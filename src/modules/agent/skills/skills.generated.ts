// ===== 自动生成，请勿手动修改 =====
// 生成命令：npm run generate:skills
// 生成时间：2026-07-03T14:35:15.161Z

import { capitalFlowSkill } from './capital-flow.skill'
import { leaderStockSkill } from './leader-stock.skill'
import { stockQuoteSkill } from './stock-quote.skill'
import type { Skill } from './types'

// Skill 元数据注册表（不含执行逻辑，用于 LLM 发现）
export const SKILLS_REGISTRY = [
  {
    name: capitalFlowSkill.name,
    description: capitalFlowSkill.description,
    tags: capitalFlowSkill.tags ?? [],
    priority: capitalFlowSkill.priority ?? 99,
  },
  {
    name: leaderStockSkill.name,
    description: leaderStockSkill.description,
    tags: leaderStockSkill.tags ?? [],
    priority: leaderStockSkill.priority ?? 99,
  },
  {
    name: stockQuoteSkill.name,
    description: stockQuoteSkill.description,
    tags: stockQuoteSkill.tags ?? [],
    priority: stockQuoteSkill.priority ?? 99,
  },
]

// 懒加载映射（运行时按需加载 execute）
export const SKILL_LOADERS: Record<string, () => Promise<Skill>> = {
  'capital-flow': () => import('./capital-flow.skill').then(m => m.capitalFlowSkill),
  'leader-stock': () => import('./leader-stock.skill').then(m => m.leaderStockSkill),
  'stock-quote': () => import('./stock-quote.skill').then(m => m.stockQuoteSkill),
}

export const REGISTERED_SKILL_COUNT = 3
