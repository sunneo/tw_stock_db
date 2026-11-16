'use strict';
// 桌面版 lm_head 實機量測的執行器：啟動一次真 Electron（獨立暫存 --user-data-dir、換埠，不佔使用者的 17923），
// 跑 scripts/eval/cudaweb_head_desktop.eval.js，印出 [eval-file] 結果，然後只清理自己啟動、記下 PID 的行程。
// 不加 --disable-gpu（否則沒有 WebGPU）。執行包：用本機來源（FA_NATIVE_RUNTIME_LOCAL_SRC），只用於量測、不發布。
// 用法：node scripts/eval/cudaweb_head_desktop.run.js <本機執行包來源資料夾> [埠，預設 17991]
const { spawn, execFileSync } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const app = path.join(__dirname, '..', '..');
const exe = path.join(app, 'node_modules', 'electron', 'dist', 'electron.exe');
const src = process.argv[2];
const port = process.argv[3] || '17991';
if (!src) { console.log('用法：node scripts/eval/cudaweb_head_desktop.run.js <本機執行包來源資料夾> [埠]'); process.exit(1); }
const model = path.join(process.env.APPDATA, 'floating-assistant-desktop', 'native-models', 'qwen3-0.6b-q8');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-head-ud-'));
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const env = Object.assign({}, process.env, {
  HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', FA_DISABLE_MAIN_OVERLAY: '1', ELECTRON_ENABLE_LOGGING: '1',
  FA_DEBUG_EVAL_FILE: path.join(__dirname, 'cudaweb_head_desktop.eval.js'),
  FA_BROWSER_CONTROL_PORT: port,
  FA_NATIVE_RUNTIME_LOCAL_SRC: src,
  FA_NATIVE_MODEL_PATH: path.join(model, 'onnx', 'model_quantized.onnx'),
  FA_NATIVE_TOKENIZER_PATH: path.join(model, 'tokenizer.json'),
});
const p = spawn(exe, [app, '--no-sandbox', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
console.log('STARTED pid=' + p.pid + ' port=' + port + ' ud=' + ud);
let out = '';
const feed = (d) => { out += String(d); };
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => {
  console.log('TIMEOUT: 只清理自己的 pid ' + p.pid + '（含子行程）');
  try { execFileSync('taskkill', ['/PID', String(p.pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* 已結束 */ }
}, 900000);
p.on('exit', (code) => {
  clearTimeout(t);
  const lines = out.split('\n').filter((l) => /\[eval-file\]|\[main-ext\] 執行包|\[main-ext\] 原生|native-runtime|head/i.test(l));
  console.log('EXIT code=' + code);
  console.log(lines.slice(0, 40).join('\n').slice(0, 12000));
  try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* 還被佔用就留著 */ }
});
