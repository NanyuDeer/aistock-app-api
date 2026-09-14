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
                forecast_netprofit_yoy, forecast_netprofit, forecast_eps, forecast_eps_yoy
            ) VALUES ($1, $2::date, $3, $4, $5::jsonb, $6, $7, $8, $9)
            ON CONFLICT (symbol, version_date) DO UPDATE SET
                update_time = EXCLUDED.update_time,
                summary = EXCLUDED.summary,
                forecast_detail = EXCLUDED.forecast_detail,
                forecast_netprofit_yoy = EXCLUDED.forecast_netprofit_yoy,
                forecast_netprofit = EXCLUDED.forecast_netprofit,
                forecast_eps = EXCLUDED.forecast_eps,
                forecast_eps_yoy = EXCLUDED.forecast_eps_yoy
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
}
