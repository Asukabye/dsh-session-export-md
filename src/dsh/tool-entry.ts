/**
 * Agent 预设层入口（/tool 子路径）：注册模型可见的 export_conversation 工具。
 * 挂载方式（standard 预设等 agent 组合）：
 *   - id: session-export-tool
 *     name: '@deepseek-ai/dsh-session-export-md/tool'
 * @module @deepseek-ai/dsh-session-export-md/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-storage-domain'
import { registerExportTool } from './tool-registration.js'
import { ExportPluginConfig, type ExportPluginConfig as ConfigType } from './config.js'

export const name = 'session-export-tool'

export const inject = ['tools', 'storageDomain', 'sessionPersistence', 'sessions']

/** 与宿主行相同的 LLM 配置 schema（两行独立配置，默认值一致）。 */
export interface Config extends ConfigType {}

export const Config = ExportPluginConfig

export function apply(ctx: Context, config: Config = {}): void {
  registerExportTool(ctx, config)
}
