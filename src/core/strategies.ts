import type { Strategy, StrategyDimension, StrategyModule } from './types.js'

/**
 * 无保存策略时的技术兜底（**不是**分类词表）：两个维度都只有「未分类」，
 * 且跳过 LLM 分类调用。真实词表见 {@link DEFAULT_STRATEGY}。
 */
export const UNCLASSIFIED_STRATEGY_ID = 'unclassified'

/** 内建维度 id（文档里不显示，只作映射键）。 */
export const PHASE_DIMENSION_ID = 'phase'
export const PURPOSE_DIMENSION_ID = 'purpose'

function dimension(
  id: string,
  name: string,
  modules: readonly (string | StrategyModule)[],
  fallback: string,
): StrategyDimension {
  return {
    id,
    name,
    defaultModule: fallback,
    modules: modules.map((m) => (typeof m === 'string' ? { name: m } : m)),
  }
}

/**
 * 内置默认策略（format=5 起）：两套固定词表——开发阶段 / 对话功能·目的。
 * 每维 7 个具名模块 + 1 个兜底模块「其他」（与文档模板的目录一致）。
 */
export const DEFAULT_STRATEGY: Strategy = {
  id: 'standard-dev',
  name: '标准研发流程',
  source: 'builtin',
  dimensions: [
    dimension(PHASE_DIMENSION_ID, '开发阶段', [
      { name: '需求分析', description: '澄清需求、拆解用户故事、编写验收标准' },
      { name: '系统设计', description: '架构选型、数据库设计、接口定义、技术方案对比' },
      { name: '编码实现', description: '生成代码、补全函数、解释语法、优化算法' },
      { name: '测试', description: '设计用例、生成测试脚本、分析失败原因、造数据' },
      { name: '调试与排障', description: '分析报错、日志排查、性能瓶颈定位' },
      { name: '部署与运维', description: 'Dockerfile、CI/CD 配置、服务器命令、监控告警' },
      { name: '维护与重构', description: '代码审查、重构建议、依赖升级、废弃迁移' },
      { name: '其他', description: '无法归入以上阶段（概念问答等）' },
    ], '其他'),
    dimension(PURPOSE_DIMENSION_ID, '对话功能/目的', [
      { name: '问答型', description: '概念解释、API 用法、报错原因' },
      { name: '生成型', description: '生成代码、文档、测试用例、配置' },
      { name: '审查型', description: 'Review 代码、检查安全漏洞、评估方案' },
      { name: '调试型', description: '分析日志、定位 Bug、验证修复' },
      { name: '规划型', description: '任务拆解、排期、技术选型对比' },
      { name: '学习型', description: '系统学习某个技术栈、原理讲解' },
      { name: 'Agent 执行型', description: '让 LLM 调用工具、多步完成任务' },
      { name: '其他', description: '无法归入以上目的' },
    ], '其他'),
  ],
}

export const UNCLASSIFIED_STRATEGY: Strategy = {
  id: UNCLASSIFIED_STRATEGY_ID,
  name: '未分类',
  source: 'builtin',
  dimensions: [
    dimension(PHASE_DIMENSION_ID, '开发阶段', [
      { name: '未分类', description: '尚未选择分类策略时的兜底模块' },
    ], '未分类'),
    dimension(PURPOSE_DIMENSION_ID, '对话功能/目的', [
      { name: '未分类', description: '尚未选择分类策略时的兜底模块' },
    ], '未分类'),
  ],
}

/** 内置策略（可选、不可删、不入容器）。 */
export const BUILTIN_STRATEGIES: readonly Strategy[] = [DEFAULT_STRATEGY, UNCLASSIFIED_STRATEGY]

export function builtinStrategy(id: string): Strategy | null {
  return BUILTIN_STRATEGIES.find((s) => s.id === id) ?? null
}

export interface ValidationResult {
  ok: boolean
  strategy?: Strategy
  errors: string[]
}

function parseModules(raw: unknown, label: string, errors: string[]): StrategyModule[] {
  const modules: StrategyModule[] = []
  if (!Array.isArray(raw) || raw.length === 0) {
    errors.push(`${label} 必须是非空数组`)
    return modules
  }
  const seen = new Set<string>()
  raw.forEach((m, i) => {
    if (typeof m !== 'object' || m === null) {
      errors.push(`${label}[${i}] 必须是对象`)
      return
    }
    const mo = m as Record<string, unknown>
    const mn = typeof mo.name === 'string' ? mo.name.trim() : ''
    if (mn === '') {
      errors.push(`${label}[${i}].name 必须为非空字符串`)
      return
    }
    if (seen.has(mn)) {
      errors.push(`${label} 模块名重复：${mn}`)
      return
    }
    seen.add(mn)
    const description = typeof mo.description === 'string' ? mo.description : undefined
    const examples = Array.isArray(mo.examples)
      ? mo.examples.filter((x): x is string => typeof x === 'string')
      : undefined
    modules.push({
      name: mn,
      ...(description !== undefined && description !== '' ? { description } : {}),
      ...(examples !== undefined && examples.length > 0 ? { examples } : {}),
    })
  })
  return modules
}

/** 解析一个维度对象（dimensions[i]）。 */
function parseDimension(raw: unknown, i: number, errors: string[]): StrategyDimension | null {
  if (typeof raw !== 'object' || raw === null) {
    errors.push(`dimensions[${i}] 必须是对象`)
    return null
  }
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (id === '') errors.push(`dimensions[${i}].id 必须为非空字符串`)
  if (name === '') errors.push(`dimensions[${i}].name 必须为非空字符串`)
  const modules = parseModules(o.modules, `dimensions[${i}].modules`, errors)
  const defaultModule = typeof o.defaultModule === 'string' ? o.defaultModule.trim() : ''
  if (modules.length > 0 && !modules.some((m) => m.name === defaultModule)) {
    errors.push(`dimensions[${i}].defaultModule（${defaultModule || '空'}）必须存在于该维度的 modules`)
  }
  if (id === '' || name === '' || modules.length === 0) return null
  return {
    id,
    name,
    modules,
    defaultModule: defaultModule !== '' ? defaultModule : (modules[0]?.name ?? ''),
  }
}

/**
 * 校验策略结构（LLM 生成、手动导入、手动编辑共用）。
 * 兼容旧结构（单维 `modules` + `defaultModule`）：自动包成第一个维度。
 */
export function validateStrategy(input: unknown): ValidationResult {
  const errors: string[] = []
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, errors: ['策略必须是 JSON 对象'] }
  }
  const o = input as Record<string, unknown>

  const id = typeof o.id === 'string' ? o.id.trim() : ''
  const name = typeof o.name === 'string' ? o.name.trim() : ''
  if (id === '') errors.push('id 必须为非空字符串')
  if (name === '') errors.push('name 必须为非空字符串')

  let dimensions: StrategyDimension[] = []
  if (Array.isArray(o.dimensions)) {
    dimensions = o.dimensions
      .map((d, i) => parseDimension(d, i, errors))
      .filter((d): d is StrategyDimension => d !== null)
  } else if (Array.isArray(o.modules)) {
    // 旧单维结构 → 迁移为第一维（维度名沿用策略名，id 用 phase）
    const migrated = parseDimension(
      {
        id: PHASE_DIMENSION_ID,
        name: name !== '' ? name : '分类',
        modules: o.modules,
        defaultModule: o.defaultModule,
      },
      0,
      errors,
    )
    if (migrated !== null) dimensions = [migrated]
  } else {
    errors.push('dimensions 必须是非空数组（或提供旧结构 modules）')
  }

  if (dimensions.length === 0) errors.push('dimensions 必须是非空数组')
  const ids = new Set<string>()
  for (const d of dimensions) {
    if (ids.has(d.id)) errors.push(`维度 id 重复：${d.id}`)
    ids.add(d.id)
  }

  if (errors.length > 0) return { ok: false, errors }

  const source = o.source === 'llm' || o.source === 'builtin' || o.source === 'imported'
    ? o.source
    : 'imported'
  return { ok: true, strategy: { id, name, dimensions, source }, errors: [] }
}

/**
 * 解析 LLM 生成的策略文本：提取 ```json 围栏或裸 JSON，校验并归一化 source 为 'llm'。
 */
export function parseLlmStrategy(text: string): ValidationResult {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const candidate = (fenceMatch !== null && fenceMatch[1] !== undefined ? fenceMatch[1] : text).trim()
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate)
  } catch {
    return { ok: false, errors: ['无法解析为 JSON'] }
  }
  const v = validateStrategy(parsed)
  if (!v.ok) return v
  return { ok: true, strategy: { ...v.strategy!, source: 'llm' }, errors: [] }
}

/** 最小 KV 表接口（集成阶段对接 storageDomain KV；测试用内存实现）。 */
export interface KvTable {
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
  keys(): Promise<string[]>
}

function keyOf(id: string): string {
  return `strategy:${id}`
}

/**
 * 策略存储容器：只装用户生成的策略（LLM 设计 / 手动新建 / 导入）。
 * 容器为空时由服务层回落到 {@link DEFAULT_STRATEGY}（内置标准研发流程）。
 */
export class StrategyStore {
  constructor(private readonly table: KvTable) {}

  async list(): Promise<Strategy[]> {
    const out: Strategy[] = []
    for (const k of await this.table.keys()) {
      if (!k.startsWith('strategy:')) continue
      const raw = await this.table.get(k)
      if (raw === null) continue
      const v = validateStrategy(JSON.parse(raw))
      if (v.ok && v.strategy) out.push(v.strategy)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
  }

  async get(id: string): Promise<Strategy | null> {
    const builtin = builtinStrategy(id)
    if (builtin !== null) return builtin
    const raw = await this.table.get(keyOf(id))
    if (raw === null) return null
    const v = validateStrategy(JSON.parse(raw))
    return v.ok && v.strategy ? v.strategy : null
  }

  /** 存入（覆盖同 id；写入前校验）。内置策略 id 不可覆盖。 */
  async put(strategy: Strategy): Promise<ValidationResult> {
    if (builtinStrategy(strategy.id) !== null) {
      return { ok: false, errors: [`${strategy.id} 是内置策略 id，请改用其它 id`] }
    }
    const v = validateStrategy(strategy)
    if (!v.ok) return v
    await this.table.set(keyOf(v.strategy!.id), JSON.stringify(v.strategy))
    return v
  }

  /** 删除策略；返回是否已删除。内置策略不可删。 */
  async remove(id: string): Promise<boolean> {
    if (builtinStrategy(id) !== null) return false
    const existed = (await this.table.get(keyOf(id))) !== null
    if (existed) await this.table.delete(keyOf(id))
    return existed
  }

  /** 手动导入 JSON 策略文本。 */
  async importFromJson(text: string): Promise<ValidationResult> {
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      return { ok: false, errors: ['无法解析为 JSON'] }
    }
    const v = validateStrategy(parsed)
    if (!v.ok) return v
    const strategy: Strategy = { ...v.strategy!, source: 'imported' }
    if (builtinStrategy(strategy.id) !== null) {
      return { ok: false, errors: [`${strategy.id} 是内置策略 id，请改用其它 id`] }
    }
    await this.table.set(keyOf(strategy.id), JSON.stringify(strategy))
    return { ok: true, strategy, errors: [] }
  }
}
