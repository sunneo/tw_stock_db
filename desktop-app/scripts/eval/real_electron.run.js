// 啟動真的 Electron 跑 scripts/eval/<名稱>.eval.js（獨立暫存資料夾、換埠、停用 live-patch 覆蓋），印出 [eval-file] 結果。用法：node scripts/eval/real_electron.run.js <名稱> [埠]
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const name = process.argv[2]; if (!name) { console.log('用法：node scripts/eval/real_electron.run.js <名稱> [埠]'); process.exit(1); }
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-eval-ud-'));
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8')); if (rev) fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev[1]);
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: path.join(__dirname, name + '.eval.js'), FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: process.argv[3] || '17988', ELECTRON_ENABLE_LOGGING: '1' });
const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = ''; const feed = (d) => { out += d; if (/\[eval-file\] (result|error)/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500); };
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, 240000);
p.on('exit', () => { clearTimeout(t); const m = out.split('\n').filter((l) => /\[eval-file\]/.test(l)); console.log(m.join('\n').slice(0, 8000) || out.slice(-1500)); try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ } process.exit(0); });
