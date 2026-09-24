#!/usr/bin/env node
// tw_stock_db客製: 2026-09-25使用者要求——「超過20MB的進入branch都要split by
// 20MB並提供合併回來的script」。這是「package為單位的branch」（每個大型
// 外部套件——例如clang.wasm/lld.wasm這類WASM工具鏈——各自mirror進一個獨立的
// GitHub backup分支，例如`clang-wasm-backup`）的**產出端**工具：把一個本機
// 大檔案切成≤20MB的`.partNNN`片段＋維護一份`manifest.json`，格式跟
// floating-assistant.js既有的_fetchAssetBackupFile()讀取邏輯完全對齊
// （同一套manifest.json + `<relPath>.partNNN`慣例，這支腳本產出的東西可以
// 直接commit進backup分支、不需要renderer端改任何程式碼就能被抓到）。
//
// 跟main分支的db-snapshot分支（tw_stock.db.part000~part004 + merge_db.py）
// 是同一種精神的延伸——不用Git LFS（免費頻寬額度太容易超額），改用「一般
// git檔案+手動切割」。
//
// 用法：
//   node split-asset-for-branch.js <來源檔案> [relPath] [--chunk-mb=20] [--out=<目錄>]
//
//   <來源檔案>   要切割的本機檔案（例如 ./clang.wasm）
//   [relPath]    manifest.json裡登記的路徑（呼叫端_fetchAssetBackupFile()的
//                relPath參數要跟這個完全一致）——留空預設用來源檔案的檔名。
//   --chunk-mb   每片大小上限（MB），預設20（使用者明確要求的門檻）。
//   --out        輸出目錄（.partNNN檔案＋manifest.json都寫在這裡），預設是
//                來源檔案所在目錄下的 ./dist-branch/。
//
// 同一個--out目錄可以對多個不同檔案各跑一次這支腳本——manifest.json用
// upsert（依path比對，找到就整筆覆蓋、找不到就新增），不會把前一個檔案的
// entry洗掉，符合「一個branch裡可能同時放好幾個檔案（例如clang.wasm+
// lld.wasm都在同一個clang-wasm-backup分支）」的情境。
//
// 小於等於--chunk-mb的檔案一樣會走這支腳本（parts=1，仍然切成
// `<relPath>.part000`一份），維持「backup分支底下的檔案一律用manifest.json
// 描述、一律用.partNNN命名」的一致性，_fetchAssetBackupFile()判斷entry是否
// 存在就走chunked邏輯，不會因為只有一片而特別處理。

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function parseArgs(argv) {
  const positional = [];
  const opts = { chunkMb: 20, out: null };
  for (const a of argv) {
    if (a.startsWith("--chunk-mb=")) opts.chunkMb = Number(a.slice("--chunk-mb=".length)) || 20;
    else if (a.startsWith("--out=")) opts.out = a.slice("--out=".length);
    else positional.push(a);
  }
  return { positional, opts };
}

function sha256File(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

function main() {
  const { positional, opts } = parseArgs(process.argv.slice(2));
  const srcPath = positional[0];
  if (!srcPath) {
    console.error("用法: node split-asset-for-branch.js <來源檔案> [relPath] [--chunk-mb=20] [--out=<目錄>]");
    process.exit(1);
  }
  const relPath = positional[1] || path.basename(srcPath);
  const outDir = opts.out ? path.resolve(opts.out) : path.join(path.dirname(path.resolve(srcPath)), "dist-branch");
  const chunkBytes = Math.max(1, Math.floor(opts.chunkMb * 1024 * 1024));

  const buf = fs.readFileSync(srcPath);
  const totalSize = buf.length;
  const wholeSha256 = sha256File(buf);
  const partCount = Math.max(1, Math.ceil(totalSize / chunkBytes));

  fs.mkdirSync(outDir, { recursive: true });
  // relPath可能帶子目錄（例如"clang/clang.wasm"）——.partNNN檔案要落在
  // 對應的子目錄底下，manifest.json裡的path沿用relPath原樣（給
  // _fetchAssetBackupFile()當key直接比對，不做任何正規化）。
  const relDir = path.dirname(relPath);
  if (relDir && relDir !== ".") fs.mkdirSync(path.join(outDir, relDir), { recursive: true });

  const partsSha256 = [];
  for (let i = 0; i < partCount; i++) {
    const start = i * chunkBytes;
    const end = Math.min(totalSize, start + chunkBytes);
    const chunk = buf.subarray(start, end);
    const partName = `${relPath}.part${String(i).padStart(3, "0")}`;
    fs.writeFileSync(path.join(outDir, partName), chunk);
    partsSha256.push(sha256File(chunk));
    console.log(`  寫入 ${partName}（${(chunk.length / 1024 / 1024).toFixed(2)}MB）`);
  }

  const manifestPath = path.join(outDir, "manifest.json");
  let manifest = { files: [] };
  if (fs.existsSync(manifestPath)) {
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")); } catch (_) { manifest = { files: [] }; }
    if (!Array.isArray(manifest.files)) manifest.files = [];
  }
  const entry = {
    path: relPath,
    parts: partCount,
    size: totalSize,
    sha256: wholeSha256,
    partsSha256,
    chunkBytes,
    updatedAt: new Date().toISOString(),
  };
  const existingIdx = manifest.files.findIndex((f) => f.path === relPath);
  if (existingIdx >= 0) manifest.files[existingIdx] = entry; else manifest.files.push(entry);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  console.log(
    `\n完成：${srcPath}（${(totalSize / 1024 / 1024).toFixed(2)}MB）切成 ${partCount} 片，寫進 ${outDir}\n` +
    `sha256（整份）：${wholeSha256}\n` +
    `manifest.json 已更新（entry path="${relPath}"）\n\n` +
    `下一步：把 ${outDir} 底下的內容（.part* + manifest.json）commit/push到對應的\n` +
    `package backup分支（例如 <package>-wasm-backup），renderer端floating-assistant.js\n` +
    `的_fetchAssetBackupFile(backupBase, "${relPath}")就能直接抓到、自動合併。\n` +
    `要在本機驗證切出來的片段能不能正確還原，跑：\n` +
    `  node merge-asset-from-branch.js ${path.relative(process.cwd(), outDir)} ${relPath} --out=/tmp/${path.basename(relPath)}`
  );
}

main();
