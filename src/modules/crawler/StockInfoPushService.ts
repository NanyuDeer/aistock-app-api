import { StockInfoService, StockInfoType, type StockInfoPushWindow } from './StockInfoService';
import { WechatPushService } from '../push/WechatPushService';
import { MessagePushService } from '../push/MessagePushService';
import { CacheService } from '../../shared/utils/CacheService';

export interface StockInfoPushRequest {
    window?: string;
    info_type?: string;
    from?: string;
    to?: string;
}

export interface StockInfoPushResult {
    candidates: number;
    matched_users: number;
    sent: number;
    skipped: number;
    failed: number;
    results: any[];
}

const LAST_PUSH_TIME_KEY = 'stock_info:last_push_time';

function parseDate(value: unknown, field: string): Date {
    const raw = String(value || '').trim();
    const date = new Date(raw);
    if (!raw || Number.isNaN(date.getTime())) throw new Error(`${field} must be a valid datetime`);
    return date;
}

async function getLastPushTime(): Promise<Date | null> {
    const cached = await CacheService.get<string>(LAST_PUSH_TIME_KEY);
    if (!cached) return null;
    const ts = parseInt(cached, 10);
    if (!Number.isFinite(ts)) return null;
    return new Date(ts);
}

async function setLastPushTime(time: Date): Promise<void> {
    // TTL 48小时，确保跨周末后仍可读取
    await CacheService.put(LAST_PUSH_TIME_KEY, String(time.getTime()), 48 * 3600);
}

function getDefaultWindowRange(windowName: string, lastPushTime: Date | null): { from: Date; to: Date } {
    const now = new Date();

    if (windowName === 'morning') {
        // 早盘推送：from = 上次推送时间（或默认前一天15:00），to = now
        let from: Date;
        if (lastPushTime) {
            from = lastPushTime;
        } else {
            // 默认：前一天15:00
            from = new Date(now);
            from.setDate(from.getDate() - 1);
            from.setHours(15, 0, 0, 0);
        }
        return { from, to: now };
    }

    if (windowName === 'closing') {
        // 收盘推送：from = 上次推送时间（或默认今天8:00），to = now
        let from: Date;
        if (lastPushTime) {
            from = lastPushTime;
        } else {
            // 默认：今天8:00
            from = new Date(now);
            from.setHours(8, 0, 0, 0);
        }
        return { from, to: now };
    }

    throw new Error('window must be morning or closing');
}

export class StockInfoPushService {
    static async resolveWindows(body: StockInfoPushRequest): Promise<StockInfoPushWindow[]> {
        const windowName = String(body.window || 'morning').trim();
        const lastPushTime = await getLastPushTime();
        const defaults = getDefaultWindowRange(windowName, lastPushTime);
        const from = body.from ? parseDate(body.from, 'from') : defaults.from;
        const to = body.to ? parseDate(body.to, 'to') : defaults.to;
        const types: StockInfoType[] = ['announcement', 'news'];
        console.log(`[StockInfoPush] 窗口=${windowName}, 上次推送=${lastPushTime?.toISOString() || '无'}, 资讯时间范围=${from.toISOString()} ~ ${to.toISOString()}`);
        return types.map(info_type => ({ info_type, from, to }));
    }

    static async push(body: StockInfoPushRequest): Promise<StockInfoPushResult> {
        const windows = await StockInfoPushService.resolveWindows(body);
        const summary: StockInfoPushResult = {
            candidates: 0,
            matched_users: 0,
            sent: 0,
            skipped: 0,
            failed: 0,
            results: [],
        };

        for (const window of windows) {
            const candidates = await StockInfoService.getPushCandidates(window);
            summary.candidates += candidates.length;

            for (const judgement of candidates) {
                const event = {
                    id: judgement.id,
                    symbol: judgement.symbol,
                    stock_name: judgement.stock_name,
                    info_type: judgement.info_type,
                    title: judgement.title,
                    url: judgement.url,
                    published_at: judgement.published_at,
                    ai_impact: judgement.ai_impact,
                    ai_horizon: judgement.ai_horizon,
                    ai_keywords: judgement.ai_keywords,
                    ai_summary: judgement.ai_summary,
                };

                // 微信推送
                const result = await WechatPushService.dispatchStockInfoJudgement(event);
                summary.matched_users += result.matched_users;
                summary.sent += result.sent;
                summary.skipped += result.skipped;
                summary.failed += result.failed;

                // 飞书推送
                await MessagePushService.dispatchStockInfoToFeishu({
                    symbol: event.symbol,
                    stock_name: event.stock_name || event.symbol,
                    info_type: event.info_type,
                    title: event.title,
                    ai_impact: event.ai_impact,
                    ai_horizon: event.ai_horizon,
                    ai_summary: event.ai_summary,
                    published_at: event.published_at instanceof Date ? event.published_at.toISOString() : String(event.published_at),
                });

                summary.results.push({ id: judgement.id, symbol: judgement.symbol, ...result });
            }
        }

        // 推送成功后，记录本次推送时间（下次推送的起点）
        if (summary.sent > 0 || summary.candidates > 0) {
            await setLastPushTime(new Date());
            console.log(`[StockInfoPush] 已记录推送时间，下次推送起点=${new Date().toISOString()}`);
        }

        return summary;
    }
}
