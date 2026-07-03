import dotenv from 'dotenv';
dotenv.config();

import Redis from 'ioredis';

const redisUrl = process.env.REDIS_URL || 'redis://127.0.0.1:6379/2';

const redis = new Redis(redisUrl, {
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
    commandTimeout: 3000,
    retryStrategy(times) {
        if (times > 3) return null; // 停止重试
        const delay = Math.min(times * 1000, 3000);
        return delay;
    },
    lazyConnect: true, // 延迟连接，不阻塞启动
});

redis.on('error', (err) => {
    // 只在非连接拒绝错误时打印
    if (!err.message.includes('ECONNREFUSED')) {
        console.error('[Redis] Error:', err.message);
    }
});

redis.on('connect', () => {
    console.log('[Redis] Connected successfully');
});

export default redis;
