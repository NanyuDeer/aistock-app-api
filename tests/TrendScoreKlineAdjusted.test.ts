import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTencentKlineToTrendKline } from '../src/modules/monitor/TrendScoreService';

test('parseTencentKlineToTrendKline 将腾讯前复权日K转为评分K线结构（含除权标记行）', () => {
    // 源杰科技(688498) 2026-05-18 除权除息（10派7元转4.5股），腾讯qfq前复权数据平滑无断裂。
    // 行格式: [时间, 开盘价, 收盘价, 最高价, 最低价, 成交量, 除权标记对象(可选)]
    const rows: unknown[] = [
        ['2026-05-15', '1092.333', '1075.730', '1138.467', '1045.356', '4864984'],
        // 除权日：第7项为除权标记，应被正常解析且不影响OHLC
        ['2026-05-18', '1048.000', '1058.080', '1104.000', '1041.810', '5416335', { fh_sh: '7', FHcontent: '10派7元转4.5股' }],
        ['2026-05-19', '1032.120', '1068.000', '1072.790', '1000.080', '4895054'],
    ];

    const { dates, ohlc } = parseTencentKlineToTrendKline(rows);

    // 日期转为 YYYYMMDD 紧凑格式（与 Tushare trade_date 一致）
    assert.deepEqual(dates, ['20260515', '20260518', '20260519']);

    // OHLC 顺序与 Tushare 一致: [open, close, low, high]；除权标记行正常解析
    assert.deepEqual(ohlc, [
        [1092.333, 1075.73, 1045.356, 1138.467],
        [1048, 1058.08, 1041.81, 1104],
        [1032.12, 1068, 1000.08, 1072.79],
    ]);

    // 核心断言：前复权下 5/15→5/18 收盘价平滑（差异远小于 20% 涨跌停限制）
    const jump = (ohlc[1][1] - ohlc[0][1]) / ohlc[0][1] * 100;
    assert.ok(Math.abs(jump) < 20, `前复权除权日跳变应 <20%，实际 ${jump.toFixed(2)}%`);
});

test('parseTencentKlineToTrendKline 忽略非法行与空输入', () => {
    assert.deepEqual(parseTencentKlineToTrendKline([]), { dates: [], ohlc: [] });
    assert.deepEqual(parseTencentKlineToTrendKline(null), { dates: [], ohlc: [] });
    // 缺失字段/长度不足的行被跳过
    const rows = [
        ['2026-05-19', '1032.120', '1068.000'], // 长度不足
        ['bad-date', '1', '2', '3', '4'],        // 日期非法
        ['2026-05-20', 'notnum', '2', '3', '4'], // 价格非法
        ['2026-05-21', '1', '2', '3', '4'],      // 合法
    ];
    const { dates, ohlc } = parseTencentKlineToTrendKline(rows);
    assert.deepEqual(dates, ['20260521']);
    assert.deepEqual(ohlc, [[1, 2, 4, 3]]);
});

test('parseTencentKlineToTrendKline 支持 getKLine 返回的对象格式', () => {
    // TencentKlineService.getKLine 实际返回对象数组（字段为中文键）
    const rows = [
        { '时间': '2026-05-15', '开盘价': 1092.333, '收盘价': 1075.73, '最高价': 1138.467, '最低价': 1045.356, '成交量': 4864984 },
        { '时间': '2026-05-18', '开盘价': 1048, '收盘价': 1058.08, '最高价': 1104, '最低价': 1041.81, '成交量': 5416335 },
        { '时间': '2026-05-19', '开盘价': 1032.12, '收盘价': 1068, '最高价': 1072.79, '最低价': 1000.08, '成交量': 4895054 },
    ];

    const { dates, ohlc } = parseTencentKlineToTrendKline(rows);

    assert.deepEqual(dates, ['20260515', '20260518', '20260519']);
    assert.deepEqual(ohlc, [
        [1092.333, 1075.73, 1045.356, 1138.467],
        [1048, 1058.08, 1041.81, 1104],
        [1032.12, 1068, 1000.08, 1072.79],
    ]);

    const jump = (ohlc[1][1] - ohlc[0][1]) / ohlc[0][1] * 100;
    assert.ok(Math.abs(jump) < 20, `前复权除权日跳变应 <20%，实际 ${jump.toFixed(2)}%`);
});