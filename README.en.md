[简体中文](README.md) | **English**

# dsh-open-guard

> **One line:** before the Harness host heap is blown apart by *opening several large sessions at once*, queue the ones that must wait and refuse the ones that cannot fit — so the app stays up instead of crashing.

A DeepSeek Harness host plugin. It wraps `sessionQuery.observeSession`, the single choke point every cold session read goes through, and applies a remaining-memory budget there.

## The problem

Opening a session decodes its whole event log into memory (measured retention is roughly 1.8–2.5× the decompressed text). The V8 heap ceiling is 4,192 MB and cannot be raised. Clicking two large sessions in a row stacks two materializations — measured: a 1.2 GB main session plus three large sessions reached 4,058 MB and crashed.

## What it does

1. **Estimate** what this open will cost — a learned measured value when the session was seen before; otherwise a heuristic from the compressed size, refined by measuring the text in a worker thread when the projection gets close to the limit.
2. **Admit** when *used + inflight + this estimate + reserve ≤ limit*.
3. **Queue or refuse** otherwise: if it fits alone, wait for inflight reads (cancellable, bounded by `maxWaitMs`); if it does not fit even alone, refuse and report the numbers.

Live sessions are skipped entirely.

## Normal-use impact

When the heap is healthy there is **no waiting, no refusal, no text scan** — one extra `stat` (~6 ms) and the same concurrency as without the plugin (verified: two concurrent small reads, `maxActive=2`). Queueing and refusals only appear in the situation that would otherwise crash.

## Install

Desktop app: **Settings → Plugins → Add plugin**, enter `dsh-open-guard`, install, then enable it.

`dsh web`:

```bash
# from this repository (not published to npm yet)
dsh plugin --profile web add github:deepseekmaid/dsh-open-guard

# from a release tarball (no build step)
dsh plugin --profile web add https://github.com/deepseekmaid/dsh-open-guard/releases/download/v0.2.0/dsh-open-guard-0.2.0.tgz
```

Restart the host once. The bundle inserts its own row (`open-guard`), so no manual patch edit is required.

## Configuration

Override the row in your profile patch (`~/.dsh/profiles/<name>/cordis.patch.yml`):

```yaml
- id: open-guard
  config:
    limitMB: 4192      # heap ceiling to budget against
    reserveMB: 500     # headroom kept free; raise for a more conservative guard
    maxWaitMs: 20000   # longest a queued open waits
```

Other keys: `ratio` (compressed → retained multiplier), `transient`, `textFactor`, `measureFromMB`, `measureNearRatio`, `learn`, `learnedPath`, `logPath`, `enabled`.

## Logs

Every decision is one JSON line in `~/.dsh/logs/open-guard.jsonl`:

```json
{"t":"...","kind":"observe","sid":"8e2ae589","estMB":1,"source":"heuristic","usedMB":161,"deltaMB":3,"decision":"allow","waitedMs":0,"runMs":28}
```

`decision` is `allow`, `refuse`, or `refuse-after-wait`. Learned retained sizes live in `~/.dsh/storages/open-guard-learned.json`.

## Tests

```bash
node test/open-guard-test.mjs      # 8 checks: allow / concurrency / refuse / queue / cancel / live / uninstall / idempotence
node test/measure-text-test.mjs    # worker text measurement
```

## Verification

Verified on the official `@deepseek-ai/dsh` `0.2.2-rc.1` in an isolated `DSH_HOME` (not a fork build):

- the bundle loaded and `apply` ran;
- `ctx.inject(['sessionQuery','sessionPersistence','sessions'])` resolved — all three host services exist;
- `observeSession` was replaced (`wrapped=true`);
- one real cold read of a 98 KB session produced `decision=allow` (`estMB=1`, `deltaMB=3`, 28 ms).

## Known limits

- Full-library search reconciliation does **not** pass through this seam; avoid whole-library searches while indices are unhealthy.
- A refusal surfaces in the UI as an error carrying the numbers; it is a controlled failure, not a crash.
- Estimates are conservative by design; the worker measurement falls back to a heuristic when it fails.
- Host-side only: it does not address renderer-side memory growth from very long conversations.
- Profile-level plugin: upgrading DSH does not overwrite it, but re-test if the host plugin API changes.

## License

MIT
