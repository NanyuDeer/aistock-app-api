import { Request, Response, NextFunction } from 'express';
import { StockAnalysisService } from './StockAnalysisService';
import { StockAnalysisAgentService } from './StockAnalysisAgentService';
import { createResponse } from '../../shared/utils/response';

const USE_AGENT = () => process.env.USE_AGENT_ANALYSIS === 'true';

export class StockAnalysisController {
    private static readonly DEFAULT_PAGE_SIZE = 20;
    private static readonly MAX_PAGE_SIZE = 100;

    private static isSseRequested(req: Request): boolean {
        const accept = (req.headers.accept || '').toLowerCase();
        return accept.includes('text/event-stream');
    }

    private static parseHistoryParams(req: Request): { page: number; pageSize: number } | { error: string } {
        const pageRaw = (req.query.page as string || '').trim();
        const pageSizeRaw = (req.query.pageSize as string || '').trim();

        let page = 1;
        if (pageRaw) {
            const parsed = Number(pageRaw);
            if (!Number.isInteger(parsed) || parsed < 1) return { error: 'Invalid page - page 必须是大于0的整数' };
            page = parsed;
        }

        let pageSize = StockAnalysisController.DEFAULT_PAGE_SIZE;
        if (pageSizeRaw) {
            const parsed = Number(pageSizeRaw);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > StockAnalysisController.MAX_PAGE_SIZE) return { error: `Invalid pageSize - pageSize 必须是 1-${StockAnalysisController.MAX_PAGE_SIZE} 的整数` };
            pageSize = parsed;
        }

        return { page, pageSize };
    }

    static async handleStockAnalysis(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, 'Invalid symbol - A股代码必须是6位数字');
            return;
        }

        if (req.method === 'POST') {
            if (StockAnalysisController.isSseRequested(req)) {
                res.setHeader('Content-Type', 'text/event-stream;charset=UTF-8');
                res.setHeader('Cache-Control', 'no-cache, no-transform');
                res.setHeader('Connection', 'keep-alive');
                res.setHeader('X-Accel-Buffering', 'no');
                res.flushHeaders();

                const encoder = new TextEncoder();
                const send = (event: string, payload: unknown) => {
                    const raw = typeof payload === 'string' ? payload : JSON.stringify(payload);
                    const lines = raw.split(/\r?\n/).map(line => `data: ${line}`).join('\n');
                    res.write(encoder.encode(`event: ${event}\n${lines}\n\n`));
                };

                const heartbeat = setInterval(() => {
                    res.write(': keep-alive\n\n');
                }, 15_000);

                try {
                    send('start', { message: '开始刷新个股评价', symbol, mode: USE_AGENT() ? 'agent' : 'legacy' });

                    if (USE_AGENT()) {
                        // Agent 模式：多轮检索
                        const data = await StockAnalysisAgentService.createStockAnalysis(
                            symbol,
                            (event) => {
                                send('progress', event);
                                // 额外发送 agent_step 事件供前端展示
                                send('agent_step', {
                                    type: event.type,
                                    round: event.round,
                                    data: event.data,
                                });
                            },
                        );
                        send('result', data);
                    } else {
                        // 旧版模式：全量喂入
                        const data = await StockAnalysisService.createStockAnalysis(
                            symbol,
                            (progress) => send('progress', progress),
                            (delta) => send('model.delta', delta),
                        );
                        send('result', data);
                    }
                    send('done', { message: 'success' });
                } catch (error: any) {
                    const message = error instanceof Error ? error.message : 'Internal Server Error';
                    const code = message.includes('股票代码不存在') ? 404 : 500;
                    send('error', { code, message });
                } finally {
                    clearInterval(heartbeat);
                    res.end();
                }
                return;
            }

            try {
                let data: Record<string, any>;
                if (USE_AGENT()) {
                    data = await StockAnalysisAgentService.createStockAnalysis(symbol);
                } else {
                    data = await StockAnalysisService.createStockAnalysis(symbol);
                }
                createResponse(res, 200, 'success', data);
            } catch (error: any) {
                const message = error instanceof Error ? error.message : 'Internal Server Error';
                if (message.includes('股票代码不存在')) {
                    createResponse(res, 404, message);
                    return;
                }
                createResponse(res, 500, message);
            }
            return;
        }

        if (req.method === 'GET') {
            try {
                const data = await StockAnalysisService.getLatestStockAnalysis(symbol);
                if (!data) {
                    createResponse(res, 404, `未找到该股票的分析记录: ${symbol}`);
                    return;
                }
                createResponse(res, 200, 'success', data);
            } catch (error: any) {
                const message = error instanceof Error ? error.message : 'Internal Server Error';
                if (message.includes('股票代码不存在')) {
                    createResponse(res, 404, message);
                    return;
                }
                createResponse(res, 500, message);
            }
            return;
        }

        createResponse(res, 405, 'Method Not Allowed - 仅支持 GET/POST');
    }

    static async getStockAnalysisHistory(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        if (!symbol || !/^\d{6}$/.test(symbol)) {
            createResponse(res, 400, 'Invalid symbol - A股代码必须是6位数字');
            return;
        }

        const parsed = this.parseHistoryParams(req);
        if ('error' in parsed) {
            createResponse(res, 400, parsed.error);
            return;
        }

        try {
            const data = await StockAnalysisService.getStockAnalysisHistory(symbol, parsed.page, parsed.pageSize);
            if ((data['总数量'] as number) === 0) {
                createResponse(res, 404, `未找到该股票的历史分析记录: ${symbol}`);
                return;
            }
            createResponse(res, 200, 'success', data);
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }
}
