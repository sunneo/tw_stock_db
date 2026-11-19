// node renderer/src/uml/fluid3d_cl.test.js — fluid3d 的 OpenCL 版（examples/llc/gpgpu/fluid3d_cl.ll，產生器 _gen/_gen_fluid3d_cl.py）。
// 1. 編得出 wasm；2. 從 .ll 的 @sph_src 讀出四個核心（krho 密度、kfx／kfy／kfz 力），用 JS 墊片（clCompile）與 KIR（cl_front→kir.runJs）執行，
// 與 double 精度的 CPU 參考比對。核心是 float32，所以容差用相對於最大量級的比例。
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js');
const CF = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 240) : '')); };

const IRPATH = path.join(__dirname, '../examples/llc/gpgpu/fluid3d_cl.ll');
const ir = fs.readFileSync(IRPATH, 'utf8');

function clSource(text) {
    const m = text.match(/@sph_src = private constant \[(\d+) x i8\] c"((?:[^"\\]|\\[0-9A-Fa-f]{2})*)"/);
    if (!m) return null;
    const bytes = []; const s = m[2];
    for (let i = 0; i < s.length;) {
        if (s[i] === '\\') { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 3; } else { bytes.push(s.charCodeAt(i)); i += 1; }
    }
    if (bytes.length !== +m[1]) return null;
    return Buffer.from(bytes).toString('latin1').replace(/\0+$/, '');
}

// 1. 編譯
const host = H.create({ gui: async () => null, fs: { read: () => null, write: () => {}, exists: () => false, remove: () => {} } });
host.install(L);
const c = L.compileIr(ir, {});
check('fluid3d_cl.ll 編得出 wasm', !!c.wasm, c.errors);
host.uninstall(L);

// 2. 核心原始碼
const src = clSource(ir);
const names = ['krho', 'kfx', 'kfy', 'kfz'];
check('@sph_src 讀得出來', typeof src === 'string' && /__kernel void krho\(/.test(src), src && src.slice(0, 60));
for (const n of names) check('核心 ' + n + ' 在原始碼裡', !!src && src.indexOf('void ' + n + '(') >= 0);

// 物理常數（與 _gen_fluid3d.py 相同）
const Hh = 0.1, SPACING = Hh / 2, RHO0 = 1000, MASS = RHO0 * SPACING ** 3, K = 200, MU = 3, G = -9.8;
const POLY6 = 315 / (64 * Math.PI * Hh ** 9), SPIKY = -45 / (Math.PI * Hh ** 6), VISC = 45 / (Math.PI * Hh ** 6);
const C0 = MASS * POLY6, CS = -MASS * SPIKY, CV = MU * MASS * VISC, H2 = Hh * Hh;

// CPU 參考（double，與 _gen_fluid3d.py 的 step 同一公式）
function ref(X, Y, Z, VX, VY, VZ, N) {
    const rho = new Float64Array(N), ax = new Float64Array(N), ay = new Float64Array(N), az = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        let s = 0;
        for (let j = 0; j < N; j++) {
            const dx = X[i] - X[j], dy = Y[i] - Y[j], dz = Z[i] - Z[j];
            const mm = H2 - (dx * dx + dy * dy + dz * dz);
            if (mm > 0) s += mm * mm * mm;
        }
        rho[i] = s * C0;
    }
    const prs = (r) => (r - RHO0) * K > 0 ? (r - RHO0) * K : 0;
    for (let i = 0; i < N; i++) {
        let fx = 0, fy = 0, fz = 0;
        for (let j = 0; j < N; j++) {
            const dx = X[i] - X[j], dy = Y[i] - Y[j], dz = Z[i] - Z[j];
            const r2 = dx * dx + dy * dy + dz * dz;
            if (r2 < H2 && r2 > 1e-12) {
                const r = Math.sqrt(r2), w = Hh - r;
                const cp = ((prs(rho[i]) + prs(rho[j])) / (rho[j] * 2)) * (w * w / r) * CS;
                const cv = (w / rho[j]) * CV;
                fx += dx * cp + (VX[j] - VX[i]) * cv; fy += dy * cp + (VY[j] - VY[i]) * cv; fz += dz * cp + (VZ[j] - VZ[i]) * cv;
            }
        }
        const inv = 1 / rho[i];
        ax[i] = fx * inv; ay[i] = fy * inv + G; az[i] = fz * inv;
    }
    return { rho, ax, ay, az };
}

if (src) {
    const N = 60;
    let seed = 4242; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    // 位置用 double（與 CPU 參考同精度）；GPU 收到的是 hi（float）與 lo（float(pos − hi)）兩個陣列，dx 由兩者合成
    const X = new Float64Array(N), Y = new Float64Array(N), Z = new Float64Array(N), VX = new Float32Array(N), VY = new Float32Array(N), VZ = new Float32Array(N);
    for (let i = 0; i < N; i++) { X[i] = rnd() * 0.3; Y[i] = rnd() * 0.3; Z[i] = rnd() * 0.3; VX[i] = (rnd() - 0.5) * 0.2; VY[i] = (rnd() - 0.5) * 0.2; VZ[i] = (rnd() - 0.5) * 0.2; }
    const R = ref(X, Y, Z, VX, VY, VZ, N);
    const tolOf = (arr) => 2e-3 * Math.max(1, ...arr.map(Math.abs));
    const scalars = { n: N, h2: H2, h: Hh, c0: C0, K, rho0: RHO0, cs: CS, cv: CV, g: G };
    const hiOf = (A) => Float32Array.from(A), loOf = (A) => Float32Array.from(A, (v, i) => v - Math.fround(v));
    const ARG_BUF = { x: hiOf(X), y: hiOf(Y), z: hiOf(Z), xl: loOf(X), yl: loOf(Y), zl: loOf(Z), vx: VX, vy: VY, vz: VZ };

    // 2a. JS 墊片（clCompile）
    const cc = H.clCompile(src);
    check('clCompile 翻得過四個核心', !!cc.kernels && names.every((n) => cc.kernels[n]), cc.error || Object.keys(cc.kernels || {}));
    // 2b. KIR（cl_front→runJs）
    const pr = CF.parseKernels(src);
    check('cl_front 解析四個核心', pr.ok && pr.kernels.length === 4, pr.error || pr.kernels && pr.kernels.length);

    const outOf = { krho: 'rho', kfx: 'ax', kfy: 'ay', kfz: 'az' };
    const wantOf = { rho: R.rho, ax: R.ax, ay: R.ay, az: R.az };
    if (cc.kernels) {
        for (const n of names) {
            const k = cc.kernels[n];
            const out = new Float32Array(N);
            const rhoIn = R.rho.map((v) => Math.fround(v));   // 力核心讀的 rho（float32）
            const args = k.params.map((p) => {
                if (p.name in ARG_BUF) return ARG_BUF[p.name];
                if (p.name === 'rho' && n !== 'krho') return rhoIn;
                if (p.name === outOf[n]) return out;
                if (p.name in scalars) return scalars[p.name];
                return undefined;
            });
            k.run([N, 1, 1], [0, 0, 0], 1, args);
            const want = wantOf[outOf[n]];
            let err = 0; for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(out[i] - want[i]));
            check('JS 墊片 ' + n + ' 與 CPU 參考一致（最大誤差 ' + err.toExponential(2) + '，容差 ' + tolOf(want).toExponential(2) + '）', err <= tolOf(want), { err });
        }
    }
    if (pr.ok) {
        for (const k of pr.kernels) {
            const v = KIR.validate(k); check('KIR 驗證 ' + k.name, v.ok, v.errors);
            const B = {};
            const outBuf = k.params.find((p) => p.kind === 'buf' && p.access === 'out').name;
            for (const p of k.params) if (p.kind === 'buf') {
                if (p.access === 'out') B[p.name] = new Float32Array(N);
                else if (p.name === 'rho') B[p.name] = R.rho.map((v2) => Math.fround(v2));
                else B[p.name] = ARG_BUF[p.name];
            }
            const sc = {}; for (const p of k.params) if (p.kind === 'scalar') sc[p.name] = scalars[p.name];
            KIR.runJs(k, B, sc, N);
            const want = wantOf[outOf[k.name]];
            let err = 0; for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(B[outBuf][i] - want[i]));
            check('KIR ' + k.name + ' 與 CPU 參考一致（最大誤差 ' + err.toExponential(2) + '，容差 ' + tolOf(want).toExponential(2) + '）', err <= tolOf(want), { err });
        }
    }
}

console.log('fluid3d_cl: ' + ok + ' passed' + (bad.length ? '\nFAILED:\n  ' + bad.join('\n  ') : ''));
if (bad.length) process.exitCode = 1;
