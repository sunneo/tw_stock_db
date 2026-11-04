// node renderer/src/chat/handoff.test.js
'use strict';
const assert = require('assert');
const H = require('./handoff.js');

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok - ' + name); }

t('標題：一般短句原樣保留', () => {
  assert.strictEqual(H.buildHandoff('父', [], '幫我創作一首音樂').title, '幫我創作一首音樂');
});

t('標題：超過 20 字截斷，含省略號後總長不超過 20 字', () => {
  const long = '一二三四五六七八九十一二三四五六七八九十一二三四五六七八九十';
  const title = H.buildHandoff('父', [], long).title;
  assert.strictEqual(Array.from(title).length, H.TITLE_MAX);
  assert.ok(title.endsWith('…'));
});

t('標題：換行與多餘空白收成單一空白', () => {
  assert.strictEqual(H.titleOf('  幫我\n\n畫一張\t貓   的圖  '), '幫我 畫一張 貓 的圖');
});

t('標題：空字串或只有空白時用預設名稱', () => {
  assert.strictEqual(H.titleOf(''), '新對話');
  assert.strictEqual(H.titleOf(' \n\t '), '新對話');
  assert.strictEqual(H.titleOf(null), '新對話');
});

t('標題：emoji 與中文不會被切壞（依字元截斷）', () => {
  const title = H.titleOf('🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵🎵');
  assert.strictEqual(Array.from(title).length, H.TITLE_MAX);
});

t('交接：空的舊話題只有來源說明與結尾，沒有摘錄', () => {
  const r = H.buildHandoff('畫貓', [], '幫我創作一首音樂');
  assert.ok(r.handoff.includes('〈畫貓〉'));
  assert.ok(!r.handoff.includes('・'));
  assert.ok(r.handoff.includes('請只針對下面的新問題回答'));
});

t('交接：只取舊話題最近 EXCERPT_COUNT 則使用者訊息，忽略 assistant 與 system', () => {
  const old = [
    { role: 'system', content: '系統' },
    { role: 'user', content: '第一則' },
    { role: 'assistant', content: '助理回覆不應出現' },
    { role: 'user', content: '第二則' },
    { role: 'user', content: '第三則' },
    { role: 'user', content: '第四則' },
  ];
  const h = H.buildHandoff('父', old, '新話題').handoff;
  assert.ok(!h.includes('第一則'), '最舊的一則應被丟掉');
  assert.ok(h.includes('第二則') && h.includes('第三則') && h.includes('第四則'));
  assert.ok(!h.includes('助理回覆不應出現') && !h.includes('系統'));
  assert.strictEqual((h.match(/・/g) || []).length, H.EXCERPT_COUNT);
});

t('交接：很長的單則訊息截斷到 EXCERPT_MAX', () => {
  const big = '字'.repeat(5000);
  const h = H.buildHandoff('父', [{ role: 'user', content: big }], '新').handoff;
  const line = h.split('\n').find((x) => x.startsWith('・'));
  assert.ok(line, '應有摘錄行');
  assert.ok(Array.from(line).length <= H.EXCERPT_MAX + 1);
  assert.ok(line.endsWith('…'));
});

t('交接：含換行的訊息摘錄會收成單行', () => {
  const h = H.buildHandoff('父', [{ role: 'user', content: '第一行\n第二行\n\n第三行' }], '新').handoff;
  const line = h.split('\n').find((x) => x.startsWith('・'));
  assert.strictEqual(line, '・第一行 第二行 第三行');
});

t('交接：父標題很長會截斷', () => {
  const h = H.buildHandoff('父'.repeat(200), [], '新').handoff;
  assert.ok(h.includes('…〉'));
  assert.ok(Array.from(h.split('〈')[1].split('〉')[0]).length <= H.PARENT_MAX);
});

t('交接：整體長度不超過 TOTAL_MAX（很多很長的摘錄）', () => {
  const old = [];
  for (let i = 0; i < 50; i++) old.push({ role: 'user', content: '重複'.repeat(300) + i });
  const h = H.buildHandoff('父'.repeat(100), old, '新').handoff;
  assert.ok(Array.from(h).length <= H.TOTAL_MAX, '實際長度 ' + Array.from(h).length);
});

t('交接：非陣列與缺欄位的舊訊息不會丟錯', () => {
  assert.doesNotThrow(() => H.buildHandoff(undefined, null, undefined));
  assert.doesNotThrow(() => H.buildHandoff('父', [null, { role: 'user' }, { role: 'user', content: 42 }], '新'));
});

console.log('\n' + n + ' 項全部通過');
