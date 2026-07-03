/**
 * Skill: capital_flow - 主力资金流向查询
 * 复用现有 SinaMoneyFlowService（函数导出），零改造成本
 */
import type { Skill, SkillResult } from './types'
import { getSinaMoneyflow } from '../../quote/SinaMoneyFlowService'

export const capitalFlowSkill: Skill = {
  name: 'capital_flow',
  description: '查询个股主力资金流向，包括主力净流入、超大单/大单/中单/小单分布',
  tags: ['market', 'fund-flow'],
  priority: 1,
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

    // ✅ 直接复用现有 getSinaMoneyflow 函数
    const flow = await getSinaMoneyflow(symbol)

    if (!flow) {
      return {
        type: 'text',
        data: null,
        narrative: `未能获取 ${symbol} 的资金流向数据。`
      }
    }

    // SinaMoneyflowRaw 字段：netamount(净流入元)、r0_in/r0_out(特大单)、r1_in/r1_out(大单) 等
    const mainNet = flow.netamount || 0
    const superLargeNet = (flow.r0_in || 0) - (flow.r0_out || 0)
    const largeNet = (flow.r1_in || 0) - (flow.r1_out || 0)
    const mediumNet = (flow.r2_in || 0) - (flow.r2_out || 0)
    const smallNet = (flow.r3_in || 0) - (flow.r3_out || 0)
    const trend = mainNet > 0 ? '净流入' : '净流出'

    return {
      type: 'card',
      data: {
        symbol,
        name: flow.name,
        mainNetInflow: mainNet,
        superLargeNet,
        largeNet,
        mediumNet,
        smallNet,
        mainNetInflowPercent: flow.r0x_ratio || 0
      },
      narrative: `${flow.name}（${symbol}）主力资金${trend} ${Math.abs(mainNet / 10000).toFixed(2)}万元，特大单${superLargeNet > 0 ? '净流入' : '净流出'} ${Math.abs(superLargeNet / 10000).toFixed(2)}万元。`
    }
  }
}
