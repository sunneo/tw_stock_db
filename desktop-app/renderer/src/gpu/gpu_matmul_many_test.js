'use strict';
// matmulMany（gpu_core 的批次矩陣乘）：用假 WebGPU 裝置（gpu_fakes.js，依 @kernel 標記用 CPU 參考重現核心）對拍。
// 驗證：結果與 CPU 參考逐位相同、混合形狀與轉置、一次 submit、無裝置時降到 T5、核心失敗時降級、超過上限時逐組分塊、輸入錯誤要明確。
// 不驗證 WGSL 本身（那要真 GPU 的 eval）。純 node。
const assert = require('assert');
const core = require('./gpu_core.js');
const { fakeNavigator } = require('./gpu_fakes.js');
let passes = 0;
async function check(name, fn) { await fn(); passes++; console.log('ok   ' + name); }
const close = (a, b, tol, msg) => {
  assert.strictEqual(a.length, b.length, msg + ' 長度');
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) <= tol, msg + ' i=' + i + ' ' + a[i] + ' vs ' + b[i]);
};
function fill(n, seed) { const o = new Float32Array(n); let s = seed; for (let i = 0; i < n; i++) { s = (Math.imul(s, 1103515245) + 12345) | 0; o[i] = ((s >>> 0) / 4294967296) - 0.5; } return o; }
// 形狀：[m, k, n, flags]；flags 為 undefined、{transA}、{transB}
function job(m, k, n, flags, seed) {
  const ra = flags && flags.transA ? k * m : m * k;
  const rb = flags && flags.transB ? n * k : k * n;
  return { A: fill(ra, seed), B: fill(rb, seed + 7), m: m, k: k, n: n, flags: flags };
}
function refOf(j) { return Array.from(j.flags && (j.flags.transA || j.flags.transB) ? core.matmulTRef(j.A, j.B, j.m, j.k, j.n, (j.flags.transA ? 1 : 0) | (j.flags.transB ? 2 : 0)) : core.matmulRef(j.A, j.B, j.m, j.k, j.n)); }
function withSubmitCount(dev) {
  const st = { submits: 0 }; const orig = dev.queue.submit;
  dev.queue.submit = function (cmds) { st.submits++; return orig.call(this, cmds); };
  return st;
}

(async () => {
  const shapes = [
    job(3, 5, 7, undefined, 1),                          // simple 核心（K 不是 4 的倍數）
    job(4, 8, 4, { transB: true }, 2),                   // 轉置 B
    job(5, 6, 3, { transA: true }, 3),                   // 轉置 A
    job(8, 16, 8, undefined, 4),                         // vec4 條件（K、N 為 4 的倍數）
  ];

  await check('混合形狀（含轉置、vec4）：WebGPU 批次結果與 CPU 參考逐位一致，且一次 submit', async () => {
    const f = fakeNavigator();
    const rt = core.createRuntime({ navigator: f.nav, webgl2: null });
    const sc = withSubmitCount(f.dev);
    const out = await rt.matmulMany(shapes.map((j) => [j.A, j.B, j.m, j.k, j.n, j.flags]));
    assert.strictEqual(out.info.layer, 'T1');
    assert.strictEqual(out.info.batched, true);
    assert.strictEqual(out.info.items, shapes.length);
    assert.strictEqual(sc.submits, 1, '應該只 submit 一次，實際 ' + sc.submits);
    assert.strictEqual(out.results.length, shapes.length);
    shapes.forEach((j, i) => close(out.results[i], refOf(j), 0, '第 ' + i + ' 組'));
  });

  await check('物件形式與陣列形式結果相同；與逐組 matmul 一致', async () => {
    const f = fakeNavigator();
    const rt = core.createRuntime({ navigator: f.nav, webgl2: null });
    const asObj = await rt.matmulMany(shapes.map((j) => ({ A: j.A, B: j.B, m: j.m, k: j.k, n: j.n, flags: j.flags })));
    for (let i = 0; i < shapes.length; i++) {
      const j = shapes[i];
      const one = await rt.matmul(j.A, j.B, j.m, j.k, j.n, j.flags);
      close(asObj.results[i], Array.from(one.result), 0, '第 ' + i + ' 組（與 matmul）');
    }
  });

  await check('空的 items：回傳空結果，layer 為 null、batched 為 false', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const out = await rt.matmulMany([]);
    assert.deepStrictEqual(out.results, []);
    assert.strictEqual(out.info.layer, null);
    assert.strictEqual(out.info.batched, false);
  });

  await check('沒有 WebGPU 裝置：降到純 JS（T5），結果仍正確，batched 為 false', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ adapter: 'null' }).nav, webgl2: null });
    const out = await rt.matmulMany(shapes.map((j) => [j.A, j.B, j.m, j.k, j.n, j.flags]));
    assert.strictEqual(out.info.layer, 'T5');
    assert.strictEqual(out.info.batched, false);
    assert.ok(out.info.reason.length > 0, '原因要寫明');
    shapes.forEach((j, i) => close(out.results[i], refOf(j), 0, '第 ' + i + ' 組'));
  });

  await check('核心執行失敗：整批降級（T5），結果仍正確，原因寫明核心失敗', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ kernelError: 'matmul' }).nav, webgl2: null });
    const out = await rt.matmulMany([[shapes[0].A, shapes[0].B, 3, 5, 7]]);
    assert.strictEqual(out.info.layer, 'T5');
    assert.ok(/WGSL 核心執行失敗/.test(out.info.reason), out.info.reason);
    close(out.results[0], refOf(shapes[0]), 0, '降級後的結果');
  });

  await check('超過單一儲存緩衝上限：逐組分塊執行，結果仍正確，batched 為 false', async () => {
    // 上限 256 位元組：k=8 的一列是 32 位元組，分塊後每塊的列數會變小
    const rt = core.createRuntime({ navigator: fakeNavigator({ limits: { maxStorageBufferBindingSize: 256 } }).nav, webgl2: null });
    const big = job(12, 8, 8, undefined, 9);
    const out = await rt.matmulMany([[big.A, big.B, big.m, big.k, big.n]]);
    assert.strictEqual(out.info.batched, false);
    assert.strictEqual(out.info.via, 'per-item');
    close(out.results[0], refOf(big), 1e-6, '分塊後的結果');
  });

  await check('輸入錯誤：不是陣列、尺寸為 0、元素數不符，都丟明確錯誤（指出第幾組）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    await assert.rejects(rt.matmulMany('x'), /必須是陣列/);
    await assert.rejects(rt.matmulMany([[[1], [1], 0, 1, 1]]), /第 0 組的 m、k、n/);
    await assert.rejects(rt.matmulMany([[[1], [1], 1, 1, 1], [[1, 2], [1], 1, 1, 1]]), /第 1 組 A 的元素數/);
    await assert.rejects(rt.matmulMany([[[1], [1, 2], 1, 1, 1]]), /第 0 組 B 的元素數/);
  });

  console.log('gpu_matmul_many_test: ' + passes + ' 項通過');
})().catch((e) => { console.error(e); process.exit(1); });
