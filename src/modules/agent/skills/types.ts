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
  /** 参数 Schema（Zod 校验） */
  parameters: any // ZodSchema
  /** 执行逻辑 */
  execute(params: any): Promise<SkillResult>
}

/**
 * Agent 接口
 */
export interface Agent {
  /** Agent 唯一标识 */
  id: string
  /** 显示名称 */
  name: string
  /** 系统提示词 */
  systemPrompt: string
  /** 可调用的 Skills 列表 */
  availableSkills: string[]
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
