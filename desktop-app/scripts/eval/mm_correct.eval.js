// 評測 4：單一 MatMul 的正確性與速度。手寫最小 ONNX（只有一個 MatMul 節點），同一組輸入：
//   GPU：cudaweb 圖形引擎（ops 開、minMacs=1 強制走 GPU）；CPU：ops=false（純 CPU 參考）。
// 量：每個形狀的 GPU 首次／暖機時間、CPU 時間、最大絕對誤差、GPU 輸出是否全 0、路由層（tiers）。
// 守則：全新 --user-data-dir、最多兩次、不存檔設定。
const out = { cases: [] };
const a = window.desktopAPI;
const save = async () => { try { await a.rawfs.writeFile('E:/Temp/mm_correct.json', { text: JSON.stringify(out, null, 2) }); } catch (_) { /* */ } };
// ---- 最小 protobuf 編碼（ModelProto → GraphProto → NodeProto，只給 MatMul 用） ----
function varint(n) { const o = []; while (n > 127) { o.push((n & 127) | 128); n = Math.floor(n / 128); } o.push(n); return o; }
function fld(f, w) { return varint((f << 3) | w); }
function bf(f, arr) { return [...fld(f, 2), ...varint(arr.length), ...arr]; }
function sf(f, s) { return bf(f, Array.from(new TextEncoder().encode(s))); }
function iv(f, v) { return [...fld(f, 0), ...varint(v)]; }
function vinfo(name, dims) {
  const shape = dims.flatMap((d) => bf(1, iv(1, d)));
  const tensor = [...iv(1, 1), ...bf(2, shape)];
  return [...sf(1, name), ...bf(2, bf(1, tensor))];
}
function matmulModel(M, K, N) {
  const node = [...sf(1, 'x'), ...sf(1, 'y'), ...sf(2, 'z'), ...sf(3, 'mm'), ...sf(4, 'MatMul')];
  const graph = [...bf(1, node), ...sf(2, 'g'), ...bf(11, vinfo('x', [M, K])), ...bf(11, vinfo('y', [K, N])), ...bf(12, vinfo('z', [M, N]))];
  return new Uint8Array([...iv(1, 8), ...bf(7, graph), ...bf(8, [...sf(1, ''), ...iv(2, 13)])]);
}
// ---- 輸入與 CPU 參考（獨立 JS 迴圈，不用 interp 的函式） ----
function rnd(n, seed) { const v = new Float32Array(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = (s / 4294967296) * 2 - 1; } return v; }
function refMM(x, y, M, K, N) { const z = new Float64Array(M * N); for (let i = 0; i < M; i++) for (let k = 0; k < K; k++) { const xv = x[i * K + k]; for (let j = 0; j < N; j++) z[i * N + j] += xv * y[k * N + j]; } return z; }
try {
  if (!navigator.gpu) throw new Error('沒有 WebGPU');
  const ad = await navigator.gpu.requestAdapter();
  out.limits = { maxComputeInvocationsPerWorkgroup: ad.limits.maxComputeInvocationsPerWorkgroup, maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize };
  // 用和正式路徑一樣的模組
  const M0 = window.fa._qwenModule();
  // 路由：強制 cudaweb（不走 ort 後端），與實際拆軌路由同一個 ops 形狀
  const cudaOps = { route: () => ({ backend: 'cudaweb', source: 'eval', reason: 'eval 強制' }), onRecord: () => {}, navigator: navigator };
  const shapes = [[64, 64, 64], [256, 256, 256], [512, 512, 512], [1024, 512, 256]];
  for (const [M, K, N] of shapes) {
    const bytes = matmulModel(M, K, N);
    const x = rnd(M * K, 11 + M), y = rnd(K * N, 23 + N);
    const feeds = { x: { type: 'float32', data: x, dims: [M, K] }, y: { type: 'float32', data: y, dims: [K, N] } };
    const c = { M, K, N };
    try {
      const gg = M0.graph.create(bytes, { ops: cudaOps, minMacs: 1 });
      let t = Date.now(); const r1 = await gg.run(feeds); c.gpuFirstSec = +((Date.now() - t) / 1000).toFixed(3);
      t = Date.now(); const r2 = await gg.run(feeds); c.gpuWarmSec = +((Date.now() - t) / 1000).toFixed(3);
      c.tiers = Object.assign({}, gg.info.tiers);
      const g = r2.z.data; let nz = 0; for (let i = 0; i < g.length; i++) if (g[i] !== 0) nz++;
      c.gpuNonZero = nz; c.gpuN = g.length;
      const cg = M0.graph.create(bytes, { ops: false });
      t = Date.now(); const rc = await cg.run(feeds); c.cpuSec = +((Date.now() - t) / 1000).toFixed(3);
      const ref = rc.z.data, ref2 = refMM(x, y, M, K, N);
      let mxErr = 0, mxRef = 0, mxErrRef = 0;
      for (let i = 0; i < g.length; i++) { const d = Math.abs(g[i] - ref[i]); if (d > mxErr) mxErr = d; const r = Math.abs(ref[i]); if (r > mxRef) mxRef = r; const d2 = Math.abs(ref2[i] - ref[i]); if (d2 > mxErrRef) mxErrRef = d2; }
      c.maxAbsErrVsCpu = mxErr; c.maxAbsCpu = mxRef; c.cpuVsNaive = mxErrRef;
    } catch (e) { c.error = String((e && e.message) || e).slice(0, 300); }
    out.cases.push(c); await save();
  }
} catch (e) { out.error = String((e && e.stack) || e); }
await save();
return out;
