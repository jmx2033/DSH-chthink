/**
 * 覆盖率算法（纯函数，无 IO）。2026-10-23 把口径从 v1 修订为 v2：
 *
 *   coverage = count(CJK 统一表意文字) / count(自然语言字符)
 *   自然语言字符 = 全部字符 − 代码块内字符 − 数字 − 标点 − 空白 − 符号
 *
 * v2 相对 v1 只改一处：分母再排除 Unicode 符号（`\p{S}`，数学运算符 `= × +`、
 * 箭头、emoji 等）。原因：这些字符不是自然语言，却会把明确是中文的数学推理
 * 压到 0.55 左右，被 0.6 阈值误判成 failed。真实样本实测 0.5570 → 0.8980。
 * 同时把「数字」从 `\p{Nd}` 扩到 `\p{N}`（含 `²`、`½` 这类上标/分数），
 * 与「数字」的字面含义一致。
 *
 * 口径版本写进日志行的 `metricVersion`，v1 旧行不能与 v2 直接比较。
 *
 * 口径刻意保持简单：它只回答「这段思考是不是用中文写的」，不做语言识别、
 * 不做分词。英文推理的 coverage 会趋近 0，中英夹杂会落在中间，这正是
 * `chthink_report` 判 failed 的依据。
 *
 * 两处边界写死在这里，不散落在调用方：
 *   - 围栏代码块（``` / ~~~）整段剔除；未闭合的围栏一直剔到文末。
 *   - 行内代码不剔（文档口径只有「代码块」），所以路径、工具名等仍会
 *     进入分母，压低一点覆盖率——这是预期的保守方向。
 */

export const COVERAGE_METRIC_VERSION = 2

const HAN = /\p{Script=Han}/u
const NUMBER = /\p{N}/u
const PUNCTUATION = /\p{P}/u
const SYMBOL = /\p{S}/u
const WHITESPACE = /\s/u

/**
 * 剔除围栏代码块。反引号/波浪号至少三个，开标记可带语言名，
 * 闭标记必须单独占一行（允许行首缩进）。
 */
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm

/** 小数点后 4 位足够区分，也避免浮点噪声进日志。 */
function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * @param {unknown} text 一段自然语言（通常是 assistant 消息里的 reasoning 全文）
 * @returns {{ chars: number, cjk: number, coverage: number | null }}
 *   `chars` 是分母（自然语言字符数）；没有任何可计字符时 `coverage` 为 null。
 */
export function analyseCoverage(text) {
  const source = typeof text === 'string' ? text : ''
  const body = source.replace(FENCED_CODE, ' ')

  let chars = 0
  let cjk = 0
  for (const ch of body) {
    if (NUMBER.test(ch) || PUNCTUATION.test(ch) || SYMBOL.test(ch) || WHITESPACE.test(ch)) continue
    chars += 1
    if (HAN.test(ch)) cjk += 1
  }

  return {
    chars,
    cjk,
    coverage: chars === 0 ? null : round4(cjk / chars),
  }
}

/**
 * 从 DSH 的 assistant/message 事件流里抽出 reasoning 文本与模型身份。
 * 纯函数，便于回归测试；事件形状见 SessionEventMap['assistant/message']。
 *
 * @param {readonly unknown[]} events
 * @returns {{
 *   text: string,
 *   segments: number,
 *   provider: string | null,
 *   model: string | null,
 *   lastAt: number,
 * }}
 */
export function collectThinking(events) {
  const parts = []
  let segments = 0
  let provider = null
  let model = null
  let lastAt = 0

  for (const event of Array.isArray(events) ? events : []) {
    if (!event || typeof event !== 'object' || event.type !== 'assistant/message') continue
    const data = event.data && typeof event.data === 'object' ? event.data : {}
    const message = data.message && typeof data.message === 'object' ? data.message : {}

    let touched = false
    for (const block of Array.isArray(message.content) ? message.content : []) {
      if (block && block.type === 'reasoning' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text)
        touched = true
      }
    }
    if (touched) {
      segments += 1
      if (typeof event.time === 'number' && event.time > lastAt) lastAt = event.time
    }

    const source = message.source && typeof message.source === 'object' ? message.source : {}
    if (typeof source.model === 'string' && source.model) model = source.model
    if (typeof source.provider === 'string' && source.provider) provider = source.provider
  }

  return { text: parts.join('\n\n'), segments, provider, model, lastAt }
}
