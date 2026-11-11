'use strict';
// 真模型（標準版 q8 ONNX）：槽版轉換器的 LoRA 旁支是否等於 fp32 真值？
// 逐目標（196 個）：旁支輸出（槽版 y − 槽版內的基底輸出 y_base）對 x·A·B（x 取自同一次槽版執行的啟動值）。
// 在基底與槽版的 graph 尾端加上 y、y_base、x 為圖輸出，並關閉圖最佳化（否則部分中間名稱會被融合掉、不回傳）。
// 用法：node scripts/eval/lora_slot_branch_check.js <標準版 onnx> <random:種子:B幅度[:A幅度]> <ids.json> <OUT>
'use strict';
// 真模型：槽版的 LoRA 旁支是否等於 fp32 真值？逐目標（196 個）：旁支輸出（槽版 y − 基底 y）對 x·A·B（x 取自基底的同一啟動值）。
// 做法：在基底與槽版的 graph 尾端加上「目標輸出 y」與「目標啟動值 x」為圖輸出，跑一次 forward。
// 用法：node branch_check.js <標準版 onnx> <random:種子:B[:A]> <ids.json> <OUT>
const fs = require('fs'), path = require('path');
const RT = process.env.NR_RUNTIME || path.join(require('os').homedir(), '.config', 'floating-assistant-desktop', 'native-runtime', '1.22.0-1');
const ort = require(path.join(RT, 'node_modules', 'onnxruntime-node'));
const R = path.join(__dirname, '..', '..');
const Build = require(path.join(R, 'lora-slot-build.js'));
const Onnx = require(path.join(R, 'renderer/src/studio/onnx_patch_core.js'));
const [stdPath, spec, idsPath, OUT] = process.argv.slice(2);
if (!stdPath || !spec || !idsPath || !OUT) { console.error('用法：node lora_slot_branch_check.js <標準版 onnx> <random:種子:B[:A]> <ids.json> <OUT>'); process.exit(2); }
fs.mkdirSync(OUT, { recursive: true });
const TE = new TextEncoder();
const vb = (v) => { const o = []; while (v >= 128) { o.push((v % 128) | 0x80); v = Math.floor(v / 128); } o.push(v); return Uint8Array.from(o); };
const cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };
const lf = (n, pl) => cat([vb(n * 8 + 2), vb(pl.length), pl]);
const sf = (n, s) => lf(n, TE.encode(s));
const nf = (n, v) => cat([vb(n * 8), vb(v)]);
// 把名稱清單加成圖輸出（無 shape 的 float 型別）
function withOutputs(buf, names, outPath) {
    function rv(p) { let v = 0, m = 1; for (;;) { const c = buf[p++]; v += (c & 0x7f) * m; m *= 128; if (!(c & 0x80)) return [v, p]; } }
    let p = 0, g = null;
    while (p < buf.length) { const ts = p; let tag; [tag, p] = rv(p); const num = Math.floor(tag / 8), wt = tag % 8; if (wt === 0) [, p] = rv(p); else if (wt === 2) { let len; [len, p] = rv(p); if (num === 7) g = { ts, s: p, e: p + len }; p += len; } else if (wt === 1) p += 8; else if (wt === 5) p += 4; }
    const body = cat([buf.subarray(g.s, g.e), ...names.map((nm) => lf(12, cat([sf(1, nm), lf(2, lf(1, nf(1, 1)))])))]);
    fs.writeFileSync(outPath, cat([buf.subarray(0, g.ts), vb(7 * 8 + 2), vb(body.length), body, buf.subarray(g.e)]));
}
(async () => {
    const base = fs.readFileSync(stdPath);
    const idx = Onnx.indexModel(base);
    const targets = []; // {name, x}
    for (const n of idx.nodes) if (n.op === 'MatMulInteger' && /\/model\/layers\.\d+\/(attn|mlp)\/\w+\/MatMul_quant$/.test(n.name)) {
        const y = n.name.replace(/_quant$/, '/output_0'); targets.push({ name: n.name, y, x: n.inputs[0].replace(/_quantized$/, '') });
    }
    // 槽版（正式 builder）
    const sdir = path.join(OUT, 'slot'); const res = Build.buildSlotModel({ srcPath: stdPath, outDir: sdir, rank: 16 });
    let seedR = Number(spec.split(':')[1]); const rnd = () => { seedR = (seedR * 1103515245 + 12345) >>> 0; return (seedR + 0.5) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    const bs = Number(spec.split(':')[2]), as = Number(spec.split(':')[3] || 1);
    const lora = new Uint8Array(res.layout.total_bytes); const AB = new Map();
    for (const t of res.layout.tensors) { const n = t.dims[0] * t.dims[1]; const f = new Float32Array(n); const sc = t.name.endsWith('.A') ? as : bs; for (let i = 0; i < n; i++) f[i] = sc * gauss(); lora.set(new Uint8Array(f.buffer), t.offset); AB.set(t.name, f); }
    fs.writeFileSync(path.join(sdir, 'lora.bin'), lora);
    // 加輸出：y 與 x（基底與槽版都有這些名稱）
    const names = [...new Set([...targets.map((t) => t.y), ...targets.map((t) => t.x)])];
    const bpath = path.join(OUT, 'base_out.onnx'); withOutputs(base, names, bpath);
    const spath = path.join(OUT, 'slot_out.onnx'); withOutputs(fs.readFileSync(path.join(sdir, 'model_quantized.onnx')), [...names, ...targets.map((t) => t.y + '_base')], spath); fs.copyFileSync(path.join(sdir, 'lora.bin'), path.join(OUT, 'lora.bin'));
    const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8')); const T = ids.length;
    const feeds = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, T]), attention_mask: new ort.Tensor('int64', BigInt64Array.from({ length: T }, () => 1n), [1, T]), position_ids: new ort.Tensor('int64', BigInt64Array.from({ length: T }, (_, i) => BigInt(i)), [1, T]) };
    for (let l = 0; l < 28; l++) for (const k of ['key', 'value']) feeds[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
    const sb = await ort.InferenceSession.create(bpath, { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
    const rb = await sb.run(feeds); await sb.release?.();
    const ss = await ort.InferenceSession.create(spath, { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
    const rs = await ss.run(feeds);
    const mb = names.filter((n) => !rb[n]), ms = names.filter((n) => !rs[n]); console.log('names', names.length, 'missing base', mb.length, mb.slice(0, 3), 'missing slot', ms.length, ms.slice(0, 3));
    // 逐目標比較
    let worst = 0, sum = 0, cnt = 0, worstName = ''; const rows = [];
    for (const t of targets) {
        const lname = t.name.replace('/model/', '');
        const parts = t.name.split('/'); const L = parts[2].split('.')[1], grp = parts[3], proj = parts[4];
        const A = AB.get(`lora.${L}.${proj}.A`), B = AB.get(`lora.${L}.${proj}.B`);
        // 同一次槽版執行內比較：x、基底輸出（y_base，槽版內的原輸出）與槽版輸出 y，避免上游層的旁支改變了啟動值
        const xT = rs[t.x], yB = rs[t.y + '_base'], yS = rs[t.y];
        const din = xT.dims[xT.dims.length - 1], dout = yB.dims[yB.dims.length - 1], R = 16;
        const X = xT.data, Yb = yB.data, Ys = yS.data, rows_ = X.length / din;
        let num = 0, den = 0;
        for (let r = 0; r < rows_; r++) {
            const h = new Float64Array(R); for (let k = 0; k < din; k++) { const x = X[r * din + k]; for (let q = 0; q < R; q++) h[q] += x * A[k * R + q]; }
            for (let j = 0; j < dout; j++) { let want = 0; for (let q = 0; q < R; q++) want += h[q] * B[q * dout + j]; const got = Ys[r * dout + j] - Yb[r * dout + j]; num += (got - want) ** 2; den += want * want; }
        }
        const e = Math.sqrt(num / Math.max(den, 1e-30)); sum += e; cnt++; if (e > worst) { worst = e; worstName = lname; }
        if (cnt <= 2) { // 診斷：旁支（槽版）與真值的方向與長度
            const gotv = [], wantv = []; for (let r = 0; r < Math.min(rows_, 4); r++) { const h = new Float64Array(R); for (let k = 0; k < din; k++) { const x = X[r * din + k]; for (let q = 0; q < R; q++) h[q] += x * A[k * R + q]; } for (let j = 0; j < dout; j++) { let want = 0; for (let q = 0; q < R; q++) want += h[q] * B[q * dout + j]; wantv.push(want); gotv.push(Ys[r * dout + j] - Yb[r * dout + j]); } }
            let dd = 0, g2 = 0, w2 = 0; for (let i = 0; i < gotv.length; i++) { dd += gotv[i] * wantv[i]; g2 += gotv[i] ** 2; w2 += wantv[i] ** 2; }
            console.log('DIAG', lname, 'cos', (dd / Math.sqrt(g2 * w2)).toFixed(4), 'normRatio', (Math.sqrt(g2 / w2)).toFixed(4), 'gotNorm', Math.sqrt(g2).toFixed(3), 'wantNorm', Math.sqrt(w2).toFixed(3), 'yBnorm', Math.sqrt(Yb.reduce((a, v) => a + v * v, 0) / Yb.length).toFixed(3));
        }
        rows.push({ t: lname, relErr: e, loraNorm: Math.sqrt(den) });
    }
    const rep = { targets: cnt, meanRelErr: sum / cnt, worstRelErr: worst, worstName, layoutTargets: res.targets };
    console.log(JSON.stringify(rep, null, 1));
    fs.writeFileSync(path.join(OUT, 'branch_rows.json'), JSON.stringify(rows));
})().catch((e) => { console.error(e); process.exit(1); });
