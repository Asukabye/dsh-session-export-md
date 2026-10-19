/**
 * 插件共享配置（宿主路由行与预设工具行共用同一 schema，各自可独立配置）。
 */

import Schema from '@deepseek-ai/schemastery'

export interface ExportPluginConfig {
  /** 显式 provider 路由；空 = 跟随会话当前模型路由。 */
  provider?: string
  /** 显式模型；空 = 跟随会话当前模型路由。 */
  model?: string
  /** 本地 OpenAI 兼容端点（如 http://127.0.0.1:11434/v1）；空 = 未配置本地。 */
  localBaseUrl?: string
  /** 本地模型名。 */
  localModel?: string
  /** 宿主无 llm 服务时的兜底端点（该路径读 DEEPSEEK_API_KEY 环境变量）。 */
  remoteBaseUrl?: string
  /** 兜底端点模型名。 */
  remoteModel?: string
}

export const ExportPluginConfig: Schema<ExportPluginConfig> = Schema.object({
  provider: Schema.string().default(''),
  model: Schema.string().default(''),
  localBaseUrl: Schema.string().default(''),
  localModel: Schema.string().default(''),
  remoteBaseUrl: Schema.string().default('https://api.deepseek.com'),
  remoteModel: Schema.string().default('deepseek-flash'),
})
