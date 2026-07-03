/**
 * Skills 注册中心
 * 所有 Skills 在此注册，供 Agent 按需调用
 */
import type { Skill } from './types'
import { stockQuoteSkill } from './stock-quote.skill'
import { capitalFlowSkill } from './capital-flow.skill'
import { leaderStockSkill } from './leader-stock.skill'

// Skills 注册表
const registry = new Map<string, Skill>()

/**
 * 注册一个 Skill
 */
export function registerSkill(skill: Skill): void {
  if (registry.has(skill.name)) {
    console.warn(`[SkillsRegistry] Skill "${skill.name}" 已存在，将被覆盖`)
  }
  registry.set(skill.name, skill)
  console.log(`[SkillsRegistry] 注册 Skill: ${skill.name}`)
}

/**
 * 获取 Skill
 */
export function getSkill(name: string): Skill | undefined {
  return registry.get(name)
}

/**
 * 获取所有已注册的 Skills（供 LLM 选择）
 */
export function getAllSkills(): Skill[] {
  return Array.from(registry.values())
}

/**
 * 获取 Skills 描述（供 LLM prompt 使用）
 */
export function getSkillsDescription(): string {
  const skills = getAllSkills()
  return skills.map(s => `- ${s.name}: ${s.description}`).join('\n')
}

/**
 * 初始化所有 Skills
 */
export function initSkills(): void {
  // P0 Skills
  registerSkill(stockQuoteSkill)
  registerSkill(capitalFlowSkill)

  // P1 Skills
  registerSkill(leaderStockSkill)

  // TODO: 后续添加更多 Skills
  // registerSkill(eventChainSkill)
  // registerSkill(valuationSkill)
  // registerSkill(researchReportSkill)
  // registerSkill(knowledgeGraphSkill)
  // registerSkill(alertMonitorSkill)

  console.log(`[SkillsRegistry] 共注册 ${registry.size} 个 Skills`)
}
