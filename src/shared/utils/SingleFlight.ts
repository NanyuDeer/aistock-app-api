/**
 * 并发同 key 请求合并（single-flight）。
 *
 * 为什么需要：缓存穿透（Redis 未命中）时，同一 key 的并发请求会各自直打上游
 * （腾讯行情 / Tushare / 同花顺），既浪费配额，也容易触发上游限流。
 * 本工具只合并「在途请求」，不承担缓存职责——结果缓存仍由 CacheService 负责。
 *
 * 约束：
 * - 成功与失败都在 finally 清理：失败不会被记住，下一次调用会重新执行；
 * - 不传 AbortSignal：单个调用方取消不能拖垮共享同一 Promise 的其他调用方；
 * - 每个 service 持有自己的实例，key 不做跨服务拼接，避免碰撞。
 */
export class SingleFlight {
    private readonly inflight = new Map<string, Promise<unknown>>();
    private coalesced = 0;

    run<T>(key: string, loader: () => Promise<T>): Promise<T> {
        const existing = this.inflight.get(key);
        if (existing) {
            this.coalesced += 1;
            return existing as Promise<T>;
        }

        // 先注册再返回：loader 内部同步抛错也会走 finally 清理。
        const task = (async () => loader())().finally(() => {
            this.inflight.delete(key);
        });
        this.inflight.set(key, task);
        return task;
    }

    /** 观测出口：coalesced = 被合并掉的重复调用次数。 */
    stats(): { coalesced: number; inflight: number } {
        return { coalesced: this.coalesced, inflight: this.inflight.size };
    }
}
