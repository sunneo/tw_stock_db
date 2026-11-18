// SmolVLM／LLaVA 的 GPU 執行器（瀏覽器用，全域 VlmGpuR）：權重上傳一次、常駐 GPU，跨 token 重用。
// 精度模式（每個權重矩陣各自選）：
//   f32：權重與計算都是 f32。
//   f16：權重以 f16 位元打包成 u32（兩個一組），著色器用 unpack2x16float 解開；乘加是 f32。
//   q8 ：權重每列一個 f32 縮放值，8 位元整數打包成 u32（四個一組）；著色器用位元運算取出，乘加後再乘縮放值。
// 注意：f16 模式只用儲存為 f16、不依賴 shader-f16 功能（所以這台有沒有 shader-f16 都能跑）；是否有 shader-f16 會被記錄下來。
// 所有運算都是樸素實作（沒有共享記憶體分塊），數值正確性優先；時間數字是這份實作的時間，不是 cudaweb 核心的時間。
// 版面（row-major）：X[T][K]、W[N][K]（骨架的 [out][in]）、Y[T][N]。
(function (root) {
  'use strict';

  // 共用的轉換緩衝（避免每個元素都配置新陣列，那會讓大權重的打包慢到無法使用）
  const F16_F = new Float32Array(1), F16_U = new Uint32Array(F16_F.buffer);
  function f32ToF16Bits(v) {
    F16_F[0] = v; const x = F16_U[0];
    const sign = (x >>> 16) & 0x8000;
    const exp = (x >>> 23) & 0xff;
    let mant = x & 0x7fffff;
    if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
    const e = exp - 127 + 15;
    if (e >= 31) return sign | 0x7c00;
    if (e <= 0) {
      if (e < -10) return sign;
      mant = (mant | 0x800000) >>> (1 - e);
      return sign | ((mant + 0x1000) >>> 13);
    }
    let h = sign | (e << 10) | (mant >>> 13);
    if (mant & 0x1000) h = h + 1;
    return h & 0xffff;
  }

  // 每個 WGSL 著色器的共同片段
  const MATMUL_WGSL = (mode) => {
    const wType = mode === 'f32' ? 'f32' : 'u32';
    let load;
    if (mode === 'f32') load = 'W[idx]';
    else if (mode === 'f16') load = 'unpack2x16float(W[idx >> 1u])[idx & 1u]';
    else load = 'f32(bitcast<i32>(((W[idx >> 2u] >> (8u * (idx & 3u))) & 0xffu) << 24u) >> 24u)';
    const scale = mode === 'q8' ? 'y = y * S[n];' : '';
    return `
struct P { T: u32, K: u32, N: u32, flags: u32, t0: u32, t1: u32 }
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> W: array<${wType}>;
@group(0) @binding(2) var<storage, read> B: array<f32>;
@group(0) @binding(3) var<storage, read> S: array<f32>;
@group(0) @binding(4) var<storage, read> R: array<f32>;
@group(0) @binding(5) var<storage, read_write> Y: array<f32>;
@group(0) @binding(6) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let n = g.x; let t = g.y + p.t0;
  if (n >= p.N || t >= p.t1) { return; }
  var acc: f32 = 0.0;
  let wb = n * p.K; let xb = t * p.K;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) {
    let idx = wb + k;
    acc = acc + X[xb + k] * ${load};
  }
  var y = acc;
  ${scale}
  if ((p.flags & 1u) != 0u) { y = y + B[n]; }
  if ((p.flags & 2u) != 0u) { y = y + R[t * p.N + n]; }
  Y[t * p.N + n] = y;
}`;
  };

  const LN_WGSL = `
struct P { T: u32, D: u32, eps: f32, flags: u32 }
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> G: array<f32>;
@group(0) @binding(2) var<storage, read> Bt: array<f32>;
@group(0) @binding(3) var<storage, read_write> Y: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x;
  if (t >= p.T) { return; }
  let base = t * p.D;
  let isRms = (p.flags & 1u) != 0u;
  var mean: f32 = 0.0;
  if (!isRms) { for (var d: u32 = 0u; d < p.D; d = d + 1u) { mean = mean + X[base + d]; } mean = mean / f32(p.D); }
  var v: f32 = 0.0;
  for (var d: u32 = 0u; d < p.D; d = d + 1u) { let c = X[base + d] - mean; v = v + c * c; }
  v = v / f32(p.D);
  let inv = 1.0 / sqrt(v + p.eps);
  for (var d: u32 = 0u; d < p.D; d = d + 1u) {
    var b: f32 = 0.0;
    if (!isRms) { b = Bt[d]; }
    Y[base + d] = (X[base + d] - mean) * inv * G[d] + b;
  }
}`;

  // op：0 gelu（tanh 近似，輸入 A）、1 silu(A)·B、2 A+B
  const EW_WGSL = `
struct P { n: u32, op: u32 }
@group(0) @binding(0) var<storage, read> A: array<f32>;
@group(0) @binding(1) var<storage, read> Bv: array<f32>;
@group(0) @binding(2) var<storage, read_write> Y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let i = g.x;
  if (i >= p.n) { return; }
  let a = A[i];
  if (p.op == 0u) {
    let c = 0.7978845608028654 * (a + 0.044715 * a * a * a);
    Y[i] = 0.5 * a * (1.0 + tanh(clamp(c, -15.0, 15.0)));
  } else if (p.op == 1u) {
    Y[i] = (a / (1.0 + exp(-a))) * Bv[i];
  } else {
    Y[i] = a + Bv[i];
  }
}`;

  const ROPE_WGSL = `
struct P { T: u32, nh: u32, hd: u32, base: f32 }
@group(0) @binding(0) var<storage, read_write> Q: array<f32>;
@group(0) @binding(1) var<uniform> p: P;
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let h2 = p.hd / 2u;
  let total = p.T * p.nh * h2;
  let id = g.x;
  if (id >= total) { return; }
  let i = id % h2;
  let h = (id / h2) % p.nh;
  let t = id / (h2 * p.nh);
  let row = p.nh * p.hd;
  let theta = f32(t) * pow(p.base, -2.0 * f32(i) / f32(p.hd));
  let c = cos(theta); let s = sin(theta);
  let o = t * row + h * p.hd;
  let a = Q[o + i]; let b = Q[o + i + h2];
  Q[o + i] = a * c - b * s;
  Q[o + i + h2] = a * s + b * c;
}`;

  // 注意力：每個執行緒算一個 (位置 t, query 頭 qh)。causal 為 1 時只看 j ≤ t。GQA：kv 頭 = qh / (nh/nkv)。
  const ATTN_WGSL = `
struct P { T: u32, nh: u32, nkv: u32, hd: u32, causal: u32, scale: f32, r0: u32, r1: u32 }
@group(0) @binding(0) var<storage, read> Q: array<f32>;
@group(0) @binding(1) var<storage, read> K: array<f32>;
@group(0) @binding(2) var<storage, read> V: array<f32>;
@group(0) @binding(3) var<storage, read_write> O: array<f32>;
@group(0) @binding(4) var<uniform> p: P;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) g: vec3<u32>) {
  let t = g.x + p.r0; let qh = g.y;
  if (t >= p.r1 || qh >= p.nh) { return; }
  let group = p.nh / p.nkv;
  let kh = qh / group;
  let qd = p.nh * p.hd; let kd = p.nkv * p.hd;
  let qb = t * qd + qh * p.hd;
  var jmax = p.T - 1u;
  if (p.causal == 1u) { jmax = t; }
  var m: f32 = -3.0e38;
  for (var j: u32 = 0u; j <= jmax; j = j + 1u) {
    var s: f32 = 0.0;
    let kb = j * kd + kh * p.hd;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { s = s + Q[qb + d] * K[kb + d]; }
    s = s * p.scale;
    if (s > m) { m = s; }
  }
  var acc: array<f32, 128>;
  for (var d: u32 = 0u; d < p.hd; d = d + 1u) { acc[d] = 0.0; }
  var z: f32 = 0.0;
  for (var j: u32 = 0u; j <= jmax; j = j + 1u) {
    var s: f32 = 0.0;
    let kb = j * kd + kh * p.hd;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { s = s + Q[qb + d] * K[kb + d]; }
    let e = exp(s * p.scale - m);
    z = z + e;
    let vb = j * kd + kh * p.hd;
    for (var d: u32 = 0u; d < p.hd; d = d + 1u) { acc[d] = acc[d] + e * V[vb + d]; }
  }
  for (var d: u32 = 0u; d < p.hd; d = d + 1u) { O[qb + d] = acc[d] / z; }
}`;

  async function create(opts) {
    opts = opts || {};
    if (!navigator.gpu) throw new Error('VlmGpuR：這個瀏覽器沒有 WebGPU');
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) throw new Error('VlmGpuR：requestAdapter 回傳空值');
    const hasF16 = adapter.features.has('shader-f16');
    const device = await adapter.requestDevice({ requiredFeatures: [], requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize } });
    const R = new Runtime(device, { hasF16: hasF16, adapterName: (adapter.info && (adapter.info.description || adapter.info.device)) || 'unknown',
      maxStorage: device.limits.maxStorageBufferBindingSize, maxBuffer: device.limits.maxBufferSize });
    return R;
  }

  class Runtime {
    constructor(device, info) {
      this.device = device; this.info = info;
      this.liveBufs = [];
      const d = device;
      const U = GPUBufferUsage;
      this.U = { STORAGE: U.STORAGE, COPY_DST: U.COPY_DST, COPY_SRC: U.COPY_SRC, UNIFORM: U.UNIFORM, MAP_READ: U.MAP_READ };
      const ro = (b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } });
      const rw = (b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } });
      const un = (b) => ({ binding: b, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } });
      this.bgl = {
        mm: d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), ro(3), ro(4), rw(5), un(6)] }),
        ln: d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), rw(3), un(4)] }),
        ew: d.createBindGroupLayout({ entries: [ro(0), ro(1), rw(2), un(3)] }),
        rope: d.createBindGroupLayout({ entries: [rw(0), un(1)] }),
        attn: d.createBindGroupLayout({ entries: [ro(0), ro(1), ro(2), rw(3), un(4)] }),
      };
      this.pipe = {};
      this.dummy = this.buffer(new Float32Array(4));
    }
    pipeline(key, code, layoutKey) {
      if (!this.pipe[key]) {
        const mod = this.device.createShaderModule({ code: code });
        this.pipe[key] = this.device.createComputePipeline({
          layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.bgl[layoutKey]] }),
          compute: { module: mod, entryPoint: 'main' } });
      }
      return this.pipe[key];
    }
    buffer(arr) {
      const bytes = arr.byteLength;
      if (bytes > this.info.maxBuffer) throw new Error('VlmGpuR：單一緩衝 ' + bytes + ' 位元組超過 maxBufferSize ' + this.info.maxBuffer);
      if (bytes > this.info.maxStorage) throw new Error('VlmGpuR：單一緩衝 ' + bytes + ' 位元組超過 maxStorageBufferBindingSize ' + this.info.maxStorage);
      const buf = this.device.createBuffer({ size: Math.max(4, Math.ceil(bytes / 4) * 4), usage: this.U.STORAGE | this.U.COPY_DST | this.U.COPY_SRC });
      if (bytes) this.device.queue.writeBuffer(buf, 0, arr.buffer, arr.byteOffset, bytes);
      this.liveBufs.push(buf);
      return buf;
    }
    zeros(n) { return this.buffer(new Float32Array(Math.max(1, n))); }
    // 權重矩陣 W[N][K]：mode 為 f32、f16、q8。回傳 { mode, N, K, buf, scale }
    weight(W, N, K, mode) {
      if (W.length !== N * K) throw new Error('VlmGpuR.weight：長度 ' + W.length + ' 與 N×K=' + (N * K) + ' 不符');
      if (mode === 'f32') return { mode: mode, N: N, K: K, buf: this.buffer(W), scale: this.dummy };
      if (mode === 'f16') {
        if (K % 2) throw new Error('VlmGpuR：f16 需要 K 為偶數');
        const words = new Uint32Array(N * K / 2);
        for (let i = 0; i < N * K; i += 2) words[i >> 1] = (f32ToF16Bits(W[i]) | (f32ToF16Bits(W[i + 1]) << 16)) >>> 0;
        return { mode: mode, N: N, K: K, buf: this.buffer(words), scale: this.dummy };
      }
      if (mode === 'q8') {
        if (K % 4) throw new Error('VlmGpuR：q8 需要 K 為 4 的倍數');
        const words = new Uint32Array(N * K / 4), sc = new Float32Array(N);
        for (let n = 0; n < N; n++) {
          let mx = 0; for (let k = 0; k < K; k++) { const a = Math.abs(W[n * K + k]); if (a > mx) mx = a; }
          const s = mx > 0 ? mx / 127 : 1; sc[n] = s;
          for (let k = 0; k < K; k += 4) {
            let w = 0;
            for (let j = 0; j < 4; j++) { let q = Math.round(W[n * K + k + j] / s); if (q > 127) q = 127; if (q < -127) q = -127; w |= ((q & 0xff) << (8 * j)); }
            words[(n * K + k) / 4] = w >>> 0;
          }
        }
        return { mode: mode, N: N, K: K, buf: this.buffer(words), scale: this.buffer(sc) };
      }
      throw new Error('VlmGpuR：不認得的模式 ' + mode);
    }
    vec(a) { return this.buffer(a); }
    uni(bytes) {
      const b = this.device.createBuffer({ size: 32, usage: this.U.UNIFORM | this.U.COPY_DST });
      this.device.queue.writeBuffer(b, 0, bytes);
      this.liveBufs.push(b);
      return b;
    }
    // 每個分派各自送出（避免單一提交過久觸發 GPU 逾時）
    dispatch(pipe, layoutKey, entries, gx, gy, gz) {
      const bg = this.device.createBindGroup({ layout: this.bgl[layoutKey], entries: entries.map((e, i) => ({ binding: i, resource: { buffer: e } })) });
      const enc = this.device.createCommandEncoder();
      const pass = enc.beginComputePass();
      pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(gx, gy || 1, gz || 1); pass.end();
      this.device.queue.submit([enc.finish()]);
    }
    // Y[T][N] = X[T][K]·W^T（+ bias）（+ resid）；列方向依工作量分段
    matmul(X, Wt, T, opts) {
      opts = opts || {};
      const flags = (opts.bias ? 1 : 0) | (opts.resid ? 2 : 0);
      const pipe = this.pipeline('mm_' + Wt.mode, MATMUL_WGSL(Wt.mode), 'mm');
      const Y = this.zeros(T * Wt.N);
      const rowsPer = Math.max(1, Math.min(T, Math.floor(268435456 / (Wt.N * Wt.K))));
      for (let t0 = 0; t0 < T; t0 += rowsPer) {
        const t1 = Math.min(T, t0 + rowsPer);
        const u = new ArrayBuffer(24); const dv = new DataView(u);
        dv.setUint32(0, T, true); dv.setUint32(4, Wt.K, true); dv.setUint32(8, Wt.N, true); dv.setUint32(12, flags, true);
        dv.setUint32(16, t0, true); dv.setUint32(20, t1, true);
        this.dispatch(pipe, 'mm', [X, Wt.buf, opts.bias || this.dummy, Wt.scale, opts.resid || this.dummy, Y, this.uni(u)],
          Math.ceil(Wt.N / 8), Math.ceil((t1 - t0) / 8));
      }
      return Y;
    }
    layernorm(X, T, D, g, b, eps, rms) {
      const pipe = this.pipeline('ln', LN_WGSL, 'ln');
      const Y = this.zeros(T * D);
      const u = new ArrayBuffer(16); const dv = new DataView(u);
      dv.setUint32(0, T, true); dv.setUint32(4, D, true); dv.setFloat32(8, eps, true); dv.setUint32(12, rms ? 1 : 0, true);
      this.dispatch(pipe, 'ln', [X, g, b || this.dummy, Y, this.uni(u)], Math.ceil(T / 64));
      return Y;
    }
    ew(op, A, B, n) {
      const pipe = this.pipeline('ew', EW_WGSL, 'ew');
      const Y = this.zeros(n);
      const u = new ArrayBuffer(8); const dv = new DataView(u);
      dv.setUint32(0, n, true); dv.setUint32(4, op, true);
      this.dispatch(pipe, 'ew', [A, B || this.dummy, Y, this.uni(u)], Math.ceil(n / 256));
      return Y;
    }
    gelu(A, n) { return this.ew(0, A, null, n); }
    siluMul(A, B, n) { return this.ew(1, A, B, n); }
    add(A, B, n) { return this.ew(2, A, B, n); }
    rope(Q, T, nh, hd, base) {
      const pipe = this.pipeline('rope', ROPE_WGSL, 'rope');
      const u = new ArrayBuffer(16); const dv = new DataView(u);
      dv.setUint32(0, T, true); dv.setUint32(4, nh, true); dv.setUint32(8, hd, true); dv.setFloat32(12, base, true);
      this.dispatch(pipe, 'rope', [Q, this.uni(u)], Math.ceil(T * nh * (hd / 2) / 64));
      return Q;
    }
    // 注意力：列方向依工作量分段（每段一個分派）
    attn(Q, K, V, T, nh, nkv, hd, causal) {
      const pipe = this.pipeline('attn', ATTN_WGSL, 'attn');
      const O = this.zeros(T * nh * hd);
      const rowsPer = Math.max(1, Math.min(T, Math.floor(67108864 / (nh * T * hd * 4))));
      for (let r0 = 0; r0 < T; r0 += rowsPer) {
        const r1 = Math.min(T, r0 + rowsPer);
        const u = new ArrayBuffer(32); const dv = new DataView(u);
        dv.setUint32(0, T, true); dv.setUint32(4, nh, true); dv.setUint32(8, nkv, true); dv.setUint32(12, hd, true);
        dv.setUint32(16, causal ? 1 : 0, true); dv.setFloat32(20, 1 / Math.sqrt(hd), true);
        dv.setUint32(24, r0, true); dv.setUint32(28, r1, true);
        this.dispatch(pipe, 'attn', [Q, K, V, O, this.uni(u)], Math.ceil((r1 - r0) / 8), Math.ceil(nh / 8));
      }
      return O;
    }
    // 等 GPU 做完（計時用），回傳耗時（毫秒）
    async flush() {
      const t0 = performance.now();
      await this.device.queue.onSubmittedWorkDone();
      return performance.now() - t0;
    }
    async read(buf, n) {
      const staging = this.device.createBuffer({ size: n * 4, usage: this.U.COPY_DST | this.U.MAP_READ });
      const enc = this.device.createCommandEncoder();
      enc.copyBufferToBuffer(buf, 0, staging, 0, n * 4);
      this.device.queue.submit([enc.finish()]);
      await staging.mapAsync(GPUMapMode.READ);
      const out = new Float32Array(staging.getMappedRange().slice(0));
      staging.unmap(); staging.destroy();
      return out;
    }
    destroy() { for (const b of this.liveBufs) { try { b.destroy(); } catch (e) { /* 已釋放 */ } } this.liveBufs = []; try { this.device.destroy(); } catch (e) { /* ignore */ } }
  }

  root.VlmGpuR = { create: create, f32ToF16Bits: f32ToF16Bits };
})(typeof self !== 'undefined' ? self : this);
