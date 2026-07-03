import * as XLSX from 'xlsx';
import path from 'path';
import {
    AiGraphDataSource,
    ConceptNode,
    IndustryNode,
    IndustryRelation
} from './AiGraphDataSource';

export class AiGraphExcelSource implements AiGraphDataSource {
    private readonly DATA_DIR = path.join(__dirname, '../../data');
    private readonly CONCEPT_INDUSTRY_FILE = 'concept_industry.xlsx';
    private readonly INDUSTRY_RELATION_FILE = 'industry_relation.xlsx';

    private conceptsCache: ConceptNode[] = [];
    private conceptIndustryMap: Map<string, IndustryNode[]> = new Map();
    private industryRelationsCache: IndustryRelation[] = [];
    private industryNameCache: Map<string, string> = new Map(); // 行业代码 -> 行业名称
    
    private lastLoadTime: number = 0;
    private readonly CACHE_TTL: number = 3600000;

    constructor() {
        this.loadAllData();
    }

    private loadAllData(): void {
        try {
            this.loadConceptIndustryData();
            this.loadIndustryRelationData();
            this.lastLoadTime = Date.now();
            console.log(`[AiGraph Excel] 已加载 ${this.conceptsCache.length} 个概念，${this.industryRelationsCache.length} 条行业关系`);
        } catch (err) {
            console.error('[AiGraph Excel] 加载数据失败:', err);
            throw err;
        }
    }

    private loadConceptIndustryData(): void {
        const filePath = path.join(this.DATA_DIR, this.CONCEPT_INDUSTRY_FILE);
        
        if (!this.existsFile(filePath)) {
            console.warn(`[AiGraph Excel] 概念-行业映射文件不存在: ${filePath}`);
            return;
        }

        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(sheet);

        this.conceptsCache = [];
        this.conceptIndustryMap.clear();

        for (const row of rows) {
            const conceptName: string = row['concept'];
            const conceptCode: string = row['concept_code'];
            const industryName: string = row['industry'];
            const industryCode: string = row['industry_code'];

            if (!conceptCode || !conceptName) continue;

            if (!this.conceptsCache.find(c => c.code === conceptCode)) {
                this.conceptsCache.push({
                    code: conceptCode,
                    name: conceptName
                });
            }

            if (!this.conceptIndustryMap.has(conceptCode)) {
                this.conceptIndustryMap.set(conceptCode, []);
            }
            this.conceptIndustryMap.get(conceptCode)!.push({
                code: industryCode,
                name: industryName
            });
        }

        this.conceptsCache.sort((a, b) => a.name.localeCompare(b.name));
    }

    private loadIndustryRelationData(): void {
        const filePath = path.join(this.DATA_DIR, this.INDUSTRY_RELATION_FILE);
        
        if (!this.existsFile(filePath)) {
            console.warn(`[AiGraph Excel] 行业上下游关系文件不存在: ${filePath}`);
            return;
        }

        const workbook = XLSX.readFile(filePath);
        const sheet = workbook.Sheets[workbook.SheetNames[0]];
        const rows: any[] = XLSX.utils.sheet_to_json(sheet);

        this.industryRelationsCache = [];
        this.industryNameCache.clear();

        for (const row of rows) {
            const sourceName: string = row['source'];
            const sourceCode: string = row['source-code'];
            const targetName: string = row['target'];
            const targetCode: string = row['target-code'];

            if (!sourceCode || !targetCode) continue;

            // 缓存行业名称
            if (!this.industryNameCache.has(sourceCode)) {
                this.industryNameCache.set(sourceCode, sourceName || sourceCode);
            }
            if (!this.industryNameCache.has(targetCode)) {
                this.industryNameCache.set(targetCode, targetName || targetCode);
            }

            this.industryRelationsCache.push({
                sourceCode,
                sourceName: sourceName || sourceCode,
                targetCode,
                targetName: targetName || targetCode
            });
        }
    }

    private existsFile(filePath: string): boolean {
        try {
            const fs = require('fs');
            return fs.existsSync(filePath);
        } catch {
            return false;
        }
    }

    private isCacheValid(): boolean {
        return Date.now() - this.lastLoadTime < this.CACHE_TTL;
    }

    async getAllConcepts(): Promise<ConceptNode[]> {
        if (!this.isCacheValid()) {
            this.loadAllData();
        }
        return this.conceptsCache;
    }

    async getIndustriesByConcept(conceptCode: string): Promise<IndustryNode[]> {
        if (!this.isCacheValid()) {
            this.loadAllData();
        }
        return this.conceptIndustryMap.get(conceptCode) || [];
    }

    async getAllIndustryRelations(): Promise<IndustryRelation[]> {
        if (!this.isCacheValid()) {
            this.loadAllData();
        }
        return this.industryRelationsCache;
    }

    async detectConceptsByEvent(eventText: string): Promise<ConceptNode[]> {
        throw new Error('事件识别功能暂未开放，请使用概念代码查询');
    }

    getIndustryName(industryCode: string): string | undefined {
        if (!this.isCacheValid()) {
            this.loadAllData();
        }
        return this.industryNameCache.get(industryCode);
    }
}