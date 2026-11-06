// 小窗口（任何窗口大小的模型都做得完）的工具接線（真實 Electron，直接呼叫工具）。
// 用法：node scripts/eval/run_eval.js scripts/eval/small-window.eval.js 17953
//   midi_compose_tree（start／read／set／assemble：一次一個節點）、uml_edit 的 next／queue（一次一格）、
//   分頁預算（token 算，中文不低估）與 pages_left、knowledge_ask／repo 的 _page 欄位不擋讀取帳本。
const fa = window.fa; const R = {};
const call = async (name, args) => { const t = fa.tools[name]; if (!t) return { _missing: name }; const raw = await t.callback.call(fa, JSON.stringify(args)); try { return JSON.parse(raw); } catch (_) { return { _text: String(raw).slice(0, 200) }; } };

// 1) 作曲樹：一次一個節點
R.compose = {};
try {
    const s = await call('midi_compose_tree', { action: 'start', description: '輕快的流行歌，C 調，16 小節', bars: 16 });
    R.compose.start = { ok: s.ok, tree_id: !!s.tree_id, spec: s.spec, total: s.total, pending: s.pending && s.pending.length, next: s.next && s.next.id, hasAsk: !!(s.next && /【/.test(s.next.ask)) };
    const bad = await call('midi_compose_tree', { action: 'set', tree_id: s.tree_id, node: 'harmony.main', value: 'XX YY' });
    R.compose.rejected = { ok: bad.ok, error: String(bad.error || '').slice(0, 50), retryAsk: !!(bad.retry && bad.retry.ask) };
    const answers = { form: 'B', 'harmony.main': 'I V vi IV', 'harmony.lift': 'IV I V vi', 'voices.main.texture': 'B', 'voices.main.bass': 'C', 'voices.main.drum': 'A', 'voices.lift.texture': 'C', 'voices.lift.bass': 'B', 'voices.lift.drum': 'B', motif: '1:q 3:q 5:q 4:q 3:q 2:q 1:h' };
    let r = s, guard = 0, set = [];
    while (r.next && guard++ < 20) { const id = r.next.id; const v = answers[id] || 'A'; r = await call('midi_compose_tree', { action: 'set', tree_id: s.tree_id, node: id, value: v }); set.push(id + ':' + (r.ok ? 'ok' : r.error)); if (!r.ok) break; }
    R.compose.set = set; R.compose.done = !!r.done;
    const rd = await call('midi_compose_tree', { action: 'read', tree_id: s.tree_id }); R.compose.read = { ok: rd.ok, rows: rd.rows && rd.rows.length, decided: rd.rows && rd.rows.filter((x) => x.decided).length, parents: rd.rows && rd.rows.filter((x) => x.parent).length };
    const as = await call('midi_compose_tree', { action: 'assemble', tree_id: s.tree_id, seed: 3 });
    R.compose.assemble = { ok: as.ok, song_id: !!as.song_id, warnings: as.warnings && as.warnings.length, undecided: as.undecided && as.undecided.length, err: as.error };
    R.compose.unknown_tree = (await call('midi_compose_tree', { action: 'read', tree_id: 'nope' })).ok;
} catch (e) { R.compose.exception = String((e && e.message) || e); }

// 2) uml_edit 的 next／queue：從空白一格一格做到完整
R.uml = {};
try {
    const empty = { name: '網路商店', actors: [], classes: [], usecases: [], relations: [] };
    const design = FaDesign.recommend('線上商店', 'python', {}); const sess = await fa._umlStartSession(JSON.parse(JSON.stringify(empty)), 'python', 'app', '網路商店', design);
    let u = await call('uml_edit', { session: sess.id, next: true }); const units = [];
    const first = u.unit && u.unit.unit;
    for (let i = 0; i < 12 && u.unit && !u.unit.done; i++) {
        units.push(u.unit.unit); const ops = u.unit.answer_with.ops;
        u = await call('uml_edit', { session: sess.id, ops, queue: true }); u = { unit: u.next_unit, rejected: u.rejected };
        if (u.rejected && u.rejected.length) { units.push('REJECTED'); break; }
    }
    const s2 = fa._umlSessions.get(sess.id);
    R.uml = { first, units, done: !!(u.unit && u.unit.done), classes: s2.model.classes.length, usecases: s2.model.usecases.length, errors: FaUml.validateModel(s2.model).length };
} catch (e) { R.uml.exception = String((e && e.message) || e); }

// 3) 分頁：token 預算（中文）與 pages_left，窗口 4096／8192／32768 各一次
R.pager = {};
try {
    const recs = []; for (let i = 0; i < 400; i++) recs.push({ id: i, 名稱: '項目' + i, 說明: '這是第' + i + '個項目的說明文字，大約三十個字左右。' });
    const gen = fa._getGenerationSettings(); const keep = gen.contextWindowTokens; const L = fa._faReadLedgerMod();
    for (const ctx of [4096, 8192, 32768]) {
        gen.contextWindowTokens = ctx; const id = fa._bigStash(JSON.stringify(recs), 'eval_cjk_' + ctx); const pg = fa._bigPage(id, null); const meta = JSON.parse(pg.text.split('\n')[0])._page; const opts = fa._pagerBudgetOpts();
        const pt = FaVlm.estimateTokens(pg.text); const g = L.record(L.createLedger(), 'big_content', { id }, { ok: true, _page: meta });
        R.pager['ctx' + ctx] = { mode: opts.maxTokens ? 'tokens' : 'chars', maxTokens: opts.maxTokens, pageTokens: pt, shareOfWindow: Math.round(pt / ctx * 100) + '%', returned: meta.returned, pages_left: meta.pages_left, reminder: L.reminderText(L.pending(g), { room: Math.floor(ctx * 0.5), pageTokens: pt }).split('\n').slice(1, 2).join('').slice(0, 200) };
    }
    gen.contextWindowTokens = keep;
    const g2 = L.record(L.createLedger(), 'knowledge_ask', { question: 'q' }, { ok: true, _page: { source: 'ki_ask:q', from: 0, to: 5, total: 5, has_more: true, blocking: false } }); R.pager.nonBlocking = L.pending(g2).length;
} catch (e) { R.pager.exception = String((e && e.message) || e); }

// 4) knowledge_ask 的 offset／_page（沒有知識庫內容時也要回得出 _page、不丟例外）
R.ki = {};
try { const r = await call('knowledge_ask', { question: '測試', limit: 3, offset: 3 }); R.ki = { ok: r.ok, page: r._page && { from: r._page.from, to: r._page.to, blocking: r._page.blocking, has_more: r._page.has_more, next_offset: r._page.next_offset }, err: r.error && String(r.error).slice(0, 80), text: r._text }; } catch (e) { R.ki.exception = String((e && e.message) || e); }
return R;
