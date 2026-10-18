#!/usr/bin/env node
'use strict';
// 給 scripts/publish.sh 用：把 renderer/update-manifest.json 列的檔案複製進 patch 目錄，寫出遠端用的 manifest.json。
// 用法：node scripts/publish-manifest.js <patch目錄> <版本> <備註>
// 遠端 manifest 的 files 是 { 路徑: { md5 } }（本機的 update-manifest.json 是 { 路徑: "md5" }，兩邊格式不一樣，這裡轉換）。
const fs = require('fs');
const path = require('path');

const [patchDir, version, notes] = process.argv.slice(2);
if (!patchDir || !version || !notes) { console.error('用法：node scripts/publish-manifest.js <patch目錄> <版本> <備註>'); process.exit(2); }
const appDir = path.resolve(__dirname, '..');
const local = JSON.parse(fs.readFileSync(path.join(appDir, 'renderer', 'update-manifest.json'), 'utf8'));
const names = Object.keys(local.files || {});
if (!names.length) { console.error('update-manifest.json 沒有任何檔案（先跑 node build-assistant.js）'); process.exit(1); }
for (const k of names) {
    const src = path.join(appDir, k); if (!fs.existsSync(src)) { console.error('找不到檔案：' + k); process.exit(1); }
    const dst = path.join(patchDir, k); fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst);
}
const manifest = { schema: 1, version: String(version), publishedAt: new Date().toISOString(), notes: String(notes), files: Object.fromEntries(names.map((k) => [k, { md5: local.files[k] }])) };
fs.writeFileSync(path.join(patchDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('已複製 ' + names.length + ' 個檔案，版本 ' + version);
