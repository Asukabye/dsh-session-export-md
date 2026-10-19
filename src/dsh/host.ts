/**
 * 宿主装配：从 DSH Context 构建框架无关的 ExportService（GUI 路由与工具双入口共用，建议 9）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionHeader, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { StrategyStore, type KvTable } from '../core/strategies.js'
import { ExportService, type ExportDeps } from '../service/export-service.js'
import { CategorizeStore, SessionPrefStore, WatermarkStore } from '../service/persistence.js'
import {
  buildRouter,
  domainTableToKvTable,
  persistenceEventsSource,
  resolveSessionRoute,
  workspaceFsAdapter,
  type ExportLlmEnv,
} from './adapters.js'
import { exportDomainSpec } from './domain.js'

export type { ExportLlmEnv } from './adapters.js'

interface SessionsLike {
  get(id: SessionId): unknown
  flush(session: unknown): Promise<void>
}

interface TitleSnapshot {
  readonly sessionId: SessionId
  readonly status: 'fulfilled' | 'rejected'
  readonly value?: { readonly title?: { readonly title?: string } }
}

interface SessionQueryLike {
  readTitleSnapshots(ids: readonly SessionId[], signal?: AbortSignal): Promise<readonly TitleSnapshot[]>
}

/**
 * 会话标题解析：header.title → sessionQuery 标题投影 → 去 `session-` 前缀的 id 片段。
 * DSH 的 SessionHeader 通常不带 title，标题由 session-title 投影拥有。
 */
async function resolveSessionTitle(
  ctx: Context,
  sessionId: SessionId,
  header: SessionHeader,
): Promise<string> {
  const fromHeader = (header as unknown as { title?: string }).title
  if (typeof fromHeader === 'string' && fromHeader.trim() !== '') return fromHeader.trim()

  const sessionQuery = ctx.get('sessionQuery') as SessionQueryLike | undefined
  if (sessionQuery !== undefined) {
    try {
      const snapshots = await sessionQuery.readTitleSnapshots([sessionId])
      const first = snapshots[0]
      const text =
        first !== undefined && first.status === 'fulfilled' ? first.value?.title?.title : undefined
      if (typeof text === 'string' && text.trim() !== '') return text.trim()
    } catch {
      // 标题不可得（无投影/后端缺失）：继续回退
    }
  }
  return sessionId.replace(/^session-/, '').slice(0, 8) || 'session'
}

/**
 * One opened domain per storage facility. `DomainFacility.open` refuses a second
 * open of the same domain name in one process, so every request (GUI preview,
 * GUI commit, tool call) must reuse the first open instead of opening again.
 * The facility instance is the cache key, so the host row and the preset-plane
 * tool row share one domain.
 */
const kvByFacility = new WeakMap<object, Promise<KvTable>>()

export function openExportKv(storageDomain: DomainFacility): Promise<KvTable> {
  const key = storageDomain as unknown as object
  const cached = kvByFacility.get(key)
  if (cached !== undefined) return cached
  const opened = storageDomain
    .open(exportDomainSpec)
    .then((domain) => domainTableToKvTable(domain.table('export')))
  kvByFacility.set(key, opened)
  // A failed open must not be memoized: a later request retries instead of
  // inheriting a permanent rejection.
  void opened.catch(() => { kvByFacility.delete(key) })
  return opened
}

/** 组装一个会话的导出服务（域名、KV、事件源、文件系统、LLM 路由全部接线）。 */
export async function buildExportService(
  ctx: Context,
  sessionId: SessionId,
  header: SessionHeader,
  env: ExportLlmEnv,
): Promise<ExportService> {
  const storageDomain = ctx.get('storageDomain') as DomainFacility
  const kv = await openExportKv(storageDomain)

  const strategies = new StrategyStore(kv)

  const persistence = ctx.get('sessionPersistence') as SessionPersistence
  const sessions = ctx.get('sessions') as SessionsLike | undefined

  const title = await resolveSessionTitle(ctx, sessionId, header)
  const events = persistenceEventsSource(persistence, sessions, sessionId)
  // 辅助调用跟随会话当前模型路由（日志里的 request/header），拿不到才用配置默认。
  const sessionRoute = await resolveSessionRoute(events)
  const deps: ExportDeps = {
    events,
    fs: workspaceFsAdapter(header.cwd ?? process.cwd()),
    watermarks: new WatermarkStore(kv, sessionId),
    categorize: new CategorizeStore(kv, sessionId),
    prefs: new SessionPrefStore(kv, sessionId),
    strategies,
    router: buildRouter(ctx, env, sessionId, sessionRoute),
    session: {
      id: sessionId,
      title,
      ...(header.cwd !== undefined ? { workspace: header.cwd } : {}),
      createdAtMs: header.createdAt,
    },
    now: () => Date.now(),
  }
  return new ExportService(deps)
}
