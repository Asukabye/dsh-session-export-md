/**
 * storage-domain 声明（集成阶段）：单表 `export`，键为字符串、值为字符串信封。
 * 业务键（watermark:/categorize:/pref:/strategy:/__keys__）由上层 KvTable 适配器管理。
 * @module @deepseek-ai/dsh-session-export-md/domain
 */

import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** 字符串信封：所有业务值序列化为 JSON 字符串存储。 */
export interface ValueEnvelope {
  value: string
}

const valueEnvelope = z.object({
  value: z.string(),
})

export const exportDomainSpec = defineDomain({
  name: 'session_export_md',
  version: 1,
  tables: { export: domainTable<string, ValueEnvelope>(valueEnvelope) },
})

export type ExportDomainTable = (typeof exportDomainSpec)['tables']['export']
