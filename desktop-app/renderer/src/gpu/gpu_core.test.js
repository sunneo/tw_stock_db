// node renderer/src/gpu/gpu_core.test.js
// GPU 核心的單元測試（假後端）：能力偵測與能力檔、CPU 參考版、WGSL 與 WebGL2 的流程（假裝置）、降級與回報、
// 預算與排程、第二階段子程式、登錄表對映。假裝置只驗證「流程」與「索引計算」：它依核心原始碼的 @kernel 標記，
// 用 CPU 參考版算出結果。WGSL 與 GLSL 本身的正確性只能在真的 GPU 上驗證（見 DESIGN.webgpu-cuda.md §9）。
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
// opts: { limits, features, isFallback, adapter: 'ok'|'null'|'throw', deviceError, kernelError, noAdapterFeatures }
// 用途旗標檢查（與真實 WebGPU 的驗證錯誤一致）：缺旗標就丟錯，讓 COPY_SRC 之類的 bug 在單元測試就會被抓到
const USE_NAME = { 0x1: 'MAP_READ', 0x4: 'COPY_SRC', 0x8: 'COPY_DST', 0x40: 'UNIFORM', 0x80: 'STORAGE' };
function needUse(buf, flag, what) {
  if (!((buf.usage || 0) & flag)) throw new Error('假裝置用途檢查失敗：' + what + ' 的緩衝區缺少 ' + USE_NAME[flag] + '（實際用途 ' + (buf.usage || 0) + '）');
}
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
      writeBuffer(buf, off, data) { needUse(buf, 0x8, 'writeBuffer'); new Uint8Array(buf.data).set(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), off); },
      submit(cmds) { for (const ops of cmds) for (const op of ops) { if (op.copy) new Uint8Array(op.dst.data).set(new Uint8Array(op.src.data, op.so, op.n), op.dO); else runKernel(op); } }
    },
    createBuffer({ size, usage }) {
      const b = { size, usage, data: new ArrayBuffer(Math.max(4, size)), destroy() {}, unmap() {} };
      b.mapAsync = async () => { needUse(b, 0x1, 'mapAsync'); };
      b.getMappedRange = () => b.data;
      return b;
    },
    createShaderModule({ code }) { return { code }; },
    createComputePipeline({ compute }) {
      const m = /@kernel\s+(\w+)/.exec(compute.module.code);
      return { kernel: m ? m[1] : 'unknown', getBindGroupLayout() { return {}; } };
    },
    createBindGroup({ entries }) {
      for (const e of entries) { if (!((e.resource.buffer.usage || 0) & (0x80 | 0x40))) throw new Error('假裝置用途檢查失敗：binding ' + e.binding + ' 缺少 STORAGE 或 UNIFORM'); }
      return { entries };
    },
    createCommandEncoder() {
      const ops = [];
      return {
        beginComputePass() {
          let pipe = null, bg = null;
          return {
            setPipeline(p) { pipe = p; },
            setBindGroup(i, g) { bg = g; },
            dispatchWorkgroups(x, y) { ops.push({ pipe, bg, x, y }); },
            end() {}
          };
        },
        // 複製在 submit 時依序執行（與真實 WebGPU 相同）；來源要 COPY_SRC、目的要 COPY_DST
        copyBufferToBuffer(src, so, dst, dO, n) {
          needUse(src, 0x4, 'copyBufferToBuffer 的來源'); needUse(dst, 0x8, 'copyBufferToBuffer 的目的');
          ops.push({ copy: true, src: src, so: so, dst: dst, dO: dO, n: n });
        },
        finish() { return ops; }
      };
    },
    pushErrorScope() {},
    popErrorScope: async () => null
  };
  function f32(buf, n) { return new Float32Array(buf.data, 0, n); }
  function u32(buf) { return new Uint32Array(buf.data); }
  function runKernel(op) {
    if (opts.kernelError && op.pipe.kernel === opts.kernelError) throw new Error('假核心錯誤');
    const e = op.bg.entries.map((x) => x.resource.buffer);
    const k = op.pipe.kernel;
    if (k === 'vector_add') {
      const n = u32(e[3])[0];
      f32(e[2], n).set(core.vectorAddRef(f32(e[0], n), f32(e[1], n)));
    } else if (k === 'matmul' || k === 'matmul_vec4') {
      // 參數：B, M, K, N, Bb, azp, bzp, p0（與 gpu_core.js 的 mmTileWords 相同）
      const p = u32(e[3]); const m = p[1], kk = p[2], n = p[3], fl = p[7];
      f32(e[2], m * n).set(core.matmulTRef(f32(e[0], m * kk), f32(e[1], kk * n), m, kk, n, fl));
    } else if (k === 'scan_block') {
      // 參數：IN(n)、OUT(n)、BSUM(groups)、P{n}；每個工作群組 256 個元素做區塊前綴和，並寫出區塊總和
      const n = u32(e[3])[0], IN = f32(e[0], n), OUT = f32(e[1], n), groups = op.x, BS = f32(e[2], groups);
      for (let g = 0; g < groups; g++) {
        let acc = 0;
        for (let i = g * 256; i < Math.min(n, g * 256 + 256); i++) { acc = Math.fround(acc + IN[i]); OUT[i] = acc; }
        BS[g] = acc;
      }
    } else if (k === 'add_offsets') {
      // 參數：OUT(n)、SCAN(groups)、P{n}；區塊 b（b ≥ 1）的每個元素加上 SCAN[b-1]
      const n = u32(e[2])[0], OUT = f32(e[0], n), SC = f32(e[1], Math.ceil(n / 256));
      for (let i = 256; i < n; i++) OUT[i] = Math.fround(OUT[i] + SC[Math.floor(i / 256) - 1]);
    } else if (k === 'transpose') {
      // 參數：A(m×n)、O(n×m)、P{m, n}；與 gpu_core.js 的 transpose 相同的索引
      const p = u32(e[2]); const m = p[0], n = p[1];
      const A = f32(e[0], m * n), O = f32(e[1], m * n);
      for (let i = 0; i < m; i++) for (let j = 0; j < n; j++) O[j * m + i] = A[i * n + j];
    } else if (k === 'gemv_row') {
      // 參數：A(m×n)、X(n)、Y(m)、P{n, m}；與 gpu_core.js 的 gemv_row 相同的列式定義（順序不同，容差比對）
      const p = u32(e[3]); const n = p[0], m = p[1];
      const A = f32(e[0], m * n), X = f32(e[1], n), Y = f32(e[2], m);
      for (let r = 0; r < m; r++) { let acc = 0; for (let j = 0; j < n; j++) acc = Math.fround(acc + Math.fround(A[r * n + j] * X[j])); Y[r] = acc; }
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
    } else if (k === 'axpy' || k === 'scal') {
      const n = u32(e[e.length - 1])[0];
      const alpha = new Float32Array(e[e.length - 1].data, 4, 1)[0];
      if (k === 'axpy') f32(e[1], n).set(core.axpyRef(alpha, f32(e[0], n), f32(e[1], n)));
      else f32(e[0], n).set(core.scalRef(alpha, f32(e[0], n)));
    } else if (k === 'mul') {
      const n = u32(e[3])[0];
      f32(e[2], n).set(core.mulRef(f32(e[0], n), f32(e[1], n)));
    } else if (k === 'user_axpb') {   // 任意核心（numba 的 WGSL）測試用：e[0] 輸入、e[1] 輸出（先加上自己原有的值）、e[2] 輸出 2：out = in * 2 + out；out2 = in + 1
      const n = f32(e[0], 3).length; f32(e[1], n).forEach((v, i, arr) => { arr[i] = f32(e[0], n)[i] * 2 + v; }); f32(e[2], n).forEach((v, i, arr) => { arr[i] = f32(e[0], n)[i] + 1; });
    } else {
      throw new Error('假裝置不認得核心：' + k);
    }
  }
  const adapter = {
    features: new Set(opts.features || []),
    limits: limits,
    isFallbackAdapter: !!opts.isFallback,
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

// ---------- 假的 WebGL2 上下文 ----------
// 用 JS 重現片段著色器的索引語意（與 GLSL 同一套公式），只驗證host端的紋理配置、單元綁定、幀緩衝與讀回流程。
const GLSL_KERNEL_TAG = /@kernel\s+(\w+)/;
function fakeGl(opts) {
  opts = opts || {};
  const maxTex = opts.maxTex || 4096;
  const gl = {
    units: {}, activeUnit: 0, bound: null, fbo: null, uniforms: {}, prog: null, deleted: 0,
    getExtension(name) { if (name === 'EXT_color_buffer_float') return opts.noFloat ? null : {}; return null; },
    getParameter(p) { return p === 0x0D33 ? maxTex : 0; },
    createShader(t) { return { t: t, src: '', ok: true }; },
    shaderSource(s, src) { s.src = src; },
    compileShader(s) { s.ok = !/#FAILCOMPILE/.test(s.src); },
    getShaderParameter(s) { return s.ok; },
    getShaderInfoLog() { return 'fake shader log'; },
    createProgram() { return { shaders: [], kernel: null, ok: false }; },
    attachShader(p, s) { p.shaders.push(s); },
    linkProgram(p) {
      const fs = p.shaders.find((s) => s.t === 0x8B30);
      const m = GLSL_KERNEL_TAG.exec(fs.src);
      p.kernel = m ? m[1] : null;
      p.ok = !!p.kernel;
    },
    getProgramParameter(p) { return p.ok; },
    getProgramInfoLog() { return 'fake program log'; },
    createTexture() { return { w: 0, h: 0, data: null }; },
    bindTexture(target, tex) { gl.bound = tex; gl.units[gl.activeUnit] = tex; },
    texParameteri() {},
    texStorage2D(t, l, f, w, h) { gl.bound.w = w; gl.bound.h = h; gl.bound.data = new Float32Array(w * h * 4); },
    texSubImage2D(t, l, x, y, w, h, f, ty, px) { gl.bound.data.set(px.subarray(0, w * h * 4)); },
    createFramebuffer() { return { tex: null }; },
    bindFramebuffer(t, f) { gl.fbo = f; },
    framebufferTexture2D(t, a, tg, tex) { gl.fbo.tex = tex; },
    checkFramebufferStatus() { return 0x8CD5; },
    useProgram(p) { gl.prog = p; },
    getUniformLocation(p, name) { return name; },
    uniform1i(loc, v) { gl.uniforms[loc] = v; },
    activeTexture(u) { gl.activeUnit = u - 0x84C0; },
    viewport() {},
    drawArrays() {
      if (opts.drawFail && gl.prog.kernel === opts.drawFail) throw new Error('假繪製錯誤');
      const out = gl.fbo.tex;
      const ow = out.w, oh = out.h;
      const tex = (name) => gl.units[gl.uniforms[name]];
      const at = (t, x, y) => t.data[(y * t.w + x) * 4];
      out.data.fill(0);
      const k = gl.prog.kernel;
      for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
        let v = 0;
        if (k === 'vector_add') {
          const W = gl.uniforms.uW, N = gl.uniforms.uN, e = y * W + x;
          v = e >= N ? 0 : at(tex('uA'), x, y) + at(tex('uB'), x, y);
        } else if (k === 'matmul') {
          const K = gl.uniforms.uK;
          for (let t = 0; t < K; t++) v = Math.fround(v + Math.fround(at(tex('uA'), t, y) * at(tex('uB'), x, t)));
        } else if (k === 'sum') {
          const W = gl.uniforms.uW, N = gl.uniforms.uN, OW = gl.uniforms.uOW;
          const j = y * OW + x;
          if (j * 4 < N) for (let q = 0; q < 4; q++) { const e = j * 4 + q; if (e < N) v += at(tex('uA'), e % W, Math.floor(e / W)); }
        }
        out.data[(y * ow + x) * 4] = v;
      }
    },
    readPixels(x, y, w, h, f, ty, px) { px.set(gl.fbo.tex.data.subarray(0, w * h * 4)); },
    deleteTexture() { gl.deleteds = (gl.deleteds || 0) + 1; },
    deleteFramebuffer() {}
  };
  return gl;
}

function seeded(n, seed) {
  let s = seed >>> 0 || 1; const out = [];
  for (let i = 0; i < n; i++) { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; out.push(((s % 20001) - 10000) / 1000); }
  return out;
}

(async () => {
  // ---- 參考版與容差 ----
  await check('CPU 向量加參考版', () => {
    assert.deepStrictEqual(Array.from(core.vectorAddRef(Float32Array.from([1, 2, 3]), Float32Array.from([10, 20, 30]))), [11, 22, 33]);
  });
  await check('CPU 矩陣乘參考版（2×3 乘 3×2）', () => {
    assert.deepStrictEqual(Array.from(core.matmulRef(Float32Array.from([1, 2, 3, 4, 5, 6]), Float32Array.from([7, 8, 9, 10, 11, 12]), 2, 3, 2)), [58, 64, 139, 154]);
  });
  await check('CPU 歸約與第二階段參考版', () => {
    assert.strictEqual(core.sumRef([1, 2, 3, 4]), 10);
    assert.deepStrictEqual(Array.from(core.axpyRef(2, [1, 2], [10, 20])), [12, 24]);
    assert.deepStrictEqual(Array.from(core.scalRef(3, [1, 2])), [3, 6]);
    assert.strictEqual(core.dotRef([1, 2, 3], [4, 5, 6]), 32);
    assert.ok(Math.abs(core.nrm2Ref([3, 4]) - 5) < 1e-6);
    assert.deepStrictEqual(Array.from(core.gemvRef([1, 2, 3, 4], [1, 1], 2, 2)), [3, 7]);
  });
  await check('容差隨 k 增加、且為正數（暫定規則）', () => {
    assert.ok(core.tolerance(1) > 0);
    assert.ok(core.tolerance(4096) > core.tolerance(16));
  });

  // ---- WGSL 與 GLSL 原始碼（靜態檢查） ----
  await check('WGSL 核心含 workgroup 大小與屏障、歸約用 num_workgroups', () => {
    assert.ok(core.kernels.vector_add.includes('@workgroup_size(256)'));
    assert.ok(core.kernels.matmul.includes('@workgroup_size(16, 16, 1)'));
    assert.strictEqual(core.kernels.matmul.split('workgroupBarrier()').length - 1, 2, '矩陣乘應有兩個屏障');
    assert.ok(core.kernels.sum.includes('workgroupBarrier()') && core.kernels.sum.includes('num_workgroups'));
    for (const n of ['axpy', 'scal', 'mul']) assert.ok(core.kernels[n].includes('// @kernel ' + n));
  });
  await check('GLSL 核心都有 @kernel 標記，且使用 texelFetch 與 RGBA 輸出', () => {
    for (const n of ['vector_add', 'matmul', 'sum']) {
      assert.ok(core.glKernels[n].includes('// @kernel ' + n), n);
      assert.ok(core.glKernels[n].includes('texelFetch'), n);
      assert.ok(core.glKernels[n].includes('outColor = vec4'), n);
    }
  });

  // ---- 能力偵測與能力檔 ----
  await check('profileOf：軟體介面卡歸為檔 A', () => {
    const p = core.profileOf({ hasAdapter: true, isFallbackAdapter: true, limits: {}, features: [] }, null);
    assert.strictEqual(p.profile, 'A');
  });
  await check('profileOf：共享記憶體小於 16 KiB 歸為檔 A', () => {
    const p = core.profileOf({ hasAdapter: true, isFallbackAdapter: false, limits: { maxComputeWorkgroupStorageSize: 8192 }, features: [] }, null);
    assert.strictEqual(p.profile, 'A');
    assert.ok(p.reason.includes('8192'));
  });
  await check('profileOf：有 shader-f16 與 subgroups 為檔 C；其他 WebGPU 為檔 B', () => {
    assert.strictEqual(core.profileOf({ hasAdapter: true, limits: { maxComputeWorkgroupStorageSize: 16384 }, features: ['shader-f16', 'subgroups'] }, null).profile, 'C');
    assert.strictEqual(core.profileOf({ hasAdapter: true, limits: { maxComputeWorkgroupStorageSize: 16384 }, features: [] }, null).profile, 'B');
  });
  await check('profileOf：只有 WebGL2 為檔 A；都沒有為 null 並說明原因', () => {
    assert.strictEqual(core.profileOf({ hasAdapter: false }, { available: true }).profile, 'A');
    const none = core.profileOf({ hasAdapter: false }, { available: false });
    assert.strictEqual(none.profile, null);
    assert.ok(none.reason.length > 0);
  });
  await check('probeWebgl2：沒有上下文、缺 EXT_color_buffer_float、可用，三種結果', () => {
    assert.strictEqual(core.probeWebgl2(null).available, false);
    const noFloat = core.probeWebgl2(fakeGl({ noFloat: true }));
    assert.strictEqual(noFloat.available, false);
    assert.ok(noFloat.reason.includes('EXT_color_buffer_float'));
    const ok = core.probeWebgl2(fakeGl({ maxTex: 2048 }));
    assert.strictEqual(ok.available, true);
    assert.strictEqual(ok.maxTextureSize, 2048);
  });

  // ---- 沒有任何 GPU 時降到 T5 ----
  await check('沒有 navigator.gpu 也沒有 WebGL2：降到 T5（純 JS），原因寫明，結果仍正確', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: null });
    const r = await rt.vectorAdd([1, 2], [3, 4]);
    assert.deepStrictEqual(r.result, [4, 6]);
    assert.strictEqual(r.info.layer, 'T5');
    assert.strictEqual(r.info.via, 'cpu-js');
    assert.ok(r.info.reason.includes('沒有 WebGPU'));
    assert.ok(r.info.reason.includes('沒有 WebGL2'));
  });
  await check('介面卡為空：原因是沒有顯示卡介面卡', async () => {
    const f = fakeNavigator({ adapter: 'null' });
    const rt = core.createRuntime({ navigator: f.nav, webgl2: null });
    const r = await rt.sum([1, 2, 3]);
    assert.strictEqual(r.result, 6);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('沒有可用的顯示卡介面卡'));
  });
  await check('requestAdapter 丟例外：原因帶上錯誤文字', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ adapter: 'throw' }).nav, webgl2: null });
    const r = await rt.sum([5]);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('介面卡探測爆炸'));
  });
  await check('requestDevice 失敗：原因帶上錯誤文字', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ deviceError: '裝置遺失於啟動' }).nav, webgl2: null });
    const r = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('要求 WebGPU 裝置失敗：裝置遺失於啟動'));
  });

  // ---- WebGPU（T1） ----
  await check('向量加在 T1 執行，結果與參考版一致', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const a = seeded(1000, 7), b = seeded(1000, 9);
    const r = await rt.vectorAdd(a, b);
    assert.strictEqual(r.info.layer, 'T1');
    assert.strictEqual(r.info.via, 'wgsl-native');
    assert.strictEqual(r.info.reason, '');
    close(r.result, Array.from(core.vectorAddRef(Float32Array.from(a), Float32Array.from(b))), 0, 'vector_add');
  });
  await check('共用平鋪核心：轉置旗標與明確轉置的矩陣乘一致；共用記憶體 8 KiB；f16 版有 enable 行', () => {
    const m = 7, k = 5, n = 4;
    const A = seeded(m * k, 11), B = seeded(k * n, 13);
    const At = []; for (let i = 0; i < m; i++) for (let t = 0; t < k; t++) At[t * m + i] = A[i * k + t];   // A 的儲存為 K×M（transA）
    const Bt = []; for (let t = 0; t < k; t++) for (let j = 0; j < n; j++) Bt[j * k + t] = B[t * n + j];   // B 的儲存為 N×K（transB）
    const plain = core.matmulTRef(A, B, m, k, n, 0);
    assert.deepStrictEqual(Array.from(core.matmulTRef(At, B, m, k, n, 1)), Array.from(plain), 'transA');
    assert.deepStrictEqual(Array.from(core.matmulTRef(A, Bt, m, k, n, 2)), Array.from(plain), 'transB');
    assert.deepStrictEqual(Array.from(core.matmulTRef(At, Bt, m, k, n, 3)), Array.from(plain), 'transA+transB');
    assert.strictEqual(core.mmTileSharedBytes(), 8192);
    assert.ok(core.mmTileSharedBytes() <= 16384, '低階卡的共用記憶體上限');
    const src = core.mmTileWgsl({ marker: 'matmul', dtype: 'f32' });
    assert.ok(src.startsWith('// @kernel matmul\n'), '@kernel 標記');
    assert.strictEqual(src.split('workgroupBarrier()').length - 1, 2, '兩個屏障');
    assert.ok(!/enable f16/.test(src), 'f32 版不該有 enable f16');
    const h = core.mmTileWgsl({ marker: 'matmul_f16', dtype: 'f16' });
    assert.ok(h.startsWith('enable f16;\n// @kernel matmul_f16'), 'f16 版要有 enable 行');
    assert.ok(/array<f16>/.test(h), 'f16 版的輸入是 f16');
    assert.deepStrictEqual(core.mmTileDispatch(70, 90, 3), [2, 2, 3]);
    const v4 = core.mmTileWgslVec4({ marker: 'matmul_vec4' });
    assert.ok(v4.startsWith('// @kernel matmul_vec4\n'), 'vec4 版的 @kernel 標記');
    assert.ok(/array<vec4<f32>>/.test(v4) && v4.split('workgroupBarrier()').length - 1 === 2, 'vec4 版：vec4 綁定與兩個屏障');
    assert.ok(core.mmTileVec4Ok(70, 52, 92, 0) === true, 'K、N 為 4 的倍數、不轉置：可用 vec4');
    assert.ok(core.mmTileVec4Ok(70, 50, 92, 0) === false, 'K 不是 4 的倍數：不可用 vec4');
    assert.ok(core.mmTileVec4Ok(70, 52, 92, 1) === false, '轉置：不可用 vec4（呼叫端退回純量版）');
  });
  await check('矩陣乘在 T1 執行，形狀不是 16 的倍數（邊界檢查）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const m = 17, k = 19, n = 21;
    const A = seeded(m * k, 3), B = seeded(k * n, 5);
    const r = await rt.matmul(A, B, m, k, n);
    assert.strictEqual(r.info.layer, 'T1');
    close(r.result, Array.from(core.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n)), core.tolerance(k), 'matmul');
  });
  await check('矩陣乘 K、N 為 4 的倍數時走 vec4 版，結果與參考版一致（假裝置）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const m = 9, k = 8, n = 12;
    const A = seeded(m * k, 21), B = seeded(k * n, 23);
    const r = await rt.matmul(A, B, m, k, n);
    assert.strictEqual(r.info.layer, 'T1');
    close(r.result, Array.from(core.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n)), core.tolerance(k), 'matmul vec4');
  });
  await check('歸約在 T1 執行（1000 個元素，需要兩輪），誤差在容差內', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const a = seeded(1000, 11);
    const r = await rt.sum(a);
    assert.strictEqual(r.info.layer, 'T1');
    const exact = core.sumExact(a);
    assert.ok(Math.abs(r.result - exact) <= core.tolerance(a.length) * Math.max(1, Math.abs(exact)) + 1e-3, '歸約誤差：' + r.result + ' 與 ' + exact);
    assert.strictEqual(r.info.reductionOrder, 'tree-wg256');
  });
  await check('WebGPU 與 WebGL2 都可用時優先 T1', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: fakeGl() });
    const r = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r.info.layer, 'T1');
  });

  // ---- WebGL2（T3） ----
  await check('向量加在 T3（WebGL2）執行，結果與參考版一致', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl({ maxTex: 64 }) });
    const a = seeded(300, 21), b = seeded(300, 22);
    const r = await rt.vectorAdd(a, b);
    assert.strictEqual(r.info.layer, 'T3');
    assert.strictEqual(r.info.via, 'webgl2');
    assert.ok(r.info.reason.includes('沒有 WebGPU'), '應說明 T1 不可用的原因');
    close(r.result, Array.from(core.vectorAddRef(Float32Array.from(a), Float32Array.from(b))), 0, 'vector_add T3');
  });
  await check('矩陣乘在 T3 執行（形狀不整齊），誤差在容差內', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl({ maxTex: 4096 }) });
    const m = 17, k = 19, n = 21;
    const A = seeded(m * k, 31), B = seeded(k * n, 32);
    const r = await rt.matmul(A, B, m, k, n);
    assert.strictEqual(r.info.layer, 'T3');
    close(r.result, Array.from(core.matmulRef(Float32Array.from(A), Float32Array.from(B), m, k, n)), core.tolerance(k), 'matmul T3');
  });
  await check('歸約在 T3 執行（多趟縮減），誤差在容差內', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl({ maxTex: 64 }) });
    const a = seeded(1000, 41);
    const r = await rt.sum(a);
    assert.strictEqual(r.info.layer, 'T3');
    const exact = core.sumExact(a);
    assert.ok(Math.abs(r.result - exact) <= core.tolerance(a.length) * Math.max(1, Math.abs(exact)) + 1e-3, '歸約誤差：' + r.result + ' 與 ' + exact);
  });
  await check('gemv 在 T3 走矩陣乘路徑', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl() });
    const r = await rt.gemv([1, 2, 3, 4], [1, 1], 2, 2);
    assert.strictEqual(r.info.layer, 'T3');
    assert.deepStrictEqual(r.result, [3, 7]);
  });
  await check('WebGL2 缺 EXT_color_buffer_float：降到 T5，原因寫明擴充功能', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl({ noFloat: true }) });
    const r = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('EXT_color_buffer_float'));
  });
  await check('紋理尺寸超過 MAX_TEXTURE_SIZE：WebGL2 退到 T5，原因寫明尺寸', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl({ maxTex: 8 }) });
    const r = await rt.matmul(seeded(4 * 9, 1), seeded(9 * 2, 2), 4, 9, 2);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('MAX_TEXTURE_SIZE'));
  });
  await check('WebGL2 繪製失敗：退到 T5，原因帶上錯誤', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl({ drawFail: 'vector_add' }) });
    const r = await rt.vectorAdd([1, 2], [3, 4]);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('WebGL2 核心執行失敗'));
    assert.deepStrictEqual(r.result, [4, 6]);
  });

  // ---- 降級路徑（WebGPU） ----
  await check('儲存緩衝超過上限：WebGPU 那一層跳過並寫明，之後退到 T5', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ limits: { maxStorageBufferBindingSize: 64 } }).nav, webgl2: null });
    const a = new Array(100).fill(1);
    const r = await rt.vectorAdd(a, a);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('超過裝置的儲存緩衝上限'));
    assert.strictEqual(r.result[0], 2);
  });
  await check('核心執行失敗：先退 WebGL2 或 T5，原因帶上錯誤，結果仍正確', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ kernelError: 'matmul' }).nav, webgl2: null });
    const r = await rt.matmul([1, 2, 3, 4], [5, 6, 7, 8], 2, 2, 2);
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('WGSL 核心執行失敗'));
    assert.ok(r.info.reason.includes('假核心錯誤'));
    assert.deepStrictEqual(r.result, [19, 22, 43, 50]);
  });
  await check('裝置遺失：之後的呼叫不再用 WebGPU，原因寫明遺失', async () => {
    const f = fakeNavigator();
    const rt = core.createRuntime({ navigator: f.nav, webgl2: null });
    const r1 = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r1.info.layer, 'T1');
    f.dev.__resolveLost({ message: 'test loss' });
    await new Promise((r) => setImmediate(r));
    const r2 = await rt.vectorAdd([1], [2]);
    assert.strictEqual(r2.info.layer, 'T5');
    assert.ok(r2.info.reason.includes('裝置遺失'));
    assert.ok(r2.info.reason.includes('test loss'));
  });

  // ---- 第二階段：cuBLAS 子集 ----
  await check('axpy、scal、dot、nrm2 在 T1 與參考版一致', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const x = seeded(300, 51), y = seeded(300, 52);
    const ax = await rt.axpy(2.5, x, y);
    assert.strictEqual(ax.info.layer, 'T1');
    close(ax.result, Array.from(core.axpyRef(2.5, Float32Array.from(x), Float32Array.from(y))), 1e-6, 'axpy');
    const sc = await rt.scal(-0.5, x);
    assert.strictEqual(sc.info.layer, 'T1');
    close(sc.result, Array.from(core.scalRef(-0.5, Float32Array.from(x))), 1e-6, 'scal');
    const d = await rt.dot(x, y);
    assert.strictEqual(d.info.layer, 'T1');
    const dExact = x.reduce((s, v, i) => s + v * y[i], 0);
    assert.ok(Math.abs(d.result - dExact) <= core.tolerance(300) * Math.max(1, Math.abs(dExact)) + 1e-3, 'dot 誤差');
    const nr = await rt.nrm2(x);
    assert.strictEqual(nr.info.layer, 'T1');
    const nExact = Math.sqrt(x.reduce((s, v) => s + v * v, 0));
    assert.ok(Math.abs(nr.result - nExact) <= core.tolerance(300) * Math.max(1, nExact) + 1e-3, 'nrm2 誤差');
  });
  await check('gemv 在 T1 與參考版一致（m=5、n=7）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const A = seeded(35, 61), x = seeded(7, 62);
    const r = await rt.gemv(A, x, 5, 7);
    assert.strictEqual(r.info.layer, 'T1');
    close(r.result, Array.from(core.gemvRef(Float32Array.from(A), Float32Array.from(x), 5, 7)), core.tolerance(7), 'gemv');
  });
  await check('矩陣乘轉置旗標（transA／transB／兩者）在 T1 與普通形式的參考一致（同一份核心，不在宿主轉置）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    const M = 5, K = 7, N = 6;
    const An = seeded(M * K, 31), Bn = seeded(K * N, 32);           // 普通形式：A 為 M×K、B 為 K×N
    const ref = []; for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) { let acc = 0; for (let k = 0; k < K; k++) acc += An[i * K + k] * Bn[k * N + j]; ref.push(acc); }
    const As = new Array(M * K), Bs = new Array(K * N);             // 轉置儲存：A 存成 K×M，B 存成 N×K
    for (let i = 0; i < M; i++) for (let k = 0; k < K; k++) As[k * M + i] = An[i * K + k];
    for (let k = 0; k < K; k++) for (let j = 0; j < N; j++) Bs[j * K + k] = Bn[k * N + j];
    const cases = [
      { name: 'transA', A: As, B: Bn, flags: { transA: true } },
      { name: 'transB', A: An, B: Bs, flags: { transB: true } },
      { name: 'transA+transB', A: As, B: Bs, flags: { transA: true, transB: true } },
    ];
    for (const c of cases) {
      const r = await rt.matmul(c.A, c.B, M, K, N, c.flags);
      assert.strictEqual(r.info.layer, 'T1', c.name);
      close(r.result, ref, core.tolerance(K), 'matmul ' + c.name);
    }
  });
  await check('前綴和在 T1 與參考版一致（單區塊、多區塊、需要遞迴的 70000 個元素）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    for (const n of [5, 300, 70000]) {
      const a = seeded(n, 80 + n);
      const r = await rt.scan(a);
      assert.strictEqual(r.info.layer, 'T1');
      // 參考用雙精度前綴和（精確）。實測（同樣的 f32 區塊運算）最大絕對誤差：n=5 約 1.5e-8、n=300 約 1.5e-6、n=70000 約 1.3e-4；
      // 逐步 f32 累加在 n=70000 誤差約 1.0e-3，所以不能當比對基準。容差 5e-4 絕對值，約為實測誤差的 3.7 倍。
      const ref = []; let acc = 0; for (let i = 0; i < n; i++) { acc += Math.fround(a[i]); ref.push(acc); }
      close(r.result, ref, 5e-4, 'scan n=' + n);
    }
  });
  await check('轉置樣板在 T1 與參考版一致（m=5、n=7 與 m=33、n=17，跨越 16×16 分塊邊界）', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    for (const [m, n] of [[5, 7], [33, 17]]) {
      const A = seeded(m * n, 70 + m);
      const r = await rt.transpose(A, m, n);
      assert.strictEqual(r.info.layer, 'T1');
      const ref = []; for (let j = 0; j < n; j++) for (let i = 0; i < m; i++) ref.push(Math.fround(A[i * n + j]));   // 核心輸出是 f32，參考也要先 fround
      assert.deepStrictEqual(r.result, ref, 'transpose ' + m + '×' + n);
    }
  });
  await check('第二階段子程式在沒有 WebGPU 時：axpy、scal、dot、nrm2 退 T5 並寫明 WebGL2 尚未實作', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: fakeGl() });
    const r = await rt.axpy(2, [1], [1]);
    assert.strictEqual(r.info.layer, 'T5');
    assert.deepStrictEqual(r.result, [3]);
    assert.ok(r.info.reason.includes('WebGL2 版尚未實作'));
  });
  await check('子程式的參數錯誤：長度不合、alpha 非有限數字，直接丟錯不降級', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: null });
    await assert.rejects(rt.axpy(1, [1, 2], [1]), /長度不同/);
    await assert.rejects(rt.scal(Infinity, [1]), /alpha/);
    await assert.rejects(rt.gemv([1, 2, 3], [1], 2, 2), /元素數 3 與 m×n=4 不符/);
  });

  // ---- 預算與排程 ----
  await check('GPU 緩衝區預算不足：跳過 GPU 並寫明預算，結束後預算回到 0', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null, budgetBytes: 100 });
    const r = await rt.vectorAdd(new Array(50).fill(1), new Array(50).fill(2));
    assert.strictEqual(r.info.layer, 'T5');
    assert.ok(r.info.reason.includes('GPU 緩衝區預算不足'));
    const info = await rt.backendInfo();
    assert.strictEqual(info.budget.usedBytes, 0);
    assert.strictEqual(info.budget.limitBytes, 100);
  });
  await check('排程：推論優先，連續高優先級超過門檻時讓出一次給模擬器（防餓死）', async () => {
    const s = core.createScheduler({ starveAfter: 2 });
    const order = [];
    const rel0 = await s.acquire('infer');
    const mk = (name) => s.acquire(name.startsWith('i') ? 'infer' : 'sim').then((rel) => { order.push(name); rel(); });
    const ps = [mk('i1'), mk('i2'), mk('i3'), mk('i4'), mk('sim')];
    rel0();
    await Promise.all(ps);
    assert.deepStrictEqual(order, ['i1', 'sim', 'i2', 'i3', 'i4']);
    assert.strictEqual(s.stats().starvedGrants, 1);
    assert.strictEqual(s.stats().busy, false);
  });
  await check('排程：同一時間只有一個工作持有裝置', async () => {
    const s = core.createScheduler({});
    const r1 = await s.acquire('sim');
    assert.strictEqual(s.stats().busy, true);
    let got2 = false;
    const p2 = s.acquire('sim').then((rel) => { got2 = true; rel(); });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(got2, false, '第二個工作不應在第一個釋放前拿到裝置');
    r1();
    await p2;
    assert.strictEqual(got2, true);
  });

  // ---- backendInfo 與降級紀錄 ----
  await check('backendInfo 回報能力檔、各操作的層、降級紀錄與預算', async () => {
    const rt = core.createRuntime({ navigator: fakeNavigator({ limits: { maxStorageBufferBindingSize: 64 } }).nav, webgl2: null });
    await rt.vectorAdd(new Array(100).fill(1), new Array(100).fill(1));
    const info = await rt.backendInfo();
    assert.strictEqual(info.hasWebGPU, true);
    assert.strictEqual(info.hasAdapter, true);
    assert.strictEqual(info.last.layer, 'T5');
    assert.strictEqual(info.degradeLog.length, 1);
    assert.strictEqual(info.degradeLog[0].op, 'vector_add');
    assert.strictEqual(info.profile, 'B');
    assert.strictEqual(info.ops.vector_add.layer, 'T5');
    assert.strictEqual(info.ops.axpy.webgl2, 'missing');
    assert.strictEqual(info.ops.vector_add.webgpu, 'native');
    assert.ok(info.budget.limitBytes > 0);
    assert.ok(info.scheduler && typeof info.scheduler.waiting === 'number');
  });
  await check('backendInfo 在沒有 GPU 時給能力檔 null 與原因', async () => {
    const rt = core.createRuntime({ navigator: {}, webgl2: null });
    const info = await rt.backendInfo();
    assert.strictEqual(info.profile, null);
    assert.ok(info.profileReason.length > 0);
  });

  // ---- 登錄表對映 ----
  await check('登錄表 webgpuTierProbe：無 GPU 時 reason 必填、結構合法；有裝置時可用', async () => {
    const bc = require('../studio/backend_core.js');
    const rt = core.createRuntime({ navigator: {}, webgl2: null });
    await rt.vectorAdd([1], [2]);
    const p1 = bc.webgpuTierProbe(await rt.backendInfo());
    assert.strictEqual(p1.available, false);
    assert.ok(p1.reason.includes('沒有 WebGPU'));
    assert.deepStrictEqual(bc.validateProbeResult(p1), []);
    const rt2 = core.createRuntime({ navigator: fakeNavigator().nav, webgl2: null });
    await rt2.vectorAdd([1], [2]);
    const p2 = bc.webgpuTierProbe(await rt2.backendInfo());
    assert.strictEqual(p2.available, true);
    assert.ok(!p2.reason, '可用時不應有 reason');
    assert.deepStrictEqual(bc.validateProbeResult(p2), []);
  });

  await check('任意核心（runKernel）：緩衝區重用不殘留舊資料、多個輸出一起讀回、沒給資料的緩衝區是零', async () => {
    const f = fakeNavigator(); const rt = core.createRuntime({ navigator: f.nav, webgl2: null });
    const W = '// @kernel user_axpb\n';
    const run = (inp, o1) => rt.runKernel({ wgsl: W, groups: [1, 1], bindings: [{ name: 'a', dtype: 'f32', n: 3, write: false, data: Float32Array.from(inp) }, { name: 'o', dtype: 'f32', n: 3, write: true, data: o1 ? Float32Array.from(o1) : null }, { name: 'p', dtype: 'f32', n: 3, write: true, data: null }] });
    const f32o = (r, k) => Array.from(new Float32Array(r.outputs[k].buffer, r.outputs[k].byteOffset, 3));
    const r1 = await run([1, 2, 3], [10, 20, 30]); assert.ok(r1.ran, r1.reason); assert.deepStrictEqual(f32o(r1, 'o'), [12, 24, 36]); assert.deepStrictEqual(f32o(r1, 'p'), [2, 3, 4]);
    const r2 = await run([5, 6, 7], null); assert.deepStrictEqual(f32o(r2, 'o'), [10, 12, 14], '上一次的輸出不能殘留（沒給資料就是零）'); assert.deepStrictEqual(f32o(r2, 'p'), [6, 7, 8]);
    const r3 = await run([0, 0, 0], [1, 1, 1]); assert.deepStrictEqual(f32o(r3, 'o'), [1, 1, 1]);
  });

  console.log('\n' + pass + ' 通過，' + fail + ' 失敗');
  if (fail) process.exit(1);
})();
