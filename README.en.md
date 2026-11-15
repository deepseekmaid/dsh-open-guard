[简体中文](README.md) | **English**

# dsh-open-guard

A DeepSeek Harness host plugin that applies memory admission control during session loading, preventing concurrent loads of large sessions from exhausting the host heap.

## Problem

When DeepSeek Harness loads a session that is not cached, it decodes the session's complete event log into memory. Measured retention is approximately 1.8–2.5× the decompressed text size. The V8 heap limit is fixed at 4,192 MB and cannot be raised. Loading several large sessions in succession stacks multiple retained copies; in testing, a 1.2 GB main session plus three large sessions terminated the process at 4,058 MB.

## Mechanism

The plugin intercepts `sessionQuery.observeSession`, the single entry point for session loading, and performs the following steps in order:

1. **Estimate** — sessions observed before use a measured retained size; otherwise the compressed size is used, refined by a worker-thread measurement of the decompressed text when the projected usage approaches the limit.
2. **Admit** — the load proceeds when current heap usage + in-flight loads + this estimate + reserve is within the limit.
3. **Queue or refuse** — when the load does not fit alongside in-flight loads but fits on its own, it waits for them to finish (cancellable, bounded by `maxWaitMs`); when it does not fit even on its own, it is refused and the error reports the estimate and current usage.

Sessions that are already live bypass these checks.

## Overhead in normal operation

When memory is not constrained, there is no queueing, no refusal, and no text scan; the only added cost is one `stat` call (about 6 ms), and concurrency matches a host without the plugin (verified: two concurrent small sessions, `maxActive=2`). Queueing and refusals occur only in the situation that would otherwise terminate the process.

## Install

Desktop app: Settings → Plugins → Add plugin, enter `dsh-open-guard`, install and enable it.

`dsh web`:

```bash
# not published to npm yet; install from the repository
dsh plugin --profile web add github:deepseekmaid/dsh-open-guard
```

Restart the host once after installation. The bundle inserts its own `open-guard` row; no manual patch edit is required.

## Configuration

Override the defaults in your profile patch file (`~/.dsh/profiles/<name>/cordis.patch.yml`):

```yaml
- id: open-guard
  config:
    limitMB: 4192      # heap limit (default 4192)
    reserveMB: 500     # reserved headroom (default 500)
    maxWaitMs: 45000   # longest queue wait (default 45000, milliseconds)
```

Other options: `ratio` (compressed-size to retained-size factor), `transient` (estimation multiplier), `textFactor` (decompressed-text to retained-size factor), `measureFromMB` (minimum compressed size that triggers a worker measurement), `measureNearRatio` (heap-usage ratio that triggers the exact measurement), `learn` (record measured sizes), `learnedPath`, `logPath`, `enabled`.

## Logs

Each admission decision writes one JSON line to `~/.dsh/logs/open-guard.jsonl`:

```json
{"t":"...","kind":"observe","sid":"8e2ae589","estMB":1,"source":"heuristic","usedMB":161,"deltaMB":3,"decision":"allow","waitedMs":0,"runMs":28}
```

`decision` is `allow`, `refuse`, or `refuse-after-wait`. Measured retained sizes are stored in `~/.dsh/storages/open-guard-learned.json`.

## Tests

```bash
node test/open-guard-test.mjs      # 8 checks: allow, concurrency, refusal, queueing, cancellation, live sessions, unload restore, idempotent re-apply
node test/measure-text-test.mjs    # worker-based text size measurement
```

## Verification

Verified on the official `@deepseek-ai/dsh` `0.2.2-rc.1` in an isolated `DSH_HOME` (not a fork build):

- the bundle loaded and `apply` ran;
- `ctx.inject(['sessionQuery','sessionPersistence','sessions'])` resolved, with all three host services present;
- `sessionQuery.observeSession` was replaced;
- one real session load produced `decision=allow` (`estMB=1`, `deltaMB=3`, 28 ms).

## Known limitations

- Full-library search reconciliation does not pass through this entry point; do not run whole-library searches while indices are unhealthy.
- A refusal appears in the host UI as an error containing the usage figures; this is a controlled failure.
- Estimates are conservative by design; when the worker measurement fails, the heuristic estimate is used.
- Host process only; renderer-side memory growth from long conversations is out of scope.
- The plugin is installed at profile level. Upgrading DSH does not overwrite it, but changes to the host plugin API require re-verification.

## License

MIT
