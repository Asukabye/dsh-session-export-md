/**
 * DSH 服务 → 框架无关接口的适配层（集成阶段）：
 * - domainTableToKvTable：storage-domain 表 ↔ 核心 KvTable（附 __keys__ 索引，不依赖表 API 的 keys() 语义）；
 * - persistenceEventsSource：会话事件源（flush 活跃会话 → 读句柄 → 事件数组）；
 * - workspaceFsAdapter：以会话 cwd 为根的节点文件系统适配；
 * - resolveSessionRoute / buildRouter：解析会话当前模型路由并构建线上（宿主模型平面）+ 本地 LLM 路由。
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { KvTable as DomainKvTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '../core/strategies.js'
import type { SessionEvent } from '../core/types.js'
import { createOpenAiCompatibleClient, LlmRouter, type LlmSlotConfig } from '../llm/client.js'
import { createHostLlmClient, type HostLlmService } from '../llm/host-client.js'
import type { FsAdapter, SessionEventSource } from '../service/export-service.js'

/**
 * 把 storage-domain 表适配为核心 KvTable。
 * 表 API：同步 get/keys、异步 put/delete（见 storage-domain 的 KvTable 契约）。
 */
export function domainTableToKvTable(
  table: DomainKvTable<string, { value: string }>,
): KvTable {
  return {
    async get(key) {
      return table.get(key)?.value ?? null
    },
    async set(key, value) {
      await table.put(key, { value })
    },
    async delete(key) {
      await table.delete(key)
    },
    async keys() {
      return [...table.keys()]
    },
  }
}

interface SessionsLike {
  get(id: SessionId): unknown
  flush(session: unknown): Promise<void>
}

/**
 * 会话事件源：先 flush 活跃会话（含进行中的工具调用自身），再经读句柄取全部事件。
 * 会话不存在时由 open 抛出（调用方决定 404/错误呈现）。
 */
export function persistenceEventsSource(
  persistence: SessionPersistence,
  sessions: SessionsLike | undefined,
  sessionId: SessionId,
): SessionEventSource {
  return {
    async events(): Promise<readonly SessionEvent[]> {
      const live = sessions?.get(sessionId)
      if (live !== undefined && sessions !== undefined) await sessions.flush(live)
      const handle = await persistence.open(sessionId, 'read')
      try {
        const { events } = await handle.read(0, undefined)
        return events as unknown as readonly SessionEvent[]
      } finally {
        await handle.close()
      }
    },
  }
}

/** 以会话工作区为根的节点文件系统适配（相对路径解析到 cwd 下）。 */
export function workspaceFsAdapter(root: string): FsAdapter {
  const toAbs = (p: string): string => (isAbsolute(p) ? p : resolve(root, p))
  return {
    async readFile(path) {
      try {
        return await readFile(toAbs(path), 'utf8')
      } catch {
        return null
      }
    },
    async writeFile(path, content) {
      const abs = toAbs(path)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content, 'utf8')
    },
  }
}

export interface ExportLlmEnv {
  /** 显式 provider 路由（空 = 跟随会话当前模型路由）。 */
  provider?: string
  /** 显式模型（空 = 跟随会话当前模型路由）。 */
  model?: string
  /** 无 `llm` 服务时的兜底 OpenAI 兼容端点（此时才读 DEEPSEEK_API_KEY 环境变量）。 */
  remoteBaseUrl?: string
  remoteModel?: string
  localBaseUrl?: string
  localModel?: string
}

/** 会话当前模型路由（取自日志里最后一条 request/header）。 */
export interface SessionLlmRoute {
  readonly provider: string
  readonly model: string
}

function pick(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (value !== undefined && value !== '') return value
  }
  return ''
}

/**
 * 会话当前模型路由：读日志里最后一条 `request/header`（data.header.config）。
 * 让插件的辅助调用跟随用户在界面上选的模型，而不是写死一个 model id。
 * 会话日志不可读时返回 undefined，由调用方回退配置默认。
 */
export async function resolveSessionRoute(
  source: SessionEventSource,
): Promise<SessionLlmRoute | undefined> {
  try {
    const events = await source.events()
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i]!
      if (event.type !== 'request/header') continue
      const config = (event.data as { header?: { config?: unknown } } | undefined)?.header?.config
      const route = config as { provider?: unknown; model?: unknown } | undefined
      if (
        typeof route?.provider === 'string' &&
        route.provider !== '' &&
        typeof route.model === 'string' &&
        route.model !== ''
      ) {
        return { provider: route.provider, model: route.model }
      }
    }
  } catch {
    // 日志不可读（会话已归档等）：交给配置默认
  }
  return undefined
}

/**
 * 从配置、会话路由与宿主模型平面构建 LLM 路由。
 *
 * 线上槽优先走 `ctx.llm`（凭据由 DSH 的 credentials 服务解析，复用重试/计量/缓存）；
 * 只有在宿主没有 `llm` 服务时才退回自建 HTTP 客户端（读 DEEPSEEK_API_KEY 环境变量）。
 * 路由优先级：显式配置 → 会话当前模型 → 内置默认。
 */
export function buildRouter(
  ctx: Context,
  env: ExportLlmEnv,
  sessionId?: SessionId,
  sessionRoute?: SessionLlmRoute,
): LlmRouter {
  const route = {
    provider: pick(env.provider, sessionRoute?.provider, 'deepseek-official'),
    model: pick(env.model, sessionRoute?.model, env.remoteModel, 'deepseek-flash'),
  }
  const llm = ctx.get('llm') as HostLlmService | undefined
  const remote =
    llm !== undefined && typeof llm.stream === 'function'
      ? createHostLlmClient(llm, route, sessionId)
      : createOpenAiCompatibleClient({
          baseUrl: pick(env.remoteBaseUrl, 'https://api.deepseek.com'),
          ...(process.env.DEEPSEEK_API_KEY !== undefined && process.env.DEEPSEEK_API_KEY !== ''
            ? { apiKey: process.env.DEEPSEEK_API_KEY }
            : {}),
          model: route.model,
        })
  const local =
    env.localBaseUrl !== undefined && env.localBaseUrl !== ''
      ? createOpenAiCompatibleClient({
          baseUrl: env.localBaseUrl,
          model: env.localModel !== undefined && env.localModel !== '' ? env.localModel : 'local',
        })
      : undefined
  const config: LlmSlotConfig = {
    classify: { kind: 'remote', model: remote.model },
    designStrategy: { kind: 'remote', model: remote.model },
  }
  return new LlmRouter(remote, local, config)
}
