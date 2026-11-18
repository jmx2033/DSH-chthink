/**
 * 语料回归：覆盖 v3 片段分类的各类边界，断言「预期分类」而非精确比值。
 *
 * 为什么断言分类而不是数值：数值精确回归 = 把当前算法的输出当标准，虚词表
 * 漏判会被一起固化。这里只锁「这段算不算中文遵循」的判定方向，能真正抓到
 * 虚词表改动导致的漏判（例如某段明明有完整英文句却被判成遵循）。
 *
 * 三类：
 *   chinese —— 中文思考（标识符/代码/数学可多），chineseRatio 应 ≥ 0.8
 *   english —— 含成句英文，chineseRatio 应 ≤ 0.5
 *   record  —— 边界样本，只记录不断言（用于观察算法演进）
 *
 * 真实数据的复现入口是 tools/model-census.mjs 与 tools/freshness-vs-compliance.mjs，
 * 不在这里断言（换机器数值不同）。
 */
import assert from 'node:assert/strict'
import { analyseCoverage } from '../lib/coverage.js'

let checks = 0
function ok(label) {
  checks += 1
  console.log(`  ✓ ${label}`)
}

const CHINESE_FLOOR = 0.8
const ENGLISH_CEIL = 0.5

const corpus = [
  // ── chinese：模型遵循，即便标识符/代码密集 ──
  {
    cls: 'chinese',
    name: '中文 + 工具名标识符',
    text: '任务：统计 1 到 20000 之间素数的个数，要用实际计算。用 Python 或者简单脚本跑一下。用 ops_bash 跑一段 Python 或 awk。我用 Python 做埃拉托斯特尼筛法，再用试除法交叉验证。',
  },
  {
    cls: 'chinese',
    name: '中文 + 函数调用括号紧贴',
    text: '再用 sympy 的 primepi(20000) 与 len(primerange(1, 20001)) 作第三方交叉核对，同样得 2262，三者一致。',
  },
  {
    cls: 'chinese',
    name: '中文 + 全大写标识符 ALWAYS',
    text: '注意：game.gd 设了 process_mode = Node.PROCESS_MODE_ALWAYS，pause_menu 根节点是 process_mode=2（ALWAYS），它作为子节点继承父节点。',
  },
  {
    cls: 'chinese',
    name: '中文 + 点号/下划线方法链',
    text: '调用 get_tree().paused 后 _process 停止，process_mode 为 ALWAYS，_unhandled_input 仍能收到事件。',
  },
  {
    cls: 'chinese',
    name: '中文 + 围栏代码块',
    text: '先看配置：\n```js\nconst value = foo(1, 2)\nfunction bar(a) { return a + 1 }\n```\n然后注册分区，确认 order 排在末尾。',
  },
  {
    cls: 'chinese',
    name: '中文 + 行内代码',
    text: '调用 `get_tree().paused = true` 之后节点停止处理，我们验证一下信号是否还会发出。',
  },
  {
    cls: 'chinese',
    name: '纯中文数学推理',
    text: '17×23 = 391，19×21 = 399。399 - 391 = 8。所以 19×21 更大，大 8。用平方差验证：(20-3)(20+3) = 400-9 = 391。',
  },

  // ── english：含成句英文，应被抓出 ──
  {
    cls: 'english',
    name: '纯英文推理',
    text: 'We should read the config file first, then register the section before assembling the prompt.',
  },
  {
    cls: 'english',
    name: '中文夹完整英文句',
    text: '先看配置。Wait, I need to double-check one thing before we proceed, does it get injected into every single step of the turn? 然后继续。',
  },
  {
    cls: 'english',
    name: '英文缩写 let’s / don’t',
    text: '先这样。Let’s check the value, don’t you think it works better this way? 继续处理。',
  },
  {
    cls: 'english',
    name: '句中虚词（非句首）',
    text: '这里有个坑 because the order is stable only by name 需要注意一下。',
  },
  {
    cls: 'english',
    name: 'markdown 英文列表项',
    text: '- first read the config file\n- then register the section with the correct order\n先读配置再注册分区。',
  },
  {
    cls: 'english',
    name: '连续普通英文词三连兜底',
    text: '这里需要 check the value again 然后继续处理下一步。',
  },

  // ── record：边界，只观察不断言 ──
  { cls: 'record', name: '单个 I', text: 'I think 这个需要先确认再往下走。' },
  { cls: 'record', name: '大量英文专名', text: 'DeepSeek 和 Kimi 与 Qwen 三个模型在 coding 任务上各有优劣。' },
]

console.log('语料回归')
for (const item of corpus) {
  const r = analyseCoverage(item.text)
  if (item.cls === 'chinese') {
    assert.ok(
      r.chineseRatio === null || r.chineseRatio >= CHINESE_FLOOR,
      `${item.name}：应判遵循，实际 chineseRatio=${r.chineseRatio}（eng=${r.englishChars}）`,
    )
    ok(`${item.name} → 遵循（${r.chineseRatio}）`)
  } else if (item.cls === 'english') {
    assert.ok(
      r.chineseRatio !== null && r.chineseRatio <= ENGLISH_CEIL,
      `${item.name}：应判含英文，实际 chineseRatio=${r.chineseRatio}（eng=${r.englishChars}）`,
    )
    ok(`${item.name} → 含英文（${r.chineseRatio}）`)
  } else {
    console.log(`  · ${item.name}（记录）chineseRatio=${r.chineseRatio} eng=${r.englishChars} id=${r.identifierChars}`)
  }
}

console.log(`\n语料回归通过（${checks} 项断言）。`)
