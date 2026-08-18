/**
 * 板块轮动榜持久化（网页同款口径）
 *
 * 数据源：同花顺板块指数日线 d.10jqka.com.cn/v6/line/bk_<code>/01/last.js
 * 口径：每日涨幅前10（up_rank）+ 每日跌幅前10（down_rank），与网页
 *       "近10日热门/板块轮动表"（apigate hotCirclePlate 的 mrpm）一致
 *       （已验证：用日线还原每日涨跌榜命中率 149/150 与 150/150）。
 *
 * 持久化到 board_rotation_daily 表后，支持任意天数（10/20/30/60/120）
 * 的板块上榜次数统计，无需每次全量重算。
 */

import pool from '../../core/db';
import { sessionFetch } from '../../shared/utils/httpAgent';
import { getThsIndex } from '../quote/TushareService';
import { CacheService } from '../../shared/utils/CacheService';

// ==================== 常量 ====================

/** 板块指数日线 JSONP 接口（返回近 140 个交易日） */
const KLINE_URL = (code: string) => `https://d.10jqka.com.cn/v6/line/bk_${code}/01/last.js`;
const KLINE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': 'https://q.10jqka.com.cn/',
};
/** 拉取日线并发数 */
const FETCH_CONCURRENCY = 12;
/** 板块池内存缓存 TTL（24 小时） */
const POOL_CACHE_TTL = 24 * 3600 * 1000;

// ==================== 类型 ====================

/** 每日轮动榜行（一个板块一天最多一行：要么涨幅榜、要么跌幅榜） */
export interface DailyRotationRow {
    trading_date: string;   // '2026-08-06'
    board_code: string;
    board_name: string;
    up_rank: number | null;   // 1~10，涨幅榜排名；null=未进涨幅榜
    down_rank: number | null; // 1~10，跌幅榜排名；null=未进跌幅榜
    pct_change: number;       // 当日涨跌幅（%）
}

/** 板块池成员 */
export interface BoardPoolItem {
    code: string;         // 6 位同花顺板块代码（881xxx 行业 / 885xxx 886xxx 概念）
    name: string;
    category: 'industry' | 'concept';
}

// ==================== 板块池 ====================

let poolCache: BoardPoolItem[] | null = null;
let poolCacheAt = 0;

/**
 * 获取板块池（网页同款口径）
 *
 * 主路径：hotCirclePlate 近 30 日上榜过的板块（约 106 个热门板块），
 *         与同花顺网页"板块轮动表"口径一致。
 * 兜底：Tushare ths_index 全量（概念 N + 行业 I），仅在 hotCirclePlate 失败时使用。
 *
 * 注意：Tushare 全量池（349 个）含大量细分板块（如"钨""种子生产""焦炭加工"），
 *       网页不跟踪这些细分板块，会导致每日涨跌前10 与网页不一致（实测仅 2/10 重合）。
 *       必须用 hotCirclePlate 子集才能对齐网页口径。
 */
export async function getBoardPool(): Promise<BoardPoolItem[]> {
    if (poolCache && Date.now() - poolCacheAt < POOL_CACHE_TTL) return poolCache;
    // 主路径：hotCirclePlate 网页同款板块池
    const hotItems = await fetchPoolFromHotCirclePlate();
    if (hotItems.length >= 50) {
        poolCache = hotItems;
        poolCacheAt = Date.now();
        console.log(`[RotationBoardStore] 板块池(hotCirclePlate): ${hotItems.length} 个（概念 ${hotItems.filter(i => i.category === 'concept').length} + 行业 ${hotItems.filter(i => i.category === 'industry').length}）`);
        return hotItems;
    }
    console.warn('[RotationBoardStore] hotCirclePlate 板块池不足，回退 Tushare 全量');
    // 兜底：Tushare ths_index 全量
    try {
        const [concepts, industries] = await Promise.all([
            getThsIndex('N', 'A'),
            getThsIndex('I', 'A'),
        ]);
        const items: BoardPoolItem[] = [];
        const seen = new Set<string>();
        for (const row of concepts) {
            const code = row.ts_code.match(/^\d{6}/)?.[0];
            if (!code || seen.has(code)) continue;
            seen.add(code);
            items.push({ code, name: row.name, category: 'concept' });
        }
        for (const row of industries) {
            const code = row.ts_code.match(/^\d{6}/)?.[0];
            if (!code || seen.has(code)) continue;
            seen.add(code);
            items.push({ code, name: row.name, category: 'industry' });
        }
        if (items.length >= 100) {
            poolCache = items;
            poolCacheAt = Date.now();
            console.log(`[RotationBoardStore] 板块池(Tushare兜底): ${items.length} 个`);
            return items;
        }
    } catch (err) {
        console.warn('[RotationBoardStore] getBoardPool(Tushare) 失败:', (err as Error).message);
    }
    return [];
}

/** 网页同款板块池：从 hotCirclePlate 近 30 日 mrpm 收集上榜板块（与同花顺网页"板块轮动表"口径一致） */
async function fetchPoolFromHotCirclePlate(): Promise<BoardPoolItem[]> {
    try {
        const url = 'https://apigate.10jqka.com.cn/d/charge/smallcharge/l2/v2/hotCirclePlate?days=30&filter=';
        const resp = await sessionFetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0',
                'Referer': 'http://l2.10jqka.com.cn/hottrack/public/dist/index.html',
            },
        });
        if (!resp.ok) return [];
        const json = await resp.json() as { result?: { mrpm?: { up?: { stocks: { stockcode: string; stockname: string }[] }[]; down?: { stocks: { stockcode: string; stockname: string }[] }[] } } };
        const mrpm = json.result?.mrpm;
        if (!mrpm) return [];
        const items: BoardPoolItem[] = [];
        const seen = new Set<string>();
        const add = (code: string, name: string) => {
            if (!code || seen.has(code)) return;
            seen.add(code);
            const category = code.startsWith('881') ? 'industry' : 'concept';
            items.push({ code, name, category });
        };
        for (const day of mrpm.up ?? []) for (const s of day.stocks) add(s.stockcode, s.stockname);
        for (const day of mrpm.down ?? []) for (const s of day.stocks) add(s.stockcode, s.stockname);
        console.log(`[RotationBoardStore] 板块池（hotCirclePlate 兜底）: ${items.length} 个`);
        return items;
    } catch (err) {
        console.warn('[RotationBoardStore] hotCirclePlate 兜底池失败:', (err as Error).message);
        return [];
    }
}

// ==================== 日线拉取与榜单计算 ====================

/** 并发受限执行 */
async function fetchWithConcurrency<T>(items: T[], concurrency: number, worker: (item: T) => Promise<void>): Promise<void> {
    let idx = 0;
    const tasks: Promise<void>[] = [];
    for (let i = 0; i < Math.min(concurrency, items.length); i++) {
        tasks.push((async () => {
            while (idx < items.length) {
                const cur = idx++;
                await worker(items[cur]);
            }
        })());
    }
    await Promise.all(tasks);
}

/** 解析 last.js JSONP → { date: close }（日期 YYYYMMDD） */
export function parseKline(jsonpText: string): Map<string, number> {
    const byDate = new Map<string, number>();
    const start = jsonpText.indexOf('(');
    const end = jsonpText.lastIndexOf(')');
    if (start < 0 || end <= start) return byDate;
    let body: string;
    try {
        body = jsonpText.slice(start + 1, end);
    } catch {
        return byDate;
    }
    let parsed: { data?: string };
    try {
        parsed = JSON.parse(body) as { data?: string };
    } catch {
        return byDate;
    }
    if (!parsed.data) return byDate;
    for (const row of parsed.data.split(';')) {
        if (!row) continue;
        const p = row.split(',');
        const close = parseFloat(p[4]);
        if (p[0] && Number.isFinite(close)) byDate.set(p[0], close);
    }
    return byDate;
}

/** 板块日 K 线单点（OHLC） */
export interface BoardKlinePoint {
    open: number;
    high: number;
    low: number;
    close: number;
}

/**
 * 解析 last.js JSONP → { date: { open, high, low, close } }
 * 行格式：date,open,high,low,close,volume,amount,...（close 已验证位于 p[4]）
 * 防御：若 high < low 则交换，兼容列序差异，不改变有效数据。
 */
export function parseKlineFull(jsonpText: string): Map<string, BoardKlinePoint> {
    const byDate = new Map<string, BoardKlinePoint>();
    const start = jsonpText.indexOf('(');
    const end = jsonpText.lastIndexOf(')');
    if (start < 0 || end <= start) return byDate;
    let body: string;
    try {
        body = jsonpText.slice(start + 1, end);
    } catch {
        return byDate;
    }
    let parsed: { data?: string };
    try {
        parsed = JSON.parse(body) as { data?: string };
    } catch {
        return byDate;
    }
    if (!parsed.data) return byDate;
    for (const row of parsed.data.split(';')) {
        if (!row) continue;
        const p = row.split(',');
        const open = parseFloat(p[1]);
        let high = parseFloat(p[2]);
        let low = parseFloat(p[3]);
        const close = parseFloat(p[4]);
        if (!p[0] || ![open, high, low, close].every(Number.isFinite)) continue;
        if (high < low) [high, low] = [low, high];
        byDate.set(p[0], { open, high, low, close });
    }
    return byDate;
}

/** 计算全部可交易日期的每日涨跌榜（含 pct_change），供回填/增量入库 */
export function computeDailyBoards(klines: Map<string, Map<string, number>>, poolItems: BoardPoolItem[]): DailyRotationRow[] {
    // 每个板块: date -> 当日涨跌幅(%)
    const pctMap = new Map<string, Map<string, number>>();
    for (const [code, byDate] of klines) {
        const sorted = [...byDate.keys()].sort();
        const m = new Map<string, number>();
        for (let i = 1; i < sorted.length; i++) {
            const prev = byDate.get(sorted[i - 1])!;
            const cur = byDate.get(sorted[i])!;
            if (prev > 0) m.set(sorted[i], (cur - prev) / prev * 100);
        }
        pctMap.set(code, m);
    }

    // 全部交易日（跨板块并集，升序）
    const allDates = new Set<string>();
    for (const byDate of pctMap.values()) for (const d of byDate.keys()) allDates.add(d);
    const dates = [...allDates].sort();

    const round2 = (n: number) => Math.round(n * 100) / 100;
    const rows: DailyRotationRow[] = [];
    for (const date of dates) {
        const entries: { code: string; name: string; pct: number }[] = [];
        for (const item of poolItems) {
            const pct = pctMap.get(item.code)?.get(date);
            if (pct === undefined || !Number.isFinite(pct)) continue;
            entries.push({ code: item.code, name: item.name, pct });
        }
        if (entries.length < 20) continue; // 数据不足（如首批板块未上市）跳过
        entries.sort((a, b) => b.pct - a.pct);
        const up = entries.slice(0, 10);
        const down = entries.slice(-10);
        up.forEach((e, i) => rows.push({
            trading_date: date,
            board_code: e.code,
            board_name: e.name,
            up_rank: i + 1,
            down_rank: null,
            pct_change: round2(e.pct),
        }));
        down.forEach((e, i) => rows.push({
            trading_date: date,
            board_code: e.code,
            board_name: e.name,
            up_rank: null,
            down_rank: i + 1,
            pct_change: round2(e.pct),
        }));
    }
    return rows;
}

/** 批量 upsert（ON CONFLICT 更新，幂等） */
async function upsertRows(rows: DailyRotationRow[]): Promise<void> {
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
        const chunk = rows.slice(i, i + CHUNK);
        const values: unknown[] = [];
        const placeholders: string[] = [];
        chunk.forEach((r, idx) => {
            const base = idx * 6;
            placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`);
            values.push(r.trading_date, r.board_code, r.board_name, r.up_rank, r.down_rank, r.pct_change);
        });
        await pool.query(
            `INSERT INTO board_rotation_daily (trading_date, board_code, board_name, up_rank, down_rank, pct_change)
             VALUES ${placeholders.join(',')}
             ON CONFLICT (trading_date, board_code) DO UPDATE SET
               board_name = EXCLUDED.board_name,
               up_rank = EXCLUDED.up_rank,
               down_rank = EXCLUDED.down_rank,
               pct_change = EXCLUDED.pct_change`,
            values,
        );
    }
}

// ==================== 建表 ====================

/** 启动时建表（幂等） */
export async function ensureRotationSchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS board_rotation_daily (
            trading_date DATE NOT NULL,
            board_code VARCHAR(16) NOT NULL,
            board_name VARCHAR(64) NOT NULL,
            up_rank SMALLINT,
            down_rank SMALLINT,
            pct_change NUMERIC(10, 4),
            PRIMARY KEY (trading_date, board_code)
        );
        CREATE INDEX IF NOT EXISTS idx_board_rotation_date ON board_rotation_daily (trading_date);
    `);
}

// ==================== 同步（回填 + 每日增量） ====================

/**
 * 同步轮动榜：拉板块池全部日线 → 计算每日涨跌榜 → upsert。
 * 首次部署即回填近 140 个交易日；此后每日调用只新增最新交易日，幂等。
 * @returns 写入行数
 */
export async function syncRotationHistory(): Promise<number> {
    const poolItems = await getBoardPool();
    if (poolItems.length === 0) {
        console.warn('[RotationBoardStore] 板块池为空，跳过同步');
        return 0;
    }
    const klines = new Map<string, Map<string, number>>();
    let fetched = 0;
    await fetchWithConcurrency(poolItems, FETCH_CONCURRENCY, async (item) => {
        try {
            const resp = await sessionFetch(KLINE_URL(item.code), { headers: KLINE_HEADERS });
            if (!resp.ok) return;
            const text = await resp.text();
            const parsed = parseKline(text);
            if (parsed.size > 0) {
                klines.set(item.code, parsed);
                fetched++;
            }
        } catch {
            // 单板块失败忽略
        }
    });
    console.log(`[RotationBoardStore] 日线拉取完成: ${fetched}/${poolItems.length} 个板块`);

    const rows = computeDailyBoards(klines, poolItems);
    if (rows.length === 0) {
        console.warn('[RotationBoardStore] 未计算出有效榜单');
        return 0;
    }
    await upsertRows(rows);
    const dayCount = new Set(rows.map(r => r.trading_date)).size;
    console.log(`[RotationBoardStore] 同步完成: ${rows.length} 条 / ${dayCount} 个交易日`);
    return rows.length;
}

// ==================== 查询 ====================

/**
 * 查询最近 N 个交易日的轮动榜（按交易日降序，榜内按排名升序）
 */
export async function queryRotationDaily(days: number): Promise<DailyRotationRow[]> {
    const { rows } = await pool.query(
        `SELECT to_char(trading_date, 'YYYY-MM-DD') AS trading_date,
                board_code, board_name, up_rank, down_rank, pct_change
         FROM board_rotation_daily
         WHERE trading_date IN (
             SELECT DISTINCT trading_date FROM board_rotation_daily
             ORDER BY trading_date DESC LIMIT $1
         )
         ORDER BY trading_date DESC, COALESCE(up_rank, down_rank) ASC`,
        [days],
    );
    return rows.map((r) => ({
        trading_date: r.trading_date as string,
        board_code: r.board_code as string,
        board_name: r.board_name as string,
        up_rank: r.up_rank as number | null,
        down_rank: r.down_rank as number | null,
        pct_change: Number(r.pct_change),
    }));
}

// ==================== 板块日 K 线（详情页按需） ====================

/** 板块 K 线缓存 TTL（1 小时，Redis+Map 双写降级） */
const BOARD_KLINE_CACHE_TTL = 3600;

/** 板块日 K 线返回结构（对齐前端 TrendKLineData：ohlc 每行 = [open, close, low, high]） */
export interface BoardKlineData {
    dates: string[];
    ohlc: [number, number, number, number][];
}

/**
 * 按需拉取单板块日 K 线（复用同花顺 bk_ 板块指数日线源）
 * @param code 6 位同花顺板块代码（如 881121 / 885551）
 * @param days 返回最近 N 个交易日，默认 120，上限 120
 * @returns null 表示抓取/解析失败（前端展示空态）
 */
export async function fetchBoardKline(code: string, days = 120): Promise<BoardKlineData | null> {
    const cacheKey = `wind:board-kline:${code}`;
    try {
        const cached = await CacheService.get<string>(cacheKey);
        if (cached) return JSON.parse(cached) as BoardKlineData;
    } catch {
        // 缓存解析失败忽略，回源抓取
    }
    try {
        const resp = await sessionFetch(KLINE_URL(code), { headers: KLINE_HEADERS });
        if (!resp.ok) return null;
        const text = await resp.text();
        const byDate = parseKlineFull(text);
        const sorted = [...byDate.keys()].sort().slice(-Math.min(days, 120));
        if (sorted.length === 0) return null;
        const data: BoardKlineData = {
            dates: sorted.map((d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`),
            ohlc: sorted.map((d) => {
                const p = byDate.get(d)!;
                return [p.open, p.close, p.low, p.high];
            }),
        };
        await CacheService.put(cacheKey, JSON.stringify(data), BOARD_KLINE_CACHE_TTL);
        return data;
    } catch (err) {
        console.warn(`[RotationBoardStore] fetchBoardKline(${code}) 失败:`, (err as Error).message);
        return null;
    }
}
