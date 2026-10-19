/**
 * 产物提取（format=5 起，**纯本地规则、不调用模型**）：
 * 从一轮内的工具调用（`tool/call`）与交付事件（`deliverables/presented`）中，
 * 归纳出该轮产生的代码/测试/命令/文档/图表/决策/提示词/数据/报告/链接/附件。
 *
 * 只提取“引用”（路径、命令、URL），不导出工具调用的参数载荷——与
 * 「不导出工具调用/结果」的既有规则一致。
 */

import type { ArtifactItem, ArtifactKind, ToolCallRecord, Turn } from './types.js'

/** 产物在文档中的固定展示顺序。 */
export const ARTIFACT_ORDER: readonly ArtifactKind[] = [
  '代码',
  '测试',
  '命令',
  '文档',
  '图表',
  '决策',
  '提示词',
  '数据',
  '报告',
  '链接',
  '附件',
]

/** 每个类别的条数上限（超出截断，避免单轮产物刷屏）。 */
export const MAX_PER_KIND = 12
/** 单个类别的值长度上限（命令尤其长）。 */
const MAX_VALUE_CHARS = 240
/** 命令只保留首行并截断。 */
const MAX_COMMAND_CHARS = 240

/** 会产生产物的工具。其它工具（读取、状态、交互类）一律忽略。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'apply_patch'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'shell', 'powershell'])
const WEB_TOOLS = new Set(['web_search', 'web_fetch'])
const PRESENT_TOOLS = new Set(['present'])

/** 噪声路径片段：出现在产物里没有价值。 */
const NOISE_SEGMENTS = ['node_modules/', '/.git/', '/.pnpm/', '/.venv/', '/__pycache__/']

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').trim()
}

function isNoise(path: string): boolean {
  const lower = `/${path.toLowerCase()}`
  return NOISE_SEGMENTS.some((seg) => lower.includes(seg))
}

/** 按路径判定产物类别（目录约定优先于扩展名）。 */
export function classifyArtifactPath(rawPath: string): ArtifactKind {
  const path = normalizePath(rawPath).toLowerCase()
  if (/(^|\/)(adr|decisions?)\//.test(path) || /(^|\/)adr[-_]/.test(path)) return '决策'
  if (/(^|\/)prompts?\//.test(path)) return '提示词'
  if (/(^|\/)(diagrams?|charts?)\//.test(path) || /\.(mmd|drawio|puml|dot)$/.test(path)) return '图表'
  if (/(^|\/)tests?\//.test(path) || /(^|\/)test_[^/]*$/.test(path) || /\.(test|spec)\.[a-z0-9]+$/.test(path)) {
    return '测试'
  }
  if (/(^|\/)reports?\//.test(path) || /\.html?$/.test(path)) return '报告'
  if (/\.(json|jsonl|csv|tsv|xlsx?|parquet|yaml|yml|toml)$/.test(path)) return '数据'
  if (/\.(md|mdx|txt|rst|adoc)$/.test(path)) return '文档'
  if (/\.(png|jpe?g|gif|webp|svg|bmp|pdf|zip|tar|gz|xz)$/.test(path)) return '附件'
  return '代码'
}

function truncateValue(value: string, max = MAX_VALUE_CHARS): string {
  const one = value.replace(/\s+/g, ' ').trim()
  return one.length <= max ? one : `${one.slice(0, max)}…`
}

/** 命令取首行（去掉换行与多余空白）。 */
function commandOf(raw: string): string {
  const first = raw.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).find((l) => l !== '') ?? ''
  return truncateValue(first, MAX_COMMAND_CHARS)
}

/** 安全解析工具参数（JSON 字符串）。 */
function parseArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function firstString(o: Record<string, unknown>, keys: readonly string[]): string {
  for (const k of keys) {
    const v = o[k]
    if (typeof v === 'string' && v.trim() !== '') return v.trim()
  }
  return ''
}

/** 从一次工具调用提取产物（返回 0..n 条）。 */
export function artifactsOfToolCall(call: ToolCallRecord): ArtifactItem[] {
  const args = parseArguments(call.arguments)
  const name = call.name.toLowerCase()
  if (WRITE_TOOLS.has(name)) {
    const path = firstString(args, ['file_path', 'path', 'filePath', 'filename'])
    if (path === '') return []
    const normalized = normalizePath(path)
    if (isNoise(normalized)) return []
    return [{ kind: classifyArtifactPath(normalized), value: normalized }]
  }
  if (SHELL_TOOLS.has(name)) {
    const command = firstString(args, ['command', 'script', 'cmd'])
    if (command === '') return []
    const one = commandOf(command)
    return one === '' ? [] : [{ kind: '命令', value: one }]
  }
  if (WEB_TOOLS.has(name)) {
    const url = firstString(args, ['url', 'query', 'uri'])
    if (url === '' || !/^https?:\/\//i.test(url)) return []
    return [{ kind: '链接', value: url }]
  }
  if (PRESENT_TOOLS.has(name)) {
    const files = args.files
    if (!Array.isArray(files)) return []
    const out: ArtifactItem[] = []
    for (const f of files) {
      const o = (typeof f === 'object' && f !== null ? f : {}) as Record<string, unknown>
      const path = firstString(o, ['path', 'file', 'file_path'])
      if (path === '') continue
      const normalized = normalizePath(path)
      if (isNoise(normalized)) continue
      const kind = classifyArtifactPath(normalized)
      out.push({ kind: kind === '代码' ? '附件' : kind, value: normalized })
    }
    return out
  }
  return []
}

/** 提取一轮的全部产物：交付事件 + 工具调用，按类别去重并限量。 */
export function extractArtifacts(turn: Pick<Turn, 'toolCalls' | 'deliverables'>): ArtifactItem[] {
  const collected: ArtifactItem[] = []
  for (const d of turn.deliverables) {
    const value = normalizePath(d.path)
    if (value === '' || isNoise(value)) continue
    collected.push({ kind: '附件', value })
  }
  for (const call of turn.toolCalls) collected.push(...artifactsOfToolCall(call))

  const seen = new Set<string>()
  const perKind = new Map<ArtifactKind, number>()
  const out: ArtifactItem[] = []
  // 先按固定类别顺序，再按出现顺序
  for (const kind of ARTIFACT_ORDER) {
    for (const item of collected) {
      if (item.kind !== kind) continue
      const dedupeKey = `${item.kind}\u0000${item.value}`
      if (seen.has(dedupeKey)) continue
      const count = perKind.get(kind) ?? 0
      if (count >= MAX_PER_KIND) continue
      seen.add(dedupeKey)
      perKind.set(kind, count + 1)
      out.push(item)
    }
  }
  return out
}
