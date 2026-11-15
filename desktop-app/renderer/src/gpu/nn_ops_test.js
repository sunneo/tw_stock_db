// node renderer/src/gpu/nn_ops_test.js
// cudaweb 訓練核心（nn_ops.js）的測試。目前：RMSNorm。
// 注意：假裝置以 CPU 參考版執行 WGSL 核心，所以這裡驗證的是主機端的綁定、回讀與降級流程；WGSL 本身的數值需真機驗證。
'use strict';
const assert = require('assert');
const NN = require('./nn_ops.js');
const { fakeNavigator } = require('./gpu_fakes.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}
function seeded(n, seed) {
  let s = seed >>> 0 || 1; const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = Math.fround(((s % 2001) - 1000) / 500); }
  return out;
}
function maxAbs(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }

(async () => {
  const T = 5, d = 8, eps = 1e-6;
  const x = seeded(T * d, 1), g = seeded(d, 2);

  await check('rmsnormRef 與獨立公式一致（逐列用 sqrt(mean(x²)+eps) 直接算）', async () => {
    const y = NN.rmsnormRef(x, g, T, d, eps);
    const want = new Float64Array(T * d);
    for (let t = 0; t < T; t++) {
      let ss = 0; for (let i = 0; i < d; i++) ss += x[t * d + i] ** 2;
      const rms = Math.sqrt(ss / d + eps);
      for (let i = 0; i < d; i++) want[t * d + i] = x[t * d + i] / rms * g[i];
    }
    assert.ok(maxAbs(y, want) < 1e-12, '差 ' + maxAbs(y, want));
  });

  await check('rmsnorm 經 WGSL（假裝置）：層為 T1，結果與參考版在 f32 捨入內一致', async () => {
    const r = await NN.rmsnorm(x, g, T, d, eps, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1');
    assert.strictEqual(r.info.webgl2, 'missing');
    const ref = NN.rmsnormRef(x, g, T, d, eps);
    assert.ok(maxAbs(r.result, ref) < 1e-6, '差 ' + maxAbs(r.result, ref));
  });

  await check('沒有 WebGPU：退到 cpu-js，原因寫明 WebGPU 不可用與 WebGL2 尚未實作', async () => {
    const r = await NN.rmsnorm(x, g, T, d, eps, { navigator: {} });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.includes('WebGPU 不可用'), r.info.reason);
    assert.ok(r.info.reason.includes(NN.NOTE_T3));
    assert.ok(maxAbs(r.result, NN.rmsnormRef(x, g, T, d, eps)) < 1e-12);
  });

  await check('WGSL 執行失敗：退回 CPU，原因寫明失敗訊息', async () => {
    // 假裝置的 kernelError 目前只認 @kernel 名稱；這裡用一個會丟錯的 navigator 來模擬分派失敗
    const nav = fakeNavigator({ kernelError: 'rmsnorm' }).nav;
    const r = await NN.rmsnorm(x, g, T, d, eps, { navigator: nav });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.includes('WGSL 執行失敗'), r.info.reason);
    assert.ok(r.info.reason.includes('假核心錯誤'));
  });

  await check('形狀不符：直接丟錯（不降級，避免默默算錯）', async () => {
    assert.throws(() => NN.rmsnormRef(x.slice(1), g, T, d, eps), /x 的長度/);
    assert.throws(() => NN.rmsnormRef(x, g.slice(1), T, d, eps), /g 的長度/);
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
