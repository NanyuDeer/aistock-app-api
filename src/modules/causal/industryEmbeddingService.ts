/**
 * 行业嵌入向量：生成、落库、余弦检索。
 *
 * 为什么不用 pgvector（2026-11-17 实测）：
 *   pg 镜像是 postgres:17，不含 pgvector，连 extension 都不可用。
 *   装它要重建生产库容器，风险远大于收益——我们只有 110 个行业向量，
 *   每次检索 110 次余弦在应用层是微秒级，pgvector 的 ANN 索引毫无用武之地。
 *
 * 为什么模型名要入库：
 *   不同模型的向量空间完全不通用。换了模型而旧向量还在，相似度就是垃圾，
 *   而且不会报错——只会静默给出错误的行业匹配。这是最难查的一类问题。
 */

import axios from 'axios';

import pool from '../../core/db';

/** bge-large-zh-v1.5 的输出维度。换模型必须同步改这里 + 重灌全量。 */
export const EMBEDDING_DIM = 1024;

/**
 * 当前使用的 embedding 模型。
 *
 * 可通过 EMBEDDING_MODEL 覆盖——不同中转站对同一模型的标识不同
 * （有的叫 bge-large-zh-v1.5，有的叫 BAAI/bge-large-zh-v1.5）。
 * 填错会 404，但不影响维度校验（zh / en 版都是 1024 维）。
 */
export const EMBEDDING_MODEL = process.env.EMBEDDING_MODEL || 'bge-large-zh-v1.5';

export interface IndustryVector {
    name: string;
    similarity: number;
}

export interface EmbeddingDeps {
    query: (
        sql: string,
        params: unknown[],
    ) => Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
    embed: (texts: string[]) => Promise<number[][]>;
}

/** 调 embedding 中转站生成向量（OpenAI 兼容接口）。 */
async function callEmbeddingApi(texts: string[]): Promise<number[][]> {
    const baseUrl = process.env.EMBEDDING_BASE_URL;
    const apiKey = process.env.EMBEDDING_API_KEY;
    if (!baseUrl || !apiKey) {
        throw new Error('EMBEDDING_BASE_URL / EMBEDDING_API_KEY 未配置');
    }

    // 中转站给的 baseURL 通常已含 /v1（如 https://api.102465.xyz/v1），
    // 直接拼 /v1/embeddings 会变成 /v1/v1/embeddings。两种情况都兼容。
    const root = baseUrl.replace(/\/+$/, '');
    const endpoint = root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`;

    const response = await axios.post(
        endpoint,
        { model: EMBEDDING_MODEL, input: texts },
        {
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
            timeout: 30_000,
            // 与宏观抓取同样的问题：本机环境代理会把 https 目标串成 http
            proxy: false,
        },
    );

    const data = response.data?.data;
    if (!Array.isArray(data) || data.length !== texts.length) {
        throw new Error(`embedding 返回条数不符：期望 ${texts.length}，实际 ${data?.length}`);
    }

    return data.map((item: { embedding: number[] }) => {
        if (!Array.isArray(item.embedding) || item.embedding.length !== EMBEDDING_DIM) {
            throw new Error(`embedding 维度不符：期望 ${EMBEDDING_DIM}，实际 ${item.embedding?.length}`);
        }
        return item.embedding;
    });
}

const defaultDeps: EmbeddingDeps = {
    query: (sql, params) => pool.query(sql, params),
    embed: callEmbeddingApi,
};

/** 余弦相似度。向量已归一化时等价于点积，但这里不假设归一化。 */
export function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    const len = Math.min(a.length, b.length);
    for (let i = 0; i < len; i += 1) {
        dot += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** 取出全部行业名（来自 stocks.industry，项目没有独立行业表）。 */
export async function listIndustries(deps: EmbeddingDeps = defaultDeps): Promise<string[]> {
    const result = await deps.query(
        `SELECT DISTINCT industry FROM stocks
          WHERE industry IS NOT NULL AND industry <> ''
       ORDER BY industry`,
        [],
    );
    return result.rows.map((row) => String(row.industry));
}

/** 全量重灌：行业名 → 向量 → 落库。返回写入条数。 */
export async function rebuildIndustryEmbeddings(
    batchSize = 20,
    deps: EmbeddingDeps = defaultDeps,
): Promise<number> {
    const industries = await listIndustries(deps);
    let written = 0;

    for (let i = 0; i < industries.length; i += batchSize) {
        const batch = industries.slice(i, i + batchSize);
        const vectors = await deps.embed(batch);

        for (let j = 0; j < batch.length; j += 1) {
            const result = await deps.query(
                `INSERT INTO industry_embeddings (industry_name, embedding, model, updated_at)
                 VALUES ($1, $2::double precision[], $3, NOW())
                 ON CONFLICT (industry_name) DO UPDATE SET
                     embedding  = EXCLUDED.embedding,
                     model      = EXCLUDED.model,
                     updated_at = NOW()`,
                [batch[j], vectors[j], EMBEDDING_MODEL],
            );
            written += result.rowCount ?? 0;
        }
    }
    return written;
}

/**
 * 语义检索：全表加载 → 应用层余弦 → 排序取 topN。
 *
 * 110 个向量 1024 维 ≈ 11 万次乘加，单次微秒级，无需索引。
 */
export async function semanticSearchIndustries(
    embedding: number[],
    threshold = 0.7,
    limit = 5,
    deps: EmbeddingDeps = defaultDeps,
): Promise<IndustryVector[]> {
    if (embedding.length !== EMBEDDING_DIM) {
        throw new Error(`查询向量维度不符：期望 ${EMBEDDING_DIM}，实际 ${embedding.length}`);
    }

    const result = await deps.query(
        `SELECT industry_name, embedding FROM industry_embeddings`,
        [],
    );

    const scored: IndustryVector[] = [];
    for (const row of result.rows) {
        const raw = row.embedding;
        const vector = Array.isArray(raw)
            ? (raw as number[]).map(Number)
            : String(raw).replace(/^\{|\}$/g, '').split(',').map(Number);
        const similarity = cosine(embedding, vector);
        if (similarity > threshold) {
            scored.push({ name: String(row.industry_name), similarity });
        }
    }

    return scored
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, limit)
        .map((item) => ({ name: item.name, similarity: Math.round(item.similarity * 10000) / 10000 }));
}

/** 库里的向量与当前配置的模型是否一致。不一致说明需要重灌。 */
export async function checkModelConsistency(
    deps: EmbeddingDeps = defaultDeps,
): Promise<{ total: number; mismatched: number; models: string[] }> {
    const result = await deps.query(
        `SELECT model, count(*) AS n FROM industry_embeddings GROUP BY model`,
        [],
    );
    let total = 0;
    let mismatched = 0;
    const models: string[] = [];
    for (const row of result.rows) {
        const count = Number(row.n);
        const model = String(row.model);
        models.push(model);
        total += count;
        if (model !== EMBEDDING_MODEL) mismatched += count;
    }
    return { total, mismatched, models };
}
