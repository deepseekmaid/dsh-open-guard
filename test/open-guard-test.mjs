// open-guard-test.mjs — 假宿主验证 v2：正常并发不受影响、接近上限才排队/拒绝
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../lib/index.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'open-guard-learn-'))
let seq = 0
const learnedPath = () => path.join(TMP, 'learned-' + (++seq) + '.json')

function makeHost({ sizes = {}, live = new Set(), heap = 1000, delayMs = 0, deltaMB = 0 } = {}) {
  const state = { calls: 0, active: 0, maxActive: 0, stats: 0, heap }
  const query = {
    async observeSession(sessionId, options = {}) {
      state.calls += 1
      state.active += 1
      state.maxActive = Math.max(state.maxActive, state.active)
      try {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, delayMs)
          const signal = options && options.signal
          if (signal) {
            const onAbort = () => { clearTimeout(timer); reject(Object.assign(new Error('aborted'), { code: 'SESSION_QUERY_ABORTED' })) }
            if (signal.aborted) return onAbort()
            signal.addEventListener('abort', onAbort, { once: true })
          }
        })
        state.heap += deltaMB
        return { id: sessionId, events: [] }
      } finally {
        state.active -= 1
      }
    },
  }
  const persistence = {
    async stat(sessionId) {
      state.stats += 1
      const mb = sizes[sessionId]
      if (mb === undefined) throw new Error('missing stat')
      return { sizeBytes: mb * 1048576, location: { kind: 'jsonl', path: '/nonexistent/' + sessionId } }
    },
  }
  const sessions = { get(id) { return live.has(id) ? { id } : undefined } }
  const disposers = []
  const ctx = {
    inject(names, fn) { fn({ sessionQuery: query, sessionPersistence: persistence, sessions, effect: (f) => { disposers.push(f()); return () => {} } }) },
  }
  return { ctx, query, state, disposers }
}

const base = { logPath: false, limitMB: 4192, reserveMB: 500, ratio: 12, transient: 1.3, measureFromMB: 8, textFactor: 2.2, maxWaitMs: 300 }
const settle = (p) => p.then(v => ({ v }), e => ({ e }))

// 1) 小会话放行
{
  const host = makeHost({ sizes: { small: 2 }, heap: 1000 })
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  const out = await host.query.observeSession('small')
  assert.equal(out.id, 'small')
  console.log('PASS 小会话放行')
}

// 2) 两个小会话并发：不应被串行（正常并发保持）
{
  const host = makeHost({ sizes: { a: 2, b: 2 }, heap: 1000, delayMs: 60 })
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  await Promise.all([host.query.observeSession('a'), host.query.observeSession('b')])
  assert.equal(host.state.maxActive, 2, '小会话应保持并发')
  console.log('PASS 小会话保持并发（maxActive=2）')
}

// 3) 单独就超预算：立即拒绝且不读盘
{
  const host = makeHost({ sizes: { big: 184.2 }, heap: 3000 })
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  await assert.rejects(() => host.query.observeSession('big'), (e) => e.code === 'OPEN_GUARD_REFUSED')
  assert.equal(host.state.calls, 0)
  console.log('PASS 单独超预算立即拒绝')
}

// 4) 与在途叠加：一个允许、另一个排队后拒绝（不假设谁先）
{
  const host = makeHost({ sizes: { a: 100, b: 80 }, heap: 1500, delayMs: 120, deltaMB: 1400 })
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  const first = settle(host.query.observeSession('a'))
  await new Promise(r => setTimeout(r, 10))
  const second = settle(host.query.observeSession('b'))
  const [r1, r2] = await Promise.all([first, second])
  const results = [r1, r2]
  const ok = results.filter(r => r.v).length
  const refused = results.filter(r => r.e && r.e.code === 'OPEN_GUARD_REFUSED').length
  assert.equal(ok, 1, '应恰好一个成功')
  assert.equal(refused, 1, '另一个应被拒绝')
  assert.equal(host.state.calls, 1, '被拒绝的读取不应执行')
  console.log('PASS 在途叠加时排队后拒绝（1 成功 / 1 拒绝）')
}

// 5) 排队中被取消
{
  const host = makeHost({ sizes: { a: 100, b: 80 }, heap: 1500, delayMs: 150, deltaMB: 1200 })
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  const controller = new AbortController()
  const first = settle(host.query.observeSession('a'))
  await new Promise(r => setTimeout(r, 10))
  const second = settle(host.query.observeSession('b', { signal: controller.signal }))
  setTimeout(() => controller.abort(), 30)
  const [r1, r2] = await Promise.all([first, second])
  assert.ok(r1.v || r2.v, '至少一个成功')
  assert.ok(r1.e?.code === 'SESSION_QUERY_ABORTED' || r2.e?.code === 'SESSION_QUERY_ABORTED', '一个应被取消')
  console.log('PASS 排队中被取消')
}

// 6) live 会话直接放行且不 stat
{
  const host = makeHost({ sizes: {}, live: new Set(['live-1']), heap: 4000 })
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  const out = await host.query.observeSession('live-1')
  assert.equal(out.id, 'live-1')
  assert.equal(host.state.stats, 0)
  console.log('PASS live 会话直接放行')
}

// 7) 卸载还原
{
  const host = makeHost({ sizes: { a: 2 }, heap: 1000 })
  const original = host.query.observeSession
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  assert.notEqual(host.query.observeSession, original)
  for (const dispose of host.disposers) dispose()
  assert.equal(host.query.observeSession, original)
  console.log('PASS 卸载还原')
}

// 8) 重复 apply 不叠包裹（幂等）
{
  const host = makeHost({ sizes: { a: 2 }, heap: 1000 })
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  const once = host.query.observeSession
  apply(host.ctx, { ...base, learnedPath: learnedPath(), heapMBProvider: () => host.state.heap })
  assert.equal(host.query.observeSession, once, '重复 apply 不应再包一层')
  console.log('PASS 重复 apply 幂等')
}

fs.rmSync(TMP, { recursive: true, force: true })
console.log('\n全部通过')
