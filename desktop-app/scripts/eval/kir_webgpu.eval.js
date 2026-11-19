// KIR 的 WebGPU 裝置層（真 GPU）：nbody3d_cl 與 fluid3d_cl 的核心，在 WebGPU 上的正確性（對 KIR 的 JS 後端）與每步耗時。
// 同一組核心也在 WebGL2 裝置（kir_webgl2.createDevice）上計時，CPU 參考是 KIR 的 JS 後端（不是 app 的 wasm 路徑）。
// 優化項目：(a) 工作群大小實測（候選 32／64／128／256，結果存 IndexedDB）；(d) 派送不讀回 vs 每步讀回。
// 由 scripts/eval/kir_webgpu.build.js 產生（內嵌 KIR 模組與 .ll 的 OpenCL 原始碼）。
// 執行：FA_EVAL_GL=gpu FA_EVAL_TIMEOUT_MS=600000 node scripts/eval/run_eval.js <輸出檔> [埠]
// 安全：每個核心只派送一次 N 個工作項（N＝3072 時一次約 1–5 ms）；每步計時前後都 await onSubmittedWorkDone；device.lost 記錄。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.webgpu); load(SRC.front);
const K = window.FaKir, FR = window.FaClFront, WGD = window.FaKirWebGPU, GLD = window.FaKirWebGL2;
const R = { errors: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' 超時 ' + ms + ' ms')), ms))]);

if (!navigator.gpu) return { error: 'navigator.gpu 不存在' };
const adapter = await navigator.gpu.requestAdapter();
if (!adapter) return { error: 'requestAdapter 回傳 null' };
R.adapter = { vendor: adapter.info && adapter.info.vendor, arch: adapter.info && adapter.info.architecture, fallback: !!adapter.isFallbackAdapter, subgroupsFeature: adapter.features.has('subgroups'), f16Feature: adapter.features.has('shader-f16') };
const gdev = await adapter.requestDevice();
let lostInfo = null; gdev.lost.then((i) => { lostInfo = (i.reason || '') + ':' + (i.message || ''); });
const dev = WGD.createDevice(gdev, { wg: 64 });

// 從 .ll 的 @cl_src 讀出的 OpenCL 原始碼（SRC.nbody、SRC.sph）→ KIR 核心（依名字）
const kmap = (src) => { const o = {}; for (const k of FR.parseKernels(src).kernels) o[k.name] = k; return o; };
const NB = kmap(SRC.nbody), SPH = kmap(SRC.sph);
R.kernels = { nbody: Object.keys(NB), sph: Object.keys(SPH) };

// IndexedDB 存放工作群的實測結果（換裝置要重測：金鑰含介面卡資訊）。失敗就 null（只是不快取）。
const store = await (async () => {
  try {
    const db = await new Promise((res, rej) => { const rq = indexedDB.open('kir-webgpu-eval', 1); rq.onupgradeneeded = () => rq.result.createObjectStore('t'); rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });
    return {
      get: (k) => new Promise((res, rej) => { const q = db.transaction('t').objectStore('t').get(k); q.onsuccess = () => res(q.result || null); q.onerror = () => rej(q.error); }),
      set: (k, v) => new Promise((res, rej) => { const tx = db.transaction('t', 'readwrite'); tx.objectStore('t').put(v, k); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); })
    };
  } catch (e) { R.errors.push('IndexedDB：' + e.message); return null; }
})();
const adapterKey = [R.adapter.vendor, R.adapter.arch, R.adapter.subgroupsFeature ? 'sg' : 'nosg'].join('/');

// 一組「步」的定義：核心依序執行，共用的緩衝區依名字連起來（例如 krho 的輸出 rho 是 kfx 的輸入）
const scalarVal = (name, N) => (name === 'n' || name === 'm' ? N : 0.05);
const rnd = (() => { let s = 7; return () => ((s = (s * 1103515245 + 12345) >>> 0) / 4294967296); })();
function makeData(kernels, N) {
  const arrs = {}, elems = {};
  for (const k of kernels) for (const p of k.params) if (p.ptr || p.kind === 'buf') {
    const elem = p.elem || (p.type === 'float4' ? 'f32x4' : 'f32');
    if (arrs[p.name]) continue;
    const n = N * (elem === 'f32x4' ? 4 : 1), a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = 0.1 + 0.9 * rnd();
    arrs[p.name] = a; elems[p.name] = elem;
  }
  return { arrs, elems };
}
// KIR 核心的 buffer 參數（來自 cl_front 的解析結果）；cl_front 的參數格式：{ name, ptr, type, ... }
const bufParams = (k) => k.params.filter((p) => p.ptr || p.kind === 'buf');
const scalParams = (k) => k.params.filter((p) => !(p.ptr || p.kind === 'buf'));
const toKir = (k) => K.validate(k);   // 核心必須已是 KIR（cl_front 的 parseKernels 已經是 KIR）

function kirElem(p) { return p.elem || (p.type === 'float4' ? 'f32x4' : 'f32'); }
function refStep(kernels, data, N) {
  // CPU 參考：KIR 的 JS 後端，依序執行；共用 name → 陣列
  const B = {};
  for (const k of kernels) for (const p of bufParams(k)) B[p.name] = B[p.name] || data.arrs[p.name].slice();
  for (const k of kernels) {
    const bufs = {}; for (const p of bufParams(k)) bufs[p.name] = B[p.name];
    const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name, N);
    K.runJs(k, bufs, S, N);
  }
  return B;
}

async function devStep(devLayer, kernels, shared, N, wg, readback) {
  // 派送整步；readback＝true 時每步讀回所有 out（每幀讀回的成本）
  const outs = [];
  for (const k of kernels) {
    const binds = {}; let outName = null;
    for (const p of bufParams(k)) {
      binds[p.name] = shared[p.name];
      if (p.access === 'out') outName = p.name;
    }
    const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name, N);
    devLayer.dispatch(k, binds, binds[outName], S, N);
    outs.push(outName);
  }
  if (readback) for (const n of outs) await devLayer.download(shared[n]);
}

async function runFamily(label, kernels, N, steps, warm) {
  const out = { label, N };
  for (const k of kernels) dev.setTiling(k, false);   // 「未分塊」的變體要明確關掉（裝置預設是分塊）
  const data = makeData(kernels, N);
  // 形狀要先在 WebGPU 上建好；每個 buffer name 一塊
  const shared = {};
  for (const k of kernels) for (const p of bufParams(k)) if (!shared[p.name]) shared[p.name] = dev.alloc(N, kirElem(p));
  for (const name of Object.keys(shared)) dev.upload(shared[name], data.arrs[name]);
  // 正確性：完整一步後，每個 out 讀回與 CPU 參考比對
  const ref = refStep(kernels, data, N);
  await devStep(dev, kernels, shared, N, dev.wgFor(kernels[0]), false);
  await dev.sync();
  out.correct = {};
  for (const k of kernels) for (const p of bufParams(k)) if (p.access === 'out') {
    const got = await dev.download(shared[p.name]);
    let m = 0, rmax = 0; const want = ref[p.name];
    for (let i = 0; i < want.length; i++) { const d = Math.abs(got[i] - want[i]); if (d > m) m = d; const r = Math.abs(want[i]) || 1; if (d / r > rmax) rmax = d / r; }
    out.correct[p.name] = { maxAbs: +m.toExponential(3), maxRel: +rmax.toExponential(3), n: want.length };
  }
  // 計時：每個變體各自 steps 步（warm 步不計）
  const time = async (wg, readback) => {
    if (wg > 0) for (const k of kernels) dev.setWorkgroup(k, wg);   // wg＜0：沿用自適應實測的結果（ensureTuned 已設定）
    for (let i = 0; i < warm; i++) await devStep(dev, kernels, shared, N, wg, readback);
    await dev.sync();
    const t0 = performance.now();
    for (let i = 0; i < steps; i++) await devStep(dev, kernels, shared, N, wg, readback);
    await dev.sync();
    return (performance.now() - t0) / steps;
  };
  out.webgpu_wg64_noreadback_ms = +(await time(64, false)).toFixed(3);
  out.webgpu_wg64_readback_ms = +(await time(64, true)).toFixed(3);
  // (a) 工作群自適應：每個核心各自實測（第一個核心的結果代表整步；其餘核心也各自存）
  out.tune = {};
  for (const k of kernels) {
    const r = await withTimeout(dev.ensureTuned(k, N, { store, adapterKey, scalars: Object.fromEntries(scalParams(k).map((p) => [p.name, scalarVal(p.name, N)])), reps: 4 }), 60000, 'tune ' + k.name);
    out.tune[k.name] = { best: r.best, cached: r.cached, times: r.times ? Object.fromEntries(Object.entries(r.times).map(([w, t]) => [w, +t.toFixed(3)])) : null };
  }
  out.webgpu_tuned_noreadback_ms = +(await time(-1, false)).toFixed(3);
  out.webgpu_tuned_readback_ms = +(await time(-1, true)).toFixed(3);
  // (c/b) 分塊版（workgroup 共享記憶體）：先正確性（對 CPU 參考），再計時（wg 64 固定與自適應）
  for (const k of kernels) dev.setTiling(k, true);
  await devStep(dev, kernels, shared, N, 64, false); await dev.sync();
  out.correct_tiled = {};
  for (const k of kernels) for (const p of bufParams(k)) if (p.access === 'out') {
    const got = await dev.download(shared[p.name]);
    let m = 0, rmax = 0; const want = ref[p.name];
    for (let i = 0; i < want.length; i++) { const d = Math.abs(got[i] - want[i]); if (d > m) m = d; const r = Math.abs(want[i]) || 1; if (d / r > rmax) rmax = d / r; }
    out.correct_tiled[p.name] = { maxAbs: +m.toExponential(3), maxRel: +rmax.toExponential(3), n: want.length };
  }
  out.tiled_wg64_noreadback_ms = +(await time(64, false)).toFixed(3);
  out.tiled_wg64_readback_ms = +(await time(64, true)).toFixed(3);
  out.tune_tiled = {};
  for (const k of kernels) {
    const r = await withTimeout(dev.ensureTuned(k, N, { store, adapterKey, scalars: Object.fromEntries(scalParams(k).map((p) => [p.name, scalarVal(p.name, N)])), reps: 4 }), 60000, 'tune tiled ' + k.name);
    out.tune_tiled[k.name] = { best: r.best, cached: r.cached, times: r.times ? Object.fromEntries(Object.entries(r.times).map(([w, t]) => [w, +t.toFixed(3)])) : null };
  }
  out.tiled_tuned_noreadback_ms = +(await time(-1, false)).toFixed(3);
  out.tiled_tuned_readback_ms = +(await time(-1, true)).toFixed(3);
  // (c) 內層迴圈展開 4 次（分塊版，wg 64 固定；與展開 1 比較）
  for (const k of kernels) dev.setTiling(k, 4);
  await devStep(dev, kernels, shared, N, 64, false); await dev.sync();
  out.correct_tiled_u4 = {};
  for (const k of kernels) for (const p of bufParams(k)) if (p.access === 'out') {
    const got = await dev.download(shared[p.name]);
    let m = 0; const want = ref[p.name];
    for (let i = 0; i < want.length; i++) m = Math.max(m, Math.abs(got[i] - want[i]));
    out.correct_tiled_u4[p.name] = { maxAbs: +m.toExponential(3), n: want.length };
  }
  out.tiled_u4_wg64_noreadback_ms = +(await time(64, false)).toFixed(3);
  out.tiled_u4_wg64_readback_ms = +(await time(64, true)).toFixed(3);
  for (const k of kernels) dev.setTiling(k, false);
  // CPU（KIR JS，單執行緒）：每步 steps 次太慢時只跑 2 次
  const cpuSteps = 2, B = {}; for (const k of kernels) for (const p of bufParams(k)) B[p.name] = B[p.name] || data.arrs[p.name].slice();
  const t0 = performance.now();
  for (let i = 0; i < cpuSteps; i++) {
    for (const k of kernels) { const bufs = {}; for (const p of bufParams(k)) bufs[p.name] = B[p.name]; const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name, N); K.runJs(k, bufs, S, N); }
  }
  out.cpu_kirjs_ms = +((performance.now() - t0) / cpuSteps).toFixed(1);
  // 清理
  for (const b of Object.values(shared)) dev.free(b);
  return out;
}

// WebGL2 裝置（同一組核心，離屏 context；只計時，每步 gl.finish）
const glDev = await (async () => {
  try {
    const cv = new OffscreenCanvas(8, 8); const gl = cv.getContext('webgl2');
    return gl ? GLD.createDevice(gl) : null;
  } catch (e) { R.errors.push('WebGL2：' + e.message); return null; }
})();
async function runWebgl2(kernels, N, steps, warm) {
  const data = makeData(kernels, N), shared = {};
  for (const k of kernels) for (const p of bufParams(k)) if (!shared[p.name]) shared[p.name] = glDev.alloc(N, kirElem(p));
  for (const name of Object.keys(shared)) glDev.upload(shared[name], data.arrs[name]);
  const step = () => { for (const k of kernels) { const binds = {}; let on = null; for (const p of bufParams(k)) { binds[p.name] = shared[p.name]; if (p.access === 'out') on = p.name; } const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name, N); glDev.dispatch(k, binds, binds[on], S, N); } };
  for (let i = 0; i < warm; i++) step();
  const t0 = performance.now();
  for (let i = 0; i < steps; i++) step();
  // 強制完成：讀回一個 texel 即可（readPixels 會等 GPU）
  glDev.download(shared[bufParams(kernels[kernels.length - 1]).find((p) => p.access === 'out').name]);
  const ms = (performance.now() - t0) / steps;
  for (const b of Object.values(shared)) glDev.free(b);
  return +ms.toFixed(3);
}

const NN = 3072, NF = 1000;
try { R.nbody = await runFamily('nbody3d_cl', ['accx', 'accy', 'accz', 'accpot'].map((n) => NB[n]).filter(Boolean), NN, 30, 3); }
catch (e) { R.errors.push('nbody：' + (e.stack || e.message).slice(0, 400)); }
try { R.fluid = await runFamily('fluid3d_cl', ['krho', 'kfx', 'kfy', 'kfz'].map((n) => SPH[n]).filter(Boolean), NF, 30, 3); }
catch (e) { R.errors.push('fluid：' + (e.stack || e.message).slice(0, 400)); }
if (glDev) {
  try { R.webgl2_nbody_ms = await runWebgl2(['accx', 'accy', 'accz', 'accpot'].map((n) => NB[n]).filter(Boolean), NN, 30, 3); } catch (e) { R.errors.push('webgl2 nbody：' + e.message); }
  try { R.webgl2_fluid_ms = await runWebgl2(['krho', 'kfx', 'kfy', 'kfz'].map((n) => SPH[n]).filter(Boolean), NF, 30, 3); } catch (e) { R.errors.push('webgl2 fluid：' + e.message); }
}
R.stats = { dispatches: dev.stats.dispatches, submits: dev.stats.submits, downloads: dev.stats.downloads, uploads: dev.stats.uploads, pipelines: dev.stats.pipelines, uncaptured: dev.stats.errors.slice(0, 5) };
R.lost = lostInfo || dev.lost || null;
console.log('KIR_WEBGPU ' + JSON.stringify(R));
return R;
