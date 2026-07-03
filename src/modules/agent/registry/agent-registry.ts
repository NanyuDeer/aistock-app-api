import { AGENT_LIST } from '../agents/agents.generated'
import type { Agent, ChatContext } from '../skills/types'

export class AgentRegistry {
  private agents: Map<string, Agent>

  constructor() {
    this.agents = new Map()
    for (const agent of AGENT_LIST) {
      this.agents.set(agent.id, agent)
    }
  }

  getAllAgents(): Agent[] {
    return Array.from(this.agents.values())
  }

  getAgent(id: string): Agent | undefined {
    return this.agents.get(id)
  }

  /**
   * 通过 LLM 路由选择 Agent
   * @param message 用户消息
   * @param llmRouter LLM 调用函数（由外部注入，便于测试和切换模型）
   * @returns 选中的 Agent，无匹配返回 general_agent
   */
  async matchIntent(
    message: string,
    llmRouter: (message: string, agents: Agent[]) => Promise<string | null>
  ): Promise<Agent> {
    const agents = this.getAllAgents().filter(a => a.id !== 'general')
    const selectedId = await llmRouter(message, agents)

    if (selectedId && this.agents.has(selectedId)) {
      return this.agents.get(selectedId)!
    }

    // 降级到兜底 Agent
    return this.agents.get('general') || agents[0]
  }
}

// 单例
export const agentRegistry = new AgentRegistry()
