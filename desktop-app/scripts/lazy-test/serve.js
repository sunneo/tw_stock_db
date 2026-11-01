// 本機靜態伺服器（測網頁版延遲載入用）：node scripts/lazy-test/serve.js [埠]；根目錄是 desktop-app
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.join(__dirname, '..', '..');
const port = Number(process.argv[2]) || 8765;
const types = { '.js': 'application/javascript', '.html': 'text/html; charset=utf-8', '.json': 'application/json' };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(root, u === '/' ? 'scripts/lazy-test/harness.html' : u);
  if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(port, () => console.log('http://localhost:' + port));
