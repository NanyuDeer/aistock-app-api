# Tencent Quick Snapshot Quote Normalization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the quick market snapshot use actual Tencent index and breadth values when its callers supply Tencent-prefixed symbols.

**Architecture:** `TencentQuoteService.getBatchQuotes` will normalize bare and explicitly-prefixed Tencent identifiers while preserving the prior bare-symbol result contract. `TencentSnapshotService` will request activity-level quotes, fail index construction on error placeholders, and exclude placeholders from breadth counts.

**Tech Stack:** TypeScript, Node.js built-in test runner, tsx, pnpm, Tencent quote API.

## Global Constraints

- Do not add a market-data provider, a database change, or a new runtime dependency.
- Bare six-digit callers of `TencentQuoteService.getBatchQuotes` must retain their current request and returned `股票代码` behavior.
- Explicit `sh`/`sz`/`bj` Tencent symbols must make exactly one-prefix requests and retain that exact normalized symbol in returned parsed rows.
- Index quote failures remain strict; market breadth remains best-effort, but error placeholders must never count as flat stocks.
- Do not print or persist internal API tokens.

---

### Task 1: Normalize explicit Tencent batch symbols without changing bare-symbol behavior

**Files:**
- Modify: `tests/TencentSnapshotService.test.ts`
- Modify: `src/modules/quote/TencentQuoteService.ts:136-193`

**Interfaces:**
- Consumes: `TencentQuoteService.getBatchQuotes(symbols: string[], level?: QuoteLevel)`.
- Produces: batch requests whose explicit `sh`/`sz`/`bj` symbols are sent unchanged and whose parsed rows retain their normalized explicit `股票代码`.

- [ ] **Step 1: Write the failing test**

Add a focused test that stubs the HTTP fetch boundary used by `TencentQuoteService`, calls `getBatchQuotes(['sh000001', 'sz000001'], 'activity')`, and asserts the requested URL contains `q=sh000001,sz000001` (never `shsh000001` or `shsz000001`). Return two minimal Tencent `v_*` payload lines and assert the result rows have `股票代码` values `sh000001` and `sz000001`.

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --import tsx --test tests/TencentSnapshotService.test.ts --test-name-pattern "explicit Tencent symbols"`

Expected: FAIL because the current request applies `getStockIdentity()` to already-prefixed strings and sends a duplicated prefix.

- [ ] **Step 3: Write the minimal implementation**

In `TencentQuoteService.ts`, add a private identifier normalizer matching `^(sh|sz|bj)(\\d{6})$` case-insensitively. It must return `{ requestCode, explicitCode }`, where a bare input uses the current `getStockIdentity()` path and has no `explicitCode`, while a prefixed input lowercases and returns its prefix-preserved code for both values. During result assembly, overwrite parsed `股票代码` only when `explicitCode` is present.

- [ ] **Step 4: Run the focused test to verify it passes**

Run: `node --import tsx --test tests/TencentSnapshotService.test.ts --test-name-pattern "explicit Tencent symbols"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/TencentSnapshotService.test.ts src/modules/quote/TencentQuoteService.ts
git commit -m "fix: preserve explicit Tencent batch symbols"
```

### Task 2: Reject quote error placeholders from quick snapshot facts and breadth

**Files:**
- Modify: `tests/TencentSnapshotService.test.ts`
- Modify: `src/modules/quote/TencentSnapshotService.ts:113-205`

**Interfaces:**
- Consumes: `TencentQuoteService.getBatchQuotes(..., 'activity')` rows, including `{ '股票代码': string, '错误': string }` placeholders.
- Produces: `fetchIndexes(): Promise<CloseIndexFact[]>` that rejects placeholders, and `calculateBreadth(quotes): MarketBreadth` that excludes placeholders.

- [ ] **Step 1: Write the failing tests**

Add one test that mocks `TencentQuoteService.getBatchQuotes` with six index rows where one is `{ '股票代码': 'sh000001', '错误': '未获取到行情数据' }`, then asserts `TencentSnapshotService.fetchIndexes()` rejects with `index sh000001 quote failed`. Add a second test whose valid advancing quote and one `{ '股票代码': 'sh600000', '错误': '查询失败' }` placeholder produce `total_count === 1`, `advance_count === 1`, and `flat_count === 0`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test tests/TencentSnapshotService.test.ts --test-name-pattern "error placeholder"`

Expected: FAIL because the index placeholder is converted to zeroes and the breadth placeholder is counted as flat.

- [ ] **Step 3: Write the minimal implementation**

Call `TencentQuoteService.getBatchQuotes` with the `activity` level in both `fetchIndexes` and `fetchMarketBreadth`. In `fetchIndexes`, throw `new Error(\`index ${code} quote failed\`)` when the selected row is missing or has its own `错误` property. In `calculateBreadth`, continue before numeric conversion when a quote has an own `错误` property.

- [ ] **Step 4: Run the focused tests to verify they pass**

Run: `node --import tsx --test tests/TencentSnapshotService.test.ts --test-name-pattern "error placeholder"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tests/TencentSnapshotService.test.ts src/modules/quote/TencentSnapshotService.ts
git commit -m "fix: reject failed Tencent snapshot quotes"
```

### Task 3: Verify the full affected contract

**Files:**
- Modify only if a focused verification failure proves a missing regression case.

**Interfaces:**
- Consumes: the normalized batch symbol contract and quick snapshot behavior from Tasks 1-2.
- Produces: a clean focused suite and TypeScript build.

- [ ] **Step 1: Run the snapshot regression suite**

Run: `node --import tsx --test tests/TencentSnapshotService.test.ts`

Expected: all tests pass.

- [ ] **Step 2: Run the TypeScript build**

Run: `pnpm build`

Expected: `tsc` exits 0.

- [ ] **Step 3: Confirm scope and whitespace**

Run: `git diff --check` and `git status --short`

Expected: only the two source files and focused test file are changed before their commits; no generated snapshot or configuration file is included.
