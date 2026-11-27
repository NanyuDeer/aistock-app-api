import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    MAX_RARITY_STALENESS_DAYS,
    loadStateRarity,
    stalenessDays,
} from '../stateRarity';

type Row = Record<string, unknown>;

function fakeQuery(rows: Row[]): {
    (sql: string, params: unknown[]): Promise<{ rows: Row[] }>;
    calls: Array<{ sql: string; params: unknown[] }>;
} {
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    const fn = (sql: string, params: unknown[]): Promise<{ rows: Row[] }> => {
        calls.push({ sql, params });
        return Promise.resolve({ rows });
    };
    return Object.assign(fn, { calls });
}

const row = (asOf: string): Row => ({
    as_of: asOf,
    breadth_rank: 0.998,
    decline_rank: 0.71,
    style_rank: 0.42,
    limit_rank: 0.998,
    window_days: 750,
});

test('stalenessDays 按自然日算差', () => {
    assert.equal(stalenessDays('2026-11-27', '2026-11-27'), 0);
    assert.equal(stalenessDays('2026-11-25', '2026-11-27'), 2);
    assert.equal(stalenessDays('2026-10-31', '2026-11-02'), 2);
});

test('当日有分位：原样返回，as_of = 当日', async () => {
    const q = fakeQuery([row('2026-11-27')]);
    const fact = await loadStateRarity('2026-11-27', q);
    assert.ok(fact);
    assert.equal(fact.as_of, '2026-11-27');
    assert.equal(fact.breadth_rank, 0.998);
    assert.equal(fact.window_days, 750);
    assert.deepEqual(q.calls[0].params, ['2026-11-27']);
});

test('当日缺失：回退到最近一行，并保留真实 as_of', async () => {
    // 快照 15:35 构建时，当日 state_rarity 还没算出来（日链 18:20），只能拿上一交易日
    const q = fakeQuery([row('2026-11-26')]);
    const fact = await loadStateRarity('2026-11-27', q);
    assert.ok(fact);
    assert.equal(fact.as_of, '2026-11-26');
});

test('完全没有分位：返回 null', async () => {
    const fact = await loadStateRarity('2015-01-05', fakeQuery([]));
    assert.equal(fact, null);
});

test('分位过旧：按缺失处理，不给陈旧值', async () => {
    const asOf = '2026-11-10';
    const date = '2026-11-27';
    assert.ok(stalenessDays(asOf, date) > MAX_RARITY_STALENESS_DAYS);
    const fact = await loadStateRarity(date, fakeQuery([row(asOf)]));
    assert.equal(fact, null);
});
