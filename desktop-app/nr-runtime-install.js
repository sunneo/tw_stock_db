// 執行包按需安裝（見 DESIGN.TODO.native-runner.md 第 4 項）。只在主程序使用；由使用者在介面按下安裝時才執行，不會自動下載。
// 來源順序（使用者原話：「用npm官方庫優先，官方庫掛了才跑github branch下載」）：
//   1. npm 官方庫：onnxruntime-node-1.22.0.tgz，用 integrity（sha512）驗證後抽取 onnxruntime 相關檔（不含 onnxruntime-common 與子程序程式）。
//   2. GitHub 分支 native-runtime-1.22.0：釘住 commit SHA 的 raw 網址，分割段逐段 md5，合併後整檔 sha256。
// 切換條件：npm 連線失敗、逾時、HTTP 非 200、或 integrity 驗證失敗，才改走來源 2。兩個來源取得的每個檔案都要 sha256 相同。
// 進度與原因都會寫進 log（哪個來源、為什麼切換）。
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');

const NPM_PREFIX = 'node_modules/onnxruntime-node/';

function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function sha512Integrity(buf) { return 'sha512-' + crypto.createHash('sha512').update(buf).digest('base64'); }

// 讀 tgz 內的檔案（ustar 格式，只取 wanted(名稱) 為真的一般檔案）。名稱是 tgz 內的路徑（例如 package/dist/index.js）。
function tgzEntries(gz, wanted) {
    const buf = zlib.gunzipSync(gz);
    const out = new Map();
    const cstr = (off, len) => { let e = off; while (e < off + len && buf[e] !== 0) e++; return buf.toString('utf8', off, e); };
    let off = 0;
    while (off + 512 <= buf.length) {
        if (buf.subarray(off, off + 512).every((b) => b === 0)) break;
        const name = cstr(off, 100), prefix = cstr(off + 345, 155);
        const full = prefix ? prefix + '/' + name : name;
        const size = parseInt(cstr(off + 124, 12).trim() || '0', 8);
        const type = String.fromCharCode(buf[off + 156] || 48);
        if ((type === '0' || type === '\0') && wanted(full)) out.set(full, Buffer.from(buf.subarray(off + 512, off + 512 + size)));
        off += 512 + Math.ceil(size / 512) * 512;
    }
    return out;
}

// tgz 內名稱（package/...）對應到執行包內的路徑（node_modules/onnxruntime-node/...）
function tgzToRel(name) {
    if (!name.startsWith('package/')) return null;
    return NPM_PREFIX + name.slice('package/'.length);
}

function platformFiles(manifest, platformKey) {
    return manifest.files.filter((f) => f.platform === platformKey || f.platform === 'all');
}

// 來源 1：npm。回傳 { ok, why, bufs: Map(rel→Buffer) }。
async function trySourceNpm(manifest, opts) {
    const src = manifest.sources.npm;
    let gz;
    try { gz = await opts.fetchBytes(opts.npmLocation || src.tarball, opts.timeoutMs); }
    catch (e) { return { ok: false, why: 'npm 連線失敗、逾時或 HTTP 非 200：' + String((e && e.message) || e) }; }
    if (sha512Integrity(gz) !== src.integrity) return { ok: false, why: 'npm 的 integrity（sha512）驗證失敗' };
    const want = new Set(platformFiles(manifest, opts.platformKey).map((f) => f.path));
    const entries = tgzEntries(gz, (n) => { const r = tgzToRel(n); return r && want.has(r); });
    const bufs = new Map();
    for (const [name, buf] of entries) bufs.set(tgzToRel(name), buf);
    return { ok: true, bufs, bytes: gz.length };
}

// 來源 2：GitHub 分支的分割段。每段 md5 核對，合併後整檔 sha256 核對。
async function readFromGithub(manifest, file, opts) {
    const parts = [];
    for (const p of file.parts) {
        const b = await opts.fetchBytes(opts.githubBase + '/parts/' + p.name, opts.timeoutMs);
        if (md5(b) !== p.md5) throw new Error('段 ' + p.name + ' 的 md5 不符');
        parts.push(b);
    }
    const buf = Buffer.concat(parts);
    if (buf.length !== file.size || sha256(buf) !== file.sha256) throw new Error('合併後 ' + file.path + ' 的 sha256 不符');
    return buf;
}

// 主流程。opts: { manifest, platformKey, runtimeDir（最後的目標）, npmLocation?, githubBase, fetchBytes(location, timeoutMs)→Buffer, forceGithub?, timeoutMs, log, nrSourceDir }
// 回傳 { ok, runtimeDir, sourcesUsed: {rel: 'npm'|'github'}, why? }
async function installRuntime(opts) {
    const log = opts.log || (() => {});
    const prog = opts.progress || (() => {}); // prog({ stage, source, detail }) 給介面顯示進度與來源
    const m = opts.manifest;
    const files = platformFiles(m, opts.platformKey);
    const stage = opts.runtimeDir + '.partial';
    fs.rmSync(stage, { recursive: true, force: true });
    let npm = { ok: false, why: '沒有嘗試' };
    if (!opts.forceGithub) {
        log('[native-runtime] 來源 1：npm 官方庫（' + m.sources.npm.package + '）');
        prog({ stage: 'npm', source: 'npm', detail: '正在下載 npm 官方庫的 tgz（約 89 MB）' });
        npm = await trySourceNpm(m, opts);
        if (npm.ok) { log('[native-runtime] npm 成功（' + npm.bytes + ' 位元組），抽取 onnxruntime 相關檔'); prog({ stage: 'npm-ok', source: 'npm', detail: 'npm 下載完成，integrity 驗證通過（' + npm.bytes + ' 位元組）' }); }
        else { log('[native-runtime] 切換到來源 2（GitHub 分支）：' + npm.why); prog({ stage: 'switch', source: 'github', detail: '切換到 GitHub 分支，原因：' + npm.why }); }
    } else {
        log('[native-runtime] 強制使用來源 2（GitHub 分支）');
        prog({ stage: 'switch', source: 'github', detail: '強制使用 GitHub 分支（測試）' });
    }
    const sourcesUsed = {};
    const installed = {};
    try {
        for (const f of files) {
            let buf = npm.ok && npm.bufs.get(f.path) ? npm.bufs.get(f.path) : null;
            let from = 'npm';
            if (buf && sha256(buf) !== f.sha256) { buf = null; log('[native-runtime] npm 的 ' + f.path + ' sha256 不符，改用來源 2'); }
            if (!buf) { buf = await readFromGithub(m, f, opts); from = 'github'; }
            if (sha256(buf) !== f.sha256) throw new Error('最終檔案 ' + f.path + ' 的 sha256 不符');
            const dst = path.join(stage, ...f.path.split('/'));
            fs.mkdirSync(path.dirname(dst), { recursive: true });
            fs.writeFileSync(dst, buf);
            sourcesUsed[f.path] = from;
            installed[f.path] = { size: buf.length, md5: md5(buf), sha256: sha256(buf) };
            prog({ stage: 'file', source: from, detail: '第 ' + (Object.keys(installed).length) + ' / ' + files.length + ' 個檔案（' + from + '）：' + f.path });
        }
        // 子程序程式（nr-*.js）：只能從來源 2 取得（npm 沒有）；名單在 manifest 的 files 裡，source 標示 github
        if (opts.nrSourceDir) {
            for (const f of m.files.filter((x) => /^nr-.*\.js$/.test(x.path))) {
                const buf = fs.readFileSync(path.join(opts.nrSourceDir, f.path));
                if (sha256(buf) !== f.sha256) throw new Error('本機 ' + f.path + ' 與分割包不一致');
                fs.writeFileSync(path.join(stage, f.path), buf);
                sourcesUsed[f.path] = 'local';
                installed[f.path] = { size: buf.length, md5: md5(buf), sha256: sha256(buf) };
            }
        }
        for (const f of m.files.filter((x) => /^nr-.*\.js$/.test(x.path))) {
            if (!installed[f.path]) { const buf = await readFromGithub(m, f, opts); fs.writeFileSync(path.join(stage, f.path), buf); sourcesUsed[f.path] = 'github'; installed[f.path] = { size: buf.length, md5: md5(buf), sha256: sha256(buf) }; }
        }
        const [plat, arch] = opts.platformKey.split('-');
        const runtimeFiles = {};
        for (const k of Object.keys(installed)) runtimeFiles[k] = { size: installed[k].size, md5: installed[k].md5 };
        fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify({ runtimeVersion: m.runtimeVersion, ortVersion: m.ortVersion, platform: plat, arch, license: m.license, files: runtimeFiles }, null, 2) + '\n');
        fs.rmSync(opts.runtimeDir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(opts.runtimeDir), { recursive: true });
        fs.renameSync(stage, opts.runtimeDir);
        return { ok: true, runtimeDir: opts.runtimeDir, sourcesUsed, npmUsed: npm.ok };
    } catch (e) {
        fs.rmSync(stage, { recursive: true, force: true });
        return { ok: false, why: String((e && e.message) || e), sourcesUsed };
    }
}

// 本機與測試用的讀取器：location 是檔案路徑（tgz 或目錄）；網址則用 https（只在主程序、產品用）。
function localFetchBytes(location) {
    if (fs.existsSync(location) && fs.statSync(location).isFile()) return Promise.resolve(fs.readFileSync(location));
    return Promise.reject(new Error('找不到來源：' + location));
}

// 產品用的網路讀取器（只在主程序、使用者按下安裝時用）：跟隨最多 5 次轉址，HTTP 非 200 就失敗，逾時就中斷。
function httpsFetchBytes(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const https = require('https');
        const go = (u, hops) => {
            const req = https.get(u, { timeout: timeoutMs || 60000 }, (res) => {
                if ([301, 302, 303, 307, 308].indexOf(res.statusCode) >= 0 && res.headers.location && hops < 5) {
                    res.resume(); go(new URL(res.headers.location, u).toString(), hops + 1); return;
                }
                if (res.statusCode !== 200) { res.resume(); reject(new Error('HTTP ' + res.statusCode)); return; }
                const chunks = [];
                res.on('data', (c) => chunks.push(c));
                res.on('end', () => resolve(Buffer.concat(chunks)));
                res.on('error', reject);
            });
            req.on('timeout', () => req.destroy(new Error('逾時')));
            req.on('error', reject);
        };
        go(url, 0);
    });
}

module.exports = { installRuntime, tgzEntries, sha512Integrity, sha256, localFetchBytes, httpsFetchBytes, NPM_PREFIX };
