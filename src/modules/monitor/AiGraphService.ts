/**
 * AI产业链图谱服务 — 基于 IndustryKGService 数据源
 *
 * 核心职责：
 * 1. 从 IndustryKGService 获取概念、行业、上下游关系数据
 * 2. 将 IndustryKGService 的数据结构转换为前端 AiGraph 组件所需的 GraphData 格式
 * 3. BFS 扩展上下游行业，构建层级子图
 *
 * 数据流：IndustryKGService（Tushare + AI生成） → AiGraphService（格式转换 + BFS扩展） → 前端
 */

import { IndustryKGService, KGIndustryNode, KGConceptNode } from './IndustryKGService';

export interface GraphNode {
    id: string;
    name: string;
    type: 'concept' | 'core' | 'upstream' | 'downstream';
    level: number; // 核心=0, 上游=-1,-2,..., 下游=1,2,...
    parentIds?: string[]; // 多个父节点ID，用于支持多路径场景
    branch?: string; // 所属主链ID，用于前端树状布局分组
    branches?: string[]; // 所有所属分支，用于支持跨分支共享节点
    color: string;
}

export interface GraphEdge {
    from: string;
    to: string;
    relation: 'landing' | 'upstream' | 'downstream';
    sequence: number; // 动画播放顺序
    color: string;
}

export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
    centerConcept: {
        code: string;
        name: string;
    };
}

export interface TriggerInfo {
    type: 'concept' | 'event';
    value: string;
    detectedConcept?: string;
}

export interface GraphResponse {
    trigger: TriggerInfo;
    graph: GraphData;
}

export class AiGraphService {
    static async initialize(): Promise<void> {
        // IndustryKGService 在 index.ts 中已初始化，这里只确认可用
        try {
            IndustryKGService.getFullGraph();
            console.log('[AiGraph] 数据源就绪（IndustryKGService）');
        } catch {
            console.warn('[AiGraph] IndustryKGService 尚未初始化，AiGraph 接口可能不可用');
        }
    }

    static async getAllConcepts(): Promise<{ code: string; name: string }[]> {
        const graph = IndustryKGService.getFullGraph();
        return graph.concepts.map(c => ({ code: c.id, name: c.name }));
    }

    static async getGraphByConcept(conceptCode: string): Promise<GraphData> {
        const graph = IndustryKGService.getFullGraph();

        // 支持按 ID 或名称查找概念
        let concept = graph.concepts.find(c => c.id === conceptCode);
        if (!concept) {
            concept = graph.concepts.find(c => c.name === conceptCode);
        }
        if (!concept) {
            throw new Error(`概念 ${conceptCode} 不存在`);
        }

        const coreIndustries = concept.relatedIndustries
            .map(ri => graph.industries.find(i => i.id === ri.industryId))
            .filter((i): i is KGIndustryNode => i !== undefined);

        const coreCodes = coreIndustries.map(i => i.id);

        // 构建邻接表：从 IndustryKGService 的 edges
        const upstreamToDownstream = new Map<string, Set<string>>();
        const downstreamToUpstream = new Map<string, Set<string>>();

        for (const edge of graph.edges) {
            if (!upstreamToDownstream.has(edge.source)) {
                upstreamToDownstream.set(edge.source, new Set());
            }
            upstreamToDownstream.get(edge.source)!.add(edge.target);

            if (!downstreamToUpstream.has(edge.target)) {
                downstreamToUpstream.set(edge.target, new Set());
            }
            downstreamToUpstream.get(edge.target)!.add(edge.source);
        }

        // 1. 使用统一 BFS 从核心开始双向搜索
        const nodeInfoMap = new Map<string, {
            level: number;
            parentIds: string[];
            branch: string;
            branches: string[];
            type: 'upstream' | 'downstream' | 'core';
        }>();

        // 初始化：所有核心行业 level=0
        for (const coreCode of coreCodes) {
            nodeInfoMap.set(coreCode, {
                level: 0,
                parentIds: [concept.id],
                branch: coreCode,
                branches: [coreCode],
                type: 'core'
            });
        }

        // 使用队列进行 BFS，按 level 扩散
        const queue: Array<{ code: string; level: number; branch: string }> = [];

        // 首先添加核心的直接上游（level=-1）和直接下游（level=1）
        for (const coreCode of coreCodes) {
            // 添加直接上游
            const upstreamSet = downstreamToUpstream.get(coreCode);
            if (upstreamSet) {
                for (const upstreamCode of upstreamSet) {
                    if (!coreCodes.includes(upstreamCode)) {
                        const existing = nodeInfoMap.get(upstreamCode);
                        if (!existing) {
                            nodeInfoMap.set(upstreamCode, {
                                level: -1,
                                parentIds: [coreCode],
                                branch: coreCode,
                                branches: [coreCode],
                                type: 'upstream'
                            });
                            queue.push({ code: upstreamCode, level: -1, branch: coreCode });
                        } else if (existing.level === -1) {
                            if (!existing.parentIds.includes(coreCode)) {
                                existing.parentIds.push(coreCode);
                            }
                            if (!existing.branches.includes(coreCode)) {
                                existing.branches.push(coreCode);
                            }
                        }
                    }
                }
            }

            // 添加直接下游
            const downstreamSet = upstreamToDownstream.get(coreCode);
            if (downstreamSet) {
                for (const downstreamCode of downstreamSet) {
                    if (!coreCodes.includes(downstreamCode)) {
                        const existing = nodeInfoMap.get(downstreamCode);
                        if (!existing) {
                            nodeInfoMap.set(downstreamCode, {
                                level: 1,
                                parentIds: [coreCode],
                                branch: coreCode,
                                branches: [coreCode],
                                type: 'downstream'
                            });
                            queue.push({ code: downstreamCode, level: 1, branch: coreCode });
                        } else if (existing.level === 1) {
                            if (!existing.parentIds.includes(coreCode)) {
                                existing.parentIds.push(coreCode);
                            }
                            if (!existing.branches.includes(coreCode)) {
                                existing.branches.push(coreCode);
                            }
                        }
                    }
                }
            }
        }

        // 继续 BFS
        while (queue.length > 0) {
            const { code, level, branch } = queue.shift()!;
            const info = nodeInfoMap.get(code);
            if (!info) continue;

            if (info.type === 'upstream') {
                const upstreamSet = downstreamToUpstream.get(code);
                if (upstreamSet) {
                    for (const upstreamCode of upstreamSet) {
                        if (!coreCodes.includes(upstreamCode)) {
                            const newLevel = level - 1;
                            const existing = nodeInfoMap.get(upstreamCode);

                            if (!existing) {
                                nodeInfoMap.set(upstreamCode, {
                                    level: newLevel,
                                    parentIds: [code],
                                    branch: branch,
                                    branches: [branch],
                                    type: 'upstream'
                                });
                                queue.push({ code: upstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) < Math.abs(existing.level)) {
                                existing.level = newLevel;
                                existing.parentIds = [code];
                                existing.branch = branch;
                                existing.branches = [branch];
                                queue.push({ code: upstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) === Math.abs(existing.level)) {
                                if (!existing.parentIds.includes(code)) {
                                    existing.parentIds.push(code);
                                }
                                if (!existing.branches.includes(branch)) {
                                    existing.branches.push(branch);
                                }
                            }
                        }
                    }
                }
            } else if (info.type === 'downstream') {
                const downstreamSet = upstreamToDownstream.get(code);
                if (downstreamSet) {
                    for (const downstreamCode of downstreamSet) {
                        if (!coreCodes.includes(downstreamCode)) {
                            const newLevel = level + 1;
                            const existing = nodeInfoMap.get(downstreamCode);

                            if (!existing) {
                                nodeInfoMap.set(downstreamCode, {
                                    level: newLevel,
                                    parentIds: [code],
                                    branch: branch,
                                    branches: [branch],
                                    type: 'downstream'
                                });
                                queue.push({ code: downstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) < Math.abs(existing.level)) {
                                existing.level = newLevel;
                                existing.parentIds = [code];
                                existing.branch = branch;
                                existing.branches = [branch];
                                queue.push({ code: downstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) === Math.abs(existing.level)) {
                                if (!existing.parentIds.includes(code)) {
                                    existing.parentIds.push(code);
                                }
                                if (!existing.branches.includes(branch)) {
                                    existing.branches.push(branch);
                                }
                            }
                        }
                    }
                }
            }
        }

        // 分离上游和下游节点
        const allUpstreamNodes = new Map<string, number>();
        const upstreamParentMap = new Map<string, string[]>();
        const upstreamBranchMap = new Map<string, string>();
        const upstreamBranchesMap = new Map<string, string[]>();

        const allDownstreamNodes = new Map<string, number>();
        const downstreamParentMap = new Map<string, string[]>();
        const downstreamBranchMap = new Map<string, string>();
        const downstreamBranchesMap = new Map<string, string[]>();

        for (const [code, info] of nodeInfoMap) {
            if (info.type === 'upstream') {
                allUpstreamNodes.set(code, info.level);
                upstreamParentMap.set(code, info.parentIds);
                upstreamBranchMap.set(code, info.branch);
                upstreamBranchesMap.set(code, info.branches);
            } else if (info.type === 'downstream') {
                allDownstreamNodes.set(code, info.level);
                downstreamParentMap.set(code, info.parentIds);
                downstreamBranchMap.set(code, info.branch);
                downstreamBranchesMap.set(code, info.branches);
            }
        }

        // 行业名称查找（从 IndustryKGService 获取）
        const getIndustryName = (industryCode: string): string | undefined => {
            const industry = graph.industries.find(i => i.id === industryCode);
            return industry?.name;
        };

        // 收集所有节点
        const nodes: GraphNode[] = [];
        const addedNodeIds = new Set<string>();

        // 添加概念节点
        nodes.push({
            id: concept.id,
            name: concept.name,
            type: 'concept',
            level: 0,
            parentIds: undefined,
            branch: undefined,
            branches: undefined,
            color: '#FF4D4F'
        });
        addedNodeIds.add(concept.id);

        // 添加核心行业节点 (level = 0)
        for (const industry of coreIndustries) {
            if (!addedNodeIds.has(industry.id)) {
                const info = nodeInfoMap.get(industry.id);
                nodes.push({
                    id: industry.id,
                    name: industry.name,
                    type: 'core',
                    level: 0,
                    parentIds: [concept.id],
                    branch: industry.id,
                    branches: info ? info.branches : [industry.id],
                    color: '#1890FF'
                });
                addedNodeIds.add(industry.id);
            }
        }

        // 添加所有上游节点
        for (const [upstreamCode, level] of allUpstreamNodes) {
            const upstreamName = getIndustryName(upstreamCode) || upstreamCode;
            nodes.push({
                id: upstreamCode,
                name: upstreamName,
                type: 'upstream',
                level: level,
                parentIds: upstreamParentMap.get(upstreamCode) || [],
                branch: upstreamBranchMap.get(upstreamCode),
                branches: upstreamBranchesMap.get(upstreamCode),
                color: '#722ED1'
            });
            addedNodeIds.add(upstreamCode);
        }

        // 添加所有下游节点
        for (const [downstreamCode, level] of allDownstreamNodes) {
            const downstreamName = getIndustryName(downstreamCode) || downstreamCode;
            nodes.push({
                id: downstreamCode,
                name: downstreamName,
                type: 'downstream',
                level: level,
                parentIds: downstreamParentMap.get(downstreamCode) || [],
                branch: downstreamBranchMap.get(downstreamCode),
                branches: downstreamBranchesMap.get(downstreamCode),
                color: '#52C41A'
            });
            addedNodeIds.add(downstreamCode);
        }

        // 构建边并按层级计算 sequence（实现逐层扩散动画）
        const edges: GraphEdge[] = [];
        const addedEdgeKeys = new Set<string>();
        let sequence = 0;

        const getNodeInfo = (nodeCode: string) => {
            if (coreCodes.includes(nodeCode)) {
                return { type: 'core' as const, level: 0 };
            }
            if (allUpstreamNodes.has(nodeCode)) {
                return { type: 'upstream' as const, level: allUpstreamNodes.get(nodeCode)! };
            }
            if (allDownstreamNodes.has(nodeCode)) {
                return { type: 'downstream' as const, level: allDownstreamNodes.get(nodeCode)! };
            }
            return { type: 'concept' as const, level: 0 };
        };

        // 收集所有边并分组
        interface EdgeItem {
            from: string;
            to: string;
            relation: 'landing' | 'upstream' | 'downstream';
            level: number;
        }
        const collectedEdges: EdgeItem[] = [];

        // 1. 添加概念到核心行业的边 (level=0)
        for (const industry of coreIndustries) {
            const edgeKey = `${concept.id}->${industry.id}`;
            if (!addedEdgeKeys.has(edgeKey)) {
                collectedEdges.push({
                    from: concept.id,
                    to: industry.id,
                    relation: 'landing',
                    level: 0
                });
                addedEdgeKeys.add(edgeKey);
            }
        }

        // 2. 从 IndustryKGService 的 edges 中提取上游边和下游边
        addedEdgeKeys.clear();
        for (const edge of graph.edges) {
            const fromInfo = getNodeInfo(edge.source);
            const toInfo = getNodeInfo(edge.target);

            // 上游边：source 是 target 的上游
            if (fromInfo.type === 'upstream' && (toInfo.type === 'core' || toInfo.type === 'upstream')) {
                const edgeKey = `${edge.source}->${edge.target}`;
                if (!addedEdgeKeys.has(edgeKey)) {
                    const absFrom = Math.abs(fromInfo.level);
                    const absTo = Math.abs(toInfo.level);
                    collectedEdges.push({
                        from: edge.source,
                        to: edge.target,
                        relation: 'upstream',
                        level: Math.max(absFrom, absTo)
                    });
                    addedEdgeKeys.add(edgeKey);
                }
            }

            // 下游边：target 是 source 的下游
            if (toInfo.type === 'downstream' && (fromInfo.type === 'core' || fromInfo.type === 'upstream' || fromInfo.type === 'downstream')) {
                const edgeKey = `${edge.source}->${edge.target}`;
                if (!addedEdgeKeys.has(edgeKey)) {
                    const absFrom = Math.abs(fromInfo.level);
                    const absTo = Math.abs(toInfo.level);
                    collectedEdges.push({
                        from: edge.source,
                        to: edge.target,
                        relation: 'downstream',
                        level: Math.max(absFrom, absTo)
                    });
                    addedEdgeKeys.add(edgeKey);
                }
            }
        }

        // 按绝对距离（level）逐层排序，实现逐层扩散动画
        const maxLevel = Math.max(
            ...collectedEdges.map(e => e.level),
            allUpstreamNodes.size > 0 ? Math.abs(Math.min(...Array.from(allUpstreamNodes.values()))) : 0,
            allDownstreamNodes.size > 0 ? Math.max(...Array.from(allDownstreamNodes.values())) : 0
        );

        for (let level = 0; level <= maxLevel; level++) {
            const levelEdges = collectedEdges.filter(e => e.level === level);
            const levelUpstreamEdges = levelEdges.filter(e => e.relation === 'upstream');
            const levelLandingEdges = levelEdges.filter(e => e.relation === 'landing');
            const levelDownstreamEdges = levelEdges.filter(e => e.relation === 'downstream');

            for (const edge of levelLandingEdges) {
                edges.push({
                    from: edge.from,
                    to: edge.to,
                    relation: edge.relation,
                    sequence: sequence++,
                    color: '#FF4D4F'
                });
            }
            for (const edge of levelUpstreamEdges) {
                edges.push({
                    from: edge.from,
                    to: edge.to,
                    relation: edge.relation,
                    sequence: sequence++,
                    color: '#722ED1'
                });
            }
            for (const edge of levelDownstreamEdges) {
                edges.push({
                    from: edge.from,
                    to: edge.to,
                    relation: edge.relation,
                    sequence: sequence++,
                    color: '#52C41A'
                });
            }
        }

        const minUpstreamLevel = allUpstreamNodes.size > 0 ? Math.min(...Array.from(allUpstreamNodes.values())) : 0;
        const maxDownstreamLevel = allDownstreamNodes.size > 0 ? Math.max(...Array.from(allDownstreamNodes.values())) : 0;

        console.log(`[AiGraph] 概念: ${concept.name}, 核心行业: ${coreIndustries.length}个`);
        console.log(`[AiGraph] 上游行业: ${allUpstreamNodes.size}个 (最深${Math.abs(minUpstreamLevel)}层)`);
        console.log(`[AiGraph] 下游行业: ${allDownstreamNodes.size}个 (最深${maxDownstreamLevel}层)`);
        console.log(`[AiGraph] 总节点数: ${nodes.length}, 总边数: ${edges.length}`);

        return {
            nodes,
            edges,
            centerConcept: {
                code: concept.id,
                name: concept.name
            }
        };
    }

    static async getGraphByEvent(eventText: string): Promise<GraphResponse> {
        // 事件识别：用关键词匹配概念
        const graph = IndustryKGService.getFullGraph();
        const detectedConcepts = graph.concepts.filter(c =>
            eventText.includes(c.name) || c.name.split('').some(char => eventText.includes(char))
        );

        if (detectedConcepts.length === 0) {
            throw new Error('无法识别事件相关的概念');
        }

        // 取匹配度最高的概念（名称最长匹配）
        const bestMatch = detectedConcepts.sort((a, b) => b.name.length - a.name.length)[0];
        const graphData = await this.getGraphByConcept(bestMatch.id);

        return {
            trigger: {
                type: 'event',
                value: eventText,
                detectedConcept: bestMatch.id
            },
            graph: graphData
        };
    }
}
