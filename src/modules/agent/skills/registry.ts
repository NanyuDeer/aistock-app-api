/**
 * Skills 注册中心
 * 消费 skills.generated.ts，不做动态扫描
 * Skills 的新增/移除由构建时代码生成脚本处理
 */
import type { Agent, Skill, SkillMetadata, SkillResult } from './types'
import { SKILLS_REGISTRY, SKILL_LOADERS } from './skills.generated'

// Skills 运行时缓存（懒加载后缓存）
const skillCache = new Map<string, Skill>()
let initialized = false

/**
 * 初始化所有 Skills（全量加载简单模式）
 * Phase 3 可改为按需懒加载
 */
export async function initSkills(): Promise<void> {
  if (initialized) return

  const loadPromises = Object.entries(SKILL_LOADERS).map(async ([name, loader]) => {
    try {
      const mod = await loader()
      // SKILL_LOADERS entries return Promise<Skill> directly (named export), not { default: Skill }
      skillCache.set(name, mod)
      console.log(`[SkillsRegistry] 加载 Skill: ${name}`)
    } catch (err) {
      console.error(`[SkillsRegistry] 加载 Skill "${name}" 失败:`, err)
    }
  })

  await Promise.all(loadPromises)
  initialized = true
  console.log(`[SkillsRegistry] 共加载 ${skillCache.size} 个 Skills`)
}

/**
 * 获取 Skill（运行时）
 */
export function getSkill(name: string): Skill | undefined {
  return skillCache.get(name)
}

/**
 * 获取所有已加载的 Skills
 */
export function getAllSkills(): Skill[] {
  return Array.from(skillCache.values())
}

/**
 * 获取 Skills 元数据（供 LLM prompt 使用，轻量级，不需加载执行代码）
 */
export function getSkillsDescription(): string {
  return SKILLS_REGISTRY
    .map(s => `- ${s.name}: ${s.description}`)
    .join('\n')
}

/**
 * 获取 Skills 元数据列表
 */
export function getSkillsMetadata(): SkillMetadata[] {
  return SKILLS_REGISTRY
}

/**
 * 带权限校验的 Skill 执行
 * @param agent 发起调用的 Agent
 * @param skillName 要调用的 Skill 名称
 * @param params 参数
 * @returns SkillResult
 * @throws Error 当越权或 Skill 不存在时
 */
export async function executeSkill(
  agent: Agent,
  skillName: string,
  params: any
): Promise<SkillResult> {
  // Phase 3: 白名单校验
  if (!agent.allowedSkills.includes(skillName)) {
    const allowed = agent.allowedSkills.join(', ')
    throw new Error(
      `权限拒绝: Agent "${agent.id}" 无权调用 Skill "${skillName}"。` +
      `该 Agent 允许的 Skills: [${allowed}]`
    )
  }

  const skill = getSkill(skillName)
  if (!skill) {
    throw new Error(`Skill "${skillName}" 未注册，请确认名称是否正确`)
  }

  return skill.execute(params)
}
