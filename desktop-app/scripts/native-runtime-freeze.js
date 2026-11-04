// 凍結分割包（開發者用）：把 onnxruntime-node 1.22.0 的 tgz 抽取結果、onnxruntime-common、子程序程式分割成 ≤5 MB 的段，
// 每段附 md5，每個檔案附 sha256，寫出 manifest.json。只讀本機檔案，不下載。見 DESIGN.TODO.native-runner.md 第 4 項。
// 用法：node scripts/native-runtime-freeze.js <tgz 抽取資料夾（含 package/）> <onnxruntime-common 資料夾> <輸出資料夾> [--tgz <tgz 路徑>] [--integrity <sha512-…>]
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PART_MAX = 5 * 1024 * 1024; // 每段上限 5 MB
const ORT_VERSION = '1.22.0';
const RUNTIME_VERSION = '1.22.0-1';
const PLATFORMS = [['win32', 'x64'], ['linux', 'x64']];
const NR_FILES = ['nr-child.js', 'nr-engine.js', 'nr-host.js', 'nr-protocol.js', 'nr-gen-params.js', 'nr-template.js', 'nr-tokenizer.js'];

function md5(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function safeName(rel) { return rel.replace(/[\\/]/g, '__'); }

// 收集要打包的檔案：{ rel（執行包內的相對路徑，/ 分隔）, src（本機來源路徑）, platform（'win32-x64'、'linux-x64' 或 'all'）}
function collect(opts) {
    const out = [];
    const pkg = path.join(opts.extract, 'package');
    const add = (rel, src, platform) => out.push({ rel, src, platform });
    add('node_modules/onnxruntime-node/package.json', path.join(pkg, 'package.json'), 'all');
    for (const f of fs.readdirSync(path.join(pkg, 'dist'))) {
        if (/\.map$|\.d\.ts$/.test(f)) continue; // 執行時用不到
        add('node_modules/onnxruntime-node/dist/' + f, path.join(pkg, 'dist', f), 'all');
    }
    for (const [p, a] of PLATFORMS) {
        const dir = path.join(pkg, 'bin', 'napi-v6', p, a);
        for (const f of fs.readdirSync(dir)) {
            if (/DirectML|dxcompiler|dxil/i.test(f)) continue; // 產品不用 DirectML
            add('node_modules/onnxruntime-node/bin/napi-v6/' + p + '/' + a + '/' + f, path.join(dir, f), p + '-' + a);
        }
    }
    // onnxruntime-common（執行時 dist/index.js 會 require 它）：只取 package.json 與 dist/cjs
    add('node_modules/onnxruntime-common/package.json', path.join(opts.common, 'package.json'), 'all');
    const cjs = path.join(opts.common, 'dist', 'cjs');
    for (const f of fs.readdirSync(cjs)) if (!/\.map$|\.d\.ts$/.test(f) && fs.statSync(path.join(cjs, f)).isFile()) add('node_modules/onnxruntime-common/dist/cjs/' + f, path.join(cjs, f), 'all');
    const cjsPkgDir = path.join(cjs);
    // 子程序程式（與 scripts/native-runtime-pack.js 相同來源：repo 根目錄）
    for (const f of NR_FILES) add(f, path.join(opts.repo, f), 'all');
    return out;
}

function freeze(opts) {
    const ortPkg = JSON.parse(fs.readFileSync(path.join(opts.extract, 'package', 'package.json'), 'utf8'));
    if (ortPkg.version !== ORT_VERSION) throw new Error('onnxruntime-node 版本 ' + ortPkg.version + '，應為 ' + ORT_VERSION);
    const commonPkg = JSON.parse(fs.readFileSync(path.join(opts.common, 'package.json'), 'utf8'));
    if (commonPkg.version !== ORT_VERSION) throw new Error('onnxruntime-common 版本 ' + commonPkg.version + '，應為 ' + ORT_VERSION);
    const out = path.resolve(opts.out);
    fs.rmSync(out, { recursive: true, force: true });
    fs.mkdirSync(path.join(out, 'parts'), { recursive: true });
    const files = [];
    for (const it of collect(opts)) {
        const buf = fs.readFileSync(it.src);
        const parts = [];
        for (let off = 0, n = 0; off < buf.length || (off === 0 && buf.length === 0); off += PART_MAX, n++) {
            const chunk = buf.subarray(off, Math.min(buf.length, off + PART_MAX));
            const name = safeName(it.rel) + '.' + String(n + 1).padStart(3, '0') + '.part';
            fs.writeFileSync(path.join(out, 'parts', name), chunk);
            parts.push({ name, size: chunk.length, md5: md5(chunk) });
            if (buf.length === 0) break;
        }
        files.push({ path: it.rel, platform: it.platform, size: buf.length, sha256: sha256(buf), parts });
    }
    const platformSizes = {};
    for (const [p, a] of PLATFORMS) {
        const key = p + '-' + a;
        platformSizes[key] = files.filter((f) => f.platform === key || f.platform === 'all').reduce((s, f) => s + f.size, 0);
    }
    const manifest = {
        runtimeVersion: RUNTIME_VERSION, ortVersion: ORT_VERSION, license: 'MIT', partMaxBytes: PART_MAX,
        sources: {
            npm: { package: 'onnxruntime-node@' + ORT_VERSION, tarball: 'https://registry.npmjs.org/onnxruntime-node/-/onnxruntime-node-' + ORT_VERSION + '.tgz', integrity: opts.integrity || '', tgzBytes: opts.tgzBytes || null, note: 'npm 官方庫（來源 1）只提供 onnxruntime 相關檔（不含 nr-*.js）' },
            commonPackage: 'onnxruntime-common@' + ORT_VERSION + '（來源：本機既有安裝，見 DESIGN.TODO.native-runner.md 第 4 項）',
            github: { branch: 'native-runtime-1.22.0', commit: '', note: '來源 2：釘住 commit SHA 的 raw 網址；所有檔案都在這裡' },
        },
        platforms: platformSizes,
        files,
    };
    fs.writeFileSync(path.join(out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    return manifest;
}

function parseArgs(argv) {
    const a = { extract: null, common: null, out: null, repo: path.join(__dirname, '..'), tgz: null, integrity: null };
    const pos = [];
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--tgz') a.tgz = argv[++i];
        else if (argv[i] === '--integrity') a.integrity = argv[++i];
        else pos.push(argv[i]);
    }
    [a.extract, a.common, a.out] = pos;
    if (!a.out) throw new Error('用法：node scripts/native-runtime-freeze.js <抽取資料夾> <common 資料夾> <輸出資料夾> [--tgz] [--integrity]');
    if (a.tgz) a.tgzBytes = fs.statSync(a.tgz).size;
    return a;
}

if (require.main === module) {
    const o = parseArgs(process.argv.slice(2));
    const m = freeze(o);
    const total = Object.values(m.platforms);
    console.log('分割包已建立：' + m.files.length + ' 個檔案，' + m.files.reduce((s, f) => s + f.parts.length, 0) + ' 段；各平台大小（位元組）：' + JSON.stringify(m.platforms));
}

module.exports = { freeze, collect, PART_MAX, RUNTIME_VERSION, ORT_VERSION, PLATFORMS };
