// node renderer/src/gpu/kir_host_hooks_test.js — KIR 主機掛鉤的後端選擇（WebGPU → WebGL2 → JS）與每一步的具體原因。
// 裝置用假的（stub）：這裡只測選擇與退路，不測 GPU。真 GPU 的端到端在 scripts/eval/llc_kir_e2e.eval.js。
const H = require('./kir_host_hooks.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 240) : '')); };

const stubDev = () => ({ alloc: () => ({}), upload: () => {}, download: async () => new Float32Array(0), dispatch: () => {}, free: () => {} });
const glOk = { getContext: () => ({ fake: 'gl' }) };
const mods = (over) => Object.assign({ FaKir: { validate: () => ({ ok: true }) }, FaKirGen: { toWgsl: () => ({ ok: true }), toGlsl: () => ({ ok: true }) },
    FaKirWebGL2: { supportsWebGL2: () => true, createDevice: () => stubDev(), runGl: () => ({ out: {} }) },
    FaKirWebGPU: { createDevice: () => stubDev() }, FaClFront: { parseKernels: () => ({ ok: true, kernels: [] }) } }, over || {});
const gpuNav = (adapter) => ({ gpu: { requestAdapter: async () => adapter } });
const adapterOk = { requestDevice: async () => ({ fake: 'gdev' }) };

(async () => {
    // 1. 沒有 JSPI：WebGPU 不啟用，原因寫清楚；WebGL2 可用就用它
    {
        const r = await H.setup({ mods: mods(), nav: gpuNav(adapterOk), makeCanvas: () => ({ getContext: () => glOk.getContext() }), jspi: false });
        check('無 JSPI：不用 WebGPU、用 WebGL2', r.backend === 'webgl2', r.backend);
        check('無 JSPI：原因寫出 JSPI', /JSPI/.test(r.reasons.webgpu || ''), r.reasons);
        check('無 JSPI：WebGL2 的掛鉤是同步的（asyncReadback 為假、kirRun 有）', r.hooks.asyncReadback === false && typeof r.hooks.kirRun === 'function' && r.hooks.kirBackend === 'webgl2');
        check('describe 說明實際後端與 WebGPU 未使用的原因', /WebGL2/.test(r.describe()) && /JSPI/.test(r.describe()), r.describe());
    }
    // 2. 有 JSPI 但沒有介面卡：原因是 requestAdapter 回傳空值
    {
        const r = await H.setup({ mods: mods(), nav: gpuNav(null), makeCanvas: () => glOk, jspi: true });
        check('介面卡為空：原因寫出 requestAdapter', /requestAdapter/.test(r.reasons.webgpu || ''), r.reasons);
        check('介面卡為空：退回 WebGL2', r.backend === 'webgl2');
    }
    // 3. 有 JSPI、有介面卡：選 WebGPU；讀回非同步；kirRun 不給（同步的 WebGL2 才有）；派送計數算到 webgpu
    {
        const r = await H.setup({ mods: mods(), nav: gpuNav(adapterOk), makeCanvas: () => glOk, jspi: true });
        check('有 WebGPU：選 webgpu', r.backend === 'webgpu', r.backend);
        check('有 WebGPU：asyncReadback 為真、kirRun 不給、kirBackend 為 webgpu', r.hooks.asyncReadback === true && r.hooks.kirRun === null && r.hooks.kirBackend === 'webgpu');
        r.hooks.kirDev.dispatch({ name: 'k' }, {}, {}, {}, 1);
        check('派送計數記在 webgpu', r.stats().byBackend.webgpu === 1 && r.stats().dispatches === 1, r.stats());
        const d = await r.hooks.kirDev.download({});
        check('download 回傳 Promise（非同步）', d instanceof Float32Array);
    }
    // 4. WebGPU 初始化丟錯：原因是具體的錯誤訊息，退回 WebGL2
    {
        const nav = { gpu: { requestAdapter: async () => ({ requestDevice: async () => { throw new Error('裝置被拒絕'); } }) } };
        const r = await H.setup({ mods: mods(), nav, makeCanvas: () => glOk, jspi: true });
        check('requestDevice 失敗：原因含錯誤訊息', /裝置被拒絕/.test(r.reasons.webgpu || ''), r.reasons);
        check('requestDevice 失敗：退回 WebGL2', r.backend === 'webgl2');
    }
    // 5. 沒有 WebGL2 也沒有 WebGPU：JS 墊片，掛鉤是空的（host 全部用 JS）
    {
        const r = await H.setup({ mods: mods({ FaKirWebGL2: { supportsWebGL2: () => false } }), nav: null, makeCanvas: () => glOk, jspi: false });
        check('全部沒有：backend 是 js 且掛鉤為空', r.backend === 'js' && Object.keys(r.hooks).length === 0, r.backend);
        check('全部沒有：describe 寫出 JS 墊片與 WebGL2 原因', /JS 墊片/.test(r.describe()) && /EXT_color_buffer_float/.test(r.describe()), r.describe());
    }
    // 6. 沒有嵌入 KIR 模組：JS
    {
        const r = await H.setup({ mods: {}, nav: null, makeCanvas: () => glOk, jspi: true });
        check('沒有 KIR 模組：js', r.backend === 'js' && /沒有嵌入/.test(r.reasons.webgpu), r.reasons);
    }
    // 7. 翻譯：WebGPU 後端用 toWgsl 過濾，WebGL2 用 toGlsl 過濾
    {
        let asked = null;
        const m = mods({ FaKirGen: { toWgsl: () => { asked = 'wgsl'; return { ok: true }; }, toGlsl: () => { asked = 'glsl'; return { ok: false }; } }, FaClFront: { parseKernels: () => ({ ok: true, kernels: [{ name: 'vadd' }] }) } });
        const r = await H.setup({ mods: m, nav: gpuNav(adapterOk), makeCanvas: () => glOk, jspi: true });
        const t = r.hooks.kirTranslate('x');
        check('WebGPU 翻譯用 WGSL 檢查', asked === 'wgsl' && t && t.vadd, { asked, t });
    }
    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'kir_host_hooks: ' + ok + ' passed');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAILED (exception): ' + (e && e.stack || e)); process.exit(1); });
