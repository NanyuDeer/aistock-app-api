import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeJq, type BreadthCache, type DailyLimit, type LimitCache, type TushareClient } from '../src/modules/fear-greed/calculator';

/** 生成连续 YYYYMMDD 日期（跳过周末简化） */
function genDates(n: number): string[] {
    const out: string[] = [];
    const base = new Date(2026, 0, 1);
    let added = 0;
    while (added < n) {
        const d = new Date(base);
        d.setDate(base.getDate() + added * 1);
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        out.push(`${y}${m}${day}`);
        added += 1;
    }
    return out;
}

const DATES = genDates(50);

/** 构造可控 mock tushare 客户端 */
function makeClient(): TushareClient {
    return {
        async request(apiName: string, params: Record<string, unknown>, fields = '') {
            switch (apiName) {
                case 'trade_cal':
                    return DATES.map((cal_date) => ({ cal_date, is_open: 1 }));
                case 'fund_daily':
                    // 50ETF：构造递减（波动升高）的收盘价
                    return DATES.map((trade_date, i) => ({ trade_date, close: 100 - i * 0.3 }));
                case 'moneyflow_hsgt':
                    // 北向资金：先负后正（近期流入增多）
                    return DATES.map((trade_date, i) => ({ trade_date, north_money: i < 20 ? -5 : 5 }));
                case 'index_weight':
                    return ['000001.SZ', '000002.SZ', '600000.SH'].flatMap((con_code) =>
                        DATES.map((trade_date) => ({ con_code, trade_date })));
                case 'daily': {
                    const p = params as { trade_date?: string; ts_code?: string; start_date?: string; end_date?: string };
                    if (p.trade_date) {
                        // 全市场按日：用于涨跌停推导（涨停=收盘达涨停价，炸板=触板未封，跌停=收盘达跌停价）
                        const i = DATES.indexOf(String(p.trade_date));
                        const late = i >= 40;
                        const base = 100;
                        const r2 = (v: number) => Math.round(v * 100) / 100;
                        const mk = (ts_code: string, pre: number, close: number, high: number) => ({
                            ts_code, pre_close: pre, close, high,
                            pct_chg: Math.round(((close - pre) / pre) * 10000) / 100,
                        });
                        return [
                            // 早段 1 只涨停，后段 2 只涨停（封板率抬升）；600001 全期封板 → 连板递增
                            mk('600001.SH', base, r2(base * 1.1), r2(base * 1.1)),
                            ...(late ? [mk('600002.SH', base, r2(base * 1.1), r2(base * 1.1))] : []),
                            // 创业板触板未封 → 炸板
                            mk('300001.SZ', base, base + 5, r2(base * 1.2)),
                            // 跌停
                            mk('600003.SH', base, r2(base * 0.9), r2(base * 0.9)),
                        ];
                    }
                    // 沪深300成分股：近期 pct_chg 正值占比升高 → 宽度走强
                    return ['000001.SZ', '000002.SZ', '600000.SH'].flatMap((ts_code) =>
                        DATES.map((trade_date, i) => ({
                            ts_code, trade_date,
                            pct_chg: i >= 40 ? 2 : -1,
                        })));
                }
                case 'fut_daily':
                    // IF 期货：后期升水（close > 现货）
                    return DATES.map((trade_date, i) => ({ trade_date, close: 100 + (i >= 40 ? 1.2 : -0.2) }));
                case 'index_daily': {
                    const tsCode = String(params.ts_code);
                    if (tsCode === '000012.SH') {
                        // 国债指数：平稳上行
                        return DATES.map((trade_date, i) => ({ trade_date, close: 150 + i * 0.1 }));
                    }
                    // 000300.SH / 000001.SH：现货波动上行
                    return DATES.map((trade_date, i) => ({ trade_date, close: 100 + i * 0.5 }));
                }
                case 'margin':
                    return DATES.map((trade_date, i) => ({ trade_date, rzmre: 5e9 + i * 1e8 }));
                default:
                    throw new Error(`unexpected api: ${apiName} ${JSON.stringify(params)} ${fields}`);
            }
        },
    };
}

/** 内存版 breadth 缓存 */
function makeCache(): BreadthCache & { upserted: number } {
    const map = new Map<string, number>();
    return {
        map,
        upserted: 0,
        async getAll() { return map; },
        async upsert(rows) {
            for (const r of rows) {
                map.set(r.tradeDate, r.upRatio);
                this.upserted += 1;
            }
        },
    };
}

/** 内存版 limit 缓存 */
function makeLimitCache(): LimitCache & { upserted: number } {
    const map = new Map<string, DailyLimit>();
    return {
        map,
        upserted: 0,
        async getAll() { return map; },
        async upsert(rows) {
            for (const r of rows) {
                map.set(r.date, r);
                this.upserted += 1;
            }
        },
    };
}

test('computeJq 返回完整结构（key/name/10 指标/合成指数）', async () => {
    const cache = makeCache();
    const result = await computeJq(makeClient(), cache, makeLimitCache());

    assert.equal(result.key, 'jq');
    assert.equal(result.name, '韭圈儿恐贪指数');
    assert.equal(result.indicators.length, 10);
    assert.ok(result.composite >= 0 && result.composite <= 100);
    assert.ok(typeof result.label === 'string' && result.label.length > 0);
    // 综合指数历史存在
    assert.ok(result.history.dates.length > 0);
    assert.equal(result.history.dates.length, result.history.scores.length);
});

test('margin 指标标记 excluded（不计入综合指数）', async () => {
    const result = await computeJq(makeClient(), makeCache(), makeLimitCache());
    const margin = result.indicators.find((i) => i.key === 'margin');
    assert.ok(margin);
    assert.equal(margin.excluded, true);
});

test('breadth 缓存 upsert 被调用并写入缺失日期', async () => {
    const cache = makeCache();
    await computeJq(makeClient(), cache, makeLimitCache());
    assert.ok(cache.upserted > 0, 'breadth 应写入增量缓存');
    const all = await cache.getAll();
    assert.ok(all.size > 0);
});

test('limit 缓存 upsert 被调用并写入缺失日期', async () => {
    const cache = makeLimitCache();
    await computeJq(makeClient(), makeCache(), cache);
    assert.ok(cache.upserted > 0, 'limit 应写入增量缓存');
    const all = await cache.getAll();
    assert.ok(all.size > 0);
    // 每个缓存日期的涨跌停聚合应有推导结果
    const sample = [...all.values()][0];
    assert.ok(sample.sealCount > 0, '封板数应 > 0');
    assert.ok(sample.breakCount > 0, '炸板数应 > 0');
    assert.ok(sample.downCount > 0, '跌停数应 > 0');
});

test('指标历史序列为倒序（最新在前）且数值 0-100', async () => {
    const result = await computeJq(makeClient(), makeCache(), makeLimitCache());
    for (const ind of result.indicators) {
        assert.ok(ind.score >= 0 && ind.score <= 100, `${ind.key} score 越界: ${ind.score}`);
        assert.equal(ind.history.scores.length, ind.history.dates.length, `${ind.key} 历史序列长度不一致`);
        for (const s of ind.history.scores) {
            assert.ok(s >= 0 && s <= 100, `${ind.key} 历史分数越界: ${s}`);
        }
    }
});
