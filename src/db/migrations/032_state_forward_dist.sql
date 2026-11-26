-- 032: 状态向量与前瞻分布（S2 / S3）
--
-- 背景：2026-11-25 设计定稿 docs/superpowers/specs/2026-11-25-s2-s3-state-forward-dist-design.md
--   核心结论：20 日窗口下全样本只有 132 个独立观测（2646 交易日 ÷ 20），
--   5 档每档 26 < 30 直接失效；统一降为 3 档（44/档）。分段后每档 15/15/11。
--
-- 四张表：
--   1. stock_name_hist      历史名称与 ST 状态（Tushare namechange）→ 涨跌停判定的前置
--   2. stock_industry_hist  申万一级行业归属区间（Tushare index_member）→ 板块分化度的 PIT 前置
--   3. state_daily          每交易日一行状态向量（S2）
--   4. forward_return_dist  状态档 × 未来 5/10/20 日收益分布（S3）
--
-- 【为什么必须补前两张参考表】
--   - 不补 ST 历史：ST 股 ±5% 的涨跌停会被当成"没涨停"，涨停家数系统性**下偏**，
--     且偏差单向、事后无法用统计手段纠正。
--   - 不补行业历史：只能用今天的行业分类去算 2016 年的板块分化度，
--     等于让生存下来的公司代表当年所有公司（分类层生存偏差）。
--   实测（2026-11-25）：namechange 可回溯到上市首日；index_member 的 in_date/out_date
--   覆盖 2016 年 2,782 只、2026 年 5,211 只，且**含退市股**
--   （300104.SZ 乐视网：传媒，2014-02-21 ~ 2019-05-10）。
--
-- 【口径硬约束（详见设计文档 §8）】
--   - 区间收益用 pct_chg 逐日累乘，不用 adj_factor（750 行实证已确认 pct_chg 是复权收益）
--   - 两融只用 SSE+SZSE（BSE 2023 才加入，会引入水平跳变）
--   - 收益双口径：ew_all（全市场等权，主）+ hs300（对照）
--   - 单位一律原样保留并在 COMMENT 写明

-- ---------------------------------------------------------------------------
-- 历史名称 / ST 状态
-- ---------------------------------------------------------------------------
-- 来源：Tushare namechange（ts_code, name, start_date, end_date, ann_date, change_reason）
-- 语义：start_date ~ end_date **闭区间**（乐视网 2010-08-12~2017-09-26 后接 2017-09-27），
--       end_date 为 NULL 表示该名称仍在使用。
CREATE TABLE IF NOT EXISTS stock_name_hist (
    ts_code       VARCHAR(12)  NOT NULL,
    name          VARCHAR(32)  NOT NULL,
    start_date    DATE         NOT NULL,
    end_date      DATE,
    ann_date      DATE,
    change_reason VARCHAR(32),
    is_st         BOOLEAN      NOT NULL,   -- 名称含 'ST'（含 *ST / SST / S*ST）
    backfilled_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (ts_code, start_date)
);

COMMENT ON TABLE stock_name_hist IS
    '历史名称与 ST 状态。涨跌停判定用：ST 为 ±5%、非 ST 按板块（10/20/30%）。';
COMMENT ON COLUMN stock_name_hist.is_st IS
    '名称含 ST 即视为风险警示（5% 涨跌幅）。不含退市整理期（名称含"退"）；退市整理期样本量极小，不单独建模。';
COMMENT ON COLUMN stock_name_hist.end_date IS '闭区间末日；NULL = 仍在使用。与下一条 start_date 通常相差 1 天。';

CREATE INDEX IF NOT EXISTS idx_stock_name_hist_code
    ON stock_name_hist (ts_code, start_date DESC);

-- ---------------------------------------------------------------------------
-- 申万一级行业归属历史（PIT）
-- ---------------------------------------------------------------------------
-- 来源：Tushare index_classify(level=L1, src=SW2021) 31 个行业 × index_member(is_new=Y/N)
--
-- 【数据质量：实测无重叠（2026-11-25）】
--   7,740 条区间里，同一 (ts_code, l1_code) 的重叠区对数 = **0**，数据比预期干净。
--   下方规则是防御性的（源数据将来若修订不保证不重叠），不是当前必需的补丁：
--   取行业时若多条命中，**in_date 最新者优先**；同 in_date 取 is_current=true。
--   规则不随机、不依赖查询顺序，满足"同输入同档位"的硬约束。
--
-- 【实测覆盖（2026-11-20）】
--   有成交 5,572 只 → 能定位行业 5,197 只（93.27%）。
--   缺口主要是北交所 356 只（申万不给北交所分类），缺口非北交所仅 19 只。
--   → 板块分化度必须排除北交所，否则分母会被系统性拉低。
--
-- 【已知限界】
--   行业**标签**用的是 SW2021 版（2021-12 发布），套到 2016 年属"分类版本前视"；
--   但** membership（谁在哪个行业、何时进出）是历史区间**，不是当前快照。
--   因此 sector_pit 只能标 true 到"membership 级"，标签口径漂移（SW2014→SW2021 改名/合并）未消除，
--   需在输出里注明。
CREATE TABLE IF NOT EXISTS stock_industry_hist (
    ts_code    VARCHAR(12)  NOT NULL,
    l1_code    VARCHAR(12)  NOT NULL,   -- 如 801010.SI
    l1_name    VARCHAR(32)  NOT NULL,   -- 如 农林牧渔
    in_date    DATE         NOT NULL,
    out_date   DATE,                    -- NULL = 仍在该行业
    src        VARCHAR(8)   NOT NULL DEFAULT 'SW2021',
    is_current BOOLEAN      NOT NULL,   -- index_member 的 is_new 原值
    backfilled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (ts_code, l1_code, in_date)
);

COMMENT ON TABLE stock_industry_hist IS
    '申万一级行业归属区间（含历史与退市股）。区间闭区间；out_date 为 NULL 表示仍在。';
COMMENT ON COLUMN stock_industry_hist.src IS
    '分类版本。当前只有 SW2021：membership 是历史的，标签口径是 2021 版套历史。';
COMMENT ON COLUMN stock_industry_hist.is_current IS '源表 is_new：true=当前成分，false=已调出。';

CREATE INDEX IF NOT EXISTS idx_stock_industry_hist_code
    ON stock_industry_hist (ts_code, in_date DESC);

-- ---------------------------------------------------------------------------
-- S2：每日状态向量
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS state_daily (
    trade_date            DATE         NOT NULL,

    -- D1 广度（全市场，含退市、含 ST、含北交所）
    traded_count          INTEGER      NOT NULL,   -- 当日有成交的股票数（广度分母，可复核）
    breadth_up_ratio      NUMERIC(6,4) NOT NULL,   -- 上涨家数 / traded_count
    breadth_median_pct    NUMERIC(8,4) NOT NULL,   -- 全市场中位数涨跌幅（%）

    -- D2 涨跌停压力
    limit_up_count        INTEGER      NOT NULL,
    limit_down_count      INTEGER      NOT NULL,
    limit_up_pct          NUMERIC(8,6) NOT NULL,   -- 涨停家数 / traded_count
    limit_down_pct        NUMERIC(8,6) NOT NULL,
    limit_net_pct         NUMERIC(8,6) NOT NULL,   -- limit_up_pct - limit_down_pct
    st_count              INTEGER,                 -- 当日 ST 股数（审计用：ST 是否被正确识别）
    limit_approx          BOOLEAN      NOT NULL DEFAULT true,  -- 未做 namechange 回填时为 true

    -- D3 动量结构（基于自算等权指数，不用 000300 —— 2024-02-05 的教训）
    ew_ret                NUMERIC(10,6) NOT NULL,  -- 当日等权收益（小数，非百分数）
    ew_index_close        NUMERIC(14,4) NOT NULL,  -- 等权指数（2016-01-04 = 1000）
    mom_5                 NUMERIC(10,6),           -- 5 日收益（小数）
    mom_20                NUMERIC(10,6),
    mom_60                NUMERIC(10,6),
    momentum_quadrant     SMALLINT,                -- 0 双负 / 1 短负长正 / 2 短正长负 / 3 双正

    -- D4 波动
    vol_20                NUMERIC(10,6),           -- 20 日已实现波动（年化）

    -- D5 杠杆水位（T-1 PIT：T 日收盘时只能看到 T-1 的余额）
    margin_bal            NUMERIC(20,4),           -- (SSE+SZSE) 两融余额，元
    margin_ratio          NUMERIC(10,6),           -- 余额 / 过去 60 日均值
    margin_ratio_pct      NUMERIC(6,4),            -- margin_ratio 的 PIT 3 年分位（**分档用这个**）
    margin_pct_3y         NUMERIC(6,4),            -- 余额水平的 PIT 3 年分位（仅参考，退化，见注释）

    -- D6 板块分化度
    sector_count          INTEGER,                 -- 当日有成分股的行业数
    sector_dispersion     NUMERIC(10,6),           -- 行业等权收益的截面标准差（小数）
    sector_pit            BOOLEAN      NOT NULL DEFAULT false,

    -- 量能（v1 只算不建维度，留作 v2 与换手率替代）
    amount_total          NUMERIC(24,4),           -- 全市场成交额，单位千元（Tushare 原始口径）
    amount_rel            NUMERIC(10,6),           -- amount_total / 过去 60 日均值

    -- 序列派生（v1 只存不算，供 v2 检验"档位持续越久分布是否不同"）
    days_in_bucket_breadth SMALLINT,
    down_days_10          SMALLINT,                -- 过去 10 个交易日中 ew_ret<0 的天数

    -- 档位（0 低 / 1 中 / 2 高；纯函数产出，规则见 spec）
    bucket_breadth        SMALLINT,
    bucket_limit          SMALLINT,
    bucket_momentum       SMALLINT,
    bucket_vol            SMALLINT,
    bucket_margin         SMALLINT,
    bucket_dispersion     SMALLINT,

    -- 版本：阈值变更必须升版本，不同版本的行不可混算
    spec_version          VARCHAR(16)  NOT NULL,
    params                JSONB        NOT NULL DEFAULT '{}'::jsonb,
    computed_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (trade_date),
    CONSTRAINT state_breadth_range     CHECK (breadth_up_ratio >= 0 AND breadth_up_ratio <= 1),
    CONSTRAINT state_traded_positive   CHECK (traded_count > 0),
    CONSTRAINT state_limit_nonneg      CHECK (limit_up_count >= 0 AND limit_down_count >= 0),
    CONSTRAINT state_bucket_range      CHECK (
        (bucket_breadth    IS NULL OR bucket_breadth    BETWEEN 0 AND 2) AND
        (bucket_limit      IS NULL OR bucket_limit      BETWEEN 0 AND 2) AND
        (bucket_momentum   IS NULL OR bucket_momentum   BETWEEN 0 AND 2) AND
        (bucket_vol        IS NULL OR bucket_vol        BETWEEN 0 AND 2) AND
        (bucket_margin     IS NULL OR bucket_margin     BETWEEN 0 AND 2) AND
        (bucket_dispersion IS NULL OR bucket_dispersion BETWEEN 0 AND 2)
    )
);

COMMENT ON TABLE state_daily IS
    'S2 每日状态向量。每交易日一行，指标只用当日收盘及之前的信息，未来收益从当日收盘起算。';
COMMENT ON COLUMN state_daily.ew_index_close IS
    '全市场等权指数，2016-01-04 = 1000。含退市、ST、北交所，不做任何过滤（状态描述的是市场，不是可投资组合）。';
COMMENT ON COLUMN state_daily.margin_bal IS
    '两融余额（元），仅 SSE+SZSE 求和。BSE 2023 才加入且规模仅 0.3%，混入会引入水平跳变。';
COMMENT ON COLUMN state_daily.days_in_bucket_breadth IS
    '当前广度档已持续的天数。v1 只存不算，供 v2 检验档位持续期效应。';
COMMENT ON COLUMN state_daily.params IS
    '分档阈值与计算参数的完整快照。改参数必须同时升 spec_version 并整表重算。';

-- ---------------------------------------------------------------------------
-- S3：前瞻收益分布
-- ---------------------------------------------------------------------------
-- 一条记录 = 一个 (维度, 档位, 窗口, 时段, 口径) 的条件分布。
--
-- 【n 的三个口径，不要混用】
--   n_obs     日观测数。相邻日的 20 日收益高度重叠，**不能当样本量**，仅供追溯。
--   n_eff     独立观测数 = 不重叠块命中数（块长 = horizon，块内众数定档）。
--             这是唯一可用于 n≥30 门槛的口径（设计文档 §3.4 已定 A 方案）。
--   n_episode 独立事件段数（极大连续区间数）。诊断用：太小说明结论集中在少数时段。
CREATE TABLE IF NOT EXISTS forward_return_dist (
    dim            VARCHAR(16)  NOT NULL,   -- breadth/limit/momentum/vol/margin/dispersion
    bucket         SMALLINT     NOT NULL,   -- 0 低 / 1 中 / 2 高
    horizon        SMALLINT     NOT NULL,   -- 5 / 10 / 20
    segment        VARCHAR(16)  NOT NULL,   -- ALL / A_2016_2019 / B_2020_2023 / C_2024_NOW
    caliber        VARCHAR(16)  NOT NULL,   -- ew_all（主）/ hs300（对照）

    n_obs          INTEGER      NOT NULL,
    n_eff          INTEGER      NOT NULL,
    n_episode      INTEGER      NOT NULL,

    p10            NUMERIC(10,6),
    p25            NUMERIC(10,6),
    p50            NUMERIC(10,6),
    p75            NUMERIC(10,6),
    p90            NUMERIC(10,6),
    mean_ret       NUMERIC(10,6),
    prob_up        NUMERIC(6,4),            -- P(收益 > 0)
    ci_low         NUMERIC(10,6),           -- 中位数的 block bootstrap 95% CI 下界
    ci_high        NUMERIC(10,6),

    -- ok / insufficient / segment_limited / void / undecidable
    -- 白名单 CHECK：这五个值由设计冻结，不是可扩展的领域枚举
    status         VARCHAR(24)  NOT NULL,

    date_min       DATE         NOT NULL,   -- 输出必须带时间范围，不允许只给分位数
    date_max       DATE         NOT NULL,
    spec_version   VARCHAR(16)  NOT NULL,
    computed_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),

    PRIMARY KEY (dim, bucket, horizon, segment, caliber, spec_version),
    CONSTRAINT frd_horizon_valid  CHECK (horizon IN (5, 10, 20)),
    CONSTRAINT frd_bucket_valid   CHECK (bucket BETWEEN 0 AND 2),
    CONSTRAINT frd_n_nonneg       CHECK (n_obs >= 0 AND n_eff >= 0 AND n_episode >= 0),
    CONSTRAINT frd_prob_range     CHECK (prob_up IS NULL OR (prob_up >= 0 AND prob_up <= 1)),
    CONSTRAINT frd_ci_ordered     CHECK (ci_low IS NULL OR ci_high IS NULL OR ci_low <= ci_high),
    CONSTRAINT frd_date_ordered   CHECK (date_min <= date_max),
    CONSTRAINT frd_status_valid   CHECK (
        status IN ('ok','insufficient','segment_limited','void','undecidable')
    )
);

COMMENT ON TABLE forward_return_dist IS
    'S3 前瞻收益分布。点估计用全部日观测（信息更多），门槛卡 n_eff（独立观测）；两者不可混用。';
COMMENT ON COLUMN forward_return_dist.n_eff IS
    '独立观测数 = 不重叠块命中数。相邻日的 h 日收益高度重叠，n_obs 不能当样本量。';
COMMENT ON COLUMN forward_return_dist.status IS
    'ok=可出结论；insufficient=n_eff<30 样本不足；segment_limited=仅部分时段有效或存在非显著反向段；void=显著机制漂移，作废；undecidable=段内 n_eff<10 无法判定。';
COMMENT ON COLUMN forward_return_dist.ci_low IS
    'moving block bootstrap（块长=horizon，1000 次）。禁止 iid bootstrap：重叠样本会低估方差，给出假窄区间。';

CREATE INDEX IF NOT EXISTS idx_frd_lookup
    ON forward_return_dist (dim, horizon, segment, status, bucket);

-- ---------------------------------------------------------------------------
-- 消费约束（写入代码时遵守，不落 DDL）
-- ---------------------------------------------------------------------------
-- 1. 查询 forward_return_dist 必须默认过滤 status='void'。
--    作废行留在表里是为了可追溯；但前端不得拿到数字，否则迟早被误用。
-- 2. state_daily 的档位列可以为 NULL（预热期指标不足），但 spec_version 必须一致。
-- 3. 任何按 (dim,bucket,horizon) 取数的接口，都必须同时返回 n_eff 与 date_min/date_max。
--    只返回分位数 = 违反硬约束 4。

-- ---------------------------------------------------------------------------
-- 增量补列（032 首次执行后追加，幂等）
-- ---------------------------------------------------------------------------
-- 背景：首版把两融分档建在「余额水平的 3 年分位」上，实测分布 550/436/1260
--       （高档占 48%）—— 两融余额有趋势性上升，水平分位对这类序列会长期贴顶，
--       是退化变量。改为对 margin_ratio（余额/60日均值，去趋势）取分位。
--       水平分位保留为 margin_pct_3y，仅作参考，不再参与分档。
ALTER TABLE state_daily ADD COLUMN IF NOT EXISTS margin_ratio_pct NUMERIC(6,4);

COMMENT ON COLUMN state_daily.margin_ratio_pct IS
    'margin_ratio（余额/60日均值）的 PIT 3 年分位。分档用它：水平分位对趋势性序列会退化。';
COMMENT ON COLUMN state_daily.margin_pct_3y IS
    '余额水平的 PIT 3 年分位。仅参考、不用于分档（实测高档占 48%，退化变量）。';
