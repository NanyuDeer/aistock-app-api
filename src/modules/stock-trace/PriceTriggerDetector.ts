import { TencentQuoteService } from '../quote/TencentQuoteService';
import { isAShareTradingTime } from '../../shared/utils/tradingTime';
import { StockTraceService } from './StockTraceService';
import { isEligiblePriceSecurity, type PriceFact } from './types';

const DETECTOR_INTERVAL_MS = 5_000;
const SYMBOL_FIELD = '股票代码';
const NAME_FIELD = '股票简称';
const PRICE_FIELD = '最新价';
const PREVIOUS_CLOSE_FIELD = '昨收价';
const CHANGE_FIELD = '涨跌幅';

function numeric(value: unknown): number | null {
    const numberValue = typeof value === 'number' ? value : Number(value);
    return Number.isFinite(numberValue) ? numberValue : null;
}

export class PriceTriggerDetector {
    private static timer: NodeJS.Timeout | null = null;
    private static running = false;

    static start(): void {
        if (this.timer) return;
        this.timer = setInterval(() => void this.runOnce(), DETECTOR_INTERVAL_MS);
        this.timer.unref();
        void this.runOnce();
    }

    static stop(): void {
        if (!this.timer) return;
        clearInterval(this.timer);
        this.timer = null;
    }

    static async runOnce(now = new Date()): Promise<void> {
        if (this.running || !(await isAShareTradingTime({ now }))) return;
        await this.detect(now);
    }

    /**
     * 强制执行一次价格检测（绕过交易时段限制）。
     * 供手动触发使用：非交易日/非交易时段也能检测自选股异动。
     * 与 runOnce 的区别：不检查 isAShareTradingTime，其余逻辑完全一致。
     */
    static async runOnceForce(now = new Date()): Promise<void> {
        if (this.running) return;
        await this.detect(now);
    }

    private static async detect(now: Date): Promise<void> {
        this.running = true;
        try {
            const securities = (await StockTraceService.getFavoriteSecurities())
                .filter((security) => isEligiblePriceSecurity(security, now));
            if (securities.length === 0) return;

            const quotes = await TencentQuoteService.getBatchQuotes(securities.map((security) => security.symbol), 'core');
            const quoteBySymbol = new Map<string, Record<string, unknown>>();
            for (const quote of quotes) {
                const symbol = typeof quote[SYMBOL_FIELD] === 'string' ? quote[SYMBOL_FIELD] : '';
                if (symbol) quoteBySymbol.set(symbol, quote);
            }

            for (const security of securities) {
                const quote = quoteBySymbol.get(security.symbol);
                if (!quote) continue;
                const latestPrice = numeric(quote[PRICE_FIELD]);
                const previousClose = numeric(quote[PREVIOUS_CLOSE_FIELD]);
                const changePct = numeric(quote[CHANGE_FIELD]);
                if (latestPrice === null || previousClose === null || previousClose <= 0 || changePct === null) continue;
                const fact: PriceFact = {
                    symbol: security.symbol,
                    stockName: typeof quote[NAME_FIELD] === 'string' ? quote[NAME_FIELD] : security.stockName,
                    latestPrice,
                    previousClose,
                    changePct,
                    observedAt: now,
                };
                await StockTraceService.processPriceFact(security, fact);
            }
        } finally {
            this.running = false;
        }
    }
}
