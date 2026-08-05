// src/modules/insight/InsightSourceService.ts
// 来源文章持久化 + 采集高水位
import { createHash } from 'crypto';
import pool from '../../core/db';
import redis from '../../core/redis';
import type { MentionedSymbol } from './types';

const HIGHWATER_KEY = 'watchlist_insight:highwater';
const PARSER_VERSION = 'mrnxgg-v1';

export interface SourceArticle {
    articleId: string;
    detailUrl: string;
    title: string;
    keywords: string[];
    content: string;
    mentionedSymbols: MentionedSymbol[];
    publishedAt: string;   // "2026-08-05 11:26:03"
    tradeDate: string;     // YYYY-MM-DD
}

/**
 * 逐条 upsert 来源文章。
 * - 列清单与 016 迁移 watchlist_insight_sources 逐字一致；
 * - ON CONFLICT (article_id)：已存在仅刷新 content_hash（版本化）；
 * - RETURNING xmax = 0 为 PG 合法写法，行是新插入（未被更新）时返回 true。
 * @returns 本次新插入的行数
 */
export async function upsertSources(articles: SourceArticle[]): Promise<number> {
    let inserted = 0;
    for (const a of articles) {
        const hash = createHash('sha256').update(a.content).digest('hex');
        const res = await pool.query(
            `INSERT INTO watchlist_insight_sources
               (source_id, source_url, article_id, trade_date, title, keywords, content, mentioned_symbols, published_at, content_hash, parser_version)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             ON CONFLICT (article_id) DO UPDATE SET content_hash = EXCLUDED.content_hash
             RETURNING xmax = 0 AS was_inserted`,
            [a.articleId, a.detailUrl, a.articleId, a.tradeDate, a.title, JSON.stringify(a.keywords),
             a.content, JSON.stringify(a.mentionedSymbols), a.publishedAt, hash, PARSER_VERSION],
        );
        if (res.rows[0]?.was_inserted) inserted++;
    }
    return inserted;
}

/** 记录采集高水位（YYYY-MM-DD），供下次增量回溯使用 */
export async function setHighWatermark(date: string): Promise<void> {
    await redis.set(HIGHWATER_KEY, date);
}

/** 读取采集高水位，未设置过返回 null */
export async function getHighWatermark(): Promise<string | null> {
    return redis.get(HIGHWATER_KEY);
}
