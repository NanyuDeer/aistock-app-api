import { Request, Response, NextFunction } from 'express';
import { IndustryKGService } from '../services/IndustryKGService';

function createResponse(res: Response, code: number, message: string, data?: any) {
    return res.status(code >= 400 ? code : 200).json({ code, message, data });
}

export class IndustryKGController {
    /**
     * GET /api/kg/graph
     * 获取完整知识图谱
     */
    static async getFullGraph(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const graph = IndustryKGService.getFullGraph();
            createResponse(res, 200, 'success', graph);
        } catch (err: any) {
            next(err);
        }
    }

    /**
     * GET /api/kg/subgraph?concept=xxx&depth=1
     * 获取概念子图（用于层级流向图）
     */
    static async getSubGraph(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const conceptId = req.query.concept as string;
            const depth = parseInt(req.query.depth as string) || 1;

            if (!conceptId) {
                createResponse(res, 400, '缺少concept参数');
                return;
            }

            const subGraph = IndustryKGService.getSubGraphByConcept(conceptId, depth);
            createResponse(res, 200, 'success', subGraph);
        } catch (err: any) {
            next(err);
        }
    }

    /**
     * GET /api/kg/concepts
     * 获取所有概念列表
     */
    static async getConcepts(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const concepts = IndustryKGService.getAllConcepts();
            createResponse(res, 200, 'success', { total: concepts.length, concepts });
        } catch (err: any) {
            next(err);
        }
    }

    /**
     * GET /api/kg/industry/:industryId/stocks
     * 获取行业龙头股
     */
    static async getIndustryStocks(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const industryId = req.params.industryId as string;
            const stocks = IndustryKGService.getIndustryStocks(industryId);
            createResponse(res, 200, 'success', { industryId, stocks });
        } catch (err: any) {
            next(err);
        }
    }

    /**
     * GET /api/kg/ai-graph
     * 获取AI产业链子图（基于关键词匹配 + BFS扩展）
     */
    static async getAISubGraph(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const subGraph = IndustryKGService.getAISubGraph();
            createResponse(res, 200, 'success', subGraph);
        } catch (err: any) {
            next(err);
        }
    }

    /**
     * POST /api/kg/refresh
     * 手动触发知识图谱重建
     */
    static async refresh(req: Request, res: Response, next: NextFunction): Promise<void> {
        try {
            const graph = await IndustryKGService.rebuild();
            createResponse(res, 200, '知识图谱重建完成', {
                industryCount: graph.industryCount,
                edgeCount: graph.edgeCount,
                conceptCount: graph.conceptCount,
                updateTime: graph.updateTime,
            });
        } catch (err: any) {
            next(err);
        }
    }
}
