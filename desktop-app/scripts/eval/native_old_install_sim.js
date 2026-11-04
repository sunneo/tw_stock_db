// 舊版安裝模擬驅動：真 Electron 啟動舊安裝（96292810），userData 用獨立資料夾。
// 用法：node item1-drive.js <舊安裝 desktop-app 路徑> <userData 路徑> [control]
// control＝不放 live-patch（對照組：舊安裝沒有信箱，應該沒有 ready.json）
const fs = require('fs'), path = require('path'), cp = require('child_process');
const appDir = process.argv[2], ud = process.argv[3], control = process.argv[4] === 'control';
const exe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const box = path.join(ud, 'native-runner-box');
if (control) { try { fs.unlinkSync(path.join(ud, 'live-patch', 'main-ext.js')); } catch (_) {} }
try { fs.rmSync(box, { recursive: true, force: true }); } catch (_) {}
const env = Object.assign({}, process.env, { FA_BROWSER_CONTROL_PORT: '17941' });
delete env.FA_DISABLE_MAIN_OVERLAY;
const child = cp.spawn(exe, [appDir, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, windowsHide: true, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const t0 = Date.now(); let ready = null;
  while (Date.now() - t0 < 90000) { try { ready = JSON.parse(fs.readFileSync(path.join(box, 'ready.json'), 'utf8')); break; } catch (_) {} await sleep(100); }
  const result = { control, readyFound: !!ready, readyMs: Date.now() - t0 };
  if (ready) {
    fs.writeFileSync(path.join(box, 'req-probe1.json'), JSON.stringify({ op: 'status' }));
    const t1 = Date.now(); let resp = null;
    while (Date.now() - t1 < 15000) { try { resp = JSON.parse(fs.readFileSync(path.join(box, 'resp-probe1.json'), 'utf8')); break; } catch (_) {} await sleep(50); }
    result.statusMs = Date.now() - t1; result.statusResp = resp;
    fs.writeFileSync(path.join(box, 'req-probe2.json'), JSON.stringify({ op: 'run', payload: {} }));
    const t2 = Date.now(); let r2 = null;
    while (Date.now() - t2 < 15000) { try { r2 = JSON.parse(fs.readFileSync(path.join(box, 'resp-probe2.json'), 'utf8')); break; } catch (_) {} await sleep(50); }
    result.runResp = r2;
  }
  try { result.logTail = fs.readFileSync(path.join(ud, 'logs', 'main-ext.log'), 'utf8').split('\n').filter((l) => /live-patch|main-ext/.test(l)).slice(-8); } catch (_) { result.logTail = 'no log'; }
  cp.spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
  console.log('[item1] ' + JSON.stringify(result));
  process.exit(0);
})();
