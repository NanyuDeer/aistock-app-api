/**
 * S7：基线 claim 的到期验证
 *
 * 设计：docs/superpowers/specs/2026-11-26-baseline-claim-verification-design.md
 *
 * 只做一件事：把到期的 claim 了结，写下实际收益与两个命中判定。
 * 不做汇总措辞（那是 --report 的事），不做回填（伪造"当时说过"没有意义）。
 *
 * 用法：
 *   node --import tsx scripts/verify-baseline-claims.ts
 *   node --import tsx scripts/verify-baseline-claims.ts --report
 */

import pool from '../src/core/db';
import {
    dueIndex,
    forwardReturn,
    judge,
    parseSourceRef,
    selectNonOverlapping,
} from '../src/modules/insight/claimVerification';

const hasFlag = (n: string): boolean => process.argv.includes(`--${n}`);

interface PendingClaim {
    claimId: string;
    /** null = 存量 claim 没有出处（本闭环跳过并计数） */
    sourceRef: string | null;
    asOf: string;
    horizonDays: number;
    claimHorizon: string;
}

interface Cell {
    p25: number; p50: number; p75: number; probUp: number;
}

async function loadTradingDates(): Promise<string[]> {
    const r = await pool.query('SELECT trade_date::text AS d FROM state_daily ORDER BY trade_date');
    return r.rows.map((x) => x.d);
}

async function loadCaliberReturns(caliber: string): Promise<Map<string, number>> {
    // ew_all 用 state_daily.ew_ret；hs300 用 index_daily
    if (caliber === 'hs300') {
        const r = await pool.query(
            `SELECT trade_date::text AS d, pct_chg / 100.0 AS r FROM index_daily
              WHERE ts_code = '000300.SH' ORDER BY trade_date`,
        );
        return new Map(r.rows.map((x) => [x.d, Number(x.r)]));
    }
    const r = await pool.query('SELECT trade_date::text AS d, ew_ret AS r FROM state_daily ORDER BY trade_date');
    return new Map(r.rows.map((x) => [x.d, Number(x.r)]));
}

async function loadPending(): Promise<PendingClaim[]> {
    // 不在 SQL 里 `source_ref LIKE 'frd:%'`：那样存量 claim（source_ref 为 null）
    // 会被静默过滤掉，"跳过了多少条"就永远看不见。跳过必须在计数里体现。
    const r = await pool.query(
        `SELECT c.claim_id, c.source_ref, c.as_of::date::text AS as_of,
                c.horizon_days, c.horizon
           FROM claim_ledger c
           LEFT JOIN claim_verification v ON v.claim_id = c.claim_id
          WHERE v.claim_id IS NULL
            AND c.horizon_days IS NOT NULL
          ORDER BY c.as_of`,
    );
    return r.rows.map((x) => ({
        claimId: x.claim_id,
        sourceRef: x.source_ref === null ? null : String(x.source_ref),
        asOf: x.as_of,
        horizonDays: Number(x.horizon_days),
        claimHorizon: x.horizon,
    }));
}

async function loadCell(sourceRef: string | null): Promise<Cell | null> {
    const ref = parseSourceRef(sourceRef);
    if (!ref) return null;
    const r = await pool.query(
        `SELECT p25, p50, p75, prob_up FROM forward_return_dist
          WHERE dim = $1 AND bucket = $2 AND horizon = $3
            AND segment = $4 AND caliber = $5 AND spec_version = $6`,
        [ref.dim, ref.bucket, ref.horizon, ref.segment, ref.caliber, ref.specVersion],
    );
    if (r.rowCount !== 1) return null;
    const x = r.rows[0];
    if (x.p25 === null || x.p50 === null || x.p75 === null || x.prob_up === null) return null;
    return {
        p25: Number(x.p25), p50: Number(x.p50), p75: Number(x.p75), probUp: Number(x.prob_up),
    };
}

async function runVerification(): Promise<{ verified: number; pending: number; skipped: number }> {
    const dates = await loadTradingDates();
    const indexOf = new Map(dates.map((d, i) => [d, i]));
    const pendingClaims = await loadPending();

    let verified = 0;
    let pending = 0;
    let skipped = 0;
    const returnCache = new Map<string, number[]>();

    for (const claim of pendingClaims) {
        const ref = parseSourceRef(claim.sourceRef);
        if (!ref) { skipped += 1; continue; }

        const due = dueIndex(dates, claim.asOf, claim.horizonDays);
        if (due === null) { pending += 1; continue; }

        const cell = await loadCell(claim.sourceRef);
        if (!cell) { skipped += 1; continue; }

        let rets = returnCache.get(ref.caliber);
        if (!rets) {
            const m = await loadCaliberReturns(ref.caliber);
            rets = dates.map((d) => (m.has(d) ? (m.get(d) as number) : Number.NaN));
            returnCache.set(ref.caliber, rets);
        }

        const asOfIdx = indexOf.get(claim.asOf);
        if (asOfIdx === undefined) { skipped += 1; continue; }
        const actual = forwardReturn(rets, asOfIdx, claim.horizonDays);
        if (actual === null) { skipped += 1; continue; }

        const { isUp, inIqr } = judge(actual, cell.p25, cell.p75);
        await pool.query(
            `INSERT INTO claim_verification
                (claim_id, due_date, actual_ret, is_up, in_iqr,
                 claimed_p25, claimed_p50, claimed_p75, claimed_prob_up,
                 horizon_days, spec_version)
             VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8, $9, $10, $11)
             ON CONFLICT (claim_id) DO NOTHING`,
            [claim.claimId, dates[due], actual, isUp, inIqr,
             cell.p25, cell.p50, cell.p75, cell.probUp, claim.horizonDays, ref.specVersion],
        );
        verified += 1;
    }
    return { verified, pending, skipped };
}

interface VerifiedRow {
    claimId: string;
    asOf: string;
    asOfIdx: number;
    horizonDays: number;
    actual: number;
    isUp: boolean;
    inIqr: boolean;
    probUp: number;
    p50: number;
}

function summarize(rows: VerifiedRow[]): string {
    const n = rows.length;
    if (n === 0) return '  （无已了结样本）';
    const up = rows.filter((r) => r.isUp).length;
    const iqr = rows.filter((r) => r.inIqr).length;
    const median = [...rows.map((r) => r.actual)].sort((a, b) => a - b)[Math.floor(n / 2)];
    const claimed = rows[0].p50;
    const claimedUp = rows[0].probUp;
    return [
        `  方向 ${up}/${n} = ${((up / n) * 100).toFixed(1)}%   声称 ${(claimedUp * 100).toFixed(1)}%`,
        `  区间 ${iqr}/${n} = ${((iqr / n) * 100).toFixed(1)}%   理论 50%`,
        `  幅度 实际中位数 ${(median * 100).toFixed(2)}%   声称 ${(claimed * 100).toFixed(2)}%`,
    ].join('\n');
}

async function report(): Promise<void> {
    const dates = await loadTradingDates();
    const idx = new Map(dates.map((d, i) => [d, i]));
    const r = await pool.query(
        `SELECT v.claim_id, v.actual_ret, v.is_up, v.in_iqr, v.claimed_p50, v.claimed_prob_up,
                v.horizon_days, c.as_of::date::text AS as_of
           FROM claim_verification v JOIN claim_ledger c ON c.claim_id = v.claim_id
          ORDER BY c.as_of`,
    );
    const rows: VerifiedRow[] = r.rows.map((x) => ({
        claimId: x.claim_id,
        asOf: x.as_of,
        asOfIdx: idx.get(x.as_of) ?? -1,
        horizonDays: Number(x.horizon_days),
        actual: Number(x.actual_ret),
        isUp: Boolean(x.is_up),
        inIqr: Boolean(x.in_iqr),
        probUp: Number(x.claimed_prob_up),
        p50: Number(x.claimed_p50),
    }));

    console.log(`已了结 ${rows.length} 条`);
    console.log('原始（全部已了结）：');
    console.log(summarize(rows));

    const flat = selectNonOverlapping(rows.filter((x) => x.asOfIdx >= 0));
    console.log(`去重叠后（按窗口分期取首条）：${flat.length} 条`);
    console.log(summarize(flat));

    // 样本量守则（spec §8）：< 10 条不下任何结论
    if (rows.length < 10) {
        console.log('\n样本不足 10 条，不给任何结论。逐条明细：');
        for (const x of rows) {
            console.log(`  ${x.asOf}  实际 ${(x.actual * 100).toFixed(2)}%  方向${x.isUp ? '✓' : '✗'}  区间${x.inIqr ? '✓' : '✗'}`);
        }
    } else {
        console.log('\n（≥10 条：可在报告对外时引用命中率，但须同时标注条数与置信区间）');
    }
}

async function main(): Promise<void> {
    if (hasFlag('report')) {
        await report();
        await pool.end();
        return;
    }
    const r = await runVerification();
    console.log(`[verify] 了结 ${r.verified} 条，未到期 ${r.pending} 条，跳过 ${r.skipped} 条`);
    await pool.end();
}

main().catch(async (e) => {
    console.error('[verify] 失败：', e instanceof Error ? e.message : e);
    await pool.end().catch(() => undefined);
    process.exit(1);
});
