// measure-text-test.mjs — 验证 worker 能算出会话文件的解压文本大小
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { measureTextMB } from '../lib/index.js'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'open-guard-'))
const file = path.join(dir, 'sample.v4.jsonl.zstd')
const parts = [
  JSON.stringify({ header: { id: 'session-test' } }),
  JSON.stringify({ type: 'session/end-seed', seq: 0 }),
  JSON.stringify({ type: 'turn/end', seq: 1 }),
]
const frames = parts.map((p) => zlib.zstdCompressSync(Buffer.from(p)))
fs.writeFileSync(file, Buffer.concat(frames))
const expected = parts.reduce((n, p) => n + Buffer.byteLength(p), 0) / 1048576

const mb = await measureTextMB(file, 10000)
assert.ok(Number.isFinite(mb), '应返回数值')
assert.ok(Math.abs(mb - expected) < 0.001, `应≈${expected} MB，实际 ${mb}`)
console.log('PASS 文本量测量（' + mb.toFixed(4) + ' MB）')
fs.rmSync(dir, { recursive: true, force: true })
