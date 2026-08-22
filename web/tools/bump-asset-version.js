#!/usr/bin/env node
/**
 * 自動用 floating-assistant.js 的內容雜湊產生 index.html 裡的 ?v= 版號，
 * 取代「commit時手動記得改版號」——這個repo這個session踩過兩次「內容真的
 * 改了、但忘記手動bump版號，瀏覽器/CDN快取住舊版」的問題（見git log裡
 * "20260821-5"/"20260821-6"/"20260822-1"這幾個手動版號的commit）。人腦
 * 記憶不可靠，交給程式在commit前自動算，版號永遠精確對應內容有沒有變。
 *
 * 用法：node web/tools/bump-asset-version.js
 * 通常不用手動跑，.githooks/pre-commit 會在 commit 動到
 * web/floating-assistant.js 時自動呼叫這支腳本。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const webDir = path.join(__dirname, '..');
const jsPath = path.join(webDir, 'floating-assistant.js');
const htmlPath = path.join(webDir, 'index.html');

const jsContent = fs.readFileSync(jsPath);
const hash = crypto.createHash('sha256').update(jsContent).digest('hex').slice(0, 10);

const html = fs.readFileSync(htmlPath, 'utf8');
const re = /(floating-assistant\.js\?v=)[\w-]+/;
if (!re.test(html)) {
  console.error('[bump-asset-version] 找不到 floating-assistant.js?v=... 這個 script 標籤，請確認 web/index.html 結構沒變');
  process.exit(1);
}
const newHtml = html.replace(re, `$1${hash}`);
if (newHtml !== html) {
  fs.writeFileSync(htmlPath, newHtml);
  console.log(`[bump-asset-version] 版號已更新 → ${hash}`);
} else {
  console.log(`[bump-asset-version] 版號已經是最新的（${hash}），不用改`);
}
