// 在隱藏視窗的真 Electron（Chromium）裡跑訓練頁：
//   <electron.exe> scripts/webgpu-train/main.js --no-sandbox --user-data-dir=<全新暫存資料夾> --data=<export-graph 的輸出資料夾> --ort=<onnxruntime-web 的 dist 資料夾> [--ep=webgpu|wasm] [--steps=3] [--lr=0.001] [--opt=disabled] [--trace=1] [--port=18765]
// 本機 http 伺服器綁 127.0.0.1（安全來源，WebGPU 才有 navigator.gpu），只服務上述兩個資料夾與 page.html；視窗 show:false，不搶焦點。
const { app, BrowserWindow } = require('electron'); const http = require('http'), fs = require('fs'), path = require('path');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const data = arg('data'), ortDir = arg('ort'), ep = arg('ep', 'webgpu'), steps = arg('steps', '3'), lr = arg('lr', '0.001'), opt = arg('opt', 'disabled'), trace = arg('trace', '0'), port = +arg('port', '18765'), pageName = arg('page', 'page.html');
const types = { '.html': 'text/html', '.mjs': 'text/javascript', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json', '.onnx': 'application/octet-stream', '.bin': 'application/octet-stream' };
const server = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]); let f = null;
    if (u === '/' + pageName) f = path.join(__dirname, pageName); else if (u.startsWith('/ort/')) f = path.join(ortDir, path.basename(u)); else if (u.startsWith('/src/')) f = path.join(__dirname, '..', '..', 'renderer', 'src', 'studio', path.basename(u)); else if (u.startsWith('/data/')) f = path.join(data, path.basename(u));
    if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': types[path.extname(f)] || 'application/octet-stream', 'Content-Length': fs.statSync(f).size, 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp', 'Cross-Origin-Resource-Policy': 'same-origin' });
    fs.createReadStream(f).pipe(res);
});
app.whenReady().then(() => {
    server.listen(port, '127.0.0.1', async () => {
        const win = new BrowserWindow({ show: false, width: 800, height: 600, webPreferences: { sandbox: false, backgroundThrottling: false } });
        win.webContents.on('console-message', (e, level, message) => { const m = typeof level === 'object' ? level.message : message; if (/^RESULT |PAGE_FINISHED/.test(m)) { console.log(m); if (/PAGE_FINISHED/.test(m)) { server.close(); app.quit(); } } });
        win.webContents.on('render-process-gone', (e, d) => { console.log('RESULT ' + JSON.stringify({ error: 'render-process-gone ' + d.reason })); app.quit(); });
        await win.loadURL('http://127.0.0.1:' + port + '/' + pageName + '?ep=' + ep + '&steps=' + steps + '&lr=' + lr + '&opt=' + opt + '&trace=' + trace + (arg('extra') ? '&' + arg('extra') : ''));
    });
});
