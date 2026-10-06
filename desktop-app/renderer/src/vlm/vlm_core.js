// 離線圖像轉文字（image to text）的純邏輯：模型登記表、裝置與執行緒決策、任務與提示詞、結果整理、模型快取用量。
// 不碰 DOM、不碰 transformers.js（那在 Worker 裡），node 與瀏覽器都能跑；嵌入成 FaVlm（見 scripts/embed-code-ui.js）。
// 模型的檔案大小是 2026-10-06 從 HuggingFace 的檔案清單讀來的（只讀 metadata），實際下載量以 dtype 組合為準。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaVlm = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MB = 1024 * 1024;

    // arch：決定 Worker 用哪一套載入與推論流程（見 faVlmWorkerMain）。
    // dtype：transformers.js 的 dtype 對照（每個子模型一個）；gpu＝WebGPU 用、cpu＝WASM 用。bytes：兩種組合各自的大致下載量（加 tokenizer／config 約 3MB）。
    // verified：這個組合有沒有在真實環境跑通過——false 代表「照官方範例寫的、還沒驗證」，介面會標示。
    const MODELS = [
        { id: 'florence-2-base-ft', gpuNeedsF16: true, label: 'Florence-2 base（推薦：小、快、會 OCR）', task: 'image-to-text', arch: 'florence2', repo: 'onnx-community/Florence-2-base-ft',
            tasks: ['caption', 'detailed', 'ocr', 'objects'], lang: '英文', license: 'MIT',
            dtype: { gpu: { embed_tokens: 'fp16', vision_encoder: 'fp16', encoder_model: 'q4', decoder_model_merged: 'q4' }, cpu: { embed_tokens: 'q8', vision_encoder: 'q4', encoder_model: 'q4', decoder_model_merged: 'q4' } },
            bytes: { gpu: 344 * MB, cpu: 208 * MB }, verified: false, notes: '描述圖片（簡短／詳細）、OCR 文字辨識、物件偵測；沒有自由問答。約 0.23B 參數。' },
        { id: 'smolvlm-256m', gpuNeedsF16: true, label: 'SmolVLM 256M（可以問問題）', task: 'image-to-text', arch: 'vision2seq', repo: 'HuggingFaceTB/SmolVLM-256M-Instruct',
            tasks: ['caption', 'detailed', 'ocr', 'objects', 'ask'], lang: '英文為主', license: 'Apache-2.0',
            dtype: { gpu: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' }, cpu: { embed_tokens: 'q8', vision_encoder: 'q8', decoder_model_merged: 'q4' } },
            bytes: { gpu: 200 * MB, cpu: 203 * MB }, verified: false, notes: '小型對話式視覺模型，可以用提示詞問圖片裡的事；OCR 與細節不如 Florence-2。' },
        { id: 'vit-gpt2', label: 'ViT-GPT2（最簡單的一句話描述）', task: 'image-to-text', arch: 'vit-gpt2', repo: 'Xenova/vit-gpt2-image-captioning',
            tasks: ['caption'], lang: '英文', license: 'Apache-2.0',
            dtype: { gpu: 'q8', cpu: 'q8' }, bytes: { gpu: 238 * MB, cpu: 238 * MB }, verified: false, notes: '只能產生一句短描述，沒有 OCR、不能問問題；最舊也最簡單。' },
        { id: 'paligemma2-3b-224', gpuNeedsF16: true, label: 'PaliGemma 2 3B（大，只能用 GPU）', task: 'image-to-text', arch: 'paligemma', repo: 'onnx-community/paligemma2-3b-pt-224',
            tasks: ['caption', 'detailed', 'ocr', 'ask'], lang: '多語（提示詞英文）', license: 'Gemma',
            dtype: { gpu: { embed_tokens: 'q4f16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' }, cpu: null },
            bytes: { gpu: 2765 * MB, cpu: null }, gpuOnly: true, verified: false, notes: '約 2.7GB，要有 WebGPU 與足夠的顯示記憶體；沒有 GPU 就不能用。預訓練（pt）版本，提示詞要用 PaliGemma 的格式。' },
        { id: 'llava-interleave-qwen-0.5b', gpuNeedsF16: true, label: 'LLaVA-Interleave Qwen 0.5B（實驗，社群轉檔）', task: 'image-to-text', arch: 'llava', repo: 'luisresende13/llava-interleave-qwen-0.5b-hf', processorRepo: 'llava-hf/llava-interleave-qwen-0.5b-hf',
            tasks: ['caption', 'detailed', 'ocr', 'objects', 'ask'], lang: '英文與中文', license: 'Tongyi Qianwen Research',
            dtype: { gpu: { embed_tokens: 'q4f16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' }, cpu: { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' } },
            bytes: { gpu: 780 * MB, cpu: 695 * MB }, experimental: true, verified: false, notes: '沒有官方的瀏覽器版（transformers.js）轉檔，模型是社群轉出的 ONNX（luisresende13，該 repo 缺 processor_config.json），所以處理器與分詞器改從原版 llava-hf/llava-interleave-qwen-0.5b-hf 載入（多下載幾 MB）；能不能跑要看函式庫是否支援 llava 架構，載入失敗會直接回報。約 0.7～0.8GB（q4 量化）。' },
        // 管理用（不能拿來做圖像轉文字）：語音轉文字 Whisper，跟這裡共用同一個瀏覽器快取
        { id: 'whisper-base', label: 'Whisper base（語音轉文字，transcribe_media 用）', task: 'asr', arch: 'whisper', repo: 'onnx-community/whisper-base', tasks: [], bytes: { gpu: 80 * MB, cpu: 80 * MB }, managedOnly: true, verified: true, notes: '影音轉逐字稿用，跟圖像轉文字共用快取與裝置設定。' },
    ];
    const byId = (id) => MODELS.find((m) => m.id === id) || null;
    const imageModels = () => MODELS.filter((m) => m.task === 'image-to-text');
    const DEFAULT_MODEL = 'florence-2-base-ft';

    // ---------- 裝置與執行緒 ----------
    // preference：'gpu'（偏好 GPU，不支援就降級 CPU）或 'cpu'；gpuAvailable：這個環境偵測到 WebGPU。
    // 回傳 { order:['webgpu','wasm'] | ['wasm'] | [], reason, error? }：order 是「依序嘗試」的裝置；任何一個失敗都會往後降級，最後一個是 CPU。
    // f16：WebGPU 介面卡是否支援 shader-f16；undefined 當成支援（沒有偵測資訊時不擋）。GPU 版本用到 fp16／q4f16 的模型（gpuNeedsF16）在不支援時不走 GPU。
    function resolveDevice(model, preference, gpuAvailable, f16) {
        const wantGpu = preference !== 'cpu';
        if (gpuAvailable && f16 === false && model && model.gpuNeedsF16) {
            if (model.gpuOnly) return { order: [], reason: '這個模型的 GPU 版本需要 fp16 著色器（shader-f16），這張顯示卡不支援，而且它不能用 CPU', error: 'gpu_required' };
            return { order: ['wasm'], reason: '這張顯示卡不支援 fp16 著色器（shader-f16），這個模型的 GPU 版本用不了，改用 CPU' };
        }
        if (model && model.gpuOnly) {
            if (!gpuAvailable) return { order: [], reason: '這個模型只能用 GPU（WebGPU），但是這個環境沒有偵測到 WebGPU', error: 'gpu_required' };
            if (!wantGpu) return { order: ['webgpu'], reason: '你偏好 CPU，但這個模型只能用 GPU，所以仍然用 GPU' };
            return { order: ['webgpu'], reason: '這個模型只能用 GPU' };
        }
        if (wantGpu && gpuAvailable) return { order: ['webgpu', 'wasm'], reason: '偏好 GPU 且偵測到 WebGPU；GPU 失敗會自動降級成 CPU' };
        if (wantGpu && !gpuAvailable) return { order: ['wasm'], reason: '偏好 GPU，但這個環境沒有偵測到 WebGPU，降級成 CPU' };
        return { order: ['wasm'], reason: '偏好 CPU' };
    }
    // maxCores：使用者設定的 CPU 核心上限（0／空＝不限制，用偵測到的全部）；hardware：navigator.hardwareConcurrency；
    // canThread：這個環境能不能多執行緒——onnxruntime-web 自己檢查的三件事：SharedArrayBuffer 存在、能傳給 Worker、WebAssembly 執行緒指令可驗證通過
    // （**不是**非要 crossOriginIsolated：Electron 桌面版開了 SharedArrayBuffer 旗標，頁面不是 cross-origin isolated 也一樣能多執行緒）；reason：不能時的原因。
    function resolveThreads(maxCores, hardware, canThread, reason) {
        const isolated = canThread;
        const hw = Math.max(1, Math.floor(Number(hardware) || 1));
        const want = Number(maxCores) > 0 ? Math.min(hw, Math.floor(Number(maxCores))) : hw;
        const requested = Math.max(1, want);
        return { requested, effective: isolated ? requested : 1, hardware: hw, isolated: !!isolated, note: isolated ? '' : (reason || '這個環境不能多執行緒（沒有可用的 SharedArrayBuffer）') + '，CPU 路徑實際只會用 1 個執行緒；設定的核心數在能多執行緒的環境才會生效。' };
    }

    // ---------- 任務與提示詞 ----------
    const TASKS = { caption: '簡短描述', detailed: '詳細描述', ocr: '辨識文字（OCR）', objects: '列出物件', ask: '問問題（自訂提示詞）' };
    const FLORENCE_TOKEN = { caption: '<CAPTION>', detailed: '<MORE_DETAILED_CAPTION>', ocr: '<OCR>', objects: '<OD>' };
    const CHAT_PROMPT = { caption: 'Describe this image briefly.', detailed: 'Describe this image in detail.', ocr: 'Transcribe all the text in this image exactly as written. If there is no text, say so.', objects: 'List the main objects in this image.' };
    const PALI_PROMPT = { caption: 'caption en', detailed: 'describe en', ocr: 'ocr' };
    // 回傳 { task（實際用的任務）, prompt, note? }；模型不支援的任務會退回最接近的，並在 note 說明
    function buildTask(model, task, prompt) {
        task = TASKS[task] ? task : 'caption'; const note = [];
        if (model.arch === 'florence2' && task === 'ask') { task = 'detailed'; note.push('Florence-2 不能自由問答，改用「詳細描述」（問題沒有被使用）'); }
        if (!model.tasks.includes(task)) { note.push('這個模型不支援「' + TASKS[task] + '」，改用「簡短描述」'); task = 'caption'; }
        if (model.arch === 'florence2') {
            return { task, prompt: FLORENCE_TOKEN[task], note: note.join('；') || undefined };
        }
        if (model.arch === 'paligemma') {
            if (task === 'ask') return { task, prompt: 'answer en ' + String(prompt || 'what is in this image?').trim(), note: note.join('；') || undefined };
            return { task, prompt: PALI_PROMPT[task] || 'caption en', note: note.join('；') || undefined };
        }
        if (model.arch === 'vit-gpt2') return { task: 'caption', prompt: '', note: note.join('；') || undefined };
        if (task === 'ask') return { task, prompt: String(prompt || '').trim() || CHAT_PROMPT.detailed, note: note.join('；') || undefined };
        return { task, prompt: CHAT_PROMPT[task], note: note.join('；') || undefined };
    }
    // 把 Worker 回傳的原始結果整理成文字。Florence-2 的結果是 { '<TASK>': 文字 | {bboxes, labels, quad_boxes} }
    function formatResult(model, raw, task) {
        if (raw == null) return '';
        if (model.arch !== 'florence2') return String(raw).replace(/^\s+|\s+$/g, '');
        const v = typeof raw === 'object' ? Object.values(raw)[0] : raw;
        if (typeof v === 'string') return v.replace(/<[^>]+>/g, '').trim();
        if (v && Array.isArray(v.labels) && (Array.isArray(v.bboxes) || Array.isArray(v.quad_boxes))) {
            const boxes = v.bboxes || v.quad_boxes; const rows = v.labels.map((l, i) => { const b = (boxes[i] || []).map((n) => Math.round(Number(n))); return (String(l).replace(/<[^>]+>/g, '').trim() || '(未命名)') + (b.length ? ' @[' + b.join(',') + ']' : ''); });
            return task === 'ocr' ? rows.join('\n') : rows.join('\n');
        }
        return JSON.stringify(v);
    }


    // ---------- 抽象層：自然語言提示詞 → 任務 → 各模型自己的提示詞格式 ----------
    // 呼叫端（Python 腳本、interpret_image、任何工具）只給一般的自然語言提示詞（中文或英文都行）；
    // 「這是 OCR、描述還是問問題」與「Florence-2 要 <OCR>、PaliGemma 要 ocr、對話式模型要完整句子」都在這一層解決，呼叫端不用管模型的格式。
    function inferTask(text) {
        const s = String(text == null ? '' : text).trim(); if (!s) return { task: 'detailed' };
        if (/\b(ocr|transcrib\w*|extract(?:ed)?\s+(?:the\s+)?text|read\s+(?:out\s+)?(?:all\s+)?(?:the\s+)?text|what\s+(?:does|do)\s+(?:it|this|the\s+text)\s+say|text\s+(?:in|on|from)\s+(?:the\s+|this\s+)?(?:image|picture|photo|screenshot))\b|辨識.{0,4}文字|圖.{0,3}(?:裡|中|上)?的?文字|文字(?:辨識|內容|轉錄|擷取)|讀出|轉錄|擷取文字|寫了什麼|寫什麼/i.test(s)) return { task: 'ocr' };
        if (/\b(?:list|detect|identify|enumerate)\b.{0,24}\b(?:objects?|items?|things)\b|bounding\s*box|\bwhat\s+objects\b|物件偵測|偵測物件|列出.{0,6}(?:物件|東西|物品)|有哪些(?:東西|物件|物品)/i.test(s)) return { task: 'objects' };
        if (/\b(?:brief(?:ly)?|short(?:ly)?|one[\s-]sentence|in\s+a\s+sentence|caption)\b|簡短|一句話|簡單(?:描述|說明)|標題/i.test(s)) return { task: 'caption' };
        if (/\b(?:describe|description|explain\s+(?:this|the)\s+(?:image|picture|photo)|what(?:'s|\s+is)\s+in|tell\s+me\s+about|analy[sz]e)\b|描述|說明這|解釋這|解析|分析|看看|有什麼|是什麼/i.test(s)) return { task: 'detailed' };
        if (/[?？]\s*$/.test(s) || /^(?:what|who|where|when|why|how|which|is|are|was|were|does|do|did|can|could|count|how\s+many)\b/i.test(s) || /(?:幾|多少|是不是|是否|有沒有|為什麼|誰|哪|嗎|呢)/.test(s)) return { task: 'ask', question: s };
        return s.length > 12 ? { task: 'ask', question: s } : { task: 'detailed' };
    }
    // 挑模型：偏好的（設定裡的預設）能做這個任務就用它；不能時，改用「已經下載」而且能做的；都沒有就用偏好的並降級任務（buildTask 會說明）。
    // installed：{模型id: 已下載位元組}；gpu：{available, f16}（只能用 GPU 的模型在沒有 GPU 時不考慮）。回傳 { model, reason }
    function pickModel(task, installed, preferredId, gpu) {
        installed = installed || {}; const ok = (m) => !m.managedOnly && m.tasks.includes(task) && !(m.gpuOnly && !(gpu && gpu.available && gpu.f16 !== false));
        const pref = byId(preferredId) && !byId(preferredId).managedOnly ? byId(preferredId) : byId(DEFAULT_MODEL);
        if (ok(pref)) return { model: pref, reason: '預設模型支援這個任務' };
        const have = imageModels().filter((m) => ok(m) && (installed[m.id] || 0) > 0);
        if (have.length) return { model: have[0], reason: '預設模型（' + pref.id + '）不支援「' + (TASKS[task] || task) + '」，改用已下載的 ' + have[0].id };
        return { model: pref, reason: '沒有已下載的模型支援「' + (TASKS[task] || task) + '」，用預設模型並降級任務' };
    }
    // 圖片理解的後端優先順序（設定 visionBackendPolicy）
    const VISION_POLICIES = {
        'llm-first': { label: '線上視覺模型優先，失敗退離線模型', order: ['llm', 'offline'] },
        'offline-first': { label: '離線模型優先，失敗退線上視覺模型', order: ['offline', 'llm'] },
        'llm': { label: '只用線上視覺模型', order: ['llm'] },
        'offline': { label: '只用離線模型', order: ['offline'] },
    };
    const visionOrder = (policy) => (VISION_POLICIES[policy] || VISION_POLICIES['llm-first']).order.slice();

    // ---------- 模型快取用量（Cache API 裡的檔案）----------
    // entries：[{url, size}]（transformers.js 把下載的檔案以 URL 為鍵存在 Cache API；URL 形如 https://huggingface.co/<owner>/<name>/resolve/<rev>/<path>）
    function repoOfUrl(url) { const m = /^https?:\/\/[^/]*huggingface\.co\/([^/]+\/[^/]+)\/resolve\//i.exec(String(url || '')); return m ? m[1].toLowerCase() : null; }
    // 回傳 { byModel:{id:{bytes,files}}, other:{bytes,files, repos:[repo]}, total:{bytes,files} }
    function usageByModel(entries, models) {
        models = models || MODELS; const out = { byModel: {}, other: { bytes: 0, files: 0, repos: [] }, total: { bytes: 0, files: 0 } };
        const repoMap = new Map(models.map((m) => [m.repo.toLowerCase(), m.id])); models.forEach((m) => { out.byModel[m.id] = { bytes: 0, files: 0 }; });
        const others = new Set();
        for (const e of entries || []) {
            const size = Number(e.size) || 0; const repo = repoOfUrl(e.url); out.total.bytes += size; out.total.files++;
            const id = repo && repoMap.get(repo);
            if (id) { out.byModel[id].bytes += size; out.byModel[id].files++; } else { out.other.bytes += size; out.other.files++; if (repo) others.add(repo); }
        }
        out.other.repos = Array.from(others).sort(); return out;
    }
    // 某個模型在快取裡的檔案網址（刪除用）
    function urlsOfModel(entries, model) { const r = model.repo.toLowerCase(); return (entries || []).filter((e) => repoOfUrl(e.url) === r).map((e) => e.url); }
    function fmtBytes(n) { n = Number(n) || 0; if (n >= 1024 * MB) return (n / (1024 * MB)).toFixed(2) + ' GB'; if (n >= MB) return (n / MB).toFixed(1) + ' MB'; if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'; return n + ' B'; }
    // 估算這次下載量（依裝置組合）；已經在快取裡的部分不用再下載
    function estimateDownload(model, device, cachedBytes) { const total = (model.bytes && model.bytes[device === 'webgpu' ? 'gpu' : 'cpu']) || 0; return Math.max(0, total - (Number(cachedBytes) || 0)); }

    return { MODELS, byId, imageModels, DEFAULT_MODEL, TASKS, inferTask, pickModel, VISION_POLICIES, visionOrder, resolveDevice, resolveThreads, buildTask, formatResult, repoOfUrl, usageByModel, urlsOfModel, fmtBytes, estimateDownload };
});
