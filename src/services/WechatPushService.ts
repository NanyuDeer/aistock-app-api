import pool from '../db';
import { ScanLoginController } from '../controllers/ScanLoginController';
import { sessionFetch } from '../utils/httpAgent';

export interface MonitorEvent {
    event_id: string;
    symbol: string;
    stock_code: string;
    stock_name: string;
    股票异动: string;
    event_type: string;
    level: string;
    summary: string;
    event_time: string;
    detail_url: string;
}

export interface PushLogItem {
    openid: string;
    status: 'sent' | 'skipped' | 'failed';
    reason: string | null;
    wechat_response?: any;
}

export interface PushResult {
    matched_users: number;
    sent: number;
    skipped: number;
    failed: number;
    logs: PushLogItem[];
}

export interface EnqueueResult {
    queued: boolean;
    reason: string | null;
    queue_size: number;
    event_id: string;
}

export interface StockInfoPushEvent {
    id: number;
    symbol: string;
    stock_name: string | null;
    info_type: string;
    title: string;
    url: string;
    published_at: string | Date;
    ai_impact: string;
    ai_horizon: string;
    ai_keywords: string[];
    ai_summary: string;
}

export interface LeaderStockPushItem {
    name: string;
    code: string;
    industry: string;
    change_pct: number;
    reason: string;
}

export interface OutbreakPushItem {
    name: string;
    code: string;
    sector: string;
    resonance_score: number;
    resonance_level: string;
    trigger_reason: string;
}

export class WechatPushService {
    private static readonly DAILY_LIMIT = 5;
    private static readonly STOCK_COOLDOWN_MINUTES = 30;
    private static readonly QUEUE_MAX = Number(process.env.WECHAT_PUSH_QUEUE_MAX || 5000);
    private static readonly QUEUE_INTERVAL_MS = Number(process.env.WECHAT_PUSH_QUEUE_INTERVAL_MS || 300);
    private static readonly LEVEL_RANK: Record<string, number> = {
        L1: 1,
        L2: 2,
        L3: 3,
        L4: 4,
    };
    private static readonly EVENT_TYPE_SETTING_MAP: Record<string, string> = {
        '短线异动': 'push_tag_short_term',
        '中线异动': 'push_tag_mid_term',
        '长线异动': 'push_tag_long_term',
    };
    private static pushQueue: MonitorEvent[] = [];
    private static queuedEventIds = new Set<string>();
    private static processingQueue = false;

    private static log(stage: string, message: string, data?: any): void {
        const ts = new Date().toISOString();
        const detail = data !== undefined ? ` | ${JSON.stringify(data)}` : '';
        console.log(`[WechatPush][${stage}] ${ts} ${message}${detail}`);
    }

    private static buildDetailUrl(detailUrl: string): string {
        if (/^https?:\/\//i.test(detailUrl)) return detailUrl;
        const base = process.env.FRONTEND_URL || '';
        if (!base) return detailUrl;
        return `${base.replace(/\/+$/, '')}/${detailUrl.replace(/^\/+/, '')}`;
    }

    private static formatEventTime(eventTime: string): string {
        if (!eventTime) return '';
        const normalized = eventTime.replace('T', ' ');
        const match = normalized.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
        return match ? `${match[1]} ${match[2]}` : eventTime;
    }

    private static async isPushEnabled(openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT enabled
             FROM user_settings
             WHERE openid = $1 AND setting_type = 'stock_push'
             LIMIT 1`,
            [openid],
        );
        const setting = result.rows[0];
        return !setting || Number(setting.enabled) !== 0;
    }

    private static async isEventTypeMatched(openid: string, eventType: string): Promise<boolean> {
        const requiredSetting = WechatPushService.EVENT_TYPE_SETTING_MAP[eventType];
        if (!requiredSetting) return true;

        const result = await pool.query(
            `SELECT setting_type, enabled
             FROM user_settings
             WHERE openid = $1
               AND setting_type IN ('push_tag_short_term', 'push_tag_mid_term', 'push_tag_long_term')`,
            [openid],
        );

        const settings = result.rows || [];
        if (settings.length === 0) {
            return true;
        }

        return settings.some((item: any) =>
            item.setting_type === requiredSetting && Number(item.enabled) === 1,
        );
    }

    private static async hasPushed(eventId: string, openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT id
             FROM wechat_push_logs
             WHERE event_id = $1 AND openid = $2
             LIMIT 1`,
            [eventId, openid],
        );
        return (result.rowCount || 0) > 0;
    }

    private static async isOverDailyLimit(openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT COUNT(*)::int AS count
             FROM wechat_push_logs
             WHERE openid = $1
               AND status = 'sent'
               AND sent_at::date = CURRENT_DATE`,
            [openid],
        );
        return Number(result.rows[0]?.count || 0) >= WechatPushService.DAILY_LIMIT;
    }

    private static getLevelRank(level: string): number {
        return WechatPushService.LEVEL_RANK[String(level || '').toUpperCase()] || 0;
    }

    private static isLowPriorityLevel(level: string): boolean {
        return WechatPushService.getLevelRank(level) <= WechatPushService.LEVEL_RANK.L1;
    }

    private static async isInStockCooldown(event: MonitorEvent, openid: string): Promise<boolean> {
        const result = await pool.query(
            `SELECT level
             FROM wechat_push_logs
             WHERE openid = $1
               AND symbol = $2
               AND status = 'sent'
               AND sent_at >= CURRENT_TIMESTAMP - ($3::text || ' minutes')::interval
             ORDER BY sent_at DESC
             LIMIT 1`,
            [openid, event.symbol, WechatPushService.STOCK_COOLDOWN_MINUTES],
        );

        const lastSent = result.rows[0];
        if (!lastSent) return false;

        const currentRank = WechatPushService.getLevelRank(event.level);
        const lastRank = WechatPushService.getLevelRank(lastSent.level);
        return currentRank <= lastRank;
    }

    private static async insertPushLog(
        event: MonitorEvent,
        openid: string,
        status: PushLogItem['status'],
        errorMsg: string | null,
        responseJson: any,
    ): Promise<void> {
        await pool.query(
            `INSERT INTO wechat_push_logs (
                event_id,
                openid,
                symbol,
                stock_name,
                event_type,
                level,
                summary,
                template_id,
                status,
                error_msg,
                wechat_response_json,
                click_url
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             ON CONFLICT(event_id, openid) DO NOTHING`,
            [
                event.event_id,
                openid,
                event.symbol,
                event.stock_name,
                event.event_type,
                event.level,
                event.summary,
                process.env.WECHAT_TEMPLATE_ID || '',
                status,
                errorMsg,
                responseJson ? JSON.stringify(responseJson) : null,
                WechatPushService.buildDetailUrl(event.detail_url),
            ],
        );
    }

    private static async sendTemplateMessage(event: MonitorEvent, openid: string): Promise<any> {
        if (!process.env.WECHAT_TEMPLATE_ID) {
            throw new Error('WECHAT_TEMPLATE_ID is not configured');
        }

        const accessToken = await ScanLoginController.getServerAccessToken();
        const detailUrl = WechatPushService.buildDetailUrl(event.detail_url);
        const res = await sessionFetch(
            `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    touser: openid,
                    template_id: process.env.WECHAT_TEMPLATE_ID,
                    url: detailUrl,
                    data: {
                        stock: { value: `${event.stock_name} (${event.symbol})` },
                        event_type: { value: event.event_type },
                        level: { value: event.level },
                        summary: { value: event.summary },
                        time: { value: WechatPushService.formatEventTime(event.event_time) },
                    },
                }),
            },
        );
        const data: any = await res.json();
        if (data.errcode && data.errcode !== 0) {
            throw new Error(`wechat template send failed: ${data.errmsg || data.errcode}`);
        }
        return data;
    }

    static enqueueMonitorEvent(event: MonitorEvent): EnqueueResult {
        if (WechatPushService.queuedEventIds.has(event.event_id)) {
            return {
                queued: false,
                reason: 'duplicate_in_queue',
                queue_size: WechatPushService.pushQueue.length,
                event_id: event.event_id,
            };
        }

        if (WechatPushService.pushQueue.length >= WechatPushService.QUEUE_MAX) {
            WechatPushService.log('queue', 'queue is full, drop event', {
                event_id: event.event_id,
                queue_size: WechatPushService.pushQueue.length,
                queue_max: WechatPushService.QUEUE_MAX,
            });
            return {
                queued: false,
                reason: 'queue_full',
                queue_size: WechatPushService.pushQueue.length,
                event_id: event.event_id,
            };
        }

        WechatPushService.pushQueue.push(event);
        WechatPushService.queuedEventIds.add(event.event_id);
        WechatPushService.startQueueProcessor();

        return {
            queued: true,
            reason: null,
            queue_size: WechatPushService.pushQueue.length,
            event_id: event.event_id,
        };
    }

    private static startQueueProcessor(): void {
        if (WechatPushService.processingQueue) return;
        WechatPushService.processingQueue = true;
        setTimeout(() => {
            void WechatPushService.processNextQueueItem();
        }, 0);
    }

    private static async processNextQueueItem(): Promise<void> {
        const event = WechatPushService.pushQueue.shift();
        if (!event) {
            WechatPushService.processingQueue = false;
            return;
        }

        try {
            await WechatPushService.dispatchMonitorEvent(event);
        } catch (err: any) {
            WechatPushService.log('queue', 'dispatch failed', {
                event_id: event.event_id,
                error: err instanceof Error ? err.message : String(err),
            });
        } finally {
            WechatPushService.queuedEventIds.delete(event.event_id);
        }

        setTimeout(() => {
            void WechatPushService.processNextQueueItem();
        }, WechatPushService.QUEUE_INTERVAL_MS);
    }

    static async dispatchMonitorEvent(event: MonitorEvent): Promise<PushResult> {
        const result = await pool.query(
            `SELECT DISTINCT u.openid
             FROM users u
             INNER JOIN user_stocks us ON u.openid = us.openid
             WHERE us.symbol = $1`,
            [event.symbol],
        );

        const users = result.rows || [];
        const pushResult: PushResult = {
            matched_users: users.length,
            sent: 0,
            skipped: 0,
            failed: 0,
            logs: [],
        };

        for (const user of users) {
            const openid = String(user.openid || '');
            if (!openid) continue;

            if (await WechatPushService.hasPushed(event.event_id, openid)) {
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'duplicate_event' });
                continue;
            }

            if (!(await WechatPushService.isPushEnabled(openid))) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'stock_push_disabled', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'stock_push_disabled' });
                continue;
            }

            if (!(await WechatPushService.isEventTypeMatched(openid, event.event_type))) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'tag_mismatch', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'tag_mismatch' });
                continue;
            }

            if (WechatPushService.isLowPriorityLevel(event.level)) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'low_level', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'low_level' });
                continue;
            }

            if (await WechatPushService.isOverDailyLimit(openid)) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'daily_limit_reached', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'daily_limit_reached' });
                continue;
            }

            if (await WechatPushService.isInStockCooldown(event, openid)) {
                await WechatPushService.insertPushLog(event, openid, 'skipped', 'stock_cooldown', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'stock_cooldown' });
                continue;
            }

            try {
                const wxResponse = await WechatPushService.sendTemplateMessage(event, openid);
                await WechatPushService.insertPushLog(event, openid, 'sent', null, wxResponse);
                pushResult.sent += 1;
                pushResult.logs.push({ openid, status: 'sent', reason: null, wechat_response: wxResponse });
            } catch (err: any) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                WechatPushService.log('send', 'template send failed', {
                    openid,
                    event_id: event.event_id,
                    error: errorMsg,
                });
                await WechatPushService.insertPushLog(event, openid, 'failed', errorMsg, { error: errorMsg });
                pushResult.failed += 1;
                pushResult.logs.push({ openid, status: 'failed', reason: errorMsg });
            }
        }

        return pushResult;
    }

    // ==================== 资讯研判推送（changer 分支） ====================

    private static async insertStockInfoPushLog(
        event: StockInfoPushEvent,
        openid: string,
        status: PushLogItem['status'],
        errorMsg: string | null,
        responseJson: any,
    ): Promise<void> {
        await pool.query(
            `INSERT INTO wechat_push_logs (
                event_id,
                openid,
                symbol,
                stock_name,
                event_type,
                level,
                summary,
                template_id,
                status,
                error_msg,
                wechat_response_json,
                click_url
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12)
             ON CONFLICT(event_id, openid) DO NOTHING`,
            [
                `stock_info:${event.id}`,
                openid,
                event.symbol,
                event.stock_name || event.symbol,
                event.info_type,
                event.ai_impact,
                event.ai_summary,
                process.env.WECHAT_TEMPLATE_ID || '',
                status,
                errorMsg,
                responseJson ? JSON.stringify(responseJson) : null,
                WechatPushService.buildDetailUrl(event.url),
            ],
        );
    }

    private static async sendStockInfoTemplateMessage(event: StockInfoPushEvent, openid: string): Promise<any> {
        if (!process.env.WECHAT_TEMPLATE_ID) {
            throw new Error('WECHAT_TEMPLATE_ID is not configured');
        }

        const accessToken = await ScanLoginController.getServerAccessToken();
        const detailUrl = WechatPushService.buildDetailUrl(event.url);
        const title = event.title.length > 40 ? `${event.title.slice(0, 40)}...` : event.title;
        const res = await sessionFetch(
            `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    touser: openid,
                    template_id: process.env.WECHAT_TEMPLATE_ID,
                    url: detailUrl,
                    data: {
                        stock: { value: `${event.stock_name || event.symbol} (${event.symbol})` },
                        event_type: { value: `${event.info_type === 'announcement' ? '公告' : '新闻'}研判` },
                        level: { value: `${event.ai_impact}/${event.ai_horizon}` },
                        summary: { value: event.ai_summary || title },
                        time: { value: WechatPushService.formatEventTime(new Date(event.published_at).toISOString()) },
                    },
                }),
            },
        );
        const data: any = await res.json();
        if (data.errcode && data.errcode !== 0) {
            throw new Error(`wechat template send failed: ${data.errmsg || data.errcode}`);
        }
        return data;
    }

    static async dispatchStockInfoJudgement(event: StockInfoPushEvent): Promise<PushResult> {
        const result = await pool.query(
            `SELECT DISTINCT u.openid
             FROM users u
             INNER JOIN user_stocks us ON u.openid = us.openid
             WHERE us.symbol = $1`,
            [event.symbol],
        );

        const users = result.rows || [];
        const pushResult: PushResult = {
            matched_users: users.length,
            sent: 0,
            skipped: 0,
            failed: 0,
            logs: [],
        };

        const eventId = `stock_info:${event.id}`;
        for (const user of users) {
            const openid = String(user.openid || '');
            if (!openid) continue;

            if (await WechatPushService.hasPushed(eventId, openid)) {
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'duplicate_event' });
                continue;
            }

            if (!(await WechatPushService.isPushEnabled(openid))) {
                await WechatPushService.insertStockInfoPushLog(event, openid, 'skipped', 'stock_push_disabled', null);
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'stock_push_disabled' });
                continue;
            }

            try {
                const wxResponse = await WechatPushService.sendStockInfoTemplateMessage(event, openid);
                await WechatPushService.insertStockInfoPushLog(event, openid, 'sent', null, wxResponse);
                pushResult.sent += 1;
                pushResult.logs.push({ openid, status: 'sent', reason: null, wechat_response: wxResponse });
            } catch (err: any) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                WechatPushService.log('sendStockInfo', 'template send failed', {
                    openid,
                    event_id: eventId,
                    error: errorMsg,
                });
                await WechatPushService.insertStockInfoPushLog(event, openid, 'failed', errorMsg, { error: errorMsg });
                pushResult.failed += 1;
                pushResult.logs.push({ openid, status: 'failed', reason: errorMsg });
            }
        }

        return pushResult;
    }

    // ==================== 龙头股推送 ====================

    private static async getAllWechatOpenids(): Promise<string[]> {
        // 推送给所有已注册的微信用户
        const result = await pool.query(
            `SELECT DISTINCT openid FROM users WHERE openid IS NOT NULL AND openid <> ''`,
        );
        return result.rows.map((r: any) => String(r.openid));
    }

    /** 获取订阅了指定推送类型的微信用户 */
    private static async getSubscribedWechatOpenids(settingType: string): Promise<string[]> {
        const result = await pool.query(
            `SELECT DISTINCT u.openid
             FROM users u
             INNER JOIN user_settings us ON u.openid = us.openid
             WHERE u.openid IS NOT NULL
               AND u.openid <> ''
               AND us.setting_type = $1
               AND COALESCE(us.enabled, 1) != 0`,
            [settingType],
        );
        return result.rows.map((r: any) => String(r.openid));
    }

    private static formatChangePct(pct: number): string {
        if (pct > 0) return `+${pct.toFixed(2)}%`;
        return `${pct.toFixed(2)}%`;
    }

    static async dispatchLeaderStocks(stocks: LeaderStockPushItem[], force: boolean = false): Promise<PushResult> {
        // 只推送给订阅了龙头股推送的用户
        const openids = await WechatPushService.getSubscribedWechatOpenids('leader_push');
        const today = new Date().toISOString().slice(0, 10);
        const eventId = `leader:${today}`;

        const pushResult: PushResult = {
            matched_users: openids.length,
            sent: 0,
            skipped: 0,
            failed: 0,
            logs: [],
        };

        for (const openid of openids) {
            if (!force && await WechatPushService.hasPushed(eventId, openid)) {
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'duplicate_event' });
                continue;
            }

            try {
                const wxResponse = await WechatPushService.sendLeaderTemplateMessage(stocks, openid);
                await WechatPushService.insertLeaderPushLog(eventId, openid, 'sent', null, wxResponse, stocks);
                pushResult.sent += 1;
                pushResult.logs.push({ openid, status: 'sent', reason: null, wechat_response: wxResponse });
            } catch (err: any) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                WechatPushService.log('leader', 'template send failed', { openid, event_id: eventId, error: errorMsg });
                await WechatPushService.insertLeaderPushLog(eventId, openid, 'failed', errorMsg, null, stocks);
                pushResult.failed += 1;
                pushResult.logs.push({ openid, status: 'failed', reason: errorMsg });
            }
        }

        return pushResult;
    }

    private static async sendLeaderTemplateMessage(stocks: LeaderStockPushItem[], openid: string): Promise<any> {
        const templateId = process.env.WECHAT_TEMPLATE_LEADER;
        if (!templateId) throw new Error('WECHAT_TEMPLATE_LEADER is not configured');

        const accessToken = await ScanLoginController.getServerAccessToken();
        const sectors = [...new Set(stocks.map(s => s.industry))].join(' / ');

        const data: Record<string, any> = {
            first: { value: '今日风口板块及龙头股推荐', color: '#173177' },
            sector: { value: sectors },
            remark: { value: '点击查看完整龙头股一览', color: '#009688' },
        };

        for (let i = 0; i < 3; i++) {
            const stock = stocks[i];
            const stockKey = `stock${i + 1}`;
            const reasonKey = `reason${i + 1}`;
            if (stock) {
                data[stockKey] = { value: `${stock.name}(${stock.code})  ${WechatPushService.formatChangePct(stock.change_pct)}` };
                data[reasonKey] = { value: stock.reason || '暂无' };
            } else {
                data[stockKey] = { value: '暂无' };
                data[reasonKey] = { value: '暂无' };
            }
        }

        const res = await sessionFetch(
            `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ touser: openid, template_id: templateId, url: 'https://gupiao.yaozhineng.com/', data }),
            },
        );
        const resData: any = await res.json();
        if (resData.errcode && resData.errcode !== 0) {
            throw new Error(`wechat template send failed: ${resData.errmsg || resData.errcode}`);
        }
        return resData;
    }

    private static async insertLeaderPushLog(
        eventId: string,
        openid: string,
        status: PushLogItem['status'],
        errorMsg: string | null,
        responseJson: any,
        stocks: LeaderStockPushItem[],
    ): Promise<void> {
        const firstStock = stocks[0] || {} as LeaderStockPushItem;
        await pool.query(
            `INSERT INTO wechat_push_logs (
                event_id, openid, symbol, stock_name, event_type, level, summary,
                template_id, status, error_msg, wechat_response_json, click_url, push_type
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
             ON CONFLICT(event_id, openid) DO NOTHING`,
            [
                eventId,
                openid,
                firstStock.code || '',
                firstStock.name || '',
                '龙头股日报',
                '',
                stocks.map(s => `${s.name}(${s.code})`).join('; '),
                process.env.WECHAT_TEMPLATE_LEADER || '',
                status,
                errorMsg,
                responseJson ? JSON.stringify(responseJson) : null,
                '',
                'leader',
            ],
        );
    }

    // ==================== 机构调研推荐热门股推送 ====================

    static async dispatchOutbreakStocks(stocks: OutbreakPushItem[], force: boolean = false): Promise<PushResult> {
        // 只推送给订阅了机构调研推荐热门股推送的用户
        const openids = await WechatPushService.getSubscribedWechatOpenids('outbreak_push');
        const today = new Date().toISOString().slice(0, 10);

        const pushResult: PushResult = {
            matched_users: openids.length,
            sent: 0,
            skipped: 0,
            failed: 0,
            logs: [],
        };

        if (stocks.length === 0) return pushResult;

        // 合并为一条消息：每只股票一个 eventId，但只发一条合并消息
        const eventId = `outbreak:${today}:${stocks.map(s => s.code).join(',')}`;
        const stockSummary = stocks.map(s => `${s.name}(${s.code})`).join('、');
        const sectorSummary = stocks.map(s => s.sector).join('；');

        for (const openid of openids) {
            if (!force && await WechatPushService.hasPushed(eventId, openid)) {
                pushResult.skipped += 1;
                pushResult.logs.push({ openid, status: 'skipped', reason: 'duplicate_event' });
                continue;
            }

            try {
                const wxResponse = await WechatPushService.sendOutbreakTemplateMessage(stocks, openid);
                await WechatPushService.insertOutbreakPushLog(eventId, openid, 'sent', null, wxResponse, stocks[0], stockSummary, sectorSummary);
                pushResult.sent += 1;
                pushResult.logs.push({ openid, status: 'sent', reason: null, wechat_response: wxResponse });
            } catch (err: any) {
                const errorMsg = err instanceof Error ? err.message : String(err);
                WechatPushService.log('outbreak', 'template send failed', { openid, event_id: eventId, error: errorMsg });
                await WechatPushService.insertOutbreakPushLog(eventId, openid, 'failed', errorMsg, null, stocks[0], stockSummary, sectorSummary);
                pushResult.failed += 1;
                pushResult.logs.push({ openid, status: 'failed', reason: errorMsg });
            }
        }

        return pushResult;
    }

    private static async sendOutbreakTemplateMessage(stocks: OutbreakPushItem[], openid: string): Promise<any> {
        const templateId = process.env.WECHAT_TEMPLATE_OUTBREAK;
        if (!templateId) throw new Error('WECHAT_TEMPLATE_OUTBREAK is not configured');

        const accessToken = await ScanLoginController.getServerAccessToken();

        // 合并所有股票信息为一条消息
        const stockLines = stocks.map((s, i) =>
            `${i + 1}. ${s.name}(${s.code}) [${s.resonance_level} ${s.resonance_score}分] ${s.sector}`
        ).join('\n');
        const triggerLines = stocks.map((s, i) =>
            `${i + 1}. ${s.trigger_reason}`
        ).join('\n');

        const res = await sessionFetch(
            `https://api.weixin.qq.com/cgi-bin/message/template/send?access_token=${accessToken}`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    touser: openid,
                    template_id: templateId,
                    data: {
                        first: { value: `机构调研推荐热门股检测到${stocks.length}只共振信号`, color: '#FF5722' },
                        stocks: { value: stockLines },
                        trigger: { value: triggerLines },
                        remark: { value: '三步验证通过，点击查看详情', color: '#009688' },
                    },
                }),
            },
        );
        const resData: any = await res.json();
        if (resData.errcode && resData.errcode !== 0) {
            throw new Error(`wechat template send failed: ${resData.errmsg || resData.errcode}`);
        }
        return resData;
    }

    private static async insertOutbreakPushLog(
        eventId: string,
        openid: string,
        status: PushLogItem['status'],
        errorMsg: string | null,
        responseJson: any,
        stock: OutbreakPushItem,
        stockSummary?: string,
        sectorSummary?: string,
    ): Promise<void> {
        await pool.query(
            `INSERT INTO wechat_push_logs (
                event_id, openid, symbol, stock_name, event_type, level, summary,
                template_id, status, error_msg, wechat_response_json, click_url, push_type
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)
             ON CONFLICT(event_id, openid) DO NOTHING`,
            [
                eventId,
                openid,
                stock.code,
                stockSummary || stock.name,
                '机构调研推荐热门股',
                stock.resonance_level,
                stock.trigger_reason,
                process.env.WECHAT_TEMPLATE_OUTBREAK || '',
                status,
                errorMsg,
                responseJson ? JSON.stringify(responseJson) : null,
                '',
                'outbreak',
            ],
        );
    }
}
