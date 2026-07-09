import { Request, Response, NextFunction } from 'express';
import { AiGraphService } from './AiGraphService';
import { createResponse } from '../../shared/utils/response';

export class AiGraphController {
    static async getConcepts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const concepts = await AiGraphService.getAllConcepts();
            createResponse(res, 200, 'success', {
                total: concepts.length,
                concepts
            });
        } catch (err: any) {
            next(err);
        }
    }

    static async getGraph(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            let triggerType: 'concept' | 'event' = 'concept';
            let value: string | undefined;

            if (req.method === 'GET') {
                // 支持从 URL 参数或查询参数获取概念代码
                value = req.params.conceptCode as string || req.query.conceptCode as string;
            } else {
                triggerType = req.body.triggerType || 'concept';
                value = req.body.value;
            }

            if (!value) {
                createResponse(res, 400, '缺少参数：conceptCode 或 value');
                return;
            }

            if (triggerType === 'event') {
                const result = await AiGraphService.getGraphByEvent(value);
                createResponse(res, 200, 'success', result);
                return;
            } else {
                const graphData = await AiGraphService.getGraphByConcept(value);
                createResponse(res, 200, 'success', {
                    trigger: {
                        type: triggerType,
                        value: value
                    },
                    graph: graphData
                });
            }
        } catch (err: any) {
            next(err);
        }
    }
}
