# dsh-chthink（DSH Chinese Thinking）

让 DSH 的**思考内容（思维链 / CoT）以简体中文产出**；最终回答的语言仍跟随用户提问语言。

- **零额外调用、零时延**：只向系统提示词追加一个分区，不做后端/前端翻译。
- **失效静默**：模型不遵循时不打断、不插提示行，只把覆盖率写进本地日志。
- **可回退**：`enabled: false` 或卸载后，行为与未安装一致。

## 工作机制

```
用户提问
  → DSH 装配系统提示词（末尾含 chthink 分区）+ 每步刷新的 runtime context 提醒
  → 模型以简体中文思考并流式展示
  →（离线）chthink_report 回放会话日志 → 覆盖率 → ~/.dsh/chthink/log.jsonl
```

### 通道 1：系统提示词分区（主通道）

| 字段 | 值 |
|------|-----|
| `name` | `chthink:thinking-language` |
| `order` | `10300`（内置最大值为 `DEPLOYMENT_PERSONA_SUFFIX = 10200`，因此固定在全文末尾） |
| `interpolate` | `false`（原文直出，不参与 `{{ }}` 插值） |

注入文本：

> [language-requirement] 硬性要求：你的 thinking / reasoning 内容必须从第一个字到最后一个字全部使用简体中文书写，禁止用英文思考或写英文句子。即使题目、代码、路径或工具名是英文，也只允许在引用时保留原文；代码、数学公式与专有名词保持原文。本要求优先于你自己此前轮次的思考风格：即使上文中的 thinking 是英文，那也只是旧要求生效前的历史，不得模仿；从本步起一律用中文思考。最终回复的语言仍跟随用户提问语言。

### 通道 2：每步刷新的 runtime context（对抗风格惯性）

| 字段 | 值 |
|------|-----|
| `name` | `chthink:thinking-language` |
| `order` | `220`（严格大于内置最大值 `WEB_SURFACE = 210`，确定排在快照末尾；contexts 只按 order 稳定排序，取更小值会与内置项同序、落点随加载顺序漂移） |
| `required` | 未设置（别的 preset 显式 `suppressRuntimeContext()` 时尊重其选择，此时只剩通道 1） |

DSH 会把 runtime context 渲染成一条 `Current runtime context…` 的**用户角色消息**，并且**每一步重新投影**（宿主每步都会更新其中的时间行，快照必然变化）。它贴在用户轮次一侧，比固定在系统提示词末尾的分区离当步生成更近。

提醒文本：

> [language-requirement] 本会话的思考语言要求仍然生效：thinking / reasoning 全程用简体中文书写，禁止英文思考句子；代码、数学公式与专有名词保留原文；此前轮次里若是英文思考属于历史，不要模仿；最终回复语言跟随用户提问。

### A/B 实测数据（同一条被污染会话，按字符加权）

| 阶段 | 加权覆盖率 | 段数 |
|---|---:|---:|
| 未注入 / 仅旧温和措辞 | 0.022 | 136 |
| 变体 A：长句 + 提醒在快照末尾 | **0.215** | 15 |
| 变体 B：短句 + 提醒置顶 | 0.166 | 17 |

结论：双通道把被污染会话的遵循度从 2% 抬到 ~20%；A 与 B 的差距小于任务内容噪声，最终采用 A 的措辞与位置。**对被污染的长会话，提示词通道收益到此见顶**——剩余失效属模型能力边界，此时按设计边界静默展示英文原文，靠 `chthink_report` 日志把该模型加入 `modelBlacklist`。

### 为什么要两个通道（两次实测踩坑）

1. **措辞太温和会完全无效**。最初的温和版本（“……必须使用简体中文进行思考并输出思考内容……”）对 `deepseek-flash`、`kimi-k3` 都不生效（reasoning 仍全英文）；换成上面的强措辞后两者都变中文。
2. **只有系统提示词分区，扛不住长会话的风格惯性**。模型会模仿自己前文的语言：一条会话里攒下几段英文 reasoning 后，后续轮次就跟着写英文，规则没变也一样。实测同一个 `qfmodel`——
   - 全新会话：注入后 100% 中文；
   - 已污染的长会话（注入后 24 段、4.8 万字符仍 0% 中文）：光靠通道 1 无效；
   - 加上通道 2 后：被污染会话的遵循度升到约 20%（见上表），新会话仍稳定中文。

两条通道都受 `modelBlacklist` 控制：命中时各自返回空文本，宿主的 `renderPrompt` 与 `renderContextSections` 会丢弃空条目，等于没有注入。

## 安装

要求：DSH（DeepSeek Harness）0.2.1-rc.2 或更高；插件只依赖 `systemPrompt` / `tools` 两个宿主服务与可选的 `sessionQuery`，不 import 任何宿主包。

从本仓库安装（推荐，会热生效）：clone 本仓库后，在 DSH 会话里让 agent 用 `plugin_manager` 的 `install_bundle` 把 target 指向 clone 出来的目录；或在插件面板里添加本地 bundle 路径。安装会把该目录链接进当前 profile 并写入 `cordis.yml` 条目。

手动安装（不经过插件管理器）：

1. 把本目录 junction 到 `~/.dsh/profiles/<profile>/node_modules/@local/dsh-chthink`；
2. 在 profile 的 `cordis.yml` 追加：

   ```yaml
   - id: chthink
     name: '@local/dsh-chthink'
     config: {}
   ```

3. 重启 DSH（手动路径不会被 HMR 自动加载）。

本包的 `cordis.patch.yml` 已声明 `insert: chthink`，走 `install_bundle` 时不需要手改 profile。

## 配置

写在 `cordis.patch.yml` 的 `config` 块或 profile `cordis.yml` 对应条目下。

| 配置键 | 类型 | 默认值 | 说明 |
|--------|------|--------|------|
| `enabled` | boolean | `true` | 总开关；`false` 时不注册分区与工具，等同卸载 |
| `modelBlacklist` | string[] | `[]` | 不注入的模型；接受裸模型名（`deepseek-reasoner`）或 `provider/model` 两种写法 |
| `reportSessions` | number | `20` | `chthink_report` 默认扫描的最近会话数（夹在 1–200） |
| `coverageThreshold` | number | `0.6` | 日志中 `failed` 标记的阈值（夹在 0–1） |
| `logFile` | string | `~/.dsh/chthink/log.jsonl` | 可选：日志落点，仅测试/多 profile 场景需要 |

改配置后重新加载插件即可；分区注册使用 `section()` 返回的 disposer 由 cordis 生命周期托管，同名重复注册会抛错而不是静默双写。

## 中文覆盖率报告

工具 `chthink_report`（只读）：

- 参数 `sessions`：扫描最近多少个会话（默认取配置）；
- 参数 `writeLog`：是否追加日志（默认 `true`）。

返回每个会话的 `hanChars / englishChars / identifierChars / chineseRatio / coverage / failed / provider / model`、总体三项占比、未达标会话数，以及 JSONL 写入结果。会话日志通过宿主的 `sessionQuery` 服务只读回放，不改写任何会话文件。

### 覆盖率口径（v3）

v2 的单一比值有一个**测量缺陷**：它把 `ops_bash`、`Python`、`get_tree()` 这类标识符和真正的英文推理句子算成同一种东西（都是「非汉字」）。编码会话里标识符密度很高，模型明明遵循了要求，比值却被压到 0.4–0.5，误判成失效。

v3 按「词」把非汉字部分拆开，输出三个互斥量：

```
hanChars           汉字字符
englishChars       英文句子片段里的拉丁字符   ← 真正的违规量
identifierChars    标识符与专名字符           ← 豁免，不计违规

chineseRatio          = hanChars / (hanChars + englishChars)   ← 判定用这个
englishSentenceRatio  = englishChars / chars
identifierRatio       = identifierChars / chars
coverage              = cjk / chars（v2 原样保留，便于与旧日志对比）
```

`failed` 由 `chineseRatio < coverageThreshold` 判定。片段判定规则：

1. 以汉字与代码符号为界切成「拉丁片段」——`_` `.` `/` `(` `=` 等都会断开片段，所以 `primepi(20000)` 与 `len(primerange(1, 20001))` 不会被粘成一句；
2. 片段内含英文虚词或高频动词（the / of / is / let / we / I …）→ 英文句子；
3. 否则片段有 ≥3 个连续普通英文词 → 英文句子；
4. 否则 → 标识符（豁免）。

词级预分类优先于词义：含 `_ - . / : @ \` 或数字、驼峰、全大写形态（`ALWAYS`、`JSON`）一律先算标识符——否则 `ALWAYS` 会命中副词 always 而被误判成英文。围栏代码块与行内代码在 v3 里整段剔除。

**阈值标定**（本机 76 个会话、25 条模型路由、约 1.1 万段 reasoning）：v3 的 `chineseRatio` 呈明显双峰——遵循良好的一组 0.82–0.99，失效的一组 0.004–0.56，中间是空档。默认阈值 `0.6` 正落在空档里，无需调整。

v2 的失真幅度（同一批真实数据）：

| 路由 | v2 coverage | v3 chineseRatio | 结论 |
|---|---:|---:|---|
| `codearts/deepseek-v4.1-flash` | 0.607 | **0.955** | v2 判 failed，实际遵循良好（标识符占 24%） |
| `workbuddy/cn:deepseek-v4.1-flash` | 0.566 | **0.955** | 同上（标识符占 34%） |
| `trae/deepseek-v4.1-flash` | 0.506 | **0.951** | 同上 |
| `loomy/spark-x2.6` | 0.201 | 0.237 | 两口径都判失效，结论不变 |
| `acme-gateway/kimi-k3` | 0.032 | 0.037 | 同上 |

即 v2 只冤枉了「中文为主 + 标识符密集」的模型，没有漏判真正失效的。

其他实现细节：

- 围栏代码块（``` / ~~~）整段剔除；未闭合的围栏一直剔到文末；
- 数字按 `\p{N}` 全量排除（含 `²`、`½`），符号按 `\p{S}` 排除（`= × +`、箭头、emoji）；
- 口径版本写进日志行的 `metricVersion` 字段。v1/v2 旧行不能与 v3 的 `chineseRatio` 直接比较；
- 子会话/分支会重放父会话历史，统计时按 `inheritedEventCount` 只算本会话自己的事件；
- 没有 thinking 内容的会话比值为 `null`，不计入 failed。

### 日志格式

`~/.dsh/chthink/log.jsonl`，每次报告为每个「有 thinking」的会话追加一行：

```json
{"ts":"2026-11-15T03:55:00.000Z","metricVersion":3,"sessionId":"…","provider":"acme-gateway","model":"deepseek-flash","chars":1820,"cjk":1200,"coverage":0.6593,"hanChars":1200,"englishChars":60,"identifierChars":520,"englishSegments":2,"chineseRatio":0.9524,"englishSentenceRatio":0.033,"identifierRatio":0.2857,"failed":false,"segments":12}
```

`metricVersion` 标记口径代际（缺省为 v1，`2` 为 v2，`3` 为当前 v3）。旧行保留不删，但 v1/v2 的 `coverage` 不能与 v3 的 `chineseRatio` 直接比较——两者判定标准不同。

用途只有一个：跑几天后人工回看，把持续 `failed: true` 的模型加入 `modelBlacklist`，并据此微调注入措辞。无上报、无面板。

## 模型黑名单（自动）

- `agent/request` 在每一步解析出真正的 `provider/model`，插件记下该 agent 的路由；
- `section.text` 命中黑名单时返回空字符串——`renderPrompt` 会丢弃空 section，系统提示词里不留痕迹；
- `system-prompt/assemble` 再兜一层：装配结果里的 `variables.provider/model` 已命中时直接移除本插件的分区；
- 静态场景直接用 `Agent.options.provider/model`。

已知边界：装配发生在请求解析之前，所以**刚切换到被拉黑模型的第一步**可能仍注入一次，第二步起稳定跳过。这是事件顺序决定的，不影响正常使用。

## 与官方 CoT 翻译实验包的关系

官方 `@deepseek-ai/dsh-experimental-cot-translation-bundle` 是**展示层机器翻译**（英文思维链产出后再翻译）；本插件是**让模型直接用中文思考**。两者正交、可并存；本插件生效时官方翻译几乎没有内容可译。个人场景优先本插件：零成本、零时延，上下文里的思维链也是中文。

## 自测

```bash
node test/smoke-test.mjs
```

覆盖：分区注册、模型黑名单（静态 / 请求解析 / 装配兜底）、覆盖率算法（中文、英文、代码块、空文本）、`chthink_report` 的读取与失败隔离、JSONL 追加、返回值无损 JSON 序列化。

验收（安装后）：

| 测试项 | 方法 | 通过标准 |
|--------|------|----------|
| 注入生效 | 装插件后开新会话，问一个需要推理的问题 | 思维链为中文（覆盖率 ≥ 0.6） |
| 分区注册 | 会话日志确认提示词末尾含 `[language-requirement]` 段 | 存在且仅一份 |
| 卸载回退 | `enabled: false` 或移除插件后重启 | 行为与未安装一致 |
| 报告工具 | 让 agent 调 `chthink_report` | 返回合法 JSON，`log.jsonl` 追加成功 |
| 序列化回归 | 工具返回值含缺失字段场景 | 不出现 `invalid output` 报错 |

## 目录

```
dsh-chthink/
├── index.js            # 分区 + 运行时上下文 + 黑名单 + chthink_report
├── lib/coverage.js     # 覆盖率算法、thinking 抽取（纯函数）
├── lib/policy.js       # 配置归一化、黑名单匹配（纯函数）
├── cordis.patch.yml    # bundle 插入声明
├── locale/{en,zh}.json # 插件管理器展示元数据
├── icon.svg
├── test/smoke-test.mjs # 离线冒烟测试
└── LICENSE             # MIT
```
