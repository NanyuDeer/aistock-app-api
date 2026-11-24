import type { HotConceptResult } from './HotKeywordDetectorService';

export type SourceStatus = 'passed' | 'not_passed' | 'unavailable' | 'unknown';
export interface SourceDetails {
    cls: { status: SourceStatus; matched_concepts: string[] };
    glh: { status: SourceStatus; matched_concepts: string[] };
    qq: { status: SourceStatus; stock_mention_count: number; evidence_message_ids: number[] };
    ths: { status: SourceStatus; matched_sectors: { code: string; name: string; rank: number }[] };
}
export function unknownSources(): SourceDetails {
    return {
        cls: { status: 'unknown', matched_concepts: [] },
        glh: { status: 'unknown', matched_concepts: [] },
        qq: { status: 'unknown', stock_mention_count: 0, evidence_message_ids: [] },
        ths: { status: 'unknown', matched_sectors: [] },
    };
}
export function mediaSources(symbol: string, concepts: HotConceptResult[], available: { cls: boolean; glh: boolean }) {
    const names = { cls: new Set<string>(), glh: new Set<string>() };
    for (const concept of concepts) {
        for (const stock of concept.stockCodes) {
            if (stock.symbol !== symbol) continue;
            if (stock.source === 'cls' || stock.source === 'both') names.cls.add(concept.conceptName);
            if (stock.source === 'glh' || stock.source === 'both') names.glh.add(concept.conceptName);
        }
    }
    const result = unknownSources();
    for (const source of ['cls', 'glh'] as const) {
        result[source] = {
            status: !available[source] ? 'unavailable' : names[source].size ? 'passed' : 'not_passed',
            matched_concepts: available[source] ? [...names[source]].sort() : [],
        };
    }
    return result;
}

/** 供应商返回顺序不保证排名；按真实rank取Top10，缺失/非法排名不冒充上榜。 */
export function rankedHotSectors(rows: { ts_code: string; ts_name: string; rank: number; pct_change?: number }[]) {
    const seen = new Set<string>();
    return rows.filter(row => Number.isInteger(Number(row.rank)) && Number(row.rank) >= 1 && Number(row.rank) <= 10 && row.ts_name)
        .sort((a, b) => Number(a.rank) - Number(b.rank))
        .filter(row => {
            const key = row.ts_code?.split('.')[0] || row.ts_name;
            if (seen.has(key)) return false;
            seen.add(key); return true;
        }).map(row => ({ code: row.ts_code || '', name: row.ts_name, rank: Number(row.rank), change_pct: Number(row.pct_change) || 0 }));
}
