# Market Snapshot Report Persistence Design

## Goal

Allow the Agent evening pipeline to persist its `market_snapshot` artifact through Node's internal analysis-report API, so the subsequent `iterate`, `brief_evening`, and `broadcast_evening` stages can run.

## Root Cause

The Python evening scheduler saves `report_type="market_snapshot"`, but Node's `VALID_REPORT_TYPES` allowlist rejects that identifier with HTTP 400. The pipeline stops before it can create the remaining evening artifacts.

## Design

Add `market_snapshot` to the existing `VALID_REPORT_TYPES` allowlist in `src/core/routes/internal.ts`. Keep the allowlist in place: unknown report types continue to return HTTP 400.

Add an integration-style router test using the existing test harness. It will POST a valid internal analysis report with `report_type="market_snapshot"` and assert successful persistence. The test must fail before the allowlist change and pass afterward.

## Scope and Safety

- No database schema change or manual database writes.
- No frontend changes.
- No relaxation of internal API authentication or validation.
- Existing report types and invalid-type rejection behavior remain unchanged.

## Verification

Run the focused internal-route test, the related route test file, TypeScript build, and verify the server can persist a `market_snapshot` report during the evening-chain rerun.
