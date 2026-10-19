import { useState } from 'react'
import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionExportDialogProps } from './Dialog.tsx'

/**
 * 分类策略设计对话：与 LLM 多轮沟通，产出可保存的分类策略。
 * 保存后自动设为该会话当前策略并重新预览。
 * @param props - Session runtime, export controller bindings, and localized copy.
 * @returns the design-chat modal.
 */
export function StrategyDesignDialog({
  sessionId, useSessionExport, sendChat, saveChatStrategy, closeChat, t,
}: SessionExportDialogProps): ReactNode {
  const entry = useSessionExport(state => state.bySession[String(sessionId)])
  const [draft, setDraft] = useState('')
  const open = entry?.chatOpen === true
  const busy = entry?.chatBusy === true
  const messages = entry?.chatMessages ?? []
  const strategyReady = entry?.chatStrategy != null

  const submit = (): void => {
    const text = draft.trim()
    if (text === '' || busy) return
    setDraft('')
    void sendChat(sessionId, text)
  }

  return (
    <Modal
      open={open}
      onClose={() => { closeChat(sessionId) }}
      title={t('design.title')}
      description={t('design.hint')}
      closeLabel={t('dialog.close')}
      footer={(
        <>
          <Button variant="ghost" onClick={() => { closeChat(sessionId) }}>{t('dialog.close')}</Button>
          <Button
            variant="primary"
            disabled={!strategyReady || busy}
            onClick={() => { void saveChatStrategy(sessionId) }}
          >
            {t('design.save')}
          </Button>
        </>
      )}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div
          data-strategy-design-log
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            maxHeight: '300px',
            overflowY: 'auto',
            whiteSpace: 'pre-wrap',
          }}
        >
          {messages.length === 0 && <div>{t('design.empty')}</div>}
          {messages.map((message, index) => (
            <div
              key={`${message.role}-${String(index)}`}
              style={{
                padding: '6px 8px',
                borderRadius: '6px',
                background: message.role === 'user' ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
              }}
            >
              <b>{message.role === 'user' ? t('design.you') : t('design.llm')}：</b>
              {message.content}
            </div>
          ))}
          {busy && <div>{t('design.thinking')}</div>}
          {entry?.chatError != null && <div>{`${t('design.failed')}：${entry.chatError}`}</div>}
        </div>
        <Input
          data-strategy-design-input
          value={draft}
          placeholder={t('design.placeholder')}
          onChange={(event) => { setDraft(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') submit() }}
        />
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button variant="primary" disabled={busy || draft.trim() === ''} onClick={submit}>
            {t('design.send')}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

/** 复用导出对话框的注入面类型（同一槽位贡献）。 */
export type StrategyDesignProps = SessionExportDialogProps
