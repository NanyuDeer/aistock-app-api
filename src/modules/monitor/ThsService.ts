import * as cheerio from 'cheerio';
import { parseTable } from '../../shared/utils/parser';
import { thsThrottler } from '../../shared/utils/throttlers';
import { sessionFetch } from '../../shared/utils/httpAgent';

export class ThsService {
    private static readonly BASE_URL = 'http://basic.10jqka.com.cn';
    private static readonly HEADERS = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
    };

    static async getProfitForecast(symbol: string): Promise<Record<string, any>> {
        const url = `${this.BASE_URL}/${symbol}/worth.html`;
        await thsThrottler.throttle();

        const response = await sessionFetch(url, { headers: this.HEADERS });
        if (!response.ok) throw new Error(`同花顺接口请求失败: ${response.status}`);

        const arrayBuffer = await response.arrayBuffer();
        const html = new TextDecoder('gbk').decode(arrayBuffer);

        const cleanHtml = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<!--[\s\S]*?-->/g, '');

        const $ = cheerio.load(cleanHtml, { scriptingEnabled: false });

        const result: Record<string, any> = { '摘要': '', '业绩预测详表_详细指标预测': [] };
        result['摘要'] = $('#forecast > div.bd > p.tip.clearfix').text().trim().replace(/\s+/g, ' ');

        const detailTable = $('#forecastdetail > div.bd > table.m_table.m_hl.ggintro.ggintro_1.organData');
        if (detailTable.length > 0) result['业绩预测详表_详细指标预测'] = parseTable($, detailTable[0], '业绩预测详表-详细指标预测');

        return result;
    }
}
