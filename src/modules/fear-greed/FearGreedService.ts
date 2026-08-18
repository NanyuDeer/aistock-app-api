/**
 * 恐贪指数服务：编排计算 → PG 快照落库 → Redis 缓存 → 组装 dashboard。
 * 替代原 Python FastAPI 服务（services/calculator.py），接口契约保持一致。
 */
import pool from '../../core/db';
import redis from '../../core/redis';
import { tushareRequest } from '../quote/TushareService';
import { computeJq, type BreadthCache, type JqResult } from './calculator';

const CACHE_TTL_SECONDS = 30 * 60; // 30 分钟（与 Python 版一致）

// 内存缓存：{ key: { ts, result } }
const memoryCache = new Map<string, { ts: number; result: JqResult }>();

/** breadth 指标缓存：PG 表 breadth_daily */
const breadthCache: BreadthCache = {
    async getAll(): Promise<Map<string, number>> {
        const { rows } = await pool.query('SELECT trade_date, up_ratio FROM breadth_daily');
        const map = new Map<string, number>();
        for (const r of rows as { trade_date: string; up_ratio: number }[]) {
            map.set(String(r.trade_date).replace(/-/g, ''), Number(r.up_ratio));
        }
        return map;
    },
    async upsert(rows: { tradeDate: string; upRatio: number }[]): Promise<void> {
        if (!rows.length) return;
        const values = rows
            .map((r) => `('${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6, 8)}', ${r.upRatio})`)
            .join(',');
        await pool.query(`
            INSERT INTO breadth_daily (trade_date, up_ratio) VALUES ${values}
            ON CONFLICT (trade_date) DO UPDATE SET up_ratio = EXCLUDED.up_ratio
        `);
    },
};

/** 建表（幂等，启动时调用） */
export async function ensureFearGreedSchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS fear_greed_snapshot (
            id SERIAL PRIMARY KEY,
            index_key VARCHAR(10) NOT NULL,
            trade_date DATE NOT NULL,
            composite NUMERIC(6,2) NOT NULL,
            label VARCHAR(20) NOT NULL,
            indicators_json TEXT NOT NULL DEFAULT '[]',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(index_key, trade_date)
        )
    `);
    await pool.query(`
        CREATE TABLE IF NOT EXISTS breadth_daily (
            trade_date DATE PRIMARY KEY,
            up_ratio NUMERIC(6,2) NOT NULL
        )
    `);
}

/** 计算并返回最新结果（优先内存缓存；可选强制刷新） */
export async function getLatestJq(force = false): Promise<JqResult> {
    const now = Date.now();
    if (!force) {
        const hit = memoryCache.get('jq');
        if (hit && now - hit.ts < CACHE_TTL_SECONDS * 1000) return hit.result;
    }

    const result = await computeJq({ request: tushareRequest }, breadthCache);
    memoryCache.set('jq', { ts: now, result });

    // PG 快照落库（按 index_key + trade_date 去重）
    try {
        const today = new Date().toISOString().slice(0, 10);
        await pool.query(
            `INSERT INTO fear_greed_snapshot (index_key, trade_date, composite, label, indicators_json)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (index_key, trade_date) DO UPDATE SET
               composite = EXCLUDED.composite,
               label = EXCLUDED.label,
               indicators_json = EXCLUDED.indicators_json`,
            [result.key, today, result.composite, result.label, JSON.stringify(result.indicators)],
        );
    } catch (err) {
        // 落库失败不影响返回（快照是辅助存储）
        console.error('[FearGreed] snapshot persist failed:', err instanceof Error ? err.message : String(err));
    }

    return result;
}

// 上证指数日线缓存：(dates 倒序, values 倒序) 与恐贪 history.dates 对齐
let shIndexCache: { dates: string[]; values: (number | null)[] } | null = null;

/** 按给定 YYYYMMDD 日期列表对齐返回上证指数（000001.SH）收盘点位（倒序） */
async function shIndexSeries(datesYyyymmdd: string[]): Promise<{ dates: string[]; values: (number | null)[] }> {
    if (!datesYyyymmdd.length) return { dates: [], values: [] };
    if (shIndexCache && shIndexCache.dates.length === datesYyyymmdd.length
        && shIndexCache.dates.every((d, i) => d === datesYyyymmdd[i])) {
        return shIndexCache;
    }

    const sorted = [...datesYyyymmdd].sort();
    const rows = await tushareRequest(
        'index_daily',
        { ts_code: '000001.SH', start_date: sorted[0], end_date: sorted[sorted.length - 1] },
        'trade_date,close',
    );
    const closeMap = new Map(rows.map((r) => [String(r.trade_date), Number(r.close)]));
    const values = datesYyyymmdd.map((d) => closeMap.get(d) ?? null);
    shIndexCache = { dates: [...datesYyyymmdd], values };
    return { dates: [...datesYyyymmdd], values };
}

function colorFor(score: number): string {
    if (score < 25) return '#FF3B30';
    if (score < 45) return '#FF9500';
    if (score < 55) return '#FFCC00';
    if (score < 80) return '#34C759';
    return '#00C853';
}

/** 组装首页主面板数据（对齐原 /api/fear-greed/dashboard） */
export async function buildDashboard(): Promise<Record<string, unknown>> {
    const result = await getLatestJq();
    const { history, indicators, composite } = result;
    const scores = history.scores; // 倒序：scores[0] 为最新

    // 饼图：恐惧侧 vs 贪婪侧
    const pie = [
        { name: '极度恐惧', value: Math.round((100 - composite) * 10) / 10, color: '#FF3B30' },
        { name: '极度贪婪', value: Math.round(composite * 10) / 10, color: '#18a058' },
    ];

    // 柱状图：历史对比（1日前 / 1周前 / 1月前 / 1年前）
    const bars: { label: string; value: number; color: string }[] = [];
    for (const [label, offset] of [['1日前', 1], ['1周前', 5], ['1月前', 20], ['1年前', -1]] as [string, number][]) {
        let v: number | undefined;
        if (offset === -1) {
            if (scores.length > 0) v = scores[scores.length - 1];
        } else if (offset < scores.length) {
            v = scores[offset];
        }
        if (v !== undefined) bars.push({ label, value: Math.round(v * 100) / 100, color: colorFor(v) });
    }

    // 折线图：近期走势（最近 20 日，倒序）
    const recent = scores.slice(0, 20);

    // 上证指数走势（与恐贪 history.dates 对齐，倒序）
    const stockIdx = await shIndexSeries(history.dates);

    return {
        updateTime: new Date().toISOString().slice(0, 10),
        indexName: result.name,
        currentIndex: composite,
        label: result.label,
        pieData: pie,
        barData: bars,
        lineData: {
            currentIndex: composite,
            neutralLine: 50,
            recentValues: recent,
            dates: history.dates.slice(0, 20),
        },
        updateProgress: {
            fearGreed: Math.round(composite),
            indexValue: composite,
        },
        indicators,
        history,
        stockIndex: { ...stockIdx, name: '上证指数', tsCode: '000001.SH' },
    };
}

/** 从数据库读取历史序列（供折线图） */
export async function getHistory(days = 60): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
        `SELECT trade_date, composite FROM fear_greed_snapshot
         WHERE index_key = 'jq' ORDER BY trade_date DESC LIMIT $1`,
        [days],
    );
    const ordered = (rows as { trade_date: Date; composite: string }[]).reverse();
    return {
        index_key: 'jq',
        dates: ordered.map((r) => new Date(r.trade_date).toISOString().slice(0, 10)),
        composite: ordered.map((r) => Number(r.composite)),
    };
}

/** 强制刷新（重算 + 落库 + 更新缓存） */
export async function refreshJq(): Promise<JqResult> {
    return getLatestJq(true);
}

/** Redis 快捷读取（供 cron 预热后快速访问；当前主缓存为内存，保留接口以兼容未来多实例） */
export async function getCachedFromRedis(): Promise<string | null> {
    try {
        return await redis.get('fear_greed:jq');
    } catch {
        return null;
    }
}
