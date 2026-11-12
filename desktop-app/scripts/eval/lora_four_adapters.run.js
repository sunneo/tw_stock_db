// 四顆 LoRA 在「產品視窗」（真 Electron，xvfb）的實測啟動器：獨立使用者資料夾、不連網、不改產品程式。
// 做法：建一個隔離的 userData，放入（複製）本機已有的標準版 q8 模型（LoRA 槽版由產品的 slot_prepare 轉換），並以 FA_NATIVE_RUNTIME_LOCAL_SRC 從本機資料夾安裝 1.22.0-2 執行包
//   （用 scripts/native-runtime-pack.js 由本機已有的 onnxruntime-node 1.22.0 重新打包，沒有下載）。
// 用法：xvfb-run -a nice -n 19 node scripts/eval/lora_four_adapters.run.js --runtime=<執行包資料夾> --assets=<.fatrain 資料夾> [--src-userdata=<有 native-models／native-lora 的 userData>] [--minutes=40] [--out=<結果 JSON>]
const cp = require('child_process'), { spawn } = cp, fs = require('fs'), os = require('os'), path = require('path');
const arg = (k, d) => { const a = process.argv.find((x) => x.startsWith('--' + k + '=')); return a ? a.slice(k.length + 3) : d; };
const runtime = arg('runtime'), assets = arg('assets', path.join(os.homedir(), 'fa-adapters-int', 'assets')), minutes = +arg('minutes', '40');
const srcUd = arg('src-userdata', path.join(os.homedir(), '.config', 'floating-assistant-desktop')), outFile = arg('out', path.join(os.tmpdir(), 'lora_four_adapters.result.json'));
if (!runtime) { console.log('用法見檔頭'); process.exit(1); }
const app = path.join(__dirname, '..', '..'); const exe = path.join(app, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron');
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-lora4-ud-'));
// 只複製標準版模型；LoRA 槽版由評估腳本走產品自己的 slot_prepare 轉換（快取鍵含路徑與時間，複製過來的舊快取不會被認得，所以不複製）
for (const d of ['native-models']) fs.cpSync(path.join(srcUd, d), path.join(ud, d), { recursive: true });
const rev = /const REV = "([^"]+)"/.exec(fs.readFileSync(path.join(app, 'main-ext.js'), 'utf8')); if (rev) fs.writeFileSync(path.join(ud, 'main-ext-rev.txt'), rev[1]);
fs.writeFileSync(path.join(ud, 'desktop-settings.json'), '{"execEnabled":true,"execConfirmRequired":false}');
const items = fs.readFileSync(path.join(__dirname, 'lora_four_adapters.items.json'), 'utf8');
const src = fs.readFileSync(arg('eval', path.join(__dirname, 'lora_four_adapters.eval.js')), 'utf8').replace('__ITEMS__', () => items).replace('__ASSET_DIR__', () => JSON.stringify(assets));
const evalFile = path.join(ud, 'lora_four_adapters.eval.js'); fs.writeFileSync(evalFile, src);
const env = Object.assign({}, process.env, { FA_DEBUG_EVAL_FILE: evalFile, FA_DISABLE_MAIN_OVERLAY: '1', FA_BROWSER_CONTROL_PORT: '18996', FA_NATIVE_RUNTIME_LOCAL_SRC: runtime });
delete env.FA_NATIVE_MODEL_PATH; delete env.FA_NATIVE_TOKENIZER_PATH;
const p = spawn(exe, [app, '--no-sandbox', '--disable-gpu', '--user-data-dir=' + ud], { env, stdio: ['ignore', 'pipe', 'pipe'] });
// --restore-slot=1：繞過產品的一個缺陷（main-ext.js 的 lora_apply／lora_clear 會把 native-lora 底下不在保留清單的項目全刪，連同 native-lora/slot-model 這個
// 已轉換好的槽版模型一起刪掉，之後帶 LoRA 的生成因找不到 layout.json 而 load_failed）。這裡由「啟動器」（不是產品）在槽版目錄消失時，用硬連結備份即時還原。
// 預設關閉＝量產品原樣的行為；開啟＝量「槽版不被誤刪」時 adapter 實際有沒有效。
let restored = 0, wd = null;
if (arg('restore-slot', '0') === '1') {
  const live = path.join(ud, 'native-lora', 'slot-model'), bak = path.join(ud, 'slot-backup');
  wd = setInterval(() => {
    try {
      const built = fs.existsSync(live) && fs.existsSync(path.join(live, '_hashes.json')) && fs.readdirSync(live).some((n) => fs.existsSync(path.join(live, n, '.ok')) && fs.existsSync(path.join(live, n, 'layout.json')));
      if (!fs.existsSync(bak) && built) cp.execFileSync('cp', ['-al', live, bak]);
      else if (fs.existsSync(bak) && !fs.existsSync(live)) { fs.mkdirSync(path.dirname(live), { recursive: true }); cp.execFileSync('cp', ['-al', bak, live]); restored++; }
    } catch (_) { /* 下一輪再試 */ }
  }, 20);
}
let out = ''; const feed = (d) => { out += d; if (/\[eval-file\] (result|error)/.test(out) && !p.killed) setTimeout(() => { try { p.kill(); } catch (_) { /* */ } }, 1500); };
p.stdout.on('data', feed); p.stderr.on('data', feed);
const t = setTimeout(() => { try { p.kill(); } catch (_) { /* */ } console.log('逾時'); }, minutes * 60000);
p.on('exit', () => {
  clearTimeout(t); if (wd) clearInterval(wd); out += '\n[runner] 槽版還原次數：' + restored; const m = out.split('\n').filter((l) => /\[eval-file\]|\[main-ext\]|\[runner\]/.test(l)); fs.writeFileSync(outFile, m.join('\n'));
  console.log(m.join('\n').slice(0, 30000) || out.slice(-3000)); try { fs.rmSync(ud, { recursive: true, force: true }); } catch (_) { /* */ } process.exit(0);
});
