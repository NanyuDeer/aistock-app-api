import pool from '../../core/db';
import { extractStockCodes, loadStockNameMap } from '../monitor/HotKeywordDetectorService';

export interface ResearchReportStock {
  symbol: string;
  stockName: string;
  messageId: string;
  chatName: string;
  text: string;
  receivedAt: string;
}

const REPORT_KEYWORDS = ['研报', 'VIP', '风口研报', '个股推荐', '推荐', '目标价', '评级', '买入', '增持'];

export function isResearchReportMessage(text: string, chatName: string = ''): boolean {
  const combined = `${text} ${chatName}`;
  return REPORT_KEYWORDS.some(kw => combined.includes(kw));
}

export function extractReportRecommendedStocks(text: string): { symbol: string; stockName: string }[] {
  const codes = extractStockCodes(text);
  return Array.from(codes.entries()).map(([symbol, stockName]) => ({ symbol, stockName }));
}

export async function findResearchReportMessagesForStock(
  symbol: string,
  hours: number = 24,
): Promise<ResearchReportStock[]> {
  // 预加载 A 股名称映射（用于公司名称→代码匹配）
  await loadStockNameMap();

  // 查询1：通过 stock_codes 数组匹配（bot 已提取代码的消息）
  const resultByCode = await pool.query(
    `SELECT id, chat_name, message_id, text, stock_codes, received_at
     FROM feishu_messages
     WHERE received_at > NOW() - INTERVAL '${hours} hours'
       AND $1 = ANY(stock_codes)
     ORDER BY received_at DESC
     LIMIT 100`,
    [symbol],
  );

  // 查询2：stock_codes 为空的消息，回退到文本提取名称匹配
  // 飞书消息文本中通常只有描述性文字（如"这家公司"），不直接包含股票名称，
  // 但 bot 入库时可能未填充 stock_codes，需要从文本中重新提取
  const resultByText = await pool.query(
    `SELECT id, chat_name, message_id, text, stock_codes, received_at
     FROM feishu_messages
     WHERE received_at > NOW() - INTERVAL '${hours} hours'
       AND array_length(stock_codes, 1) IS NULL
     ORDER BY received_at DESC
     LIMIT 200`,
  );

  // 合并去重
  const seenIds = new Set<number>();
  const allRows = [...resultByCode.rows];
  for (const row of resultByText.rows) {
    if (!seenIds.has(row.id)) {
      seenIds.add(row.id);
      // 从文本中提取股票代码，检查是否包含目标股票
      const extracted = extractStockCodes(row.text || '');
      if (extracted.has(symbol)) {
        allRows.push(row);
      }
    }
  }
  // 对查询1的行也加入去重集合
  for (const row of resultByCode.rows) {
    seenIds.add(row.id);
  }

  const matched: ResearchReportStock[] = [];

  for (const row of allRows) {
    const text = String(row.text || '');
    const chatName = String(row.chat_name || '');
    if (!isResearchReportMessage(text, chatName)) continue;

    const stocks = extractReportRecommendedStocks(text);
    const stock = stocks.find(s => s.symbol === symbol);
    if (!stock) continue;

    matched.push({
      symbol: stock.symbol,
      stockName: stock.stockName,
      messageId: row.message_id,
      chatName,
      text: text.slice(0, 200),
      receivedAt: row.received_at,
    });
  }

  return matched;
}
