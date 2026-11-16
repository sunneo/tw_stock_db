'use strict';
// midi_session：用假的 decodeFn（把「第幾個詞元」寫進 KV）驗證時間優先 ↔ H×L×D 佈局轉換、新列抽取、外部重放時的快取重建與 P=0 重置。
const assert = require('assert');
const S = require('./midi_session.js');
const H = 2, D = 3, NL = 2, ROW = H * D;
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
const ort = { Tensor };
// 假解碼：每個位置 t 的 K[h][d] = 100·layer + 10·t + h + d/10；V = −K。logits[0] = 這一步的最後 id
const fill = (li, t, h, d) => 100 * li + 10 * t + h + d / 10;
let calls = 0;
const decodeFn = async (ids, cache) => {
  calls++; const P = cache ? cache[0].L : 0, Ln = P + ids.length, out = [];
  for (let li = 0; li < NL; li++) {
    const K = new Float32Array(H * Ln * D), Vv = new Float32Array(H * Ln * D);
    for (let h = 0; h < H; h++) for (let t = 0; t < Ln; t++) for (let d = 0; d < D; d++) {
      if (t < P) { K[(h * Ln + t) * D + d] = cache[li].K[(h * P + t) * D + d]; Vv[(h * Ln + t) * D + d] = cache[li].V[(h * P + t) * D + d]; }
      else { K[(h * Ln + t) * D + d] = fill(li, t, h, d); Vv[(h * Ln + t) * D + d] = -fill(li, t, h, d); }
    }
    out.push({ K, V: Vv, L: Ln });
  }
  const lg = new Float32Array(5); lg[0] = ids[ids.length - 1]; return { logits: lg, cache: out };
};
const mk = () => S.createSession({ ort, nHeads: H, headDim: D, nLayers: NL, vocab: 5, decodeFn });
const empty = (n) => { const f = {}; for (let i = 0; i < NL; i++) for (const c of 'kv') f[`past_${c}${i}`] = new Tensor('float32', new Float32Array(0), [1, 0, H, D]); return f; };
const ids = (a) => new Tensor('int64', BigInt64Array.from(a, BigInt), [1, a.length]);
// 時間優先的快取累積器（跟 cpuStep 一樣把 new_* 接在後面）
function accumulate(bufs, out, P, T) { for (const k of Object.keys(bufs)) { const nb = new Float32Array((P + T) * ROW); nb.set(bufs[k]); nb.set(out['new_' + k.slice(5)].data, P * ROW); bufs[k] = nb; } }
(async () => {
  const s = mk(); assert.strictEqual(s.inputNames.length, 1 + 2 * NL); assert.strictEqual(s.outputNames[0], 'logits');
  const bufs = {}; for (const n of s.inputNames.slice(1)) bufs[n] = new Float32Array(0);
  const feeds = (a, P) => { const f = { ids: ids(a) }; for (const n of Object.keys(bufs)) f[n] = new Tensor('float32', bufs[n], [1, P, H, D]); return f; };
  let o = await s.run(feeds([7, 8, 9], 0)); accumulate(bufs, o, 0, 3);
  assert.strictEqual(o.logits.data[0], 9); assert.deepStrictEqual(o.logits.dims, [1, 5]); assert.deepStrictEqual(o.new_k0.dims, [1, 3, H, D]);
  for (let t = 0; t < 3; t++) for (let h = 0; h < H; h++) for (let d = 0; d < D; d++) { assert.ok(Math.abs(o.new_k1.data[(t * H + h) * D + d] - fill(1, t, h, d)) < 1e-5); assert.ok(Math.abs(o.new_v0.data[(t * H + h) * D + d] + fill(0, t, h, d)) < 1e-5); }
  o = await s.run(feeds([4], 3)); accumulate(bufs, o, 3, 1);
  assert.strictEqual(o.logits.data[0], 4); for (let h = 0; h < H; h++) for (let d = 0; d < D; d++) assert.ok(Math.abs(o.new_k0.data[h * D + d] - fill(0, 3, h, d)) < 1e-5);
  // 外部重放：新 session（沒有內部快取）收到 P=4 的 feeds → 從 feeds 重建，再接一步，位置 4 的新列正確，且舊列沒被弄亂
  const s2 = mk(); o = await s2.run(feeds([5], 4)); accumulate(bufs, o, 4, 1);
  for (let t = 0; t < 5; t++) for (let h = 0; h < H; h++) for (let d = 0; d < D; d++) assert.ok(Math.abs(bufs.past_k1[(t * H + h) * D + d] - fill(1, t, h, d)) < 1e-5, 'k1 ' + t);
  // P=0 重置（另一次生成）
  const bufs0 = {}; for (const n of s.inputNames.slice(1)) bufs0[n] = new Float32Array(0);
  o = await s.run(Object.assign({ ids: ids([1]) }, Object.fromEntries(Object.keys(bufs0).map((n) => [n, new Tensor('float32', bufs0[n], [1, 0, H, D])]))));
  assert.deepStrictEqual(o.new_k0.dims, [1, 1, H, D]); assert.ok(Math.abs(o.new_k0.data[0] - fill(0, 0, 0, 0)) < 1e-5);
  // 錯誤原樣丟出
  const bad = S.createSession({ ort, nHeads: H, headDim: D, nLayers: NL, vocab: 5, decodeFn: async () => { throw new Error('gpu lost'); } });
  await assert.rejects(() => bad.run(Object.assign({ ids: ids([1]) }, empty())), /gpu lost/);
  console.log('midi_session_test: 全部通過');
})().catch((e) => { console.error(e); process.exit(1); });
