import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { mediaSources } from '../hotBurstSources';
import { HotBurstService, __hotBurstDependencies } from '../HotBurstService';
import { HotKeywordDetectorService, type HotConceptResult } from '../HotKeywordDetectorService';
import pool from '../../../core/db';
import { TencentQuoteService } from '../../quote/TencentQuoteService';

const concept = (source: 'cls' | 'glh' | 'both', name = '机器人'): HotConceptResult => ({
    conceptName: name, conceptTsCode: '885001.TI', clsCount: 1, glhCount: 1,
    totalCount: 2, previousCount: 0, surgeRatio: 2, crossVerified: true, crossSource: true,
    stockCodes: [{ symbol: '000001', name: '测试', source }], articles: [], detectedAt: '',
});
test('概念双源但个股仅财联社提及时，不得继承格隆汇票；多个概念合并去重', () => {
    const result = mediaSources('000001', [concept('cls'), concept('cls'), concept('glh', '人工智能')], { cls: true, glh: true });
    assert.deepEqual(result.cls, { status: 'passed', matched_concepts: ['机器人'] });
    assert.deepEqual(result.glh, { status: 'passed', matched_concepts: ['人工智能'] });
    assert.equal(mediaSources('000001', [concept('cls')], { cls: true, glh: true }).glh.status, 'not_passed');
    assert.equal(mediaSources('000002', [concept('both')], { cls: true, glh: true }).cls.status, 'not_passed');
    assert.equal(mediaSources('000001', [concept('cls')], { cls: false, glh: true }).cls.status, 'unavailable');
});
test('完整发布：媒体双源直接提股入榜，QQ加精确板块入榜，概念继承和模糊板块不入榜', async t => {
    t.after(() => mock.restoreAll());
    mock.method(HotKeywordDetectorService, 'detectHotStocks', async () => []);
    mock.method(HotKeywordDetectorService, 'detectHotKeywords', async () => []);
    mock.method(HotKeywordDetectorService, 'detectHotConcepts', async () => [concept('cls'), {
        ...concept('both', '芯片'), stockCodes: [{ symbol: '000002', name: '双源股', source: 'both' as const }],
    }]);
    mock.method(__hotBurstDependencies, 'getThsHot', async () => [{ ts_code: '885999.TI', ts_name: 'PCB概念', rank: 3 }] as never);
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    let saved: unknown[] = [];
    mock.method(pool, 'query', async (sql: string, params?: unknown[]) => {
        if (sql.includes('SELECT id, stock_codes')) return { rows: [
            { id: 10, stock_codes: ['000003', '000003'], received_at: '2026-11-24T01:00:00Z' },
            { id: 11, stock_codes: ['000004'], received_at: '2026-11-24T02:00:00Z' },
        ] };
        if (sql.includes('FROM stock_concept_mapping')) return { rows: [
            { symbol: '000003', sector_name: 'PCB概念', sector_code: '885999.TI' },
            { symbol: '000004', sector_name: 'PCB概念延伸', sector_code: '885998.TI' },
        ] };
        if (sql.includes('INSERT INTO institution')) saved = params ?? [];
        return { rows: [] };
    });
    const result = await HotBurstService.detectHotBurst();
    assert.deepEqual(result.outbreaks.map(s => s.symbol).sort(), ['000002', '000003']);
    for (const stock of result.outbreaks) {
        assert.equal(stock.resonanceCount, 2);
        assert.equal(Object.values(stock.source_details!).filter(s => s.status === 'passed').length, 2);
    }
    const qq = result.outbreaks.find(s => s.symbol === '000003')!;
    assert.deepEqual(qq.source_details!.qq.evidence_message_ids, [10]);
    assert.equal(qq.source_details!.qq.stock_mention_count, 1);
    assert.equal(qq.source_details!.ths.matched_sectors[0].code, '885999.TI');
    assert.equal(saved.length, 28);
    assert.ok(saved.some(v => typeof v === 'string' && v.includes('evidence_message_ids')));
});
test('历史缺少明细保持旧共振数，来源返回unknown', async t => {
    t.after(() => mock.restoreAll());
    mock.method(pool, 'query', async () => ({ rows: [{ symbol: '000001', resonance_count: 3, source_details: null }] }));
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    const result = await HotBurstService.getHistory();
    assert.equal(result.records[0].resonance_count, 3);
    assert.equal(result.records[0].source_details.cls.status, 'unknown');
});

test('新闻源独立超时，健康源保留并按新闻ID去重', async t => {
    const { fetchDetectionNews, __hotKeywordDependencies: deps } = await import('../HotKeywordDetectorService');
    t.after(() => mock.restoreAll());
    const article = { id: 'n1', title: '机器人', content: '测试', time: '', timestamp: 1 };
    mock.method(deps, 'fetchClsTelegraph', async () => [article, article]);
    mock.method(deps, 'fetchGelonghuiNews', () => new Promise<never>(() => {}));
    const result = await fetchDetectionNews(10);
    assert.deepEqual(result.sourceAvailability, { cls: true, glh: false });
    assert.equal(result.clsArticles.length, 1);
    assert.equal(result.glhArticles.length, 0);
});

test('概念词库加载失败不能缓存为空，后续检测可以重试', async t => {
    const { getConceptVocabulary, refreshConceptVocabulary, __hotKeywordDependencies: deps } = await import('../HotKeywordDetectorService');
    t.after(() => mock.restoreAll());
    let calls = 0;
    mock.method(deps, 'getThsIndex', async () => {
        if (++calls === 1) throw new Error('temporary failure');
        return [{ ts_code: '885001.TI', name: '机器人' }] as never;
    });
    await assert.rejects(refreshConceptVocabulary(), /temporary failure/);
    assert.equal((await getConceptVocabulary())[0].name, '机器人');
    assert.equal(calls, 2);
});

test('Top10按真实排名筛选，去重，剔除缺失排名而非按返回顺序赋值', async () => {
    const { rankedHotSectors } = await import('../hotBurstSources');
    const result = rankedHotSectors([
        { ts_code: '885003.TI', ts_name: '第三', rank: 3 },
        { ts_code: '885011.TI', ts_name: '十一', rank: 11 },
        { ts_code: '885001.TI', ts_name: '第一', rank: 1 },
        { ts_code: '885001', ts_name: '第一重复', rank: 2 },
        { ts_code: '885000.TI', ts_name: '缺失', rank: 0 },
    ]);
    assert.deepEqual(result.map(s => s.rank), [1, 3]);
});

test('数据库兜底来源布尔值与已保存的source_details一致', async t => {
    t.after(() => mock.restoreAll());
    const details = mediaSources('000001', [concept('both')], { cls: true, glh: true });
    details.qq.status = 'passed';
    mock.method(pool, 'query', async () => ({ rows: [{ symbol: '000001', resonance_count: 3, source_details: details }] }));
    mock.method(TencentQuoteService, 'getCachedBatchQuotes', async () => []);
    const result = await HotBurstService.getLatestFromDB();
    assert.equal(result!.outbreaks[0].clsVerified, true);
    assert.equal(result!.outbreaks[0].glhVerified, true);
    assert.equal(result!.outbreaks[0].reportVerified, true);
});
