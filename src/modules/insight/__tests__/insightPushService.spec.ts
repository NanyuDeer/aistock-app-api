/**
 * InsightPushService 单元测试（pushCreated / pushUpdated / isSubstantiveChange）
 *
 * 仓库惯例：Node 内建 test runner（node:test）+ .spec.ts 命名 + __tests__ 目录。
 * mock 方式与 insightService.spec.ts 一致：mock pool.query / 推送类静态方法。
 * 注意：tsx 的 CJS 互操作把模块级导出编译成命名空间上的 getter（不可配置），
 *   Node 24 mock.method 无法补丁此类导出，故 WS 通道不 mock，而是通过真实的
 *   registerClient 注册假 WS 客户端，让 pushAlertToUser 走真实链路并断言真实报文。
 *
 * 运行：`node --import tsx --test src/modules/insight/__tests__/insightPushService.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { WebSocket } from 'ws';
import pool from '../../../core/db';
import { registerClient, getAllClients } from '../../../core/ws/channels/quote-channel';
import { WechatPushService } from '../../push/WechatPushService';
import { MessagePushService } from '../../push/MessagePushService';
import { pushCreated, pushUpdated, isSubstantiveChange } from '../InsightPushService';

afterEach(() => {
    mock.restoreAll();
    getAllClients().clear();
});

const EVENT_ID = 'wi_20260805_000962_limit_up';

interface QueryCall {
    text: string;
    params: unknown[];
}
/** 构造 pool.query mock：命中查询 + push_records 判重结果，记录实际执行的 SQL 及参数 */
function buildQueryMock(opts: {
    users: Array<Record<string, unknown>>;
    insertReturning: boolean;
}): { calls: QueryCall[] } {
    const calls: QueryCall[] = [];
    const mockQuery = (async (text: string, params?: unknown[]) => {
        calls.push({ text, params: params ?? [] });
        if (text.includes('FROM watchlist_insight_events e')) {
            return { rows: opts.users };
        }
        if (text.includes('INSERT INTO watchlist_insight_push_records')) {
            return { rows: opts.insertReturning ? [{ id: 1 }] : [] };
        }
        return { rows: [] };
    }) as unknown as typeof pool.query;
    mock.method(pool, 'query', mockQuery);
    return { calls };
}

/** 注册假 WS 客户端，返回 send 捕获（真实 pushAlertToUser 链路） */
function registerFakeWsClient(openid: string): { sends: string[] } {
    const sends: string[] = [];
    const fakeWs = {
        readyState: 1,
        OPEN: 1,
        send(payload: string): void {
            sends.push(payload);
        },
    } as unknown as WebSocket;
    registerClient(fakeWs, { userId: openid, subscribedSymbols: new Set() });
    return { sends };
}

/** 装配微信/飞书发送 mock，返回捕获的调用参数 */
function mockSendChannels() {
    const wxArgs: Array<[string, string, string]> = [];
    const feishuArgs: Array<[string, string, string]> = [];
    mock.method(WechatPushService, 'dispatchInsightPush',
        (async (openid: string, content: string, eventId: string) => {
            wxArgs.push([openid, content, eventId]);
            return true;
        }) as unknown as typeof WechatPushService.dispatchInsightPush);
    mock.method(MessagePushService, 'dispatchInsightToFeishu',
        (async (openid: string, content: string, eventId: string) => {
            feishuArgs.push([openid, content, eventId]);
            return true;
        }) as unknown as typeof MessagePushService.dispatchInsightToFeishu);
    return { wxArgs, feishuArgs };
}

describe('pushCreated', () => {
    it('命中用户时走 WS + 微信 + 飞书三通道并返回 sent 数', async () => {
        const { calls } = buildQueryMock({
            users: [{
                openid: 'openid_1',
                symbol: '000962',
                stock_name: '东方钽业',
                primary_driver: { label: '涨停板', category: '资金' },
                attribution_status: 'confirmed',
                confidence: 'high',
                feishu_open_id: 'feishu_open_id_1',
            }],
            insertReturning: true,
        });

        const { sends } = registerFakeWsClient('openid_1');
        const { wxArgs, feishuArgs } = mockSendChannels();

        const sent = await pushCreated(EVENT_ID);

        assert.equal(sent, 1);
        // WS 定向推送：真实 pushAlertToUser 链路产出的 wire 报文
        assert.equal(sends.length, 1);
        const wsPayload = JSON.parse(sends[0]) as { type: string; data: unknown };
        assert.deepStrictEqual(wsPayload, {
            type: 'alert',
            data: {
                type: 'insight.created',
                eventId: EVENT_ID,
                content: '【自选股洞察】东方钽业(000962) 涨停板 · 置信度 high',
                symbol: '000962',
            },
        });
        // 微信/飞书发送入参一致（飞书目标为 feishu_open_id 而非微信 openid）
        const expectedContent = '【自选股洞察】东方钽业(000962) 涨停板 · 置信度 high';
        assert.deepStrictEqual(wxArgs[0], ['openid_1', expectedContent, EVENT_ID]);
        assert.deepStrictEqual(feishuArgs[0], ['feishu_open_id_1', expectedContent, EVENT_ID], '飞书通道收到 feishu_open_id 而非微信 openid');
        // 命中查询 SQL 契约：过滤 watchlist_insight_push 开关（默认开启）+ 归因版本
        assert.ok(calls[0].text.includes("r.analysis_version = 'watchlist-insight-v1'"));
        assert.ok(calls[0].text.includes("s.setting_type = 'watchlist_insight_push'"));
        assert.ok(calls[0].text.includes('(s.enabled IS NULL OR s.enabled != 0)'));
        // 飞书通道解析契约：命中查询必须从 user_subscriptions 取 feishu_open_id（仅非空绑定）
        assert.ok(calls[0].text.includes('LEFT JOIN user_subscriptions fs'));
        assert.ok(calls[0].text.includes('fs.feishu_open_id'));
        assert.ok(calls[0].text.includes("fs.status = 'subscribed'"));
        // push_records 插入走 UNIQUE 冲突 DO NOTHING（016 契约）
        const insertCalls = calls.filter(c => c.text.includes('INSERT INTO watchlist_insight_push_records'));
        assert.equal(insertCalls.length, 2, '微信 + 飞书各一次判重插入');
        assert.ok(insertCalls.every(c => c.text.includes('ON CONFLICT (event_id, openid, push_kind, channel) DO NOTHING')));
        // pushCreated 使用 push_kind='created'
        assert.ok(insertCalls.every(c => c.params[2] === 'created'), 'push_records 使用 push_kind=created');
    });

    it('无飞书绑定用户仅走 WS + 微信，跳过飞书通道', async () => {
        buildQueryMock({
            users: [{
                openid: 'openid_1',
                symbol: '000962',
                stock_name: '东方钽业',
                primary_driver: { label: '涨停板', category: '资金' },
                attribution_status: 'confirmed',
                confidence: 'high',
                feishu_open_id: null,
            }],
            insertReturning: true,
        });

        const { sends } = registerFakeWsClient('openid_1');
        const { wxArgs, feishuArgs } = mockSendChannels();

        const sent = await pushCreated(EVENT_ID);

        assert.equal(sent, 1, '微信/WS 成功即计 sent');
        assert.equal(sends.length, 1, 'WS 定向推送不受飞书绑定影响');
        assert.equal(wxArgs.length, 1, '微信照常发送');
        assert.deepStrictEqual(wxArgs[0], ['openid_1', '【自选股洞察】东方钽业(000962) 涨停板 · 置信度 high', EVENT_ID]);
        assert.equal(feishuArgs.length, 0, '未绑定飞书的用户不触发飞书推送');
    });

    it('push_records 已存在（DO NOTHING 无返回行）时跳过微信/飞书发送，WS 仍推送', async () => {
        buildQueryMock({
            users: [{
                openid: 'openid_1',
                symbol: '000962',
                stock_name: '东方钽业',
                primary_driver: null,
                attribution_status: 'unconfirmed',
                confidence: 'low',
                feishu_open_id: 'feishu_open_id_1',
            }],
            insertReturning: false,
        });

        const { sends } = registerFakeWsClient('openid_1');
        let wxCalls = 0;
        mock.method(WechatPushService, 'dispatchInsightPush',
            (async () => { wxCalls++; return true; }) as unknown as typeof WechatPushService.dispatchInsightPush);
        let feishuCalls = 0;
        mock.method(MessagePushService, 'dispatchInsightToFeishu',
            (async () => { feishuCalls++; return true; }) as unknown as typeof MessagePushService.dispatchInsightToFeishu);

        const sent = await pushCreated(EVENT_ID);

        assert.equal(sent, 0);
        assert.equal(sends.length, 1, 'WS 推送不走去重');
        assert.equal(wxCalls, 0, 'push_records 已存在则不再发微信');
        assert.equal(feishuCalls, 0, 'push_records 已存在则不再发飞书');
    });

    it('unconfirmed 归因时文案为主因待验证', async () => {
        buildQueryMock({
            users: [{
                openid: 'openid_1',
                symbol: '000962',
                stock_name: '东方钽业',
                primary_driver: null,
                attribution_status: 'unconfirmed',
                confidence: 'medium',
            }],
            insertReturning: true,
        });

        let wxContent = '';
        mock.method(WechatPushService, 'dispatchInsightPush',
            (async (_openid: string, content: string) => {
                wxContent = content;
                return true;
            }) as unknown as typeof WechatPushService.dispatchInsightPush);
        mock.method(MessagePushService, 'dispatchInsightToFeishu',
            (async () => true) as unknown as typeof MessagePushService.dispatchInsightToFeishu);

        await pushCreated(EVENT_ID);

        assert.equal(wxContent, '【自选股洞察】东方钽业(000962) 主因待验证 · 置信度 medium');
    });

    it('无命中用户时返回 0 且不触发任何发送', async () => {
        const { calls } = buildQueryMock({ users: [], insertReturning: true });

        let sendCalls = 0;
        mock.method(WechatPushService, 'dispatchInsightPush',
            (async () => { sendCalls++; return true; }) as unknown as typeof WechatPushService.dispatchInsightPush);

        const sent = await pushCreated(EVENT_ID);

        assert.equal(sent, 0);
        assert.equal(sendCalls, 0);
        assert.equal(calls.length, 1, '仅执行命中查询，无判重插入');
    });

    it('微信/飞书发送失败时删除 push_records 判重记录，允许下次触发重试', async () => {
        const { calls } = buildQueryMock({
            users: [{
                openid: 'openid_1',
                symbol: '000962',
                stock_name: '东方钽业',
                primary_driver: { label: '涨停板', category: '资金' },
                attribution_status: 'confirmed',
                confidence: 'high',
                feishu_open_id: 'feishu_open_id_1',
            }],
            insertReturning: true,
        });
        registerFakeWsClient('openid_1');
        mock.method(WechatPushService, 'dispatchInsightPush',
            (async () => false) as unknown as typeof WechatPushService.dispatchInsightPush);
        mock.method(MessagePushService, 'dispatchInsightToFeishu',
            (async () => false) as unknown as typeof MessagePushService.dispatchInsightToFeishu);

        const sent = await pushCreated(EVENT_ID);

        assert.equal(sent, 0, '微信/飞书均失败不计 sent');
        const deletes = calls.filter(c => c.text.includes('DELETE FROM watchlist_insight_push_records'));
        assert.equal(deletes.length, 2, '微信 + 飞书发送失败各删除一次判重记录');
        assert.ok(deletes.every(c => c.text.includes('WHERE id = $1')), '按插入返回的 id 精确删除');
    });
});

describe('pushUpdated', () => {
    it('命中用户时使用 push_kind=updated 发送三通道', async () => {
        const { calls } = buildQueryMock({
            users: [{
                openid: 'openid_1',
                symbol: '000962',
                stock_name: '东方钽业',
                primary_driver: { label: '涨停板', category: '资金' },
                attribution_status: 'confirmed',
                confidence: 'high',
                feishu_open_id: 'feishu_open_id_1',
            }],
            insertReturning: true,
        });

        registerFakeWsClient('openid_1');
        const { wxArgs, feishuArgs } = mockSendChannels();

        const sent = await pushUpdated(EVENT_ID);

        assert.equal(sent, 1, 'pushUpdated 应正常发送');
        // push_records 插入使用 push_kind='updated'
        const insertCalls = calls.filter(c => c.text.includes('INSERT INTO watchlist_insight_push_records'));
        assert.equal(insertCalls.length, 2, '微信 + 飞书各一次判重插入');
        assert.ok(insertCalls.every(c => c.params[2] === 'updated'), 'push_records 使用 push_kind=updated');
        // 微信/飞书发送入参内容与 pushCreated 一致
        const expectedContent = '【自选股洞察】东方钽业(000962) 涨停板 · 置信度 high';
        assert.deepStrictEqual(wxArgs[0], ['openid_1', expectedContent, EVENT_ID]);
        assert.deepStrictEqual(feishuArgs[0], ['feishu_open_id_1', expectedContent, EVENT_ID]);
    });

    it('无命中用户时返回 0', async () => {
        buildQueryMock({ users: [], insertReturning: true });
        const sent = await pushUpdated(EVENT_ID);
        assert.equal(sent, 0);
    });
});

describe('isSubstantiveChange', () => {
    it('无旧记录视为变化返回 true', async () => {
        mock.method(pool, 'query', (async () => ({ rows: [] })) as unknown as typeof pool.query);
        const result = await isSubstantiveChange(EVENT_ID, {
            attribution_status: 'confirmed', confidence: 'high', primary_driver: {},
        });
        assert.equal(result, true);
    });

    it('待验证→有主因（unconfirmed→confirmed）返回 true', async () => {
        mock.method(pool, 'query', (async () => ({
            rows: [{ attribution_status: 'unconfirmed', confidence: 'low', primary_driver: null }],
        })) as unknown as typeof pool.query);
        const result = await isSubstantiveChange(EVENT_ID, {
            attribution_status: 'confirmed', confidence: 'low', primary_driver: { label: '资金' },
        });
        assert.equal(result, true);
    });

    it('状态翻转（confirmed→unconfirmed）返回 true', async () => {
        mock.method(pool, 'query', (async () => ({
            rows: [{ attribution_status: 'confirmed', confidence: 'medium', primary_driver: { label: '资金' } }],
        })) as unknown as typeof pool.query);
        const result = await isSubstantiveChange(EVENT_ID, {
            attribution_status: 'unconfirmed', confidence: 'medium', primary_driver: { label: '资金' },
        });
        assert.equal(result, true);
    });

    it('主因标签变化返回 true', async () => {
        mock.method(pool, 'query', (async () => ({
            rows: [{ attribution_status: 'confirmed', confidence: 'medium', primary_driver: { label: '资金' } }],
        })) as unknown as typeof pool.query);
        const result = await isSubstantiveChange(EVENT_ID, {
            attribution_status: 'confirmed', confidence: 'medium', primary_driver: { label: '政策利好' },
        });
        assert.equal(result, true);
    });

    it('置信度升级（low→high）返回 true', async () => {
        mock.method(pool, 'query', (async () => ({
            rows: [{ attribution_status: 'confirmed', confidence: 'low', primary_driver: { label: '资金' } }],
        })) as unknown as typeof pool.query);
        const result = await isSubstantiveChange(EVENT_ID, {
            attribution_status: 'confirmed', confidence: 'high', primary_driver: { label: '资金' },
        });
        assert.equal(result, true);
    });

    it('置信度降级（high→medium）不视为变化返回 false', async () => {
        mock.method(pool, 'query', (async () => ({
            rows: [{ attribution_status: 'confirmed', confidence: 'high', primary_driver: { label: '资金' } }],
        })) as unknown as typeof pool.query);
        const result = await isSubstantiveChange(EVENT_ID, {
            attribution_status: 'confirmed', confidence: 'medium', primary_driver: { label: '资金' },
        });
        assert.equal(result, false);
    });

    it('完全相同（无变化）返回 false', async () => {
        mock.method(pool, 'query', (async () => ({
            rows: [{ attribution_status: 'confirmed', confidence: 'high', primary_driver: { label: '资金' } }],
        })) as unknown as typeof pool.query);
        const result = await isSubstantiveChange(EVENT_ID, {
            attribution_status: 'confirmed', confidence: 'high', primary_driver: { label: '资金' },
        });
        assert.equal(result, false);
    });
});
