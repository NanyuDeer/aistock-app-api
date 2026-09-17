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