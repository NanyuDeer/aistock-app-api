/**
 * 宏观预期快照 —— 归一化与过滤逻辑单测（不连库、不发网络）。
 * 运行：node --import tsx --test src/modules/causal/__tests__/macroExpectationService.spec.ts
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
    buildRows,
    normalizeIndicator,
    type RawCalendarItem,
} from '../macroExpectationService';

const AS_OF = new Date('2026-11-09T12:00:00Z');

describe('normalizeIndicator', () => {
    it('CPI 同比归一为中国键，统计期取标题月份', () => {
        assert.deepEqual(normalizeIndicator('10月CPI同比', '中国', AS_OF), {
            indicator: 'CN_CPI_YOY',
            period: '2026-10',
            unit: '%',
        });
    });

    it('累计口径的社融仍归到截止月', () => {
        const result = normalizeIndicator('1至10月社会融资规模增量(亿人民币)', '中国', AS_OF);
        assert.equal(result?.indicator, 'CN_TSF');
        assert.equal(result?.period, '2026-10');
    });

    it('美国指标带 US 前缀', () => {
        const result = normalizeIndicator('10月ADP就业人数变动(万人)', '美国', AS_OF);
        assert.equal(result?.indicator, 'US_ADP');
    });

    it('非关注国家返回 null', () => {
        assert.equal(normalizeIndicator('10月CPI同比', '澳大利亚', AS_OF), null);
    });

    it('归一化规则未覆盖的指标返回 null（宁可缺，不造错键）', () => {
        assert.equal(normalizeIndicator('10月道明证券通胀指数同比', '中国', AS_OF), null);
    });

    it('标题无月份时返回 null', () => {
        assert.equal(normalizeIndicator('CPI同比', '中国', AS_OF), null);
    });
});

describe('buildRows', () => {
    it('只保留中国/美国、重要度≥3、可归一化的条目', () => {
        const items: RawCalendarItem[] = [
            {
                country: '中国',
                title: '10月CPI同比',
                previous: '0.9',
                forecast: '0.8',
                actual: '0.7',
                importance: 4,
            },
            { country: '日本', title: '10月CPI同比', importance: 4 },
            { country: '中国', title: '10月CPI同比', importance: 2 },
            { country: '中国', title: '10月某不知名指标', importance: 5 },
            { country: '美国', title: '10月ADP就业人数变动(万人)', importance: 3 },
        ];

        const rows = buildRows(items, AS_OF);
        assert.deepEqual(
            rows.map((row) => row.indicator),
            ['CN_CPI_YOY', 'US_ADP'],
        );
        assert.equal(rows[0].forecast, 0.8);
        assert.equal(rows[0].actual, 0.7);
        assert.equal(rows[0].previous, 0.9);
    });

    it('空字符串转成 null，不变成 0', () => {
        const items: RawCalendarItem[] = [
            { country: '中国', title: '10月CPI同比', previous: '0.9', forecast: '', actual: '0.7', importance: 4 },
        ];
        const rows = buildRows(items, AS_OF);
        assert.equal(rows[0].forecast, null);
        assert.equal(rows[0].actual, 0.7);
    });

    it('无有效条目时返回空数组', () => {
        assert.deepEqual(buildRows([], AS_OF), []);
    });
});
