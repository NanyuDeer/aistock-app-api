-- 038: 融资盘出清（S8）
--
-- 设计：docs/superpowers/specs/2026-11-27-margin-purge-graph-design.md
--
-- 【为什么单独一张表，不塞 state_daily】
--   state_daily 是 S2 的契约（六维三档），加列会改变它的语义边界；
--   且本表是「逐日事实 + 回合状态」，与状态分档不是一回事。
--
-- 【为什么 peak/drawdown 可空】
--   margin_daily 起于 2016-01-04，前 250 个交易日没有完整的「一年高点」。
--   2016 年内算出的回撤（如 -25%）是缺 2015 峰值的假象，写 NULL 表示「历史不足」，
--   比写一个看起来像事实的假数字诚实。
--
-- 【为什么一行一天、全量重算】
--   状态机依赖前序回合（回合内只记一次完成信号），增量最容易在回合边界出错。
--   2,646 行全量重算约 1 秒，没有省的必要。

CREATE TABLE IF NOT EXISTS margin_purge_daily (
    trade_date      DATE          PRIMARY KEY,
    balance         NUMERIC(18,2) NOT NULL,
    peak_250        NUMERIC(18,2),
    peak_date       DATE,
    drawdown        NUMERIC(8,5),
    ma20            NUMERIC(18,2),
    below_ma20_days SMALLINT      NOT NULL DEFAULT 0,
    episode_id      INTEGER,
    episode_start   DATE,
    episode_days    SMALLINT,
    phase           VARCHAR(8)    NOT NULL,
    event_kind      VARCHAR(8),
    spec_version    VARCHAR(8)    NOT NULL,
    computed_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
    CONSTRAINT mp_phase_valid  CHECK (phase IN ('none', 'purging', 'easing')),
    CONSTRAINT mp_event_valid  CHECK (event_kind IS NULL OR event_kind = 'complete'),
    CONSTRAINT mp_drawdown_neg CHECK (drawdown IS NULL OR drawdown <= 0),
    CONSTRAINT mp_episode_pair CHECK ((episode_id IS NULL) = (phase = 'none'))
);

COMMENT ON TABLE margin_purge_daily IS
    '融资盘出清逐日事实与回合状态。一行一天，全量重算。drawdown 为 NULL 表示历史不足 250 日。';
COMMENT ON COLUMN margin_purge_daily.phase IS
    'none=不在回撤回合内；purging=回合内且余额在 20 日均线下方；easing=回合内且余额在均线上方。';
COMMENT ON COLUMN margin_purge_daily.event_kind IS
    '回合内首次余额上穿 20 日均线记 complete，一个回合只记一次。';

CREATE INDEX IF NOT EXISTS idx_mp_complete
    ON margin_purge_daily (trade_date) WHERE event_kind = 'complete';
