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
 * - ON CONFLICT (article_id)：已存在则刷新正文/标题/关键词/提及标的/发布时间 + content_hash/parser_version，
 *   PRD §5.3 要求"来源轻微修改→更新来源记录"，保证 DB 正文与 content_hash 一致（否则 Python context 读旧正文
 *   却对上新 hash，导致证据错配）；
 * - RETURNING xmax = 0 为 PG 合法写法，行是新插入（未被更新）时返回 true（仅对 INSERT 新行成立，不受 DO UPDATE 影响）。
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
             ON CONFLICT (article_id) DO UPDATE SET
               content = EXCLUDED.content,
               title = EXCLUDED.title,
               keywords = EXCLUDED.keywords,
               mentioned_symbols = EXCLUDED.mentioned_symbols,
               published_at = EXCLUDED.published_at,
               content_hash = EXCLUDED.content_hash,
               parser_version = EXCLUDED.parser_version
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
