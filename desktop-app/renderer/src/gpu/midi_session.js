'use strict';
// midigenai 解碼器的「假 ORT session」：把 midi_decoder.js（CPU 參考＋WebGPU 的 MatMulNBits 投影）包成 midigen-web.mjs 的 cpuStep 看得懂的 session。
// 契約（見 renderer/vendor/midigenai/midigen-web.mjs 的 cpuStep）：run({ ids int64[1,T], past_k0, past_v0, … 時間優先 [1,P,H,D] }) → { logits（最後位置，[1,V]）, new_k0, new_v0, … 新的 T 列 [1,T,H,D] }。
// 內部自己留 KV 快取（decode 用 H×L×HD 佈局），只有在長度對不上（例如另一次生成從 P=0 開始，或外部重放）時才從 feeds 重建。
// decodeFn(ids:number[], cache|null) → Promise<{ logits:Float32Array, cache:[{K,V,L}] }>：預設是 midi_decoder.decode(model, ids, cache, mm)；測試可注入。
// 任何錯誤原樣丟出，由呼叫端（floating-assistant.js 的 _midigenEngine，開關 midiGpu）處理退回。
function createSession(o) {
  const ort = o.ort, H = o.nHeads || 12, D = o.headDim || 64, NL = o.nLayers || 12, ROW = H * D, V = o.vocab || 598, decodeFn = o.decodeFn;
  const names = []; for (let i = 0; i < NL; i++) for (const c of 'kv') names.push([`past_${c}${i}`, `new_${c}${i}`, i, c]);
  let cache = null, steps = 0;
  const fromFeeds = (feeds, P) => { // 時間優先 [P,H,D] → H×P×D
    return Array.from({ length: NL }, (_, i) => {
      const K = new Float32Array(H * P * D), Vv = new Float32Array(H * P * D), sk = feeds[`past_k${i}`].data, sv = feeds[`past_v${i}`].data;
      for (let t = 0; t < P; t++) for (let h = 0; h < H; h++) for (let d = 0; d < D; d++) { K[(h * P + t) * D + d] = sk[(t * H + h) * D + d]; Vv[(h * P + t) * D + d] = sv[(t * H + h) * D + d]; }
      return { K, V: Vv, L: P };
    });
  };
  return {
    inputNames: ['ids'].concat(names.map((n) => n[0])), outputNames: ['logits'].concat(names.map((n) => n[1])), backend: 'cudaweb',
    get steps() { return steps; },
    async run(feeds) {
      const idt = feeds.ids, ids = Array.from(idt.data, (x) => Number(x)), T = ids.length, P = feeds.past_k0.dims[1];
      if (P === 0) cache = null; else if (!cache || cache[0].L !== P) cache = fromFeeds(feeds, P);
      const r = await decodeFn(ids, cache); cache = r.cache; steps++;
      const out = { logits: new ort.Tensor('float32', Float32Array.from(r.logits), [1, V]) };
      const Ln = P + T;
      for (const [, nn, li, c] of names) { // H×Ln×D 的最後 T 列 → 時間優先 [T,H,D]
        const src = c === 'k' ? r.cache[li].K : r.cache[li].V, rows = new Float32Array(T * ROW);
        for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) rows.set(src.subarray((h * Ln + P + t) * D, (h * Ln + P + t + 1) * D), (t * H + h) * D);
        out[nn] = new ort.Tensor('float32', rows, [1, T, H, D]);
      }
      return out;
    },
    async release() { cache = null; },
  };
}
module.exports = { createSession };
