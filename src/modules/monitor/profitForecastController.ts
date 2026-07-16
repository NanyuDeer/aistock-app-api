import { Request, Response, NextFunction } from 'express';
import { ThsService } from './ThsService';
import { createResponse } from '../../shared/utils/response';
import pool from '../../core/db';
import { CacheService } from '../../shared/utils/CacheService';
import { sessionFetch } from '../../shared/utils/httpAgent';

interface EarningsForecastRow {
    update_time: string;
    summary: string | null;
    forecast_detail: unknown;
    forecast_netprofit_yoy: unknown;
}

interface ForecastListRow {
    symbol: string;
    stock_name: string | null;
    update_time: string;
    summary: string | null;
    forecast_netprofit_yoy: unknown;
    forecast_detail: unknown;
    forecast_netprofit: unknown;
    forecast_eps: unknown;
    forecast_eps_yoy: unknown;
}

/** 从摘要文本中解析结构化字段 */
interface ParsedSummary {
    institutionCount: number;
    eps: string;
    epsGrowth: string;
    netProfit: string;
    netProfitGrowth: string;
}

type ForecastSortBy = 'symbol' | 'forecast_netprofit_yoy' | 'update_time' | 'net_profit_forecast' | 'eps_forecast' | 'net_profit_growth' | 'eps_growth';
type ForecastSortOrder = 'asc' | 'desc';

interface CommonListParams {
    page: number;
    pageSize: number;
    sortBy: ForecastSortBy;
    sortOrder: ForecastSortOrder;
}

const LATEST_FORECAST_CTE = `
    WITH latest AS (
        SELECT e.symbol, e.update_time, e.summary, e.forecast_detail, e.forecast_netprofit_yoy,
               e.forecast_netprofit, e.forecast_eps, e.forecast_eps_yoy
        FROM earnings_forecast e
        INNER JOIN (
            SELECT symbol, MAX(update_time) AS latest_update_time
            FROM earnings_forecast
            GROUP BY symbol
        ) m ON e.symbol = m.symbol AND e.update_time = m.latest_update_time
    )
`;

export class ProfitForecastController {
    private static readonly DEFAULT_PAGE_SIZE = 50;
    private static readonly MAX_PAGE_SIZE = 500;
    private static readonly DEFAULT_SORT_BY: ForecastSortBy = 'forecast_netprofit_yoy';
    private static readonly ALLOWED_SORT_BY = new Set<ForecastSortBy>(['symbol', 'forecast_netprofit_yoy', 'update_time', 'net_profit_forecast', 'eps_forecast', 'net_profit_growth', 'eps_growth']);
    private static readonly ALLOWED_SORT_ORDER = new Set<ForecastSortOrder>(['asc', 'desc']);

    private static formatToChinaTimeWithMs(timestamp: number): string {
        const date = new Date(timestamp);
        const utc8Time = date.getTime() + (date.getTimezoneOffset() * 60000) + (8 * 3600000);
        const d = new Date(utc8Time);
        const pad2 = (n: number) => n.toString().padStart(2, '0');
        const pad3 = (n: number) => n.toString().padStart(3, '0');
        return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
            `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
    }

    private static parseForecastDetail(raw: unknown): any[] {
        if (Array.isArray(raw)) return raw;
        if (typeof raw === 'string') {
            try { const parsed = JSON.parse(raw); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
        }
        return [];
    }

    private static parseForecastNetProfitYoy(raw: unknown): number | null {
        if (raw === null || raw === undefined || raw === '') return null;
        const parsed = Number(raw);
        return Number.isFinite(parsed) ? parsed : null;
    }

    /** 从摘要中提取数值（正则匹配） */
    private static extractNumericFromSummary(summary: string, pattern: RegExp): number | null {
        if (!summary) return null;
        const match = summary.match(pattern);
        if (match) return parseFloat(match[1]);
        return null;
    }

    private static extractForecastNetProfitYoy(summary: string): number | null {
        if (!summary) return null;
        const normalized = summary.replace(/[−－]/g, '-').replace(/\s+/g, '');
        const patterns = [
            /预测\d{4}年净利润[^，,。；;]*(?:，|,)较去年同比(增长|下降)(-?\d+(?:\.\d+)?)%/,
            /净利润[^，,。；;]*(?:，|,)较去年同比(增长|下降)(-?\d+(?:\.\d+)?)%/,
        ];
        for (const pattern of patterns) {
            const match = normalized.match(pattern);
            if (!match) continue;
            const direction = match[1];
            const value = Number(match[2]);
            if (!Number.isFinite(value)) return null;
            return direction === '下降' ? -Math.abs(value) : Math.abs(value);
        }
        return null;
    }

    private static parseCommonListParams(url: URL): CommonListParams | { error: string } {
        const pageParam = url.searchParams.get('page');
        const pageSizeParam = url.searchParams.get('pageSize');
        const sortByRaw = (url.searchParams.get('sortBy') || url.searchParams.get('sort') || ProfitForecastController.DEFAULT_SORT_BY).trim();
        const sortOrderRaw = (url.searchParams.get('sortOrder') || url.searchParams.get('order') || '').trim().toLowerCase();

        let page = 1;
        if (pageParam) {
            const parsed = Number(pageParam);
            if (!Number.isInteger(parsed) || parsed < 1) return { error: 'Invalid page - page 必须是大于0的整数' };
            page = parsed;
        }

        let pageSize = ProfitForecastController.DEFAULT_PAGE_SIZE;
        if (pageSizeParam) {
            const parsed = Number(pageSizeParam);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > ProfitForecastController.MAX_PAGE_SIZE) return { error: `Invalid pageSize - pageSize 必须是 1-${ProfitForecastController.MAX_PAGE_SIZE} 的整数` };
            pageSize = parsed;
        }

        if (!ProfitForecastController.ALLOWED_SORT_BY.has(sortByRaw as ForecastSortBy)) return { error: 'Invalid sortBy - 仅支持 symbol / forecast_netprofit_yoy / update_time / net_profit_growth / eps_growth' };
        const sortBy = sortByRaw as ForecastSortBy;

        const defaultOrder: ForecastSortOrder = sortBy === 'symbol' ? 'asc' : 'desc';
        const finalSortOrder = (sortOrderRaw || defaultOrder) as ForecastSortOrder;
        if (!ProfitForecastController.ALLOWED_SORT_ORDER.has(finalSortOrder)) return { error: 'Invalid sortOrder - 仅支持 asc 或 desc' };

        return { page, pageSize, sortBy, sortOrder: finalSortOrder };
    }

    private static buildOrderBy(sortBy: ForecastSortBy, sortOrder: ForecastSortOrder): string {
        const order = sortOrder.toUpperCase();
        if (sortBy === 'symbol') return `l.symbol ${order}`;
        if (sortBy === 'update_time') return `l.update_time ${order} NULLS LAST, l.symbol ASC`;
        if (sortBy === 'net_profit_forecast') return `l.forecast_netprofit IS NULL ASC, l.forecast_netprofit ${order}, l.symbol ASC`;
        if (sortBy === 'eps_forecast') return `l.forecast_eps IS NULL ASC, l.forecast_eps ${order}, l.symbol ASC`;
        if (sortBy === 'eps_growth') return `l.forecast_eps_yoy IS NULL ASC, l.forecast_eps_yoy ${order}, l.symbol ASC`;
        // net_profit_growth 或默认
        return `l.forecast_netprofit_yoy IS NULL ASC, l.forecast_netprofit_yoy ${order}, l.symbol ASC`;
    }

    /**
     * 解析摘要文本，提取结构化字段
     * 示例：截至2026-06-22，6个月以内共有 4 家机构对汽轮科技的2026年度业绩作出预测；
     *       预测2026年每股收益 0.34 元，较去年同比增长 5051.52%，
     *       预测2026年净利润 5.11 亿元，较去年同比增长 22652.89%
     */
    private static parseSummary(summary: string): ParsedSummary {
        const result: ParsedSummary = { institutionCount: 0, eps: '', epsGrowth: '', netProfit: '', netProfitGrowth: '' };
        if (!summary) return result;

        // 机构数量
        const instMatch = summary.match(/共有\s*(\d+)\s*家/);
        if (instMatch) result.institutionCount = parseInt(instMatch[1], 10);

        // 每股收益 + 增长率
        const epsMatch = summary.match(/预测\d{4}年每股收益\s*([\d.]+)\s*元[^，,。；;]*?(?:，|,)较去年同比增长\s*([\d.]+)%/);
        if (epsMatch) {
            result.eps = epsMatch[1];
            result.epsGrowth = `${epsMatch[2]}%`;
        }

        // 净利润 + 增长率 (可能有"亿元"或"万元")
        const npMatch = summary.match(/预测\d{4}年净利润\s*([\d.]+)\s*(亿元|万元)[^，,。；;]*?(?:，|,)较去年同比增长\s*([\d.]+)%/);
        if (npMatch) {
            result.netProfit = `${npMatch[1]}${npMatch[2] === '万元' ? '万' : '亿'}`;
            result.netProfitGrowth = `${npMatch[3]}%`;
        }

        return result;
    }

    private static mapForecastRow(row: ForecastListRow) {
        const parsed = this.parseSummary(row.summary || '');
        return {
            '股票代码': row.symbol,
            '股票简称': row.stock_name || '',
            '更新时间': row.update_time,
            '净利润同比(%)': this.parseForecastNetProfitYoy(row.forecast_netprofit_yoy),
            '摘要': row.summary || '',
            '净利润预测': parsed.netProfit,
            'EPS预测': parsed.eps,
            'EPS同比': parsed.epsGrowth,
            '机构数量': parsed.institutionCount,
            '_净利润预测值': this.parseForecastNetProfitYoy(row.forecast_netprofit),
            '_EPS预测值': this.parseForecastNetProfitYoy(row.forecast_eps),
            '_EPS同比值': this.parseForecastNetProfitYoy(row.forecast_eps_yoy),
        };
    }

    static async getThsForecast(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const symbol = String(req.params.symbol || '');
        if (!symbol) {
            createResponse(res, 400, '缺少 symbol 参数');
            return;
        }

        const source = `同花顺 http://basic.10jqka.com.cn/${symbol}/worth.html`;

        try {
            if (req.method === 'GET') {
                const result = await pool.query(
                    `SELECT update_time, summary, forecast_detail, forecast_netprofit_yoy
                     FROM earnings_forecast
                     WHERE symbol = $1
                     ORDER BY update_time DESC
                     LIMIT 1`,
                    [symbol],
                );
                const latest = result.rows[0] as EarningsForecastRow | undefined;

                if (!latest) {
                    createResponse(res, 404, `未找到该股票的盈利预测记录: ${symbol}`);
                    return;
                }

                createResponse(res, 200, 'success', {
                    '股票代码': symbol,
                    '来源': source,
                    '更新时间': latest.update_time,
                    '摘要': latest.summary || '',
                    '净利润同比(%)': this.parseForecastNetProfitYoy(latest.forecast_netprofit_yoy),
                    '业绩预测详表_详细指标预测': this.parseForecastDetail(latest.forecast_detail),
                });
                return;
            }

            if (req.method === 'POST') {
                const data = await ThsService.getProfitForecast(symbol);
                const now = Date.now();
                const updateTime = this.formatToChinaTimeWithMs(now);
                const summary = typeof data['摘要'] === 'string' ? data['摘要'] : '';
                const forecastNetProfitYoy = this.extractForecastNetProfitYoy(summary);
                const forecastNetprofit = this.extractNumericFromSummary(summary, /预测\d{4}年净利润\s*([\d.]+)\s*亿元/);
                const forecastEps = this.extractNumericFromSummary(summary, /预测\d{4}年每股收益\s*([\d.]+)\s*元/);
                const forecastEpsYoy = this.extractNumericFromSummary(summary, /每股收益[\s\S]*?较去年同比增长\s*([\d.]+)%/);

                await pool.query(
                    `INSERT INTO earnings_forecast (symbol, update_time, summary, forecast_detail, forecast_netprofit_yoy, forecast_netprofit, forecast_eps, forecast_eps_yoy)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (symbol) DO UPDATE SET
                        update_time = EXCLUDED.update_time,
                        summary = EXCLUDED.summary,
                        forecast_detail = EXCLUDED.forecast_detail,
                        forecast_netprofit_yoy = EXCLUDED.forecast_netprofit_yoy,
                        forecast_netprofit = EXCLUDED.forecast_netprofit,
                        forecast_eps = EXCLUDED.forecast_eps,
                        forecast_eps_yoy = EXCLUDED.forecast_eps_yoy`,
                    [symbol, updateTime, summary, JSON.stringify(data['业绩预测详表_详细指标预测'] ?? []), forecastNetProfitYoy, forecastNetprofit, forecastEps, forecastEpsYoy],
                );

                createResponse(res, 200, 'success', {
                    '股票代码': symbol,
                    '来源': source,
                    '更新时间': updateTime,
                    '净利润同比(%)': forecastNetProfitYoy,
                    ...data,
                });
                return;
            }

            createResponse(res, 405, 'Method Not Allowed - 仅支持 GET/POST');
        } catch (error: any) {
            createResponse(res, 500, error.message);
        }
    }

    static async getForecastList(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const url = new URL(req.originalUrl, `http://${req.get('host')}`);
        const parsed = this.parseCommonListParams(url);
        if ('error' in parsed) {
            createResponse(res, 400, parsed.error);
            return;
        }

        const { page, pageSize, sortBy, sortOrder } = parsed;
        const offset = (page - 1) * pageSize;
        const orderBy = this.buildOrderBy(sortBy, sortOrder);

        try {
            const countQuery = `${LATEST_FORECAST_CTE} SELECT COUNT(*) AS total FROM latest l WHERE l.forecast_netprofit_yoy IS NOT NULL`;
            const countResult = await pool.query(countQuery);
            const total = Number(countResult.rows[0]?.total) || 0;
            const totalPages = Math.ceil(total / pageSize);

            const dataQuery = `${LATEST_FORECAST_CTE}
                SELECT l.symbol, s.name AS stock_name, l.update_time, l.summary, l.forecast_netprofit_yoy, l.forecast_detail,
                       l.forecast_netprofit, l.forecast_eps, l.forecast_eps_yoy
                FROM latest l
                LEFT JOIN stocks s ON s.symbol = l.symbol
                WHERE l.forecast_netprofit_yoy IS NOT NULL
                ORDER BY ${orderBy}
                LIMIT $1 OFFSET $2`;
            const dataResult = await pool.query(dataQuery, [pageSize, offset]);

            const list = dataResult.rows.map(item => this.mapForecastRow(item as ForecastListRow));
            createResponse(res, 200, 'success', {
                '数据源': 'PostgreSQL',
                '排序字段': sortBy,
                '排序方向': sortOrder,
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '盈利预测列表': list,
            });
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    static async searchForecastList(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const url = new URL(req.originalUrl, `http://${req.get('host')}`);
        const keyword = (url.searchParams.get('keyword') || url.searchParams.get('q') || '').trim();
        if (!keyword) {
            createResponse(res, 400, '缺少 keyword 参数');
            return;
        }
        if (keyword.length > 30) {
            createResponse(res, 400, 'keyword 长度不能超过30个字符');
            return;
        }

        const parsed = this.parseCommonListParams(url);
        if ('error' in parsed) {
            createResponse(res, 400, parsed.error);
            return;
        }

        const { page, pageSize, sortBy, sortOrder } = parsed;
        const offset = (page - 1) * pageSize;
        const orderBy = this.buildOrderBy(sortBy, sortOrder);
        const keywordPattern = `%${keyword}%`;

        try {
            const countQuery = `${LATEST_FORECAST_CTE}
                SELECT COUNT(*) AS total
                FROM latest l
                LEFT JOIN stocks s ON s.symbol = l.symbol
                WHERE l.forecast_netprofit_yoy IS NOT NULL
                  AND (l.symbol LIKE $1 OR COALESCE(s.name, '') LIKE $1 OR COALESCE(s.pinyin, '') LIKE $1)`;
            const countResult = await pool.query(countQuery, [keywordPattern]);
            const total = Number(countResult.rows[0]?.total) || 0;
            const totalPages = Math.ceil(total / pageSize);

            const dataQuery = `${LATEST_FORECAST_CTE}
                SELECT l.symbol, s.name AS stock_name, l.update_time, l.summary, l.forecast_netprofit_yoy, l.forecast_detail,
                       l.forecast_netprofit, l.forecast_eps, l.forecast_eps_yoy
                FROM latest l
                LEFT JOIN stocks s ON s.symbol = l.symbol
                WHERE l.forecast_netprofit_yoy IS NOT NULL
                  AND (l.symbol LIKE $1 OR COALESCE(s.name, '') LIKE $1 OR COALESCE(s.pinyin, '') LIKE $1)
                ORDER BY ${orderBy}
                LIMIT $2 OFFSET $3`;
            const dataResult = await pool.query(dataQuery, [keywordPattern, pageSize, offset]);

            const list = dataResult.rows.map(item => this.mapForecastRow(item as ForecastListRow));
            createResponse(res, 200, 'success', {
                '数据源': 'PostgreSQL',
                '关键词': keyword,
                '排序字段': sortBy,
                '排序方向': sortOrder,
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '盈利预测列表': list,
            });
        } catch (error: any) {
            createResponse(res, 500, error instanceof Error ? error.message : 'Internal Server Error');
        }
    }

    // ============ 批量爬取 ============
    private static batchStatus = {
        running: false,
        total: 0,
        success: 0,
        failed: 0,
        current: 0,
        currentSymbol: '',
        startedAt: 0,
        finishedAt: 0,
        errors: [] as { symbol: string; error: string }[],
        lastBatchDate: '', // 上次批量爬取日期 YYYY-MM-DD，用于每天一次限制
    };

    static async batchRefresh(req: Request, res: Response, _next: NextFunction): Promise<void> {
        if (ProfitForecastController.batchStatus.running) {
            createResponse(res, 409, '批量爬取正在进行中，请等待完成或查看进度');
            return;
        }

        // 每天最多一次限制：检查今天是否已经爬取过（Redis 持久化 + 内存备份）
        const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
        const redisLastDate = await CacheService.get<string>('profit_forecast:batch:date');
        const lastDate = redisLastDate || ProfitForecastController.batchStatus.lastBatchDate;
        if (lastDate === today) {
            ProfitForecastController.batchStatus.lastBatchDate = today; // 同步内存
            createResponse(res, 429, '今天已经执行过批量爬取，每天最多一次，请明天再试', {
                lastBatchDate: lastDate,
            });
            return;
        }

        let symbols: string[] = [];
        let concurrency = 3;
        let intervalMs = 500;
        let timeoutMs = 15000;
        let maxRetries = 1;

        try {
            const body = req.body || {};
            if (Array.isArray(body.symbols)) {
                symbols = body.symbols.filter((s: any) => typeof s === 'string' && /^\d{6}$/.test(s));
            }
            if (typeof body.concurrency === 'number') concurrency = Math.max(1, Math.min(10, body.concurrency));
            if (typeof body.intervalMs === 'number') intervalMs = Math.max(0, Math.min(5000, body.intervalMs));
            if (typeof body.timeoutMs === 'number') timeoutMs = Math.max(5000, Math.min(60000, body.timeoutMs));
            if (typeof body.maxRetries === 'number') maxRetries = Math.max(0, Math.min(3, body.maxRetries));
        } catch {}

        // 未指定 symbols 则全量
        if (symbols.length === 0) {
            try {
                const result = await pool.query('SELECT symbol FROM stocks ORDER BY symbol');
                symbols = result.rows.map((r: any) => r.symbol).filter((s: string) => /^\d{6}$/.test(s));
            } catch (err: any) {
                createResponse(res, 500, `读取股票列表失败: ${err.message}`);
                return;
            }
        }

        if (symbols.length === 0) {
            createResponse(res, 400, '未找到可爬取的股票代码');
            return;
        }

        // 重置状态并启动后台任务
        ProfitForecastController.batchStatus = {
            running: true,
            total: symbols.length,
            success: 0,
            failed: 0,
            current: 0,
            currentSymbol: '',
            startedAt: Date.now(),
            finishedAt: 0,
            errors: [],
            lastBatchDate: today, // 立即标记今天已爬取，防止并发重复触发
        };
        // 同步写入 Redis（TTL 25 小时，确保跨天后自动失效）
        await CacheService.put('profit_forecast:batch:date', today, 25 * 3600);

        createResponse(res, 200, `批量爬取已启动，共 ${symbols.length} 只股票，并发 ${concurrency}`, {
            total: symbols.length,
            concurrency,
            intervalMs,
            timeoutMs,
            maxRetries,
        });

        // 后台执行，不阻塞响应
        ProfitForecastController.runBatch(symbols, { concurrency, intervalMs, timeoutMs, maxRetries })
            .catch(err => console.error('[ProfitForecast] batchRefresh 异常:', err?.message || err));
    }

    private static async runBatch(
        symbols: string[],
        opts: { concurrency: number; intervalMs: number; timeoutMs: number; maxRetries: number }
    ): Promise<void> {
        const { concurrency, intervalMs, timeoutMs, maxRetries } = opts;
        const queue = [...symbols];
        let cursor = 0;

        async function worker(workerId: number) {
            while (queue.length > 0) {
                const sym = queue.shift();
                if (!sym) break;
                cursor++;
                ProfitForecastController.batchStatus.current = cursor;
                ProfitForecastController.batchStatus.currentSymbol = sym;

                let ok = false;
                let lastErr = '';
                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        const data = await ProfitForecastController.fetchWithTimeout(sym, timeoutMs);
                        const summary = typeof data['摘要'] === 'string' ? data['摘要'] : '';
                        const forecastNetProfitYoy = ProfitForecastController.extractForecastNetProfitYoy(summary);
                        const forecastNetprofit = ProfitForecastController.extractNumericFromSummary(summary, /预测\d{4}年净利润\s*([\d.]+)\s*亿元/);
                        const forecastEps = ProfitForecastController.extractNumericFromSummary(summary, /预测\d{4}年每股收益\s*([\d.]+)\s*元/);
                        const forecastEpsYoy = ProfitForecastController.extractNumericFromSummary(summary, /每股收益[\s\S]*?较去年同比增长\s*([\d.]+)%/);
                        const updateTime = ProfitForecastController.formatToChinaTimeWithMs(Date.now());
                        await pool.query(
                            `INSERT INTO earnings_forecast (symbol, update_time, summary, forecast_detail, forecast_netprofit_yoy, forecast_netprofit, forecast_eps, forecast_eps_yoy)
                             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                             ON CONFLICT (symbol) DO UPDATE SET
                                update_time = EXCLUDED.update_time,
                                summary = EXCLUDED.summary,
                                forecast_detail = EXCLUDED.forecast_detail,
                                forecast_netprofit_yoy = EXCLUDED.forecast_netprofit_yoy,
                                forecast_netprofit = EXCLUDED.forecast_netprofit,
                                forecast_eps = EXCLUDED.forecast_eps,
                                forecast_eps_yoy = EXCLUDED.forecast_eps_yoy`,
                            [sym, updateTime, summary, JSON.stringify(data['业绩预测详表_详细指标预测'] ?? []), forecastNetProfitYoy, forecastNetprofit, forecastEps, forecastEpsYoy],
                        );
                        ok = true;
                        break;
                    } catch (err: any) {
                        lastErr = err?.message || String(err);
                        if (attempt < maxRetries) {
                            await new Promise(r => setTimeout(r, 800 * (attempt + 1)));
                        }
                    }
                }

                if (ok) {
                    ProfitForecastController.batchStatus.success++;
                } else {
                    ProfitForecastController.batchStatus.failed++;
                    ProfitForecastController.batchStatus.errors.push({ symbol: sym, error: lastErr });
                    if (ProfitForecastController.batchStatus.errors.length > 200) {
                        ProfitForecastController.batchStatus.errors.shift();
                    }
                }

                if (intervalMs > 0) {
                    await new Promise(r => setTimeout(r, intervalMs));
                }
            }
        }

        const workers = Array.from({ length: concurrency }, (_, i) => worker(i));
        await Promise.all(workers);

        ProfitForecastController.batchStatus.running = false;
        ProfitForecastController.batchStatus.finishedAt = Date.now();
        ProfitForecastController.batchStatus.currentSymbol = '';
        const cost = ((ProfitForecastController.batchStatus.finishedAt - ProfitForecastController.batchStatus.startedAt) / 1000).toFixed(1);
        console.log(`[ProfitForecast] 批量爬取完成: 成功 ${ProfitForecastController.batchStatus.success}/${ProfitForecastController.batchStatus.total}, 耗时 ${cost}秒`);
    }

    private static async fetchWithTimeout(symbol: string, timeoutMs: number): Promise<Record<string, any>> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            // ThsService 不支持 abort，这里直接内联实现以便控制超时
            const url = `http://basic.10jqka.com.cn/${symbol}/worth.html`;
            const response = await sessionFetch(url, {
                headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
                signal: controller.signal,
            });
            if (!response.ok) throw new Error(`同花顺接口请求失败: ${response.status}`);
            const arrayBuffer = await response.arrayBuffer();
            const html = new TextDecoder('gbk').decode(arrayBuffer);
            const cleanHtml = html
                .replace(/<script[\s\S]*?<\/script>/gi, '')
                .replace(/<style[\s\S]*?<\/style>/gi, '')
                .replace(/<!--[\s\S]*?-->/g, '');
            const cheerio = await import('cheerio');
            const $ = cheerio.load(cleanHtml, { scriptingEnabled: false });
            const result: Record<string, any> = { '摘要': '', '业绩预测详表_详细指标预测': [] };
            result['摘要'] = $('#forecast > div.bd > p.tip.clearfix').text().trim().replace(/\s+/g, ' ');
            const detailTable = $('#forecastdetail > div.bd > table.m_table.m_hl.ggintro.ggintro_1.organData');
            if (detailTable.length > 0) {
                const { parseTable } = await import('../../shared/utils/parser');
                result['业绩预测详表_详细指标预测'] = parseTable($, detailTable[0], '业绩预测详表-详细指标预测');
            }
            return result;
        } finally {
            clearTimeout(timer);
        }
    }

    static async getBatchStatus(_req: Request, res: Response, _next: NextFunction): Promise<void> {
        const s = ProfitForecastController.batchStatus;
        const elapsedMs = s.running ? Date.now() - s.startedAt : (s.finishedAt - s.startedAt);
        const progress = s.total > 0 ? Math.round((s.current / s.total) * 100) : 0;
        const today = new Date().toISOString().slice(0, 10);
        // 优先从 Redis 读取（持久化），内存作为备份
        const redisLastDate = await CacheService.get<string>('profit_forecast:batch:date');
        const lastBatchDate = redisLastDate || s.lastBatchDate;
        createResponse(res, 200, 'success', {
            running: s.running,
            total: s.total,
            success: s.success,
            failed: s.failed,
            current: s.current,
            currentSymbol: s.currentSymbol,
            progress,
            elapsedMs,
            startedAt: s.startedAt,
            finishedAt: s.finishedAt,
            recentErrors: s.errors.slice(-20),
            lastBatchDate,
            canBatchToday: lastBatchDate !== today, // 今天是否还可以批量爬取
        });
    }
}
