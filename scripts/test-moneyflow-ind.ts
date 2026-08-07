/**
 * 测试 moneyflow_ind_dc 按 name 匹配：查询行业板块里是否有"旅游""酒店""电池"等
 * 运行：npx tsx scripts/test-moneyflow-ind.ts 2
 */
import dotenv from 'dotenv';
dotenv.config({ path: '.env.production' });

const TOKEN = process.env.TUSHARE_TOKEN || '';
const TRADE_DATE = process.argv[2] === '2' ? process.argv[3] || '20260806' : '20260806';

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
    console.log(`===== moneyflow_ind_dc 按 name 搜索 (${TRADE_DATE}) =====\n`);
    const ind = await tushareCall('moneyflow_ind_dc', { trade_date: TRADE_DATE });
    if ('error' in ind) {
        console.log('错误:', ind.error);
        return;
    }
    const rows = ind as Record<string, unknown>[];
    console.log(`总条数: ${rows.length}`);

    const keywords = ['旅游', '酒店', '电池', '医疗服务', '元件', '光刻', '半导体', '煤炭'];
    for (const kw of keywords) {
        const hits = rows.filter(r => String(r.name).includes(kw));
        console.log(`\n包含"${kw}": ${hits.length} 个`);
        for (const h of hits.slice(0, 5)) {
            console.log(`  ${h.ts_code} ${h.name} net_amount=${h.net_amount} (元)`);
        }
    }

    // content_type 分布
    const types = new Map<string, number>();
    for (const r of rows) types.set(String(r.content_type), (types.get(String(r.content_type)) || 0) + 1);
    console.log('\ncontent_type 分布:', [...types.entries()].map(([k, v]) => `${k}:${v}`).join(' '));
}

main().catch(err => { console.error('执行失败:', err); process.exit(1); });
