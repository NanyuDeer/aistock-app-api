import { randomBytes } from 'node:crypto';
import { readFile, writeFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import dotenv from 'dotenv';
import { Client } from 'pg';

const TEST_DATABASE = 'aistock_test';
const TEST_ROLE = 'aistock_test';
const TEST_USER_OPENID = 'trace_test_user_001';
const TEST_SYMBOL = '600519';
const ROOT_DIR = process.cwd();
// 显式声明而非扫描 src/db/migrations/*.sql：010 依赖 pgvector 扩展等运行时上下文，
// 测试库扫描全部迁移会引入额外执行。仅执行本测试场景所需的 stock_trace + insight 迁移。
const MIGRATIONS = [
    '011_stock_trace_events.sql',
    '012_stock_trace_snapshots.sql',
    '013_stock_trace_results.sql',
    '014_stock_trace_artifacts.sql',
    '015_stock_trace_jobs.sql',
    '016_watchlist_insights.sql',
    '017_watchlist_price_move.sql',
] as const;

function buildTestUrl(sourceUrl: string, password: string): string {
    const url = new URL(sourceUrl);
    url.username = TEST_ROLE;
    url.password = password;
    url.pathname = `/${TEST_DATABASE}`;
    return url.toString();
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path, constants.F_OK);
        return true;
    } catch {
        return false;
    }
}

async function main(): Promise<void> {
    dotenv.config({ path: join(ROOT_DIR, '.env') });
    const sourceUrl = process.env.DATABASE_URL;
    if (!sourceUrl) throw new Error('DATABASE_URL is required in .env');

    const envTestPath = join(ROOT_DIR, '.env.test');
    const hasExistingTestEnv = await exists(envTestPath);
    const password = randomBytes(24).toString('base64url');
    // A fresh local installation has the default `postgres` database but not the
    // application's `aistock` database yet, so bootstrap from `postgres` first.
    const adminUrl = new URL(sourceUrl);
    adminUrl.pathname = '/postgres';
    const admin = new Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
        const role = await admin.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [TEST_ROLE]);
        if (role.rowCount === 0) {
            await admin.query(`CREATE ROLE ${TEST_ROLE} LOGIN PASSWORD '${password}'`);
        } else if (!hasExistingTestEnv) {
            await admin.query(`ALTER ROLE ${TEST_ROLE} PASSWORD '${password}'`);
        }
        const database = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [TEST_DATABASE]);
        if (database.rowCount === 0) {
            // PostgreSQL 17 requires a role to be a member of the target owner
            // role. Keep the application administrator as DB owner and grant the
            // isolated test role all access instead.
            await admin.query(`CREATE DATABASE ${TEST_DATABASE} OWNER aistock`);
        }
        const applicationDatabase = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', ['aistock']);
        if (applicationDatabase.rowCount === 0) {
            await admin.query('CREATE DATABASE aistock OWNER aistock');
        }
    } finally {
        await admin.end();
    }

    const ownerUrl = new URL(sourceUrl);
    ownerUrl.pathname = `/${TEST_DATABASE}`;
    const ownerClient = new Client({ connectionString: ownerUrl.toString() });
    await ownerClient.connect();
    try {
        await ownerClient.query(`GRANT ALL PRIVILEGES ON DATABASE ${TEST_DATABASE} TO ${TEST_ROLE}`);
        await ownerClient.query(`GRANT ALL ON SCHEMA public TO ${TEST_ROLE}`);
    } finally {
        await ownerClient.end();
    }

    let testUrl: string;
    if (hasExistingTestEnv) {
        const existing = await readFile(envTestPath, 'utf8');
        const match = existing.match(/^DATABASE_URL=(.+)$/m);
        if (!match) throw new Error('.env.test exists but DATABASE_URL is missing');
        testUrl = match[1].trim();
    } else {
        testUrl = buildTestUrl(sourceUrl, password);
        await writeFile(envTestPath, [
            'NODE_ENV=test',
            'QA_MODE=true',
            'PORT=3001',
            `DATABASE_URL=${testUrl}`,
            'INTERNAL_API_TOKEN=stock-trace-test-token',
        ].join('\n').concat('\n'), { encoding: 'utf8', mode: 0o600 });
    }

    const testClient = new Client({ connectionString: testUrl });
    await testClient.connect();
    try {
        await testClient.query(`
            CREATE TABLE IF NOT EXISTS users (
                openid VARCHAR(128) PRIMARY KEY,
                nickname VARCHAR(80) NOT NULL DEFAULT '',
                avatar_url TEXT NOT NULL DEFAULT '',
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
            CREATE TABLE IF NOT EXISTS stocks (
                symbol VARCHAR(6) PRIMARY KEY,
                name VARCHAR(80) NOT NULL,
                pinyin VARCHAR(80) NOT NULL DEFAULT '',
                market VARCHAR(16) NOT NULL DEFAULT '',
                industry TEXT NOT NULL DEFAULT '',
                list_date VARCHAR(8) NOT NULL DEFAULT ''
            );
            CREATE TABLE IF NOT EXISTS user_stocks (
                openid VARCHAR(128) NOT NULL REFERENCES users(openid),
                symbol VARCHAR(6) NOT NULL REFERENCES stocks(symbol),
                created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
                PRIMARY KEY (openid, symbol)
            );
            CREATE TABLE IF NOT EXISTS stock_trace_test_cases (
                case_id VARCHAR(64) PRIMARY KEY,
                symbol VARCHAR(6) NOT NULL,
                stock_name VARCHAR(80) NOT NULL,
                latest_price NUMERIC(16,4) NOT NULL,
                previous_close NUMERIC(16,4) NOT NULL,
                change_pct NUMERIC(10,4) NOT NULL,
                observed_at TIMESTAMPTZ NOT NULL,
                description TEXT NOT NULL
            );
        `);
        for (const migration of MIGRATIONS) {
            const sql = await readFile(join(ROOT_DIR, 'src', 'db', 'migrations', migration), 'utf8');
            await testClient.query(sql);
        }
        await testClient.query(`INSERT INTO users (openid, nickname) VALUES ($1, 'Stock Trace Test User')
            ON CONFLICT (openid) DO UPDATE SET nickname = EXCLUDED.nickname`, [TEST_USER_OPENID]);
        await testClient.query(`INSERT INTO stocks (symbol, name, pinyin, market, industry, list_date)
            VALUES ($1, '贵州茅台', 'gmt', 'sh', '白酒', '20010827')
            ON CONFLICT (symbol) DO UPDATE SET name = EXCLUDED.name, pinyin = EXCLUDED.pinyin,
                market = EXCLUDED.market, industry = EXCLUDED.industry, list_date = EXCLUDED.list_date`, [TEST_SYMBOL]);
        await testClient.query('INSERT INTO user_stocks (openid, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING', [TEST_USER_OPENID, TEST_SYMBOL]);
        await testClient.query(`INSERT INTO stock_trace_test_cases
                (case_id, symbol, stock_name, latest_price, previous_close, change_pct, observed_at, description)
            VALUES ('price-up-7-8', $1, '贵州茅台', 1778.00, 1649.35, 7.80, '2026-07-30T10:05:00+08:00', '价格上涨 7.80%，应创建价格异动事件')
            ON CONFLICT (case_id) DO UPDATE SET latest_price = EXCLUDED.latest_price,
                previous_close = EXCLUDED.previous_close, change_pct = EXCLUDED.change_pct,
                observed_at = EXCLUDED.observed_at, description = EXCLUDED.description`, [TEST_SYMBOL]);
        const tables = await testClient.query<{ table_name: string }>(`
            SELECT table_name FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name LIKE 'stock_trace%'
            ORDER BY table_name
        `);
        console.log(JSON.stringify({
            database: TEST_DATABASE,
            role: TEST_ROLE,
            testUser: TEST_USER_OPENID,
            testSymbol: TEST_SYMBOL,
            traceTables: tables.rows.map((row) => row.table_name),
            testCase: 'price-up-7-8',
        }, null, 2));
    } finally {
        await testClient.end();
    }
}

main().catch((error: unknown) => {
    console.error('[stock-trace-test-db] setup failed:', error instanceof Error ? error.message : error);
    process.exitCode = 1;
});
