// measure-text-worker.mjs — 在 worker 里流式解压会话帧，只算「解压文本字节数」
// 单独线程的原因：解码 100–200 MB 的 zstd 会阻塞事件循环；放 worker 里宿主堆不受影响。
import { parentPort, workerData } from 'node:worker_threads'
import fs from 'node:fs'
import zlib from 'node:zlib'

function frameEnd(buf, pos) {
  if (pos + 4 > buf.length) throw new Error('eof')
  if (buf.readUInt32LE(pos) !== 0xFD2FB528) throw new Error('bad magic')
  let p = pos + 4
  const fhd = buf[p++]
  const fcs = fhd >> 6
  const single = (fhd >> 5) & 1
  const ck = (fhd >> 2) & 1
  const df = fhd & 3
  if (!single) p += 1
  p += [0, 1, 2, 4][df]
  p += [single ? 1 : 0, 2, 4, 8][fcs]
  for (;;) {
    const bh = buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16)
    p += 3
    const last = bh & 1
    const type = (bh >> 1) & 3
    const size = bh >>> 3
    if (type === 1) p += 1
    else p += size
    if (last) break
  }
  if (ck) p += 4
  return p
}

try {
  const buf = fs.readFileSync(workerData.path)
  let pos = 0
  let total = 0
  let frames = 0
  while (pos < buf.length) {
    const end = frameEnd(buf, pos)
    if (end <= pos) break
    const out = zlib.zstdDecompressSync(buf.subarray(pos, end))
    total += out.length
    pos = end
    frames += 1
  }
  parentPort.postMessage({ ok: true, bytes: total, frames, compressed: buf.length })
} catch (error) {
  parentPort.postMessage({ ok: false, message: String(error && error.message || error) })
}
