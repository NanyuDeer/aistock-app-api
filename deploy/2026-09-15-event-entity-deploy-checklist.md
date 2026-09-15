# Event Entity 上线部署清单（2026-09-15）

> 发给组长：请按本清单顺序执行。**不能只重启服务** —— 需先应用 019 迁移，否则物化端点报错（表不存在）。
> 涉及两仓：`aistock-app-api`（端点 + 表）+ `aistock-agent-py`（物化/守卫 + 开关）。

---

## 0. 前置：两仓 PR 先合并

| 仓库 | PR | 方向 |
|------|-----|------|
| aistock-app-api | #116 `feat(event-entity): /internal/event-entities 端点落地 + design-debate R2 收口` | changer → master |
| aistock-agent-py | #137 `feat(event-entity+rhythm): Event Entity 收口接入 + 节奏大师主线/仓位批次` | changer → main |

代码变更摘要（供验收参考）：

- **app-api**：`migration 019`（`event_entities` 权威表 + 部分表达式索引）、`EventEntityService`（确定性 `computeEventStatus` 纯函数 / canonical_key 幂等 upsert / normalizeTitle 保留小数）、`EventEntityInternalRouter`（POST 物化 + GET 列表，信封恒 code:200，独立 internal token）、`index.ts` 挂载 `/internal/event-entities`。
- **agent-py**：`EventRecord` 增 `app_event_id`/`app_event_status` 可选字段；`_materialize_event_entity` 有明确绝对日期即物化（未来 scheduled / 已发生 occurred 都 POST，time_confidence=0.9）；物化循环在传导前原地回填 app id/status；`event_conduction` 守卫：`scheduled|upcoming` → 跳过已发生传导（`event_conduction_phase="pre"`，红线 §6.2）；`event_persister` content 加性回写 `appEventId/appEventStatus`。
- **switch**：`event_entity_enabled` 默认 **False**（翻转前行为逐字节不变）。

---

## 1. 部署顺序（必须按序，不可打乱）

### 第 1 步：app-api 部署 + 应用 019 迁移

```bash
cd /home/aistock/aistock-app-api
git pull origin master            # 合并 PR #116 后

# 部署（npm install + tsc 编译 + pm2 重启，或按现有 deploy 流程）
npm install && npx tsc && pm2 restart aistock-api

# ⚠️ 关键：手工应用 019 迁移（app-api 启动时不会自动建 event_entities 表）
# 方式 A（docker 环境，对齐现有 deploy.sh 先例）：
docker exec -i pg psql -U aistock -d aistock < src/db/migrations/019_event_entities.sql
# 方式 B（psql 直连）：
psql -h 127.0.0.1 -p 5432 -U aistock -d aistock -f src/db/migrations/019_event_entities.sql
```

**验证**：确认表存在且索引就位

```sql
\d event_entities
-- 期望看到：canonical_event_key UNIQUE、idx_event_entities_start_status 部分索引
```

### 第 2 步：agent-py 部署（先不翻开关）

```bash
cd /home/aistock/aistock-agent-py
git pull origin main             # 合并 PR #137 后
pm2 restart aistock-agent        # 默认 EVENT_ENTITY_ENABLED=false，本次重启不启用新功能
```

> 此时 Event Entity 全程短路，线上行为与部署前逐字节一致，可正常观察灰度。

### 第 3 步：核对生产端点配置（翻开关前）

agent-py 通过 `settings.node_api_base_url`（默认 `http://localhost:3000`）+ `internal_api_token` 调 app-api。请核对生产配置：

- `NODE_API_BASE_URL` 指向 app-api 可达地址（同机默认 localhost:3000 即可）
- `INTERNAL_API_TOKEN` 与 app-api 的 `.env` 中 `INTERNAL_API_TOKEN` **完全一致**（本地为 `hTElt...`，生产以实际值为准）
- 简测端点可达：

```bash
curl -s -H "X-Internal-Token: <token>" http://127.0.0.1:3000/internal/health
# 或直接 GET event-entities（空库应返回 code:200 + items:[]，而非 502/404）
curl -s -H "X-Internal-Token: <token>" http://127.0.0.1:3000/internal/event-entities
# 期望 {"code":200,"data":{"items":[]}}  ← 表存在且端点挂载成功
```

### 第 4 步：翻开关启用（仅第 1-3 步全部通过后）

```bash
# 在 agent-py 生产环境变量中加入：
# EVENT_ENTITY_ENABLED=true
pm2 restart aistock-agent
```

---

## 2. 翻开关后观察重点（前几次抓取）

必须盯日志，不要只看"服务还活着"：

| 日志特征 | 含义 | 处置 |
|----------|------|------|
| `event_entity_materialized` event_id=... | 物化成功（200） | ✅ 正常 |
| `event_entity_materialize_failed` | 端点失败（非 200/异常/表缺失） | ⚠️ 回查第 1 步 019 是否应用、token 是否一致 |
| `event_entity_materialize_skipped` | 响应无 event_id | ⚠️ 回查端点返回体 |
| `EVENT_CONDUCTION_FILTER event_status=scheduled reason=future_event_pre_phase` | 未来事件被守卫拦截，不进入已发生传导 | ✅ **预期行为**，非 bug（Pre 双套 P2 未落地，红线） |
| app-api 日志 `POST /internal/event-entities` 200 | 物化落库 | ✅ 正常 |

---

## 3. 已知边界（如实上报，非缺陷）

1. **开关翻转不回收存量标记**：开启期间已物化的 `scheduled` 事件，即使开关后关闭仍会被守卫拦截（红线优先设计意图，spec §0.3-3）。
2. **News↔Calendar 跨通道收敛**：无 calendar→entity 物化作业，News 与日历事件暂不自动归并为同一 entity（P0.5 后续对账项）。
3. **time_confidence**：本批只产 `0.9`（正则命中绝对日期）；`0.6` 相对日期分档属 P1 能力，未落地。
4. **Pre 双套传导（scheduled 事件的前瞻分析）**：P2 未落地，未来事件被守卫拦截后不进任何分析路径（接受性行为）。
5. **event_status 写库列**为 display-only 快照，读时按 now 重算为权威（GET 过滤/展示以重算值为准）。

---

## 4. 回滚预案

- **代码回滚**：`git revert` 两仓合入提交，或降级 `EVENT_ENTITY_ENABLED=false` → pm2 restart（旧行为恢复，物化全部短路）。
- **数据**：`event_entities` 表为独立新表，回滚不涉及删表，无历史影响；如需清空测试数据保留表结构：
  ```sql
  TRUNCATE event_entities;  -- 仅清数据，保留表/索引
  ```
- **存量标记**：开启期间回填到事件库的 `app_event_id`/`app_event_status` 保留——守卫消费标记属红线设计，回滚代码后字段无消费方，无副作用。