import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isRetryableQwenError,
    qwenRetryDelayMs,
} from '../FeishuMessageAiService';

test('retries temporary Qwen connection failures', () => {
    assert.equal(isRetryableQwenError(new Error('The operation was aborted.')), true);
    assert.equal(isRetryableQwenError(new Error('Qwen HTTP 503: unavailable')), true);
    assert.equal(isRetryableQwenError(new Error('Qwen HTTP 401: invalid API key')), false);
});

test('backs off Qwen retries and caps the delay', () => {
    const original = process.env.QWEN_RETRY_BASE_MS;
    process.env.QWEN_RETRY_BASE_MS = '1000';
    try {
        assert.equal(qwenRetryDelayMs(1), 1000);
        assert.equal(qwenRetryDelayMs(2), 2000);
        assert.equal(qwenRetryDelayMs(20), 15 * 60_000);
    } finally {
        if (original === undefined) delete process.env.QWEN_RETRY_BASE_MS;
        else process.env.QWEN_RETRY_BASE_MS = original;
    }
});
