#!/usr/bin/env node
// 網頁版冷載入量測（無頭 Chrome，2026-11-15）：每次用全新的暫存設定檔（= 沒有任何快取）開啟 web/aiweb/，
// 等 window.fa 出現，取回就緒時間、資源時間與同步分塊載入順序，印摘要並可寫成 JSON。
// 不開桌面視窗、不用內建瀏覽器；用的是 Chrome 的 --headless=new 與 --dump-dom（虛擬時間）。
//
// 用法（在 desktop-app 目錄下）：
//   node scripts/web-cold-load-headless.js                       # 本機改寫模式（核心與分塊走本機建置產物）
//   node scripts/web-cold-load-headless.js --no-rewrite          # 基線：不改寫，頁面照原網址走 jsDelivr／raw 等外部來源
//   node scripts/web-cold-load-headless.js --throttle 800 --runs 3 --out <結果.json>
// 參數：--runs N（預設 1）、--throttle <kbps>（只限速本機伺服器回應，見 web-local-serve.js）、--budget <毫秒>（虛擬時間上限，預設 900000；太小會在網頁還在下載時就截止）、
//       --port <埠>（預設 18780）、--out <檔案>（寫出每次的原始結果）、--chrome <chrome.exe 路徑>
// 注意：--no-rewrite 時外部來源是真實網路，結果會隨網路狀況變動；比較時請在同一時段、同一網路下交替量。
'use strict';
const { spawn, execFile } = require('child_process');
const http = require('http');
const fs = require('fs'); const os = require('os'); const path = require('path');

const DESKTOP_DIR = path.resolve(__dirname, '..');
const SERVE = path.join(__dirname, 'web-local-serve.js');

function parseArgs(argv) {
    const o = { runs: 1, throttle: 0, budget: 900000, port: 18780, out: '', noRewrite: false, chrome: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--runs') o.runs = Number(argv[++i]);
        else if (a === '--throttle') o.throttle = Number(argv[++i]);
        else if (a === '--budget') o.budget = Number(argv[++i]);
        else if (a === '--port') o.port = Number(argv[++i]);
        else if (a === '--out') o.out = argv[++i];
        else if (a === '--chrome') o.chrome = argv[++i];
        else if (a === '--no-rewrite') o.noRewrite = true;
        else if (a === '--web') o.web = argv[++i];
        else { console.error('不認得的參數：' + a); process.exit(2); }
    }
    if (!(o.runs >= 1)) { console.error('--runs 要是 1 以上'); process.exit(2); }
    return o;
}

function startServer(o) {
    const args = [SERVE, '--measure', '--port', String(o.port)];
    if (o.throttle > 0) args.push('--throttle', String(o.throttle));
    if (o.noRewrite) args.push('--no-rewrite');
    if (o.web) args.push('--web', o.web);
    const child = spawn(process.execPath, args, { cwd: DESKTOP_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    return new Promise((resolve, reject) => {
        let buf = '';
        const onData = (d) => { buf += d.toString('utf8'); if (buf.indexOf('Ctrl+C') >= 0) resolve(child); };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error('本機伺服器提早結束（代碼 ' + code + '）：' + buf.slice(0, 300))));
        setTimeout(() => resolve(child), 8000); // 保險：8 秒後不論看到什麼都繼續
    });
}

function getJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (d) => { body += d; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

function unescapeHtml(s) {
    return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
}

// 清掉這次量測啟動的 Chrome 殘留：只殺命令列含本次暫存 user-data-dir 路徑的行程（那是本腳本獨有的標記，不會碰使用者的 Chrome）。
// 標記走環境變數傳入，不放進 powershell 的命令列（否則 powershell 自己的命令列會含標記，把自己殺掉）；另外排除自己的 $PID。
function killByProfileMarker(profile) {
    if (process.platform !== 'win32') return;
    const ps = "Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and $_.CommandLine.Contains($env:FA_KILL_MARK) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }";
    const env = Object.assign({}, process.env, { FA_KILL_MARK: profile });
    try { require('child_process').execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: 'ignore', timeout: 30000, env }); } catch (_) { /* 清不掉就算了，下次腳本會再清 */ }
}

function runChrome(o, url) {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cold-'));
    const args = [
        '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--disable-extensions',
        '--user-data-dir=' + profile, '--virtual-time-budget=' + o.budget, '--dump-dom', url,
    ];
    return new Promise((resolve, reject) => {
        execFile(o.chrome, args, { maxBuffer: 200 * 1024 * 1024, timeout: o.budget + 120000 }, (err, stdout) => {
            killByProfileMarker(profile); // 主行程結束後，子行程（renderer、gpu、crashpad）可能還活著，一併清掉
            try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 暫存目錄清不掉就算了 */ }
            if (err && !stdout) return reject(err);
            resolve(stdout || '');
        });
    });
}

function summarize(p) {
    const res = p.resources || [];
    const isLocal = (n) => /^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(n);
    const ext = res.filter((r) => !isLocal(r.n));
    const hosts = {};
    for (const r of ext) { const h = (r.n.match(/^https?:\/\/([^/]+)/) || [])[1] || '?'; hosts[h] = (hosts[h] || 0) + 1; }
    const core = res.find((r) => /\/web-lazy\/core\.js/.test(r.n));
    // 探針在 fa 就緒時才記錄資源，所以這裡的請求都是就緒前發出的（虛擬時間的 startTime 不可當真實時間，只數數量）
    const atReady = p.resourcesAtReady || res; // 就緒那一刻的快照：開機路徑上的請求（之後才發出的請求不算）
    const before = atReady.length;
    return {
        wallReadyMs: p.wallReadyMs, htmlCount: p.htmlCount, readyMsVirtual: p.readyMs, domContentLoadedMs: p.domContentLoadedMs, loadMs: p.loadMs,
        resourceCount: res.length, externalCount: ext.length, hosts,
        coreStartMs: core ? core.s : null, coreEndMs: core ? core.e : null, coreBytes: core ? core.b : null,
        requestsStartedBeforeReady: before,
        externalAtReady: atReady.filter((r) => !isLocal(r.n)).length,
        externalHostsAtReady: atReady.filter((r) => !isLocal(r.n)).reduce((m, r) => { const h = (r.n.match(/^https?:\/\/([^/]+)/) || [])[1] || '?'; m[h] = (m[h] || 0) + 1; return m; }, {}),
        syncChunkLoads: (p.trace || []).filter((x) => typeof x === 'string' || x.how !== 'prefetch').length,
        prefetchedChunkLoads: (p.trace || []).filter((x) => typeof x === 'object' && x.how === 'prefetch').length, syncChunkOrder: (p.trace || []).map((x) => (typeof x === 'string' ? x : x.name)), syncChunkStacks: (p.trace || []).map((x) => (typeof x === 'string' ? '' : x.stack)),
        chunkRequests: res.filter((r) => /\/web-lazy\/chunks\//.test(r.n)).length,
        externalRequests: ext.map((r) => ({ n: r.n.slice(0, 140), b: r.b })),
    };
}

(async () => {
    const o = parseArgs(process.argv.slice(2));
    const results = [];
    for (let i = 0; i < o.runs; i++) {
        const child = await startServer(o);
        try {
            const url = 'http://127.0.0.1:' + o.port + '/web/aiweb/';
            const dom = await runChrome(o, url);
            const m = dom.match(/<pre id="faprobe">([\s\S]*?)<\/pre>/);
            if (!m) { console.log('第 ' + (i + 1) + ' 次：沒有取得探針結果（頁面可能沒載入或超過虛擬時間上限）'); results.push({ error: 'no-probe' }); continue; }
            const p = JSON.parse(unescapeHtml(m[1]));
            // 牆鐘時間（伺服器記下的真實毫秒數）：virtual time 下頁面內的 performance.now() 不是真實時間，就緒時間以這裡為準
            try {
                const L = await getJson('http://127.0.0.1:' + o.port + '/__measure/log');
                const r = (L.events || []).find((e) => e.ev === 'ready');
                p.wallReadyMs = r ? r.wallMs : null;
                p.htmlCount = L.htmlCount || 0;
                p.wallEvents = L.events || [];
            } catch (_) { p.wallReadyMs = null; }
            if (p.timeout) { console.log('第 ' + (i + 1) + ' 次：助理未就緒（逾時）'); results.push({ error: 'timeout' }); continue; }
            const s = summarize(p);
            results.push(s);
            console.log('第 ' + (i + 1) + ' 次：就緒（牆鐘）' + s.wallReadyMs + ' 毫秒｜資源 ' + s.resourceCount + '（外部 ' + s.externalCount + '）｜就緒前開始的請求 ' + s.requestsStartedBeforeReady + ' 個｜同步分塊載入 ' + s.syncChunkLoads + ' 次｜分塊請求 ' + s.chunkRequests + ' 個｜外部來源 ' + JSON.stringify(s.hosts));
        } finally {
            child.kill();
        }
    }
    if (o.out) fs.writeFileSync(o.out, JSON.stringify({ options: o, when: new Date().toISOString(), results }, null, 1));
})().catch((e) => { console.error('量測失敗：' + (e && e.message ? e.message : e)); process.exit(1); });
