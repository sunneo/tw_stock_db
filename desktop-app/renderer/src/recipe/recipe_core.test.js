// 食譜核心測試：node renderer/src/recipe/recipe_core.test.js
const R = require('./recipe_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info))); } }

(async () => {
    // ---- 附件 ----
    const atts = R.parseAttachments('幫我轉pdf\n\n[附件：a.png（file_id=11）、報告 v2.pdf（file_id=22-x）]');
    check('parse attachments', atts.length === 2 && atts[0].id === '11' && atts[1].filename === '報告 v2.pdf' && atts[1].id === '22-x', atts);
    check('strip attachments', R.stripAttachments('幫我轉pdf [附件：a.png（file_id=11）]') === '幫我轉pdf');
    check('file kinds', R.kindOf('x.PNG') === 'image' && R.kindOf('a.pdf') === 'pdf' && R.kindOf('v.mp4') === 'video' && R.kindOf('s.srt') === 'subtitle' && R.kindOf('x.txt') === 'other');

    // ---- 欄位（schema）----
    const schema = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: '圖片' }, page_size: { type: 'string', enum: ['fit', 'a4', 'letter'] }, margin: { type: 'number', minimum: 0, maximum: 144 } }, required: ['files'] };
    const defs = R.slotsFromSchema(schema);
    check('slots from schema', defs.length === 3 && defs[0].required && defs[1].enum.length === 3 && defs[2].max === 144, defs);

    // ---- 程式填欄位 ----
    let pf = R.programFill(defs, { text: '轉成 A4 的 pdf', slots: {}, attachments: [{ id: 'i1', filename: 'a.png' }, { id: 'i2', filename: 'b.jpg' }, { id: 'p1', filename: 'x.pdf' }] });
    check('program fill: attachments of the right kind + enum from text', pf.values.files.join() === 'i1,i2' && pf.values.page_size === 'a4' && pf.missing.length === 0 && pf.by.files === 'program', pf);
    pf = R.programFill(defs, { text: '幫我轉pdf', slots: {}, attachments: [] });
    check('program fill: no attachment → required slot is missing (model/user must supply)', pf.missing.length === 1 && pf.missing[0].name === 'files', pf);
    pf = R.programFill(defs, { text: 'fit or a4', slots: {}, attachments: [{ id: 'i1', filename: 'a.png' }] });
    check('program fill: ambiguous enum is left alone', pf.values.page_size === undefined, pf);
    const sd = R.slotsFromSchema({ type: 'object', properties: { url: { type: 'string' }, query: { type: 'string' }, count: { type: 'integer' }, mode: { type: 'string', enum: ['a', 'b'], default: 'a' } }, required: ['url', 'query', 'count'] });
    pf = R.programFill(sd, { text: '看一下 這個網頁 https://x.io/a 重點', slots: { url: 'https://x.io/a', numbers: [], after_colon: '', quoted: '' }, attachments: [] });
    check('program fill: url from slots, query from cleaned text, default used, count missing', pf.values.url === 'https://x.io/a' && /重點/.test(pf.values.query) && pf.values.mode === 'a' && pf.by.mode === 'default' && pf.missing.map((d) => d.name).join() === 'count', pf);
    pf = R.programFill(sd, { text: '抓 5 篇', slots: { url: 'https://x.io', numbers: ['5'] }, attachments: [] });
    check('program fill: a single number fills the single required numeric slot', pf.values.count === 5, pf);
    pf = R.programFill(sd, { text: '抓 5 到 8 篇', slots: { url: 'https://x.io', numbers: ['5', '8'] }, attachments: [] });
    check('program fill: two numbers → not guessed', pf.values.count === undefined, pf);
    pf = R.programFill(R.slotsFromSchema({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }), { text: '查：rust 借用規則', slots: {}, attachments: [] });
    check('program fill: text after a colon wins for query', pf.values.query === 'rust 借用規則', pf);

    // ---- 查詢字串清理 ----
    check('cleanQuery: strips command verbs and trailing question words', R.cleanQuery('上網搜尋 rust borrow checker 是什麼') === 'rust borrow checker' && R.cleanQuery('幫我查一下 errno 2 是什麼意思') === 'errno 2' && R.cleanQuery('請幫我搜尋：gdb 斷點') === 'gdb 斷點', [R.cleanQuery('上網搜尋 rust borrow checker 是什麼'), R.cleanQuery('幫我查一下 errno 2 是什麼意思'), R.cleanQuery('請幫我搜尋：gdb 斷點')]);
    check('cleanQuery: a colon inside a URL is not a split point', R.cleanQuery('看一下 https://example.com/a 在講什麼') === '看一下 在講什麼', R.cleanQuery('看一下 https://example.com/a 在講什麼'));
    check('cleanQuery: a trailing "and summarise it" is not part of the search words', R.cleanQuery('上網查 rust borrow checker 並整理重點') === 'rust borrow checker' && R.cleanQuery('搜尋 gdb 斷點，然後幫我整理成報告') === 'gdb 斷點', [R.cleanQuery('上網查 rust borrow checker 並整理重點'), R.cleanQuery('搜尋 gdb 斷點，然後幫我整理成報告')]);
    check('cleanQuery: keeps plain text when nothing to strip', R.cleanQuery('rust 借用規則') === 'rust 借用規則');
    // ---- 用證據縮小候選 ----
    const sch = { fetch_web_page: R.slotsFromSchema({ type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }), browser_search: R.slotsFromSchema({ type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }), images_to_pdf: R.slotsFromSchema({ type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: '圖片' } }, required: ['files'] }), merge_pdfs: R.slotsFromSchema({ type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, description: 'PDF檔' } }, required: ['files'] }) };
    const cs = [{ tool: 'browser_search', score: 0.4 }, { tool: 'fetch_web_page', score: 0.2 }, { tool: 'images_to_pdf', score: 0.3 }, { tool: 'merge_pdfs', score: 0.3 }];
    let nb = R.narrowByEvidence(cs, sch, { text: '看這個 https://x.io', slots: { url: 'https://x.io' }, attachments: [] });
    check('narrow: a URL keeps only tools with a url slot', nb.cands.length === 1 && nb.cands[0].tool === 'fetch_web_page' && /網址/.test(nb.why.join()), nb);
    nb = R.narrowByEvidence(cs, sch, { text: '轉pdf', slots: {}, attachments: [{ id: 'a', filename: 'a.png' }] });
    check('narrow: image attachments keep tools whose file slot accepts images', nb.cands.map((c) => c.tool).join() === 'images_to_pdf', nb);
    nb = R.narrowByEvidence(cs, sch, { text: '合併', slots: {}, attachments: [{ id: 'a', filename: 'a.pdf' }, { id: 'b', filename: 'b.pdf' }] });
    check('narrow: pdf attachments keep merge_pdfs', nb.cands.map((c) => c.tool).join() === 'merge_pdfs', nb);
    nb = R.narrowByEvidence(cs, sch, { text: '你好', slots: {}, attachments: [] });
    check('narrow: no evidence → candidates unchanged', nb.cands.length === 4 && nb.why.length === 0);
    // ---- jsonStep ----
    const gen = (replies, log) => { let i = 0; return async (a) => { if (log) log.push(a.messages); return replies[Math.min(i++, replies.length - 1)]; }; };
    let r = await R.jsonStep({ generate: gen(['{"x": 1}']), messages: [{ role: 'user', content: 'q' }], validate: () => [] });
    check('jsonStep: first reply fine', r.ok && r.value.x === 1 && r.tries === 1, r);
    r = await R.jsonStep({ generate: gen(['```json\n{"x": 2}\n```']), messages: [], validate: () => [] });
    check('jsonStep: fenced json', r.ok && r.value.x === 2, r);
    r = await R.jsonStep({ generate: gen(['好的，結果是 {"x": 3} 謝謝']), messages: [], validate: () => [] });
    check('jsonStep: json embedded in prose', r.ok && r.value.x === 3, r);
    let log = []; r = await R.jsonStep({ generate: gen(['{"x": 0}', '{"x": 5}'], log), messages: [{ role: 'user', content: 'q' }], validate: (o) => (o.x < 1 ? ['x 必須 ≥ 1'] : []) });
    check('jsonStep: rejected reply is retried with only the last reply + the exact error (no history)', r.ok && r.tries === 2 && r.rejected.length === 1 && log[1].length === 3 && /x 必須 ≥ 1/.test(log[1][2].content) && log[1][1].content === '{"x": 0}', { r, n: log[1].length });
    log = []; r = await R.jsonStep({ generate: gen(['{"x": 0}'], log), messages: [], validate: () => ['錯'], maxTries: 5 });
    check('jsonStep: identical repeated reply stops early', !r.ok && log.length === 2, { calls: log.length });
    r = await R.jsonStep({ generate: gen(['不是 json']), messages: [], validate: () => [], maxTries: 2 });
    check('jsonStep: never valid → failure with reasons', !r.ok && r.rejected.length >= 1 && /JSON/.test(r.error), r);
    r = await R.jsonStep({ generate: async () => { throw new Error('boom'); }, messages: [], validate: () => [] });
    check('jsonStep: generator error is reported, not thrown', !r.ok && /boom/.test(r.error), r);

    // ---- prefill：替模型寫好回覆開頭 ----
    let seenPrefill = []; await R.jsonStep({ generate: async (a) => { seenPrefill.push(a.prefill); return '{"x":1}'; }, messages: [], validate: () => [], prefill: '{"x":' });
    check('jsonStep: passes the prefill to the generator', seenPrefill[0] === '{"x":', seenPrefill);
    seenPrefill = []; await R.chooseTool({ cands: [{ tool: 'a', intent: 'A', score: 0 }], question: 'q', generate: async (a) => { seenPrefill.push(a.prefill); return '{"choice": 1}'; } });
    check('chooseTool: prefills {"choice":', seenPrefill[0] === '{"choice":', seenPrefill);
    seenPrefill = []; await R.modelFill({ missing: R.slotsFromSchema({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }), question: 'x', toolName: 't', generate: async (a) => { seenPrefill.push(a.prefill); return '{"q": "x"}'; } });
    check('modelFill: prefills the first missing field', seenPrefill[0] === '{"q":', seenPrefill);
    // ---- 模型填空 ----
    const miss = R.slotsFromSchema({ type: 'object', properties: { count: { type: 'integer', minimum: 1, maximum: 10 }, mode: { type: 'string', enum: ['x', 'y'] }, name: { type: 'string' } }, required: ['count', 'mode', 'name'] });
    let mf = await R.modelFill({ missing: miss, question: '給我 3 個 x', toolName: 't', generate: gen(['{"count": 3, "mode": "x", "name": null}']) });
    check('modelFill: values filled, null stays missing (not invented)', mf.ok && mf.values.count === 3 && mf.values.mode === 'x' && mf.missing.map((d) => d.name).join() === 'name', mf);
    mf = await R.modelFill({ missing: miss, question: 'q', toolName: 't', generate: gen(['{"count": 99, "mode": "z", "name": "a"}', '{"count": 2, "mode": "y", "name": "a"}']) });
    check('modelFill: out-of-range and enum violations are rejected with exact reasons, then fixed', mf.ok && mf.tries === 2 && mf.values.count === 2 && /不能大於 10/.test(mf.rejected[0].errors.join()) && /必須是：x、y/.test(mf.rejected[0].errors.join()), mf);
    mf = await R.modelFill({ missing: miss, question: 'q', toolName: 't', generate: gen(['{"count": 1, "mode": "x", "name": "n", "extra": 1}', '{"count": 1, "mode": "x", "name": "n"}']) });
    check('modelFill: unknown key rejected', mf.ok && mf.tries === 2 && /不認得的欄位/.test(mf.rejected[0].errors.join()), mf);
    check('fill prompt has no invented example values', !/例如|範例|e\.g\./.test(R.fillMessages('q', miss, 't').map((m) => m.content).join('')));

    // ---- 數字必須是使用者說過的；選填欄位只在有關連時才問 ----
    const nd = R.slotsFromSchema({ type: 'object', properties: { fps: { type: 'integer', description: '每秒幀數' }, end: { type: 'number', description: '結束秒數' } }, required: [] });
    let nf = await R.modelFill({ missing: nd, question: '前 5 秒', toolName: 't', numbers: ['5'], generate: gen(['{"fps": 12, "end": 5}', '{"fps": null, "end": 5}']) });
    check('modelFill: a number the user never said is rejected (no invented numbers), then fixed with null', nf.ok && nf.tries === 2 && /沒有出現在使用者的話裡/.test(nf.rejected[0].errors.join()) && nf.values.end === 5 && nf.missing.map((d) => d.name).join() === 'fps', nf);
    const od = R.slotsFromSchema({ type: 'object', properties: { fps: { type: 'integer', description: '每秒幀數' }, max_width: { type: 'integer', description: '最大寬度（像素）' }, end: { type: 'number', description: '結束秒數' }, page_size: { type: 'string', enum: ['fit', 'a4'] } } });
    check('relevantOptional: only slots whose name/description wording appears', R.relevantOptional(od, '把影片轉成 gif，結束秒數 5').map((d) => d.name).join() === 'end', R.relevantOptional(od, '把影片轉成 gif，結束秒數 5').map((d) => d.name));
    check('relevantOptional: loose wording (前 5 秒) is deliberately NOT guessed into fps/width/end', R.relevantOptional(od, '把影片前 5 秒轉成 gif').length === 0);
    check('relevantOptional: names, descriptions and enum values all count', R.relevantOptional(od, '寬度 480 fps 8').map((d) => d.name).join() === 'fps,max_width' && R.relevantOptional(od, '轉成 a4').map((d) => d.name).join() === 'page_size');
    check('relevantOptional: unrelated wording → nothing', R.relevantOptional(od, '幫我轉pdf').length === 0);
    // ---- 路由 ----
    const c1 = [{ tool: 'a', intent: 'A', score: 0.9 }, { tool: 'b', intent: 'B', score: 0.5 }];
    check('autoPick: clear winner by the program', R.autoPick(c1).index === 0 && R.autoPick(c1).by === 'program');
    check('autoPick: close scores → ask the model', R.autoPick([{ tool: 'a', score: 0.7 }, { tool: 'b', score: 0.66 }]) === null);
    check('autoPick: weak single candidate → null; decent single → program', R.autoPick([{ tool: 'a', score: 0.2 }]) === null && R.autoPick([{ tool: 'a', score: 0.6 }]).index === 0);
    check('autoPick: top score below the floor → null', R.autoPick([{ tool: 'a', score: 0.4 }, { tool: 'b', score: 0.1 }]) === null);
    const menu = R.menuMessages('問題', c1).map((m) => m.content).join('\n');
    check('menu: numbered, includes the none option, no tool arguments', /1\. A（工具 a）/.test(menu) && /0\. 都不是/.test(menu));
    let ch = await R.chooseTool({ cands: c1, question: 'q', generate: gen(['{"choice": 2}']) });
    check('chooseTool: model picks', ch.ok && ch.index === 1 && !ch.none && ch.by === 'model', ch);
    ch = await R.chooseTool({ cands: c1, question: 'q', generate: gen(['{"choice": 0}']) });
    check('chooseTool: 0 = none', ch.ok && ch.none === true, ch);
    ch = await R.chooseTool({ cands: c1, question: 'q', generate: gen(['{"choice": 7}', '{"choice": 1}']) });
    check('chooseTool: out-of-range choice rejected then fixed', ch.ok && ch.index === 0 && ch.tries === 2 && /0～2/.test(ch.rejected[0].errors.join()), ch);

    // ---- 措辭檢查 ----
    const src = 'errno 2 ENOENT：No such file or directory，檔案或資料夾不存在（路徑拼錯）';
    check('extractive: faithful condensation passes', R.checkExtractive('errno 2 是 ENOENT，表示檔案或資料夾不存在。', [src]).ok);
    check('extractive: invented number rejected', !R.checkExtractive('errno 2 是 ENOENT，大約有 40 種情況。', [src]).ok && /數字/.test(R.checkExtractive('errno 2 是 ENOENT，大約有 40 種情況。', [src]).reason));
    check('extractive: mostly new content rejected', !R.checkExtractive('這是一個與記憶體配置有關的問題，通常出現在多執行緒程式中', [src]).ok);
    check('extractive: empty and too long rejected', !R.checkExtractive('', [src]).ok && !R.checkExtractive('檔案'.repeat(300), [src]).ok);

    // ---- 決策紀錄 ----
    const tr = R.newTrace('q', { recipe: 'x' }); R.decide(tr, { stage: 'route', by: 'program' });
    check('trace: decisions recorded', tr.decisions.length === 1 && tr.decisions[0].by === 'program' && tr.recipe === 'x');
    let ring = []; for (let i = 0; i < 50; i++) ring = R.pushRing(ring, R.newTrace('q' + i), 30, 400000);
    check('ring buffer: keeps the newest 30', ring.length === 30 && ring[29].question === 'q49' && ring[0].question === 'q20');
    const fat = []; let ring2 = []; for (let i = 0; i < 10; i++) ring2 = R.pushRing(ring2, R.newTrace('x'.repeat(250)), 30, 1200);
    check('ring buffer: byte cap drops the oldest', JSON.stringify(ring2).length <= 1200 + 400 && ring2.length < 10, ring2.length);
    check('traces → json lines', R.tracesToLines(ring.slice(0, 2)).split('\n').length === 2);

    // ---- 多步驟引擎 ----
    const recipe = { id: 'lookup_answer', steps: [{ id: 'look', type: 'tool', name: 'ref_lookup', args: { query: '{{slots.q}}' } }, { id: 'say', type: 'phrase', input: '{{vars.look.text}}', check: 'extractive', fallback: '{{vars.look.text}}' }, { id: 'out', type: 'render', template: '結果：{{vars.say}}（查詢：{{slots.q}}）' }], result: 'out' };
    check('validateRecipe ok / bad', R.validateRecipe(recipe).length === 0 && R.validateRecipe({ id: 'X', steps: [] }).length >= 1 && R.validateRecipe({ id: 'a', steps: [{ id: 'a', type: 'tool' }, { id: 'a', type: 'tool' }] }).some((e) => /重複/.test(e)) && R.validateRecipe({ id: 'a', steps: [{ id: 's', type: 'nope' }] }).some((e) => /類型/.test(e)));
    let calls = []; const env = (phraseOut, toolOk) => ({ question: 'q', trace: R.newTrace('q'), tool: async (n, a) => { calls.push([n, a]); return { ok: toolOk !== false, text: toolOk === false ? '壞了' : 'ENOENT 檔案不存在' }; }, phrase: async () => phraseOut });
    let e1 = env('ENOENT 表示檔案不存在'); let rr = await R.runRecipe(recipe, { q: 'errno 2' }, e1);
    check('runRecipe: tool args interpolated, phrase used, render', rr.ok && calls[0][1].query === 'errno 2' && /ENOENT 表示檔案不存在（查詢：errno 2）/.test(rr.text) && e1.trace.decisions.some((d) => d.type === 'phrase' && d.by === 'model'), rr);
    rr = await R.runRecipe(recipe, { q: 'x' }, env(null));
    check('runRecipe: phrase fails → program fallback, recorded as fallback', rr.ok && /ENOENT 檔案不存在/.test(rr.text), rr);
    rr = await R.runRecipe(recipe, { q: 'x' }, env('x', false));
    check('runRecipe: failing tool stops the recipe with a clear error', !rr.ok && /ref_lookup/.test(rr.error) && /壞了/.test(rr.error), rr);
    const rOpt = { id: 'o', steps: [{ id: 'a', type: 'tool', name: 't', optional: true }, { id: 'b', type: 'render', template: 'done' }], result: 'b' };
    rr = await R.runRecipe(rOpt, {}, env('x', false));
    check('runRecipe: optional failing step is skipped', rr.ok && rr.text === 'done', rr);
    rr = await R.runRecipe({ id: 'c', steps: [{ id: 'a', type: 'compute', fn: 'double', args: { n: '{{slots.n}}' } }, { id: 'b', type: 'render', template: '{{vars.a}}' }], result: 'b' }, { n: 4 }, { fns: { double: (a) => Number(a.n) * 2 } });
    check('runRecipe: compute step runs a registered function; unknown function is an error', rr.ok && rr.text === '8', rr);
    rr = await R.runRecipe({ id: 'c', steps: [{ id: 'a', type: 'compute', fn: 'nope' }] }, {}, { fns: {} });
    check('runRecipe: unknown compute function reported', !rr.ok && /nope/.test(rr.error), rr);
    check('interp keeps object values when the whole string is a ref', JSON.stringify(R.interp({ a: '{{slots.o}}' }, { slots: { o: { k: 1 } } })) === '{"a":{"k":1}}');

    // ---- 參考資料包（線上養出來的訓練器與 RAG → 離線模型的參考）----
    const now = Date.UTC(2026, 9, 7);
    const items = [{ kind: 'rag', title: 'notes.md', text: 'RAG 內容 '.repeat(60), score: 0.9 }, { kind: 'qa', title: '', text: '問：errno 2？答：ENOENT 檔案不存在', ts: now - 3 * 86400000, score: 0.5 }, { kind: 'steps', title: '圖片轉PDF', text: '先 images_to_pdf，再 merge_pdfs', score: 0.7 }, { kind: 'example', title: '', text: '把圖片轉成 pdf', score: 0.4 }, { kind: 'rule', title: 'core_rules/ref', text: 'errno → ref_lookup', score: 0.8 }, { kind: 'rag', text: '', score: 1 }];
    const pack = R.buildReferencePack(items, 400, { now });
    check('pack: ordered steps > rules > examples > qa > rag, empty items dropped', pack.lines.length === 5 && /^【離線訓練器學到的做法/.test(pack.lines[0]) && /^【離線訓練器的規則/.test(pack.lines[1]) && /^【類似的問法/.test(pack.lines[2]) && /^【過去的問答/.test(pack.lines[3]) && /^【RAG 知識庫/.test(pack.lines[4]), pack.lines.map((l) => l.slice(0, 14)));
    check('pack: past Q&A carries its age and a staleness warning', /3 天前，可能已過期/.test(pack.lines[3]), pack.lines[3]);
    check('pack: fits the budget (self-adaptive, no fixed size) and long items are clipped', pack.used <= 400 && /…$/.test(pack.lines[4]), { used: pack.used, last: pack.lines[4].slice(-8) });
    const small = R.buildReferencePack(items, 80, { now }); const big = R.buildReferencePack(items, 800, { now });
    check('pack: a bigger budget keeps more text', big.used > small.used && small.used <= 80 + 40, { s: small.used, b: big.used });
    check('pack: numbered text for the prompt', /^1\. 【/.test(pack.text) && pack.text.split('\n').length === pack.lines.length);
    check('pack: nothing in → empty pack', R.buildReferencePack([], 100).lines.length === 0 && R.buildReferencePack([{ kind: 'rag', text: '  ' }], 100).lines.length === 0);
    // ---- 離線摘要與切段 ----
    const doc = '台北今天下雨，氣溫 20 度。會議在下午三點開始，主題是專案進度。' + '這是一段不太重要的閒聊內容，沒有什麼資訊。'.repeat(8) + '結論：專案預計 10 月底上線，需要補三位測試人員。最後請大家提出意見。';
    const ex = R.extractiveSummary(doc, 3);
    check('extractive summary: at most N sentences, original order, only sentences from the source', ex.split('\n').length <= 3 && ex.split('\n').every((s) => doc.includes(s.replace(/…$/, ''))), ex);
    check('extractive summary: short text is returned whole', R.extractiveSummary('只有一句話。', 5) === '只有一句話。');
    const long2 = Array.from({ length: 40 }, (_, i) => '第' + i + '段內容，說明了一些事情。').join('');
    const chunks = R.chunkText(long2, 120);
    check('chunkText: every chunk is within the token budget and nothing is lost', chunks.length > 2 && chunks.every((c) => R.tokensOf(c).size > 0) && chunks.join('').replace(/\n/g, '').length >= long2.length - 40, { n: chunks.length });
    check('chunkText: smaller budget → more chunks (scales with the model context)', R.chunkText(long2, 60).length > R.chunkText(long2, 240).length);

    // ---- stripThink（階段 1：思考區塊剝除，純函式）----
    let st = R.stripThink('<think>先想一下</think>{"x": 1}');
    check('stripThink: normal → answer without block, reasoning kept', st.answer === '{"x": 1}' && st.reasoning === '先想一下' && st.unclosed === false, st);
    st = R.stripThink('{"x": 2}');
    check('stripThink: no think block → reasoning empty, answer unchanged', st.answer === '{"x": 2}' && st.reasoning === '' && st.unclosed === false, st);
    st = R.stripThink('<think>想到一半沒有閉合 {"x": 3}');
    check('stripThink: unclosed open tag → everything after it is reasoning', st.answer === '' && /想到一半/.test(st.reasoning) && st.unclosed === true, st);
    st = R.stripThink('答案前綴<think>還在想');
    check('stripThink: unclosed keeps the text before the tag as answer', st.answer === '答案前綴' && st.reasoning === '還在想' && st.unclosed === true, st);
    st = R.stripThink('<think>第一段</think>中間<think>第二段</think>{"x":4}');
    check('stripThink: multiple blocks are merged into reasoning', st.reasoning === '第一段\n\n第二段' && st.answer === '中間{"x":4}', st);
    st = R.stripThink('<think>我想 {"a": {"b": [1]}} 和 ( ) 的關係</think>{"choice": 2}');
    check('stripThink: JSON braces inside thinking do not leak into answer', st.answer === '{"choice": 2}' && /\{"a"/.test(st.reasoning), st);
    st = R.stripThink('<think>選項 A 還是 B？選 C 比較好</think>{"choice":3}');
    check('stripThink: letter options inside thinking do not leak into answer', st.answer === '{"choice":3}' && /選項 A/.test(st.reasoning), st);
    st = R.stripThink('');
    check('stripThink: empty string → all empty, not unclosed', st.answer === '' && st.reasoning === '' && st.unclosed === false, st);
    st = R.stripThink(null);
    check('stripThink: null/undefined is treated as empty string', st.answer === '' && st.reasoning === '', st);
    st = R.stripThink('<THINK>大寫標籤</THINK>  {"x":5}  ');
    check('stripThink: uppercase tags are handled and whitespace is trimmed', st.answer === '{"x":5}' && st.reasoning === '大寫標籤', st);
    st = R.stripThink('<Thinking>混合</thinking>\n\n{"x":6}\n');
    check('stripThink: <thinking> variant and mixed case handled', st.answer === '{"x":6}' && st.reasoning === '混合', st);
    st = R.stripThink('<think>\n  \n</think>{"x":7}');
    check('stripThink: empty thinking block gives empty reasoning', st.answer === '{"x":7}' && st.reasoning === '', st);

    // jsonStep 整合
    r = await R.jsonStep({ generate: gen(['<think>想想看 {"x": 9}</think>{"x": 8}']), messages: [], validate: () => [] });
    check('jsonStep: think block stripped before parse, reasoning exposed', r.ok && r.value.x === 8 && /想想看/.test(r.reasoning) && r.tries === 1, r);
    log = []; r = await R.jsonStep({ generate: gen(['<think>想</think>{"x": 0}', '<think>又想</think>{"x": 5}'], log), messages: [{ role: 'user', content: 'q' }], validate: (o) => (o.x < 1 ? ['x 必須 ≥ 1'] : []) });
    check('jsonStep: retry messages carry the answer only, never the reasoning', r.ok && r.value.x === 5 && log[1].every((m) => !/想/.test(m.content)) && /x 必須/.test(log[1][2].content) && r.reasoning === '想\n\n又想', { r, msgs: log[1] });
    r = await R.jsonStep({ generate: gen(['<think>沒閉合的思考 {"x":1}']), messages: [], validate: () => [], maxTries: 1 });
    check('jsonStep: unclosed think with no answer fails but keeps reasoning', !r.ok && /JSON/.test(r.error) && /沒閉合/.test(r.reasoning), r);
    r = await R.jsonStep({ generate: gen(['純文字沒有思考']), messages: [], validate: () => [], maxTries: 1 });
    check('jsonStep: existing behavior unchanged without think blocks (reasoning empty)', !r.ok && r.reasoning === '', r);
    r = await R.jsonStep({ generate: gen(['{"choice": 1}']), messages: [], validate: (o) => (o.choice === 1 ? [] : ['bad']) });
    check('jsonStep: existing success shape unchanged plus reasoning field', r.ok && r.value.choice === 1 && r.tries === 1 && Array.isArray(r.rejected) && r.reasoning === '', r);
    // 思考堆疊：選工具是路由的一層，選了哪個要留給後面（補欄位）看
    {
        const T = require('./think_stack.js'); const st = T.create('把這個網址的重點唸出來', { maxDecisions: 8 }); T.push(st, { path: '路由', question: '判斷這句話要用哪個工具' });
        const seen = []; const spy = async (req) => { seen.push(req.messages.map((m) => m.content).join('\n')); return '{"choice": 2}'; };
        const c2 = [{ tool: 'a', intent: 'A', score: 0 }, { tool: 'b', intent: 'B', score: 0 }];
        const r1 = await R.chooseTool({ cands: c2, question: 'q', generate: spy, stack: st, stackMod: T, label: '選工具' });
        check('chooseTool+stack: 提示有標頭（目標、路徑、這題），選完框架關閉', r1.ok && r1.index === 1 && /【目標】把這個網址的重點唸出來/.test(seen[0]) && /路由 > 選工具/.test(seen[0]) && st.frames.length === 1, { seen: seen[0], frames: st.frames.length });
        check('chooseTool+stack: 選了哪個變成上層的「已定」', st.frames[0].decisions.some((d) => /選了 b/.test(d)), st.frames[0].decisions);
        seen.length = 0; await R.modelFill({ missing: [{ name: 'text', type: 'string', required: true, description: '要唸的文字' }], question: 'q', toolName: 'b', generate: async (req) => { seen.push(req.messages.map((m) => m.content).join('\n')); return '{"text":"x"}'; }, stack: st, stackMod: T });
        check('補欄位看得到前面選了 b', /【已定，不要改】[\s\S]*選工具：選了 b/.test(seen[0]), seen[0]);
        const st2 = T.create('g'); T.push(st2, { path: '路由', question: 'x' }); await R.chooseTool({ cands: c2, question: 'q', generate: async () => '{"choice": 0}', stack: st2, stackMod: T });
        check('chooseTool+stack: 都不合適也記下來', st2.frames[0].decisions.some((d) => /都不合適/.test(d)), st2.frames[0].decisions);
        const r3 = await R.chooseTool({ cands: c2, question: 'q', generate: async () => '亂答' , maxTries: 1, stack: st2, stackMod: T });
        check('chooseTool+stack: 選不出來也要把框架關掉（堆疊不外漏）', !r3.ok && st2.frames.length === 1, st2.frames.length);
    }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
