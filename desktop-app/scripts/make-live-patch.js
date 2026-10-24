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
const SPLIT_ABOVE = 7 * 1000 * 1000; // 超過這個大小（bytes）就切成兩份，每份都在舊版 8MB 上限（8,388,608）內
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
const files = {}; let splitInfo = null;
const willSplit = fs.statSync(path.join(root, 'renderer/floating-assistant.js')).size > SPLIT_ABOVE; // index.html 排在前面，先判斷
for (const rel of FILES) {
  let buf = fs.readFileSync(path.join(root, rel));
  if (md5(buf) !== local.files[rel] && buf.includes(13)) buf = Buffer.from(buf.toString('utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)), 'utf8'); // 工作目錄是 CRLF、發佈的是 LF（git 會正規化）
  if (md5(buf) !== local.files[rel]) throw new Error(rel + ' 的 md5 跟 update-manifest.json 不符：先跑 node build-assistant.js');
  // 超過舊版單檔上限的 floating-assistant.js：切兩份，第二份放進 floating-assistant.min.js，index.html 依序載入兩個 script
  if (rel === 'renderer/floating-assistant.js' && buf.length > SPLIT_ABOVE) { splitInfo = splitScript(buf.toString('utf8')); buf = Buffer.from(splitInfo[0], 'utf8'); }
  else if (rel === 'renderer/floating-assistant.min.js' && splitInfo) buf = Buffer.from(splitInfo[1], 'utf8');
  else if (rel === 'renderer/index.html' && willSplit) {
    const tag = '<script src="floating-assistant.js"></script>', html = buf.toString('utf8');
    if (html.split(tag).length !== 2) throw new Error('index.html 裡找不到唯一的 ' + tag);
    buf = Buffer.from(html.replace(tag, () => tag + String.fromCharCode(10) + '  <script src="floating-assistant.min.js"></script>'), 'utf8');
  }
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true }); fs.writeFileSync(path.join(out, rel), buf);
  const info = { md5: md5(buf) };
  if (buf.length > PART_BYTES) {
    info.parts = [];
    for (let i = 0, n = 0; i < buf.length; i += PART_BYTES, n++) {
      const slice = buf.subarray(i, i + PART_BYTES), p = 'parts/' + path.basename(rel) + '.' + String(n).padStart(3, '0');
      fs.mkdirSync(path.join(out, 'parts'), { recursive: true });
      fs.writeFileSync(path.join(out, p), slice);
      info.parts.push({ path: p, md5: md5(slice), size: slice.length });
    }
    const joined = Buffer.concat(info.parts.map((x) => fs.readFileSync(path.join(out, x.path))));
    if (md5(joined) !== info.md5) throw new Error(rel + ' 分段接回來的 md5 不符');
  }
  files[rel] = info;
}
fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify({ schema: 1, version: String(version), publishedAt: new Date().toISOString(), notes: notes || '', files }, null, 2) + '\n');
console.log('已組好 ' + out + '：' + Object.entries(files).map(([k, v]) => k.split('/').pop() + (v.parts ? '（' + v.parts.length + ' 段）' : '')).join('、'));
