/**
 * Cordis 插件入口（宿主层）：只注册 GUI 路由 POST /api/session.export-md。
 * 模型可见工具 export_conversation 由 /tool 子入口在 agent 预设层注册
 * （Web 预设代理只读取预设层工具注册，宿主层注册不会进入模型目录）。
 * @module @deepseek-ai/dsh-session-export-md
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { registerExportRoute } from './route.js'
import { ExportPluginConfig, type ExportPluginConfig as ConfigType } from './config.js'

export const name = 'session-export-md'

/**
 * 依赖：路由、存储域、会话持久化。`llm` 不列入 inject —— 插件必须在没有模型平面
 * 的部署里也能加载（此时回退到配置的 OpenAI 兼容端点），故在请求时用 `ctx.get('llm')` 取用。
 */
export const inject = ['connection', 'storageDomain', 'sessionPersistence', 'sessions']

/**
 * 部署配置：显式 provider/model 覆盖（留空则跟随会话当前模型路由）、本地端点，
 * 以及宿主无 `llm` 服务时的兜底端点。模型凭据由 DSH 的 credentials 服务解析
 * （`$DSH_HOME/.credentials.yaml` 或环境变量），不落插件配置。
 */
export interface Config extends ConfigType {}

export const Config = ExportPluginConfig

export function apply(ctx: Context, config: Config = {}): void {
  ctx.effect(() => registerExportRoute(ctx, config), 'session-export-md: route')
}

export { buildExportService } from './host.js'
export type { ExportLlmEnv } from './adapters.js'
