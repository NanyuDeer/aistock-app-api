/**
 * 个股 AI 分析大模型超时解析测试。
 *
 * 背景（2026-11-12 周会任务 3）：线上 `POST /api/cn/stocks/:symbol/analysis`
 * 恒定 45s 后 500。实测模型单次真实分析请求约 51s，而硬编码超时 45s
 * 必然 AbortError。契约：默认 120s，可由 STOCK_ANALYSIS_LLM_TIMEOUT_MS
 * 覆盖，非法/过小值回落默认值。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveStockAnalysisLlmTimeoutMs } from '../StockAnalysisService'

test('resolveStockAnalysisLlmTimeoutMs 默认 120000', () => {
    const previous = process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS
    delete process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS
    try {
        assert.equal(resolveStockAnalysisLlmTimeoutMs(), 120_000)
    } finally {
        if (previous === undefined) delete process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS
        else process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS = previous
    }
})

test('resolveStockAnalysisLlmTimeoutMs 支持环境变量覆盖', () => {
    const previous = process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS
    process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS = '90000'
    try {
        assert.equal(resolveStockAnalysisLlmTimeoutMs(), 90_000)
    } finally {
        if (previous === undefined) delete process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS
        else process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS = previous
    }
})

test('resolveStockAnalysisLlmTimeoutMs 非法或过小值回落默认', () => {
    const previous = process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS
    try {
        for (const raw of ['abc', '0', '-1', '29999', '']) {
            process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS = raw
            assert.equal(resolveStockAnalysisLlmTimeoutMs(), 120_000, `raw=${raw}`)
        }
    } finally {
        if (previous === undefined) delete process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS
        else process.env.STOCK_ANALYSIS_LLM_TIMEOUT_MS = previous
    }
})
