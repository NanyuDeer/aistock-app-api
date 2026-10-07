/**
 * StockInfoPredictionService — 个股情报入验证环的候选聚合 + 转发
 *
 * 职责边界（spec §6.3/§6.4）：
 * - 只做两件事：① 取「当日最强口径」候选（一条批次 SQL）；② 逐个转发给 agent-py 内部端点。
 * - **不做映射**（ai_impact/ai_horizon → direction/horizon 归 agent-py）；
 * - **不算 due_dates**（到期日唯一口径在 agent-py 的 `_compute_due_dates`）；
 * - **不实现任何入环门槛**：门槛唯一实现在 agent-py 的 `meets_entry_threshold`。
 *   SQL 里的 `CASE j.ai_impact ... ORDER BY ... DESC` 只是「哪一条最有方向」的排序，
 *   不是门槛——中性候选也会被转发，由 agent-py skip（`status="skipped"` 是正常降级）。
 *   理由：同一判据两份实现会漂移，且「app-api 不转发」是静默漏入环（agent-py 永远看不到）。
 *
 * fail-safe（spec §6.4）：`ingest` 任何异常只 `console.warn`，**绝不抛**——
 * 由 Task 4 挂在 `StockInfoService.upsertJudgements` 末尾，不得阻断研判落库。
 */

import pool from '../../../core/db';
import { normalizeStockSymbol } from '../../../shared/utils/stock';

/** 透明转发上游地址（复用 internalRouter.ts 同一 env 表达式） */
const AGENT_PY_URL = process.env.AGENT_PY_URL || process.env.PYTHON_AGENT_URL || 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

export interface StockInfoCandidate {
  symbol: string;
  stock_name: string;
  published_date: string;
  ai_impact: string;
  ai_horizon: string;
  ai_summary: string;
  url: string | null;
}

/**
 * 候选聚合 SQL（spec §6.3 当日去重 / 计划 Task 3 逐字照用）。
 * - `DISTINCT ON (symbol, 上海日)` + ORDER BY 取「当日最强口径」；中性排最低档。
 * - 读 `stock_info_judgements` 而非本批次入参：跨批次（8:00 / 15:00）时才能看到先前已落库候选，
 *   保证去重规则在批次内/跨批次统一（唯一真相源）。
 */
const COLLECT_CANDIDATES_SQL = `
SELECT DISTINCT ON (j.symbol, (j.published_at AT TIME ZONE 'Asia/Shanghai')::date)
       j.symbol,
       coalesce(j.stock_name, '') AS stock_name,
       to_char((j.published_at AT TIME ZONE 'Asia/Shanghai')::date, 'YYYY-MM-DD') AS published_date,
       j.ai_impact, j.ai_horizon, coalesce(j.ai_summary, '') AS ai_summary, j.url
  FROM stock_info_judgements j
  JOIN unnest($1::text[], $2::date[]) AS p(symbol, day)
    ON j.symbol = p.symbol
   AND (j.published_at AT TIME ZONE 'Asia/Shanghai')::date = p.day
 WHERE j.published_at IS NOT NULL
 ORDER BY j.symbol,
          (j.published_at AT TIME ZONE 'Asia/Shanghai')::date,
          CASE j.ai_impact
            WHEN '重大利好' THEN 3 WHEN '重大利空' THEN 3
            WHEN '利好' THEN 2 WHEN '利空' THEN 2
            ELSE 1 END DESC,
          j.published_at DESC,
          j.id DESC
`;

/** `published_at`（带时区 ISO 串）→ 上海自然日 YYYY-MM-DD；缺失/非法返回 null */
function shanghaiDateOf(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const time = new Date(raw).getTime();
  if (Number.isNaN(time)) return null;
  return new Date(time + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/**
 * 从 rawItems 提取去重后的 (symbol, publishedDate) 集合；非法条目跳过。
 *
 * symbol 用与写库侧（StockInfoService）**同一份** `normalizeStockSymbol` 归一化：
 * DB 里存的是归一化后的裸码，若这里用严格 `/^\d{6}$/`，带前后缀的 symbol 会
 * 「写库成功、入环侧跳过」→ 静默漏入环且不告警（本设计要消灭的正是这种静默）。
 */
function extractCandidatePairs(
  rawItems: Record<string, unknown>[],
): Array<{ symbol: string; publishedDate: string }> {
  const seen = new Set<string>();
  const pairs: Array<{ symbol: string; publishedDate: string }> = [];
  for (const raw of rawItems) {
    // 归一化后可提取 6 位裸码才继续；无法提取（如 'ABC'）仍跳过、不查库不转发
    const symbol = normalizeStockSymbol(raw.symbol);
    if (!/^\d{6}$/.test(symbol)) continue;
    const publishedDate = shanghaiDateOf(raw.published_at);
    if (!publishedDate) continue;
    const key = `${symbol}|${publishedDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({ symbol, publishedDate });
  }
  return pairs;
}

/**
 * 默认转发实现：POST agent-py `from-stock-info`（转发失败只告警，不抛）。
 *
 * `skipped` 只代表"服务端未落库"，其内部可能同时是①门槛未达（预期正常）或
 * ②输入非法/③映射缺档（系统性失败信号）。agent-py 用机器可读的 `reason_code`
 * 区分这三种：仅 `below_threshold` 静默；其余（含缺失/未知 `reason_code`）一律告警
 * 并带上 symbol / reason_code / reason，避免系统性映射失败整批静默。
 */
async function defaultForward(candidate: StockInfoCandidate): Promise<void> {
  const tag = `${candidate.symbol}@${candidate.published_date}`;
  const response = await fetch(`${AGENT_PY_URL}/api/agent/internal/predictions/from-stock-info`, {
    method: 'POST',
    headers: {
      'x-internal-token': INTERNAL_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(candidate),
    signal: AbortSignal.timeout(__stockInfoPredictionDependencies.timeoutMs),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    console.warn(
      `[StockInfoPrediction] forward failed: HTTP ${response.status} ${response.statusText} (${tag})${text ? ` body=${text.slice(0, 300)}` : ''}`,
    );
    return;
  }

  let payload: { status?: unknown; reason_code?: unknown; reason?: unknown; record?: unknown };
  try {
    payload = (await response.json()) as {
      status?: unknown;
      reason_code?: unknown;
      reason?: unknown;
      record?: unknown;
    };
  } catch {
    console.warn(`[StockInfoPrediction] forward failed: invalid JSON response (${tag})`);
    return;
  }

  if (payload.status === 'skipped') {
    if (payload.reason_code === 'below_threshold') {
      // 门槛未达：正常降级，不告警
      return;
    }
    // invalid_input / unmapped_value / 缺失或未知 reason_code → 系统性失败信号，必须告警
    console.warn(
      `[StockInfoPrediction] forward skipped: symbol=${candidate.symbol} reason_code=${String(payload.reason_code)} reason=${String(payload.reason)} (${tag})`,
    );
    return;
  }
  if (payload.status === 'saved') {
    if (payload.record === null || payload.record === undefined) {
      console.warn(`[StockInfoPrediction] forward failed: saved but record is empty (${tag})`);
    }
    return;
  }
  console.warn(`[StockInfoPrediction] forward failed: unexpected status=${String(payload.status)} (${tag})`);
}

/** 测试注入点（沿用仓库 `__xxxDependencies` 模式）：query 与 forward 均可替换，避免测试打真库/真网络 */
export const __stockInfoPredictionDependencies: {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  forward: (candidate: StockInfoCandidate) => Promise<void>;
  timeoutMs: number;
} = {
  query: (text, values) => pool.query(text, values),
  forward: defaultForward,
  timeoutMs: 10_000,
};

export class StockInfoPredictionService {
  /** 取「当日最强口径」候选（一条批次 SQL，避免 N 次查询） */
  static async collectCandidates(
    pairs: Array<{ symbol: string; publishedDate: string }>,
  ): Promise<StockInfoCandidate[]> {
    if (pairs.length === 0) return [];
    const symbols = pairs.map((pair) => pair.symbol);
    const days = pairs.map((pair) => pair.publishedDate);
    const { rows } = await __stockInfoPredictionDependencies.query(COLLECT_CANDIDATES_SQL, [symbols, days]);
    return rows.map((row) => ({
      symbol: String(row.symbol ?? ''),
      stock_name: String(row.stock_name ?? ''),
      published_date: String(row.published_date ?? ''),
      ai_impact: String(row.ai_impact ?? ''),
      ai_horizon: String(row.ai_horizon ?? ''),
      ai_summary: String(row.ai_summary ?? ''),
      url: row.url === null || row.url === undefined ? null : String(row.url),
    }));
  }

  /**
   * 从本批次 rawItems 提取 (symbol, 上海自然日) → 聚合候选 → 逐个转发。
   * 全流程 fail-safe：任何异常只 `console.warn`，绝不抛（不得阻断研判落库）。
   */
  static async ingest(rawItems: Record<string, unknown>[]): Promise<void> {
    try {
      const pairs = extractCandidatePairs(rawItems);
      if (pairs.length === 0) return;

      const candidates = await StockInfoPredictionService.collectCandidates(pairs);
      for (const candidate of candidates) {
        try {
          // 不做任何门槛判定：是否入环由 agent-py 决定
          await __stockInfoPredictionDependencies.forward(candidate);
        } catch (err) {
          console.warn(
            `[StockInfoPrediction] forward failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      console.warn(
        '[StockInfoPrediction] ingest failed (fail-safe, 不阻断落库):',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}
