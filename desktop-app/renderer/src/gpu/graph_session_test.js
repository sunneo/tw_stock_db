// node renderer/src/gpu/graph_session_test.js — 圖形 session 的轉換與 attachRun 的退路（假 gs／假 session）。整張真圖對 ORT 在 scripts/eval/cudaweb_graph_*.js。
const assert = require('assert'); const G = require('./graph_session.js');
class T { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
let ok = 0; const pend = []; const t = (n, f) => pend.push(Promise.resolve().then(f).then(() => { ok++; }, (e) => { console.log('FAIL', n, e.message); process.exitCode = 1; }));
t('toInternal／toExternal：float32、int64(BigInt)、bool、int32', () => {
  const a = G.toInternal(new T('int64', BigInt64Array.from([3n, -2n]), [2])); assert.deepStrictEqual([a.t, Array.from(a.v)], ['i', [3, -2]]);
  const b = G.toInternal(new T('bool', Uint8Array.from([1, 0]), [2])); assert.strictEqual(b.t, 'b'); const c = G.toInternal(new T('int32', Int32Array.from([5]), [1])); assert.strictEqual(c.v[0], 5);
  const e = G.toExternal({ d: [2], t: 'i', v: Float64Array.from([3, -2]) }, T); assert.ok(e.data instanceof BigInt64Array && e.data[1] === -2n); assert.strictEqual(G.toExternal({ d: [1], t: 'f', v: Float32Array.of(1) }).type, 'float32');
  assert.throws(() => G.toInternal(new T('string', [], [0])), /不支援/);
});
t('gpuShare：T1 為主才算；cpu-int 是刻意；其他算退層（≥20% 不算）', () => {
  assert.strictEqual(G.gpuShare({ T1: 30 }).ok, true); assert.strictEqual(G.gpuShare({ T1: 30, 'cpu-int（權重大）': 70 }).ok, true);
  assert.strictEqual(G.gpuShare({ T1: 7, 'cpu-js': 3 }).ok, false); assert.strictEqual(G.gpuShare({}).ok, false); assert.strictEqual(G.gpuShare({ 'cpu-js': 5 }).ok, false); assert.strictEqual(G.gpuShare({ T1: 9, 'cpu-js': 1 }).ok, true);
});
const mkGs = (tiers, out) => ({ info: { tiers }, async run() { return out || { wav: { type: 'float32', data: new Float32Array(8).fill(0.1), dims: [1, 8] } }; } });
const mkSess = () => { const c = { orig: 0 }; return { c, run: async () => { c.orig++; return { wav: new T('float32', new Float32Array(8), [1, 8]) }; } }; };
const feeds = () => ({ x: new T('float32', new Float32Array(2), [2]) });
t('attachRun 成功：回 session 自己的 Tensor 建構子，不碰原 run', async () => { const s = mkSess(); const h = G.attachRun(s, mkGs({ T1: 5 })); const r = await s.run(feeds()); assert.ok(r.wav instanceof T); assert.strictEqual(s.c.orig, 0); assert.strictEqual(h.gpu, true); assert.strictEqual(h.stat.runs, 1); });
t('attachRun：GPU 退層太多→永久退回原 run，原因寫明', async () => { const s = mkSess(); const notes = []; const h = G.attachRun(s, mkGs({ T1: 1, 'cpu-js': 9 }), { say: (x) => notes.push(x) }); await s.run(feeds()); await s.run(feeds()); assert.strictEqual(s.c.orig, 2); assert.strictEqual(h.gpu, false); assert.ok(/沒有跑在 GPU/.test(h.stat.fellBack) && notes.length === 1); });
t('attachRun：輸出含 NaN／丟錯都退回', async () => { const s = mkSess(); G.attachRun(s, mkGs({ T1: 5 }, { wav: { type: 'float32', data: Float32Array.of(NaN, 1), dims: [2] } })); await s.run(feeds()); assert.strictEqual(s.c.orig, 1);
  const s2 = mkSess(); G.attachRun(s2, { info: { tiers: { T1: 1 } }, async run() { throw new Error('裝置遺失'); } }); await s2.run(feeds()); assert.strictEqual(s2.c.orig, 1); });
Promise.all(pend).then(() => console.log(ok + ' passed'));
