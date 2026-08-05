/**
 * InsightPushService 单元测试（pushCreated：命中用户 + 三通道 + push_records 去重）
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
import { pushCreated } from '../InsightPushService';

afterEach(() => {
    mock.restoreAll();
    getAllClients().clear();
});

const EVENT_ID = 'wi_20260805_000962_limit_up';

/** 构造 pool.query mock：命中查询 + push_records 判重结果，记录实际执行的 SQL */
function buildQueryMock(opts: {
    users: Array<Record<string, unknown>>;
    insertReturning: boolean;
}): { executed: string[] } {
    const executed: string[] = [];
    const mockQuery = (async (text: string) => {
        executed.push(text);
        if (text.includes('FROM watchlist_insight_events e')) {
            return { rows: opts.users };
        }
        if (text.includes('INSERT INTO watchlist_insight_push_records')) {
            return { rows: opts.insertReturning ? [{ id: 1 }] : [] };
        }
        return { rows: [] };
    }) as unknown as typeof pool.query;
    mock.method(pool, 'query', mockQuery);
    return { executed };
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
        const { executed } = buildQueryMock({
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
        assert.ok(executed[0].includes("r.analysis_version = 'watchlist-insight-v1'"));
        assert.ok(executed[0].includes("s.setting_type = 'watchlist_insight_push'"));
        assert.ok(executed[0].includes('(s.enabled IS NULL OR s.enabled != 0)'));
        // 飞书通道解析契约：命中查询必须从 user_subscriptions 取 feishu_open_id（仅非空绑定）
        assert.ok(executed[0].includes('LEFT JOIN user_subscriptions fs'));
        assert.ok(executed[0].includes('fs.feishu_open_id'));
        assert.ok(executed[0].includes("fs.status = 'subscribed'"));
        // push_records 插入走 UNIQUE 冲突 DO NOTHING（016 契约）
        const insertSqls = executed.filter(t => t.includes('INSERT INTO watchlist_insight_push_records'));
        assert.equal(insertSqls.length, 2, '微信 + 飞书各一次判重插入');
        assert.ok(insertSqls.every(t => t.includes('ON CONFLICT (event_id, openid, push_kind, channel) DO NOTHING')));
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
        const { executed } = buildQueryMock({ users: [], insertReturning: true });

        let sendCalls = 0;
        mock.method(WechatPushService, 'dispatchInsightPush',
            (async () => { sendCalls++; return true; }) as unknown as typeof WechatPushService.dispatchInsightPush);

        const sent = await pushCreated(EVENT_ID);

        assert.equal(sent, 0);
        assert.equal(sendCalls, 0);
        assert.equal(executed.length, 1, '仅执行命中查询，无判重插入');
    });
});
