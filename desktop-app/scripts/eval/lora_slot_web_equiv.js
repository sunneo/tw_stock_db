'use strict';
// 真模型三方比較（診斷）：base（標準版）、slot（槽版，fp32 旁支，正式轉換器）、slotdq（旁支吃反量化後的啟動值，builder 選項 dqLoraInput）、web（網頁版併權重，lora_web_core）。
// 報告：首步 logits 餘弦、各方式 LoRA 增量對槽版增量的相對誤差、前 N 步貪婪 token。
// 注意：端到端 logits 會受動態量化的離散跳動影響（小改動也會讓下游量化值跳一格），所以這裡的數字是診斷用，不是通過／不通過的判準；判準見 lora_slot_branch_check.js。
// 用法：node scripts/eval/lora_slot_web_equiv.js <標準版 onnx> <random:種子:B[:A]|lora.bin> <ids.json> <steps> <OUT>
'use strict';
// 真模型三方比較：base、slot（fp32 旁支，正式版）、slotdq（旁支吃反量化後的輸入，驗證用變體）、web（併權重）
// 用法：node three_way.js <標準版 onnx> <random:種子:B幅度[:A幅度]> <ids.json> <steps> <OUT>
const fs = require('fs'), path = require('path');
const RT = process.env.NR_RUNTIME || path.join(require('os').homedir(), '.config', 'floating-assistant-desktop', 'native-runtime', '1.22.0-1');
const ort = require(path.join(RT, 'node_modules', 'onnxruntime-node'));
const R = path.join(__dirname, '..', '..');
const Build = require(path.join(R, 'lora-slot-build.js'));
const BuildDq = { buildSlotModel: (o) => Build.buildSlotModel({ ...o, dqLoraInput: true }) };
const Web = require(path.join(R, 'renderer/src/studio/lora_web_core.js'));
const [stdPath, spec, idsPath, stepsArg, OUT] = process.argv.slice(2);
const steps = Number(stepsArg), RANK = 16, LAYERS = 28, KV = 8, HD = 128;
const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });
let seedR = 1; const rnd = () => { seedR = (seedR * 1103515245 + 12345) >>> 0; return (seedR + 0.5) / 4294967296; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
const [, sd, bs, as] = spec.split(':'); seedR = Number(sd);
function randomAdapter(layout) { const out = new Uint8Array(layout.total_bytes); for (const t of layout.tensors) { const n = t.dims[0] * t.dims[1]; const f = new Float32Array(n); const sc = t.name.endsWith('.A') ? Number(as || 1) : Number(bs); for (let i = 0; i < n; i++) f[i] = sc * gauss(); out.set(new Uint8Array(f.buffer), t.offset); } return out; }
async function generate(modelPath) {
    const s = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    let past = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
    const toks = []; let plen = 0, nxt = null, first = null;
    for (let i = 0; i < steps; i++) {
        const q = i === 0 ? ids : [nxt], L = plen + q.length;
        const feeds = { ...past, input_ids: new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]), attention_mask: new ort.Tensor('int64', BigInt64Array.from({ length: L }, () => 1n), [1, L]), position_ids: new ort.Tensor('int64', BigInt64Array.from(q.map((_, j) => BigInt(plen + j))), [1, q.length]) };
        const r = await s.run(feeds);
        const V = r.logits.dims[2]; const lg = Float32Array.from(r.logits.data.slice((q.length - 1) * V, q.length * V));
        if (i === 0) first = lg;
        let best = 0; for (let j = 1; j < V; j++) if (lg[j] > lg[best]) best = j;
        nxt = best; toks.push(best); plen = L;
        past = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = r[`present.${l}.${k}`];
    }
    await s.release();
    return { first, toks };
}
const cos = (x, y) => { let d = 0, a = 0, b = 0; for (let j = 0; j < x.length; j++) { d += x[j] * y[j]; a += x[j] * x[j]; b += y[j] * y[j]; } return d / Math.sqrt(a * b); };
const sub = (x, y) => Float32Array.from(x, (v, j) => v - y[j]);
const nrm = (x) => Math.sqrt(x.reduce((a, v) => a + v * v, 0));
(async () => {
    const base = await generate(stdPath);
    // 槽版（fp32）與 slotdq（變體）：同一份 adapter
    const sdir = path.join(OUT, 'slot'); const res = Build.buildSlotModel({ srcPath: stdPath, outDir: sdir, rank: RANK });
    const lora = randomAdapter(res.layout); fs.writeFileSync(path.join(sdir, 'lora.bin'), lora);
    const slot = await generate(path.join(sdir, 'model_quantized.onnx'));
    const ddir = path.join(OUT, 'slotdq'); fs.mkdirSync(ddir, { recursive: true });
    BuildDq.buildSlotModel({ srcPath: stdPath, outDir: ddir, rank: RANK }); fs.writeFileSync(path.join(ddir, 'lora.bin'), lora);
    const slotdq = await generate(path.join(ddir, 'model_quantized.onnx'));
    // 網頁版
    const pr = Web.patchQwen3Q8(Uint8Array.from(fs.readFileSync(stdPath)), lora, { rank: RANK, minCos: 0, loraSha256: 'three' });
    if (!pr.ok) { console.error('web skipped:', pr.error); }
    const wdir = path.join(OUT, 'web'); fs.mkdirSync(wdir, { recursive: true });
    if (pr.ok) { fs.writeFileSync(path.join(wdir, 'model_quantized.onnx'), Buffer.concat(pr.parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)))); fs.writeFileSync(path.join(wdir, 'lora.bin'), lora); }
    const web = pr.ok ? await generate(path.join(wdir, 'model_quantized.onnx')) : slot;
    const dS = sub(slot.first, base.first), dD = sub(slotdq.first, base.first), dW = sub(web.first, base.first);
    const rep = {
        baseVsSlotDeltaNorm: +nrm(dS).toFixed(3), baseLogitNorm: +nrm(base.first).toFixed(1),
        slotVsSlotdq_cos: +cos(slot.first, slotdq.first).toFixed(6), slotdqVsWeb_cos: +cos(slotdq.first, web.first).toFixed(6), slotVsWeb_cos: +cos(slot.first, web.first).toFixed(6),
        deltaRelErr_slotdqVsSlot: +(nrm(sub(dD, dS)) / nrm(dS)).toFixed(4), deltaRelErr_webVsSlot: +(nrm(sub(dW, dS)) / nrm(dS)).toFixed(4), deltaRelErr_webVsSlotdq: +(nrm(sub(dW, dD)) / nrm(dD)).toFixed(4),
        tokens: { base: base.toks, slot: slot.toks, slotdq: slotdq.toks, web: web.toks },
        webClipped: pr.report && pr.report.clipped, webOutCosMean: pr.report && +pr.report.outCosMean.toFixed(4),
    };
    console.log(JSON.stringify(rep, null, 1));
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(rep, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
