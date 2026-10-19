import { ARTIFACT_ORDER } from './artifacts.js'
import { planAttachments } from './attachments.js'
import type {
  ChangeRecord,
  ContentBlock,
  ExportSegment,
  Strategy,
  StrategyDimension,
} from './types.js'

/**
 * 文档模板（format=10，2026-10-11 第十次确认）：
 *   ---                      front matter（format / session_id / turns / … ）
 *   # 对话信息
 *     ## 目录                维度 `###` + 模块加粗（计数） + 轮次 wiki 链接
 *     ## 对话正文            每轮：标签行 → 用户 callout → 概要 → 回答 callout → 产物（附件链接）
 *   ## 备注                  脱敏说明、生成信息、变更记录
 * 结构标题只有 `# 对话信息`、`## 目录`、`### 维度名`、`## 对话正文`、`### 第 N 轮`、`## 备注`；
 * 用户文本行首 `#` 转义、回答自带标题固定降到 `####`–`######`，保证大纲不被正文污染。
 * 正文不写任何 HTML 注释标记；分类用 Obsidian 原生标签；产物写进附件文件、正文只留链接。
 */

/** 确定性时间格式（UTC，测试快照稳定）。 */
export function formatTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ') + ' UTC'
}

/** 日期（UTC，YYYY-MM-DD）。 */
export function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/** 标题锚点 slug：保留字母/数字/CJK/下划线，其余替换为 '-'（对齐 GitHub 锚点行为）。 */
export function slugify(title: string): string {
  return title
    .replace(/[^\p{L}\p{N}_]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

/** 标题归一化：折叠空白为单空格（多行标题会破坏标题行与目录）。 */
export function singleLine(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim()
}

/**
 * 内容块转 md 源文本：**只取文本块**。
 * 思考（reasoning）、工具调用/结果（tool-call / tool-result）等非文本块一律不导出，
 * 否则会把原始 JSON 载荷写进文档正文。图片附件以占位文字保留。
 */
export function contentToMd(blocks: readonly ContentBlock[]): string {
  if (blocks.length === 0) return ''
  return blocks
    .map((b) => {
      if (b.type === 'text' && typeof b.text === 'string') return b.text
      if (b.type === 'image') return '（图片附件）'
      return ''
    })
    .filter((t) => t !== '')
    .join('\n\n')
}

/**
 * 逐行加 '> ' 前缀转引用块。
 * 每行独立加前缀，代码围栏（```）行同样处理，围栏在引用块内保持完整。
 */
export function blockquote(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  return lines.map((l) => (l.length === 0 ? '>' : `> ${l}`)).join('\n')
}

/** 逐行变换，但跳过代码围栏内部（围栏内的 `#` 是注释，不是标题）。 */
function mapOutsideFences(text: string, transform: (line: string) => string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  let fence: string | null = null
  return lines
    .map((line) => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)
      if (marker !== null) {
        const token = marker[1]![0]!
        if (fence === null) fence = token
        else if (fence === token) fence = null
        return line
      }
      return fence === null ? transform(line) : line
    })
    .join('\n')
}

/** 行首标题：允许引用前缀（`> `、`> > `），引用块里的标题同样会进大纲，必须一并处理。 */
const HEADING_LINE = /^((?:[ \t]*>[ \t]*)*)(#{1,6})([ \t]|$)/

/**
 * 转义行首标题标记：逐字引用的问题原文（含用户粘贴的模板片段）不应产生真标题。
 */
export function escapeHeadingMarkers(text: string): string {
  return mapOutsideFences(text, (line) =>
    line.replace(HEADING_LINE, (_match, prefix: string, hashes: string, space: string) =>
      `${prefix}\\${hashes}${space}`),
  )
}

/**
 * 把内容自带的标题整体降到文档结构之下（第 N 轮是 `###`）。
 * **固定映射**（跨轮一致）：`#`→`####`、`##`→`#####`、`###` 及更深→`######`。
 * 不再按每轮最浅标题归一——那会让同一层级在不同轮落到不同级别，跨轮看结构就乱了。
 */
export function nestHeadings(text: string, baseLevel: number): string {
  return mapOutsideFences(text, (line) =>
    line.replace(HEADING_LINE, (_match, prefix: string, hashes: string, space: string) =>
      `${prefix}${'#'.repeat(Math.min(6, baseLevel + hashes.length - 1))}${space}`),
  )
}

/** 回答里的概述块前缀（`**概述：** 内容`、`概述: 内容`、`概括：内容`、`摘要：内容`）。 */
const SUMMARY_PREFIX = /^\s*(?:\*\*)?\s*(?:概述|概括|摘要)\s*(?:\*\*)?\s*[：:]\s*(?:\*\*)?\s*/

/** 概要单行长度上限（超出按语义边界截断；界面用悬停显示全文）。 */
export const SUMMARY_MAX_CHARS = 200

/** 句末标点 / 次级停顿标点（按语义边界截断时从后往前找）。 */
const SENTENCE_END = /[。！？!?；;…]/
const CLAUSE_END = /[，、,：:]/

/**
 * 按**语义边界**截断（在上限内尽量落在句末，其次落在分句处，最后才硬截断），
 * 截断时补 `…`。用于概要：避免把话切在半句、看着"没说完"。
 */
export function truncateAtBoundary(raw: string, maxChars: number): string {
  const one = singleLine(raw)
  const chars = Array.from(one)
  if (chars.length <= maxChars) return one
  const head = chars.slice(0, maxChars)
  for (let i = head.length - 1; i >= Math.floor(head.length * 0.5); i--) {
    if (SENTENCE_END.test(head[i]!)) return head.slice(0, i + 1).join('')
  }
  for (let i = head.length - 1; i >= Math.floor(head.length * 0.5); i--) {
    if (CLAUSE_END.test(head[i]!)) return head.slice(0, i + 1).join('') + '…'
  }
  return head.join('') + '…'
}

/**
 * 把回答里的概述段提取为「概要」，其余文本仍为回答正文。
 * 规则：先取概述标记后的**第一段**；若这一段结尾不是句末标点（说明话没说完），
 * 就继续并入后续段落，直到出现句末标点或达到字数上限（`SUMMARY_MAX_CHARS`），
 * 最后按语义边界截断。找不到概述标记时返回空概要（文档留空，不用标题冒充）。
 * @param texts - 该轮全部助手文本块（已按顺序、已剔除思考/工具载荷）。
 */
export function splitLeadingSummary(texts: readonly string[]): {
  summary: string
  rest: string[]
} {
  const index = texts.findIndex((text) => SUMMARY_PREFIX.test(text))
  if (index === -1) return { summary: '', rest: [...texts] }
  const body = texts[index]!.replace(SUMMARY_PREFIX, '')
  // 结构标记（加粗标签行 / 标题行）即概述段结束
  const stop = /^(?:\*\*|#{1,6}\s)/m.exec(body)
  const block = stop !== null ? body.slice(0, stop.index) : body
  const paragraphs = block.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p !== '')

  let acc = paragraphs[0] ?? ''
  let consumed = acc === '' ? 0 : 1
  const endsSentence = (text: string): boolean => {
    const last = Array.from(text).at(-1) ?? ''
    return SENTENCE_END.test(last)
  }
  while (consumed < paragraphs.length && !endsSentence(acc)) {
    if (Array.from(acc).length >= SUMMARY_MAX_CHARS) break
    acc = `${acc} ${paragraphs[consumed]!}`
    consumed++
  }

  const summary = truncateAtBoundary(acc, SUMMARY_MAX_CHARS)
  const remainder = paragraphs.slice(consumed).join('\n\n') + (stop !== null ? `\n\n${body.slice(stop.index)}` : '')
  const rest = [...texts]
  rest.splice(index, 1, ...(remainder.trim() !== '' ? [remainder.trim()] : []))
  return { summary, rest }
}

/** 标题正下方的变更标记（规则：编辑→提示；撤回→提示+保留历史）。 */
export function renderChangeMarker(changes: readonly ChangeRecord[]): string {
  if (changes.length === 0) return ''
  return changes
    .map((c) => {
      const at = formatTime(c.time)
      if (c.kind === 'withdraw') {
        return `> ⚠️ **变更标记**（${at} 导出时检测）：本段内容（seq ${c.targetStart}–${c.targetEnd}）已被撤回，历史导出内容保留如下。`
      }
      return `> ⚠️ **变更标记**（${at} 导出时检测）：本段「问题」原文（seq ${c.targetStart}–${c.targetEnd}）已被编辑。`
    })
    .join('\n')
}

/**
 * 轮次标题下的标注区（变更标记 + 编辑后的问题），供两处使用：
 * - 本轮随增量一起渲染时内联输出（renderRound）；
 * - 已导出轮次在后续增量中命中变更时，由 Writer 注入该轮标题的正下方。
 */
export function renderSegmentAnnotation(changes: readonly ChangeRecord[]): string {
  const marker = renderChangeMarker(changes)
  if (marker === '') return ''
  const parts: string[] = [marker]
  for (const c of changes) {
    if (c.kind === 'edit' && c.newContent && c.newContent.length > 0) {
      parts.push('', `> ✏️ **编辑后的问题**（${formatTime(c.time)}）：`, blockquote(escapeHeadingMarkers(contentToMd(c.newContent))))
    }
  }
  return parts.join('\n')
}

/**
 * 轮次标题文本（不带 `###` 前缀）：`第 N 轮` 或 `第 N 轮：标题`。
 * 正文标题与目录 wiki 链接同源，保证链接目标与标题逐字一致。
 */
export function roundHeadingText(no: number, title: string): string {
  const text = title.trim()
  return text === '' ? `第 ${String(no)} 轮` : `第 ${String(no)} 轮：${escapeInlineTitle(text)}`
}

/** wiki 链接目标转义：`\`/`|`/`#`/`^` 是 Obsidian 链接语法字符。 */
export function escapeWikiTarget(raw: string): string {
  return singleLine(raw).replace(/[\\|#^]/g, (m) => `\\${m}`)
}

/**
 * 目录里的轮次链接（Obsidian 原生 wiki 链接，指向正文同名标题）。
 * 目标文本用**未转义**的标题（与 Obsidian 缓存的标题文本一致），
 * 正文标题里的 `\[`/`\]` 是 Markdown 转义，渲染后同样是 `[`/`]`。
 */
export function roundLink(no: number, title: string): string {
  const text = singleLine(title)
  const heading = text === '' ? `第 ${String(no)} 轮` : `第 ${String(no)} 轮：${text}`
  return `[[#${escapeWikiTarget(heading)}]]`
}

/** 分类标签行（Obsidian 原生标签，行首无前缀）：`#开发阶段/其他 #对话功能/目的/问答型`。 */
export function renderTags(segment: ExportSegment, strategy: Strategy): string {
  return strategy.dimensions
    .map((d) => `#${tagify(d.name)}/${tagify(segment.labels[d.id] ?? d.defaultModule)}`)
    .join(' ')
}

/**
 * 标签片段规范化：去掉 Obsidian 标签不允许的字符（空白、`·`、`/`、标点等），
 * 统一替换为 `-` 再折叠，保证最终标签恒为「维度/模块」两层
 * （维度名「对话功能/目的」里的 `/` 也会变成 `-`，避免出现三层标签）。
 */
export function tagify(raw: string): string {
  const cleaned = singleLine(raw)
    .replace(/[\s·・、,，。.：:；;｜|#\[\]()（）{}<>《》"'`*_~!！?？+=&^$%@\\/-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned === '' ? '未分类' : cleaned
}

/** 用户内容块的 callout 头（不折叠）。 */
export const QUESTION_CALLOUT_PREFIX = '> [!question] '
/** 回答内容块的 callout 头（不折叠——折叠会让轮次结构看起来断裂）。 */
export const ANSWER_CALLOUT_PREFIX = '> [!quote] '
/** 产物块的 callout 头。 */
export const ARTIFACT_CALLOUT_PREFIX = '> [!example]- '

/** 去掉回答自带的水平线：`> ---` 会在 callout 里形成分界线，甚至把折叠块切断。 */
export function stripHorizontalRules(text: string): string {
  return mapOutsideFences(text, (line) =>
    /^ {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line) ? '' : line,
  )
}

/** 重复的「复述 / 概括」块：只保留第一次出现（同一轮内多次复述没有信息量）。 */
const RESTATE_START = /^(?:\*\*)?\s*复述/
const RESTATE_PART = /^(?:\*\*)?\s*(?:复述|概括|概要)/

/**
 * 同一轮里重复的「复述 + 概括」块只保留第一次。
 * 回答里常有多条助手消息（工具调用前后各一次复述），逐个拼接会重复堆叠。
 * 块 = `复述…` 起，含其中的代码围栏与 `概括…`，直到下一个实义行（空行不断块）。
 */
export function dedupeRestatements(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  // 先给每行分类：围栏行 / 围栏内 / 普通行（围栏内的内容不参与块边界判断）
  const kind: ('plain' | 'fence' | 'fenced')[] = []
  let fence: string | null = null
  for (const line of lines) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)
    if (marker !== null) {
      const token = marker[1]![0]!
      kind.push('fence')
      if (fence === null) fence = token
      else if (fence === token) fence = null
      continue
    }
    kind.push(fence === null ? 'plain' : 'fenced')
  }

  const keep = lines.map(() => true)
  const seen = new Set<string>()
  let start = -1
  let block: string[] = []
  const flush = (end: number): void => {
    if (start === -1) return
    const key = block
      .join('\n')
      .replace(/`{3,}|~{3,}/g, '')
      .replace(/\s+/g, ' ')
      .trim()
    if (key !== '') {
      if (seen.has(key)) for (let i = start; i < end; i++) keep[i] = false
      else seen.add(key)
    }
    start = -1
    block = []
  }

  for (const [i, line] of lines.entries()) {
    const lineKind = kind[i]!
    if (lineKind === 'plain' && RESTATE_START.test(line)) {
      flush(i)
      start = i
      block = [line]
      continue
    }
    if (start === -1) continue
    if (lineKind === 'plain' && line.trim() !== '' && !RESTATE_PART.test(line)) {
      flush(i)
      continue
    }
    block.push(line)
  }
  flush(lines.length)
  return lines.filter((_line, i) => keep[i] === true).join('\n')
}

/**
 * 产物块：默认只给附件文件链接（产物正文写在附件里）；
 * `inlineArtifacts` 为真时退回按类型分组的内联展示（附件写失败时的降级路径）。
 */
export function renderArtifacts(
  segment: ExportSegment,
  opts: { inlineArtifacts?: boolean } = {},
): string {
  if (segment.artifacts.length === 0) return ''
  const plans = planAttachments(segment.no, segment.artifacts)
  if (opts.inlineArtifacts !== true && plans.length > 0) {
    const counts = plans
      .flatMap((p) => p.groups)
      .map((g) => `${g.kind} ${String(g.items.length)}`)
      .join(' / ')
    const lines = [`${ARTIFACT_CALLOUT_PREFIX}产物（${String(plans.length)} 个文件 · ${counts}）`]
    for (const plan of plans) {
      const label = plans.length === 1 ? '全部产物' : plan.groups.map((g) => g.kind).join(' · ')
      const detail = plan.groups.map((g) => `${g.kind} ${String(g.items.length)}`).join(' / ')
      lines.push(`> - ${label}：[[${plan.linkTarget}|${plan.fileName}]]（${detail}）`)
    }
    return lines.join('\n')
  }
  const lines: string[] = [`${ARTIFACT_CALLOUT_PREFIX}产物（${String(segment.artifacts.length)} 项）`]
  for (const kind of ARTIFACT_ORDER) {
    const values = segment.artifacts.filter((item) => item.kind === kind).map((item) => item.value)
    if (values.length === 0) continue
    lines.push(`> **${kind}**（${String(values.length)}）`)
    for (const value of values) lines.push(kind === '链接' ? `> - ${value}` : `> - \`${value}\``)
  }
  return lines.join('\n')
}

/** 单轮渲染选项。 */
export interface RoundRenderOptions {
  /** 附件写失败时改为把产物内联进正文（降级）。 */
  inlineArtifacts?: boolean
}

/**
 * 渲染一轮（format=10，标题由模型生成；正文零标记）：
 *   ### 第 1 轮：标题
 *   > 变更标记（若有）
 *   （空行）
 *   #开发阶段/其他 #对话功能/目的/问答型
 *   （空行）
 *   > [!question] 用户
 *   > 问题原文
 *   （空行）
 *   **概要**：…（为空时整行省略）
 *   （空行）
 *   > [!quote] 回答
 *   > 回答正文（标题固定降到 #### 起）
 *   （空行）
 *   > [!example]- 产物（1 个文件 · 命令 3）   ← 只给附件链接
 * 轮次位置由标题本身表达（`document.ts` 按 `### 第 N 轮` 定位），
 * 已导出轮的变更标注由 Writer 注入该轮标题的下一行；轮次之间由 Writer 插入 `---` 分隔。
 */
export function renderRound(
  segment: ExportSegment,
  strategy: Strategy,
  opts: RoundRenderOptions = {},
): string {
  const texts = segment.turn.assistant.map((m) => contentToMd(m.content)).filter((t) => t !== '')
  const { summary: extracted, rest } = splitLeadingSummary(texts)
  // 概要优先用段上的值（可由预览编辑/服务层预填）；段上为空时退回从回答提取，
  // 避免调用方漏填时把回答里的概述段白白丢掉。提取不到就整行省略（不写空标签）。
  const summary = singleLine(segment.summary !== '' ? segment.summary : extracted)
  const answerBody = stripHorizontalRules(dedupeRestatements(rest.join('\n\n'))).replace(/\n{3,}/g, '\n\n').trim()

  const parts: string[] = [`### ${roundHeadingText(segment.no, segment.title)}`]
  const annotation = renderSegmentAnnotation(segment.changes)
  if (annotation !== '') parts.push(annotation)
  const tags = renderTags(segment, strategy)
  if (tags !== '') parts.push('', tags)

  const question = segment.turn.user
    .map((m) => contentToMd(m.content))
    .filter((t) => t !== '')
    .join('\n\n')
    .replace(/\s+$/, '')
  parts.push('', `${QUESTION_CALLOUT_PREFIX}用户`)
  if (question !== '') parts.push(blockquote(escapeHeadingMarkers(question)))

  if (summary !== '') parts.push('', `**概要**：${summary}`)

  parts.push('', `${ANSWER_CALLOUT_PREFIX}回答`)
  if (answerBody !== '') parts.push(blockquote(nestHeadings(answerBody, 4)))

  const artifacts = renderArtifacts(segment, opts)
  if (artifacts !== '') parts.push('', artifacts)
  return parts.join('\n')
}

/** 目录条目：某维度下某模块命中的轮次（带标题，正文标题同源）。 */
export interface TocModuleEntries {
  dimensionId: string
  moduleName: string
  turns: { no: number; title: string }[]
}

/** 行内/链接文本里的标题转义：单行化 + 转义方括号（否则目录链接会被截断）。 */
export function escapeInlineTitle(raw: string): string {
  return singleLine(raw).replace(/[[\]]/g, (m) => `\\${m}`)
}

/**
 * 目录（`## 目录` 的内容，format=10）：
 *   ### 开发阶段                     ← 维度是结构标题（进大纲）
 *
 *   **1. 需求分析**（5 轮）           ← 模块加粗一行 + 轮次计数
 *   - [[#第 2 轮：需求提出：对话按语义分段导出]]
 *   - [[#第 5 轮：规则修改：变更标记改为两处]]
 *
 *   **4. 测试**                      ← 空模块只留一行加粗（不写 0 轮、无子列表）
 * 每个维度的模块按策略顺序全量列出；链接是 Obsidian 原生 wiki 链接，指向正文同名标题。
 * 不用 callout/`<details>`：Obsidian 不解析 HTML 块内部的 Markdown，且 callout 框观感过重。
 */
export function renderToc(strategy: Strategy, entries: readonly TocModuleEntries[]): string {
  const lines: string[] = ['## 目录']
  for (const dimension of strategy.dimensions) {
    // 维度之间只留一个空行（上一个维度的末尾可能已经补过空行）
    if (lines[lines.length - 1] !== '') lines.push('')
    // 维度是结构标题（进大纲），模块是加粗一行 + 轮次链接列表（无框，观感更轻）
    lines.push(`### ${singleLine(dimension.name)}`, '')
    const names = dimension.modules.map((m) => m.name)
    // 策略外的历史模块（换策略后残留）追加在后面，避免条目凭空消失
    const extra = [...new Set(
      entries
        .filter((e) => e.dimensionId === dimension.id && !names.includes(e.moduleName))
        .map((e) => e.moduleName),
    )]
    const all = [...names, ...extra]
    for (const [index, name] of all.entries()) {
      const hit = entries.find((e) => e.dimensionId === dimension.id && e.moduleName === name)
      const byNo = new Map<number, string>()
      for (const t of hit?.turns ?? []) byNo.set(t.no, t.title)
      const turns = [...byNo.keys()].sort((a, b) => a - b)
      if (turns.length === 0) {
        // 空模块：只留一行加粗标题（不写 0 轮、不写子列表），保持"每维全量列出"的可核对性
        lines.push(`**${String(index + 1)}. ${name}**`)
        if (index < all.length - 1) lines.push('')
        continue
      }
      lines.push(`**${String(index + 1)}. ${name}**（${String(turns.length)} 轮）`)
      for (const no of turns) lines.push(`- ${roundLink(no, byNo.get(no) ?? '')}`)
      lines.push('')
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines.join('\n')
}

/** front matter（文件最前，`---` 包裹；format 版本号在首行）。 */
export interface FrontMatterInput {
  format: number
  date: string
  sessionId: string
  workspace?: string
  turns: number
  exportedAt: string
  generator: string
  strategy: string
}

/** YAML 单引号字符串（内部单引号双写）。 */
function yamlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

export function renderFrontMatter(input: FrontMatterInput): string {
  const lines: string[] = ['---', `format: ${String(input.format)}`]
  lines.push(`date: ${yamlString(input.date)}`)
  lines.push(`session_id: ${yamlString(input.sessionId)}`)
  if (input.workspace !== undefined && input.workspace !== '') {
    lines.push(`workspace: ${yamlString(input.workspace.replace(/\\/g, '/'))}`)
  }
  lines.push(`turns: ${String(input.turns)}`)
  lines.push(`exported_at: ${yamlString(input.exportedAt)}`)
  lines.push(`generator: ${yamlString(input.generator)}`)
  lines.push(`strategy: ${yamlString(input.strategy)}`)
  lines.push('---')
  return lines.join('\n')
}

/** 备注小节：脱敏提示 + 生成信息（含分类覆盖度）+ 附件说明 + 变更记录。 */
export function renderNotes(opts: {
  format: number
  strategyName: string
  coverage: readonly { dimensionName: string; used: number; total: number }[]
  /** 附件目录名（有产物附件时写入；如 `对话导出-session-.artifacts/`）。 */
  attachmentsDir?: string
  changeLog?: string
}): string {
  const lines: string[] = ['## 备注', '', '- 敏感信息已脱敏。']
  const coverage = opts.coverage
    .map((c) => `${c.dimensionName} ${String(c.used)}/${String(c.total)} 类`)
    .join('、')
  const info = [
    `本文件由 dsh-session-export-md 生成（format=${String(opts.format)}）`,
    `分类策略：${opts.strategyName}`,
  ]
  if (coverage !== '') info.push(`覆盖：${coverage}`)
  lines.push(`- ${info.join('；')}。`)
  if (opts.attachmentsDir !== undefined && opts.attachmentsDir !== '') {
    lines.push(`- 各轮产物存放在同目录的 \`${opts.attachmentsDir}\` 下（每轮一个文件，正文按轮次给出链接）。`)
  }
  if (opts.changeLog !== undefined && opts.changeLog !== '') lines.push(`- ${opts.changeLog}`)
  return lines.join('\n')
}

/** 增量末尾的变更记录文本（单行，写入备注）；reference 用「第 N 轮」。 */
export function renderChangeLog(
  records: readonly ChangeRecord[],
  roundsByTurn: ReadonlyMap<number, number>,
  exportedAtMs: number,
): string {
  if (records.length === 0) return ''
  const items = records.map((c) => {
    const no = c.turnNo !== undefined ? roundsByTurn.get(c.turnNo) : undefined
    const ref = no !== undefined ? `第 ${String(no)} 轮` : `seq ${String(c.targetStart)}–${String(c.targetEnd)}`
    return c.kind === 'withdraw'
      ? `↩️ 撤回问题 \`${ref}\``
      : `✏️ 编辑问题 \`${ref}\``
  })
  return `本次变更记录（${formatTime(exportedAtMs)} 导出）：${items.join('；')}。`
}

export type { StrategyDimension }
