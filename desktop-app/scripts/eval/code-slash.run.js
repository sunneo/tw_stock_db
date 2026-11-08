// node scripts/eval/code-slash.run.js   啟動真的 Electron 跑 code-slash.eval.js（獨立使用者資料夾＋換埠＋停用覆蓋，不碰使用者的環境）
const { spawn } = require('child_process'); const fs = require('fs'); const os = require('os'); const path = require('path');
const app = path.join(__dirname, '..', '..'); const ELECTRON = path.join(app, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-code-slash-'));
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8'))[1]; fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev);
if (process.env.FA_EVAL_EXEC) fs.writeFileSync(path.join(ud, 'desktop-settings.json'), JSON.stringify({ execEnabled: true })); // 只寫進這次的暫存資料夾
const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: path.join(__dirname, (process.argv[2] || 'code-slash') + '.eval.js'), FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: '17987', ELECTRON_ENABLE_LOGGING: '1' });
const proc = spawn(ELECTRON, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' });
let out = ''; const on = (d) => { out += d; if (/\[eval-file\] (result|error)/.test(out)) finish(); }; proc.stdout.on('data', on); proc.stderr.on('data', on);
let done = false; function finish() { if (done) return; done = true; setTimeout(() => { console.log(out.split('\n').filter((l) => /\[eval-file\]/.test(l) || /^\s*[{}"\[\]]/.test(l)).join('\n').slice(0, 12000)); try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']); } catch (_) { /* */ } process.exit(0); }, 800); }
setTimeout(() => { console.log('逾時 120 秒\n' + out.slice(-3000)); try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F']); } catch (_) { /* */ } process.exit(1); }, 120000);
