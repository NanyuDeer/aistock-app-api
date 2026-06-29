/**
 * Skill: stock_quote - 个股实时行情查询
 * 复用现有 TencentQuoteService，零改造成本
 */
import type { Skill, SkillResult } from './types'
import { TencentQuoteService } from '../../services/TencentQuoteService'

export const stockQuoteSkill: Skill = {
  name: 'stock_quote',
  description: '查询个股实时行情，包括当前价、涨跌幅、成交量等',
  parameters: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: '股票代码，6位数字，如 600519（贵州茅台）'
      }
    },
    required: ['symbol']
  },

  async execute(params: { symbol: string }): Promise<SkillResult> {
    const { symbol } = params

    // ✅ 直接复用现有 TencentQuoteService
    const quote = await TencentQuoteService.getQuote(symbol)

    const changePercent = quote.changePercent || 0
    const trend = changePercent > 0 ? '上涨' : changePercent < 0 ? '下跌' : '持平'

    return {
      type: 'card',
      data: {
        symbol: quote.symbol,
        name: quote.name,
        price: quote.price,
        change: quote.change,
        changePercent: quote.changePercent,
        open: quote.open,
        high: quote.high,
        low: quote.low,
        prevClose: quote.prevClose,
        volume: quote.volume,
        amount: quote.amount
      },
      narrative: `${quote.name}（${symbol}）当前价 ${quote.price}元，${trend} ${Math.abs(changePercent).toFixed(2)}%，成交量 ${quote.volume}手。`
    }
  }
}
