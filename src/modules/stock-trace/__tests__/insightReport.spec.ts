/**
 * 完整洞察报告 PDF 接口测试
 *
 * 覆盖：401（未登录）/ 404（无自选归属）/ 409（无完整归因）/ 200（成功返回PDF）
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
            movementView: { confidenceLevel: 'high', primaryCandidate: { verdict: '液冷板块联动' } },
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
        assert.deepEqual(data.attribution.candidates, []);
        assert.deepEqual(data.attribution.chains, []);
        assert.deepEqual(data.attribution.unresolvedQuestions, []);
        assert.deepEqual(data.attribution.evidenceIndex, []);
    });
});

describe('InsightReportService.renderPdf content-type check', () => {
    // 保存原始环境变量，在跑 controller 测试时 mock 回正常值
    const origUrl = process.env.AGENT_PY_URL;

    afterEach(() => {
        process.env.AGENT_PY_URL = origUrl;
    });

    it('非 PDF content-type → 抛出异常', async () => {
        process.env.AGENT_PY_URL = 'http://mock-agent:9999';
        const mockResponse = {
            status: 200,
            data: new ArrayBuffer(8),
            headers: { 'content-type': 'text/html; charset=utf-8' },
        };
        mock.method(axios, 'post', async () => mockResponse);
        await assert.rejects(
            () => InsightReportService.renderPdf({}),
            { message: 'agent-py 返回非 PDF 内容' },
        );
    });

    it('无 content-type header → 抛出异常', async () => {
        process.env.AGENT_PY_URL = 'http://mock-agent:9999';
        const mockResponse = {
            status: 200,
            data: new ArrayBuffer(8),
            headers: {},
        };
        mock.method(axios, 'post', async () => mockResponse);
        await assert.rejects(
            () => InsightReportService.renderPdf({}),
            { message: 'agent-py 返回非 PDF 内容' },
        );
    });

    it('正确的 content-type → 正常返回 Buffer', async () => {
        process.env.AGENT_PY_URL = 'http://mock-agent:9999';
        const pdfBytes = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 52]).buffer; // %PDF-1.4
        const mockResponse = {
            status: 200,
            data: pdfBytes,
            headers: { 'content-type': 'application/pdf' },
        };
        mock.method(axios, 'post', async () => mockResponse);
        const buf = await InsightReportService.renderPdf({});
        assert.ok(Buffer.isBuffer(buf));
        assert.equal(buf.length, 8);
    });
});

describe('GET /movements/:eventId/report.pdf', () => {
    it('未登录 → 401', async () => {
        const res = fakeRes();
        await StockTraceController.report(
            { headers: {}, params: { eventId: 'mv:1' } } as never,
            res as never,
            (() => {}) as never,
        );
        assert.equal(res.statusCode, 401);
    });

    it('无自选归属 → 404', async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        mock.method(StockTraceService, 'getUserEvent', async () => null);
        const res = fakeRes();
        const req = { headers: { authorization: `Bearer ${makeToken()}` }, params: { eventId: 'mv:1' } };
        await StockTraceController.report(req as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 404);
    });

    it('无有效归因 → 409', async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        mock.method(StockTraceService, 'getUserEvent', async () => ({ event_id: 'mv:1', trigger_revision: 1 }) as Record<string, unknown>);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', async () => null);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifact', async () => null);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', async () => ({ validationStatus: 'rejected', processingStatus: 'partial' }));
        const res = fakeRes();
        const req = { headers: { authorization: `Bearer ${makeToken()}` }, params: { eventId: 'mv:1' } };
        await StockTraceController.report(req as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 409);
    });

    it('成功 → 200 + application/pdf', async () => {
        process.env.JWT_SECRET = JWT_SECRET;
        const artifact = {
            artifactId: 'a1', artifactVersion: 1,
            artifactJson: { candidates: [], chains: [], evidence_index: [] },
            movementView: {
                status: 'confirmed', schemaVersion: 'movement-view-v2' as const,
                eventId: 'mv:1', artifactId: 'a1', alternatives: [],
                unresolvedQuestions: [], suggestedActions: [], evidenceCount: 1,
                generatedAt: '2026-09-13',
            },
            createdAt: '2026-09-13',
        };
        mock.method(StockTraceService, 'getUserEvent', async () => ({ event_id: 'mv:1', symbol: '003018', trigger_revision: 1, triggered_at: '2026-09-04T01:34:07.932Z' }) as Record<string, unknown>);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', async () => artifact);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', async () => ({ primaryPhrase: '液冷服务器概念板块联动', validationStatus: 'passed', processingStatus: 'completed' }));
        mock.method(InsightReportService, 'renderPdf', async () => Buffer.from('%PDF-1.4 fake'));
        const res = fakeRes();
        const req = { headers: { authorization: `Bearer ${makeToken()}` }, params: { eventId: 'mv:1' } };
        await StockTraceController.report(req as never, res as never, (() => {}) as never);
        assert.equal(res.statusCode, 200);
        assert.equal(res.headers['Content-Type'], 'application/pdf');
        assert.ok(String(res.headers['Content-Disposition']).includes('attachment'));
    });
});
