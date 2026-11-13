// 內建 LoRA 端到端探針（DESIGN.lora-training.md §33 批 3）：真 Electron（xvfb）、乾淨 userData（只帶標準版模型）、不連網。
// 內建清單與六顆 .fatrain 由本機 http 伺服器提供（暫存目錄 --assets 裡的分片，清單的 base_url 改成本機）；主行程用環境變數 FA_BUILTIN_MANIFEST_URL 指過來。
// 用法：xvfb-run -a nice -n 19 node scripts/eval/builtin_lora_probe.run.js --runtime=<執行包資料夾> --assets=<lora-adapters 暫存目錄，含 builtin.json> [--src-userdata=<有 native-models 的 userData>] [--minutes=40] [--out=<結果 JSON>]
const cp = require('child_process'), { spawn } = cp, fs = require('fs'), os = require('os'), path = require('path'), http = require('http');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const runtime = arg('runtime'), assets = arg('assets'), minutes = +arg('minutes', '40');
const srcUd = arg('src-userdata', path.join(os.homedir(), '.config', 'floating-assistant-desktop')), outFile = arg('out', path.join(os.tmpdir(), 'builtin_lora_probe.result.json'));
if (!runtime || !assets) { console.log('用法見檔頭'); process.exit(1); }
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-builtin-ud-'));
fs.cpSync(path.join(srcUd, 'native-models'), path.join(ud, 'native-models'), { recursive: true }); // 只帶標準版模型：沒有任何 LoRA、沒有匯入過的資產（乾淨）
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8')); if (rev) fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev[1]);
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
// 本機伺服器：清單的 base_url 改成本機；分片原樣提供
const m = JSON.parse(fs.readFileSync(path.join(assets, 'builtin.json'), 'utf8'));
const srv = http.createServer((q, r) => {
  const p = decodeURIComponent(q.url.split('?')[0]);
  if (p === '/builtin.json') { const b = Buffer.from(JSON.stringify(Object.assign({}, m, { base_url: 'http://127.0.0.1:' + srv.address().port + '/' }))); r.writeHead(200, { 'content-length': b.length }); return r.end(b); }
  const f = path.join(assets, p); if (!fs.existsSync(f) || fs.statSync(f).isDirectory()) { r.writeHead(404); return r.end(); }
  const b = fs.readFileSync(f); r.writeHead(200, { 'content-length': b.length }); r.end(b);
});
srv.listen(0, '127.0.0.1', () => {
  const evalFile = path.join(ud, 'builtin_lora_probe.eval.js');
  fs.writeFileSync(evalFile, fs.readFileSync(path.join(__dirname, 'builtin_lora_probe.eval.js'), 'utf8'));
  const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: '18997', FA_NATIVE_RUNTIME_LOCAL_SRC: runtime, FA_BUILTIN_MANIFEST_URL: 'http://127.0.0.1:' + srv.address().port + '/builtin.json' });
  delete env.FA_NATIVE_MODEL_PATH; delete env.FA_NATIVE_TOKENIZER_PATH;
  const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; const feed = (d) => { out += d; if (/\[eval-file\] (builtin|error)/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500); };
  p.stdout.on('data', feed); p.stderr.on('data', feed);
  const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, minutes * 60000);
  p.on('exit', () => {
    clearTimeout(t); srv.close();
    const lines = out.split('\n').filter((l) => /\[eval-file\]|\[main-ext\]|\[runner\]/.test(l)); fs.writeFileSync(outFile, lines.join('\n'));
    console.log(lines.join('\n').slice(0, 30000) || out.slice(-3000)); try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ } process.exit(0);
  });
});
