/**
 * 测试 电子化学品/保险 在 cnt_ths 和 ind_dc 中的匹配情况
 * 运行：npx tsx scripts/test-moneyflow-ind.ts 3
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.production' });

const TOKEN = process.env.TUSHARE_TOKEN || '';
const TRADE_DATE = process.argv[3] || '20260806';

async function tushareCall(apiName: string, params: Record<string, unknown>, fields = '') {
    const res = await fetch('https://api.tushare.pro', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ api_name: apiName, token: TOKEN, params, fields }),
    });
    const json = await res.json() as {
        code: number;
        msg?: string;
        data?: { fields: string[]; items: unknown[][] };
    };
    if (json.code !== 0) return { error: json.msg || `code=${json.code}` };
    const { fields: fs, items } = json.data!;
    return items.map(row => {
        const obj: Record<string, unknown> = {};
        fs.forEach((f, i) => { obj[f] = row[i]; });
        return obj;
    });
}

async function main() {
    console.log(`===== 电子化学品/保险 匹配测试 (${TRADE_DATE}) =====\n`);

    // 1. cnt_ths 里有没有
    const cnt = await tushareCall('moneyflow_cnt_ths', { trade_date: TRADE_DATE },
        'trade_date,ts_code,name,lead_stock,net_amount');
    if (!('error' in cnt)) {
        const rows = cnt as Record<string, unknown>[];
        console.log(`[moneyflow_cnt_ths] ${rows.length} 条`);
        for (const kw of ['电子化学品', '保险']) {
            const hits = rows.filter(r => String(r.name).includes(kw));
            console.log(`  cnt_ths 含"${kw}": ${hits.length} 个`);
            for (const h of hits) console.log(`    ${h.ts_code} ${h.name} lead=${h.lead_stock} net=${h.net_amount}`);
        }
    }

    console.log('');

    // 2. ind_dc 里名称
    const ind = await tushareCall('moneyflow_ind_dc', { trade_date: TRADE_DATE });
    if (!('error' in ind)) {
        const rows = ind as Record<string, unknown>[];
        console.log(`[moneyflow_ind_dc] ${rows.length} 条`);
        for (const kw of ['电子化学品', '保险']) {
            const hits = rows.filter(r => String(r.name).includes(kw));
            console.log(`  ind_dc 含"${kw}": ${hits.length} 个`);
            for (const h of hits.slice(0, 8)) console.log(`    ${h.ts_code} [${h.content_type}] ${h.name} net=${h.net_amount} lead=${h.buy_sm_amount_stock}`);
        }
    }
}

main().catch(err => { console.error('执行失败:', err); process.exit(1); });
