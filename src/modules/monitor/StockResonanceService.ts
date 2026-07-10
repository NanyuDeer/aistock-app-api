import { HotKeywordDetectorService, type HotConceptResult } from './HotKeywordDetectorService';
import { isParentIndustryHot } from './ConceptIndustryMap';
import { findResearchReportMessagesForStock, type ResearchReportStock } from '../crawler/FeishuResearchReportService';
import { getThsHot, type ThsHotRow } from '../quote/TushareService';

export interface MatchedSector {
  sectorName: string;
  rank: number;
  conceptName: string;
  conceptTsCode: string;
}

export interface StockResonanceDetail {
  symbol: string;
  updateTime: string;
  clsVerified: boolean;
  glhVerified: boolean;
  thsVerified: boolean;
  reportVerified: boolean;
  /** 共振信号数量（1-4） */
  resonanceCount: number;
  /** 概念详情 */
  concepts: { conceptName: string; conceptTsCode: string; clsCount: number; glhCount: number; surgeRatio: number }[];
  /** 同花顺匹配板块 */
  matchedSectors: MatchedSector[];
  bestRank: number;
  /** 研报详情 */
  reports: ResearchReportStock[];
  isOutbreak: boolean;
}

function formatDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

export async function fetchThsHotSectors(): Promise<{ name: string; rank: number; changePct: number }[]> {
  try {
    const today = new Date();
    for (let offset = 0; offset < 3; offset++) {
      const d = new Date(today);
      d.setDate(d.getDate() - offset);
      const dateStr = formatDate(d);

      const hotData: ThsHotRow[] = await getThsHot(dateStr, '概念板块');
      if (hotData.length > 0) {
        return hotData.slice(0, 10).map((row, idx) => ({
          name: row.ts_name || '',
          rank: idx + 1,
          changePct: Number(row.pct_change) || 0,
        }));
      }
    }
  } catch (err) {
    console.warn('[StockResonance] 同花顺热榜获取失败:', (err as Error).message);
  }
  return [];
}

export async function evaluateStockResonance(
  symbol: string,
  hotConcepts: HotConceptResult[],
  hotSectorNameSet: Set<string>,
  hotSectorRankMap: Map<string, number>,
  reportStocks: ResearchReportStock[],
): Promise<StockResonanceDetail> {
  const relatedConcepts: { conceptName: string; conceptTsCode: string; clsCount: number; glhCount: number; surgeRatio: number }[] = [];
  const matchedSectors: MatchedSector[] = [];

  let clsVerified = false;
  let glhVerified = false;

  for (const concept of hotConcepts) {
    if (!concept.stockCodes.some(s => s.symbol === symbol)) continue;

    if (concept.clsCount > 0) clsVerified = true;
    if (concept.glhCount > 0) glhVerified = true;

    relatedConcepts.push({
      conceptName: concept.conceptName,
      conceptTsCode: concept.conceptTsCode,
      clsCount: concept.clsCount,
      glhCount: concept.glhCount,
      surgeRatio: concept.surgeRatio,
    });

    const parentCheck = await isParentIndustryHot(concept.conceptTsCode, hotSectorNameSet);
    for (const matchedName of parentCheck.matched) {
      const rank = hotSectorRankMap.get(matchedName) || 0;
      if (rank > 0) {
        matchedSectors.push({
          sectorName: matchedName,
          rank,
          conceptName: concept.conceptName,
          conceptTsCode: concept.conceptTsCode,
        });
      }
    }
  }

  const bestRank = matchedSectors.length > 0 ? Math.min(...matchedSectors.map(s => s.rank)) : 0;
  const thsVerified = matchedSectors.length > 0;
  const reportVerified = reportStocks.length > 0;
  const resonanceCount = [clsVerified, glhVerified, thsVerified, reportVerified].filter(Boolean).length;

  return {
    symbol,
    updateTime: new Date().toISOString(),
    clsVerified,
    glhVerified,
    thsVerified,
    reportVerified,
    resonanceCount,
    concepts: relatedConcepts,
    matchedSectors,
    bestRank,
    reports: reportStocks.slice(0, 10),
    isOutbreak: resonanceCount >= 2,
  };
}

export async function getStockResonance(symbol: string): Promise<StockResonanceDetail> {
  const [hotConcepts, hotSectors, reportStocks] = await Promise.all([
    HotKeywordDetectorService.detectHotConcepts(),
    fetchThsHotSectors(),
    findResearchReportMessagesForStock(symbol, 24),
  ]);

  const hotSectorNameSet = new Set(hotSectors.map(s => s.name));
  const hotSectorRankMap = new Map(hotSectors.map(s => [s.name, s.rank]));

  return evaluateStockResonance(symbol, hotConcepts, hotSectorNameSet, hotSectorRankMap, reportStocks);
}
