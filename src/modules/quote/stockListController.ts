import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import pool from '../../core/db';

export class StockListController {
    private static readonly DEFAULT_PAGE_SIZE = 50;
    private static readonly MAX_PAGE_SIZE = 500;

    static async getStockList(req: Request, res: Response, _next: NextFunction): Promise<void> {
        const pageParam = req.query.page as string;
        const pageSizeParam = req.query.pageSize as string;
        const keyword = (req.query.keyword as string)?.trim();
        const symbol = (req.query.symbol as string)?.trim();
        const market = (req.query.market as string)?.trim()?.toUpperCase();

        let page = 1;
        if (pageParam) {
            const parsed = Number(pageParam);
            if (!Number.isInteger(parsed) || parsed < 1) {
                createResponse(res, 400, 'Invalid page - page 必须是大于0的整数');
                return;
            }
            page = parsed;
        }

        let pageSize = StockListController.DEFAULT_PAGE_SIZE;
        if (pageSizeParam) {
            const parsed = Number(pageSizeParam);
            if (!Number.isInteger(parsed) || parsed < 1 || parsed > StockListController.MAX_PAGE_SIZE) {
                createResponse(res, 400, `Invalid pageSize - pageSize 必须是 1-${StockListController.MAX_PAGE_SIZE} 的整数`);
                return;
            }
            pageSize = parsed;
        }

        if (symbol && symbol.length > 8) {
            createResponse(res, 400, 'symbol 长度不能超过8个字符');
            return;
        }
        if (keyword && keyword.length > 10) {
            createResponse(res, 400, '关键词长度不能超过10个字符');
            return;
        }
        if (market && market.length > 6) {
            createResponse(res, 400, 'market 长度不能超过6个字符');
            return;
        }

        try {
            const offset = (page - 1) * pageSize;

            let countQuery = 'SELECT COUNT(*) as total FROM stocks';
            let dataQuery = 'SELECT symbol, name, market, industry FROM stocks';
            const whereConditions: string[] = [];
            const countParams: any[] = [];
            const dataParams: any[] = [];
            let paramIdx = 1;

            if (symbol) {
                whereConditions.push(`symbol = $${paramIdx}`);
                countParams.push(symbol);
                dataParams.push(symbol);
                paramIdx++;
            } else if (keyword) {
                whereConditions.push(`(symbol LIKE $${paramIdx} OR name LIKE $${paramIdx} OR pinyin LIKE $${paramIdx})`);
                const keywordPattern = `%${keyword}%`;
                countParams.push(keywordPattern);
                dataParams.push(keywordPattern);
                paramIdx++;
            }

            if (market) {
                whereConditions.push(`market = $${paramIdx}`);
                countParams.push(market);
                dataParams.push(market);
                paramIdx++;
            }

            if (whereConditions.length > 0) {
                const whereClause = ' WHERE ' + whereConditions.join(' AND ');
                countQuery += whereClause;
                dataQuery += whereClause;
            }

            dataQuery += ` ORDER BY symbol LIMIT $${paramIdx} OFFSET $${paramIdx + 1}`;

            const countResult = await pool.query(countQuery, countParams);
            const total = Number(countResult.rows[0]?.total) || 0;
            const totalPages = Math.ceil(total / pageSize);

            const dataResult = await pool.query(dataQuery, [...dataParams, pageSize, offset]);

            const stockList = dataResult.rows.map((stock: any) => ({
                '股票代码': stock.symbol,
                '股票简称': stock.name,
                '市场代码': stock.market,
                '所属行业': stock.industry || '',
            }));

            createResponse(res, 200, 'success', {
                '数据源': 'PostgreSQL',
                '当前页': page,
                '每页数量': pageSize,
                '总数量': total,
                '总页数': totalPages,
                '股票列表': stockList,
            });
        } catch (err: any) {
            console.error('Error fetching stock list:', err);
            createResponse(res, 500, err instanceof Error ? err.message : 'Internal Server Error');
        }
    }
}
