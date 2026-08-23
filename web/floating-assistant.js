// ============================================================
// 這是外部通用函式庫（原始檔案：ref-web-ai/floating-assistant.js），
// 給任何網頁掛載一個可mount/可浮動的AI聊天widget，支援tool-calling、
// RAG、自訂工具編輯器、批次/multi-agent分析。
//
// 【設計原則：這個檔案本身刻意不依賴任何特定應用領域】
// FloatingAssistant類別完全不知道「股票」「台股」是什麼——它只認得：
// 已註冊的工具（register_openai_tool，name+description+callback）、
// 系統prompt（setSystemPrompt，純文字）、API設定（localStorage的
// floating_ai_api_key/base_url/model_name）。所有跟這個專案（tw_stock_db）
// 有關的東西——AI_CAPABILITIES工具清單、DBMgr/StockDiagnosis等資料存取、
// 股票代號解析、AI_SYSTEM_PROMPT文字——全部留在web/index.html，透過
// register_openai_tool()/setSystemPrompt()這組公開介面注入，不會反過來
// 出現在這個檔案裡。換一個應用場景（例如客服系統、文件審查工具），只要
// 把index.html那層換掉、重新註冊一組工具，這個檔案完全不用改一行就能
// 直接沿用，包含下面第5點的批次/multi-agent引擎在內——runBatchSubAgents()
// 拿到的只是中性的字串陣列(items)跟一段指示文字(instruction)，不假設
// items是股票代號，用在任何「一份清單、每項獨立判斷」的場景都成立。
//
// tw_stock_db專案在這份副本上做了幾處客製擴充，每處都有明確標記
// 「tw_stock_db客製」，方便日後對照/同步上游新版：
//   1. _renderMessageHistory()：tool結果若是 {type:'image', dataUrl}
//      的JSON，額外渲染<img>（這是通用的圖片payload慣例，不是股票專屬——
//      任何工具想回傳圖片都可以用這個形狀，本專案的走勢圖截圖只是第一個
//      使用案例）。
//   2. 原生 tool/function call 偵測與切換（NATIVE_TOOLCALL_MODEL_PATTERNS
//      當退回預設值、_shouldUseNativeToolCalls、_buildNativeToolsSchema、
//      executeChat的原生路徑分支），加上主動探測機制
//      （_probeNativeToolSupport/_ensureNativeToolSupportProbed）：與其
//      只靠模型名稱pattern猜測支不支援原生tools/tool_choice，實際送一個
//      極小的探測請求問端點，探測結果快取進localStorage，換一個新模型
//      也能自動判斷正確，不用等pattern清單更新。
//   3. .skill (zip) 匯入/匯出（_importSkillZip/_exportSkillZip，需要
//      JSZip；只有使用者實際按下匯入/匯出按鈕時才動態注入CDN script
//      標籤，見 _ensureJSZipLoaded()，不使用這功能的人不用背這個依賴）。
//   4. 淺色/深色主題偵測預設改讀 <html data-theme>（_isLightTheme()、主題
//      MutationObserver），跟這個專案實際的主題切換機制對齊（原始函式庫
//      預設看 body 的 'light-theme' class，這個網頁從來不會加這個class）。
//      2026-08-23使用者把這份檔案複製到另一個沿用不同主題慣例的專案
//      合併時發現這裡原本寫死，改成可覆寫：host頁面可以提供
//      options.isLightTheme（回傳boolean的函式）自訂偵測邏輯，用自己的
//      訊號切換主題時另外呼叫公開方法refreshTheme()通知即時更新，兩者
//      都沒提供時才退回這裡的data-theme預設值——不再是唯一假設host頁面
//      慣例的地方了。
//   5. 批次/multi-agent分析引擎（runBatchSubAgents/_runSubAgentTask，見
//      該函式群組上方的說明）：把一份清單拆成N個獨立、用完即丟的子對話
//      平行處理，只留精簡結論流回主對話，不會讓主對話context隨清單長度
//      線性膨脹。這是通用能力，不是股票專屬——index.html把它包成一個叫
//      batch_analyze_stocks的工具，是「應用層怎麼用」，不是這個引擎的
//      設計本身。
//   6. 對話上下文膨脹的一系列防護（reasoning_content用非可枚舉屬性跟
//      msg.content分開存、_stripInlineBase64()防模型自己生成的文字混入
//      大段base64、pruneContext()壓縮時不再真的遺失已顯示內容、
//      _turnPruneCount限制同一輪對話的壓縮重試次數、_buildToolResultMessage
//      幫文字式[CALL:...]慣例的role:'tool'訊息補上這個NVIDIA相容端點
//      強制要求的tool_call_id）：這些全部是通用的聊天核心穩定性修正，
//      跟股票資料完全無關，任何用這個檔案的應用都會受益。
//   7. AI回覆訊息內建「匯出Markdown/PPTX/PDF」按鈕（_appendMarkdownExportButton
//      + 下面的faMarkdownTo*系列函式）：2026-08-23使用者要求這個功能要
//      內建在本檔案裡，不要像chipsProvider/onTableRendered那樣委派給
//      host頁面——這跟前面幾點的判斷標準一致：「把一段AI寫的口語化
//      markdown（#標題/**粗體**/-條列/|表格|）轉成投影片」是純粹的聊天
//      widget能力，不涉及任何tw_stock_db業務邏輯，所以直接內建、預設
//      就能用；PPTX用pptxgenjs、PDF用pdfmake（都是動態注入的CDN
//      script，只有使用者實際按下匯出才會載入，比照第3點.skill匯入的
//      作法，不使用這功能的人不用背這個依賴）。options.onExportMarkdown
//      仍然保留作為選用的覆寫掛勾——host頁面如果想要自己的版型/報告
//      結構（例如tw_stock_db自己的ReportExport，支援更多股票專屬的
//      投影片類型），提供這個callback就會優先使用；沒提供時退回這裡
//      的內建通用版本，而不是像之前那樣直接停用按鈕。
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
// FileCache — AI助理產生的檔案（PDF/PPTX/Markdown等匯出結果）的持久化LRU
// 快取。使用者明確要求：AI助理也要能產生檔案並提供下載，下載連結要能在
// 重新整理頁面後依然有效，所以真正的檔案位元組要存在IndexedDB（不是
// localStorage——那個容量只有5-10MB，一個PPTX/PDF隨便就會超過），並且
// 有容量上限（可在Advanced Settings設定，見 fileCacheLimitMB），超過上限
// 時比照 IndexedDBRAGSystem 同一套「刪最久沒被存取的」LRU邏輯淘汰。
// 訊息本身只存一個很小的 {id,filename,mimeType,sizeBytes} 參照（見
// FloatingAssistant.generateAndDeliverFile/_persistChatHistory的
// fileRefMap），不是把整個檔案位元組塞進聊天紀錄的JSON裡。
// ============================================================
class FileCache {
    constructor(dbName = 'FloatingAssistantFiles', maxBytes = 256 * 1024 * 1024) { // 預設 256MB
        this.dbName = dbName;
        this.storeName = 'files';
        this.maxBytes = maxBytes;
        this.db = null;
        this._ready = this._init();
    }

    _init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    const store = db.createObjectStore(this.storeName, { keyPath: 'id' });
                    store.createIndex('lastAccessedAt', 'lastAccessedAt', { unique: false });
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

    setMaxBytes(maxBytes) {
        if (Number.isFinite(maxBytes) && maxBytes > 0) this.maxBytes = maxBytes;
    }

    /* 存一個新檔案（blob直接存進IndexedDB，瀏覽器原生支援存Blob，不需要
       先轉base64——轉base64只會白白多佔1/3空間又浪費CPU）。存進去之後
       立刻檢查是否超過容量上限，超過就從「最久沒被存取」的開始刪，直到
       低於上限的95%（留一點緩衝，避免每次都卡在上限邊緣頻繁觸發淘汰）。
       回傳存進去的id，供訊息物件的_downloadFile參照使用。 */
    async put(filename, mimeType, blob) {
        const id = (crypto.randomUUID ? crypto.randomUUID() : `file_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
        const record = {
            id, filename, mimeType, blob,
            sizeBytes: blob.size,
            createdAt: Date.now(),
            lastAccessedAt: Date.now(),
        };
        await this._tx('readwrite', s => s.put(record));
        await this._evictToLimit();
        return id;
    }

    async _evictToLimit() {
        const all = await this.getAll();
        let total = all.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
        if (total <= this.maxBytes) return;
        all.sort((a, b) => (a.lastAccessedAt || 0) - (b.lastAccessedAt || 0)); // 最久沒被存取的排最前面
        const target = this.maxBytes * 0.95;
        const idsToDelete = [];
        for (const r of all) {
            if (total <= target) break;
            idsToDelete.push(r.id);
            total -= (r.sizeBytes || 0);
        }
        if (idsToDelete.length) await this.deleteMany(idsToDelete);
    }

    /* 取回一個檔案（連同blob本身），順便把lastAccessedAt洗新——LRU淘汰
       是看「最久沒被存取」，使用者重新整理頁面後只要訊息還顯示著、有去
       點開下載連結，這個檔案就該被視為「還在用」，不該被優先淘汰掉。 */
    async get(id) {
        const record = await this._tx('readonly', s => s.get(id));
        if (record) {
            record.lastAccessedAt = Date.now();
            await this._tx('readwrite', s => s.put(record)).catch(() => {});
        }
        return record;
    }

    async getAll() {
        return this._tx('readonly', s => s.getAll());
    }

    async delete(id) {
        return this._tx('readwrite', s => s.delete(id));
    }

    async deleteMany(ids) {
        await Promise.all(ids.map(id => this.delete(id)));
    }

    async totalBytes() {
        const all = await this.getAll();
        return all.reduce((sum, r) => sum + (r.sizeBytes || 0), 0);
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

// tw_stock_db客製: 端點回報「這個參數不認得」時常見的錯誤訊息關鍵字，
// _detectRejectedSamplingParam()跟_isStopParamRejected()共用同一份清單
// （沒有統一標準的provider錯誤格式，只能盡力而為關鍵字比對）。
const PARAM_REJECTION_HINTS = [
    'unrecognized', 'not supported', 'unsupported', 'unknown parameter',
    'unknown field', 'invalid parameter', 'extra fields not permitted',
    'unexpected keyword argument', 'not a valid', 'invalid request',
    'does not support', "isn't supported", 'not allowed'
];

// tw_stock_db客製: 文字式[CALL: name(args)]慣例專用的stop sequence——
// 呼叫格式固定是"...)]"結尾，模型只要正確收尾，伺服器端就會在生成到這裡
// 時直接截斷輸出，不用等模型自己（可能）繼續往下編一段假的[TOOL RESULT]
// 才由用戶端事後丟棄（見_extractBalancedCallArgs的說明）——省下那些被
// 丟棄的token，也從源頭降低「模型不停下來」造成的各種解析錯誤機率。只
// 用在文字式協定（見_loopFetch/_runSubAgentTask的useNative分支判斷），
// 原生tool_calls協定由API自己控制呼叫邊界，不需要也不應該加這個。
const CALL_STOP_SEQUENCE = ')]';

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

// tw_stock_db客製: 內建的模型清單，給MODEL NAME欄位的<datalist>下拉選單、
// 以及「MODEL NAME留空時自動fallback」機制（見_resolveAutoFallbackModel）
// 共用。使用者仍然可以自己輸入清單以外的任何模型名稱——這只是常用選項的
// 捷徑，不是限制。
//
// 2026-08-21使用者明確要求：順序依「參數量＋穩定度優先」排列，這是fallback
// 嘗試的順序，不是憑印象排的：
//   1. nvidia/nemotron-3-super-120b-a12b：能力最強，平常最穩，但使用者
//      2026-08-21回報「今天很不穩，偶爾404消失，過一段時間又恢復」——
//      研判是NVIDIA NIM那端的機器狀況，不是這個模型本身的問題，加入
//      fallback清單就是為了防這種暫時性下線。
//   2. nvidia/nemotron-3.5-lightning-30b-a3b：2026-08-21用/benchmark-model
//      實測過，完整多步驟報告流程會遇到「This model only supports
//      single tool-calls at once!」的伺服器錯誤，當時決定不內建——這次
//      使用者明確要求連同其他3個一起排入fallback清單，接受這個風險
//      （只有輪到它、剛好又觸發這個錯誤模式時才會影響那一次對話）。
//   3. nvidia/nemotron-3-nano-omni-30b-a3b-reasoning：同上，2026-08-21
//      實測簡單問題快，但完整報告流程會卡到近5分鐘沒回應——注意：
//      4xx/404以外的「掛住不回應」不在_resolveAutoFallbackModel處理的
//      404-only條件內，真的卡住時fallback機制不會自動跳下一個，需要
//      使用者手動按Stop再重送。
//   4. nvidia/nemotron-3-nano-30b-a3b：同上，實測過完整流程兩次都失敗
//      （一次誤把系統提示範例文字當真呼叫、一次直接空白回應），跟上面
//      兩個模型同樣的已知風險。
//   5. meta/llama-3.3-70b-instruct：能力較強，回應較慢(~18秒)，實測穩定。
//   6. openai/gpt-oss-120b：早期（見_getApiConfig()的說明）實測在NVIDIA
//      NIM端點上完整對話會整個卡住90秒以上沒有任何回應；2026-08-21用
//      _probeNativeToolSupport()重新探測時反而秒回，研判是端點狀況不
//      穩定、不是模型本身必然有問題，但仍保留這個已知風險紀錄。
//   7. openai/gpt-oss-20b：2026-08-21探測回應快（<1秒）。
//   8. meta/llama-3.1-8b-instruct：實測<1秒回應，最快但能力較弱，排在
//      清單最後，是最後的安全網。
const PRESET_MODEL_OPTIONS = [
    'nvidia/nemotron-3-super-120b-a12b',
    'nvidia/nemotron-3.5-lightning-30b-a3b',
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning',
    'nvidia/nemotron-3-nano-30b-a3b',
    'meta/llama-3.3-70b-instruct',
    'openai/gpt-oss-120b',
    'openai/gpt-oss-20b',
    'meta/llama-3.1-8b-instruct',
];

// tw_stock_db客製: 使用者要求「內建模型就提前把model card的支援tool call
// 建表紀錄，因為這個屬性是固定的」——用_probeNativeToolSupport()對真實
// 端點逐一探測過的結果（2026-08-21，透過使用者自己設定的Cloudflare Worker
// 端點測試），直接寫死在這裡，_shouldUseNativeToolCalls()/
// _ensureNativeToolSupportProbed()會優先查這份表，命中就直接用、不再對
// 這8個內建模型另外打探測請求——省下每個使用者自己在瀏覽器裡各測一次的
// 重複網路成本。meta/llama-3.3-70b-instruct探測時5次都在15秒逾時上限
// 精準卡住（可能是這個模型回應本來就慢、加上tools欄位更慢，探測用的
// 15秒逾時不夠長），沒辦法確認是否真的支援，保守寫false（退回文字式
// [CALL:...]協定，這也是本來就實測穩定能用的路徑）。使用者自訂的模型
// （不在這份表裡）不受影響，一樣照原本的邏輯即時探測。
const PRESET_MODEL_TOOLCALL_SUPPORT = {
    'nvidia/nemotron-3-super-120b-a12b': false,
    'nvidia/nemotron-3.5-lightning-30b-a3b': true,
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': true,
    'nvidia/nemotron-3-nano-30b-a3b': false,
    'meta/llama-3.3-70b-instruct': false, // 探測逾時、無法確認，保守值
    'openai/gpt-oss-120b': false,
    'openai/gpt-oss-20b': true,
    'meta/llama-3.1-8b-instruct': true,
};

// ============================================================
// AI回覆匯出PPTX/PDF——見檔案開頭說明第7點。只處理泛用的markdown（#標題、
// **粗體**、-條列、|表格|）轉投影片，不含任何應用領域專屬的投影片類型
// （那些屬於host頁面自己的報告系統，例如tw_stock_db的ReportExport，
// 透過options.onExportMarkdown覆寫時會用host頁面那一套，不會經過這裡）。
// ============================================================
const FA_PPTXGENJS_URL = 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js';
const FA_PDFMAKE_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.9/pdfmake.min.js';
const FA_PDFMAKE_FONTS_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.9/vfs_fonts.js';
// Noto Sans TC「繁體中文」子集，透過jsDelivr的fontsource鏡像取得TTF——
// pdfmake內建字型（Roboto）完全沒有中文字圖，不額外載入的話中文會整段
// 變成豆腐字方塊。
const FA_CJK_FONT_REGULAR_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-tc@latest/chinese-traditional-400-normal.ttf';
const FA_CJK_FONT_BOLD_URL = 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-tc@latest/chinese-traditional-700-normal.ttf';
const FA_EXPORT_PALETTE = { navy: '1E2761', txt: '333333', muted: '888888', border: 'DDDDDD', tileGray: 'F5F6FA', white: 'FFFFFF' };

const _faExportScriptCache = new Map();
function _faLoadScriptOnce(url) {
    if (_faExportScriptCache.has(url)) return _faExportScriptCache.get(url);
    const p = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = url;
        s.onload = () => resolve();
        s.onerror = () => reject(new Error(`匯出功能所需的外部程式庫載入失敗：${url}`));
        document.head.appendChild(s);
    });
    _faExportScriptCache.set(url, p);
    return p;
}

function _faArrayBufferToBase64(buf) {
    let binary = '';
    const bytes = new Uint8Array(buf);
    const chunkSize = 0x8000; // 32KB一塊，避免String.fromCharCode.apply一次吃進太多引數爆呼叫堆疊
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}

let _faCjkFontPromise = null;
async function _faEnsureCjkFontRegistered() {
    if (_faCjkFontPromise) return _faCjkFontPromise;
    _faCjkFontPromise = (async () => {
        const pdfMake = window.pdfMake;
        const [regularBuf, boldBuf] = await Promise.all([
            fetch(FA_CJK_FONT_REGULAR_URL).then(r => { if (!r.ok) throw new Error('中文字型下載失敗'); return r.arrayBuffer(); }),
            fetch(FA_CJK_FONT_BOLD_URL).then(r => { if (!r.ok) throw new Error('中文字型(粗體)下載失敗'); return r.arrayBuffer(); }),
        ]);
        pdfMake.vfs = pdfMake.vfs || {};
        pdfMake.vfs['NotoSansTC-Regular.ttf'] = _faArrayBufferToBase64(regularBuf);
        pdfMake.vfs['NotoSansTC-Bold.ttf'] = _faArrayBufferToBase64(boldBuf);
        pdfMake.fonts = Object.assign({}, pdfMake.fonts, {
            NotoSansTC: {
                normal: 'NotoSansTC-Regular.ttf', bold: 'NotoSansTC-Bold.ttf',
                italics: 'NotoSansTC-Regular.ttf', bolditalics: 'NotoSansTC-Bold.ttf',
            },
        });
    })();
    return _faCjkFontPromise;
}

// 上面載入的Noto Sans TC「chinese-traditional」子集字型經opentype.js實測
// charToGlyphIndex()確認缺這10個全形標點的字圖（.notdef），pdfmake找不到
// 字圖時畫出豆腐字方塊，轉成對應半形符號保證能顯示；其餘全形標點
// （。、「」『』【】—）這個子集有涵蓋，不轉換。
const FA_PDF_MISSING_PUNCT = { '！': '!', '％': '%', '（': '(', '）': ')', '－': '-', '：': ':', '；': ';', '？': '?', '～': '~', '，': ',' };
function _faSanitizePdfText(s) {
    if (s == null) return s;
    return String(s).replace(/[！％（）－：；？～，]/g, ch => FA_PDF_MISSING_PUNCT[ch] || ch);
}

function _faSplitMarkdownSections(text) {
    const lines = String(text || '').split('\n');
    const sections = [];
    let cur = { title: null, body: [] };
    for (const line of lines) {
        const m = /^#{1,3}\s+(.+?)\s*$/.exec(line);
        if (m) {
            if (cur.title !== null || cur.body.some(l => l.trim() !== '')) sections.push(cur);
            cur = { title: m[1], body: [] };
        } else {
            cur.body.push(line);
        }
    }
    if (cur.title !== null || cur.body.some(l => l.trim() !== '')) sections.push(cur);
    return sections.map(s => ({ title: s.title, body: s.body.join('\n').trim() }));
}

function _faChunkTextByLength(body, maxChars) {
    const paras = String(body || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
    const chunks = [];
    let cur = '', curLen = 0;
    for (const p of paras) {
        if (curLen && curLen + p.length + 2 > maxChars) { chunks.push(cur); cur = ''; curLen = 0; }
        cur += (cur ? '\n\n' : '') + p; curLen += p.length;
    }
    if (cur || !chunks.length) chunks.push(cur);
    return chunks;
}

// 偵測markdown pipe table（表頭列 + |---|---|分隔列），AI寫的表格內容
// 原本會被當純文字整段印出來（"| a | b |"原始語法），這裡解析成
// {columns, rows}丟給下面的faMarkdownToPptxBlob/faMarkdownToPdfBlob畫成
// 真正的表格。cell內容偶爾會塞"<br>"當作cell內分行（markdown表格語法
// 本身不能有真正的換行），順便轉成"\n"實際換行。
function _faIsTableSeparatorLine(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
}
function _faIsTableRowLine(line) {
    return line.includes('|') && line.trim() !== '';
}
function _faParseTableCell(v) {
    return String(v ?? '').trim().replace(/<br\s*\/?>/gi, '\n');
}
function _faParseTableRow(line) {
    let t = line.trim();
    if (t.startsWith('|')) t = t.slice(1);
    if (t.endsWith('|')) t = t.slice(0, -1);
    return t.split('|').map(_faParseTableCell);
}
function _faSplitMarkdownBlocks(text) {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let textBuf = [];
    const flushText = () => {
        const body = textBuf.join('\n').trim();
        if (body) blocks.push({ type: 'text', body });
        textBuf = [];
    };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (_faIsTableRowLine(line) && i + 1 < lines.length && _faIsTableSeparatorLine(lines[i + 1])) {
            flushText();
            const columns = _faParseTableRow(line);
            let j = i + 2;
            const rows = [];
            while (j < lines.length && _faIsTableRowLine(lines[j])) { rows.push(_faParseTableRow(lines[j])); j++; }
            blocks.push({ type: 'table', columns, rows });
            i = j - 1;
        } else {
            textBuf.push(line);
        }
    }
    flushText();
    return blocks;
}

// 給PPTX/PDF這種不吃markdown語法的純文字版面用：拿掉**/-符號，條列改用
// 純文字項目符號。
function _faMdLiteToPlainText(text) {
    return String(text || '')
        .split('\n')
        .map(line => {
            const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
            if (bullet) return '• ' + bullet[1].replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '$1');
            return line.replace(/\*\*(.+?)\*\*/g, '$1').replace(/(?<!\*)\*(?!\*)(.+?)\*(?!\*)/g, '$1');
        })
        .join('\n');
}

// 把一段AI寫的markdown拆成{type:'text'|'table', heading, body|columns/rows}
// 陣列——依#/##/###標題分段、每段再依表格邊界拆block、單一text block過長
// （>900字）再依段落邊界分頁，PPTX跟PDF共用同一份轉換結果。
function _faMarkdownToSlides(markdownText, heading) {
    const sections = _faSplitMarkdownSections(markdownText);
    const secList = sections.length ? sections : [{ title: null, body: markdownText }];
    const slides = [];
    secList.forEach(sec => {
        const secTitle = sec.title || heading;
        _faSplitMarkdownBlocks(sec.body).forEach(block => {
            if (block.type === 'table') {
                slides.push({ type: 'table', heading: secTitle, columns: block.columns, rows: block.rows });
            } else {
                const chunks = _faChunkTextByLength(block.body, 900);
                const n = chunks.length;
                chunks.forEach((body, i) => {
                    slides.push({ type: 'text', heading: n > 1 ? `${secTitle}（${i + 1}/${n}）` : secTitle, body });
                });
            }
        });
    });
    return slides;
}

async function _faMarkdownToPptxBlob(markdownText, heading) {
    await _faLoadScriptOnce(FA_PPTXGENJS_URL);
    const PptxGenJS = window.PptxGenJS;
    const pres = new PptxGenJS();
    pres.layout = 'LAYOUT_WIDE'; // 13.3"x7.5"，預設是10"寬的16x9，要先設過再addSlide
    pres.title = heading;

    const titleSlide = pres.addSlide();
    titleSlide.background = { color: FA_EXPORT_PALETTE.navy };
    titleSlide.addText(heading, { x: 0.8, y: 2.6, w: 11.7, h: 1.2, fontFace: 'Calibri', fontSize: 32, bold: true, color: FA_EXPORT_PALETTE.white, align: 'center' });
    titleSlide.addText(new Date().toLocaleDateString('zh-TW'), { x: 0.8, y: 3.8, w: 11.7, h: 0.5, fontFace: 'Calibri', fontSize: 14, color: FA_EXPORT_PALETTE.white, align: 'center' });

    const addHeadingSlideBase = (slideHeading) => {
        const s = pres.addSlide();
        s.background = { color: FA_EXPORT_PALETTE.white };
        s.addText(slideHeading || '', { x: 0.6, y: 0.4, w: 12.1, h: 0.6, fontFace: 'Calibri', fontSize: 22, bold: true, color: FA_EXPORT_PALETTE.navy });
        return s;
    };

    _faMarkdownToSlides(markdownText, heading).forEach((slide) => {
        const s = addHeadingSlideBase(slide.heading);
        if (slide.type === 'table') {
            const headerRow = (slide.columns || []).map(c => ({ text: String(c ?? ''), options: { bold: true, color: FA_EXPORT_PALETTE.white, fill: { color: FA_EXPORT_PALETTE.navy }, fontSize: 12 } }));
            const bodyRows = (slide.rows || []).map((r, ri) => (r || []).map(c => ({
                text: String(c ?? ''),
                options: { color: FA_EXPORT_PALETTE.txt, fontSize: 11, fill: { color: ri % 2 === 0 ? FA_EXPORT_PALETTE.white : FA_EXPORT_PALETTE.tileGray } },
            })));
            s.addTable([headerRow, ...bodyRows], { x: 0.6, y: 1.3, w: 12.1, autoPage: false, border: { type: 'solid', color: FA_EXPORT_PALETTE.border, pt: 0.5 } });
        } else {
            s.addText(_faMdLiteToPlainText(slide.body), { x: 0.6, y: 1.3, w: 12.1, h: 5.7, fontFace: 'Calibri', fontSize: 15, color: FA_EXPORT_PALETTE.txt, align: 'left', valign: 'top', lineSpacingMultiple: 1.3 });
        }
    });

    return pres.write({ outputType: 'blob' });
}

async function _faMarkdownToPdfBlob(markdownText, heading) {
    await _faLoadScriptOnce(FA_PDFMAKE_URL);
    await _faLoadScriptOnce(FA_PDFMAKE_FONTS_URL);
    await _faEnsureCjkFontRegistered();
    const pdfMake = window.pdfMake;

    const content = [
        { text: heading, style: 'h1' },
        { text: new Date().toLocaleDateString('zh-TW'), style: 'subtitle', margin: [0, 2, 0, 16] },
    ];
    _faMarkdownToSlides(markdownText, heading).forEach((slide) => {
        content.push({ text: slide.heading || '', style: 'h2' });
        if (slide.type === 'table') {
            const cols = slide.columns || [];
            const rows = slide.rows || [];
            content.push({
                table: {
                    headerRows: 1,
                    widths: cols.map(() => '*'),
                    body: [
                        cols.map(c => ({ text: String(c ?? ''), style: 'tableHeader' })),
                        ...rows.map(r => (r || []).map(c => ({ text: String(c ?? ''), style: 'tableCell' }))),
                    ],
                },
                layout: {
                    fillColor: (rowIdx) => (rowIdx === 0 ? FA_EXPORT_PALETTE.navy : (rowIdx % 2 === 0 ? FA_EXPORT_PALETTE.tileGray : null)),
                    hLineColor: () => FA_EXPORT_PALETTE.border, vLineColor: () => FA_EXPORT_PALETTE.border,
                    hLineWidth: () => 0.5, vLineWidth: () => 0.5,
                },
            });
        } else {
            content.push({ text: _faMdLiteToPlainText(slide.body), style: 'body' });
        }
        content.push({ text: '', margin: [0, 4, 0, 4] });
    });

    // 深度掃過整個content樹，把pdfmake載入的CJK字型不涵蓋的全形標點換成
    // 安全等效字（見_faSanitizePdfText說明），所有text節點統一在這裡
    // 處理一次，不用在上面組字串的地方各自記得呼叫。
    (function deepSanitize(node) {
        if (Array.isArray(node)) { node.forEach(deepSanitize); return; }
        if (!node || typeof node !== 'object') return;
        if (typeof node.text === 'string') node.text = _faSanitizePdfText(node.text);
        else if (Array.isArray(node.text)) deepSanitize(node.text);
        for (const v of Object.values(node)) {
            if (Array.isArray(v) || (v && typeof v === 'object')) deepSanitize(v);
        }
    })(content);

    const docDefinition = {
        pageSize: 'A4',
        pageMargins: [48, 56, 48, 56],
        footer: (currentPage, pageCount) => ({
            text: `第 ${currentPage} / ${pageCount} 頁`, alignment: 'center', fontSize: 8, color: FA_EXPORT_PALETTE.muted, margin: [0, 8, 0, 0],
        }),
        content,
        styles: {
            h1: { fontSize: 22, bold: true, color: FA_EXPORT_PALETTE.navy, margin: [0, 0, 0, 4] },
            h2: { fontSize: 14, bold: true, color: FA_EXPORT_PALETTE.navy, margin: [0, 10, 0, 6] },
            subtitle: { fontSize: 11, color: FA_EXPORT_PALETTE.muted, italics: true },
            body: { fontSize: 10.5, color: FA_EXPORT_PALETTE.txt, lineHeight: 1.35 },
            tableHeader: { fontSize: 10, bold: true, color: '#FFFFFF', fillColor: FA_EXPORT_PALETTE.navy, margin: [4, 4, 4, 4] },
            tableCell: { fontSize: 9.5, color: FA_EXPORT_PALETTE.txt, margin: [4, 4, 4, 4] },
        },
        defaultStyle: { font: 'NotoSansTC' },
    };

    return new Promise((resolve, reject) => {
        try { pdfMake.createPdf(docDefinition).getBlob(resolve); } catch (e) { reject(e); }
    });
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
        // tw_stock_db客製: this.messages原本純粹是記憶體內狀態，重新整理
        // 頁面（或AI分頁重新初始化）對話就整個消失——見_persistChatHistory()/
        // _loadPersistedChatHistory()，跟advancedSettings一樣存進localStorage。
        this.CHAT_HISTORY_KEY = "floating_ai_chat_history";
        // tw_stock_db客製: 使用者要求「經過/benchmark-model並被加入的模型，
        // 就給它一個model card」——每次/benchmark-model跑完（不管通過與否）
        // 都會把摘要結果存進這個key（見_saveModelCard/_getModelCards），
        // MODEL NAME輸入框的下拉選單（見_modelDatalistOptionsHtml）會把
        // 已經測過的模型也列進去、附上分數/結論當提示文字，不用等真的改
        // PRESET_MODEL_OPTIONS陣列（改陣列還是保留給「確定要長期內建」的
        // 模型），一般測試/曾經測過的模型也能在下拉選單裡看到歷史結果。
        this.MODEL_CARDS_KEY = "floating_ai_model_cards";
        // tw_stock_db客製: 見_ensureNativeToolSupportProbed()——用一個小探測
        // 請求實測「這個apiUrl+apiModel組合是不是真的支援原生tools/
        // tool_calls」，取代原本只靠模型名稱pattern猜測的作法（換一個新
        // 模型、pattern沒收錄到就一律被誤判成不支援）。探測結果確認完成後
        // 才寫進這個key，不會把「還沒測過」或「測到一半」的狀態存進去。
        this.NATIVE_TOOL_SUPPORT_CACHE_KEY = "floating_ai_native_tool_support_cache";
        this._nativeToolSupportCache = null; // lazy load，見_ensureNativeToolSupportProbed()
        // tw_stock_db客製: MODEL NAME留空時的自動fallback狀態，見
        // executeChat()/_nextAutoFallbackModel()的說明，每輪新對話開始時
        // 由executeChat()重新設定。
        this._autoFallbackActive = false;
        this._autoFallbackIndex = 0;

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
        // tw_stock_db客製: 斜線指令登記表，見register_slash_command()的說明。
        // 只登記真正屬於「這個聊天widget本身」的內建指令，tw_stock_db自己的
        // 業務邏輯指令一律由外部（index.html）呼叫register_slash_command()掛進來。
        this.slashCommands = new Map();
        this.register_slash_command(
            '/benchmark-model', '<model> [<api base url>] [<api key>]',
            '對指定模型跑三項基準測試（簡易回應/單一工具呼叫/完整多步驟報告），算加權總分評估要不要內建',
            (argsText) => this._handleBenchmarkModelCommand(argsText)
        );
        this.retryLimit = 10;
        this.retryBaseDelayMs = 800;
        this.retryMaxDelayMs = 4000;
        // tw_stock_db客製: retryLimit/retryAttempt原本是設計來擋「連續」
        // 400/413重試的，但工具呼叫成功後_loopFetch/_loopFetchNative都會把
        // retryAttempt重設回1（見那兩處的呼叫），代表只要中間穿插過一次
        // 成功的工具呼叫，retryLimit就形同虛設——實測遇到「壓縮→模型把整個
        // 任務重做一遍（重新呼叫工具）→context又被填滿→再壓縮」的迴圈，
        // 每一輪都有工具呼叫成功，retryAttempt每次都被重設，永遠不會撞到
        // retryLimit，導致這個迴圈實質上無限迴圈。_turnPruneCount是獨立於
        // retryAttempt之外、真正計算「這一輪使用者對話總共觸發過幾次
        // pruneContext」的計數器，不會被工具呼叫成功重設，只在executeChat()
        // 每次真正開始新一輪對話時歸零，才能確實擋住這種迴圈。
        this.maxPruneRetriesPerTurn = 3;
        this._turnPruneCount = 0;
        // tw_stock_db客製: 這一輪對話使用者真正打的原始文字，executeChat()
        // 一開始就存進來，pruneContext()重新接回問題時固定用這個，不會
        // 因為連續壓縮而巢狀疊加（見executeChat()跟pruneContext()兩處說明）。
        this._currentTurnUserText = null;
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
        // tw_stock_db客製: AI助理產生的檔案（PDF/PPTX/Markdown匯出結果）持久化
        // LRU快取，見 FileCache 類別的說明、generateAndDeliverFile()。跟RAG
        // 系統一樣依mount實例分開資料庫，避免同一頁掛多個AI助理實例時互相
        // 干擾彼此的檔案快取。
        this.fileCache = new FileCache('FloatingAssistantFiles_' + ragDbSuffix, this._getFileCacheLimitBytes());
        this._initUI();
        this._initEventListeners();
        this._registerBuiltinAiTools();
        this.refreshSuggestionChips();
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
            // tw_stock_db客製: batch_analyze_stocks工具（見runBatchSubAgents）
            // 同時開幾個子任務並行執行——太小沒有平行效益，太大容易一次炸開
            // 太多併發請求（共用金鑰的NVIDIA端點/Cloudflare Worker流量控管
            // 都可能吃不消，見worker.js的checkAndIncrementRateLimit），使用者
            // 可以在設定面板調整，_getBatchConcurrency()會夾在1~8之間。
            batchConcurrency: 4,
            // tw_stock_db客製: AI助理產生檔案（PDF/PPTX/Markdown）的持久化LRU
            // 快取容量上限，見 FileCache/generateAndDeliverFile()。超過上限
            // 時自動刪掉最久沒被存取的檔案，使用者可在Advanced Settings調整。
            fileCacheLimitMB: 256,
            // tw_stock_db客製: 2026-08-23使用者要求輸入框打「/」開頭時要跳出
            // 斜線指令選單（見_wireSlashCommandMenu），手機版也要有同樣的
            // 好處——這裡給使用者一個開關可以關掉（例如覺得干擾），預設開啟。
            slashCommandMenuEnabled: true,
        };
    }

    // fileCacheLimitMB 夾在 1~2048（MB）之間，防禦性寫法避免使用者填0/負數/
    // 超大數字把IndexedDB塞爆或讓FileCache邏輯除零。
    _getFileCacheLimitBytes() {
        const mb = Number(this.advancedSettings?.fileCacheLimitMB);
        const clamped = Number.isFinite(mb) && mb > 0 ? Math.min(2048, Math.max(1, mb)) : 256;
        return clamped * 1024 * 1024;
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
    //   講完）時自動重送「請接續」把內容拼起來（見MAX_AUTO_CONTINUE_ROUNDS）。
    //   2026-08調高預設值到16384並移除設定面板裡的手動輸入框——使用者反映
    //   不該讓人去調這種偏底層的參數：在有串流+自動接續機制兜底的前提下，
    //   max_tokens理論上只是「單次API呼叫的形式上限」，調太小才是真正會讓
    //   使用者「感覺到」截斷的原因（推理模型會先輸出一大段內部思考過程才給
    //   最終答案，值太小時常常整段max_tokens都花在思考階段、還沒寫到最終
    //   答案就被截斷，續接請求裡卻沒有辦法帶回被截斷的思考內容，容易讓模型
    //   在接續時又重新想一輪、一樣生不出答案——見_loopFetch/_loopFetchNative
    //   接續請求组裝處的說明）。調大預設值直接從根本上降低這種情況的機率，
    //   不需要靠使用者自己發現「怎麼回覆都是空的」再回頭調參數。
    // - samplingParams：value為null代表「沒特別設定，不送這個欄位」；
    //   disabled:true代表這個參數曾經被目標端點拒絕過(見
    //   _detectRejectedSamplingParam)，之後的請求都不會再帶，直到使用者
    //   自己在設定面板手動重新啟用。
    _createDefaultGenerationSettings() {
        return {
            contextWindowTokens: 8192,
            maxOutputTokens: 16384,
            samplingParams: {
                frequency_penalty: { value: 0, disabled: false },
                presence_penalty: { value: 0, disabled: false },
                repetition_penalty: { value: 1, disabled: false },
                length_penalty: { value: 0.3, disabled: false },
            },
            // tw_stock_db客製: 見CALL_STOP_SEQUENCE說明——只用在文字式[CALL:...]
            // 協定，被目標端點拒絕過(偵測到400+關鍵字)就記住，之後不再送這個
            // 欄位，跟samplingParams的disabled是同一套設計理念。
            stopSequenceDisabled: false,
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
            // tw_stock_db客製: 故意不讀raw.maxOutputTokens——這個值不再是使用者
            // 可調的設定（見_createDefaultGenerationSettings的說明），一律用
            // 目前的預設值，這樣舊使用者localStorage裡殘留的舊版低預設值
            // （例如4096）也會自動套用新的16384，不需要額外的settings遷移邏輯。
            maxOutputTokens: defaults.maxOutputTokens,
            samplingParams,
            stopSequenceDisabled: !!raw.stopSequenceDisabled,
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
        if (!PARAM_REJECTION_HINTS.some(h => lower.includes(h))) return null;
        for (const key of SAMPLING_PARAM_KEYS) {
            if (lower.includes(key)) return key;
        }
        return null;
    }

    // tw_stock_db客製: 只有文字式[CALL:...]協定的請求才會呼叫這個——把
    // CALL_STOP_SEQUENCE組進body.stop，除非這個端點之前已經拒絕過（見
    // _disableStopParam）。用陣列包起來是OpenAI相容API的標準stop參數格式
    // （單一字串也大多能接受，但陣列相容性更好）。
    _buildStopParamBody() {
        if (this._getGenerationSettings().stopSequenceDisabled) return {};
        return { stop: [CALL_STOP_SEQUENCE] };
    }

    _isStopParamRejected(errText) {
        if (!errText) return false;
        const lower = String(errText).toLowerCase();
        return PARAM_REJECTION_HINTS.some(h => lower.includes(h)) && lower.includes('stop');
    }

    // tw_stock_db客製: 跟_disableRejectedSamplingParam同樣的設計——標記後
    // 之後所有請求都不會再帶stop欄位，並留一則使用者看得到的記錄。
    _disableStopParam(errText) {
        const gs = this._getGenerationSettings();
        if (gs.stopSequenceDisabled) return false;
        gs.stopSequenceDisabled = true;
        this._saveAdvancedSettings();
        this.messages.push({
            role: 'system',
            content: `[Steering] 偵測到目前模型/端點不支援 "stop" 參數，已自動排除、之後的請求不會再帶這個欄位（可以到設定面板手動重新啟用）。伺服器回應片段：${String(errText || '').slice(0, 300)}`
        });
        this._renderMessageHistory();
        return true;
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
        const batchConcurrencyNum = Number(raw.batchConcurrency);
        const fileCacheLimitMBNum = Number(raw.fileCacheLimitMB);
        return {
            rulesMd: String(raw.rulesMd || '').replace(/\r\n/g, '\n'),
            customFunctions: String(raw.customFunctions || '').replace(/\r\n/g, '\n'),
            customTools,
            aiCustomFunctions,
            toolCallMode,
            generation: this._normalizeGenerationSettings(raw.generation),
            batchConcurrency: Number.isFinite(batchConcurrencyNum) && batchConcurrencyNum > 0 ? Math.round(batchConcurrencyNum) : 4,
            fileCacheLimitMB: Number.isFinite(fileCacheLimitMBNum) && fileCacheLimitMBNum > 0 ? Math.round(fileCacheLimitMBNum) : 256,
            slashCommandMenuEnabled: raw.slashCommandMenuEnabled !== false,
        };
    }

    // tw_stock_db客製: 統一的併發數存取入口，夾在1~8之間——上限8是保守值，
    // 避免使用者調太大時一次炸出過多併發請求（見_createDefaultAdvancedSettings
    // 裡batchConcurrency的說明）。
    _getBatchConcurrency() {
        const n = Number(this.advancedSettings.batchConcurrency);
        return Number.isFinite(n) && n > 0 ? Math.min(8, Math.round(n)) : 4;
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
        // tw_stock_db客製: 使用者調整檔案快取容量上限後要立即生效，不用重新
        // 整理頁面——下一次saveGeneratedFile()觸發LRU淘汰檢查時就會照新的
        // 上限計算，這裡只是同步this.fileCache.maxBytes這個數字本身。
        if (this.fileCache) this.fileCache.setMaxBytes(this._getFileCacheLimitBytes());
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

    // tw_stock_db客製: 給「MODEL NAME留空時自動fallback」機制用——跟
    // _getApiConfig()分開，是因為_getApiConfig()本來就會把空白欄位預設成
    // 固定的第一個模型（給benchmark工具、原生探測等其他呼叫端用，維持
    // 既有行為不變），這裡要看的是「使用者真的完全沒填」這個原始狀態，
    // 才能判斷該不該啟動fallback，而不是每次都直接固定用第一個模型。
    _isModelFieldBlank() {
        return !(localStorage.getItem(this.LLM_MODEL_NAME_KEY) || '').trim();
    }

    // tw_stock_db客製: 只有this._autoFallbackActive（本輪對話一開始MODEL
    // NAME留空）且status===404時才回傳下一個候選模型名稱，否則回傳null
    // （呼叫端不換模型，照原本的邏輯處理這次錯誤）。this._autoFallbackIndex
    // 是實例狀態，同一輪對話裡不管中途重試幾次都會往前推進、不會回頭，
    // 直到清單用完或成功一次；下一次executeChat()才會重新從0開始（見
    // executeChat()裡的說明）。
    _nextAutoFallbackModel(status, currentModel) {
        if (status !== 404 || !this._autoFallbackActive) return null;
        if (this._autoFallbackIndex >= PRESET_MODEL_OPTIONS.length - 1) return null;
        this._autoFallbackIndex++;
        return PRESET_MODEL_OPTIONS[this._autoFallbackIndex];
    }

    // tw_stock_db客製: 使用者要求「在AI Assistant (Graph RAG)右邊顯示model
    // name，用小字體」——isFallback為true時額外標註「自動」，讓使用者知道
    // 目前這個模型是MODEL NAME留空時系統自動選的，不是自己指定的。
    _updateHeaderModelName(apiModel, isFallback) {
        const el = document.getElementById('ai-header-model-name');
        if (!el) return;
        el.textContent = isFallback ? `${apiModel}（自動）` : apiModel;
        el.title = isFallback
            ? `MODEL NAME欄位留空，系統依內建清單順序自動選用；若目前這個模型無法使用(404)會自動改下一個。`
            : '';
    }

    // tw_stock_db客製: 判斷目前要不要用原生 tools/tool_calls API格式，而不是
    // [CALL: ...]文字慣例。advancedSettings.toolCallMode三態: 'native'/'text'
    // 直接照使用者指定；'auto'(預設)則依模型名稱pattern猜測。
    _shouldUseNativeToolCalls(apiModel) {
        const mode = this.advancedSettings.toolCallMode || 'auto';
        if (mode === 'native') return true;
        if (mode === 'text') return false;
        // tw_stock_db客製: auto模式優先信任_ensureNativeToolSupportProbed()
        // 實測過的結果（見那邊的說明——用一個小探測請求直接問端點支不支援
        // tools/tool_choice，而不是靠模型名稱pattern猜）；還沒探測過、或
        // 探測還在進行中時，才退回舊的pattern比對當暫時預設，確保第一次
        // 呼叫（探測結果還沒回來）仍然有個可用的判斷依據。
        const { apiUrl } = this._getApiConfig();
        const key = this._nativeProbeCacheKey(apiUrl, apiModel);
        if (this._nativeToolSupportCache && Object.prototype.hasOwnProperty.call(this._nativeToolSupportCache, key)) {
            return this._nativeToolSupportCache[key];
        }
        // tw_stock_db客製: 內建模型清單已經預先探測建表（見
        // PRESET_MODEL_TOOLCALL_SUPPORT說明），優先查這份表，比name pattern
        // 猜測準確，也不用等第一次對話才臨時打探測請求。
        if (Object.prototype.hasOwnProperty.call(PRESET_MODEL_TOOLCALL_SUPPORT, apiModel)) {
            return PRESET_MODEL_TOOLCALL_SUPPORT[apiModel];
        }
        const name = String(apiModel || '');
        return NATIVE_TOOLCALL_MODEL_PATTERNS.some(re => re.test(name));
    }

    _nativeProbeCacheKey(apiUrl, apiModel) {
        return `${apiUrl}::${apiModel}`;
    }

    // tw_stock_db客製: 送一個極小的探測請求，直接問這個apiUrl+apiModel組合
    // 「你真的支援tools/tool_choice嗎」，用回應內容判斷——比起僅靠模型
    // 名稱pattern猜測可靠得多（使用者換一個新模型，pattern清單沒收錄到
    // 就會一律被誤判成不支援，被迫走容易出錯的文字式[CALL:...]慣例）。
    // 刻意用tool_choice:'auto'+ 強烈措辭的提示（而不是'required'）——部分
    // 較舊的OpenAI相容端點可能不支援'required'這個值本身，用'auto'搭配
    // 明確指示風險較低，不會把「端點不支援tool_choice:required」誤判成
    // 「端點完全不支援原生tool_calls」。任何錯誤（網路、逾時、端點拒絕
    // tools欄位等）都當作「不支援」處理，安全退回文字式慣例，不影響對話
    // 能不能繼續進行。
    async _probeNativeToolSupport(apiKey, apiUrl, apiModel) {
        try {
            const controller = this._createAbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            let response;
            try {
                response = await fetch(`${apiUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    signal: controller.signal,
                    body: JSON.stringify({
                        model: apiModel,
                        messages: [
                            { role: 'system', content: 'You are a capability test harness.' },
                            { role: 'user', content: 'You MUST call the "ping" function now with no arguments. Do not respond with any text, only call the function.' },
                        ],
                        temperature: 0,
                        max_tokens: 50,
                        stream: false,
                        tools: [{
                            type: 'function',
                            function: {
                                name: 'ping',
                                description: 'A no-op test tool used only to verify native tool-calling support. Call this now.',
                                parameters: { type: 'object', properties: {}, additionalProperties: false },
                            },
                        }],
                        tool_choice: 'auto',
                    }),
                });
            } finally {
                clearTimeout(timeoutId);
            }
            if (!response.ok) return false;
            const data = await response.json();
            const message = data.choices && data.choices[0] && data.choices[0].message;
            return !!(message && Array.isArray(message.tool_calls) && message.tool_calls.length > 0);
        } catch (_) {
            return false;
        }
    }

    // tw_stock_db客製: 探測結果的快取入口——同一個apiUrl+apiModel組合只會
    //真的送一次探測請求，之後都直接讀快取（記憶體+localStorage雙層，見
    // NATIVE_TOOL_SUPPORT_CACHE_KEY的說明），不會每一輪對話都重新打一次。
    // 「確認完畢才寫進persistent storage」：_probeNativeToolSupport()完全
    // resolve、拿到明確的true/false之後才呼叫_saveNativeToolSupportCache()，
    // 探測進行中的狀態不會被提前存下來。
    async _ensureNativeToolSupportProbed(apiKey, apiUrl, apiModel) {
        if (!this._nativeToolSupportCache) this._nativeToolSupportCache = this._loadNativeToolSupportCache();
        const key = this._nativeProbeCacheKey(apiUrl, apiModel);
        if (Object.prototype.hasOwnProperty.call(this._nativeToolSupportCache, key)) {
            return this._nativeToolSupportCache[key];
        }
        // tw_stock_db客製: 內建模型已經預先探測好（見PRESET_MODEL_TOOLCALL_SUPPORT
        // 說明），直接用固定值寫進快取，省下這次網路探測請求。
        if (Object.prototype.hasOwnProperty.call(PRESET_MODEL_TOOLCALL_SUPPORT, apiModel)) {
            const preset = PRESET_MODEL_TOOLCALL_SUPPORT[apiModel];
            this._nativeToolSupportCache[key] = preset;
            this._saveNativeToolSupportCache();
            return preset;
        }
        const supported = await this._probeNativeToolSupport(apiKey, apiUrl, apiModel);
        this._nativeToolSupportCache[key] = supported;
        this._saveNativeToolSupportCache();
        this._log(supported
            ? `✅ 已探測確認 ${apiModel} 支援原生 tool_calls，之後對話改用原生模式。`
            : `ℹ️ ${apiModel} 不支援（或探測失敗/逾時）原生 tool_calls，使用文字式 [CALL:...] 慣例。`);
        return supported;
    }

    _loadNativeToolSupportCache() {
        try {
            return JSON.parse(localStorage.getItem(this.NATIVE_TOOL_SUPPORT_CACHE_KEY) || '{}');
        } catch (_) {
            return {};
        }
    }

    _saveNativeToolSupportCache() {
        try {
            localStorage.setItem(this.NATIVE_TOOL_SUPPORT_CACHE_KEY, JSON.stringify(this._nativeToolSupportCache || {}));
        } catch (_) { /* localStorage滿了頂多下次重新探測，不影響功能 */ }
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
        // tw_stock_db客製: _pushToolResultMessage()已經專門處理過
        // {type:'image',dataUrl}這個結構化圖片payload了，這裡是走到這個函式
        // 代表沒被判定成圖片——但如果那份JSON.parse因為某種原因失敗（例如
        // 內容剛好不是嚴格合法JSON），或工具直接回傳了帶base64的字串，還是
        // 可能有大段base64混在裡面，用_stripInlineBase64()兜底清掉，避免
        // 意外塞進送給模型的訊息內容裡（見那個函式的說明）。
        if (typeof result === 'string') return this._stripInlineBase64(result);
        if (typeof result === 'undefined') return `[Tool 回傳成功] ${toolName} 執行完成`;
        try {
            // tw_stock_db客製: 原本用 JSON.stringify(result, null, 2) 美化縮排，
            // 但這段文字是直接塞進送給模型的訊息內容，縮排/換行對LLM閱讀沒有
            // 幫助，純粹浪費token（實測同一份300筆OHLCV資料，美化版比壓縮版
            // 多耗費約23%字元數）。畫面上的<details>區塊本身就是等寬字型+
            // 自動換行，壓縮後照樣可讀。
            return this._stripInlineBase64(JSON.stringify(result));
        } catch (err) {
            return this._stripInlineBase64(String(result));
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
    // tw_stock_db客製: 把assistant訊息push進this.messages的共用邏輯，統一
    // 套用_stripInlineBase64（防模型自己生成的文字混進base64，見那個函式
    // 的說明）跟_reasoningDisplay的非可枚舉存放方式（防reasoning_content
    // 被重複送進API，見_loopFetch/_loopFetchNative頂端的說明）。_loopFetch
    // 的文字式CALL路徑跟_loopFetchNative的原生路徑都改用這個，避免兩處各自
    // 維護一份同樣邏輯、容易改一邊忘了改另一邊。
    _pushAssistantMessage(content, reasoning, extra) {
        const msg = Object.assign({ role: 'assistant', content: this._stripInlineBase64(content) }, extra || {});
        if (reasoning) {
            Object.defineProperty(msg, '_reasoningDisplay', { value: this._stripInlineBase64(reasoning), enumerable: false, configurable: true });
        }
        this.messages.push(msg);
        return msg;
    }

    // tw_stock_db客製: 通用能力——讓AI助理（或host app透過register_openai_tool
    // 註冊的工具）可以直接產生一個檔案（PDF/PPTX/Markdown/任何Blob）並在對話
    // 裡提供下載連結。設計上跟圖片（_displayDataUrl）同一個原則：訊息的
    // content只留一句給LLM看的確認文字，真正的檔案位元組不進content（不會
    // 被送進下一輪API request、也不佔token估算），改存進this.fileCache這個
    // 獨立的IndexedDB LRU快取（見FileCache類別），訊息上只掛一個很小的
    // _downloadFile參照（非可枚舉，跟_displayDataUrl一樣的理由）。
    //
    // 使用者明確要求的行為：
    // 1. 暫存在persistent storage（IndexedDB，不是localStorage）
    // 2. LRU淘汰、容量上限可在設定調整（見fileCacheLimitMB）
    // 3. 產生下載連結嵌入對話（見_renderSingleMessage的_downloadFile分支）
    // 4. 下載連結重新整理頁面後依然有效（每次渲染時從IndexedDB重新取出
    //    blob、用URL.createObjectURL()現生一個物件URL，不依賴瀏覽器分頁
    //    存活期間才有效的舊URL字串——效果等同data URL可以持久使用，但
    //    不需要真的把整個檔案base64編碼存進聊天紀錄JSON裡，省空間也省
    //    CPU）。
    async generateAndDeliverFile(blob, filename, mimeType) {
        if (!(blob instanceof Blob)) throw new Error('generateAndDeliverFile 需要一個 Blob');
        const id = await this.fileCache.put(filename, mimeType || blob.type || 'application/octet-stream', blob);
        const sizeLabel = blob.size >= 1024 * 1024 ? `${(blob.size / 1024 / 1024).toFixed(2)} MB` : `${(blob.size / 1024).toFixed(1)} KB`;
        const msg = this._pushAssistantMessage(`📎 已產生檔案：${filename}（${sizeLabel}），請點下方連結下載。`, null);
        Object.defineProperty(msg, '_downloadFile', {
            value: { id, filename, mimeType: mimeType || blob.type, sizeBytes: blob.size },
            enumerable: false, configurable: true,
        });
        this._persistChatHistory();
        this._renderMessageHistory();
        return { id, filename };
    }

    // tw_stock_db客製: 把「工具執行結果」組成訊息物件的邏輯，跟「push進
    // this.messages」拆開——runBatchSubAgents()的子任務有自己獨立、用完即丟
    // 的本地訊息陣列（不是this.messages），需要同一套圖片/meta處理規則，
    // 但不能push進主對話。
    _buildToolResultMessage(fnName, result, extra) {
        let imageDataUrl = null;
        let imageMeta = null;
        try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed && parsed.type === 'image' && typeof parsed.dataUrl === 'string') {
                imageDataUrl = parsed.dataUrl;
                // tw_stock_db客製: 圖片本身不列入對話上下文（見下面），但如果
                // 工具額外附了一個輕量的meta摘要（例如render_stock_chart回傳
                // 實際畫出來的高低點價位/時間），這個摘要要照樣送進模型看得到
                // 的content，不能被「圖片=整包隱藏」的規則一起吃掉——不然模型
                // 完全沒有真實數字可以用來下精準的標記/線段，只能瞎猜（實測
                // 遇到的真實案例：標記位置對不齊K棒）。
                if (parsed.meta && typeof parsed.meta === 'object') imageMeta = parsed.meta;
            }
        } catch (_) { /* 不是圖片payload，走下面一般文字流程 */ }

        const msg = Object.assign({ role: 'tool' }, extra || {});
        // tw_stock_db客製: 實測發現這個NVIDIA相容端點無論是不是走原生
        // tools/tool_calls，只要訊息陣列裡出現role:'tool'就一律要求要有
        // tool_call_id欄位，缺了就直接回400「missing field tool_call_id」
        // ——用curl/最小化對話重現、確認加上這個欄位後同一個請求就變成
        // 200。文字式[CALL:...]慣例（非原生路徑）原本完全不會帶這個欄位，
        // 因為它不是走API的原生tool_calls機制、沒有「真正」的id可用。
        //
        // 這是這次session一直反覆出現的「AI一直撞到context limit又觸發
        // 壓縮、壓縮完還是同樣狀況」的真正根因之一：_loopFetch的400/413
        // 處理原本看到任何400就無條件當成「Context Window Exception」去
        // 壓縮，從來沒有真的檢查過errText內容——壓縮把this.messages換成
        // [system, summary]後，因為暫時沒有role:'tool'訊息，下一次請求
        // 就會成功，看起來像是「修好了」，但只要對話裡再出現任何一次工具
        // 呼叫，同一個400就會再發生一次，形成表面上看起來像「一直撞到
        // context limit」、實際上是同一個schema驗證錯誤反覆觸發的假象。
        // 這裡幫每一則沒有帶tool_call_id的role:'tool'訊息補一個自己產生
        // 的合成id（原生路徑呼叫時extra已經帶了API給的真正tool_call_id，
        // 不會被這裡覆蓋，見_loopFetchNative/_runSubAgentTask原生分支）。
        if (msg.role === 'tool' && !msg.tool_call_id) {
            msg.tool_call_id = `call_text_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
        }
        if (imageDataUrl) {
            msg.content = `[Tool ${fnName} 已產生一張圖表圖片，已直接顯示給使用者看，圖片二進位內容不列入對話上下文]`
                + (imageMeta ? ` 圖表實際資料摘要（如需精準標記請以此為準，不要自行估計）：${this._stripInlineBase64(JSON.stringify(imageMeta))}` : '');
            Object.defineProperty(msg, '_displayDataUrl', { value: imageDataUrl, enumerable: false, configurable: true });
        } else {
            msg.content = this._formatToolResult(result, fnName);
        }
        return msg;
    }

    _pushToolResultMessage(fnName, result, extra) {
        const msg = this._buildToolResultMessage(fnName, result, extra);
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

    // tw_stock_db客製: 文字式[CALL: name(args)]慣例的「找出這個呼叫自己的
    // 參數邊界」共用邏輯，被_loopFetch跟runBatchSubAgents各自的fallback
    // 解析路徑共用（見下面呼叫端的說明）。從緊接在函式名稱後面的那個 '('
    // 開始，逐字元掃描、正確跳過字串內容（單/雙引號、反斜線跳脫）跟巢狀的
    // ()/{}/[]，找到跟這個 '(' 真正配對的那個 ')'——不管字串裡剩下的內容
    // 是乾淨的下一輪對話、還是模型自己接著編造的假[TOOL RESULT]/推理文字/
    // 甚至又寫了另一個[CALL:...]，都不會被誤吞進這個呼叫的參數裡。掃到
    // 字串結尾都還沒配對成功（模型真的沒把這次呼叫寫完）就回傳掃到底的
    // 內容當最佳猜測，並把endIndex設成text.length。
    _extractBalancedCallArgs(text, openParenIndex) {
        let depth = 0, inStr = null;
        let i = openParenIndex;
        for (; i < text.length; i++) {
            const c = text[i];
            if (inStr) {
                if (c === '\\') { i++; continue; } // 跳過跳脫字元本身+它跳脫的那個字元
                if (c === inStr) inStr = null;
                continue;
            }
            if (c === '"' || c === "'") { inStr = c; continue; }
            if (c === '(' || c === '{' || c === '[') { depth++; continue; }
            if (c === ')' || c === '}' || c === ']') {
                depth--;
                if (depth === 0 && c === ')') {
                    return { content: text.slice(openParenIndex + 1, i), endIndex: i + 1 };
                }
            }
        }
        // 沒找到配對的')'：掃到底，回傳目前為止的內容當最佳猜測。
        return { content: text.slice(openParenIndex + 1), endIndex: text.length };
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

    // 不同host頁面標示淺色/深色主題的慣例不一致（body class、html
    // data-theme屬性、或其他自訂機制皆有可能），這裡不假設任何一種為
    // 通用預設：優先讓host頁面透過options.isLightTheme（回傳boolean的
    // 函式）自行提供偵測邏輯，沒有提供時才退回本函式庫的預設慣例（讀
    // <html data-theme>，tw_stock_db本身就是用這個屬性，見
    // web/index.html的isDark()）。2026-08-23使用者把這個檔案複製到另一個
    // 專案（沿用不同的主題慣例）合併時發現原本寫死讀data-theme，改成這樣
    // 才符合「floating-assistant.js本身不假設任何host頁面慣例」的設計
    // 原則（見檔案開頭說明）。
    _isLightTheme() {
        if (typeof this.options.isLightTheme === 'function') {
            try {
                return !!this.options.isLightTheme();
            } catch (e) {
                console.error('options.isLightTheme 執行失敗，改用預設主題偵測:', e);
            }
        }
        return document.documentElement.getAttribute('data-theme') !== 'dark';
    }

    // 公開方法，讓host頁面在自己切換主題的地方主動呼叫，強制AI視窗重新
    // 套用主題（見上面bindEvents()裡themeObserver的說明：預設的
    // MutationObserver只認得<html data-theme>，host頁面若用其他訊號
    // 標示主題就用不到那個observer，改呼叫這個方法即可）。
    refreshTheme() {
        this._applyThemeStyles();
        this._renderMessageHistory();
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
        // tw_stock_db客製: 建議chip列（見refreshSuggestionChips()）跟歷史
        // 訊息按鈕/面板同樣是_initUI()組innerHTML時用當下palette寫死顏色，
        // 跟上面genDetailBox同一種問題——使用者實測回報這兩個元件切換主題
        // 後顏色沒跟著變，停留在視窗剛建立時的深色（因為視窗一開始mount時
        // data-theme還沒確定成light）。chip按鈕本身的顏色會在下次
        // refreshSuggestionChips()呼叫時自然修正，但容器背景跟歷史按鈕/
        // 面板沒有其他自動刷新的機會，這裡一併同步。
        const suggestionChips = document.getElementById('ai-suggestion-chips');
        if (suggestionChips) {
            suggestionChips.style.background = palette.chatBg;
            suggestionChips.style.borderTopColor = palette.windowBorder;
            suggestionChips.querySelectorAll('.ai-suggestion-chip').forEach(chip => {
                chip.style.borderColor = palette.inputBorder;
                chip.style.background = palette.detailBg;
                chip.style.color = palette.detailText;
            });
        }
        const historyBtn = document.getElementById('ai-history-btn');
        if (historyBtn) {
            historyBtn.style.borderColor = palette.inputBorder;
            historyBtn.style.background = palette.detailBg;
            historyBtn.style.color = palette.detailText;
        }
        const historyPanel = document.getElementById('ai-history-panel');
        if (historyPanel) {
            historyPanel.style.background = palette.windowBg;
            historyPanel.style.borderColor = palette.inputBorder;
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
        if (gen.stopSequenceDisabled) disabledKeys.push('stop');
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

    // tw_stock_db客製: 保險措施——不管base64圖片資料是怎麼跑進模型自己生成
    // 的文字裡的（例如較弱的模型在文字裡「模擬」了一個假的工具結果、複誦
    // 前面看到的東西、或其他非預期行為，都實際發生過），只要偵測到一段
    // 疑似data:image;base64,...的長字串（門檻200字元，正常文字不會這麼長
    // 一整段沒有空白/換行的亂碼），就換成一句提示文字，不讓它真的塞進
    // this.messages佔用/放大context——這是跟_reasoningDisplay/
    // _displayDataUrl同樣性質的防護，那兩個只保護「我們自己產生、知道
    // 結構」的圖片/推理資料，這裡多一層兜底，防的是「模型自己生成的文字
    // 裡意外混進去的」，來源不可控、沒辦法用結構化判斷排除，只能用樣式
    // 偵測。
    _stripInlineBase64(text) {
        if (!text) return text;
        return text.replace(/data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]{200,}/g, '[圖片資料已省略，不列入對話內容]');
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

        // tw_stock_db客製: 明確要求摘要列出「已經呼叫過哪些工具、取得了什麼
        // 結果」，而不是只籠統講「使用者想要X、助理做了Y」——實測發現太
        // 籠統的摘要會讓下一輪的模型分不清楚哪些步驟已經做過，傾向整個
        // 任務重新來一遍（重新呼叫同樣的工具），反而更快又把新context填滿、
        // 再次觸發壓縮，形成「一直撞到限制→重做」的迴圈（見下面重新接回
        // 使用者提問時的說明，兩處是同一個問題的兩面）。
        const summaryPrompt = `請將以下對話內容進行深度摘要與壓縮，字數限制在 300 個 Token 內。請保留：(1)使用者的原始意圖與具體需求 (2)已經呼叫過哪些工具、傳了什麼參數、取得了什麼關鍵結果（例如已經查到的股票代號、已經產生的圖表）(3)目前任務進行到哪個階段、還缺什麼才能給出最終答案。這份摘要會被當成「已完成的工作記錄」交給下一輪繼續，重點是讓下一輪不需要重新呼叫已經呼叫過的工具：\n\n${JSON.stringify(chatToCompress)}`;

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

            // tw_stock_db客製: 摘要本身是旁白式描述「之前發生了什麼」，不是
            // 一個可以直接回答的問題——實測發現如果就這樣結束，緊接著的續答
            // 請求收到的上下文只有這段敘述性摘要，模型很容易把摘要內容原文
            // 複誦/改寫一遍當成最終答案，而不是真的針對使用者原本的問題給
            // 結論。這裡把使用者最後一則真正的提問接在摘要後面，但**不能
            // 原樣裸接**——早期版本試過原樣接回去，結果模型把這當成一個
            // 全新的請求，把摘要裡已經記錄過的工具呼叫全部重做一遍（重新
            // search_stocks/get_intraday_series/render_stock_chart...），
            // 重做的結果又把新context填滿、立刻再次觸發這裡的壓縮，變成
            // 「一直撞到限制→重做→又撞到限制」的迴圈（實測遇到的真實案例）。
            // 這裡明確加一句「不要重複已完成的工具呼叫」的提示包住原始問題，
            // 讓模型把摘要當成「已完成的工作記錄」而不是「跟這件事無關、
            // 重新開始」。真正兜底防止迴圈失控的是下面_loopFetch/
            // _loopFetchNative對同一輪對話的壓縮次數上限（maxPruneRetriesPerTurn）。
            //
            // tw_stock_db客製: 固定用executeChat()一開始存下的
            // this._currentTurnUserText（這一輪對話「使用者真正打的原始
            // 文字」），不要從chatToCompress裡找「最後一則user訊息」——同一輪
            // 對話連續壓縮第二次以後，訊息陣列裡最後一則user訊息已經是上一次
            // 壓縮包裝過的版本，再包一層會巢狀疊加、每壓縮一次文字量倍增，
            // 反而更快撞到下一次上下文上限（實測案例：只問一句話卻疊出好幾層
            // 「[系統提示]我的原始問題：[系統提示]我的原始問題：...」）。找不到
            // this._currentTurnUserText時（理論上不會發生，防禦性寫法）才退回
            // 舊的掃描方式。
            const originalUserText = this._currentTurnUserText
                ?? [...chatToCompress].reverse().find(m => m.role === 'user')?.content;
            if (originalUserText) {
                this.messages.push({
                    role: 'user',
                    content: `[系統提示：以上摘要已經記錄了目前為止呼叫過的工具與取得的結果，請不要重複呼叫已經執行過的工具、也不要把這當成新任務重新開始，直接依照摘要中已有的資料繼續完成任務，缺什麼資料再呼叫對應的工具補齊，資料齊全就直接給出最終回答]\n\n我的原始問題：${originalUserText}`
                });
            }

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

    // tw_stock_db客製: 2026-08-23使用者要求「AI回應的markdown內容右下角有
    // 一個小按鈕可以匯出markdown/pptx/pdf」，且這個功能要內建在本檔案裡
    // （見檔案開頭說明第7點）。Markdown直接用既有的generateAndDeliverFile()；
    // PPTX/PDF預設呼叫下面內建的_faMarkdownToPptxBlob/_faMarkdownToPdfBlob
    // （任何AI的回覆習慣都是markdown，這是通用能力，不需要host頁面幫忙）。
    // options.onExportMarkdown仍保留為選用覆寫——host頁面如果想用自己的
    // 報告版型/投影片類型（例如tw_stock_db的ReportExport支援股票診斷卡片
    // 等專屬版面），提供這個callback就會優先使用；沒提供時一律用內建版本，
    // 不會像之前那樣停用按鈕。
    _appendMarkdownExportButton(container, markdownText, palette) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:absolute; bottom:4px; right:6px;';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = '匯出這則回覆';
        btn.textContent = '📤';
        btn.style.cssText = `border:none; background:transparent; cursor:pointer; font-size:13px; opacity:0.6; padding:2px 4px;`;
        btn.addEventListener('mouseenter', () => { btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', () => { btn.style.opacity = '0.6'; });
        wrap.appendChild(btn);

        const menu = document.createElement('div');
        menu.style.cssText = `display:none; position:absolute; bottom:100%; right:0; margin-bottom:4px; background:${palette.windowBg}; border:1px solid ${palette.inputBorder}; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,0.25); z-index:5; min-width:120px;`;
        const items = [
            { fmt: 'markdown', label: '📝 Markdown' },
            { fmt: 'pptx', label: '📊 PPTX' },
            { fmt: 'pdf', label: '📄 PDF' },
        ];
        menu.innerHTML = items.map((it) => `
            <div class="ai-export-item" data-fmt="${it.fmt}" style="padding:6px 12px; font-size:12px; cursor:pointer; color:${palette.detailText};">${it.label}</div>
        `).join('');
        wrap.appendChild(menu);
        container.appendChild(wrap);

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.ai-export-menu-open').forEach((m) => { if (m !== menu) m.style.display = 'none'; });
            menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
        });
        document.addEventListener('click', () => { menu.style.display = 'none'; });
        menu.querySelectorAll('.ai-export-item').forEach((item) => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.style.display = 'none';
                const fmt = item.dataset.fmt;
                const originalText = btn.textContent;
                btn.textContent = '⏳';
                try {
                    const heading = 'AI回覆';
                    if (fmt === 'markdown') {
                        const blob = new Blob([markdownText], { type: 'text/markdown;charset=utf-8' });
                        await this.generateAndDeliverFile(blob, `ai回覆_${Date.now()}.md`, 'text/markdown');
                    } else if (typeof this.options.onExportMarkdown === 'function') {
                        await this.options.onExportMarkdown(markdownText, fmt);
                    } else if (fmt === 'pptx') {
                        const blob = await _faMarkdownToPptxBlob(markdownText, heading);
                        await this.generateAndDeliverFile(blob, `ai回覆_${Date.now()}.pptx`, blob.type);
                    } else if (fmt === 'pdf') {
                        const blob = await _faMarkdownToPdfBlob(markdownText, heading);
                        await this.generateAndDeliverFile(blob, `ai回覆_${Date.now()}.pdf`, blob.type);
                    }
                } catch (err) {
                    this._log(`❌ 匯出失敗（${fmt}）：${err.message || err}`);
                } finally {
                    btn.textContent = originalText;
                }
            });
        });
    }

    // tw_stock_db客製: 斜線指令的公開註冊入口，跟register_openai_tool()同一種
    // 「外部程式碼可以自己掛新能力進來、不用改floating-assistant.js本體」的
    // 設計——2026-08-23使用者明確要求「stock相關的客製化行為（例如
    // /collect-volrank）不要變成floating-assistant.js的內建功能」，這個檔案
    // 定位是可重用的通用元件，tw_stock_db專案自己的斜線指令一律從
    // web/index.html呼叫這個方法掛進來（見registerAiCapabilities()旁邊的
    // 呼叫），本體只保留真正跟「這個聊天widget本身」有關的內建指令
    // （目前只有/benchmark-model——它評估的是LLM模型本身，不是tw_stock_db
    // 的業務邏輯，留在這裡合理）。cmd大小寫不敏感、必須以/開頭；handler
    // 拿到的是指令名稱之後、trim過的參數字串（跟原本/benchmark-model的
    // 呼叫慣例一致）。回傳this方便鏈式呼叫。
    register_slash_command(cmd, hint, desc, handler) {
        const key = String(cmd || '').trim().toLowerCase();
        if (!key.startsWith('/')) {
            console.warn('register_slash_command: cmd必須以/開頭，忽略：', cmd);
            return this;
        }
        this.slashCommands.set(key, { cmd: key, hint: hint || '', desc: desc || '', handler });
        return this;
    }

    // tw_stock_db客製: 從輸入框取字、清空、觸發executeChat的共用邏輯，被
    // Enter鍵送出跟「送出」按鈕共用，確保兩條路徑行為完全一致（見上面
    // bindEvents()裡兩處的呼叫端）。斜線指令刻意在這裡攔截、不進
    // executeChat/LLM——這些是本地端function call直接觸發的工具指令，
    // 不需要也不應該讓AI自己「決定」要不要執行；實際指令清單見
    // this.slashCommands（見register_slash_command()的註冊機制）。
    _submitChatInput(inputText, suggestBar) {
        const textToSend = inputText.value.trim();
        if (!textToSend) return;

        inputText.value = '';
        if (suggestBar) suggestBar.style.display = 'none';

        if (textToSend.startsWith('/')) {
            const firstToken = textToSend.split(/\s+/)[0].toLowerCase();
            const entry = this.slashCommands.get(firstToken);
            if (entry) {
                const argsText = textToSend.slice(firstToken.length).trim();
                entry.handler(argsText);
                return;
            }
        }

        if (this.isResponding) {
            this._setRespondingState(true, '⏳ AI 回應中（Steering 已加入）');
        }
        this.executeChat(textToSend);
    }

    // ============================================================
    // tw_stock_db客製: /benchmark-model 指令——見使用者要求記錄的評估準則
    // （簡易回應速度／單一工具呼叫／完整多步驟請求跑2次，各自評分、算
    // 加權總分），做成可以直接在對話框打指令觸發的本地function call，
    // 完全不經過LLM（不是AI工具，是聊天輸入框自己識別的指令，跟
    // [CALL:...]是兩回事）。用法：
    //   /benchmark-model <model> [<api base url>] [<api key>]
    // 後兩個參數選填，沒填就沿用目前設定面板裡的API URL/Key——這樣可以
    // 在不動使用者目前實際在用的模型設定的前提下，臨時測一個新模型（甚至
    // 測別的API端點），測完不影響原本的對話或設定。
    // ============================================================

    _benchmarkSpeedScore(ms, tiers) {
        for (const [maxMs, score] of tiers) {
            if (ms <= maxMs) return score;
        }
        return 0;
    }

    // 掃一輪測試自己獨立的本地messages陣列（不是this.messages，見
    // _benchmarkRunTurn的說明），抓正確性訊號：
    // - toolCount：真的執行過幾次工具
    // - hasProtocolConfusion：模型有沒有把系統提示裡的呼叫格式範例文字
    //   （例如"tool_name("、"ARGUMENTS_AS_JSON_OBJECT"）誤當成真實呼叫寫
    //   出來——這是實測抓到的真實失敗模式。
    // - hasEmptyFinal / finalText：最後一則assistant訊息是否為空、內容
    //   是什麼。
    _benchmarkAnalyzeMessages(msgs) {
        const toolCount = msgs.filter(m => m.role === 'tool').length;
        const hasProtocolConfusion = msgs.some(m => m.role === 'assistant' && typeof m.content === 'string' &&
            /tool_name\s*\(|ARGUMENTS_AS_JSON_OBJECT/i.test(m.content));
        const lastAssistant = [...msgs].reverse().find(m => m.role === 'assistant');
        const finalText = lastAssistant && typeof lastAssistant.content === 'string' ? lastAssistant.content : '';
        const hasEmptyFinal = !!lastAssistant && finalText.trim() === '';
        return { toolCount, hasProtocolConfusion, hasEmptyFinal, finalText };
    }

    // tw_stock_db客製: 跑一輪完全獨立的對話（自己的messages陣列，不是
    // this.messages），刻意不重用executeChat/_loopFetch/_loopFetchNative
    // ——那三個是為了「使用者看得到的即時串流對話視窗」設計的（stream:
    // true、邊收邊更新DOM、操作this.messages），基準測試要的是「跑完就好，
    // 不要動使用者真正的對話視窗、也不要被牽動UI狀態」，用非串流請求＋
    // 區域變數乾淨很多。跟_runSubAgentTask的精神一樣（那個也是獨立
    // messages陣列），差別是這裡允許呼叫端傳入自訂apiKey/apiUrl/apiModel
    // （測別的端點/模型時不能依賴this._getApiConfig()目前設定的值）。
    async _benchmarkRunTurn(apiKey, apiUrl, apiModel, useNative, prompt, maxRounds, timeoutMs, onProgress) {
        const t0 = Date.now();
        const report = (msg) => { if (onProgress) onProgress(msg); };
        const messages = [
            { role: 'system', content: this._getFinalSystemPrompt() },
            { role: 'user', content: prompt },
        ];
        let timedOut = false;
        // tw_stock_db客製: 使用者要求benchmark也要摸索「max_tokens調大會不會
        // 讓模型吐垃圾」——早期實測nemotron在temperature=0時容易卡進「同一段
        // 輸出不斷重複」的退化狀態（見_hasRepeatingTail的說明），真實對話走
        // 串流可以邊收邊偵測、提前截斷，但這裡是非串流(stream:false)，只能
        // 等一輪完整回來後事後檢查。hitLengthLimit記錄「有沒有任何一輪把
        // max_tokens整個用完」（finish_reason==='length'）——即使沒有出現
        // 字面重複，簡單問題卻用光完整輸出上限本身就是可疑訊號；
        // repetitionDetected記錄「有沒有偵測到真正的重複輸出退化」，兩者
        // 都會回傳給呼叫端，用來調整正確性評分、並在報告卡上明講。
        let hitLengthLimit = false;
        let repetitionDetected = false;
        // tw_stock_db客製: 使用者要求把「AI寫的報告有沒有遵守文字規範（數字
        // 不加引號、不能出現程式代號、不要整份都是text投影片）」也做成一個
        // benchmark項目——這裡直接在呼叫export_document的當下把它的
        // content_yaml參數截下來（不管走native tool_calls還是文字式[CALL:...]
        // 協定），比事後從messages裡用正則反推更準確，交給
        // _benchmarkAnalyzeDesignCompliance()評分（見該函式）。
        let exportedYaml = '';
        try {
            for (let round = 0; round < maxRounds; round++) {
                const remaining = timeoutMs - (Date.now() - t0);
                if (remaining <= 0) { timedOut = true; break; }
                report(`第${round + 1}輪：送出請求…（已耗時${Math.round((Date.now() - t0) / 1000)}秒）`);

                const body = {
                    model: apiModel,
                    messages,
                    temperature: 0,
                    ...this._buildSamplingParamsBody(),
                    max_tokens: this._getGenerationSettings().maxOutputTokens,
                    // tw_stock_db客製: 只有原生tool_calls走非串流——真實app的
                    // _loopFetchNative本來就是stream:false（tool_calls的增量
                    // JSON片段跨chunk組裝很麻煩，真實app都沒做，這裡跟著真實
                    // 行為一致，不用另外發明一套benchmark專屬的複雜度）。文字式
                    // [CALL:...]慣例則跟真實app的_loopFetch一樣走stream:true，
                    // 這樣才能重用同一套「邊收邊偵測重複輸出、一偵測到就提前
                    // 中斷連線」的機制（見下面的說明），不用整輪max_tokens吐完
                    // 垃圾才知道——這正是使用者要benchmark去「摸索max_tokens
                    // 調大會不會讓模型吐垃圾」的關鍵：提前中斷才量得出「這個
                    // 模型/端點在這個max_tokens下到底安不安全」，而不是浪費
                    // 時間等它吐完整段垃圾。
                    stream: !useNative,
                };
                if (useNative) {
                    body.tools = this._buildNativeToolsSchema();
                    body.tool_choice = 'auto';
                } else {
                    Object.assign(body, this._buildStopParamBody());
                }

                const controller = this._createAbortController();
                const timeoutId = setTimeout(() => controller.abort(), Math.max(5000, remaining));
                let response;
                try {
                    response = await fetch(`${apiUrl}/chat/completions`, {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                        signal: controller.signal,
                        body: JSON.stringify(body),
                    });
                } catch (err) {
                    clearTimeout(timeoutId);
                    messages.push({ role: 'assistant', content: `[網路錯誤] ${String(err.message || err)}` });
                    break;
                }

                if (!response.ok) {
                    clearTimeout(timeoutId);
                    const errText = await response.text().catch(() => '');
                    if (!useNative && this._isStopParamRejected(errText) && this._disableStopParam(errText)) {
                        round--;
                        continue;
                    }
                    messages.push({ role: 'assistant', content: `[HTTP ${response.status}] ${errText.slice(0, 200)}` });
                    break;
                }

                let rawContent = '';
                let toolCalls = [];
                let roundFinishReason = null;

                if (useNative) {
                    clearTimeout(timeoutId);
                    const data = await response.json();
                    const choice = data.choices && data.choices[0];
                    const message = choice && choice.message;
                    if (!message) { messages.push({ role: 'assistant', content: '[回應格式異常]' }); break; }
                    roundFinishReason = choice.finish_reason;
                    rawContent = message.content || '';
                    toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
                } else {
                    // 跟_loopFetch同一套串流解析＋邊收邊偵測重複輸出退化的邏輯
                    // （見_hasRepeatingTail），差別只是這裡沒有即時DOM顯示。
                    try {
                        const reader = response.body.getReader();
                        const decoder = new TextDecoder('utf-8');
                        let buffer = '';
                        streamLoop: while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split('\n');
                            buffer = lines.pop();
                            for (const line of lines) {
                                const cleaned = line.trim();
                                if (!cleaned || cleaned === 'data: [DONE]') continue;
                                if (!cleaned.startsWith('data: ')) continue;
                                try {
                                    const parsed = JSON.parse(cleaned.slice(6));
                                    const delta = parsed.choices[0]?.delta || {};
                                    if (parsed.choices[0]?.finish_reason) roundFinishReason = parsed.choices[0].finish_reason;
                                    rawContent += delta.content || '';
                                } catch (_) {}
                            }
                            if (this._hasRepeatingTail(rawContent)) {
                                repetitionDetected = true;
                                rawContent = this._dedupeRepeatingTail(rawContent);
                                controller.abort();
                                break streamLoop;
                            }
                        }
                    } finally {
                        clearTimeout(timeoutId);
                    }
                }

                if (roundFinishReason === 'length') hitLengthLimit = true;
                if (!repetitionDetected && this._hasRepeatingTail(rawContent)) {
                    repetitionDetected = true;
                    rawContent = this._dedupeRepeatingTail(rawContent);
                }

                if (useNative && toolCalls.length) {
                    messages.push(Object.assign({ role: 'assistant', content: this._stripInlineBase64(rawContent) }, { tool_calls: toolCalls }));
                    report(`第${round + 1}輪：呼叫 ${toolCalls.map(tc => tc.function && tc.function.name).join('、')}…`);
                    for (const tc of toolCalls) {
                        const fnName = tc.function && tc.function.name;
                        const rawArgs = (tc.function && tc.function.arguments) || '{}';
                        if (fnName === 'export_document') {
                            try { exportedYaml += (JSON.parse(rawArgs).content_yaml || '') + '\n\n'; } catch (_) {}
                        }
                        try {
                            const toolDef = this._getToolDefinition(fnName);
                            if (!toolDef) throw new Error(`找不到工具: ${fnName}`);
                            const result = await Promise.resolve(toolDef.callback(rawArgs));
                            messages.push(this._buildToolResultMessage(fnName, result, { tool_call_id: tc.id }));
                        } catch (err) {
                            messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: String(err.message || err) }) });
                        }
                    }
                    continue;
                }

                // 文字式[CALL:...]慣例，跟_loopFetch的救援路徑同一套邏輯（見
                // _extractBalancedCallArgs的說明）。
                const regex = /\[CALL:\s*([a-zA-Z0-9_]+)\(([\s\S]*?)\)(?=\]|$)/g;
                let match; const toolTasks = []; let lastMatchEnd = -1;
                while ((match = regex.exec(rawContent)) !== null) {
                    toolTasks.push({ fnName: match[1], fnArgsRaw: match[2].trim() });
                    lastMatchEnd = match.index + match[0].length;
                }
                let truncated = rawContent;
                if (lastMatchEnd > -1) {
                    let end = lastMatchEnd;
                    if (rawContent[end] === ']') end += 1;
                    truncated = rawContent.slice(0, end);
                } else {
                    const callStart = rawContent.indexOf('[CALL:');
                    if (callStart > -1) {
                        const nameMatch = rawContent.slice(callStart).match(/^\[CALL:\s*([a-zA-Z0-9_]+)\s*\(/);
                        if (nameMatch) {
                            const openParenIdx = callStart + nameMatch[0].length - 1;
                            const { content, endIndex } = this._extractBalancedCallArgs(rawContent, openParenIdx);
                            toolTasks.push({ fnName: nameMatch[1], fnArgsRaw: content.trim() });
                            let end = endIndex;
                            if (rawContent[end] === ']') end += 1;
                            truncated = rawContent.slice(0, end);
                        }
                    }
                }
                messages.push({ role: 'assistant', content: this._stripInlineBase64(truncated) });
                if (!toolTasks.length) { report(`第${round + 1}輪：已取得最終回覆`); break; } // 純文字回答，這一輪結束，視為對話完成

                report(`第${round + 1}輪：呼叫 ${toolTasks.map(t => t.fnName).join('、')}…`);
                for (const task of toolTasks) {
                    try {
                        const toolDef = this._getToolDefinition(task.fnName);
                        if (!toolDef) throw new Error(`找不到工具: ${task.fnName}`);
                        const parsedArgs = await this.repairJsonPayload(task.fnArgsRaw);
                        if (task.fnName === 'export_document' && parsedArgs && typeof parsedArgs === 'object') {
                            exportedYaml += (parsedArgs.content_yaml || '') + '\n\n';
                        }
                        const result = await Promise.resolve(toolDef.callback(JSON.stringify(parsedArgs)));
                        messages.push(this._buildToolResultMessage(task.fnName, result));
                    } catch (err) {
                        messages.push({ role: 'user', content: `[系統提示] 工具 "${task.fnName}" 執行失敗: ${err.message}。` });
                    }
                }
            }
        } catch (err) {
            messages.push({ role: 'assistant', content: `[錯誤] ${String(err.message || err)}` });
        }
        return { messages, elapsedMs: Date.now() - t0, timedOut, hitLengthLimit, repetitionDetected, exportedYaml };
    }

    // tw_stock_db客製: 檢查AI寫的content_yaml（如果有呼叫export_document的話）
    // 跟口頭回覆有沒有遵守AI_REPORT_STYLE_GUIDE/export_document description
    // 裡的兩條硬性文字規範，加上「是不是整份都是text投影片」的排版判斷——
    // 三種都是實測真的發生過的瑕疵（見那兩處description的說明），量化成
    // 一個違規計數，給_benchmarkTest3Attempt拿去扣分、也讓報告卡列出具體
    // 是哪裡不合規，不是只給一個模糊的分數。
    _benchmarkAnalyzeDesignCompliance(exportedYaml, finalText) {
        const corpus = `${exportedYaml}\n${finalText}`;
        const quotedNumberMatches = corpus.match(/['"]\d[\d,.]*['"]/g) || [];
        const enumCandidates = corpus.match(/\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g) || [];
        const enumWhitelist = new Set(['CALL', 'TODO', 'JSON', 'YAML', 'HTML', 'PDF', 'PPTX', 'API', 'URL', 'OK', 'ID']);
        const rawEnumCodes = [...new Set(enumCandidates.filter(s => !enumWhitelist.has(s)))];
        const slideTypeMatches = exportedYaml.match(/^\s*-?\s*type:\s*(\w+)/gm) || [];
        const totalSlides = slideTypeMatches.length;
        const textTypeCount = slideTypeMatches.filter(s => /type:\s*text\b/.test(s)).length;
        const isWallOfText = totalSlides >= 3 && textTypeCount === totalSlides;
        const violationCount = (quotedNumberMatches.length > 0 ? 1 : 0) + (rawEnumCodes.length > 0 ? 1 : 0) + (isWallOfText ? 1 : 0);
        return {
            hasExport: exportedYaml.trim().length > 0,
            quotedNumberCount: quotedNumberMatches.length,
            rawEnumCodeSamples: rawEnumCodes.slice(0, 3),
            totalSlides, textTypeCount, isWallOfText,
            violationCount,
        };
    }

    async _benchmarkTest1(apiKey, apiUrl, apiModel, useNative, onProgress) {
        const { messages, elapsedMs, timedOut, hitLengthLimit, repetitionDetected } = await this._benchmarkRunTurn(
            apiKey, apiUrl, apiModel, useNative, '請直接回覆兩個字：測試', 3, 60000, onProgress);
        const { hasEmptyFinal, finalText } = this._benchmarkAnalyzeMessages(messages);
        // tw_stock_db客製: 這題只需要兩個字，正常模型用不到幾十個token就能
        // 答完——如果這一輪用光了完整的max_tokens上限，或偵測到重複輸出
        // 退化（見_hasRepeatingTail），代表這個模型/端點在目前的max_tokens
        // 設定下不安全，直接判不合格，不管答案本身對不對。
        const correct = !timedOut && !hasEmptyFinal && finalText.includes('測試') && !hitLengthLimit && !repetitionDetected;
        const speedScore = timedOut ? 0 : this._benchmarkSpeedScore(elapsedMs, [[10000, 100], [20000, 85], [40000, 60], [60000, 30], [Infinity, 0]]);
        return { name: '①簡易回應速度', timedOut, elapsedMs, correct, hitLengthLimit, repetitionDetected, score: correct ? speedScore : 0 };
    }

    async _benchmarkTest2(apiKey, apiUrl, apiModel, useNative, onProgress) {
        const { messages, elapsedMs, timedOut, hitLengthLimit, repetitionDetected } = await this._benchmarkRunTurn(
            apiKey, apiUrl, apiModel, useNative, '幫我查一下2330現在的價格跟簡短技術面判斷，一兩句話就好', 6, 90000, onProgress);
        const { toolCount, hasProtocolConfusion, hasEmptyFinal, finalText } = this._benchmarkAnalyzeMessages(messages);
        if (timedOut) return { name: '②單一工具呼叫', timedOut, elapsedMs, toolCount, hasProtocolConfusion, hasEmptyFinal, hitLengthLimit, repetitionDetected, score: 0 };
        // tw_stock_db客製: repetitionDetected直接把正確性歸零——輸出內容本身
        // 已經退化成垃圾，其餘檢查項目（有沒有真的呼叫工具等）就算通過也沒
        // 意義。hitLengthLimit扣分但不歸零（一句技術面判斷偶爾用完額度不算
        // 太離譜，只是效率差，見③測項更寬鬆的門檻）。
        let correctness = 0;
        if (!repetitionDetected) {
            if (toolCount >= 1) correctness += 40;
            if (!hasEmptyFinal && finalText.length > 10) correctness += 40;
            if (!hasProtocolConfusion) correctness += 20;
            if (hitLengthLimit) correctness = Math.max(0, correctness - 20);
        }
        const speedScore = this._benchmarkSpeedScore(elapsedMs, [[15000, 100], [30000, 85], [60000, 60], [90000, 30], [Infinity, 0]]);
        const score = Math.round(correctness * 0.7 + speedScore * 0.3);
        return { name: '②單一工具呼叫', timedOut, elapsedMs, toolCount, hasProtocolConfusion, hasEmptyFinal, hitLengthLimit, repetitionDetected, correctness, speedScore, score };
    }

    // 完整多步驟請求單次嘗試——呼叫端負責跑兩次取平均（見runModelBenchmarkCommand）。
    // exportedFileSizeBytes由呼叫端透過暫時attach的_benchmarkCapturedExport
    // 傳進來（見generateAndDeliverFile的monkey-patch說明），不用掃訊息內容
    // 猜測，直接讀真正的匯出結果最可靠。
    async _benchmarkTest3Attempt(apiKey, apiUrl, apiModel, useNative, onProgress) {
        this._benchmarkCapturedExport = null;
        const { messages, elapsedMs, timedOut, hitLengthLimit, repetitionDetected, exportedYaml } = await this._benchmarkRunTurn(
            apiKey, apiUrl, apiModel, useNative, '幫2330做一個完整持股分析，產生pptx，也要口頭報告給我', 10, 240000, onProgress);
        const { toolCount, hasProtocolConfusion, hasEmptyFinal, finalText } = this._benchmarkAnalyzeMessages(messages);
        const exportedFile = this._benchmarkCapturedExport;
        const designCompliance = this._benchmarkAnalyzeDesignCompliance(exportedYaml, finalText);
        if (timedOut) return { timedOut, elapsedMs, toolCount, hasProtocolConfusion, hasEmptyFinal, hitLengthLimit, repetitionDetected, exportedFile, designCompliance, score: 0 };
        let correctness = 0;
        if (!repetitionDetected) {
            // 檔案是不是真的產生（不是模型自己宣稱「已產生檔案」卻沒真的呼叫
            // export_document）——20000 bytes是保守的「非空殼」門檻。
            if (exportedFile && exportedFile.sizeBytes > 20000) correctness += 50;
            if (!hasEmptyFinal && finalText.length > 200) correctness += 30;
            if (!hasProtocolConfusion) correctness += 20;
            // 完整報告本來就可能用不少token，單純用完額度不算太意外，扣分
            // 比②單一工具呼叫寬鬆一些。
            if (hitLengthLimit) correctness = Math.max(0, correctness - 10);
            // tw_stock_db客製: 報告寫作規範違規（數字加引號/程式代號外露/整份
            // 都是text投影片）——每種違規扣8分、最多扣24分，比檔案有沒有真的
            // 產生這種硬性條件寬鬆，避免文字規範沒完全遵守就整個歸零。
            if (designCompliance.hasExport) correctness = Math.max(0, correctness - designCompliance.violationCount * 8);
        }
        const speedScore = this._benchmarkSpeedScore(elapsedMs, [[60000, 100], [120000, 80], [180000, 60], [240000, 30], [Infinity, 0]]);
        const score = Math.round(correctness * 0.8 + speedScore * 0.2);
        return { timedOut, elapsedMs, toolCount, hasProtocolConfusion, hasEmptyFinal, hitLengthLimit, repetitionDetected, exportedFile, designCompliance, correctness, speedScore, score };
    }

    // 主入口：解析/benchmark-model的參數、依序跑三項測試、算加權總分、
    // 把報告卡直接插進聊天視窗DOM（不進this.messages，不會被送進之後的
    // API request、也不會被存進對話歷史——這是本地指令的輸出，不是對話
    // 內容）。export_document會呼叫的generateAndDeliverFile在測試期間
    // 暫時被換成一個只記錄結果、不真的推訊息/存檔案到使用者真實對話的
    // 版本，測完準確還原，確保跑基準測試不會弄髒使用者真正的聊天記錄
    // 跟檔案快取。
    async _handleBenchmarkModelCommand(argsText) {
        const parts = argsText.trim().split(/\s+/).filter(Boolean);
        const model = parts[0];
        const chatBody = document.getElementById('ai-chat-body');
        if (!model) {
            if (chatBody) chatBody.insertAdjacentHTML('beforeend',
                `<div style="margin:8px 0; padding:8px 10px; border:1px solid #dd6b20; border-radius:6px; font-size:12px; color:#dd6b20;">用法：/benchmark-model &lt;model&gt; [&lt;api base url&gt;] [&lt;api key&gt;]</div>`);
            return;
        }
        const base = this._getApiConfig();
        const apiUrl = parts[1] || base.apiUrl;
        const apiKey = parts[2] || base.apiKey;

        const originalGenerateAndDeliverFile = this.generateAndDeliverFile;
        this.generateAndDeliverFile = async (blob) => {
            this._benchmarkCapturedExport = { sizeBytes: blob.size };
            return { id: 'benchmark-temp', filename: 'benchmark-temp' };
        };

        const progressId = `bench-progress-${Date.now()}`;
        if (chatBody) {
            chatBody.insertAdjacentHTML('beforeend', `<div id="${progressId}" style="margin:8px 0; padding:8px 10px; border:1px solid ${this._getThemePalette().windowBorder}; border-radius:6px; font-size:12px;">🧪 正在對 <b>${this._escapeHtml(model)}</b> 執行基準測試…</div>`);
        }
        const progressEl = document.getElementById(progressId);
        const setProgress = (msg) => { this._log(msg); if (progressEl) progressEl.innerHTML = `🧪 <b>${this._escapeHtml(model)}</b>：${this._escapeHtml(msg)}`; };
        // tw_stock_db客製: 使用者反映完整多步驟請求那幾項一等就是1-2分鐘，
        // 中途只看到一句沒變過的「測試中」文字，感覺像卡住——把
        // _benchmarkRunTurn每一輪實際在做什麼（送出請求／呼叫哪個工具／
        // 拿到最終回覆）即時印出來，讓使用者看得到「還在動」，不是真的卡死。
        const subProgress = (label) => (detail) => setProgress(`${label}：${detail}`);

        let report;
        try {
            const useNative = await this._ensureNativeToolSupportProbed(apiKey, apiUrl, model);
            setProgress('①測試簡易回應速度…');
            const test1 = await this._benchmarkTest1(apiKey, apiUrl, model, useNative, subProgress('①'));
            setProgress(`①完成：${test1.score}分`);

            setProgress('②測試單一工具呼叫…');
            const test2 = await this._benchmarkTest2(apiKey, apiUrl, model, useNative, subProgress('②'));
            setProgress(`②完成：${test2.score}分`);

            setProgress('③-1測試完整多步驟請求（第1次）…');
            const attempt1 = await this._benchmarkTest3Attempt(apiKey, apiUrl, model, useNative, subProgress('③-1'));
            setProgress(`③-1完成：${attempt1.score}分`);

            setProgress('③-2測試完整多步驟請求（第2次）…');
            const attempt2 = await this._benchmarkTest3Attempt(apiKey, apiUrl, model, useNative, subProgress('③-2'));
            setProgress(`③-2完成：${attempt2.score}分`);

            const test3avg = Math.round((attempt1.score + attempt2.score) / 2);
            const overallScore = Math.round(test1.score * 0.15 + test2.score * 0.30 + test3avg * 0.55);
            const verdict = overallScore >= 80 ? '✅ 建議加入'
                : overallScore >= 50 ? '⚠️ 可用但不穩定，建議人工複核'
                : '❌ 不建議加入';
            report = { model, apiUrl, useNative, test1, test2, attempt1, attempt2, test3avg, overallScore, verdict };
        } catch (err) {
            report = { model, apiUrl, error: String(err.message || err) };
        } finally {
            this.generateAndDeliverFile = originalGenerateAndDeliverFile;
            this._benchmarkCapturedExport = null;
            this._log('✅ 已完成');
        }

        if (progressEl) progressEl.remove();
        // tw_stock_db客製: 使用者反映報告卡在切換主題時會消失——原因是它
        // 原本用insertAdjacentHTML直接插進chatBody，完全不在this.messages
        // 裡；切換主題／收到新訊息都會呼叫_renderMessageHistory()整個清空
        // chatBody重繪（見那個函式的說明），純DOM插入的東西自然就被清掉了。
        // 改成比照generateAndDeliverFile()的_downloadFile做法：把報告存成
        // this.messages裡一則真正的訊息（content是精簡摘要，安全給未來的
        // API request重播；完整報告物件存在非可枚舉的_benchmarkReport屬性，
        // 只用來畫面渲染，見_renderSingleMessage），這樣就會跟著正常的
        // 訊息陣列存活過重繪，也順便可以被匯出/持久化。
        const summary = report.error
            ? `🧪 ${report.model} 基準測試失敗：${report.error}`
            : `🧪 ${report.model} 基準測試完成，總分 ${report.overallScore}/100（${report.verdict}）`;
        const msg = { role: 'assistant', content: summary };
        Object.defineProperty(msg, '_benchmarkReport', { value: report, enumerable: false, configurable: true });
        this.messages.push(msg);
        this._persistChatHistory();
        this._renderMessageHistory();
        if (!report.error) this._saveModelCard(report);
    }

    // tw_stock_db客製: 見this.MODEL_CARDS_KEY的說明——每次/benchmark-model
    // 跑完（不管結果好壞）都存一張卡，同一個模型重測會覆蓋舊卡（只保留
    // 最新一次結果，避免歷史結果互相矛盾）。
    _getModelCards() {
        try { return JSON.parse(localStorage.getItem(this.MODEL_CARDS_KEY) || '{}'); }
        catch (_) { return {}; }
    }

    _saveModelCard(report) {
        const cards = this._getModelCards();
        cards[report.model] = {
            model: report.model,
            apiUrl: report.apiUrl,
            useNative: report.useNative,
            overallScore: report.overallScore,
            verdict: report.verdict,
            test1Score: report.test1 && report.test1.score,
            test2Score: report.test2 && report.test2.score,
            test3avgScore: report.test3avg,
            testedAt: new Date().toISOString(),
        };
        try { localStorage.setItem(this.MODEL_CARDS_KEY, JSON.stringify(cards)); } catch (_) {}
    }

    // 給MODEL NAME輸入框的<datalist>用：PRESET_MODEL_OPTIONS(內建三個)
    // ∪ 所有測過的模型（即使沒有正式收進PRESET_MODEL_OPTIONS），有卡片的
    // 附上分數/結論當option文字（多數瀏覽器的datalist會把它當提示顯示在
    // value旁邊）。
    _modelDatalistOptionsHtml() {
        const cards = this._getModelCards();
        const names = [...new Set([...PRESET_MODEL_OPTIONS, ...Object.keys(cards)])];
        return names.map(m => {
            const c = cards[m];
            if (!c) return `<option value="${this._escapeAttr(m)}"></option>`;
            const badge = c.verdict.startsWith('✅') ? '✅' : c.verdict.startsWith('⚠️') ? '⚠️' : '❌';
            const dateStr = c.testedAt ? c.testedAt.slice(0, 10) : '';
            return `<option value="${this._escapeAttr(m)}">${badge} ${c.overallScore}/100（${dateStr}）</option>`;
        }).join('');
    }

    _renderBenchmarkReportHtml(r) {
        const palette = this._getThemePalette();
        if (r.error) {
            return `<div style="margin:8px 0; padding:10px 12px; border:1px solid #e53e3e; border-radius:8px; font-size:12px; color:#e53e3e;">🧪 <b>${this._escapeHtml(r.model)}</b> 基準測試失敗：${this._escapeHtml(r.error)}</div>`;
        }
        const flagNote = (t) => {
            const flags = [];
            if (t.repetitionDetected) flags.push('⚠️偵測到重複輸出退化');
            if (t.hitLengthLimit) flags.push('⚠️用完max_tokens上限');
            const dc = t.designCompliance;
            if (dc && dc.hasExport) {
                if (dc.quotedNumberCount > 0) flags.push(`⚠️數字被加引號×${dc.quotedNumberCount}`);
                if (dc.rawEnumCodeSamples.length) flags.push(`⚠️出現程式代號（如${this._escapeHtml(dc.rawEnumCodeSamples[0])}）`);
                if (dc.isWallOfText) flags.push(`⚠️整份都是text投影片（${dc.totalSlides}張）`);
            }
            return flags.length ? `<div style="color:#dd6b20; font-size:10px;">${flags.join('　')}</div>` : '';
        };
        const row = (label, t) => `<tr><td style="padding:3px 8px 3px 0; white-space:nowrap; vertical-align:top;">${label}</td><td style="padding:3px 8px; vertical-align:top;">${t.score}分</td><td style="padding:3px 8px; color:${palette.detailText}; vertical-align:top;">${(t.elapsedMs / 1000).toFixed(1)}秒${t.timedOut ? '（逾時）' : ''}${flagNote(t)}</td></tr>`;
        // tw_stock_db客製: 使用者要求benchmark順便摸索「max_tokens調大會不會
        // 讓模型吐垃圾」——只要四項測試裡任何一項偵測到重複輸出退化，就在
        // 報告卡最上面用明顯的警語提醒，不要讓使用者得自己逐行找表格裡的
        // 小字才會發現。
        const anyRepetition = [r.test1, r.test2, r.attempt1, r.attempt2].some(t => t && t.repetitionDetected);
        const repetitionBanner = anyRepetition
            ? `<div style="margin-bottom:6px; padding:6px 8px; background:#fed7aa; color:#7c2d12; border-radius:4px; font-size:11px;">⚠️ 這個模型在目前的max_tokens設定下，至少一次測試出現輸出重複退化的現象——不建議用大的max_tokens，或這個端點/模型本身不適合。</div>`
            : '';
        return `<div style="margin:8px 0; padding:10px 12px; border:1px solid ${palette.windowBorder}; border-radius:8px; font-size:12px;">
            <div style="font-weight:bold; margin-bottom:6px;">🧪 模型基準測試報告 — ${this._escapeHtml(r.model)}</div>
            <div style="font-size:11px; color:${palette.detailText}; margin-bottom:6px;">端點：${this._escapeHtml(r.apiUrl)}　協定：${r.useNative ? '原生tool_calls' : '文字式[CALL:...]'}　max_tokens：${this._getGenerationSettings().maxOutputTokens}</div>
            ${repetitionBanner}
            <table style="border-collapse:collapse; font-size:12px;">
                ${row('①簡易回應速度', r.test1)}
                ${row('②單一工具呼叫', r.test2)}
                ${row('③-1完整多步驟請求', r.attempt1)}
                ${row('③-2完整多步驟請求', r.attempt2)}
            </table>
            <div style="margin-top:8px; font-size:13px;">總分：<b>${r.overallScore}</b>／100　${r.verdict}</div>
        </div>`;
    }

    /**
     * 執行 Stream 對話循環
     */
    async executeChat(userText) {
        const { apiKey, apiUrl } = this._getApiConfig();
        let apiModel = this._getApiConfig().apiModel;
        if (this.isResponding) {
            this._addSteeringMessage(userText);
            return;
        }

        // tw_stock_db客製: MODEL NAME留空時的自動fallback——見PRESET_MODEL_OPTIONS
        // 上方各模型的實測風險註記。每次使用者主動送出新訊息（這裡，不是
        // 對話中途的重試）都重新從PRESET_MODEL_OPTIONS[0]開始，不接續上一輪
        // fallback到的模型——呼應使用者「不要因為找到一個成功的就固定住」
        // 的要求：主力模型如果只是暫時404、後來恢復了，下一則新訊息會自動
        // 先試回主力模型。_loopFetch/_loopFetchNative遇到404時會依
        // this._autoFallbackIndex往下試下一個（見那兩處的說明），只有MODEL
        // NAME真的留空時才啟動，使用者自己指定了模型就完全不受影響。
        this._autoFallbackActive = this._isModelFieldBlank();
        if (this._autoFallbackActive) {
            this._autoFallbackIndex = 0;
            apiModel = PRESET_MODEL_OPTIONS[0];
        }
        this._updateHeaderModelName(apiModel, this._autoFallbackActive);

        // tw_stock_db客製: toolCallMode==='auto'時，先確保這個apiUrl+apiModel
        // 組合已經探測過是否支援原生tool_calls（見_ensureNativeToolSupportProbed
        // 的說明）——只有第一次真的會打一次探測請求，之後都是讀快取，不會
        // 每輪對話都多一次網路往返。'native'/'text'手動模式不需要探測，
        // 直接跳過。
        if ((this.advancedSettings.toolCallMode || 'auto') === 'auto') {
            await this._ensureNativeToolSupportProbed(apiKey, apiUrl, apiModel);
        }

        // tw_stock_db客製: 每次真正開始新一輪對話才歸零，見_turnPruneCount
        // 在建構子裡的說明——這樣同一輪對話裡不管中間穿插幾次成功的工具
        // 呼叫，壓縮次數上限都不會被誤重設。
        this._turnPruneCount = 0;

        // tw_stock_db客製: 記住「這一輪對話使用者真正打的原始文字」，給
        // pruneContext()重新接回問題時用（見該函式內的說明）。不能讓
        // pruneContext自己從this.messages裡找「最後一則user訊息」來代替——
        // 同一輪對話裡如果連續壓縮兩次以上，第一次壓縮後push進去的user訊息
        // 已經是包了「[系統提示：...] 我的原始問題：xxx」這層包裝的訊息，
        // 第二次壓縮再去找「最後一則user」會抓到這則包裝過的訊息，把它當成
        // 「原始問題」再包一層，變成「[系統提示]我的原始問題：[系統提示]
        // 我的原始問題：xxx」，每壓縮一次疊一層、文字量疊加成長，反而
        // 加速撞到下一次的上下文上限（實測遇到的真實案例：使用者只問一句
        // 「大成鋼適合進場嗎」，畫面上卻疊出好幾層巢狀的系統提示文字）。
        // 固定用這裡存的原始文字，不管壓縮幾次，重新接回去的內容永遠只有
        // 一層包裝。
        this._currentTurnUserText = userText;

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
        // tw_stock_db客製: 只有使用者原本就在（接近）畫面底部時，才在新增
        // 這則streamDiv後自動捲到底——如果使用者正往上拉看歷史訊息，不該
        // 因為AI開始回覆就被強制拉回底部。見_isNearBottom()的說明。
        const wasNearBottomBeforeStream = this._isNearBottom(chatBody);
        chatBody.appendChild(streamDiv);
        if (wasNearBottomBeforeStream) chatBody.scrollTop = chatBody.scrollHeight;

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
                        // tw_stock_db客製: 見CALL_STOP_SEQUENCE說明——這裡一定是文字式
                        // [CALL:...]協定（函式最上面已經把原生tool_calls模型導去
                        // _loopFetchNative了），讓端點在模型正確收尾的當下就直接
                        // 截斷生成，不用等模型自己繼續往下編一段假的[TOOL RESULT]。
                        ...this._buildStopParamBody(),
                        max_tokens: this._getGenerationSettings().maxOutputTokens,
                        stream: true
                    })
                });

                if (!response.ok) {
                    // tw_stock_db客製: MODEL NAME留空時的自動fallback——見
                    // executeChat()裡this._autoFallbackActive的說明。只處理404
                    // （模型/端點暫時下線），不處理其他4xx/5xx（那些通常是請求
                    // 本身有問題，換模型也不會解決，交給下面既有的邏輯處理）。
                    const nextFallbackModel = this._nextAutoFallbackModel(response.status, apiModel);
                    if (nextFallbackModel) {
                        this._log(`⚠️ 模型 ${apiModel} 目前無法使用(HTTP ${response.status})，自動改用下一個候選模型：${nextFallbackModel}`);
                        streamDiv.remove();
                        this._updateHeaderModelName(nextFallbackModel, true);
                        return await this._loopFetch(apiKey, apiUrl, nextFallbackModel, retryAttempt);
                    }
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
                    if (this._isStopParamRejected(errText) && this._disableStopParam(errText)) {
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
                        // tw_stock_db客製: 見_turnPruneCount在建構子裡的說明——
                        // retryAttempt在每次工具呼叫成功後都會被重設回1，沒辦法
                        // 真正擋住「壓縮→模型把任務整個重做一遍→又填滿context→
                        // 再壓縮」這種迴圈，這裡用不受工具呼叫成功影響的獨立
                        // 計數器擋住，超過就明確放棄並告知使用者原因，而不是
                        // 無聲一直重試下去。
                        if (this._turnPruneCount >= this.maxPruneRetriesPerTurn) {
                            // tw_stock_db客製: 附上最後一次的原始errText（不再只講
                            // 「可能是資料量太大」這種猜測）——這個上限原本是為了
                            // 擋「壓縮沒有真正解決400/413成因」的無窮迴圈設計的，
                            // 但過去這裡的訊息完全沒有透露「成因」到底是什麼，
                            // 使用者沒辦法判斷這次觸發的原因跟上次是不是同一個
                            // （例如同一個schema驗證錯誤又發生了、還是真的換了個
                            // 新原因），把原始錯誤內容印出來才能真正協助排查。
                            this._log(`❌ 這一輪對話已經反覆壓縮 ${this.maxPruneRetriesPerTurn} 次仍超過上下文限制。已停止繼續嘗試，建議縮小範圍再問一次，或換一個上下文較大的模型。最後一次的原始錯誤：HTTP ${response.status} ${errText.slice(0, 300)}`);
                            return "";
                        }
                        this._turnPruneCount++;
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
                                // tw_stock_db客製: 同上，每個chunk進來前先檢查
                                // 使用者「當下」是不是還在底部附近，不是只看
                                // 串流剛開始那一刻——使用者隨時可能在串流過程
                                // 中自己往上拉走，這裡要能即時偵測到並停止
                                // 繼續自動捲動。
                                const wasNearBottomChunk = this._isNearBottom(chatBody);
                                textSpan.innerText = fullContent || (reasoningContent ? '🧠 思考中…' : '');
                                if (wasNearBottomChunk) chatBody.scrollTop = chatBody.scrollHeight;
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
                fullContent += '\n\n---\n⚠️ **已自動請AI接續多次仍未寫完，這裡先停下來（可能內容真的很長，或端點異常）。** 可以直接追問「請繼續」。';
            }

            // tw_stock_db客製: reasoningContent只存進非可枚舉的_reasoningDisplay
            // 屬性，不接進msg.content——早期版本是接成<think>標籤直接混進
            // content，這樣雖然「🧠 思考過程」摺疊區塊看得到，但content同時是
            // 真正送進API的欄位，等於是把模型自己的內部推理草稿（實測動輒
            // 6000~8000字，遠大於工具結果本身）永久疊進對話歷史，下一輪
            // 對話又整段送回去，是造成「一直撞到context limit、又觸發壓縮」
            // 的主因之一（推理愈長，context長得愈快，形成惡性循環）。跟圖片
            // 用_displayDataUrl把「畫面顯示」跟「送進API的內容」分開是同一個
            // 道理，見_pushToolResultMessage()。_renderSingleMessage()會優先
            // 讀這個屬性；沒有的話（例如舊資料、或模型把推理直接混進content
            // 沒有走獨立欄位）才退回原本的<think>/[THINKING]標籤解析。
            // --- 容錯偵測與解析機制 ---
            const callStart = fullContent.indexOf('[CALL:');
            // tw_stock_db客製: contentForMessage是真正存進this.messages（畫面
            // 顯示+送進API）的內容，預設等於fullContent，只有偵測到真正的
            // [CALL:...)]呼叫時才會被截斷，見下面lastMatchEnd的說明。
            let contentForMessage = fullContent;
            if (callStart > -1) {
                // --- 強化版多工具解析機制 ---
                let invokedCount = 0;

                // 方案 A: 使用進階 Regex 嘗試批次抓取（只有模型每個[CALL:...]都
                // 有乖乖用')]'正確收尾時才抓得到——這是行為良好的模型的正常
                // 多工具呼叫路徑）
                const regex = /\[CALL:\s*([a-zA-Z0-9_]+)\(([\s\S]*?)\)(?=\]|$)/g;
                let match;
                const toolTasks = [];
                let lastMatchEnd = -1;

                while ((match = regex.exec(fullContent)) !== null) {
                    toolTasks.push({ fnName: match[1], fnArgsRaw: match[2].trim() });
                    lastMatchEnd = match.index + match[0].length;
                }

                // tw_stock_db客製: 有些模型（實測nemotron系列）發出第一個真正
                // 的[CALL:...]之後完全不會停下來等真正的工具結果，反而自己
                // 接著在後面「模擬」一整段假的工具回傳內容、假裝在推理、甚至
                // 自己接著再寫一個[CALL:...]（但同樣沒有正確收尾），全部黏在
                // 同一次回覆裡——這種情況下面的方案A regex找不到任何一個
                // 以')]'正確收尾的呼叫（lookahead永遠不成立），toolTasks會是
                // 空陣列，需要退回下面的方案B救援路徑。
                //
                // 方案A成功找到呼叫時，才用它算出的lastMatchEnd截斷訊息內容
                // （丟掉模型自己接著編造的任何內容，只留到最後一個「真的」
                // 呼叫結尾——這種情況代表模型每個呼叫都有正確收尾，值得信任
                // 全部執行）。方案B的截斷邏輯是分開算的，見下面。
                if (lastMatchEnd > -1) {
                    let truncateAt = lastMatchEnd;
                    if (fullContent[truncateAt] === ']') truncateAt += 1;
                    contentForMessage = fullContent.slice(0, truncateAt);
                }

                // 方案 B: 方案A完全沒抓到任何正確收尾的呼叫時的救援路徑。
                // 這裡不能沿用舊版「找fullContent裡最後一個[CALL:，把它到
                // 字串結尾的全部內容當參數」的做法——模型不停下來時，最後
                // 一個[CALL:往往才是模型自己憑空接著編的（可能引用它自己前面
                // 虛構的假資料，例如假造一個圖片編號），而且參數會被字串
                // 結尾前所有後續文字（假TOOL RESULT、推理草稿、甚至下一個
                // 使用者看不到的[CALL:...]）污染。改成鎖定fullContent裡「第
                // 一個」[CALL:——那才是模型最初真正想呼叫、最可信的意圖——
                // 再用_extractBalancedCallArgs()正確算出這個呼叫自己的參數
                // 邊界（考慮巢狀括號/字串，不管模型有沒有乖乖收尾都能正確
                // 停在對的位置），確保只執行、只顯示這一個呼叫，把模型自己
                // 接著編造的所有內容整段丟棄，讓下一輪對話基於真正的工具
                // 結果重新產生，而不是順著一整串自我幻想的假資料繼續編。
                if (toolTasks.length === 0) {
                    const nameMatch = fullContent.slice(callStart).match(/^\[CALL:\s*([a-zA-Z0-9_]+)\s*\(/);
                    if (nameMatch) {
                        const openParenIdx = callStart + nameMatch[0].length - 1;
                        const { content, endIndex } = this._extractBalancedCallArgs(fullContent, openParenIdx);
                        toolTasks.push({ fnName: nameMatch[1], fnArgsRaw: content.trim() });
                        let truncateAt = endIndex;
                        if (fullContent[truncateAt] === ']') truncateAt += 1;
                        contentForMessage = fullContent.slice(0, truncateAt);
                    }
                }

                this._pushAssistantMessage(contentForMessage, reasoningContent);

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
            } else {
                // 完全沒有[CALL:的純文字回答，contentForMessage就是fullContent本身，
                // 不需要截斷。
                this._pushAssistantMessage(contentForMessage, reasoningContent);
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
                    // tw_stock_db客製: 跟_loopFetch同樣的MODEL NAME留空自動fallback，
                    // 見executeChat()/_nextAutoFallbackModel()的說明。
                    const nextFallbackModel = this._nextAutoFallbackModel(response.status, apiModel);
                    if (nextFallbackModel) {
                        this._log(`⚠️ 模型 ${apiModel} 目前無法使用(HTTP ${response.status})，自動改用下一個候選模型：${nextFallbackModel}`);
                        this._updateHeaderModelName(nextFallbackModel, true);
                        return await this._loopFetchNative(apiKey, apiUrl, nextFallbackModel, retryAttempt);
                    }
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
                        // tw_stock_db客製: 跟_loopFetch同樣的理由，見那邊
                        // _turnPruneCount的說明。
                        if (this._turnPruneCount >= this.maxPruneRetriesPerTurn) {
                            // tw_stock_db客製: 跟_loopFetch同樣的理由，附上原始errText。
                            this._log(`❌ 這一輪對話已經反覆壓縮 ${this.maxPruneRetriesPerTurn} 次仍超過上下文限制。已停止繼續嘗試，建議縮小範圍再問一次，或換一個上下文較大的模型。最後一次的原始錯誤：HTTP ${response.status} ${errText.slice(0, 300)}`);
                            return "";
                        }
                        this._turnPruneCount++;
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

            // tw_stock_db客製: 跟_loopFetch串流路徑同樣的理由（見那邊的詳細
            // 說明）——reasoningAccum只存進非可枚舉的_reasoningDisplay屬性，
            // 不接進finalContent/msg.content，避免模型的內部推理草稿被永久
            // 疊進送給API的對話歷史、造成context愈滾愈大。
            // tw_stock_db客製: 只有觸及安全上限仍未寫完才提醒使用者，正常情況
            // 下自動接續機制會無聲把內容拼完整，見_loopFetch串流路徑同樣的
            // 說明。
            if (hitContinueCap) {
                finalContent += '\n\n---\n⚠️ **已自動請AI接續多次仍未寫完，這裡先停下來（可能內容真的很長，或端點異常）。** 可以直接追問「請繼續」。';
            }

            this._pushAssistantMessage(finalContent, reasoningAccum, toolCalls.length ? { tool_calls: toolCalls } : {});

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

    // ============================================================
    // 🧩 批次子任務（multi-agent-style parallel batch analysis）
    // ============================================================
    // tw_stock_db客製: 解決「AI要逐一分析一份清單（例如鎖股名單）裡的每一
    // 檔股票、篩出符合條件的」這種filter型任務時，實測會不停撞到context
    // limit又觸發壓縮的問題（見這次session稍早修的一連串context膨脹問題）
    // ——根本原因是這種任務本來就不需要「同時看到全部股票」才能下結論，
    // 每一檔的判斷是獨立的，卻被塞進同一個持續累積的主對話context裡，
    // 逐檔疊加reasoning/工具呼叫，當然愈滾愈大。
    //
    // 這裡的做法：每一檔股票各自開一個「用完即丟」的獨立子任務（跟主對話
    // 共用同一組API設定/已註冊工具，但訊息歷史完全隔離，不會互相汙染），
    // 只留一段精簡的最終結論流回主對話——不管清單有幾十檔，主對話的
    // context增量都是「筆數 × 一句話結論」，不會隨著逐檔分析的過程細節
    // （工具呼叫、模型的內部推理）線性膨脹。多個子任務用簡單的worker-pool
    // 平行執行（併發數見_getBatchConcurrency()，使用者可調），近似
    // multi-agent的效果，同時控制成本/流量。
    //
    // 這個機制只適合「篩選/獨立判斷型」任務，不適合「一定要同時看到全部
    // 項目才能下結論」的統整型任務（例如「這20檔裡最強的是哪一檔」需要
    // 互相比較，拆開各自獨立判斷就沒有意義）——AI_SYSTEM_PROMPT裡有教
    // 這個判斷原則，交給AI自己先分類問題類型再決定要不要用這個工具。

    // tw_stock_db客製: 單一子任務的執行迴圈——跟主對話的_loopFetch/
    // _loopFetchNative是同樣的「送出請求→解析工具呼叫→執行→餵回結果→
    // 再送出」邏輯，但簡化成非串流、固定輪數上限、訊息歷史用區域變數
    // （不動this.messages），沒有streaming UI更新、沒有pruneContext（子
    // 任務本來就是短命、用完即丟，正常不會累積到需要壓縮；真的異常時
    // maxRounds上限會擋住，不會無限迴圈）。
    async _runSubAgentTask(userPrompt, maxRounds = 6) {
        const { apiKey, apiUrl, apiModel } = this._getApiConfig();
        const useNative = this._shouldUseNativeToolCalls(apiModel);
        let messages = [
            { role: 'system', content: this._getFinalSystemPrompt() },
            { role: 'user', content: userPrompt },
        ];

        for (let round = 0; round < maxRounds; round++) {
            const body = {
                model: apiModel,
                messages,
                temperature: 0,
                ...this._buildSamplingParamsBody(),
                max_tokens: this._getGenerationSettings().maxOutputTokens,
                stream: false,
            };
            if (useNative) {
                body.tools = this._buildNativeToolsSchema();
                body.tool_choice = 'auto';
            } else {
                // tw_stock_db客製: 見_loopFetch裡CALL_STOP_SEQUENCE的說明，子任務
                // 用的是同一份判斷（只在文字式協定加，原生tool_calls不用）。
                Object.assign(body, this._buildStopParamBody());
            }

            let response;
            try {
                response = await fetch(`${apiUrl}/chat/completions`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                });
            } catch (err) {
                return `[子任務網路錯誤: ${err.message}]`;
            }
            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                // tw_stock_db客製: 子任務故意不接pruneContext/一般重試機制（見下面
                // 的原有說明），但stop參數被拒絕是「這次request body本身有問題」
                // 而不是內容太長，值得單獨處理——不然只要stop一被拒絕，整批
                // batch_analyze_stocks的每一個子任務都會全部失敗。偵測到就標記
                // 停用、重跑同一輪（不消耗maxRounds），_disableStopParam對同一個
                // session只會成功一次，不會無窮重試。
                if (!useNative && this._isStopParamRejected(errText) && this._disableStopParam(errText)) {
                    round--;
                    continue;
                }
                // 子任務故意不接pruneContext/重試機制——訊息歷史本來就很短
                // （系統prompt+單一問題+少數工具往返），真的撞到400/413多半
                // 代表這個端點/模型本身有問題，重試對子任務的成本效益不划算，
                // 直接回報失敗讓上層知道即可。
                return `[子任務失敗: HTTP ${response.status}${errText ? ' ' + errText.slice(0, 150) : ''}]`;
            }

            const data = await response.json();
            const message = data.choices && data.choices[0] && data.choices[0].message;
            if (!message) return '[子任務失敗: 回應格式異常]';

            const rawContent = message.content || '';
            const toolCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];

            if (useNative && toolCalls.length) {
                messages.push(Object.assign({ role: 'assistant', content: this._stripInlineBase64(rawContent) }, { tool_calls: toolCalls }));
                for (const tc of toolCalls) {
                    const fnName = tc.function && tc.function.name;
                    const rawArgs = (tc.function && tc.function.arguments) || '{}';
                    try {
                        const toolDef = this._getToolDefinition(fnName);
                        if (!toolDef) throw new Error(`找不到工具: ${fnName}`);
                        const result = await Promise.resolve(toolDef.callback(rawArgs));
                        messages.push(this._buildToolResultMessage(fnName, result, { tool_call_id: tc.id }));
                    } catch (err) {
                        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify({ ok: false, error: String(err.message || err) }) });
                    }
                }
                continue;
            }

            // tw_stock_db客製: 文字式[CALL:...]慣例，跟_loopFetch同樣的解析
            // 規則（含救援路徑，見_loopFetch裡_extractBalancedCallArgs呼叫端
            // 的詳細說明——模型沒有正確用')]'收尾時，鎖定第一個[CALL:、用
            // 括號配對正確算出參數邊界，不要被模型自己接著編造的假TOOL
            // RESULT/推理文字/後續呼叫污染），這裡簡化重寫一份而不是共用同一個
            // helper，是因為子任務訊息陣列是區域變數，跟_loopFetch操作
            // this.messages/fullContent的方式不同，硬要共用反而更複雜。
            const regex = /\[CALL:\s*([a-zA-Z0-9_]+)\(([\s\S]*?)\)(?=\]|$)/g;
            let match;
            const toolTasks = [];
            let lastMatchEnd = -1;
            while ((match = regex.exec(rawContent)) !== null) {
                toolTasks.push({ fnName: match[1], fnArgsRaw: match[2].trim() });
                lastMatchEnd = match.index + match[0].length;
            }

            let truncated = rawContent;
            if (lastMatchEnd > -1) {
                let end = lastMatchEnd;
                if (rawContent[end] === ']') end += 1;
                truncated = rawContent.slice(0, end);
            } else {
                const callStart = rawContent.indexOf('[CALL:');
                if (callStart > -1) {
                    const nameMatch = rawContent.slice(callStart).match(/^\[CALL:\s*([a-zA-Z0-9_]+)\s*\(/);
                    if (nameMatch) {
                        const openParenIdx = callStart + nameMatch[0].length - 1;
                        const { content, endIndex } = this._extractBalancedCallArgs(rawContent, openParenIdx);
                        toolTasks.push({ fnName: nameMatch[1], fnArgsRaw: content.trim() });
                        let end = endIndex;
                        if (rawContent[end] === ']') end += 1;
                        truncated = rawContent.slice(0, end);
                    }
                }
            }

            if (!toolTasks.length) {
                const finalText = this._stripInlineBase64(rawContent).trim();
                return finalText || '（子任務無回應）';
            }

            messages.push({ role: 'assistant', content: this._stripInlineBase64(truncated) });

            for (const task of toolTasks) {
                try {
                    const toolDef = this._getToolDefinition(task.fnName);
                    if (!toolDef) throw new Error(`找不到工具: ${task.fnName}`);
                    const parsedArgs = await this.repairJsonPayload(task.fnArgsRaw);
                    const result = await Promise.resolve(toolDef.callback(JSON.stringify(parsedArgs)));
                    messages.push(this._buildToolResultMessage(task.fnName, result));
                } catch (err) {
                    messages.push({ role: 'user', content: `[系統提示] 工具 "${task.fnName}" 執行失敗: ${err.message}。` });
                }
            }
            // 迴圈繼續下一輪，讓模型看到工具結果後給出最終結論
        }
        return '[子任務超過最大回合數仍未給出結論]';
    }

    // tw_stock_db客製: batch_analyze_stocks工具的實作入口（見web/index.html
    // 的AI_CAPABILITIES註冊），把一份項目清單拆成N個一組平行執行的子任務，
    // 每個子任務只回傳一段精簡結論，彙整成陣列回傳給主對話。這個引擎本身
    // 刻意跟「股票」無關（不假設items是什麼、instruction要問什麼）——是
    // web/index.html的AI_CAPABILITIES把它包成一個叫batch_analyze_stocks、
    // items填股票代號的工具，這裡拿到的只是通用的字串陣列，換成別的應用
    // （例如「批次審查一批文件」「批次檢查一批網址」）items填別的東西一樣
    // 能用，見這次session稍早的說明：floating-assistant.js整份檔案不應該
    // 依賴任何股票/這個app特有的模組，所有領域邏輯都應該留在index.html。
    async runBatchSubAgents(items, instruction, concurrency) {
        const list = (Array.isArray(items) ? items : [items]).map(c => String(c || '').trim()).filter(Boolean);
        if (!list.length) return { ok: false, error: '沒有提供任何項目' };
        const n = Math.min(list.length, Number.isFinite(Number(concurrency)) && Number(concurrency) > 0
            ? Math.min(8, Math.round(Number(concurrency)))
            : this._getBatchConcurrency());

        const results = new Array(list.length);
        let nextIdx = 0;
        let doneCount = 0;
        this._log(`↻ 批次分析開始：共${list.length}項，同時執行${n}個子任務…`);

        const worker = async () => {
            while (nextIdx < list.length) {
                const myIdx = nextIdx++;
                const item = list[myIdx];
                const prompt = `${instruction}\n\n這次只需要處理這一項：${item}。回答要精簡（2-4句話為原則），先講結論、再附一句關鍵理由，不需要完整的多段式分析架構。`;
                let verdict;
                try {
                    verdict = await this._runSubAgentTask(prompt);
                } catch (err) {
                    verdict = `[子任務例外: ${err.message}]`;
                }
                results[myIdx] = { item, verdict };
                doneCount++;
                this._log(`↻ 批次分析進度：${doneCount}/${list.length}（${item} 完成）`);
            }
        };

        await Promise.all(Array.from({ length: n }, () => worker()));
        this._log(`✅ 批次分析完成，共${list.length}項。`);
        return results;
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
                <span style="font-weight: bold; color: #76b900;">AI Assistant <span style="font-size:10px; background:#8b5cf6; color:#fff; padding:1px 5px; border-radius:999px; font-weight:normal; margin-left:4px;">Graph RAG</span><span id="ai-header-model-name" style="font-size:10px; font-weight:normal; color:${palette.detailText}; margin-left:6px;"></span></span>
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
                <input type="text" id="ai-model-name" list="ai-model-datalist" style="width:100%; padding:6px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; background:${palette.inputBg}; color:${palette.inputText};" placeholder='留空＝依內建清單順序自動fallback'>
                <datalist id="ai-model-datalist">
                    ${this._modelDatalistOptionsHtml()}
                </datalist>

                <details style="margin-top:8px;">
                    <summary style="font-size:12px; font-weight:bold; cursor:pointer; user-select:none; color:${palette.detailText};">生成／取樣參數（點擊展開）</summary>
                    <div style="margin-top:6px; padding:8px; background:${palette.detailBg}; color:${palette.detailText}; border-radius:6px;">
                        <label style="font-size:11px; display:block; margin-bottom:2px;" for="ai-gen-context-window">模型上下文視窗（tokens，用來主動判斷何時該壓縮對話）</label>
                        <input type="number" min="512" step="512" id="ai-gen-context-window" style="width:100%; padding:4px; box-sizing:border-box; border:1px solid ${palette.inputBorder}; border-radius:4px; margin-bottom:6px; background:${palette.inputBg}; color:${palette.inputText};">
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
                <div style="margin-top:4px; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="ai-slash-menu-chk" ${this.advancedSettings.slashCommandMenuEnabled !== false ? 'checked' : ''} style="cursor:pointer;">
                    <label for="ai-slash-menu-chk" style="font-size:12px; cursor:pointer; user-select:none; color:${palette.detailText};">輸入框打「/」時顯示可用指令選單</label>
                </div>

                <div style="margin-top:10px;">
                    <button id="ai-btn-advanced" type="button" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid ${palette.inputBorder}; background:${palette.detailBg}; color:${palette.detailText}; cursor:pointer;">Advance</button>
                </div>
            </div>
            <div id="ai-chat-body" style="flex:1; padding:15px; overflow-y:auto; background: ${palette.chatBg}; color: ${palette.chatText}; font-size: 14px;"></div>
            <div id="ai-suggestion-chips" style="display:none; flex-wrap:wrap; gap:6px; padding:8px 12px; background:${palette.chatBg}; border-top:1px solid ${palette.windowBorder};"></div>
            <div id="ai-autocomplete-bar" style="background:${palette.detailBg}; color:${palette.detailText}; font-size:11px; padding:4px 12px; display:none; border-top:1px solid ${palette.windowBorder};">
                💡 按 <kbd style="background:#fff;padding:1px 3px;border:1px solid #ccc;border-radius:3px;">Tab</kbd> 自動補全: <span id="ai-suggest-text"></span>
            </div>
            <div id="ai-input-wrap" style="padding:10px; background:${palette.windowBg}; border-top:1px solid ${palette.windowBorder}; position:relative;">
                <div id="ai-history-panel" style="display:none; position:absolute; left:10px; right:10px; bottom:100%; margin-bottom:6px; max-height:45vh; overflow-y:auto; background:${palette.windowBg}; border:1px solid ${palette.inputBorder}; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.25); z-index:20;"></div>
                <div id="ai-slash-menu" style="display:none; position:absolute; left:10px; right:10px; bottom:100%; margin-bottom:6px; max-height:30vh; overflow-y:auto; background:${palette.windowBg}; border:1px solid ${palette.inputBorder}; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.25); z-index:21;"></div>
                <div style="display:flex; align-items:stretch; gap:6px;">
                    <button id="ai-history-btn" type="button" title="歷史訊息（手機沒有上下鍵時可以用這個瀏覽/挑選之前輸入過的內容）" style="flex:0 0 auto; padding:0 10px; border:1px solid ${palette.inputBorder}; border-radius:6px; background:${palette.detailBg}; color:${palette.detailText}; font-size:15px; cursor:pointer;">🕘</button>
                    <textarea id="ai-input-text" rows="2" placeholder="輸入訊息... (上下鍵選歷史, Tab補全)" style="flex:1; min-width:0; box-sizing:border-box; padding:8px; border:1px solid ${palette.inputBorder}; border-radius:6px; resize:none; font-size:13px; font-family:inherit; background:${palette.inputBg}; color:${palette.inputText};"></textarea>
                    <button id="ai-send-btn" type="button" title="送出 (Enter)" style="flex:0 0 auto; padding:0 14px; border:none; border-radius:6px; background:#76b900; color:#fff; font-size:13px; font-weight:bold; cursor:pointer;">送出</button>
                </div>
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

    // tw_stock_db客製: 判斷聊天視窗目前的捲動位置是不是「已經在底部附近」
    // （容許80px誤差，含捲軸慣性/次像素捲動的誤差空間）。這是「要不要自動
    // 捲到底」的唯一依據——使用者自己往上拉看歷史訊息時，新內容進來(串流
    // /新訊息/重繪)不應該把畫面拉走；只有使用者本來就守在底部看最新內容
    // 時，才維持「自動貼底」的行為，這是一般聊天介面（Slack/ChatGPT等）
    // 慣用的「stick to bottom」模式。
    _isNearBottom(el) {
        if (!el) return true;
        return el.scrollHeight - el.scrollTop - el.clientHeight < 80;
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
            // tw_stock_db客製: _reasoningDisplay跟_displayDataUrl是同一個
            // 道理，同樣是刻意不可枚舉、同樣需要獨立存一份才能撐過reload，
            // 見_loopFetch/_loopFetchNative的說明。
            // tw_stock_db客製: _downloadFile（見generateAndDeliverFile）也是
            // 同一套「非可枚舉屬性額外存一份」的作法，但跟imageMap/reasoningMap
            // 不同的是：fileMap只存{id,filename,mimeType,sizeBytes}這種小
            // 參照，真正的檔案位元組本來就已經在FileCache（IndexedDB）裡，
            // 不需要、也不應該把整個檔案再塞進localStorage一次（那樣既浪費
            // 空間又違背「用IndexedDB存大檔案」的原始理由）。
            const imageMap = {};
            const reasoningMap = {};
            const fileMap = {};
            // tw_stock_db客製: /benchmark-model的報告卡也是同一套「非可枚舉
            // 屬性額外存一份」作法（見_handleBenchmarkModelCommand的說明）——
            // 報告物件本身很小（沒有圖片/檔案位元組），直接整包存進
            // localStorage沒有fileMap那種「大檔案不該重複存」的顧慮。
            const benchmarkReportMap = {};
            this.messages.forEach((m, i) => {
                if (m._displayDataUrl) imageMap[i] = m._displayDataUrl;
                if (m._reasoningDisplay) reasoningMap[i] = m._reasoningDisplay;
                if (m._downloadFile) fileMap[i] = m._downloadFile;
                if (m._benchmarkReport) benchmarkReportMap[i] = m._benchmarkReport;
            });
            (this.archivedDisplayBlocks || []).forEach((block, bi) => {
                (block.messages || []).forEach((m, mi) => {
                    if (m._displayDataUrl) imageMap[`${bi}:${mi}`] = m._displayDataUrl;
                    if (m._reasoningDisplay) reasoningMap[`${bi}:${mi}`] = m._reasoningDisplay;
                    if (m._downloadFile) fileMap[`${bi}:${mi}`] = m._downloadFile;
                    if (m._benchmarkReport) benchmarkReportMap[`${bi}:${mi}`] = m._benchmarkReport;
                });
            });
            localStorage.setItem(this.CHAT_HISTORY_KEY, JSON.stringify({
                messages: this.messages,
                archivedDisplayBlocks: this.archivedDisplayBlocks,
                imageMap,
                reasoningMap,
                fileMap,
                benchmarkReportMap,
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
            // tw_stock_db客製: key是純數字代表this.messages裡的index；
            // "bi:mi"格式代表archivedDisplayBlocks[bi].messages[mi]，見
            // _persistChatHistory()存檔時的說明。imageMap/reasoningMap兩者
            // key格式相同，共用同一個解析邏輯。
            const resolveMsg = (key) => {
                if (key.includes(':')) {
                    const [bi, mi] = key.split(':').map(Number);
                    return this.archivedDisplayBlocks[bi] && this.archivedDisplayBlocks[bi].messages[mi];
                }
                return this.messages[Number(key)];
            };
            if (data.imageMap) {
                Object.entries(data.imageMap).forEach(([key, dataUrl]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_displayDataUrl', { value: dataUrl, enumerable: false, configurable: true });
                });
            }
            if (data.reasoningMap) {
                Object.entries(data.reasoningMap).forEach(([key, reasoningText]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_reasoningDisplay', { value: reasoningText, enumerable: false, configurable: true });
                });
            }
            if (data.fileMap) {
                Object.entries(data.fileMap).forEach(([key, fileRef]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_downloadFile', { value: fileRef, enumerable: false, configurable: true });
                });
            }
            if (data.benchmarkReportMap) {
                Object.entries(data.benchmarkReportMap).forEach(([key, report]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_benchmarkReport', { value: report, enumerable: false, configurable: true });
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
        // tw_stock_db客製: 這個函式會整個清空chatBody重繪（innerHTML=''），
        // 捲動位置在清空的瞬間就會歸零，一定要在清空「之前」先記住使用者
        // 目前的捲動狀態，重繪完才知道該還原成什麼樣子——只有原本就在底部
        // 附近才自動捲到新的底部，不然就照原本的絕對scrollTop還原（重繪
        // 通常只在最後追加內容，前面內容高度不變，同一個scrollTop數值
        // 對應的畫面內容不會變，見_isNearBottom()的說明）。
        const wasNearBottomForRerender = this._isNearBottom(chatBody);
        const prevScrollTopForRerender = chatBody.scrollTop;
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
        chatBody.scrollTop = wasNearBottomForRerender ? chatBody.scrollHeight : prevScrollTopForRerender;
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

        // tw_stock_db客製: /benchmark-model的報告卡，見_handleBenchmarkModelCommand
        // 的說明——存在this.messages裡才會跟著正常訊息陣列存活過
        // _renderMessageHistory()整個重繪（例如切換主題），純DOM插入的版本
        // 會在那種情況下憑空消失（使用者實測回報過）。
        if (msg._benchmarkReport) {
            const wrap = document.createElement('div');
            wrap.innerHTML = this._renderBenchmarkReportHtml(msg._benchmarkReport);
            container.appendChild(wrap.firstElementChild);
            return;
        }

        // 💡 tw_stock_db客製：AI助理產生的檔案下載連結（見
        // generateAndDeliverFile()）。跟圖片訊息（見下面role==='tool'那段）
        // 同一個設計原則——真正的檔案位元組不在msg.content/DOM屬性裡，而是
        // 非同步從this.fileCache（IndexedDB）取回；blob: URL只在目前這個
        // 分頁存活期間有效，所以每次渲染（含重新整理頁面後）都要重新產生，
        // 不能直接把URL字串存起來重用。
        if (msg._downloadFile) {
            const { id, filename, sizeBytes } = msg._downloadFile;
            const fileWrap = document.createElement('div');
            fileWrap.style.cssText = `margin-bottom: 12px; padding: 10px 14px; border-radius: 6px; max-width: 85%; background: ${palette.assistantBg}; color: ${palette.assistantText}; border-left: 4px solid #76b900;`;
            const sizeLabel = sizeBytes != null
                ? (sizeBytes >= 1024 * 1024 ? `${(sizeBytes / 1024 / 1024).toFixed(2)} MB` : `${(sizeBytes / 1024).toFixed(1)} KB`)
                : '';
            fileWrap.innerHTML = `
                <div style="margin-bottom:6px;"><b>🤖 AI:</b> ${msg.content || ''}</div>
                <a class="ai-file-download-link" href="javascript:void(0)" style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;background:#76b900;color:#fff;border-radius:6px;text-decoration:none;font-weight:bold;font-size:13px;">📥 下載 ${filename}${sizeLabel ? `（${sizeLabel}）` : ''}</a>
            `;
            container.appendChild(fileWrap);
            const linkEl = fileWrap.querySelector('.ai-file-download-link');
            this.fileCache.get(id).then(record => {
                if (!record) throw new Error('not found');
                const url = URL.createObjectURL(record.blob);
                linkEl.href = url;
                linkEl.setAttribute('download', record.filename);
                linkEl.addEventListener('click', () => setTimeout(() => URL.revokeObjectURL(url), 4000), { once: true });
            }).catch(() => {
                linkEl.textContent = '⚠️ 檔案已不在快取中（可能已被自動清除或超過容量上限被淘汰）';
                linkEl.style.background = palette.detailBg || '#999';
                linkEl.style.cursor = 'default';
            });
            return;
        }

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
            // tw_stock_db客製: 優先讀非可枚舉的_reasoningDisplay屬性（見
            // _loopFetch/_loopFetchNative的說明，這樣msg.content本身是乾淨
            // 的答案文字，不含推理草稿）；沒有這個屬性時（例如舊版資料、或
            // 模型沒有走獨立reasoning_content欄位、直接把推理混進content）
            // 才退回原本的<think>/[THINKING]標籤解析，維持向下相容。
            const thinking = msg._reasoningDisplay
                ? { thinking: msg._reasoningDisplay, answer: msg.content }
                : this._extractThinkingContent(msg.content);
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
            div.style.cssText += `background: ${palette.assistantBg}; color: ${palette.assistantText}; border-left: 4px solid #76b900; position: relative;`;
            const label = document.createElement('div');
            label.style.cssText = 'margin-bottom: 4px;';
            label.innerHTML = '<b>🤖 AI:</b>';
            div.appendChild(label);
            // tw_stock_db客製: 使用者反映偶爾會看到這則佔位文字直接顯示成
            // 好像是AI的正式回覆——實際情況是模型這一輪只寫了思考過程
            // （_reasoningDisplay有內容），真正的答案欄位(content)卻是空的
            // （常見成因：單次回覆上限提前用完，模型還在「思考」階段就被
            // 截斷，沒機會寫出最終答案）。改成講清楚發生了什麼、建議怎麼
            // 處理，不要只留一句容易被誤會成「這就是回覆內容」的短語。
            const answerText = thinking.answer ||
                '⚠️ 這一輪模型只輸出了思考過程，沒有產生最終文字回覆（可能是單次回覆上限提前用完，或端點異常）。可以點上面「🧠 思考過程」查看，或直接追問一次。';
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
                // tw_stock_db客製: 2026-08-23使用者要求「AI回應的表格裡股票
                // 名稱/代號可以點下去跳過去」——floating-assistant.js不認識
                // 「股票」這個概念，跟chipsProvider/register_slash_command
                // 同一種設計：只提供options.onTableRendered這個callback，
                // 每渲染出一個<table>就呼叫一次，實際的股票代號辨識/點擊
                // 跳轉邏輯由index.html注入（見linkifyStockTableCells()）。
                if (typeof this.options.onTableRendered === 'function') {
                    mdDiv.querySelectorAll('table').forEach((table) => {
                        try { this.options.onTableRendered(table); }
                        catch (e) { console.warn('onTableRendered callback失敗:', e); }
                    });
                }
                this._appendMarkdownExportButton(div, answerText, palette);
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

    // tw_stock_db客製: 2026-08-23使用者要求輸入框打「/」開頭時跳出可用斜線
    // 指令清單（不只是行動裝置——原本的Tab補全只認得指令「歷史」，不知道
    // 「現在到底有哪些指令」）。讀this.slashCommands（見register_slash_command）
    // 即時做前綴過濾，desktop/mobile共用同一份可點擊清單（觸控裝置上原生
    // <select>沒有可靠的「用JS強制彈出」API，改用這個自訂清單、加大列高當
    // 觸控目標，實務上比硬要求原生combobox更可靠）。
    // this.advancedSettings.slashCommandMenuEnabled是使用者可以關掉這個功能
    // 的開關（Advanced Settings裡的「輸入/時顯示指令選單」核取方塊）。
    _wireSlashCommandMenu(inputText, slashMenu, suggestBar) {
        if (!slashMenu) return;
        const palette = this._getThemePalette();

        const hide = () => { slashMenu.style.display = 'none'; slashMenu.innerHTML = ''; };

        const renderMenu = () => {
            if (this.advancedSettings.slashCommandMenuEnabled === false) { hide(); return; }
            const val = inputText.value;
            if (!val.startsWith('/') || /\s/.test(val)) { hide(); return; }
            const matches = [...this.slashCommands.values()].filter((c) => c.cmd.startsWith(val.toLowerCase()));
            if (!matches.length) { hide(); return; }
            if (suggestBar) suggestBar.style.display = 'none'; // 兩個下拉選單不要同時開
            slashMenu.innerHTML = matches.map((c) => `
                <div class="ai-slash-item" data-cmd="${this._escapeAttr(c.cmd)}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid ${palette.windowBorder};">
                    <div style="font-size:13px; font-weight:bold; color:#76b900;">${this._escapeHtml(c.cmd)}${c.hint ? ` <span style="font-weight:normal; color:${palette.detailText};">${this._escapeHtml(c.hint)}</span>` : ''}</div>
                    ${c.desc ? `<div style="font-size:11px; color:${palette.detailText}; margin-top:2px;">${this._escapeHtml(c.desc)}</div>` : ''}
                </div>
            `).join('');
            slashMenu.style.display = 'block';
        };

        inputText.addEventListener('input', renderMenu);
        inputText.addEventListener('focus', renderMenu);

        slashMenu.addEventListener('mousedown', (e) => {
            // mousedown（而不是click）先於textarea的blur觸發，避免blur把選單
            // 關掉之後click事件才發生、選不到東西。
            const item = e.target.closest('.ai-slash-item');
            if (!item) return;
            e.preventDefault();
            inputText.value = item.dataset.cmd + ' ';
            hide();
            inputText.focus();
        });

        document.addEventListener('click', (e) => {
            if (e.target !== inputText && !slashMenu.contains(e.target)) hide();
        });
        inputText.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && slashMenu.style.display === 'block') hide();
        });
    }

    // tw_stock_db客製: 2026-08-23使用者要求「使用者切到AI的時候，貼幾個
    // breadcrumb讓使用者按下去當推薦詢問」——跟register_slash_command()同一
    // 種「floating-assistant.js只提供機制、tw_stock_db自己的內容從
    // index.html掛進來」設計，這裡不寫死任何跟股票/tw_stock_db有關的文字，
    // 只提供options.chipsProvider這個callback（建構子傳入，跟既有的
    // contextProvider是同一種模式）跟這個公開的refresh方法。index.html會在
    // 使用者切到AI分頁、或切換選中的股票時呼叫這個方法重新產生（例如把
    // 目前選中的股票代號/名稱代入模板文字）。點擊chip只會把文字填進輸入框
    // （不自動送出），讓使用者可以先看一眼/改字再送，比較不會誤觸發要花
    // token或會產生檔案的動作（例如「口頭+pptx」）。
    refreshSuggestionChips() {
        const container = document.getElementById('ai-suggestion-chips');
        if (!container) return;
        const chips = typeof this.options.chipsProvider === 'function' ? (this.options.chipsProvider() || []) : [];
        if (!chips.length) { container.style.display = 'none'; container.innerHTML = ''; return; }
        const palette = this._getThemePalette();
        container.innerHTML = chips.map((c, i) => `
            <button type="button" class="ai-suggestion-chip" data-idx="${i}" style="padding:4px 10px; border-radius:999px; border:1px solid ${palette.inputBorder}; background:${palette.detailBg}; color:${palette.detailText}; font-size:11px; cursor:pointer; white-space:nowrap;">${this._escapeHtml(c.label || c.text)}</button>
        `).join('');
        container.style.display = 'flex';
        container.querySelectorAll('.ai-suggestion-chip').forEach((btn) => {
            btn.addEventListener('click', () => {
                const chip = chips[Number(btn.dataset.idx)];
                const inputEl = document.getElementById('ai-input-text');
                if (inputEl && chip) { inputEl.value = chip.text; inputEl.focus(); }
            });
        });
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
        const slashMenu = document.getElementById('ai-slash-menu');
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
        const slashMenuChkBx = document.getElementById('ai-slash-menu-chk');
        if (slashMenuChkBx) {
            slashMenuChkBx.addEventListener('change', (e) => {
                this.advancedSettings.slashCommandMenuEnabled = e.target.checked;
                this._saveAdvancedSettings();
            });
        }

        this._applyThemeStyles();
        this._syncStopButton();

        // 預設的主題切換觸發機制：觀察 <html data-theme> 屬性變化（跟
        // _isLightTheme()預設慣例一致）。提供了options.isLightTheme但host
        // 頁面用的是完全不同的訊號（例如body class、自訂事件）時，這個
        // observer不會觸發，host頁面應該在自己切換主題的地方直接呼叫下面
        // 公開的refreshTheme()，不用等這裡猜對觀察目標。
        const themeObserver = new MutationObserver(() => this.refreshTheme());
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
            // tw_stock_db客製: 使用者手動打字時即時更新header小字提示，留空時
            // 顯示「自動fallback候選清單第一個」而不是誤導成「已經固定用某個
            // 模型」——真正選中哪個要等executeChat()送出下一輪對話才知道。
            const trimmed = inputModelName.value.trim();
            this._updateHeaderModelName(trimmed || `${PRESET_MODEL_OPTIONS[0]}起`, !trimmed);
        });
        // tw_stock_db客製: 面板剛開啟時的初始值，邏輯跟上面input監聽器一致。
        this._updateHeaderModelName(inputModelName.value.trim() || `${PRESET_MODEL_OPTIONS[0]}起`, !inputModelName.value.trim());

        // tw_stock_db客製: 生成/取樣參數設定，跟上面API Key/URL/Model一樣採
        // 輸入即存的方式，不用另外按儲存鍵。
        const genContextWindowInput = document.getElementById('ai-gen-context-window');
        if (genContextWindowInput) {
            genContextWindowInput.addEventListener('input', () => {
                const n = Number(genContextWindowInput.value);
                if (Number.isFinite(n) && n > 0) this._getGenerationSettings().contextWindowTokens = Math.round(n);
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
                this._submitChatInput(inputText, suggestBar);
            }
        });

        // tw_stock_db客製: 使用者反映自動化/部分環境下對textarea送出的Enter
        // keydown事件有時不會被觸發（例如某些瀏覽器自動化工具模擬按鍵的方式
        // 跟真人打字產生的事件不完全一致），加一個實體的送出按鈕當備援，
        // 兩條路徑共用同一個_submitChatInput()，行為完全一致。
        const sendBtn = document.getElementById('ai-send-btn');
        if (sendBtn) {
            sendBtn.addEventListener('click', () => this._submitChatInput(inputText, suggestBar));
        }

        this._wireSlashCommandMenu(inputText, slashMenu, suggestBar);

        // tw_stock_db客製: 手機上沒有實體上/下鍵，原本的ArrowUp/ArrowDown
        // 瀏覽歷史指令沒辦法用——加一個🕘按鈕，點開一份可以直接點選的歷史
        // 清單（this.commandHistory，跟Arrow鍵共用同一份資料），點哪一則
        // 就把內容填回輸入框（不自動送出，讓使用者可以先看/改再送），手機
        // 桌機都適用。
        const historyBtn = document.getElementById('ai-history-btn');
        const historyPanel = document.getElementById('ai-history-panel');
        if (historyBtn && historyPanel) {
            const closeHistoryPanel = () => { historyPanel.style.display = 'none'; };
            historyBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                if (historyPanel.style.display === 'block') { closeHistoryPanel(); return; }
                const palette = this._getThemePalette();
                if (!this.commandHistory.length) {
                    historyPanel.innerHTML = `<div style="padding:12px; font-size:12px; color:${palette.detailText}; text-align:center;">目前沒有歷史訊息</div>`;
                } else {
                    historyPanel.innerHTML = this.commandHistory.map((cmd, i) => `
                        <div class="ai-history-row" data-history-idx="${i}" style="padding:9px 12px; font-size:13px; border-bottom:1px solid ${palette.inputBorder}; cursor:pointer; white-space:pre-wrap; word-break:break-word;">${this._escapeHtml(cmd)}</div>
                    `).join('');
                }
                historyPanel.style.display = 'block';
            });
            historyPanel.addEventListener('click', (e) => {
                const row = e.target.closest('[data-history-idx]');
                if (!row) return;
                const cmd = this.commandHistory[Number(row.dataset.historyIdx)];
                if (cmd != null) {
                    inputText.value = cmd;
                    inputText.focus();
                }
                closeHistoryPanel();
            });
            document.addEventListener('click', (e) => {
                if (historyPanel.style.display === 'block' && !historyPanel.contains(e.target) && e.target !== historyBtn) {
                    closeHistoryPanel();
                }
            });
        }

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
