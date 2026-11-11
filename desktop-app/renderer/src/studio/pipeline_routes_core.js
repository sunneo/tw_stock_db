'use strict';
/* 流程總覽與建議的路由（純核心，依賴注入；不直接碰檔案，檔案由 studio_host 的唯讀操作讀出）。設計見 DESIGN.TODO.offline-training-studio.md §19。
 *   createPipelineApi(deps).route(method, url, body) → null（不是這裡的路由）或 { j } ／ { s, j }
 *   GET  /api/pipeline?kind=&name=&run=&env=   五種訓練的階段圖＋即時狀態（run＝訓練輸出資料夾，裡面的 train.log、run.pid）＋匯出格式選擇
 *   GET  /api/advice?kind=&name=               讀資產的 eval.json，推導「下一次該加強什麼」
 *   POST /api/advice/from-json  {report, trainRows, source}   貼上或選取的評量 JSON 直接推導
 * deps：storage（loadManifest、loadAsset）、readRunLog(dir) → { log, rssBytes, rssReason, hostRssBytes }（studio_run_info）、
 *       now()、Pipeline（pipeline_core）、Live（pipeline_live_core）、Advice（train_advice_core）、parseLine（backend_cpu_py.parseProgressLine）、exportCaps()
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaStudioPipelineRoutes = factory();
}(typeof self !== 'undefined' ? self : this, function () {
    // 流程種類 → 資產 kind（llm 的產物是 LoRA 資產；完整模型的匯出尚未實作）
    const ASSET_KIND = { colu: 'colu', matrix: 'matrix', blockly: 'blockly', lora: 'lora', llm: 'lora' };
    const SYMBOLIC = ['colu', 'matrix', 'blockly'];
    const MEM_KEEP = 200;

    // 從資產 manifest 推導 facts：資產存在＝訓練與打包已寫出（資產是原子寫入；有 sha256 才算）
    function factsFromManifest(kind, m, Pipeline) {
        const stages = {};
        // 符號式的按需載入不依賴產物：永遠略過（由程式直接使用）
        if (SYMBOLIC.indexOf(kind) >= 0) stages.mount = { skipped: '符號式模型由程式直接使用，不需要載入' };
        if (!m || !m.sha256 || !Object.keys(m.sha256).length) return { stages };
        const sum = Pipeline.summarizeProduct(m), prod = [sum], done = true;
        ['ingest', 'generate', 'split', 'train', 'pack'].forEach((id) => { stages[id] = { products: prod, done }; });
        if (m.eval) stages.eval = { products: prod, done };
        return { stages };
    }

    // 日誌行 → 事件（parseLine 回 null 的行略過）
    function eventsFromLog(text, parseLine) {
        return String(text || '').split(/\r?\n/).map((l) => parseLine(l)).filter(Boolean);
    }

    // 從資料檔數出每個領域的訓練列數（holdout 不計；沒有 domain 欄位的列歸到 "?"）
    function trainRowsFrom(files) {
        const out = {};
        Object.keys(files || {}).filter((p) => /^data\/.*\.jsonl$/.test(p)).forEach((p) => {
            const u8 = files[p]; const txt = typeof u8 === 'string' ? u8 : new TextDecoder('utf-8').decode(u8);
            txt.split('\n').forEach((line) => {
                const t = line.trim(); if (!t) return; let r; try { r = JSON.parse(t); } catch (e) { return; }
                if (!r || r.split === 'holdout' || r.split === 'heldout') return;
                const d = typeof r.domain === 'string' && r.domain ? r.domain : '?'; out[d] = (out[d] || 0) + 1;
            });
        });
        return out;
    }

    function createPipelineApi(deps) {
        const d = deps || {}; const memHist = new Map();
        const now = () => (typeof d.now === 'function' ? d.now() : Date.now());
        const exportCaps = () => (typeof d.exportCaps === 'function' ? d.exportCaps() : { onnxExport: false, ggufExport: false });

        async function pipelineView(kind, name, run, env) {
            if (!d.Pipeline || !d.Live) return { ok: false, error: '流程核心沒有接上' };
            if (d.Pipeline.KINDS.indexOf(kind) < 0) return { ok: false, error: 'kind 必須是 ' + d.Pipeline.KINDS.join('／') + '，收到 ' + JSON.stringify(kind) };
            const ak = ASSET_KIND[kind];
            const m = name && d.storage ? await d.storage.loadManifest(ak, name) : null;
            const facts = factsFromManifest(kind, m, d.Pipeline);
            let live = null, memory = null, memoryReason = '', logOk = false, rssHost = null;
            if (run && typeof d.readRunLog === 'function') {
                const info = await d.readRunLog(String(run));
                if (info && info.log !== null && info.log !== undefined) {
                    logOk = true;
                    const events = Array.isArray(info.events) ? info.events : eventsFromLog(info.log, d.parseLine || (() => null));
                    if (info.rssBytes !== null && info.rssBytes !== undefined) {
                        const h = memHist.get(run) || []; h.push({ t: now(), rssBytes: info.rssBytes }); if (h.length > MEM_KEEP) h.shift(); memHist.set(run, h);
                    }
                    rssHost = info.hostRssBytes === undefined ? null : info.hostRssBytes;
                    live = d.Live.liveProgress(events, { running: false, nowMs: now(), memSamples: memHist.get(run) || [] });
                    const fl = d.Live.progressToFacts(live);
                    facts.stages.train = Object.assign({}, facts.stages.train || {}, fl);
                    memory = live.memory; memoryReason = live.memoryReason;
                    if (!memory) memoryReason = info.rssReason || live.memoryReason;
                } else memoryReason = '讀不到訓練紀錄（train.log）';
            } else if (run) memoryReason = '主行程沒有讀取訓練紀錄的接口';
            else memoryReason = '沒有指定訓練資料夾（run）';
            const stages = d.Pipeline.deriveStageStates(kind, facts);
            const e = env === 'web' ? 'web' : 'desktop';
            return { ok: true, kind, label: stages.label, stages: stages.stages, live, memory, memoryReason, hostRssBytes: rssHost,
                export: d.Pipeline.pickExportFormat(e, exportCaps()), env: e,
                source: { manifest: !!m, log: logOk, runDir: run || null, asset: name ? ak + '/' + name : null } };
        }

        async function adviceFromAsset(kind, name) {
            if (!d.Advice) return { ok: false, error: '建議核心沒有接上' };
            const ak = ASSET_KIND[kind] || kind;
            const a = d.storage && name ? await d.storage.loadAsset(ak, name) : null;
            const f = a && a.asset && a.asset.files ? a.asset.files : {};
            if (!f['eval.json']) return { ok: true, suggestions: [], insufficient: [{ rule: 'eval', name: '全體', missing: ['eval.json'], reason: '這個資產沒有 eval.json（評量輸出）；用 lora-train/eval_run.py --json_out 產生後放進資產' }], thresholds: d.Advice.DEFAULT_THRESHOLDS, source: ak + '/' + name };
            let rep; try { rep = JSON.parse(typeof f['eval.json'] === 'string' ? f['eval.json'] : new TextDecoder('utf-8').decode(f['eval.json'])); } catch (e) { return { ok: false, error: 'eval.json 不是合法的 JSON：' + ((e && e.message) || e) }; }
            const out = d.Advice.adviceFromEval({ groups: rep.groups, rows: rep.rows, trainRows: trainRowsFrom(f), source: ak + '/' + name + ' 的 eval.json' });
            return Object.assign({ source: ak + '/' + name }, out);
        }

        async function route(method, u, body) {
            const P = u.pathname, Q = (k) => u.searchParams.get(k) || '';
            try {
                if (method === 'GET' && P === '/api/pipeline') {
                    const v = await pipelineView(Q('kind') || 'lora', Q('name'), Q('run'), Q('env'));
                    return v.ok ? { j: v } : { s: 400, j: v };
                }
                if (method === 'GET' && P === '/api/advice') {
                    const v = await adviceFromAsset(Q('kind') || 'lora', Q('name'));
                    return v.ok === false ? { s: 400, j: v } : { j: Object.assign({ ok: true }, v) };
                }
                if (method === 'GET' && P === '/api/lora/card') { const v = await loraCard(Q('id')); return v; }
                if (method === 'POST' && P === '/api/advice/from-json') {
                    const b = body || {}; const rep = b.report;
                    if (!rep || typeof rep !== 'object' || !rep.groups) return { s: 400, j: { ok: false, error: '缺 report（eval_run.py 的 --json_out 內容，需要有 groups）' } };
                    const out = d.Advice.adviceFromEval({ groups: rep.groups, rows: rep.rows, trainRows: b.trainRows || {}, source: String(b.source || '貼上的評量 JSON') });
                    return { j: Object.assign({ ok: true }, out) };
                }
            } catch (e) { return { s: 500, j: { ok: false, error: String((e && e.message) || e) } }; }
            return null;
        }
        // LoRA model card（lora_manage_core.js，§21）：讀資產的 model_card.json，檢查後回摘要；沒有就說沒有
        async function loraCard(id) {
            if (!d.LoraManage) return { s: 500, j: { ok: false, error: 'LoRA 管理核心沒有接上' } };
            const m = /^lora\/(.+)$/.exec(String(id || ''));
            if (!m) return { s: 400, j: { ok: false, error: '參照格式是 lora/<名稱>' } };
            const a = d.storage ? await d.storage.loadAsset('lora', m[1]) : null;
            const f = a && a.asset && a.asset.files ? a.asset.files['model_card.json'] : null;
            if (!f) return { j: { ok: true, hasCard: false, card: null, reason: '這個 LoRA 沒有 model_card.json' } };
            let card; try { card = JSON.parse(typeof f === 'string' ? f : new TextDecoder('utf-8').decode(f)); } catch (e) { return { s: 400, j: { ok: false, error: 'model_card.json 不是合法的 JSON：' + ((e && e.message) || e) } }; }
            return { j: { ok: true, hasCard: true, card: d.LoraManage.summarizeCard(card), source: 'lora/' + m[1] + '/model_card.json' } };
        }
        // 註冊表介面到位前，列表用假資料（讀取 entries 與槽位的真正來源由 lora-slot-js 提供）；這裡只轉傳 card
        return { route, pipelineView, adviceFromAsset, loraCard };
    }

    return { ASSET_KIND, createPipelineApi, factsFromManifest, eventsFromLog, trainRowsFrom };
}));
