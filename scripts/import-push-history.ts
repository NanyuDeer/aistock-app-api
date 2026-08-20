/**
 * 导入历史推送记录到 PostgreSQL
 * 用法: npx tsx scripts/import-push-history.ts <json文件路径>
 */
import fs from 'fs';
import path from 'path';

interface PushRecord {
  push_id: string;
  push_batch_id: string;
  push_date: string;
  push_time: string;
  push_rank: number;
  stock_code: string;
  stock_name: string;
  theme: string;
  reason: string;
  strategy_name: string;
  score: number;
  chain_position: string;
  source: string;
  reason_tag: string;
  push_price: number;
  latest_price: number;
  latest_trade_date: string;
  latest_change_pct: number;
  raw_analysis_price: number;
  price_basis: string;
  realtime_return_pct: number;
  realtime_time: string;
}

async function main() {
  const jsonPath = process.argv[2] || path.join(__dirname, '../data/potential-stock-push-history.json');

  if (!fs.existsSync(jsonPath)) {
    console.error(`文件不存在: ${jsonPath}`);
    process.exit(1);
  }

  const records: PushRecord[] = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
  console.log(`读取到 ${records.length} 条记录`);

  // 动态导入 pg（避免编译时依赖）
  const { Pool } = await import('pg');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://aistock:aistock2026@localhost:5432/aistock',
  });

  // 确保表存在
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wind_leader_push_history (
      id SERIAL PRIMARY KEY,
      push_id TEXT NOT NULL,
      push_batch_id TEXT,
      push_date TEXT NOT NULL,
      push_time TEXT,
      push_rank INTEGER,
      stock_code TEXT NOT NULL,
      stock_name TEXT NOT NULL,
      theme TEXT,
      reason TEXT,
      strategy_name TEXT,
      score INTEGER,
      chain_position TEXT,
      source TEXT,
      reason_tag TEXT,
      push_price NUMERIC(10,2),
      latest_price NUMERIC(10,2),
      latest_trade_date TEXT,
      latest_change_pct NUMERIC(10,2),
      raw_analysis_price NUMERIC(10,2),
      price_basis TEXT,
      realtime_return_pct NUMERIC(10,2),
      realtime_time TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(push_id)
    )
  `);

  // 清空旧数据（可选，如果需要覆盖）
  // await pool.query('TRUNCATE wind_leader_push_history');

  let inserted = 0;
  let skipped = 0;

  for (const record of records) {
    try {
      await pool.query(
        `INSERT INTO wind_leader_push_history (
          push_id, push_batch_id, push_date, push_time, push_rank,
          stock_code, stock_name, theme, reason, strategy_name,
          score, chain_position, source, reason_tag,
          push_price, latest_price, latest_trade_date, latest_change_pct,
          raw_analysis_price, price_basis, realtime_return_pct, realtime_time
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
        ON CONFLICT (push_id) DO NOTHING`,
        [
          record.push_id,
          record.push_batch_id,
          record.push_date,
          record.push_time,
          record.push_rank,
          record.stock_code,
          record.stock_name,
          record.theme,
          record.reason,
          record.strategy_name,
          record.score,
          record.chain_position,
          record.source,
          record.reason_tag,
          record.push_price,
          record.latest_price,
          record.latest_trade_date,
          record.latest_change_pct,
          record.raw_analysis_price,
          record.price_basis,
          record.realtime_return_pct,
          record.realtime_time ? new Date(record.realtime_time) : null,
        ]
      );
      inserted++;
    } catch (err: any) {
      if (err.message?.includes('duplicate key')) {
        skipped++;
      } else {
        console.error(`插入失败 ${record.push_id}:`, err.message);
      }
    }
  }

  // 统计
  const { rows } = await pool.query('SELECT push_date, count(*) FROM wind_leader_push_history GROUP BY push_date ORDER BY push_date');
  console.log('\n导入完成:');
  console.log(`  成功插入: ${inserted} 条`);
  console.log(`  重复跳过: ${skipped} 条`);
  console.log(`  数据库总计: ${rows.reduce((sum, r) => sum + parseInt(r.count), 0)} 条`);
  console.log('\n按日期分布:');
  rows.forEach((r: any) => console.log(`  ${r.push_date}: ${r.count} 条`));

  await pool.end();
}

main().catch(console.error);
