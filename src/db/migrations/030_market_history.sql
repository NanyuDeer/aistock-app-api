-- 030: 历史行情地基（S1）
--
-- 背景（2026-11-24，组长已授权在华为云自建数据层）：
--   「给定市场状态 → 未来 N 日收益分布」是趋势判断与事前预判的唯一地基，
--   而现有库无任何行情表（TushareKlineService 每次实时调 Tushare，150ms 节流）。
--   等价结论：这套基线必须先把历史价格落库，否则每次"跑历史"都是一次远程拉取。
--
-- 为什么从 2016 起：
--   20 日窗口下相邻交易日的未来收益高度重叠，不能按天数算样本。
--   2 年（~500 交易日）→ 独立观测仅 25 个，分 5 档每档 5 个，无统计意义；
--   2016 起（~2400 交易日）→ 独立观测 121 个，每档 24 个，是可用底线。
--   同时避开 2015 配资牛市那种极端杠杆机制，老样本与新样本可比性更好。
--
-- 【硬约束：禁止存前复权价】
--   前复权用"最新"复权因子调整历史价格，等于把未来的分红送股信息带进过去，
--   是标准的 point-in-time 泄漏。本表只存交易所原始成交价 + 当日 adj_factor，
--   复权一律在查询时按"原始价 × 截至当日的累计因子"现算。
--
-- 【硬约束：必须包含退市股】
--   只回填当前在市的 5601 只会让所有收益分位数系统性偏右（生存偏差），
--   最容易在"冰点抄底"这类状态上给出过于乐观的结论。
--   回填时需一并拉 Tushare stock_basic 里 list_status='D'（退市）与 'P'（暂停）。
--
-- 【硬约束：金额与成交量单位原样保留】
--   Tushare daily: vol 单位「手」，amount 单位「千元」；adj_factor 无单位。
--   全部原样落库并在 COMMENT 里写明，**不做任何换算**——
--   换算错误极难发现，而单位信息一旦丢失就再也补不回来。
--
-- 表规模：约 2400 交易日 × 5700 只（含退市）≈ 1370 万行，约 1.7GB（含索引）。

-- ---------------------------------------------------------------------------
-- 个股日线
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stock_daily (
    ts_code       VARCHAR(12)    NOT NULL,   -- 如 000001.SZ / 600519.SH
    trade_date    DATE           NOT NULL,
    open          NUMERIC(18,4),
    high          NUMERIC(18,4),
    low           NUMERIC(18,4),
    close         NUMERIC(18,4),
    pre_close     NUMERIC(18,4),
    change        NUMERIC(18,4),
    pct_chg       NUMERIC(10,4),
    vol           NUMERIC(20,2),             -- 单位：手
    amount        NUMERIC(20,4),             -- 单位：千元
    adj_factor    NUMERIC(18,6),             -- 当日复权因子（无单位）
    backfilled_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (ts_code, trade_date)
);

COMMENT ON TABLE stock_daily IS
    '个股日线（交易所原始价 + 当日复权因子）。禁止存前复权价，复权在查询时现算。';
COMMENT ON COLUMN stock_daily.adj_factor IS
    '当日复权因子。累计复权价 = 原始价 × (当日因子 / 基准日因子)；不得用最新因子调历史。';
COMMENT ON COLUMN stock_daily.vol IS '成交量，单位「手」（Tushare 原始口径，未换算）';
COMMENT ON COLUMN stock_daily.amount IS '成交额，单位「千元」（Tushare 原始口径，未换算）';
COMMENT ON COLUMN stock_daily.backfilled_at IS
    '本行写入时刻。早于 2026-11 的日期均为事后回填，不是"当时可得"，做严格 PIT 时必须区分。';

-- 全市场按日扫（截面计算）：主键是 (ts_code, trade_date)，此索引供按日取全市场
CREATE INDEX IF NOT EXISTS idx_stock_daily_date
    ON stock_daily (trade_date);

-- ---------------------------------------------------------------------------
-- 指数日线
-- ---------------------------------------------------------------------------
-- 指数不复权（指数本身为价格指数，无分红调整概念），无需 adj_factor。
CREATE TABLE IF NOT EXISTS index_daily (
    ts_code       VARCHAR(12)    NOT NULL,   -- 如 000300.SH / 000001.SH / 399006.SZ
    trade_date    DATE           NOT NULL,
    open          NUMERIC(18,4),
    high          NUMERIC(18,4),
    low           NUMERIC(18,4),
    close         NUMERIC(18,4),
    pre_close     NUMERIC(18,4),
    change        NUMERIC(18,4),
    pct_chg       NUMERIC(10,4),
    vol           NUMERIC(20,2),
    amount        NUMERIC(20,4),
    backfilled_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (ts_code, trade_date)
);

COMMENT ON TABLE index_daily IS '指数日线。指数为价格指数，无复权概念。';

CREATE INDEX IF NOT EXISTS idx_index_daily_date
    ON index_daily (trade_date);

-- ---------------------------------------------------------------------------
-- 两融汇总（市场级）
-- ---------------------------------------------------------------------------
-- 用途：筹码结构判定的基础。「融资盘还没出清所以还没见底」这类判断，
--       在系统里此前没有任何数据入口（两融已取但未落独立表、未接归因）。
-- 口径：Tushare margin 接口为交易所汇总（SSE / SZSE / BSE），每日 3 行，体量极小。
--       个股两融明细（margin_detail）另表，仅在需要个股级杠杆水位时再落。
CREATE TABLE IF NOT EXISTS margin_daily (
    trade_date    DATE           NOT NULL,
    exchange_id   VARCHAR(8)     NOT NULL,   -- SSE / SZSE / BSE
    rzye          NUMERIC(20,4),             -- 融资余额，单位：元
    rzmre         NUMERIC(20,4),             -- 融资买入额，单位：元
    rzche         NUMERIC(20,4),             -- 融资偿还额，单位：元
    rqye          NUMERIC(20,4),             -- 融券余额，单位：元
    rqyl          NUMERIC(20,4),             -- 融券余量，单位：股
    rqmcl         NUMERIC(20,4),             -- 融券卖出量，单位：股
    rqchl         NUMERIC(20,4),             -- 融券偿还量，单位：股
    rzrqye        NUMERIC(20,4),             -- 融资融券余额，单位：元
    backfilled_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (trade_date, exchange_id)
);

COMMENT ON TABLE margin_daily IS
    '两融汇总（交易所级）。单位均为元/股，Tushare 原始口径未换算。';
COMMENT ON COLUMN margin_daily.rzye IS
    '融资余额。「融资盘是否出清」= 融资余额相对近期高点回落幅度，需配合价格序列判断。';

-- ---------------------------------------------------------------------------
-- 北向与互联互通资金
-- ---------------------------------------------------------------------------
-- 注意（2024 起）：北向资金已取消盘中实时披露，只有日度成交额。
-- 因此本表只能回答"昨天谁在买"，不能回答"今天盘中谁在买"。
CREATE TABLE IF NOT EXISTS moneyflow_daily (
    trade_date    DATE           NOT NULL,
    ggt_ss        NUMERIC(20,4),             -- 港股通（上海），单位：百万元
    ggt_sz        NUMERIC(20,4),             -- 港股通（深圳），单位：百万元
    hgt           NUMERIC(20,4),             -- 沪股通，单位：百万元
    sgt           NUMERIC(20,4),             -- 深股通，单位：百万元
    north_money   NUMERIC(20,4),             -- 北向资金，单位：百万元
    south_money   NUMERIC(20,4),             -- 南向资金，单位：百万元
    backfilled_at TIMESTAMPTZ    NOT NULL DEFAULT now(),
    PRIMARY KEY (trade_date)
);

COMMENT ON TABLE moneyflow_daily IS
    '互联互通资金日度。单位「百万元」（Tushare moneyflow_hsgt 原始口径）。';
COMMENT ON COLUMN moneyflow_daily.north_money IS
    '北向资金净流入。2024 起仅日度值，无盘中实时；不得声称"盘中北向流入"。';

-- ---------------------------------------------------------------------------
-- 复权因子基准说明（不做表，仅约束）
-- ---------------------------------------------------------------------------
-- 复权价计算方式（查询时）：
--   假设基准日 B 的因子为 f_B，目标日 T 的因子为 f_T：
--     后复权价 = 原始价_T × (f_T / f_首日)
--     等权价   = 原始价_T × (f_T / f_B)        -- B 固定为样本区间起点
--   两种都不泄漏未来信息。**唯一禁止的是用 f_最新 去调整历史。**
