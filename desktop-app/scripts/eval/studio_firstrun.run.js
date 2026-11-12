// 啟動真的 Electron（xvfb）跑 scripts/eval/studio_firstrun.eval.js；eval 印 "[shot] 名稱" 時，用 import 截整個螢幕到 FA_SHOT_DIR（預設 scratchpad）。
// 用法：xvfb-run -a nice -n 19 node scripts/eval/studio_firstrun.run.js [埠]
const { spawn, execFileSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', 'electron');
const OUT = process.env.FA_SHOT_DIR || path.join(os.tmpdir(), 'fa-firstrun-shots'); fs.mkdirSync(OUT, { recursive: true });
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-firstrun-ud-'));
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
// FA_TPL=1：把工作目錄裡的 studio-viewer 樣板（未經嵌入）注入探測用的 globalThis.__FA_TPL，讓未嵌入的修正也能在真畫面上驗證
let evalFile = path.join(__dirname, 'studio_firstrun.eval.js');
if (process.env.FA_TPL === '1') {
    const tpl = fs.readFileSync(path.join(app, 'renderer', 'src', 'studio', 'studio-viewer.template.html'), 'utf8');
    evalFile = path.join(OUT, 'eval-combined.js');
    fs.writeFileSync(evalFile, 'globalThis.__FA_TPL = ' + JSON.stringify(tpl) + ';\n' + fs.readFileSync(path.join(__dirname, 'studio_firstrun.eval.js'), 'utf8'));
}
const env = Object.assign({}, process.env, { HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: process.argv[2] || '17991', ELECTRON_ENABLE_LOGGING: '1' });
const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; let shotsDone = 0;
const feed = (d) => {
    const s = String(d); out += s;
    for (const m of s.matchAll(/\[shot\] ([\w-]+)/g)) { try { execFileSync('import', ['-window', 'root', path.join(OUT, m[1] + '.png')]); shotsDone++; } catch (e) { console.log('截圖失敗 ' + m[1] + ': ' + e.message); } }
    if (/\[eval-file\] (result|error)/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500);
};
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, 240000);
p.on('exit', () => {
    clearTimeout(t);
    const m = out.split('\n').filter((l) => /\[eval-file\]/.test(l)).join('\n');
    console.log('截圖 ' + shotsDone + ' 張 → ' + OUT);
    console.log(m.slice(0, 60000) || out.slice(-3000));
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ }
    process.exit(0);
});
