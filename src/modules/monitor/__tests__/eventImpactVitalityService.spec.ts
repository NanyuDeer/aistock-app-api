/**
 * EventImpactVitalityService 纯函数单测（一期「只算不干扰」）。
 *
 * 覆盖：主导方向 / 衰减 / 对齐判定（含 neutral）/ 分档边界 / 别名桥接与包含式兜底 /
 * no_observation / attribution_weak / 端到端 computeVitality / 日期工具。
 *
 * 运行：node --import tsx --test src/modules/monitor/__tests__/eventImpactVitalityService.spec.ts
 */
import assert from 'node:assert/strict';
import { describe, it, mock } from 'node:test';

import pool from '../../../core/db';
import {
    buildBoardPct,
    computeVitality,
    diffDays,
    directedExcess,
    dominantDirection,
    eventHorizonDays,
    getLatestVitality,
    getLatestVitalityByEventIds,
    judgeAligned,
    judgeImpactStatus,
    judgeReversed,
    normalizeEventTypeCategory,
    resolveIndustryBoardCode,
    shiftDate,
    snapshotBaselineForEvent,
    topChainIndustries,
    type VitalityConfig,
    type VitalityBaselineRow,
} from '../EventImpactVitalityService';

const CONFIG: VitalityConfig = {
    enabled: true,
    windowMaxDays: 45,
    horizonMultiplier: 4,
    reversalDays: 2,
    excessMinPct: 0.5,
    recentAlignedDays: 3,
    excessScalePct: 2,
    weights: { aligned: 0.35, recency: 0.3, cumExcess: 0.2, reinforce: 0.15 },
    halfLifeByType: { policy: 14, macro: 10, geopolitical: 7, industry: 5, company: 3, market: 2 },
    halfLifeDefault: 5,
    reinforceTarget: 2,
    topIndustries: 3,
    benchmarkCode: '000001.SH',
};

/** 常用基线：10/01 政策/行业类事件，影视院线 bullish。 */
function baseline(overrides: Partial<VitalityBaselineRow> = {}): VitalityBaselineRow {
    return {
        event_id: 'E1',
        event_type: 'industry_news',
        event_date: '2026-10-01',
        chain: [{ industry: '影视院线', direction: 'bullish', impactStrength: 0.9 }],
        ...overrides,
    };
}

const INDEX = new Map<string, string>([['影视院线', '881274']]);

describe('dominantDirection：按 impactStrength 加权（1.5 倍阈值）', () => {
    it('单边 bullish → bullish', () => {
        assert.equal(dominantDirection([{ industry: 'A', direction: 'bullish', impactStrength: 0.9 }]), 'bullish');
    });
    it('空链 / 无强度 → neutral', () => {
        assert.equal(dominantDirection([]), 'neutral');
        assert.equal(dominantDirection([{ industry: 'A', direction: 'bullish' }]), 'neutral');
    });
    it('多空接近（未达 1.5 倍）→ neutral', () => {
        assert.equal(
            dominantDirection([
                { industry: 'A', direction: 'bullish', impactStrength: 1 },
                { industry: 'B', direction: 'bearish', impactStrength: 0.9 },
            ]),
            'neutral',
        );
    });
    it('空方显著占优 → bearish', () => {
        assert.equal(
            dominantDirection([
                { industry: 'A', direction: 'bullish', impactStrength: 0.3 },
                { industry: 'B', direction: 'bearish', impactStrength: 1 },
            ]),
            'bearish',
        );
    });
});

describe('eventHorizonDays：事件类型 → 正常寿命（期限）', () => {
    it('类型期限 = 半衰期 × horizonMultiplier（policy 14×4=56 / company 3×4=12 / market 2×4=8）', () => {
        assert.equal(eventHorizonDays('policy_release', CONFIG), 56);
        assert.equal(eventHorizonDays('公司公告', CONFIG), 12);
        assert.equal(eventHorizonDays('市场动态', CONFIG), 8);
    });
    it('未识别类型走 halfLifeDefault（industry 5×4=20）', () => {
        assert.equal(eventHorizonDays('unknown_thing', CONFIG), 20);
        assert.equal(eventHorizonDays('', CONFIG), 20);
    });
});

describe('judgeAligned / directedExcess：方向一致性判定', () => {
    it('bullish 需 ≥ +0.5%', () => {
        assert.equal(judgeAligned(0.5, 'bullish', 0.5), true);
        assert.equal(judgeAligned(0.49, 'bullish', 0.5), false);
    });
    it('bearish 需 ≤ -0.5%（跑输即对齐）', () => {
        assert.equal(judgeAligned(-0.5, 'bearish', 0.5), true);
        assert.equal(judgeAligned(0.5, 'bearish', 0.5), false);
    });
    it('neutral 只判幅度', () => {
        assert.equal(judgeAligned(0.6, 'neutral', 0.5), true);
        assert.equal(judgeAligned(-0.6, 'neutral', 0.5), true);
        assert.equal(judgeAligned(0.1, 'neutral', 0.5), false);
    });
    it('directedExcess 与主导方向同号为正', () => {
        assert.equal(directedExcess(2, 'bullish'), 2);
        assert.equal(directedExcess(-2, 'bearish'), 2);
        assert.equal(directedExcess(-2, 'neutral'), 2);
    });
});

describe('judgeReversed：反向超额（逻辑被证伪）判定', () => {
    it('bullish 事件出现 ≤ -0.5% 的超额 → 反向', () => {
        assert.equal(judgeReversed(-0.5, 'bullish', 0.5), true);
        assert.equal(judgeReversed(0.5, 'bullish', 0.5), false);
    });
    it('bearish 事件出现 ≥ +0.5% 的超额 → 反向', () => {
        assert.equal(judgeReversed(0.5, 'bearish', 0.5), true);
        assert.equal(judgeReversed(-0.5, 'bearish', 0.5), false);
    });
    it('neutral 无方向 → 不判反向', () => {
        assert.equal(judgeReversed(-2, 'neutral', 0.5), false);
    });
});

describe('judgeImpactStatus：先分类型期限，再判影响是否消散', () => {
    const base = { observable: true, everAligned: true, ageDays: 5, horizonDays: 56, reversed: false };

    it('曾传导 + 未到期 → alive（默认预期，前端不标注）', () => {
        assert.equal(judgeImpactStatus(base), 'alive');
    });
    it('曾传导 + 到期（ageDays ≥ horizonDays，含边界）→ expired', () => {
        assert.equal(judgeImpactStatus({ ...base, ageDays: 56 }), 'expired');
        assert.equal(judgeImpactStatus({ ...base, ageDays: 57 }), 'expired');
    });
    it('曾传导 + 被反向证伪 → 提前 expired', () => {
        assert.equal(judgeImpactStatus({ ...base, reversed: true }), 'expired');
    });
    it('从未形成定向传导 → fading（未起效 ≠ 已消散，禁判 expired）', () => {
        assert.equal(judgeImpactStatus({ ...base, everAligned: false, ageDays: 57 }), 'fading');
    });
    it('无可观测行情 → no_observation（vitality=null，禁判 expired）', () => {
        assert.equal(judgeImpactStatus({ ...base, observable: false, ageDays: 57 }), 'no_observation');
    });
});

describe('normalizeEventTypeCategory：event_type 关键词归一', () => {
    it('政策 / 宏观 / 地缘 / 行业 / 公司 / 市场动态', () => {
        assert.equal(normalizeEventTypeCategory('policy_release'), 'policy');
        assert.equal(normalizeEventTypeCategory('监管变化'), 'policy');
        assert.equal(normalizeEventTypeCategory('宏观数据'), 'macro');
        assert.equal(normalizeEventTypeCategory('geopolitical_conflict'), 'geopolitical');
        assert.equal(normalizeEventTypeCategory('industry_supply'), 'industry');
        assert.equal(normalizeEventTypeCategory('技术突破'), 'industry');
        assert.equal(normalizeEventTypeCategory('company_earnings'), 'company');
        assert.equal(normalizeEventTypeCategory('市场动态'), 'market');
        assert.equal(normalizeEventTypeCategory('unknown_thing'), 'unknown');
    });
});

describe('resolveIndustryBoardCode：精确 → 别名桥接 → 包含式兜底', () => {
    it('精确名命中', () => {
        assert.equal(resolveIndustryBoardCode('影视院线', INDEX), '881274');
    });
    it('别名桥接命中（探针未命中的 4 个名之一）', () => {
        const idx = new Map<string, string>([['石油行业', '881001']]);
        assert.equal(resolveIndustryBoardCode('石油石化', idx), '881001');
    });
    it('包含式兜底命中', () => {
        const idx = new Map<string, string>([['石油天然气', '881003']]);
        assert.equal(resolveIndustryBoardCode('石油', idx), '881003');
    });
    it('全部未命中 → null（降级 no_observation，不抛错）', () => {
        assert.equal(resolveIndustryBoardCode('不存在的行业', INDEX), null);
        assert.equal(resolveIndustryBoardCode('', INDEX), null);
    });
});

describe('topChainIndustries：impactStrength 降序 Top N，过滤空行业', () => {
    it('排序 + 截断 + 过滤', () => {
        const out = topChainIndustries(
            [
                { industry: 'A', impactStrength: 0.2 },
                { industry: '', impactStrength: 1 },
                { industry: 'B', impactStrength: 0.8 },
                { industry: 'C', impactStrength: 0.5 },
            ],
            2,
        );
        assert.deepEqual(out.map((n) => n.industry), ['B', 'C']);
    });
});

describe('computeVitality：端到端评分', () => {
    it('持续顺向超额 → alive（未到期，传导强度分不乘衰减）', () => {
        const result = computeVitality({
            baseline: baseline(),
            statDate: '2026-10-05',
            industryIndex: INDEX,
            boardPct: new Map([['881274', new Map([['2026-10-02', 3.0], ['2026-10-03', 2.0]])]]),
            benchmarkPct: new Map([['2026-10-02', 0.5], ['2026-10-03', 0.0], ['2026-10-04', 0.1]]),
            peerEvents: [],
            config: CONFIG,
        });
        // observedDays=2, alignedRatio=1, recency=2/3, cum=1, reinforce=0 → base 0.75
        assert.equal(result.impact_status, 'alive');
        assert.equal(result.vitality, 0.75);
        assert.equal(result.observed_industries[0].obs_days, 2);
        assert.equal(result.observed_industries[0].aligned_days, 2);
        assert.equal(result.window_start, '2026-10-01');
        assert.equal(result.window_end, '2026-10-05');
    });

    it('attribution_weak：同行业另有重大事件 → 不计分子、计入分母', () => {
        const result = computeVitality({
            baseline: baseline(),
            statDate: '2026-10-05',
            industryIndex: INDEX,
            boardPct: new Map([['881274', new Map([['2026-10-02', 3.0], ['2026-10-03', 2.0]])]]),
            benchmarkPct: new Map([['2026-10-02', 0.5], ['2026-10-03', 0.0]]),
            peerEvents: [
                {
                    // 方向 neutral → 不触发 reinforce，只触发 weak（weak 只看行业重叠）
                    event_id: 'E2',
                    chain: [{ industry: '影视院线' }],
                    direction: 'neutral',
                    event_date: '2026-10-02',
                },
            ],
            config: CONFIG,
        });
        assert.equal(result.impact_status, 'fading'); // 从未形成定向传导 → 不判消散
        assert.equal(result.vitality, 0.2);
        assert.equal(result.reinforce_count, 0);
        assert.equal(result.observed_industries[0].weak_days, 2);
        assert.equal(result.observed_industries[0].aligned_days, 0);
    });

    it('reinforce：窗口内同行业新增同向事件计入加成', () => {
        const result = computeVitality({
            baseline: baseline(),
            statDate: '2026-10-05',
            industryIndex: INDEX,
            boardPct: new Map([['881274', new Map([['2026-10-02', 3.0], ['2026-10-03', 2.0]])]]),
            benchmarkPct: new Map([['2026-10-02', 0.5], ['2026-10-03', 0.0]]),
            peerEvents: [
                {
                    // 事件日 10/04 晚于全部观测日 → 不判 weak，只计 reinforce
                    event_id: 'E3',
                    chain: [{ industry: '影视院线', direction: 'bullish', impactStrength: 0.8 }],
                    direction: 'bullish',
                    event_date: '2026-10-04',
                },
            ],
            config: CONFIG,
        });
        assert.equal(result.reinforce_count, 1);
        assert.equal(result.observed_industries[0].weak_days, 0);
        assert.equal(result.impact_status, 'alive');
        assert.equal(result.vitality, 0.825); // 0.75 + 0.15 × (1/2)
    });

    it('长周期事件（政策，期限 56 天）：第 7 天仍存活 → 不标「影响已消散」', () => {
        const result = computeVitality({
            baseline: baseline({ event_type: 'policy_release', event_date: '2026-10-01' }),
            statDate: '2026-10-08',
            industryIndex: INDEX,
            boardPct: new Map([['881274', new Map([['2026-10-02', 3.0], ['2026-10-03', 2.0]])]]),
            benchmarkPct: new Map([['2026-10-02', 0.5], ['2026-10-03', 0.0]]),
            peerEvents: [],
            config: CONFIG,
        });
        assert.equal(result.impact_status, 'alive');
    });

    it('一次性行情事件（市场动态，期限 8 天）：到期后必标「影响已消散」', () => {
        const result = computeVitality({
            baseline: baseline({ event_type: '市场动态', event_date: '2026-10-01' }),
            statDate: '2026-10-09',
            industryIndex: INDEX,
            boardPct: new Map([['881274', new Map([['2026-10-02', 3.0], ['2026-10-03', 2.0]])]]),
            benchmarkPct: new Map([['2026-10-02', 0.5], ['2026-10-03', 0.0]]),
            peerEvents: [],
            config: CONFIG,
        });
        assert.equal(result.impact_status, 'expired');
    });

    it('从未形成定向传导（30 天后仍无 aligned）→ fading，不标「影响已消散」', () => {
        const result = computeVitality({
            baseline: baseline({ event_type: '市场动态', event_date: '2026-10-01' }),
            statDate: '2026-10-31',
            industryIndex: INDEX,
            boardPct: new Map([['881274', new Map([['2026-10-02', 0.1], ['2026-10-03', -0.1]])]]),
            benchmarkPct: new Map([['2026-10-02', 0.0], ['2026-10-03', 0.0]]),
            peerEvents: [],
            config: CONFIG,
        });
        assert.equal(result.observed_industries[0].aligned_days, 0);
        assert.equal(result.impact_status, 'fading');
    });

    it('曾传导后被反向证伪（连续 2 日反向超额）→ 提前 expired', () => {
        const result = computeVitality({
            baseline: baseline({ event_type: 'policy_release', event_date: '2026-10-01' }),
            statDate: '2026-10-04',
            industryIndex: INDEX,
            boardPct: new Map([['881274', new Map([['2026-10-02', 3.0], ['2026-10-03', -2.0], ['2026-10-04', -2.0]])]]),
            benchmarkPct: new Map([['2026-10-02', 0.0], ['2026-10-03', 0.0], ['2026-10-04', 0.0]]),
            peerEvents: [],
            config: CONFIG,
        });
        assert.equal(result.observed_industries[0].aligned_days, 1);
        assert.equal(result.impact_status, 'expired');
    });

    it('行业映射不到板块 → no_observation（vitality=null，不判 expired）', () => {
        const result = computeVitality({
            baseline: baseline({ chain: [{ industry: '不存在的行业', direction: 'bullish', impactStrength: 0.9 }] }),
            statDate: '2026-10-05',
            industryIndex: INDEX,
            boardPct: new Map(),
            benchmarkPct: new Map([['2026-10-02', 0.5]]),
            peerEvents: [],
            config: CONFIG,
        });
        assert.equal(result.impact_status, 'no_observation');
        assert.equal(result.vitality, null);
        assert.equal(result.observed_industries[0].board_code, null);
    });

    it('无板块数据（观测日为 0）→ no_observation', () => {
        const result = computeVitality({
            baseline: baseline(),
            statDate: '2026-10-05',
            industryIndex: INDEX,
            boardPct: new Map(),
            benchmarkPct: new Map([['2026-10-02', 0.5]]),
            peerEvents: [],
            config: CONFIG,
        });
        assert.equal(result.impact_status, 'no_observation');
        assert.equal(result.vitality, null);
    });

    it('窗口上限：statDate 超过 windowMaxDays 时 window_end 截断', () => {
        const result = computeVitality({
            baseline: baseline(),
            statDate: '2026-11-30',
            industryIndex: INDEX,
            boardPct: new Map(),
            benchmarkPct: new Map([['2026-10-02', 0.5]]),
            peerEvents: [],
            config: CONFIG,
        });
        assert.equal(result.window_end, '2026-11-15'); // 10-01 + 45
    });
});

describe('buildBoardPct / 日期工具', () => {
    it('由 OHLC 相邻收盘算涨跌幅（首日无前收 → 不计）', () => {
        const pct = buildBoardPct({
            dates: ['2026-10-01', '2026-10-02', '2026-10-03'],
            ohlc: [
                [10, 100, 9, 11],
                [100, 110, 99, 111],
                [110, 99, 98, 111],
            ],
        });
        assert.equal(pct.size, 2);
        assert.equal(Math.round(pct.get('2026-10-02')! * 100) / 100, 10);
        assert.equal(Math.round(pct.get('2026-10-03')! * 100) / 100, -10);
    });

    it('shiftDate / diffDays', () => {
        assert.equal(shiftDate('2026-10-01', 45), '2026-11-15');
        assert.equal(shiftDate('2026-10-01', -1), '2026-09-30');
        assert.equal(diffDays('2026-10-01', '2026-10-05'), 4);
    });
});

describe('snapshotBaselineForEvent：落库即冻结 chain 快照（根治 7 天 TTL）', () => {
    /** 记录 mock 收到的 (sql, params)，按需返回行。 */
    function stubQuery(handler: (sql: string, params?: unknown[]) => { rows: unknown[]; rowCount?: number }) {
        const calls: Array<{ sql: string; params?: unknown[] }> = [];
        mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
            calls.push({ sql, params });
            return handler(sql, params);
        });
        return calls;
    }

    it('eventId 为空 → false，不触库', async () => {
        const calls = stubQuery(() => ({ rows: [] }));
        try {
            assert.equal(await snapshotBaselineForEvent({ eventId: '', chain: [{ industry: '影视院线' }] }), false);
            assert.equal(calls.length, 0);
        } finally {
            mock.restoreAll();
        }
    });

    it('chain 为空 → false，不触库（无行业可观测，不占窗口行）', async () => {
        const calls = stubQuery(() => ({ rows: [] }));
        try {
            assert.equal(await snapshotBaselineForEvent({ eventId: 'E1', chain: [], eventDate: '2026-10-01' }), false);
            assert.equal(calls.length, 0);
        } finally {
            mock.restoreAll();
        }
    });

    it('显式 eventDate → INSERT ON CONFLICT DO NOTHING，rowCount>0 返回 true，chain 截断 Top3', async () => {
        const calls = stubQuery((sql) => {
            assert.match(sql, /INSERT INTO event_impact_vitality_baseline/);
            assert.match(sql, /ON CONFLICT \(event_id\) DO NOTHING/);
            return { rows: [], rowCount: 1 };
        });
        try {
            const chain = [
                { industry: 'A', impactStrength: 0.5 },
                { industry: 'B', impactStrength: 0.9 },
                { industry: 'C', impactStrength: 0.7 },
                { industry: 'D', impactStrength: 0.1 },
            ];
            const ok = await snapshotBaselineForEvent({ eventId: 'E1', eventType: 'policy', chain, eventDate: '2026-10-01' });
            assert.equal(ok, true);
            assert.equal(calls.length, 1);
            const params = calls[0].params as unknown[];
            assert.equal(params[0], 'E1');
            assert.equal(params[1], 'policy');
            assert.equal(params[2], '2026-10-01');
            // Top3：B(0.9) / C(0.7) / A(0.5)，D 被截断
            assert.deepEqual((JSON.parse(String(params[3])) as Array<{ industry: string }>).map((n) => n.industry), ['B', 'C', 'A']);
        } finally {
            mock.restoreAll();
        }
    });

    it('eventDate 缺省 → 读 event_entities.event_start_time 取事件日', async () => {
        const calls = stubQuery((sql) => {
            if (/FROM event_entities/.test(sql)) return { rows: [{ d: '2026-10-03' }] };
            return { rows: [], rowCount: 1 };
        });
        try {
            const ok = await snapshotBaselineForEvent({ eventId: 'E1', chain: [{ industry: '影视院线' }] });
            assert.equal(ok, true);
            assert.equal(calls.length, 2);
            assert.match(calls[0].sql, /event_start_time/);
            assert.equal((calls[1].params as unknown[])[2], '2026-10-03');
        } finally {
            mock.restoreAll();
        }
    });

    it('event_entities 无事件日 → 用 fallbackDate 兜底', async () => {
        const calls = stubQuery((sql) => {
            if (/FROM event_entities/.test(sql)) return { rows: [] };
            return { rows: [], rowCount: 1 };
        });
        try {
            const ok = await snapshotBaselineForEvent({
                eventId: 'E1',
                chain: [{ industry: '影视院线' }],
                fallbackDate: '2026-10-07',
            });
            assert.equal(ok, true);
            assert.equal((calls[1].params as unknown[])[2], '2026-10-07');
        } finally {
            mock.restoreAll();
        }
    });

    it('两值皆无（无事件日）→ false，不写库', async () => {
        const calls = stubQuery(() => ({ rows: [] }));
        try {
            assert.equal(await snapshotBaselineForEvent({ eventId: 'E1', chain: [{ industry: '影视院线' }] }), false);
            // 仅一次 event_entities 查询，无 INSERT
            assert.equal(calls.length, 1);
        } finally {
            mock.restoreAll();
        }
    });
});

describe('getLatestVitality / getLatestVitalityByEventIds：列表/详情 annotation 取数', () => {
    it('getLatestVitality：无行 → null', async () => {
        mock.method(pool, 'query', async () => ({ rows: [] }));
        try {
            assert.equal(await getLatestVitality('E1'), null);
        } finally {
            mock.restoreAll();
        }
    });

    it('getLatestVitality：命中行 → { score, status, statDate }', async () => {
        mock.method(pool, 'query', async () => ({
            rows: [{ vitality: '0.742', impact_status: 'alive', stat_date: '2026-10-15' }],
        }));
        try {
            assert.deepEqual(await getLatestVitality('E1'), { score: 0.742, status: 'alive', statDate: '2026-10-15' });
        } finally {
            mock.restoreAll();
        }
    });

    it('getLatestVitality：no_observation（vitality 为 null）→ score=null，status 保留', async () => {
        mock.method(pool, 'query', async () => ({
            rows: [{ vitality: null, impact_status: 'no_observation', stat_date: '2026-10-15' }],
        }));
        try {
            assert.deepEqual(await getLatestVitality('E1'), { score: null, status: 'no_observation', statDate: '2026-10-15' });
        } finally {
            mock.restoreAll();
        }
    });

    it('getLatestVitalityByEventIds：空数组 → 空 Map，不触库', async () => {
        const calls: string[] = [];
        mock.method(pool, 'query', async (sql: string) => {
            calls.push(sql);
            return { rows: [] };
        });
        try {
            const map = await getLatestVitalityByEventIds(['', '']);
            assert.equal(map.size, 0);
            assert.equal(calls.length, 0);
        } finally {
            mock.restoreAll();
        }
    });

    it('getLatestVitalityByEventIds：IN ($1,$2,...) 标量占位符（避免 42P18）并映射为 Map', async () => {
        let capturedSql = '';
        let capturedParams: unknown[] = [];
        mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
            capturedSql = sql;
            capturedParams = params ?? [];
            return {
                rows: [
                    { event_id: 'E1', vitality: '0.8', impact_status: 'alive', stat_date: '2026-10-15' },
                    { event_id: 'E2', vitality: null, impact_status: 'no_observation', stat_date: '2026-10-15' },
                ],
            };
        });
        try {
            const map = await getLatestVitalityByEventIds(['E1', 'E2']);
            assert.match(capturedSql, /event_id IN \(\$1, \$2\)/);
            assert.deepEqual(capturedParams, ['E1', 'E2']);
            assert.equal(map.size, 2);
            assert.deepEqual(map.get('E1'), { score: 0.8, status: 'alive', statDate: '2026-10-15' });
            assert.deepEqual(map.get('E2'), { score: null, status: 'no_observation', statDate: '2026-10-15' });
        } finally {
            mock.restoreAll();
        }
    });
});
