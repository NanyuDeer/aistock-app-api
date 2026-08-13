import assert from 'node:assert/strict';
import test from 'node:test';
import { parseForecastSymbols } from '../profitForecastController';

// 自选股筛选：symbols 查询参数解析（逗号分隔、去空、去重、限 200 只）
test('parseForecastSymbols returns null for empty input', () => {
    assert.equal(parseForecastSymbols(null), null);
    assert.equal(parseForecastSymbols(''), null);
    assert.equal(parseForecastSymbols('   '), null);
});

test('parseForecastSymbols splits comma-separated symbols and trims spaces', () => {
    assert.deepEqual(parseForecastSymbols('600519, 300750, 000001'), ['600519', '300750', '000001']);
});

test('parseForecastSymbols drops empty segments', () => {
    assert.deepEqual(parseForecastSymbols('600519,,300750,'), ['600519', '300750']);
});

test('parseForecastSymbols dedupes repeated symbols', () => {
    assert.deepEqual(parseForecastSymbols('600519,600519,300750'), ['600519', '300750']);
});

test('parseForecastSymbols caps at 200 symbols to prevent abuse', () => {
    const raw = Array.from({ length: 250 }, (_, i) => String(600000 + i)).join(',');
    const result = parseForecastSymbols(raw);
    assert.equal(result?.length, 200);
});
