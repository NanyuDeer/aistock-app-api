/**
 * Skill: capital_flow - 主力资金流向查询
 * 复用现有 SinaMoneyFlowService，零改造成本
 */
import type { Skill, SkillResult } from './types'
import { SinaMoneyFlowService } from '../../services/SinaMoneyFlowService'

export const capitalFlowSkill: Skill = {
  name: 'capital_flow',
  description: '查询个股主力资金流向，包括主力净流入、超大单/大单/中单/小单分布',
  parameters: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: '股票代码，6位数字，如 600519'
      }
    },
    required: ['symbol']
  },

  async execute(params: { symbol: string }): Promise<SkillResult> {
    const { symbol } = params

    // ✅ 直接复用现有 SinaMoneyFlowService
    const flow = await SinaMoneyFlowService.getMoneyFlow(symbol)

    const mainNet = flow.mainNetInflow || 0
    const trend = mainNet > 0 ? '净流入' : '净流出'

    return {
      type: 'card',
      data: {
        symbol,
        mainNetInflow: flow.mainNetInflow,
        superLargeNet: flow.superLargeNet,
        largeNet: flow.largeNet,
        mediumNet: flow.mediumNet,
        smallNet: flow.smallNet,
        mainNetInflowPercent: flow.mainNetInflowPercent
      },
      narrative: `主力资金${trend} ${Math.abs(mainNet / 10000).toFixed(2)}万元，超大单${flow.superLargeNet > 0 ? '净流入' : '净流出'} ${Math.abs(flow.superLargeNet / 10000).toFixed(2)}万元。`
    }
  }
}
