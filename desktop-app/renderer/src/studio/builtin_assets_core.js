/* 訓練工作室「內建資產」唯讀提供者（UMD，依賴注入，不碰 DOM／網路／檔案系統）。
 * 為什麼有它：資產清單原本只列儲存層（記憶體／fap）裡的資產，已經做好的內建內容（積木領域包與內建課、CoLU 排序與回饋、矩陣層合成器、
 * 離線訓練器規則、UML 設計表、LoRA 現況）不在儲存層，使用者打開就看到「全部 0 個」。這裡把它們讀出來，以 owner:'builtin' 的虛擬資產列出：
 * 名稱、數量、來源檔案、版本、評量摘要；資料集可瀏覽（唯讀）、可匯出成 .fatrain。數量一律從實際載入的物件算，不寫死。
 * createProvider(deps)，deps 全部選填；缺的來源回「不可用」並寫具體原因（不假裝是 0 個、也不假裝做好）：
 *   domainPacks()        → 已 make 好的領域包陣列（FaDomains.register 用的那種）
 *   seedCounts           → {領域包id:{total,train,holdout,file}}（種子題只寫在測試檔，建置時由 scripts/domain-seed-counts.js 算好嵌入）
 *   lessons              → FaPyLessonsBuiltin 物件（{generatedAt, verified, lessons:[…]}）
 *   feedbackStats()      → async，{stats, location, store?}｜null（CoLU 回饋累積：FaCatalogFeedback.stats(store)）
 *   rankModel()          → async，排名模型物件｜null；rankReport 之類的評量放在 model.report（有才顯示）
 *   presetProfiles()     → [{model, advice, testedAt, self, assisted…}]（內建模型的 CoLU 體檢）
 *   routeEval()          → async，{tasks, units, edges}｜null（接線路由評量集的題數）
 *   matrixSynth          → FaMatrixSynth（要有 list()）
 *   umlCore／designCore  → FaUml／FaDesign 的匯出物件；umlBench → FaUmlBench（FIXTURES／BIG）
 *   trainerDomains()     → async，離線訓練器內建（source:'builtin'）領域陣列
 *   loraInfo()           → async，{adapters:[…], datasets:[{name,rows,file}], note}
 *   webReason            → 字串；網頁版取不到某些內容時的共同原因前綴（選填）
 *   now()
 * 回傳 { list(), read(kind,name), has(kind,name), summary(), SOURCES } 。list 項目形狀同儲存層 listAssets 加上 readonly／note／unavailable／source_files／version。 */
(function (root, factory) {
    const A = (typeof module === 'object' && module.exports) ? require('./asset_core.js') : root.FaStudioAsset;
    if (typeof module === 'object' && module.exports) module.exports = factory(A);
    else root.FaStudioBuiltin = factory(A);
})(typeof self !== 'undefined' ? self : this, function (Asset) {
    'use strict';
    const enc = (o) => new TextEncoder().encode(typeof o === 'string' ? o : JSON.stringify(o, null, 1));
    const P = 'renderer/src/';
    const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) + '…' : s; };
    const NAMES = {
        blockly_domains: '內建-領域包', blockly_lessons: '內建-內建課', colu_feedback: '內建-回饋紀錄', colu_rank: '內建-排序模型',
        colu_profiles: '內建-模型體檢', colu_route: '內建-接線評量', matrix: '內建-合成器', trainer: '內建-離線訓練器', uml: '內建-UML設計表', lora: '內建-LoRA現況'
    };

    function createProvider(deps) {
        deps = deps || {};
        const now = () => (deps.now ? deps.now() : Date.now());
        const created = () => new Date(now()).toISOString();
        const ua = (kind, name, why) => ({ kind, name, unavailable: why, counts: {}, files: {}, source_files: [], summary: why, version: '' });

        // ===== 各種內容 =====
        async function blocklyDomains() {
            if (!deps.domainPacks) return ua('blockly', NAMES.blockly_domains, '這個環境沒有接上領域包（FaDomains）');
            const packs = deps.domainPacks() || []; const doms = []; const seeds = []; let nAlgo = 0, nPar = 0, nSk = 0, nSeed = 0, nTrain = 0, nHold = 0;
            for (const p of packs) {
                const par = Object.keys(p.paradigms || {}).reduce((n, k) => n + (p.paradigms[k] || []).length, 0);
                const sd = p.seeds || [], sc = (deps.seedCounts || {})[p.id]; const hold = sc && !sd.length ? sc.holdout : sd.filter((s) => s.split === 'holdout').length; const total = sc && !sd.length ? sc.total : sd.length;
                nAlgo += (p.algos || []).length; nPar += par; nSk += (p.skeletons || []).length; nSeed += total; nHold += hold; nTrain += total - hold; nSeed += 0;
                doms.push({ id: p.id, label: p.label, requires: p.requires || [], judge: p.judge || null, algos: (p.algos || []).map((a) => a.key), paradigms: p.paradigms || {}, skeletons: (p.skeletons || []).map((s) => ({ id: s.id, paradigm: s.paradigm, algo: s.algo, label: s.label })), seed_total: total, train: total - hold, holdout: hold, seeds_from: sd.length ? 'pack.seeds' : (sc ? sc.file : '（沒有種子題資料）') });
                for (const s of sd) seeds.push({ domain: p.id, id: s.id, split: s.split === 'holdout' ? 'holdout' : 'train', want: s.want, statement: clip(s.st, 400) });
            }
            const files = { 'data/domains.json': enc(doms), 'data/seeds.jsonl': enc(seeds.map((x) => JSON.stringify(x)).join('\n')), 'README.txt': enc('積木課程的領域包（唯讀，內建在程式裡）。數量由載入的領域包算出。\n來源：uml/domain_*_core.js，經 FaDomains.register 註冊。') };
            return { kind: 'blockly', name: NAMES.blockly_domains, version: 'packs ' + packs.length, files, counts: { packs: packs.length, algos: nAlgo, paradigms: nPar, skeletons: nSk, seeds: nSeed, train: nTrain, holdout: nHold }, source_files: [P + 'uml/domain_*_core.js（共 ' + packs.length + ' 個領域包）', P + 'uml/domain_registry_core.js'], summary: packs.length + ' 個領域包：' + nAlgo + ' 種算法、' + nSk + ' 個骨架、' + nSeed + ' 題種子（訓練 ' + nTrain + '／留存 ' + nHold + '）；種子題的實際評量在各 domain_*.test.js，這裡不重跑' };
        }
        async function blocklyLessons() {
            const L = deps.lessons; if (!L || !Array.isArray(L.lessons)) return ua('blockly', NAMES.blockly_lessons, '這個環境沒有載入內建課（py_lessons_builtin.js）');
            const algos = new Set(L.lessons.map((l) => l.algo)); const v = L.verified || {};
            const rows = L.lessons.map((l) => ({ id: l.id, algo: l.algo, shape: l.shape, nparams: l.nparams, paradigms: l.paradigms, cnl: clip(l.cnl, 300) }));
            const files = { 'data/lessons.jsonl': enc(rows.map((x) => JSON.stringify(x)).join('\n')), 'README.txt': enc('老師教、判題器驗證後收的內建課（唯讀）。由 scripts/teach-builtin-lessons.js 產生，不手改。') };
            return { kind: 'blockly', name: NAMES.blockly_lessons, version: L.generatedAt || '', files, counts: { lessons: L.lessons.length, algos: algos.size, verified_tasks: v.tasks || 0 }, source_files: [P + 'uml/py_lessons_builtin.js', 'scripts/teach-builtin-lessons.js（產生器）'], eval: v.tasks != null ? { verified_tasks: v.tasks, offline_after: v.offlineAfter, offline_before: v.offlineBefore } : null, summary: L.lessons.length + ' 堂課、' + algos.size + ' 種算法；產生於 ' + (L.generatedAt || '?') + '，離線通過 ' + (v.offlineBefore != null ? v.offlineBefore + ' → ' + v.offlineAfter + '／' + v.tasks : '（沒有記錄）') };
        }
        async function coluFeedback() {
            if (!deps.feedbackStats) return ua('colu', NAMES.colu_feedback, '這個環境沒有接上回饋累積（FaCatalogFeedback）');
            const r = await deps.feedbackStats();
            if (!r) return ua('colu', NAMES.colu_feedback, '讀不到回饋紀錄的儲存位置（桌面版與網頁版都存在 fileCache 的 unit-catalog-feedback.json；這次讀取失敗）');
            const s = r.stats || {}; const files = { 'data/feedback-stats.json': enc(s), 'README.txt': enc('採用／退回的回饋累積（使用者實際使用產生，唯讀檢視）。儲存位置：' + (r.location || 'fileCache unit-catalog-feedback.json') + '。') };
            if (r.store && Array.isArray(r.store.records)) files['data/feedback.jsonl'] = enc(r.store.records.map((x) => JSON.stringify({ source: x.source, verdict: x.verdict, weight: x.weight, group: x.group, at: x.at })).join('\n'));
            return { kind: 'colu', name: NAMES.colu_feedback, version: '', files, counts: { records: s.records || 0, rows: s.rows || 0, positives: s.positives || 0, negatives: s.negatives || 0, groups: s.groups || 0 }, source_files: [P + 'catalog/feedback_core.js', '執行期儲存：' + (r.location || 'fileCache／unit-catalog-feedback.json')], summary: (s.records || 0) + ' 筆回饋（正例 ' + (s.positives || 0) + '、負例 ' + (s.negatives || 0) + '、' + (s.groups || 0) + ' 組）；' + (s.ready_to_train ? '資料量已夠訓練排名模型' : '還不夠訓練排名模型（' + ((s.missing || []).join('、') || '—') + '）') + '。這是使用者用出來的資料，空的表示還沒有人採用／退回過推薦' };
        }
        async function coluRank() {
            if (!deps.rankModel) return ua('colu', NAMES.colu_rank, '這個環境沒有接上排名模型（FaCatalogRankTrain）');
            const m = await deps.rankModel();
            if (!m) return { kind: 'colu', name: NAMES.colu_rank, version: '', files: { 'README.txt': enc('排序模型尚未訓練：回饋紀錄需累積到門檻（見「內建-回饋紀錄」）後由 rank_train.js 的 trainReport 訓練並存成 unit-catalog-rank-model.json。') }, counts: { weights: 0, trained: 0 }, source_files: [P + 'catalog/rank_train.js', '執行期儲存：fileCache／unit-catalog-rank-model.json'], summary: '程式碼（rank_train.js）已內建，但這台電腦還沒有訓練出的模型檔' };
            const rp = m.report || null;
            return { kind: 'colu', name: NAMES.colu_rank, version: m.trainedAt ? new Date(m.trainedAt).toISOString().slice(0, 10) : '', files: { 'data/rank-model.json': enc(m), 'README.txt': enc('CoLU 候選排序模型（邏輯迴歸），唯讀。') }, counts: { weights: (m.w || []).length, trained: 1 }, source_files: [P + 'catalog/rank_train.js', '執行期儲存：fileCache／unit-catalog-rank-model.json'], eval: rp, summary: '已訓練：' + (m.w || []).length + ' 個權重' + (rp && rp.best ? '；交叉驗證 precision ' + rp.best.precision + '、recall ' + rp.best.recall : '（沒有附評量報告）') };
        }
        async function coluProfiles() {
            if (!deps.presetProfiles) return ua('colu', NAMES.colu_profiles, '這個環境沒有接上內建模型體檢（FA_PRESET_MODEL_STATE）');
            const ps = deps.presetProfiles() || []; const by = {}; ps.forEach((p) => { by[p.advice || '未知'] = (by[p.advice || '未知'] || 0) + 1; });
            return { kind: 'colu', name: NAMES.colu_profiles, version: '', files: { 'data/profiles.jsonl': enc(ps.map((x) => JSON.stringify(x)).join('\n')), 'README.txt': enc('內建模型的 CoLU 體檢結果（唯讀）。') }, counts: Object.assign({ models: ps.length }, by), source_files: [P + 'floating-assistant.js（FA_PRESET_MODEL_STATE）', P + 'catalog/colu_bench_core.js'], summary: ps.length + ' 個內建模型有體檢結果：' + (Object.keys(by).map((k) => k + ' ' + by[k]).join('、') || '—') };
        }
        async function coluRoute() {
            if (!deps.routeEval) return ua('colu', NAMES.colu_route, '這個環境沒有接上接線路由評量（FaColuBench.makeTasks 需要單元目錄）');
            const r = await deps.routeEval(); if (!r) return ua('colu', NAMES.colu_route, '單元目錄建不起來，出不了接線評量題');
            return { kind: 'colu', name: NAMES.colu_route, version: 'seed ' + (r.seed == null ? 'default' : r.seed), files: { 'data/route-tasks.jsonl': enc((r.sample || []).map((x) => JSON.stringify(x)).join('\n')), 'README.txt': enc('接線路由評量集：由單元目錄＋型別接線矩陣以固定種子產生的選擇題（唯讀）。這裡只列前幾題樣本。') }, counts: { tasks: r.tasks || 0, units: r.units || 0 }, source_files: [P + 'catalog/colu_bench_core.js', P + 'catalog/matrix_core.js'], summary: '以目前單元目錄（' + (r.units || 0) + ' 個單元）產生 ' + (r.tasks || 0) + ' 題接線題' + (r.reason ? '（' + r.reason + '）' : '') };
        }
        async function matrixAsset() {
            const M = deps.matrixSynth; if (!M || !M.list) return ua('matrix', NAMES.matrix, '這個環境沒有載入矩陣層合成器（FaMatrixSynth）');
            const l = M.list(); const lv = {}; l.forEach((x) => { String(x.level || '?').split('/').forEach((k) => { lv[k] = (lv[k] || 0) + 1; }); });
            return { kind: 'matrix', name: NAMES.matrix, version: '', files: { 'data/synthesizers.json': enc(l), 'README.txt': enc('矩陣層註冊表（唯讀）：每個合成器是一個程式模組，不是可訓練的權重。補一種範本＝註冊一個模組。') }, counts: Object.assign({ synthesizers: l.length }, Object.keys(lv).sort().reduce((o, k) => { o[k] = lv[k]; return o; }, {})), source_files: [P + 'algo/matrix_synth_core.js（L0–L2／範本）', P + 'algo/matrix_l0_core.js', P + 'algo/matrix_graph_core.js', P + 'algo/matrix_compose_core.js', P + 'algo/matrix_edit_core.js', P + 'catalog/matrix_core.js（型別接線矩陣）'], summary: l.length + ' 個已註冊的合成器，涵蓋層級 ' + (Object.keys(lv).sort().join('、') || '—') + '：' + l.map((x) => x.name + '(' + (x.level || '?') + ')').join('、') };
        }
        async function trainerAsset() {
            if (!deps.trainerDomains) return ua('trainer', NAMES.trainer, '這個環境沒有接上離線訓練器儲存（IndexedDB 的 domains）');
            const ds = await deps.trainerDomains(); if (!ds) return ua('trainer', NAMES.trainer, '讀不到離線訓練器的領域表');
            let patterns = 0, tools = 0, refs = 0, states = 0; const brief = ds.map((d) => { const p = (d.patterns || []).length, t = (d.tools || []).length, st = d.states && d.states.states ? Object.keys(d.states.states).length : 0, r = (d.references || []).length; patterns += p; tools += t; states += st; refs += r; return { name: d.name, description: clip(d.description, 120), enabled: d.enabled !== false, patterns: p, tools: t, states: st, references: r }; });
            const rules = []; ds.forEach((d) => (d.patterns || []).forEach((p) => rules.push({ domain: d.name, id: p.id, type: p.type, intent: clip(p.intent, 100), tool: p.tool, confidence: p.confidence, risk: p.risk })));
            return { kind: 'trainer', name: NAMES.trainer, version: '', files: { 'data/domains.json': enc(brief), 'data/patterns.jsonl': enc(rules.map((x) => JSON.stringify(x)).join('\n')), 'README.txt': enc('離線訓練器內建（source:builtin）的領域與規則，唯讀檢視。使用者自己的領域請用「把目前的離線訓練器存成資產」。') }, counts: { domains: ds.length, patterns, tools, states, references: refs }, source_files: [P + 'floating-assistant.js（_otSeedBuiltin 播種；執行期存 IndexedDB 的 domains 表）'], summary: ds.length + ' 個內建領域、' + patterns + ' 條規則、' + tools + ' 個工具、' + states + ' 個狀態' };
        }
        async function umlAsset() {
            const U = deps.umlCore, D = deps.designCore; if (!U && !D) return ua('uml', NAMES.uml, '這個環境沒有載入 UML 核心（uml_core.js／design_core.js）');
            const size = (v) => (Array.isArray(v) ? v.length : (v && typeof v === 'object' ? Object.keys(v).length : 0)); const c = {}, srcs = [];
            if (U) { ['ACTORS', 'NOUNS', 'VERBS', 'KINDS', 'LANGS', 'FILTERS', 'PRIMS', 'PREFILL'].forEach((k) => { if (U[k] !== undefined) c['uml_' + k.toLowerCase()] = size(U[k]); }); srcs.push(P + 'uml/uml_core.js'); }
            if (D) { ['ARCH', 'CONCERNS', 'PKG', 'FRAGMENTS', 'GUIDE_LANGS'].forEach((k) => { if (D[k] !== undefined) c['design_' + k.toLowerCase()] = size(D[k]); }); srcs.push(P + 'uml/design_core.js'); }
            if (deps.umlBench) { c.fixtures = size(deps.umlBench.FIXTURES); c.big_fixtures = size(deps.umlBench.BIG); srcs.push(P + 'uml/uml_bench_core.js（評量題）'); }
            const dump = {}; if (U) ['ACTORS', 'NOUNS', 'VERBS', 'KINDS', 'LANGS', 'PRIMS'].forEach((k) => { if (U[k] !== undefined) dump['uml_' + k] = Array.isArray(U[k]) ? U[k].map((x) => (Array.isArray(x) ? x[0] : (x && x.key) || String(x))) : Object.keys(U[k] || {}); });
            if (D) ['ARCH', 'CONCERNS', 'PKG', 'FRAGMENTS'].forEach((k) => { if (D[k] !== undefined) dump['design_' + k] = Array.isArray(D[k]) ? D[k].map((x) => (x && (x.id || x.key || x.name)) || String(x)) : Object.keys(D[k] || {}); });
            return { kind: 'uml', name: NAMES.uml, version: '', files: { 'data/tables.json': enc(dump), 'README.txt': enc('UML 的詞彙表、模板與決策表。這些寫在程式裡，不是使用者可訓練的資料：唯讀內建，改它要改原始碼。') }, counts: c, source_files: srcs, summary: '詞彙與設計表（唯讀內建、寫在程式裡，不是可訓練資料）：' + Object.keys(c).map((k) => k + ' ' + c[k]).join('、') };
        }
        async function loraAsset() {
            const r = deps.loraInfo ? await deps.loraInfo() : null;
            if (!r) return { kind: 'lora', name: NAMES.lora, version: '', files: { 'README.txt': enc('LoRA 訓練資料集（lora-train/data：coverage_when2call.json、real_tools_all.json、ref_facts.json）在原始碼倉庫裡；打包後的程式不含 lora-train 目錄（package.json 的 files 只收 renderer/**），所以從這裡讀不到。要用請在桌面版用「資料匯入」重新產生，或直接在倉庫裡看。') }, counts: { adapters: 0, datasets: 0 }, source_files: ['lora-train/data/*.json（倉庫內，未隨程式打包）', 'lora-train/gen/*.js（資料集產生器）'], summary: '沒有內建的 adapter；lora-train 的資料集不在打包內，這個環境讀不到（' + (deps.webReason || '具體原因見說明檔') + '）' };
            const ds = r.datasets || [], ad = r.adapters || [];
            return { kind: 'lora', name: NAMES.lora, version: '', files: { 'data/datasets.json': enc(ds), 'data/adapters.json': enc(ad), 'README.txt': enc(r.note || 'LoRA 現況（唯讀）') }, counts: { adapters: ad.length, datasets: ds.length, rows: ds.reduce((n, d) => n + (d.rows || 0), 0), generators: (r.generators || []).length }, source_files: ds.map((d) => d.file).filter(Boolean).concat((r.generators || []).length ? ['lora-train/gen/*.js（' + r.generators.length + ' 個產生器）'] : []), summary: ad.length + ' 個內建 adapter（要訓練出來並匯入才有）；lora-train/data 現有 ' + ds.length + ' 份資料表共 ' + ds.reduce((n, d) => n + (d.rows || 0), 0) + ' 筆（' + ds.map((d) => d.name + ' ' + d.rows).join('、') + '）、' + (r.generators || []).length + ' 個資料產生器。資料表是倉庫檔，筆數為建置時算好' };
        }
        const BUILDERS = [blocklyDomains, blocklyLessons, coluFeedback, coluRank, coluProfiles, coluRoute, matrixAsset, trainerAsset, umlAsset, loraAsset];
        let cache = null;
        async function buildAll(fresh) {
            if (cache && !fresh) return cache;
            const out = []; for (const b of BUILDERS) { try { out.push(await b()); } catch (e) { out.push(ua('?', b.name, '讀取失敗：' + String((e && e.message) || e))); } }
            cache = out.filter((x) => x.kind !== '?' || x.unavailable); return cache;
        }
        const itemOf = (x) => ({ kind: x.kind, name: x.name, owner: 'builtin', origin: 'builtin', readonly: true, created: created(), counts: x.counts, version: x.version, summary: x.summary, source_files: x.source_files, unavailable: x.unavailable || '', eval: x.eval || null, files: Object.keys(x.files || {}).length });
        async function list(fresh) { return (await buildAll(fresh)).map(itemOf); }
        async function find(kind, name) { return (await buildAll()).find((x) => x.kind === kind && x.name === name) || null; }
        async function read(kind, name) {
            const x = await find(kind, name); if (!x) return null;
            const files = Object.assign({}, x.files); const readme = '內建資產（唯讀）\n來源檔案：\n' + (x.source_files || []).map((s) => ' - ' + s).join('\n') + '\n' + (x.summary || '') + '\n';
            if (!files['SOURCES.txt']) files['SOURCES.txt'] = enc(readme);
            const manifest = Asset.createManifest({ kind: x.kind, name: x.name, files, counts: x.counts, owner: 'builtin', created: created(), eval: x.eval || null, extra: { builtin: { version: x.version, summary: x.summary, source_files: x.source_files, unavailable: x.unavailable || '' } } });
            return { asset: { manifest, files }, verify: { ok: true }, builtin: true };
        }
        async function summary() { const a = await list(); const by = {}; a.forEach((x) => { by[x.kind] = (by[x.kind] || 0) + 1; }); return by; }
        return { list, read, has: async (k, n) => !!(await find(k, n)), summary, NAMES };
    }
    return { createProvider, NAMES };
});
