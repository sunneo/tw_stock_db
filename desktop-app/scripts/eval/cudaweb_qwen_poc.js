// node scripts/eval/cudaweb_qwen_poc.js [--vocab=4096]
// Qwen3-0.6B 的 MLP 與 lm_head 矩陣乘 PoC（DESIGN.webgpu-cuda.md 第二階段之後的驗證項）。
// 重要：這裡的權重是「假的」——形狀取自 Qwen3-0.6B 的公開設定（隱藏 1024、MLP 中間 3072、詞表 151936），
// 數值是決定性的偽隨機數，不下載任何真實權重。因此它只證明：形狀、分塊、降級與數值對拍的流程可跑，
// 不能證明模型品質、也不代表真實權重的誤差。
// lm_head 完整詞表（1024×151936 約 6.2 億個 f32，約 593 MiB）超過 node 合理記憶體，預設縮成 --vocab=4096；
// 要跑完整詞表請自行傳 --vocab=151936（需要足夠記憶體，且不建議在一般機器上跑）。
'use strict';
const core = require('../../renderer/src/gpu/gpu_core.js');
const { fakeNavigator } = require('../../renderer/src/gpu/gpu_fakes.js');

const argVocab = (process.argv.find((a) => a.startsWith('--vocab=')) || '--vocab=4096').split('=')[1];
const VOCAB = Math.max(1, parseInt(argVocab, 10) || 4096);
const SHAPES = {
  hidden: 1024,
  mlp: 3072,
  vocabFull: 151936,
  vocabUsed: VOCAB,
};

function fakeWeights(rows, cols, seed) {
  const out = new Float32Array(rows * cols);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < out.length; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    out[i] = Math.fround(((s % 2001) - 1000) / 10000);
  }
  return out;
}

async function runOne(rt, name, x, W, m, k, n) {
  const t0 = Date.now();
  const r = await rt.matmul(Array.from(x), Array.from(W), m, k, n);
  const ms = Date.now() - t0;
  const ref = core.matmulRef(x, W, m, k, n);
  let maxAbs = 0, maxRel = 0;
  for (let i = 0; i < ref.length; i++) {
    const d = Math.abs(r.result[i] - ref[i]);
    maxAbs = Math.max(maxAbs, d);
    maxRel = Math.max(maxRel, d / Math.max(1e-6, Math.abs(ref[i])));
  }
  const tol = core.tolerance(k);
  const pass = maxRel <= tol;
  return { name, shape: [m, k, n], ms, chunks: r.info.chunks || 1, layer: r.info.layer, maxAbs, maxRel, tol, pass, fake: true };
}

(async () => {
  const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
  const results = [];
  // 單一 token 的隱藏向量（列向量 1×hidden）
  const x = fakeWeights(1, SHAPES.hidden, 11);
  results.push(await runOne(rt, 'mlp_up (1024→3072)', x, fakeWeights(SHAPES.hidden, SHAPES.mlp, 12), 1, SHAPES.hidden, SHAPES.mlp));
  const h = fakeWeights(1, SHAPES.mlp, 13);
  results.push(await runOne(rt, 'mlp_down (3072→1024)', h, fakeWeights(SHAPES.mlp, SHAPES.hidden, 14), 1, SHAPES.mlp, SHAPES.hidden));
  results.push(await runOne(rt, 'lm_head (1024→vocab=' + SHAPES.vocabUsed + ')', x, fakeWeights(SHAPES.hidden, SHAPES.vocabUsed, 15), 1, SHAPES.hidden, SHAPES.vocabUsed));

  // 分塊路徑：把儲存上限壓到 256 位元組，逼 lm_head 切塊，確認分塊結果仍與參考版一致
  const rtSmall = core.createRuntime({ navigator: fakeNavigator({ limits: { maxStorageBufferBindingSize: 256 } }).nav, webgl2: null });
  // 上限 256 位元組時一列至多放 64 個 f32，所以 k 取 8（一列 32 位元組），讓分塊實際發生
  const chunked = await runOne(rtSmall, 'lm_head 分塊（上限 256 B，k=8，詞表縮成 64）', x.slice(0, 8), fakeWeights(8, 64, 16), 1, 8, 64);
  results.push(chunked);

  const bi = await rt.backendInfo();
  const out = {
    model: 'Qwen3-0.6B（形狀取自公開設定，權重為假的）',
    fakeWeights: true,
    vocabFull: SHAPES.vocabFull,
    vocabUsed: SHAPES.vocabUsed,
    results,
    allPass: results.every((r) => r.pass),
    backendLayers: bi.last ? bi.last.layer : null,
    note: '假裝置驗證流程與索引；WGSL 真實數值需真機驗證（見 DESIGN.webgpu-cuda.md §9）',
  };
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.allPass ? 0 : 1);
})().catch((e) => { console.error('PoC 失敗：', e && e.stack || e); process.exit(2); });
