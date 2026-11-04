// 聲紋儲存與比對的單元測試（階段 C 純邏輯）。執行：node scripts/voice-tests/voiceprint_store.test.js
'use strict';
const path = require('path');
const assert = require('assert');
const V = require(path.join(__dirname, '..', '..', 'renderer', 'src', 'voice', 'voiceprint_store.js'));

const MODEL = { id: 'ecapa-tdnn-onnx', sha256: '9acb086d5d9efca07266930ce03772f13cad5fd5a415bcf014ee4d82bed26311' };
const tests = [];
function check(name, fn) { tests.push([name, fn]); }
const vec = (...xs) => Float32Array.from(xs);

check('上限夾在 8 到 128，預設 8，無效值回預設', () => {
  assert.strictEqual(V.clampLimit(3), 8);
  assert.strictEqual(V.clampLimit(500), 128);
  assert.strictEqual(V.clampLimit(64), 64);
  assert.strictEqual(V.clampLimit('abc'), 8);
  assert.strictEqual(V.clampLimit(undefined), 8);
});

check('新建的儲存區上限是 8；setLimit 會夾限', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  assert.strictEqual(s.getLimit(), 8);
  assert.strictEqual(s.setLimit(999), 128);
  assert.strictEqual(s.setLimit(1), 8);
});

check('沒有聲紋時 needsEnrollment 為真（第一次開啟要強制錄入）', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  assert.strictEqual(s.needsEnrollment(), true);
  s.add('我', vec(1, 0, 0));
  assert.strictEqual(s.needsEnrollment(), false);
});

check('新增回報 ID（文字用），ID 從 1 開始遞增', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  const a = s.add('甲', vec(1, 0));
  const b = s.add('乙', vec(0, 1));
  assert.strictEqual(a.id, 1);
  assert.strictEqual(b.id, 2);
  assert.strictEqual(a.report, '已將聲紋記錄為 ID 1');
});

check('達到上限時新增被拒絕，且不會自動刪除任何聲紋', () => {
  const s = V.createVoiceprintStore({ model: MODEL, data: { limit: 8 } });
  for (let i = 0; i < 8; i++) assert.ok(s.add('p' + i, vec(i + 1, 1)).ok);
  const r = s.add('第九個', vec(9, 1));
  assert.strictEqual(r.ok, false);
  assert.ok(/上限/.test(r.error));
  assert.strictEqual(s.count(), 8);
});

check('調高上限後可以繼續新增', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  for (let i = 0; i < 8; i++) s.add('p' + i, vec(i + 1, 1));
  s.setLimit(10);
  assert.ok(s.add('第九個', vec(9, 1)).ok);
});

check('刪除後 ID 不重用', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  s.add('甲', vec(1, 0)); // 1
  s.add('乙', vec(0, 1)); // 2
  assert.strictEqual(s.remove(2).ok, true);
  const c = s.add('丙', vec(1, 1));
  assert.strictEqual(c.id, 3, '2 刪掉後不能再配發 2');
});

check('刪除不存在的 ID 回傳失敗', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  assert.strictEqual(s.remove(99).ok, false);
});

check('比對：同一人的樣本分數高於其他人，超過門檻就接受', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  s.add('甲', vec(1, 0, 0));
  s.add('乙', vec(0, 1, 0));
  const r = s.match(vec(0.99, 0.05, 0), 0.7);
  assert.strictEqual(r.accepted, true);
  assert.strictEqual(r.bestId, 1);
  assert.ok(r.score > 0.9);
});

check('比對：分數低於門檻不接受', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  s.add('甲', vec(1, 0, 0));
  const r = s.match(vec(0, 1, 0), 0.5);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'below_threshold');
});

check('比對：沒有聲紋時不接受（reason=no_enrollment）', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  const r = s.match(vec(1, 0), 0.5);
  assert.strictEqual(r.accepted, false);
  assert.strictEqual(r.reason, 'no_enrollment');
});

check('同一人多筆樣本：取最大值（不是平均）', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  s.add('甲-1', vec(0, 1, 0));    // 很不像的一筆
  s.add('甲-2', vec(1, 0, 0));    // 很像的一筆
  const r = s.match(vec(1, 0.01, 0), 0.9);
  assert.strictEqual(r.accepted, true);
  assert.strictEqual(r.bestId, 2);
});

check('模型版本不符的聲紋不參與比對，列表標示不可用', () => {
  const old = { id: 'ecapa-tdnn-onnx', sha256: 'old-hash', entries: null };
  const s0 = V.createVoiceprintStore({ model: old });
  s0.add('舊', vec(1, 0));
  const json = s0.toJSON();
  const s = V.createVoiceprintStore({ model: MODEL, data: json });
  assert.strictEqual(s.needsEnrollment(), true, '舊模型的聲紋不能當作已錄入');
  assert.strictEqual(s.list()[0].usable, false);
  assert.strictEqual(s.match(vec(1, 0), 0.5).reason, 'no_enrollment');
});

check('從 JSON 還原後 ID 不會重用（nextId 至少大於最大 id）', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  s.add('甲', vec(1, 0)); s.add('乙', vec(0, 1)); s.remove(2);
  const restored = V.createVoiceprintStore({ model: MODEL, data: JSON.parse(JSON.stringify(s.toJSON())) });
  assert.strictEqual(restored.add('丙', vec(1, 1)).id, 3);
});

check('零向量與缺少模型資訊時丟錯', () => {
  const s = V.createVoiceprintStore({ model: MODEL });
  assert.throws(() => s.add('壞', vec(0, 0)));
  assert.throws(() => V.createVoiceprintStore({ model: {} }));
});

(function run() {
  let pass = 0, fail = 0;
  for (const [name, fn] of tests) {
    try { fn(); pass++; console.log('[通過] ' + name); }
    catch (e) { fail++; console.log('[失敗] ' + name + '：' + e.message); }
  }
  console.log('\n合計：' + pass + ' 通過，' + fail + ' 失敗');
  process.exit(fail ? 1 : 0);
})();
