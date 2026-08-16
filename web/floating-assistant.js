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
//      JSZip，由 web/index.html 動態載入後才會啟用這兩個方法）。
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
        
        this.tools = {};
        this.FromAI = {};
        this.messages = [];
        this.activeToolEditIndex = -1;
        
        this.commandHistory = JSON.parse(localStorage.getItem(this.HISTORY_KEY)) || [];
        this.historyIndex = -1;
        this.maxMessagesLimit = 20; 
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
            aiCustomFunctions: {}
        };
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
        return {
            rulesMd: String(raw.rulesMd || '').replace(/\r\n/g, '\n'),
            customFunctions: String(raw.customFunctions || '').replace(/\r\n/g, '\n'),
            customTools,
            aiCustomFunctions
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

        if (predefinedTools.length || customTools.length) {
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
                '[CALL: tool_name("arguments")]',
                'Do not output anything else in that turn. Once the user provides the [TOOL RESULT], you will continue answering.'
            ].join('\n'));
            sections.push(toolSections.join('\n\n'));
        }

        return sections.filter(Boolean).join('\n\n') || this.baseSystemPrompt;
    }

    _getApiConfig() {
        const apiKey = localStorage.getItem(this.STORAGE_KEY);
        let apiUrl = localStorage.getItem(this.LLM_BASE_URL_KEY) || 'https://integrate.api.nvidia.com/v1';
        let apiModel = localStorage.getItem(this.LLM_MODEL_NAME_KEY) || 'openai/gpt-oss-120b';
        return { apiKey, apiUrl, apiModel };
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
            return JSON.stringify(result, null, 2);
        } catch (err) {
            return String(result);
        }
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

    _isLightTheme() {
        return document.body.classList.contains('light-theme');
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
        configPanel.style.borderBottomColor = palette.windowBorder;
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
        this._syncAllCodeEditors();
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
    
    async pruneContext(reason = "Limit Exceeded") {
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

            this.messages = [{ role: "system", content: this._getFinalSystemPrompt() }];
            this.messages.push({ role: "system", content: `[歷史對話摘要(300 tokens 內)]: ${summaryResult}` });

            this._log("✅ 歷史對話壓縮完成！已釋放 Context 空間。");
            this._renderMessageHistory();

        } catch (err) {
            if (err.name === 'AbortError' || this.stopRequested) {
                this._log('🛑 已停止 AI 回應');
                return;
            }
            this._log("❌ 壓縮失敗: " + err.message);
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

        if (this.messages.length > this.maxMessagesLimit) {
            await this.pruneContext("Max count reached (>20)");
        }

        if (this.messages.length === 0) {
            this.messages.push({ role: "system", content: this._getFinalSystemPrompt() });
        }

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
                    messages: this.messages,
                    temperature: 0,
                    stream: true
                })
            });

            if (!response.ok) {
                if (response.status === 400 || response.status === 413) {
                    streamDiv.remove();
                    await this.pruneContext("Context Window Exception (Token Limit)");
                    return await this._loopFetch(apiKey, apiUrl, apiModel, 1);
                }
                throw new Error("HTTP " + response.status);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder('utf-8');
            let buffer = '';
            let fullContent = '';

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
                            const chunk = parsed.choices[0]?.delta?.content || '';
                            fullContent += chunk;
                            textSpan.innerText = fullContent;
                            chatBody.scrollTop = chatBody.scrollHeight;
                        } catch (_) {}
                    }
                }
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
                        
                        this.messages.push({ role: "tool", content: this._formatToolResult(result, task.fnName) });
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
                    <span id="ai-btn-config" style="cursor:pointer; margin-right: 10px;">⚙️</span>
                    <span id="ai-btn-close" style="cursor:pointer;">❌</span>
                </div>
            </div>
            <div id="ai-config-panel" style="display:none; background: ${palette.chatBg}; padding: 10px; border-bottom: 1px solid ${palette.windowBorder};">
                <label style="font-size:12px; font-weight:bold; display:block; margin-bottom:4px;">API KEY:</label>
                <input type="password" id="ai-input-key" style="width:100%; padding:6px; box-sizing:border-box; border:1px solid #ccc; border-radius:4px;">
                <label style="font-size:12px; font-weight:bold; display:block; margin-bottom:4px;">API URL:</label>
                <input type="text" id="ai-url" style="width:100%; padding:6px; box-sizing:border-box; border:1px solid #ccc; border-radius:4px;" placeholder='https://integrate.api.nvidia.com/v1'>
                <label style="font-size:12px; font-weight:bold; display:block; margin-bottom:4px;">MODEL NAME:</label>
                <input type="text" id="ai-model-name" style="width:100%; padding:6px; box-sizing:border-box; border:1px solid #ccc; border-radius:4px;" placeholder='openai/gpt-oss-120b'>
                
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
                            <div class="ai-advanced-label" style="margin:0;">Custom Tools</div>
                            <button type="button" id="ai-tool-add-btn" class="ai-advanced-btn primary">新增 Tool</button>
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
                        <h3 style="margin:0; color:#76b900;">編輯 Custom Tool</h3>
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
    
    _renderMessageHistory() {
        const chatBody = document.getElementById('ai-chat-body');
        const palette = this._getThemePalette();
        this._applyThemeStyles();
        chatBody.innerHTML = '';
        this.messages.forEach(msg => {
            // 隱藏最基礎無關的 System Prompt，避免畫面雜亂
            if (
                msg.role === 'system' &&
                !msg.content.startsWith('[歷史對話摘要') &&
                !msg.content.startsWith('[Topic Transition Summary') &&
                !msg.content.startsWith('[Steering]')
            ) return; 
            
            // 💡 情況一：如果訊息是 AI 輸出的 Tool 呼叫指令，例如 [CALL: xxx(...)]
            if (msg.role === 'assistant' && msg.content.trim().startsWith('[CALL:')) {
                const detailEl = document.createElement('details');
                detailEl.style = `margin-bottom: 12px; font-size: 12px; background: #edf2f7; border-left: 4px solid #4a5568; border-radius: 6px; padding: 6px 10px; color: #4a5568; max-width: 95%; cursor: pointer;`;
                detailEl.innerHTML = `
                    <summary style="font-weight: bold; outline: none; user-select: none;">⚙️ 觸發本地工具呼叫 (點擊展開)</summary>
                    <div style="margin-top: 6px; white-space: pre-wrap; font-family: monospace; background: #fff; padding: 6px; border-radius: 4px; border: 1px solid #e2e8f0;">${msg.content}</div>
                `;
                chatBody.appendChild(detailEl);
                return;
            }

            // 💡 tw_stock_db客製擴充：Tool結果如果是 {type:'image', dataUrl}
            // 的JSON（例如get_chart_snapshot截圖），直接渲染成<img>，不要
            // 走下面情況二那種「摺疊起來的純文字」渲染——data URL通常是幾十
            // KB的base64字串，塞進純文字區塊只會很長一串看不出是圖片。
            if (msg.role === 'tool') {
                let imagePayload = null;
                try {
                    const parsed = JSON.parse(msg.content);
                    if (parsed && parsed.type === 'image' && typeof parsed.dataUrl === 'string') imagePayload = parsed;
                } catch (_) { /* 不是JSON，走下面一般文字流程 */ }
                if (imagePayload) {
                    const imgWrap = document.createElement('div');
                    imgWrap.style.cssText = 'margin-bottom: 12px; max-width: 95%;';
                    imgWrap.innerHTML = `
                        <div style="font-size: 12px; font-weight: bold; color: #319795; margin-bottom: 4px;">🖼️ 圖表截圖</div>
                        <img src="${imagePayload.dataUrl}" style="max-width: 100%; border-radius: 6px; border: 1px solid rgba(0,0,0,0.1);">
                    `;
                    chatBody.appendChild(imgWrap);
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
                chatBody.appendChild(detailEl);
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
                    chatBody.appendChild(detailEl);
                }
                div.style.cssText += `background: ${palette.assistantBg}; color: ${palette.assistantText}; border-left: 4px solid #76b900;`;
                const label = document.createElement('b');
                label.textContent = '🤖 AI:';
                div.appendChild(label);
                div.appendChild(document.createTextNode(` ${thinking.answer || '（已輸出思考內容）'}`));
            }
            chatBody.appendChild(div);
        });
        chatBody.scrollTop = chatBody.scrollHeight;
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

        const themeObserver = new MutationObserver(() => {
            this._applyThemeStyles();
            this._renderMessageHistory();
        });
        themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });

        document.getElementById('ai-btn-close').onclick = () => this.toggleWindow();
        document.getElementById('ai-btn-config').onclick = () => {
            configPanel.style.display = configPanel.style.display === 'none' ? 'block' : 'none';
        };
        document.getElementById('ai-btn-advanced').onclick = () => this._openAdvancedModal();
        document.getElementById('ai-stop-response-btn').onclick = () => this._requestStopResponse();
        document.getElementById('ai-advanced-close').onclick = () => this._closeAdvancedModal();
        document.getElementById('ai-advanced-done').onclick = () => this._closeAdvancedModal();
        document.getElementById('ai-tool-add-btn').onclick = () => this._openToolEditor(-1);
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
