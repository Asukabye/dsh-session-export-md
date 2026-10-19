/**
 * GUI 入口的 Host 路由（阶段 5）：POST /api/session.export-md?sessionId=<id>
 * 动作：preview（无副作用计划）、commit（应用归类编辑后写入）、run（工具式直写，可带 path）。
 * 结果一律 JSON 摘要/计划，不回流文件内容。
 */

import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { LlmClientError } from '../llm/client.js'
import { HostLlmError } from '../llm/host-client.js'
import { buildExportService, type ExportLlmEnv } from './host.js'

export const EXPORT_MD_PATH = '/api/session.export-md'

/**
 * 动作失败响应：模型平面的失败（凭据缺失、上游错误）回 502 并带上可读原因，
 * 其余内部错误回 500。正文会被对话框原样展示，故不留堆栈。
 */
function failureResponse(prefix: string, error: unknown): Response {
  const detail = error instanceof Error ? error.message : String(error)
  const isLlm = error instanceof LlmClientError || error instanceof HostLlmError
  return new Response(`${prefix} failed: ${detail}`, { status: isLlm ? 502 : 500 })
}

interface ConnectionLike {
  fetch: {
    register(route: {
      path: string
      methods: readonly 'POST'[]
      requestBody: 'buffered'
      fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

interface RouteBody {
  action?:
    | 'preview'
    | 'commit'
    | 'rebuild'
    | 'run'
    | 'strategy-list'
    | 'strategy-chat'
    | 'strategy-save'
    | 'strategy-delete'
  /** 归类编辑：每轮给出新的双维 labels（dimensionId → 模块名）。 */
  edits?: { no: number; labels: Record<string, string> }[]
  path?: string
  /** 对话框选中的分类策略（预览/提交/重建/删除共用）。 */
  strategyId?: string
  /** 策略设计对话的历史消息。 */
  messages?: { role: 'user' | 'assistant'; content: string }[]
  /** 待保存的策略（对象或含 JSON 的文本）。 */
  strategy?: unknown
  /** 手动新建/编辑/导入时的来源标记（缺省沿用策略自带的 source）。 */
  source?: 'llm' | 'imported' | 'builtin'
}

export function registerExportRoute(ctx: Context, env: ExportLlmEnv): () => Promise<void> {
  const connection = Reflect.get(ctx, 'connection') as ConnectionLike
  return connection.fetch.register({
    path: EXPORT_MD_PATH,
    methods: ['POST'],
    requestBody: 'buffered',
    // A route handler must never throw: an escaped throw reaches the webserver's
    // per-request containment, which answers an opaque 400 with no body.
    fetch: async (request: Request): Promise<Response> => {
      try {
        return await handleExportRequest(ctx, request, env)
      } catch (error) {
        const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
        return new Response(`export route failed: ${detail}`, { status: 500 })
      }
    },
  })
}

async function handleExportRequest(
  ctx: Context,
  request: Request,
  env: ExportLlmEnv,
): Promise<Response> {
  const url = new URL(request.url)
  const sessionIdValue = url.searchParams.get('sessionId')
  if (sessionIdValue === null || sessionIdValue === '') {
    return new Response('missing sessionId query parameter', { status: 400 })
  }
  const sessionId = brandString<SessionId>(sessionIdValue)

  const persistence = ctx.get('sessionPersistence') as SessionPersistence
  let header: SessionHeader
  try {
    const handle = await persistence.open(sessionId, 'read')
    try {
      header = handle.header
    } finally {
      await handle.close()
    }
  } catch {
    return new Response('session not found', { status: 404 })
  }

  let body: RouteBody = {}
  try {
    body = (await request.json()) as RouteBody
  } catch {
    // 空 body 视为 run
  }

  const svc = await buildExportService(ctx, sessionId, header, env)

  if (body.action === 'strategy-list') {
    try {
      return Response.json({ strategies: await svc.listStrategies() })
    } catch (error) {
      return failureResponse('strategy-list', error)
    }
  }

  if (body.action === 'strategy-chat') {
    try {
      return Response.json(await svc.chatStrategy(body.messages ?? []))
    } catch (error) {
      return failureResponse('strategy-chat', error)
    }
  }

  if (body.action === 'strategy-save') {
    try {
      return Response.json(await svc.saveStrategy(body.strategy, {
        ...(body.source !== undefined ? { source: body.source } : {}),
      }))
    } catch (error) {
      return failureResponse('strategy-save', error)
    }
  }

  if (body.action === 'strategy-delete') {
    try {
      return Response.json(await svc.deleteStrategy(body.strategyId ?? ''))
    } catch (error) {
      return failureResponse('strategy-delete', error)
    }
  }

  if (body.action === 'preview') {
    try {
      return Response.json(await svc.preview(body.path, body.strategyId))
    } catch (error) {
      return failureResponse('preview', error)
    }
  }

  if (body.action === 'commit') {
    try {
      const plan = await svc.preview(body.path, body.strategyId)
      return Response.json(await svc.commit(plan, body.edits ?? []))
    } catch (error) {
      return failureResponse('commit', error)
    }
  }

  if (body.action === 'rebuild') {
    try {
      const plan = await svc.preview(body.path, body.strategyId)
      return Response.json(await svc.rebuild(plan, body.edits ?? []))
    } catch (error) {
      return failureResponse('rebuild', error)
    }
  }

  try {
    return Response.json(await svc.run(body.path))
  } catch (error) {
    return failureResponse('export', error)
  }
}
