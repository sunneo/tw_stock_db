#!/usr/bin/env node
// 組出要發佈到 desktop-app-patch 分支的內容資料夾（發佈用 git plumbing 的步驟見 .claude/skills/publish-live-update-patch）。
// 用法：node scripts/make-live-patch.js <輸出資料夾> <版本> "<notes>"
//   資料夾內容：renderer/ 四個檔案（完整檔）、parts/ 底下的分段、manifest.json
// 超過 PART_BYTES 的檔案同時放「完整檔」（舊版主程式只認這個，而且舊版有單檔 8MB 上限）與「分段」
// （新版主程式逐段下載再接回來，沒有大小上限；manifest 的 files[路徑].parts 是 [{path, md5}]）。
// 舊版主程式（沒有分檔下載）下載單檔有 8MB 上限，而且重新安裝不是選項：所以 floating-assistant.js 超過上限時，
// 發佈時把它切成兩份放進「本來就在熱更新清單裡的兩個檔案」（floating-assistant.js 與 floating-assistant.min.js），
// 並在 renderer/index.html 依序載入這兩個 <script>（同一個全域範圍，等同一個檔案）。切法：先放所有最上層的 function 宣告
// （單一檔案裡它們本來就會被提升到最前面，所以搬到前面行為不變），其餘最上層敘述照原順序切成前後兩段。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const PART_BYTES = 4 * 1024 * 1024;
const SPLIT_ABOVE = process.env.LIVE_PATCH_NO_SPLIT === '1' ? Infinity : 7 * 1000 * 1000; // LIVE_PATCH_NO_SPLIT=1：不切雙 script，只靠分段（所有機器都換成新更新邏輯之後的正式做法） // 超過這個大小（bytes）就切成兩份，每份都在舊版 8MB 上限（8,388,608）內
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

function splitScript(text) {
  const acorn = require('acorn'); const ast = acorn.parse(text, { ecmaVersion: 'latest', sourceType: 'script' });
  if (ast.body[0] && ast.body[0].directive) throw new Error('檔案開頭有 "' + ast.body[0].directive + '" 指令，這個切法不支援');
  const funcs = ast.body.filter((n) => n.type === 'FunctionDeclaration'), rest = ast.body.filter((n) => n.type !== 'FunctionDeclaration');
  const src = (n) => text.slice(n.start, n.end), size = (n) => Buffer.byteLength(src(n)) + 2;
  const total = ast.body.reduce((a, n) => a + size(n), 0); let acc = funcs.reduce((a, n) => a + size(n), 0), k = 0;
  while (k < rest.length && acc + size(rest[k]) <= total / 2) { acc += size(rest[k]); k++; }
  const a = funcs.map(src).concat(rest.slice(0, k).map(src)).join(';' + String.fromCharCode(10)) + ';' + String.fromCharCode(10);
  const b = rest.slice(k).map(src).join(';' + String.fromCharCode(10)) + ';' + String.fromCharCode(10);
  acorn.parse(a, { ecmaVersion: 'latest' }); acorn.parse(b, { ecmaVersion: 'latest' }); // 兩份各自都要是完整可剖析的程式
  return [a, b];
}

const [out, version, notes] = process.argv.slice(2);
if (!out || !version) { console.error('用法：node scripts/make-live-patch.js <輸出資料夾> <版本> "<notes>"'); process.exit(1); }
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });
const local = JSON.parse(fs.readFileSync(path.join(root, 'renderer/update-manifest.json'), 'utf8'));
const FILES = Object.keys(local.files); // 發佈的檔案清單以 build-assistant.js 產生的 update-manifest.json 為準（不只 renderer 四個檔案，主行程模組也在內）
// ── 凍結的互換版（舊版主程式 EOL）──
// 舊版主程式（單檔 8MB 上限、不認得 parts）的升級路線已經收尾：它們只會停在凍結的互換版（git 標籤 live-patch-compat，
// 內容是 v182：內含新的更新處理 main-ext.js），套用後重啟、再檢查更新，就改走 manifest.v2.json。所以互換版不再跟著新內容走；
// 之後所有新內容只出現在 v2/ 底下與 manifest.v2.json（沒有大小限制）。沒有這個標籤時（第一次）才會產生互換版（見下方原本的流程）。
const COMPAT_REF = process.env.LIVE_PATCH_COMPAT_REF || 'live-patch-compat';
const { execFileSync } = require('child_process');
let frozen = false; try { execFileSync('git', ['rev-parse', '--verify', '-q', COMPAT_REF + '^{commit}'], { cwd: root, stdio: 'pipe' }); frozen = true; } catch (_) { frozen = false; }
if (frozen) {
  const gitShow = (n) => execFileSync('git', ['show', COMPAT_REF + ':' + n], { cwd: root, maxBuffer: 1 << 30 });
  const names = execFileSync('git', ['ls-tree', '-r', '--full-tree', '--name-only', COMPAT_REF], { cwd: root, maxBuffer: 1 << 28 }).toString().split(String.fromCharCode(10)).filter((n) => n && !n.startsWith('v2/') && n !== 'manifest.v2.json');
  for (const n of names) { fs.mkdirSync(path.dirname(path.join(out, n)), { recursive: true }); fs.writeFileSync(path.join(out, n), gitShow(n)); }
  const compat = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8')), v2files = {};
  for (const rel of FILES) {
    let buf = fs.readFileSync(path.join(root, rel));
    if (md5(buf) !== local.files[rel] && buf.includes(13)) buf = Buffer.from(buf.toString('utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)), 'utf8');
    if (md5(buf) !== local.files[rel]) throw new Error(rel + ' 的 md5 跟 update-manifest.json 不符：先跑 node build-assistant.js');
    const c = compat.files[rel]; if (c && c.md5 === md5(buf)) { v2files[rel] = { md5: c.md5 }; continue; } // 跟凍結的互換版一樣：沿用根目錄那份
    const vp = 'v2/' + rel; fs.mkdirSync(path.dirname(path.join(out, vp)), { recursive: true }); fs.writeFileSync(path.join(out, vp), buf);
    const info = { md5: md5(buf), path: vp }; if (buf.length > PART_BYTES) { info.parts = []; for (let k = 0, n = 0; k < buf.length; k += PART_BYTES, n++) { const slice = buf.subarray(k, k + PART_BYTES), p = 'v2/parts/' + path.basename(rel) + '.' + String(n).padStart(3, '0'); fs.mkdirSync(path.join(out, 'v2/parts'), { recursive: true }); fs.writeFileSync(path.join(out, p), slice); info.parts.push({ path: p, md5: md5(slice), size: slice.length }); } if (md5(Buffer.concat(info.parts.map((x) => fs.readFileSync(path.join(out, x.path))))) !== info.md5) throw new Error(rel + ' 分段接回來的 md5 不符'); }
    v2files[rel] = info;
  }
  fs.writeFileSync(path.join(out, 'manifest.v2.json'), JSON.stringify({ schema: 1, version: String(version), publishedAt: new Date().toISOString(), notes: notes || '', files: v2files }, null, 2) + String.fromCharCode(10));
  console.log('已組好 ' + out + '：互換版凍結在 v' + compat.version + '（' + COMPAT_REF + '），新內容 ' + Object.values(v2files).filter((x) => x.path).length + ' 個檔案放在 v2/' + '，版本 ' + version);
  process.exit(0);
}
const files = {}, filesV2 = {}; let splitInfo = null;
const willSplit = fs.statSync(path.join(root, 'renderer/floating-assistant.js')).size > SPLIT_ABOVE; // index.html 排在前面，先判斷
for (const rel of FILES) {
  let buf = fs.readFileSync(path.join(root, rel)), full = null;
  if (md5(buf) !== local.files[rel] && buf.includes(13)) buf = Buffer.from(buf.toString('utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)), 'utf8'); // 工作目錄是 CRLF、發佈的是 LF（git 會正規化）
  if (md5(buf) !== local.files[rel]) throw new Error(rel + ' 的 md5 跟 update-manifest.json 不符：先跑 node build-assistant.js');
  full = buf; // 驗證過的完整檔案（新版用）
  // 超過舊版單檔上限的 floating-assistant.js：切兩份，第二份放進 floating-assistant.min.js，index.html 依序載入兩個 script
  if (rel === 'renderer/floating-assistant.js' && buf.length > SPLIT_ABOVE) { splitInfo = splitScript(buf.toString('utf8')); buf = Buffer.from(splitInfo[0], 'utf8'); }
  else if (rel === 'renderer/floating-assistant.min.js' && splitInfo) buf = Buffer.from(splitInfo[1], 'utf8');
  else if (rel === 'renderer/index.html' && willSplit) {
    const tag = '<script src="floating-assistant.js"></script>', html = buf.toString('utf8');
    if (html.split(tag).length !== 2) throw new Error('index.html 裡找不到唯一的 ' + tag);
    buf = Buffer.from(html.replace(tag, () => tag + String.fromCharCode(10) + '  <script src="floating-assistant.min.js"></script>'), 'utf8');
  }
  // 互換版（manifest.json）：舊版主程式只認這個，每個檔案都要在 8MB 內
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), buf);
  files[rel] = { md5: md5(buf) };
  // 新版（manifest.v2.json）：新的更新處理（main-ext.js）優先讀這個——原本的單一大檔 + 分段，不需要切雙 script；沒有差別的檔案沿用互換版的項目
  if (buf.equals(full)) { filesV2[rel] = files[rel]; continue; }
  const vp = 'v2/' + rel; fs.mkdirSync(path.dirname(path.join(out, vp)), { recursive: true }); fs.writeFileSync(path.join(out, vp), full);
  const info = { md5: md5(full), path: vp, parts: [] };
  for (let k = 0, n = 0; k < full.length; k += PART_BYTES, n++) {
    const slice = full.subarray(k, k + PART_BYTES), p = 'v2/parts/' + path.basename(rel) + '.' + String(n).padStart(3, '0');
    fs.mkdirSync(path.join(out, 'v2/parts'), { recursive: true }); fs.writeFileSync(path.join(out, p), slice);
    info.parts.push({ path: p, md5: md5(slice), size: slice.length });
  }
  if (md5(Buffer.concat(info.parts.map((x) => fs.readFileSync(path.join(out, x.path))))) !== info.md5) throw new Error(rel + ' 分段接回來的 md5 不符');
  filesV2[rel] = info;
}
const head = { schema: 1, version: String(version), publishedAt: new Date().toISOString(), notes: notes || '' };
fs.writeFileSync(path.join(out, 'manifest.v2.json'), JSON.stringify({ ...head, files: filesV2 }, null, 2) + '\n');
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ ...head, files }, null, 2) + '\n');
console.log('已組好 ' + out + '：' + Object.entries(files).map(([k, v]) => k.split('/').pop() + (v.parts ? '（' + v.parts.length + ' 段）' : '')).join('、'));
