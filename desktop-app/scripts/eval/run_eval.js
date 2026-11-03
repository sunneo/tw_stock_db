// 用法：node scripts/eval/run_eval.js <評估檔> [埠，預設 17931]
// 真 Electron 跑評估檔：全新暫存使用者資料夾、換埠、FA_DISABLE_MAIN_OVERLAY=1（渲染頁用工作目錄的實作，不套用遠端版本）。
// 另外預先寫入 main-ext-rev.txt（內容讀自 main-ext.js 的 REV）：全新資料夾第一次啟動時 main-ext.js 會把 autoPrompt 設為真，
// 畫面就自動跳出「發現新版本」對話框，按「立即更新」會把遠端版本蓋過工作目錄；預先寫入後第一次啟動也不會跳。
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const root = path.join(__dirname, '..', '..');
const evalFile = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !fs.existsSync(evalFile)) { console.error('usage: node scripts/eval/run_eval.js <eval file> [port]'); process.exit(2); }
const m = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(root, 'main-ext.js'), 'utf8'));
if (!m) { console.error('找不到 main-ext.js 的 REV'); process.exit(2); }
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-eval-'));
fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), m[1]);
const exe = path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const env = Object.assign({}, process.env, { FA_DISABLE_MAIN_OVERLAY: '1', FA_DEBUG_EVAL_FILE: evalFile, FA_BROWSER_CONTROL_PORT: String(process.argv[3] || 17931) });
const r = cp.spawnSync(exe, [root, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, encoding: 'utf8', timeout: 170000, maxBuffer: 1 << 26 });
const out = String(r.stdout || '') + String(r.stderr || '');
out.split('\n').filter((l) => /\[eval-file\]/.test(l)).forEach((l) => console.log(l));
