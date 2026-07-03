/**
 * Skill 类型定义
 * 所有 Skills 必须实现 Skill 接口
 */

/**
 * Skill 执行结果
 */
export interface SkillResult {
  /** 渲染类型 */
  type: 'text' | 'card' | 'chart' | 'graph'
  /** 结构化数据 */
  data: any
  /** AI 叙述文本（可选，用于对话展示） */
  narrative?: string
}

/**
 * Skill 接口 - 可插拔技能
 */
export interface Skill {
  /** Skill 唯一标识（snake_case） */
  name: string
  /** 功能描述（供 LLM 选择 Skill 时参考） */
  description: string
  /** 技能标签（供分类/筛选使用，如 'market', 'realtime', 'analysis'） */
  tags?: string[]
  /** 优先级（数值越小优先级越高，同场景下优先展示高优先级 Skill） */
  priority?: number
  /** 参数 Schema（Zod 校验） */
  parameters: any // ZodSchema
  /** 执行逻辑 */
  execute(params: any): Promise<SkillResult>
}

/** Skill 元数据（不含执行逻辑，用于 LLM 发现和 prompt 构建） */
export interface SkillMetadata {
  name: string
  description: string
  tags: string[]
  priority: number
}

/**
 * Agent 接口
 */
export interface Agent {
  /** Agent 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 简短描述，用于列表展示 */
  description: string
  /** 路由提示词：描述这个 Agent 擅长处理什么类型的用户请求，给 LLM 路由用 */
  routingPrompt: string
  /** 路由分类标签（Phase 4 启用，用于二级路由） */
  category: string
  /** 系统提示词 */
  systemPrompt: string
  /** 白名单：该 Agent 能调用哪些全局 Skills */
  allowedSkills: string[]
  /** 处理消息（流式输出） */
  handle(message: string, context?: ChatContext): AsyncGenerator<string>
}

/**
 * 对话上下文
 */
export interface ChatContext {
  sessionId: string
  userId?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string }>
  favorites?: string[]
}

/**
 * 流式对话消息类型
 */
export type StreamMessage =
  | { type: 'text'; content: string }
  | { type: 'skill_call'; skill: string; params: any }
  | { type: 'skill_result'; result: SkillResult }
  | { type: 'done' }
  | { type: 'error'; message: string }
