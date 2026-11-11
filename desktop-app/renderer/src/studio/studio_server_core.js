/* Studio 檢視器的「假伺服器」路由核心（UMD，依賴注入，不碰 DOM／window）。檢視器（沙盒 iframe）用 fetch('http://mock.local/api/…') 呼叫，
 * 主程式的 floating-assistant.js 負責把 iframe 的 postMessage 轉進來（同 AIDoc 的做法）。設計見 DESIGN.TODO.offline-training-studio.md §4、§4.1。
 * createServer(h)，h 是主程式提供的接口：
 *   h.storage        createStorage() 的實例（資產儲存層）
 *   h.desktop        true＝桌面版（可以叫主行程做訓練／基準）
 *   h.call(op,payload,timeoutMs)  → 主行程 studio_* 操作（網頁版沒有，回 {ok:false,…}）
 *   h.download(name, u8, mime)   讓使用者存檔；h.pickFile() → {name, bytes}|null（需要使用者手勢，呼叫端負責）
 *   h.otExport()／h.otImport(bundle, opts)   離線訓練器 bundle（_otBundleExport／_otBundleImport）
 *   h.prefsGet()／h.prefsSet(o)  版面等偏好（主程式 localStorage）
 *   h.workDir()      → 桌面版訓練輸出根目錄（絕對路徑）或 null
 *   h.builtin        FaStudioBuiltin.createProvider(...) 的實例（唯讀內建資產；選填，沒有就只列儲存層）
 *   h.sym            符號式評量與訓練需要的模組與接口（見 sym_suites_core.js 檔頭；選填，沒給就在畫面寫「這個環境沒有接上」）
 *   h.localReadDir／localStat／localReadFile  桌面版以路徑讀本機（rawfs）；fapList／fapRead  檔案存取資料夾參照；fetchUrl  使用者確認後才連網取文字（皆選填，缺了該類輸入回具體原因）
 *   h.teacherAI      async ({system, prompt, tools, maxRounds}) → {text, calls}  線上 AI 子任務（只有白名單工具）；沒給＝老師迴圈寫明沒有線上 AI
 *   h.now()
 * 回傳 { route(method, url(URL物件), body) → {s, j}, push(obj)（由呼叫端接上）, log[] } */
(function (root, factory) {
    const A = (typeof module === 'object' && module.exports) ? require('./asset_core.js') : root.FaStudioAsset;
    const F = (typeof module === 'object' && module.exports) ? require('./fatrain_core.js') : root.FaFatrain;
    const T = (typeof module === 'object' && module.exports) ? require('./trainer_adapter.js') : root.FaStudioTrainerAdapter;
    const Lay = (typeof module === 'object' && module.exports) ? require('./studio_layout_core.js') : root.FaStudioLayout;
    const Ing = (typeof module === 'object' && module.exports) ? require('./ingest_core.js') : root.FaStudioIngest;
    const Cln = (typeof module === 'object' && module.exports) ? require('./clean_core.js') : root.FaStudioClean;
    const Reg = (typeof module === 'object' && module.exports) ? require('./lora_registry_core.js') : root.FaLoraRegistry;
    const Ev = (typeof module === 'object' && module.exports) ? require('./eval_core.js') : root.FaStudioEval;
    const Sy = (typeof module === 'object' && module.exports) ? require('./sym_suites_core.js') : root.FaStudioSym;
    const ST = (typeof module === 'object' && module.exports) ? require('./sym_train_core.js') : root.FaStudioSymTrain;
    const Si = (typeof module === 'object' && module.exports) ? require('./source_input_core.js') : root.FaStudioSourceInput;
    const Te = (typeof module === 'object' && module.exports) ? require('./teacher_core.js') : root.FaStudioTeacher;
    if (typeof module === 'object' && module.exports) module.exports = factory(A, F, T, Lay, Ing, Cln, Reg, Ev, Sy, ST, Te, Si);
    else root.FaStudioServer = factory(A, F, T, Lay, Ing, Cln, Reg, Ev, Sy, ST, Te, Si);
})(typeof self !== 'undefined' ? self : this, function (Asset, Fatrain, Trainer, Layout, Ingest, Clean, LoraReg, EvalCore, Sym, SymTrain, Teacher, SourceInput) {
    'use strict';
    const KIND_LABEL = { colu: 'CoLU', blockly: '積木課程', matrix: '矩陣層', uml: 'UML 設計', trainer: '離線訓練器', lora: 'LoRA' };
    const dec = (u) => new TextDecoder('utf-8').decode(u);
    const WEB_BACKENDS = [
        { id: 'cpu-py', available: false, reason: '網頁版沒有 Python 子行程；請「匯出訓練包」（.fatrain）後到桌面版訓練' },
        { id: 'webgpu', available: false, reason: 'WebGPU 的 LoRA 反向傳播引擎尚未實作（研究中：onnxruntime-web 只有推論，需自寫 WGSL 前向／反向，單層梯度對拍通過前不點亮）', planned: true },
        { id: 'directml', available: false, reason: 'DirectML 只在桌面版原生路徑有意義，且尚未實作', planned: true },
        { id: 'vulkan', available: false, reason: 'Vulkan 後端尚未實作', planned: true },
    ];
    // 主程式目前的基底模型與 LoRA 槽版 ONNX 的條件（make_lora_onnx.py build 的單槽 rank 16；提示格式版本 1）；工具目錄雜湊目前主程式沒有對應來源，所以不比對（adapter 缺記錄會出警告）
    const LORA_ENV = { base: 'Qwen/Qwen3-0.6B', rank_slots: [16], prompt_format_version: 1 };
    const LORA_APPLY_BLOCKER = '目前環境沒有原生推論套用器：桌面版需要原生執行包 1.22.0-2 以上（nr-host／nr-child 轉傳 lora，見設計文件 §14）；網頁版的 transformers.js 接點尚未接（阻礙見 §14）。所以這裡只做到「選用與載入到記憶體」，不假裝已套用';
    const SOURCES = ['wiki', 'open_source', 'book', 'aidoc'];
    const NOT_DESKTOP = '這個功能要在桌面版執行（需要主行程子行程）；網頁版請用「匯出訓練包」到桌面版訓練';

    function createServer(h) {
        const SYMBOLIC = ['trainer', 'colu', 'uml', 'blockly', 'matrix'];
        const S = { evals: {}, teachers: new Map(), log: [], pending: null, seq: 0, lastTrain: null, lastBench: null, ingest: null, registry: null, regSha: {} };
        const chunkBrief = (c) => ({ id: c.id, tokens: c.tokens_est, split: c.split, code: !!c.code, heading: c.meta.heading || c.meta.title || '', path: c.meta.path || '', license: c.meta.license, builtin_allowed: !!(c.meta.license_policy && c.meta.license_policy.builtin_allowed), user_supplied: !!c.meta.user_supplied, redactions: c.meta.redactions, head: c.text.slice(0, 200) });
        const ingestView = () => {
            const I = S.ingest; if (!I) return { has: false };
            const lic = {}; I.chunks.forEach((c) => { lic[c.meta.license] = (lic[c.meta.license] || 0) + 1; });
            const q = { pending: 0, claimed: 0, done: 0 }; I.requests.forEach((r) => { q[r.status] = (q[r.status] || 0) + 1; });
            return { has: true, inputs: I.inputs || null, source: I.source, stats: I.stats, sizing: I.sizing, licenses: lic, skipped: (I.skipped || []).slice(0, 30), skippedTotal: (I.skipped || []).length, rejectedTotal: I.rejected.length, rejected: I.rejected.slice(0, 30), preview: I.chunks.slice(0, 8).map(chunkBrief), requests: q, samples: I.samples.length, savedAs: I.savedAs || null };
        };
        // 由 kind:'lora' 且帶權重的資產建立登錄項；只含資料的資產（資料匯入的結果）不是 adapter
        async function syncRegistry() {
            if (!S.registry) S.registry = LoraReg.createRegistry({ env: LORA_ENV, maxActive: h.loraApply ? (h.loraMaxActive >= 1 ? h.loraMaxActive : 4) : 1, loader: LoraReg.nrEngineLoader({ readBytes: async (e) => { const r = await h.storage.loadAsset('lora', e.asset_name); if (!r || !r.asset.files[e.weight_file]) throw new Error('讀不到權重檔 ' + e.weight_file); return r.asset.files[e.weight_file]; }, sha256Hex: Asset.sha256Hex }) });
            const reg = S.registry, prefs = (h.prefsGet && h.prefsGet()) || {}, en = prefs.loraEnabled || {}, imp = new Set(Array.isArray(prefs.imported) ? prefs.imported : []);
            const seen = new Set(), invalid = [], items = await h.storage.listAssets();
            for (const it of items) {
                if (it.kind !== 'lora') continue; const m = await h.storage.loadManifest('lora', it.name); if (!m) continue;
                const wf = Object.keys(m.sha256 || {}).find((p) => /^weights\/.*(lora\.bin|\.safetensors|\.bin)$/.test(p)); if (!wf) continue;
                const ex = (m.extra && m.extra.lora) || {}, id = it.name;
                const e = LoraReg.entryFromManifest(Object.assign({}, m, { sha256: undefined, total_size: undefined, size: undefined }), { id, name: it.name, source: m.owner === 'builtin' ? 'builtin' : (imp.has('lora/' + it.name) ? 'imported' : 'user'), domains: ex.domains || m.domains || [], location: 'asset:lora/' + it.name, size: ex.size || (m.counts && m.counts.weight_bytes) || 0, sha256: m.sha256[wf], enabled: en[id] !== false, asset_name: it.name, weight_file: wf, triggers: ex.triggers, priority: ex.priority });
                seen.add(id);
                const cur = reg.get(id);
                if (cur && S.regSha[id] === e.sha256) continue;
                try { if (cur) await reg.unregister(id); reg.register(e); S.regSha[id] = e.sha256; } catch (err) { invalid.push({ id, error: String((err && err.message) || err) }); seen.delete(id); }
            }
            for (const e of reg.list()) if (!seen.has(e.id)) await reg.unregister(e.id);
            const loaded = new Set(reg.loaded().map((x) => x.id));
            const entries = reg.list().map((e) => ({ id: e.id, name: e.name, source: e.source, base: e.base, rank: e.rank, size: e.size, domains: e.domains, enabled: e.enabled, compat: reg.checkCompat(e), verdict: LoraReg.evalVerdict(e.eval), loaded: loaded.has(e.id), prompt_format_version: e.prompt_format_version }));
            return { reg, entries, invalid };
        }
        const now = () => (h.now ? h.now() : Date.now());
        const prefsObj = () => (h.prefsGet && h.prefsGet()) || {};
        const jsonl = (u8) => dec(u8).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
        // 從資產取題目／情境對（data/tasks.jsonl、data/pairs.jsonl）；沒有就回 null 與原因
        async function tasksFrom(ref, file) {
            const m = /^([a-z]+)\/(.+)$/.exec(String(ref || '')); if (!m) return { tasks: null, why: '資產參照格式是 kind/name' };
            const r = await readAsset(m[1], m[2]); if (!r) return { tasks: null, why: '找不到資產 ' + ref }; const f = r.asset.files[file]; if (!f) return { tasks: null, why: ref + ' 沒有 ' + file };
            return { tasks: jsonl(f) };
        }
        async function evalKind(kind, fromAsset) {
            const p = prefsObj(); let suites = Sym.evalSuites(kind, h.sym);
            if (fromAsset) { const t = await tasksFrom(fromAsset, 'data/tasks.jsonl'); if (!t.tasks) throw new Error('無法取題目：' + t.why); suites = suites.concat(Sym.taskSuites(kind, t.tasks, h.sym)); }
            return EvalCore.runEval(kind, suites, { baseline: (p.evalBaseline || {})[kind] || {}, gate: p.evalGate, now });
        }
        let teacherObj = null;
        const getTeacher = () => teacherObj || (teacherObj = Teacher.createTeacher({
            now, Eval: EvalCore, hash: Clean.hash64,
            kinds: Sym.teacherKinds(Object.assign({}, h.sym || {}, { cleanValidateRow: Clean.validateRow, verifyTeacherSample: Clean.verifyTeacherSample, ingestChunk: (id) => (S.ingest ? S.ingest.chunks.find((c) => c.id === id) : null) })),
            evaluate: (kind) => evalKind(kind), trial: h.sym && h.sym.trial ? h.sym.trial : null, ai: h.teacherAI || null,
            whyNot: (k) => (k === 'colu' ? 'colu 的資料是使用者「採用／退回」推薦的標註，那是使用者的決定，老師不能代做；解除條件：使用者自己累積，或匯入別人的回饋資產' : (k === 'trainer' ? 'trainer 的資料是離線訓練器實際成功的案例，只能由實際執行產生；要讓 AI 教它請用 /offline-trainer-by-ai（有自己的老師迴圈與回滾）' : '')),
            loadExisting: async (kind, ref) => {
                const train = [], heldout = []; const push = (r) => { const sp = r && r.split; (sp === 'heldout' || sp === 'holdout' ? heldout : train).push(r); };
                if (ref) { const m = /^([a-z]+)\/(.+)$/.exec(ref); const a = m && await readAsset(m[1], m[2]); if (a) Object.keys(a.asset.files).filter((p) => /^data\/.*\.jsonl$/.test(p)).forEach((p) => jsonl(a.asset.files[p]).forEach(push)); }
                if (kind === 'lora' && S.ingest) S.ingest.samples.forEach(push);
                return { train, heldout };
            }
        }));
        let runner = null;
        const getRunner = () => runner || (runner = SymTrain.createRunner({ storage: h.storage, Asset, Trainer, now, onChange: () => { if (S.push) { try { S.push({ type: 'sym_progress' }); } catch (_) { /* */ } } } }));
        const log = (text, extra) => { const r = Object.assign({ at: now(), text }, extra || {}); S.log.push(r); if (S.log.length > 500) S.log.shift(); if (S.push) { try { S.push({ type: 'log', rec: r }); } catch (_) { /* */ } } return r; };
        const ok = (j) => ({ j: Object.assign({ ok: true }, j) });
        const bad = (s, error, extra) => ({ s, j: Object.assign({ ok: false, error }, extra || {}) });
        const imported = () => { const p = (h.prefsGet && h.prefsGet()) || {}; return Array.isArray(p.imported) ? p.imported : []; };
        const markImported = (kind, name) => { const p = Object.assign({}, h.prefsGet ? h.prefsGet() : {}); const a = imported().filter((x) => x !== kind + '/' + name); a.push(kind + '/' + name); p.imported = a.slice(-500); h.prefsSet(p); };
        const fapNote = async () => { const st = await h.storage.fapState(); return st.ok ? { ok: true } : { ok: false, message: st.message, reason: st.reason }; };
        const callHost = async (op, payload, t) => { if (!h.desktop || !h.call) return { ok: false, error: NOT_DESKTOP, notDesktop: true }; const r = await h.call(op, payload || {}, t || 20000); if (r && r.ok === false && !r.error) r.error = r.message || r.code || '主行程沒有回應'; return r; };
        // 儲存層優先；沒有同名的才看唯讀內建資產（h.builtin，見 builtin_assets_core.js）
        const readAsset = async (kind, name) => { const r = await h.storage.loadAsset(kind, name); if (r) return r; return h.builtin ? h.builtin.read(kind, name) : null; };
        const builtinItems = async (stored) => { if (!h.builtin) return []; const have = new Set(stored.map((x) => x.kind + '/' + x.name)); return (await h.builtin.list()).filter((x) => !have.has(x.kind + '/' + x.name)); };

        async function listAssets() {
            const items = await h.storage.listAssets(), imp = new Set(imported()), groups = {};
            Asset.KINDS.forEach((k) => { groups[k] = { kind: k, label: KIND_LABEL[k] || k, items: [] }; });
            for (const it of items) { if (!groups[it.kind]) continue; const origin = it.owner === 'builtin' ? 'builtin' : (imp.has(it.kind + '/' + it.name) ? 'imported' : 'mine'); groups[it.kind].items.push(Object.assign({}, it, { origin })); }
            for (const it of await builtinItems(items)) if (groups[it.kind]) groups[it.kind].items.unshift(it);
            return Asset.KINDS.map((k) => { const g = groups[k]; g.counts = { builtin: 0, mine: 0, imported: 0 }; g.items.forEach((x) => { g.counts[x.origin] = (g.counts[x.origin] || 0) + 1; }); return g; });
        }

        async function route(method, u, body) {
            const P = u.pathname, Q = (k) => u.searchParams.get(k) || '';
            body = body || {};
            try {
                if (method === 'GET' && P === '/api/info') {
                    const fs = await fapNote();
                    return ok({ desktop: !!h.desktop, storage: fs, kinds: Asset.KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k] })), tabs: Layout.TABS, workDir: h.workDir ? await h.workDir() : null, webgpu: !!(h.webgpu && h.webgpu()) });
                }
                if (method === 'GET' && P === '/api/prefs') return ok({ layout: Layout.normalize(((h.prefsGet && h.prefsGet()) || {}).layout) });
                if (method === 'POST' && P === '/api/prefs') {
                    const p = Object.assign({}, h.prefsGet ? h.prefsGet() : {});
                    p.layout = body.reset ? Layout.defaults() : Layout.normalize(body.layout);
                    h.prefsSet(p); return ok({ layout: p.layout });
                }
                // ---- 資產 ----
                if (method === 'GET' && P === '/api/assets') return ok({ groups: await listAssets(), storage: await fapNote() });
                if (method === 'GET' && P === '/api/asset') {
                    const r = await readAsset(Q('kind'), Q('name')); if (!r) return bad(404, '沒有這個資產');
                    return ok({ readonly: !!r.builtin, manifest: r.asset.manifest, verify: { ok: r.verify.ok, message: r.verify.message || '' }, files: Object.keys(r.asset.files).map((p) => ({ path: p, bytes: r.asset.files[p].length })) });
                }
                if (method === 'GET' && P === '/api/asset-file') {
                    const r = await readAsset(Q('kind'), Q('name')); if (!r) return bad(404, '沒有這個資產'); const f = r.asset.files[Q('path')]; if (!f) return bad(404, '資產裡沒有這個檔案');
                    const head = f.subarray(0, 6000); let text; try { text = dec(head); } catch (_) { text = ''; }
                    return ok({ path: Q('path'), bytes: f.length, truncated: f.length > head.length, text });
                }
                if (method === 'POST' && P === '/api/asset/delete') {
                    if (!body.confirmed) return bad(400, '刪除資產要先確認（confirmed:true）', { needsConfirm: true });
                    if (h.builtin && !(await h.storage.loadManifest(String(body.kind || ''), String(body.name || ''))) && await h.builtin.has(String(body.kind || ''), String(body.name || ''))) return bad(409, '這是內建資產（唯讀，內容來自程式本身），不能刪除');
                    const r = await h.storage.deleteAsset(String(body.kind || ''), String(body.name || '')); log('刪除資產 ' + body.kind + '/' + body.name + '（' + r.removed + ' 個檔案）'); return ok(r);
                }
                if (method === 'POST' && P === '/api/export') {
                    const r = await readAsset(String(body.kind || ''), String(body.name || '')); if (!r) return bad(404, '沒有這個資產');
                    if (!r.verify.ok) return bad(409, '資產自己的雜湊核對不過，不匯出：' + (r.verify.message || ''), { verify: r.verify });
                    const e = Fatrain.exportAsset(r.asset, {}); if (!e.ok) return bad(500, e.error);
                    await h.download(e.name, e.bytes, 'application/zip'); log('匯出 ' + e.name + '（' + e.size + ' 位元組' + (e.sharded.length ? '，大檔已分片' : '') + '）');
                    return ok({ filename: e.name, bytes: e.size, sharded: e.sharded });
                }
                if (method === 'POST' && P === '/api/import/pick') {
                    const f = await h.pickFile(); if (!f) return ok({ cancelled: true });
                    const r = await Fatrain.importAsset(f.bytes, { storage: h.storage, confirmed: false });
                    if (!r.ok) { log('匯入被拒：' + (r.error || '') + '（' + f.name + '）'); return bad(409, r.error || '匯入失敗', r); }
                    S.pending = { id: 'imp' + (++S.seq), bytes: f.bytes, name: f.name }; return ok(Object.assign({ pendingId: S.pending.id, file: f.name }, r));
                }
                if (method === 'POST' && P === '/api/import/confirm') {
                    const pd = S.pending; if (!pd || pd.id !== body.pendingId) return bad(409, '沒有待確認的匯入（可能已取消，請重新選檔）');
                    const r = await Fatrain.importAsset(pd.bytes, { storage: h.storage, confirmed: true, mode: body.mode || 'auto', forkName: body.forkName });
                    if (!r.ok) return bad(409, r.error || '匯入失敗', r);
                    S.pending = null; markImported(r.plan.kind, r.plan.target); log('匯入 ' + r.plan.kind + '/' + r.plan.target + '（' + r.plan.action + '）' + (r.dataMayBeLost ? '，注意：只存在記憶體' : ''));
                    if (S.push) S.push({ type: 'asset_changed' }); return ok(r);
                }
                if (method === 'POST' && P === '/api/import/cancel') { S.pending = null; return ok({}); }
                // ---- 離線訓練器 bundle 往返 ----
                if (method === 'POST' && P === '/api/trainer/snapshot') {
                    if (!h.otExport) return bad(501, '這個版本沒有離線訓練器匯出');
                    const bundle = await h.otExport(); if (!bundle || bundle.ok === false) return bad(500, '離線訓練器匯出失敗：' + ((bundle && (bundle.error || bundle.message)) || ''));
                    const name = String(body.name || 'trainer-' + new Date(now()).toISOString().slice(0, 10));
                    if (!Asset.safeName(name)) return bad(400, '名稱不合法：' + name);
                    const c = Trainer.bundleToAsset(bundle, { name }); if (!c.ok) return bad(500, c.error);
                    if (!body.overwrite && await h.storage.loadManifest('trainer', name)) return bad(409, '「' + name + '」已存在（要覆蓋請帶 overwrite:true）');
                    const w = await h.storage.saveAsset(c.asset, { replace: true }); if (!w.ok) return bad(500, w.error);
                    log('把目前的離線訓練器存成資產 trainer/' + name); if (S.push) S.push({ type: 'asset_changed' }); return ok({ name, write: w, warnings: c.warnings });
                }
                if (method === 'POST' && P === '/api/trainer/apply') {
                    if (!h.otImport) return bad(501, '這個版本沒有離線訓練器匯入');
                    const r = await readAsset('trainer', String(body.name || '')); if (!r) return bad(404, '沒有這個 trainer 資產');
                    const b = Trainer.assetToBundle(r.asset); if (!b.ok) return bad(409, b.error);
                    const res = await h.otImport(b.bundle, { mode: body.mode || 'merge', dry_run: !body.confirmed, confirmed: !!body.confirmed, overwrite: !!body.overwrite });
                    if (body.confirmed) log('把 trainer/' + body.name + ' 套用到離線訓練器');
                    return ok({ applied: !!body.confirmed, result: res });
                }
                // ---- 資料集（先唯讀）／評量 ----
                if (method === 'GET' && P === '/api/datasets') {
                    const out = []; const st0 = await h.storage.listAssets(); for (const it of st0.concat(await builtinItems(st0))) { const r = await readAsset(it.kind, it.name); if (!r) continue; Object.keys(r.asset.files).filter((p) => /^data\//.test(p)).forEach((p) => out.push({ kind: it.kind, name: it.name, path: p, bytes: r.asset.files[p].length, readonly: !!r.builtin })); }
                    return ok({ files: out, note: out.length ? '' : '還沒有任何資產帶資料檔（data/）。把離線訓練器存成資產後這裡會出現 solutions／synonyms 等資料。' });
                }
                if (method === 'GET' && P === '/api/eval') {
                    const out = []; const st1 = await h.storage.listAssets(); for (const it of st1) { const m = await h.storage.loadManifest(it.kind, it.name); if (m && m.eval) out.push({ kind: it.kind, name: it.name, eval: m.eval }); } for (const it of await builtinItems(st1)) if (it.eval) out.push({ kind: it.kind, name: it.name, eval: it.eval, builtin: true });
                    const p = prefsObj(); return ok({ implemented: true, kinds: Asset.KINDS.map((k) => ({ kind: k, label: KIND_LABEL[k], available: SYMBOLIC.indexOf(k) >= 0 ? !!h.sym : k === 'lora' })), items: out, last: S.evals, gate: Object.assign({}, EvalCore.DEFAULT_GATE, p.evalGate || {}), baseline: p.evalBaseline || {} });
                }
                if (method === 'POST' && P === '/api/eval/run') {
                    const kind = String(body.kind || ''); if (Asset.KINDS.indexOf(kind) < 0) return bad(400, '不認得的種類：' + kind);
                    if (!h.sym) return bad(501, '這個環境沒有接上評量需要的模組（h.sym）；更新到含 sym 接口的版本');
                    let res; try { res = await evalKind(kind, body.fromAsset); } catch (e) { return bad(409, String((e && e.message) || e)); }
                    S.evals[kind] = res; log('評量 ' + kind + '：' + res.summary.ran + '/' + res.summary.groups + ' 組有跑，退步 ' + res.summary.regressed + '、未過門檻 ' + res.summary.belowGate);
                    if (body.saveBaseline && res.summary.ran) { const np = Object.assign({}, prefsObj()); np.evalBaseline = Object.assign({}, np.evalBaseline); np.evalBaseline[kind] = EvalCore.saveBaseline(res, np.evalBaseline[kind]); h.prefsSet(np); res.baselineSaved = true; }
                    return ok(res);
                }
                if (method === 'POST' && P === '/api/eval/gate') { const np = Object.assign({}, prefsObj()); const d = Number(body.default); np.evalGate = { default: d >= 0 && d <= 1 ? d : EvalCore.DEFAULT_GATE.default, groups: Object.assign({}, body.groups || {}) }; h.prefsSet(np); return ok({ gate: np.evalGate }); }
                if (method === 'GET' && P === '/api/teacher') { const v = ingestView(); return ok({ implemented: true, canRun: !!h.teacherAI, whyNot: h.teacherAI ? '' : '這個環境沒有接上線上 AI 子任務（h.teacherAI）；桌面版與網頁版都在設定→AI 有線上模型時才能跑老師', tools: Teacher.TOOLS, limits: Teacher.LIMITS, kinds: ['blockly', 'matrix', 'uml', 'lora'], sessions: getTeacher().list(), queue: v.has ? v.requests : null, samples: v.has ? v.samples : 0 }); }
                if (method === 'POST' && P === '/api/teacher/plan') { if (!h.sym) return bad(501, '這個環境沒有接上評量模組（h.sym），無法算缺口'); const r = await getTeacher().plan({ kind: body.kind, goal: body.goal, fromAsset: body.fromAsset, target: body.target, limits: body.limits }); if (!r.ok) return bad(409, r.error); log('老師工作階段 ' + r.session.id + '（' + r.session.kind + '）建立；弱項 ' + (getTeacher().sessions.get(r.session.id).gap.weak.length)); return ok(r); }
                if (method === 'POST' && P === '/api/teacher/run') { const r = await getTeacher().run(String(body.id || ''), { confirmed: !!body.confirmed, previewHash: body.previewHash, model: body.model }); if (r.needsConfirm) return bad(400, r.error, r); if (!r.ok) return bad(409, r.error); log('老師執行完成：' + r.session.state + '，新增 ' + r.session.counts.accepted + ' 筆（尚未寫入資產）'); return ok(r); }
                if (method === 'GET' && P === '/api/teacher/session') { const v = getTeacher().view(Q('id')); return v ? ok({ session: v }) : bad(404, '沒有這個老師工作階段'); }
                if (method === 'POST' && P === '/api/teacher/reject') { const r = getTeacher().reject(String(body.id || ''), String(body.itemId || ''), body.reason); return r.ok ? ok(r) : bad(409, r.error); }
                if (method === 'POST' && P === '/api/teacher/stop') { const r = getTeacher().stop(String(body.id || '')); return r.ok ? ok(r) : bad(404, r.error); }
                if (method === 'POST' && P === '/api/teacher/commit') {
                    const T = getTeacher(); const v = T.view(String(body.id || '')); if (!v) return bad(404, '沒有這個老師工作階段'); const rows = T.rowsToCommit(v.id); if (!rows.length) return bad(409, '沒有可寫入的資料（全部被拒絕、回滾或根本沒新增）');
                    const name = String(body.name || v.target || ''); if (!name || !Asset.safeName(name)) return bad(400, '請填合法的資產名稱（寫入 ' + v.kind + '/名稱 的 data/teacher.jsonl；不會開始訓練）');
                    const ex = await h.storage.loadAsset(v.kind, name); const files = ex ? Object.assign({}, ex.asset.files) : {}; const old = files['data/teacher.jsonl'] ? jsonl(files['data/teacher.jsonl']) : [];
                    const all = old.concat(rows); files['data/teacher.jsonl'] = new TextEncoder().encode(all.map((x) => JSON.stringify(x)).join('\n'));
                    const m = Asset.createManifest({ kind: v.kind, name, files, counts: Object.assign({}, ex ? ex.asset.manifest.counts : {}, { teacher_rows: all.length }), owner: 'user', created: ex ? ex.asset.manifest.created : new Date(now()).toISOString(), parent: ex ? ex.asset.manifest.parent : null, base: ex ? ex.asset.manifest.base : null, compat: ex ? ex.asset.manifest.compat : undefined, eval: ex ? ex.asset.manifest.eval : null, extra: ex ? ex.asset.manifest.extra : undefined });
                    const w = await h.storage.saveAsset({ manifest: m, files }, { replace: true }); if (!w.ok) return bad(500, w.error); log('老師資料寫入 ' + v.kind + '/' + name + '（' + rows.length + ' 筆；沒有開始訓練）'); if (S.push) S.push({ type: 'asset_changed' }); return ok({ written: rows.length, total: all.length, asset: v.kind + '/' + name, note: '已寫入資料集；訓練是另一個動作，請到「訓練」分頁開始。' });
                }
                if (method === 'GET' && P === '/api/log') return ok({ log: S.log.slice(-300) });
                // ---- 運算後端／基準／訓練 ----
                if (method === 'GET' && P === '/api/backends') {
                    const kind = Q('kind') || 'lora';
                    if (!h.desktop) return ok({ desktop: false, kind, symbolic: kind !== 'lora', backends: kind === 'lora' ? WEB_BACKENDS : [{ id: 'cpu-js', available: true, reason: '', note: '只需處理器' }], note: NOT_DESKTOP });
                    const r = await callHost('studio_probe', { kind }, 30000); if (r.ok === false) return bad(502, r.error);
                    const sel = kind === 'lora' ? await callHost('studio_select', { kind }, 30000) : null;
                    return ok(Object.assign({ desktop: true, selection: sel && { chosen: sel.chosen, order: sel.order, needsRebench: sel.needsRebench, reason: sel.reason, source: sel.source } }, r));
                }
                if (method === 'GET' && P === '/api/config') { const r = await callHost('studio_config_get'); return r.ok === false ? bad(502, r.error) : ok(r); }
                if (method === 'POST' && P === '/api/config') { const r = await callHost('studio_config_set', { patch: body.patch }); if (r.ok === false) return bad(502, r.error); log('Studio 設定更新：' + JSON.stringify(body.patch)); return ok(r); }
                if (method === 'POST' && P === '/api/bench/start') { const r = await callHost('studio_bench_start', { kind: body.kind || 'lora', base: body.base }); if (r.ok === false) return bad(r.notDesktop ? 400 : 409, r.error); S.lastBench = r.jobId; log('開始基準測試（' + r.jobId + '）'); return ok(r); }
                if (method === 'POST' && P === '/api/bench/stop') { const r = await callHost('studio_bench_stop', { jobId: body.jobId || S.lastBench }); log('要求停止基準測試'); return ok(r); }
                if (method === 'GET' && P === '/api/bench/status') { const r = await callHost('studio_bench_status', { jobId: Q('jobId') || S.lastBench }); return r.ok === false ? bad(404, r.error) : ok(r); }
                if (method === 'POST' && P === '/api/train/start' && SYMBOLIC.indexOf(String(body.kind || '')) >= 0) {
                    const kind = String(body.kind); const name = String(body.name || ''); if (!name || !Asset.safeName(name)) return bad(400, '請先填一個合法的名稱（不可含斜線或 ..）');
                    if (!h.sym) return bad(501, '這個環境沒有接上符號式訓練需要的模組（h.sym）');
                    const opts = Object.assign({}, body.cfg || {});
                    if (body.fromAsset) { const file = kind === 'uml' ? 'data/pairs.jsonl' : 'data/tasks.jsonl'; const t = await tasksFrom(body.fromAsset, file); if (!t.tasks) return bad(409, '無法取題目：' + t.why); if (kind === 'uml') opts.pairs = t.tasks; else opts.tasks = t.tasks; }
                    const prep = await Sym.prepareTrain(kind, h.sym, opts); if (!prep.ok) { log('符號式訓練沒有啟動（' + kind + '）：' + prep.error, { level: 'error' }); return bad(409, prep.error); }
                    const r = getRunner().start(kind, name, prep, opts); if (!r.ok) return bad(409, r.error);
                    S.lastSym = r.jobId; log('開始 ' + kind + ' 訓練 → ' + kind + '/' + name + '（' + r.total + ' 段）'); return ok(Object.assign({ sym: true }, r));
                }
                if (method === 'POST' && P === '/api/train/start') {
                    if (!h.desktop) return bad(400, NOT_DESKTOP);
                    const kind = String(body.kind || 'lora');
                    const wd = h.workDir ? await h.workDir() : null; const name = String(body.name || '');
                    if (!name || !Asset.safeName(name)) return bad(400, '請先填一個合法的名稱（不可含斜線或 ..）');
                    const cfg = Object.assign({ base: 'Qwen/Qwen3-0.6B', epochs: 1, batch: 1, accum: 4, seqLen: 256, saveSteps: 50 }, body.cfg || {});
                    if (!cfg.trainFile) return bad(400, '請填訓練資料檔路徑（.jsonl；第二輪的「資料匯入」會自動產生）');
                    if (!cfg.outputDir) { if (!wd) return bad(500, '找不到使用者資料夾，請手動指定輸出資料夾'); cfg.outputDir = wd + '/runs/' + name; }
                    const r = await callHost('studio_train_start', { kind, backend: body.backend && body.backend !== 'auto' ? body.backend : undefined, cfg, resume: !!body.resume }, 60000);
                    if (r.ok === false) { log('訓練沒有啟動：' + r.error, { level: 'error' }); return bad(409, r.error); }
                    S.lastTrain = r.jobId; log((body.resume ? '續訓 ' : '開始訓練 ') + kind + '/' + name + '（' + r.jobId + '）→ ' + cfg.outputDir); return ok(Object.assign({ outputDir: cfg.outputDir }, r));
                }
                if (method === 'GET' && P === '/api/train/sym-status') return ok(getRunner().status(Q('jobId') || S.lastSym));
                if (method === 'POST' && P === '/api/train/sym-pause') { const r = await getRunner().pause(body.jobId || S.lastSym); log('暫停符號式訓練'); return r.ok === false ? bad(409, r.error) : ok(r); }
                if (method === 'POST' && P === '/api/train/sym-resume') { const r = getRunner().resume(body.jobId || S.lastSym); return r.ok === false ? bad(409, r.error) : ok(r); }
                if (method === 'POST' && P === '/api/train/sym-stop') { const r = getRunner().stop(body.jobId || S.lastSym); log('停止符號式訓練'); return ok(r); }
                if (method === 'GET' && P === '/api/train/status') { const r = await callHost('studio_train_status', { jobId: Q('jobId') || S.lastTrain, tail: 30 }); return r.ok === false ? bad(502, r.error) : ok(r); }
                if (method === 'POST' && P === '/api/train/pause') { const r = await callHost('studio_train_pause', { jobId: body.jobId || S.lastTrain }, 180000); log('暫停訓練：' + (r.ok ? '已存檢查點 step=' + r.step : r.error || r.reason)); return r.ok === false && !r.checkpoint ? bad(409, r.error || r.reason || '暫停失敗', r) : ok(r); }
                if (method === 'POST' && P === '/api/train/stop') { const r = await callHost('studio_train_stop', { jobId: body.jobId || S.lastTrain }, 30000); log('停止訓練'); return r.ok === false ? bad(409, r.error) : ok(r); }
                // ---- LoRA 登錄與按需載入（第二輪，接 lora_registry_core）----
                if (method === 'GET' && P === '/api/lora') { const reg = await syncRegistry(); return ok({ env: LORA_ENV, budget: reg.reg.budget, maxActive: reg.reg.maxActive, entries: reg.entries, invalid: reg.invalid, loaded: reg.reg.loaded(), applyBlocker: h.loraApply ? '' : LORA_APPLY_BLOCKER }); }
                if (method === 'POST' && P === '/api/lora/enable') {
                    const reg = await syncRegistry(); if (!reg.reg.get(String(body.id || ''))) return bad(404, '沒有這個 adapter');
                    await reg.reg.setEnabled(body.id, !!body.on); const p = Object.assign({}, h.prefsGet ? h.prefsGet() : {}); p.loraEnabled = Object.assign({}, p.loraEnabled); p.loraEnabled[body.id] = !!body.on; h.prefsSet(p);
                    log((body.on ? '啟用' : '停用') + ' LoRA ' + body.id); return ok({});
                }
                if (method === 'POST' && P === '/api/lora/select') { const reg = await syncRegistry(); return ok(reg.reg.select({ text: body.text, domains: body.domains, ids: body.ids, manual: !!(body.ids && body.ids.length) })); }
                if (method === 'POST' && P === '/api/lora/load') {
                    const reg = await syncRegistry(); const r = await reg.reg.request({ text: body.text, domains: body.domains, ids: body.ids, manual: !!(body.ids && body.ids.length) });
                    let applied = false, applyNote = LORA_APPLY_BLOCKER, applyItems = null;
                    if (h.loraClear && !r.handles.length) { try { await h.loraClear(); applyNote = '沒有選到 adapter，原生推論已回到基底模型'; } catch (e) { applyNote = String((e && e.message) || e); } }
                    if (h.loraApply && r.handles.length) { try { const a = await h.loraApply(r.handles.map((x) => ({ id: x.id, bytes: x.handle && x.handle.bytes }))); applied = !!(a && a.ok); applyNote = (a && (a.error || a.note)) || ''; applyItems = (a && a.items) || null; } catch (e) { applyNote = String((e && e.message) || e); } }
                    log('LoRA 按需載入：' + (r.active.join('、') || '（沒有符合的）') + (applied ? '，已套用' : '，尚未套用到推論'));
                    return ok({ active: r.active, loaded: r.loaded, unloaded: r.unloaded, skipped: r.skipped, handles: r.handles.map((x) => ({ id: x.id, bytes: x.handle && x.handle.bytes ? x.handle.bytes.length : 0 })), applied, applyNote, applyItems });
                }
                if (method === 'POST' && P === '/api/lora/unload') { const reg = await syncRegistry(); const ids = body.id ? [body.id] : await reg.reg.unloadAll(); if (body.id) await reg.reg.unload(body.id); if (h.loraClear) { try { await h.loraClear(); } catch (_) { /* 主程序沒回應不影響卸載 */ } } return ok({ unloaded: ids }); }
                // ---- 資料匯入與清洗（第二輪，接 ingest_core／clean_core）----
                if (method === 'POST' && P === '/api/ingest/pick') {
                    const src = String(body.source || ''); if (SOURCES.indexOf(src) < 0) return bad(400, '來源必須是 ' + SOURCES.join('／'));
                    if (!h.pickFiles) return bad(501, '這個環境沒有檔案挑選器');
                    const files = await h.pickFiles({ directory: src === 'wiki' || src === 'open_source', accept: src === 'aidoc' ? '.json' : (src === 'book' ? '.txt,.md,.html' : '') });
                    if (!files || !files.length) return ok({ cancelled: true });
                    let docs = [], skipped = [], info = {};
                    try {
                        if (src === 'aidoc') { for (const f of files) { let o; try { o = JSON.parse(f.content); } catch (_) { skipped.push({ path: f.path, reason: '不是 JSON' }); continue; } const r = Ingest.ingest('aidoc', o, {}); docs = docs.concat(r.docs); skipped = skipped.concat(r.skipped || []); info = r.info || info; } }
                        else if (src === 'book') { const f = files[0]; const r = Ingest.ingest('book', { title: String(body.title || f.path.replace(/\.[^.]+$/, '')), author: body.author || undefined, text: f.content }, {}); docs = r.docs; skipped = r.skipped || []; info = r.info || {}; }
                        else { const r = Ingest.ingest(src, files.map((f) => ({ path: f.path, content: f.content })), {}); docs = r.docs; skipped = r.skipped || []; info = r.info || {}; }
                    } catch (e) { return bad(409, '匯入來源解析失敗：' + String((e && e.message) || e)); }
                    const cw = Number(body.contextWindowTokens) > 0 ? Number(body.contextWindowTokens) : 4096;
                    const cl = Clean.cleanDocs(docs, { contextWindowTokens: cw, now: new Date(now()).toISOString() });
                    const rq = Clean.buildSampleRequests(cl.chunks, { now: new Date(now()).toISOString() });
                    S.ingest = { source: src, chunks: cl.chunks, rejected: cl.rejected, stats: cl.stats, skipped, info, requests: rq.requests, samples: [], sizing: cl.sizing, savedAs: null };
                    log('資料匯入 ' + src + '：' + files.length + ' 個檔案 → ' + cl.chunks.length + ' 個語料塊、' + rq.requests.length + ' 張請求單（拒絕 ' + cl.rejected.length + '、略過 ' + skipped.length + '）');
                    return ok(ingestView());
                }
                // ---- 資料匯入的輸入欄位：本機路徑／fap 參照／網址／多個資料夾／釘選（設計 §15.4）----
                if (method === 'GET' && P === '/api/ingest/pins') return ok({ pins: prefsObj().ingestPins || [], can: { path: !!h.localReadDir, fap: !!h.fapList, url: !!h.fetchUrl } });
                if (method === 'POST' && P === '/api/ingest/pin') { const r = SourceInput.addPin(prefsObj().ingestPins, body); if (!r.ok) return bad(409, r.error); const np = Object.assign({}, prefsObj()); np.ingestPins = r.pins; h.prefsSet(np); return ok({ pins: r.pins, pin: r.pin }); }
                if (method === 'POST' && P === '/api/ingest/unpin') { const r = SourceInput.removePin(prefsObj().ingestPins, String(body.id || '')); if (!r.ok) return bad(404, '沒有這個釘選'); const np = Object.assign({}, prefsObj()); np.ingestPins = r.pins; h.prefsSet(np); return ok({ pins: r.pins }); }
                if (method === 'POST' && P === '/api/ingest/plan') { const inputs = (Array.isArray(body.inputs) ? body.inputs : String(body.lines || '').split(/\r?\n/).map(SourceInput.parseLine)).filter(Boolean); return ok({ inputs, urls: SourceInput.planUrls(inputs) }); }
                if (method === 'POST' && P === '/api/ingest/from') {
                    const src = String(body.source || ''); if (SOURCES.indexOf(src) < 0) return bad(400, '來源必須是 ' + SOURCES.join('／'));
                    const inputs = (Array.isArray(body.inputs) ? body.inputs : String(body.lines || '').split(/\r?\n/).map(SourceInput.parseLine)).filter((x) => x && x.value); if (!inputs.length) return bad(400, '請至少填一個輸入（本機路徑、fap:資料夾、或網址；一行一個）');
                    const urls = SourceInput.planUrls(inputs);
                    if (urls.length && !body.confirmedUrls) return bad(400, '要連網取得網址內容，請先確認（使用者主動操作）：' + urls.map((u) => u.url + (u.ok ? ' → ' + u.willFetch.join('、') : '（' + u.error + '）')).join('；'), { needsConfirm: true, urls });
                    const ex = await SourceInput.expandInputs(inputs, h, body.limits);
                    const files = ex.files.filter((f) => f.content != null);
                    if (!files.length) return bad(409, '沒有取得任何可用的文字檔：' + ex.sources.map((s) => s.type + ' ' + s.value + '：' + (s.error || '無檔案')).join('；'), { sources: ex.sources });
                    let docs = [], skipped = ex.files.filter((f) => f.content == null).map((f) => ({ path: f.path, reason: '二進位／過大／在略過目錄（' + f.size + ' 位元組）' })), info = {};
                    try {
                        if (src === 'aidoc') { for (const f of files) { let o; try { o = JSON.parse(f.content); } catch (_) { skipped.push({ path: f.path, reason: '不是 JSON' }); continue; } const r = Ingest.ingest('aidoc', o, {}); docs = docs.concat(r.docs); skipped = skipped.concat(r.skipped || []); info = r.info || info; } }
                        else if (src === 'book') { const f = files[0]; const r = Ingest.ingest('book', { title: String(body.title || f.path.replace(/\.[^.]+$/, '')), author: body.author || undefined, text: files.map((x) => x.content).join('\n\n') }, {}); docs = r.docs; skipped = skipped.concat(r.skipped || []); info = r.info || {}; }
                        else { const r = Ingest.ingest(src, files.map((f) => ({ path: f.path, content: f.content })), {}); docs = r.docs; skipped = skipped.concat(r.skipped || []); info = r.info || {}; }
                    } catch (e) { return bad(409, '匯入來源解析失敗：' + String((e && e.message) || e)); }
                    const cw = Number(body.contextWindowTokens) > 0 ? Number(body.contextWindowTokens) : 4096;
                    const cl = Clean.cleanDocs(docs, { contextWindowTokens: cw, now: new Date(now()).toISOString() });
                    const rq = Clean.buildSampleRequests(cl.chunks, { now: new Date(now()).toISOString() });
                    S.ingest = { source: src, chunks: cl.chunks, rejected: cl.rejected, stats: cl.stats, skipped, info, requests: rq.requests, samples: [], sizing: cl.sizing, savedAs: null, inputs: ex.sources };
                    log('資料匯入（輸入欄位）' + src + '：' + inputs.length + ' 個輸入、' + files.length + ' 個檔案、' + ex.totalBytes + ' 位元組 → ' + cl.chunks.length + ' 個語料塊');
                    return ok(ingestView());
                }
                if (method === 'GET' && P === '/api/ingest') return ok(ingestView());
                if (method === 'GET' && P === '/api/ingest/chunks') { if (!S.ingest) return ok({ chunks: [], total: 0 }); const off = Math.max(0, Number(Q('offset')) || 0), lim = Math.min(100, Number(Q('limit')) || 20); return ok({ total: S.ingest.chunks.length, chunks: S.ingest.chunks.slice(off, off + lim).map(chunkBrief) }); }
                if (method === 'POST' && P === '/api/ingest/drop') {
                    if (!S.ingest) return bad(409, '還沒有匯入資料'); const id = String(body.chunkId || ''); const i = S.ingest.chunks.findIndex((c) => c.id === id); if (i < 0) return bad(404, '沒有這個語料塊');
                    S.ingest.chunks.splice(i, 1); S.ingest.requests = S.ingest.requests.filter((r) => r.chunk_id !== id); S.ingest.samples = S.ingest.samples.filter((r) => !(r.meta && r.meta.chunk_id === id)); S.ingest.rejected.push({ id, reason: 'manual_drop' }); return ok(ingestView());
                }
                if (method === 'POST' && P === '/api/ingest/rules') {
                    if (!S.ingest) return bad(409, '還沒有匯入資料'); const rows = Clean.ruleSamples(S.ingest.chunks, {}); const hc = new Set(S.ingest.chunks.filter((c) => c.split === 'heldout').map((c) => c.id)); const have = new Set(S.ingest.samples.map((r) => r.id));
                    const good = [], badRows = []; rows.forEach((r) => { const v = Clean.validateRow(r); if (v.length) badRows.push({ id: r.id, problems: v }); else if (!have.has(r.id) && !hc.has(r.meta && r.meta.chunk_id)) good.push(r); });
                    S.ingest.samples = S.ingest.samples.concat(good); log('規則樣本：新增 ' + good.length + ' 列（不用 AI；答案逐字取自語料塊）'); return ok(Object.assign(ingestView(), { added: good.length, invalid: badRows.slice(0, 10) }));
                }
                if (method === 'POST' && P === '/api/ingest/save') {
                    if (!S.ingest) return bad(409, '還沒有匯入資料'); const name = String(body.name || ''); if (!Asset.safeName(name)) return bad(400, '請填合法的資產名稱（不可含斜線或 ..）');
                    if (!body.overwrite && await h.storage.loadManifest('lora', name)) return bad(409, '「' + name + '」已存在（要覆蓋請帶 overwrite:true）');
                    const enc = (x) => new TextEncoder().encode(x.map((r) => JSON.stringify(r)).join('\n') + (x.length ? '\n' : ''));
                    const files = { 'data/corpus.jsonl': enc(S.ingest.chunks), 'data/requests.jsonl': enc(S.ingest.requests), 'data/train.jsonl': enc(S.ingest.samples) };
                    const lic = {}; S.ingest.chunks.forEach((c) => { lic[c.meta.license] = (lic[c.meta.license] || 0) + 1; });
                    const m = Asset.createManifest({ kind: 'lora', name, files, counts: { chunks: S.ingest.chunks.length, requests: S.ingest.requests.length, samples: S.ingest.samples.length }, owner: 'user', extra: { ingest: { source: S.ingest.source, stats: S.ingest.stats, licenses: lic, data_only: true } } });
                    const w = await h.storage.saveAsset({ manifest: m, files }, { replace: true }); if (!w.ok) return bad(500, w.error); S.ingest.savedAs = name;
                    log('資料匯入結果存成資產 lora/' + name + '（資料檔，沒有權重）'); if (S.push) S.push({ type: 'asset_changed' }); return ok({ name, write: w });
                }
                if (method === 'POST' && P === '/api/ingest/load') {
                    const r = await readAsset('lora', String(body.name || '')); if (!r) return bad(404, '沒有這個資產'); const f = r.asset.files, dec2 = (u) => (u ? new TextDecoder().decode(u).split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
                    if (!f['data/corpus.jsonl']) return bad(409, '這個資產沒有 data/corpus.jsonl（不是資料匯入的結果）');
                    const ing = (r.asset.manifest.extra && r.asset.manifest.extra.ingest) || {};
                    S.ingest = { source: ing.source || '', chunks: dec2(f['data/corpus.jsonl']), rejected: [], stats: ing.stats || {}, skipped: [], info: {}, requests: dec2(f['data/requests.jsonl']), samples: dec2(f['data/train.jsonl']), savedAs: body.name };
                    return ok(ingestView());
                }
                // ---- 老師領取樣本請求單（§6；老師迴圈本身尚未實作，這裡是它領取與回交的接口）----
                if (method === 'POST' && P === '/api/teacher/claim') {
                    if (!S.ingest) return bad(409, '還沒有匯入資料，沒有請求單'); const lim = Math.min(20, Math.max(1, Number(body.limit) || 5)); const out = [];
                    for (const r of S.ingest.requests) { if (out.length >= lim) break; if (r.status === 'pending' && (!body.task || r.task === body.task)) { r.status = 'claimed'; r.claimed_at = now(); out.push(r); } }
                    log('老師領取 ' + out.length + ' 張請求單'); return ok({ requests: out });
                }
                if (method === 'POST' && P === '/api/teacher/release') { if (!S.ingest) return ok({ released: 0 }); let n = 0; S.ingest.requests.forEach((r) => { if (r.status === 'claimed' && (!body.ids || body.ids.indexOf(r.id) >= 0)) { r.status = 'pending'; n++; } }); return ok({ released: n }); }
                if (method === 'POST' && P === '/api/teacher/submit') {
                    if (!S.ingest) return bad(409, '還沒有匯入資料'); const rq = S.ingest.requests.find((r) => r.id === body.id); if (!rq) return bad(404, '沒有這張請求單'); if (rq.status !== 'claimed') return bad(409, '請求單不是「已領取」狀態（' + rq.status + '）');
                    const chunk = S.ingest.chunks.find((c) => c.id === rq.chunk_id); if (!chunk) return bad(409, '請求單引用的語料塊已被移除');
                    const row = Object.assign({ split: 'train', domain: rq.domain, verified_by: 'rejection_sampling', source_file: (rq.source && (rq.source.path || rq.source.url)) || chunk.meta.path || chunk.meta.source || 'corpus' }, body.row || {}); row.meta = Object.assign({}, row.meta, { author: 'teacher', chunk_id: chunk.id, task: rq.task });
                    if (!row.id) row.id = 'doc_knowledge:' + Clean.hash64(rq.id + '|' + String(row.completion || '').slice(0, 60));
                    const v = Clean.verifyTeacherSample(row, chunk, {}); if (!v.ok) { rq.status = 'pending'; rq.last_problems = v.problems; log('老師樣本被拒（' + rq.id + '）：' + v.problems[0]); return bad(422, '樣本驗證沒過：' + v.problems.join('；'), { problems: v.problems }); }
                    if (S.ingest.samples.some((r) => r.id === row.id)) return bad(409, '樣本 id 重複'); S.ingest.samples.push(row); rq.status = 'done'; return ok({ accepted: true, samples: S.ingest.samples.length });
                }
                return bad(404, '沒有這個路由：' + method + ' ' + P);
            } catch (e) { return bad(500, String((e && e.message) || e)); }
        }
        return { route, S, log, push: null, setPush(f) { S.push = f; } };
    }
    return { createServer, WEB_BACKENDS, KIND_LABEL, NOT_DESKTOP };
});
