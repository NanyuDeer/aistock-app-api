/**
 * HTTP Session 管理 - 按域名维护 keepAlive 连接池
 *
 * 使用方式：
 *   import { sessionFetch } from '../utils/httpAgent';
 *   const response = await sessionFetch('https://push2.eastmoney.com/api/qt/stock/get', { ... });
 *
 * 原理：Node.js 原生 http.Agent/https.Agent 的 keepAlive 复用 TCP/TLS 连接，
 * 减少握手开销，降低反爬风险。每个域名独立 Agent，避免连接池互相影响。
 * 零新依赖，无需 sudo 权限。
 */

import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';

/** Agent 配置选项 */
interface AgentPoolConfig {
    keepAlive: boolean;
    keepAliveMsecs: number;
    maxSockets: number;
    maxFreeSockets: number;
    timeout: number;
}

/** 默认配置：空闲连接保持 30 秒，最多 20 个并发 socket */
const DEFAULT_CONFIG: AgentPoolConfig = {
    keepAlive: true,
    keepAliveMsecs: 30_000,
    maxSockets: 20,
    maxFreeSockets: 5,
    timeout: 60_000,
};

/** 高频域名专用配置（东方财富、腾讯行情）：更多并发连接 */
const HIGH_FREQ_CONFIG: AgentPoolConfig = {
    ...DEFAULT_CONFIG,
    maxSockets: 30,
    maxFreeSockets: 10,
};

/** 域名 → Agent 缓存 */
const agentCache = new Map<string, http.Agent | https.Agent>();

/**
 * 域名归一化：同一主域名的不同子域名共享 Agent
 * 例如 push2.eastmoney.com 和 86.push2.eastmoney.com → eastmoney
 */
function normalizeDomain(url: string): string {
    try {
        const hostname = new URL(url).hostname;
        if (hostname.includes('eastmoney')) return 'eastmoney';
        if (hostname.includes('tushare')) return 'tushare';
        if (hostname.includes('gtimg')) return 'tencent';
        if (hostname.includes('10jqka') || hostname.includes('ths')) return 'ths';
        if (hostname.includes('cls.cn')) return 'cls';
        if (hostname.includes('gelonghui')) return 'gelonghui';
        return hostname;
    } catch {
        return 'default';
    }
}

function getAgent(url: string): http.Agent | https.Agent {
    const domain = normalizeDomain(url);
    const isHttps = url.startsWith('https');
    // 缓存键必须包含协议，避免 HTTP 请求缓存的 http.Agent 被后续 HTTPS 请求误用
    // 否则会报 "Protocol https: not supported. Expected http:" 错误
    const cacheKey = `${domain}:${isHttps ? 'https' : 'http'}`;
    let agent = agentCache.get(cacheKey);
    if (agent) return agent;

    const isHighFreq = ['eastmoney', 'tencent'].includes(domain);
    const config = isHighFreq ? HIGH_FREQ_CONFIG : DEFAULT_CONFIG;

    if (isHttps) {
        agent = new https.Agent(config);
    } else {
        agent = new http.Agent(config);
    }
    agentCache.set(cacheKey, agent);
    return agent;
}

/**
 * sessionFetch - 带 keepAlive 连接复用的 fetch
 *
 * 签名与原生 fetch 兼容：接受 URL + RequestInit，返回 Response。
 * 所有外部 HTTP 请求应使用此函数替代原生 fetch。
 */
export function sessionFetch(
    url: string | URL,
    init?: RequestInit,
): Promise<Response> {
    const urlStr = String(url);
    const parsedUrl = new URL(urlStr);
    const agent = getAgent(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';

    // 解析 headers
    const headers: Record<string, string> = {};
    if (init?.headers) {
        if (init.headers instanceof Headers) {
            init.headers.forEach((value, key) => { headers[key] = value; });
        } else if (Array.isArray(init.headers)) {
            init.headers.forEach(([key, value]) => { headers[key] = value; });
        } else {
            Object.assign(headers, init.headers);
        }
    }

    return new Promise((resolve, reject) => {
        const options: http.RequestOptions = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port || (isHttps ? 443 : 80),
            path: parsedUrl.pathname + parsedUrl.search,
            method: (init?.method || 'GET').toUpperCase(),
            headers,
            agent,
        };

        const transport = isHttps ? https : http;
        const req = transport.request(options, (res) => {
            // 读取响应体
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks);
                const responseHeaders = new Headers();
                if (res.headers) {
                    for (const [key, value] of Object.entries(res.headers)) {
                        if (value !== undefined) {
                            if (Array.isArray(value)) {
                                value.forEach(v => responseHeaders.append(key, v));
                            } else {
                                responseHeaders.set(key, value as string);
                            }
                        }
                    }
                }

                resolve(new Response(body.length > 0 ? body : null, {
                    status: res.statusCode || 500,
                    statusText: res.statusMessage || '',
                    headers: responseHeaders,
                }));
            });
        });

        req.on('error', (err) => {
            reject(err);
        });

        // 处理 AbortSignal（必须在 req 创建之后注册，避免 TDZ 错误）
        if (init?.signal) {
            if (init.signal.aborted) {
                req.destroy();
                reject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            init.signal.addEventListener('abort', () => {
                req.destroy();
                reject(new DOMException('The operation was aborted.', 'AbortError'));
            }, { once: true });
        }

        // 发送请求体
        if (init?.body) {
            if (typeof init.body === 'string') {
                req.write(init.body);
            } else if (init.body instanceof Uint8Array) {
                req.write(Buffer.from(init.body));
            } else if (typeof (init.body as any).pipe === 'function') {
                (init.body as any).pipe(req);
                return; // stream 自动 end
            }
        }
        req.end();
    });
}

/**
 * 关闭指定域名的 Agent（连接池）
 */
export function closeAgent(domain: string): void {
    const agent = agentCache.get(domain);
    if (agent) {
        agent.destroy();
        agentCache.delete(domain);
    }
}

/**
 * 关闭所有连接池（进程退出时调用）
 */
export function closeAllAgents(): void {
    const agents = Array.from(agentCache.values());
    for (const agent of agents) {
        agent.destroy();
    }
    agentCache.clear();
}
