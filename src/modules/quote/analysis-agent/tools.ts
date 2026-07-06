import { ClsStockNewsService } from '../../monitor/ClsStockNewsService';
import { ThsService } from '../../monitor/ThsService';
import { TencentQuoteService } from '../TencentQuoteService';
import type { AgentToolCall, AgentToolResult, AgentContext } from './types';

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
