#!/usr/bin/env node
'use strict';
// 給 scripts/publish.sh 用：組 patch 目錄與遠端用的 manifest.json。
// 用法：node scripts/publish-manifest.js <patch目錄> <版本> <備註>
// 實際工作交給 scripts/make-live-patch.js：照 update-manifest.json 的完整檔案清單複製、
// floating-assistant.js 超過 7MB 時切成兩份（舊版主程式單檔 8MB 上限，而且不能要求使用者重新安裝）、
// 大檔另附分段給新版主程式、寫出 manifest.json（遠端格式 { 路徑: { md5, parts? } }）。
const path = require('path');
const { execFileSync } = require('child_process');

const [patchDir, version, notes] = process.argv.slice(2);
if (!patchDir || !version || !notes) { console.error('用法：node scripts/publish-manifest.js <patch目錄> <版本> <備註>'); process.exit(2); }
execFileSync(process.execPath, [path.join(__dirname, 'make-live-patch.js'), patchDir, String(version), String(notes)], { stdio: 'inherit' });
