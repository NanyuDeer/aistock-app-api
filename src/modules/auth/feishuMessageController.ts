/**
 * 飞书消息接收控制器
 *
 * 接收 feishu_ws_bot 推送的群消息数据
 * 存储到数据库供风口爆发检测使用
 */

import { Request, Response, NextFunction } from 'express';
import { createResponse } from '../../shared/utils/response';
import pool from '../../core/db';
import { extractStockCodes, loadStockNameMap } from '../monitor/HotKeywordDetectorService';

const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN || 'crawler-int-2026-token';

function verifyInternalToken(req: Request): boolean {
    const headerToken = req.headers['x-internal-token'];
    const bearerToken = req.headers.authorization?.replace('Bearer ', '');
    const token = String(Array.isArray(headerToken) ? headerToken[0] : headerToken || '') || bearerToken || '';
    return token === INTERNAL_TOKEN;
}

async function ensureSchema(): Promise<void> {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS feishu_messages (
            id SERIAL PRIMARY KEY,
            source TEXT NOT NULL DEFAULT 'feishu',
            chat_id TEXT NOT NULL DEFAULT '',
            chat_name TEXT NOT NULL DEFAULT '',
            message_id TEXT NOT NULL DEFAULT '',
            message_type TEXT NOT NULL DEFAULT '',
            text TEXT NOT NULL DEFAULT '',
            stock_codes TEXT[] DEFAULT '{}',
            keywords JSONB DEFAULT '[]',
            received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_fm_chat_id ON feishu_messages(chat_id);
        CREATE INDEX IF NOT EXISTS idx_fm_message_id ON feishu_messages(message_id);
        CREATE INDEX IF NOT EXISTS idx_fm_received_at ON feishu_messages(received_at);
        CREATE INDEX IF NOT EXISTS idx_fm_stock_codes ON feishu_messages USING GIN(stock_codes);
    `);
}

export class FeishuMessageController {
    /**
     * POST /api/internal/feishu-message
     * 内部接口：接收飞书群消息推送
     */
    static async receiveMessage(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!verifyInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const data = req.body;
            if (!data || !data.message_id) {
                createResponse(res, 400, '数据格式错误，需要包含 message_id');
                return;
            }

            await ensureSchema();

            // 去重检查
            const existing = await pool.query(
                'SELECT id FROM feishu_messages WHERE message_id = $1 LIMIT 1',
                [data.message_id],
            );
            if (existing.rows.length > 0) {
                createResponse(res, 200, 'duplicate', { message_id: data.message_id });
                return;
            }

            // 如果 bot 未提取到 stock_codes，用 extractStockCodes 从 text 中重新提取
            // 这能识别 OCR 文本中的股票名称（如"中际旭创"→300308）
            let stockCodes = data.stock_codes || [];
            const textContent = data.text || '';
            if (stockCodes.length === 0 && textContent) {
                try {
                    await loadStockNameMap();
                    const extracted = extractStockCodes(textContent);
                    stockCodes = Array.from(extracted.keys());
                    if (stockCodes.length > 0) {
                        console.log(`[FeishuMessage] 从text中提取到${stockCodes.length}个股票代码: ${JSON.stringify(stockCodes)}`);
                    }
                } catch (err) {
                    console.warn('[FeishuMessage] extractStockCodes 失败:', (err as Error).message);
                }
            }

            await pool.query(
                `INSERT INTO feishu_messages (source, chat_id, chat_name, message_id, message_type, text, stock_codes, keywords, received_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    data.source || 'feishu',
                    data.chat_id || '',
                    data.chat_name || '',
                    data.message_id,
                    data.message_type || '',
                    textContent,
                    stockCodes,
                    JSON.stringify(data.keywords || []),
                    data.received_at || new Date().toISOString(),
                ],
            );

            console.log(`[FeishuMessage] 收到飞书群消息: chat=${data.chat_name}, codes=${JSON.stringify(stockCodes)}, keywords=${JSON.stringify((data.keywords || []).map((k: any) => k.keyword))}`);
            createResponse(res, 200, 'success', { message_id: data.message_id });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuMessage] receiveMessage error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }

    /**
     * GET /api/internal/feishu-messages
     * 内部接口：查询飞书群消息（供风口爆发检测使用）
     *
     * Query params:
     *   - hours: 查询最近N小时，默认6
     *   - limit: 返回数量，默认50
     */
    static async getMessages(req: Request, res: Response, _next: NextFunction): Promise<void> {
        try {
            if (!verifyInternalToken(req)) {
                createResponse(res, 401, 'invalid internal token');
                return;
            }

            const hours = Math.min(Math.max(parseInt(String(req.query.hours || '6'), 10), 1), 72);
            const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10), 1), 200);

            await ensureSchema();

            const result = await pool.query(
                `SELECT id, source, chat_id, chat_name, message_id, message_type, text, stock_codes, keywords, received_at
                 FROM feishu_messages
                 WHERE received_at > NOW() - INTERVAL '${hours} hours'
                 ORDER BY received_at DESC
                 LIMIT $1`,
                [limit],
            );

            createResponse(res, 200, 'success', {
                count: result.rows.length,
                messages: result.rows.map((row: any) => ({
                    ...row,
                    keywords: typeof row.keywords === 'string' ? JSON.parse(row.keywords) : row.keywords,
                })),
            });
        } catch (err: any) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error('[FeishuMessage] getMessages error:', errMsg);
            createResponse(res, 500, errMsg);
        }
    }
}
