/**
 * RotationBoardStore：今日风口榜（T1）+ 实时涨跌幅 stale 修复（T4）
 *
 * 背景：
 *  - today.js 在非交易日/盘前仍返回「上一交易日」的日期，旧实现直接把它当今日涨跌幅，
 *    导致前端把昨日涨幅冒充今日（stale）。故引入 buildBoardRealtime 做日期校验。
 *  - 今日风口榜需要「当日 mrpm 排名 + 实时涨跌幅」，无实时值时降级为最近收盘涨跌幅，
 *    并显式标注数据来源，前端才能区分实时/昨收/不可用。
 *
 * 运行：node --import tsx --test src/modules/monitor/__tests__/RotationBoardStore.today.spec.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
    buildBoardRealtime,
    buildTodayRankingFromHistory,
    buildTodayRankingFromRealtime,
    type BoardRealtime,
    type DailyRotationRow,
    type MrpmTodayRankItem,
} from '../RotationBoardStore';

/** 构造同花顺 today.js（quotebridge JSONP）：1=日期, 11=现价, 19=成交额 */
function todayJsonp(date: string, price: number, amount: number): string {
    return `quotebridge_1({"bk_881175":{"1":"${date}","7":"100","8":"112","9":"99","11":"${price}","13":"1000","19":"${amount}"}})`;
}

/** 构造同花顺 last.js（quotebridge JSONP）：行格式 date,open,high,low,close,volume,amount */
function lastJsonp(rows: [string, number][]): string {
    const data = rows.map(([d, close]) => `${d},100,105,99,${close},1000,100000`).join(';');
    return `quotebridge_2({"data":"${data}"})`;
}

describe('buildBoardRealtime：实时涨跌幅 + stale 判定', () => {
    it('today.js 日期=当前交易日：按昨收计算涨跌幅，source=realtime', () => {
        const rt = buildBoardRealtime(
            todayJsonp('20261112', 110, 12345678),
            lastJsonp([['20261110', 98], ['20261111', 100]]),
            '20261112',
        );
        assert.ok(rt);
        assert.equal(rt.date, '20261112');
        assert.equal(rt.source, 'realtime');
        assert.ok(rt.change_pct !== null);
        // 昨收 100、现价 110 → 10%
        assert.ok(Math.abs(rt.change_pct - 10) < 1e-9, `涨跌幅应约为 10，实际 ${rt.change_pct}`);
        assert.equal(rt.amount, 12345678);
    });

    it('today.js 日期=前一交易日（stale）：不冒充今日，change_pct/amount 置 null', () => {
        const rt = buildBoardRealtime(
            todayJsonp('20261111', 110, 500),
            lastJsonp([['20261110', 100]]),
            '20261112',
        );
        assert.ok(rt);
        assert.equal(rt.date, '20261111');
        assert.equal(rt.source, 'stale');
        assert.equal(rt.change_pct, null);
        assert.equal(rt.amount, null);
    });

    it('last.js 缺失/无法解析 → 返回 null（保持原有降级）', () => {
        const rt = buildBoardRealtime(todayJsonp('20261112', 110, 1), 'not-jsonp-at-all', '20261112');
        assert.equal(rt, null);
    });

    it('last.js 无严格早于今日的收盘价 → 返回 null', () => {
        const rt = buildBoardRealtime(
            todayJsonp('20261112', 110, 1),
            lastJsonp([['20261112', 100]]),
            '20261112',
        );
        assert.equal(rt, null);
    });

    it('today.js 无法解析 → 返回 null', () => {
        const rt = buildBoardRealtime('garbage()', lastJsonp([['20261111', 100]]), '20261112');
        assert.equal(rt, null);
    });
});

describe('buildTodayRankingFromRealtime：mrpm 当日榜 + 实时补全', () => {
    const ranking: MrpmTodayRankItem[] = [
        { board_code: '881175', board_name: '影视院线', rank: 1 },
        { board_code: '885001', board_name: '某概念', rank: 2 },
        { board_code: '885002', board_name: '另一概念', rank: 3 },
    ];

    it('命中的按实时值（保留两位小数），null/stale 项标记 unavailable', () => {
        const realtimeByCode = new Map<string, BoardRealtime | null>([
            ['881175', { date: '20261112', change_pct: 3.14159, amount: 100, source: 'realtime' }],
            ['885001', null],
            ['885002', { date: '20261111', change_pct: 2, amount: 5, source: 'stale' }],
        ]);
        const result = buildTodayRankingFromRealtime(
            '2026-11-12', ranking, realtimeByCode, 10, '2026-11-12 14:00:00',
        );

        assert.equal(result.trading_date, '2026-11-12');
        assert.equal(result.is_live, true);
        assert.equal(result.source, 'ths_mrpm');
        assert.equal(result.update_time, '2026-11-12 14:00:00');
        assert.equal(result.boards.length, 3);

        const [hit, missing, stale] = result.boards;
        assert.equal(hit.board_code, '881175');
        assert.equal(hit.rank, 1);
        assert.equal(hit.change_pct, 3.14);
        assert.equal(hit.amount, 100);
        assert.equal(hit.change_source, 'realtime');

        assert.equal(missing.change_pct, null);
        assert.equal(missing.amount, null);
        assert.equal(missing.change_source, 'unavailable');

        // stale 数据不得冒充今日实时
        assert.equal(stale.change_pct, null);
        assert.equal(stale.amount, null);
        assert.equal(stale.change_source, 'unavailable');
    });

    it('按 limit 截取前 N 名', () => {
        const result = buildTodayRankingFromRealtime(
            '2026-11-12', ranking, new Map(), 2, '2026-11-12 14:00:00',
        );
        assert.deepEqual(result.boards.map(b => b.board_code), ['881175', '885001']);
    });
});

describe('buildTodayRankingFromHistory：收盘榜回退', () => {
    const rows: DailyRotationRow[] = [
        { trading_date: '2026-11-11', board_code: '885002', board_name: 'C', up_rank: 2, down_rank: null, pct_change: 3.2 },
        { trading_date: '2026-11-11', board_code: '885001', board_name: 'B', up_rank: 1, down_rank: null, pct_change: 5.5 },
        { trading_date: '2026-11-11', board_code: '881175', board_name: 'A', up_rank: null, down_rank: 1, pct_change: -4.1 },
        { trading_date: '2026-11-10', board_code: '885003', board_name: 'D', up_rank: 1, down_rank: null, pct_change: 9.9 },
    ];

    it('只取涨幅榜、按 up_rank 升序、取最大交易日那组，标注 latest_close', () => {
        const result = buildTodayRankingFromHistory(rows, 10, '2026-11-12 09:30:00');
        assert.ok(result);
        assert.equal(result.trading_date, '2026-11-11', '多日时取最大日期那一组');
        assert.equal(result.is_live, false);
        assert.equal(result.source, 'board_rotation_daily');
        assert.deepEqual(result.boards.map(b => b.board_code), ['885001', '885002'], '按 up_rank 升序，跌幅榜不计入');
        assert.deepEqual(result.boards.map(b => b.rank), [1, 2]);
        assert.equal(result.boards[0].change_pct, 5.5);
        assert.equal(result.boards[0].amount, null);
        assert.equal(result.boards[0].change_source, 'latest_close');
        assert.equal(result.boards[1].change_source, 'latest_close');
    });

    it('无涨幅榜行 → 返回 null', () => {
        const result = buildTodayRankingFromHistory(
            [{ trading_date: '2026-11-11', board_code: '881175', board_name: 'A', up_rank: null, down_rank: 1, pct_change: -4.1 }],
            10,
            '2026-11-12 09:30:00',
        );
        assert.equal(result, null);
    });
});
