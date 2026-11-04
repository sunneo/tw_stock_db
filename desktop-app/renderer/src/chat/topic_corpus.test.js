// node renderer/src/chat/topic_corpus.test.js
// 話題偵測語料（topic_corpus.json）的單元測試（S8 步驟 D）。語料是合成的，這裡只鎖住「校準結果」與「語料格式」，不代表真實對話的誤判率。
'use strict';
const assert = require('assert');
const L = require('./topic_local.js');
const corpus = require('./topic_corpus.json');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }

function currentOf(history) {
  let fp = null;
  for (const h of history) fp = fp === null ? L.fingerprintOf(h) : L.mergeFingerprint(fp, h, L.DEFAULT_MAX_TERMS);
  return fp;
}
function predict(c, opts) { return L.detectShift(currentOf(c.history), [], c.message, opts || {}).isShifted; }

t('語料至少 60 組，類別 A–E 都有，每組欄位完整', () => {
  assert.ok(corpus.cases.length >= 60, 'cases=' + corpus.cases.length);
  const cats = new Set(corpus.cases.map((c) => c.cat));
  ['A', 'B', 'C', 'D', 'E'].forEach((k) => assert.ok(cats.has(k), '缺類別 ' + k));
  for (const c of corpus.cases) {
    assert.ok(Array.isArray(c.history) && c.history.length >= 1, 'history');
    assert.strictEqual(typeof c.message, 'string');
    assert.strictEqual(typeof c.expectShift, 'boolean');
  }
});

t('語料含中文、英文、中英混合', () => {
  const has = (re) => corpus.cases.some((c) => re.test(c.message));
  assert.ok(has(/[一-鿿]/), '沒有中文');
  assert.ok(has(/^[\x00-\x7f ]+$/), '沒有純英文');
  assert.ok(has(/[一-鿿].*[a-zA-Z]|[a-zA-Z].*[一-鿿]/), '沒有中英混合');
});

t('明確延續句（類別 C）被誤開不超過 15%（使用預設門檻）', () => {
  const cs = corpus.cases.filter((c) => c.cat === 'C');
  const wrong = cs.filter((c) => predict(c)).length;
  assert.ok(wrong / cs.length <= 0.15, 'C 誤開 ' + wrong + '/' + cs.length);
});

t('預設門檻下，該開沒開最多 1 組（已知反例：「還要幫我寫一首詩」，見 topic_corpus.json）', () => {
  const pos = corpus.cases.filter((c) => c.expectShift);
  const miss = pos.filter((c) => !predict(c));
  assert.ok(miss.length <= 1, '漏判 ' + miss.map((c) => c.message).join('、'));
});

t('「來」開頭的完整新需求都會開（類別 D 全部為真）', () => {
  const ds = corpus.cases.filter((c) => c.cat === 'D' && /^來/.test(c.message) && c.message.length > 4);
  assert.ok(ds.length >= 6, '來開頭案例數 ' + ds.length);
  for (const c of ds) assert.strictEqual(predict(c), true, c.message);
});

t('短延續句（好、繼續、謝謝、再來一個、改成紅色）不開', () => {
  for (const m of ['好', '繼續', '謝謝', '再來一個', '改成紅色']) {
    assert.strictEqual(predict({ history: ['幫我畫一張貓的圖'], message: m }), false, m);
  }
});

console.log(n + ' tests passed');
