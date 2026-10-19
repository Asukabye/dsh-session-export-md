import { describe, expect, it } from 'vitest'
import {
  artifactsDirOf,
  ATTACHMENT_SPLIT_COMMANDS,
  ATTACHMENT_SPLIT_ITEMS,
  planAttachments,
  renderAttachmentFile,
} from '../src/core/attachments.js'
import type { ArtifactItem } from '../src/core/types.js'

/** n 条命令产物。 */
function commands(n: number): ArtifactItem[] {
  return Array.from({ length: n }, (_value, index) => ({
    kind: '命令' as const,
    value: `npx vitest run --shard ${String(index + 1)}`,
  }))
}

/** n 条文档产物。 */
function docs(n: number): ArtifactItem[] {
  return Array.from({ length: n }, (_value, index) => ({
    kind: '文档' as const,
    value: `docs/notes-${String(index + 1)}.md`,
  }))
}

const meta = {
  sourcePath: '.chat-exports/x.md',
  roundNo: 3,
  roundTitle: '编码实现：补测试',
  exportedAt: '2026-10-11 09:30',
}

describe('artifactsDirOf（附件目录 = 导出文件同目录同名）', () => {
  it('`x.md` → `x.artifacts`；保留目录部分；大小写不敏感', () => {
    expect(artifactsDirOf('x.md')).toBe('x.artifacts')
    expect(artifactsDirOf('.chat-exports/对话导出-session-.md')).toBe('.chat-exports/对话导出-session-.artifacts')
    expect(artifactsDirOf('D:/w/a/b.md')).toBe('D:/w/a/b.artifacts')
    expect(artifactsDirOf('x.MD')).toBe('x.artifacts')
    // 无 .md 后缀时直接追加
    expect(artifactsDirOf('x')).toBe('x.artifacts')
  })
})

describe('planAttachments（每轮产物 → 附件文件计划）', () => {
  it('无产物 → 空数组（不建空附件）', () => {
    expect(planAttachments(1, [])).toEqual([])
  })

  it('默认一个 `第N轮-产物.md`：按固定类别顺序分组，链接目标 = 文件名去掉扩展名', () => {
    const plan = planAttachments(3, [
      { kind: '链接', value: 'https://example.com' },
      { kind: '命令', value: 'npx vitest run' },
      { kind: '文档', value: 'docs/a.md' },
    ])
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({
      fileName: '第3轮-产物.md',
      linkTarget: '第3轮-产物',
      title: '第 3 轮产物',
    })
    // 分组按 ARTIFACT_ORDER（命令 → 文档 → 链接），与入参顺序无关
    expect(plan[0]!.groups.map(g => g.kind)).toEqual(['命令', '文档', '链接'])
    expect(plan[0]!.groups.map(g => g.items.length)).toEqual([1, 1, 1])
  })

  it(`命令 ${String(ATTACHMENT_SPLIT_COMMANDS)} 条以内且总条目 ${String(ATTACHMENT_SPLIT_ITEMS)} 条以内仍是单文件`, () => {
    // 边界内：10 命令 + 14 文档 = 24 条 → 单文件
    const plan = planAttachments(1, [...commands(ATTACHMENT_SPLIT_COMMANDS), ...docs(14)])
    expect(plan).toHaveLength(1)
    expect(plan[0]!.fileName).toBe('第1轮-产物.md')
  })

  it('命令超过 10 条 → 拆成「命令」+「其它」两个文件', () => {
    const plan = planAttachments(4, [...commands(ATTACHMENT_SPLIT_COMMANDS + 1), ...docs(1)])
    expect(plan.map(p => p.fileName)).toEqual(['第4轮-产物-命令.md', '第4轮-产物-其它.md'])
    expect(plan.map(p => p.linkTarget)).toEqual(['第4轮-产物-命令', '第4轮-产物-其它'])
    expect(plan[0]).toMatchObject({ title: '第 4 轮命令' })
    expect(plan[1]).toMatchObject({ title: '第 4 轮其它产物' })
    expect(plan[0]!.groups.map(g => g.kind)).toEqual(['命令'])
    expect(plan[0]!.groups[0]!.items).toHaveLength(ATTACHMENT_SPLIT_COMMANDS + 1)
    expect(plan[1]!.groups.map(g => g.kind)).toEqual(['文档'])
  })

  it('总条目超过 24 条（命令不多）同样拆两文件', () => {
    const plan = planAttachments(2, [...commands(2), ...docs(ATTACHMENT_SPLIT_ITEMS - 1)])
    expect(plan.map(p => p.fileName)).toEqual(['第2轮-产物-命令.md', '第2轮-产物-其它.md'])
    expect(plan[0]!.groups[0]!.items).toHaveLength(2)
    expect(plan[1]!.groups[0]!.items).toHaveLength(ATTACHMENT_SPLIT_ITEMS - 1)
  })

  it('只有命令且超过阈值时只产出「命令」文件（不写空「其它」文件）', () => {
    const plan = planAttachments(5, commands(ATTACHMENT_SPLIT_COMMANDS + 2))
    expect(plan.map(p => p.fileName)).toEqual(['第5轮-产物-命令.md'])
  })
})

describe('renderAttachmentFile（附件文件正文）', () => {
  it('页头（来源文档/轮次/时间/统计）→ `## 类型` 分组 → 命令逐条 `### 命令 N` + 代码块', () => {
    const plan = planAttachments(3, [
      ...commands(2),
      { kind: '文档', value: 'docs/a.md' },
      { kind: '链接', value: 'https://example.com' },
    ])
    const out = renderAttachmentFile(meta, plan[0]!)
    expect(out.endsWith('\n')).toBe(true)
    expect(out.startsWith('# 第 3 轮产物\n')).toBe(true)
    expect(out).toContain('- 来源文档：`.chat-exports/x.md`')
    expect(out).toContain('- 轮次：第 3 轮：编码实现：补测试')
    expect(out).toContain('- 导出时间：2026-10-11 09:30')
    expect(out).toContain('- 内容统计：命令 2 · 文档 1 · 链接 1')
    // 命令逐条、原文进 powershell 代码块（不截断）
    expect(out).toContain('## 命令\n\n### 命令 1\n\n```powershell\nnpx vitest run --shard 1\n```')
    expect(out).toContain('### 命令 2\n\n```powershell\nnpx vitest run --shard 2\n```')
    // 非命令类型：分组标题 + 条目（路径加反引号，链接不加）
    expect(out).toContain('## 文档\n\n- `docs/a.md`')
    expect(out).toContain('## 链接\n\n- https://example.com')
  })

  it('拆分计划用各自的页标题与统计', () => {
    const plan = planAttachments(7, [...commands(ATTACHMENT_SPLIT_COMMANDS + 1), ...docs(1)])
    const commandsFile = renderAttachmentFile(meta, plan[0]!)
    expect(commandsFile.startsWith(`# ${plan[0]!.title}\n`)).toBe(true)
    expect(commandsFile).toContain(`- 内容统计：命令 ${String(ATTACHMENT_SPLIT_COMMANDS + 1)}`)
    expect(commandsFile).toContain(`### 命令 ${String(ATTACHMENT_SPLIT_COMMANDS + 1)}`)
    expect(commandsFile).not.toContain('## 文档')
    const othersFile = renderAttachmentFile(meta, plan[1]!)
    expect(othersFile.startsWith(`# ${plan[1]!.title}\n`)).toBe(true)
    expect(othersFile).toContain('- 内容统计：文档 1')
    expect(othersFile).not.toContain('```powershell')
  })
})
