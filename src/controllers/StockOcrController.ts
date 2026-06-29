import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../utils/response';
import { StockOcrService, type StockOcrOptions } from '../services/StockOcrService';

export class StockOcrController {
    static async batchOcr(req: Request, res: Response, _next: NextFunction): Promise<void> {
        if (req.method !== 'POST') {
            createResponse(res, 405, 'Method Not Allowed - 仅支持 POST');
            return;
        }

        const body = req.body;
        if (!body) {
            createResponse(res, 400, '请求体必须是 JSON');
            return;
        }

        const images = body?.images ?? body?.image_list ?? body?.imgs;
        if (!Array.isArray(images)) {
            createResponse(res, 400, 'images 必须是数组');
            return;
        }

        const hint = typeof body?.hint === 'string'
            ? body.hint
            : (typeof body?.ocrHint === 'string' ? body.ocrHint : '');
        const ocrOptions: StockOcrOptions = {
            batchConcurrency: body?.batchConcurrency ?? body?.ocrOptions?.batchConcurrency,
            maxImagesPerRequest: body?.maxImagesPerRequest ?? body?.ocrOptions?.maxImagesPerRequest,
            timeoutMs: body?.timeoutMs ?? body?.ocrOptions?.timeoutMs,
        };

        try {
            const normalizedImages = StockOcrService.normalizeImages(images);
            const data = await StockOcrService.recognizeStocksFromImages(normalizedImages, hint, ocrOptions);
            createResponse(res, 200, 'success', data);
        } catch (error: any) {
            const message = error instanceof Error ? error.message : 'Internal Server Error';
            if (message.includes('images') || message.includes('图片')) {
                createResponse(res, 400, message);
                return;
            }
            createResponse(res, 500, message);
        }
    }
}
