// node renderer/src/gpu/qwen_decode_test.js
// qwen_decode.js 的 CPU 參考引擎：用合成的小權重（不需要真模型）檢查結構、KV 快取、錯誤處理與貪婪生成的確定性。
// 對真 ORT 的比對在 scripts/eval/cudaweb_qwen_greedy.js（要真模型）。
const assert = require('assert');
const Q = require('./qwen_decode.js');
let seed = 12345; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
const u8 = (n) => Uint8Array.from({ length: n }, () => Math.floor(rnd() * 256));
const f32 = (n, a, b) => Float32Array.from({ length: n }, () => a + rnd() * (b - a));
const D = 16, H = 2, Hkv = 1, hd = 8, I = 32, V = 40, L = 2;
const qp = (K, N) => ({ W: u8(K * N), K, N, zp: 128, scale: 0.01 });
const W = { L, H, Hkv, hd, D, V, I, eps: 1e-6, theta: 1e6, emb: { W: u8(V * D), zp: 128, scale: 0.02 }, finalNorm: f32(D, 0.8, 1.2),
  layers: Array.from({ length: L }, () => ({ q: qp(D, H * hd), k: qp(D, Hkv * hd), v: qp(D, Hkv * hd), o: qp(H * hd, D), g: qp(D, I), u: qp(D, I), d: qp(I, D),
    qNorm: f32(hd, 0.8, 1.2), kNorm: f32(hd, 0.8, 1.2), inNorm: f32(D, 0.8, 1.2), postNorm: f32(D, 0.8, 1.2) })) };
let ok = 0; const pend = []; const t = (n, f) => { try { const r = f(); if (r && r.then) pend.push(r.then(() => { ok++; }, (e) => { console.log('FAIL', n, e.message); process.exitCode = 1; })); else ok++; } catch (e) { console.log('FAIL', n, e.message); process.exitCode = 1; } };

t('embedRows：反量化 (q-zp)×scale，超出詞表丟錯', () => {
  const r = Q.embedRows(W, [3, 0]);
  assert.strictEqual(r.length, 2 * D);
  assert.ok(Math.abs(r[0] - (W.emb.W[3 * D] - 128) * 0.02) < 1e-6);
  assert.throws(() => Q.embedRows(W, [V]), /超出詞表/);
  assert.throws(() => Q.embedRows(W, [-1]), /超出詞表/);
});
t('step：回傳 V 個有限的 logits，len 增加', () => {
  const e = Q.createCpuEngine(W, { maxT: 16 });
  const lg = e.step([1, 2, 3]);
  assert.strictEqual(lg.length, V); assert.ok(lg.every(Number.isFinite)); assert.strictEqual(e.len, 3);
  e.step([4]); assert.strictEqual(e.len, 4);
});
t('reset 之後結果與重新建立相同（KV 快取確實清掉）', () => {
  const a = Q.createCpuEngine(W, { maxT: 16 }), b = Q.createCpuEngine(W, { maxT: 16 });
  const x = a.step([5, 6]); a.step([7]); a.reset();
  const y = a.step([5, 6]); const z = b.step([5, 6]);
  assert.deepStrictEqual(Array.from(y), Array.from(x)); assert.deepStrictEqual(Array.from(z), Array.from(x));
});
t('KV 快取有作用：同一個詞元接在不同歷史後面，logits 不同', () => {
  const a = Q.createCpuEngine(W, { maxT: 16 }), b = Q.createCpuEngine(W, { maxT: 16 });
  a.step([1, 2]); b.step([9, 8]);
  const x = a.step([4]), y = b.step([4]);
  assert.ok(Array.from(x).some((v, i) => Math.abs(v - y[i]) > 1e-4));
});
t('超過 maxT 丟錯', () => { const e = Q.createCpuEngine(W, { maxT: 3 }); e.step([1, 2, 3]); assert.throws(() => e.step([4]), /超過上限/); });
t('greedy：確定性、長度 n、遇到 stop 即停（不含 stop）', async () => {
  const mk = () => Q.createCpuEngine(W, { maxT: 32 });
  const g1 = await Q.greedy(mk(), [1, 2, 3], 6), g2 = await Q.greedy(mk(), [1, 2, 3], 6);
  assert.deepStrictEqual(g1, g2); assert.strictEqual(g1.length, 6);
  const g3 = await Q.greedy(mk(), [1, 2, 3], 6, [g1[2]]);
  assert.deepStrictEqual(g3, g1.slice(0, g1.indexOf(g1[2])));
});
t('argmax：平手取索引小的（與 GPU 的 argmax 規則相同）', () => { assert.strictEqual(Q.argmax(Float32Array.from([1, 5, 5, 2])), 1); });
t('trace：每層一筆殘差流', () => { const e = Q.createCpuEngine(W, { maxT: 8, trace: true }); e.step([1, 2]); assert.strictEqual(e.lastTrace.length, L); assert.strictEqual(e.lastTrace[0].length, 2 * D); });
Promise.all(pend).then(() => console.log(ok + ' passed'));
