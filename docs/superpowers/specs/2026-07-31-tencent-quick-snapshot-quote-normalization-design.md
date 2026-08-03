# Tencent Quick Snapshot Quote Normalization Design

## Goal

Make post-close Tencent quick snapshots preserve real index and market-breadth values when callers provide Tencent-prefixed symbols, instead of silently turning request errors into zero-valued market data.

## Root Cause

`TencentSnapshotService` supplies already-prefixed Tencent symbols such as `sh000001` and `sz000001` to `TencentQuoteService.getBatchQuotes`. The quote service assumes every input is a bare six-digit symbol and prepends an exchange prefix again. Failed requests return error placeholder rows. Snapshot construction accepts those rows, coercing absent numeric fields to zero and counting them as flat securities.

## Design

1. `TencentQuoteService.getBatchQuotes` accepts either a bare six-digit symbol or an explicit Tencent symbol (`sh`/`sz`/`bj` plus six digits). Explicit symbols are sent unchanged and their parsed result retains the explicit symbol as `股票代码`; bare-symbol behavior is unchanged.
2. `TencentSnapshotService` requests its indexes and breadth quote batches at the `activity` level so percent change, volume, and amount are populated.
3. `fetchIndexes` treats an error placeholder as a core-data failure and throws instead of building a zero-valued index fact.
4. `calculateBreadth` skips error placeholder rows so request failures cannot be misclassified as flat stocks.

## Constraints

- No new data source or database change.
- Keep existing raw-symbol callers backward compatible.
- Preserve quick snapshot's strict index failure and best-effort breadth behavior.
- Do not expose or log internal tokens.

## Tests

- A prefixed symbol produces exactly one Tencent prefix in the requested URL and retains its prefixed symbol in the parsed batch result.
- An index error placeholder causes `fetchIndexes` to reject.
- Breadth excludes error rows while continuing to count valid quotes.
- Focused quote and snapshot tests plus TypeScript build must pass.
