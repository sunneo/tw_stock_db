// infer_ops.js — 離線模型推論用的 cudaweb 核心（DESIGN.webgpu-cuda.md §7.3、§12）。
// 目前內容：q8 反量化矩陣乘兩種（對應 Qwen3-0.6B 現有 onnx q8 權重格式）：
//   q8mm  ：MatMulInteger 路徑。權重 K×N（uint8、單一 zero point），輸入先動態量化成 uint8（扣掉 zero point 後是 int32），
//           累加用 int32（精確），最後乘上 輸入scale×權重scale，與 ORT 的 DynamicQuantizeLinear→MatMulInteger→Cast→Mul 一致。
//   q8lm  ：lm_head 路徑。權重 V×K（詞表×隱藏，uint8、單一 zero point），輸入是 f32，logits[v] = scale · Σ x[k]·(w[v,k] − zp)。
// 每個核心三層：T1 = WGSL、T3 = WebGL2（此檔尚未實作，會寫明）、cpu-js = 參考版。
// 注意：node 內的測試用假裝置只驗證主機端流程；WGSL 的數值要在真 WebGPU（scripts/eval/cudaweb_infer_browser.js）驗證。
'use strict';
const nn = require('./nn_ops.js');

const USAGE = { MAP_READ: 0x0001, COPY_SRC: 0x0004, COPY_DST: 0x0008, UNIFORM: 0x0040, STORAGE: 0x0080 };
const MAX_GROUPS = 65535;
const MAX_CHUNK_BYTES = 64 * 1024 * 1024;  // 預設裝置的儲存緩衝上限 128 MiB；權重照列切成 ≤ 64 MiB 的塊

// ---------- 參考版（CPU，純 JS） ----------
function roundHalfEven(v) {
  const r = Math.round(v);
  return (Math.abs(v % 1) === 0.5 && r % 2 !== 0) ? r - 1 : r;
}
// ORT DynamicQuantizeLinear（uint8）：回傳 { q: Uint8Array, scale, zp }
function quantizeDynamicRef(x) {
  let mn = 0, mx = 0;
  for (let i = 0; i < x.length; i++) { if (x[i] < mn) mn = x[i]; if (x[i] > mx) mx = x[i]; }
  const scale = Math.fround((mx - mn) / 255);
  if (scale === 0) return { q: new Uint8Array(x.length), scale: 1, zp: 0 };
  const zp = Math.min(255, Math.max(0, roundHalfEven(Math.fround(-mn / scale))));
  const q = new Uint8Array(x.length);
  for (let i = 0; i < x.length; i++) q[i] = Math.min(255, Math.max(0, roundHalfEven(Math.fround(x[i] / scale)) + zp));
  return { q: q, scale: scale, zp: zp };
}
// xq：M×K 的 int（已扣輸入 zero point），W：K×N uint8，回傳 Float32Array(M×N)
function q8mmRef(xq, W, wzp, M, K, N, scale) {
  const out = new Float32Array(M * N);
  const acc = new Int32Array(N);
  const sc = Math.fround(scale);
  for (let m = 0; m < M; m++) {
    acc.fill(0);
    for (let k = 0; k < K; k++) {
      const xv = xq[m * K + k];
      if (xv === 0) continue;
      const row = k * N;
      for (let n = 0; n < N; n++) acc[n] += xv * (W[row + n] - wzp);
    }
    for (let n = 0; n < N; n++) out[m * N + n] = Math.fround(Math.fround(acc[n]) * sc);
  }
  return out;
}
// x：K 個 f32，W：V×K uint8 → Float64Array(V)（用雙精度累加，當作「真值」）
function q8lmRef(x, W, wzp, V, K, scale) {
  const out = new Float64Array(V);
  for (let v = 0; v < V; v++) {
    let s = 0; const row = v * K;
    for (let k = 0; k < K; k++) s += x[k] * (W[row + k] - wzp);
    out[v] = s * scale;
  }
  return out;
}

// ---------- WGSL ----------
const WGSL_Q8MM = `
struct P { M: u32, K: u32, N: u32, wzp: i32, scale: f32, p0: u32, p1: u32, p2: u32 }
@group(0) @binding(0) var<storage, read> x: array<i32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
// @kernel q8mm
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let n = gid.x;
  let m = gid.y;
  if (n >= p.N || m >= p.M) { return; }
  var acc: i32 = 0;
  for (var k: u32 = 0u; k < p.K; k = k + 1u) {
    let idx = k * p.N + n;
    let wv = i32((w[idx >> 2u] >> ((idx & 3u) * 8u)) & 255u) - p.wzp;
    acc = acc + x[m * p.K + k] * wv;
  }
  y[m * p.N + n] = f32(acc) * p.scale;
}
`;
// 一個工作群組（64 執行緒）算一個詞表列；每個執行緒讀整個 u32（4 個位元組）。K 必須是 4 的倍數。
const WGSL_Q8LM = `
struct P { rows: u32, K: u32, wzp: i32, scale: f32 }
@group(0) @binding(0) var<storage, read> x: array<f32>;
@group(0) @binding(1) var<storage, read> w: array<u32>;
@group(0) @binding(2) var<storage, read_write> y: array<f32>;
@group(0) @binding(3) var<uniform> p: P;
var<workgroup> sh: array<f32, 64>;
// @kernel q8lm
@compute @workgroup_size(64)
fn main(@builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let row = wid.y * 65535u + wid.x;
  let kw = p.K >> 2u;
  var acc: f32 = 0.0;
  if (row < p.rows) {
    let base = row * kw;
    for (var j: u32 = lid.x; j < kw; j = j + 64u) {
      let word = w[base + j];
      let k4 = j * 4u;
      acc = acc + x[k4] * f32(i32(word & 255u) - p.wzp)
                + x[k4 + 1u] * f32(i32((word >> 8u) & 255u) - p.wzp)
                + x[k4 + 2u] * f32(i32((word >> 16u) & 255u) - p.wzp)
                + x[k4 + 3u] * f32(i32((word >> 24u) & 255u) - p.wzp);
    }
  }
  sh[lid.x] = acc;
  workgroupBarrier();
  for (var s: u32 = 32u; s > 0u; s = s >> 1u) {
    if (lid.x < s) { sh[lid.x] = sh[lid.x] + sh[lid.x + s]; }
    workgroupBarrier();
  }
  if (lid.x == 0u && row < p.rows) { y[row] = sh[0] * p.scale; }
}
`;

// ---------- 主機端：緩衝區與分派 ----------
const wcache = new WeakMap();  // 裝置 → WeakMap(Uint8Array → { buf, bytes })
function packedBytes(u8) {
  const padded = (u8.length + 3) & ~3;
  if (padded === u8.length && (u8.byteOffset & 3) === 0) return new Uint8Array(u8.buffer, u8.byteOffset, u8.length);
  const c = new Uint8Array(padded); c.set(u8); return c;
}
// 權重緩衝區：同一個 Uint8Array 在同一裝置上只上傳一次（常駐）
function weightBuf(dev, u8) {
  let m = wcache.get(dev);
  if (!m) { m = new WeakMap(); wcache.set(dev, m); }
  let e = m.get(u8);
  if (!e) {
    const bytes = packedBytes(u8);
    const buf = dev.createBuffer({ size: bytes.byteLength, usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC });
    dev.queue.writeBuffer(buf, 0, bytes);
    e = { buf: buf, bytes: bytes.byteLength };
    m.set(u8, e);
  }
  return e.buf;
}
const pipes = new WeakMap();  // 裝置 → Map(程式碼 → 管線)
function pipeFor(dev, code) {
  let m = pipes.get(dev);
  if (!m) { m = new Map(); pipes.set(dev, m); }
  let p = m.get(code);
  if (!p) { p = dev.createComputePipeline({ layout: 'auto', compute: { module: dev.createShaderModule({ code: code }), entryPoint: 'main' } }); m.set(code, p); }
  return p;
}
function inBuf(dev, arr) {
  const buf = dev.createBuffer({ size: Math.max(4, arr.byteLength), usage: USAGE.STORAGE | USAGE.COPY_DST | USAGE.COPY_SRC });
  dev.queue.writeBuffer(buf, 0, arr);
  return buf;
}
// 分派一次並讀回輸出（Float32Array，長度 outLen）
async function dispatchRead(dev, code, bufs, outLen, uniform, gx, gy) {
  const out = dev.createBuffer({ size: Math.max(4, outLen * 4), usage: USAGE.STORAGE | USAGE.COPY_SRC | USAGE.COPY_DST });
  const ub = dev.createBuffer({ size: Math.max(16, Math.ceil(uniform.byteLength / 16) * 16), usage: USAGE.UNIFORM | USAGE.COPY_DST });
  dev.queue.writeBuffer(ub, 0, uniform);
  const pipe = pipeFor(dev, code);
  const all = bufs.concat([out]);
  const entries = all.map((b, i) => ({ binding: i, resource: { buffer: b } }));
  entries.push({ binding: all.length, resource: { buffer: ub } });
  const bg = dev.createBindGroup({ layout: pipe.getBindGroupLayout(0), entries: entries });
  const enc = dev.createCommandEncoder();
  const pass = enc.beginComputePass();
  pass.setPipeline(pipe); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(gx, gy || 1); pass.end();
  const rb = dev.createBuffer({ size: Math.max(4, outLen * 4), usage: USAGE.MAP_READ | USAGE.COPY_DST });
  enc.copyBufferToBuffer(out, 0, rb, 0, Math.max(4, outLen * 4));
  dev.queue.submit([enc.finish()]);
  await rb.mapAsync(1);
  const res = new Float32Array(rb.getMappedRange().slice(0, outLen * 4));
  rb.unmap();
  out.destroy && out.destroy(); rb.destroy && rb.destroy(); ub.destroy && ub.destroy();
  return res;
}

function unif(fn) { const ab = new ArrayBuffer(32); fn(new DataView(ab)); return new Uint8Array(ab); }

// ---------- 對外 API ----------
// q8mm：xq（Int32Array，M×K，已扣輸入 zero point）、W（Uint8Array，K×N）、wzp、scale = 輸入scale × 權重scale
async function q8mm(xq, W, wzp, M, K, N, scale, opts) {
  const sc = Math.fround(scale);
  return nn.tryLayers('q8mm', opts,
    async (dev) => {
      const xb = inBuf(dev, Int32Array.from(xq));
      const wb = weightBuf(dev, W);
      const u = unif((d) => { d.setUint32(0, M, true); d.setUint32(4, K, true); d.setUint32(8, N, true); d.setInt32(12, wzp, true); d.setFloat32(16, sc, true); });
      const r = await dispatchRead(dev, WGSL_Q8MM, [xb, wb], M * N, u, Math.ceil(N / 64), M);
      xb.destroy && xb.destroy();
      return r;
    },
    null,
    () => q8mmRef(xq, W, wzp, M, K, N, sc));
}

// q8lm：x（Float32Array K）、W（Uint8Array V×K，不論多大；超過儲存緩衝上限時照列分塊）、回傳 logits
// chunks 可選：事先切好的 Uint8Array 陣列（同一個陣列物件重複使用才能常駐），沒給就用 W.subarray 切（每次新物件，不常駐）
function planChunks(W, V, K, maxBytes) {
  const rowsPer = Math.max(1, Math.floor(maxBytes / K));
  const out = [];
  for (let r = 0; r < V; r += rowsPer) { const n = Math.min(rowsPer, V - r); out.push({ row0: r, rows: n, w: W.subarray(r * K, (r + n) * K) }); }
  return out;
}
async function q8lm(x, chunks, wzp, K, scale, opts) {
  const xf = Float32Array.from(x);
  const V = chunks.reduce((s, c) => s + c.rows, 0);
  const sc = Math.fround(scale);
  return nn.tryLayers('q8lm', opts,
    async (dev) => {
      if (K % 4 !== 0) throw new Error('q8lm：K 必須是 4 的倍數（K=' + K + '）');
      const xb = inBuf(dev, xf);
      const out = new Float32Array(V);
      for (const c of chunks) {
        const wb = weightBuf(dev, c.w);
        const u = unif((d) => { d.setUint32(0, c.rows, true); d.setUint32(4, K, true); d.setInt32(8, wzp, true); d.setFloat32(12, sc, true); });
        const r = await dispatchRead(dev, WGSL_Q8LM, [xb, wb], c.rows, u, Math.min(c.rows, MAX_GROUPS), Math.ceil(c.rows / MAX_GROUPS));
        out.set(r, c.row0);
      }
      xb.destroy && xb.destroy();
      return out;
    },
    null,
    () => {
      const o = new Float32Array(V);
      for (const c of chunks) { const r = q8lmRef(xf, c.w, wzp, c.rows, K, sc); for (let i = 0; i < c.rows; i++) o[c.row0 + i] = r[i]; }
      return o;
    });
}

// ---------- WebGL2（T3）：lm_head 的 q8 矩陣乘退路 ----------
// 權重打包成 RGBA8 紋理：每個紋理像素是同一列的 4 個相鄰位元組（k=4j..4j+3），紋理寬度 = maxTex，
// 紋理像素序號 t = 列×(K/4)+j。一個分塊（tile）＝一張 maxTex×maxTex 的紋理（至多 maxTex² 個像素）。
// 片段著色器每個輸出（一個詞表列）讀 K/4 個像素做點積；x 放在寬 K、高 1 的 RGBA32F 紋理（R 通道）。
// 輸出寫進 RGBA32F 的 FBO，readPixels 讀回。需要 EXT_color_buffer_float（nn.glSupport 會檢查）。
const VS_GL = '#version 300 es\nvoid main(){ vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2)); gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }\n';
const FS_Q8LM_GL = `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uW;
uniform highp sampler2D uX;
uniform int uK4;
uniform int uTW;
uniform int uRows;
uniform int uOW;
uniform float uZp;
uniform float uScale;
out vec4 fragColor;
void main() {
  int idx = int(gl_FragCoord.y) * uOW + int(gl_FragCoord.x);
  if (idx >= uRows) { fragColor = vec4(0.0); return; }
  float acc = 0.0;
  for (int j = 0; j < uK4; j++) {
    int t = idx * uK4 + j;
    vec4 b = floor(texelFetch(uW, ivec2(t % uTW, t / uTW), 0) * 255.0 + 0.5);
    int k = j * 4;
    acc += texelFetch(uX, ivec2(k, 0), 0).r * (b.r - uZp)
         + texelFetch(uX, ivec2(k + 1, 0), 0).r * (b.g - uZp)
         + texelFetch(uX, ivec2(k + 2, 0), 0).r * (b.b - uZp)
         + texelFetch(uX, ivec2(k + 3, 0), 0).r * (b.a - uZp);
  }
  fragColor = vec4(acc * uScale, 0.0, 0.0, 1.0);
}`;
const glStateOf = new WeakMap();  // WebGL2 上下文 → { prog, maxTex, weights: WeakMap(權重陣列 → 分塊紋理) }
function glStateFor(gl) {
  let s = glStateOf.get(gl);
  if (!s) {
    const maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE) || 4096;
    s = { prog: null, maxTex: maxTex, weights: new WeakMap() };
    glStateOf.set(gl, s);
  }
  return s;
}
function glCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error('著色器編譯失敗：' + gl.getShaderInfoLog(sh));
  return sh;
}
function glProgramFor(gl, st) {
  if (st.prog) return st.prog;
  const p = gl.createProgram();
  gl.attachShader(p, glCompile(gl, gl.VERTEX_SHADER, VS_GL));
  gl.attachShader(p, glCompile(gl, gl.FRAGMENT_SHADER, FS_Q8LM_GL));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error('程式連結失敗：' + gl.getProgramInfoLog(p));
  st.prog = p;
  return p;
}
function glTex2D(gl, internal, w, h) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, w, h);
  return t;
}
// 把一個分塊的權重（rows×K 位元組）打包成 maxTex 寬的 RGBA8 紋理（尾端補 0）
function glUploadWeightTile(gl, bytes, texels, maxTex) {
  const th = Math.max(1, Math.ceil(texels / maxTex));
  const px = new Uint8Array(maxTex * th * 4);
  px.set(bytes);
  const t = glTex2D(gl, gl.RGBA8, maxTex, th);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, maxTex, th, gl.RGBA, gl.UNSIGNED_BYTE, px);
  return { tex: t };
}
// WebGL2 版 lm_head：整張權重（V×K）依 maxTex² 切塊，權重紋理快取在上下文上（同一個權重陣列只上傳一次）
function q8lmGl(gl, x, W, V, K, zp, scale) {
  const sup = nn.glSupport(gl);
  if (!sup.ok) throw new Error(sup.reason);
  if (K % 4 !== 0) throw new Error('q8lm（WebGL2）：K 必須是 4 的倍數（K=' + K + '）');
  const st = glStateFor(gl);
  const maxTex = st.maxTex, K4 = K / 4;
  if (K > maxTex) throw new Error('q8lm（WebGL2）：K=' + K + ' 超過紋理寬度上限 ' + maxTex);
  const prog = glProgramFor(gl, st);
  const tileRows = Math.floor(maxTex * maxTex / K4);
  let tiles = st.weights.get(W);
  if (!tiles) {
    tiles = [];
    for (let r0 = 0; r0 < V; r0 += tileRows) {
      const n = Math.min(tileRows, V - r0);
      tiles.push({ row0: r0, rows: n, tex: glUploadWeightTile(gl, W.subarray(r0 * K, (r0 + n) * K), n * K4, maxTex).tex });
    }
    st.weights.set(W, tiles);
  }
  // x：寬 K、高 1 的 RGBA32F（R 通道）
  const xpx = new Float32Array(K * 4);
  for (let k = 0; k < K; k++) xpx[k * 4] = x[k];
  const xTex = glTex2D(gl, gl.RGBA32F, K, 1);
  gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, K, 1, gl.RGBA, gl.FLOAT, xpx);
  const out = new Float32Array(V);
  const fb = gl.createFramebuffer();
  const tmp = [xTex];
  try {
    gl.useProgram(prog);
    const uW = gl.getUniformLocation(prog, 'uW'), uX = gl.getUniformLocation(prog, 'uX');
    gl.uniform1i(uW, 0); gl.uniform1i(uX, 1);
    gl.uniform1i(gl.getUniformLocation(prog, 'uK4'), K4);
    gl.uniform1i(gl.getUniformLocation(prog, 'uTW'), maxTex);
    gl.uniform1f(gl.getUniformLocation(prog, 'uZp'), zp);
    gl.uniform1f(gl.getUniformLocation(prog, 'uScale'), scale);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    for (const tile of tiles) {
      const ow = Math.min(tile.rows, maxTex), oh = Math.ceil(tile.rows / ow);
      const oTex = glTex2D(gl, gl.RGBA32F, ow, oh);
      tmp.push(oTex);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, oTex, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('WebGL2 幀緩衝區不完整');
      gl.uniform1i(gl.getUniformLocation(prog, 'uRows'), tile.rows);
      gl.uniform1i(gl.getUniformLocation(prog, 'uOW'), ow);
      gl.viewport(0, 0, ow, oh);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tile.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, xTex);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      const buf = new Float32Array(ow * oh * 4);
      gl.readPixels(0, 0, ow, oh, gl.RGBA, gl.FLOAT, buf);
      for (let i = 0; i < tile.rows; i++) out[tile.row0 + i] = buf[i * 4];
    }
  } finally {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.deleteFramebuffer(fb);
    for (const t of tmp) gl.deleteTexture(t);
  }
  return out;
}

// 分塊快取：同一個權重陣列只切一次（分塊物件穩定，WGSL 端的權重緩衝區才能常駐）
const chunkCache = new WeakMap();
function cachedChunks(W, V, K, maxBytes) {
  let c = chunkCache.get(W);
  if (!c) { c = planChunks(W, V, K, maxBytes); chunkCache.set(W, c); }
  return c;
}
// WebGPU 版 lm_head（分塊、常駐權重）；丟例外由呼叫端決定退路
async function q8lmWgsl(dev, x, chunks, K, zp, scale) {
  if (K % 4 !== 0) throw new Error('q8lm：K 必須是 4 的倍數（K=' + K + '）');
  const xf = Float32Array.from(x);
  const V = chunks.reduce((s, c) => s + c.rows, 0);
  const sc = Math.fround(scale);
  const xb = inBuf(dev, xf);
  const out = new Float32Array(V);
  try {
    for (const c of chunks) {
      const wb = weightBuf(dev, c.w);
      const u = unif((d) => { d.setUint32(0, c.rows, true); d.setUint32(4, K, true); d.setInt32(8, zp, true); d.setFloat32(12, sc, true); });
      const r = await dispatchRead(dev, WGSL_Q8LM, [xb, wb], c.rows, u, Math.min(c.rows, MAX_GROUPS), Math.ceil(c.rows / MAX_GROUPS));
      out.set(r, c.row0);
    }
  } finally { xb.destroy && xb.destroy(); }
  return out;
}

// 自動選層的 lm_head（網頁版與桌面版渲染行程共用）：T1 WebGPU（分塊）→ T3 WebGL2（紋理分塊）。
// 都不可用或執行失敗就丟出「每一層各自的原因」，呼叫端退回 ONNX 路徑；不走慢的純 JS（比 ORT 還慢，沒有意義）。
// opts：{ navigator, gl, skipT1 }（測試用：skipT1 強制走 WebGL2）。回傳 { result, info:{ layer, ms, reasons } }。
async function q8lmAuto(x, W, V, K, zp, scale, opts) {
  const o = opts || {};
  const nav = o.navigator !== undefined ? o.navigator : (typeof navigator !== 'undefined' ? navigator : undefined);
  const reasons = [];
  const t0 = Date.now();
  if (!o.skipT1) {
    const g = await nn.getDevice(nav);
    if (g.dev) {
      try {
        const r = await q8lmWgsl(g.dev, x, cachedChunks(W, V, K, MAX_CHUNK_BYTES), K, zp, scale);
        return { result: r, info: { layer: 'T1', ms: Date.now() - t0, reasons: reasons } };
      } catch (e) { reasons.push('WebGPU 執行失敗：' + String((e && e.message) || e)); }
    } else reasons.push(g.reason || 'WebGPU 不可用');
  } else reasons.push('已指定跳過 WebGPU');
  const gl = o.gl !== undefined ? o.gl : nn.getGl({ navigator: nav });
  if (gl) {
    try {
      const t1 = Date.now();
      const r = q8lmGl(gl, x, W, V, K, zp, scale);
      return { result: r, info: { layer: 'T3', ms: Date.now() - t1, reasons: reasons } };
    } catch (e) { reasons.push('WebGL2 執行失敗：' + String((e && e.message) || e)); }
  } else reasons.push('WebGL2 上下文不可用');
  const err = new Error('lm_head 沒有可用的 GPU 層（' + reasons.join('；') + '）');
  err.reasons = reasons;
  throw err;
}

module.exports = { quantizeDynamicRef, q8mmRef, q8lmRef, q8mm, q8lm, q8lmAuto, q8lmGl, q8lmWgsl, cachedChunks, planChunks, WGSL_Q8MM, WGSL_Q8LM, FS_Q8LM_GL, MAX_GROUPS, MAX_CHUNK_BYTES };
