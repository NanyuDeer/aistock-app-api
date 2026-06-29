import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import pool from '../db';
import { getStockIdentity } from '../utils/stock';

export type StockInfoTargetSource = 'all' | 'favorites' | 'leaders';
export type StockInfoType = 'news' | 'announcement';
export type StockInfoImpact = '重大利好' | '利好' | '中性' | '利空' | '重大利空';
export type StockInfoHorizon = '短期' | '中期' | '长期' | '中长期';

const DATA_FILE = path.resolve(__dirname, '../../data/hot-sectors.json');
const VALID_INFO_TYPES = new Set<StockInfoType>(['news', 'announcement']);
const VALID_IMPACTS = new Set<StockInfoImpact>(['重大利好', '利好', '中性', '利空', '重大利空']);
const VALID_HORIZONS = new Set<StockInfoHorizon>(['短期', '中期', '长期', '中长期']);
const MAJOR_IMPACTS = new Set<StockInfoImpact>(['重大利好', '重大利空']);

export interface FavoriteTargetRow {
    symbol: string;
    stock_name?: string | null;
    market?: string | null;
    favorite_user_count: number;
}

export interface StockInfoTarget {
    symbol: string;
    stock_name: string;
    market: string;
    target_sources: Array<'favorite' | 'leader'>;
    favorite_user_count: number;
    leader_reason: string;
}

export interface StockInfoJudgementInput {
    symbol: string;
    stock_name?: string;
    info_type: StockInfoType;
    source: string;
    source_id?: string | null;
    title: string;
    url: string;
    published_at: string;
    ai_impact: StockInfoImpact;
    ai_horizon: StockInfoHorizon;
    ai_keywords?: unknown[];
    ai_summary: string;
}

export interface NormalizedStockInfoJudgementInput extends Omit<StockInfoJudgementInput, 'source_id' | 'ai_keywords'> {
    stock_name: string;
    source_id: string | null;
    ai_keywords: string[];
    dedupe_key: string;
}

export interface StockInfoJudgementRow {
    id: number;
    symbol: string;
    stock_name: string | null;
    info_type: StockInfoType;
    source?: string;
    source_id?: string | null;
    title: string;
    url: string;
    published_at: Date;
    ai_impact: StockInfoImpact;
    ai_horizon: StockInfoHorizon;
    ai_keywords: string[];
    ai_summary: string;
    created_at: Date;
}

export interface StockInfoQueryParams {
    symbol?: string;
    info_type?: StockInfoType;
    impact?: StockInfoImpact;
    limit?: number;
    offset?: number;
}

export interface StockInfoPushWindow {
    info_type: StockInfoType;
    from: Date;
    to: Date;
}

export interface StockInfoExistingInput {
    source?: unknown;
    info_type?: unknown;
    source_id?: unknown;
}

export interface StockInfoExistingKey {
    key: string;
    source: string;
    info_type: StockInfoType;
    source_id: string;
}

function cleanText(value: unknown): string {
    return String(value ?? '').trim().replace(/\s+/g, ' ');
}

function normalizeSymbol(raw: unknown): string {
    const text = cleanText(raw).toUpperCase();
    const match = text.match(/\d{6}/);
    return match ? match[0] : '';
}

function normalizeMarket(rawMarket: unknown, symbol: string): string {
    const raw = cleanText(rawMarket).toUpperCase();
    if (raw === 'SH' || raw === 'SZ' || raw === 'BJ') return raw;
    return getStockIdentity(symbol).market.toUpperCase();
}

function addTarget(targets: Map<string, StockInfoTarget>, item: {
    symbol: unknown;
    stock_name?: unknown;
    market?: unknown;
    target_source: 'favorite' | 'leader';
    favorite_user_count?: number;
    leader_reason?: unknown;
}): void {
    const symbol = normalizeSymbol(item.symbol);
    if (!/^\d{6}$/.test(symbol)) return;

    const existing = targets.get(symbol);
    const stockName = cleanText(item.stock_name);
    const market = normalizeMarket(item.market, symbol);
    if (!existing) {
        targets.set(symbol, {
            symbol,
            stock_name: stockName,
            market,
            target_sources: [item.target_source],
            favorite_user_count: item.favorite_user_count || 0,
            leader_reason: cleanText(item.leader_reason),
        });
        return;
    }

    if (!existing.target_sources.includes(item.target_source)) existing.target_sources.push(item.target_source);
    if (!existing.stock_name && stockName) existing.stock_name = stockName;
    if (!existing.market || existing.market === 'UNKNOWN') existing.market = market;
    if (item.favorite_user_count) existing.favorite_user_count = item.favorite_user_count;
    if (!existing.leader_reason && item.leader_reason) existing.leader_reason = cleanText(item.leader_reason);
}

function extractLeaderStocks(hotSectors: any[]): Array<{ code: unknown; name?: unknown; reason?: unknown }> {
    const leaders: Array<{ code: unknown; name?: unknown; reason?: unknown }> = [];
    for (const sector of hotSectors || []) {
        const leading = sector?.leading_stock_info;
        if (leading?.code) leaders.push({ code: leading.code, name: leading.name, reason: leading.reason || '趋势龙头股' });

        for (const stock of sector?.main_stocks || []) {
            if (stock?.code) leaders.push({ code: stock.code, name: stock.name, reason: stock.reason || '趋势龙头股' });
        }
    }
    return leaders;
}

export function buildStockInfoTargets(params: {
    favorites: FavoriteTargetRow[];
    hotSectors: any[];
    source: StockInfoTargetSource;
    limit: number;
}): StockInfoTarget[] {
    const targets = new Map<string, StockInfoTarget>();

    if (params.source === 'all' || params.source === 'favorites') {
        for (const favorite of params.favorites) {
            addTarget(targets, {
                symbol: favorite.symbol,
                stock_name: favorite.stock_name,
                market: favorite.market,
                target_source: 'favorite',
                favorite_user_count: Number(favorite.favorite_user_count || 0),
            });
        }
    }

    if (params.source === 'all' || params.source === 'leaders') {
        for (const leader of extractLeaderStocks(params.hotSectors)) {
            addTarget(targets, {
                symbol: leader.code,
                stock_name: leader.name,
                target_source: 'leader',
                leader_reason: leader.reason || '趋势龙头股',
            });
        }
    }

    return Array.from(targets.values()).slice(0, params.limit);
}

function normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    const result: string[] = [];
    const seen = new Set<string>();
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const text = cleanText(item);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        result.push(text);
        if (result.length >= 8) break;
    }
    return result;
}

function buildDedupeKey(item: {
    symbol: string;
    info_type: string;
    source: string;
    source_id: string | null;
    title: string;
    url: string;
}): string {
    const rawKey = item.source_id
        ? `${item.source}|${item.info_type}|${item.source_id}`
        : `${item.symbol}|${item.info_type}|${item.title}|${item.url}`;
    return crypto.createHash('sha1').update(rawKey).digest('hex');
}

export function buildStockInfoExistingKeys(rawItems: StockInfoExistingInput[]): StockInfoExistingKey[] {
    const keys: StockInfoExistingKey[] = [];
    const seen = new Set<string>();
    for (const raw of rawItems) {
        const source = cleanText(raw.source);
        const infoType = cleanText(raw.info_type) as StockInfoType;
        const sourceId = cleanText(raw.source_id);
        if (!source || !sourceId || !VALID_INFO_TYPES.has(infoType)) continue;

        const key = `${source}|${infoType}|${sourceId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        keys.push({ key, source, info_type: infoType, source_id: sourceId });
    }
    return keys;
}

export function normalizeStockInfoJudgementInput(raw: Record<string, any>): NormalizedStockInfoJudgementInput {
    const symbol = normalizeSymbol(raw.symbol);
    if (!/^\d{6}$/.test(symbol)) throw new Error('symbol must be a 6-digit A-share code');

    const infoType = cleanText(raw.info_type) as StockInfoType;
    if (!VALID_INFO_TYPES.has(infoType)) throw new Error('info_type must be news or announcement');

    const source = cleanText(raw.source);
    if (!source) throw new Error('source is required');

    const title = cleanText(raw.title);
    if (!title) throw new Error('title is required');

    const url = cleanText(raw.url);
    if (!/^https?:\/\//i.test(url)) throw new Error('url must be http(s)');

    const publishedAtRaw = cleanText(raw.published_at);
    const publishedAt = new Date(publishedAtRaw);
    if (!publishedAtRaw || Number.isNaN(publishedAt.getTime())) throw new Error('published_at must be a valid datetime');

    const aiImpact = cleanText(raw.ai_impact) as StockInfoImpact;
    if (!VALID_IMPACTS.has(aiImpact)) throw new Error('ai_impact is invalid');

    const aiHorizon = cleanText(raw.ai_horizon) as StockInfoHorizon;
    if (!VALID_HORIZONS.has(aiHorizon)) throw new Error('ai_horizon is invalid');

    const aiSummary = cleanText(raw.ai_summary);
    if (!aiSummary) throw new Error('ai_summary is required');

    const sourceId = cleanText(raw.source_id) || null;
    const normalized = {
        symbol,
        stock_name: cleanText(raw.stock_name),
        info_type: infoType,
        source,
        source_id: sourceId,
        title,
        url,
        published_at: publishedAt.toISOString(),
        ai_impact: aiImpact,
        ai_horizon: aiHorizon,
        ai_keywords: normalizeStringArray(raw.ai_keywords),
        ai_summary: aiSummary,
    };

    return {
        ...normalized,
        dedupe_key: buildDedupeKey(normalized),
    };
}

export function shouldPushStockInfoJudgement(row: StockInfoJudgementRow, window: StockInfoPushWindow): boolean {
    const publishedAt = new Date(row.published_at);
    return row.info_type === window.info_type
        && MAJOR_IMPACTS.has(row.ai_impact)
        && publishedAt >= window.from
        && publishedAt <= window.to;
}

function parseJsonFile(filePath: string): any {
    try {
        if (!fs.existsSync(filePath)) return null;
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (err) {
        console.error('[StockInfoService] read hot sectors failed:', err);
        return null;
    }
}

export class StockInfoService {
    private static schemaReady = false;

    static normalizeSource(value: unknown): StockInfoTargetSource {
        const source = cleanText(value).toLowerCase();
        if (source === 'favorites' || source === 'leaders') return source;
        return 'all';
    }

    static normalizeLimit(value: unknown, fallback = 200, max = 1000): number {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
        return Math.min(parsed, max);
    }

    static normalizeOffset(value: unknown): number {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed < 0) return 0;
        return parsed;
    }

    static async ensureSchema(): Promise<void> {
        if (this.schemaReady) return;
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_info_judgements (
                id BIGSERIAL PRIMARY KEY,
                dedupe_key TEXT UNIQUE,
                symbol TEXT NOT NULL,
                stock_name TEXT,
                info_type TEXT NOT NULL,
                source TEXT NOT NULL,
                source_id TEXT,
                title TEXT NOT NULL,
                url TEXT NOT NULL,
                published_at TIMESTAMPTZ NOT NULL,
                ai_impact TEXT NOT NULL,
                ai_horizon TEXT NOT NULL,
                ai_keywords JSONB NOT NULL DEFAULT '[]',
                ai_summary TEXT NOT NULL,
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_info_judgements_symbol_time ON stock_info_judgements(symbol, published_at DESC)');
        await pool.query('CREATE INDEX IF NOT EXISTS idx_stock_info_judgements_type_impact_time ON stock_info_judgements(info_type, ai_impact, published_at DESC)');
        this.schemaReady = true;
    }

    static async getTargets(source: StockInfoTargetSource, limit: number): Promise<StockInfoTarget[]> {
        const favoritesResult = await pool.query(
            `SELECT us.symbol, MAX(s.name) AS stock_name, MAX(s.market) AS market, COUNT(DISTINCT us.openid)::int AS favorite_user_count
             FROM user_stocks us
             LEFT JOIN stocks s ON s.symbol = us.symbol
             WHERE EXISTS (
                 SELECT 1 FROM user_settings ust
                 WHERE ust.openid = us.openid
                   AND ust.setting_type = 'stock_push'
                   AND COALESCE(ust.enabled, 1) != 0
             )
             GROUP BY us.symbol
             ORDER BY favorite_user_count DESC, us.symbol ASC`,
        );
        const hotData = parseJsonFile(DATA_FILE);
        return buildStockInfoTargets({
            favorites: favoritesResult.rows as FavoriteTargetRow[],
            hotSectors: Array.isArray(hotData?.hot_sectors) ? hotData.hot_sectors : [],
            source,
            limit,
        });
    }

    static async upsertJudgements(rawItems: Record<string, any>[]): Promise<{
        summary: { total: number; inserted: number; updated: number; failed: number };
        results: any[];
    }> {
        await this.ensureSchema();
        const summary = { total: rawItems.length, inserted: 0, updated: 0, failed: 0 };
        const results: any[] = [];

        for (const raw of rawItems) {
            try {
                const item = normalizeStockInfoJudgementInput(raw);
                const result = await pool.query(
                    `INSERT INTO stock_info_judgements (
                        dedupe_key, symbol, stock_name, info_type, source, source_id,
                        title, url, published_at, ai_impact, ai_horizon, ai_keywords, ai_summary
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz, $10, $11, $12::jsonb, $13)
                    ON CONFLICT(dedupe_key) DO UPDATE SET
                        stock_name = EXCLUDED.stock_name,
                        title = EXCLUDED.title,
                        url = EXCLUDED.url,
                        published_at = EXCLUDED.published_at,
                        ai_impact = EXCLUDED.ai_impact,
                        ai_horizon = EXCLUDED.ai_horizon,
                        ai_keywords = EXCLUDED.ai_keywords,
                        ai_summary = EXCLUDED.ai_summary,
                        updated_at = CURRENT_TIMESTAMP
                    RETURNING id, (xmax = 0) AS inserted`,
                    [
                        item.dedupe_key,
                        item.symbol,
                        item.stock_name || null,
                        item.info_type,
                        item.source,
                        item.source_id,
                        item.title,
                        item.url,
                        item.published_at,
                        item.ai_impact,
                        item.ai_horizon,
                        JSON.stringify(item.ai_keywords),
                        item.ai_summary,
                    ],
                );
                const inserted = Boolean(result.rows[0]?.inserted);
                if (inserted) summary.inserted += 1;
                else summary.updated += 1;
                results.push({ status: inserted ? 'inserted' : 'updated', id: result.rows[0]?.id, symbol: item.symbol });
            } catch (err: any) {
                summary.failed += 1;
                results.push({ status: 'failed', error: err instanceof Error ? err.message : String(err), raw });
            }
        }

        return { summary, results };
    }

    static async getExistingJudgements(rawItems: StockInfoExistingInput[]): Promise<StockInfoExistingKey[]> {
        await this.ensureSchema();
        const keys = buildStockInfoExistingKeys(rawItems);
        if (keys.length === 0) return [];

        const result = await pool.query(
            `SELECT source, info_type, source_id
             FROM stock_info_judgements
             WHERE source_id IS NOT NULL
               AND dedupe_key = ANY($1::text[])`,
            [keys.map(item => crypto.createHash('sha1').update(item.key).digest('hex'))],
        );
        const existing = new Set(
            result.rows.map((row: any) => `${cleanText(row.source)}|${cleanText(row.info_type)}|${cleanText(row.source_id)}`),
        );
        return keys.filter(item => existing.has(item.key));
    }

    static async queryJudgements(params: StockInfoQueryParams): Promise<{ total: number; items: StockInfoJudgementRow[] }> {
        await this.ensureSchema();
        const conditions: string[] = [];
        const values: any[] = [];

        if (params.symbol) {
            const symbol = normalizeSymbol(params.symbol);
            if (symbol) {
                values.push(symbol);
                conditions.push(`symbol = $${values.length}`);
            }
        }
        if (params.info_type && VALID_INFO_TYPES.has(params.info_type)) {
            values.push(params.info_type);
            conditions.push(`info_type = $${values.length}`);
        }
        if (params.impact && VALID_IMPACTS.has(params.impact)) {
            values.push(params.impact);
            conditions.push(`ai_impact = $${values.length}`);
        }

        const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
        const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM stock_info_judgements ${whereClause}`, values);

        const limit = params.limit || 20;
        const offset = params.offset || 0;
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

        return {
            total: Number(countResult.rows[0]?.total || 0),
            items: result.rows.map((row: any) => ({
                ...row,
                ai_keywords: Array.isArray(row.ai_keywords) ? row.ai_keywords : [],
            })),
        };
    }

    static async getPushCandidates(window: StockInfoPushWindow): Promise<StockInfoJudgementRow[]> {
        await this.ensureSchema();
        const result = await pool.query(
            `SELECT id, symbol, stock_name, info_type, source, source_id, title, url, published_at,
                    ai_impact, ai_horizon, ai_keywords, ai_summary, created_at
             FROM stock_info_judgements
             WHERE info_type = $1
               AND ai_impact IN ('重大利好', '重大利空')
               AND published_at >= $2::timestamptz
               AND published_at <= $3::timestamptz
             ORDER BY published_at DESC, id DESC`,
            [window.info_type, window.from.toISOString(), window.to.toISOString()],
        );
        return result.rows
            .map((row: any) => ({ ...row, ai_keywords: Array.isArray(row.ai_keywords) ? row.ai_keywords : [] }))
            .filter((row: StockInfoJudgementRow) => shouldPushStockInfoJudgement(row, window));
    }
}
