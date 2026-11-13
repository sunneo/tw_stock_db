// 擴充點（DESIGN.extension-points.md）在產品視窗（真 Electron，xvfb）的實測啟動器：獨立使用者資料夾（乾淨）、不改產品程式。
// 用法：xvfb-run -a nice -n 19 node scripts/eval/ext_points.run.js [--minutes=5] [--out=<結果 JSON>]
// 注意：工具抓網頁走產品自己的 CORS 代理（/proxy/，需要設定好的 AI 端點）；代理不通時如實記錄，不改走其他路線。
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const minutes = +arg('minutes', '5'), outFile = arg('out', path.join(os.tmpdir(), 'ext_points.result.txt'));
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-ext-ud-'));
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8')); if (rev) fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev[1]);
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const evalFile = path.join(ud, 'ext_points.eval.js'); fs.writeFileSync(evalFile, fs.readFileSync(path.join(__dirname, 'ext_points.eval.js'), 'utf8'));
const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: '18998' });
const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; const feed = (d) => { out += d; if (/\[eval-file\] ext/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500); };
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, minutes * 60000);
p.on('exit', () => {
    clearTimeout(t);
    const lines = out.split('\n').filter((l) => /\[eval-file\]|\[main-ext\]|Error|error/.test(l));
    fs.writeFileSync(outFile, lines.join('\n'));
    console.log(lines.join('\n').slice(0, 30000) || out.slice(-3000));
    try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ }
    process.exit(0);
});
