/**
 * 统一消息推送服务
 *
 * 推送架构：
 * 1. 龙头股日报推送（8:30）：定时读取 hot-sectors.json → 微信+飞书
 * 2. 机构调研推荐热门股推送（9:00/17:00）：定时检测三重共振信号 → 微信+飞书
 * 3. 自选股异动推送（事件驱动）：爬虫周期中检测到重大利好/利空 → 微信+飞书
 *    - 由 StockInfoCrawlService.runCycle() 在8:00/15:00触发
 *    - 不在此处定时推送，而是通过 StockInfoPushService.push() 事件驱动
 */

import pool from '../../core/db';
import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import cron from 'node-cron';
import { HotBurstService } from '../monitor/HotBurstService';

const FEISHU_APP_ID = process.env.FEISHU_APP_ID || '';
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET || '';
const FEISHU_BASE_URL = 'https://open.feishu.cn/open-apis';

// 推送时间配置（cron 表达式 + 标签 + 类型）
const PUSH_SCHEDULES = [
    { cron: '30 8 * * *', label: '龙头股日报', type: 'leader' as const },
    { cron: '0 9 * * *', label: '早报', type: 'outbreak+stock' as const },
    { cron: '0 17 * * *', label: '晚报', type: 'outbreak+stock' as const },
];

// ==================== 标签 ====================

// ==================== 飞书API ====================

async function getFeishuAppToken(): Promise<string> {
    const res = await axios.post(
        `${FEISHU_BASE_URL}/auth/v3/app_access_token/internal`,
        { app_id: FEISHU_APP_ID, app_secret: FEISHU_APP_SECRET },
    );
    return res.data?.app_access_token || '';
}

async function sendFeishuCard(openId: string, card: any): Promise<boolean> {
    try {
        const appToken = await getFeishuAppToken();
        await axios.post(
            `${FEISHU_BASE_URL}/im/v1/messages?receive_id_type=open_id`,
            {
                receive_id: openId,
                msg_type: 'interactive',
                content: JSON.stringify(card),
            },
            {
                headers: {
                    Authorization: `Bearer ${appToken}`,
                    'Content-Type': 'application/json',
                },
            },
        );
        return true;
    } catch (err: any) {
        console.error('[MessagePush] 飞书发送失败:', err?.response?.data || err.message);
        return false;
    }
}

// ==================== 数据查询 ====================

interface Subscriber {
    user_id: number;
    feishu_open_id: string;
    feishu_name: string;
    wechat_openid: string;
}

async function getSubscribers(): Promise<Subscriber[]> {
    try {
        const result = await pool.query(
            `SELECT us.id AS user_id, us.feishu_open_id, us.feishu_name, us.user_openid AS wechat_openid
             FROM user_subscriptions us
             WHERE us.status = 'subscribed'
               AND (us.feishu_open_id IS NOT NULL AND us.feishu_open_id != ''
                    OR us.user_openid IS NOT NULL AND us.user_openid != '')`,
        );
        return result.rows;
    } catch {
        return [];
    }
}

/** 获取订阅了指定推送类型的飞书用户 */
async function getFeishuSubscribersBySetting(settingType: string): Promise<Subscriber[]> {
    try {
        const result = await pool.query(
            `SELECT us.id AS user_id, us.feishu_open_id, us.feishu_name, us.user_openid AS wechat_openid
             FROM user_subscriptions us
             INNER JOIN user_settings ust ON us.user_openid = ust.openid
             WHERE us.status = 'subscribed'
               AND us.feishu_open_id IS NOT NULL
               AND us.feishu_open_id != ''
               AND ust.setting_type = $1
               AND COALESCE(ust.enabled, 1) != 0`,
            [settingType],
        );
        return result.rows;
    } catch {
        return [];
    }
}

interface OutbreakStock {
    name: string;
    concept: string;
    change_pct: number;
    reason: string;
}

async function getOutbreakData(): Promise<{ feishu: OutbreakStock[]; wechat: OutbreakPushData[] }> {
    try {
        console.log('[MessagePush] 开始获取机构调研推荐热门股数据...');
        const result = await HotBurstService.detectHotBurst();
        // 二重及以上共振过滤
        const signals = result.outbreaks
            .filter(s => s.resonanceCount >= 2)
            .slice(0, 3);
        console.log(`[MessagePush] 机构调研推荐热门股检测完成: ${signals.length} 个共振信号（共${result.outbreaks.length}个）`);
        return {
            feishu: signals.map(signal => ({
                name: signal.stockName || signal.symbol,
                concept: signal.thsSectorName || signal.triggerTags.join('、'),
                change_pct: signal.resonanceScore,
                reason: buildOutbreakReason(signal),
            })),
            wechat: signals.map(signal => ({
                name: signal.stockName || signal.symbol,
                code: signal.symbol,
                sector: signal.thsSectorName || signal.triggerTags.join('、'),
                resonance_score: signal.resonanceScore,
                resonance_level: signal.resonanceLevel === 'critical' ? '极高' : signal.resonanceLevel === 'high' ? '高' : signal.resonanceLevel === 'medium' ? '中' : '低',
                trigger_reason: buildOutbreakReason(signal),
            })),
        };
    } catch (err: any) {
        console.error('[MessagePush] 获取机构调研推荐热门股数据失败:', err?.message || err, err?.stack || '');
        return { feishu: [], wechat: [] };
    }
}

// ==================== 龙头股数据提取（渠道无关，飞书可复用） ====================

interface LeaderStockData {
    name: string;
    code: string;
    industry: string;
    change_pct: number;
    reason: string;
    score: number;
}

async function getLeaderStocksForPush(): Promise<LeaderStockData[]> {
    try {
        const dataFile = path.resolve(__dirname, '../../data/hot-sectors.json');
        const raw = fs.readFileSync(dataFile, 'utf-8');
        const data = JSON.parse(raw);
        const sectors = Array.isArray(data?.hot_sectors) ? data.hot_sectors : [];

        // 取score最高的前3个板块，每个板块取1只龙头股
        const sortedSectors = [...sectors]
            .sort((a, b) => (b.score || 0) - (a.score || 0))
            .slice(0, 3);

        const result: LeaderStockData[] = [];
        for (const sector of sortedSectors) {
            const sectorName = sector.name || '';
            const mainStocks = Array.isArray(sector.main_stocks) ? sector.main_stocks : [];
            if (mainStocks.length === 0) continue;
            // 取该板块得分最高的龙头股
            const best = [...mainStocks].sort((a, b) => (b.score || 0) - (a.score || 0))[0];
            result.push({
                name: best.name || '',
                code: best.code || '',
                industry: sectorName,
                change_pct: Number(best.change_pct) || 0,
                reason: best.reason || '',
                score: Number(best.score) || 0,
            });
        }

        return result.slice(0, 3);
    } catch (err: any) {
        console.error('[MessagePush] 读取龙头股数据失败:', err?.message || err);
        return [];
    }
}

// ==================== 机构调研推荐热门股数据提取（扩展字段，供微信模板使用） ====================

interface OutbreakPushData {
    name: string;
    code: string;
    sector: string;
    resonance_score: number;
    resonance_level: string;
    trigger_reason: string;
}

function buildOutbreakReason(signal: any): string {
    const parts: string[] = [];
    if (signal.newsCount > 0) parts.push(`资讯${signal.newsCount}次`);
    if (signal.newsSurgeRatio > 1) parts.push(`爆发比${signal.newsSurgeRatio.toFixed(1)}`);
    if (signal.feishuMessageCount > 0) parts.push(`飞书${signal.feishuMessageCount}次`);
    if (signal.thsVerified) parts.push(`同花顺验证(${signal.thsSectorName}#${signal.thsSectorRank})`);
    if (signal.clsVerified) parts.push(`财联社概念(${signal.conceptDetail?.conceptName || ''})`);
    if (signal.glhVerified) parts.push(`格隆汇概念(${signal.conceptDetail?.conceptName || ''})`);
    if (signal.reportVerified) parts.push(`研报${signal.reportDetail?.reportCount || 0}篇`);
    return parts.length > 0 ? parts.join('，') : (signal.triggerTags || []).slice(0, 3).join('、') || '共振信号';
}

// ==================== 消息构建 ====================

function buildLeaderFeishuCard(stocks: LeaderStockData[]): any {
    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '**风口板块及龙头股推荐**' },
    });
    elements.push({ tag: 'hr' });

    const sectors = stocks.map(s => s.industry).join(' / ');
    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `风口板块：${sectors}` },
    });
    elements.push({ tag: 'hr' });

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        const changeStr = stock.change_pct > 0
            ? `+${stock.change_pct.toFixed(2)}%`
            : `${stock.change_pct.toFixed(2)}%`;
        const color = stock.change_pct > 0 ? 'red' : 'green';
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `**龙头股${i + 1}：${stock.name}(${stock.code})** <font color="${color}">${changeStr}</font>\n推荐理由：${stock.reason}`,
            },
        });
        elements.push({ tag: 'hr' });
    }

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '<font color="grey">点击查看完整龙头股一览</font>' },
    });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '【龙头股日报】' },
            template: 'green',
        },
        elements,
    };
}

function buildOutbreakFeishuCard(stocks: OutbreakPushData[]): any {
    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '**机构调研推荐热门股检测到共振信号**' },
    });
    elements.push({ tag: 'hr' });

    for (let i = 0; i < stocks.length; i++) {
        const stock = stocks[i];
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `**${stock.name}(${stock.code})**\n概念板块：${stock.sector}\n共振强度：${stock.resonance_level}（${stock.resonance_score}分）\n触发原因：${stock.trigger_reason}`,
            },
        });
        elements.push({ tag: 'hr' });
    }

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '<font color="grey">三步验证通过，点击查看详情</font>' },
    });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '【机构调研热门股】' },
            template: 'red',
        },
        elements,
    };
}

interface StockInfoPushEventData {
    symbol: string;
    stock_name: string;
    info_type: string;
    title: string;
    ai_impact: string;
    ai_horizon: string;
    ai_summary: string;
    published_at: string;
}

function buildStockInfoFeishuCard(event: StockInfoPushEventData): any {
    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '**您的自选股有新动态**' },
    });
    elements.push({ tag: 'hr' });

    const eventType = event.info_type === 'announcement' ? '公告研判' : '新闻研判';
    const time = new Date(event.published_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    elements.push({
        tag: 'div',
        text: {
            tag: 'lark_md',
            content: `股票：**${event.stock_name}**(${event.symbol})\n事件类型：${eventType}\n影响级别：${event.ai_impact}/${event.ai_horizon}\n摘要：${event.ai_summary || event.title}\n发生时间：${time}`,
        },
    });
    elements.push({ tag: 'hr' });

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: '<font color="grey">点击查看完整分析</font>' },
    });

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: '【自选股异动提醒】' },
            template: 'orange',
        },
        elements,
    };
}

// ==================== 推送执行 ====================

export class MessagePushService {
    private static cronTasks: cron.ScheduledTask[] = [];

    static startScheduler(): void {
        if (this.cronTasks.length > 0) return;

        console.log('[MessagePush] 启动定时推送调度器 (node-cron)');

        for (const schedule of PUSH_SCHEDULES) {
            const task = cron.schedule(schedule.cron, () => {
                console.log(`[MessagePush] 到达推送时间: ${schedule.label}`);
                this.executePush(schedule).catch(err => {
                    console.error(`[MessagePush] ${schedule.label}推送失败:`, err.message);
                });
            }, { timezone: 'Asia/Shanghai' });
            this.cronTasks.push(task);
        }
    }

    static stopScheduler(): void {
        for (const task of this.cronTasks) {
            task.stop();
        }
        this.cronTasks = [];
        console.log('[MessagePush] 停止定时推送调度器');
    }

    static async executePush(schedule: { label: string; type: string }): Promise<{ success: number; fail: number }> {
        // 龙头股日报推送
        if (schedule.type === 'leader') {
            return this.executeLeaderPush();
        }

        // 原有的机构调研推荐热门股+个股资讯推送逻辑
        return this.executeOutbreakAndStockPush(schedule.label);
    }

    // ==================== 龙头股推送 ====================

    static async executeLeaderPush(force: boolean = false): Promise<{ success: number; fail: number; detail?: any }> {
        const stocks = await getLeaderStocksForPush();
        if (stocks.length === 0) {
            console.log('[MessagePush] 龙头股日报: 无数据，跳过推送');
            return { success: 0, fail: 0, detail: { reason: 'no_stocks', stocksCount: 0 } };
        }

        console.log(`[MessagePush] 龙头股日报: 提取到${stocks.length}只龙头股`, stocks.map(s => `${s.name}(${s.code}) score=${s.score}`));

        let success = 0;
        let fail = 0;

        // 微信推送
        const { WechatPushService } = await import('./WechatPushService');
        const leaderStocks: any[] = stocks.map(s => ({
            name: s.name,
            code: s.code,
            industry: s.industry,
            change_pct: s.change_pct,
            reason: s.reason,
        }));
        const wxResult = await WechatPushService.dispatchLeaderStocks(leaderStocks, force);
        success += wxResult.sent;
        fail += wxResult.failed;
        console.log(`[MessagePush] 龙头股日报微信推送: 发送${wxResult.sent}, 跳过${wxResult.skipped}, 失败${wxResult.failed}`);

        // 飞书推送 - 只推送给订阅了龙头股推送的用户
        const feishuSubs = await getFeishuSubscribersBySetting('leader_push');
        if (feishuSubs.length > 0) {
            const card = buildLeaderFeishuCard(stocks);
            for (const sub of feishuSubs) {
                const sent = await sendFeishuCard(sub.feishu_open_id, card);
                if (sent) success++;
                else fail++;
            }
            console.log(`[MessagePush] 龙头股日报飞书推送: ${feishuSubs.length} 个订阅用户`);
        }

        console.log(`[MessagePush] 龙头股日报推送完成: 成功${success}, 失败${fail}`);
        return { success, fail, detail: { wxMatched: wxResult.matched_users, wxSkipped: wxResult.skipped, feishuCount: feishuSubs.length, logs: wxResult.logs } };
    }

    // ==================== 机构调研推荐热门股+个股资讯推送 ====================

    /** 手动触发机构调研推荐热门股推送（测试用） */
    static async executeOutbreakPush(testData?: any[], force: boolean = false): Promise<{ success: number; fail: number; detail?: any }> {
        const { WechatPushService } = await import('./WechatPushService');
        let outbreakData: OutbreakPushData[];
        if (testData && testData.length > 0) {
            outbreakData = testData;
        } else {
            const { wechat } = await getOutbreakData();
            outbreakData = wechat;
        }
        if (outbreakData.length === 0) {
            console.log('[MessagePush] 无机构调研推荐热门股数据，跳过推送');
            return { success: 0, fail: 0, detail: { message: '无机构调研推荐热门股数据' } };
        }
        console.log(`[MessagePush] 检测到 ${outbreakData.length} 只机构调研热门股，开始推送`);

        // 微信推送
        const wxResult = await WechatPushService.dispatchOutbreakStocks(outbreakData, force);

        // 飞书推送 - 只推送给订阅了机构调研推荐热门股推送的用户
        const feishuSubs = await getFeishuSubscribersBySetting('outbreak_push');
        let feishuSent = 0;
        let feishuFail = 0;
        if (feishuSubs.length > 0) {
            const card = buildOutbreakFeishuCard(outbreakData);
            for (const sub of feishuSubs) {
                const ok = await sendFeishuCard(sub.feishu_open_id, card);
                if (ok) feishuSent++;
                else feishuFail++;
            }
        }

        return {
            success: wxResult.sent,
            fail: wxResult.failed,
            detail: {
                wxMatched: wxResult.matched_users, wxSkipped: wxResult.skipped,
                feishuSent, feishuFail,
                outbreakData, logs: wxResult.logs,
            },
        };
    }

    static async executeOutbreakAndStockPush(scheduleLabel: string): Promise<{ success: number; fail: number }> {
        // 机构调研推荐热门股定时推送（9:00/17:00）
        // 注意：自选股异动推送由 StockInfoCrawlService.runCycle() 事件驱动，
        // 在8:00/15:00爬虫周期中自动触发，不在此处处理
        let success = 0;
        let fail = 0;

        // 获取机构调研推荐热门股数据（一次检测，同时生成飞书和微信格式）
        const { feishu: outbreakFeishu, wechat: outbreakWechat } = await getOutbreakData();
        if (outbreakWechat.length === 0 && outbreakFeishu.length === 0) {
            console.log(`[MessagePush] ${scheduleLabel}: 无机构调研推荐热门股数据，跳过推送`);
            return { success: 0, fail: 0 };
        }

        console.log(`[MessagePush] ${scheduleLabel}: 检测到${outbreakWechat.length}个机构调研热门信号`);

        // 微信推送
        if (outbreakWechat.length > 0) {
            const { WechatPushService } = await import('./WechatPushService');
            const wxResult = await WechatPushService.dispatchOutbreakStocks(outbreakWechat);
            success += wxResult.sent;
            fail += wxResult.failed;
            console.log(`[MessagePush] ${scheduleLabel}微信推送: 发送${wxResult.sent}, 跳过${wxResult.skipped}, 失败${wxResult.failed}`);
        }

        // 飞书推送 - 只推送给订阅了机构调研推荐热门股推送的用户
        const feishuSubs = await getFeishuSubscribersBySetting('outbreak_push');
        if (feishuSubs.length > 0 && outbreakFeishu.length > 0) {
            const card = buildOutbreakFeishuCard(outbreakWechat);
            for (const sub of feishuSubs) {
                const sent = await sendFeishuCard(sub.feishu_open_id, card);
                if (sent) success++;
                else fail++;
            }
            console.log(`[MessagePush] ${scheduleLabel}飞书推送: ${feishuSubs.length} 个订阅用户`);
        }

        console.log(`[MessagePush] ${scheduleLabel}推送完成: 成功${success}, 失败${fail}`);
        return { success, fail };
    }

    static async manualPush(): Promise<{ success: number; fail: number }> {
        return this.executePush({ label: '手动推送', type: 'outbreak+stock' });
    }

    // ==================== 自选股异动飞书实时推送 ====================

    static async dispatchStockInfoToFeishu(event: StockInfoPushEventData, pushToAll: boolean = false): Promise<{ sent: number; failed: number }> {
        try {
            let rows: any[];
            if (pushToAll) {
                // 测试模式：推送给所有订阅了自选股推送且有飞书ID的用户
                const result = await pool.query(
                    `SELECT DISTINCT us.feishu_open_id
                     FROM user_subscriptions us
                     INNER JOIN user_settings ust ON us.user_openid = ust.openid
                     WHERE us.status = 'subscribed'
                       AND us.feishu_open_id IS NOT NULL
                       AND us.feishu_open_id != ''
                       AND ust.setting_type = 'stock_push'
                       AND COALESCE(ust.enabled, 1) != 0`,
                );
                rows = result.rows;
            } else {
                // 正常模式：推送给持有该股票且订阅了自选股推送的用户
                const result = await pool.query(
                    `SELECT DISTINCT us.feishu_open_id
                     FROM user_subscriptions us
                     INNER JOIN user_stocks ust ON us.user_openid = ust.openid
                     INNER JOIN user_settings ust2 ON us.user_openid = ust2.openid
                     WHERE ust.symbol = $1
                       AND us.status = 'subscribed'
                       AND us.feishu_open_id IS NOT NULL
                       AND us.feishu_open_id != ''
                       AND ust2.setting_type = 'stock_push'
                       AND COALESCE(ust2.enabled, 1) != 0`,
                    [event.symbol],
                );
                rows = result.rows;
            }

            if (rows.length === 0) return { sent: 0, failed: 0 };

            const card = buildStockInfoFeishuCard(event);
            let sent = 0;
            let failed = 0;

            for (const row of rows) {
                const openId = String(row.feishu_open_id);
                const ok = await sendFeishuCard(openId, card);
                if (ok) sent++;
                else failed++;
            }

            console.log(`[MessagePush] 自选股异动飞书推送: ${event.stock_name}(${event.symbol}), 发送${sent}, 失败${failed}`);
            return { sent, failed };
        } catch (err: any) {
            console.error('[MessagePush] 自选股异动飞书推送失败:', err.message);
            return { sent: 0, failed: 0 };
        }
    }

    // ==================== 市场事件飞书推送 ====================

    /** 市场事件推送载荷 */
    static marketEventPayload?: {
        market: string;
        direction: string;
        indices: string;
        change_pct: number;
        cause: string;
        evidence_url: string;
        evidence_summary: string;
        title: string;
        event_time: string;
    };

    static async dispatchMarketEventToFeishu(payload: typeof MessagePushService.marketEventPayload): Promise<{ sent: number; failed: number }> {
        if (!payload || !payload.title) return { sent: 0, failed: 0 };

        try {
            // 市场事件属重大行情，推送给所有有飞书ID的已订阅用户
            const result = await pool.query(
                `SELECT DISTINCT us.feishu_open_id
                 FROM user_subscriptions us
                 WHERE us.status = 'subscribed'
                   AND us.feishu_open_id IS NOT NULL
                   AND us.feishu_open_id != ''`,
            );
            const rows = result.rows || [];
            if (rows.length === 0) return { sent: 0, failed: 0 };

            const card = buildMarketEventFeishuCard(payload as NonNullable<typeof MessagePushService.marketEventPayload>);
            let sent = 0;
            let failed = 0;

            for (const row of rows) {
                const openId = String(row.feishu_open_id);
                const ok = await sendFeishuCard(openId, card);
                if (ok) sent++;
                else failed++;
            }

            console.log(`[MessagePush] 市场事件飞书推送: ${payload.title}, 发送${sent}, 失败${failed}`);
            return { sent, failed };
        } catch (err: any) {
            console.error('[MessagePush] 市场事件飞书推送失败:', err.message);
            return { sent: 0, failed: 0 };
        }
    }
}

/** 构建市场事件飞书卡片 */
function buildMarketEventFeishuCard(payload: NonNullable<typeof MessagePushService.marketEventPayload>): any {
    const directionLabel = payload.direction === 'up' ? '大涨' : payload.direction === 'down' ? '重挫' : '异动';
    const directionSymbol = payload.direction === 'up' ? '↑' : payload.direction === 'down' ? '↓' : '→';
    const changeStr = payload.change_pct
        ? (payload.change_pct > 0 ? `+${payload.change_pct.toFixed(2)}%` : `${payload.change_pct.toFixed(2)}%`)
        : '';
    const changeColor = payload.change_pct > 0 ? 'red' : payload.change_pct < 0 ? 'green' : 'grey';

    const elements: any[] = [];

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**${directionSymbol} ${payload.market}市场${directionLabel}**` },
    });
    elements.push({ tag: 'hr' });

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**${payload.title}**` },
    });

    elements.push({
        tag: 'div',
        text: {
            tag: 'lark_md',
            content: `${payload.indices} <font color="${changeColor}">${changeStr}</font>`,
        },
    });

    elements.push({
        tag: 'div',
        text: { tag: 'lark_md', content: `**原因**：${payload.cause}` },
    });

    if (payload.evidence_summary) {
        elements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: `**依据**：${payload.evidence_summary}` },
        });
    }

    elements.push({ tag: 'hr' });

    if (payload.evidence_url) {
        elements.push({
            tag: 'div',
            text: { tag: 'lark_md', content: `<font color="grey">[查看原文](${payload.evidence_url})</font>` },
        });
    }

    return {
        config: { wide_screen_mode: true },
        header: {
            title: { tag: 'plain_text', content: `【市场重磅事件】${payload.market}` },
            template: payload.direction === 'up' ? 'red' : payload.direction === 'down' ? 'green' : 'blue',
        },
        elements,
    };
}
