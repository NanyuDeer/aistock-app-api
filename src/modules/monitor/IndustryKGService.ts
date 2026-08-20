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
import { getThsIndex, getThsMember, getDailyByDate, getDailyBasicByDate, getFinaIndicator, getIncome, ThsIndexRow } from '../quote/TushareService';
import { sessionFetch } from '../../shared/utils/httpAgent';
import { shanghaiDateYyyymmdd } from '../../shared/utils/shanghaiTime';

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

/**
 * 行业知识图谱版本号（稳定常量）。
 * 图谱重建/数据结构变更时递增；供 Agent 侧缓存边界校验（_has_verifiable_cached_graph_boundary）
 * 与审计使用——graphVersion 必须为非空字符串，否则 Agent 事件缓存永远无法复用。
 */
export const INDUSTRY_GRAPH_VERSION = '1.0.0'

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

/**
 * 专家人工修正表（权威行业上下游关系，按行业名精确匹配）。
 * 优先级高于 AI 生成结果：AI 输出与下表冲突时，以本表为准；
 * AI 生成失败时，本表作为兜底保证热门行业仍有上下游。
 * 原则：仅收录产业链关系明确的行业；上游=原材料/零部件/设备/能源供应方，下游=应用/渠道/终端；
 * 不收录并列、细分-父级、服务外包等非上下游关系。
 */
const EXPERT_INDUSTRY_RELATIONS: Record<string, AIRelation> = {
    // ===== 医药生物 =====
    '生物制品': { upstream: ['化学原料'], downstream: ['医院', '药店', '医药商业', '医疗美容', '体外诊断'] },
    '化学制药': { upstream: ['化学原料', '原料药'], downstream: ['医院', '药店', '医药商业'] },
    '中药': { upstream: ['农产品加工', '种植业与林业'], downstream: ['医院', '药店', '医药商业'] },
    '医疗器械': { upstream: ['半导体', '电子化学品', '金属制品', '塑料制品'], downstream: ['医院', '医疗服务'] },
    '原料药': { upstream: ['化学原料'], downstream: ['化学制药', '化学制剂'] },
    '化学制剂': { upstream: ['原料药', '化学原料'], downstream: ['医院', '药店', '医药商业'] },
    '医疗研发外包': { upstream: ['化学原料'], downstream: ['化学制药', '生物制品'] },
    '疫苗': { upstream: ['生物制品', '化学原料'], downstream: ['医院', '药店', '医药商业'] },
    '血液制品': { upstream: ['生物制品'], downstream: ['医院', '医药商业'] },
    '体外诊断': { upstream: ['生物制品', '电子化学品', '医疗器械'], downstream: ['医院', '医疗服务'] },
    '医疗美容': { upstream: ['生物制品', '化学制药', '医疗器械'], downstream: ['美容护理'] },
    '医疗服务': { upstream: ['医疗器械', '生物制品', '化学制药'], downstream: ['医院'] },
    '医院': { upstream: ['医疗器械', '化学制药', '生物制品'], downstream: [] },
    '药店': { upstream: ['医药商业', '化学制药', '生物制品', '中药'], downstream: [] },
    '医药商业': { upstream: ['化学制药', '生物制品', '中药'], downstream: ['药店', '医院'] },
    '医药流通': { upstream: ['化学制药', '生物制品', '中药'], downstream: ['药店', '医院'] },
    '动物保健': { upstream: ['化学原料', '生物制品'], downstream: ['养殖业', '生猪养殖', '肉鸡养殖'] },
    // ===== 金属 =====
    '贵金属': { upstream: ['工业金属'], downstream: ['饰品', '半导体', '电子化学品', '化学制品', '其他电子', '医疗器械'] },
    '工业金属': { upstream: ['冶钢原料', '金属新材料'], downstream: ['金属制品', '汽车零部件', '家电零部件', '线缆部件及其他'] },
    '小金属': { upstream: ['金属新材料'], downstream: ['金属新材料', '半导体材料', '电池'] },
    '能源金属': { upstream: ['金属新材料'], downstream: ['电池', '锂电池'] },
    '金属新材料': { upstream: ['工业金属', '小金属', '稀土'], downstream: ['半导体材料', '磁性材料', '军工装备', '其他金属新材料'] },
    '钢铁': { upstream: ['冶钢原料'], downstream: ['金属制品', '建筑装饰', '汽车零部件', '工程机械', '轨交设备'] },
    '特钢': { upstream: ['冶钢原料'], downstream: ['金属制品', '汽车零部件', '军工装备'] },
    '稀土': { upstream: ['金属新材料', '小金属'], downstream: ['磁性材料', '金属新材料'] },
    '铝': { upstream: ['工业金属', '金属新材料'], downstream: ['金属制品', '汽车零部件', '光伏设备', '家电零部件'] },
    '铜': { upstream: ['金属新材料', '工业金属'], downstream: ['线缆部件及其他', '印制电路板', '电网设备', '电机'] },
    '铅锌': { upstream: ['金属新材料'], downstream: ['电池', '金属制品'] },
    '锂': { upstream: ['金属新材料'], downstream: ['锂电池', '电池化学品'] },
    '钴': { upstream: ['金属新材料'], downstream: ['电池', '锂电池'] },
    '镍': { upstream: ['金属新材料'], downstream: ['电池', '锂电池', '钢铁'] },
    '钨': { upstream: ['金属新材料'], downstream: ['金属制品', '机床工具'] },
    '钼': { upstream: ['金属新材料'], downstream: ['钢铁', '金属制品'] },
    '磁性材料': { upstream: ['金属新材料', '稀土'], downstream: ['电机', '元件', '汽车电子电气系统'] },
    '冶钢原料': { upstream: [], downstream: ['钢铁', '特钢'] },
    // ===== 半导体/电子 =====
    '半导体': { upstream: ['半导体材料', '半导体设备', '电子化学品'], downstream: ['消费电子', '计算机设备', '通信设备', '汽车电子电气系统', '其他电子'] },
    '半导体材料': { upstream: ['电子化学品', '金属新材料'], downstream: ['半导体', '集成电路制造'] },
    '半导体设备': { upstream: ['通用设备', '自动化设备', '机床工具'], downstream: ['半导体', '集成电路制造'] },
    '集成电路制造': { upstream: ['半导体材料', '半导体设备', '电子化学品'], downstream: ['集成电路封测', '数字芯片设计', '模拟芯片设计'] },
    '集成电路封测': { upstream: ['集成电路制造'], downstream: ['半导体', '消费电子'] },
    '数字芯片设计': { upstream: ['集成电路制造', '集成电路封测'], downstream: ['消费电子', '通信设备', '计算机设备', '汽车电子电气系统'] },
    '模拟芯片设计': { upstream: ['集成电路制造', '集成电路封测'], downstream: ['消费电子', '通信设备', '汽车电子电气系统'] },
    '电子化学品': { upstream: ['化学原料'], downstream: ['半导体', '光伏设备', '集成电路制造', '面板'] },
    '印制电路板': { upstream: ['铜', '电子化学品', '玻璃玻纤'], downstream: ['通信设备', '消费电子', '计算机设备', '汽车电子电气系统'] },
    '光学光电子': { upstream: ['光学元件', '面板'], downstream: ['消费电子', '通信设备', '汽车电子电气系统'] },
    '面板': { upstream: ['玻璃玻纤', '电子化学品'], downstream: ['消费电子', '光学光电子'] },
    'LED': { upstream: ['半导体', '电子化学品'], downstream: ['光学光电子', '其他电子'] },
    '消费电子': { upstream: ['半导体', '元件', '面板', '光学光电子'], downstream: ['零售', '互联网电商'] },
    '计算机设备': { upstream: ['半导体', '元件', '印制电路板'], downstream: ['软件开发', 'IT服务', '互联网电商'] },
    '通信设备': { upstream: ['通信线缆及配套', '印制电路板', '元件'], downstream: ['电信运营商', '通信服务'] },
    '元件': { upstream: ['被动元件', '分立器件'], downstream: ['消费电子', '通信设备', '计算机设备', '汽车电子电气系统'] },
    '被动元件': { upstream: ['金属新材料', '电子化学品'], downstream: ['元件', '消费电子'] },
    '分立器件': { upstream: ['半导体'], downstream: ['元件', '消费电子', '汽车电子电气系统'] },
    // ===== 新能源 =====
    '光伏设备': { upstream: ['硅料硅片', '光伏辅材', '光伏加工设备'], downstream: ['新能源发电', '电力'] },
    '硅料硅片': { upstream: ['化学原料', '金属新材料'], downstream: ['光伏电池组件', '半导体'] },
    '光伏电池组件': { upstream: ['硅料硅片', '光伏辅材'], downstream: ['光伏设备', '新能源发电'] },
    '逆变器': { upstream: ['元件', '半导体'], downstream: ['光伏设备', '新能源发电'] },
    '光伏辅材': { upstream: ['玻璃玻纤', '金属新材料'], downstream: ['光伏电池组件', '光伏设备'] },
    '风电设备': { upstream: ['风电零部件', '金属新材料'], downstream: ['新能源发电', '电力'] },
    '风电零部件': { upstream: ['金属制品', '金属新材料'], downstream: ['风电设备'] },
    '电池': { upstream: ['锂电池', '电池化学品', '锂电专用设备', '能源金属'], downstream: ['汽车整车', '消费电子', '其他电源设备'] },
    '锂电池': { upstream: ['锂', '电池化学品', '锂电专用设备'], downstream: ['电池', '汽车整车'] },
    '电池化学品': { upstream: ['化学原料'], downstream: ['锂电池', '电池'] },
    '锂电专用设备': { upstream: ['通用设备', '自动化设备'], downstream: ['锂电池', '电池'] },
    '其他电池': { upstream: ['电池化学品'], downstream: ['电池', '消费电子'] },
    '电网设备': { upstream: ['输变电设备', '线缆部件及其他', '金属制品'], downstream: ['电力', '新能源发电'] },
    '新能源发电': { upstream: ['光伏设备', '风电设备', '光伏电池组件'], downstream: ['电力'] },
    // ===== AI/科技/军工 =====
    '软件开发': { upstream: ['计算机设备'], downstream: ['IT服务', '互联网电商', '游戏', '数字媒体'] },
    'IT服务': { upstream: ['软件开发', '计算机设备'], downstream: ['银行', '证券', '通信服务'] },
    '自动化设备': { upstream: ['通用设备', '电机', '工控设备'], downstream: ['汽车整车', '电池', '半导体', '光伏设备'] },
    '机器人': { upstream: ['自动化设备', '电机', '元件'], downstream: ['汽车整车', '消费电子', '其他专用设备'] },
    '工控设备': { upstream: ['元件', '半导体'], downstream: ['自动化设备', '机床工具'] },
    '激光设备': { upstream: ['光学元件', '半导体'], downstream: ['专用设备', '通用设备'] },
    '军工装备': { upstream: ['军工电子', '金属新材料', '航天装备'], downstream: ['航空装备', '航天装备'] },
    '军工电子': { upstream: ['半导体', '元件', '印制电路板'], downstream: ['军工装备', '航天装备', '航空装备'] },
    '航天装备': { upstream: ['军工电子', '金属新材料'], downstream: ['军工装备'] },
    '航空装备': { upstream: ['军工电子', '金属新材料'], downstream: ['军工装备', '机场航运'] },
    // ===== 汽车 =====
    '汽车整车': { upstream: ['汽车零部件', '汽车电子电气系统', '电池', '轮胎轮毂'], downstream: ['汽车服务及其他', '零售'] },
    '汽车零部件': { upstream: ['金属制品', '橡胶制品', '塑料制品', '钢铁'], downstream: ['汽车整车'] },
    '汽车电子电气系统': { upstream: ['半导体', '元件', '印制电路板'], downstream: ['汽车整车', '汽车零部件'] },
    '轮胎轮毂': { upstream: ['橡胶制品', '金属制品'], downstream: ['汽车整车', '汽车零部件'] },
    // ===== 消费 =====
    '白酒': { upstream: ['农产品加工'], downstream: ['零售', '贸易'] },
    '白酒Ⅲ': { upstream: ['农产品加工'], downstream: ['零售', '贸易'] },
    '饮料制造': { upstream: ['食品加工制造', '农产品加工'], downstream: ['零售', '贸易'] },
    '食品加工制造': { upstream: ['农产品加工', '养殖业', '种植业与林业'], downstream: ['零售', '贸易'] },
    '白色家电': { upstream: ['家电零部件', '金属制品'], downstream: ['零售', '互联网电商'] },
    '家电零部件': { upstream: ['金属制品', '电机', '塑料制品'], downstream: ['白色家电', '黑色家电'] },
    // ===== 能源/原材料/化工 =====
    '电力': { upstream: ['煤炭开采加工', '油气开采及服务', '新能源发电', '电网设备'], downstream: ['工业金属', '化学原料', '半导体', '汽车整车'] },
    '煤炭开采加工': { upstream: ['煤炭开采', '油服工程'], downstream: ['电力', '钢铁', '水泥', '煤化工'] },
    '油气开采及服务': { upstream: ['油服工程'], downstream: ['石油加工贸易', '石油加工'] },
    '石油加工贸易': { upstream: ['油气开采及服务'], downstream: ['化学原料', '化学纤维', '物流'] },
    '化学原料': { upstream: ['石油加工贸易', '煤炭开采加工'], downstream: ['化学制品', '化学制药', '生物制品', '电子化学品', '电池化学品'] },
    '化学制品': { upstream: ['化学原料'], downstream: ['塑料制品', '橡胶制品', '纺织化学用品'] },
    '水泥': { upstream: ['煤炭开采加工', '电力'], downstream: ['建筑材料', '建筑装饰', '基础建设'] },
    '玻璃玻纤': { upstream: ['纯碱', '电力'], downstream: ['建筑材料', '面板', '光伏辅材', '汽车零部件'] },
    '建筑材料': { upstream: ['水泥', '玻璃玻纤', '耐火材料'], downstream: ['建筑装饰', '基础建设', '房屋建设'] },
    '建筑装饰': { upstream: ['建筑材料', '装饰园林', '工程咨询服务'], downstream: ['房地产', '房屋建设'] },
    '工程机械': { upstream: ['钢铁', '金属制品', '电机'], downstream: ['基础建设', '房地产', '建筑装饰'] },
    '机床工具': { upstream: ['金属制品', '工控设备'], downstream: ['通用设备', '专用设备', '汽车零部件'] },
    '通用设备': { upstream: ['机床工具', '钢铁', '电机'], downstream: ['专用设备', '自动化设备', '半导体设备', '锂电专用设备'] },
    '专用设备': { upstream: ['通用设备', '钢铁'], downstream: ['光伏设备', '半导体设备', '煤炭开采加工'] },
    // ===== 纺织/化工 =====
    '化学纤维': { upstream: ['石油加工贸易'], downstream: ['纺织制造', '涤纶', '粘胶'] },
    '涤纶': { upstream: ['化学纤维', '石油加工贸易'], downstream: ['纺织制造'] },
    '粘胶': { upstream: ['化学纤维', '石油加工贸易'], downstream: ['纺织制造'] },
    '纺织制造': { upstream: ['化学纤维'], downstream: ['服装家纺', '纺织服装设备'] },
    '服装家纺': { upstream: ['纺织制造'], downstream: ['零售', '互联网电商'] },
    '造纸': { upstream: ['林业', '化学原料'], downstream: ['包装印刷', '印刷', '包装'] },
    '包装印刷': { upstream: ['造纸', '塑料制品'], downstream: ['食品加工制造', '饮料制造', '化妆品'] },
    // ===== 农/食 =====
    '种植业与林业': { upstream: [], downstream: ['农产品加工', '食品加工制造', '造纸'] },
    '农产品加工': { upstream: ['种植业与林业', '养殖业'], downstream: ['食品加工制造', '饮料制造', '中药'] },
    '养殖业': { upstream: ['畜禽饲料', '水产饲料', '动物保健'], downstream: ['农产品加工', '食品加工制造'] },
    '生猪养殖': { upstream: ['畜禽饲料', '动物保健'], downstream: ['农产品加工', '肉制品'] },
    '肉制品': { upstream: ['生猪养殖', '肉鸡养殖', '农产品加工'], downstream: ['零售', '贸易'] },
    '畜禽饲料': { upstream: ['农产品加工', '化学原料'], downstream: ['养殖业', '生猪养殖', '肉鸡养殖'] },
};

async function aiGenerateChainBatch(
    batch: string[],
    allNames: string[],
): Promise<Record<string, AIRelation>> {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) throw new Error('未配置OPENAI_API_KEY');

    let apiBase = process.env.OPENAI_API_BASE_URL || process.env.OPENAI_API_BASE || 'https://api.openai.com/v1';
    const chatUrl = apiBase.includes('/chat/completions') ? apiBase : `${apiBase}/chat/completions`;
    const model = process.env.AI_MODEL || 'gpt-4o-mini';

    const prompt = `你是一位资深A股行业分析师，熟悉同花顺行业分类体系（881xxx为二级行业，884xxx为三级细分行业）。

请为以下行业确定其上游和下游行业。

参考行业名称列表（请仅使用此列表中的名称，必须精确匹配，包括后缀如"Ⅲ"或"(A股)"）：
${allNames.join('、')}

请为以下行业确定上下游：
${batch.map((n, i) => `${i + 1}. ${n}`).join('\n')}

返回JSON格式，key为行业名称（必须与参考列表精确一致），value为{"upstream": [...], "downstream": [...]}。

规则：
1. 上游行业：该行业生产所需的原材料、零部件、设备、能源等供应方所属行业
2. 下游行业：该行业产品的应用领域、销售渠道、终端客户所属行业
3. 严禁把以下关系当作上下游：
   - 并列/同业关系（如"化学制药"与"生物制品"、"铝"与"铜"）
   - 细分与父级关系（如"疫苗"是"生物制品"的细分，"半导体材料"是"半导体"产业链细分——细分行业不要列为其父级的上下游）
   - 服务外包关系（如"医疗研发外包"是医药行业的服务商）
   - 仅因资金/概念同涨跌而相关的行业
4. 仅使用参考列表中的行业名称，必须精确匹配（包括"Ⅲ"、"(A股)"等后缀），不要省略或改写
5. 如果某行业无明确上下游，返回空数组
6. 每个行业的上下游各不超过5个
7. 只返回JSON，不要其他文字
8. 确保JSON格式完全正确，不要有多余逗号或注释

参考示例：
对于"半导体"（二级）：upstream应为["半导体材料","半导体设备","电子化学品"]；downstream应为["消费电子","计算机设备","通信设备","汽车电子电气系统"]
对于"生物制品"（二级）：upstream应为["化学原料"]；downstream应为["医院","药店","医药商业"]（"疫苗""血液制品"是其细分，不要列为上下游）`;

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
            // 修复：full_graph.json 的文件 mtime 会被 loadLeadingStocksInBackground 重写刷新，
            // 导致按 mtime 判断的 15 天 TTL 永远不触发、AI 边永不更新。
            // 改用缓存内部的 updateTime 判断真实数据年龄。
            const updateTime = typeof cached.updateTime === 'string' ? new Date(cached.updateTime).getTime() : 0;
            if (Number.isNaN(updateTime) || Date.now() - updateTime > FIFTEEN_DAYS) {
                console.log(`[IndustryKG] full_graph 数据已过期（updateTime=${cached.updateTime}，超过${FIFTEEN_DAYS / 86400000}天），强制重建图谱`);
                await this.rebuild(true);
                return;
            }

            this.fullGraph = cached;

            // 专家表修正：缓存边也统一应用专家覆盖（幂等），保证专家表行业永远正确
            // （AI 生成/缓存加载都走 applyExpertEdges，避免缓存路径绕过专家表）
            const industries = cached.industries || [];
            const fixedEdges = this.applyExpertEdges(cached.edges || [], industries);
            if (fixedEdges.length !== (cached.edges || []).length) {
                cached.edges = fixedEdges;
                cached.edgeCount = fixedEdges.length;
                writeCacheFile('full_graph.json', cached);
                console.log(`[IndustryKG] 缓存加载后应用专家修正表: ${cached.edgeCount}条边`);
            }

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
    static async rebuild(force = false): Promise<KGFullGraph> {
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
                aiEdges = await this.buildAIEdges(industries, force);
                console.log(`[IndustryKG] AI生成${aiEdges.length}条边`);
            } catch (err: any) {
                console.warn(`[IndustryKG] AI生成上下游关系失败: ${err?.message || err}，使用专家修正表兜底`);
                aiEdges = this.applyExpertEdges([], industries);
                console.log(`[IndustryKG] 专家修正表兜底: ${aiEdges.length}条边`);
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

    /**
     * 获取所有概念列表（供 /internal/graph/concepts 接口调用）
     * 包装 getAllConcepts()，异步接口便于统一 await 模式
     */
    static async getConcepts(): Promise<{ id: string; name: string; industryCount: number }[]> {
        return this.getAllConcepts();
    }

    /**
     * 根据概念获取产业链子图（供 /internal/graph/:concept 接口调用）
     * 接受概念 ID（如 885641.TI）或概念名称（如 人工智能），自动解析
     */
    static async getGraphByConcept(concept: string): Promise<KGSubGraph> {
        const graph = this.getFullGraph();
        // 先按 ID 精确匹配，再按名称匹配
        let conceptNode = graph.concepts.find(c => c.id === concept);
        if (!conceptNode) {
            conceptNode = graph.concepts.find(c => c.name === concept);
        }
        if (!conceptNode) {
            throw new Error(`概念 ${concept} 不存在`);
        }
        return this.getSubGraphByConcept(conceptNode.id);
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
    private static async buildAIEdges(industries: KGIndustryNode[], force = false): Promise<KGEdge[]> {
        if (!force) {
            const cached = readCacheFile('ai_edges.json');
            if (cached) {
                console.log(`[IndustryKG] 从缓存加载AI边: ${cached.length}条`);
                const withExpert = this.applyExpertEdges(cached, industries);
                if (withExpert.length !== cached.length) {
                    console.log(`[IndustryKG] 专家修正表覆盖后: ${withExpert.length}条边`);
                    writeCacheFile('ai_edges.json', withExpert);
                }
                return withExpert;
            }
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
        const withExpert = this.applyExpertEdges(edges, industries);
        console.log(`[IndustryKG] 专家修正后: ${withExpert.length}条边`);
        writeCacheFile('ai_edges.json', withExpert);
        return withExpert;
    }

    /**
     * 应用专家人工修正表：覆盖专家表行业的全部 AI 边，替换为权威上下游关系。
     * 幂等操作：缓存加载与重新生成统一走这里，保证专家表永远生效。
     */
    private static applyExpertEdges(edges: KGEdge[], industries: KGIndustryNode[]): KGEdge[] {
        const nameToId = new Map(industries.map(i => [i.name, i.id]));
        const coveredIds = new Set<string>();
        const expertEdges: KGEdge[] = [];
        const edgeSet = new Set<string>();

        for (const [indName, rel] of Object.entries(EXPERT_INDUSTRY_RELATIONS)) {
            const indId = nameToId.get(indName);
            if (!indId) continue;
            coveredIds.add(indId);

            for (const upName of rel.upstream) {
                const upId = nameToId.get(upName);
                if (!upId || upId === indId) continue;
                const key = `${upId}->${indId}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    expertEdges.push({ source: upId, target: indId, confidence: 'ai_strong', direction: 'upstream' });
                }
            }
            for (const downName of rel.downstream) {
                const downId = nameToId.get(downName);
                if (!downId || downId === indId) continue;
                const key = `${indId}->${downId}`;
                if (!edgeSet.has(key)) {
                    edgeSet.add(key);
                    expertEdges.push({ source: indId, target: downId, confidence: 'ai_strong', direction: 'upstream' });
                }
            }
        }

        // 移除被专家覆盖行业的所有 AI 边，替换为专家权威边
        const keptAiEdges = edges.filter(e => !coveredIds.has(e.source) && !coveredIds.has(e.target));

        // 合并去重（专家边与保留 AI 边不冲突：专家行业已被完全过滤）
        return [...expertEdges, ...keptAiEdges];
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
                const dateStr = shanghaiDateYyyymmdd(d);
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
