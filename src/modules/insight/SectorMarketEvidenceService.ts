// src/modules/insight/SectorMarketEvidenceService.ts
// L2 量化联动：板块强度 ≥3%（ths_daily）、同行同步 ≥3 只且同向 ≥5%（ths_member + daily）、
// 市场冲击（上证 ±1.5% / 上涨家数占比 ≤30% 或 ≥70%，腾讯来源免积分）
import pool from '../../core/db';
import { getThsIndex, getThsDaily, getThsMember, getDailyByDate } from '../quote/TushareService';
import { TencentQuoteService } from '../quote/TencentQuoteService';
import type { EvidenceItem } from './EvidencePackageService';

const INDEX_CODES = ['sh000001']; // 上证指数（腾讯格式）

export class SectorMarketEvidenceService {
    static async collect(symbol: string, tradeDate: string, direction: 'up' | 'down'): Promise<EvidenceItem[]> {
        const out: EvidenceItem[] = [];
        const dateCompact = tradeDate.replace(/-/g, '');

        // 1. 板块强度：stock_concept_mapping 取所属板块名 → getThsIndex 映射 ts_code → getThsDaily 当日 pct_change
        try {
            const { rows } = await pool.query(
                `SELECT sector_name FROM stock_concept_mapping WHERE symbol=$1 LIMIT 3`, [symbol]);
            const boards = await getThsIndex('I', 'A'); // 行业板块
            for (const r of rows) {
                const board = boards.find(b => b.name === r.sector_name);
                if (!board) continue;
                const dailies = await getThsDaily(board.ts_code, dateCompact, dateCompact);
                const d = dailies[0];
                if (!d || d.pct_change === null || d.pct_change === undefined) continue;
                // 板块方向与个股方向一致才纳入：上涨方向需板块 ≥3%，下跌方向需板块 ≤-3%
                const pct = Number(d.pct_change);
                const aligned = (pct >= 3 && direction === 'up') || (pct <= -3 && direction === 'down');
                if (!aligned) continue;
                out.push({
                    source_id: `quant:sector:${board.ts_code}:${dateCompact}`, source_type: 'quant',
                    provider: 'tushare', title: `板块强度 ${board.name} ${d.pct_change}%`,
                    excerpt: `同花顺行业板块 ${board.name} 当日涨跌 ${d.pct_change}%`,
                    published_at: `${tradeDate}T00:00:00+08:00`, symbol,
                    strength: 0.7, days_offset: 0, time_bucket: 'T0',
                });
            }
        } catch (e) { console.warn('[quant] sector failed', e instanceof Error ? e.message : String(e)); }

        // 2. 同行同步：同板块成分股中当日同向且 ≥5% 数量 ≥3
        try {
            const industryCode = await SectorMarketEvidenceService.firstIndustryCode(symbol);
            // 无板块映射不产同行证据（避免空 ts_code 请求）；用 if 包裹而非 return，避免跳过市场冲击环节
            if (industryCode) {
                const members = await getThsMember(industryCode);
                if (members.length > 0) {
                    const codes = members.slice(0, 30).map(m => m.con_code);
                    const dailies = await getDailyByDate(dateCompact);
                    const byCode = new Map(dailies.map(d => [d.ts_code, d]));
                    const peers = codes.filter(c => {
                        const d = byCode.get(c);
                        if (!d || d.pct_chg === null || d.pct_chg === undefined) return false;
                        return direction === 'up' ? d.pct_chg >= 5 : d.pct_chg <= -5;
                    });
                    if (peers.length >= 3) {
                        out.push({
                            source_id: `quant:peer:${symbol}:${dateCompact}`, source_type: 'quant',
                            provider: 'tushare', title: `同行同步 ${peers.length} 只`,
                            excerpt: `同板块成分股中同向涨跌 ≥5% 共 ${peers.length} 只`,
                            published_at: `${tradeDate}T00:00:00+08:00`, symbol,
                            strength: 0.65, days_offset: 0, time_bucket: 'T0',
                        });
                    }
                }
            }
        } catch (e) { console.warn('[quant] peer failed', e instanceof Error ? e.message : String(e)); }

        // 3. 市场冲击：上证指数 abs(pct_change) ≥1.5%（腾讯免积分）
        try {
            const quotes = await TencentQuoteService.getBatchQuotes(INDEX_CODES, 'activity');
            const sh = quotes.find(q => q['股票代码'] === 'sh000001');
            if (sh) {
                const prev = Number(sh['昨收价'] ?? NaN);
                const latest = Number(sh['最新价'] ?? NaN);
                if (Number.isFinite(prev) && Number.isFinite(latest) && prev > 0) {
                    const pct = ((latest - prev) / prev) * 100;
                    // 市场方向与个股方向一致：上涨方向需 pct >= 1.5，下跌方向需 pct <= -1.5
                    const aligned = (pct >= 1.5 && direction === 'up') || (pct <= -1.5 && direction === 'down');
                    if (aligned) {
                        out.push({
                            source_id: `quant:market:sh000001:${dateCompact}`, source_type: 'quant',
                            provider: 'tencent', title: `市场冲击 上证 ${pct.toFixed(2)}%`,
                            excerpt: `上证指数当日涨跌 ${pct.toFixed(2)}%（阈值 ±1.5%）`,
                            published_at: `${tradeDate}T00:00:00+08:00`, symbol,
                            strength: 0.6, days_offset: 0, time_bucket: 'T0',
                        });
                    }
                }
            }
        } catch (e) { console.warn('[quant] market failed', e instanceof Error ? e.message : String(e)); }

        // 3.5 市场广度（可选增强）：上涨家数占比 ≤30% 或 ≥70%（PRD §9 阈值②）。
        // 交易时段可复用 TencentSnapshotService.fetchMarketBreadth（全市场活跃股分批拉取，
        // 腾讯来源免积分）；注意其 15:30 后的 quick 快照语义为收盘口径，午盘/尾盘调用时
        // 按实时上涨/下跌家数计算 advance_ratio。实现时若发现接口与时段不匹配，保留
        // 上证 ±1.5%（①）作为 market 主证据，本条标记 coverage.partial。

        return out;
    }

    private static async firstIndustryCode(symbol: string): Promise<string> {
        const { rows } = await pool.query(
            `SELECT sector_name FROM stock_concept_mapping WHERE symbol=$1 LIMIT 1`, [symbol]);
        if (rows.length === 0) return '';
        const boards = await getThsIndex('I', 'A');
        const b = boards.find(x => x.name === rows[0].sector_name);
        return b?.ts_code ?? '';
    }
}
