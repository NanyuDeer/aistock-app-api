/**
 * Skill: stock_quote - 个股实时行情查询
 * 复用现有 TencentQuoteService，零改造成本
 */
import type { Skill, SkillResult } from './types'
import { TencentQuoteService } from '../../quote/TencentQuoteService'

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

    // ✅ 直接复用现有 TencentQuoteService，使用 activity 级别获取完整数据
    const quote: Record<string, any> = await TencentQuoteService.getQuote(symbol, 'activity')

    // 腾讯行情返回中文字段名，做映射
    const name = quote['股票简称'] || ''
    const price = quote['最新价'] || 0
    const changePercent = quote['涨跌幅'] || 0
    const change = quote['涨跌额'] || 0
    const volume = quote['成交量'] || 0
    const amount = quote['成交额'] || 0

    const trend = changePercent > 0 ? '上涨' : changePercent < 0 ? '下跌' : '持平'

    return {
      type: 'card',
      data: {
        symbol,
        name,
        price,
        change,
        changePercent,
        open: quote['今开价'] || 0,
        high: quote['最高价'] || 0,
        low: quote['最低价'] || 0,
        prevClose: quote['昨收价'] || 0,
        volume,
        amount
      },
      narrative: `${name}（${symbol}）当前价 ${price}元，${trend} ${Math.abs(changePercent).toFixed(2)}%，成交量 ${volume}手。`
    }
  }
}
