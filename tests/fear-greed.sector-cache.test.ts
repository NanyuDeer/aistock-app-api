/**
 * getSectorBoardData 缓存行为回归测试：
 * 1) 软失败（availability:false）结果不得写入缓存——否则会把降级结果冻结 10 分钟，
 *    前端建议卡在静态 fallback；
 * 2) 健康结果 10 分钟内命中缓存、TTL 过期后重取；
 * 3) 双源失败返回体 availability:false 且 source 为空串。
 * 注入 stub loaders（与 buildSectorBoardData 同款）；用 node:test mock.timers(apis:['Date'])
 * 控制时间，避免真实等待 10 分钟。各用例时间基准错开 > TTL，规避模块级缓存跨用例串扰。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSectorBoardData } from '../src/modules/fear-greed/FearGreedService';

function fact(name: string, pct: number, net: number) {
    return { ts_code: 'BK0001', name, pct_change: pct, net_amount: net, lead_stock: 'X', company_num: 10, trade_date: '20260903' };
}

const TTL_MS = 10 * 60 * 1000; // 与 SECTOR_CACHE_TTL_SECONDS 对齐

/** 固定时间基准，彼此错开 1h（> TTL），防止上个用例写入的模块级缓存被命中 */
const T0 = 1_700_000_000_000;
const T1 = T0 + 3_600_000;
const T2 = T0 + 7_200_000;
const T3 = T0 + 10_800_000;

function healthyConcept(counter: { n: number }) {
    return async () => {
        counter.n++;
        return {
            gainers: [fact('A', 3, 1e8)],
            losers: [fact('B', -2, -1e8)],
            inflows: [fact('C', 1, 5e8)],
            outflows: [fact('D', 4, -5e8)],
            available: true,
        };
    };
}

test('软失败(availability:false)不写缓存：随后健康数据源调用会重新拉取', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(T0);

    let deadCalls = 0;
    const deadConcept = async () => { deadCalls++; return { gainers: [], losers: [], inflows: [], outflows: [], available: false }; };
    const deadTencent = async () => { deadCalls++; return { gainers: [], losers: [], available: false }; };

    const failed = await getSectorBoardData({ concept: deadConcept, tencent: deadTencent });
    assert.equal(failed.availability, false);
    assert.equal(failed.source, '');
    assert.equal(deadCalls, 2, '双源均失败后才降级');

    // 紧接着换健康数据源：若软失败结果被写缓存，这里会命中缓存返回 availability:false 且不拉取
    const healthCounter = { n: 0 };
    const healthy = await getSectorBoardData({ concept: healthyConcept(healthCounter), tencent: deadTencent });
    assert.equal(healthy.availability, true);
    assert.equal(healthCounter.n, 1, '软失败结果不应写入缓存：健康调用必须真正重新拉取');
});

test('健康结果写入缓存：10 分钟内第二次调用不重取', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(T1);

    const counter = { n: 0 };
    const concept = healthyConcept(counter);
    const tencent = async () => { throw new Error('tencent 不应被调用（concept 已成功）'); };

    const first = await getSectorBoardData({ concept, tencent });
    assert.equal(first.availability, true);
    assert.equal(counter.n, 1);

    const second = await getSectorBoardData({ concept, tencent });
    assert.equal(second.availability, true);
    assert.equal(counter.n, 1, '10 分钟内应命中缓存，不重新拉取');
});

test('缓存超过 10 分钟 TTL 后重新拉取', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(T2);

    const counter = { n: 0 };
    const concept = healthyConcept(counter);
    const tencent = async () => { throw new Error('tencent 不应被调用（concept 已成功）'); };

    const first = await getSectorBoardData({ concept, tencent });
    assert.equal(counter.n, 1);

    t.mock.timers.tick(TTL_MS + 1); // 越过 10 分钟 TTL
    const second = await getSectorBoardData({ concept, tencent });
    assert.equal(counter.n, 2, 'TTL 过期后应重新拉取');
    assert.equal(second.availability, true);
});

test('双源失败：返回体 availability:false 且 source 为空串', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    t.mock.timers.setTime(T3);

    const deadConcept = async () => ({ gainers: [], losers: [], inflows: [], outflows: [], available: false });
    const deadTencent = async () => ({ gainers: [], losers: [], available: false });

    const out = await getSectorBoardData({ concept: deadConcept, tencent: deadTencent });
    assert.equal(out.availability, false);
    assert.equal(out.source, '');
    assert.deepEqual(out.sectors, { topGainers: [], topInflows: [], topLosers: [], topOutflows: [] });
});
