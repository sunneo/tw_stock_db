// node renderer/src/studio/llm_web_gpudecode.test.js
// greedyGenerate 的 opts.gpuDecode（Qwen3 整段 GPU 解碼）：用假的 ort／session／引擎驗證編排——
// 一致就用 GPU 的詞元、第一個詞元不同整段退回、GPU 中途失敗時原圖把還沒吃進 KV 的詞元補進去、關閉時行為不變。
const W = require('./llm_web_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };
const V = 64, L = 2;
class Tensor { constructor(type, data, dims) { this.type = type; this.data = data; this.dims = dims; } }
const ort = { Tensor };
const nextOf = (hist) => (hist.reduce((a, b) => a + b, 0) % 50) + 1;
// 假 session：歷史（以 float32 存在 present 裡）決定下一個詞元；順便檢查 KV 長度與 attention_mask 一致
function makeSession(log) {
  return {
    async run(feed) {
      const pastLen = feed['past_key_values.0.key'].dims[2], n = Number(feed.input_ids.dims[1]);
      log.push({ pastLen, n, mask: feed.attention_mask.dims[1], pos0: Number(feed.position_ids.data[0]) });
      if (feed.attention_mask.dims[1] !== pastLen + n) throw new Error('attention_mask 長度與 KV＋輸入不符');
      const hist = Array.from(feed['past_key_values.0.key'].data).concat(Array.from(feed.input_ids.data, Number));
      const lg = new Float32Array(n * V); lg[(n - 1) * V + nextOf(hist) % V] = 10;
      const out = { logits: new Tensor('float32', lg, [1, n, V]) };
      for (let l = 0; l < L; l++) for (const k of ['key', 'value']) out[`present.${l}.${k}`] = new Tensor('float32', Float32Array.from(hist), [1, 1, hist.length, 1]);
      return out;
    },
  };
}
function makeEngine(o) {
  const hist = []; const e = { calls: [], reset() { hist.length = 0; },
    async step(ids) {
      e.calls.push(ids.length);
      if (o.failAt !== undefined && e.calls.length - 1 === o.failAt) throw new Error('假的 GPU 失敗');
      for (const t of ids) hist.push(t);
      let tok = nextOf(hist);
      if (o.wrongFirst && e.calls.length === 1) tok = (tok % 50) + 1;
      return { token: tok };
    } };
  return e;
}
const base = { maxNew: 6, layers: L, kvHeads: 1, headDim: 1, eosIds: [] };
(async () => {
  const prompt = [3, 5, 7];
  // 參考：沒有 gpuDecode
  const lr = []; const ref = await W.greedyGenerate(ort, makeSession(lr), prompt, base);
  check('參考：6 個詞元', ref.tokens.length === 6, ref.tokens);
  check('沒帶 gpuDecode：gpuDecode.requested 為 false', ref.gpuDecode && ref.gpuDecode.requested === false);

  // 1) 一致：除了第一步（原圖）之外都由 GPU 產生，詞元與參考相同，原圖只跑一次（預填）
  { const log = [], eng = makeEngine({}); const r = await W.greedyGenerate(ort, makeSession(log), prompt, Object.assign({}, base, { gpuDecode: { engine: eng } }));
    check('一致：詞元與參考相同', JSON.stringify(r.tokens) === JSON.stringify(ref.tokens), r.tokens);
    check('一致：原圖只跑預填一次', log.length === 1 && log[0].n === 3, log);
    check('一致：GPU 引擎 1 次預填＋5 次解碼', eng.calls.length === 6 && eng.calls[0] === 3 && eng.calls.slice(1).every((x) => x === 1), eng.calls);
    check('一致：診斷 used=5、verify 一致', r.gpuDecode.used === 5 && r.gpuDecode.verify.argmaxSame && r.gpuDecode.fallbackAt === -1, r.gpuDecode); }

  // 2) 第一個詞元不同：整段退回原路徑，詞元與參考相同
  { const log = [], eng = makeEngine({ wrongFirst: true }); const r = await W.greedyGenerate(ort, makeSession(log), prompt, Object.assign({}, base, { gpuDecode: { engine: eng } }));
    check('不同：詞元與參考相同（用原路徑）', JSON.stringify(r.tokens) === JSON.stringify(ref.tokens), r.tokens);
    check('不同：診斷寫明退回與原因', r.gpuDecode.fallbackAt === 0 && /第一個詞元與原圖不同/.test(r.gpuDecode.reason) && r.gpuDecode.verify.argmaxSame === false, r.gpuDecode);
    check('不同：GPU 只被呼叫預填一次', eng.calls.length === 1, eng.calls); }

  // 3) GPU 第 3 步失敗：原圖把已生成的詞元補進 KV，之後的詞元與參考相同
  { const log = [], eng = makeEngine({ failAt: 3 }); const r = await W.greedyGenerate(ort, makeSession(log), prompt, Object.assign({}, base, { gpuDecode: { engine: eng } }));
    check('中途失敗：詞元與參考相同', JSON.stringify(r.tokens) === JSON.stringify(ref.tokens), r.tokens);
    check('中途失敗：診斷', r.gpuDecode.fallbackAt === 3 && /第 3 步失敗/.test(r.gpuDecode.reason) && r.gpuDecode.used === 2, r.gpuDecode);
    // 原圖：預填(3) → 補吃已生成的 3 個詞元（KV 3） → 之後逐個
    check('中途失敗：原圖補吃 3 個詞元', log[1] && log[1].pastLen === 3 && log[1].n === 3 && log[1].mask === 6, log);
    check('中途失敗：之後逐個詞元', log.slice(2).every((x, i) => x.n === 1 && x.pastLen === 6 + i), log); }

  // 4) 預填就失敗：整段用原路徑
  { const log = [], eng = makeEngine({ failAt: 0 }); const r = await W.greedyGenerate(ort, makeSession(log), prompt, Object.assign({}, base, { gpuDecode: { engine: eng } }));
    check('預填失敗：詞元與參考相同', JSON.stringify(r.tokens) === JSON.stringify(ref.tokens), r.tokens);
    check('預填失敗：診斷', r.gpuDecode.fallbackAt === 0 && /GPU 解碼失敗/.test(r.gpuDecode.reason), r.gpuDecode); }

  // 5) 逾時視為失敗
  { const eng = { reset() {}, step: () => new Promise(() => {}) }; const r = await W.greedyGenerate(ort, makeSession([]), prompt, Object.assign({}, base, { gpuDecode: { engine: eng, timeoutMs: 30 } }));
    check('逾時：詞元與參考相同', JSON.stringify(r.tokens) === JSON.stringify(ref.tokens), r.tokens);
    check('逾時：診斷', r.gpuDecode.fallbackAt === 0 && /逾時|timeout|超過/i.test(r.gpuDecode.reason), r.gpuDecode); }

  // 6) 結束詞元：GPU 階段遇到 eos 就停，且不含停止之後的詞元
  { const eos = ref.tokens[2]; const eng = makeEngine({}); const r = await W.greedyGenerate(ort, makeSession([]), prompt, Object.assign({}, base, { eosIds: [eos], gpuDecode: { engine: eng } }));
    check('eos：停在第 3 個詞元', r.stoppedBy === 'eos' && r.tokens.length === 3 && r.tokens[2] === eos, r); }

  console.log(ok + ' passed, ' + bad + ' failed');
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
