# 十倍股模块下线 — 后续修改建议

> 本次（7.20）采用**保守范围**：仅删除 tenx-score 独立模块（控制器/批量/路由/agent-py工具），保留 `TenxScoreService.ts` 共享计算函数。
> 以下为后续可逐步推进的清理项，按优先级排列。

## 1. 执行 DB 迁移（高优先级，部署前必须）

### 1.1 新增 ma60_excluded 列
```bash
# 在云服务器执行
docker exec -it pg psql -U root -d aistock -f sql/trend_scores_ma60.sql
```
- 给 `trend_scores` 表加 `ma60_excluded BOOLEAN DEFAULT FALSE` 列
- 创建部分索引加速 Top 列表查询
- 幂等设计，可重复执行

### 1.2 删除 tenx_scores 表（前端迁移后执行）
```bash
# 确认前端无页面调用 tenx-score 接口后执行
docker exec -it pg psql -U root -d aistock -f docs/sql/drop_tenx_scores.sql
```
- **前置条件**：Web 前端和 App 前端的 tenx 引用已全部清理（见下方第 2、3 节）

---

## 2. Web 前端 tenx 清理（`aistock-frontend`）

### 2.1 删除 tenxApi（`src/shared/api/api.js` 795-838 行）
- 删除 `tenxApi` 对象（6 个方法）
- 更新 `shared/AGENTS.md`、`market/AGENTS.md`、`favorites/AGENTS.md` 中的 tenxApi 引用

### 2.2 删除 TenxScoreView.vue（`src/modules/market/views/TenxScoreView.vue`）
- 整页面使用 tenxApi，需删除或重定向到趋势股评分页
- 检查路由配置中是否有 `/tenx-score` 路由需移除

### 2.3 迁移 StockDetailView.vue tenx 区块（`src/modules/favorites/views/StockDetailView.vue`）
- **工作量最大**：560-639 行模板（tenx-card/tenx-radar-canvas）、1268-1489 行逻辑（TENX_DIMS/tenxApiData/雷达图渲染）、771 行 import
- **建议方案**：将 tenx 雷达图区块替换为趋势股评分区块，复用 `trendApi`（如果已存在）或新建
- 可作为独立任务分配给前端开发者

---

## 3. App 前端 tenx 清理（`aistock-app-frontend`）

### 3.1 删除 getTenxScore（`src/shared/api/modules/stock.ts` 203-205 行）
- `getTenxScore(symbol)` 方法调用 `/cn/stocks/${symbol}/tenx-score`
- **注意**：当前 grep 未见页面调用，可能是死代码，确认后直接删除
- 此项可在 App 前端重构窗口顺便处理

---

## 4. TenxScoreService.ts 共享函数提取（中优先级）

### 现状
`TenxScoreService.ts` 同时包含：
- **共享基础设施**（被 TrendScoreService import 的 11 个符号）：`PrefetchedData`、`RawIndicators`、`DimDef`、`IndustryCache`、`prefetchAllData`、`calcEarningsExplosion`、`calcValuationElasticity`、`calcProfitQuality`、`calcCompetitiveMoat`、`calcIndustryTrack`、`calcNewsCatalyst`、`scoreIndicator`、`scoreAllIndicators`、`calcDimScore`、`vetoCheck`、`VetoError`、`getAiIndicatorScores`、`clearAiIndicatorScores`
- **tenx 业务代码**（已成死代码）：`TenxScoreService` class（`calculateTenxScore`、`getScore`）、`TenxScoreResult` interface

### 建议方案
1. 新建 `src/modules/monitor/scoreCommon.ts`，将上述共享函数迁移过去
2. `TrendScoreService.ts` 改为从 `scoreCommon.ts` import
3. `StockAnalysisAgentService.ts` 和 `StockAnalysisService.ts` 的 `setAiIndicatorScores` import 改为从 `scoreCommon.ts`
4. 删除 `TenxScoreService.ts`（此时已无消费者）
5. 更新 `quote/AGENTS.md` 跨模块依赖说明

### 注意事项
- 迁移时保持函数签名和逻辑不变，仅改文件位置
- 迁移后跑 `npx tsc --noEmit` 确认无编译错误
- `preloadThsEnhanceCache` 也应一并迁移（当前仅被已删除的 TenxBatchService 调用，可评估是否保留）

---

## 5. StockAnalysisAgentService 桥接字段重命名（低优先级）

### 现状
`StockAnalysisAgentService.ts` 和 `StockAnalysisService.ts` 通过 `setAiIndicatorScores` 将 AI 资讯打分注入评分系统，字段名为"十倍股指标打分"，硬编码在多处：
- `analysis-agent/prompts.ts:31,34` — prompt 模板
- `analysis-agent/types.ts:52` — `AgentAnalysisResult['十倍股指标打分']` 类型
- `StockAnalysisAgentService.ts:67-78,288-305` — 字段解析
- `StockAnalysisService.ts:205-221,499-518` — prompt + 解析 + DB 写入
- DB 列名 `ai_indicator_scores`

### 建议方案
- 将"十倍股指标打分"重命名为"趋势股指标打分"或"AI指标打分"
- 同步更新 prompt 模板、类型定义、解析逻辑、DB 列名（或保持列名不变仅改应用层命名）
- **功能不受影响**，仅命名问题，可延后处理

---

## 6. 验证检查清单

完成上述清理后，执行以下验证：
- [ ] `npx tsc --noEmit` 零错误（aistock-app-api）
- [ ] `node --import tsx --test tests/**/*.test.ts` 全通过
- [ ] agent-py `python -c "from aistock_agent.tools import *"` 无报错
- [ ] 全仓 grep `tenx|Tenx|TENX|十倍` 确认无残留引用（除本文档和 SQL 运维文件）
- [ ] 前端 tenx 页面已替换或删除
- [ ] DB 迁移已在服务器执行
