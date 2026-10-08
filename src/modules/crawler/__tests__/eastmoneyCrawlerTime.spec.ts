/**
 * EastmoneyCrawler.toChinaIso 时区无关回归测试
 *
 * 为什么：toChinaIso 长期无测试覆盖（私有函数 + 仅经需网络的 fetchAnnouncements/
 * fetchNews 触达）。旧实现用「裸串按宿主时区解析 + 手算偏移」，在任何时区都偏 ±8h
 * （生产 Asia/Shanghai 下偏早 8h，UTC runner 下偏晚 8h），产出直接作为公告/新闻
 * `published_at`，影响推送窗口判定与「当日最强」按上海日分桶。
 *
 * 本测试的核心手法：断言 `toChinaIso` 的**输出字符串**与**时刻（toISOString）**，
 * 二者都与宿主时区无关 —— 在 CI 的 UTC runner 与本地 Asia/Shanghai 下必须得到
 * 同一答案，从而锁死「裸北京墙钟串 → 保留墙上时间 + 固定 +08:00」的契约。
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { toChinaIso } from '../services/EastmoneyCrawler';

describe('EastmoneyCrawler.toChinaIso 时区无关', () => {
    it('裸秒级串按北京墙上时间补 +08:00（结果串与宿主 TZ 无关）', () => {
        const result = toChinaIso('2026-08-12 10:00:00');
        // 锁死输出串：A 格式（保留墙上时间 10:00，固定 +08:00）
        assert.equal(result, '2026-08-12T10:00:00+08:00');
        // 锁死时刻：北京 10:00 即真值 02:00Z
        assert.equal(new Date(result).toISOString(), '2026-08-12T02:00:00.000Z');
    });

    it('裸到分钟串补全秒与 +08:00', () => {
        const result = toChinaIso('2026-08-12 10:00');
        assert.equal(result, '2026-08-12T10:00:00+08:00');
        assert.equal(new Date(result).toISOString(), '2026-08-12T02:00:00.000Z');
    });

    it('带毫秒的裸串保留毫秒', () => {
        const result = toChinaIso('2026-08-12 10:00:00.123');
        assert.equal(result, '2026-08-12T10:00:00.123+08:00');
        assert.equal(new Date(result).toISOString(), '2026-08-12T02:00:00.123Z');
    });

    it('仅日期串显式按北京当日 00:00（不随宿主时区漂移）', () => {
        const result = toChinaIso('2026-08-12');
        assert.equal(result, '2026-08-12T00:00:00+08:00');
        assert.equal(new Date(result).toISOString(), '2026-08-11T16:00:00.000Z');
    });

    it('已带 Z 的串原样透传（语义不变）', () => {
        const result = toChinaIso('2026-08-12T10:00:00Z');
        assert.equal(result, '2026-08-12T10:00:00Z');
        assert.equal(new Date(result).toISOString(), '2026-08-12T10:00:00.000Z');
    });

    it('已带 ±HH:MM 的串原样透传（语义不变）', () => {
        const result = toChinaIso('2026-08-12T10:00:00+09:00');
        assert.equal(result, '2026-08-12T10:00:00+09:00');
        assert.equal(new Date(result).toISOString(), '2026-08-12T01:00:00.000Z');
    });

    it('首尾空白被 trim 后再解析', () => {
        assert.equal(toChinaIso('  2026-08-12 10:00:00  '), '2026-08-12T10:00:00+08:00');
    });

    it('非法串保持原有行为：抛出 invalid eastmoney notice time', () => {
        assert.throws(() => toChinaIso('not-a-date'), /invalid eastmoney notice time/);
        assert.throws(() => toChinaIso(''), /invalid eastmoney notice time/);
    });

    it('同一裸串在不同宿主 TZ 下输出完全一致（锁死时区无关性）', () => {
        // 该用例的价值在于：无论 CI（UTC）还是本地（Asia/Shanghai）运行，
        // 断言的都是同一常量，任何引入宿主时区依赖的实现都会在其中一个环境失败。
        assert.equal(
            new Date(toChinaIso('2026-01-01 00:30:00')).toISOString(),
            '2025-12-31T16:30:00.000Z',
            '北京 01-01 00:30 必须是 12-31 16:30Z（跨年边界，UTC 下按本地解析会错成 01-01 00:30Z）',
        );
    });
});
