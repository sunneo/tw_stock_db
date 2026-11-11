'use strict';
// 真模型驗證腳本（草稿，尚未在真檔上執行）：比較「網頁版併權重」與「槽版（fp32 旁支）」
// 用法：FA_ROOT=<desktop-app> OUT=<輸出資料夾> node real_equiv.js <標準版 model_quantized.onnx> <lora.bin> <prompt_ids.json> [steps=8] [rank=16]
// 尚未在真模型上執行（2026-11-12：真檔 618 MB 不在本機，依規則不下載）。輸出 JSON：首步 logits 餘弦、首步 top-1 是否相同、前 N 步貪婪 token 是否逐一相同、第一個不同的步數。
const fs = require('fs'), path = require('path');
const ROOT = process.env.FA_ROOT || path.join(__dirname, '..', '..'), OUT = process.env.OUT || path.join(require('os').tmpdir(), 'lora-slot-web-equiv');
const RT = process.env.NR_RUNTIME || path.join(require('os').homedir(), '.config', 'floating-assistant-desktop', 'native-runtime', '1.22.0-1');
const ort = require(path.join(RT, 'node_modules', 'onnxruntime-node'));
const Build = require(path.join(ROOT, 'lora-slot-build.js'));
const Web = require(path.join(ROOT, 'renderer/src/studio/lora_web_core.js'));
const [stdPath, loraPath, idsPath, stepsArg, rankArg] = process.argv.slice(2);
const steps = Number(stepsArg || 8), rank = Number(rankArg || 16), LAYERS = 28, KV = 8, HD = 128;
const lora = new Uint8Array(fs.readFileSync(loraPath));
const ids = JSON.parse(fs.readFileSync(idsPath, 'utf8'));
fs.mkdirSync(OUT, { recursive: true });

async function generate(modelPath, dir) {
    const s = await ort.InferenceSession.create(modelPath, { executionProviders: ['cpu'] });
    let past = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = new ort.Tensor('float32', new Float32Array(0), [1, KV, 0, HD]);
    const toks = []; let plen = 0, nxt = null, first = null;
    for (let i = 0; i < steps; i++) {
        const q = i === 0 ? ids : [nxt], L = plen + q.length;
        const feeds = { ...past, input_ids: new ort.Tensor('int64', BigInt64Array.from(q.map(BigInt)), [1, q.length]),
            attention_mask: new ort.Tensor('int64', BigInt64Array.from({ length: L }, () => 1n), [1, L]),
            position_ids: new ort.Tensor('int64', BigInt64Array.from(q.map((_, j) => BigInt(plen + j))), [1, q.length]) };
        const r = await s.run(feeds);
        const lg = r.logits.data.slice((q.length - 1) * r.logits.dims[2], q.length * r.logits.dims[2]);
        if (i === 0) first = Float32Array.from(lg);
        let best = 0; for (let j = 1; j < lg.length; j++) if (lg[j] > lg[best]) best = j;
        nxt = best; toks.push(best); plen = L;
        past = {}; for (let l = 0; l < LAYERS; l++) for (const k of ['key', 'value']) past[`past_key_values.${l}.${k}`] = r[`present.${l}.${k}`];
    }
    return { first, toks };
}
(async () => {
    // 槽版：來源是標準版檔案；把 lora.bin 換成真 adapter（大小必須與版面相同）
    const sdir = path.join(OUT, 'slot');
    const res = Build.buildSlotModel({ srcPath: stdPath, outDir: sdir, rank });
    if (res.layout.total_bytes !== lora.length) throw new Error(`lora.bin ${lora.length} 與版面 ${res.layout.total_bytes} 不符`);
    fs.copyFileSync(loraPath, path.join(sdir, 'lora.bin'));
    const slot = await generate(path.join(sdir, 'model_quantized.onnx'), sdir);
    // 網頁版：併權重
    const pr = Web.patchQwen3Q8(Uint8Array.from(fs.readFileSync(stdPath)), lora, { rank, minCos: 0, loraSha256: 'verify' });
    if (!pr.ok) throw new Error('網頁版併權重失敗：' + pr.error);
    const wdir = path.join(OUT, 'web'); fs.mkdirSync(wdir, { recursive: true });
    fs.writeFileSync(path.join(wdir, 'model_quantized.onnx'), Buffer.concat(pr.parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength))));
    fs.copyFileSync(loraPath, path.join(wdir, 'lora.bin'));
    const web = await generate(path.join(wdir, 'model_quantized.onnx'), wdir);
    let d = 0, na = 0, nb = 0; for (let j = 0; j < slot.first.length; j++) { d += slot.first[j] * web.first[j]; na += slot.first[j] ** 2; nb += web.first[j] ** 2; }
    let firstDiff = -1; for (let i = 0; i < steps; i++) if (slot.toks[i] !== web.toks[i]) { firstDiff = i; break; }
    console.log(JSON.stringify({ steps, firstLogitCos: +(d / Math.sqrt(na * nb)).toFixed(6), firstTop1Same: slot.toks[0] === web.toks[0], greedySame: firstDiff < 0, firstDiffStep: firstDiff, slotTokens: slot.toks, webTokens: web.toks, patchReport: pr.report }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
