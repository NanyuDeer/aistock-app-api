/**
 * Event Article API — GET /api/agent/event/:eventId/article
 * 完整发布前回归测试（本地 mock，不连接本地/生产数据库、不部署、不改生产库）
 *
 * Mock strategy（与 event_conduction.spec.ts 一致）：
 *   - monkey-patch pool.query 在同一对象引用上（内部路由在 import 时即捕获该引用），
 *     不发任何真实 DB 连接。
 *   - mock ClsStockNewsService.getNewsFulltext 以覆盖「实时正文抓取成功/失败」，
 *     避免真实网络调用带来的不确定性。
 *
 * 覆盖维度：
 *   A. 匹配规则：newsId→payload.id / url 精确 / title 归一化模糊
 *   B. 正文：有正文 / 空正文 / 非字符串正文 / payload 缺失 / content 缺失
 *   C. 数据缺失：source 空 / source URL 异常 / event_scrape 不存在 / events 空 / events 非数组
 *   D. 多条记录：多 event_scrape / 多事件时不误匹配其他事件
 *   E. 日期：Date 对象 / 'YYYY-MM-DD' / 带时区 ISO / 非法 / 跨月 / 跨年
 *   F. SQL：成功 / event_scrape 查询异常 / event_conduction 查询异常（真异常→500）
 *   G. 实时兜底：抓取成功 / 抓取失败降级
 *   H. 结构安全：null/undefined 访问、无 RangeError、无 42P18、占位符数与参数数一致
 */

import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'http'
import type { AddressInfo } from 'net'
import express, { type Express } from 'express'
import pool from '../../db'
import { publicRouter } from '../internal'
import { ClsStockNewsService } from '../../../modules/monitor/ClsStockNewsService'

// ── Mock pool.query ──

type MockQuery = (sql: string, ...rest: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>

const originalQuery = pool.query.bind(pool) as unknown as MockQuery
let mockCalls: { sql: string; params: unknown[] }[] = []

type SqlKind = 'event_conduction' | 'event_scrape'

function classify(sql: string): SqlKind | 'other' {
    if (sql.includes("report_type = 'event_conduction'")) return 'event_conduction'
    if (sql.includes("report_type = 'event_scrape'")) return 'event_scrape'
    return 'other'
}

// 配置当前 mock 的 query 行为（可注入异常）
let failSql: RegExp | null = null
let failError: Error = new Error('mock db error')
;(pool as unknown as { query: MockQuery }).query = function (sql, ...rest) {
    mockCalls.push({ sql, params: rest.length === 1 && Array.isArray(rest[0]) ? rest[0] : rest })
    if (failSql && failSql.test(sql)) return Promise.reject(failError)
    const kind = classify(sql)
    const rowsByKind = currentRows
    return Promise.resolve({ rows: kind === 'other' ? [] : (rowsByKind[kind] ?? []) })
}

let currentRows: Partial<Record<SqlKind, Array<Record<string, unknown>>>> = {}

function installResponder(rowsByKind: Partial<Record<SqlKind, Array<Record<string, unknown>>>>) {
    mockCalls = []
    currentRows = rowsByKind
    failSql = null
}

function installFail(failWhen: Partial<Record<SqlKind, boolean>>, err?: Error) {
    mockCalls = []
    failSql = new RegExp(
        failWhen['event_conduction']
            ? "report_type = 'event_conduction'"
            : "report_type = 'event_scrape'"
    )
    failError = err ?? new Error('mock db error')
}

// ── Mock ClsStockNewsService.getNewsFulltext（实时兜底） ──

const realGetNewsFulltext = ClsStockNewsService.getNewsFulltext
type FulltextResult = { title: string; content: string; link: string; time: string } | null
let fulltextResult: FulltextResult | null = null
let fulltextError: Error | null = null

;(ClsStockNewsService as unknown as {
    getNewsFulltext: (id: string) => Promise<FulltextResult>
}).getNewsFulltext = async () => {
    if (fulltextError) throw fulltextError
    return fulltextResult
}

// ── HTTP 辅助 ──

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

// ── 数据构造（与生产 JSONB 结构一致） ──

function conductionRow(args: {
    eventId: string
    content?: Record<string, unknown>
    reportDate: unknown
    created_at?: string
}): Record<string, unknown> {
    return {
        id: 1,
        report_date: args.reportDate,
        content: args.content ?? { eventId: args.eventId },
        created_at: args.created_at ?? '2026-08-25T08:00:00Z',
    }
}

function eventScrapeRow(events: unknown, reportDate: unknown): Record<string, unknown> {
    return {
        id: 2,
        report_date: reportDate,
        content: { events },
        created_at: '2026-08-25T08:00:00Z',
    }
}

interface ScrapeEventArgs {
    title?: unknown
    url?: unknown
    payload?: unknown
}

function scrapeEvent(args: ScrapeEventArgs): Record<string, unknown> {
    return {
        title: args.title ?? '',
        url: args.url ?? '',
        payload: args.payload ?? {},
    }
}

interface ArticleData {
    title: unknown
    source: unknown
    sourceName: unknown
    publishTime: unknown
    content: unknown
    sourceUrl: unknown
    hasContent: unknown
}

function readData(res: CallResult): ArticleData {
    assert.strictEqual(res.status, 200, `期望 200，实际 ${res.status}\nbody=${res.text}`)
    const body = res.json as { code: number; data: ArticleData }
    assert.strictEqual(body.code, 0)
    assert.ok(body.data, 'data 应存在')
    return body.data
}

// 断言 SQL 修复（42P18 / RangeError 相关）
function assertScrapeSqlSafe() {
    const scrapeCall = mockCalls.find((c) => c.sql.includes('event_scrape'))
    assert.ok(scrapeCall, '应存在 event_scrape 查询')
    assert.ok(!/ANY\(\$/.test(scrapeCall!.sql), '不应使用 = ANY($n)')
    for (const p of scrapeCall!.params) assert.ok(typeof p === 'string', '日期参数应为标量字符串')
    const placeholders = (scrapeCall!.sql.match(/\$\d+/g) ?? []).length
    assert.strictEqual(placeholders, scrapeCall!.params.length, '占位符数量 === 参数数量')
}

// ── Tests ──

describe('GET /api/agent/event/:eventId/article — 完整本地回归', () => {
    before(() => {
        mockCalls = []
    })

    after(() => {
        ;(pool as unknown as { query: MockQuery }).query = originalQuery
        ;(ClsStockNewsService as unknown as {
            getNewsFulltext: (id: string) => Promise<FulltextResult>
        }).getNewsFulltext = realGetNewsFulltext
    })

    afterEach(() => {
        fulltextResult = null
        fulltextError = null
    })

    // ═══ A. 匹配规则 ═══

    it('A1: 财联社 newsId → payload.id 精确匹配，正文非空', async () => {
        const source = 'https://www.cls.cn/detail/1234567'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'A1',
                content: { title: '财联社正文事件', source, source_name: '财联社' },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '财联社正文事件',
                url: source,
                payload: { id: '1234567', content: '财联社原文真实正文……（newsId 匹配 payload.id）' },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/A1/article'))
        assert.strictEqual(d.hasContent, true)
        assert.ok(typeof d.content === 'string' && (d.content as string).length > 0)
        assert.strictEqual(d.source, source)
        assert.strictEqual(d.sourceName, '财联社')
        assert.strictEqual(d.sourceUrl, source)
        assert.ok((d.publishTime as string).includes('2026-08-25'))
        assertScrapeSqlSafe()
    })

    it('A2: 非财联社 URL 精确匹配 events[].url', async () => {
        const source = 'https://example.com/news/zzz'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'A2',
                content: { title: '非财联社事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '非财联社事件',
                url: source,
                payload: { id: '', content: '非财联社 URL 精确匹配正文' },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/A2/article'))
        assert.strictEqual(d.hasContent, true)
        assert.ok((d.content as string).length > 0)
        assert.strictEqual(d.sourceUrl, source)
    })

    it('A3: 财联社 URL 但是 newsId 解析失败（非数字）→ 回落规则2/3，不 500', async () => {
        const source = 'https://www.cls.cn/detail/abc-not-number'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'A3',
                content: { title: '奇怪URL事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '奇怪URL事件',
                url: source,
                payload: { id: '0', content: 'newsId 解析失败仍可用 url 匹配' },
            })], '2026-08-25')],
        })

        // newsId.match 失败 → newsId null → 跳过规则1；url 精确匹配命中规则2
        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/A3/article'))
        assert.strictEqual(d.hasContent, true)
        assert.strictEqual(d.sourceUrl, source)
    })

    it('A4: title 归一化模糊匹配（空白差异）', async () => {
        const source = 'https://example.com/x'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'A4',
                content: { title: 'A公司 发布 重要公告', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([{
                title: 'A公司  发布  重要公告', // 空白差异
                url: 'https://example.com/totally-different',
                payload: { id: '', content: '标题归一化匹配到的正文' },
            }], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/A4/article'))
        assert.strictEqual(d.hasContent, true)
        assert.ok((d.content as string).includes('标题归一化'))
    })

    it('A5: title 互为子串（较长正文标题 vs 较短 conduction 标题）也能模糊命中', async () => {
        const source = 'https://example.com/y'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'A5',
                content: { title: '某公司 2026 半年度业绩预告', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([{
                title: '某公司 2026 半年度业绩预告 全文', // conduction 标题是其子串
                url: 'https://example.com/unmatched',
                payload: { id: '', content: '子串模糊匹配正文' },
            }], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/A5/article'))
        assert.strictEqual(d.hasContent, true)
    })

    // ═══ B. 正文形态 ═══

    it('B1: payload.content 为空字符串 → hasContent=false，不 500', async () => {
        const source = 'https://www.cls.cn/detail/8888888'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'B1',
                content: { title: '空正文事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '空正文事件',
                url: source,
                payload: { id: '8888888', content: '' },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/B1/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.content, '')
    })

    it('B2: payload.content 为 null/undefined → hasContent=false', async () => {
        const source = 'https://www.cls.cn/detail/7777777'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'B2',
                content: { title: 'null正文事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: 'null正文事件',
                url: source,
                payload: { id: '7777777', content: null },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/B2/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.content, '')
        assert.ok(!String(d.content).includes('undefined'), 'content 不应含字符串 undefined')
    })

    it('B3: payload 缺失 → 走 title/url 匹配，但读取正文为空 → hasContent=false', async () => {
        const source = 'https://example.com/nopayload'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'B3',
                content: { title: '无payload事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([{
                title: '无payload事件',
                url: source,
                // payload 缺失
            }], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/B3/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.content, '')
    })

    it('B4: payload 非对象（字符串/数字）→ 不 throw，hasContent=false', async () => {
        const source = 'https://example.com/nonobj'
        for (const badPayload of ['just-a-string', 12345]) {
            installResponder({
                event_conduction: [conductionRow({
                    eventId: `B4_${String(badPayload)}`,
                    content: { title: 'payload非对象', source },
                    reportDate: '2026-08-25',
                })],
                event_scrape: [eventScrapeRow([scrapeEvent({
                    title: 'payload非对象',
                    url: source,
                    payload: badPayload,
                })], '2026-08-25')],
            })

            const d = readData(await call(buildApp(), 'GET', `/api/agent/event/B4_${String(badPayload)}/article`))
            assert.strictEqual(d.hasContent, false)
            assert.strictEqual(d.content, '')
        }
    })

    it('B5: payload.content 为非字符串（数字/布尔）→ String 化，hasContent 视内容', async () => {
        const source = 'https://example.com/nonstring'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'B5',
                content: { title: '非字符串正文', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '非字符串正文',
                url: source,
                payload: { id: '', content: 12345 },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/B5/article'))
        // String(12345) = '12345' → 非空 → hasContent true（不 throw）
        assert.strictEqual(d.hasContent, true)
        assert.strictEqual(d.content, '12345')
    })

    it('B6: events 字段缺失/非数组 → 不 throw，正常降级', async () => {
        const source = 'https://example.com/nonarray'
        const brokenContents = [{}, { events: 'not-an-array' }, { events: 7 }, { events: null }]
        let i = 0
        for (const c of brokenContents) {
            i += 1
            installResponder({
                event_conduction: [conductionRow({
                    eventId: `B6_${i}`,
                    content: { title: '坏events结构', source },
                    reportDate: '2026-08-25',
                })],
                event_scrape: [{ id: 2, report_date: '2026-08-25', content: c, created_at: '2026-08-25T08:00:00Z' }],
            })

            const d = readData(await call(buildApp(), 'GET', `/api/agent/event/B6_${i}/article`))
            assert.strictEqual(d.hasContent, false)
            assert.strictEqual(d.content, '')
        }
    })

    it('B7: events 数组含 null / 非对象元素 → 跳过，不 throw', async () => {
        const source = 'https://example.com/nullchild'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'B7',
                content: { title: '含null子项事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([
                null as unknown as Record<string, unknown>,
                'string-element',
                42,
                scrapeEvent({ title: '含null子项事件', url: source, payload: { id: '', content: '有效正文' } }),
            ], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/B7/article'))
        // 有效的第4项 url 精确命中 → 有正文
        assert.strictEqual(d.hasContent, true)
        assert.ok((d.content as string).includes('有效正文'))
    })

    // ═══ C. 数据缺失 ═══

    it('C1: source 为空/空白 → hasContent=false，不 500', async () => {
        for (const bad of ['', '   ', null, undefined]) {
            const evtId = `C1_${mockCalls.length}` // unique-ish
            installResponder({
                event_conduction: [conductionRow({
                    eventId: evtId,
                    content: { title: '无source事件', source: bad },
                    reportDate: '2026-08-25',
                })],
                event_scrape: [],
            })
            const d = readData(await call(buildApp(), 'GET', `/api/agent/event/${evtId}/article`))
            assert.strictEqual(d.hasContent, false)
            assert.strictEqual(d.content, '')
            assert.strictEqual(d.source, '')
            assert.strictEqual(d.sourceUrl, '')
        }
    })

    it('C2: event_scrape 不存在（无行）→ 实时兜底失败 → hasContent=false', async () => {
        const source = 'https://www.cls.cn/detail/9999999'
        fulltextResult = null
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'C2',
                content: { title: 'scrape缺失事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/C2/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.content, '')
    })

    it('C3: 非财联社 + scrape 无命中 → 直接 hasContent=false（不尝试实时）', async () => {
        const source = 'https://example.com/no-scrape'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'C3',
                content: { title: '非财联社无命中', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/C3/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.sourceUrl, source)
    })

    it('C4: content 整行为 null/缺字段 → 不 throw，hasContent=false', async () => {
        installResponder({
            event_conduction: [{
                id: 1,
                report_date: '2026-08-25',
                content: null,
                created_at: '2026-08-25T08:00:00Z',
            }],
            event_scrape: [],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/C4/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.content, '')
        assert.strictEqual(d.title, '')
    })

    // ═══ D. 多条记录 ═══

    it('D1: 多条 event_scrape 记录合并后仍能匹配目标事件', async () => {
        const source = 'https://www.cls.cn/detail/42424242'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'D1',
                content: { title: '跨日多条scrape', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [
                eventScrapeRow([scrapeEvent({
                    title: '无关事件A', url: 'https://example.com/other-a', payload: { id: '', content: '无关' },
                })], '2026-08-24'),
                eventScrapeRow([scrapeEvent({
                    title: '跨日多条scrape', url: source, payload: { id: '42424242', content: '目标正文' },
                })], '2026-08-25'),
                eventScrapeRow([scrapeEvent({
                    title: '无关事件B', url: 'https://example.com/other-b', payload: { id: '', content: '无关' },
                })], '2026-08-26'),
            ],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/D1/article'))
        assert.strictEqual(d.hasContent, true)
        assert.ok((d.content as string).includes('目标正文'))
        // 不应误匹配到无关事件A/B
        assert.ok(!String(d.content).includes('无关'))
    })

    it('D2: 同一事件多条 scrapes，应命中最新（created_at DESC 后先匹配到）、且返回匹配项正文', async () => {
        const source = 'https://example.com/dup'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'D2',
                content: { title: '重复scrape事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [
                // 较旧：url 不同、但 title 与其匹配——ORDER BY DESC 时旧记录在前
                eventScrapeRow([scrapeEvent({
                    title: '重写后的标题', url: 'https://example.com/old', payload: { id: '', content: '旧正文' },
                })], '2026-08-24'),
                eventScrapeRow([scrapeEvent({
                    title: '重复scrape事件', url: source, payload: { id: '', content: '新正文' },
                })], '2026-08-25'),
            ],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/D2/article'))
        // url 精确匹配优先于 title，命中第2行 → 新正文
        assert.strictEqual(d.hasContent, true)
        assert.strictEqual(d.content, '新正文')
    })

    it('D3: events 内多个事件，不能被无关事件误匹配（newsId 必须精确）', async () => {
        const source = 'https://www.cls.cn/detail/5000001'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'D3',
                content: { title: '目标区分事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([
                scrapeEvent({ title: '目标区分事件', url: 'https://example.com/target', payload: { id: '5000002', content: '错误正文-其他newsId' } }),
                scrapeEvent({ title: '目标区分事件', url: source, payload: { id: '5000001', content: '正确正文-目标newsId' } }),
            ], '2026-08-25')],
        })

        // 规则1 newsId=5000001 精确匹配 payload.id → 命中第二个事件
        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/D3/article'))
        assert.strictEqual(d.content, '正确正文-目标newsId')
        assert.strictEqual(d.hasContent, true)
    })

    // ═══ E. 日期 ═══

    it('E1: report_date 为 PG Date 对象 → publishTime 不抛 RangeError/Invalid', async () => {
        const dateObj = new Date(2026, 7, 25, 8, 0, 0)
        const source = 'https://www.cls.cn/detail/5555555'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'E1',
                content: { title: '日期对象', source },
                reportDate: dateObj,
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '日期对象', url: source, payload: { id: '5555555', content: '正文' },
            })], dateObj)],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/E1/article'))
        assert.strictEqual(d.hasContent, true)
        assert.doesNotMatch(String(d.publishTime), /Invalid|NaN|RangeError/)
        assertScrapeSqlSafe()
    })

    it('E2: report_date 为 "2026-08-25" 字符串', async () => {
        const source = 'https://www.cls.cn/detail/5556666'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'E2',
                content: { title: '字符串日期', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '字符串日期', url: source, payload: { id: '5556666', content: '正文' },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/E2/article'))
        assert.strictEqual(d.hasContent, true)
    })

    it('E3: report_date 为带时区 ISO 字符串 → 归一化截取日期前缀', async () => {
        const source = 'https://www.cls.cn/detail/5557777'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'E3',
                content: { title: 'ISO带时区', source },
                reportDate: '2026-08-25T08:49:08.719+08:00',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: 'ISO带时区', url: source, payload: { id: '5557777', content: '正文' },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/E3/article'))
        assert.strictEqual(d.hasContent, true)
        // 必须有值且不含 Invalid
        assert.ok(/^\d{4}-\d{2}-\d{2}/.test(String(d.publishTime)))
        assertScrapeSqlSafe()
    })

    it('E4: report_date 非法 → normalizeArticleDate 返回 ""，跳过 scrape 匹配，hasContent=false 不 500', async () => {
        for (const badDate of ['not-a-date', 'abc', 12345, '2026-13-99']) {
            const evtId = `E4_${String(badDate).replace(/[^a-z0-9]/gi, '_')}`
            installResponder({
                event_conduction: [conductionRow({
                    eventId: evtId,
                    content: { title: '非法日期', source: 'https://example.com/x' },
                    reportDate: badDate,
                })],
                event_scrape: [],
            })

            const d = readData(await call(buildApp(), 'GET', `/api/agent/event/${evtId}/article`))
            assert.strictEqual(d.hasContent, false, `日期 ${String(badDate)} 应降级 expected=false`)
            assert.strictEqual(d.content, '')
        }
    })

    it('E5: 跨月（月底→次月初）shift ∓1 天正确', async () => {
        const source = 'https://www.cls.cn/detail/7100001'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'E5',
                content: { title: '跨月事件', source },
                reportDate: '2026-08-01',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '跨月事件', url: source, payload: { id: '7100001', content: '正文' },
            })], '2026-08-01')],
        })
        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/E5/article'))
        assert.strictEqual(d.hasContent, true)
        const scrapeCall = mockCalls.find((c) => c.sql.includes('event_scrape'))
        assert.deepStrictEqual(scrapeCall!.params, ['2026-08-01', '2026-07-31', '2026-08-02'])
    })

    it('E6: 跨年（年初→上年末）shift ∓1 天正确', async () => {
        const source = 'https://www.cls.cn/detail/7100002'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'E6',
                content: { title: '跨年事件', source },
                reportDate: '2026-01-01',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '跨年事件', url: source, payload: { id: '7100002', content: '正文' },
            })], '2026-01-01')],
        })
        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/E6/article'))
        assert.strictEqual(d.hasContent, true)
        const scrapeCall = mockCalls.find((c) => c.sql.includes('event_scrape'))
        assert.deepStrictEqual(scrapeCall!.params, ['2026-01-01', '2025-12-31', '2026-01-02'])
    })

    it('E7: report_date 为 String(Date) 格式（"Tue Aug 25 2026 ..."）→ 可解析', async () => {
        const source = 'https://www.cls.cn/detail/7100003'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'E7',
                content: { title: 'String(Date)格式', source },
                reportDate: 'Tue Aug 25 2026 08:00:00 GMT+0800 (中国标准时间)',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: 'String(Date)格式', url: source, payload: { id: '7100003', content: '正文' },
            })], '2026-08-25')],
        })
        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/E7/article'))
        assert.strictEqual(d.hasContent, true)
        assert.doesNotMatch(String(d.publishTime), /Invalid|NaN/)
    })

    // ═══ F. SQL 异常 ═══

    it('F1: event_scrape 查询异常（真 DB 错误）→ 500', async () => {
        const source = 'https://www.cls.cn/detail/8800001'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'F1',
                content: { title: 'scrape查询异常', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [],
        })
        // 显式注入 event_scrape 查询失败
        failSql = /report_type = 'event_scrape'/
        const res = await call(buildApp(), 'GET', '/api/agent/event/F1/article')
        assert.strictEqual(res.status, 500)
        const body = res.json as { code: number }
        assert.strictEqual(body.code, -1)
    })

    it('F2: event_conduction 查询异常（真 DB 错误）→ 500', async () => {
        installResponder({ event_conduction: [] })
        failSql = /report_type = 'event_conduction'/
        const res = await call(buildApp(), 'GET', '/api/agent/event/F2/article')
        assert.strictEqual(res.status, 500)
        const body = res.json as { code: number }
        assert.strictEqual(body.code, -1)
    })

    it('F3: report_date 非法 → scrapeDates 过滤为空 → 不构造非法 SQL，正常降级（F3 日期无 500）', async () => {
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'F3',
                content: { title: '日期过滤', source: 'https://example.com/x' },
                reportDate: 'bad-date-xx',
            })],
            event_scrape: [],
        })
        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/F3/article'))
        assert.strictEqual(d.hasContent, false)
        // 应不存在 event_scrape 调用（日期非法 → 空窗口跳过）
        const scrapeCall = mockCalls.find((c) => c.sql.includes('event_scrape'))
        assert.strictEqual(scrapeCall, undefined, '非法日期不应发起 event_scrape 查询')
    })

    // ═══ G. 实时兜底 ═══

    it('G1: 实时正文抓取成功 → hasContent=true', async () => {
        const source = 'https://www.cls.cn/detail/9900001'
        fulltextResult = { title: '实时抓取标题', content: '实时抓取到的正文内容。', link: source, time: '' }
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'G1',
                content: { title: '实时抓取事件', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [], // scrape 无命中 → 走实时
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/G1/article'))
        assert.strictEqual(d.hasContent, true)
        assert.ok((d.content as string).includes('实时抓取到的正文'))
    })

    it('G2: 实时正文抓取失败（抛异常）→ hasContent=false，不 500', async () => {
        const source = 'https://www.cls.cn/detail/9900002'
        fulltextError = new Error('network down')
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'G2',
                content: { title: '实时抓取失败', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/G2/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.content, '')
    })

    it('G3: 实时正文抓取返回空 content → 视为未命中，hasContent=false', async () => {
        const source = 'https://www.cls.cn/detail/9900003'
        fulltextResult = { title: '空正文', content: '', link: source, time: '' }
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'G3',
                content: { title: '实时空正文', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/G3/article'))
        assert.strictEqual(d.hasContent, false)
        assert.strictEqual(d.content, '')
    })

    // ═══ 其他 ═══

    it('H1: eventId 不存在 → 404 Event not found', async () => {
        installResponder({ event_conduction: [] })
        const res = await call(buildApp(), 'GET', '/api/agent/event/nonexistent/article')
        assert.strictEqual(res.status, 404)
        const body = res.json as { code: number; message: string }
        assert.strictEqual(body.code, -1)
        assert.match(body.message, /not found/i)
    })

    it('H2: publishTime 字段为 Date 对象时（content 内）String() 不 throw', async () => {
        const source = 'https://www.cls.cn/detail/7700001'
        const publishTimeDate = new Date(2026, 7, 25, 10, 0, 0)
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'H2',
                content: { title: 'publishTime是Date', source, publishTime: publishTimeDate },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: 'publishTime是Date', url: source, payload: { id: '7700001', content: '正文' },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/H2/article'))
        assert.strictEqual(d.hasContent, true)
        assert.ok(typeof d.publishTime === 'string')
    })

    it('H3: source 带查询参数/trailing slash 异常形态 → 不 throw', async () => {
        const source = 'https://www.cls.cn/detail/6600001?from=telegraph#frag'
        installResponder({
            event_conduction: [conductionRow({
                eventId: 'H3',
                content: { title: '带Query的URL', source },
                reportDate: '2026-08-25',
            })],
            event_scrape: [eventScrapeRow([scrapeEvent({
                title: '带Query的URL', url: source, payload: { id: '6600001', content: '正文' },
            })], '2026-08-25')],
        })

        const d = readData(await call(buildApp(), 'GET', '/api/agent/event/H3/article'))
        // newsId 正则仍能提取 6600001 → 规则1命中
        assert.strictEqual(d.hasContent, true)
    })
})