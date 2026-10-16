// node renderer/src/catalog/bind_core.test.js
const C = require('./catalog_core.js'); const MX = require('./matrix_core.js'); const IR = require('./ir_core.js'); const B = require('./bind_core.js'); const U = require('../uml/uml_core.js');
let ok = 0; const bad = []; const check = (n, c, x) => { if (c) ok++; else bad.push(n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 700) : '')); };

const mk = (id, params, returns, extra) => Object.assign({ id, runtime: 'app', name: id.replace(/^[a-z]+:/, ''), summary: '', params: params.map(([n, t, req]) => ({ name: n, kind: 'named', type: t, type_src: 'schema', required: req !== false })), returns: { type: returns || 'json', type_src: 'doc' }, effects: ['state.read'], pure: false, avail: { state: 'builtin', needs: [] }, domains: [], tests: [], tier: 1 }, extra || {});
const units = [
    mk('tool:download', [['url', 'url']], 'object{ok:bool,file_id:file_id,size:int}', { effects: ['net'], summary: '下載網址的檔案' }),
    mk('tool:to_pdf', [['file_id', 'file_id'], ['page_size', 'enum<a4|a5>', false]], 'object{ok:bool,pdf_file_id:pdf_file}', { summary: '轉成 PDF' }),
    mk('tool:count_pages', [['pdf', 'pdf_file']], 'int', { summary: '算 PDF 頁數' }),
    mk('tool:say', [['text', 'text']], 'object{ok:bool}', { effects: ['ui'] }),
    mk('tool:search', [['query', 'query']], 'object{urls:list<url>,total:int}', { effects: ['net'] }),
    mk('tool:mystery', [['x', 'text']], 'json'),
];
const cat = { units };
const parse = (dsl) => { const r = U.parseDsl(dsl); if (r.errors.length) throw new Error(JSON.stringify(r.errors)); return r.model; };

// ---- 型別合約 ----
const m0 = parse('actor: A\nenum Color { RED, GREEN }\nclass Item { name:str; qty:int }\nclass S { +f(a:str, b:List<int>, d:Optional<float>, e:Color, g:Item, h:Url, i:PdfFile, j:Path, k:bytes, l:datetime):bool }\nusecase T: A -> S.f(a)');
const pt = (s) => B.umlToType(U.parseType(s), m0);
check('uml basic types', pt('str') === 'text' && pt('int') === 'int' && pt('float') === 'number' && pt('bool') === 'bool' && pt('datetime') === 'text' && pt('bytes') === 'bytes' && pt('void') === 'void' && pt('any') === 'any', [pt('str'), pt('float')]);
check('uml containers', pt('List<int>') === 'list<int>' && pt('Map<str,int>') === 'dict' && pt('Optional<float>') === 'number' && pt('int[]') === 'list<int>' && pt('str?') === 'text');
check('uml enum/class/kinded', pt('Color') === 'enum<RED|GREEN>' && pt('Item') === 'object{name:text,qty:int}' && pt('Url') === 'url' && pt('PdfFile') === 'pdf_file' && pt('Path') === 'path' && pt('Yaml') === 'yaml' && pt('Unknown') === 'any', [pt('Color'), pt('Item'), pt('PdfFile')]);
check('mapped types are valid catalog types', ['Color', 'Item', 'Url', 'PdfFile', 'List<Item>'].every((s) => { try { C.parseType(pt(s)); return true; } catch (_) { return false; } }));

// ---- 直接對得上：下載 → 數頁 ----
const m1 = parse('actor: User\nclass PdfService { +download(url:Url):FileId; +countPages(pdf:PdfFile):int }\nusecase CountPages: User -> PdfService.download(url) -> PdfService.countPages(pdf):int');
const r1 = B.bindModel(m1, cat);
const u1 = r1.results[0];
check('steps bound by name', u1.steps[0].unit === 'tool:download' && u1.steps[1].unit === 'tool:count_pages', u1.steps);
check('program valid', u1.valid === true && u1.errors.length === 0, [u1.errors, u1.program]);
check('download output flows into pdf step through the object field chain', JSON.stringify(u1.program.steps.map((s) => s.call)) === JSON.stringify(['tool:download', 'tool:to_pdf', 'tool:count_pages']), u1.program && u1.program.steps);
check('bridged recorded', (u1.steps[1].bridged || []).length === 1, u1.steps[1]);
check('only url is an input', Object.keys(u1.program.inputs).join() === 'url' && u1.program.inputs.url.type === 'url', u1.program.inputs);
check('zero model calls', r1.summary.model_calls === 0 && u1.model_calls === 0);
check('summary counts', r1.summary.steps === 2 && r1.summary.bound === 2 && r1.summary.valid === 1 && r1.summary.fully_wired === 1, r1.summary);

// ---- 執行：programs run against stub invoke ----
const calls = [];
const invoke = async (u, a) => { calls.push(u.id); if (u.id === 'tool:download') return { ok: true, file_id: 'f1', size: 5 }; if (u.id === 'tool:to_pdf') return { ok: true, pdf_file_id: 'p1' }; if (u.id === 'tool:count_pages') return 7; throw new Error('?'); };
IR.run(u1.program, { url: 'https://x.com/a' }, cat, { invoke }, {}).then((res) => { check('program runs end to end', res.ok && res.result === 7 && calls.join() === 'tool:download,tool:to_pdf,tool:count_pages', res); done(); });

// ---- 沒有名稱對得上：用型別合約接線 ----
const m2 = parse('actor: User\nclass Converter { +transform(link:Url):PdfFile }\nusecase MakePdf: User -> Converter.transform(link):PdfFile');
const u2 = B.bindModel(m2, cat).results[0];
check('type-wiring when no unit by name', u2.steps[0].by === 'type-wiring' && u2.steps[0].units.join() === 'tool:download,tool:to_pdf', u2.steps);
check('type-wiring program valid + issue recorded', u2.valid && u2.issues.some((i) => i.kind === 'wired_by_type'), [u2.errors, u2.issues]);

// ---- 對不上 ----
const m3 = parse('actor: User\nclass Mailer { +sendEmail(to:str):bool }\nusecase Notify: User -> Mailer.sendEmail(to)');
const u3 = B.bindModel(m3, cat).results[0];
check('unbound reported, no program', u3.steps[0].by === 'none' && u3.program === null && u3.valid === false && u3.issues.some((i) => i.kind === 'unbound'), u3);

// ---- 必填參數接不上 → 變成輸入並標示 ----
const m4 = parse('actor: User\nclass PdfService { +countPages(n:int):int }\nusecase Count: User -> PdfService.countPages(n)');
const u4 = B.bindModel(m4, cat).results[0];
check('unwired param becomes input and flagged', u4.steps[0].unit === 'tool:count_pages' && u4.issues.some((i) => i.kind === 'unwired') && u4.program.inputs.pdf && u4.program.inputs.pdf.type === 'pdf_file', [u4.issues, u4.program && u4.program.inputs]);

// ---- 精確名稱優先、不明回傳不亂接 ----
const m5 = parse('actor: User\nclass Chat { +say(text:str):bool }\nusecase Speak: User -> Chat.say(text)');
const u5 = B.bindModel(m5, cat).results[0];
check('exact name wins', u5.steps[0].unit === 'tool:say' && u5.valid, u5.steps);
const m6 = parse('actor: User\nclass Net { +search(query:str):List<Url> }\nusecase Find: User -> Net.search(query)');
const u6 = B.bindModel(m6, cat).results[0];
check('return contract fits (list<url>)', u6.steps[0].unit === 'tool:search' && u6.steps[0].candidates[0].ret_fit >= 0.9, u6.steps[0]);

// ---- 不明型別補齊後，原本接不上的路徑接得上了（任務 A 的效益）----
const hidden = units.concat([mk('tool:read_note', [['n', 'int']], 'json'), mk('tool:shout', [['text', 'text']], 'object{ok:bool}')]);
const m7 = parse('actor: User\nclass Notes { +readNote(n:int):str; +shout(text:str):bool }\nusecase Loud: User -> Notes.readNote(n) -> Notes.shout(text)');
const before = B.bindModel(m7, { units: hidden }).results[0];
const after = B.bindModel(m7, { units: hidden.map((u) => (u.id === 'tool:read_note' ? Object.assign({}, u, { returns: { type: 'object{ok:bool,text:text}', type_src: 'observed' } }) : u)) }).results[0];
check('opaque return cannot feed next step (becomes input)', before.issues.some((i) => i.kind === 'opaque_link'), before.issues);
check('observed return type wires the field through', after.valid && !after.issues.some((i) => i.kind === 'opaque_link') && JSON.stringify(after.program.steps[1].args.text) === '{"$ref":"s1.text"}', [after.issues, after.program && after.program.steps]);

// ---- 只靠一個共同字不算對得上（真實目錄裡 countPages 曾被配到 remove_pdf_pages、sendEmail 配到 tmux_send_keys）----
const noisy = { units: units.concat([mk('tool:remove_pdf_pages', [['pdf', 'pdf_file'], ['pages', 'text']], 'object{ok:bool}', { summary: '刪除 PDF 的頁面' }), mk('tool:tmux_send_keys', [['keys', 'text']], 'object{ok:bool}', { summary: 'send keys to tmux' })]).filter((u) => u.id !== 'tool:count_pages') };
const nz = B.bindModel(parse(['actor: User', 'class P { +countPages(pdf:PdfFile):int }', 'class M { +sendEmail(to:str):bool }', 'usecase A: User -> P.countPages(pdf)', 'usecase B: User -> M.sendEmail(to)'].join('\n')), noisy);
check('single shared word is not enough', nz.results[0].steps[0].by === 'none' && nz.results[1].steps[0].by === 'none', nz.results.map((r) => r.steps[0]));
check('plural/singular stem still matches', B.bindModel(parse(['actor: User', 'class P { +removePage(pdf:PdfFile):bool }', 'usecase A: User -> P.removePage(pdf)'].join('\n')), noisy).results[0].steps[0].unit === 'tool:remove_pdf_pages');

// ---- 語意檢索（嵌入）：名稱對不上時靠語意；向量用人造的 ----
const E = require('./embed_core.js');
const chartUnits = { units: units.concat([mk('tool:render_chart', [['data', 'text']], 'object{ok:bool}', { summary: '畫圖表' }), mk('tool:other_a', [['x', 'text']], 'object{ok:bool}', { summary: '別的 A' }), mk('tool:other_b', [['x', 'text']], 'object{ok:bool}', { summary: '別的 B' })]) };
const mChart = parse(['actor: User', 'class Viz { +drawBarGraph(data:str):bool }', 'usecase Plot: User -> Viz.drawBarGraph(data)'].join('\n'));
const q0 = B.queriesOf(mChart); check('queriesOf', q0.length === 1 && q0[0] === 'viz draw bar graph', q0);
const vec = (a) => E.normalize(Float32Array.from(a));
const fillers = Array.from({ length: 40 }, (_, i) => ['filler' + i, [Math.sin(i) * 0.1, Math.cos(i * 1.7), Math.sin(i * 2.3)]]); // 一群跟查詢不太像的單元，讓『高於平均幾個標準差』有母體可算
const mkDense = (qv, uv) => ({ queryVecs: new Map([[q0[0], vec(qv)]]), unitVecs: new Map(Object.entries(uv).concat(fillers).map(([k, v]) => [k, vec(v)])) });
const base = B.bindModel(mChart, chartUnits).results[0];
check('without embeddings the renamed op is unbound', base.steps[0].by === 'none', base.steps[0]);
const near = B.bindModel(mChart, chartUnits, { dense: mkDense([1, 0.1, 0], { 'tool:render_chart': [1, 0.15, 0], 'tool:other_a': [0, 1, 0], 'tool:other_b': [0, 0, 1] }) }).results[0];
check('semantic match binds', near.steps[0].unit === 'tool:render_chart' && near.steps[0].by === 'semantic+contract' && near.steps[0].cos > 0.98 && near.valid, near.steps[0]);
check('semantic match is flagged', near.issues.some((i) => i.kind === 'semantic_match'), near.issues);
const far = B.bindModel(mChart, chartUnits, { dense: mkDense([1, 0, 0], { 'tool:render_chart': [0.05, 1, 0.1], 'tool:other_a': [0, 1, 0], 'tool:other_b': [0, 0, 1] }) }).results[0];
check('too close to the crowd (z below threshold) is rejected', far.steps[0].by === 'none', far.steps[0]);
const third = B.bindModel(mChart, chartUnits, { dense: mkDense([1, 0, 0], { 'tool:other_a': [1, 0.01, 0], 'tool:other_b': [1, 0.02, 0], 'tool:render_chart': [1, 0.03, 0] }) }).results[0];
check('dense rank beyond 2 is rejected even when cosine is high', third.steps[0].by === 'none' || third.steps[0].unit !== 'tool:render_chart', third.steps[0]);
const sum = B.bindModel(mChart, chartUnits, { dense: mkDense([1, 0.1, 0], { 'tool:render_chart': [1, 0.15, 0] }) }).summary;
check('summary reports semantic', sum.semantic === true && sum.semantic_steps === 1, sum);
check('empty dense falls back to BM25', B.bindModel(mChart, chartUnits, { dense: { queryVecs: new Map(), unitVecs: new Map() } }).summary.semantic === false);
check('name matches still go through the name path with dense on', B.bindModel(m1, cat, { dense: { queryVecs: new Map(B.queriesOf(m1).map((q) => [q, vec([1, 0, 0])])), unitVecs: new Map([['tool:download', vec([0, 1, 0])]]) } }).results[0].steps[0].by === 'retrieval+contract');

// ---- 文字輸出 ----
check('toText mentions counts and 0 model calls', /模型呼叫 0 次/.test(B.toText(r1)) && /CountPages/.test(B.toText(r1)));

function done() { console.log('bind_core: ' + ok + ' passed' + (bad.length ? ', ' + bad.length + ' FAILED' : '')); bad.forEach((b) => console.log('FAIL', b)); process.exit(bad.length ? 1 : 0); }
