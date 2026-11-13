/**
 * 行业级业绩预告聚合单测（注入 DB，不连库）。
 * 运行：node --import tsx --test src/modules/causal/__tests__/earningsGuidanceService.spec.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    queryIndustryGuidance,
    type IndustryGuidanceDeps,
} from '../earningsGuidanceService';

function makeDeps(rows: Record<string, unknown>[]): {
    deps: IndustryGuidanceDeps;
    calls: Array<{ sql: string; params: unknown[] }>;
} {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const deps: IndustryGuidanceDeps = {
        query: async (sql, params) => {
            calls.push({ sql, params });
            return { rows };
        },
    };
    return { deps, calls };
}

describe('queryIndustryGuidance', () => {
    it('把 pg 返回的字符串数值转成数字并保留两位小数', async () => {
        // pg 的 percentile_cont 返回 string，count 也可能是 string
        const { deps } = makeDeps([
            { industry: '半导体', median_yoy: '45.2345', sample: '38' },
            { industry: '光伏设备', median_yoy: '-12.5', sample: '21' },
        ]);

        const result = await queryIndustryGuidance(deps);

        assert.deepEqual(result['半导体'], { medianYoy: 45.23, sample: 38 });
        assert.deepEqual(result['光伏设备'], { medianYoy: -12.5, sample: 21 });
    });

    it('空结果返回空对象，不是 null', async () => {
        const { deps } = makeDeps([]);
        assert.deepEqual(await queryIndustryGuidance(deps), {});
    });

    it('中位数非法时跳过该行业，不写成 0', async () => {
        const { deps } = makeDeps([
            { industry: '坏数据', median_yoy: null, sample: '10' },
            { industry: '正常', median_yoy: '30.0', sample: '8' },
        ]);

        const result = await queryIndustryGuidance(deps);

        assert.equal(result['坏数据'], undefined);
        assert.deepEqual(result['正常'], { medianYoy: 30, sample: 8 });
    });

    it('样本数非法时跳过', async () => {
        const { deps } = makeDeps([{ industry: '异常', median_yoy: '20.0', sample: 'abc' }]);
        assert.deepEqual(await queryIndustryGuidance(deps), {});
    });

    it('样本门槛由 SQL 参数传入，不硬编码在转换层', async () => {
        const { deps, calls } = makeDeps([]);
        await queryIndustryGuidance(deps);

        assert.equal(calls.length, 1);
        assert.match(calls[0].sql, /HAVING count\(\*\) >= \$1/);
        assert.deepEqual(calls[0].params, [5]);
    });

    it('SQL 里排除空行业与空同比，避免无意义分组', async () => {
        const { deps, calls } = makeDeps([]);
        await queryIndustryGuidance(deps);

        assert.match(calls[0].sql, /forecast_netprofit_yoy IS NOT NULL/);
        assert.match(calls[0].sql, /industry IS NOT NULL/);
        assert.match(calls[0].sql, /industry <> ''/);
    });
});
