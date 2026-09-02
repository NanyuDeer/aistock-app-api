import { Request, Response, NextFunction } from 'express';
import { StockMidLongAnalysisService } from './StockMidLongAnalysisService';
import { createResponse } from '../../shared/utils/response';

type Timeframe = 'mid' | 'long';

export class StockMidLongAnalysisController {
    private static parseTimeframe(raw: string): Timeframe | null {
        const normalized = (raw || '').toLowerCase().trim();
        if (normalized === 'mid' || normalized === 'long') return normalized;
        return null;
    }

    static async handleGet(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        const timeframe = StockMidLongAnalysisController.parseTimeframe(String(req.params.timeframe || ''));
        if (!timeframe) {
            createResponse(res, 400, 'Invalid timeframe - 必须是 mid 或 long');
            return;
        }

        try {
            const data = await StockMidLongAnalysisService.getLatestAnalysis(symbol, timeframe);
            if (!data) {
                createResponse(res, 404, `未找到该股票的${timeframe === 'mid' ? '中线' : '长线'}分析记录: ${symbol}`);
                return;
            }
            createResponse(res, 200, 'success', data);
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    static async handleCreate(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        const timeframe = StockMidLongAnalysisController.parseTimeframe(String(req.params.timeframe || ''));
        if (!timeframe) {
            createResponse(res, 400, 'Invalid timeframe - 必须是 mid 或 long');
            return;
        }

        try {
            const data = await StockMidLongAnalysisService.createAnalysis(symbol, timeframe);
            createResponse(res, 200, 'success', data);
        } catch (error: any) {
            const message = error instanceof Error ? error.message : 'Internal Server Error';
            if (message.includes('股票代码不存在')) {
                createResponse(res, 404, message);
                return;
            }
            createResponse(res, 500, message);
        }
    }
}