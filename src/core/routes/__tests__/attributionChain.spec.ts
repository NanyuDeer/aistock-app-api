/**
 * Attribution Chain Router — POST /api/internal/attribution-chain（upsert 保存）
 * + GET /api/agent/attribution-chain/:date（读取）测试（2026-09-03 P1 chain-attribution Task 4）。
 *
 * 用例（brief 契约）：
 * 1. POST 无效载荷（缺 date / root.type 非 market / children 非数组）→ 400 且不触达 DB
 * 2. POST 有效 → {ok:true}；GET 同 date 读回 chain 内容一致
 * 3. POST 同 date 二次（不同 content）→ 覆盖更新
 * 4. GET 无该 date → {date, chain:null}（200，不报错）
 * 5. POST 无/错 X-Internal-Token → 401 且不触达 DB（Task4 审查 Important 补鉴权）
 * 6. GET :date 非 YYYY-MM-DD → 400 且不触达 DB（Task4 审查顺带 date 防御）
 * 7. POST date 非 YYYY-MM-DD（"foo"）→ 400 且不触达 DB（Phase 0.4：与 GET 同款 DATE_RE）
 * 8. POST children 子项非法（sector 空/缺失、relation 越界、pct 为字符串）→ 400 且不触达 DB，
 *    错误文案含下标（Phase 0.4：原先 children 零校验）
 * 9. POST 落库 SQL 不再内联建表（Phase 0.4：attribution_chains 转 020 migration 管理，
 *    每次 POST 仅 1 条 INSERT ... ON CONFLICT）
 *
 * Mock strategy（沿仓库既有惯例，见 internal_user_profile.spec.ts / event_conduction.spec.ts）：
 * monkey-patch pool.query（router 持有同一 pool 对象引用），不建立真实 DB 连接；
 * mockResponder 用内存 Map<date, content> 模拟 attribution_chains 表两分支
 * （INSERT ... ON CONFLICT upsert / SELECT content），使 POST→GET 读回一致性与
 * 覆盖更新可端到端断言（建表由 020 migration 负责，不在本路由 SQL 序列内）。
 */
import { describe, it, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'http';
import type { AddressInfo } from 'net';
import express, { type Express } from 'express';
import pool from '../../db';
import { attributionChainRouter } from '../attributionChainRouter';

interface MockCall {
    sql: string;
    params: unknown[];
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const originalQuery = pool.query.bind(pool) as any;
let mockCalls: MockCall[] = [];
// 内存 DB 模拟：date → content（模拟 attribution_chains 表 upsert 语义）
const store = new Map<string, unknown>();

(pool as any).query = function (sql: string, ...rest: unknown[]): Promise<{ rows: unknown[] }> {
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest;
    mockCalls.push({ sql, params });
    if (/INSERT INTO attribution_chains/i.test(sql)) {
        store.set(String(params[0]), JSON.parse(String(params[1])));
        return Promise.resolve({ rows: [] });
    }
    if (/SELECT content FROM attribution_chains/i.test(sql)) {
        const content = store.get(String(params[0]));
        return Promise.resolve({ rows: content === undefined ? [] : [{ content }] });
    }
    return Promise.resolve({ rows: [] });
};
/* eslint-enable @typescript-eslint/no-explicit-any */

const JSON_HEADERS = { 'content-type': 'application/json' };
// 对齐仓库路由测试惯例（internal_user_profile.spec.ts 等）：token 不另设 env，
// 直接取 env 或与路由同款兜底值（'change-me-in-production'）——路由与测试同进程读取即匹配。
const INTERNAL_TOKEN =
    process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';
const POST_HEADERS = { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN };

const DATE = '2026-09-03';

// 链结构契约：{date, chain:{date, root:{type:"market",...}, children:[...]}}
// children[].relation 取值域对齐 agent-py judge_sector_driver_relation：
// self_driven | market_follow | unknown；pct 为 number | null。
const CHAIN_V1 = {
    date: DATE,
    chain: {
        date: DATE,
        root: { type: 'market', date: DATE, summary: '放量普涨', index_pct: 1.25 },
        children: [
            { sector: '半导体', relation: 'self_driven', pct: 3.2, trace_summary: 'AI 算力催化领涨' },
            { sector: '证券', relation: 'market_follow', pct: 1.8, trace_summary: '情绪扩散' },
        ],
    },
};

const CHAIN_V2 = {
    date: DATE,
    chain: {
        date: DATE,
        root: { type: 'market', date: DATE, summary: '缩量回调', index_pct: -0.85 },
        children: [
            { sector: '银行', relation: 'market_follow', pct: 0.6, trace_summary: '避险资金流入' },
        ],
    },
};

/** 以指定 children 覆盖构造合法外壳（date/root 均合法），便于聚焦 children 子项校验 */
function chainWith(children: unknown): unknown {
    return { date: DATE, chain: { date: DATE, root: { type: 'market', date: DATE }, children } };
}

function buildApp(): Express {
    const app = express();
    app.use(express.json());
    app.use('/api', attributionChainRouter);
    return app;
}

interface CallResult {
    status: number;
    json: unknown;
}

function call(
    app: Express,
    opts: { method: string; path: string; headers?: http.OutgoingHttpHeaders; body?: unknown },
): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo;
            const req = http.request(
                {
                    method: opts.method,
                    hostname: '127.0.0.1',
                    port: addr.port,
                    path: opts.path,
                    headers: opts.headers,
                },
                (res) => {
                    const chunks: Buffer[] = [];
                    res.on('data', (c: Buffer) => chunks.push(c));
                    res.on('end', () => {
                        server.close();
                        const text = Buffer.concat(chunks).toString('utf8');
                        let json: unknown = null;
                        try {
                            json = JSON.parse(text);
                        } catch {
                            /* 非 JSON */
                        }
                        resolve({ status: res.statusCode ?? 0, json });
                    });
                    res.on('error', (err) => {
                        server.close();
                        reject(err);
                    });
                },
            );
            req.on('error', (err) => {
                server.close();
                reject(err);
            });
            if (opts.body !== undefined) {
                req.write(typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
            }
            req.end();
        });
        server.on('error', reject);
    });
}

beforeEach(() => {
    mockCalls = [];
    store.clear();
});

after(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    (pool as any).query = originalQuery;
    /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe('POST /api/internal/attribution-chain', () => {
    it('无 X-Internal-Token → 401，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: JSON_HEADERS,
            body: CHAIN_V1,
        });
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(res.json, { error: 'invalid internal token' });
        assert.strictEqual(mockCalls.length, 0, '未鉴权请求应在落库前拦截');
    });

    it('错误 X-Internal-Token → 401，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: { 'content-type': 'application/json', 'x-internal-token': 'wrong-token' },
            body: CHAIN_V1,
        });
        assert.strictEqual(res.status, 401);
        assert.deepStrictEqual(res.json, { error: 'invalid internal token' });
        assert.strictEqual(mockCalls.length, 0, '错误 token 请求应在落库前拦截');
    });

    it('缺 date → 400，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: { chain: CHAIN_V1.chain },
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(mockCalls.length, 0, '无效载荷应在落库前拦截');
    });

    it('root.type 非 market → 400，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: {
                date: DATE,
                chain: { date: DATE, root: { type: 'sector', date: DATE }, children: [] },
            },
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(mockCalls.length, 0, '无效载荷应在落库前拦截');
    });

    it('children 非数组 → 400，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: {
                date: DATE,
                chain: { date: DATE, root: { type: 'market', date: DATE }, children: 'not-array' },
            },
        });
        assert.strictEqual(res.status, 400);
        assert.strictEqual(mockCalls.length, 0, '无效载荷应在落库前拦截');
    });

    it('date 非 YYYY-MM-DD → 400（对齐 GET 侧 DATE_RE），且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: { date: 'foo', chain: CHAIN_V1.chain },
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, { error: 'invalid date format: foo（需要 YYYY-MM-DD）' });
        assert.strictEqual(mockCalls.length, 0, '非法 date 应在落库前拦截');
    });

    it('children[0].sector 为空串 → 400（错误含下标），且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: chainWith([{ sector: '  ', relation: 'self_driven', pct: 1.0 }]),
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, { error: 'children[0].sector must be a non-empty string' });
        assert.strictEqual(mockCalls.length, 0, '非法 children 应在落库前拦截');
    });

    it('children[0].sector 缺失 → 400（错误含下标），且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: chainWith([{ relation: 'self_driven', pct: 1.0 }]),
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, { error: 'children[0].sector must be a non-empty string' });
        assert.strictEqual(mockCalls.length, 0, '非法 children 应在落库前拦截');
    });

    it('children[0].relation 越界（非 self_driven/market_follow/unknown）→ 400，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: chainWith([{ sector: '半导体', relation: '主因', pct: 1.0 }]),
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, {
            error: 'children[0].relation must be one of self_driven|market_follow|unknown',
        });
        assert.strictEqual(mockCalls.length, 0, '非法 children 应在落库前拦截');
    });

    it('children[0].pct 为字符串 → 400（非 number|null），且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: chainWith([{ sector: '半导体', relation: 'self_driven', pct: '3.2' }]),
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, { error: 'children[0].pct must be a number or null' });
        assert.strictEqual(mockCalls.length, 0, '非法 children 应在落库前拦截');
    });

    it('children[0].pct 缺失（undefined）→ 400，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: chainWith([{ sector: '半导体', relation: 'self_driven' }]),
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, { error: 'children[0].pct must be a number or null' });
        assert.strictEqual(mockCalls.length, 0, '非法 children 应在落库前拦截');
    });

    it('children[1] 非法 → 错误下标为 1（定位到具体子项），且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: chainWith([
                { sector: '半导体', relation: 'self_driven', pct: 3.2 },
                { sector: '证券', relation: '联动', pct: 1.8 },
            ]),
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, {
            error: 'children[1].relation must be one of self_driven|market_follow|unknown',
        });
        assert.strictEqual(mockCalls.length, 0, '非法 children 应在落库前拦截');
    });

    it('children[].pct 为 null 且 relation 为 unknown → 200（合法边界）', async () => {
        const res = await call(buildApp(), {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: chainWith([{ sector: '银行', relation: 'unknown', pct: null }]),
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.json, { ok: true });
        assert.strictEqual(mockCalls.length, 1);
    });

    it('有效载荷 → {ok:true}，GET 同 date 读回 chain 内容一致', async () => {
        const app = buildApp();
        const postRes = await call(app, {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: CHAIN_V1,
        });
        assert.strictEqual(postRes.status, 200);
        assert.deepStrictEqual(postRes.json, { ok: true });

        // 落库 SQL 序列：仅 INSERT ... ON CONFLICT upsert（建表由 020 migration 负责）
        assert.strictEqual(mockCalls.length, 1);
        assert.match(mockCalls[0].sql, /INSERT INTO attribution_chains[\s\S]*ON CONFLICT/);
        assert.deepStrictEqual(mockCalls[0].params, [DATE, JSON.stringify(CHAIN_V1.chain)]);
        assert.ok(
            !/CREATE TABLE/i.test(mockCalls.map((c) => c.sql).join('\n')),
            '路由不得内联建表（attribution_chains 由 020 migration 管理）',
        );

        const getRes = await call(app, {
            method: 'GET',
            path: `/api/agent/attribution-chain/${DATE}`,
        });
        assert.strictEqual(getRes.status, 200);
        assert.deepStrictEqual(getRes.json, { date: DATE, chain: CHAIN_V1.chain });
    });

    it('同 date 二次 POST（不同 content）→ 覆盖更新，GET 读回最新', async () => {
        const app = buildApp();
        await call(app, {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: CHAIN_V1,
        });
        const post2 = await call(app, {
            method: 'POST',
            path: '/api/internal/attribution-chain',
            headers: POST_HEADERS,
            body: CHAIN_V2,
        });
        assert.strictEqual(post2.status, 200);

        const getRes = await call(app, {
            method: 'GET',
            path: `/api/agent/attribution-chain/${DATE}`,
        });
        assert.strictEqual(getRes.status, 200);
        assert.deepStrictEqual(getRes.json, { date: DATE, chain: CHAIN_V2.chain });
    });
});

describe('GET /api/agent/attribution-chain/:date', () => {
    it('date 非 YYYY-MM-DD → 400，且不触达 DB', async () => {
        const res = await call(buildApp(), {
            method: 'GET',
            path: '/api/agent/attribution-chain/2026-09-3',
        });
        assert.strictEqual(res.status, 400);
        assert.deepStrictEqual(res.json, { error: 'invalid date format: 2026-09-3（需要 YYYY-MM-DD）' });
        assert.strictEqual(mockCalls.length, 0, '非法 date 应在查询前拦截');
    });

    it('无该 date → 200 + {date, chain:null}（降级，不报错）', async () => {
        const res = await call(buildApp(), {
            method: 'GET',
            path: `/api/agent/attribution-chain/${DATE}`,
        });
        assert.strictEqual(res.status, 200);
        assert.deepStrictEqual(res.json, { date: DATE, chain: null });
    });
});
