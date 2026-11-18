/**
 * 会话新鲜度 × 中文遵循度：验证「模型不遵循」到底是模型本身，还是长会话污染。
 * 用法：node tools/freshness-vs-compliance.mjs [模型名子串]
 */
import { readFile, readdir } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import path from 'node:path'

import { analyseCoverage } from '../lib/coverage.js'

const ROOT = path.join(homedir(), '.dsh', 'sessions')
const TARGET = process.argv[2] ?? 'qfmodel'

async function frames(file) {
  const raw = await readFile(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offs = []
  let at = 0
  while ((at = raw.indexOf(magic, at)) !== -1) {
    offs.push(at)
    at += 4
  }
  const parts = []
  for (let i = 0; i < offs.length; i++) {
    const s = offs[i]
    const e = i + 1 < offs.length ? offs[i + 1] : raw.length
    try {
      parts.push(zstdDecompressSync(raw.subarray(s, e)).toString('utf8'))
    } catch {}
  }
  const out = []
  for (const line of parts.join('').split('\n')) {
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {}
  }
  return out
}

async function walk(d, acc) {
  let es
  try {
    es = await readdir(d, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of es) {
    const p = path.join(d, e.name)
    if (e.isDirectory()) await walk(p, acc)
    else if (e.name === 'session.v4.jsonl.zstd') acc.push(p)
  }
}

const files = []
await walk(ROOT, files)

const rows = []
for (const file of files) {
  let events
  try {
    events = await frames(file)
  } catch {
    continue
  }
  let han = 0
  let eng = 0
  let segs = 0
  let models = new Set()
  let injected = false
  for (const ev of events) {
    if (ev.type === 'system/message' && JSON.stringify(ev).includes('[language-requirement]')) injected = true
    if (ev.type !== 'assistant/message') continue
    const msg = ev.data?.message ?? {}
    if (msg.source?.model) models.add(`${msg.source.provider}/${msg.source.model}`)
    for (const b of msg.content ?? []) {
      if (b?.type !== 'reasoning' || !b.text || !b.text.trim()) continue
      const s = analyseCoverage(b.text)
      han += s.hanChars
      eng += s.englishChars
      segs += 1
    }
  }
  const hit = [...models].some((m) => m.includes(TARGET))
  if (!hit || segs === 0) continue
  rows.push({ segs, ratio: han + eng > 0 ? han / (han + eng) : null, injected })
}

const mean = (arr) => {
  const v = arr.map((r) => r.ratio).filter((x) => x !== null)
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null
}

console.log(`目标含「${TARGET}」的会话：${rows.length} 个`)
for (const [lo, hi] of [[1, 3], [4, 10], [11, 50], [51, 200], [201, 1e9]]) {
  const b = rows.filter((r) => r.segs >= lo && r.segs <= hi)
  if (b.length) console.log(`  ${String(lo).padStart(3)}-${hi === 1e9 ? '∞' : String(hi).padStart(3)} 段：${String(b.length).padStart(3)} 会话，平均 chineseRatio ${mean(b)?.toFixed(3)}`)
}
const inj = rows.filter((r) => r.injected)
console.log(`  注入在场：${inj.length}/${rows.length} 会话，平均 ${mean(inj)?.toFixed(3)}`)
