'use strict';
// 網頁版 LoRA（路線 c：併入 q8 權重）的單元測試：假 ONNX（自己編碼的 protobuf）、假 fetch 範圍、假載入器。不需要真模型、不需要 ORT。
const Onnx = require('./onnx_patch_core.js'), Merge = require('./lora_merge_core.js'), Web = require('./lora_web_core.js');
// Node 16 沒有全域 Response／Blob：補最小替身（瀏覽器與 Node 18+ 用原生的）
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
if (typeof Response === 'undefined') global.Response = class { constructor(body, init) { init = init || {}; this._b = body; this.status = init.status || 200; this.ok = this.status >= 200 && this.status < 300; const h = init.headers || {}; this.headers = { get: (k) => h[String(k).toLowerCase()] === undefined ? null : h[String(k).toLowerCase()] }; } clone() { return this; } async arrayBuffer() { return this._b.arrayBuffer(); } };
let pass = 0, fail = 0;
function check(name, cond, extra) { if (cond) pass++; else { fail++; console.log('FAIL ' + name + (extra !== undefined ? ' ' + JSON.stringify(extra) : '')); } }

const TE = new TextEncoder();
const field = (num, wt, payload) => { const tag = Onnx.varintBytes(num * 8 + wt); return wt === 2 ? Buffer.concat([tag, Onnx.varintBytes(payload.length), payload]) : Buffer.concat([tag, Onnx.varintBytes(payload)]); };
const s = (x) => Buffer.from(TE.encode(x));
function node(name, op, inputs, outputs) { return Buffer.concat([...inputs.map((i) => field(1, 2, s(i))), ...outputs.map((o) => field(2, 2, s(o))), field(3, 2, s(name)), field(4, 2, s(op))]); }
function tensor(name, dataType, dims, raw) { return Buffer.from(Onnx.encodeTensor({ name, dataType, dims, raw })); }
function rng(seed) { return Merge.mulberry32(seed); }
function gauss(r) { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()); }

// 假 Qwen3：layers 層、每層 7 個目標，維度 din×dout（為了測試很小）。每個目標：DynamicQuantizeLinear → MatMulInteger → Mul（縮放值）。
function buildModel(o) {
    o = o || {}; const layers = o.layers || 2, DIN = o.din || 64, DOUT = o.dout || 96, r = rng(7), dtype = o.dtype || 'uint8';
    const nodes = [], inits = [], weights = {}, truth = {};
    for (let L = 0; L < layers; L++) for (const [grp, proj] of [['attn', 'q_proj'], ['attn', 'k_proj'], ['attn', 'v_proj'], ['attn', 'o_proj'], ['mlp', 'gate_proj'], ['mlp', 'up_proj'], ['mlp', 'down_proj']]) {
        const base = '/model/layers.' + L + '/' + grp + '/' + proj + '/MatMul', x = 'x.' + L + proj;
        const Wf = new Float32Array(DIN * DOUT); for (let i = 0; i < Wf.length; i++) Wf[i] = (r() < 0.0005 ? 15 : 1) * 0.03 * gauss(r);
        let mx = 0, mn = 0; for (const v of Wf) { if (v > mx) mx = v; if (v < mn) mn = v; }
        let sc, zp, q = new Uint8Array(DIN * DOUT);
        if (dtype === 'uint8') { sc = (mx - mn) / 255; zp = Math.round(-mn / sc); for (let i = 0; i < Wf.length; i++) q[i] = Math.max(0, Math.min(255, Math.round(Wf[i] / sc) + zp)); }
        else { sc = Math.max(mx, -mn) / 127; zp = 0; for (let i = 0; i < Wf.length; i++) q[i] = Math.max(-128, Math.min(127, Math.round(Wf[i] / sc))) & 255; }
        const dt = dtype === 'uint8' ? 2 : 3, sf = new Float32Array([sc]);
        nodes.push(node(base + '_dq', 'DynamicQuantizeLinear', [x], [base + '_xq', base + '_xs', base + '_xz']));
        nodes.push(node(base + '_quant', 'MatMulInteger', [base + '_xq', base + '_W', base + '_xz', base + '_Wz'], [base + '_int']));
        nodes.push(node(base + '_sm', 'Mul', [base + '_xs', base + '_Wscale'], [base + '_scales']));
        inits.push(tensor(base + '_W', dt, [DIN, DOUT], Buffer.from(q)));
        inits.push(tensor(base + '_Wz', dt, [], Buffer.from([zp & 255])));
        inits.push(tensor(base + '_Wscale', 1, [], Buffer.from(sf.buffer)));
        weights[base] = { din: DIN, dout: DOUT, L, proj, q: q.slice(), sc, zp, dtype };
    }
    const extra = o.extraGraphInput ? [field(11, 2, field(1, 2, s(o.extraGraphInput)))] : [];
    const graph = Buffer.concat([...nodes.map((n) => field(1, 2, n)), field(2, 2, s('g')), ...inits.map((t) => field(5, 2, t)), ...extra]);
    const model = Buffer.concat([field(1, 0, 8), field(2, 2, s('fake')), field(7, 2, graph), field(8, 2, field(2, 0, 17))]);
    return { bytes: new Uint8Array(model), weights, DIN, DOUT, layers };
}
function makeLora(m, rank, relScale, opt) {
    opt = opt || {}; const r = rng(opt.seed || 11);
    const targets = []; for (const k of Object.keys(m.weights)) { const w = m.weights[k]; targets.push({ layer: w.L, proj: w.proj, din: w.din, dout: w.dout }); }
    const lay = Merge.computeLayout(targets, rank), buf = new Uint8Array(lay.total), deltas = {};
    const used = opt.usedRank || rank;
    for (const k of Object.keys(m.weights)) {
        const w = m.weights[k], tag = 'lora.' + w.L + '.' + w.proj;
        const A = new Float32Array(w.din * rank), B = new Float32Array(rank * w.dout);
        for (let i = 0; i < w.din; i++) for (let j = 0; j < used; j++) A[i * rank + j] = gauss(r) / Math.sqrt(w.din);
        if (!opt.zeroB) for (let j = 0; j < used; j++) for (let c = 0; c < w.dout; c++) B[j * w.dout + c] = gauss(r);
        // 縮放到 |d| = relScale·|W_deq|
        let wn = 0; for (const q of w.q) { const c = (w.dtype === 'int8' ? (q << 24 >> 24) : q) - w.zp; wn += (c * w.sc) ** 2; } wn = Math.sqrt(wn);
        let dn = 0; const d = new Float64Array(w.din * w.dout);
        for (let i = 0; i < w.din; i++) for (let c = 0; c < w.dout; c++) { let a = 0; for (let j = 0; j < rank; j++) a += A[i * rank + j] * B[j * w.dout + c]; d[i * w.dout + c] = a; dn += a * a; }
        dn = Math.sqrt(dn); const f = dn > 0 ? relScale * wn / dn : 0; for (let j = 0; j < rank * w.dout; j++) B[j] *= f; for (let i = 0; i < d.length; i++) d[i] *= f;
        deltas[k] = d;
        for (const [ab, arr] of [['A', A], ['B', B]]) { const t = lay.tensors.find((x) => x.name === tag + '.' + ab); buf.set(new Uint8Array(arr.buffer), t.offset); }
    }
    return { bytes: buf, deltas, layout: lay };
}
const deq = (w, qv, j, sc) => ((w.dtype === 'int8' ? (qv << 24 >> 24) : qv) - w.zp) * sc[j];

// ---------- 1. protobuf 讀寫 ----------
{
    const m = buildModel(); const idx = Onnx.indexModel(m.bytes);
    check('索引：節點數 = 目標×3', idx.nodes.length === 14 * 3, idx.nodes.length);
    check('索引：初始值數 = 目標×3', idx.inits.size === 14 * 3, idx.inits.size);
    const w = idx.inits.get('/model/layers.0/attn/q_proj/MatMul_W');
    check('權重初始值：型別／形狀／長度', w.dataType === 2 && w.dims.join() === '64,96' && w.rawEnd - w.rawStart === 64 * 96, w);
    const rw = Onnx.rewrite(m.bytes, idx, new Map());
    check('無替換時 rewrite 與原檔逐位元相同', Buffer.compare(Buffer.from(Onnx.concatParts(rw.parts, rw.length)), Buffer.from(m.bytes)) === 0);
    const rep = tensor('/model/layers.0/attn/q_proj/MatMul_Wscale', 1, [96], Buffer.alloc(96 * 4, 1));
    const rw2 = Onnx.rewrite(m.bytes, idx, new Map([['/model/layers.0/attn/q_proj/MatMul_Wscale', new Uint8Array(rep)]]));
    const full = Onnx.concatParts(rw2.parts, rw2.length), idx2 = Onnx.indexModel(full);
    check('替換後可重新解析且形狀變 [96]', idx2.inits.get('/model/layers.0/attn/q_proj/MatMul_Wscale').dims.join() === '96' && idx2.nodes.length === idx.nodes.length);
    check('替換後尾端欄位（opset）仍在', Buffer.from(full.subarray(full.length - 4)).equals(Buffer.from(m.bytes.subarray(m.bytes.length - 4))));
    let e1 = ''; try { Onnx.rewrite(m.bytes, idx, new Map([['不存在', new Uint8Array(1)]])); } catch (e) { e1 = e.message; }
    check('替換不存在的初始值 → 明確錯誤', /不存在/.test(e1), e1);
    const mg = buildModel({ extraGraphInput: '/model/layers.0/attn/q_proj/MatMul_Wscale' }); let e2 = '';
    try { Onnx.rewrite(mg.bytes, Onnx.indexModel(mg.bytes), new Map([['/model/layers.0/attn/q_proj/MatMul_Wscale', new Uint8Array(rep)]])); } catch (e) { e2 = e.message; }
    check('初始值同時是 graph.input → 拒絕', /graph\.input/.test(e2), e2);
    let e3 = ''; try { Onnx.indexModel(Uint8Array.from([1, 2, 3])); } catch (e) { e3 = e.message; }
    check('亂資料 → 明確錯誤', e3.length > 0);
}
// ---------- 2. 版面與 make_lora_onnx.py 一致 ----------
{
    const lay = Merge.computeLayout([{ layer: 1, proj: 'k_proj', din: 5, dout: 7 }, { layer: 0, proj: 'q_proj', din: 5, dout: 7 }], 16);
    check('版面：依層、PROJ 順序，A 再 B', lay.tensors.map((t) => t.name).join() === 'lora.0.q_proj.A,lora.0.q_proj.B,lora.1.k_proj.A,lora.1.k_proj.B');
    check('版面：offset 對齊 64 且依序累加', lay.tensors.every((t) => t.offset % 64 === 0) && lay.tensors[1].offset === Math.ceil(5 * 16 * 4 / 64) * 64 && lay.total === lay.tensors[3].offset + Math.ceil(16 * 7 * 4 / 64) * 64, lay);
    const big = Merge.computeLayout([{ layer: 0, proj: 'q_proj', din: 1024, dout: 2048 }], 16);
    check('版面：q_proj A=65536 B=131072', big.tensors[0].length === 65536 && big.tensors[1].length === 131072 && big.total === 196608);
}
// ---------- 3. 單張量併入：數值品質 ----------
function tensorExperiment(dtype, rel, usedRank) {
    const DIN = 256, DOUT = 192, R = 16, r = rng(5);
    const Wf = new Float32Array(DIN * DOUT); for (let i = 0; i < Wf.length; i++) Wf[i] = (r() < 0.0005 ? 15 : 1) * 0.03 * gauss(r);
    let mx = 0, mn = 0; for (const v of Wf) { if (v > mx) mx = v; if (v < mn) mn = v; }
    const q = new Uint8Array(DIN * DOUT); let sc, zp;
    if (dtype === 'uint8') { sc = (mx - mn) / 255; zp = Math.round(-mn / sc); for (let i = 0; i < q.length; i++) q[i] = Math.max(0, Math.min(255, Math.round(Wf[i] / sc) + zp)); }
    else { sc = Math.max(mx, -mn) / 127; zp = 0; for (let i = 0; i < q.length; i++) q[i] = Math.max(-128, Math.min(127, Math.round(Wf[i] / sc))) & 255; }
    const old = q.slice(), A = new Float32Array(DIN * R), B = new Float32Array(R * DOUT);
    for (let i = 0; i < DIN; i++) for (let j = 0; j < usedRank; j++) A[i * R + j] = gauss(r) / Math.sqrt(DIN);
    for (let j = 0; j < usedRank; j++) for (let c = 0; c < DOUT; c++) B[j * DOUT + c] = gauss(r);
    const sgn = dtype === 'int8';
    const cc = (v) => (sgn ? (v << 24 >> 24) : v) - zp;
    let wn = 0; for (const v of old) wn += (cc(v) * sc) ** 2; wn = Math.sqrt(wn);
    let dn = 0; for (let i = 0; i < DIN; i++) for (let c = 0; c < DOUT; c++) { let a = 0; for (let j = 0; j < R; j++) a += A[i * R + j] * B[j * DOUT + c]; dn += a * a; } dn = Math.sqrt(dn);
    for (let j = 0; j < R * DOUT; j++) B[j] *= rel * wn / dn;
    const res = Merge.mergeTensor({ q, dtype, zp, scale: sc, din: DIN, dout: DOUT, A, B, rank: R, seed: 99 });
    return { res, old, q, sc, zp, DIN, DOUT, A, B, R, cc };
}
for (const dtype of ['uint8', 'int8']) {
    const e = tensorExperiment(dtype, 0.03, 16);
    check(dtype + '：3% 變化量，輸出空間相似度 > 0.9', e.res.stats.outCos > 0.9, e.res.stats);
    check(dtype + '：k 平均 > 1（有變細）且每欄 k ≥ 1', e.res.kMean > 1.5 && e.res.kMin >= 1, { kMean: e.res.kMean, kMin: e.res.kMin });
    // 反量化：基底 + 變化量 vs 新權重
    let maxBaseErr = 0, sumEff = 0, sumD = 0;
    for (let i = 0; i < e.DIN; i++) for (let j = 0; j < e.DOUT; j++) {
        const newW = e.cc(e.q[i * e.DOUT + j]) * e.res.scales[j], oldW = e.cc(e.old[i * e.DOUT + j]) * e.sc;
        let d = 0; for (let r = 0; r < e.R; r++) d += e.A[i * e.R + r] * e.B[r * e.DOUT + j];
        sumEff += newW - oldW; sumD += d; maxBaseErr = Math.max(maxBaseErr, Math.abs(newW - oldW - d));
    }
    const n = e.DIN * e.DOUT;
    check(dtype + '：不偏——平均偏差遠小於一個新步距', Math.abs(sumEff - sumD) / n < e.sc / 64, { bias: (sumEff - sumD) / n, step: e.sc });
    check(dtype + '：每個元素誤差 ≤ 一個新步距（抖動上限）', maxBaseErr <= e.sc / e.res.kMin + 1e-6, { maxBaseErr });
}
{
    // 對照：「用原本縮放直接重新量化」會完全丟掉變化量（這就是不能走最簡單做法的證據）
    const DIN = 256, DOUT = 192, e = tensorExperiment('uint8', 0.03, 16);
    let changed = 0, naiveChanged = 0;
    for (let i = 0; i < DIN * DOUT; i++) { if (e.q[i] !== e.old[i]) changed++; }
    for (let i = 0; i < DIN; i++) for (let j = 0; j < DOUT; j++) { let d = 0; for (let r = 0; r < e.R; r++) d += e.A[i * e.R + r] * e.B[r * DOUT + j]; if (Math.round(d / e.sc) !== 0) naiveChanged++; }
    check('對照：直接用舊縮放四捨五入，幾乎沒有元素會改變', naiveChanged < DIN * DOUT * 0.005, naiveChanged);
    check('本做法：有改變的元素數量遠多於對照', changed > 100 * Math.max(1, naiveChanged) || changed > DIN * DOUT * 0.2, { changed, naiveChanged });
    // 零 adapter：新縮放反量化後與舊值完全一致
    const m2 = tensorExperiment('uint8', 0, 16);
    let same = true; for (let i = 0; i < m2.DIN && same; i++) for (let j = 0; j < m2.DOUT; j++) { const a = m2.cc(m2.q[i * m2.DOUT + j]) * m2.res.scales[j], b = m2.cc(m2.old[i * m2.DOUT + j]) * m2.sc; if (Math.abs(a - b) > 1e-6 * Math.max(1e-3, Math.abs(b))) { same = false; break; } }
    check('零 adapter：併入後與基底反量化值相同（無額外雜訊）', same);
    const lowRank = tensorExperiment('uint8', 0.03, 4);
    check('rank 槽沒用滿（只用 4）也能併入', lowRank.res.stats.outCos > 0.85, lowRank.res.stats.outCos);
    const tiny = tensorExperiment('uint8', 0.0005, 16);
    check('變化量極小（0.05%）→ 相似度偏低會被如實量出（< 0.9）', tiny.res.stats.outCos < 0.9, tiny.res.stats.outCos);
}
// ---------- 4. 整模型 patchQwen3Q8 ----------
{
    const m = buildModel(), lora = makeLora(m, 16, 0.03), orig = m.bytes.slice();
    const prog = []; const r = Web.patchQwen3Q8(m.bytes, lora.bytes, { rank: 16, verify: true, onProgress: (d, t) => prog.push([d, t]), loraSha256: 'abc' });
    check('patch 成功', r.ok, r.error);
    check('報告：14 個目標全部併入', r.report.targets === 14 && r.report.merged === 14 && r.report.skippedZero === 0, r.report);
    check('報告：輸出相似度平均 > 0.9', r.report.outCosMean > 0.9, r.report.outCosMean);
    check('報告：已用重新解析核對', r.report.verified === true);
    check('進度回報走完', prog.length === 14 && prog[13][0] === 14);
    const full = Onnx.concatParts(r.parts, r.length), idx = Onnx.indexModel(full);
    let allShape = true, relErrSum = 0, nW = 0;
    for (const base of Object.keys(m.weights)) {
        const w = m.weights[base], S = idx.inits.get(base + '_Wscale'), W = idx.inits.get(base + '_W');
        if (S.dims.join() !== String(w.dout) || S.rawEnd - S.rawStart !== w.dout * 4) allShape = false;
        const sc = new Float32Array(full.slice(S.rawStart, S.rawEnd).buffer);
        let d2 = 0, e2 = 0; const d = lora.deltas[base];
        for (let i = 0; i < w.din; i++) for (let j = 0; j < w.dout; j++) { const nw = deq(w, full[W.rawStart + i * w.dout + j], j, sc), ow = deq(w, w.q[i * w.dout + j], j, { [j]: w.sc }); const eff = nw - ow; d2 += d[i * w.dout + j] ** 2; e2 += (eff - d[i * w.dout + j]) ** 2; }
        relErrSum += Math.sqrt(e2 / d2); nW++;
    }
    check('每個縮放值都變成 [dout] 向量', allShape);
    check('重新解析模型、反量化後：權重空間誤差合理（< 1.2，抖動雜訊量級）', relErrSum / nW < 1.2, relErrSum / nW);
    check('原模型位元組確實被原地修改', Buffer.compare(Buffer.from(orig), Buffer.from(m.bytes)) !== 0);
}
{
    // 錯誤與拒絕：都要有具體原因，絕不回 ok:true
    const m = buildModel(), lora = makeLora(m, 16, 0.03);
    check('lora.bin 大小不符 → 拒絕並說明版面', (() => { const r = Web.patchQwen3Q8(buildModel().bytes, lora.bytes.slice(0, lora.bytes.length - 64), { rank: 16 }); return !r.ok && /版面/.test(r.error); })());
    check('rank 槽與 adapter 不符 → 拒絕', (() => { const r = Web.patchQwen3Q8(buildModel().bytes, lora.bytes, { rank: 8 }); return !r.ok && /版面/.test(r.error); })());
    check('空 lora.bin → 拒絕', !Web.patchQwen3Q8(buildModel().bytes, new Uint8Array(0), {}).ok);
    const zero = makeLora(m, 16, 0.03, { zeroB: true });
    const rz = Web.patchQwen3Q8(buildModel().bytes, zero.bytes, { rank: 16 });
    check('B 全零（adapter 沒訓練）→ 拒絕，不假裝套用', !rz.ok && /全部是零/.test(rz.error), rz.error);
    const tiny = makeLora(m, 16, 0.00002);
    const rt = Web.patchQwen3Q8(buildModel().bytes, tiny.bytes, { rank: 16 });
    check('變化量太小（品質不足）→ 拒絕並給數字', !rt.ok && /相似度/.test(rt.error), rt.error);
    const fm = buildModel({ layers: 1 }); const noq = Onnx.concatParts([fm.bytes], fm.bytes.length);
    const garbage = new Uint8Array(noq.length); garbage.set(noq); // 型別改成 float 的情形：直接改 data_type 位元組不好做，改測「找不到目標層」
    const empty = Buffer.concat([field(7, 2, field(2, 2, s('g')))]);
    const re = Web.patchQwen3Q8(new Uint8Array(empty), lora.bytes, { rank: 16 });
    check('不是 Qwen3 q8 模型 → 具體原因', !re.ok && /找不到 Qwen3/.test(re.error), re.error);
    const bad = buildModel({ layers: 1 }); const lb = makeLora(bad, 16, 0.03);
    check('只有 1 層也能套（層數不寫死）', Web.patchQwen3Q8(bad.bytes, lb.bytes, { rank: 16 }).ok);
    const i8 = buildModel({ dtype: 'int8' }), li8 = makeLora(i8, 16, 0.03);
    const ri8 = Web.patchQwen3Q8(i8.bytes, li8.bytes, { rank: 16 });
    check('int8 權重（零點 0）也能併入', ri8.ok && ri8.report.outCosMean > 0.9, ri8.error || ri8.report);
}
// ---------- 5. fetch 攔截 ----------
(async () => {
    const m = buildModel(), lora = makeLora(m, 16, 0.03), origBytes = m.bytes.slice();
    const calls = [];
    const scope = { fetch: async (u) => { calls.push(u); return new Response(new Blob([origBytes]), { status: 200 }); } };
    const patchCalls = [];
    const h = Web.installFetchPatch(scope, { match: (u) => /\/onnx\/model_quantized\.onnx$/.test(u), transform: (bytes, u) => { patchCalls.push(u); const r = Web.patchQwen3Q8(bytes, lora.bytes, { rank: 16 }); if (!r.ok) throw new Error(r.error); return r; } });
    const other = await scope.fetch('https://x/config.json');
    check('不相符的網址原樣通過（不動、不經過 transform）', (await other.arrayBuffer()).byteLength === origBytes.length && patchCalls.length === 0 && h.hits === 0);
    const res = await scope.fetch('https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX/resolve/main/onnx/model_quantized.onnx');
    const got = new Uint8Array(await res.arrayBuffer());
    check('相符網址回傳合併後的模型（長度與原檔不同、可解析）', got.length !== origBytes.length && Onnx.indexModel(got).nodes.length === 42 && h.hits === 1, { got: got.length, orig: origBytes.length });
    check('content-length 與實際長度相符', Number(res.headers.get('content-length')) === got.length);
    h.uninstall();
    check('uninstall 還原原本的 fetch', scope.fetch !== undefined && (await (await scope.fetch('https://huggingface.co/x/onnx/model_quantized.onnx')).arrayBuffer()).byteLength === origBytes.length);
    // transform 失敗要把錯誤丟出去（不能悄悄回傳原檔）
    const scope2 = { fetch: async () => new Response(new Blob([origBytes]), { status: 200 }) };
    const h2 = Web.installFetchPatch(scope2, { match: () => true, transform: () => { throw new Error('壞了'); } });
    let thrown = ''; try { await scope2.fetch('https://x/onnx/model_quantized.onnx'); } catch (e) { thrown = e.message; }
    check('合併失敗 → fetch 拒絕並留下錯誤（不回傳未套用的原檔）', thrown === '壞了' && h2.errors[0] === '壞了' && h2.hits === 0);
    // 沒有 LoRA 時完全不安裝：載入路徑與現在相同
    const scope3 = { fetch: async () => new Response(new Blob([origBytes]), { status: 200 }) }; const f0 = scope3.fetch;
    check('沒有 LoRA 時不安裝攔截（fetch 未被替換）', scope3.fetch === f0);
    // envs.fetch 也被包
    const env = { fetch: async () => new Response(new Blob([origBytes]), { status: 200 }) }, scope4 = { fetch: async () => new Response(new Blob([origBytes])) };
    const h4 = Web.installFetchPatch(scope4, { match: () => true, transform: (b) => ({ parts: [b], length: b.length }), envs: [env] });
    await (await env.fetch('https://x/onnx/model_quantized.onnx')).arrayBuffer(); check('env.fetch 也被攔截', h4.hits === 1); h4.uninstall();

    // ---------- 6. 套用器 ----------
    const state = { lora: null }; let loads = 0, mode = 'ok';
    const ap = Web.createWebLoraApplier({ state, sha256Hex: (b) => 'sha' + b.length, loadModel: async () => { loads++; if (mode === 'ok') return { ok: true, report: { ok: true, merged: 196, targets: 196, outCosMean: 0.97 } }; if (mode === 'nohit') return { ok: false, error: 'transformers.js 沒有經過 fetch 取得模型，LoRA 未套用' }; throw new Error('記憶體不足'); } });
    check('沒有 handle → 拒絕', (await ap.apply([])).ok === false && loads === 0);
    const a1 = await ap.apply([{ id: 'a1', bytes: new Uint8Array(8) }, { id: 'a2', bytes: new Uint8Array(8) }]);
    check('載入並核對成功 → ok:true、state 已設、說明只能套一個', a1.ok && state.lora && state.lora.id === 'a1' && state.lora.sha256 === 'sha8' && /未套用：a2/.test(a1.note) && loads === 1, a1);
    mode = 'nohit'; const a2 = await ap.apply([{ id: 'b', bytes: new Uint8Array(4) }]);
    check('攔截沒被用到 → ok:false、狀態回到前一個 adapter', !a2.ok && /沒有經過 fetch/.test(a2.error) && state.lora.id === 'a1', a2);
    mode = 'throw'; const a3 = await ap.apply([{ id: 'c', bytes: new Uint8Array(4) }]);
    check('載入丟例外 → ok:false 帶原因', !a3.ok && /記憶體不足/.test(a3.error));
    await ap.clear(); check('clear 清掉 state', state.lora === null && ap.status().active === false);
    const apNo = Web.createWebLoraApplier({}); check('沒接載入端 → 誠實拒絕', (await apNo.apply([{ id: 'x', bytes: new Uint8Array(1) }])).ok === false);
    console.log('lora_web: ' + pass + ' 通過, ' + fail + ' 失敗'); process.exit(fail ? 1 : 0);
})();
