'use strict';
// profile_priors 的 node 測試（G3）：簽名、等級、查表（measured 優先於 heuristic）、匯出入往返、heuristic 不可匯入、JSON 檔與內建資料同步。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const PP = require('./profile_priors.js');

let passed = 0;
function check(name, fn) { fn(); passed++; console.log('ok   ' + name); }

// GT720：這台應用程式探測到的能力（2026-11-18 真 Electron 實測 subgroups 不可用，簽名 sg0）
const GT720 = { maxWorkgroupStorage: 16384, maxInvocations: 256, hasF16: false, hasSubgroups: false };
const LOW = { maxWorkgroupStorage: 16384, maxInvocations: 256, hasF16: false, hasSubgroups: false };
const MID = { maxWorkgroupStorage: 32768, maxInvocations: 256, hasF16: true, hasSubgroups: false };
const HIGH = { maxWorkgroupStorage: 49152, maxInvocations: 1024, hasF16: true, hasSubgroups: true };

check('capSig：只看會影響選擇的四個欄位，且固定格式', () => {
  assert.strictEqual(PP.capSig(GT720), 'wg16384-inv256-f160-sg0');
  assert.strictEqual(PP.capSig(LOW), 'wg16384-inv256-f160-sg0');
  assert.strictEqual(PP.capSig(null), 'wg0-inv0-f160-sg0');
});

check('tierOf：低／中／高依能力，不看廠牌', () => {
  assert.strictEqual(PP.tierOf(LOW), 'low');
  assert.strictEqual(PP.tierOf(MID), 'mid');
  assert.strictEqual(PP.tierOf(HIGH), 'high');
  assert.strictEqual(PP.tierOf(GT720), 'low', 'GT 720 沒有 f16、共用 16 KiB：低階');
});

check('查表：GT 720 的簽名命中 measured，首選為手寫 v4', () => {
  const r = PP.lookup(null, GT720, 'matmul');
  assert.strictEqual(r.source, 'measured');
  assert.strictEqual(r.ranking[0], 'hand_v4');
});

check('查表：沒有同簽名時退到等級的 heuristic，且 source 標 heuristic（不冒充量測）', () => {
  const LOW_SG = { maxWorkgroupStorage: 16384, maxInvocations: 256, hasF16: false, hasSubgroups: true };   // 同為低階但 subgroups 可用 → 簽名 sg1，無 measured
  const r = PP.lookup(null, LOW_SG, 'matmul');
  assert.strictEqual(r.source, 'heuristic');
  assert.strictEqual(r.tier, 'low');
  assert.strictEqual(PP.lookup(null, LOW, 'matmul').source, 'measured');   // 這台的探測結果（sg0）命中實測
  assert.strictEqual(PP.lookup(null, HIGH, 'matmul').source, 'heuristic');
  assert.strictEqual(PP.lookup(null, MID, 'matmul').tier, 'mid');
});

check('查表：未知運算回傳 null（呼叫端退回規則選擇器）', () => {
  assert.strictEqual(PP.lookup(null, GT720, 'nosuchop'), null);
});

check('validate：來源必須是三種之一；heuristic 要 basis；measured 要 evidence', () => {
  assert.strictEqual(PP.validate({ schema: 1, entries: [{ sig: 'x', op: 'matmul', source: 'guess', ranking: ['a'] }] }).ok, false);
  assert.strictEqual(PP.validate({ schema: 1, entries: [{ sig: 'x', op: 'matmul', source: 'heuristic', ranking: ['a'] }] }).ok, false);
  assert.strictEqual(PP.validate({ schema: 1, entries: [{ sig: 'x', op: 'matmul', source: 'measured', ranking: ['a'] }] }).ok, false);
  assert.strictEqual(PP.validate({ schema: 2, entries: [] }).ok, false);
  assert.strictEqual(PP.validate(PP.BUILTIN).ok, true);
});

check('匯出→匯入往返：measured 與 local 不失真；同鍵的舊筆被取代', () => {
  const exp = PP.exportPriors(PP.BUILTIN);
  assert.ok(exp.entries.every((e) => e.source !== 'heuristic'), '匯出不含 heuristic');
  const local = { schema: 1, entries: [{ sig: 'wg32768-inv512-f161-sg0', op: 'matmul', shape: '*', source: 'local', ranking: ['g_64x128_k8_t4x8_v4'], evidence: '使用者 AMD 機器 2026-11-18' }] };
  const imp = PP.importPriors(PP.BUILTIN, local);
  assert.strictEqual(imp.ok, true);
  assert.ok(imp.doc.entries.some((e) => e.source === 'local' && e.sig === 'wg32768-inv512-f161-sg0'));
  assert.ok(imp.doc.entries.some((e) => e.source === 'measured'), '既有 measured 保留');
  const again = PP.importPriors(imp.doc, { schema: 1, entries: [{ sig: 'wg32768-inv512-f161-sg0', op: 'matmul', shape: '*', source: 'local', ranking: ['g_128x64_k8_t8x4_v4'], evidence: '重量' }] });
  assert.strictEqual(again.doc.entries.filter((e) => e.source === 'local').length, 1, '同鍵取代，不重複');
});

check('匯入拒絕 heuristic 筆（推估不當量測）', () => {
  const r = PP.importPriors(PP.BUILTIN, { schema: 1, entries: [{ sig: 'wg1-inv1-f160-sg0', op: 'matmul', source: 'heuristic', basis: 'x', ranking: ['a'] }] });
  assert.strictEqual(r.ok, false);
  assert.ok(/heuristic/.test(r.reason));
});

check('profile_priors.json 與內建資料一致（維護者匯出的檔案不會和程式脫節）', () => {
  const f = path.join(__dirname, 'profile_priors.json');
  const onDisk = JSON.parse(fs.readFileSync(f, 'utf8'));
  assert.deepStrictEqual(onDisk, PP.BUILTIN);
});

console.log(passed + ' 項通過');
