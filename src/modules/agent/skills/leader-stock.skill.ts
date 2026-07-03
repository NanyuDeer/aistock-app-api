/**
 * Skill: leader_stock - 龙头股筛选
 * 复用现有 TushareTagLeaderService（同花顺数据源不可用时的替代方案）
 * 注：东方财富不允许使用，此处使用 Tushare 数据源
 */
import type { Skill, SkillResult } from './types'
import { TushareTagLeaderService } from '../../quote/TushareTagLeaderService'

export const leaderStockSkill: Skill = {
  name: 'leader_stock',
  description: '查询板块龙头股，按概念或行业分类筛选领涨股',
  tags: ['sector', 'leader'],
  priority: 1,
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

    // ✅ 直接复用现有 TushareTagLeaderService
    const leaders: Record<string, any>[] = await TushareTagLeaderService.getTagLeaders(tagCode, limit)

    const leaderNames = leaders.map((l: any) => l.name || l['股票简称'] || '').filter(Boolean).join('、')

    return {
      type: 'card',
      data: {
        tagCode,
        count: leaders.length,
        leaders
      },
      narrative: `板块 ${tagCode} 的龙头股包括：${leaderNames}，共 ${leaders.length} 只。`
    }
  }
}
