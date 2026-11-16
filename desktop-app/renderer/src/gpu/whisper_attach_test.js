// node renderer/src/gpu/whisper_attach_test.js — 假 session／假編碼器：成功時回 ORT 風格張量；各種失敗永久退回原 run。
const assert = require('assert'); const A = require('./whisper_attach.js');
class T { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
const feats = () => ({ input_features: new T('float32', new Float32Array(80 * 3000).fill(0.1), [1, 80, 3000]) });
const mk = (WEover, tiers) => { const calls = { orig: 0, enc: 0 }; const sess = { async run() { calls.orig++; return { last_hidden_state: new T('float32', new Float32Array(1500 * 512), [1, 1500, 512]) }; } };
  const ops = { tiers: tiers || { whisper_mm: 'T1', whisper_conv80: 'T1' } }; const WE = { async encode() { calls.enc++; return new Float32Array(1500 * 512).fill(0.5); } }; Object.assign(WE, WEover || {});
  const notes = []; const h = A.attach({ sess, enc: {}, WE, ops, say: (t) => notes.push(t) }); return { sess, h, calls, notes }; };
let ok = 0; const pend = []; const t = (n, f) => pend.push(Promise.resolve().then(f).then(() => { ok++; }, (e) => { console.log('FAIL', n, e.message); process.exitCode = 1; }));
t('成功：回 ORT 風格張量（同建構子）、不碰原 run', async () => { const { sess, h, calls } = mk(); const r = await sess.run(feats()); assert.ok(r.last_hidden_state instanceof T); assert.deepStrictEqual(r.last_hidden_state.dims, [1, 1500, 512]); assert.strictEqual(calls.orig, 0); assert.strictEqual(h.gpu, true); assert.strictEqual(h.stat.runs, 1); });
t('有運算退到 cpu-js：本次與之後都用原 run，原因寫明', async () => { const { sess, h, calls, notes } = mk({}, { whisper_mm: 'cpu-js（沒有 WebGPU）' }); await sess.run(feats()); await sess.run(feats()); assert.strictEqual(calls.orig, 2); assert.strictEqual(calls.enc, 1); assert.strictEqual(h.gpu, false); assert.ok(/沒有跑在 GPU/.test(h.stat.fellBack) && notes.length === 1); });
t('輸出含 NaN：退回', async () => { const { sess, calls, h } = mk({ async encode() { const o = new Float32Array(1500 * 512); o[97 * 5] = NaN; return o; } }); await sess.run(feats()); assert.strictEqual(calls.orig, 1); assert.ok(/NaN/.test(h.stat.fellBack)); });
t('輸出長度錯：退回', async () => { const { sess, calls } = mk({ async encode() { return new Float32Array(10); } }); await sess.run(feats()); assert.strictEqual(calls.orig, 1); });
t('編碼器丟錯：退回且不再嘗試 GPU', async () => { const { sess, calls } = mk({ async encode() { throw new Error('裝置遺失'); } }); await sess.run(feats()); await sess.run(feats()); assert.strictEqual(calls.orig, 2); });
t('輸入形狀不對：退回', async () => { const { sess, calls } = mk(); await sess.run({ input_features: new T('float32', new Float32Array(10), [1, 10]) }); assert.strictEqual(calls.orig, 1); assert.strictEqual(calls.enc, 0); });
Promise.all(pend).then(() => console.log(ok + ' passed'));
