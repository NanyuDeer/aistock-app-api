/**
 * Task 10 集成冒烟（本地真实 DB + Redis + 真实 HTTP 路由）
 *
 * 覆盖 plan Task 10 Step 4 的 4 项 + spec §6 验收 1/2/5/6：
 *   A. opt-in 关闭 → 批次 0 用户、0 行（验收 1）
 *   B. opt-in 开启 → 5 维度落库 + 置信度落档（验收 2）
 *   C. 同日重跑幂等（行数不变、inferred_at 刷新）
 *   D. 关闭 opt-in → 批次不再更新该用户（验收 5）
 *   E. internal 接口真实 HTTP → 契约形状
 *   F. python qa_router 真实渲染（真数据 → ≤300 字 + 含「推测」）
 *   G. 显式 investment_preferences 存在 → preferred_sectors 从 prompt 消失（验收 4）
 *   H. DELETE /api/user/profile → 两表清空 + 双缓存 key 失效（验收 6）
 *
 * 只动专用 openid `o_task10_smoke`，结束时全部清理（幂等，可反复跑）。
 *
 * 运行：
 *   cd aistock-app-api && npx tsx scripts/verify-profile-mining-smoke.ts
 * 可选环境变量：
 *   PYTHON_BIN    agent-py 的 python 可执行文件（默认 ../aistock-agent-py/.venv/Scripts/python.exe）
 *   AGENT_PY_DIR  agent-py 仓库目录（默认 ../aistock-agent-py）
 */
import 'dotenv/config';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import express from 'express';
import Redis from 'ioredis';
import pool from '../src/core/db';
import { ProfileMiningService, USER_PROFILE_INFERENCES_DDL } from '../src/modules/profile-mining/ProfileMiningService';
import { ProfileController, resolveAgentCacheRedisUrl } from '../src/modules/user/profileController';
import { signJwt } from '../src/shared/utils/jwt';

const OPENID = 'o_task10_smoke';
const UID = '11111111-2222-4333-8444-555555555510';
const PY_CWD = process.env.AGENT_PY_DIR ?? path.resolve(process.cwd(), '..', 'aistock-agent-py');
const PY = process.env.PYTHON_BIN ?? path.join(PY_CWD, '.venv', 'Scripts', 'python.exe');

let pass = 0;
const failures: string[] = [];

function check(name: string, cond: boolean, detail = ''): void {
    if (cond) {
        pass += 1;
        console.log(`  PASS  ${name}`);
    } else {
        failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
        console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
    }
}

async function cleanup(): Promise<void> {
    // 表可能尚未建（DDL 在 index.ts 启动时执行）→ 先探测再删，保证异常路径也能清理
    const reg = await pool.query<{ oid: string | null }>(
        `SELECT to_regclass('public.user_profile_inferences')::text AS oid`,
    );
    if (reg.rows[0]?.oid) {
        await pool.query('DELETE FROM user_profile_inferences WHERE user_id = $1', [OPENID]);
    }
    await pool.query('DELETE FROM user_profiles WHERE user_id = $1', [OPENID]);
    await pool.query('DELETE FROM user_settings WHERE openid = $1', [OPENID]);
    await pool.query('DELETE FROM user_stocks WHERE openid = $1 OR user_id = $2', [OPENID, UID]);
    await pool.query('DELETE FROM chat_token_usage WHERE user_id = $1', [OPENID]);
    await pool.query('DELETE FROM stock_trace_user_events WHERE openid = $1', [OPENID]);
    await pool.query("DELETE FROM stock_trace_events WHERE event_id LIKE 'smoke10-%'");
    await pool.query('DELETE FROM users WHERE openid = $1', [OPENID]);
}

async function seed(): Promise<{ industries: string[] }> {
    await pool.query(USER_PROFILE_INFERENCES_DDL);
    await cleanup();

    await pool.query(
        `INSERT INTO users (id, openid, nickname, is_vip) VALUES ($1, $2, '冒烟测试', false)`,
        [UID, OPENID],
    );

    // opt-in 初始关闭（验收 1：默认无行 = 关闭）
    await pool.query(
        `INSERT INTO user_settings (openid, setting_type, enabled) VALUES ($1, 'profile_mining', 0)`,
        [OPENID],
    );

    // ── 自选股：4 个行业 × 3 只 = 12 只（样本 ≥10 → 0.70）──
    const inds = await pool.query<{ industry: string; symbols: string[] }>(
        `SELECT industry, (array_agg(symbol ORDER BY symbol))[1:3] AS symbols
           FROM stocks
          WHERE industry IS NOT NULL AND industry <> ''
          GROUP BY industry
          HAVING count(*) >= 5
          ORDER BY count(*) DESC
          LIMIT 4`,
    );
    const industries = inds.rows.map((r) => r.industry);
    const symbols: string[] = inds.rows.flatMap((r) => r.symbols);

    let i = 0;
    for (const symbol of symbols) {
        // 双通道身份：前 8 只只挂 openid、第 9-11 只只挂 user_id、第 12 只两者都挂
        const onlyOpenid = i < 8;
        const onlyUserId = i >= 8 && i < 11;
        await pool.query(
            `INSERT INTO user_stocks (openid, symbol, user_id)
             VALUES ($1, $2, $3)`,
            [onlyOpenid ? OPENID : onlyUserId ? null : OPENID, symbol, onlyUserId || i === 11 ? UID : null],
        );
        i += 1;
    }

    // ── 提问：35 条（≥30 → 0.65），23:00 前后 18 条（≥20 → 0.60）──
    const buckets: Array<[string, number, number]> = [
        ['财报业绩怎么样', 12, 21],
        ['宏观政策有何影响', 8, 21],
        ['资金流向怎么看', 5, 10],
        ['技术形态如何', 4, 15],
        ['板块轮动节奏', 3, 10],
        ['你好', 3, 15],
    ];
    let k = 0;
    for (const [q, n, hour] of buckets) {
        for (let j = 0; j < n; j += 1) {
            k += 1;
            await pool.query(
                `INSERT INTO chat_token_usage (user_id, session_id, prompt_tokens, completion_tokens, total_tokens, question, created_at)
                 VALUES ($1, 'smoke_task10', 1, 1, 2, $2, (now() - ($3 || ' days')::interval)::date + ($4 || ' hours')::interval)`,
                [OPENID, q, (k % 20) + 1, hour],
            );
        }
    }

    // ── 洞察事件：12 条（≥5 → 0.60）：6 涨停雷达 / 4 上涨 / 2 下跌 ──
    const plan: Array<[string, boolean]> = [
        ['up', true], ['up', true], ['up', true], ['up', true], ['up', true], ['up', true],
        ['up', false], ['up', false], ['up', false], ['up', false],
        ['down', false], ['down', false],
    ];
    for (let e = 0; e < plan.length; e += 1) {
        const [direction, isLimitUp] = plan[e];
        const eventId = `smoke10-${e}`;
        await pool.query(
            `INSERT INTO stock_trace_events (event_id, symbol, stock_name, trading_date, direction, is_limit_up,
                                             current_severity, first_triggered_at, window_start_at, window_end_at, last_seen_at)
             VALUES ($1, $2, '冒烟股', CURRENT_DATE, $3, $4,
                     'medium', now() - interval '3 days', now() - interval '3 days', now(), now())`,
            [eventId, symbols[e % symbols.length], direction, isLimitUp],
        );
        await pool.query(
            `INSERT INTO stock_trace_user_events (id, event_id, openid, created_at)
             VALUES (gen_random_uuid(), $1, $2, now() - interval '2 days')`,
            [eventId, OPENID],
        );
    }

    return { industries };
}

async function rows() {
    const r = await pool.query<{
        dimension: string; value: unknown; confidence: string; sample_size: number;
        window_days: number | null; inferred_at: Date;
    }>(
        `SELECT dimension, value, confidence, sample_size, window_days, inferred_at
           FROM user_profile_inferences WHERE user_id = $1 ORDER BY dimension`,
        [OPENID],
    );
    return r.rows;
}

async function setOptIn(enabled: 0 | 1): Promise<void> {
    await pool.query(
        `UPDATE user_settings SET enabled = $2, updated_at = now() WHERE openid = $1 AND setting_type = 'profile_mining'`,
        [OPENID, enabled],
    );
}

async function main(): Promise<void> {
    console.log('=== 造数据 ===');
    const { industries } = await seed();
    console.log(`  自选股行业：${industries.join(' / ')}`);

    // ── A. opt-in 关闭 → 0 用户 0 行 ──
    console.log('\n=== A. opt-in 关闭（验收 1）===');
    const a = await ProfileMiningService.runDailyMining();
    check('批次 0 opt-in 用户', a.users === 0, `users=${a.users}`);
    check('未写入任何推断行', (await rows()).length === 0);

    // ── B. opt-in 开启 → 5 维度 ──
    console.log('\n=== B. opt-in 开启（验收 2）===');
    await setOptIn(1);
    const b = await ProfileMiningService.runDailyMining();
    check('批次 1 用户成功', b.users === 1 && b.ok === 1 && b.failed === 0, JSON.stringify(b));
    const r1 = await rows();
    check('产出 5 个维度行', r1.length === 5, `实际 ${r1.length}: ${r1.map((x) => x.dimension).join(',')}`);

    const byDim = new Map(r1.map((r) => [r.dimension, r]));
    const conf = (d: string): number => Number(byDim.get(d)?.confidence ?? -1);
    check('preferred_sectors 置信度 0.70', conf('preferred_sectors') === 0.7, String(conf('preferred_sectors')));
    check('question_topics 置信度 0.65', conf('question_topics') === 0.65, String(conf('question_topics')));
    check('watch_events 置信度 0.60', conf('watch_events') === 0.6, String(conf('watch_events')));
    check('active_hours 置信度 0.60', conf('active_hours') === 0.6, String(conf('active_hours')));
    check('watchlist_breadth 置信度 0.70', conf('watchlist_breadth') === 0.7, String(conf('watchlist_breadth')));

    const ps = byDim.get('preferred_sectors')?.value as { items: Array<{ name: string; stock_count: number; weight: number }>; total: number };
    check('preferred_sectors total=12（双通道全采到）', ps?.total === 12, `total=${ps?.total}`);
    check('preferred_sectors Top 行业数 ≤5', (ps?.items?.length ?? 9) <= 5);
    check('weight 求和 ≈ 1', Math.abs((ps?.items ?? []).reduce((s, x) => s + x.weight, 0) - 1) < 0.02,
        String((ps?.items ?? []).reduce((s, x) => s + x.weight, 0)));
    check('window_days：preferred_sectors=null', byDim.get('preferred_sectors')?.window_days === null);
    check('window_days：question_topics=30', byDim.get('question_topics')?.window_days === 30);

    const qv = byDim.get('question_topics')?.value as { items: Array<{ topic: string; hits: number }>; total: number };
    check('question_topics total=35', qv?.total === 35, `total=${qv?.total}`);
    check('question_topics Top1 = 财报业绩', qv?.items?.[0]?.topic === '财报业绩', qv?.items?.[0]?.topic);

    const wv = byDim.get('watch_events')?.value as { items: Array<{ type: string; count: number }>; total: number };
    const wMap = new Map((wv?.items ?? []).map((x) => [x.type, x.count]));
    check('watch_events total=12', wv?.total === 12, `total=${wv?.total}`);
    check('涨停雷达=6 / 上涨异动=4 / 下跌异动=2',
        wMap.get('limit_up_radar') === 6 && wMap.get('up_move') === 4 && wMap.get('down_move') === 2,
        JSON.stringify(Object.fromEntries(wMap)));
    check('insight 表缺失 → 无 insight_push（to_regclass 安全跳过）', !wMap.has('insight_push'));

    const hv = byDim.get('active_hours')?.value as { items: Array<{ hour: number; hits: number }>; total: number };
    check('active_hours Top1 = 21 点', hv?.items?.[0]?.hour === 21, JSON.stringify(hv?.items?.[0]));

    const bv = byDim.get('watchlist_breadth')?.value as { band: string; count: number };
    check('watchlist_breadth band=5-15 / count=12', bv?.band === '5-15' && bv?.count === 12, JSON.stringify(bv));

    // ── C. 同日重跑幂等 ──
    console.log('\n=== C. 幂等重跑 ===');
    const before = new Map(r1.map((r) => [r.dimension, r.inferred_at.getTime()]));
    await new Promise((r) => setTimeout(r, 1100));
    await ProfileMiningService.runDailyMining();
    const r2 = await rows();
    check('重跑后仍 5 行（不追加历史）', r2.length === 5, String(r2.length));
    check('inferred_at 已刷新', r2.every((r) => r.inferred_at.getTime() > (before.get(r.dimension) ?? 0)));

    // ── D. 关闭 opt-in → 不再更新（验收 5）──
    console.log('\n=== D. 关闭后不再更新（验收 5）===');
    const t2 = new Map(r2.map((r) => [r.dimension, r.inferred_at.getTime()]));
    await setOptIn(0);
    await new Promise((r) => setTimeout(r, 1100));
    const d = await ProfileMiningService.runDailyMining();
    const r3 = await rows();
    check('关闭后批次 0 用户', d.users === 0, `users=${d.users}`);
    check('updated_at/inferred_at 未变', r3.every((r) => r.inferred_at.getTime() === t2.get(r.dimension)));

    // ── E. internal 接口真实 HTTP ──
    console.log('\n=== E. internal 接口契约 ===');
    const app = express();
    app.use(express.json());
    const internalRouter = (await import('../src/core/routes/internal')).default;
    app.use('/internal', internalRouter);
    app.delete('/api/user/profile', (req, res, next) => ProfileController.del(req, res, next));
    const server = app.listen(0);
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const token = process.env.INTERNAL_API_TOKEN || process.env.INTERNAL_TOKEN || 'change-me-in-production';

    const noToken = await fetch(`${base}/internal/user-profile-inferences/${OPENID}`);
    check('缺 X-Internal-Token → 403', noToken.status === 403, String(noToken.status));

    const okResp = await fetch(`${base}/internal/user-profile-inferences/${OPENID}`, {
        headers: { 'X-Internal-Token': token },
    });
    const body = await okResp.json() as { code: number; data: Array<Record<string, unknown>> };
    check('200 + data 数组 5 项', okResp.status === 200 && body.code === 200 && body.data.length === 5, String(body.data?.length));
    const first = body.data[0] ?? {};
    check('字段形状完整', ['dimension', 'value', 'confidence', 'sample_size', 'window_days', 'inferred_at'].every((f) => f in first),
        Object.keys(first).join(','));
    check('confidence 为 number', typeof first.confidence === 'number', typeof first.confidence);

    const empty = await fetch(`${base}/internal/user-profile-inferences/o_no_such_user_10`, {
        headers: { 'X-Internal-Token': token },
    });
    const emptyBody = await empty.json() as { code: number; data: unknown[] };
    check('无数据 → 200 + []（不 404）', empty.status === 200 && Array.isArray(emptyBody.data) && emptyBody.data.length === 0, String(empty.status));

    // ── F. python 真实渲染 ──
    console.log('\n=== F. qa_router 渲染（真实数据）===');
    const inferFile = path.join(tmpdir(), 'profile-mining-inferences.json');
    writeFileSync(inferFile, JSON.stringify(body.data), 'utf-8');

    const pyRender = `
import json, sys
from aistock_agent.graph.nodes.qa_router import _build_inference_context
data = json.load(open(sys.argv[1], encoding='utf-8'))
out = _build_inference_context(data, None)
print('__LEN__', len(out))
print(out)
`.trim();

    const render = execFileSync(PY, ['-c', pyRender, inferFile], {
        cwd: PY_CWD,
        env: { ...process.env, PYTHONPATH: 'src' },
        encoding: 'utf-8',
    });
    const lenLine = render.split('\n')[0] ?? '';
    const rendered = render.split('\n').slice(1).join('\n').trim();
    const rlen = Number(lenLine.replace('__LEN__', '').trim());
    check('渲染非空', rendered.length > 0, `len=${rlen}`);
    check('渲染 ≤300 字', rlen <= 300, String(rlen));
    check('含「推测」标注', rendered.includes('推测'));
    check('含板块信息', industries.some((ind) => rendered.includes(ind)), rendered.slice(0, 80));

    // ── G. 显式偏好存在 → preferred_sectors 消失（验收 4）──
    console.log('\n=== G. 显式优先（验收 4）===');
    await pool.query(
        `INSERT INTO user_profiles (user_id, nickname, investment_preferences, risk_tolerance)
         VALUES ($1, '冒烟测试', '["白酒"]'::jsonb, 'balanced')
         ON CONFLICT (user_id) DO UPDATE SET investment_preferences = '["白酒"]'::jsonb`,
        [OPENID],
    );
    const profileFile = path.join(tmpdir(), 'profile-mining-profile.json');
    writeFileSync(profileFile, JSON.stringify({ nickname: '冒烟测试', investment_preferences: ['白酒'], risk_tolerance: 'balanced' }), 'utf-8');
    const pyExplicit = `
import json, sys
from aistock_agent.graph.nodes.qa_router import _build_inference_context
data = json.load(open(sys.argv[1], encoding='utf-8'))
profile = json.load(open(sys.argv[2], encoding='utf-8'))
out = _build_inference_context(data, profile)
print('__HAS_SECTOR__', '自选股集中' in out)
print(out)
`.trim();
    const explicit = execFileSync(PY, ['-c', pyExplicit, inferFile, profileFile], {
        cwd: PY_CWD, env: { ...process.env, PYTHONPATH: 'src' }, encoding: 'utf-8',
    });
    check('显式偏好存在 → 板块推断被丢弃', (explicit.split('\n')[0] ?? '').includes('False'), (explicit.split('\n')[0] ?? '').trim());
    check('其余推断仍在（含推测）', explicit.includes('推测'));

    // ── H. DELETE /api/user/profile 级联（验收 6）──
    console.log('\n=== H. 删除级联 + 缓存失效（验收 6）===');
    const redisUrl = resolveAgentCacheRedisUrl();
    const cache = new Redis(redisUrl, { lazyConnect: true });
    await cache.connect();
    await cache.set(`user_profile:${OPENID}`, '{"stale":1}');
    await cache.set(`user_profile_inferences:${OPENID}`, '[{"stale":1}]');

    const now = Math.floor(Date.now() / 1000);
    const jwt = signJwt({ openid: OPENID, nickname: '冒烟测试', iat: now, exp: now + 3600 }, process.env.JWT_SECRET!);
    const delResp = await fetch(`${base}/api/user/profile`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${jwt}` },
    });
    const delBody = await delResp.json() as { code: number; data?: { deleted: boolean } };
    check('DELETE 200 且 deleted=true', delResp.status === 200 && delBody.data?.deleted === true, JSON.stringify(delBody));

    const afterProfile = await pool.query('SELECT 1 FROM user_profiles WHERE user_id = $1', [OPENID]);
    const afterInfer = await pool.query('SELECT 1 FROM user_profile_inferences WHERE user_id = $1', [OPENID]);
    check('user_profiles 已清空', afterProfile.rowCount === 0);
    check('user_profile_inferences 已清空', afterInfer.rowCount === 0);
    const k1 = await cache.exists(`user_profile:${OPENID}`);
    const k2 = await cache.exists(`user_profile_inferences:${OPENID}`);
    check('两个缓存 key 均已 DEL（无 300s 旧画像窗口）', k1 === 0 && k2 === 0, `k1=${k1} k2=${k2}`);
    cache.disconnect();

    server.close();

    console.log('\n=== 清理造数据 ===');
    await cleanup();
    const leftover = await pool.query('SELECT COUNT(*)::int n FROM user_profile_inferences WHERE user_id = $1', [OPENID]);
    check('清理后无残留', leftover.rows[0].n === 0);

    console.log(`\n=== 结果：PASS ${pass} / FAIL ${failures.length} ===`);
    if (failures.length) {
        for (const f of failures) console.log(`  ✗ ${f}`);
    }
    await pool.end();
    process.exit(failures.length ? 1 : 0);
}

main().catch(async (e) => {
    console.error('SMOKE CRASHED:', e instanceof Error ? e.stack : e);
    try { await cleanup(); } catch { /* ignore */ }
    process.exit(2);
});
