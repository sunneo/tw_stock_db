// 執行包按需安裝的本機測試（假來源：檔案路徑）。用法：ELECTRON_RUN_AS_NODE=1 electron.exe scripts/eval/native_runtime_install_test.js <分割包資料夾> <tgz> <測試暫存資料夾> <本機對照安裝 ort-node-test122>
// 驗證：(1) 來源 1（npm tgz）與來源 2（分割段）取得的每個檔案 sha256 相同；(2) npm 不可用、integrity 錯誤時改走來源 2 並記下原因；
// (3) 安裝後的 onnxruntime 檔與本機對照安裝的 sha256 相同。
'use strict';
const fs = require('fs');
const path = require('path');
const { installRuntime, localFetchBytes, sha256 } = require(path.join(__dirname, '..', '..', 'main-ext.js'))._NRI;

const [, , PACK, TGZ, WORK, REF] = process.argv;
const manifest = JSON.parse(fs.readFileSync(path.join(PACK, 'manifest.json'), 'utf8'));
const PLATFORM = 'win32-x64';
const results = { checks: [] };
const ck = (name, ok, extra) => results.checks.push({ name, ok: !!ok, extra: extra === undefined ? null : extra });

async function run(label, o) {
    const logs = [];
    const r = await installRuntime(Object.assign({
        manifest, platformKey: PLATFORM, githubBase: PACK, fetchBytes: localFetchBytes, timeoutMs: 60000,
        runtimeDir: path.join(WORK, label, 'native-runtime', manifest.runtimeVersion), nrSourceDir: path.join(__dirname, '..', '..'),
        log: (s) => logs.push(s),
    }, o));
    return { r, logs };
}

(async () => {
    fs.rmSync(WORK, { recursive: true, force: true });
    const A = await run('A-npm', { npmLocation: TGZ });
    ck('A：npm 來源可用，安裝成功', A.r.ok && A.r.npmUsed, A.r.why || null);
    const B = await run('B-github', { forceGithub: true });
    ck('B：強制來源 2（分割段）安裝成功', B.r.ok, B.r.why || null);
    const files = manifest.files.filter((f) => f.platform === PLATFORM || f.platform === 'all');
    const diff = [];
    for (const f of files) {
        const a = path.join(A.r.runtimeDir || '', ...f.path.split('/'));
        const b = path.join(B.r.runtimeDir || '', ...f.path.split('/'));
        const sa = fs.existsSync(a) ? sha256(fs.readFileSync(a)) : 'missing';
        const sb = fs.existsSync(b) ? sha256(fs.readFileSync(b)) : 'missing';
        if (sa !== sb || sa !== f.sha256) diff.push(f.path);
    }
    ck('A 與 B：每個檔案的 sha256 相同（同時等於分割包清單）', diff.length === 0 && files.length > 0, { files: files.length, diff });
    const sourcesA = A.r.sourcesUsed || {};
    const npmFiles = Object.keys(sourcesA).filter((k) => sourcesA[k] === 'npm').length;
    const ghFiles = Object.keys(sourcesA).filter((k) => sourcesA[k] === 'github').length;
    ck('A：onnxruntime 檔來自 npm，common 與子程序程式來自來源 2', npmFiles > 0 && ghFiles > 0, { npmFiles, ghFiles });
    const C = await run('C-npm-down', { npmLocation: path.join(WORK, 'no-such-file.tgz') });
    ck('C：npm 不可用時改走來源 2，原因寫進 log', C.r.ok && !C.r.npmUsed && C.logs.some((s) => /切換到來源 2.*npm 連線失敗/.test(s)), C.logs.join(' | ').slice(0, 300));
    const bad = Object.assign({}, manifest, { sources: Object.assign({}, manifest.sources, { npm: Object.assign({}, manifest.sources.npm, { integrity: 'sha512-AAAA' }) }) });
    const D = await run('D-bad-integrity', { npmLocation: TGZ, manifest: bad });
    ck('D：npm integrity 錯誤時改走來源 2，原因寫進 log', D.r.ok && !D.r.npmUsed && D.logs.some((s) => /integrity.*驗證失敗/.test(s)), D.logs.join(' | ').slice(0, 300));
    const refDir = path.join(REF, 'node_modules', 'onnxruntime-node');
    const cmp = [['bin/napi-v6/win32/x64/onnxruntime.dll', path.join(refDir, 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime.dll')],
        ['bin/napi-v6/win32/x64/onnxruntime_binding.node', path.join(refDir, 'bin', 'napi-v6', 'win32', 'x64', 'onnxruntime_binding.node')]];
    for (const [rel, refPath] of cmp) {
        const inst = path.join(A.r.runtimeDir, 'node_modules', 'onnxruntime-node', ...rel.split('/'));
        ck('安裝後的 ' + rel + ' 與本機對照安裝 sha256 相同', fs.existsSync(inst) && sha256(fs.readFileSync(inst)) === sha256(fs.readFileSync(refPath)));
    }
    results.pass = results.checks.every((c) => c.ok);
    results.runtimeDirA = A.r.runtimeDir || null;
    console.log('[install-test] ' + JSON.stringify(results));
    process.exit(0);
})().catch((e) => { console.log('[install-test] 失敗 ' + String((e && e.stack) || e).slice(0, 500)); process.exit(1); });
