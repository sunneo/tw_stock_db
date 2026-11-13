#!/usr/bin/env node
/* 讀回驗證 .fatrain（DESIGN.lora-training.md §27.8）：用產品同一套讀取器（renderer/src/studio/fatrain_core.js）讀回，
 * 核對 manifest、權重大小與 sha256、描述檔（descriptor）規則、model card 規則、相容性（base、rank 槽寬）。
 * 用法：node lora-train/verify_fatrain.js <a.fatrain> [...]    （在 desktop-app 目錄下執行）
 * 任何一項不符就 exit 1，並寫明原因；全部符合列出大小與 sha256。 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Fatrain = require('../renderer/src/studio/fatrain_core.js');
const Reg = require('../renderer/src/studio/lora_registry_core.js');
const Manage = require('../renderer/src/studio/lora_manage_core.js');

const SLOT_BYTES = 40370176, BASE = 'Qwen/Qwen3-0.6B', SLOT_RANK = 16;
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let bad = 0;
const fail = (f, msg) => { bad++; console.log('  [FAIL] ' + msg); };

for (const file of process.argv.slice(2)) {
  console.log('== ' + file);
  const bytes = new Uint8Array(fs.readFileSync(file));
  console.log('  file size ' + bytes.length + ' sha256 ' + sha(bytes));
  const r = Fatrain.readAsset(bytes);
  if (!r.ok) { fail(file, 'readAsset 拒絕：' + (r.errors || []).join('；')); continue; }
  const m = r.manifest, files = r.asset.files;
  console.log('  manifest: name=' + m.name + ' kind=' + m.kind + ' version=' + m.version + ' base=' + (m.compat && m.compat.base) + ' rank=' + (m.compat && m.compat.rank));
  if (m.kind !== 'lora') fail(file, 'kind 不是 lora');
  if (!m.compat || m.compat.base !== BASE) fail(file, 'compat.base 不是 ' + BASE);
  if (!m.compat || m.compat.rank !== SLOT_RANK) fail(file, 'compat.rank 不是槽寬 ' + SLOT_RANK);
  const get = (k) => { const v = files[k]; return v instanceof Uint8Array ? v : (v && v.data) || null; };
  const bin = get('weights/lora.bin');
  if (!bin) fail(file, '缺 weights/lora.bin');
  else {
    console.log('  weights/lora.bin ' + bin.length + ' bytes sha256 ' + sha(bin));
    if (bin.length !== SLOT_BYTES) fail(file, 'lora.bin 大小 ' + bin.length + ' ≠ 槽版固定 ' + SLOT_BYTES);
    if (m.sha256 && m.sha256['weights/lora.bin'] !== sha(bin)) fail(file, 'manifest 的 sha256 與實際 lora.bin 不符');
  }
  const descB = get('data/descriptor.json');
  if (!descB) fail(file, '缺 data/descriptor.json');
  else {
    const desc = JSON.parse(Buffer.from(descB).toString('utf8'));
    const derrs = Reg.descriptorErrors(desc);
    console.log('  descriptor: id=' + desc.id + ' version=' + desc.version + ' rank=' + desc.rank + ' domains=' + JSON.stringify(desc.applies && desc.applies.domains) + ' eval=' + (desc.eval ? 'groups ' + Object.keys(desc.eval.groups || {}).length : 'null'));
    if (derrs.length) fail(file, '描述檔規則：' + derrs.join('；'));
    if (bin && (desc.size !== bin.length || desc.sha256 !== sha(bin))) fail(file, '描述檔的 size／sha256 與 lora.bin 不符');
    if (desc.base !== BASE) fail(file, '描述檔 base 不是 ' + BASE);
  }
  const cardB = get('data/model_card.json');
  if (!cardB) fail(file, '缺 data/model_card.json');
  else {
    const card = JSON.parse(Buffer.from(cardB).toString('utf8'));
    const cv = Manage.validateModelCard(card);
    console.log('  model card: ' + (cv.ok ? 'ok' : 'NG') + (cv.warnings.length ? '（警告：' + cv.warnings.join('；') + '）' : ''));
    if (!cv.ok) fail(file, 'model card：' + cv.errors.join('；'));
  }
  if (r.verify && r.verify.ok === false) fail(file, 'sha256 核對失敗：' + r.verify.message);
  console.log(bad ? '  結果：有問題' : '  結果：讀回通過（manifest、權重大小與 sha256、描述檔、model card、相容性）');
}
process.exit(bad ? 1 : 0);
