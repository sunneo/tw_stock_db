// node renderer/src/gpu/gpu_core.test.js
// 第一階段核心的測試：CPU 參考版、WGSL 原始碼的關鍵字、降級路徑與回報、執行期的錯誤處理。
// 假的 WebGPU（fake navigator.gpu）只驗證「流程」：它依 WGSL 開頭的 @kernel 標記，改用 CPU 參考版算結果。
// 它不驗證 WGSL 本身的正確性；那要在真的 WebGPU 裝置上跑（見 DESIGN.webgpu-cuda.md §8、§9）。
'use strict';
const assert = require('assert');
const core = require('./gpu_core.js');

let pass = 0, fail = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(
    () => { pass++; console.log('ok   ' + name); },
    (e) => { fail++; console.log('FAIL ' + name + '\n     ' + (e && e.stack || e)); }
  );
}
function close(a, b, tol, label) {
  assert.strictEqual(a.length, b.length, (label || '') + ' 長度不同');
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    const rel = d / Math.max(1e-30, Math.abs(b[i]));
    assert.ok(rel <= tol || d <= tol, (label || '') + ' 第 ' + i + ' 個：' + a[i] + ' 與參考 ' + b[i] + ' 差 ' + d);
  }
}

// ---------- 假的 WebGPU ----------
// opts: { limits, adapter: 'ok'|'null'|'throw', deviceError, kernelError, lostPromise }
function fakeNavigator(opts) {
  opts = opts || {};
  const limits = Object.assign({ maxStorageBufferBindingSize: 134217728, maxComputeWorkgroupStorageSize: 16384 }, opts.limits || {});
  let resolveLost = null;
  const lostPromise = new Promise((r) => { resolveLost = r; });
  const dev = {
    limits: limits,
    lost: lostPromise,
    __resolveLost: (info) => resolveLost(info),
    queue: {
      writeBuffer(buf, off, data) { new Uint8Array(buf.data).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), off); },
      submit() {}
    },
    createBuffer({ size, usage }) {
      const b = { size, usage, data: new ArrayBuffer(Math.max(4, size)), destroy() {}, unmap() {} };
      b.mapAsync = async () => {};
      b.getMappedRange = () => b.data;
      return b;
    },
    createShaderModule({ code }) { return { code }; },
    createComputePipeline({ compute }) {
      const m = /@kernel\s+(\w+)/.exec(compute.module.code);
      return { kernel: m ? m[1] : 'unknown', getBindGroupLayout() { return {}; } };
    },
    createBindGroup({ entries }) { return { entries }; },
    createCommandEncoder() {
      const ops = [];
      return {
        beginComputePass() {
          let pipe = null, bg = null;
          return {
            setPipeline(p) { pipe = p; },
            setBindGroup(i, g) { bg = g; },
            dispatchWorkgroups(x, y) {
              ops.push({ pipe, bg, x, y });
            },
            end() {}
          };
        },
        copyBufferToBuffer(src, so, dst, dO, n) {
          new Uint8Array(dst.data).set(new Uint8Array(src.data, so, n), dO);
        },
        finish() { return ops; }
      };
    },
    pushErrorScope() {},
    popErrorScope: async () => null
  };
  // 在 submit 時執行 dispatch（假裝置把 pass 記下的工作照順序跑掉）
  dev.queue.submit = (cmds) => {
    for (const ops of cmds) for (const op of ops) runKernel(op);
  };
  function f32(buf, n) { return new Float32Array(buf.data, 0, n); }
  function u32(buf) { return new Uint32Array(buf.data); }
  function runKernel(op) {
    if (opts.kernelError && op.pipe.kernel === opts.kernelError) throw new Error('假核心錯誤');
    const e = op.bg.entries.map((x) => x.resource.buffer);
    const k = op.pipe.kernel;
    if (k === 'vector_add') {
      const n = u32(e[3])[0];
      const out = core.vectorAddRef(f32(e[0], n), f32(e[1], n));
      f32(e[2], n).set(out);
    } else if (k === 'matmul') {
      const p = u32(e[3]); const m = p[0], kk = p[1], n = p[2];
      const out = core.matmulRef(f32(e[0], m * kk), f32(e[1], kk * n), m, kk, n);
      f32(e[2], m * n).set(out);
    } else if (k === 'sum') {
      const n = u32(e[2])[0];
      const inp = f32(e[0], n);
      const groups = op.x;
      const out = f32(e[1], groups);
      const stride = 256 * groups;
      for (let g = 0; g < groups; g++) {
        let acc = 0;
        for (let i = g * 256; i < n; i += stride) for (let j = 0; j < 256 && i + j < n; j++) acc = Math.fround(acc + inp[i + j]);
        out[g] = acc;
      }
    } else {
      throw new Error('假裝置不認得核心：' + k);
    }
  }
  const adapter = {
    features: new Set(opts.features || []),
    limits: limits,
    info: { vendor: 'fake' },
    requestDevice: async () => {
      if (opts.deviceError) throw new Error(opts.deviceError);
      return dev;
    }
  };
  const gpu = {
    requestAdapter: async () => {
      if (opts.adapter === 'throw') throw new Error('介面卡探測爆炸');
      if (opts.adapter === 'null') return null;
      return adapter;
    }
  };
  return { nav: { gpu: gpu }, dev: dev };
}

function seeded(n, seed) {
  let s = seed >>> 0 || 1; const out = [];
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out.push(((s % 20001) - 10000) / 1000); }
  return out;
}

(async () => {
  // ---- 參考版與容差 ----
  await check('CPU 向量加參考版', () => {
    const r = core.vectorAddRef(Float32Array.from([1, 2, 3]), Float32Array.from([10, 20, 30]));
    assert.deepStrictEqual(Array.from(r), [11, 22, 33]);
  });
  await check('CPU 矩陣乘參考版（2×3 乘 3×2）', () => {
    // [[1,2,3],[4,5,6]] × [[7,8],[9,10],[11,12]] = [[58,64],[139,154]]
    const r = core.matmulRef(Float32Array.from([1, 2, 3, 4, 5, 6]), Float32Array.from([7, 8, 9, 10, 11, 12]), 2, 3, 2);
    assert.deepStrictEqual(Array.from(r), [58, 64, 139, 154]);
  });
  await check('CPU 歸約參考版與高精度參考', () => {
    assert.strictEqual(core.sumRef([1, 2, 3, 4]), 10);
    assert.strictEqual(core.sumExact([1, 2, 3, 4]), 10);
  });
  await check('容差隨 k 增加、且為正數（暫定規則）', () => {
    assert.ok(core.tolerance(1) > 0);
    assert.ok(core.tolerance(4096) > core.tolerance(16));
  });

  // ---- WGSL 原始碼（靜態檢查） ----
  await check('WGSL 核心含 workgroup 大小與屏障、歸約用 num_workgroups', () => {
    assert.ok(core.kernels.vector_add.includes('@workgroup_size(256)'));
    assert.ok(core.kernels.matmul.includes('@workgroup_size(16, 16, 1)'));
    assert.ok(core.kernels.matmul.split('workgroupBarrier()').length - 1 === 2, '矩陣乘應有兩個屏障');
    assert.ok(core.kernels.sum.includes('workgroupBarrier()'));
    assert.ok(core.kernels.sum.includes('num_workgroups'));
    assert.ok(core.kernels.sum.includes('// @kernel sum'));
  });

  // ---- 沒有 WebGPU 時降級 ----
  await check('沒有 navigator.gpu：降到 T4，原因寫明，結果仍正確', async () => {
    const rt = core.createRuntime({ navigator: {} });
    const r = await rt.vectorAdd([1, 2], [3, 4]);
    assert.deepStrictEqual(r.result, [4, 6]);
    assert.strictEqual(r.info.layer, 'T4');
    assert.strictEqual(r.info.via, 'cpu-fallback');
    assert.ok(r.info.reason.includes('沒有 WebGPU'));
  });
  await check('介面卡為空：原因是沒有顯示卡介面卡', async () => {
    const f = fakeNavigator({ adapter: 'null' });
    const rt = core.createRuntime({ navigator: f.nav });
    const r = await rt.sum([1, 2, 3]);
    assert.strictEqual(r.result, 6);
    assert.strictEqual(r.info.layer, 'T4');
    assert.ok(r.info.reason.includes('沒有可用的顯示卡介面卡'));
  });
  await check('requestAdapter 丟例外：原因帶上錯誤文字', async () => {
    const f = fakeNavigator({ adapter: 'throw' });
    const rt = core.createRuntime({ navigator: f.nav });
    const r = await rt.sum([5]);
    assert.strictEqual(r.info.layer, 'T4');
    assert.ok(r.info.reason.includes('介面卡探測爆炸'));
  });
  await check('requestDevice 失敗：原因帶上錯誤文字', async () => {
    const f = fakeNavigator({ deviceError: '裝置遺失於啟動' });
    const rt = core.createRuntime({ navigator: f.nav });
    const r = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r.info.layer, 'T4');
    assert.ok(r.info.reason.includes('要求 WebGPU 裝置失敗：裝置遺失於啟動'));
  });

  // ---- 假 WebGPU 可用：T1 ----
  await check('向量加在 T1 執行，結果與參考版一致', async () => {
    const f = fakeNavigator();
    const rt = core.createRuntime({ navigator: f.nav });
    const a = seeded(1000, 7), b = seeded(1000, 9);
    const r = await rt.vectorAdd(a, b);
    assert.strictEqual(r.info.layer, 'T1');
    assert.strictEqual(r.info.via, 'wgsl-native');
    assert.strictEqual(r.info.reason, '');
    close(r.result, Array.from(core.vectorAddRef(Float32Array.from(a), Float32Array.from(b))), 0, 'vector_add');
  });
  await check('矩陣乘在 T1 執行，形狀不是 16 的倍數（邊界檢查）', async () => {
    const f = fakeNavigator();
    const rt = core.createRuntime({ navigator: f.nav });
    const m = 17, k = 19, n = 21;
    const A = seeded(m * k, 3), B = seeded(k * n, 5);
    const r = await rt.matmul(A, B, m, k, n);
    assert.strictEqual(r.info.layer, 'T1');
    const ref = core.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n);
    close(r.result, Array.from(ref), core.tolerance(k), 'matmul');
  });
  await check('歸約在 T1 執行（1000 個元素，需要兩輪），誤差在容差內', async () => {
    const f = fakeNavigator();
    const rt = core.createRuntime({ navigator: f.nav });
    const a = seeded(1000, 11);
    const r = await rt.sum(a);
    assert.strictEqual(r.info.layer, 'T1');
    const exact = core.sumExact(a);
    assert.ok(Math.abs(r.result - exact) <= core.tolerance(a.length) * Math.max(1, Math.abs(exact)) + 1e-3, '歸約誤差：' + r.result + ' 與 ' + exact);
    assert.strictEqual(r.info.reductionOrder, 'tree-wg256');
  });

  // ---- 降級路徑 ----
  await check('儲存緩衝超過上限：降到 T4，原因列出需要與上限', async () => {
    const f = fakeNavigator({ limits: { maxStorageBufferBindingSize: 64 } });
    const rt = core.createRuntime({ navigator: f.nav });
    const a = new Array(100).fill(1);
    const r = await rt.vectorAdd(a, a);
    assert.strictEqual(r.info.layer, 'T4');
    assert.ok(r.info.reason.includes('超過裝置的儲存緩衝上限'));
    assert.strictEqual(r.result.length, 100);
    assert.strictEqual(r.result[0], 2);
  });
  await check('核心執行失敗：降到 T4，原因帶上錯誤，結果仍正確', async () => {
    const f = fakeNavigator({ kernelError: 'matmul' });
    const rt = core.createRuntime({ navigator: f.nav });
    const A = [1, 2, 3, 4], B = [5, 6, 7, 8];
    const r = await rt.matmul(A, B, 2, 2, 2);
    assert.strictEqual(r.info.layer, 'T4');
    assert.ok(r.info.reason.includes('WGSL 核心執行失敗'));
    assert.ok(r.info.reason.includes('假核心錯誤'));
    assert.deepStrictEqual(r.result, [19, 22, 43, 50]);
  });
  await check('裝置遺失：之後的呼叫改用 T4，原因寫明遺失', async () => {
    const f = fakeNavigator();
    const rt = core.createRuntime({ navigator: f.nav });
    const r1 = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r1.info.layer, 'T1');
    f.dev.__resolveLost({ message: 'test loss' });
    await new Promise((r) => setImmediate(r));
    const r2 = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r2.info.layer, 'T4');
    assert.ok(r2.info.reason.includes('裝置遺失'));
    assert.ok(r2.info.reason.includes('test loss'));
  });

  // ---- 輸入檢查與回報 ----
  await check('向量長度不同：丟出具體錯誤（不降級）', async () => {
    const rt = core.createRuntime({ navigator: {} });
    await assert.rejects(rt.vectorAdd([1, 2], [1]), /長度不同（2 與 1）/);
  });
  await check('矩陣元素數與形狀不符：丟出具體錯誤', async () => {
    const rt = core.createRuntime({ navigator: {} });
    await assert.rejects(rt.matmul([1, 2, 3], [1, 2], 2, 2, 1), /A 的元素數 3 與 m×k=4 不符/);
  });
  await check('非有限數字：丟出具體錯誤', async () => {
    const rt = core.createRuntime({ navigator: {} });
    await assert.rejects(rt.sum([1, NaN]), /不是有限數字/);
  });
  await check('backendInfo 回報降級紀錄與最後一次呼叫', async () => {
    const f = fakeNavigator({ limits: { maxStorageBufferBindingSize: 64 } });
    const rt = core.createRuntime({ navigator: f.nav });
    await rt.vectorAdd(new Array(100).fill(1), new Array(100).fill(1));
    const info = await rt.backendInfo();
    assert.strictEqual(info.hasWebGPU, true);
    assert.strictEqual(info.hasAdapter, true);
    assert.strictEqual(info.last.layer, 'T4');
    assert.strictEqual(info.degradeLog.length, 1);
    assert.strictEqual(info.degradeLog[0].op, 'vector_add');
  });

  await check('登錄表 webgpuTierProbe：無 WebGPU 時 reason 必填、結構合法；有裝置時可用', async () => {
    const bc = require('../studio/backend_core.js');
    const rt = core.createRuntime({ navigator: {} });
    await rt.vectorAdd([1], [2]);
    const p1 = bc.webgpuTierProbe(await rt.backendInfo());
    assert.strictEqual(p1.available, false);
    assert.ok(p1.reason.includes('沒有 WebGPU'));
    assert.deepStrictEqual(bc.validateProbeResult(p1), []);
    const f = fakeNavigator();
    const rt2 = core.createRuntime({ navigator: f.nav });
    await rt2.vectorAdd([1], [2]);
    const p2 = bc.webgpuTierProbe(await rt2.backendInfo());
    assert.strictEqual(p2.available, true);
    assert.ok(!p2.reason, '可用時不應有 reason（probeResult 只在有原因時才寫入）');
    assert.deepStrictEqual(bc.validateProbeResult(p2), []);
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
