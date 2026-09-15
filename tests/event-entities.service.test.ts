/**
 * Event Entity 服务层纯函数测试（spec §3/§10，design-debate 定稿）：
 * - computeEventStatus：date-only/单日/多日/无 start 四个边界的确定性状态机
 * - normalizeTitle / canonicalKey：canonical_event_key = event_start_date|canonical_title
 *
 * 不连真实 DB（upsert/list 的 SQL 行断言由联调探针承担）。
 */

import assert from 'node:assert/strict'
import test from 'node:test'

import {
    canonicalKey,
    computeEventStatus,
    normalizeTitle,
} from '../src/modules/event-entities/EventEntityService'

test('computeEventStatus：date-only 事件当日整天 ongoing、次日 0 点起 occurred（spec §3.4）', () => {
    const start = '2026-09-23T00:00:00+08:00'
    assert.equal(computeEventStatus(start, null, '2026-09-22T23:59:59+08:00'), 'scheduled')
    assert.equal(computeEventStatus(start, null, '2026-09-23T00:00:00+08:00'), 'ongoing')
    assert.equal(computeEventStatus(start, null, '2026-09-23T18:00:00+08:00'), 'ongoing')
    assert.equal(computeEventStatus(start, null, '2026-09-24T00:00:00+08:00'), 'occurred')
})

test('computeEventStatus：单日带具体时刻 = end=start，now≤end ongoing、之后 occurred', () => {
    const start = '2026-09-23T14:00:00+08:00'
    assert.equal(computeEventStatus(start, null, '2026-09-23T13:59:59+08:00'), 'scheduled')
    assert.equal(computeEventStatus(start, null, '2026-09-23T14:00:00+08:00'), 'ongoing')
    assert.equal(computeEventStatus(start, null, '2026-09-23T14:00:01+08:00'), 'occurred')
})

test('computeEventStatus：多日事件 start≤now≤end → ongoing、now>end → occurred', () => {
    const start = '2026-09-23T09:00:00+08:00'
    const end = '2026-09-25T17:00:00+08:00'
    assert.equal(computeEventStatus(start, end, '2026-09-24T12:00:00+08:00'), 'ongoing')
    assert.equal(computeEventStatus(start, end, '2026-09-25T17:00:00+08:00'), 'ongoing')
    assert.equal(computeEventStatus(start, end, '2026-09-25T17:00:01+08:00'), 'occurred')
})

test('computeEventStatus：event_start_time 为 NULL（历史 fallback）→ 保守判 occurred，不冒充未来', () => {
    assert.equal(computeEventStatus(null, null, '2026-09-24T12:00:00+08:00'), 'occurred')
})

test('normalizeTitle：去空白/标点/符号/全半角、小写（跨通道一致先例）', () => {
    assert.equal(normalizeTitle('  美联储  议息，议息！'), '美联储议息议息')
    assert.equal(normalizeTitle('ＡＢＣ 议息'), 'abc议息')
    assert.equal(normalizeTitle('下半年GDP展望'), '下半年gdp展望')
    // 中文标点/破折号同样剥离（/ 属 \p{P} 标点）
    assert.equal(normalizeTitle('9/17——美联储议息'), '917美联储议息')
})

test('canonicalKey：确定性且与书写噪声无关；不同日期同标题 → 不同 key', () => {
    const a1 = canonicalKey('2026-09-17', '美联储议息')
    const a2 = canonicalKey('2026-09-17', '  美联储 议息，')
    const b = canonicalKey('2026-09-23', '美联储议息')
    assert.equal(a1, a2)
    assert.notEqual(a1, b)
    assert.ok(a1.startsWith('2026-09-17|'))
})