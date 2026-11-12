#!/usr/bin/env node
// 把「槽版 lora.bin」＋ 訓練產出的描述檔＋model_card.json 打成工作室可匯入的 .fatrain（kind:'lora'）。
// 用法：node scripts/build-lora-asset.js <release 目錄（含 lora.descriptor.json、model_card.json）> <lora.bin> <輸出資料夾>
// 資產內容：weights/lora.bin、data/descriptor.json、data/model_card.json；manifest.extra.lora 帶 domains／triggers／訓練秩／版本／說明／已知限制。
//
// 出貨前的檢查（任何一項不過就不產出，錯誤寫明原因）：
//   1. 描述檔過 registry 的 descriptorErrors（同 lora_registry_core 的規則）；
//   2. model_card.json 過 validateModelCard（同 lora_manage_core 的規則）；沒有 card 不產出（不靜默略過）；
//   3. lora.bin 的大小必須等於槽版固定大小（SLOT_BYTES，rank 16 的槽）。
// 描述檔寫出的 size／sha256 是實際打包的 lora.bin（不是 PEFT 檔）；base 是 HF 名稱 BASE（本機路徑另存在 base_local）。
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const Asset = require('../renderer/src/studio/asset_core.js');
const Fatrain = require('../renderer/src/studio/fatrain_core.js');
const Reg = require('../renderer/src/studio/lora_registry_core.js');
const Manage = require('../renderer/src/studio/lora_manage_core.js');

const SLOT_RANK = 16, BASE = 'Qwen/Qwen3-0.6B';
// 槽版 rank 16 的 lora.bin 固定大小（make_lora_onnx.py 的 layout：40,370,176 位元組）
const SLOT_BYTES = 40370176;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

function build(relDir, binPath, outDir) {
    const desc = JSON.parse(fs.readFileSync(path.join(relDir, 'lora.descriptor.json'), 'utf8'));
    const derrs = Reg.descriptorErrors(desc);
    if (derrs.length) throw new Error('描述檔不合法：' + derrs.join('；'));
    let card = null; try { card = JSON.parse(fs.readFileSync(path.join(relDir, 'model_card.json'), 'utf8')); } catch (_) { /* 下面統一報錯 */ }
    if (!card) throw new Error('沒有 model_card.json（或不是合法 JSON）：不產出沒有介紹與評量來源的 .fatrain');
    const cv = Manage.validateModelCard(card);
    if (!cv.ok) throw new Error('model_card.json 不合法：' + cv.errors.join('；'));
    const bin = new Uint8Array(fs.readFileSync(binPath));
    if (bin.length !== SLOT_BYTES) throw new Error('lora.bin 大小 ' + bin.length + ' 與槽版固定大小 ' + SLOT_BYTES + ' 不符（不是 rank 16 槽版的權重）');
    const enc = (s) => new TextEncoder().encode(s);
    // 描述檔：權重欄位改成實際打包的檔案；base 改成 HF 名稱，本機路徑另存
    const d2 = Object.assign({}, desc, { base: BASE, size: bin.length, sha256: sha(bin), slot_rank: SLOT_RANK });
    if (desc.base !== BASE) d2.base_local = desc.base;
    const files = { 'weights/lora.bin': bin, 'data/descriptor.json': enc(JSON.stringify(d2, null, 1)), 'data/model_card.json': enc(JSON.stringify(card, null, 1)) };
    const ap = desc.applies || {};
    const m = Asset.createManifest({
        kind: 'lora', name: desc.name, files, base: BASE, owner: 'user',
        compat: { base: BASE, rank: SLOT_RANK, alpha: desc.alpha, prompt_format_version: desc.prompt_format_version, tool_catalog_sha256: desc.tool_catalog_sha256 },
        counts: { weight_bytes: bin.length },
        eval: card.eval || desc.eval || null,
        extra: { lora: {
            domains: ap.domains || [], triggers: ap.triggers || [], trained_rank: desc.rank, trained_base: desc.base, size: bin.length,
            version: desc.version, description: desc.description || card.intro || '', known_limits: Array.isArray(card.known_limits) ? card.known_limits.slice() : [],
        } },
    });
    const r = Fatrain.exportAsset({ manifest: m, files }, {}); if (!r.ok) throw new Error(r.error);
    fs.mkdirSync(outDir, { recursive: true }); const out = path.join(outDir, r.name); fs.writeFileSync(out, Buffer.from(r.bytes));
    return { out, size: r.size, name: desc.name, version: desc.version, warnings: cv.warnings };
}
if (require.main === module) {
    const [rel, bin, out] = process.argv.slice(2); if (!rel || !bin || !out) { console.error('用法：build-lora-asset.js <release 目錄> <lora.bin> <輸出資料夾>'); process.exit(2); }
    try { const r = build(rel, bin, out); console.log(JSON.stringify(r)); }
    catch (e) { console.error('[build-lora-asset] ' + (e.message || e)); process.exit(1); }
}
module.exports = { build, SLOT_RANK, SLOT_BYTES, BASE };
