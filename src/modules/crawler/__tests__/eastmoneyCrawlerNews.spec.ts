/**
 * 东财新闻抓取：静默失效守护 + TLS 指纹加固（2026-10-11）
 *
 * 背景：2026-09-26 起，东财边缘对 Node 20 / OpenSSL 3.0 的默认 TLS ClientHello 返回降级体
 * （`result.passportWeb`，且 `hitsTotal>0`），`parseNews` 取不到 `result.cmsArticleWebOld`
 * → 返回空数组、不抛异常 → `StockInfoCrawlService` 的 catch 不触发 → 新闻静默归零
 * （生产实际发生 9/26~10/11，公告不受影响）。
 *
 * 覆盖：
 * 1. 降级响应必须显式告警（不得静默返回空）；
 * 2. 正常响应不得误报；
 * 3. 无命中（hitsTotal=0）不得告警；
 * 4. 东财域名 agent 固定 `ecdhCurve='X25519'`（实测可稳定取到真实数据），其它域名不受影响。
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { EastmoneyCrawler, __eastmoneyCrawlerDependencies } from '../services/EastmoneyCrawler';
import { __getAgentForTest, closeAllAgents } from '../../../shared/utils/httpAgent';

/** 构造 JSONP 响应文本 */
function jsonp(body: unknown): string {
    return `callback(${JSON.stringify(body)});`;
}

describe('EastmoneyCrawler.fetchNews 静默失效守护', () => {
    const originalFetch = __eastmoneyCrawlerDependencies.sessionFetch;
    const originalError = __eastmoneyCrawlerDependencies.errorLog;
    let errors: string[] = [];

    beforeEach(() => {
        errors = [];
        __eastmoneyCrawlerDependencies.errorLog = (message: string) => {
            errors.push(message);
        };
    });

    afterEach(() => {
        __eastmoneyCrawlerDependencies.sessionFetch = originalFetch;
        __eastmoneyCrawlerDependencies.errorLog = originalError;
    });

    it('降级响应（hitsTotal>0 但无 cmsArticleWebOld）必须告警且返回空', async () => {
        __eastmoneyCrawlerDependencies.sessionFetch = async () => new Response(
            jsonp({ code: 0, hitsTotal: 1, result: { passportWeb: [{ alias: '达利食品' }] } }),
            { status: 200 },
        );

        const news = await EastmoneyCrawler.fetchNews('300750', '宁德时代', 10);

        assert.equal(news.length, 0, '降级响应应返回空');
        assert.equal(errors.length, 1, '命中降级特征必须告警一次');
        assert.ok(errors[0].includes('cmsArticleWebOld'), '告警信息应点明缺失字段');
    });

    it('正常响应不误报', async () => {
        __eastmoneyCrawlerDependencies.sessionFetch = async () => new Response(
            jsonp({
                code: 0,
                hitsTotal: 2,
                result: {
                    cmsArticleWebOld: [
                        {
                            code: 'c1',
                            title: '标题1',
                            content: '正文',
                            date: '2026-10-10 14:12:29',
                            url: 'https://finance.eastmoney.com/a/1.html',
                            mediaName: '媒体',
                        },
                    ],
                },
            }),
            { status: 200 },
        );

        const news = await EastmoneyCrawler.fetchNews('300750', '宁德时代', 10);

        assert.equal(news.length, 1, '正常响应应解析出条目');
        assert.equal(errors.length, 0, '正常响应不得告警');
    });

    it('无命中（hitsTotal=0）不告警', async () => {
        __eastmoneyCrawlerDependencies.sessionFetch = async () => new Response(
            jsonp({ code: 0, hitsTotal: 0, result: { cmsArticleWebOld: [] } }),
            { status: 200 },
        );

        const news = await EastmoneyCrawler.fetchNews('300750', '宁德时代', 10);

        assert.equal(news.length, 0);
        assert.equal(errors.length, 0, '无命中不得告警');
    });
});

describe('东财 TLS 指纹加固', () => {
    afterEach(() => {
        closeAllAgents();
    });

    it('eastmoney 域名 agent 固定 ecdhCurve=X25519，其它域名不受影响', () => {
        const em = __getAgentForTest('https://search-api-web.eastmoney.com/search/jsonp') as unknown as { options: { ecdhCurve?: string } };
        const other = __getAgentForTest('https://d.10jqka.com.cn/v6/line/hs_000001/01/last.js') as unknown as { options: { ecdhCurve?: string } };

        assert.equal(em.options.ecdhCurve, 'X25519', '东财 agent 必须固定 ecdhCurve 以规避边缘指纹拦截');
        assert.notEqual(other.options.ecdhCurve, 'X25519', '非东财域名不应受影响');
    });
});
