#!/usr/bin/env node
// 網頁版冷載入的 jsDelivr 預熱清單（2026-11-15）：列出一個釘住 SHA 的 web-lazy 下，要預熱的所有網址（一行一個）。
// publish.sh 在網頁版釘新 SHA、推上 main 之後呼叫，對每個網址各發一次 curl（逾時、失敗只警告），
// 讓使用者第一次造訪時 jsDelivr 已經是 HIT。
//
// 用法：node scripts/web-warm-urls.js <完整40字元SHA> [--root <desktop-app 目錄>]
//   預設 --root 是本檔的上一層（desktop-app/），讀 web-lazy/manifest.json 與 web-lazy/boot.json。
// 列出順序：core.js、boot.json、manifest 裡的每個分塊（不含未列在 manifest 的檔案）。
'use strict';
const fs = require('fs'); const path = require('path');

const JSD_BASE = 'https://cdn.jsdelivr.net/gh/sunneo/tw_stock_db@';

// 回傳網址陣列；sha 不合法就丟錯（避免預熱到不存在的 commit）
function warmUrls(sha, manifest, boot) {
    if (!/^[0-9a-f]{40}$/.test(String(sha || ''))) throw new Error('SHA 必須是完整 40 字元的小寫十六進位：' + sha);
    const root = JSD_BASE + sha + '/desktop-app/web-lazy/';
    const urls = [root + 'core.js', root + 'boot.json'];
    const keys = Object.keys((manifest && manifest.chunks) || {});
    for (const k of keys) urls.push(root + 'chunks/' + k + '.js');
    return urls;
}

module.exports = { warmUrls, JSD_BASE };

if (require.main === module) {
    const args = process.argv.slice(2);
    const sha = args[0];
    const ri = args.indexOf('--root');
    const root = ri >= 0 ? path.resolve(args[ri + 1]) : path.join(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'web-lazy', 'manifest.json'), 'utf8'));
    let boot = [];
    try { boot = JSON.parse(fs.readFileSync(path.join(root, 'web-lazy', 'boot.json'), 'utf8')); } catch (_) { boot = []; }
    try {
        process.stdout.write(warmUrls(sha, manifest, boot).join('\n') + '\n');
    } catch (e) {
        console.error(e.message);
        process.exit(2);
    }
}
