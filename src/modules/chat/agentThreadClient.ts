/**
 * agent-py chat thread 删除客户端 — 删会话联动删 checkpointer thread（Phase 5）
 *
 * app-api 直连 agent-py `DELETE /api/agent/internal/chat/threads/{session_id}`
 * （agent-py 路由实际挂载在 /api/agent 前缀下，见其 main.py include_router）。
 * env 约定沿用 chat-bridge：
 * - 地址：AGENT_PY_URL || PYTHON_AGENT_URL || 'http://localhost:8080'（agent-py 默认端口 8080）
 * - token：INTERNAL_API_TOKEN || INTERNAL_TOKEN || 'change-me-in-production'
 *   （已核对与 agent-py settings.internal_api_token 默认值一致，生产/本地一致）
 *
 * 超时：AbortController ~3s，保证删会话最坏延迟有界（"永不 500"由调用侧 catch）。
 * 非 2xx 一律抛错，由 SessionController.remove 捕获记 warning。
 */

const AGENT_PY_URL = process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || 'http://localhost:8080';
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';
/** 联动删除超时（ms）：bounded 最坏 +3s 延迟 */
const THREAD_DELETE_TIMEOUT_MS = 3000;

export async function deleteChatThread(sessionId: string): Promise<void> {
    const url = `${AGENT_PY_URL}/api/agent/internal/chat/threads/${encodeURIComponent(sessionId)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), THREAD_DELETE_TIMEOUT_MS);
    try {
        const resp = await fetch(url, {
            method: 'DELETE',
            headers: { 'X-Internal-Token': INTERNAL_TOKEN },
            signal: controller.signal,
        });
        if (!resp.ok) {
            throw new Error(`agent thread delete failed: HTTP ${resp.status}`);
        }
    } finally {
        clearTimeout(timer);
    }
}
