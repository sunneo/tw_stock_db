// node renderer/src/chat/topic_local.test.js
'use strict';
const assert = require('assert');
const L = require('./topic_local.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }

// 模擬一個對話的狀態：目前話題指紋 + 被轉出的舊話題（候選）
function run(seq) {
  let current = null;
  let candidates = [];
  const out = [];
  for (const text of seq) {
    const r = L.detectShift(current, candidates, text);
    out.push(r);
    if (current === null) {
      current = L.fingerprintOf(text);
    } else if (r.isShifted) {
      candidates.push({ id: 'topic' + candidates.length, fingerprint: current });
      if (r.matchedTopicId) {
        const hit = candidates.find((c) => c.id === r.matchedTopicId);
        current = L.mergeFingerprint(hit.fingerprint, text);
      } else {
        current = L.fingerprintOf(text);
      }
    } else {
      current = L.mergeFingerprint(current, text);
    }
  }
  return out;
}

t('指紋：中文二元組、英文單字、虛詞不計入', () => {
  const fp = L.fingerprintOf('幫我畫一張貓的圖');
  assert.ok(fp['畫一'] >= 1);
  assert.ok(fp['貓的'] >= 1);
  assert.ok(fp['的圖'] >= 1);
  assert.strictEqual(fp['幫我'], undefined);
  assert.strictEqual(fp['一張'], undefined);
  const en = L.fingerprintOf('Draw a CAT picture');
  assert.strictEqual(en.cat, 1);
  assert.strictEqual(en.picture, 1);
  assert.strictEqual(en.a, undefined);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(fp)), fp);
});

t('mergeFingerprint：累加、超過上限只留次數最多的（確定性）', () => {
  let fp = {};
  for (let i = 0; i < 30; i++) fp = L.mergeFingerprint(fp, 'alpha beta', 5);
  assert.ok(Object.keys(fp).length <= 5);
  assert.strictEqual(fp.alpha, 30);
  assert.strictEqual(fp.beta, 30);
  const a = L.mergeFingerprint({ x: 1, y: 1, z: 1 }, 'w', 2);
  const b = L.mergeFingerprint({ x: 1, y: 1, z: 1 }, 'w', 2);
  assert.deepStrictEqual(a, b);
});

t('similarity：相同為 1、無重疊為 0、空為 0', () => {
  const a = L.fingerprintOf('畫一張貓的圖');
  assert.ok(Math.abs(L.similarity(a, a) - 1) < 1e-9);
  assert.strictEqual(L.similarity(a, L.fingerprintOf('寫一首詩')), 0);
  assert.strictEqual(L.similarity({}, a), 0);
});

t('沒有目前話題 → 不判轉移', () => {
  const r = L.detectShift(null, [], '幫我畫一張貓的圖');
  assert.strictEqual(r.isShifted, false);
  assert.strictEqual(r.reason, 'no-current-topic');
});

t('使用者案例序列（中文）', () => {
  const r = run([
    '幫我畫一張貓的圖',
    '再加一隻狗',
    '幫我創作一首音樂',
    '再畫一張狗的圖',
    '好',
  ]);
  assert.deepStrictEqual(r.map((x) => x.isShifted), [false, false, true, true, false]);
  assert.strictEqual(r[2].matchedTopicId, null);
  assert.strictEqual(r[3].matchedTopicId, 'topic0');
});

t('英文序列', () => {
  const r = run([
    'draw a cat picture',
    'add another dog',
    'write a poem about the ocean',
    'draw a dog picture again',
    'thanks',
  ]);
  assert.deepStrictEqual(r.map((x) => x.isShifted), [false, false, true, true, false]);
  assert.strictEqual(r[3].matchedTopicId, 'topic0');
});

t('中英混合序列', () => {
  const r = run([
    '幫我畫一張cat的圖',
    '再加一隻dog',
    '幫我寫一首關於海的詩',
    '再畫一隻dog的圖',
  ]);
  assert.deepStrictEqual(r.map((x) => x.isShifted), [false, false, true, true]);
  assert.strictEqual(r[3].matchedTopicId, 'topic0');
});

t('太短或純延續不判轉移', () => {
  const cur = L.fingerprintOf('幫我畫一張貓的圖');
  for (const s of ['好', '繼續', '謝謝', '對', '再來一個', '改一下', 'ok', '好的。', '我']) {
    assert.strictEqual(L.detectShift(cur, [], s).isShifted, false, s);
  }
});

t('同話題的延續句不轉移（相似度夠高）', () => {
  const cur = L.fingerprintOf('幫我畫一張貓的圖');
  const r = L.detectShift(cur, [], '把貓的圖改成水彩');
  assert.strictEqual(r.isShifted, false);
});

t('無關的新需求判轉移，且沒有候選時 matchedTopicId 為 null', () => {
  const cur = L.fingerprintOf('幫我畫一張貓的圖');
  const r = L.detectShift(cur, [], '幫我查明天的股價走勢');
  assert.strictEqual(r.isShifted, true);
  assert.strictEqual(r.matchedTopicId, null);
});

t('門檻可由 opts 覆寫', () => {
  const cur = L.fingerprintOf('畫貓');
  const txt = '畫狗';
  assert.strictEqual(L.detectShift(cur, [], txt, { sameThreshold: 0.0 }).isShifted, false);
  assert.strictEqual(L.detectShift(cur, [], txt).isShifted, true);
});

t('判斷 1000 次的總耗時 < 50 ms', () => {
  const cur = L.mergeFingerprint(L.fingerprintOf('幫我畫一張貓的圖'), '再加一隻狗', 40);
  const cands = [{ id: 'x', fingerprint: L.fingerprintOf('幫我寫一首關於海的詩') }];
  const msgs = ['再畫一張狗的圖', '幫我查明天的股價走勢', '好', 'draw a dog picture again', '把貓的圖改成水彩'];
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 1000; i++) L.detectShift(cur, cands, msgs[i % msgs.length]);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  assert.ok(ms < 50, '耗時 ' + ms.toFixed(2) + ' ms');
  console.log('    (1000 次判斷耗時 ' + ms.toFixed(2) + ' ms)');
});

console.log(n + ' tests passed');
