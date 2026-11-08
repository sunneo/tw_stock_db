// 啟動真的 Electron 跑 code_patch.eval.js（獨立暫存資料夾、換埠、停用 live-patch 覆蓋），印出 [eval-file] 結果。用法：node scripts/eval/code_patch.run.js
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-codepatch-ud-'));
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8'));
if (rev) fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev[1]);
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: path.join(__dirname, 'code_patch.eval.js'), FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: '17987', ELECTRON_ENABLE_LOGGING: '1' });
const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; const feed = (d) => { out += d; if (/\[eval-file\] (result|error)/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500); };
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, 150000);
p.on('exit', () => { clearTimeout(t); const m = out.split('\n').filter((l) => /\[eval-file\]/.test(l)); console.log(m.join('\n').slice(0, 6000) || out.slice(-1500)); try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ } process.exit(0); });
