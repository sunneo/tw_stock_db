#!/usr/bin/env node
// 本機網頁版測試伺服器（2026-11-15）：讓管理者「發布前」先在本機測網頁版，OK 才跑 scripts/publish.sh。
// 只綁 127.0.0.1、唯讀（不寫任何檔案、不改網頁版倉庫、不在網頁版倉庫提交任何東西）。
//
// 用法（在 desktop-app 目錄下執行）：
//   node scripts/web-local-serve.js                      # 起伺服器，預設埠 18770
//   node scripts/web-local-serve.js --port 18771         # 換埠
//   node scripts/web-local-serve.js --dry-run            # 只印出會被改寫的清單，不起伺服器
//   node scripts/web-local-serve.js --throttle 800       # 本機回應限速 800 kbps（模擬慢網路）
//   node scripts/web-local-serve.js --no-cache          # 回應一律 Cache-Control: no-store（預設即如此，參數只是寫明意圖）
//   node scripts/web-local-serve.js --web <網頁版目錄>    # 網頁版目錄；預設依序找 ../web、../../videos-嗨投資/web，或環境變數 FA_WEB_DIR
//
// 提供的路徑：
//   /web/...          → 網頁版目錄（index.html、aiweb/ 等）
//   /desktop-app/...  → 本機 desktop-app 目錄（renderer/、web-lazy/ 等建置產物）
//   /                 → 轉到 /web/
//
// 改寫規則（只在伺服器回應 .html 時即時改寫，磁碟上的檔案不動）：
//   https://raw.githubusercontent.com/sunneo/tw_stock_db/<完整SHA或refs/heads/分支>/desktop-app/<其餘路徑>
//   → http://127.0.0.1:<埠>/desktop-app/<其餘路徑>
//   以及 aiweb 頁的 RAW + '/<ref>/desktop-app/' 形狀 → '<同上本機網址>/desktop-app/'
//   其他外部資源（vendor-assets 的 sql.js、模型、字型、CDN，含 RAW + '/vendor-assets/…'）維持原網址，不改寫。
//
// 啟動前檢查：desktop-app 的建置產物（renderer/floating-assistant.js、renderer/floating-assistant.min.js、
// web-lazy/core.js）若比 renderer/src/** 或 renderer/*.template.html 舊，會印警告並提示先跑：
//   node scripts/embed-code-ui.js && node build-assistant.js
//
// 驗證步驟（完整流程見 DESIGN.release.md「發布前本機驗證」）：
//   1. node scripts/web-local-serve.js
//   2. curl -s http://127.0.0.1:18770/web/aiweb/ | grep -c raw.githubusercontent   （改寫後應只剩非 desktop-app 的網址）
//   3. Claude in Chrome 開 http://127.0.0.1:18770/web/aiweb/，依 DESIGN.release.md 的檢查清單驗證
//   4. OK 才 scripts/publish.sh

const http = require('http');
const fs = require('fs');
const path = require('path');

const HOST = '127.0.0.1';
const DESKTOP_DIR = path.resolve(__dirname, '..');
// 2026-11-15：核心與分塊改走 jsDelivr（釘 SHA）；本機測試一併改寫成本機 desktop-app 路徑
const JSD_RE = /https:\/\/cdn\.jsdelivr\.net\/gh\/sunneo\/tw_stock_db@[0-9a-f]{7,40}\/desktop-app\//g;
const JSD_CONCAT_RE = /'https:\/\/cdn\.jsdelivr\.net\/gh\/sunneo\/tw_stock_db@' \+ [A-Za-z_][A-Za-z0-9_]* \+ '\/desktop-app\//g;
// RAW + '/' + SHA 變數 + '/desktop-app/' 的形狀（aiweb 的 FA_RAWB）
const RAW_VAR_CONCAT_RE = /RAW \+ '\/' \+ [A-Za-z_][A-Za-z0-9_]* \+ '\/desktop-app\//g;
const RAW_RE = /https:\/\/raw\.githubusercontent\.com\/sunneo\/tw_stock_db\/((?:refs\/heads\/)?[^\/'"\s)`<>]+)\/desktop-app\//g;
const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
};

function parseArgs(argv) {
    const o = { port: 18770, dryRun: false, web: null, throttleKbps: 0, noCache: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--dry-run') o.dryRun = true;
        else if (a === '--port') o.port = Number(argv[++i]);
        else if (a === '--web') o.web = argv[++i];
        else if (a === '--throttle') o.throttleKbps = Number(argv[++i]);
        else if (a === '--no-cache') o.noCache = true;
        else { console.error('不認得的參數：' + a); process.exit(2); }
    }
    if (!(o.throttleKbps >= 0)) { console.error('--throttle 要是 0 或正數（kbps）'); process.exit(2); }
    if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) { console.error('埠號不合法'); process.exit(2); }
    return o;
}

function findWebDir(explicit) {
    // 先找主要的網頁版倉庫（D:\Downloads\videos-嗨投資\web）；從 worktree 執行時 ../web 是另一份分支內容，只當退路
    const cands = [explicit, process.env.FA_WEB_DIR, path.resolve(DESKTOP_DIR, '..', '..', 'videos-嗨投資', 'web'), path.resolve(DESKTOP_DIR, '..', 'web')].filter(Boolean);
    for (const c of cands) { const p = path.resolve(c); if (fs.existsSync(path.join(p, 'index.html'))) return p; }
    console.error('找不到網頁版目錄（需要含 index.html）。試過：\n  ' + cands.map((c) => path.resolve(c)).join('\n  ') + '\n請用 --web 指定，例如 --web "D:\\Downloads\\videos-嗨投資\\web"');
    process.exit(1);
}

// 建置產物是否比來源舊：不是最新就只警告（不擋啟動）
function walk(dir, pick, out = []) {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
    for (const e of ents) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, pick, out); else if (pick(p)) out.push(p);
    }
    return out;
}
function staleCheck() {
    const mt = (p) => { try { return fs.statSync(p).mtimeMs; } catch (_) { return null; } };
    const srcs = walk(path.join(DESKTOP_DIR, 'renderer', 'src'), (p) => /\.js$/.test(p))
        .concat(walk(path.join(DESKTOP_DIR, 'renderer'), (p) => /\.template\.html$/.test(p) && path.dirname(p) === path.join(DESKTOP_DIR, 'renderer')));
    let newest = 0, newestFile = '';
    for (const s of srcs) { const t = mt(s); if (t && t > newest) { newest = t; newestFile = s; } }
    const outs = ['renderer/floating-assistant.js', 'renderer/floating-assistant.min.js', 'web-lazy/core.js'];
    const stale = [];
    for (const o of outs) {
        const t = mt(path.join(DESKTOP_DIR, o));
        if (t === null) stale.push(`${o}（不存在）`);
        else if (t < newest) stale.push(`${o}（比來源 ${path.relative(DESKTOP_DIR, newestFile)} 舊）`);
    }
    if (stale.length) {
        console.warn('⚠️  建置產物不是最新的：\n  ' + stale.join('\n  ') + '\n  請先跑：node scripts/embed-code-ui.js && node build-assistant.js\n  （仍會啟動，但網頁版拿到的會是舊程式碼）');
    } else {
        console.log('建置產物已是最新（相對於 renderer/src 與樣板）。');
    }
}

// 改寫 html 文字；回傳 { text, hits: Map<原網址前綴, 次數> }
// aiweb/index.html 用 `const RAW = 'https://raw.githubusercontent.com/sunneo/tw_stock_db'` 再接字串（RAW + '/<ref>/desktop-app/…'），
// 所以另外處理 RAW + '/<ref>/desktop-app/' 這個形狀（改成字串字面值 'http://127.0.0.1:<埠>/desktop-app/'，語法仍合法）。
// RAW 本身不改（它還給 vendor-assets 用，那些要維持原網址）。
const RAW_CONCAT_RE = /RAW \+ '\/((?:refs\/heads\/)?[^\/'"\s]+)\/desktop-app\//g;
function rewriteHtml(text, port) {
    const hits = new Map();
    const bump = (k) => hits.set(k, (hits.get(k) || 0) + 1);
    let out = text.replace(JSD_RE, (m) => { bump(m); return `http://${HOST}:${port}/desktop-app/`; });
    out = out.replace(JSD_CONCAT_RE, (m) => { bump(m); return `'http://${HOST}:${port}/desktop-app/`; });
    out = out.replace(RAW_VAR_CONCAT_RE, (m) => { bump(m); return `'http://${HOST}:${port}/desktop-app/`; });
    out = out.replace(RAW_RE, (m) => { bump(m); return `http://${HOST}:${port}/desktop-app/`; });
    out = out.replace(RAW_CONCAT_RE, (m) => { bump(m); return `'http://${HOST}:${port}/desktop-app/`; });
    return { text: out, hits };
}

function resolveRequest(urlPath, webDir) {
    let pure;
    try { pure = decodeURIComponent(urlPath.split('?')[0]); } catch (_) { return null; }
    const m = /^\/(web|desktop-app)(\/.*)?$/.exec(pure);
    if (!m) return null;
    const base = path.resolve(m[1] === 'web' ? webDir : DESKTOP_DIR);
    let rel = (m[2] || '/').replace(/^\/+/, '');
    let full = path.resolve(base, rel);
    if (full !== base && !full.startsWith(base + path.sep)) return null; // 防止 .. 跳出目錄
    try { if (fs.statSync(full).isDirectory()) full = path.join(full, 'index.html'); } catch (_) { /* 下面會 404 */ }
    return full;
}

// 限速：每 50 毫秒送 bytesPerSec/20 位元組，模擬慢網路（只影響本機伺服器回應，不影響 jsDelivr 或 raw）
function sendThrottled(res, buf, bytesPerSec, done) {
    const chunk = Math.max(256, Math.floor(bytesPerSec / 20));
    let off = 0;
    const tick = () => {
        if (res.destroyed) return;
        if (off >= buf.length) { res.end(); return done(); }
        res.write(buf.subarray(off, off + chunk)); off += chunk;
        setTimeout(tick, 50);
    };
    tick();
}

function startServer(o, webDir) {
    const server = http.createServer((req, res) => {
        const t0 = Date.now();
        if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end('method not allowed'); }
        const pure = req.url.split('?')[0];
        if (pure === '/') { res.writeHead(302, { Location: '/web/' }); return res.end(); }
        const file = resolveRequest(req.url, webDir);
        let body = null;
        try { if (file && fs.statSync(file).isFile()) body = fs.readFileSync(file); } catch (_) { body = null; }
        if (!body) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('404 not found: ' + pure);
            console.log(`GET ${req.url} 404 (${Date.now() - t0}ms)`);
            return;
        }
        const ext = path.extname(file).toLowerCase();
        let outBody = body;
        let note = '';
        if (ext === '.html') {
            const r = rewriteHtml(body.toString('utf8'), o.port);
            outBody = Buffer.from(r.text, 'utf8');
            note = r.hits.size ? ` 改寫 ${[...r.hits.values()].reduce((a, b) => a + b, 0)} 處` : '';
        }
        // --no-cache：不論參數如何一律 no-store（預設也是 no-store，這個參數只是讓意圖寫明）；ETag／Last-Modified 本來就不送，瀏覽器不會條件式快取
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Content-Length': outBody.length });
        if (req.method === 'HEAD') return res.end();
        if (o.throttleKbps > 0) return sendThrottled(res, outBody, o.throttleKbps * 1024 / 8, () => console.log(`GET ${req.url} 200 (${Date.now() - t0}ms，限速 ${o.throttleKbps} kbps)${note}`));
        res.end(outBody);
        console.log(`GET ${req.url} 200 (${Date.now() - t0}ms)${note}`);
    });
    server.listen(o.port, HOST, () => {
        console.log(`本機網頁版測試伺服器：http://${HOST}:${o.port}/web/aiweb/   （網頁版目錄：${webDir}；desktop-app：${DESKTOP_DIR}）`);
        console.log('Ctrl+C 結束。只綁 127.0.0.1，唯讀。' + (o.throttleKbps > 0 ? ` 限速 ${o.throttleKbps} kbps。` : '') + (o.noCache ? ' no-cache（no-store）。' : ''));
    });
    server.on('error', (e) => { console.error('啟動失敗：' + e.message + '（埠 ' + o.port + ' 可能被占用，用 --port 換一個）'); process.exit(1); });
}

function dryRun(o, webDir) {
    const htmls = walk(webDir, (p) => /\.html$/i.test(p) && !/[\\/]node_modules[\\/]/.test(p));
    let total = 0;
    console.log(`網頁版目錄：${webDir}\n會被改寫的網址（只改 .html 回應；前綴 raw.githubusercontent.com/sunneo/tw_stock_db/<ref>/desktop-app/ → http://${HOST}:${o.port}/desktop-app/）：`);
    for (const f of htmls) {
        const r = rewriteHtml(fs.readFileSync(f, 'utf8'), o.port);
        if (!r.hits.size) continue;
        console.log(`  ${path.relative(webDir, f)}`);
        for (const [u, n] of r.hits) { console.log(`    ${n} × ${u}  →  http://${HOST}:${o.port}/desktop-app/`); total += n; }
    }
    console.log(`共 ${total} 處。其他外部網址（vendor-assets、CDN、模型）維持原樣。`);
    const pathsOk = ['renderer/floating-assistant.js', 'web-lazy/core.js'].map((p) => `${p}:${fs.existsSync(path.join(DESKTOP_DIR, p)) ? '存在' : '缺少'}`);
    console.log('本機對應檔案：' + pathsOk.join('、'));
}

const o = parseArgs(process.argv.slice(2));
const webDir = findWebDir(o.web);
if (o.dryRun) dryRun(o, webDir);
else { staleCheck(); startServer(o, webDir); }
