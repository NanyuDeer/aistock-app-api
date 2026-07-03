export interface ConceptNode {
    code: string;
    name: string;
}

export interface IndustryNode {
    code: string;
    name: string;
}

export interface IndustryRelation {
    sourceCode: string;
    sourceName: string;
    targetCode: string;
    targetName: string;
}

export interface ConceptIndustryMapping {
    conceptCode: string;
    conceptName: string;
    industryCode: string;
    industryName: string;
}

export interface AiGraphDataSource {
    getAllConcepts(): Promise<ConceptNode[]>;
    getIndustriesByConcept(conceptCode: string): Promise<IndustryNode[]>;
    getAllIndustryRelations(): Promise<IndustryRelation[]>;
    getIndustryName(industryCode: string): string | undefined;
    detectConceptsByEvent?(eventText: string): Promise<ConceptNode[]>;
}

export enum DataSourceType {
    EXCEL = 'excel',
    DATABASE = 'database',
    API = 'api',
    AI_DETECT = 'ai_detect'
}

export class AiGraphDataSourceFactory {
    private static currentSource: AiGraphDataSource | null = null;
    private static currentType: DataSourceType = DataSourceType.EXCEL;

    static async initialize(type: DataSourceType = DataSourceType.EXCEL): Promise<void> {
        this.currentType = type;

        switch (type) {
            case DataSourceType.EXCEL:
                const { AiGraphExcelSource } = await import('./AiGraphExcelSource');
                this.currentSource = new AiGraphExcelSource();
                break;
            case DataSourceType.DATABASE:
                throw new Error('数据库数据源暂未实现');
            case DataSourceType.API:
                throw new Error('API 数据源暂未实现');
            case DataSourceType.AI_DETECT:
                throw new Error('AI 事件识别暂未实现');
            default:
                throw new Error(`未知的数据源类型: ${type}`);
        }

        console.log(`[AiGraph] 数据源初始化完成: ${type}`);
    }

    static getSource(): AiGraphDataSource {
        if (!this.currentSource) {
            throw new Error('数据源未初始化，请先调用 initialize()');
        }
        return this.currentSource;
    }

    static getCurrentType(): DataSourceType {
        return this.currentType;
    }

    static async switchSource(type: DataSourceType): Promise<void> {
        if (type === this.currentType) {
            console.log(`[AiGraph] 数据源已是 ${type}，无需切换`);
            return;
        }

        console.log(`[AiGraph] 正在切换数据源: ${this.currentType} -> ${type}`);
        await this.initialize(type);
        console.log(`[AiGraph] 数据源切换成功`);
    }
}