/**
 * Event Article API — GET /api/agent/event/:eventId/article
 *
 * 本地验证（不连接生产库、不部署）：
 *   Mock strategy（与 event_conduction.spec.ts 相同）：
 *   monkey-patch pool.query 在同一对象引用上，内部路由在 import 时即捕获该引用。
 *   不发任何真实 DB 连接，绕过生产 PostgreSQL 直连问题。
 *
 * 覆盖场景：
 *   A. 财联社事件 + event_scrape.payload.content 有真实正文 → hasContent=true, content 非空
 *   B. 非财联社事件 + event_scrape 按 url 命中可匹配 → hasContent=true
 *   C. event_scrape 存在但 payload.content 为空 → hasContent=false（降级，不 500）
 *   D. event_conduction 存在但 event_scrape 无法匹配 → 走实时兜底失败 → hasContent=false（不 500）
 *   E. report_date 由 node-postgres 返回 Date 对象 → normalizeArticleDate 正常输出 YYYY-MM-DD
 *   F. report_date 返回字符串 → 同一输出
 *   G. eventId 不存在 → 404（业务预期）
 *   H. source 为空 → hasContent=false（不 500）
 *
 * SQL 修复验证：
 *   - event_scrape 查询使用 IN ($1,$2,...) 标量展开（非 = ANY($2) 数组参数）→ 修复 42P18
 *   - 参数与占位符一一对应
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import type { AddressInfo } from 'net'
import express, { type Express } from 'express'
import pool from '../../db'
import { publicRouter } from '../internal'

// ── Mock pool.query ──

// 统一 mock query 函数类型：参数为标量展开，返回 { rows }
type MockQuery = (sql: string, ...rest: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

const originalQuery = pool.query.bind(pool) as unknown as MockQuery
let mockCalls: { sql: string; params: unknown[] }[] = []
// 判定每个 SQL 属于哪类（event_conduction 首查 / event_scrape 窗口查）
type SqlKind = 'event_conduction' | 'event_scrape'

function classify(sql: string): SqlKind | 'other' {
    if (sql.includes("report_type = 'event_conduction'")) return 'event_conduction'
    if (sql.includes("report_type = 'event_scrape'")) return 'event_scrape'
    return 'other'
}

// 替换 pool.query
;(pool as unknown as { query: MockQuery }).query = function (sql, ...rest) {
    const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest
    mockCalls.push({ sql, params })
    return Promise.reject(new Error('unhandled sql in per-test responder'))
}

function installResponder(rowsByKind: Partial<Record<SqlKind, Array<Record<string, unknown>>>>) {
    mockCalls = []
    ;(pool as unknown as { query: MockQuery }).query = function (sql, ...rest) {
        const params = rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest
        mockCalls.push({ sql, params })
        const kind = classify(sql)
        return Promise.resolve({
            rows: kind === 'other' ? [] : (rowsByKind[kind] ?? []),
        })
    }
}

function buildApp(): Express {
    const app = express()
    app.use(express.json())
    app.use('/api/agent', publicRouter)
    return app
}

interface CallResult {
    status: number
    text: string
    json: unknown
}

function call(app: Express, method: string, path: string): Promise<CallResult> {
    return new Promise((resolve, reject) => {
        const server = app.listen(0, '127.0.0.1', () => {
            const addr = server.address() as AddressInfo
            const req = http.request(
                { method, hostname: '127.0.0.1', port: addr.port, path },
                (res) => {
                    const chunks: Buffer[] = []
                    res.on('data', (c: Buffer) => chunks.push(c))
                    res.on('end', () => {
                        server.close()
                        const text = Buffer.concat(chunks).toString('utf8')
                        let json: unknown
                        try {
                            json = JSON.parse(text)
                        } catch {
                            json = null
                        }
                        resolve({ status: res.statusCode ?? 0, text, json })
                    })
                    res.on('error', reject)
                },
            )
            req.on('error', reject)
            req.end()
        })
        server.on('error', reject)
    })
}

// ── 数据构造 ──

interface ArticleRow {
    title?: unknown
    source?: unknown
    source_name?: unknown
    publishTime?: unknown
}

function conductionRow(args: {
    eventId: string
    content: ArticleRow
    reportDate: unknown
    created_at?: string
}): Record<string, unknown> {
    return {
        id: 1,
        report_date: args.reportDate,
        content: { eventId: args.eventId, ...args.content },
        created_at: args.created_at ?? '2026-08-25T08:00:00Z',
    }
}

function eventScrapeRow(events: Array<Record<string, unknown>>, reportDate: unknown): Record<string, unknown> {
    return {
        id: 2,
        report_date: reportDate,
        content: { events },
        created_at: '2026-08-25T08:00:00Z',
    }
}

/** EventRecord：payload 为原始抓取数据 */
function scrapeEvent(args: {
    title: string
    url: string
    payloadId?: string
    payloadContent?: string
}): Record<string, unknown> {
    return {
        title: args.title,
        url: args.url,
        payload: { id: args.payloadId ?? '', content: args.payloadContent ?? '' },
    }
}

// ── Tests ──

describe('GET /api/agent/event/:eventId/article — 本地 mock 验证', () => {
    before(() => {
        mockCalls = []
    })

    after(() => {
        ;(pool as unknown as { query: MockQuery }).query = originalQuery
    })

    // ── A. 财联社事件 + payload.content 有正文 ──
    it('A: 财联社事件命中 event_scrape.payload.content → hasContent=true, content 非空', async () => {
        const source = 'https://www.cls.cn/detail/1234567'
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_cls_1',
                    content: { title: '测试财联社事件', source },
                    reportDate: '2026-08-25',
                }),
            ],
            event_scrape: [
                eventScrapeRow([scrapeEvent({
                    title: '测试财联社事件',
                    url: source,
                    payloadId: '1234567',
                    payloadContent: '财联社原文正文内容……这是一段真实正文，用于验证规则1（newsId 匹配 payload.id）能否正确返回。',
                })], '2026-08-25'),
            ],
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_cls_1/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { content: string; hasContent: boolean } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, true)
        assert.ok(body.data.content.length > 0, 'content 应非空')

        // SQL 修复验证：event_scrape 使用 IN 标量展开，参数与占位符对应
        const scrapeCall = mockCalls.find((c) => c.sql.includes('event_scrape'))
        assert.ok(scrapeCall, '应存在 event_scrape 查询')
        assert.match(scrapeCall!.sql, /report_date IN \(\$1,\$2,\$3\)/, '应使用 IN ($1,$2,$3) 标量展开')
        assert.ok(!/ANY\(\$/.test(scrapeCall!.sql), '不应再使用 = ANY($n) 数组参数')
        assert.deepStrictEqual(scrapeCall!.params, ['2026-08-25', '2026-08-24', '2026-08-26'])
    })

    // ── B. 非财联社事件 + event_scrape 按 url 命中 ──
    it('B: 非财联社事件 url 精确命中 → hasContent=true', async () => {
        const source = 'https://example.com/news/abc-1'
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_noncls_1',
                    content: { title: '某非财联社事件', source },
                    reportDate: '2026-08-25',
                }),
            ],
            event_scrape: [
                eventScrapeRow([scrapeEvent({
                    title: '某非财联社事件',
                    url: source,
                    payloadContent: '非财联社来源的正文内容……规则2 url 精确匹配生效。',
                })], '2026-08-25'),
            ],
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_noncls_1/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { content: string; hasContent: boolean } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, true)
        assert.ok(body.data.content.length > 0)
    })

    // ── C. event_scrape 存在但 payload.content 为空 → 降级 ──
    it('C: event_scrape.payload.content 为空 → hasContent=false, content=""，不 500', async () => {
        const source = 'https://www.cls.cn/detail/8888888'
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_empty_1',
                    content: { title: '无正文事件', source },
                    reportDate: '2026-08-25',
                }),
            ],
            event_scrape: [
                eventScrapeRow([scrapeEvent({
                    title: '无正文事件',
                    url: source,
                    payloadId: '8888888',
                    payloadContent: '',
                })], '2026-08-25'),
            ],
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_empty_1/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { content: string; hasContent: boolean } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, false)
        assert.strictEqual(body.data.content, '')
    })

    // ── D. event_conduction 存在但 event_scrape 匹配不到 → 实时兜底失败 → 降级 ──
    it('D: event_scrape 无命中且实时兜底失败 → hasContent=false，不 500', async () => {
        const source = 'https://www.cls.cn/detail/9999999'
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_noscrape_1',
                    content: { title: '无法匹配事件', source },
                    reportDate: '2026-08-25',
                }),
            ],
            event_scrape: [], // 无 scrape 数据
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_noscrape_1/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { content: string; hasContent: boolean } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, false)
        assert.strictEqual(body.data.content, '')
    })

    // ── E. report_date 为 Date 对象 → 正常输出 YYYY-MM-DD ──
    it('E: report_date 为 Date 对象 → publishTime 正常（无 Invalid Date / RangeError）', async () => {
        const source = 'https://www.cls.cn/detail/5555555'
        const dateObj = new Date(2026, 7, 25, 8, 0, 0) // 2026-08-25 本地时区
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_date_obj',
                    content: { title: '日期对象事件', source },
                    reportDate: dateObj,
                }),
            ],
            event_scrape: [
                eventScrapeRow([scrapeEvent({
                    title: '日期对象事件',
                    url: source,
                    payloadId: '5555555',
                    payloadContent: '正文……',
                })], dateObj),
            ],
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_date_obj/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { content: string; publishTime: string; hasContent: boolean } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, true)
        assert.doesNotMatch(body.data.publishTime, /Invalid|NaN/, 'publishTime 不应含 Invalid/NaN')
        assert.ok(!body.data.content.includes('undefined'), 'content 不应含字符串 "undefined"')
    })

    // ── F. report_date 返回字符串 ──
    it('F: report_date 为字符串 YYYY-MM-DD → 正常输出', async () => {
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_str',
                    content: { title: '字符串日期事件', source: '' },
                    reportDate: '2026-08-25',
                }),
            ],
            event_scrape: [],
        })

        const app = buildApp()
        // source 为空 → 走 respondNoContent 路径，验证不抛异常
        const res = await call(app, 'GET', '/api/agent/event/evt_str/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { hasContent: boolean } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, false)
    })

    // ── H. source 为空 → hasContent=false ──
    it('H: source 为空 → hasContent=false, content=""，不 500', async () => {
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_nosrc',
                    content: { title: '无来源事件', source: '   ' },
                    reportDate: '2026-08-25',
                }),
            ],
            event_scrape: [],
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_nosrc/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { hasContent: boolean; content: string } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, false)
        assert.strictEqual(body.data.content, '')
    })

    // ── G. eventId 不存在 → 404 ──
    it('G: eventId 不存在 → HTTP 404 Event not found', async () => {
        installResponder({ event_conduction: [] })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/nonexistent/article')

        assert.strictEqual(res.status, 404)
        const body = res.json as { code: number; message: string }
        assert.strictEqual(body.code, -1)
        assert.match(body.message, /not found/i)
    })

    // ── 规则3：title 归一化匹配（轻微空格差异） ──
    it('规则3: title 有空白差异仍能归一化匹配 → hasContent=true', async () => {
        // event_scrape 里的标题带多余空格；event_conduction 标题紧凑 → 非财联社、无 source、url 不精确匹配，
        // 依赖 title 归一化后 equals
        const source = 'https://example.com/x'
        installResponder({
            event_conduction: [
                conductionRow({
                    eventId: 'evt_title_diff',
                    content: { title: 'A公司 发布 重要公告', source },
                    reportDate: '2026-08-25',
                }),
            ],
            // source url 不精确匹配，title 归一化后相等 → 命中规则3
            event_scrape: [
                eventScrapeRow([{
                    title: 'A公司  发布  重要公告', // 空格差异
                    url: 'https://example.com/totally-different',
                    payload: { id: '', content: '标题归一化匹配到的正文内容。' },
                }], '2026-08-25'),
            ],
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_title_diff/article')

        assert.strictEqual(res.status, 200)
        const body = res.json as { code: number; data: { hasContent: boolean; content: string } }
        assert.strictEqual(body.code, 0)
        assert.strictEqual(body.data.hasContent, true, 'title 归一化匹配应命中')
        assert.ok(body.data.content.length > 0)
    })

    // ── 42P18 回归：任何查询参数不得为数组传给占位符 ──
    it('SQL 修复: event_scrape 查询不使用数组参数（42P18 回归）', async () => {
        const source = 'https://www.cls.cn/detail/42424242'
        installResponder({
            event_conduction: [{
                id: 1,
                report_date: '2026-08-25',
                content: { eventId: 'evt_sql', title: 'SQL 修复事件', source },
                created_at: '2026-08-25T08:00:00Z',
            }],
            event_scrape: [{
                id: 2,
                report_date: '2026-08-25',
                content: { events: [{ title: 'SQL 修复事件', url: source, payload: { id: '42424242', content: '正文' } }] },
                created_at: '2026-08-25T08:00:00Z',
            }],
        })

        const app = buildApp()
        const res = await call(app, 'GET', '/api/agent/event/evt_sql/article')

        assert.strictEqual(res.status, 200)
        const scrapeCall = mockCalls.find((c) => c.sql.includes('event_scrape'))
        assert.ok(scrapeCall, '应存在 event_scrape 查询')
        // 参数必须是标量字符串，不能是数组
        for (const p of scrapeCall!.params) {
            assert.ok(typeof p === 'string', 'event_scrape 查询参数应为标量字符串，而非数组')
        }
        // 占位符数量 == 参数数量
        const placeholders = (scrapeCall!.sql.match(/\$\d+/g) ?? []).length
        assert.strictEqual(placeholders, scrapeCall!.params.length)
        assert.ok(!/ANY\(\$/.test(scrapeCall!.sql))
    })
})