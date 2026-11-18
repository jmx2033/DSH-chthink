/**
 * 按 provider/model 聚合全部会话日志的中文思维链覆盖率。
 * 用法：node tools/model-census.mjs [sessionsRoot]
 *
 * 输出每个模型的：段数、字符数、覆盖率、注入在场率（该模型的 reasoning 之前，
 * 系统提示词里是否已含 [language-requirement]）。用于区分两种失效：
 *   注入缺失（插件/preset 问题，可修）vs 模型不遵循（能力边界，只能拉黑）。
 */
import { readFile } from 'node:fs/promises'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import path from 'node:path'

import { analyseCoverage } from '../lib/coverage.js'

const ROOT = process.argv[2] ?? path.join(homedir(), '.dsh', 'sessions')
const MARKER = '[language-requirement]'

const HAN = /\p{Script=Han}/u
const LATIN = /\p{L}/u

async function loadFrames(file) {
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

async function listSessionFiles(dir) {
  const found = []
  const walk = async (d) => {
    const { readdir } = await import('node:fs/promises')
    let entries
    try {
      entries = await readdir(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.name === 'session.v4.jsonl.zstd') found.push(p)
    }
  }
  await walk(dir)
  return found
}

const files = await listSessionFiles(ROOT)
const models = new Map()
let sessionsScanned = 0

for (const file of files) {
  let events
  try {
    events = await loadFrames(file)
  } catch {
    continue
  }
  if (events.length === 0) continue
  sessionsScanned += 1

  // 注入在场判定：每条 system/message 是否含 marker；取「最近一次装配」的状态。
  // 同时记录时间点，用于判断某段 reasoning 之前注入是否已存在。
  const injectedAt = []
  for (const ev of events) {
    if (ev.type !== 'system/message') continue
    const text = JSON.stringify(ev)
    if (text.includes(MARKER)) injectedAt.push(ev.time)
  }
  const firstInject = injectedAt.length ? Math.min(...injectedAt) : Infinity
  const lastInject = injectedAt.length ? Math.max(...injectedAt) : 0

  for (const ev of events) {
    if (ev.type !== 'assistant/message') continue
    const msg = ev.data?.message ?? {}
    const provider = typeof msg.source?.provider === 'string' ? msg.source.provider : '(unknown)'
    const model = typeof msg.source?.model === 'string' ? msg.source.model : '(unknown)'
    const key = `${provider}/${model}`
    for (const b of msg.content ?? []) {
      if (b?.type !== 'reasoning' || !b.text || !b.text.trim()) continue
      const s = analyseCoverage(b.text)
      if (s.chars < 10) continue
      const rec = models.get(key) ?? {
        segments: 0,
        chars: 0,
        cjk: 0,
        han: 0,
        eng: 0,
        ident: 0,
        sessions: new Set(),
        ratios: [],
        injectedRatios: [],
        withInject: 0,
        withoutInject: 0,
        charsWithInject: 0,
        cjkWithInject: 0,
        hanWithInject: 0,
        engWithInject: 0,
        charsWithout: 0,
        cjkWithout: 0,
        lastAt: 0,
        everInjected: false,
      }
      rec.segments += 1
      rec.chars += s.chars
      rec.cjk += s.cjk
      rec.han += s.hanChars
      rec.eng += s.englishChars
      rec.ident += s.identifierChars
      if (s.chineseRatio !== null) {
        rec.ratios.push(s.chineseRatio)
        if (ev.time >= firstInject) rec.injectedRatios.push(s.chineseRatio)
      }
      rec.sessions.add(path.basename(path.dirname(file)))
      rec.lastAt = Math.max(rec.lastAt, ev.time ?? 0)
      // 该段生成时，注入是否已在场（本会话曾装配出含 marker 的提示词，且时间上早于本段）
      const present = ev.time >= firstInject
      if (present) {
        rec.withInject += 1
        rec.charsWithInject += s.chars
        rec.cjkWithInject += s.cjk
        rec.hanWithInject += s.hanChars
        rec.engWithInject += s.englishChars
        rec.everInjected = true
      } else {
        rec.withoutInject += 1
        rec.charsWithout += s.chars
        rec.cjkWithout += s.cjk
      }
      models.set(key, rec)
    }
  }
}

const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null)

const rows = [...models.entries()]
  .map(([key, r]) => ({
    model: key,
    segments: r.segments,
    sessions: r.sessions.size,
    chars: r.chars,
    // v2：汉字 / 自然字符（含标识符），与历史日志可比
    coverage: r.chars ? r.cjk / r.chars : 0,
    // 段级均值：每段一个 chineseRatio 再取平均，不被超长段主导（判定看这个）
    segMean: mean(r.ratios),
    segMeanInjected: mean(r.injectedRatios),
    // 按字符加权：会被少数超长英文段主导，仅作对照，不作判定
    weighted: r.han + r.eng > 0 ? r.han / (r.han + r.eng) : null,
    engRatio: r.chars ? r.eng / r.chars : 0,
    identRatio: r.chars ? r.ident / r.chars : 0,
    injectedSegs: r.withInject,
    plainSegs: r.withoutInject,
    lastAt: r.lastAt,
  }))
  .sort((a, b) => (a.segMean ?? 1) - (b.segMean ?? 1))

console.log(`会话文件 ${files.length}，有效扫描 ${sessionsScanned}，模型路由 ${rows.length}`)
console.log('')
console.log('判定看 segMean（段级均值）；weighted 会被超长英文段主导，仅对照')
console.log(
  'model'.padEnd(36) +
    'segs'.padStart(6) +
    'sess'.padStart(5) +
    '段均v3'.padStart(8) +
    '注入段均'.padStart(9) +
    '加权'.padStart(7) +
    'v2'.padStart(6) +
    '英文'.padStart(6) +
    '标识'.padStart(6) +
    'in/out'.padStart(11),
)
for (const r of rows) {
  const pct = (v) => (v === null || v === undefined ? '   —' : (v * 100).toFixed(1) + '%')
  console.log(
    r.model.padEnd(36) +
      String(r.segments).padStart(6) +
      String(r.sessions).padStart(5) +
      pct(r.segMean).padStart(8) +
      pct(r.segMeanInjected).padStart(9) +
      pct(r.weighted).padStart(7) +
      pct(r.coverage).padStart(6) +
      pct(r.engRatio).padStart(6) +
      pct(r.identRatio).padStart(6) +
      `${r.injectedSegs}/${r.plainSegs}`.padStart(11),
  )
}
