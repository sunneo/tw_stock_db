#!/usr/bin/env node
// tw_stock_db客製: 2026-09-25使用者要求的「合併回來的script」——
// split-asset-for-branch.js的反向操作，純本機驗證/還原用（renderer端
// floating-assistant.js的_fetchAssetBackupFile()自己有一份等效邏輯，直接在
// 瀏覽器裡對著GitHub raw URL做一樣的事，兩邊manifest.json/.partNNN格式完全
// 一致，這支腳本不是renderer執行期會用到的東西，是給人在本機核對「切出來
// 的片段真的能還原成原始檔案」、或需要在CI/本機重組一份完整檔案時用的）。
// 不用Git LFS，純粹讀git-tracked的.partNNN檔案+manifest.json重組。
//
// 用法：
//   node merge-asset-from-branch.js <manifest.json所在目錄> <relPath> [--out=<輸出檔案>]
//
//   <manifest.json所在目錄>   通常是clone下來的<package>-wasm-backup分支根目錄
//   <relPath>                 manifest.json裡的path欄位（跟split時給的
//                              relPath要完全一致）
//   --out                     還原後寫到哪個檔案，預設跟relPath同名、寫在
//                              目前工作目錄

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function parseArgs(argv) {
  const positional = [];
  const opts = { out: null };
  for (const a of argv) {
    if (a.startsWith("--out=")) opts.out = a.slice("--out=".length);
    else positional.push(a);
  }
  return { positional, opts };
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const dir = positional[0];
  const relPath = positional[1];
  if (!dir || !relPath) {
    console.error("用法: node merge-asset-from-branch.js <manifest.json所在目錄> <relPath> [--out=<輸出檔案>]");
    process.exit(1);
  }
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`找不到 ${manifestPath}`);
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const entry = Array.isArray(manifest.files) ? manifest.files.find((f) => f.path === relPath) : null;
  if (!entry) {
    console.error(`manifest.json裡找不到path="${relPath}"的entry。可用的path：\n` +
      (Array.isArray(manifest.files) ? manifest.files.map((f) => `  - ${f.path}`).join("\n") : "（manifest.json沒有files陣列）"));
    process.exit(1);
  }

  const buffers = [];
  for (let i = 0; i < entry.parts; i++) {
    const partPath = path.join(dir, `${relPath}.part${String(i).padStart(3, "0")}`);
    if (!fs.existsSync(partPath)) {
      console.error(`缺少片段：${partPath}`);
      process.exit(1);
    }
    const buf = fs.readFileSync(partPath);
    if (Array.isArray(entry.partsSha256) && entry.partsSha256[i]) {
      const actualHash = crypto.createHash("sha256").update(buf).digest("hex");
      if (actualHash !== entry.partsSha256[i]) {
        console.error(`片段 ${partPath} 的sha256不符（manifest記錄=${entry.partsSha256[i]}，實際=${actualHash}），檔案可能損毀或被截斷`);
        process.exit(1);
      }
    }
    buffers.push(buf);
  }

  const merged = Buffer.concat(buffers);
  if (entry.size && merged.length !== entry.size) {
    console.error(`合併後大小不符（manifest記錄=${entry.size}，實際=${merged.length}）`);
    process.exit(1);
  }
  if (entry.sha256) {
    const actualWhole = crypto.createHash("sha256").update(merged).digest("hex");
    if (actualWhole !== entry.sha256) {
      console.error(`合併後整份sha256不符（manifest記錄=${entry.sha256}，實際=${actualWhole}），還原失敗`);
      process.exit(1);
    }
  }

  const outPath = opts.out ? path.resolve(opts.out) : path.resolve(path.basename(relPath));
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, merged);
  console.log(`還原成功：${entry.parts} 片 → ${outPath}（${(merged.length / 1024 / 1024).toFixed(2)}MB），sha256/大小都跟manifest.json核對通過。`);
}

main();
