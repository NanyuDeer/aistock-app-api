# AGENTS.md - modules/calendar（节奏大师日历模块）

> 本文件是 AI 开发助手的模块入口地图，开发本模块时必读。

## 功能范围

节奏大师（上证指数目标交易日节奏状态卡）的数据层：聚合 L1-L4 四层事件日历，供前端节奏卡展示。

- **L1 规则日历**：期指交割日 = 每月第三个周五（纯计算，遇休市不顺延，spec §4.1）
- **L2/L3 事件入库**：外部源（爬虫/agent）通过 `POST /internal/calendar/events` upsert 财报预告/宏观事件
- **L4 种子事件**：默认 `source='L4'`（种子事件由其他链路写入）
- **存量披露密度**：`GET /internal/calendar/earnings-density` 聚合 `performance_reports` 作"披露高峰"辅助信号
- **前端三版本读取**：`GET /api/agent/rhythm-master/:date` 按 refresh_slot 优先级返回三时点节奏卡

## 核心文件与职责

| 文件 | 职责 |
|------|------|
| `CalendarRuleService.ts` | L1 规则层：`nthWeekday(year, month, weekday=4, n=3)`（每月第 n 个星期几）、`listDeliveryDates(dateFrom, dateTo)`（窗口内交割日，升序）；`CalendarEvent` 对外契约类型 |
| `MarketCalendarEventService.ts` | 表读写：`listEvents(dateFrom, dateTo)`、`upsertEvent(input)`（ON CONFLICT (event_date, dedup_hash)）；`normalizeTitle`（去空白标点小写）、`dedupHash`（sha256 前 16 位）、`typeFromSource`（source→type 推导）、`isOvernightEvent`（time≥15:00） |
| `internalRouter.ts` | Python/爬虫专用 internal API：GET/POST `/events`、GET `/earnings-density`；独立 `x-internal-token` 鉴权 |
| `publicRouter.ts` | 前端公开 API：GET `/rhythm-master/:date` 三版本读取（无需 token） |

## 数据模型（启动自动建表，对齐 prediction_records 先例）

- `market_calendar_events`：`event_date DATE` + `title TEXT` + `importance`（high/medium/low）+ `market`（CN/US_OVERNIGHT）+ `event_time TEXT`（HH:MM）+ `source`（L1/L2/L3/L4）+ `detail` + `result` + `dedup_hash VARCHAR(64)`
- 唯一键：`ux_market_calendar_events_dedup(event_date, dedup_hash)`（三源共用去重）；日期索引 `idx_market_calendar_events_date`

## 关键契约

- 对外事件：`{date, type: delivery|earnings|seed|macro, title, importance, source, event_time?, result?}`
- `typeFromSource`：L1→delivery；L2/L3 标题命中 `/(发布日程|CPI|PPI|PMI|社融|FOMC|议息)/` →macro，否则 earnings；L4→seed
- **US 隔夜事件**（`market='US_OVERNIGHT'` 且 `event_time>=15:00`）：对外 `date` 顺延次一交易日（`TradingCalendarService.getNextTradingDay`，§4.5）；交易日历未覆盖年份 fail-close 保留原始日期（不抛 502）
- **listEvents 排序契约**（2026-09-02，rhythm 锚点单一来源）：`ORDER BY event_date ASC, event_time ASC NULLS LAST, title ASC`（三键稳定排序）；`internalRouter` GET /events 再按 date 主键 JS 稳定排序（同日期保留 DB 行次序）；Python 侧 `high_events`/`next_event_anchor` 取首条顺序唯一继承此下发序，Python 不重排
- `upsertEvent` 默认值：importance=medium、market=CN、source=L3、event_time/detail/result=null；返回 `{id, upserted}`（`xmax=0` 判断新插入）
- `dedupHash`：`sha256(event_date|normalizeTitle(title))` 前 16 位；`normalizeTitle` = 去 `[\s\W_]+` + 小写
- internal 鉴权：`x-internal-token` 必须等于 `INTERNAL_API_TOKEN || INTERNAL_TOKEN || 'change-me-in-production'`（**请求时动态求值**，非模块加载期常量——避免 core/db 的 dotenv 抢先固化导致测试/热更新后 token 失效）
- rhythm-master 版本优先级：`midday > morning > after_close`（展示最新）

## 接口表

| 接口 | 方法 | 鉴权 | 说明 |
|------|------|------|------|
| `/internal/calendar/events?dateFrom=&dateTo=` | GET | x-internal-token | L1 交割日 + 表内事件合并，按日期升序 |
| `/internal/calendar/events` | POST | x-internal-token | upsert 事件（event_date+title 必填，importance/market/source 枚举校验） |
| `/internal/calendar/earnings-density?dateFrom=&dateTo=` | GET | x-internal-token | performance_reports 按 ann_date 聚合 `{date, count}` |
| `/api/agent/rhythm-master/:date` | GET | 无 | 三时点版本（user_id ∈ after_close/morning/midday），按 refresh_slot 优先级排序 |

## 依赖

- 共享：`core/db`（pool）、`shared/utils/TradingCalendarService`（getNextTradingDay）
- 消费端：`aistock-agent-py` 回调 `/internal/calendar/*` 写入事件；前端经 `/api/agent/rhythm-master/:date` 读版本

## 测试

- 运行：`node --import tsx --test src/modules/calendar/internalRouter.test.ts src/modules/calendar/publicRouter.test.ts`
- 类型检查：`npx tsc --noEmit`
- 仓库惯例：node:test + 覆写 `pool.query`（静态 import 与路由内动态 import 同一模块缓存实例，覆写生效）；禁止触碰真实数据库
