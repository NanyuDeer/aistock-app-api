import pool from '../../core/db';
import type { AiScoreResult } from './AiScoreService';

interface PerformanceAiScoreVersionInput {
    symbol: string;
    endDate: string;
    reportType: string;
    scoreData: AiScoreResult;
}

interface PerformanceAiScoreVersionRow {
    score_data: AiScoreResult;
}

/**
 * 财报通知对应的 AI 评分快照。
 * 同一股票、报告期、报告类型只保留一份，使历史通知不随最新财务数据改变。
 */
export class PerformanceAiScoreVersionStore {
    private static schemaReady: Promise<void> | null = null;

    static async ensureSchema(): Promise<void> {
        if (!this.schemaReady) {
            this.schemaReady = (async () => {
                await pool.query(`
                    CREATE TABLE IF NOT EXISTS performance_ai_score_versions (
                        symbol VARCHAR(20) NOT NULL,
                        end_date VARCHAR(8) NOT NULL,
                        report_type VARCHAR(20) NOT NULL,
                        score_data JSONB NOT NULL,
                        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                        PRIMARY KEY (symbol, end_date, report_type)
                    )
                `);
                await pool.query(`CREATE INDEX IF NOT EXISTS idx_performance_ai_score_versions_symbol_end_date
                    ON performance_ai_score_versions (symbol, end_date DESC)`);
            })().catch((error: unknown) => {
                this.schemaReady = null;
                throw error;
            });
        }
        await this.schemaReady;
    }

    static async upsert(input: PerformanceAiScoreVersionInput): Promise<void> {
        await this.ensureSchema();
        await pool.query(`
            INSERT INTO performance_ai_score_versions (symbol, end_date, report_type, score_data)
            VALUES ($1, $2, $3, $4::jsonb)
            ON CONFLICT (symbol, end_date, report_type) DO UPDATE SET
                score_data = EXCLUDED.score_data
        `, [
            input.symbol,
            input.endDate,
            input.reportType,
            JSON.stringify(input.scoreData),
        ]);
    }

    static async find(symbol: string, endDate: string, reportType: string): Promise<AiScoreResult | null> {
        await this.ensureSchema();
        const result = await pool.query<PerformanceAiScoreVersionRow>(`
            SELECT score_data
            FROM performance_ai_score_versions
            WHERE symbol = $1 AND end_date = $2 AND report_type = $3
            LIMIT 1
        `, [symbol, endDate, reportType]);
        return result.rows[0]?.score_data || null;
    }
}
