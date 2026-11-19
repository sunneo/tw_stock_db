// node renderer/src/gpu/kir_test.js — KIR（通用逐元素核心）＋OpenCL C 子集解析器＋JS 後端（DESIGN.webgpu-cuda.md §13）。
// 每個核心都與手寫的 JS 參考實作比對（容差 gpu_core.tolerance）；超出子集的寫法要明確被拒絕。
const K = require('./kir.js'), F = require('./cl_front.js');
const { tolerance } = require('./gpu_core.js');
let ok = 0; const bad = [];
const check = (name, c, info) => { if (c) ok++; else bad.push(name + (info !== undefined ? ' ' + JSON.stringify(info).slice(0, 240) : '')); };
const parse1 = (src) => { const r = F.parseKernels(src); if (!r.ok) return { err: r.error }; if (r.kernels.length !== 1) return { err: 'kernels=' + r.kernels.length }; return { kernel: r.kernels[0] }; };
const maxErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };

// 固定種子的亂數（可重現）
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);

// ---- 1. vecadd（與 examples/llc/gpgpu/opencl_vecadd.ll 的核心字串相同）
{
  const p = parse1('__kernel void vadd(__global const float* a, __global const float* b, __global float* c, int n) { int i = get_global_id(0); if (i < n) c[i] = a[i] + b[i]; }');
  check('vecadd 解析', !!p.kernel, p.err);
  if (p.kernel) {
    const N = 1000, a = new Float32Array(N).map((_, i) => i), b = new Float32Array(N).map((_, i) => 2 * i), c = new Float32Array(N);
    const v = K.validate(p.kernel); check('vecadd 通過驗證', v.ok, v.errors);
    K.runJs(p.kernel, { a, b, c }, { n: N }, N);
    check('vecadd 結果 c[999]＝2997', c[999] === 2997 && c[0] === 0 && c[500] === 1500, [c[0], c[500], c[999]]);
  }
}

// ---- 2. N 體加速度（OpenCL 版：位置＋質量在 float4 的 xyz、w；每個 work-item 掃全部）
const NBODY_CL = `
__kernel void accel(__global const float4* p, __global float4* a, int n, float eps) {
  int i = get_global_id(0);
  float4 pi = p[i];
  float ax = 0.0f; float ay = 0.0f; float az = 0.0f;
  for (int j = 0; j < n; j++) {
    float4 pj = p[j];
    float dx = pj.x - pi.x;
    float dy = pj.y - pi.y;
    float dz = pj.z - pi.z;
    float r2 = dx * dx + dy * dy + dz * dz + eps;
    float inv = rsqrt(r2);
    float inv3 = inv * inv * inv;
    float s = pj.w * inv3;
    ax += dx * s; ay += dy * s; az += dz * s;
  }
  a[i] = (float4)(ax, ay, az, 0.0f);
}`;
function nbodyRef(P, N, eps) {
  const out = new Float32Array(4 * N);
  for (let i = 0; i < N; i++) {
    const xi = P[4 * i], yi = P[4 * i + 1], zi = P[4 * i + 2]; let ax = 0, ay = 0, az = 0;
    for (let j = 0; j < N; j++) {
      const dx = P[4 * j] - xi, dy = P[4 * j + 1] - yi, dz = P[4 * j + 2] - zi;
      const r2 = dx * dx + dy * dy + dz * dz + eps, inv = 1 / Math.sqrt(r2), inv3 = inv * inv * inv, s = P[4 * j + 3] * inv3;
      ax += dx * s; ay += dy * s; az += dz * s;
    }
    out[4 * i] = ax; out[4 * i + 1] = ay; out[4 * i + 2] = az;
  }
  return out;
}
{
  const p = parse1(NBODY_CL); check('N 體（OpenCL）解析', !!p.kernel, p.err);
  if (p.kernel) {
    const N = 64, P = new Float32Array(4 * N); for (let i = 0; i < N; i++) { P[4 * i] = rnd() * 10; P[4 * i + 1] = rnd() * 10; P[4 * i + 2] = rnd() * 10; P[4 * i + 3] = 0.5 + rnd(); }
    const A = new Float32Array(4 * N), eps = 0.01;
    const v = K.validate(p.kernel); check('N 體通過驗證', v.ok, v.errors);
    K.runJs(p.kernel, { p: P, a: A }, { n: N, eps }, N);
    const R = nbodyRef(P, N, Math.fround(eps));
    const err = maxErr(A, R), tol = tolerance(N) * 100;   // 加速度的量級約 1，允許 N 項累加的誤差
    check(`N 體加速度 JS 對照（最大誤差 ${err.toExponential(2)} ≤ ${tol.toExponential(2)}）`, err <= tol, { err, tol });
  }
}

// ---- 3. SPH 密度（poly6 核，全掃描；fluid3d 的鄰域先用全掃描）
const SPH_CL = `
__kernel void density(__global const float4* p, __global float* rho, int n, float h2, float m) {
  int i = get_global_id(0);
  float4 pi = p[i];
  float s = 0.0f;
  for (int j = 0; j < n; j++) {
    float4 pj = p[j];
    float dx = pj.x - pi.x;
    float dy = pj.y - pi.y;
    float dz = pj.z - pi.z;
    float r2 = dx * dx + dy * dy + dz * dz;
    float d = h2 - r2;
    float w = d * d * d;
    s += (r2 < h2) ? w : 0.0f;
  }
  rho[i] = s * m;
}`;
function sphRef(P, N, h2, m) {
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = 0; j < N; j++) {
      const dx = P[4 * j] - P[4 * i], dy = P[4 * j + 1] - P[4 * i + 1], dz = P[4 * j + 2] - P[4 * i + 2];
      const r2 = dx * dx + dy * dy + dz * dz, d = h2 - r2, w = d * d * d;
      if (r2 < h2) s += w;
    }
    out[i] = s * m;
  }
  return out;
}
{
  const p = parse1(SPH_CL); check('SPH 密度（OpenCL）解析', !!p.kernel, p.err);
  if (p.kernel) {
    const N = 80, P = new Float32Array(4 * N); for (let i = 0; i < N; i++) { P[4 * i] = rnd(); P[4 * i + 1] = rnd(); P[4 * i + 2] = rnd(); P[4 * i + 3] = 1; }
    const RHO = new Float32Array(N), h2 = 0.09, m = 0.02;
    const v = K.validate(p.kernel); check('SPH 通過驗證', v.ok, v.errors);
    K.runJs(p.kernel, { p: P, rho: RHO }, { n: N, h2, m }, N);
    const R = sphRef(P, N, Math.fround(h2), Math.fround(m));
    const err = maxErr(RHO, R), scale = Math.max(...R), tol = tolerance(N) * Math.max(1, scale);
    check(`SPH 密度 JS 對照（最大誤差 ${err.toExponential(2)} ≤ ${tol.toExponential(2)}）`, err <= tol, { err, tol });
    check('SPH 密度有非零的值（測試有效）', scale > 0, scale);
  }
}

// ---- 4. 被拒絕的寫法（要明確報錯，不能靜默算錯）
const rejects = [
  ['__local', '__kernel void f(__global float* a) { __local float t[4]; a[0] = 1.0f; }', /__local|不支援|未宣告/],
  ['barrier', '__kernel void f(__global float* a) { barrier(1); }', /不支援|未宣告/],
  ['while', '__kernel void f(__global float* a, int n) { int i = 0; while (i < n) { i++; } }', /不支援/],
  ['else', '__kernel void f(__global const float* a, __global float* c, int n) { int i = get_global_id(0); if (i < n) c[i] = a[i]; else c[i] = 0.0f; }', /else/],
  ['輔助函式', 'float h(float x) { return x; }\n__kernel void f(__global float* a) { a[0] = 1.0f; }', /只支援 __kernel|不支援/],
  ['寫入 const 緩衝區', '__kernel void f(__global const float* a) { a[0] = 1.0f; }', /只讀|const/],
  ['讀取只寫緩衝區', '__kernel void f(__global float* a, __global float* c) { c[0] = a[0]; }', /只寫|不能讀/],
  ['float 隱式轉 int', '__kernel void f(__global float* a, int n) { int k = 1.5f; a[0] = 1.0f; }', /隱式|型別/],
  ['未宣告的變數', '__kernel void f(__global float* a) { a[0] = zz; }', /未宣告/],
  ['f32x4 不給分量', '__kernel void f(__global const float4* p, __global float* a) { a[0] = p[0]; }', /分量|float4/],
];
for (const [why, src, re] of rejects) {
  const p = F.parseKernels(src);
  const msg = p.ok ? (K.validate(p.kernels[0]).errors.join(';') || '') : p.error;
  check('拒絕：' + why, (!p.ok || !K.validate(p.kernels[0]).ok) && re.test(msg), msg);
}

// ---- 5. KIR 驗證：直接構造的錯誤核心
{
  const bad1 = { name: 'x', params: [{ kind: 'buf', name: 'a', elem: 'f32', access: 'in' }], body: [{ k: 'store', buf: 'a', idx: { k: 'gid', t: 'i32' }, e: { k: 'num', v: 1, t: 'f32' } }] };
  const v1 = K.validate(bad1); check('KIR：寫入 in 緩衝區被拒', !v1.ok && /只讀/.test(v1.errors.join()), v1.errors);
  const bad2 = { name: 'x', params: [{ kind: 'buf', name: 'a', elem: 'f32', access: 'out' }], body: [{ k: 'let', name: 'q', t: 'f32', e: { k: 'num', v: 1, t: 'i32' } }] };
  const v2 = K.validate(bad2); check('KIR：let 型別與初值不符被拒', !v2.ok, v2.errors);
}

// ---- 6. 產生器（DESIGN.webgpu-cuda.md §13）：WGSL 只做結構檢查（本機沒有 naga／tint，未在真 GPU 驗證）；GLSL 結構檢查，編譯由真 Electron 的 WebGL2 驗證。
const G = require('./kir_gen.js');
{
  const pv = parse1('__kernel void vadd(__global const float* a, __global const float* b, __global float* c, int n){int i=get_global_id(0); if(i<n) c[i]=a[i]+b[i];}').kernel;
  const w = G.toWgsl(pv);
  check('WGSL：vecadd 產生', w.ok, w.error);
  check('WGSL：結構（workgroup 64、gid 守衛、storage 讀寫權限、uniform 結構）', w.ok && /@compute @workgroup_size\(64\)/.test(w.code) && /if \(gid >= P\._count\) \{ return; \}/.test(w.code) && /var<storage, read_write> c: array<f32>/.test(w.code) && /var<storage, read> a: array<f32>/.test(w.code) && /var<uniform> P: Params/.test(w.code), w.code);
  const g = G.toGlsl(pv);
  check('GLSL：vecadd 產生（render-to-texture 結構）', g.ok, g.error);
  check('GLSL：結構（#version 300 es、gl_FragCoord、守邊界 discard、texelFetch、fragColor）', g.ok && /#version 300 es/.test(g.fs) && /gl_FragCoord/.test(g.fs) && /discard/.test(g.fs) && /texelFetch\(a,/.test(g.fs) && /fragColor = vec4\(/.test(g.fs) && !/uniform highp sampler2D c;/.test(g.fs), g.fs);
  const pn = parse1(NBODY_CL).kernel;
  const wn = G.toWgsl(pn), gn = G.toGlsl(pn);
  check('WGSL：N 體（f32x4 緩衝區）產生', wn.ok && /array<vec4<f32>>/.test(wn.code) && /\.w\b/.test(wn.code), wn.error);
  check('GLSL：N 體（f32x4 讀分量）產生', gn.ok && /\.w;/.test(gn.fs) && gn.samplers.length === 1, gn.error);
  const multi = parse1('__kernel void f(__global const float* a, __global float* c, __global float* d, int n){int i=get_global_id(0); c[i]=a[i]; d[i]=a[i];}').kernel;
  const gm = G.toGlsl(multi);
  check('GLSL：多個輸出緩衝區明確拒絕（需要 MRT）', !gm.ok && /只支援恰好一個輸出/.test(gm.error), gm.error);
  const wm = G.toWgsl(multi);
  check('WGSL：多個輸出緩衝區可以產生（storage buffer 不受限）', wm.ok, wm.error);
}

console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'kir: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
