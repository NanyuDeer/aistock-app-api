/**
 * 完整洞察报告 SSE 流式接口测试
 *
 * 覆盖：401（未登录）/ 404（无自选归属）/ 409（无完整归因）/ 200（成功流式返回章节 blocks）/ 502（agent-py 失败）
 * 另覆盖 `buildReportData` 的字段映射与 `getUserEvent` 的 trading_date 投影。
 *
 * 鉴权 mock 策略：用 signJwt 签发真实 token 替代 mock verifyJwt（避免 ESM 动态 import mock 在 tsx 下不可靠）。
 * 运行：`node --import tsx --test src/modules/stock-trace/__tests__/insightReport.spec.ts`
 */
import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { signJwt } from '../../../shared/utils/jwt';
import { StockTraceController } from '../controller';
import { StockTraceService } from '../StockTraceService';
import { StockTraceArtifactService } from '../StockTraceArtifactService';
import { StockTraceResultService } from '../StockTraceResultService';
import { InsightReportService } from '../InsightReportService';
import pool from '../../../core/db';

const JWT_SECRET = 'test-secret-insight-report';

function fakeRes() {
    const res = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        setHeader(k: string, v: string) { this.headers[k] = v; return this; },
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        send(payload: unknown) { this.body = payload; return this; },
    };
    return res;
}

function makeToken(): string {
    return signJwt({ id: 'u1', openid: 'o1' } as never, JWT_SECRET);
}

afterEach(() => {
    mock.restoreAll();
});

type ReportDataShape = { event: Record<string, unknown>; attribution: Record<string, unknown> };

describe('InsightReportService.buildReportData', () => {
    it('事件字段从 DB 行映射正确', () => {
        const event = {
            event_id: 'mv:003018:20260913:123456:up',
            symbol: '003018',
            stock_name: '某科技公司',
            trading_date: '2026-09-13',
            triggered_at: '2026-09-13T10:30:00Z',
            direction: 'up',
            change_pct: 9.5,
            threshold_pct: 7,
            severity: 'high',
            latest_price: 15.50,
            previous_close: 14.15,
            trigger_revision: 1,
        };
        const artifact = {
            artifactId: 'a1',
            artifactVersion: 1,
            artifactJson: { candidates: [], chains: [], evidence_index: [], unresolved_questions: [] },
            movementView: {
                confidenceLevel: 'high',
                generatedAt: '2026-09-13T11:00:00Z',
                primaryCandidate: { layer: 'sector', verdict: '液冷板块联动' },
            },
            createdAt: '2026-09-13',
        };
        const result = { primaryPhrase: '液冷服务器板块联动拉升' };
        const data = InsightReportService.buildReportData(
            event, artifact as never, result as never,
        ) as unknown as ReportDataShape;
        const evt = data.event;

        assert.equal(evt.eventId, 'mv:003018:20260913:123456:up');
        assert.equal(evt.symbol, '003018');
        assert.equal(evt.stockName, '某科技公司');
        // 页眉交易日（PDF 页眉「股票名（代码） · 交易日」依赖）
        assert.equal(evt.tradingDate, '2026-09-13');
        assert.equal(evt.triggeredAt, '2026-09-13T10:30:00Z');
        assert.equal(evt.direction, 'up');
        assert.equal(evt.changePct, 9.5);
        assert.equal(evt.thresholdPct, 7);
        assert.equal(evt.severity, 'high');
        assert.equal(evt.latestPrice, 15.50);
        assert.equal(evt.previousClose, 14.15);
        // attribution 字段也从有效输入正确映射
        assert.equal(data.attribution.primaryPhrase, '液冷服务器板块联动拉升');
        assert.equal(data.attribution.confidenceLevel, 'high');
        // 主因结论补「归类标签 + 归因生成时间」
        assert.equal(data.attribution.primaryLayer, 'sector');
        assert.equal(data.attribution.generatedAt, '2026-09-13T11:00:00Z');
    });

    it('artifactJson 缺失字段回落为空数组/null（非 undefined）', () => {
        const event = { event_id: 'mv:1', symbol: '003018', stock_name: 'test' };
        const artifact = {
            artifactId: 'a1',
            artifactVersion: 1,
            artifactJson: {},
            movementView: {},
            createdAt: '2026-09-13',
        };
        const data = InsightReportService.buildReportData(
            event, artifact as never, null,
        ) as unknown as ReportDataShape;

        assert.equal(data.attribution.primaryPhrase, null);
        assert.equal(data.attribution.confidenceLevel, null);
        assert.equal(data.attribution.primaryLayer, null);
        assert.equal(data.attribution.generatedAt, null);
        assert.deepEqual(data.attribution.candidates, []);
        assert.deepEqual(data.attribution.chains, []);
        assert.deepEqual(data.attribution.unresolvedQuestions, []);
        assert.deepEqual(data.attribution.evidenceIndex, []);
    });
});

/** SSE 响应桩：记录每次 write 的 chunk，供断言事件序列与"未缓冲" */
function fakeSseRes() {
    const chunks: string[] = [];
    const res = {
        statusCode: 200,
        headers: {} as Record<string, string>,
        body: undefined as unknown,
        headersSent: false,
        chunks,
        setHeader(k: string, v: string) { this.headers[k] = v; return this; },
        flushHeaders() { this.headersSent = true; },
        status(code: number) { this.statusCode = code; return this; },
        json(payload: unknown) { this.body = payload; return this; },
        write(chunk: string) { chunks.push(chunk); return true; },
        end() { /* noop */ },
    };
    return res;
}

/** 从 write chunk 中解析 data 事件（`data: {...}\n\n`） */
function sseEvents(res: { chunks: string[] }): Array<Record<string, unknown>> {
    return res.chunks
        .filter((c) => c.startsWith('data: '))
        .map((c) => JSON.parse(c.slice(6)) as Record<string, unknown>);
}

describe('GET /movements/:eventId/report/stream（流式报告）', () => {
    it('未登录 → 401 + JSON（未开流）', async () => {
        const res = fakeSseRes();
        await StockTraceController.reportStream(
            { headers: {}, params: { eventId: 'mv:1' } } as never,
            res as never,
        );
        assert.equal(res.statusCode, 401);
        assert.equal((res.body as { message: string }).message, '请先登录查看');
        assert.equal(res.chunks.length, 0, '前置失败不应写入任何 SSE chunk');
    });

    it('无自选归属 → 404 + JSON', async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        mock.method(StockTraceService, 'getUserEvent', async () => null);
        const res = fakeSseRes();
        const req = { headers: { authorization: `Bearer ${makeToken()}` }, params: { eventId: 'mv:1' } };
        await StockTraceController.reportStream(req as never, res as never);
        assert.equal(res.statusCode, 404);
        assert.equal(res.chunks.length, 0);
    });

    it('无有效归因 → 409 + JSON', async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        mock.method(StockTraceService, 'getUserEvent', async () => ({ event_id: 'mv:1', trigger_revision: 1 }) as Record<string, unknown>);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', async () => null);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifact', async () => null);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', async () => ({ validationStatus: 'rejected', processingStatus: 'partial' }));
        const res = fakeSseRes();
        const req = { headers: { authorization: `Bearer ${makeToken()}` }, params: { eventId: 'mv:1' } };
        await StockTraceController.reportStream(req as never, res as never);
        assert.equal(res.statusCode, 409);
        assert.equal((res.body as { message: string }).message, '该异动暂无完整归因');
        assert.equal(res.chunks.length, 0);
    });

    it('成功 → 开流后 start → section×N → done，且逐条 write（未缓冲）', async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        const artifact = {
            artifactId: 'a1', artifactVersion: 1,
            artifactJson: { candidates: [], chains: [], evidence_index: [] },
            movementView: { confidenceLevel: 'medium', generatedAt: '2026-09-13T11:00:00Z' },
            createdAt: '2026-09-13',
        };
        mock.method(StockTraceService, 'getUserEvent', async () => ({ event_id: 'mv:1', symbol: '003018', trigger_revision: 1, trading_date: '2026-09-13', triggered_at: '2026-09-13T01:34:07.932Z' }) as Record<string, unknown>);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', async () => artifact);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', async () => ({ primaryPhrase: '液冷服务器概念板块联动', validationStatus: 'passed', processingStatus: 'completed' }));
        mock.method(InsightReportService, 'fetchSections', async () => ({
            header: '金富科技（003018） · 2026-09-13',
            sections: [
                { heading: '事件事实', blocks: [{ type: 'kv', items: [{ label: '方向', value: '上涨', tone: 'up' }] }] },
                { heading: '六阶段因果链', blocks: [{ type: 'chain', stages: [
                    { stage: '结构根因', stageKey: 'structural_root', claim: '主力净流出',
                      epistemic: '假设', epistemicKey: 'hypothesis', status: '未确立',
                      statusKey: 'not_established', evidenceIds: [], evidenceCount: 0 },
                ] }] },
            ],
        }));
        const res = fakeSseRes();
        const req = { headers: { authorization: `Bearer ${makeToken()}` }, params: { eventId: 'mv:1' } };
        await StockTraceController.reportStream(req as never, res as never);

        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'text/event-stream;charset=UTF-8');
        const events = sseEvents(res);
        assert.deepEqual(events.map((e) => e.type), ['start', 'section', 'section', 'done']);
        assert.equal(events[0].header, '金富科技（003018） · 2026-09-13');
        assert.equal(events[0].total, 2);
        assert.equal(events[1].heading, '事件事实');
        // blocks 原样透传（前端按 block.type 渲染，六阶段因果链为纵向时间轴）
        assert.deepEqual(events[1].blocks, [
            { type: 'kv', items: [{ label: '方向', value: '上涨', tone: 'up' }] },
        ]);
        assert.equal(events[2].index, 1);
        const chainBlocks = events[2].blocks as Array<{ type: string; stages: Array<Record<string, unknown>> }>;
        assert.equal(chainBlocks[0].type, 'chain');
        assert.equal(chainBlocks[0].stages[0].stageKey, 'structural_root');
        // 事件逐条各占一个 chunk（缓冲会合并成一次 write）
        assert.equal(res.chunks.filter((c) => c.startsWith('data: ')).length, 4);
        assert.ok(res.chunks.every((c) => c.endsWith('\n\n')));
    });

    it('agent-py 失败（开流前）→ 502 + JSON', async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        const artifact = {
            artifactId: 'a1', artifactVersion: 1, artifactJson: {}, movementView: {}, createdAt: '2026-09-13',
        };
        mock.method(StockTraceService, 'getUserEvent', async () => ({ event_id: 'mv:1', symbol: '003018', trigger_revision: 1 }) as Record<string, unknown>);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', async () => artifact);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', async () => null);
        mock.method(InsightReportService, 'fetchSections', async () => { throw new Error('agent down'); });
        const res = fakeSseRes();
        const req = { headers: { authorization: `Bearer ${makeToken()}` }, params: { eventId: 'mv:1' } };
        await StockTraceController.reportStream(req as never, res as never);
        assert.equal(res.statusCode, 502);
        assert.equal((res.body as { message: string }).message, '报告生成失败，请重试');
        assert.equal(res.chunks.length, 0);
    });
});

describe('InsightReportService.fetchSections（上游边界归一化）', () => {
    it('章节缺 blocks / blocks 非数组 → 补空数组，不把 undefined 透给前端', async () => {
        mock.method(axios, 'post', async () => ({
            data: {
                header: 'h',
                sections: [{ heading: '事件事实' }, { heading: '主因结论', blocks: null }],
            },
        }));
        const report = await InsightReportService.fetchSections({});
        assert.deepEqual(report.sections, [
            { heading: '事件事实', blocks: [] },
            { heading: '主因结论', blocks: [] },
        ]);
    });

    it('header 缺失 → 空串', async () => {
        mock.method(axios, 'post', async () => ({ data: { sections: [] } }));
        assert.equal((await InsightReportService.fetchSections({})).header, '');
    });

    it('sections 非数组 → 抛错（由 controller 转 502）', async () => {
        mock.method(axios, 'post', async () => ({ data: { sections: 'bad' } }));
        await assert.rejects(() => InsightReportService.fetchSections({}), /结构非法/);
    });
});

describe('StockTraceService 事件投影（报告数据来源）', () => {
    it('getUserEvent 投影含 trading_date（PDF 页眉交易日依赖）', async () => {
        let seenSql = '';
        mock.method(pool, 'query', async (sql: unknown) => {
            const text = typeof sql === 'string' ? sql : String((sql as { text?: string }).text ?? '');
            if (text.includes('INNER JOIN user_stocks')) {
                seenSql = text;
                return {
                    rows: [{
                        event_id: 'mv:1', symbol: '003018', stock_name: '某科技', direction: 'up',
                        first_triggered_at: new Date('2026-09-13T01:00:00Z'),
                        window_start_at: null, window_end_at: null,
                        current_trigger_revision: 1, current_severity: 'high', is_limit_up: false,
                        read_at: null, triggered_at: new Date('2026-09-13T01:30:00Z'),
                        latest_price: '15.5', previous_close: '14.15', change_pct: '9.5',
                        threshold_value: '7', rule_version: 'price-v1', data_quality: null,
                        trading_date: '2026-09-13',
                    }],
                };
            }
            return { rows: [] };
        });
        const event = await StockTraceService.getUserEvent('u1', 'o1', 'mv:1');
        // DATE 列必须转文本：否则 node-postgres 解析为 Date，JSON 化后变 UTC ISO 串
        // （实测页眉曾显示 "2026-09-23T16:00:00.000Z" 而非 "2026-09-24"）
        assert.ok(seenSql.includes('e.trading_date::text'), 'SQL 未把 trading_date 转文本');
        assert.equal(event?.trading_date, '2026-09-13');
    });
});
