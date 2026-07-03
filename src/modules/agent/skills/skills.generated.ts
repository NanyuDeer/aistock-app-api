// ===== 自动生成，请勿手动修改 =====
// 生成命令：npm run generate:skills
// 生成时间：2026-07-03T13:56:53.719Z

import { capital_flow } from './capital-flow.skill'
import { leader_stock } from './leader-stock.skill'
import { stock_quote } from './stock-quote.skill'
import type { Skill } from './types'

// Skill 元数据注册表（不含执行逻辑，用于 LLM 发现）
export const SKILLS_REGISTRY = [
  {
    name: capital_flow.name,
    description: capital_flow.description,
    tags: capital_flow.tags ?? [],
    priority: capital_flow.priority ?? 99,
  },
  {
    name: leader_stock.name,
    description: leader_stock.description,
    tags: leader_stock.tags ?? [],
    priority: leader_stock.priority ?? 99,
  },
  {
    name: stock_quote.name,
    description: stock_quote.description,
    tags: stock_quote.tags ?? [],
    priority: stock_quote.priority ?? 99,
  },
]

// 懒加载映射（运行时按需加载 execute）
export const SKILL_LOADERS: Record<string, () => Promise<{ default: Skill }>> = {
  'capital-flow': () => import('./capital-flow.skill'),
  'leader-stock': () => import('./leader-stock.skill'),
  'stock-quote': () => import('./stock-quote.skill'),
}

export const REGISTERED_SKILL_COUNT = 3
