// src/modules/insight/InsightService.ts
// 自选股洞察：来源文章采集 → 自选股筛选 → stock-trace mv 事件
//
// 数据流：
//   fetchLatest（增量抓取，跳过已知文章）→ fetchDetail + parseTitleKeywords 组装
//   → upsertSources 入库 → 文章提及标的 ∩ 用户自选股 → radarHitToPriceEvent
//   → StockTraceService.processPriceFact(immediateEnqueue=true) → stock_trace mv 事件
import pool from '../../core/db';
import { TradingCalendarService } from '../../shared/utils/TradingCalendarService';
import { fetchLatest, fetchDetail, parseTitleKeywords, parseTitleStockName, parseLimitUpSymbolsFromSummary } from './LimitUpRadarCrawler';
import { upsertSources, getHighWatermark, setHighWatermark } from './InsightSourceService';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { StockTraceService } from '../stock-trace/StockTraceService';
import { isEligiblePriceSecurity, PRICE_TRIGGER_PERCENT, type FavoriteSecurity } from '../stock-trace/types';
import type { SourceArticle } from './InsightSourceService';
import type { MentionedSymbol } from './types';

/**
 * 执行一轮采集：
 * 1. 冷启动回溯 2 个交易日，此后从上一高水位开始增量抓取；
 * 2. 详情解析并入库；
 * 3. 文章提及标的中命中用户自选股的，调用 radarHitToPriceEvent 拉行情；
 * 4. 行情满足触发条件 → StockTraceService.processPriceFact(immediateEnqueue=true)
 *    → stock_trace mv 事件（不再走 watchlist_insight_events/enqueue）；
 * 5. 推进高水位，供下次增量回溯。
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
        try {
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
        } catch (e) {
            // 单篇详情抓取失败（如陈旧链接 404）只记日志跳过，不中断整轮采集
            console.warn(`[insight] fetchDetail failed: ${a.articleId}`,
                e instanceof Error ? e.message : String(e));
        }
    }
    const inserted = await upsertSources(enriched);

    // 自选股筛选：事件股票必须与标题主体股票一致（详情页推荐链接的股票不建事件），
    // 且该主体股票命中用户自选股 —— 防止事件挂到页面推荐/相关股票上（数据错配根因）
    const watchlist = await getWatchlistSymbols();
    // 2026-08-30 链路合并：命中自选股 → stock-trace mv 事件（immediateEnqueue 立即归因）；
    // 不再创建 watchlist_insight_events（存量保留）。重复触发由 stock_trace revision 机制天然去重。
    const securities = await StockTraceService.getFavoriteSecurities();
    let events = 0;
    for (const a of enriched) {
        const handleHit = async (s: MentionedSymbol): Promise<void> => {
            if (!watchlist.has(s.symbol)) return;
            try {
                const { triggered } = await radarHitToPriceEvent(s.symbol, securities);
                if (triggered) events++;
            } catch (e) {
                // 单股触发失败（行情抖动等）只记日志，不中断整轮；下轮重复文章会被 sources 幂等跳过
                console.warn('[insight] radar→stock-trace emit failed:', e instanceof Error ? e.message : String(e));
            }
        };
        const titleStock = parseTitleStockName(a.title);
        if (titleStock) {
            const hit = a.mentionedSymbols.find(s => s.name === titleStock && watchlist.has(s.symbol));
            if (hit) await handleHit(hit);
            continue;
        }
        // 涨停复盘汇总文章（无标题主体）：从正文"涨停/涨超"语境提取个股，命中自选股逐只建事件
        // （2026-08-20 增强：防"涨停个股过多汇总进复盘文章"导致漏检，如近岸蛋白 08-20 案例）
        if (/涨停复盘/.test(a.title)) {
            for (const s of parseLimitUpSymbolsFromSummary(a.content, a.mentionedSymbols)) {
                await handleHit(s);
            }
        }
    }
    await setHighWatermark(todayStr());
    return { collected: inserted, events };
}

/** 读取用户自选股集合（仅保留 stocks 表中存在的标的） */
export async function getWatchlistSymbols(): Promise<Set<string>> {
    const { rows } = await pool.query(
        'SELECT DISTINCT us.symbol FROM user_stocks us JOIN stocks s ON s.symbol = us.symbol',
    );
    return new Set(rows.map((r: { symbol: string }) => r.symbol));
}

/**
 * 生成洞察事件 ID：涨停 wi_{date}_{symbol}_limit_up；价格异动 wi_{date}_{symbol}_pm_{direction}。
 * 事件 ID 由 createEvent 内部生成，runCycle 入队时需同源复用，故抽为导出辅助，
 * 保证与 016 迁移及 watchlist_insight_jobs.event_id 关联键格式一致。
 */
export function buildEventId(symbol: string, tradeDate: string, kind: 'limit_up' | 'pm', direction?: 'up' | 'down'): string {
    return kind === 'limit_up'
        ? `wi_${tradeDate.replace(/-/g, '')}_${symbol}_limit_up`
        : `wi_${tradeDate.replace(/-/g, '')}_${symbol}_pm_${direction}`;
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
    const eventId = buildEventId(symbol, tradeDate, 'limit_up');
    const res = await pool.query(
        `INSERT INTO watchlist_insight_events (event_id, symbol, stock_name, trade_date, source_id)
         VALUES ($1,$2,$3,$4,$5) ON CONFLICT (symbol, trade_date, direction, insight_group) DO NOTHING RETURNING event_id`,
        [eventId, symbol, stockName, tradeDate, sourceId],
    );
    return res.rows.length > 0;
}

/** activity 行情字段（中文键）→ 数值（undefined/NaN → null）。 */
export function parseActivityQuote(row: Record<string, unknown>): {
    latest: number | null; prevClose: number | null; changePct: number | null; name: string;
} {
    const numeric = (value: unknown): number | null => {
        const numberValue = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(numberValue) ? numberValue : null;
    };
    return {
        latest: numeric(row['最新价']),
        prevClose: numeric(row['昨收价']),
        changePct: numeric(row['涨跌幅']),
        name: typeof row['股票简称'] === 'string' ? row['股票简称'] : '',
    };
}

/**
 * 涨停雷达文章命中 → 拉行情 → processPriceFact（immediateEnqueue 盘中立即归因）。
 * 行情缺失或 |changePct| < PRICE_TRIGGER_PERCENT → 跳过不建事件（防假数据，当日由午尾盘打点兜底）。
 */
export async function radarHitToPriceEvent(
    symbol: string,
    securities: FavoriteSecurity[],
): Promise<{ triggered: boolean }> {
    const security = securities.find((s) => s.symbol === symbol);
    if (!security || !isEligiblePriceSecurity(security, new Date())) return { triggered: false };
    const quotes = await TencentQuoteService.getBatchQuotes([symbol], 'activity');
    const row = quotes.find((q) => String(q['股票代码']) === symbol);
    if (!row) return { triggered: false };
    const { latest, prevClose, changePct, name } = parseActivityQuote(row as Record<string, unknown>);
    if (latest === null || prevClose === null || prevClose <= 0 || changePct === null) return { triggered: false };
    if (Math.abs(changePct) < PRICE_TRIGGER_PERCENT) return { triggered: false };
    await StockTraceService.processPriceFact(security, {
        symbol, stockName: name || security.stockName, latestPrice: latest,
        previousClose: prevClose, changePct, observedAt: new Date(),
    }, { immediateEnqueue: true });
    return { triggered: true };
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

/** 上海时区 YYYY-MM-DD：经 Asia/Shanghai 时区转换取年月日，任何时刻调用都得到上海当地日期（不依赖 getUTC* 归一化前提） */
function formatShanghaiDate(date: Date): string {
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const get = (type: string) => parts.find(p => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')}`;
}

/** 上海时区当日 YYYY-MM-DD（高水位键格式） */
function todayStr(): string {
    return formatShanghaiDate(new Date());
}
