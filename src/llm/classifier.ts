/**
 * 双维度分类（轮次标题 + 两套分类标签）：
 * - 分批调用 LLM，每轮返回「动作式标题 + 每个维度一个模块序号」；
 * - 输入按字符截断以节省输入；
 * - 失败只影响该批：重试后仍失败才把该批各维度落到兜底模块，并记录原因；
 * - buildDesignStrategyPrompt 供「LLM 设计分类策略」使用（结果经 parseLlmStrategy 校验入库）。
 *
 * 标题由本调用生成（缺失时降级为问题截断）；概要不由 LLM 生成，
 * 概要直接从回答正文里的「概述/概括/摘要：」段提取。
 */

import type { ExportSegment, Strategy, StrategyDimension, Turn, Watermark } from '../core/types.js'
import { textOf } from '../core/reader.js'
import { contentToMd, splitLeadingSummary } from '../core/renderer.js'
import type { LlmClient, LlmMessage } from './client.js'

export const DEFAULT_CLASSIFY_MAX_CHARS = 2000
export const DESIGN_STRATEGY_SAMPLE_MAX_CHARS = 800
/** 轮次标题字数上限（模型生成；超出截断）。 */
export const TITLE_MAX_CHARS = 20
/** 标题降级时（模型没给标题）用问题原文截断，同样受上限约束。 */
export const FALLBACK_TITLE_MAX_CHARS = TITLE_MAX_CHARS
/** 每批轮次数：分批调用，避免单次请求过大导致传输层失败。 */
export const DEFAULT_CLASSIFY_BATCH_SIZE = 8
/** 每批最多尝试次数（含首次）。 */
export const CLASSIFY_MAX_ATTEMPTS = 3
/** 失败重试间隔基数（毫秒），按尝试次数线性退避。 */
const RETRY_BACKOFF_MS = 800
/** 提示词里每轮问题的截断长度。 */
const PROMPT_QUESTION_MAX_CHARS = 600

/** 按 Unicode 码点截断（避免截断代理对）。 */
export function truncateText(text: string, maxChars: number): string {
  const chars = Array.from(text)
  if (chars.length <= maxChars) return text
  return chars.slice(0, maxChars).join('') + '…'
}

/**
 * 标题归一化：折叠空白为单空格（多行会破坏标题行与目录项），并按**码点**截断。
 * 不能用 `String.slice`：它按 UTF-16 单元切，遇到 emoji 或 CJK 扩展 B 区汉字会切出孤立代理对，
 * 写盘时被编码成 U+FFFD（同文件 {@link truncateText} 已按码点处理，这里保持一致）。
 */
export function normalizeTitle(raw: string, maxLen: number): string {
  const one = raw.replace(/\s+/g, ' ').trim()
  const chars = Array.from(one)
  return chars.length <= maxLen ? one : chars.slice(0, maxLen).join('')
}

export interface ClassifyItem {
  key: string
  question: string
}

/** 组装批量分类提示词：每个维度一段带序号的词表 + JSON 输出约定。 */
export function buildClassificationPrompt(
  strategy: Strategy,
  items: readonly ClassifyItem[],
): LlmMessage[] {
  const dimensionBlocks = strategy.dimensions.map((d) => {
    const modules = d.modules
      .map((m, i) => {
        const desc = m.description !== undefined && m.description !== '' ? `：${m.description}` : ''
        const examples = m.examples !== undefined && m.examples.length > 0 ? `（如：${m.examples.join('、')}）` : ''
        return `  ${String(i + 1)}. ${m.name}${desc}${examples}`
      })
      .join('\n')
    return `【维度 ${d.id}：${d.name}】共 ${String(d.modules.length)} 个模块，用序号选择\n${modules}`
  }).join('\n\n')

  const dimensions = strategy.dimensions.map((d) => d.id)
  const example = `{"items":[{"key":"1","title":"对话规则添加：回答前复述问题","labels":{${dimensions.map((id) => `"${id}":1`).join(',')}}}]}`
  const system = [
    '你是对话归档助手。下面每个问答（条目）需要：①为它起一个标题；②同时归入每个维度的**一个**模块。',
    dimensionBlocks,
    `只输出 JSON：${example}，不要输出其他内容。`,
    'title 规则：',
    `- 不超过 ${String(TITLE_MAX_CHARS)} 个汉字，单行，结尾不加句号；`,
    '- 采用「动作 + 冒号 + 内容」写法，先写用户做了什么，再写内容，例如「对话规则添加：回答前复述问题」「规则修改：变更标记改为两处」「需求提出：对话按语义分段导出」；',
    '- 概括用户问题的主题，不要抄原句；不要以分类名（如「需求分析：」）开头。',
    '- 用户消息信息不足（例如只有一个数字或一句「继续」）时，依据你的回答内容判断本次在做什么，再起标题。',
    `labels 的键必须与维度 id 完全一致（${dimensions.join(' / ')}），值是模块序号（从 1 开始）。`,
    '确实无法归入任何模块时，该维度填对应维度兜底模块的序号。',
  ].join('\n')

  const userParts = items.map((it, i) => {
    const q = truncateText(it.question, PROMPT_QUESTION_MAX_CHARS)
    return `条目 ${String(i + 1)}（key=${it.key}）\n问题：${q}`
  })
  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n\n---\n\n') },
  ]
}

export interface ParsedClassifyItem {
  key: string
  /** 模型给出的轮次标题（已单行化+截断；缺失为空串）。 */
  title: string
  /** dimensionId → 模块序号（数字）或模块名（模型偶发改写）；缺失为 undefined。 */
  labels: Record<string, number | string | undefined>
}

/** 解析分类结果（容忍 ```json 围栏与裸 JSON；逐条容错，不让一个坏条目毁掉整批）。 */
export function parseClassification(
  text: unknown,
): { ok: true; items: ParsedClassifyItem[] } | { ok: false; error: string } {
  if (typeof text !== 'string') return { ok: false, error: '分类结果为空' }
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenceMatch !== null && fenceMatch[1] !== undefined ? fenceMatch[1] : text).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return { ok: false, error: '分类结果无法解析为 JSON' }
  }
  const rawItems = (parsed as { items?: unknown })?.items
  if (!Array.isArray(rawItems) || rawItems.length === 0) {
    return { ok: false, error: '分类结果缺少 items 数组' }
  }
  const items: ParsedClassifyItem[] = rawItems.map((it, i) => {
    const o = (typeof it === 'object' && it !== null ? it : {}) as Record<string, unknown>
    const rawLabels = (typeof o.labels === 'object' && o.labels !== null ? o.labels : {}) as Record<string, unknown>
    const labels: Record<string, number | string | undefined> = {}
    for (const [key, value] of Object.entries(rawLabels)) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        labels[key] = Math.trunc(value)
      } else if (typeof value === 'string') {
        const trimmed = value.trim()
        if (trimmed === '') labels[key] = undefined
        // 纯数字按序号；否则按「模块名」处理，交给 resolveLabel 做精确/归一化匹配
        else labels[key] = /^\d+$/.test(trimmed) ? Number(trimmed) : trimmed
      } else if (typeof value === 'object' && value !== null) {
        // 容忍 {"i":3} / {"index":3} / {"module":"编码实现"} 这类包装
        const wrapped = value as Record<string, unknown>
        const idx = wrapped.i ?? wrapped.index ?? wrapped.moduleIndex
        const name = wrapped.n ?? wrapped.name ?? wrapped.module
        if (typeof idx === 'number' && Number.isFinite(idx)) labels[key] = Math.trunc(idx)
        else if (typeof name === 'string' && name.trim() !== '') labels[key] = name.trim()
        else labels[key] = undefined
      } else {
        labels[key] = undefined
      }
    }
    const rawTitle = typeof o.title === 'string' ? o.title : ''
    return {
      key: typeof o.key === 'string' ? o.key.trim() : String(i),
      title: normalizeTitle(rawTitle, TITLE_MAX_CHARS),
      labels,
    }
  })
  return { ok: true, items }
}

/** 无 LLM 判定时的展示标题：问题原文单行截断（空则用轮次号）。 */
export function fallbackSegmentTitle(turn: Turn): string {
  const question = normalizeTitle(textOf(turn.user.map((m) => m.content).flat()), FALLBACK_TITLE_MAX_CHARS)
  return question !== '' ? question : `轮次 ${String(turn.turnNo)}`
}

/** 从回答正文提取概要（供「**概要**：」；找不到则空串 → 文档留空）。 */
export function summaryOfTurn(turn: Turn): string {
  const texts = turn.assistant.map((m) => contentToMd(m.content)).filter((t) => t !== '')
  return splitLeadingSummary(texts).summary
}

/** 单个维度的分类体检。 */
export interface DimensionReport {
  id: string
  name: string
  /** LLM 未返回该维度序号的条目数。 */
  missing: number
  /** 序号越界且名称无法匹配的条目数。 */
  unknown: number
  /** 对不上的名称/序号（去重、最多 5 个，供界面说明）。 */
  unmatched: string[]
}

/** 分类结果体检：让「降级为兜底模块」在界面上可见，而不是静默发生。 */
export interface ClassificationReport {
  /** ok = 全部条目按策略归类；fallback = 至少一条降级；skipped = 未分类兜底策略（未发请求）。 */
  status: 'ok' | 'fallback' | 'skipped'
  /** 失败或降级原因（status 为 fallback 时有值）。 */
  reason?: string
  dimensions: DimensionReport[]
  /** 本次分了几批。 */
  batches: number
  /** 重试后仍失败的批次数。 */
  failedBatches: number
  /** 实际发起的 LLM 调用次数（含重试）。 */
  calls: number
}

/** 分类产物 + 体检报告。 */
export interface ClassifyResult {
  segments: ExportSegment[]
  report: ClassificationReport
}

function emptyDimensionReport(d: StrategyDimension): DimensionReport {
  return { id: d.id, name: d.name, missing: 0, unknown: 0, unmatched: [] }
}

/** 宽松比较用的模块名归一：去空白与常见标点/后缀，容忍模型的轻微改写。 */
function normalizeModuleName(raw: string): string {
  return raw
    .replace(/[\s"'`「」【】\[\]（）()：:，,。.、·—-]+/g, '')
    .replace(/模块$/, '')
    .toLowerCase()
}

/**
 * 把某维度的返回值解析成模块名：序号优先，其次完全同名，最后归一化同名。
 * 都对不上返回 null（调用方按条降级）。
 */
export function resolveLabel(value: number | string | undefined, dimension: StrategyDimension): string | null {
  const { modules } = dimension
  if (typeof value === 'number') {
    return modules[value - 1]?.name ?? null
  }
  if (typeof value !== 'string' || value === '') return null
  const exact = modules.find((m) => m.name === value)
  if (exact !== undefined) return exact.name
  const wanted = normalizeModuleName(value)
  const loose = modules.find((m) => normalizeModuleName(m.name) === wanted)
  if (loose !== undefined) return loose.name
  // 模型可能返回「3. 编码实现」这类带序号的写法
  const prefixed = /^(\d+)\s*[.、:：]?\s*(.*)$/.exec(value)
  if (prefixed !== null) {
    const byIndex = modules[Number(prefixed[1]) - 1]
    if (byIndex !== undefined) return byIndex.name
    const rest = normalizeModuleName(prefixed[2] ?? '')
    const byName = modules.find((m) => normalizeModuleName(m.name) === rest)
    if (byName !== undefined) return byName.name
  }
  return null
}

function chunkTurns(turns: readonly Turn[], size: number): Turn[][] {
  const step = size > 0 ? size : DEFAULT_CLASSIFY_BATCH_SIZE
  const batches: Turn[][] = []
  for (let i = 0; i < turns.length; i += step) batches.push(turns.slice(i, i + step))
  return batches
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms) })
}

/**
 * 分批分类：每批一次 LLM 调用，批内失败按 {@link CLASSIFY_MAX_ATTEMPTS} 重试。
 * 失败只降级该批（各维度落到兜底模块），但**不吞掉原因**：哪一批失败、原因是什么，
 * 都随 {@link ClassificationReport} 返回给界面。
 * @param options.batchSize - 每批轮次数（默认 {@link DEFAULT_CLASSIFY_BATCH_SIZE}）。
 * @param options.retryBackoffMs - 传输类失败的重试间隔基数（测试可传 0）。
 */
export async function classifyIncrement(
  client: LlmClient,
  strategy: Strategy,
  turns: readonly Turn[],
  watermark: Watermark,
  options: { batchSize?: number; retryBackoffMs?: number } = {},
): Promise<ClassifyResult> {
  const backoff = options.retryBackoffMs ?? RETRY_BACKOFF_MS
  const batches = chunkTurns(turns, options.batchSize ?? DEFAULT_CLASSIFY_BATCH_SIZE)
  const mapping = new Map<string, {
    title: string
    labels: Record<string, number | string | undefined>
  }>()
  const failures: string[] = []
  let calls = 0

  for (const [batchIndex, batch] of batches.entries()) {
    const items: ClassifyItem[] = batch.map((t) => ({
      key: String(t.turnNo),
      question: textOf(t.user.map((m) => m.content).flat()),
    }))
    const messages = buildClassificationPrompt(strategy, items)
    let batchReason: string | undefined

    for (let attempt = 0; attempt < CLASSIFY_MAX_ATTEMPTS; attempt++) {
      calls++
      try {
        const resp = await client.complete({
          messages: attempt === 0
            ? messages
            : [...messages, {
                role: 'user',
                content: `上一次回复不是合法 JSON。请只输出：{"items":[{"key":"<条目key>","title":"<≤${String(TITLE_MAX_CHARS)}字的动作式标题>","labels":{${strategy.dimensions.map((d) => `"${d.id}":<序号>`).join(',')}}}]}`,
              }],
          json: true,
        })
        const parsed = parseClassification(resp.text)
        if (parsed.ok) {
          for (const x of parsed.items) mapping.set(x.key, { title: x.title, labels: x.labels })
          batchReason = undefined
          break
        }
        batchReason = parsed.error
      } catch (error) {
        batchReason = error instanceof Error ? error.message : String(error)
        if (attempt < CLASSIFY_MAX_ATTEMPTS - 1 && backoff > 0) await delay(backoff * (attempt + 1))
      }
    }

    if (batchReason !== undefined) {
      failures.push(`第 ${String(batchIndex + 1)}/${String(batches.length)} 批：${batchReason}`)
    }
  }

  const reports = strategy.dimensions.map(emptyDimensionReport)
  const segments = turns.map((t, i) => {
    const raw = mapping.get(String(t.turnNo))
    const labels: Record<string, string> = {}
    const value1 = raw?.labels
    strategy.dimensions.forEach((d, di) => {
      const report = reports[di]!
      const value = value1?.[d.id]
      if (value === undefined) {
        report.missing++
        labels[d.id] = d.defaultModule
        return
      }
      const resolved = resolveLabel(value, d)
      if (resolved !== null) {
        labels[d.id] = resolved
        return
      }
      report.unknown++
      const label = typeof value === 'number' ? `序号 ${String(value)}` : value
      if (!report.unmatched.includes(label) && report.unmatched.length < 5) report.unmatched.push(label)
      labels[d.id] = d.defaultModule
    })
    return {
      no: watermark.lastSegmentNo + i + 1,
      // 模型给的标题优先；没有则退回问题原文截断（两者同一字数上限）
      title: raw !== undefined && raw.title !== '' ? raw.title : fallbackSegmentTitle(t),
      labels,
      summary: summaryOfTurn(t),
      artifacts: [],
      changes: [],
      turn: t,
    }
  })

  const degraded = failures.length > 0 || reports.some((r) => r.missing > 0 || r.unknown > 0)
  const reason = failures.length > 0 ? failures.join('；') : undefined
  return {
    segments,
    report: {
      status: degraded ? 'fallback' : 'ok',
      ...(reason !== undefined ? { reason } : {}),
      dimensions: reports,
      batches: batches.length,
      failedBatches: failures.length,
      calls,
    },
  }
}

export interface DesignSample {
  question: string
  answer: string
}

/** 「与 LLM 对话设计分类策略」的系统提示词（多轮对话用；要求输出 dimensions 结构）。 */
export const STRATEGY_DESIGN_SYSTEM_PROMPT = [
  '你是对话归档的分类体系设计师。用户要把一段与 AI 的对话导出为 Markdown，需要两套分类维度来归档其中的问答。',
  '你的任务：通过对话了解用户想怎么归类（用途、关注点、粒度），据此设计维度与模块词表。',
  '',
  '工作方式：',
  '1. 先了解用途与关注点（1~2 个问题即可，不要过度追问）；用户已给足信息时直接给方案；',
  '2. 默认给两个维度（例如「开发阶段」与「对话功能/目的」），每维 3~10 个模块，模块名 2~8 字，并给出「判定说明」与 1~2 个「示例」；',
  '3. 每个维度都必须有一个兜底模块（例如「其他」），并把该维度的 defaultModule 指向它；',
  '4. 当方案确定（或用户说"就这个"）时，在回复末尾输出一个 ```json 代码块，内容严格为：',
  '   {"id":"<短id，字母数字连字符>","name":"<策略名>","dimensions":[{"id":"<维度id，字母>","name":"<维度名>","modules":[{"name":"<模块名>","description":"<判定说明>","examples":["<示例>"]}],"defaultModule":"<兜底模块名>"}],"source":"llm"}',
  '5. 其余回复用简洁中文，先说明设计理由，再给 JSON。',
].join('\n')

/** 「LLM 设计分类策略」提示词（单次批量版，保留给工具/测试使用）。 */
export function buildDesignStrategyPrompt(sample: readonly DesignSample[]): LlmMessage[] {
  const system = [
    '你是分类体系设计师。根据提供的对话样本，设计两套分类维度（每维 3~10 个模块）用于归档此会话的问答。',
    '输出 JSON：{"id":"<短id>","name":"<策略名>","dimensions":[{"id":"<维度id>","name":"<维度名>","modules":[{"name":"<模块名>","description":"<判定说明>","examples":["<示例>"]}],"defaultModule":"<兜底模块名>"}],"source":"llm"}，不要输出其他内容。',
    '模块名简短（≤8 字）；defaultModule 必须是同维度 modules 之一；每维都必须有兜底模块。',
  ].join('\n')
  const sampleText = sample
    .map((s, i) => {
      const q = truncateText(s.question, DESIGN_STRATEGY_SAMPLE_MAX_CHARS)
      const a = truncateText(s.answer, DESIGN_STRATEGY_SAMPLE_MAX_CHARS)
      return `样本 ${String(i + 1)}\n问题：${q}\n回答：${a}`
    })
    .join('\n\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: sampleText },
  ]
}
