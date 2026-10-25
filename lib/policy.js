/**
 * 配置归一化与模型黑名单匹配（纯函数，无 IO）。
 *
 * README「配置」表里的四个配置键在这里定型；`logFile` 是本实现追加的可选项，
 * 只影响日志落点（测试与多 profile 场景用），不改变任何判定逻辑。
 */

export const DEFAULT_REPORT_SESSIONS = 20
export const MAX_REPORT_SESSIONS = 200
export const DEFAULT_COVERAGE_THRESHOLD = 0.6
export const DEFAULT_LOG_FILE = ''

function clampInteger(value, fallback, min, max) {
  if (!Number.isFinite(value)) return fallback
  const integer = Math.trunc(value)
  if (integer < min) return min
  if (integer > max) return max
  return integer
}

function clampThreshold(value, fallback) {
  if (!Number.isFinite(value)) return fallback
  if (value < 0) return 0
  if (value > 1) return 1
  return value
}

/**
 * `provider/model` 与裸 `model` 两种写法都接受；空白项丢弃、重复项去重。
 * 大小写保持原样：模型 ID 区分大小写。
 */
export function normalizeBlacklist(value) {
  if (!Array.isArray(value)) return []
  const entries = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed || entries.includes(trimmed)) continue
    entries.push(trimmed)
  }
  return entries
}

/**
 * @param {unknown} raw 插件 config 块
 * @returns {{
 *   enabled: boolean,
 *   modelBlacklist: string[],
 *   reportSessions: number,
 *   coverageThreshold: number,
 *   logFile: string,
 * }}
 */
export function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  return {
    enabled: config.enabled !== false,
    modelBlacklist: normalizeBlacklist(config.modelBlacklist),
    reportSessions: clampInteger(config.reportSessions, DEFAULT_REPORT_SESSIONS, 1, MAX_REPORT_SESSIONS),
    coverageThreshold: clampThreshold(config.coverageThreshold, DEFAULT_COVERAGE_THRESHOLD),
    logFile: typeof config.logFile === 'string' && config.logFile.trim() ? config.logFile.trim() : DEFAULT_LOG_FILE,
  }
}

/**
 * 黑名单匹配：裸模型名，或 `provider/model`。provider 缺失时只比裸名。
 *
 * @param {{ provider?: string | null, model?: string | null } | null | undefined} route
 * @param {readonly string[]} blacklist
 */
export function matchesBlacklist(route, blacklist) {
  if (!route || typeof route.model !== 'string' || !route.model) return false
  if (!Array.isArray(blacklist) || blacklist.length === 0) return false
  const provider = typeof route.provider === 'string' ? route.provider : ''
  const full = provider ? `${provider}/${route.model}` : route.model
  return blacklist.includes(route.model) || blacklist.includes(full)
}
