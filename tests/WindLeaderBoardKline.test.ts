import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseKlineFull } from '../src/modules/monitor/RotationBoardStore';

// 同花顺 last.js 行格式：date,open,high,low,close,volume,amount,...
// close 已在生产 parseKline（p[4]）验证，此处验证全 OHLC 解析。
const SAMPLE = 'jQuery1720000000000({"data":"20260805,100.50,102.00,99.80,101.20,123456,7890123;20260806,101.20,103.50,100.90,103.00,234567,8901234;"})';

test('parseKlineFull 解析 OHLC 四价', () => {
    const map = parseKlineFull(SAMPLE);
    assert.equal(map.size, 2);
    const first = map.get('20260805');
    assert.deepEqual(first, { open: 100.5, high: 102.0, low: 99.8, close: 101.2 });
    const second = map.get('20260806');
    assert.deepEqual(second, { open: 101.2, high: 103.5, low: 100.9, close: 103.0 });
});

test('parseKlineFull 非法输入返回空 Map', () => {
    assert.equal(parseKlineFull('').size, 0);
    assert.equal(parseKlineFull('not jsonp').size, 0);
    assert.equal(parseKlineFull('({"data":""})').size, 0);
});
