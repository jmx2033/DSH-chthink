/**
 * dsh-chthink（DSH Chinese Thinking）—— DSH Host 插件
 *
 * 唯一主通道：向 systemPrompt 服务注册一个固定排在全文末尾的分区，让模型在
 * thinking 阶段用简体中文推理。不做翻译兜底、不拦截流、不改最终回答。
 *
 * 检测通道：只读工具 `chthink_report` 通过 sessionQuery 回放最近若干会话的
 * reasoning 内容，统计中文覆盖率并追加到 ~/.dsh/chthink/log.jsonl。
 * 覆盖率只用于日志里的 failed 标记与人工调参，不触发任何运行时动作。
 *
 * 模型黑名单（本版已实做）：`agent/request` 拿到当步解析后的 provider/model，
 * 同时 `section.text` 与 `system-prompt/assemble` 都会按黑名单判断；命中时返回
 * 空文本——renderPrompt 会丢弃空 section，系统提示词里不会留下痕迹。
 * 装配发生在请求解析之前，所以「刚切换到被拉黑模型」的第一步可能仍注入一次，
 * 第二步起稳定跳过；这是事件顺序决定的，不影响正常使用。
 *
 * 硬约束（DSH 工具注册的实测要求）：
 *   - 工具返回值必须无损 JSON 可序列化：一律显式构造成 string/number/boolean/null/数组/纯对象，
 *     不把服务对象、ctx、undefined 放进返回值。
 *   - 不 import 任何宿主包；只用 node: 内置模块与本地相对路径。
 *   - 会话读取只读：不改写、不删除、不创建任何会话文件。
 */

import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

import { analyseCoverage, collectThinking, COVERAGE_METRIC_VERSION } from './lib/coverage.js'
import {
  DEFAULT_REPORT_SESSIONS,
  MAX_REPORT_SESSIONS,
  matchesBlacklist,
  normalizeConfig,
} from './lib/policy.js'

export const name = 'chthink'

/** systemPrompt 是主通道，tools 用于注册只读报告工具。 */
export const inject = ['systemPrompt', 'tools']

const SECTION_NAME = 'chthink:thinking-language'

/** 大于内置最大值 DEPLOYMENT_PERSONA_SUFFIX = 10200，固定在系统提示词末尾。 */
const SECTION_ORDER = 10300

/**
 * 与分区同名：两处贡献在各自序列里都排最后（同名便于一起被 scoped shadow）。
 *
 * 为什么取 220 而不是置顶：宿主对 contexts 只按 order 做**稳定排序**（不像
 * sections 有名字典序破平），取 100 会与内置 WORKING_DIRECTORY 同序、落点随
 * 插件加载顺序漂移。220 严格大于内置最大值 WEB_SURFACE = 210，确定排在快照
 * 末尾——也最靠近当步生成。A/B 实测里「末尾」的变体 A（0.215）也不低于
 * 「置顶」的变体 B（0.166）。
 */
const CONTEXT_NAME = 'chthink:thinking-language'
const CONTEXT_ORDER = 220

/**
 * 措辞要点：
 *   - 明确「思考语言」与「回答语言」是两件事，英文提问不能被中文回答；
 *   - 声明代码、公式、专有名词豁免，保护回答正确性；
 *   - 用「硬性要求 / 从第一个字到最后一个字 / 禁止用英文思考」这类强措辞；
 *   - **反风格惯性条款**（2026-10-23 补）：模型会模仿自己前文的语言。一条
 *     会话里只要攒下几段英文 reasoning，后续轮次就跟着写英文，哪怕规则没变。
 *     实测：同一 qfmodel 在全新会话里 100% 中文，在已污染的长会话里 0–1% 中文。
 *     所以必须显式声明「此前轮次的英文思考不作数，从现在起改用中文」。
 */
const INJECT_TEXT =
  '[language-requirement] 硬性要求：你的 thinking / reasoning 内容必须从第一个字到最后一个字全部使用简体中文书写，' +
  '禁止用英文思考或写英文句子。即使题目、代码、路径或工具名是英文，也只允许在引用时保留原文；' +
  '代码、数学公式与专有名词保持原文。' +
  '本要求优先于你自己此前轮次的思考风格：即使上文中的 thinking 是英文，那也只是旧要求生效前的历史，' +
  '不得模仿；从本步起一律用中文思考。最终回复的语言仍跟随用户提问语言。'

/**
 * 每步刷新的运行时上下文提醒。
 *
 * 为什么不只靠系统提示词分区：runtime context 快照是**每一步重新渲染、贴在用户
 * 轮次一侧**的消息（`Current runtime context…`），比固定在系统提示词末尾的分区
 * 离当步生成更近，对「延续历史英文风格」这股惯性更管用。
 *
 * 2026-10-23 A/B 实测（同一条被污染会话，按字符加权覆盖率）：
 *   未注入 0.022 → 变体 A（长句+快照末尾）0.215 → 变体 B（短句+置顶）0.166。
 *   A/B 差距小于任务内容噪声，且都远好于未注入；最终采用 A 的完整措辞
 *   （含代码/公式豁免与回答语言条款，保护回答正确性）与末尾位置。
 *   对被污染的长会话，提示词通道收益到此见顶，剩余失效属模型能力边界，
 *   此时静默展示英文原文，不做任何兜底或提示。
 */
const CONTEXT_TEXT =
  '[language-requirement] 本会话的思考语言要求仍然生效：thinking / reasoning 全程用简体中文书写，' +
  '禁止英文思考句子；代码、数学公式与专有名词保留原文；此前轮次里若是英文思考属于历史，不要模仿；' +
  '最终回复语言跟随用户提问。'

const DEFAULT_LOG_FILE = path.join(homedir(), '.dsh', 'chthink', 'log.jsonl')
const TOOL_NAME = 'chthink_report'

/** 单条错误原因进返回值前截断，避免把栈或超长路径塞进上下文。 */
function errorMessage(error, max = 200) {
  const text = error instanceof Error ? error.message : String(error)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * 稳定 JSONL 追加：每行一条独立对象。
 * @param {readonly Record<string, unknown>[]} lines
 * @param {string} filePath
 * @returns {Promise<number>} 实际写入行数
 */
async function appendJsonLines(lines, filePath) {
  if (lines.length === 0) return 0
  await mkdir(path.dirname(filePath), { recursive: true })
  await appendFile(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n', 'utf8')
  return lines.length
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig = {}) {
  const config = normalizeConfig(rawConfig)
  if (!config.enabled) return

  const blacklist = config.modelBlacklist
  const logFile = config.logFile || DEFAULT_LOG_FILE
  const threshold = config.coverageThreshold

  /**
   * agent → 当步解析后的路由。WeakMap 不持有 agent 生命周期；
   * 没有缓存时退回 Agent.options（静态默认模型）。
   */
  const routeCache = new WeakMap()

  function resolveRoute(agent) {
    if (!agent || typeof agent !== 'object') return null
    const cached = routeCache.get(agent)
    if (cached) return cached
    const options = agent.options
    if (!options || typeof options !== 'object') return null
    const model = typeof options.model === 'string' ? options.model : ''
    if (!model) return null
    return { provider: typeof options.provider === 'string' ? options.provider : '', model }
  }

  // 请求解析的最终配置就是这一步真正使用的模型；记下来供后续装配参考。
  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next()
    const agent = payload && typeof payload === 'object' ? payload.agent : undefined
    if (agent && resolved && typeof resolved.model === 'string' && resolved.model) {
      routeCache.set(agent, {
        provider: typeof resolved.provider === 'string' ? resolved.provider : '',
        model: resolved.model,
      })
    }
    return resolved
  })

  // 兜底：装配阶段已经带上了 provider/model 变量（由模型选择提供）时，
  // 直接按本次真实模型剔除本插件的分区，覆盖「切换模型后的第一步」。
  ctx.on('system-prompt/assemble', async (assembly, context, next) => {
    const assembled = await next()
    if (!assembled || typeof assembled !== 'object') return assembled
    const variables = assembled.variables && typeof assembled.variables === 'object' ? assembled.variables : {}
    const model = typeof variables.model === 'string' ? variables.model : ''
    if (!model) return assembled

    const route = {
      provider: typeof variables.provider === 'string' ? variables.provider : '',
      model,
    }
    const agent = context && typeof context === 'object' ? (context.agent ?? context.scope) : undefined
    if (agent && typeof agent === 'object') routeCache.set(agent, route)
    if (!matchesBlacklist(route, blacklist)) return assembled

    const ours = (item) => item && item.name !== SECTION_NAME && item.name !== CONTEXT_NAME
    return {
      ...assembled,
      sections: (Array.isArray(assembled.sections) ? assembled.sections : []).filter(ours),
      contexts: (Array.isArray(assembled.contexts) ? assembled.contexts : []).filter(ours),
    }
  })

  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: SECTION_ORDER,
    // 空字符串会被 renderPrompt 过滤掉，黑名单命中时等于「没有这个分区」。
    text: (context) => {
      const agent = context && typeof context === 'object' ? (context.agent ?? context.scope) : undefined
      return matchesBlacklist(resolveRoute(agent), blacklist) ? '' : INJECT_TEXT
    },
    interpolate: false,
  })

  // 每步刷新的运行时上下文：快照贴在用户轮次一侧，比系统提示词末尾离当步更近，
  // 用来对抗「模仿自己上文英文思考」的风格惯性。renderContextSections 会丢弃
  // 空文本，所以黑名单命中时同样干净。
  //
  // 不设 required：别的 preset 若显式 suppress 运行时上下文，那是用户的选择，
  // 这里不强行挤进去；此时主通道（系统提示词分区）仍然生效。
  ctx.systemPrompt.context({
    name: CONTEXT_NAME,
    order: CONTEXT_ORDER,
    text: (context) => {
      const agent = context && typeof context === 'object' ? (context.agent ?? context.scope) : undefined
      return matchesBlacklist(resolveRoute(agent), blacklist) ? '' : CONTEXT_TEXT
    },
    interpolate: false,
  })

  // 可选的会话读取通道：服务缺席时插件照常注入，只是报告工具如实报错。
  let sessionQuery
  ctx.inject(['sessionQuery'], (scoped) => {
    sessionQuery = scoped.sessionQuery
    return () => {
      sessionQuery = undefined
    }
  })

  ctx.tools.register({
    name: TOOL_NAME,
    description:
      '只读统计最近若干会话里 thinking（reasoning）内容的中文覆盖率，并把每个会话的结果追加到本地日志；' +
      '用于确认中文思考注入是否生效、哪些模型持续失效。不改写任何会话，也不产生模型调用。',
    parameters: {
      type: 'object',
      properties: {
        sessions: {
          type: 'integer',
          minimum: 1,
          maximum: MAX_REPORT_SESSIONS,
          description: `扫描最近多少个会话（按最近活跃排序）；默认取配置 reportSessions，未配置时 ${DEFAULT_REPORT_SESSIONS}。`,
        },
        writeLog: {
          type: 'boolean',
          description: '是否把结果追加到 ~/.dsh/chthink/log.jsonl；默认 true，只想看结果时可传 false。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args) {
      const input = args && typeof args === 'object' ? args : {}
      const requested = Number.isFinite(input.sessions) ? input.sessions : config.reportSessions
      const limit = Math.max(1, Math.min(MAX_REPORT_SESSIONS, Math.trunc(requested)))
      const writeLog = input.writeLog !== false

      const query = sessionQuery
      if (!query || typeof query.listSessions !== 'function' || typeof query.readSession !== 'function') {
        return {
          ok: false,
          result: '会话读取服务 sessionQuery 不可用，无法统计覆盖率。',
          threshold,
          logFile: writeLog ? logFile : null,
        }
      }

      let records
      try {
        records = await query.listSessions()
      } catch (error) {
        return {
          ok: false,
          result: `列出会话失败：${errorMessage(error)}`,
          threshold,
          logFile: writeLog ? logFile : null,
        }
      }

      const list = Array.isArray(records) ? records.slice(0, limit) : []
      const sessions = []
      const unreadableDetails = []
      let totalChars = 0
      let totalCjk = 0

      for (const record of list) {
        const header = record && typeof record === 'object' && record.header && typeof record.header === 'object' ? record.header : {}
        const sessionId = typeof header.id === 'string' ? header.id : ''
        if (!sessionId) continue

        let snapshot
        try {
          snapshot = await query.readSession(sessionId)
        } catch (error) {
          unreadableDetails.push({ sessionId, reason: errorMessage(error) })
          continue
        }

        // 子会话/分支会重放父会话历史；只统计本会话自己的事件。
        const inheritedRaw = Number(snapshot && typeof snapshot === 'object' ? snapshot.inheritedEventCount : 0)
        const inherited = Number.isFinite(inheritedRaw) && inheritedRaw > 0 ? Math.trunc(inheritedRaw) : 0
        const events = Array.isArray(snapshot && snapshot.events) ? snapshot.events : []
        const ownEvents = inherited > 0 ? events.slice(inherited) : events

        const thinking = collectThinking(ownEvents)
        const stats = analyseCoverage(thinking.text)

        sessions.push({
          sessionId,
          cwd: typeof header.cwd === 'string' ? header.cwd : null,
          provider: thinking.provider,
          model: thinking.model,
          segments: thinking.segments,
          chars: stats.chars,
          cjk: stats.cjk,
          coverage: stats.coverage,
          failed: stats.coverage !== null && stats.coverage < threshold,
          lastAt: thinking.lastAt > 0 ? new Date(thinking.lastAt).toISOString() : null,
        })

        totalChars += stats.chars
        totalCjk += stats.cjk
      }

      const withThinking = sessions.filter((entry) => entry.segments > 0)
      const failedSessions = withThinking.filter((entry) => entry.failed)
      const overallCoverage = totalChars === 0 ? null : round4(totalCjk / totalChars)

      let logWritten = 0
      let logError = null
      if (writeLog) {
        const ts = new Date().toISOString()
        const lines = withThinking.map((entry) => ({
          ts,
          metricVersion: COVERAGE_METRIC_VERSION,
          sessionId: entry.sessionId,
          provider: entry.provider,
          model: entry.model,
          chars: entry.chars,
          cjk: entry.cjk,
          coverage: entry.coverage,
          failed: entry.failed,
          segments: entry.segments,
        }))
        try {
          logWritten = await appendJsonLines(lines, logFile)
        } catch (error) {
          logError = errorMessage(error)
        }
      }

      const parts = [
        `扫描 ${list.length} 个会话：${withThinking.length} 个有 thinking 内容`,
        `总体覆盖率 ${overallCoverage === null ? 'n/a' : overallCoverage.toFixed(4)}（阈值 ${threshold}）`,
        `${failedSessions.length} 个未达标`,
      ]
      if (unreadableDetails.length > 0) parts.push(`${unreadableDetails.length} 个读不出`)
      if (writeLog) {
        parts.push(logError ? `日志写入失败：${logError}` : `已追加 ${logWritten} 行到 ${logFile}`)
      }

      return {
        ok: true,
        result: parts.join('；') + '。',
        threshold,
        metricVersion: COVERAGE_METRIC_VERSION,
        reportSessions: limit,
        logFile: writeLog ? logFile : null,
        logWritten,
        logError,
        scannedSessions: list.length,
        sessionsWithThinking: withThinking.length,
        sessionsWithoutThinking: sessions.length - withThinking.length,
        unreadable: unreadableDetails.length,
        unreadableDetails,
        totalChars,
        totalCjk,
        overallCoverage,
        failedSessions: failedSessions.length,
        sessions,
        injection: {
          sectionName: SECTION_NAME,
          order: SECTION_ORDER,
          contextName: CONTEXT_NAME,
          contextOrder: CONTEXT_ORDER,
          text: INJECT_TEXT,
          contextText: CONTEXT_TEXT,
          modelBlacklist: blacklist,
        },
      }
    },
  })
}
