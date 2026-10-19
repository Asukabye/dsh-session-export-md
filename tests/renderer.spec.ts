import { describe, expect, it } from 'vitest'
import {
  ANSWER_CALLOUT_PREFIX,
  ARTIFACT_CALLOUT_PREFIX,
  blockquote,
  contentToMd,
  dedupeRestatements,
  escapeHeadingMarkers,
  escapeInlineTitle,
  formatTime,
  nestHeadings,
  QUESTION_CALLOUT_PREFIX,
  renderArtifacts,
  renderChangeLog,
  renderFrontMatter,
  renderNotes,
  renderRound,
  renderTags,
  renderToc,
  roundHeadingText,
  roundLink,
  singleLine,
  slugify,
  splitLeadingSummary,
  stripHorizontalRules,
  tagify,
  escapeWikiTarget,
} from '../src/core/renderer.js'
import type { ChangeRecord, ExportSegment, Strategy, Turn } from '../src/core/types.js'

/** 双维度策略夹具（format=10：每轮同时归入两个维度）。 */
const strategy: Strategy = {
  id: 'dev-phase',
  name: '常规开发规模',
  source: 'builtin',
  dimensions: [
    {
      id: 'phase',
      name: '开发阶段',
      modules: [{ name: '需求分析' }, { name: '编码实现' }, { name: '其他' }],
      defaultModule: '其他',
    },
    {
      id: 'purpose',
      name: '对话功能/目的',
      modules: [{ name: '问答型' }, { name: '生成型' }, { name: '其他' }],
      defaultModule: '其他',
    },
  ],
}

function mkTurn(no: number, userText?: string, assistantText?: string): Turn {
  return {
    turnNo: no,
    startSeq: no * 10 + 1,
    endSeq: no * 10 + 4,
    startTime: 0,
    endTime: 0,
    completed: true,
    user: [
      {
        seq: no * 10 + 2,
        time: 0,
        content: [{ type: 'text', text: userText ?? `问题原文${no}` }],
      },
    ],
    assistant: [
      {
        seq: no * 10 + 3,
        time: 0,
        content: [{ type: 'text', text: assistantText ?? `回答${no}` }],
        model: 'm',
      },
    ],
    tools: [],
    toolCalls: [],
    deliverables: [],
  }
}

function seg(
  no: number,
  labels: Record<string, string>,
  options: {
    changes?: ChangeRecord[]
    summary?: string
    artifacts?: ExportSegment['artifacts']
    turn?: Turn
    title?: string
  } = {},
): ExportSegment {
  return {
    no,
    title: options.title ?? `段标题${no}`,
    labels,
    summary: options.summary ?? '',
    artifacts: options.artifacts ?? [],
    changes: options.changes ?? [],
    turn: options.turn ?? mkTurn(no),
  }
}

const fullLabels = { phase: '需求分析', purpose: '问答型' }

describe('slugify / blockquote / 基础工具', () => {
  it('生成 CJK 锚点 slug', () => {
    expect(slugify('3. 导出功能调研')).toBe('3-导出功能调研')
    expect(slugify('  A_B-c ')).toBe('a_b-c')
  })

  it('逐行加引用前缀且代码围栏完整', () => {
    expect(blockquote('a\n```\nb\n```')).toBe('> a\n> ```\n> b\n> ```')
    expect(blockquote('a\n\nb')).toBe('> a\n>\n> b')
  })

  it('singleLine 折叠空白；formatTime 走 UTC 确定性格式', () => {
    expect(singleLine('第一行\n第二行')).toBe('第一行 第二行')
    expect(formatTime(1700000000000)).toBe('2023-11-14 22:13:20 UTC')
  })

  it('contentToMd 只取文本块，图片留占位，思考/工具载荷丢弃', () => {
    expect(
      contentToMd([
        { type: 'reasoning', text: '不该出现' },
        { type: 'text', text: '正文' },
        { type: 'tool-call', name: 'write', arguments: '{"file_path":"x"}' },
        { type: 'image' },
      ]),
    ).toBe('正文\n\n（图片附件）')
  })

  it('roundHeadingText / roundLink 同源构造正文标题与目录链接；escapeWikiTarget 只转义链接语法字符', () => {
    expect(roundHeadingText(3, '编码：补测试')).toBe('第 3 轮：编码：补测试')
    expect(roundHeadingText(3, '   ')).toBe('第 3 轮')
    expect(roundLink(3, '编码：补测试')).toBe('[[#第 3 轮：编码：补测试]]')
    expect(roundLink(3, '')).toBe('[[#第 3 轮]]')
    // `[` `]` 在 wiki 链接里是普通字符，不转义；`\` `|` `#` `^` 是 Obsidian 链接语法字符，必须转义
    expect(escapeWikiTarget('规则[1]：变更标记')).toBe('规则[1]：变更标记')
    expect(escapeWikiTarget('别名|显示#锚^引用')).toBe('别名\\|显示\\#锚\\^引用')
    expect(escapeWikiTarget('第一行\n第二行')).toBe('第一行 第二行')
    // 用户 / 回答的 callout 头都不折叠（折叠会让轮次结构看起来断裂）
    expect(QUESTION_CALLOUT_PREFIX).toBe('> [!question] ')
    expect(ANSWER_CALLOUT_PREFIX).toBe('> [!quote] ')
  })

  it('escapeInlineTitle：单行化 + 转义方括号（正文标题与目录链接文本共用）', () => {
    expect(escapeInlineTitle('规则[1]：变更')).toBe('规则\\[1\\]：变更')
    expect(escapeInlineTitle('第一行\n第二行')).toBe('第一行 第二行')
    expect(escapeInlineTitle('[a] ]b[')).toBe('\\[a\\] \\]b\\[')
    expect(escapeInlineTitle('普通标题')).toBe('普通标题')
  })
})

describe('标题级别防护：引用转义 + 回答内标题降级', () => {
  it('引用的问题原文里行首 # 被转义（不产生真标题）', () => {
    const s = seg(1, fullLabels)
    s.turn.user = [
      {
        seq: 12,
        time: 0,
        content: [{ type: 'text', text: '参考模板：\n# 会话\n## 模块一\n### 标题A' }],
      },
    ]
    const out = renderRound(s, strategy)
    expect(out).toContain('> \\# 会话')
    expect(out).toContain('> \\## 模块一')
    expect(out).not.toContain('> # 会话')
  })

  it('代码围栏内的 # 注释不被转义/降级', () => {
    const s = seg(1, fullLabels)
    s.turn.user = [{ seq: 12, time: 0, content: [{ type: 'text', text: '```sh\n# comment\n```' }] }]
    s.turn.assistant = [
      {
        seq: 13,
        time: 0,
        content: [{ type: 'text', text: '说明：\n```py\n# not a heading\n```' }],
      },
    ]
    const out = renderRound(s, strategy)
    expect(out).toContain('> # comment')
    expect(out).toContain('# not a heading')
  })

  it('回答自带的标题按固定映射整体降到 #### 及以下（不污染大纲）', () => {
    const s = seg(1, fullLabels)
    s.turn.assistant = [
      {
        seq: 13,
        time: 0,
        content: [{ type: 'text', text: '## 一、调研结论\n正文\n### 关键要点\n更细的内容' }],
      },
    ]
    const out = renderRound(s, strategy)
    // 固定映射（跨轮一致）：`#`→`####`、`##`→`#####`、`###` 及更深→`######`
    expect(out).toContain('> ##### 一、调研结论')
    expect(out).toContain('> ###### 关键要点')
    // 结构标题保持原级别；回答改用 callout
    expect(out).toContain('### 第 1 轮')
    expect(out).toContain('> [!quote] 回答')
  })

  it('escapeHeadingMarkers / nestHeadings 基础行为', () => {
    expect(escapeHeadingMarkers('# 标题\n正文')).toBe('\\# 标题\n正文')
    expect(nestHeadings('# 一\n## 二\n###### 六', 4)).toBe('#### 一\n##### 二\n###### 六')
  })

  it('nestHeadings 固定映射（跨轮一致）：`#`→`####`、`##`→`#####`、`###` 及更深→`######`', () => {
    // 不再按每轮最浅标题归一：同一级别在不同轮落到同一级别
    expect(nestHeadings('## 一\n### 二\n#### 三', 4)).toBe('##### 一\n###### 二\n###### 三')
    // `###` 及更深一律压到 `######`（不再整篇上提）
    expect(nestHeadings('### 一\n### 二\n### 三', 4)).toBe('###### 一\n###### 二\n###### 三')
    expect(nestHeadings('##### 一\n###### 二', 4)).toBe('###### 一\n###### 二')
    // 无标题时原文不动
    expect(nestHeadings('纯文本\n\n- 列表项', 4)).toBe('纯文本\n\n- 列表项')
    // 代码围栏内的 `#` 不被改写
    expect(nestHeadings('### 一\n```sh\n# 注释\n```\n#### 二', 4)).toBe(
      '###### 一\n```sh\n# 注释\n```\n###### 二',
    )
  })

  it('引用块内的标题同样被转义 / 降级（粘贴的模板不再污染大纲）', () => {
    expect(escapeHeadingMarkers('> ## 模块一\n> > # 会话')).toBe('> \\## 模块一\n> > \\# 会话')
    expect(nestHeadings('> # 一\n> 正文', 4)).toBe('> #### 一\n> 正文')
  })
})

describe('renderRound', () => {
  it('渲染既定结构：标题行打头（零标记） + 标签行 + 用户 callout + 回答 callout', () => {
    const out = renderRound(seg(1, fullLabels), strategy)
    expect(out.split('\n')[0]).toBe('### 第 1 轮：段标题1')
    // 标题 → 空行 → Obsidian 原生标签行（行首无前缀）→ 空行 → 问题 callout
    expect(out).toContain(
      '### 第 1 轮：段标题1\n\n' +
        '#开发阶段/需求分析 #对话功能-目的/问答型\n\n' +
        '> [!question] 用户\n> 问题原文1',
    )
    expect(out).toContain('> [!quote] 回答\n> 回答1')
    // format 10 正文零标记：既无 HTML 注释，也无 turn-N 锚点
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('<a id=')
    expect(out).not.toContain('#turn-1')
    // 旧的 `**分类**：…` / `**用户**：` / `**回答**：` / `**AI**：` 标签行整体消失
    expect(out).not.toContain('**分类**')
    expect(out).not.toContain('**用户**')
    expect(out).not.toContain('**回答**')
    expect(out).not.toContain('**AI**')
  })

  it('缺少某维标签时回落到该维兜底模块', () => {
    const out = renderRound(seg(1, { phase: '编码实现' }), strategy)
    expect(out).toContain('#开发阶段/编码实现 #对话功能-目的/其他')
  })

  it('概要缺失时整行省略（不写空标签，也不用标题或占位文字冒充）', () => {
    const out = renderRound(seg(3, fullLabels), strategy)
    expect(out.split('\n').some(line => line.startsWith('**概要**'))).toBe(false)
    expect(out).not.toContain('**概要**：')
    expect(out).not.toContain('（本段回答未给出概述）')
    // 标题归标题行，不拿来当概要
    expect(out).toContain('### 第 3 轮：段标题3')
  })

  it('段概要为空时退回回答里的概述段（不白丢），段上有值优先', () => {
    const fallback = seg(1, fullLabels, {
      summary: '',
      turn: mkTurn(1, '问题', '概述：兜底提取。\n\n正文。'),
    })
    expect(renderRound(fallback, strategy)).toContain('**概要**：兜底提取。')

    const explicit = seg(1, fullLabels, {
      summary: '段上给的概要。',
      turn: mkTurn(1, '问题', '概述：回答里的概述。\n\n正文。'),
    })
    const out = renderRound(explicit, strategy)
    expect(out).toContain('**概要**：段上给的概要。')
    // 概述段本身从回答正文里剥离
    expect(out).not.toContain('概述：回答里的概述。')
    expect(out).toContain('正文。')
  })

  it('思考（reasoning）与工具调用/结果块不导出：文档里不出现 JSON 载荷', () => {
    const s = seg(1, fullLabels, {
      summary: '一句话概要。',
      turn: mkTurn(1, '问题', ''),
    })
    s.turn.assistant = [
      {
        seq: 12,
        time: 0,
        content: [
          { type: 'reasoning', text: '我先想想这个需求。' },
          { type: 'tool-call', id: 'call_1', name: 'memory_remember', arguments: '{"content":"x"}' },
          { type: 'tool-result', id: 'call_1', result: '{"ok":true}' },
        ],
      },
      {
        seq: 13,
        time: 0,
        content: [
          { type: 'reasoning', text: '再想想。' },
          { type: 'text', text: '概述：一句话概要。\n\n正文段落。' },
        ],
      },
    ]
    const out = renderRound(s, strategy)
    expect(out).not.toContain('```json')
    expect(out).not.toContain('reasoning')
    expect(out).not.toContain('tool-call')
    expect(out).not.toContain('call_1')
    expect(out).not.toContain('我先想想这个需求。')
    expect(out).toContain('一句话概要。')
    expect(out).toContain('正文段落。')
  })

  it('长回答也不折叠：回答 callout 头不带折叠标记（不再有 <details>）', () => {
    const long = '很长的一段回答。'.repeat(160)
    const s = seg(1, fullLabels, { turn: mkTurn(1, '问题', `${long}\n## 结尾标题`) })
    const out = renderRound(s, strategy)
    expect(ANSWER_CALLOUT_PREFIX).toBe('> [!quote] ')
    expect(out).toContain(`${ANSWER_CALLOUT_PREFIX}回答`)
    expect(out).not.toContain('> [!quote]-')
    // 文档里不再有 <details>/<summary>
    expect(out).not.toContain('<details>')
    expect(out).not.toContain('<summary>')
    // callout 每一行都带引用前缀（空行写成单 `>`），且回答标题按固定映射降到 `#####`
    const lines = out.split('\n')
    const body = lines.slice(lines.indexOf(`${ANSWER_CALLOUT_PREFIX}回答`) + 1)
    expect(body.length).toBeGreaterThan(0)
    expect(body.every(line => line === '>' || line.startsWith('> '))).toBe(true)
    expect(out).toContain('> ##### 结尾标题')
  })

  it('多行回答的 callout 内空行写成单 `>`，不打断引用块', () => {
    const long = `${'很长的一段回答。'.repeat(160)}\n\n第二段仍然在 callout 里。`
    const out = renderRound(seg(1, fullLabels, { turn: mkTurn(1, '问题', long) }), strategy)
    expect(out).toContain(`${ANSWER_CALLOUT_PREFIX}回答`)
    // 段落之间的空行在 callout 里是单 `>`（裸空行会终止引用块）
    expect(out).toContain('>\n> 第二段仍然在 callout 里。')
    const lines = out.split('\n')
    const start = lines.indexOf(`${ANSWER_CALLOUT_PREFIX}回答`) + 1
    expect(lines.slice(start)).not.toContain('')
  })

  it('多行问题按引用块逐字保留', () => {
    const s = seg(1, fullLabels, { turn: mkTurn(1, '第一行\n第二行') })
    const out = renderRound(s, strategy)
    expect(out).toContain('> [!question] 用户\n> 第一行\n> 第二行')
  })

  it('产物块只给附件链接（按固定类别顺序统计）；无产物时省略', () => {
    const withArtifacts = seg(1, fullLabels, {
      artifacts: [
        { kind: '文档', value: 'README.md' },
        { kind: '代码', value: 'src/a.ts' },
        { kind: '链接', value: 'https://example.com' },
      ],
    })
    const out = renderRound(withArtifacts, strategy)
    expect(ARTIFACT_CALLOUT_PREFIX).toBe('> [!example]- ')
    expect(out).toContain(`${ARTIFACT_CALLOUT_PREFIX}产物（1 个文件 · 代码 1 / 文档 1 / 链接 1）`)
    // 正文只留一行 wiki 链接，链接名与附件文件名同源（planAttachments）
    expect(out).toContain('> - 全部产物：[[第1轮-产物|第1轮-产物.md]]（代码 1 / 文档 1 / 链接 1）')
    // 产物正文（路径/链接）不再内联进轮次
    expect(out).not.toContain('src/a.ts')
    expect(out).not.toContain('`README.md`')
    expect(out).not.toContain('https://example.com')
    // 不再有 `#### 产物` 小节标题
    expect(out).not.toContain('#### 产物')

    const plain = renderRound(seg(1, fullLabels), strategy)
    expect(plain).not.toContain('#### 产物')
    expect(plain).not.toContain('产物（')
    expect(plain).not.toContain(ARTIFACT_CALLOUT_PREFIX)
  })

  it('附件写失败（inlineArtifacts）时产物退回内联分组', () => {
    const s = seg(1, fullLabels, {
      artifacts: [
        { kind: '文档', value: 'README.md' },
        { kind: '代码', value: 'src/a.ts' },
        { kind: '链接', value: 'https://example.com' },
      ],
    })
    const out = renderRound(s, strategy, { inlineArtifacts: true })
    expect(out).toContain(`${ARTIFACT_CALLOUT_PREFIX}产物（3 项）`)
    expect(out).toContain('> **代码**（1）\n> - `src/a.ts`')
    expect(out).toContain('> **文档**（1）\n> - `README.md`')
    expect(out).toContain('> **链接**（1）\n> - https://example.com')
    // 降级路径不写附件链接
    expect(out).not.toContain('[[第1轮-产物')
  })

  it('编辑标记：轮次标题下标记 + 追加编辑后的问题', () => {
    const change: ChangeRecord = {
      kind: 'edit',
      seq: 99,
      time: 1700000000000,
      targetStart: 2,
      targetEnd: 2,
      turnNo: 1,
      newContent: [{ type: 'text', text: '编辑后的新问题' }],
    }
    const out = renderRound(seg(1, fullLabels, { changes: [change] }), strategy)
    expect(out).toContain('⚠️ **变更标记**')
    expect(out).toContain('「问题」原文（seq 2–2）已被编辑')
    expect(out).toContain('> ✏️ **编辑后的问题**（')
    expect(out).toContain('> 编辑后的新问题')
    // 标记紧贴轮次标题（下一行）、在标签行之前
    expect(out.indexOf('### 第 1 轮')).toBeLessThan(out.indexOf('⚠️ **变更标记**'))
    expect(out.indexOf('⚠️ **变更标记**')).toBeLessThan(out.indexOf('#开发阶段/需求分析'))
  })

  it('撤回标记：标题下提示保留历史，不追加新问题', () => {
    const change: ChangeRecord = {
      kind: 'withdraw',
      seq: 99,
      time: 1700000000000,
      targetStart: 2,
      targetEnd: 2,
      turnNo: 1,
    }
    const out = renderRound(seg(1, fullLabels, { changes: [change] }), strategy)
    expect(out).toContain('已被撤回，历史导出内容保留如下')
    expect(out).not.toContain('编辑后的问题')
  })
})

describe('renderRound：轮次标题行（模型标题 → 正文标题）', () => {
  it('标题为空时退化为 `### 第 N 轮`（不留下多余冒号）', () => {
    const out = renderRound(seg(4, fullLabels, { title: '' }), strategy)
    const heading = out.split('\n').find(l => l.startsWith('### 第 4 轮'))
    expect(heading).toBe('### 第 4 轮')
    expect(out).not.toContain('### 第 4 轮：')
  })

  it('只有空白字符的标题同样退化', () => {
    const out = renderRound(seg(5, fullLabels, { title: '   ' }), strategy)
    expect(out.split('\n')).toContain('### 第 5 轮')
  })

  it('标题单行化，且 `[` `]` 被转义（正文标题不破坏 Markdown 结构）', () => {
    const out = renderRound(seg(1, fullLabels, { title: '规则[1]：变更\n标记改为两处' }), strategy)
    expect(out.split('\n')).toContain('### 第 1 轮：规则\\[1\\]：变更 标记改为两处')
  })
})

describe('splitLeadingSummary', () => {
  it('没有概述标记时概要为空、正文原样', () => {
    const r = splitLeadingSummary(['先说过程。', '结论如下。'])
    expect(r.summary).toBe('')
    expect(r.rest).toEqual(['先说过程。', '结论如下。'])
  })

  it('概述不在首条文本里也能抽出，其余文本顺序不变', () => {
    const r = splitLeadingSummary(['我先查一下现有实现。', '概述：查完了。\n\n结论如下。'])
    expect(r.summary).toBe('查完了。')
    expect(r.rest).toEqual(['我先查一下现有实现。', '结论如下。'])
  })

  it('支持「概述/概括/摘要」多种前缀（含 **概述：** 加粗形式）', () => {
    expect(splitLeadingSummary(['概括: 简要说明']).summary).toBe('简要说明')
    expect(splitLeadingSummary(['摘要：一段摘要']).summary).toBe('一段摘要')
    expect(splitLeadingSummary(['**概述：** 加粗前缀。\n\n正文。']).summary).toBe('加粗前缀。')
  })

  it('概要按语义边界截断到上限（200 字）', () => {
    // 连续无标点 → 硬截断到上限 + 省略号
    const hard = splitLeadingSummary([`概述：${'长'.repeat(300)}`]).summary
    expect(Array.from(hard).length).toBe(201)
    expect(hard.endsWith('…')).toBe(true)
    // 有句末标点 → 在句末收尾，不把句子切断
    const sentences = splitLeadingSummary([`概述：${'句子。'.repeat(80)}`]).summary
    expect(sentences.endsWith('。')).toBe(true)
    expect(Array.from(sentences).length).toBeLessThanOrEqual(200)
  })

  it('概述段结尾没说完时并入下一段；已说完则下一段留在正文', () => {
    const merged = splitLeadingSummary(['概述：前半句还没说完\n\n后半句结束在这里。'])
    expect(merged.summary).toBe('前半句还没说完 后半句结束在这里。')
    expect(merged.rest).toEqual([])
    const kept = splitLeadingSummary(['概述：说完的概要。\n\n这是正文第一段。\n\n正文第二段。'])
    expect(kept.summary).toBe('说完的概要。')
    expect(kept.rest.join('\n')).toContain('这是正文第一段。')
    expect(kept.rest.join('\n')).toContain('正文第二段。')
  })
})

describe('renderToc（format=10：维度 ### + 模块加粗计数 + wiki 链接）', () => {
  it('维度是结构标题，有轮次的模块写加粗计数，空模块只留一行加粗（不写 0 轮/（无））', () => {
    const toc = renderToc(strategy, [
      { dimensionId: 'phase', moduleName: '编码实现', turns: [{ no: 2, title: '编码：补测试' }] },
      { dimensionId: 'phase', moduleName: '需求分析', turns: [{ no: 1, title: '需求提出：对话按语义分段导出' }] },
      {
        dimensionId: 'purpose',
        moduleName: '问答型',
        turns: [{ no: 2, title: '编码：补测试' }, { no: 1, title: '需求提出：对话按语义分段导出' }],
      },
    ])
    expect(toc.startsWith('## 目录')).toBe(true)
    // 维度是 `###` 结构标题（进大纲），不再有加粗行
    expect(toc).toContain('### 开发阶段')
    expect(toc).toContain('### 对话功能/目的')
    expect(toc).not.toContain('**开发阶段**')
    expect(toc).not.toContain('**对话功能/目的**')

    // 模块按策略顺序全量列出（策略内的顺序，与 entries 传入顺序无关）
    expect(toc.indexOf('**1. 需求分析**')).toBeLessThan(toc.indexOf('**2. 编码实现**'))
    // 有轮次：`**序号. 模块名**（N 轮）` + 轮次 wiki 链接（链接文本与正文标题同源）
    expect(toc).toContain(
      '**1. 需求分析**（1 轮）\n- [[#第 1 轮：需求提出：对话按语义分段导出]]',
    )
    expect(toc).toContain('**2. 编码实现**（1 轮）\n- [[#第 2 轮：编码：补测试]]')
    // 同一模块的多个轮次按轮次号升序（与 entries 传入顺序无关）
    expect(toc).toContain(
      '**1. 问答型**（2 轮）\n' +
        '- [[#第 1 轮：需求提出：对话按语义分段导出]]\n' +
        '- [[#第 2 轮：编码：补测试]]',
    )
    // 空模块：单行加粗「**序号. 模块名**」，不写计数、无子列表
    expect(toc).toContain('\n**3. 其他**\n')
    expect(toc).not.toContain('**3. 其他**（')
    expect(toc).not.toContain('0 轮')
    expect(toc).not.toContain('（无）')
    // 空模块之间、维度之间都有空行隔开
    expect(toc).toContain('**3. 其他**\n\n### 对话功能/目的')
    expect(toc).toContain('**2. 生成型**\n\n**3. 其他**')
    // 不再有 callout / <details>：Obsidian 不解析 HTML 块内部的 Markdown
    expect(toc).not.toContain('[!note]')
    expect(toc).not.toContain('<details>')
  })

  it('策略外的历史模块名追加在后面，不凭空消失', () => {
    const toc = renderToc(strategy, [
      { dimensionId: 'phase', moduleName: '编码实现', turns: [{ no: 1, title: '编码：首段' }] },
      { dimensionId: 'phase', moduleName: '遗留模块', turns: [{ no: 3, title: '遗留：旧模块的轮次' }] },
    ])
    // 遗留模块排在策略内 3 个模块之后（序号 4），仍带轮次链接
    expect(toc).toContain('**4. 遗留模块**（1 轮）\n- [[#第 3 轮：遗留：旧模块的轮次]]')
  })

  it('目录链接是 wiki 链接 `[[#第 N 轮：标题]]`；标题为空时退化', () => {
    const toc = renderToc(strategy, [
      {
        dimensionId: 'phase',
        moduleName: '需求分析',
        turns: [{ no: 7, title: '需求提出：分段导出' }, { no: 9, title: '' }],
      },
    ])
    expect(toc).toContain('- [[#第 7 轮：需求提出：分段导出]]')
    expect(toc).toContain('- [[#第 9 轮]]')
  })

  it('目录链接目标里的 `|` `#` `^` 被转义（wiki 链接语法字符），`[` `]` 原样保留', () => {
    const toc = renderToc(strategy, [
      { dimensionId: 'phase', moduleName: '需求分析', turns: [{ no: 1, title: '规则[1]|别名：变更标记' }] },
    ])
    expect(toc).toContain('- [[#第 1 轮：规则[1]\\|别名：变更标记]]')
    // wiki 链接不需要 md 方括号转义（`\[` 会原样显示成正文里的反斜杠）
    expect(toc).not.toContain('\\[')
  })
})

describe('renderTags / tagify（Obsidian 原生标签）', () => {
  it('每维一个两层标签，空格分隔，行首无前缀', () => {
    expect(renderTags(seg(1, fullLabels), strategy))
      .toBe('#开发阶段/需求分析 #对话功能-目的/问答型')
    // 维度名里的 `/` 被规范成 `-`，标签恒为两层
    expect(renderTags(seg(2, { phase: '编码实现' }), strategy))
      .toBe('#开发阶段/编码实现 #对话功能-目的/其他')
    for (const tag of renderTags(seg(1, fullLabels), strategy).split(' ')) {
      expect(tag).toMatch(/^#[^#\s/]+\/[^#\s/]+$/)
    }
    // 维度名为空 → 维度段也兜底「未分类」
    const unnamed: Strategy = {
      ...strategy,
      dimensions: [{ ...strategy.dimensions[0]!, name: '  ' }],
    }
    expect(renderTags(seg(1, fullLabels), unnamed)).toBe('#未分类/需求分析')
  })

  it('tagify 把空白/`·`/`/`/标点统一换成 `-` 再折叠，空名兜底「未分类」', () => {
    expect(tagify('对话功能/目的')).toBe('对话功能-目的')
    expect(tagify('需求 分析')).toBe('需求-分析')
    expect(tagify('开发阶段·编码')).toBe('开发阶段-编码')
    expect(tagify('  a--b  ')).toBe('a-b')
    expect(tagify('问答型（含报错）')).toBe('问答型-含报错')
    expect(tagify('')).toBe('未分类')
    expect(tagify('   ')).toBe('未分类')
    expect(tagify('///')).toBe('未分类')
  })

  it('模块名为空/纯空白时标签落到「未分类」（不再回落到兜底模块）', () => {
    const out = renderRound(seg(1, { phase: '', purpose: '   ' }), strategy)
    expect(out).toContain('#开发阶段/未分类 #对话功能-目的/未分类')
  })
})

describe('stripHorizontalRules（回答自带的水平线）', () => {
  it('删掉 `---` / `***` / `___`（含缩进与尾随空白），围栏内不动', () => {
    expect(stripHorizontalRules('甲\n\n---\n\n乙')).toBe('甲\n\n\n\n乙')
    expect(stripHorizontalRules('甲\n***\n乙')).toBe('甲\n\n乙')
    expect(stripHorizontalRules('甲\n   ___\n乙')).toBe('甲\n\n乙')
    expect(stripHorizontalRules('甲\n----\n乙')).toBe('甲\n\n乙')
    // 不是水平线的行（列表项、正文里的短线）不动
    expect(stripHorizontalRules('甲\n- 列表项\n乙')).toBe('甲\n- 列表项\n乙')
    expect(stripHorizontalRules('甲\n--\n乙')).toBe('甲\n--\n乙')
    // 代码围栏内的 `---` 是内容，不能删
    expect(stripHorizontalRules('```yaml\n---\nname: x\n```')).toBe('```yaml\n---\nname: x\n```')
  })

  it('renderRound 里回答自带的水平线被删除（不与轮次分隔线/产物块混淆）', () => {
    const out = renderRound(
      seg(1, fullLabels, { turn: mkTurn(1, '问题', '第一段。\n\n---\n\n第二段。') }),
      strategy,
    )
    expect(out).not.toContain('> ---')
    expect(out).toContain('> 第一段。')
    expect(out).toContain('> 第二段。')
  })
})

describe('dedupeRestatements（同轮重复的复述/概括块）', () => {
  it('重复块只保留第一次，普通正文不受影响', () => {
    const text = [
      '复述：用户想要导出对话。',
      '',
      '概括：把对话导出成 Markdown。',
      '',
      '正文一。',
      '',
      '复述：用户想要导出对话。',
      '',
      '概括：把对话导出成 Markdown。',
      '',
      '正文二。',
    ].join('\n')
    expect(dedupeRestatements(text)).toBe(
      ['复述：用户想要导出对话。', '', '概括：把对话导出成 Markdown。', '', '正文一。', '', '正文二。'].join('\n'),
    )
  })

  it('围栏内的「复述/概括」不是块边界（内容安全，不误删）', () => {
    const text = [
      '复述：同一条需求。',
      '',
      '```md',
      '概括：围栏里的字不是块边界',
      '复述：围栏里也不算新块',
      '```',
      '',
      '概括：要点。',
      '',
      '正文。',
    ].join('\n')
    expect(dedupeRestatements(text)).toBe(text)
  })

  it('正文里提到「复述」但不在行首时不参与去重', () => {
    const text = '这是普通正文，里面提到了复述但没有行首标记。\n\n第二段。'
    expect(dedupeRestatements(text)).toBe(text)
    // 不重复的单块保持原样
    const once = '复述：只出现一次。\n\n概括：也一次。\n\n正文。'
    expect(dedupeRestatements(once)).toBe(once)
  })
})

describe('renderFrontMatter / renderNotes / renderChangeLog / renderArtifacts', () => {
  it('front matter 首行 ---、第二行 format 版本行，窗口字段齐全且不含 tech_stack', () => {
    const fm = renderFrontMatter({
      format: 10,
      date: '2026-10-09',
      sessionId: 's1',
      workspace: 'D:\\w',
      turns: 3,
      exportedAt: '2026-10-09 12:00',
      generator: 'dsh-session-export-md',
      strategy: '标准研发流程',
    })
    const lines = fm.split('\n')
    expect(lines[0]).toBe('---')
    expect(lines[1]).toBe('format: 10')
    expect(lines.at(-1)).toBe('---')
    // 技术栈已从 front matter 移除：不再输出 tech_stack 行
    expect(fm).not.toContain('tech_stack')
    expect(fm).toContain("date: '2026-10-09'")
    expect(fm).toContain("session_id: 's1'")
    expect(fm).toContain("workspace: 'D:/w'")
    expect(fm).toContain('turns: 3')
    expect(fm).toContain("exported_at: '2026-10-09 12:00'")
    expect(fm).toContain("generator: 'dsh-session-export-md'")
    expect(fm).toContain("strategy: '标准研发流程'")
  })

  it('renderNotes 输出脱敏提示、format 版本、策略名、每维覆盖度与附件目录', () => {
    const notes = renderNotes({
      format: 10,
      strategyName: '标准研发流程',
      coverage: [
        { dimensionName: '开发阶段', used: 2, total: 8 },
        { dimensionName: '对话功能/目的', used: 1, total: 8 },
      ],
      attachmentsDir: '对话导出-session-.artifacts/',
      changeLog: '本次变更记录（测试）。',
    })
    expect(notes.startsWith('## 备注')).toBe(true)
    expect(notes).toContain('- 敏感信息已脱敏。')
    expect(notes).toContain('format=10')
    expect(notes).toContain('分类策略：标准研发流程')
    expect(notes).toContain('覆盖：开发阶段 2/8 类、对话功能/目的 1/8 类')
    expect(notes).toContain(
      '- 各轮产物存放在同目录的 `对话导出-session-.artifacts/` 下（每轮一个文件，正文按轮次给出链接）。',
    )
    expect(notes).toContain('- 本次变更记录（测试）。')
    // 没有产物附件时不写附件说明行
    expect(renderNotes({ format: 10, strategyName: 's', coverage: [] })).not.toContain('.artifacts/')
  })

  it('renderChangeLog 概括本次编辑/撤回，轮次号取自映射，缺失时退回 seq', () => {
    const records: ChangeRecord[] = [
      { kind: 'edit', seq: 99, time: 1700000000000, targetStart: 2, targetEnd: 2, turnNo: 1, newContent: [{ type: 'text', text: 'x' }] },
      { kind: 'withdraw', seq: 100, time: 1700000000001, targetStart: 6, targetEnd: 6, turnNo: 2 },
      { kind: 'withdraw', seq: 101, time: 1700000000002, targetStart: 20, targetEnd: 21 },
    ]
    const log = renderChangeLog(records, new Map([[1, 1], [2, 2]]), 1700000000002)
    expect(log).toContain('本次变更记录（2023-11-14 22:13:20 UTC 导出）')
    expect(log).toContain('✏️ 编辑问题 `第 1 轮`')
    expect(log).toContain('↩️ 撤回问题 `第 2 轮`')
    expect(log).toContain('↩️ 撤回问题 `seq 20–21`')
    expect(renderChangeLog([], new Map(), 1)).toBe('')
  })

  it('renderArtifacts 无产物返回空串；有产物给附件链接；inlineArtifacts 时退回内联分组', () => {
    expect(renderArtifacts(seg(1, fullLabels))).toBe('')
    const withArtifacts = seg(1, fullLabels, {
      artifacts: [
        { kind: '链接', value: 'https://example.com' },
        { kind: '命令', value: 'npx vitest run' },
      ],
    })
    const md = renderArtifacts(withArtifacts)
    expect(md.startsWith(`${ARTIFACT_CALLOUT_PREFIX}产物（1 个文件 · 命令 1 / 链接 1）`)).toBe(true)
    expect(md).toContain('> - 全部产物：[[第1轮-产物|第1轮-产物.md]]（命令 1 / 链接 1）')
    expect(md).not.toContain('#### 产物')
    // 每行都带引用前缀（callout 不被打断）
    expect(md.split('\n').every(line => line.startsWith('> '))).toBe(true)

    const inline = renderArtifacts(withArtifacts, { inlineArtifacts: true })
    expect(inline.startsWith(`${ARTIFACT_CALLOUT_PREFIX}产物（2 项）`)).toBe(true)
    expect(inline).toContain('> **命令**（1）\n> - `npx vitest run`')
    expect(inline).toContain('> **链接**（1）\n> - https://example.com')
    expect(inline).not.toContain('第1轮-产物')
  })
})

describe('format=10：轮次正文零标记', () => {
  it('长回答 + 产物的轮次里没有 <details>/<summary>/HTML 注释/锚点', () => {
    const s = seg(1, fullLabels, {
      summary: '一句话概要。',
      turn: mkTurn(1, '问题', `${'长回答。'.repeat(400)}\n## 小节\n更细的内容`),
      artifacts: [
        { kind: '命令', value: 'npx vitest run' },
        { kind: '链接', value: 'https://example.com' },
      ],
    })
    const out = renderRound(s, strategy)
    expect(out).toContain('**概要**：一句话概要。')
    expect(out).toContain(ANSWER_CALLOUT_PREFIX)
    expect(out).toContain(ARTIFACT_CALLOUT_PREFIX)
    expect(out).not.toContain('<details>')
    expect(out).not.toContain('<summary>')
    expect(out).not.toContain('<!--')
    expect(out).not.toContain('<a id=')
    expect(out).not.toContain('#turn-')
  })
})
