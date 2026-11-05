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

// ===== VLM 拆解：逐行輸出、被截斷自動接著寫、最後用分頁器讀完 =====
const v0 = src.indexOf('    // vopts（選填）：{ timeoutMs, meta }'), v1 = src.indexOf('    // 線上視覺模型看圖：每個候選 row');
assert.ok(v0 > 0 && v1 > v0, '找不到 _visionChat 區段');
const mkVlm = (total, capChars) => {
  const sent = [];
  const FaLlm = { fetch: async (url, o) => {
    const req = JSON.parse(o.body); const prompt = req.messages[0].content[0].text; sent.push({ max_tokens: req.max_tokens, prompt });
    const m = /id 從 (\d+) 開始/.exec(prompt); let id = m ? Number(m[1]) : 1, out = '';
    for (; id <= total; id++) {
      const line = JSON.stringify({ id, label: '物件' + id, bbox: [id, id, 4, 4] }) + '\n';
      if (out.length + line.length > capChars) { out += line.slice(0, capChars - out.length); return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: out }, finish_reason: 'length' }], model: 'fake' }) }; }
      out += line;
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: out + '{"_end":true}\n' }, finish_reason: 'stop' }], model: 'fake' }) };
  } };
  const C = new Function('FaLlm', 'FA_JSONL_PAGER_SRC', 'REASONING_DEADEND_CHARS_PER_TOKEN_ESTIMATE', 'return (class {\n' + src.slice(a, b) + '\n' + src.slice(v0, v1) + '\n})')(FaLlm, pagerSrc, 3);
  const fa = Object.assign(new C(), {
    _getGenerationSettings: () => ({ contextWindowTokens: 8192 }), _isAutoAgentMode: () => false, _toolResultBudgetChars: () => 8000,
    _createAbortController: () => new AbortController(), _isOpenRouter: () => false,
    _orderedVisionCandidateRows: () => [{ abilityTags: { vision: true } }], _resolveModelRowConfig: () => ({ apiUrl: 'http://x', apiKey: 'k', apiModel: 'fake-vlm' }), _ensureRowVisionVerified: async () => true,
  });
  return { fa, sent };
};
(async () => {
  const { fa, sent } = mkVlm(8000, 9000);
  const r = await fa._visionJsonlStream('data:image/png;base64,AAAA', '請拆解這張圖的所有物件', {});
  assert.strictEqual(r.complete, true); assert.strictEqual(r.lines.length, 8000); assert.ok(r.rounds > 30); assert.ok(sent.every((x) => x.max_tokens === 4096));
  const sid = fa._bigStashRecords(r.lines, { ok: true, complete: r.complete, rounds: r.rounds }, 'interpret_image');
  let pg = fa._bigPage(sid, null), pp = P.parsePage(pg.text); const got = pp.records.slice(); assert.strictEqual(pp.meta.head.complete, true);
  while (pp.meta.has_more) { pg = fa._bigPage(sid, pp.meta.next_cursor); pp = P.parsePage(pg.text); got.push(...pp.records); }
  assert.deepStrictEqual(got.map((x) => x.id), Array.from({ length: 8000 }, (_, i) => i + 1)); n++; console.log('ok - VLM 拆解 8000 個物件（每輪被截斷）：自動接著寫到說完，分頁器一頁頁讀完全部');

  // 中途一直失敗：不假裝完成（已拿到的保留、complete:false、附真實錯誤）
  const bad = mkVlm(8000, 9000); const orig = bad.fa._visionChat; let calls = 0;
  bad.fa._visionChat = async function (...x) { if (++calls > 3) throw new Error('HTTP 503'); return orig.apply(this, x); };
  const origJ = bad.fa._jsonlPagerMod().runStream;
  const r2 = await bad.fa._visionJsonlStream('data:x', 'q', { deadlineMs: 60000 }).catch((e) => e);
  assert.ok(r2 instanceof Error || r2.complete === false, '中途失敗不能回報完成'); n++; console.log('ok - 中途一直失敗：不回報完成（' + (r2 instanceof Error ? '明確錯誤' : 'complete:false，stop_reason=' + r2.stop_reason) + '）');

  // 被截斷時 _visionChat 的 meta 要看得到 finish_reason（原本回字串，呼叫端完全不知道被截斷）
  const m1 = mkVlm(8000, 9000); const mc = await m1.fa._visionChat({ apiUrl: 'http://x', apiKey: 'k', apiModel: 'm' }, [{ role: 'user', content: [{ type: 'text', text: 'q' }] }], 4096, { meta: true });
  assert.strictEqual(mc.finishReason, 'length'); assert.ok(typeof mc.ms === 'number'); n++; console.log('ok - _visionChat meta：回報 finish_reason=length 與耗時');
  // ===== 讀取帳本：總截斷也進帳本、跳頁不能清掉、最終閘門 =====
  const l0 = src.indexOf('    _faReadLedgerMod() {'), l1 = src.indexOf('    // 每個終端機 session 一個視窗主機');
  assert.ok(l0 > 0 && l1 > l0);
  const ledgerSrc = fs.readFileSync(path.join(__dirname, '..', 'renderer/src/agent/read_ledger.js'), 'utf8');
  const Cl = new Function('FA_READ_LEDGER_SRC', 'FA_JSONL_PAGER_SRC', 'REASONING_DEADEND_CHARS_PER_TOKEN_ESTIMATE', 'return (class {\n' + src.slice(a, b) + '\n' + src.slice(l0, l1) + '\n})')(ledgerSrc, pagerSrc, 3);
  const mkG = () => Object.assign(new Cl(), { _getGenerationSettings: () => ({ contextWindowTokens: 4096 }), _isAutoAgentMode: () => false, _toolResultBudgetChars() { return 8000; } });
  const g1 = mkG(); const big = JSON.stringify(objs(3000));
  const first = g1._truncateToolResultForContext(big, 'some_tool');   // 工具原始結果在截斷之前記帳本時看不到 has_more；現在截斷時一併記
  const pm1 = P.parsePage(first).meta;
  assert.ok(g1._readLedgerGate() && g1._readLedgerGate().remind, '只看了第一頁：最終回答前要被擋下來並提醒');
  assert.ok(g1._readLedgerGate().remind.indexOf('c1:' + pm1.source + ':' + pm1.to + ':0:0') > 0, '提醒要附缺口的 cursor');
  // AI 直接跳到最後一頁（big_content page 回傳字串）→ 缺口仍在
  const last = P.encodeCursor({ source: pm1.source, index: 2990, part: 0, page: 99 });
  const lastPg = g1._bigPage(pm1.source, last); g1._noteReadLedger('big_content', JSON.stringify({ id: pm1.source, action: 'page', cursor: last }), lastPg.text);
  const gate = g1._readLedgerGate(); assert.ok(gate && gate.remind && /還沒讀：第 \d+～\d+ 筆/.test(gate.remind), '跳到最後一頁不能清掉中間的缺口');
  n++; console.log('ok - 帳本：總截斷進帳本、只讀第一頁被擋、跳到最後一頁缺口仍在');
  // 補讀所有缺口 → 放行
  let cur = pm1.next_cursor; while (cur) { const r = g1._bigPage(pm1.source, cur); g1._noteReadLedger('big_content', JSON.stringify({ id: pm1.source, action: 'page', cursor: cur }), r.text); cur = P.parsePage(r.text).meta.next_cursor; }
  assert.strictEqual(g1._readLedgerGate(), null); n++; console.log('ok - 帳本：讀完全部 → 閘門放行');
  // 提醒用完仍沒讀：由程式附警語（不靠模型）
  const g2 = mkG(); g2._truncateToolResultForContext(big, 'some_tool'); let w = null; for (let i = 0; i < 8; i++) { w = g2._readLedgerGate(); if (w && w.warn) break; }
  assert.ok(w && w.warn && /只讀了 \d+／3000 筆/.test(w.warn), w && w.warn); n++; console.log('ok - 帳本：提醒用完後由程式附警語，寫明讀了多少筆');
  console.log(n + ' passed, 0 failed');
})().catch((e) => { console.error(e); process.exit(1); });
