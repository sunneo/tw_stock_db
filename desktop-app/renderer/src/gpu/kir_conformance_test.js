// node renderer/src/gpu/kir_conformance_test.js — KIR／OpenCL 一致性套件（node 版）：所有案例用 KIR 的 JS 後端（kir.runJs）當參考，
// 與 double 參考解比對（容差與 kir_conformance_cases.js 相同）。真 GPU 的比對在 scripts/eval/kir_conformance.eval.js。
const path = require('path');
const K = require('./kir.js'), FR = require('./cl_front.js'), C = require('./kir_conformance_cases.js');

const parsed = FR.parseKernels(C.SRC);
if (!parsed.ok) { console.error('cl_front 解析失敗：' + parsed.error); process.exitCode = 1; }
const kmap = {}; if (parsed.ok) for (const k of parsed.kernels) kmap[k.name] = k;

// JS 後端：每個 f32 運算已由 kir.runJs 包成 Math.fround
const jsBackend = {
    alloc: (elem, n) => ({ elem, n, arr: new Float32Array(n * (elem === 'f32x4' ? 4 : 1)) }),
    upload: (h, data) => { h.arr.set(data); },
    download: (h) => Promise.resolve(h.arr.slice()),
    dispatch: (kernel, binds, out, scalars, N) => {
        if (!(N >= 1)) return;   // 空派送：不做事
        const B = {}, sc = {};
        for (const p of kernel.params) { if (p.kind === 'buf') B[p.name] = binds[p.name].arr; else sc[p.name] = scalars[p.name]; }
        K.runJs(kernel, B, sc, N);
    }
};

// 跑一個案例實例（給定後端）：分配、上傳、依階段派送、下載輸出
async function runOne(inst, be, km) {
    const H = {};
    for (const [name, s] of Object.entries(inst.buffers)) {
        if (s.n === 0) { H[name] = null; continue; }
        H[name] = be.alloc(s.elem, s.n);
        if (s.data) be.upload(H[name], s.data);
    }
    for (const st of inst.stages) {
        const k = km[st.k], binds = {};
        for (const p of k.params) if (p.kind === 'buf') binds[p.name] = H[st.bind[p.name]];
        const outP = k.params.find((p) => p.kind === 'buf' && p.access === 'out');
        await be.dispatch(k, binds, outP ? binds[outP.name] : undefined, st.scalars, st.N);
    }
    const got = {};
    for (const name of inst.outs) got[name] = inst.buffers[name].n ? await be.download(H[name]) : new Float32Array(0);
    return got;
}

async function main() {
    let total = 0, passed = 0; const failures = [];
    if (!parsed.ok) return;
    for (const c of C.CASES) {
        for (const N of c.sizes) {
            total++;
            let res;
            try {
                const inst = c.make(N);
                const got = await runOne(inst, jsBackend, kmap);
                const refs = inst.ref(), scales = inst.scale();
                res = C.judge(c, got, refs, scales);
                if (inst.analytic) res.analytic = inst.analytic(got);
            } catch (e) {
                res = { pass: false, error: String(e && e.message || e).slice(0, 200) };
            }
            if (res.pass) passed++; else failures.push(c.id + ' N=' + N + ' ' + (res.error || JSON.stringify(res.detail).slice(0, 300)));
        }
    }
    console.log('kir_conformance (JS 參考後端): ' + passed + '/' + total + ' passed');
    if (failures.length) { console.log('FAILED:\n  ' + failures.join('\n  ')); process.exitCode = 1; }
}

// 多輸出拆分（WebGL2 用）：拆成單一輸出核心依序執行，結果必須與原核心逐位元相同（JS 參考後端）
function splitCheck() {
    const GEN = require('./kir_gen.js');
    let n = 0, bad = [];
    for (const k of Object.values(kmap)) {
        const outs = k.params.filter((p) => p.kind === 'buf' && p.access === 'out');
        if (outs.length < 2) continue;
        const N = 37, sc = { n: N, eps: 0.01, dt: 0.05, h: 0.5, s: 1.25 };
        const mk = () => { const B = {}; for (const p of k.params) if (p.kind === 'buf') { const len = N * (p.elem === 'f32x4' ? 4 : 1); B[p.name] = new Float32Array(len); if (p.access === 'in') for (let i = 0; i < len; i++) B[p.name][i] = Math.fround(Math.sin(i * 0.37 + p.name.length)); } return B; };
        const whole = mk(); K.runJs(k, whole, Object.fromEntries(k.params.filter((p) => p.kind === 'scalar').map((p) => [p.name, sc[p.name]])), N);
        const parts = mk();
        for (const sk of GEN.singleOutKernels(k)) K.runJs(sk, parts, Object.fromEntries(sk.params.filter((p) => p.kind === 'scalar').map((p) => [p.name, sc[p.name]])), N);
        for (const o of outs) { n++; for (let i = 0; i < whole[o.name].length; i++) if (!Object.is(whole[o.name][i], parts[o.name][i])) { bad.push(k.name + '.' + o.name + ' 元素 ' + i); break; } }
    }
    console.log('kir_conformance 多輸出拆分（JS）：' + (n - bad.length) + '/' + n + ' 個輸出逐位元相同');
    if (bad.length) { console.log('拆分不一致：' + bad.join(', ')); process.exitCode = 1; }
}
main().then(() => splitCheck()).catch((e) => { console.error(e); process.exitCode = 1; });
module.exports = { jsBackend, runOne, kmap };
