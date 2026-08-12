// src/modules/insight/EvidencePackageService.ts
// 冻结证据包：触发时收集公告/新闻/业绩/研报/涨停雷达，Node 侧计算 days_offset 与 time_bucket，
// Python 侧仅消费并乘时效系数（PRD §8：证据时效分层参数经实证校准）
import pool from '../../core/db';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { ClsStockNewsService } from '../monitor/ClsStockNewsService';
import { StockInfoService } from '../crawler/StockInfoService';
import { SectorMarketEvidenceService } from './SectorMarketEvidenceService';

export type EvidenceSourceType = 'announcement' | 'news' | 'earnings' | 'rating' | 'radar_article' | 'quant';
export type TimeBucket = 'T0' | 'T1' | 'T2' | 'earnings';

export interface EvidenceItem {
    source_id: string;
    source_type: EvidenceSourceType;
    provider: string;
    title: string;
    excerpt: string;
    published_at: string;      // ISO 时间
    symbol: string;
    url?: string;
    strength: number;          // 初始强度（LLM 前置，Python 乘时效系数）
    days_offset: number;       // published_at 所在交易日 → trade_date 的交易日落差（0=当日,1=T-1）
    time_bucket: TimeBucket;
}

/** 计算某日期（Asia/Shanghai）到 tradeDate 的交易日偏移；published_at 落在非交易日（如周末公告）时回溯到最近交易日再计算 */
export function tradingDayOffset(tradeDate: string, dateStr: string): number | null {
    let target = new Date(`${dateStr}T00:00:00+08:00`);
    while (!TradingCalendarService.isTradingDay(target)) {
        target = new Date(target.getTime() - 24 * 60 * 60 * 1000);
    }
    let offset = 0;
    let cursor = new Date(`${tradeDate}T00:00:00+08:00`);
    while (cursor.getTime() > target.getTime()) {
        cursor = new Date(cursor.getTime() - 24 * 60 * 60 * 1000);
        if (TradingCalendarService.isTradingDay(cursor)) offset++;
    }
    return offset;
}

/** 按 days_offset + source_type 归类时效层（PRD §8：T0/T1/T2 + 业绩特例 T-20） */
export function computeTimeBucket(daysOffset: number, sourceType: EvidenceSourceType): TimeBucket {
    if (sourceType === 'earnings') return 'earnings';                 // 业绩特例：可追溯至 T-20
    if (daysOffset <= 1) return 'T0';                                 // T-1 至触发时刻（含当日）
    if (daysOffset <= 5) return 'T1';                                 // T-2 ~ T-5
    if (daysOffset <= 10) return 'T2';                                // T-6 ~ T-10
    return 'T2';                                                      // 超出窗口：仍给 T2 由 Python 判低权重
}

export async function collectEvidence(
    symbol: string,
    stockName: string,
    tradeDate: string,
    direction: 'up' | 'down',
): Promise<EvidenceItem[]> {
    const items: EvidenceItem[] = [];
    const push = (it: Omit<EvidenceItem, 'days_offset' | 'time_bucket' | 'published_at'> & { published_at?: string | Date | null }) => {
        if (!it.published_at) return;                                  // 来源时间无法确认 → 不纳入（PRD：unconfirmed 情形之一）
        const pubStr = it.published_at instanceof Date ? it.published_at.toISOString() : String(it.published_at);
        const offset = tradingDayOffset(tradeDate, pubStr.slice(0, 10));
        if (offset === null || offset > 20) return;                    // 超窗口（>20 交易日）不纳入
        items.push({
            ...it,
            published_at: pubStr,
            days_offset: offset,
            time_bucket: computeTimeBucket(offset, it.source_type),
        });
    };

    // 1. 财联社个股新闻（provider=cls）
    try {
        const news = await ClsStockNewsService.getStockNews(symbol, { limit: 10, lastTime: 0 });
        for (const n of news.items) {
            push({
                source_id: `cls:${n.id}`, source_type: 'news', provider: 'cls',
                title: n.title || '', excerpt: (n.content || '').slice(0, 200),
                published_at: n.time, symbol, url: n.link, strength: 0.5,
            });
        }
    } catch (e) { console.warn('[evidence] cls news failed', e instanceof Error ? e.message : String(e)); }

    // 2. 公告研判（provider=stock_info，东财公告 AI 研判入库）
    try {
        const ann = await StockInfoService.queryJudgements({ symbol, info_type: 'announcement', limit: 10, offset: 0 });
        for (const a of ann.items) {
            push({
                source_id: `announcement:${a.id}`, source_type: 'announcement', provider: a.source || 'stock_info',
                title: a.title, excerpt: (a.ai_summary || a.title || '').slice(0, 200),
                published_at: a.published_at, symbol, url: a.url, strength: 0.7,
            });
        }
    } catch (e) { console.warn('[evidence] announcement failed', e instanceof Error ? e.message : String(e)); }

    // 3. 业绩预告/正式财报（performance_reports：express/formal）
    try {
        const { rows } = await pool.query(
            `SELECT end_date, report_type, n_income_attr_p, ai_tag, total_revenue
             FROM performance_reports WHERE symbol=$1 AND report_type IN ('express','formal')
             ORDER BY end_date DESC LIMIT 5`, [symbol]);
        for (const r of rows) {
            push({
                source_id: `earnings:${symbol}:${r.end_date}`, source_type: 'earnings', provider: 'tushare',
                title: `${r.report_type === 'express' ? '业绩预告' : '财报'} ${r.end_date}`,
                excerpt: `净利润 ${r.n_income_attr_p ?? '--'}${r.ai_tag ? `；AI标签：${r.ai_tag}` : ''}`,
                published_at: `${r.end_date}`, symbol, strength: 0.8,
            });
        }
    } catch (e) { console.warn('[evidence] earnings failed', e instanceof Error ? e.message : String(e)); }

    // 4. 研报评级（performance_reports：rating，仅结构化评级无正文）
    try {
        const { rows } = await pool.query(
            `SELECT end_date, report_type, ai_tag FROM performance_reports
             WHERE symbol=$1 AND report_type='rating' ORDER BY end_date DESC LIMIT 3`, [symbol]);
        for (const r of rows) {
            push({
                source_id: `rating:${symbol}:${r.end_date}`, source_type: 'rating', provider: 'tushare',
                title: `研报评级 ${r.end_date}`, excerpt: r.ai_tag || '', published_at: `${r.end_date}`,
                symbol, strength: 0.4,
            });
        }
    } catch (e) { console.warn('[evidence] rating failed', e instanceof Error ? e.message : String(e)); }

    // 5. 近 2 个交易日涨停雷达文章（watchlist_insight_sources，覆盖 T-1 至当日，T0 层证据）
    try {
        const t1Date = new Date(new Date(`${tradeDate}T00:00:00+08:00`).getTime() - 3 * 24 * 60 * 60 * 1000)
            .toISOString().slice(0, 10); // 保守 3 自然天覆盖 T-1 交易日
        const { rows } = await pool.query(
            `SELECT source_id, source_url, title, content, published_at FROM watchlist_insight_sources
             WHERE trade_date >= $1 AND trade_date <= $2 ORDER BY published_at DESC LIMIT 5`,
            [t1Date, tradeDate]);
        for (const a of rows) {
            push({
                source_id: `radar:${a.source_id}`, source_type: 'radar_article', provider: 'ths',
                title: a.title, excerpt: (a.content || '').slice(0, 300),
                published_at: a.published_at, symbol, url: a.source_url, strength: 0.6,
            });
        }
    } catch (e) { console.warn('[evidence] radar failed', e instanceof Error ? e.message : String(e)); }

    return items;
}

export async function freezeEvidencePackage(
    eventId: string,
    snapshot: { symbol: string; tradeDate: string; direction: 'up' | 'down' },
): Promise<void> {
    const evidence = await collectEvidence(snapshot.symbol, '', snapshot.tradeDate, snapshot.direction);
    const quant = await SectorMarketEvidenceService.collect(snapshot.symbol, snapshot.tradeDate, snapshot.direction);
    const allEvidence = [...evidence, ...quant];
    const { rows } = await pool.query(
        `SELECT COALESCE(MAX(frozen_seq), 0) + 1 AS next_seq FROM watchlist_evidence_packages WHERE event_id=$1`,
        [eventId]);
    const seq = Number(rows[0]?.next_seq ?? 1);
    await pool.query(
        `INSERT INTO watchlist_evidence_packages (event_id, frozen_seq, trigger_at, evidence, coverage)
         VALUES ($1,$2,NOW(),$3,$4)`,
        [eventId, seq, JSON.stringify(allEvidence), JSON.stringify({ source_count: allEvidence.length })],
    );
    console.log(`[evidence] frozen event=${eventId} seq=${seq} sources=${allEvidence.length} (quant=${quant.length})`);
}