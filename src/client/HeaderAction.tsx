import { useState } from 'react'
import type { ReactNode } from 'react'
import { IconEllipsisOutline16, IconListPenOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { SessionExportDialog, type SessionExportDialogProps } from './Dialog.tsx'
import { StrategyDesignDialog } from './StrategyDesignDialog.tsx'
import { StrategyManagerDialog } from './StrategyManagerDialog.tsx'
import css from './HeaderAction.module.css'

/**
 * Menu surface this plugin's entry registers into: the registry provided as
 * `ctx.sessionLogMenu` by the session-log-export browser plugin, so the export
 * entry renders as the SECOND item of the shared Session Header more-actions
 * menu instead of a menu of its own.
 */
export interface SessionExportMenuLike {
  register(entry: {
    readonly id: string
    readonly label: () => string
    readonly icon?: ReactNode
    readonly onSelect: (sessionId: SessionId) => void
  }): () => void
}

/**
 * Register the Markdown export entry into the shared more-actions menu.
 * @param menu - the session-log-export menu registry.
 * @param preview - opens this session's export dialog.
 * @param label - locale-bound label read at render time.
 * @returns the disposal that removes the entry.
 */
export function registerSessionExportMenuEntry(
  menu: SessionExportMenuLike,
  preview: (sessionId: SessionId) => Promise<void>,
  label: () => string,
): () => void {
  return menu.register({
    id: 'session-export-md',
    label,
    icon: <IconListPenOutline16 />,
    onSelect: (sessionId) => { void preview(sessionId) },
  })
}

/**
 * The Session Header contribution: the shared dialog, plus a standalone
 * more-actions button only when the host menu registry is absent (a deployment
 * that does not mount session-log-export).
 * @param props - Session runtime, export controller bindings, and localized copy.
 * @returns the Header contribution and Session-scoped dialog.
 */
export function SessionExportHeaderAction(props: SessionExportDialogProps): ReactNode {
  const { sessionId, preview, standaloneButton, t } = props
  const entry = props.useSessionExport(state => state.bySession[String(sessionId)])
  const busy = entry?.phase === 'previewing' || entry?.phase === 'committing'
  const [open, setOpen] = useState(false)

  if (!standaloneButton) {
    return (
      <>
        <SessionExportDialog {...props} />
        <StrategyDesignDialog {...props} />
        <StrategyManagerDialog {...props} />
      </>
    )
  }

  return (
    <>
      <Menu
        open={open}
        align="end"
        dense
        onClose={() => { setOpen(false) }}
        items={[{ id: 'export-md', label: t('menu.export'), icon: <IconListPenOutline16 />, disabled: busy }]}
        onSelect={() => {
          setOpen(false)
          void preview(sessionId)
        }}
        anchor={(
          <button
            type="button"
            className={css.moreButton}
            aria-label={t('header.more')}
            aria-haspopup="menu"
            aria-expanded={open}
            aria-busy={busy}
            onClick={() => { setOpen(value => !value) }}
          >
            <IconEllipsisOutline16 />
          </button>
        )}
      />
      <SessionExportDialog {...props} />
      <StrategyDesignDialog {...props} />
      <StrategyManagerDialog {...props} />
    </>
  )
}
