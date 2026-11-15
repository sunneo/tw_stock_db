#!/usr/bin/env node
// 發布前檢查：web-lazy/ 底下實際的檔案跟 manifest.json 完全一致（少一個、多一個、檢查碼不對都不准發布）。
// 加 --remote <完整 SHA> 時，另外逐一確認每個檔案在釘住的 commit 下 raw 網址回應 HTTP 200 且檢查碼一致。
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const dir = path.join(__dirname, '..', 'web-lazy');
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const man = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const expect = { 'core.js': man.core.md5 };
for (const c of Object.values(man.chunks)) expect[c.file] = c.md5;
const errors = [];
for (const [f, m] of Object.entries(expect)) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) { errors.push('缺檔：' + f); continue; }
    if (md5(fs.readFileSync(p)) !== m) errors.push('檢查碼不符：' + f);
}
const actual = [];
(function walk(d, rel) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r = rel ? rel + '/' + e.name : e.name; e.isDirectory() ? walk(path.join(d, e.name), r) : actual.push(r); } })(dir, '');
// boot.json：開機要平行預抓的區塊清單（scripts/build-web-lazy.js 產生，載入器在核心執行前讀它），不是區塊檔，所以不列進 manifest；
// 但內容要合法，且清單裡的每個區塊都必須在 manifest 裡（否則載入器會預抓到不存在的檔案）。
const SIDE_FILES = new Set(['manifest.json', 'boot.json']);
if (actual.indexOf('boot.json') >= 0) {
    try {
        const b = JSON.parse(fs.readFileSync(path.join(dir, 'boot.json'), 'utf8'));
        if (!b || !Array.isArray(b.names)) errors.push('boot.json 格式不符（要有 names 陣列）');
        else for (const n of b.names) if (!man.chunks[n]) errors.push('boot.json 列了不在 manifest 的區塊：' + n);
    } catch (e) { errors.push('boot.json 無法解析：' + (e && e.message)); }
}
for (const f of actual) if (!SIDE_FILES.has(f) && !expect[f]) errors.push('manifest 沒有列到：' + f);
if (errors.length) { console.error('web-lazy 檢查失敗：\n' + errors.join('\n')); process.exit(1); }
console.log('web-lazy 本機檢查通過：core.js＋' + Object.keys(man.chunks).length + ' 個區塊檔');
// 舊版 node（16 以前）沒有內建 fetch：退回 https 模組（只做 GET，跟隨轉址）。
const httpGet = (url, n) => new Promise((res, rej) => {
    require('https').get(url, { headers: { 'User-Agent': 'fa-web-lazy-check' } }, (r) => {
        if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && (n || 0) < 5) { r.resume(); return res(httpGet(new URL(r.headers.location, url).href, (n || 0) + 1)); }
        const c = []; r.on('data', (d) => c.push(d)); r.on('end', () => res({ ok: r.statusCode >= 200 && r.statusCode < 300, status: r.statusCode, arrayBuffer: async () => Buffer.concat(c) }));
    }).on('error', rej);
});
const getUrl = (u) => (typeof fetch === 'function' ? fetch(u) : httpGet(u));
const i = process.argv.indexOf('--remote');
if (i > 0) {
    const sha = process.argv[i + 1];
    (async () => {
        const base = 'https://raw.githubusercontent.com/sunneo/tw_stock_db/' + sha + '/desktop-app/web-lazy/';
        let bad = 0;
        for (const [f, m] of Object.entries(expect)) {
            const r = await getUrl(base + f);
            const ok = r.ok && md5(Buffer.from(await r.arrayBuffer())) === m;
            if (!ok) { bad++; console.error('遠端不對：' + f + ' HTTP ' + r.status); }
        }
        if (bad) process.exit(1);
        console.log('遠端 ' + Object.keys(expect).length + ' 個檔案都是 HTTP 200 且檢查碼一致');
    })().catch(e => { console.error(e); process.exit(1); });
}
