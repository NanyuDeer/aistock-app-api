import { Request, Response, NextFunction } from 'express';
import { TushareTagLeaderService } from './TushareTagLeaderService';
import { createResponse } from '../../shared/utils/response';
import { isValidTagCode } from '../../shared/utils/validator';

export class TagLeaderController {
    private static readonly DEFAULT_COUNT = 10;
    private static readonly MAX_COUNT = 100;

    static async getTagLeaders(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const tagCode = String(req.params.tagCode || '').toUpperCase();
        if (!isValidTagCode(tagCode)) {
            createResponse(res, 400, 'Invalid tagCode - tagCode 必须是 BK+4位数字，例如 BK0428');
            return;
        }

        const countParam = req.query.count as string;
        let count = TagLeaderController.DEFAULT_COUNT;

        if (countParam) {
            const parsed = Number(countParam);
            if (!Number.isInteger(parsed) || parsed <= 0 || parsed > TagLeaderController.MAX_COUNT) {
                createResponse(res, 400, `Invalid count - count 必须是 1-${TagLeaderController.MAX_COUNT} 的整数`);
                return;
            }
            count = parsed;
        }

        try {
            const leaders = await TushareTagLeaderService.getTagLeaders(tagCode, count);
            createResponse(res, 200, 'success', {
                '来源': 'Tushare https://tushare.pro',
                '板块ID': tagCode,
                '排序字段': '主力净流入',
                '排序方式': '降序',
                '数量': leaders.length,
                '龙头个股': leaders,
            });
        } catch (err: any) {
            console.error(`Error fetching tag leaders for ${tagCode}:`, err);
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
