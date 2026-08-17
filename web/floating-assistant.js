// ============================================================
// 這是外部通用函式庫（原始檔案：ref-web-ai/floating-assistant.js），
// 給任何網頁掛載一個可mount/可浮動的AI聊天widget，支援tool-calling、
// RAG、自訂工具編輯器。tw_stock_db專案在這份副本上做了幾處客製擴充，
// 每處都有明確標記「tw_stock_db客製」，方便日後對照/同步上游新版：
//   1. _renderMessageHistory()：tool結果若是 {type:'image', dataUrl}
//      的JSON，額外渲染<img>（持股走勢圖截圖用）。
//   2. 原生 tool/function call 偵測與切換（NATIVE_TOOLCALL_MODEL_PATTERNS、
//      _shouldUseNativeToolCalls、_buildNativeToolsSchema、executeChat
//      的原生路徑分支）。
//   3. .skill (zip) 匯入/匯出（_importSkillZip/_exportSkillZip，需要
//      JSZip；只有使用者實際按下匯入/匯出按鈕時才動態注入CDN script
//      標籤，見 _ensureJSZipLoaded()，不使用這功能的人不用背這個依賴）。
//   4. 淺色/深色主題偵測改讀 <html data-theme>（_isLightTheme()、主題
//      MutationObserver），跟這個專案實際的主題切換機制對齊（原始函式庫
//      預設看 body 的 'light-theme' class，這個網頁從來不會加這個class）。
// ============================================================

// ============================================================
// SimpleEmbeddingEngine — 免LLM微向量嵌入引擎 (TF-IDF based)
// ============================================================
class SimpleEmbeddingEngine {
    constructor() {
        this.idf = new Map();
        this.docCount = 0;
    }

    // 內建分詞器，支援中英文與日文
    tokenize(text) {
        return String(text || '')
            .toLowerCase()
            .replace(/[^\w\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff]/g, ' ')
            .split(/\s+/)
            .filter(t => t.length > 0);
    }

    // 更新全局的逆文檔頻率 (IDF)
    updateIDF(docs) {
        const df = new Map();
        this.docCount = docs.length;
        docs.forEach(doc => {
            const terms = new Set(this.tokenize(doc));
            terms.forEach(t => df.set(t, (df.get(t) || 0) + 1));
        });
        this.idf.clear();
        df.forEach((count, term) => {
            this.idf.set(term, Math.log((this.docCount + 1) / (count + 1)) + 1);
        });
    }

    // 計算文檔的 TF-IDF 稀疏特徵向量
    embed(text) {
        const tokens = this.tokenize(text);
        if (!tokens.length) return {};
        const tf = new Map();
        tokens.forEach(t => tf.set(t, (tf.get(t) || 0) + 1));
        const vec = {};
        tf.forEach((count, term) => {
            const tfi = count / tokens.length;
            const idfi = this.idf.get(term) || Math.log((this.docCount + 1) / 1) + 1;
            vec[term] = tfi * idfi;
        });
        return vec;
    }

    // 餘弦相似度計算
    cosineSimilarity(vec1, vec2) {
        let dot = 0, norm1 = 0, norm2 = 0;
        Object.entries(vec1).forEach(([t, v]) => {
            norm1 += v * v;
            if (Object.prototype.hasOwnProperty.call(vec2, t)) dot += v * vec2[t];
        });
        Object.values(vec2).forEach(v => { norm2 += v * v; });
        return (norm1 && norm2) ? dot / (Math.sqrt(norm1) * Math.sqrt(norm2)) : 0;
    }
}

// ============================================================
// IndexedDBRAGSystem — 具備 LRU 淘汰與有向無環圖 (DAG) 的 Graph-RAG 系統
// ============================================================
class IndexedDBRAGSystem {
    constructor(dbName = 'FloatingAssistantRAG', maxBytes = 50 * 1024 * 1024) { // 預設 50MB 空間限制
        this.dbName = dbName;
        this.storeName = 'rag_records';
        this.maxBytes = maxBytes;
        this.db = null;
        this.engine = new SimpleEmbeddingEngine();
        this._ready = this._init();
    }

    _init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('timestamp', 'timestamp', { unique: false });
                    store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
                }
            };
            req.onsuccess = (e) => { this.db = e.target.result; resolve(this.db); };
            req.onerror = (e) => reject(e.target.error);
        });
    }

    async _tx(mode, fn) {
        await this._ready;
        return new Promise((resolve, reject) => {
            const tx = this.db.transaction(this.storeName, mode);
            const store = tx.objectStore(this.storeName);
            const req = fn(store);
            req.onsuccess = (e) => resolve(e.target.result);
            req.onerror = (e) => reject(e.target.error);
        });
    }

    // 估計單個記錄佔用的 Bytes 大小
    _estimateSize(obj) {
        return new Blob([JSON.stringify(obj)]).size;
    }

    // LRU 容量自動淘汰機制
    async _checkAndPruneLRU(additionalSize = 0) {
        const all = await this.getAll();
        let currentSize = all.reduce((sum, r) => sum + this._estimateSize(r), 0);
        
        if (currentSize + additionalSize <= this.maxBytes) return;

        // 依 lastAccessed 時間從小到大排序（最舊的在前面）
        all.sort((a, b) => {
            const timeA = a.lastAccessed || a.timestamp || 0;
            const timeB = b.lastAccessed || b.timestamp || 0;
            return timeA - timeB;
        });

        let bytesToRemove = (currentSize + additionalSize) - (this.maxBytes * 0.95); // 預留 5% 緩衝
        const idsToDelete = [];

        for (const record of all) {
            if (bytesToRemove <= 0) break;
            const recordSize = this._estimateSize(record);
            bytesToRemove -= recordSize;
            idsToDelete.push(record.id);
        }

        if (idsToDelete.length > 0) {
            await this.deleteMany(idsToDelete);
            console.warn("⚠️ [Hermes LRU 剪枝] 本地空間即將爆滿，自動淘汰了最久未使用的 " + idsToDelete.length + " 筆技能或紀錄！");
        }
    }

    // 儲存/更新圖譜節點
    async add(content, meta = {}) {
        const recordId = meta.id || `node_${Date.now()}_${Math.random().toString(36).substr(2, 4)}`;
        const record = { 
            id: recordId,
            content: String(content || ''), 
            timestamp: Date.now(), 
            lastAccessed: Date.now(),
            dependencies: Array.isArray(meta.dependencies) ? meta.dependencies : [], // 前置依賴節點 ID 清單
            preConditions: Array.isArray(meta.preConditions) ? meta.preConditions : [], // 觸發先決條件
            source: meta.source || 'manual',
            tags: meta.tags || 'skill'
        };
        
        const recordSize = this._estimateSize(record);
        await this._checkAndPruneLRU(recordSize);

        await this._tx('readwrite', s => s.put(record));
        return recordId;
    }

    async get(id) {
        const key = isNaN(Number(id)) ? id : Number(id);
        const record = await this._tx('readonly', s => s.get(key));
        if (record) {
            // 洗新最後讀取時間，幫節點續命
            record.lastAccessed = Date.now();
            await this._tx('readwrite', s => s.put(record));
        }
        return record;
    }

    async update(id, updates) {
        const existing = await this.get(id);
        if (!existing) throw new Error(`Graph Node ${id} not found`);
        const updated = { 
            ...existing, 
            ...updates, 
            lastAccessed: Date.now(), 
            id: existing.id 
        };
        
        const recordSize = this._estimateSize(updated);
        await this._checkAndPruneLRU(recordSize);

        return this._tx('readwrite', s => s.put(updated));
    }

    async delete(id) {
        const key = isNaN(Number(id)) ? id : Number(id);
        return this._tx('readwrite', s => s.delete(key));
    }

    async getAll() {
        return this._tx('readonly', s => s.getAll());
    }

    // 遞迴拉取依賴鏈上的所有前置節點 (Topological Prerequisite chain)
    async _resolveDependencyChain(nodeIds, visited = new Set(), resolved = []) {
        for (const id of nodeIds) {
            if (visited.has(id)) continue;
            visited.add(id);

            const node = await this.get(id);
            if (node) {
                if (node.dependencies && node.dependencies.length > 0) {
                    await this._resolveDependencyChain(node.dependencies, visited, resolved);
                }
                if (!resolved.some(r => r.id === node.id)) {
                    resolved.push(node);
                }
            }
        }
        return resolved;
    }

    // 圖譜檢索主方法：檢索後自動追溯依賴前置鏈
    async query(queryText, topK = 3) {
        const all = await this.getAll();
        if (!all.length) return [];
        this.engine.updateIDF(all.map(r => r.content));
        const qVec = this.engine.embed(queryText);
        
        // 計算相似度並排序
        const scored = all
            .map(r => ({ ...r, score: this.engine.cosineSimilarity(qVec, this.engine.embed(r.content)) }))
            .sort((a, b) => b.score - a.score);

        // 取出高於 10% 相似度的最相關的前 K 個作為直接觸發點
        const triggerNodes = scored.filter(r => r.score >= 0.1).slice(0, topK);
        if (triggerNodes.length === 0) return [];

        const visited = new Set();
        const resolvedChain = [];
        const triggerIds = triggerNodes.map(n => n.id);
        
        // 遞迴尋找前置依賴節點
        await this._resolveDependencyChain(triggerIds, visited, resolvedChain);

        // 回傳依序整理好的推論鏈
        return resolvedChain.map(node => {
            const directMatch = triggerNodes.find(tn => tn.id === node.id);
            return {
                ...node,
                score: directMatch ? directMatch.score : -1, // -1 代表這是背景依賴，不是直接匹配的
                isPrerequisite: !directMatch
            };
        });
    }

    async search(keyword) {
        const all = await this.getAll();
        const kw = String(keyword || '').toLowerCase().trim();
        if (!kw) return all;
        return all.filter(r =>
            String(r.content || '').toLowerCase().includes(kw) ||
            String(r.id || '').toLowerCase().includes(kw) ||
            String(r.tags || '').toLowerCase().includes(kw)
        );
    }

    async clearAll() {
        return this._tx('readwrite', s => s.clear());
    }

    async exportAll() {
        const records = await this.getAll();
        return JSON.stringify({ version: 2, records }, null, 2);
    }

    async importAll(jsonStr, mode = 'merge') {
        let data;
        try { data = JSON.parse(jsonStr); } catch (e) { throw new Error('無效的 JSON 格式'); }
        const records = Array.isArray(data.records) ? data.records : (Array.isArray(data) ? data : []);
        if (mode === 'replace') await this.clearAll();
        const ids = [];
        for (const r of records) {
            const newId = await this.add(r.content || '', {
                id: r.id,
                dependencies: r.dependencies,
                preConditions: r.preConditions,
                source: r.source,
                tags: r.tags
            });
            ids.push(newId);
        }
        return ids;
    }

    async deleteMany(ids) {
        await Promise.all(ids.map(id => this.delete(id)));
    }
}

// tw_stock_db客製：已知支援OpenAI相容原生 tools/tool_calls 參數的模型名稱
// pattern（用於 toolCallMode==='auto' 時猜測），對不到的模型一律退回文字式
// [CALL: ...] 慣例（走既有路徑，最保險）。
const NATIVE_TOOLCALL_MODEL_PATTERNS = [
    /^gpt-/i, /^o[1-9]/i, /^chatgpt/i,
    /^claude-/i,
    /^gemini-/i,
    /^grok-/i,
    /^llama-3\.[1-9]/i, /^meta-llama\/llama-3\.[1-9]/i,
    /^mistral-/i, /^mixtral-/i,
    /^qwen2\.5/i, /^qwen-/i,
    /^deepseek-/i,
];

// tw_stock_db客製: 這四個是唯一會被UI暴露、可以送進chat completions
// request body的取樣/重複懲罰參數鍵名（frequency_penalty/presence_penalty
// 是OpenAI標準欄位；repetition_penalty/length_penalty是vLLM/HF
// text-generation-inference常見但非標準的擴充欄位，不是每個OpenAI相容端點
// 都認得）。集中定義成常數，是因為_buildSamplingParamsBody()、
// _detectRejectedSamplingParam()、設定面板UI三處都要用同一份清單，避免
// 三邊各自硬寫一份、改一個忘了改另一個。
const SAMPLING_PARAM_KEYS = ['frequency_penalty', 'presence_penalty', 'repetition_penalty', 'length_penalty'];

// tw_stock_db客製: max_tokens的本質是「這一次API呼叫最多產生多少token」，
// 跟「這一輪對話總共能回覆多長」是兩件事——就算使用者把它調到很小
// （例如128），只要每次卡到上限就自動用同樣的上下文再送一次「請接續」，
// 理論上還是能拼出很長的完整回覆，不需要為了怕被截斷而被迫調大
// max_tokens（那樣反而更容易一次燒光推理模型的思考預算）。這裡是那個
// 自動接續機制：finish_reason==='length'時不是直接顯示警告了事，而是
// 自動重送一次「接續上一段」的請求並把內容接在後面，最多接續
// MAX_AUTO_CONTINUE_ROUNDS次（純粹是防止端點異常/模型跳針導致無限迴圈
// 燒費用的安全上限，不是真正的長度限制）。
const MAX_AUTO_CONTINUE_ROUNDS = 40;
const AI_AUTO_CONTINUE_PROMPT = '[系統提示] 上一則回覆因為單次輸出長度上限被截斷，請直接接續上一段未完成的內容繼續寫下去，不要重複已經說過的部分，也不要加任何開場白、道歉語或「以下接續」之類的提示語。';

// tw_stock_db客製: 內建的NVIDIA NIM模型清單，實測過都能正常回應（見下方
// 各自的實測結果，2026-08確認），給MODEL NAME欄位的<datalist>下拉選單用。
// 使用者仍然可以自己輸入清單以外的任何模型名稱——這只是常用選項的捷徑，
// 不是限制。
//   - nvidia/nemotron-3-super-120b-a12b：預設值，回應速度快、能力也最強，
//     早期實測在temperature=0時容易卡進重複輸出迴圈，現在有兩層防護：
//     _hasRepeatingTail()串流中偵測並截斷，加上預設repetition_penalty=1/
//     length_penalty=0.3的取樣參數（2026-08調整）。
//   - google/gemma-4-31b-it：實測~2秒回應、中文輸出正常。
//   - meta/llama-3.1-8b-instruct：實測<1秒回應，最快但能力較弱。
//   - meta/llama-3.3-70b-instruct：能力較強，回應較慢(~18秒)。
const PRESET_MODEL_OPTIONS = [
    'nvidia/nemotron-3-super-120b-a12b',
    'google/gemma-4-31b-it',
    'meta/llama-3.1-8b-instruct',
    'meta/llama-3.3-70b-instruct',
];

// ============================================================
// FloatingAssistant — 萬能網頁懸浮 AI 助手主體
// ============================================================
class FloatingAssistant {
    constructor(options = {}) {
        // --- 核心方法強制綁定實例 (防禦 Context 遺失 Bug) ---
        this.toggleWindow = this.toggleWindow.bind(this);
        this._log = this._log.bind(this);
        this.executeChat = this.executeChat.bind(this);
        this.register_openai_tool = this.register_openai_tool.bind(this);
        this.pruneContext = this.pruneContext.bind(this);
        this._checkTopicTransition = this._checkTopicTransition.bind(this);
        this._hermesReflectAndEvolve = this._hermesReflectAndEvolve.bind(this);
        this._openRagEditor = this._openRagEditor.bind(this);
        this._saveRagRecord = this._saveRagRecord.bind(this);
        this._deleteSelectedRagRecords = this._deleteSelectedRagRecords.bind(this);
        this._importRag = this._importRag.bind(this);
        this._exportRag = this._exportRag.bind(this);

        this.options = options || {};
        this.LLM_BASE_URL_KEY = "floating_ai_base_url_key";
        this.LLM_MODEL_NAME_KEY = "floating_ai_model_name_key";
        this.STORAGE_KEY = "floating_ai_api_key";
        this.HISTORY_KEY = "floating_ai_cmd_history";
        this.ADVANCED_SETTINGS_KEY = "floating_ai_advanced_settings";
        this.HERMES_AUTO_EVOLVE_KEY = "floating_ai_hermes_auto_evolve"; // 自我進化開關
        // tw_stock_db客製: this.messages原本純粹是記憶體內狀態，重新整理
        // 頁面（或AI分頁重新初始化）對話就整個消失——見_persistChatHistory()/
        // _loadPersistedChatHistory()，跟advancedSettings一樣存進localStorage。
        this.CHAT_HISTORY_KEY = "floating_ai_chat_history";

        this.tools = {};
        this.FromAI = {};
        this.messages = [];
        // tw_stock_db客製: pruneContext()壓縮上下文時被移出this.messages的原始
        // 訊息，純粹留著給畫面顯示用（見_renderMessageHistory()），不會被
        // 重新送回API，所以還是有真正縮減context的效果，只是使用者還能點開
        // 回顧，不會覺得對話「憑空消失」。
        this.archivedDisplayBlocks = [];
        this._loadPersistedChatHistory();
        this.activeToolEditIndex = -1;
        
        this.commandHistory = JSON.parse(localStorage.getItem(this.HISTORY_KEY)) || [];
        this.historyIndex = -1;
        this.retryLimit = 10;
        this.retryBaseDelayMs = 800;
        this.retryMaxDelayMs = 4000;
        this.isResponding = false;
        this.stopRequested = false;
        this.currentAbortController = null;
        this.responseStartedAt = 0;
        this.responseElapsedMs = 0;
        this.responseIndicatorTimer = null;
        this.responseIndicatorLabel = '';

        // 預設啟用背景自我進化
        if (localStorage.getItem(this.HERMES_AUTO_EVOLVE_KEY) === null) {
            localStorage.setItem(this.HERMES_AUTO_EVOLVE_KEY, 'true');
        }

        this.topicData = {
            currentTopic: "無（新對話開始）",
        };
        
        this.baseSystemPrompt = `你是一個具備「自適應依賴圖譜 RAG (Graph RAG)」與「程序記憶」能力的萬能進化助理。
當你與使用者互動時，請遵循以下機制：
1. 【記憶圖譜檢索】：
   對話前系統會自動搜尋「最相關的知識節點」並遞迴拉取其依賴的前置節點（Prerequisites）與確認條件。請多利用這些已被喚醒的上下文回答，不要跳過前置步驟。
2. 【長文章組織切塊】：
   遇到超大文章、書籍或長程式碼時，你可以調用 \`rag_chunk_document\` 工具在背景進行語意切分，建立 dependencies 以免 context 混亂。`;

        this.advancedSettings = this._loadAdvancedSettings();
        this._syncFromAI();
        
        const ragDbSuffix = String(options.ragDbSuffix || 'default').replace(/[^a-zA-Z0-9_\-]/g, '_');
        // 初始化具備 Graph-RAG 特性的 RAG 系統
        this.ragSystem = new IndexedDBRAGSystem('FloatingAssistantRAG_' + ragDbSuffix);
        this.activeRagEditId = null;
        this._initUI();
        this._initEventListeners();
        this._registerBuiltinAiTools();
    }

    setSystemPrompt(prompt) {
        this.baseSystemPrompt = prompt;
        this._refreshSystemPromptMessage();
        return this; 
    }

    register_openai_tool(name, description, callback) {
        this.tools[name] = { description, callback };
        this._log("工具已註冊: " + name);
        this._refreshSystemPromptMessage();
        return this; 
    }

    static mount(target, options = {}) {
        const opts = Object.assign({}, options);
        if (typeof target === 'string') {
            opts.mountSelector = target;
        } else if (target instanceof Element) {
            opts.mountElement = target;
        }
        return new FloatingAssistant(opts);
    }

    _createDefaultAdvancedSettings() {
        return {
            rulesMd: '',
            customFunctions: '',
            customTools: [],
            aiCustomFunctions: {},
            toolCallMode: 'auto', // tw_stock_db客製: 'auto' | 'native' | 'text'
            generation: this._createDefaultGenerationSettings(),
        };
    }

    // tw_stock_db客製: 使用者可調的生成/取樣參數。
    // - contextWindowTokens：使用者自己參考用（顯示在設定面板），目前沒有
    //   任何程式邏輯會主動拿它去做預算判斷——原本有一個「主動式」預算檢查
    //   會在送出請求前用這個值跟粗估的token數比較，但那個機制估算不準、
    //   常常在還沒真的超過限制時就誤觸發，已經移除（見executeChat()裡的
    //   說明），改成只信任伺服器真正回傳的400/413。
    // - maxOutputTokens：會真的送進request body的max_tokens欄位，替「單一次
    //   API呼叫」的輸出長度設一個硬上限——這不是「這一輪回覆的總長度」，兩者
    //   是分開的概念。就算把這個值調得很小，_loopFetch/_loopFetchNative也會
    //   在收到finish_reason==='length'（代表被這個上限攔腰截斷，不是真的
    //   講完）時自動重送「請接續」把內容拼起來（見MAX_AUTO_CONTINUE_ROUNDS），
    //   所以不需要為了怕截斷而刻意調大這個值。預設值(4096)只是給一般情況
    //   一個不錯的起點：推理模型（例如nemotron系列）會先輸出一大段內部思考
    //   過程才給最終答案，太小的值會讓每一輪都要多繞一次自動接續，稍微拖慢
    //   總時間，不是「調小就會截斷答案」。
    // - samplingParams：value為null代表「沒特別設定，不送這個欄位」；
    //   disabled:true代表這個參數曾經被目標端點拒絕過(見
    //   _detectRejectedSamplingParam)，之後的請求都不會再帶，直到使用者
    //   自己在設定面板手動重新啟用。
    _createDefaultGenerationSettings() {
        return {
            contextWindowTokens: 8192,
            maxOutputTokens: 4096,
            samplingParams: {
                frequency_penalty: { value: 0, disabled: false },
                presence_penalty: { value: 0, disabled: false },
                repetition_penalty: { value: 1, disabled: false },
                length_penalty: { value: 0.3, disabled: false },
            },
        };
    }

    _normalizeGenerationSettings(raw) {
        const defaults = this._createDefaultGenerationSettings();
        if (!raw || typeof raw !== 'object') return defaults;
        const toPositiveIntOr = (v, fallback) => {
            const n = Number(v);
            return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
        };
        const rawSp = (raw.samplingParams && typeof raw.samplingParams === 'object') ? raw.samplingParams : {};
        const samplingParams = {};
        for (const key of SAMPLING_PARAM_KEYS) {
            const entry = rawSp[key];
            const num = entry && entry.value != null && entry.value !== '' ? Number(entry.value) : null;
            samplingParams[key] = {
                value: Number.isFinite(num) ? num : null,
                disabled: !!(entry && entry.disabled),
            };
        }
        return {
            contextWindowTokens: toPositiveIntOr(raw.contextWindowTokens, defaults.contextWindowTokens),
            maxOutputTokens: toPositiveIntOr(raw.maxOutputTokens, defaults.maxOutputTokens),
            samplingParams,
        };
    }

    _getGenerationSettings() {
        if (!this.advancedSettings.generation) {
            this.advancedSettings.generation = this._createDefaultGenerationSettings();
        }
        return this.advancedSettings.generation;
    }

    // tw_stock_db客製: 只把「使用者有填值、且沒被標記為已拒絕」的取樣參數
    // 組進request body，其餘一律不送（不送=沿用端點自己的預設值，比送一個
    // 猜錯的值安全）。
    _buildSamplingParamsBody() {
        const sp = this._getGenerationSettings().samplingParams || {};
        const body = {};
        for (const key of SAMPLING_PARAM_KEYS) {
            const entry = sp[key];
            if (entry && !entry.disabled && entry.value != null) body[key] = entry.value;
        }
        return body;
    }

    // tw_stock_db客製: 400/413不一定真的是「上下文太長」——也可能是端點根本
    // 不認得我們送的某個取樣參數（例如某些NVIDIA NIM模型不接受
    // repetition_penalty/length_penalty，甚至某些端點連frequency_penalty/
    // presence_penalty都不支援）。如果對這種情況一律當成「上下文太長」去做
    // pruneContext，會發生「壓縮完還是同一個錯誤→一直壓縮，但訊息量根本
    // 沒有真的太長」的無效迴圈（實測過：已經壓縮到只剩system+摘要兩則還是
    // 400，代表400的成因跟訊息長度無關）。這裡用簡單的關鍵字比對從錯誤
    // 訊息本文猜是哪個參數被拒絕——沒有統一標準的provider錯誤格式，只能
    // 盡力而為，抓不到就照舊當成上下文問題處理（後面仍有retryLimit兜底，
    // 不會真的卡死）。
    _detectRejectedSamplingParam(errText) {
        if (!errText) return null;
        const lower = String(errText).toLowerCase();
        const rejectionHints = [
            'unrecognized', 'not supported', 'unsupported', 'unknown parameter',
            'unknown field', 'invalid parameter', 'extra fields not permitted',
            'unexpected keyword argument', 'not a valid', 'invalid request',
            'does not support', "isn't supported", 'not allowed'
        ];
        if (!rejectionHints.some(h => lower.includes(h))) return null;
        for (const key of SAMPLING_PARAM_KEYS) {
            if (lower.includes(key)) return key;
        }
        return null;
    }

    // tw_stock_db客製: 把某個取樣參數標記為「這個端點不支援」，之後所有
    // 請求都不會再帶（直到使用者自己在設定面板手動重新啟用），並在對話裡
    // 留一則使用者看得到的記錄，說明發生了什麼事、以後不會再重複發生。
    _disableRejectedSamplingParam(key, errText) {
        const sp = this._getGenerationSettings().samplingParams;
        if (!sp[key] || sp[key].disabled) return false; // 已經停用過，不要重複記錄/避免無窮遞迴
        sp[key].disabled = true;
        this._saveAdvancedSettings();
        this.messages.push({
            role: 'system',
            content: `[Steering] 偵測到目前模型/端點不支援 "${key}" 參數，已自動排除、之後的請求不會再帶這個欄位（可以到設定面板手動重新啟用）。伺服器回應片段：${String(errText || '').slice(0, 300)}`
        });
        this._renderMessageHistory();
        this._renderGenerationSettingsUI();
        return true;
    }

    // tw_stock_db客製: 部分模型在temperature=0（本專案固定貪婪解碼）+
    // 缺少足夠的重複懲罰時，容易卡進「同一段文字不斷重複輸出」的退化狀態
    // （實測nemotron系列模型針對同一支股票的[CALL: get_price_history(...)]
    // 連續重複十幾次，直到把整個回應的token額度耗光）。這裡在串流過程中
    // 邊收邊檢查，一偵測到就立刻截斷連線，不用等模型自己耗盡額度。
    _hasRepeatingTail(text, minLineLen = 15, minRepeats = 3) {
        const lines = String(text || '').split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < minRepeats) return false;
        const tail = lines.slice(-minRepeats);
        const first = tail[0];
        if (first.length < minLineLen) return false;
        return tail.every(l => l === first);
    }

    // 把偵測到的重複片段裁掉，只留第一次出現的那一份，避免下面的[CALL:...]
    // 解析邏輯把同一個工具重複執行十幾次（那樣只會讓對話歷史不必要地暴增，
    // 又繞回前面修的「上下文爆掉」問題）。
    _dedupeRepeatingTail(text) {
        const lines = String(text || '').split('\n');
        const nonEmptyIdx = [];
        lines.forEach((l, i) => { if (l.trim()) nonEmptyIdx.push(i); });
        if (nonEmptyIdx.length < 2) return text;
        const lastIdx = nonEmptyIdx[nonEmptyIdx.length - 1];
        const lastLine = lines[lastIdx].trim();
        let firstDupIdx = lastIdx;
        for (let k = nonEmptyIdx.length - 1; k >= 0; k--) {
            const idx = nonEmptyIdx[k];
            if (lines[idx].trim() === lastLine) firstDupIdx = idx;
            else break;
        }
        return lines.slice(0, firstDupIdx + 1).join('\n').trimEnd();
    }

    _normalizeCustomTool(tool, fallbackName) {
        if (!tool || typeof tool !== 'object') return null;
        const normalized = {
            name: String(tool.name || fallbackName || this._createTimestampedToolName()).trim(),
            description: String(tool.description || '').trim(),
            handlerScript: String(tool.handlerScript || '').replace(/\r\n/g, '\n')
        };
        if (!normalized.handlerScript.trim()) {
            normalized.handlerScript = this._getDefaultToolHandlerScript();
        }
        return normalized;
    }

    _normalizeAdvancedSettings(raw) {
        const defaults = this._createDefaultAdvancedSettings();
        if (!raw || typeof raw !== 'object') return defaults;
        const customTools = Array.isArray(raw.customTools)
            ? raw.customTools
                .map((tool, index) => this._normalizeCustomTool(tool, `custom_tool_${index + 1}`))
                .filter(Boolean)
            : [];
        const aiCustomFunctions = (raw.aiCustomFunctions && typeof raw.aiCustomFunctions === 'object' && !Array.isArray(raw.aiCustomFunctions))
            ? Object.fromEntries(
                Object.entries(raw.aiCustomFunctions)
                    .filter(([k, v]) => typeof k === 'string' && k.trim() && v && typeof v === 'object')
                    .map(([k, v]) => [k.trim(), {
                        description: String(v.description || '').trim(),
                        code: String(v.code || '').replace(/\r\n/g, '\n')
                    }])
            )
            : {};
        const toolCallMode = ['auto', 'native', 'text'].includes(raw.toolCallMode) ? raw.toolCallMode : 'auto';
        return {
            rulesMd: String(raw.rulesMd || '').replace(/\r\n/g, '\n'),
            customFunctions: String(raw.customFunctions || '').replace(/\r\n/g, '\n'),
            customTools,
            aiCustomFunctions,
            toolCallMode,
            generation: this._normalizeGenerationSettings(raw.generation),
        };
    }

    _loadAdvancedSettings() {
        try {
            const raw = localStorage.getItem(this.ADVANCED_SETTINGS_KEY);
            return this._normalizeAdvancedSettings(raw ? JSON.parse(raw) : null);
        } catch (err) {
            console.warn('Advanced settings load failed:', err);
            return this._createDefaultAdvancedSettings();
        }
    }

    _saveAdvancedSettings() {
        this.advancedSettings = this._normalizeAdvancedSettings(this.advancedSettings);
        try {
            localStorage.setItem(this.ADVANCED_SETTINGS_KEY, JSON.stringify(this.advancedSettings));
        } catch (err) {
            console.error('Advanced settings save failed:', err);
            alert('儲存 Advanced 設定失敗，請確認 localStorage 空間是否足夠。');
        }
        this._refreshSystemPromptMessage();
    }

    _syncFromAI() {
        this.FromAI = {};
        const fns = this.advancedSettings.aiCustomFunctions || {};
        for (const [name, fnData] of Object.entries(fns)) {
            this.FromAI[name] = this._createAiFnCallable(name, fnData);
        }
    }

    async callFromAI(name, args = {}) {
        const fnName = String(name || '').trim();
        if (!fnName) throw new Error('函式名稱不能為空。');
        const fn = this.FromAI[fnName];
        if (typeof fn !== 'function') throw new Error("找不到AI函式: " + fnName);
        return await fn(args);
    }

    _createAiFnCallable(name, fnData) {
        const self = this;
        return async function(args) {
            const helpers = {
                console: {
                    log: (...a) => console.log("[AI Fn:" + name + "]", ...a),
                    warn: (...a) => console.warn("[AI Fn:" + name + "]", ...a),
                    error: (...a) => console.error("[AI Fn:" + name + "]", ...a)
                },
                alert: (...a) => alert(a.map(v => typeof v === 'string' ? v : JSON.stringify(v, null, 2)).join(' ')),
                log: msg => self._log(String(msg || ''))
            };
            const runner = new Function('args', 'helpers', `
                return (async (args) => {
${fnData.code}
                })(args);
            `);
            return runner(args, helpers);
        };
    }

    _registerBuiltinAiTools() {
        this.register_openai_tool('list_ai_functions',
            '列舉所有AI自製函式，返回函式名稱和描述的清單。',
            async () => {
                const fns = this.advancedSettings.aiCustomFunctions || {};
                const list = Object.entries(fns).map(([n, fn]) => ({ name: n, description: fn.description || '' }));
                if (!list.length) return '目前沒有AI自製函式。';
                return JSON.stringify(list, null, 2);
            }
        );
        this.register_openai_tool('call_ai_function',
            '呼叫指定名稱的AI自製函式。參數: {"name":"函式名稱","args":{任意參數}}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const fnName = String(parsed.name || '');
                const fnArgs = parsed.args || {};
                if (!fnName) return JSON.stringify({ ok: false, error: '缺少 name 參數' });
                try {
                    const result = await this.callFromAI(fnName, fnArgs);
                    return this._formatToolResult(result, fnName);
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
            }
        );
        this.register_openai_tool('add_ai_function',
            '新增或更新AI自製函式。注意：設計此自製功能之 JavaScript 函式體時，腳本結尾必須有一行主動調用執行並回傳（例如，若定義了 async function main(args)，最後一行必須寫 "return await main(args);"），否則自製功能僅會被宣告定義而不會實際執行。參數: {"name":"函式名稱","description":"描述","code":"JavaScript函式體"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const fnName = String(parsed.name || '').trim();
                const fnDesc = String(parsed.description || '').trim();
                const fnCode = String(parsed.code || '').trim();
                if (!fnName) return JSON.stringify({ ok: false, error: '缺少 name 參數' });
                if (!fnCode) return JSON.stringify({ ok: false, error: '缺少 code 參數' });
                try { this._validateCustomScript(fnCode, 'AI函式 "' + fnName + '"'); } catch (err) { return JSON.stringify({ ok: false, error: err.message }); }
                if (!this.advancedSettings.aiCustomFunctions) this.advancedSettings.aiCustomFunctions = {};
                this.advancedSettings.aiCustomFunctions[fnName] = { description: fnDesc, code: fnCode };
                this._saveAdvancedSettings();
                this._syncFromAI();
                this._renderAiFnList();
                return JSON.stringify({ ok: true, message: "已儲存AI函式: " + fnName });
            }
        );
        this.register_openai_tool('delete_ai_function',
            '刪除指定名稱的AI自製函式。參數: {"name":"函式名稱"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const fnName = String(parsed.name || '').trim();
                if (!fnName) return JSON.stringify({ ok: false, error: '缺少 name 參數' });
                const fns = this.advancedSettings.aiCustomFunctions || {};
                if (!Object.prototype.hasOwnProperty.call(fns, fnName)) return JSON.stringify({ ok: false, error: "找不到AI函式: " + fnName });
                delete fns[fnName];
                this._saveAdvancedSettings();
                this._syncFromAI();
                this._renderAiFnList();
                return JSON.stringify({ ok: true, message: "已刪除AI函式: " + fnName });
            }
        );

        // ============================================================
        // 核心 Graph-RAG 圖譜 API
        // ============================================================
        this.register_openai_tool('rag_store_graph_node',
            '將高價值 Routine 技能或偏好儲存到記憶圖譜中。參數: {"id":"節點名稱(如 skill_debounce)","content":"核心內容","dependencies":["依賴的前置節點ID清單"],"preConditions":["滿足此條件才調用此節點的描述"],"tags":"標籤(可填 skill, user_preference, document_section)"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const content = String(parsed.content || '').trim();
                if (!content) return JSON.stringify({ ok: false, error: '缺少 content 參數' });
                try {
                    const id = await this.ragSystem.add(content, {
                        id: parsed.id || undefined,
                        dependencies: parsed.dependencies || [],
                        preConditions: parsed.preConditions || [],
                        source: 'hermes_evolution',
                        tags: parsed.tags || 'skill'
                    });
                    return JSON.stringify({ ok: true, id, message: "已成功學習並建立知識節點。id=" + id });
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
            }
        );

        this.register_openai_tool('rag_query_graph',
            '從知識圖譜中進行語意查詢，會自動提取符合條件與所有前置依賴鏈(DAG Traversal)的有序列表。參數: {"query":"查詢語意","top_k":3}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const queryText = String(parsed.query || '').trim();
                if (!queryText) return JSON.stringify({ ok: false, error: '缺少 query 參數' });
                const topK = Number(parsed.top_k) > 0 ? Number(parsed.top_k) : 3;
                try {
                    const results = await this.ragSystem.query(queryText, topK);
                    if (!results.length) return '查無相關圖譜記錄。';
                    return JSON.stringify(results.map(r => ({
                        id: r.id,
                        content: r.content,
                        isPrerequisite: r.isPrerequisite,
                        dependencies: r.dependencies,
                        preConditions: r.preConditions,
                        score: r.score > 0 ? (Math.round(r.score * 1000) / 1000) : '依賴鏈拉入'
                    })), null, 2);
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
            }
        );

        // ============================================================
        // 📚 長文章自動語意切塊工具 (Semantic Dependency-Chunking)
        // ============================================================
        this.register_openai_tool('rag_chunk_document',
            '【長文組織器】將超大文章、程式專案或長文件，在背景進行章節拆解，為每個章節提煉精準摘要，並自動設定 dependencies 與 preconditions。參數: {"documentText":"超長文章內文","title":"文章大標題","tags":"自訂標籤(選填)"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const docText = String(parsed.documentText || '').trim();
                const title = String(parsed.title || '長文件分析').trim();
                if (!docText) return JSON.stringify({ ok: false, error: '缺少 documentText 參數' });
                
                this._log("📚 正在解析長文「" + title + "」，進行動態切塊中...");
                
                const { apiKey, apiUrl, apiModel } = this._getApiConfig();
                if (!apiKey) return JSON.stringify({ ok: false, error: '缺少 API KEY，無法在本地調用 AI 解析長文' });

                const prompt = `你是一個專業的文件分析官。
現在有一篇名為「${title}」的大型文章，由於內文過於龐大，LLM 容易迷失。
請幫我將這篇文章進行章節拆碎與切塊（Semantic Chunking）。為每個重要的章節或小段，撰寫精準的核心內文總結。
更重要的是：你必須為每個章節，建立承接它的 \`dependencies\`（依賴節點ID）與 \`preConditions\`（需要理解的前置背景）。
例如：
- 第二小節(例如：'node_2') 的 dependencies 必須包含第一小節(例如：'node_1')。
- 第三小節(例如：'node_3') 依賴 第二小節。

請嚴格以下列 JSON Array 格式輸出，不要含有任何額外文字或 markdown 標記：
[
  {
    "id": "一組唯一的英文蛇形 ID，如 ${title.toLowerCase().replace(/[^a-z0-9]/g, '_')}_sec_1",
    "content": "此小節的核心總結與關鍵代碼/事實",
    "dependencies": [],
    "preConditions": ["需要先了解的文章段落背景或前提"],
    "tags": "document_section, ${parsed.tags || 'docs'}"
  },
  ...
]

超大文章內容：\n${docText.slice(0, 25000)}`;

                try {
                    const response = await fetch(`${apiUrl}/chat/completions`, {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${apiKey}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: apiModel,
                            messages: [{ role: "user", content: prompt }],
                            temperature: 0.2,
                            stream: false
                        })
                    });

                    if (!response.ok) throw new Error("HTTP " + response.status);
                    const data = await response.json();
                    const reply = data.choices[0]?.message?.content?.trim() || "";
                    const jsonMatch = reply.match(/\[[\s\S]*\]/);
                    if (!jsonMatch) throw new Error('AI 回傳格式不符合 JSON Array 期待');

                    const chunks = JSON.parse(jsonMatch[0]);
                    const ids = [];

                    for (const chunk of chunks) {
                        const newId = await this.ragSystem.add(chunk.content, {
                            id: chunk.id,
                            dependencies: chunk.dependencies || [],
                            preConditions: chunk.preConditions || [],
                            source: `chunk_document:${title}`,
                            tags: chunk.tags || 'document_section'
                        });
                        ids.push(newId);
                    }

                    // 強制刷新 TF-IDF 索引
                    const allRecords = await this.ragSystem.getAll();
                    this.ragSystem.engine.updateIDF(allRecords.map(r => r.content));

                    return JSON.stringify({ 
                        ok: true, 
                        message: "成功將文件「" + title + "」切割為 " + ids.length + " 個帶有依賴關係的知識節點！",
                        nodeIds: ids 
                    });

                } catch (err) {
                    return JSON.stringify({ ok: false, error: "解析長文失敗: " + err.message });
                }
            }
        );

        this.register_openai_tool('rag_delete',
            '從RAG記憶庫刪除指定id的記錄。參數: {"id":記錄id}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const id = parsed.id;
                if (!id) return JSON.stringify({ ok: false, error: '缺少有效的 id 參數' });
                try {
                    await this.ragSystem.delete(id);
                    return JSON.stringify({ ok: true, message: "已刪除RAG記錄 id=" + id });
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
            }
        );
    }

    _refreshSystemPromptMessage() {
        if (this.messages.length === 0) return;
        const systemPrompt = this._getFinalSystemPrompt();
        if (this.messages[0] && this.messages[0].role === 'system') {
            this.messages[0].content = systemPrompt;
        } else {
            this.messages.unshift({ role: 'system', content: systemPrompt });
        }
        this._refreshSystemPromptMessageHistory();
    }

    _refreshSystemPromptMessageHistory() {
        this._renderMessageHistory();
    }

    _createTimestampedToolName() {
        return `unnamed_tool_${Date.now().toString(16)}`;
    }

    _getDefaultToolHandlerScript() {
        return [
            "console.log('custom tool args:', args);",
            "alert('custom tool args: ' + JSON.stringify(args, null, 2));",
            "return JSON.stringify({",
            "  ok: true,",
            "  received: args",
            "}, null, 2);"
        ].join('\n');
    }

    _getCombinedToolEntries() {
        const entries = Object.entries(this.tools).map(([name, tool]) => [name, Object.assign({ source: 'predefined' }, tool)]);
        this.advancedSettings.customTools.forEach(tool => {
            entries.push([tool.name, {
                description: tool.description,
                callback: rawArgs => this._executeCustomTool(tool, rawArgs),
                source: 'custom'
            }]);
        });
        return entries;
    }

    _getToolDefinition(name) {
        return this._getCombinedToolEntries().find(([toolName]) => toolName === name)?.[1] || null;
    }

    _isToolNameDuplicate(name, excludeIndex = -1) {
        return Object.prototype.hasOwnProperty.call(this.tools, name) ||
            this.advancedSettings.customTools.some((tool, index) => tool.name === name && index !== excludeIndex);
    }

    _validateCustomScript(script, label = '腳本') {
        return true;
    }

    _getFinalSystemPrompt() {
        const sections = [];
        const rulesMd = String(this.advancedSettings.rulesMd || '').trim();
        const basePrompt = String(this.baseSystemPrompt || '').trim();
        const predefinedTools = Object.entries(this.tools);
        const customTools = this.advancedSettings.customTools;

        if (rulesMd) sections.push(rulesMd);
        if (basePrompt) sections.push(basePrompt);

        // tw_stock_db客製: 原生tool-call模式下，工具清單已經透過API的tools參數
        // 結構化傳給模型，不需要再用文字重複描述一次工具清單、更不需要
        // [TOOL CALL PROTOCOL]這段文字慣例(那是給不支援原生function call的
        // 模型用的)，所以這裡整段跳過。
        const { apiModel } = this._getApiConfig();
        if (!this._shouldUseNativeToolCalls(apiModel) && (predefinedTools.length || customTools.length)) {
            const toolSections = [];
            if (predefinedTools.length) {
                toolSections.push([
                    '[PREDEFINED TOOLS]',
                    ...predefinedTools.map(([name, tool]) => `- ${name}: ${tool.description}`)
                ].join('\n'));
            }
            if (customTools.length) {
                toolSections.push([
                    '[CUSTOM TOOLS]',
                    ...customTools.map(tool => `- ${tool.name}: ${tool.description || 'No description provided.'}`)
                ].join('\n'));
            }
            toolSections.push([
                '[TOOL CALL PROTOCOL]',
                'If you need to use a tool, you MUST output the call format strictly as:',
                '[CALL: tool_name(ARGUMENTS_AS_JSON_OBJECT)]',
                // tw_stock_db客製: 原本這裡只給抽象模板([CALL: tool_name("arguments")])，
                // 沒有具體示範"arguments"該長什麼樣子，模型（尤其較小的模型）很
                // 容易誤以為是一個裸值而不是物件，例如寫成
                // diagnose_stock("9945")而不是diagnose_stock({"code":"9945"})，
                // 導致handler拿到的參數對不上宣告的鍵名。這裡明講ARGUMENTS必須
                // 是JSON物件、鍵名要對應工具描述裡列出的參數名稱，並給一個具體
                // 範例，降低模型猜錯的機率（後端aiToolHandler仍然有針對單一參數
                // 工具的容錯，這裡是雙重保險，不是取代）。
                'ARGUMENTS_AS_JSON_OBJECT means a JSON object whose keys match the parameter names listed in that tool\'s description — NEVER a bare value. For example, if a tool\'s params are {"code": "stock code"}, call it as:',
                '[CALL: diagnose_stock({"code": "2330"})]',
                'and NOT as [CALL: diagnose_stock("2330")] or [CALL: diagnose_stock(2330)].',
                'Do not output anything else in that turn. Once the user provides the [TOOL RESULT], you will continue answering.'
            ].join('\n'));
            sections.push(toolSections.join('\n\n'));
        }

        return sections.filter(Boolean).join('\n\n') || this.baseSystemPrompt;
    }

    _getApiConfig() {
        const apiKey = localStorage.getItem(this.STORAGE_KEY);
        let apiUrl = localStorage.getItem(this.LLM_BASE_URL_KEY) || 'https://integrate.api.nvidia.com/v1';
        // tw_stock_db客製: 原本預設的 'openai/gpt-oss-120b' 在NVIDIA的NIM端點
        // 上會整個請求卡住、永遠不回應（實測90秒仍無回應，不是慢，是完全不
        // 回），導致沒自己設定模型的使用者(=大多數人，因為AI分頁預設用假
        // 金鑰+這個預設模型)問任何問題都會卡住/最終fetch失敗。改用回應速度
        // 快、能力也最強的 'nvidia/nemotron-3-super-120b-a12b'（2026-08調整，
        // 見PRESET_MODEL_OPTIONS上方的各選項實測註記）。
        let apiModel = localStorage.getItem(this.LLM_MODEL_NAME_KEY) || 'nvidia/nemotron-3-super-120b-a12b';
        return { apiKey, apiUrl, apiModel };
    }

    // tw_stock_db客製: 判斷目前要不要用原生 tools/tool_calls API格式，而不是
    // [CALL: ...]文字慣例。advancedSettings.toolCallMode三態: 'native'/'text'
    // 直接照使用者指定；'auto'(預設)則依模型名稱pattern猜測。
    _shouldUseNativeToolCalls(apiModel) {
        const mode = this.advancedSettings.toolCallMode || 'auto';
        if (mode === 'native') return true;
        if (mode === 'text') return false;
        const name = String(apiModel || '');
        return NATIVE_TOOLCALL_MODEL_PATTERNS.some(re => re.test(name));
    }

    // tw_stock_db客製: 把 this.tools（預定義）+ advancedSettings.customTools
    // （使用者自訂）轉成OpenAI相容的原生 tools schema。目前工具的參數只有
    // 自由文字描述（沒有結構化per-參數型別），所以這裡用寬鬆的
    // {type:'object'}（不逐一定義每個參數型別），效果比嚴格schema差一點，
    // 但仍然比純文字[CALL:...]可靠，模型看得到工具名稱/描述並能正確產生
    // 呼叫。
    _buildNativeToolsSchema() {
        return this._getCombinedToolEntries().map(([name, tool]) => ({
            type: 'function',
            function: {
                name,
                description: String(tool.description || ''),
                parameters: { type: 'object', properties: {}, additionalProperties: true }
            }
        }));
    }

    _extractJsonErrorPosition(err) {
        const match = String(err && err.message || '').match(/position\s+(\d+)/i);
        return match ? Number(match[1]) : null;
    }

    _buildJsonCandidates(rawText) {
        const text = String(rawText == null ? '' : rawText).trim();
        const candidates = [];
        const push = value => {
            if (typeof value !== 'string') return;
            const normalized = value.trim();
            if (!normalized || candidates.includes(normalized)) return;
            candidates.push(normalized);
        };
        push(text);
        if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
            push(text.slice(1, -1));
        }
        push(text.replace(/\\"/g, '"'));
        push(text.replace(/\\'/g, "'"));
        push(text.replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\t/g, '\t'));
        return candidates;
    }

    _tryParseJsonPayload(rawText, depth = 0) {
        let lastError = null;
        let errorPosition = null;
        for (const candidate of this._buildJsonCandidates(rawText)) {
            try {
                const parsed = JSON.parse(candidate);
                if (typeof parsed === 'string' && depth < 2) {
                    const nested = parsed.trim();
                    if (!nested) return { ok: true, value: {} };
                    return this._tryParseJsonPayload(nested, depth + 1);
                }
                return { ok: true, value: parsed };
            } catch (err) {
                lastError = err;
                if (errorPosition == null) errorPosition = this._extractJsonErrorPosition(err);
            }
        }
        return { ok: false, error: lastError, errorPosition };
    }

    _formatToolResult(result, toolName) {
        if (typeof result === 'string') return result;
        if (typeof result === 'undefined') return `[Tool 回傳成功] ${toolName} 執行完成`;
        try {
            // tw_stock_db客製: 原本用 JSON.stringify(result, null, 2) 美化縮排，
            // 但這段文字是直接塞進送給模型的訊息內容，縮排/換行對LLM閱讀沒有
            // 幫助，純粹浪費token（實測同一份300筆OHLCV資料，美化版比壓縮版
            // 多耗費約23%字元數）。畫面上的<details>區塊本身就是等寬字型+
            // 自動換行，壓縮後照樣可讀。
            return JSON.stringify(result);
        } catch (err) {
            return String(result);
        }
    }

    // tw_stock_db客製: 圖片類工具結果（例如render_stock_chart/get_chart_snapshot
    // 回傳的{type:'image', dataUrl}）的base64內容常常是幾十KB的文字，塞進送給
    // LLM的訊息內容裡完全是浪費——這裡串接的是純文字模型（不是走OpenAI vision
    // API的圖片content block格式），模型看到的只會是一坨看不懂的base64亂碼，
    // 沒有任何幫助，卻會大量佔用上下文預算（單張圖動輒兩三萬token），是「已
    // 封存對話」跳出來太頻繁的主因之一。這裡統一由這個helper決定怎麼push
    // tool結果訊息：圖片類的話，送進this.messages（會被JSON.stringify進
    // request body、也會被拿去估算token預算）的content只留一句提示文字，
    // 真正的圖片資料改存在不可枚舉的_displayDataUrl屬性上，只給
    // _renderSingleMessage()渲染畫面用，JSON.stringify不會序列化到它（送出的
    // request body、prune的token估算、甚至存進localStorage都不會含圖片內容——
    // 圖片改由_persistChatHistory()額外用imageMap存，見那邊的說明）。
    _pushToolResultMessage(fnName, result, extra) {
        let imageDataUrl = null;
        try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed && parsed.type === 'image' && typeof parsed.dataUrl === 'string') {
                imageDataUrl = parsed.dataUrl;
            }
        } catch (_) { /* 不是圖片payload，走下面一般文字流程 */ }

        const msg = Object.assign({ role: 'tool' }, extra || {});
        if (imageDataUrl) {
            msg.content = `[Tool ${fnName} 已產生一張圖表圖片，已直接顯示給使用者看，圖片二進位內容不列入對話上下文]`;
            Object.defineProperty(msg, '_displayDataUrl', { value: imageDataUrl, enumerable: false, configurable: true });
        } else {
            msg.content = this._formatToolResult(result, fnName);
        }
        this.messages.push(msg);
        return msg;
    }

    async _executeCustomTool(tool, rawArgs) {
        const sourceTool = this._normalizeCustomTool(tool, tool && tool.name);
        if (!sourceTool) {
            throw new Error('找不到自訂工具定義');
        }
        this._validateCustomScript(this.advancedSettings.customFunctions, 'Customize Functions');
        this._validateCustomScript(sourceTool.handlerScript, `Tool ${sourceTool.name} Handler Script`);
        let parsedArgs = {};
        const normalizedRawArgs = String(rawArgs == null ? '' : rawArgs).trim();
        if (normalizedRawArgs) {
            try {
                parsedArgs = await this.repairJsonPayload(normalizedRawArgs);
            } catch (err) {
                parsedArgs = normalizedRawArgs;
            }
        }
        const helpers = {
            console: {
                log: (...args) => console.log("[AI Custom Tool:" + sourceTool.name + "]", ...args),
                warn: (...args) => console.warn("[AI Custom Tool:" + sourceTool.name + "]", ...args),
                error: (...args) => console.error("[AI Custom Tool:" + sourceTool.name + "]", ...args)
            },
            alert: (...args) => alert(args.map(value => typeof value === 'string' ? value : JSON.stringify(value, null, 2)).join(' ')),
            log: message => this._log(String(message || ''))
        };
        const runner = new Function('parsedArgs', 'rawArgs', 'helpers', `
            return (async (args, rawArgs) => {
${sourceTool.handlerScript}
            })(parsedArgs, rawArgs);
        `);
        const result = await runner(parsedArgs, normalizedRawArgs, helpers);
        return this._formatToolResult(result, sourceTool.name);
    }

    // ============================================================
    // 💡 完整無缺漏之寬鬆 JSON 解析器
    // ============================================================
    _parseJsonLenient(rawText, options = {}) {
        const text = String(rawText == null ? '' : rawText).trim();
        let index = 0;
        const errors = [];
        const recordError = (message, position = index) => errors.push({ message, position });
        const skipWhitespace = () => {
            while (index < text.length && /\s/.test(text[index])) index += 1;
        };
        const syncTo = chars => {
            while (index < text.length && !chars.includes(text[index])) index += 1;
        };
        const canStartValue = ch => ch === '{' || ch === '[' || ch === '"' || ch === '\'' || ch === '-' || /\d/.test(ch || '') || ch === 't' || ch === 'f' || ch === 'n';

        const parseString = () => {
            const quote = text[index];
            if (quote !== '"' && quote !== '\'') {
                recordError('字串起始引號遺失', index);
                return { ok: false };
            }
            index += 1;
            let value = '';
            while (index < text.length) {
                const ch = text[index];
                if (ch === quote) {
                    index += 1;
                    return { ok: true, value, closed: true };
                }
                if (ch === '\\') {
                    const next = text[index + 1];
                    if (next == null) {
                        recordError('跳脫字元不完整', index);
                        index += 1;
                        return { ok: true, value, closed: false };
                    }
                    if (next === 'u' && /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6))) {
                        value += String.fromCharCode(parseInt(text.slice(index + 2, index + 6), 16));
                        index += 6;
                        continue;
                    }
                    const escapes = { '"': '"', '\'': '\'', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
                    value += Object.prototype.hasOwnProperty.call(escapes, next) ? escapes[next] : next;
                    index += 2;
                    continue;
                }
                value += ch;
                index += 1;
            }
            recordError('字串未閉合', index);
            return { ok: true, value, closed: false };
        };

        const parseNumber = () => {
            const match = text.slice(index).match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/);
            if (!match) {
                recordError('數字格式錯誤', index);
                return { ok: false };
            }
            index += match[0].length;
            return { ok: true, value: Number(match[0]) };
        };

        const parseLiteral = (literal, value) => {
            if (text.slice(index, index + literal.length) === literal) {
                index += literal.length;
                return { ok: true, value };
            }
            return { ok: false };
        };

        const parseValue = () => {
            skipWhitespace();
            const ch = text[index];
            if (ch === '{') return parseObject();
            if (ch === '[') return parseArray();
            if (ch === '"' || ch === '\'') return parseString();
            if (ch === '-' || /\d/.test(ch || '')) return parseNumber();
            if (text.startsWith('true', index)) return parseLiteral('true', true);
            if (text.startsWith('false', index)) return parseLiteral('false', false);
            if (text.startsWith('null', index)) return parseLiteral('null', null);
            recordError('無法辨識的 JSON 值', index);
            return { ok: false };
        };

        const parseArray = () => {
            index += 1;
            const value = [];
            let expectItem = true;
            while (index < text.length) {
                skipWhitespace();
                if (text[index] === ']') {
                    index += 1;
                    return { ok: true, value, closed: true };
                }
                if (!expectItem) {
                    if (text[index] === ',') {
                        index += 1;
                        expectItem = true;
                        continue;
                    }
                    recordError('陣列缺少逗號', index);
                }
                const item = parseValue();
                if (!item.ok) {
                    recordError('陣列項目解析失敗', index);
                    syncTo(',]');
                    if (text[index] === ',') {
                        index += 1;
                        expectItem = true;
                        continue;
                    }
                    if (text[index] === ']') {
                        index += 1;
                        return { ok: true, value, closed: true };
                    }
                    break;
                }
                value.push(item.value);
                expectItem = false;
            }
            recordError('陣列未閉合', index);
            return { ok: value.length > 0 || !!options.allowPartialRoot, value, closed: false };
        };

        const parseObject = () => {
            index += 1;
            const value = {};
            let expectKey = true;
            while (index < text.length) {
                skipWhitespace();
                if (text[index] === '}') {
                    index += 1;
                    return { ok: true, value, closed: true };
                }
                if (!expectKey) {
                    if (text[index] === ',') {
                        index += 1;
                        expectKey = true;
                        continue;
                    }
                    recordError('物件缺少逗號', index);
                }
                skipWhitespace();
                if (text[index] !== '"' && text[index] !== '\'') {
                    recordError('物件 key 不是字串', index);
                    while (index < text.length && text[index] !== '"' && text[index] !== '\'' && text[index] !== '}') index += 1;
                    if (text[index] === '}') {
                        index += 1;
                        return { ok: true, value, closed: true };
                    }
                }
                const keyResult = parseString();
                if (!keyResult.ok) break;
                const key = keyResult.value;
                skipWhitespace();
                if (text[index] === ':') {
                    index += 1;
                } else {
                    recordError('物件缺少冒號', index);
                    if (!canStartValue(text[index])) {
                        while (index < text.length && text[index] !== ':' && text[index] !== ',' && text[index] !== '}') index += 1;
                        if (text[index] === ':') index += 1;
                    }
                }
                const entryValue = parseValue();
                if (!entryValue.ok) {
                    recordError("欄位 " + key + " 解析失敗", index);
                    syncTo(',}');
                    if (text[index] === ',') {
                        index += 1;
                        expectKey = true;
                        continue;
                    }
                    if (text[index] === '}') {
                        index += 1;
                        return { ok: true, value, closed: true };
                    }
                    break;
                }
                value[key] = entryValue.value;
                expectKey = false;
            }
            recordError('物件未閉合', index);
            return { ok: Object.keys(value).length > 0 || !!options.allowPartialRoot, value, closed: false };
        };

        if (!text) return { ok: false, errors: [{ message: 'JSON 內容為空', position: 0 }] };
        const root = parseValue();
        skipWhitespace();
        if (index < text.length) recordError('JSON 尾端有多餘內容', index);
        return {
            ok: !!root.ok,
            value: root.value,
            closed: !!root.closed,
            errors,
            errorPosition: errors.length ? errors[0].position : null,
            repairedText: root.ok ? JSON.stringify(root.value) : ''
        };
    }

    _extractJsonSnippet(text) {
        // 安全拼接，避免外層 Markdown 編輯器混淆
        const b1 = '`';
        const ticks = b1 + b1 + b1;
        const regex = new RegExp(ticks + '(?:json)?\\s*([\\s\\S]*?)' + ticks, 'i');
        const fenced = String(text || '').match(regex);
        if (fenced) return fenced[1].trim();
        
        const match = String(text || '').match(/[\{\[][\s\S]*[\}\]]/);
        return match ? match[0].trim() : String(text || '').trim();
    }

    _buildJsonRepairPrompt(rawText, errorPosition) {
        const text = String(rawText || '');
        const MAX_JSON_REPAIR_PROMPT_LENGTH = 6000;
        const JSON_ERROR_CONTEXT_RADIUS = 3000;
        if (text.length <= MAX_JSON_REPAIR_PROMPT_LENGTH || errorPosition == null || !Number.isFinite(errorPosition)) {
            return `請修復以下 JSON。若有錯，優先修復錯誤位置附近的內容。\n\n${text}`;
        }
        const start = Math.max(0, errorPosition - JSON_ERROR_CONTEXT_RADIUS);
        const end = Math.min(text.length, errorPosition + JSON_ERROR_CONTEXT_RADIUS);
        const prefix = start > 0 ? '...<trimmed>...' : '';
        const suffix = end < text.length ? '...<trimmed>...' : '';
        return [
            `請修復以下 JSON 片段並維持既有結構。錯誤位置=${errorPosition}`,
            '',
            `${prefix}${text.slice(start, end)}${suffix}`
        ].join('\n');
    }

    _repairJsonWithTokenizer(rawText) {
        const parsed = this._parseJsonLenient(rawText);
        if (!parsed.ok || !parsed.repairedText) {
            return {
                ok: false,
                error: new Error('Tokenizer 無法修復 JSON'),
                errorPosition: parsed.errorPosition
            };
        }
        const reparsed = this._tryParseJsonPayload(parsed.repairedText);
        if (reparsed.ok) {
            return {
                ok: true,
                value: reparsed.value,
                strategy: 'tokenizer',
                errorPosition: parsed.errorPosition,
                errors: parsed.errors
            };
        }
        return { ok: false, error: reparsed.error, errorPosition: parsed.errorPosition };
    }

    async _repairJsonWithLlm(rawText, errorPosition) {
        const { apiKey, apiUrl, apiModel } = this._getApiConfig();
        if (!apiKey) {
            return { ok: false, error: new Error('缺少 API Key，無法使用 LLM 修復 JSON。') };
        }
        try {
            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: apiModel,
                    temperature: 0,
                    stream: false,
                    messages: [
                        {
                            role: 'system',
                            content: '你是一個無記憶 JSON 修復器。只輸出修復後的合法 JSON，不要輸出解釋、markdown 或額外文字。'
                        },
                        {
                            role: 'user',
                            content: this._buildJsonRepairPrompt(rawText, errorPosition)
                        }
                    ]
                })
            });
            if (!response.ok) {
                return { ok: false, error: new Error(`LLM JSON 修復失敗: HTTP ${response.status}`) };
            }
            const data = await response.json();
            const content = data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : '';
            const snippet = this._extractJsonSnippet(content);
            const parsed = this._tryParseJsonPayload(snippet);
            if (parsed.ok) return { ok: true, value: parsed.value, strategy: 'llm' };
            return { ok: false, error: parsed.error || new Error('LLM 回傳內容不是合法 JSON') };
        } catch (err) {
            return { ok: false, error: err };
        }
    }

    _loadJsonPartially(rawText) {
        const parsed = this._parseJsonLenient(rawText, { allowPartialRoot: true });
        if (parsed.ok && (parsed.repairedText || typeof parsed.value !== 'undefined')) {
            return {
                ok: true,
                value: parsed.value,
                strategy: 'partial',
                errorPosition: parsed.errorPosition,
                errors: parsed.errors
            };
        }
        return {
            ok: false,
            error: new Error('無法以逐字方式載入 JSON'),
            errorPosition: parsed.errorPosition
        };
    }

    async repairJsonPayload(rawText) {
        const direct = this._tryParseParseJsonPayload(rawText);
        if (direct.ok) return direct.value;

        const tokenizer = this._repairJsonWithTokenizer(rawText);
        if (tokenizer.ok) return tokenizer.value;

        const llm = await this._repairJsonWithLlm(rawText, tokenizer.errorPosition ?? direct.errorPosition);
        if (llm.ok) return llm.value;

        const partial = this._loadJsonPartially(rawText);
        if (partial.ok) return partial.value;

        throw direct.error || tokenizer.error || llm.error || partial.error || new Error('JSON 解析失敗');
    }

    _tryParseParseJsonPayload(rawText, depth = 0) {
        return this._tryParseJsonPayload(rawText, depth);
    }

    // tw_stock_db客製: 原始函式庫預設看 document.body 是否帶 'light-theme'
    // class 來判斷淺色/深色，但這個專案的主題切換是設在 <html> 標籤的
    // data-theme屬性（"light"/"dark"，見 web/index.html 的 isDark()），
    // 從來不會加 body class，導致這裡永遠判斷成深色。改成直接讀同一個
    // data-theme屬性，讓AI助理視窗跟著網頁本身的主題走。
    _isLightTheme() {
        return document.documentElement.getAttribute('data-theme') !== 'dark';
    }

    _getThemePalette() {
        if (this._isLightTheme()) {
            return {
                windowBg: '#ffffff',
                windowBorder: '#d0d7de',
                headerBg: '#f6f8fa',
                headerText: '#24292f',
                chatBg: '#f6f8fa',
                chatText: '#1f2328',
                userBg: '#dbeafe',
                userText: '#1d4ed8',
                assistantBg: '#e5e7eb',
                assistantText: '#1f2937',
                detailBg: '#f1f5f9',
                detailText: '#334155',
                inputBg: '#ffffff',
                inputText: '#111827',
                inputBorder: '#cbd5e1',
                statusBg: '#e2e8f0',
                statusText: '#334155',
            };
        }
        return {
            windowBg: '#1b1f24',
            windowBorder: '#30363d',
            headerBg: '#161b22',
            headerText: '#f0f6fc',
            chatBg: '#0d1117',
            chatText: '#e6edf3',
            userBg: '#1e3a8a',
            userText: '#dbeafe',
            assistantBg: '#1f2937',
            assistantText: '#e5e7eb',
            detailBg: '#111827',
            detailText: '#cbd5e1',
            inputBg: '#0f172a',
            inputText: '#e2e8f0',
            inputBorder: '#334155',
            statusBg: '#161b22',
            statusText: '#93a4b7',
        };
    }

    _applyThemeStyles() {
        const win = document.getElementById('ai-floating-window');
        const header = document.getElementById('ai-window-header');
        const configPanel = document.getElementById('ai-config-panel');
        const chatBody = document.getElementById('ai-chat-body');
        const autocomplete = document.getElementById('ai-autocomplete-bar');
        const inputWrap = document.getElementById('ai-input-wrap');
        const inputText = document.getElementById('ai-input-text');
        const status = document.getElementById('ai-status-log');
        if (!win || !header || !chatBody || !inputWrap || !inputText || !status) return;

        const palette = this._getThemePalette();
        win.style.background = palette.windowBg;
        win.style.borderColor = palette.windowBorder;
        header.style.background = palette.headerBg;
        header.style.color = palette.headerText;
        configPanel.style.background = palette.chatBg;
        configPanel.style.color = palette.chatText;
        configPanel.style.borderBottomColor = palette.windowBorder;
        // tw_stock_db客製: API KEY/URL/MODEL NAME + 生成/取樣參數這幾個輸入框
        // 是在_initUI()組innerHTML時用當下的palette寫死背景/文字色——如果
        // 使用者是先開了AI視窗、之後才切換網頁的淺/深色主題，這裡不主動
        // 同步的話，這幾個欄位的顏色會停留在視窗剛建立時的舊主題，跟其他
        // 已經正確跟隨主題的元素（例如下面的inputText）不一致，看起來像是
        // 顏色跑掉/讀不清楚。
        const genDetailBox = configPanel.querySelector('#ai-gen-context-window')?.closest('div');
        if (genDetailBox) {
            genDetailBox.style.background = palette.detailBg;
            genDetailBox.style.color = palette.detailText;
        }
        configPanel.querySelectorAll('#ai-input-key, #ai-url, #ai-model-name, #ai-gen-context-window, #ai-gen-max-output, [id^="ai-param-"]').forEach(el => {
            el.style.background = palette.inputBg;
            el.style.color = palette.inputText;
            el.style.borderColor = palette.inputBorder;
        });
        chatBody.style.background = palette.chatBg;
        chatBody.style.color = palette.chatText;
        if (autocomplete) {
            autocomplete.style.background = palette.detailBg;
            autocomplete.style.color = palette.detailText;
            autocomplete.style.borderTopColor = palette.windowBorder;
        }
        inputWrap.style.background = palette.windowBg;
        inputWrap.style.borderTopColor = palette.windowBorder;
        inputText.style.background = palette.inputBg;
        inputText.style.color = palette.inputText;
        inputText.style.borderColor = palette.inputBorder;
        status.style.background = palette.statusBg;
        status.style.color = palette.statusText;
    }

    _ensureAdvancedStyles() {
        if (document.getElementById('ai-advanced-style')) return;
        const style = document.createElement('style');
        style.id = 'ai-advanced-style';
        style.textContent = `
            .ai-advanced-overlay {
                position: fixed;
                inset: 0;
                background: rgba(0, 0, 0, 0.82);
                display: none;
                z-index: 1000001;
                justify-content: center;
                align-items: flex-start;
                overflow-y: auto;
                padding: 20px 0;
            }
            .ai-advanced-dialog {
                width: min(960px, 94vw);
                background: #111827;
                color: #e5e7eb;
                border: 1px solid #334155;
                border-radius: 12px;
                box-shadow: 0 18px 50px rgba(0, 0, 0, 0.45);
                padding: 18px;
                display: flex;
                flex-direction: column;
                gap: 14px;
                margin: auto;
                max-height:100%;
                overflow:auto;
            }
            .ai-advanced-row,
            .ai-advanced-tools-header,
            .ai-advanced-tool-item,
            .ai-advanced-footer {
                display: flex;
                gap: 10px;
                align-items: center;
                justify-content: space-between;
            }
            .ai-advanced-stack {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ai-advanced-label {
                font-size: 12px;
                font-weight: bold;
                color: #93c5fd;
            }
            .ai-advanced-textarea,
            .ai-advanced-input {
                width: 100%;
                box-sizing: border-box;
                border-radius: 8px;
                border: 1px solid #475569;
                background: #020617;
                color: #e2e8f0;
                padding: 10px;
                font-size: 13px;
                font-family: inherit;
            }
            .ai-advanced-textarea {
                min-height: 150px;
                resize: vertical;
                line-height: 1.45;
            }
            .ai-code-editor {
                display: grid;
                grid-template-columns: 46px 1fr;
                border: 1px solid #475569;
                border-radius: 8px;
                overflow: hidden;
                background: #020617;
                min-height: 220px;
            }
            .ai-code-editor-lines {
                margin: 0;
                padding: 12px 8px;
                background: #0f172a;
                color: #64748b;
                text-align: right;
                font: 13px/1.5 monospace;
                user-select: none;
                overflow: hidden;
                white-space: pre;
            }
            .ai-code-editor-stage {
                position: relative;
                min-height: 220px;
                overflow: hidden;
            }
            .ai-code-editor-highlight,
            .ai-code-editor-input {
                margin: 0;
                padding: 12px;
                font: 13px/1.5 monospace;
                white-space: pre;
                overflow: auto;
                box-sizing: border-box;
                width: 100%;
                height: 100%;
                min-height: 220px;
            }
            .ai-code-editor-highlight {
                pointer-events: none;
                color: #e2e8f0;
            }
            .ai-code-editor-input {
                position: absolute;
                inset: 0;
                border: 0;
                resize: none;
                background: transparent;
                color: transparent;
                caret-color: #f8fafc;
                text-shadow: 0 0 0 #e2e8f0;
            }
            .ai-code-editor-input:focus {
                outline: none;
            }
            .ai-token-keyword { color: #93c5fd; }
            .ai-token-string { color: #86efac; }
            .ai-token-number { color: #fca5a5; }
            .ai-token-comment { color: #94a3b8; font-style: italic; }
            .ai-tool-list {
                display: flex;
                flex-direction: column;
                gap: 8px;
            }
            .ai-advanced-tool-item {
                border: 1px solid #334155;
                border-radius: 8px;
                padding: 10px 12px;
                background: #0f172a;
                align-items: flex-start;
            }
            .ai-advanced-tool-name {
                font-weight: bold;
                color: #f8fafc;
            }
            .ai-advanced-tool-desc {
                font-size: 12px;
                color: #cbd5e1;
                margin-top: 4px;
                white-space: pre-wrap;
            }
            .ai-advanced-tool-empty {
                border: 1px dashed #475569;
                border-radius: 8px;
                padding: 12px;
                color: #94a3b8;
                text-align: center;
            }
            .ai-advanced-btn {
                padding: 7px 12px;
                border-radius: 8px;
                border: 1px solid #475569;
                background: #1e293b;
                color: #f8fafc;
                cursor: pointer;
            }
            .ai-advanced-btn.primary {
                background: #2563eb;
                border-color: #2563eb;
            }
            .ai-advanced-btn.danger {
                background: #7f1d1d;
                border-color: #991b1b;
            }
            @media (max-width: 700px) {
                .ai-advanced-dialog {
                    width: 96vw;
                    padding: 14px;
                }
                .ai-advanced-row,
                .ai-advanced-tools-header,
                .ai-advanced-tool-item,
                .ai-advanced-footer {
                    flex-direction: column;
                    align-items: stretch;
                }
                .ai-code-editor {
                    grid-template-columns: 38px 1fr;
                }
            }
            .ai-rag-table {
                width: 100%;
                border-collapse: collapse;
                font-size: 12px;
            }
            .ai-rag-table th,
            .ai-rag-table td {
                padding: 6px 8px;
                border: 1px solid #334155;
                text-align: left;
                word-break: break-all;
                vertical-align: top;
            }
            .ai-rag-table th {
                background: #0f172a;
                color: #93c5fd;
                font-weight: bold;
                position: sticky;
                top: 0;
                z-index: 1;
            }
            .ai-rag-table tr:nth-child(even) td { background: #0f172a; }
            .ai-rag-table tr:hover td { background: #1e293b; }
            .ai-rag-table td.ai-rag-content { max-width: 300px; cursor: pointer; }
            .ai-rag-table-wrap {
                max-height: 360px;
                overflow-y: auto;
                border: 1px solid #334155;
                border-radius: 8px;
            }
            .ai-rag-score { color: #86efac; font-family: monospace; }
            .ai-rag-id { color: #fca5a5; font-family: monospace; }
            .ai-rag-edit-form {
                display: flex;
                flex-direction: column;
                gap: 10px;
            }
        `;
        document.head.appendChild(style);
    }

    // tw_stock_db客製: AI回覆原本是用document.createTextNode塞純文字，模型
    // 輸出的markdown（表格、清單、粗體等）完全沒有被解析，可讀性很差。這裡
    // 加一組通用的markdown內容排版樣式，給marked.parse()產生的HTML用
    // （見_renderSingleMessage裡的.ai-markdown-body）。
    _ensureMarkdownStyles() {
        if (document.getElementById('ai-markdown-style')) return;
        const style = document.createElement('style');
        style.id = 'ai-markdown-style';
        style.textContent = `
            .ai-markdown-body { line-height: 1.6; }
            .ai-markdown-body p { margin: 0 0 8px; }
            .ai-markdown-body p:last-child { margin-bottom: 0; }
            .ai-markdown-body ul, .ai-markdown-body ol { margin: 4px 0 8px; padding-left: 22px; }
            .ai-markdown-body li { margin-bottom: 2px; }
            .ai-markdown-body h1, .ai-markdown-body h2, .ai-markdown-body h3,
            .ai-markdown-body h4, .ai-markdown-body h5, .ai-markdown-body h6 {
                margin: 10px 0 6px; font-weight: bold; line-height: 1.3;
            }
            .ai-markdown-body h1 { font-size: 1.25em; }
            .ai-markdown-body h2 { font-size: 1.15em; }
            .ai-markdown-body h3 { font-size: 1.05em; }
            .ai-markdown-body table {
                border-collapse: collapse; margin: 8px 0; font-size: 0.95em;
                max-width: 100%; display: block; overflow-x: auto;
            }
            .ai-markdown-body th, .ai-markdown-body td {
                border: 1px solid rgba(128,128,128,0.4); padding: 4px 8px; text-align: left;
            }
            .ai-markdown-body th { background: rgba(128,128,128,0.15); font-weight: bold; }
            .ai-markdown-body code {
                font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
                background: rgba(128,128,128,0.15); padding: 1px 5px; border-radius: 4px; font-size: 0.9em;
            }
            .ai-markdown-body pre {
                background: rgba(128,128,128,0.15); padding: 8px 10px; border-radius: 6px;
                overflow-x: auto; margin: 6px 0;
            }
            .ai-markdown-body pre code { background: none; padding: 0; }
            .ai-markdown-body blockquote {
                border-left: 3px solid rgba(128,128,128,0.5); margin: 6px 0; padding: 2px 10px;
                color: inherit; opacity: 0.85;
            }
            .ai-markdown-body a { color: #3182ce; text-decoration: underline; }
            .ai-markdown-body hr { border: none; border-top: 1px solid rgba(128,128,128,0.3); margin: 10px 0; }
            .ai-markdown-body .katex-display { overflow-x: auto; overflow-y: hidden; margin: 8px 0; }
            .ai-markdown-body .katex { font-size: 1.05em; }
        `;
        document.head.appendChild(style);
    }

    // tw_stock_db客製: 用marked.js把assistant的markdown文字轉成HTML、再用
    // DOMPurify消毒過濾掉<script>/on*事件屬性等，避免模型輸出（或被工具結果
    // 間接帶進來的內容）挾帶惡意HTML造成XSS。兩個都是輕量單檔CDN函式庫，第
    // 一次用到才載入（見_initUI()裡mount時就先背景觸發，不用等第一則訊息才
    // 開始載入）。載入失敗（離線等情況）會靜默跳過，畫面退回純文字顯示，不
    // 影響其他功能。
    _ensureMarkdownLibsLoaded() {
        if (this._markdownLibsPromise) return this._markdownLibsPromise;
        const loadScript = (src) => new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src;
            s.onload = () => resolve();
            s.onerror = () => reject(new Error('載入失敗: ' + src));
            document.head.appendChild(s);
        });
        const loadStyle = (href) => new Promise((resolve, reject) => {
            const l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = href;
            l.onload = () => resolve();
            l.onerror = () => reject(new Error('載入失敗: ' + href));
            document.head.appendChild(l);
        });
        // tw_stock_db客製: KaTeX用來把AI回覆裡的LaTeX數學語法（$...$/$$...$$）
        // 排版成正式的數學符號，見_renderMarkdownWithMath()。跟marked/
        // DOMPurify一樣是輕量單檔CDN函式庫，一起在mount時背景預載。
        this._markdownLibsPromise = Promise.all([
            typeof marked === 'undefined' ? loadScript('https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js') : Promise.resolve(),
            typeof DOMPurify === 'undefined' ? loadScript('https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js') : Promise.resolve(),
            typeof katex === 'undefined' ? loadScript('https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js') : Promise.resolve(),
            document.getElementById('ai-katex-style') ? Promise.resolve() : loadStyle('https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css').then(() => {
                const link = document.querySelector('link[href*="katex.min.css"]');
                if (link) link.id = 'ai-katex-style';
            }),
        ]).then(() => {
            if (typeof marked !== 'undefined' && marked.setOptions) {
                marked.setOptions({ gfm: true, breaks: true });
            }
        }).catch(err => {
            console.warn('Markdown/KaTeX函式庫載入失敗，AI回覆將以純文字顯示:', err);
            this._markdownLibsPromise = null; // 允許之後（例如網路恢復）重試
        });
        return this._markdownLibsPromise;
    }

    // tw_stock_db客製: marked.js本身不懂LaTeX語法，直接丟給它解析$...$只會
    // 被當成普通文字（或被裡面的_/*等符號誤判成粗體/斜體，排版更亂）。這裡
    // 在跑markdown解析「之前」，先把$$...$$（區塊公式）跟$...$（行內公式）
    // 抽出來，用katex.renderToString()各自轉成純HTML（output:'html'，不產生
    // MathML，避免後面DOMPurify消毒時要另外處理MathML標籤的相容性問題），
    // 暫時用不會被markdown語法誤判的佔位字串取代，跑完marked.parse()以後再
    // 把佔位字串換回真正的KaTeX HTML。任何一段LaTeX解析失敗（模型輸出的
    // 語法有誤）不影響其他段落，失敗的那一段原樣保留文字，不會讓整則訊息
    // 都不能顯示。
    _renderMarkdownWithMath(text) {
        if (typeof katex === 'undefined') return marked.parse(text);
        const mathHtmlList = [];
        const stash = (expr, displayMode) => {
            let html;
            try {
                html = katex.renderToString(expr, { throwOnError: false, displayMode, output: 'html' });
            } catch (err) {
                html = displayMode ? `$$${expr}$$` : `$${expr}$`;
            }
            mathHtmlList.push(html);
            return `@@TWSTOCKDB_MATH_${mathHtmlList.length - 1}@@`;
        };
        let withPlaceholders = text
            .replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => stash(expr, true))
            .replace(/(?<!\$)\$(?!\$)([^\n$]+?)\$(?!\$)/g, (_, expr) => stash(expr, false));
        let html = marked.parse(withPlaceholders);
        html = html.replace(/@@TWSTOCKDB_MATH_(\d+)@@/g, (_, idx) => mathHtmlList[Number(idx)] || '');
        return html;
    }

    _buildCodeEditorHtml(id, minHeight = 220) {
        return `
            <div class="ai-code-editor" data-editor-id="${id}" style="min-height:${minHeight}px;">
                <pre class="ai-code-editor-lines"></pre>
                <div class="ai-code-editor-stage">
                    <pre class="ai-code-editor-highlight"></pre>
                    <textarea id="${id}" class="ai-code-editor-input" spellcheck="false" wrap="off"></textarea>
                </div>
            </div>
        `;
    }

    _escapeHtml(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    _escapeAttr(text) {
        return String(text || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    _highlightJavaScript(code) {
        const text = String(code || '');
        const keywords = new Set(['async', 'await', 'break', 'case', 'catch', 'class', 'const', 'continue', 'default', 'delete', 'else', 'export', 'extends', 'finally', 'for', 'function', 'if', 'import', 'let', 'new', 'null', 'return', 'switch', 'throw', 'try', 'typeof', 'var', 'while', 'yield', 'true', 'false']);
        let html = '';
        let index = 0;
        while (index < text.length) {
            const ch = text[index];
            const next = text[index + 1];
            if (ch === '/' && next === '/') {
                let end = text.indexOf('\n', index);
                if (end === -1) end = text.length;
                html += `<span class="ai-token-comment">${this._escapeHtml(text.slice(index, end))}</span>`;
                index = end;
                continue;
            }
            if (ch === '/' && next === '*') {
                let end = text.indexOf('*/', index + 2);
                end = end === -1 ? text.length : end + 2;
                html += `<span class="ai-token-comment">${this._escapeHtml(text.slice(index, end))}</span>`;
                index = end;
                continue;
            }
            if (ch === '"' || ch === '\'' || ch === '`') {
                const quote = ch;
                let end = index + 1;
                while (end < text.length) {
                    if (text[end] === '\\') {
                        end += 2;
                        continue;
                    }
                    if (text[end] === quote) {
                        end += 1;
                        break;
                    }
                    end += 1;
                }
                html += `<span class="ai-token-string">${this._escapeHtml(text.slice(index, end))}</span>`;
                index = end;
                continue;
            }
            if (/\d/.test(ch)) {
                let end = index + 1;
                while (end < text.length && /[\d.]/.test(text[end])) end += 1;
                html += `<span class="ai-token-number">${this._escapeHtml(text.slice(index, end))}</span>`;
                index = end;
                continue;
            }
            if (/[A-Za-z_$]/.test(ch)) {
                let end = index + 1;
                while (end < text.length && /[\w$]/.test(text[end])) end += 1;
                const token = text.slice(index, end);
                html += keywords.has(token)
                    ? `<span class="ai-token-keyword">${this._escapeHtml(token)}</span>`
                    : this._escapeHtml(token);
                index = end;
                continue;
            }
            html += this._escapeHtml(ch);
            index += 1;
        }
        return html || '&nbsp;';
    }

    _syncCodeEditor(editor) {
        if (!editor) return;
        const textarea = editor.querySelector('.ai-code-editor-input');
        const highlight = editor.querySelector('.ai-code-editor-highlight');
        const lines = editor.querySelector('.ai-code-editor-lines');
        if (!textarea || !highlight || !lines) return;
        const value = textarea.value || '';
        const lineCount = Math.max(1, value.split('\n').length);
        lines.textContent = Array.from({ length: lineCount }, (_, index) => index + 1).join('\n');
        highlight.innerHTML = this._highlightJavaScript(value) + '\n';
        highlight.scrollTop = textarea.scrollTop;
        highlight.scrollLeft = textarea.scrollLeft;
        lines.scrollTop = textarea.scrollTop;
    }

    _syncAllCodeEditors() {
        document.querySelectorAll('.ai-code-editor').forEach(editor => this._syncCodeEditor(editor));
    }

    _openAdvancedModal() {
        const modal = document.getElementById('ai-advanced-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        this._renderAdvancedSettings();
    }

    _closeAdvancedModal() {
        const modal = document.getElementById('ai-advanced-modal');
        if (modal) modal.style.display = 'none';
    }

    _isModalOpen(modal) {
        return !!(modal && modal.style.display === 'flex');
    }

    _openToolEditor(index = -1) {
        const modal = document.getElementById('ai-tool-editor-modal');
        if (!modal) return;
        this.activeToolEditIndex = Number.isInteger(index) ? index : -1;
        const tool = this.activeToolEditIndex >= 0
            ? this.advancedSettings.customTools[this.activeToolEditIndex]
            : null;
        const nameInput = document.getElementById('ai-tool-name-input');
        const descInput = document.getElementById('ai-tool-desc-input');
        const scriptInput = document.getElementById('ai-tool-script-input');
        if (!nameInput || !descInput || !scriptInput) return;
        nameInput.value = tool ? tool.name : this._createTimestampedToolName();
        descInput.value = tool ? tool.description : '';
        scriptInput.value = tool ? tool.handlerScript : this._getDefaultToolHandlerScript();
        modal.style.display = 'flex';
        this._syncCodeEditor(scriptInput.closest('.ai-code-editor'));
    }

    _closeToolEditor() {
        const modal = document.getElementById('ai-tool-editor-modal');
        if (modal) modal.style.display = 'none';
        this.activeToolEditIndex = -1;
    }

    _renderCustomToolList() {
        const list = document.getElementById('ai-custom-tool-list');
        if (!list) return;
        const tools = this.advancedSettings.customTools;
        if (!tools.length) {
            list.innerHTML = `<div class="ai-advanced-tool-empty">尚未新增自訂 tool。</div>`;
            return;
        }
        list.innerHTML = tools.map((tool, index) => `
            <div class="ai-advanced-tool-item">
                <div style="flex:1; min-width:0;">
                    <div class="ai-advanced-tool-name">${this._escapeHtml(tool.name)}</div>
                    <div class="ai-advanced-tool-desc">${this._escapeHtml(tool.description || 'No description provided.')}</div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button type="button" class="ai-advanced-btn" data-tool-edit="${index}">修改</button>
                    <button type="button" class="ai-advanced-btn danger" data-tool-delete="${index}">刪除</button>
                </div>
            </div>
        `).join('');
    }

    _renderAdvancedSettings() {
        const rulesInput = document.getElementById('ai-rules-input');
        const functionsInput = document.getElementById('ai-custom-functions-input');
        if (rulesInput) rulesInput.value = this.advancedSettings.rulesMd || '';
        if (functionsInput) functionsInput.value = this.advancedSettings.customFunctions || '';
        this._renderCustomToolList();
        this._renderAiFnList();
        this._renderGenerationSettingsUI();
        this._syncAllCodeEditors();
    }

    // tw_stock_db客製: 把 advancedSettings.generation 目前的值同步進設定
    // 面板的輸入框，並顯示哪些取樣參數已經因為被端點拒絕而自動排除
    // （見 _disableRejectedSamplingParam）。
    _renderGenerationSettingsUI() {
        const gen = this._getGenerationSettings();
        const ctxInput = document.getElementById('ai-gen-context-window');
        if (ctxInput) ctxInput.value = gen.contextWindowTokens;
        const maxOutInput = document.getElementById('ai-gen-max-output');
        if (maxOutInput) maxOutInput.value = gen.maxOutputTokens;
        const disabledKeys = [];
        SAMPLING_PARAM_KEYS.forEach(key => {
            const input = document.getElementById(`ai-param-${key}`);
            const entry = gen.samplingParams[key];
            if (input) {
                input.value = entry.value != null ? entry.value : '';
                input.title = entry.disabled ? '此端點曾拒絕這個參數，已自動排除；重新輸入值會再試一次' : '';
            }
            if (entry.disabled) disabledKeys.push(key);
        });
        const note = document.getElementById('ai-param-disabled-note');
        if (note) note.textContent = disabledKeys.length ? `⚠️ 已自動排除（端點不支援）：${disabledKeys.join('、')}` : '';
    }

    _renderAiFnList() {
        const list = document.getElementById('ai-fn-list');
        if (!list) return;
        const fns = this.advancedSettings.aiCustomFunctions || {};
        const entries = Object.entries(fns);
        if (!entries.length) {
            list.innerHTML = `<div class="ai-advanced-tool-empty">尚未有AI自製函式。</div>`;
            return;
        }
        list.innerHTML = entries.map(([name, fn]) => `
            <div class="ai-advanced-tool-item">
                <div style="flex:1; min-width:0;">
                    <div class="ai-advanced-tool-name">${this._escapeHtml(name)}</div>
                    <div class="ai-advanced-tool-desc">${this._escapeHtml(fn.description || '無描述。')}</div>
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap;">
                    <button type="button" class="ai-advanced-btn primary" data-ai-fn-run="${this._escapeAttr(name)}">執行</button>
                    <button type="button" class="ai-advanced-btn" data-ai-fn-edit="${this._escapeAttr(name)}">修改</button>
                    <button type="button" class="ai-advanced-btn danger" data-ai-fn-delete="${this._escapeAttr(name)}">刪除</button>
                </div>
            </div>
        `).join('');
    }

    async _runAiFunctionPrompt(fnName) {
        const displayName = String(fnName || '').replace(/[\r\n]+/g, ' ').trim();
        const rawArgs = prompt(`執行 AI 函式「${displayName}」\n請輸入 JSON 參數（可留空）`, '{}');
        if (rawArgs === null) return;
        let parsedArgs = {};
        try {
            const text = String(rawArgs || '').trim();
            parsedArgs = text ? await this.repairJsonPayload(text) : {};
        } catch (err) {
            alert('無法解析 JSON 參數，請確認格式正確。');
            return;
        }
        try {
            const result = await this.callFromAI(fnName, parsedArgs);
            const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            alert(`AI函式「${displayName}」執行成功：\n${output}`);
            this._log(`已手動執行AI函式: ${displayName}`);
        } catch (err) {
            alert(`AI函式「${displayName}」執行失敗：${err.message || err}`);
        }
    }

    _openAiFnModal() {
        const modal = document.getElementById('ai-fn-modal');
        if (!modal) return;
        this._renderAiFnList();
        modal.style.display = 'flex';
    }

    _closeAiFnModal() {
        const modal = document.getElementById('ai-fn-modal');
        if (modal) modal.style.display = 'none';
    }

    _openAiFnEditor(name = '') {
        const modal = document.getElementById('ai-fn-editor-modal');
        if (!modal) return;
        const nameInput = document.getElementById('ai-fn-name-input');
        const descInput = document.getElementById('ai-fn-desc-input');
        const codeInput = document.getElementById('ai-fn-code-input');
        if (!nameInput || !descInput || !codeInput) return;
        const fns = this.advancedSettings.aiCustomFunctions || {};
        const fn = name && Object.prototype.hasOwnProperty.call(fns, name) ? fns[name] : null;
        nameInput.value = fn ? name : '';
        nameInput.dataset.originalName = fn ? name : '';
        descInput.value = fn ? fn.description : '';
        codeInput.value = fn ? fn.code : '// 在此撰寫函式體\n// 參數: args (object)\n// 使用 return 回傳結果\nreturn JSON.stringify({ ok: true });';
        modal.style.display = 'flex';
        this._syncCodeEditor(codeInput.closest('.ai-code-editor'));
    }

    _closeAiFnEditor() {
        const modal = document.getElementById('ai-fn-editor-modal');
        if (modal) modal.style.display = 'none';
    }

    // ---- RAG 記憶庫管理 ----

    _openRagModal() {
        const modal = document.getElementById('ai-rag-modal');
        if (!modal) return;
        modal.style.display = 'flex';
        this._renderRagTable([]);
        this._loadAndRenderRag();
    }

    _closeRagModal() {
        const modal = document.getElementById('ai-rag-modal');
        if (modal) modal.style.display = 'none';
    }

    _setRagStatus(msg) {
        const el = document.getElementById('ai-rag-status');
        if (el) el.textContent = msg || '';
    }

    async _loadAndRenderRag(keyword) {
        this._setRagStatus('載入中...');
        try {
            const records = keyword
                ? await this.ragSystem.search(keyword)
                : await this.ragSystem.getAll();
            this._renderRagTable(records);
            this._setRagStatus("共 " + records.length + " 筆記錄");
        } catch (err) {
            this._setRagStatus('載入失敗: ' + (err.message || err));
        }
    }

    async _queryAndRenderRag(queryText) {
        this._setRagStatus('圖譜語意查詢中...');
        try {
            const results = await this.ragSystem.query(queryText, 50);
            this._renderRagTable(results, true);
            this._setRagStatus("查詢到 " + results.length + " 筆相關依賴鏈記錄");
        } catch (err) {
            this._setRagStatus('查詢失敗: ' + (err.message || err));
        }
    }

    _renderRagTable(records, showScore = false) {
        const tbody = document.getElementById('ai-rag-table-body');
        if (!tbody) return;
        if (!records.length) {
            tbody.innerHTML = `<tr><td colspan="6" style="text-align:center; color:#94a3b8; padding:16px;">無記錄</td></tr>`;
            return;
        }
        const RAG_PREVIEW_LENGTH = 120;
        tbody.innerHTML = records.map(r => {
            const contentText = String(r.content || '');
            const contentAttr = this._escapeAttr(contentText);
            const contentHtml = this._escapeHtml(contentText);
            const preview = contentHtml.length > RAG_PREVIEW_LENGTH ? contentHtml.slice(0, RAG_PREVIEW_LENGTH) + '…' : contentHtml;
            
            let score = '—';
            if (typeof r.score === 'number') {
                score = r.score > 0 
                    ? `<span class="ai-rag-score">${(r.score * 100).toFixed(1)}%</span>`
                    : '<span style="color:#a855f7;">依賴鏈入</span>';
            }

            const ts = r.timestamp ? new Date(r.timestamp).toLocaleString() : '—';
            
            let tagBadge = '';
            if (r.tags && r.tags.includes('skill')) {
                tagBadge = ' <span style="background:#10b981; color:#fff; font-size:9px; padding:1px 4px; border-radius:3px;">SKILL</span>';
            } else if (r.tags && r.tags.includes('user_preference')) {
                tagBadge = ' <span style="background:#3b82f6; color:#fff; font-size:9px; padding:1px 4px; border-radius:3px;">PREF</span>';
            } else if (r.tags && r.tags.includes('document_section')) {
                tagBadge = ' <span style="background:#8b5cf6; color:#fff; font-size:9px; padding:1px 4px; border-radius:3px;">SECTION</span>';
            }

            let depLabel = '';
            if (r.dependencies && r.dependencies.length > 0) {
                depLabel = " <span style=\"color:#94a3b8; font-size:10px;\">(🔗 " + r.dependencies.join(', ') + ")</span>";
            }

            return `<tr data-rag-id="${r.id}">
                <td><input type="checkbox" class="ai-rag-row-check" data-rag-id="${r.id}"></td>
                <td class="ai-rag-id" style="font-size:11px;">${r.id}</td>
                <td class="ai-rag-content" title="${contentAttr}" style="cursor:pointer;">${preview}${tagBadge}${depLabel}</td>
                <td>${score}</td>
                <td>${this._escapeHtml(String(r.source || ''))}</td>
                <td style="font-size:11px; white-space:nowrap;">${ts}</td>
            </tr>`;
        }).join('');
        
        tbody.ondblclick = (e) => {
            const td = e.target.closest('.ai-rag-content');
            if (!td) return;
            const tr = td.closest('tr[data-rag-id]');
            if (tr) this._openRagEditor(tr.dataset.ragId);
        };
        
        const selectAll = document.getElementById('ai-rag-select-all');
        if (selectAll) selectAll.checked = false;
    }

    _openRagEditor(id = null) {
        const modal = document.getElementById('ai-rag-editor-modal');
        if (!modal) return;
        this.activeRagEditId = id;
        const title = document.getElementById('ai-rag-editor-title');
        const idLabel = document.getElementById('ai-rag-edit-id-label');
        const contentEl = document.getElementById('ai-rag-edit-content');
        const sourceEl = document.getElementById('ai-rag-edit-source');
        const tagsEl = document.getElementById('ai-rag-edit-tags');
        if (id !== null) {
            title.textContent = "編輯 RAG/技能圖譜節點 (id=" + id + ")";
            idLabel.textContent = "id: " + id;
            this.ragSystem.get(id).then(r => {
                if (!r) { alert('找不到記錄 id=' + id); return; }
                if (contentEl) contentEl.value = r.content || '';
                if (sourceEl) sourceEl.value = r.source || 'manual';
                
                const metaTags = [];
                if (r.tags) metaTags.push(r.tags);
                if (r.dependencies && r.dependencies.length > 0) metaTags.push("deps:" + r.dependencies.join(','));
                if (r.preConditions && r.preConditions.length > 0) metaTags.push("conds:" + r.preConditions.join(','));
                if (tagsEl) tagsEl.value = metaTags.join('; ');
            }).catch(err => {
                this._log("記錄載入失敗: " + (err.message || err));
            });
        } else {
            title.textContent = '新增圖譜知識節點';
            idLabel.textContent = '';
            if (contentEl) contentEl.value = '';
            if (sourceEl) sourceEl.value = 'manual';
            if (tagsEl) tagsEl.value = 'skill';
        }
        modal.style.display = 'flex';
    }

    _closeRagEditor() {
        const modal = document.getElementById('ai-rag-editor-modal');
        if (modal) modal.style.display = 'none';
        this.activeRagEditId = null;
    }

    async _saveRagRecord() {
        const contentEl = document.getElementById('ai-rag-edit-content');
        const sourceEl = document.getElementById('ai-rag-edit-source');
        const tagsEl = document.getElementById('ai-rag-edit-tags');
        const content = (contentEl ? contentEl.value : '').trim();
        if (!content) { alert('內文不能為空。'); return; }
        
        let tagsInput = tagsEl ? tagsEl.value.trim() : '';
        let finalTags = 'skill';
        let dependencies = [];
        let preConditions = [];

        const parts = tagsInput.split(';').map(p => p.trim());
        const cleanTags = [];
        parts.forEach(p => {
            if (p.startsWith('deps:')) {
                dependencies = p.replace('deps:', '').split(',').map(d => d.trim()).filter(Boolean);
            } else if (p.startsWith('conds:')) {
                preConditions = p.replace('conds:', '').split(',').map(c => c.trim()).filter(Boolean);
            } else if (p) {
                cleanTags.push(p);
            }
        });
        if (cleanTags.length > 0) finalTags = cleanTags.join(',');

        const meta = {
            id: this.activeRagEditId || undefined,
            dependencies,
            preConditions,
            source: sourceEl ? sourceEl.value.trim() : 'manual',
            tags: finalTags
        };

        try {
            if (this.activeRagEditId !== null) {
                await this.ragSystem.update(this.activeRagEditId, { content, dependencies, preConditions, source: meta.source, tags: finalTags });
                this._log("已更新節點 id=" + this.activeRagEditId);
            } else {
                const newId = await this.ragSystem.add(content, meta);
                this._log("已新增節點 id=" + newId);
            }
            this._closeRagEditor();
            await this._loadAndRenderRag();
        } catch (err) {
            alert('儲存失敗: ' + (err.message || err));
        }
    }

    async _deleteSelectedRagRecords() {
        const checks = document.querySelectorAll('.ai-rag-row-check:checked');
        if (!checks.length) { alert('請先勾選要刪除的記錄。'); return; }
        const ids = Array.from(checks).map(c => c.dataset.ragId);
        if (!confirm("確定刪除 " + ids.length + " 筆 RAG 記錄？")) return;
        try {
            await this.ragSystem.deleteMany(ids);
            this._log("已刪除 " + ids.length + " 筆記錄");
            await this._loadAndRenderRag();
        } catch (err) {
            alert('刪除失敗: ' + (err.message || err));
        }
    }

    async _exportRag() {
        try {
            const jsonStr = await this.ragSystem.exportAll();
            const blob = new Blob([jsonStr], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'rag-records.json';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            alert('匯出失敗: ' + (err.message || err));
        }
    }

    _importRag(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = async (e) => {
            try {
                const mode = confirm('是否先清空記錄再匯入？（按取消則合併）') ? 'replace' : 'merge';
                const ids = await this.ragSystem.importAll(e.target.result, mode);
                this._log("已匯入 " + ids.length + " 筆圖譜節點記錄");
                await this._loadAndRenderRag();
                alert("成功匯入 " + ids.length + " 筆記錄！");
            } catch (err) {
                alert('匯入失敗: ' + (err.message || err));
            }
        };
        reader.readAsText(file);
    }

    _exportSettings() {
        const config = {
            apiUrl: localStorage.getItem(this.LLM_BASE_URL_KEY) || '',
            apiToken: localStorage.getItem(this.STORAGE_KEY) || '',
            modelName: localStorage.getItem(this.LLM_MODEL_NAME_KEY) || '',
            advancedSettings: JSON.parse(JSON.stringify(this.advancedSettings))
        };
        const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'ai-assistant-settings.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    }

    _importSettings(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (e) => {
            try {
                const config = JSON.parse(e.target.result);
                if (typeof config.apiUrl === 'string') localStorage.setItem(this.LLM_BASE_URL_KEY, config.apiUrl);
                if (typeof config.apiToken === 'string') localStorage.setItem(this.STORAGE_KEY, config.apiToken);
                if (typeof config.modelName === 'string') localStorage.setItem(this.LLM_MODEL_NAME_KEY, config.modelName);
                if (config.advancedSettings && typeof config.advancedSettings === 'object') {
                    this.advancedSettings = this._normalizeAdvancedSettings(config.advancedSettings);
                    this._saveAdvancedSettings();
                    this._syncFromAI();
                }
                const keyInput = document.getElementById('ai-input-key');
                const urlInput = document.getElementById('ai-url');
                const modelInput = document.getElementById('ai-model-name');
                if (keyInput && typeof config.apiToken === 'string') keyInput.value = config.apiToken;
                if (urlInput && typeof config.apiUrl === 'string') urlInput.value = config.apiUrl;
                if (modelInput && typeof config.modelName === 'string') modelInput.value = config.modelName;
                this._renderAdvancedSettings();
                alert('設定已成功匯入！');
            } catch (err) {
                alert('匯入失敗：' + err.message);
            }
        };
        reader.readAsText(file);
    }

    // tw_stock_db客製: .skill (zip) 匯出/匯入。格式是這個專案自訂的（沒有
    // 業界標準可循）：zip內含 SKILL.md（純文字，匯入時附加進rulesMd）+
    // 選填的 tools/*.js（每個檔案代表一個customTool，開頭兩行用
    // "// name: xxx"/"// description: xxx" 宣告中繼資料，其餘內容是
    // handlerScript本體），跟 advancedSettings.customTools 現有的
    // {name, description, handlerScript} 結構直接對應。需要JSZip（由
    // web/index.html動態載入CDN版本），沒載入的話兩個方法都會提示使用者。
    // tw_stock_db客製: JSZip只有使用者真的按了匯入/匯出.skill才需要，平常
    // 不會用到這個功能的使用者不用多背這個CDN依賴，所以用得到才動態注入
    // <script>標籤，而不是像sql.js那樣一開始就無條件載入。載入結果快取在
    // this._jszipLoadPromise，避免使用者連續點兩次按鈕重複注入。
    _ensureJSZipLoaded() {
        if (typeof JSZip !== 'undefined') return Promise.resolve();
        if (this._jszipLoadPromise) return this._jszipLoadPromise;
        this._jszipLoadPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
            script.onload = () => resolve();
            script.onerror = () => {
                this._jszipLoadPromise = null;
                reject(new Error('JSZip 載入失敗（可能是網路問題）'));
            };
            document.head.appendChild(script);
        });
        return this._jszipLoadPromise;
    }

    async _exportSkillZip() {
        try {
            await this._ensureJSZipLoaded();
        } catch (err) {
            alert('.skill 匯出功能需要 JSZip 函式庫：' + (err.message || err));
            return;
        }
        try {
            const zip = new JSZip();
            const rulesMd = String(this.advancedSettings.rulesMd || '').trim();
            zip.file('SKILL.md', rulesMd || '# SKILL.md\n\n（尚未填寫 RULES.md 內容）\n');
            const toolsFolder = zip.folder('tools');
            this.advancedSettings.customTools.forEach(tool => {
                const safeName = String(tool.name || 'tool').replace(/[^a-zA-Z0-9_\-]/g, '_') || 'tool';
                const description = String(tool.description || '').replace(/\r?\n/g, ' ');
                const content = `// name: ${tool.name}\n// description: ${description}\n${tool.handlerScript || ''}\n`;
                toolsFolder.file(`${safeName}.js`, content);
            });
            const blob = await zip.generateAsync({ type: 'blob' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'tw-stock-db-assistant.skill';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        } catch (err) {
            alert('.skill 匯出失敗: ' + (err.message || err));
        }
    }

    async _importSkillZip(file) {
        if (!file) return;
        try {
            await this._ensureJSZipLoaded();
        } catch (err) {
            alert('.skill 匯入功能需要 JSZip 函式庫：' + (err.message || err));
            return;
        }
        try {
            const zip = await JSZip.loadAsync(file);
            const skillMdEntry = zip.file('SKILL.md');
            let skillMdImported = false;
            if (skillMdEntry) {
                const skillMdText = (await skillMdEntry.async('string')).trim();
                if (skillMdText) {
                    const existing = String(this.advancedSettings.rulesMd || '').trim();
                    this.advancedSettings.rulesMd = existing
                        ? `${existing}\n\n---\n[來自匯入的 .skill: ${file.name}]\n${skillMdText}`
                        : skillMdText;
                    skillMdImported = true;
                }
            }

            const toolFiles = zip.file(/^tools\/.+\.js$/i);
            let importedToolCount = 0;
            let skippedBuiltinCount = 0;
            for (const entry of toolFiles) {
                const text = await entry.async('string');
                const nameMatch = text.match(/^\s*\/\/\s*name:\s*(.+)$/mi);
                const descMatch = text.match(/^\s*\/\/\s*description:\s*(.+)$/mi);
                const fallbackName = entry.name.replace(/^tools\//i, '').replace(/\.js$/i, '');
                const name = (nameMatch ? nameMatch[1] : fallbackName).trim();
                const description = descMatch ? descMatch[1].trim() : '';
                const handlerScript = text
                    .replace(/^\s*\/\/\s*name:.*$/mi, '')
                    .replace(/^\s*\/\/\s*description:.*$/mi, '')
                    .trim();
                const normalized = this._normalizeCustomTool({ name, description, handlerScript });
                if (!normalized) continue;

                if (Object.prototype.hasOwnProperty.call(this.tools, normalized.name)) {
                    console.warn(`.skill匯入略過: "${normalized.name}" 與內建工具同名，不可覆蓋。`);
                    skippedBuiltinCount++;
                    continue;
                }
                const existingIndex = this.advancedSettings.customTools.findIndex(t => t.name === normalized.name);
                if (existingIndex > -1) {
                    if (!confirm(`Skill「${normalized.name}」已存在，是否覆蓋？`)) continue;
                    this.advancedSettings.customTools.splice(existingIndex, 1, normalized);
                } else {
                    this.advancedSettings.customTools.push(normalized);
                }
                importedToolCount++;
            }

            this._saveAdvancedSettings();
            this._renderAdvancedSettings();
            this._syncFromAI();
            const parts = [];
            if (skillMdImported) parts.push('SKILL.md 已附加到 RULES.md');
            parts.push(`匯入/更新 ${importedToolCount} 個 Skill 工具`);
            if (skippedBuiltinCount) parts.push(`略過 ${skippedBuiltinCount} 個與內建工具同名的項目`);
            alert('.skill 匯入完成：' + parts.join('，'));
        } catch (err) {
            alert('.skill 匯入失敗: ' + (err.message || err));
        }
    }

    _formatElapsedTime(ms) {
        const totalSeconds = Math.max(0, Math.floor((ms || 0) / 1000));
        const seconds = String(totalSeconds % 60).padStart(2, '0');
        const minutes = String(Math.floor(totalSeconds / 60) % 60).padStart(2, '0');
        const hours = Math.floor(totalSeconds / 3600);
        return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
    }

    _renderResponseIndicator(text) {
        const indicator = document.getElementById('ai-response-indicator');
        if (!indicator) return;
        indicator.textContent = text;
    }

    _syncStopButton() {
        const stopBtn = document.getElementById('ai-stop-response-btn');
        if (!stopBtn) return;
        stopBtn.disabled = !this.isResponding;
        stopBtn.style.opacity = this.isResponding ? '1' : '0.45';
        stopBtn.style.cursor = this.isResponding ? 'pointer' : 'not-allowed';
    }

    _updateElapsedIndicator() {
        const elapsed = this.responseStartedAt
            ? Date.now() - this.responseStartedAt
            : this.responseElapsedMs;
        const label = this.responseIndicatorLabel || '⏳ AI 回應中';
        this._renderResponseIndicator(`${label} · 已經過 ${this._formatElapsedTime(elapsed)}`);
    }

    _requestStopResponse() {
        if (!this.isResponding) return;
        this.stopRequested = true;
        this._setRespondingState(true, '⏹️ 正在停止 AI 回應');
        this._log('🛑 正在停止 AI 回應...');
        if (this.currentAbortController) {
            this.currentAbortController.abort();
        }
    }

    _createAbortController() {
        const controller = new AbortController();
        this.currentAbortController = controller;
        return controller;
    }

    _setRespondingState(isResponding, extraMessage = '', finalState = 'completed') {
        this.isResponding = isResponding;
        const indicator = document.getElementById('ai-response-indicator');
        if (isResponding) {
            if (!this.responseStartedAt) this.responseStartedAt = Date.now();
            this.responseIndicatorLabel = extraMessage || '⏳ AI 回應中';
            if (!this.responseIndicatorTimer) {
                this.responseIndicatorTimer = setInterval(() => this._updateElapsedIndicator(), 1000);
            }
            this._updateElapsedIndicator();
        } else {
            this.responseElapsedMs = this.responseStartedAt
                ? Date.now() - this.responseStartedAt
                : this.responseElapsedMs;
            if (this.responseIndicatorTimer) {
                clearInterval(this.responseIndicatorTimer);
                this.responseIndicatorTimer = null;
            }
            const finalLabel = finalState === 'stopped' ? '⏹️ 已停止' : '✅ 已完成';
            this._renderResponseIndicator(`${finalLabel} · 本次耗時 ${this._formatElapsedTime(this.responseElapsedMs)}`);
            this.responseStartedAt = 0;
            this.responseIndicatorLabel = '';
            this.currentAbortController = null;
            this.stopRequested = false;
        }
        if (indicator) {
            indicator.style.opacity = isResponding ? '1' : '0.7';
        }
        this._syncStopButton();
    }

    _addSteeringMessage(userText) {
        const steeringText = String(userText || '').trim();
        if (!steeringText) return;
        this.messages.push({
            role: 'system',
            content: `[Steering] 使用者在回應中插入新方向：${steeringText}`
        });
        this._renderMessageHistory();
        this._log('🧭 已加入 Steering 指令，AI 會在下一輪回應中優先處理。');
    }

    _extractThinkingContent(content) {
        const text = String(content || '');
        const thinkTag = text.match(/<think>([\s\S]*?)<\/think>/i);
        if (thinkTag) {
            return {
                thinking: thinkTag[1].trim(),
                answer: text.replace(thinkTag[0], '').trim()
            };
        }
        const thinkBlock = text.match(/\[THINKING\]([\s\S]*?)\[\/THINKING\]/i);
        if (thinkBlock) {
            return {
                thinking: thinkBlock[1].trim(),
                answer: text.replace(thinkBlock[0], '').trim()
            };
        }
        return { thinking: '', answer: text };
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    // ============================================================
    // 🧠 核心對話與 AI 自動壓縮 (Prune) 與主題檢測機制
    // ============================================================
    
    // tw_stock_db客製: archive參數決定要不要把被壓縮掉的原始訊息存進
    // archivedDisplayBlocks（畫面上會出現一張「已封存對話」摺疊卡片）——
    // 預設false，因為這個函式主要是被400/413反應式重試路徑呼叫的「例行」
    // 壓縮（真正超過模型可用上下文才會觸發，見_loopFetch/_loopFetchNative），
    // 使用者反映這種例行壓縮跳出一整張大卡片太干擾，這裡改成安靜處理——
    // 送進API的內容照樣換成精簡版本，但畫面上不留大卡片，只留下面既有的
    // 小型[歷史對話摘要]摺疊區塊當作「已經整理過上下文」的輕量提示（性質
    // 上更接近使用者建議的「thinking/自我消化」，不是逐字保留）。只有
    // 「話題轉移」（見_checkTopicTransition）這種使用者主動切換到完全不同
    // 討論方向的情境才傳archive:true，明確留一份可回顧的封存紀錄。
    async pruneContext(reason = "Limit Exceeded", { archive = false } = {}) {
        this._log("⚠️ 觸發訊息壓縮機制 (原因: " + reason + ")...");
        const { apiKey, apiUrl, apiModel } = this._getApiConfig();

        const chatToCompress = this.messages.filter(m => m.role !== 'system');
        if (chatToCompress.length === 0) return;

        const summaryPrompt = `請將以下對話內容進行深度摘要與壓縮，字數限制在 300 個 Token 內。請保留重要的上下文、用戶意圖以及之前的關鍵結論：\n\n${JSON.stringify(chatToCompress)}`;

        try {
            const controller = this._createAbortController();
            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: apiModel,
                    messages: [{ role: "user", content: summaryPrompt }],
                    temperature: 0.3,
                    stream: false
                }),
                signal: controller.signal
            });

            if (!response.ok) throw new Error("摘要請求失敗");
            const data = await response.json();
            const summaryResult = data.choices[0]?.message?.content || "（對話已壓縮）";

            // tw_stock_db客製: 不管是不是話題轉移，被壓縮掉的原始訊息一律
            // 留著、不再真的丟棄——差別只在畫面呈現方式：archive:true（話題
            // 轉移）包成一張可摺疊的「已封存對話」卡片；archive:false（例行
            // token-limit壓縮）標記silent:true，_renderMessageHistory()會
            // 直接原樣攤開顯示，畫面上看起來像完全沒發生過壓縮。這是修正
            // 實測遇到的真實案例：使用者請AI畫走勢圖、圖表剛畫好顯示在畫面
            // 上，緊接著同一輪對話觸發例行壓縮，因為舊版這裡archive:false
            // 時完全不保留，圖表訊息物件（含圖片資料）就直接從記憶體跟畫面
            // 上一起消失，使用者反映「圖被刪掉了」。this.messages（真正送進
            // API的內容）兩種情況都一樣會換成精簡版，只有畫面顯示邏輯不同。
            this.archivedDisplayBlocks.push({ reason, messages: chatToCompress, silent: !archive });

            this.messages = [{ role: "system", content: this._getFinalSystemPrompt() }];
            this.messages.push({ role: "system", content: `[歷史對話摘要(300 tokens 內)]: ${summaryResult}` });

            this._log(archive
                ? "✅ 歷史對話壓縮完成！已釋放 Context 空間，原始內容仍可在上方封存區塊回顧。"
                : "✅ 已整理對話上下文，釋放部分 Context 空間。");
            this._renderMessageHistory();

        } catch (err) {
            if (err.name === 'AbortError' || this.stopRequested) {
                this._log('🛑 已停止 AI 回應');
                return;
            }
            this._log("❌ 壓縮失敗: " + err.message);
            // 摘要請求本身失敗時 this.messages 保持原樣不動（沒有東西被砍掉、
            // 也沒有封存）——呼叫端（_loopFetch/_loopFetchNative 的 400/413
            // 分支）不能因此就無條件遞迴重試，否則「壓縮沒解決問題→立刻重試
            // →又觸發同一個400/413→又壓縮→又失敗」會無窮迴圈，畫面上就是
            // 使用者反映的「不停閃動/一直被洗掉」，見那兩處呼叫改用有上限的
            // retryAttempt 計數，不再寫死傳1。
        }
    }

    async _checkTopicTransition(newUserPrompt) {
        const { apiKey, apiUrl, apiModel } = this._getApiConfig();
        if (this.messages.length < 3) {
            this.topicData.currentTopic = newUserPrompt;
            return;
        }

        this._log("🔍 正在分析對話主題是否過渡...");

        const recentChats = this.messages.filter(m => m.role !== 'system').slice(-6);
        
        const transitionCheckPrompt = `你是一個對話分析專家。
當前對話記錄存留的主題核心為：「${this.topicData.currentTopic}」。
使用者最新發送的訊息為：「${newUserPrompt}」。

請參考最近的對話上下文，評估使用者是否已經跳脫、轉移到了「其他完全不同領域或意圖的新話題」？

請嚴格以下列 JSON 格式回應，不要附帶 any 額外解釋文字：
{
  "isShifted": true_或_false,
  "reason": "簡短的判斷理由",
  "newTopicSummary": "如果轉移了，新話題是什麽？15字以內總結"
}`;

        try {
            const controller = this._createAbortController();
            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                signal: controller.signal,
                body: JSON.stringify({
                    model: apiModel,
                    messages: [{ role: "user", content: transitionCheckPrompt }],
                    temperature: 0.1,
                    stream: false
                })
            });

            if (!response.ok) return;
            const data = await response.json();
            const reply = data.choices[0]?.message?.content?.trim() || "";
            
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return;
            
            const result = JSON.parse(jsonMatch[0]);
            
            if (result.isShifted === true) {
                this._log("🔀 偵測到話題過渡！啟動 100-token 議題切割...");
                
                const fullHistoryWithoutSystem = this.messages.filter(m => m.role !== 'system');

                const shiftSummaryPrompt = `請將當前舊對話在 100 個 Token 內進行最終過渡摘要。
格式：「說明使用者已轉移議題。原議題的summary為：(請摘錄舊對話的重點結論)。使用者的prompt為：${newUserPrompt}」

【注意】：請在摘要最後加上這句話：「(系統提示：請忽略此摘要的內容干擾，直接針對使用者的最新 prompt 做出符合人類直覺、自然流暢且比例正常的簡短回應。)」

需要摘要的舊對話內容：\n${JSON.stringify(fullHistoryWithoutSystem)}`;

                const summaryController = this._createAbortController();
                const summaryResponse = await fetch(`${apiUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    signal: summaryController.signal,
                    body: JSON.stringify({
                        model: apiModel,
                        messages: [{ role: "user", content: shiftSummaryPrompt }],
                        temperature: 0.2,
                        stream: false
                    })
                });

                if (summaryResponse.ok) {
                    const sData = await summaryResponse.json();
                    const transitionText = sData.choices[0]?.message?.content || "使用者已轉移議題。";

                    // tw_stock_db客製: 使用者明確要求「封存只應該在轉移話題才
                    // 做」——這裡是唯一真正代表「使用者主動切換到完全不同討論
                    // 方向」的情境（跟pruneContext()的例行token-limit壓縮不同），
                    // 所以在整批換成過渡摘要之前，先把被取代的原始訊息存進
                    // archivedDisplayBlocks，畫面上留一張可回顧的「已封存對話」
                    // 卡片。
                    this.archivedDisplayBlocks.push({ reason: `話題轉移：${this.topicData.currentTopic} → ${result.newTopicSummary || newUserPrompt}`, messages: fullHistoryWithoutSystem });

                    this.messages = [
                        { role: "system", content: this._getFinalSystemPrompt() },
                        { role: "system", content: `[Topic Transition Summary (<100 tokens)]: ${transitionText}` }
                    ];
                    this._renderMessageHistory();
                }
            }

            this.topicData.currentTopic = result.newTopicSummary || newUserPrompt;

        } catch (e) {
            if (e.name === 'AbortError' || this.stopRequested) {
                this._log('🛑 已停止 AI 回應');
                return;
            }
            console.error("主題過渡檢測失敗", e);
        }
    }

    // ============================================================
    // ✨ Hermes 自我反思圖譜進化機制 (Reflective Graph-Self-Improving)
    // ============================================================
    async _hermesReflectAndEvolve(userPrompt, aiResponseText) {
        if (localStorage.getItem(this.HERMES_AUTO_EVOLVE_KEY) !== 'true') return;

        const { apiKey, apiUrl, apiModel } = this._getApiConfig();
        if (!apiKey) return;

        const alignKeywords = ['對', '沒錯', '就是這個', '完美', '可以了', '成功了', '感謝', '謝謝', 'yes', 'correct', 'perfect', 'exactly', 'solved'];
        const hasPositiveSignal = alignKeywords.some(keyword => userPrompt.toLowerCase().includes(keyword));
        
        // 使用安全拼接，避免連續反引號引發外層 parser 裂開
        const b1 = '`';
        const hasCodeSnippet = aiResponseText.includes(b1 + b1 + b1);
        const hasDeepDive = this.messages.filter(m => m.role !== 'system').length >= 6;

        if (!hasPositiveSignal && !hasCodeSnippet && !hasDeepDive) {
            return;
        }

        this._log("✨ [Hermes 反思] 偵測到知識演化契機，正在分析其依賴圖譜結構...");

        let existingNodeSummaries = "無";
        try {
            const allNodes = await this.ragSystem.getAll();
            if (allNodes.length > 0) {
                existingNodeSummaries = allNodes.slice(0, 15).map(n => `- id: ${n.id} (摘要: ${n.content.slice(0, 40)}...)`).join('\n');
            }
        } catch (_) {}

        const evaluationPrompt = `你現在是 Hermes 本地助理的「依賴圖譜 RAG 自我反思進化引擎」。
請分析以下最近的一輪對話：
【使用者輸入】: "${userPrompt}"
【助理回應】: "${aiResponseText}"

【現有本機知識節點 IDs】:
${existingNodeSummaries}

請將這個新成功的 Routine、解答或偏好萃取成一個「知識圖譜節點 (Graph Node)」。
你需要決定：
1. 它的唯一標識 ID。
2. 它的核心總結與程式碼（content）。
3. 前置依賴節點（dependencies）：它是否必須基於現有的某個 ID 才能正常運作？（例如，它是對既有代碼的升級或重構，則它必須依賴舊 ID）
4. 先決條件（preConditions）：在什麼環境、滿足何種變數或前置描述時，才調用此節點？

請嚴格以下列 JSON 格式回應，不要附帶任何額外解釋文字或 markdown 標籤：
{
  "shouldLearn": true_或_false,
  "id": "skill_或者_pref_為首的英文蛇形標識",
  "content": "要儲存的提煉知識內文（包含程式碼或精簡說明）",
  "dependencies": ["如果需要，填入關聯的現有節點 ID"],
  "preConditions": ["需要滿足的環境或先決條件描述，如 '使用 JavaScript' 或 '需要 WebGL 支援'"],
  "tags": "標籤，如 'javascript, skill'",
  "description": "這項進化記憶的摘要說明"
}`;

        try {
            const response = await fetch(`${apiUrl}/chat/completions`, {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + apiKey,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: apiModel,
                    messages: [{ role: "user", content: evaluationPrompt }],
                    temperature: 0.1,
                    stream: false
                })
            });

            if (!response.ok) return;
            const data = await response.json();
            const reply = data.choices[0]?.message?.content?.trim() || "";
            const jsonMatch = reply.match(/\{[\s\S]*\}/);
            if (!jsonMatch) return;

            const decision = JSON.parse(jsonMatch[0]);
            
            if (decision.shouldLearn === true && decision.content && decision.id) {
                const newId = await this.ragSystem.add(decision.content, {
                    id: decision.id,
                    dependencies: decision.dependencies || [],
                    preConditions: decision.preConditions || [],
                    source: `hermes_evolution:${decision.id}`,
                    tags: decision.tags || 'skill'
                });

                this._log("✨ [Hermes 進化成功] 新增圖譜節點 [id=" + newId + "]: " + decision.description + " (依賴: " + JSON.stringify(decision.dependencies) + ")");
                
                const allRecords = await this.ragSystem.getAll();
                this.ragSystem.engine.updateIDF(allRecords.map(r => r.content));
            } else {
                this._log("ℹ️ [Hermes 反思完畢] 本輪對話無須寫入圖譜。");
            }

        } catch (err) {
            console.error("Hermes 背景自我學習進化失敗", err);
            this._log("ℹ️ [Hermes 演化中斷] 反思連線不穩定。");
        }
    }

    /**
     * 執行 Stream 對話循環
     */
    async executeChat(userText) {
        const { apiKey, apiUrl, apiModel } = this._getApiConfig();
        if (this.isResponding) {
            this._addSteeringMessage(userText);
            return;
        }

        // tw_stock_db客製: 原本這裡有一個「訊息數超過20則就主動壓縮」的
        // proactive檢查——這跟先前被移除的token估算式proactive檢查是同一類
        // 問題：訊息「則數」也只是粗糙的代理指標（20則可能都是短文字、也
        // 可能其中幾則是剛畫好的走勢圖圖表），一旦誤觸發，pruneContext()會
        // 立刻把this.messages換成精簡摘要並重繪畫面，實測遇到真實案例：
        // 使用者請AI分析並畫走勢圖，圖表剛顯示出來，緊接著這個檢查在下一輪
        // 對話開始時觸發，畫面上剛貼的內容跟剛畫好的圖表就憑空消失（即使
        // pruneContext本身已經修正成不會真的遺失資料，也不該讓使用者平白
        // 多等一次不必要的摘要API呼叫）。改成完全信任_loopFetch/
        // _loopFetchNative在真正收到伺服器400/413時才反應式壓縮，不再用
        // 則數這種不準的指標搶先出手。
        if (this.messages.length === 0) {
            this.messages.push({ role: "system", content: this._getFinalSystemPrompt() });
        }

        // tw_stock_db客製: system prompt只在對話第一則訊息時建立一次（見上面
        // this.messages.length===0那段），對一個會被存檔、重新整理也不會清空
        // 的長對話來說，裡面塞的「現在幾點」「使用者目前在看哪一檔股票」這種
        // 動態資訊只要過了第一輪就整個過期。如果外部有透過options.contextProvider
        // 註冊一個取得「即時上下文」的函式（見web/index.html的renderAiTab()），
        // 這裡每一輪對話開始前都重新呼叫一次、取代掉上一輪留下的舊版本（用
        // 前綴比對過濾+splice重新插入，不是每輪都疊加一則新訊息，避免對話
        // 歷史被一堆過期的舊上下文塞爆）。
        if (typeof this.options.contextProvider === 'function') {
            try {
                const liveContext = this.options.contextProvider();
                this.messages = this.messages.filter(m => !(m.role === 'system' && m.content.startsWith('[Live Context]')));
                if (liveContext) {
                    this.messages.splice(1, 0, { role: 'system', content: `[Live Context] ${liveContext}` });
                }
            } catch (err) {
                console.warn('contextProvider執行失敗:', err);
            }
        }

        // tw_stock_db客製: 原本這裡有一個「主動式」預算檢查，在送出請求前
        // 用粗估token數跟contextWindowTokens比較，超過就先壓縮一次。改成
        // 只信任「真的」被端點用400/413拒絕才觸發壓縮（見_loopFetch/
        // _loopFetchNative的400/413分支），不再用我們自己不精確的粗估
        // 主動出手——粗估容易高估（尤其修好圖片token bloat之前，幾乎每輪
        // 都會被觸發），導致「已封存對話」摺疊卡片跳出來的頻率遠高於實際
        // 需要，使用者感受上很干擾。真正的上下文爆掉現在已經很少見（見
        // _pushToolResultMessage()：圖片類工具結果不再把base64塞進送給
        // LLM的內容），交給reactive路徑處理已經足夠、也更準確（伺服器
        // 自己知道真正的token限制是多少，不用我們用字元數瞎猜）。

        this.responseElapsedMs = 0;
        this._setRespondingState(true);

        await this._checkTopicTransition(userText);
        if (this.stopRequested) return;

        // ============================================================
        // 🧠 【RAG 記憶圖譜喚醒與遞迴依賴拉取】：對話前提取整個前置依賴鏈
        // ============================================================
        try {
            const resolvedChain = await this.ragSystem.query(userText, 3);
            
            this.messages = this.messages.filter(m => !m.content.startsWith('[Hermes 歷史記憶喚醒]'));

            if (resolvedChain.length > 0) {
                const memoryContent = resolvedChain.map(s => {
                    let typeLabel = '累積技能(Skill)';
                    if (s.tags && s.tags.includes('user_preference')) typeLabel = '習慣偏好';
                    if (s.tags && s.tags.includes('document_section')) typeLabel = '章節總結';

                    const scoreLabel = s.score > 0 ? "直接命中相似度: " + (s.score * 100).toFixed(1) + "%" : 'Prerequisite 依賴鏈拉入';
                    const condLabel = (s.preConditions && s.preConditions.length > 0) ? "\n(前置條件: " + s.preConditions.join(', ') + ")" : '';
                    const depLabel = (s.dependencies && s.dependencies.length > 0) ? "\n(依賴關係: " + s.dependencies.join(' -> ') + " -> " + s.id + ")" : '';

                    return "【節點 ID: " + s.id + " (" + typeLabel + " · " + scoreLabel + ")" + condLabel + depLabel + "】:\n" + s.content;
                }).join('\n\n');

                this.messages.splice(1, 0, {
                    role: 'system',
                    content: `[Hermes 歷史記憶喚醒]\n檢索到以下相互關聯的「知識/章節推論依賴圖譜鏈」。某些節點雖然沒有直接與輸入字面匹配，但它是被命中節點的前置 Prerequisites 必要脈絡！請結合以下鏈條回答問題：\n\n${memoryContent}`
                });
                
                this._log("🧠 圖譜機制已喚醒 " + resolvedChain.length + " 個依賴知識/文章切片節點");
                this._renderMessageHistory();
            }
        } catch (err) {
            console.error("圖譜喚醒出錯:", err);
        }

        if (userText && !this.commandHistory.includes(userText)) {
            this.commandHistory.unshift(userText);
            if (this.commandHistory.length > 50) this.commandHistory.pop(); 
            localStorage.setItem(this.HISTORY_KEY, JSON.stringify(this.commandHistory));
        }
        this.historyIndex = -1;

        this.messages.push({ role: "user", content: userText });
        this._renderMessageHistory();

        let aiFullResponseContent = "";

        try {
            aiFullResponseContent = await this._loopFetch(apiKey, apiUrl, apiModel);
        } finally {
            this._setRespondingState(false, '', this.stopRequested ? 'stopped' : 'completed');
            
            if (aiFullResponseContent && !this.stopRequested) {
                this._hermesReflectAndEvolve(userText, aiFullResponseContent);
            }
        }
    }

    async _loopFetch(apiKey, apiUrl, apiModel, retryAttempt = 1) {
        if (this.stopRequested) {
            this._log('🛑 已停止 AI 回應');
            return "";
        }
        // tw_stock_db客製: 原生tool-call路徑跟既有的文字式[CALL:...]串流路徑
        // 是完全獨立的兩條邏輯（原生路徑需要非串流請求才能拿到完整的
        // tool_calls陣列），這裡分流。
        if (this._shouldUseNativeToolCalls(apiModel)) {
            return await this._loopFetchNative(apiKey, apiUrl, apiModel, retryAttempt);
        }
        const chatBody = document.getElementById('ai-chat-body');
        const palette = this._getThemePalette();
        const streamDiv = document.createElement('div');
        streamDiv.className = 'ai-msg ai-assistant';
        streamDiv.style.cssText = `margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; max-width: 85%; word-break: break-all; line-height:1.4; font-size: 14px; background: ${palette.assistantBg}; color: ${palette.assistantText}; border-left: 4px solid #76b900;`;
        streamDiv.innerHTML = `
            <div style="display:flex; align-items:center; gap:8px; margin-bottom:4px;">
                <button type="button" class="ai-inline-stop-btn" style="padding:2px 8px; border:1px solid ${palette.inputBorder}; border-radius:999px; background:${palette.detailBg}; color:${palette.detailText}; font-size:11px; line-height:1.4;">⏹ Stop</button>
                <b>🤖 AI:</b>
            </div>
            <span class="ai-stream-content"></span>
        `;
        chatBody.appendChild(streamDiv);
        chatBody.scrollTop = chatBody.scrollHeight;

        const streamStopBtn = streamDiv.querySelector('.ai-inline-stop-btn');
        if (streamStopBtn) streamStopBtn.onclick = () => this._requestStopResponse();
        const textSpan = streamDiv.querySelector('.ai-stream-content');

        try {
            let fullContent = '';
            let reasoningContent = ''; // tw_stock_db客製: 見下方說明
            let finishReason = null; // tw_stock_db客製: 見下方truncation偵測說明
            let repetitionCut = false;
            let autoContinueRounds = 0; // tw_stock_db客製: 見MAX_AUTO_CONTINUE_ROUNDS說明

            // tw_stock_db客製: 外層迴圈＝自動接續。第一輪送使用者真正的對話
            // 歷史；若這一輪在還沒講完時就被max_tokens截斷
            // (finish_reason==='length')，之後每一輪改送「原對話歷史 + 目前
            // 已經拼到的內容 + 請AI直接接續」，重複直到收到非length的
            // finish_reason，或觸及安全上限。this.messages本身不會被中間輪
            // 汙染，只有全部接續完成後才把最終合併結果push進去一則。
            while (true) {
                const requestMessages = autoContinueRounds === 0
                    ? this.messages
                    : this.messages.concat([
                        { role: 'assistant', content: fullContent },
                        { role: 'user', content: AI_AUTO_CONTINUE_PROMPT }
                    ]);

                const controller = this._createAbortController();
                const response = await fetch(`${apiUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    signal: controller.signal,
                    body: JSON.stringify({
                        model: apiModel,
                        messages: requestMessages,
                        temperature: 0,
                        // tw_stock_db客製: 只送使用者有設定、且沒被目標端點拒絕過的
                        // 取樣參數（見_buildSamplingParamsBody），加上max_tokens替
                        // 輸出長度設硬上限——temperature=0的貪婪解碼在某些模型上
                        // 容易卡進「同一段輸出不斷重複」的退化狀態，這兩者是預防，
                        // 真正兜底的是下面串流迴圈裡的_hasRepeatingTail偵測。
                        ...this._buildSamplingParamsBody(),
                        max_tokens: this._getGenerationSettings().maxOutputTokens,
                        stream: true
                    })
                });

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    // tw_stock_db客製: 400不一定是上下文太長——先檢查是不是某個
                    // 取樣參數被端點拒絕，是的話標記排除、重新送一次（不算進
                    // retryAttempt，因為這不是「內容太長」的重試，是「這次的
                    // request body本身就有問題」，兩者要分開計數，否則正常的
                    // 內容瘦身重試次數會被參數排除吃掉）。_disableRejectedSamplingParam
                    // 對同一個key只會生效一次，不會無窮遞迴。
                    const rejectedParam = this._detectRejectedSamplingParam(errText);
                    if (rejectedParam && this._disableRejectedSamplingParam(rejectedParam, errText)) {
                        streamDiv.remove();
                        return await this._loopFetch(apiKey, apiUrl, apiModel, retryAttempt);
                    }
                    if (response.status === 400 || response.status === 413) {
                        streamDiv.remove();
                        // tw_stock_db客製: 原本這裡遞迴時永遠寫死傳1，等於這條路徑
                        // 沒有重試上限——如果壓縮沒有真正解決400/413的成因（例如
                        // 單一則過大的tool結果，不是對話輪數太多），就會「壓縮→
                        // 還是太大→再觸發400/413→再壓縮」無窮迴圈，也是使用者
                        // 反映「不停閃動/一直被洗掉」的成因之一。改成沿用同一個
                        // retryAttempt計數並設上限，超過就跟一般錯誤一樣放棄並
                        // 記錄，不再無條件遞迴。
                        if (retryAttempt >= this.retryLimit) {
                            this._log("❌ 已達重試上限，仍收到 400/413（可能不是上下文太長，而是這個端點不接受目前的請求格式），請點「清除對話」或換一個模型。錯誤訊息：" + errText.slice(0, 200));
                            return "";
                        }
                        await this.pruneContext("Context Window Exception (Token Limit)");
                        return await this._loopFetch(apiKey, apiUrl, apiModel, retryAttempt + 1);
                    }
                    throw new Error("HTTP " + response.status + (errText ? (": " + errText.slice(0, 200)) : ""));
                }

                const reader = response.body.getReader();
                const decoder = new TextDecoder('utf-8');
                let buffer = '';
                let roundFinishReason = null;

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true });
                    const lines = buffer.split('\n');
                    buffer = lines.pop();

                    for (const line of lines) {
                        const cleaned = line.trim();
                        if (!cleaned || cleaned === 'data: [DONE]') continue;
                        if (cleaned.startsWith('data: ')) {
                            try {
                                const parsed = JSON.parse(cleaned.slice(6));
                                const delta = parsed.choices[0]?.delta || {};
                                if (parsed.choices[0]?.finish_reason) roundFinishReason = parsed.choices[0].finish_reason;
                                // tw_stock_db客製: NVIDIA的推理模型（例如nemotron系列）
                                // 用跟DeepSeek-R1同樣的慣例，把「思考過程」放在獨立的
                                // delta.reasoning_content欄位，跟真正要顯示的
                                // delta.content分開送——原本這裡只讀content，完全沒讀
                                // reasoning_content，導致這個欄位被無聲丟棄；某些對話
                                // 情境下（尤其工具呼叫後的接續回覆）模型的思考過程沒有
                                // 走這個獨立欄位、直接混進content裡，使用者就會在最終
                                // 回覆裡看到一大段「We need to...」這種內部推理文字，
                                // 而不是預期的簡短結論。這裡把reasoning_content累積
                                // 起來，串流結束後包成<think>...</think>接在fullContent
                                // 前面，讓已經存在的_extractThinkingContent()/「🧠 思考
                                // 過程」摺疊區塊機制自動處理，不用另外刻一套新的顯示
                                // 邏輯。
                                reasoningContent += delta.reasoning_content || '';
                                fullContent += delta.content || '';
                                // 純思考、還沒有正式內容時，用一個輕量提示取代空白，
                                // 讓使用者知道AI正在思考、不是卡住沒反應。
                                textSpan.innerText = fullContent || (reasoningContent ? '🧠 思考中…' : '');
                                chatBody.scrollTop = chatBody.scrollHeight;
                            } catch (_) {}
                        }
                    }

                    // tw_stock_db客製: 邊收邊偵測退化重複輸出（見_hasRepeatingTail
                    // 說明），一偵測到就中斷連線、裁掉重複片段，不用等模型自己
                    // 耗盡max_tokens額度才停下來。
                    if (this._hasRepeatingTail(fullContent)) {
                        fullContent = this._dedupeRepeatingTail(fullContent);
                        this._log('⚠️ 偵測到模型輸出重複迴圈，已提前中斷並移除重複內容。');
                        repetitionCut = true;
                        controller.abort();
                        break;
                    }
                }

                finishReason = roundFinishReason;
                if (repetitionCut || finishReason !== 'length') break;

                // tw_stock_db客製: 這一輪被max_tokens截斷——不是內容有問題，
                // 是「這一次API呼叫」的長度上限到了，自動用「請接續」重送一次，
                // 讓使用者不用手動追問。安全上限見MAX_AUTO_CONTINUE_ROUNDS。
                autoContinueRounds++;
                if (autoContinueRounds >= MAX_AUTO_CONTINUE_ROUNDS) break;
                this._log(`↻ 回覆超過單次長度上限，自動請AI接續（第${autoContinueRounds}次）…`);
            }
            if (repetitionCut) textSpan.innerText = fullContent;

            // tw_stock_db客製: 走到這裡如果finishReason還是'length'，代表已經
            // 自動接續到MAX_AUTO_CONTINUE_ROUNDS上限仍未寫完（極端情況，例如
            // 端點異常或模型卡在某種輸出模式），才需要提醒使用者——正常情況
            // 下自動接續機制會在使用者沒感覺到的狀況下把內容拼完整。
            if (finishReason === 'length' && !repetitionCut) {
                fullContent += '\n\n---\n⚠️ **已自動請AI接續多次仍未寫完，這裡先停下來（可能內容真的很長，或端點異常）。** 可以直接追問「請繼續」，或到「圖表設定→AI助理」把「單次回覆上限」調高。';
            }

            // tw_stock_db客製: 把累積的reasoning_content包成<think>標籤接在
            // 正式內容前面，交給既有的_extractThinkingContent()/「🧠 思考過程」
            // 摺疊區塊機制處理，見上面串流迴圈裡的說明。
            if (reasoningContent) {
                fullContent = `<think>${reasoningContent}</think>${fullContent}`;
            }

            this.messages.push({ role: "assistant", content: fullContent });

            // --- 容錯偵測與解析機制 ---
            const callStart = fullContent.lastIndexOf('[CALL:');
            if (callStart > -1) {
                // --- 強化版多工具解析機制 ---
                let invokedCount = 0;
                
                // 方案 A: 使用進階 Regex 嘗試批次抓取
                const regex = /\[CALL:\s*([a-zA-Z0-9_]+)\(([\s\S]*?)\)(?=\]|$)/g;
                let match;
                const toolTasks = [];

                while ((match = regex.exec(fullContent)) !== null) {
                    toolTasks.push({ fnName: match[1], fnArgsRaw: match[2].trim() });
                }

                // 方案 B: 若 Regex 沒抓到，嘗試傳統最後搜尋法 (備援路徑)
                if (toolTasks.length === 0) {
                    const callStart = fullContent.lastIndexOf('[CALL:');
                    if (callStart > -1) {
                        const fallbackMatch = fullContent.slice(callStart).match(/\[CALL:\s*([^\(\s]+)\s*\(([\s\S]*)/);
                        if (fallbackMatch) {
                            let rawArgs = fallbackMatch[2].trim();
                            if (!rawArgs.endsWith(')]')) rawArgs = rawArgs.replace(/\)]?$/, '').replace(/\n/g, '') + ')]';
                            toolTasks.push({ fnName: fallbackMatch[1], fnArgsRaw: rawArgs.slice(0, -2) });
                        }
                    }
                }

                // 統一執行工具邏輯
                for (const task of toolTasks) {
                    try {
                        const toolDefinition = this._getToolDefinition(task.fnName);
                        if (!toolDefinition) throw new Error(`找不到工具: ${task.fnName}`);

                        this._log(`執行工具: ${task.fnName}`);
                        const parsedArgs = await this.repairJsonPayload(task.fnArgsRaw);
                        const result = await Promise.resolve(toolDefinition.callback(JSON.stringify(parsedArgs)));

                        this._pushToolResultMessage(task.fnName, result);
                        this._renderMessageHistory();
                        invokedCount++;
                    } catch (err) {
                        console.error(`執行 ${task.fnName} 失敗:`, err);
                        this.executeChat(`[系統提示] 工具 "${task.fnName}" 執行失敗: ${err.message}。`);
                    }
                }

                // 若有執行任何工具，遞迴呼叫確保 AI 完成後續 Plan
                if (invokedCount > 0) {
                    return await this._loopFetch(apiKey, apiUrl, apiModel, 1);
                }
            }

            // tw_stock_db客製: 串流過程中畫面顯示的textSpan.innerText是刻意的
            // 純文字（串流到一半的markdown沒辦法正確渲染，例如表格/程式碼區塊
            // 只打了一半），但回應完成、沒有觸發工具呼叫的情況下（最常見的
            // 純文字回答），原本這裡直接return，從沒有機會把畫面從那個純
            // 文字的streamDiv換成_renderMessageHistory()產生的、有markdown
            // 排版的正式版本——使用者會看到回應「永遠」停在未轉換的原始
            // markdown文字，要等到送出下一則訊息、整批重繪時才會補上格式，
            // 造成「markdown完全沒作用」的錯覺。這裡在確定沒有後續工具呼叫
            // 要處理時，主動補一次重繪，讓格式化立刻生效。
            this._renderMessageHistory();
            return fullContent;

        } catch (err) {
            streamDiv.remove();
            if (err.name === 'AbortError' || this.stopRequested) return "";
            if (retryAttempt < this.retryLimit) {
                await this._sleep(this.retryBaseDelayMs * retryAttempt);
                return await this._loopFetch(apiKey, apiUrl, apiModel, retryAttempt + 1);
            }
            this._log("錯誤: " + err.message);
            return "";
        }
    }

    // tw_stock_db客製: 原生 tools/tool_calls 路徑。跟上面 _loopFetch 的文字式
    // [CALL:...]路徑是分開的實作——原生路徑用非串流請求（stream:false），
    // 才能一次拿到完整的 message.tool_calls 陣列（串流時tool_calls是逐段
    // index累加的delta，重組複雜度高，這裡先用非串流換取正確性，使用者
    // 體感差異只是「這一輪沒有逐字跳出」，仍然有基本的loading等待感由
    // _setRespondingState負責）。
    async _loopFetchNative(apiKey, apiUrl, apiModel, retryAttempt = 1) {
        if (this.stopRequested) {
            this._log('🛑 已停止 AI 回應');
            return "";
        }
        try {
            let finalContent = '';
            let reasoningAccum = '';
            let autoContinueRounds = 0; // tw_stock_db客製: 見MAX_AUTO_CONTINUE_ROUNDS說明
            let hitContinueCap = false;
            let toolCalls = [];

            // tw_stock_db客製: 跟_loopFetch串流路徑同樣的自動接續機制（見那邊
            // 詳細說明）——finish_reason==='length'代表這一次API呼叫被max_tokens
            // 截斷，不是內容真的講完了，這裡自動用「請接續」重送，直到收到
            // 非length的finish_reason或觸及安全上限，而不是每次都直接顯示
            // 截斷警告要求使用者手動追問。
            while (true) {
                const requestMessages = autoContinueRounds === 0
                    ? this.messages
                    : this.messages.concat([
                        { role: 'assistant', content: finalContent },
                        { role: 'user', content: AI_AUTO_CONTINUE_PROMPT }
                    ]);

                const controller = this._createAbortController();
                const response = await fetch(`${apiUrl}/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${apiKey}`,
                        'Content-Type': 'application/json'
                    },
                    signal: controller.signal,
                    body: JSON.stringify({
                        model: apiModel,
                        messages: requestMessages,
                        temperature: 0,
                        // tw_stock_db客製: 跟 _loopFetch 同樣的理由，見那邊的說明。
                        ...this._buildSamplingParamsBody(),
                        max_tokens: this._getGenerationSettings().maxOutputTokens,
                        stream: false,
                        tools: this._buildNativeToolsSchema(),
                        tool_choice: 'auto'
                    })
                });

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    // tw_stock_db客製: 跟 _loopFetch 同樣的理由，先排除「取樣參數被
                    // 拒絕」這個可能性，見那邊的說明。
                    const rejectedParam = this._detectRejectedSamplingParam(errText);
                    if (rejectedParam && this._disableRejectedSamplingParam(rejectedParam, errText)) {
                        return await this._loopFetchNative(apiKey, apiUrl, apiModel, retryAttempt);
                    }
                    if (response.status === 400 || response.status === 413) {
                        // tw_stock_db客製: 跟 _loopFetch 同樣的理由，不能無條件遞迴
                        // （原本寫死傳1），見那邊的說明。
                        if (retryAttempt >= this.retryLimit) {
                            this._log("❌ 已達重試上限，仍收到 400/413（可能不是上下文太長，而是這個端點不接受目前的請求格式），請點「清除對話」或換一個模型。錯誤訊息：" + errText.slice(0, 200));
                            return "";
                        }
                        await this.pruneContext("Context Window Exception (Token Limit)");
                        return await this._loopFetchNative(apiKey, apiUrl, apiModel, retryAttempt + 1);
                    }
                    throw new Error("HTTP " + response.status + (errText ? (": " + errText.slice(0, 200)) : ""));
                }

                const data = await response.json();
                const message = data.choices && data.choices[0] && data.choices[0].message;
                if (!message) throw new Error("回應格式異常，缺少 choices[0].message");

                // tw_stock_db客製: 推理模型的reasoning_content是獨立欄位，見
                // _loopFetch串流路徑的詳細說明，這裡累積、最後一起包成
                // <think>標籤。
                if (message.reasoning_content) reasoningAccum += message.reasoning_content;
                finalContent += message.content || '';
                toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

                const roundFinishReason = data.choices[0].finish_reason;
                // tool_calls跟finish_reason==='length'實務上不會同時發生（模型
                // 若要呼叫工具，不會被裁在講到一半），這裡只在「純文字被截斷、
                // 沒有工具呼叫」時才自動接續。
                if (toolCalls.length || roundFinishReason !== 'length') break;

                autoContinueRounds++;
                if (autoContinueRounds >= MAX_AUTO_CONTINUE_ROUNDS) { hitContinueCap = true; break; }
                this._log(`↻ 回覆超過單次長度上限，自動請AI接續（第${autoContinueRounds}次）…`);
            }

            if (reasoningAccum) {
                finalContent = `<think>${reasoningAccum}</think>${finalContent}`;
            }
            // tw_stock_db客製: 只有觸及安全上限仍未寫完才提醒使用者，正常情況
            // 下自動接續機制會無聲把內容拼完整，見_loopFetch串流路徑同樣的
            // 說明。
            if (hitContinueCap) {
                finalContent += '\n\n---\n⚠️ **已自動請AI接續多次仍未寫完，這裡先停下來（可能內容真的很長，或端點異常）。** 可以直接追問「請繼續」，或到「圖表設定→AI助理」把「單次回覆上限」調高。';
            }

            this.messages.push(Object.assign(
                { role: 'assistant', content: finalContent },
                toolCalls.length ? { tool_calls: toolCalls } : {}
            ));

            if (!toolCalls.length) {
                this._renderMessageHistory();
                return finalContent;
            }

            this._renderMessageHistory();
            for (const tc of toolCalls) {
                const fnName = tc.function && tc.function.name;
                const rawArgs = (tc.function && tc.function.arguments) || '{}';
                try {
                    const toolDefinition = this._getToolDefinition(fnName);
                    if (!toolDefinition) throw new Error(`找不到工具: ${fnName}`);
                    this._log(`執行工具（原生）: ${fnName}`);
                    const result = await Promise.resolve(toolDefinition.callback(rawArgs));
                    this._pushToolResultMessage(fnName, result, { tool_call_id: tc.id });
                } catch (err) {
                    console.error(`執行 ${fnName} 失敗:`, err);
                    this._pushToolResultMessage(fnName, JSON.stringify({ ok: false, error: String(err.message || err) }), { tool_call_id: tc.id });
                }
                this._renderMessageHistory();
            }

            return await this._loopFetchNative(apiKey, apiUrl, apiModel, 1);

        } catch (err) {
            if (err.name === 'AbortError' || this.stopRequested) return "";
            if (retryAttempt < this.retryLimit) {
                await this._sleep(this.retryBaseDelayMs * retryAttempt);
                return await this._loopFetchNative(apiKey, apiUrl, apiModel, retryAttempt + 1);
            }
            this._log("錯誤: " + err.message);
            return "";
        }
    }

    _resolveMountElement() {
        if (this.options.mountElement instanceof Element) return this.options.mountElement;
        if (typeof this.options.mountSelector === 'string') {
            const mount = document.querySelector(this.options.mountSelector);
            if (!mount) {
                console.warn("FloatingAssistant mount selector not found: " + this.options.mountSelector);
            }
            return mount;
        }
        return null;
    }

    _applyStyleOverride(el, overrides) {
        if (!overrides) return;
        if (typeof overrides === 'string') {
            const existing = el.style.cssText.trimEnd();
            el.style.cssText = (existing && !existing.endsWith(';') ? existing + '; ' : existing) + overrides;
        } else if (typeof overrides === 'object') {
            Object.assign(el.style, overrides);
        }
    }

    _getWindowPositionCSS(anchored, position) {
        if (!anchored) {
            return 'position: fixed; bottom: 90px; right: 20px; width: 380px; height: 500px;';
        }
        const size = 'width: min(420px, calc(100vw - 32px)); height: min(560px, 72vh);';
        switch (position) {
            case 'above': return `position: absolute; bottom: calc(100% + 6px); left: 0; ${size}`;
            case 'left':  return `position: absolute; top: 0; right: calc(100% + 6px); ${size}`;
            case 'right': return `position: absolute; top: 0; left: calc(100% + 6px); ${size}`;
            default:      return `position: absolute; top: calc(100% + 6px); left: 0; ${size}`;
        }
    }

    _initUI() {
        const mount = this._resolveMountElement();
        const anchored = !!mount;
        const container = mount || document.body;
        const customRender = typeof this.options.render === 'function';
        const palette = this._getThemePalette();
        this._ensureAdvancedStyles();
        this._ensureMarkdownStyles();
        // tw_stock_db客製: 提早（mount時就）背景載入markdown函式庫，不等第一次
        // 有assistant訊息要渲染才開始載入——LLM回覆通常要等好幾秒，載入這兩個
        // 小型CDN檔案的時間差不多會被那段等待「吃掉」，使用者體感上幾乎不會
        // 注意到有額外延遲。不用await，失敗也不影響其他功能（見
        // _ensureMarkdownLibsLoaded內的容錯）。
        this._ensureMarkdownLibsLoaded();

        let btn, win;

        if (customRender) {
            const result = this.options.render(container, this);
            btn = result.btn;
            win = result.win;
            if (!win.style.display || win.style.display === '') win.style.display = 'none';
            this._applyStyleOverride(win, this.options.windowStyle);
        } else {
            if (mount) {
                mount.style.position = mount.style.position || 'relative';
                mount.style.display = mount.style.display || 'inline-flex';
                mount.style.alignItems = mount.style.alignItems || 'center';
            }

            btn = document.createElement('div');
            btn.id = 'ai-floating-btn';
            btn.innerHTML = this.options.buttonText || (anchored ? '🤖 AI' : '🟢 AI');
            btn.style.cssText = `
                ${anchored
                    ? 'position: relative; min-width: 70px; height: 30px; padding: 0 12px; border-radius: 999px; display: inline-flex;'
                    : 'position: fixed; bottom: 20px; right: 20px; width: 60px; height: 60px; border-radius: 50%; display: flex;'}
                background: #76b900; color: white;
                align-items: center; justify-content: center; font-weight: bold;
                cursor: pointer; box-shadow: 0 4px 12px rgba(0,0,0,0.3); z-index: 999999;
                user-select: none; transition: transform 0.2s;
            `;
            this._applyStyleOverride(btn, this.options.buttonStyle);
            btn.onclick = () => this.toggleWindow();
            container.appendChild(btn);

            win = document.createElement('div');
            win.style.cssText = `
                ${this._getWindowPositionCSS(anchored, this.options.windowPosition)}
                background: ${palette.windowBg}; border: 1px solid ${palette.windowBorder}; border-radius: 12px;
                box-shadow: 0 6px 24px rgba(0,0,0,0.15); z-index: 999999; display: none;
                flex-direction: column; overflow: hidden; font-family: sans-serif;
            `;
            this._applyStyleOverride(win, this.options.windowStyle);
            container.appendChild(win);
        }

        win.id = 'ai-floating-window';

        const hermesEvolveOn = localStorage.getItem(this.HERMES_AUTO_EVOLVE_KEY) === 'true';

        win.innerHTML = `
            <div id="ai-window-header" style="background: ${palette.headerBg}; color: ${palette.headerText}; padding: 12px; display: flex; justify-content: space-between; align-items: center;">
                <span style="font-weight: bold; color: #76b900;">AI Assistant <span style="font-size:10px; background:#8b5cf6; color:#fff; padding:1px 5px; border-radius:999px; font-weight:normal; margin-left:4px;">Graph RAG</span></span>
                <div>
                    <span id="ai-btn-clear-chat" title="清除對話" style="cursor:pointer; margin-right: 10px;">🗑️</span>
                    <span id="ai-btn-config" style="cursor:pointer; margin-right: 10px;">⚙️</span>
                    <span id="ai-btn-close" style="cursor:pointer;">❌</span>
                </div>
            </div>
            <div id="ai-config-panel" style="display:none; background: ${palette.chatBg}; color: ${palette.chatText}; padding: 10px; border-bottom: 1px solid ${palette.windowBorder};">
                <label style="font-size:12px; font-weight:bold; display:block; margin-bottom:4px;">API KEY:</label>
                <input type="password" id="ai-input-key" style="width:100%; padding:6px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; background:${palette.inputBg}; color:${palette.inputText};">
                <label style="font-size:12px; font-weight:bold; display:block; margin-bottom:4px;">API URL:</label>
                <input type="text" id="ai-url" style="width:100%; padding:6px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; background:${palette.inputBg}; color:${palette.inputText};" placeholder='https://integrate.api.nvidia.com/v1'>
                <label style="font-size:12px; font-weight:bold; display:block; margin-bottom:4px;">MODEL NAME:</label>
                <input type="text" id="ai-model-name" list="ai-model-datalist" style="width:100%; padding:6px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; background:${palette.inputBg}; color:${palette.inputText};" placeholder='nvidia/nemotron-3-super-120b-a12b'>
                <datalist id="ai-model-datalist">
                    ${PRESET_MODEL_OPTIONS.map(m => `<option value="${m}"></option>`).join('')}
                </datalist>

                <details style="margin-top:8px;">
                    <summary style="font-size:12px; font-weight:bold; cursor:pointer; user-select:none; color:${palette.detailText};">生成／取樣參數（點擊展開）</summary>
                    <div style="margin-top:6px; padding:8px; background:${palette.detailBg}; color:${palette.detailText}; border-radius:6px;">
                        <label style="font-size:11px; display:block; margin-bottom:2px;" for="ai-gen-context-window">模型上下文視窗（tokens，用來主動判斷何時該壓縮對話）</label>
                        <input type="number" min="512" step="512" id="ai-gen-context-window" style="width:100%; padding:4px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; margin-bottom:6px; background:${palette.inputBg}; color:${palette.inputText};">
                        <label style="font-size:11px; display:block; margin-bottom:2px;" for="ai-gen-max-output">單次回覆上限（max_tokens）</label>
                        <input type="number" min="64" step="64" id="ai-gen-max-output" style="width:100%; padding:4px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; margin-bottom:6px; background:${palette.inputBg}; color:${palette.inputText};">
                        <div style="font-size:11px; margin-bottom:2px;">取樣/重複懲罰參數（留空＝不送這個欄位；若被伺服器拒絕會自動排除並在對話中記錄）：</div>
                        <div style="display:grid; grid-template-columns:1fr 1fr; gap:6px 8px;">
                            ${SAMPLING_PARAM_KEYS.map(key => `
                                <div>
                                    <label style="display:block; font-size:10px; margin-bottom:2px;" for="ai-param-${key}">${key}</label>
                                    <input type="number" step="0.1" id="ai-param-${key}" style="width:100%; padding:4px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; background:${palette.inputBg}; color:${palette.inputText};">
                                </div>
                            `).join('')}
                        </div>
                        <div id="ai-param-disabled-note" style="font-size:10px; color:#dd6b20; margin-top:6px;"></div>
                    </div>
                </details>

                <div style="margin-top:8px; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="ai-hermes-evolve-chk" ${hermesEvolveOn ? 'checked' : ''} style="cursor:pointer;">
                    <label for="ai-hermes-evolve-chk" style="font-size:12px; font-weight:bold; color:#8b5cf6; cursor:pointer; user-select:none;">開啟 RAG 本地條件圖譜自我演化</label>
                </div>

                <div style="margin-top:10px;">
                    <button id="ai-btn-advanced" type="button" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid ${palette.inputBorder}; background:${palette.detailBg}; color:${palette.detailText}; cursor:pointer;">Advance</button>
                </div>
            </div>
            <div id="ai-chat-body" style="flex:1; padding:15px; overflow-y:auto; background: ${palette.chatBg}; color: ${palette.chatText}; font-size: 14px;"></div>
            <div id="ai-autocomplete-bar" style="background:${palette.detailBg}; color:${palette.detailText}; font-size:11px; padding:4px 12px; display:none; border-top:1px solid ${palette.windowBorder};">
                💡 按 <kbd style="background:#fff;padding:1px 3px;border:1px solid #ccc;border-radius:3px;">Tab</kbd> 自動補全: <span id="ai-suggest-text"></span>
            </div>
            <div id="ai-input-wrap" style="padding:10px; background:${palette.windowBg}; border-top:1px solid ${palette.windowBorder};">
                <textarea id="ai-input-text" rows="2" placeholder="輸入訊息... (上下鍵選歷史, Tab補全)" style="width:100%; box-sizing:border-box; padding:8px; border:1px solid ${palette.inputBorder}; border-radius:6px; resize:none; font-size:13px; font-family:inherit; background:${palette.inputBg}; color:${palette.inputText};"></textarea>
                <div style="margin-top:6px; display:flex; align-items:center; gap:8px;">
                    <button id="ai-stop-response-btn" type="button" style="padding:2px 8px; border:1px solid ${palette.inputBorder}; border-radius:999px; background:${palette.detailBg}; color:${palette.detailText}; font-size:11px; line-height:1.4;">⏹ Stop</button>
                    <div id="ai-response-indicator" style="font-size:11px; color:${palette.detailText};">✅ 已完成</div>
                </div>
            </div>
            <div id="ai-status-log" style="background:${palette.statusBg}; color:${palette.statusText}; font-size:10px; padding:3px 10px; max-height:20px; overflow:auto;">系統就緒</div>
            <div id="ai-advanced-modal" class="ai-advanced-overlay">
                <div class="ai-advanced-dialog">
                    <div class="ai-advanced-row">
                        <h3 style="margin:0; color:#76b900;">Advance 設定</h3>
                        <button type="button" id="ai-advanced-close" class="ai-advanced-btn">關閉</button>
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-rules-input">RULES.md</label>
                        <textarea id="ai-rules-input" class="ai-advanced-textarea" placeholder="如果有內容，會附加到 system prompt 的開頭。"></textarea>
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-custom-functions-input">Customize Functions (JavaScript, private for AI)</label>
                        ${this._buildCodeEditorHtml('ai-custom-functions-input', 240)}
                    </div>
                    <div class="ai-advanced-stack">
                        <div class="ai-advanced-tools-header">
                            <div class="ai-advanced-label" style="margin:0;">Skill（自訂工具 / Custom Tools）</div>
                            <div style="display:flex; gap:8px; flex-wrap:wrap;">
                                <button type="button" id="ai-tool-add-btn" class="ai-advanced-btn primary">新增 Skill</button>
                                <button type="button" id="ai-skill-export-btn" class="ai-advanced-btn">匯出 .skill</button>
                                <label class="ai-advanced-btn" style="cursor:pointer; display:inline-flex; align-items:center;">匯入 .skill<input type="file" id="ai-skill-import-input" accept=".skill,.zip" style="display:none;"></label>
                            </div>
                        </div>
                        <div id="ai-custom-tool-list" class="ai-tool-list"></div>
                    </div>
                    <div class="ai-advanced-stack">
                        <div class="ai-advanced-tools-header">
                            <div class="ai-advanced-label" style="margin:0;">AI自製函式 (FromAI)</div>
                            <button type="button" id="ai-fn-manage-btn" class="ai-advanced-btn primary">管理AI自製函式</button>
                        </div>
                    </div>
                    <div class="ai-advanced-stack">
                        <div class="ai-advanced-tools-header">
                            <div class="ai-advanced-label" style="margin:0;">RAG 條件與依賴關係知識庫</div>
                            <button type="button" id="ai-rag-manage-btn" class="ai-advanced-btn primary">管理條件圖譜</button>
                        </div>
                    </div>
                    <div class="ai-advanced-footer">
                        <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center;">
                            <span style="font-size:12px; color:#94a3b8;">全部內容以 JSON 格式儲存在 persistent localStorage。</span>
                            <button type="button" id="ai-settings-export-btn" class="ai-advanced-btn">匯出設定</button>
                            <label class="ai-advanced-btn" style="cursor:pointer; display:inline-flex; align-items:center;">匯入設定<input type="file" id="ai-settings-import-input" accept=".json" style="display:none;"></label>
                        </div>
                        <button type="button" id="ai-advanced-done" class="ai-advanced-btn primary">完成</button>
                    </div>
                </div>
            </div>
            <div id="ai-tool-editor-modal" class="ai-advanced-overlay">
                <div class="ai-advanced-dialog" style="width:min(860px, 94vw);">
                    <div class="ai-advanced-row">
                        <h3 style="margin:0; color:#76b900;">編輯 Skill（Custom Tool）</h3>
                        <button type="button" id="ai-tool-editor-close" class="ai-advanced-btn">關閉</button>
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-tool-name-input">Name</label>
                        <input id="ai-tool-name-input" class="ai-advanced-input" type="text">
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-tool-desc-input">Description</label>
                        <textarea id="ai-tool-desc-input" class="ai-advanced-textarea" style="min-height:100px;"></textarea>
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-tool-script-input">Handler Script (JavaScript)</label>
                        ${this._buildCodeEditorHtml('ai-tool-script-input', 280)}
                    </div>
                    <div class="ai-advanced-footer">
                        <span style="font-size:12px; color:#94a3b8;">Handler 會以 async function body 執行，參數為 <code>args</code> 與 <code>rawArgs</code>。</span>
                        <div style="display:flex; gap:8px; flex-wrap:wrap;">
                            <button type="button" id="ai-tool-editor-cancel" class="ai-advanced-btn">取消</button>
                            <button type="button" id="ai-tool-editor-save" class="ai-advanced-btn primary">儲存</button>
                        </div>
                    </div>
                </div>
            </div>
            <div id="ai-fn-modal" class="ai-advanced-overlay">
                <div class="ai-advanced-dialog" style="width:min(860px, 94vw);">
                    <div class="ai-advanced-row">
                        <h3 style="margin:0; color:#76b900;">管理AI自製函式</h3>
                        <button type="button" id="ai-fn-modal-close" class="ai-advanced-btn">關閉</button>
                    </div>
                    <div class="ai-advanced-stack">
                        <div class="ai-advanced-tools-header">
                            <div class="ai-advanced-label" style="margin:0;">AI自製函式清單</div>
                            <button type="button" id="ai-fn-add-btn" class="ai-advanced-btn primary">新增函式</button>
                        </div>
                        <div id="ai-fn-list" class="ai-tool-list"></div>
                    </div>
                    <div class="ai-advanced-footer">
                        <span style="font-size:12px; color:#94a3b8;">由AI透過 add_ai_function 工具建立，儲存於 FloatingAssistant.FromAI。</span>
                        <button type="button" id="ai-fn-modal-done" class="ai-advanced-btn primary">完成</button>
                    </div>
                </div>
            </div>
            <div id="ai-fn-editor-modal" class="ai-advanced-overlay">
                <div class="ai-advanced-dialog" style="width:min(860px, 94vw);">
                    <div class="ai-advanced-row">
                        <h3 style="margin:0; color:#76b900;">編輯AI自製函式</h3>
                        <button type="button" id="ai-fn-editor-close" class="ai-advanced-btn">關閉</button>
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-fn-name-input">函式名稱</label>
                        <input id="ai-fn-name-input" class="ai-advanced-input" type="text" placeholder="my_function_name">
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-fn-desc-input">描述</label>
                        <textarea id="ai-fn-desc-input" class="ai-advanced-textarea" style="min-height:80px;"></textarea>
                    </div>
                    <div class="ai-advanced-stack">
                        <label class="ai-advanced-label" for="ai-fn-code-input">函式體 (JavaScript)</label>
                        ${this._buildCodeEditorHtml('ai-fn-code-input', 280)}
                    </div>
                    <div class="ai-advanced-footer">
                        <span style="font-size:12px; color:#94a3b8;">函式以 async function body 執行，參數為 <code>args</code>。儲存於 FloatingAssistant.FromAI。</span>
                        <div style="display:flex; gap:8px; flex-wrap:wrap;">
                            <button type="button" id="ai-fn-editor-cancel" class="ai-advanced-btn">取消</button>
                            <button type="button" id="ai-fn-editor-save" class="ai-advanced-btn primary">儲存</button>
                        </div>
                    </div>
                </div>
            </div>
            <div id="ai-rag-modal" class="ai-advanced-overlay">
                <div class="ai-advanced-dialog" style="width:min(960px, 96vw);">
                    <div class="ai-advanced-row">
                        <h3 style="margin:0; color:#76b900;">RAG 條件與依賴關係記憶圖譜管理</h3>
                        <button type="button" id="ai-rag-modal-close" class="ai-advanced-btn">關閉</button>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <input id="ai-rag-search-input" class="ai-advanced-input" type="text" placeholder="關鍵字搜尋或節點 ID..." style="flex:1; min-width:160px;">
                        <button type="button" id="ai-rag-search-btn" class="ai-advanced-btn">搜尋</button>
                        <button type="button" id="ai-rag-query-btn" class="ai-advanced-btn">圖譜語意檢索</button>
                        <button type="button" id="ai-rag-add-btn" class="ai-advanced-btn primary">新增節點</button>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
                        <label style="font-size:12px; color:#94a3b8; display:flex; align-items:center; gap:4px; cursor:pointer;">
                            <input type="checkbox" id="ai-rag-select-all"> 全選
                        </label>
                        <button type="button" id="ai-rag-delete-selected-btn" class="ai-advanced-btn danger">刪除選取</button>
                        <button type="button" id="ai-rag-export-btn" class="ai-advanced-btn">匯出資料</button>
                        <label class="ai-advanced-btn" style="cursor:pointer; display:inline-flex; align-items:center;">
                            匯入資料<input type="file" id="ai-rag-import-input" accept=".json" style="display:none;">
                        </label>
                        <span id="ai-rag-status" style="font-size:11px; color:#94a3b8; margin-left:4px;"></span>
                    </div>
                    <div class="ai-rag-table-wrap">
                        <table class="ai-rag-table">
                            <thead>
                                <tr>
                                    <th style="width:32px;"></th>
                                    <th style="width:120px;">節點 ID</th>
                                    <th>內文 (含自動依賴與先決條件標記)</th>
                                    <th style="width:70px;">相關度</th>
                                    <th style="width:90px;">來源</th>
                                    <th style="width:150px;">時間</th>
                                </tr>
                            </thead>
                            <tbody id="ai-rag-table-body"></tbody>
                        </table>
                    </div>
                    <div class="ai-advanced-footer">
                        <span style="font-size:12px; color:#94a3b8;">雙擊節點內文行可編輯其依賴與先決條件。設定格式：<code>tags; deps:node_a,node_b; conds:環境==WebGPU</code></span>
                        <button type="button" id="ai-rag-modal-done" class="ai-advanced-btn primary">完成</button>
                    </div>
                </div>
            </div>
            <div id="ai-rag-editor-modal" class="ai-advanced-overlay">
                <div class="ai-advanced-dialog" style="width:min(700px, 94vw);">
                    <div class="ai-advanced-row">
                        <h3 id="ai-rag-editor-title" style="margin:0; color:#76b900;">編輯圖譜節點</h3>
                        <button type="button" id="ai-rag-editor-close" class="ai-advanced-btn">關閉</button>
                    </div>
                    <div class="ai-rag-edit-form">
                        <div class="ai-advanced-stack">
                            <label class="ai-advanced-label" for="ai-rag-edit-content">核心內文 / Routine / 總結</label>
                            <textarea id="ai-rag-edit-content" class="ai-advanced-textarea" style="min-height:140px;" placeholder="輸入要儲存的文字內容..."></textarea>
                        </div>
                        <div class="ai-advanced-stack">
                            <label class="ai-advanced-label" for="ai-rag-edit-source">來源 (選填)</label>
                            <input id="ai-rag-edit-source" class="ai-advanced-input" type="text" placeholder="如: hermes_evolution, manual...">
                        </div>
                        <div class="ai-advanced-stack">
                            <label class="ai-advanced-label" for="ai-rag-edit-tags">配置格式 (格式為: 標籤; deps:依賴的節點ID; conds:觸發條件)</label>
                            <input id="ai-rag-edit-tags" class="ai-advanced-input" type="text" placeholder="例如: skill; deps:node_1,node_2; conds:使用JS">
                        </div>
                    </div>
                    <div class="ai-advanced-footer">
                        <span style="font-size:12px; color:#94a3b8;" id="ai-rag-edit-id-label"></span>
                        <div style="display:flex; gap:8px; flex-wrap:wrap;">
                            <button type="button" id="ai-rag-editor-cancel" class="ai-advanced-btn">取消</button>
                            <button type="button" id="ai-rag-editor-save" class="ai-advanced-btn primary">儲存</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const savedKey = localStorage.getItem(this.STORAGE_KEY);
        if (savedKey) win.querySelector('#ai-input-key').value = savedKey;
        let savedURL = localStorage.getItem(this.LLM_BASE_URL_KEY);
        if (savedURL) win.querySelector('#ai-url').value = savedURL;
        let savedModel = localStorage.getItem(this.LLM_MODEL_NAME_KEY);
        if (savedModel) win.querySelector('#ai-model-name').value = savedModel;
        this._renderAdvancedSettings();
        this._applyThemeStyles();
    }
    
    toggleWindow(forceOpen = false) {
        const win = document.getElementById('ai-floating-window');
        if (win.style.display === 'none' || forceOpen) {
            win.style.display = 'flex';
        } else {
            win.style.display = 'none';
        }
    }

    _log(msg) {
        const el = document.getElementById('ai-status-log');
        if (el) el.innerText = msg;
    }

    // tw_stock_db客製: 對話紀錄（含已封存的舊訊息）存進localStorage，讓
    // 重新整理頁面／關掉分頁再回來都還在，不用每次都從零開始。存的時機是
    // _renderMessageHistory()結尾——這個函式本來就是「訊息有變動」的唯一
    // 進入點，掛在這裡不用在一堆呼叫端各自補一次存檔邏輯。localStorage
    // 容量有限（~5-10MB），失敗（例如單一使用者對話量真的異常大）只記警告、
    // 不影響其他功能，畫面上的內容還是完整的，只是下次重新整理會遺失。
    _persistChatHistory() {
        try {
            // tw_stock_db客製: _displayDataUrl是特意設成不可枚舉的屬性（見
            // _pushToolResultMessage()），JSON.stringify(this.messages)不會
            // 序列化到它——這裡額外把圖片資料存進一個獨立的imageMap（用訊息
            // 在陣列裡的索引當key），讓圖片還是能在重新整理頁面後正確還原
            // 顯示，同時維持「圖片不佔用送給LLM的內容/token估算」這個優化。
            // archivedDisplayBlocks（pruneContext壓縮後被移出this.messages的
            // 舊訊息，見那邊的說明）裡的訊息物件是同一個參考、同樣可能帶
            // _displayDataUrl，這裡也要一併掃到，不然圖表被例行壓縮移進
            // archivedDisplayBlocks後，當下畫面雖然還看得到（物件參考還在），
            // 但重新整理頁面後圖片就會不見——key用"blockIdx:msgIdx"跟
            // this.messages的純數字index區分開。
            const imageMap = {};
            this.messages.forEach((m, i) => { if (m._displayDataUrl) imageMap[i] = m._displayDataUrl; });
            (this.archivedDisplayBlocks || []).forEach((block, bi) => {
                (block.messages || []).forEach((m, mi) => {
                    if (m._displayDataUrl) imageMap[`${bi}:${mi}`] = m._displayDataUrl;
                });
            });
            localStorage.setItem(this.CHAT_HISTORY_KEY, JSON.stringify({
                messages: this.messages,
                archivedDisplayBlocks: this.archivedDisplayBlocks,
                imageMap,
            }));
        } catch (err) {
            console.warn('對話紀錄存檔失敗（可能超過localStorage容量）:', err);
        }
    }

    _loadPersistedChatHistory() {
        try {
            const raw = localStorage.getItem(this.CHAT_HISTORY_KEY);
            if (!raw) return;
            const data = JSON.parse(raw);
            if (Array.isArray(data.messages)) this.messages = data.messages;
            if (Array.isArray(data.archivedDisplayBlocks)) this.archivedDisplayBlocks = data.archivedDisplayBlocks;
            if (data.imageMap) {
                // tw_stock_db客製: key是純數字代表this.messages裡的index；
                // "bi:mi"格式代表archivedDisplayBlocks[bi].messages[mi]，見
                // _persistChatHistory()存檔時的說明。
                Object.entries(data.imageMap).forEach(([key, dataUrl]) => {
                    let msg;
                    if (key.includes(':')) {
                        const [bi, mi] = key.split(':').map(Number);
                        msg = this.archivedDisplayBlocks[bi] && this.archivedDisplayBlocks[bi].messages[mi];
                    } else {
                        msg = this.messages[Number(key)];
                    }
                    if (msg) Object.defineProperty(msg, '_displayDataUrl', { value: dataUrl, enumerable: false, configurable: true });
                });
            }
        } catch (err) {
            console.warn('對話紀錄讀取失敗，改用空白對話:', err);
        }
    }

    // tw_stock_db客製: 使用者手動清除對話（🗑️按鈕，見_initEventListeners）
    // ，也是_loopFetch/_loopFetchNative在真的沒辦法解決400/413時建議使用者
    // 採取的動作（見那兩處錯誤訊息）。
    _clearChatHistory() {
        this.messages = [];
        this.archivedDisplayBlocks = [];
        localStorage.removeItem(this.CHAT_HISTORY_KEY);
        this._renderMessageHistory();
        this._log('🗑️ 對話已清除');
    }

    _renderMessageHistory() {
        const chatBody = document.getElementById('ai-chat-body');
        const palette = this._getThemePalette();
        this._applyThemeStyles();
        chatBody.innerHTML = '';

        // tw_stock_db客製: pruneContext()壓縮上下文時，被移出this.messages
        // 的原始訊息存在archivedDisplayBlocks裡（純粹給畫面用，不會回頭餵
        // 給API）。block.silent===true（例行token-limit壓縮，見
        // pruneContext）的區塊直接原樣攤開渲染、不包摺疊卡片，畫面上跟沒
        // 被壓縮過一樣；只有block.silent!==true（話題轉移，使用者主動切換
        // 討論方向）才包成一張可摺疊的「已封存對話」卡片，明確提示這是
        // 一次話題轉場。
        (this.archivedDisplayBlocks || []).forEach((block, idx) => {
            if (block.silent) {
                block.messages.forEach(m => this._renderSingleMessage(m, chatBody, palette));
                return;
            }
            const archiveEl = document.createElement('details');
            archiveEl.style.cssText = `margin-bottom: 12px; font-size: 12px; background: ${palette.detailBg}; border-left: 4px solid #94a3b8; border-radius: 6px; padding: 6px 10px; color: ${palette.detailText}; max-width: 95%;`;
            const summaryEl = document.createElement('summary');
            summaryEl.style.cssText = 'font-weight: bold; outline: none; user-select: none; cursor: pointer;';
            summaryEl.textContent = `📦 已封存對話 #${idx + 1}（原因：${block.reason}，共${block.messages.length}則，點擊展開）`;
            archiveEl.appendChild(summaryEl);
            const inner = document.createElement('div');
            inner.style.cssText = 'margin-top: 6px;';
            block.messages.forEach(m => this._renderSingleMessage(m, inner, palette));
            archiveEl.appendChild(inner);
            chatBody.appendChild(archiveEl);
        });

        this.messages.forEach(msg => this._renderSingleMessage(msg, chatBody, palette));
        chatBody.scrollTop = chatBody.scrollHeight;
        this._persistChatHistory();
    }

    // tw_stock_db客製: 從 _renderMessageHistory() 拆出來的單則訊息渲染邏輯
    // （原本就是一個 forEach 內的大函式體，只是把 chatBody 換成參數化的
    // container），這樣同一套渲染規則可以重複用在「目前的訊息列表」跟
    // 「被封存起來的舊訊息」兩種情境，不用維護兩份重複邏輯。
    _renderSingleMessage(msg, container, palette) {
        // 隱藏最基礎無關的 System Prompt，避免畫面雜亂
        if (
            msg.role === 'system' &&
            !msg.content.startsWith('[歷史對話摘要') &&
            !msg.content.startsWith('[Topic Transition Summary') &&
            !msg.content.startsWith('[Steering]')
        ) return;

        // 💡 tw_stock_db客製：原生tool-call模式下，assistant訊息本身沒有
        // [CALL:...]文字（呼叫資訊在msg.tool_calls結構化欄位），比照文字
        // 模式的摺疊呈現方式，避免畫面出現一個空白的AI回覆泡泡。
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
            const detailEl = document.createElement('details');
            detailEl.style = `margin-bottom: 12px; font-size: 12px; background: #edf2f7; border-left: 4px solid #4a5568; border-radius: 6px; padding: 6px 10px; color: #4a5568; max-width: 95%; cursor: pointer;`;
            const callsText = msg.tool_calls.map(tc => `${tc.function?.name}(${tc.function?.arguments || ''})`).join('\n');
            detailEl.innerHTML = `
                <summary style="font-weight: bold; outline: none; user-select: none;">⚙️ 觸發本地工具呼叫（原生function call，點擊展開）</summary>
                <div style="margin-top: 6px; white-space: pre-wrap; font-family: monospace; background: #fff; padding: 6px; border-radius: 4px; border: 1px solid #e2e8f0;">${callsText}</div>
            `;
            container.appendChild(detailEl);
            return;
        }

        // 💡 情況一：如果訊息是 AI 輸出的 Tool 呼叫指令，例如 [CALL: xxx(...)]
        if (msg.role === 'assistant' && msg.content.trim().startsWith('[CALL:')) {
            const detailEl = document.createElement('details');
            detailEl.style = `margin-bottom: 12px; font-size: 12px; background: #edf2f7; border-left: 4px solid #4a5568; border-radius: 6px; padding: 6px 10px; color: #4a5568; max-width: 95%; cursor: pointer;`;
            detailEl.innerHTML = `
                <summary style="font-weight: bold; outline: none; user-select: none;">⚙️ 觸發本地工具呼叫 (點擊展開)</summary>
                <div style="margin-top: 6px; white-space: pre-wrap; font-family: monospace; background: #fff; padding: 6px; border-radius: 4px; border: 1px solid #e2e8f0;">${msg.content}</div>
            `;
            container.appendChild(detailEl);
            return;
        }

        // 💡 tw_stock_db客製擴充：Tool結果如果是 {type:'image', dataUrl}
        // 的JSON（例如get_chart_snapshot截圖），直接渲染成<img>，不要
        // 走下面情況二那種「摺疊起來的純文字」渲染——data URL通常是幾十
        // KB的base64字串，塞進純文字區塊只會很長一串看不出是圖片。
        if (msg.role === 'tool') {
            let imagePayload = null;
            // tw_stock_db客製: 優先看不可枚舉的_displayDataUrl（見
            // _pushToolResultMessage()的說明——msg.content現在只留提示文字，
            // 真正的圖片資料存在這個屬性上，不會被序列化進送給LLM的內容）；
            // 沒有的話才退回舊路徑嘗試解析msg.content本身是不是圖片JSON
            // （相容舊格式/其他呼叫路徑）。
            if (msg._displayDataUrl) {
                imagePayload = { type: 'image', dataUrl: msg._displayDataUrl };
            } else {
                try {
                    const parsed = JSON.parse(msg.content);
                    if (parsed && parsed.type === 'image' && typeof parsed.dataUrl === 'string') imagePayload = parsed;
                } catch (_) { /* 不是JSON，走下面一般文字流程 */ }
            }
            if (imagePayload) {
                const imgWrap = document.createElement('div');
                imgWrap.style.cssText = 'margin-bottom: 12px; max-width: 95%;';
                imgWrap.innerHTML = `
                    <div style="font-size: 12px; font-weight: bold; color: #319795; margin-bottom: 4px;">🖼️ 圖表截圖</div>
                    <img src="${imagePayload.dataUrl}" style="max-width: 100%; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1);">
                `;
                container.appendChild(imgWrap);
                return;
            }
        }

        // 💡 情況二：如果是 Tool 的執行回傳結果，或者 Topic 轉移的背景摘要
        if (
            msg.role === 'tool' ||
            (
                msg.role === 'system' &&
                (
                    msg.content.startsWith('[歷史對話摘要') ||
                    msg.content.startsWith('[Topic Transition Summary') ||
                    msg.content.startsWith('[Steering]')
                )
            )
        ) {
            let title = "ℹ️ 系統內部上下文";
            let bgColor = "#feebc8"; // 預設黃色
            let borderCol = "#dd6b20";
            let textColor = "#c05621";

            if (msg.role === 'tool') {
                title = "🛠️ 工具執行結果回傳";
                bgColor = "#e6fffa"; // 綠色調
                borderCol = "#319795";
                textColor = "#234e52";
            } else if (msg.content.startsWith('[Topic Transition Summary')) {
                title = "🔀 話題轉移/過渡背景摘要";
                bgColor = "#feebc8"; // 橘色調
                borderCol = "#dd6b20";
                textColor = "#c05621";
            } else if (msg.content.startsWith('[歷史對話摘要')) {
                title = "🧠 歷史對話壓縮快照 (Prune)";
                bgColor = "#edf2f7";
                borderCol = "#718096";
                textColor = "#2d3748";
            } else if (msg.content.startsWith('[Steering]')) {
                title = "🧭 Steering 指令";
                bgColor = "#ede9fe";
                borderCol = "#7c3aed";
                textColor = "#5b21b6";
            }

            const detailEl = document.createElement('details');
            detailEl.style = `margin-bottom: 12px; font-size: 12px; background: ${bgColor}; border-left: 4px solid ${borderCol}; border-radius: 6px; padding: 6px 10px; color: ${textColor}; max-width: 95%; cursor: pointer;`;
            detailEl.innerHTML = `
                <summary style="font-weight: bold; outline: none; user-select: none;">${title} (點擊展開)</summary>
                <div style="margin-top: 6px; white-space: pre-wrap; background: rgba(255,255,255,0.7); padding: 8px; border-radius: 4px;">${msg.content}</div>
            `;
            container.appendChild(detailEl);
            return;
        }

        // 💡 情況三：標準的 User 與 Assistant 對話節點（維持原樣，不折疊）
        const div = document.createElement('div');
        div.className = `ai-msg ai-${msg.role}`;
        div.style = `margin-bottom: 12px; padding: 8px 12px; border-radius: 6px; max-width: 85%; word-break: break-all; line-height:1.4; font-size: 14px;`;

        if (msg.role === 'user') {
            div.style.cssText += `background: ${palette.userBg}; color: ${palette.userText}; margin-left: auto; border-right: 4px solid #3182ce;`;
            div.innerHTML = `<b>You:</b> ${msg.content}`;
        } else {
            const thinking = this._extractThinkingContent(msg.content);
            if (thinking.thinking) {
                const detailEl = document.createElement('details');
                detailEl.style = `margin-bottom: 8px; font-size: 12px; background: ${palette.detailBg}; border-left: 4px solid #6366f1; border-radius: 6px; padding: 6px 10px; color: ${palette.detailText}; max-width: 95%;`;
                detailEl.innerHTML = `<summary style="font-weight: bold; outline: none; user-select: none;">🧠 思考過程 (點擊展開)</summary>`;
                const thinkDiv = document.createElement('div');
                thinkDiv.style.cssText = 'margin-top: 6px; white-space: pre-wrap; background: rgba(255,255,255,0.08); padding: 8px; border-radius: 4px;';
                thinkDiv.textContent = thinking.thinking;
                detailEl.appendChild(thinkDiv);
                container.appendChild(detailEl);
            }
            div.style.cssText += `background: ${palette.assistantBg}; color: ${palette.assistantText}; border-left: 4px solid #76b900;`;
            const label = document.createElement('div');
            label.style.cssText = 'margin-bottom: 4px;';
            label.innerHTML = '<b>🤖 AI:</b>';
            div.appendChild(label);
            const answerText = thinking.answer || '（已輸出思考內容）';
            // tw_stock_db客製: markdown函式庫載入完成前，先用純文字顯示（不
            // 讓使用者等），載入完成後這則訊息會在下一次_renderMessageHistory()
            // 重新整批渲染時自動變成排版過的版本（見下面的排程重繪邏輯）。
            if (typeof marked !== 'undefined' && typeof DOMPurify !== 'undefined') {
                const mdDiv = document.createElement('div');
                mdDiv.className = 'ai-markdown-body';
                try {
                    mdDiv.innerHTML = DOMPurify.sanitize(this._renderMarkdownWithMath(answerText));
                } catch (_) {
                    mdDiv.textContent = answerText;
                }
                div.appendChild(mdDiv);
            } else {
                div.appendChild(document.createTextNode(answerText));
                if (!this._markdownRerenderScheduled) {
                    this._markdownRerenderScheduled = true;
                    this._ensureMarkdownLibsLoaded().then(() => {
                        this._markdownRerenderScheduled = false;
                        this._renderMessageHistory();
                    });
                }
            }
        }
        container.appendChild(div);
    }

    _initEventListeners() {
        const win = document.getElementById('ai-floating-window');
        const inputKey = document.getElementById('ai-input-key');
        const inputAiUrl = document.getElementById('ai-url');
        const inputModelName = document.getElementById('ai-model-name');
        const inputText = document.getElementById('ai-input-text');
        const configPanel = document.getElementById('ai-config-panel');
        const suggestBar = document.getElementById('ai-autocomplete-bar');
        const suggestText = document.getElementById('ai-suggest-text');
        const advancedModal = document.getElementById('ai-advanced-modal');
        const toolEditorModal = document.getElementById('ai-tool-editor-modal');
        const aiFnModal = document.getElementById('ai-fn-modal');
        const aiFnEditorModal = document.getElementById('ai-fn-editor-modal');
        const ragModal = document.getElementById('ai-rag-modal');
        const ragEditorModal = document.getElementById('ai-rag-editor-modal');
        const rulesInput = document.getElementById('ai-rules-input');
        const functionsInput = document.getElementById('ai-custom-functions-input');
        const toolNameInput = document.getElementById('ai-tool-name-input');
        const toolDescInput = document.getElementById('ai-tool-desc-input');
        const toolScriptInput = document.getElementById('ai-tool-script-input');
        const fnCodeInput = document.getElementById('ai-fn-code-input');
        
        const hermesChkBx = document.getElementById('ai-hermes-evolve-chk');
        if (hermesChkBx) {
            hermesChkBx.addEventListener('change', (e) => {
                localStorage.setItem(this.HERMES_AUTO_EVOLVE_KEY, String(e.target.checked));
                this._log("🤖 Hermes 圖譜進化功能已" + (e.target.checked ? '開啟' : '關閉'));
            });
        }

        this._applyThemeStyles();
        this._syncStopButton();

        // tw_stock_db客製: 跟上面 _isLightTheme() 同一個原因，主題切換觀察的
        // 目標/屬性也要改成 <html> 的 data-theme，不然使用者在網頁上切換
        // 淺色/深色時，AI視窗不會跟著即時更新（要重新整理頁面才會生效）。
        const themeObserver = new MutationObserver(() => {
            this._applyThemeStyles();
            this._renderMessageHistory();
        });
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

        document.getElementById('ai-btn-close').onclick = () => this.toggleWindow();
        document.getElementById('ai-btn-clear-chat').onclick = () => {
            if (!this.messages.length && !(this.archivedDisplayBlocks || []).length) return;
            if (confirm('確定要清除目前的對話紀錄嗎？這個動作無法復原。')) this._clearChatHistory();
        };
        document.getElementById('ai-btn-config').onclick = () => {
            configPanel.style.display = configPanel.style.display === 'none' ? 'block' : 'none';
        };
        document.getElementById('ai-btn-advanced').onclick = () => this._openAdvancedModal();
        document.getElementById('ai-stop-response-btn').onclick = () => this._requestStopResponse();
        document.getElementById('ai-advanced-close').onclick = () => this._closeAdvancedModal();
        document.getElementById('ai-advanced-done').onclick = () => this._closeAdvancedModal();
        document.getElementById('ai-tool-add-btn').onclick = () => this._openToolEditor(-1);
        document.getElementById('ai-skill-export-btn').onclick = () => this._exportSkillZip();
        document.getElementById('ai-skill-import-input').addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) this._importSkillZip(file);
            e.target.value = '';
        });
        document.getElementById('ai-tool-editor-close').onclick = () => this._closeToolEditor();
        document.getElementById('ai-tool-editor-cancel').onclick = () => this._closeToolEditor();
        document.getElementById('ai-fn-manage-btn').onclick = () => this._openAiFnModal();
        document.getElementById('ai-fn-modal-close').onclick = () => this._closeAiFnModal();
        document.getElementById('ai-fn-modal-done').onclick = () => this._closeAiFnModal();
        document.getElementById('ai-fn-add-btn').onclick = () => this._openAiFnEditor('');
        document.getElementById('ai-fn-editor-close').onclick = () => this._closeAiFnEditor();
        document.getElementById('ai-fn-editor-cancel').onclick = () => this._closeAiFnEditor();
        document.getElementById('ai-settings-export-btn').onclick = () => this._exportSettings();
        document.getElementById('ai-settings-import-input').addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) this._importSettings(file);
            e.target.value = '';
        });
        document.getElementById('ai-rag-manage-btn').onclick = () => this._openRagModal();
        document.getElementById('ai-rag-modal-close').onclick = () => this._closeRagModal();
        document.getElementById('ai-rag-modal-done').onclick = () => this._closeRagModal();
        document.getElementById('ai-rag-add-btn').onclick = () => this._openRagEditor(null);
        document.getElementById('ai-rag-editor-close').onclick = () => this._closeRagEditor();
        document.getElementById('ai-rag-editor-cancel').onclick = () => this._closeRagEditor();
        document.getElementById('ai-rag-editor-save').onclick = () => this._saveRagRecord();
        document.getElementById('ai-rag-delete-selected-btn').onclick = () => this._deleteSelectedRagRecords();
        document.getElementById('ai-rag-export-btn').onclick = () => this._exportRag();
        document.getElementById('ai-rag-import-input').addEventListener('change', (e) => {
            const file = e.target.files && e.target.files[0];
            if (file) this._importRag(file);
            e.target.value = '';
        });
        document.getElementById('ai-rag-search-btn').onclick = () => {
            const kw = (document.getElementById('ai-rag-search-input').value || '').trim();
            this._loadAndRenderRag(kw);
        };
        document.getElementById('ai-rag-query-btn').onclick = () => {
            const q = (document.getElementById('ai-rag-search-input').value || '').trim();
            if (!q) { alert('請先輸入查詢文字'); return; }
            this._queryAndRenderRag(q);
        };
        document.getElementById('ai-rag-search-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                document.getElementById('ai-rag-search-btn').click();
            }
        });
        document.getElementById('ai-rag-select-all').addEventListener('change', (e) => {
            document.querySelectorAll('.ai-rag-row-check').forEach(cb => { cb.checked = e.target.checked; });
        });

        inputKey.addEventListener('input', () => {
            localStorage.setItem(this.STORAGE_KEY, inputKey.value.trim());
        });
        inputAiUrl.addEventListener('input', () => {
            localStorage.setItem(this.LLM_BASE_URL_KEY, inputAiUrl.value.trim());
        });
        inputModelName.addEventListener('input', () => {
            localStorage.setItem(this.LLM_MODEL_NAME_KEY, inputModelName.value.trim());
        });

        // tw_stock_db客製: 生成/取樣參數設定，跟上面API Key/URL/Model一樣採
        // 輸入即存的方式，不用另外按儲存鍵。
        const genContextWindowInput = document.getElementById('ai-gen-context-window');
        const genMaxOutputInput = document.getElementById('ai-gen-max-output');
        if (genContextWindowInput) {
            genContextWindowInput.addEventListener('input', () => {
                const n = Number(genContextWindowInput.value);
                if (Number.isFinite(n) && n > 0) this._getGenerationSettings().contextWindowTokens = Math.round(n);
                this._saveAdvancedSettings();
            });
        }
        if (genMaxOutputInput) {
            genMaxOutputInput.addEventListener('input', () => {
                const n = Number(genMaxOutputInput.value);
                if (Number.isFinite(n) && n > 0) this._getGenerationSettings().maxOutputTokens = Math.round(n);
                this._saveAdvancedSettings();
            });
        }
        SAMPLING_PARAM_KEYS.forEach(key => {
            const input = document.getElementById(`ai-param-${key}`);
            if (!input) return;
            input.addEventListener('input', () => {
                const raw = input.value.trim();
                const entry = this._getGenerationSettings().samplingParams[key];
                entry.value = raw === '' ? null : Number(raw);
                // 使用者自己重新輸入值，代表想再試一次，即使之前被伺服器拒絕過
                // 也重新啟用——不然使用者改了值卻永遠送不出去會很困惑。
                entry.disabled = false;
                this._saveAdvancedSettings();
                this._renderGenerationSettingsUI();
            });
        });
        rulesInput.addEventListener('input', () => {
            this.advancedSettings.rulesMd = rulesInput.value;
            this._saveAdvancedSettings();
        });
        functionsInput.addEventListener('input', () => {
            this.advancedSettings.customFunctions = functionsInput.value;
            this._saveAdvancedSettings();
            this._syncCodeEditor(functionsInput.closest('.ai-code-editor'));
        });
        [functionsInput, toolScriptInput, fnCodeInput].forEach(textarea => {
            textarea.addEventListener('scroll', () => this._syncCodeEditor(textarea.closest('.ai-code-editor')));
            textarea.addEventListener('input', () => this._syncCodeEditor(textarea.closest('.ai-code-editor')));
        });
        document.getElementById('ai-tool-editor-save').onclick = () => {
            const name = toolNameInput.value.trim();
            if (!name) {
                alert('Tool 名稱不能為空。');
                return;
            }
            if (this._isToolNameDuplicate(name, this.activeToolEditIndex)) {
                alert("Tool 名稱已存在：" + name);
                return;
            }
            try {
                this._validateCustomScript(functionsInput.value, 'Customize Functions');
                this._validateCustomScript(toolScriptInput.value, "Tool " + name + " Handler Script");
            } catch (err) {
                alert(err.message);
                return;
            }
            const nextTool = this._normalizeCustomTool({
                name,
                description: toolDescInput.value,
                handlerScript: toolScriptInput.value
            }, name);
            if (this.activeToolEditIndex >= 0) {
                this.advancedSettings.customTools.splice(this.activeToolEditIndex, 1, nextTool);
            } else {
                this.advancedSettings.customTools.push(nextTool);
            }
            this._saveAdvancedSettings();
            this._renderCustomToolList();
            this._closeToolEditor();
            this._log("已儲存自訂工具: " + name);
        };
        document.getElementById('ai-fn-editor-save').onclick = () => {
            const fnNameInput = document.getElementById('ai-fn-name-input');
            const fnDescInput = document.getElementById('ai-fn-desc-input');
            const name = fnNameInput.value.trim();
            const originalName = fnNameInput.dataset.originalName || '';
            const desc = fnDescInput.value.trim();
            const code = fnCodeInput.value.trim();
            if (!name) {
                alert('函式名稱不能為空。');
                return;
            }
            if (!code) {
                alert('函式體不能為空。');
                return;
            }
            try {
                this._validateCustomScript(code, 'AI函式 "' + name + '"');
            } catch (err) {
                alert(err.message);
                return;
            }
            if (!this.advancedSettings.aiCustomFunctions) this.advancedSettings.aiCustomFunctions = {};
            if (originalName && originalName !== name && Object.prototype.hasOwnProperty.call(this.advancedSettings.aiCustomFunctions, originalName)) {
                delete this.advancedSettings.aiCustomFunctions[originalName];
            }
            this.advancedSettings.aiCustomFunctions[name] = { description: desc, code };
            this._saveAdvancedSettings();
            this._syncFromAI();
            this._renderAiFnList();
            this._closeAiFnEditor();
            this._log("已儲存AI函式: " + name);
        };
        if (advancedModal) {
            advancedModal.addEventListener('click', (event) => {
                if (event.target === advancedModal) this._closeAdvancedModal();
            });
        }
        if (toolEditorModal) {
            toolEditorModal.addEventListener('click', (event) => {
                if (event.target === toolEditorModal) this._closeToolEditor();
            });
        }
        if (aiFnModal) {
            aiFnModal.addEventListener('click', (event) => {
                if (event.target === aiFnModal) this._closeAiFnModal();
            });
        }
        if (aiFnEditorModal) {
            aiFnEditorModal.addEventListener('click', (event) => {
                if (event.target === aiFnEditorModal) this._closeAiFnEditor();
            });
        }
        if (ragModal) {
            ragModal.addEventListener('click', (event) => {
                if (event.target === ragModal) this._closeRagModal();
            });
        }
        if (ragEditorModal) {
            ragEditorModal.addEventListener('click', (event) => {
                if (event.target === ragEditorModal) this._closeRagEditor();
            });
        }
        document.getElementById('ai-custom-tool-list').addEventListener('click', event => {
            const editBtn = event.target.closest('[data-tool-edit]');
            if (editBtn) {
                this._openToolEditor(Number(editBtn.dataset.toolEdit));
                return;
            }
            const deleteBtn = event.target.closest('[data-tool-delete]');
            if (!deleteBtn) return;
            const index = Number(deleteBtn.dataset.toolDelete);
            const tool = this.advancedSettings.customTools[index];
            if (!tool) return;
            if (!confirm("確定刪除自訂 tool「" + tool.name + "」嗎？")) return;
            this.advancedSettings.customTools.splice(index, 1);
            this._saveAdvancedSettings();
            this._renderCustomToolList();
            this._log("已刪除自訂工具: " + tool.name);
        });
        document.getElementById('ai-fn-list').addEventListener('click', event => {
            const runBtn = event.target.closest('[data-ai-fn-run]');
            if (runBtn) {
                this._runAiFunctionPrompt(runBtn.dataset.aiFnRun);
                return;
            }
            const editBtn = event.target.closest('[data-ai-fn-edit]');
            if (editBtn) {
                this._openAiFnEditor(editBtn.dataset.aiFnEdit);
                return;
            }
            const deleteBtn = event.target.closest('[data-ai-fn-delete]');
            if (!deleteBtn) return;
            const fnName = deleteBtn.dataset.aiFnDelete;
            if (!confirm("確定刪除AI函式「" + fnName + "」嗎？")) return;
            const fns = this.advancedSettings.aiCustomFunctions || {};
            if (Object.prototype.hasOwnProperty.call(fns, fnName)) {
                delete fns[fnName];
                this._saveAdvancedSettings();
                this._syncFromAI();
                this._renderAiFnList();
                this._log("已刪除AI函式: " + fnName);
            }
        });

        inputText.addEventListener('keydown', (e) => {
            if (this._isModalOpen(advancedModal) || this._isModalOpen(toolEditorModal) ||
                this._isModalOpen(aiFnModal) || this._isModalOpen(aiFnEditorModal) ||
                this._isModalOpen(ragModal) || this._isModalOpen(ragEditorModal)) {
                if (e.key === 'Escape') {
                    if (this._isModalOpen(ragEditorModal)) this._closeRagEditor();
                    else if (this._isModalOpen(ragModal)) this._closeRagModal();
                    else if (this._isModalOpen(aiFnEditorModal)) this._closeAiFnEditor();
                    else if (this._isModalOpen(toolEditorModal)) this._closeToolEditor();
                    else if (this._isModalOpen(aiFnModal)) this._closeAiFnModal();
                    else this._closeAdvancedModal();
                }
                return;
            }
            const currentVal = inputText.value;

            if (e.key === 'Tab') {
                e.preventDefault(); 
                if (suggestBar.style.display === 'block') {
                    inputText.value = suggestText.innerText;
                    suggestBar.style.display = 'none';
                    this.historyIndex = this.commandHistory.indexOf(inputText.value);
                }
                return;
            }

            if (e.key === 'ArrowUp') {
                if (currentVal === '' || this.historyIndex > -1) {
                    e.preventDefault();
                    if (this.commandHistory.length > 0 && this.historyIndex < this.commandHistory.length - 1) {
                        this.historyIndex++;
                        const selectedCmd = this.commandHistory[this.historyIndex];
                        suggestText.innerText = selectedCmd;
                        suggestBar.style.display = 'block';
                    }
                }
                return;
            }

            if (e.key === 'ArrowDown') {
                if (this.historyIndex > -1) {
                    e.preventDefault();
                    this.historyIndex--;
                    if (this.historyIndex === -1) {
                        suggestBar.style.display = 'none';
                    } else {
                        const selectedCmd = this.commandHistory[this.historyIndex];
                        suggestText.innerText = selectedCmd;
                        suggestBar.style.display = 'block';
                    }
                }
                return;
            }

            if (e.key === 'Enter') {
                if (e.shiftKey || e.ctrlKey) {
                    return; 
                }
                
                e.preventDefault();
                const textToSend = currentVal.trim();
                if (!textToSend) return;

                inputText.value = '';
                suggestBar.style.display = 'none';
                if (this.isResponding) {
                    this._setRespondingState(true, '⏳ AI 回應中（Steering 已加入）');
                }
                this.executeChat(textToSend);
            }
        });

        inputText.addEventListener('input', () => {
            if (inputText.value !== '') {
                suggestBar.style.display = 'none';
                this.historyIndex = -1;
            }
        });
        [functionsInput, toolScriptInput, fnCodeInput].forEach(textarea => this._syncCodeEditor(textarea.closest('.ai-code-editor')));
    }

    
}

window.FloatingAssistant = FloatingAssistant;
