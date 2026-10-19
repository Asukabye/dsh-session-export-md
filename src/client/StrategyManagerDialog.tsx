import type { ReactNode } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SessionExportDialogProps } from './Dialog.tsx'

/**
 * 策略管理：列出容器里的分类策略并支持删除 / 新建 / 导入 / 编辑。
 * 编辑与新建共用同一张表单；策略由**两个（或更多）维度**组成，
 * 每个维度有自己的模块表与兜底模块。
 * @param props - Session runtime, export controller bindings, and localized copy.
 * @returns the strategy-manager modal.
 */
export function StrategyManagerDialog({
  sessionId, useSessionExport, t,
  closeManager, newDraft, editDraft, cancelDraft, deleteStrategy, saveDraft,
  setDraftField, setDraftDimension, setDraftModule, addDraftModule, removeDraftModule,
  toggleImport, setImportText, importStrategy,
}: SessionExportDialogProps): ReactNode {
  const entry = useSessionExport(state => state.bySession[String(sessionId)])
  const open = entry?.manageOpen === true
  const busy = entry?.manageBusy === true
  const list = entry?.manageList ?? []
  const draft = entry?.draft ?? null
  const notice = entry?.manageNotice ?? null
  const importOpen = entry?.importOpen === true

  const noticeText = notice === null
    ? ''
    : notice.kind === 'saved'
      ? `${t('manage.saved')}：${notice.name ?? ''}`
      : notice.kind === 'imported'
        ? `${t('manage.imported')}：${notice.name ?? ''}`
        : notice.kind === 'deleted'
          ? t('manage.deleted')
          : t('manage.notFound')

  const footer = draft !== null
    ? (
        <>
          <Button variant="ghost" onClick={() => { cancelDraft(sessionId) }}>{t('manage.cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { void saveDraft(sessionId) }}>
            {t('manage.save')}
          </Button>
        </>
      )
    : (
        <>
          <Button variant="ghost" onClick={() => { closeManager(sessionId) }}>{t('dialog.close')}</Button>
          <Button variant="ghost" onClick={() => { toggleImport(sessionId) }}>{t('manage.import')}</Button>
          <Button variant="primary" onClick={() => { newDraft(sessionId) }}>{t('manage.new')}</Button>
        </>
      )

  return (
    <Modal
      open={open}
      onClose={() => { closeManager(sessionId) }}
      title={t('manage.title')}
      description={t('manage.hint')}
      closeLabel={t('dialog.close')}
      footer={footer}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        {noticeText !== '' && <div data-strategy-notice>{noticeText}</div>}
        {entry?.manageError != null && (
          <div data-strategy-error style={{ color: 'var(--dsw-alias-text-danger, #b91c1c)' }}>{entry.manageError}</div>
        )}

        {importOpen && draft === null && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <div>{t('manage.importHint')}</div>
            <textarea
              data-strategy-import
              rows={6}
              value={entry?.importText ?? ''}
              placeholder={'{"id":"my-strategy","name":"…","dimensions":[{"id":"phase","name":"开发阶段","modules":[{"name":"…"}],"defaultModule":"…"}]}'}
              onChange={(event) => { setImportText(sessionId, event.target.value) }}
              style={{ width: '100%', fontFamily: 'monospace', fontSize: '12px' }}
            />
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <Button
                variant="primary"
                disabled={busy || (entry?.importText ?? '').trim() === ''}
                onClick={() => { void importStrategy(sessionId) }}
              >
                {t('manage.importConfirm')}
              </Button>
            </div>
          </div>
        )}

        {draft !== null && (
          <div data-strategy-editor style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span>{t('manage.name')}</span>
              <Input
                data-strategy-name
                value={draft.name}
                placeholder={t('manage.namePlaceholder')}
                onChange={(event) => { setDraftField(sessionId, { name: event.target.value }) }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <span>{t('manage.id')}</span>
              <Input
                data-strategy-id
                value={draft.id}
                disabled={draft.existing}
                onChange={(event) => { setDraftField(sessionId, { id: event.target.value }) }}
              />
            </label>

            {draft.dimensions.map((dimension, dimensionIndex) => (
              <div
                key={dimension.id}
                data-strategy-dimension={dimension.id}
                style={{ display: 'flex', flexDirection: 'column', gap: '6px', border: '1px solid var(--dsw-alias-border-l2, #e5e7eb)', borderRadius: '6px', padding: '8px' }}
              >
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span>{`${t('manage.dimension')} ${String(dimensionIndex + 1)}`}</span>
                  <Input
                    data-strategy-dimension-name
                    value={dimension.name}
                    placeholder={t('manage.dimensionName')}
                    onChange={(event) => { setDraftDimension(sessionId, dimensionIndex, { name: event.target.value }) }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                  <span>{t('manage.defaultModule')}</span>
                  <select
                    data-strategy-default
                    value={dimension.defaultModule}
                    onChange={(event) => { setDraftDimension(sessionId, dimensionIndex, { defaultModule: event.target.value }) }}
                  >
                    {dimension.modules.map((m, index) => (
                      <option key={`${m.name}-${String(index)}`} value={m.name}>
                        {m.name === '' ? t('manage.unnamed') : m.name}
                      </option>
                    ))}
                  </select>
                </label>
                <div>{`${t('manage.modules')}（${String(dimension.modules.length)}）`}</div>
                <div data-strategy-modules style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                  {dimension.modules.map((m, moduleIndex) => (
                    <div
                      key={String(moduleIndex)}
                      style={{ display: 'flex', flexDirection: 'column', gap: '4px', background: 'var(--dsw-alias-bg-l1, #fafafa)', borderRadius: '5px', padding: '6px' }}
                    >
                      <div style={{ display: 'flex', gap: '6px', alignItems: 'center' }}>
                        <Input
                          value={m.name}
                          placeholder={t('manage.moduleName')}
                          onChange={(event) => { setDraftModule(sessionId, dimensionIndex, moduleIndex, { name: event.target.value }) }}
                        />
                        <Button
                          variant="ghost"
                          disabled={dimension.modules.length <= 1}
                          onClick={() => { removeDraftModule(sessionId, dimensionIndex, moduleIndex) }}
                        >
                          {t('manage.removeModule')}
                        </Button>
                      </div>
                      <Input
                        value={m.description}
                        placeholder={t('manage.moduleDescription')}
                        onChange={(event) => { setDraftModule(sessionId, dimensionIndex, moduleIndex, { description: event.target.value }) }}
                      />
                      <Input
                        value={m.examples}
                        placeholder={t('manage.moduleExamples')}
                        onChange={(event) => { setDraftModule(sessionId, dimensionIndex, moduleIndex, { examples: event.target.value }) }}
                      />
                    </div>
                  ))}
                </div>
                <div>
                  <Button variant="ghost" onClick={() => { addDraftModule(sessionId, dimensionIndex) }}>
                    {t('manage.addModule')}
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}

        {draft === null && (
          <div>
            {list.length === 0
              ? <div>{t('manage.empty')}</div>
              : (
                  <ul data-strategy-list style={{ margin: 0, padding: 0, listStyle: 'none', maxHeight: '320px', overflowY: 'auto' }}>
                    {list.map((strategy) => (
                      <li
                        key={strategy.id}
                        style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}
                      >
                        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {`${strategy.name}（${strategy.id} · ${strategy.source} · ${
                            strategy.dimensions.map((d) => `${d.name} ${String(d.modules.length)}`).join(' / ')
                          }）`}
                        </span>
                        <Button variant="ghost" onClick={() => { editDraft(sessionId, strategy.id) }}>{t('manage.edit')}</Button>
                        <Button
                          variant="ghost"
                          disabled={busy || strategy.builtin}
                          onClick={() => { void deleteStrategy(sessionId, strategy.id) }}
                        >
                          {t('manage.delete')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
          </div>
        )}
      </div>
    </Modal>
  )
}
