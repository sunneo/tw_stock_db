#!/usr/bin/env node
// 把「槽版 lora.bin」＋ 訓練產出的描述檔打成工作室可匯入的 .fatrain（kind:'lora'）。
// 用法：node scripts/build-lora-asset.js <release 目錄（含 lora.descriptor.json、model_card.json）> <lora.bin> <輸出資料夾>
// 資產內容：weights/lora.bin、data/descriptor.json、data/model_card.json；manifest.extra.lora 帶 domains／triggers／訓練秩。
// 登錄所見的 rank 是「槽秩」（槽版 ONNX 固定 16），訓練秩記在 extra.lora.trained_rank。
const fs = require('fs'); const path = require('path');
const Asset = require('../renderer/src/studio/asset_core.js');
const Fatrain = require('../renderer/src/studio/fatrain_core.js');

const SLOT_RANK = 16, BASE = 'Qwen/Qwen3-0.6B';
function build(relDir, binPath, outDir) {
    const desc = JSON.parse(fs.readFileSync(path.join(relDir, 'lora.descriptor.json'), 'utf8'));
    let card = null; try { card = JSON.parse(fs.readFileSync(path.join(relDir, 'model_card.json'), 'utf8')); } catch (_) { /* 沒有就略過 */ }
    const bin = new Uint8Array(fs.readFileSync(binPath)); const enc = (s) => new TextEncoder().encode(s);
    const files = { 'weights/lora.bin': bin, 'data/descriptor.json': enc(JSON.stringify(desc, null, 1)) };
    if (card) files['data/model_card.json'] = enc(JSON.stringify(card, null, 1));
    const ap = desc.applies || {};
    const m = Asset.createManifest({
        kind: 'lora', name: desc.name, files, base: BASE, owner: 'user',
        compat: { base: BASE, rank: SLOT_RANK, alpha: desc.alpha, prompt_format_version: desc.prompt_format_version, tool_catalog_sha256: desc.tool_catalog_sha256 },
        counts: { weight_bytes: bin.length },
        eval: (card && card.eval) || desc.eval || null,
        extra: { lora: { domains: ap.domains || [], triggers: ap.triggers || [], trained_rank: desc.rank, trained_base: desc.base, size: bin.length } },
    });
    const r = Fatrain.exportAsset({ manifest: m, files }, {}); if (!r.ok) throw new Error(r.error);
    fs.mkdirSync(outDir, { recursive: true }); const out = path.join(outDir, r.name); fs.writeFileSync(out, Buffer.from(r.bytes));
    return { out, size: r.size, name: desc.name };
}
if (require.main === module) {
    const [rel, bin, out] = process.argv.slice(2); if (!rel || !bin || !out) { console.error('用法：build-lora-asset.js <release 目錄> <lora.bin> <輸出資料夾>'); process.exit(2); }
    const r = build(rel, bin, out); console.log(JSON.stringify(r));
}
module.exports = { build, SLOT_RANK, BASE };
