/**
 * presentEventAnalysis 链路（controller.get）测试：当前版本最新 job 状态为 dead_letter 时，
 * 详情接口 analysis_status 派生为 'failed'（该链路负责查 job 并透传给 presentStockTraceAnalysis）。
 *
 * Mock 策略：mock StockTraceService.getRecentEvent（未登录降级路径）+ 三个详情读取服务。
 * 仓库惯例：node:test + .spec.ts + __tests__。
 * 运行：`node --import tsx --test src/modules/stock-trace/__tests__/presentEventAnalysis.spec.ts`
 */
import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { NextFunction, Request, Response } from 'express';
import { StockTraceService } from '../StockTraceService';
import { StockTraceArtifactService } from '../StockTraceArtifactService';
import { StockTraceResultService } from '../StockTraceResultService';
import { StockTraceJobService } from '../StockTraceJobService';
import { StockTraceController } from '../controller';

afterEach(() => {
    mock.restoreAll();
});

interface FakeRes {
    statusCode: number;
    body: unknown;
    status(code: number): FakeRes;
    json(body: unknown): void;
}

function makeRes(): FakeRes {
    const res: FakeRes = {
        statusCode: 0,
        body: undefined,
        status(this: FakeRes, code: number): FakeRes {
            this.statusCode = code;
            return this;
        },
        json(this: FakeRes, body: unknown): void {
            this.body = body;
        },
    };
    return res;
}

const next: NextFunction = () => {};

const baseEvent: Record<string, unknown> = {
    event_id: 'mv:000004:2026-09-30:1:up',
    trigger_revision: 1,
    symbol: '688203',
    stock_name: '海正生材',
    direction: 'down',
    event_type: 'price',
};

describe('presentEventAnalysis（controller.get 详情链路）', () => {
    it('job 为 dead_letter 时详情 analysis_status === failed', async () => {
        mock.method(StockTraceService, 'getRecentEvent', (async () => baseEvent) as unknown as typeof StockTraceService.getRecentEvent);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', (async () => null) as unknown as typeof StockTraceArtifactService.getEffectiveArtifactForRevision);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', (async () => null) as unknown as typeof StockTraceResultService.getLatestForEventRevision);
        mock.method(StockTraceJobService, 'getLatestJobStatusForEventRevision', (async () => 'dead_letter') as unknown as typeof StockTraceJobService.getLatestJobStatusForEventRevision);

        const req = { headers: {}, params: { eventId: baseEvent.event_id } } as unknown as Request;
        const res = makeRes();
        await StockTraceController.get(req as Request, res as unknown as Response, next);

        const body = res.body as { code: number; data: { analysis_status: string } };
        assert.equal(body.code, 200);
        assert.equal(body.data.analysis_status, 'failed');
    });

    it('job 无 dead_letter（无 job/processing）时仍 processing，不透传 failed', async () => {
        mock.method(StockTraceService, 'getRecentEvent', (async () => baseEvent) as unknown as typeof StockTraceService.getRecentEvent);
        mock.method(StockTraceArtifactService, 'getEffectiveArtifactForRevision', (async () => null) as unknown as typeof StockTraceArtifactService.getEffectiveArtifactForRevision);
        mock.method(StockTraceResultService, 'getLatestForEventRevision', (async () => null) as unknown as typeof StockTraceResultService.getLatestForEventRevision);
        mock.method(StockTraceJobService, 'getLatestJobStatusForEventRevision', (async () => 'processing') as unknown as typeof StockTraceJobService.getLatestJobStatusForEventRevision);

        const req = { headers: {}, params: { eventId: baseEvent.event_id } } as unknown as Request;
        const res = makeRes();
        await StockTraceController.get(req as Request, res as unknown as Response, next);

        const body = res.body as { data: { analysis_status: string } };
        assert.equal(body.data.analysis_status, 'processing');
    });
});