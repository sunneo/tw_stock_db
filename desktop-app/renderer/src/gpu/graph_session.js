'use strict';
// ORT 相容的「cudaweb 圖形 session」（DESIGN.webgpu-cuda.md §7.25）：把 ONNX 圖交給 onnx_interp 逐節點執行，Conv／ConvTranspose／大的 MatMul 走 GPU（T1 WGSL → cpu-js），其餘算子在 CPU。
// 介面刻意貼近 onnxruntime 的 InferenceSession（產品的 audio_runtime／SDXS／Kokoro 呼叫端都只用 inputNames、outputNames、run(feeds)→{名稱: {type,data,dims}}）。
//   create(bytes, { dataFiles, ops, minMacs, TensorCtor }) → { inputNames, outputNames, run(feeds), info }
//   feeds 值：{ type:'float32'|'int64'|'int32'|'bool', data, dims }（ORT Tensor 即可）；輸出同形（有 TensorCtor 就用它建，讓呼叫端拿到真的 ort Tensor）。
//   info：{ runs, ms, nodes, gpuNote }；任何不支援的算子由 run 丟錯（呼叫端退回原 session，不偷偷略過）。
const lite = require('./onnx_lite.js');
const I = require('./onnx_interp.js');

function toInternal(t) {
  const n = t.data.length;
  if (t.type === 'float32') return { d: Array.from(t.dims), t: 'f', v: t.data instanceof Float32Array ? t.data : Float32Array.from(t.data) };
  if (t.type === 'int64' || t.type === 'int32') { const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = Number(t.data[i]); return { d: Array.from(t.dims), t: 'i', v }; }
  if (t.type === 'bool') { const v = new Uint8Array(n); for (let i = 0; i < n; i++) v[i] = t.data[i] ? 1 : 0; return { d: Array.from(t.dims), t: 'b', v }; }
  throw new Error('graph_session：不支援的輸入型別 ' + t.type);
}
function toExternal(x, Ctor) {
  let type, data;
  if (x.t === 'f') { type = 'float32'; data = x.v; }
  else if (x.t === 'b') { type = 'bool'; data = x.v; }
  else { type = 'int64'; data = Ctor ? BigInt64Array.from(x.v, (q) => BigInt(Math.trunc(q))) : x.v; }
  return Ctor ? new Ctor(type, data, x.d) : { type, data, dims: x.d.slice() };
}
function create(bytes, o) {
  const opt = o || {}, model = lite.parseModel(bytes), inits = new Set(Object.keys(model.inits || {}));
  const inputNames = model.inputs.map((i) => i.name || i).filter((n) => !inits.has(n)), outputNames = model.outputs.slice();
  const initCache = Object.create(null);   // 初始值只解碼一次（session 活著期間常駐；release 時清掉）
  const info = { runs: 0, ms: 0, nodes: model.nodes.length, lastError: '' };
  const gpu = opt.ops === false ? null : { ops: opt.ops || {}, minMacs: opt.minMacs, tiers: {} }; info.tiers = gpu ? gpu.tiers : null;
  return {
    inputNames, outputNames, info,
    async run(feeds) {
      const t0 = Date.now(), f = {};
      for (const n of Object.keys(feeds)) f[n] = toInternal(feeds[n]);
      let r; try { r = await I.run(model, f, opt.dataFiles || {}, { gpu, initCache }); } catch (e) { info.lastError = String((e && e.message) || e); throw e; }
      const out = {}; for (const n of outputNames) out[n] = toExternal(r[n], opt.TensorCtor);
      info.runs++; info.ms += Date.now() - t0; return out;
    },
    release() { for (const k of Object.keys(initCache)) delete initCache[k]; },
  };
}
// GPU 實際用上了嗎：T1 是 WGSL；cpu-int（權重太大，刻意用精確的 CPU 整數參考）不算退層；其餘（cpu-js 等）是 GPU 失敗退層。退層比例 < 20% 且至少有一個 T1 才算
function gpuShare(tiers) {
  let t1 = 0, fb = 0, byDesign = 0; for (const l of Object.keys(tiers || {})) { if (/^T1/.test(l)) t1 += tiers[l]; else if (/^cpu-int/.test(l)) byDesign += tiers[l]; else fb += tiers[l]; }
  return { t1, fallback: fb, byDesign, ok: t1 > 0 && fb / (t1 + fb) < 0.2 };
}
// 把一個現成的 ORT 風格 session（例如 transformers.js／kokoro-js 內部的 session）的 run 換成圖形 session 的 GPU 版：
// 回傳的張量用「第一個輸入張量的建構子」建（還給 transformers.js 的必須是它自己的 ort Tensor）；執行失敗、GPU 退層超過 20%、輸出含 NaN／無限大都永久改回原 run，原因寫進 stat.fellBack 並呼叫 say。
function attachRun(sess, gs, o) {
  const opt = o || {}, say = opt.say || (() => {}), origRun = sess.run.bind(sess); let gpu = true; const stat = { runs: 0, ms: 0, fellBack: '', tiers: null };
  sess.run = async (feeds) => {
    if (gpu) {
      try {
        const t0 = Date.now(), names = Object.keys(feeds), Ctor = feeds[names[0]].constructor, out = await gs.run(feeds), sh = gpuShare(gs.info.tiers);
        stat.runs++; stat.ms += Date.now() - t0; stat.tiers = Object.assign({}, gs.info.tiers);
        if (!sh.ok) throw new Error('重運算沒有跑在 GPU：' + JSON.stringify(gs.info.tiers));
        const r = {}; for (const k of Object.keys(out)) { const d = out[k].data; if (d instanceof Float32Array) for (let i = 0; i < d.length; i += 53) if (!Number.isFinite(d[i])) throw new Error('輸出 ' + k + ' 含 NaN／無限大'); r[k] = new Ctor(out[k].type, out[k].data, out[k].dims); }
        return r;
      } catch (e) { gpu = false; stat.fellBack = String((e && e.message) || e).slice(0, 200); say('GPU 執行失敗，已退回原路徑：' + stat.fellBack); }
    }
    return origRun(feeds);
  };
  const h = { get gpu() { return gpu; }, stat }; sess.__faGpu = h; return h;
}
module.exports = { create, toInternal, toExternal, gpuShare, attachRun };
