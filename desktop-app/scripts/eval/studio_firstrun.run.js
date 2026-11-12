// 啟動真的 Electron（xvfb）跑探測腳本；探測印 "[shot] 名稱" 時，用 import 截整個螢幕到 FA_SHOT_DIR（預設暫存資料夾）。
// 用法：xvfb-run -a nice -n 19 node scripts/eval/studio_firstrun.run.js [埠]
// 環境變數：FA_EVAL=探測名（預設 studio_firstrun，即 scripts/eval/<名>.eval.js）；FA_TPL=1 注入工作目錄未嵌入的 studio-viewer 樣板；FA_THEME=light|dark 指定探測框的主題；FA_HOWTO=1 注入工作目錄未嵌入的 studio_howto_deck.js；FA_MT=1 注入模型類型登錄表；FA_HALF=1|0 設定「顯示半成品」開關。
const { spawn, execFileSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', 'electron');
const OUT = process.env.FA_SHOT_DIR || path.join(os.tmpdir(), 'fa-firstrun-shots'); fs.mkdirSync(OUT, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-firstrun-ud-'));
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const evalSrc = path.join(__dirname, (process.env.FA_EVAL || 'studio_firstrun') + '.eval.js');
let evalFile = evalSrc; let pre = '';
if (process.env.FA_TPL === '1') pre += 'globalThis.__FA_TPL = ' + JSON.stringify(fs.readFileSync(path.join(app, 'renderer', 'src', 'studio', 'studio-viewer.template.html'), 'utf8')) + ';\n';
if (process.env.FA_HOWTO === '1') pre += 'globalThis.__FA_HOWTO_SRC = ' + JSON.stringify(fs.readFileSync(path.join(app, 'renderer', 'src', 'studio', 'studio_howto_deck.js'), 'utf8')) + ';\n';
// FA_INJECT=模組,模組：把工作目錄未嵌入的 studio 模組注入（探測用；UMD 會設定 window.FaStudio<名稱>）
if (process.env.FA_INJECT) pre += 'globalThis.__FA_INJECT = ' + JSON.stringify(process.env.FA_INJECT.split(',').filter(Boolean).map((n) => ({ name: n, src: fs.readFileSync(path.join(app, 'renderer', 'src', 'studio', n + '.js'), 'utf8') }))) + ';\n';
if (process.env.FA_MT === '1') pre += 'globalThis.__FA_MT_SRC = ' + JSON.stringify(fs.readFileSync(path.join(app, 'renderer', 'src', 'studio', 'model_types_core.js'), 'utf8')) + ';\n';
if (process.env.FA_HALF) pre += 'globalThis.__FA_HALF = ' + JSON.stringify(process.env.FA_HALF === '1') + ';\n';
if (process.env.FA_THEME) pre += 'globalThis.__FA_THEME = ' + JSON.stringify(process.env.FA_THEME) + ';\n';
if (pre) { evalFile = path.join(OUT, 'eval-combined.js'); fs.writeFileSync(evalFile, pre + fs.readFileSync(evalSrc, 'utf8')); }
const env = Object.assign({}, process.env, { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: process.argv[2] || '17991', ELECTRON_ENABLE_LOGGING: '1' });
const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; let shotsDone = 0;
const feed = (d) => {
    const s = String(d); out += s;
    for (const m of s.matchAll(/\[shot\] ([\w-]+)/g)) { try { execFileSync('import', ['-window', 'root', path.join(OUT, m[1] + '.png')]); shotsDone++; } catch (e) { console.log('截圖失敗 ' + m[1] + ': ' + e.message); } }
    if (/\[eval-file\] (result|error)/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500);
};
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, 400000);
p.on('exit', () => {
    clearTimeout(t);
    const m = out.split('\n').filter((l) => /\[eval-file\]/.test(l)).join('\n');
    console.log('截圖 ' + shotsDone + ' 張 → ' + OUT);
    console.log(m.slice(0, 80000) || out.slice(-3000));
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ }
    process.exit(0);
});
