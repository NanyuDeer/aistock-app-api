const http = require('http');
http.get('http://localhost:3000/api/agent/report/review/2026-07-16', (r) => {
  let d = '';
  r.on('data', (c) => { d += c; });
  r.on('end', () => {
    try {
      const j = JSON.parse(d);
      console.log('http status:', r.statusCode);
      console.log('code:', j.code);
      console.log('msg:', j.message);
      const data = j.data || j;
      if (data && typeof data === 'object') {
        console.log('report_type:', data.report_type);
        console.log('report_date:', data.report_date);
        console.log('content keys:', Object.keys(data.content || {}));
        const dr = (data.content || {}).display_report;
        if (dr) {
          console.log('summary:', (dr.summary || '').slice(0, 100));
          console.log('stocks:', JSON.stringify(dr.stocks));
          console.log('risks:', JSON.stringify(dr.risks));
          console.log('details len:', (dr.details || '').length);
        } else {
          console.log('no display_report, text len:', ((data.content || {}).text || '').length);
        }
      } else {
        console.log('no data, raw:', d.slice(0, 300));
      }
    } catch (e) {
      console.log('parse err:', e.message, d.slice(0, 300));
    }
  });
}).on('error', (e) => console.error(e.message));
