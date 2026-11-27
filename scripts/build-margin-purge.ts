/**
 * S8：融资盘出清（逐日事实 + 回合状态 + 证据）
 *
 * 设计：docs/superpowers/specs/2026-11-27-margin-purge-graph-design.md
 *
 * 只做三件事：
 *   1. 把 margin_daily 的两融余额整理成逐日序列（SSE+SZSE，与 state_daily 同列同口径）
 *   2. 跑状态机，全量重写 margin_purge_daily
 *   3. 给最新一个数据日写一条 evidence（若在回合内且数据已可见）
 *
 * 【为什么不回溯补写历史 evidence】
 *   历史回合的事实在表里可查。账本记的是「当时能看到的证据」，补写等于伪造披露时间。
 *
 * 【为什么缺一家交易所的日子直接丢弃】
 *   SSE 或 SZSE 缺一天，sum 会把余额算低，回撤瞬间变深，凭空造出一次「出清」。
 *   宁可少一天，也不要一个假信号。
 *
 * 用法：
 *   node --import tsx scripts/build-margin-purge.ts
 *   node --import tsx scripts/build-margin-purge.ts --quiet
 */

import pool from '../src/core/db';
import {
    buildPurgeSeries,
    PURGE_DEFAULTS,
    type PurgeRow,
} from '../src/modules/insight/marginPurge';
import { forwardReturn } from '../src/modules/insight/claimVerification';

const SPEC_VERSION = 'v1';
const EXCHANGES = ['SSE', 'SZSE'];

const hasFlag = (n: string): boolean => process.argv.includes(`--${n}`);

// ---------------------------------------------------------------------------
// 读
// ---------------------------------------------------------------------------

interface DayBalance {
    date: string;
    balance: number;
    legs: number;
}

async function loadBalances(): Promise<DayBalance[]> {
    const r = await pool.query(
        `SELECT trade_date::text AS d,
                sum(rzrqye) AS bal,
                count(*)::int AS legs
           FROM margin_daily
          WHERE exchange_id = ANY($1::text[])
          GROUP BY 1
          ORDER BY 1`,
        [EXCHANGES],
    );
    return r.rows.map((x) => ({
        date: x.d,
        balance: Number(x.bal),
        legs: Number(x.legs),
    }));
}

// ---------------------------------------------------------------------------
// 写
// ---------------------------------------------------------------------------

const COLS = 13;

async function writeRows(rows: PurgeRow[]): Promise<void> {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('TRUNCATE margin_purge_daily');
        const BATCH = 400; // 400 × 13 = 5,200 个参数，远低于 65,535 上限
        for (let i = 0; i < rows.length; i += BATCH) {
            const chunk = rows.slice(i, i + BATCH);
            const tuples: string[] = [];
            const params: unknown[] = [];
            chunk.forEach((r, k) => {
                const b = k * COLS;
                tuples.push(`(${Array.from({ length: COLS }, (_, j) => `$${b + j + 1}`).join(',')})`);
                params.push(
                    r.tradeDate, r.balance, r.peak250, r.peakDate, r.drawdown, r.ma20,
                    r.belowMa20Days, r.episodeId, r.episodeStart, r.episodeDays,
                    r.phase, r.eventKind, SPEC_VERSION,
                );
            });
            await client.query(
                `INSERT INTO margin_purge_daily
                    (trade_date, balance, peak_250, peak_date, drawdown, ma20, below_ma20_days,
                     episode_id, episode_start, episode_days, phase, event_kind, spec_version)
                 VALUES ${tuples.join(',')}`,
                params,
            );
        }
        await client.query('COMMIT');
    } catch (e) {
        await client.query('ROLLBACK');
        throw e;
    } finally {
        client.release();
    }
}

// ---------------------------------------------------------------------------
// 证据
// ---------------------------------------------------------------------------

function formatBalance(v: number): string {
    if (v >= 1e12) return `${(v / 1e12).toFixed(2)} 万亿元`;
    return `${(v / 1e8).toFixed(0)} 亿元`;
}

function formatPct(v: number): string {
    return `${(v * 100).toFixed(1)}%`;
}

/** 数据日期之后的下一个交易日；没有就退回自然日 +1。 */
async function nextTradingDate(d: string): Promise<string> {
    const r = await pool.query(
        'SELECT min(trade_date)::text AS d FROM state_daily WHERE trade_date > $1::date',
        [d],
    );
    if (r.rows[0]?.d) return r.rows[0].d;
    return new Date(new Date(`${d}T00:00:00Z`).getTime() + 86400000).toISOString().slice(0, 10);
}

/** 前 N 次完成事件里，有多少次 T+1 起算的 20 日等权收益为正。 */
async function priorEventStats(events: PurgeRow[]): Promise<{ total: number; up: number }> {
    if (events.length === 0) return { total: 0, up: 0 };
    const s = await pool.query('SELECT trade_date::text AS d, ew_ret FROM state_daily ORDER BY trade_date');
    const dates: string[] = s.rows.map((x) => x.d);
    const rets: number[] = s.rows.map((x) => Number(x.ew_ret));
    const idx = new Map(dates.map((d, i) => [d, i]));

    let up = 0;
    for (const ev of events) {
        const i = idx.get(ev.tradeDate);
        if (i === undefined) continue;
        const fwd = forwardReturn(rets, i, 20);
        if (fwd !== null && fwd > 0) up += 1;
    }
    return { total: events.length, up };
}

async function writeEvidence(rows: PurgeRow[]): Promise<string> {
    const latest = rows[rows.length - 1];
    if (latest.phase === 'none') return '不在回合内，不写';

    const publishedAt = `${await nextTradingDate(latest.tradeDate)}T09:00:00+08:00`;
    if (new Date(publishedAt).getTime() > Date.now()) {
        // 数据 T 日晚间才披露，T+1 开盘前才确定可见；还没到就等下一轮
        return `数据尚未可见（published_at=${publishedAt}），下轮再写`;
    }

    const phaseText = latest.phase === 'purging' ? '出清进行中' : '出清回补中';
    let statement = [
        `截至 ${latest.tradeDate}，两融余额 ${formatBalance(latest.balance)}`,
        `距近一年高点 ${formatPct(latest.drawdown as number)}（高点 ${latest.peakDate}）`,
        `已连续 ${latest.belowMa20Days} 个交易日低于 20 日均线`,
        `${phaseText}（第 ${latest.episodeId} 个回合，自 ${latest.episodeStart} 起 ${latest.episodeDays} 个交易日）`,
    ].join('，') + '。';

    if (latest.eventKind === 'complete') {
        const prior = rows.filter((r) => r.eventKind === 'complete' && r.tradeDate < latest.tradeDate);
        const { total, up } = await priorEventStats(prior);
        const seq = total + 1;
        statement += total === 0
            ? `余额今日上穿 20 日均线，为 2017 年以来第 ${seq} 次出清完成信号。`
            : `余额今日上穿 20 日均线，为 2017 年以来第 ${seq} 次出清完成信号（前 ${total} 次中 ${up} 次 20 日后上涨）。`;
    }

    const payload = {
        node: 'FLOW_MARGIN',
        balance: Number(latest.balance),
        peak_250: latest.peak250 === null ? null : Number(latest.peak250),
        peak_date: latest.peakDate,
        drawdown: latest.drawdown,
        ma20: latest.ma20,
        below_ma20_days: latest.belowMa20Days,
        episode_id: latest.episodeId,
        episode_start: latest.episodeStart,
        episode_days: latest.episodeDays,
        phase: latest.phase,
        event_kind: latest.eventKind,
    };

    const id = `ev_${latest.tradeDate.replace(/-/g, '')}_margin_purge`;
    const res = await pool.query(
        `INSERT INTO evidence_ledger
            (evidence_id, kind, subject_type, subject_code, statement, source, source_type,
             published_at, fetched_at, quality, weight, payload)
         VALUES ($1, 'market', 'market', 'ALL', $2, 'internal_state', 'data',
                 $3::timestamptz, now(), 'ok', NULL, $4::jsonb)
         ON CONFLICT (evidence_id) DO NOTHING`,
        [id, statement, publishedAt, JSON.stringify(payload)],
    );
    return res.rowCount === 1 ? `已写 ${id}` : `${id} 已存在，跳过`;
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    const quiet = hasFlag('quiet');

    const days = await loadBalances();
    if (days.length === 0) throw new Error('margin_daily 为空，先跑 backfill-market-history.ts --tables margin_daily');

    // 缺一家交易所的日子整段丢弃：sum 会少一家，回撤瞬间变深，凭空造出出清信号
    const complete = days.filter((d) => d.legs >= EXCHANGES.length);
    const dropped = days.length - complete.length;
    if (dropped > 0) {
        console.warn(
            `[筹码] 丢弃 ${dropped} 天：SSE/SZSE 未齐（缺一家会把余额算低，凭空造出出清信号）`,
        );
    }

    const rows = buildPurgeSeries(complete.map((d) => ({ date: d.date, balance: d.balance })));
    await writeRows(rows);

    const latest = rows[rows.length - 1];
    const events = rows.filter((r) => r.eventKind === 'complete');
    const evidence = await writeEvidence(rows);

    console.log(
        `[筹码] ${rows.length} 行  最新 ${latest.tradeDate}  ` +
        `回撤 ${latest.drawdown === null ? '—' : formatPct(latest.drawdown)}  ` +
        `phase=${latest.phase}  ` +
        `回合=${latest.episodeId ?? '—'}${latest.episodeDays ? `(${latest.episodeDays}日)` : ''}  ` +
        `完成事件 ${events.length}`,
    );
    if (!quiet) {
        const first = rows.find((r) => r.drawdown !== null);
        console.log(
            `[筹码] 判定起点 ${first?.tradeDate ?? '—'}（前 ${PURGE_DEFAULTS.minHistory} 个交易日历史不足，不判定）`,
        );
        console.log(`[筹码] evidence：${evidence}`);
    }

    await pool.end();
}

main().catch(async (e) => {
    console.error('[筹码] 失败：', e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
