'use strict';
/* 訓練工作室「流程總覽（pipeline view）」純核心（UMD，不碰 DOM、網路、檔案系統）。設計見 DESIGN.TODO.offline-training-studio.md §17。
 *   PIPELINES[kind]                      五種訓練的階段表（左到右）：colu／matrix／blockly／lora／llm
 *   deriveStageStates(kind, facts)       依「真實產物」推導每個階段狀態：待做／進行中／完成／失敗／略過
 *   summarizeProduct(manifest)           資產 manifest → 產物摘要（筆數、檔案數、manifest 雜湊、sha256 片段）
 *   pickExportFormat(env, caps)          LLM 匯出格式預設：依環境（web／desktop）與可用工具挑 ONNX q8 或 GGUF，不寫死
 * facts 形狀（由呼叫端從磁碟或資產庫讀出，本模組不讀檔）：
 *   facts.stages[id] = { products: [{ count, files, sha256 }], done: bool（有 done 標記）, running: bool, failed: '原因' 或 null, skipped: '原因' 或 null, elapsedMs: 數字 或 null }
 * 規則：failed 優先；其次 running；有產物且有 done 標記 → 完成；有產物但沒有 done 標記 → 失敗（產物不完整，不宣稱完成）；
 *       skipped → 略過；前一個必要階段沒完成時，本階段為待做（不因有殘留檔案而算完成）。
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./asset_core.js'));
    else root.FaStudioPipeline = factory(root.FaStudioAsset);
}(typeof self !== 'undefined' ? self : this, function (Asset) {
    const STATES = ['待做', '進行中', '完成', '失敗', '略過'];

    // 階段定義：implemented 為 false 時 blocker 必須寫明阻礙（畫面顯示「尚未實作」＋原因，不假裝可用）
    const S = (id, label, extra) => Object.assign({ id, label, implemented: true, required: true }, extra || {});
    const SYM_TRAIN = S('train', '訓練（cpu-js 符號式）', { backends: ['cpu-js'] });
    const SYM_MOUNT = S('mount', '按需載入', { implemented: true, required: false, lookup: true, note: '符號式模型由程式直接使用，不需要載入（略過）' });
    const common = (kind, trainStage, extra) => [
        S('ingest', '資料來源／匯入清洗'), S('generate', '資料產生（驗證）'), S('split', '切分訓練與留出'),
        trainStage, S('eval', '評量（基底 vs 微調，退步列出）'), S('pack', '打包／匯出'), extra
    ];

    const PIPELINES = {
        colu: { kind: 'colu', label: 'CoLU', stages: common('colu', SYM_TRAIN, SYM_MOUNT) },
        matrix: { kind: 'matrix', label: '矩陣操作', stages: common('matrix', Object.assign({}, SYM_TRAIN, { note: '判題需要 Python；沒有時訓練階段標「失敗」並寫原因' }), SYM_MOUNT) },
        blockly: { kind: 'blockly', label: 'blockly 教學', stages: common('blockly', Object.assign({}, SYM_TRAIN, { note: '判題需要 tree-sitter 快取與 Python' }), SYM_MOUNT) },
        lora: {
            kind: 'lora', label: 'LoRA',
            stages: [
                S('ingest', '資料來源／匯入清洗'), S('generate', '資料產生（驗證）'), S('split', '切分訓練與留出'),
                S('train', '訓練（後端：cpu-py／wasm-web）', { backends: ['cpu-py', 'wasm-web'], note: 'webgpu、directml、vulkan 仍是研究項，不在這裡' }),
                S('eval', '評量（基底 vs 微調，退步列出）'), S('pack', '打包（lora.bin，fatrain）'), S('mount', '按需載入（登錄與套用）')
            ]
        },
        llm: {
            kind: 'llm', label: 'LLM 模型（完整模型）',
            stages: [
                S('ingest', '資料來源／匯入清洗'), S('generate', '資料產生（驗證）'), S('split', '切分訓練與留出'),
                S('train', '訓練（LoRA 或完整微調）', { backends: ['cpu-py'], implemented: true, note: '目前只有 LoRA 路線；完整微調尚未實作' }),
                S('eval', '評量（基底 vs 微調，退步列出）'),
                S('merge', '合併（LoRA 併入基底權重）', { note: '有 lora_merge_core.js；完整模型路線的合併尚未接上' }),
                S('export', '匯出（ONNX q8 或 GGUF）', { implemented: false, blocker: '這台沒有 ONNX 與 GGUF 轉換工具（optimum／llama.cpp）；任何下載都要先回報並由使用者同意' }),
                S('mount', '按需載入（ONNX 執行包）', { implemented: false, blocker: '依賴匯出階段；匯出未實作前不能載入' })
            ]
        }
    };
    const KINDS = Object.keys(PIPELINES);

    function summarizeProduct(manifest) {
        if (!manifest || typeof manifest !== 'object') return null;
        const counts = manifest.counts || {};
        const count = (Number(counts.train) || 0) + (Number(counts.holdout) || 0);
        const files = Object.keys(manifest.sha256 || {}).length;
        const hash = Asset && Asset.manifestHash ? Asset.manifestHash(manifest) : null;
        return { count, files, sha256: hash ? hash.slice(0, 16) : null, kind: manifest.kind || null, name: manifest.name || null };
    }

    // 單一階段狀態推導（純函式）。prevDone：前一個必要階段是否完成（第一階段傳 true）
    function stageState(stage, fact, prevDone) {
        const f = fact || {}, products = Array.isArray(f.products) ? f.products.filter(Boolean) : [];
        const elapsed = typeof f.elapsedMs === 'number' && f.elapsedMs >= 0 ? f.elapsedMs : null;
        if (stage.implemented === false) return { state: '待做', reason: stage.blocker || '尚未實作', products, elapsedMs: elapsed, unimplemented: true };
        if (f.failed) return { state: '失敗', reason: String(f.failed), products, elapsedMs: elapsed };
        const progress = f.progress || null;
        if (f.running) return { state: '進行中', reason: '', products, elapsedMs: elapsed, progress };
        if (f.pausedReason) return { state: '進行中', reason: String(f.pausedReason), products, elapsedMs: elapsed, progress };
        if (f.skipped) return { state: '略過', reason: String(f.skipped), products, elapsedMs: elapsed, progress };
        if (!prevDone) return { state: '待做', reason: '前一個階段還沒完成', products, elapsedMs: elapsed, progress };
        if (products.length && f.done) return { state: '完成', reason: '', products, elapsedMs: elapsed, progress };
        if (f.logDone && !f.done) return { state: '失敗', reason: '日誌寫了 [done]，但沒有 done 標記，不算完成', products, elapsedMs: elapsed, progress };
        if (products.length && !f.done) return { state: '失敗', reason: '有產物但沒有 done 標記，產物不完整，不算完成', products, elapsedMs: elapsed, progress };
        return { state: '待做', reason: '', products, elapsedMs: elapsed, progress };
    }

    // 推導整條流程。回 { kind, label, stages:[{id,label,state,reason,products,elapsedMs,implemented,backends,note,blocker,lookup}] }
    function deriveStageStates(kind, facts) {
        const P = PIPELINES[kind];
        if (!P) return { ok: false, error: 'kind 必須是 ' + KINDS.join('／') + '，收到 ' + JSON.stringify(kind) };
        const st = (facts && facts.stages) || {};
        let prevDone = true; const out = [];
        for (const stage of P.stages) {
            const r = stageState(stage, st[stage.id], prevDone);
            // 略過（按需載入的符號式）與未實作不擋後面；其餘必要階段沒完成則後面待做
            const doneLike = r.state === '完成' || r.state === '略過' || (stage.lookup && r.state !== '失敗');
            out.push(Object.assign({ id: stage.id, label: stage.label, implemented: stage.implemented !== false, backends: stage.backends || null, note: stage.note || null, blocker: stage.blocker || null, lookup: !!stage.lookup }, r));
            if (stage.required !== false) prevDone = prevDone && doneLike;
        }
        return { ok: true, kind, label: P.label, stages: out };
    }

    // 匯出格式預設。env：'web'（網頁版）｜'desktop'（桌面版本機）。caps：{ onnxExport: bool, ggufExport: bool }（工具是否真的可用）
    // 規則：網頁與桌面都優先 ONNX q8；GGUF 只在有 llama.cpp 後端（ggufExport）時才提供，且不會在沒有 ONNX 時搶走預設而不說明。
    function pickExportFormat(env, caps) {
        const c = caps || {}; const e = env === 'web' || env === 'desktop' ? env : null;
        if (!e) return { ok: false, error: 'env 必須是 web 或 desktop，收到 ' + JSON.stringify(env) };
        const options = [
            { format: 'onnx', quant: 'q8', available: !!c.onnxExport, reason: c.onnxExport ? '' : '沒有 ONNX 匯出工具（尚未實作）' },
            { format: 'gguf', quant: 'q8_0', available: !!c.ggufExport, reason: c.ggufExport ? '' : '沒有 llama.cpp 後端（尚未實作）' }
        ];
        const pref = options.find((o) => o.format === 'onnx' && o.available) || options.find((o) => o.available) || null;
        return { ok: true, env: e, default: pref ? pref.format : null, quant: pref ? pref.quant : null, options,
            reason: pref ? '' : '目前沒有任何可用的匯出格式：' + options.map((o) => o.format + '：' + o.reason).join('；') };
    }

    return { STATES, PIPELINES, KINDS, summarizeProduct, stageState, deriveStageStates, pickExportFormat };
}));
