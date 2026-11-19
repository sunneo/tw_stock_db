/* KIR／OpenCL 一致性套件的案例（與後端無關）。
 * 每個案例是 OpenCL C 核心（cl_front 子集）＋ 緩衝區規格 ＋ 派送階段 ＋ 參考解（double，用 Math.fround 只在需要時）。
 * 同一份案例給兩處用：node 測試（kir_conformance_test.js，KIR 的 JS 後端當參考）與真 Electron 評測（scripts/eval/kir_conformance.eval.js，
 * 比 WebGPU 分塊、WebGPU 未分塊、WebGL2 與 JS 參考）。
 * 容差：與 gpu_core.tolerance(k) 相同形式 8·√k·EPS32（EPS32＝2^-23）；每個元素的誤差除以該元素的量級（scale）後與容差比較。
 * 標 exact 的案例要求誤差恰為 0（單一 IEEE 加／乘／比較，WebGPU 與 JS 都應逐位元相同）。
 * 這個模組不依賴任何後端；只用到 cl_front 的解析結果由呼叫端提供。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.KIR_CONFORMANCE = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const EPS32 = Math.pow(2, -23);
    const tolK = (k) => 8 * Math.sqrt(Math.max(1, k));        // 倍數（乘上 EPS32）；與 gpu_core.tolerance 同形式
    const f32 = Math.fround;

    // 可重現的亂數（線性同餘）
    function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
    const fill = (r, n, lo, hi) => { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = f32(lo + (hi - lo) * r()); return a; };

    // ---- OpenCL C 原始碼（全部放在一個字串，cl_front 會解析出所有核心）
    const SRC = `
__kernel void k_vecadd(__global const float* a, __global const float* b, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = a[i] + b[i]; }
}
__kernel void k_saxpy(__global const float* x, __global const float* y, __global float* o, float s, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = s * x[i] + y[i]; }
}
__kernel void k_sqrt(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = sqrt(x[i]); }
}
__kernel void k_rsqrt(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = rsqrt(x[i]); }
}
__kernel void k_sin(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = sin(x[i]); }
}
__kernel void k_cos(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = cos(x[i]); }
}
__kernel void k_exp(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = exp(x[i]); }
}
__kernel void k_pow(__global const float* x, __global const float* y, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = pow(x[i], y[i]); }
}
__kernel void k_floor(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = floor(x[i]); }
}
__kernel void k_select(__global const float* x, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { float v = x[i]; o[i] = v > 0.5f ? v : -v; }
}
__kernel void k_min(__global const float* a, __global const float* b, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = min(a[i], b[i]); }
}
__kernel void k_max(__global const float* a, __global const float* b, __global float* o, int n) {
  int i = get_global_id(0);
  if (i < n) { o[i] = max(a[i], b[i]); }
}
__kernel void k_rowsum(__global const float* a, __global float* o, int n, int k) {
  int i = get_global_id(0);
  if (i < n) {
    float s = 0.0f;
    for (int j = 0; j < k; j++) { s += a[i * k + j]; }
    o[i] = s;
  }
}
__kernel void k_part(__global const float* a, __global float* p, int n, int ch, int m) {
  int g = get_global_id(0);
  if (g < m) {
    float s = 0.0f;
    int base = g * ch;
    for (int j = 0; j < ch; j++) {
      if (base + j < n) { s += a[base + j]; }
    }
    p[g] = s;
  }
}
__kernel void k_final(__global const float* p, __global float* o, int m) {
  int i = get_global_id(0);
  if (i < 1) {
    float s = 0.0f;
    for (int j = 0; j < m; j++) { s += p[j]; }
    o[0] = s;
  }
}
__kernel void k_grav(__global const float* x, __global const float* y, __global const float* z, __global const float* m, __global float* ax, __global float* ay, __global float* az, int n, float eps) {
  int i = get_global_id(0);
  if (i < n) {
    float xi = x[i]; float yi = y[i]; float zi = z[i];
    float fx = 0.0f; float fy = 0.0f; float fz = 0.0f;
    for (int j = 0; j < n; j++) {
      float dx = x[j] - xi; float dy = y[j] - yi; float dz = z[j] - zi;
      float r2 = dx * dx + dy * dy + dz * dz + eps;
      float inv = rsqrt(r2);
      float s = m[j] * inv * inv * inv;
      fx += dx * s; fy += dy * s; fz += dz * s;
    }
    ax[i] = fx; ay[i] = fy; az[i] = fz;
  }
}
__kernel void k_kdk(__global const float* x, __global const float* v, __global float* x2, __global float* v2, float dt, int n) {
  int i = get_global_id(0);
  if (i < n) {
    float vh = v[i] - 0.5f * dt * x[i];
    float xn = x[i] + dt * vh;
    x2[i] = xn;
    v2[i] = vh - 0.5f * dt * xn;
  }
}
__kernel void k_grav4(__global const float4* p, __global const float* m, __global float4* acc, int n, float eps) {
  int i = get_global_id(0);
  if (i < n) {
    float4 pi = p[i];
    float fx = 0.0f; float fy = 0.0f; float fz = 0.0f;
    for (int j = 0; j < n; j++) {
      float4 pj = p[j];
      float dx = pj.x - pi.x; float dy = pj.y - pi.y; float dz = pj.z - pi.z;
      float r2 = dx * dx + dy * dy + dz * dz + eps;
      float inv = rsqrt(r2);
      float s = m[j] * inv * inv * inv;
      fx += dx * s; fy += dy * s; fz += dz * s;
    }
    acc[i] = (float4)(fx, fy, fz, 0.0f);
  }
}
__kernel void k_kick4(__global const float4* v, __global const float4* acc, __global float4* vo, float h, int n) {
  int i = get_global_id(0);
  if (i < n) {
    vo[i] = (float4)(v[i].x + h * acc[i].x, v[i].y + h * acc[i].y, v[i].z + h * acc[i].z, 0.0f);
  }
}
__kernel void k_drift4(__global const float4* p, __global const float4* v, __global float4* po, float dt, int n) {
  int i = get_global_id(0);
  if (i < n) {
    po[i] = (float4)(p[i].x + dt * v[i].x, p[i].y + dt * v[i].y, p[i].z + dt * v[i].z, 0.0f);
  }
}
__kernel void k_vec4(__global const float4* a, __global float4* o, int n) {
  int i = get_global_id(0);
  if (i < n) {
    o[i] = (float4)(a[i].x + a[i].w, a[i].y * 2.0f, a[i].z - 1.0f, a[i].w);
  }
}
__kernel void k_twoout(__global const float* a, __global const float* b, __global float* s, __global float* d, int n) {
  int i = get_global_id(0);
  if (i < n) { s[i] = a[i] + b[i]; d[i] = a[i] - b[i]; }
}
`;

    // ---- 案例工廠。每個案例：{ id, group, desc, exact?, k（容差倍數的 k）, buffers(N), stages(N), outs(N), ref(N, data) → {名字: Float64Array}, scale(N, data, ref) → {名字: Float64Array（每元素量級）} }
    const CASES = [];
    const add = (c) => { CASES.push(c); return c; };

    // 單一輸入→輸出的逐元素案例
    function unary(id, desc, kern, gen, refFn, opts) {
        const o = opts || {};
        return add({
            id, group: o.group || 'elem', desc, exact: !!o.exact, k: o.k || 1, sizes: o.sizes || [1, 63, 64, 65, 255, 256, 257, 1000],
            make(N) {
                const r = rng(0x1234 + id.length * 97 + N);
                const x = gen(r, N);
                return {
                    buffers: { x: { elem: 'f32', n: N, data: x }, o: { elem: 'f32', n: N } },
                    stages: [{ k: kern, bind: { x: 'x', o: 'o' }, scalars: { n: N }, N }],
                    outs: ['o'],
                    ref: () => ({ o: Float64Array.from(x, (v) => refFn(v)) }),
                    scale: () => ({ o: Float64Array.from(x, (v) => Math.max(1, Math.abs(refFn(v)))) })
                };
            }
        });
    }
    const uni = (lo, hi) => (r, n) => fill(r, n, lo, hi);

    // (1) 逐元素
    add({
        id: 'vecadd', group: 'elem', desc: 'o = a + b（單一加法，應逐位元相同）', exact: true, k: 0, sizes: [1, 63, 64, 65, 255, 256, 257, 1000],
        make(N) {
            const r = rng(7 + N);
            const a = fill(r, N, -100, 100), b = fill(r, N, -100, 100);
            return {
                buffers: { a: { elem: 'f32', n: N, data: a }, b: { elem: 'f32', n: N, data: b }, o: { elem: 'f32', n: N } },
                stages: [{ k: 'k_vecadd', bind: { a: 'a', b: 'b', o: 'o' }, scalars: { n: N }, N }],
                outs: ['o'],
                ref: () => ({ o: Float64Array.from(a, (v, i) => f32(v + b[i])) }),
                scale: () => ({ o: new Float64Array(N).fill(1) })
            };
        }
    });
    add({
        id: 'saxpy', group: 'elem', desc: 'o = s·x + y（s 為純量；應逐位元相同：WGSL 不做 FMA 融合）', exact: true, k: 0, sizes: [1, 63, 64, 65, 255, 256, 257, 1000],
        make(N) {
            const r = rng(11 + N), s = f32(1.75);
            const x = fill(r, N, -50, 50), y = fill(r, N, -50, 50);
            return {
                buffers: { x: { elem: 'f32', n: N, data: x }, y: { elem: 'f32', n: N, data: y }, o: { elem: 'f32', n: N } },
                stages: [{ k: 'k_saxpy', bind: { x: 'x', y: 'y', o: 'o' }, scalars: { s, n: N }, N }],
                outs: ['o'],
                ref: () => ({ o: Float64Array.from(x, (v, i) => f32(f32(s * v) + y[i])) }),
                scale: () => ({ o: new Float64Array(N).fill(1) })
            };
        }
    });
    unary('sqrt', 'o = √x（x ∈ [0, 100]）', 'k_sqrt', uni(0, 100), (v) => Math.sqrt(v));
    unary('rsqrt', 'o = 1/√x（x ∈ [0.01, 100]）', 'k_rsqrt', uni(0.01, 100), (v) => 1 / Math.sqrt(v));
    unary('sin', 'o = sin x（x ∈ [-10, 10]）', 'k_sin', uni(-10, 10), (v) => Math.sin(v));
    unary('cos', 'o = cos x（x ∈ [-10, 10]）', 'k_cos', uni(-10, 10), (v) => Math.cos(v));
    unary('exp', 'o = eˣ（x ∈ [-5, 5]）', 'k_exp', uni(-5, 5), (v) => Math.exp(v));
    unary('floor', 'o = ⌊x⌋（x ∈ [-50, 50]，應逐位元相同）', 'k_floor', uni(-50, 50), (v) => Math.floor(v), { exact: true, k: 0 });
    unary('select', 'o = x > 0.5 ? x : −x（三元運算子，應逐位元相同）', 'k_select', uni(-1, 1), (v) => (v > 0.5 ? v : -v), { exact: true, k: 0 });
    add({
        id: 'pow', group: 'elem', desc: 'o = pow(x, y)（x ∈ [0.1, 10]，y ∈ [-2, 3]）', k: 1, sizes: [1, 63, 64, 65, 255, 256, 257, 1000],
        make(N) {
            const r = rng(31 + N);
            const x = fill(r, N, 0.1, 10), y = fill(r, N, -2, 3);
            return {
                buffers: { x: { elem: 'f32', n: N, data: x }, y: { elem: 'f32', n: N, data: y }, o: { elem: 'f32', n: N } },
                stages: [{ k: 'k_pow', bind: { x: 'x', y: 'y', o: 'o' }, scalars: { n: N }, N }],
                outs: ['o'],
                ref: () => ({ o: Float64Array.from(x, (v, i) => Math.pow(v, y[i])) }),
                // 量級取 |y·ln x| 的上界：pow＝exp(y·ln x)，相對誤差約隨 |y·ln x| 放大
                scale: () => ({ o: Float64Array.from(x, (v, i) => Math.max(1, Math.abs(Math.pow(v, y[i])), Math.abs(y[i] * Math.log(v)))) })
            };
        }
    });
    add({
        id: 'min', group: 'elem', desc: 'o = min(a, b)', exact: true, k: 0, sizes: [1, 63, 64, 65, 255, 256, 257, 1000],
        make(N) {
            const r = rng(41 + N); const a = fill(r, N, -10, 10), b = fill(r, N, -10, 10);
            return {
                buffers: { a: { elem: 'f32', n: N, data: a }, b: { elem: 'f32', n: N, data: b }, o: { elem: 'f32', n: N } },
                stages: [{ k: 'k_min', bind: { a: 'a', b: 'b', o: 'o' }, scalars: { n: N }, N }], outs: ['o'],
                ref: () => ({ o: Float64Array.from(a, (v, i) => Math.min(v, b[i])) }), scale: () => ({ o: new Float64Array(N).fill(1) })
            };
        }
    });
    add({
        id: 'max', group: 'elem', desc: 'o = max(a, b)', exact: true, k: 0, sizes: [1, 63, 64, 65, 255, 256, 257, 1000],
        make(N) {
            const r = rng(53 + N); const a = fill(r, N, -10, 10), b = fill(r, N, -10, 10);
            return {
                buffers: { a: { elem: 'f32', n: N, data: a }, b: { elem: 'f32', n: N, data: b }, o: { elem: 'f32', n: N } },
                stages: [{ k: 'k_max', bind: { a: 'a', b: 'b', o: 'o' }, scalars: { n: N }, N }], outs: ['o'],
                ref: () => ({ o: Float64Array.from(a, (v, i) => Math.max(v, b[i])) }), scale: () => ({ o: new Float64Array(N).fill(1) })
            };
        }
    });

    // (2) 邊界：vecadd 在各種 N（含非工作群倍數）；N＝0（空輸入）
    for (const N of [1, 63, 64, 65, 255, 256, 257, 1000]) {
        add({
            id: 'bound_vecadd_N' + N, group: 'bound', desc: 'vecadd，N＝' + N + '（應逐位元相同）', exact: true, k: 0, sizes: [N],
            make() { return CASES.find((c) => c.id === 'vecadd').make(N); }
        });
    }
    add({
        id: 'bound_empty', group: 'bound', desc: 'N＝0（空輸入）：不派送、不報錯，輸出長度 0', exact: true, k: 0, sizes: [0], empty: true,
        make() {
            return {
                buffers: { a: { elem: 'f32', n: 0, data: new Float32Array(0) }, b: { elem: 'f32', n: 0, data: new Float32Array(0) }, o: { elem: 'f32', n: 0 } },
                stages: [{ k: 'k_vecadd', bind: { a: 'a', b: 'b', o: 'o' }, scalars: { n: 0 }, N: 0 }], outs: ['o'],
                ref: () => ({ o: new Float64Array(0) }), scale: () => ({ o: new Float64Array(0) })
            };
        }
    });

    // (3) 迴圈與歸約
    for (const n of [1, 64, 1000]) {
        add({
            id: 'loop_rowsum_n' + n, group: 'loop', desc: 'for 迴圈求和：每列 16 個元素，n＝' + n, k: 16, sizes: [n],
            make(N) {
                const K = 16, r = rng(61 + N);
                const a = fill(r, N * K, -1, 1);
                return {
                    buffers: { a: { elem: 'f32', n: N * K, data: a }, o: { elem: 'f32', n: N } },
                    stages: [{ k: 'k_rowsum', bind: { a: 'a', o: 'o' }, scalars: { n: N, k: K }, N }], outs: ['o'],
                    ref: () => ({ o: Float64Array.from({ length: N }, (_, i) => { let s = 0; for (let j = 0; j < K; j++) s += a[i * K + j]; return s; }) }),
                    scale: () => ({ o: Float64Array.from({ length: N }, (_, i) => { let s = 0; for (let j = 0; j < K; j++) s += Math.abs(a[i * K + j]); return Math.max(1, s); }) })
                };
            }
        });
    }
    for (const N of [1, 100, 1000]) {
        add({
            id: 'reduce2_N' + N, group: 'loop', desc: '兩階段歸約（部分和 ch＝32，再加總），N＝' + N, k: N, sizes: [N],
            make(n) {
                const CH = 32, G = Math.ceil(n / CH), r = rng(71 + n);
                const x = fill(r, n, -1, 1);
                return {
                    buffers: { x: { elem: 'f32', n, data: x }, p: { elem: 'f32', n: G }, o: { elem: 'f32', n: 1 } },
                    stages: [
                        { k: 'k_part', bind: { a: 'x', p: 'p' }, scalars: { n, ch: CH, m: G }, N: G },
                        { k: 'k_final', bind: { p: 'p', o: 'o' }, scalars: { m: G }, N: 1 }
                    ],
                    outs: ['o'],
                    ref: () => { let s = 0; for (const v of x) s += v; return { o: Float64Array.of(s) }; },
                    scale: () => { let s = 0; for (const v of x) s += Math.abs(v); return { o: Float64Array.of(Math.max(1, s)) }; }
                };
            }
        });
    }

    // (4) 全對全（分塊與未分塊由評測端切換；這裡給輸入與參考）
    for (const N of [1, 31, 32, 33, 64, 65, 1000]) {
        add({
            id: 'allpairs_N' + N, group: 'tile', desc: '全對全引力核心，N＝' + N + '（分塊版與未分塊版都要對）', k: N, sizes: [N], tiling: true,
            make(n) {
                const r = rng(81 + n), eps = 0.01;
                const x = fill(r, n, -1, 1), y = fill(r, n, -1, 1), z = fill(r, n, -1, 1), m = fill(r, n, 0.5, 1.5);
                const accRef = () => {
                    const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
                    for (let i = 0; i < n; i++) {
                        let fx = 0, fy = 0, fz = 0;
                        for (let j = 0; j < n; j++) {
                            const dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i];
                            const s = m[j] / Math.pow(dx * dx + dy * dy + dz * dz + eps, 1.5);
                            fx += dx * s; fy += dy * s; fz += dz * s;
                        }
                        ax[i] = fx; ay[i] = fy; az[i] = fz;
                    }
                    return { ax, ay, az };
                };
                return {
                    buffers: { x: { elem: 'f32', n, data: x }, y: { elem: 'f32', n, data: y }, z: { elem: 'f32', n, data: z }, m: { elem: 'f32', n, data: m },
                        ax: { elem: 'f32', n }, ay: { elem: 'f32', n }, az: { elem: 'f32', n } },
                    stages: [{ k: 'k_grav', bind: { x: 'x', y: 'y', z: 'z', m: 'm', ax: 'ax', ay: 'ay', az: 'az' }, scalars: { n, eps }, N: n }],
                    outs: ['ax', 'ay', 'az'],
                    ref: accRef,
                    scale: () => {
                        const sc = {}; const abs = (arr) => Float64Array.from(arr, (v) => Math.max(1e-30, Math.abs(v)));
                        // 量級：各元素的 Σ|項|，避免相消讓相對誤差失真
                        const sx = new Float64Array(n), sy = new Float64Array(n), sz = new Float64Array(n);
                        for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
                            const dx = x[j] - x[i], dy = y[j] - y[i], dz = z[j] - z[i];
                            const s = Math.abs(m[j] / Math.pow(dx * dx + dy * dy + dz * dz + eps, 1.5));
                            sx[i] += Math.abs(dx) * s; sy[i] += Math.abs(dy) * s; sz[i] += Math.abs(dz) * s;
                        }
                        sc.ax = sx; sc.ay = sy; sc.az = sz; return sc;
                    }
                };
            }
        });
    }

    // (5) 逐步積分
    // 5a：N 個獨立簡諧振子（x'' = −x），leapfrog（KDK）；對照 double 的同一公式與解析解 x(t)＝x0·cos t（v0＝0）
    for (const S of [1, 2, 5, 10, 100, 1000]) {
        add({
            id: 'ho_leapfrog_S' + S, group: 'integrator', desc: '簡諧振子 leapfrog，步數 ' + S + '（dt＝0.01；對照 double 同公式）', k: S, sizes: [S],
            make() {
                const N = 64, dt = 0.01;
                const r = rng(91 + S);
                const x0 = fill(r, N, -1, 1), v0 = new Float32Array(N);
                const buffers = {};
                for (let t = 0; t <= S; t++) {
                    buffers['x' + t] = { elem: 'f32', n: N, data: t === 0 ? x0 : undefined };
                    buffers['v' + t] = { elem: 'f32', n: N, data: t === 0 ? v0 : undefined };
                }
                const stages = [];
                for (let t = 0; t < S; t++) stages.push({ k: 'k_kdk', bind: { x: 'x' + t, v: 'v' + t, x2: 'x' + (t + 1), v2: 'v' + (t + 1) }, scalars: { dt: f32(dt), n: N }, N });
                const ref = () => {
                    let x = Float64Array.from(x0), v = Float64Array.from(v0);
                    for (let t = 0; t < S; t++) {
                        const xn = new Float64Array(N), vn = new Float64Array(N);
                        for (let i = 0; i < N; i++) { const vh = v[i] - 0.5 * dt * x[i]; xn[i] = x[i] + dt * vh; vn[i] = vh - 0.5 * dt * xn[i]; }
                        x = xn; v = vn;
                    }
                    return { x, v };
                };
                return {
                    buffers, stages, outs: ['x' + S, 'v' + S], ref: () => { const o = ref(); return { ['x' + S]: o.x, ['v' + S]: o.v }; },
                    scale: () => ({ ['x' + S]: Float64Array.from(x0, () => 1), ['v' + S]: Float64Array.from(x0, () => 1) }),
                    analytic: (outs) => {   // 資訊用：與解析解的差（含 dt² 截斷，不判定）
                        const t = S * dt; let e = 0; for (let i = 0; i < N; i++) e = Math.max(e, Math.abs(outs['x' + S][i] - x0[i] * Math.cos(t)));
                        return e;
                    }
                };
            }
        });
    }
    // 5b：16 體引力系統（f32x4），leapfrog（KDK），每步 5 個核心，逐步對照 double
    for (const S of [1, 2, 5, 10, 100]) {
        add({
            id: 'nbody16_S' + S, group: 'integrator', desc: '16 體引力（f32x4）leapfrog，步數 ' + S + '（逐步對照 double）', k: S * 4, sizes: [S],
            make() {
                const N = 16, dt = 0.001, eps = 0.05, r = rng(101 + S);
                const p0 = new Float32Array(N * 4), v0 = new Float32Array(N * 4), m = new Float32Array(N);
                for (let i = 0; i < N; i++) {
                    p0[i * 4] = f32(r() * 2 - 1); p0[i * 4 + 1] = f32(r() * 2 - 1); p0[i * 4 + 2] = f32(r() * 2 - 1); p0[i * 4 + 3] = 0;
                    v0[i * 4] = f32((r() - 0.5) * 0.2); v0[i * 4 + 1] = f32((r() - 0.5) * 0.2); v0[i * 4 + 2] = f32((r() - 0.5) * 0.2);
                    m[i] = f32(0.5 + r());
                }
                const buffers = { m: { elem: 'f32', n: N, data: m } };
                for (let t = 0; t <= S; t++) {
                    buffers['p' + t] = { elem: 'f32x4', n: N, data: t === 0 ? p0 : undefined };
                    buffers['v' + t] = { elem: 'f32x4', n: N, data: t === 0 ? v0 : undefined };
                    buffers['vh' + t] = { elem: 'f32x4', n: N };
                    buffers['a' + t] = { elem: 'f32x4', n: N };
                    buffers['a2_' + t] = { elem: 'f32x4', n: N };
                    buffers['p2_' + t] = { elem: 'f32x4', n: N };
                }
                const stages = [];
                for (let t = 0; t < S; t++) {
                    stages.push({ k: 'k_grav4', bind: { p: 'p' + t, m: 'm', acc: 'a' + t }, scalars: { n: N, eps }, N });
                    stages.push({ k: 'k_kick4', bind: { v: 'v' + t, acc: 'a' + t, vo: 'vh' + t }, scalars: { h: f32(dt / 2), n: N }, N });
                    stages.push({ k: 'k_drift4', bind: { p: 'p' + t, v: 'vh' + t, po: 'p' + (t + 1) }, scalars: { dt: f32(dt), n: N }, N });
                    stages.push({ k: 'k_grav4', bind: { p: 'p' + (t + 1), m: 'm', acc: 'a2_' + t }, scalars: { n: N, eps }, N });
                    stages.push({ k: 'k_kick4', bind: { v: 'vh' + t, acc: 'a2_' + t, vo: 'v' + (t + 1) }, scalars: { h: f32(dt / 2), n: N }, N });
                }
                const ref = () => {
                    const P = [], V = [];
                    let p = Float64Array.from(p0), v = Float64Array.from(v0);
                    const accOf = (pp) => {
                        const a = new Float64Array(N * 4);
                        for (let i = 0; i < N; i++) {
                            let fx = 0, fy = 0, fz = 0;
                            for (let j = 0; j < N; j++) {
                                const dx = pp[j * 4] - pp[i * 4], dy = pp[j * 4 + 1] - pp[i * 4 + 1], dz = pp[j * 4 + 2] - pp[i * 4 + 2];
                                const s = m[j] / Math.pow(dx * dx + dy * dy + dz * dz + eps, 1.5);
                                fx += dx * s; fy += dy * s; fz += dz * s;
                            }
                            a[i * 4] = fx; a[i * 4 + 1] = fy; a[i * 4 + 2] = fz;
                        }
                        return a;
                    };
                    for (let t = 0; t < S; t++) {
                        const a = accOf(p);
                        const vh = new Float64Array(N * 4);
                        for (let i = 0; i < N * 4; i++) vh[i] = (i % 4 === 3) ? 0 : v[i] + (dt / 2) * a[i];
                        const pn = new Float64Array(N * 4);
                        for (let i = 0; i < N * 4; i++) pn[i] = (i % 4 === 3) ? 0 : p[i] + dt * vh[i];
                        const a2 = accOf(pn);
                        const vn = new Float64Array(N * 4);
                        for (let i = 0; i < N * 4; i++) vn[i] = (i % 4 === 3) ? 0 : vh[i] + (dt / 2) * a2[i];
                        p = pn; v = vn; P.push(p); V.push(v);
                    }
                    return { P, V };
                };
                const names = [];
                return {
                    buffers, stages, outs: ['p' + S, 'v' + S],
                    // 逐步：參考的每個檢查點都對應一組輸出（這裡只取最後一步；逐步檢查點由評測端以 S＝1,2,5,10,100 的獨立案例完成）
                    ref: () => { const o = ref(); return { ['p' + S]: o.P[S - 1], ['v' + S]: o.V[S - 1] }; },
                    scale: () => ({ ['p' + S]: Float64Array.from({ length: N * 4 }, () => 1), ['v' + S]: Float64Array.from({ length: N * 4 }, () => 1) })
                };
            }
        });
    }

    // (6) f32x4 緩衝區與多輸出核心
    add({
        id: 'f32x4_vec4', group: 'vec', desc: 'f32x4：out.x＝in.x＋in.w，out.y＝in.y·2，out.z＝in.z−1，out.w＝in.w（應逐位元相同）', exact: true, k: 0, sizes: [1, 64, 1000],
        make(N) {
            const r = rng(111 + N), a = new Float32Array(N * 4);
            for (let i = 0; i < N * 4; i++) a[i] = f32(r() * 20 - 10);
            return {
                buffers: { a: { elem: 'f32x4', n: N, data: a }, o: { elem: 'f32x4', n: N } },
                stages: [{ k: 'k_vec4', bind: { a: 'a', o: 'o' }, scalars: { n: N }, N }], outs: ['o'],
                ref: () => {
                    const o = new Float64Array(N * 4);
                    // 每個輸出都是單一 IEEE 運算，參考解也要先四捨五入到 f32（否則參考比 GPU 精確，差 1 ulp）
                    for (let i = 0; i < N; i++) { o[i * 4] = f32(a[i * 4] + a[i * 4 + 3]); o[i * 4 + 1] = f32(a[i * 4 + 1] * 2); o[i * 4 + 2] = f32(a[i * 4 + 2] - 1); o[i * 4 + 3] = a[i * 4 + 3]; }
                    return { o };
                },
                scale: () => ({ o: new Float64Array(N * 4).fill(1) })
            };
        }
    });
    add({
        id: 'multi_out', group: 'vec', desc: '多輸出核心：s＝a＋b、d＝a−b（兩個輸出都要對）', exact: true, k: 0, sizes: [1, 63, 64, 65, 1000],
        make(N) {
            const r = rng(121 + N); const a = fill(r, N, -10, 10), b = fill(r, N, -10, 10);
            return {
                buffers: { a: { elem: 'f32', n: N, data: a }, b: { elem: 'f32', n: N, data: b }, s: { elem: 'f32', n: N }, d: { elem: 'f32', n: N } },
                stages: [{ k: 'k_twoout', bind: { a: 'a', b: 'b', s: 's', d: 'd' }, scalars: { n: N }, N }], outs: ['s', 'd'],
                ref: () => ({ s: Float64Array.from(a, (v, i) => f32(v + b[i])), d: Float64Array.from(a, (v, i) => f32(v - b[i])) }),
                scale: () => ({ s: new Float64Array(N).fill(1), d: new Float64Array(N).fill(1) })
            };
        }
    });

    // 比較：回傳每個輸出的最大「誤差／量級」比（exact 案例要求 0）
    function judge(c, outs, refs, scales) {
        const detail = {}; let worst = 0, pass = true;
        for (const name of Object.keys(refs)) {
            const want = refs[name], got = outs[name], sc = scales[name];
            if (!got || got.length !== want.length) { detail[name] = { ok: false, note: '長度不對 ' + (got ? got.length : 'undefined') + ' vs ' + want.length }; pass = false; continue; }
            let maxAbs = 0, maxRatio = 0;
            for (let i = 0; i < want.length; i++) {
                const e = Math.abs(got[i] - want[i]);
                if (Number.isNaN(e) && !Number.isNaN(want[i])) { maxAbs = Infinity; maxRatio = Infinity; break; }
                if (e > maxAbs) maxAbs = e;
                const ratio = e / (sc ? sc[i] : Math.max(1, Math.abs(want[i])));
                if (ratio > maxRatio) maxRatio = ratio;
            }
            const limit = c.exact ? 0 : tolK(c.k) * EPS32;
            const ok = maxRatio <= limit;
            detail[name] = { ok, maxAbs: maxAbs, maxRatio, limit };
            if (!ok) pass = false;
            if (maxRatio > worst) worst = maxRatio;
        }
        return { pass, worst, detail };
    }

    return { EPS32, tolK, SRC, CASES, judge };
});
