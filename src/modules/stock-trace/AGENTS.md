# Stock Trace module

This module owns event-scoped stock-movement trace facts, snapshots, jobs, validated results, and artifacts.

- `StockTraceJobService` writes a PostgreSQL job and transactional Outbox before publishing to Redis Stream `stock-trace.jobs`.
- Stream messages contain `job_id`, `event_id`, `trigger_revision`, `analysis_version`, and `job_kind` only; never include user data or source content.
- Redis publish failure must leave the Outbox record pending and must not affect TriggerEvent persistence or the initial alert.
- Python Workers consume jobs idempotently. They may only read Node Stock Trace context by `event_id` / `snapshot_id` and must not fetch A-share sources directly.
- User APIs remain in `controller.ts`; Python-facing routes remain in `internalRouter.ts` and require `X-Internal-Token`.
