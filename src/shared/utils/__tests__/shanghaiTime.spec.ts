/**
 * shanghaiTime.asBeijingAwareText 单测
 *
 * 该函数由 StockTraceSnapshotService 的私有实现上提而来（提交 15b5760 引入），
 * 供 EastmoneyCrawler.toChinaIso 等复用。核心契约：把**裸北京墙钟串**补固定
 * `+08:00`；带时区（`Z` / `±HH:MM`）或仅日期的串**原样透传**；本函数**不 trim**
 * （首尾空白由调用方负责，既有调用点均已 `.trim()`）。
 *
 * 断言输出字符串与时刻，二者均与宿主时区无关（CI runner 为 UTC）。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { asBeijingAwareText } from '../shanghaiTime';

describe('shanghaiTime.asBeijingAwareText', () => {
    it('裸秒级串 → T 分隔 + 固定 +08:00', () => {
        assert.equal(asBeijingAwareText('2026-08-12 10:00:00'), '2026-08-12T10:00:00+08:00');
    });

    it('裸到分钟串补全秒', () => {
        assert.equal(asBeijingAwareText('2026-08-12 10:00'), '2026-08-12T10:00:00+08:00');
    });

    it('带毫秒的裸串保留毫秒', () => {
        assert.equal(asBeijingAwareText('2026-08-12 10:00:00.123'), '2026-08-12T10:00:00.123+08:00');
    });

    it('接受 T 分隔（日期与时间无空格）', () => {
        assert.equal(asBeijingAwareText('2026-08-12T10:00:00'), '2026-08-12T10:00:00+08:00');
    });

    it('已带 Z 的串原样透传', () => {
        assert.equal(asBeijingAwareText('2026-08-12T10:00:00Z'), '2026-08-12T10:00:00Z');
    });

    it('已带 ±HH:MM 的串原样透传', () => {
        assert.equal(asBeijingAwareText('2026-08-12T10:00:00+09:00'), '2026-08-12T10:00:00+09:00');
        assert.equal(asBeijingAwareText('2026-08-12 10:00:00-05:00'), '2026-08-12 10:00:00-05:00');
    });

    it('仅日期串原样透传（本函数不把它补成 T00:00:00+08:00）', () => {
        // 保持 StockTraceSnapshotService 既有语义：仅日期按规范解释为 UTC 零点，交给 new Date。
        assert.equal(asBeijingAwareText('2026-08-12'), '2026-08-12');
    });

    it('含首尾空白的串不匹配 → 原样返回（trim 由调用方负责）', () => {
        assert.equal(asBeijingAwareText('  2026-08-12 10:00:00  '), '  2026-08-12 10:00:00  ');
        // 调用方 trim 后即可正常补偏移
        assert.equal(asBeijingAwareText('  2026-08-12 10:00:00  '.trim()), '2026-08-12T10:00:00+08:00');
    });

    it('空串原样返回', () => {
        assert.equal(asBeijingAwareText(''), '');
    });

    it('补偏移后解析得到与宿主时区无关的时刻', () => {
        assert.equal(
            new Date(asBeijingAwareText('2026-08-12 10:00:00')).toISOString(),
            '2026-08-12T02:00:00.000Z',
            '北京 10:00 必须是 02:00Z；若随时区变化说明补偏移失效',
        );
    });
});
