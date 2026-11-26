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
} from '../src/modules/insight/claimVerification';

const hasFlag = (n: string): boolean => process.argv.includes(`--${n}`);

interface PendingClaim {
    claimId: string;
    sourceRef: string;
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
    const r = await pool.query(
        `SELECT c.claim_id, c.source_ref, c.as_of::date::text AS as_of,
                c.horizon_days, c.horizon
           FROM claim_ledger c
           LEFT JOIN claim_verification v ON v.claim_id = c.claim_id
          WHERE v.claim_id IS NULL
            AND c.source_ref LIKE 'frd:%'
            AND c.horizon_days IS NOT NULL
          ORDER BY c.as_of`,
    );
    return r.rows.map((x) => ({
        claimId: x.claim_id,
        sourceRef: x.source_ref,
        asOf: x.as_of,
        horizonDays: Number(x.horizon_days),
        claimHorizon: x.horizon,
    }));
}

async function loadCell(sourceRef: string): Promise<Cell | null> {
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

/** 占位：Task 6 替换为真正的汇总输出（本任务是脚本骨架，先保证写库路径正确）。 */
async function report(): Promise<void> {
    throw new Error('not implemented');
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
