'use strict';
// 真模型啟動值統計（診斷）：量化前的啟動值（DynamicQuantizeLinear 的輸入）有沒有離群值？對隨機 LoRA 項（rank 16），量化造成的相對誤差多大？
// 做法：在標準版 ONNX 的 graph 尾端加上這些啟動值為圖輸出，跑一次 forward，統計。
// 用法：node scripts/eval/lora_activation_probe.js <標準版 onnx> <ids.json> <OUT>
'use strict';
// 真模型：量化前的啟動值（DynamicQuantizeLinear 的輸入）是否有離群值？對隨機 LoRA 項，量化造成的相對誤差多大？
// 做法：在標準版 ONNX 的 graph 尾端加上「這些啟動值」為圖輸出（ORT 允許中間張量當輸出），跑一次 forward，統計。
const fs = require('fs'), path = require('path');
const RT = process.env.NR_RUNTIME || path.join(require('os').homedir(), '.config', 'floating-assistant-desktop', 'native-runtime', '1.22.0-1');
const ort = require(path.join(RT, 'node_modules', 'onnxruntime-node'));
const SRC = process.argv[2], IDS = process.argv[3], OUT = process.argv[4];
if (!SRC || !IDS || !OUT) { console.error('用法：node lora_activation_probe.js <標準版 onnx> <ids.json> <OUT>'); process.exit(2); }
const buf = fs.readFileSync(SRC);
function rv(p) { let v = 0, m = 1; for (;;) { const c = buf[p++]; v += (c & 0x7f) * m; m *= 128; if (!(c & 0x80)) return [v, p]; } }
const top = []; let p = 0;
while (p < buf.length) {
    const ts = p; let tag; [tag, p] = rv(p); const num = Math.floor(tag / 8), wt = tag % 8;
    if (wt === 0) { [, p] = rv(p); top.push({ num, ts, s: p, e: p }); }
    else if (wt === 2) { let len; [len, p] = rv(p); top.push({ num, ts, s: p, e: p + len }); p += len; }
    else if (wt === 1) { p += 8; top.push({ num, ts, s: p, e: p }); } else if (wt === 5) { p += 4; top.push({ num, ts, s: p, e: p }); }
}
const g = top.find((f) => f.num === 7);
// 收集目標的啟動值名稱（MatMulInteger 第 0 個輸入去掉 _quantized）
const gb = buf.subarray(g.s, g.e);
// 簡單掃描：節點本體內的字串；只取 MatMulInteger 的第一個輸入
const xs = new Set();
{
    // 用 onnx_patch_core（repo）解析節點較可靠
    const Onnx = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'studio', 'onnx_patch_core.js'));
    const idx = Onnx.indexModel(buf);
    for (const n of idx.nodes) if (n.op === 'MatMulInteger' && /\/model\/layers\.\d+\/(attn|mlp)\/\w+\/MatMul_quant$/.test(n.name)) xs.add(n.inputs[0].replace(/_quantized$/, ''));
}
const list = [...xs].sort();
console.log('啟動值數量', list.length, list.slice(0, 3));
// 每個輸出：name + 型別 float（無 shape）
const TE = new TextEncoder();
const vb = (v) => { const o = []; while (v >= 128) { o.push((v % 128) | 0x80); v = Math.floor(v / 128); } o.push(v); return Uint8Array.from(o); };
const cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let q = 0; for (const x of a) { o.set(x, q); q += x.length; } return o; };
const lf = (n, pl) => cat([vb(n * 8 + 2), vb(pl.length), pl]);
const sf = (n, s) => lf(n, TE.encode(s));
const nf = (n, v) => cat([vb(n * 8), vb(v)]);
const outs = list.map((nm) => lf(12, cat([sf(1, nm), lf(2, lf(1, nf(1, 1)))])));
const newG = cat([gb, ...outs]);
const newTop = cat([buf.subarray(0, g.ts), vb(7 * 8 + 2), vb(newG.length), newG, buf.subarray(g.e)]);
fs.mkdirSync(OUT, { recursive: true }); const mp = path.join(OUT, 'probe.onnx'); fs.writeFileSync(mp, newTop);
(async () => {
    const ids = JSON.parse(fs.readFileSync(IDS, 'utf8')); const T = ids.length;
    const s = await ort.InferenceSession.create(mp, { executionProviders: ['cpu'], graphOptimizationLevel: 'disabled' });
    const feeds = { input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, T]), attention_mask: new ort.Tensor('int64', BigInt64Array.from({ length: T }, () => 1n), [1, T]), position_ids: new ort.Tensor('int64', BigInt64Array.from({ length: T }, (_, i) => BigInt(i)), [1, T]) };
    for (let l = 0; l < 28; l++) for (const k of ['key', 'value']) feeds[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, 8, 0, 128]);
    const r = await s.run(feeds); // 不傳名稱清單：傳了清單時 ORT 只回傳預設輸出
    // 統計：離群比、量化相對誤差（隨機 A、B，rank 16）
    let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return (seed + 0.5) / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
    const rows = []; const missing = list.filter((nm) => !r[nm]); console.log('keys', Object.keys(r).length, 'missing', missing.length, missing.slice(0, 4));
    for (const nm of list) {
        const t = r[nm]; if (!t) continue; const d = t.dims; const din = d[d.length - 1]; const X = Float32Array.from(t.data);
        const rowsN = X.length / din;
        let mx = 0; const absv = []; for (const v of X) { const a = Math.abs(v); absv.push(a); if (a > mx) mx = a; }
        absv.sort((a, b) => a - b); const med = absv[absv.length >> 1];
        // DQL 語意（整個張量一個縮放）
        let lo = 0, hi = 0; for (const v of X) { if (v < lo) lo = v; if (v > hi) hi = v; }
        const sc = (hi - lo) / 255, zp = Math.round(-lo / sc);
        const Xq = Float32Array.from(X, (v) => (Math.max(0, Math.min(255, Math.round(v / sc) + zp)) - zp) * sc);
        const R = 16; const A = Float32Array.from({ length: din * R }, () => gauss()), B = Float32Array.from({ length: R * 64 }, () => gauss());
        // 只看前 64 個輸出欄（代表性），每個 token 一列
        const dout = 64; let num = 0, den = 0;
        for (let row = 0; row < rowsN; row++) {
            const h = new Float64Array(R), hq = new Float64Array(R);
            for (let k = 0; k < din; k++) { const x = X[row * din + k], xq = Xq[row * din + k]; for (let q = 0; q < R; q++) { h[q] += x * A[k * R + q]; hq[q] += xq * A[k * R + q]; } }
            for (let j = 0; j < dout; j++) { let y = 0, yq = 0; for (let q = 0; q < R; q++) { y += h[q] * B[q * dout + j]; yq += hq[q] * B[q * dout + j]; } num += (yq - y) ** 2; den += y * y; }
        }
        rows.push({ name: nm.replace('/model/', ''), din, max: +mx.toFixed(2), median: +med.toFixed(4), ratio: +(mx / med).toFixed(0), loraRelErrQuant: +Math.sqrt(num / den).toFixed(4) });
    }
    console.table(rows.slice(0, 12)); console.table(rows.slice(-6));
    const avg = rows.reduce((a, x) => a + x.loraRelErrQuant, 0) / rows.length; const mxE = Math.max(...rows.map((x) => x.loraRelErrQuant));
    console.log(JSON.stringify({ count: rows.length, meanLoraRelErrQuant: +avg.toFixed(4), maxLoraRelErrQuant: +mxE.toFixed(4) }));
    fs.writeFileSync(path.join(OUT, 'probe_rows.json'), JSON.stringify(rows));
})().catch((e) => { console.error(e); process.exit(1); });
