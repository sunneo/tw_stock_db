// node renderer/src/gpu/nn_ops_test.js
// cudaweb 訓練核心（nn_ops.js）的測試。目前：RMSNorm。
// 注意：假裝置以 CPU 參考版執行 WGSL 核心，所以這裡驗證的是主機端的綁定、回讀與降級流程；WGSL 本身的數值需真機驗證。
'use strict';
const assert = require('assert');
const NN = require('./nn_ops.js');
const { fakeNavigator, fakeGl } = require('./gpu_fakes.js');

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
    assert.ok(r.info.reason.includes('WebGL2'));
    assert.ok(maxAbs(r.result, NN.rmsnormRef(x, g, T, d, eps)) < 1e-12);
  });

  await check('rmsnorm 沒有 WebGPU、有 WebGL2（假上下文）：層為 T3，結果與參考版一致', async () => {
    const r = await NN.rmsnorm(x, g, T, d, eps, { navigator: {}, gl: fakeGl() });
    assert.strictEqual(r.info.layer, 'T3');
    assert.strictEqual(r.info.webgl2, 'native');
    assert.ok(r.info.reason.includes('WebGPU 不可用'), '應寫明為何退到 T3：' + r.info.reason);
    assert.ok(maxAbs(r.result, NN.rmsnormRef(x, g, T, d, eps)) < 1e-6, '差 ' + maxAbs(r.result, NN.rmsnormRef(x, g, T, d, eps)));
  });

  await check('rmsnorm 的 WebGL2 沒有 EXT_color_buffer_float：不走 T3，退到 cpu-js 並寫明原因', async () => {
    const r = await NN.rmsnorm(x, g, T, d, eps, { navigator: {}, gl: fakeGl({ noFloat: true }) });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.strictEqual(r.info.webgl2, 'missing');
    assert.ok(r.info.reason.includes('EXT_color_buffer_float'), r.info.reason);
  });

  await check('WGSL 執行失敗：退回 CPU，原因寫明失敗訊息', async () => {
    // 假裝置的 kernelError 目前只認 @kernel 名稱；這裡用一個會丟錯的 navigator 來模擬分派失敗
    const nav = fakeNavigator({ kernelError: 'rmsnorm' }).nav;
    const r = await NN.rmsnorm(x, g, T, d, eps, { navigator: nav });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.includes('WGSL 執行失敗'), r.info.reason);
    assert.ok(r.info.reason.includes('假核心錯誤'));
  });

  // ---- softmax ----
  const SR = 4, SC = 7;
  const sx = seeded(SR * SC, 3);

  await check('softmaxRef 每列和為 1，且與獨立公式一致', async () => {
    const y = NN.softmaxRef(sx, SR, SC);
    for (let r = 0; r < SR; r++) {
      let s = 0; for (let c = 0; c < SC; c++) s += y[r * SC + c];
      assert.ok(Math.abs(s - 1) < 1e-12, '第 ' + r + ' 列和 ' + s);
      let z = 0; for (let c = 0; c < SC; c++) z += Math.exp(sx[r * SC + c]);
      for (let c = 0; c < SC; c++) assert.ok(Math.abs(y[r * SC + c] - Math.exp(sx[r * SC + c]) / z) < 1e-12);
    }
  });

  await check('softmaxRef 大數值不溢位（減最大值）', async () => {
    const y = NN.softmaxRef([1000, 1001, 1002], 1, 3);
    assert.ok(y.every(Number.isFinite));
    assert.ok(Math.abs(y[0] + y[1] + y[2] - 1) < 1e-12);
  });

  await check('softmax 經 WGSL（假裝置）：層為 T1，結果與參考版一致', async () => {
    const r = await NN.softmax(sx, SR, SC, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1');
    assert.ok(maxAbs(r.result, NN.softmaxRef(sx, SR, SC)) < 1e-6);
  });

  await check('softmax 沒有 WebGPU：退到 cpu-js 並寫明原因', async () => {
    const r = await NN.softmax(sx, SR, SC, { navigator: {} });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.includes('WebGL2'));
  });

  await check('softmax 沒有 WebGPU、有 WebGL2（假上下文）：層為 T3，結果與參考版一致', async () => {
    const r = await NN.softmax(sx, SR, SC, { navigator: {}, gl: fakeGl() });
    assert.strictEqual(r.info.layer, 'T3');
    assert.ok(maxAbs(r.result, NN.softmaxRef(sx, SR, SC)) < 1e-6, '差 ' + maxAbs(r.result, NN.softmaxRef(sx, SR, SC)));
  });

  await check('softmaxRef 形狀不符丟錯', async () => {
    assert.throws(() => NN.softmaxRef(sx.slice(1), SR, SC), /softmax：x 的長度/);
  });

  // ---- SiLU ----
  const sv = seeded(37, 4);

  await check('siluRef 與獨立公式 x·σ(x) 一致，且 silu(0)=0', async () => {
    const y = NN.siluRef(sv);
    for (let i = 0; i < sv.length; i++) {
      const sig = 1 / (1 + Math.exp(-sv[i]));
      assert.ok(Math.abs(y[i] - sv[i] * sig) < 1e-12, '第 ' + i + ' 個');
    }
    assert.strictEqual(NN.siluRef([0])[0], 0);
  });

  await check('silu 經 WGSL（假裝置）：層為 T1，結果與參考版一致（含非 64 的倍數長度）', async () => {
    const r = await NN.silu(sv, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1');
    assert.strictEqual(r.result.length, sv.length);
    assert.ok(maxAbs(r.result, NN.siluRef(sv)) < 1e-6);
  });

  await check('silu 沒有 WebGPU、有 WebGL2（假上下文）：層為 T3，結果與參考版一致', async () => {
    const r = await NN.silu(sv, { navigator: {}, gl: fakeGl() });
    assert.strictEqual(r.info.layer, 'T3');
    assert.strictEqual(r.result.length, sv.length);
    assert.ok(maxAbs(r.result, NN.siluRef(sv)) < 1e-6);
  });

  await check('silu 沒有 WebGPU：退到 cpu-js 並寫明原因', async () => {
    const r = await NN.silu(sv, { navigator: {} });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.includes('WebGL2'));
  });

  // ---- RoPE ----
  const RT = 6, RH = 2, Rhd = 8;
  const rx = seeded(RT * RH * Rhd, 5);

  await check('ropeRef：位置 0 不旋轉（θ=0）；每對維度的長度保持不變（正交）', async () => {
    const y = NN.ropeRef(rx, RT, RH, Rhd, 1);
    for (let i = 0; i < RH * Rhd; i++) assert.ok(Math.abs(y[i] - rx[i]) < 1e-12, '位置 0 第 ' + i);
    // rotate-half：每對是 (i, i+hd/2)
    for (let t = 0; t < RT; t++) for (let h = 0; h < RH; h++) for (let i = 0; i < Rhd / 2; i++) {
      const o = t * RH * Rhd + h * Rhd + i, p = o + Rhd / 2;
      const n0 = Math.hypot(rx[o], rx[p]), n1 = Math.hypot(y[o], y[p]);
      assert.ok(Math.abs(n0 - n1) < 1e-9, '第 t=' + t + ' 對 ' + i + ' 長度改變');
    }
  });

  await check('ropeRef：反向（dir=−1）還原正向結果', async () => {
    const fwd = NN.ropeRef(rx, RT, RH, Rhd, 1);
    const back = NN.ropeRef(fwd, RT, RH, Rhd, -1);
    assert.ok(maxAbs(back, rx) < 1e-9, '差 ' + maxAbs(back, rx));
  });

  await check('rope 經 WGSL（假裝置）：層為 T1，結果與參考版一致', async () => {
    const r = await NN.rope(rx, RT, RH, Rhd, 1, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1');
    assert.ok(maxAbs(r.result, NN.ropeRef(rx, RT, RH, Rhd, 1)) < 1e-5, '差 ' + maxAbs(r.result, NN.ropeRef(rx, RT, RH, Rhd, 1)));
  });

  await check('rope 沒有 WebGPU、有 WebGL2（假上下文）：層為 T3，結果與參考版一致（正向與反向）', async () => {
    for (const dir of [1, -1]) {
      const r = await NN.rope(rx, RT, RH, Rhd, dir, { navigator: {}, gl: fakeGl() });
      assert.strictEqual(r.info.layer, 'T3');
      assert.ok(maxAbs(r.result, NN.ropeRef(rx, RT, RH, Rhd, dir)) < 1e-5, 'dir=' + dir + ' 差 ' + maxAbs(r.result, NN.ropeRef(rx, RT, RH, Rhd, dir)));
    }
  });

  await check('rope 沒有 WebGPU：退到 cpu-js 並寫明原因', async () => {
    const r = await NN.rope(rx, RT, RH, Rhd, -1, { navigator: {} });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.includes('WebGL2'));
  });

  await check('rope：hd 為奇數直接丟錯', async () => {
    assert.throws(() => NN.ropeRef(new Float32Array(RT * RH * 7), RT, RH, 7, 1), /hd 必須是偶數/);
  });

  // ---- AdamW ----
  const AN = 19;
  const ap = seeded(AN, 6), ag = seeded(AN, 7), am = seeded(AN, 8).map((x) => x * 0.1), av = seeded(AN, 9).map((x) => Math.abs(x) * 0.1);
  const A = { t: 3, lr: 0.01, b1: 0.9, b2: 0.999, eps: 1e-8, wd: 0.01 };

  await check('adamwRef（wd=0）與 lora_ref_train.js 的 adamStep 公式逐元素一致', async () => {
    const L = require('../studio/lora_ref_train.js');
    const pp = Float64Array.from(ap), mm = Float64Array.from(am), vv = Float64Array.from(av);
    // adamStep 需要整個模型結構；這裡照它的公式（同一組常數）逐元素算一步作為獨立參考
    const b1 = A.b1, b2 = A.b2, c1 = 1 - Math.pow(b1, A.t), c2 = 1 - Math.pow(b2, A.t);
    for (let i = 0; i < AN; i++) {
      const m2 = b1 * mm[i] + (1 - b1) * ag[i], v2 = b2 * vv[i] + (1 - b2) * ag[i] * ag[i];
      mm[i] = m2; vv[i] = v2;
      pp[i] -= A.lr * (m2 / c1) / (Math.sqrt(v2 / c2) + A.eps);
    }
    const r = NN.adamwRef(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, 0);
    assert.ok(maxAbs(r.p, pp) < 1e-12 && maxAbs(r.m, mm) < 1e-12 && maxAbs(r.v, vv) < 1e-12, 'wd=0 與 adamStep 公式不一致');
    assert.ok(L && typeof L.adamStep === 'function');
  });

  await check('adamwRef：權重衰減使參數朝 0 收縮（wd>0 與 wd=0 不同）', async () => {
    const r0 = NN.adamwRef(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, 0);
    const r1 = NN.adamwRef(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, 0.1);
    assert.ok(maxAbs(r0.p, r1.p) > 0, '衰減沒有生效');
    for (let i = 0; i < AN; i++) assert.ok(Math.abs(r1.p[i]) <= Math.abs(r0.p[i]) + 1e-12 || Math.abs(ap[i]) < 1e-9, '第 ' + i + ' 個沒有收縮');
  });

  await check('adamw 經 WGSL（假裝置）：層為 T1，p、m、v 三個輸出都與參考版一致', async () => {
    const r = await NN.adamw(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, A.wd, { navigator: fakeNavigator().nav });
    assert.strictEqual(r.info.layer, 'T1');
    const ref = NN.adamwRef(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, A.wd);
    assert.ok(maxAbs(r.result.p, ref.p) < 1e-6 && maxAbs(r.result.m, ref.m) < 1e-6 && maxAbs(r.result.v, ref.v) < 1e-6);
  });

  await check('adamw 沒有 WebGPU、有 WebGL2（假上下文）：層為 T3，p、m、v 三個輸出都與參考版一致', async () => {
    const r = await NN.adamw(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, A.wd, { navigator: {}, gl: fakeGl() });
    assert.strictEqual(r.info.layer, 'T3');
    const ref = NN.adamwRef(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, A.wd);
    assert.ok(maxAbs(r.result.p, ref.p) < 1e-6 && maxAbs(r.result.m, ref.m) < 1e-6 && maxAbs(r.result.v, ref.v) < 1e-6);
  });

  await check('adamw 沒有 WebGPU：退到 cpu-js 並寫明原因', async () => {
    const r = await NN.adamw(ap, ag, am, av, A.t, A.lr, A.b1, A.b2, A.eps, A.wd, { navigator: {} });
    assert.strictEqual(r.info.layer, 'cpu-js');
    assert.ok(r.info.reason.includes('WebGL2'));
  });

  // ---- 批次提交 ----
  await check('批次：rmsnorm → silu → softmax 連續運算，只 submit 一次、只回讀一次，結果與逐一呼叫一致', async () => {
    const nav = fakeNavigator().nav;
    const g0 = await NN.getDevice(nav);
    const dev = g0.dev;
    let submits = 0, maps = 0;
    const realSubmit = dev.queue.submit.bind(dev.queue);
    dev.queue.submit = (cmds) => { submits++; return realSubmit(cmds); };
    const T = 4, d = 6;
    const x = seeded(T * d, 11), gg = seeded(d, 12);
    const b = NN.createBatch(dev);
    const xb = b.upload(x), gb = b.upload(gg);
    const n1 = b.rmsnorm(xb, gb, T, d, 1e-6);
    const s1 = b.silu(n1);
    const s2 = b.softmax(s1, T, d);
    const [out] = await b.read([[s2, T * d]]);
    maps = b.stats.readbacks;
    assert.strictEqual(submits, 1, '應只 submit 一次，實際 ' + submits);
    assert.strictEqual(b.stats.dispatches, 3);
    assert.strictEqual(maps, 1, '應只回讀一次');
    // 逐一呼叫的參考（每步都在主機上）
    const ref = NN.softmaxRef(NN.siluRef(NN.rmsnormRef(x, gg, T, d, 1e-6)), T, d);
    assert.ok(maxAbs(out, ref) < 1e-6, '差 ' + maxAbs(out, ref));
    dev.queue.submit = realSubmit;
  });

  await check('批次含矩陣乘（純量與 vec4 兩路）：一次 submit、結果與參考版一致', async () => {
    const dev = (await NN.getDevice(fakeNavigator().nav)).dev;
    const realSubmit = dev.queue.submit.bind(dev.queue); let submits = 0;
    dev.queue.submit = (cmds) => { submits++; return realSubmit(cmds); };
    for (const [M, K, N] of [[5, 8, 12], [3, 7, 5]]) {   // 第一組 K、N 為 4 的倍數走 vec4，第二組走純量
      submits = 0;
      const A = seeded(M * K, 31), B = seeded(K * N, 37);
      const b = NN.createBatch(dev);
      const ab = b.upload(A), bb = b.upload(B);
      const y = b.matmul(ab, bb, M, K, N);
      const [out] = await b.read([[y, M * N]]);
      assert.strictEqual(submits, 1, '應只 submit 一次，實際 ' + submits);
      const ref = require('./gpu_core.js').matmulRef(Float32Array.from(A), Float32Array.from(B), M, K, N);
      assert.ok(maxAbs(out, ref) < 1e-5, '矩陣乘差 ' + maxAbs(out, ref));
    }
    dev.queue.submit = realSubmit;
  });

  await check('批次：提交後不能再加入運算或再次讀取', async () => {
    const dev = (await NN.getDevice(fakeNavigator().nav)).dev;
    const b = NN.createBatch(dev);
    const xb = b.upload([1, 2, 3, 4]);
    const y = b.silu(xb);
    await b.read([[y, 4]]);
    assert.throws(() => b.silu(xb), /已經提交/);
    await assert.rejects(b.read([[y, 4]]), /已經提交過/);
  });

  await check('形狀不符：直接丟錯（不降級，避免默默算錯）', async () => {
    assert.throws(() => NN.rmsnormRef(x.slice(1), g, T, d, eps), /x 的長度/);
    assert.throws(() => NN.rmsnormRef(x, g.slice(1), T, d, eps), /g 的長度/);
  });

  // ---- 三層狀態回報 ----
  await check('nnBackendInfo：有 WebGPU 與 WebGL2 時，五個核心的 t1、t3 都是 native；cpu 永遠 native', async () => {
    const info = await NN.nnBackendInfo({ navigator: fakeNavigator().nav, gl: fakeGl() });
    assert.strictEqual(info.webgpu.available, true);
    assert.strictEqual(info.webgl2.available, true);
    for (const op of NN.NN_OPS) assert.deepStrictEqual(info.ops[op], { t1: 'native', t3: 'native', cpu: 'native' }, op);
  });

  await check('nnBackendInfo：只有 WebGL2（沒有 WebGPU）時，t1 missing 並寫明原因', async () => {
    const info = await NN.nnBackendInfo({ navigator: {}, gl: fakeGl() });
    assert.strictEqual(info.webgpu.available, false);
    assert.ok(info.webgpu.reason.includes('WebGPU 不可用'));
    assert.strictEqual(info.ops.silu.t1, 'missing');
    assert.strictEqual(info.ops.silu.t3, 'native');
  });

  await check('nnBackendInfo：WebGL2 沒有浮點渲染目標時，t3 missing 並寫明原因', async () => {
    const info = await NN.nnBackendInfo({ navigator: {}, gl: fakeGl({ noFloat: true }) });
    assert.strictEqual(info.webgl2.available, false);
    assert.ok(info.webgl2.reason.includes('EXT_color_buffer_float'));
    assert.strictEqual(info.ops.rope.t3, 'missing');
  });

  // ---- 用途旗標（回歸：真機發現 axpy 的來源緩衝缺 COPY_SRC）----
  await check('假裝置拒絕從缺 COPY_SRC 的緩衝複製（回歸：axpy 的 bug 在單元測試就會抓到）', async () => {
    const dev = (await NN.getDevice(fakeNavigator().nav)).dev;
    const src = dev.createBuffer({ size: 16, usage: 0x80 | 0x8 }); // STORAGE|COPY_DST，缺 COPY_SRC
    const dst = dev.createBuffer({ size: 16, usage: 0x1 | 0x8 });
    const enc = dev.createCommandEncoder();
    assert.throws(() => enc.copyBufferToBuffer(src, 0, dst, 0, 16), /缺少 COPY_SRC/);
  });

  await check('假裝置拒絕 mapAsync 於非 MAP_READ 緩衝、拒絕綁定沒有 STORAGE／UNIFORM 的緩衝', async () => {
    const dev = (await NN.getDevice(fakeNavigator().nav)).dev;
    const plain = dev.createBuffer({ size: 16, usage: 0x8 });
    await assert.rejects(plain.mapAsync(1), /缺少 MAP_READ/);
    const copyOnly = dev.createBuffer({ size: 16, usage: 0x4 | 0x8 });
    assert.throws(() => dev.createBindGroup({ layout: {}, entries: [{ binding: 0, resource: { buffer: copyOnly } }] }), /缺少 STORAGE 或 UNIFORM/);
  });

  await check('axpy 經執行期在假 WebGPU 上走 T1（回歸：不再因 COPY_SRC 降到純 JS）', async () => {
    const core = require('./gpu_core.js');
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const r = await rt.axpy(2, [1, 2, 3, 4], [10, 20, 30, 40]);
    assert.strictEqual(r.info.layer, 'T1', r.info.reason);
    assert.deepStrictEqual(Array.from(r.result), [12, 24, 36, 48]);
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
