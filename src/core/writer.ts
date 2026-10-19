import type { ChangeRecord, ExportSegment, Strategy, Turn, Watermark } from './types.js'
import { bodyRange, normalizeNewlines, parseDocument } from './document.js'
import {
  renderArtifacts,
  renderChangeLog,
  renderFrontMatter,
  renderNotes,
  renderRound,
  renderToc,
  type FrontMatterInput,
  type TocModuleEntries,
} from './renderer.js'
import { advanceWatermark } from './watermark.js'

/**
 * 文件结构（format=10：正文零标记；分类用 Obsidian 原生标签；答案/问题用 callout；产物写附件文件）：
 *   ---                       front matter（首行为 format: 10）
 *   # 对话信息
 *   ## 目录                  维度 `###` + 模块加粗（计数） + 轮次 wiki 链接
 *   ## 对话正文
 *   ### 第 1 轮：标题         轮次位置由标题本身表达；轮次之间用 `---` 分隔
 *   …标签行 / 用户 callout / 概要 / 回答 callout / 产物（附件链接）
 *   ## 备注
 * 派生区（front matter、目录、备注）可重建；轮次正文只追加；
 * 结构定位见 `document.ts`（围栏感知扫描，不依赖任何 HTML 注释标记）。
 */

/** 当前格式版本（写入 front matter 首行）。 */
export const FORMAT_VERSION = 10

/** 轮次之间的分隔线（长会话里区分轮次边界）。 */
export const ROUND_SEPARATOR = '---'

/** 文件头里必须出现的版本行；旧文件据此判为需重建。 */
export const FORMAT_MARKER = `format: ${String(FORMAT_VERSION)}`

/**
 * 文件是否为本格式：
 * - 版本号**只认 front matter 首部**（不能用全文件 `includes`：正文里被引用的示例也可能含
 *   `format: 8` 行，会把旧文件误判成当前格式，进而把新结构追加到旧结构上）；
 * - `# 对话信息` / `## 目录` / `## 对话正文` / `## 备注` 必须齐全且顺序正确（围栏感知）。
 */
export function isCurrentFormat(content: string): boolean {
  if (!normalizeNewlines(content).startsWith(`---\n${FORMAT_MARKER}\n`)) return false
  const layout = parseDocument(content)
  return layout.infoLine !== -1 &&
    layout.tocLine !== -1 && layout.bodyLine !== -1 && layout.notesLine !== -1 &&
    layout.tocLine < layout.bodyLine && layout.bodyLine < layout.notesLine
}

export interface ExportDocumentMeta {
  sessionId: string
  title: string
  workspace?: string
  createdAtMs?: number
  exportedAtMs: number
  model?: string
}

export interface ComposeOptions {
  meta: ExportDocumentMeta
  strategy: Strategy
  segments: readonly ExportSegment[]
  /** 目录条目（两套分类各自命中的轮次）。 */
  toc: readonly TocModuleEntries[]
  /** 附件目录名（写进备注；有产物附件时给出）。 */
  attachmentsDir?: string
  /** 附件写失败时把产物内联回正文（降级路径）。 */
  inlineArtifacts?: boolean
  changeLog?: readonly ChangeRecord[]
  includeChangeLog?: boolean
}

function frontMatterOf(meta: ExportDocumentMeta, strategy: Strategy, turns: number): FrontMatterInput {
  const exportedAtMs = meta.exportedAtMs
  const iso = new Date(exportedAtMs).toISOString()
  return {
    format: FORMAT_VERSION,
    date: iso.slice(0, 10),
    sessionId: meta.sessionId,
    ...(meta.workspace !== undefined ? { workspace: meta.workspace } : {}),
    turns,
    exportedAt: iso.slice(0, 16).replace('T', ' '),
    generator: 'dsh-session-export-md',
    strategy: strategy.name,
  }
}

/** 备注里的覆盖度只需要每轮的分类标签（段/目录条目都能满足）。 */
export interface CoverageEntry {
  labels: Record<string, string>
}

/** 每维覆盖度（用到的模块数 / 模块总数），写入备注。 */
function coverageOf(
  strategy: Strategy,
  segments: readonly CoverageEntry[],
): { dimensionName: string; used: number; total: number }[] {
  return strategy.dimensions.map((d) => {
    const used = new Set(
      segments.map((s) => s.labels[d.id]).filter((v): v is string => v !== undefined && v !== ''),
    )
    const known = new Set(d.modules.map((m) => m.name))
    return {
      dimensionName: d.name,
      used: [...used].filter((n) => known.has(n)).length,
      total: d.modules.length,
    }
  })
}

function notesOf(opts: {
  strategy: Strategy
  /** 覆盖度统计口径：**全量**条目（增量导出时应传全量，而不是本次增量）。 */
  segments: readonly CoverageEntry[]
  meta: ExportDocumentMeta
  attachmentsDir?: string
  changeLog?: string
}): string {
  return renderNotes({
    format: FORMAT_VERSION,
    strategyName: opts.strategy.name,
    coverage: coverageOf(opts.strategy, opts.segments),
    ...(opts.attachmentsDir !== undefined ? { attachmentsDir: opts.attachmentsDir } : {}),
    ...(opts.changeLog !== undefined ? { changeLog: opts.changeLog } : {}),
  })
}

/** 组装完整文档（首次导出 / 重建 / 重排）。 */
export function composeExport(opts: ComposeOptions): string {
  const { meta, strategy, segments, toc } = opts
  const roundOpts = opts.inlineArtifacts === true ? { inlineArtifacts: true } : {}
  const rounds = segments.map((s) => renderRound(s, strategy, roundOpts))
  const changeLog = opts.includeChangeLog === false
    ? undefined
    : renderChangeLog(
        opts.changeLog ?? [],
        new Map(segments.map((s) => [s.turn.turnNo, s.no])),
        meta.exportedAtMs,
      )

  const parts: string[] = [
    renderFrontMatter(frontMatterOf(meta, strategy, segments.length)),
    '',
    '# 对话信息',
    '',
    renderToc(strategy, toc),
    '',
    '## 对话正文',
  ]
  if (rounds.length > 0) parts.push('', rounds.join(`\n\n${ROUND_SEPARATOR}\n\n`))
  parts.push('', notesOf({
    strategy,
    segments,
    meta,
    ...(opts.attachmentsDir !== undefined ? { attachmentsDir: opts.attachmentsDir } : {}),
    ...(changeLog !== undefined && changeLog !== '' ? { changeLog } : {}),
  }))
  return parts.join('\n') + '\n'
}

export interface SegmentAnnotation {
  /** 轮次编号（对应正文标题 `### 第 N 轮：…`）。 */
  no: number
  /** 注入到该轮标题下方的标注 md（变更标记等）。 */
  annotation: string
}

/**
 * 把标注注入到指定轮标题的正下方（仅插入派生标注行，正文不动）。
 * 轮次位置由标题定位（围栏感知）；幂等只看**本轮区间**——同一段标注文本出现在别的轮次
 * 或正文引用里，不会导致本轮漏注入。
 */
export function injectSegmentAnnotation(content: string, a: SegmentAnnotation): string {
  if (a.annotation === '') return content
  const layout = parseDocument(content)
  const index = layout.rounds.findIndex((r) => r.no === a.no)
  if (index === -1) return content
  const round = layout.rounds[index]
  if (round === undefined) return content
  const next = layout.rounds[index + 1]
  const endLine = next !== undefined
    ? next.line
    : (layout.notesLine !== -1 ? layout.notesLine : layout.lines.length)
  const zone = layout.lines.slice(round.line, endLine).join('\n')
  if (zone.includes(a.annotation)) return content
  const after = layout.lines.slice(round.line + 1)
  while (after.length > 0 && after[0] === '') after.shift()
  return [...layout.lines.slice(0, round.line + 1), '', a.annotation, '', ...after].join('\n')
}

export interface AppendOptions {
  existing: string
  meta: ExportDocumentMeta
  strategy: Strategy
  /** 本次新增轮次（追加到正文末尾）。 */
  segments: readonly ExportSegment[]
  /** 重建后的完整目录内容（含 `## 目录`）。 */
  toc: string
  watermark: Watermark
  appendedSegments: number
  appendedTurns: readonly Pick<Turn, 'endSeq' | 'endTime'>[]
  /** 全量条目（用于重算备注里的覆盖度；增量导出时必须传全量，否则覆盖度只算本次增量）。 */
  allSegments?: readonly CoverageEntry[]
  /** 已导出轮的标注（编辑/撤回标记）。 */
  segmentAnnotations?: readonly SegmentAnnotation[]
  /** 附件目录名（写进备注；有产物附件时给出）。 */
  attachmentsDir?: string
  /** 附件写失败时把产物内联回正文（降级路径）。 */
  inlineArtifacts?: boolean
  /** 本次变更记录（写入备注）。 */
  changeLog?: string
}

/** 现有轮次数：正文区里的 `### 第 N 轮` 标题数量。 */
function countRounds(content: string): number {
  return parseDocument(content).rounds.length
}

/** 替换 front matter 里的某个标量（值按 YAML 单引号规则写入）。 */
function patchFrontMatter(content: string, key: string, value: string): string {
  const end = content.indexOf('\n---\n')
  if (!content.startsWith('---\n') || end === -1) return content
  const head = content.slice(0, end)
  const rest = content.slice(end)
  const re = new RegExp(`^${key}:.*$`, 'm')
  const line = `${key}: ${value}`
  return (re.test(head) ? head.replace(re, line) : `${head}\n${line}`) + rest
}

/**
 * 只追加：新轮次追加到正文区末尾，目录与 front matter 的 turns/exported_at 重建；
 * 已导出轮的变更标记注入对应轮次标题下；备注整段按当前模板重排（含变更记录）。
 * 文件不是当前格式（format=10）时返回 null，由调用方转为重建。
 */
export function appendExport(
  opts: AppendOptions,
): { newContent: string; newWatermark: Watermark } | null {
  const { existing } = opts
  if (!isCurrentFormat(existing)) return null
  const layout = parseDocument(existing)
  const range = bodyRange(layout)
  if (range === null) return null

  const frontMatter = layout.lines.slice(0, layout.infoLine).join('\n').replace(/\s+$/, '')
  // 正文区：去掉 `## 对话正文` 之后的空行与区尾空行，内部间距原样保留
  let rounds = layout.lines.slice(range.start, range.end).join('\n')
    .replace(/^\s+/, '').replace(/\s+$/, '')
  const roundOpts = opts.inlineArtifacts === true ? { inlineArtifacts: true } : {}
  for (const s of opts.segments) {
    const block = renderRound(s, opts.strategy, roundOpts)
    rounds = rounds === '' ? block : `${rounds}\n\n${ROUND_SEPARATOR}\n\n${block}`
  }

  // 备注：重建覆盖度（用全量段）并更新变更记录
  const newNotes = notesOf({
    strategy: opts.strategy,
    segments: opts.allSegments ?? opts.segments,
    meta: opts.meta,
    ...(opts.attachmentsDir !== undefined ? { attachmentsDir: opts.attachmentsDir } : {}),
    ...(opts.changeLog !== undefined ? { changeLog: opts.changeLog } : {}),
  })

  // 派生区（front matter / 目录 / 正文标题 / 备注）整段按当前模板重排，只保留轮次正文
  let newContent =
    `${frontMatter}\n# 对话信息\n\n` +
    `${opts.toc}\n\n` +
    `## 对话正文\n\n` +
    (rounds === '' ? '' : `${rounds}\n\n`) +
    `${newNotes}\n`

  // front matter 的 turns / exported_at 重建
  newContent = patchFrontMatter(newContent, 'turns', String(countRounds(newContent)))
  const iso = new Date(opts.meta.exportedAtMs).toISOString()
  newContent = patchFrontMatter(newContent, 'exported_at', `'${iso.slice(0, 16).replace('T', ' ')}'`)

  for (const a of opts.segmentAnnotations ?? []) {
    newContent = injectSegmentAnnotation(newContent, a)
  }
  if (!newContent.endsWith('\n')) newContent += '\n'

  const newWatermark = advanceWatermark(opts.watermark, opts.appendedTurns, opts.appendedSegments)
  return { newContent, newWatermark }
}

export { renderArtifacts }
