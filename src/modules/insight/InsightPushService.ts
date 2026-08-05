// src/modules/insight/InsightPushService.ts
// 自选股洞察推送：归因结果落库后，命中自选股用户的三通道推送（WS 定向 / 微信模板 / 飞书卡片）
//
// 去重契约（016 迁移）：watchlist_insight_push_records UNIQUE(event_id, openid, push_kind, channel)
//   sendWechat/sendFeishu 先 INSERT ON CONFLICT DO NOTHING 判重，重复返回 false 不发送。
// 开关：命中查询 LEFT JOIN user_settings 过滤 'watchlist_insight_push'，
//   默认开启（未配置或 enabled != 0），与旧推送模块 isPushEnabled 语义一致。
import pool from '../../core/db';
import { pushAlertToUser } from '../../core/ws/channels/alert-channel';

/** 命中用户的归因结果行（列名与 016 迁移 watchlist_insight_events/results 对齐） */
interface InsightPushRow {
    openid: string;
    symbol: string;
    stock_name: string;
    primary_driver: { label?: string } | null;
    attribution_status: string;
    confidence: string;
    /** 飞书 open_id（user_subscriptions 解析，未绑定/非订阅为 null），飞书通道仅对非空值下发 */
    feishu_open_id: string | null;
}

/**
 * 首次生成洞察后推送：命中持有该股票的自选股用户，经 WS + 微信 + 飞书三通道下发。
 * 微信/飞书通过 push_records 唯一键幂等去重（重复调用不重复发送）。
 * @returns 实际发送成功的用户数（微信或飞书至少成功一个计 1）
 */
export async function pushCreated(eventId: string): Promise<number> {
    const { rows } = await pool.query(
        `SELECT DISTINCT u.openid, e.symbol, e.stock_name, r.primary_driver, r.attribution_status, r.confidence, fs.feishu_open_id
         FROM watchlist_insight_events e
         JOIN watchlist_insight_results r ON r.event_id = e.event_id AND r.analysis_version = 'watchlist-insight-v1'
         JOIN user_stocks us ON us.symbol = e.symbol
         JOIN users u ON u.openid = us.openid
         LEFT JOIN user_subscriptions fs ON fs.user_openid = u.openid AND fs.status = 'subscribed' AND fs.feishu_open_id IS NOT NULL AND fs.feishu_open_id != ''
         LEFT JOIN user_settings s ON s.openid = u.openid AND s.setting_type = 'watchlist_insight_push'
         WHERE e.event_id = $1 AND (s.enabled IS NULL OR s.enabled != 0)`, [eventId],
    );
    let sent = 0;
    for (const row of rows) {
        const r = row as InsightPushRow;
        const label = r.attribution_status === 'unconfirmed'
            ? '主因待验证'
            : (r.primary_driver?.label ?? '');
        const content = `【自选股洞察】${r.stock_name}(${r.symbol}) ${label} · 置信度 ${r.confidence}`;
        // WS 定向推送（WebSocket 无持久化去重，连接关闭时自然收不到）
        pushAlertToUser(r.openid, { type: 'insight.created', eventId, content, symbol: r.symbol });
        // 微信 + 飞书（复用现有推送基础设施，幂等去重走 push_records）
        const wx = await sendWechat(r.openid, content, eventId);
        // 飞书通道：仅已绑定飞书（feishu_open_id 非空）的用户下发；未绑定者跳过，微信/WS 不受影响
        const feishuOpenId = r.feishu_open_id?.trim() || '';
        const feishu = feishuOpenId ? await sendFeishu(r.openid, feishuOpenId, content, eventId) : false;
        if (wx || feishu) sent++;
    }
    return sent;
}

/** 微信推送：先插 push_records 判重，未推送过才调用发送（动态 import 避免与 push 模块循环依赖） */
async function sendWechat(openid: string, content: string, eventId: string): Promise<boolean> {
    const res = await pool.query(
        `INSERT INTO watchlist_insight_push_records (event_id, openid, push_kind, channel)
         VALUES ($1,$2,'created','wechat') ON CONFLICT (event_id, openid, push_kind, channel) DO NOTHING RETURNING id`,
        [eventId, openid],
    );
    if (res.rows.length === 0) return false;
    const { WechatPushService } = await import('../push/WechatPushService');
    return WechatPushService.dispatchInsightPush(openid, content, eventId);
}

/** 飞书推送：先插 push_records 判重，未推送过才调用发送（动态 import 避免与 push 模块循环依赖）。
 *  recordOpenid 为用户微信 openid（push_records 去重键，保证同一用户/事件/通道只发一次）；
 *  feishuOpenId 为真实发送目标（来自 user_subscriptions.feishu_open_id）。 */
async function sendFeishu(recordOpenid: string, feishuOpenId: string, content: string, eventId: string): Promise<boolean> {
    const res = await pool.query(
        `INSERT INTO watchlist_insight_push_records (event_id, openid, push_kind, channel)
         VALUES ($1,$2,'created','feishu') ON CONFLICT (event_id, openid, push_kind, channel) DO NOTHING RETURNING id`,
        [eventId, recordOpenid],
    );
    if (res.rows.length === 0) return false;
    const { MessagePushService } = await import('../push/MessagePushService');
    return MessagePushService.dispatchInsightToFeishu(feishuOpenId, content, eventId);
}
