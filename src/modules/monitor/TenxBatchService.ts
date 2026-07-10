import { TenxScoreService, IndustryCache, VetoError, vetoCheck, preloadThsEnhanceCache } from './TenxScoreService';
import * as TushareService from '../quote/TushareService';
import pool from '../../core/db';

const PRIORITY_STOCKS = ['688205', '688008', '300058', '300136', '002050'];

const policyMap: Record<string, number> = {
    '半导体': 5, '芯片': 5, '人工智能': 5, '新能源': 5, '储能': 5, '信创': 5, '数字经济': 5, '机器人': 5, '量子': 5, '脑机': 5,
    '光伏': 4, '军工': 4, '航天': 4, '创新药': 4, '电池': 4, '风电': 4, '氢能': 4, '软件': 4, '云计算': 4, '大数据': 4, '网络安全': 4, '生物': 4, '基因': 4, '航空': 4, '新材料': 4, '稀土': 4, '碳中和': 4, '环保': 4, '核电': 4, '卫星': 4,
    '医疗器械': 3, '消费电子': 3, '汽车': 3, '物联网': 3, '通信': 3, '5G': 3, '半导体材料': 3, '显示': 3, '面板': 3, '智能家居': 3, '工业互联': 3, '智能制造': 3, '特高压': 3, '宠物': 3, '医美': 3, '养老': 3, '体育': 3, '文化': 3, '教育': 3, '游戏': 3, '影视': 3, '食品': 3, '饮料': 3, '家电': 3, '建材': 3, '装饰': 3, '农业': 3, '种业': 3,
    '银行': 2, '保险': 2, '证券': 2, '地产': 2, '钢铁': 2, '煤炭': 2, '石油': 2, '化工': 2, '有色': 2, '港口': 2, '公路': 2, '铁路': 2, '电力': 2, '水务': 2, '燃气': 2,
};

export class TenxBatchService {
    private static readonly BATCH_DELAY_MS = 2000;

    static async run(force: boolean = false): Promise<void> {
        const today = new Date().toISOString().slice(0, 10);

        const result = await pool.query('SELECT symbol FROM stocks');
        const allSymbols = result.rows.map((r: any) => r.symbol as string);

        if (!allSymbols.length) {
            console.log('[TenxBatch] 数据库中无股票数据，跳过');
            return;
        }

        const symbols = this.prioritizeSymbols(allSymbols);
        console.log(`[TenxBatch] 共${symbols.length}只股票待评分, date=${today}, force=${force}`);
        console.log(`[TenxBatch] 优先股票: ${symbols.slice(0, PRIORITY_STOCKS.length).join(', ')}`);

        const industryCache = await this.preloadIndustryData(symbols);
        console.log(`[TenxBatch] 行业数据缓存完成, 共${Object.keys(industryCache).length}个行业`);

        // 预加载THS增强数据（全市场接口，仅调用1次）
        await preloadThsEnhanceCache();
        console.log('[TenxBatch] THS增强数据缓存完成');

        let success = 0;
        let skipped = 0;
        let vetoed = 0;
        let failed = 0;

        for (const symbol of symbols) {
            try {
                if (!force) {
                    const existing = await pool.query(
                        'SELECT 1 FROM tenx_scores WHERE symbol = $1 AND score_date = $2',
                        [symbol, today],
                    );
                    if (existing.rows.length > 0) { skipped++; continue; }
                }

                // 初筛：先做一票否决检查，被否决的跳过评分
                try {
                    const vetoResult = await vetoCheck(symbol);
                    if (!vetoResult.passed) {
                        vetoed++;
                        continue;
                    }
                } catch {
                    // 否决检查失败（如无数据），也跳过
                    vetoed++;
                    continue;
                }

                const scoreResult = await TenxScoreService.calculateTenxScore(symbol, industryCache);

                const rawDataJson = scoreResult.rawData ? JSON.stringify(scoreResult.rawData) : null;
                try {
                    await pool.query(`
                        INSERT INTO tenx_scores
                            (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, indicators, raw_data, updated_at)
                        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                        ON CONFLICT (symbol, score_date) DO UPDATE SET
                            score = EXCLUDED.score,
                            label = EXCLUDED.label,
                            expected_multiple = EXCLUDED.expected_multiple,
                            description = EXCLUDED.description,
                            ai_conclusion = EXCLUDED.ai_conclusion,
                            dim_scores = EXCLUDED.dim_scores,
                            indicators = EXCLUDED.indicators,
                            raw_data = EXCLUDED.raw_data,
                            updated_at = EXCLUDED.updated_at
                    `, [
                        symbol, today, scoreResult.score, scoreResult.label, scoreResult.expectedMultiple,
                        scoreResult.description, scoreResult.aiConclusion, JSON.stringify(scoreResult.dimScores),
                        JSON.stringify(scoreResult.dimensions), rawDataJson, scoreResult.updatedAt,
                    ]);
                } catch {
                    try {
                        await pool.query(`
                            INSERT INTO tenx_scores
                                (symbol, score_date, score, label, expected_multiple, description, ai_conclusion, dim_scores, indicators, updated_at)
                            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
                            ON CONFLICT (symbol, score_date) DO UPDATE SET
                                score = EXCLUDED.score,
                                label = EXCLUDED.label,
                                expected_multiple = EXCLUDED.expected_multiple,
                                description = EXCLUDED.description,
                                ai_conclusion = EXCLUDED.ai_conclusion,
                                dim_scores = EXCLUDED.dim_scores,
                                indicators = EXCLUDED.indicators,
                                updated_at = EXCLUDED.updated_at
                        `, [
                            symbol, today, scoreResult.score, scoreResult.label, scoreResult.expectedMultiple,
                            scoreResult.description, scoreResult.aiConclusion, JSON.stringify(scoreResult.dimScores),
                            JSON.stringify(scoreResult.dimensions), scoreResult.updatedAt,
                        ]);
                    } catch {}
                }

                success++;
                console.log(`[TenxBatch] ${symbol} 评分完成: ${scoreResult.score}`);

                // 更新 stocks 表的 industry 字段
                if (scoreResult.rawData?.industry?.industry_name) {
                    pool.query('UPDATE stocks SET industry = $1 WHERE symbol = $2', [scoreResult.rawData.industry.industry_name, symbol]).catch(() => {});
                }

                await this.sleep(this.BATCH_DELAY_MS);
            } catch (err: any) {
                failed++;
                console.error(`[TenxBatch] ${symbol} 评分失败:`, err?.message || err);
            }
        }

        console.log(`[TenxBatch] 完成: 成功=${success}, 跳过=${skipped}, 否决=${vetoed}, 失败=${failed}`);
    }

    private static prioritizeSymbols(symbols: string[]): string[] {
        const prioritySet = new Set(PRIORITY_STOCKS);
        const priority = symbols.filter(s => prioritySet.has(s));
        const rest = symbols.filter(s => !prioritySet.has(s));
        return [...priority, ...rest];
    }

    private static async preloadIndustryData(symbols: string[]): Promise<IndustryCache> {
        const industryCache: IndustryCache = {};

        const stockIndustryMap = new Map<string, { code: string; name: string }>();
        for (const symbol of symbols) {
            try {
                const industry = await TushareService.getStockIndustry(symbol);
                if (industry?.industry_code) {
                    stockIndustryMap.set(symbol, { code: industry.industry_code, name: industry.industry_name });
                }
            } catch {}
        }

        const industrySet = new Map<string, string>();
        for (const [, info] of stockIndustryMap) {
            if (!industrySet.has(info.code)) industrySet.set(info.code, info.name);
        }

        console.log(`[TenxBatch] 发现${industrySet.size}个行业, 开始预加载...`);

        for (const [industryCode, industryName] of industrySet) {
            try {
                // 市场认可度：批量模式下用行业指数涨跌幅近似（0-100映射）
                let market_recognition = 50;
                try {
                    const sixMonthsAgo = new Date();
                    sixMonthsAgo.setDate(sixMonthsAgo.getDate() - 180);
                    const startDate = sixMonthsAgo.toISOString().slice(0, 10).replace(/-/g, '');
                    const daily = await TushareService.getIndexDaily(industryCode, startDate);
                    if (daily.length >= 2) {
                        const sorted = daily.sort((a, b) => a.trade_date.localeCompare(b.trade_date));
                        const first = sorted[0], last = sorted[sorted.length - 1];
                        if (first.close > 0) {
                            const industryReturn = ((last.close / first.close) - 1) * 100;
                            // 将行业涨跌幅映射为0-100的市场认可度
                            market_recognition = Math.min(100, Math.max(0, 50 + industryReturn * 2));
                        }
                    }
                } catch {}

                let policy_trend_score = 2;
                for (const [keyword, score] of Object.entries(policyMap)) {
                    if (industryName.includes(keyword)) { policy_trend_score = score; break; }
                }

                let members: string[] = [];
                try { members = await TushareService.getIndexMember(industryCode); } catch {}

                industryCache[industryCode] = { industryName, market_recognition, policy_trend_score, members };
                console.log(`[TenxBatch] 行业缓存: ${industryName}(${industryCode}), 成分股=${members.length}, 市场认可度=${market_recognition.toFixed(1)}, 政策=${policy_trend_score}`);
            } catch (err: any) {
                console.error(`[TenxBatch] 行业缓存失败 ${industryCode}:`, err?.message || err);
            }
        }

        return industryCache;
    }

    private static sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
