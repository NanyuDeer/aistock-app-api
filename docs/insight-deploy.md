# 自选股洞察（一期）部署切换清单

> AI Stock App 自选股洞察一期（涨停雷达采集 → 自选股筛选 → LLM 归因 → 落库 → 首次生成推送）上线部署步骤。
> 本文档为**人工执行的部署核对清单**；所有步骤均需在确认上一步结果后再执行。

## 0. 背景与范围

- 一期上线内容：涨停雷达采集（mrnxgg_list 静态分页 + 回溯 2 交易日）→ 自选股筛选 → LLM 归因 → 落库（`watchlist_insight_*`）→ 首次生成推送（微信/飞书/WS）。
- 旧 `stock_trace` 因果链：Node 侧触发默认停用、Python 侧 consumer 默认停用（Task 12 门控）；本清单在确认无新写入后清理旧数据。
- 涉及迁移：`016_watchlist_insights.sql`，新增 `watchlist_insight_sources` / `watchlist_insight_events` / `watchlist_insight_jobs` / `watchlist_insight_outbox` / `watchlist_insight_results` / `watchlist_insight_push_records` 共 6 张表。

## 1. 备份生产库（必做）

```bash
pg_dump "$DATABASE_URL" -Fc -f /backup/aistock_$(date +%Y%m%d_%H%M%S).dump
```

> 旧 stock_trace 清理脚本只 TRUNCATE 清空数据，删除不可逆，务必先完成备份。

## 2. 执行 016 迁移

在 aistock-app-api 仓库根目录执行：

```bash
psql "$DATABASE_URL" -f src/db/migrations/016_watchlist_insights.sql
```

迁移后校验表已创建：

```sql
SELECT table_name FROM information_schema.tables
WHERE table_schema = 'public' AND table_name LIKE 'watchlist_insight%'
ORDER BY table_name;
```

应出现 6 张表（sources / events / jobs / outbox / results / push_records）。

## 3. 部署 app-api（采集侧）

1. 拉取最新代码到目标部署分支。
2. `pnpm install`，构建前类型检查 `npx tsc --noEmit`，再 `pnpm build`。
3. 重启服务。
4. 采集 cron 已内置（交易时段周一至周五 9:00-15:59 每 10 分钟执行 `InsightService.runCycle`），无需额外配置，部署后自动开始采集。

验证采集已启动：

```sql
SELECT count(*) FROM watchlist_insight_sources;
```

## 4. 部署 agent-py（归因消费侧）

部署时显式声明以下环境变量（两个消费开关与代码默认值一致，防止环境继承历史值导致回归）：

```bash
INSIGHT_CONSUMER_ENABLED=true
STOCK_TRACE_CONSUMER_ENABLED=false
INSIGHT_REDIS_URL=<与 Node 侧 REDIS_URL 完全一致的生产 Redis 地址>
```

> **`INSIGHT_REDIS_URL` 必须与 Node 侧 `REDIS_URL` 指向同一 Redis 实例与 db（生产约定 db=9）。** Node 侧（app-api）将任务写入 `watchlist-insight.jobs` Stream，Python consumer 从同一实例同一 db 的该 Stream 消费；若两者指向不同实例或 db，consumer 将永远收不到消息，整条归因链路静默失效。代码默认值为 `redis://localhost:6379/3`（db=3），部署时**必须**显式覆盖为生产地址，不能沿用默认值或本地 `.env` 的值。

配置校验（部署后在 agent-py 机器执行，确认队列能读到 Node 侧写入的消息）：

```bash
redis-cli -u "$INSIGHT_REDIS_URL" XLEN watchlist-insight.jobs
```

返回值应与 Node 侧 `REDIS_URL` 下同命令一致，且随采集不断增长（交易时段每 10 分钟有新增）。若返回 `(nil)` 或长时间为 0 而 app-api 日志显示已入队，即为实例/db 未对齐。

1. 更新环境变量后重启 agent-py（PM2：`pm2 restart aistock-agent`，配置参考 `deploy/ecosystem.config.json`）。
2. 确认新 consumer 消费 `watchlist-insight.jobs`：日志出现归因结果回写 `POST /internal/insight/results/external`，`watchlist_insight_results` 表开始有记录。

## 5. 确认无新 stock-trace.jobs 后清理旧数据

切换窗口人工执行。先确认旧 stock_trace 已停写（部署后无新增消息）：

```sql
-- 部署后不应出现新的 stock_trace_jobs
SELECT count(*) FROM stock_trace_jobs WHERE created_at >= now() - interval '30 minutes';
-- 无 pending 积压
SELECT count(*) FROM stock_trace_outbox WHERE status = 'pending';
```

确认无新消息后，在 aistock-app-api 仓库根目录执行清理脚本（保留表结构，仅清数据）：

```bash
psql "$DATABASE_URL" -f scripts/cleanup-stock-trace.sql
```

> 清理脚本只 TRUNCATE，不删除表结构；若目标环境未执行过 011-015 迁移导致某张表不存在会报错，请先核对迁移版本。执行前请确保 Node 侧 `STOCK_TRACE_TRIGGER_ENABLED` 与 Python 侧 `STOCK_TRACE_CONSUMER_ENABLED` 均为关闭状态，否则清理后数据会再次写入。

## 6. 前端发布与灰度

1. 发布前端（列表 / 详情 / 推送设置相关页面）。
2. 灰度验证：
   - 列表页展示自选股洞察事件（`limit_up_radar`，方向 up）。
   - 详情页展示主因 / 次因 / 置信度 / 来源证据。
   - 推送设置开启后，首次生成推送（微信 / 飞书 / WS）能正常收到。

## 7. 联调核对项（上线前确认）

| 核对项 | 验证方式 | 状态 |
|--------|---------|------|
| 采集选择器验证 | 涨停雷达采集器（`LimitUpRadarCrawler`）在目标页面实际抓取到文章与正文，标题关键词 / 正文解析结果正确 | 待核 |
| 微信模板字段验证 | 首次生成推送的微信模板消息各字段（股票、方向、主因、置信度等）渲染正确 | 待核 |
| push_records 表迁移已应用 | `watchlist_insight_push_records` 表存在，且推送去重（event_id + openid + push_kind + channel 唯一）生效 | 待核 |

## 8. 二期补充（午盘/尾盘价格异动洞察）

二期（价格异动洞察）新增以下内容，详见独立文档 `docs/insight-phase2-deploy.md`：

1. 执行 `017_watchlist_price_move.sql` 迁移（新增 `watchlist_price_snapshots` / `watchlist_evidence_packages` 表）。
2. 部署 app-api（午盘 11:30 打点 + 尾盘 15:05 打点 + 午盘 11:50 补抓共 3 个 cron，自动启用）。
3. agent-py 无需新配置（consumer 与一期共用同一 `watchlist-insight.jobs` Stream）。
4. 前端发布：验证列表/详情页价格异动展示（`move_bps`、`direction`、`snap_direction` 等字段）。
5. 次日 Tushare daily 校准仅质量指标，不回溯改写已发布洞察。

### 二期联调核对项

| 核对项 | 验证方式 | 状态 |
|--------|---------|------|
| 017 迁移已执行 | `watchlist_price_snapshots` / `watchlist_evidence_packages` 表存在 | 待核 |
| 午盘 cron 11:30 触发 | 11:30 后有 `midday_price_move` 事件写入 | 待核 |
| 尾盘 cron 15:05 触发 | 15:05 后有 `close_price_move` 事件写入 | 待核 |
| 阈值 700 bps 生效 | 事件 `move_bps` 绝对值 >= 700 | 待核 |
| 证据包已冻结 | `watchlist_evidence_packages` 有对应 event_id 记录 | 待核 |
| Python 消费归因 | `watchlist_insight_results` 有价格异动事件结果 | 待核 |
| 前端展示正确 | 列表/详情页展示价格异动字段 + 归因结果 | 待核 |

> 详细部署步骤、已知保留点及回滚方案见 `docs/insight-phase2-deploy.md`。

## 9. 回滚与确认

- 回滚（一期）：可将 `INSIGHT_CONSUMER_ENABLED=false`，并停用 app-api 采集 cron；数据表保留不删，后续可随时恢复。
- 回滚（二期）：从 app-api `src/index.ts` 中移除午盘/尾盘/补抓 cron 注册项后重新部署；agent-py 侧无需变更；数据表保留不删。
- 全部步骤执行完成后，在发布记录中勾选本清单，并确认第 7 节及第 8 节中二期联调核对项全部通过。
