'use strict';
// llm_skeleton_gpu（O12b GPU 版）：以 CPU 替身的 matvec 對拍 llm_skeleton.run，必須逐位相同；mv 的呼叫次數與錯誤傳遞。
const assert = require('assert');
const S = require('./llm_skeleton.js');
const G = require('./llm_skeleton_gpu.js');
let passes = 0;
async function check(name, fn) { await fn(); passes++; console.log('ok   ' + name); }

function rng(seed) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) | 0; return ((s >>> 0) / 4294967296) - 0.5; }; }
function randArr(n, r) { return Float32Array.from({ length: n }, () => r() * 0.6); }
function model(opts) {
  const o = Object.assign({ layers: 2, hidden: 8, heads: 4, kvHeads: 2, headDim: 2, ffn: 6, vocab: 5, qkNorm: false, tied: false, seed: 7 }, opts || {});
  const r = rng(o.seed);
  const arch = {
    family: 'llama', status: 'supported', verified: false,
    layers: o.layers, hidden: o.hidden, heads: o.heads, kvHeads: o.kvHeads, headDim: o.headDim, ffn: o.ffn,
    norm: 'rmsnorm', eps: 1e-5, qkNorm: o.qkNorm,
    rope: { base: 10000, scaling: null, style: 'half' }, act: 'silu_mul', bias: false, tiedEmbeddings: o.tied,
    vocab: o.vocab, quant: ['f32']
  };
  const H = o.hidden, hd = o.headDim;
  const w = {
    embed: randArr(o.vocab * H, r), finalNorm: randArr(H, r).map((v) => 1 + v),
    layers: []
  };
  if (!o.tied) w.lmHead = randArr(o.vocab * H, r);
  for (let i = 0; i < o.layers; i++) {
    const L = {
      attnNorm: randArr(H, r).map((v) => 1 + v), wq: randArr(o.heads * hd * H, r), wk: randArr(o.kvHeads * hd * H, r),
      wv: randArr(o.kvHeads * hd * H, r), wo: randArr(H * o.heads * hd, r), ffnNorm: randArr(H, r).map((v) => 1 + v),
      wGate: randArr(o.ffn * H, r), wUp: randArr(o.ffn * H, r), wDown: randArr(H * o.ffn, r)
    };
    if (o.qkNorm) { L.qNorm = randArr(hd, r).map((v) => 1 + v); L.kNorm = randArr(hd, r).map((v) => 1 + v); }
    w.layers.push(L);
  }
  return { arch: arch, w: w };
}
// CPU 替身：與 llm_skeleton 的 matvec 同一個算法（同樣的加總順序），所以結果必須逐位相同
const cpuMv = async (W, rows, cols, x) => {
  const y = new Float32Array(rows);
  for (let r = 0; r < rows; r++) { let s = 0; const o = r * cols; for (let c = 0; c < cols; c++) s += W[o + c] * x[c]; y[r] = s; }
  return y;
};

(async () => {
  await check('GPU 版（CPU 替身）與參考實作逐位相同：兩層、未共用 lm_head、多詞元', async () => {
    const m = model();
    const ref = S.run(m.arch, m.w, [1, 3, 0, 4], { useOverrides: false });
    const got = await G.runGpu(m.arch, m.w, [1, 3, 0, 4], cpuMv);
    assert.deepStrictEqual(Array.from(got.logits), Array.from(ref.logits));
    assert.strictEqual(got.argmax, ref.argmax);
  });

  await check('GPU 版：qk-norm 與共用嵌入（tied）也逐位相同', async () => {
    const m = model({ qkNorm: true, tied: true, seed: 11 });
    const ref = S.run(m.arch, m.w, [2, 2, 1], { useOverrides: false });
    const got = await G.runGpu(m.arch, m.w, [2, 2, 1], cpuMv);
    assert.deepStrictEqual(Array.from(got.logits), Array.from(ref.logits));
  });

  await check('投影呼叫次數：每層 7 次（q、k、v、o、gate、up、down），每個詞元再加 1 次（lm_head）', async () => {
    const m = model({ layers: 3 });
    let calls = 0;
    await G.runGpu(m.arch, m.w, [0, 1], async (W, r, c, x) => { calls++; return cpuMv(W, r, c, x); });
    assert.strictEqual(calls, 2 * (3 * 7 + 1));
  });

  await check('錯誤會傳出來：投影丟錯時 runGpu 拒絕（不悄悄算錯）', async () => {
    const m = model();
    await assert.rejects(G.runGpu(m.arch, m.w, [0], async () => { throw new Error('裝置遺失'); }), /裝置遺失/);
  });

  await check('權重長度不對：沿用 llm_skeleton 的檢查，開頭就丟錯', async () => {
    const m = model();
    m.w.layers[0].wq = new Float32Array(3);
    await assert.rejects(G.runGpu(m.arch, m.w, [0], cpuMv), /權重 layers\[0\]\.wq/);
  });

  console.log('llm_skeleton_gpu_test: ' + passes + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
