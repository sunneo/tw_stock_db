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
    if (typeof module === 'object' && module.exports) module.exports = factory(A, F, T, Lay);
    else root.FaStudioServer = factory(A, F, T, Lay);
})(typeof self !== 'undefined' ? self : this, function (Asset, Fatrain, Trainer, Layout) {
    'use strict';
    const KIND_LABEL = { colu: 'CoLU', blockly: '積木課程', matrix: '矩陣層', uml: 'UML 設計', trainer: '離線訓練器', lora: 'LoRA' };
    const dec = (u) => new TextDecoder('utf-8').decode(u);
    const WEB_BACKENDS = [
        { id: 'cpu-py', available: false, reason: '網頁版沒有 Python 子行程；請「匯出訓練包」（.fatrain）後到桌面版訓練' },
        { id: 'webgpu', available: false, reason: 'WebGPU 的 LoRA 反向傳播引擎尚未實作（研究中：onnxruntime-web 只有推論，需自寫 WGSL 前向／反向，單層梯度對拍通過前不點亮）', planned: true },
        { id: 'directml', available: false, reason: 'DirectML 只在桌面版原生路徑有意義，且尚未實作', planned: true },
        { id: 'vulkan', available: false, reason: 'Vulkan 後端尚未實作', planned: true },
    ];
    const NOT_DESKTOP = '這個功能要在桌面版執行（需要主行程子行程）；網頁版請用「匯出訓練包」到桌面版訓練';

    function createServer(h) {
        const S = { log: [], pending: null, seq: 0, lastTrain: null, lastBench: null };
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
                if (method === 'GET' && P === '/api/teacher') return ok({ implemented: false, reason: '老師面板（白名單工具、驗證鐵則、缺口驅動，§6）屬設計文件 §10 步驟 7，尚未實作；它依賴資料匯入的樣本請求單（第二輪），目前沒有可領取的請求。' });
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
                return bad(404, '沒有這個路由：' + method + ' ' + P);
            } catch (e) { return bad(500, String((e && e.message) || e)); }
        }
        return { route, S, log, push: null, setPush(f) { S.push = f; } };
    }
    return { createServer, WEB_BACKENDS, KIND_LABEL, NOT_DESKTOP };
});
