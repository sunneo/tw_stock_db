// nn_ops.js — 訓練步用的 cudaweb 核心（DESIGN.webgpu-cuda.md §12.4，第三階段後段）。
// 每個操作三層：T1 = WGSL（WebGPU）、T3 = WebGL2（尚未實作，會寫明）、cpu-js = CPU 參考版。
// 目前已完成的操作：RMSNorm。之後依序加入 softmax、SiLU、RoPE、AdamW。
// 注意：WGSL 原始碼在真 WebGPU 上尚未驗證；測試的假裝置用 CPU 參考版執行，只驗證主機端的綁定、回讀與降級流程。
'use strict';
const core = require('./gpu_core.js');

const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
const NOTE_T3 = 'WebGL2 版尚未實作';

// 取得 WebGPU 裝置（每個 navigator 只要一次）。沒有就回傳 dev:null 與原因。
const devCache = new Map();
function getDevice(nav) {
  if (!nav || !nav.gpu) return Promise.resolve({ dev: null, reason: 'WebGPU 不可用（navigator.gpu 不存在）' });
  if (!devCache.has(nav)) {
    devCache.set(nav, (async () => {
      try {
        const pa = await core.probeAdapter(nav);
        if (!pa.adapter) return { dev: null, reason: 'WebGPU 沒有可用的介面卡' + (pa.probe && pa.probe.reason ? '（' + pa.probe.reason + '）' : '') };
        const dev = await pa.adapter.requestDevice();
        return { dev: dev, reason: null };
      } catch (e) { return { dev: null, reason: 'WebGPU 初始化失敗：' + String((e && e.message) || e) }; }
    })());
  }
  return devCache.get(nav);
}

// 通用的單次分派：bufs = [{data: Float32Array, out: bool}]，依序綁定 0..n-1；uniform 綁在最後一個索引
async function runWgsl(dev, code, bufs, uniform, groups) {
  const objs = bufs.map((b) => {
    const buf = dev.createBuffer({ size: b.data.byteLength, usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
    dev.queue.writeBuffer(buf, 0, b.data);
    return buf;
  });
  const ub = dev.createBuffer({ size: Math.max(16, Math.ceil(uniform.byteLength / 16) * 16), usage: USAGE.UNIFORM | USAGE.COPY_DST });
  dev.queue.writeBuffer(ub, 0, uniform);
  const module = dev.createShaderModule({ code: code });
  const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: module, entryPoint: 'main' } });
  const entries = objs.map((buf, i) => ({ binding: i, resource: { buffer: buf } }));
  entries.push({ binding: bufs.length, resource: { buffer: ub } });
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(groups); pass.end();
  const rb = bufs.map((b) => (b.out ? dev.createBuffer({ size: b.data.byteLength, usage: USAGE.MAP_READ | USAGE.COPY_DST }) : null));
  bufs.forEach((b, i) => { if (b.out) enc.copyBufferToBuffer(objs[i], 0, rb[i], 0, b.data.byteLength); });
  dev.queue.submit([enc.finish()]);
  const outs = [];
  for (let i = 0; i < bufs.length; i++) {
    if (!bufs[i].out) continue;
    await rb[i].mapAsync(1);
    outs.push(new Float32Array(rb[i].getMappedRange().slice(0)));
    rb[i].unmap();
  }
  return outs;
}

// 先試 T1；沒有 WebGPU、或執行失敗就退到 CPU 參考版，原因照實寫進 info
async function tryLayers(name, opts, gpuFn, refFn) {
  const o = opts || {};
  const nav = o.navigator !== undefined ? o.navigator : (typeof navigator !== 'undefined' ? navigator : undefined);
  const g = await getDevice(nav);
  if (!g.dev) return { result: refFn(), info: { lib: 'cudaweb-nn', op: name, layer: 'cpu-js', reason: g.reason + '；' + NOTE_T3, webgl2: 'missing' } };
  try {
    const r = await gpuFn(g.dev);
    return { result: r, info: { lib: 'cudaweb-nn', op: name, layer: 'T1', reason: '', webgl2: 'missing' } };
  } catch (e) {
    return { result: refFn(), info: { lib: 'cudaweb-nn', op: name, layer: 'cpu-js', reason: 'WGSL 執行失敗，退回 CPU：' + String((e && e.message) || e) + '；' + NOTE_T3, webgl2: 'missing' } };
  }
}

// ---------- RMSNorm ----------
// y[t,i] = x[t,i] · g[i] / sqrt(mean_i(x[t,·]²) + eps)；x 為 T×d 列主序
function rmsnormRef(x, g, T, d, eps) {
  if (x.length !== T * d) throw new Error('rmsnorm：x 的長度 ' + x.length + ' 與 T×d=' + (T * d) + ' 不符');
  if (g.length !== d) throw new Error('rmsnorm：g 的長度 ' + g.length + ' 與 d=' + d + ' 不符');
  const y = new Float64Array(T * d);
  for (let t = 0; t < T; t++) {
    let s = 0;
    for (let i = 0; i < d; i++) s += x[t * d + i] * x[t * d + i];
    const inv = 1 / Math.sqrt(s / d + eps);
    for (let i = 0; i < d; i++) y[t * d + i] = x[t * d + i] * inv * g[i];
  }
  return y;
}

const WGSL_RMSNORM = `
struct P { rows: u32, d: u32, eps: f32, pad: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> g: array<f32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
// @kernel rmsnorm
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= p.rows) { return; }
  var s: f32 = 0.0;
  for (var i: u32 = 0u; i < p.d; i = i + 1u) { let v = x[r * p.d + i]; s = s + v * v; }
  let inv = 1.0 / sqrt(s / f32(p.d) + p.eps);
  for (var i: u32 = 0u; i < p.d; i = i + 1u) { y[r * p.d + i] = x[r * p.d + i] * inv * g[i]; }
}
`;

async function rmsnorm(x, g, T, d, eps, opts) {
  const xf = Float32Array.from(x), gf = Float32Array.from(g);
  return tryLayers('rmsnorm', opts,
    async (dev) => {
      const uni = new ArrayBuffer(16);
      new Uint32Array(uni, 0, 2).set([T, d]);
      new Float32Array(uni, 8, 1)[0] = eps;
      const outs = await runWgsl(dev, WGSL_RMSNORM,
        [{ data: xf, out: false }, { data: gf, out: false }, { data: new Float32Array(T * d), out: true }],
        uni, Math.ceil(T / 64));
      return outs[0];
    },
    () => rmsnormRef(xf, gf, T, d, eps));
}

// ---------- softmax（沿最後一維，數值穩定：先減最大值）----------
// x 為 rows×cols 列主序；每列獨立
function softmaxRef(x, rows, cols) {
  if (x.length !== rows * cols) throw new Error('softmax：x 的長度 ' + x.length + ' 與 rows×cols=' + (rows * cols) + ' 不符');
  const y = new Float64Array(rows * cols);
  for (let r = 0; r < rows; r++) {
    let mx = -Infinity;
    for (let c = 0; c < cols; c++) if (x[r * cols + c] > mx) mx = x[r * cols + c];
    let s = 0;
    for (let c = 0; c < cols; c++) { const e = Math.exp(x[r * cols + c] - mx); y[r * cols + c] = e; s += e; }
    for (let c = 0; c < cols; c++) y[r * cols + c] /= s;
  }
  return y;
}

const WGSL_SOFTMAX = `
struct P { rows: u32, cols: u32, pad0: u32, pad1: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
// @kernel softmax
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= p.rows) { return; }
  var mx: f32 = x[r * p.cols];
  for (var c: u32 = 1u; c < p.cols; c = c + 1u) { mx = max(mx, x[r * p.cols + c]); }
  var s: f32 = 0.0;
  for (var c: u32 = 0u; c < p.cols; c = c + 1u) { let e = exp(x[r * p.cols + c] - mx); y[r * p.cols + c] = e; s = s + e; }
  for (var c: u32 = 0u; c < p.cols; c = c + 1u) { y[r * p.cols + c] = y[r * p.cols + c] / s; }
}
`;

async function softmax(x, rows, cols, opts) {
  const xf = Float32Array.from(x);
  return tryLayers('softmax', opts,
    async (dev) => {
      const uni = new ArrayBuffer(16);
      new Uint32Array(uni, 0, 2).set([rows, cols]);
      const outs = await runWgsl(dev, WGSL_SOFTMAX,
        [{ data: xf, out: false }, { data: new Float32Array(rows * cols), out: true }],
        uni, Math.ceil(rows / 64));
      return outs[0];
    },
    () => softmaxRef(xf, rows, cols));
}

// ---------- SiLU（逐元素）：y = x · sigmoid(x) = x / (1 + e^(−x)) ----------
function siluRef(x) {
  const y = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) y[i] = x[i] / (1 + Math.exp(-x[i]));
  return y;
}

const WGSL_SILU = `
struct P { n: u32, pad0: u32, pad1: u32, pad2: u32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
// @kernel silu
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= p.n) { return; }
  let v = x[i];
  y[i] = v / (1.0 + exp(-v));
}
`;

async function silu(x, opts) {
  const xf = Float32Array.from(x);
  return tryLayers('silu', opts,
    async (dev) => {
      const uni = new ArrayBuffer(16);
      new Uint32Array(uni, 0, 1).set([xf.length]);
      const outs = await runWgsl(dev, WGSL_SILU,
        [{ data: xf, out: false }, { data: new Float32Array(xf.length), out: true }],
        uni, Math.ceil(xf.length / 64));
      return outs[0];
    },
    () => siluRef(xf));
}

// ---------- RoPE（旋轉位置編碼）----------
// x 為 T×(H·hd) 列主序；每個 head 內相鄰兩維一組，角度 θ = t · 10000^(−2i/hd)；dir=−1 為反向（轉置旋轉）
function ropeRef(x, T, H, hd, dir) {
  if (x.length !== T * H * hd) throw new Error('rope：x 的長度 ' + x.length + ' 與 T×H×hd=' + (T * H * hd) + ' 不符');
  if (hd % 2 !== 0) throw new Error('rope：hd 必須是偶數（收到 ' + hd + '）');
  const y = new Float64Array(x.length), d = H * hd;
  for (let t = 0; t < T; t++) for (let h = 0; h < H; h++) for (let i = 0; i < hd / 2; i++) {
    const th = t * Math.pow(10000, -2 * i / hd), c = Math.cos(th), s = dir * Math.sin(th);
    const o = t * d + h * hd + 2 * i;
    const a = x[o], b = x[o + 1];
    y[o] = a * c - b * s;
    y[o + 1] = a * s + b * c;
  }
  return y;
}

const WGSL_ROPE = `
struct P { T: u32, H: u32, hd: u32, dir: f32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read_write> y: array<f32>;
@group(0) @binding(2) var<uniform> p: P;
// @kernel rope
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let hp = p.hd / 2u;
  let total = p.T * p.H * hp;
  let k = gid.x;
  if (k >= total) { return; }
  let i = k % hp;
  let h = (k / hp) % p.H;
  let t = k / (hp * p.H);
  let d = p.H * p.hd;
  let th = f32(t) * pow(10000.0, -2.0 * f32(i) / f32(p.hd));
  let c = cos(th);
  let s = p.dir * sin(th);
  let o = t * d + h * p.hd + 2u * i;
  let a = x[o];
  let b = x[o + 1u];
  y[o] = a * c - b * s;
  y[o + 1u] = a * s + b * c;
}
`;

async function rope(x, T, H, hd, dir, opts) {
  const xf = Float32Array.from(x);
  return tryLayers('rope', opts,
    async (dev) => {
      const uni = new ArrayBuffer(16);
      new Uint32Array(uni, 0, 3).set([T, H, hd]);
      new Float32Array(uni, 12, 1)[0] = dir;
      const outs = await runWgsl(dev, WGSL_ROPE,
        [{ data: xf, out: false }, { data: new Float32Array(xf.length), out: true }],
        uni, Math.ceil(T * H * (hd / 2) / 64));
      return outs[0];
    },
    () => ropeRef(xf, T, H, hd, dir));
}

// ---------- AdamW（逐元素，解耦權重衰減）----------
// m ← b1·m + (1−b1)·g；v ← b2·v + (1−b2)·g²；p ← p − lr·wd·p − lr·(m/c1)/(sqrt(v/c2)+eps)
// c1 = 1−b1^t、c2 = 1−b2^t 由主機算好傳入。wd=0 時與 lora_ref_train.js 的 adamStep 相同公式。
function adamwCore(p, g, m, v, lr, b1, b2, eps, wd, c1, c2) {
  const n = p.length, P2 = new Float64Array(n), M2 = new Float64Array(n), V2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    M2[i] = b1 * m[i] + (1 - b1) * g[i];
    V2[i] = b2 * v[i] + (1 - b2) * g[i] * g[i];
    P2[i] = p[i] - lr * wd * p[i] - lr * (M2[i] / c1) / (Math.sqrt(V2[i] / c2) + eps);
  }
  return { p: P2, m: M2, v: V2 };
}
function adamwRef(p, g, m, v, t, lr, b1, b2, eps, wd) {
  if (p.length !== g.length || p.length !== m.length || p.length !== v.length) throw new Error('adamw：p、g、m、v 長度不同');
  return adamwCore(p, g, m, v, lr, b1, b2, eps, wd, 1 - Math.pow(b1, t), 1 - Math.pow(b2, t));
}

const WGSL_ADAMW = `
struct P { n: u32, lr: f32, b1: f32, b2: f32, eps: f32, wd: f32, c1: f32, c2: f32 }
@group(0) @binding(0) var<storage, read_write> pp: array<f32>;
@group(0) @binding(1) var<storage, read> gg: array<f32>;
@group(0) @binding(2) var<storage, read_write> mm: array<f32>;
@group(0) @binding(3) var<storage, read_write> vv: array<f32>;
@group(0) @binding(4) var<uniform> u: P;
// @kernel adamw
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i = gid.x;
  if (i >= u.n) { return; }
  let g = gg[i];
  let m2 = u.b1 * mm[i] + (1.0 - u.b1) * g;
  let v2 = u.b2 * vv[i] + (1.0 - u.b2) * g * g;
  let p0 = pp[i];
  mm[i] = m2;
  vv[i] = v2;
  pp[i] = p0 - u.lr * u.wd * p0 - u.lr * (m2 / u.c1) / (sqrt(v2 / u.c2) + u.eps);
}
`;

async function adamw(p, g, m, v, t, lr, b1, b2, eps, wd, opts) {
  const pf = Float32Array.from(p), gf = Float32Array.from(g), mf = Float32Array.from(m), vf = Float32Array.from(v);
  const n = pf.length;
  return tryLayers('adamw', opts,
    async (dev) => {
      const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t);
      const uni = new ArrayBuffer(32);
      new Uint32Array(uni, 0, 1)[0] = n;
      const fl = new Float32Array(uni, 4, 7);
      fl.set([lr, b1, b2, eps, wd, c1, c2]);
      const outs = await runWgsl(dev, WGSL_ADAMW,
        [{ data: pf, out: true }, { data: gf, out: false }, { data: mf, out: true }, { data: vf, out: true }],
        uni, Math.ceil(n / 64));
      return { p: outs[0], m: outs[1], v: outs[2] };
    },
    () => adamwRef(pf, gf, mf, vf, t, lr, b1, b2, eps, wd));
}

// ---------- 批次提交：同一個 command encoder、中間結果留在 GPU 緩衝區，只在 read() 時回讀 ----------
// 用法：const b = createBatch(dev); const x = b.upload(arr); const y = b.rmsnorm(x, g, T, d, eps); ...
//       const [out] = await b.read([[y, n]]);   // 整批只 submit 一次、回讀只在最後
// 目前涵蓋 RMSNorm、softmax、SiLU、RoPE（同一層內的逐元素與列運算）。matmul 仍走 gpu_core 的獨立呼叫（每次一次往返）。
function createBatch(dev) {
  const enc = dev.createCommandEncoder();
  let submitted = false;
  const stats = { dispatches: 0, readbacks: 0 };
  function storage(n) { return dev.createBuffer({ size: Math.max(4, n * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST }); }
  function upload(arr) { const f = Float32Array.from(arr); const buf = storage(f.length); dev.queue.writeBuffer(buf, 0, f); return { buf: buf, n: f.length }; }
  function dispatch(code, bindBufs, uniform, groups) {
    if (submitted) throw new Error('批次已經提交，不能再加入運算');
    const ub = dev.createBuffer({ size: Math.max(16, Math.ceil(uniform.byteLength / 16) * 16), usage: USAGE.UNIFORM | USAGE.COPY_DST });
    dev.queue.writeBuffer(ub, 0, uniform);
    const module = dev.createShaderModule({ code: code });
    const pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: module, entryPoint: 'main' } });
    const entries = bindBufs.map((b, i) => ({ binding: i, resource: { buffer: b } }));
    entries.push({ binding: bindBufs.length, resource: { buffer: ub } });
    const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries });
    const pass = enc.beginComputePass();
    pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(groups); pass.end();
    stats.dispatches++;
  }
  const b = {
    upload: upload,
    rmsnorm(x, g, T, d, eps) {
      const y = storage(T * d);
      const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 2).set([T, d]); new Float32Array(uni, 8, 1)[0] = eps;
      dispatch(WGSL_RMSNORM, [x.buf, g.buf, y], uni, Math.ceil(T / 64));
      return { buf: y, n: T * d };
    },
    softmax(x, rows, cols) {
      const y = storage(rows * cols);
      const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 2).set([rows, cols]);
      dispatch(WGSL_SOFTMAX, [x.buf, y], uni, Math.ceil(rows / 64));
      return { buf: y, n: rows * cols };
    },
    silu(x) {
      const y = storage(x.n);
      const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 1)[0] = x.n;
      dispatch(WGSL_SILU, [x.buf, y], uni, Math.ceil(x.n / 64));
      return { buf: y, n: x.n };
    },
    rope(x, T, H, hd, dir) {
      const y = storage(T * H * hd);
      const uni = new ArrayBuffer(16); new Uint32Array(uni, 0, 3).set([T, H, hd]); new Float32Array(uni, 12, 1)[0] = dir;
      dispatch(WGSL_ROPE, [x.buf, y], uni, Math.ceil(T * H * (hd / 2) / 64));
      return { buf: y, n: T * H * hd };
    },
    // 一次 submit，整批的回讀都在這裡；specs = [[handle, n], ...]，回傳 Float32Array 陣列
    async read(specs) {
      if (submitted) throw new Error('批次已經提交過');
      submitted = true;
      const rbs = specs.map(([h, n]) => {
        const rb = dev.createBuffer({ size: Math.max(4, n * 4), usage: USAGE.MAP_READ | USAGE.COPY_DST });
        enc.copyBufferToBuffer(h.buf, 0, rb, 0, n * 4);
        return rb;
      });
      dev.queue.submit([enc.finish()]);
      const out = [];
      for (const rb of rbs) {
        await rb.mapAsync(1);
        out.push(new Float32Array(rb.getMappedRange().slice(0)));
        rb.unmap();
        stats.readbacks++;
      }
      return out;
    },
    stats: stats,
  };
  return b;
}

module.exports = { rmsnormRef, rmsnorm, softmaxRef, softmax, siluRef, silu, ropeRef, rope, adamwCore, adamwRef, adamw, createBatch, runWgsl, getDevice, tryLayers, WGSL_RMSNORM, WGSL_SOFTMAX, WGSL_SILU, WGSL_ROPE, WGSL_ADAMW, NOTE_T3 };
