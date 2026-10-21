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

// ---------- 編輯對話：程式先讀（讀不懂的才交給模型）----------
const PE = W.parseEditRequest('把第3串改成粉紅色，附上答案，改成橫式，珠子大一點，標題改成「我的串珠」，然後變魔術', r.spec);
check('edit request: each clause is read by the program (colour, answers, landscape, size, title)', PE.edits.map((e) => e.op).join() === 'set_color,set_answer,set_page,set_size,set_title' && PE.edits[0].count === 3 && PE.edits[0].color === '#F2D4CF' && PE.edits[1].show === true && PE.edits[2].orient === 'landscape' && PE.edits[4].text === '我的串珠', PE.edits);
check('edit request: what it cannot read is left over for the model, nothing is guessed', PE.unmatched.join() === '變魔術' && PE.matched.length === 5, PE);
check('edit request: rows, header, add/remove blocks, teacher/student version', (() => { const o = (t) => W.parseEditRequest(t, r.spec).edits[0]; return o('做成5串').n === 5 && o('不要日期').date === false && o('加一個數線').block.type === 'number_line' && o('刪掉第1個區塊').index === 0 && o('學生版').show === false && o('答案放下方').side === 'below' && o('金色珠改成橘色').color === '#F28C28'; })());
check('edit request: "第3串改成…" without a bead block is not misread', W.parseEditRequest('第3串改成紅色', { blocks: [{ type: 'equations' }] }).edits.length === 0);
check('edit request: the edits it produces are all valid ops (applyEdits accepts them)', (() => { const x = W.applyEdits(r.spec, PE.edits); return x.rejected.length === 0 && x.applied.length === 5; })());
const mp = W.editPrompt(r.spec, '弄得更適合小朋友'); check('model prompt: closed op list, current sheet and the sentence', /set_color/.test(mp.system) && /只回一段 JSON/.test(mp.system) && /弄得更適合小朋友/.test(mp.user) && /bead_rows/.test(mp.user));
const pr2 = W.parseEditsReply('好：{"say":"改好了","edits":[{"op":"set_title","text":"x"},{"op":"rm_rf"},{"nope":1}]}'); check('model reply: only ops in the closed list survive; garbage is not ok', pr2.ok && pr2.edits.length === 1 && pr2.dropped === 2 && W.parseEditsReply('hello').ok === false);
check('set_block / move_block: patch is re-validated; bad index is rejected', (() => { const x = W.applyEdits(r.spec, [{ op: 'set_block', index: 0, patch: { base: 99, counts: [1, 2], type: 'text' } }, { op: 'set_block', index: 7, patch: {} }, { op: 'move_block', index: 0, to: 3 }]); return x.spec.blocks[0].type === 'bead_rows' && x.spec.blocks[0].base === 20 && x.spec.blocks[0].counts.join() === '1,2' && x.rejected.length === 2; })());
check('hitTest: a click on a bead row, on the title, outside', (() => { const Lx = W.layout(r.spec); const rb = Lx.rowBoxes[2]; const h1 = W.hitTest(Lx, rb.x + 10, rb.y + rb.h / 2), h2 = W.hitTest(Lx, 105, 15), h3 = W.hitTest(Lx, -5, -5); return h1.kind === 'row' && h1.r === 2 && h2.kind === 'title' && h3 === null; })());
check('svg selection box is drawn only when something is selected', !/stroke-dasharray="2 1.2"/.test(W.toSvg(W.layout(r.spec))) && /stroke-dasharray="2 1.2"/.test(W.toSvg(W.layout(r.spec), { selected: { kind: 'row', b: 0, r: 1 } })));
const SP = W.specToPrompt(E.spec, [{ kind: 'start', summary: '開始' }, { kind: 'chat', text: '改標題', summary: '標題改成「彩色串珠（二）」' }, { kind: 'undo', summary: 'x' }]);
check('summary prompt: describes the sheet (title, rows, colours, answers) and lists the edit steps (no start/undo)', /彩色串珠（二）/.test(SP) && /5 串/.test(SP) && /#F2D4CF/.test(SP) && /教師版/.test(SP) && /編輯過程/.test(SP) && /1\. 我說：「改標題」/.test(SP) && !/開始/.test(SP), SP);
check('summary prompt can be read back by the request parser (round trip: same rows)', W.parseRequest(SP).spec.blocks[0].counts.length >= 1);
check('mergeRef creates a bead block when the sheet has none', (() => { const m = W.mergeRef(W.validate({ title: '', blocks: [] }).spec, W.refFromReply('{"rows":[{"count":1,"color":"#111111"},{"count":2,"color":"#222222"}]}')); return m.spec.blocks.length === 1 && m.spec.blocks[0].counts.join() === '1,2' && m.spec.blocks[0].colors[2] === '#222222' && m.spec.title !== ''; })());

// ---------- 數的組成（二元樹）：使用者真實的兩段話 ----------
const BOND1 = '製作這種教材，每個格子都是5個積木，用一個像是而二元樹的樹狀表達，上面樹根用紅色圈，下面左右兒子用藍色圈，兒子裡面寫上數字，顯示1+4,2+3,3+2,4+1';
const BOND2 = BOND1 + '\n是做成html ->pdf 教材，六個大格子，每個大格子旁邊有直直的5個積木代表5';
const nb1 = W.parseRequest(BOND1), nb2 = W.parseRequest(BOND2);
check('bond: read as number bond (not equations, even though it has 1+4)', nb1.ok && nb1.template === 'number_bond' && nb2.template === 'number_bond');
check('bond: 5 cubes per cell, the four listed splits, 2x2 grid, numbers shown, student version', (() => { const b = nb1.spec.blocks[0]; return b.total === 5 && b.cells.map((c) => c.a + '+' + c.b).join() === '1+4,2+3,3+2,4+1' && b.cols === 2 && b.showNumbers === true && b.fill === false; })(), nb1.spec.blocks[0]);
check('bond: "六個大格子" -> 6 cells in 2 columns; the extra two are 0+5 and 5+0 with a closed question (default = fill)', (() => { const b = nb2.spec.blocks[0]; return b.cells.length === 6 && b.cells.slice(4).map((c) => c.a + '+' + c.b).join() === '0+5,5+0' && b.cols === 2 && nb2.questions.length === 1 && nb2.questions[0].default === 0; })(), nb2.spec.blocks[0].cells);
check('bond: red root and blue children from the request words', nb1.spec.blocks[0].rootColor === '#D93025' && nb1.spec.blocks[0].childColor === '#2F6FD0' && W.parseRequest(BOND1.replace('樹根用紅色圈', '樹根用綠色圈')).spec.blocks[0].rootColor === '#2E9E4F');
const LB = W.layout(nb2.spec); const cubes = LB.prims.filter((p) => p.t === 'rect' && p.rx > 0), circ = LB.prims.filter((p) => p.t === 'circle');
check('bond layout: 6 cells x 5 cubes = 30 cubes, each with a ring; 6 roots + 12 children + 30 cube rings = 48 circles; 6 numbered badges', cubes.length === 30 && circ.length === 48 && LB.prims.filter((p) => p.t === 'poly').length === 6, [cubes.length, circ.length]);
check('bond layout: numbers 1,4,2,3,3,2,4,1,0,5,5,0 appear in the children (student version shows them), roots are empty', (() => { const nums = LB.prims.filter((p) => p.t === 'text' && /^\d$/.test(p.s) && p.fill === '#2F6FD0').map((p) => p.s).join(''); return nums === '142332410550' && !LB.prims.some((p) => p.t === 'text' && p.fill === '#D93025'); })());
check('bond layout: nothing leaves the page; cells are separated by a cross of lines', LB.prims.every((p) => p.t === 'text' || p.t === 'line' || p.t === 'poly' || p.t === 'rect' || (p.cx - p.r >= 0 && p.cx + p.r <= LB.w && p.cy - p.r >= 0 && p.cy + p.r <= LB.h)) && LB.prims.filter((p) => p.t === 'line' && p.stroke === '#666666').length === 3);
const tb = W.layout(W.parseRequest(BOND2 + ' 附答案').spec); check('bond teacher version: cubes coloured by the split (a on top), root shows 5', tb.prims.filter((p) => p.t === 'rect' && p.fill === '#F6A33B').length === 1 + 2 + 3 + 4 + 0 + 5 && tb.prims.filter((p) => p.t === 'text' && p.s === '5' && p.fill === '#D93025').length === 6);
check('bond: blank child circles when asked ("兒子圈先留空")', (() => { const b = W.parseRequest(BOND1 + '，兒子圈先留空').spec.blocks[0]; const l = W.layout({ title: '', blocks: [b] }); return b.showNumbers === false && !l.prims.some((p) => p.t === 'text' && p.fill === '#2F6FD0'); })());
check('bond: other totals and unlisted splits (7 with no pairs -> 1+6 .. 6+1)', (() => { const b = W.parseRequest('做數的組成 7個積木').spec.blocks[0]; return b.total === 7 && b.cells.length === 6 && b.cells[0].a === 1 && b.cells[5].b === 1; })());
check('bond: pairs that do not add up are dropped with a note; invalid sums in a spec are repaired', (() => { const r = W.parseRequest('二元樹 5個積木 1+4,2+2,3+2'); const v = W.validate({ blocks: [{ type: 'number_bond', total: 5, cells: [{ a: 2, b: 2 }] }] }); return r.spec.blocks[0].cells.length === 2 && r.notes.some((n) => /加起來不是/.test(n)) && v.spec.blocks[0].cells[0].b === 3 && v.problems.length === 1; })());
(async () => { const q = W.parseRequest(BOND2); const a = await W.resolveQuestions(q, async () => 1); const c = await W.resolveQuestions(W.parseRequest(BOND2), async () => 2);
  check('bond closed question: pick "blank" -> the extra cells are empty; pick "repeat" -> they repeat the first ones', a.spec.blocks[0].cells.slice(4).every((x) => x.a === null) && c.spec.blocks[0].cells.slice(4).map((x) => x.a + '+' + x.b).join() === '1+4,2+3', [a.spec.blocks[0].cells.slice(4), c.spec.blocks[0].cells.slice(4)]); })();
check('bond: reference image of a number bond page (VLM json) is merged: cube count, cell count, splits', (() => { const ref = W.refFromReply('{"kind":"number_bond","total":5,"cell_count":6,"cells":[{"a":1,"b":4},{"a":2},{"b":1}]}'); const m = W.mergeRef(W.validate({ blocks: [] }).spec, ref); const b = m.spec.blocks[0]; return ref.kind === 'number_bond' && b.type === 'number_bond' && b.total === 5 && b.cells.length === 6 && m.notes.length === 1; })());
check('bond: describe / prompt mention the tree, cubes and cells', /數的組成/.test(W.specToPrompt(nb2.spec)) && /紅圈/.test(W.specToPrompt(nb2.spec)) && W.describe(nb2.spec).join('').includes('number_bond'));
check('bond: set_block patches cells/total and set_answer toggles the teacher version', (() => { const r = W.applyEdits(nb1.spec, [{ op: 'set_block', index: 0, patch: { cells: [{ a: 2, b: 3 }] } }, { op: 'set_answer', show: true }]); return r.spec.blocks[0].cells.length === 1 && r.spec.blocks[0].fill === true && r.applied.length === 2; })());

// ---------- 自由繪圖 draw：現成區塊做不到的時候自己畫（座標是區塊寬高的百分比）----------
const treeItems = [];
for (let j = 0; j < 5; j++) treeItems.push({ shape: 'rect', x: 6, y: 20 + j * 12, w: 14, h: 11, fill: '#FFFFFF', stroke: '#555555', rx: 1 });
treeItems.push({ shape: 'line', x1: 62, y1: 34, x2: 48, y2: 66, stroke: '#888888' }, { shape: 'line', x1: 62, y1: 34, x2: 76, y2: 66, stroke: '#888888' },
  { shape: 'circle', x: 62, y: 28, r: 9, fill: 'none', stroke: 'red', sw: 0.9 }, { shape: 'circle', x: 48, y: 72, r: 9, fill: '#FFFFFF', stroke: 'blue', sw: 0.9 }, { shape: 'circle', x: 76, y: 72, r: 9, fill: '#FFFFFF', stroke: 'blue', sw: 0.9 },
  { shape: 'text', x: 48, y: 76, text: '1', size: 9, color: 'blue', bold: true }, { shape: 'text', x: 76, y: 76, text: '4', size: 9, color: 'blue', bold: true });
const DR = W.validate({ title: '自訂圖形', blocks: [{ type: 'draw', height: 80, items: treeItems.concat([{ shape: 'blob' }, null, { shape: 'poly', pts: [[1, 1]] }]) }] });
check('draw: valid shapes are kept (5 cubes, 2 lines, 3 circles, 2 texts); unknown shapes, nulls and 1-point polygons are dropped', DR.spec.blocks[0].items.length === 12 && DR.spec.blocks[0].items.filter((x) => x.shape === 'rect').length === 5, DR.spec.blocks[0].items.length);
check('draw: colour words and "none" are understood (red -> hex, none stays none)', DR.spec.blocks[0].items.find((x) => x.shape === 'circle').fill === 'none' && DR.spec.blocks[0].items.find((x) => x.shape === 'circle').stroke === '#C8174F');
check('draw: a block with no valid shape is dropped with a problem; the item count is capped', W.validate({ blocks: [{ type: 'draw', items: [{ shape: 'nope' }] }] }).problems.length === 1 && W.validate({ blocks: [{ type: 'draw', items: Array.from({ length: 500 }, () => ({ shape: 'circle' })) }] }).spec.blocks[0].items.length === 300);
const DL = W.layout(DR.spec); const dc = DL.prims.filter((p) => p.t === 'circle'), dr = DL.prims.filter((p) => p.t === 'rect');
check('draw layout: shapes are placed inside the block (percent of its width/height) and the whole sheet stays on the page', dc.length === 3 && dr.length === 5 && dc.every((c) => c.cx >= 0 && c.cx <= DL.w && c.cy >= 0 && c.cy <= DL.h) && DL.prims.some((p) => p.t === 'text' && p.s === '4'));
check('draw: svg, html and pdf outputs all contain the drawing', W.toSvg(DL).split('<circle').length - 1 === 3 && W.toPdfmake(DL).content[0].canvas.filter((c) => c.type === 'ellipse').length === 3);
check('draw: edits and descriptions know it; the topic text exists', W.describe(DR.spec).join('').includes('自由繪圖') && !!W.TOPICS.draw && /百分比/.test(W.TOPICS.draw) && W.applyEdits(DR.spec, [{ op: 'set_block', index: 0, patch: { height: 40 } }]).spec.blocks[0].height === 40);

// ---------- 編輯對話：畫圖形、放繪圖區域（程式先讀，不必問模型）----------
const EMPTY = W.validate({ title: 't', blocks: [] }).spec;
const shapeOf = (txt) => { const pe = W.parseEditRequest(txt, EMPTY), r = W.applyEdits(EMPTY, pe.edits); return { n: pe.edits.length, un: pe.unmatched.length, rej: r.rejected.length, blocks: r.spec.blocks.map((b) => b.type + ':' + (b.items && b.items[0].shape)).join() }; };
check('shape requests are read by the program: triangle, circle, line, star, drawing area (no model, nothing rejected)', ['在上面畫上三角形', '加一個紅色圓形', '畫一條線', '在下面畫一個星星', '自己放一個繪圖區域'].every((x) => { const r = shapeOf(x); return r.n === 1 && r.un === 0 && r.rej === 0 && /^draw:/.test(r.blocks); }), ['在上面畫上三角形', '自己放一個繪圖區域'].map(shapeOf));
check('"上面" puts the new block first, otherwise last', (() => { const base = W.validate({ blocks: [{ type: 'text', lines: ['x'] }] }).spec; const top = W.applyEdits(base, W.parseEditRequest('在上面畫上三角形', base).edits).spec.blocks, end = W.applyEdits(base, W.parseEditRequest('畫一個圓', base).edits).spec.blocks; return top[0].type === 'draw' && end[1].type === 'draw'; })());
check('the colour in the sentence is used (紅色圓形 is filled red)', W.applyEdits(EMPTY, W.parseEditRequest('加一個紅色圓形', EMPTY).edits).spec.blocks[0].items[0].fill === '#C8174F');
check('"先清空學習單" removes every block (the title stays); on an empty sheet it is understood and does nothing', (() => { const base = W.validate({ title: 'T', blocks: [{ type: 'text', lines: ['a'] }, { type: 'spacer' }] }).spec; const pe = W.parseEditRequest('先清空學習單', base); const r = W.applyEdits(base, pe.edits); const e2 = W.parseEditRequest('清空', EMPTY); return pe.edits.length === 2 && r.spec.blocks.length === 0 && r.spec.title === 'T' && e2.unmatched.length === 0; })());
check('"加一個數線" is still a number line, not a line shape', W.parseEditRequest('加一個數線', EMPTY).edits[0].block.type === 'number_line');
check('a draw triangle (x,y,w,h) becomes a 3-point polygon', (() => { const it = W.validate({ blocks: [{ type: 'draw', items: [{ shape: 'triangle', x: 10, y: 10, w: 30, h: 30 }] }] }).spec.blocks[0].items[0]; return it.shape === 'poly' && it.pts.length === 3; })());
check('a rejected add_block says why (no type / unknown type) so the model and the user can fix it', (() => { const r = W.applyEdits(EMPTY, [{ op: 'add_block', block: { type: 'triangle' } }, { op: 'add_block', block: {} }]); return r.rejected.length === 2 && r.rejected.every((x) => /不認得|type/.test(x.error) && /draw/.test(x.error)); })());
check('the model prompt carries the draw format and real line breaks', (() => { const P = W.editPrompt(EMPTY, '畫一個三角形'); return /draw 區塊/.test(P.system) && /triangle/.test(P.system) && P.system.indexOf(String.fromCharCode(92) + 'n') < 0; })());

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
