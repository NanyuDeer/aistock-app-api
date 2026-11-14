/**
 * 个股 AI 分析非流式分支流式化回归测试。
 *
 * 背景（2026-11-15）：App「短线洞见 → 重新分析」走非流式 POST，
 * 上游大模型网关在生成超过约 60s 时断连，服务端 63.5s 返回 500；
 * 同服务直调 40.7s 成功。契约：非流式分支内部也走流式请求，
 * 规避网关空闲超时；流式失败时回退非流式。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import { StockAnalysisService } from '../StockAnalysisService'

type AnyService = Record<string, any>

const VALID_RESULT = JSON.stringify({
    结论: '中性',
    核心逻辑: '测试逻辑',
    风险提示: '测试风险',
})

test('非流式分支内部走 requestModelStream', async () => {
    const service = StockAnalysisService as unknown as AnyService
    const originalStream = service.requestModelStream
    const originalModel = service.requestModel
    let streamCalls = 0
    let modelCalls = 0
    service.requestModelStream = async () => {
        streamCalls += 1
        return VALID_RESULT
    }
    service.requestModel = async () => {
        modelCalls += 1
        return VALID_RESULT
    }
    try {
        const result = await service.generateStockAnalysis('新闻', '预测', '交易')
        assert.equal(result['结论'], '中性')
        assert.equal(streamCalls, 1)
        assert.equal(modelCalls, 0)
    } finally {
        service.requestModelStream = originalStream
        service.requestModel = originalModel
    }
})

test('流式失败时回退 requestModel', async () => {
    const service = StockAnalysisService as unknown as AnyService
    const originalStream = service.requestModelStream
    const originalModel = service.requestModel
    let streamCalls = 0
    let modelCalls = 0
    service.requestModelStream = async () => {
        streamCalls += 1
        throw new Error('stream failed')
    }
    service.requestModel = async () => {
        modelCalls += 1
        return VALID_RESULT
    }
    try {
        const result = await service.generateStockAnalysis('新闻', '预测', '交易')
        assert.equal(result['结论'], '中性')
        assert.equal(streamCalls, 1)
        assert.equal(modelCalls, 1)
    } finally {
        service.requestModelStream = originalStream
        service.requestModel = originalModel
    }
})
