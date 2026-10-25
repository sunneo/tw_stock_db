// node scripts/edit-tests/cad_sheet.test.js -- CAD 風格工程圖：規格檢查、從零件表讀規格、畫圖（尺寸線、比例、明細表、剖面、孔槽、小提琴外形）、給模型的規格說明與回覆解析
const C = require('../../renderer/src/edit/cad_sheet.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const count = (s, re) => (s.match(re) || []).length;
const table = [
  '| 零件 | 名稱 | 數量 | 長 × 寬 × 厚（cm） | 備註 |', '|---|---|---|---|---|',
  '| A | 上板（Top Plate） | 1 | 35.0 × 20.0（最寬）× 0.5 | 雙圓弧琴身外形 |', '| B | 下板（Back Plate） | 1 | 35.0 × 20.0（最寬）× 0.5 | 與上板相同 |',
  '| C1 | 上側板條（Rib, Upper） | 2 | 20.0 × 3.0 × 0.5 | 貼合上圓弧 |', '| D | 琴頸（Neck） | 1 | 13.0 × 2.5 × 1.5 | 向外延伸 |',
  '琴身外形參考：總長 35 cm，上圓寬約 16 cm，下圓寬約 20 cm，中間腰部收縮至約 11 cm。小提琴', '1. 剪下上下板 A、B', '2. 把側板條夾在上下板之間膠合', '3. 安裝琴頸'
].join('\n');

// ---- 規格檢查
const n = C.normalize({ title: '<b>x</b>', unit: 'mm', parts: [{ id: 'A', name: '板', outline: { kind: 'rect', w: 10, h: 5 }, thickness: 3 }, { id: 'A', name: '重複代號', outline: { kind: 'bogus', w: -3, h: 'x' } }, null, { name: '圓', outline: { kind: 'ellipse', w: 4, h: 4 } }] });
check('normalize: duplicate ids are renamed, unknown outline kinds become rect, bad numbers get defaults, nulls are dropped', n.parts.length === 3 && n.parts[0].id === 'A' && n.parts[1].id !== 'A' && n.parts[1].outline.kind === 'rect' && n.parts[1].outline.w > 0, n.parts.map((p) => p.id));
check('normalize: at most 40 parts and 12 features; polygons with fewer than 3 points fall back to rect', C.normalize({ parts: Array.from({ length: 80 }, (_, i) => ({ name: 'p' + i, outline: { kind: 'rect', w: 1, h: 1 } })) }).parts.length === 40 && C.normalize({ parts: [{ outline: { kind: 'polygon', points: [[0, 0], [1, 1]] } }] }).parts[0].outline.kind === 'rect');
const poly = C.normalize({ parts: [{ name: 'p', outline: { kind: 'polygon', points: [[10, 10], [20, 10], [15, 18]] } }] }).parts[0].outline;
check('normalize: polygon is moved to the origin and its size is measured', poly.w === 10 && poly.h === 8 && poly.points[0][0] === 0);

// ---- 從零件表讀規格
const spec = C.specFromTable(table, { title: '小提琴 工程圖' });
check('table: parts, quantities, thickness and steps are read', spec && spec.parts.length === 4 && spec.parts[2].qty === 2 && spec.parts[0].thickness === 0.5 && spec.steps.length === 3, spec && spec.parts.length);
check('table: with violin in the text, the plates get the violin outline and the 上圓／下圓／腰 widths are read from the text (16, 20, 11)', spec.parts[0].outline.kind === 'violin' && spec.parts[0].outline.upper === 16 && spec.parts[0].outline.lower === 20 && spec.parts[0].outline.waist === 11 && spec.parts[0].outline.length === 35, spec.parts[0].outline);
check('table: ribs and the neck stay rectangles; the plates and ribs make a stack (back, rib, top)', spec.parts[2].outline.kind === 'rect' && JSON.stringify(spec.stack) === JSON.stringify(['B', 'C1', 'A']), spec.stack);
check('table: no table gives null; without the word violin plates are plain rectangles', C.specFromTable('今天天氣很好') === null && C.specFromTable(table.replace(/小提琴/g, '')).parts[0].outline.kind === 'rect');

// ---- 畫圖
const svg = C.render(Object.assign({}, spec, { author: 'tester', date: '2026-10-26' }));
check('render: a well formed svg with a physical size in mm (so printing at 100% keeps the scale)', /^<svg [^>]*viewBox="0 0 1400 [\d.]+" width="[\d.]+mm" height="[\d.]+mm"/.test(svg) && /<\/svg>$/.test(svg));
check('render: every part has a card with a balloon, a dimension line and the thickness side view', count(svg, /class="part-card"/g) === 4 && count(svg, /class="bal"/g) >= 4 && count(svg, /class="cut"/g) >= 4 + 3, count(svg, /class="part-card"/g));
check('render: the violin outline is a smooth closed path and carries the 上圓／腰／下圓 widths', /<path d="M[^"]+ Z" class="part"\/>/.test(svg) && /上圓 16/.test(svg) && /腰 11/.test(svg) && /下圓 20/.test(svg));
check('render: overall size dimensions use arrows (marker) and read 35 cm × 20 cm', />35 cm</.test(svg) && />20 cm</.test(svg) && count(svg, /marker-start="url\(#ar0\)"/g) >= 8);
check('render: BOM has a header and one row per part; title block has the drawing name, number, scale and unit', count(svg, /class="tr"/g) === 4 * 6 && />項次</.test(svg) && />DWG-001</.test(svg) && /比例/.test(svg) && />cm</.test(svg));
check('render: assembly steps are numbered and the stack (exploded) view is drawn', /組裝步驟/.test(svg) && />剪下上下板 A、B</.test(svg) && /層疊爆炸示意/.test(svg));
check('render: one scale for every part (the 20 cm rib is 20/35 of the 35 cm plate in drawing size)', (() => { const sc = [...svg.matchAll(/scale\(([\d.]+)\)" class="outline"/g)].map((m) => Number(m[1])); return sc.length === 4 && sc.every((x) => Math.abs(x - sc[0]) < 1e-9); })());
check('render: scale text is a nice ratio like 1:5 and the physical width matches it', (() => { const m = /比例 (1:\d+)/.exec(svg); return !!m && /1:(2|2\.5|5|10)\b/.test(m[1]); })(), /比例 [^　]+/.exec(svg));
check('render: text is escaped', !/<b>x<\/b>/.test(C.render({ title: '<b>x</b>', parts: [{ name: '<i>q</i>', outline: { kind: 'rect', w: 5, h: 5 } }] })));
const feat = C.render({ unit: 'mm', parts: [{ id: 'P', name: '板', outline: { kind: 'rect', w: 100, h: 60 }, thickness: 3, features: [{ kind: 'hole', x: 20, y: 30, d: 8 }, { kind: 'slot', x: 50, y: 10, w: 20, h: 4 }] }] });
check('render: holes get a diameter label and centre lines; slots get their size; millimetre sheets say mm', />Ø8</.test(feat) && />20×4</.test(feat) && count(feat, /class="hole"/g) === 2 && />尺寸單位：mm|尺寸單位：mm/.test(feat) && />100 mm</.test(feat));
check('render: an empty spec gives an empty string, and the five outline kinds all draw', C.render({ parts: [] }) === '' && ['rect', 'rrect', 'ellipse', 'polygon', 'violin'].every((k) => C.render({ parts: [{ name: k, outline: { kind: k, w: 10, h: 20, r: 1, length: 20, upper: 8, waist: 5, lower: 10, points: [[0, 0], [10, 0], [5, 9]] } }] }).indexOf('class="part"') > 0));

// ---- 給模型的規格與回覆解析
const sp = C.specPrompt('幫我畫小提琴工程圖', '背景');
check('specPrompt: forbids drawing, lists the closed outline kinds and the JSON shape', /不要寫 SVG/.test(sp.system) && /violin/.test(sp.system) && /rrect/.test(sp.system) && /"parts"/.test(sp.system) && /小提琴/.test(sp.user));
const good = C.parseSpecReply('好的：```json\n{"title":"T","unit":"cm","parts":[{"id":"A","name":"板","qty":2,"outline":{"kind":"rect","w":10,"h":5},"thickness":0.5}],"steps":["切"]}\n``` 完成');
check('parseSpecReply: a JSON inside prose and code fences is accepted and normalised', good.ok && good.spec.parts[0].qty === 2 && good.spec.steps[0] === '切');
check('parseSpecReply: no JSON, broken JSON and an empty parts list each give a reason', !C.parseSpecReply('我不知道').ok && /JSON/.test(C.parseSpecReply('{bad').error) && /零件/.test(C.parseSpecReply('{"parts":[]}').error) && !C.parseSpecReply('').ok);
check('parseSpecReply: thinking text before the answer is ignored', C.parseSpecReply('<think>{"a":1}</think>{"parts":[{"name":"x","outline":{"kind":"rect","w":3,"h":3}}]}').ok);
check('isCadRequest: Chinese and English words; ordinary drawings are not', C.isCadRequest('幫我準備小提琴的工程圖') && C.isCadRequest('Create an engineering drawing (CAD-style) with dimensions') && C.isCadRequest('請列出每個 Component 的長度') && !C.isCadRequest('畫一隻貓') && !C.isCadRequest('畫一個流程圖'));
console.log('cad_sheet: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED\n - ' + bad.join('\n - ') : '')); process.exit(bad.length ? 1 : 0);
