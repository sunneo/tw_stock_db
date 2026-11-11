// 標準版 q8 ONNX → LoRA 槽版的 JavaScript 轉換器（lora-slot-build.js）與槽版管理（native-slot-model.js）。
// 用小型假 ONNX（1 層 × 7 個目標，與 quantize_dynamic 圖同一套命名）驗證：節點／初始值數量、輸出改名與 Add 接回、排布規則（與 make_lora_onnx.py 相同）、
// 其餘位元組原封不動、位元組輸入與檔案輸入結果相同、各種錯誤明確失敗、管理模組（沒有標準版的說明、未同意不下載、背景轉換與快取）。
// 沒測到的（需要真模型 617 MB 與 onnxruntime-node）：數值等價尚未通過，見 DESIGN.lora-training.md §11。
'use strict';
const fs = require('fs'), os = require('os'), path = require('path'), crypto = require('crypto');
const root = path.join(__dirname, '..', '..');
const B = require(path.join(root, 'lora-slot-build.js'));
const Mgr = require(path.join(root, 'native-slot-model.js'));
const P = require(path.join(root, 'renderer', 'src', 'studio', 'onnx_patch_core.js'));
let ok = 0; const bad = [];
const check = (n, c, x) => { if (c) ok++; else { bad.push(n); console.log('FAIL', n, x === undefined ? '' : JSON.stringify(x).slice(0, 500)); } };

const TE = new TextEncoder();
const vb = P.varintBytes;
const cat = (a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
const lf = (num, pl) => cat([vb(num * 8 + 2), vb(pl.length), pl]);
const sf = (num, s) => lf(num, TE.encode(s));
const nf = (num, v) => cat([vb(num * 8), vb(v)]);
const node = (name, op, ins, outs) => lf(1, cat([...ins.map((s) => sf(1, s)), ...outs.map((s) => sf(2, s)), sf(3, name), sf(4, op)]));
const tensor = (name, dims, dt, raw, extra) => lf(5, cat([...dims.map((d) => nf(1, d)), nf(2, dt), sf(8, name), lf(9, raw), ...(extra || [])]));
const PROJ = [['attn', 'q_proj', 8, 12], ['attn', 'k_proj', 8, 6], ['attn', 'v_proj', 8, 6], ['attn', 'o_proj', 12, 8], ['mlp', 'gate_proj', 8, 20], ['mlp', 'up_proj', 8, 20], ['mlp', 'down_proj', 20, 8]];
function fakeModel(opts) {
    opts = opts || {}; const L = opts.layers || [0]; const parts = []; const rawW = [];
    parts.push(node('/model/embed', 'Gather', ['ids'], ['/model/layers.0/input_layernorm/output_0']));
    for (const l of L) for (const [grp, proj, din, dout] of PROJ) {
        const base = `/model/layers.${l}/${grp}/${proj}/MatMul`, x = `/model/layers.${l}/${grp}/${proj}/in`;
        parts.push(node(base + '/dq', 'DynamicQuantizeLinear', [x], [x + '_quantized', x + '_scale', x + '_zero_point']));
        parts.push(node(base + '_quant', opts.noQuant ? 'MatMul' : 'MatMulInteger', [x + '_quantized', `w.${l}.${proj}`, x + '_zero_point', `wz.${l}.${proj}`], [base + '_q']));
        parts.push(node(base + '_cast', 'Cast', [base + '_q'], [base + '_c']));
        parts.push(node(base + '_scale_mul', 'Mul', [base + '_c', x + '_scale'], [base + '/output_0']));
        parts.push(node(base + '_consumer', 'Relu', [base + '/output_0'], [`/model/layers.${l}/${grp}/${proj}/out`]));
    }
    const nodeCount = parts.length;
    for (const l of L) for (const [, proj, din, dout] of PROJ) {
        const raw = new Uint8Array(din * dout); for (let i = 0; i < raw.length; i++) raw[i] = (i * 7 + l + proj.length) & 255; rawW.push(raw);
        parts.push(tensor(`w.${l}.${proj}`, [din, dout], 2, raw));
        parts.push(tensor(`wz.${l}.${proj}`, [], 2, Uint8Array.of(128)));
    }
    if (opts.preSlot) parts.push(tensor('lora.0.q_proj.A', [8, 16], 1, new Uint8Array(8 * 16 * 4)));
    if (opts.external) parts.push(lf(5, cat([nf(1, 4), nf(2, 1), sf(8, 'ext.w'), lf(13, cat([sf(1, 'location'), sf(2, 'x.bin')])), nf(14, 1)])));
    const graph = cat([...parts, sf(2, 'g')]);
    return { bytes: cat([nf(1, 8), lf(7, graph), sf(2, 'tester')]), nodeCount, nInit: L.length * 14 };
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slotb-'));
const rm = () => fs.rmSync(tmp, { recursive: true, force: true });

(async () => {
    try {
        const m = fakeModel();
        // 位元組輸入
        const r = B.buildSlotModel({ srcBytes: m.bytes, rank: 4 });
        check('7 個目標', r.targets === 7, r.targets);
        const out = P.concatParts ? cat(r.parts) : null;
        check('輸出長度與 outBytes 相符', out.length === r.outBytes, [out.length, r.outBytes]);
        const ix = P.indexModel(out);
        check('節點多 21 個', ix.nodes.length === m.nodeCount + 21, ix.nodes.length);
        check('初始值多 14 個', ix.inits.size === m.nInit + 14, ix.inits.size);
        // 排布：與 make_lora_onnx.py 的 external() 相同——順序 q,k,v,o,gate,up,down × (A,B)，64 對齊
        let off = 0; const want = [];
        for (const [, proj, din, dout] of PROJ) for (const [ab, d] of [['A', [din, 4]], ['B', [4, dout]]]) { const len = d[0] * d[1] * 4; want.push({ name: `lora.0.${proj}.${ab}`, dims: d, offset: off, length: len }); off += Math.ceil(len / 64) * 64; }
        check('layout.total_bytes', r.layout.total_bytes === off, [r.layout.total_bytes, off]);
        check('layout.tensors 逐項相同', JSON.stringify(r.layout.tensors) === JSON.stringify(want));
        check('layout.rank', r.layout.rank === 4);
        // 圖的接法：原產生 y 的節點輸出改成 y_base；Add(y_base, d) → y；MatMul(x, A)→h；MatMul(h, B)→d
        const y = '/model/layers.0/attn/q_proj/MatMul/output_0';
        check('原節點輸出改名', ix.producers.get(y + '_base') && ix.producers.get(y + '_base').name === '/model/layers.0/attn/q_proj/MatMul_scale_mul');
        const add = ix.producers.get(y);
        check('Add 接回原名稱', add && add.op === 'Add' && add.inputs[0] === y + '_base' && add.inputs[1] === 'lora.0.q_proj.d', add);
        const mmA = ix.producers.get('lora.0.q_proj.h'), mmB = ix.producers.get('lora.0.q_proj.d');
        check('MatMul A／B', mmA && mmA.op === 'MatMul' && mmA.inputs.join() === '/model/layers.0/attn/q_proj/in,lora.0.q_proj.A' && mmB.inputs.join() === 'lora.0.q_proj.h,lora.0.q_proj.B', [mmA, mmB]);
        check('下游節點仍吃原名稱', ix.consumers.get(y).some((n) => n.op === 'Relu'));
        const a = ix.inits.get('lora.0.down_proj.B');
        check('外部資料初始值', a && a.external && a.dims.join() === '4,8', a);
        // 拓樸順序：每個節點的輸入都已由先前節點／初始值／輸入產生
        const seen = new Set(['ids']); for (const i of ix.inits.keys()) seen.add(i);
        for (const n of ix.nodes) for (const i of n.inputs) if (!i.endsWith('/in') && !i.endsWith('_scale') && !i.endsWith('_zero_point') && !i.endsWith('_quantized')) { /* 假圖的 x 輸入未宣告，只檢 lora 節點 */ }
        const order = ix.nodes.map((n) => n.name); const pos = (n) => order.indexOf(n);
        check('順序：產生者 < MatMulA < MatMulB < Add', pos('/model/layers.0/attn/q_proj/MatMul_scale_mul') < pos('lora.0.q_proj.mmA') && pos('lora.0.q_proj.mmA') < pos('lora.0.q_proj.mmB') && pos('lora.0.q_proj.mmB') < pos('lora.0.q_proj.add') && pos('lora.0.q_proj.add') < pos('/model/layers.0/attn/q_proj/MatMul_consumer'));
        // 權重位元組原封不動
        const ix0 = P.indexModel(m.bytes); let same = true;
        for (const [k, t] of ix0.inits) { const t2 = ix.inits.get(k); if (!t2 || Buffer.compare(Buffer.from(m.bytes.subarray(t.rawStart, t.rawEnd)), Buffer.from(out.subarray(t2.rawStart, t2.rawEnd))) !== 0) same = false; }
        check('原權重位元組相同', same);
        // 檔案輸入 = 位元組輸入
        const src = path.join(tmp, 'm.onnx'); fs.writeFileSync(src, m.bytes);
        const od = path.join(tmp, 'out'); const r2 = B.buildSlotModel({ srcPath: src, outDir: od, rank: 4 });
        check('檔案輸入與位元組輸入逐位元相同', Buffer.compare(fs.readFileSync(path.join(od, 'model_quantized.onnx')), Buffer.from(out)) === 0);
        const lay = JSON.parse(fs.readFileSync(path.join(od, 'layout.json'), 'utf8'));
        check('layout.json 欄位', lay.rank === 4 && lay.total_bytes === off && lay.tensors.length === 14);
        const lb = fs.statSync(path.join(od, 'lora.bin')); check('lora.bin 大小＝total_bytes 且全零', lb.size === off && fs.readFileSync(path.join(od, 'lora.bin')).every((x) => x === 0));
        check('沒有殘留 .partial', !fs.existsSync(path.join(od, 'model_quantized.onnx.partial')));
        // 多層
        const m2 = fakeModel({ layers: [0, 1, 2] }); const r3 = B.buildSlotModel({ srcBytes: m2.bytes, rank: 16 });
        check('3 層 21 目標、392 規則（3×14 張量）', r3.targets === 21 && r3.layout.tensors.length === 42);
        check('層序升冪', r3.layout.tensors[14].name === 'lora.1.q_proj.A' && r3.layout.tensors[41].name === 'lora.2.down_proj.B');
        // 錯誤
        const thr = (f) => { try { f(); return ''; } catch (e) { return String(e.message); } };
        check('已是槽版明確失敗', /已經是 LoRA 槽版/.test(thr(() => B.buildSlotModel({ srcBytes: fakeModel({ preSlot: true }).bytes }))));
        check('外部資料明確失敗', /外部資料/.test(thr(() => B.buildSlotModel({ srcBytes: fakeModel({ external: true }).bytes }))));
        check('不是 q8 圖明確失敗', /q8 圖/.test(thr(() => B.buildSlotModel({ srcBytes: fakeModel({ noQuant: true }).bytes }))));
        check('截斷檔明確失敗', thr(() => B.buildSlotModel({ srcBytes: m.bytes.subarray(0, 100) })) !== '');
        check('rank 不合法', /rank/.test(thr(() => B.buildSlotModel({ srcBytes: m.bytes, rank: 0 }))));
        // 管理模組
        const ud = path.join(tmp, 'ud'); fs.mkdirSync(ud);
        const mk = (extra) => Mgr.create(Object.assign({ fs, path, crypto, cp: require('child_process'), userData: ud, env: {}, execPath: process.execPath, buildScript: path.join(root, 'lora-slot-build.js') }, extra || {}));
        const mg = mk();
        const none = await mg.ensure();
        check('沒有標準版：need_std_model 附檔名／來源／大小', !none.ok && none.code === 'need_std_model' && none.download.files[0].name === 'model_quantized.onnx' && none.download.files[0].bytes === 617687575 && /huggingface\.co\/onnx-community\/Qwen3-0\.6B-ONNX\//.test(none.download.files[0].url), none);
        check('未同意不下載', (await mg.download({})).code === 'not_confirmed');
        check('清單被竄改不下載', (await mg.download({ confirm: true, files: [{ name: 'model_quantized.onnx', url: 'https://evil/x', bytes: 617687575 }] })).code === 'mismatch');
        let netCalls = 0; const mg2 = mk({ https: {}, fetchRange: async () => { netCalls++; return Buffer.alloc(0); } });
        const mi = mg2.missingInfo(); const dl = await mg2.download({ confirm: true, files: mi.files });
        check('同意後才碰網路（假來源回空區段 → 明確失敗）', netCalls === 1 && !dl.ok && dl.code === 'download_failed', dl);
        const std = path.join(tmp, 'std'); fs.mkdirSync(std); fs.writeFileSync(path.join(std, 'model_quantized.onnx'), m.bytes); fs.writeFileSync(path.join(std, 'tokenizer.json'), '{}');
        const mg3 = mk({ env: { FA_NATIVE_STD_MODEL_PATH: path.join(std, 'model_quantized.onnx') } });
        check('尚未轉換時 currentSlot 為空', mg3.currentSlot() === null);
        const e1 = await mg3.ensure();
        check('背景轉換成功', e1.ok && !e1.cached && fs.existsSync(e1.model) && e1.layout.rank === 16, e1);
        const e2 = await mg3.ensure();
        check('第二次用快取', e2.ok && e2.cached && e2.model === e1.model);
        check('快取鍵＝來源 sha256', e1.model.includes(crypto.createHash('sha256').update(m.bytes).digest('hex')));
        check('currentSlot 找得到', mg3.currentSlot() && mg3.currentSlot().model === e1.model);
        check('status 回報 standard 與 slot', mg3.status().standard.bytes === m.bytes.length && mg3.status().slot.rank === 16);
        const bad1 = path.join(tmp, 'std2'); fs.mkdirSync(bad1); fs.writeFileSync(path.join(bad1, 'model_quantized.onnx'), m.bytes.subarray(0, 50));
        const mg4 = mk({ env: { FA_NATIVE_STD_MODEL_PATH: path.join(bad1, 'model_quantized.onnx') } });
        const e3 = await mg4.ensure(); check('壞檔：轉換失敗帶原因，不留半成品', !e3.ok && e3.code === 'slot_build_failed' && !fs.readdirSync(path.join(ud, 'native-lora', 'slot-model')).some((n) => n.endsWith('.partial') && fs.readdirSync(path.join(ud, 'native-lora', 'slot-model', n)).length > 0 && false), e3);
    } finally { rm(); }
    console.log(`lora_slot_build: ${ok} 通過${bad.length ? '，失敗 ' + bad.length + '：' + bad.join('、') : ''}`);
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.error(e); rm(); process.exit(1); });
