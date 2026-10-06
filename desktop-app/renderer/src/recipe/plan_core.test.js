// 多步驟食譜（計畫）測試：node renderer/src/recipe/plan_core.test.js
const R = require('./recipe_core.js');
const P = require('./plan_core.js');
let ok = 0; const bad = [];
function check(name, cond, info) { if (cond) ok++; else { bad.push(name); console.log('FAIL ' + name, info === undefined ? '' : (typeof info === 'string' ? info : JSON.stringify(info).slice(0, 700))); } }
const att = (filename, id) => ({ id: id || filename, filename });
const F = (o) => P.factsFrom(Object.assign({ attachments: [], text: '' }, o));
const tools = (plan) => plan.steps.map((s) => s.tool).join('>');

(async () => {
    // ---- 種類與 facts ----
    check('file kinds', P.kindOfFile('a.mp4') === 'video' && P.kindOfFile('a.wav') === 'audio' && P.kindOfFile('r.docx') === 'doc' && P.kindOfFile('n.txt') === 'text' && P.kindOfFile('s.srt') === 'subtitle' && P.kindOfFile('x.png') === 'image' && P.kindOfFile('x.pdf') === 'pdf' && P.kindOfFile('x.bin') === 'file');
    const f1 = F({ attachments: [att('a.mp4'), att('b.pdf'), att('c.pdf')], url: 'https://x.io', text: '幫我整理' });
    check('facts: counts by kind', f1.kinds.video === 1 && f1.kinds.pdf === 2 && f1.kinds.url === 1 && f1.kinds.usertext === 1 && f1.items.length === 5, f1.kinds);

    // ---- 目標分類（程式）----
    const g = (text, facts) => P.matchGoals(text, facts).map((x) => x.id).join();
    check('goal: video + summary words → video_summary only (not doc_summary)', g('幫我把這支影片整理成摘要', F({ attachments: [att('a.mp4')] })) === 'video_summary', g('幫我把這支影片整理成摘要', F({ attachments: [att('a.mp4')] })));
    check('goal: transcript', g('轉成逐字稿', F({ attachments: [att('a.mp3')] })) === 'media_transcript');
    check('goal: url + summary → web_summary', g('這個網頁在講什麼', F({ url: 'https://x.io' })) === 'web_summary');
    check('goal: research needs a query fact', g('上網查 rust 並整理重點', F({ query: 'rust' })) === 'web_research' && g('上網查 rust 並整理重點', F({})) === '');
    check('goal: research trigger tolerates a long query between the verbs', g('上網查 rust borrow checker 的用法和常見錯誤 並整理重點', F({ query: 'x' })) === 'web_research');
    check('goal: with an old text attachment around, research still wins over a document summary', g('上網查 rust borrow checker 並整理重點', F({ query: 'x', attachments: [att('old.txt')] })) === 'web_research');
    check('goal: pdf merge needs two pdfs', g('合併這些 pdf', F({ attachments: [att('a.pdf'), att('b.pdf')] })) === 'pdf_merge' && g('合併這些 pdf', F({ attachments: [att('a.pdf')] })) === '');
    check('goal: the more specific goal (speak) wins over the generic document summary', g('把這份 pdf 摘要後念出來', F({ attachments: [att('a.pdf')] })) === 'speak_summary', g('把這份 pdf 摘要後念出來', F({ attachments: [att('a.pdf')] })));
    check('goal: two equally specific goals are both returned (the model chooses from the menu)', g('合併 pdf 並取出第 2 頁', F({ attachments: [att('a.pdf'), att('b.pdf')] })) === 'pdf_merge,pdf_pages', g('合併 pdf 並取出第 2 頁', F({ attachments: [att('a.pdf'), att('b.pdf')] })));
    check('goal: nothing matches → empty', g('你好', F({ attachments: [att('a.mp4')] })) === '');
    check('goal menu shape', P.goalMenu(P.GOALS.slice(0, 2)).every((m) => m.tool && m.intent && m.score === 0));

    // ---- 規劃（倒推）----
    let pl = P.buildPlan({ target: 'summary' }, F({ attachments: [att('a.mp4')] }));
    check('plan: video → summary offline = transcribe > local_summarize', pl.ok && tools(pl) === 'transcribe_media>local_summarize', pl.steps && tools(pl));
    pl = P.buildPlan({ target: 'summary' }, Object.assign(F({ attachments: [att('a.mp4')] }), { online: true }));
    check('plan: with an online model the online summarizer is preferred', pl.ok && tools(pl) === 'transcribe_media>summarize_large_text', tools(pl));
    pl = P.buildPlan({ target: 'summary' }, F({ url: 'https://x.io' }));
    check('plan: url → fetch > local_summarize', tools(pl) === 'fetch_web_page>local_summarize', pl.steps && tools(pl));
    pl = P.buildPlan({ target: 'summary' }, F({ query: 'rust' }));
    check('plan: query → search > pick_urls > fetch > summarize (4 steps, in dependency order)', tools(pl) === 'browser_search>pick_urls>fetch_web_page>local_summarize', pl.steps && tools(pl));
    pl = P.buildPlan({ target: 'summary' }, F({ attachments: [att('r.docx')] }));
    check('plan: docx → parse > summarize', tools(pl) === 'parse_uploaded_file>local_summarize', pl.steps && tools(pl));
    pl = P.buildPlan({ target: 'audio' }, F({ attachments: [att('r.pdf')] }));
    check('plan: without a hint, speech reads the whole parsed text (shortest path)', tools(pl) === 'parse_uploaded_file>text_to_speech', tools(pl));
    pl = P.buildPlan({ target: 'audio' }, F({ attachments: [att('r.pdf')] }), { inputKinds: { 'text_to_speech.text': ['summary'] } });
    check('plan: "summarise then read aloud" restricts the speech input to a summary → parse > summarize > tts (a 3-hop chain)', tools(pl) === 'parse_uploaded_file>local_summarize>text_to_speech', pl.steps && tools(pl));
    pl = P.buildPlan({ target: 'pdf' }, F({ attachments: [att('a.png'), att('b.jpg')] }));
    check('plan: images → pdf is a single step with many inputs', tools(pl) === 'images_to_pdf' && pl.steps[0].bind.files.many === true, pl);
    pl = P.buildPlan({ target: 'pdf' }, F({ attachments: [att('a.pdf')] }));
    check('plan: nothing to do → explicit "already have it"', !pl.ok && /不需要計畫/.test(pl.reason), pl);
    pl = P.buildPlan({ target: 'gif' }, F({ attachments: [att('a.png')] }));
    check('plan: impossible goal → ok:false with the reason and the missing kind', !pl.ok && pl.missing.join() === 'gif' && /能力表/.test(pl.reason), pl);
    pl = P.buildPlan({ target: 'summary' }, F({ attachments: [att('a.mp4')] }), { excluded: ['transcribe_media'] });
    check('plan: excluding a broken tool finds no path when there is no alternative', !pl.ok, pl);
    pl = P.buildPlan({ target: 'summary' }, F({ url: 'https://x.io' }), { excluded: ['local_summarize'] });
    check('plan: excluding the offline summarizer without an online model → no path (honest, not a silent wrong answer)', !pl.ok || tools(pl) !== 'fetch_web_page>local_summarize');

    pl = P.buildPlan(P.GOALS.find((x) => x.id === 'web_summary'), F({ url: 'https://x.io', attachments: [att('old.txt', 't1')] }));
    check('plan: a goal only starts from the inputs it needs (a URL is fetched even if an unrelated text file is around)', tools(pl) === 'fetch_web_page>local_summarize', pl.steps && tools(pl));
    pl = P.buildPlan(P.GOALS.find((x) => x.id === 'doc_summary'), F({ url: 'https://x.io', attachments: [att('old.txt', 't1')] }));
    check('plan: a document summary ignores a URL that happens to be in the message', tools(pl) === 'local_summarize', pl.steps && tools(pl));
    // ---- phase／substep 展開 ----
    pl = P.buildPlan({ target: 'summary' }, F({ query: 'rust' }));
    const ph = P.expand(pl.steps);
    check('expand: phases follow the stage order and only include used stages', ph.map((p) => p.stage).join() === 'acquire,analyze', ph.map((p) => p.stage));
    check('expand: every step is broken into 4 substeps', pl.steps.every((s) => s.sub.length === 4 && /綁定輸入/.test(s.sub[0].name) && /驗證成品/.test(s.sub[2].name)));
    check('plan: data flow is bound by kind (each step reads the previous step output)', pl.steps[1].bind.results.from.ref === 's1' && pl.steps[2].bind.url.from.ref === 's2' && pl.steps[3].bind.text.from.ref === 's3', pl.steps.map((s) => s.bind));

    // ---- 狀態機：成功路徑（假環境）----
    const mkEnv = (impl, extra) => { const calls = []; const env = Object.assign({ calls, events: [], onEvent: (e) => env.events.push(e), tool: async (n, a) => { calls.push([n, a]); return impl[n] ? impl[n](a, calls.length) : { ok: false, text: '沒有這個工具' }; }, fns: {}, defsOf: () => [], saved: 0, save: () => { env.saved++; } }, extra || {}); return env; };
    const jr = (o) => ({ ok: true, text: JSON.stringify(o), json: o });
    let facts = F({ attachments: [att('talk.mp4', 'v1')], text: '整理摘要' });
    let plan = P.buildPlan({ target: 'summary' }, facts);
    let run = P.createRun({ id: 'video_summary', label: '影片做摘要' }, facts, plan, '整理摘要');
    let env = mkEnv({ transcribe_media: (a) => jr({ ok: true, text: '這是逐字稿內容。', language: 'zh' }) }, { fns: { local_summarize: async (a) => ({ ok: true, text: JSON.stringify({ summary: '摘要：逐字稿內容' }), json: { summary: '摘要：逐字稿內容' } }) } });
    await P.advance(run, env);
    check('run: happy path ends done with both steps done and artifacts registered', run.state === 'done' && run.steps.every((s) => s.state === 'done') && run.artifacts.some((a) => a.kind === 'transcript') && run.artifacts.some((a) => a.kind === 'summary'), { state: run.state, steps: run.steps.map((s) => s.state) });
    check('run: step 1 was fed the attachment id (bound by kind), local step ran locally', env.calls.length === 1 && env.calls[0][0] === 'transcribe_media' && env.calls[0][1].file === 'v1', env.calls);
    check('run: phases marked done, state persisted several times', run.phases.every((p) => p.state === 'done') && env.saved >= 2);
    const sm = P.summarizeRun(run);
    check('summarizeRun: final artifact of the target kind', sm.final && sm.final.kind === 'summary' && /摘要/.test(sm.final.value) && sm.doneSteps.join() === 'transcribe_media,local_summarize', sm);
    check('renderPlan: shows phases, checkmarks and the state', /Phase 1/.test(P.renderPlan(run)) && /✅ s1/.test(P.renderPlan(run)) && /完成/.test(P.renderPlan(run)), P.renderPlan(run));

    // ---- 決策樹：重試、換路、略過、問使用者、中止 ----
    check('decision: transient error retries (first time)', P.decideFailure({}, { attempts: 1 }, 'network timeout').action === 'retry');
    check('decision: transient error does not retry forever', P.decideFailure({}, { attempts: 2 }, 'network timeout').action !== 'retry');
    check('decision: optional step is skipped', P.decideFailure({}, { optional: true, attempts: 1 }, 'whatever').action === 'skip');
    check('decision: missing input → ask the user', P.decideFailure({}, { attempts: 1 }, '找不到檔案 abc').action === 'ask' && P.decideFailure({}, { attempts: 1 }, 'PDF 有密碼保護').action === 'ask');
    check('decision: unsupported input → replan', P.decideFailure({}, { attempts: 1 }, 'Input has an unsupported or unrecognizable format').action === 'replan');
    check('decision: unknown error → replan (try another path)', P.decideFailure({}, { attempts: 1 }, '???').action === 'replan');

    // 重試成功
    facts = F({ url: 'https://x.io' }); plan = P.buildPlan({ target: 'summary' }, facts); run = P.createRun({ id: 'web_summary', label: '網頁摘要' }, facts, plan, '');
    let n = 0; env = mkEnv({ fetch_web_page: (a) => (n++ === 0 ? { ok: false, text: 'fetch failed: timeout' } : jr({ ok: true, file_id: 'f1', title: 'T' })) }, { fns: { local_summarize: async () => ({ ok: true, text: '{}', json: { summary: 'S' } }) } });
    await P.advance(run, env);
    check('run: transient failure is retried once and then succeeds', run.state === 'done' && run.steps[0].attempts === 2 && env.events.some((e) => e.type === 'decision' && e.action === 'retry'), { st: run.state, ev: env.events.map((e) => e.type + ':' + (e.action || '')) });

    // 換路：線上摘要壞了 → 重新規劃走離線摘要
    facts = Object.assign(F({ url: 'https://x.io' }), { online: true }); plan = P.buildPlan({ target: 'summary' }, facts);
    check('precondition: online plan uses the online summarizer', tools(plan) === 'fetch_web_page>summarize_large_text');
    run = P.createRun({ id: 'web_summary', label: '網頁摘要' }, facts, plan, '');
    env = mkEnv({ fetch_web_page: () => jr({ ok: true, file_id: 'f1' }), summarize_large_text: () => ({ ok: false, text: '沒有可用的模型 (api key 未設定)' }) }, { fns: { local_summarize: async (a) => ({ ok: true, text: '{}', json: { summary: '離線摘要' } }) } });
    await P.advance(run, env);
    check('run: a failing online tool triggers a replan that excludes it and finishes through the offline path', run.state === 'done' && run.excluded.join() === 'summarize_large_text' && run.replans === 1 && run.steps.some((s) => s.state === 'replaced') && run.artifacts.some((a) => a.kind === 'summary' && a.value === '離線摘要'), { st: run.state, steps: run.steps.map((s) => s.tool + ':' + s.state), ex: run.excluded });
    check('run: the already-fetched page is NOT fetched again after the replan', env.calls.filter((c) => c[0] === 'fetch_web_page').length === 1, env.calls.map((c) => c[0]));

    // 沒有別條路 → 失敗並交出已完成的部分
    facts = F({ attachments: [att('a.mp4', 'v1')] }); plan = P.buildPlan({ target: 'summary' }, facts); run = P.createRun({ id: 'video_summary', label: 'x' }, facts, plan, '');
    env = mkEnv({ transcribe_media: () => ({ ok: false, text: '無法解碼這個影片' }) }, { fns: { local_summarize: async () => ({ ok: true, text: '{}', json: { summary: 'S' } }) } });
    await P.advance(run, env);
    check('run: failure with no alternative path → failed, nothing invented, error kept', run.state === 'failed' && /無法解碼/.test(run.error) && run.artifacts.length === 0, { st: run.state, err: run.error });

    // 限制：不會無窮重新規劃／呼叫
    facts = Object.assign(F({ url: 'https://x.io' }), { online: true }); plan = P.buildPlan({ target: 'summary' }, facts); run = P.createRun({ id: 'w', label: 'w' }, facts, plan, '');
    env = mkEnv({ fetch_web_page: () => jr({ ok: true, file_id: 'f1' }), summarize_large_text: () => ({ ok: false, text: 'boom' }) }, { fns: { local_summarize: async () => ({ ok: false, text: 'boom2' }) } });
    await P.advance(run, env);
    check('run: replan budget is bounded (replans ≤ 2, ends failed, finite number of calls)', run.state === 'failed' && run.replans <= 2 && env.calls.length <= 16, { st: run.state, rp: run.replans, calls: env.calls.length });
    run = P.createRun({ id: 'w', label: 'w' }, facts, plan, ''); env = mkEnv({ fetch_web_page: () => jr({ ok: true, file_id: 'f1' }), summarize_large_text: () => jr({ ok: true, summary: 'ok' }) }, { limits: { maxCalls: 1 } });
    await P.advance(run, env);
    check('run: call cap stops the run', run.state === 'failed' && /上限/.test(run.error), { st: run.state, err: run.error });

    // 驗證成品：呼叫成功但沒有預期成品 → 當成失敗處理
    facts = F({ attachments: [att('a.png', 'i1'), att('b.png', 'i2')] }); plan = P.buildPlan({ target: 'pdf' }, facts); run = P.createRun({ id: 'images_pdf', label: 'x' }, facts, plan, '');
    env = mkEnv({ images_to_pdf: () => jr({ ok: true, note: 'no file here' }) });
    await P.advance(run, env);
    check('run: success without the promised artifact is treated as a failure (verify substep)', run.state === 'failed' && env.events.some((e) => e.type === 'verify_failed'), env.events.map((e) => e.type));
    run = P.createRun({ id: 'images_pdf', label: 'x' }, facts, plan, ''); env = mkEnv({ images_to_pdf: (a) => jr({ ok: true, pdf_file_id: 'P1', filename: 'x.pdf', _a: a }) });
    await P.advance(run, env);
    check('run: many-input slot receives all image ids in order', run.state === 'done' && env.calls[0][1].files.join() === 'i1,i2' && run.artifacts[0].id === 'P1', { calls: env.calls, st: run.state });

    // ---- 問使用者與繼續 ----
    facts = F({ attachments: [att('doc.pdf', 'd1')], text: '取出頁面' }); plan = P.buildPlan({ target: 'pdf' }, facts, {}); // 已經有 pdf → 不需要計畫
    check('plan: pdf already present → no plan for pdf target', !plan.ok);
    const goalPages = P.GOALS.find((x) => x.id === 'pdf_pages');
    // extract_pdf_pages 需要 pages：用 images 為例不適用 → 直接造一個需要 extra 欄位的計畫
    plan = { ok: true, target: 'pdf', steps: [{ id: 's1', tool: 'extract_pdf_pages', label: '取出頁面', stage: 'produce', cost: 1, bind: { file: { kind: 'pdf', from: { type: 'fact', kind: 'pdf' }, many: false } }, extra: ['pages'], out: [{ kind: 'pdf', keys: ['pdf_file_id'] }], state: 'pending', attempts: 0 }] };
    run = P.createRun(goalPages, facts, plan, '取出頁面');
    const defs = R.slotsFromSchema({ type: 'object', properties: { file: { type: 'string' }, pages: { type: 'string', description: '頁碼範圍' } }, required: ['file', 'pages'] });
    env = mkEnv({ extract_pdf_pages: (a) => jr({ ok: true, pdf_file_id: 'P2', pages: a.pages }) }, { defsOf: () => defs, fill: async () => ({ values: {}, missing: defs.filter((d) => d.name === 'pages') }) });
    await P.advance(run, env);
    check('run: a missing required field the model cannot fill → waiting (asks the user), nothing executed', run.state === 'waiting' && run.waiting.missing.includes('pages') && env.calls.length === 0 && run.steps[0].state === 'waiting', { st: run.state, w: run.waiting });
    P.provide(run, { text: '1-3' }); env.fill = async () => ({ values: { pages: '1-3' }, missing: [] });
    await P.advance(run, env);
    check('provide: after the user answers, the run resumes from the waiting step and finishes', run.state === 'done' && env.calls.length === 1 && env.calls[0][1].pages === '1-3' && env.calls[0][1].file === 'd1', { st: run.state, calls: env.calls });
    run = P.createRun(goalPages, facts, JSON.parse(JSON.stringify(plan)), '');
    P.provide(run, { attachments: [att('more.pdf', 'm1')] });
    check('provide: new attachments become facts', run.facts.kinds.pdf === 2 && run.state === 'ready');

    // ---- 成品登記 ----
    const step = { id: 's1', out: [{ kind: 'audio', keys: ['audio_file_id'] }, { kind: 'text', inline: true }] };
    const arts = P.collectArtifacts(step, { audio_file_id: 'A1', filename: 'a.wav', text: '內容', other_file_id: 'Z9' }, '');
    check('artifacts: declared key, inline text and undeclared *_file_id are all registered', arts.some((a) => a.kind === 'audio' && a.id === 'A1') && arts.some((a) => a.kind === 'text' && a.value === '內容') && arts.some((a) => a.id === 'Z9'), arts);

    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
    process.exit(bad.length ? 1 : 0);
})();
