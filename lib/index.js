// @local/dsh-open-guard — 冷读会话的「剩余内存预算」准入（v2.2）
//
// 目标：正常使用时**不改变任何行为**；只有「再加一份物化就会超过堆上限」时，
// 才排队或拒绝，把必然的崩溃变成一次可控的失败。
//
// 要点：
//   - 估算 cost：学过用实测；否则压缩×12×1.3；接近上限时才用 worker 精确量文本。
//   - 只有「真正开始读」才计入 inflight（等待中的请求不算），避免互相把对方当成在途。
//   - 检查与 inflight 自增在同一个同步块里完成，防止两个请求同时通过检查。
//   - 放不下时轮询等待（任何在途完成都会唤醒所有等待者重试），超过 maxWaitMs 才失败。
//   - live 会话直接放行；内部错误一律 fail-open。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Worker } from 'node:worker_threads'

export const name = 'open-guard'
export const inject = ['sessionQuery', 'sessionPersistence', 'sessions']

const STATE_DIR = path.join(os.homedir(), '.dsh', 'storages')
const LEARNED_PATH = path.join(STATE_DIR, 'open-guard-learned.json')
const WORKER_URL = new URL('./measure-text-worker.mjs', import.meta.url)
const WRAPPED = Symbol.for('local.dsh-open-guard.wrapped')

const DEFAULTS = Object.freeze({
  enabled: true,
  limitMB: 4192,
  reserveMB: 500,
  ratio: 12,
  transient: 1.3,
  textFactor: 2.2,
  measureFromMB: 8,
  measureNearRatio: 0.75,
  textTimeoutMs: 15000,
  maxWaitMs: 45000,
  learn: true,
  learnedPath: LEARNED_PATH,
  logPath: path.join(os.homedir(), '.dsh', 'logs', 'open-guard.jsonl'),
})

/** 用 worker 量一份会话文件的解压文本 MB；失败/超时返回 null。 */
export function measureTextMB(filePath, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false
    let worker
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { worker?.terminate() } catch { /* ignore */ }
      resolve(value)
    }
    const timer = setTimeout(() => done(null), timeoutMs)
    try {
      worker = new Worker(WORKER_URL, { workerData: { path: filePath }, resourceLimits: { maxOldGenerationSizeMb: 256 } })
      worker.once('message', (msg) => done(msg && msg.ok ? msg.bytes / 1048576 : null))
      worker.once('error', () => done(null))
      worker.once('exit', () => done(null))
    } catch {
      done(null)
    }
  })
}

const refused = (message, detail) => {
  const error = new Error(message)
  error.code = 'OPEN_GUARD_REFUSED'
  error.detail = detail
  return error
}

function loadLearned(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

function saveLearned(file, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(map))
  } catch { /* 不影响主流程 */ }
}

export function apply(ctx, config = {}) {
  const cfg = { ...DEFAULTS, ...config }
  if (cfg.enabled === false) return

  ctx.inject(['sessionQuery', 'sessionPersistence', 'sessions'], (scope) => {
    const query = scope.sessionQuery
    const persistence = scope.sessionPersistence
    const sessions = scope.sessions
    const originalObserve = query.observeSession
    const originalRead = typeof query.readSession === 'function' ? query.readSession : undefined
    if (typeof originalObserve !== 'function') return
    if (originalObserve[WRAPPED]) return

    const heapMB = typeof cfg.heapMBProvider === 'function'
      ? cfg.heapMBProvider
      : () => process.memoryUsage().heapUsed / 1048576

    const learned = cfg.learn ? loadLearned(cfg.learnedPath) : {}
    let inflightMB = 0
    const waiters = new Set()

    const writeLog = (record) => {
      if (cfg.logPath === false) return
      try {
        fs.mkdirSync(path.dirname(cfg.logPath), { recursive: true })
        fs.appendFileSync(cfg.logPath, JSON.stringify(record) + '\n')
      } catch { /* 日志失败不影响主流程 */ }
    }

    const shortId = (id) => String(id).replace(/^session-/, '').slice(0, 8)

    async function heuristicMB(sessionId, signal) {
      const known = learned[sessionId]
      if (known && Number.isFinite(known.holdMB) && known.holdMB > 0) {
        return { value: known.holdMB * 1.15, source: 'learned-hold', compMB: known.compMB ?? null }
      }
      if (known && Number.isFinite(known.textMB) && known.textMB > 0) {
        return { value: known.textMB * cfg.textFactor, source: 'learned-text', compMB: known.compMB ?? null }
      }
      let stat
      try { stat = await persistence.stat(sessionId, signal ? { signal } : undefined) } catch { return null }
      const compMB = Number(stat?.sizeBytes ?? 0) / 1048576
      if (!Number.isFinite(compMB) || compMB <= 0) return null
      return { value: compMB * cfg.ratio * cfg.transient, source: 'heuristic', compMB, path: stat?.location?.path }
    }

    async function refineMB(estimate, sessionId, used) {
      if (!estimate || !estimate.path) return estimate
      if (estimate.compMB < cfg.measureFromMB) return estimate
      const projected = used + inflightMB + estimate.value + cfg.reserveMB
      if (projected <= cfg.limitMB * cfg.measureNearRatio) return estimate
      const textMB = await measureTextMB(estimate.path, cfg.textTimeoutMs)
      if (!Number.isFinite(textMB) || textMB <= 0) return estimate
      if (cfg.learn) {
        learned[sessionId] = { textMB: Math.round(textMB * 10) / 10, compMB: estimate.compMB, updatedAt: new Date().toISOString() }
        saveLearned(cfg.learnedPath, learned)
      }
      return { value: textMB * cfg.textFactor, source: 'measured-text', compMB: estimate.compMB, textMB }
    }

    function wakeAll() {
      for (const entry of waiters) {
        entry.cleanup?.()
        entry.resolve()
      }
      waiters.clear()
    }

    function waitOne(signal, timeoutMs) {
      return new Promise((resolve, reject) => {
        const entry = { resolve: null, cleanup: null }
        let timer
        const finish = (fn, arg) => {
          if (!waiters.has(entry)) return
          waiters.delete(entry)
          clearTimeout(timer)
          entry.cleanup?.()
          fn(arg)
        }
        entry.resolve = () => finish(resolve)
        const onAbort = () => {
          const error = new Error('open-guard: 排队的会话打开已取消')
          error.code = 'SESSION_QUERY_ABORTED'
          finish(reject, error)
        }
        if (signal) {
          if (signal.aborted) {
            const error = new Error('open-guard: 排队的会话打开已取消')
            error.code = 'SESSION_QUERY_ABORTED'
            reject(error)
            return
          }
          signal.addEventListener('abort', onAbort, { once: true })
          entry.cleanup = () => signal.removeEventListener('abort', onAbort)
        }
        timer = setTimeout(() => {
          const error = new Error('open-guard: 等待其它大物化完成超时')
          error.code = 'OPEN_GUARD_QUEUE_TIMEOUT'
          finish(reject, error)
        }, Math.max(1, timeoutMs))
        waiters.add(entry)
      })
    }

    function clampLearned(delta, estimate) {
      const text = estimate?.textMB
      if (Number.isFinite(text) && text > 0) {
        if (delta < text * 1.2 || delta > text * 3.2) return null
      } else if (Number.isFinite(estimate?.compMB) && estimate.compMB > 0) {
        if (delta < estimate.compMB * 5 || delta > estimate.compMB * 40) return null
      }
      return Math.round(delta)
    }

    function guard(label, fn) {
      async function guarded(sessionId, options = {}) {
        const startedAt = Date.now()
        const signal = options && options.signal

        try {
          if (typeof sessions?.get === 'function' && sessions.get(sessionId) !== undefined) {
            return await fn.call(this, sessionId, options)
          }
        } catch { /* 继续 */ }

        let estimate = null
        try { estimate = await heuristicMB(sessionId, signal) } catch { estimate = null }
        if (estimate === null) return await fn.call(this, sessionId, options)

        estimate = await refineMB(estimate, sessionId, heapMB())

        const deadline = Date.now() + cfg.maxWaitMs
        let waitedMs = 0
        for (;;) {
          const used = heapMB()
          if (used + estimate.value + cfg.reserveMB > cfg.limitMB) {
            const record = {
              t: new Date().toISOString(), kind: label, sid: shortId(sessionId),
              estMB: Math.round(estimate.value), source: estimate.source,
              usedMB: Math.round(used), inflightMB: Math.round(inflightMB), decision: 'refuse',
            }
            writeLog(record)
            throw refused(
              `open-guard 拒绝打开：单独这一份就预计需要 ${Math.round(estimate.value)} MB，` +
              `当前已用 ${Math.round(used)} MB、其它在途 ${Math.round(inflightMB)} MB，加上预留会到 ` +
              `${Math.round(used + estimate.value + cfg.reserveMB)} MB（上限 ${cfg.limitMB} MB）。` +
              `请重启 DSH 或先关闭其它大会话；本次没有读取日志。`,
              record,
            )
          }
          if (used + inflightMB + estimate.value + cfg.reserveMB <= cfg.limitMB) {
            inflightMB += estimate.value // 同步自增，避免并发同时通过
            break
          }
          const remaining = deadline - Date.now()
          if (remaining <= 0) {
            const record = {
              t: new Date().toISOString(), kind: label, sid: shortId(sessionId),
              estMB: Math.round(estimate.value), source: estimate.source,
              usedMB: Math.round(used), inflightMB: Math.round(inflightMB),
              decision: 'refuse-after-wait', waitedMs,
            }
            writeLog(record)
            throw refused(
              `open-guard 拒绝打开（等待超时）：再读会到 ${Math.round(used + inflightMB + estimate.value + cfg.reserveMB)} MB，` +
              `超过上限 ${cfg.limitMB} MB。请重启 DSH 或先关闭其它大会话；本次没有读取日志。`,
              record,
            )
          }
          const waitStart = Date.now()
          await waitOne(signal, remaining)
          waitedMs += Date.now() - waitStart
        }

        try {
          const before = heapMB()
          const result = await fn.call(this, sessionId, options)
          const delta = heapMB() - before
          if (cfg.learn && Number.isFinite(delta) && delta > 50 && delta < 3000) {
            const hold = clampLearned(delta, estimate)
            if (hold !== null) {
              learned[sessionId] = {
                holdMB: hold, compMB: estimate.compMB ?? null,
                textMB: estimate.textMB, updatedAt: new Date().toISOString(),
              }
              saveLearned(cfg.learnedPath, learned)
            }
          }
          writeLog({
            t: new Date().toISOString(), kind: label, sid: shortId(sessionId),
            estMB: Math.round(estimate.value), source: estimate.source,
            usedMB: Math.round(before), deltaMB: Math.round(delta),
            decision: 'allow', waitedMs, runMs: Date.now() - startedAt,
          })
          return result
        } finally {
          inflightMB = Math.max(0, inflightMB - estimate.value)
          wakeAll()
        }
      }
      guarded[WRAPPED] = true
      return guarded
    }

    query.observeSession = guard('observe', originalObserve)
    if (originalRead && !originalRead[WRAPPED]) query.readSession = guard('read', originalRead)

    if (typeof scope.effect === 'function') {
      scope.effect(() => () => {
        query.observeSession = originalObserve
        if (originalRead) query.readSession = originalRead
      })
    }
  })
}
