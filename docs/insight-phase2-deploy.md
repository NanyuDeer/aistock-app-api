# 自选股洞察二期（午盘/尾盘价格异动）部署补充清单

> AI Stock App 自选股洞察二期（午盘/尾盘价格异动洞察）上线部署步骤。
> 本文档为**一期部署清单的补充**，覆盖二期新增的迁移、cron、配置变更与验证项。
> 执行前请确保一期已稳定运行（`watchlist_insight_events` 表已存在一期数据）。

## 1. 备份生产库（必做）

```bash
pg_dump "$DATABASE_URL" -Fc -f /backup/aistock_$(date +%Y%m%d_%H%M%S).dump
```

## 2. 执行 017 迁移

在 aistock-app-api 仓库根目录执行：

```bash
psql "$DATABASE_URL" -f src/db/migrations/017_watchlist_price_move.sql
```

迁移后校验表已创建：

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name IN ('watchlist_price_snapshots', 'watchlist_evidence_packages')
ORDER BY table_name;
```

应出现 2 张表：
- `watchlist_price_snapshots` — 午盘/尾盘价格快照（业务唯一键：symbol + trade_date + snapshot_type）
- `watchlist_evidence_packages` — 证据包冻结版本化（frozen_seq 递增，支持补抓）

## 3. 部署 app-api（价格异动采集侧）

1. 拉取最新代码（含二期全部变更）。
2. `pnpm install`，构建前类型检查 `npx tsc --noEmit`，再 `pnpm build`。
3. 重启服务。
4. 二期 cron 已内置在 `src/index.ts`，无需额外配置：

| Cron 表达式 | 职责 | 说明 |
|------------|------|------|
| `30 11 * * 1-5` | 午盘打点（11:30） | `PriceMoveService.run('midday')`，达阈值者创建事件 + 冻结证据包 + 入队 |
| `5 15 * * 1-5` | 尾盘打点（15:05） | `PriceMoveService.run('close')`，同方向更新/反方向创建独立事件 |
| `50 11 * * 1-5` | 午盘补抓（11:50） | `PriceMoveService.refetchMiddayEvidence()`，20 分钟后补抓新证据（frozen_seq++） |

> 所有 cron 使用 `timezone: 'Asia/Shanghai'`，仅在交易时段（周一至周五）触发。
> 补抓仅覆盖午盘事件；尾盘触发后当日不再补抓（收盘后无增量资讯意义）。

验证 cron 已注册：

```sql
-- 检查是否有午盘/尾盘事件写入
SELECT count(*) FROM watchlist_insight_events
WHERE event_type IN ('midday_price_move', 'close_price_move');
```

## 4. 部署 agent-py（归因消费侧）

**无需新配置。** 二期复用一期相同的 consumer 流：

- `watchlist-insight.jobs` Redis Stream 的 consumer 已由一期 `insight_consumer.py` 消费
- 价格异动事件通过 `enqueue()` 写入同一 Stream，consumer 自动消费
- 环境变量 `INSIGHT_CONSUMER_ENABLED=true`、`INSIGHT_REDIS_URL` 等保持一期配置不变

验证配置（确认队列能收到价格异动消息）：

```bash
redis-cli -u "$INSIGHT_REDIS_URL" XLEN watchlist-insight.jobs
```

交易时段午盘 11:30 后应有新消息入队（`event_id` 格式为 `wi_YYYYMMDD_symbol_pm_up/down`）。

## 5. 前端发布与验证

1. 发布前端（含价格异动字段展示的列表/详情页）。
2. 验证列表页：事件类型包含 `midday_price_move` / `close_price_move`，展示 `move_bps`、`direction`。
3. 验证详情页：展示价格异动主因/次因/置信度，证据包来源含量化联动（板块强度/同行同步/市场冲击）。
4. 验证推送设置：价格异动事件触发推送（`push_kind='created'` 或 `push_kind='updated'`）。

## 6. 次日 Tushare daily 校准

二期量化联动（板块强度、同行同步）依赖 Tushare `ths_daily` / `daily` 接口数据。次日 Tushare 数据更新后：

```sql
-- 检查是否存在量化证据包的 evidence_packages 行
SELECT count(*) FROM watchlist_evidence_packages
WHERE evidence::text LIKE '%quant%' AND created_at >= now() - interval '2 days';
```

> 注意：Tushare daily 校准仅用于质量指标检查，**不回溯改写已发布的洞察**。价格异动事件的证据包在触发时已冻结，Tushare 数据更新不影响已有归因结果。

## 7. 联调核对项（上线前确认）

| 核对项 | 验证方式 | 状态 |
|--------|---------|------|
| 017 迁移已执行 | `watchlist_price_snapshots` / `watchlist_evidence_packages` 表存在 | 待核 |
| 午盘 cron 11:30 触发 | 11:30 后有 `midday_price_move` 事件写入 | 待核 |
| 尾盘 cron 15:05 触发 | 15:05 后有 `close_price_move` 事件写入 | 待核 |
| 阈值 700 bps 生效 | 事件 `move_bps` 绝对值 >= 700（699 不触发） | 待核 |
| 证据包已冻结 | `watchlist_evidence_packages` 有对应 event_id 记录 | 待核 |
| Redis Stream 有消息 | `XLEN watchlist-insight.jobs` > 0 | 待核 |
| Python 消费归因 | `watchlist_insight_results` 有价格异动事件结果 | 待核 |
| 前端展示正确 | 列表/详情页展示价格异动字段 + 归因结果 | 待核 |

## 8. 已知保留点（不阻塞上线）

以下为二期实现中已知的保留点，已在代码中注明，不影响核心功能上线：

- **市场广度（上涨家数占比）**：`SectorMarketEvidenceService` 中 `coverage.partial` 标记为可选增强，当前以市场冲击①（上证 ±1.5%）为主证据。可复用 `TencentSnapshotService.fetchMarketBreadth`，但需验证交易时段调用语义。
- **业绩证据 `published_at`**：使用 `end_date`（报告期）近似，非实际公告日；`days_offset` 可能偏大。若 `performance_reports` 表存在 `ann_date` 字段，后续应优先取 `ann_date`。
- **补抓范围**：仅覆盖午盘事件；尾盘触发后当日不再补抓。
- **stock_concept_mapping 覆盖**：依赖每日 04:30 刷新任务，新股/新板块可能当日缺失。

## 9. 回滚

如需停用二期功能：

1. 从 app-api 源码中移除午盘/尾盘/补抓 cron 注册项（`src/index.ts`），重新部署。
2. agent-py 侧无需变更（consumer 同时处理一期和二期 job，二期 job 无事件时自然跳过）。
3. 数据表保留不删（`watchlist_price_snapshots`、`watchlist_evidence_packages`），后续可随时恢复。