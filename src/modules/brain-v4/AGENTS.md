# AGENTS.md - modules/brain-v4（V4 冻结快照数据层）

> 本文件是 AI 开发助手的模块入口地图，开发本模块时必读。

## 功能范围

智慧大脑 V4 的**可复现冻结快照**录制与回放：接收一组工具请求，用注入的 fetcher 取数后生成规范化 manifest 与 SHA-256；`GET` 回放只读冻结 manifest，**不触达任何上游**。

- 本 Task（V4-03-P01）只做进程内 `Map` 快照，**不做数据库持久化**（留待 Task 7）；
- 生产 fetcher 目前只保留最小映射注册表：未注册的工具在录制时显式报错，不静默返回空数据；
- 不执行 LLM 研究循环、不生成任何结论（V4 快照只存权威数据的事实投影）。

## 核心文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `snapshotService.ts` | 纯逻辑：`canonicalJson`（递归键排序、无空白差异）、`computeSha256`（`node:crypto`）、`recordSnapshot`（串行取数 → 稳定 manifest）、`replaySnapshot`（只读 manifest，可按 request_id 过滤，无 fetcher 参数）、`createSnapshotStore`（进程内 Map） |
| `snapshotController.ts` | Express handler：`createSnapshotHandlers({fetcher, store})` 支持测试注入；`registerSnapshotFetcher(tool, fetcher)` 注册生产取数；导出默认 `snapshotHandlers` |
| `__tests__/snapshot.spec.ts` | node:test 单测：规范化 JSON、SHA 稳定性、回放零上游调用、POST/GET 信封与 400/404 |

## 接口表

| 接口 | 方法 | 鉴权 | 说明 |
| ---- | ---- | ---- | ---- |
| `/internal/brain-v4/snapshots` | POST | x-internal-token | body `{as_of, snapshot_id?, requests:[{request_id, tool, params}]}`；返回 `{code:0, data:{snapshot_id, as_of, sha256, manifest}, message:''}`；body 非法 400，取数失败 502 |
| `/internal/brain-v4/snapshots/:snapshotId` | GET | x-internal-token | 返回同一 `{snapshot_id, as_of, sha256, manifest}`；不存在 404；**只读冻结数据，不触达上游** |

## 关键契约

- **规范化 JSON**：对象键递归升序、数组保持顺序、无多余空白；`undefined` 字段省略、`Date` 转 ISO 字符串。
- **SHA-256**：对规范化 manifest 计算；同输入两次录制必须同 SHA、同 `snapshot_id`（未显式传入时由请求身份派生 `snap_<sha前16位>`）。
- **条目排序**：manifest entries 按 `request_id` 升序，与请求到达顺序无关，保证逐字节可复现。
- **回放零上游**：`replaySnapshot` 签名不接收 fetcher，GET handler 只读进程内已冻结记录。

## 依赖

- 共享：`node:crypto`（SHA-256）、Express 类型。
- 挂载（`src/index.ts` 已存在）：`app.use('/internal', internalRouter)`；本模块两条路由在 `core/routes/internal.ts` 中注册，鉴权沿用既有 `verifyInternalToken`。
- 消费端：`aistock-agent-py` 的 V4 研究运行通过 `/internal/brain-v4/snapshots` 录制与回放快照。

## 测试

- 运行：`node --import tsx --test src/modules/brain-v4/__tests__/snapshot.spec.ts`
- 类型检查：`npx tsc --noEmit`
- 仓库惯例：node:test；纯函数直测，假 req/res 直测 handler，禁止触碰真实数据库/上游。

## 影子归档与只读对比（Task 7 / V4-07-P01）

独立于快照模块的 V4 影子数据层，**不写入也不查询已删除的 `brain_run_archives`**。

| 文件 | 职责 |
| ---- | ---- |
| `BrainV4ArchiveService.ts` | `archiveRun`（强制 `is_shadow=true`）、`getRun`、`listRuns({feature,profile,date})`、`getComparison`、`archiveComparison`（两个 run 的 snapshot SHA 必须一致）；可注入 `SqlExecutor`，测试不依赖真实 PG |
| `internalRouter.ts` | 本地 `verifyInternalToken`（`X-Internal-Token`）；`POST /archive`、`GET /runs`、`GET /runs/:v4RunId`、`GET /comparisons/:comparisonId`；统一 `{code,data,message}`；导出 default router |
| `__tests__/internalRouter.spec.ts` | 假 SQL 执行器 + 注入 Service：401/403、归档强制影子、读取只查影子表、快照 SHA 不一致 409 |
| `src/db/migrations/037_brain_v4_shadow.sql` | `brain_v4_runs` / `brain_v4_comparisons`，`CHECK (is_shadow = TRUE)` 与 profile/subject/as_of/run_id 索引 |

### 归档接口表

| 接口 | 方法 | 鉴权 | 说明 |
| ---- | ---- | ---- | ---- |
| `/internal/brain-v4/archive` | POST | X-Internal-Token | body 含 `v4_run_id` → 归档运行（强制 `is_shadow=true`）；含 `comparison_id` → 归档对比（快照 SHA 不一致 409） |
| `/internal/brain-v4/runs` | GET | X-Internal-Token | 只读影子运行，query `feature/profile/date`；仅查 `brain_v4_runs` 且 `is_shadow = TRUE` |
| `/internal/brain-v4/runs/:v4RunId` | GET | X-Internal-Token | 单条影子运行；不存在 404 |
| `/internal/brain-v4/comparisons/:comparisonId` | GET | X-Internal-Token | 只读对比；仅查 `brain_v4_comparisons` 且 `is_shadow = TRUE` |

### 挂载顺序

`src/index.ts` 中 `app.use('/internal/brain-v4', brainV4InternalRouter)` 必须位于
`app.use('/internal', internalRouter)` **之后**，保证 Task 3 的
`/internal/brain-v4/snapshots` 仍先命中既有路由；`core/routes/internal.ts` 不新增归档路由。

### 测试

- 运行：`node --import tsx --test src/modules/brain-v4/__tests__/internalRouter.spec.ts`
- 类型检查：`pnpm build`；测试用假 `SqlExecutor`，不要求真实 PostgreSQL。

