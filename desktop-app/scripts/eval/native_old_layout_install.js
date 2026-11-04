// 舊安裝版面模擬：舊安裝的檔案＝git 的 96292810（不是目前倉庫）；再把「這次發布要覆蓋的檔案」只依照舊安裝的 update-manifest 比對出來的變更清單，
// 用 live-patch 的 state.json 覆蓋進去（和真實熱更新寫入的格式相同），不放倉庫其他檔案。然後在真 Electron 裡走「按安裝」按鈕的同一個函式。
// 模式：npm（npm 來源可用）或 blocked（npm 來源失敗，切到 GitHub 分支）。兩者都用本機檔案當假來源，不碰網路。
// 用法：node scripts/eval/native_old_layout_install.js <輸出資料夾> <npm|blocked> <onnxruntime-node-1.22.0.tgz> <分割包資料夾>
'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const APP = path.join(__dirname, '..', '..');                  // 倉庫裡的 desktop-app（新版）
const OUT = path.resolve(process.argv[2] || '');
const MODE = process.argv[3] || 'npm';
const TGZ = path.resolve(process.argv[4] || '');
const GH = path.resolve(process.argv[5] || '');
const OLD_COMMIT = '96292810';
if (!OUT || !['npm', 'blocked'].includes(MODE) || !TGZ || !GH) { console.error('用法：node scripts/eval/native_old_layout_install.js <輸出資料夾> <npm|blocked> <tgz> <分割包資料夾>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const log = (s) => console.log(new Date().toISOString() + ' [' + MODE + '] ' + s);
const md5 = (p) => crypto.createHash('md5').update(fs.readFileSync(p)).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = path.join(APP, '..');                              // 工作目錄根（git 倉庫根）

(async () => {
    // 1. 舊安裝版面：git worktree 開 96292810，只有那個 commit 有的檔案
    const old = path.join(OUT, 'old-layout-' + MODE);
    cp.execFileSync('git', ['-C', REPO, 'worktree', 'add', '--detach', old, OLD_COMMIT], { stdio: 'ignore' });
    const oldApp = path.join(old, 'desktop-app');
    // 接上 node_modules（Node 直接建立 junction，不經過 cmd，避免中文路徑在 cmd 裡出錯）
    fs.symlinkSync(path.join(APP, 'node_modules'), path.join(oldApp, 'node_modules'), 'junction');
    if (!fs.existsSync(path.join(oldApp, 'node_modules', 'electron', 'dist', 'electron.exe'))) throw new Error('node_modules 連結失敗');
    const oldManifest = JSON.parse(fs.readFileSync(path.join(oldApp, 'renderer', 'update-manifest.json'), 'utf8'));
    const newManifest = JSON.parse(fs.readFileSync(path.join(APP, 'renderer', 'update-manifest.json'), 'utf8'));
    // 2. 只覆蓋清單上 md5 有變的檔案（和熱更新的「依清單」相同）
    const changed = Object.keys(newManifest.files).filter((k) => oldManifest.files[k] !== newManifest.files[k]);
    const ud = path.join(OUT, 'ud-' + MODE);
    fs.rmSync(ud, { recursive: true, force: true });
    const lp = path.join(ud, 'live-patch');
    const state = { baselineVersion: oldManifest.baseVersion || '1.1.0', files: {} };
    // 頁面是從 live-patch/renderer 載入的：先把舊安裝的整個 renderer 目錄（安裝包內本來就有的）放進去，再覆蓋清單上變更的檔案
    fs.cpSync(path.join(oldApp, 'renderer'), path.join(lp, 'renderer'), { recursive: true });
    for (const rel of changed) {
        const src = path.join(APP, ...rel.split('/'));
        const dst = path.join(lp, ...rel.split('/'));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        state.files[rel] = md5(src);
        if (state.files[rel] !== newManifest.files[rel]) throw new Error('清單 md5 與檔案不符：' + rel);
    }
    fs.writeFileSync(path.join(lp, 'state.json'), JSON.stringify(state, null, 2));
    fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), '2026-10-26-vendor');
    log('覆蓋清單（依 update-manifest）：' + changed.join('、'));

    // 3. 真 Electron：舊版面＋覆蓋，按安裝（同一個函式），一題真推論，移除
    const exe = path.join(APP, 'node_modules', 'electron', 'dist', 'electron.exe');
    const evalFile = path.join(APP, 'scripts', 'eval', 'native_old_layout_install.eval.js');
    const env = Object.assign({}, process.env, {
        FA_DEBUG_EVAL_FILE: evalFile, FA_BROWSER_CONTROL_PORT: MODE === 'npm' ? '17963' : '17964',
        FA_NATIVE_INSTALL_NPM_FILE: MODE === 'npm' ? TGZ : path.join(OUT, 'no-such-npm.tgz'),
        FA_NATIVE_INSTALL_GH_DIR: GH,
        FA_NATIVE_MODEL_PATH: 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\ort-node-test\\models\\qwen3-0.6b-cpu.onnx',
        FA_NATIVE_TOKENIZER_PATH: 'C:\\Users\\sunneo\\AppData\\Local\\Temp\\ort-node-test\\tok\\tokenizer.json',
    });
    delete env.FA_DISABLE_MAIN_OVERLAY;
    delete env.FA_NATIVE_INSTALL_NPM_URL; delete env.FA_NATIVE_INSTALL_GH_BASE;
    const r = cp.spawnSync(exe, [oldApp, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, encoding: 'utf8', timeout: 1500000, maxBuffer: 1 << 26 });
    const out = String(r.stdout || '') + String(r.stderr || '');
    fs.writeFileSync(path.join(OUT, 'electron-' + MODE + '.txt'), out);
    const evalLine = out.split('\n').filter((l) => /\[eval-file\]/.test(l)).join('\n');
    let mainLog = ''; try { mainLog = fs.readFileSync(path.join(ud, 'logs', 'main-ext.log'), 'utf8'); } catch (_) { /* 沒有日誌 */ }
    const result = {
        mode: MODE,
        overlaidFiles: changed,
        mainOverlayUsed: /主行程模組使用覆蓋版本/.test(out) || /主行程模組覆蓋/.test(mainLog),
        requireErrorSeen: /Cannot find module/.test(mainLog + out),
        switchToGithub: /切換到來源 2/.test(mainLog),
        npmSucceeded: /npm 成功/.test(mainLog),
        evalResult: evalLine,
        exitCode: r.status,
    };
    fs.writeFileSync(path.join(OUT, 'result-' + MODE + '.json'), JSON.stringify(result, null, 2));
    log('結果：' + JSON.stringify({ pass: /"pass":true/.test(evalLine), overlay: result.mainOverlayUsed, requireError: result.requireErrorSeen, npmSucceeded: result.npmSucceeded, switchToGithub: result.switchToGithub }));

    // 4. 清理：先拆 junction（rmdir 不會刪目標內容），再移除 worktree
    try { fs.rmdirSync(path.join(oldApp, 'node_modules')); } catch (_) { /* junction 只移除連結，不會刪除目標 */ }
    try { cp.execFileSync('git', ['-C', REPO, 'worktree', 'remove', '--force', old], { stdio: 'ignore' }); } catch (_) { /* */ }
    process.exit(/"pass":true/.test(evalLine) && !result.requireErrorSeen ? 0 : 1);
})().catch((e) => { log('錯誤：' + String((e && e.stack) || e)); process.exit(1); });
