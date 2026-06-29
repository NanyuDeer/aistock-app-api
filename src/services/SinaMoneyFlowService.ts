/**
 * 新浪财经资金流向服务
 *
 * 用途：补充Tushare不支持的北交所（BJ）股票资金流向数据
 * 已验证：新浪 ssi_ssfx_flzjtj 接口对沪深和北交所都返回完整数据
 *
 * 字段映射（新浪→Tushare moneyflow_ths）：
 * - r0_in/r0_out（特大单流入/流出，元）→ buy_elg_amount/sell_elg_amount（万元）
 * - r1_in/r1_out（大单流入/流出，元）→ buy_lg_amount/sell_lg_amount（万元）
 * - r2_in/r2_out（中单流入/流出，元）→ buy_md_amount/sell_md_amount（万元）
 * - r3_in/r3_out（散单流入/流出，元）→ buy_sm_amount/sell_sm_amount（万元）
 * - netamount（净流入，元）→ net_mf_amount（万元）
 * - r0x_ratio（净占比，%）→ net_mf_ratio（%）
 */
import { sessionFetch } from '../utils/httpAgent';
import { createThrottler } from '../utils/throttle';
import type { MoneyflowThsRow } from './TushareService';

const sinaThrottler = createThrottler(120); // 间隔120ms，避免封IP

const HEADERS: Record<string, string> = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Referer': 'https://vip.stock.finance.sina.com.cn/',
};

export interface SinaMoneyflowRaw {
    r0_in: number;  // 特大单流入（元）
    r0_out: number; // 特大单流出（元）
    r0: number;     // 特大单成交额（元）
    r1_in: number;  // 大单流入（元）
    r1_out: number; // 大单流出（元）
    r1: number;     // 大单成交额（元）
    r2_in: number;  // 中单流入（元）
    r2_out: number; // 中单流出（元）
    r2: number;     // 中单成交额（元）
    r3_in: number;  // 散单流入（元）
    r3_out: number; // 散单流出（元）
    r3: number;     // 散单成交额（元）
    curr_capital: number; // 流通股本（万股）
    name: string;
    trade: number;       // 当前价
    changeratio: number; // 涨跌幅（小数，如0.047表示4.7%）
    volume: number;      // 成交量（股）
    turnover: number;    // 成交额（万元）
    r0x_ratio: number;   // 主力净占比（%）
    netamount: number;   // 净流入（元）
}

/**
 * 获取新浪资金流向（单日，当日数据）
 * @param symbol 股票代码（如 920116、600519、000001）
 * @returns 解析后的字段对象，失败返回 null
 */
export async function getSinaMoneyflow(symbol: string): Promise<SinaMoneyflowRaw | null> {
    // 直接根据代码规则判断前缀（兼容所有BJ代码：920xxx/83xxxx/87xxxx/430xxx）
    const prefix = resolveSinaPrefix(symbol);
    const sinaSymbol = `${prefix}${symbol}`;
    const url = `https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/MoneyFlow.ssi_ssfx_flzjtj?format=text&daima=${sinaSymbol}`;

    await sinaThrottler.throttle();
    try {
        const response = await sessionFetch(url, {
            method: 'GET',
            headers: HEADERS,
        });

        if (!response.ok) return null;
        const text = await response.text();
        if (!text || text.includes('__ERROR') || text.length < 30) return null;

        // 解析格式: ({...json...})
        const jsonStr = text.replace(/^\s*\(\s*\{/, '{').replace(/\}\s*\)\s*$/, '}');
        const obj = JSON.parse(jsonStr);

        return {
            r0_in: Number(obj.r0_in) || 0,
            r0_out: Number(obj.r0_out) || 0,
            r0: Number(obj.r0) || 0,
            r1_in: Number(obj.r1_in) || 0,
            r1_out: Number(obj.r1_out) || 0,
            r1: Number(obj.r1) || 0,
            r2_in: Number(obj.r2_in) || 0,
            r2_out: Number(obj.r2_out) || 0,
            r2: Number(obj.r2) || 0,
            r3_in: Number(obj.r3_in) || 0,
            r3_out: Number(obj.r3_out) || 0,
            r3: Number(obj.r3) || 0,
            curr_capital: Number(obj.curr_capital) || 0,
            name: obj.name || '',
            trade: Number(obj.trade) || 0,
            changeratio: Number(obj.changeratio) || 0,
            volume: Number(obj.volume) || 0,
            turnover: Number(obj.turnover) || 0,
            r0x_ratio: Number(obj.r0x_ratio) || 0,
            netamount: Number(obj.netamount) || 0,
        };
    } catch (err) {
        console.warn(`[SinaMoneyFlow] ${symbol} 获取失败:`, (err as Error).message);
        return null;
    }
}

/**
 * 转换为 Tushare MoneyflowThsRow 格式（与 moneyflow_ths 接口字段一致）
 * 新浪金额单位为元，Tushare moneyflow_ths 单位为万元，需 / 10000
 * @param symbol 股票代码（如 920116）
 * @param tradeDate 交易日期 YYYYMMDD
 */
export async function getSinaMoneyflowAsThs(symbol: string, tradeDate: string): Promise<MoneyflowThsRow | null> {
    const raw = await getSinaMoneyflow(symbol);
    if (!raw) return null;

    const toWan = (yuan: number) => Math.round(yuan / 10000 * 100) / 100;
    // 与 WindLeaderAnalyzerService.toTsCodeFromEm 保持一致
    const isBJ = symbol.startsWith('920') || symbol.startsWith('8') || symbol.startsWith('43');
    const first = symbol[0];
    const suffix = isBJ ? '.BJ' : first === '6' ? '.SH' : '.SZ';
    const tsCode = `${symbol}${suffix}`;

    return {
        ts_code: tsCode,
        trade_date: tradeDate,
        buy_sm_amount: toWan(raw.r3_in),
        buy_md_amount: toWan(raw.r2_in),
        buy_lg_amount: toWan(raw.r1_in),
        buy_elg_amount: toWan(raw.r0_in),
        sell_sm_amount: toWan(raw.r3_out),
        sell_md_amount: toWan(raw.r2_out),
        sell_lg_amount: toWan(raw.r1_out),
        sell_elg_amount: toWan(raw.r0_out),
        net_mf_amount: toWan(raw.netamount),
        net_mf_vol: 0, // 新浪接口无此字段
        buy_sm_ratio: 0,
        buy_md_ratio: 0,
        buy_lg_ratio: 0,
        buy_elg_ratio: 0,
        sell_sm_ratio: 0,
        sell_md_ratio: 0,
        sell_lg_ratio: 0,
        sell_elg_ratio: 0,
        net_mf_ratio: raw.r0x_ratio,
        mf_5day: 0, // 新浪单日接口无5日数据
    };
}

/**
 * 批量获取北交所股票的资金流向（补充Tushare缺口）
 * @param bjSymbols BJ股票代码数组
 * @param tradeDate 交易日期
 * @returns Map<tsCode, MoneyflowThsRow>
 */
export async function getBatchSinaMoneyflowForBJ(
    bjSymbols: string[],
    tradeDate: string,
): Promise<Map<string, MoneyflowThsRow>> {
    const result = new Map<string, MoneyflowThsRow>();
    if (bjSymbols.length === 0) return result;

    console.log(`[SinaMoneyFlow] 批量获取 ${bjSymbols.length} 只BJ股票资金流向（新浪）...`);
    let successCount = 0;
    for (const symbol of bjSymbols) {
        const row = await getSinaMoneyflowAsThs(symbol, tradeDate);
        if (row) {
            result.set(row.ts_code, row);
            successCount++;
        }
    }
    console.log(`[SinaMoneyFlow] 完成: 成功 ${successCount}/${bjSymbols.length}`);
    return result;
}

/**
 * 判断股票是否为北交所股票
 */
export function isBJStock(symbol: string): boolean {
    if (!symbol) return false;
    // BJ股票代码特征：6位数字，开头为 8 或 9（如 920116、830879、832145、430090）
    return /^[89]\d{5}$/.test(symbol) || /^43\d{4}$/.test(symbol);
}

/**
 * 解析新浪接口所需的市场前缀
 * BJ: 920xxx / 83xxxx / 87xxxx / 430xxx
 * SH: 6xxxxx (沪市主板/科创板) / 9xxxxx(B股除外)
 * SZ: 0xxxxx / 3xxxxx
 */
function resolveSinaPrefix(symbol: string): 'sh' | 'sz' | 'bj' {
    if (!symbol) return 'sh';
    if (symbol.startsWith('920') || symbol.startsWith('8') || symbol.startsWith('43')) return 'bj';
    if (symbol.startsWith('6') || symbol.startsWith('9')) return 'sh';
    if (symbol.startsWith('0') || symbol.startsWith('3') || symbol.startsWith('2')) return 'sz';
    return 'sh';
}
