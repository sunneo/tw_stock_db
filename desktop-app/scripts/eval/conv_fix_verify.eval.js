// 評測 9（保留字修正後驗證）：單一 Conv（CPU 參考改用 ops.gpu=false 走真正的 CPU 路徑）（1 維，含 stride 與 pad）的正確性與速度。手寫最小 ONNX（一個 Conv 節點）。
//   GPU：cudaweb 圖形引擎（ops 開、minMacs=1）；CPU：ops=false。另外用獨立 JS 迴圈算參考值。
// 量：每個形狀的 GPU 首次／暖機時間、CPU 時間、與 CPU 的最大絕對誤差、GPU 輸出非零數、路由層。
// 守則：全新 --user-data-dir、最多兩次、不存檔設定。
const out = { cases: [] };
const a = window.desktopAPI;
const save = async () => { try { await a.rawfs.writeFile('E:/Temp/conv_fix_verify.json', { text: JSON.stringify(out, null, 2) }); } catch (_) { /* */ } };
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
// AttributeProto：name=1，type=20（INT=2、INTS=7），i=3，ints=8（重複、非打包）
function attrInts(name, vals) { let a2 = [...sf(1, name), ...iv(20, 7)]; for (const v of vals) a2 = a2.concat(iv(8, v)); return bf(5, a2); }
function attrInt(name, v) { return bf(5, [...sf(1, name), ...iv(20, 2), ...iv(3, v)]); }
function convModel(C, L, O, k, stride, pad) {
  const Lout = Math.floor((L + 2 * pad - k) / stride) + 1;
  const node = [...sf(1, 'x'), ...sf(1, 'w'), ...sf(2, 'z'), ...sf(3, 'cv'), ...sf(4, 'Conv'), ...attrInts('kernel_shape', [k]), ...attrInts('strides', [stride]), ...attrInts('pads', [pad, pad]), ...attrInts('dilations', [1]), ...attrInt('group', 1)];
  const graph = [...bf(1, node), ...sf(2, 'g'), ...bf(11, vinfo('x', [1, C, L])), ...bf(11, vinfo('w', [O, C, k])), ...bf(12, vinfo('z', [1, O, Lout]))];
  return { bytes: new Uint8Array([...iv(1, 8), ...bf(7, graph), ...bf(8, [...sf(1, ''), ...iv(2, 13)])]), Lout };
}
function rnd(n, seed) { const v = new Float32Array(n); let s = seed >>> 0; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; v[i] = (s / 4294967296) * 2 - 1; } return v; }
function refConv(x, w, C, L, O, k, stride, pad, Lout) {
  const z = new Float64Array(O * Lout);
  for (let o = 0; o < O; o++) for (let t = 0; t < Lout; t++) { let s = 0; for (let c = 0; c < C; c++) for (let j = 0; j < k; j++) { const p = t * stride + j - pad; if (p >= 0 && p < L) s += x[c * L + p] * w[(o * C + c) * k + j]; } z[o * Lout + t] = s; }
  return z;
}
try {
  if (!navigator.gpu) throw new Error('沒有 WebGPU');
  const ad = await navigator.gpu.requestAdapter();
  out.limits = { maxComputeInvocationsPerWorkgroup: ad.limits.maxComputeInvocationsPerWorkgroup, maxStorageBufferBindingSize: ad.limits.maxStorageBufferBindingSize };
  const M0 = window.fa._qwenModule();
  const cudaOps = { route: () => ({ backend: 'cudaweb', source: 'eval', reason: 'eval 強制' }), onRecord: () => {}, navigator: navigator };
  const cases = [[16, 256, 32, 3, 1, 1], [64, 1024, 128, 5, 1, 2], [128, 1024, 256, 3, 2, 1]];
  for (const [C, L, O, k, stride, pad] of cases) {
    const { bytes, Lout } = convModel(C, L, O, k, stride, pad);
    const x = rnd(C * L, 7 + C), w = rnd(O * C * k, 13 + O);
    const feeds = { x: { type: 'float32', data: x, dims: [1, C, L] }, w: { type: 'float32', data: w, dims: [O, C, k] } };
    const c = { C, L, O, k, stride, pad, Lout };
    try {
      const gg = M0.graph.create(bytes, { ops: cudaOps, minMacs: 1 });
      let t = Date.now(); await gg.run(feeds); c.gpuFirstSec = +((Date.now() - t) / 1000).toFixed(3);
      t = Date.now(); const r2 = await gg.run(feeds); c.gpuWarmSec = +((Date.now() - t) / 1000).toFixed(3);
      c.tiers = Object.assign({}, gg.info.tiers);
      const g = r2.z.data; let nz = 0; for (let i = 0; i < g.length; i++) if (g[i] !== 0) nz++;
      c.gpuNonZero = nz; c.gpuN = g.length;
      const cg = M0.graph.create(bytes, { ops: { gpu: false } });
      t = Date.now(); const rc = await cg.run(feeds); c.cpuSec = +((Date.now() - t) / 1000).toFixed(3);
      const ref = rc.z.data, ref2 = refConv(x, w, C, L, O, k, stride, pad, Lout);
      let mxErr = 0, mxRef = 0, mxCpuVsNaive = 0;
      for (let i = 0; i < g.length; i++) { const d = Math.abs(g[i] - ref[i]); if (d > mxErr) mxErr = d; const r = Math.abs(ref[i]); if (r > mxRef) mxRef = r; const d2 = Math.abs(ref2[i] - ref[i]); if (d2 > mxCpuVsNaive) mxCpuVsNaive = d2; }
      c.maxAbsErrVsCpu = mxErr; c.maxAbsCpu = mxRef; c.cpuVsNaive = mxCpuVsNaive;
    } catch (e) { c.error = String((e && e.message) || e).slice(0, 300); }
    out.cases.push(c); await save();
  }
} catch (e) { out.error = String((e && e.stack) || e); }
await save();
return out;
