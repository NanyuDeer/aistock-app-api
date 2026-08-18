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
   # 生产机（Linux）：
   pm2 logs aistock-agent --lines 20 2>&1 | grep "stock_trace_job_completed"

   # 或本地 PowerShell（通过 SSH）：
   ssh root@<host> "pm2 logs aistock-agent --lines 20 2>&1" | Select-String "stock_trace_job_completed"

   # 或查询 PG stock_trace_results 表，确认 no new rows
   psql -h 127.0.0.1 -p 15432 -U aistock -d aistock -c \
     "SELECT count(*) FROM stock_trace_results WHERE created_at > now() - interval '5 minutes';"
   ```

**预期结果**：stock_trace_events 仍会写入（由 Node.js 触发），但不再被消费和归因。

**回滚恢复**：将 `STOCK_TRACE_CONSUMER_ENABLED` 设回 `true`，重启服务即可。

---

## 步骤 2：恢复 PriceMoveService 原触发链路

**目标**：将价格异动事件触发从 stocktrace 链路回退到旧版 insight 触发链路。

**背景**：Task 2 由两个提交组成，将午/尾盘触发从 PriceMoveService 直接写 insight 改为经 stocktrace 事件层路由：

  - `77d108b` — feat(insight): route midday/close price move trigger into stock-trace event layer
  - `c66374c` — fix(insight): apply eligible price security filter in midday/close trigger

**操作**：

1. 确认当前在 `junliang` 分支，且 HEAD 包含上述两个提交：

   ```bash
   git log --oneline -5
   # 预期显示 77d108b 和 c66374c
   ```

2. 使用 `git revert` 回退 Task 2 的两个提交（按时间倒序，先 revert 新提交）：

   ```bash
   # 精确指定两个 SHA（按时间倒序）
   git revert c66374c 77d108b --no-edit
   ```

   > **注意**：revert 会同时恢复被注释停用的 11:50 补抓 cron（`50 11 * * 1-5` refetchMiddayEvidence，见 `src/index.ts` L684-693）。该 cron 在 2026-08-15 迁移时因 stocktrace 以 revision 机制处理盘中变化而被注释停用。revert 后该 cron 恢复注册，如仍需保持停用请重新注释。

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
   ```

   **验证旧链路（价格异动）**：`/insights` 只能验证涨停雷达，无法证明价格异动旧链路已恢复。需通过以下方式验证：

   - 等待 cron 触发：午盘 11:30 / 尾盘 15:05 自动触发 `PriceMoveService.run()`
   - 或手动调用 `PriceMoveService.run('midday')` 或 `PriceMoveService.run('close')`，通过临时脚本或路由（需临时添加）：

     ```bash
     # 方式 A（推荐）：临时脚本文件
     # 新建 scripts/manual-trigger-pricemove.ts：
     #   import { PriceMoveService } from '../src/modules/insight/PriceMoveService';
     #   PriceMoveService.run('midday').then(r => { console.log(r); process.exit(0); })
     #     .catch(e => { console.error(e); process.exit(1); });
     node --import tsx scripts/manual-trigger-pricemove.ts

     # 方式 B：npx tsx -e（tsx 支持 ESM 内联，不受 CJS 默认模式限制）
     npx tsx -e "
       import { PriceMoveService } from './src/modules/insight/PriceMoveService';
       PriceMoveService.run('midday').then(r => { console.log(r); process.exit(0); })
         .catch(e => { console.error(e); process.exit(1); });
     "
     ```

   **预期结果**：PriceMoveService 恢复旧版触发逻辑，事件触发不再经过 stocktrace 链路。

**回滚恢复**：`git revert HEAD~2..HEAD`（撤销本次 revert），重启服务。

---

## 步骤 3：前端恢复 insightNavigation 分流

**目标**：前端从 stocktrace movement 页面回退到旧版 insight 展示。

**背景**：Task 5 提交 `034380f`（feat(movement): add detail page and switch price-move navigation to movement-detail）将前端价格异动导航指向 movement 详情页。

**操作**：

**方式 A（推荐）—— git revert 精确回退**：

```bash
cd aistock-app-frontend
git revert 034380f --no-edit
```

**方式 B（手动修改）**：

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

**预期结果**：用户侧不再看到 movement 标签页/列表，恢复旧版 insight 展示。movement 页面文件留存但不可达。

**回滚恢复**：回退本次前端提交，或恢复分流开关为开启状态。

---

## 影响分析与注意事项

| 关注点 | 说明 |
|--------|------|
| 数据残留 | 回滚后 stock_trace_events/snapshots/results/artifacts 表中已存在的数据不会自动清理。如需清理，使用 `scripts/cleanup-stock-trace.sql`（需先确认无写入后执行） |
| 部分回滚 | 三步可独立回滚。例如：仅关闭 consumer（步骤 1）可保留 Node.js 触发 + 五域快照能力，只是不归因 |
| 旧版兼容 | PriceMoveService 旧版触发逻辑仍在代码中（通过 git history 恢复），无需额外开发 |
| 时序要求 | 建议先停 consumer（步骤 1），再回滚触发（步骤 2），最后改前端（步骤 3），避免 consumer 写了不完整数据 |
| 11:50 补抓 cron | 步骤 2 revert 会恢复被注释停用的 `50 11 * * 1-5` refetchMiddayEvidence cron。如需要保持停用，请在 revert 后重新注释 `src/index.ts` 对应代码段 |
| 验证环境 | 生产环境回滚后，建议在预发布环境执行一次完整回归：等待 cron 触发 PriceMoveService.run -> /insights -> 前端展示 |

---

## 快速回滚命令（生产环境一键执行）

```bash
# ===== 步骤 1：停 consumer =====
ssh root@<host> "sed -i 's/STOCK_TRACE_CONSUMER_ENABLED=true/STOCK_TRACE_CONSUMER_ENABLED=false/' /opt/aistock-agent-py/.env && pm2 restart aistock-agent"

# ===== 步骤 2：回滚触发 =====
ssh root@<host> "cd /opt/aistock-app-api && git revert c66374c 77d108b --no-edit && pm2 restart aistock-api"

# ===== 步骤 3：前端回滚 =====
ssh root@<host> "cd /opt/aistock-app-frontend && git revert 034380f --no-edit && npm run build:h5"
```

> 注意：一键执行前请先确认目标 `<host>` 正确。步骤 2 revert 会恢复 11:50 补抓 cron，如需保持停用请重新注释 `src/index.ts` 中 `50 11 * * 1-5` 代码段。