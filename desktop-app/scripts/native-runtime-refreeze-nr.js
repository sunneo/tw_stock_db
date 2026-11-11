#!/usr/bin/env node
// 把「只有 nr-*.js 變動」的新版執行包清單做出來（開發者用；只讀本機檔案，不下載、不推送）。
// 做什麼：以 main-ext.js 內嵌的現行清單為底，重新計算 nr-*.js 各檔的大小／sha256／分割段 md5，
// 版本號改成 --version，加上 features，更新各平台大小；輸出到 <輸出資料夾>：
//   manifest.json（新版完整清單，與要推到 GitHub 分支的檔案逐位元組相同）、parts/<只有有變動的 nr-*.js 的分割段>、PUSH-LIST.txt（要推的檔案清單與 md5）。
// 加 --write-main-ext 會把新清單寫回 main-ext.js 內嵌的 NATIVE_RUNTIME_MANIFEST（與分支的 manifest.json 逐位元組相同的約定）。
// 用法：node scripts/native-runtime-refreeze-nr.js <輸出資料夾> --version 1.22.0-2 --features lora [--write-main-ext]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = path.join(__dirname, '..');
const PART_MAX = 5 * 1024 * 1024;
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const safeName = (rel) => rel.replace(/[\\/]/g, '__');

function refreeze(opts) {
    const mainExt = path.join(root, 'main-ext.js');
    const src = fs.readFileSync(mainExt, 'utf8');
    const a = src.indexOf('const NATIVE_RUNTIME_MANIFEST = ');
    const em = a < 0 ? null : /\r?\n\};\r?\n/.exec(src.slice(a)), b = em ? a + em.index : -1, crlf = em ? em[0].indexOf('\r') >= 0 : false; // main-ext.js 是 CRLF
    if (a < 0 || b < 0) throw new Error('main-ext.js 找不到 NATIVE_RUNTIME_MANIFEST');
    const old = JSON.parse(src.slice(a + 'const NATIVE_RUNTIME_MANIFEST = '.length, b + (crlf ? 3 : 2)));
    const m = JSON.parse(JSON.stringify(old));
    m.runtimeVersion = opts.version;
    m.features = opts.features;
    const changed = [];
    for (const f of m.files) {
        if (!/^nr-.*\.js$/.test(f.path)) continue;
        const buf = fs.readFileSync(path.join(root, f.path));
        if (buf.length > PART_MAX) throw new Error(f.path + ' 超過單段上限，需要多段（此工具只處理單段）');
        const sha = sha256(buf);
        if (sha === f.sha256) continue; // 沒變動
        f.size = buf.length; f.sha256 = sha;
        f.parts = [{ name: safeName(f.path) + '.001.part', size: buf.length, md5: md5(buf) }];
        changed.push({ file: f, buf });
    }
    // 各平台大小重算
    m.platforms = {};
    for (const key of Object.keys(old.platforms)) m.platforms[key] = m.files.filter((f) => f.platform === key || f.platform === 'all').reduce((s, f) => s + f.size, 0);
    const out = path.resolve(opts.out);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'parts'), { recursive: true });
    for (const c of changed) fs.writeFileSync(path.join(out, 'parts', c.file.parts[0].name), c.buf);
    const text = JSON.stringify(m, null, 2) + '\n';
    fs.writeFileSync(path.join(out, 'manifest.json'), text);
    const lines = ['要推到 GitHub 分支 native-runtime-1.22.0 的檔案（相對於分支根目錄）：', ' manifest.json  md5 ' + md5(Buffer.from(text, 'utf8')) + '  ' + Buffer.byteLength(text) + ' 位元組'];
    for (const c of changed) lines.push(' parts/' + c.file.parts[0].name + '  md5 ' + c.file.parts[0].md5 + '  ' + c.file.size + ' 位元組  （整檔 sha256 ' + c.file.sha256 + '）');
    lines.push('版本 ' + opts.version + '，features：' + opts.features.join('、') + '；有變動的檔案 ' + changed.length + ' 個');
    fs.writeFileSync(path.join(out, 'PUSH-LIST.txt'), lines.join('\n') + '\n');
    if (opts.writeMainExt) {
        const body = JSON.stringify(m, null, 2).replace(/\n/g, crlf ? '\r\n' : '\n');
        fs.writeFileSync(mainExt, src.slice(0, a) + 'const NATIVE_RUNTIME_MANIFEST = ' + body + src.slice(b + (crlf ? 3 : 2)));
    }
    return { manifest: m, changed: changed.map((c) => c.file.path), manifestMd5: md5(Buffer.from(text, 'utf8')), lines };
}

if (require.main === module) {
    const argv = process.argv.slice(2), o = { out: null, version: null, features: [], writeMainExt: false };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--version') o.version = argv[++i];
        else if (argv[i] === '--features') o.features = String(argv[++i]).split(',').filter(Boolean);
        else if (argv[i] === '--write-main-ext') o.writeMainExt = true;
        else if (!o.out) o.out = argv[i];
    }
    if (!o.out || !o.version) { console.error('用法：node scripts/native-runtime-refreeze-nr.js <輸出資料夾> --version 1.22.0-2 --features lora [--write-main-ext]'); process.exit(2); }
    console.log(refreeze(o).lines.join('\n'));
}

module.exports = { refreeze };
