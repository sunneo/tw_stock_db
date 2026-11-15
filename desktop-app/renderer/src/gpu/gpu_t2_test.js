// node renderer/src/gpu/gpu_t2_test.js
// T2 替代實作的測試：雙 f32 歸約、f32 原子加（CAS）、64 位元整數（兩個 u32）、矩陣乘分塊、能力檔閘門、三層一致性。
// 假裝置只驗證流程與索引計算（見 gpu_fakes.js）；WGSL 的正確性需要真機驗證。
'use strict';
const assert = require('assert');
const core = require('./gpu_core.js');
const { fakeNavigator, fakeGl } = require('./gpu_fakes.js');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('ok   ' + name); },
    (e) => { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  );
}
function seeded(n, seed) {
  let s = seed >>> 0 || 1; const out = [];
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out.push(((s % 20001) - 10000) / 1000); }
  return out;
}
const f32r = (x) => Math.fround(x);

(async () => {
  // ---- 雙 f32 演算法 ----
  await check('ddAdd：1 + 2^-30 + 2^-30 的 hi、lo 還原正確（精度比單一 f32 好）', () => {
    // 單一 f32 加 1 + 2^-30 會被捨掉；雙 f32 要保留在 lo 裡
    const r = core.ddAdd(1, 0, Math.pow(2, -30), 0);
    assert.strictEqual(r[0], 1);
    assert.strictEqual(r[1], Math.pow(2, -30));
  });
  await check('sumDdRef 比一般 f32 順序加總更接近精確值（2000 個隨機數）', () => {
    const a = seeded(2000, 101).map(f32r);
    const exact = core.sumExact(a);
    const plain = core.sumRef(a);
    const dd = core.sumDdRef(a);
    const errPlain = Math.abs(plain - exact), errDd = Math.abs(dd - exact);
    assert.ok(errDd <= errPlain, 'dd 誤差 ' + errDd + ' 不應大於一般 f32 誤差 ' + errPlain);
    assert.ok(errDd < 1e-3, 'dd 誤差過大：' + errDd);
  });

  // ---- 64 位元整數（兩個 u32） ----
  await check('add64：進位與模 2^64 與 BigInt 逐筆一致（隨機 200 組）', () => {
    let s = 7;
    const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
    const M = (1n << 64n) - 1n;
    for (let i = 0; i < 200; i++) {
      const a = [rnd(), rnd()], b = [rnd(), rnd()];
      const A = (BigInt(a[0]) << 32n) | BigInt(a[1]), B = (BigInt(b[0]) << 32n) | BigInt(b[1]);
      const want = (A + B) & M;
      const got = core.add64(a, b);
      assert.strictEqual(((BigInt(got[0]) << 32n) | BigInt(got[1])), want, '第 ' + i + ' 組');
    }
  });
  await check('add64：0xFFFFFFFF_FFFFFFFF + 1 溢位回到 0', () => {
    assert.deepStrictEqual(core.add64([0xFFFFFFFF, 0xFFFFFFFF], [0, 1]), [0, 0]);
  });

  // ---- 原子加參考版 ----
  await check('scatterAddRef：重複索引累加正確', () => {
    assert.deepStrictEqual(Array.from(core.scatterAddRef([0, 2, 0, 1], [1, 2, 3, 4], 3)), [4, 4, 2]);
  });

  // ---- 執行期：T2 操作（WGSL 假裝置） ----
  await check('sumDd 在 T1 執行（假 WebGPU），結果與 CPU 雙 f32 參考版在 1e-9 相對誤差內', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const a = seeded(1000, 111).map(f32r);
    const r = await rt.sumDd(a);
    assert.strictEqual(r.info.layer, 'T1');
    assert.strictEqual(r.info.via, 'wgsl-substitute');
    const ref = core.sumDdRef(a), exact = core.sumExact(a);
    assert.ok(Math.abs(r.result - ref) <= 1e-9 * Math.max(1, Math.abs(exact)), 'T1 與 CPU 差 ' + (r.result - ref));
    assert.ok(Math.abs(r.result - exact) < 1e-3, '與精確值差 ' + (r.result - exact));
  });
  await check('scatterAdd 在 T1 執行（假 WebGPU），與 CPU 參考版逐元素一致', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const idx = seeded(500, 121).map((v) => Math.abs(Math.round(v * 10)) % 16);
    const vals = seeded(500, 122).map(f32r);
    const r = await rt.scatterAdd(idx, vals, 16);
    assert.strictEqual(r.info.layer, 'T1');
    assert.strictEqual(r.info.via, 'wgsl-substitute');
    assert.deepStrictEqual(r.result, Array.from(core.scatterAddRef(idx, vals, 16)));
  });
  await check('scatterAdd 在檔 A（軟體介面卡）：不跑原子替代，退到 T5 並寫明原因', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ isFallback: true }).nav, webgl2: null });
    const r = await rt.scatterAdd([0, 0], [1, 2], 2);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('檔 A 沒有原子操作'));
    assert.deepStrictEqual(r.result, [3, 0]);
  });
  await check('scatterAdd 索引超出範圍：直接丟錯（不降級）', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: null });
    await assert.rejects(rt.scatterAdd([5], [1], 3), /超出 0\.\.2/);
    await assert.rejects(rt.scatterAdd([0, 1], [1], 3), /長度不同/);
  });
  await check('sumDd 與 scatterAdd 沒有 WebGL2 版：WebGL2 不可用時退 T5，原因寫明', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl() });
    const r = await rt.sumDd([1, 2, 3]);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('WebGL2 版尚未實作'));
    assert.strictEqual(r.result, 6);
  });

  // ---- 三層一致性（WGSL 假裝置、WebGL2 不適用、CPU） ----
  await check('三層一致性：sum_dd 的 WGSL（假）與 CPU 參考版在容差內；scatter_add 逐元素完全相等', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const a = seeded(3000, 131).map(f32r);
    const w = await rt.sumDd(a);
    const c = core.sumDdRef(a);
    assert.ok(Math.abs(w.result - c) <= core.tolerance(a.length) * Math.max(1, Math.abs(c)) + 1e-6, 'sum_dd 差 ' + (w.result - c));
    const idx = seeded(800, 132).map((v) => Math.abs(Math.round(v * 7)) % 9);
    const vals = seeded(800, 133).map(f32r);
    const sw = await rt.scatterAdd(idx, vals, 9);
    assert.deepStrictEqual(sw.result, Array.from(core.scatterAddRef(idx, vals, 9)));
  });

  // ---- 矩陣乘分塊 ----
  await check('matmul 分塊：儲存上限 256 位元組時切塊執行，結果與參考版一致（17×19×21）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ limits: { maxStorageBufferBindingSize: 256 } }).nav, webgl2: null });
    const m = 17, k = 19, n = 21;
    const A = seeded(m * k, 141), B = seeded(k * n, 142);
    const r = await rt.matmul(A, B, m, k, n);
    assert.ok(r.info.chunks > 1, '應該分塊，實際塊數 ' + r.info.chunks);
    assert.strictEqual(r.info.layer, 'T1');
    const ref = core.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n);
    for (let i = 0; i < ref.length; i++) {
      assert.ok(Math.abs(r.result[i] - ref[i]) <= core.tolerance(k) * Math.max(1, Math.abs(ref[i])), '第 ' + i + ' 個差 ' + (r.result[i] - ref[i]));
    }
  });
  await check('matmul 不超過上限時不分塊（chunks 不存在）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const r = await rt.matmul([1, 2, 3, 4], [5, 6, 7, 8], 2, 2, 2);
    assert.strictEqual(r.info.chunks, undefined);
    assert.deepStrictEqual(r.result, [19, 22, 43, 50]);
  });
  await check('matmul 上限小到連一列都放不下：丟出具體錯誤', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ limits: { maxStorageBufferBindingSize: 8 } }).nav, webgl2: null });
    await assert.rejects(rt.matmul(new Array(4).fill(1), new Array(4).fill(1), 1, 4, 1), /無法分塊/);
  });

  // ---- 替代清單與回報 ----
  await check('backendInfo 回報替代清單與 sum_dd、scatter_add 的層', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    await rt.sumDd([1, 2]);
    const info = await rt.backendInfo();
    assert.strictEqual(info.substitutes.sum_dd.kind, 'double-float');
    assert.strictEqual(info.substitutes.scatter_add.kind, 'cas-f32-atomic');
    assert.strictEqual(info.substitutes.matmul.kind, 'chunked');
    assert.strictEqual(info.substitutes.add64.kind, 'two-u32');
    assert.strictEqual(info.ops.sum_dd.layer, 'T1');
    assert.strictEqual(info.ops.scatter_add.layer, null);
    assert.strictEqual(info.ops.scatter_add.webgl2, 'missing');
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
