/**
 * 覆盖率算法（纯函数，无 IO）。
 *
 * ## v2（保留，向后兼容）
 *
 *   coverage = count(汉字) / count(自然语言字符)
 *   自然语言字符 = 全部字符 − 代码块 − 数字 − 标点 − 空白 − 符号
 *
 * ## v3 新增：把「英文句子」和「被豁免的标识符」拆开
 *
 * v2 有一个测量缺陷：它把 `ops_bash`、`Python`、`sympy`、`get_tree()` 这类
 * 标识符和真正的英文推理句子算成同一种东西（都是「非汉字」）。编码类会话里
 * 标识符密度很高，于是模型明明遵循了要求，coverage 却只有 0.4–0.5，被误判成
 * 失效。实测对照：同一模型同一任务，受控新会话的 26% 非汉字几乎全是标识符。
 *
 * v3 按「词」分类，输出三个互斥量：
 *
 *   hanChars          汉字字符
 *   englishChars      英文句子片段里的拉丁字符（真正的违规量）
 *   identifierChars   标识符与专名字符（豁免，不算违规）
 *
 *   chineseRatio        = hanChars / (hanChars + englishChars)   ← 判定用这个
 *   englishSentenceRatio = englishChars / chars
 *   identifierRatio      = identifierChars / chars
 *
 * `coverage` 仍按 v2 计算，字段含义不变，便于与旧日志对比；`failed` 在 v3
 * 改由 `chineseRatio` 判定。日志行的 `metricVersion` 升到 3。
 *
 * ## 片段判定规则（写死在这里，不散落）
 *
 * 以汉字与非拉丁字符为界，把文本切成「拉丁片段」，逐片段判定：
 *   1. 片段含 FUNCTION_WORDS 里的词（虚词、高频动词、句首感叹词）→ 英文句子；
 *   2. 否则片段有 ≥3 个连续纯字母词（长度 ≥2）→ 英文句子；
 *   3. 否则 → 标识符/专名（豁免）。
 * 词级预分类：含 `_` `-` `.` `/` `\` `:` `@` 或数字、全大写短词、驼峰混合大小写
 * 一律先算标识符，不参与规则 1 的匹配（所以 `run_in_background` 不会因 `run` 命中）。
 *
 * 行内代码（`...`）在 v3 里整段剔除，不计入任何分子分母；v2 的 chars 口径不变。
 */

export const COVERAGE_METRIC_VERSION = 3

const HAN = /\p{Script=Han}/u
const NUMBER = /\p{N}/u
const PUNCTUATION = /\p{P}/u
const SYMBOL = /\p{S}/u
const WHITESPACE = /\s/u
const LATIN = /\p{L}/u

/** 围栏代码块：开标记可带语言名，闭标记单独成行；未闭合则剔到文末。 */
const FENCED_CODE = /^[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:^[ \t]*\1[ \t]*$|(?![\s\S]))/gm
/** 行内代码：只剔成对的短标记，不跨行。 */
const INLINE_CODE = /(`+)(?![\s`])[^`\n]*?\1/g

/**
 * 英文行文信号词。刻意只收「中文思考里不会单独出现、但在英文句子里高频」的词，
 * 宁可漏判成标识符（保守，不会冤枉模型）也不把工具名误判成英文句子。
 * 全部小写；匹配时对词做小写化。
 */
const FUNCTION_WORDS = new Set(
  (
    // 限定词 / 指示词 / 数量
    'a an the this that these those there here such every each other one two three four five ' +
    'first second third next last same different all any both few many much more most some no none ' +
    // 代词
    'i you he she it we they me him her us them my your his its our their mine yours hers ours theirs ' +
    'myself yourself himself herself itself ourselves themselves somebody anyone nothing something anything ' +
    // be / have / do
    'is are was were be been being am do does did doing have has had having ' +
    // 助动词
    'can could will would shall should may might must need neednt ' +
    // 介词 / 连词
    'of in on at to for with from by as into onto over under about above below between during since ' +
    'and or but nor so yet because while if then than though although however therefore thus hence ' +
    'within without against toward towards per via plus minus ' +
    // 高频动词
    'let make makes made making take takes took taking give gives gave giving get gets got getting ' +
    'know knew known think thinks thought want wants wanted needing needs use uses used using ' +
    'see sees saw seen seem seems seemed find finds found try tries tried keeping keeps kept ' +
    'start starts started stop stops stopped check checks checked run runs ran write writes wrote ' +
    'read reads send sends sent call calls called add adds added remove removes removed ' +
    'move moves moved build builds built test tests tested fix fixes fixed work works works ' +
    'go goes went go come comes came come look looks looked look tell tells told ask asks asked ' +
    'put puts set sets sit say says said see mean means meant allow allows allowed ' +
    // 副词 / 句首感叹词
    'just very also again now here wait hmm ok okay actually finally maybe probably instead ' +
    'rather otherwise simply still already yet never always often rarely quickly slowly ' +
    'directly basically certainly obviously unfortunately importantly note ' +
    // 疑问词
    'what when where who whom whose which why how'
  )
    .split(/\s+/)
    .filter(Boolean),
)

/** 含这些字符即视为标识符形态，不做词义匹配。 */
const IDENTIFIER_MARK = /[_\-./\\:@#]/
/** 驼峰或内部大写（opsBash / getTree / JSONParse）。 */
const CAMEL = /[a-z][A-Z]|[A-Z]{2,}[a-z]/

function round4(value) {
  return Math.round(value * 10000) / 10000
}

/**
 * 词级形态分类。
 * @returns {'identifier' | 'function' | 'plain'}
 */
function classifyWord(word) {
  if (IDENTIFIER_MARK.test(word)) return 'identifier'
  if (/\d/.test(word)) return 'identifier'
  if (CAMEL.test(word)) return 'identifier'
  // 全大写形态（ALWAYS / NULL / JSON / TRUE）一律算标识符，且**优先于词义**：
  // 否则 `ALWAYS` 会命中副词 always 而被当成英文句子。不限长度，只要求 ≥2 字母，
  // 好让英文句里的 `I` 仍走词义判定。
  if (word.length >= 2 && word === word.toUpperCase() && /[A-Z]/.test(word)) return 'identifier'
  if (FUNCTION_WORDS.has(word.toLowerCase())) return 'function'
  return 'plain'
}

/**
 * 词间允许的分隔符：这些字符说明两个拉丁词仍在同一句行文里。
 * 刻意**不含** `.` `/` `\` `=` `+` `-` `*` `<` `>` `|` `&` `$` 等代码符号——
 * 否则 `sympy primepi(20000) 与 len(primerange(1, 20001))` 这类连续函数调用
 * 会被粘成一段并误判成英文句子。
 */
const PROSE_GAP = /[ \t\r\n,;:!?"'()[\]{}]/u

/**
 * 把文本切成拉丁片段，并统计汉字字符。
 *
 * 逐字符状态机（不用「词 + 贪婪 gap」的写法，因为 gap 会把汉字一起吞掉，
 * 导致汉字漏计、跨汉字的词被粘进同一段）：
 *   - 汉字 → 计数并结束当前片段；
 *   - 拉丁词 → 形态分类后入段；
 *   - PROSE_GAP 字符 → 片段延续；
 *   - 其他字符（代码符号、全角标点等）→ 结束片段。
 */
function splitSegments(body) {
  const segments = []
  let hanChars = 0
  let current = null
  let plainRun = 0

  const close = () => {
    if (current && current.tokens.length > 0) segments.push(current)
    current = null
    plainRun = 0
  }
  const open = () => {
    if (!current) current = { tokens: [], englishByRun: false }
    return current
  }

  const wordRe = /[_A-Za-z][A-Za-z0-9_']*/y
  // 必须带 u：\p{Script=Han} 在无 u 标志时退化成字面量，汉字永远匹配不上
  const hanRe = /\p{Script=Han}/yu

  let pos = 0
  while (pos < body.length) {
    hanRe.lastIndex = pos
    const han = hanRe.exec(body)
    if (han) {
      hanChars += 1
      close()
      pos += 1
      continue
    }

    wordRe.lastIndex = pos
    const word = wordRe.exec(body)
    if (word && word.index === pos) {
      const kind = classifyWord(word[0])
      const segment = open()
      segment.tokens.push({ word: word[0], kind })
      if (kind === 'plain') {
        plainRun += 1
        if (plainRun >= 3) segment.englishByRun = true
      } else {
        plainRun = 0
      }
      pos += word[0].length
      continue
    }

    if (PROSE_GAP.test(body[pos])) {
      pos += 1
      continue
    }
    close()
    pos += 1
  }
  close()
  return { segments, hanChars }
}

/**
 * @param {unknown} text 一段 reasoning 全文
 * @returns 见文件头 v2 + v3 字段说明
 */
export function analyseCoverage(text) {
  const source = typeof text === 'string' ? text : ''
  const fenced = source.replace(FENCED_CODE, ' ')

  // v2 口径：不含行内代码剔除，与历史日志保持可比
  let chars = 0
  let cjk = 0
  for (const ch of fenced) {
    if (NUMBER.test(ch) || PUNCTUATION.test(ch) || SYMBOL.test(ch) || WHITESPACE.test(ch)) continue
    chars += 1
    if (HAN.test(ch)) cjk += 1
  }

  // v3 口径：先剔行内代码，再按片段分类
  const body = fenced.replace(INLINE_CODE, ' ')
  const { segments, hanChars } = splitSegments(body)

  let englishChars = 0
  let identifierChars = 0
  let englishSegments = 0

  for (const segment of segments) {
    const hasFunction = segment.tokens.some((token) => token.kind === 'function')
    const isEnglish = hasFunction || segment.englishByRun === true
    // 只数**字母**：`_` 在 v2 的 chars 里算标点被剔除，若这里按词长统计，
    // identifierChars 会超过 chars 的对应部分，三个占比就不再自洽（可能 >1）。
    const latin = segment.tokens.reduce(
      (sum, token) => sum + [...token.word].filter((ch) => LATIN.test(ch)).length,
      0,
    )
    if (isEnglish) {
      englishChars += latin
      englishSegments += 1
    } else {
      identifierChars += latin
    }
  }

  const judged = hanChars + englishChars

  return {
    // v2（不变）
    chars,
    cjk,
    coverage: chars === 0 ? null : round4(cjk / chars),
    // v3
    hanChars,
    englishChars,
    identifierChars,
    englishSegments,
    chineseRatio: judged === 0 ? null : round4(hanChars / judged),
    englishSentenceRatio: chars === 0 ? null : round4(englishChars / chars),
    identifierRatio: chars === 0 ? null : round4(identifierChars / chars),
  }
}

/**
 * 从 DSH 的 assistant/message 事件流里抽出 reasoning 文本与模型身份。
 * 纯函数，便于回归测试；事件形状见 SessionEventMap['assistant/message']。
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
