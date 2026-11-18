/**
 * dsh-chthink 冒烟测试（无框架，直接 `node test/smoke-test.mjs`）。
 *
 * 覆盖 README「自测 / 验收」里可离线验证的部分：
 *   - 分区与运行时上下文注册（name / order / interpolate / 文本）；
 *   - 模型黑名单（静态 options、agent/request 解析结果、装配期兜底）；
 *   - 覆盖率算法（中文、英文、围栏代码块、数学符号、空文本）；
 *   - chthink_report 的读取、继承事件切片、失败隔离、JSONL 追加；
 *   - 返回值无损 JSON 可序列化（DSH 工具注册的硬性要求）。
 *
 * 真实注入效果与 DSH 重启后的行为无法在这里验证，属于安装期验收。
 */

import assert from 'node:assert/strict'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

import { apply, inject, name } from '../index.js'
import { analyseCoverage, collectThinking, COVERAGE_METRIC_VERSION } from '../lib/coverage.js'
import { matchesBlacklist, normalizeBlacklist, normalizeConfig } from '../lib/policy.js'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ✓ ${label}`)
}

function assistantEvent(time, text, model = 'deepseek-flash', provider = 'acme-gateway') {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: text === null ? [{ type: 'text', text: 'ok' }] : [{ type: 'reasoning', text }],
        source: { kind: 'model', provider, model },
      },
      stream: [],
    },
  }
}

/** 递归确认返回值只含 JSON 可无损往返的值。 */
function assertLossless(value, label = 'result') {
  if (value === null) return
  const type = typeof value
  if (type === 'string' || type === 'boolean') return
  if (type === 'number') {
    assert.ok(Number.isFinite(value), `${label} 含非有限数字`)
    return
  }
  assert.ok(type === 'object', `${label} 含不可序列化类型 ${type}`)
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertLossless(item, `${label}[${index}]`))
    return
  }
  assert.equal(Object.getPrototypeOf(value), Object.prototype, `${label} 不是纯对象`)
  for (const [key, child] of Object.entries(value)) assertLossless(child, `${label}.${key}`)
}

function makeContext() {
  const ctx = {
    sections: [],
    contexts: [],
    registeredTools: [],
    listeners: new Map(),
    injectRequests: [],
    get(name) {
      if (name === 'sessionQuery') return ctx.sessionQuery
      return undefined
    },
    systemPrompt: {
      section(definition) {
        ctx.sections.push(definition)
        return () => {}
      },
      context(definition) {
        ctx.contexts.push(definition)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        ctx.registeredTools.push(definition)
        return () => {}
      },
    },
    inject(deps, callback) {
      ctx.injectRequests.push({ deps, callback })
      return () => {}
    },
    on(event, listener) {
      const list = ctx.listeners.get(event) ?? []
      list.push(listener)
      ctx.listeners.set(event, list)
      return () => {}
    },
  }
  return ctx
}

function applyPlugin(config) {
  const ctx = makeContext()
  apply(ctx, config)
  return ctx
}

function activate(ctx, sessionQuery) {
  ctx.sessionQuery = sessionQuery
  for (const { callback } of ctx.injectRequests) callback({ sessionQuery })
}

function freshLogFile() {
  return path.join(tmpdir(), `chthink-test-${randomUUID()}.jsonl`)
}

// ── 1. 覆盖率算法 ────────────────────────────────────────────────
console.log('覆盖率算法')
{
  const chinese = analyseCoverage('我们需要先读取配置文件，然后确认服务名是否可用。')
  assert.equal(chinese.coverage, 1)
  assert.ok(chinese.chars > 0 && chinese.cjk === chinese.chars)
  ok('纯中文覆盖率 = 1，标点/空白不进分母')

  const english = analyseCoverage('We should read the config file first, then register the section.')
  assert.equal(english.coverage, 0)
  assert.ok(english.chars > 0)
  ok('纯英文覆盖率 = 0')

  const fenced = analyseCoverage('先看配置：\n```js\nconst value = foo(1, 2)\n```\n然后注册分区。')
  assert.ok(fenced.coverage > 0.9, `实际 ${fenced.coverage}`)
  ok('围栏代码块被剔除，不拉低覆盖率')

  const unclosed = analyseCoverage('先看配置：\n```js\nconst value = 1\n')
  assert.ok(unclosed.coverage > 0.9, `实际 ${unclosed.coverage}`)
  ok('未闭合围栏一直剔到文末')

  const digits = analyseCoverage('版本 0.2.1，共 20 个会话。')
  assert.equal(digits.coverage, 1)
  ok('数字不进分母')

  const math = analyseCoverage('17×23 = 391，19×21 = 399。所以 19×21 更大，大 8。')
  assert.equal(math.coverage, 1)
  ok('数学运算符（× =）按符号剔除，纯中文数学推理不再被误判')

  const superscript = analyseCoverage('面积是 20²，体积是 20³，占 ½。')
  assert.equal(superscript.coverage, 1)
  ok('上标/分数类数字（²、½）也不进分母')

  assert.equal(analyseCoverage('').coverage, null)
  assert.equal(analyseCoverage('，。！ \n\t').coverage, null)
  ok('没有可计字符时 coverage = null')
}

// ── 1b. v3：把「英文句子」与「被豁免的标识符」拆开 ─────────────────
console.log('v3 片段分类')
{
  // 中文思考里夹标识符：v2 会压低覆盖率，v3 必须判成完全遵循
  const identifiers = analyseCoverage(
    '任务：统计 1 到 20000 之间素数的个数，要用实际计算。用 Python 或者简单脚本跑一下。用 ops_bash 跑一段 Python 或 awk。我用 Python 做埃拉托斯特尼筛法。',
  )
  assert.equal(identifiers.chineseRatio, 1, `标识符被误判成英文句子：${identifiers.chineseRatio}`)
  assert.equal(identifiers.englishChars, 0)
  assert.ok(identifiers.identifierChars > 20, '标识符应计入 identifierChars')
  assert.ok(identifiers.coverage < 1, 'v2 口径仍应偏低（证明两者确有差异）')
  ok('中文 + 标识符：v3 判 100% 遵循，v2 偏低')

  // 函数调用连写不能被当成英文行文（primepi(20000) 与 len(primerange(...))）
  const calls = analyseCoverage(
    '再用 sympy 的 primepi(20000) 与 len(primerange(1, 20001)) 作第三方交叉核对，同样得 2262，三者一致。',
  )
  assert.equal(calls.chineseRatio, 1, `函数调用被误判：englishChars=${calls.englishChars}`)
  ok('函数调用与括号紧贴的标识符不算英文句子')

  // 真英文句子必须被抓出来
  const english = analyseCoverage(
    '先看配置。Wait, I need to double check one thing before we proceed, does it get injected into every step? 然后继续。',
  )
  assert.ok(english.chineseRatio < 0.2, `英文句子未被识别：${english.chineseRatio}`)
  assert.ok(english.englishChars > 50, '英文字符应计入 englishChars')
  assert.ok(english.englishSegments >= 1)
  ok('中文夹完整英文句子：v3 判为违规')

  // 全英文
  const pure = analyseCoverage('We should read the config file first, then register the section.')
  assert.equal(pure.chineseRatio, 0)
  assert.equal(pure.englishSentenceRatio, 1)
  ok('纯英文 reasoning：chineseRatio = 0，englishSentenceRatio = 1')

  // 纯标识符片段（无虚词、无三连 plain 词）保持豁免
  const onlyIds = analyseCoverage('调用 get_tree().paused 后 _process 停止，process_mode 为 ALWAYS。')
  assert.equal(onlyIds.chineseRatio, 1, `点号/下划线标识符被误判：${onlyIds.chineseRatio}`)
  ok('点号与下划线形态的标识符不参与英文句子判定')

  // 无信号词但连续 3 个以上普通英文词 → 判英文（保守兜底）
  const run = analyseCoverage('这里需要 check the value again 然后继续处理。')
  assert.ok(run.chineseRatio < 0.8, `连续英文词未被识别：${run.chineseRatio}`)
  ok('连续普通英文词触发英文句子判定')

  // 行内代码整段剔除
  const inline = analyseCoverage('调用 `get_tree().paused = true` 之后节点停止处理，我们验证一下。')
  assert.equal(inline.chineseRatio, 1)
  ok('行内代码在 v3 里整段剔除')

  // 三个占比与 chars 的自洽性
  const sample = analyseCoverage('统计 1 到 20000 之间素数的个数，用 Python 跑 ops_bash 验证。')
  assert.ok(sample.hanChars + sample.englishChars + sample.identifierChars <= sample.chars)
  assert.equal(sample.englishChars, 0)
  assert.equal(sample.chineseRatio, 1)
  assert.ok(sample.identifierRatio > 0 && sample.identifierRatio < 1)
  ok('han/english/identifier 三段互斥且与 chineseRatio 自洽')
}

// ── 2. collectThinking ──────────────────────────────────────────
console.log('thinking 抽取')
{
  const thinking = collectThinking([
    assistantEvent(1000, '第一段推理。'),
    { type: 'tool/call', time: 1001, data: { name: 'ops_bash' } },
    assistantEvent(1002, '第二段推理。', 'other-model', 'other-provider'),
  ])
  assert.equal(thinking.segments, 2)
  assert.equal(thinking.model, 'other-model')
  assert.equal(thinking.provider, 'other-provider')
  assert.equal(thinking.lastAt, 1002)
  assert.ok(thinking.text.includes('第一段推理') && thinking.text.includes('第二段推理'))
  ok('多段 reasoning 合并，模型取最后一条')

  const none = collectThinking([assistantEvent(1000, null)])
  assert.equal(none.segments, 0)
  assert.equal(none.text, '')
  ok('没有 reasoning 时 segments = 0')
}

// ── 3. 配置与黑名单 ─────────────────────────────────────────────
console.log('配置与黑名单')
{
  const config = normalizeConfig({
    enabled: false,
    modelBlacklist: [' a ', 'a', '', 'p/m', 3],
    reportSessions: 999,
    coverageThreshold: 1.7,
  })
  assert.equal(config.enabled, false)
  assert.deepEqual(config.modelBlacklist, ['a', 'p/m'])
  assert.equal(config.reportSessions, 200)
  assert.equal(config.coverageThreshold, 1)
  ok('黑名单去重去空，数值被夹到合法区间')

  const defaults = normalizeConfig(null)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.reportSessions, 20)
  assert.equal(defaults.coverageThreshold, 0.6)
  ok('缺省值与 README 配置表一致')

  assert.equal(matchesBlacklist({ provider: 'p', model: 'm' }, ['m']), true)
  assert.equal(matchesBlacklist({ provider: 'p', model: 'm' }, ['p/m']), true)
  assert.equal(matchesBlacklist({ provider: 'q', model: 'm' }, ['p/m']), false)
  assert.equal(matchesBlacklist(null, ['m']), false)
  ok('裸模型名与 provider/model 两种写法都命中')

  assert.deepEqual(normalizeBlacklist('m'), [])
  ok('非数组黑名单按空处理')
}

// ── 4. 插件注册 ─────────────────────────────────────────────────
console.log('插件注册')
{
  assert.equal(name, 'chthink')
  assert.deepEqual(inject, ['systemPrompt', 'tools'])

  const ctx = applyPlugin({})
  assert.equal(ctx.sections.length, 1)
  const section = ctx.sections[0]
  assert.equal(section.name, 'chthink:thinking-language')
  assert.equal(section.order, 10300)
  assert.equal(section.interpolate, false)
  assert.ok(section.order > 10200, '必须排在 DEPLOYMENT_PERSONA_SUFFIX 之后')
  assert.ok(section.text({ agent: { options: { provider: 'p', model: 'm' } } }).startsWith('[language-requirement]'))
  assert.ok(
    section.text({ agent: { options: { provider: 'p', model: 'm' } } }).includes('禁止用英文思考'),
    '必须使用实测有效的强措辞',
  )
  assert.ok(
    section.text({ agent: { options: { provider: 'p', model: 'm' } } }).includes('不得模仿'),
    '必须带反风格惯性条款（长会话会被英文历史带偏）',
  )

  // 每步刷新的运行时上下文：贴近当步生成，对抗历史英文风格惯性。
  assert.equal(ctx.contexts.length, 1)
  const promptContext = ctx.contexts[0]
  assert.equal(promptContext.name, 'chthink:thinking-language')
  assert.equal(promptContext.order, 220)
  assert.ok(promptContext.order > 210, '必须严格大于内置最大值 WEB_SURFACE = 210，确定排在快照末尾')
  assert.equal(promptContext.interpolate, false)
  assert.equal(promptContext.required, undefined, '不强制，尊重别的 preset 的 suppress 选择')
  assert.ok(
    promptContext.text({ agent: { options: { provider: 'p', model: 'm' } } }).includes('[language-requirement]'),
  )

  assert.equal(ctx.registeredTools.length, 1)
  assert.equal(ctx.registeredTools[0].name, 'chthink_report')
  ok('分区与运行时上下文各注册一次，工具一个，interpolate = false')

  // runtimeContext=false：只关通道2，主通道（系统提示词分区）必须保留。
  const noCtx = applyPlugin({ runtimeContext: false })
  assert.equal(noCtx.sections.length, 1, '主通道应仍在')
  assert.equal(noCtx.contexts.length, 0, 'runtimeContext=false 应关掉通道2')
  assert.equal(noCtx.registeredTools.length, 1, '报告工具不受影响')
  ok('runtimeContext=false 只关通道2，主通道与工具保留')

  // 默认（不写该键）两通道都在
  assert.equal(applyPlugin({}).contexts.length, 1, '默认应开通道2')
  ok('runtimeContext 默认开启')

  const disabled = applyPlugin({ enabled: false })
  assert.equal(disabled.sections.length, 0)
  assert.equal(disabled.contexts.length, 0)
  assert.equal(disabled.registeredTools.length, 0)
  ok('enabled=false 时不注册任何东西')

  const blocked = applyPlugin({ modelBlacklist: ['bad-model'] })
  const blockedSection = blocked.sections[0]
  const blockedContext = blocked.contexts[0]
  assert.equal(blockedSection.text({ agent: { options: { provider: 'p', model: 'bad-model' } } }), '')
  assert.equal(blockedContext.text({ agent: { options: { provider: 'p', model: 'bad-model' } } }), '')
  assert.ok(blockedSection.text({ agent: { options: { provider: 'p', model: 'good-model' } } }).length > 0)
  assert.ok(blockedContext.text({ agent: { options: { provider: 'p', model: 'good-model' } } }).length > 0)
  ok('黑名单命中时分区与上下文都返回空文本（空条目会被丢弃）')

  // agent/request 学到解析后的模型后，后续装配即按新模型判断。
  const requestListeners = blocked.listeners.get('agent/request') ?? []
  assert.equal(requestListeners.length, 1)
  const agent = { id: 's', options: { provider: 'p', model: 'good-model' } }
  const resolved = await requestListeners[0]({ agent }, async () => ({ provider: 'p', model: 'bad-model' }))
  assert.equal(resolved.model, 'bad-model')
  assert.equal(blockedSection.text({ agent }), '')
  ok('agent/request 解析出的模型会覆盖静态默认值')

  // 装配期兜底：variables 已带真实模型时直接剔除分区。
  const assembleListeners = blocked.listeners.get('system-prompt/assemble') ?? []
  assert.equal(assembleListeners.length, 1)
  const assembly = {
    sections: [
      { name: 'chthink:thinking-language', text: section.text({ agent }) },
      { name: 'other', text: 'x' },
    ],
    contexts: [
      { name: 'chthink:thinking-language', text: 'reminder' },
      { name: 'runtime:other', text: 'y' },
    ],
    variables: { provider: 'p', model: 'bad-model' },
  }
  const filtered = await assembleListeners[0](assembly, { agent }, async () => assembly)
  assert.deepEqual(
    filtered.sections.map((item) => item.name),
    ['other'],
  )
  assert.deepEqual(
    filtered.contexts.map((item) => item.name),
    ['runtime:other'],
  )
  ok('装配期兜底会剔除本插件的分区与运行时上下文')
}

// ── 5. chthink_report ───────────────────────────────────────────
console.log('chthink_report')
{
  const chineseEvent = assistantEvent(2000, '先读配置，再确认服务名，最后注册分区。\n```js\nconst a = 1\n```')
  const englishEvent = assistantEvent(2001, 'Read the config first, then register the section.')
  const inheritedEvent = assistantEvent(1999, 'Parent session reasoning in English only.')

  const snapshots = {
    'session-cn': { inheritedEventCount: 0, events: [chineseEvent, assistantEvent(2002, '第二段中文推理，继续确认边界。')] },
    'session-en': { inheritedEventCount: 0, events: [englishEvent] },
    'session-seeded': { inheritedEventCount: 1, events: [inheritedEvent, chineseEvent] },
    'session-empty': { inheritedEventCount: 0, events: [assistantEvent(2003, null)] },
  }

  const query = {
    async listSessions() {
      return ['session-cn', 'session-en', 'session-seeded', 'session-empty', 'session-broken'].map((id, index) => ({
        header: { id, cwd: 'D:/work/chthink', createdAt: index },
        live: false,
        persisted: true,
      }))
    },
    async readSession(id) {
      if (id === 'session-broken') throw new Error('replay validation failed')
      return snapshots[id]
    },
  }

  const logFile = freshLogFile()
  const ctx = applyPlugin({ logFile })
  activate(ctx, query)
  const tool = ctx.registeredTools[0]
  const result = await tool.execute({ sessions: 10 })

  assertLossless(result)
  assert.deepStrictEqual(JSON.parse(JSON.stringify(result)), result)
  ok('返回值无损 JSON 可序列化')

  assert.equal(result.ok, true)
  assert.equal(result.metricVersion, COVERAGE_METRIC_VERSION)
  assert.equal(result.scannedSessions, 5)
  assert.equal(result.unreadable, 1)
  assert.equal(result.sessionsWithThinking, 3)
  assert.equal(result.sessionsWithoutThinking, 1)
  assert.equal(result.failedSessions, 1)
  // 三个有 thinking 的会话里有一个纯英文，总体覆盖率被它拉低；
  // 单个中文会话仍各自通过。这正是「按会话判 failed、按总体看趋势」的口径。
  assert.ok(
    result.overallCoverage > 0.5 && result.overallCoverage < result.threshold,
    `实际 ${result.overallCoverage}`,
  )
  ok('读取、失败隔离、失败会话计数正确')

  const seeded = result.sessions.find((entry) => entry.sessionId === 'session-seeded')
  assert.ok(seeded.coverage > 0.9, `继承事件未被剔除：${seeded.coverage}`)
  ok('继承的父会话事件被剔除，不污染本会话覆盖率')

  const failing = result.sessions.find((entry) => entry.sessionId === 'session-en')
  assert.equal(failing.failed, true)
  assert.equal(failing.coverage, 0)
  const passing = result.sessions.find((entry) => entry.sessionId === 'session-cn')
  assert.equal(passing.failed, false)
  ok('failed 标记按阈值判定，覆盖中文/英文两端')

  const raw = await readFile(logFile, 'utf8')
  const lines = raw.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines.length, 3)
  for (const line of lines) {
    for (const key of ['ts', 'metricVersion', 'sessionId', 'chars', 'coverage', 'failed']) assert.ok(key in line, `缺字段 ${key}`)
    assert.equal(line.metricVersion, COVERAGE_METRIC_VERSION)
    assert.ok(['session-cn', 'session-en', 'session-seeded'].includes(line.sessionId))
  }
  assert.equal(result.logWritten, 3)
  ok('JSONL 每个有 thinking 的会话追加一行，字段与 README 日志格式一致')

  // 不写日志 & 会话数上限
  const quietLog = freshLogFile()
  const quiet = applyPlugin({ logFile: quietLog })
  activate(quiet, query)
  const limited = await quiet.registeredTools[0].execute({ sessions: 2, writeLog: false })
  assert.equal(limited.scannedSessions, 2)
  assert.equal(limited.logWritten, 0)
  await assert.rejects(readFile(quietLog, 'utf8'))
  ok('writeLog=false 不落盘，sessions 参数限制扫描数')

  // 会话服务缺席
  const missing = applyPlugin({})
  const unavailable = await missing.registeredTools[0].execute({})
  assert.equal(unavailable.ok, false)
  assertLossless(unavailable)
  ok('sessionQuery 缺席时如实返回 ok:false')

  await rm(logFile, { force: true })
}

// ── 6. 按模型聚合（折中方案：会话均值判定 + 注入在场区分 + 拉黑候选）─────
console.log('模型聚合与拉黑候选')
{
  const zh = '先读取配置文件然后注册分区并确认排序规则是否正确。'
  const en = 'We should read the config file first then register the section before assembling the prompt.'
  const inject = { type: 'system/message', time: 1, data: { message: { content: [{ type: 'text', text: '[language-requirement] 生效' }] } } }
  const noInject = { type: 'system/message', time: 1, data: { message: { content: [{ type: 'text', text: '没有语言要求' }] } } }
  const snap = (events) => ({ inheritedEventCount: 0, events })

  const routeSnapshots = {
    // 遵循良好：3 会话全中文、注入在场
    'g1': snap([inject, assistantEvent(2, zh, 'good', 'p')]),
    'g2': snap([inject, assistantEvent(2, zh, 'good', 'p')]),
    'g3': snap([inject, assistantEvent(2, zh, 'good', 'p')]),
    // 不遵循：3 会话全英文、注入在场 → 进候选
    'b1': snap([inject, assistantEvent(2, en, 'bad', 'p')]),
    'b2': snap([inject, assistantEvent(2, en, 'bad', 'p')]),
    'b3': snap([inject, assistantEvent(2, en, 'bad', 'p')]),
    // 样本不足：1 会话英文 → conclusive=false，不进候选
    'f1': snap([inject, assistantEvent(2, en, 'few', 'p')]),
    // 从未注入：3 会话英文但无 marker → 不能算模型不遵循，不进候选
    'n1': snap([noInject, assistantEvent(2, en, 'noinject', 'p')]),
    'n2': snap([noInject, assistantEvent(2, en, 'noinject', 'p')]),
    'n3': snap([noInject, assistantEvent(2, en, 'noinject', 'p')]),
    // 均值 vs 加权：2 会话中文(各1段) + 1 会话英文(5段)。
    // 会话均值 = (1+1+0)/3 ≈ 0.667；加权会被 5 段英文拉到接近 0。
    'm1': snap([inject, assistantEvent(2, zh, 'mix', 'p')]),
    'm2': snap([inject, assistantEvent(2, zh, 'mix', 'p')]),
    'm3': snap([inject, ...Array.from({ length: 5 }, (_, i) => assistantEvent(10 + i, en, 'mix', 'p'))]),
  }
  const ids = Object.keys(routeSnapshots)
  const query = {
    async listSessions() {
      return ids.map((id, index) => ({ header: { id, cwd: '/w', createdAt: index }, live: false, persisted: true }))
    },
    async readSession(id) {
      return routeSnapshots[id]
    },
  }

  const ctx = applyPlugin({ logFile: freshLogFile() })
  activate(ctx, query)
  const result = await ctx.registeredTools[0].execute({ sessions: 40, writeLog: false })

  assertLossless(result)
  const byRoute = Object.fromEntries(result.models.map((m) => [m.route, m]))

  // 注入在场标记
  assert.equal(byRoute['p/good'].injectedSessions, 3, 'good 应识别 3 个注入会话')
  assert.equal(byRoute['p/noinject'].injectedSessions, 0, 'noinject 不应算注入在场')
  ok('区分「注入在场」与「从未注入」')

  // 会话均值，不受段数主导
  assert.ok(
    byRoute['p/mix'].meanChineseRatio > 0.6 && byRoute['p/mix'].meanChineseRatio < 0.7,
    `应≈0.667(均值)，实际 ${byRoute['p/mix'].meanChineseRatio}`,
  )
  ok('遵循度用会话均值，不被少数超长英文段主导')

  // 拉黑候选：只有 bad 进，few/noinject/good/mix 都不进
  assert.ok(result.blacklistCandidates.includes('p/bad'), 'bad 应进候选')
  assert.ok(!result.blacklistCandidates.includes('p/few'), '样本不足不该进候选')
  assert.ok(!result.blacklistCandidates.includes('p/noinject'), '从未注入不该进候选')
  assert.ok(!result.blacklistCandidates.includes('p/good'), '遵循的不该进候选')
  assert.equal(byRoute['p/few'].conclusive, false)
  ok('拉黑候选只含「样本充足+注入在场+均值不达标」的路由')

  // 候选不自动改配置，只列出
  assert.ok(Array.isArray(result.blacklistCandidates))
  assert.equal(result.injection.modelBlacklist.length, 0, '候选不写回 modelBlacklist')
  ok('候选仅供人工确认，不自动写入配置')
}

console.log(`\n全部通过（${checks} 项检查）。`)
