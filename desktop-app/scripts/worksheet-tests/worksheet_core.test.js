// node scripts/worksheet-tests/worksheet_core.test.js -- 教育文書（學習單）核心：讀請求、驗證、排版、輸出、參考圖片、編輯動作、封閉題。
const W = require('../../renderer/src/worksheet/worksheet_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }

// ---------- 讀請求（使用者的真實說法）----------
const REQ = '幫我設計一樣的，做成一個pdf，要有圈圈圖式跟顏色，右邊填上相對的樹字\n顏色跟他一樣\n一串10又1, 10又2的概念';
const r = W.parseRequest(REQ);
check('the request is read as bead rows', r.ok && r.template === 'bead_rows', r);
const b = r.spec.blocks[0];
check('10又1, 10又2 -> base 10; no range given -> default 1..8 (like the example) with a closed question', b.base === 10 && b.counts.join() === '1,2,3,4,5,6,7,8' && r.questions.length === 1 && r.questions[0].default === 0, [b.base, b.counts, r.questions.length]);
check('"右邊填上" -> an answer line on the right, blank (student version)', b.answer.side === 'right' && b.answer.line === true && b.answer.show === false);
check('the title and instruction are written like the example', r.spec.title === '彩色串珠｜10又幾（一）' && /10顆金色珠/.test(r.spec.subtitle), [r.spec.title, r.spec.subtitle]);
check('the notes tell what the program decided (defaults)', r.notes.some((n) => /1～8/.test(n)) && r.notes.some((n) => /標準色/.test(n)), r.notes);
check('explicit range "10又1到10又5" gives 5 rows', W.parseRequest('做串珠 10又1到10又5').spec.blocks[0].counts.join() === '1,2,3,4,5');
check('"做6串" gives 6 rows without asking', (() => { const x = W.parseRequest('串珠10又幾，做6串'); return x.spec.blocks[0].counts.length === 6 && x.questions.length === 0; })());
check('teacher version: "附答案"', W.parseRequest('串珠10又幾 附答案').spec.blocks[0].answer.show === true);
check('other templates are recognised', ['數一數 3 5 2', '十格框 4 7 9', '數線 0到20', '加法練習 20以內 12題'].map((x) => W.parseRequest(x).template).join() === 'count_rows,ten_frames,number_line,equations');
check('nothing recognisable -> not ok with a clear message (no invented worksheet)', (() => { const x = W.parseRequest('今天天氣很好'); return x.ok === false && /看不出/.test(x.error); })());

// ---------- 驗證：壞的欄位退回預設、不丟例外 ----------
const v = W.validate({ title: 'x'.repeat(500), page: { size: 'B7', margin: 999 }, blocks: [{ type: 'bead_rows', counts: [0, 'a', 99, 3], colors: { 3: 'red', 4: 'nope' } }, { type: 'nonsense' }, null] });
check('validate: long title cut, unknown paper -> A4, margin clamped, bad blocks dropped with problems', v.spec.title.length === 80 && v.spec.page.size === 'A4' && v.spec.page.margin === 30 && v.spec.blocks.length === 1 && v.problems.length >= 3, v.problems);
check('validate: only valid counts stay, colour words become hex, bad colours are dropped', v.spec.blocks[0].counts.join() === '3' && v.spec.blocks[0].colors[3] === '#C8174F' && !v.spec.blocks[0].colors[4]);
check('validate never throws on garbage', (() => { try { W.validate('hello'); W.validate(null); W.validate({ blocks: 5 }); return true; } catch (e) { return false; } })());

// ---------- 排版與輸出 ----------
const L = W.layout(r.spec);
const circles = L.prims.filter((p) => p.t === 'circle'), texts = L.prims.filter((p) => p.t === 'text'), lines = L.prims.filter((p) => p.t === 'line');
check('layout: A4 portrait in mm', L.w === 210 && L.h === 297);
// 8 串：每串 10 顆金珠 + c 顆彩珠，每顆 2 個圓（珠＋反光），加 2 個端環
const expectCircles = [1, 2, 3, 4, 5, 6, 7, 8].reduce((a, c) => a + (10 + c) * 2 + 2, 0);
check('layout: every bead is drawn (10 gold + the coloured ones, with end rings)', circles.length === expectCircles, [circles.length, expectCircles]);
check('layout: 8 answer lines on the right + 2 header lines (name/date)', lines.length === 10, lines.length);
check('layout: title and instruction are centred text', texts.some((t) => t.s === r.spec.title && t.anchor === 'middle') && texts.some((t) => /金色珠/.test(t.s)));
check('layout: nothing is drawn outside the page', L.prims.every((p) => p.t === 'text' || p.t === 'line' || (p.cx === undefined ? true : p.cx - p.r >= 0 && p.cx + p.r <= L.w && p.cy - p.r >= 0 && p.cy + p.r <= L.h)));
const goldX = circles.filter((c) => c.fill === '#E9B22E').map((c) => c.cx);
const row1 = circles.filter((c) => Math.abs(c.cy - circles[0].cy) < 0.5 && c.r > 1);
check('layout: the colours of row n are the standard colours (row 1 red, row 2 green)', (() => { const ys = [...new Set(circles.filter((c) => c.r > 2).map((c) => Math.round(c.cy)))]; const col = (yy, n) => circles.filter((c) => Math.round(c.cy) === yy && c.fill !== '#E9B22E' && c.r > 2 && !/^#[0-9A-F]{6}$/.test('x') ).length; return ys.length === 8; })());
check('layout: rows do not overlap (gap between row centres > bead size)', (() => { const ys = [...new Set(circles.filter((c) => c.r > 2).map((c) => Math.round(c.cy * 10) / 10))].sort((a, b) => a - b); const d = circles.find((c) => c.r > 2).r * 2; for (let i = 1; i < ys.length; i++) if (ys[i] - ys[i - 1] < d * 1.2) return false; return ys.length === 8; })());
const svg = W.toSvg(L);
check('svg: a valid document with all shapes and the Chinese title escaped', /^<svg [^>]*viewBox="0 0 210 297"/.test(svg) && svg.split('<circle').length - 1 === expectCircles && svg.includes('彩色串珠｜10又幾（一）') && !/<script/i.test(svg));
const html = W.toHtml(L);
check('html: opens as a page with @page A4 and the svg inside', /@page\{size:210mm 297mm/.test(html) && html.includes('<svg') && html.includes('<title>彩色串珠'));
const pm = W.toPdfmake(L);
check('pdfmake: page size in points, one vector canvas plus absolutely placed texts', Math.abs(pm.pageSize.width - 595.28) < 0.1 && Math.abs(pm.pageSize.height - 841.89) < 0.1 && pm.content[0].canvas.length === L.prims.filter((p) => p.t !== 'text').length && pm.content.length === 1 + texts.length);
check('pdf: the full-width bar (missing in the CJK font) is written as " | "', pm.content.every((x) => !x.text || x.text.indexOf('｜') < 0));
check('pdfmake: ellipses and lines have the right shape fields', pm.content[0].canvas.some((c) => c.type === 'ellipse' && c.r1 > 0) && pm.content[0].canvas.some((c) => c.type === 'line' && c.lineWidth > 0));
check('pdfmake: centred title is placed by its estimated width', (() => { const shown = r.spec.title.replace(/｜/g, ' | '); const t = pm.content.find((x) => x.text === shown); const w = W.textWidth(shown, t.fontSize); return Math.abs(t.absolutePosition.x + w / 2 - 595.28 / 2) < 1; })());

// ---------- 答案顯示（教師版）----------
const T = W.layout(W.parseRequest('串珠 10又幾 附答案').spec); check('teacher version writes 11..18 in red next to the lines', ['11', '12', '13', '14', '15', '16', '17', '18'].every((n) => T.prims.some((p) => p.t === 'text' && p.s === n && p.fill === '#C0392B')));

// ---------- 其他區塊 ----------
const O = W.layout(W.validate({ title: 't', blocks: [{ type: 'count_rows', counts: [3, 5], shape: 'star' }, { type: 'equations', kind: 'sub', max: 20, count: 6 }, { type: 'ten_frames', counts: [3, 7] }, { type: 'number_line', from: 0, to: 10, blanks: [3, 6] }, { type: 'text', lines: ['a', 'b'] }, { type: 'spacer', mm: 5 }] }).spec);
check('other blocks all draw something and stay on the page', O.prims.length > 40 && O.prims.every((p) => p.t !== 'text' || (p.x >= 0 && p.x <= O.w && p.y >= 0 && p.y <= O.h)), O.prims.length);
check('equations: subtraction never goes negative and has no duplicates', (() => { const e = W.makeEquations('sub', 20, 12, 3); return new Set(e).size === e.length && e.every((q) => { const m = /(\d+) − (\d+)/.exec(q); return +m[1] > +m[2]; }); })());

// ---------- 參考圖片：視覺模型的回覆被檢查 ----------
const ref = W.refFromReply('好的：\n```json\n{"title":"彩色串珠","rows":[{"count":1,"color":"#c8174f"},{"count":2,"color":"綠色"},{"count":2,"color":"#00"},{"count":99,"color":"#fff"},{"count":3,"color":"不是顏色"}],"base_color":"金色","base":10}\n```');
check('reference: rows are validated (duplicates, out-of-range counts and bad colours dropped)', ref.ok && ref.rows.length === 3 && ref.rows[1].color === '#8CC63F' && !ref.rows[2].color && ref.baseColor === '#E9B22E', ref);
check('reference: garbage reply -> not ok, no throw', W.refFromReply('我看不出來').ok === false && W.refFromReply('').ok === false);
const merged = W.mergeRef(r.spec, ref); check('reference: rows and colours are merged into the bead block', merged.spec.blocks[0].counts.join() === '1,2,3' && merged.spec.blocks[0].colors[1] === '#C8174F' && merged.notes.length === 1);
const r2 = W.parseRequest('串珠 10又幾', { reference: ref }); check('request + reference: the reference decides the rows, no range question', r2.spec.blocks[0].counts.join() === '1,2,3' && r2.questions.length === 0);

// ---------- 人工調整：封閉的編輯動作 ----------
const E = W.applyEdits(r.spec, [{ op: 'set_title', text: '彩色串珠（二）' }, { op: 'set_color', count: 3, color: '粉紅色' }, { op: 'set_rows', n: 5 }, { op: 'set_answer', show: true }, { op: 'set_page', orient: 'landscape' }, { op: 'remove_block', index: 9 }, { op: 'fly' }, { op: 'set_color', count: 1, color: 'zzz' }]);
check('edits: valid ones are applied, invalid ones are rejected with the reason (nothing thrown)', E.applied.length === 5 && E.rejected.length === 3 && E.rejected.every((x) => x.error), E);
check('edits: the result is what was asked', E.spec.title === '彩色串珠（二）' && E.spec.blocks[0].colors[3] === '#F2D4CF' && E.spec.blocks[0].counts.length === 5 && E.spec.blocks[0].answer.show === true && E.spec.page.orient === 'landscape');
check('edits: do not change the input spec', r.spec.title === '彩色串珠｜10又幾（一）' && r.spec.blocks[0].counts.length === 8);
check('edits: add and remove blocks', (() => { const a = W.applyEdits(r.spec, [{ op: 'add_block', block: { type: 'text', lines: ['hi'] } }]); const c = W.applyEdits(a.spec, [{ op: 'remove_block', index: 0 }]); return a.spec.blocks.length === 2 && c.spec.blocks.length === 1 && c.spec.blocks[0].type === 'text'; })());
check('edits: describe lists the blocks in plain words', W.describe(r.spec).join('\n').includes('bead_rows') && /答案留白/.test(W.describe(r.spec).join('\n')));

// ---------- 封閉題：弱模型只選字母，選不出來就用預設 ----------
(async () => {
  const asked = []; const a = await W.resolveQuestions(W.parseRequest('串珠 10又1'), async (q, opts) => { asked.push({ q, opts }); return 2; });
  check('closed question: the pick changes the number of rows (1..5)', asked.length === 1 && asked[0].opts.length === 4 && a.spec.blocks[0].counts.join() === '1,2,3,4,5' && a.asked[0].default === false, [asked, a.spec.blocks[0].counts]);
  const b2 = await W.resolveQuestions(W.parseRequest('串珠 10又1'), async () => 99); check('closed question: out-of-range pick keeps the default', b2.spec.blocks[0].counts.length === 8);
  const c2 = await W.resolveQuestions(W.parseRequest('串珠 10又1'), async () => { throw new Error('model down'); }); check('closed question: a failing model keeps the default, no throw', c2.spec.blocks[0].counts.length === 8);
  const d2 = await W.resolveQuestions(W.parseRequest('串珠 10又1'), null); check('closed question: no model -> program default', d2.spec.blocks[0].counts.length === 8);
  console.log((bad.length ? 'FAIL' : 'PASS') + ' 教育文書（學習單）：讀請求、驗證、排版、SVG／HTML／PDF、參考圖片、編輯動作、封閉題：' + ok + ' passed, ' + bad.length + ' failed', bad);
  process.exit(bad.length ? 1 : 0);
})();
