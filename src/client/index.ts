/**
 * Browser half: the Session Header "导出对话为 Markdown" entry and its
 * preview/commit dialog over the host route `POST /api/session.export-md`.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { SessionExportController } from './controller.ts'
import type { SessionExportInjected } from './Dialog.tsx'
import { registerSessionExportMenuEntry, SessionExportHeaderAction, type SessionExportMenuLike } from './HeaderAction.tsx'
import { en, NS, zh, type SessionExportKey } from './locales.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionExport: SessionExportController
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'session-export-md': SessionExportKey
  }
}

export type { ExportEntry, ExportPhase, SegmentView, SessionExportState, TocModuleView } from './controller.ts'

export const inject = ['slots', 'locale']

/** 宿主目录选择器（可选能力）：`ctx.remote.directoryPicker.pick()` 打开系统选择框。 */
interface RemoteDirectoryPickerLike {
  pick?: (signal?: AbortSignal) => Promise<unknown>
}

/**
 * 探测宿主目录选择能力。
 * 目录选择 seam 的约定是「没有能力时隐藏入口，而不是报错」，
 * 所以这里用可选探测（不写进 inject），拿不到就返回 undefined → 界面不显示按钮。
 * @param ctx - browser context.
 * @returns 调用函数（返回绝对路径或 null=用户取消），无原生能力时为 undefined。
 */
function detectDirectoryPicker(ctx: ClientContext): (() => Promise<string | null>) | undefined {
  const remote = ctx.get('remote') as { directoryPicker?: RemoteDirectoryPickerLike } | undefined
  const pick = remote?.directoryPicker?.pick
  if (typeof pick !== 'function') return undefined
  return async () => {
    const result = (await pick.call(remote!.directoryPicker)) as unknown
    if (typeof result === 'string') return result
    if (result === null || result === undefined) return null
    const wrapped = result as { ok?: boolean; value?: unknown }
    if (wrapped.ok === true && typeof wrapped.value === 'string') return wrapped.value
    throw new Error('directory picker failed')
  }
}

/**
 * Provide the export controller, register the export entry into the shared
 * Session Header more-actions menu (second item, after "Download session log"),
 * and mount the dialog into the Session Header utilities slot.
 * @param ctx - browser context carrying slots and locale services.
 */
export function apply(ctx: ClientContext): void {
  const pickDirectory = detectDirectoryPicker(ctx)
  const controller = new SessionExportController(undefined, {
    ...(pickDirectory !== undefined ? { pickDirectory } : {}),
  })
  const translate = ctx.locale.bind(NS)
  ctx.provide('sessionExport', controller)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'session-export-md: browser dictionaries')

  // The menu registry comes from the session-log-export browser plugin; without
  // it (a deployment that does not mount that package) this plugin keeps its
  // own more-actions button.
  const menu = ctx.get('sessionLogMenu') as SessionExportMenuLike | undefined
  if (menu !== undefined) {
    ctx.effect(
      () => registerSessionExportMenuEntry(
        menu,
        (sessionId: SessionId) => controller.preview(sessionId),
        () => translate('menu.export'),
      ),
      'session-export-md: header menu entry',
    )
  }

  ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
    name: 'conversation.session.header.utilities',
    id: 'session-export-md',
    locale: NS,
    inject: (): SessionExportInjected => ({
      hooks: { sessionExport: controller.store },
      standaloneButton: menu === undefined,
      preview: (sessionId: SessionId) => controller.preview(sessionId),
      commit: (sessionId: SessionId) => controller.commit(sessionId),
      rebuild: (sessionId: SessionId) => controller.rebuild(sessionId),
      selectStrategy: (sessionId: SessionId, strategyId: string) => controller.selectStrategy(sessionId, strategyId),
      openDesignChat: (sessionId: SessionId) => { controller.openDesignChat(sessionId) },
      sendChat: (sessionId: SessionId, text: string) => controller.sendChat(sessionId, text),
      saveChatStrategy: (sessionId: SessionId) => controller.saveChatStrategy(sessionId),
      closeChat: (sessionId: SessionId) => { controller.closeDesignChat(sessionId) },
      openManager: (sessionId: SessionId) => controller.openManager(sessionId),
      closeManager: (sessionId: SessionId) => { controller.closeManager(sessionId) },
      editDraft: (sessionId: SessionId, id: string) => { controller.editDraft(sessionId, id) },
      newDraft: (sessionId: SessionId) => { controller.newDraft(sessionId) },
      cancelDraft: (sessionId: SessionId) => { controller.cancelDraft(sessionId) },
      saveDraft: (sessionId: SessionId) => controller.saveDraft(sessionId),
      setDraftField: (sessionId, patch) => { controller.setDraftField(sessionId, patch) },
      setDraftDimension: (sessionId, dimensionIndex, patch) => {
        controller.setDraftDimension(sessionId, dimensionIndex, patch)
      },
      setDraftModule: (sessionId, dimensionIndex, moduleIndex, patch) => {
        controller.setDraftModule(sessionId, dimensionIndex, moduleIndex, patch)
      },
      addDraftModule: (sessionId: SessionId, dimensionIndex: number) => {
        controller.addDraftModule(sessionId, dimensionIndex)
      },
      removeDraftModule: (sessionId: SessionId, dimensionIndex: number, moduleIndex: number) => {
        controller.removeDraftModule(sessionId, dimensionIndex, moduleIndex)
      },
      toggleImport: (sessionId: SessionId) => { controller.toggleImport(sessionId) },
      setImportText: (sessionId: SessionId, value: string) => { controller.setImportText(sessionId, value) },
      importStrategy: (sessionId: SessionId) => controller.importStrategy(sessionId),
      deleteStrategy: (sessionId: SessionId, id: string) => controller.deleteStrategy(sessionId, id),
      dismiss: (sessionId: SessionId) => { controller.dismiss(sessionId) },
      setPath: (sessionId: SessionId, value: string) => { controller.setPathDraft(sessionId, value) },
      canPickDirectory: pickDirectory !== undefined,
      pickDirectory: (sessionId: SessionId) => controller.chooseDirectory(sessionId),
      setLabel: (sessionId: SessionId, no: number, dimensionId: string, moduleName: string) => {
        controller.setSegmentLabel(sessionId, no, dimensionId, moduleName)
      },
    }),
  }, SessionExportHeaderAction))
}

export type { SessionExportDialogProps, SessionExportInjected } from './Dialog.tsx'
