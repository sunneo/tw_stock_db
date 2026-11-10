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
    if (typeof module === 'object' && module.exports) module.exports = factory(A, F, T, Lay, Ing, Cln, Reg);
    else root.FaStudioServer = factory(A, F, T, Lay, Ing, Cln, Reg);
})(typeof self !== 'undefined' ? self : this, function (Asset, Fatrain, Trainer, Layout, Ingest, Clean, LoraReg) {
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
    const LORA_APPLY_BLOCKER = '載入器已把 adapter 讀成 {id, bytes}（nr-engine.js 的 lora 接點格式），但原生執行器的子行程（nr-host.js／nr-child.js）沒有轉傳 lora 欄位，這兩個檔屬於 md5 釘住、從 GitHub 分支下載的執行包，要先更新執行包才能真的套用到推論；所以這裡只做到「選用與載入到記憶體」，不假裝已套用';
    const SOURCES = ['wiki', 'open_source', 'book', 'aidoc'];
    const NOT_DESKTOP = '這個功能要在桌面版執行（需要主行程子行程）；網頁版請用「匯出訓練包」到桌面版訓練';

    function createServer(h) {
        const S = { log: [], pending: null, seq: 0, lastTrain: null, lastBench: null, ingest: null, registry: null, regSha: {} };
        const chunkBrief = (c) => ({ id: c.id, tokens: c.tokens_est, split: c.split, code: !!c.code, heading: c.meta.heading || c.meta.title || '', path: c.meta.path || '', license: c.meta.license, builtin_allowed: !!(c.meta.license_policy && c.meta.license_policy.builtin_allowed), user_supplied: !!c.meta.user_supplied, redactions: c.meta.redactions, head: c.text.slice(0, 200) });
        const ingestView = () => {
            const I = S.ingest; if (!I) return { has: false };
            const lic = {}; I.chunks.forEach((c) => { lic[c.meta.license] = (lic[c.meta.license] || 0) + 1; });
            const q = { pending: 0, claimed: 0, done: 0 }; I.requests.forEach((r) => { q[r.status] = (q[r.status] || 0) + 1; });
            return { has: true, source: I.source, stats: I.stats, sizing: I.sizing, licenses: lic, skipped: (I.skipped || []).slice(0, 30), skippedTotal: (I.skipped || []).length, rejectedTotal: I.rejected.length, rejected: I.rejected.slice(0, 30), preview: I.chunks.slice(0, 8).map(chunkBrief), requests: q, samples: I.samples.length, savedAs: I.savedAs || null };
        };
        // 由 kind:'lora' 且帶權重的資產建立登錄項；只含資料的資產（資料匯入的結果）不是 adapter
        async function syncRegistry() {
            if (!S.registry) S.registry = LoraReg.createRegistry({ env: LORA_ENV, loader: LoraReg.nrEngineLoader({ readBytes: async (e) => { const r = await h.storage.loadAsset('lora', e.asset_name); if (!r || !r.asset.files[e.weight_file]) throw new Error('讀不到權重檔 ' + e.weight_file); return r.asset.files[e.weight_file]; }, sha256Hex: Asset.sha256Hex }) });
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
        const log = (text, extra) => { const r = Object.assign({ at: now(), text }, extra || {}); S.log.push(r); if (S.log.length > 500) S.log.shift(); if (S.push) { try { S.push({ type: 'log', rec: r }); } catch (_) { /* */ } } return r; };
        const ok = (j) => ({ j: Object.assign({ ok: true }, j) });
        const bad = (s, error, extra) => ({ s, j: Object.assign({ ok: false, error }, extra || {}) });
        const imported = () => { const p = (h.prefsGet && h.prefsGet()) || {}; return Array.isArray(p.imported) ? p.imported : []; };
        const markImported = (kind, name) => { const p = Object.assign({}, h.prefsGet ? h.prefsGet() : {}); const a = imported().filter((x) => x !== kind + '/' + name); a.push(kind + '/' + name); p.imported = a.slice(-500); h.prefsSet(p); };
        const fapNote = async () => { const st = await h.storage.fapState(); return st.ok ? { ok: true } : { ok: false, message: st.message, reason: st.reason }; };
        const callHost = async (op, payload, t) => { if (!h.desktop || !h.call) return { ok: false, error: NOT_DESKTOP, notDesktop: true }; const r = await h.call(op, payload || {}, t || 20000); if (r && r.ok === false && !r.error) r.error = r.message || r.code || '主行程沒有回應'; return r; };
        const readAsset = async (kind, name) => { const r = await h.storage.loadAsset(kind, name); return r; };

        async function listAssets() {
            const items = await h.storage.listAssets(), imp = new Set(imported()), groups = {};
            Asset.KINDS.forEach((k) => { groups[k] = { kind: k, label: KIND_LABEL[k] || k, items: [] }; });
            for (const it of items) { if (!groups[it.kind]) continue; const origin = it.owner === 'builtin' ? 'builtin' : (imp.has(it.kind + '/' + it.name) ? 'imported' : 'mine'); groups[it.kind].items.push(Object.assign({}, it, { origin })); }
            return Asset.KINDS.map((k) => groups[k]);
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
                    return ok({ manifest: r.asset.manifest, verify: { ok: r.verify.ok, message: r.verify.message || '' }, files: Object.keys(r.asset.files).map((p) => ({ path: p, bytes: r.asset.files[p].length })) });
                }
                if (method === 'GET' && P === '/api/asset-file') {
                    const r = await readAsset(Q('kind'), Q('name')); if (!r) return bad(404, '沒有這個資產'); const f = r.asset.files[Q('path')]; if (!f) return bad(404, '資產裡沒有這個檔案');
                    const head = f.subarray(0, 6000); let text; try { text = dec(head); } catch (_) { text = ''; }
                    return ok({ path: Q('path'), bytes: f.length, truncated: f.length > head.length, text });
                }
                if (method === 'POST' && P === '/api/asset/delete') {
                    if (!body.confirmed) return bad(400, '刪除資產要先確認（confirmed:true）', { needsConfirm: true });
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
                    const out = []; for (const it of await h.storage.listAssets()) { const r = await readAsset(it.kind, it.name); if (!r) continue; Object.keys(r.asset.files).filter((p) => /^data\//.test(p)).forEach((p) => out.push({ kind: it.kind, name: it.name, path: p, bytes: r.asset.files[p].length })); }
                    return ok({ files: out, note: out.length ? '' : '還沒有任何資產帶資料檔（data/）。把離線訓練器存成資產後這裡會出現 solutions／synonyms 等資料。' });
                }
                if (method === 'GET' && P === '/api/eval') {
                    const out = []; for (const it of await h.storage.listAssets()) { const m = await h.storage.loadManifest(it.kind, it.name); if (m && m.eval) out.push({ kind: it.kind, name: it.name, eval: m.eval }); }
                    return ok({ items: out, implemented: false, reason: out.length ? '' : '評量集與分組評量的執行（每組都列、退步標紅、上線門檻）屬設計文件 §10 步驟 3／§8，目前資產的 manifest 還沒有任何評量結果；等符號式包裝與 LoRA 評量集（資料匯入）完成後才會有資料' });
                }
                if (method === 'GET' && P === '/api/teacher') { const v = ingestView(); return ok({ implemented: false, reason: '老師迴圈本身（呼叫線上 AI、白名單工具、缺口驅動，§6）屬設計文件 §10 步驟 7，尚未實作；請求單的領取、驗證與回交接口（/api/teacher/claim｜submit｜release）已可用。' + (v.has ? '' : '目前還沒有匯入資料，沒有請求單。'), queue: v.has ? v.requests : null, samples: v.has ? v.samples : 0 }); }
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
                    let applied = false, applyNote = LORA_APPLY_BLOCKER;
                    if (h.loraApply && r.handles.length) { try { const a = await h.loraApply(r.handles); applied = !!(a && a.ok); applyNote = (a && (a.error || a.note)) || ''; } catch (e) { applyNote = String((e && e.message) || e); } }
                    log('LoRA 按需載入：' + (r.active.join('、') || '（沒有符合的）') + (applied ? '，已套用' : '，尚未套用到推論'));
                    return ok({ active: r.active, loaded: r.loaded, unloaded: r.unloaded, skipped: r.skipped, handles: r.handles.map((x) => ({ id: x.id, bytes: x.handle && x.handle.bytes ? x.handle.bytes.length : 0 })), applied, applyNote });
                }
                if (method === 'POST' && P === '/api/lora/unload') { const reg = await syncRegistry(); const ids = body.id ? [body.id] : await reg.reg.unloadAll(); if (body.id) await reg.reg.unload(body.id); return ok({ unloaded: ids }); }
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
