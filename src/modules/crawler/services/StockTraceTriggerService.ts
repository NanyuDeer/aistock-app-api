/**
 * StockTraceTriggerService — 个股 Trace 触发 relay
 *
 * 从 StockInfoPushService 接收重大利好/重大利空候选，
 * 按 symbol 去重后，经本 Service 转发到 Python alert.run。
 *
 * 职责仅限传输与结果分类：不重试、不排队、不抛异常给调用方。
 */
import { env } from 'node:process';

const TRACE_TIMEOUT_MS = 90_000; // 90 秒超时（Python deep-think 预留）
const PLACEHOLDER_TOKENS = new Set(['change-me-in-production', '']);

export interface StockTraceTriggerInput {
    symbol: string;
    traceId: string;
}

export type StockTraceTriggerResult =
    | { status: 'completed'; traceId: string }
    | { status: 'degraded' | 'failed' | 'skipped'; traceId: string; reason: string };

function readToken(): string {
    return env.INTERNAL_API_TOKEN || env.INTERNAL_TOKEN || '';
}

function isTokenConfigured(token: string): boolean {
    return !PLACEHOLDER_TOKENS.has(token);
}

function readPythonUrl(): string {
    return env.PYTHON_AGENT_URL || '';
}

export class StockTraceTriggerService {
    /**
     * 触发个股 Trace 分析
     *
     * Token 未配置/占位、URL 未配置时静默跳过（skipped）。
     * 网络错误、HTTP 错误、Python 降级、解析失败均返回非 completed，
     * 绝不抛异常 — 确保调用方（StockInfoPushService）通知流程不受影响。
     */
    static async triggerStockTrace(
        input: StockTraceTriggerInput,
    ): Promise<StockTraceTriggerResult> {
        const { symbol, traceId } = input;

        // ── fail-closed：Token 或 URL 未配置 ──
        const token = readToken();
        if (!isTokenConfigured(token)) {
            console.log(
                `[StockTraceTrigger] skipped: token not configured (traceId=${traceId}, symbol=${symbol})`,
            );
            return { status: 'skipped', traceId, reason: 'internal token not configured' };
        }

        const baseUrl = readPythonUrl();
        if (!baseUrl) {
            console.log(
                `[StockTraceTrigger] skipped: PYTHON_AGENT_URL not configured (traceId=${traceId}, symbol=${symbol})`,
            );
            return { status: 'skipped', traceId, reason: 'PYTHON_AGENT_URL not configured' };
        }

        // ── 发起请求 ──
        const url = `${baseUrl.replace(/\/+$/, '')}/api/agent/trace/stock/trigger`;
        const body = JSON.stringify({ symbol, trace_id: traceId });

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Internal-Token': token,
                },
                body,
                signal: AbortSignal.timeout(TRACE_TIMEOUT_MS),
            });

            // ── HTTP 非 2xx ──
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                console.error(
                    `[StockTraceTrigger] failed: HTTP ${response.status} ${response.statusText}` +
                        ` (traceId=${traceId}, symbol=${symbol})` +
                        (text ? ` body=${text.slice(0, 500)}` : ''),
                );
                return {
                    status: 'failed',
                    traceId,
                    reason: `HTTP ${response.status} ${response.statusText}`,
                };
            }

            // ── 解析响应 ──
            let data: Record<string, unknown>;
            try {
                data = (await response.json()) as Record<string, unknown>;
            } catch {
                console.error(
                    `[StockTraceTrigger] failed: invalid JSON response (traceId=${traceId}, symbol=${symbol})`,
                );
                return { status: 'failed', traceId, reason: 'invalid JSON response from Python' };
            }

            const pythonStatus = String(data.status || '');
            if (pythonStatus === 'completed') {
                console.log(
                    `[StockTraceTrigger] completed (traceId=${traceId}, symbol=${symbol})`,
                );
                return { status: 'completed', traceId };
            }

            // degraded 响应
            const degradedReason = String(data.degraded_reason || 'unknown degradation');
            console.warn(
                `[StockTraceTrigger] degraded: ${degradedReason} (traceId=${traceId}, symbol=${symbol})`,
            );
            return { status: 'degraded', traceId, reason: degradedReason };
        } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            console.error(
                `[StockTraceTrigger] failed: ${errMsg} (traceId=${traceId}, symbol=${symbol})`,
            );
            return { status: 'failed', traceId, reason: errMsg };
        }
    }
}
