# Verification record

Date: 2026-11-15 (Asia/Shanghai)
Host under test: official `@deepseek-ai/dsh` **0.2.2-rc.1** (npm), not a fork build
Environment: isolated `DSH_HOME`, isolated profile `guardtest`, loopback port 18222, Node 24.18.0, Windows 10 22H2

## Setup

1. `npm install @deepseek-ai/dsh@0.2.2-rc.1` into a throwaway directory.
2. Copy the shipped `web` profile to `guardtest`, place this bundle under
   `profiles/guardtest/node_modules/dsh-open-guard`, and insert its row in
   `profiles/guardtest/cordis.patch.yml`.
3. Boot: `dsh --profile guardtest --port 18222 --no-open`.

## What was checked

| Check | Result |
|---|---|
| Bundle resolved and `apply(ctx)` executed | pass (instrumented run) |
| `ctx.inject(['sessionQuery','sessionPersistence','sessions'])` resolved | pass — all three host services exist |
| `sessionQuery.observeSession` replaced | pass — `wrapped=true` |
| Real cold read of a 98 KB session went through the guard | pass — 30 events, 29 ms |

Decision line written by the guard during that read:

```json
{"t":"2026-11-15T02:28:45.900Z","kind":"observe","sid":"8e2ae589","estMB":1,"source":"heuristic","usedMB":161,"deltaMB":3,"decision":"allow","waitedMs":0,"runMs":28}
```

## Unit tests

```
node test/open-guard-test.mjs    -> 8/8 PASS
node test/measure-text-test.mjs  -> PASS
```

## Not covered by this run

- Refusal / queue paths were exercised by the fake-host unit tests only; reproducing them on a real host needs the heap to actually approach the ceiling.
- Renderer-side memory is out of scope.
