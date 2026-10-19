import { describe, expect, it } from 'vitest'
import {
  ARTIFACT_ORDER,
  MAX_PER_KIND,
  artifactsOfToolCall,
  classifyArtifactPath,
  extractArtifacts,
} from '../src/core/artifacts.js'
import type { ToolCallRecord, Turn } from '../src/core/types.js'

function call(name: string, args: unknown): ToolCallRecord {
  return { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
}

function turnOf(
  toolCalls: ToolCallRecord[] = [],
  deliverables: { path: string; description?: string }[] = [],
): Pick<Turn, 'toolCalls' | 'deliverables'> {
  return { toolCalls, deliverables }
}

describe('classifyArtifactPath（路径 → 类别）', () => {
  it('目录约定优先：adr/decisions、prompts、diagrams、tests、reports', () => {
    expect(classifyArtifactPath('docs/adr/0001-use-sqlite.md')).toBe('决策')
    expect(classifyArtifactPath('decisions/0002.md')).toBe('决策')
    expect(classifyArtifactPath('prompts/system.md')).toBe('提示词')
    expect(classifyArtifactPath('diagrams/flow.mmd')).toBe('图表')
    expect(classifyArtifactPath('tests/renderer.spec.ts')).toBe('测试')
    expect(classifyArtifactPath('reports/coverage.html')).toBe('报告')
  })

  it('扩展名兜底：数据 / 文档 / 附件 / 代码', () => {
    expect(classifyArtifactPath('data/metrics.csv')).toBe('数据')
    expect(classifyArtifactPath('config/a.yaml')).toBe('数据')
    expect(classifyArtifactPath('docs/design.md')).toBe('文档')
    expect(classifyArtifactPath('notes.txt')).toBe('文档')
    expect(classifyArtifactPath('assets/logo.png')).toBe('附件')
    expect(classifyArtifactPath('dist/bundle.zip')).toBe('附件')
    expect(classifyArtifactPath('src/core/writer.ts')).toBe('代码')
    expect(classifyArtifactPath('foo.spec.ts')).toBe('测试')
    expect(classifyArtifactPath('test_helpers.py')).toBe('测试')
  })

  it('反斜杠路径先归一化为 /', () => {
    expect(classifyArtifactPath('src\\core\\writer.ts')).toBe('代码')
  })
})

describe('artifactsOfToolCall（工具 → 产物）', () => {
  it('write/edit 取 file_path；读取类工具不产生产物', () => {
    expect(artifactsOfToolCall(call('write', { file_path: 'src/a.ts' }))).toEqual([
      { kind: '代码', value: 'src/a.ts' },
    ])
    expect(artifactsOfToolCall(call('edit', { file_path: 'docs/x.md' }))).toEqual([
      { kind: '文档', value: 'docs/x.md' },
    ])
    expect(artifactsOfToolCall(call('write', {}))).toEqual([])
    for (const name of ['read', 'grep', 'glob', 'memory_search', 'memory_remember', 'todo_write', 'task']) {
      expect(artifactsOfToolCall(call(name, { file_path: 'src/a.ts', pattern: 'x' }))).toEqual([])
    }
  })

  it('噪声路径（node_modules / .git 等）被跳过', () => {
    expect(artifactsOfToolCall(call('write', { file_path: 'node_modules/x/index.js' }))).toEqual([])
    expect(artifactsOfToolCall(call('write', { file_path: 'repo/.git/config' }))).toEqual([])
    expect(artifactsOfToolCall(call('write', { file_path: 'a/__pycache__/b.pyc' }))).toEqual([])
    // 只是名字里含 node_modules 字样、并非该目录的路径不受影响
    expect(artifactsOfToolCall(call('write', { file_path: 'src/node_modules_note.md' }))).toEqual([
      { kind: '文档', value: 'src/node_modules_note.md' },
    ])
  })

  it('shell 工具取命令首行并截断为单行', () => {
    expect(artifactsOfToolCall(call('pwsh', { command: '\n  npx vitest run\n  echo done' }))).toEqual([
      { kind: '命令', value: 'npx vitest run' },
    ])
    expect(artifactsOfToolCall(call('bash', { command: '' }))).toEqual([])
    expect(artifactsOfToolCall(call('pwsh', { command: 'x'.repeat(300) }))[0]!.value).toHaveLength(241)
  })

  it('web 工具只收 http(s) 链接', () => {
    expect(artifactsOfToolCall(call('web_fetch', { url: 'https://example.com/a' }))).toEqual([
      { kind: '链接', value: 'https://example.com/a' },
    ])
    expect(artifactsOfToolCall(call('web_search', { query: 'https://example.com/search' }))).toEqual([
      { kind: '链接', value: 'https://example.com/search' },
    ])
    expect(artifactsOfToolCall(call('web_search', { query: '纯文本关键词' }))).toEqual([])
  })

  it('present 的附件按类别归一（代码类降级为附件）', () => {
    expect(
      artifactsOfToolCall(call('present', { files: [{ path: 'out/report.md' }, { path: 'src/x.ts' }, {}] })),
    ).toEqual([
      { kind: '文档', value: 'out/report.md' },
      { kind: '附件', value: 'src/x.ts' },
    ])
    expect(artifactsOfToolCall(call('present', {}))).toEqual([])
  })
})

describe('extractArtifacts（一轮产物：去重 + 定序 + 限量）', () => {
  it('交付事件记入附件；工具调用按类别合并，顺序遵循 ARTIFACT_ORDER', () => {
    const items = extractArtifacts(turnOf(
      [
        call('write', { file_path: 'data/metrics.csv' }),
        call('write', { file_path: 'src/a.ts' }),
        call('write', { file_path: 'docs/design.md' }),
        call('pwsh', { command: 'npx vitest run' }),
        call('web_fetch', { url: 'https://example.com' }),
      ],
      [{ path: 'dist/bundle.zip', description: '打包产物' }],
    ))
    expect(items).toEqual([
      { kind: '代码', value: 'src/a.ts' },
      { kind: '命令', value: 'npx vitest run' },
      { kind: '文档', value: 'docs/design.md' },
      { kind: '数据', value: 'data/metrics.csv' },
      { kind: '链接', value: 'https://example.com' },
      { kind: '附件', value: 'dist/bundle.zip' },
    ])
    // 顺序即 ARTIFACT_ORDER 的子序列
    const order = items.map(i => ARTIFACT_ORDER.indexOf(i.kind))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('同一产物（类别 + 值）只记一次；交付事件里的噪声路径跳过', () => {
    const items = extractArtifacts(turnOf(
      [
        call('write', { file_path: 'src/a.ts' }),
        call('write', { file_path: 'src/a.ts' }),
        call('edit', { file_path: 'src/a.ts' }),
      ],
      [{ path: 'node_modules/x.js' }, { path: 'src/a.ts' }],
    ))
    expect(items).toEqual([
      { kind: '代码', value: 'src/a.ts' },
      { kind: '附件', value: 'src/a.ts' },
    ])
  })

  it(`每个类别最多 ${String(MAX_PER_KIND)} 条`, () => {
    const calls = Array.from({ length: MAX_PER_KIND + 3 }, (_, i) =>
      call('write', { file_path: `src/f${String(i)}.ts` }))
    const items = extractArtifacts(turnOf(calls))
    expect(items).toHaveLength(MAX_PER_KIND)
    expect(items[0]!.value).toBe('src/f0.ts')
  })

  it('空轮次返回空数组', () => {
    expect(extractArtifacts(turnOf())).toEqual([])
  })
})
