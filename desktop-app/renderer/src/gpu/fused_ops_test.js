// node renderer/src/gpu/fused_ops_test.js
// O7 融合核心的測試：每個融合核心對「未融合的組合」逐元素比對，相對誤差 ≤1e-6。
// 注意：假裝置依 @kernel 標記，用 fused_ops.js 的 CPU 參考版算結果，所以這裡驗證的是：
//   主機端的綁定順序、派發數、一次提交、參考版的演算法（融合版與未融合版在數學上相同）、與既有量化規則一致。
// WGSL 本身沒有在真 GPU 上驗證（這台沒有 CUDA，也沒有跑過真 Chrome），真機驗證另外做。
'use strict';
const assert = require('assert');
const NN = require('./nn_ops.js');
const FO = require('./fused_ops.js');
const INF = require('./infer_ops.js');
const { fakeNavigator } = require('./gpu_fakes.js');

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('ok   ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.message || e)); }
}
function seeded(n, seed, scale) {
  let s = seed >>> 0 || 1; const out = new Float32Array(n);
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out[i] = Math.fround(((s % 2001) - 1000) / 1000 * (scale || 2)); }
  return out;
}
// 相對誤差：max |a−b| / max(|b|, 1e-30)（b 是未融合的對照）
function relErr(a, b) {
  assert.strictEqual(a.length, b.length, '長度不同 ' + a.length + ' 對 ' + b.length);
  let m = 0;
  for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i]) / Math.max(Math.abs(b[i]), 1e-30));
  return m;
}
function maxAbs(a, b) { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; }
const TOL = 1e-6;

// 在假裝置上跑一個批次：build(b) 回傳要讀回的 [句柄, 元素數] 清單；回傳讀回結果、派發數、submit 次數
async function runBatch(dev, build) {
  let submits = 0;
  const real = dev.queue.submit.bind(dev.queue);
  dev.queue.submit = (cmds) => { submits++; return real(cmds); };
  try {
    const b = NN.createBatch(dev);
    const specs = build(b);
    const outs = await b.read(specs);
    return { outs: outs, dispatches: b.stats.dispatches, submits: submits };
  } finally {
    dev.queue.submit = real;
  }
}

(async () => {
  // ---------- CPU 參考版 ----------
  await check('silu×up 參考版與 siluRef×up（兩步、雙精度）一致', async () => {
    const gate = seeded(101, 3, 4), up = seeded(101, 4, 3);
    const want = NN.siluRef(gate);
    const ref = new Float64Array(gate.length);
    for (let i = 0; i < gate.length; i++) ref[i] = want[i] * up[i];
    assert.ok(relErr(FO.siluMulRef(gate, up), ref) <= TOL);
  });

  await check('rmsq 參考版與「rmsnormRef → 既有 infer_ops.quantizeDynamicRef」逐元素一致（q 精確相等）', async () => {
    for (const [d, seed] of [[1, 5], [37, 6], [300, 7]]) {
      const x = seeded(d, seed, 5), g = seeded(d, seed + 100, 2);
      const fused = FO.rmsQuantFusedRef(x, g, d, 1e-6);
      const yRef = Float32Array.from(NN.rmsnormRef(x, g, 1, d, 1e-6));
      assert.ok(maxAbs(fused.y, yRef) <= 1e-6 * 4, 'y 差 ' + maxAbs(fused.y, yRef));
      const qz = INF.quantizeDynamicRef(fused.y);
      let mism = 0;
      for (let i = 0; i < d; i++) if (fused.q[i] !== qz.q[i] - qz.zp) mism++;
      assert.strictEqual(mism, 0, 'd=' + d + ' 的 q 有 ' + mism + ' 個不同');
      assert.strictEqual(fused.st[2], qz.scale === 0 ? 1 : qz.scale, 'scale');
      assert.strictEqual(fused.st[3], qz.zp, 'zp');
    }
  });

  await check('rmsq 零輸入：scale 記 1、zp 記 0、q 全為 0（與既有規則一致）', async () => {
    const r = FO.rmsQuantFusedRef(new Float32Array(8), seeded(8, 9), 8, 1e-6);
    assert.deepStrictEqual(Array.from(r.st), [0, 0, 1, 0]);
    assert.ok(r.q.every((v) => v === 0));
  });

  await check('RoPE 併進 QKV 參考版與分開的 ropeRef（q、k）＋ v 複製一致', async () => {
    const T = 5, H = 4, Hkv = 2, hd = 8;
    const q = seeded(T * H * hd, 11), k = seeded(T * Hkv * hd, 12), v = seeded(T * Hkv * hd, 13);
    const r = FO.ropeQkvRef(q, k, v, T, H, Hkv, hd);
    assert.ok(relErr(r.q, NN.ropeRef(q, T, H, hd, 1)) <= TOL, 'q 相對誤差');
    assert.ok(relErr(r.k, NN.ropeRef(k, T, Hkv, hd, 1)) <= TOL, 'k 相對誤差');
    assert.deepStrictEqual(Array.from(r.v), Array.from(v));
  });

  await check('線上 softmax 參考版與 softmaxRef 一致（一般值與 ±300 的極端值）', async () => {
    const rows = 70, cols = 9;
    const x = seeded(rows * cols, 21, 3);
    assert.ok(relErr(FO.softmaxOnlineRef(x, rows, cols), NN.softmaxRef(x, rows, cols)) <= TOL);
    const xe = seeded(rows * cols, 22, 300);
    const ye = FO.softmaxOnlineRef(xe, rows, cols);
    const re = NN.softmaxRef(xe, rows, cols);
    assert.ok(relErr(ye, re) <= TOL, '極端值相對誤差 ' + relErr(ye, re));
    for (let r = 0; r < rows; r++) {
      let s = 0; for (let c = 0; c < cols; c++) s += ye[r * cols + c];
      assert.ok(Math.abs(s - 1) < 1e-6, '第 ' + r + ' 列和 ' + s);
    }
  });

  await check('形狀不符：參考版直接丟錯，不默默算錯', async () => {
    assert.throws(() => FO.siluMulRef(new Float32Array(3), new Float32Array(2)), /長度不同/);
    assert.throws(() => FO.rmsQuantFusedRef(new Float32Array(4), new Float32Array(3), 4, 1e-6), /g 的長度/);
    assert.throws(() => FO.ropeQkvRef(new Float32Array(6), new Float32Array(4), new Float32Array(4), 1, 2, 1, 3), /hd 必須是偶數/);
    assert.throws(() => FO.softmaxOnlineRef(new Float32Array(5), 2, 3), /x 的長度/);
  });

  // ---------- 假裝置上的融合 vs 未融合（同一個批次機制）----------
  const nav = fakeNavigator().nav;
  const dev = (await NN.getDevice(nav)).dev;

  await check('silu×up：融合（1 次派發）對未融合 silu＋乘法（2 次派發）相對誤差 ≤1e-6，一次 submit', async () => {
    const n = 101;
    const gate = seeded(n, 31, 4), up = seeded(n, 32, 3);
    const f = await runBatch(dev, (b) => {
      const y = FO.siluMulFused(b, b.upload(gate), b.upload(up));
      return [[y, n]];
    });
    const u = await runBatch(dev, (b) => {
      const y = FO.siluMulUnfused(b, b.upload(gate), b.upload(up));
      return [[y, n]];
    });
    assert.strictEqual(f.dispatches, 1, '融合應為 1 次派發，實際 ' + f.dispatches);
    assert.strictEqual(u.dispatches, 2, '未融合應為 2 次派發，實際 ' + u.dispatches);
    assert.strictEqual(f.submits, 1); assert.strictEqual(u.submits, 1);
    const err = relErr(f.outs[0], u.outs[0]);
    assert.ok(err <= TOL, 'silu×up 相對誤差 ' + err);
    assert.ok(relErr(f.outs[0], FO.siluMulRef(gate, up)) <= TOL);
  });

  await check('RMSNorm＋動態量化（單列）：融合（1 次）對 rmsnorm＋qdyn_stats＋qdyn（3 次）；y 相對誤差 ≤1e-6、q 與 st 精確相等', async () => {
    for (const [d, seed] of [[37, 41], [300, 42]]) {
      const x = seeded(d, seed, 5), g = seeded(d, seed + 7, 2);
      const f = await runBatch(dev, (b) => {
        const r = FO.rmsQuantFusedBatch(b, b.upload(x), b.upload(g), d, 1e-6);
        return [[r.y, d], [r.q, d], [r.q.st, 4]];
      });
      const u = await runBatch(dev, (b) => {
        const r = FO.rmsQuantUnfusedBatch(b, b.upload(x), b.upload(g), d, 1e-6);
        return [[r.y, d], [r.q, d], [r.q.st, 4]];
      });
      assert.strictEqual(f.dispatches, 1, '融合應為 1 次派發，實際 ' + f.dispatches);
      assert.strictEqual(u.dispatches, 3, '未融合應為 3 次派發，實際 ' + u.dispatches);
      assert.strictEqual(f.submits, 1); assert.strictEqual(u.submits, 1);
      const yErr = relErr(f.outs[0], u.outs[0]);
      assert.ok(yErr <= TOL, 'd=' + d + ' y 相對誤差 ' + yErr);
      const qf = new Int32Array(f.outs[1].buffer, f.outs[1].byteOffset, d);
      const qu = new Int32Array(u.outs[1].buffer, u.outs[1].byteOffset, d);
      let mism = 0; for (let i = 0; i < d; i++) if (qf[i] !== qu[i]) mism++;
      assert.strictEqual(mism, 0, 'd=' + d + ' q 不一致 ' + mism + ' 個');
      assert.ok(relErr(f.outs[2], u.outs[2]) <= TOL, 'st 不一致');
      const ref = FO.rmsQuantFusedRef(x, g, d, 1e-6);
      assert.ok(relErr(f.outs[0], ref.y) <= TOL);
    }
  });

  await check('RoPE 併進 QKV：融合（1 次）對 rope(q)＋rope(k)＋copy(v)（3 次）相對誤差 ≤1e-6，一次 submit', async () => {
    for (const [T, H, Hkv, hd] of [[5, 4, 2, 8], [3, 6, 3, 4], [1, 2, 1, 16]]) {
      const q = seeded(T * H * hd, 51 + T), k = seeded(T * Hkv * hd, 61 + T), v = seeded(T * Hkv * hd, 71 + T);
      const nq = T * H * hd, nk = T * Hkv * hd;
      const f = await runBatch(dev, (b) => {
        const r = FO.ropeQkvFused(b, b.upload(q), b.upload(k), b.upload(v), T, H, Hkv, hd);
        return [[r.q, nq], [r.k, nk], [r.v, nk]];
      });
      const u = await runBatch(dev, (b) => {
        const r = FO.ropeQkvUnfused(b, b.upload(q), b.upload(k), b.upload(v), T, H, Hkv, hd);
        return [[r.q, nq], [r.k, nk], [r.v, nk]];
      });
      const tag = 'T=' + T + ' H=' + H + ' Hkv=' + Hkv + ' hd=' + hd;
      assert.strictEqual(f.dispatches, 1, tag + ' 融合應為 1 次派發，實際 ' + f.dispatches);
      assert.strictEqual(u.dispatches, 3, tag + ' 未融合應為 3 次派發，實際 ' + u.dispatches);
      assert.strictEqual(f.submits, 1); assert.strictEqual(u.submits, 1);
      assert.ok(relErr(f.outs[0], u.outs[0]) <= TOL, tag + ' q 相對誤差 ' + relErr(f.outs[0], u.outs[0]));
      assert.ok(relErr(f.outs[1], u.outs[1]) <= TOL, tag + ' k 相對誤差 ' + relErr(f.outs[1], u.outs[1]));
      assert.ok(relErr(f.outs[2], u.outs[2]) <= TOL, tag + ' v 相對誤差 ' + relErr(f.outs[2], u.outs[2]));
    }
  });

  await check('線上 softmax：融合核心對既有 softmax 相對誤差 ≤1e-6（rows 跨越 64 的工作群組邊界，含極端值）', async () => {
    for (const [rows, cols, scale] of [[70, 9, 3], [5, 33, 300]]) {
      const x = seeded(rows * cols, 81 + cols, scale);
      const f = await runBatch(dev, (b) => {
        const y = FO.softmaxOnlineBatch(b, b.upload(x), rows, cols);
        return [[y, rows * cols]];
      });
      const u = await runBatch(dev, (b) => {
        const y = b.softmax(b.upload(x), rows, cols);
        return [[y, rows * cols]];
      });
      assert.strictEqual(f.dispatches, 1); assert.strictEqual(f.submits, 1);
      const err = relErr(f.outs[0], u.outs[0]);
      assert.ok(err <= TOL, 'rows=' + rows + ' cols=' + cols + ' 相對誤差 ' + err);
    }
  });

  await check('融合核心的綁定由假裝置的 @kernel 標記辨識（未知名稱會丟錯；這裡確認各 WGSL 的標記名稱正確）', async () => {
    const want = { fused_silu_mul: FO.WGSL_SILU_MUL, mul: FO.WGSL_MUL_EW, rope_qkv_fused: FO.WGSL_ROPE_QKV, copy: FO.WGSL_COPY, softmax_online: FO.WGSL_SOFTMAX_ONLINE, rmsq_fused: NN.WGSL_RMSQ_FUSED };
    for (const [name, code] of Object.entries(want)) {
      const m = /@kernel\s+(\w+)/.exec(code);
      assert.ok(m && m[1] === name, name + ' 的標記是 ' + (m && m[1]));
    }
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
