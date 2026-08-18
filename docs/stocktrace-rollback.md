# StockTrace 价格异动归因链路 — 回滚手册

> 本文档描述自选股午尾盘价格异动归因迁移到 stocktrace 链路后的回滚步骤。
> 每步均可在 5 分钟内独立完成，互不依赖。

---

## 回滚总览

| 优先级 | 步骤 | 影响范围 | 回滚时间 | 风险 |
|--------|------|---------|---------|------|
| 1 (最高) | 关闭 Python stock_trace_consumer | 归因结果写入 | < 1 分钟 | 低 |
| 2 | 恢复 Node.js PriceMoveService 原触发链路 | 事件触发 | < 5 分钟 | 中 |
| 3 | 前端恢复 insightNavigation 分流 | 用户侧展示 | < 5 分钟 | 低 |

---

## 步骤 1：关闭 Python stock_trace_consumer

**目标**：停止 Python 侧消费 stock_trace_events 并写入归因结果，防止新数据进入 stock_trace_results / stock_trace_artifacts。

**操作**：

1. 修改 Python 部署配置（`aistock-agent-py/.env` 或环境变量）：

   ```bash
   # 将 stock_trace_consumer_enabled 设为 false
   STOCK_TRACE_CONSUMER_ENABLED=false
   ```

2. 重启 Python agent 服务：

   ```bash
   # 生产环境（PM2）
   pm2 restart aistock-agent

   # 或 Docker 重启
   docker restart aistock-agent-py
   ```

3. 验证消费者已停止：

   ```bash
   # 检查日志，确认不再有 "stock_trace_consumer consumed event" 行
   pm2 logs aistock-agent --lines 20 | grep -i "stock_trace_consumer"

   # 或查询 PG stock_trace_results 表，确认 no new rows
   psql -h 127.0.0.1 -p 15432 -U aistock -d aistock -c \
     "SELECT count(*) FROM stock_trace_results WHERE created_at > now() - interval '5 minutes';"
   ```

**预期结果**：stock_trace_events 仍会写入（由 Node.js 触发），但不再被消费和归因。

**回滚恢复**：将 `STOCK_TRACE_CONSUMER_ENABLED` 设回 `true`，重启服务即可。

---

## 步骤 2：恢复 PriceMoveService 原触发链路

**目标**：将价格异动事件触发从 stocktrace 链路回退到旧版 insight 触发链路。

**操作**：

1. 确认当前 Task 2 的提交 SHA：

   ```bash
   git log --oneline --all | grep -i "stock.trace\|price.move\|trigger"
   ```

2. 使用 `git revert` 回退 Task 2 的触发适配提交：

   ```bash
   # 找到 Task 2 的提交 SHA（示例，实际替换）
   git revert <task-2-commit-sha> --no-edit

   # 如果 Task 2 包含多个提交，按时间倒序 revert
   git revert <sha-3> <sha-2> <sha-1> --no-edit
   ```

3. 重启 app-api 服务：

   ```bash
   pm2 restart aistock-api
   # 或
   node --import tsx src/index.ts
   ```

4. 验证原触发链路恢复：

   ```bash
   # 健康检查
   curl -s http://localhost:3000/health

   # 验证 insights 接口仍返回涨停雷达事件
   curl -s http://localhost:3000/api/cn/favorites/insights \
     -H "Authorization: Bearer <JWT>"

   # 手动触发检测（旧链路）
   curl -s -X POST http://localhost:3000/api/cn/favorites/movements/detect \
     -H "Authorization: Bearer <JWT>"
   ```

**预期结果**：PriceMoveService 恢复旧版触发逻辑，事件触发不再经过 stocktrace 链路。

**回滚恢复**：`git revert HEAD`（撤销本次 revert），重启服务。

---

## 步骤 3：前端恢复 insightNavigation 分流

**目标**：前端从 stocktrace movement 页面回退到旧版 insight 展示。

**操作**：

1. 在 `aistock-app-frontend` 仓库中定位 insightNavigation 分流代码：

   ```bash
   cd aistock-app-frontend
   grep -r "insightNavigation\|movement\|stockTrace" src/ --include="*.ts" --include="*.vue"
   ```

2. 找到分流开关/条件判断，将其恢复为旧版逻辑（始终走 insight 页面，不走 movement 详情页）。

3. 提交并部署：

   ```bash
   git add -A
   git commit -m "fix: revert insightNavigation to old insight flow"
   git push

   # H5 部署
   npm run build:h5
   ```

4. 验证前端展示：

   - 打开 H5 首页，确认卡片列表仍显示涨停雷达事件
   - 点击卡片跳转到 insight 详情页，而非 movement 详情页

**预期结果**：用户侧不再看到 movement 标签页/列表，恢复旧版 insight 展示。

**回滚恢复**：回退本次前端提交，或恢复分流开关为开启状态。

---

## 影响分析与注意事项

| 关注点 | 说明 |
|--------|------|
| 数据残留 | 回滚后 stock_trace_events/snapshots/results/artifacts 表中已存在的数据不会自动清理。如需清理，使用 `scripts/cleanup-stock-trace.sql`（需先确认无写入后执行） |
| 部分回滚 | 三步可独立回滚。例如：仅关闭 consumer（步骤 1）可保留 Node.js 触发 + 五域快照能力，只是不归因 |
| 旧版兼容 | PriceMoveService 旧版触发逻辑仍在代码中（通过 git history 恢复），无需额外开发 |
| 时序要求 | 建议先停 consumer（步骤 1），再回滚触发（步骤 2），最后改前端（步骤 3），避免 consumer 写了不完整数据 |
| 验证环境 | 生产环境回滚后，建议在预发布环境执行一次完整回归：/detect -> /insights -> 前端展示 |

---

## 快速回滚命令（生产环境一键执行）

```bash
# ===== 步骤 1：停 consumer =====
ssh root@<host> "sed -i 's/STOCK_TRACE_CONSUMER_ENABLED=true/STOCK_TRACE_CONSUMER_ENABLED=false/' /opt/aistock-agent-py/.env && pm2 restart aistock-agent"

# ===== 步骤 2：回滚触发 =====
ssh root@<host> "cd /opt/aistock-app-api && git revert <task-2-sha> --no-edit && pm2 restart aistock-api"

# ===== 步骤 3：前端回滚 =====
# 在前端仓库执行 git revert，重新部署
```

> 注意：一键执行前请先确认 `<task-2-sha>` 和 `<host>` 正确。