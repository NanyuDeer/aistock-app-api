/**
 * 恐贪指数服务：编排计算 → PG 快照落库 → Redis 缓存 → 组装 dashboard。
 * 替代原 Python FastAPI 服务（services/calculator.py），接口契约保持一致。
 */
import pool from '../../core/db';
import redis from '../../core/redis';
import { tushareRequest } from '../quote/TushareService';
import { computeJq, type BreadthCache, type DailyLimit, type JqResult, type LimitCache } from './calculator';

const CACHE_TTL_SECONDS = 30 * 60; // 30 分钟（与 Python 版一致）

// 内存缓存：{ key: { ts, result } }
const memoryCache = new Map<string, { ts: number; result: JqResult }>();

/**
 * 数据源瞬时网络抖动重试。Tushare 接口偶发 TLS 断开/请求中止（沙箱网络不稳定），
 * 而一次 computeJq 需串行调用数十次外部接口，任一次失败都会让整次刷新失败。
 * 仅对网络类错误重试（业务拒绝如无权限不重试，避免无谓重复调用与日志噪音）。
 */
async function withNetRetry<T>(fn: () => Promise<T>, retries = 3): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < retries; i++) {
        try {
            return await fn();
        } catch (err) {
            lastErr = err;
            if (err instanceof Error && err.message.includes('业务错误')) throw err;
            await new Promise((r) => setTimeout(r, 1200 * (i + 1)));
        }
    }
    throw lastErr;
}

/** PG 不可用时的内存降级缓存 */
const memBreadth = new Map<string, number>();
const memLimit = new Map<string, DailyLimit>();

/** breadth 指标缓存：PG 表 breadth_daily（PG 不可用时降级为内存 Map） */
const breadthCache: BreadthCache = {
    async getAll(): Promise<Map<string, number>> {
        try {
            const { rows } = await pool.query('SELECT trade_date, up_ratio FROM breadth_daily');
            const map = new Map<string, number>();
            for (const r of rows as { trade_date: string; up_ratio: number }[]) {
                map.set(String(r.trade_date).replace(/-/g, ''), Number(r.up_ratio));
            }
            // 合并内存缓存（PG 缺失的日期用内存补齐）
            for (const [k, v] of memBreadth) if (!map.has(k)) map.set(k, v);
            return map;
        } catch {
            return new Map(memBreadth);
        }
    },
    async upsert(rows: { tradeDate: string; upRatio: number }[]): Promise<void> {
        for (const r of rows) memBreadth.set(r.tradeDate, r.upRatio);
        if (!rows.length) return;
        try {
            const values = rows
                .map((r) => `('${r.tradeDate.slice(0, 4)}-${r.tradeDate.slice(4, 6)}-${r.tradeDate.slice(6, 8)}', ${r.upRatio})`)
                .join(',');
            await pool.query(`
                INSERT INTO breadth_daily (trade_date, up_ratio) VALUES ${values}
                ON CONFLICT (trade_date) DO UPDATE SET up_ratio = EXCLUDED.up_ratio
            `);
        } catch { /* PG 不可用时仅写内存 */ }
    },
};

/** limit 指标缓存：PG 表 limit_daily（PG 不可用时降级为内存 Map） */
const limitCache: LimitCache = {
    async getAll(): Promise<Map<string, DailyLimit>> {
        try {
            const { rows } = await pool.query(
                `SELECT trade_date, seal_count, break_count, down_count, seal_codes FROM limit_daily`,
            );
            const map = new Map<string, DailyLimit>();
            for (const r of rows as { trade_date: string; seal_count: number; break_count: number; down_count: number; seal_codes: string | string[] }[]) {
                const date = String(r.trade_date).replace(/-/g, '');
                map.set(date, {
                    date,
                    sealCount: Number(r.seal_count),
                    breakCount: Number(r.break_count),
                    downCount: Number(r.down_count),
                    maxStreak: 0,
                    sealCodes: typeof r.seal_codes === 'string'
                        ? JSON.parse(r.seal_codes || '[]')
                        : (r.seal_codes ?? []),
                });
            }
            for (const [k, v] of memLimit) if (!map.has(k)) map.set(k, v);
            return map;
        } catch {
            return new Map(memLimit);
        }
    },
    async upsert(rows: DailyLimit[]): Promise<void> {
        for (const r of rows) memLimit.set(r.date, r);
        if (!rows.length) return;
        try {
            const values = rows
                .map((r) => {
                    const d = `${r.date.slice(0, 4)}-${r.date.slice(4, 6)}-${r.date.slice(6, 8)}`;
                    return `('${d}', ${r.sealCount}, ${r.breakCount}, ${r.downCount}, '${JSON.stringify(r.sealCodes)}')`;
                })
                .join(',');
            await pool.query(`
                INSERT INTO limit_daily (trade_date, seal_count, break_count, down_count, seal_codes)
                VALUES ${values}
                ON CONFLICT (trade_date) DO UPDATE SET
                  seal_count = EXCLUDED.seal_count,
                  break_count = EXCLUDED.break_count,
                  down_count = EXCLUDED.down_count,
                  seal_codes = EXCLUDED.seal_codes
            `);
        } catch { /* PG 不可用时仅写内存 */ }
    },
};

/** 建表（幂等，启动时调用；PG 不可用时安全跳过） */
export async function ensureFearGreedSchema(): Promise<void> {
    try {
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
        await pool.query(`
            CREATE TABLE IF NOT EXISTS limit_daily (
                trade_date DATE PRIMARY KEY,
                seal_count INT NOT NULL DEFAULT 0,
                break_count INT NOT NULL DEFAULT 0,
                down_count INT NOT NULL DEFAULT 0,
                seal_codes JSONB NOT NULL DEFAULT '[]'
            )
        `);
        // 迁移：添加 time_slot 列 + 改唯一约束（支持每日3次快照）
        await pool.query(`ALTER TABLE fear_greed_snapshot ADD COLUMN IF NOT EXISTS time_slot VARCHAR(10) DEFAULT 'post'`);
        await pool.query(`ALTER TABLE fear_greed_snapshot DROP CONSTRAINT IF EXISTS fear_greed_snapshot_index_key_trade_date_key`);
        await pool.query(`
            DO $$
            BEGIN
                ALTER TABLE fear_greed_snapshot ADD CONSTRAINT fear_greed_snapshot_idx_date_slot_key UNIQUE (index_key, trade_date, time_slot);
            EXCEPTION WHEN duplicate_object THEN
                NULL;
            END $$
        `);
    } catch (e) {
        console.warn('[FearGreed] PG schema init skipped (PG unavailable):', e instanceof Error ? e.message : String(e));
    }
}

/** 计算并返回最新结果（优先内存缓存；可选强制刷新） */
export async function getLatestJq(force = false, timeSlot = 'post'): Promise<JqResult> {
    const now = Date.now();
    if (!force) {
        const hit = memoryCache.get('jq');
        if (hit && now - hit.ts < CACHE_TTL_SECONDS * 1000) return hit.result;
    }

    // 注入带网络重试的 request：一次 computeJq 串行调用数十次外部接口，
    // 数据源瞬时抖动（TLS 断开等）不应让整次刷新失败
    const request = (apiName: string, params: Record<string, unknown>, fields?: string) =>
        withNetRetry(() => tushareRequest(apiName, params, fields));
    const result = await computeJq({ request }, breadthCache, limitCache);
    memoryCache.set('jq', { ts: now, result });

    // PG 快照落库（按 index_key + trade_date + time_slot 去重）
    try {
        const today = new Date().toISOString().slice(0, 10);
        await pool.query(
            `INSERT INTO fear_greed_snapshot (index_key, trade_date, composite, label, indicators_json, time_slot)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (index_key, trade_date, time_slot) DO UPDATE SET
               composite = EXCLUDED.composite,
               label = EXCLUDED.label,
               indicators_json = EXCLUDED.indicators_json`,
            [result.key, today, result.composite, result.label, JSON.stringify(result.indicators), timeSlot],
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
    if (score < 20) return '#00C853';
    if (score < 45) return '#FF9500';
    if (score < 55) return '#FFCC00';
    if (score < 80) return '#34C759';
    return '#FF3B30';
}

/** 组装首页主面板数据（对齐原 /api/fear-greed/dashboard） */
export async function buildDashboard(): Promise<Record<string, unknown>> {
    const result = await getLatestJq();
    const { history, indicators, composite } = result;
    const scores = history.scores; // 倒序：scores[0] 为最新

    // 饼图：恐惧侧 vs 贪婪侧
    const pie = [
        { name: '极度恐惧', value: Math.round((100 - composite) * 10) / 10, color: '#00C853' },
        { name: '极度贪婪', value: Math.round(composite * 10) / 10, color: '#FF3B30' },
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

    // 历史快照（DB，含 intraday 时段 pre/noon/post）：用于绘制短热度线（每日3点）
    // history（来自 calculator）仍提供日级 composite 序列，用于中热度线（20日MA）和均线数值
    const historySnapshots = await getHistory(60);

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
        historySnapshots,
        stockIndex: { ...stockIdx, name: '上证指数', tsCode: '000001.SH' },
    };
}

/**
 * 从数据库读取历史序列（供折线图）。
 * 返回：
 *   - dates/composite：每日 composite 均值（升序），用于中热度线（20日MA）和均线数值
 *   - snapshots：每日 3 次快照（pre/noon/post，升序），用于短热度线（intraday 粒度）
 *     某时段缺失时为 null，前端跳过 null 绘制断点
 */
export async function getHistory(days = 60): Promise<Record<string, unknown>> {
    const { rows } = await pool.query(
        `SELECT trade_date, composite, time_slot FROM fear_greed_snapshot
         WHERE index_key = 'jq' ORDER BY trade_date DESC LIMIT $1`,
        [days * 3], // 每日至多 3 条快照
    );

    // 按日期聚合：{ 'YYYY-MM-DD': { pre, noon, post, values: [] } }
    type SlotVals = { pre: number | null; noon: number | null; post: number | null; vals: number[] };
    const byDate = new Map<string, SlotVals>();
    for (const r of rows as { trade_date: Date; composite: string; time_slot: string }[]) {
        const iso = new Date(r.trade_date).toISOString().slice(0, 10);
        const slot = (r.time_slot || 'post') as 'pre' | 'noon' | 'post';
        if (!byDate.has(iso)) byDate.set(iso, { pre: null, noon: null, post: null, vals: [] });
        const entry = byDate.get(iso)!;
        entry[slot] = Number(r.composite);
        entry.vals.push(Number(r.composite));
    }

    // 升序输出
    const sortedDates = [...byDate.keys()].sort();
    const dailyAvg = sortedDates.map((d) => {
        const v = byDate.get(d)!.vals;
        return Math.round((v.reduce((s, x) => s + x, 0) / v.length) * 100) / 100;
    });
    const snapshots = sortedDates.map((d) => {
        const e = byDate.get(d)!;
        return { date: d, pre: e.pre, noon: e.noon, post: e.post };
    });

    return {
        index_key: 'jq',
        dates: sortedDates,
        composite: dailyAvg,
        snapshots,
    };
}

/** 强制刷新（重算 + 落库 + 更新缓存）；timeSlot 用于落库区分盘前/正午/盘后 */
export async function refreshJq(timeSlot: 'pre' | 'noon' | 'post' = 'post'): Promise<JqResult> {
    return getLatestJq(true, timeSlot);
}

/** Redis 快捷读取（供 cron 预热后快速访问；当前主缓存为内存，保留接口以兼容未来多实例） */
export async function getCachedFromRedis(): Promise<string | null> {
    try {
        return await redis.get('fear_greed:jq');
    } catch {
        return null;
    }
}
