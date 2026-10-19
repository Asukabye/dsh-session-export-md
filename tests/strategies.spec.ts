import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STRATEGY,
  parseLlmStrategy,
  StrategyStore,
  UNCLASSIFIED_STRATEGY,
  UNCLASSIFIED_STRATEGY_ID,
  validateStrategy,
  type KvTable,
} from '../src/core/strategies.js'

function memoryKv(): KvTable & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    async get(key) {
      return data.get(key) ?? null
    },
    async set(key, value) {
      data.set(key, value)
    },
    async delete(key) {
      data.delete(key)
    },
    async keys() {
      return [...data.keys()]
    },
  }
}

/** 双维度标准结构：两个维度，各有自己的词表与兜底模块。 */
const validStrategy = {
  id: 'dev',
  name: '开发规模',
  dimensions: [
    {
      id: 'phase',
      name: '开发阶段',
      modules: [{ name: '需求' }, { name: '实现' }, { name: '其他' }],
      defaultModule: '其他',
    },
    {
      id: 'purpose',
      name: '对话功能/目的',
      modules: [{ name: '问答型' }, { name: '其他' }],
      defaultModule: '其他',
    },
  ],
}

describe('内置策略', () => {
  it('DEFAULT_STRATEGY 是双维度（phase / purpose），每维 8 个模块且以「其他」兜底', () => {
    expect(DEFAULT_STRATEGY.id).toBe('standard-dev')
    expect(DEFAULT_STRATEGY.dimensions.map(d => d.id)).toEqual(['phase', 'purpose'])
    expect(DEFAULT_STRATEGY.dimensions.map(d => d.name)).toEqual(['开发阶段', '对话功能/目的'])
    for (const d of DEFAULT_STRATEGY.dimensions) {
      expect(d.modules).toHaveLength(8)
      expect(d.modules.at(-1)!.name).toBe('其他')
      expect(d.defaultModule).toBe('其他')
    }
  })

  it('UNCLASSIFIED_STRATEGY 两维都只有「未分类」，且本身合法', () => {
    const v = validateStrategy(UNCLASSIFIED_STRATEGY)
    expect(v.ok).toBe(true)
    expect(UNCLASSIFIED_STRATEGY.id).toBe(UNCLASSIFIED_STRATEGY_ID)
    expect(UNCLASSIFIED_STRATEGY.dimensions).toHaveLength(2)
    for (const d of UNCLASSIFIED_STRATEGY.dimensions) {
      expect(d.modules).toHaveLength(1)
      expect(d.modules[0]!.name).toBe('未分类')
      expect(d.defaultModule).toBe('未分类')
    }
  })
})

describe('validateStrategy', () => {
  it('接受双维度合法策略并归一化 source', () => {
    const v = validateStrategy(validStrategy)
    expect(v.ok).toBe(true)
    expect(v.strategy?.dimensions).toHaveLength(2)
    expect(v.strategy?.dimensions[0]!.modules).toHaveLength(3)
    expect(v.strategy?.dimensions[1]!.defaultModule).toBe('其他')
    expect(v.strategy?.source).toBe('imported')
  })

  it('兼容旧单维结构：自动迁移为第一个维度', () => {
    const v = validateStrategy({
      id: 'legacy',
      name: '旧策略',
      modules: [{ name: '需求' }, { name: '其他' }],
      defaultModule: '其他',
    })
    expect(v.ok).toBe(true)
    expect(v.strategy?.dimensions).toHaveLength(1)
    const dim = v.strategy!.dimensions[0]!
    expect(dim.id).toBe('phase')
    expect(dim.name).toBe('旧策略')
    expect(dim.modules.map(m => m.name)).toEqual(['需求', '其他'])
    expect(dim.defaultModule).toBe('其他')
  })

  it('拒绝空 dimensions / 空 modules / 模块名重复 / defaultModule 不存在 / 空 id / 维度 id 重复', () => {
    expect(validateStrategy({ id: 'a', name: 'x', dimensions: [] }).ok).toBe(false)
    expect(
      validateStrategy({
        id: 'a',
        name: 'x',
        dimensions: [{ id: 'd', name: 'D', modules: [], defaultModule: '' }],
      }).ok,
    ).toBe(false)
    expect(
      validateStrategy({
        id: 'a',
        name: 'x',
        dimensions: [
          { id: 'd', name: 'D', modules: [{ name: 'm' }, { name: 'm' }], defaultModule: 'm' },
        ],
      }).errors.join(';'),
    ).toContain('重复')
    expect(
      validateStrategy({
        id: 'a',
        name: 'x',
        dimensions: [{ id: 'd', name: 'D', modules: [{ name: 'm' }], defaultModule: 'nope' }],
      }).ok,
    ).toBe(false)
    expect(
      validateStrategy({
        id: '',
        name: 'x',
        dimensions: [{ id: 'd', name: 'D', modules: [{ name: 'm' }], defaultModule: 'm' }],
      }).ok,
    ).toBe(false)
    expect(
      validateStrategy({
        id: 'a',
        name: 'x',
        dimensions: [
          { id: 'd', name: 'D', modules: [{ name: 'm' }], defaultModule: 'm' },
          { id: 'd', name: 'E', modules: [{ name: 'n' }], defaultModule: 'n' },
        ],
      }).errors.join(';'),
    ).toContain('维度 id 重复')
    expect(validateStrategy(null).ok).toBe(false)
  })
})

describe('parseLlmStrategy', () => {
  it('从 JSON 围栏提取双维度策略并归一化 source 为 llm', () => {
    const text = '方案如下：\n```json\n'
      + '{"id":"study","name":"学习笔记","dimensions":[{"id":"topic","name":"主题","modules":[{"name":"概念理解"}],"defaultModule":"概念理解"}],"source":"llm"}\n```'
    const v = parseLlmStrategy(text)
    expect(v.ok).toBe(true)
    expect(v.strategy?.source).toBe('llm')
    expect(v.strategy?.id).toBe('study')
    expect(v.strategy?.dimensions[0]!.id).toBe('topic')
  })

  it('裸 JSON 与非法文本', () => {
    const v = parseLlmStrategy(
      '{"id":"a","name":"x","dimensions":[{"id":"d","name":"D","modules":[{"name":"m"}],"defaultModule":"m"}]}',
    )
    expect(v.ok).toBe(true)
    expect(v.strategy?.source).toBe('llm')
    expect(parseLlmStrategy('不是 JSON').ok).toBe(false)
  })
})

describe('StrategyStore', () => {
  it('初始为空：内置策略不入容器', async () => {
    const store = new StrategyStore(memoryKv())
    expect(await store.list()).toEqual([])
  })

  it('增删查：保存的策略可列出、可删除', async () => {
    const store = new StrategyStore(memoryKv())
    const put = await store.put({
      id: 'custom',
      name: '自定义',
      source: 'llm',
      dimensions: [
        { id: 'd', name: '维度', modules: [{ name: 'A' }, { name: 'B' }], defaultModule: 'A' },
      ],
    })
    expect(put.ok).toBe(true)
    const got = await store.get('custom')
    expect(got?.name).toBe('自定义')
    expect(got?.dimensions[0]!.modules.map(m => m.name)).toEqual(['A', 'B'])
    expect((await store.list()).map(s => s.id)).toEqual(['custom'])
    expect(await store.remove('custom')).toBe(true)
    expect(await store.remove('custom')).toBe(false)
  })

  it('内置策略 id：可读、不可 put 覆盖、不可删', async () => {
    const store = new StrategyStore(memoryKv())
    expect((await store.get('standard-dev'))?.id).toBe(DEFAULT_STRATEGY.id)
    expect((await store.get(UNCLASSIFIED_STRATEGY_ID))?.id).toBe(UNCLASSIFIED_STRATEGY_ID)

    const put = await store.put({ ...DEFAULT_STRATEGY, name: '改名' })
    expect(put.ok).toBe(false)
    expect(put.errors.join(';')).toContain('内置策略 id')

    expect(await store.remove('standard-dev')).toBe(false)
    expect(await store.remove(UNCLASSIFIED_STRATEGY_ID)).toBe(false)
    expect(await store.list()).toEqual([]) // 内置策略不会因此入容器
  })

  it('手动导入 JSON：合法入库、非法报错、source 归一化为 imported', async () => {
    const store = new StrategyStore(memoryKv())
    const ok = await store.importFromJson(
      '{"id":"imp","name":"导入","dimensions":[{"id":"d","name":"D","modules":[{"name":"M"}],"defaultModule":"M"}]}',
    )
    expect(ok.ok).toBe(true)
    expect(ok.strategy?.source).toBe('imported')
    expect(ok.strategy?.dimensions).toHaveLength(1)
    const bad = await store.importFromJson('{bad json')
    expect(bad.ok).toBe(false)
    const bad2 = await store.importFromJson('{"id":"x","name":"x","dimensions":[],"defaultModule":""}')
    expect(bad2.ok).toBe(false)
    const builtin = await store.importFromJson(
      '{"id":"standard-dev","name":"假冒内置","dimensions":[{"id":"d","name":"D","modules":[{"name":"M"}],"defaultModule":"M"}]}',
    )
    expect(builtin.ok).toBe(false)
  })
})
