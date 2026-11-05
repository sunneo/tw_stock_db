// node scripts/jsonl-paging.test.js
// 超大回應轉 JSONL 的接線：用真的函式原始碼（從 floating-assistant.js 切出來），內容窗口大小用假的設定。
'use strict';
const fs = require('fs'), path = require('path'), assert = require('assert');
const src = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/floating-assistant.js'), 'utf8').split('\r\n').join('\n');
const pagerSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/agent/jsonl_pager.js'), 'utf8');
const P = require('../renderer/src/agent/jsonl_pager.js');
const a = src.indexOf('    _bigStash(text, label) {'), b = src.indexOf('    _formatToolResult(result, toolName) {');
assert.ok(a > 0 && b > a, '找不到要切的原始碼');
const Cls = new Function('FA_JSONL_PAGER_SRC', 'REASONING_DEADEND_CHARS_PER_TOKEN_ESTIMATE', 'return (class {\n' + src.slice(a, b) + '\n})')(pagerSrc, 3);
const mk = (ctx, auto) => Object.assign(new Cls(), {
  _getGenerationSettings: () => ({ contextWindowTokens: ctx }),
  _isAutoAgentMode: () => !!auto,
  _toolResultBudgetChars() { return auto ? Math.max(16000, ctx * 0.25 * 3) : Math.max(8000, ctx * 0.15 * 3); },
});

let n = 0; const t = (name, fn) => { fn(); n++; console.log('ok - ' + name); };
const objs = (c) => Array.from({ length: c }, (_, i) => ({ id: i, label: '物件' + i, bbox: [i, i, i + 5, i + 5], note: '中文 😀' }));

// 模擬 AI：從截斷後的第一頁開始，用 _bigPage(cursor) 一頁頁讀到完
function readLikeAi(fa, firstText) {
  let pp = P.parsePage(firstText); assert.ok(pp, '截斷後的第一頁要能被解析');
  const all = pp.records.slice(); let pages = 1, id = pp.meta.source;
  while (pp.meta.has_more) {
    assert.ok(pp.meta.continue.indexOf('big_content') >= 0 && pp.meta.continue.indexOf(pp.meta.next_cursor) > 0, 'meta 要說明怎麼續讀');
    const r = fa._bigPage(id, pp.meta.next_cursor); assert.ok(r && r.ok, r && r.error);
    pp = P.parsePage(r.text); all.push(...pp.records); pages++;
    assert.ok(pages < 100000);
  }
  return { all, pages, last: pp.meta };
}

t('VLM 風格：8000 個物件的大回應，截斷後第一頁就是 JSONL，一頁頁讀完全部相等', () => {
  const data = { ok: true, image: 'x.png', objects: objs(8000) };
  [4096, 8192, 32768].forEach((ctx) => {
    const fa = mk(ctx, true), text = JSON.stringify(data);
    const out = fa._truncateToolResultForContext(text, 'vlm_segment');
    assert.ok(out.length <= fa._toolResultBudgetChars(), '第一頁不能又被總截斷（' + out.length + ' > ' + fa._toolResultBudgetChars() + '）');
    const r = readLikeAi(fa, out);
    assert.deepStrictEqual(r.all, data.objects); assert.strictEqual(r.last.done, true); assert.strictEqual(r.last.read_records, 8000);
    assert.ok(r.pages > 1);
  });
});

t('窗口越小分頁越多（按比例縮放，不是固定常數）', () => {
  const text = JSON.stringify(objs(3000));
  const pages = [2048, 8192, 65536].map((ctx) => { const fa = mk(ctx, false); return readLikeAi(fa, fa._truncateToolResultForContext(text, 'x')).pages; });
  assert.ok(pages[0] > pages[1] && pages[1] >= pages[2], '頁數應隨窗口變小而變多：' + pages.join(','));
});

t('不是記錄清單（大字串、單一大物件）退回原本的開頭截斷', () => {
  const fa = mk(8192, false);
  const out = fa._truncateToolResultForContext('x'.repeat(50000), 'foo');
  assert.ok(out.indexOf('內容很大') > 0 && out.indexOf('"_page"') < 0);
});

t('JSONL 文字（逐行）也能分頁，壞行保留', () => {
  const fa = mk(4096, false);
  const lines = objs(2000).map((o) => JSON.stringify(o)); lines[7] = '{壞掉的一行';
  const out = fa._truncateToolResultForContext(lines.join('\n'), 'x');
  const r = readLikeAi(fa, out);
  assert.strictEqual(r.all.length, 2000); assert.ok(r.all.some((x) => x._bad_line === 8));
});

t('cursor 給別的代號／亂填：回明確錯誤，不亂讀', () => {
  const fa = mk(4096, false); const out = fa._truncateToolResultForContext(JSON.stringify(objs(3000)), 'x'); const id = P.parsePage(out).meta.source;
  assert.ok(!fa._bigPage(id, 'abc').ok);
  assert.ok(!fa._bigPage(id, 'c1:bc_999:3:0:1').ok);
  assert.strictEqual(fa._bigPage('bc_404', null), null, '代號不存在回 null');
});

t('單筆記錄比一頁還大：分段續傳，接回去相等', () => {
  const fa = mk(2048, false); const big = { id: 1, blob: '資料'.repeat(20000) };
  const out = fa._truncateToolResultForContext(JSON.stringify([{ id: 0 }, big, { id: 2 }]), 'x');
  let pp = P.parsePage(out); const id = pp.meta.source; const recs = pp.records.slice(); const parts = pp.parts.slice();
  for (let g = 0; pp.meta.has_more && g < 100000; g++) { pp = P.parsePage(fa._bigPage(id, pp.meta.next_cursor).text); recs.push(...pp.records); parts.push(...pp.parts); }
  assert.deepStrictEqual(recs.map((x) => x.id), [0, 2]); assert.deepStrictEqual(JSON.parse(parts.map((p) => p.text).join('')), big);
});

console.log('全部通過：' + n);
