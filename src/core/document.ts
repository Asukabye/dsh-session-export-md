/**
 * 文档结构定位（format=8）。
 *
 * format 8 起文档里**不再写任何 HTML 注释标记**（旧版 `<!-- dsh-export:… -->` 会在
 * Obsidian 编辑视图里显示成粉红高亮标签），派生区与轮次位置全部靠「围栏感知的标题扫描」：
 *
 * - 只在代码围栏（``` / ~~~，含 4 反引号包 3 反引号的嵌套）之外识别标题，
 *   因此正文里被引用的示例（代码块内的 `## 目录`、`### 第 1 轮`）不会干扰解析；
 * - 位置一律用「行号（0 基）」表达，调用方按区间切片，不用字符串 indexOf，
 *   避免命中正文里被引用的同名文本（旧实现的截断隐患正来自这一点）；
 * - 若将来确实需要文件内定位点，一律用 `anchorLine()` 生成的不可见锚点
 *   `<a id="dsh-export-…"></a>`（不是注释，任何视图都不显示），不要再用 HTML 注释。
 */

/** 不可见锚点前缀（E2：需要文件内定位点时的唯一形式）。 */
export const ANCHOR_PREFIX = 'dsh-export-'

/** 预留的锚点名（当前 format 8 不写这些锚点，仅约定形式）。 */
export type AnchorName = 'toc-begin' | 'body-begin' | 'body-end'

/** 不可见锚点行文本：`<a id="dsh-export-toc-begin"></a>`。 */
export function anchorLine(name: AnchorName): string {
  return `<a id="${ANCHOR_PREFIX}${name}"></a>`
}

/**
 * 归一化换行：容忍用户在编辑器里把导出文件存成 CRLF。
 * 解析与切片统一按 LF 处理，重建后的文件也统一写成 LF。
 */
export function normalizeNewlines(content: string): string {
  return content.includes('\r\n') ? content.replace(/\r\n/g, '\n') : content
}

/** 轮次标题：`### 第 N 轮` 或 `### 第 N 轮：标题`。 */
export interface RoundHeading {
  no: number
  /** 行号（0 基）。 */
  line: number
  /** 标题正文（已去掉 Markdown 转义符；空串表示无标题）。 */
  title: string
}

/** 文档结构（未找到的位置为 -1）。 */
export interface DocumentLayout {
  lines: string[]
  /** `# 对话信息`。 */
  infoLine: number
  /** `## 目录`。 */
  tocLine: number
  /** `## 对话正文`。 */
  bodyLine: number
  /** `## 备注`。 */
  notesLine: number
  /** 正文区里出现的轮次标题（按出现顺序）。 */
  rounds: RoundHeading[]
}

interface FenceState {
  char: '`' | '~'
  len: number
}

/** 该行是否开启代码围栏（围栏内的内容一律不参与结构解析）。 */
function fenceOpen(line: string): FenceState | null {
  const m = /^ {0,3}(`{3,}|~{3,})/.exec(line)
  if (m === null) return null
  const marker = m[1] ?? ''
  const char = marker.slice(0, 1) as '`' | '~'
  // 反引号围栏的 info string 里不允许再出现反引号
  if (char === '`' && line.slice(m[0].length).includes('`')) return null
  return { char, len: marker.length }
}

/** 该行是否关闭当前围栏（同字符、长度不短于开启行、行内无其他内容）。 */
function fenceClose(line: string, state: FenceState): boolean {
  const re = new RegExp(`^ {0,3}\\${state.char}{${String(state.len)},}\\s*$`)
  return re.test(line)
}

/** 扫描文档结构（围栏感知）。 */
export function parseDocument(content: string): DocumentLayout {
  const lines = normalizeNewlines(content).split('\n')
  const layout: DocumentLayout = {
    lines,
    infoLine: -1,
    tocLine: -1,
    bodyLine: -1,
    notesLine: -1,
    rounds: [],
  }
  let fence: FenceState | null = null
  for (const [i, line] of lines.entries()) {
    if (fence !== null) {
      if (fenceClose(line, fence)) fence = null
      continue
    }
    const opened = fenceOpen(line)
    if (opened !== null) {
      fence = opened
      continue
    }
    if (layout.infoLine === -1 && line === '# 对话信息') {
      layout.infoLine = i
      continue
    }
    if (layout.tocLine === -1 && line.trim() === '## 目录') {
      layout.tocLine = i
      continue
    }
    if (layout.bodyLine === -1 && line.trim() === '## 对话正文') {
      layout.bodyLine = i
      continue
    }
    if (layout.notesLine === -1 && line.trim() === '## 备注') {
      layout.notesLine = i
      continue
    }
    const round = /^### 第 (\d+) 轮\s*(?:[：:]\s*(.*))?$/.exec(line)
    if (round !== null) {
      layout.rounds.push({
        no: Number(round[1]),
        line: i,
        title: (round[2] ?? '').replace(/\\/g, '').trim(),
      })
    }
  }
  // 轮次只认正文区内的标题（目录区不写 `###`，此处再兜一层）
  if (layout.bodyLine !== -1) {
    const end = layout.notesLine !== -1 ? layout.notesLine : lines.length
    layout.rounds = layout.rounds.filter((r) => r.line > layout.bodyLine && r.line < end)
  }
  return layout
}

/** 正文区（不含 `## 对话正文` 标题行与其后的空行）的行号区间。 */
export function bodyRange(layout: DocumentLayout): { start: number; end: number } | null {
  if (layout.bodyLine === -1) return null
  const end = layout.notesLine !== -1 ? layout.notesLine : layout.lines.length
  if (end <= layout.bodyLine) return null
  return { start: layout.bodyLine + 1, end }
}
