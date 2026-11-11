#!/usr/bin/env node
'use strict';
// 把「目前現況」打包成一個檔，傳到另一台機器接手。
// 用法（在 desktop-app 目錄）：
//   node scripts/handoff-pack.js [--out <輸出資料夾>] [--extra <路徑>]... [--with-models <資料夾>]...
// 輸出：<輸出資料夾>/fa-handoff-<時間>.tar，內含：
//   repo.bundle      整個倉庫（所有分支與標籤，含尚未推送的提交；對方用 git clone 還原）
//   extras/          倉庫外沒進版本控制、但接手需要的檔案（wiki/、.weak-harness/、progress.jsonl、test-reports/ 等）
//   models/          你用 --with-models 指定的模型資料夾（預設不含；很大，而且都能從來源重新下載）
//   RESTORE.md       對方照著做的還原步驟（含重建 Python 環境、重新下載模型的來源、大小）
//   MANIFEST.json    每個檔案的 sha256，對方可核對
// 不會打包：builtin-secrets*.json、.claude/settings.local.json、node_modules、dist、lora-train/.venv（這些要在對方機器重建）。
// 不彈視窗、不平行；所有子行程 windowsHide。建議用：node scripts/qrun.js --timeout 900 -- node <絕對路徑>\scripts\handoff-pack.js
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const cp = require('child_process');

const argv = process.argv.slice(2);
const getAll = (k) => { const r = []; for (let i = 0; i < argv.length; i++) if (argv[i] === k && argv[i + 1]) r.push(argv[++i]); return r; };
const get = (k, d) => { const r = getAll(k); return r.length ? r[r.length - 1] : d; };
const run = (cmd, args, opt) => cp.execFileSync(cmd, args, Object.assign({ windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, opt || {})).trim();
const sha256 = (f) => new Promise((res, rej) => { const h = crypto.createHash('sha256'); fs.createReadStream(f).on('data', (d) => h.update(d)).on('error', rej).on('end', () => res(h.digest('hex'))); });
const walk = (d, out) => { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); const st = fs.lstatSync(p); if (st.isDirectory()) walk(p, out); else if (st.isFile()) out.push(p); } return out; };
const human = (n) => (n > 1e9 ? (n / 1e9).toFixed(2) + ' GB' : n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : (n / 1e3).toFixed(0) + ' KB');
const SKIP = /(^|[\\/])(node_modules|dist|\.venv|__pycache__|\.git)([\\/]|$)|builtin-secrets|settings\.local\.json$/;

async function verify(d) {
  const dir = path.resolve(d); const m = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8')); let bad = 0;
  for (const [rel, v] of Object.entries(m.files)) { const f = path.join(dir, rel); if (!fs.existsSync(f) || await sha256(f) !== v.sha256) { bad++; console.log('不符：' + rel); } }
  console.log(bad ? '核對失敗 ' + bad + ' 個' : '核對通過 ' + Object.keys(m.files).length + ' 個檔案'); process.exit(bad ? 1 : 0);
}
(async () => {
  if (argv[0] === '--verify' && argv[1]) return verify(argv[1]);
  const desk = path.resolve(__dirname, '..');
  const top = run('git', ['rev-parse', '--show-toplevel'], { cwd: desk }).replace(/\//g, path.sep);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const outDir = path.resolve(get('--out', path.join(os.homedir(), 'fa-handoff')));
  const stage = path.join(outDir, 'stage-' + stamp);
  fs.mkdirSync(stage, { recursive: true });
  const say = (s) => console.log('[handoff] ' + s);

  // 1. 倉庫：所有分支與標籤（含沒推送的提交）
  say('建立 repo.bundle …');
  run('git', ['bundle', 'create', path.join(stage, 'repo.bundle'), '--all'], { cwd: top });
  const head = run('git', ['rev-parse', 'HEAD'], { cwd: top });
  const branch = run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: top });
  const dirty = run('git', ['status', '--porcelain'], { cwd: top }).split('\n').filter(Boolean);
  const tracked = dirty.filter((l) => !l.startsWith('??'));
  if (tracked.length) say('⚠ 有 ' + tracked.length + ' 個「已追蹤但未提交」的修改，bundle 不含它們；請先 commit（例如半成品存檔）再打包。前幾個：' + tracked.slice(0, 5).join(' | '));

  // 2. 倉庫外／未追蹤但接手需要的檔案
  const extras = [path.join(top, 'wiki'), path.join(desk, '.weak-harness'), path.join(desk, 'progress.jsonl'), path.join(desk, 'test-reports')].concat(getAll('--extra').map((p) => path.resolve(p)));
  const untracked = dirty.filter((l) => l.startsWith('??')).map((l) => l.slice(3).trim().replace(/^"|"$/g, ''));
  const listed = [];
  for (const e of extras) {
    if (!fs.existsSync(e)) continue;
    const rel = path.relative(top, e).startsWith('..') ? path.join('_outside', path.basename(e)) : path.relative(top, e);
    const files = fs.lstatSync(e).isDirectory() ? walk(e, []) : [e];
    for (const f of files) {
      if (SKIP.test(f)) continue;
      const dest = path.join(stage, 'extras', fs.lstatSync(e).isDirectory() ? path.join(rel, path.relative(e, f)) : rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(f, dest); listed.push(dest);
    }
  }
  say('額外檔案 ' + listed.length + ' 個');

  // 3. 模型（可選）
  for (const m of getAll('--with-models')) {
    const base = path.basename(path.resolve(m));
    for (const f of walk(path.resolve(m), [])) { const dest = path.join(stage, 'models', base, path.relative(path.resolve(m), f)); fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(f, dest); }
    say('模型資料夾 ' + base + ' 已放入');
  }

  // 4. 還原說明
  const md = `# 接手還原步驟（打包時間 ${new Date().toISOString()}）

打包時的倉庫位置：\`${top}\`，分支 \`${branch}\`，提交 \`${head}\`。${tracked.length ? '\n**警告：打包時有已追蹤但未提交的修改，bundle 不含它們。**' : ''}

## 1. 還原倉庫
\`\`\`
git clone repo.bundle fa-restored
cd fa-restored
git checkout ${branch}
\`\`\`
(bundle 內有所有分支。若遠端 \`origin\` 在對方機器也能連，\`git remote set-url origin <網址>\` 後 \`git fetch\` 即可補新的。)
接手第一件事：讀 \`desktop-app/docs/HANDOFF.md\` 的第 0 節（**這是主文件**）。

## 2. 放回倉庫外的檔案
把 \`extras/\` 裡的內容複製回新倉庫的相同相對位置（\`wiki/\`、\`desktop-app/.weak-harness/\`、\`desktop-app/progress.jsonl\`、\`desktop-app/test-reports/\`）。\`_outside/\` 下是你用 --extra 指定的倉庫外路徑，自行放置。

## 3. 重建不在包裡的東西
- **Python 訓練環境**（要 Python 3.11 以上，例如 3.13；預設的 3.10 裝不了 transformers 5.x）：
\`\`\`
py -3.13 -m venv desktop-app/lora-train/.venv
desktop-app/lora-train/.venv/Scripts/python.exe -m pip install torch -r desktop-app/lora-train/requirements.txt --extra-index-url https://download.pytorch.org/whl/cpu
\`\`\`
  （約 220 MB：torch 處理器版約 121 MB，來源 download.pytorch.org 與 PyPI。）
- **Qwen3-0.6B 模型（訓練／驗證用；包裡沒有的話要自己下載，來源都是 huggingface.co）**：
  - \`Qwen/Qwen3-0.6B\`：\`model.safetensors\` 1,503,300,328 位元組，另有 config.json、generation_config.json、merges.txt、tokenizer.json、tokenizer_config.json、vocab.json、LICENSE（約 16 MB）。
  - \`onnx-community/Qwen3-0.6B-ONNX\`：\`onnx/model_quantized.onnx\` 617,687,575 位元組，另有 config.json、generation_config.json、tokenizer.json、tokenizer_config.json。
- **node_modules、dist、launcher 產物、builtin-secrets.json、.claude/settings.local.json**：不打包（金鑰與機器專屬設定），在對方機器自行準備。
- **GitHub 金鑰／登入**：對方要自己有權限才能 push、發布。發布流程見 HANDOFF 第 0.5 節。

## 4. 訓練到一半的東西
打包當下**沒有進行到一半、需要續訓的訓練**（只有煙霧測試與基準測試，沒有留下檢查點）。對方要訓練就從頭開始；工作室的 \`.fatrain\`／\`.fackpt\` 暫停檔若之後產生，請另外放進 \`--extra\` 或 \`--with-models\`。

## 5. 核對
\`MANIFEST.json\` 列出每個檔案的 sha256，可用 \`node scripts/handoff-pack.js --verify <解開後資料夾>\` 核對。
`;
  fs.writeFileSync(path.join(stage, 'RESTORE.md'), md, 'utf8');

  // 5. 清單
  const all = walk(stage, []).filter((f) => !/MANIFEST\.json$/.test(f));
  const files = {}; let total = 0;
  for (const f of all) { const st = fs.statSync(f); total += st.size; files[path.relative(stage, f).replace(/\\/g, '/')] = { size: st.size, sha256: await sha256(f) }; }
  fs.writeFileSync(path.join(stage, 'MANIFEST.json'), JSON.stringify({ format: 'fa-handoff', created: new Date().toISOString(), repoTop: top, branch, head, trackedUncommitted: tracked.length, files }, null, 2));

  // 6. 打成一個檔
  const tarPath = path.join(outDir, 'fa-handoff-' + stamp + '.tar');
  say('打包成 ' + tarPath + ' …');
  run('tar', ['-cf', tarPath, '-C', stage, '.']);
  fs.rmSync(stage, { recursive: true, force: true });
  const sz = fs.statSync(tarPath).size;
  say('完成：' + tarPath + '（' + human(sz) + '，內含 ' + Object.keys(files).length + ' 個檔案）');
  say('在對方機器：解開（tar -xf）後讀 RESTORE.md。主文件：desktop-app/docs/HANDOFF.md 第 0 節。');
})().catch((e) => { console.error('[handoff] 失敗：' + (e && e.message || e)); process.exit(1); });
