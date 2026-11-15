# 会话打开护栏（dsh-open-guard）

> **一句话**：在宿主内存快被「同时打开多个会话」撑爆之前，把该排队的排队、该拒绝的拒绝，让应用活着而不是崩掉。

DeepSeek Harness 宿主插件。它包住会话冷读的唯一入口 `sessionQuery.observeSession`，在那里做「剩余内存预算」准入。

## 它解决什么问题

打开一个会话时，宿主会把该会话的整份事件日志解码进内存（实测持有量约为解压文本的 1.8–2.5 倍）。V8 堆上限 4,192 MB 无法调大。连续点开两个大会话，两次物化叠加就会 OOM（实测：1.2 GB 主会话 + 三个大会话 = 4,058 MB 崩溃）。

## 它做什么

1. **估算**：学过的会话用实测持有量；否则按压缩体积估算，接近上限时用 worker 线程精确量文本；
2. **准入**：已用 + 在途 + 本次估算 + 预留 ≤ 上限 → 放行；
3. **排队或拒绝**：放不下但单独放得下 → 等待在途完成（可取消，最长 `maxWaitMs`）；单独都放不下 → 拒绝并给出数字。

已经打开的会话完全跳过。

## 正常使用时的影响

内存水位正常时**不等待、不拒绝、不扫文本**：只多一次 `stat`（约 6 毫秒），并发行为与不装时一致（实测两个会话同时读，`maxActive=2`）。只有「再加一份物化就会超过上限」时才会排队或拒绝——那正是原本会崩溃的场景。

## 安装

桌面端：**设置 → 插件 → 添加插件**，输入 `dsh-open-guard`，安装并启用。

`dsh web`：

```bash
dsh plugin --profile web add dsh-open-guard
# 或从仓库安装
dsh plugin --profile web add github:deepseekmaid/dsh-open-guard
```

安装后重启一次宿主。bundle 会自行插入 `open-guard` 行，无需手工改补丁。

## 配置

在 profile 补丁（`~/.dsh/profiles/<name>/cordis.patch.yml`）里覆盖：

```yaml
- id: open-guard
  config:
    limitMB: 4192      # 堆上限
    reserveMB: 500     # 预留余量
    maxWaitMs: 20000   # 排队最长等待
```

其余可调项：`ratio`、`transient`、`textFactor`、`measureFromMB`、`measureNearRatio`、`learn`、`learnedPath`、`logPath`、`enabled`。

## 日志

每次决策写一行 JSON 到 `~/.dsh/logs/open-guard.jsonl`，`decision` 取 `allow` / `refuse` / `refuse-after-wait`；学到的实测持有量存 `~/.dsh/storages/open-guard-learned.json`。

## 测试

```bash
node test/open-guard-test.mjs
node test/measure-text-test.mjs
```

## 验证

已在官方 `@deepseek-ai/dsh` `0.2.2-rc.1` 的隔离 `DSH_HOME` 中实测（非 fork 构建）：bundle 加载、`apply` 执行、三个宿主服务注入成功、`observeSession` 被替换，且一次真实冷读产生 `decision=allow`（`estMB=1`、`deltaMB=3`、28 ms）。

## 已知边界

- 全库搜索的索引对账不经过这个入口，索引不健康时不要跑全库搜索。
- 拒绝会在 UI 显示为一条带数字的错误（受控失败，好于崩溃）。
- 估算偏保守；worker 量文本失败时回退启发式。
- 仅宿主侧：不解决 renderer 侧长对话的内存增长。
- profile 级插件：升级 DSH 不会覆盖它，但宿主插件 API 变化后需要重测。

## 许可证

MIT
