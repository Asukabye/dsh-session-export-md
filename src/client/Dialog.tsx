import { useEffect, useMemo, useRef, useState } from 'react'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionExportState } from './controller.ts'
import { NS } from './locales.ts'
import css from './Dialog.module.css'

/** Browser operations and state injected into the Session Header contribution. */
export interface SessionExportInjected {
  hooks: { sessionExport: ObservableSnapshot<SessionExportState> }
  /** True when the host menu registry is absent and this plugin renders its own button. */
  standaloneButton: boolean
  preview: (sessionId: SessionId) => Promise<void>
  commit: (sessionId: SessionId) => Promise<void>
  /** Full rebuild from session history (the export file is missing or broken). */
  rebuild: (sessionId: SessionId) => Promise<void>
  /** Switch the classification strategy (re-runs the preview with it). */
  selectStrategy: (sessionId: SessionId, strategyId: string) => Promise<void>
  /** Open the strategy-design chat (LLM conversation producing a strategy). */
  openDesignChat: (sessionId: SessionId) => void
  /** Send one design-chat message (the reply may carry a parsed strategy). */
  sendChat: (sessionId: SessionId, text: string) => Promise<void>
  /** Save the strategy produced by the design chat and select it. */
  saveChatStrategy: (sessionId: SessionId) => Promise<void>
  /** Close the strategy-design chat. */
  closeChat: (sessionId: SessionId) => void
  /** Open the strategy manager (delete / new / import / edit). */
  openManager: (sessionId: SessionId) => Promise<void>
  /** Close the strategy manager, discarding an unsaved draft. */
  closeManager: (sessionId: SessionId) => void
  /** Load one stored strategy into the editor. */
  editDraft: (sessionId: SessionId, id: string) => void
  /** Start a new strategy draft. */
  newDraft: (sessionId: SessionId) => void
  /** Drop the current draft without saving. */
  cancelDraft: (sessionId: SessionId) => void
  /** Save the current draft (create or overwrite). */
  saveDraft: (sessionId: SessionId) => Promise<void>
  /** Patch the draft's scalar fields. */
  setDraftField: (sessionId: SessionId, patch: { id?: string; name?: string }) => void
  /** Patch one module row of a draft dimension. */
  setDraftModule: (
    sessionId: SessionId,
    dimensionIndex: number,
    moduleIndex: number,
    patch: { name?: string; description?: string; examples?: string },
  ) => void
  /** Patch a draft dimension's name / fallback module. */
  setDraftDimension: (
    sessionId: SessionId,
    dimensionIndex: number,
    patch: { name?: string; defaultModule?: string },
  ) => void
  /** Append an empty module row to one draft dimension. */
  addDraftModule: (sessionId: SessionId, dimensionIndex: number) => void
  /** Remove one module row from one draft dimension. */
  removeDraftModule: (sessionId: SessionId, dimensionIndex: number, moduleIndex: number) => void
  /** Toggle the JSON import area. */
  toggleImport: (sessionId: SessionId) => void
  /** Update the JSON import text. */
  setImportText: (sessionId: SessionId, value: string) => void
  /** Import the pasted strategy JSON. */
  importStrategy: (sessionId: SessionId) => Promise<void>
  /** Delete one stored strategy. */
  deleteStrategy: (sessionId: SessionId, id: string) => Promise<void>
  dismiss: (sessionId: SessionId) => void
  setPath: (sessionId: SessionId, value: string) => void
  /** 该部署是否提供原生目录选择能力（无则隐藏「选择位置…」按钮）。 */
  canPickDirectory: boolean
  /** 打开系统目录选择框，把选中目录写回导出路径。 */
  pickDirectory: (sessionId: SessionId) => Promise<void>
  /** 把某轮在某个维度上改成另一个模块。 */
  setLabel: (sessionId: SessionId, no: number, dimensionId: string, moduleName: string) => void
}

export type SessionExportDialogProps =
  PropsRuntime<'conversation.session.header.utilities'>
  & PropsLocale<typeof NS>
  & InjectFace<SessionExportInjected>

type TabId = 'turns' | 'toc' | 'strategy'

type ChipTone = 'neutral' | 'info' | 'warning' | 'danger' | 'success'

interface Chip {
  tone: ChipTone
  text: string
  /** 供 e2e / 样式区分的稳定标记。 */
  key: string
}

/**
 * The export dialog: a status strip, three tabs (rounds / contents / strategy),
 * and the append-only write through the host route.
 *
 * 阅读顺序：标题 → 一句静态说明 → 状态胶囊（动态状态）→ 目标文件 → 页签 →
 * 面板。轮次行默认只读（标题 + 归类胶囊），点胶囊开菜单改类；概要缺失的行
 * 直接标黄并计入上方「待处理」胶囊。
 *
 * @param props - Session runtime, bound controller state, actions, and localized copy.
 * @returns the modal portal contribution.
 */
export function SessionExportDialog({
  sessionId, useSessionExport, commit, rebuild, selectStrategy, openDesignChat, openManager,
  dismiss, setPath, setLabel, canPickDirectory, pickDirectory, t,
}: SessionExportDialogProps) {
  const entry = useSessionExport(state => state.bySession[String(sessionId)])
  const phase = entry?.phase ?? 'idle'
  const open = entry?.open === true
  const needsRebuild = entry?.needsRebuild === true
  const reflow = entry?.reflow === true
  const reclassify = reflow || entry?.reclassify === true
  const classification = entry?.classification ?? null
  const degraded = (classification?.dimensions ?? []).filter((d) => d.missing + d.unknown > 0)
  /** 面板（页签 + 轮次/目录/策略）在预导出、导出完成、无新对话三种状态下都保留，
   * 否则导出成功后「切换策略 / 设计新策略 / 管理策略」会变得不可达。 */
  const showPanels = phase === 'ready' || phase === 'done' || phase === 'no_new'

  const [tab, setTab] = useState<TabId>('turns')
  const [query, setQuery] = useState('')
  const [onlyTodo, setOnlyTodo] = useState(false)
  const [expanded, setExpanded] = useState<Record<number, boolean>>({})
  const [menu, setMenu] = useState<{ no: number; dimensionId: string } | null>(null)
  const [jumpNo, setJumpNo] = useState<number | null>(null)
  const rowRefs = useRef<Record<number, HTMLLIElement | null>>({})

  const segments = useMemo(() => entry?.segments ?? [], [entry])
  const dimensions = useMemo(() => entry?.dimensions ?? [], [entry])
  const toc = useMemo(() => entry?.toc ?? [], [entry])

  /** 待处理 = 没有概要（目录描述会因此缺失）。 */
  const isTodo = (summary: string): boolean => summary === ''
  const todoCount = segments.filter((s) => isTodo(s.summary)).length

  const shown = segments.filter((s) => {
    if (onlyTodo && !isTodo(s.summary)) return false
    if (query.trim() === '') return true
    const kw = query.trim().toLowerCase()
    const labels = dimensions.map((d) => s.labels[d.id] ?? '').join(' ')
    return `${String(s.no)} ${s.title} ${s.summary} ${labels}`.toLowerCase().includes(kw)
  })

  const tocDimensions = new Set(toc.map((m) => m.dimensionId)).size
  const tocUsed = toc.filter((m) => m.turns.length > 0).length

  // 每次打开都回到默认视图，避免上一次的筛选/展开残留
  useEffect(() => {
    if (open) {
      setTab('turns')
      setQuery('')
      setOnlyTodo(false)
      setExpanded({})
      setMenu(null)
    }
  }, [open])

  // 点击别处 / Esc 关闭模块菜单
  useEffect(() => {
    if (menu === null) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null
      if (target !== null && target.closest('[data-session-export-menu]') !== null) return
      if (target !== null && target.closest('[data-session-export-segment-dim]') !== null) return
      setMenu(null)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [menu])

  // 从目录跳回轮次：滚到那一行
  useEffect(() => {
    if (jumpNo === null) return
    const node = rowRefs.current[jumpNo]
    if (node !== null && node !== undefined && typeof node.scrollIntoView === 'function') {
      node.scrollIntoView({ block: 'center' })
    }
    setJumpNo(null)
  }, [jumpNo, tab])

  const setRowRef = (no: number) => (node: HTMLLIElement | null) => {
    rowRefs.current[no] = node
  }

  /** 状态胶囊：所有动态状态都在这里，description 只留静态说明。 */
  const chips: Chip[] = []
  if (phase === 'previewing' || phase === 'committing') {
    chips.push({ key: 'running', tone: 'info', text: t('dialog.running') })
  }
  if (phase === 'ready' && needsRebuild) {
    chips.push({
      key: 'rebuild',
      tone: 'warning',
      text: `${t('dialog.rebuild')} · ${String(entry?.rebuildTurns ?? 0)} ${t('dialog.turnUnit')}`,
    })
  }
  if (phase === 'ready' && reclassify) {
    chips.push({
      key: 'reclassify',
      tone: 'info',
      text: `${reflow ? t('dialog.reflowChip') : t('dialog.reclassifyChip')} ${String(segments.length)} ${t('dialog.turnUnit')}`,
    })
  }
  if (phase === 'ready' && todoCount > 0) {
    chips.push({
      key: 'todo',
      tone: 'danger',
      text: `${t('dialog.todoChip')} ${String(todoCount)} ${t('dialog.turnUnit')}`,
    })
  }
  if (phase === 'ready' && toc.length > 0) {
    chips.push({
      key: 'toc',
      tone: 'neutral',
      text: `${t('dialog.tocChip')} ${String(tocDimensions)} 维 · ${String(tocUsed)}/${String(toc.length)} ${t('dialog.moduleUnit')}`,
    })
  }
  if (phase === 'ready' && entry !== undefined && entry.strategyId !== '') {
    const name = entry.strategies.find((s) => s.id === entry.strategyId)?.name ?? entry.strategyId
    chips.push({ key: 'strategy', tone: 'neutral', text: `${t('dialog.strategyChip')}：${name}` })
  }
  if (phase === 'no_new') chips.push({ key: 'nonew', tone: 'neutral', text: t('dialog.noNew') })
  if (phase === 'done') {
    chips.push({
      key: 'done',
      tone: 'success',
      text: `${entry?.reflowed === true
        ? t('dialog.reflowed')
        : entry?.rebuilt === true ? t('dialog.rebuilt') : t('dialog.doneChip')} ${String(entry?.appended ?? 0)} ${t('dialog.turnUnit')} · ${entry?.file ?? ''}`,
    })
  }
  if (phase === 'error') {
    chips.push({ key: 'error', tone: 'danger', text: `${t('dialog.error')}：${entry?.error ?? ''}` })
  }

  const footer = phase === 'ready'
    ? (
        <>
          <Button variant="ghost" onClick={() => { dismiss(sessionId) }}>{t('dialog.cancel')}</Button>
          <Button
            variant="primary"
            onClick={() => { void (needsRebuild ? rebuild(sessionId) : commit(sessionId)) }}
          >
            {needsRebuild ? t('dialog.rebuild') : reflow ? t('dialog.reflow') : t('dialog.confirm')}
          </Button>
        </>
      )
    : (
        <Button variant="primary" onClick={() => { dismiss(sessionId) }}>{t('dialog.close')}</Button>
      )

  /** 轮次面板：搜索 + 只看待处理 + 只读行（点胶囊改类）。 */
  const turnsPanel = (
    <>
      <div className={css.toolbar}>
        <div className={css.search}>
          <Input
            type="search"
            data-session-export-search
            placeholder={t('dialog.search')}
            value={query}
            onChange={(event) => { setQuery(event.target.value) }}
          />
        </div>
        <label className={css.switch}>
          <input
            type="checkbox"
            data-session-export-only-todo
            checked={onlyTodo}
            onChange={(event) => { setOnlyTodo(event.target.checked) }}
          />
          {`${t('dialog.onlyTodo')}（${String(todoCount)}）`}
        </label>
      </div>
      <ul className={css.rows} data-session-export-segments>
        {shown.length === 0 && <li className={css.hint}>{t('dialog.emptyFilter')}</li>}
        {shown.map((segment) => {
          const isOpen = expanded[segment.no] === true
          return (
            <li key={segment.no} ref={setRowRef(segment.no)} className={css.row} data-no={segment.no}>
              <div className={css.rowHead}>
                <span className={css.rowNo}>{segment.no}</span>
                <span
                  data-session-export-segment-title
                  className={css.rowTitle}
                  title={segment.summary !== '' ? `${t('dialog.summary')}：${segment.summary}` : undefined}
                >
                  {segment.title === '' ? `第 ${String(segment.no)} 轮` : segment.title}
                </span>
                <button
                  type="button"
                  className={css.caret}
                  aria-expanded={isOpen}
                  aria-label={t('dialog.toggleSummary')}
                  data-session-export-segment-caret
                  onClick={() => {
                    setExpanded((prev) => ({ ...prev, [segment.no]: !isOpen }))
                  }}
                >
                  ▶
                </button>
              </div>
              <div className={css.pills}>
                {dimensions.map((dimension) => {
                  const current = segment.labels[dimension.id] ?? dimension.defaultModule
                  // 段上的旧归类可能来自上一个策略：保留为选项，避免显示成别的模块
                  const options = dimension.modules.includes(current) || current === ''
                    ? dimension.modules
                    : [...dimension.modules, current]
                  const menuOpen = menu !== null && menu.no === segment.no && menu.dimensionId === dimension.id
                  return (
                    <span key={dimension.id} style={{ position: 'relative', display: 'inline-flex' }}>
                      <button
                        type="button"
                        className={css.pill}
                        data-session-export-segment-dim={dimension.id}
                        aria-haspopup="menu"
                        aria-expanded={menuOpen}
                        title={`${t('dialog.changeModule')}（${dimension.name}）`}
                        onClick={() => {
                          setMenu(menuOpen ? null : { no: segment.no, dimensionId: dimension.id })
                        }}
                      >
                        <b>{dimension.name}</b>
                        <span>{current}</span>
                        <span className={css.pillCaret}>▾</span>
                      </button>
                      {menuOpen && (
                        <div className={css.menu} role="menu" data-session-export-menu={dimension.id}>
                          {options.map((name) => (
                            <button
                              key={name}
                              type="button"
                              role="menuitemradio"
                              aria-checked={name === current}
                              className={css.menuItem}
                              data-selected={name === current}
                              data-session-export-menu-option={name}
                              onClick={() => {
                                setLabel(sessionId, segment.no, dimension.id, name)
                                setMenu(null)
                              }}
                            >
                              {name}
                            </button>
                          ))}
                        </div>
                      )}
                    </span>
                  )
                })}
              </div>
              {isOpen && (segment.summary === ''
                ? (
                    <p className={css.summaryMissing} data-session-export-segment-summary data-missing="true">
                      {`${t('dialog.summaryMissing')} — ${t('dialog.summaryMissingHint')}`}
                    </p>
                  )
                : (
                    <p
                      className={css.summary}
                      data-session-export-segment-summary
                      title={`${t('dialog.summary')}：${segment.summary}`}
                    >
                      {`${t('dialog.summary')}：${segment.summary}`}
                    </p>
                  ))}
            </li>
          )
        })}
      </ul>
    </>
  )

  /** 目录面板：直接渲染服务端返回的 toc（维度 → 模块 → 轮次），与导出文件同源。 */
  const tocPanel = (
    <div className={css.toc} data-session-export-toc>
      <p className={css.hint}>
        {`${t('dialog.tocChip')}：${String(tocDimensions)} 维 / ${String(toc.length)} ${t('dialog.moduleUnit')}，${String(tocUsed)} ${t('dialog.tocStats')}`}
      </p>
      {dimensions.map((dimension) => {
        const modules = toc.filter((m) => m.dimensionId === dimension.id)
        if (modules.length === 0) return null
        const used = modules.filter((m) => m.turns.length > 0).length
        return (
          <div key={dimension.id} className={css.dim}>
            <div className={css.dimHead}>
              <span className={css.dimName}>{dimension.name}</span>
              <span className={css.tag} data-tone={used === modules.length ? 'success' : 'warning'}>
                {`${String(used)}/${String(modules.length)}`}
              </span>
            </div>
            {modules.map((module, index) => (module.turns.length === 0
              ? (
                  <div key={module.moduleName} className={css.modEmpty}>
                    <span className={css.modEmptyName}>{`${String(index + 1)}. ${module.moduleName}`}</span>
                    <span className={css.hint}>{t('dialog.tocEmptyModule')}</span>
                  </div>
                )
              : (
                  <details key={module.moduleName} className={css.callout} open>
                    <summary className={css.calloutHead}>
                      <span>{`${String(index + 1)}. ${module.moduleName}`}</span>
                      <span className={css.calloutCount}>{`${String(module.turns.length)} ${t('dialog.turnUnit')}`}</span>
                    </summary>
                    <div className={css.calloutBody}>
                      {module.turns.map((turn) => (
                        <button
                          key={turn.no}
                          type="button"
                          className={css.turnLink}
                          data-session-export-toc-turn={turn.no}
                          onClick={() => {
                            setTab('turns')
                            setQuery('')
                            setOnlyTodo(false)
                            setExpanded((prev) => ({ ...prev, [turn.no]: true }))
                            setJumpNo(turn.no)
                          }}
                        >
                          {`第 ${String(turn.no)} 轮：${turn.title}`}
                        </button>
                      ))}
                    </div>
                  </details>
                )))}
          </div>
        )
      })}
    </div>
  )

  /** 策略面板：当前策略 + 切换 + 设计/管理，附维度与模块清单。 */
  const strategyPanel = entry !== undefined && (phase === 'ready' || phase === 'no_new' || phase === 'done')
    ? (
        <div className={css.stack}>
          <div className={css.rowBetween}>
            <div className={css.grow}>
              <div className={css.hint}>{t('dialog.current')}</div>
              <select
                data-session-export-strategy
                className={css.select}
                value={entry.strategyId}
                onChange={(event) => { void selectStrategy(sessionId, event.target.value) }}
              >
                {entry.strategies.length === 0 && <option value="">{t('dialog.strategyNone')}</option>}
                {entry.strategies.map((strategy) => (
                  <option key={strategy.id} value={strategy.id}>{strategy.name}</option>
                ))}
              </select>
            </div>
            <Button variant="ghost" onClick={() => { openDesignChat(sessionId) }}>{t('dialog.design')}</Button>
            <Button variant="ghost" onClick={() => { void openManager(sessionId) }}>{t('dialog.manage')}</Button>
          </div>
          {dimensions.map((dimension) => (
            <div key={dimension.id} className={css.hint}>
              {`${dimension.name}：${dimension.modules.join(' / ')}`}
            </div>
          ))}
        </div>
      )
    : null

  return (
    <Modal
      open={open}
      onClose={() => { dismiss(sessionId) }}
      title={t('dialog.title')}
      description={t('dialog.desc')}
      closeLabel={t('dialog.close')}
      footer={footer}
      className={css.dialog ?? ''}
      contentClassName={css.scroll ?? ''}
    >
      <div className={css.statusRow} data-session-export-status>
        {chips.map((chip) => (
          <span key={chip.key} className={css.chip} data-tone={chip.tone} data-chip={chip.key}>
            {chip.text}
          </span>
        ))}
      </div>

      {showPanels && entry !== undefined && (
        <>
          <div className={css.target}>
            <div className={css.targetCol}>
              <div className={css.hint}>{t('dialog.target')}</div>
              <div className={css.path} title={entry.file ?? ''} data-session-export-target>
                {entry.file ?? t('dialog.pathPlaceholder')}
              </div>
            </div>
            {/* 无原生目录选择能力时不显示入口（seam 约定：隐藏而不是报错） */}
            {canPickDirectory && (
              <Button
                variant="ghost"
                data-session-export-pick-dir
                onClick={() => { void pickDirectory(sessionId) }}
              >
                {t('dialog.pickDir')}
              </Button>
            )}
          </div>

          <div className={css.target}>
            <div className={css.targetCol}>
              <div className={css.hint}>{t('dialog.path')}</div>
              <Input
                data-session-export-path
                value={entry.pathDraft}
                placeholder={entry.file ?? t('dialog.pathPlaceholder')}
                onChange={(event) => { setPath(sessionId, event.target.value) }}
              />
            </div>
          </div>

          <div className={css.tabbar}>
            {([['turns', t('dialog.tabTurns')], ['toc', t('dialog.tabToc')], ['strategy', t('dialog.tabStrategy')]] as const)
              .map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={css.tab}
                  data-active={tab === id}
                  data-session-export-tab={id}
                  onClick={() => { setTab(id); setMenu(null) }}
                >
                  {id === 'turns' ? `${label}（${String(segments.length)}）` : label}
                </button>
              ))}
          </div>

          <div className={css.panel}>
            {needsRebuild && (
              <div className={css.hint} data-session-export-rebuild-reason>
                {`${entry.rebuildReason === 'broken' ? t('dialog.broken') : t('dialog.missing')} ${t('dialog.rebuildHint')}（${String(entry.rebuildTurns)}）`}
              </div>
            )}
            {reclassify && <div className={css.hint} data-session-export-reflow>{t('dialog.reflowHint')}</div>}
            {classification?.status === 'fallback' && (
              <div
                data-session-export-classify-warning
                style={{ color: 'var(--dsw-alias-state-error-primary, #ec1313)' }}
              >
                {`${t('dialog.classifyFailed')}：${classification.reason
                  ?? degraded.map((d) => `${d.name} ${String(d.missing + d.unknown)} ${t('dialog.classifyPartial')}${
                    d.unmatched.length > 0 ? `（${t('dialog.classifyUnmatched')}：${d.unmatched.join('、')}）` : ''
                  }`).join('；')}`}
              </div>
            )}
            {classification?.status === 'skipped' && (
              <div data-session-export-classify-skipped>{t('dialog.classifySkipped')}</div>
            )}
            {tab === 'turns' ? turnsPanel : tab === 'toc' ? tocPanel : strategyPanel}
          </div>

          {entry.inProgress && <div className={css.hint}>{t('dialog.inProgress')}</div>}
        </>
      )}
    </Modal>
  )
}
