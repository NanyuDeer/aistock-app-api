import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSectorStatsFromRotationRows } from '../src/modules/monitor/WindLeaderAnalyzerService';

/**
 * 上榜次数口径：只统计「涨幅榜」（up_rank 非空），不把「跌幅榜」（down_rank 非空）计入。
 * 背景：board_rotation_daily 每日同时落库涨幅前10 与跌幅前10，过去两者都算作"上榜"，
 *       导致短线（freq10）/长线（freq120）上榜次数被放大，与同花顺网页口径不一致。
 */

/** 构造一批轮动榜行（含涨幅榜与跌幅榜） */
function makeRows() {
    // 甲板块：10-09 涨幅榜 → 10-08 涨幅榜 → 10-07 跌幅榜（应为涨幅榜 2 次）
    // 乙板块：10-09 跌幅榜 → 10-08 跌幅榜 → 10-07 涨幅榜（应为涨幅榜 1 次）
    return [
        { trading_date: '2026-10-09', board_code: '881001', board_name: '甲板块', up_rank: 1, down_rank: null, pct_change: 5 },
        { trading_date: '2026-10-09', board_code: '885001', board_name: '乙板块', up_rank: null, down_rank: 1, pct_change: -5 },
        { trading_date: '2026-10-08', board_code: '881001', board_name: '甲板块', up_rank: 2, down_rank: null, pct_change: 3 },
        { trading_date: '2026-10-08', board_code: '885001', board_name: '乙板块', up_rank: null, down_rank: 2, pct_change: -3 },
        { trading_date: '2026-10-07', board_code: '881001', board_name: '甲板块', up_rank: null, down_rank: 1, pct_change: -2 },
        { trading_date: '2026-10-07', board_code: '885001', board_name: '乙板块', up_rank: 1, down_rank: null, pct_change: 2 },
    ];
}

test('上榜次数只统计涨幅榜：跌幅榜上榜不计入 freq120/freq10', () => {
    const { sectorStats } = buildSectorStatsFromRotationRows(makeRows(), 10);
    const jia = sectorStats.get('甲板块');
    const yi = sectorStats.get('乙板块');
    assert.ok(jia, '甲板块应存在');
    assert.ok(yi, '乙板块应存在');
    assert.equal(jia.freq120, 2, '甲板块 freq120 应为涨幅榜 2 次（10-07 跌幅榜不计）');
    assert.equal(jia.freq10, 2, '甲板块 freq10 应为涨幅榜 2 次');
    assert.equal(yi.freq120, 1, '乙板块 freq120 应为涨幅榜 1 次（10-08/10-09 跌幅榜不计）');
    assert.equal(yi.freq10, 1, '乙板块 freq10 应为涨幅榜 1 次');
});

test('全程只在跌幅榜出现的板块不进入上榜统计', () => {
    const rows = [
        { trading_date: '2026-10-09', board_code: '886001', board_name: '丙板块', up_rank: null, down_rank: 1, pct_change: -6 },
        { trading_date: '2026-10-08', board_code: '886001', board_name: '丙板块', up_rank: null, down_rank: 1, pct_change: -4 },
    ];
    const { sectorStats } = buildSectorStatsFromRotationRows(rows, 10);
    assert.equal(sectorStats.has('丙板块'), false, '只在跌幅榜出现的板块不应计为上榜');
});
