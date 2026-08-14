import assert from 'node:assert/strict';
import test from 'node:test';
import {
    isValidStockCode,
    isValidStockName,
    extractStockCodeFromHref,
} from '../WindLeaderAnalyzerService';

// 龙头股爬取校验：防同花顺新闻链接（URL 含日期 20260805）被误当作股票代码/名称

test('isValidStockCode accepts real A-share codes', () => {
    assert.equal(isValidStockCode('600519'), true); // 沪市主板
    assert.equal(isValidStockCode('300750'), true); // 创业板
    assert.equal(isValidStockCode('000001'), true); // 深市主板
    assert.equal(isValidStockCode('688981'), true); // 科创板
    assert.equal(isValidStockCode('830799'), true); // 北交所
    assert.equal(isValidStockCode('920001'), true); // 北交所新号段
});

test('isValidStockCode rejects date-like digits and board codes', () => {
    assert.equal(isValidStockCode('202608'), false); // 日期 2026-08
    assert.equal(isValidStockCode('20260805'), false); // 非6位
    assert.equal(isValidStockCode('2026'), false); // 不足6位
    assert.equal(isValidStockCode(''), false);
    assert.equal(isValidStockCode('12ab34'), false);
    // 同花顺板块代码非个股（881 行业 / 885 概念 / 886 概念）
    assert.equal(isValidStockCode('881169'), false);
    assert.equal(isValidStockCode('881142'), false);
    assert.equal(isValidStockCode('886111'), false);
    assert.equal(isValidStockCode('884001'), false);
});

test('isValidStockName accepts normal stock names', () => {
    assert.equal(isValidStockName('贵州茅台'), true);
    assert.equal(isValidStockName('沃格光电'), true);
    assert.equal(isValidStockName('宁德时代'), true);
    assert.equal(isValidStockName('ST华微'), true);
});

test('isValidStockName rejects descriptive news titles', () => {
    assert.equal(isValidStockName('概念细分|玻璃基板新增显示用玻璃基板、玻璃基板封装、玻璃基板制造、设备及耗材细分方向'), false);
    assert.equal(isValidStockName('概念细分'), false);
    assert.equal(isValidStockName('新增显示用玻璃基板'), false);
    assert.equal(isValidStockName('设备及耗材'), false);
    assert.equal(isValidStockName(''), false);
    assert.equal(isValidStockName('龙'), false); // 单字
});

test('extractStockCodeFromHref extracts code from stock links', () => {
    assert.equal(extractStockCodeFromHref('https://stockpage.10jqka.com.cn/300801/'), '300801');
    assert.equal(extractStockCodeFromHref('http://basic.10jqka.com.cn/48/886111/'), null); // 板块页非个股
    assert.equal(extractStockCodeFromHref('https://www.10jqka.com.cn/300801/'), '300801');
});

test('extractStockCodeFromHref rejects news links with date digits', () => {
    // 同花顺新闻 URL 的 20260805 会被旧正则 /(\d{6})/ 误提取为 202608
    assert.equal(extractStockCodeFromHref('http://news.10jqka.com.cn/20260805/c678696112.shtml'), null);
    assert.equal(extractStockCodeFromHref('http://news.10jqka.com.cn/field/20260814/678940893.shtml'), null);
    assert.equal(extractStockCodeFromHref(''), null);
});
