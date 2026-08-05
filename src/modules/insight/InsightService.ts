// src/modules/insight/InsightService.ts
// 自选股洞察：来源文章采集 → 自选股筛选 → 洞察事件创建
//
// 数据流：
//   fetchLatest（增量抓取，跳过已知文章）→ fetchDetail + parseTitleKeywords 组装
//   → upsertSources 入库 → 文章提及标的 ∩ 用户自选股 → createEvent（幂等）→ 推进高水位
import pool from '../../core/db';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { fetchLatest, fetchDetail, parseTitleKeywords } from './LimitUpRadarCrawler';
import { upsertSources, getHighWatermark, setHighWatermark } from './InsightSourceService';
import type { SourceArticle } from './InsightSourceService';

/**
 * 执行一轮采集：
 * 1. 冷启动回溯 2 个交易日，此后从上一高水位开始增量抓取；
 * 2. 详情解析并入库；
 * 3. 文章提及标的中命中用户自选股的，创建洞察事件（业务唯一键幂等）；
 * 4. 推进高水位，供下次增量回溯。
 * @returns 新入库文章数与新建事件数
 */
export async function runCycle(): Promise<{ collected: number; events: number }> {
    const highwater = (await getHighWatermark()) ?? twoTradingDaysAgo();
    const known = new Set<string>(
        (await pool.query('SELECT DISTINCT article_id FROM watchlist_insight_sources')).rows.map(
            (r: { article_id: string }) => r.article_id,
        ),
    );
    const articles = await fetchLatest(known, highwater);

    const enriched: SourceArticle[] = [];
    for (const a of articles) {
        const detail = await fetchDetail(a.detailUrl);
        enriched.push({
            articleId: a.articleId,
            detailUrl: a.detailUrl,
            title: a.title,
            keywords: parseTitleKeywords(a.title),
            content: detail.content,
            mentionedSymbols: detail.mentionedSymbols,
            publishedAt: detail.publishedAt,
            // 交易日直接从列表解析结果取（YYYY-MM-DD），无需再次截取
            tradeDate: a.tradeDate,
        });
    }
    const inserted = await upsertSources(enriched);

    // 自选股筛选：文章"文章提及标的" ∩ 用户自选股
    const watchlist = await getWatchlistSymbols();
    let events = 0;
    for (const a of enriched) {
        const hit = a.mentionedSymbols.find(s => watchlist.has(s.symbol));
        if (!hit) continue;
        if (await createEvent(hit.symbol, hit.name, a.articleId, a.tradeDate)) events++;
    }
    await setHighWatermark(todayStr());
    return { collected: inserted, events };
}

/** 读取用户自选股集合（仅保留 stocks 表中存在的标的） */
async function getWatchlistSymbols(): Promise<Set<string>> {
    const { rows } = await pool.query(
        'SELECT DISTINCT us.symbol FROM user_stocks us JOIN stocks s ON s.symbol = us.symbol',
    );
    return new Set(rows.map((r: { symbol: string }) => r.symbol));
}

/**
 * 创建洞察事件。
 * 业务唯一键 (symbol, trade_date, direction, insight_group)，direction='up'、insight_group='limit_up_radar'
 * 均由表默认值填充；重复调用命中 ON CONFLICT DO NOTHING，返回 false（幂等）。
 * @returns true=本次新插入，false=已存在
 */
export async function createEvent(
    symbol: string,
    stockName: string,
    sourceId: string,
    tradeDate: string,
): Promise<boolean> {
    const eventId = `wi_${tradeDate.replace(/-/g, '')}_${symbol}_limit_up`;
    const res = await pool.query(
        `INSERT INTO watchlist_insight_events (event_id, symbol, stock_name, trade_date, source_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (symbol, trade_date, direction, insight_group) DO NOTHING RETURNING event_id`,
        [eventId, symbol, stockName, tradeDate, sourceId],
    );
    return res.rows.length > 0;
}

/** 冷启动回溯起点：最近交易日向前数 2 个交易日的日期（复用 TradingCalendarService，不自写周末/节假日判断） */
function twoTradingDaysAgo(date: Date = new Date()): string {
    let day = TradingCalendarService.getRecentTradingDay(date);
    let remaining = 2;
    while (remaining > 0) {
        day = new Date(day.getTime() - 24 * 60 * 60 * 1000);
        if (TradingCalendarService.isTradingDay(day)) remaining--;
    }
    return formatShanghaiDate(day);
}

/** getRecentTradingDay 返回的 Date 的 UTC 年月日即上海日历年月日（见 TradingCalendarService.toDate） */
function formatShanghaiDate(date: Date): string {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

/** 上海时区当日 YYYY-MM-DD（高水位键格式） */
function todayStr(): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}
