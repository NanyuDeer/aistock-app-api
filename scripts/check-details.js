const http = require('http');
http.get('http://localhost:3000/api/agent/report/review/2026-07-16', (r) => {
  let d = '';
  r.on('data', (c) => { d += c; });
  r.on('end', () => {
    const j = JSON.parse(d);
    const data = j.data || j;
    const content = data.content || {};
    const dr = content.display_report || {};
    console.log('=== details (前500字符) ===');
    console.log(dr.details ? dr.details.slice(0, 500) : '(空)');
    console.log('\n=== details 类型 ===');
    console.log(typeof dr.details);
    console.log('\n=== text 字段(前300字符) ===');
    console.log(content.text ? content.text.slice(0, 300) : '(空)');
    console.log('\n=== stocks ===');
    console.log(JSON.stringify(dr.stocks));
  });
}).on('error', (e) => console.error(e.message));
