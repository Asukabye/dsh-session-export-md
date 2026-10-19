import { ARTIFACT_ORDER } from './artifacts.js'
import type { ArtifactItem, ArtifactKind } from './types.js'

/**
 * 产物附件（format 10 起）：每轮的产物不再内联在正文里，而是写进同目录的附件文件，
 * 正文只保留一行 wiki 链接（`[[第3轮-产物|第3轮-产物.md]]`）。
 * 计划是**纯函数**：正文渲染与写文件两边都用它，保证链接名与实际文件名永远一致。
 */

/** 附件目录：与导出 md 同级、同名（`x.md` → `x.artifacts`）。 */
export function artifactsDirOf(exportPath: string): string {
  return `${exportPath.replace(/\.md$/i, '')}.artifacts`
}

/** 附件文件里的一类产物。 */
export interface ArtifactGroup {
  kind: ArtifactKind
  items: readonly string[]
}

/** 一个附件文件（文件名 + 分组内容）。 */
export interface ArtifactAttachment {
  /** 文件名（不含目录），如 `第3轮-产物.md`。 */
  fileName: string
  /** wiki 链接目标（不含扩展名），如 `第3轮-产物`。 */
  linkTarget: string
  /** 附件页标题，如 `第 3 轮产物`。 */
  title: string
  groups: ArtifactGroup[]
}

/** 超过阈值就把该轮产物按「命令 / 其它」拆成两个文件。 */
export const ATTACHMENT_SPLIT_COMMANDS = 10
export const ATTACHMENT_SPLIT_ITEMS = 24

function groupItems(items: readonly ArtifactItem[]): ArtifactGroup[] {
  const groups: ArtifactGroup[] = []
  for (const kind of ARTIFACT_ORDER) {
    const values = items.filter((item) => item.kind === kind).map((item) => item.value)
    if (values.length > 0) groups.push({ kind, items: values })
  }
  return groups
}

function attachment(no: number, suffix: string, title: string, groups: ArtifactGroup[]): ArtifactAttachment {
  const fileName = `第${String(no)}轮-${suffix}.md`
  return { fileName, linkTarget: fileName.replace(/\.md$/i, ''), title, groups }
}

/** 每轮产物 → 附件文件计划（无产物返回空数组）。 */
export function planAttachments(no: number, items: readonly ArtifactItem[]): ArtifactAttachment[] {
  if (items.length === 0) return []
  const groups = groupItems(items)
  const commands = groups.find((g) => g.kind === '命令')?.items.length ?? 0
  const single = attachment(no, '产物', `第 ${String(no)} 轮产物`, groups)
  if (commands <= ATTACHMENT_SPLIT_COMMANDS && items.length <= ATTACHMENT_SPLIT_ITEMS) return [single]
  const commandGroups = groups.filter((g) => g.kind === '命令')
  const otherGroups = groups.filter((g) => g.kind !== '命令')
  const out: ArtifactAttachment[] = []
  if (commandGroups.length > 0) out.push(attachment(no, '产物-命令', `第 ${String(no)} 轮命令`, commandGroups))
  if (otherGroups.length > 0) out.push(attachment(no, '产物-其它', `第 ${String(no)} 轮其它产物`, otherGroups))
  return out.length > 0 ? out : [single]
}

/** 附件页头信息。 */
export interface AttachmentMeta {
  /** 导出文件路径（写进附件页头，便于回溯）。 */
  sourcePath: string
  roundNo: number
  roundTitle: string
  exportedAt: string
}

/** 附件文件正文：页头（来源 / 轮次 / 时间 / 统计）→ 按类型分组；命令逐条代码块、不截断。 */
export function renderAttachmentFile(meta: AttachmentMeta, plan: ArtifactAttachment): string {
  const counts = plan.groups.map((g) => `${g.kind} ${String(g.items.length)}`).join(' · ')
  const lines: string[] = [
    `# ${plan.title}`,
    '',
    `- 来源文档：\`${meta.sourcePath}\``,
    `- 轮次：第 ${String(meta.roundNo)} 轮：${meta.roundTitle}`,
    `- 导出时间：${meta.exportedAt}`,
    `- 内容统计：${counts}`,
  ]
  for (const group of plan.groups) {
    lines.push('', `## ${group.kind}`)
    if (group.kind === '命令') {
      for (const [index, value] of group.items.entries()) {
        lines.push('', `### 命令 ${String(index + 1)}`, '', '```powershell', value, '```')
      }
      continue
    }
    lines.push('')
    for (const value of group.items) {
      lines.push(group.kind === '链接' ? `- ${value}` : `- \`${value}\``)
    }
  }
  return lines.join('\n') + '\n'
}
