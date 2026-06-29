/**
 * 行业知识图谱服务 (Industry Knowledge Graph Service)
 *
 * 核心职责：
 * 1. 加载同花顺二级行业（I类）和概念板块（N类）
 * 2. AI生成行业上下游关系 + 双向一致性校验
 * 3. 基于成分股重叠度构建概念-行业关联
 * 4. 每个行业节点内嵌龙头股
 * 5. 15天缓存，半月更新
 */

import * as fs from 'fs';
import * as path from 'path';
import { getThsIndex, getThsMember, getDailyByDate, getDailyBasicByDate, getFinaIndicator, getIncome, ThsIndexRow } from './TushareService';
import { sessionFetch } from '../utils/httpAgent';

// ==================== 类型定义 ====================

export interface KGIndustryNode {
    id: string;           // 行业代码 (如 881101.TI)
    name: string;         // 行业名称
    leadingStocks: KGLleadingStock[];
}

export interface KGLleadingStock {
    code: string;
    name: string;
    changePct: number;
}

export interface KGConceptNode {
    id: string;           // 概念代码 (如 885641.TI)
    name: string;         // 概念名称
    relatedIndustries: {
        industryId: string;
        overlapRatio: number;
        overlapCount: number;
    }[];
}

export interface KGEdge {
    source: string;       // 上游行业代码
    target: string;       // 下游行业代码
    confidence: 'ai_strong' | 'ai_weak';
    direction: 'upstream'; // source是target的上游
}

export interface KGFullGraph {
    industries: KGIndustryNode[];
    concepts: KGConceptNode[];
    edges: KGEdge[];
    updateTime: string;
    industryCount: number;
    edgeCount: number;
    conceptCount: number;
}

export interface KGSubGraph {
    centerConcept?: KGConceptNode;
    centerIndustries: KGIndustryNode[];
    upstreamIndustries: KGIndustryNode[];
    downstreamIndustries: KGIndustryNode[];
    edges: KGEdge[];
    conceptEdges: Array<{
        conceptId: string;
        industryId: string;
        overlapRatio: number;
    }>;
}

// ==================== 缓存与文件 ====================

const CACHE_DIR = path.resolve(__dirname, '../../data/kg-cache');
const DATA_DIR = path.resolve(__dirname, '../../data');
const FIFTEEN_DAYS = 15 * 24 * 3600 * 1000;
const SEVEN_DAYS = 7 * 24 * 3600 * 1000;

/** 带重试的异步函数调用 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries: number = 3, delayMs: number = 2000): Promise<T> {
    let lastErr: any;
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await fn();
        } catch (err: any) {
            lastErr = err;
            const msg = err?.message || String(err);
            console.warn(`[IndustryKG] 重试 ${i + 1}/${maxRetries}: ${msg}`);
            if (i < maxRetries - 1) {
                await new Promise(r => setTimeout(r, delayMs * (i + 1)));
            }
        }
    }
    throw lastErr;
}

function ensureCacheDir(): void {
    if (!fs.existsSync(CACHE_DIR)) {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
    }
}

function readCacheFile(filename: string, ttl: number = FIFTEEN_DAYS): any | null {
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, filename);
        if (!fs.existsSync(fp)) return null;
        const stat = fs.statSync(fp);
        if (Date.now() - stat.mtimeMs > ttl) return null;
        const raw = fs.readFileSync(fp, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function writeCacheFile(filename: string, data: any): void {
    try {
        ensureCacheDir();
        const fp = path.join(CACHE_DIR, filename);
        fs.writeFileSync(fp, JSON.stringify(data), 'utf-8');
    } catch (err) {
        console.warn('[IndustryKG] 缓存写入失败:', err);
    }
}

// ==================== AI批量生成上下游关系 ====================

interface AIRelation {
    upstream: string[];
    downstream: string[];
}

async function aiGenerateChainBatch(
    batch: string[],
    allNames: string[],
): Promise<Record<string, AIRelation>> {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) throw new Error('未配置OPENAI_API_KEY');

    let apiBase = process.env.OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    const chatUrl = apiBase.includes('/chat/completions') ? apiBase : `${apiBase}/chat/completions`;
    const model = process.env.AI_MODEL || 'gpt-4o-mini';

    const prompt = `你是一位资深A股行业分析师，熟悉同花顺行业分类体系。请为以下行业确定其上游和下游行业。

参考行业名称列表（请仅使用此列表中的名称，必须精确匹配，包括后缀如"Ⅲ"或"(A股)"）：
${allNames.join('、')}

请为以下行业确定上下游：
${batch.map((n, i) => `${i + 1}. ${n}`).join('\n')}

返回JSON格式，key为行业名称（必须与参考列表精确一致），value为{"upstream": [...], "downstream": [...]}。

规则：
1. 上游行业：该行业的原材料、零部件、设备供应商所属行业
2. 下游行业：该行业产品的应用领域、客户所属行业
3. 仅使用参考列表中的行业名称，必须精确匹配（包括"Ⅲ"、"(A股)"等后缀），不要省略或改写
4. 如果某行业无明确上下游，返回空数组
5. 每个行业的上下游各不超过5个
6. 只返回JSON，不要其他文字
7. 确保JSON格式完全正确，不要有多余逗号或注释`;

    const resp = await sessionFetch(chatUrl, {
        method: 'POST',
        signal: AbortSignal.timeout(180000),
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
            model,
            messages: [
                { role: 'system', content: '你是一位A股行业分析师，只返回JSON，不要其他文字。' },
                { role: 'user', content: prompt },
            ],
            temperature: 0.1,
        }),
    });

    if (!resp.ok) {
        throw new Error(`AI API error: ${resp.status}`);
    }

    const result = await resp.json() as any;
    const content = result.choices?.[0]?.message?.content || '';

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('AI返回格式异常');

    try {
        return JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
        let fixed = jsonMatch[0]
            .replace(/,\s*([}\]])/g, '$1')
            .replace(/'/g, '"');
        try {
            return JSON.parse(fixed);
        } catch {
            throw new Error(`AI返回JSON解析失败: ${(parseErr as Error).message}`);
        }
    }
}

// ==================== 核心服务 ====================

export class IndustryKGService {
    private static fullGraph: KGFullGraph | null = null;
    private static building = false;

    /**
     * 初始化：加载或构建知识图谱
     */
    static async initialize(): Promise<void> {
        const cached = readCacheFile('full_graph.json');
        if (cached) {
            this.fullGraph = cached;
            console.log(`[IndustryKG] 从缓存加载: ${cached.industryCount}个行业, ${cached.edgeCount}条边, ${cached.conceptCount}个概念`);

            // 检查龙头股是否为空，如果为空则后台补充加载（不阻塞启动）
            const emptyCount = cached.industries.filter((i: KGIndustryNode) => !i.leadingStocks || i.leadingStocks.length === 0).length;
            if (emptyCount > 0) {
                console.log(`[IndustryKG] ${emptyCount}个行业缺少龙头股数据，后台开始补充加载...`);
                this.loadLeadingStocksInBackground(cached.industries);
            }

            return;
        }

        await this.rebuild();
    }

    /**
     * 后台加载龙头股，完成后更新内存和缓存
     */
    private static loadLeadingStocksInBackground(industries: KGIndustryNode[]): void {
        this.loadLeadingStocks(industries)
            .then(industriesWithStocks => {
                if (this.fullGraph) {
                    this.fullGraph.industries = industriesWithStocks;
                    writeCacheFile('full_graph.json', this.fullGraph);
                    const filledCount = industriesWithStocks.filter(i => i.leadingStocks && i.leadingStocks.length > 0).length;
                    console.log(`[IndustryKG] 龙头股后台加载完成: ${filledCount}/${industries.length}个行业有龙头股`);
                }
            })
            .catch(err => {
                console.warn(`[IndustryKG] 龙头股后台加载失败: ${err?.message || err}`);
            });
    }

    /**
     * 重建知识图谱（半月更新/手动触发）
     */
    static async rebuild(): Promise<KGFullGraph> {
        if (this.building) {
            throw new Error('知识图谱正在构建中，请稍后');
        }
        this.building = true;

        try {
            console.log('[IndustryKG] 开始构建知识图谱...');

            // 1. 一次性加载所有ths_index（I+N），筛选分类
            const { industries, concepts } = await this.loadIndexData();
            console.log(`[IndustryKG] 加载${industries.length}个二级行业, ${concepts.length}个概念板块`);

            // 2. AI生成上下游关系
            let aiEdges: KGEdge[] = [];
            try {
                aiEdges = await this.buildAIEdges(industries);
                console.log(`[IndustryKG] AI生成${aiEdges.length}条边`);
            } catch (err: any) {
                console.warn(`[IndustryKG] AI生成上下游关系失败: ${err?.message || err}`);
            }

            // 3. 双向一致性校验
            const verifiedEdges = this.verifyBidirectional(aiEdges, industries);
            console.log(`[IndustryKG] 双向校验后: strong=${verifiedEdges.filter(e => e.confidence === 'ai_strong').length}, weak=${verifiedEdges.filter(e => e.confidence === 'ai_weak').length}`);

            // 4. 基于成分股重叠度构建概念-行业关联
            const conceptsWithRelations = await this.buildConceptIndustryRelations(industries, concepts);
            console.log(`[IndustryKG] 概念-行业关联构建完成: ${conceptsWithRelations.length}个概念有关联行业`);

            // 5. 为每个行业加载龙头股（异步，不阻塞）
            const industriesWithStocks = await this.loadLeadingStocks(industries);

            this.fullGraph = {
                industries: industriesWithStocks,
                concepts: conceptsWithRelations,
                edges: verifiedEdges,
                updateTime: new Date().toISOString(),
                industryCount: industriesWithStocks.length,
                edgeCount: verifiedEdges.length,
                conceptCount: conceptsWithRelations.length,
            };

            writeCacheFile('full_graph.json', this.fullGraph);
            console.log(`[IndustryKG] 知识图谱构建完成: ${this.fullGraph.industryCount}个行业, ${this.fullGraph.edgeCount}条边, ${this.fullGraph.conceptCount}个概念`);

            return this.fullGraph;
        } finally {
            this.building = false;
        }
    }

    /**
     * 获取完整知识图谱
     */
    static getFullGraph(): KGFullGraph {
        if (!this.fullGraph) {
            throw new Error('知识图谱未初始化');
        }
        return this.fullGraph;
    }

    /**
     * 获取概念子图（用于层级流向图）
     */
    static getSubGraphByConcept(conceptId: string, depth: number = 1): KGSubGraph {
        const graph = this.getFullGraph();
        const concept = graph.concepts.find(c => c.id === conceptId);
        if (!concept) {
            throw new Error(`概念 ${conceptId} 不存在`);
        }

        const centerIndustryIds = new Set(concept.relatedIndustries.map(r => r.industryId));
        const upstreamIds = new Set<string>();
        const downstreamIds = new Set<string>();

        let currentUpstream = new Set(centerIndustryIds);
        let currentDownstream = new Set(centerIndustryIds);

        for (let d = 0; d < depth; d++) {
            const nextUpstream = new Set<string>();
            const nextDownstream = new Set<string>();

            for (const edge of graph.edges) {
                if (currentUpstream.has(edge.target) && !centerIndustryIds.has(edge.source)) {
                    upstreamIds.add(edge.source);
                    nextUpstream.add(edge.source);
                }
                if (currentDownstream.has(edge.source) && !centerIndustryIds.has(edge.target)) {
                    downstreamIds.add(edge.target);
                    nextDownstream.add(edge.target);
                }
            }

            currentUpstream = nextUpstream;
            currentDownstream = nextDownstream;
        }

        const subEdgeSet = new Set<string>();
        const subEdges: KGEdge[] = [];

        for (const edge of graph.edges) {
            const allIds = new Set([...centerIndustryIds, ...upstreamIds, ...downstreamIds]);
            if (allIds.has(edge.source) && allIds.has(edge.target)) {
                const key = `${edge.source}->${edge.target}`;
                if (!subEdgeSet.has(key)) {
                    subEdgeSet.add(key);
                    subEdges.push(edge);
                }
            }
        }

        const findIndustry = (id: string) => graph.industries.find(i => i.id === id);

        return {
            centerConcept: concept,
            centerIndustries: [...centerIndustryIds].map(id => findIndustry(id)!).filter(Boolean),
            upstreamIndustries: [...upstreamIds].map(id => findIndustry(id)!).filter(Boolean),
            downstreamIndustries: [...downstreamIds].map(id => findIndustry(id)!).filter(Boolean),
            edges: subEdges,
            conceptEdges: concept.relatedIndustries.map(r => ({
                conceptId: concept.id,
                industryId: r.industryId,
                overlapRatio: r.overlapRatio,
            })),
        };
    }

    /**
     * 根据概念ID获取强关联行业（供HotSector调用）
     */
    static getConceptRelatedIndustries(conceptId: string): {
        concept: KGConceptNode;
        stronglyRelated: KGIndustryNode[];
        allRanked: { industry: KGIndustryNode; overlapCount: number; overlapRatio: number }[];
    } {
        const graph = this.getFullGraph();
        const concept = graph.concepts.find(c => c.id === conceptId);
        if (!concept) throw new Error(`概念 ${conceptId} 不存在`);

        const allRanked = concept.relatedIndustries.map(ri => {
            const industry = graph.industries.find(i => i.id === ri.industryId)!;
            return {
                industry,
                overlapCount: ri.overlapCount,
                overlapRatio: ri.overlapRatio,
            };
        }).filter(r => r.industry);

        const stronglyRelated = allRanked
            .slice(0, 3)
            .map(r => r.industry);

        return { concept, stronglyRelated, allRanked };
    }

    /**
     * 根据概念名称获取强关联行业（供HotSector调用，按名称查找）
     */
    static getConceptRelatedIndustriesByName(conceptName: string): {
        concept: KGConceptNode;
        stronglyRelated: KGIndustryNode[];
        allRanked: { industry: KGIndustryNode; overlapCount: number; overlapRatio: number }[];
    } {
        const graph = this.getFullGraph();
        const concept = graph.concepts.find(c => c.name === conceptName);
        if (!concept) throw new Error(`概念 ${conceptName} 不存在`);
        return this.getConceptRelatedIndustries(concept.id);
    }

    /**
     * 根据行业ID获取上下游行业（供HotSector调用，替代AI产业链查找）
     */
    static getUpstreamDownstream(industryId: string, depth: number = 1): {
        upstream: KGIndustryNode[];
        downstream: KGIndustryNode[];
    } {
        const graph = this.getFullGraph();

        const upstreamIds = new Set<string>();
        const downstreamIds = new Set<string>();

        let currentUpstream = new Set([industryId]);
        let currentDownstream = new Set([industryId]);

        for (let d = 0; d < depth; d++) {
            const nextUpstream = new Set<string>();
            const nextDownstream = new Set<string>();

            for (const edge of graph.edges) {
                if (currentUpstream.has(edge.target) && edge.source !== industryId) {
                    if (!upstreamIds.has(edge.source)) {
                        upstreamIds.add(edge.source);
                        nextUpstream.add(edge.source);
                    }
                }
                if (currentDownstream.has(edge.source) && edge.target !== industryId) {
                    if (!downstreamIds.has(edge.target)) {
                        downstreamIds.add(edge.target);
                        nextDownstream.add(edge.target);
                    }
                }
            }

            currentUpstream = nextUpstream;
            currentDownstream = nextDownstream;
        }

        const findIndustry = (id: string) => graph.industries.find(i => i.id === id);

        return {
            upstream: [...upstreamIds].map(findIndustry).filter(Boolean) as KGIndustryNode[],
            downstream: [...downstreamIds].map(findIndustry).filter(Boolean) as KGIndustryNode[],
        };
    }

    /**
     * 根据行业名称获取上下游行业
     */
    static getUpstreamDownstreamByName(industryName: string, depth: number = 1): {
        upstream: KGIndustryNode[];
        downstream: KGIndustryNode[];
    } {
        const graph = this.getFullGraph();
        const industry = graph.industries.find(i => i.name === industryName);
        if (!industry) return { upstream: [], downstream: [] };
        return this.getUpstreamDownstream(industry.id, depth);
    }

    // ==================== AI产业链子图 ====================

    /** AI相关关键词（行业和概念共用） */
    private static readonly AI_KEYWORDS = [
        'AI', '人工智能', '芯片', '半导体', '光刻', 'CPO', 'PCB', '光纤', '光模块',
        '存储', '算力', 'GPU', 'FPGA', 'HBM', 'MLCC', '玻璃基板', '培育钻石',
        '物理AI', '铜缆', '太赫兹', '光通信', '激光', 'EDA', '封测',
        '大基金', '集成电路', '晶圆', '刻蚀', '薄膜', '溅射', '电子化学品',
        '消费电子', '光学光电子', '通信设备', '计算机设备', '机器人',
        '自动化', '智能制造', '工业互联', '数据中心', '云计算',
        '量子', '脑机', '边缘计算', '5G', '6G', '物联网',
        '鸿蒙', '信创', '国产替代', '国产芯片',
        // 补充关键词
        'TGV', '先进封装', 'CoWoS', 'HBM3', '硅光', '光电', '服务器',
        '液冷', '散热', '电源管理', 'MCU', 'SOC', 'DSP', 'ADC',
        '连接器', '继电器', '传感器', '摄像头', '显示', 'OLED', 'MicroLED',
        'MiniLED', 'VR', 'AR', 'MR', 'XR', '智能穿戴', '智能汽车',
        '自动驾驶', '激光雷达', '毫米波', '射频', '天线', '基站',
        '交换机', '路由器', '网络安全', '数据要素', 'AIGC', '大模型',
        'ChatGPT', '文心', '通义', '智谱', '深度学习', '机器学习',
        '神经网络', '知识图谱', '自然语言', '语音识别', '计算机视觉',
        '具身智能', '人形机器人', '工业机器人', '服务机器人',
        '固态电池', '钠电池', '氢能', '核聚变', '超导',
        '碳化硅', '氮化镓', '砷化镓', '磷化铟', '第二代半导体', '第三代半导体',
        '光刻胶', '抛光', '清洗', '检测', '量测',
    ];

    /**
     * 判断名称是否匹配AI关键词
     */
    private static matchesAIKeyword(name: string): boolean {
        const upper = name.toUpperCase();
        return this.AI_KEYWORDS.some(kw => upper.includes(kw.toUpperCase()));
    }

    /**
     * 获取AI产业链子图
     * 算法：
     * 1. 用关键词匹配种子行业和概念
     * 2. 从种子节点出发，沿edges做BFS，把所有直接/间接关联的行业纳入
     * 3. 概念通过conceptIndustryRelations关联行业，BFS时也沿概念-行业关系扩展
     * 4. 收集所有涉及的边
     */
    static getAISubGraph(): KGFullGraph {
        const graph = this.getFullGraph();

        // 1. 种子节点：关键词匹配的行业和概念
        const seedIndustryIds = new Set<string>();
        const seedConceptIds = new Set<string>();

        for (const ind of graph.industries) {
            if (this.matchesAIKeyword(ind.name)) {
                seedIndustryIds.add(ind.id);
            }
        }
        for (const c of graph.concepts) {
            if (this.matchesAIKeyword(c.name)) {
                seedConceptIds.add(c.id);
            }
        }

        console.log(`[IndustryKG] AI种子: ${seedIndustryIds.size}个行业, ${seedConceptIds.size}个概念`);

        // 2. BFS扩展：沿行业上下游边 + 概念-行业关联边
        const visitedIndustryIds = new Set<string>(seedIndustryIds);
        const visitedConceptIds = new Set<string>(seedConceptIds);

        // 概念→行业：种子概念关联的行业也加入
        for (const cId of seedConceptIds) {
            const concept = graph.concepts.find(c => c.id === cId);
            if (concept) {
                for (const rel of concept.relatedIndustries) {
                    visitedIndustryIds.add(rel.industryId);
                }
            }
        }

        // 行业→概念：种子行业关联的概念也加入
        for (const iId of seedIndustryIds) {
            for (const c of graph.concepts) {
                if (c.relatedIndustries.some(r => r.industryId === iId)) {
                    visitedConceptIds.add(c.id);
                }
            }
        }

        // 沿edges做BFS（无限深度，直到没有新节点）
        let changed = true;
        while (changed) {
            changed = false;

            // 沿行业上下游边扩展
            for (const edge of graph.edges) {
                if (visitedIndustryIds.has(edge.source) && !visitedIndustryIds.has(edge.target)) {
                    visitedIndustryIds.add(edge.target);
                    changed = true;
                }
                if (visitedIndustryIds.has(edge.target) && !visitedIndustryIds.has(edge.source)) {
                    visitedIndustryIds.add(edge.source);
                    changed = true;
                }
            }

            // 新加入的行业→关联概念
            for (const c of graph.concepts) {
                if (!visitedConceptIds.has(c.id)) {
                    if (c.relatedIndustries.some(r => visitedIndustryIds.has(r.industryId))) {
                        visitedConceptIds.add(c.id);
                        changed = true;
                    }
                }
            }

            // 新加入的概念→关联行业
            for (const cId of visitedConceptIds) {
                const concept = graph.concepts.find(c => c.id === cId);
                if (concept) {
                    for (const rel of concept.relatedIndustries) {
                        if (!visitedIndustryIds.has(rel.industryId)) {
                            visitedIndustryIds.add(rel.industryId);
                            changed = true;
                        }
                    }
                }
            }
        }

        // 3. 收集子图数据
        const subIndustries = graph.industries.filter(i => visitedIndustryIds.has(i.id));
        const subConcepts = graph.concepts.filter(c => visitedConceptIds.has(c.id));
        const subEdges = graph.edges.filter(e => visitedIndustryIds.has(e.source) && visitedIndustryIds.has(e.target));

        console.log(`[IndustryKG] AI子图: ${subIndustries.length}个行业, ${subConcepts.length}个概念, ${subEdges.length}条边`);

        return {
            industries: subIndustries,
            concepts: subConcepts,
            edges: subEdges,
            updateTime: graph.updateTime,
            industryCount: subIndustries.length,
            edgeCount: subEdges.length,
            conceptCount: subConcepts.length,
        };
    }

    /**
     * 获取行业龙头股
     */
    static getIndustryStocks(industryId: string): KGLleadingStock[] {
        const graph = this.getFullGraph();
        const industry = graph.industries.find(i => i.id === industryId);
        return industry?.leadingStocks || [];
    }

    /**
     * 获取所有概念列表
     */
    static getAllConcepts(): { id: string; name: string; industryCount: number }[] {
        const graph = this.getFullGraph();
        return graph.concepts.map(c => ({
            id: c.id,
            name: c.name,
            industryCount: c.relatedIndustries.length,
        }));
    }

    // ==================== 内部方法 ====================

    /**
     * 一次性加载ths_index数据，筛选出I类行业和N类概念
     * ths_index不允许重复调用，所以一次获取所有A股数据
     */
    private static async loadIndexData(): Promise<{
        industries: KGIndustryNode[];
        concepts: KGConceptNode[];
    }> {
        // 检查缓存
        const cachedIndustries = readCacheFile('industries.json');
        const cachedConcepts = readCacheFile('concepts.json');
        if (cachedIndustries && cachedConcepts) {
            console.log(`[IndustryKG] 从缓存加载行业/概念索引`);
            return {
                industries: cachedIndustries as KGIndustryNode[],
                concepts: cachedConcepts as KGConceptNode[],
            };
        }

        // 一次性获取所有A股同花顺指数
        const allIndices = await withRetry(() => getThsIndex('', 'A'), 5, 3000);
        console.log(`[IndustryKG] ths_index获取${allIndices.length}条记录`);

        // 筛选I类行业（排除700开头的错误数据）
        const industries: KGIndustryNode[] = allIndices
            .filter((idx: ThsIndexRow) => idx.type === 'I' && !idx.ts_code.startsWith('700'))
            .map((idx: ThsIndexRow) => ({
                id: idx.ts_code,
                name: idx.name,
                leadingStocks: [],
            }));

        // 筛选N类概念
        const concepts: KGConceptNode[] = allIndices
            .filter((idx: ThsIndexRow) => idx.type === 'N')
            .map((idx: ThsIndexRow) => ({
                id: idx.ts_code,
                name: idx.name,
                relatedIndustries: [],
            }));

        writeCacheFile('industries.json', industries);
        writeCacheFile('concepts.json', concepts);

        return { industries, concepts };
    }

    /**
     * 基于成分股重叠度构建概念-行业关联
     * 算法：获取概念成分股和行业成分股，计算重叠度，取Top1-3作为强关联
     * ths_member接口限制：每分钟200次
     */
    private static async buildConceptIndustryRelations(
        industries: KGIndustryNode[],
        concepts: KGConceptNode[],
    ): Promise<KGConceptNode[]> {
        // 检查缓存
        const cached = readCacheFile('concept_industry_relations.json');
        if (cached) {
            console.log(`[IndustryKG] 从缓存加载概念-行业关联`);
            return cached as KGConceptNode[];
        }

        // 1. 构建股票→行业反向映射（每个行业获取成分股）
        const stockIndustryMap = await this.buildStockIndustryMap(industries);

        // 2. 对每个概念，获取成分股，计算与各行业的重叠度
        // ths_member限制每分钟200次，每批3个概念（每个概念1次调用），间隔1秒
        const batchSize = 3;
        let processedCount = 0;

        for (let i = 0; i < concepts.length; i += batchSize) {
            const batch = concepts.slice(i, i + batchSize);

            await Promise.all(batch.map(async (concept) => {
                try {
                    const members = await withRetry(() => getThsMember(concept.id), 3, 2000);
                    const conceptCodes = new Set(
                        members
                            .filter(m => m.is_new === 'Y')
                            .map(m => m.con_code)
                    );

                    if (conceptCodes.size === 0) return;

                    // 统计各行业的重叠度
                    const industryOverlap = new Map<string, number>();
                    for (const code of conceptCodes) {
                        const relatedIndustries = stockIndustryMap.get(code) || [];
                        for (const indId of relatedIndustries) {
                            industryOverlap.set(indId, (industryOverlap.get(indId) || 0) + 1);
                        }
                    }

                    // 按重叠度降序排序
                    const sorted = [...industryOverlap.entries()]
                        .sort((a, b) => b[1] - a[1]);

                    // 强关联判断：Top1-3，带差距判断
                    const relatedIndustries: KGConceptNode['relatedIndustries'] = [];
                    for (let j = 0; j < Math.min(3, sorted.length); j++) {
                        const [indId, count] = sorted[j];
                        // 差距判断：当前行业重叠数不到前一个的40%，或少于2只，停止
                        if (j > 0 && count < sorted[j - 1][1] * 0.4) break;
                        if (count < 2) break;
                        relatedIndustries.push({
                            industryId: indId,
                            overlapRatio: Math.round(count / conceptCodes.size * 1000) / 1000,
                            overlapCount: count,
                        });
                    }

                    concept.relatedIndustries = relatedIndustries;
                } catch {
                    // 获取概念成分股失败，跳过
                }
            }));

            processedCount += batch.length;
            if (processedCount % 30 === 0) {
                console.log(`[IndustryKG] 概念-行业关联构建进度: ${processedCount}/${concepts.length}`);
            }

            // 控制频率：每批3个概念，间隔1秒，约180次/分钟 < 200次上限
            if (i + batchSize < concepts.length) {
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        // 过滤掉无关联行业的概念
        const result = concepts.filter(c => c.relatedIndustries.length > 0);
        writeCacheFile('concept_industry_relations.json', result);
        console.log(`[IndustryKG] 概念-行业关联构建完成: ${result.length}/${concepts.length}个概念有关联行业`);

        return result;
    }

    /**
     * 构建股票→行业反向映射
     * 对每个行业获取成分股，建立 stock_code → [industry_id...] 的映射
     * ths_member限制每分钟200次，每批5个行业，间隔2秒
     */
    private static async buildStockIndustryMap(
        industries: KGIndustryNode[],
    ): Promise<Map<string, string[]>> {
        // 检查缓存（7天有效）
        const cached = readCacheFile('stock_industry_map.json', SEVEN_DAYS);
        if (cached) {
            const map = new Map<string, string[]>();
            for (const [k, v] of Object.entries(cached as Record<string, string[]>)) {
                map.set(k, v);
            }
            console.log(`[IndustryKG] 股票→行业映射从缓存加载: ${map.size}只股票`);
            return map;
        }

        const map = new Map<string, string[]>();
        let processedCount = 0;
        let failCount = 0;

        // 串行调用，每次1个行业，间隔400ms（约150次/分钟 < 200次上限）
        for (const ind of industries) {
            try {
                const members = await withRetry(() => getThsMember(ind.id), 3, 2000);
                // is_new='Y' 表示当前有效，'N' 表示已剔除
                const activeMembers = members.filter(m => m.is_new === 'Y');
                for (const m of activeMembers) {
                    if (!map.has(m.con_code)) map.set(m.con_code, []);
                    map.get(m.con_code)!.push(ind.id);
                }
            } catch (err: any) {
                failCount++;
                if (failCount <= 3) {
                    console.warn(`[IndustryKG] getThsMember(${ind.id})失败: ${err?.message || err}`);
                }
            }

            processedCount++;
            if (processedCount % 50 === 0) {
                console.log(`[IndustryKG] 股票→行业映射构建进度: ${processedCount}/${industries.length}, ${map.size}只股票`);
            }

            // 控制频率：每次调用间隔400ms
            await new Promise(r => setTimeout(r, 400));
        }

        // 缓存
        const obj: Record<string, string[]> = {};
        for (const [k, v] of map) obj[k] = v;
        writeCacheFile('stock_industry_map.json', obj);
        console.log(`[IndustryKG] 股票→行业映射构建完成: ${map.size}只股票, ${industries.length}个行业, ${failCount}个失败`);

        return map;
    }

    /**
     * AI批量生成上下游边
     */
    private static async buildAIEdges(industries: KGIndustryNode[]): Promise<KGEdge[]> {
        const cached = readCacheFile('ai_edges.json');
        if (cached) {
            console.log(`[IndustryKG] 从缓存加载AI边: ${cached.length}条`);
            return cached;
        }

        const allNames = industries.map(i => i.name);
        const nameToId = new Map(industries.map(i => [i.name, i.id]));
        // 模糊匹配：去掉"Ⅲ"、"(A股)"后缀的映射
        const cleanNameToId = new Map<string, string>();
        for (const ind of industries) {
            const clean = ind.name.replace(/[ⅢⅡⅣⅠ]$/, '').replace(/\(A股\)$/, '');
            if (clean !== ind.name) {
                cleanNameToId.set(clean, ind.id);
            }
        }
        const resolveIndustryId = (name: string): string | undefined => {
            // 1. 精确匹配
            if (nameToId.has(name)) return nameToId.get(name);
            // 2. 去后缀模糊匹配
            const clean = name.replace(/[ⅢⅡⅣⅠ]$/, '').replace(/\(A股\)$/, '');
            if (cleanNameToId.has(clean)) return cleanNameToId.get(clean);
            // 3. 对AI返回的名字也去掉后缀再匹配
            const cleanName = name.replace(/[ⅢⅡⅣⅠ]$/, '').replace(/\(A股\)$/, '');
            for (const [origName, id] of nameToId) {
                const origClean = origName.replace(/[ⅢⅡⅣⅠ]$/, '').replace(/\(A股\)$/, '');
                if (origClean === cleanName) return id;
            }
            return undefined;
        };
        const chain: Record<string, AIRelation> = {};

        const batchSize = 20;
        let successCount = 0;

        for (let i = 0; i < allNames.length; i += batchSize) {
            const batch = allNames.slice(i, i + batchSize);
            try {
                const batchResult = await withRetry(() => aiGenerateChainBatch(batch, allNames), 2, 5000);
                for (const [name, rel] of Object.entries(batchResult)) {
                    const resolvedId = resolveIndustryId(name);
                    if (resolvedId) {
                        chain[name] = rel;
                        successCount++;
                    }
                }
            } catch (err: any) {
                console.warn(`[IndustryKG] AI批次${Math.floor(i / batchSize) + 1}失败:`, err?.message || err);
            }
        }

        // 转换为边
        const edges: KGEdge[] = [];
        const edgeSet = new Set<string>();

        for (const [industryName, rel] of Object.entries(chain)) {
            const industryId = resolveIndustryId(industryName);
            if (!industryId) continue;

            for (const upName of rel.upstream) {
                const upId = resolveIndustryId(upName);
                if (!upId || upId === industryId) continue;
                const key = `${upId}->${industryId}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    edges.push({
                        source: upId,
                        target: industryId,
                        confidence: 'ai_strong',
                        direction: 'upstream',
                    });
                }
            }

            for (const downName of rel.downstream) {
                const downId = resolveIndustryId(downName);
                if (!downId || downId === industryId) continue;
                const key = `${industryId}->${downId}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    edges.push({
                        source: industryId,
                        target: downId,
                        confidence: 'ai_strong',
                        direction: 'upstream',
                    });
                }
            }
        }

        console.log(`[IndustryKG] AI生成完成: ${successCount}个行业有关联, ${edges.length}条边`);
        writeCacheFile('ai_edges.json', edges);
        return edges;
    }

    /**
     * 双向一致性校验
     */
    private static verifyBidirectional(edges: KGEdge[], industries: KGIndustryNode[]): KGEdge[] {
        const reverseSet = new Set(edges.map(e => `${e.target}->${e.source}`));

        return edges.map(edge => {
            const forwardKey = `${edge.source}->${edge.target}`;
            if (reverseSet.has(forwardKey)) {
                return { ...edge, confidence: 'ai_weak' as const };
            }
            return { ...edge, confidence: 'ai_strong' as const };
        });
    }

    /**
     * 为每个行业加载龙头股（综合打分Top2）
     */
    private static async loadLeadingStocks(industries: KGIndustryNode[]): Promise<KGIndustryNode[]> {
        const cached = readCacheFile('industry_stocks.json');
        if (cached) {
            const stockMap = new Map<string, KGLleadingStock[]>((cached as Array<[string, KGLleadingStock[]]>));
            return industries.map(i => ({
                ...i,
                leadingStocks: stockMap.get(i.id) || [],
            }));
        }

        // 同步等待加载完成，确保缓存和内存数据一致
        console.log('[IndustryKG] 同步加载龙头股数据...');
        await this.loadLeadingStocksAsync(industries);

        // 加载完成后重新从缓存读取
        const cachedAfter = readCacheFile('industry_stocks.json');
        if (cachedAfter) {
            const stockMap = new Map<string, KGLleadingStock[]>((cachedAfter as Array<[string, KGLleadingStock[]]>));
            return industries.map(i => ({
                ...i,
                leadingStocks: stockMap.get(i.id) || [],
            }));
        }

        return industries;
    }

    /**
     * 后台异步加载龙头股（基于市值+ROE+净利润+毛利率综合打分）
     */
    private static async loadLeadingStocksAsync(industries: KGIndustryNode[]): Promise<void> {
        try {
            const stockMap = new Map<string, KGLleadingStock[]>();

            // 获取最近交易日的daily_basic（含市值），用于初步筛选
            let dailyBasicMap = new Map<string, { totalMv: number; close: number }>();
            for (let offset = 0; offset < 5; offset++) {
                const d = new Date();
                d.setDate(d.getDate() - offset);
                const dateStr = d.toISOString().slice(0, 10).replace(/-/g, '');
                try {
                    const rows = await withRetry(() => getDailyBasicByDate(dateStr), 3, 3000);
                    if (rows.length > 0) {
                        for (const row of rows) {
                            dailyBasicMap.set(row.ts_code, {
                                totalMv: row.total_mv || 0,
                                close: row.close || 0,
                            });
                        }
                        console.log(`[IndustryKG] daily_basic加载: ${rows.length}只股票 (日期${dateStr})`);
                        break;
                    }
                } catch { /* try next day */ }
            }

            // 限流间隔（毫秒）和指数退避辅助函数
            const RATE_LIMIT_MS = 600;
            const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
            const retryWithBackoff = async <T>(fn: () => Promise<T>, maxRetries: number = 3, baseDelay: number = 2000): Promise<T> => {
                for (let attempt = 0; attempt <= maxRetries; attempt++) {
                    try {
                        return await fn();
                    } catch (err: any) {
                        if (attempt === maxRetries) throw err;
                        const delay = baseDelay * Math.pow(2, attempt); // 指数退避: 2s, 4s, 8s
                        console.warn(`[IndustryKG] 请求失败，${delay}ms后重试 (${attempt + 1}/${maxRetries}): ${err?.message || err}`);
                        await sleep(delay);
                    }
                }
                throw new Error('unreachable');
            };

            // 分批获取行业成分股（ths_member限流：每批1个，间隔600ms）
            let processedCount = 0;
            console.log(`[IndustryKG] 开始加载龙头股，共${industries.length}个行业...`);
            for (const industry of industries) {
                try {
                    const tsCode = industry.id.includes('.') ? industry.id : industry.id + '.TI';
                    const members = await retryWithBackoff(() => getThsMember(tsCode));
                    const activeMembers = members.filter(m => m.is_new === 'Y');

                    if (activeMembers.length === 0) {
                        stockMap.set(industry.id, []);
                        continue;
                    }

                    // 第一步：按市值初步筛选Top 5（减少后续财务数据调用量）
                    const candidates = activeMembers
                        .map(m => ({
                            tsCode: m.con_code,
                            code6: m.con_code.replace(/\.(SZ|SH|BJ)$/, ''),
                            name: m.con_name,
                            totalMv: dailyBasicMap.get(m.con_code)?.totalMv || 0,
                        }))
                        .sort((a, b) => b.totalMv - a.totalMv)
                        .slice(0, 5);

                    // 第二步：获取Top 5的财务指标（fina_indicator只能单只获取）
                    const finaScores: Array<{
                        tsCode: string; code6: string; name: string;
                        mvScore: number; roeScore: number; profitMarginScore: number; grossMarginScore: number;
                        totalScore: number;
                    }> = [];

                    for (const c of candidates) {
                        try {
                            const fina = await retryWithBackoff(() => getFinaIndicator(c.code6), 2, 1500);
                            // 取最新一期报告
                            const latest = fina
                                .filter(r => r.roe !== null || r.grossprofit_margin !== null)
                                .sort((a, b) => b.end_date.localeCompare(a.end_date))[0];

                            finaScores.push({
                                tsCode: c.tsCode,
                                code6: c.code6,
                                name: c.name,
                                mvScore: 0, // 后续归一化
                                roeScore: latest?.roe || 0,
                                profitMarginScore: latest?.netprofit_margin || 0, // 用净利率替代净利润
                                grossMarginScore: latest?.grossprofit_margin || 0,
                                totalScore: 0,
                            });
                        } catch {
                            finaScores.push({
                                tsCode: c.tsCode, code6: c.code6, name: c.name,
                                mvScore: 0, roeScore: 0, profitMarginScore: 0, grossMarginScore: 0, totalScore: 0,
                            });
                        }
                        // fina_indicator限流：每次间隔600ms
                        await sleep(RATE_LIMIT_MS);
                    }

                    // 第三步：归一化+加权打分（不再需要单独获取income）
                    const maxMv = Math.max(...finaScores.map(f => dailyBasicMap.get(f.tsCode)?.totalMv || 0), 1);
                    const maxRoe = Math.max(...finaScores.map(f => Math.abs(f.roeScore)), 0.01);
                    const maxProfitMargin = Math.max(...finaScores.map(f => Math.abs(f.profitMarginScore)), 0.01);
                    const maxGrossMargin = Math.max(...finaScores.map(f => Math.abs(f.grossMarginScore)), 0.01);

                    for (const fs of finaScores) {
                        const mv = dailyBasicMap.get(fs.tsCode)?.totalMv || 0;
                        fs.mvScore = mv / maxMv;
                        fs.roeScore = Math.abs(fs.roeScore) / maxRoe;
                        fs.profitMarginScore = Math.abs(fs.profitMarginScore) / maxProfitMargin;
                        fs.grossMarginScore = Math.abs(fs.grossMarginScore) / maxGrossMargin;
                        // 加权：市值30% + ROE25% + 净利率25% + 毛利率20%
                        fs.totalScore = fs.mvScore * 0.3 + fs.roeScore * 0.25 + fs.profitMarginScore * 0.25 + fs.grossMarginScore * 0.2;
                    }

                    // 取Top 2
                    const top2 = finaScores
                        .sort((a, b) => b.totalScore - a.totalScore)
                        .slice(0, 2)
                        .map(f => ({ code: f.code6, name: f.name, changePct: 0 }));

                    stockMap.set(industry.id, top2);
                } catch {
                    stockMap.set(industry.id, []);
                }

                processedCount++;
                if (processedCount % 30 === 0) {
                    console.log(`[IndustryKG] 龙头股加载进度: ${processedCount}/${industries.length}`);
                }
                // ths_member限流
                await sleep(RATE_LIMIT_MS);
            }

            writeCacheFile('industry_stocks.json', Array.from(stockMap.entries()));

            if (this.fullGraph) {
                for (const industry of this.fullGraph.industries) {
                    industry.leadingStocks = stockMap.get(industry.id) || [];
                }
                writeCacheFile('full_graph.json', this.fullGraph);
            }

            console.log(`[IndustryKG] 龙头股加载完成: ${stockMap.size}个行业`);
        } catch (err: any) {
            console.warn('[IndustryKG] 龙头股加载失败:', err?.message || err);
        }
    }
}
