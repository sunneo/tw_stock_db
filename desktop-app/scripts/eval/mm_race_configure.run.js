// node scripts/eval/mm_race_configure.run.js   真 Electron（真 GPU）跑 mm_race_configure.eval.js。
// 獨立的暫存使用者資料夾（不碰使用者安裝版的資料）、預先寫入 main-ext-rev.txt（避免自動跳更新對話框）、換埠（不佔 17923）、停用主行程覆蓋。
// 不加 --disable-gpu：那會關掉 WebGPU，競賽就只能退 CPU。
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const app = path.join(__dirname, '..', '..');
const ELECTRON = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-mm-race-cfg-'));
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8'))[1];
fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev);
const env = Object.assign({}, process.env, {
  FA_DEBUG_EVAL_FILE: path.join(__dirname, (process.argv[2] || 'mm_race_configure') + '.eval.js'),
  FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: '17990', ELECTRON_ENABLE_LOGGING: '1',
});
const proc = spawn(ELECTRON, [app, '--no-sandbox', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let out = ''; let done = false;
const kill = () => { try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']); } catch (_) { /* */ } };
function finish(code) { if (done) return; done = true; console.log(out.split('\n').filter((l) => /\[eval-file\]/.test(l)).join('\n').slice(0, 20000)); kill(); process.exit(code); }
const on = (d) => { out += d; if (/\[eval-file\] (result|error)/.test(out)) setTimeout(() => finish(0), 500); };
proc.stdout.on('data', on); proc.stderr.on('data', on);
setTimeout(() => { console.log('逾時 360 秒\n' + out.slice(-3000)); finish(1); }, 360000);
