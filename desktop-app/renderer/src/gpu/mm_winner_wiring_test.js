'use strict';
// O14b：mm_ops 競賽勝者接到 runtime 矩陣乘（gpu_core 的 matmul）。假裝置（gpu_fakes.js）驗證主機端流程。
// 四種情況：無勝者＝舊核心；有勝者用勝者；強制覆蓋優先；關閉＝舊核心。另加：simple 勝者沒有對應核心＝退回預設。
// 注意：這裡只證明「選到哪個核心名、結果對 CPU 參考」，不驗證 WGSL 本身（那要真 GPU 的 eval，本機沒有 NVIDIA）。純 node。
const assert = require('assert');
const core = require('./gpu_core.js');
const mm = require('./mm_ops.js');
const KS = require('./kernel_select.js');
const { fakeNavigator } = require('./gpu_fakes.js');

let passes = 0;
function fill(n, seed) { const o = new Float32Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) | 0; o[i] = ((s >>> 0) / 4294967296) - 0.5; } return o; }

// 形狀：M=K=N=32，符合 vec4 條件（K、N 為 4 的倍數、不轉置），所以「規則預設」是 matmul_vec4
const M = 32, K = 32, N = 32;
const A = fill(M * K, 11), B = fill(K * N, 12);
const refY = Array.from(core.matmulRef(A, B, M, K, N));

// 勝者的快取鍵：與 mm_ops 查表用的同一把鍵（adapter 'unknown'、CAPS 未設定＝null）
const winnerKey = KS.cacheKey('unknown', 'matmul', { M: M, K: K, N: N }, null);
function setWinner(id) {
  mm.setMatmulWinners(id ? [{ key: winnerKey, value: { id: id, median: 1, timings: {} } }] : []);
}

// 跑一次 runtime 矩陣乘，回傳 { kernels（本次建立的管線核心名）, info, result }
async function runOnce() {
  const f = fakeNavigator();
  const names = [];
  const orig = f.dev.createComputePipeline;
  f.dev.createComputePipeline = function (desc) { const p = orig.call(this, desc); names.push(p.kernel); return p; };
  const rt = core.createRuntime({ navigator: f.nav, webgl2: null });
  const out = await rt.matmul(A, B, M, K, N);
  return { kernels: names.filter((k) => k === 'matmul' || k === 'matmul_vec4'), info: out.info, result: Array.from(out.result) };
}
function closeTo(got, want, msg) {
  assert.strictEqual(got.length, want.length, msg + ' 長度');
  for (let i = 0; i < want.length; i++) assert.ok(Math.abs(got[i] - want[i]) <= 1e-5, msg + ' i=' + i + ' ' + got[i] + ' vs ' + want[i]);
}

(async () => {
  // 先確認 mm_ops 載入時已把勝者來源接上（之後每個情況都自己設定勝者與強制值）
  assert.strictEqual(core.getMatmulPolicy().hasWinnerSource, true, 'mm_ops 載入後應已設定勝者來源');

  await (async function caseNoWinner() {
    core.setMatmulForce('auto'); setWinner(null);
    const r = await runOnce();
    assert.strictEqual(r.info.layer, 'T1');
    assert.deepStrictEqual(r.kernels, ['matmul_vec4'], '無勝者：應走舊核心（規則預設 vec4）');
    closeTo(r.result, refY, '無勝者結果');
    passes++; console.log('ok   1 無勝者＝舊核心（matmul_vec4，與接線前相同）');
  })();

  await (async function caseWinner() {
    core.setMatmulForce('auto'); setWinner('mm_tiled_f32');
    const r = await runOnce();
    assert.strictEqual(r.info.layer, 'T1');
    assert.deepStrictEqual(r.kernels, ['matmul'], '有勝者 mm_tiled_f32：應用勝者（matmul，非 vec4）');
    closeTo(r.result, refY, '有勝者結果');
    passes++; console.log('ok   2 有勝者＝用勝者（mm_tiled_f32 → matmul）');
  })();

  await (async function caseForceOverridesWinner() {
    core.setMatmulForce('mm_tiled_f32'); setWinner('mm_vec4_f32');
    const r = await runOnce();
    assert.deepStrictEqual(r.kernels, ['matmul'], '強制 mm_tiled_f32 應覆蓋勝者 mm_vec4_f32');
    closeTo(r.result, refY, '強制覆蓋結果');
    core.setMatmulForce('mm_vec4_f32'); setWinner('mm_tiled_f32');
    const r2 = await runOnce();
    assert.deepStrictEqual(r2.kernels, ['matmul_vec4'], '強制 mm_vec4_f32 應覆蓋勝者 mm_tiled_f32');
    passes++; console.log('ok   3 強制指定優先於勝者（兩個方向）');
  })();

  await (async function caseOff() {
    core.setMatmulForce('off'); setWinner('mm_tiled_f32');
    const r = await runOnce();
    assert.deepStrictEqual(r.kernels, ['matmul_vec4'], '關閉：即使有勝者也應走舊核心（規則預設）');
    closeTo(r.result, refY, '關閉結果');
    passes++; console.log('ok   4 關閉＝舊核心（即使有勝者）');
  })();

  await (async function caseSimpleWinnerHasNoKernel() {
    core.setMatmulForce('auto'); setWinner('mm_simple_f32');
    const r = await runOnce();
    assert.deepStrictEqual(r.kernels, ['matmul_vec4'], 'mm_simple_f32 在 gpu_core 沒有對應核心：退回規則預設');
    passes++; console.log('ok   5 simple 勝者沒有對應核心＝退回預設');
  })();

  await (async function caseBadForce() {
    assert.throws(() => core.setMatmulForce('mm_simple_f32'), /不認得的強制值/);
    assert.throws(() => core.setMatmulForce('bogus'), /不認得的強制值/);
    assert.strictEqual(core.setMatmulForce(null), 'auto', 'null 視為 auto');
    passes++; console.log('ok   6 不認得的強制值明確報錯；null 視為 auto');
  })();

  // 還原預設狀態，避免影響同一程序裡的其他測試
  core.setMatmulForce('auto'); setWinner(null);
  console.log('\n' + passes + ' 項通過（mm_winner_wiring_test）');
})().catch((e) => { console.error('FAIL', e && e.stack || e); process.exit(1); });
