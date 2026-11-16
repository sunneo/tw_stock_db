// node renderer/src/gpu/qwen_chat_test.js — 聊天生成迴圈（假引擎＋假分詞器）：貪婪只讀 argmax、取樣與 nr-gen-params 一致、重複懲罰、結束詞元、切塊預填、取消、逾時、上限。
const assert = require('assert');
const C = require('./qwen_chat.js'), GP = require('./nr_gen_params.js');
const V = 12;
// 假引擎：logits 由「最後一個輸入詞元」決定（固定表），記錄每次 step 的選項
function fakeEngine(over) {
  const e = { maxT: 64, maxM: 4, calls: [], len: 0, resets: 0, reset() { this.len = 0; this.resets++; },
    async step(ids, so) { this.calls.push({ n: ids.length, logits: !!(so && so.logits) }); this.len += ids.length; const last = ids[ids.length - 1]; const lg = new Float32Array(V); for (let i = 0; i < V; i++) lg[i] = ((last * 7 + i * 3) % 11) / 2; lg[(last + 1) % V] += 3; let b = 0; for (let i = 1; i < V; i++) if (lg[i] > lg[b]) b = i; const r = { token: b }; if (so && so.logits) r.logits = lg; return r; } };
  return Object.assign(e, over || {});
}
const tok = { decode: (ids) => ids.map((i) => (i === 10 ? '<|im_end|>' : String.fromCharCode(97 + i))).join('') };
let ok = 0; const pend = []; const t = (n, f) => pend.push(Promise.resolve().then(f).then(() => { ok++; }, (e) => { console.log('FAIL', n, e.message); process.exitCode = 1; }));
t('貪婪：不讀回 logits，序列等於每步 argmax，遇 eos 停且文字不含結束標記', async () => {
  const e = fakeEngine(); const r = await C.generate({ engine: e, tok, promptIds: [1, 2], maxNew: 20, gen: { do_sample: false }, eosIds: [10] });
  assert.ok(e.calls.every((c) => !c.logits)); assert.strictEqual(r.finish_reason, 'stop'); assert.strictEqual(r.ids[r.ids.length - 1], 10); assert.ok(!/im_end/.test(r.text)); assert.strictEqual(r.gpu.sampled, false);
});
t('取樣：讀回 logits，同 seed 同結果、不同 seed 可不同，且等於直接用 pickToken 的結果', async () => {
  const gen = { do_sample: true, temperature: 0.8, top_p: 0.9, repetition_penalty: 1.08 };
  const run = (seed) => C.generate({ engine: fakeEngine(), tok, promptIds: [1, 2], maxNew: 8, gen, seed, eosIds: [99] });
  const a = await run(5), b = await run(5), c = await run(6); assert.deepStrictEqual(a.ids, b.ids); assert.strictEqual(a.gpu.sampled, true);
  // 手算參考
  const eng = fakeEngine(), rng = GP.makeRng(5), ids = []; let r = await eng.step([1, 2], { logits: true });
  for (let i = 0; i < 8; i++) { const n = GP.pickToken(Float32Array.from(r.logits), [1, 2], ids, gen, rng); ids.push(n); r = await eng.step([n], { logits: true }); }
  assert.deepStrictEqual(a.ids, ids); assert.ok(c.ids.length === 8);
});
t('貪婪＋重複懲罰：要讀回 logits（排序會變），結果等於 pickToken', async () => {
  const gen = { do_sample: false, repetition_penalty: 1.5 }; assert.strictEqual(C.isPureGreedy(gen), false);
  const r = await C.generate({ engine: fakeEngine(), tok, promptIds: [3], maxNew: 6, gen, eosIds: [99] });
  const eng = fakeEngine(), ids = []; let x = await eng.step([3], { logits: true });
  for (let i = 0; i < 6; i++) { const n = GP.pickToken(Float32Array.from(x.logits), [3], ids, gen, null); ids.push(n); x = await eng.step([n], { logits: true }); }
  assert.deepStrictEqual(r.ids, ids);
});
t('重複懲罰真的改變結果（嚴格模式：n-gram 也生效）', async () => {
  const base = await C.generate({ engine: fakeEngine(), tok, promptIds: [3], maxNew: 12, gen: { do_sample: false }, eosIds: [99] });
  const pen = await C.generate({ engine: fakeEngine(), tok, promptIds: [3], maxNew: 12, gen: { do_sample: false, repetition_penalty: 1.2, no_repeat_ngram_size: 2 }, eosIds: [99] });
  assert.notDeepStrictEqual(base.ids, pen.ids);
});
t('提示超過 maxM：切塊預填，只有最後一塊要 logits', async () => {
  const e = fakeEngine(); await C.generate({ engine: e, tok, promptIds: [1, 2, 3, 4, 5, 6, 7, 8, 9], maxNew: 2, gen: { do_sample: true, temperature: 1 }, seed: 1, eosIds: [99] });
  assert.deepStrictEqual(e.calls.slice(0, 3).map((c) => c.n), [4, 4, 1]); assert.deepStrictEqual(e.calls.slice(0, 3).map((c) => c.logits), [false, false, true]); assert.strictEqual(e.resets, 1);
});
t('上下文超過引擎上限：丟出具體原因（呼叫端退回原路徑）', async () => {
  await assert.rejects(C.generate({ engine: fakeEngine({ maxT: 10 }), tok, promptIds: [1, 2, 3, 4, 5, 6], maxNew: 8, gen: {} }), /KV 上限 10/);
  assert.strictEqual(C.canRun(fakeEngine(), 5, 5).ok, true);
});
t('取消：回 cancelled；onText 逐步收到增量', async () => {
  let n = 0, got = ''; const r = await C.generate({ engine: fakeEngine(), tok, promptIds: [1], maxNew: 30, gen: { do_sample: false }, eosIds: [99], onText: (d) => { got += d; n++; }, isCancelled: () => n >= 3 });
  assert.strictEqual(r.cancelled, true); assert.strictEqual(got.length, 3);
});
t('引擎失敗與逾時：丟出，不吞掉', async () => {
  await assert.rejects(C.generate({ engine: fakeEngine({ async step() { throw new Error('裝置遺失'); } }), tok, promptIds: [1], maxNew: 3, gen: {} }), /裝置遺失/);
  await assert.rejects(C.generate({ engine: fakeEngine({ step() { return new Promise(() => {}); } }), tok, promptIds: [1], maxNew: 3, gen: {}, stepTimeoutMs: 30 }), /逾時/);
});
t('不支援的 gen 鍵丟錯（不靜默忽略）', async () => { await assert.rejects(C.generate({ engine: fakeEngine(), tok, promptIds: [1], maxNew: 2, gen: { top_k: 5 } }), /不支援/); });
Promise.all(pend).then(() => console.log(ok + ' passed'));
// readLargeFile：用真檔案系統模擬主程序 copyChunked（分段、前綴命名）與 readFile（base64）
(async () => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'qc-')); const src = path.join(d, 'big.bin'); const data = Buffer.from(Array.from({ length: 10007 }, (_, i) => (i * 31 + 7) & 255)); fs.writeFileSync(src, data);
  const raw = { copyChunked: async (s, dst, part) => { fs.mkdirSync(path.dirname(dst), { recursive: true }); const parts = []; const b = fs.readFileSync(s); for (let i = 0, k = 0; i < b.length; i += part, k++) { const n = path.basename(dst) + String(k).padStart(4, '0') + '.part'; fs.writeFileSync(path.join(path.dirname(dst), n), b.subarray(i, i + part)); parts.push({ name: n, size: Math.min(part, b.length - i) }); } return { size: b.length, parts }; },
    readFile: async (p) => ({ base64: fs.readFileSync(p).toString('base64') }), remove: async (p) => fs.rmSync(p, { recursive: true, force: true }) };
  const out = await C.readLargeFile(raw, src, path.join(d, 'parts'), '/', 3000);
  assert.ok(Buffer.from(out).equals(data)); assert.ok(!fs.existsSync(path.join(d, 'parts')), '暫存要刪掉');
  await assert.rejects(C.readLargeFile(Object.assign({}, raw, { copyChunked: async () => ({ size: 5, parts: [{ name: 'x' }] }), readFile: async () => ({ base64: Buffer.alloc(9).toString('base64') }) }), src, path.join(d, 'p2'), '/', 3), /超過檔案大小/);
  console.log('readLargeFile ok');
})();
