// 本機代理遇到「上游回應標頭很肥」不能變成 502（2026-11-08：YouTube 首頁標頭約 12～13KB，貼著 Node 預設 16KB 上限，
// 一超過就是 502／Parse Error: Header overflow）。這裡用本機假上游送出 40KB 標頭，確認代理照樣轉成 200。
const http = require('http');
const { startLocalProxy } = require('../local-proxy.js');
let pass = 0, fail = 0;
const t = (n, ok, x) => { if (ok) pass++; else { fail++; console.log('✗', n, x === undefined ? '' : JSON.stringify(x)); } };
(async () => {
  const big = http.createServer((req, res) => {
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/html', 'X-Pad-A': 'a'.repeat(8000), 'X-Pad-B': 'b'.repeat(8000), 'X-Pad-C': 'c'.repeat(8000), 'X-Pad-D': 'd'.repeat(8000), 'X-Pad-E': 'e'.repeat(8000) }); res.end('<html>ok</html>'); }
    else { res.writeHead(200); res.end('small'); }
  });
  await new Promise((r) => big.listen(0, '127.0.0.1', r));
  const up = big.address().port;
  await startLocalProxy({ preferredPort: 48931, getSecrets: async () => ({}) });
  const get = (path) => new Promise((r) => http.get({ host: '127.0.0.1', port: 48931, path, headers: {}, maxHeaderSize: 1048576 }, (res) => { const c = []; res.on('data', (d) => c.push(d)); res.on('end', () => r({ s: res.statusCode, x: res.headers['x-fa-error'], b: Buffer.concat(c).toString() })); }).on('error', (e) => r({ err: e.message })));
  const a = await get(`/proxy/http://127.0.0.1:${up}/big`);
  t('40KB 標頭的上游回應照樣 200', a.s === 200 && /ok/.test(a.b) && !a.x, a);
  const b = await get(`/proxy/http://127.0.0.1:${up}/small`);
  t('一般回應不受影響', b.s === 200 && b.b === 'small', b);
  const c = await get('/proxy/http://127.0.0.1:1/x');
  t('連不上上游仍回 502＋x-fa-error: connect（才有東西可重試）', c.s === 502 && c.x === 'connect', c);
  console.log(`local-proxy-bigheader: ${pass}/${pass + fail} 通過`);
  process.exit(fail ? 1 : 0);
})();
