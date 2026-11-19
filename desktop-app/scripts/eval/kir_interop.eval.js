// OpenCL 與繪圖的 interop 評估（DESIGN.webgpu-cuda.md §13 階段 9）：nbody 的 4 個加速度核心（N=3072）＋點精靈繪圖，
// 比較「位置不讀回、直接從 GPU 資料畫」與「每幀讀回 x、y、z 再上傳頂點」的每幀耗時；並檢查 WebGL2 兩種畫法的像素是否相同。
// 路線 A（WebGPU）：render pipeline 直接讀位置的 storage buffer，畫到 WebGPU 畫布（不讀回）。
// 路線 B（WebGL2）：頂點著色器用 texelFetch 直接讀位置紋理（不讀回）；對照組是讀回後上傳 VBO 再畫。
// 注意：這是獨立的評測場景（同樣的核心與點數），不是 app 的 nbody 程式；cluster() 的攝影機中心仍需要讀回，未在這裡計入。
// 由 scripts/eval/kir_interop.build.js 產生。結果：KIR_INTEROP {…}。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.webgpu); load(SRC.front);
const K = window.FaKir, FR = window.FaClFront, WGD = window.FaKirWebGPU, GLD = window.FaKirWebGL2;
const R = { errors: [] };
const N = 3072, WARM = 3, FRAMES = 20, SCALE = 0.004;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const kmap = (src) => { const o = {}; for (const k of FR.parseKernels(src).kernels) o[k.name] = k; return o; };
const NB = kmap(SRC.nbody);
const KERN = ['accx', 'accy', 'accz', 'accpot'].map((n) => NB[n]).filter(Boolean);
const bufParams = (k) => k.params.filter((p) => p.ptr || p.kind === 'buf');
const scalParams = (k) => k.params.filter((p) => !(p.ptr || p.kind === 'buf'));
const scalarVal = (name) => (name === 'n' ? N : 0.05);
let seed = 4242; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
// 位置：x、y、z 在 [0, 500)，質量 [0.1, 1)
const POS = {};
for (const k of KERN) for (const p of bufParams(k)) if (!(p.name in POS)) {
  const a = new Float32Array(N); for (let i = 0; i < N; i++) a[i] = p.name === 'ms' ? 0.1 + 0.9 * rnd() : 500 * rnd();
  POS[p.name] = a;
}
const elemOf = (p) => p.elem || 'f32';

// 同一個「步」：4 個加速度核心依序，共用緩衝區依名字
function stepDev(dev, shared) {
  for (const k of KERN) {
    const binds = {}; let on = null;
    for (const p of bufParams(k)) { binds[p.name] = shared[p.name]; if (p.access === 'out') on = p.name; }
    const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name);
    dev.dispatch(k, binds, binds[on], S, N);
  }
}
const POS_NAMES = ['x', 'y', 'z'];

// ---- 路線 A：WebGPU
async function runWebgpu() {
  const out = {};
  const adapter = await navigator.gpu.requestAdapter();
  const gdev = await adapter.requestDevice();
  let lost = null; gdev.lost.then((i) => { lost = i.reason + ':' + i.message; });
  const dev = WGD.createDevice(gdev, { wg: 64 });
  const shared = {};
  for (const k of KERN) for (const p of bufParams(k)) if (!shared[p.name]) shared[p.name] = dev.alloc(N, elemOf(p));
  for (const n of Object.keys(shared)) if (POS[n]) dev.upload(shared[n], POS[n]);
  // 畫布（不接到 DOM；getCurrentTexture 在離屏畫布也能用）
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  const ctx = cv.getContext('webgpu'); const fmt = navigator.gpu.getPreferredCanvasFormat();
  ctx.configure({ device: gdev, format: fmt, alphaMode: 'opaque' });
  const wgsl = `
@group(0) @binding(0) var<storage, read> X: array<f32>;
@group(0) @binding(1) var<storage, read> Y: array<f32>;
@group(0) @binding(2) var<storage, read> Z: array<f32>;
@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  return vec4<f32>(X[i] * ${SCALE}f - 1.0, Y[i] * ${SCALE}f - 1.0, 0.0, 1.0);
}
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }`;
  const mod = gdev.createShaderModule({ code: wgsl });
  const bgl = gdev.createBindGroupLayout({ entries: [0, 1, 2].map((b) => ({ binding: b, visibility: 1, buffer: { type: 'read-only-storage' } })) });
  const pipe = gdev.createRenderPipeline({ layout: gdev.createPipelineLayout({ bindGroupLayouts: [bgl] }), vertex: { module: mod, entryPoint: 'vs' }, fragment: { module: mod, entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: { topology: 'point-list' } });
  const bgInter = gdev.createBindGroup({ layout: bgl, entries: POS_NAMES.map((n, b) => ({ binding: b, resource: { buffer: shared[n].gbuf } })) });
  // 對照：讀回後的頂點緩衝區（x y z 交錯，vec3）
  const vb = gdev.createBuffer({ size: N * 12, usage: 0x20 | 0x8 });
  const pipeVB = gdev.createRenderPipeline({ layout: 'auto', vertex: { module: gdev.createShaderModule({ code: `
@vertex fn vs(@location(0) p: vec3<f32>) -> @builtin(position) vec4<f32> { return vec4<f32>(p.x * ${SCALE}f - 1.0, p.y * ${SCALE}f - 1.0, 0.0, 1.0); }
@fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0, 1.0, 1.0, 1.0); }` }), entryPoint: 'vs', buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }] }] }, fragment: { module: gdev.createShaderModule({ code: '@vertex fn v2() -> @builtin(position) vec4<f32> { return vec4<f32>(0.0); } @fragment fn fs() -> @location(0) vec4<f32> { return vec4<f32>(1.0); }' }), entryPoint: 'fs', targets: [{ format: fmt }] }, primitive: { topology: 'point-list' } });
  const draw = (pipeline, bind, vbuf) => {
    const enc = gdev.createCommandEncoder();
    const pass = enc.beginRenderPass({ colorAttachments: [{ view: ctx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }] });
    pass.setPipeline(pipeline);
    if (bind) pass.setBindGroup(0, bind); else pass.setVertexBuffer(0, vbuf);
    pass.draw(N); pass.end(); gdev.queue.submit([enc.finish()]);
  };
  // 路線 A 的橋：2D 畫布（GUI 的 2D 層）；bridge＝true 時在同一個 task 內把 WebGPU 畫布畫進 2D 畫布（drawImage，不讀回 CPU）
  const c2 = document.createElement('canvas'); c2.width = 512; c2.height = 512; const g2 = c2.getContext('2d', { willReadFrequently: true });
  const interFrame = async (bridge) => { stepDev(dev, shared); dev.flush(); draw(pipe, bgInter, null); if (bridge) g2.drawImage(cv, 0, 0); await gdev.queue.onSubmittedWorkDone(); };
  // ImageBitmap 版：transferToImageBitmap 取出畫布內容（同一個 task），再 drawImage 到 2D 畫布
  const bitmapFrame = async () => { stepDev(dev, shared); dev.flush(); draw(pipe, bgInter, null); const bm = cv.transferToImageBitmap(); g2.drawImage(bm, 0, 0); bm.close(); await gdev.queue.onSubmittedWorkDone(); };
  const readFrame = async (bridge) => {
    stepDev(dev, shared); dev.flush();
    const xs = await dev.download(shared.x), ys = await dev.download(shared.y), zs = await dev.download(shared.z);
    const inter = new Float32Array(N * 3); for (let i = 0; i < N; i++) { inter[i * 3] = xs[i]; inter[i * 3 + 1] = ys[i]; inter[i * 3 + 2] = zs[i]; }
    gdev.queue.writeBuffer(vb, 0, inter);
    draw(pipeVB, null, vb); if (bridge) g2.drawImage(cv, 0, 0); await gdev.queue.onSubmittedWorkDone();
  };
  const stepOnly = async () => { stepDev(dev, shared); dev.flush(); await gdev.queue.onSubmittedWorkDone(); };
  const time = async (f) => { for (let i = 0; i < WARM; i++) await f(); const t0 = performance.now(); for (let i = 0; i < FRAMES; i++) await f(); return +((performance.now() - t0) / FRAMES).toFixed(2); };
  out.step_only_ms = await time(stepOnly);
  out.interop_frame_ms = await time(() => interFrame(false));
  out.readback_frame_ms = await time(() => readFrame(false));
  out.interop_bridge2d_frame_ms = await time(() => interFrame(true));
  out.readback_bridge2d_frame_ms = await time(() => readFrame(true));
  try { out.interop_bitmap_frame_ms = await time(bitmapFrame); } catch (e) { out.interop_bitmap_error = String((e && e.message) || e).slice(0, 200); }
  // 像素比對（WebGPU）：路線 A 的橋畫出來的像素 vs 讀回後上傳 VBO 的畫法，同一組位置
  await interFrame(true); const pa = g2.getImageData(0, 0, 512, 512).data.slice();
  await readFrame(true); const pb = g2.getImageData(0, 0, 512, 512).data.slice();
  let pd = 0, pl = 0; for (let i = 0; i < pa.length; i++) { pd = Math.max(pd, Math.abs(pa[i] - pb[i])); if (i % 4 === 0 && pb[i] > 128) pl++; }
  out.pixel_max_diff = pd; out.white_pixels = pl;
  out.lost = lost;
  out.uncaptured = dev.stats.errors.slice(0, 3);
  return out;
}

// ---- 路線 B：WebGL2（同一個 context 上做 KIR 與繪圖）
async function runWebgl2() {
  const out = {};
  const cv = document.createElement('canvas'); cv.width = 512; cv.height = 512;
  const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true, antialias: false });
  if (!gl || !GLD.supportsWebGL2(gl)) return { error: 'WebGL2 或 EXT_color_buffer_float 不可用' };
  const dev = GLD.createDevice(gl);
  const shared = {};
  for (const k of KERN) for (const p of bufParams(k)) if (!shared[p.name]) shared[p.name] = dev.alloc(N, elemOf(p));
  for (const n of Object.keys(shared)) if (POS[n]) dev.upload(shared[n], POS[n]);
  // 紋理版畫法：頂點著色器 texelFetch 讀 x、y、z 的紋理（與 KIR 的紋理同一 context）
  const vsTex = `#version 300 es
uniform highp sampler2D tx; uniform highp sampler2D ty; uniform highp sampler2D tz; uniform int uW; uniform float uS;
void main() { int i = gl_VertexID; ivec2 t = ivec2(i % uW, i / uW);
  float x = texelFetch(tx, t, 0).r, y = texelFetch(ty, t, 0).r, z = texelFetch(tz, t, 0).r;
  gl_Position = vec4(x * uS - 1.0, y * uS - 1.0, 0.0, 1.0); gl_PointSize = 1.0; }`;
  const vsAttr = `#version 300 es
in vec3 p; uniform float uS;
void main() { gl_Position = vec4(p.x * uS - 1.0, p.y * uS - 1.0, 0.0, 1.0); gl_PointSize = 1.0; }`;
  const fsSrc = `#version 300 es
precision highp float; out vec4 c; void main() { c = vec4(1.0); }`;
  const mk = (vs, fs) => { const p = gl.createProgram(); for (const [t, s] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]]) { const sh = gl.createShader(t); gl.shaderSource(sh, s); gl.compileShader(sh); if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh)); gl.attachShader(p, sh); } gl.linkProgram(p); if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p)); return p; };
  const pTex = mk(vsTex, fsSrc), pAttr = mk(vsAttr, fsSrc);
  const vao = gl.createVertexArray(); gl.bindVertexArray(vao);
  const vbo = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.enableVertexAttribArray(gl.getAttribLocation(pAttr, 'p')); gl.vertexAttribPointer(gl.getAttribLocation(pAttr, 'p'), 3, gl.FLOAT, false, 0, 0);
  const W = shared.x.uW;
  // 同步點：gl.finish() 在這台回得太快（1.7 ms，與 kir_webgpu 量到的約 54 ms 不合），改用 1×1 readPixels（會等前面所有指令完成）
  const syncPx = new Uint8Array(4);
  const glSync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPx);
  const drawTex = () => {
    gl.useProgram(pTex); gl.bindVertexArray(null);
    [['tx', shared.x], ['ty', shared.y], ['tz', shared.z]].forEach(([n, b], u) => { gl.activeTexture(gl.TEXTURE0 + u); gl.bindTexture(gl.TEXTURE_2D, b.tex); gl.uniform1i(gl.getUniformLocation(pTex, n), u); });
    gl.uniform1i(gl.getUniformLocation(pTex, 'uW'), W); gl.uniform1f(gl.getUniformLocation(pTex, 'uS'), SCALE);
    gl.viewport(0, 0, 512, 512); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, N);
  };
  const drawAttr = (interleaved) => {
    gl.useProgram(pAttr); gl.bindVertexArray(vao); gl.bindBuffer(gl.ARRAY_BUFFER, vbo); gl.bufferData(gl.ARRAY_BUFFER, interleaved, gl.DYNAMIC_DRAW);
    gl.uniform1f(gl.getUniformLocation(pAttr, 'uS'), SCALE);
    gl.viewport(0, 0, 512, 512); gl.clearColor(0, 0, 0, 1); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.POINTS, 0, N);
  };
  const interFrame = () => { for (const k of KERN) { const binds = {}; let on = null; for (const p of bufParams(k)) { binds[p.name] = shared[p.name]; if (p.access === 'out') on = p.name; } const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name); dev.dispatch(k, binds, binds[on], S, N); } drawTex(); glSync(); };
  const readFrame = () => { for (const k of KERN) { const binds = {}; let on = null; for (const p of bufParams(k)) { binds[p.name] = shared[p.name]; if (p.access === 'out') on = p.name; } const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name); dev.dispatch(k, binds, binds[on], S, N); } const xs = dev.download(shared.x), ys = dev.download(shared.y), zs = dev.download(shared.z); const inter = new Float32Array(N * 3); for (let i = 0; i < N; i++) { inter[i * 3] = xs[i]; inter[i * 3 + 1] = ys[i]; inter[i * 3 + 2] = zs[i]; } drawAttr(inter); glSync(); };
  const stepOnly = () => { for (const k of KERN) { const binds = {}; let on = null; for (const p of bufParams(k)) { binds[p.name] = shared[p.name]; if (p.access === 'out') on = p.name; } const S = {}; for (const p of scalParams(k)) S[p.name] = scalarVal(p.name); dev.dispatch(k, binds, binds[on], S, N); } glSync(); };
  const time = (f) => { for (let i = 0; i < WARM; i++) f(); const t0 = performance.now(); for (let i = 0; i < FRAMES; i++) f(); return +((performance.now() - t0) / FRAMES).toFixed(2); };
  out.step_only_ms = time(stepOnly);
  out.interop_frame_ms = time(interFrame);
  out.readback_frame_ms = time(readFrame);
  // 像素比對：同一組位置，紋理畫法 vs 讀回後上傳的畫法（都用最後一次的位置資料）
  stepOnly(); drawTex(); glSync(); const pa = new Uint8Array(512 * 512 * 4); gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, pa);
  const xs = dev.download(shared.x), ys = dev.download(shared.y), zs = dev.download(shared.z); const inter = new Float32Array(N * 3); for (let i = 0; i < N; i++) { inter[i * 3] = xs[i]; inter[i * 3 + 1] = ys[i]; inter[i * 3 + 2] = zs[i]; }
  drawAttr(inter); glSync(); const pb = new Uint8Array(512 * 512 * 4); gl.readPixels(0, 0, 512, 512, gl.RGBA, gl.UNSIGNED_BYTE, pb);
  let diff = 0, lit = 0; for (let i = 0; i < pa.length; i++) { diff = Math.max(diff, Math.abs(pa[i] - pb[i])); if (pb[i] > 0) lit++; }
  out.pixel_max_diff = diff; out.lit_bytes = lit;
  return out;
}

try { R.webgpu = navigator.gpu ? await runWebgpu() : { error: 'no WebGPU' }; } catch (e) { R.errors.push('webgpu: ' + String((e && e.stack) || e).slice(0, 300)); }
try { R.webgl2 = await runWebgl2(); } catch (e) { R.errors.push('webgl2: ' + String((e && e.stack) || e).slice(0, 300)); }
// context 遺失（真 GPU）：WEBGL_lose_context 強制遺失後，讀回與配置要丟例外（不是回傳 0）
async function runCtxLoss() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
  const gl = cv.getContext('webgl2', { preserveDrawingBuffer: true });
  if (!gl) return { error: 'no WebGL2' };
  const ext = gl.getExtension('WEBGL_lose_context');
  if (!ext) return { error: 'no WEBGL_lose_context' };
  const dev = GLD.createDevice(gl);
  const a = dev.alloc(64, 'f32'); dev.upload(a, new Float32Array(64).fill(3));
  ext.loseContext();
  const r = { isContextLost: gl.isContextLost() };
  try { dev.download(a); r.download_after_loss = 'NO THROW'; } catch (e) { r.download_after_loss = String(e.message); }
  try { dev.alloc(64, 'f32'); r.alloc_after_loss = 'NO THROW'; } catch (e) { r.alloc_after_loss = String(e.message); }
  return r;
}
try { R.ctxLoss = await runCtxLoss(); } catch (e) { R.errors.push('ctxLoss: ' + String((e && e.stack) || e).slice(0, 300)); }
R.env = { points: N, frames: FRAMES, adapter: navigator.gpu ? 'present' : 'none' };
console.log('KIR_INTEROP ' + JSON.stringify(R));
return R;
