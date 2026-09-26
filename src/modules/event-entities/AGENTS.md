# AGENTS.md - modules/event-entities（重大事件时间线 Event Entity 模块）

> 本文件是 AI 开发助手的模块入口地图，开发本模块时必读。

## 功能范围

重大事件时间线的数据层：维护 Event Entity 权威实体表（`event_entities`），承载 News / Calendar 两通道物化的重大事件，对前端提供按事件发生时间组织的时间线读取。

- **Event Entity 权威实体**：`event_id` 仅由 app-api 首写生成（不可变），`canonical_event_key` 只做确定性幂等（不做语义 Merge）；`event_status` 由确定性纯函数计算、**读时重算**为权威
- **News 通道**：`aistock-agent-py` 经 `POST /internal/event-entities` 写入重大事件（agent-py 侧 `event_entity_enabled` 开关控制）
- **Calendar → Event Entity 物化（Phase 0.5）**：`CalendarEntityMaterializer` 对日历行做确定性准入后逐行幂等 upsert，由 `src/index.ts` cron 调度（每天 06:40 / 12:40 / 18:40）
- **时间线公开 API（Phase 1）**：`GET /api/agent/event/timeline`，按上海时区日期组织，未来事件提前可见；**不读 `agent_analysis_reports`**（GI 旁路，时间线不依赖事件传导完成度；2026-09-24 展示层例外：news 事件标题按传导报告 `content.title` 对齐 + 全部事件 impactSectors 按传导 chain Top3 覆盖展示，见「关键契约」）

## 核心文件与职责

| 文件 | 职责 |
| ---- | ---- |
| `EventEntityService.ts` | 领域服务与纯函数：`computeEventStatus`（确定性状态机，禁 LLM）、`normalizeTitle`（canonical 归一化）、`canonicalKey`（`event_start_date\|canonical_title`）、`startDateOf`（上海时区日期）、`isDateOnly`、`normalizeImpactSectors`（impact_sectors 归一化：过滤非字符串/空串/重复，返回 string[]）；`upsertEventEntity`（`ON CONFLICT (canonical_event_key)` 幂等 upsert，`event_id`/`created_at` 首写不更新；`impact_sectors` 缺省 null 时保留原值）、`listEventEntities`（日期过滤）、`withComputedStatus`（读时重算）、`toContractEventEntity`（对外契约） |
| `EventEntityInternalRouter.ts` | Python Agent 专用 internal API：`POST /`（幂等 upsert，字段/枚举校验）、`GET /`（日期 + status 过滤）；独立 `x-internal-token` 鉴权，信封 `{code:200}` |
| `CalendarEntityMaterializer.ts` | Calendar → Event Entity 物化：`qualifyCalendarEvent`（确定性准入）、`toCalendarEntityInput`（date-only 映射）、`materializeCalendarRows`（逐行幂等 upsert，单行失败不中断整批）；**本文件不 import calendar 模块**，只接收 rows（读表由 index.ts 编排） |
| `EventTimelinePublicRouter.ts` | 前端公开 API：`GET /event/timeline`（分页、排序、status 过滤、上海时区 `date` 分组键），无 token；`loadConductionPayloads` 对分页内**全部** eventIds 一次 `IN (...)` 查询最新 `event_conduction` 报告（取 `content.title` + `content.analysis_reports.event_transmission.chain`）；`topImpactSectors(chain, 3)` 按 impactStrength 降序取 Top3 板块名（过滤空 industry）；组装时 news 事件标题按 `content.title` 对齐（无报告回退原始标题）、impactSectors = chain Top3（空则回退 `event_entities.impact_sectors` 列，再空为 `[]`） |

## 数据模型（migration 019 + 023，人工 psql 执行）

- `event_entities`：`event_id VARCHAR(64) PRIMARY KEY` + `canonical_event_key VARCHAR(255) NOT NULL UNIQUE` + `title` + `summary` + `scrape_at TIMESTAMPTZ DEFAULT now()` + `publish_time TIMESTAMPTZ` + `event_start_time TIMESTAMPTZ NOT NULL` + `event_end_time TIMESTAMPTZ` + `time_source VARCHAR(40) DEFAULT 'publish_time_fallback'` + `time_confidence NUMERIC(3,2)` + `event_status VARCHAR(20)` + `source_type VARCHAR(30)` + `source_event_id VARCHAR(128)` + `impact_sectors JSONB NOT NULL DEFAULT '[]'::jsonb`（2026-09-24 migration 023 新增）+ `created_at` / `updated_at`

- 唯一键：`canonical_event_key`（幂等 upsert 冲突键）；索引 `idx_event_entities_start_status`（`date(event_start_time AT TIME ZONE 'Asia/Shanghai')` + `event_status`，`WHERE event_start_time IS NOT NULL`）

- 建表脚本：`src/db/migrations/019_event_entities.sql` + `src/db/migrations/023_event_entities_impact_sectors.sql`（本仓 migrations 均为人工 psql 执行，无启动自动执行器）

## 关键契约

- **`event_id`**：仅 app-api 首写生成（`EVT-${randomUUID()}`），`ON CONFLICT DO UPDATE` **不更新** `event_id`/`created_at`；`source_event_id` 承接 agent-py event_store 旧 id（首次保留，`COALESCE(EXCLUDED.source_event_id, 现有值)`）。

- **`canonical_event_key` = `event_start_date|canonical_title`**：`event_start_date` 用 `startDateOf`（上海时区 `YYYY-MM-DD`），`canonical_title` 由 `normalizeTitle` 归一化（NFKC 全角→半角 + 去空白/标点/符号 + 小写；**只去书写噪声、不做语义归并**）。**只做确定性幂等，不做语义 Merge**（"2026-09" 与 "9月" 不等价）。`normalizeTitle` 是 Event Entity canonical 的统一口径，Calendar→Entity 物化与 News 通道共用。

- **`event_status`**：`computeEventStatus` 确定性纯函数（禁 LLM），取值 ∈ `scheduled` / `upcoming` / `ongoing` / `occurred`；date-only（上海墙钟 00:00）→ 当日整天 ongoing、次日 0 点 occurred；单日（无 end）end=start；多日 start≤now≤end → ongoing、now>end → occurred；start 缺失 → 保守 occurred。**写库列为 display-only 快照，读时 `withComputedStatus` 按 now 重算为权威**（无刷新作业的闭合）。`upcoming`（预热窗口）待 P1 定义，P0 一律落 `scheduled`。

- **Calendar 准入（禁 LLM 红线）**：`qualifyCalendarEvent` = 仅 `importance='high'` 或 `source='L4'` 允许，其余拒绝——防止时间线退化成普通活动日历（日常公告/低优提醒不进时间线）。

- **Calendar 映射**：`toCalendarEntityInput`——date-only → `${event_date}T00:00:00+08:00`、`event_end_time = event_start_time`（单日 end=start）、`time_source='calendar'`、`time_confidence=0.95`、`source_type='calendar'`；**用原始 `event_date`，不套用 calendar 对外契约的 US 隔夜顺延**（时间线按真实发生日展示）。

- **物化容错**：`materializeCalendarRows` 逐行 try/catch，单行失败 `failed++` 并 warning，绝不中断整批；返回 `{materialized, skipped, failed}`；幂等 upsert，重复执行不产生重复实体。

- **时间线 `date` 分组键**：item 的 `date` 是后端算好的 `startDateOf(event_start_time)`（上海时区 `YYYY-MM-DD`），前端据此分组。

- **GI 旁路（spec 冻结原则）**：`EventTimelinePublicRouter` **不读 `agent_analysis_reports`**——时间线不依赖事件传导是否完成、不依赖 GI；未来事件无传导也照常展示；`event_status` 用读时重算值而非落库快照。**展示层例外（2026-09-24）**：仅用于展示字段（title / impactSectors / occurred 存在性），不改变准入/排序语义（不 Gate Timeline）：
  1. `source_type='news'` 事件的 `title` 例外读取 `agent_analysis_reports`（`report_type='event_conduction'` 最新一份的 `content->>'title'`，LLM 提炼标题）覆盖展示，无报告回退 `event_entities.title`。
  2. 所有事件的 `impactSectors` = 最新传导报告 `chain`（`impact_strength` 降序 Top3，过滤空 industry，`topImpactSectors`）优先；chain 为空回退 `event_entities.impact_sectors` 列（KG 预计算，`normalizeImpactSectors`）；再空为 `[]`（前端整块不渲染）。
  3. **occurred 事件传导存在性过滤**：occurred 事件必须在 `agent_analysis_reports` 中存在 event_conduction 报告行，否则从时间线排除（无报告事件点击详情 404 → 前端「服务异常」）；scheduled/upcoming/ongoing 未来事件保留（点击就地展开不跳详情）。`loadConductionPayloads` 对排序后**全部**事件（而非分页内）查询，保证过滤后 total 准确。

- **impactSectors 数据优先级契约（2026-09-24）**：传导 chain（Top3）> `event_entities.impact_sectors` 列 > `[]`。**与 `impact_industries`（Event Conduction 无序 set）语义不同，禁止混用**；真正的有序传导结果是 `chain`（含 `impact_strength`）。`impact_sectors` 列写入方为 agent-py 预计算作业（07:00，仅处理 calendar + scheduled/upcoming + 列值为空的行，KG 行业向量匹配 Top3，宏观事件无可靠行业保持 `[]` 不 LLM 强猜）；upsert 时 `impact_sectors` 参数为 null 则保留原值（`CASE WHEN $13::jsonb IS NULL ...`），防 Calendar 物化 cron 覆盖预计算结果。

## 接口表

| 接口 | 方法 | 鉴权 | 说明 |
| ---- | ---- | ---- | ---- |
| `/internal/event-entities` | POST | x-internal-token | 幂等 upsert 一条 Event Entity（`title`/`source_type`∈{news,calendar,announcement,manual,agent}/`event_start_time`(YYYY-MM-DD 或 ISO)/`time_source` 枚举 校验；`time_confidence` 须 0~1；`impact_sectors` **可选**，非字符串数组 400 `'impact_sectors 须为字符串数组'`，缺省 null → upsert 冲突时保留原值）；信封 `{code:200, data: <entity>}` |
| `/internal/event-entities?status=&dateFrom=&dateTo=` | GET | x-internal-token | 列表查询（日期作用于上海时区 `event_start_date`；`status` 在读时重算值上过滤，缺省不过滤）；信封 `{code:200, data:{items:[...]}}` |
| `/api/agent/event/timeline` | GET | 无 | 时间线公开读取：query 全部可选 `dateFrom`(缺省=上海今天) / `dateTo`(缺省=今天+90天) / `status`(scheduled\|upcoming\|ongoing\|occurred) / `order`(asc\|desc，缺省 asc) / `page`(缺省 1) / `pageSize`(缺省 20，上限 100)；响应 `{code:0, data:{items,total,page,pageSize,hasMore}}`，item 为 camelCase（eventId/title/summary/eventStartTime/eventEndTime/eventStatus/sourceType/timeSource/timeConfidence/sourceEventId/**date**/**impactSectors**）；**title**：news 事件优先取最新传导报告 `content.title`（LLM 提炼），无传导回退 `event_entities.title`；calendar 等原样透传；**impactSectors: string[]**：传导 chain Top3（`impact_strength` 降序）优先，空则回退 `event_entities.impact_sectors` 列，再空 `[]`（前端空数组整块不渲染）；**occurred 事件无 event_conduction 报告行 → 从结果排除**（total/hasMore 同步重算），未来事件无报告保留 |

> `EventEntityInternalRouter` 信封统一 `{code:200}`（agent-py `_request` 只收 code==200，**禁止抄 calendar 的 code:0**）；`EventTimelinePublicRouter` 信封为 `{code:0, data:...}`（前端公开接口惯例）。

## 依赖

- 共享：`core/db`（pool）
- 跨模块读取由 `src/index.ts`（composition root）编排：读取 calendar 行（`listEvents`）后把 rows 传给 `materializeCalendarRows`，**模块间不直接 import**（模块解耦硬约束）
- 消费端：`aistock-agent-py` 经 `/internal/event-entities` 写入 News 通道实体；`aistock-app-frontend` 经 `/api/agent/event/timeline` 读时间线
- 挂载（`src/index.ts`）：`app.use('/internal/event-entities', eventEntityInternalRouter)`；`app.use('/api/agent', eventTimelinePublicRouter)` **必须在 `createAgentProxy` 之前**（否则被反代到 Python）；cron `40 6,12,18 * * *`（`{ timezone: 'Asia/Shanghai' }`）执行 Calendar 物化，窗口 `[今天-1, 今天+180]`，日志前缀 `[CalendarEntityCron]`

## 测试

- 运行：`node --import tsx --test src/modules/event-entities/CalendarEntityMaterializer.test.ts src/modules/event-entities/__tests__/event_timeline.spec.ts`（Calendar 物化 10 个纯函数单测 + timeline 3 个接口单测：标题对齐 / impactSectors 优先级 chain>列>[] / 增强查询全分页 id `IN (...)`）
- 类型检查：`npx tsc --noEmit`
- 仓库惯例：node:test；纯函数优先直测，禁止触碰真实数据库
