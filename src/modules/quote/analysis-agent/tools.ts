import { ClsStockNewsService } from '../../monitor/ClsStockNewsService';
import { ThsService } from '../../monitor/ThsService';
import { TencentQuoteService } from '../TencentQuoteService';
import type { AgentToolCall, AgentToolResult, AgentContext } from './types';
import pool from '../../../core/db';
import { getSemiAnnualReport } from '../TushareService';

/** OpenAI Function Calling 工具定义 */
export const AGENT_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'search_stock_news',
      description: '搜索指定股票的相关新闻，返回新闻标题和摘要列表。当需要了解股票近期资讯时调用。',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: '返回条数，默认5，最多10',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_news_fulltext',
      description: '获取指定新闻的完整正文内容。当新闻摘要信息不足以做出判断，需要阅读全文时调用。需要传入新闻ID。',
      parameters: {
        type: 'object',
        properties: {
          news_id: {
            type: 'string',
            description: '新闻ID（从search_stock_news返回的id字段获取）',
          },
        },
        required: ['news_id'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_profit_forecast',
      description: '获取该股票的机构盈利预测数据，用于验证新闻事件是否有基本面支撑。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_trading_data',
      description: '获取该股票最近一个交易日的行情数据（价格、成交量、换手率等），用于判断市场是否已计价。',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
  },
];

/** 执行单个工具调用 */
export async function executeToolCall(
  call: AgentToolCall,
  context: AgentContext,
): Promise<AgentToolResult> {
  const { name, arguments: args } = call;

  try {
    let result: string;

    switch (name) {
      case 'search_stock_news': {
        const limit = Math.min(args.limit || 5, 10);
        const newsResult = await ClsStockNewsService.getStockNews(context.symbol, { limit, lastTime: 0 });
        for (const item of newsResult.items) {
          context.newsCache.set(String(item.id), item);
        }
        const newsList = newsResult.items.map((item, i) =>
          `【${i + 1}】ID: ${item.id}\n标题: ${item.title}\n时间: ${item.time}\n摘要: ${item.content.slice(0, 200)}\n链接: ${item.link}`
        ).join('\n\n');
        result = newsList || '未找到相关新闻';
        break;
      }

      case 'get_news_fulltext': {
        const newsId = args.news_id;
        if (!newsId) {
          result = '错误：缺少 news_id 参数';
          break;
        }
        const cached = context.newsCache.get(newsId);
        const fulltext = await ClsStockNewsService.getNewsFulltext(newsId);
        if (fulltext) {
          result = `标题: ${fulltext.title}\n时间: ${fulltext.time}\n链接: ${fulltext.link}\n\n全文:\n${fulltext.content}`;
        } else if (cached) {
          result = `标题: ${cached.title}\n时间: ${cached.time}\n链接: ${cached.link}\n\n摘要(全文获取失败，降级返回):\n${cached.content}`;
        } else {
          result = '错误：未找到该新闻，请确认 news_id 是否正确';
        }
        break;
      }

      case 'get_profit_forecast': {
        try {
          const forecast = await ThsService.getProfitForecast(context.symbol);
          result = JSON.stringify(forecast, null, 2);
        } catch (e) {
          result = '盈利预测数据获取失败: ' + (e instanceof Error ? e.message : '未知错误');
        }
        break;
      }

      case 'get_trading_data': {
        try {
          const quote = await TencentQuoteService.getQuote(context.symbol, 'activity');
          result = JSON.stringify(quote, null, 2);
        } catch (e) {
          result = '交易数据获取失败: ' + (e instanceof Error ? e.message : '未知错误');
        }
        break;
      }

      default:
        result = `错误：未知工具 ${name}`;
    }

    return { tool_call_id: call.id, name, content: result };
  } catch (error) {
    return {
      tool_call_id: call.id,
      name,
      content: `工具执行错误: ${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}

/** 中长线 Agent 工具定义 */
export const MID_LONG_AGENT_TOOL_DEFINITIONS = [
  {
    type: 'function' as const,
    function: {
      name: 'get_trend_score',
      description: '获取该股票的趋势评分模型数据，包括总分、各维度得分、预期倍数、护城河子维度等。用于了解该股票的综合投资价值。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_financial_data',
      description: '获取该股票的最新半年报财务数据，包括营收、净利润、毛利率、净利率、研发费用、PE、PB、总市值等。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_forecast_data',
      description: '获取该股票的机构盈利预测数据，包括未来净利润增速、营收增速等预测指标。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_industry_policy',
      description: '获取该股票所处行业的景气度评分和政策趋势信息，包括行业赛道评分、政策线索等。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'get_moat_data',
      description: '获取该股票的护城河四维度数据（业绩爆发力、估值弹性、盈利质量、竞争壁垒），用于判断长期竞争力。',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
];

/** 执行中长线 Agent 工具调用 */
export async function executeMidLongToolCall(
  call: AgentToolCall,
  context: AgentContext,
): Promise<AgentToolResult> {
  const { name } = call;

  try {
    let result: string;

    switch (name) {
      case 'get_trend_score': {
        try {
          const dbResult = await pool.query(
            'SELECT * FROM trend_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
            [context.symbol],
          );
          if (dbResult.rows.length > 0) {
            const row = dbResult.rows[0] as Record<string, unknown>;
            const dimensions = typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions;
            const parts: string[] = [];
            parts.push(`总分: ${row.score}分`);
            parts.push(`评级: ${row.label || '--'}`);
            parts.push(`预期倍数: ${row.expected_multiple || '--'}`);
            if (Array.isArray(dimensions)) {
              for (const dim of dimensions) {
                parts.push(`${dim.name || ''}: ${dim.score || 0}分 (权重${dim.weight || 0}%)`);
                if (Array.isArray(dim.indicators)) {
                  for (const ind of dim.indicators) {
                    parts.push(`  ${ind.name || ''}: ${ind.value || '--'}`);
                  }
                }
              }
            }
            result = parts.join('\n');
          } else {
            result = '暂无趋势评分数据';
          }
        } catch (e) {
          result = '趋势评分数据获取失败: ' + (e instanceof Error ? e.message : '未知错误');
        }
        break;
      }

      case 'get_financial_data': {
        try {
          const [semi, quote] = await Promise.allSettled([
            getSemiAnnualReport(context.symbol),
            TencentQuoteService.getQuote(context.symbol, 'activity'),
          ]);
          const semiData: any = semi.status === 'fulfilled' ? semi.value : {};
          const quoteData: any = quote.status === 'fulfilled' ? quote.value : {};
          const parts: string[] = [];
          const reports = semiData?.reports;
          if (Array.isArray(reports) && reports.length > 0) {
            const latest = reports[0];
            parts.push('最新半年报数据:');
            if (latest.total_revenue != null) parts.push(`  营业总收入: ${latest.total_revenue}元`);
            if (semiData.total_revenue_yoy != null) parts.push(`  营收同比增速: ${semiData.total_revenue_yoy}%`);
            const nIncomeYoy = semiData.n_income_yoy ?? semiData.n_income_attr_p_yoy;
            if (nIncomeYoy != null) parts.push(`  净利润同比增速: ${nIncomeYoy}%`);
            if (latest.n_income_attr_p != null) parts.push(`  归母净利润: ${latest.n_income_attr_p}元`);
            if (latest.rd_exp != null) parts.push(`  研发费用: ${latest.rd_exp}元`);
            if (latest.gross_margin != null) parts.push(`  毛利率: ${latest.gross_margin}%`);
            if (latest.net_margin != null) parts.push(`  净利率: ${latest.net_margin}%`);
          } else {
            parts.push('暂无半年报财务数据');
          }
          if (quoteData?.peRatio != null) parts.push(`PE(TTM): ${quoteData.peRatio}`);
          if (quoteData?.pbRatio != null) parts.push(`PB: ${quoteData.pbRatio}`);
          if (quoteData?.totalMarketValue != null) parts.push(`总市值: ${quoteData.totalMarketValue}`);
          result = parts.join('\n');
        } catch (e) {
          result = '财务数据获取失败: ' + (e instanceof Error ? e.message : '未知错误');
        }
        break;
      }

      case 'get_forecast_data': {
        try {
          const forecast = await ThsService.getProfitForecast(context.symbol);
          const parts: string[] = [];
          if (forecast['摘要']) parts.push(`预测摘要: ${forecast['摘要']}`);
          if (Array.isArray(forecast['业绩预测详表_详细指标预测']) && forecast['业绩预测详表_详细指标预测'].length > 0) {
            parts.push('预测详表:');
            for (const row of forecast['业绩预测详表_详细指标预测'].slice(0, 5)) {
              parts.push(JSON.stringify(row));
            }
          }
          result = parts.join('\n') || '暂无业绩预测数据';
        } catch (e) {
          result = '业绩预测数据获取失败: ' + (e instanceof Error ? e.message : '未知错误');
        }
        break;
      }

      case 'get_industry_policy': {
        try {
          const dbResult = await pool.query(
            'SELECT * FROM trend_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
            [context.symbol],
          );
          if (dbResult.rows.length > 0) {
            const row = dbResult.rows[0] as Record<string, unknown>;
            const dimensions = typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions;
            const trackDim = (Array.isArray(dimensions)
              ? dimensions.find((d: any) => String(d.name || '').includes('行业') || String(d.name || '').includes('赛道'))
              : null);
            if (trackDim) {
              const parts: string[] = [];
              parts.push(`行业赛道评分: ${trackDim.score || 0}分`);
              if (trackDim.detail?.sectorName) parts.push(`行业名称: ${trackDim.detail.sectorName}`);
              if (Array.isArray(trackDim.detail?.policyItems) && trackDim.detail.policyItems.length > 0) {
                parts.push('政策趋势:');
                for (const item of trackDim.detail.policyItems) {
                  const filtered = [item.name, item.desc, item.value].filter(Boolean).join(': ');
                  if (filtered) parts.push(`  - ${filtered}`);
                }
              }
              result = parts.join('\n');
            } else {
              result = '趋势评分中暂无行业维度数据';
            }
          } else {
            result = '暂无行业景气数据';
          }
        } catch (e) {
          result = '行业政策数据获取失败: ' + (e instanceof Error ? e.message : '未知错误');
        }
        break;
      }

      case 'get_moat_data': {
        try {
          const dbResult = await pool.query(
            'SELECT * FROM trend_scores WHERE symbol = $1 ORDER BY score_date DESC LIMIT 1',
            [context.symbol],
          );
          if (dbResult.rows.length > 0) {
            const row = dbResult.rows[0] as Record<string, unknown>;
            const dimensions = typeof row.dimensions === 'string' ? JSON.parse(row.dimensions) : row.dimensions;
            const fundamentalDim = (Array.isArray(dimensions)
              ? dimensions.find((d: any) => String(d.name || '').includes('基本面'))
              : null);
            if (fundamentalDim) {
              const parts: string[] = [];
              const subDimensions = Array.isArray(fundamentalDim.subDimensions) ? fundamentalDim.subDimensions : [];
              if (subDimensions.length > 0) {
                parts.push('护城河四维度:');
                for (const sub of subDimensions) {
                  parts.push(`  ${sub.name || ''}: ${sub.score || 0}分`);
                  if (Array.isArray(sub.indicators)) {
                    for (const ind of sub.indicators) {
                      parts.push(`    ${ind.name || ''}: ${ind.value || '--'}`);
                    }
                  }
                }
              }
              result = parts.join('\n') || '暂无护城河数据';
            } else {
              result = '趋势评分中暂无基本面维度数据';
            }
          } else {
            result = '暂无趋势评分数据';
          }
        } catch (e) {
          result = '护城河数据获取失败: ' + (e instanceof Error ? e.message : '未知错误');
        }
        break;
      }

      default:
        result = `错误：未知工具 ${name}`;
    }

    return { tool_call_id: call.id, name, content: result };
  } catch (error) {
    return {
      tool_call_id: call.id,
      name,
      content: `工具执行错误: ${error instanceof Error ? error.message : '未知错误'}`,
    };
  }
}
