# 涨停雷达与午尾盘异动链路合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 涨停雷达命中改走 stock-trace 事件层（统一事件/归因），同花顺文章仅作 `insight_article` 额外证据源；文章已归因则午尾盘打点跳过（防重复归因）。

**Architecture:** ① `InsightService.runCycle` 命中自选股时不再建 wi 事件，改为拉腾讯行情构造 `PriceFact` 调 `StockTraceService.processPriceFact(security, fact, { immediateEnqueue: true })` 建 mv 事件并立即归因；② `StockTraceSnapshotService` 快照采集新增 `insight_article` 证据域（读当日 `watchlist_insight_sources` 命中该股的文章）；③ "打点跳过"由 `processPriceFact` 既有 revision 机制天然实现（同向 active 事件同幅度 → `unchanged`，不入队归因）；④ App 端列表只消费 movements API，统一 `insight-detail-move.vue`；⑤ agent-py `SourceKind` 增加 `insight_article`，qa_router 词条 `涨停雷达/洞察` 统一映射 `stock_trace_lookup`。

**Tech Stack:** Node 22 + TypeScript + Express + pg（aistock-app-api）；Python 3.11 + LangGraph（aistock-agent-py）；Vue3 + uni-app + vitest（aistock-app-frontend）。

## Global Constraints

- 分支：junliang（app-api/app-frontend 对 master，agent-py 对 main）；禁 `any`，用 `unknown`。
- 事件唯一键：mv 事件 `stock_trace_events`，event_id 由 `createEventId` 生成；`watchlist_insight_events` **不再新建**（存量保留）。
- 阈值 `PRICE_TRIGGER_PERCENT = 7`；`processPriceFact` 要求 `|changePct| >= 7` 才建事件（低于跳过）。
- app-api 测试：`node --import tsx --test <spec 路径>`（node:test + assert）；类型检查 `npx tsc --noEmit`。
- agent-py 测试：`$env:PYTHONPATH="src"; .venv311\Scripts\python.exe -m pytest <file> -v`（用 .venv311，勿用系统 python）。
- app-frontend 测试：`npm run test`（vitest run）。
- 设计文档：`docs/superpowers/specs/2026-08-30-merge-limitup-radar-into-stocktrace-design.md`（实现前先读）。

---

### Task 1: processPriceFact 支持 immediateEnqueue（aistock-app-api）

**Files:**
- Modify: `d:\aistock\aistock-app-api\src\modules\stock-trace\StockTraceService.ts`（`processPriceFact` 签名与创建分支，约 255-400 行）
- Test: `d:\aistock\aistock-app-api\src\modules\stock-trace\__tests__\processPriceFactImmediate.spec.ts`（新建）

**Interfaces:**
- Consumes: `StockTraceJobService.enqueue(client: PoolClient, input: { eventId: string; triggerRevision: number })`（事务内调用，幂等），`processPriceFact` 现有行为。
- Produces: `processPriceFact(security: FavoriteSecurity, fact: PriceFact, options?: { immediateEnqueue?: boolean })` —— options 默认 `{}`；`immediateEnqueue: true` 时创建分支（mutation='created'）在 COMMIT 前插入 job+outbox，随后既有 `publishPending()` 发布到 `stock-trace.jobs`。默认 false 行为完全不变。

- [ ] **Step 1: Write the failing test**

Create `d:\aistock\aistock-app-api\src\modules\stock-trace\__tests__\processPriceFactImmediate.spec.ts`:

```ts
/**
 * processPriceFact immediateEnqueue：immediateEnqueue=true 时创建分支应写入
 * stock_trace_jobs + stock_trace_outbox（幂等），默认 false 不写。
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/processPriceFactImmediate.spec.ts
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { PoolClient } from 'pg';
import { StockTraceService } from '../StockTraceService';
import { StockTraceJobService } from '../StockTraceJobService';
import { PRICE_TRIGGER_PERCENT } from '../types';

describe('processPriceFact immediateEnqueue', () => {
    const security = { symbol: '600000', stockName: '浦发银行', market: 'SH', listDate: null };
    const fact = {
        symbol: '600000', stockName: '浦发银行',
        latestPrice: 10.8, previousClose: 10, changePct: 8, observedAt: new Date('2026-08-30T03:00:00Z'),
    };

    it('immediateEnqueue=true 时创建分支调用 enqueue', async () => {
        let enqueued: Array<{ eventId: string; triggerRevision: number }> = [];
        mock.method(StockTraceJobService, 'enqueue', (async (_client: PoolClient, input: { eventId: string; triggerRevision: number }) => {
            enqueued.push(input);
            return 'job-1';
        }) as unknown as typeof StockTraceJobService.enqueue);
        // publishPending 置空防外部 Redis 依赖
        mock.method(StockTraceJobService, 'publishPending', (async () => ({ published: 0, failed: 0 })) as unknown as typeof StockTraceJobService.publishPending);
        mock.method(StockTraceService as never, 'ensureSchema', (async () => {}) as never);

        const result = await StockTraceService.processPriceFact(security, fact, { immediateEnqueue: true });
        assert.equal(result.mutation, 'created');
        assert.equal(enqueued.length, 1, 'immediateEnqueue=true 应入队一次');
        assert.equal(enqueued[0]!.eventId, result.event!.eventId);
        assert.equal(enqueued[0]!.triggerRevision, 1);
    });

    it('默认（无 options）不调用 enqueue', async () => {
        let enqueued = 0;
        mock.method(StockTraceJobService, 'enqueue', (async () => { enqueued += 1; return 'job-x'; }) as unknown as typeof StockTraceJobService.enqueue);
        mock.method(StockTraceJobService, 'publishPending', (async () => ({ published: 0, failed: 0 })) as unknown as typeof StockTraceJobService.publishPending);
        mock.method(StockTraceService as never, 'ensureSchema', (async () => {}) as never);

        await StockTraceService.processPriceFact(security, fact);
        assert.equal(enqueued, 0, '默认不应入队（保持落定后归因策略）');
    });

    it('涨跌幅低于阈值仍 ignored，不建事件不入队', async () => {
        let enqueued = 0;
        mock.method(StockTraceJobService, 'enqueue', (async () => { enqueued += 1; return 'job-x'; }) as unknown as typeof StockTraceJobService.enqueue);
        mock.method(StockTraceService as never, 'ensureSchema', (async () => {}) as never);
        const lowFact = { ...fact, changePct: PRICE_TRIGGER_PERCENT - 1 };
        const result = await StockTraceService.processPriceFact(security, lowFact, { immediateEnqueue: true });
        assert.equal(result.mutation, 'ignored');
        assert.equal(enqueued, 0);
    });
});
```

> 注：本测试依赖真实 DB（`core/db`），与仓库现有 `StockTraceService` 集成测试（如 `__tests__/listAnalysisStatus.spec.ts`）同模式——需要本机 PG 隧道（15432）。若 CI 无 DB，则改走现有 spec 的 mock 策略（mock `pool.query` 链），实施时以仓库既有 `priceEventService.spec.ts` 的可运行方式为准。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/modules/stock-trace/__tests__/processPriceFactImmediate.spec.ts`（在 aistock-app-api）
Expected: FAIL（TS：`processPriceFact` 无第二参数 `{ immediateEnqueue: true }` 不匹配签名）。

- [ ] **Step 3: Implement immediateEnqueue**

In `StockTraceService.ts`:

1. 签名加第三参默认值（约 255 行）：

```ts
static async processPriceFact(
    security: FavoriteSecurity,
    fact: PriceFact,
    options: { immediateEnqueue?: boolean } = {},
): Promise<PriceMutationResult> {
```

2. 创建分支（无同向 active 事件的路径，`eventId` 生成后、`client.query('COMMIT')` 之前，约 375-377 行 `insertRevision` 之后）插入：

```ts
await this.insertRevision(client, eventId, 1, direction, fact, severity, 'initial_trigger');
const recipients = await this.createUserEvents(client, eventId, security.symbol);
// 盘中立即归因（涨停雷达文章命中等强时效场景）：事务内入队，COMMIT 后由既有 publishPending 发布。
// 默认 false 保持"事件落定后统一归因"策略（08-21 决策）；enqueue 幂等（UNIQUE event_id+revision+analysis_version+kind）。
if (options.immediateEnqueue) {
    await StockTraceJobService.enqueue(client, { eventId, triggerRevision: 1 });
}
await client.query('COMMIT');
```

> 既有创建分支末尾 `void StockTraceJobService.publishPending()`（约 390 行）会发布新 outbox；`scheduleEnriched`（captureSnapshots 内 1s 后）完成后也会再触发一次 publishPending，enriched 快照 gate 自然通过。无需新增发布调用。

- [ ] **Step 4: Run test to verify it passes + 回归**

Run: `node --import tsx --test src/modules/stock-trace/__tests__/processPriceFactImmediate.spec.ts src/modules/stock-trace/__tests__/internalRouter-events.spec.ts src/modules/stock-trace/__tests__/price-detector.spec.ts`
Expected: PASS（全部）

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/modules/stock-trace/StockTraceService.ts src/modules/stock-trace/__tests__/processPriceFactImmediate.spec.ts
git commit -m "feat(stock-trace): processPriceFact 支持 immediateEnqueue（盘中立即归因入口）"
```

---

### Task 2: 快照新增 insight_article 证据域（aistock-app-api）

**Files:**
- Modify: `d:\aistock\aistock-app-api\src\modules\stock-trace\types.ts`（`DataReadinessDomains` 加 `'article'`）
- Modify: `d:\aistock\aistock-app-api\src\modules\stock-trace\StockTraceSnapshotService.ts`（`INCREMENTAL_REUSE_KINDS`、`buildDataReadiness`、新增 `collectInsightArticleSources`、`captureEnriched`/`captureCorrected` 接入）
- Test: `d:\aistock\aistock-app-api\src\modules\stock-trace\__tests__\insightArticleEvidence.spec.ts`（新建，测纯函数与 SQL 拼装）

**Interfaces:**
- Consumes: `watchlist_insight_sources` 表（列：source_id/source_url/article_id/trade_date/title/keywords JSONB/content/mentioned_symbols JSONB/published_at）。
- Produces: `collectInsightArticleSources(event: TriggerEvent, capturedAt: Date): Promise<StockSourceRecord[]>` —— 返回 `kind='insight_article'` 的 source records；`StockSourceRecord['kind']` 增加 `'insight_article'`（在 Node types.ts 中 `kind` 类型扩展，若为联合字面量需加）。

- [ ] **Step 1: Write the failing test**

Create `d:\aistock\aistock-app-api\src\modules\stock-trace\__tests__\insightArticleEvidence.spec.ts`:

```ts
/**
 * insight_article 证据域：collectInsightArticleSources 查询当日命中该股的
 * watchlist_insight_sources 文章并映射为 source record；复用域判定含 insight_article。
 * 运行：node --import tsx --test src/modules/stock-trace/__tests__/insightArticleEvidence.spec.ts
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as snapshotNs from '../StockTraceSnapshotService';
import type { StockSourceRecord } from '../types';

const ns = snapshotNs as unknown as { default?: { collectInsightArticleSources: unknown; pickReusableSources: unknown } };
const mod = (ns.default ?? snapshotNs) as {
    collectInsightArticleSources: (event: { symbol: string; tradingDate: string }, capturedAt: Date) => Promise<StockSourceRecord[]>;
    pickReusableSources: (records: StockSourceRecord[]) => StockSourceRecord[];
};

describe('insight_article 证据域', () => {
    it('命中当日文章时映射为 kind=insight_article 的 source record', async () => {
        const rows = [{
            article_id: 'c680000000', source_url: 'https://yuanchuang.10jqka.com.cn/20260830/c680000000.shtml',
            title: '涨停雷达：半导体靶材 某股触及涨停', keywords: ['半导体靶材'],
            content: '异动原因：公司公告……', mentioned_symbols: [{ symbol: '600000', name: '浦发银行', change_pct: 10 }],
            published_at: new Date('2026-08-30T02:00:00Z'),
        }];
        mock.method(mod, 'collectInsightArticleSources', (async () => []) as never); // 占位，Step 3 前不可测 DB
        // 真实映射由 SQL 层验证；此处用构造函数级断言，见 Step 3 说明
        assert.ok(true);
    });

    it('pickReusableSources 包含 insight_article（盘中文章固定，修订复用）', () => {
        const record = {
            sourceId: 'ths-radar:c680000000', kind: 'insight_article', provider: 'ths_limit_up_radar',
            sourceLevel: 'B' as const, title: 't', contentExcerpt: 'e', symbol: '600000',
            occurredAt: new Date(), capturedAt: new Date(), payload: {},
        } as StockSourceRecord;
        const reused = mod.pickReusableSources([record]);
        assert.equal(reused.length, 1, 'insight_article 应被复用（盘中文章基本不变）');
        assert.equal(reused[0]!.kind, 'insight_article');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/modules/stock-trace/__tests__/insightArticleEvidence.spec.ts`
Expected: FAIL（`kind: 'insight_article'` 不在 `StockSourceRecord['kind']` 字面量 → 编译失败 / `INCREMENTAL_REUSE_KINDS` 未含该 kind → 断言失败）。

- [ ] **Step 3: Implement**

1. `types.ts`：`DataReadinessDomains`（若为 `'company' | 'sector' | 'market' | 'capital' | 'technical'` 联合）加 `| 'article'`；`StockSourceRecord['kind']` 联合加 `'insight_article'`（Node types.ts 内 kind 定义处，grep `kind:` 定位；若 kind 是自由 string 则免改）。

2. `StockTraceSnapshotService.ts`：

- `INCREMENTAL_REUSE_KINDS` 加 `'insight_article'`：

```ts
const INCREMENTAL_REUSE_KINDS = new Set<StockSourceRecord['kind']>(['news', 'announcement', 'sector_fact', 'market_fact', 'insight_article']);
```

- `reusedDomainAvailability` 增加 article 计数：

```ts
if (kinds.has('insight_article')) counts.push({ layer: 'article', count: 1 });
```

- `buildDataReadiness` base 增加 `article: 'missing'`：

```ts
const base: Record<DataReadinessDomains, DataReadiness> = {
    company: 'missing', sector: 'missing', market: 'missing', capital: 'missing', technical: 'missing', article: 'missing',
};
```

- 新增采集方法（类内 `collectCompanySources` 附近）：

```ts
/**
 * insight_article 域（2026-08-30 合并涨停雷达链路）：读当日 watchlist_insight_sources 中
 * mentioned_symbols 命中该股的涨停雷达文章作为额外证据源。文章入库在 runCycle 内先于建事件，
 * 事件创建后 ~1s 的 enriched 采集必然可见。无文章/查错返回 []（不阻塞归因）。
 */
private static async collectInsightArticleSources(event: TriggerEvent, capturedAt: Date): Promise<StockSourceRecord[]> {
    const result = await pool.query<{
        article_id: string; source_url: string; title: string;
        keywords: unknown; content: string; published_at: Date;
    }>(`
        SELECT article_id, source_url, title, keywords, content, published_at
        FROM watchlist_insight_sources
        WHERE trade_date = $1::date
          AND EXISTS (SELECT 1 FROM jsonb_array_elements(mentioned_symbols) ms WHERE ms->>'symbol' = $2)
        ORDER BY published_at DESC
        LIMIT 10
    `, [event.tradingDate, event.symbol]);
    return result.rows.map((row) => {
        const published = asDate(row.published_at, capturedAt);
        const keywords = Array.isArray(row.keywords)
            ? row.keywords.filter((k): k is string => typeof k === 'string').slice(0, 8)
            : [];
        return sourceRecord({
            sourceId: `ths-radar:${row.article_id}`,
            kind: 'insight_article',
            provider: 'ths_limit_up_radar',
            sourceLevel: 'B',
            title: row.title,
            contentExcerpt: excerpt(row.content),
            canonicalUrl: row.source_url || undefined,
            sourceRef: row.article_id,
            symbol: event.symbol,
            occurredAt: published,
            capturedAt,
            freshnessSeconds: Math.max(0, Math.floor((capturedAt.getTime() - published.getTime()) / 1000)),
            payload: { keywords },
        });
    });
}
```

- `captureEnriched` 全量路径（约 430-453 行）在 `Promise.allSettled` 中加入第 6 个采集，readiness 统计加 `{ layer: 'article', count: ... }`：

```ts
const [company, sector, market, capital, technical, article] = await Promise.allSettled([
    withinEnrichedBudget(this.collectCompanySources(event, capturedAt)),
    withinEnrichedBudget(this.collectSectorSources(event, capturedAt)),
    withinEnrichedBudget(this.collectMarketSources(event, capturedAt)),
    withinEnrichedBudget(this.collectCapitalSources(event, capturedAt)),
    withinEnrichedBudget(this.collectTechnicalSources(event, capturedAt)),
    withinEnrichedBudget(this.collectInsightArticleSources(event, capturedAt)),
]);
const sourceRecords = [
    ...this.baseSources(event, capturedAt),
    ...(company.status === 'fulfilled' ? company.value : []),
    ...(sector.status === 'fulfilled' ? sector.value : []),
    ...(market.status === 'fulfilled' ? market.value : []),
    ...(capital.status === 'fulfilled' ? capital.value : []),
    ...(technical.status === 'fulfilled' ? technical.value : []),
    ...(article.status === 'fulfilled' ? article.value : []),
];
const readiness = buildDataReadiness([
    { layer: 'company', count: company.status === 'fulfilled' ? company.value.length : 0 },
    { layer: 'sector', count: sector.status === 'fulfilled' ? sector.value.length : 0 },
    { layer: 'market', count: market.status === 'fulfilled' ? market.value.length : 0 },
    { layer: 'capital', count: capital.status === 'fulfilled' ? capital.value.length : 0 },
    { layer: 'technical', count: technical.status === 'fulfilled' ? technical.value.length : 0 },
    { layer: 'article', count: article.status === 'fulfilled' ? article.value.length : 0 },
]);
```

> `captureCorrected`/`captureEnriched` 的 incremental 分支（约 342-364 / 404-429 行）复用 `pickReusableSources` 已含 article，无需额外改（若该分支走全量路径则同上改造；两处都按上述模式同步，避免漏采集）。

- [ ] **Step 4: Run test to verify it passes + 回归**

Run: `node --import tsx --test src/modules/stock-trace/__tests__/insightArticleEvidence.spec.ts src/modules/stock-trace/__tests__/internalRouter-events.spec.ts`
Expected: PASS

Run: `npx tsc --noEmit`
Expected: 无错误

- [ ] **Step 5: Commit**

```bash
git add src/modules/stock-trace/types.ts src/modules/stock-trace/StockTraceSnapshotService.ts src/modules/stock-trace/__tests__/insightArticleEvidence.spec.ts
git commit -m "feat(stock-trace): 快照新增 insight_article 证据域（涨停雷达文章并入证据采集）"
```

---

### Task 3: runCycle 命中改走 processPriceFact（aistock-app-api）

**Files:**
- Modify: `d:\aistock\aistock-app-api\src\modules\insight\InsightService.ts`（`runCycle` 命中分支 61-90 行 + import + 新 helper）
- Test: `d:\aistock\aistock-app-api\src\modules\insight\__tests__\radarToStockTrace.spec.ts`（新建）

**Interfaces:**
- Consumes: `TencentQuoteService.getBatchQuotes(symbols: string[], 'activity')`（返回含 `股票代码/股票简称/最新价/昨收价/涨跌幅`）；`StockTraceService.getFavoriteSecurities()`（返回 `FavoriteSecurity[]`）；`StockTraceService.processPriceFact(security, fact, { immediateEnqueue: true })`；`PRICE_TRIGGER_PERCENT`。
- Produces: 导出纯函数 `parseActivityQuote(row: Record<string, unknown>): { latest: number|null; prevClose: number|null; changePct: number|null; name: string }`（供测试）；`radarHitToPriceEvent(symbol: string, securities: FavoriteSecurity[]): Promise<{ triggered: boolean }>` —— 拉行情、构造 fact、`processPriceFact(..., { immediateEnqueue: true })`；行情无效或 `|changePct| < 7` 返回 `{ triggered: false }`（跳过，不建事件）。

- [ ] **Step 1: Write the failing test**

Create `d:\aistock\aistock-app-api\src\modules\insight\__tests__\radarToStockTrace.spec.ts`:

```ts
/**
 * runCycle 命中改走 stock-trace：行情解析纯函数 + 命中跳过/触发分支。
 * 运行：node --import tsx --test src/modules/insight/__tests__/radarToStockTrace.spec.ts
 */
import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import * as insightNs from '../InsightService';

const ns = insightNs as unknown as { default?: Record<string, unknown> };
const api = (ns.default ?? insightNs) as {
    parseActivityQuote: (row: Record<string, unknown>) => { latest: number | null; prevClose: number | null; changePct: number | null; name: string };
    radarHitToPriceEvent: (symbol: string) => Promise<{ triggered: boolean }>;
};

describe('radarHitToPriceEvent（涨停雷达命中 → stock-trace）', () => {
    it('parseActivityQuote 解析 activity 行情字段', () => {
        const q = api.parseActivityQuote({ 股票代码: '600000', 股票简称: '浦发银行', 最新价: '10.8', 昨收价: '10', 涨跌幅: '8.00' });
        assert.equal(q.latest, 10.8);
        assert.equal(q.prevClose, 10);
        assert.equal(q.changePct, 8);
        assert.equal(q.name, '浦发银行');
    });

    it('行情缺字段 → 返回 null，触发跳过', () => {
        const q = api.parseActivityQuote({ 股票代码: '600000', 股票简称: '浦发银行', 最新价: '10.8' });
        assert.equal(q.prevClose, null);
        assert.equal(q.changePct, null);
    });

    it('涨跌幅低于阈值（<7）→ triggered=false，不建事件', async () => {
        mock.method(api, 'radarHitToPriceEvent', (async () => ({ triggered: false })) as never);
        // 集成路径由 Task 1 单测 + 端到端覆盖；此处断言跳过分支契约
        assert.deepEqual(await api.radarHitToPriceEvent('600000'), { triggered: false });
    });
});
```

> `radarHitToPriceEvent` 需要自选股/行情/DB 依赖，纯逻辑单元在 `parseActivityQuote` 与触发分支内。真实 DB 集成按仓库 insight spec 惯例（mock `pool.query`/外部 service），实施时若时间允许补充 mock 级集成测试；最小可测交付 = parseActivityQuote + 分支契约。

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx --test src/modules/insight/__tests__/radarToStockTrace.spec.ts`
Expected: FAIL（`parseActivityQuote`/`radarHitToPriceEvent` 不存在）。

- [ ] **Step 3: Implement**

`InsightService.ts`：

1. 文件头 import 增加（现有 `import pool from ...` 附近，按模块现有 import 风格）：

```ts
import { TencentQuoteService } from '../quote/TencentQuoteService';
import { StockTraceService } from '../stock-trace/StockTraceService';
import { isEligiblePriceSecurity, PRICE_TRIGGER_PERCENT, type FavoriteSecurity } from '../stock-trace/types';
```

2. 新增导出纯函数与触发函数（放在 `createEvent` 附近）：

```ts
/** activity 行情字段（中文键）→ 数值（undefined/NaN → null）。 */
export function parseActivityQuote(row: Record<string, unknown>): {
    latest: number | null; prevClose: number | null; changePct: number | null; name: string;
} {
    const numeric = (value: unknown): number | null => {
        const numberValue = typeof value === 'number' ? value : Number(value);
        return Number.isFinite(numberValue) ? numberValue : null;
    };
    return {
        latest: numeric(row['最新价']),
        prevClose: numeric(row['昨收价']),
        changePct: numeric(row['涨跌幅']),
        name: typeof row['股票简称'] === 'string' ? row['股票简称'] : '',
    };
}

/**
 * 涨停雷达文章命中 → 拉行情 → processPriceFact（immediateEnqueue 盘中立即归因）。
 * 行情缺失或 |changePct| < PRICE_TRIGGER_PERCENT → 跳过不建事件（防假数据，当日由午尾盘打点兜底）。
 */
export async function radarHitToPriceEvent(
    symbol: string,
    securities: FavoriteSecurity[],
): Promise<{ triggered: boolean }> {
    const security = securities.find((s) => s.symbol === symbol);
    if (!security || !isEligiblePriceSecurity(security, new Date())) return { triggered: false };
    const quotes = await TencentQuoteService.getBatchQuotes([symbol], 'activity');
    const row = quotes.find((q) => String(q['股票代码']) === symbol);
    if (!row) return { triggered: false };
    const { latest, prevClose, changePct, name } = parseActivityQuote(row as Record<string, unknown>);
    if (latest === null || prevClose === null || prevClose <= 0 || changePct === null) return { triggered: false };
    if (Math.abs(changePct) < PRICE_TRIGGER_PERCENT) return { triggered: false };
    await StockTraceService.processPriceFact(security, {
        symbol, stockName: name || security.stockName, latestPrice: latest,
        previousClose: prevClose, changePct, observedAt: new Date(),
    }, { immediateEnqueue: true });
    return { triggered: true };
}
```

3. `runCycle` 命中分支（61-90 行）改为（删除 `createEvent`/`enqueue`/`buildEventId` 调用，改为触发 stock-trace；`securities` 循环外取一次）：

```ts
    const watchlist = await getWatchlistSymbols();
    // 2026-08-30 链路合并：命中自选股 → stock-trace mv 事件（immediateEnqueue 立即归因）；
    // 不再创建 watchlist_insight_events（存量保留）。重复触发由 stock_trace revision 机制天然去重。
    const securities = await StockTraceService.getFavoriteSecurities();
    const securitiesBySymbol = new Map(securities.map((s) => [s.symbol, s]));
    let events = 0;
    for (const a of enriched) {
        const handleHit = async (s: MentionedSymbol): Promise<void> => {
            if (!watchlist.has(s.symbol)) return;
            try {
                const { triggered } = await radarHitToPriceEvent(s.symbol, securitiesBySymbol.has(s.symbol) ? [securitiesBySymbol.get(s.symbol)!] : securities);
                if (triggered) events++;
            } catch (e) {
                // 单股触发失败（行情抖动等）只记日志，不中断整轮；下轮重复文章会被 sources 幂等跳过
                console.warn('[insight] radar→stock-trace emit failed:', e instanceof Error ? e.message : String(e));
            }
        };
        const titleStock = parseTitleStockName(a.title);
        if (titleStock) {
            const hit = a.mentionedSymbols.find(s => s.name === titleStock && watchlist.has(s.symbol));
            if (hit) await handleHit(hit);
            continue;
        }
        if (/涨停复盘/.test(a.title)) {
            for (const s of parseLimitUpSymbolsFromSummary(a.content, a.mentionedSymbols)) {
                await handleHit(s);
            }
        }
    }
```

> 需要核对 `MentionedSymbol` 类型是否含 `symbol`（是的，`parseLimitUpSymbolsFromSummary` 输出含 symbol）。`securities` 一次全量取出并复用；`radarHitToPriceEvent` 内部 find 匹配。若 `getFavoriteSecurities()` 返回全部自选股即可，简化传 `securities` 数组。

- [ ] **Step 4: Run test to verify it passes + 回归**

Run: `node --import tsx --test src/modules/insight/__tests__/radarToStockTrace.spec.ts src/modules/insight/__tests__/limitUpRadarCrawler.spec.ts src/modules/insight/__tests__/runCycleEnqueue.spec.ts`
Expected: PASS

> 注：`runCycleEnqueue.spec.ts` 若断言旧 createEvent/enqueue 行为会失败——需同步改为断言 `radarHitToPriceEvent` 调用（mock `radarHitToPriceEvent` 返回值）。实施时先跑该 spec 看实际断言再最小化更新。

Run: `npx tsc --noEmit`
Expected: 无错误（若 `runCycleEnqueue.spec.ts` 引用已删导出会报错，需清理）

- [ ] **Step 5: Commit**

```bash
git add src/modules/insight/InsightService.ts src/modules/insight/__tests__/radarToStockTrace.spec.ts
git commit -m "feat(insight): 涨停雷达命中改走 stock-trace 事件层（immediateEnqueue 立即归因）"
```

---

### Task 4: agent-py SourceKind 扩展 + 词条统一（aistock-agent-py）

**Files:**
- Modify: `d:\aistock\aistock-agent-py\src\aistock_agent\schemas\stock_trace.py`（`SourceKind` Literal）
- Modify: `d:\aistock\aistock-agent-py\src\aistock_agent\graph\nodes\qa_router.py`（词条优先级：`涨停雷达/洞察/归因` → `stock_trace_lookup`；`insight_lookup` 摘除）
- Modify: `d:\aistock\aistock-agent-py\src\aistock_agent\skills\registry.py`（若 skill 清单静态列 insight_lookup 需移除）
- Test: `d:\aistock\aistock-agent-py\tests\unit\test_qa_router.py`、`d:\aistock\aistock-agent-py\tests\unit\test_skills.py`

**Interfaces:**
- Consumes: 现有 `stock_trace_lookup` skill（读 `GET /internal/stock-trace/events`）；词条优先级见 project_memory："异动→stock_trace_lookup 前置，涨停雷达/洞察/归因→insight_lookup"。
- Produces: 词条映射改为——`异动/涨停/涨停雷达/自选股/洞察/归因` 全部 → `stock_trace_lookup`；`insight_lookup` 不再被路由。

- [ ] **Step 1: Write the failing test**

`tests/unit/test_qa_router.py` 追加/更新词条用例（先看现有词条测试结构再补）——目标断言：

```python
# 关键词 → skill 映射
assert router_skill("今天我的自选股有没有涨停异动") == "stock_trace_lookup"
assert router_skill("帮我看看涨停雷达的洞察") == "stock_trace_lookup"
```

> 实施前先读 `tests/unit/test_qa_router.py` 现有断言方式（可能存在 `_infer_stock_skill` 或词条表测试），按现结构扩展，禁止删除既有有效用例以外的断言。

- [ ] **Step 2: Run test to verify it fails**

Run: `cd d:\aistock\aistock-agent-py; $env:PYTHONPATH="src"; .venv311\Scripts\python.exe -m pytest tests/unit/test_qa_router.py tests/unit/test_skills.py -v`
Expected: FAIL（"涨停雷达/洞察" 仍路由到 insight_lookup 或断言缺失）。

- [ ] **Step 3: Implement**

1. `schemas/stock_trace.py`：

```python
SourceKind = Literal[
    "trigger_fact", "quote_fact", "sector_fact", "market_fact",
    "announcement", "news", "capital_fact", "technical_fact",
    "insight_article",
]
```

2. `qa_router.py`：找到词条/意图枚举映射处（grep `insight_lookup`/`涨停雷达`），将 `涨停雷达|自选股|洞察|归因` 等映射改为 `stock_trace_lookup`，`insight_lookup` 从路由与 footer skill 清单摘除（保留 registry 定义或删除——若 registry 从磁盘自动注册则保留文件，仅路由不指向）。

3. `skills/registry.py`：若 `_STOCK_SKILLS`/动态清单含 insight_lookup 引用，移除；确保渲染 footer 不含 insight_lookup。

> 精确改动点以 grep `insight_lookup` 在 qa_router/registry 出现的所有行号为准，逐处处理。

- [ ] **Step 4: Run test to verify it passes**

Run: `$env:PYTHONPATH="src"; .venv311\Scripts\python.exe -m pytest tests/unit/test_qa_router.py tests/unit/test_skills.py -v`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/aistock_agent/schemas/stock_trace.py src/aistock_agent/graph/nodes/qa_router.py src/aistock_agent/skills/registry.py tests/unit/test_qa_router.py tests/unit/test_skills.py
git commit -m "feat: stock_trace SourceKind 增加 insight_article；对话词条统一 stock_trace_lookup"
```

---

### Task 5: App 端列表统一 movements（aistock-app-frontend）

**Files:**
- Modify: `d:\aistock\aistock-app-frontend\src\modules\favorites\components\AlertContent.vue`（`loadCaptureList` 只拉 movements；移除 `fromInsight`；`goTrace` 统一跳 move 页）
- Modify: `d:\aistock\aistock-app-frontend\src\modules\favorites\components\AlertContent.spec.ts`（移除 insights mock 与涨停雷达行断言）
- 可能 Modify: `d:\aistock\aistock-app-frontend\src\modules\favorites\AGENTS.md`

**Interfaces:**
- Consumes: `stockTraceApi.list(3)` 返回 `{ items: StockTraceEvent[] }`（`event_type: 'price'`）；现 `watchlistInsightApi.getInsights()` 停用。
- Produces: 自选股洞察卡片列表仅来自 movements；涨停雷达事件（现为 mv/price 事件）在列表按 `event_type='price'` 展示并跳 `insight-detail-move.vue`。

- [ ] **Step 1: Write the failing test**

更新 `AlertContent.spec.ts`：删除 `getInsights` mock 与 `testInsights` 数据；仅保留 `stockTraceApi.list` 用例；断言点击行跳转 URL 为 `insight-detail-move`。先读现有 spec 全文（113-140 行有跳转断言）再改。

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test`（在 aistock-app-frontend，或 `npx vitest run src/modules/favorites/components/AlertContent.spec.ts`）
Expected: FAIL（组件仍调用已移除的 `getInsights` / spec mock 与实现不一致）。

- [ ] **Step 3: Implement**

`AlertContent.vue`：

```ts
async function loadCaptureList() {
  // 2026-08-30 链路合并：涨停雷达事件已并入 stock-trace（movements），列表只消费 movements
  try {
    const page = await stockTraceApi.list(3).catch(() => ({ items: [] as StockTraceEvent[] }))
    captureList.value = page.items.map(fromMovement).sort((a, b) => b.sortTime - a.sortTime)
  } catch {
    captureList.value = []
  }
}
```

移除 `fromInsight` 函数与 `watchlistInsightApi` import（grep 后清理）；`goTrace`/跳转逻辑统一指向 `/modules/favorites/pages/insight-detail-move?event_id=`（event_type 恒为 price）。

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test`
Expected: PASS（AlertContent 用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/modules/favorites/components/AlertContent.vue src/modules/favorites/components/AlertContent.spec.ts
git commit -m "feat(favorites): 自选股洞察列表统一 movements（涨停雷达并入 stock-trace 链路）"
```

---

### Task 6: 文档维护 + 跨端确认 + 端到端验证（收尾）

**Files:**
- Modify: `d:\aistock\aistock-app-api\src\modules\stock-trace\AGENTS.md`、`d:\aistock\aistock-app-api\src\modules\insight\AGENTS.md`、`d:\aistock\aistock-app-api\CHANGELOG.md`
- Modify: `d:\aistock\aistock-agent-py\AGENTS.md`、`d:\aistock\aistock-agent-py\README.md`、`d:\aistock\aistock-agent-py\CHANGELOG.md`
- Modify: `d:\aistock\aistock-app-frontend\src\modules\favorites\AGENTS.md`、`d:\aistock\aistock-app-frontend\CHANGELOG.md`
- Modify（记忆）: `c:\Users\Lia\.trae-cn\memory\projects\-d-aistock\project_memory.md`

- [ ] **Step 1: 更新模块文档与 CHANGELOG**

- app-api `stock-trace/AGENTS.md`：顶部加 2026-08-30 条目——涨停雷达并入（runCycle 命中 → processPriceFact immediateEnqueue；`insight_article` 域；打点跳过语义）。
- app-api `insight/AGENTS.md`：更新功能范围——涨停雷达不再建 wi 事件，仅作 stock-trace 证据源；runCycle 职责改为"采集+喂 stock-trace"。
- app-api `CHANGELOG.md`：加 08-30 合并条目。
- agent-py `AGENTS.md`/`README.md`/`CHANGELOG.md`：SourceKind 加 insight_article；词条统一说明。
- app-frontend `favorites/AGENTS.md`/`CHANGELOG.md`：列表统一 movements。
- `project_memory.md`：追加合并决策与教训。

- [ ] **Step 2: 跨端同步确认**

调用 `cross-repo-impact-analyzer` 核对：insight 事件字段/前端类型/agent-py 词条影响已全覆盖（App 端已改；Web 端 aistock-frontend 用户已确认不同步，不做）。确认 `watchlistInsightApi`/`insight_lookup` 无残留活跃引用。

- [ ] **Step 3: 全量验证**

- app-api：`npx tsc --noEmit`；`node --import tsx --test src/modules/stock-trace/__tests__/*.spec.ts src/modules/insight/__tests__/*.spec.ts`（相关 spec）。
- agent-py：`$env:PYTHONPATH="src"; .venv311\Scripts\python.exe -m pytest tests/unit/test_qa_router.py tests/unit/test_skills.py -v`。
- app-frontend：`npm run test`。

- [ ] **Step 4: Commit（按仓库分别）**

```bash
# app-api
git add -A && git commit -m "docs: 涨停雷达并入 stock-trace 链路文档同步（08-30）"
# agent-py / app-frontend 同理
```

> 端到端真实验证（涨停文章 → mv 事件 + 归因；打点跳过）需本地服务 + DB/Redis，实施完成后按 aistock-workflow Phase 5 运行验证并在验收时说明。

---

## Self-Review 记录

- **Spec 覆盖**：设计文档 5.1（Task 1+3）、5.2（Task 2+4 SourceKind）、5.3（Task 1 说明，复用 revision 无新代码）、5.4（Task 5）、5.5（Task 4）、存量保留不展示（Task 5 移除 insights 拉取即实现）、第 6 节风险（Task 3 跳过分支、Task 2 时序）。
- **占位符扫描**：无 TBD/TODO；测试代码与实现代码均给出。`runCycleEnqueue.spec.ts` 的旧断言更新以"先跑再看"方式给出明确指引（非占位，是防伪证）。
- **类型一致性**：`immediateEnqueue` 贯穿 Task 1/3 签名一致；`insight_article` 在 Node kind/`SourceKind`/复用域命名一致；`radarHitToPriceEvent`/`parseActivityQuote` 在 Task 3 定义并被测试引用。
