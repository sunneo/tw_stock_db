// 執行包真下載評估（真 Electron，全新 userData，每個情境一個）。
//   情境 A：npm 官方庫（正式網址）→ 驗 integrity → 抽取 → 分割包補 common／子程序程式（來源 2）。
//   情境 B：npm 網址封鎖（故意用不可達的網址）→ 切到 GitHub 分支（釘住 commit SHA）真下載。
// 兩個情境完成後，比對安裝出來的每個檔案 sha256 是否相同，並與清單 md5 核對。結果寫進結果檔，逐步進度寫進進度記錄檔。
//
// 用法（真下載，由管理層執行）：
//   node scripts/eval/native_real_install_eval.js <輸出資料夾>
// 用法（本機假來源，驗證腳本本身，不碰網路）：
//   node scripts/eval/native_real_install_eval.js <輸出資料夾> --local <onnxruntime-node-1.22.0.tgz> <分割包資料夾>
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const APP = path.join(__dirname, '..', '..');
const OUT = path.resolve(process.argv[2] || '');
const LOCAL = process.argv.indexOf('--local') >= 0;
const LOCAL_TGZ = LOCAL ? path.resolve(process.argv[process.argv.indexOf('--local') + 1]) : '';
const LOCAL_GH = LOCAL ? path.resolve(process.argv[process.argv.indexOf('--local') + 2]) : '';
const BLOCKED_URL = 'https://npm-blocked.invalid/onnxruntime-node/-/onnxruntime-node-1.22.0.tgz';
if (!process.argv[2]) { console.error('用法：node scripts/eval/native_real_install_eval.js <輸出資料夾> [--local <tgz> <分割包資料夾>]'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const progLog = path.join(OUT, 'progress.log');
const resultFile = path.join(OUT, 'results.json');
const logLine = (s) => { const t = new Date().toISOString(); fs.appendFileSync(progLog, t + ' ' + s + '\n'); console.log(t + ' ' + s); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

async function scenario(name, extraEnv) {
    const ud = path.join(OUT, 'ud-' + name);
    fs.rmSync(ud, { recursive: true, force: true }); fs.mkdirSync(ud, { recursive: true });
    fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), '2026-10-26-vendor');
    const box = path.join(ud, 'native-runner-box');
    const exe = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
    const env = Object.assign({}, process.env, { FA_BROWSER_CONTROL_PORT: name === 'npm' ? '17961' : '17962' }, extraEnv);
    delete env.FA_DISABLE_MAIN_OVERLAY;
    // 清掉殘留的測試覆寫，只保留這個情境明確指定的（避免別的測試的環境變數混進真下載）
    for (const k of ['FA_NATIVE_INSTALL_NPM_FILE', 'FA_NATIVE_INSTALL_GH_DIR', 'FA_NATIVE_INSTALL_NPM_URL', 'FA_NATIVE_INSTALL_GH_BASE']) if (!(k in extraEnv)) delete env[k];
    const t0 = Date.now();
    logLine('[' + name + '] 啟動真 Electron（全新 userData：' + ud + '）');
    const child = cp.spawn(exe, [APP, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, windowsHide: true, stdio: 'ignore' });
    const res = { name, ok: false };
    try {
        for (let i = 0; i < 300 && !fs.existsSync(path.join(box, 'ready.json')); i++) await sleep(300);
        if (!fs.existsSync(path.join(box, 'ready.json'))) throw new Error('主程序沒有就緒');
        logLine('[' + name + '] 送出安裝要求（信箱 install）');
        fs.writeFileSync(path.join(box, 'req-inst-' + name + '.json'), JSON.stringify({ op: 'install', payload: {} }));
        const seen = new Set(); const tInst = Date.now(); let resp = null;
        while (Date.now() - tInst < 1200000) {
            try { const p = JSON.parse(fs.readFileSync(path.join(box, 'install-progress.json'), 'utf8')); const k = p.stage + '|' + p.detail; if (!seen.has(k)) { seen.add(k); logLine('[' + name + '] 進度 ' + p.state + ' ' + p.stage + '：' + p.detail); } } catch (_) { /* 還沒有進度 */ }
            try { resp = JSON.parse(fs.readFileSync(path.join(box, 'resp-inst-' + name + '.json'), 'utf8')); break; } catch (_) { /* 還沒回應 */ }
            await sleep(500);
        }
        if (!resp) throw new Error('安裝逾時（20 分鐘）');
        fs.rmSync(path.join(box, 'resp-inst-' + name + '.json'), { force: true });
        res.install = { ok: resp.ok, npmUsed: resp.npmUsed, npmBytes: resp.npmBytes, githubBytes: resp.githubBytes, sourceCounts: resp.sourceCounts, message: resp.message || null, elapsedMs: Date.now() - tInst };
        logLine('[' + name + '] 安裝回應：' + JSON.stringify(res.install));
        if (!resp.ok) throw new Error('安裝失敗：' + (resp.message || resp.code));
        const runtimeDir = path.join(ud, 'native-runtime', '1.22.0-1');
        const inst = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'manifest.json'), 'utf8'));
        const files = {};
        for (const rel of Object.keys(inst.files)) {
            const p = path.join(runtimeDir, ...rel.split('/'));
            const buf = fs.readFileSync(p);
            files[rel] = { sha256: crypto.createHash('sha256').update(buf).digest('hex'), md5ok: md5(buf) === inst.files[rel].md5, size: buf.length };
        }
        res.files = files; res.fileCount = Object.keys(files).length;
        res.totalBytes = Object.values(files).reduce((s, f) => s + f.size, 0);
        res.allMd5Match = Object.values(files).every((f) => f.md5ok);
        const logTxt = fs.readFileSync(path.join(ud, 'logs', 'main-ext.log'), 'utf8');
        res.switchLog = logTxt.split('\n').filter((l) => /切換到來源 2|npm 成功|npm 連線失敗/.test(l)).map((l) => l.replace(/^.*log /, '')).slice(0, 4);
        res.ok = true;
    } catch (e) {
        res.error = String((e && e.message) || e);
        logLine('[' + name + '] 失敗：' + res.error);
    } finally {
        cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    }
    res.wallMs = Date.now() - t0;
    logLine('[' + name + '] 結束，總耗時 ' + res.wallMs + ' 毫秒，ok=' + res.ok);
    return res;
}

(async () => {
    fs.rmSync(progLog, { force: true });
    const env = LOCAL
        ? { A: { FA_NATIVE_INSTALL_NPM_FILE: LOCAL_TGZ, FA_NATIVE_INSTALL_GH_DIR: LOCAL_GH },
              B: { FA_NATIVE_INSTALL_NPM_FILE: path.join(OUT, 'no-such-npm.tgz'), FA_NATIVE_INSTALL_GH_DIR: LOCAL_GH } }
        : { A: {}, B: { FA_NATIVE_INSTALL_NPM_URL: BLOCKED_URL } };
    const A = await scenario('npm', env.A);
    const B = await scenario('blocked', env.B);
    const comparison = { bothOk: A.ok && B.ok, A_npmUsed: !!(A.install && A.install.npmUsed), B_npmUsed: !!(B.install && B.install.npmUsed), B_switched: B.switchLog.some((l) => /切換到來源 2/.test(l)) };
    if (A.ok && B.ok) {
        const keys = Object.keys(A.files);
        comparison.fileCount = keys.length;
        comparison.sha256Mismatches = keys.filter((k) => !B.files[k] || A.files[k].sha256 !== B.files[k].sha256);
        comparison.sha256SameAll = comparison.sha256Mismatches.length === 0 && keys.length === Object.keys(B.files).length;
        comparison.allMd5Match = A.allMd5Match && B.allMd5Match;
    }
    comparison.pass = !!(comparison.bothOk && comparison.A_npmUsed && !comparison.B_npmUsed && comparison.B_switched && comparison.sha256SameAll && comparison.allMd5Match);
    const out = { mode: LOCAL ? 'local-fake-sources' : 'real-network', scenarios: { npm: A, blocked_then_github: B }, comparison };
    fs.writeFileSync(resultFile, JSON.stringify(out, null, 2));
    logLine('結果：' + JSON.stringify({ pass: comparison.pass, npmBytes: A.install && A.install.npmBytes, githubBytes_blocked: B.install && B.install.githubBytes, wallMs_npm: A.wallMs, wallMs_blocked: B.wallMs, sha256SameAll: comparison.sha256SameAll }));
    process.exit(comparison.pass ? 0 : 1);
})().catch((e) => { logLine('評估腳本錯誤：' + String((e && e.stack) || e)); process.exit(1); });
