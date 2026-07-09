import dotenv from 'dotenv';
dotenv.config();

// 设置时区为北京时间（确保 node-cron 按 CST 调度）
process.env.TZ = 'Asia/Shanghai';

import express from 'express';
import cors from 'cors';
import cron from 'node-cron';

import pool from './core/db';
import redis from './core/redis';

// ==================== 模块导入 ====================
// quote 行情模块
import { StockQuoteController } from './modules/quote/controller';
import { IndexQuoteController } from './modules/quote/indexController';
import { StockListController } from './modules/quote/stockListController';
import { TagLeaderController } from './modules/quote/tagLeaderController';
import { CapitalFlowController } from './modules/quote/capitalFlowController';
import { StockAnalysisController } from './modules/quote/analysisController';

// internal 内部API（Python Agent 服务专用）
import internalRouter from './core/routes/internal';

// agent 反代模块（/api/agent/* → Python FastAPI，SSE 流式透传 + 注入 X-Internal-Token）
import { createAgentProxy } from './modules/agent/agent.proxy';

// push 推送模块
import { PotentialStockPushController } from './modules/push/controller';
import { WechatEventController } from './modules/push/wechatEventController';
import { MessagePushService } from './modules/push/MessagePushService';

// auth 认证模块
import { AuthController } from './modules/auth/controller';
import { ScanLoginController } from './modules/auth/scanLoginController';
import { UserController } from './modules/auth/userController';
import { FeishuMessageController } from './modules/auth/feishuMessageController';
import { FeishuAuthController } from './modules/auth/feishuAuthController';

// monitor 监控模块
import { StockMonitorController } from './modules/monitor/controller';
import { WindLeaderController } from './modules/monitor/windLeaderController';
import { NewsController } from './modules/monitor/newsController';
import { ProfitForecastController } from './modules/monitor/profitForecastController';
import { TenxScoreController } from './modules/monitor/tenxScoreController';
import { AiGraphController } from './modules/monitor/aiGraphController';
import { AiGraphService } from './modules/monitor/AiGraphService';
import { IndustryKGController } from './modules/monitor/industryKGController';
import { IndustryKGService } from './modules/monitor/IndustryKGService';
import { TenxBatchService } from './modules/monitor/TenxBatchService';
import { WindLeaderAnalyzerService } from './modules/monitor/WindLeaderAnalyzerService';
import { HotBurstService } from './modules/monitor/HotBurstService';
import { WindLeaderService } from './modules/monitor/WindLeaderService';
import { syncStockConceptMapping } from './modules/monitor/StockConceptMappingService';
import { ProfitForecastAutoUpdateService } from './modules/monitor/ProfitForecastAutoUpdateService';
import { StockSyncService } from './modules/monitor/StockSyncService';

// crawler 爬虫模块
import { StockInfoController } from './modules/crawler/controller';
import { StockInfoJudgementController } from './modules/crawler/judgementController';
import { StockOcrController } from './modules/crawler/ocrController';
import { StockInfoCrawlService } from './modules/crawler/services/StockInfoCrawlService';

// shared 共享层
import { isValidAShareSymbol } from './shared/utils/validator';
import { closeAllAgents } from './shared/utils/httpAgent';

// core 基础设施
import { ConfigController } from './core/routes/configController';
import { initWebSocket } from './core/ws/handler';

import { Application } from 'express';

const app: Application = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

const corsAllowOrigin = process.env.CORS_ALLOW_ORIGIN || '';
const allowedOrigins = corsAllowOrigin.split(',').map(s => s.trim()).filter(Boolean);

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes('*')) {
            callback(null, true);
        } else {
            callback(null, false);
        }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'x-internal-token'],
    maxAge: 86400,
}));

// ==================== Agent 反代（/api/agent/* → Python FastAPI） ====================
// 必须在 express.json()/urlencoded() 之前挂载：反代需要原始请求流，body parser 会消费 req
// 导致 pipe 无数据可传。SSE 流式透传（upstreamRes.pipe(res) 不缓冲），自动注入 X-Internal-Token
// （Python /api/agent/chat/* 鉴权）。路径保留 /api/agent 前缀，与 Python 路由一致。
// AGENT_PY_URL（主）/ PYTHON_AGENT_URL（兼容 brief 命名）二选一，默认 http://localhost:8000。
app.use('/api/agent', createAgentProxy({
    target: process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || 'http://localhost:8000',
    internalToken: process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production',
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.text({ type: 'text/xml' }));
app.use(express.urlencoded({ extended: true }));

app.use((req: express.Request, res: express.Response, next: express.NextFunction) => {
    const start = Date.now();
    res.on('finish', () => {
        const duration = Date.now() - start;
        if (duration > 3000) {
            console.log(`[Slow] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`);
        }
    });
    next();
});

app.get('/', (_req, res) => {
    res.json({
        code: 200,
        message: 'healthy',
        data: {
            status: 'ok',
            service: 'aistock-api',
            timestamp: new Date().toISOString(),
        },
    });
});

app.get('/health', async (_req, res) => {
    let pgOk = false;
    let redisOk = false;
    try {
        await pool.query('SELECT 1');
        pgOk = true;
    } catch {}
    try {
        await redis.ping();
        redisOk = true;
    } catch {}
    const ok = pgOk && redisOk;
    res.status(ok ? 200 : 503).json({
        code: ok ? 200 : 503,
        message: ok ? 'healthy' : 'degraded',
        data: { postgresql: pgOk, redis: redisOk },
    });
});

app.get('/api/auth/wechat/login', (req, res, next) => AuthController.login(req, res, next));
app.get('/api/auth/wechat/callback', (req, res, next) => AuthController.callback(req, res, next));
app.all('/api/auth/wechat/push', (req, res, next) => WechatEventController.handle(req, res, next));
app.get('/api/auth/wechat/login/scan', (req, res, next) => ScanLoginController.generateQrCode(req, res, next));
app.get('/api/auth/wechat/login/scan/poll', (req, res, next) => ScanLoginController.poll(req, res, next));
app.post('/api/auth/logout', (req, res, next) => AuthController.logout(req, res, next));

app.get('/api/users/me', (req, res, next) => UserController.me(req, res, next));
app.get('/api/users/me/settings', (req, res, next) => UserController.getSettings(req, res, next));
app.put('/api/users/me/settings/:settingType', (req, res, next) => UserController.updateSetting(req, res, next));
app.get('/api/users/me/news/push', (req, res, next) => UserController.getPushNews(req, res, next));
app.get('/api/users/me/push-history', (req, res, next) => UserController.getPushHistory(req, res, next));
app.get('/api/users/me/push-ranking', (req, res, next) => UserController.getPushRanking(req, res, next));
app.post('/api/users/me/favorites', (req, res, next) => UserController.addFavorites(req, res, next));
app.delete('/api/users/me/favorites', (req, res, next) => UserController.removeFavorites(req, res, next));
app.post('/api/users/me/favorites/delete', (req, res, next) => UserController.removeFavorites(req, res, next));

app.get('/api/internal/stock-info/targets', (req, res, next) => StockInfoJudgementController.getTargets(req, res, next));
app.post('/api/internal/stock-info/existing', (req, res, next) => StockInfoJudgementController.getExisting(req, res, next));
app.post('/api/internal/stock-info/judgements', (req, res, next) => StockInfoJudgementController.saveJudgements(req, res, next));
app.post('/api/internal/stock-info/push', (req, res, next) => StockInfoJudgementController.push(req, res, next));

// 趋势风口 - 前端查询接口，数据来自外部爬虫提交的公告/新闻研判。
app.get('/api/cn/trend-hotspots/events', (req, res, next) => StockMonitorController.getEvents(req, res, next));
app.get('/api/cn/trend-hotspots/events/:stockCode', (req, res, next) => StockMonitorController.getEventsByStock(req, res, next));
app.get('/api/cn/trend-hotspots/stats', (req, res, next) => StockMonitorController.getStats(req, res, next));
app.get('/api/cn/favorites/news', (req, res, next) => StockMonitorController.getFavoritesNews(req, res, next));
app.get('/api/cn/stock-info/judgements', (req, res, next) => StockInfoJudgementController.queryJudgements(req, res, next));

// 风口龙头
app.post('/api/cn/wind-leaders/refresh', (req, res, next) => WindLeaderController.refreshAnalysis(req, res, next));
app.get('/api/cn/wind-leaders', (req, res, next) => WindLeaderController.getWindLeaders(req, res, next));
app.post('/api/internal/wind-leaders', (req, res, next) => WindLeaderController.pushWindLeaders(req, res, next));
app.post('/api/cn/hot-keywords/detect', (req, res, next) => WindLeaderController.detectHotKeywords(req, res, next));
app.get('/api/cn/hot-keywords', (req, res, next) => WindLeaderController.getHotKeywords(req, res, next));

// 飞书群消息接收
app.post('/api/internal/feishu-message', (req, res, next) => FeishuMessageController.receiveMessage(req, res, next));
app.get('/api/internal/feishu-messages', (req, res, next) => FeishuMessageController.getMessages(req, res, next));

// 机构调研推荐热门股三步检测
app.post('/api/cn/institution-research/detect', (req, res, next) => WindLeaderController.detectHotBurst(req, res, next));
app.get('/api/cn/institution-research', (req, res, next) => WindLeaderController.getHotBurst(req, res, next));
app.get('/api/cn/institution-research/history', (req, res, next) => WindLeaderController.getHotBurstHistory(req, res, next));
app.get('/api/cn/institution-research/latest', (req, res, next) => WindLeaderController.getLatestRecords(req, res, next));

// 飞书OAuth授权
app.get('/api/auth/feishu/callback', (req, res, next) => FeishuAuthController.oauthCallback(req, res, next));

// 用户订阅
app.get('/api/users/me/subscription', (req, res, next) => FeishuAuthController.getSubscription(req, res, next));
app.post('/api/users/me/subscription', (req, res, next) => FeishuAuthController.updateSubscription(req, res, next));

// 内部推送接口
app.post('/api/internal/push-feishu', (req, res, next) => FeishuAuthController.pushMessage(req, res, next));

// 手动触发龙头股推送（测试用）
app.post('/api/internal/push-leader', async (req, res) => {
    const token = req.headers['x-internal-token'] || req.headers.authorization?.replace('Bearer ', '');
    if (token !== (process.env.INTERNAL_TOKEN || 'crawler-int-2026-token')) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const force = req.body?.force === true || req.query.force === 'true';
        const result = await MessagePushService.executeLeaderPush(force);
        res.json({ success: true, result });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 手动触发机构调研推荐热门股推送（测试用，支持传入测试数据）
app.post('/api/internal/push-institution-research', async (req, res) => {
    const token = req.headers['x-internal-token'] || req.headers.authorization?.replace('Bearer ', '');
    if (token !== (process.env.INTERNAL_TOKEN || 'crawler-int-2026-token')) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const testData = req.body?.test_data;
        const force = req.body?.force === true || req.query.force === 'true';
        const result = await MessagePushService.executeOutbreakPush(testData, force);
        res.json({ success: true, result });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 手动触发自选股异动推送（测试用，支持传入测试数据）
app.post('/api/internal/push-stock-info', async (req, res) => {
    const token = req.headers['x-internal-token'] || req.headers.authorization?.replace('Bearer ', '');
    if (token !== (process.env.INTERNAL_TOKEN || 'crawler-int-2026-token')) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const testData = req.body?.test_data;
        if (testData) {
            // 使用传入的测试数据直接推送
            const { WechatPushService } = await import('./modules/push/WechatPushService');
            const { MessagePushService } = await import('./modules/push/MessagePushService');
            const event = {
                id: testData.id || Date.now(),
                symbol: testData.symbol || '300750',
                stock_name: testData.stock_name || '宁德时代',
                info_type: testData.info_type || 'news',
                title: testData.title || '宁德时代发布新产品',
                url: testData.url || '',
                published_at: testData.published_at || new Date().toISOString(),
                ai_impact: testData.ai_impact || '重大利好',
                ai_horizon: testData.ai_horizon || '短期',
                ai_keywords: testData.ai_keywords || ['新产品', '增长'],
                ai_summary: testData.ai_summary || '公司发布新产品，预计将带来显著业绩增长',
            };
            const wxResult = await WechatPushService.dispatchStockInfoJudgement(event);
            const feishuResult = await MessagePushService.dispatchStockInfoToFeishu({
                symbol: event.symbol,
                stock_name: event.stock_name,
                info_type: event.info_type,
                title: event.title,
                ai_impact: event.ai_impact,
                ai_horizon: event.ai_horizon,
                ai_summary: event.ai_summary,
                published_at: event.published_at,
            }, true); // 测试模式：推送给所有飞书订阅用户
            res.json({ success: true, result: { wx: wxResult, feishu: feishuResult } });
        } else {
            // 使用数据库中的数据推送
            const { StockInfoPushService } = await import('./modules/crawler/StockInfoPushService');
            const result = await StockInfoPushService.push(req.body || { window: 'morning' });
            res.json({ success: true, result });
        }
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 公共配置接口
app.get('/api/config/public', (req, res, next) => ConfigController.getPublicConfig(req, res, next));

// 手动触发爬虫抓取（只抓取+研判+入库，不推送）
app.post('/api/internal/crawl/run', async (req, res) => {
    const token = req.headers['x-internal-token'] || req.headers.authorization?.replace('Bearer ', '');
    if (token !== (process.env.INTERNAL_TOKEN || 'crawler-int-2026-token')) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const result = await StockInfoCrawlService.runOnce(req.body || {});
        res.json({ success: true, result });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

// 手动触发爬虫完整周期（抓取+研判+入库+推送）
app.post('/api/internal/crawl/cycle', async (req, res) => {
    const token = req.headers['x-internal-token'] || req.headers.authorization?.replace('Bearer ', '');
    if (token !== (process.env.INTERNAL_TOKEN || 'crawler-int-2026-token')) {
        return res.status(401).json({ error: 'unauthorized' });
    }
    try {
        const window = req.body?.window || 'morning';
        const result = await StockInfoCrawlService.runCycle(window, req.body || {});
        res.json({ success: true, result });
    } catch (err: any) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/potential-stocks/push-history', (req, res, next) => PotentialStockPushController.getHistory(req, res, next));

// 临时测试端点：手动触发推送历史价格更新
app.post('/api/internal/update-push-history-prices', async (req, res) => {
    try {
        await WindLeaderService.updatePushHistoryPrices();
        res.json({ code: 200, message: '推送历史价格更新成功' });
    } catch (err: any) {
        res.status(500).json({ code: 500, message: err?.message || '更新失败' });
    }
});
app.get('/api/potential-stocks/push-ranking', (req, res, next) => PotentialStockPushController.getRanking(req, res, next));

app.get('/api/cn/stocks', (req, res, next) => StockListController.getStockList(req, res, next));
app.get('/api/cn/stock/infos', (req, res, next) => StockInfoController.getBatchStockInfo(req, res, next));
app.get('/api/cn/stock/quotes/core', (req, res, next) => StockQuoteController.getCoreQuotes(req, res, next));
app.get('/api/cn/stock/quotes/realtime', (req, res, next) => StockQuoteController.getRealtimeQuotes(req, res, next));
app.get('/api/cn/stock/quotes/activity', (req, res, next) => StockQuoteController.getActivityQuotes(req, res, next));
app.get('/api/cn/stock/quotes/kline', (req, res, next) => StockQuoteController.getKLine(req, res, next));
app.get('/api/cn/stock/fundamentals', (req, res, next) => StockQuoteController.getFundamentalQuotes(req, res, next));
app.get('/api/cn/index/quotes', (req, res, next) => IndexQuoteController.getIndexQuotes(req, res, next));
app.get('/api/gb/index/quotes', (req, res, next) => IndexQuoteController.getGlobalIndexQuotes(req, res, next));

app.get('/api/cn/stocks/tenx-score/batch', (req, res, next) => TenxScoreController.batchRefresh(req, res, next));
app.post('/api/cn/stocks/tenx-score/batch', (req, res, next) => TenxScoreController.batchRefresh(req, res, next));
app.get('/api/cn/stocks/tenx-score/rebuild', (req, res, next) => TenxScoreController.rebuildAll(req, res, next));
app.get('/api/cn/stocks/profit-forecast', (req, res, next) => ProfitForecastController.getForecastList(req, res, next));
app.get('/api/cn/stocks/profit-forecast/search', (req, res, next) => ProfitForecastController.searchForecastList(req, res, next));
app.post('/api/cn/stocks/profit-forecast/batch', (req, res, next) => ProfitForecastController.batchRefresh(req, res, next));
app.get('/api/cn/stocks/profit-forecast/batch/status', (req, res, next) => ProfitForecastController.getBatchStatus(req, res, next));
app.post('/api/cn/stocks/ocr', (req, res, next) => StockOcrController.batchOcr(req, res, next));

app.get('/api/cn/tags/:tagCode/leaders', (req, res, next) => TagLeaderController.getTagLeaders(req, res, next));

app.get('/api/cn/stocks/:symbol/capital-flow', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    CapitalFlowController.getCapitalFlow(req, res, next);
});

app.post('/api/cn/capital-flow/batch-prefetch', (req, res, next) => CapitalFlowController.batchPrefetch(req, res, next));
app.get('/api/cn/capital-flow/batch-status', (req, res, next) => CapitalFlowController.getBatchStatus(req, res, next));

app.get('/api/cn/stocks/:symbol/news', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    NewsController.getStockNews(req, res, next);
});

app.get('/api/cn/stocks/:symbol/analysis/history', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    StockAnalysisController.getStockAnalysisHistory(req, res, next);
});

app.route('/api/cn/stocks/:symbol/analysis')
    .get((req, res, next) => {
        if (!isValidAShareSymbol(req.params.symbol)) {
            res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
            return;
        }
        StockAnalysisController.handleStockAnalysis(req, res, next);
    })
    .post((req, res, next) => {
        if (!isValidAShareSymbol(req.params.symbol)) {
            res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
            return;
        }
        StockAnalysisController.handleStockAnalysis(req, res, next);
    });

app.get('/api/cn/stock/:symbol/profit-forecast', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    ProfitForecastController.getThsForecast(req, res, next);
});
app.post('/api/cn/stock/:symbol/profit-forecast', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    ProfitForecastController.getThsForecast(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.getScore(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score/history', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.getScoreHistory(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score/refresh', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.refreshScore(req, res, next);
});
app.post('/api/cn/stocks/:symbol/tenx-score/refresh', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.refreshScore(req, res, next);
});

app.get('/api/cn/stocks/:symbol/tenx-score/veto-check', (req, res, next) => {
    if (!isValidAShareSymbol(req.params.symbol)) {
        res.status(400).json({ code: 400, message: 'Invalid symbol - A股代码必须是6位数字' });
        return;
    }
    TenxScoreController.checkVeto(req, res, next);
});

app.get('/api/cn/stocks/tenx-score/top', (req, res, next) => {
    TenxScoreController.getTopStocks(req, res, next);
});

app.get('/api/news/headlines', (req, res, next) => NewsController.getHeadlines(req, res, next));
app.get('/api/news/cn', (req, res, next) => NewsController.getCnNews(req, res, next));
app.get('/api/news/hk', (req, res, next) => NewsController.getHkNews(req, res, next));
app.get('/api/news/gb', (req, res, next) => NewsController.getGlobalNews(req, res, next));
app.get('/api/news/fund', (req, res, next) => NewsController.getFundNews(req, res, next));
app.get('/api/news/:id', (req, res, next) => {
    if (!/^\d+$/.test(req.params.id)) {
        res.status(400).json({ code: 400, message: 'Invalid ID - ID 必须是数字' });
        return;
    }
    NewsController.getNewsDetail(req, res, next);
});

// ==================== AI 知识图谱路由 ====================
AiGraphService.initialize().catch((err: Error) => {
    console.error('[AiGraph] 初始化失败:', err);
});
app.get('/api/aigraph/concepts', (req, res, next) => AiGraphController.getConcepts(req, res, next));
app.get('/api/aigraph/concept/:conceptCode', (req, res, next) => AiGraphController.getGraph(req, res, next));
app.post('/api/aigraph/graph', (req, res, next) => AiGraphController.getGraph(req, res, next));

// ==================== 行业知识图谱路由 ====================
IndustryKGService.initialize().catch((err: Error) => {
    console.error('[IndustryKG] 初始化失败:', err);
});
app.get('/api/kg/graph', (req, res, next) => IndustryKGController.getFullGraph(req, res, next));
app.get('/api/kg/ai-graph', (req, res, next) => IndustryKGController.getAISubGraph(req, res, next));
app.get('/api/kg/subgraph', (req, res, next) => IndustryKGController.getSubGraph(req, res, next));
app.get('/api/kg/concepts', (req, res, next) => IndustryKGController.getConcepts(req, res, next));
app.get('/api/kg/industry/:industryId/stocks', (req, res, next) => IndustryKGController.getIndustryStocks(req, res, next));
app.post('/api/kg/refresh', (req, res, next) => IndustryKGController.refresh(req, res, next));

// ==================== Internal API（Python Agent 服务专用） ====================
app.use('/internal', internalRouter);

app.use((_req, res) => {
    res.status(404).json({ code: 404, message: 'Not Found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[Error]', err.message);
    res.status(500).json({ code: 500, message: err.message || 'Internal Server Error' });
});

cron.schedule('0 4 * * *', async () => {
    console.log('[TenxCron] 开始批量评分');
    try {
        await TenxBatchService.run();
        console.log('[TenxCron] 批量评分完成');
    } catch (err: any) {
        console.error('[TenxCron] 批量评分失败:', err?.message || err);
    }
});

cron.schedule('5 19 * * 1-5', async () => {
    console.log('[CapitalFlowCron] 收盘后批量预取资金流向');
    try {
        const { isAShareTradingTime } = await import('./shared/utils/tradingTime');
        const isTrading = await isAShareTradingTime();
        if (isTrading) {
            console.log('[CapitalFlowCron] 仍在交易时间，跳过');
            return;
        }
        const poolModule = await import('./core/db');
        const dbPool = poolModule.default;
        const result = await dbPool.query('SELECT symbol FROM stocks');
        const symbols = result.rows.map((r: any) => r.symbol as string);
        console.log(`[CapitalFlowCron] 共${symbols.length}只股票待预取`);

        const { getCapitalFlow } = await import('./modules/quote/TushareCapitalFlowService');
        const { CacheService } = await import('./shared/utils/CacheService');
        const { getAShareAdaptiveCacheTtlSeconds } = await import('./shared/utils/tradingTime');

        let success = 0, failed = 0;
        for (const symbol of symbols) {
            try {
                const cacheKey = `capital_flow:${symbol}`;
                const data = await getCapitalFlow(symbol);
                const ttl = await getAShareAdaptiveCacheTtlSeconds(3 * 60);
                await CacheService.put(cacheKey, data as unknown as Record<string, any>, ttl);
                success++;
            } catch (err: any) {
                failed++;
                if (failed <= 5) console.error(`[CapitalFlowCron] ${symbol} error:`, err?.message || err);
            }
        }
        console.log(`[CapitalFlowCron] 完成: 成功=${success}, 失败=${failed}`);
    } catch (err: any) {
        console.error('[CapitalFlowCron] 批量预取失败:', err?.message || err);
    }
});

// 风口龙头定时分析：每天凌晨3点执行（跳过节假日）
cron.schedule('0 3 * * *', async () => {
    console.log('[WindLeaderCron] 开始风口龙头分析');
    try {
        const { isAShareTradingDay } = await import('./shared/utils/tradingTime');
        const isTradingDay = await isAShareTradingDay();
        if (!isTradingDay) {
            console.log('[WindLeaderCron] 今天是非交易日（周末/节假日），跳过风口龙头分析');
            return;
        }
        const result = await WindLeaderAnalyzerService.runFullAnalysis();
        console.log(`[WindLeaderCron] 分析完成: ${result.hot_sectors?.length || 0} 个板块`);
    } catch (err: any) {
        console.error('[WindLeaderCron] 分析失败:', err?.message || err);
    }
});

// 机构调研推荐热门股定时检测：交易日 9:30、10:30、11:30、13:30、14:30、15:05
const runInstitutionResearchDetect = async (label: string) => {
    console.log(`[InstResearchCron] ${label} 开始机构调研推荐热门股检测`);
    try {
        const result = await HotBurstService.detectHotBurst();
        console.log(`[InstResearchCron] ${label} 检测完成: ${result.outbreaks.length} 个信号`);
    } catch (err: any) {
        console.error(`[InstResearchCron] ${label} 检测失败:`, err?.message || err);
    }
};
cron.schedule('30 9 * * 1-5', () => runInstitutionResearchDetect('开盘'));
cron.schedule('30 10 * * 1-5', () => runInstitutionResearchDetect('上午'));
cron.schedule('30 11 * * 1-5', () => runInstitutionResearchDetect('午前'));
cron.schedule('30 13 * * 1-5', () => runInstitutionResearchDetect('午盘'));
cron.schedule('30 14 * * 1-5', () => runInstitutionResearchDetect('尾盘'));
cron.schedule('5 15 * * 1-5', () => runInstitutionResearchDetect('收盘'));

// 每日 04:30 刷新个股-板块映射表（在 04:00 TenxCron 之后）
cron.schedule('30 4 * * *', async () => {
    console.log('[StockConceptMappingCron] 开始刷新个股-板块映射');
    try {
        const count = await syncStockConceptMapping();
        console.log(`[StockConceptMappingCron] 刷新完成: ${count} 条记录`);
    } catch (err: any) {
        console.error('[StockConceptMappingCron] 刷新失败:', err?.message || err);
    }
});

// 个股资讯爬虫+实时推送：每天 8:00 和 15:00（包括节假日）
// runCycle = 抓取 + AI研判 + 入库 + 触发自选股异动实时推送（飞书卡片+微信模板）
cron.schedule('0 8 * * *', async () => {
    console.log('[CrawlCron] 开始早盘爬虫周期');
    try {
        const result = await StockInfoCrawlService.runCycle('morning', { source: 'favorites', limit: 200 });
        console.log(`[CrawlCron] 早盘完成: 抓取${result.crawler.submitted}条, 推送候选${result.push.candidates}条`);
    } catch (err: any) {
        console.error('[CrawlCron] 早盘失败:', err?.message || err);
    }
});

cron.schedule('0 15 * * *', async () => {
    console.log('[CrawlCron] 开始尾盘爬虫周期');
    try {
        const result = await StockInfoCrawlService.runCycle('closing', { source: 'favorites', limit: 200 });
        console.log(`[CrawlCron] 尾盘完成: 抓取${result.crawler.submitted}条, 推送候选${result.push.candidates}条`);
    } catch (err: any) {
        console.error('[CrawlCron] 尾盘失败:', err?.message || err);
    }
});

// 业绩预测自动更新：每天凌晨 00:00 执行
cron.schedule('0 0 * * *', async () => {
    console.log('[ProfitForecastAutoUpdateCron] 开始执行业绩预测自动更新');
    try {
        const result = await ProfitForecastAutoUpdateService.run();
        console.log(`[ProfitForecastAutoUpdateCron] 完成: method=${result.method}, updated=${result.updated}, skipped=${result.skipped}, errors=${result.errors}`);
    } catch (err: any) {
        console.error('[ProfitForecastAutoUpdateCron] 执行失败:', err?.message || err);
    }
});

// 股票基础数据同步：每天凌晨 00:05 执行（同步新股、更新行业等）
cron.schedule('5 0 * * *', async () => {
    console.log('[StockSyncCron] 开始同步股票基础数据');
    try {
        const result = await StockSyncService.sync();
        console.log(`[StockSyncCron] 完成: 新增=${result.inserted}, 更新=${result.updated}, 总计=${result.total}`);
    } catch (err: any) {
        console.error('[StockSyncCron] 执行失败:', err?.message || err);
    }
});

// 每天 17:30 收盘后更新推送历史记录的最新价格
cron.schedule('30 17 * * 1-5', async () => {
    console.log('[PushHistoryPriceCron] 开始更新推送历史价格');
    try {
        await WindLeaderService.updatePushHistoryPrices();
        console.log('[PushHistoryPriceCron] 推送历史价格更新完成');
    } catch (err: any) {
        console.error('[PushHistoryPriceCron] 执行失败:', err?.message || err);
    }
});

async function start() {
    try {
        await pool.query('SELECT 1');
        console.log('[PG] Connected successfully');
    } catch (err: any) {
        console.error('[PG] Connection failed:', err.message);
    }

    try {
        await pool.query(`ALTER TABLE stocks ADD COLUMN IF NOT EXISTS industry TEXT DEFAULT ''`);
        console.log('[DB] stocks.industry column ready');
    } catch (err: any) {
        console.warn('[DB] stocks.industry column check:', err.message);
    }

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS stock_concept_mapping (
                id SERIAL PRIMARY KEY,
                symbol VARCHAR(20) NOT NULL,
                sector_name VARCHAR(100) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(symbol, sector_name)
            )
        `);
        console.log('[DB] stock_concept_mapping table ready');
    } catch (err: any) {
        console.warn('[DB] stock_concept_mapping table check:', err.message);
    }

    try {
        // 兼容旧表名：逐级重命名 hot_burst_history → media_attention_history → institution_research_history
        await pool.query(`
            DO $$
            BEGIN
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'hot_burst_history') THEN
                    ALTER TABLE hot_burst_history RENAME TO institution_research_history;
                    ALTER INDEX IF EXISTS idx_hot_burst_history_time RENAME TO idx_institution_research_history_time;
                    RAISE NOTICE 'Renamed hot_burst_history to institution_research_history';
                END IF;
                IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'media_attention_history') THEN
                    ALTER TABLE media_attention_history RENAME TO institution_research_history;
                    ALTER INDEX IF EXISTS idx_media_attention_history_time RENAME TO idx_institution_research_history_time;
                    RAISE NOTICE 'Renamed media_attention_history to institution_research_history';
                END IF;
            END $$;
        `);
        await pool.query(`
            CREATE TABLE IF NOT EXISTS institution_research_history (
                id SERIAL PRIMARY KEY,
                detected_at TIMESTAMP NOT NULL,
                symbol VARCHAR(20) NOT NULL,
                stock_name VARCHAR(50) NOT NULL,
                resonance_score INT NOT NULL,
                resonance_level VARCHAR(20) NOT NULL,
                price NUMERIC(10,2),
                change_pct NUMERIC(8,2),
                sector_info TEXT DEFAULT '',
                keywords TEXT DEFAULT '',
                news_count INT DEFAULT 0,
                feishu_count INT DEFAULT 0,
                ths_verified BOOLEAN DEFAULT false
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_institution_research_history_time ON institution_research_history(detected_at DESC)');
        // 迁移：添加 resonance_count 列（记录通过的共振数量 0-3）
        await pool.query(`
            ALTER TABLE institution_research_history
            ADD COLUMN IF NOT EXISTS resonance_count INT DEFAULT 0
        `);
        console.log('[DB] institution_research_history table ready');
    } catch (err: any) {
        console.warn('[DB] institution_research_history table check:', err.message);
    }

    // 业绩预测表
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS earnings_forecast (
                id SERIAL PRIMARY KEY,
                symbol VARCHAR(20) NOT NULL,
                update_time VARCHAR(30) NOT NULL,
                summary TEXT DEFAULT '',
                forecast_detail JSONB DEFAULT '[]',
                forecast_netprofit_yoy NUMERIC(10,2)
            )
        `);
        await pool.query('CREATE INDEX IF NOT EXISTS idx_earnings_forecast_symbol ON earnings_forecast(symbol)');
        // 迁移：为 symbol 添加 UNIQUE 约束，支持 upsert（每次爬取替换旧数据，避免数据堆积）
        try {
            await pool.query('ALTER TABLE earnings_forecast ADD CONSTRAINT earnings_forecast_symbol_unique UNIQUE (symbol)');
            console.log('[DB] earnings_forecast: added UNIQUE constraint on symbol');
        } catch (e: any) {
            // 约束已存在则忽略
            if (!/already exists|duplicate/i.test(e.message)) {
                console.warn('[DB] earnings_forecast UNIQUE constraint migration:', e.message);
            }
        }
        console.log('[DB] earnings_forecast table ready');
    } catch (err: any) {
        console.warn('[DB] earnings_forecast table check:', err.message);
    }

    try {
        await redis.ping();
        console.log('[Redis] Connected successfully');
    } catch (err: any) {
        console.error('[Redis] Connection failed:', err.message);
    }

    const server = app.listen(PORT, '0.0.0.0', () => {
        console.log(`[Server] aistock-app-api running on http://0.0.0.0:${PORT}`);
        // 启动飞书定时推送调度器
        MessagePushService.startScheduler();
        // 异步同步个股-板块映射（不阻塞启动，首次启动时填充空表）
        syncStockConceptMapping().catch(err => {
            console.error('[Startup] stock_concept_mapping 同步失败:', err?.message || err);
        });
    });

    // 初始化 WebSocket 服务（用于实时行情推送、异动提醒、对话流式输出）
    initWebSocket(server);
}

start();

// 进程退出时清理 HTTP 连接池
function gracefulShutdown() {
    closeAllAgents();
}
process.on('SIGINT', () => { gracefulShutdown(); process.exit(0); });
process.on('SIGTERM', () => { gracefulShutdown(); process.exit(0); });
process.on('exit', gracefulShutdown);

export { app, pool, redis };
