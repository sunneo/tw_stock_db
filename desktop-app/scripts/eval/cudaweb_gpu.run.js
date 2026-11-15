// cudaweb 真 WebGPU 檢查的啟動器（cudaweb_gpu.eval.js）。用法：node scripts/eval/cudaweb_gpu.run.js [--port=18931] [--minutes=3]
// 真 Electron，乾淨的 userData（全新暫存資料夾），換埠（不佔使用者的 17923 等連接埠），不加 --disable-gpu（否則測的不是真 WebGPU）。
// 會開視窗、搶焦點，所以只在需要時執行，每次執行前要先 node --check。
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const port = String(arg('port', '18931')), minutes = +arg('minutes', '3');
const app = path.join(__dirname, '..', '..');
const exe = path.join(app, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
if (!fs.existsSync(exe)) { console.log('找不到 Electron：' + exe); process.exit(1); }
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-cudaweb-ud-'));
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const evalFile = path.join(ud, 'cudaweb_gpu.eval.js');
// nn_ops.js 是 CJS 模組：包成函式，require('./gpu_core.js') 指向渲染程序裡已載入的 window.FaGpuCore，結果放進全域變數 NN
const nnSrc = fs.readFileSync(path.join(app, 'renderer', 'src', 'gpu', 'nn_ops.js'), 'utf8');
const evalSrc = fs.readFileSync(path.join(__dirname, 'cudaweb_gpu.eval.js'), 'utf8');
const shim = 'var NN; { var __nnModule = { exports: {} }; (function (module, exports, require) {\n' + nnSrc + '\n})(__nnModule, __nnModule.exports, function (p) { if (p === "./gpu_core.js") return window.FaGpuCore; throw new Error("nn_ops 不認得的模組：" + p); }); NN = __nnModule.exports; }\n';
if (!evalSrc.includes('/*__NN_MODULE__*/')) { console.log('評估檔缺少 NN 注入標記'); process.exit(1); }
fs.writeFileSync(evalFile, evalSrc.replace('/*__NN_MODULE__*/', shim));
// FA_UPDATE_BASE 指向不存在的位址：避免啟動時的自動更新對話框蓋住畫面（同 gui_shots.js 的做法）
const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: port, FA_UPDATE_BASE: 'http://127.0.0.1:9/' });
const p = spawn(exe, [app, '--no-sandbox', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
const feed = (d) => {
  out += d;
  if (/\[eval-file\] cudaweb /.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* 已結束 */ } }, 1000);
};
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => { try { p.kill(); } catch (_) { /* 已結束 */ } console.log('逾時'); }, minutes * 60000);
p.on('exit', () => {
  clearTimeout(t);
  const lines = out.split('\n').filter((l) => /\[eval-file\]|\[cudaweb\]|Error|error/.test(l));
  console.log(lines.join('\n').slice(0, 20000) || out.slice(-3000));
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* 暫存目錄清理失敗不影響結果 */ }
  process.exit(0);
});
