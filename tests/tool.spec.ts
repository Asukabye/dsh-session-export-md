import { describe, expect, it } from 'vitest'
import { buildExportToolSchema, runExportTool, summarize } from '../src/service/tool.js'

describe('export_conversation 工具', () => {
  it('schema：参数全默认（仅可选 path），描述简短', () => {
    const s = buildExportToolSchema()
    expect(s.name).toBe('export_conversation')
    expect(s.inputSchema).toMatchObject({ type: 'object' })
    const props = s.inputSchema.properties as Record<string, unknown>
    expect(props.path).toBeTruthy()
    expect(s.description.length).toBeLessThan(120)
  })

  it('摘要式结果（不回传全文）', () => {
    expect(summarize({ status: 'no_new', file: 'a.md', inProgress: false }).text).toContain('无新对话')
    expect(summarize({ status: 'no_new', file: 'a.md', inProgress: true }).text).toContain('尚未完成')
    expect(
      summarize({ status: 'ok', file: 'a.md', appendedSegments: 2, titles: ['甲', '乙'], inProgress: false }).text,
    ).toContain('已导出 2 段到 a.md：甲、乙')
    expect(summarize({ status: 'error', message: 'x' }).text).toContain('导出失败：x')
  })

  it('runExportTool 调用 service.run 并摘要（透传 path 参数）', async () => {
    const calls: (string | undefined)[] = []
    const fake = {
      async run(path?: string) {
        calls.push(path)
        return { status: 'no_new' as const, file: 'a.md', inProgress: false }
      },
    }
    const r = await runExportTool(fake, { path: 'out.md' })
    expect(calls).toEqual(['out.md'])
    expect(r.text).toContain('无新对话')
  })
})
