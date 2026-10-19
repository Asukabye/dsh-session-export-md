/**
 * export_conversation 工具注册（阶段 6，建议 1/2）：参数全默认、结果只回摘要文本。
 * 调用者会话取自 exec.agent.session（与 tool-session-query 的授权前提一致）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { runExportTool } from '../service/tool.js'
import { buildExportService, type ExportLlmEnv } from './host.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerExportTool(ctx: Context, env: ExportLlmEnv): void {
  ctx.tools.register(defineTool({
    name: 'export_conversation',
    description:
      '把当前会话尚未导出的对话增量导出为 Markdown 文件（按语义自动分类并生成标题，只追加不重写；无新对话时返回提示）。',
    parameters: {
      path: {
        type: 'string',
        description: '导出文件路径（可选；默认使用上次导出路径，首次为工作区 .chat-exports 目录）',
      },
    },
    output: TEXT_OUTPUT,
    execute: async (args: { path?: string }, exec: ToolRunContext) => {
      const agent = exec.agent
      if (agent === undefined) {
        throw new Error('export_conversation 需要 agent 绑定的调用者')
      }
      const svc = await buildExportService(ctx, agent.session.id, agent.session.header, env)
      const result = await runExportTool(svc, args)
      return result.text
    },
  }))
}
