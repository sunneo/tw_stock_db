// 啟動隔離的真 Electron，跑 native_audio_e2e.eval.js（獨立 --user-data-dir、換埠，絕不用 17923；執行包從本機已安裝的複製，不下載）。
// 用法：node native_audio_e2e.js <工作資料夾> <模型資料夾> <electron.exe> <desktop-app 資料夾> <原生執行包資料夾（native-runtime/1.22.0-1）> <模型 id,逗號分隔>
// 結果寫在 <工作資料夾>/e2e-result.json。
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [, , WORK, MODELS, ELECTRON, APP, RUNTIME, IDS = 'basic-pitch,yamnet'] = process.argv;
if (!RUNTIME) { console.error('用法見檔頭'); process.exit(2); }
const fwd = (p) => p.replace(/\\/g, '/');
const OUT = fwd(path.join(WORK, 'e2e-result.json'));
fs.mkdirSync(WORK, { recursive: true });
const src = fs.readFileSync(path.join(__dirname, process.env.NAB_EVAL_FILE || 'native_audio_e2e.eval.js'), 'utf8').split('__MODELS__').join(fwd(MODELS)).split('__IDS__').join(IDS).split('__OUT__').join(OUT);
const evalFile = path.join(WORK, 'e2e.run.eval.js'); fs.writeFileSync(evalFile, src);
try { fs.unlinkSync(OUT); } catch (_) { /* 沒有就算了 */ }
const PORT = String(17990 + Math.floor(Math.random() * 9)); // 絕不用 17923
const env = Object.assign({}, process.env, { FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: PORT, FA_DEBUG_EVAL_FILE: evalFile, FA_NATIVE_RUNTIME_LOCAL_SRC: RUNTIME });
delete env.ELECTRON_RUN_AS_NODE;
const child = cp.spawn(ELECTRON, [APP, '--user-data-dir=' + path.join(WORK, 'userdata'), '--no-sandbox', '--disable-gpu'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const killer = setTimeout(() => { try { child.kill(); } catch (_) { /* 已結束 */ } }, +process.env.NAB_E2E_CAP_MS || 25 * 60 * 1000);
child.on('exit', (code) => { clearTimeout(killer); fs.writeFileSync(path.join(WORK, 'e2e-electron.log'), log.slice(-8000)); console.log('electron 結束', code, '埠', PORT); });
