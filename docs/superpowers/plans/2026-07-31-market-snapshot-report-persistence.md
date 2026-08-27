# Market Snapshot Report Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the Agent evening pipeline to persist `market_snapshot` reports through Node's internal analysis-report API.

**Architecture:** Preserve Node's finite `VALID_REPORT_TYPES` boundary and add only `market_snapshot`, the report type emitted by the scheduler. Extend the existing internal-route integration test harness to POST a normal public `market_snapshot` artifact and prove the request reaches the existing UPSERT path.

**Tech Stack:** TypeScript, Express 5, Node built-in test runner, TSX, PostgreSQL client mock.

## Global Constraints

- Do not change the database schema or manually modify production records.
- Keep all unknown report types rejected with HTTP 400.
- Keep internal-token authentication unchanged.
- Do not modify frontend code.

---

### Task 1: Allow and persist the evening market snapshot artifact

**Files:**
- Modify: `src/core/routes/__tests__/event_conduction.spec.ts`
- Modify: `src/core/routes/internal.ts:30-35`

**Interfaces:**
- Consumes: `POST /internal/analysis-reports` with a valid `X-Internal-Token`, `report_type`, `report_date`, and `content`.
- Produces: HTTP 201 response whose `data.report_type` is `"market_snapshot"`; unknown report types continue to produce HTTP 400.

- [ ] **Step 1: Write the failing test**

Add this test alongside the existing `event_conduction` whitelist test. It uses the real Express router and existing `call`, `buildApp`, `mockResponder`, and `INTERNAL_TOKEN` helpers:

```ts
it('accepts market_snapshot as a valid report_type', async () => {
    mockCalls = [];
    mockResponder = () => ({
        rows: [{
            id: 1,
            report_type: 'market_snapshot',
            report_date: '2026-07-14',
            created_at: '2026-07-14T10:00:00Z',
        }],
    });

    const app = buildApp();
    const res = await call(app, {
        method: 'POST',
        path: '/internal/analysis-reports',
        headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
        body: {
            report_type: 'market_snapshot',
            report_date: '2026-07-14',
            content: { brief_summary: { schema_version: 'brief_summary.v1' } },
            data_source: 'snapshot_builder',
            status: 'completed',
        },
    });

    assert.strictEqual(res.status, 201);
    const body = res.json as { code: number; data: { report_type: string } };
    assert.strictEqual(body.code, 201);
    assert.strictEqual(body.data.report_type, 'market_snapshot');
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test src/core/routes/__tests__/event_conduction.spec.ts`

Expected: the new test fails because the current route returns HTTP 400 with `Invalid report_type: market_snapshot`.

- [ ] **Step 3: Write the minimal implementation**

Add only `'market_snapshot'` to the `VALID_REPORT_TYPES` array:

```ts
const VALID_REPORT_TYPES = [
    'morning', 'wind_leader', 'stock', 'alert', 'hot_burst', 'review', 'iterate',
    'broadcast', 'event_conduction', 'trend_score', 'global_importance', 'market_snapshot',
    'brief_morning', 'brief_evening', 'broadcast_morning', 'broadcast_evening',
]
```

- [ ] **Step 4: Run focused tests and build**

Run:

```bash
node --import tsx --test src/core/routes/__tests__/event_conduction.spec.ts
pnpm build
```

Expected: all route tests pass and `tsc` exits zero.

- [ ] **Step 5: Commit**

```bash
git add src/core/routes/internal.ts src/core/routes/__tests__/event_conduction.spec.ts
git commit -m "fix: allow market snapshot report persistence"
```

## Final Verification

1. Run `git diff --check` for the implementation commit.
2. After deployment, re-run the production evening-chain command with `APP_ENV=production`.
3. Confirm `brief_evening` and `broadcast_evening` return non-null data from `/api/agent/brief/evening/:date` and `/api/agent/broadcast/evening/:date`.
