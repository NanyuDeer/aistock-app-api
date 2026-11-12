/**
 * 个股资讯归属护栏（2026-11-07）
 *
 * 背景 bug：自选消息面板按自选股筛选（贵州茅台 / 600519）时，列表里出现
 * 「江波龙：资讯异动」「中际旭创：资讯异动」等别的自选股的资讯。
 *
 * 根因：`stock_info_judgements.dedupe_key` 按「文章」去重（source|info_type|source_id），
 * 而同一篇文章会被多只股票的新闻搜索返回；入库冲突时原 SQL 执行
 * `DO UPDATE SET stock_name = EXCLUDED.stock_name`，但 symbol 不在 SET 列表里 ——
 * 于是留下「symbol=股票A + stock_name=股票B」的脏行，建 App 通知时用 symbol 归属、
 * 用 stock_name 拼标题，B 的资讯就挂到了 A 名下。
 *
 * 运行：`node --import tsx --test src/modules/crawler/__tests__/stockInfoAttribution.spec.ts`
 */
import { mock } from 'node:test';
import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import pool from '../../../core/db';
import { NotificationService } from '../../../core/notification/NotificationService';
import {
    StockInfoService,
    buildStockInfoExistingKeys,
    normalizeStockInfoJudgementInput,
} from '../StockInfoService';
import { StockInfoPushService } from '../StockInfoPushService';
import { parseAiJudgement } from '../services/StockInfoJudgeService';
import { isIngestableRelevance } from '../services/types';

const window0 = {
    info_type: 'news' as const,
    from: new Date('2026-11-07T00:00:00+08:00'),
    to: new Date('2026-11-07T23:59:59+08:00'),
};

describe('个股资讯归属护栏', () => {
    const queries: { text: string; values: unknown[] }[] = [];

    beforeEach(() => {
        queries.length = 0;
        // ensureSchema 有静态缓存：置 true 模拟已建表，避免 CREATE TABLE 污染 queries[0]
        (StockInfoService as any).schemaReady = true;
        mock.method(pool, 'query', async (text: string, values: unknown[]) => {
            queries.push({ text, values });
            return { rows: [{ id: '1', inserted: true }] };
        });
    });

    afterEach(() => {
        mock.restoreAll();
        (StockInfoService as any).schemaReady = undefined;
    });

    it('入库冲突更新不得改写 stock_name（身份字段必须与 symbol 保持一致）', async () => {
        await StockInfoService.upsertJudgements([{
            symbol: '600519',
            stock_name: '江波龙',
            info_type: 'news',
            source: 'eastmoney',
            source_id: 'eastmoney-news-1',
            title: '百元股数量达153只',
            url: 'http://finance.eastmoney.com/a/1.html',
            published_at: '2026-11-06T09:06:00+08:00',
            ai_impact: '中性',
            ai_horizon: '短期',
            ai_keywords: [],
            ai_summary: '市场统计，与个股无关',
        }]);

        const sql = queries[0]?.text ?? '';
        assert.ok(sql.includes('ON CONFLICT(dedupe_key) DO UPDATE SET'), `缺少冲突更新分支: ${sql}`);
        assert.ok(
            !sql.includes('stock_name = EXCLUDED.stock_name'),
            `冲突更新改写了 stock_name，会留下 symbol 与名称错配的脏行: ${sql}`,
        );
        // AI 研判结果仍应刷新（这些与归属无关）
        assert.ok(sql.includes('ai_summary = EXCLUDED.ai_summary'), `AI 字段应继续更新: ${sql}`);
    });

    it('getStockNamesBySymbols 返回 symbol → 权威名称映射（去重、忽略空值）', async () => {
        mock.restoreAll();
        mock.method(pool, 'query', async (text: string, values: unknown[]) => {
            assert.ok(text.includes('FROM stocks'));
            assert.deepEqual(values[0], ['600519', '301308']);
            return { rows: [{ symbol: '600519', name: '贵州茅台' }, { symbol: '301308', name: '' }] };
        });

        const names = await StockInfoService.getStockNamesBySymbols(['600519', '301308', '600519', '']);
        assert.equal(names.get('600519'), '贵州茅台');
        assert.equal(names.has('301308'), false);
        assert.equal(names.size, 1);
    });

    it('建通知时跳过错配资讯：别家股票的资讯不会挂到当前股票下', async () => {
        const created: any[] = [];
        mock.method(StockInfoService, 'getPushCandidates', async () => []);
        mock.method(StockInfoService, 'getAppNotificationCandidates', async () => [
            {
                id: 100, symbol: '600519', stock_name: '贵州茅台', info_type: 'news',
                source: 'eastmoney', source_id: 'n-1', title: '茅台三季报',
                url: 'http://a/1.html', published_at: new Date('2026-11-07T00:00:00+08:00'),
                ai_impact: '利好', ai_horizon: '短期', ai_keywords: [], ai_summary: 's',
            },
            {
                // 脏行：文章属于江波龙，但 symbol 是 600519（冲突更新遗留）
                id: 101, symbol: '600519', stock_name: '江波龙', info_type: 'news',
                source: 'eastmoney', source_id: 'n-2', title: '百元股数量达153只',
                url: 'http://a/2.html', published_at: new Date('2026-11-06T09:06:00+08:00'),
                ai_impact: '中性', ai_horizon: '短期', ai_keywords: [], ai_summary: 's',
            },
        ]);
        mock.method(StockInfoService, 'getStockNamesBySymbols', async () => new Map([['600519', '贵州茅台']]));
        mock.method(StockInfoPushService, 'resolveWindows', async () => [window0]);
        mock.method(NotificationService, 'createForWatchers', async (input: any) => {
            created.push(input);
            return 1;
        });

        await StockInfoPushService.push({ window: 'morning' });

        assert.equal(created.length, 1, `应只保留归属一致的资讯，实际 ${created.length} 条`);
        assert.equal(created[0].symbol, '600519');
        assert.equal(created[0].stockName, '贵州茅台');
        assert.equal(created[0].title, '贵州茅台：资讯异动');
        assert.ok(
            !created.some(item => String(item.title).includes('江波龙')),
            '错配资讯不应生成通知',
        );
    });

    it('相关性口径：只留个股本身与所处行业，市场名单/被动提及不入库', () => {
        assert.equal(isIngestableRelevance('stock_specific'), true);
        assert.equal(isIngestableRelevance('sector'), true);
        assert.equal(isIngestableRelevance('market'), false);
        assert.equal(isIngestableRelevance('mention_only'), false);
    });

    it('研判解析 ai_relevance；缺失或非法值按 stock_specific 兜底（不误杀）', () => {
        const base = { ai_impact: '中性', ai_horizon: '短期', ai_summary: '一句结论', ai_keywords: [] };

        assert.equal(parseAiJudgement(JSON.stringify({ ...base, ai_relevance: 'market' }))?.ai_relevance, 'market');
        assert.equal(parseAiJudgement(JSON.stringify({ ...base, ai_relevance: 'mention_only' }))?.ai_relevance, 'mention_only');
        // 公告 prompt 不带该字段、模型漏字段或返回非法值 → 兜底 stock_specific
        assert.equal(parseAiJudgement(JSON.stringify(base))?.ai_relevance, 'stock_specific');
        assert.equal(parseAiJudgement(JSON.stringify({ ...base, ai_relevance: 'whatever' }))?.ai_relevance, 'stock_specific');
    });

    it('入库写入 ai_relevance，冲突时同步刷新（便于后续按相关性清理）', async () => {
        await StockInfoService.upsertJudgements([{
            symbol: '300750',
            stock_name: '宁德时代',
            info_type: 'news',
            source: 'eastmoney',
            source_id: 'eastmoney-news-2',
            title: '百元股数量达153只',
            url: 'http://finance.eastmoney.com/a/2.html',
            published_at: '2026-11-06T09:06:00+08:00',
            ai_impact: '中性',
            ai_horizon: '短期',
            ai_keywords: [],
            ai_summary: '市场统计',
            ai_relevance: 'market',
        }]);

        const sql = queries[0]?.text ?? '';
        assert.ok(sql.includes('ai_relevance = EXCLUDED.ai_relevance'), `冲突时应刷新相关性: ${sql}`);
        assert.equal((queries[0]?.values as unknown[])[13], 'market');
    });
});

/**
 * 按「股票 + 文章」去重（2026-11-08）
 *
 * 背景：上一轮只保证「冲突时不改 stock_name」，但 dedupe_key 仍是文章级，
 * 同一篇文章在**同一次**抓取里被 A/B 两只股票各自研判后，后写入的 B 仍然会覆盖
 * A 那一行的 ai_summary（symbol 是 A）→ 个股异动里 A 名下出现讲 B 的摘要。
 * 根治：去重键计入 symbol，同一篇文章对每只股票各存一行。
 */
describe('去重键计入股票（每股独立一行）', () => {
    const base = {
        info_type: 'news' as const,
        source: 'eastmoney',
        source_id: 'eastmoney-news-1',
        title: '77股今日获机构买入评级',
        url: 'http://finance.eastmoney.com/a/1.html',
        published_at: '2026-11-06T09:06:00+08:00',
        ai_impact: '中性' as const,
        ai_horizon: '短期' as const,
        ai_keywords: [],
        ai_summary: '一句话结论',
    };

    it('同一篇文章对不同股票生成不同 dedupe_key；同一股票重复抓取仍幂等', () => {
        const a = normalizeStockInfoJudgementInput({ ...base, symbol: '600519', stock_name: '贵州茅台' });
        const b = normalizeStockInfoJudgementInput({ ...base, symbol: '300308', stock_name: '中际旭创' });
        const aAgain = normalizeStockInfoJudgementInput({ ...base, symbol: '600519', stock_name: '贵州茅台' });

        assert.notEqual(a.dedupe_key, b.dedupe_key, '不同股票的同一篇文章不能共用一行');
        assert.equal(a.dedupe_key, aAgain.dedupe_key, '同一股票重复抓取必须命中同一行（幂等）');
    });

    it('无 source_id 时按 symbol + 标题 + 链接兜底，天然跨股票隔离', () => {
        const a = normalizeStockInfoJudgementInput({ ...base, source_id: '', symbol: '600519' });
        const b = normalizeStockInfoJudgementInput({ ...base, source_id: '', symbol: '300308' });
        assert.notEqual(a.dedupe_key, b.dedupe_key);
    });

    it('入库前「已存在」判断同样按 symbol 粒度：别家股票抓过不影响本股重新研判', () => {
        const keys = buildStockInfoExistingKeys([
            { symbol: '600519', source: 'eastmoney', info_type: 'news', source_id: 'eastmoney-news-1' },
            { symbol: '300308', source: 'eastmoney', info_type: 'news', source_id: 'eastmoney-news-1' },
        ]);
        assert.equal(keys.length, 2);
        assert.notEqual(keys[0].key, keys[1].key);
        assert.deepEqual(keys.map(k => k.symbol).sort(), ['300308', '600519']);
        // 缺 symbol 的调用方无法判定归属：跳过，不做文章级误判
        assert.deepEqual(
            buildStockInfoExistingKeys([{ source: 'eastmoney', info_type: 'news', source_id: 'x' }]),
            [],
        );
    });
});

