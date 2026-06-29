import { AiGraphDataSourceFactory, DataSourceType } from './AiGraphDataSource';

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
        await AiGraphDataSourceFactory.initialize(DataSourceType.EXCEL);
    }

    static async getAllConcepts(): Promise<{ code: string; name: string }[]> {
        const source = AiGraphDataSourceFactory.getSource();
        const concepts = await source.getAllConcepts();
        return concepts.map(c => ({ code: c.code, name: c.name }));
    }

    static async getGraphByConcept(conceptCode: string): Promise<GraphData> {
        const source = AiGraphDataSourceFactory.getSource();

        const concepts = await source.getAllConcepts();
        const concept = concepts.find(c => c.code === conceptCode);
        if (!concept) {
            throw new Error(`概念 ${conceptCode} 不存在`);
        }

        const coreIndustries = await source.getIndustriesByConcept(conceptCode);
        const coreCodes = coreIndustries.map(i => i.code);

        const allRelations = await source.getAllIndustryRelations();

        // 构建邻接表：上游 -> 下游
        const upstreamToDownstream = new Map<string, Set<string>>();
        // 构建反向邻接表：下游 -> 上游
        const downstreamToUpstream = new Map<string, Set<string>>();

        for (const rel of allRelations) {
            if (!upstreamToDownstream.has(rel.sourceCode)) {
                upstreamToDownstream.set(rel.sourceCode, new Set());
            }
            upstreamToDownstream.get(rel.sourceCode)!.add(rel.targetCode);

            if (!downstreamToUpstream.has(rel.targetCode)) {
                downstreamToUpstream.set(rel.targetCode, new Set());
            }
            downstreamToUpstream.get(rel.targetCode)!.add(rel.sourceCode);
        }

        // 1. 使用统一 BFS 从核心开始双向搜索
        const nodeInfoMap = new Map<string, {
            level: number;
            parentIds: string[];
            branch: string; // 主分支
            branches: string[]; // 所有分支
            type: 'upstream' | 'downstream' | 'core';
        }>();

        // 初始化：所有核心行业 level=0
        for (const coreCode of coreCodes) {
            nodeInfoMap.set(coreCode, {
                level: 0,
                parentIds: [concept.code],
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
                            // 新节点
                            nodeInfoMap.set(upstreamCode, {
                                level: -1,
                                parentIds: [coreCode],
                                branch: coreCode,
                                branches: [coreCode],
                                type: 'upstream'
                            });
                            queue.push({ code: upstreamCode, level: -1, branch: coreCode });
                        } else if (existing.level === -1) {
                            // 已有节点，且 level 相同，添加父节点和分支
                            if (!existing.parentIds.includes(coreCode)) {
                                existing.parentIds.push(coreCode);
                            }
                            if (!existing.branches.includes(coreCode)) {
                                existing.branches.push(coreCode);
                            }
                        }
                        // 如果已有节点的 level 绝对值更小（更近），不做处理
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
                            // 新节点
                            nodeInfoMap.set(downstreamCode, {
                                level: 1,
                                parentIds: [coreCode],
                                branch: coreCode,
                                branches: [coreCode],
                                type: 'downstream'
                            });
                            queue.push({ code: downstreamCode, level: 1, branch: coreCode });
                        } else if (existing.level === 1) {
                            // 已有节点，且 level 相同，添加父节点和分支
                            if (!existing.parentIds.includes(coreCode)) {
                                existing.parentIds.push(coreCode);
                            }
                            if (!existing.branches.includes(coreCode)) {
                                existing.branches.push(coreCode);
                            }
                        }
                        // 如果已有节点的 level 绝对值更小（更近），不做处理
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
                // 上游继续向上搜索（level 递减）
                const upstreamSet = downstreamToUpstream.get(code);
                if (upstreamSet) {
                    for (const upstreamCode of upstreamSet) {
                        if (!coreCodes.includes(upstreamCode)) {
                            const newLevel = level - 1;
                            const existing = nodeInfoMap.get(upstreamCode);

                            if (!existing) {
                                // 新节点
                                nodeInfoMap.set(upstreamCode, {
                                    level: newLevel,
                                    parentIds: [code],
                                    branch: branch,
                                    branches: [branch],
                                    type: 'upstream'
                                });
                                queue.push({ code: upstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) < Math.abs(existing.level)) {
                                // 有更近的路径，更新
                                existing.level = newLevel;
                                existing.parentIds = [code];
                                existing.branch = branch;
                                existing.branches = [branch];
                                // 重新入队以更新其下游
                                queue.push({ code: upstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) === Math.abs(existing.level)) {
                                // 同样距离的其他路径，添加父节点和分支
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
                // 下游继续向下搜索（level 递增）
                const downstreamSet = upstreamToDownstream.get(code);
                if (downstreamSet) {
                    for (const downstreamCode of downstreamSet) {
                        if (!coreCodes.includes(downstreamCode)) {
                            const newLevel = level + 1;
                            const existing = nodeInfoMap.get(downstreamCode);

                            if (!existing) {
                                // 新节点
                                nodeInfoMap.set(downstreamCode, {
                                    level: newLevel,
                                    parentIds: [code],
                                    branch: branch,
                                    branches: [branch],
                                    type: 'downstream'
                                });
                                queue.push({ code: downstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) < Math.abs(existing.level)) {
                                // 有更近的路径，更新
                                existing.level = newLevel;
                                existing.parentIds = [code];
                                existing.branch = branch;
                                existing.branches = [branch];
                                // 重新入队以更新其下游
                                queue.push({ code: downstreamCode, level: newLevel, branch: branch });
                            } else if (Math.abs(newLevel) === Math.abs(existing.level)) {
                                // 同样距离的其他路径，添加父节点和分支
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

        // 收集所有节点
        const nodes: GraphNode[] = [];
        const addedNodeIds = new Set<string>();

        // 添加概念节点
        nodes.push({
            id: concept.code,
            name: concept.name,
            type: 'concept',
            level: 0,
            parentIds: undefined, // 概念节点没有父节点
            branch: undefined, // 概念节点没有分支
            branches: undefined, // 概念节点没有分支
            color: '#FF4D4F'
        });
        addedNodeIds.add(concept.code);

        // 添加核心行业节点 (level = 0)
        for (const industry of coreIndustries) {
            if (!addedNodeIds.has(industry.code)) {
                const info = nodeInfoMap.get(industry.code);
                nodes.push({
                    id: industry.code,
                    name: industry.name,
                    type: 'core',
                    level: 0,
                    parentIds: [concept.code], // 核心行业的父节点是概念
                    branch: industry.code, // 核心节点自己的 branch 就是自己的 code
                    branches: info ? info.branches : [industry.code], // 所有分支
                    color: '#1890FF'
                });
                addedNodeIds.add(industry.code);
            }
        }

        // 添加所有上游节点
        for (const [upstreamCode, level] of allUpstreamNodes) {
            const upstreamName = source.getIndustryName(upstreamCode) || upstreamCode;
            nodes.push({
                id: upstreamCode,
                name: upstreamName,
                type: 'upstream',
                level: level,
                parentIds: upstreamParentMap.get(upstreamCode) || [], // 支持多父节点
                branch: upstreamBranchMap.get(upstreamCode), // 主分支
                branches: upstreamBranchesMap.get(upstreamCode), // 所有分支
                color: '#722ED1'
            });
            addedNodeIds.add(upstreamCode);
        }

        // 添加所有下游节点
        for (const [downstreamCode, level] of allDownstreamNodes) {
            const downstreamName = source.getIndustryName(downstreamCode) || downstreamCode;
            nodes.push({
                id: downstreamCode,
                name: downstreamName,
                type: 'downstream',
                level: level,
                parentIds: downstreamParentMap.get(downstreamCode) || [], // 支持多父节点
                branch: downstreamBranchMap.get(downstreamCode), // 主分支
                branches: downstreamBranchesMap.get(downstreamCode), // 所有分支
                color: '#52C41A'
            });
            addedNodeIds.add(downstreamCode);
        }

        // 构建边并按层级计算 sequence（实现逐层扩散动画）
        const edges: GraphEdge[] = [];
        const addedEdgeKeys = new Set<string>();
        let sequence = 0;

        // 创建一个函数来获取节点信息
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
            level: number; // 边的层级（绝对距离）
        }
        const collectedEdges: EdgeItem[] = [];

        // 1. 添加概念到核心行业的边 (level=0)
        for (const industry of coreIndustries) {
            const edgeKey = `${concept.code}->${industry.code}`;
            if (!addedEdgeKeys.has(edgeKey)) {
                collectedEdges.push({
                    from: concept.code,
                    to: industry.code,
                    relation: 'landing',
                    level: 0 // 绝对距离 0
                });
                addedEdgeKeys.add(edgeKey);
            }
        }

        // 2. 添加上游边（从上游指向核心或上游）
        for (const rel of allRelations) {
            const fromInfo = getNodeInfo(rel.sourceCode);
            const toInfo = getNodeInfo(rel.targetCode);
            
            // 只保留上游到核心或上游的边
            if (fromInfo.type === 'upstream' && (toInfo.type === 'core' || toInfo.type === 'upstream')) {
                const edgeKey = `${rel.sourceCode}->${rel.targetCode}`;
                if (!addedEdgeKeys.has(edgeKey)) {
                    // 边的 level = 绝对距离 = Math.max(Math.abs(fromInfo.level), Math.abs(toInfo.level))
                    const absFrom = Math.abs(fromInfo.level);
                    const absTo = Math.abs(toInfo.level);
                    const edgeLevel = Math.max(absFrom, absTo);
                    collectedEdges.push({
                        from: rel.sourceCode,
                        to: rel.targetCode,
                        relation: 'upstream',
                        level: edgeLevel
                    });
                    addedEdgeKeys.add(edgeKey);
                }
            }
        }

        // 3. 添加下游边（从核心或上游指向下游，以及下游指向下游）
        addedEdgeKeys.clear();
        for (const rel of allRelations) {
            const fromInfo = getNodeInfo(rel.sourceCode);
            const toInfo = getNodeInfo(rel.targetCode);
            
            // 只保留从核心/上游/下游指向下游的边
            if (toInfo.type === 'downstream' && (fromInfo.type === 'core' || fromInfo.type === 'upstream' || fromInfo.type === 'downstream')) {
                const edgeKey = `${rel.sourceCode}->${rel.targetCode}`;
                if (!addedEdgeKeys.has(edgeKey)) {
                    // 边的 level = 绝对距离 = Math.max(Math.abs(fromInfo.level), Math.abs(toInfo.level))
                    const absFrom = Math.abs(fromInfo.level);
                    const absTo = Math.abs(toInfo.level);
                    const edgeLevel = Math.max(absFrom, absTo);
                    collectedEdges.push({
                        from: rel.sourceCode,
                        to: rel.targetCode,
                        relation: 'downstream',
                        level: edgeLevel
                    });
                    addedEdgeKeys.add(edgeKey);
                }
            }
        }

        // 按绝对距离（level）逐层排序，实现逐层扩散动画
        // 0 (概念→核心) → 1 (一级上游/一级下游) → 2 (二级上游/二级下游) → ...
        const maxLevel = Math.max(
            ...collectedEdges.map(e => e.level),
            allUpstreamNodes.size > 0 ? Math.abs(Math.min(...Array.from(allUpstreamNodes.values()))) : 0,
            allDownstreamNodes.size > 0 ? Math.max(...Array.from(allDownstreamNodes.values())) : 0
        );

        for (let level = 0; level <= maxLevel; level++) {
            // 首先添加概念→核心（level=0）
            const levelEdges = collectedEdges.filter(e => e.level === level);
            
            // 对于同一 level，先添加上游边，再添加下游边
            const levelUpstreamEdges = levelEdges.filter(e => e.relation === 'upstream');
            const levelLandingEdges = levelEdges.filter(e => e.relation === 'landing');
            const levelDownstreamEdges = levelEdges.filter(e => e.relation === 'downstream');

            // 添加顺序：landing → upstream → downstream
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

        // 输出诊断信息：每个level的节点数量
        const levelCount = new Map<number, number>();
        for (const node of nodes) {
            const cnt = levelCount.get(node.level) || 0;
            levelCount.set(node.level, cnt + 1);
        }
        
        console.log('【AiGraph 诊断】每个level的节点数量:');
        const sortedLevels = Array.from(levelCount.keys()).sort((a, b) => a - b);
        for (const level of sortedLevels) {
            const levelNodes = nodes.filter(n => n.level === level);
            console.log(`  level=${level}: ${levelCount.get(level)}个节点 ${levelNodes.map(n => `${n.id}(${n.name})`).join(', ')}`);
        }
        
        // 输出父子关系（用于检查childrenMap）
        console.log('【AiGraph 诊断】父子关系（child → parents）:');
        for (const node of nodes) {
            if (node.type !== 'concept' && node.parentIds && node.parentIds.length > 0) {
                const parentNodes = nodes.filter(n => node.parentIds!.includes(n.id));
                const parentInfo = parentNodes.map(p => `${p.id}(level=${p.level})`).join(', ');
                console.log(`  ${node.id}(${node.name}, level=${node.level}) ← parents: ${parentInfo}`);
            }
        }

        console.log(`[AiGraph] 概念: ${concept.name}, 核心行业: ${coreIndustries.length}个`);
        console.log(`[AiGraph] 上游行业: ${allUpstreamNodes.size}个 (最深${Math.abs(minUpstreamLevel)}层)`);
        console.log(`[AiGraph] 下游行业: ${allDownstreamNodes.size}个 (最深${maxDownstreamLevel}层)`);
        console.log(`[AiGraph] 总节点数: ${nodes.length}, 总边数: ${edges.length}`);

        return {
            nodes,
            edges,
            centerConcept: {
                code: concept.code,
                name: concept.name
            }
        };
    }

    static async getGraphByEvent(eventText: string): Promise<GraphResponse> {
        const source = AiGraphDataSourceFactory.getSource();

        const detectedConcepts = await source.detectConceptsByEvent!(eventText);
        
        if (detectedConcepts.length === 0) {
            throw new Error('无法识别事件相关的概念');
        }

        const conceptCode = detectedConcepts[0].code;
        const graph = await this.getGraphByConcept(conceptCode);

        return {
            trigger: {
                type: 'event',
                value: eventText,
                detectedConcept: conceptCode
            },
            graph
        };
    }

    static async switchDataSource(type: DataSourceType): Promise<void> {
        await AiGraphDataSourceFactory.switchSource(type);
    }
}