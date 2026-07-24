/**
 * Review trigger handler —— 复盘溯源手动触发
 *
 * 从 index.ts 抽出，使路由逻辑可被单元测试直接导入。
 *
 * 安全设计：
 * - 鉴权使用 INTERNAL_API_TOKEN || INTERNAL_TOKEN，缺失时 **fail closed**（默认值不作为有效凭据）
 * - 检查上游 response.ok，403/4xx/5xx 不包装成 200
 * - 安全处理非 JSON 上游响应
 */

import type { Request, Response } from 'express';

/** 默认占位 token——仅用于开发环境，生产环境 **不可**作为有效凭据 */
const DEFAULT_PLACEHOLDER = 'change-me-in-production';

/**
 * 读取有效内部 token。
 * - 优先 INTERNAL_API_TOKEN
 * - 回退 INTERNAL_TOKEN
 * - **都不存在时返回 null（fail closed）**
 */
function getValidInternalToken(): string | null {
    const apiToken = process.env.INTERNAL_API_TOKEN;
    if (apiToken && apiToken !== DEFAULT_PLACEHOLDER) {
        return apiToken;
    }
    const legacyToken = process.env.INTERNAL_TOKEN;
    if (legacyToken && legacyToken !== DEFAULT_PLACEHOLDER) {
        return legacyToken;
    }
    return null;
}

/** 从请求中提取 token */
function extractToken(req: Request): string | undefined {
    const headerToken = req.headers['x-internal-token'];
    if (typeof headerToken === 'string' && headerToken) {
        return headerToken;
    }
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
        return authHeader.slice(7);
    }
    return undefined;
}

/** 比较 token（常数时间比较，防止时序攻击） */
function safeCompare(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }
    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i);
    }
    return result === 0;
}

/**
 * 创建 Review trigger 的 Express handler。
 *
 * 测试时直接导入此函数并挂载到测试 Express app，不复制路由逻辑。
 */
export function createReviewTriggerHandler() {
    return async (req: Request, res: Response): Promise<void> => {
        const validToken = getValidInternalToken();
        if (!validToken) {
            console.error('[ReviewTrigger] 拒绝请求：INTERNAL_API_TOKEN 和 INTERNAL_TOKEN 均未配置');
            res.status(503).json({
                success: false,
                message: '服务端未配置内部 Token，拒绝请求',
            });
            return;
        }

        const token = extractToken(req);
        if (!token || !safeCompare(token, validToken)) {
            res.status(401).json({ error: 'unauthorized' });
            return;
        }

        const startTime = Date.now();
        console.log('[ReviewTrigger] 开始手动触发 review 复盘溯源...');

        const pythonUrl = process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || 'http://localhost:8000';
        const triggerUrl = `${pythonUrl}/api/agent/briefing/review/trigger`;

        try {
            const response = await fetch(triggerUrl, {
                method: 'POST',
                headers: {
                    'x-internal-token': validToken,
                    'content-type': 'application/json',
                },
                // 支持指定历史日期：POST body 传 { "report_date": "2026-07-18" }
                body: req.body && Object.keys(req.body).length > 0
                    ? JSON.stringify(req.body)
                    : JSON.stringify({}),
            });

            if (!response.ok) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                let upstreamBody: unknown = null;
                try {
                    upstreamBody = await response.json();
                } catch {
                    // 非 JSON 响应，忽略
                }
                console.error(
                    `[ReviewTrigger] 上游返回非 OK 状态 ${response.status} (${elapsed}s)`,
                    upstreamBody,
                );
                if (response.status === 403) {
                    res.status(403).json({
                        success: false,
                        message: '上游 Python 拒绝访问（鉴权失败）',
                        upstream_status: response.status,
                    });
                } else {
                    res.status(502).json({
                        success: false,
                        message: `上游 Python 返回 ${response.status}`,
                        upstream_status: response.status,
                    });
                }
                return;
            }

            let result: any;
            try {
                result = await response.json();
            } catch (jsonErr) {
                const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
                console.error(`[ReviewTrigger] 上游响应非 JSON (${elapsed}s)`, jsonErr);
                res.status(502).json({
                    success: false,
                    message: '上游返回非 JSON 响应',
                });
                return;
            }

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            if (result.success) {
                console.log(
                    `[ReviewTrigger] review 复盘溯源生成完成 (${elapsed}s) | ` +
                    `report_date=${result.report_date}`
                );
            } else {
                console.error(
                    `[ReviewTrigger] review 复盘溯源生成失败 (${elapsed}s): ${result.message}`
                );
            }

            res.json({
                success: result.success,
                message: result.message,
                report_date: result.report_date,
                elapsed_seconds: parseFloat(elapsed),
            });
        } catch (err: any) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.error(`[ReviewTrigger] review 复盘溯源请求失败 (${elapsed}s):`, err?.message || err);
            res.status(502).json({
                success: false,
                message: `Python Agent 调用失败: ${err?.message || err}`,
                elapsed_seconds: parseFloat(elapsed),
            });
        }
    };
}
