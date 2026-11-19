// KIR → GLSL → WebGL2 真實執行（DESIGN.webgpu-cuda.md §13 階段 4）。
// 不要直接用：先跑 node scripts/eval/kir_webgl2.build.js <輸出檔>，產生的檔案內含三個 KIR 模組與 OpenCL 原始碼（__SRC__ 已代換）。
// 用法（真 Electron）：FA_DEBUG_EVAL_FILE=<輸出檔> xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=<空目錄>
// 回傳 R：每個核心的 WebGL2 結果與 JS 後端（runJs）的最大誤差，以及容差與耗時。
const SRC = __SRC__;
const load = (src) => new Function('module', 'require', 'self', src)(undefined, undefined, window);
load(SRC.kir); load(SRC.gen); load(SRC.webgl); load(SRC.front);
const K = window.FaKir, GEN = window.FaKirGen, W = window.FaKirWebGL2, FR = window.FaClFront;
const R = { hasGen: !!GEN, hasWebGL: !!W, hasFront: !!FR };
const cv = document.createElement('canvas'); cv.width = 64; cv.height = 64;
const gl = cv.getContext('webgl2');
R.webgl2 = !!gl;
R.supports = !!gl && W.supportsWebGL2(gl);
const EPS32 = Math.pow(2, -23), tolerance = (k) => 8 * Math.sqrt(Math.max(1, k)) * EPS32;
const maxErr = (a, b) => { let m = 0; for (let i = 0; i < a.length; i++) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
let seed = 12345; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
const parse1 = (src) => FR.parseKernels(src).kernels[0];
const kernels = {};
const timeIt = (f) => { const t0 = performance.now(); const v = f(); return [v, performance.now() - t0]; };

if (R.supports) {
  // 1. vecadd（與 opencl_vecadd.ll 相同的核心）
  {
    const k = parse1('__kernel void vadd(__global const float* a, __global const float* b, __global float* c, int n) { int i = get_global_id(0); if (i < n) c[i] = a[i] + b[i]; }');
    const N = 1000, a = new Float32Array(N).map((_, i) => i), b = new Float32Array(N).map((_, i) => 2 * i);
    const ref = K.runJs(k, { a, b, c: new Float32Array(N) }, { n: N }, N).c;
    const [g] = timeIt(() => W.runGl(gl, k, { a, b }, { n: N }, N));
    R.vecadd = { N, err: maxErr(g.out.c, ref), uW: g.uW, rows: g.rows, backend: g.backend, c999: g.out.c[999] };
  }
  // 2. N 體加速度（float4 位置＋質量；float4 輸出）
  {
    const k = parse1(SRC.nbody);
    const N = 256, P = new Float32Array(4 * N); for (let i = 0; i < N; i++) { P[4 * i] = rnd() * 10; P[4 * i + 1] = rnd() * 10; P[4 * i + 2] = rnd() * 10; P[4 * i + 3] = 0.5 + rnd(); }
    const eps = 0.01;
    const ref = K.runJs(k, { p: P, a: new Float32Array(4 * N) }, { n: N, eps }, N).a;
    const [g, ms] = timeIt(() => W.runGl(gl, k, { p: P }, { n: N, eps }, N));
    const tol = tolerance(N) * 100;
    R.nbody = { N, err: maxErr(g.out.a, ref), tol, ms: Math.round(ms), uW: g.uW, rows: g.rows };
  }
  // 3. SPH 密度（poly6，全掃描）
  {
    const k = parse1(SRC.sph);
    const N = 512, P = new Float32Array(4 * N); for (let i = 0; i < N; i++) { P[4 * i] = rnd(); P[4 * i + 1] = rnd(); P[4 * i + 2] = rnd(); P[4 * i + 3] = 1; }
    const h2 = 0.09, m = 0.02;
    const ref = K.runJs(k, { p: P, rho: new Float32Array(N) }, { n: N, h2, m }, N).rho;
    const [g, ms] = timeIt(() => W.runGl(gl, k, { p: P }, { n: N, h2, m }, N));
    const scale = Math.max(...ref, 1), tol = tolerance(N) * scale;
    R.sph = { N, err: maxErr(g.out.rho, ref), tol, ms: Math.round(ms), uW: g.uW, rows: g.rows };
  }
}
R.ok = R.supports && R.vecadd.err === 0 && R.nbody.err <= R.nbody.tol && R.sph.err <= R.sph.tol;
console.log('KIR_WEBGL2_RESULT ' + JSON.stringify(R));
return R;
