/** Browser export state shared by the Session Header contribution and its dialog. */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Export dialog phases. */
export type ExportPhase =
  | 'idle'
  | 'previewing'
  | 'ready'
  | 'committing'
  | 'done'
  | 'no_new'
  | 'error'

/** One numbered segment shown in the preview list. */
export interface SegmentView {
  readonly no: number
  /** 轮次标题（模型生成的展示标题；界面显示用）。 */
  readonly title: string
  /** dimensionId → 模块名。 */
  readonly labels: Record<string, string>
  /** 从回答提取的概要（空 = 文档留空）。 */
  readonly summary: string
}

/** 一个分类维度的视图（id/名称/模块表/兜底模块）。 */
export interface DimensionView {
  readonly id: string
  readonly name: string
  readonly modules: readonly string[]
  readonly defaultModule: string
}

/** 单个维度的分类体检。 */
export interface DimensionReportView {
  readonly id: string
  readonly name: string
  readonly missing: number
  readonly unknown: number
  readonly unmatched: readonly string[]
}

/** 本次分类的体检结果：界面据此说明「为什么都进了兜底模块」。 */
export interface ClassificationView {
  readonly status: 'ok' | 'fallback' | 'skipped'
  readonly reason: string | null
  readonly dimensions: readonly DimensionReportView[]
}

/** 策略编辑器里的模块草稿（示例用换行/逗号分隔的纯文本）。 */
export interface StrategyModuleDraft {
  readonly name: string
  readonly description: string
  readonly examples: string
}

/** 策略编辑器里的维度草稿。 */
export interface StrategyDimensionDraft {
  readonly id: string
  readonly name: string
  readonly defaultModule: string
  readonly modules: readonly StrategyModuleDraft[]
}

/** 策略管理里的策略草稿（新建与编辑共用）。 */
export interface StrategyDraft {
  readonly id: string
  readonly name: string
  readonly dimensions: readonly StrategyDimensionDraft[]
  /** true = 容器里已存在（编辑并覆盖），false = 新建。 */
  readonly existing: boolean
}

/** 策略列表条目（含完整维度，供编辑与手动导入后查看）。 */
export interface StrategyView {
  readonly id: string
  readonly name: string
  readonly source: string
  readonly dimensions: readonly StrategyDimensionDraft[]
  /** 内置策略（可选、不可删、不可覆盖）。 */
  readonly builtin: boolean
}

/** 策略管理里的操作回执（文案由对话框本地化）。 */
export interface ManageNotice {
  readonly kind: 'saved' | 'imported' | 'deleted' | 'notFound'
  readonly name?: string
}

/** 目录条目（服务端 PreviewPlan.toc 的客户端视图）。 */
export interface TocModuleView {
  readonly dimensionId: string
  readonly moduleName: string
  readonly turns: readonly { readonly no: number; readonly title: string }[]
}

/** One Session's export-dialog state. */
export interface ExportEntry {
  readonly open: boolean
  readonly phase: ExportPhase
  readonly file: string | null
  readonly segments: readonly SegmentView[]
  /** 策略维度（逐维下拉用）。 */
  readonly dimensions: readonly DimensionView[]
  /** 服务端算好的目录条目（维度 → 模块 → 轮次），与导出文件同源。 */
  readonly toc: readonly TocModuleView[]
  readonly appended: number
  readonly inProgress: boolean
  readonly error: string | null
  readonly pathDraft: string
  /** 目标文件缺失或锚点损坏：对话框改为给出"重建完整对话"入口。 */
  readonly needsRebuild: boolean
  readonly rebuildReason: 'missing' | 'broken' | null
  /** 重建时可导出的已完成轮次数。 */
  readonly rebuildTurns: number
  /** 上一次成功写入是全量重建（用于结果文案）。 */
  readonly rebuilt: boolean
  /** 换了策略：整份文档会按新策略重新分类并重写。 */
  readonly reflow: boolean
  /** 本次预览的全量段是按所选策略重新分类的（显式选策略时即便走重建也为 true）。 */
  readonly reclassify: boolean
  /** 上一次成功写入是换策略重排（用于结果文案）。 */
  readonly reflowed: boolean
  /** 本次分类是否降级（原因、降级条目数）。 */
  readonly classification: ClassificationView | null
  /** 可选分类策略与会话当前策略（设置区选择器）。 */
  readonly strategies: readonly { readonly id: string; readonly name: string }[]
  readonly strategyId: string
  /** 策略设计对话（与 LLM 沟通生成分类策略）。 */
  readonly chatOpen: boolean
  readonly chatMessages: readonly { readonly role: 'user' | 'assistant'; readonly content: string }[]
  readonly chatBusy: boolean
  readonly chatStrategy: unknown
  readonly chatError: string | null
  /** 策略管理（删除/新建/导入/编辑）。 */
  readonly manageOpen: boolean
  readonly manageBusy: boolean
  readonly manageError: string | null
  readonly manageNotice: ManageNotice | null
  readonly manageList: readonly StrategyView[]
  readonly draft: StrategyDraft | null
  readonly importOpen: boolean
  readonly importText: string
}

/** Export states keyed by the Session whose Header owns the dialog. */
export interface SessionExportState {
  readonly bySession: Record<string, ExportEntry | undefined>
}

const EMPTY_ENTRY: ExportEntry = {
  open: false,
  phase: 'idle',
  file: null,
  segments: [],
  dimensions: [],
  toc: [],
  appended: 0,
  inProgress: false,
  error: null,
  pathDraft: '',
  needsRebuild: false,
  rebuildReason: null,
  rebuildTurns: 0,
  rebuilt: false,
  reflow: false,
  reclassify: false,
  reflowed: false,
  classification: null,
  strategies: [],
  strategyId: '',
  chatOpen: false,
  chatMessages: [],
  chatBusy: false,
  chatStrategy: null,
  chatError: null,
  manageOpen: false,
  manageBusy: false,
  manageError: null,
  manageNotice: null,
  manageList: [],
  draft: null,
  importOpen: false,
  importText: '',
}

const INITIAL: SessionExportState = { bySession: {} }

/** Host route registered by the same package's host half. */
const ROUTE = '/api/session.export-md'

interface HostPlan {
  readonly hasNew?: boolean
  readonly inProgress?: boolean
  readonly file?: string
  readonly needsRebuild?: boolean
  readonly rebuildReason?: 'missing' | 'broken' | null
  readonly rebuildTurns?: number
  readonly reflow?: boolean
  /** 本次预览的全量段是否按所选策略重新分类。 */
  readonly reclassify?: boolean
  readonly classification?: {
    readonly status?: 'ok' | 'fallback' | 'skipped'
    readonly reason?: string
    readonly dimensions?: readonly {
      readonly id?: string
      readonly name?: string
      readonly missing?: number
      readonly unknown?: number
      readonly unmatched?: readonly string[]
    }[]
  }
  readonly strategies?: readonly { readonly id?: string; readonly name?: string }[]
  readonly strategyId?: string
  /** 策略维度（id/名称/模块名/兜底模块）。 */
  readonly dimensions?: readonly {
    readonly id?: string
    readonly name?: string
    readonly modules?: readonly string[]
    readonly defaultModule?: string
  }[]
  readonly segments?: readonly {
    readonly no?: number
    readonly title?: string
    readonly labels?: Record<string, string>
    readonly summary?: string
  }[]
  /** 目录条目（维度 → 模块 → 轮次），服务端已算好。 */
  readonly toc?: readonly {
    readonly dimensionId?: string
    readonly moduleName?: string
    readonly turns?: readonly { readonly no?: number; readonly title?: string }[]
  }[]
}

/** 容器里的策略原文（strategy-list 返回）。 */
interface HostStrategy {
  readonly id?: string
  readonly name?: string
  readonly source?: string
  readonly dimensions?: readonly {
    readonly id?: string
    readonly name?: string
    readonly defaultModule?: string
    readonly modules?: readonly {
      readonly name?: string
      readonly description?: string
      readonly examples?: readonly string[]
    }[]
  }[]
}

interface HostStatus {
  readonly status?: 'ok' | 'no_new' | 'error'
  readonly file?: string
  readonly appendedSegments?: number
  readonly message?: string
  readonly inProgress?: boolean
  readonly rebuilt?: boolean
  readonly reflowed?: boolean
}

interface HostSaveResult {
  readonly ok?: boolean
  readonly id?: string
  readonly name?: string
  readonly errors?: readonly string[]
  readonly deleted?: boolean
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 宿主策略原文 → 列表/编辑器视图（示例数组并回文本行）。 */
function toStrategyView(strategy: HostStrategy): StrategyView {
  const dimensions = (strategy.dimensions ?? []).map((d) => {
    const modules = (d.modules ?? []).map((m) => ({
      name: m.name ?? '',
      description: m.description ?? '',
      examples: (m.examples ?? []).join('、'),
    }))
    return {
      id: d.id ?? '',
      name: d.name ?? '',
      defaultModule: d.defaultModule ?? (modules[0]?.name ?? ''),
      modules,
    }
  })
  return {
    id: strategy.id ?? '',
    name: strategy.name ?? '',
    source: strategy.source ?? 'imported',
    dimensions,
    builtin: strategy.source === 'builtin',
  }
}

/** Owns preview/commit calls and publishes the dialog state for one Session at a time. */
export class SessionExportController {
  /** uSES-safe state source shared by the Header contribution and the dialog. */
  readonly store: SnapshotStore<SessionExportState> = createSnapshotStore(INITIAL)

  /**
   * @param fetcher - HTTP carrier for the host route (same-origin).
   * @param options.pickDirectory - 宿主目录选择器（打开系统选择框）；缺省表示该部署没有原生能力。
   */
  constructor(
    private readonly fetcher: Fetcher = (input, init) => fetch(input, init),
    private readonly options: { pickDirectory?: () => Promise<string | null> } = {},
  ) {}

  /**
   * 打开系统目录选择框，把选中的目录与当前文件名拼成新的导出路径。
   * 记不住文件名时用默认名（会话导出-<会话短 id>.md）。用户取消则不动。
   */
  async chooseDirectory(sessionId: SessionId): Promise<void> {
    const pick = this.options.pickDirectory
    if (pick === undefined) return
    try {
      const dir = await pick()
      if (dir === null || dir === '') return
      const current = this.entryOf(sessionId).pathDraft.trim()
      const currentName = current.split(/[\\/]/).filter((s) => s !== '').pop() ?? ''
      const name = currentName !== '' && currentName.endsWith('.md')
        ? currentName
        : `session-${String(sessionId).replace(/^session-/, '').slice(0, 8)}.md`
      const base = dir.replace(/[\\/]+$/, '')
      const sep = base.includes('\\') ? '\\' : '/'
      this.patch(sessionId, { pathDraft: `${base}${sep}${name}`, error: null })
    } catch (error) {
      this.patch(sessionId, { error: messageOf(error) })
    }
  }

  private entryOf(sessionId: SessionId): ExportEntry {
    return this.store.getSnapshot().bySession[String(sessionId)] ?? EMPTY_ENTRY
  }

  private patch(sessionId: SessionId, patch: Partial<ExportEntry>): void {
    const key = String(sessionId)
    const state = this.store.getSnapshot()
    const current = state.bySession[key] ?? EMPTY_ENTRY
    this.store.set({ bySession: { ...state.bySession, [key]: { ...current, ...patch } } })
  }

  private url(sessionId: SessionId): string {
    return `${ROUTE}?sessionId=${encodeURIComponent(String(sessionId))}`
  }

  private call(sessionId: SessionId, body: Record<string, unknown>): Promise<Response> {
    return this.fetcher(this.url(sessionId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  }

  /** HTTP failure text for the dialog; an empty body still names the status. */
  private async failureOf(response: Response): Promise<string> {
    const detail = (await response.text().catch(() => '')).trim()
    return detail !== '' ? `HTTP ${response.status} · ${detail}` : `HTTP ${response.status}`
  }

  /** Open the dialog and load the increment preview (or the rebuild offer). */
  async preview(sessionId: SessionId, strategyId?: string): Promise<void> {
    this.patch(sessionId, { open: true, phase: 'previewing', error: null })
    try {
      const request: Record<string, unknown> = { action: 'preview' }
      if (strategyId !== undefined && strategyId !== '') request.strategyId = strategyId
      const response = await this.call(sessionId, request)
      if (!response.ok) throw new Error(await this.failureOf(response))
      const plan = (await response.json()) as HostPlan
      const inProgress = plan.inProgress === true
      const needsRebuild = plan.needsRebuild === true
      const saved = (plan.strategies ?? [])
        .map((s) => ({ id: s.id ?? '', name: s.name ?? '' }))
        .filter((s) => s.id !== '')
      if (plan.hasNew !== true && !needsRebuild) {
        // 无新对话时也要带上策略信息：对话框在 done/no_new 态同样提供
        // 「选择策略 / 设计 / 管理」入口（换策略本身就会触发全量重排）。
        this.patch(sessionId, {
          phase: 'no_new',
          file: plan.file ?? null,
          inProgress,
          strategies: saved,
          strategyId: plan.strategyId ?? '',
          reflow: false,
          reclassify: false,
          classification: null,
        })
        return
      }
      const dimensions = (plan.dimensions ?? [])
        .map((d) => ({
          id: d.id ?? '',
          name: d.name ?? '',
          modules: (d.modules ?? []).filter((m) => m !== ''),
          defaultModule: d.defaultModule ?? '',
        }))
        .filter((d) => d.id !== '')
      this.patch(sessionId, {
        phase: 'ready',
        file: plan.file ?? null,
        dimensions,
        segments: (plan.segments ?? []).map((s) => ({
          no: s.no ?? 0,
          title: s.title ?? '',
          labels: s.labels ?? {},
          summary: s.summary ?? '',
        })),
        toc: (plan.toc ?? []).map((m) => ({
          dimensionId: m.dimensionId ?? '',
          moduleName: m.moduleName ?? '',
          turns: (m.turns ?? []).map((turn) => ({ no: turn.no ?? 0, title: turn.title ?? '' })),
        })),
        inProgress,
        needsRebuild,
        rebuildReason: plan.rebuildReason ?? null,
        rebuildTurns: plan.rebuildTurns ?? 0,
        rebuilt: false,
        reflow: plan.reflow === true,
        reclassify: plan.reclassify === true,
        reflowed: false,
        classification: plan.classification !== undefined
          ? {
              status: plan.classification.status ?? 'ok',
              reason: plan.classification.reason ?? null,
              dimensions: (plan.classification.dimensions ?? []).map((d) => ({
                id: d.id ?? '',
                name: d.name ?? '',
                missing: d.missing ?? 0,
                unknown: d.unknown ?? 0,
                unmatched: d.unmatched ?? [],
              })),
            }
          : null,
        strategies: saved,
        strategyId: plan.strategyId ?? '',
        // 有内置默认策略时不再自动弹设计对话（用户可随时点「设计新策略…」）
        chatOpen: false,
      })
    } catch (error) {
      this.patch(sessionId, { phase: 'error', error: messageOf(error) })
    }
  }

  /** Open / close the strategy-design chat. */
  openDesignChat(sessionId: SessionId): void {
    this.patch(sessionId, { chatOpen: true, chatError: null })
  }

  closeDesignChat(sessionId: SessionId): void {
    this.patch(sessionId, { chatOpen: false, chatError: null })
  }

  /** Send one design-chat message and append the LLM reply (with any parsed strategy). */
  async sendChat(sessionId: SessionId, text: string): Promise<void> {
    const entry = this.entryOf(sessionId)
    const history = [...entry.chatMessages, { role: 'user' as const, content: text }]
    this.patch(sessionId, { chatMessages: history, chatBusy: true, chatError: null })
    try {
      const response = await this.call(sessionId, { action: 'strategy-chat', messages: history })
      if (!response.ok) throw new Error(await this.failureOf(response))
      const result = (await response.json()) as { reply?: string; strategy?: unknown }
      this.patch(sessionId, {
        chatMessages: [...history, { role: 'assistant', content: result.reply ?? '' }],
        chatBusy: false,
        chatStrategy: result.strategy ?? null,
      })
    } catch (error) {
      this.patch(sessionId, { chatBusy: false, chatError: messageOf(error) })
    }
  }

  /** Save the strategy produced by the chat, select it, and refresh the preview with it. */
  async saveChatStrategy(sessionId: SessionId): Promise<void> {
    const entry = this.entryOf(sessionId)
    if (entry.chatStrategy == null) return
    this.patch(sessionId, { chatBusy: true, chatError: null })
    try {
      const response = await this.call(sessionId, { action: 'strategy-save', strategy: entry.chatStrategy, source: 'llm' })
      if (!response.ok) throw new Error(await this.failureOf(response))
      const result = (await response.json()) as HostSaveResult
      if (result.ok !== true || result.id === undefined) {
        throw new Error((result.errors ?? []).join('；') || 'invalid strategy')
      }
      this.patch(sessionId, {
        chatBusy: false,
        chatOpen: false,
        chatStrategy: null,
        chatMessages: [],
        strategies: [...entry.strategies.filter((s) => s.id !== result.id), { id: result.id, name: result.name ?? result.id }],
        strategyId: result.id,
      })
      await this.preview(sessionId, result.id)
    } catch (error) {
      this.patch(sessionId, { chatBusy: false, chatError: messageOf(error) })
    }
  }

  /** 打开策略管理（删除/新建/导入/编辑）。 */
  async openManager(sessionId: SessionId): Promise<void> {
    this.patch(sessionId, {
      manageOpen: true,
      manageError: null,
      manageNotice: null,
      draft: null,
      importOpen: false,
      importText: '',
    })
    await this.refreshStrategies(sessionId)
  }

  /** 关闭策略管理并丢弃未保存的草稿。 */
  closeManager(sessionId: SessionId): void {
    this.patch(sessionId, {
      manageOpen: false,
      manageError: null,
      manageNotice: null,
      draft: null,
      importOpen: false,
      importText: '',
    })
  }

  /** 拉取容器里的完整策略列表（含模块，供列表展示与编辑）。 */
  async refreshStrategies(sessionId: SessionId): Promise<void> {
    try {
      const response = await this.call(sessionId, { action: 'strategy-list' })
      if (!response.ok) throw new Error(await this.failureOf(response))
      const result = (await response.json()) as { strategies?: readonly HostStrategy[] }
      this.patch(sessionId, { manageList: (result.strategies ?? []).map(toStrategyView) })
    } catch (error) {
      this.patch(sessionId, { manageError: messageOf(error) })
    }
  }

  /** 新建策略草稿（两个维度、各一个兜底模块起步）。 */
  newDraft(sessionId: SessionId): void {
    const suffix = Date.now().toString(36).slice(-4)
    this.patch(sessionId, {
      draft: {
        id: `custom-${suffix}`,
        name: '',
        dimensions: [
          {
            id: 'phase',
            name: '开发阶段',
            defaultModule: '其他',
            modules: [{ name: '其他', description: '无法归入其他模块的问答', examples: '' }],
          },
          {
            id: 'purpose',
            name: '对话功能/目的',
            defaultModule: '其他',
            modules: [{ name: '其他', description: '无法归入其他目的', examples: '' }],
          },
        ],
        existing: false,
      },
      manageError: null,
      manageNotice: null,
      importOpen: false,
    })
  }

  /** 载入已有策略到编辑器。 */
  editDraft(sessionId: SessionId, id: string): void {
    const found = this.entryOf(sessionId).manageList.find((s) => s.id === id)
    if (found === undefined) return
    this.patch(sessionId, {
      draft: {
        id: found.id,
        name: found.name,
        dimensions: found.dimensions.map((d) => ({
          id: d.id,
          name: d.name,
          defaultModule: d.defaultModule !== '' ? d.defaultModule : (d.modules[0]?.name ?? ''),
          modules: d.modules.map((m) => ({ ...m })),
        })),
        existing: true,
      },
      manageError: null,
      manageNotice: null,
      importOpen: false,
    })
  }

  /** 关闭编辑器（不保存）。 */
  cancelDraft(sessionId: SessionId): void {
    this.patch(sessionId, { draft: null, manageError: null })
  }

  /** 编辑草稿的标量字段。 */
  setDraftField(sessionId: SessionId, patch: Partial<Pick<StrategyDraft, 'id' | 'name'>>): void {
    const draft = this.entryOf(sessionId).draft
    if (draft === null) return
    this.patch(sessionId, { draft: { ...draft, ...patch } })
  }

  /** 编辑某个维度的标量字段（名称 / 兜底模块）。 */
  setDraftDimension(sessionId: SessionId, dimensionIndex: number, patch: Partial<Pick<StrategyDimensionDraft, 'name' | 'defaultModule'>>): void {
    const draft = this.entryOf(sessionId).draft
    if (draft === null) return
    this.patch(sessionId, {
      draft: {
        ...draft,
        dimensions: draft.dimensions.map((d, i) => (i === dimensionIndex ? { ...d, ...patch } : d)),
      },
    })
  }

  /** 编辑某个维度里某个模块的字段。 */
  setDraftModule(
    sessionId: SessionId,
    dimensionIndex: number,
    moduleIndex: number,
    patch: Partial<StrategyModuleDraft>,
  ): void {
    const draft = this.entryOf(sessionId).draft
    if (draft === null) return
    this.patch(sessionId, {
      draft: {
        ...draft,
        dimensions: draft.dimensions.map((d, i) => i === dimensionIndex
          ? { ...d, modules: d.modules.map((m, j) => (j === moduleIndex ? { ...m, ...patch } : m)) }
          : d),
      },
    })
  }

  /** 某个维度里追加一个空模块。 */
  addDraftModule(sessionId: SessionId, dimensionIndex: number): void {
    const draft = this.entryOf(sessionId).draft
    if (draft === null) return
    this.patch(sessionId, {
      draft: {
        ...draft,
        dimensions: draft.dimensions.map((d, i) => i === dimensionIndex
          ? { ...d, modules: [...d.modules, { name: '', description: '', examples: '' }] }
          : d),
      },
    })
  }

  /** 某个维度里删除一个模块（每维至少保留一个）。 */
  removeDraftModule(sessionId: SessionId, dimensionIndex: number, moduleIndex: number): void {
    const draft = this.entryOf(sessionId).draft
    if (draft === null) return
    const dimension = draft.dimensions[dimensionIndex]
    if (dimension === undefined || dimension.modules.length <= 1) return
    this.patch(sessionId, {
      draft: {
        ...draft,
        dimensions: draft.dimensions.map((d, i) => i === dimensionIndex
          ? { ...d, modules: d.modules.filter((_, j) => j !== moduleIndex) }
          : d),
      },
    })
  }

  /** 开关「导入 JSON」输入区。 */
  toggleImport(sessionId: SessionId): void {
    const entry = this.entryOf(sessionId)
    this.patch(sessionId, { importOpen: !entry.importOpen, manageError: null, manageNotice: null })
  }

  /** 更新导入 JSON 文本框。 */
  setImportText(sessionId: SessionId, value: string): void {
    this.patch(sessionId, { importText: value })
  }

  /** 保存草稿（新建/编辑都走 strategy-save，同 id 覆盖）。 */
  async saveDraft(sessionId: SessionId): Promise<void> {
    const entry = this.entryOf(sessionId)
    const draft = entry.draft
    if (draft === null) return
    const strategy = {
      id: draft.id.trim(),
      name: draft.name.trim(),
      dimensions: draft.dimensions.map((d) => ({
        id: d.id.trim(),
        name: d.name.trim(),
        defaultModule: d.defaultModule,
        modules: d.modules.map((m) => ({
          name: m.name.trim(),
          ...(m.description.trim() !== '' ? { description: m.description.trim() } : {}),
          ...(m.examples.trim() !== ''
            ? { examples: m.examples.split(/[\n,，、]/).map((x) => x.trim()).filter((x) => x !== '') }
            : {}),
        })),
      })),
    }
    this.patch(sessionId, { manageBusy: true, manageError: null, manageNotice: null })
    try {
      const response = await this.call(sessionId, {
        action: 'strategy-save',
        strategy,
        ...(draft.existing ? {} : { source: 'imported' }),
      })
      if (!response.ok) throw new Error(await this.failureOf(response))
      const result = (await response.json()) as HostSaveResult
      if (result.ok !== true || result.id === undefined) {
        throw new Error((result.errors ?? []).join('；') || 'invalid strategy')
      }
      this.patch(sessionId, {
        manageBusy: false,
        draft: null,
        manageNotice: { kind: 'saved', name: result.name ?? result.id },
      })
      await this.refreshStrategies(sessionId)
      await this.syncStrategySelection(sessionId, result.id)
    } catch (error) {
      this.patch(sessionId, { manageBusy: false, manageError: messageOf(error) })
    }
  }

  /** 导入 JSON 文本（strategy-save 接受字符串，源标记为 imported）。 */
  async importStrategy(sessionId: SessionId): Promise<void> {
    const text = this.entryOf(sessionId).importText.trim()
    if (text === '') return
    this.patch(sessionId, { manageBusy: true, manageError: null, manageNotice: null })
    try {
      const response = await this.call(sessionId, { action: 'strategy-save', strategy: text, source: 'imported' })
      if (!response.ok) throw new Error(await this.failureOf(response))
      const result = (await response.json()) as HostSaveResult
      if (result.ok !== true || result.id === undefined) {
        throw new Error((result.errors ?? []).join('；') || 'invalid strategy')
      }
      this.patch(sessionId, {
        manageBusy: false,
        importOpen: false,
        importText: '',
        manageNotice: { kind: 'imported', name: result.name ?? result.id },
      })
      await this.refreshStrategies(sessionId)
      await this.syncStrategySelection(sessionId, result.id)
    } catch (error) {
      this.patch(sessionId, { manageBusy: false, manageError: messageOf(error) })
    }
  }

  /** 删除策略；若删的是当前策略，重新预览以便回落。 */
  async deleteStrategy(sessionId: SessionId, id: string): Promise<void> {
    this.patch(sessionId, { manageBusy: true, manageError: null, manageNotice: null })
    try {
      const response = await this.call(sessionId, { action: 'strategy-delete', strategyId: id })
      if (!response.ok) throw new Error(await this.failureOf(response))
      const result = (await response.json()) as HostSaveResult
      if (result.ok !== true) throw new Error('strategy-delete rejected')
      this.patch(sessionId, {
        manageBusy: false,
        manageNotice: { kind: result.deleted === true ? 'deleted' : 'notFound' },
      })
      await this.refreshStrategies(sessionId)
      if (this.entryOf(sessionId).strategyId === id) await this.preview(sessionId)
    } catch (error) {
      this.patch(sessionId, { manageBusy: false, manageError: messageOf(error) })
    }
  }

  /**
   * 保存/导入后让选择器跟上：把新策略设为会话当前策略。
   * 已有文档时会触发「换策略重排」预览（整份按新策略重新分类）。
   */
  private async syncStrategySelection(sessionId: SessionId, id: string): Promise<void> {
    const entry = this.entryOf(sessionId)
    this.patch(sessionId, {
      strategies: [...entry.strategies.filter((s) => s.id !== id), { id, name: entry.manageList.find((s) => s.id === id)?.name ?? id }],
    })
    if (entry.strategyId !== id) await this.preview(sessionId, id)
  }

  /** Switch the classification strategy and refresh the preview with it. */
  async selectStrategy(sessionId: SessionId, strategyId: string): Promise<void> {
    await this.preview(sessionId, strategyId)
    this.patch(sessionId, { strategyId })
  }

  /** Rebuild the whole document from the session history (missing or broken file). */
  async rebuild(sessionId: SessionId): Promise<void> {
    const entry = this.entryOf(sessionId)
    this.patch(sessionId, { phase: 'committing', error: null })
    try {
      const body: Record<string, unknown> = {
        action: 'rebuild',
        edits: entry.segments.map((s) => ({ no: s.no, labels: s.labels })),
      }
      const path = entry.pathDraft.trim()
      if (path !== '') body.path = path
      // 必须把对话框里选中的策略带进写请求，否则提交会退回旧策略（选策略形同虚设）。
      if (entry.strategyId !== '') body.strategyId = entry.strategyId
      const response = await this.call(sessionId, body)
      if (!response.ok) throw new Error(await this.failureOf(response))
      const status = (await response.json()) as HostStatus
      if (status.status === 'ok') {
        this.patch(sessionId, {
          phase: 'done',
          file: status.file ?? entry.file,
          appended: status.appendedSegments ?? 0,
          inProgress: status.inProgress === true,
          rebuilt: status.reflowed !== true,
          reflowed: status.reflowed === true,
          reflow: false,
          needsRebuild: false,
          rebuildReason: null,
        })
        return
      }
      if (status.status === 'no_new') {
        this.patch(sessionId, { phase: 'no_new', inProgress: status.inProgress === true })
        return
      }
      this.patch(sessionId, { phase: 'error', error: status.message ?? 'unknown error' })
    } catch (error) {
      this.patch(sessionId, { phase: 'error', error: messageOf(error) })
    }
  }

  /** Confirm the previewed increment (with any module edits and path override). */
  async commit(sessionId: SessionId): Promise<void> {
    const entry = this.entryOf(sessionId)
    this.patch(sessionId, { phase: 'committing', error: null })
    try {
      const body: Record<string, unknown> = {
        action: 'commit',
        edits: entry.segments.map((s) => ({ no: s.no, labels: s.labels })),
      }
      const path = entry.pathDraft.trim()
      if (path !== '') body.path = path
      // 同 rebuild：选中的策略必须随写请求一起提交（换策略 = 全量重排）。
      if (entry.strategyId !== '') body.strategyId = entry.strategyId
      const response = await this.call(sessionId, body)
      if (!response.ok) throw new Error(await this.failureOf(response))
      const status = (await response.json()) as HostStatus
      if (status.status === 'ok') {
        this.patch(sessionId, {
          phase: 'done',
          file: status.file ?? entry.file,
          appended: status.appendedSegments ?? 0,
          inProgress: status.inProgress === true,
          reflowed: status.reflowed === true,
        })
        return
      }
      if (status.status === 'no_new') {
        this.patch(sessionId, { phase: 'no_new', inProgress: status.inProgress === true })
        return
      }
      this.patch(sessionId, { phase: 'error', error: status.message ?? 'unknown error' })
    } catch (error) {
      this.patch(sessionId, { phase: 'error', error: messageOf(error) })
    }
  }

  /** Close the dialog and reset it for the next gesture. */
  dismiss(sessionId: SessionId): void {
    this.patch(sessionId, {
      open: false,
      phase: 'idle',
      error: null,
      segments: [],
      pathDraft: '',
      needsRebuild: false,
      rebuildReason: null,
      rebuildTurns: 0,
      rebuilt: false,
      reflow: false,
      reflowed: false,
      classification: null,
      manageOpen: false,
      manageError: null,
      manageNotice: null,
      draft: null,
      importOpen: false,
      importText: '',
    })
  }

  /** Update the free-text path override shown in the dialog. */
  setPathDraft(sessionId: SessionId, value: string): void {
    this.patch(sessionId, { pathDraft: value })
  }

  /** Reassign one segment to another module (empty string reverts to the default module). */
  setSegmentLabel(sessionId: SessionId, no: number, dimensionId: string, moduleName: string): void {
    const entry = this.entryOf(sessionId)
    this.patch(sessionId, {
      segments: entry.segments.map((s) => (s.no === no ? { ...s, labels: { ...s.labels, [dimensionId]: moduleName } } : s)),
    })
  }
}
