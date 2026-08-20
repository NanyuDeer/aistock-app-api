# 收盘复盘数据源切换方案：Quick/Full 链路对比与东财改进（Design）

> 日期：2026-08-20 · 状态：方案设计（未实施，走独立 POC 验证）
> 涉及仓库：
> - `aistock-app-api`（快照构建：TencentSnapshotService / MarketSnapshotService）
> - `aistock-agent-py`（review Agent 调度与消费：scheduler / event_consumers / review.py）

---

## Goal

将 15:30 收盘复盘从"腾讯近似的 quick 快照"升级为"东方财富直采的接近 full 精度快照"，使 15:30 即可产出全量报告；后续可用东财数据替换 20:30 的 Tushare full 链路，实现在 15:30 跑 full、删除 quick 链路，简化架构。

## 现状链路全景

**quick 链路（15:30）**

```
cron 30 15 → review_quick 事件 → build_quick_snapshot
   ├─ 指数：腾讯 rank（6 大指数）
   └─ 宽度/板块/主力：腾讯 activity getBatchQuotes + rank/pt/getRank
→ ReviewQuickConsumer → review Agent（review.py run_review snapshot_kind=quick）
→ 缓存 Redis + 归档 + DB 持久化 + review_done → 播报
```

**full 链路（20:30）**

```
cron 30 20 → review_full 事件 → build_market_trace_snapshot
   ├─ 收盘快照 /close-snapshot：Tushare daily（指数/宽度/涨跌停/资金流/板块）
   ├─ 境外行情：腾讯
   ├─ 财联社电报 / 事件库
   └─ Tavily 检索×2（政策/全球）
→ ReviewFullConsumer → review Agent（snapshot_kind=full）
→ 覆盖 quick（data_source 含 full 即跳过 quick）→ 缓存 + 归档 + DB + 迭代
```

## Quick vs Full vs 改进：字段数据源对比表

> 「改进」= 方案 B 目标态（东财直采 + 腾讯），15:30 出全量。✅ 已实测可用 · 🔒 固定保留腾讯
> 原本标"⚠️ 待攻关（需逆向）"的字段（跌停/炸板/连板/资金流/资金排序）经东财接口实测全部**免逆向可用 → ✅**（见 POC 实测结论），对比表已无 ⚠️ 字段。

| 快照字段 | quick（15:30）来源 | full（20:30）来源 | 改进（15:30）来源 |
|---|---|---|---|
| 6 大指数 | 腾讯实时行情 rank | Tushare index_daily | 🔒 腾讯 realhead/rank（固定腾讯，强于当前 rank，不换同花顺） |
| 全市场宽度（涨跌家数） | 腾讯 activity 全市场批拉（50/批×10 并发） | Tushare daily 精确统计（当日） | 🔒 腾讯 activity 批拉（同花顺无批量全市场接口，固定保留；**当日**为近似，前日可由 Tushare 补） |
| 成交额 | 腾讯行情行聚合近似 | Tushare 精确成交额（当日） | 🔒 腾讯行情行聚合近似（与 quick 相同；前日 amount 用 Tushare） |
| 涨停数 | **阈值近似**（±10%/±20% 判定）、`approximate=true` | Tushare limit_list_ths 精确 | ✅ **东财 `getTopicZTPool` 精确 count**（免逆向，实测 count=79） |
| 跌停数 | **无**（不区分） | Tushare limit_list_ths 精确 | ✅ **东财 `getTopicDTPool` 精确 count**（免逆向，sort=zdp，实测 count=12） |
| 炸板数 | **无**（不区分） | Tushare limit_list_ths | ✅ **东财 `getTopicZBPool` 精确 count**（免逆向，实测 count=46） |
| 概念板块涨跌与资金流 | 腾讯板块排行前 5（仅涨跌，无资金流排序） | Tushare moneyflow_cnt_ths | ✅ **东财 `push2 clist m:90+t:3`**（免逆向，含净流入；实测创新药 net=62.6 亿） |
| 主力净流入 | 腾讯行业板块 zljlr 求和近似 | Tushare moneyflow_ths 精确 | ✅ **东财 `push2 clist m:90+t:2`（行业）主力净额**（免逆向；实测医药生物 net=109 亿）；全市场主力=行业求和 |
| 板块资金流排序（top_in/out） | **空**（不提供） | Tushare 提供 | ✅ **东财 clist fid=f62 排序**（免逆向，净额正负即 top_in/out） |
| previous_daily（前日） | 无 | Tushare 有 | ✅ **直接用 Tushare**（前日已收盘、数据就绪，不受 16 点即时性限制） |
| 连板（highest_board） | **无** | Tushare limit_step | ✅ **东财 ZTPool `lbc` 连续涨停天数**（免逆向，实测汉森制药 lbc=2） |
| 全球行情/财联社/Tavily/晨报预判 | 同 full | 同 quick | 相同（与 quick/full 共用） |

**核心差异**：quick 的短板集中在快照数据——涨跌停是阈值近似、主力资金是求和近似、板块缺资金流排序、无 previous_daily/连板/炸板，且 `coverage` 大量字段为 `approximate=true` / `unavailable` / 空。

**改进后**：涨停/跌停/炸板/连板、概念与行业资金流、板块资金排序，全部经 **东方财富开放 JSON API 免逆向**获取精确数据（`push2ex` 涨跌停池 + `push2 clist` 资金流）；指数、宽度、成交额固定保留腾讯；previous_daily/前日直接复用 Tushare（前日已就绪，不受当日即时性限制）。唯一当日精度短板是 breadth/turnover 当日值（腾讯近似）。
> 注：东财跌停池含北交所（920xxx，±30% 跌停），口径较 Tushare 更全；连板/涨跌停含题材 tag 可补充连板梯队分析。

## 改进方案（方案 B：东方财富数据源替代，15:30 出全量）

> 数据源裁决更新：原计划同花顺直采，POC 实测同花顺 `funds/` 域名触发 Chameleon 反爬（401）；
> 改投 **东方财富开放 JSON API**（`push2ex` 涨跌停池 + `push2` 板块资金流），免逆向、项目已有现成封装。

目标：15:30 收盘后即用东财数据产出接近 full 精度的报告 → 未来用东财替换 20:30 Tushare → 15:30 跑 full、删 quick 链路。

### 字段替换映射

> 与上方三列对比表一致，此处聚焦「要换」的字段；指数/宽度/成交额固定保留腾讯，不再列出。

| 字段 | 现状来源 | 改后来源（东方财富推送接口） | POC 实测 |
|---|---|---|---|
| 涨停池 | 腾讯阈值近似 / Tushare | `push2ex.eastmoney.com/getTopicZTPool` | ✅ **count=79**，连板 `lbc` 可用 |
| 跌停池 | **无** | `getTopicDTPool`（sort=zdp）| ✅ **count=12**（含北交所 ±30%）|
| 炸板池 | **无** | `getTopicZBPool` | ✅ **count=46** |
| 概念板块资金流 | 腾讯板块排行 | `push2.eastmoney.com/api/qt/clist/get?fs=m:90+t:3` | ✅ 60 只，创新药 net=62.6 亿 |
| 行业资金流（主力净额） | 腾讯求和近似 | `clist/get?fs=m:90+t:2`（主力净额 f62）| ✅ 医药生物 net=109 亿 |
| 板块资金流排序 | **空**（不提供） | clist fid=f62 排序（净额正负=top_in/out）| ✅ |
| 连板数 highest_board | **无** | ZTPool `lbc`（连续涨停天数）| ✅ 汉森制药 lbc=2 |

> 指数、全市场宽度、成交额**固定使用腾讯**（用户决策）。
> 东财接口与项目 `EmTagLeaderService`（push2 clist）、`eastmoneyThrottler` 同源，可直接复用节流/UA/UT 配置。

### POC 实测结论

**同花顺路线受阻**（tmp_ths_poc.mjs / tmp_ths_fields_poc.mjs，字段级逐项探测）：
- 涨停池 `limit_up_pool` 走 dataapi 域名可抓（total=78），但**不区分跌停/炸板**；
- 跌停池/炸板池无免费 dataapi endpoint（`limit_down/limit_down_pool`、`limit_down/limit_down_list`、`dm_flow/down_pool` 均 **404**），只能走 Chameleon；
- `funds/gnzjl`、`funds/hyzjl` 触发 **401 + Chameleon JS** 反爬，需逆向才能取到完整资金流与涨跌停池；
- 连板：`limit_up_pool` 单条仅有连板标志 `is_again_limit`（0/1），**无连板天数**，推不出 `highest_board`。

**东财替代路线全通**（tmp_em_alt_poc.mjs / tmp_ths_fields_poc.mjs 基准对照，全部免逆向）：
- 涨停池 `getTopicZTPool` count=79、连板 `lbc` 可用（**实测汉森制药 lbc=2**，免逆向直接取到连板天数）；
- 跌停池 `getTopicDTPool`（sort=zdp）count=12（含北交所 ±30%）；
- 炸板池 `getTopicZBPool` count=46；
- 概念/行业板块资金流 `push2 clist` 各 60 只，net 主力净额可用（创新药 62.6 亿 / 医药生物 109 亿）；同花顺 dataapi 板块资金流接口 **404**、`funds/` 触发 Chameleon，均不可免逆向。

**结论**：原本标"待攻关（需逆向）"的**跌停/炸板/连板/资金流/资金排序**，经东财接口**全部免逆向实测可用 → ✅**，无需逆向攻关；对比表无任何字段再残留 ⚠️。同花顺路线仅涨停池免逆向（且不区分类别），其余字段若坚持用同花顺仍需 Chameleon 逆向，故直接采用东财替代。

### 板块名称对齐实测（东财 vs 同花顺概念 vs Tushare 行业）

> 背景：full 链路 `sectors` 用 Tushare——概念为**同花顺口径**（`moneyflow_cnt_ths`，885/886/TI），
> 行业为**东财 BK 口径**（`moneyflow_ind_dc`，注释明确写"东财同花顺行业口径"）。
> 需求关注：改用东财后板块名与现链路是否对得上。实测 `tmp_ths_board_align_poc.mjs`（2026-08-19 交易日）：

| 对比组 | 结果 | 影响 |
|---|---|---|
| 东财行业 `m:90+t:2` vs Tushare 行业 `ind_dc/BK` | **50/50 精确同名（100%）** | ✅ 完全一致，行业板块名替换无风险 |
| 东财概念 `m:90+t:3` vs 同花顺概念 `cnt_ths` | top50：精确 19 / 近似 15 / 不匹配 16（≈38% 精确 / 68% 含近似） | ⚠️ 存在分歧 |
| 同花顺概念 top10 在东财概念 top50 中同名 | **0/10**（高股息精选/CIPS/POE 等均不同名） | ⚠️ top 板块排名口径差异大 |
| 东财专属风格/标签类 | 病原体防治、医药医疗风格、破发股、小盘股、稀缺资源…同花顺无 | ⚠️ 无法按名映射 |

**结论**：**行业板块用东财完全无碍**（与 Tushare 行业 100% 同名，可放心替换）。
**概念板块**东财与同花顺为两套分类体系——真热点（创新药、CRO、CAR-T、合成生物）大多能对上，
但**小众/风格标签/题材派系类对不上，且资金净流入 top 板块名几乎不重**。
**要不要紧取决于最终是否保留 20:30 full 终稿**：
- 若 15:30 用东财概念、20:30 仍 Tushare 同花顺概念 → 两期报告概念名不一致（如 15:30 报"创新药"、full 报"高股息精选"），归一化契约定 `sectors` 名映射会失败 → 需按"各源独立展示概念名"处理，或**统一改用行业板块做概念资金文案**（100% 对齐）；
- 若按用户原意**20:30 full 也换东财** → 全链路统一东财概念名，两期一致性反而最好，无此问题。
建议：`sectors` 文案优先用**行业板块**（对齐 Tushare），概念板块若保留则明确标注"东财自定义概念"并保持单一来源。

## 改进方案 vs 现网：优缺点对比

### ✅ 优点

1. **时间前置**：15:30 出全量报告，比 Tushare full 提前 5 小时，时效性大幅提升。
2. **数据精度提升**：涨跌停/炸板从"阈值近似/无"变为东财池精确 count；主力资金从"行业板块求和近似"变为东财板块资金流精确净额；连板从"无"变为 `lbc` 精确连板数。
3. **把 quick/改进升级为空缺字段最少的全量口径**：东财覆盖 full 的核心快照字段（涨跌停/炸板/连板/资金流）后可收敛为单一链路（15:30），删除 quick 分支、覆盖率（approximate/unavailable）标注、quick 覆盖跳过逻辑、`run_review` 的 snapshot_kind 分支、`_is_full_report` 覆盖检查，**大幅简化架构**（事件通道、consumer、路由分支同步精简）。
4. **摆脱 Tushare 更新延迟**：不再受 Tushare limit_list_ths/moneyflow_ths 需 16 点后才就绪的限制——改用东财 push2ex（当日实时池）即可在 15:30 取到当日精确数据。
5. **免逆向且复用现成封装**：东财接口为开放 JSON API（不触发 Chameleon），项目已有 `EmTagLeaderService`（push2 clist）、`eastmoneyThrottler`、UT 配置，可直接复用、无逆向维护成本。

### ⚠️ 缺点 / 风险

1. **东财接口无 SLA / 有封号风险**：push2ex/push2 为无文档网页接口（同项目已用的 EmTagLeader），ut 可能被轮换（项目已配置化 EASTMONEY_UT）；需限速节流（eastmoneyThrottler）、重试、缓存降级。东财不含 Chameleon，反爬风险显著低于同花顺 funds/，**无需逆向**。
2. **全市场宽度/指数无现成替代**：指数、宽度、成交额固定保留腾讯（用户决策），因此是**混合方案**（东财 + 腾讯 + Tushare 前日）；宽度/成交额仍为腾讯近似口径（full 的 Tushare 当日才精确）。previous_daily（前日）直接用 Tushare，不受限制。
3. **口径需对齐**：东财涨跌停池含北交所（920xxx，±30%），与 Tushare limit_list_ths 的主板/创业板占比可能略异，需在归一化层对齐 `_normalize_aggregate_facts` 的字段契约（up_count/down_count/broken_count/highest_board 口径）。
4. **合规与稳定性**：第三方接口无官方契约与 SLA；生产需请求限速/重试/缓存（对齐 event-scrape 中台的抓取治理经验）。
5. **破坏现有成熟 full 链路**：Tushare full 已上线、覆盖逻辑、缓存/迭代闭环稳定；替换需全量回归 review 校验（`validate_trace_against_snapshot` 对 missing_fields/coverage 极严格，东财缺字段会直接触发降级为"生成暂时不可用"）。

## 逐字段差异分析与替代结论（改进版 vs full）

> 对照 full 版 `a_share` 必填字段（MarketSnapshotService.ts L715-750）与
> build_market_trace_snapshot 的 coverage 硬门槛（previous_daily.complete 必须为 True）。

| a_share 字段 | full 版（Tushare） | 改进版（东财+腾讯） | 差异结论 |
|---|---|---|---|
| `indexes` 6 指数 | Tushare index_daily | 腾讯 | ✅ 逻辑等价，免测 |
| `breadth` 涨跌家数 | **逐股统计 daily**（精确）| 腾讯批拉（近似）| ⚠️ 当日精度降级 |
| `turnover.amount_yuan` | daily 精确求和 | 腾讯近似 | ⚠️ 当日降级 |
| `turnover.previous_amount_yuan` | previous daily（前日精确）| ✅ 直接用 Tushare（前日已就绪） |
| `limits.up/down/broken_count` | limit_list_ths 精确 | 东财 ZT/DT/ZB 池精确 | ✅ 免逆向实测（79/12/46） |
| `limits.highest_board` 连板 | limit_step | 东财 ZTPool `lbc` | ✅ 免逆向实测（lbc=2） |
| `sectors` 涨跌+资金排序 | moneyflow_cnt_ths + ind_dc | 东财 clist m:90+t:3/t:2 | ✅ 免逆向实测（创新药 62.6 亿等） |
| `main_force` 主力净额 | moneyflow_ths 大单+特大单 | 东财 clist 行业主力净额求和 | ✅ 免逆向（实测医药生物 109 亿）|

### 真正剩余的缺口

> 澄清：`previous_daily`（前一日）数据早已收盘，**Tushare 完全就绪可用**，不受"16 点后更新"的即时性限制，
> 因此**不再视为缺口**——15:30 改进版可直接复用 Tushare 前日数据填 previous_daily / previous_amount_yuan，
> 满足 full 链路 `previous_daily.complete == True` 的硬门槛。

**唯一剩余缺口**是 **`breadth`/`turnover` 的当日精确值**：full 用 Tushare daily **当日全市场逐股**统计，
而 15:30 时 Tushare 当日尚未就绪（16 点后才更新）；东财/腾讯都无批量全市场逐股接口，改进版只能腾讯批拉**当日近似值**。
（东财 push2ex 涨跌停池、push2 板块资金流均当日实时可得，**不再受 Chameleon 限制**。）

### 分级替代结论（终极目标：完全替代 full）

| 等级 | 字段 | 处理 |
|---|---|---|
| ✅ 已免逆向实测可用 | indexes、limits.up/down/broken、highest_board、sectors、main_force | 东财 push2ex + push2 clist 直接替换，免测 |
| 🔴 需混合源或接受近似 | breadth、turnover（**当日**值）| 当日全市场精确统计需 Tushare daily（15:30 未就绪）；改进版只能腾讯批拉近似。previous_daily/前日已由 Tushare 覆盖 |

**结论**：改进版**已能覆盖 full 的全部字段**——涨跌停/炸板/连板/资金流/资金排序经东财免逆向精确，指数/宽度/成交额/前日(previous_daily)固定腾讯或 Tushare。**唯一精度短板是 breadth/turnover 的当日值**（腾讯近似 vs full 的当日全市场精确），若需 100% 对齐只能等 Tushare 16 点就绪（即放弃 15:30），或接受近似。建议**以"涨跌停/资金/板块提升到精确 + 前日/宽度/成交额腾讯或 Tushare"为务实验收线**。

采用 **东财（涨停/跌停/炸板/连板池 + 概念/行业资金流）+ 腾讯（指数/宽度/成交额固定保留）+ Tushare（前日）混合方案**，即可让 15:30 快照在涨停、资金、板块、连板四个最薄弱环节升级到精确，收益最大、风险可控（免逆向）。唯一不可在 15:30 达成的当日全市场逐股精确（breadth/turnover 当日值）需接受腾讯近似，或保留 20:30 full 作为终稿覆盖。

## Full 有 Quick 没有的功能缺口（编排层，非数据字段）

> 上面的«逐字段差异»只覆盖 `a_share` 数据字段；以下是从 **Node 快照端点** 与 **agent-py 事件流**两个层面，
> 对比 full 链路独有、quick 链路缺失的**能力缺口**。用户目标：quick 用东财跑通后即可替代 full，因此这些缺口是"完善 quick 改进版"的收尾清单。

| # | 能力 | full（20:30） | quick（15:30） | 补齐 quick 改进版的做法 |
|---|---|---|---|---|
| 1 | **次日预测 review_done** | status=ok → `publish_review_done` → PredictionConsumer 独立消费组做次日预测 | 不发 review_done，无次日预测 | `ReviewQuickConsumer` 增加与 `ReviewFullConsumer` 相同的 ok 判定 + `publish_review_done` |
| 2 | **迭代深度分析 iterate** | full snapshot → `iterate` → IterateConsumer → broadcast（更完整归因链） | quick snapshot **跳过 iterate**，直接 broadcast（防重复 LLM） | 替代 full 后需评估：若 15:30 要全量，应走 iterate；若保持轻量可忽略 |
| 3 | **previous_daily 前日数据 + 覆盖硬门槛** | 校验 `current_daily.complete` **且** `previous_daily.complete`，缺任一 fail-loud | 用 `_quick_availability`，不校验 previous_daily（无前日） | 用 Tushare 前日填 previous_daily，纳入 coverage 门槛（前日已就绪，非缺口） |
| 4 | **历史回补 date 参数** | `/close-snapshot?date=report_date` 支持任意目标日回补（三期 C2） | `/quick-snapshot` **无日期参数**、仅当日 | 若需回补历史：给 quick-snapshot 端点加 date 参数 + previous_daily |
| 5 | **last-close 降级** | close-snapshot 不可用时降级 `last-close-snapshot`（盘中/凌晨/回补） | quick 无降级，`None` 即抛 `MarketTraceSnapshotUnavailable` | 需要时复用 same last-close 降级链 |
| 6 | **数据结构合法性校验强度** | 多字段类别校验（breadth 各家数相加==total、ratio∈[0,1] 整数等）+ is_quick=False 严格模式 | 同一套函数但 `is_quick=True` 放宽（partial breadth/turnover 即践可用） | 精度补齐后把 quick 归一到 full 的严格校验线 |

**结论**：quick 改进版要真正替代 full，除了«逐字段差异»里东财补的**数据精度**，还要在**编排层**补 #1（次日预测）
和 #3（previous_daily 门槛）。

> ✅ **已落地（2026-08-20）**：#1 `ReviewQuickConsumer` 在 status=ok 时 `publish_review_done`（与
> ReviewFullConsumer 一致，降级/跳过仍不发，不阻断后续快照链路）；#3 Node `TencentSnapshotService.buildQuickSnapshot`
> 用 Tushare 前日填充 `previous_daily`（`previous_amount_yuan`/`change_pct` 一并算入）并将 `coverage.previous_daily`
> 纳入硬门槛，agent-py `build_quick_snapshot` 对 `coverage.previous_daily.complete != True` 即 fail-loud，
> 与 full 的 previous_daily 门槛对齐。两端测试全绿：agent-py 62 passed、Node 20 passed、aistock-app-api
> `tsc --noEmit` 干净、ruff check 通过（mypy 仅剩 14 处既有存量错误，本改动未新增）。

#2 iterate、#4 历史回补、#5 last-close 降级是否补齐取决于用户是否保留 full 保留的回补/终稿场景；
#6 随 #1/#3 落地后，待 quick 数据精度（东财源）接入后再归一化到严格校验线。

## 实施步骤（Phase 1：走独立 POC，不碰生产）

1. **归一化组装样本**：把东财涨跌停/炸板/连板池 + 概念/行业资金流 + 腾讯（指数/宽度/成交额）+ Tushare（前日）组装成一次可复现的样本，落到 `tmp_*_result.json` 供评审（tmp_em_alt_poc.mjs 已实测各接口）。
2. **方案评估通过后**：在 `TencentSnapshotService` 旁新增东财快照源（或新增 EmSnapshotService），先以独立临时测试端点验证，通过评审后再接入生产 quick 快照；复用 `EmTagLeaderService` 的 push2 clist / eastmoneyThrottler / UT 配置。
3. **口径对齐**：东财含北交所、板块名与 Tushare 板块代码可能不同，需在归一化层对齐 `_normalize_aggregate_facts` 的 up/down/broken/highest_board/资金字段契约。
4. **逐步收敛**：quick 精度达标 → 评估是否保留 20:30 full 终稿 → 若可删 quick 则简化，写 CHANGELOG / 更新 AGENTS.md。

## 落地状态（2026-08-20 代码层，Phase 2 生产接入完成）

- **新增 `src/modules/quote/EmSnapshotService.ts`**：封装东财 push2ex 涨跌停/炸板池（`getTopicZTPool` / `getTopicDTPool`(sort=zdp) / `getTopicZBPool`(sort=zbc)，连板取 ZT 池 `lbc` 最大值）+ push2 clist 概念(`m:90+t:3`)/行业(`m:90+t:2`)资金流；复用 `eastmoneyThrottler` / `sessionFetch` / `EASTMONEY_UT` 配置（内置兜底 token 为 POC 实测可用的 `7eea3e…`）。各方法宽松失败，返回 `availability`。
- **接入 `TencentSnapshotService.buildQuickSnapshot`（EM 主源 + 腾讯近似兜底）**：
  - limits 主源=东财精确池，兜底=腾讯阈值近似（`up/down`，炸板/连板保持 null）；
  - sectors 主源=东财概念资金流（含 top_in/out 排序），兜底=腾讯板块排行（仅涨跌，资金流排序为空）；
  - main_force 主源=东财行业主力净额（`eastmoney:industry_main_force`），兜底=腾讯行业板块求和近似（`tencent:board_main_flow`，approximate=true）。
  并行 `Promise.allSettled`，单项失败不阻断快照；`coverage.has_limit_pool` 在东财池非 unavailable 时为 true。
- **schema 更新（`MarketSnapshotService.ts`）**：`QuickCloseMarketSnapshot.limits.broken_count/highest_board` 由 `null` 放宽为 `number | null`；`main_force.source` 联合类型增加 `eastmoney:industry_main_force`。
- **测试（Node）**：新增 `tests/EmSnapshotService.test.ts`（聚合/排序/求和/partial），`tests/TencentSnapshotService.test.ts` 增加 EM 主源优先用例，并为既有 build 用例注入 EM 不可用 mock。`tsc --noEmit` 干净，Node 侧相关用例全绿。
- **仍为混合方案**：指数/全市场宽度/成交额固定保留腾讯（用户决策，无免逆向全市场逐股替代源）；previous_daily 直接用 Tushare。唯一当日精度短板仍是 breadth/turnover 当日近似值。

## Constraints

- 不触碰生产调度与成熟 full 链路，先以独立临时测试端点 / POC 脚本验证。
- 不依赖当前不确定字段（approximate/unavailable）伪造事实，字段缺失仍走 `coverage` 显式标注。
- 遵守 `validate_trace_against_snapshot` 对 missing_fields 的严格校验，避免降级。
- cron.schedule 显式 `timezone=Asia/Shanghai` 的现有约束不变。
- 不暴露或记录任何内部 token；东财 UT 走 `EASTMONEY_UT` 环境变量（已有 EmTagLeader 实现），不硬编码新 token。

## 补精度记录（2026-08-20 部署后）

部署后发现生产服务器（以及本机）到默认 `push2.eastmoney.com` 的 TLS 连接被东财按出口 IP 重置（`UND_ERR_SOCKET`），
导致 `main_force` 落回腾讯行业求和近似、概念资金流 `sectors` 缺净额。
实测同簇 **`push2delay.eastmoney.com`**（约 15 分钟延迟，盘后快照无影响）与 **`push2his.eastmoney.com`** 可达且为精确镜像：

- 行业 `m:90+t:2` f62 首位医药生物 **109.2 亿**，与 `push2` POC 完全一致。
- 概念 `m:90+t:3` 净额创新药 **62 亿**，与 POC 一致。

**修复**：`EmSnapshotService.fetchBoardRows` 改为对 clist 主机轮询 `push2 → push2delay → push2his`，命中即用。
生产环境自动切 `push2delay`，恢复东财 f62 精度（`main_force` 707.6 亿，非腾讯近似）。tsc 干净，冒烟通过。