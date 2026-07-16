const fs = require('fs');
const path = require('path');
const http = require('http');

const reportPath = path.join(__dirname, '..', '..', 'aistock-agent-py', 'docs', 'agent-outputs', 'review', '2026-07-16-1645-review.md');
const content = fs.readFileSync(reportPath, 'utf-8');

const payload = {
  report_type: 'review',
  report_date: '2026-07-16',
  content: {
    text: content,
    display_report: {
      summary: '亚洲芯片股崩盘+Q2 GDP不及预期，半导体/消费承压，能源逆势',
      details: content,
      stocks: ['半导体', '存储芯片', '算力硬件', '石油石化', '煤炭', '电力', '白酒', '房地产'],
      risks: ['数据源不可用，分析基于外围市场传导逻辑推断']
    },
    podcast_brief: '今日复盘：亚洲芯片股暴跌（SK海力士-10%+）叠加中国Q2 GDP 4.3%不及预期，A股半导体、算力硬件、消费板块承压；能源板块受益于油价85美元+地缘溢价逆势走强。',
    schema_version: '2.0'
  },
  status: 'completed'
};

const postData = JSON.stringify(payload);

const token = 'hTEltVISNMfsIglLRYsz1cqP9indur-QK6stI1Nivng';

const options = {
  hostname: 'localhost',
  port: 3000,
  path: '/internal/analysis-reports',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-Internal-Token': token,
    'Content-Length': Buffer.byteLength(postData)
  }
};

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    console.log('Status:', res.statusCode);
    console.log('Response:', data);
  });
});

req.on('error', (e) => {
  console.error('Error:', e.message);
});

req.write(postData);
req.end();
