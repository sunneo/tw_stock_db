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
            bytes: { gpu: 344 * MB, cpu: 208 * MB }, verified: true, verifiedOn: 'cpu', measured: 'CPU 4 執行緒：簡短描述約 34 秒（含下載與載入）、詳細描述約 21 秒；GPU 路徑在使用者機器上載入成功（推論未量測）', notes: '描述圖片（簡短／詳細）、OCR 文字辨識、物件偵測；沒有自由問答。約 0.23B 參數。小模型，細節會錯（實測把機器人頭上的標誌讀成 B）。' },
        { id: 'smolvlm-256m', gpuNeedsF16: true, label: 'SmolVLM 256M（可以問問題）', task: 'image-to-text', arch: 'vision2seq', repo: 'HuggingFaceTB/SmolVLM-256M-Instruct',
            tasks: ['caption', 'detailed', 'ocr', 'objects', 'ask'], lang: '英文為主', license: 'Apache-2.0',
            dtype: { gpu: { embed_tokens: 'fp16', vision_encoder: 'q4', decoder_model_merged: 'q4' }, cpu: { embed_tokens: 'q8', vision_encoder: 'q8', decoder_model_merged: 'q4' } },
            bytes: { gpu: 200 * MB, cpu: 203 * MB }, verified: false, measured: 'CPU 約 16～38 秒、Intel GPU 約 10 秒；已加重複懲罰，不再卡在迴圈，但細節仍會幻覺（把頭盔笑容讀成數字 3、編出不存在的文字）。只適合快速粗略描述，不要拿來讀字或數東西', notes: '小型對話式視覺模型，可以用提示詞問圖片裡的事；OCR 與細節不如 Florence-2。' },
        { id: 'vit-gpt2', label: 'ViT-GPT2（最簡單的一句話描述）', task: 'image-to-text', arch: 'vit-gpt2', repo: 'Xenova/vit-gpt2-image-captioning',
            tasks: ['caption'], lang: '英文', license: 'Apache-2.0',
            dtype: { gpu: 'q8', cpu: 'q8' }, bytes: { gpu: 238 * MB, cpu: 238 * MB }, verified: true, verifiedOn: 'cpu', measured: 'CPU 4 執行緒：約 2 秒（首次含下載與載入約 16 秒）', notes: '只能產生一句短描述，沒有 OCR、不能問問題；最舊也最簡單，準確度最低（實測把機器人說成「時鐘上的卡通人物」）。' },
        // PaliGemma 2 3B 已從清單移除（2026-10-06）：使用者機器上載入失敗「operation does not support unaligned accesses」，無法驗證。Worker／buildTask 裡的 paligemma 分支保留，之後有可行的轉檔再加回來。
        { id: 'llava-interleave-qwen-0.5b', gpuNeedsF16: true, label: 'LLaVA-Interleave Qwen 0.5B（實驗，社群轉檔）', task: 'image-to-text', arch: 'llava', repo: 'luisresende13/llava-interleave-qwen-0.5b-hf', processorRepo: 'llava-hf/llava-interleave-qwen-0.5b-hf',
            tasks: ['caption', 'detailed', 'ocr', 'objects', 'ask'], lang: '英文與中文', license: 'Tongyi Qianwen Research',
            dtype: { gpu: { embed_tokens: 'q4f16', vision_encoder: 'q4f16', decoder_model_merged: 'q4f16' }, cpu: { embed_tokens: 'q8', vision_encoder: 'q4', decoder_model_merged: 'q4' } },
            bytes: { gpu: 780 * MB, cpu: 695 * MB }, experimental: true, verified: true, verifiedOn: 'cpu+gpu', measured: 'CPU 4 執行緒約 140～150 秒（很慢）；Intel GPU 約 23 秒；內容是目前實測最準的（藍白機器人、金色硬幣、圓形金邊框）', notes: '沒有官方的瀏覽器版（transformers.js）轉檔，模型是社群轉出的 ONNX（luisresende13，該 repo 缺 processor_config.json），所以處理器與分詞器改從原版 llava-hf/llava-interleave-qwen-0.5b-hf 載入（多下載幾 MB）；能不能跑要看函式庫是否支援 llava 架構，載入失敗會直接回報。約 0.7～0.8GB（q4 量化）。' },
        // ===== 文字生成（聊天）模型：離線訓練器信心不足時接手回答；能參考 RAG 與工具呼叫（Hermes 格式 <tool_call>，Qwen 系列原生支援）=====
        // contextTokens：這個模型每次對話實際給的上下文長度（不是模型的理論上限；瀏覽器記憶體有限，小模型給 4096）。對話歷史、RAG、工具說明的份量都依它按比例縮放（見 textBudget）。
        { id: 'qwen3-0.6b', label: 'Qwen3 0.6B（預設：中文與工具呼叫都不錯）', task: 'text-generation', arch: 'causal-lm', repo: 'onnx-community/Qwen3-0.6B-ONNX',
            tasks: ['chat', 'rag', 'tools'], toolCalling: 'hermes', contextTokens: 4096, lang: '中英文', license: 'Apache-2.0',
            dtype: { gpu: 'q4f16', cpu: 'q8' }, bytes: { gpu: 543 * MB, cpu: 589 * MB }, gpuNeedsF16: true, verified: false, notes: '約 0.6B 參數，中文與英文都能聊，支援工具呼叫與參考資料；有思考模式但這裡關掉（太慢）。' },
        { id: 'qwen2.5-0.5b', label: 'Qwen2.5 0.5B（更小更快）', task: 'text-generation', arch: 'causal-lm', repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
            tasks: ['chat', 'rag', 'tools'], toolCalling: 'hermes', contextTokens: 4096, lang: '中英文', license: 'Apache-2.0',
            dtype: { gpu: 'q4f16', cpu: 'q8' }, bytes: { gpu: 461 * MB, cpu: 488 * MB }, gpuNeedsF16: true, verified: false, notes: '約 0.5B 參數；比 Qwen3 小一點，答得比較淺，工具呼叫比較容易出錯。' },
        { id: 'smollm2-360m', label: 'SmolLM2 360M（最小，英文為主）', task: 'text-generation', arch: 'causal-lm', repo: 'HuggingFaceTB/SmolLM2-360M-Instruct',
            tasks: ['chat', 'rag'], toolCalling: null, contextTokens: 2048, lang: '英文為主', license: 'Apache-2.0',
            dtype: { gpu: 'q4f16', cpu: 'q8' }, bytes: { gpu: 260 * MB, cpu: 348 * MB }, gpuNeedsF16: true, verified: false, notes: '很小，能閒聊與依參考資料回答；中文弱、沒有工具呼叫格式。' },
        { id: 'granite-4.0-350m', label: 'Granite 4.0 350M（小型工具呼叫專長，未驗證）', task: 'text-generation', arch: 'causal-lm', repo: 'onnx-community/granite-4.0-350m-ONNX-web',
            tasks: ['chat', 'rag', 'tools'], toolCalling: 'hermes', contextTokens: 4096, lang: '英文為主（多語）', license: 'Apache-2.0',
            dtype: { gpu: 'q4f16', cpu: 'q4' }, bytes: { gpu: 336 * MB, cpu: 551 * MB }, gpuNeedsF16: true, verified: false, notes: 'IBM 的小模型，官方標榜工具呼叫與指令遵循；很小，適合當「工具階段」的模型，再交給別的模型寫回答。還沒實測。' },
        { id: 'qwen2.5-1.5b', label: 'Qwen2.5 1.5B（較大，建議用 GPU）', task: 'text-generation', arch: 'causal-lm', repo: 'onnx-community/Qwen2.5-1.5B-Instruct',
            tasks: ['chat', 'rag', 'tools'], toolCalling: 'hermes', contextTokens: 8192, lang: '中英文', license: 'Apache-2.0',
            dtype: { gpu: 'q4f16', cpu: 'q8' }, bytes: { gpu: 1165 * MB, cpu: 1506 * MB }, gpuNeedsF16: true, verified: false, notes: '約 1.5B 參數；答得明顯比 0.5B 好，工具呼叫也更穩；CPU 上很慢。' },
        { id: 'qwen3-1.7b', label: 'Qwen3 1.7B（最大，要 GPU 才實用）', task: 'text-generation', arch: 'causal-lm', repo: 'onnx-community/Qwen3-1.7B-ONNX',
            tasks: ['chat', 'rag', 'tools'], toolCalling: 'hermes', contextTokens: 8192, lang: '中英文', license: 'Apache-2.0',
            dtype: { gpu: 'q4f16', cpu: 'q8' }, bytes: { gpu: 1360 * MB, cpu: 1662 * MB }, gpuNeedsF16: true, verified: false, notes: '約 1.7B 參數；這份清單裡品質最好，下載與記憶體需求也最大。' },
        // 管理用（不能拿來做圖像轉文字）：語音轉文字 Whisper，跟這裡共用同一個瀏覽器快取
        { id: 'whisper-base', label: 'Whisper base（語音轉文字，transcribe_media 用）', task: 'asr', arch: 'whisper', repo: 'onnx-community/whisper-base', tasks: [], bytes: { gpu: 80 * MB, cpu: 80 * MB }, managedOnly: true, verified: true, notes: '影音轉逐字稿用，跟圖像轉文字共用快取與裝置設定。' },
    ];
    const byId = (id) => MODELS.find((m) => m.id === id) || null;
    const imageModels = () => MODELS.filter((m) => m.task === 'image-to-text');
    const textModels = () => MODELS.filter((m) => m.task === 'text-generation');
    const DEFAULT_MODEL = 'florence-2-base-ft';          // 圖像（VLM）預設
    const DEFAULT_TEXT_MODEL = 'qwen3-0.6b';             // 文字生成預設（兩種預設分開設定）

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
    // 生成參數（傳給 generate）。實測 SmolVLM 256M 會陷入重複同一句的迴圈 → 對話式模型（vision2seq、llava）在描述類任務加重複懲罰；OCR 不加。
    function generationParams(model, task) {
        if ((model.arch === 'vision2seq' || model.arch === 'llava') && task !== 'ocr') return { repetition_penalty: 1.25, no_repeat_ngram_size: 6 };
        return {};
    }
    // 各任務預設最多產生多少 token（描述不需要寫到上限；太長的輸出多半是在重複）
    function defaultMaxTokens(task) { return task === 'caption' ? 96 : (task === 'ocr' ? 384 : 256); }
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
    // ---------- 文字生成（離線聊天）：預算、組訊息、解析工具呼叫、工具呼叫基準測試 ----------
    // 離線訓練器的信心門檻範圍：0.1～1.0（1.0＝只有「完全一樣的問題」才不進離線模型，幾乎全部交給離線模型）
    const THRESHOLD_MIN = 0.1, THRESHOLD_MAX = 1;
    function clampThreshold(v, dflt) { const n = Number(v); return Number.isFinite(n) && n >= THRESHOLD_MIN && n <= THRESHOLD_MAX ? n : (dflt == null ? 0.45 : dflt); }
    // 離線訓練器沒辦法回答（decision.status === 'unresolved'）而且設定允許 → 交給離線文字模型。缺參數（needs_input）仍由訓練器自己問，因為模型也不會知道缺的網址或路徑。
    function shouldUseOfflineLlm(decision, settings) { return !!decision && decision.status === 'unresolved' && !(settings && settings.offlineLlmFallback === false); }
    // token 估計：中日韓字約 1 字 1 token、其他約 3.5 字元 1 token（不同分詞器有出入，這裡只用來配置預算，保守估）
    function estimateTokens(s) { s = String(s == null ? '' : s); let cjk = 0; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if ((c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0xac00 && c <= 0xd7af)) cjk++; } return Math.ceil(cjk + (s.length - cjk) / 3.5); }
    function trimToTokens(s, tokens) { s = String(s == null ? '' : s); if (s.length > tokens * 4 + 16) s = s.slice(0, tokens * 4 + 16); /* 每個字至少約 0.29 token：再長的一定超過，先切短，避免對很大的文字做昂貴的二分搜尋（主執行緒） */ if (estimateTokens(s) <= tokens) return s; let lo = 0, hi = s.length; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (estimateTokens(s.slice(0, mid)) <= tokens) lo = mid; else hi = mid - 1; } return s.slice(0, lo) + '…'; }
    // 上下文預算（token）：全部依 contextTokens 按比例，不寫死——模型的上下文越大，能帶的歷史與參考資料越多
    function textBudget(model, maxReply) {
        const ctx = Math.max(1024, Number(model && model.contextTokens) || 4096); const reply = Math.min(Math.max(64, Number(maxReply) || 512), Math.floor(ctx / 2));
        const prompt = ctx - reply; const f = (x) => Math.floor(prompt * x);
        return { context: ctx, reply, prompt, system: f(0.12), tools: f(0.18), rag: f(0.25), history: f(0.35), user: f(0.10) };
    }
    // 組出送給模型的訊息：system（含參考資料）＋盡量多的最近對話歷史（從最新往回加，超過預算就丟掉舊的）＋這次的問題
    // opts: { system, history:[{role,content}], rag:[string], user, budget }
    function composeMessages(opts) {
        const b = opts.budget; let sys = String(opts.system || '');
        const rag = (opts.rag || []).map((r) => String(r).replace(/\s+/g, ' ').trim()).filter(Boolean); let ragUsed = 0; const ragParts = [];
        for (const r of rag) { const left = b.rag - ragUsed; if (left < 40) break; const piece = trimToTokens(r, Math.min(left, Math.max(60, Math.floor(b.rag / Math.max(1, Math.min(rag.length, 4)))))); ragParts.push(piece); ragUsed += estimateTokens(piece); }
        if (ragParts.length) sys += '\n\n【參考資料（可能有幫助；沒有相關就忽略，不要硬套）】\n' + ragParts.map((r, i) => (i + 1) + '. ' + r).join('\n');
        const user = trimToTokens(opts.user, b.user + 200);
        const hist = []; let used = 0; const src = (opts.history || []).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
        let dropped = 0;
        for (let i = src.length - 1; i >= 0; i--) { const c = trimToTokens(src[i].content, Math.floor(b.history / 2)); const n = estimateTokens(c) + 4; if (used + n > b.history) { dropped = i + 1; break; } hist.unshift({ role: src[i].role, content: c }); used += n; }
        return { messages: [{ role: 'system', content: sys }].concat(hist, [{ role: 'user', content: user }]), dropped, ragUsed: ragParts.length, historyTokens: used };
    }
    // 生成參數：小模型用低溫度（答得穩），加一點重複懲罰避免迴圈（見 SmolVLM 的教訓）
    function textGenParams(model, opts) { opts = opts || {}; const p = { do_sample: true, temperature: opts.temperature != null ? opts.temperature : 0.4, top_p: 0.9, repetition_penalty: 1.08 }; if (opts.deterministic) { p.do_sample = false; delete p.temperature; delete p.top_p; } return p; }
    // 工具說明縮成模型看得懂又不佔太多上下文：描述截短、參數只留名稱／型別／短描述；整體超過預算就從尾端少放幾個
    function compactToolSpecs(tools, budgetTokens) {
        const out = []; let used = 0;
        for (const t of tools || []) {
            const spec = { type: 'function', function: { name: t.name, description: String(t.description || '').replace(/\s+/g, ' ').slice(0, 140), parameters: { type: 'object', properties: {}, required: (t.parameters && t.parameters.required) || [] } } };
            const props = (t.parameters && t.parameters.properties) || {};
            for (const k of Object.keys(props).slice(0, 8)) spec.function.parameters.properties[k] = { type: props[k].type || 'string', description: String(props[k].description || '').replace(/\s+/g, ' ').slice(0, 60) };
            const n = estimateTokens(JSON.stringify(spec)); if (used + n > budgetTokens) break; out.push(spec); used += n;
        }
        return out;
    }
    // 從模型輸出裡找工具呼叫。標準格式是 <tool_call>{"name":..., "arguments":{...}}</tool_call>（Qwen／Hermes）；
    // 小模型常常漏掉結尾標籤、加 ```json 圍欄，或只吐一段 JSON——都盡量容忍。回傳 { calls:[{name,args}], text（拿掉呼叫後剩下的文字）, format:'tag'|'json'|'none' }
    function parseToolCalls(text) {
        const src = String(text == null ? '' : text); const calls = []; let format = 'none';
        const norm = (o) => { if (!o || typeof o !== 'object' || typeof o.name !== 'string' || !o.name) return null; let a = o.arguments != null ? o.arguments : (o.parameters != null ? o.parameters : o.args); if (typeof a === 'string') { try { a = JSON.parse(a); } catch (_) { a = {}; } } return { name: o.name, args: a && typeof a === 'object' ? a : {} }; };
        const parseJson = (s) => { s = String(s).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''); try { return JSON.parse(s); } catch (_) { const i = s.indexOf('{'), j = s.lastIndexOf('}'); if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_2) {} } return null; } };
        const re = /<tool_call>\s*([\s\S]*?)\s*(?:<\/tool_call>|(?=<tool_call>)|$)/g; let m; let rest = src;
        while ((m = re.exec(src))) { const c = norm(parseJson(m[1])); if (c) { calls.push(c); format = 'tag'; } if (m[0] === '') re.lastIndex++; }
        if (format === 'tag') rest = src.replace(/<tool_call>[\s\S]*?(?:<\/tool_call>|(?=<tool_call>)|$)/g, '');
        else { const trimmed = src.trim(); if (/^(?:```(?:json)?\s*)?\{[\s\S]*"name"[\s\S]*\}(?:\s*```)?$/.test(trimmed)) { const c = norm(parseJson(trimmed)); if (c) { calls.push(c); format = 'json'; rest = ''; } } }
        return { calls, text: rest.replace(/<think>[\s\S]*?<\/think>/g, '').trim(), format };
    }
    // 工具呼叫基準測試：用三個假工具與固定題目，量「選對工具＋參數對」的比例；也量輸出格式合不合（能不能被解析）。
    // 題目刻意包含：中文、英文、該用工具、不該用工具（要能克制）。每題 1 分。
    const BENCH_TOOLS = [
        { name: 'get_weather', description: '查詢城市目前的天氣', parameters: { type: 'object', properties: { city: { type: 'string', description: '城市名稱' } }, required: ['city'] } },
        { name: 'calculator', description: '計算數學算式並回傳結果', parameters: { type: 'object', properties: { expression: { type: 'string', description: '算式，例如 (1+2)*3' } }, required: ['expression'] } },
        { name: 'search_web', description: '上網搜尋資料', parameters: { type: 'object', properties: { query: { type: 'string', description: '搜尋關鍵字' } }, required: ['query'] } },
    ];
    const BENCH_CASES = [
        { id: 'weather_zh', user: '台北現在天氣怎麼樣？', tool: 'get_weather', arg: 'city', match: /台北|taipei/i },
        { id: 'calc_zh', user: '幫我算 (12+8)*3 等於多少', tool: 'calculator', arg: 'expression', match: /12/ },
        { id: 'search_zh', user: '上網查一下 Rust 的 borrow checker 是什麼', tool: 'search_web', arg: 'query', match: /rust|borrow/i },
        { id: 'weather_en', user: "What's the weather in Tokyo right now?", tool: 'get_weather', arg: 'city', match: /tokyo|東京/i },
        { id: 'chat_none', user: '你好，謝謝你的幫忙！', tool: null },
        { id: 'calc_en', user: 'Please compute 7 * 6 + 2 for me.', tool: 'calculator', arg: 'expression', match: /7/ },
    ];
    // 評一題：回傳 { ok, formatOk, reason }。formatOk＝該用工具時輸出能被解析成工具呼叫（或不該用時沒有亂用）
    function scoreToolCase(c, outputText) {
        const r = parseToolCalls(outputText); const first = r.calls[0];
        if (c.tool == null) return r.calls.length === 0 ? { ok: true, formatOk: true, reason: '沒有亂用工具' } : { ok: false, formatOk: true, reason: '不該用工具卻呼叫了 ' + first.name };
        if (!first) return { ok: false, formatOk: false, reason: '沒有輸出可解析的工具呼叫' };
        if (first.name !== c.tool) return { ok: false, formatOk: true, reason: '選錯工具：' + first.name + '（應為 ' + c.tool + '）' };
        const v = first.args && first.args[c.arg]; if (v == null || !c.match.test(String(v))) return { ok: false, formatOk: true, reason: '參數 ' + c.arg + ' 不對：' + JSON.stringify(v) };
        return { ok: true, formatOk: true, reason: '正確' };
    }
    // 把各題結果彙總成可存放與顯示的評級
    function summarizeToolBench(results) {
        const total = results.length; const passed = results.filter((r) => r.ok).length; const formatOk = results.filter((r) => r.formatOk).length;
        const ratio = total ? passed / total : 0; const rating = ratio >= 0.83 ? 'good' : (ratio >= 0.5 ? 'fair' : 'poor');
        return { passed, total, formatOk, rating, label: { good: '可靠', fair: '普通（建議離線模型只在有參考資料時使用工具）', poor: '不可靠（建議不要讓它呼叫工具）' }[rating] };
    }

    // ---------- 離線文字模型的對話迴圈：不調用工具就是單純文字生成；有調用就多輪，但一定會收斂 ----------
    // 要擋的三件事：
    //   1. 無窮迴圈：輪數上限、呼叫總數上限、同一個「工具＋參數」不執行第二次、不存在的工具最多容忍兩次，之後一律強制「不給工具、直接回答」。
    //   2. 垃圾輸出：空白、只有標點、重複同一段（小模型的典型失敗）→ 偵測到就中斷生成，用更保守的參數重試一次，還是不行就誠實回報失敗，不把垃圾丟給使用者。
    //   3. 上下文爆掉：每一輪都重新估算；舊的工具結果換成「placeholder」（只留一小段摘要），再不夠才丟最舊的對話；工具結果太長就先摘要或截短。
    // 這一層是純函式＋注入的 generate／execTool，所以可以用假模型完整測試。
    function looksLikeGarbage(text) {
        const s = String(text == null ? '' : text); let t = s.trim();
        if (!t) return { garbage: true, reason: 'empty' };
        if (t.length > 6000) t = t.slice(0, 3000) + '\n' + t.slice(-3000); // 很長的輸出只看頭尾（正規表示式不要在主執行緒上跑太久）
        if (!/[A-Za-z0-9㐀-鿿぀-ヿ가-힯]/.test(t)) return { garbage: true, reason: 'no_content' };
        let bad = 0; for (let i = 0; i < t.length; i++) if (t.charCodeAt(i) === 0xfffd) bad++;
        if (t.length >= 8 && bad / t.length > 0.02) return { garbage: true, reason: 'broken_chars' };
        if (/(.{6,80}?)\1{3,}/s.test(t)) return { garbage: true, reason: 'repeat' };       // 同一段 6～80 字連續出現 4 次以上
        const sm = /(.{1,5}?){11,}/s.exec(t); if (sm && (/[A-Za-z0-9㐀-鿿]/.test(sm[1]) || sm[0].length >= 60)) return { garbage: true, reason: 'repeat' }; // 很短的單位重複 12 次以上（「哈哈哈哈…」）；純符號（markdown 分隔線）要更長才算
        const lines = t.split(/\n+/).map((x) => x.trim()).filter(Boolean);
        if (lines.length >= 6 && new Set(lines).size / lines.length < 0.4) return { garbage: true, reason: 'repeat_lines' };
        return { garbage: false };
    }
    // 把舊的工具結果換成 placeholder：只留名稱與前面一小段，其他省略
    function placeholderOf(msg, keep) { const body = String(msg.content || '').replace(/\s+/g, ' ').trim(); return { role: 'tool', name: msg.name, content: '[' + (msg.name || '工具') + ' 的結果已省略；摘要：' + body.slice(0, keep == null ? 60 : keep) + (body.length > (keep == null ? 60 : keep) ? '…' : '') + ']', _placeholder: true }; }
    function messagesTokens(messages, tools) { let n = 0; for (const m of messages) n += estimateTokens(m.content) + 6; if (tools && tools.length) n += estimateTokens(JSON.stringify(tools)); return n; }
    // 讓訊息放得進預算：①舊的工具結果（最新一則以外）換 placeholder ②最新的工具結果截短 ③丟最舊的對話歷史（留 system、最後的 user 與這一輪的工具往返）。回傳 { messages, changed:[…] }
    function fitMessages(messages, tools, limit) {
        let msgs = messages.map((m) => Object.assign({}, m)); const changed = [];
        if (messagesTokens(msgs, tools) <= limit) return { messages: msgs, changed };
        const toolIdx = msgs.map((m, i) => (m.role === 'tool' && !m._placeholder ? i : -1)).filter((i) => i >= 0);
        for (const i of toolIdx.slice(0, -1)) { msgs[i] = placeholderOf(msgs[i]); changed.push('舊工具結果換成 placeholder'); if (messagesTokens(msgs, tools) <= limit) return { messages: msgs, changed }; }
        const last = toolIdx[toolIdx.length - 1];
        if (last != null) { const room = Math.max(80, limit - (messagesTokens(msgs, tools) - estimateTokens(msgs[last].content))); msgs[last] = Object.assign({}, msgs[last], { content: trimToTokens(msgs[last].content, Math.floor(room * 0.8)) }); changed.push('最新工具結果截短'); if (messagesTokens(msgs, tools) <= limit) return { messages: msgs, changed }; }
        let dropped = 0; // 最舊的先丟；system（第 0 則）與標了 _keep 的（這次的問題、強制回答的提示）不丟
        while (messagesTokens(msgs, tools) > limit - 24) { const k = msgs.findIndex((m, i) => i > 0 && !m._keep); if (k < 0) break; msgs.splice(k, 1); dropped++; }
        if (dropped) { msgs.splice(1, 0, { role: 'system', content: '（較早的 ' + dropped + ' 則對話為了節省上下文已省略）' }); changed.push('丟掉最舊的 ' + dropped + ' 則對話'); }
        return { messages: msgs, changed, overflow: messagesTokens(msgs, tools) > limit };
    }
    // opts: { messages, tools:[spec], toolNames:Set（可呼叫的工具名稱）, budget（textBudget）, generate: async({messages,tools,strict,maxTokens}) → string, execTool: async({name,args}) → {ok,text},
    //         summarize?: async(text, maxTokens) → string, maxRounds=4, maxCalls=6, maxCallsPerRound=3, onEvent?: (e) → void }
    // 回傳 { ok, text, reason:'answer'|'forced'|'garbage'|'empty'|'exhausted', rounds, calls:[{name,args,ok,skipped?}], notes:[…] }
    async function runAgentLoop(opts) {
        const b = opts.budget; const maxRounds = opts.maxRounds || 4, maxCalls = opts.maxCalls || 6, perRound = opts.maxCallsPerRound || 3;
        const emit = (e) => { if (opts.onEvent) try { opts.onEvent(e); } catch (_) {} };
        let messages = opts.messages.map((m) => Object.assign({}, m)); for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user') { messages[i]._keep = true; break; }
        let tools = (opts.tools || []).slice(); const names = opts.toolNames || new Set(tools.map((t) => t.function.name));
        const calls = []; const seen = new Set(); const notes = []; let invalid = 0; const hasResults = () => calls.some((c) => c.ok && c.text); const handoff = (round) => ({ ok: true, text: '', reason: 'handoff', handoff: true, rounds: round, calls, notes }); let forceFinal = tools.length === 0; let garbageRetried = false;
        const finishFrom = (text, reason, rounds) => ({ ok: true, text, reason, rounds, calls, notes });
        for (let round = 1; round <= maxRounds + 1; round++) {
            if (opts.handoff && (forceFinal || round > maxRounds) && hasResults()) return handoff(round - 1); // 要強制收尾了：有工具結果就交給寫回答的模型
            const useTools = !forceFinal && round <= maxRounds ? tools : [];
            const fit = fitMessages(messages, useTools, b.prompt - 16); fit.changed.forEach((c) => { if (notes.indexOf(c) < 0) notes.push(c); });
            if (fit.overflow) { notes.push('上下文放不下'); return { ok: false, text: '', reason: 'context_full', rounds: round, calls, notes }; }
            messages = fit.messages;
            let text = await opts.generate({ messages, tools: useTools, strict: false, maxTokens: b.reply });
            let g = looksLikeGarbage(text);
            if (g.garbage) {
                emit({ type: 'garbage', reason: g.reason, round });
                if (!garbageRetried) { garbageRetried = true; notes.push('輸出是垃圾（' + g.reason + '），用保守參數重試'); text = await opts.generate({ messages, tools: [], strict: true, maxTokens: Math.min(b.reply, 256) }); g = looksLikeGarbage(text); forceFinal = true; }
                if (g.garbage) { // 還是垃圾：有工具結果就老實列出，不然回報失敗
                    const results = calls.filter((c) => c.ok && c.text); if (results.length) return { ok: true, text: '（模型沒能整理出像樣的回答，以下是工具回傳的原始結果）\n' + results.map((c) => '【' + c.name + '】' + String(c.text).slice(0, 600)).join('\n'), reason: 'garbage', rounds: round, calls, notes };
                    return { ok: false, text: '', reason: g.reason === 'empty' ? 'empty' : 'garbage', rounds: round, calls, notes };
                }
            }
            const pc = parseToolCalls(text);
            if (opts.handoff && !pc.calls.length && hasResults()) return handoff(round);
            if (pc.calls.length && !useTools.length) { notes.push('工具已收回，模型還在輸出工具呼叫'); break; } // 不給工具了還在呼叫＝沒有收斂，走下面的收尾
            if (!pc.calls.length || !useTools.length) return Object.assign(finishFrom(pc.text || String(text).replace(/<\/?tool_call>/g, '').trim(), forceFinal && calls.length ? 'forced' : 'answer', round), { plain: !calls.length });
            messages.push({ role: 'assistant', content: text });
            let did = 0;
            for (const c of pc.calls.slice(0, perRound)) {
                const key = c.name + ' ' + JSON.stringify(c.args || {}); const rec = { name: c.name, args: c.args };
                if (!names.has(c.name)) { invalid++; rec.ok = false; rec.skipped = '沒有這個工具'; calls.push(rec); messages.push({ role: 'tool', name: c.name, content: '沒有名為 ' + c.name + ' 的工具。可用工具：' + Array.from(names).join('、') + '。如果不需要工具，請直接回答。' }); emit({ type: 'invalid_tool', name: c.name }); continue; }
                if (seen.has(key)) { rec.ok = false; rec.skipped = '重複呼叫'; calls.push(rec); messages.push({ role: 'tool', name: c.name, content: '你已經用同樣的參數呼叫過 ' + c.name + '，結果就在上面。請直接用它回答，不要再重複呼叫。' }); forceFinal = true; emit({ type: 'duplicate_call', name: c.name }); continue; }
                if (calls.filter((x) => !x.skipped).length >= maxCalls) { rec.ok = false; rec.skipped = '呼叫次數已達上限'; calls.push(rec); forceFinal = true; continue; }
                seen.add(key); emit({ type: 'tool_start', name: c.name, args: c.args });
                let r; try { r = await opts.execTool({ name: c.name, args: c.args || {} }); } catch (e) { r = { ok: false, text: String((e && e.message) || e) }; }
                let body = String((r && r.text) == null ? '' : r.text); const limit = Math.max(120, Math.floor(b.rag * 0.8));
                if (estimateTokens(body) > limit) { let s = null; if (opts.summarize) { try { s = await opts.summarize(body, Math.floor(limit / 2)); } catch (_) { s = null; } } body = s && !looksLikeGarbage(s).garbage ? '（內容太長，摘要如下）' + trimToTokens(s, limit) : trimToTokens(body, limit); notes.push('工具 ' + c.name + ' 的結果太長，已' + (s ? '摘要' : '截短')); }
                rec.ok = !!(r && r.ok); rec.text = body; calls.push(rec); did++;
                messages.push({ role: 'tool', name: c.name, content: (r && r.ok ? '' : '（執行失敗）') + body });
                emit({ type: 'tool_done', name: c.name, ok: rec.ok });
            }
            if (invalid >= 2) forceFinal = true;
            if (!did && !forceFinal) forceFinal = true; // 這一輪沒有任何有效呼叫：不要再給機會
            if (forceFinal) messages.push({ role: 'user', content: '請根據上面的資訊直接回答我的問題，不要再呼叫工具。', _keep: true });
        }
        if (opts.handoff && hasResults()) return handoff(maxRounds);
        // 輪數用完還沒收斂：有工具結果就列出，不然回報
        const results = calls.filter((c) => c.ok && c.text);
        if (results.length) return { ok: true, text: '（沒能整理出完整回答，以下是工具的結果）\n' + results.map((c) => '【' + c.name + '】' + String(c.text).slice(0, 600)).join('\n'), reason: 'exhausted', rounds: maxRounds, calls, notes };
        return { ok: false, text: '', reason: 'exhausted', rounds: maxRounds, calls, notes };
    }

    // ---------- 混用多個模型（模仿 MoE 的「分工」）：工具呼叫由一個模型處理，處理完交給專門寫文字的模型 ----------
    // 一張 GPU 放不下全部模型，所以不是同時載入，而是「依階段輪流載入」：階段一（工具）→ 卸載 → 階段二（寫回答）。換模型的代價是重新載入（檔案已在快取，約數秒）。
    // 每個模型有自己的「角色標記」與「優先順序」：tools（呼叫工具）、answer（寫最後的回答）、summarize（摘要過長的內容）；同一個角色有多個候選時，優先順序大的先用。
    // 工具角色另外看基準測試：測過、評為「可靠／普通」的才信任；沒測過的只在沒有已測過的候選時才用；評為「不可靠」或根本沒有工具呼叫格式的不會被選去呼叫工具。
    function roleConfig(model, cfg, defaultId) {
        const c = (cfg && cfg[model.id]) || {};
        const canTools = !!model.toolCalling;
        return { tools: c.tools != null ? !!c.tools && canTools : canTools, answer: c.answer != null ? !!c.answer : true, summarize: c.summarize != null ? !!c.summarize : true, priority: Number.isFinite(Number(c.priority)) ? Number(c.priority) : (model.id === defaultId ? 50 : 10) };
    }
    // 工具信任度：'trusted'（基準測試可靠／普通）、'untested'（有格式但沒測過）、'no'（沒有格式，或測出不可靠）
    function toolsTrust(model, bench) {
        if (!model || !model.toolCalling) return 'no';
        const b = bench && bench[model.id]; if (!b) return 'untested';
        return b.rating === 'poor' ? 'no' : 'trusted';
    }
    // opts: { config（每個模型的角色標記與優先順序）, bench（基準測試結果）, installed:Set（已下載的模型 id）, requireInstalled（沒下載的不選，除非全都沒下載）, defaultId, hasTools }
    // 回傳 { tools, answer, summarize, mixed, stages:[{role, model}], reasons:[…] }
    function routeStages(opts) {
        const models = textModels(); const defaultId = opts.defaultId || DEFAULT_TEXT_MODEL; const inst = opts.installed || new Set(); const reasons = [];
        const rc = (m) => roleConfig(m, opts.config, defaultId);
        const pick = (role) => {
            let c = models.filter((m) => rc(m)[role]);
            if (role === 'tools') c = c.filter((m) => toolsTrust(m, opts.bench) !== 'no');
            if (opts.requireInstalled && c.some((m) => inst.has(m.id))) c = c.filter((m) => inst.has(m.id));
            const tier = (m) => (role === 'tools' ? (toolsTrust(m, opts.bench) === 'trusted' ? 0 : 1) : 0);
            c.sort((a, b) => tier(a) - tier(b) || rc(b).priority - rc(a).priority || (b.id === defaultId) - (a.id === defaultId) || ((a.bytes && a.bytes.gpu) || 0) - ((b.bytes && b.bytes.gpu) || 0));
            return c[0] || null;
        };
        let tools = opts.hasTools ? pick('tools') : null; let answer = pick('answer') || (tools || null); const summarize = pick('summarize') || answer;
        if (opts.hasTools && !tools) reasons.push('沒有可以呼叫工具的離線模型（沒勾角色、格式不支援，或基準測試評為不可靠），這次不給工具，單純文字生成');
        if (!answer) answer = byId(defaultId);
        if (tools && toolsTrust(tools, opts.bench) === 'untested') reasons.push('工具模型「' + tools.id + '」還沒做過基準測試，工具呼叫能不能用未知（建議到離線模型管理按「測試工具呼叫」）');
        const mixed = !!(tools && answer && tools.id !== answer.id);
        const stages = []; if (tools) stages.push({ role: 'tools', model: tools }); if (!tools || mixed) stages.push({ role: 'answer', model: answer }); else stages[0].role = 'tools+answer';
        return { tools, answer, summarize, mixed, stages, reasons };
    }
    // 把工具結果整理成給「寫回答的模型」看的參考資料（它自己不呼叫工具，只看結果）
    function toolResultsAsReferences(calls) {
        return (calls || []).filter((c) => c.ok && c.text).map((c) => '工具 ' + c.name + (c.args && Object.keys(c.args).length ? '（' + JSON.stringify(c.args).slice(0, 120) + '）' : '') + ' 的結果：' + String(c.text));
    }

    function fmtBytes(n) { n = Number(n) || 0; if (n >= 1024 * MB) return (n / (1024 * MB)).toFixed(2) + ' GB'; if (n >= MB) return (n / MB).toFixed(1) + ' MB'; if (n >= 1024) return (n / 1024).toFixed(0) + ' KB'; return n + ' B'; }
    // 估算這次下載量（依裝置組合）；已經在快取裡的部分不用再下載
    function estimateDownload(model, device, cachedBytes) { const total = (model.bytes && model.bytes[device === 'webgpu' ? 'gpu' : 'cpu']) || 0; return Math.max(0, total - (Number(cachedBytes) || 0)); }

    return { MODELS, byId, imageModels, textModels, DEFAULT_MODEL, DEFAULT_TEXT_MODEL, THRESHOLD_MIN, THRESHOLD_MAX, clampThreshold, shouldUseOfflineLlm, estimateTokens, trimToTokens, textBudget, composeMessages, textGenParams, compactToolSpecs, parseToolCalls, roleConfig, toolsTrust, routeStages, toolResultsAsReferences, looksLikeGarbage, fitMessages, runAgentLoop, placeholderOf, BENCH_TOOLS, BENCH_CASES, scoreToolCase, summarizeToolBench, TASKS, generationParams, defaultMaxTokens, inferTask, pickModel, VISION_POLICIES, visionOrder, resolveDevice, resolveThreads, buildTask, formatResult, repoOfUrl, usageByModel, urlsOfModel, fmtBytes, estimateDownload };
});
