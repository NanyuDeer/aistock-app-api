import pool from '../../core/db';

export interface ForecastVersionInput {
    symbol: string;
    versionDate: string;
    updateTime: string;
    summary: string;
    forecastDetail: unknown;
    forecastNetprofitYoy: number | null;
    forecastNetprofit: number | null;
    forecastEps: number | null;
    forecastEpsYoy: number | null;
    /** 数据可得时刻。缺省用写库时间（保守：只会更严格，不泄漏未来）。 */
    asOf?: string | Date;
}

export interface ForecastVersionRow {
    symbol: string;
    version_date: string;
    update_time: string;
    summary: string | null;
    forecast_detail: unknown;
    forecast_netprofit_yoy: unknown;
    forecast_netprofit: unknown;
    forecast_eps: unknown;
    forecast_eps_yoy: unknown;
}

/**
 * 业绩预测的按日快照。最新表 earnings_forecast 仍按 symbol 覆盖，
 * 本表仅供通知详情还原当日触发时的数据。
 */
export class ForecastVersionStore {
    private static schemaReady: Promise<void> | null = null;

    static async ensureSchema(): Promise<void> {
        if (!this.schemaReady) {
            this.schemaReady = (async () => {
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS earnings_forecast_versions (
                        symbol VARCHAR(20) NOT NULL,
                        version_date DATE NOT NULL,
                        update_time VARCHAR(30) NOT NULL,
                        summary TEXT NOT NULL DEFAULT '',
                        forecast_detail JSONB NOT NULL DEFAULT '[]'::jsonb,
                        forecast_netprofit_yoy NUMERIC(10,2),
                        forecast_netprofit NUMERIC(20,2),
                        forecast_eps NUMERIC(10,3),
                        forecast_eps_yoy NUMERIC(10,2),
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        -- 数据可得时刻（point-in-time 基准）。见 migrations/026
                        as_of TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (symbol, version_date)
                    )
                `);
                await pool.query(`CREATE INDEX IF NOT EXISTS idx_earnings_forecast_versions_symbol_date
                    ON earnings_forecast_versions (symbol, version_date DESC)`);
            })().catch((error: unknown) => {
                this.schemaReady = null;
                throw error;
            });
        }
        await this.schemaReady;
    }

    static async upsert(input: ForecastVersionInput): Promise<void> {
        await this.ensureSchema();
        await pool.query(`
            INSERT INTO earnings_forecast_versions (
                symbol, version_date, update_time, summary, forecast_detail,
                forecast_netprofit_yoy, forecast_netprofit, forecast_eps, forecast_eps_yoy,
                as_of
            ) VALUES ($1, $2::date, $3, $4, $5::jsonb, $6, $7, $8, $9, COALESCE($10::timestamptz, NOW()))
            ON CONFLICT (symbol, version_date) DO UPDATE SET
                update_time = EXCLUDED.update_time,
                summary = EXCLUDED.summary,
                forecast_detail = EXCLUDED.forecast_detail,
                forecast_netprofit_yoy = EXCLUDED.forecast_netprofit_yoy,
                forecast_netprofit = EXCLUDED.forecast_netprofit,
                forecast_eps = EXCLUDED.forecast_eps,
                forecast_eps_yoy = EXCLUDED.forecast_eps_yoy,
                as_of = EXCLUDED.as_of
        `, [
            input.symbol,
            input.versionDate,
            input.updateTime,
            input.summary,
            JSON.stringify(input.forecastDetail ?? []),
            input.forecastNetprofitYoy,
            input.forecastNetprofit,
            input.forecastEps,
            input.forecastEpsYoy,
            input.asOf ?? null,
        ]);
    }

    static async find(symbol: string, versionDate: string): Promise<ForecastVersionRow | null> {
        await this.ensureSchema();
        const result = await pool.query<ForecastVersionRow>(`
            SELECT symbol, version_date::text, update_time, summary, forecast_detail,
                   forecast_netprofit_yoy, forecast_netprofit, forecast_eps, forecast_eps_yoy
            FROM earnings_forecast_versions
            WHERE symbol = $1 AND version_date = $2::date
            LIMIT 1
        `, [symbol, versionDate]);
        return result.rows[0] || null;
    }

    /**
     * point-in-time 查询：返回在 `at` 时刻**已经可见**的最新预测版本。
     *
     * 与 `find(symbol, versionDate)` 的区别：后者按快照日精确匹配；
     * 前者按「数据可得时刻」回溯，用于归因时还原「事件发生时市场看到的是什么」。
     *
     * 已知局限：同一快照日内多次更新仍会互相覆盖（主键含 version_date），
     * 故日内精度不完整。M1 的案例是日级，够用；若要还原「事件前 1 小时的预期」，
     * 需把主键改为含 as_of。
     */
    static async findAsOf(symbol: string, at: string | Date): Promise<ForecastVersionRow | null> {
        await this.ensureSchema();
        const result = await pool.query<ForecastVersionRow>(`
            SELECT symbol, version_date::text, update_time, summary, forecast_detail,
                   forecast_netprofit_yoy, forecast_netprofit, forecast_eps, forecast_eps_yoy
            FROM earnings_forecast_versions
            WHERE symbol = $1 AND as_of <= $2::timestamptz
            ORDER BY as_of DESC, version_date DESC
            LIMIT 1
        `, [symbol, at]);
        return result.rows[0] || null;
    }
}
