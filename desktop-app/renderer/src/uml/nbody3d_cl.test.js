// node renderer/src/uml/nbody3d_cl.test.js — nbody3d 的 OpenCL 版（examples/llc/gpgpu/nbody3d_cl.ll，產生器 _gen/_gen_nbody3d_cl.py）。
// 1. 編得出 wasm（llvm_core＋llvm_host）；2. 從 .ll 的 @cl_src 讀出 OpenCL 原始碼，四個核心
//    （accx、accy、accz、accpot）用 JS 墊片（clCompile）與 KIR（cl_front→kir.runJs）執行，與 CPU 參考實作比對。
// 真正的 GPU（WebGL2）路徑與每幀計時要在真 Electron 跑（scripts/eval/nbody3d_cl_timing.eval.js）。
const fs = require('fs'), path = require('path');
const L = require('./llvm_core.js'), H = require('./llvm_host.js');
const CF = require('../gpu/cl_front.js'), KIR = require('../gpu/kir.js');
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 240) : '')); };

const IRPATH = path.join(__dirname, '../examples/llc/gpgpu/nbody3d_cl.ll');
const ir = fs.readFileSync(IRPATH, 'utf8');

// 讀 @cl_src = private constant [N x i8] c"…"（esc 只會把 " 與 \ 以外的非可印字元寫成 \XX）
function clSource(text) {
    const m = text.match(/@cl_src = private constant \[(\d+) x i8\] c"((?:[^"\\]|\\[0-9A-Fa-f]{2})*)"/);
    if (!m) return null;
    const bytes = []; const s = m[2];
    for (let i = 0; i < s.length;) {
        if (s[i] === '\\') { bytes.push(parseInt(s.substr(i + 1, 2), 16)); i += 3; } else { bytes.push(s.charCodeAt(i)); i += 1; }
    }
    if (bytes.length !== +m[1]) return null;
    return Buffer.from(bytes).toString('latin1').replace(/\0+$/, '');
}

// 1. 編譯（需要 llvm_host 的簽名）
const host = H.create({ gui: async () => null, fs: { read: () => null, write: () => {}, exists: () => false, remove: () => {} } });
host.install(L);
const c = L.compileIr(ir, {});
check('nbody3d_cl.ll 編得出 wasm', !!c.wasm, c.errors);
host.uninstall(L);

// 2. 核心原始碼
const src = clSource(ir);
check('@cl_src 讀得出來', typeof src === 'string' && /__kernel void accx\(/.test(src), src && src.slice(0, 80));
const names = ['accx', 'accy', 'accz', 'accpot'];
for (const n of names) check('核心 ' + n + ' 在原始碼裡', !!src && src.indexOf('void ' + n + '(') >= 0);

// CPU 參考（與 _gen_nbody3d.py 的 step 同一個公式：s = G·m_j·inv³，a += s·d；pot += m_j·inv；j≠i）
function ref(X, Y, Z, MS, N, G, e2) {
    const ax = new Float64Array(N), ay = new Float64Array(N), az = new Float64Array(N), pot = new Float64Array(N);
    for (let i = 0; i < N; i++) {
        let a = 0, b = 0, cz = 0, p = 0;
        for (let j = 0; j < N; j++) {
            if (j === i) continue;
            const dx = X[j] - X[i], dy = Y[j] - Y[i], dz = Z[j] - Z[i];
            const inv = 1 / Math.sqrt(dx * dx + dy * dy + dz * dz + e2);
            const s = G * MS[j] * inv * inv * inv;
            a += s * dx; b += s * dy; cz += s * dz; p += MS[j] * inv;
        }
        ax[i] = a; ay[i] = b; az[i] = cz; pot[i] = p;
    }
    return { ax, ay, az, pot };
}

if (src) {
    const N = 48, G = 0.8, e2 = 0.01;
    let seed = 777; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const X = new Float32Array(N), Y = new Float32Array(N), Z = new Float32Array(N), MS = new Float32Array(N);
    for (let i = 0; i < N; i++) { X[i] = rnd() * 10; Y[i] = rnd() * 10; Z[i] = rnd() * 10; MS[i] = 200 + rnd() * 100; }
    const R = ref(X, Y, Z, MS, N, G, e2);
    const tolOf = (arr) => 1e-3 * Math.max(1, ...arr.map(Math.abs));

    // 2a. 原始碼用 JS 墊片（clCompile）翻譯
    const cc = H.clCompile(src);
    check('clCompile 翻得過四個核心', !!cc.kernels && names.every((n) => cc.kernels[n]), cc.error || Object.keys(cc.kernels || {}));
    if (cc.kernels) {
        const outName = { accx: 'ax', accy: 'ay', accz: 'az', accpot: 'pot' };
        for (const n of names) {
            const k = cc.kernels[n]; const out = new Float32Array(N);
            const args = k.params.map((p) => {
                if (p.name === 'x') return X; if (p.name === 'y') return Y; if (p.name === 'z') return Z; if (p.name === 'ms') return MS;
                if (p.name === outName[n]) return out; if (p.name === 'n') return N; if (p.name === 'G') return G; if (p.name === 'e2') return e2;
                return undefined;
            });
            k.run([N, 1, 1], [0, 0, 0], 1, args);
            const want = R[outName[n] === 'pot' ? 'pot' : 'a' + outName[n][1]];
            let err = 0; for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(out[i] - want[i]));
            check('JS 墊片 ' + n + ' 與 CPU 參考一致（最大誤差 ' + err.toExponential(2) + '）', err <= tolOf(want), { err });
        }
    }

    // 2b. 同一份原始碼：cl_front→KIR→runJs（與 GPU 的 WebGL2 路徑用同一個翻譯結果）
    const pr = CF.parseKernels(src);
    check('cl_front 解析全部核心（4 個加速度＋3 個速度＋3 個位置）', pr.ok && pr.kernels.length === 10, pr.error || pr.kernels && pr.kernels.length);
    if (pr.ok) {
        const outName = { accx: 'ax', accy: 'ay', accz: 'az', accpot: 'pot' };
        for (const k of pr.kernels.filter((q) => names.includes(q.name))) {
            const v = KIR.validate(k); check('KIR 驗證 ' + k.name, v.ok, v.errors);
            const B = {}; for (const p of k.params) if (p.kind === 'buf') B[p.name] = p.access === 'out' ? new Float32Array(N) : ({ x: X, y: Y, z: Z, ms: MS })[p.name];
            KIR.runJs(k, B, { n: N, G, e2 }, N);
            const outBuf = k.params.find((p) => p.kind === 'buf' && p.access === 'out').name;
            const want = R[outName[k.name] === 'pot' ? 'pot' : 'a' + outName[k.name][1]];
            let err = 0; for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(B[outBuf][i] - want[i]));
            check('KIR ' + k.name + ' 與 CPU 參考一致（最大誤差 ' + err.toExponential(2) + '）', err <= tolOf(want), { err });
        }
    }
}

// 積分核心（步驟 1b）：vx' = vx + ax·dt；x' = x + clampf(vx', 1, vmax)·dt（clampf：超過上限移回一半，再看下限）
const prI = src ? CF.parseKernels(src) : { ok: false, kernels: [] };
if (src && prI.ok) {
    const N = 48, dt = 0.01, vmax = 5.0;
    let seed = 2024; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const V = new Float32Array(N), A = new Float32Array(N), P = new Float32Array(N);
    for (let i = 0; i < N; i++) { V[i] = (rnd() - 0.5) * 20; A[i] = (rnd() - 0.5) * 3; P[i] = rnd() * 10; }
    const clampRef = (v) => { let x = v; if (x > vmax) x = (x + vmax) * 0.5; if (x < 1) x = (x + 1) * 0.5; return x; };
    const wantV = new Float64Array(N), wantP = new Float64Array(N);
    for (let i = 0; i < N; i++) { wantV[i] = V[i] + A[i] * dt; wantP[i] = P[i] + clampRef(wantV[i]) * dt; }
    const byName = Object.fromEntries(prI.kernels.map((k) => [k.name, k]));
    const cases = [['kvx', 'vx', 'ax', 'ovx', wantV], ['kpx', 'x', 'vx', 'ox', wantP]];
    // 速度核心的第二個輸入是加速度（ax）；位置核心的第二個輸入是新速度，這裡用參考的新速度當輸入
    for (const [kn, in1, in2, outn, want] of cases) {
        const k = byName[kn];
        check('積分核心 ' + kn + ' 存在', !!k, Object.keys(byName));
        if (!k) continue;
        const B = { [in1]: kn === 'kvx' ? V : P, [in2]: kn === 'kvx' ? A : wantV, [outn]: new Float32Array(N) };
        const sc = kn === 'kvx' ? { n: N, dt } : { n: N, dt, vmax };
        const kk = { ...k, params: k.params.map((p) => (p.name === 'vx' && kn === 'kpx' ? { ...p, name: 'vx' } : p)) };
        KIR.runJs(k, Object.fromEntries(k.params.filter((p) => p.kind === 'buf').map((p) => [p.name, B[p.name]])), sc, N);
        const got = B[outn]; let err = 0; for (let i = 0; i < N; i++) err = Math.max(err, Math.abs(got[i] - want[i]));
        check('KIR ' + kn + ' 與參考公式一致（最大誤差 ' + err.toExponential(2) + '）', err <= 1e-4 * Math.max(1, ...want.map(Math.abs)), { err });
    }
}

console.log('nbody3d_cl: ' + ok + ' passed' + (bad.length ? '\nFAILED:\n  ' + bad.join('\n  ') : ''));
if (bad.length) process.exitCode = 1;
