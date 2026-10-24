#!/usr/bin/env node
// 組出要發佈到 desktop-app-patch 分支的內容資料夾（發佈用 git plumbing 的步驟見 .claude/skills/publish-live-update-patch）。
// 用法：node scripts/make-live-patch.js <輸出資料夾> <版本> "<notes>"
//   資料夾內容：renderer/ 四個檔案（完整檔）、parts/ 底下的分段、manifest.json
// 超過 PART_BYTES 的檔案同時放「完整檔」（舊版主程式只認這個，而且舊版有單檔 8MB 上限）與「分段」
// （新版主程式逐段下載再接回來，沒有大小上限；manifest 的 files[路徑].parts 是 [{path, md5}]）。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const PART_BYTES = 4 * 1024 * 1024;
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');

const [out, version, notes] = process.argv.slice(2);
if (!out || !version) { console.error('用法：node scripts/make-live-patch.js <輸出資料夾> <版本> "<notes>"'); process.exit(1); }
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'renderer'), { recursive: true });
const local = JSON.parse(fs.readFileSync(path.join(root, 'renderer/update-manifest.json'), 'utf8'));
const FILES = Object.keys(local.files); // 發佈的檔案清單以 build-assistant.js 產生的 update-manifest.json 為準（不只 renderer 四個檔案，主行程模組也在內）
const files = {};
for (const rel of FILES) {
  let buf = fs.readFileSync(path.join(root, rel));
  if (md5(buf) !== local.files[rel] && buf.includes(13)) buf = Buffer.from(buf.toString('utf8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)), 'utf8'); // 工作目錄是 CRLF、發佈的是 LF（git 會正規化）
  if (md5(buf) !== local.files[rel]) throw new Error(rel + ' 的 md5 跟 update-manifest.json 不符：先跑 node build-assistant.js');
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
