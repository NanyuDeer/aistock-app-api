/**
 * StockInfoJudgeService prompt 证据硬规则测试（Task 4）
 *
 * 背景：抓取入库时的一句话结论由 StockInfoJudgeService 调 LLM 生成，
 * 原 prompt 只规定输出字段、无证据口径约束。本测试校验两个 prompt
 * 已注入「研判硬规则」与版本号（对齐「AI 解读」链路约束口径）。
 *
 * 运行：`node --import tsx --test src/modules/crawler/__tests__/stockInfoJudgePrompt.spec.ts`
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildAnnouncementPrompt,
  buildNewsPrompt,
  PROMPT_VERSION,
} from '../services/StockInfoJudgeService';
import type { EastmoneyAnnouncement, EastmoneyNews, PdfContent } from '../services/types';

const announcement = {
  symbol: '600383',
  stock_name: '金地集团',
  title: '测试公告',
  published_at: '2026-09-30 08:00:00',
  detail_url: 'https://x/a',
  pdf_url: 'https://x/a.pdf',
} as unknown as EastmoneyAnnouncement;

const pdf = { text: '正文', tables: [] } as unknown as PdfContent;

const news = {
  symbol: '600383',
  stock_name: '金地集团',
  title: '测试新闻',
  media_name: '证券时报',
  published_at: '2026-09-30 08:00:00',
  url: 'https://x/n',
  content: '正文',
} as unknown as EastmoneyNews;

describe('StockInfoJudgeService prompt 证据硬规则', () => {
  it('公告 prompt 含证据硬规则与版本号', () => {
    const p = buildAnnouncementPrompt(announcement, pdf);
    assert.ok(p.includes('禁止给出目标价'));
    assert.ok(p.includes('区分事实与推断'));
    assert.ok(p.includes('证据可回溯'));
    assert.ok(p.includes(PROMPT_VERSION));
    assert.ok(p.includes('"ai_summary"'));
  });

  it('新闻 prompt 同样注入硬规则', () => {
    const p = buildNewsPrompt(news);
    assert.ok(p.includes('禁止给出目标价'));
    assert.ok(p.includes('区分事实与推断'));
    assert.ok(p.includes(PROMPT_VERSION));
  });
});
