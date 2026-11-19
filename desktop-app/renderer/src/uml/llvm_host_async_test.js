// node renderer/src/uml/llvm_host_async_test.js — llvm_host 的非同步讀回（WebGPU 裝置：讀回是 Promise，需要 JSPI）。
// 1. 一定跑：SIGS 的 async 旗標依 asyncReadback 設定，而且不改動全域的 SIGS；沒有 JSPI 時用到非同步的 OpenCL 程式會說清楚。
// 2. 只有 hasJspi 為真才跑：假的非同步裝置（讀回是手動推進的 Promise）＋真的 wasm，輸出要與 JS 後備一樣；fa_cl_backend 回報 3（WebGPU）。
// node 16 沒有 JSPI，所以 2 在 node 16 會略過（真正的端到端在真 Electron 的 scripts/eval/llc_kir_e2e.eval.js）。
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js');
const CF = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 240) : '')); };
const hasJspi = typeof WebAssembly.Suspending === 'function' && typeof WebAssembly.promising === 'function';
const memfs = new Map(); const fsx = { read: (p) => (memfs.has(p) ? memfs.get(p) : null), write: (p, b) => { memfs.set(p, new Uint8Array(b)); }, exists: (p) => memfs.has(p), remove: (p) => memfs.delete(p) };
const IR = fs.readFileSync(path.join(__dirname, '../examples/llc/gpgpu/opencl_vecadd.ll'), 'utf8');
const kirTranslate = (src) => { const r = CF.parseKernels(src); if (!r.ok) return null; const m = {}; for (const k of r.kernels) { if (!KIR.validate(k).ok) return null; m[k.name] = k; } return m; };

// 假的非同步裝置：alloc／upload／dispatch 都同步（JS 後端執行）；download 回傳 Promise，由 driver 手動推進
function asyncDevice(st) {
    const pend = [];
    const dev = {
        alloc: (N, elem) => { st.alloc++; return { N, elem, v: new Float32Array(N * (elem === 'f32x4' ? 4 : 1)) }; },
        upload: (b, arr) => { st.upload++; b.v.set(arr.subarray(0, b.v.length)); },
        download: (b) => { st.download++; return new Promise((res) => { pend.push(() => res(b.v.slice())); }); },
        dispatch: (k, binds, out, scal, N) => { st.dispatch++; const B = {}; for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? out.v : binds[p.name].v; KIR.runJs(k, B, scal, N); },
        free: () => {},
    };
    // driver：每隔一個宏任務解開一個等待中的讀回（模擬 mapAsync 完成）
    dev.drive = () => new Promise((resolve) => { const tick = () => { if (pend.length) { pend.shift()(); } if (st.download === st.resolved) return resolve(); st.resolved++; setTimeout(tick, 0); }; st.resolved = 0; tick(); });
    return dev;
}

(async () => {
    // 1. SIGS 旗標
    const before = H.SIGS.clEnqueueReadBuffer.async;
    const hA = H.create({ asyncReadback: true, kirDev: asyncDevice({ alloc: 0, upload: 0, download: 0, dispatch: 0 }), kirTranslate, kirBackend: 'webgpu' });
    const hB = H.create({});
    check('asyncReadback：clEnqueueReadBuffer 與 NDRange 標成 async', hA.SIGS.clEnqueueReadBuffer.async === true && hA.SIGS.clEnqueueNDRangeKernel.async === true);
    check('沒有 asyncReadback：不是 async', hB.SIGS.clEnqueueReadBuffer.async === false);
    check('全域 SIGS 沒有被改動', !H.SIGS.clEnqueueReadBuffer.async && !before);
    // 2. 沒有 JSPI 時，用到非同步主機函式會說清楚（不是默默壞掉）
    if (!hasJspi) {
        const st = { alloc: 0, upload: 0, download: 0, dispatch: 0 };
        const h = H.create({ asyncReadback: true, kirDev: asyncDevice(st), kirTranslate, kirBackend: 'webgpu' });
        h.install(L);
        let msg = '';
        try { const c = L.compileIr(IR, {}); const dec = {}; for (const d of L.parse(IR).mod.declares) dec[d.name] = d; await L.runHost(c.wasm, { args: ['prog', '8'] }, h.impls, undefined, dec); } catch (e) { msg = String((e && e.message) || e); }
        h.uninstall(L);
        check('沒有 JSPI：非同步的 OpenCL 程式說明需要 JSPI', /JSPI/.test(msg), msg);
    } else {
        // 3. 有 JSPI：真 wasm、假的非同步裝置，輸出與 JS 後備一樣；後端回報 3（WebGPU）
        const st = { alloc: 0, upload: 0, download: 0, dispatch: 0 };
        const dev = asyncDevice(st);
        const h = H.create({ asyncReadback: true, kirDev: dev, kirTranslate, kirBackend: 'webgpu', gui: async () => null, fs: fsx });
        h.install(L);
        const c = L.compileIr(IR, {}); const dec = {}; for (const d of L.parse(IR).mod.declares) dec[d.name] = d;
        const run = L.runHost(c.wasm, { args: ['prog', '1000'] }, h.impls, undefined, dec);
        const driver = dev.drive();
        const o = await run; await driver; h.uninstall(L);
        check('非同步讀回：輸出正確（vadd OK, n=1000 c=2997）', o.stdout === 'vadd OK, n=1000 c=2997.000000\n' && o.exitCode === 0, { out: o.stdout, st });
        check('非同步讀回：一次派送、讀回 c 一次', st.dispatch === 1 && st.download === 1, st);
        check('fa_cl_backend 回報 3（WebGPU）', h.impls.fa_cl_backend() === 3, h.impls.fa_cl_backend());
    }
    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'llvm_host_async: ' + ok + ' passed' + (hasJspi ? '' : '（沒有 JSPI：真 wasm 那段略過）'));
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAILED (exception): ' + (e && e.stack || e)); process.exit(1); });
