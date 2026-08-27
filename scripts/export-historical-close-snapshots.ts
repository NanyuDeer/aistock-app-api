/**
 * export-historical-close-snapshots.ts
 *
 * 导出 5 个历史重大异动交易日的 CloseMarketSnapshot 原始 JSON。
 * 只复用 MarketSnapshotService.getTodayCloseSnapshot(nowOverride)，
 * 不在 Python 侧新增 A 股数据抓取逻辑。
 *
 * 用法:
 *   pnpm exec tsx scripts/export-historical-close-snapshots.ts [--dry-run] [--out-dir <path>]
 *
 * --dry-run  只列出待导出的 case 和目标路径，不实际导出
 * --out-dir  指定输出目录（默认 ../aistock-agent-py/tests/fixtures/historical_snapshots）
 *
 * 写入使用 flag "wx"，同名 fixture 文件已存在时立即报错退出，不覆盖。
 */

import dotenv from 'dotenv';
dotenv.config({ path: '.env.development' });
dotenv.config(); // 回退加载 .env

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { getTodayCloseSnapshot } from '../src/modules/quote/MarketSnapshotService';

// ============================================================================
// 类型定义
// ============================================================================

interface HistoricalCase {
    caseId: string;
    reportDate: string;
}

// ============================================================================
// 常量
// ============================================================================

/** 5 个已知大幅异动交易日。 */
const HISTORICAL_CASES: readonly HistoricalCase[] = [
    { caseId: '2024-09-24-broad-rally', reportDate: '2024-09-24' },
    { caseId: '2024-09-30-broad-rally', reportDate: '2024-09-30' },
    { caseId: '2024-10-08-broad-rally', reportDate: '2024-10-08' },
    { caseId: '2024-10-09-broad-decline', reportDate: '2024-10-09' },
    { caseId: '2025-04-07-broad-decline', reportDate: '2025-04-07' },
];

/** 默认 fixture 输出目录（相对于脚本所在目录）。 */
const DEFAULT_FIXTURE_DIR = path.resolve(
    __dirname,
    '..',
    '..',
    'aistock-agent-py',
    'tests',
    'fixtures',
    'historical_snapshots',
);

// ============================================================================
// 辅助函数
// ============================================================================

/** 将 YYYY-MM-DD 转换为 YYYYMMDD。 */
function toYyyymmdd(reportDate: string): string {
    return reportDate.replace(/-/g, '');
}

/** 检查 JSON 值是否包含完整 coverage。 */
function hasCompleteCoverage(snapshot: Record<string, unknown>): boolean {
    const coverage = snapshot['coverage'] as Record<string, unknown> | undefined;
    if (!coverage) return false;

    const current = coverage['current_daily'] as Record<string, unknown> | undefined;
    const previous = coverage['previous_daily'] as Record<string, unknown> | undefined;

    return !!(
        current?.['complete'] === true &&
        previous?.['complete'] === true
    );
}

// ============================================================================
// 主逻辑
// ============================================================================

async function exportHistoricalCloseSnapshots(
    cases: readonly HistoricalCase[],
    fixtureDirectory: string,
    dryRun: boolean,
): Promise<void> {
    if (dryRun) {
        console.log('[DRY RUN] 以下 5 个历史 case 将被导出:');
        console.log('');

        for (const item of cases) {
            const yyyymmdd = toYyyymmdd(item.reportDate);
            const outputPath = path.join(fixtureDirectory, `${item.reportDate}.json`);
            const nowOverride = new Date(`${item.reportDate}T16:00:00+08:00`);
            console.log(`  caseId:      ${item.caseId}`);
            console.log(`  reportDate:  ${item.reportDate}`);
            console.log(`  trade_date:  ${yyyymmdd}`);
            console.log(`  nowOverride: ${nowOverride.toISOString()}`);
            console.log(`  output:      ${outputPath}`);
            console.log('');
        }

        console.log('dry-run 模式，未写入任何文件。');
        return;
    }

    // 确保输出目录存在
    await mkdir(fixtureDirectory, { recursive: true });

    for (const item of cases) {
        const yyyymmdd = toYyyymmdd(item.reportDate);
        const outputPath = path.join(fixtureDirectory, `${item.reportDate}.json`);
        const nowOverride = new Date(`${item.reportDate}T16:00:00+08:00`);

        console.log(`[${item.caseId}] 正在采集 ${item.reportDate} 收盘快照...`);

        // 1. 调用 MarketSnapshotService.getTodayCloseSnapshot
        let snapshot: Record<string, unknown>;
        try {
            snapshot = await getTodayCloseSnapshot(nowOverride) as unknown as Record<string, unknown>;
        } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[FAIL] ${item.caseId}: getTodayCloseSnapshot 失败 — ${message}`);
            process.exit(1);
        }

        // 2. 校验 status === 'complete'
        if (snapshot['status'] !== 'complete') {
            console.error(
                `[FAIL] ${item.caseId}: status 不是 complete (got ${snapshot['status']})`,
            );
            process.exit(1);
        }

        // 3. 校验 trade_date 匹配
        if (snapshot['trade_date'] !== yyyymmdd) {
            console.error(
                `[FAIL] ${item.caseId}: trade_date 不匹配 — ` +
                `期望 ${yyyymmdd}，实际 ${snapshot['trade_date']}`,
            );
            process.exit(1);
        }

        // 4. 校验 coverage 完整
        if (!hasCompleteCoverage(snapshot)) {
            console.error(
                `[FAIL] ${item.caseId}: coverage 不完整 — ${JSON.stringify(snapshot['coverage'])}`,
            );
            process.exit(1);
        }

        // 5. 用 flag "wx" 写入，已有文件时直接失败
        const jsonContent = JSON.stringify(snapshot, null, 2) + '\n';
        try {
            await writeFile(outputPath, jsonContent, { encoding: 'utf8', flag: 'wx' });
        } catch (err: unknown) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
                console.error(
                    `[FAIL] ${item.caseId}: 目标文件已存在，不会覆盖 — ${outputPath}`,
                );
                process.exit(1);
            }
            throw err;
        }

        // 6. 校验写入内容的完整性
        const written = await import('node:fs/promises').then(
            (fs) => fs.readFile(outputPath, 'utf8'),
        );
        const parsed = JSON.parse(written) as Record<string, unknown>;
        if (parsed['trade_date'] !== yyyymmdd) {
            console.error(`[FAIL] ${item.caseId}: 写入后校验失败 — trade_date 不匹配`);
            process.exit(1);
        }

        console.log(`  ✅ 已写入 ${outputPath} (trade_date=${snapshot['trade_date']})`);
    }

    console.log('');
    console.log('全部 5 个历史快照采集完成。');
}

// ============================================================================
// 入口
// ============================================================================

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');

    const outDirIndex = args.indexOf('--out-dir');
    const fixtureDirectory =
        outDirIndex !== -1 && outDirIndex + 1 < args.length
            ? path.resolve(args[outDirIndex + 1])
            : DEFAULT_FIXTURE_DIR;

    await exportHistoricalCloseSnapshots(HISTORICAL_CASES, fixtureDirectory, dryRun);
}

main().catch((err: unknown) => {
    console.error('脚本异常退出:', err instanceof Error ? err.message : String(err));
    process.exit(1);
});
