/**
 * 回归测试：路由注册顺序（2026-09-25 线上 404 根因）
 *
 * 背景：publicRouter 含通用路由 GET /event/:eventId。Express 按注册顺序匹配，
 * 若 eventTimelinePublicRouter（/event/timeline）注册在其之后，请求
 * GET /api/agent/event/timeline 会被 /event/:eventId 截获（eventId='timeline'）
 * → 查库无此事件 → 404 { code: -1, message: 'Event not found' }。
 *
 * 该缺陷只在 index.ts 组合挂载后显现，单独挂载 router 的单测无法发现，
 * 故在此静态断言挂载顺序，防止后续调整时回归。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const INDEX_SRC = readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8')

test('重大事件时间线路由必须先于 publicRouter 挂载', () => {
    const timelineAt = INDEX_SRC.indexOf("app.use('/api/agent', eventTimelinePublicRouter)")
    const publicRouterAt = INDEX_SRC.indexOf("app.use('/api/agent', publicRouter)")

    assert.ok(timelineAt >= 0, '未找到 eventTimelinePublicRouter 的挂载语句')
    assert.ok(publicRouterAt >= 0, '未找到 publicRouter 的挂载语句')
    assert.ok(
        timelineAt < publicRouterAt,
        'eventTimelinePublicRouter 必须先于 publicRouter 挂载：'
            + '否则 /api/agent/event/timeline 会被 publicRouter 的通用路由 /event/:eventId 截获并返回 404',
    )
})
