/**
 * RotationBoardStore：hotCirclePlate mrpm → 每日涨/跌榜行 的映射与合并
 *
 * 背景：last.js 日线对「当日」那根 bar 更新不全（881xxx 行业板块常缺、部分概念也缺），
 * 导致当日榜残缺、下游「上榜次数」算错。改用 hotCirclePlate 的 mrpm（官网同款、
 * 近 30 日每日完整涨/跌前 10）作为这些日期的权威来源。
 *
 * 契约（已用官网数据核对）：
 * - mrpm.up[i].stocks[j]   → 涨幅榜名次 = j + 1（index0 = 第 1 名，day0 = 最新交易日）
 * - mrpm.down[i].stocks[j] → 跌幅榜名次 = 条数 - j（index0 = 第 10 名，末位 = 第 1 名）
 * - pct 由 last.js 提供；缺失记 0
 *
 * 运行：node --import tsx --test src/modules/monitor/__tests__/rotationBoardMrpm.spec.ts
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildRowsFromMrpm, mergeRotationRows, normalizeTradingDate, type MrpmPayload, type DailyRotationRow } from '../RotationBoardStore';

function day(datetime: string, codes: [string, string][]): MrpmPayload['up'][number] {
    return { datetime, stocks: codes.map(([stockcode, stockname]) => ({ stockcode, stockname })) };
}

describe('buildRowsFromMrpm：mrpm → 每日涨/跌榜行', () => {
    const mrpm: MrpmPayload = {
        up: [
            day('2026-10-12', [['881274', '影视院线'], ['881164', '文化传媒']]),
            day('2026-10-09', [['881274', '影视院线']]),
        ],
        // down 为「第10名→第1名」顺序
        down: [day('2026-10-12', [['885810', '大豆'], ['881169', '贵金属']])],
    };

    it('涨幅榜按 index 正序=名次；跌幅榜按 index 倒序=名次（末位为第1名）', () => {
        const rows = buildRowsFromMrpm(mrpm, () => undefined);
        const find = (d: string, c: string) => rows.find((r) => r.trading_date === d && r.board_code === c)!;

        assert.equal(find('2026-10-12', '881274').up_rank, 1);
        assert.equal(find('2026-10-12', '881164').up_rank, 2);
        assert.equal(find('2026-10-09', '881274').up_rank, 1);
        // 2 条跌幅榜：index0（大豆）= 第2名，index1（贵金属）= 第1名
        assert.equal(find('2026-10-12', '885810').down_rank, 2);
        assert.equal(find('2026-10-12', '881169').down_rank, 1);
        // 未上榜侧为 null
        assert.equal(find('2026-10-12', '881274').down_rank, null);
        assert.equal(find('2026-10-12', '881169').up_rank, null);
    });

    it('pct 取自 last.js（存在则用，缺失记 0）', () => {
        const rows = buildRowsFromMrpm(mrpm, (code, date) => (code === '881274' && date === '2026-10-12' ? 5.5 : undefined));
        const find = (d: string, c: string) => rows.find((r) => r.trading_date === d && r.board_code === c)!;

        assert.equal(find('2026-10-12', '881274').pct_change, 5.5, '有 last.js 日线 → 用真实涨跌幅');
        assert.equal(find('2026-10-12', '881164').pct_change, 0, '缺 last.js 日线 → 记 0');
    });
});

describe('mergeRotationRows：mrpm 覆盖的日期以 mrpm 为准', () => {
    const hist: DailyRotationRow[] = [
        { trading_date: '2026-10-12', board_code: '885792', board_name: '赛马概念', up_rank: 1, down_rank: null, pct_change: 1.27 },
        { trading_date: '2026-10-08', board_code: '881107', board_name: '油气开采及服务', up_rank: 1, down_rank: null, pct_change: 3.1 },
    ];
    const mrpmRows: DailyRotationRow[] = [
        { trading_date: '2026-10-12', board_code: '881274', board_name: '影视院线', up_rank: 1, down_rank: null, pct_change: 0 },
    ];

    it('被 mrpm 覆盖的日期丢弃历史残缺行，未覆盖日期保留', () => {
        const merged = mergeRotationRows(hist, mrpmRows);
        assert.equal(merged.length, 2, '历史 10-12 行应被丢弃，历史 10-08 行保留 + mrpm 10-12 行');
        assert.ok(merged.some((r) => r.trading_date === '2026-10-12' && r.board_code === '881274'), '应保留 mrpm 的 10-12 行');
        assert.ok(!merged.some((r) => r.trading_date === '2026-10-12' && r.board_code === '885792'), '历史残缺的 10-12 行应被剔除');
        assert.ok(merged.some((r) => r.trading_date === '2026-10-08'), '未覆盖的 10-08 历史行保留');
    });

    // 回归：last.js 推导的日期是 YYYYMMDD、mrpm 是 YYYY-MM-DD，格式不同也不能漏覆盖，
    // 否则同一天会同时存在两套行 → 批量 INSERT 触发
    // "ON CONFLICT DO UPDATE command cannot affect row a second time"
    it('历史行 YYYYMMDD 与 mrpm YYYY-MM-DD 混用也能正确覆盖，同一天只留一套', () => {
        const histRaw: DailyRotationRow[] = [
            { trading_date: '20261012', board_code: '885792', board_name: '赛马概念', up_rank: 1, down_rank: null, pct_change: 1.27 },
            { trading_date: '20261008', board_code: '881107', board_name: '油气开采及服务', up_rank: 1, down_rank: null, pct_change: 3.1 },
        ];
        const mrpmIso: DailyRotationRow[] = [
            { trading_date: '2026-10-12', board_code: '881274', board_name: '影视院线', up_rank: 1, down_rank: null, pct_change: 0 },
        ];
        const merged = mergeRotationRows(histRaw, mrpmIso);
        const day1012 = merged.filter((r) => normalizeTradingDate(r.trading_date) === '2026-10-12');
        assert.equal(day1012.length, 1, '同一天只能有一套行');
        assert.equal(day1012[0].board_code, '881274', '10-12 应以 mrpm 为准');
        assert.equal(normalizeTradingDate(merged.find((r) => r.board_code === '881107')!.trading_date), '2026-10-08', '未覆盖日保留');
    });
});
