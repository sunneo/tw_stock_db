/* 訓練工作室「領域」分頁的路由（UMD，依賴注入）。設計 §16.5。由 studio_server_core 在 route() 開頭呼叫 domainApi.route(method, url, body)，回 null 表示不是領域路由。
 * createDomainApi(c)：
 *   c.storage / c.prefsGet / c.prefsSet / c.now / c.log(text) / c.push(obj)?     工作室共用
 *   c.Asset / c.Eval                                                              asset_core／eval_core
 *   c.sym                                                                         { Synth, judge }（和評量共用）
 *   c.domain                                                                       { runtime, solve, runRef, corpus? }（App 端提供；缺的在畫面寫具體原因）
 *   c.teacherAI                                                                    async ({system, prompt, tools, maxRounds}) → {text}（選填）
 * 路由：
 *   GET  /api/domains                         已存的領域資產（含啟用狀態、驗證結果）＋範例＋環境能力
 *   GET  /api/domain?kind&name                規格全文
 *   POST /api/domain/validate {spec}          驗證＋摘要＋題目預覽（blockly：敘述與輸入範例；matrix：題目）
 *   POST /api/domain/preview {spec, family?, count?}   預覽家族生成的題目（有判題沙盒就連答案一起算）
 *   POST /api/domain/fit {spec, op, examples, statement?}   用輸入輸出範例擬合一個操作：顯示擬合結果、候選數、verified
 *   POST /api/domain/save {spec, replace?}    驗證通過才存成資產（kind blockly／matrix，名稱＝id）
 *   POST /api/domain/import {spec, fromAsset?, text?, split}   匯入既有題庫（資產 data/tasks.jsonl）或貼上的 JSONL，合併進規格（不改 holdout 題）
 *   POST /api/domain/enable {kind, name, enabled}   啟用／停用（載入或拿掉 FaDomains／矩陣層登記）
 *   POST /api/domain/eval {kind, name, saveBaseline?}   train／holdout 通過率、退步標紅（基準存偏好 evalBaseline['domain/<id>']）
 *   POST /api/domain/teach {kind, name, goal, confirmed}   老師（線上 AI）提議新家族／新範例：先預覽要送出的內容，confirmed 後才送；回來的提議必須經程式驗證才暫存
 *   POST /api/domain/teach/commit {kind, name, proposalId}   把通過驗證的提議合併進規格（作者標 teacher，只進 train） */
(function (root, factory) {
    const S = (typeof module === 'object' && module.exports) ? require('./domain_spec_core.js') : root.FaStudioDomainSpec;
    const EV = (typeof module === 'object' && module.exports) ? require('./domain_eval_core.js') : root.FaStudioDomainEval;
    const D = (typeof module === 'object' && module.exports) ? require('./domain_demo_core.js') : root.FaStudioDomainDemo;
    const X = (typeof module === 'object' && module.exports) ? require('./dsl_expr_core.js') : root.FaStudioExpr;
    if (typeof module === 'object' && module.exports) module.exports = factory(S, EV, D, X);
    else root.FaStudioDomainApi = factory(S, EV, D, X);
})(typeof self !== 'undefined' ? self : this, function (Spec, DEval, Demo, Expr) {
    'use strict';
    const dec = (u) => new TextDecoder('utf-8').decode(u);
    const jsonl = (u8) => dec(u8).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
    const KINDS = ['blockly', 'matrix'];
    const TEACH_LIMITS = { families: 3, statements: 6, chars: 8000 };

    function createDomainApi(c) {
        const d = c.domain || {}; const now = () => (c.now ? c.now() : Date.now());
        const ok = (j) => ({ j: Object.assign({ ok: true }, j) }), bad = (s, error, extra) => ({ s, j: Object.assign({ ok: false, error }, extra || {}) });
        const prefs = () => (c.prefsGet && c.prefsGet()) || {};
        const enabledMap = () => prefs().domainEnabled || {};
        const proposals = new Map(); let pseq = 0;
        const evalDeps = (cache) => ({ runtime: d.runtime, solve: d.solve, runRef: d.runRef, Synth: c.sym && c.sym.Synth, Expr, judge: c.sym && c.sym.judge, corpus: d.corpus, cache: cache || {} });
        const caps = () => ({
            blockly: d.solve && d.runRef ? { ok: true } : { ok: false, reason: DEval.NO_SOLVE },
            matrix: c.sym && c.sym.Synth ? { ok: true, judge: !!(c.sym && c.sym.judge), note: c.sym && c.sym.judge ? '' : '沒有判題器時：使用者操作用同一份運算式重算隱藏範例（照樣可驗證）；內建合成器解出的程式無法驗證隱藏範例' } : { ok: false, reason: '沒有載入 matrix_synth_core' },
            runtime: d.runtime ? { ok: true } : { ok: false, reason: '這個環境沒有領域載入器（FaStudioDomainRuntime），領域只能編輯、評量，不會被離線 AI 用到' }
        });
        async function loadSpec(kind, name) {
            const r = await c.storage.loadAsset(kind, name); if (!r) return { error: '沒有這個資產：' + kind + '/' + name };
            const f = Spec.fromFiles(r.asset.files); if (!f.ok) return { error: f.error };
            const teacher = r.asset.files['data/teacher.jsonl'] ? jsonl(r.asset.files['data/teacher.jsonl']) : [];
            return { spec: f.spec, manifest: r.asset.manifest, verify: r.verify, teacherRows: teacher, files: r.asset.files };
        }
        // 老師暫存的題目列（data/teacher.jsonl）併進題目（只進 train；留出題不收）
        function withTeacher(spec, rows) {
            if (!rows || !rows.length) return spec;
            const s = JSON.parse(JSON.stringify(spec)); const have = new Set((s.tasks || []).map((t) => t.id));
            rows.forEach((r, i) => { if (!r || r.split === 'holdout' || r.split === 'heldout' || !r.statement) return; const id = 'teacher-' + (r.id || i); if (have.has(id)) return; have.add(id);
                if (s.kind === 'matrix' && Array.isArray(r.examples) && r.examples.length >= 3) s.tasks.push({ id, op: r.op, split: 'train', statement: r.statement, examples: r.examples.slice(0, 2), hidden: r.examples.slice(2) });
                if (s.kind === 'blockly' && Array.isArray(r.tests) && r.tests.length >= 3) s.tasks.push({ id, split: 'train', statement: r.statement, solution: r.solution, tests: r.tests }); });
            return s;
        }
        async function saveSpec(spec, opts) {
            const v = Spec.validate(spec); if (!v.ok) return { ok: false, error: '規格沒通過驗證：' + v.errors.slice(0, 5).join('；'), validation: v };
            const n = Spec.normalize(spec); let tasks = []; const problems = [];
            if (n.kind === 'matrix') tasks = (await Spec.buildTasks(n, {})).tasks;
            else if (d.runRef) { const bt = await Spec.buildTasks(n, { runRef: d.runRef, tests: 4, hidden: 2 }); tasks = bt.tasks; bt.problems.forEach((p) => problems.push(p)); }
            const files = Spec.toFiles(n, tasks); const sm = Spec.summary(n);
            const manifest = c.Asset.createManifest({ kind: n.kind, name: n.id, files, counts: { train: sm.train, holdout: sm.holdout, algos: sm.algos, skeletons: sm.skeletons, ops: sm.ops, families: sm.families, tasks_materialized: tasks.length }, owner: 'user', parent: opts && opts.parent || null, created: new Date(now()).toISOString(),
                extra: { domain: { id: n.id, spec_version: n.version, spec_sha256: Spec.hash(n), license: n.meta.license || null, source: n.meta.source || null, author: n.meta.author || null } } });
            const old = await c.storage.loadManifest(n.kind, n.id);
            if (old && !(opts && opts.replace)) return { ok: false, error: '「' + n.id + '」已存在（要覆蓋請帶 replace:true）', exists: true };
            const w = await c.storage.saveAsset({ manifest, files }, { replace: true }); if (!w.ok) return { ok: false, error: w.error };
            if (c.log) c.log('儲存領域規格 ' + n.kind + '/' + n.id + '（' + sm.train + ' train、' + sm.holdout + ' holdout）' + (problems.length ? '；有 ' + problems.length + ' 個家族沒能算出測資' : ''));
            if (c.push) c.push({ type: 'asset_changed' });
            return { ok: true, name: n.id, kind: n.kind, write: w, summary: sm, warnings: v.warnings, problems };
        }
        async function syncRuntime() { if (!d.runtime) return null; const items = (await c.storage.listAssets()).filter((x) => KINDS.indexOf(x.kind) >= 0); return d.runtime.syncEnabled({ list: async () => items, load: async (k, n) => { const r = await loadSpec(k, n); return r.spec || null; } }, enabledMap()); }

        async function route(method, u, body) {
            const P = u.pathname, Q = (k) => u.searchParams.get(k) || ''; body = body || {};
            if (!/^\/api\/domains?(\/|$)/.test(P)) return null;
            try {
                if (method === 'GET' && P === '/api/domains') {
                    const items = (await c.storage.listAssets()).filter((x) => KINDS.indexOf(x.kind) >= 0); const out = []; const en = enabledMap();
                    for (const it of items) { const r = await loadSpec(it.kind, it.name); if (!r.spec) continue; const v = Spec.validate(r.spec); out.push({ kind: it.kind, name: it.name, label: r.spec.label, enabled: en[it.kind + '/' + it.name] === true, loaded: d.runtime ? d.runtime.has(r.spec.id) : false, valid: v.ok, errors: v.errors.slice(0, 3), summary: Spec.summary(r.spec), license: r.spec.meta && r.spec.meta.license || '', source: r.spec.meta && r.spec.meta.source || '', owner: r.manifest.owner, hasTeacherRows: r.teacherRows.length }); }
                    return ok({ items: out, demos: { blockly: Demo.blockly(), matrix: Demo.matrix() }, caps: caps(), formats: { version: Spec.VERSION, limits: Spec.LIMITS, funcs: Expr.FUNCS, methods: Expr.METHODS }, runtime: d.runtime ? d.runtime.status() : [] });
                }
                if (method === 'GET' && P === '/api/domain') { const r = await loadSpec(Q('kind'), Q('name')); if (!r.spec) return bad(404, r.error); return ok({ spec: r.spec, manifest: r.manifest, verify: { ok: r.verify.ok, message: r.verify.message || '' }, teacherRows: r.teacherRows.length }); }
                if (method === 'POST' && P === '/api/domain/validate') {
                    const spec = body.spec; const v = Spec.validate(spec, { builtin: !!body.builtin }); const out = { validation: v };
                    if (v.ok) { out.summary = Spec.summary(spec); out.hash = Spec.hash(Spec.normalize(spec));
                        if (spec.kind === 'blockly') out.preview = (spec.families || []).map((f) => ({ family: f.id, split: f.split, statements: Spec.expandStatements(f).slice(0, 4).map((x) => x.statement), inputs: Spec.makeInputs(f, { seed: spec.seed, count: 2 }) }));
                        else out.preview = (spec.tasks || []).slice(0, 8).map((t) => ({ id: t.id, split: t.split, statement: clip(t.statement, 80), examples: (t.examples || []).length, hidden: (t.hidden || []).length })); }
                    return ok(out);
                }
                if (method === 'POST' && P === '/api/domain/preview') {
                    const spec = body.spec; const v = Spec.validate(spec); if (!v.ok) return bad(400, '規格沒通過驗證：' + v.errors.slice(0, 3).join('；'), { validation: v });
                    if (spec.kind !== 'blockly') return bad(400, 'matrix 領域沒有家族；預覽請用 validate 的題目清單，或用 fit 看操作擬合');
                    const f = (spec.families || []).find((x) => x.id === body.family) || (spec.families || [])[0]; if (!f) return bad(400, '沒有家族可預覽');
                    const n = Math.min(Number(body.count) || 3, 8); const ins = Spec.makeInputs(f, { seed: spec.seed, count: n }); const rows = [];
                    for (const inp of ins) { let out = null, err = ''; if (d.runRef) { const r = await d.runRef(f.ref, inp); if (r && r.ok) out = r.out; else err = clip(r && r.error, 200) || '參考解沒有輸出'; } rows.push({ in: inp, out, error: err }); }
                    return ok({ family: f.id, split: f.split, statements: Spec.expandStatements(f).slice(0, 6), tests: rows, answered: !!d.runRef, note: d.runRef ? '' : '沒有判題沙盒，只顯示輸入；解除條件：桌面版並開啟「允許 AI 執行程式」' });
                }
                if (method === 'POST' && P === '/api/domain/fit') {
                    const spec = body.spec; const v = Spec.validate(spec); if (!v.ok) return bad(400, '規格沒通過驗證：' + v.errors.slice(0, 3).join('；'), { validation: v });
                    const op = (spec.ops || []).find((o) => o.id === body.op); if (!op) return bad(400, '規格裡沒有操作 ' + body.op);
                    const ex = (body.examples || []).filter((e) => e && typeof e.in === 'string' && typeof e.out === 'string'); if (ex.length < 2) return bad(400, '至少 2 筆範例');
                    const fit = ex.slice(0, Number(body.fitN) || 2), held = ex.slice(fit.length); const r = Spec.fitOp(op, fit, Expr);
                    if (!r.ok) return ok({ fitted: false, reason: r.reason, tried: r.tried, verified: false });
                    const cands = [{ assignment: r.assignment, source: r.source }].concat(r.alternatives); let chosen = cands[0], verified = false, heldPass = 0;
                    if (held.length) { const good = cands.find((cd) => held.every((h) => { const q = Spec.replay(op, cd.assignment, h.in, Expr); return q.ok && q.out.trim() === String(h.out).trim(); })); if (good) { chosen = good; verified = true; heldPass = held.length; } else verified = false; }
                    return ok({ fitted: true, assignment: chosen.assignment, source: chosen.source, candidates: cands.length, ambiguous: cands.length > 1 && !verified, verified, heldout: held.length, heldoutPass: heldPass, tried: r.tried,
                        status: verified ? '已驗證（' + held.length + ' 筆沒參與擬合的範例都對）' : held.length ? '未驗證：擬合出的參數對不上後面 ' + held.length + ' 筆範例' : '未驗證：只有擬合用的範例，' + (cands.length > 1 ? '而且有 ' + cands.length + ' 個候選全對（範例太少）' : '沒有範例以外的資料驗證') });
                }
                if (method === 'POST' && P === '/api/domain/save') { const r = await saveSpec(body.spec, { replace: !!body.replace }); return r.ok ? ok(r) : bad(r.exists ? 409 : 400, r.error, r); }
                if (method === 'POST' && P === '/api/domain/import') {
                    const spec = JSON.parse(JSON.stringify(body.spec || {})); if (spec.kind !== 'blockly' && spec.kind !== 'matrix') return bad(400, '規格 kind 不對');
                    let rows = []; if (body.fromAsset) { const m = /^([a-z]+)\/(.+)$/.exec(String(body.fromAsset)); if (!m) return bad(400, '資產參照格式是 kind/name'); const r = await c.storage.loadAsset(m[1], m[2]); const f = r && r.asset.files['data/tasks.jsonl']; if (!f) return bad(404, String(body.fromAsset) + ' 沒有 data/tasks.jsonl'); rows = jsonl(f); }
                    if (body.text) { rows = rows.concat(String(body.text).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean)); }
                    if (!rows.length) return bad(400, '沒有讀到任何題目列（每列要是一個 JSON 物件）');
                    const split = body.split === 'holdout' ? 'holdout' : 'train'; const have = new Set((spec.tasks || []).map((t) => t.id)); spec.tasks = spec.tasks || []; let added = 0, skipped = [];
                    rows.forEach((r, i) => { const id = String(r.id || ('imp-' + (i + 1))); if (have.has(id)) { skipped.push(id + '：id 已存在'); return; }
                        if (spec.kind === 'matrix') { if (!r.statement || !Array.isArray(r.examples) || r.examples.length < 2) { skipped.push(id + '：要有 statement 與至少 2 筆 examples'); return; } spec.tasks.push({ id, op: r.op || undefined, split, statement: r.statement, examples: r.examples.slice(0, Math.max(2, Math.min(2, r.examples.length))), hidden: r.hidden || r.examples.slice(2) }); }
                        else { if (!r.statement || !Array.isArray(r.tests) || r.tests.length < 3) { skipped.push(id + '：要有 statement 與至少 3 筆 tests'); return; } spec.tasks.push({ id, split, statement: r.statement, solution: r.solution, tests: r.tests }); }
                        have.add(id); added++; });
                    const v = Spec.validate(spec); return ok({ spec, added, skipped, validation: v });
                }
                if (method === 'POST' && P === '/api/domain/enable') {
                    const kind = String(body.kind || ''), name = String(body.name || ''); const r = await loadSpec(kind, name); if (!r.spec) return bad(404, r.error);
                    if (body.enabled) { const v = Spec.validate(r.spec); if (!v.ok) return bad(409, '規格沒通過驗證，不能啟用：' + v.errors.slice(0, 3).join('；'), { validation: v }); if (!d.runtime) return bad(501, caps().runtime.reason); }
                    const np = Object.assign({}, prefs()); np.domainEnabled = Object.assign({}, np.domainEnabled); if (body.enabled) np.domainEnabled[kind + '/' + name] = true; else delete np.domainEnabled[kind + '/' + name]; c.prefsSet(np);
                    const sync = await syncRuntime(); const failed = sync && sync.failed.find((f) => f.ref === kind + '/' + name);
                    if (failed) { delete np.domainEnabled[kind + '/' + name]; c.prefsSet(np); await syncRuntime(); return bad(409, '啟用失敗：' + failed.error, { sync }); }
                    if (c.log) c.log((body.enabled ? '啟用' : '停用') + '領域 ' + kind + '/' + name); return ok({ enabled: !!body.enabled, sync });
                }
                if (method === 'POST' && P === '/api/domain/eval') {
                    const r = await loadSpec(String(body.kind || ''), String(body.name || '')); if (!r.spec) return bad(404, r.error);
                    const spec = withTeacher(r.spec, r.teacherRows); const key = 'domain/' + spec.id; const p = prefs();
                    const suites = DEval.domainSuites(spec, evalDeps({}));
                    const res = await c.Eval.runEval(spec.kind, suites, { baseline: (p.evalBaseline || {})[key] || {}, gate: p.evalGate, now: c.now });
                    if (body.saveBaseline && res.summary.ran) { const np = Object.assign({}, prefs()); np.evalBaseline = Object.assign({}, np.evalBaseline); np.evalBaseline[key] = c.Eval.saveBaseline(res, np.evalBaseline[key]); c.prefsSet(np); res.baselineSaved = true; }
                    if (c.log) c.log('領域評量 ' + key + '：' + res.summary.ran + '/' + res.summary.groups + ' 組有跑，退步 ' + res.summary.regressed);
                    return ok(res);
                }
                // ---- 老師：提議新家族／範例（程式驗證才暫存；holdout 不可教）----
                if (method === 'POST' && P === '/api/domain/teach') {
                    const r = await loadSpec(String(body.kind || ''), String(body.name || '')); if (!r.spec) return bad(404, r.error);
                    if (r.spec.kind !== 'blockly') return bad(400, '老師提議新家族只支援 blockly 領域；matrix 領域請用「資料集」分頁的老師迴圈補範例（data/teacher.jsonl 會併進這個領域的 train 題）');
                    const spec = r.spec; const sendTrain = { id: spec.id, label: spec.label, algos: spec.algos, skeletons: spec.skeletons.map((s) => ({ id: s.id, algo: s.algo, label: s.label, slots: (s.slots || []).map((x) => x.id), needs: s.needs })), train_families: (spec.families || []).filter((f) => f.split === 'train').map((f) => ({ id: f.id, algo: f.algo, statements: f.statements })) }; // 不送 holdout、不送參考解細節以外的東西
                    const prompt = '你是領域老師。目前領域的規格（只含訓練部分）：\n' + JSON.stringify(sendTrain) + '\n目標：' + String(body.goal || '擴充題目家族') + '\n請只回一個 JSON：{"families":[{"id","algo","statements":[題目樣板…],"params":{…}?,"ref":"Python 參考解","gen":[輸入產生規則]}]}。每個家族 split 一律是 train；statements 要用一致的格式描述輸入；ref 只能用標準輸入輸出與允許的匯入。最多 ' + TEACH_LIMITS.families + ' 個家族、每個最多 ' + TEACH_LIMITS.statements + ' 個敘述。';
                    if (!body.confirmed) return ok({ needsConfirm: true, willSend: { prompt: clip(prompt, 6000), chars: prompt.length, note: '只送訓練部分的規格摘要與目標，不送 holdout、不送使用者檔案' } });
                    if (!c.teacherAI) return bad(501, '這個環境沒有接上線上 AI 子任務（teacherAI）；桌面版與網頁版都在設定→AI 有線上模型時才能用老師。也可以手動貼提議到 propose 欄位。');
                    const ai = await c.teacherAI({ system: '你是嚴謹的題庫老師，只輸出 JSON。', prompt, tools: {}, maxRounds: 2 }); return await receive(spec, String(ai && ai.text || ''), 'teacher');
                }
                if (method === 'POST' && P === '/api/domain/teach/propose') { const r = await loadSpec(String(body.kind || ''), String(body.name || '')); if (!r.spec) return bad(404, r.error); return await receive(r.spec, typeof body.proposal === 'string' ? body.proposal : JSON.stringify(body.proposal || {}), body.author === 'teacher' ? 'teacher' : 'user'); }
                if (method === 'POST' && P === '/api/domain/teach/commit') {
                    const pr = proposals.get(String(body.proposalId || '')); if (!pr) return bad(409, '沒有這個提議（可能已提交或視窗重開）'); if (pr.kind !== body.kind || pr.name !== body.name) return bad(409, '提議不屬於這個領域');
                    const r = await loadSpec(pr.kind, pr.name); if (!r.spec) return bad(404, r.error); const spec = JSON.parse(JSON.stringify(r.spec));
                    if (Spec.hash(Spec.normalize(spec)) !== pr.baseHash) return bad(409, '領域在提議之後被改過，請重新提議');
                    spec.families = (spec.families || []).concat(pr.families); const sv = await saveSpec(spec, { replace: true, parent: pr.name }); if (!sv.ok) return bad(409, sv.error, sv);
                    proposals.delete(pr.id); if (d.runtime && d.runtime.has(spec.id)) await syncRuntime(); return ok({ committed: pr.families.map((f) => f.id), summary: sv.summary });
                }
                return bad(404, '未知的領域路由：' + P);
            } catch (e) { return bad(500, String((e && e.message) || e)); }
        }
        // 收提議：解析→強制 train→合併驗證→在判題沙盒跑參考解（兩次結果要一致）→通過才暫存
        async function receive(spec, text, author) {
            let obj; try { const m = /\{[\s\S]*\}/.exec(text); obj = JSON.parse(m ? m[0] : text); } catch (_) { return bad(422, '提議不是合法的 JSON'); }
            let fams = Array.isArray(obj.families) ? obj.families : null; if (!fams || !fams.length) return bad(422, '提議裡沒有 families');
            if (fams.length > TEACH_LIMITS.families) return bad(422, '一次最多 ' + TEACH_LIMITS.families + ' 個家族'); if (JSON.stringify(fams).length > TEACH_LIMITS.chars) return bad(422, '提議太長（上限 ' + TEACH_LIMITS.chars + ' 字元）');
            const taken = new Set((spec.families || []).map((f) => f.id)); const problems = [];
            fams = fams.map((f, i) => Object.assign({}, f, { split: 'train', origin: { author, at: now() }, id: taken.has(f.id) ? undefined : f.id }));
            if (fams.some((f) => !f.id)) return bad(422, '家族 id 缺少或與現有的重複');
            const merged = JSON.parse(JSON.stringify(spec)); merged.families = (merged.families || []).concat(fams);
            const v = Spec.validate(merged); if (!v.ok) return bad(422, '提議沒通過規格驗證（含 holdout 不可混入檢查）：' + v.errors.slice(0, 4).join('；'), { validation: v });
            const evidence = [];
            if (d.runRef) { for (const f of fams) { const ins = Spec.makeInputs(f, { seed: spec.seed, count: 3 }); for (const inp of ins) { const a = await d.runRef(f.ref, inp), b = await d.runRef(f.ref, inp); if (!a || !a.ok || !String(a.out || '').trim()) { problems.push(f.id + '：參考解在產生的輸入上沒有輸出'); break; } if (a.out !== b.out) { problems.push(f.id + '：參考解兩次結果不一致（不可重現）'); break; } } if (!problems.some((p) => p.startsWith(f.id + '：'))) evidence.push({ family: f.id, verified_by: '判題沙盒執行參考解，輸出非空且可重現' }); } }
            else problems.push('沒有判題沙盒，無法用程式驗證提議（解除條件：桌面版並開啟「允許 AI 執行程式」）');
            if (problems.length) return bad(422, '提議沒通過程式驗證', { problems });
            const id = 'p' + (++pseq); proposals.set(id, { id, kind: spec.kind, name: spec.id, families: fams, baseHash: Spec.hash(Spec.normalize(spec)) });
            return ok({ proposalId: id, families: fams.map((f) => ({ id: f.id, algo: f.algo, split: f.split, statements: Spec.expandStatements(f).slice(0, 4).map((x) => x.statement) })), evidence, note: '已通過程式驗證，尚未寫入；確認後按提交。提議一律標 train，作者 ' + author });
        }
        return { route, saveSpec, loadSpec, syncRuntime, withTeacher };
    }
    return { createDomainApi };
});
