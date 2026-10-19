/**
 * export_conversation 工具入口（阶段 6，建议 1/2 落地）：
 * - 参数全默认（仅可选 path），schema 描述 2–3 句；
 * - 结果只回摘要（状态、文件、段数、标题），绝不回传全文。
 */

import type { ExportService, ExportStatus } from './export-service.js'

export const EXPORT_TOOL_NAME = 'export_conversation'

export interface ExportToolArgs {
  path?: string
}

export function buildExportToolSchema(): {
  name: string
  description: string
  inputSchema: Record<string, unknown>
} {
  return {
    name: EXPORT_TOOL_NAME,
    description:
      '把当前会话尚未导出的对话增量导出为 Markdown 文件（按语义自动分类并生成标题，只追加不重写；无新对话时返回提示）。',
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: '导出文件路径（可选；默认使用上次导出路径，首次为工作区 .chat-exports 目录）',
        },
      },
    },
  }
}

export interface ToolResult {
  text: string
  data: ExportStatus
}

/** 摘要式结果（建议 2）：不回传 md 全文，LLM 只需转述。 */
export function summarize(status: ExportStatus): ToolResult {
  switch (status.status) {
    case 'no_new':
      return {
        text: `无新对话，本次导出不生效（文件：${status.file}）${status.inProgress ? '；当前有一轮尚未完成，不计入导出' : ''}`,
        data: status,
      }
    case 'error':
      return { text: `导出失败：${status.message}`, data: status }
    default:
      return {
        text: `${status.rebuilt === true ? '已重建' : '已导出'} ${status.appendedSegments} 段到 ${status.file}：${status.titles.join('、')}${status.inProgress ? '（另有一轮进行中未包含）' : ''}`,
        data: status,
      }
  }
}

export async function runExportTool(
  service: Pick<ExportService, 'run'>,
  args?: ExportToolArgs,
): Promise<ToolResult> {
  return summarize(await service.run(args?.path))
}
