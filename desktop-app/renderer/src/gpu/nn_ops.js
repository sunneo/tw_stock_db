// nn_ops.js — 訓練步用的 cudaweb 核心（DESIGN.webgpu-cuda.md §12.4，第三階段後段）。
// 每個操作三層：T1 = WGSL（WebGPU）、T3 = WebGL2（尚未實作，會寫明）、cpu-js = CPU 參考版。
// 目前已完成的操作：RMSNorm。之後依序加入 softmax、SiLU、RoPE、AdamW。
// 注意：WGSL 原始碼在真 WebGPU 上尚未驗證；測試的假裝置用 CPU 參考版執行，只驗證主機端的綁定、回讀與降級流程。
'use strict';
const core = require('./gpu_core.js');

const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
// WebGL2 常數（用數字，因為假 WebGL2 上下文沒有這些符號）
const GLC = { VERTEX: 0x8B31, FRAG: 0x8B30, COMPILE: 0x8B81, LINK: 0x8B82, TEX2D: 0x0DE1, RGBA32F: 0x8814, RGBA: 0x1908, FLOAT: 0x1406,
  FB: 0x8D40, COLOR0: 0x8CE0, FB_OK: 0x8CD5, UNIT0: 0x84C0, TRIANGLES: 0x0004, NEAREST: 0x2600, MIN_F: 0x2801, MAG_F: 0x2800, MAX_TEX: 0x0D33 };
const NOTE_T3 = 'WebGL2 版尚未實作';  // 僅供舊測試參照；新版降級原因以實際狀態為準

// 取得 WebGL2 上下文：opts.gl 可注入（測試用）；瀏覽器用 OffscreenCanvas；沒有就 null
function getGl(opts) {
  const o = opts || {};
  if (o.gl !== undefined) return o.gl;
  if (typeof OffscreenCanvas !== 'undefined') {
    try { return new OffscreenCanvas(1, 1).getContext('webgl2'); } catch (e) { return null; }
  }
  return null;
}
// WebGL2 可用性：需要上下文，且需要 EXT_color_buffer_float（浮點渲染目標）。沒有編碼退路（RGBA8 打包未實作）。
function glSupport(gl) {
  if (!gl) return { ok: false, reason: 'WebGL2 上下文不可用' };
  if (!gl.getExtension('EXT_color_buffer_float')) return { ok: false, reason: 'WebGL2 沒有 EXT_color_buffer_float（浮點渲染目標），無法寫入 f32 結果；RGBA8 編碼退路尚未實作' };
  return { ok: true, reason: '' };
}

// 全螢幕三角形（用 gl_VertexID，不需要頂點緩衝區）
const VS_FULL = '#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n';

// 把長度 len 的陣列打包成 W×H 的 RGBA32F 紋理（只用 R 通道）
function packTex(gl, arr, W, H) {
  const px = new Float32Array(W * H * 4);
  for (let i = 0; i < arr.length; i++) px[i * 4] = arr[i];
  const tex = gl.createTexture();
  gl.bindTexture(GLC.TEX2D, tex); // 呼叫端已先選好 texture unit
  gl.texParameteri(GLC.TEX2D, GLC.MIN_F, GLC.NEAREST);
  gl.texParameteri(GLC.TEX2D, GLC.MAG_F, GLC.NEAREST);
  gl.texStorage2D(GLC.TEX2D, 1, GLC.RGBA32F, W, H);
  gl.texSubImage2D(GLC.TEX2D, 0, 0, 0, W, H, GLC.RGBA, GLC.FLOAT, px);
  return tex;
}

// 單趟繪製：ins = [Float32Array]（依序綁定 uniform sampler uIn0、uIn1…，在 shader 裡宣告）；
// uni = { i: {名稱: 整數}, f: {名稱: 浮點} }；n = 輸出長度。shader 的 uW 由這裡自動給（所有紋理共用寬度）。
// 回傳 Float32Array(n)：第 k 個元素在紋理的 (k % W, floor(k / W))，取 R 通道。
function glRun(gl, fsSrc, ins, uni, n, samplerNames) {
  const maxTex = gl.getParameter(GLC.MAX_TEX) || 4096;
  const longest = Math.max(n, ...ins.map((a) => a.length));
  const W = Math.max(1, Math.min(maxTex, longest));
  const outH = Math.ceil(n / W), inH = Math.ceil(longest / W);
  if (outH > maxTex) throw new Error('WebGL2：輸出 ' + n + ' 個元素超過紋理上限（寬 ' + W + '、高 ' + outH + '），需要分塊（尚未實作）');
  const vs = gl.createShader(GLC.VERTEX); gl.shaderSource(vs, VS_FULL); gl.compileShader(vs);
  const fs = gl.createShader(GLC.FRAG); gl.shaderSource(fs, fsSrc); gl.compileShader(fs);
  if (!gl.getShaderParameter(fs, GLC.COMPILE)) throw new Error('WebGL2 片段著色器編譯失敗：' + gl.getShaderInfoLog(fs));
  const prog = gl.createProgram(); gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, GLC.LINK)) throw new Error('WebGL2 程式連結失敗：' + gl.getProgramInfoLog(prog));
  gl.useProgram(prog);
  const texs = [];
  ins.forEach((a, k) => {
    gl.activeTexture(GLC.UNIT0 + k);
    texs.push(packTex(gl, a, W, inH));
    gl.uniform1i(gl.getUniformLocation(prog, samplerNames[k]), k);
  });
  const uOut = ins.length;
  const outTex = gl.createTexture();
  gl.activeTexture(GLC.UNIT0 + uOut); gl.bindTexture(GLC.TEX2D, outTex);
  gl.texParameteri(GLC.TEX2D, GLC.MIN_F, GLC.NEAREST); gl.texParameteri(GLC.TEX2D, GLC.MAG_F, GLC.NEAREST);
  gl.texStorage2D(GLC.TEX2D, 1, GLC.RGBA32F, W, outH);
  const fb = gl.createFramebuffer();
  gl.bindFramebuffer(GLC.FB, fb);
  gl.framebufferTexture2D(GLC.FB, GLC.COLOR0, GLC.TEX2D, outTex, 0);
  if (gl.checkFramebufferStatus(GLC.FB) !== GLC.FB_OK) throw new Error('WebGL2 幀緩衝不完整（可能不支援浮點渲染目標）');
  gl.uniform1i(gl.getUniformLocation(prog, 'uW'), W);
  for (const k of Object.keys(uni.i || {})) gl.uniform1i(gl.getUniformLocation(prog, k), uni.i[k]);
  for (const k of Object.keys(uni.f || {})) gl.uniform1f(gl.getUniformLocation(prog, k), uni.f[k]);
  gl.viewport(0, 0, W, outH);
  gl.drawArrays(GLC.TRIANGLES, 0, 3);
  const px = new Float32Array(W * outH * 4);
  gl.readPixels(0, 0, W, outH, GLC.RGBA, GLC.FLOAT, px);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = px[i * 4];
  // 釋放（假上下文不一定有全部方法，逐一檢查）
  [...texs, outTex].forEach((t) => { if (gl.deleteTexture) gl.deleteTexture(t); });
  if (gl.deleteFramebuffer) gl.deleteFramebuffer(fb);
  return out;
}

// 三層的實際狀態：供 backend_info 與測試使用。ops 只列這個檔案實作的核心。
const NN_OPS = ['rmsnorm', 'softmax', 'silu', 'rope', 'adamw'];
async function nnBackendInfo(opts) {
  const o = opts || {};
  const nav = o.navigator !== undefined ? o.navigator : (typeof navigator !== 'undefined' ? navigator : undefined);
  const g = await getDevice(nav);
  const gs = glSupport(getGl(o));
  const ops = {};
  for (const op of NN_OPS) ops[op] = { t1: g.dev ? 'native' : 'missing', t3: gs.ok ? 'native' : 'missing', cpu: 'native' };
  return { webgpu: { available: !!g.dev, reason: g.reason || '' }, webgl2: { available: gs.ok, reason: gs.reason }, ops: ops };
}

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
  // pipeline 快取（同一份 WGSL 只建一次；原本每次呼叫都重建，是注意力比 CPU 慢的主因之一）
  const pc = dev.__cudawebPipes || (dev.__cudawebPipes = new Map());
  let pipe = pc.get(code);
  if (!pipe) { const module = dev.createShaderModule({ code: code }); pipe = dev.createComputePipeline({ layout: 'auto', compute: { module: module, entryPoint: 'main' } }); pc.set(code, pipe); }
  const entries = objs.map((buf, i) => ({ binding: i, resource: { buffer: buf } }));
  entries.push({ binding: bufs.length, resource: { buffer: ub } });
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe); pass.setBindGroup(0, bg);
  // 超過單維 65535 個工作群組時改二維派發；著色器以 gid.x + gid.y·4194240（=65535×64）還原扁平索引
  if (groups > 65535) pass.dispatchWorkgroups(65535, Math.ceil(groups / 65535)); else pass.dispatchWorkgroups(groups);
  pass.end();
  const rb = bufs.map((b) => (b.out ? dev.createBuffer({ size: b.data.byteLength, usage: USAGE.MAP_READ | USAGE.COPY_DST }) : null));
  bufs.forEach((b, i) => { if (b.out) enc.copyBufferToBuffer(objs[i], 0, rb[i], 0, b.data.byteLength); });
  dev.queue.submit([enc.finish()]);
  const outs = [];
  for (let i = 0; i < bufs.length; i++) {
    if (!bufs[i].out) continue;
    await rb[i].mapAsync(1);
    outs.push(new (bufs[i].data.constructor === Int32Array ? Int32Array : Float32Array)(rb[i].getMappedRange().slice(0)));
    rb[i].unmap();
  }
  return outs;
}

// 先試 T1；沒有 WebGPU、或執行失敗就退到 CPU 參考版，原因照實寫進 info
// 三層：T1（WGSL）→ T3（WebGL2）→ cpu-js。每一層失敗都把原因接到 reason。
async function tryLayers(name, opts, gpuFn, glFn, refFn) {
  const o = opts || {};
  const nav = o.navigator !== undefined ? o.navigator : (typeof navigator !== 'undefined' ? navigator : undefined);
  const notes = [];
  const glAvail = glSupport(getGl(o)).ok && !!glFn ? 'native' : 'missing';  // webgl2 欄位回報「這個核心的 WebGL2 層是否可用」
  const g = await getDevice(nav);
  if (g.dev) {
    try { return { result: await gpuFn(g.dev), info: layerInfo(name, 'T1', '', glAvail) }; }
    catch (e) { notes.push('WGSL 執行失敗：' + String((e && e.message) || e)); }
  } else notes.push(g.reason);
  const gl = getGl(o);
  const gs = glSupport(gl);
  let glState = 'missing';
  if (gs.ok && glFn) {
    glState = 'native';
    try { return { result: glFn(gl), info: layerInfo(name, 'T3', notes.join('；'), 'native') }; }
    catch (e) { glState = 'failed'; notes.push('WebGL2 執行失敗：' + String((e && e.message) || e)); }
  } else if (!gs.ok) notes.push(gs.reason);
  else notes.push('WebGL2 版尚未實作（此核心）');
  return { result: refFn(), info: layerInfo(name, 'cpu-js', notes.join('；'), glState) };
}
function layerInfo(op, layer, reason, webgl2) {
  return { lib: 'cudaweb-nn', op: op, layer: layer, reason: reason || '', webgl2: webgl2 };
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

// WebGL2 片段著色器：每個輸出像素算自己那一列的平方和（單趟、不用多趟縮減；列長度小時成本可接受，大列再改多趟）
const FS_RMSNORM = `#version 300 es
precision highp float;
precision highp int;
// @kernel rmsnorm
uniform highp sampler2D uX;
uniform highp sampler2D uG;
uniform int uW;
uniform int uRows;
uniform int uD;
uniform float uEps;
out vec4 fragColor;
float fetchX(int i) { return texelFetch(uX, ivec2(i % uW, i / uW), 0).r; }
float fetchG(int i) { return texelFetch(uG, ivec2(i % uW, i / uW), 0).r; }
void main() {
  int idx = int(gl_FragCoord.y) * uW + int(gl_FragCoord.x);
  if (idx >= uRows * uD) { fragColor = vec4(0.0); return; }
  int row = idx / uD;
  int i = idx - row * uD;
  float s = 0.0;
  for (int j = 0; j < uD; j++) { float v = fetchX(row * uD + j); s += v * v; }
  float inv = 1.0 / sqrt(s / float(uD) + uEps);
  fragColor = vec4(fetchX(idx) * inv * fetchG(i), 0.0, 0.0, 1.0);
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
    (gl) => glRun(gl, FS_RMSNORM, [xf, gf], { i: { uRows: T, uD: d }, f: { uEps: eps } }, T * d, ['uX', 'uG']),
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

// WebGL2 片段著色器：每個輸出像素對自己那一列取最大值與指數和（單趟）
const FS_SOFTMAX = `#version 300 es
precision highp float;
precision highp int;
// @kernel softmax
uniform highp sampler2D uX;
uniform int uW;
uniform int uRows;
uniform int uCols;
out vec4 fragColor;
float fetchX(int i) { return texelFetch(uX, ivec2(i % uW, i / uW), 0).r; }
void main() {
  int idx = int(gl_FragCoord.y) * uW + int(gl_FragCoord.x);
  if (idx >= uRows * uCols) { fragColor = vec4(0.0); return; }
  int row = idx / uCols;
  float mx = fetchX(row * uCols);
  for (int c = 1; c < uCols; c++) mx = max(mx, fetchX(row * uCols + c));
  float s = 0.0;
  for (int c = 0; c < uCols; c++) s += exp(fetchX(row * uCols + c) - mx);
  fragColor = vec4(exp(fetchX(idx) - mx) / s, 0.0, 0.0, 1.0);
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
    (gl) => glRun(gl, FS_SOFTMAX, [xf], { i: { uRows: rows, uCols: cols } }, rows * cols, ['uX']),
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

// WebGL2 片段著色器：逐元素 x / (1 + e^(−x))
const FS_SILU = `#version 300 es
precision highp float;
precision highp int;
// @kernel silu
uniform highp sampler2D uX;
uniform int uW;
uniform int uN;
out vec4 fragColor;
void main() {
  int idx = int(gl_FragCoord.y) * uW + int(gl_FragCoord.x);
  if (idx >= uN) { fragColor = vec4(0.0); return; }
  float v = texelFetch(uX, ivec2(idx % uW, idx / uW), 0).r;
  fragColor = vec4(v / (1.0 + exp(-v)), 0.0, 0.0, 1.0);
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
    (gl) => glRun(gl, FS_SILU, [xf], { i: { uN: xf.length } }, xf.length, ['uX']),
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

// WebGL2 片段著色器：每個輸出元素依自己在 (t, h, 對) 中的位置，取出同一對的兩個輸入做旋轉
const FS_ROPE = `#version 300 es
precision highp float;
precision highp int;
// @kernel rope
uniform highp sampler2D uX;
uniform int uW;
uniform int uT;
uniform int uH;
uniform int uHd;
uniform float uDir;
out vec4 fragColor;
float fetchX(int i) { return texelFetch(uX, ivec2(i % uW, i / uW), 0).r; }
void main() {
  int idx = int(gl_FragCoord.y) * uW + int(gl_FragCoord.x);
  int d = uH * uHd;
  if (idx >= uT * d) { fragColor = vec4(0.0); return; }
  int t = idx / d;
  int rem = idx - t * d;
  int r2 = rem % uHd;
  int i = r2 / 2;
  int o = idx - (r2 - 2 * i);
  float th = float(t) * pow(10000.0, -2.0 * float(i) / float(uHd));
  float c = cos(th);
  float s = uDir * sin(th);
  float a = fetchX(o);
  float b = fetchX(o + 1);
  float v = (r2 == 2 * i) ? (a * c - b * s) : (a * s + b * c);
  fragColor = vec4(v, 0.0, 0.0, 1.0);
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
    (gl) => glRun(gl, FS_ROPE, [xf], { i: { uT: T, uH: H, uHd: hd }, f: { uDir: dir } }, xf.length, ['uX']),
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

// WebGL2：AdamW 三個輸出各一趟（不用多個 draw buffer）。每趟都從四個輸入重算 m2、v2，所以三趟互不依賴。
function fsAdamw(tag, outExpr) {
  return `#version 300 es
precision highp float;
precision highp int;
// @kernel ${tag}
uniform highp sampler2D uP;
uniform highp sampler2D uG;
uniform highp sampler2D uM;
uniform highp sampler2D uV;
uniform int uW;
uniform int uN;
uniform float uLr;
uniform float uB1;
uniform float uB2;
uniform float uEps;
uniform float uWd;
uniform float uC1;
uniform float uC2;
out vec4 fragColor;
float fetch(sampler2D t, int i) { return texelFetch(t, ivec2(i % uW, i / uW), 0).r; }
void main() {
  int idx = int(gl_FragCoord.y) * uW + int(gl_FragCoord.x);
  if (idx >= uN) { fragColor = vec4(0.0); return; }
  float p = fetch(uP, idx);
  float g = fetch(uG, idx);
  float m = fetch(uM, idx);
  float v = fetch(uV, idx);
  float m2 = uB1 * m + (1.0 - uB1) * g;
  float v2 = uB2 * v + (1.0 - uB2) * g * g;
  fragColor = vec4(${outExpr}, 0.0, 0.0, 1.0);
}
`;
}
const FS_ADAMW_P = fsAdamw('adamw_p', 'p - uLr * uWd * p - uLr * (m2 / uC1) / (sqrt(v2 / uC2) + uEps)');
const FS_ADAMW_M = fsAdamw('adamw_m', 'm2');
const FS_ADAMW_V = fsAdamw('adamw_v', 'v2');

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
    (gl) => {
      const c1 = 1 - Math.pow(b1, t), c2 = 1 - Math.pow(b2, t);
      const ins = [pf, gf, mf, vf], names = ['uP', 'uG', 'uM', 'uV'];
      const uni = { i: { uN: n }, f: { uLr: lr, uB1: b1, uB2: b2, uEps: eps, uWd: wd, uC1: c1, uC2: c2 } };
      return {
        p: glRun(gl, FS_ADAMW_P, ins, uni, n, names),
        m: glRun(gl, FS_ADAMW_M, ins, uni, n, names),
        v: glRun(gl, FS_ADAMW_V, ins, uni, n, names),
      };
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
    // （批次內的 rmsnorm、softmax、silu、rope 都只走 T1；批次是 GPU 內連續運算，不經過 WebGL2）
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

// 訓練器用的運算介面（lora_ref_train.js 的 lossAndGradsAsync／adamStepAsync 接受的 ops）。
// 每次呼叫都走三層降級（T1 → T3 → cpu-js），並把實際使用的層記在 stats 裡，給後端選單與測試用。
function trainerOps(opts) {
  const o = opts || {};
  const stats = { calls: 0, layers: {}, last: null };
  const rec = (op, info) => {
    stats.calls++;
    const key = op + ':' + info.layer;
    stats.layers[key] = (stats.layers[key] || 0) + 1;
    stats.last = info;
  };
  return {
    stats: stats,
    rmsnorm: async (x, g, T, d, eps) => { const r = await rmsnorm(x, g, T, d, eps, o); rec('rmsnorm', r.info); return r.result; },
    softmax: async (x, rows, cols) => { const r = await softmax(x, rows, cols, o); rec('softmax', r.info); return r.result; },
    silu: async (x) => { const r = await silu(x, o); rec('silu', r.info); return r.result; },
    rope: async (x, T, H, hd, dir) => { const r = await rope(x, T, H, hd, dir, o); rec('rope', r.info); return r.result; },
    adamw: async (p, g, m, v, t, lr, b1, b2, eps, wd) => { const r = await adamw(p, g, m, v, t, lr, b1, b2, eps, wd, o); rec('adamw', r.info); return r.result; },
  };
}

module.exports = { trainerOps, rmsnormRef, rmsnorm, softmaxRef, softmax, siluRef, silu, ropeRef, rope, adamwCore, adamwRef, adamw, createBatch, runWgsl, getDevice, getGl, glSupport, glRun, tryLayers, nnBackendInfo, NN_OPS, WGSL_RMSNORM, WGSL_SOFTMAX, WGSL_SILU, WGSL_ROPE, WGSL_ADAMW, NOTE_T3 };
