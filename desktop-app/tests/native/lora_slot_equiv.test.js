// LoRA 槽版與網頁版併權重的等價性（DESIGN.lora-training.md §11「查明」）。node 直接跑。
// 結論（2026-11-11 查明）：槽版（旁支 fp32）與「x·A·B」的真值逐位元一致；網頁版併權重的誤差是「抖動式四捨五入」的零均值隨機雜訊，
// 不是槽版的錯，也不是縮放（2 的冪）、轉置、rank 槽順序的錯。因此等價的基準應是 fp32 真值，網頁版只能用容忍值比較。
// 兩部分：
//   A（一定跑）：權重層級。併入後的 ΔW 對 A·B 的誤差，單一種子大，對多個種子平均後明顯變小（零均值）。
//   B（有 onnxruntime-node 才跑，否則略過並說明）：用假的 q8 圖（1 層 × 7 目標）：槽版輸出 == 基底 + x·A·B（fp32）；
//      網頁版（patchQwen3Q8）輸出與真值的相對誤差在容忍值內。沒測到的：真模型（617 MB）上的數值，見 §11。
// 執行：node tests/native/lora_slot_equiv.test.js（FA_ROOT 可指定 desktop-app 目錄；未給時用本檔上兩層）
'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const root = process.env.FA_ROOT || path.join(__dirname, '..', '..');
const Merge = require(path.join(root, 'renderer', 'src', 'studio', 'lora_merge_core.js'));
const Web = require(path.join(root, 'renderer', 'src', 'studio', 'lora_web_core.js'));
const Build = require(path.join(root, 'lora-slot-build.js'));

let ok = 0; const bad = []; const skipped = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 400)); } };

let seed = 777;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed + 0.5) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const cosine = (a, b) => { let d = 0, na = 0, nb = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } return d / Math.sqrt(na * nb); };
const relErr = (a, ref) => { let d = 0, n = 0; for (let i = 0; i < a.length; i++) { d += (a[i] - ref[i]) ** 2; n += ref[i] * ref[i]; } return Math.sqrt(d / n); };

(async () => {
    // ---- A：權重層級（不需要 onnxruntime）----
    {
        const din = 256, dout = 192, R = 16, ZP = 128, WS = 0.02;
        const q0 = new Uint8Array(din * dout); for (let i = 0; i < q0.length; i++) q0[i] = Math.max(0, Math.min(255, Math.round(ZP + 40 * gauss())));
        const A = Float32Array.from({ length: din * R }, () => gauss());
        const B = Float32Array.from({ length: R * dout }, () => 0.002 * gauss());   // 小到 ΔW 遠小於一格：最壞情況
        const AB = new Float64Array(din * dout);
        for (let i = 0; i < din; i++) for (let j = 0; j < dout; j++) { let s = 0; for (let r = 0; r < R; r++) s += A[i * R + r] * B[r * dout + j]; AB[i * dout + j] = s; }
        const one = (sd) => {
            const q = Uint8Array.from(q0);
            const m = Merge.mergeTensor({ q, dtype: 'uint8', zp: ZP, scale: WS, din, dout, A, B, rank: R, seed: sd, probes: 0 });
            const d = new Float64Array(din * dout);
            for (let i = 0; i < din; i++) for (let j = 0; j < dout; j++) d[i * dout + j] = (q[i * dout + j] - ZP) * m.scales[j] - (q0[i * dout + j] - ZP) * WS;
            return { d, k: m.kMean };
        };
        const N = 32; const runs = []; for (let s = 1; s <= N; s++) runs.push(one(s * 2654435761 >>> 0));
        const mean = new Float64Array(din * dout); for (const r of runs) for (let i = 0; i < mean.length; i++) mean[i] += r.d[i] / N;
        const single = relErr(runs[0].d, AB), avg = relErr(mean, AB);
        check('A：單一種子的 ΔW 誤差確實大（抖動雜訊可見）', single > 0.5, single);
        check('A：' + N + ' 個種子平均後誤差明顯變小（零均值：約 1/√N）', avg < single * 0.35 && avg < 0.3, { single, avg });
        check('A：平均後與 A·B 高度相似', cosine(mean, AB) > 0.97, cosine(mean, AB));
        check('A：縮放是 2 的冪（不改 k 的語意）', runs.every((r) => Number.isInteger(Math.log2(r.k))), runs[0].k);
    }

    // ---- B：onnxruntime 等價（有執行包才跑）----
    const cands = [process.env.NR_RUNTIME, path.join(process.env.APPDATA || '', 'floating-assistant-desktop', 'native-runtime', '1.22.0-1'), path.join(os.homedir(), '.config', 'floating-assistant-desktop', 'native-runtime', '1.22.0-1')].filter(Boolean);
    const RT = cands.find((p) => fs.existsSync(path.join(p, 'node_modules', 'onnxruntime-node')));
    if (!RT) { skipped.push('B：找不到 onnxruntime-node 執行包（設定 NR_RUNTIME 可指定），略過數值等價'); }
    else {
        const ort = require(path.join(RT, 'node_modules', 'onnxruntime-node'));
        const TE = new TextEncoder();
        const vb = (v) => { const o = []; while (v >= 128) { o.push((v % 128) | 0x80); v = Math.floor(v / 128); } o.push(v); return Uint8Array.from(o); };
        const cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
        const lf = (n, pl) => cat([vb(n * 8 + 2), vb(pl.length), pl]);
        const sf = (n, s) => lf(n, TE.encode(s));
        const nf = (n, v) => cat([vb(n * 8), vb(v)]);
        const attrI = (name, v) => lf(5, cat([sf(1, name), nf(20, 2), nf(3, v)]));
        const node = (name, op, ins, outs, attrs) => lf(1, cat([...ins.map((s) => sf(1, s)), ...outs.map((s) => sf(2, s)), sf(3, name), sf(4, op), ...(attrs || [])]));
        const tensor = (name, dims, dt, raw) => lf(5, cat([...dims.map((d) => nf(1, d)), nf(2, dt), sf(8, name), lf(9, raw)]));
        const viBody = (name, dims) => cat([sf(1, name), lf(2, lf(1, cat([nf(1, 1), lf(2, cat(dims.map((d) => lf(1, nf(1, d)))))])))]);
        const F32 = (arr) => new Uint8Array(Float32Array.from(arr).buffer);
        const PROJ = [['attn', 'q_proj', 8, 12], ['attn', 'k_proj', 8, 6], ['attn', 'v_proj', 8, 6], ['attn', 'o_proj', 12, 8], ['mlp', 'gate_proj', 8, 20], ['mlp', 'up_proj', 8, 20], ['mlp', 'down_proj', 20, 8]];
        const ZP = 128, RANK = 4, WS = 0.02;
        // 假 q8 圖：與 quantize_dynamic 同一套命名與節點形狀（DynamicQuantizeLinear → MatMulInteger → Cast → Mul(xs,ws) → Mul）
        const buildQ8 = (wq) => {
            const parts = [], inits = [], ins = [], outs = [];
            PROJ.forEach(([grp, proj, din, dout], i) => {
                const base = `/model/layers.0/${grp}/${proj}/MatMul`, x = `/model/layers.0/${grp}/${proj}/in`;
                parts.push(node(base + '/dq', 'DynamicQuantizeLinear', [x], [x + '_quantized', x + '_scale', x + '_zero_point']));
                parts.push(node(base + '_quant', 'MatMulInteger', [x + '_quantized', `w.${proj}`, x + '_zero_point', `wz.${proj}`], [base + '_q']));
                parts.push(node(base + '_cast', 'Cast', [base + '_q'], [base + '_c'], [attrI('to', 1)]));
                parts.push(node(base + '_sprod', 'Mul', [x + '_scale', `ws.${proj}`], [base + '_s']));
                parts.push(node(base + '_scale_mul', 'Mul', [base + '_c', base + '_s'], [base + '/output_0']));
                inits.push(tensor(`w.${proj}`, [din, dout], 2, wq[i]), tensor(`wz.${proj}`, [], 2, Uint8Array.of(ZP)), tensor(`ws.${proj}`, [], 1, F32([WS])));
                ins.push(lf(11, viBody(x, [1, din]))); outs.push(lf(12, viBody(base + '/output_0', [1, dout])));
            });
            return cat([nf(1, 8), lf(8, cat([sf(1, ''), nf(2, 17)])), lf(7, cat([...parts, ...inits, sf(2, 'g'), ...ins, ...outs])), sf(2, 'repro')]);
        };
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slot-equiv-'));
        try {
            const wq = PROJ.map(([, , din, dout]) => { const q = new Uint8Array(din * dout); for (let i = 0; i < q.length; i++) q[i] = Math.max(0, Math.min(255, Math.round(ZP + 40 * gauss()))); return q; });
            const A = [], B = [], X = [];
            PROJ.forEach(([, , din, dout]) => { A.push(Float32Array.from({ length: din * RANK }, () => gauss())); B.push(Float32Array.from({ length: RANK * dout }, () => 0.02 * gauss())); X.push(Float32Array.from({ length: din }, () => gauss())); });
            const base = buildQ8(wq);
            const feeds = {}; PROJ.forEach(([grp, proj, din], i) => { feeds[`/model/layers.0/${grp}/${proj}/in`] = new ort.Tensor('float32', X[i], [1, din]); });
            const outName = PROJ.map(([grp, proj]) => `/model/layers.0/${grp}/${proj}/MatMul/output_0`);
            const run = async (bytes, dir, extra) => {
                fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'model.onnx'), bytes);
                if (extra) fs.writeFileSync(path.join(dir, 'lora.bin'), extra);
                const s = await ort.InferenceSession.create(path.join(dir, 'model.onnx'), { executionProviders: ['cpu'] });
                const r = await s.run(feeds); const out = {}; for (const k of Object.keys(r)) out[k] = Float32Array.from(r[k].data); return out;
            };
            // 槽版（真的 fp32 旁支）
            const sdir = path.join(tmp, 'slot');
            const res = Build.buildSlotModel({ srcBytes: base, outDir: sdir, rank: RANK });
            const lora = new Uint8Array(res.layout.total_bytes);
            const idxOf = new Map(PROJ.map(([, p], i) => [p, i]));
            for (const t of res.layout.tensors) { const [, , proj, ab] = t.name.split('.'); const v = ab === 'A' ? A[idxOf.get(proj)] : B[idxOf.get(proj)]; lora.set(new Uint8Array(v.buffer), t.offset); }
            const slotOut = await run(fs.readFileSync(path.join(sdir, 'model_quantized.onnx')), path.join(tmp, 'slot_run'), lora);
            const baseOut = await run(base, path.join(tmp, 'base'));
            // 網頁版（併權重）
            const pr = Web.patchQwen3Q8(Uint8Array.from(base), lora, { rank: RANK, minCos: 0, loraSha256: 'equiv-test' });
            check('B：網頁版併權重成功', pr.ok, pr.error);
            if (pr.ok) {
                const webOut = await run(Buffer.concat(pr.parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))), path.join(tmp, 'web'), lora);
                let worstSlot = 0, worstWeb = 0, worstWebQ = 0;
                PROJ.forEach(([, , din, dout], i) => {
                    const nm = outName[i], yb = baseOut[nm], ys = slotOut[nm], yw = webOut[nm];
                    const xab = new Float32Array(dout), h = new Float32Array(RANK);
                    for (let r = 0; r < RANK; r++) for (let k = 0; k < din; k++) h[r] += X[i][k] * A[i][k * RANK + r];
                    for (let j = 0; j < dout; j++) for (let r = 0; r < RANK; r++) xab[j] += h[r] * B[i][r * dout + j];
                    const yt = yb.map((v, j) => v + xab[j]);
                    // 網頁版的 LoRA 項吃的是動態量化後的輸入（與真值用的 fp32 輸入差一點點）：另外算一個「量化後輸入」的真值，確認差異不是來自它
                    const xmin = Math.min(0, ...X[i]), xmax = Math.max(0, ...X[i]), xs = (xmax - xmin) / 255, xzp = Math.round(-xmin / xs);
                    const Xdq = Float32Array.from(X[i], (v) => (Math.max(0, Math.min(255, Math.round(v / xs) + xzp)) - xzp) * xs);
                    const hq = new Float32Array(RANK), xabq = new Float32Array(dout);
                    for (let r = 0; r < RANK; r++) for (let k = 0; k < din; k++) hq[r] += Xdq[k] * A[i][k * RANK + r];
                    for (let j = 0; j < dout; j++) for (let r = 0; r < RANK; r++) xabq[j] += hq[r] * B[i][r * dout + j];
                    const ytq = yb.map((v, j) => v + xabq[j]);
                    worstSlot = Math.max(worstSlot, relErr(ys, yt)); worstWeb = Math.max(worstWeb, relErr(yw, yt));
                    worstWebQ = Math.max(worstWebQ, relErr(yw, ytq));
                });
                check('B：槽版輸出 == 基底 + x·A·B（fp32 真值，相對誤差 < 1e-5）', worstSlot < 1e-5, worstSlot);
                check('B：網頁版輸出與真值相對誤差在容忍值內（抖動雜訊，實測約 0.5%～1.3%）', worstWeb < 0.03, worstWeb);
                check('B：網頁版對「量化後輸入的真值」的誤差與對 fp32 真值的誤差相近（差異不是量化輸入造成）', worstWebQ < 0.03 && Math.abs(worstWebQ - worstWeb) < 0.01, { worstWeb, worstWebQ });
            }
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }
    for (const s of skipped) console.log('SKIP', s);
    console.log(`lora_slot_equiv: ${ok} 通過${bad.length ? '，失敗 ' + bad.length + '：' + bad.join('、') : ''}${skipped.length ? '（略過 ' + skipped.length + ' 項）' : ''}`);
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
