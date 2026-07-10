import pool from '../../core/db';
import { tushareRequest } from '../quote/TushareService';
import { pinyin } from 'pinyin-pro';

/**
 * 股票基础数据同步服务
 * 从 Tushare stock_basic 同步到 stocks 表，保持股票列表完整（新股、退市股）
 */
export class StockSyncService {
    /** 生成拼音首字母（如"华控赛格"→"hksg"） */
    private static toPinyinInitials(name: string): string {
        if (!name) return '';
        try {
            const py = pinyin(name, { toneType: 'none', type: 'array' }) as string[];
            return py.map(s => s.charAt(0)).join('');
        } catch {
            return '';
        }
    }

    /** ts_code 后缀转 market（000001.SZ→sz） */
    private static tsCodeToMarket(tsCode: string): string {
        const suffix = tsCode.split('.')[1]?.toUpperCase() || '';
        if (suffix === 'SH') return 'sh';
        if (suffix === 'SZ') return 'sz';
        if (suffix === 'BJ') return 'bj';
        return suffix.toLowerCase();
    }

    /**
     * 执行同步：从 Tushare stock_basic 全量同步到 stocks 表
     * - 新增：插入新股
     * - 更新：刷新 name/industry/market
     * - 退市：从 Tushare 返回的 list_status=L 不含退市股，但不会主动删除（保留历史记录）
     */
    static async sync(): Promise<{ inserted: number; updated: number; total: number }> {
        console.log('[StockSync] 开始从 Tushare 同步股票基础数据...');

        const rows = await tushareRequest(
            'stock_basic',
            { exchange: '', list_status: 'L' },
            'ts_code,symbol,name,market,industry',
        );

        console.log(`[StockSync] Tushare 返回 ${rows.length} 条上市股票`);

        let inserted = 0;
        let updated = 0;

        for (const row of rows) {
            const symbol = (row.symbol || '').trim();
            const name = (row.name || '').trim();
            const industry = (row.industry || '').trim();
            const market = this.tsCodeToMarket(row.ts_code || '');
            const py = this.toPinyinInitials(name);

            if (!symbol || !name) continue;

            try {
                const result = await pool.query(
                    `INSERT INTO stocks (symbol, name, pinyin, market, industry)
                     VALUES ($1, $2, $3, $4, $5)
                     ON CONFLICT (symbol) DO UPDATE SET
                       name = EXCLUDED.name,
                       pinyin = COALESCE(NULLIF(stocks.pinyin, ''), EXCLUDED.pinyin),
                       market = EXCLUDED.market,
                       industry = EXCLUDED.industry
                     RETURNING (xmax = 0) AS inserted`,
                    [symbol, name, py, market, industry],
                );

                if (result.rows[0]?.inserted) {
                    inserted++;
                } else {
                    updated++;
                }
            } catch (err) {
                console.error(`[StockSync] 同步 ${symbol} 失败:`, err);
            }
        }

        console.log(`[StockSync] 同步完成: 新增 ${inserted}，更新 ${updated}，总计 ${rows.length}`);
        return { inserted, updated, total: rows.length };
    }
}
