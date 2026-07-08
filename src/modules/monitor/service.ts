import { StockInfoService, type StockInfoImpact, type StockInfoJudgementRow } from '../crawler/StockInfoService';
import pool from '../../core/db';

const INFO_TYPE_LABELS: Record<string, string> = {
    announcement: '公告研判',
    news: '新闻研判',
};

const HORIZON_CYCLES: Record<string, string> = {
    短期: 'short',
    中期: 'mid',
    长期: 'long',
    中长期: 'long',
};

const TREND_HOTSPOT_IMPACTS = new Set<StockInfoImpact>(['重大利好', '利好', '中性', '利空', '重大利空']);

export interface MonitorEventItem {
    event_id: string;
    symbol: string;
    stock_code: string;
    stock_name: string;
    industry: string;
    change_type: string;
    change_type_name: string;
    level: string;
    cycle: string;
    price: number | null;
    change_pct: number | null;
    volume_ratio: number | null;
    turnover_rate: number | null;
    event_time: string | Date;
    title: string;
    summary: string;
    detail_url: string;
    info_type: string;
    ai_impact: string;
    ai_horizon: string;
    ai_keywords: string[];
    source: string;
}

export interface TrendHotspotStats {
    total: number;
    announcement: number;
    news: number;
    positive: number;
    negative: number;
}

function normalizeStockCode(value: string): string {
    return String(value || '').replace(/^(SH|SZ|BJ)/i, '').trim();
}

function normalizeCycle(value: string | undefined): string | undefined {
    if (!value || value === 'all') return undefined;
    return value;
}

function normalizeImpact(value: string | undefined): StockInfoImpact | undefined {
    return value && TREND_HOTSPOT_IMPACTS.has(value as StockInfoImpact)
        ? value as StockInfoImpact
        : undefined;
}

async function enrichIndustry(events: MonitorEventItem[]): Promise<MonitorEventItem[]> {
    if (events.length === 0) return events;
    const symbols = [...new Set(events.map(e => e.symbol).filter(Boolean))];
    if (symbols.length === 0) return events;

    try {
        // 从 stocks 表获取行业板块名称（Tushare stock_basic.industry），与个股详情页"行业板块"一致
        const result = await pool.query(
            `SELECT symbol, industry FROM stocks WHERE symbol = ANY($1)`,
            [symbols],
        );

        const industryMap = new Map<string, string>();
        for (const row of result.rows) {
            if (row.industry) industryMap.set(row.symbol, row.industry);
        }

        // 回退：对 stocks 表中没有 industry 的 symbol，从 stock_concept_mapping 取第一条
        const missingSymbols = symbols.filter(s => !industryMap.has(s));
        if (missingSymbols.length > 0) {
            const fallbackResult = await pool.query(
                `SELECT DISTINCT ON (symbol) symbol, sector_name
                 FROM stock_concept_mapping
                 WHERE symbol = ANY($1)
                 ORDER BY symbol, sector_name`,
                [missingSymbols],
            );
            for (const row of fallbackResult.rows) {
                industryMap.set(row.symbol, row.sector_name);
            }
        }

        for (const event of events) {
            event.industry = industryMap.get(event.symbol) || '';
        }
    } catch (err) {
        console.error('enrichIndustry failed:', err);
    }

    return events;
}

function mapJudgementToEvent(row: StockInfoJudgementRow): MonitorEventItem {
    return {
        event_id: `stock_info:${row.id}`,
        symbol: row.symbol,
        stock_code: normalizeStockCode(row.symbol),
        stock_name: row.stock_name || row.symbol,
        industry: '',
        change_type: row.info_type,
        change_type_name: INFO_TYPE_LABELS[row.info_type] || row.info_type,
        level: row.ai_impact,
        cycle: HORIZON_CYCLES[row.ai_horizon] || 'short',
        price: null,
        change_pct: null,
        volume_ratio: null,
        turnover_rate: null,
        event_time: row.published_at,
        title: row.title,
        summary: row.ai_summary,
        detail_url: row.url,
        info_type: row.info_type,
        ai_impact: row.ai_impact,
        ai_horizon: row.ai_horizon,
        ai_keywords: row.ai_keywords,
        source: row.source || '',
    };
}

export class StockMonitorService {
    static async getEvents(params: {
        cycle?: string;
        change_type?: string;
        stock_code?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ total: number; events: MonitorEventItem[] }> {
        const cycle = normalizeCycle(params.cycle);
        const result = await StockInfoService.queryJudgements({
            symbol: params.stock_code,
            info_type: params.change_type as any,
            impact: normalizeImpact(params.change_type),
            limit: params.limit || 20,
            offset: params.offset || 0,
        });

        const events = result.items.map(mapJudgementToEvent);
        const filteredEvents = cycle
            ? events.filter(event => event.cycle === cycle)
            : events;

        await enrichIndustry(filteredEvents);

        return {
            total: cycle ? filteredEvents.length : result.total,
            events: filteredEvents,
        };
    }

    static async getEventsByStockCode(stockCode: string, params?: {
        cycle?: string;
        limit?: number;
    }): Promise<MonitorEventItem[]> {
        const result = await StockMonitorService.getEvents({
            stock_code: stockCode,
            cycle: params?.cycle,
            limit: params?.limit || 20,
        });
        return result.events;
    }

    /**
     * 根据用户自选股过滤研判资讯
     */
    static async getEventsByUserFavorites(openid: string, params?: {
        cycle?: string;
        change_type?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ total: number; events: MonitorEventItem[] }> {
        // 获取用户自选股列表
        const stocksResult = await pool.query(
            `SELECT symbol FROM user_stocks WHERE openid = $1`,
            [openid],
        );
        const symbols = stocksResult.rows.map((r: any) => r.symbol as string);
        if (symbols.length === 0) {
            return { total: 0, events: [] };
        }

        const cycle = normalizeCycle(params?.cycle);
        await StockInfoService.ensureSchema();

        // 按自选股symbol批量查询研判数据
        const conditions = ['symbol = ANY($1)'];
        const values: any[] = [symbols];

        if (params?.change_type) {
            const impact = normalizeImpact(params.change_type);
            if (impact) {
                values.push(impact);
                conditions.push(`ai_impact = $${values.length}`);
            } else {
                const infoType = params.change_type as 'news' | 'announcement';
                if (infoType === 'news' || infoType === 'announcement') {
                    values.push(infoType);
                    conditions.push(`info_type = $${values.length}`);
                }
            }
        }

        const whereClause = `WHERE ${conditions.join(' AND ')}`;
        const countResult = await pool.query(
            `SELECT COUNT(*)::int AS total FROM stock_info_judgements ${whereClause}`,
            values,
        );

        const limit = params?.limit || 20;
        const offset = params?.offset || 0;
        const listValues = [...values, limit, offset];
        const result = await pool.query(
            `SELECT id, symbol, stock_name, info_type, source, source_id, title, url, published_at,
                    ai_impact, ai_horizon, ai_keywords, ai_summary, created_at
             FROM stock_info_judgements
             ${whereClause}
             ORDER BY published_at DESC, id DESC
             LIMIT $${listValues.length - 1} OFFSET $${listValues.length}`,
            listValues,
        );

        const items: StockInfoJudgementRow[] = result.rows.map((row: any) => ({
            ...row,
            ai_keywords: Array.isArray(row.ai_keywords) ? row.ai_keywords : [],
        }));

        let events = items.map(mapJudgementToEvent);
        if (cycle) {
            events = events.filter(event => event.cycle === cycle);
        }

        await enrichIndustry(events);

        return {
            total: cycle ? events.length : Number(countResult.rows[0]?.total || 0),
            events,
        };
    }

    static async getStats(): Promise<TrendHotspotStats> {
        await StockInfoService.ensureSchema();
        const poolModule = await import('../../core/db');
        const result = await poolModule.default.query(
            `SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE info_type = 'announcement')::int AS announcement,
                COUNT(*) FILTER (WHERE info_type = 'news')::int AS news,
                COUNT(*) FILTER (WHERE ai_impact IN ('重大利好', '利好'))::int AS positive,
                COUNT(*) FILTER (WHERE ai_impact IN ('重大利空', '利空'))::int AS negative
             FROM stock_info_judgements`,
        );

        const row = result.rows[0] || {};
        return {
            total: Number(row.total || 0),
            announcement: Number(row.announcement || 0),
            news: Number(row.news || 0),
            positive: Number(row.positive || 0),
            negative: Number(row.negative || 0),
        };
    }

    /**
     * 获取个股监控数据（供 /internal/monitor/:symbol 接口调用）
     * 包装 getEventsByStockCode()，返回该股票的研判资讯事件列表
     */
    static async getMonitorData(symbol: string): Promise<MonitorEventItem[]> {
        return this.getEventsByStockCode(symbol);
    }

    /**
     * 获取告警历史（供 /internal/monitor/alerts 接口调用）
     * 包装 getEvents()，返回全局研判资讯事件（分页）
     */
    static async getAlertHistory(query: {
        cycle?: string;
        change_type?: string;
        limit?: number;
        offset?: number;
    }): Promise<{ total: number; events: MonitorEventItem[] }> {
        return this.getEvents(query);
    }
}
