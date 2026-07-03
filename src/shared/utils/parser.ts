import * as cheerio from 'cheerio';

type CheerioStatic = ReturnType<typeof import('cheerio').load>;
type CheerioElement = any;

const getText = ($: CheerioStatic, el: CheerioElement): string => $(el).text().trim();

function parseInstitutionTable($: CheerioStatic, tableElement: CheerioElement): Record<string, any>[] {
    const data: Record<string, any>[] = [];
    const headerRows = $(tableElement).find('thead tr');
    if (headerRows.length < 2) return parseFlatTable($, tableElement);

    const row0Cells = $(headerRows[0]).find('th, td');
    let epsHeaderName = '预测年报每股收益', profitHeaderName = '预测年报净利润';
    row0Cells.each((_: number, el: CheerioElement) => {
        const txt = getText($, el);
        if (txt.includes('每股收益')) epsHeaderName = txt;
        if (txt.includes('净利润')) profitHeaderName = txt;
    });

    const row1Cells = $(headerRows[1]).find('th, td');
    const yearsEPS = [0, 1, 2].map(i => getText($, row1Cells[i]));
    const yearsProfit = [3, 4, 5].map(i => getText($, row1Cells[i]));

    const tbody = $(tableElement).find('tbody');
    const dataRows = tbody.length > 0 ? tbody.find('tr') : $(tableElement).find('tr').slice(headerRows.length);

    dataRows.each((_: number, row: CheerioElement) => {
        const cells = $(row).find('th, td');
        if (cells.length < 9) return;
        data.push({
            '机构名称': getText($, cells[0]), '研究员': getText($, cells[1]),
            [epsHeaderName]: { [yearsEPS[0]]: getText($, cells[2]), [yearsEPS[1]]: getText($, cells[3]), [yearsEPS[2]]: getText($, cells[4]) },
            [profitHeaderName]: { [yearsProfit[0]]: getText($, cells[5]), [yearsProfit[1]]: getText($, cells[6]), [yearsProfit[2]]: getText($, cells[7]) },
            '报告日期': getText($, cells[8]),
        });
    });
    return data;
}

function parseFlatTable($: CheerioStatic, tableElement: CheerioElement): Record<string, any>[] {
    const data: Record<string, any>[] = [], headers: string[] = [];
    let headerRow = $(tableElement).find('thead tr').last();
    if (headerRow.length === 0) headerRow = $(tableElement).find('tr').first();
    headerRow.find('th, td').each((_: number, cell: CheerioElement) => { headers.push(getText($, cell)); });

    const tbody = $(tableElement).find('tbody');
    const dataRows = tbody.length > 0 ? tbody.find('tr') : $(tableElement).find('tr').slice(1);
    dataRows.each((_: number, row: CheerioElement) => {
        const cells = $(row).find('th, td');
        if (cells.length === 0) return;
        const rowObj: Record<string, string> = {};
        cells.each((idx: number, cell: CheerioElement) => { if (headers[idx]) rowObj[headers[idx]] = getText($, cell); });
        if (Object.keys(rowObj).length > 0) data.push(rowObj);
    });
    return data;
}

function parseDetailedForecastTable($: CheerioStatic, tableElement: CheerioElement): Record<string, any>[] {
    const data: Record<string, any>[] = [], headers: string[] = [];
    const getCleanText = (el: CheerioElement): string => {
        const prSpan = $(el).find('div.pr > span');
        if (prSpan.length > 0) return prSpan.first().text().trim();
        let text = '';
        $(el).contents().each((_: number, child: CheerioElement) => {
            if (child.type === 'text') text += child.data || '';
            else if (child.type === 'tag' && child.name !== 'table' && child.name !== 'div') text += $(child).text();
        });
        return text.replace(/\s+/g, '');
    };

    let headerRow = $(tableElement).children('thead').children('tr').last();
    if (headerRow.length === 0) headerRow = $(tableElement).children('tbody').children('tr').first();
    if (headerRow.length === 0) headerRow = $(tableElement).children('tr').first();

    headerRow.children('th, td').each((_: number, cell: CheerioElement) => {
        let text = getCleanText(cell);
        text = text.replace(/（/g, '-').replace(/）/g, '').replace(/\(/g, '-').replace(/\)/g, '').replace(/\s+/g, '');
        if (text) headers.push(text);
    });

    let dataRows = $(tableElement).children('tbody').children('tr');
    if (dataRows.length === 0) dataRows = $(tableElement).children('tr').slice(1);

    dataRows.each((_: number, row: CheerioElement) => {
        const cells = $(row).children('th, td');
        if (cells.length === 0) return;
        const rowObj: Record<string, string> = {};
        cells.each((idx: number, cell: CheerioElement) => { if (headers[idx]) rowObj[headers[idx]] = getCleanText(cell); });
        if (Object.keys(rowObj).length > 0) data.push(rowObj);
    });
    return data;
}

export function parseTable($: CheerioStatic, tableElement: CheerioElement, type: string): Record<string, any>[] {
    if (type === '业绩预测详表-机构') return parseInstitutionTable($, tableElement);
    if (type === '业绩预测详表-详细指标预测') return parseDetailedForecastTable($, tableElement);
    return parseFlatTable($, tableElement);
}
