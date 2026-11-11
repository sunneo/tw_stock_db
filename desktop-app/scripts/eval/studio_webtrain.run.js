// 工作室「網頁版頁內訓練」的真 Electron 驗證執行器（獨立使用者資料夾、換埠、停用 live-patch 覆蓋）。
// 為什麼不用 real_electron.run.js：這個驗證要 20～40 分鐘（載入 617MB 模型、建 57 張層圖、跑數步），那支的逾時是 4 分鐘。
// 另外啟動一個只綁 127.0.0.1 的本機伺服器，把「已在本機的」模型與分詞器檔案餵給頁面（沒有任何下載）：
//   /model.onnx                                    ← --model（Qwen3-0.6B q8 ONNX）
//   /onnx-community/Qwen3-0.6B-ONNX/resolve/main/<檔> ← --tok 資料夾（tokenizer.json／tokenizer_config.json／config.json…）
// 用法：node scripts/qrun.js --timeout 3000 -- node scripts/eval/studio_webtrain.run.js --model=<model_quantized.onnx> --tok=<分詞器資料夾> [--port=18990] [--minutes=45]
const { spawn } = require('child_process'), fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const model = arg('model'), tok = arg('tok'), port = +arg('port', '18990'), minutes = +arg('minutes', '45');
if (!model || !tok) { console.log('用法見檔頭'); process.exit(1); }
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-wt-ud-'));
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8')); if (rev) fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev[1]);
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const srv = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]); let f = null;
  if (u === '/model.onnx') f = model; else if (u.indexOf('/onnx-community/Qwen3-0.6B-ONNX/resolve/main/') === 0) f = path.join(tok, path.basename(u));
  if (!f || !fs.existsSync(f)) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
  res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': fs.statSync(f).size, 'Access-Control-Allow-Origin': '*' }); fs.createReadStream(f).pipe(res);
});
srv.listen(port, '127.0.0.1', () => {
  const evalSrc = fs.readFileSync(path.join(__dirname, 'studio_webtrain.eval.js'), 'utf8').replace(/__PORT__/g, String(port)); const evalFile = path.join(ud, 'studio_webtrain.eval.js'); fs.writeFileSync(evalFile, evalSrc);
  const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: String(port + 1) });
  const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; const feed = (d) => { out += d; if (/\[eval-file\] (result|error)/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500); };
  p.stdout.on('data', feed); p.stderr.on('data', feed);
  const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, minutes * 60000);
  p.on('exit', () => { clearTimeout(t); srv.close(); const m = out.split('\n').filter((l) => /\[eval-file\]/.test(l)); console.log(m.join('\n').slice(0, 20000) || out.slice(-3000)); try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ } process.exit(0); });
});
