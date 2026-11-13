'use strict';
// 上下文擴展純函式測試（node renderer/src/studio/context_extend_core.test.js）
const assert = require('assert');
const C = require('./context_extend_core.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok -', name); }

t('原長度與基底 config 一致', () => {
  assert.strictEqual(C.ORIG_MAX, 40960);
  assert.strictEqual(C.ROPE_THETA, 1000000);
  assert.strictEqual(C.targetLength(2), 81920);
  assert.strictEqual(C.targetLength(4), 163840);
});

t('只允許 2 與 4 倍', () => {
  assert.strictEqual(C.validateFactor(2).ok, true);
  assert.strictEqual(C.validateFactor(4).ok, true);
  assert.strictEqual(C.validateFactor(3).ok, false);
  assert.strictEqual(C.validateFactor(1).ok, false);
});

t('rope_parameters 是 YaRN（transformers 5.x 格式）', () => {
  assert.deepStrictEqual(C.ropeParameters(2), { rope_type: 'yarn', factor: 2, original_max_position_embeddings: 40960, rope_theta: 1000000 });
  assert.deepStrictEqual(C.ropeParameters(1), { rope_type: 'default', rope_theta: 1000000 });
});

t('YaRN 注意力縮放 0.1·ln(f)+1', () => {
  assert.ok(Math.abs(C.yarnAttentionScale(2) - (0.1 * Math.log(2) + 1)) < 1e-12);
  assert.strictEqual(C.yarnAttentionScale(1), 1);
});

t('KV 快取算術：28 層 × 2 × 8 頭 × 128 × 4 位元組 = 229376 位元組/權杖', () => {
  assert.strictEqual(C.kvCacheBytes(1, 'fp32'), 229376);
  assert.strictEqual(C.kvCacheBytes(1, 'fp16'), 114688);
  assert.strictEqual(C.kvCacheBytes(4096, 'fp32'), 229376 * 4096);
});

t('記憶體估算：8192 權杖 fp32 的 KV 約 1.75 GiB', () => {
  const m = C.memoryEstimate(8192, 'fp32');
  assert.strictEqual(m.kvGiB, 1.75);
});

t('網頁版 4 GiB：2 倍 fp32 的 KV 超過 4 GiB 時 plan 會寫出警告行', () => {
  const p = C.plan(2);
  assert.strictEqual(p.ok, true);
  assert.strictEqual(p.targetLength, 81920);
  assert.ok(p.lines.some((s) => s.indexOf('WebAssembly') >= 0));
  assert.ok(C.memoryEstimate(81920, 'fp32').kvGiB > 4);
  assert.ok(C.memoryEstimate(8192, 'fp32').kvGiB < 4);
});

t('plan 對非法倍數回傳 ok:false', () => {
  assert.strictEqual(C.plan(8).ok, false);
});

t('訓練時間估計只做乘法', () => {
  assert.strictEqual(C.estimateSeconds(60, 40), 2400);
  const p = C.plan(4, { stepSeconds: 60, steps: 40 });
  assert.strictEqual(p.stepSecondsEstimate, 2400);
});

console.log(`全部 ${n} 項通過`);
