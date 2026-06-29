import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../utils/response';
import { StockInfoService } from '../services/StockInfoService';
import { StockInfoPushService } from '../services/StockInfoPushService';

function validateInternalToken(req: Request): boolean {
    const expected = process.env.INTERNAL_TOKEN || process.env.INTERNAL_API_TOKEN || 'crawler-int-2026-token';
    const headerToken = req.headers['x-internal-token'];
    const bearerToken = req.headers.authorization?.replace('Bearer ', '');
    const token = String(Array.isArray(headerToken) ? headerToken[0] : headerToken || '') || bearerToken || '';
    return token === expected;
}

function getPayloadItems(body: any): Record<string, any>[] {
    if (Array.isArray(body)) return body;
    if (Array.isArray(body?.items)) return body.items;
    if (body && typeof body === 'object') return [body];
    return [];
}

export class StockInfoJudgementController {
    static async getTargets(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!validateInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const source = StockInfoService.normalizeSource(req.query.source);
            const limit = StockInfoService.normalizeLimit(req.query.limit, 200, 1000);
            const targets = await StockInfoService.getTargets(source, limit);
            createResponse(res, 200, 'success', { targets });
        } catch (err: any) {
            createResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
    }

    static async saveJudgements(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!validateInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const items = getPayloadItems(req.body);
            if (items.length === 0) {
                createResponse(res, 400, 'items is required');
                return;
            }

            const result = await StockInfoService.upsertJudgements(items);
            createResponse(res, result.summary.failed > 0 ? 207 : 200, 'success', result);
        } catch (err: any) {
            createResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
    }

    static async getExisting(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!validateInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const items = getPayloadItems(req.body);
            if (items.length === 0) {
                createResponse(res, 400, 'items is required');
                return;
            }

            const existing = await StockInfoService.getExistingJudgements(items);
            createResponse(res, 200, 'success', { existing });
        } catch (err: any) {
            createResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
    }

    static async queryJudgements(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            const limit = StockInfoService.normalizeLimit(req.query.limit, 20, 100);
            const offset = StockInfoService.normalizeOffset(req.query.offset);
            const result = await StockInfoService.queryJudgements({
                symbol: String(req.query.symbol || ''),
                info_type: String(req.query.info_type || '') as any,
                impact: String(req.query.impact || '') as any,
                limit,
                offset,
            });
            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            createResponse(res, 500, err instanceof Error ? err.message : String(err));
        }
    }

    static async push(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!validateInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const result = await StockInfoPushService.push(req.body || {});
            createResponse(res, 200, 'success', result);
        } catch (err: any) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('window') || message.includes('datetime')) {
                createResponse(res, 400, message);
                return;
            }
            createResponse(res, 500, message);
        }
    }
}
