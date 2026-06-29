/**
 * PDF 文本提取服务
 * 移植自 Python 爬虫 pdf_extract.py
 *
 * 简化策略：
 * - 使用 pdf-parse 提取纯文本（无原生依赖）
 * - 跳过表格提取（Python 用 pdfplumber，JS 无等价库）
 * - 跳过图片渲染（Python 代码注释已说明不发送图片给 AI）
 * - 如果 pdf-parse 失败，返回空文本，由上层降级到详情页提取
 */

import type { PdfContent } from './types';

// pdf-parse v2 API：new PDFParse({ verbosity }) → load({ data }) → getText()
let pdfParseMod: any = null;

async function loadPdfParseMod() {
    if (pdfParseMod) return pdfParseMod;
    try {
        pdfParseMod = await import('pdf-parse');
        return pdfParseMod;
    } catch {
        console.warn('[PdfExtractor] pdf-parse 未安装，PDF 文本提取不可用');
        return null;
    }
}

/**
 * 提取 PDF 内容
 * @param pdfBytes PDF 二进制数据
 * @param maxPages 最大提取页数（默认 6）
 */
export async function extractPdfContent(
    pdfBytes: Buffer,
    maxPages = 6,
): Promise<PdfContent> {
    if (!pdfBytes || pdfBytes.length < 100) {
        return { text: '', tables: [], images: [] };
    }

    // 验证 PDF 文件头
    if (!pdfBytes.subarray(0, 5).toString('ascii').startsWith('%PDF')) {
        console.warn('[PdfExtractor] 非 PDF 内容，跳过');
        return { text: '', tables: [], images: [] };
    }

    const mod = await loadPdfParseMod();
    if (!mod?.PDFParse) {
        return { text: '', tables: [], images: [] };
    }

    try {
        const { PDFParse, VerbosityLevel } = mod;
        // v2: data 直接传给构造函数
        const parser = new PDFParse({
            data: new Uint8Array(pdfBytes),
            verbosity: VerbosityLevel?.ERRORS ?? 0,
        });
        const result = await parser.getText();
        // v2 返回 { pages: [{ text }], total } 或 { text }
        let fullText = '';
        if (Array.isArray(result?.pages)) {
            const pages = result.pages.slice(0, maxPages);
            const texts: string[] = [];
            pages.forEach((p: any, index: number) => {
                const t = (p.text || '').trim();
                if (t) texts.push(`[第${index + 1}页]\n${t}`);
            });
            fullText = texts.join('\n\n');
        } else if (typeof result?.text === 'string') {
            // 兼容 v1 风格
            const allPages = result.text.split('\f').slice(0, maxPages);
            const texts: string[] = [];
            allPages.forEach((pageText: string, index: number) => {
                const t = pageText.trim();
                if (t) texts.push(`[第${index + 1}页]\n${t}`);
            });
            fullText = texts.join('\n\n');
        }

        return {
            text: fullText,
            tables: [],  // 跳过表格提取
            images: [], // 跳过图片渲染
        };
    } catch (err) {
        console.error('[PdfExtractor] PDF 解析失败:', (err as Error).message);
        return { text: '', tables: [], images: [] };
    }
}
