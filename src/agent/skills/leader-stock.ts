/**
 * Skill: leader_stock - 龙头股筛选
 * 复用现有 ThsService，零改造成本
 */
import type { Skill, SkillResult } from './types'
import { ThsService } from '../../services/ThsService'

export const leaderStockSkill: Skill = {
  name: 'leader_stock',
  description: '查询板块龙头股，按概念或行业分类筛选领涨股',
  parameters: {
    type: 'object',
    properties: {
      tagCode: {
        type: 'string',
        description: '板块/概念代码，如 BK0475（白酒）'
      },
      limit: {
        type: 'number',
        description: '返回数量，默认 10'
      }
    },
    required: ['tagCode']
  },

  async execute(params: { tagCode: string; limit?: number }): Promise<SkillResult> {
    const { tagCode, limit = 10 } = params

    // ✅ 直接复用现有 ThsService
    const leaders = await ThsService.getTagLeaders(tagCode)

    const topLeaders = leaders.slice(0, limit)
    const leaderNames = topLeaders.map((l: any) => l.name).join('、')

    return {
      type: 'card',
      data: {
        tagCode,
        count: topLeaders.length,
        leaders: topLeaders
      },
      narrative: `板块 ${tagCode} 的龙头股包括：${leaderNames}，共 ${topLeaders.length} 只。`
    }
  }
}
