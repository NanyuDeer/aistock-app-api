// src/modules/insight/InsightPushService.ts
// 自选股洞察推送：归因结果落库后，命中自选股用户的三通道推送（WS 定向 / 微信模板 / 飞书卡片）
//
// 去重契约（016 迁移）：watchlist_insight_push_records UNIQUE(event_id, openid, push_kind, channel)
//   sendWechat/sendFeishu 先 INSERT ON CONFLICT DO NOTHING 判重，重复返回 false 不发送。
// 开关：命中查询 LEFT JOIN user_settings 过滤 'watchlist_insight_push'，
//   默认开启（未配置或 enabled != 0），与旧推送模块 isPushEnabled 语义一致。
import pool from '../../core/db';
import { pushAlertToUser } from '../../core/ws/channels/alert-channel';

/** 置信度数字化映射（用于 isSubstantiveChange 升级判定） */
const CONF_LEVEL: Record<string, number> = { low: 0, medium: 1, high: 2, unconfirmed: -1 };

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
 * 判断此次归因结果相比旧记录是否有实质变化（用于决定是否触发更新推送）。
 * 变化条件：无旧记录 || 待验证→有主因 || 状态翻转 || 主因标签变化 || 置信度升级
 */
export async function isSubstantiveChange(
    eventId: string,
    next: { attribution_status: string; confidence: string; primary_driver: Record<string, unknown> },
): Promise<boolean> {
    const { rows } = await pool.query(
        `SELECT attribution_status, confidence, primary_driver FROM watchlist_insight_results
         WHERE event_id=$1 AND analysis_version='watchlist-insight-v1'`, [eventId]);
    if (rows.length === 0) return true; // 无旧结果视为变化
    const old = rows[0] as { attribution_status: string; confidence: string; primary_driver: { label?: string } | null };
    const oldLabel = old.primary_driver?.label ?? '';
    const newLabel = String((next.primary_driver as { label?: string } | null)?.label ?? '');
    const oldStatus = String(old.attribution_status);
    const newStatus = next.attribution_status;
    return (
        (oldStatus === 'unconfirmed' && newStatus === 'confirmed')  // 待验证→有主因
        || oldStatus !== newStatus                                  // 状态翻转
        || oldLabel !== newLabel                                    // 主因标签变化
        || (CONF_LEVEL[next.confidence] ?? 0) > (CONF_LEVEL[old.confidence] ?? 0) // 置信度升级
    );
}

/**
 * 核心推送（按 kind 区分 push_kind，复用三通道 + push_records 去重）。
 * @returns 实际发送成功的用户数（微信或飞书至少成功一个计 1）
 */
export async function pushWithKind(eventId: string, kind: string): Promise<number> {
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
        // 微信 + 飞书（复用现有推送基础设施，幂等去重走 push_records，kind 区分 push_kind）
        const wx = await sendWechat(r.openid, content, eventId, kind);
        // 飞书通道：仅已绑定飞书（feishu_open_id 非空）的用户下发；未绑定者跳过，微信/WS 不受影响
        const feishuOpenId = r.feishu_open_id?.trim() || '';
        const feishu = feishuOpenId ? await sendFeishu(r.openid, feishuOpenId, content, eventId, kind) : false;
        if (wx || feishu) sent++;
    }
    return sent;
}

/**
 * 首次生成洞察后推送（push_kind='created'）：命中持有该股票的自选股用户，经 WS + 微信 + 飞书三通道下发。
 * 微信/飞书通过 push_records 唯一键幂等去重（重复调用不重复发送）。
 * @returns 实际发送成功的用户数（微信或飞书至少成功一个计 1）
 */
export async function pushCreated(eventId: string): Promise<number> {
    return pushWithKind(eventId, 'created');
}

/**
 * 归因结果更新后推送（push_kind='updated'）：复用三通道 + push_records 去重（push_kind='updated' 与 created 互不冲突）。
 * @returns 实际发送成功的用户数（微信或飞书至少成功一个计 1）
 */
export async function pushUpdated(eventId: string): Promise<number> {
    return pushWithKind(eventId, 'updated');
}

/** 微信推送：先插 push_records 判重，未推送过才调用发送（动态 import 避免与 push 模块循环依赖）。
 *  发送失败会删除刚插入的判重记录，避免 insert-before-send 语义下唯一键永久挡住后续重试。 */
async function sendWechat(openid: string, content: string, eventId: string, kind: string = 'created'): Promise<boolean> {
    const res = await pool.query(
        `INSERT INTO watchlist_insight_push_records (event_id, openid, push_kind, channel)
         VALUES ($1,$2,$3,'wechat') ON CONFLICT (event_id, openid, push_kind, channel) DO NOTHING RETURNING id`,
        [eventId, openid, kind],
    );
    if (res.rows.length === 0) return false;
    const recordId = res.rows[0].id as number;
    const { WechatPushService } = await import('../push/WechatPushService');
    const ok = await WechatPushService.dispatchInsightPush(openid, content, eventId);
    if (!ok) {
        // 发送失败：删除刚插入的判重记录，使下次触发可重试；成功则保留（去重语义不变）
        await removePushRecord(recordId);
    }
    return ok;
}

/** 飞书推送：先插 push_records 判重，未推送过才调用发送（动态 import 避免与 push 模块循环依赖）。
 *  recordOpenid 为用户微信 openid（push_records 去重键，保证同一用户/事件/通道只发一次）；
 *  feishuOpenId 为真实发送目标（来自 user_subscriptions.feishu_open_id）。 */
async function sendFeishu(recordOpenid: string, feishuOpenId: string, content: string, eventId: string, kind: string = 'created'): Promise<boolean> {
    const res = await pool.query(
        `INSERT INTO watchlist_insight_push_records (event_id, openid, push_kind, channel)
         VALUES ($1,$2,$3,'feishu') ON CONFLICT (event_id, openid, push_kind, channel) DO NOTHING RETURNING id`,
        [eventId, recordOpenid, kind],
    );
    if (res.rows.length === 0) return false;
    const recordId = res.rows[0].id as number;
    const { MessagePushService } = await import('../push/MessagePushService');
    const ok = await MessagePushService.dispatchInsightToFeishu(feishuOpenId, content, eventId);
    if (!ok) {
        await removePushRecord(recordId);
    }
    return ok;
}

/** 删除判重记录：发送失败后调用，保证唯一键不残留、下次触发可重新尝试 */
async function removePushRecord(id: number): Promise<void> {
    try {
        await pool.query('DELETE FROM watchlist_insight_push_records WHERE id = $1', [id]);
    } catch (e) {
        // 删除失败（如 DB 抖动）仅记日志不抛错：本轮推送结果已定，避免删除动作拖垮推送链路
        console.warn('[insight] failed to remove push record:', e instanceof Error ? e.message : String(e));
    }
}
