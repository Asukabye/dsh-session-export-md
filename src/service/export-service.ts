/**
 * 导出编排服务（format=9，框架无关）：
 * - preview()：无副作用地计算导出计划（增量轮次、变更、双维分类、两套目录、产物），供 GUI 预览编辑；
 * - commit(plan, edits)：应用归类编辑后写入文件（增量追加 / 换策略整份重写）、更新水位；
 * - rebuild(plan, edits)：忽略水位按全量段重写；
 * - run(path?)：LLM 工具路径 = preview + commit（无新对话短路）。
 *
 * 集成阶段：本类作为 DSH 宿主服务与 export_conversation 工具处理器的共同实现。
 */

import { detectChanges } from '../core/change-detector.js'
import { collectIncrement, foldTurns } from '../core/reader.js'
import { extractArtifacts } from '../core/artifacts.js'
import {
  renderChangeLog,
  renderSegmentAnnotation,
  renderToc,
  slugify,
  type TocModuleEntries,
} from '../core/renderer.js'
import {
  DEFAULT_STRATEGY,
  parseLlmStrategy,
  StrategyStore,
  UNCLASSIFIED_STRATEGY_ID,
  validateStrategy,
} from '../core/strategies.js'
import type { ChangeRecord, ExportSegment, SessionEvent, Strategy, Turn, Watermark } from '../core/types.js'
import { appendExport, composeExport, isCurrentFormat, type SegmentAnnotation } from '../core/writer.js'
import { artifactsDirOf, planAttachments, renderAttachmentFile } from '../core/attachments.js'
import {
  classifyIncrement,
  fallbackSegmentTitle,
  STRATEGY_DESIGN_SYSTEM_PROMPT,
  summaryOfTurn,
  type ClassificationReport,
  type ClassifyResult,
} from '../llm/classifier.js'
import { LlmRouter, LocalLlmUnavailableError } from '../llm/client.js'
import { CategorizeStore, DEFAULT_MD_DIR, SessionPrefStore, WatermarkStore } from './persistence.js'

export interface SessionEventSource {
  events(): Promise<readonly SessionEvent[]>
}

/** 附件路径分隔符（`/` 在 Windows 上由 path.resolve 归一化）。 */
const SEP = '/'

/** 正文里的附件链接样式（`[[第3轮-产物|第3轮-产物.md]]`）。 */
const ARTIFACT_LINK = /\[\[第\d+轮-产物/

/** 附件目录名（`x.md` → `x.artifacts/`）。 */
function attachmentsDirName(file: string): string {
  const dir = artifactsDirOf(file)
  return `${dir.slice(Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')) + 1)}/`
}

/** 这批段里是否有产物（决定附件写失败时是否需要降级内联）。 */
function hasArtifacts(segments: readonly ExportSegment[]): boolean {
  return segments.some((s) => s.artifacts.length > 0)
}

export interface FsAdapter {
  readFile(path: string): Promise<string | null>
  writeFile(path: string, content: string): Promise<void>
}

export interface ExportSessionInfo {
  id: string
  title: string
  workspace?: string
  model?: string
  createdAtMs?: number
}

export interface ExportDeps {
  events: SessionEventSource
  fs: FsAdapter
  watermarks: WatermarkStore
  categorize: CategorizeStore
  prefs: SessionPrefStore
  strategies: StrategyStore
  router: LlmRouter
  session: ExportSessionInfo
  now(): number
  /** 分类调用参数（每批轮次、重试间隔）；默认每批 8 轮、退避 800ms（测试传 0 免等待）。 */
  classifyOptions?: { batchSize?: number; retryBackoffMs?: number }
}

export type ExportStatus =
  | {
      status: 'ok'
      file: string
      appendedSegments: number
      /** 轮次标题（模型生成的展示标题），供调用方转述。 */
      titles: string[]
      inProgress: boolean
      /** 本次为全量重建（文件曾缺失/损坏）。 */
      rebuilt?: boolean
      /** 本次为「换策略后按新策略重新分类」，整份文档被重写。 */
      reflowed?: boolean
    }
  | { status: 'no_new'; file: string; inProgress: boolean }
  | { status: 'error'; message: string }

export interface PreviewPlan {
  hasNew: boolean
  /** 文件缺失或不是当前格式：不能按增量追加，需要从会话历史全量重建。 */
  needsRebuild: boolean
  rebuildReason: 'missing' | 'broken' | null
  /** 重建时可导出的已完成轮次数。 */
  rebuildTurns: number
  /** 换了策略：整份文档按新策略重新分类并重写。 */
  reflow: boolean
  /** 本次预览的全量段是按所选策略重新分类的（显式选策略时即便走重建也为 true）。 */
  reclassify: boolean
  inProgress: boolean
  file: string
  strategy: Strategy
  /** 可选分类策略（内置默认 + 容器）与会话当前策略（供对话框选择）。 */
  strategies: { id: string; name: string; source: string }[]
  strategyId: string
  /** 策略维度（每维含模块名、兜底模块），供对话框逐维选择。 */
  dimensions: { id: string; name: string; modules: string[]; defaultModule: string }[]
  /** 本次分类的体检结果。 */
  classification: ClassificationReport
  segments: ExportSegment[]
  /** 两套目录条目（维度 → 模块 → 轮次）。 */
  toc: TocModuleEntries[]
  changes: ChangeRecord[]
  watermark: Watermark
  existing: string | null
}

/** 归类编辑：把某轮在若干维度上改成另一个模块（缺省的维度不变；空串 = 回该维兜底模块）。 */
export interface CategorizeEdit {
  no: number
  labels: Record<string, string>
}

export function defaultMdPath(session: ExportSessionInfo): string {
  const titlePart = slugify(session.title.trim() !== '' ? session.title : 'session') || 'session'
  return `${DEFAULT_MD_DIR}/${titlePart}-${session.id.slice(0, 8)}.md`
}

/** 可参与导出的完整轮次（已完成且问答成对）。 */
function exportableTurns(turns: readonly Turn[]): Turn[] {
  return turns.filter((t) => t.completed && t.user.length > 0 && t.assistant.length > 0)
}

/** 策略维度视图（供界面逐维选择）。 */
function dimensionViews(strategy: Strategy): PreviewPlan['dimensions'] {
  return strategy.dimensions.map((d) => ({
    id: d.id,
    name: d.name,
    modules: d.modules.map((m) => m.name),
    defaultModule: d.defaultModule,
  }))
}

/** 一轮在每维的兜底归属（无策略或分类失败时使用）。 */
function fallbackLabels(strategy: Strategy): Record<string, string> {
  const labels: Record<string, string> = {}
  for (const d of strategy.dimensions) labels[d.id] = d.defaultModule
  return labels
}

function emptyReport(strategy: Strategy, status: ClassificationReport['status']): ClassificationReport {
  return {
    status,
    dimensions: strategy.dimensions.map((d) => ({
      id: d.id,
      name: d.name,
      missing: 0,
      unknown: 0,
      unmatched: [],
    })),
    batches: 0,
    failedBatches: 0,
    calls: 0,
  }
}

/** 无策略时的直接归类（不调用 LLM）：各维度都落兜底模块。 */
function assignWithoutLlm(
  strategy: Strategy,
  turns: readonly Turn[],
  watermark: Watermark,
): ClassifyResult {
  return {
    segments: turns.map((turn, index) => ({
      no: watermark.lastSegmentNo + index + 1,
      title: fallbackSegmentTitle(turn),
      labels: fallbackLabels(strategy),
      summary: summaryOfTurn(turn),
      artifacts: extractArtifacts(turn),
      changes: [],
      turn,
    })),
    report: emptyReport(strategy, 'skipped'),
  }
}

/** 分类入口：「未分类」兜底策略不发 LLM 请求，其余走分批分类（内部自带降级 + 体检报告）。 */
async function classifyForStrategy(
  deps: ExportDeps,
  strategy: Strategy,
  turns: readonly Turn[],
  watermark: Watermark,
): Promise<ClassifyResult> {
  const result = strategy.id === UNCLASSIFIED_STRATEGY_ID
    ? assignWithoutLlm(strategy, turns, watermark)
    : await classifyIncrement(
        deps.router.clientFor('classify'),
        strategy,
        turns,
        watermark,
        deps.classifyOptions ?? {},
      )
  // 产物提取是纯本地规则，两条路径统一补上
  return {
    segments: result.segments.map((s) => ({ ...s, artifacts: extractArtifacts(s.turn) })),
    report: result.report,
  }
}

/**
 * 全量段（重建/换策略重排用）：编号按轮次顺序 1..N。
 * @param preferStored - true 复用已存归类（缺的才分类）；false 一律用新策略重新分类。
 *   用户在对话框里**显式选了策略**时必须为 false —— 否则重建会拿旧策略写下的归类
 *   覆盖新策略的分类结果（「选了策略还是全在兜底模块」的真正原因）。
 */
async function buildFullSegments(
  deps: ExportDeps,
  turns: readonly Turn[],
  strategy: Strategy,
  watermark: Watermark,
  preferStored: boolean,
): Promise<ClassifyResult> {
  if (turns.length === 0) return { segments: [], report: emptyReport(strategy, 'ok') }
  const stored = preferStored ? await deps.categorize.get() : {}
  const storedByTurn = new Map<number, { title: string; labels: Record<string, string> }>()
  for (const entry of Object.values(stored)) {
    storedByTurn.set(entry.turnNo, { title: entry.title ?? '', labels: entry.labels })
  }
  const classified = await classifyForStrategy(deps, strategy, turns, { ...watermark, lastSegmentNo: 0 })
  const segments = turns.map((turn, index) => {
    const kept = storedByTurn.get(turn.turnNo)
    const fresh = classified.segments[index]
    return {
      no: index + 1,
      // 已落库的标题优先（避免重建/重排时标题漂移），否则用本次分类结果
      title: kept?.title !== undefined && kept.title !== '' ? kept.title : (fresh?.title ?? fallbackSegmentTitle(turn)),
      labels: kept?.labels ?? fresh?.labels ?? fallbackLabels(strategy),
      summary: fresh?.summary ?? summaryOfTurn(turn),
      artifacts: fresh?.artifacts ?? extractArtifacts(turn),
      changes: [],
      turn,
    }
  })
  return { segments, report: classified.report }
}

/** 两套目录条目：按策略维度顺序 → 模块顺序 → 命中的轮次号（含策略外的历史模块名）。 */
export function tocEntriesOf(
  strategy: Strategy,
  entries: readonly { no: number; title?: string; labels: Record<string, string> }[],
): TocModuleEntries[] {
  const out: TocModuleEntries[] = []
  for (const d of strategy.dimensions) {
    const used = entries
      .map((e) => e.labels[d.id])
      .filter((v): v is string => v !== undefined && v !== '')
    const names = d.modules.map((m) => m.name)
    const extra = [...new Set(used.filter((n) => !names.includes(n)))]
    for (const name of [...names, ...extra]) {
      out.push({
        dimensionId: d.id,
        moduleName: name,
        turns: entries
          .filter((e) => (e.labels[d.id] ?? d.defaultModule) === name)
          .map((e) => ({ no: e.no, title: e.title ?? '' })),
      })
    }
  }
  return out
}

export async function buildPlan(
  deps: ExportDeps,
  pathOverride?: string,
  strategyIdOverride?: string,
): Promise<PreviewPlan> {
  const { events, fs, watermarks, categorize, prefs, strategies, session } = deps
  const pref = await prefs.get(defaultMdPath(session))
  const file = pathOverride !== undefined && pathOverride.trim() !== '' ? pathOverride.trim() : pref.mdPath
  const rawEvents = await events.events()
  const turns = foldTurns(rawEvents)

  const fallback: Watermark = {
    sessionId: session.id,
    lastTurnEndSeq: 0,
    lastTurnEndTime: 0,
    lastSegmentNo: 0,
    mdPath: file,
  }
  const watermark = (await watermarks.get()) ?? fallback
  watermark.mdPath = file

  const existing = await fs.readFile(file)
  const progressed = watermark.lastTurnEndSeq > 0 || watermark.lastSegmentNo > 0
  const missing = existing === null && progressed
  const broken = existing !== null && !isCurrentFormat(existing)
  const needsRebuild = missing || broken
  const rebuildReason: PreviewPlan['rebuildReason'] = missing ? 'missing' : broken ? 'broken' : null
  const rebuildTurns = needsRebuild ? exportableTurns(turns).length : 0

  const inc = collectIncrement(turns, watermark)
  // 策略：会话选中 → 容器第一个 → 内置标准研发流程 → 未分类技术兜底。
  const saved = await strategies.list()
  const requested = strategyIdOverride !== undefined && strategyIdOverride !== ''
    ? strategyIdOverride
    : pref.currentStrategyId
  const strategy =
    (requested !== '' ? await strategies.get(requested) : null)
    ?? saved[0]
    ?? DEFAULT_STRATEGY
  const strategiesList = [DEFAULT_STRATEGY, ...saved.filter((s) => s.id !== DEFAULT_STRATEGY.id)]
    .map((s) => ({ id: s.id, name: s.name, source: s.source }))
  // 用户在对话框里主动选了策略（而不是用会话记住的那个）：一律按该策略重新分类。
  const explicitStrategy = strategyIdOverride !== undefined && strategyIdOverride !== ''
  const strategyChanged = explicitStrategy && strategyIdOverride !== pref.currentStrategyId
  const reflow = !needsRebuild && existing !== null && strategyChanged
  const storedEntries = Object.entries(await categorize.get()).map(([no, e]) => ({
    no: Number(no),
    title: e.title ?? '',
    labels: e.labels,
  }))

  if (needsRebuild) {
    const full = await buildFullSegments(deps, exportableTurns(turns), strategy, watermark, !explicitStrategy)
    return {
      hasNew: full.segments.length > 0,
      needsRebuild: true,
      rebuildReason,
      rebuildTurns: full.segments.length,
      reflow: false,
      reclassify: explicitStrategy,
      inProgress: inc.inProgress,
      file,
      strategy,
      strategies: strategiesList,
      strategyId: strategy.id,
      dimensions: dimensionViews(strategy),
      classification: full.report,
      segments: full.segments,
      toc: tocEntriesOf(strategy, full.segments),
      changes: [],
      watermark,
      existing,
    }
  }

  if (reflow) {
    const full = await buildFullSegments(deps, exportableTurns(turns), strategy, watermark, false)
    return {
      hasNew: full.segments.length > 0,
      needsRebuild: false,
      rebuildReason: null,
      rebuildTurns: 0,
      reflow: true,
      reclassify: true,
      inProgress: inc.inProgress,
      file,
      strategy,
      strategies: strategiesList,
      strategyId: strategy.id,
      dimensions: dimensionViews(strategy),
      classification: full.report,
      segments: full.segments,
      toc: tocEntriesOf(strategy, full.segments),
      changes: [],
      watermark,
      existing,
    }
  }

  if (!inc.hasNew) {
    return {
      hasNew: false,
      needsRebuild: false,
      rebuildReason: null,
      rebuildTurns,
      reflow: false,
      reclassify: false,
      inProgress: inc.inProgress,
      file,
      strategy,
      strategies: strategiesList,
      strategyId: strategy.id,
      dimensions: dimensionViews(strategy),
      classification: emptyReport(strategy, 'skipped'),
      segments: [],
      toc: tocEntriesOf(strategy, storedEntries),
      changes: [],
      watermark,
      existing,
    }
  }

  const changes = detectChanges(rawEvents, watermark, turns)
  const classified = await classifyForStrategy(deps, strategy, inc.turns, watermark)
  const segments = classified.segments

  return {
    hasNew: true,
    needsRebuild: false,
    rebuildReason: null,
    rebuildTurns,
    reflow: false,
    reclassify: false,
    inProgress: inc.inProgress,
    file,
    strategy,
    strategies: strategiesList,
    strategyId: strategy.id,
    dimensions: dimensionViews(strategy),
    classification: classified.report,
    segments,
    toc: tocEntriesOf(strategy, [
      ...storedEntries,
      ...segments.map((s) => ({ no: s.no, title: s.title, labels: s.labels })),
    ]),
    changes,
    watermark,
    existing,
  }
}

/** 文档元信息（front matter 输入）。 */
function metaOf(deps: ExportDeps): {
  sessionId: string
  title: string
  workspace?: string
  createdAtMs?: number
  exportedAtMs: number
  model?: string
} {
  return {
    sessionId: deps.session.id,
    title: `对话导出：${deps.session.title}`,
    ...(deps.session.workspace !== undefined ? { workspace: deps.session.workspace } : {}),
    ...(deps.session.createdAtMs !== undefined ? { createdAtMs: deps.session.createdAtMs } : {}),
    exportedAtMs: deps.now(),
    ...(deps.session.model !== undefined ? { model: deps.session.model } : {}),
  }
}

export class ExportService {
  constructor(private readonly deps: ExportDeps) {}

  preview(pathOverride?: string, strategyId?: string): Promise<PreviewPlan> {
    return buildPlan(this.deps, pathOverride, strategyId)
  }

  /** 采用本次计划使用的策略作为会话当前策略（对话框切换策略后生效）。 */
  private async persistStrategy(strategyId: string): Promise<void> {
    const pref = await this.deps.prefs.get(defaultMdPath(this.deps.session))
    if (pref.currentStrategyId !== strategyId) {
      await this.deps.prefs.set({ ...pref, currentStrategyId: strategyId })
    }
  }

  /** 可选策略列表：内置默认 + 容器内容（容器为空也能直接导出）。 */
  async listStrategies(): Promise<Strategy[]> {
    const saved = await this.deps.strategies.list()
    return [DEFAULT_STRATEGY, ...saved.filter((s) => s.id !== DEFAULT_STRATEGY.id)]
  }

  /** 读取单个策略（策略管理里的编辑用）。 */
  async readStrategy(id: string): Promise<Strategy | null> {
    return this.deps.strategies.get(id)
  }

  /** 删除策略；若它正是本会话当前策略，一并清空指针。内置策略不可删。 */
  async deleteStrategy(id: string): Promise<{ ok: boolean; deleted: boolean }> {
    if (id === '' || id === UNCLASSIFIED_STRATEGY_ID) return { ok: false, deleted: false }
    const deleted = await this.deps.strategies.remove(id)
    const pref = await this.deps.prefs.get(defaultMdPath(this.deps.session))
    if (pref.currentStrategyId === id) {
      await this.deps.prefs.set({ ...pref, currentStrategyId: '' })
    }
    return { ok: true, deleted }
  }

  /**
   * 与 LLM 对话设计分类策略：把历史消息 + 设计系统提示词交给 designStrategy 槽位的模型，
   * 返回回复正文；若回复里含合法策略 JSON，则一并解析出来（供「保存策略」使用）。
   */
  async chatStrategy(
    messages: readonly { role: 'user' | 'assistant'; content: string }[],
  ): Promise<{ reply: string; strategy: Strategy | null }> {
    const client = this.deps.router.clientFor('designStrategy')
    const response = await client.complete({
      messages: [
        { role: 'system', content: STRATEGY_DESIGN_SYSTEM_PROMPT },
        ...messages.map((m) => ({ role: m.role, content: m.content })),
      ],
    })
    const parsed = parseLlmStrategy(response.text)
    return { reply: response.text, strategy: parsed.ok ? (parsed.strategy ?? null) : null }
  }

  /**
   * 保存分类策略入容器（覆盖同 id）：接受对象或 JSON 文本，
   * 覆盖「设计对话产出 / 手动新建 / 手动编辑 / JSON 导入」四条路径。
   */
  async saveStrategy(
    strategy: unknown,
    options: { source?: 'llm' | 'imported' | 'builtin' } = {},
  ): Promise<{ ok: boolean; id?: string; name?: string; errors: string[] }> {
    let parsed: unknown = strategy
    if (typeof strategy === 'string') {
      try {
        parsed = JSON.parse(strategy)
      } catch {
        return { ok: false, errors: ['无法解析为 JSON'] }
      }
    }
    const validated = validateStrategy(parsed)
    if (!validated.ok || validated.strategy === undefined) {
      return { ok: false, errors: validated.errors }
    }
    const next: Strategy = options.source !== undefined
      ? { ...validated.strategy, source: options.source }
      : validated.strategy
    const saved = await this.deps.strategies.put(next)
    return saved.ok
      ? { ok: true, id: saved.strategy!.id, name: saved.strategy!.name, errors: [] }
      : { ok: false, errors: saved.errors }
  }

  /** 把某策略设为该会话当前策略。 */
  async selectStrategy(strategyId: string): Promise<void> {
    await this.persistStrategy(strategyId)
  }

  /** 应用归类编辑（未知模块名回落到该维兜底模块；缺省的维度不变）。 */
  private applyEdits(
    strategy: Strategy,
    segments: readonly ExportSegment[],
    edits: readonly CategorizeEdit[],
  ): ExportSegment[] {
    const byNo = new Map(edits.map((e) => [e.no, e.labels]))
    return segments.map((segment) => {
      const edit = byNo.get(segment.no)
      if (edit === undefined) return segment
      const labels: Record<string, string> = { ...segment.labels }
      for (const d of strategy.dimensions) {
        const wanted = edit[d.id]
        if (wanted === undefined) continue
        labels[d.id] = wanted === '' || !d.modules.some((m) => m.name === wanted)
          ? d.defaultModule
          : wanted
      }
      return { ...segment, labels }
    })
  }

  async commit(plan: PreviewPlan, edits: readonly CategorizeEdit[] = []): Promise<ExportStatus> {
    const deps = this.deps
    // 换策略重排 = 整份文档按新策略重写：与重建同一条写入路径。
    if (plan.reflow) {
      const result = await this.rebuild(plan, edits)
      return result.status === 'ok' ? { ...result, rebuilt: false, reflowed: true } : result
    }
    if (!plan.hasNew) return { status: 'no_new', file: plan.file, inProgress: plan.inProgress }

    const strategy = plan.strategy
    const segments = this.applyEdits(strategy, plan.segments, edits)

    const catMap = await deps.categorize.get()
    for (const s of segments) {
      catMap[String(s.no)] = { title: s.title, labels: s.labels, turnNo: s.turn.turnNo }
    }
    await deps.categorize.set(catMap)

    const allEntries = Object.entries(catMap).map(([no, e]) => ({ no: Number(no), title: e.title, labels: e.labels }))
    const roundsByTurn = new Map<number, number>()
    for (const [noStr, e] of Object.entries(catMap)) roundsByTurn.set(e.turnNo, Number(noStr))

    const changesByTurn = new Map<number, ChangeRecord[]>()
    for (const c of plan.changes) {
      if (c.turnNo === undefined) continue
      const list = changesByTurn.get(c.turnNo) ?? []
      list.push(c)
      changesByTurn.set(c.turnNo, list)
    }
    const annotations: SegmentAnnotation[] = []
    for (const [turnNo, recs] of changesByTurn) {
      const no = roundsByTurn.get(turnNo)
      if (no === undefined) continue
      const ann = renderSegmentAnnotation(recs)
      if (ann !== '') annotations.push({ no, annotation: ann })
    }
    const changeLog = plan.changes.length > 0
      ? renderChangeLog(plan.changes, roundsByTurn, deps.now())
      : undefined

    let newContent: string
    let newWatermark: Watermark
    // 产物附件：先写附件，写成功才在正文里放链接；失败则降级为内联产物
    const attachments = await this.writeAttachments(plan.file, segments, deps)
    // 增量本身可能没有产物，但文档里已有历史附件链接 → 备注仍要写上附件目录
    const linkedAlready = plan.existing !== null && ARTIFACT_LINK.test(plan.existing)
    const attachmentsDir = attachments !== null
      ? attachments.dir
      : (linkedAlready ? attachmentsDirName(plan.file) : undefined)
    const degrade = attachments === null && hasArtifacts(segments)
    if (plan.existing === null) {
      newContent = composeExport({
        meta: metaOf(deps),
        strategy,
        segments,
        toc: tocEntriesOf(strategy, allEntries),
        changeLog: plan.changes,
        ...(attachmentsDir === undefined ? {} : { attachmentsDir }),
        ...(degrade ? { inlineArtifacts: true } : {}),
      })
      newWatermark = {
        ...plan.watermark,
        mdPath: plan.file,
        lastTurnEndSeq: Math.max(plan.watermark.lastTurnEndSeq, ...segments.map((s) => s.turn.endSeq)),
        lastSegmentNo: Math.max(plan.watermark.lastSegmentNo, ...segments.map((s) => s.no)),
      }
    } else {
      const res = appendExport({
        existing: plan.existing,
        meta: metaOf(deps),
        strategy,
        segments,
        toc: renderToc(strategy, tocEntriesOf(strategy, allEntries)),
        watermark: plan.watermark,
        appendedSegments: segments.length,
        appendedTurns: segments.map((s) => s.turn),
        allSegments: allEntries,
        segmentAnnotations: annotations,
        ...(attachmentsDir === undefined ? {} : { attachmentsDir }),
        ...(degrade ? { inlineArtifacts: true } : {}),
        ...(changeLog !== undefined ? { changeLog } : {}),
      })
      if (res === null) {
        return {
          status: 'error',
          message: '导出文件不是当前格式（结构标题不齐或版本落后），无法安全追加；请用「重建完整对话」重写',
        }
      }
      newContent = res.newContent
      newWatermark = { ...res.newWatermark, mdPath: plan.file }
    }

    await deps.fs.writeFile(plan.file, newContent)
    await deps.watermarks.set(newWatermark)
    await this.persistStrategy(plan.strategyId)
    const pref = await deps.prefs.get(defaultMdPath(deps.session))
    if (pref.mdPath !== plan.file) await deps.prefs.set({ ...pref, mdPath: plan.file })
    return {
      status: 'ok',
      file: plan.file,
      appendedSegments: segments.length,
      titles: segments.map((s) => s.title),
      inProgress: plan.inProgress,
    }
  }

  /** 全量重建：忽略水位，用计划里的全量段（编号 1..N，含预览期编辑）重写整个文档。 */
  async rebuild(plan: PreviewPlan, edits: readonly CategorizeEdit[] = []): Promise<ExportStatus> {
    const deps = this.deps
    if (plan.segments.length === 0) {
      return { status: 'no_new', file: plan.file, inProgress: plan.inProgress }
    }
    const strategy = plan.strategy
    const segments = this.applyEdits(strategy, plan.segments, edits)

    const nextCategorize: Record<string, { title: string; labels: Record<string, string>; turnNo: number }> = {}
    for (const s of segments) {
      nextCategorize[String(s.no)] = { title: s.title, labels: s.labels, turnNo: s.turn.turnNo }
    }
    await deps.categorize.set(nextCategorize)

    // 产物附件：先写附件，再写正文（写失败降级为内联产物）
    const attachments = await this.writeAttachments(plan.file, segments, deps)
    const content = composeExport({
      meta: metaOf(deps),
      strategy,
      segments,
      toc: tocEntriesOf(strategy, segments),
      includeChangeLog: false,
      ...(attachments === null ? {} : { attachmentsDir: attachments.dir }),
      ...(attachments === null && hasArtifacts(segments) ? { inlineArtifacts: true } : {}),
    })
    await deps.fs.writeFile(plan.file, content)
    await deps.watermarks.set({
      sessionId: deps.session.id,
      lastTurnEndSeq: Math.max(...segments.map((s) => s.turn.endSeq)),
      lastTurnEndTime: Math.max(...segments.map((s) => s.turn.endTime)),
      lastSegmentNo: segments.length,
      mdPath: plan.file,
    })
    const pref = await deps.prefs.get(defaultMdPath(deps.session))
    if (pref.mdPath !== plan.file) await deps.prefs.set({ ...pref, mdPath: plan.file })
    await this.persistStrategy(plan.strategyId)
    return {
      status: 'ok',
      file: plan.file,
      appendedSegments: segments.length,
      titles: segments.map((s) => s.title),
      inProgress: plan.inProgress,
      rebuilt: true,
    }
  }

  /**
   * 写各轮产物附件（`<导出基名>.artifacts/第N轮-产物.md`）。
   * 失败时返回 null，由调用方把正文降级为内联产物（不让导出整体失败）。
   * @returns 附件目录名（`xxx.artifacts/`，无产物时为 null）。
   */
  private async writeAttachments(
    file: string,
    segments: readonly ExportSegment[],
    deps: ExportDeps,
  ): Promise<{ dir: string; count: number } | null> {
    const dir = artifactsDirOf(file)
    const name = attachmentsDirName(file).replace(/\/$/, '')
    const iso = new Date(deps.now()).toISOString()
    const exportedAt = `${iso.slice(0, 10)} ${iso.slice(11, 16)}`
    let count = 0
    try {
      for (const segment of segments) {
        for (const plan of planAttachments(segment.no, segment.artifacts)) {
          const content = renderAttachmentFile(
            { sourcePath: file, roundNo: segment.no, roundTitle: segment.title, exportedAt },
            plan,
          )
          await deps.fs.writeFile(`${dir}${SEP}${plan.fileName}`, content)
          count += 1
        }
      }
    } catch {
      return null
    }
    return count === 0 ? null : { dir: `${name}/`, count }
  }

/** 工具路径：preview + commit（无新对话短路；文件缺失/换策略时走重建）。 */
  async run(pathOverride?: string): Promise<ExportStatus> {
    const plan = await buildPlan(this.deps, pathOverride)
    if (plan.needsRebuild || plan.reflow) {
      const result = await this.rebuild(plan)
      if (result.status !== 'ok') return result
      return plan.reflow
        ? { ...result, rebuilt: false, reflowed: true }
        : result
    }
    return this.commit(plan)
  }
}

export { LocalLlmUnavailableError }
