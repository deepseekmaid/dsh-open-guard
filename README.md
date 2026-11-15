**简体中文** | [English](README.en.md)

# dsh-open-guard

DeepSeek Harness 宿主插件。在会话加载阶段实施内存准入控制，避免并发加载大型会话导致宿主进程内存耗尽。

## 问题

DeepSeek Harness 在加载未缓存的会话时，会把该会话的完整事件日志解码到内存中。实测内存占用约为解压文本大小的 1.8–2.5 倍。V8 堆上限固定为 4,192 MB，无法上调。连续加载多个大型会话会造成多份内存驻留叠加；实测中，1.2 GB 的主会话加三个大型会话在 4,058 MB 处触发进程终止。

## 机制

插件拦截会话加载的唯一入口 `sessionQuery.observeSession`，并在该入口依次执行：

1. **估算**：已记录过的会话使用实测占用值；否则按压缩体积估算，接近上限时由 worker 线程测量解压文本大小。
2. **准入**：当前堆用量 + 在途加载估算 + 本次估算 + 预留 ≤ 上限时放行。
3. **排队或拒绝**：不满足准入条件但单独可容纳时，等待在途加载完成（可取消，最长 `maxWaitMs`）；单独也无法容纳时拒绝，并在错误信息中给出本次估算值与当前用量。

已经加载（live）的会话不经过上述检查。

## 正常运行时的开销

内存充足时不排队、不拒绝、不扫描文本，仅增加一次 `stat` 调用（约 6 毫秒），并发行为与未安装时一致（实测两个并发小会话，`maxActive=2`）。只有在「再加载一份就会超过堆上限」时才会出现排队或拒绝，该情形在未安装插件时会导致进程终止。

## 安装

桌面端：设置 → 插件 → 添加插件，输入 `dsh-open-guard`，安装并启用。

`dsh web`：

```bash
# 尚未发布到 npm，从仓库安装
dsh plugin --profile web add github:deepseekmaid/dsh-open-guard
```

安装后重启一次宿主。bundle 会自行插入 `open-guard` 配置项，无需手工修改补丁文件。

## 配置

在 profile 补丁文件（`~/.dsh/profiles/<name>/cordis.patch.yml`）中覆盖默认配置：

```yaml
- id: open-guard
  config:
    limitMB: 4192      # 堆上限（默认 4192）
    reserveMB: 500     # 预留可用内存（默认 500）
    maxWaitMs: 45000   # 排队最长等待时间（默认 45000，单位毫秒）
```

其余可配置项：`ratio`（压缩体积到内存占用的估算系数）、`transient`（估算放大系数）、`textFactor`（解压文本到内存占用的系数）、`measureFromMB`（启用 worker 测量的最小压缩体积）、`measureNearRatio`（触发精确测量的堆用量比例）、`learn`（是否记录实测值）、`learnedPath`（实测值存储路径）、`logPath`（决策日志路径）、`enabled`（是否启用）。

## 日志

每次准入决策写入一行 JSON 到 `~/.dsh/logs/open-guard.jsonl`：

```json
{"t":"...","kind":"observe","sid":"8e2ae589","estMB":1,"source":"heuristic","usedMB":161,"deltaMB":3,"decision":"allow","waitedMs":0,"runMs":28}
```

`decision` 取值为 `allow`、`refuse` 或 `refuse-after-wait`。实测占用值保存在 `~/.dsh/storages/open-guard-learned.json`。

## 测试

```bash
node test/open-guard-test.mjs      # 8 项：放行、并发、拒绝、排队、取消、live 会话、卸载还原、重复加载幂等
node test/measure-text-test.mjs    # worker 文本体积测量
```

## 验证

已在官方 `@deepseek-ai/dsh` `0.2.2-rc.1` 的隔离 `DSH_HOME` 中验证（非 fork 构建）：

- bundle 加载成功，`apply` 执行；
- `ctx.inject(['sessionQuery','sessionPersistence','sessions'])` 解析成功，三个宿主服务均存在；
- `sessionQuery.observeSession` 被替换；
- 一次真实会话加载产生 `decision=allow`（`estMB=1`、`deltaMB=3`、28 毫秒）。

## 已知限制

- 全库搜索的索引对账不经过该入口；索引状态异常时不应执行全库搜索。
- 拒绝时宿主界面会显示一条包含用量信息的错误，属于受控失败。
- 估算值偏保守；worker 测量失败时回退到启发式估算。
- 仅作用于宿主进程，不处理渲染进程因长对话产生的内存增长。
- 插件安装在 profile 级别，升级 DSH 不会覆盖；宿主插件 API 变更后需要重新验证。

## 许可证

MIT
