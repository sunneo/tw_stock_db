// node scripts/knowledge-tests/knowledge_core.test.js -- Knowledge Inventory 核心：各格式整理成帶行號的來源、出處、檢索（關鍵字＋向量）、原句摘要、核對、關聯
const K = require('../../renderer/src/knowledge/knowledge_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 500) : '')); }

// ---- 斷詞
check('tokenize: latin words lowercased, CJK as unigrams + bigrams', K.tokenize('Hello World 蜘蛛網').join('|') === 'hello|world|蜘|蜘蛛|蛛|蛛網|網');
check('tokenize: version / file-like words stay whole, trailing punctuation dropped', K.tokenize('flux.1-schnell v2.0.').join('|') === 'flux.1-schnell|v2.0');

// ---- 純文字：行號就是檔案的行號
const wiki = '# 蜘蛛\n\n蜘蛛是節肢動物，身體分成頭胸部和腹部。\n\n## 習性\n\n多數蜘蛛會結網捕食昆蟲。\n部分蜘蛛不結網，直接獵捕。\n\n## 分類\n\n目前已知四萬多種蜘蛛。\n';
const s1 = K.ingest({ id: 'k1', name: '蜘蛛.md', kind: 'md', raw: wiki });
check('ingest md: lines are the file lines; sections with line ranges', s1.lines.length === 13 && s1.sections.map((s) => s.title + '@' + s.line_start).join('|') === '蜘蛛@1|習性@5|分類@10', s1.sections);
check('ingest: chunks cover every line exactly once, each with its line range', s1.chunks.length >= 1 && s1.chunks[0].line_start === 1 && s1.chunks[s1.chunks.length - 1].line_end === s1.lines.length && s1.chunks.every((c, i) => i === 0 || c.line_start === s1.chunks[i - 1].line_end + 1), s1.chunks.map((c) => [c.line_start, c.line_end]));
check('chunks break at section boundaries', s1.chunks.some((c) => c.section === '習性') && s1.chunks.some((c) => c.section === '分類'));

// ---- 各種格式
const js = K.ingest({ name: 'a.json', kind: 'json', raw: '{"name":"x","items":[{"id":1,"title":"第一個"}],"meta":{"owner":"Bob"}}' });
check('json is pretty-printed and noted; lines carry field paths', /格式化/.test(js.notes.join()) && js.lines.length > 5 && js.locators.some((l) => l.path === 'meta.owner'), js.locators.slice(0, 12));
const jl = K.ingest({ name: 'log.jsonl', kind: 'jsonl', raw: '{"a":1}\n{"a":2}\n{"a":3}\n' });
check('jsonl: line N is record N', jl.locators[1].record === 2);
const csv = K.ingest({ name: 'd.csv', kind: 'csv', raw: 'name,qty\n蘋果,3\n香蕉,5\n' });
check('csv: line numbers are the file line numbers (header is line 1)', csv.lines[1] === '蘋果,3' && /第 1 行是欄位名稱/.test(csv.notes.join()));
const xl = K.ingest({ name: 'b.xlsx', kind: 'xlsx', raw: { sheets: [{ name: '銷售', rows: [['品名', '數量'], ['蘋果', 3]] }, { name: '庫存', rows: [['A', 1]] }] } });
check('xlsx: one line per row, "sheet!row", locator has sheet and row', xl.lines[1] === '銷售!2：蘋果 | 3' && xl.locators[2].sheet === '庫存' && xl.locators[2].row === 1);
const pdf = K.ingest({ name: '報告.pdf', kind: 'pdf', raw: '[第 1 頁]\n前言內容在這裡。\n[第 2 頁]\n結論：預算增加百分之十。\n' });
check('page markers become locators for the lines after them', pdf.locators[1].page === 1 && pdf.locators[3].page === 2);
const tr = K.ingest({ name: '會議.mp3', kind: 'mp3', raw: '[00:00:05]\n大家好，開始開會。\n[00:01:30]\n下週三交付報告。\n' });
check('transcript time markers become locators', tr.locators[3].time === '00:01:30');
const mw = K.ingest({ name: 'w.mediawiki', kind: 'mediawiki', raw: '導言文字，足夠長的一段話說明主題。\n== 歷史 ==\n很久以前。\n== 現況 ==\n現在。\n' });
check('mediawiki / textile headings are sections', mw.outline_style === 'mediawiki' && K.ingest({ name: 't.textile', kind: 'textile', raw: 'h1. 標題\n內容一\nh2. 小節\n內容二\n' }).sections.length === 2);

// ---- 出處
const c1 = K.cite(s1, 7, 8, 'x');
check('cite: source name, line range, section', c1.label === '「蜘蛛.md」第 7–8 行，章節「習性」' && c1.section === '習性' && c1.line_start === 7);
check('cite: json says the lines are formatted lines; pdf shows the page', /格式化後/.test(K.cite(js, 3, 3, '').label) && /第 2 頁/.test(K.cite(pdf, 4, 4, '').label) && /工作表 銷售 第 2 列/.test(K.cite(xl, 2, 2, '').label));

// ---- 檢索：關鍵字
const s2 = K.ingest({ id: 'k2', name: '會議.mp3', kind: 'mp3', raw: '[00:00:05]\n大家好，開始開會。\n[00:01:30]\n下週三交付報告，預算增加百分之十。\n' });
const idx = K.buildIndex([s1, s2, pdf]);
const h1 = K.search(idx, '蜘蛛怎麼結網');
check('search: finds the chunk that really talks about spider webs, with line numbers', h1.length >= 1 && h1[0].source === '蜘蛛.md' && h1[0].line_start <= 7 && h1[0].line_end >= 7 && /結網/.test(h1[0].quote), h1[0]);
const h2 = K.search(idx, '預算');
check('search: across sources (transcript + pdf), each hit has its source and place', h2.some((h) => h.source === '會議.mp3' && /00:01:30/.test(h.label)) && h2.some((h) => h.source === '報告.pdf' && /第 2 頁/.test(h.label)), h2.map((h) => h.label));
check('search: nothing relevant → nothing (no made-up answer)', K.search(idx, '量子電腦的退火演算法').length === 0);
check('search: limited to chosen sources', K.search(idx, '預算', { sources: ['k2'] }).every((h) => h.source === '會議.mp3'));

// ---- 檢索：混合（向量）
const vec = (a) => { const n = Math.hypot.apply(null, a); return a.map((x) => x / n); };
const idx2 = K.buildIndex([s1]);
idx2.docs.forEach((d) => { d.vec = vec(/結網/.test(d.ch.text) ? [1, 0.1, 0] : [0, 1, 0.2]); });
const hv = K.searchHybrid(idx2, '蜘蛛織網的方式', { queryVec: vec([1, 0.05, 0]), limit: 3 });
check('hybrid: a semantic-only hit (no shared keyword) is found, marked as found by meaning', hv.length >= 1 && /結網/.test(hv[0].quote) && /語意/.test(hv[0].found_by), hv);
const hv2 = K.searchHybrid(idx2, '蜘蛛結網', { queryVec: vec([1, 0.05, 0]) });
check('hybrid: found by both → both marked', /關鍵字＋語意|語意＋關鍵字/.test(hv2[0].found_by), hv2[0]);
check('hybrid: a vector that is not close enough is ignored', K.searchHybrid(idx2, '完全無關', { queryVec: vec([0, 0, 1]) }).length === 0);

// ---- 向量門檻（用實測的 e5-small 分數校準）
const mk = (sims) => sims.map((s, i) => ({ id: i, sim: s }));
check('denseKeep: related (0.86+) kept, unrelated (<=0.82) dropped', K.denseKeep(mk([0.863, 0.9, 0.855, 0.778, 0.801])).length === 3 && K.denseKeep(mk([0.787, 0.797, 0.795, 0.821, 0.795])).length === 0);
check('denseKeep: cross-language hit (0.777 vs the rest ~0.72) kept by the gap rule', K.denseKeep(mk([0.726, 0.777, 0.733, 0.683, 0.715])).map((x) => x.id).join() === '1');
check('denseKeep: a flat pool (everything ~0.80) gives nothing, even the top one', K.denseKeep(mk([0.794, 0.814, 0.811, 0.803, 0.793])).length === 0);
check('denseKeep: with fewer than 5 chunks only the strict rule applies', K.denseKeep(mk([0.78, 0.7])).length === 0 && K.denseKeep(mk([0.9, 0.7])).length === 1);

// ---- 回答：只交出原文
const ans = K.answer(idx, '蜘蛛怎麼結網');
check('answer: returns quotes with labels, found:true', ans.found && ans.hits[0].quote && ans.hits[0].label.indexOf('蜘蛛.md') >= 0);
check('answer: not found says so', K.answer(idx, '量子電腦的退火演算法').found === false);

// ---- 摘要：只選原句，每句都核對得過
const sm = K.summarize(s1, { perSection: 1 });
check('summarize: every sentence is verbatim from its line, with a citation', sm.length >= 2 && K.verifyAll(s1, sm).ok && sm.every((x) => x.label && x.line_start >= 1), sm);
check('summarize: never invents text — every quote is a substring of the source', sm.every((x) => s1.text.indexOf(x.quote) >= 0));
check('verifyQuote: whitespace differences are fine, changed words are not', K.verifyQuote(s1, '多數蜘蛛 會結網 捕食昆蟲', 7, 8) === true && K.verifyQuote(s1, '多數蜘蛛會織網捕食昆蟲', 7, 8) === false);
check('verifyAll reports the ones that do not check out', K.verifyAll(s1, [{ quote: '憑空捏造的一句話', line_start: 1, line_end: 13 }]).bad.length === 1);

// ---- 細節
const dt = K.detail(s1, '習性');
check('detail: the section lines, each with its line number', dt.lines[0].line === 5 && dt.lines.some((l) => /不結網/.test(l.text) && l.line === 8) && !dt.truncated, dt);
check('detail by line range and unknown section', K.detail(s1, { line_start: 3, line_end: 3 }).lines[0].text.indexOf('節肢動物') >= 0 && !!K.detail(s1, '不存在').error);

// ---- 關聯：只用字面證據
const a = K.ingest({ id: 'a', name: '會議記錄.txt', kind: 'txt', raw: '本次討論參考 專案計畫 的進度。\n負責人是 Alice Johnson。\n' });
const b = K.ingest({ id: 'b', name: '專案計畫.md', kind: 'md', raw: '# 專案計畫\n專案經理 Alice Johnson 負責整體進度。\n' });
const lk = K.links([a, b]);
check('links: "mentions" when one source names another, with the line', lk.some((l) => l.kind === 'mentions' && l.from.source === '會議記錄.txt' && l.to.source === '專案計畫.md' && l.from.line_start === 1), lk);
check('links: shared term with both sides cited', lk.some((l) => l.kind === 'shared_term' && l.term === 'Alice Johnson' && l.from.line_start === 2 && l.to.line_start === 2), lk);
check('links: every link quote is really in its source', lk.every((l) => (l.kind !== 'mentions' || a.text.indexOf(l.from.quote.slice(0, 20)) >= 0)));

// ---- 空與壞輸入
check('empty source does not crash and yields no chunks', K.ingest({ name: 'e.txt', kind: 'txt', raw: '' }).chunks.length === 0 && K.buildIndex([K.ingest({ name: 'e.txt', kind: 'txt', raw: '' })]).n === 0);
check('bad json falls back to plain text with a note', /解析失敗/.test(K.ingest({ name: 'x.json', kind: 'json', raw: '{oops' }).notes.join()));
console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'knowledge_core: ' + ok + ' passed');
process.exit(bad.length ? 1 : 0);
