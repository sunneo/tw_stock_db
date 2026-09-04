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
//   8. 工具/函式名稱支援非ASCII（例如中文）：2026-08-24使用者指出，沒有
//      資工背景的使用者透過Skill編輯器或add_ai_function讓AI建立自訂
//      函式時，很自然會用自己看得懂的中文命名，但原生tool-calling
//      API（OpenAI相容端點）規定function.name只能是
//      ^[a-zA-Z0-9_-]{1,64}$，中文名稱直接送出去輕則該工具被拒絕、重則
//      整批tools參數格式不合法讓當輪原生tool-calling整個失敗；文字式
//      [CALL: name(args)]慣例原本到處用[a-zA-Z0-9_]+解析呼叫名稱，同樣
//      抓不到中文。新增_sanitizeToolNameForNativeApi()：純ASCII名稱完全
//      不受影響（絕大多數內建工具都是這種情況），只有不符合API規定格式
//      的名稱才會產生一個穩定的短雜湊別名送給原生API，_getToolDefinition
//      同時接受原始名稱或別名反查；所有[CALL:...]解析regex加上Unicode
//      屬性字元類（\p{L}\p{N}_ + u旗標）取代原本的[a-zA-Z0-9_]，讓文字式
//      慣例也能正確解析中文函式名稱。這是通用的聊天widget穩定性修正，
//      跟股票資料無關。
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
    // tw_stock_db客製: kind區分這筆記錄是誰產生的——'generated'（預設，AI
    // 匯出的PDF/PPTX/Markdown，既有行為不變）或'uploaded'（階段2新增：
    // 使用者透過📎附件按鈕上傳、給AI叫用sub agent解析的檔案，見
    // list_uploaded_files/parse_uploaded_file）。同一個FileCache/LRU淘汰
    // 機制兩種都適用，只是列出「使用者上傳了哪些檔案」時要能篩掉AI自己
    // 產生的匯出檔，不然使用者會在清單裡看到自己從沒上傳過的PPTX。
    async put(filename, mimeType, blob, kind = 'generated') {
        const id = (crypto.randomUUID ? crypto.randomUUID() : `file_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);
        const record = {
            id, filename, mimeType, blob, kind,
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

// tw_stock_db客製: 階段5——互動式viewer的persistentStorage（見計畫文件
// 階段5）。跟FileCache是同一種IndexedDB持久化精神，但存的是結構化的
// 鍵值狀態（例如viewer表單填了什麼），不是blob——單筆記錄很小，不需要
// FileCache那種LRU容量淘汰機制，這裡刻意保持精簡。key是字串（慣例上用
// "viewer:<namespace>"這種前綴避免不同用途互相覆蓋，但這個class本身
// 不強制），value是任意可JSON化的物件。
class KVStore {
    constructor(dbName) {
        this.dbName = dbName;
        this.storeName = 'kv';
        this.db = null;
        this._ready = this._init();
    }

    _init() {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open(this.dbName, 1);
            req.onupgradeneeded = (e) => {
                const db = e.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) db.createObjectStore(this.storeName, { keyPath: 'key' });
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

    async get(key) {
        const rec = await this._tx('readonly', s => s.get(key));
        return rec ? rec.value : undefined;
    }

    async set(key, value) {
        await this._tx('readwrite', s => s.put({ key, value, updatedAt: Date.now() }));
    }

    async delete(key) {
        await this._tx('readwrite', s => s.delete(key));
    }

    async getAll() {
        return this._tx('readonly', s => s.getAll());
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
// tw_stock_db客製: 2026-08-25使用者實測案例——推理模型（例如
// nemotron-3-super-120b-a12b）偶爾會在reasoning_content吐完一大段思考後
// 就自然觸發EOS，finish_reason回報'stop'（不是'length'），但content跟
// tool_calls都是空的，等於「想了一輪但沒有真的產出答案」，是死路而不是
// 正常完成——原本的自動接續機制只認finish_reason==='length'，這種情況
// 會被誤判成「這輪就是這樣，正常結束」，使用者只會看到「這一輪模型只
// 輸出了思考過程」的警告，而不是像length截斷一樣自動重試。這裡跟
// AI_AUTO_CONTINUE_PROMPT分開一個專用提示——因為這種情況沒有「上一段
// 未完成的內容」可以接續，用「請接續」語意上不通，要講清楚「你剛才只
// 想了沒有真的回答，現在請直接給答案」。
const AI_REASONING_DEADEND_PROMPT = '[系統提示] 你剛才那一輪只完成了內部思考，沒有輸出任何最終回覆內容、也沒有呼叫任何工具。請現在直接給出最終答案或呼叫需要的工具，不用重複或摘要你剛才想過的內容，也不要再次陷入純思考而不輸出結果。';

// tw_stock_db客製: sub agent委派框架（delegate_to_subagent工具）的domain
// 註冊表——刻意寫死每個domain能用的工具子集+專屬system prompt（不像
// 通用的_runSubAgentTask那樣預設能看到全部工具），理由見計畫文件：
// domain專屬工具的使用guidance是跟該domain專屬system prompt綁在一起設計
// 的，開放任意組合等於要求每個工具都要能配合任何system prompt，複雜度
// 不成比例。目前只有rag_lookup是真正啟用的驗證用domain，其餘（
// file_analysis/drawing/scene_3d/interactive_component）留給後續階段
// 各自加入工具子集時才把enabled改成true——未啟用的domain呼叫時直接回報
// 「尚未實作」，不是crash。
//
// 2026-09-05使用者明確要求的設計原則（後續階段新增domain時都要遵守）：
// 「domain主功能的tool的暴露保持為主體，並將核心功能註冊分段，省token以
// 避免注意渙散與幻覺發生」——跟get_tool_details（文字協定下只列名稱+極短
// 摘要，完整規格按需查詢）跟redmine參考文件§13.6（render_3d_scene自己的
// description只留最常用欄位，texture/particles/polygon/defs這類進階主題
// 移出去用get_3d_scene_topic(topic)按需查）是同一個精神。後續階段（尤其
// file_analysis要對付十幾種檔案格式、scene_3d要涵蓋粒子/貼圖/defs等進階
// 主題）新增toolNames時，每個domain應該只暴露1-2個「主功能」工具（名稱+
// 描述要精簡，只講最常用的核心用法），任何進階/次要的參數細節或次要能力
// 一律包成domain自己的get_xxx_topic(topic)這類按需查詢工具，不要把所有
// 細節一次攤平進主工具的description或一次註冊一大排工具——目的是讓被委派
// 的子任務system prompt/tools schema本身保持精簡，不會因為工具描述太長
// 稀釋掉模型的注意力、增加幻覺機率。
const SUBAGENT_DOMAIN_REGISTRY = {
    rag_lookup: {
        enabled: true,
        label: 'RAG知識圖譜查詢',
        toolNames: ['rag_query_graph'],
        systemPrompt: '你是一個專門查詢RAG知識圖譜的子任務助理。使用者會給你一個查詢需求，你只能使用rag_query_graph工具查詢知識圖譜，查到結果後直接用一段精簡的文字總結回答，不要輸出多餘的寒暄或重複問題本身。如果查無相關記錄，直接明講查無資料，不要編造答案。',
    },
    file_analysis: {
        enabled: true,
        label: '檔案解讀分析',
        toolNames: ['list_uploaded_files', 'parse_uploaded_file'],
        systemPrompt: '你是一個專門解讀使用者上傳檔案的子任務助理。先用list_uploaded_files確認可用的file_id（如果使用者訊息裡已經明確給了file_id可以跳過這步），再用parse_uploaded_file取得內容；如果是壓縮檔（zip/tar/tgz）先看entries清單，需要看特定檔案內容時再帶entry_path重新呼叫一次。根據使用者的實際需求（摘要/找特定資訊/檢查格式問題等）用一段精簡文字回答，不要把整份原始內容整段貼回去。',
    },
    drawing: {
        enabled: true,
        label: '通用繪圖',
        toolNames: ['render_drawing'],
        systemPrompt: '你是一個專門畫向量圖（流程圖、示意圖、圖表、插畫等）的子任務助理，用render_drawing工具輸出SVG原始碼給使用者看。這不是股票K線圖表工具。SVG會被自動消毒過濾掉script/事件屬性，所以只能用純圖形元素（path/rect/circle/line/text等）表達，不能靠內嵌JS互動。畫完後只需要一兩句話簡短說明，不用重複整份SVG原始碼。',
    },
    scene_3d: {
        enabled: true,
        label: '3D場景設計',
        toolNames: ['render_3d_scene', 'get_3d_scene_topic', 'get_3d_scene_yaml', 'import_3d_model_attachment', 'list_uploaded_files'],
        systemPrompt: '你是一個專門設計/繪製3D場景的子任務助理，用render_3d_scene渲染純宣告式YAML描述的3D場景給使用者看（絕對不能輸出真正會執行的JavaScript程式碼，場景格式是固定字彙的宣告式YAML）。不確定texture/particles/polygon/defs這幾個進階主題的欄位格式時，先呼叫get_3d_scene_topic查詢，不要用猜的；如果使用者是要求「調整/修改」既有場景，先呼叫get_3d_scene_yaml取得目前真正的內容再基於它修改，絕對不要憑對話記憶重新編寫一份、也不要虛構任何場景網址。渲染完成後只需要用一兩句話簡短說明做了什麼，不用重複整份YAML內容。',
    },
    interactive_component: {
        enabled: true,
        label: '互動元件生成',
        toolNames: ['render_interactive_viewer', 'get_interactive_viewer_yaml', 'get_viewer_state', 'set_viewer_state'],
        systemPrompt: '你是一個專門設計多頁互動表單/精靈/教學畫面的子任務助理，用render_interactive_viewer渲染純宣告式YAML描述的viewer給使用者看（絕對不能輸出真正會執行的JavaScript程式碼，viewer格式是固定字彙的宣告式YAML，visible_if/enabled_if只能用有限的安全表達式）。修改既有viewer前先呼叫get_interactive_viewer_yaml取得目前真正的內容，不要憑記憶重新編寫。渲染完成後只需要一兩句話簡短說明，不用重複整份YAML內容。',
    },
};

// tw_stock_db客製: delegate_to_subagent委派出去的子任務迴圈輪數上限——
// 瀏覽器端沒有redmine版本「佔用共用伺服器執行緒」的限制，不需要照抄它的
// 8輪硬上限，但仍要有一個寬鬆但存在的上限純粹防止端點異常/模型跳針造成
// 無限迴圈燒費用，量級比照既有MAX_AUTO_CONTINUE_ROUNDS（40）思路，這裡
// 取一半——委派任務通常比「接續被截斷的單一回覆」更早能有結論，20輪已經
// 相當寬裕。
const SUBAGENT_DELEGATE_MAX_ROUNDS = 20;

// tw_stock_db客製: 共用的「安全表達式」白名單函式表——階段3自訂粒子preset
// 的init/update/output公式、階段5互動viewer的visible_if/enabled_if都用
// 同一套expression evaluator（見_compileSafeExpression）。這是一個固定、
// 封閉的JS物件，運算式文字本身永遠沒有任何管道能新增/覆寫/繞過這張表、
// 也沒有任何語法能存取這張表以外的任何東西（沒有DOM/window、沒有任意
// 函式呼叫）——不是用eval/new Function實作，是手刻的遞迴下降parser把
// 每段運算式編譯成一串closure，呼叫時只會呼叫到這裡列出的純函式。
// random()是唯一有非決定性副作用的例外（給粒子初始化亂數用），其餘全是
// 無副作用的Math包裝。
const SAFE_EXPR_FUNCTIONS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan, atan2: Math.atan2,
    sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    min: Math.min, max: Math.max, pow: Math.pow,
    mod: (a, b) => a % b,
    clamp: (v, lo, hi) => Math.min(hi, Math.max(lo, v)),
    lerp: (a, b, f) => a + (b - a) * f,
    random: () => Math.random(),
    pi: () => Math.PI,
};

// tw_stock_db客製: 階段3——3D場景YAML格式的資源上限，跟計畫文件/redmine
// 參考文件的§13.5同一組數字（MAX_EXPANDED_NODES=500）；粒子上限一般
// preset是2000、nbody因為是真正O(n²)互相引力運算，額外壓低到60（見
// _buildNBodyParticles的說明），這裡只在client端驗證（沒有伺服器端，
// 見計畫文件——redmine版本的驗證原本在Ruby伺服器端，這裡整個搬到瀏覽器
// 端做，行為一致）。
const SCENE3D_MAX_EXPANDED_NODES = 500;
const SCENE3D_MAX_PARTICLE_COUNT = 2000;
const SCENE3D_MAX_NBODY_PARTICLE_COUNT = 60;
// tw_stock_db客製: 2026-09-05——STL/OBJ/3MF/FBX匯入轉成的polygon節點若
// 三角形數量超過這個上限直接拒絕（見_convertModelFileToSceneYaml），
// 理由：YAML用逐頂點座標的文字表示法，高面數CAD/掃描模型直接嵌入會讓
// 檔案暴增到不合理的大小，也會拖垮CPU軟體光柵化fallback的每幀效能——
// 5000三角形大致涵蓋一般3D列印/簡單模型的量級，掃描級/工業CAD等級的
// 高面數模型不在這次支援範圍內。
const SCENE3D_MAX_IMPORTED_MESH_TRIANGLES = 5000;
const SCENE3D_MESH_TYPES = new Set(['box', 'sphere', 'cylinder', 'cone', 'plane', 'torus', 'polygon', 'particles']);
const SCENE3D_ANIMATION_TYPES = new Set(['spin', 'bounce', 'orbit']);
const SCENE3D_PARTICLE_PRESETS = new Set(['spark', 'flame', 'mist', 'bounce', 'firework', 'nbody']);

// tw_stock_db客製: 階段5——互動viewer的封閉元件字彙（跟3D場景的
// SCENE3D_MESH_TYPES同一個精神：固定、封閉，不是任意HTML/JS）。
const VIEWER_COMPONENT_TYPES = new Set(['text', 'input', 'button', 'subagent_panel']);
const VIEWER_INPUT_TYPES = new Set(['text', 'number', 'select', 'checkbox', 'textarea']);
const VIEWER_ACTION_KINDS = new Set(['next_page', 'prev_page', 'goto_page', 'save_state', 'run_subagent', 'close']);

// tw_stock_db客製: render_3d_scene自己的:description只留最常用欄位（見
// 該工具註冊處），texture/particles/polygon/defs這四個進階主題移出來
// 用get_3d_scene_topic(topic)按需查詢——跟計畫文件記錄的使用者要求
// 一致（「主功能工具保持精簡、核心功能註冊分段」），也是redmine參考
// 文件§13.6同樣的分層說明模式。
const SCENE3D_TOPIC_DOCS = {
    texture: '材質貼圖（放在node.material底下）：texture:"water"（內建具名程序貼圖，目前有water/grass/sand/wood/brick五種，沒對到已知名稱會退回grass，不是照片、是手繪花紋）+texture_repeat:[rx,ry]（貼圖重複次數，例如[10,6]）；texture也可以直接給http(s)網址或data:開頭的base64圖片當自訂貼圖（此時texture_repeat/texture_uv_offset/texture_uv_scale一樣適用）。舊版欄位texture_url/texture_data_url+texture_uv_scale仍相容，但新場景建議直接用texture欄位＋texture_repeat。注意：WebGL初始化失敗時的CPU軟體光柵化fallback不支援貼圖取樣，會退化成純色近似，這是已知取捨。',
    particles: '粒子節點：{mesh:"particles", position:[x,y,z], particle_preset:"...", particle_count:200, material:{color,color2}}——preset/count/其他額外參數（例如particle_spread）建議直接攤平寫在node底下（用particle_前綴，例如particle_spread、particle_gravity），跟position/material同一層，不用包一層particles物件（舊版巢狀寫法particles:{preset,count,...}仍相容，兩者可以並存，衝突時以巢狀寫法為準）；color/color2建議放在material底下（跟其他mesh類型的material.color一致），也支援直接放在particles/攤平參數裡。六種內建preset：spark（火花噴發，額外欄位gravity）、flame（火焰，額外欄位spread/rise_speed/sway）、mist（煙霧/冷氣出風口，跟flame同機制只是較慢較廣較淡）、bounce（不停彈跳的球，額外欄位amplitude/frequency/spread）、firework（夜空煙火，額外欄位cycle）、nbody（真正O(n²)相互重力模擬，額外欄位g/softening，count上限只有60，比其他preset的2000低很多）。count超過各自preset的上限會直接被render_3d_scene拒絕。除了六種內建preset，也可以在scene.particle_presets自己註冊全新的preset（用安全表達式公式描述動畫邏輯，不是JS程式碼）——完整格式見get_3d_scene_topic("particle_presets")。',
    polygon: 'polygon節點格式：{mesh:"polygon", vertices:[[x,y,z],...], faces:[[i,j,k],...]}（faces選填，三角形頂點index清單；不給的話用簡單扇形三角化，假設vertices依序繞邊界排列）。用來表達沒有對應固定圖元的自訂形狀（例如傾斜懸挑的屋頂），沒有stairs/chair這類複雜mesh，一律用原語（含polygon）組合出來。',
    defs: 'defs是一組具名、可重複使用的節點群組：{defs:{樹:{nodes:[{mesh:...},{mesh:...}]}}}，頂層nodes陣列裡用{use:"樹", position:[x,y,z], scale:n}實例化一次（套用位移position+等比縮放scale，縮放同時套用到子節點的position/size/radius/height）。刻意不支援巢狀（defs底下的節點自己不能再use另一個defs），展開後全部節點總數不能超過500，超過會被render_3d_scene拒絕。',
    particle_presets: '在scene頂層新增particle_presets可以自己註冊全新的粒子動畫preset，讓動畫邏輯寫在場景YAML本身（portable），不是只能用六選一的內建preset。格式：{particle_presets:{我的preset名:{count_default:200, init:{變數名:"安全表達式"}, update:{變數名:"安全表達式"}, output:{x:"...",y:"...",z:"...",r:"...",g:"...",b:"...",alive:"...(選填)"}}}}。三個階段：init（粒子誕生/重生時算一次，例如隨機初速度）、update（每幀先跑，可更新自訂狀態變數）、output（每幀算出最終x/y/z（世界座標）與r/g/b（0~1顏色），選填的alive決定是否要重生，通常寫成"age < life"這種條件）。運算式語法：算術(+-*/%)、比較(==!=<<=>>=)、布林(&&||!)、括號、數字/字串/true/false/null字面值、對context變數的讀取（可以讀base_x/base_y/base_z（發射原點）、age（這個粒子存活了多久，秒）、t（場景經過的總時間，秒）、dt（每幀時間差，通常1/60）、以及init/update自己定義過的任何變數名）、以及呼叫白名單數學函式：sin/cos/tan/atan2/sqrt/abs/floor/ceil/round/min/max/pow/mod/clamp/lerp/random/pi——絕對不能寫真正的JS程式碼、不能呼叫這份白名單以外的任何函式、不能存取DOM/window，語法上就不存在這些管道，不是黑名單擋。particles節點用particle_preset:"我的preset名"（或巢狀particles:{preset:"我的preset名"}）指向這個自訂preset，count/size等欄位用法跟內建preset一樣。',
};

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
// 重複網路成本。使用者自訂的模型（不在這份表裡）不受影響，一樣照原本的
// 邏輯即時探測。
// 2026-08-25修正：原本這裡把nvidia/nemotron-3-super-120b-a12b跟
// meta/llama-3.3-70b-instruct都寫死false，但兩者的false都是探測本身的
// bug造成的偽陰性，不是真的不支援——見_probeNativeToolSupport()的說明，
// 原本max_tokens只給50、逾時只給15秒，對「先吐一大段reasoning_content
// 才輸出tool_calls」的推理模型（nemotron-120b）或回應本來就慢的模型
// （llama-3.3-70b，這裡舊註解本來就寫「探測逾時、無法確認」）幾乎必定
// 測不出真正結果。使用者實測NVIDIA官方範例證實nemotron-120b確實支援原生
// tool_calls，修好探測本身（放寬到4096 tokens+45秒）之後，這兩個模型
// 改成不寫死在這份表裡，讓它們用修正後的探測邏輯重新測一次、把真正結果
// 存回快取（見NATIVE_TOOL_SUPPORT_CACHE_KEY版本號同步往上加一層，確保
// 不會沿用舊探測留下的錯誤快取值）。
const PRESET_MODEL_TOOLCALL_SUPPORT = {
    'nvidia/nemotron-3.5-lightning-30b-a3b': true,
    'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning': true,
    'nvidia/nemotron-3-nano-30b-a3b': false,
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
// tw_stock_db客製: 2026-08-28使用者要求——floating-assistant.js匯出PPTX/PDF/
// markdown渲染用到的所有外部函式庫（pptxgenjs/pdfmake/CJK字型/marked/
// DOMPurify/KaTeX/JSZip）原本全部寫死指向公開CDN，使用者希望PPT/PDF等匯出
// 功能不要依賴CDN的存活與否，要能vendor一份到host頁面自己的網域下、由
// host頁面覆寫這裡的網址。這裡集中成一個可被覆寫的設定物件（預設值仍然是
// 原本的CDN網址，讓floating-assistant.js單獨拿去別的專案用時，不需要
// 額外設定就能照樣運作——這是它原本「通用聊天widget，不綁定特定host」的
// 設計精神，見檔案開頭說明），host頁面（例如這個專案的index.html）載入
// floating-assistant.js之後、在new FloatingAssistant()之前，呼叫
// FloatingAssistant.setAssetUrls({...})覆寫成自己vendor的路徑即可，未覆寫
// 的鍵值保留預設CDN網址（部分覆寫也支援，不用整包重寫）。
const FA_ASSET_URLS = {
    pptxgenjs: 'https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js',
    pdfmake: 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.9/pdfmake.min.js',
    pdfmakeFonts: 'https://cdnjs.cloudflare.com/ajax/libs/pdfmake/0.2.9/vfs_fonts.js',
    // Noto Sans TC「繁體中文」子集，透過jsDelivr的fontsource鏡像取得TTF——
    // pdfmake內建字型（Roboto）完全沒有中文字圖，不額外載入的話中文會整段
    // 變成豆腐字方塊。
    cjkFontRegular: 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-tc@latest/chinese-traditional-400-normal.ttf',
    cjkFontBold: 'https://cdn.jsdelivr.net/fontsource/fonts/noto-sans-tc@latest/chinese-traditional-700-normal.ttf',
    marked: 'https://cdnjs.cloudflare.com/ajax/libs/marked/12.0.2/marked.min.js',
    dompurify: 'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.1.6/purify.min.js',
    katexJs: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.js',
    // katex.min.css用相對路徑url(fonts/xxx)引用字型檔，覆寫這個網址時要指向
    // 一個「同目錄下也放著對應fonts/資料夾」的位置，不能只換CSS本身的網址
    // （見web/vendor/katex/README.md的說明）。
    katexCss: 'https://cdnjs.cloudflare.com/ajax/libs/KaTeX/0.16.11/katex.min.css',
    jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    // tw_stock_db客製: 階段2（檔案解析sub agent）跟階段3（3D場景YAML描述）
    // 共用同一份js-yaml，理由跟redmine參考版本一致（見計畫文件）——同一個
    // vendored版本兩處共用，不重複vendor兩份。
    jsyaml: 'https://cdnjs.cloudflare.com/ajax/libs/js-yaml/4.1.0/js-yaml.min.js',
    // tw_stock_db客製: 階段3（3D場景viewer）——固定用舊式global-attaching
    // build（r128，非ES module），因為要靠<script>依序載入
    // three.min.js→OrbitControls.js讓後者透過window.THREE直接掛上
    // THREE.OrbitControls，跟其餘vendored函式庫（marked/pdfmake等）同一種
    // 載入模式一致，不用額外處理ES module的import graph。
    threejs: 'https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js',
    threeOrbitControls: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/controls/OrbitControls.js',
    // tw_stock_db客製: 2026-09-05使用者要求支援上傳STL/OBJ/3MF/FBX並轉成
    // 內部3D場景YAML顯示——直接用three.js官方addon loader解析（同一個r128
    // 版本、同樣是舊式global-attaching build），比自己手刻四種格式的解析器
    // 可靠很多，尤其FBX的二進位/ASCII雙格式規格複雜，官方loader已經是
    // 經過大量真實檔案驗證過的實作。fflate是FBXLoader解析壓縮/二進位FBX
    // 用的相依套件，只有真的匯入FBX時才會載入。
    threeSTLLoader: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/STLLoader.js',
    threeOBJLoader: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/OBJLoader.js',
    three3MFLoader: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/3MFLoader.js',
    threeFBXLoader: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/loaders/FBXLoader.js',
    threeFflate: 'https://cdn.jsdelivr.net/npm/three@0.128.0/examples/js/libs/fflate.min.js',
};
function _faSetAssetUrls(overrides) {
    Object.assign(FA_ASSET_URLS, overrides || {});
}
// tw_stock_db客製: 2026-09-05使用者要求（計畫文件階段3的「已完成的部分」
// 項目3）——PPTX匯出的視覺識別要換成適合這個台股專案的風格，不要沿用
// redmine參考版本的Insyde品牌配色。這裡選深藏青（信任/專業，金融業常見
// 基調色）+金色（股票代碼機常見的暖色點綴，呼應「台股」語境），不是隨便
// 換一個顏色——navy/accent兩色刻意保持強烈明暗對比，其餘皆為輔助中性色。
const FA_EXPORT_PALETTE = { navy: '0B1E3D', accent: 'C9A227', accentDark: '8A6E17', txt: '333333', muted: '888888', border: 'DDDDDD', tileGray: 'F5F6FA', white: 'FFFFFF' };

// tw_stock_db客製: 標題投影片背景——不用靜態圖片檔案（這個專案沒有伺服器
// 附件系統可以vendor圖片資源，見計畫文件對texture_attachment_id的說明，
// 同樣的限制在這裡也適用），改成在匯出當下用canvas程序生成一張淡淡的
// 股價走勢面積圖當背景紋理（深藏青漸層底色+低透明度的金色走勢線+填色），
// 呼應「台股」主題但不會蓋過上面疊的標題文字。只在真的要匯出標題投影片
// 時才呼叫，不是每次載入都要背這個運算成本。
function _faGeneratePptxTitleBackgroundDataUri() {
    const w = 1280, h = 720;
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, '#0B1E3D');
    grad.addColorStop(1, '#16305C');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    const n = 24;
    const points = [];
    let y = h * 0.62;
    for (let i = 0; i <= n; i++) {
        y += (Math.sin(i * 0.7) + (Math.random() - 0.5)) * 14;
        y = Math.max(h * 0.45, Math.min(h * 0.8, y));
        points.push({ x: (i / n) * w, y });
    }
    // tw_stock_db客製: 第一版純色低透明度填色在深藏青底色上會被吃成灰藍色，
    // 完全看不出「金色」——改用由淡轉濃的垂直漸層填色（越靠底部越實色），
    // 讓面積圖底部有足夠彩度撐住金色，頂部邊緣仍維持淡出、不搶標題文字。
    const fillGrad = ctx.createLinearGradient(0, h * 0.4, 0, h);
    fillGrad.addColorStop(0, 'rgba(201,162,39,0.05)');
    fillGrad.addColorStop(1, 'rgba(201,162,39,0.4)');
    ctx.beginPath();
    ctx.moveTo(0, h);
    points.forEach(p => ctx.lineTo(p.x, p.y));
    ctx.lineTo(w, h);
    ctx.closePath();
    ctx.fillStyle = fillGrad;
    ctx.fill();

    ctx.strokeStyle = '#F0C94D';
    ctx.lineWidth = 3;
    ctx.beginPath();
    points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
    ctx.stroke();
    return canvas.toDataURL('image/png');
}

// tw_stock_db客製: 2026-08-28使用者要求把匯出用的外部函式庫vendor到自己的
// GitHub repo（見FA_ASSET_URLS），vendor完之後瀏覽器實測發現一個重要限制：
// raw.githubusercontent.com（vendor資源放置處）每個檔案的回應一律帶
// `Content-Type: text/plain` + `X-Content-Type-Options: nosniff`，這是
// GitHub刻意的安全設計（避免raw.githubusercontent.com被當成公開JS/CSS CDN
// 濫用），瀏覽器看到nosniff+非JS/CSS的MIME類型時，會直接拒絕把回應內容
// 當<script>/<link rel=stylesheet>執行/套用——長期不會改變，不是暫時性
// 問題。實測驗證：對同一個網址直接用<script src=...>四連發全部失敗，改用
// fetch()卻100%成功（fetch()本身不受回應MIME類型限制，單純把回應當
// bytes/text處理）。字型(@font-face url())不受這個限制影響，不需要處理。
//
// 解法：fetch()抓下內容→包成Blob（自己指定正確的MIME type，不理會伺服器
// 回應的Content-Type）→用Blob URL當<script src>/<link href>，繞過nosniff
// 限制。sql.js本身的wasm是initSqlJs內部自己走fetch機制載入（不是
// <script>/<link>），不受影響，不需要處理（見index.html的initSqlJs呼叫）。
const _faExportScriptCache = new Map();
function _faLoadScriptOnce(url) {
    if (_faExportScriptCache.has(url)) return _faExportScriptCache.get(url);
    const p = fetch(url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(text => new Promise((resolve, reject) => {
            const blob = new Blob([text], { type: 'application/javascript' });
            const blobUrl = URL.createObjectURL(blob);
            const s = document.createElement('script');
            s.src = blobUrl;
            s.onload = () => { URL.revokeObjectURL(blobUrl); resolve(); };
            s.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error(`匯出功能所需的外部程式庫執行失敗：${url}`)); };
            document.head.appendChild(s);
        }))
        .catch(e => { _faExportScriptCache.delete(url); throw new Error(`匯出功能所需的外部程式庫載入失敗：${url}（${e.message}）`); });
    _faExportScriptCache.set(url, p);
    return p;
}

// katex.min.css用相對路徑url(fonts/xxx)引用字型檔，Blob URL沒有「目錄」
// 概念、相對路徑解析會全部失效，這裡在包成Blob之前，先把CSS內容裡的
// 相對路徑改寫成絕對網址（rewriteBaseUrl，指向katex vendor資料夾），字型
// 本身不受nosniff限制（見上方說明），可以直接指向raw.githubusercontent.com。
// elementId選填：因為套用的是Blob URL，href不會再帶原始網址的字樣，呼叫端
// 沒辦法再用「href包含某關鍵字」去判斷「這個樣式表是不是已經套用過」，改成
// 由這裡直接把id設在建立出來的<link>上，呼叫端改用document.getElementById
// 判斷即可（見_ensureMarkdownLibsLoaded的katex.min.css用法）。
function _faLoadStyleOnce(url, rewriteBaseUrl, elementId) {
    const cacheKey = 'style:' + url;
    if (_faExportScriptCache.has(cacheKey)) return _faExportScriptCache.get(cacheKey);
    const p = fetch(url)
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(text => {
            if (rewriteBaseUrl) {
                text = text.replace(/url\((?!['"]?(?:https?:|data:|blob:))(['"]?)([^'")]+)\1\)/g, (m, q, path) => `url(${q}${rewriteBaseUrl}${path}${q})`);
            }
            return new Promise((resolve, reject) => {
                const blob = new Blob([text], { type: 'text/css' });
                const blobUrl = URL.createObjectURL(blob);
                const l = document.createElement('link');
                if (elementId) l.id = elementId;
                l.rel = 'stylesheet';
                l.href = blobUrl;
                l.onload = () => { URL.revokeObjectURL(blobUrl); resolve(); };
                l.onerror = () => { URL.revokeObjectURL(blobUrl); reject(new Error(`樣式表套用失敗：${url}`)); };
                document.head.appendChild(l);
            });
        })
        .catch(e => { _faExportScriptCache.delete(cacheKey); throw new Error(`樣式表載入失敗：${url}（${e.message}）`); });
    _faExportScriptCache.set(cacheKey, p);
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
            fetch(FA_ASSET_URLS.cjkFontRegular).then(r => { if (!r.ok) throw new Error('中文字型下載失敗'); return r.arrayBuffer(); }),
            fetch(FA_ASSET_URLS.cjkFontBold).then(r => { if (!r.ok) throw new Error('中文字型(粗體)下載失敗'); return r.arrayBuffer(); }),
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

// tw_stock_db客製: 2026-09-05使用者明確要求——對話中出現3D場景/互動viewer/
// 通用繪圖時，使用者把回覆匯出成PPTX（或PDF）也要能把這些視覺內容一併
// 放進去，不能只匯出文字。做法比照redmine參考文件PROMPT.md §13（見那邊
// 的rasterizeIfSvg說明）的精神——不管畫面/PDF/PPTX，最終都是「把視覺內容
// 轉成一張PNG圖片再嵌進去」，差別只在於這個無後端架構沒有伺服器附件URL可
// 抓，改成直接對這個對話輪次裡實際渲染過的DOM節點（3D canvas / SVG）
// 截圖，見FloatingAssistant.prototype._collectTurnVisualSnapshots/
// _captureVisualSnapshot。visualSnapshots是選填的{dataUrl,kind}陣列，
// 沒有提供時行為完全不變（純文字/表格投影片）。
function _faAppendVisualSnapshotSlides(pres, addHeadingSlideBase, visualSnapshots) {
    const KIND_LABEL = { image: '🖼️ 圖表', scene3d: '🧊 3D場景', drawing: '🎨 繪圖', viewer_summary: '📝 互動表單內容' };
    (visualSnapshots || []).forEach((snap) => {
        if (!snap) return;
        const s = addHeadingSlideBase(KIND_LABEL[snap.kind] || '視覺內容');
        try {
            // tw_stock_db客製: 互動viewer是文字摘要（kind==='viewer_summary'，
            // 見_summarizeViewerStateForExport），不是截圖——表單填寫內容用
            // 文字呈現比像素截圖更有報告價值。其餘kind都是dataUrl截圖。
            if (snap.kind === 'viewer_summary' && snap.text) {
                s.addText(_faMdLiteToPlainText(snap.text), { x: 0.6, y: 1.3, w: 12.1, h: 5.7, fontFace: 'Calibri', fontSize: 14, color: FA_EXPORT_PALETTE.txt, align: 'left', valign: 'top', lineSpacingMultiple: 1.3 });
            } else if (snap.dataUrl) {
                s.addImage({ data: snap.dataUrl, x: 1.5, y: 1.3, w: 10.3, h: 5.7, sizing: { type: 'contain', w: 10.3, h: 5.7 } });
            }
        } catch (_) { /* 個別截圖/摘要嵌入失敗不影響其餘投影片 */ }
    });
}

async function _faMarkdownToPptxBlob(markdownText, heading, visualSnapshots) {
    await _faLoadScriptOnce(FA_ASSET_URLS.pptxgenjs);
    const PptxGenJS = window.PptxGenJS;
    const pres = new PptxGenJS();
    pres.layout = 'LAYOUT_WIDE'; // 13.3"x7.5"，預設是10"寬的16x9，要先設過再addSlide
    pres.title = heading;

    const titleSlide = pres.addSlide();
    try {
        titleSlide.background = { data: _faGeneratePptxTitleBackgroundDataUri() };
    } catch (_) {
        titleSlide.background = { color: FA_EXPORT_PALETTE.navy }; // canvas生成失敗時的保底純色背景
    }
    titleSlide.addText(heading, { x: 0.8, y: 2.5, w: 11.7, h: 1.2, fontFace: 'Calibri', fontSize: 32, bold: true, color: FA_EXPORT_PALETTE.white, align: 'center' });
    titleSlide.addText(new Date().toLocaleDateString('zh-TW'), { x: 0.8, y: 3.7, w: 11.7, h: 0.5, fontFace: 'Calibri', fontSize: 14, color: FA_EXPORT_PALETTE.accent, align: 'center' });

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

    _faAppendVisualSnapshotSlides(pres, addHeadingSlideBase, visualSnapshots);

    return pres.write({ outputType: 'blob' });
}

async function _faMarkdownToPdfBlob(markdownText, heading, visualSnapshots) {
    await _faLoadScriptOnce(FA_ASSET_URLS.pdfmake);
    await _faLoadScriptOnce(FA_ASSET_URLS.pdfmakeFonts);
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

    // tw_stock_db客製: 3D場景/繪圖截圖同樣以圖片content item加進去（見
    // _faAppendVisualSnapshotSlides在PPTX那邊的說明，這裡是PDF版本）。
    // 互動viewer是文字摘要（kind==='viewer_summary'），不是截圖。
    const VISUAL_KIND_LABEL = { image: '🖼️ 圖表', scene3d: '🧊 3D場景', drawing: '🎨 繪圖', viewer_summary: '📝 互動表單內容' };
    (visualSnapshots || []).forEach((snap) => {
        if (!snap) return;
        content.push({ text: VISUAL_KIND_LABEL[snap.kind] || '視覺內容', style: 'h2' });
        try {
            if (snap.kind === 'viewer_summary' && snap.text) {
                content.push({ text: _faMdLiteToPlainText(snap.text), style: 'body' });
            } else if (snap.dataUrl) {
                content.push({ image: snap.dataUrl, width: 460, alignment: 'center' });
            }
        } catch (_) { /* 個別截圖/摘要嵌入失敗不影響其餘內容 */ }
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
    // tw_stock_db客製: 2026-08-28使用者要求——讓host頁面能在`new FloatingAssistant()`
    // 之前，把PPT/PDF/markdown渲染用到的外部函式庫網址（pptxgenjs/pdfmake/
    // CJK字型/marked/DOMPurify/KaTeX/JSZip，見FA_ASSET_URLS）覆寫成自己
    // vendor的路徑，讓這些匯出功能不依賴公開CDN的存活與否。只需要覆寫
    // 需要的鍵值（例如只換pptxgenjs跟pdfmake），沒覆寫的鍵值繼續用預設CDN
    // 網址，同一份floating-assistant.js單獨拿去別的專案用時不用額外設定
    // 也能照樣運作。用法：
    //   FloatingAssistant.setAssetUrls({
    //     pptxgenjs: 'https://your-host/vendor/pptxgenjs/pptxgen.bundle.js',
    //     katexCss: 'https://your-host/vendor/katex/katex.min.css', // 注意katexCss要跟fonts/資料夾放在一起，見web/vendor/katex/README.md
    //   });
    static setAssetUrls(overrides) {
        _faSetAssetUrls(overrides);
    }

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
        // 2026-08-25使用者實測發現NVIDIA官方範例證實nemotron-3-super-120b
        // 確實支援原生tool_calls，但這裡的探測請求原本max_tokens只給50——
        // 這個模型是推理模型，會先在reasoning_content吐一大段思考過程才
        // 輸出tool_calls（見_loopFetch/_loopFetchNative頂端關於
        // reasoning_content的說明），50 tokens幾乎必定在思考階段就被截斷，
        // 從沒機會真的輸出tool_calls，導致探測永遠回報false——不是模型真的
        // 不支援，是探測本身的bug。修好_probeNativeToolSupport後，舊版
        // 探測留在使用者localStorage裡的false快取不會自動失效（見
        // _ensureNativeToolSupportProbed：快取命中就不會重新探測），所以
        // 版本號往上加一層，讓所有人下次都重新測一次，不用手動清瀏覽器
        // 資料。
        this.NATIVE_TOOL_SUPPORT_CACHE_KEY = "floating_ai_native_tool_support_cache_v2";
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
        // tw_stock_db客製: 2026-08-24使用者要求的「主動要求建議操作」入口
        // ——跟建構子/清空對話時的自動插入（見insertSuggestionChipsMessage）
        // 共用同一個方法，這裡只是讓使用者隨時能重新叫出來，不用等對話清空。
        // 屬於「聊天widget本身」的通用指令（實際建議內容仍然來自
        // options.chipsProvider，不涉及任何tw_stock_db業務邏輯），所以是
        // 內建指令，不用像/collect-volrank那樣從index.html掛進來。
        this.register_slash_command(
            '/suggest', '',
            '重新顯示建議操作（例如換了股票之後想看新的建議）',
            () => this.insertSuggestionChipsMessage()
        );
        // tw_stock_db客製: 2026-09-05使用者要求——如果剛好附加了一個3D場景
        // YAML檔案（或最近上傳過），不用麻煩AI，直接用這個指令本地開啟
        // 顯示，完全不經過LLM/API呼叫。跟/benchmark-model同一種「屬於這個
        // 聊天widget本身、不涉及tw_stock_db業務邏輯」的內建指令。
        this.register_slash_command(
            '/view-3d-attachment', '',
            '如果目前輸入框旁邊有附加、或最近上傳過3D場景YAML檔案，直接在對話中開啟顯示（不經過AI）',
            () => this._handleViewAttachedSceneCommand()
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
        // tw_stock_db客製: 階段5——互動viewer的結構化狀態儲存（見KVStore/
        // 計畫文件階段5），跟fileCache一樣依mount實例分開資料庫。
        this.stateStore = new KVStore('FloatingAssistantState_' + ragDbSuffix);
        // tw_stock_db客製: 階段2——使用者按📎附件按鈕選好、還沒送出訊息前的
        // 暫存附件清單（見_wireAttachmentUpload/_submitChatInput），送出當下
        // 才把檔名+file_id接進使用者訊息文字並清空。
        this._pendingAttachments = [];
        this._initUI();
        this._initEventListeners();
        this._registerBuiltinAiTools();
        // tw_stock_db客製: 只在「完全沒有對話紀錄」時（全新安裝、或上次
        // 結束時剛好是空的）主動插入一次建議操作訊息，不要每次mount都插入
        // ——this.messages在上面_loadPersistedChatHistory()已經還原過，這裡
        // 看到的長度就是使用者實際的對話狀態。見insertSuggestionChipsMessage()
        // 的說明。
        if (!this.messages.length) this.insertSuggestionChipsMessage();
    }

    setSystemPrompt(prompt) {
        this.baseSystemPrompt = prompt;
        this._refreshSystemPromptMessage();
        return this; 
    }

    // tw_stock_db客製: 2026-08-26使用者實測發現的真實回歸——把
    // nemotron-3-super-120b-a12b修好切到原生tool_calls模式後（見
    // PRESET_MODEL_TOOLCALL_SUPPORT/_probeNativeToolSupport的說明），
    // render_stock_chart的markers/lines/indicators/range這類陣列/物件
    // 參數突然整批消失——原因是_buildNativeToolsSchema()原本對所有工具
    // 一律回傳空白的{type:'object',properties:{},additionalProperties:true}
    // schema，完全沒有逐欄位型別資訊，模型沒有訊號知道這些參數該是原生
    // 陣列/物件，於是自己決定用JSON字串包一層送出來（例如
    // {"indicators":"[\"macd\",\"rsi\"]"}而不是{"indicators":["macd","rsi"]}），
    // handler裡的Array.isArray()檢查全部落空、靜靜退回空陣列。文字式
    // [CALL:...]協定沒有這個問題，是因為它在system prompt裡有明確的JSON
    // 範例（見_getFinalSystemPrompt的TOOL CALL PROTOCOL段落）引導模型
    // 直接生成巢狀結構的文字，不受這裡schema缺失的影響——這正是使用者
    // 要求「確認native跟text based的工具註冊與支援度要一樣」的落差所在。
    // 這裡新增可選的第4個參數parametersSchema，讓呼叫端（index.html的
    // registerAiCapabilities）可以傳入逐欄位型別的JSON Schema，
    // _buildNativeToolsSchema()優先使用它；沒有提供時維持原本的opaque
    // schema（向下相容，不影響只用3個參數呼叫的既有builtin工具）。
    register_openai_tool(name, description, callback, parametersSchema) {
        this.tools[name] = { description, callback, parametersSchema };
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
            // tw_stock_db客製: 使用者要求「中間tool call tracing跟thinking都要
            // 可以用齒輪開關決定是否顯示，預設改成隱藏，使用者只應該在乎最終
            // 結果」——這個開關預設false（隱藏），跟slashCommandMenuEnabled
            // 預設true的方向刻意相反，見_renderSingleMessage()裡實際套用這個
            // 開關的四個位置（原生tool_calls摺疊卡、文字式[CALL:...]摺疊卡、
            // tool結果/系統上下文摘要摺疊卡、思考過程摺疊卡）。圖片型tool結果
            // （🖼️ 圖表截圖）不受這個開關影響，一律顯示。
            showInternalTrace: false,
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
            showInternalTrace: raw.showInternalTrace === true,
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

        // tw_stock_db客製: 2026-08-25使用者要求——文字式[CALL:...]協定模型
        // （目前最明顯是nvidia/nemotron-3-super-120b-a12b，NVIDIA NIM端點對它
        // 的原生tool_calls支援探測結果是false，見PRESET_MODEL_TOOLCALL_SUPPORT
        // 說明，被迫走文字協定）原本每一輪對話都要把全部已註冊工具（目前38個）
        // 的完整說明+參數JSON攤平進system prompt，量測起來高達約11,450字
        // （光是export_document跟render_stock_chart兩個就佔了近4,000字）——
        // 這正是使用者實測「模型越換越大顆反而越容易幻覺」的根因之一：不是
        // 單純「context太大」，而是文字協定把所有工具的完整規格用自然語言
        // 攤開，模型必須從這一大段文字裡精確記住每個工具的確切名稱/參數
        // 格式，再手打出語法正確的呼叫，比原生API的結構化schema容易出錯
        // 得多。解法：文字協定模式下，system prompt裡只列「名稱+極短摘要」
        // （見_getFinalSystemPrompt()/_summarizeToolDescription()），這個
        // get_tool_details就是對應的「按需查詢」入口——模型要呼叫一個不熟悉
        // 的工具之前，先呼叫這個查出它完整的描述+參數格式，不用猜的。
        // 原生tool_calls模式完全不受影響：那個路徑本來就用
        // _buildNativeToolsSchema()把完整工具清單透過API的tools參數結構化
        // 傳給模型，不會被這裡的「文字協定清單縮減」影響，模型也不需要呼叫
        // 這個工具（結構化schema裡本來就看得到完整參數）。
        this.register_openai_tool('get_tool_details',
            '查詢一個或多個工具的完整說明（用途、每個參數的確切名稱與格式）。上面工具清單裡其他項目為了節省篇幅只列出名稱跟極短摘要，呼叫任何不熟悉的工具之前，務必先呼叫這個工具查出它完整的參數規格，不要自己憑印象/猜測參數名稱或格式。參數: {"names":["工具名稱1","工具名稱2",...]}（可以一次查多個）',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const names = Array.isArray(parsed.names) ? parsed.names
                    : (typeof parsed.names === 'string' ? [parsed.names] : []);
                if (!names.length) return JSON.stringify({ ok: false, error: '缺少names參數（工具名稱陣列，例如{"names":["get_price_history"]}）' });
                const entries = this._getCombinedToolEntries();
                const found = {}, notFound = [];
                for (const name of names) {
                    const entry = entries.find(([n]) => n === name);
                    if (entry) found[name] = entry[1].description;
                    else notFound.push(name);
                }
                return JSON.stringify({ ok: true, tools: found, notFound: notFound.length ? notFound : undefined });
            },
            { type: 'object', properties: { names: { type: 'array', items: { type: 'string' }, description: '要查詢的工具名稱清單' } }, additionalProperties: false }
        );

        // tw_stock_db客製: sub agent委派框架的入口工具（見計畫階段1）。刻意
        // 不把delegate_to_subagent自己放進任何domain的toolNames子集裡——
        // 委派出去的子任務迴圈看不到這個工具，沒辦法再往下委派，避免無限
        // 遞迴。description刻意精簡（只列domain名稱+一行用途），不逐一展開
        // 每個domain底下實際有哪些工具/怎麼用，呼應上面SUBAGENT_DOMAIN_REGISTRY
        // 的註解說明的「主功能工具保持精簡」原則。
        this.register_openai_tool('delegate_to_subagent',
            '把一個任務委派給指定領域的專家子agent處理，子agent只能使用該領域的專屬工具、用專屬system prompt獨立跑完整個對話後只回傳最終結論（過程不會顯示在主對話）。domain目前可用: ' +
            Object.entries(SUBAGENT_DOMAIN_REGISTRY).filter(([, d]) => d.enabled).map(([k, d]) => `${k}(${d.label})`).join('、') +
            '。參數: {"task":"要委派的任務描述","domain":"領域代號"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const task = String(parsed.task || '').trim();
                const domainKey = String(parsed.domain || '').trim();
                if (!task) return JSON.stringify({ ok: false, error: '缺少task參數（要委派的任務描述）' });
                return JSON.stringify(await this._delegateToSubagentDomain(domainKey, task));
            },
            { type: 'object', properties: {
                task: { type: 'string', description: '要委派給子agent的任務描述' },
                domain: { type: 'string', description: '領域代號，例如rag_lookup' },
            }, required: ['task', 'domain'], additionalProperties: false }
        );

        // tw_stock_db客製: 階段2——persistentStorage檔案上傳+解析（見計畫文件
        // 階段2、_parseUploadedFileContent的說明）。只暴露兩個主功能工具
        // （列出/解析），每個格式的細節解析邏輯藏在_parseUploadedFileContent
        // 內部依副檔名分派，不對AI逐一展開每種格式怎麼解析——呼應
        // SUBAGENT_DOMAIN_REGISTRY註解說的「主功能工具保持精簡」原則。
        this.register_openai_tool('list_uploaded_files',
            '列出使用者透過📎附件按鈕上傳、目前還在快取中的檔案清單（不含AI自己產生的匯出檔）。無參數。',
            async () => {
                try {
                    const all = await this.fileCache.getAll();
                    const uploaded = all.filter(r => r.kind === 'uploaded')
                        .map(r => ({ file_id: r.id, filename: r.filename, sizeBytes: r.sizeBytes, uploadedAt: r.createdAt }));
                    return JSON.stringify({ ok: true, files: uploaded });
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
            },
            { type: 'object', properties: {}, additionalProperties: false }
        );

        this.register_openai_tool('parse_uploaded_file',
            '解析一個已上傳檔案的內容，依副檔名自動判斷格式（csv/xlsx/js/json/txt/markdown/yaml/docx/pptx/toon/cfg/inf/ini/log/zip/tar/tgz都支援）。壓縮檔（zip/tar/tgz）預設只回傳內含項目清單，要看特定項目的實際內容再帶entry_path指定。參數: {"file_id":"...", "entry_path":"（選填，僅壓縮檔用）"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const fileId = String(parsed.file_id || '').trim();
                if (!fileId) return JSON.stringify({ ok: false, error: '缺少file_id參數（用list_uploaded_files查詢可用的file_id）' });
                const record = await this.fileCache.get(fileId);
                if (!record || record.kind !== 'uploaded') {
                    return JSON.stringify({ ok: false, error: `找不到上傳檔案 file_id=${fileId}（可能已被淘汰或這不是使用者上傳的檔案）` });
                }
                const result = await this._parseUploadedFileContent(record, { entryPath: parsed.entry_path });
                return JSON.stringify(Object.assign({ filename: record.filename }, result));
            },
            { type: 'object', properties: {
                file_id: { type: 'string', description: '要解析的檔案id，用list_uploaded_files取得' },
                entry_path: { type: 'string', description: '（選填）壓縮檔內要抽取內容的項目路徑' },
            }, required: ['file_id'], additionalProperties: false }
        );

        // tw_stock_db客製: 階段3——3D場景viewer（見_mount3DScene/計畫文件
        // 階段3）。render_3d_scene自己的description刻意只留最常用欄位，
        // texture/particles/polygon/defs四個進階主題移到get_3d_scene_topic
        // 按需查詢（見SCENE3D_TOPIC_DOCS的說明），呼應使用者「主功能工具
        // 保持精簡」的明確要求。
        this.register_openai_tool('render_3d_scene',
            '用一段YAML描述渲染一個可用滑鼠拖曳/縮放互動的3D場景給使用者看（純宣告式格式，不能寫真正的JS程式碼）。基本欄位：{title:"這個場景的簡短標題（選填，會顯示在畫面下方，建議一定要填，讓使用者一眼看出這是什麼）", camera:{position:[x,y,z],look_at:[x,y,z],fov:50}, lights:[{type:"directional"|"ambient"|"point",position:[x,y,z],intensity:1,color:"#fff"}], nodes:[{mesh:"box"|"sphere"|"cylinder"|"cone"|"plane"|"torus"|"polygon"|"particles", position:[x,y,z], rotation:[x,y,z]（弧度）, size:[w,h,d]（box用）或[寬,長]（plane用，只有2個維度，不要照box習慣多寫第三個「厚度」數字進去——plane是平面沒有厚度，寫3個元素時第2個會被忽略、只有第1、3個當寬/長，容易誤解成整片被壓扁成一條細線）, radius, height（cylinder/cone/sphere/torus用）, material:{color,metalness,roughness,emissive,emissive_intensity,opacity}, animation:"spin"|"bounce"|"orbit"}]}。plane預設面朝相機（垂直），沒指定rotation時想當地板/海面/天空這種大範圍水平面用，要自己設rotation:[-1.5708,0,0]；沒有stairs/chair這類複雜mesh，用原語組合。polygon（例如手刻多面體）沒辦法保證每個面winding方向一致，這個渲染器已經把polygon一律當雙面處理，不會因為winding反過來就有一面消失，不用特別擔心這件事、不用刻意去對齊winding方向。呼叫前若不確定texture/particles/polygon/defs這幾個進階主題的格式，先呼叫get_3d_scene_topic查，不要用猜的。修改既有場景之前，一律先呼叫get_3d_scene_yaml拿到目前真正的內容再改，不要憑對話記憶重新編寫（容易跟實際渲染出來的內容有落差）。未知的mesh類型會直接回報錯誤。畫面上會有📤按鈕讓使用者自己把這個場景匯出成PPTX/PDF，不需要另外用其他工具產生匯出檔。參數: {"yaml":"場景YAML描述"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const yamlText = String(parsed.yaml || '').trim();
                if (!yamlText) return JSON.stringify({ ok: false, error: '缺少yaml參數' });
                try {
                    await this._ensureJsYamlLoaded();
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
                const validation = this._validate3DSceneYaml(yamlText);
                if (!validation.ok) return JSON.stringify({ ok: false, error: validation.error });
                return JSON.stringify({ type: 'scene3d', yaml: yamlText });
            },
            { type: 'object', properties: { yaml: { type: 'string', description: '場景YAML描述' } }, required: ['yaml'], additionalProperties: false }
        );

        this.register_openai_tool('get_3d_scene_topic',
            '查詢render_3d_scene進階主題的完整說明（texture貼圖/particles粒子/polygon自訂形狀/defs可重用群組），這些細節不包含在render_3d_scene自己的說明裡，用之前先查這個，不要用猜的。參數: {"topic":"texture|particles|polygon|defs"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const topic = String(parsed.topic || '').trim();
                const doc = SCENE3D_TOPIC_DOCS[topic];
                if (!doc) return JSON.stringify({ ok: false, error: `未知主題: "${topic}"，合法值：${Object.keys(SCENE3D_TOPIC_DOCS).join('/')}` });
                return JSON.stringify({ ok: true, topic, doc });
            },
            { type: 'object', properties: { topic: { type: 'string', description: 'texture|particles|polygon|defs' } }, required: ['topic'], additionalProperties: false }
        );

        this.register_openai_tool('get_3d_scene_yaml',
            '取得目前對話中最近一次成功渲染的3D場景YAML原始內容——要修改既有場景之前，一律先呼叫這個工具取得目前真正的內容，不要憑記憶重新編寫。無參數。',
            async () => {
                if (!this._latestScene3DYaml) return JSON.stringify({ ok: false, error: '目前對話還沒有渲染過任何3D場景' });
                return JSON.stringify({ ok: true, yaml: this._latestScene3DYaml });
            },
            { type: 'object', properties: {}, additionalProperties: false }
        );

        // tw_stock_db客製: 2026-09-05使用者要求——使用者上傳STL/OBJ/3MF/FBX
        // 這幾種3D模型檔案（透過📎附件，見list_uploaded_files/
        // parse_uploaded_file），想直接看模型時不用一定要打/view-3d-attachment
        // 指令，AI也可以在對話中判斷「使用者想看這個檔案」直接呼叫這個
        // 工具轉換+顯示。轉換邏輯見_convertModelFileToSceneYaml——只還原
        // 幾何形狀+單一材質顏色，不含貼圖/骨架動畫，三角形數量超過上限
        // 會直接報錯而不是硬做有損簡化。
        this.register_openai_tool('import_3d_model_attachment',
            '把使用者上傳的STL/OBJ/3MF/FBX這幾種3D模型檔案轉成場景YAML並直接顯示給使用者看（用list_uploaded_files取得file_id）。只還原幾何形狀+單一材質顏色，不含原始貼圖/多重材質/骨架動畫；模型三角形數量超過5000會被拒絕，請提醒使用者換更精簡的模型。參數: {"file_id":"..."}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const fileId = String(parsed.file_id || '').trim();
                if (!fileId) return JSON.stringify({ ok: false, error: '缺少file_id參數（用list_uploaded_files查詢可用的file_id）' });
                const record = await this.fileCache.get(fileId);
                if (!record || record.kind !== 'uploaded') {
                    return JSON.stringify({ ok: false, error: `找不到上傳檔案 file_id=${fileId}（可能已被淘汰或這不是使用者上傳的檔案）` });
                }
                const converted = await this._convertModelFileToSceneYaml(record);
                if (!converted.ok) return JSON.stringify(converted);
                const validation = this._validate3DSceneYaml(converted.yaml);
                if (!validation.ok) return JSON.stringify({ ok: false, error: `轉換出來的場景格式有誤：${validation.error}` });
                return JSON.stringify({ type: 'scene3d', yaml: converted.yaml });
            },
            { type: 'object', properties: { file_id: { type: 'string', description: '要匯入的3D模型檔案id，用list_uploaded_files取得' } }, required: ['file_id'], additionalProperties: false }
        );

        // tw_stock_db客製: 階段4——內建通用繪圖工具（見計畫文件階段4）。跟
        // host頁面（index.html）自己既有的個股K線圖表/型態標記功能明確分開，
        // 這裡是floating-assistant.js內建、不限host的通用向量繪圖能力
        // （流程圖/示意圖/插畫等）。AI直接輸出SVG原始碼，用既有已vendored的
        // DOMPurify消毒（跟既有markdown渲染管線同一套信任邊界處理方式，不是
        // 新發明的沙盒機制）——SVG本身非可執行，消毒後可安全內嵌，不需要
        // 另外設計一套YAML圖元語言（比3D場景的固定字彙宣告式格式更靈活，
        // 適合這種開放式繪圖需求）。
        this.register_openai_tool('render_drawing',
            '畫一張通用向量圖給使用者看（流程圖、示意圖、圖表、插畫等），直接輸出完整的SVG原始碼——這不是股票K線圖表工具（那是這個網頁應用自己的功能，不透過這裡）。輸出的SVG會先經過消毒過濾掉任何可執行的script/事件屬性才顯示，所以安全無虞，但也代表SVG裡不能靠內嵌JS做互動效果，只能用純圖形元素表達。參數: {"svg":"完整的<svg .../>...</svg>原始碼"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const svgText = String(parsed.svg || '').trim();
                if (!svgText) return JSON.stringify({ ok: false, error: '缺少svg參數' });
                if (!/^<svg[\s>]/i.test(svgText)) return JSON.stringify({ ok: false, error: 'svg參數必須是完整的<svg>...</svg>原始碼（以<svg開頭）' });
                try {
                    await this._ensureDOMPurifyLoaded();
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
                const sanitized = DOMPurify.sanitize(svgText, { USE_PROFILES: { svg: true, svgFilters: true } });
                if (!sanitized.trim()) {
                    return JSON.stringify({ ok: false, error: 'SVG消毒後內容變成空的，可能整段被判定不安全（例如包含script/事件屬性），請只用純圖形元素（path/rect/circle/text等）重新繪製' });
                }
                return JSON.stringify({ type: 'drawing', svg: sanitized });
            },
            { type: 'object', properties: { svg: { type: 'string', description: '完整的<svg>...</svg>原始碼' } }, required: ['svg'], additionalProperties: false }
        );

        // tw_stock_db客製: 階段5——互動式viewer（見_mountInteractiveViewer/
        // 計畫文件階段5）。跟render_3d_scene一樣主功能工具保持精簡，格式細節
        // 交給模型自己看description裡的範例欄位即可（viewer的元件字彙比3D
        // 場景簡單很多，不需要另外拆get_xxx_topic）。
        this.register_openai_tool('render_interactive_viewer',
            '用一段YAML描述渲染一個多頁互動表單/精靈/教學畫面給使用者看（純宣告式，不能寫真正的JS）。格式：{state_namespace:"必填，這個viewer狀態要存在persistentStorage的哪個位置", pages:[{id:"page1", title:"標題", components:[{type:"text", content:"說明文字"}, {type:"input", state_key:"變數名", label:"標籤", input_type:"text|number|select|checkbox|textarea", options:[...]（select用）, default:預設值, visible_if:"安全表達式（選填，可讀其他input的state_key當變數）", enabled_if:"安全表達式（選填）"}, {type:"button", label:"下一步", action:"next_page|prev_page|goto_page:目標page_id|save_state|close", enabled_if:"..."}, {type:"subagent_panel", domain:"領域代號", prompt_placeholder:"..."}]}]}。visible_if/enabled_if是有限安全表達式（算術/比較/布林+讀其他欄位的值），不是真正的JS，不能呼叫函式（除了白名單數學函式）也不能存取DOM。save_state按鈕會把使用者目前填的所有input值存進persistentStorage；之後可以用get_viewer_state(state_namespace)查詢使用者實際填了什麼。參數: {"yaml":"viewer YAML描述"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const yamlText = String(parsed.yaml || '').trim();
                if (!yamlText) return JSON.stringify({ ok: false, error: '缺少yaml參數' });
                try {
                    await this._ensureJsYamlLoaded();
                } catch (err) {
                    return JSON.stringify({ ok: false, error: String(err.message || err) });
                }
                const validation = this._validateInteractiveViewerYaml(yamlText);
                if (!validation.ok) return JSON.stringify({ ok: false, error: validation.error });
                return JSON.stringify({ type: 'viewer', yaml: yamlText });
            },
            { type: 'object', properties: { yaml: { type: 'string', description: 'viewer YAML描述' } }, required: ['yaml'], additionalProperties: false }
        );

        this.register_openai_tool('get_interactive_viewer_yaml',
            '取得目前對話中最近一次成功渲染的互動viewer YAML原始內容——要修改既有viewer之前，一律先呼叫這個工具取得目前真正的內容，不要憑記憶重新編寫。無參數。',
            async () => {
                if (!this._latestViewerYaml) return JSON.stringify({ ok: false, error: '目前對話還沒有渲染過任何互動viewer' });
                return JSON.stringify({ ok: true, yaml: this._latestViewerYaml });
            },
            { type: 'object', properties: {}, additionalProperties: false }
        );

        this.register_openai_tool('get_viewer_state',
            '查詢某個互動viewer目前persistentStorage裡存的狀態（使用者按過save_state之後實際填了什麼）。參數: {"state_namespace":"viewer YAML裡的state_namespace"}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const ns = String(parsed.state_namespace || '').trim();
                if (!ns) return JSON.stringify({ ok: false, error: '缺少state_namespace參數' });
                const value = await this.stateStore.get(`viewer:${ns}`);
                return JSON.stringify({ ok: true, state_namespace: ns, state: value === undefined ? null : value });
            },
            { type: 'object', properties: { state_namespace: { type: 'string' } }, required: ['state_namespace'], additionalProperties: false }
        );

        this.register_openai_tool('set_viewer_state',
            '直接修改某個互動viewer在persistentStorage裡的狀態（例如AI想預先幫使用者填一些預設值）。這會整包覆蓋該namespace目前的狀態，不是欄位級合併。參數: {"state_namespace":"...", "state":{...任意物件...}}',
            async (rawArgs) => {
                let parsed = {};
                try { parsed = await this.repairJsonPayload(String(rawArgs || '{}')); } catch (_) {}
                const ns = String(parsed.state_namespace || '').trim();
                if (!ns) return JSON.stringify({ ok: false, error: '缺少state_namespace參數' });
                if (!parsed.state || typeof parsed.state !== 'object') return JSON.stringify({ ok: false, error: '缺少state參數（必須是物件）' });
                await this.stateStore.set(`viewer:${ns}`, parsed.state);
                return JSON.stringify({ ok: true, state_namespace: ns });
            },
            { type: 'object', properties: { state_namespace: { type: 'string' }, state: { type: 'object' } }, required: ['state_namespace', 'state'], additionalProperties: false }
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

    // tw_stock_db客製: allowedNames（非null時）把回傳的工具entries限制在這個
    // 名稱子集內——給delegate_to_subagent的domain委派用（見
    // SUBAGENT_DOMAIN_REGISTRY/_runSubAgentTask），讓被委派的子任務迴圈
    // 只看得到、只能呼叫該domain允許的工具，不是全部38個工具。null（預設，
    // 所有既有呼叫端都沒傳這個參數）維持原本「回傳全部工具」的行為不變。
    _getCombinedToolEntries(allowedNames = null) {
        const entries = Object.entries(this.tools).map(([name, tool]) => [name, Object.assign({ source: 'predefined' }, tool)]);
        this.advancedSettings.customTools.forEach(tool => {
            entries.push([tool.name, {
                description: tool.description,
                callback: rawArgs => this._executeCustomTool(tool, rawArgs),
                source: 'custom'
            }]);
        });
        if (!allowedNames) return entries;
        const allowedSet = new Set(allowedNames);
        return entries.filter(([name]) => allowedSet.has(name));
    }

    // tw_stock_db客製: 2026-08-24使用者要求——沒有資工背景的人透過自訂
    // 工具編輯器或add_ai_function讓AI建立函式時，很自然會用自己看得懂的
    // 中文命名（例如「計算持股獲利」），但原生tool-calling API（OpenAI相容
    // 端點）規定function.name只能是 ^[a-zA-Z0-9_-]{1,64}$（不能有中文/
    // 空白），中文名稱直接塞進tools參數送出去，輕則這個工具被API拒絕，
    // 重則整批tools參數格式不合法、當輪對話的原生tool-calling整個失敗
    // （不是只有這個工具受影響）。這裡加一層「原生API安全別名」：只有
    // 名稱本身不符合API規定格式時才會產生別名（純ASCII名稱完全不受
    // 影響、行為不變，這是絕大多數內建工具的情況），別名是原始名稱算出
    // 的短雜湊，同一個名稱每次都算出同一個別名（同一個對話/重新整理都
    // 穩定），_getToolDefinition同時接受原始名稱或別名查詢，讓文字式
    // [CALL:...]用中文原名（regex已經放寬到能吃中文，見上面幾處
    // \p{L}\p{N}_的修改）照樣能解析執行，原生tool_calls回傳的別名也能
    // 正確對應回同一個工具。
    _sanitizeToolNameForNativeApi(name) {
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(name)) return name;
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
        return 'tool_' + hash.toString(36);
    }

    _getToolDefinition(name, allowedNames = null) {
        const entries = this._getCombinedToolEntries(allowedNames);
        const direct = entries.find(([toolName]) => toolName === name);
        if (direct) return direct[1];
        const byAlias = entries.find(([toolName]) => this._sanitizeToolNameForNativeApi(toolName) === name);
        return byAlias ? byAlias[1] : null;
    }

    _isToolNameDuplicate(name, excludeIndex = -1) {
        return Object.prototype.hasOwnProperty.call(this.tools, name) ||
            this.advancedSettings.customTools.some((tool, index) => tool.name === name && index !== excludeIndex);
    }

    _validateCustomScript(script, label = '腳本') {
        return true;
    }

    // tw_stock_db客製: 見get_tool_details註冊處的說明——文字協定模式下，
    // system prompt裡每個工具只給「名稱+極短摘要」，不給完整description
    // （可能上千字），精確參數格式一律靠get_tool_details查詢。摘要取
    // description開頭到第一個中文/英文句讀（。，；！,.）或字數上限，先到
    // 先切——只是給模型一個「這個工具大概是做什麼的」的粗略印象，用來判斷
    // 要不要查詢它的完整規格，不是要在這裡塞完整規格。
    _summarizeToolDescription(desc, maxLen = 36) {
        const text = String(desc || '');
        const cutAt = text.search(/[。，；！,.\n]/);
        let summary = (cutAt > 0 && cutAt < maxLen) ? text.slice(0, cutAt) : text.slice(0, maxLen);
        if (summary.length < text.length) summary += '…';
        return summary;
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
        // 模型用的)，所以這裡整段跳過。這裡的「名稱+摘要」縮減也只影響文字
        // 協定路徑，原生模式不受影響（見_summarizeToolDescription說明）。
        const { apiModel } = this._getApiConfig();
        if (!this._shouldUseNativeToolCalls(apiModel) && (predefinedTools.length || customTools.length)) {
            const toolSections = [];
            if (predefinedTools.length) {
                toolSections.push([
                    '[PREDEFINED TOOLS] (name + short hint only — call get_tool_details({"names":[...]}) to get a tool\'s exact parameters before using it for the first time; never guess parameter names/format)',
                    ...predefinedTools.map(([name, tool]) => name === 'get_tool_details'
                        ? `- ${name}: ${tool.description}`
                        : `- ${name}: ${this._summarizeToolDescription(tool.description)}`)
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
                'The [PREDEFINED TOOLS] list above only gives each tool\'s name and a short hint, not its exact parameters. Before calling any tool for the first time in this conversation, call get_tool_details({"names": ["tool_name"]}) to get its exact parameter names/format, unless you already saw its full details earlier in this same conversation. Never invent or guess a parameter name that was not shown to you.',
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
            // tw_stock_db客製: 2026-08-25修正——原本max_tokens:50+15秒逾時對
            // 推理模型（例如nemotron系列）太苛刻：這類模型會先在
            // reasoning_content吐一大段思考過程才輸出真正的tool_calls，50
            // tokens幾乎必定在思考階段就被截斷，永遠測不到tool_calls，把
            // 「探測預算不夠」誤判成「不支援原生tool_calls」（實測案例：
            // nemotron-3-super-120b-a12b被這樣誤判成false，但NVIDIA官方
            // 範例證實它確實支援）。放寬到4096 tokens + 45秒，給思考過程
            // 足夠空間，才能測出真正的支援與否。
            const timeoutId = setTimeout(() => controller.abort(), 45000);
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
                        max_tokens: 4096,
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
    _buildNativeToolsSchema(allowedNames = null) {
        return this._getCombinedToolEntries(allowedNames).map(([name, tool]) => ({
            type: 'function',
            function: {
                name: this._sanitizeToolNameForNativeApi(name),
                description: String(tool.description || ''),
                // tw_stock_db客製: 見register_openai_tool()的說明——有提供
                // parametersSchema（逐欄位型別）就用它，讓模型知道哪些參數
                // 該是原生陣列/物件而不是自己包一層JSON字串；沒提供的工具
                // （自訂工具、部分沒有結構化params的builtin工具）維持原本
                // 的opaque schema，行為不變。
                parameters: tool.parametersSchema || { type: 'object', properties: {}, additionalProperties: true }
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

    // tw_stock_db客製: 2026-08-28使用者要求——通用「暫停並跳表單詢問使用者」
    // 機制，讓AI能像Claude一樣在需要時停下來問，不是自己瞎猜或直接執行
    // 有風險的動作。兩種呼叫情境共用這一個方法：
    //   (1) host app的aiToolHandler在"ask if need"模式下，執行mutates:true
    //       的工具前先跳表單讓使用者確認/編輯參數（見index.html的說明）
    //   (2) AI自己主動呼叫ask_user_for_input工具，判斷需要使用者決定時
    //       主動問（例如有多種做法要使用者選）
    //
    // options: { title, description, choices?: string[], fields?:
    //   [{key, label, value?, placeholder?}] }
    //   - choices有給：渲染成按鈕群組（單選），回傳{confirmed:true, answer}
    //   - 沒choices但fields有給：渲染成文字輸入表單+送出/取消按鈕，回傳
    //     {confirmed:true, values:{key:value,...}} 或 {confirmed:false}
    //   - 兩者都沒有：純文字確認(是/否)，回傳{confirmed:boolean}
    //
    // 刻意純DOM操作、不進this.messages/不persist——這是「當下這次互動」的
    // 暫時性UI元件，跟index.html那些slash command進度條div是同一種模式
    // (用完就從DOM移除)，不是聊天記錄的一部分；理由：Promise本來就沒辦法
    // JSON序列化，使用者中途重新整理頁面的話，這個「暫停中」的狀態本來
    // 就沒辦法真正恢復（相當於那次工具呼叫直接視為使用者沒有回應），比起
    // 硬做一套可持久化的表單狀態機，這裡選擇不過度工程化。
    requestUserForm(options = {}) {
        return new Promise((resolve) => {
            const { title = '🧭 AI 想確認一下', description = '', choices = null, fields = null } = options;
            const chatBody = document.getElementById('ai-chat-body');
            if (!chatBody) { resolve({ confirmed: true }); return; } // 理論上不該發生(呼叫這個方法時對話視窗一定已經開著)，保守起見不卡住整個工具呼叫流程
            const palette = this._getThemePalette();
            const formId = `ai-form-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

            let bodyHtml;
            if (Array.isArray(choices) && choices.length) {
                bodyHtml = `<div style="display:flex; flex-wrap:wrap; gap:6px; margin-top:8px;">` +
                    choices.map((c, i) => `<button class="btn" data-choice-idx="${i}" style="font-size:12px;">${this._escapeHtml(String(c))}</button>`).join('') +
                    `</div>`;
            } else if (Array.isArray(fields) && fields.length) {
                bodyHtml = fields.map(f => `<label style="display:block; margin:6px 0; font-size:12px;">
                    <span style="color:${palette.detailText};">${this._escapeHtml(f.label || f.key)}</span>
                    <input type="text" data-field-key="${this._escapeHtml(f.key)}" value="${this._escapeHtml(String(f.value ?? ''))}" placeholder="${this._escapeHtml(f.placeholder || '')}"
                        style="width:100%; box-sizing:border-box; padding:4px 6px; margin-top:2px; border:1px solid ${palette.windowBorder}; border-radius:4px; background:transparent; color:${palette.detailText};">
                </label>`).join('') +
                    `<div style="margin-top:8px; display:flex; gap:8px;">
                        <button class="btn primary" data-action="submit" style="font-size:12px;">✅ 送出</button>
                        <button class="btn" data-action="cancel" style="font-size:12px;">✖️ 取消</button>
                    </div>`;
            } else {
                bodyHtml = `<div style="margin-top:8px; display:flex; gap:8px;">
                    <button class="btn primary" data-action="confirm-yes" style="font-size:12px;">✅ 確定</button>
                    <button class="btn" data-action="confirm-no" style="font-size:12px;">✖️ 取消</button>
                </div>`;
            }

            const html = `<div id="${formId}" style="margin:8px 0; padding:10px 12px; border:1px solid ${palette.windowBorder}; border-radius:8px; font-size:13px;">
                <div style="font-weight:bold; margin-bottom:4px;">${this._escapeHtml(title)}</div>
                ${description ? `<div style="font-size:12px; color:${palette.detailText}; white-space:pre-wrap;">${this._escapeHtml(description)}</div>` : ''}
                ${bodyHtml}
            </div>`;
            chatBody.insertAdjacentHTML('beforeend', html);
            chatBody.scrollTo({ top: chatBody.scrollHeight, behavior: 'smooth' });

            const container = document.getElementById(formId);
            const finish = (result) => { container.remove(); resolve(result); };

            if (Array.isArray(choices) && choices.length) {
                container.querySelectorAll('[data-choice-idx]').forEach(btn => {
                    btn.addEventListener('click', () => finish({ confirmed: true, answer: choices[Number(btn.dataset.choiceIdx)] }));
                });
            } else if (Array.isArray(fields) && fields.length) {
                container.querySelector('[data-action="submit"]').addEventListener('click', () => {
                    const values = {};
                    container.querySelectorAll('[data-field-key]').forEach(input => { values[input.dataset.fieldKey] = input.value; });
                    finish({ confirmed: true, values });
                });
                container.querySelector('[data-action="cancel"]').addEventListener('click', () => finish({ confirmed: false }));
            } else {
                container.querySelector('[data-action="confirm-yes"]').addEventListener('click', () => finish({ confirmed: true }));
                container.querySelector('[data-action="confirm-no"]').addEventListener('click', () => finish({ confirmed: false }));
            }
        });
    }

    // tw_stock_db客製: 把「工具執行結果」組成訊息物件的邏輯，跟「push進
    // this.messages」拆開——runBatchSubAgents()的子任務有自己獨立、用完即丟
    // 的本地訊息陣列（不是this.messages），需要同一套圖片/meta處理規則，
    // 但不能push進主對話。
    _buildToolResultMessage(fnName, result, extra) {
        let imageDataUrl = null;
        let imageMeta = null;
        let scene3DYaml = null;
        let drawingSvg = null;
        let viewerYaml = null;
        try {
            const parsed = typeof result === 'string' ? JSON.parse(result) : result;
            if (parsed && parsed.type === 'drawing' && typeof parsed.svg === 'string') {
                // tw_stock_db客製: 階段4——通用繪圖跟圖片/3D場景同一個「顯示
                // 內容不列入對話上下文」原則，理由也一樣：SVG原始碼可能不小，
                // 沒有必要每輪都重新送給模型看一次已經畫好、使用者已經看到
                // 的圖。
                drawingSvg = parsed.svg;
            } else if (parsed && parsed.type === 'image' && typeof parsed.dataUrl === 'string') {
                imageDataUrl = parsed.dataUrl;
                // tw_stock_db客製: 圖片本身不列入對話上下文（見下面），但如果
                // 工具額外附了一個輕量的meta摘要（例如render_stock_chart回傳
                // 實際畫出來的高低點價位/時間），這個摘要要照樣送進模型看得到
                // 的content，不能被「圖片=整包隱藏」的規則一起吃掉——不然模型
                // 完全沒有真實數字可以用來下精準的標記/線段，只能瞎猜（實測
                // 遇到的真實案例：標記位置對不齊K棒）。
                if (parsed.meta && typeof parsed.meta === 'object') imageMeta = parsed.meta;
            } else if (parsed && parsed.type === 'scene3d' && typeof parsed.yaml === 'string') {
                // tw_stock_db客製: 階段3——3D場景跟圖片同一個「顯示內容不列入
                // 送給LLM的上下文」原則，但理由不完全一樣：圖片是「base64太佔
                // token」，YAML場景文字量通常不大，真正的理由是仿照參考文件
                // §13的既有規則——絕不能讓模型憑自己對話記憶「重新默寫」一份
                // 已經渲染過的場景YAML去修改（容易跟實際渲染出來的內容有落差），
                // 修改既有場景一律要求先呼叫get_3d_scene_yaml拿到目前真正的
                // 內容，這裡刻意不把YAML留在content裡，逼模型走那個工具。
                scene3DYaml = parsed.yaml;
            } else if (parsed && parsed.type === 'viewer' && typeof parsed.yaml === 'string') {
                // tw_stock_db客製: 階段5——互動viewer跟3D場景同一個「不列入
                // 對話上下文、逼模型走get_interactive_viewer_yaml重新取得
                // 最新內容」原則。
                viewerYaml = parsed.yaml;
            }
        } catch (_) { /* 不是圖片/3D場景/viewer payload，走下面一般文字流程 */ }

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
        } else if (scene3DYaml) {
            msg.content = `[Tool ${fnName} 已產生一個可用滑鼠互動的3D場景，已直接顯示給使用者看，場景YAML原始內容不列入對話上下文。如果之後要修改這個場景，請先呼叫get_3d_scene_yaml取得目前實際內容再修改，不要憑記憶重新編寫]`;
            Object.defineProperty(msg, '_displayScene3DYaml', { value: scene3DYaml, enumerable: false, configurable: true });
            this._latestScene3DYaml = scene3DYaml;
        } else if (drawingSvg) {
            msg.content = `[Tool ${fnName} 已產生一張向量圖，已直接顯示給使用者看，SVG原始碼不列入對話上下文]`;
            Object.defineProperty(msg, '_displayDrawingSvg', { value: drawingSvg, enumerable: false, configurable: true });
        } else if (viewerYaml) {
            msg.content = `[Tool ${fnName} 已產生一個互動viewer，已直接顯示給使用者看，viewer YAML原始內容不列入對話上下文。如果之後要修改這個viewer，請先呼叫get_interactive_viewer_yaml取得目前實際內容再修改，不要憑記憶重新編寫]`;
            Object.defineProperty(msg, '_displayViewerYaml', { value: viewerYaml, enumerable: false, configurable: true });
            this._latestViewerYaml = viewerYaml;
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
        // tw_stock_db客製: 歷史訊息按鈕/面板是_initUI()組innerHTML時用當下
        // palette寫死顏色，跟上面genDetailBox同一種問題——使用者實測回報
        // 這兩個元件切換主題後顏色沒跟著變，停留在視窗剛建立時的深色（因為
        // 視窗一開始mount時data-theme還沒確定成light），沒有其他自動刷新的
        // 機會，這裡一併同步。（建議操作chip列已經改成插入對話訊息裡顯示，
        // 見insertSuggestionChipsMessage()，每次隨訊息重繪自然套用當下
        // palette，不用再像這裡額外同步。）
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
        // tw_stock_db客製: KaTeX用來把AI回覆裡的LaTeX數學語法（$...$/$$...$$）
        // 排版成正式的數學符號，見_renderMarkdownWithMath()。跟marked/
        // DOMPurify一樣是輕量單檔CDN函式庫，一起在mount時背景預載。改用
        // _faLoadScriptOnce/_faLoadStyleOnce（見該函式說明：fetch+Blob繞過
        // raw.githubusercontent.com的nosniff限制），不再自己直接注入
        // <script src>/<link href>——katex.min.css的相對路徑字型引用要改寫
        // 成絕對網址，rewriteBaseUrl取katexCss網址本身去掉檔名的目錄部分。
        const katexCssBase = FA_ASSET_URLS.katexCss.replace(/katex\.min\.css(?:\?.*)?$/, '');
        this._markdownLibsPromise = Promise.all([
            typeof marked === 'undefined' ? _faLoadScriptOnce(FA_ASSET_URLS.marked) : Promise.resolve(),
            typeof DOMPurify === 'undefined' ? _faLoadScriptOnce(FA_ASSET_URLS.dompurify) : Promise.resolve(),
            typeof katex === 'undefined' ? _faLoadScriptOnce(FA_ASSET_URLS.katexJs) : Promise.resolve(),
            document.getElementById('ai-katex-style') ? Promise.resolve() : _faLoadStyleOnce(FA_ASSET_URLS.katexCss, katexCssBase, 'ai-katex-style'),
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
        // 改用_faLoadScriptOnce（fetch+Blob，見該函式說明）而不是直接注入
        // <script src>，避免vendor資源放在raw.githubusercontent.com時因為
        // nosniff MIME限制載入失敗。
        this._jszipLoadPromise = _faLoadScriptOnce(FA_ASSET_URLS.jszip).catch(e => {
            this._jszipLoadPromise = null;
            throw new Error('JSZip 載入失敗（可能是網路問題）：' + e.message);
        });
        return this._jszipLoadPromise;
    }

    // tw_stock_db客製: 階段2（parse_uploaded_file解析yaml）+ 階段3（3D場景
    // YAML描述）共用同一份js-yaml延遲載入，同一個精神：不用到就不多背這個
    // CDN依賴。
    _ensureJsYamlLoaded() {
        if (typeof jsyaml !== 'undefined') return Promise.resolve();
        if (this._jsyamlLoadPromise) return this._jsyamlLoadPromise;
        this._jsyamlLoadPromise = _faLoadScriptOnce(FA_ASSET_URLS.jsyaml).catch(e => {
            this._jsyamlLoadPromise = null;
            throw new Error('js-yaml 載入失敗（可能是網路問題）：' + e.message);
        });
        return this._jsyamlLoadPromise;
    }

    // tw_stock_db客製: 階段3——three.js本體+OrbitControls依序載入（後者要靠
    // 前者的window.THREE先存在才能掛上THREE.OrbitControls，見FA_ASSET_URLS
    // 的threejs/threeOrbitControls說明），只有使用者真的觸發3D場景渲染時
    // 才載入，同樣不無條件多背這個依賴。
    _ensureThreeJsLoaded() {
        if (typeof THREE !== 'undefined' && THREE.OrbitControls) return Promise.resolve();
        if (this._threejsLoadPromise) return this._threejsLoadPromise;
        this._threejsLoadPromise = (async () => {
            if (typeof THREE === 'undefined') await _faLoadScriptOnce(FA_ASSET_URLS.threejs);
            if (!THREE.OrbitControls) await _faLoadScriptOnce(FA_ASSET_URLS.threeOrbitControls);
        })().catch(e => {
            this._threejsLoadPromise = null;
            throw new Error('three.js 載入失敗（可能是網路問題）：' + e.message);
        });
        return this._threejsLoadPromise;
    }

    // tw_stock_db客製: 2026-09-05使用者要求支援匯入STL/OBJ/3MF/FBX——依格式
    // 只載入對應的官方loader（都是r128同一批舊式global-attaching build，
    // 見FA_ASSET_URLS的說明），不會四個loader一次全載。FBX額外需要fflate
    // （解壓縮二進位FBX用），loader本身沒載入時才載入fflate，避免已經
    // 有全域fflate時重複注入。
    async _ensure3DModelImportLoaded(format) {
        await this._ensureThreeJsLoaded();
        if (format === 'stl' && !THREE.STLLoader) await _faLoadScriptOnce(FA_ASSET_URLS.threeSTLLoader);
        else if (format === 'obj' && !THREE.OBJLoader) await _faLoadScriptOnce(FA_ASSET_URLS.threeOBJLoader);
        else if (format === '3mf' && !THREE.ThreeMFLoader) await _faLoadScriptOnce(FA_ASSET_URLS.three3MFLoader);
        else if (format === 'fbx' && !THREE.FBXLoader) {
            if (typeof fflate === 'undefined') await _faLoadScriptOnce(FA_ASSET_URLS.threeFflate);
            await _faLoadScriptOnce(FA_ASSET_URLS.threeFBXLoader);
        }
    }

    // 把STLLoader/OBJLoader/ThreeMFLoader/FBXLoader解析出來的Object3D圖
    // （可能是單一Mesh、也可能是巢狀Group）攤平成這個內部YAML格式能用的
    // 「mesh零件」清單——每個零件的頂點座標先乘上該Mesh的matrixWorld
    // （把巢狀transform直接烘焙進頂點座標本身），因為這個YAML格式的node
    // 是扁平清單、沒有父子巢狀transform的概念。只取幾何形狀+單一材質顏色，
    // 不嘗試還原貼圖/多重材質/骨架動畫這類進階內容（見計畫文件的取捨
    // 說明）。
    _extractMeshPartsFromObject3D(root) {
        root.updateMatrixWorld(true);
        const parts = [];
        root.traverse((obj) => {
            if (!obj.isMesh || !obj.geometry) return;
            const posAttr = obj.geometry.attributes.position;
            if (!posAttr) return;
            const worldMatrix = obj.matrixWorld;
            const vertices = [];
            const round = (n) => Math.round(n * 10000) / 10000;
            for (let i = 0; i < posAttr.count; i++) {
                const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(worldMatrix);
                vertices.push([round(v.x), round(v.y), round(v.z)]);
            }
            const index = obj.geometry.index;
            const faces = [];
            const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
            for (let t = 0; t < triCount; t++) {
                faces.push(index
                    ? [index.getX(t * 3), index.getX(t * 3 + 1), index.getX(t * 3 + 2)]
                    : [t * 3, t * 3 + 1, t * 3 + 2]);
            }
            let color = '#cccccc';
            const mat = Array.isArray(obj.material) ? obj.material[0] : obj.material;
            if (mat && mat.color) { try { color = '#' + mat.color.getHexString(); } catch (_) { /* 保底顏色 */ } }
            parts.push({ name: obj.name || `part${parts.length + 1}`, vertices, faces, color });
        });
        return parts;
    }

    // 把mesh零件清單組成一份完整的場景YAML：先算全部零件合併起來的
    // bounding box，置中到原點+等比縮放讓最長邊落在4個單位左右（STL常見
    // 單位是公釐，數字動輒幾十~幾百，不縮放的話會跟這個場景格式預設的
    // camera/燈光距離完全對不起來，畫面上不是整個模型跑到畫面外就是
    // 縮成一個看不見的小點），每個零件對應一個mesh:polygon節點，附一個
    // 依bounding box自動抓的相機視角。用jsyaml.dump()產生YAML文字而不是
    // 手拼字串，正確處理浮點數/巢狀陣列的格式，也順便用lineWidth:-1避免
    // 長陣列被自動換行。
    _buildSceneYamlFromMeshParts(parts, filename) {
        let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
        parts.forEach(p => p.vertices.forEach(([x, y, z]) => {
            minX = Math.min(minX, x); maxX = Math.max(maxX, x);
            minY = Math.min(minY, y); maxY = Math.max(maxY, y);
            minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
        }));
        const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2, cz = (minZ + maxZ) / 2;
        const maxDim = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
        const scale = 4 / maxDim;
        const round = (n) => Math.round(n * 10000) / 10000;

        const nodes = parts.map((p) => ({
            mesh: 'polygon',
            vertices: p.vertices.map(([x, y, z]) => [round((x - cx) * scale), round((y - cy) * scale), round((z - cz) * scale)]),
            faces: p.faces,
            material: { color: p.color, metalness: 0.1, roughness: 0.6 },
        }));

        const scene = {
            title: `匯入模型：${filename}`,
            camera: { position: [4, 3, 6], look_at: [0, 0, 0], fov: 50 },
            lights: [
                { type: 'directional', position: [5, 8, 5], intensity: 1 },
                { type: 'ambient', intensity: 0.5 },
            ],
            nodes,
        };
        return jsyaml.dump(scene, { lineWidth: -1 });
    }

    // tw_stock_db客製: 主要轉換入口——給/view-3d-attachment跟
    // import_3d_model_attachment工具共用。依副檔名判斷格式、載入對應
    // loader、解析成Object3D、攤平成mesh零件、算出總三角形數跟
    // SCENE3D_MAX_IMPORTED_MESH_TRIANGLES比較（STL/OBJ/3MF/FBX都可能是
    // 掃描/CAD等級的高面數模型，YAML用逐頂點座標的文字表示法直接嵌入
    // 太大量三角形會讓檔案暴增、也會拖垮軟體光柵化fallback的每幀效能，
    // 超過上限直接拒絕、不做任何有損簡化——簡化錯了會做出比拒絕更糟的
    // 「看起來壞掉」的模型)，通過才組成場景YAML回傳。
    async _convertModelFileToSceneYaml(record) {
        const format = this._detectFileFormat(record.filename);
        if (!['stl', 'obj', '3mf', 'fbx'].includes(format)) {
            return { ok: false, error: `不支援的3D模型格式: ${format}（目前支援stl/obj/3mf/fbx）` };
        }
        try {
            await this._ensure3DModelImportLoaded(format);
        } catch (err) {
            return { ok: false, error: String(err.message || err) };
        }
        let object3D;
        try {
            if (format === 'stl') {
                const buf = await record.blob.arrayBuffer();
                object3D = new THREE.Mesh(new THREE.STLLoader().parse(buf));
            } else if (format === 'obj') {
                const text = await record.blob.text();
                object3D = new THREE.OBJLoader().parse(text);
            } else if (format === '3mf') {
                const buf = await record.blob.arrayBuffer();
                object3D = new THREE.ThreeMFLoader().parse(buf);
            } else if (format === 'fbx') {
                const buf = await record.blob.arrayBuffer();
                object3D = new THREE.FBXLoader().parse(buf, '');
            }
        } catch (err) {
            return { ok: false, error: `解析${format.toUpperCase()}檔案失敗: ${err.message || err}` };
        }
        const parts = this._extractMeshPartsFromObject3D(object3D);
        if (!parts.length) return { ok: false, error: '這個檔案裡沒有找到任何可渲染的網格' };
        const totalTriangles = parts.reduce((sum, p) => sum + p.faces.length, 0);
        if (totalTriangles > SCENE3D_MAX_IMPORTED_MESH_TRIANGLES) {
            return { ok: false, error: `模型三角形數量(${totalTriangles})超過上限${SCENE3D_MAX_IMPORTED_MESH_TRIANGLES}，請提供更精簡/低面數的模型` };
        }
        const yaml = this._buildSceneYamlFromMeshParts(parts, record.filename);
        return { ok: true, yaml, triangleCount: totalTriangles, partCount: parts.length };
    }

    // tw_stock_db客製: 階段4（通用繪圖工具render_drawing）只需要DOMPurify
    // 消毒SVG，不需要marked/katex——獨立一個輕量loader，不要為了畫一張圖
    // 就連帶把markdown/數學公式的函式庫也載進來（那些由
    // _ensureMarkdownLibsLoaded()另外管理，兩者共用同一個全域DOMPurify，
    // 不會重複載入）。
    _ensureDOMPurifyLoaded() {
        if (typeof DOMPurify !== 'undefined') return Promise.resolve();
        if (this._dompurifyLoadPromise) return this._dompurifyLoadPromise;
        this._dompurifyLoadPromise = _faLoadScriptOnce(FA_ASSET_URLS.dompurify).catch(e => {
            this._dompurifyLoadPromise = null;
            throw new Error('DOMPurify 載入失敗（可能是網路問題）：' + e.message);
        });
        return this._dompurifyLoadPromise;
    }

    // ============================================================
    // tw_stock_db客製: 共用的「安全表達式」評估器（見SAFE_EXPR_FUNCTIONS的
    // 說明）——手刻的遞迴下降parser，直接把運算式編譯成一串closure
    // （_compileSafeExpression回傳(context)=>value的函式，可以編譯一次、
    // 用不同context重複呼叫很多次，這對階段3每個粒子每幀都要算一次公式
    // 的情境很重要，不用每幀重新做字串斷詞/語法分析）。文法涵蓋算術
    // （+-*/%）、比較（==!=<<=>>=）、布林（&&||!）、括號分組、數字/字串/
    // true/false/null字面值、對context物件的dot-path讀取（例如base_x、
    // user.name）、以及只能呼叫SAFE_EXPR_FUNCTIONS白名單裡函式的呼叫語法
    // （語法上完全沒有辦法呼叫白名單以外的任何東西，不是靠黑名單擋，是
    // 語法結構性地不存在）——絕對不用eval/new Function實作。
    // ============================================================

    _tokenizeSafeExpr(text) {
        const tokens = [];
        const s = String(text || '');
        let i = 0;
        while (i < s.length) {
            const ch = s[i];
            if (/\s/.test(ch)) { i++; continue; }
            if (ch === '"' || ch === "'") {
                const quote = ch; let j = i + 1; let str = '';
                while (j < s.length && s[j] !== quote) { str += s[j]; j++; }
                tokens.push({ type: 'string', value: str }); i = j + 1; continue;
            }
            if (/[0-9]/.test(ch)) {
                let j = i; while (j < s.length && /[0-9.]/.test(s[j])) j++;
                tokens.push({ type: 'number', value: Number(s.slice(i, j)) }); i = j; continue;
            }
            if (/[A-Za-z_一-鿿]/.test(ch)) {
                let j = i; while (j < s.length && /[A-Za-z0-9_一-鿿]/.test(s[j])) j++;
                tokens.push({ type: 'ident', value: s.slice(i, j) }); i = j; continue;
            }
            const two = s.slice(i, i + 2);
            if (['==', '!=', '<=', '>=', '&&', '||'].includes(two)) { tokens.push({ type: 'op', value: two }); i += 2; continue; }
            if ('+-*/%<>().!,'.includes(ch)) { tokens.push({ type: 'op', value: ch }); i++; continue; }
            throw new Error(`無法識別的字元: "${ch}"`);
        }
        return tokens;
    }

    // 編譯一次、回傳(context)=>value的函式，不重複斷詞/語法分析。
    _compileSafeExpression(exprText) {
        const tokens = this._tokenizeSafeExpr(exprText);
        let pos = 0;
        const peek = () => tokens[pos];
        const next = () => tokens[pos++];
        const expect = (val) => {
            if (!peek() || peek().value !== val) throw new Error(`預期 "${val}"，但看到 "${peek() ? peek().value : 'EOF'}"`);
            return next();
        };

        const parseOr = () => {
            let leftFn = parseAnd();
            while (peek() && peek().value === '||') {
                next(); const rightFn = parseAnd(); const prevFn = leftFn;
                leftFn = (ctx) => prevFn(ctx) || rightFn(ctx);
            }
            return leftFn;
        };
        const parseAnd = () => {
            let leftFn = parseNot();
            while (peek() && peek().value === '&&') {
                next(); const rightFn = parseNot(); const prevFn = leftFn;
                leftFn = (ctx) => prevFn(ctx) && rightFn(ctx);
            }
            return leftFn;
        };
        const parseNot = () => {
            if (peek() && peek().value === '!') { next(); const fn = parseNot(); return (ctx) => !fn(ctx); }
            return parseCmp();
        };
        const parseCmp = () => {
            const leftFn = parseAdd();
            if (peek() && ['==', '!=', '<=', '>=', '<', '>'].includes(peek().value)) {
                const op = next().value;
                const rightFn = parseAdd();
                switch (op) {
                    case '==': return (ctx) => leftFn(ctx) == rightFn(ctx);
                    case '!=': return (ctx) => leftFn(ctx) != rightFn(ctx);
                    case '<=': return (ctx) => leftFn(ctx) <= rightFn(ctx);
                    case '>=': return (ctx) => leftFn(ctx) >= rightFn(ctx);
                    case '<': return (ctx) => leftFn(ctx) < rightFn(ctx);
                    case '>': return (ctx) => leftFn(ctx) > rightFn(ctx);
                }
            }
            return leftFn;
        };
        const parseAdd = () => {
            let leftFn = parseMul();
            while (peek() && (peek().value === '+' || peek().value === '-')) {
                const op = next().value; const rightFn = parseMul(); const prevFn = leftFn;
                leftFn = op === '+' ? (ctx) => prevFn(ctx) + rightFn(ctx) : (ctx) => prevFn(ctx) - rightFn(ctx);
            }
            return leftFn;
        };
        const parseMul = () => {
            let leftFn = parseUnary();
            while (peek() && (peek().value === '*' || peek().value === '/' || peek().value === '%')) {
                const op = next().value; const rightFn = parseUnary(); const prevFn = leftFn;
                leftFn = op === '*' ? (ctx) => prevFn(ctx) * rightFn(ctx)
                    : op === '/' ? (ctx) => prevFn(ctx) / rightFn(ctx)
                        : (ctx) => prevFn(ctx) % rightFn(ctx);
            }
            return leftFn;
        };
        const parseUnary = () => {
            if (peek() && peek().value === '-') { next(); const fn = parseUnary(); return (ctx) => -fn(ctx); }
            return parsePrimary();
        };
        const parsePrimary = () => {
            const tok = next();
            if (!tok) throw new Error('表達式意外結束');
            if (tok.type === 'number') { const v = tok.value; return () => v; }
            if (tok.type === 'string') { const v = tok.value; return () => v; }
            if (tok.type === 'ident') {
                if (tok.value === 'true') return () => true;
                if (tok.value === 'false') return () => false;
                if (tok.value === 'null') return () => null;
                if (peek() && peek().value === '(') {
                    const fn = SAFE_EXPR_FUNCTIONS[tok.value];
                    if (!fn) throw new Error(`未知的函式: "${tok.value}"（只允許白名單裡的數學函式：${Object.keys(SAFE_EXPR_FUNCTIONS).join('/')}）`);
                    next(); // consume '('
                    const argFns = [];
                    if (!(peek() && peek().value === ')')) {
                        argFns.push(parseOr());
                        while (peek() && peek().value === ',') { next(); argFns.push(parseOr()); }
                    }
                    expect(')');
                    return (ctx) => fn(...argFns.map(f => f(ctx)));
                }
                const path = [tok.value];
                while (peek() && peek().value === '.') {
                    next();
                    const propTok = next();
                    if (!propTok || propTok.type !== 'ident') throw new Error('屬性名稱格式錯誤');
                    path.push(propTok.value);
                }
                return (ctx) => {
                    let val = ctx;
                    for (const key of path) val = (val && typeof val === 'object') ? val[key] : undefined;
                    return val;
                };
            }
            if (tok.value === '(') {
                const innerFn = parseOr();
                expect(')');
                return innerFn;
            }
            throw new Error(`無法解析的token: "${tok.value}"`);
        };

        const rootFn = parseOr();
        if (pos < tokens.length) throw new Error(`表達式結尾有多餘內容: "${tokens[pos].value}"`);
        return rootFn;
    }

    // 一次性求值的便利包裝（給不需要重複呼叫的情境用，例如驗證階段確認
    // 語法正確、或互動viewer的visible_if/enabled_if——每次重新編譯，換取
    // 呼叫端不用自己管理編譯快取的簡單性）。
    _evalSafeExpression(exprText, context) {
        return this._compileSafeExpression(exprText)(context || {});
    }

    // ============================================================
    // tw_stock_db客製: 階段3——3D場景viewer（見計畫文件階段3、redmine參考
    // 文件§13）。純宣告式YAML描述場景（不嵌入真正會執行的JS，理由跟
    // browser_action的封閉動作清單一致——AI生成內容是prompt injection攻擊
    // 面），驗證/展開全部搬到瀏覽器端做（沒有伺服器端）。WebGL初始化失敗時
    // 落到CPU軟體光柵化fallback（_raster3DFrame），OrbitControls互動在
    // 兩條路徑下都能動（只需要camera+DOM事件，不需要真的有WebGLRenderer）。
    // ============================================================

    _validate3DNodeShape(n, where) {
        if (!n || typeof n !== 'object') return `${where} 內有非物件的節點`;
        if (!n.mesh) return `${where} 內有節點缺少mesh欄位`;
        if (!SCENE3D_MESH_TYPES.has(n.mesh)) return `${where} 內有未知的mesh類型: "${n.mesh}"（合法值：${[...SCENE3D_MESH_TYPES].join('/')}）`;
        if (n.animation && !SCENE3D_ANIMATION_TYPES.has(n.animation)) return `${where} 內有未知的animation類型: "${n.animation}"（合法值：spin/bounce/orbit）`;
        return null;
    }

    // tw_stock_db客製: 2026-09-05使用者貼了一份redmine那邊AI實際產生過的
    // 真實場景YAML（生日蛋糕+海洋+山脈+煙火），粒子節點寫的是攤平的
    // particle_preset/particle_count/particle_spread等欄位直接放在node
    // 底下（不是巢狀的particles:{preset,count,...}），color/color2放在
    // material底下——這是已經實際跑過的慣例，這裡在驗證/建構之前先正規化
    // 成內部統一使用的node.particles.xxx形式，讓後面所有既有邏輯
    // （_validate3DSceneYaml的preset/count檢查、六個preset builder、
    // _buildFormulaParticles）都不用另外改，只要餵normalize過的node即可。
    // 兩種寫法（巢狀particles物件 vs 攤平particle_*欄位）都繼續支援，都給
    // 就以巢狀寫法為準。
    _normalize3DParticleNode(node) {
        if (!node || node.mesh !== 'particles') return node;
        const particles = Object.assign({}, node.particles || {});
        Object.keys(node).forEach((key) => {
            if (key.startsWith('particle_') && key.length > 'particle_'.length) {
                const shortKey = key.slice('particle_'.length);
                if (particles[shortKey] === undefined) particles[shortKey] = node[key];
            }
        });
        if (node.material && typeof node.material === 'object') {
            if (particles.color === undefined && node.material.color !== undefined) particles.color = node.material.color;
            if (particles.color2 === undefined && node.material.color2 !== undefined) particles.color2 = node.material.color2;
        }
        return Object.assign({}, node, { particles });
    }

    // defs不可巢狀use（見計畫文件——這個限制讓「檢查循環參照」整個問題不
    // 存在，不需要另外寫圖形走訪防止defs互相參照造成無限展開）。
    _validate3DDefs(defs) {
        for (const [defName, def] of Object.entries(defs)) {
            if (!def || !Array.isArray(def.nodes)) return `defs.${defName} 缺少nodes陣列`;
            for (const n of def.nodes) {
                if (n && n.use) return `defs.${defName} 內的節點不可以再use其他defs（不支援巢狀prefab）`;
                const err = this._validate3DNodeShape(n, `defs.${defName}`);
                if (err) return err;
            }
        }
        return null;
    }

    // 把use節點換成偏移/縮放過的真實節點副本，一律深拷貝，絕不修改defs本身。
    _instantiate3DPrefabNode(node, offset, scale) {
        const cloned = JSON.parse(JSON.stringify(node));
        const pos = Array.isArray(cloned.position) ? cloned.position : [0, 0, 0];
        cloned.position = [
            (pos[0] || 0) * scale + offset[0],
            (pos[1] || 0) * scale + offset[1],
            (pos[2] || 0) * scale + offset[2],
        ];
        if (Array.isArray(cloned.size)) cloned.size = cloned.size.map(v => v * scale);
        if (Number.isFinite(cloned.radius)) cloned.radius *= scale;
        if (Number.isFinite(cloned.height)) cloned.height *= scale;
        return cloned;
    }

    _expand3DSceneNodes(nodes, defs) {
        const result = [];
        for (const n of nodes) {
            if (n && n.use) {
                const def = defs[n.use];
                if (!def) continue; // 未知use名稱：防禦性靜默跳過（正常情況已在validate階段擋過一次，這裡是給手改/過期yaml的防禦）
                const offset = Array.isArray(n.position) ? n.position : [0, 0, 0];
                const scale = Number.isFinite(n.scale) ? n.scale : 1;
                for (const child of def.nodes) result.push(this._instantiate3DPrefabNode(child, offset, scale));
                continue;
            }
            result.push(n);
        }
        return result;
    }

    // 主驗證入口：YAML語法→形狀→defs/use展開→節點數/粒子數上限，全部通過
    // 才回傳ok:true+展開後的節點陣列，任何一步失敗都回傳明確的錯誤訊息
    // （不是籠統的「格式錯誤」，讓AI看得懂哪裡要修正）。
    _validate3DSceneYaml(yamlText) {
        let scene;
        try {
            scene = jsyaml.load(yamlText);
        } catch (err) {
            return { ok: false, error: `YAML語法錯誤: ${err.message}` };
        }
        if (!scene || typeof scene !== 'object') return { ok: false, error: '場景內容必須是一個物件（至少要有nodes陣列）' };
        const nodes = (Array.isArray(scene.nodes) ? scene.nodes : []).map(n => this._normalize3DParticleNode(n));
        if (!nodes.length) return { ok: false, error: '缺少nodes陣列，或nodes是空的' };
        const defs = (scene.defs && typeof scene.defs === 'object') ? scene.defs : {};
        Object.values(defs).forEach((def) => {
            if (def && Array.isArray(def.nodes)) def.nodes = def.nodes.map(n => this._normalize3DParticleNode(n));
        });
        const defsErr = this._validate3DDefs(defs);
        if (defsErr) return { ok: false, error: defsErr };
        // tw_stock_db客製: 2026-09-05使用者明確要求——粒子動畫要能「portable
        // 在model裡，不是寫死在JS引擎內」，新增scene.particle_presets讓YAML
        // 自己註冊自訂preset（init/update/output都是安全表達式公式，見
        // _compileSafeExpression/_buildFormulaParticles），particles.preset
        // 可以是內建六選一，也可以是這裡註冊的自訂名稱。
        const particlePresets = (scene.particle_presets && typeof scene.particle_presets === 'object') ? scene.particle_presets : {};
        const presetsErr = this._validate3DParticlePresets(particlePresets);
        if (presetsErr) return { ok: false, error: presetsErr };
        for (const n of nodes) {
            if (n && n.use) {
                if (!defs[n.use]) return { ok: false, error: `use引用了不存在的defs: "${n.use}"` };
                continue;
            }
            const err = this._validate3DNodeShape(n, 'nodes');
            if (err) return { ok: false, error: err };
        }
        const expanded = this._expand3DSceneNodes(nodes, defs);
        if (expanded.length > SCENE3D_MAX_EXPANDED_NODES) {
            return { ok: false, error: `展開後節點數(${expanded.length})超過上限${SCENE3D_MAX_EXPANDED_NODES}，請減少use次數或nodes數量` };
        }
        for (const n of expanded) {
            if (n.mesh === 'particles') {
                const preset = n.particles && n.particles.preset;
                const isBuiltin = SCENE3D_PARTICLE_PRESETS.has(preset);
                const isCustom = Object.prototype.hasOwnProperty.call(particlePresets, preset);
                if (!isBuiltin && !isCustom) {
                    return { ok: false, error: `particles節點缺少合法的preset——內建preset：spark/flame/mist/bounce/firework/nbody，或scene.particle_presets裡註冊過的自訂名稱，收到: ${preset}` };
                }
                const cap = preset === 'nbody' ? SCENE3D_MAX_NBODY_PARTICLE_COUNT : SCENE3D_MAX_PARTICLE_COUNT;
                const count = Number(n.particles.count) || 0;
                if (count > cap) return { ok: false, error: `particles節點的count(${count})超過${preset}的上限${cap}` };
            }
        }
        return { ok: true, scene, expandedNodes: expanded, particlePresets };
    }

    // 自訂粒子preset的形狀驗證：init/update/output都必須是{變數名:安全表達式字串}
    // 的字典，每個表達式先實際編譯一次確認語法正確（編譯失敗直接回報是哪個
    // preset的哪個欄位錯，不是籠統的錯誤）。
    _validate3DParticlePresets(particlePresets) {
        for (const [name, def] of Object.entries(particlePresets)) {
            if (!def || typeof def !== 'object') return `particle_presets.${name} 必須是一個物件`;
            for (const stage of ['init', 'update', 'output']) {
                const dict = def[stage];
                if (dict == null) continue;
                if (typeof dict !== 'object' || Array.isArray(dict)) return `particle_presets.${name}.${stage} 必須是一個{變數名:表達式}物件`;
                for (const [key, expr] of Object.entries(dict)) {
                    if (typeof expr !== 'string') return `particle_presets.${name}.${stage}.${key} 必須是字串表達式`;
                    try {
                        this._compileSafeExpression(expr);
                    } catch (err) {
                        return `particle_presets.${name}.${stage}.${key} 表達式錯誤: ${err.message}`;
                    }
                }
            }
            if (!def.output || (!def.output.x && !def.output.y && !def.output.z)) {
                return `particle_presets.${name}.output 至少要定義x/y/z其中一個座標公式`;
            }
        }
        return null;
    }

    _build3DGeometryForNode(node) {
        const size = Array.isArray(node.size) ? node.size : [1, 1, 1];
        const radius = Number.isFinite(node.radius) ? node.radius : 1;
        const height = Number.isFinite(node.height) ? node.height : 1;
        switch (node.mesh) {
            case 'box': return new THREE.BoxGeometry(size[0] || 1, size[1] || 1, size[2] || 1);
            case 'sphere': return new THREE.SphereGeometry(radius, 24, 16);
            case 'cylinder': return new THREE.CylinderGeometry(radius, radius, height, 24);
            case 'cone': return new THREE.ConeGeometry(radius, height, 24);
            // tw_stock_db客製: 2026-09-05使用者實測回報——AI寫size:[100,1,100]
            // 描述一片沙灘（明顯是套用box的[寬,高,深]心智模型，中間塞一個
            // 「厚度」占位值），但plane是純2D幾何體，PlaneGeometry(w,h)的h
            // 其實是「第二維長度」，size[1]=1會讓整片沙灘變成只有1個單位
            // 深的細長條——使用者截圖看到的「兩條線」正是這個bug。收到3個
            // 元素的size時，改用size[0]/size[2]（比照box的寬/深），中間的
            // size[1]視為「厚度」直接忽略（plane本來就沒有厚度）；只給2個
            // 元素時維持原本[w,h]的解讀，向下相容。
            case 'plane': {
                const w = size[0] || 1;
                const h = (Array.isArray(node.size) && node.size.length >= 3) ? (size[2] || 1) : (size[1] || 1);
                return new THREE.PlaneGeometry(w, h);
            }
            // tw_stock_db客製: 2026-09-05——使用者貼的redmine真實場景YAML用了
            // tube_radius欄位（甜甜圈的管徑），原本這裡只會自動用radius*0.35
            // 估算，沒有讀取這個欄位，收到tube_radius時優先採用。
            case 'torus': return new THREE.TorusGeometry(radius, Number.isFinite(node.tube_radius) ? node.tube_radius : radius * 0.35, 12, 24);
            case 'polygon': return this._build3DPolygonGeometry(node);
            default: return null;
        }
    }

    // polygon：接受任意3D頂點+可選的三角面index清單(faces)，沒給faces時
    // 用簡單扇形三角化（假設頂點依序繞邊界排列），足以表達自訂形狀（例如
    // 傾斜懸挑屋頂），不追求處理非凸/自我相交這類進階幾何情況。
    // tw_stock_db客製: 2026-09-05使用者要求支援匯入STL/OBJ/3MF/FBX並轉成
    // 這個內部YAML格式（見_convertModelFileToSceneYaml），為了讓這個格式
    // 「設計到可以完整相容」外部網格資料，額外接受選填的normals（逐頂點
    // 法向量，沒給時退回computeVertexNormals()自動估算）、uvs（逐頂點UV，
    // 給了才能正確貼材質貼圖）、colors（逐頂點顏色，給了會覆蓋material.color
    // 變成頂點著色，常見於3MF的color extension）——目前實際的匯入轉換
    // 只會填vertices/faces+單一material.color（純幾何形狀優先，見計畫
    // 文件的取捨說明），但格式本身完整支援這三個欄位，AI手刻場景或未來
    // 需要更高保真度的匯入都能直接使用。
    _build3DPolygonGeometry(node) {
        const verts = Array.isArray(node.vertices) ? node.vertices : [];
        const geo = new THREE.BufferGeometry();
        if (verts.length < 3) return geo;
        let faces = Array.isArray(node.faces) && node.faces.length ? node.faces : null;
        if (!faces) {
            faces = [];
            for (let i = 1; i < verts.length - 1; i++) faces.push([0, i, i + 1]);
        }
        const hasNormals = Array.isArray(node.normals) && node.normals.length === verts.length;
        const hasUvs = Array.isArray(node.uvs) && node.uvs.length === verts.length;
        const hasColors = Array.isArray(node.colors) && node.colors.length === verts.length;
        const positions = [];
        const normals = hasNormals ? [] : null;
        const uvs = hasUvs ? [] : null;
        const colors = hasColors ? [] : null;
        for (const f of faces) {
            for (const idx of f) {
                const v = verts[idx];
                if (!v) continue;
                positions.push(v[0] || 0, v[1] || 0, v[2] || 0);
                if (hasNormals) { const n = node.normals[idx] || [0, 1, 0]; normals.push(n[0] || 0, n[1] || 0, n[2] || 0); }
                if (hasUvs) { const uv = node.uvs[idx] || [0, 0]; uvs.push(uv[0] || 0, uv[1] || 0); }
                if (hasColors) { const c = node.colors[idx] || [1, 1, 1]; colors.push(c[0] ?? 1, c[1] ?? 1, c[2] ?? 1); }
            }
        }
        geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
        if (normals) geo.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
        else geo.computeVertexNormals();
        if (uvs) geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
        if (colors) geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
        return geo;
    }

    // texture_attachment_id（redmine版本指向伺服器端Workspace附件）在這個
    // 無後端架構下沒有對應物——改用texture_url（外部http(s)網址）或
    // texture_data_url（base64 data URL），這是計畫文件記錄過的刻意調整。
    // tw_stock_db客製: 2026-09-05使用者貼了一份redmine那邊AI實際產生過的
    // 真實場景YAML範例（生日蛋糕+海洋+山脈+煙火），material.texture用的是
    // 「water」「grass」這種具名貼圖（不是網址）+texture_repeat（不是
    // texture_uv_scale）——這是已經跑過的實際慣例，不是我方原設計的
    // texture_url/texture_data_url。兩者都支援：texture是http(s)/data:
    // 開頭時當URL用TextureLoader載入，其餘字串當內建具名貼圖查
    // _getBuiltin3DTexture（沒有伺服器附件系統，這幾個是手刻的canvas
    // 程序貼圖，不是真的照片，但比純色更接近使用者對water/grass的直覺）。
    _build3DMaterial(node) {
        const m = node.material || {};
        const params = {
            color: m.color || '#cccccc',
            metalness: Number.isFinite(m.metalness) ? m.metalness : 0.2,
            roughness: Number.isFinite(m.roughness) ? m.roughness : 0.7,
        };
        if (Number.isFinite(m.opacity) && m.opacity < 1) { params.transparent = true; params.opacity = m.opacity; }
        if (m.emissive) {
            params.emissive = m.emissive;
            params.emissiveIntensity = Number.isFinite(m.emissive_intensity) ? m.emissive_intensity : 1;
        }
        const material = new THREE.MeshStandardMaterial(params);
        try {
            let tex = null;
            if (m.texture_url || m.texture_data_url) {
                tex = new THREE.TextureLoader().load(m.texture_url || m.texture_data_url);
            } else if (typeof m.texture === 'string' && m.texture) {
                tex = /^(https?:|data:)/i.test(m.texture)
                    ? new THREE.TextureLoader().load(m.texture)
                    : this._getBuiltin3DTexture(m.texture);
            }
            if (tex) {
                const uvOffset = m.texture_uv_offset;
                const uvScale = m.texture_uv_scale || m.texture_repeat;
                if (Array.isArray(uvOffset)) tex.offset.set(uvOffset[0] || 0, uvOffset[1] || 0);
                if (Array.isArray(uvScale)) tex.repeat.set(uvScale[0] || 1, uvScale[1] || 1);
                material.map = tex;
                material.needsUpdate = true;
            }
        } catch (_) { /* 貼圖載入失敗不影響其餘場景渲染，退回純色 */ }
        return material;
    }

    // 內建具名程序貼圖（canvas手繪出來的簡易花紋，不是照片）——目前涵蓋
    // water/grass/sand/wood/brick五種常見地面/背景材質，沒對到已知名稱時
    // 退回grass當保底，不會渲染失敗。同一個名稱在同一個場景內只會建一次、
    // 快取重複使用。
    _getBuiltin3DTexture(name) {
        this._builtin3DTextureCache = this._builtin3DTextureCache || {};
        if (this._builtin3DTextureCache[name]) return this._builtin3DTextureCache[name];
        const canvas = document.createElement('canvas');
        canvas.width = 64; canvas.height = 64;
        const ctx = canvas.getContext('2d');
        const presets = {
            water: () => {
                ctx.fillStyle = '#1c5d8c'; ctx.fillRect(0, 0, 64, 64);
                ctx.strokeStyle = 'rgba(255,255,255,0.25)';
                for (let y = 6; y < 64; y += 10) {
                    ctx.beginPath(); ctx.moveTo(0, y);
                    for (let x = 0; x <= 64; x += 8) ctx.lineTo(x, y + Math.sin(x * 0.5) * 2);
                    ctx.stroke();
                }
            },
            grass: () => {
                ctx.fillStyle = '#3a7d34'; ctx.fillRect(0, 0, 64, 64);
                for (let i = 0; i < 200; i++) {
                    ctx.fillStyle = Math.random() > 0.5 ? '#4c9a3f' : '#2f6b2a';
                    ctx.fillRect(Math.random() * 64, Math.random() * 64, 1.5, 1.5);
                }
            },
            sand: () => {
                ctx.fillStyle = '#e6d19a'; ctx.fillRect(0, 0, 64, 64);
                for (let i = 0; i < 150; i++) {
                    ctx.fillStyle = 'rgba(0,0,0,0.05)';
                    ctx.fillRect(Math.random() * 64, Math.random() * 64, 1, 1);
                }
            },
            wood: () => {
                ctx.fillStyle = '#8a5a34'; ctx.fillRect(0, 0, 64, 64);
                ctx.strokeStyle = 'rgba(0,0,0,0.15)';
                for (let y = 4; y < 64; y += 8) {
                    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(64, y + Math.sin(y) * 2); ctx.stroke();
                }
            },
            brick: () => {
                ctx.fillStyle = '#a33'; ctx.fillRect(0, 0, 64, 64);
                ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
                for (let y = 0; y < 64; y += 16) {
                    for (let x = (y / 16 % 2) * 8; x < 64; x += 16) ctx.strokeRect(x, y, 16, 16);
                }
            },
        };
        (presets[name] || presets.grass)();
        const tex = new THREE.CanvasTexture(canvas);
        tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        this._builtin3DTextureCache[name] = tex;
        return tex;
    }

    _build3DMeshObject(node, particlePresets) {
        if (node.mesh === 'particles') return this._build3DParticleSystem(node, particlePresets || {});
        const geometry = this._build3DGeometryForNode(node);
        if (!geometry) return null;
        const material = this._build3DMaterial(node);
        // tw_stock_db客製: 2026-09-05使用者實測回報——AI手刻的polygon
        // （例如正四面體，用vertices/faces描述）常常沒辦法保證每個面的
        // winding方向對外一致，一旦某一面winding反過來，法向量會指向內部，
        // WebGL預設的單面背面剔除就會讓那一面直接消失（使用者截圖看到的
        // 「一面三角形不見了」）。要求LLM每次都產出全域一致的外向winding
        // 不切實際，這裡直接把polygon改成雙面渲染（材質+軟體光柵化fallback
        // 都要改，兩邊是各自獨立的剔除實作）——winding錯誤最多只影響那一面
        // 的明暗方向，不會再讓整面消失。box/sphere/cylinder/cone/plane/
        // torus這些內建圖元幾何體本身winding永遠正確，維持單面剔除不受影響
        // （效能/正確性都沒有理由改成雙面）。
        if (node.mesh === 'polygon') {
            material.side = THREE.DoubleSide;
            geometry.userData = geometry.userData || {};
            geometry.userData.faDoubleSided = true;
            // tw_stock_db客製: 有給逐頂點colors時（見_build3DPolygonGeometry）
            // 要開啟vertexColors材質才會真的套用，不然three.js預設無視color
            // BufferAttribute、整片維持material.color那個單一顏色。
            if (geometry.attributes.color) material.vertexColors = true;
        }
        const mesh = new THREE.Mesh(geometry, material);
        const pos = Array.isArray(node.position) ? node.position : [0, 0, 0];
        mesh.position.set(pos[0] || 0, pos[1] || 0, pos[2] || 0);
        if (Array.isArray(node.rotation)) {
            mesh.rotation.set(node.rotation[0] || 0, node.rotation[1] || 0, node.rotation[2] || 0);
        } else if (node.mesh === 'plane') {
            // tw_stock_db客製: plane預設面朝相機（垂直），不是水平躺平——這是
            // 計畫文件記錄過的既知bug教訓，只在使用者沒有明確指定rotation時
            // 才補上-90度讓plane預設當地板用。
            mesh.rotation.x = -Math.PI / 2;
        }
        return mesh;
    }

    _build3DAnimatorForNode(obj, node) {
        const anim = node.animation;
        if (anim === 'spin') {
            const speed = Number.isFinite(node.animation_speed) ? node.animation_speed : 1;
            return () => { obj.rotation.y += 0.02 * speed; };
        }
        if (anim === 'bounce') {
            const baseY = obj.position.y;
            const amplitude = Number.isFinite(node.animation_amplitude) ? node.animation_amplitude : 0.5;
            const freq = Number.isFinite(node.animation_speed) ? node.animation_speed : 2;
            return (t) => { obj.position.y = baseY + amplitude * Math.abs(Math.sin(t * freq)); };
        }
        if (anim === 'orbit') {
            const center = Array.isArray(node.animation_center) ? node.animation_center : [0, obj.position.y, 0];
            const radius = Number.isFinite(node.animation_radius)
                ? node.animation_radius
                : (Math.hypot(obj.position.x - center[0], obj.position.z - center[2]) || 2);
            const speed = Number.isFinite(node.animation_speed) ? node.animation_speed : 1;
            const startAngle = Math.atan2(obj.position.z - center[2], obj.position.x - center[0]);
            return (t) => {
                const angle = startAngle + t * speed;
                obj.position.x = center[0] + radius * Math.cos(angle);
                obj.position.z = center[2] + radius * Math.sin(angle);
            };
        }
        return null;
    }

    // ---- 粒子系統：六種preset，見計畫/redmine參考文件§13.3的逐一說明 ----

    _build3DParticleSystem(node, particlePresets) {
        const preset = node.particles && node.particles.preset;
        let built = null;
        if (preset === 'spark') built = this._buildSparkParticles(node);
        else if (preset === 'flame') built = this._buildFlameLikeParticles(node, { spread: 0.4, speed: 1.2, sway: 0.4, defaultColor1: '#ffcc66', defaultColor2: '#552200' });
        else if (preset === 'mist') built = this._buildFlameLikeParticles(node, { spread: 1.5, speed: 0.35, sway: 0.9, defaultColor1: '#dddddd', defaultColor2: '#aaccee' });
        else if (preset === 'bounce') built = this._buildBounceParticles(node);
        else if (preset === 'firework') built = this._buildFireworkParticles(node);
        else if (preset === 'nbody') built = this._buildNBodyParticles(node);
        else if (particlePresets && particlePresets[preset]) {
            // tw_stock_db客製: 自訂preset（scene.particle_presets註冊的，見
            // _validate3DParticlePresets/_buildFormulaParticles）——動畫邏輯
            // portable在model本身的YAML裡，不是寫死在這個JS引擎裡的六選一。
            built = this._buildFormulaParticles(node, particlePresets[preset]);
        }
        if (!built) return null;
        // tw_stock_db客製: 2026-09-05使用者實測回報「nbody顆粒不會動」「煙火
        // 特效沒看到」——真正根因：所有六種內建preset+自訂formula preset的
        // update()都直接改寫position/color這兩個BufferAttribute背後的
        // Float32Array，但從來沒有標記needsUpdate=true。three.js只有第一次
        // 繪製時會自動上傳GPU緩衝區，之後的每一幀即使JS端的陣列數值真的
        // 有在變（用posAttr.array直接讀確實看得到變化），畫面上看到的還是
        // 第一幀上傳過的那份舊資料，等於視覺上完全靜止——nbody看起來像
        // 「完全沒有在動」、firework看起來像「幾乎沒有效果」都是同一個根因。
        // 集中在這個唯一的組裝入口統一補上needsUpdate，而不是在六個+一個
        // preset builder裡各自重複加一次，避免以後新增preset又忘記加同樣
        // 的兩行。
        const geometry = built.object.geometry;
        const rawUpdate = built.update;
        built.update = (t, dt) => {
            rawUpdate(t, dt);
            if (geometry.attributes.position) geometry.attributes.position.needsUpdate = true;
            if (geometry.attributes.color) geometry.attributes.color.needsUpdate = true;
        };
        return built;
    }

    _new3DPointsBase(count, sizeDefault) {
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const material = new THREE.PointsMaterial({ size: sizeDefault, vertexColors: true, transparent: true, depthWrite: false });
        return { positions, colors, points: new THREE.Points(geometry, material) };
    }

    // spark：從position往外/往上噴出，真的套用重力，顏色隨年齡從color冷卻到
    // color2，超過壽命就在原地重生形成連續噴發循環。
    _buildSparkParticles(node) {
        const p = node.particles || {};
        const count = Math.min(Number(p.count) || 200, SCENE3D_MAX_PARTICLE_COUNT);
        const basePos = Array.isArray(node.position) ? node.position : [0, 0, 0];
        const color1 = new THREE.Color(p.color || '#ffffff');
        const color2 = new THREE.Color(p.color2 || '#661100');
        const gravity = Number.isFinite(p.gravity) ? p.gravity : -3;
        const { positions, colors, points } = this._new3DPointsBase(count, Number.isFinite(p.size) ? p.size : 0.08);
        const vel = new Float32Array(count * 3), age = new Float32Array(count), life = new Float32Array(count);
        const reset = (i) => {
            positions[i * 3] = basePos[0]; positions[i * 3 + 1] = basePos[1]; positions[i * 3 + 2] = basePos[2];
            const theta = Math.random() * Math.PI * 2, phi = Math.random() * Math.PI * 0.4;
            const speed = 1.5 + Math.random() * 2.5;
            vel[i * 3] = Math.cos(theta) * Math.sin(phi) * speed;
            vel[i * 3 + 1] = Math.cos(phi) * speed + 1.5;
            vel[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * speed;
            age[i] = 0; life[i] = 0.5 + Math.random() * 0.6;
            colors[i * 3] = color1.r; colors[i * 3 + 1] = color1.g; colors[i * 3 + 2] = color1.b;
        };
        for (let i = 0; i < count; i++) reset(i);
        const update = (t, dt) => {
            for (let i = 0; i < count; i++) {
                age[i] += dt;
                if (age[i] > life[i]) { reset(i); continue; }
                vel[i * 3 + 1] += gravity * dt;
                positions[i * 3] += vel[i * 3] * dt; positions[i * 3 + 1] += vel[i * 3 + 1] * dt; positions[i * 3 + 2] += vel[i * 3 + 2] * dt;
                const f = age[i] / life[i];
                colors[i * 3] = color1.r + (color2.r - color1.r) * f;
                colors[i * 3 + 1] = color1.g + (color2.g - color1.g) * f;
                colors[i * 3 + 2] = color1.b + (color2.b - color1.b) * f;
            }
        };
        return { object: points, update, isParticleSystem: true };
    }

    // flame/mist共用同一種機制（往上升+亂流擾動+顏色從底部到尖端漸變），
    // 差別只在spread/speed/sway/預設顏色（flame橘黃→暗紅較快較窄；mist
    // 灰白→淡藍白較慢較廣，見_build3DParticleSystem呼叫端的opts）。
    _buildFlameLikeParticles(node, opts) {
        const p = node.particles || {};
        const count = Math.min(Number(p.count) || 150, SCENE3D_MAX_PARTICLE_COUNT);
        const basePos = Array.isArray(node.position) ? node.position : [0, 0, 0];
        const color1 = new THREE.Color(p.color || opts.defaultColor1);
        const color2 = new THREE.Color(p.color2 || opts.defaultColor2);
        const spread = Number.isFinite(p.spread) ? p.spread : opts.spread;
        const riseSpeed = Number.isFinite(p.rise_speed) ? p.rise_speed : opts.speed;
        const sway = Number.isFinite(p.sway) ? p.sway : opts.sway;
        const { positions, colors, points } = this._new3DPointsBase(count, Number.isFinite(p.size) ? p.size : 0.15);
        const age = new Float32Array(count), life = new Float32Array(count), phase = new Float32Array(count);
        const seedX = new Float32Array(count), seedZ = new Float32Array(count);
        const reset = (i) => {
            age[i] = 0; life[i] = 0.8 + Math.random() * 0.8; phase[i] = Math.random() * Math.PI * 2;
            seedX[i] = (Math.random() - 0.5) * spread; seedZ[i] = (Math.random() - 0.5) * spread;
            positions[i * 3] = basePos[0] + seedX[i] * 0.2;
            positions[i * 3 + 1] = basePos[1];
            positions[i * 3 + 2] = basePos[2] + seedZ[i] * 0.2;
            colors[i * 3] = color1.r; colors[i * 3 + 1] = color1.g; colors[i * 3 + 2] = color1.b;
        };
        for (let i = 0; i < count; i++) reset(i);
        const update = (t, dt) => {
            for (let i = 0; i < count; i++) {
                age[i] += dt;
                if (age[i] > life[i]) { reset(i); continue; }
                const f = age[i] / life[i];
                positions[i * 3 + 1] += riseSpeed * dt;
                positions[i * 3] = basePos[0] + seedX[i] * (0.2 + f * spread) + Math.sin(t * 2 + phase[i]) * sway * f * 0.3;
                positions[i * 3 + 2] = basePos[2] + seedZ[i] * (0.2 + f * spread) + Math.cos(t * 2 + phase[i]) * sway * f * 0.3;
                colors[i * 3] = color1.r + (color2.r - color1.r) * f;
                colors[i * 3 + 1] = color1.g + (color2.g - color1.g) * f;
                colors[i * 3 + 2] = color1.b + (color2.b - color1.b) * f;
            }
        };
        return { object: points, update, isParticleSystem: true };
    }

    // bounce：刻意用封閉解y=amplitude*|sin(t*freq+phase)|而不是追蹤真實
    // 速度/阻尼，保證每個球永遠彈到同樣高度、永不停止、天生完美循環。
    _buildBounceParticles(node) {
        const p = node.particles || {};
        const count = Math.min(Number(p.count) || 100, SCENE3D_MAX_PARTICLE_COUNT);
        const basePos = Array.isArray(node.position) ? node.position : [0, 0, 0];
        const color1 = new THREE.Color(p.color || '#ffffff');
        const spreadRadius = Number.isFinite(p.spread) ? p.spread : 2;
        const amplitude = Number.isFinite(p.amplitude) ? p.amplitude : 1;
        const freq = Number.isFinite(p.frequency) ? p.frequency : 2;
        const { positions, colors, points } = this._new3DPointsBase(count, Number.isFinite(p.size) ? p.size : 0.12);
        const seedX = new Float32Array(count), seedZ = new Float32Array(count), phase = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const ang = Math.random() * Math.PI * 2, r = Math.random() * spreadRadius;
            seedX[i] = Math.cos(ang) * r; seedZ[i] = Math.sin(ang) * r; phase[i] = Math.random() * Math.PI * 2;
            colors[i * 3] = color1.r; colors[i * 3 + 1] = color1.g; colors[i * 3 + 2] = color1.b;
        }
        const update = (t) => {
            for (let i = 0; i < count; i++) {
                positions[i * 3] = basePos[0] + seedX[i];
                positions[i * 3 + 1] = basePos[1] + amplitude * Math.abs(Math.sin(t * freq + phase[i]));
                positions[i * 3 + 2] = basePos[2] + seedZ[i];
            }
        };
        return { object: points, update, isParticleSystem: true };
    }

    // firework：用t%cycle直接取模實作重複的「發射-爆炸-淡出」循環，天生
    // 完美循環不需要額外狀態；粒子數夠多時自動分成好幾組、每組不同的相位
    // 偏移，畫面上同時看得到好幾發交錯的煙火。
    _buildFireworkParticles(node) {
        const p = node.particles || {};
        const count = Math.min(Number(p.count) || 300, SCENE3D_MAX_PARTICLE_COUNT);
        const basePos = Array.isArray(node.position) ? node.position : [0, 0, 0];
        const color1 = new THREE.Color(p.color || '#ffaa00');
        const color2 = new THREE.Color(p.color2 || '#ff2222');
        const cycle = Number.isFinite(p.cycle) ? p.cycle : 3;
        const groupCount = Math.max(1, Math.min(6, Math.round(count / 50)));
        const perGroup = Math.max(1, Math.floor(count / groupCount));
        const { positions, colors, points } = this._new3DPointsBase(count, Number.isFinite(p.size) ? p.size : 0.1);
        const groupOf = new Int32Array(count);
        const dirX = new Float32Array(count), dirY = new Float32Array(count), dirZ = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            groupOf[i] = Math.min(groupCount - 1, Math.floor(i / perGroup));
            const theta = Math.random() * Math.PI * 2, phi = Math.acos(2 * Math.random() - 1);
            dirX[i] = Math.sin(phi) * Math.cos(theta); dirY[i] = Math.cos(phi); dirZ[i] = Math.sin(phi) * Math.sin(theta);
        }
        const groupPhase = new Float32Array(groupCount);
        for (let g = 0; g < groupCount; g++) groupPhase[g] = (g / groupCount) * cycle;
        const update = (t) => {
            for (let i = 0; i < count; i++) {
                const g = groupOf[i];
                const localT = (t + groupPhase[g]) % cycle;
                let ex, ey, ez, brightness;
                if (localT < cycle * 0.3) {
                    const f = localT / (cycle * 0.3);
                    ex = basePos[0]; ey = basePos[1] + f * 3; ez = basePos[2];
                    brightness = 0.3;
                } else {
                    const f = (localT - cycle * 0.3) / (cycle * 0.7);
                    const expandR = f * 2.5;
                    ex = basePos[0] + dirX[i] * expandR;
                    ey = basePos[1] + 3 + dirY[i] * expandR - f * f * 1.5;
                    ez = basePos[2] + dirZ[i] * expandR;
                    brightness = Math.max(0, 1 - f);
                }
                positions[i * 3] = ex; positions[i * 3 + 1] = ey; positions[i * 3 + 2] = ez;
                colors[i * 3] = (color1.r + (color2.r - color1.r) * 0.3) * brightness;
                colors[i * 3 + 1] = (color1.g + (color2.g - color1.g) * 0.3) * brightness;
                colors[i * 3 + 2] = (color1.b + (color2.b - color1.b) * 0.3) * brightness;
            }
        };
        return { object: points, update, isParticleSystem: true };
    }

    // nbody：真正的小規模相互重力模擬，O(n²)每幀，softening避免距離趨近0
    // 時力道爆炸；因為是O(n²)，count另外裁切到比一般preset更低的上限。
    _buildNBodyParticles(node) {
        const p = node.particles || {};
        const count = Math.min(Number(p.count) || 20, SCENE3D_MAX_NBODY_PARTICLE_COUNT);
        const basePos = Array.isArray(node.position) ? node.position : [0, 0, 0];
        const color1 = new THREE.Color(p.color || '#88ccff');
        const spread = Number.isFinite(p.spread) ? p.spread : 2;
        // tw_stock_db客製: 2026-09-05使用者實測回報「顆粒都不會動」——舊預設
        // g=0.5、粒子從完全靜止開始，純引力積分要好幾秒才會累積出肉眼看得
        // 出來的位移量，第一印象就是「沒在動」。提高預設g，且不再從零速度
        // 開始：改給每個粒子一個跟半徑相關的切向初速度（模擬迷你星系自帶
        // 角動量），從第一幀就看得到粒子繞著彼此轉，之後才逐漸因為真正的
        // O(n²)引力交互作用偏離簡單圓周軌道——效果立即可見，同時仍然是
        // 真正的物理模擬，不是預錄動畫。
        const g = Number.isFinite(p.g) ? p.g : 1.5;
        const softening = Number.isFinite(p.softening) ? p.softening : 0.2;
        const { positions, colors, points } = this._new3DPointsBase(count, Number.isFinite(p.size) ? p.size : 0.15);
        const vel = new Float32Array(count * 3), mass = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            const ang = Math.random() * Math.PI * 2, r = 0.3 + Math.random() * spread, h = (Math.random() - 0.5) * spread * 0.4;
            positions[i * 3] = basePos[0] + Math.cos(ang) * r;
            positions[i * 3 + 1] = basePos[1] + h;
            positions[i * 3 + 2] = basePos[2] + Math.sin(ang) * r;
            mass[i] = 0.5 + Math.random();
            const tangentialSpeed = 0.6 * Math.sqrt(r);
            vel[i * 3] = -Math.sin(ang) * tangentialSpeed;
            vel[i * 3 + 2] = Math.cos(ang) * tangentialSpeed;
            colors[i * 3] = color1.r; colors[i * 3 + 1] = color1.g; colors[i * 3 + 2] = color1.b;
        }
        const update = (t, dt) => {
            const ax = new Float32Array(count), ay = new Float32Array(count), az = new Float32Array(count);
            for (let i = 0; i < count; i++) {
                for (let j = i + 1; j < count; j++) {
                    const dx = positions[j * 3] - positions[i * 3];
                    const dy = positions[j * 3 + 1] - positions[i * 3 + 1];
                    const dz = positions[j * 3 + 2] - positions[i * 3 + 2];
                    const distSq = dx * dx + dy * dy + dz * dz + softening * softening;
                    const dist = Math.sqrt(distSq);
                    const force = g / distSq;
                    const fx = force * dx / dist, fy = force * dy / dist, fz = force * dz / dist;
                    ax[i] += fx * mass[j]; ay[i] += fy * mass[j]; az[i] += fz * mass[j];
                    ax[j] -= fx * mass[i]; ay[j] -= fy * mass[i]; az[j] -= fz * mass[i];
                }
            }
            for (let i = 0; i < count; i++) {
                vel[i * 3] += ax[i] * dt; vel[i * 3 + 1] += ay[i] * dt; vel[i * 3 + 2] += az[i] * dt;
                positions[i * 3] += vel[i * 3] * dt; positions[i * 3 + 1] += vel[i * 3 + 1] * dt; positions[i * 3 + 2] += vel[i * 3 + 2] * dt;
            }
        };
        return { object: points, update, isParticleSystem: true };
    }

    // tw_stock_db客製: 2026-09-05使用者明確要求——粒子動畫要能「portable在
    // model裡，不是寫死在JS引擎內」，這是自訂preset（scene.particle_presets
    // 註冊，見_validate3DParticlePresets）的實際執行引擎。三個階段：
    // init（粒子誕生/重生時算一次，結果存進該粒子的自訂狀態）、update
    // （每幀先跑，可以更新自訂狀態裡的變數，例如累加位移）、output（每幀
    // 算出最終的x/y/z/r/g/b，選填alive決定要不要重生）。每個公式只在
    // 「建立這個粒子系統時」編譯一次（_compileSafeExpression），每幀/每
    // 粒子只是呼叫已編譯好的closure，不會每幀重新斷詞/語法分析。
    _buildFormulaParticles(node, presetDef) {
        const p = node.particles || {};
        const count = Math.min(Number(p.count) || presetDef.count_default || 200, SCENE3D_MAX_PARTICLE_COUNT);
        const basePos = Array.isArray(node.position) ? node.position : [0, 0, 0];
        const { positions, colors, points } = this._new3DPointsBase(count, Number.isFinite(p.size) ? p.size : 0.1);

        const compileStage = (dict) => {
            const compiled = {};
            for (const [key, expr] of Object.entries(dict || {})) compiled[key] = this._compileSafeExpression(expr);
            return compiled;
        };
        const initFns = compileStage(presetDef.init);
        const updateFns = compileStage(presetDef.update);
        const outputFns = compileStage(presetDef.output);

        // particles節點底下除了preset/count/size之外的其餘欄位，原樣併入
        // context給init/update/output公式參照（例如自訂的gravity/spread等
        // 參數），跟內建preset讀node.particles.xxx是同一個精神。
        const customParams = {};
        Object.keys(p).forEach((k) => { if (!['preset', 'count', 'size'].includes(k)) customParams[k] = p[k]; });
        const baseCtx = { base_x: basePos[0], base_y: basePos[1], base_z: basePos[2], ...customParams };

        const age = new Float32Array(count);
        const state = new Array(count);
        const resetParticle = (i) => {
            age[i] = 0;
            const s = {};
            for (const [key, fn] of Object.entries(initFns)) s[key] = fn({ ...baseCtx, ...s });
            state[i] = s;
        };
        for (let i = 0; i < count; i++) resetParticle(i);

        const update = (t, dt) => {
            for (let i = 0; i < count; i++) {
                age[i] += dt;
                const updCtx = { ...baseCtx, ...state[i], age: age[i], t, dt };
                for (const [key, fn] of Object.entries(updateFns)) state[i][key] = fn(updCtx);
                const outCtx = { ...baseCtx, ...state[i], age: age[i], t, dt };
                if (outputFns.alive && !outputFns.alive(outCtx)) { resetParticle(i); continue; }
                const ox = outputFns.x ? outputFns.x(outCtx) : basePos[0];
                const oy = outputFns.y ? outputFns.y(outCtx) : basePos[1];
                const oz = outputFns.z ? outputFns.z(outCtx) : basePos[2];
                const or_ = outputFns.r != null ? outputFns.r(outCtx) : 1;
                const og = outputFns.g != null ? outputFns.g(outCtx) : 1;
                const ob = outputFns.b != null ? outputFns.b(outCtx) : 1;
                positions[i * 3] = ox; positions[i * 3 + 1] = oy; positions[i * 3 + 2] = oz;
                colors[i * 3] = Math.max(0, Math.min(1, Number(or_) || 0));
                colors[i * 3 + 1] = Math.max(0, Math.min(1, Number(og) || 0));
                colors[i * 3 + 2] = Math.max(0, Math.min(1, Number(ob) || 0));
            }
        };
        return { object: points, update, isParticleSystem: true };
    }

    // ---- CPU軟體光柵化fallback（WebGLRenderer建立失敗時使用） ----

    // 把場景裡所有Mesh的世界座標三角形投影到螢幕座標、依深度排序後逐一
    // 填色（painter's algorithm，不是真正的z-buffer），法向量點光源方向
    // 當作簡易平面明暗；粒子（THREE.Points）改用獨立的fillRect繪製步驟，
    // 疊在mesh三角形之後畫（跟參考實作一致）。刻意不支援材質貼圖取樣
    // （退化成純色近似），也沒有真正的疊加混合/發光後製特效——這些都是
    // 計畫文件記錄過的已知取捨。
    _raster3DFrame(scene, camera, ctx, width, height) {
        ctx.fillStyle = '#111318';
        ctx.fillRect(0, 0, width, height);
        camera.updateMatrixWorld();
        const vpMatrix = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        const lightDir = new THREE.Vector3(0.5, 1, 0.3).normalize();

        const project = (v3) => {
            const p = v3.clone().applyMatrix4(vpMatrix);
            return { x: (p.x * 0.5 + 0.5) * width, y: (1 - (p.y * 0.5 + 0.5)) * height, behind: p.z > 1 || p.z < -1 };
        };

        const triangles = [];
        scene.traverse((obj) => {
            if (!obj.isMesh || !obj.geometry) return;
            obj.updateMatrixWorld();
            const posAttr = obj.geometry.attributes.position;
            if (!posAttr) return;
            const index = obj.geometry.index;
            const worldMatrix = obj.matrixWorld;
            const color = (obj.material && obj.material.color) ? obj.material.color : new THREE.Color('#cccccc');
            // tw_stock_db客製: 2026-09-05——跟_build3DMeshObject的DoubleSide
            // 修法對稱：polygon的geometry.userData.faDoubleSided為true時，
            // 這條路徑（軟體光柵化，WebGL以外獨立的另一套剔除實作，兩邊都要
            // 修）也要放棄背面剔除，並用abs()明暗（見下面），winding反過來
            // 的面才不會直接消失或整片死黑。
            const doubleSided = !!(obj.geometry.userData && obj.geometry.userData.faDoubleSided);
            const getVertex = (idx) => new THREE.Vector3().fromBufferAttribute(posAttr, idx).applyMatrix4(worldMatrix);
            const triCount = index ? Math.floor(index.count / 3) : Math.floor(posAttr.count / 3);
            for (let t = 0; t < triCount; t++) {
                const i0 = index ? index.getX(t * 3) : t * 3;
                const i1 = index ? index.getX(t * 3 + 1) : t * 3 + 1;
                const i2 = index ? index.getX(t * 3 + 2) : t * 3 + 2;
                const a = getVertex(i0), b = getVertex(i1), c = getVertex(i2);
                const normal = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).normalize();
                const rawDot = normal.dot(lightDir);
                const brightness = Math.max(0.25, doubleSided ? Math.abs(rawDot) : rawDot);
                const depth = a.distanceTo(camera.position) + b.distanceTo(camera.position) + c.distanceTo(camera.position);
                triangles.push({ a, b, c, color, brightness, depth, doubleSided });
            }
        });
        triangles.sort((x, y) => y.depth - x.depth);

        for (const tri of triangles) {
            const pa = project(tri.a), pb = project(tri.b), pc = project(tri.c);
            if (pa.behind || pb.behind || pc.behind) continue;
            const area = (pb.x - pa.x) * (pc.y - pa.y) - (pc.x - pa.x) * (pb.y - pa.y);
            if (!tri.doubleSided && area >= 0) continue; // 背面剔除（螢幕座標y向下，正面三角形投影後帶負面積）；doubleSided的polygon不剔除
            const c = tri.color;
            const r = Math.min(255, Math.round(c.r * 255 * tri.brightness));
            const g = Math.min(255, Math.round(c.g * 255 * tri.brightness));
            const b = Math.min(255, Math.round(c.b * 255 * tri.brightness));
            ctx.fillStyle = `rgb(${r},${g},${b})`;
            ctx.beginPath();
            ctx.moveTo(pa.x, pa.y);
            ctx.lineTo(pb.x, pb.y);
            ctx.lineTo(pc.x, pc.y);
            ctx.closePath();
            ctx.fill();
        }

        scene.traverse((obj) => {
            if (!obj.isPoints || !obj.geometry) return;
            obj.updateMatrixWorld();
            const posAttr = obj.geometry.attributes.position;
            const colorAttr = obj.geometry.attributes.color;
            if (!posAttr || !colorAttr) return;
            for (let i = 0; i < posAttr.count; i++) {
                const v = new THREE.Vector3().fromBufferAttribute(posAttr, i).applyMatrix4(obj.matrixWorld);
                const proj = project(v);
                if (proj.behind) continue;
                const r = Math.round(Math.min(1, Math.max(0, colorAttr.getX(i))) * 255);
                const g = Math.round(Math.min(1, Math.max(0, colorAttr.getY(i))) * 255);
                const b = Math.round(Math.min(1, Math.max(0, colorAttr.getZ(i))) * 255);
                ctx.fillStyle = `rgb(${r},${g},${b})`;
                ctx.fillRect(proj.x - 2, proj.y - 2, 4, 4);
            }
        });
    }

    // ---- 掛載/渲染迴圈 ----

    // 把一段場景YAML掛到container底下：建THREE.Scene/camera/lights/nodes，
    // 試著建立WebGLRenderer，失敗就落到_raster3DFrame軟體光柵化；不管走
    // 哪條路徑都用真正的THREE.OrbitControls處理滑鼠互動（只需要camera+DOM
    // 事件，不需要WebGLRenderer存在），每幀先跑完animators（含粒子系統的
    // update）再渲染，frameIndex/60當作動畫時間軸，方便exportSnapshot時
    // 用整數幀數快轉。回傳null代表驗證/建立失敗（container已經填入錯誤
    // 訊息），呼叫端不需要再處理。
    async _mount3DScene(container, yamlText) {
        await this._ensureJsYamlLoaded();
        const validation = this._validate3DSceneYaml(yamlText);
        if (!validation.ok) {
            container.innerHTML = `<div style="padding:10px 12px; color:#e53e3e; font-size:12px; background:#fff5f5; border-radius:6px;">⚠️ 3D場景格式錯誤：${this._escapeHtml(validation.error)}</div>`;
            return null;
        }
        try {
            await this._ensureThreeJsLoaded();
        } catch (err) {
            container.innerHTML = `<div style="padding:10px 12px; color:#e53e3e; font-size:12px; background:#fff5f5; border-radius:6px;">⚠️ 3D函式庫載入失敗：${this._escapeHtml(err.message || String(err))}</div>`;
            return null;
        }
        const sceneDef = validation.scene;
        const width = Math.max(240, container.clientWidth || 480);
        const height = Math.round(width * 0.65);
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        canvas.style.cssText = 'width:100%; height:auto; display:block; border-radius:8px; touch-action:none; background:#111318;';
        container.appendChild(canvas);

        const scene = new THREE.Scene();
        scene.background = new THREE.Color(sceneDef.background || '#111318');
        const camDef = sceneDef.camera || {};
        const camera = new THREE.PerspectiveCamera(camDef.fov || 50, width / height, 0.1, 1000);
        const camPos = Array.isArray(camDef.position) ? camDef.position : [4, 3, 6];
        camera.position.set(camPos[0], camPos[1], camPos[2]);
        const lookAt = Array.isArray(camDef.look_at) ? camDef.look_at : [0, 0, 0];
        camera.lookAt(new THREE.Vector3(lookAt[0], lookAt[1], lookAt[2]));

        const lights = (Array.isArray(sceneDef.lights) && sceneDef.lights.length)
            ? sceneDef.lights
            : [{ type: 'directional', position: [5, 8, 5], intensity: 1 }, { type: 'ambient', intensity: 0.4 }];
        lights.forEach((l) => {
            if (l.type === 'ambient') {
                scene.add(new THREE.AmbientLight(l.color || '#ffffff', Number.isFinite(l.intensity) ? l.intensity : 0.4));
            } else if (l.type === 'point') {
                const pl = new THREE.PointLight(l.color || '#ffffff', Number.isFinite(l.intensity) ? l.intensity : 1);
                const p = Array.isArray(l.position) ? l.position : [0, 3, 0];
                pl.position.set(p[0], p[1], p[2]);
                scene.add(pl);
            } else {
                const dl = new THREE.DirectionalLight(l.color || '#ffffff', Number.isFinite(l.intensity) ? l.intensity : 1);
                const p = Array.isArray(l.position) ? l.position : [5, 8, 5];
                dl.position.set(p[0], p[1], p[2]);
                scene.add(dl);
            }
        });

        const animators = [];
        for (const node of validation.expandedNodes) {
            const built = this._build3DMeshObject(node);
            if (!built) continue;
            if (built.isParticleSystem) {
                scene.add(built.object);
                animators.push(built.update);
            } else {
                scene.add(built);
                const animFn = this._build3DAnimatorForNode(built, node);
                if (animFn) animators.push(animFn);
            }
        }

        let renderer = null;
        let webglOk = false;
        try {
            renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
            renderer.setSize(width, height, false);
            webglOk = true;
        } catch (_) {
            webglOk = false;
        }
        const ctx2d = webglOk ? null : canvas.getContext('2d');

        let controls = null;
        try {
            controls = new THREE.OrbitControls(camera, canvas);
            controls.enableDamping = true;
            controls.target.set(lookAt[0], lookAt[1], lookAt[2]);
            controls.update();
        } catch (_) { controls = null; }

        let frameIndex = 0;
        let stopped = false;
        const renderOnce = () => {
            const t = frameIndex / 60;
            for (const fn of animators) fn(t, 1 / 60);
            if (controls) controls.update();
            if (webglOk) renderer.render(scene, camera);
            else this._raster3DFrame(scene, camera, ctx2d, width, height);
            frameIndex++;
        };
        const loop = () => {
            if (stopped) return;
            renderOnce();
            requestAnimationFrame(loop);
        };
        loop();

        return {
            scene, camera, canvas, webglOk,
            title: (typeof sceneDef.title === 'string' && sceneDef.title.trim()) ? sceneDef.title.trim() : null,
            stop: () => { stopped = true; if (controls) controls.dispose(); },
            // tw_stock_db客製: 2026-09-05使用者要求——右下角要有「重設視角」
            // 按鈕，把camera位置/朝向、OrbitControls的target都還原成場景YAML
            // 一開始定義的camera.position/look_at，不是重新掛載整個場景（那樣
            // 會讓動畫/粒子系統的累積狀態也跟著重置，使用者只是想恢復視角，
            // 不是重新播放整個場景）。
            resetView: () => {
                camera.position.set(camPos[0], camPos[1], camPos[2]);
                camera.lookAt(new THREE.Vector3(lookAt[0], lookAt[1], lookAt[2]));
                if (controls) { controls.target.set(lookAt[0], lookAt[1], lookAt[2]); controls.update(); }
            },
            // 匯出前先快轉90幀（1.5秒），讓靜態圖抓到「效果進行中」的畫面，
            // 不是動畫剛開始播放、還沒真的動起來的初始退化姿態。
            snapshotDataUri: () => {
                for (let i = 0; i < 90; i++) {
                    frameIndex++;
                    const t = frameIndex / 60;
                    for (const fn of animators) fn(t, 1 / 60);
                }
                if (controls) controls.update();
                if (webglOk) renderer.render(scene, camera); else this._raster3DFrame(scene, camera, ctx2d, width, height);
                return canvas.toDataURL('image/png');
            },
        };
    }

    // ============================================================
    // tw_stock_db客製: 階段5——互動式viewer（見計畫文件階段5）。純宣告式
    // YAML描述多頁表單/精靈流程，元件顯示/啟用條件用_compileSafeExpression
    // （跟階段3自訂粒子preset共用同一套安全表達式評估器，見使用者2026-09-05
    // 確認的折衷方案：允許有限白名單運算式，不是任意JS）。狀態存in-memory+
    // this.stateStore（KVStore，見計畫文件），元件是固定封閉字彙
    // （text/input/button/subagent_panel），不是任意HTML/JS。
    // ============================================================

    _validateInteractiveViewerYaml(yamlText) {
        let viewer;
        try {
            viewer = jsyaml.load(yamlText);
        } catch (err) {
            return { ok: false, error: `YAML語法錯誤: ${err.message}` };
        }
        if (!viewer || typeof viewer !== 'object') return { ok: false, error: 'viewer內容必須是一個物件' };
        if (!viewer.state_namespace || typeof viewer.state_namespace !== 'string') {
            return { ok: false, error: '缺少state_namespace（字串）——這個viewer的狀態要存在persistentStorage的哪個位置，必須明確指定，才能之後用get_viewer_state查詢' };
        }
        const pages = Array.isArray(viewer.pages) ? viewer.pages : null;
        if (!pages || !pages.length) return { ok: false, error: '缺少pages陣列，或pages是空的' };
        const seenIds = new Set();
        for (const page of pages) {
            if (!page || typeof page !== 'object' || !page.id) return { ok: false, error: '每個page都要有id欄位' };
            if (seenIds.has(page.id)) return { ok: false, error: `page id重複: "${page.id}"` };
            seenIds.add(page.id);
            for (const c of (Array.isArray(page.components) ? page.components : [])) {
                const err = this._validateViewerComponentShape(c, page.id);
                if (err) return { ok: false, error: err };
            }
        }
        for (const page of pages) {
            for (const c of (page.components || [])) {
                if (c.type === 'button' && typeof c.action === 'string' && c.action.startsWith('goto_page:')) {
                    const target = c.action.slice('goto_page:'.length);
                    if (!seenIds.has(target)) return { ok: false, error: `page "${page.id}" 的button action goto_page指向不存在的page id: "${target}"` };
                }
                if (c.type === 'subagent_panel') {
                    if (!c.domain) return { ok: false, error: `page "${page.id}" 的subagent_panel缺少domain` };
                    const d = SUBAGENT_DOMAIN_REGISTRY[c.domain];
                    if (!d || !d.enabled) return { ok: false, error: `page "${page.id}" 的subagent_panel指向未啟用的domain: "${c.domain}"` };
                }
            }
        }
        return { ok: true, viewer };
    }

    _validateViewerComponentShape(c, pageId) {
        if (!c || typeof c !== 'object' || !VIEWER_COMPONENT_TYPES.has(c.type)) {
            return `page "${pageId}" 內有未知的component類型: "${c && c.type}"（合法值：${[...VIEWER_COMPONENT_TYPES].join('/')}）`;
        }
        if (c.type === 'input') {
            if (!c.state_key) return `page "${pageId}" 的input元件缺少state_key`;
            if (c.input_type && !VIEWER_INPUT_TYPES.has(c.input_type)) return `page "${pageId}" 的input元件有未知的input_type: "${c.input_type}"`;
        }
        if (c.type === 'button' && c.action) {
            const actionKind = String(c.action).split(':')[0];
            if (!VIEWER_ACTION_KINDS.has(actionKind)) return `page "${pageId}" 的button有未知的action: "${c.action}"（合法值：${[...VIEWER_ACTION_KINDS].join('/')}或goto_page:頁面id）`;
        }
        for (const exprField of ['visible_if', 'enabled_if']) {
            if (c[exprField]) {
                try { this._compileSafeExpression(c[exprField]); } catch (err) { return `page "${pageId}" 的${exprField}表達式錯誤: ${err.message}`; }
            }
        }
        return null;
    }

    // 把viewer掛到container底下：目前頁面/表單狀態存成closure裡的區域變數
    // （state），每次互動後就地更新+重繪整個container（元件數量通常很小，
    // 不需要virtual DOM diff那種複雜度）。首次掛載時從this.stateStore讀出
    // 上次save_state存過的狀態當初始值，讓使用者離開又回來的viewer（例如
    // 重新整理頁面）能接續填過的內容。
    async _mountInteractiveViewer(container, viewerDef) {
        const stateNamespace = `viewer:${viewerDef.state_namespace}`;
        const persisted = (await this.stateStore.get(stateNamespace)) || {};
        const state = Object.assign({}, persisted);
        let currentPageIndex = 0;

        const dispatchAction = async (action) => {
            if (action === 'next_page') { currentPageIndex = Math.min(viewerDef.pages.length - 1, currentPageIndex + 1); render(); return; }
            if (action === 'prev_page') { currentPageIndex = Math.max(0, currentPageIndex - 1); render(); return; }
            if (action.startsWith('goto_page:')) {
                const idx = viewerDef.pages.findIndex(p => p.id === action.slice('goto_page:'.length));
                if (idx !== -1) { currentPageIndex = idx; render(); }
                return;
            }
            if (action === 'save_state') { await this.stateStore.set(stateNamespace, state); render(); return; }
            if (action === 'close') { container.innerHTML = '<div style="padding:8px; font-size:12px; opacity:0.6;">（已關閉）</div>'; return; }
        };

        const render = () => {
            container.innerHTML = '';
            const page = viewerDef.pages[currentPageIndex];
            const pageDiv = document.createElement('div');
            pageDiv.style.cssText = 'padding:10px; border:1px solid rgba(0,0,0,0.12); border-radius:8px;';
            if (viewerDef.pages.length > 1) {
                const nav = document.createElement('div');
                nav.style.cssText = 'font-size:10px; opacity:0.6; margin-bottom:6px;';
                nav.textContent = `第 ${currentPageIndex + 1} / ${viewerDef.pages.length} 頁`;
                pageDiv.appendChild(nav);
            }
            if (page.title) {
                const h = document.createElement('div');
                h.style.cssText = 'font-weight:bold; margin-bottom:8px; font-size:14px;';
                h.textContent = page.title;
                pageDiv.appendChild(h);
            }
            (page.components || []).forEach((c) => {
                if (c.visible_if) {
                    let visible = true;
                    try { visible = !!this._evalSafeExpression(c.visible_if, state); } catch (_) { /* 表達式錯誤時預設顯示，不憑空隱藏元件 */ }
                    if (!visible) return;
                }
                const el = this._renderViewerComponent(c, state, { rerender: render, dispatchAction });
                if (el) pageDiv.appendChild(el);
            });
            container.appendChild(pageDiv);
        };
        render();
        return { getState: () => state, rerender: render };
    }

    _renderViewerComponent(c, state, ctx) {
        if (c.type === 'text') {
            const div = document.createElement('div');
            div.style.cssText = 'margin-bottom:8px; font-size:13px; white-space:pre-wrap;';
            div.textContent = c.content || '';
            return div;
        }
        if (c.type === 'input') {
            const wrap = document.createElement('div');
            wrap.style.cssText = 'margin-bottom:8px;';
            if (c.label) {
                const label = document.createElement('label');
                label.style.cssText = 'display:block; font-size:12px; margin-bottom:2px;';
                label.textContent = c.label;
                wrap.appendChild(label);
            }
            const inputType = c.input_type || 'text';
            let inputEl;
            if (inputType === 'select') {
                inputEl = document.createElement('select');
                (c.options || []).forEach((opt) => {
                    const optionEl = document.createElement('option');
                    const val = (opt && typeof opt === 'object') ? opt.value : opt;
                    optionEl.value = val;
                    optionEl.textContent = (opt && typeof opt === 'object' && opt.label) ? opt.label : String(val);
                    inputEl.appendChild(optionEl);
                });
            } else if (inputType === 'textarea') {
                inputEl = document.createElement('textarea');
                inputEl.rows = 3;
            } else if (inputType === 'checkbox') {
                inputEl = document.createElement('input');
                inputEl.type = 'checkbox';
            } else {
                inputEl = document.createElement('input');
                inputEl.type = inputType === 'number' ? 'number' : 'text';
            }
            inputEl.style.cssText = inputType === 'checkbox' ? 'cursor:pointer;' : 'width:100%; box-sizing:border-box; padding:4px; font-size:12px;';
            const currentVal = state[c.state_key] !== undefined ? state[c.state_key] : c.default;
            if (inputType === 'checkbox') inputEl.checked = !!currentVal;
            else if (currentVal !== undefined) inputEl.value = currentVal;
            if (c.enabled_if) {
                let enabled = true;
                try { enabled = !!this._evalSafeExpression(c.enabled_if, state); } catch (_) { /* 表達式錯誤時預設啟用 */ }
                inputEl.disabled = !enabled;
            }
            inputEl.addEventListener('change', () => {
                state[c.state_key] = inputType === 'checkbox' ? inputEl.checked : (inputType === 'number' ? Number(inputEl.value) : inputEl.value);
                ctx.rerender();
            });
            wrap.appendChild(inputEl);
            return wrap;
        }
        if (c.type === 'button') {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = c.label || '按鈕';
            btn.style.cssText = 'padding:6px 14px; margin:2px 4px 2px 0; border-radius:6px; border:1px solid rgba(0,0,0,0.15); cursor:pointer; font-size:12px;';
            if (c.enabled_if) {
                let enabled = true;
                try { enabled = !!this._evalSafeExpression(c.enabled_if, state); } catch (_) { /* 表達式錯誤時預設啟用 */ }
                btn.disabled = !enabled;
            }
            btn.addEventListener('click', () => ctx.dispatchAction(String(c.action || '')));
            return btn;
        }
        if (c.type === 'subagent_panel') return this._renderViewerSubagentPanel(c);
        return null;
    }

    _renderViewerSubagentPanel(c) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin:8px 0; padding:8px; border:1px dashed rgba(0,0,0,0.2); border-radius:6px;';
        const domainInfo = SUBAGENT_DOMAIN_REGISTRY[c.domain];
        const label = document.createElement('div');
        label.style.cssText = 'font-size:11px; font-weight:bold; margin-bottom:4px; opacity:0.7;';
        label.textContent = `🤖 子agent（${(domainInfo && domainInfo.label) || c.domain}）`;
        wrap.appendChild(label);
        const textarea = document.createElement('textarea');
        textarea.rows = 2;
        textarea.placeholder = c.prompt_placeholder || '輸入要問這個子agent的內容...';
        textarea.style.cssText = 'width:100%; box-sizing:border-box; font-size:12px; padding:4px;';
        wrap.appendChild(textarea);
        const sendBtn = document.createElement('button');
        sendBtn.type = 'button';
        sendBtn.textContent = '送出';
        sendBtn.style.cssText = 'margin-top:4px; padding:4px 12px; font-size:12px; border-radius:6px; border:1px solid rgba(0,0,0,0.15); cursor:pointer;';
        const resultDiv = document.createElement('div');
        resultDiv.style.cssText = 'margin-top:6px; font-size:12px; white-space:pre-wrap;';
        sendBtn.addEventListener('click', async () => {
            const task = textarea.value.trim();
            if (!task) return;
            sendBtn.disabled = true;
            resultDiv.textContent = '⏳ 執行中…';
            try {
                const r = await this._delegateToSubagentDomain(c.domain, task);
                resultDiv.textContent = r.ok ? r.result : `⚠️ ${r.error}`;
            } catch (err) {
                resultDiv.textContent = `⚠️ ${err.message || err}`;
            } finally {
                sendBtn.disabled = false;
            }
        });
        wrap.appendChild(sendBtn);
        wrap.appendChild(resultDiv);
        return wrap;
    }

    // ============================================================
    // tw_stock_db客製: 階段2——persistentStorage檔案解析（見計畫文件階段2）。
    // 使用者透過📎附件按鈕上傳的檔案存在既有this.fileCache（IndexedDB，
    // kind='uploaded'），AI透過list_uploaded_files/parse_uploaded_file（見
    // _registerBuiltinAiTools）讀取。這裡是實際的格式偵測+各格式解析邏輯，
    // 刻意不vendor SheetJS/mammoth這類重量級函式庫（見計畫文件），xlsx/docx/
    // pptx都是zip-based OOXML，用既有已vendored的JSZip手刻抽取，只取「AI
    // 讀得懂內容」所需的最小結構，不追求還原完整格式/樣式。
    // ============================================================

    _detectFileFormat(filename) {
        const lower = String(filename || '').toLowerCase();
        if (lower.endsWith('.tar.gz') || lower.endsWith('.tgz')) return 'tgz';
        const dotIdx = lower.lastIndexOf('.');
        return dotIdx === -1 ? '' : lower.slice(dotIdx + 1);
    }

    // 簡易CSV欄位切割，支援雙引號包欄位+雙引號escape（""→"），不支援
    // RFC4180以外的進階情境（例如欄位內換行），對絕大多數實務CSV已經足夠。
    _parseCsvLine(line) {
        const fields = [];
        let cur = '';
        let inQuotes = false;
        for (let i = 0; i < line.length; i++) {
            const ch = line[i];
            if (inQuotes) {
                if (ch === '"') {
                    if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
                } else cur += ch;
            } else {
                if (ch === '"') inQuotes = true;
                else if (ch === ',') { fields.push(cur); cur = ''; }
                else cur += ch;
            }
        }
        fields.push(cur);
        return fields;
    }

    _parseCsvText(text, maxRows = 50) {
        const lines = text.split(/\r\n|\n|\r/).filter(l => l.length > 0);
        if (!lines.length) return { headers: [], rows: [], totalRows: 0 };
        const headers = this._parseCsvLine(lines[0]);
        const dataLines = lines.slice(1);
        const rows = dataLines.slice(0, maxRows).map(l => this._parseCsvLine(l));
        return { headers, rows, totalRows: dataLines.length, truncated: dataLines.length > maxRows };
    }

    // 極簡INI/CFG/INF解析：[section]標頭+key=value，不支援跨行值/巢狀
    // section，遇到不合語法的行直接跳過（防禦性，不拋錯中斷整份解析）。
    _parseIniText(text) {
        const result = {};
        let currentSection = result;
        text.split(/\r\n|\n|\r/).forEach(rawLine => {
            const line = rawLine.trim();
            if (!line || line.startsWith(';') || line.startsWith('#')) return;
            const sectionMatch = line.match(/^\[(.+)\]$/);
            if (sectionMatch) {
                const name = sectionMatch[1].trim();
                result[name] = result[name] || {};
                currentSection = result[name];
                return;
            }
            const eqIdx = line.indexOf('=');
            if (eqIdx === -1) return;
            const key = line.slice(0, eqIdx).trim();
            const value = line.slice(eqIdx + 1).trim();
            currentSection[key] = value;
        });
        return result;
    }

    // tw_stock_db客製: TOON（Token-Oriented Object Notation）是用縮排+表格
    // 語法縮減JSON語意冗餘的緊湊格式。這裡是best-effort簡化實作（純量、
    // 巢狀物件、`key[N]{f1,f2}:`表格陣列、`key[N]:`純量陣列四種語法），不是
    // 對照官方spec逐字驗證過的完整實作——見計畫文件「已知取捨」，解析失敗
    // 一律安全退回rawText，不拋錯中斷，讓AI至少能看到原始文字自己判讀。
    _parseToonText(text) {
        try {
            const lines = text.split(/\r\n|\n|\r/);
            const getIndent = (line) => { const m = line.match(/^ */); return m[0].length; };
            let pos = 0;
            const parseBlock = (indent) => {
                const obj = {};
                while (pos < lines.length) {
                    const line = lines[pos];
                    if (!line.trim()) { pos++; continue; }
                    const lineIndent = getIndent(line);
                    if (lineIndent < indent) break;
                    if (lineIndent > indent) { pos++; continue; }
                    const trimmed = line.trim();
                    pos++;
                    const tableMatch = trimmed.match(/^([^\[\]{}:]+)\[(\d+)\]\{([^}]*)\}:\s*$/);
                    if (tableMatch) {
                        const [, key, countStr, fieldsStr] = tableMatch;
                        const count = Number(countStr);
                        const fields = fieldsStr.split(',').map(f => f.trim());
                        const arr = [];
                        for (let i = 0; i < count && pos < lines.length;) {
                            const rowLine = lines[pos];
                            if (!rowLine.trim()) { pos++; continue; }
                            pos++;
                            const values = this._parseCsvLine(rowLine.trim());
                            const rowObj = {};
                            fields.forEach((f, idx) => { rowObj[f] = values[idx] !== undefined ? values[idx] : ''; });
                            arr.push(rowObj);
                            i++;
                        }
                        obj[key.trim()] = arr;
                        continue;
                    }
                    const listMatch = trimmed.match(/^([^\[\]{}:]+)\[(\d+)\]:\s*$/);
                    if (listMatch) {
                        const [, key, countStr] = listMatch;
                        const count = Number(countStr);
                        const arr = [];
                        for (let i = 0; i < count && pos < lines.length;) {
                            const itemLine = lines[pos];
                            if (!itemLine.trim()) { pos++; continue; }
                            pos++;
                            const m2 = itemLine.trim().match(/^-\s?(.*)$/);
                            arr.push(m2 ? m2[1] : itemLine.trim());
                            i++;
                        }
                        obj[key.trim()] = arr;
                        continue;
                    }
                    const colonIdx = trimmed.indexOf(':');
                    if (colonIdx === -1) continue;
                    const key = trimmed.slice(0, colonIdx).trim();
                    const rest = trimmed.slice(colonIdx + 1).trim();
                    obj[key] = rest === '' ? parseBlock(indent + 2) : rest;
                }
                return obj;
            };
            const parsed = parseBlock(0);
            return { parsed };
        } catch (err) {
            return { parseError: String(err.message || err), rawText: text.length > 8000 ? text.slice(0, 8000) + '\n…(截斷)' : text };
        }
    }

    async _gunzipToArrayBuffer(blob) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('這個瀏覽器不支援DecompressionStream，無法解開gzip/tgz');
        }
        const decompressedStream = blob.stream().pipeThrough(new DecompressionStream('gzip'));
        return await new Response(decompressedStream).arrayBuffer();
    }

    // 極簡USTAR格式tar reader：只讀header算出name/size/typeflag+對應的資料
    // 區塊位移，不驗證checksum、不支援長檔名擴充(pax/gnu longlink)——實務上
    // 絕大多數現代打包出來的.tar都能正確讀出entry清單，遇到不支援的擴充
    // 格式頂多名稱被截斷，不會整包解析失敗。
    _parseTarBuffer(buffer) {
        const bytes = new Uint8Array(buffer);
        const entries = [];
        let offset = 0;
        const decoder = new TextDecoder('utf-8', { fatal: false });
        const parseOctal = (segment) => {
            let s = '';
            for (const b of segment) { if (b === 0 || b === 32) break; s += String.fromCharCode(b); }
            return s.trim() ? parseInt(s.trim(), 8) : 0;
        };
        while (offset + 512 <= bytes.length) {
            const header = bytes.subarray(offset, offset + 512);
            let allZero = true;
            for (let i = 0; i < 512; i++) { if (header[i] !== 0) { allZero = false; break; } }
            if (allZero) break;
            const nameBytes = header.subarray(0, 100);
            let nameEnd = nameBytes.indexOf(0);
            if (nameEnd === -1) nameEnd = 100;
            const name = decoder.decode(nameBytes.subarray(0, nameEnd));
            const size = parseOctal(header.subarray(124, 136));
            const typeflag = String.fromCharCode(header[156] || 48);
            const dataStart = offset + 512;
            entries.push({ name, size, typeflag, isDir: typeflag === '5' || name.endsWith('/'), _dataStart: dataStart });
            const dataBlocks = Math.ceil(size / 512);
            offset = dataStart + dataBlocks * 512;
        }
        return { bytes, entries };
    }

    _extractTarEntry(parsedTar, name) {
        const entry = parsedTar.entries.find(e => e.name === name);
        if (!entry) return null;
        return parsedTar.bytes.subarray(entry._dataStart, entry._dataStart + entry.size);
    }

    // xlsx是zip-based OOXML：xl/sharedStrings.xml存共用字串表(<si><t>)，
    // xl/worksheets/sheetN.xml的<c t="s">用索引參照它，其餘型別(數字/inline
    // string)直接讀<v>/<is><t>。這裡只還原「第一個工作表的儲存格文字內容」
    // 這個最小可用結構（依<row>/<c>的XML書寫順序輸出，不精確對應欄位字母），
    // 不處理公式/樣式/合併儲存格。
    async _parseXlsxZip(zip) {
        const sheetFiles = Object.keys(zip.files).filter(n => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort();
        if (!sheetFiles.length) return { ok: false, error: '找不到任何工作表 (xl/worksheets/*.xml)，可能不是有效的xlsx檔' };
        let sharedStrings = [];
        const sharedStringsFile = zip.file('xl/sharedStrings.xml');
        if (sharedStringsFile) {
            const xml = await sharedStringsFile.async('string');
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            sharedStrings = Array.from(doc.getElementsByTagName('si')).map(si => si.textContent || '');
        }
        const parseSheet = async (fileName) => {
            const xml = await zip.file(fileName).async('string');
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            return Array.from(doc.getElementsByTagName('row')).map(rowEl =>
                Array.from(rowEl.getElementsByTagName('c')).map(c => {
                    const t = c.getAttribute('t');
                    const vEl = c.getElementsByTagName('v')[0];
                    if (t === 's') {
                        const idx = vEl ? Number(vEl.textContent) : -1;
                        return sharedStrings[idx] != null ? sharedStrings[idx] : '';
                    }
                    if (t === 'inlineStr') {
                        const isEl = c.getElementsByTagName('is')[0];
                        return isEl ? isEl.textContent : '';
                    }
                    return vEl ? vEl.textContent : '';
                })
            );
        };
        const firstSheetRows = await parseSheet(sheetFiles[0]);
        return { ok: true, sheetFiles, firstSheetRows: firstSheetRows.slice(0, 200) };
    }

    // docx是zip-based OOXML：word/document.xml，段落是<w:p>，段落內文字跑在
    // 一或多個<w:t>裡（w:r的run可能因為格式切換被拆成好幾段<w:t>，這裡把同一
    // 段落內全部<w:t>接起來還原成一行純文字，不保留粗體/字型等樣式資訊）。
    async _parseDocxZip(zip) {
        const docFile = zip.file('word/document.xml');
        if (!docFile) return { ok: false, error: '找不到 word/document.xml，可能不是有效的docx檔' };
        const xml = await docFile.async('string');
        const doc = new DOMParser().parseFromString(xml, 'application/xml');
        const paragraphs = Array.from(doc.getElementsByTagName('w:p')).map(p =>
            Array.from(p.getElementsByTagName('w:t')).map(t => t.textContent).join('')
        );
        const fullText = paragraphs.join('\n');
        return { ok: true, paragraphs: paragraphs.slice(0, 300), fullText: fullText.length > 12000 ? fullText.slice(0, 12000) + '\n…(截斷)' : fullText };
    }

    // pptx是zip-based OOXML：每張投影片是ppt/slides/slideN.xml，文字跑在
    // <a:t>裡，依slideN數字順序輸出每張投影片的文字內容陣列。
    async _parsePptxZip(zip) {
        const slideFiles = Object.keys(zip.files)
            .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
            .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]));
        if (!slideFiles.length) return { ok: false, error: '找不到任何投影片 (ppt/slides/*.xml)，可能不是有效的pptx檔' };
        const slides = [];
        for (const f of slideFiles) {
            const xml = await zip.file(f).async('string');
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            slides.push(Array.from(doc.getElementsByTagName('a:t')).map(t => t.textContent).join(' '));
        }
        return { ok: true, slideCount: slides.length, slides };
    }

    // 主解析入口：依副檔名分派。archives（zip/tar/tgz）預設只列出entries清單
    // （不展開內容），呼叫端要看某個entry的實際內容時再帶entryPath指定要
    // 抽取哪一個，避免一次把整個archive所有檔案內容都塞進AI的context。
    async _parseUploadedFileContent(record, opts = {}) {
        const format = this._detectFileFormat(record.filename);
        const entryPath = typeof opts.entryPath === 'string' && opts.entryPath ? opts.entryPath : null;
        try {
            if (format === 'zip') {
                await this._ensureJSZipLoaded();
                const zip = await JSZip.loadAsync(record.blob);
                if (entryPath) {
                    const entry = zip.file(entryPath);
                    if (!entry) return { ok: false, error: `zip內找不到項目: ${entryPath}` };
                    const text = await entry.async('string');
                    return { ok: true, format: 'zip_entry', entryPath, content: text.length > 20000 ? text.slice(0, 20000) + '\n…(截斷)' : text };
                }
                const entries = Object.keys(zip.files).map(name => ({ name, isDir: zip.files[name].dir }));
                return { ok: true, format: 'zip', entries };
            }
            if (format === 'tar' || format === 'tgz') {
                const buffer = format === 'tgz' ? await this._gunzipToArrayBuffer(record.blob) : await record.blob.arrayBuffer();
                const parsed = this._parseTarBuffer(buffer);
                if (entryPath) {
                    const raw = this._extractTarEntry(parsed, entryPath);
                    if (!raw) return { ok: false, error: `${format}內找不到項目: ${entryPath}` };
                    const text = new TextDecoder('utf-8', { fatal: false }).decode(raw);
                    return { ok: true, format: `${format}_entry`, entryPath, content: text.length > 20000 ? text.slice(0, 20000) + '\n…(截斷)' : text };
                }
                return { ok: true, format, entries: parsed.entries.map(e => ({ name: e.name, size: e.size, isDir: e.isDir })) };
            }
            if (format === 'xlsx') {
                await this._ensureJSZipLoaded();
                return await this._parseXlsxZip(await JSZip.loadAsync(record.blob));
            }
            if (format === 'docx') {
                await this._ensureJSZipLoaded();
                return await this._parseDocxZip(await JSZip.loadAsync(record.blob));
            }
            if (format === 'pptx') {
                await this._ensureJSZipLoaded();
                return await this._parsePptxZip(await JSZip.loadAsync(record.blob));
            }
            if (format === 'csv') {
                return { ok: true, format: 'csv', ...this._parseCsvText(await record.blob.text()) };
            }
            if (format === 'yaml' || format === 'yml') {
                const text = await record.blob.text();
                try {
                    await this._ensureJsYamlLoaded();
                    return { ok: true, format: 'yaml', parsed: jsyaml.load(text) };
                } catch (err) {
                    return { ok: true, format: 'yaml', parseError: String(err.message || err), rawText: text.length > 8000 ? text.slice(0, 8000) + '\n…(截斷)' : text };
                }
            }
            if (format === 'toon') {
                return { ok: true, format: 'toon', ...this._parseToonText(await record.blob.text()) };
            }
            if (['cfg', 'conf', 'ini', 'inf'].includes(format)) {
                const text = await record.blob.text();
                return { ok: true, format, parsed: this._parseIniText(text), rawText: text.length > 8000 ? text.slice(0, 8000) + '\n…(截斷)' : text };
            }
            const text = await record.blob.text();
            if (format === 'json') {
                try {
                    return { ok: true, format: 'json', parsed: JSON.parse(text) };
                } catch (err) {
                    return { ok: true, format: 'json', parseError: String(err.message || err), rawText: text.length > 8000 ? text.slice(0, 8000) + '\n…(截斷)' : text };
                }
            }
            // txt/md/markdown/log/js等純文字類，直接回傳（js刻意只當文字讀，
            // 絕不執行——見計畫文件的安全立場）。
            return { ok: true, format: format || 'text', content: text.length > 8000 ? text.slice(0, 8000) + `\n…(截斷，共${text.length}字元)` : text };
        } catch (err) {
            return { ok: false, error: String(err.message || err) };
        }
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

    // tw_stock_db客製: 2026-08-28使用者要求「加強」——原本這裡只是把使用者
    // 插進來的文字原封不動塞進一則[Steering]系統訊息，模型看到之後要怎麼
    // 處理完全靠自己猜。跟Claude Code自己處理「使用者在執行中途插話」的
    // 方式一樣，明確教模型三件事：(1)這不是新的一輪對話、是插進目前任務
    // 中間的訊息 (2)先自己判斷這需不需要改變方向 (3)不需要改變方向就直接
    // 按原計畫做完，不用特別在回覆裡提起。這幾句指示故意寫在每一則
    // steering訊息本身裡（不是塞進系統提示），理由跟AI_ANALYSIS_PRINCIPLES
    // 等說明文件刻意不放進系統提示一樣——這種指示只在真的發生插話時才需要
    // 出現一次，塞進每輪都會重送的系統提示只會不必要地增加token。
    _addSteeringMessage(userText) {
        const steeringText = String(userText || '').trim();
        if (!steeringText) return;
        this.messages.push({
            role: 'system',
            content: `[Steering] 使用者在你還在處理原本的任務時，插入了這則新訊息：「${steeringText}」\n` +
                `這不是一輪新的獨立對話，是插在你目前任務執行過程中間的訊息。請先判斷：這則訊息是不是` +
                `代表使用者想改變方向、取消、或需要你先回應/處理？\n` +
                `如果不需要改變方向（例如只是順口確認一下、跟原任務無關的閒聊、或內容其實跟你正在做的` +
                `事一致），請直接按原計畫繼續完成剛才的任務，不用在回覆裡特別提起這則訊息。\n` +
                `如果確實需要改變方向，才調整接下來的行動去回應這則新訊息，並視情況告知使用者你做了` +
                `什麼調整。`,
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
    // tw_stock_db客製: 2026-09-05使用者明確要求——匯出PPTX/PDF時，這個對話
    // 輪次裡出現過的3D場景/繪圖/圖表也要一併嵌進去，不能只匯出文字。SVG
    // 繪圖用Image+離屏canvas轉成PNG（比照redmine參考文件rasterizeIfSvg的
    // 精神）。
    async _rasterizeSvgToDataUrl(svgText, targetWidth) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => {
                const w = targetWidth || img.naturalWidth || 800;
                const scale = w / (img.naturalWidth || w);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = Math.max(1, Math.round((img.naturalHeight || w * 0.6) * scale));
                const ctx = canvas.getContext('2d');
                ctx.fillStyle = '#ffffff';
                ctx.fillRect(0, 0, canvas.width, canvas.height);
                ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
                resolve(canvas.toDataURL('image/png'));
            };
            img.onerror = () => reject(new Error('SVG轉PNG失敗'));
            img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
        });
    }

    // 依訊息的顯示型態（圖片/3D場景/繪圖）截出一張PNG data URL。3D場景優先
    // 用目前存活的_scene3DHandle（畫面上正在跑的那個canvas實例，見
    // _renderSingleMessage掛載scene3d的地方）直接截圖，沒有存活的handle
    // （例如重新整理過頁面後才匯出）才off-screen重新掛載一次、截完立刻
    // stop()釋放，不留在畫面上。
    async _captureVisualSnapshot(msg) {
        if (msg._displayDataUrl) return { dataUrl: msg._displayDataUrl, kind: 'image' };
        if (msg._displayScene3DYaml) {
            if (msg._scene3DHandle && typeof msg._scene3DHandle.snapshotDataUri === 'function') {
                try { return { dataUrl: msg._scene3DHandle.snapshotDataUri(), kind: 'scene3d' }; } catch (_) { /* 落到下面重新掛載 */ }
            }
            const offDiv = document.createElement('div');
            offDiv.style.cssText = 'position:fixed; left:-9999px; top:-9999px; width:480px;';
            document.body.appendChild(offDiv);
            try {
                const handle = await this._mount3DScene(offDiv, msg._displayScene3DYaml);
                if (!handle) return null;
                await new Promise(r => setTimeout(r, 50));
                const dataUrl = handle.snapshotDataUri();
                handle.stop();
                return { dataUrl, kind: 'scene3d' };
            } catch (_) {
                return null;
            } finally {
                document.body.removeChild(offDiv);
            }
        }
        if (msg._displayDrawingSvg) {
            try {
                return { dataUrl: await this._rasterizeSvgToDataUrl(msg._displayDrawingSvg, 800), kind: 'drawing' };
            } catch (_) {
                return null;
            }
        }
        if (msg._displayViewerYaml) {
            // tw_stock_db客製: 互動viewer匯出時刻意不截圖（表單元件的像素
            // 外觀對報告閱讀者沒什麼意義，實際有意義的是「使用者填了什麼」
            // 這份資料本身）——改成文字摘要（頁面標題+每個input目前的值），
            // 見_faAppendVisualSnapshotSlides/_faMarkdownToPdfBlob怎麼處理
            // kind==='viewer_summary'。
            try {
                const text = await this._summarizeViewerStateForExport(msg._displayViewerYaml);
                return { text, kind: 'viewer_summary' };
            } catch (_) {
                return null;
            }
        }
        return null;
    }

    // 把viewer YAML的頁面/元件結構＋目前persistentStorage存的實際填寫值，
    // 組成一段給PPTX/PDF用的可讀文字摘要。
    async _summarizeViewerStateForExport(yamlText) {
        await this._ensureJsYamlLoaded();
        const validation = this._validateInteractiveViewerYaml(yamlText);
        if (!validation.ok) return `（互動viewer格式錯誤，無法產生摘要：${validation.error}）`;
        const viewer = validation.viewer;
        const state = (await this.stateStore.get(`viewer:${viewer.state_namespace}`)) || {};
        const lines = [];
        viewer.pages.forEach((page) => {
            lines.push(`【${page.title || page.id}】`);
            (page.components || []).forEach((c) => {
                if (c.type === 'text' && c.content) lines.push(c.content);
                if (c.type === 'input') {
                    const val = state[c.state_key] !== undefined ? state[c.state_key] : c.default;
                    lines.push(`${c.label || c.state_key}：${val === undefined || val === '' ? '(未填寫)' : val}`);
                }
            });
            lines.push('');
        });
        return lines.join('\n').trim() || '（這個viewer沒有任何內容）';
    }

    // 掃這則assistant回覆「同一輪對話」（往前找到上一則user訊息為止）裡
    // 出現過的所有視覺型tool結果，依原始順序回傳截圖陣列，給匯出PPTX/PDF
    // 用。找不到訊息本身（例如是archivedDisplayBlocks裡的舊訊息）就回傳
    // 空陣列，不強求archived訊息也要能匯出視覺內容。
    async _collectTurnVisualSnapshots(msg) {
        const idx = this.messages.indexOf(msg);
        if (idx === -1) return [];
        // tw_stock_db客製: 2026-09-05——同一輪內被之後的呼叫取代掉的草稿
        // （見_markSupersededVisualDrafts）匯出時也要跳過，跟畫面顯示邏輯
        // 一致：使用者要匯出的是「最終交件」，不是每一次試錯的草稿。
        this._markSupersededVisualDrafts(this.messages);
        const collected = [];
        for (let i = idx - 1; i >= 0; i--) {
            const m = this.messages[i];
            if (m.role === 'user') break;
            if (m._visualSuperseded) continue;
            if (m._displayDataUrl || m._displayScene3DYaml || m._displayDrawingSvg || m._displayViewerYaml) {
                const snap = await this._captureVisualSnapshot(m);
                if (snap) collected.unshift(snap);
            }
        }
        return collected;
    }

    // tw_stock_db客製: 2026-09-05使用者要求——3D場景/繪圖/互動viewer卡片
    // 除了匯出PPTX/PDF，還要能直接下載原始碼、或就地檢視原始碼文字，不
    // 經過任何轉檔。getSourceFn是同步/非同步都可、回傳原始碼字串的函式
    // （呼叫當下才取，例如get_interactive_viewer_yaml那種「最新內容」
    // 語意，不是預先算好凍結一份）；wrapEl是要把展開的<pre>原始碼區塊
    // 插進去的容器（通常是整張卡片本身，不是按鈕列，這樣<pre>會排在
    // 按鈕列下方而不是塞進同一列擠爆版面）。
    _appendCardSourceButtons(container, wrapEl, getSourceFn, filenameBase, fileExt) {
        const viewBtn = document.createElement('button');
        viewBtn.type = 'button';
        viewBtn.title = '檢視原始碼';
        viewBtn.textContent = '📝';
        viewBtn.style.cssText = 'border:none; background:rgba(0,0,0,0.08); border-radius:6px; cursor:pointer; font-size:13px; padding:3px 7px; line-height:1.4;';
        const downloadBtn = document.createElement('button');
        downloadBtn.type = 'button';
        downloadBtn.title = '下載原始碼';
        downloadBtn.textContent = '📥';
        downloadBtn.style.cssText = viewBtn.style.cssText;

        let sourcePre = null;
        viewBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (sourcePre) { sourcePre.remove(); sourcePre = null; return; }
            const src = await getSourceFn();
            sourcePre = document.createElement('pre');
            sourcePre.style.cssText = 'margin-top:6px; padding:8px; background:rgba(0,0,0,0.04); border:1px solid rgba(0,0,0,0.1); border-radius:6px; font-size:11px; white-space:pre-wrap; word-break:break-all; max-height:260px; overflow:auto;';
            sourcePre.textContent = src || '（沒有原始碼內容）';
            wrapEl.appendChild(sourcePre);
        });
        // tw_stock_db客製: 2026-09-05使用者明確要求「必須要做，不要當
        // ambiguous」——原本這裡是「動態建立<a>+合成click()」的做法，
        // 這種模式在部分行動裝置瀏覽器上，如果click()前有經過任何一次
        // await（即使只是微任務等級的延遲），可能會被瀏覽器判定不再是
        // 「使用者手勢觸發」而悄悄擋下下載、完全沒有錯誤訊息、看起來就像
        // 按了沒反應。改用這個專案既有、已經在PPTX/PDF/圖片/skill.zip
        // 匯出都驗證過確實可靠的下載機制（generateAndDeliverFile→存進
        // FileCache→在對話裡產生一個真正的、使用者自己點擊的下載連結
        // 訊息）——下載動作變成使用者自己在後續一次真實點擊觸發，不會
        // 有這種瀏覽器手勢時效性的疑慮。
        downloadBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const original = downloadBtn.textContent;
            downloadBtn.textContent = '⏳';
            try {
                const src = await getSourceFn();
                const blob = new Blob([src || ''], { type: 'text/plain;charset=utf-8' });
                await this.generateAndDeliverFile(blob, `${filenameBase}_${Date.now()}.${fileExt}`, 'text/plain;charset=utf-8');
            } catch (err) {
                this._log(`❌ 下載原始碼失敗：${err.message || err}`);
            } finally {
                downloadBtn.textContent = original;
            }
        });
        container.appendChild(viewBtn);
        container.appendChild(downloadBtn);
    }

    // tw_stock_db客製: 2026-09-05使用者實測回報——AI回應一個3D場景時，畫面
    // 上完全找不到匯出PPTX的入口（原本的📤匯出按鈕只掛在assistant文字回覆
    // 泡泡上，_collectTurnVisualSnapshots雖然會掃到同一輪的3D場景，但如果
    // 那輪assistant文字回覆很短、甚至使用者根本沒注意到底下還有文字泡泡，
    // 這個入口形同不存在）。這裡是給3D場景/繪圖卡片本身直接加一個小型
    // 📤匯出按鈕的共用helper，getSnapshotFn是一個回傳{dataUrl,kind}或
    // {text,kind}的非同步函式（呼叫當下才截圖/產生摘要，不是預先算好），
    // 匯出範圍只有「這一張卡片」，跟訊息底下那個匯出「整個回覆」的按鈕
    // 語意不同、互不取代。
    _appendCardExportButton(container, getSnapshotFn, defaultTitle) {
        const wrap = document.createElement('div');
        wrap.style.cssText = 'position:relative; display:inline-block;';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.title = '匯出這個內容';
        btn.textContent = '📤';
        btn.style.cssText = 'border:none; background:rgba(0,0,0,0.08); border-radius:6px; cursor:pointer; font-size:13px; padding:3px 7px; line-height:1.4;';
        const menu = document.createElement('div');
        menu.style.cssText = 'display:none; position:absolute; bottom:100%; right:0; margin-bottom:4px; background:#fff; border:1px solid #ccc; border-radius:6px; box-shadow:0 2px 10px rgba(0,0,0,0.25); z-index:6; min-width:96px;';
        menu.innerHTML = `
            <div class="fa-card-export-item" data-fmt="pptx" style="padding:6px 12px; font-size:12px; cursor:pointer; color:#333;">📊 PPTX</div>
            <div class="fa-card-export-item" data-fmt="pdf" style="padding:6px 12px; font-size:12px; cursor:pointer; color:#333;">📄 PDF</div>
        `;
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            document.querySelectorAll('.fa-card-export-menu-open').forEach((m) => { if (m !== menu) m.style.display = 'none'; });
            menu.style.display = menu.style.display === 'block' ? 'none' : 'block';
        });
        document.addEventListener('click', () => { menu.style.display = 'none'; });
        menu.querySelectorAll('.fa-card-export-item').forEach((item) => {
            item.addEventListener('click', async (e) => {
                e.stopPropagation();
                menu.style.display = 'none';
                const fmt = item.dataset.fmt;
                const original = btn.textContent;
                btn.textContent = '⏳';
                try {
                    const snap = await getSnapshotFn();
                    if (!snap) throw new Error('目前沒有可匯出的內容');
                    if (fmt === 'pptx') {
                        const blob = await _faMarkdownToPptxBlob('', defaultTitle, [snap]);
                        await this.generateAndDeliverFile(blob, `${defaultTitle}_${Date.now()}.pptx`, blob.type);
                    } else {
                        const blob = await _faMarkdownToPdfBlob('', defaultTitle, [snap]);
                        await this.generateAndDeliverFile(blob, `${defaultTitle}_${Date.now()}.pdf`, blob.type);
                    }
                } catch (err) {
                    this._log(`❌ 匯出失敗：${err.message || err}`);
                } finally {
                    btn.textContent = original;
                }
            });
        });
        wrap.appendChild(btn);
        wrap.appendChild(menu);
        container.appendChild(wrap);
        return wrap;
    }

    _appendMarkdownExportButton(container, markdownText, palette, msg) {
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
                        const visualSnapshots = msg ? await this._collectTurnVisualSnapshots(msg) : [];
                        const blob = await _faMarkdownToPptxBlob(markdownText, heading, visualSnapshots);
                        await this.generateAndDeliverFile(blob, `ai回覆_${Date.now()}.pptx`, blob.type);
                    } else if (fmt === 'pdf') {
                        const visualSnapshots = msg ? await this._collectTurnVisualSnapshots(msg) : [];
                        const blob = await _faMarkdownToPdfBlob(markdownText, heading, visualSnapshots);
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
    // tw_stock_db客製: 2026-08-28使用者反饋——「slashcommand沒有自動完成嗎？
    // 像是型態代碼，沒有任何一個使用者知道該填什麼」，原本的自動完成只
    // 認得指令名稱本身，使用者打完指令名稱+一個空白、開始打參數的當下，
    // 選單就直接整個隱藏（見_wireSlashCommandMenu），參數該填什麼完全沒有
    // 提示。新增選填的第5個參數argChoices：陣列，每個元素對應第N個位置
    // 參數的候選值清單（第0個元素=第1個參數的候選值），元素本身可以是
    // 純字串陣列、或{value,label}物件陣列（label選填，用來顯示中文說明，
    // 沒有的話用value本身當顯示文字）；某個位置不需要自動完成（例如自由
    // 輸入的數字）就填null或直接省略該位置。不是每個指令都要提供，沒給
    // 就完全不影響原本行為。
    register_slash_command(cmd, hint, desc, handler, argChoices) {
        const key = String(cmd || '').trim().toLowerCase();
        if (!key.startsWith('/')) {
            console.warn('register_slash_command: cmd必須以/開頭，忽略：', cmd);
            return this;
        }
        this.slashCommands.set(key, { cmd: key, hint: hint || '', desc: desc || '', handler, argChoices: Array.isArray(argChoices) ? argChoices : null });
        return this;
    }

    // tw_stock_db客製: 從輸入框取字、清空、觸發executeChat的共用邏輯，被
    // Enter鍵送出跟「送出」按鈕共用，確保兩條路徑行為完全一致（見上面
    // bindEvents()裡兩處的呼叫端）。斜線指令刻意在這裡攔截、不進
    // executeChat/LLM——這些是本地端function call直接觸發的工具指令，
    // 不需要也不應該讓AI自己「決定」要不要執行；實際指令清單見
    // this.slashCommands（見register_slash_command()的註冊機制）。
    _submitChatInput(inputText, suggestBar) {
        let textToSend = inputText.value.trim();
        // tw_stock_db客製: 階段2——如果有📎附加的檔案，就算輸入框是空的也
        // 允許送出（單純附檔案、讓AI自己判斷要不要主動看內容，是合理的使用
        // 情境），沒有附件時維持原本「空白不送出」的行為。
        const hasAttachments = this._pendingAttachments.length > 0;
        if (!textToSend && !hasAttachments) return;

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

        if (hasAttachments) {
            const attachmentNote = this._pendingAttachments
                .map(a => `${a.filename}（file_id=${a.id}）`)
                .join('、');
            const instruction = textToSend
                ? textToSend
                : '請視需要使用檔案解讀能力（parse_uploaded_file / delegate_to_subagent的file_analysis領域）查看下面附件的內容，再回答我。';
            textToSend = `${instruction}\n\n[附件：${attachmentNote}]`;
            this._pendingAttachments = [];
            this._renderPendingAttachments();
        }

        if (this.isResponding) {
            this._setRespondingState(true, '⏳ AI 回應中（Steering 已加入）');
        }
        this.executeChat(textToSend);
    }

    // tw_stock_db客製: 階段2——📎按鈕觸發隱藏的<input type=file>，選好的每個
    // 檔案立刻存進this.fileCache（kind='uploaded'，見FileCache.put），存好
    // 就加進this._pendingAttachments暫存清單、更新聊天輸入框上方的附件
    // chip列；真正把file_id接進使用者訊息文字是送出當下才做（見
    // _submitChatInput），先存起來只是讓使用者能在送出前看到「等一下會附上
    // 哪些檔案」、也能點×移除還沒送出的附件。
    _wireAttachmentUpload() {
        const attachBtn = document.getElementById('ai-attach-btn');
        const attachInput = document.getElementById('ai-attach-input');
        if (!attachBtn || !attachInput) return;
        attachBtn.addEventListener('click', () => attachInput.click());
        attachInput.addEventListener('change', async () => {
            const files = Array.from(attachInput.files || []);
            attachInput.value = '';
            for (const file of files) {
                try {
                    const id = await this.fileCache.put(file.name, file.type || 'application/octet-stream', file, 'uploaded');
                    this._pendingAttachments.push({ id, filename: file.name, sizeBytes: file.size });
                } catch (err) {
                    this._log(`⚠️ 附件「${file.name}」存檔失敗：${err.message || err}`);
                }
            }
            this._renderPendingAttachments();
        });
        const pendingRow = document.getElementById('ai-pending-attachments');
        if (pendingRow) {
            pendingRow.addEventListener('click', (e) => {
                const removeBtn = e.target.closest('[data-remove-attachment-id]');
                if (!removeBtn) return;
                const id = removeBtn.dataset.removeAttachmentId;
                this._pendingAttachments = this._pendingAttachments.filter(a => a.id !== id);
                this._renderPendingAttachments();
            });
        }
    }

    _renderPendingAttachments() {
        const row = document.getElementById('ai-pending-attachments');
        if (!row) return;
        if (!this._pendingAttachments.length) {
            row.style.display = 'none';
            row.innerHTML = '';
            return;
        }
        const palette = this._getThemePalette();
        row.style.display = 'flex';
        row.innerHTML = this._pendingAttachments.map(a => {
            const sizeLabel = a.sizeBytes >= 1024 * 1024
                ? `${(a.sizeBytes / 1024 / 1024).toFixed(1)}MB`
                : `${Math.ceil(a.sizeBytes / 1024)}KB`;
            return `<span style="display:inline-flex; align-items:center; gap:4px; padding:3px 8px; border-radius:999px; background:${palette.detailBg}; color:${palette.detailText}; font-size:11px;">
                📎 ${this._escapeHtml(a.filename)}（${sizeLabel}）
                <span data-remove-attachment-id="${this._escapeAttr(a.id)}" style="cursor:pointer; opacity:0.7;" title="移除">✕</span>
            </span>`;
        }).join('');
    }

    // tw_stock_db客製: 2026-09-05使用者要求——/view-3d-attachment指令的實作。
    // 優先用「輸入框旁邊還沒送出的📎附件」（使用者剛附加、想直接看，不想
    // 麻煩AI）；沒有pending附件時，退而找this.fileCache裡最近上傳過的一個
    // 檔案（kind='uploaded'）試試看。附件如果是.yaml/.yml，走既有的場景
    // YAML驗證；如果是.stl/.obj/.3mf/.fbx，先透過
    // _convertModelFileToSceneYaml轉成場景YAML再顯示——兩條路徑最後都
    // 收斂到同一個_validate3DSceneYaml+渲染流程。完全不呼叫API/LLM，
    // 純本地動作。
    async _handleViewAttachedSceneCommand() {
        let record = null;
        if (this._pendingAttachments.length) {
            const pending = this._pendingAttachments[this._pendingAttachments.length - 1];
            record = await this.fileCache.get(pending.id);
            this._pendingAttachments = this._pendingAttachments.filter(a => a.id !== pending.id);
            this._renderPendingAttachments();
        } else {
            const all = await this.fileCache.getAll();
            const uploaded = all.filter(r => r.kind === 'uploaded').sort((a, b) => b.createdAt - a.createdAt);
            record = uploaded[0];
        }
        if (!record) {
            this._log('⚠️ /view-3d-attachment：目前沒有附加、也沒有最近上傳過的檔案');
            return;
        }
        try {
            await this._ensureJsYamlLoaded();
        } catch (err) {
            this._log(`⚠️ /view-3d-attachment：${err.message || err}`);
            return;
        }
        const format = this._detectFileFormat(record.filename);
        let yamlText;
        if (['stl', 'obj', '3mf', 'fbx'].includes(format)) {
            const converted = await this._convertModelFileToSceneYaml(record);
            if (!converted.ok) {
                this._log(`⚠️ /view-3d-attachment：${converted.error}`);
                return;
            }
            yamlText = converted.yaml;
        } else {
            try {
                yamlText = await record.blob.text();
            } catch (err) {
                this._log(`⚠️ /view-3d-attachment：讀取附件失敗：${err.message || err}`);
                return;
            }
        }
        const validation = this._validate3DSceneYaml(yamlText);
        if (!validation.ok) {
            this._log(`⚠️ /view-3d-attachment：附件「${record.filename}」不是合法的3D場景（或轉換失敗）：${validation.error}`);
            return;
        }
        this.messages.push({ role: 'user', content: `📎 開啟附件的3D場景：${record.filename}` });
        const msg = this._buildToolResultMessage('view_3d_attachment', JSON.stringify({ type: 'scene3d', yaml: yamlText }), {});
        this.messages.push(msg);
        this._renderMessageHistory();
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
                const regex = /\[CALL:\s*([\p{L}\p{N}_]+)\(([\s\S]*?)\)(?=\]|$)/gu;
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
                        const nameMatch = rawContent.slice(callStart).match(/^\[CALL:\s*([\p{L}\p{N}_]+)\s*\(/u);
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
            let lastRoundWasReasoningDeadEnd = false; // 見AI_REASONING_DEADEND_PROMPT說明

            // tw_stock_db客製: 外層迴圈＝自動接續。第一輪送使用者真正的對話
            // 歷史；若這一輪在還沒講完時就被max_tokens截斷
            // (finish_reason==='length')，之後每一輪改送「原對話歷史 + 目前
            // 已經拼到的內容 + 請AI直接接續」，重複直到收到非length的
            // finish_reason，或觸及安全上限。this.messages本身不會被中間輪
            // 汙染，只有全部接續完成後才把最終合併結果push進去一則。
            while (true) {
                const requestMessages = autoContinueRounds === 0
                    ? this.messages
                    : lastRoundWasReasoningDeadEnd
                        ? this.messages.concat([{ role: 'user', content: AI_REASONING_DEADEND_PROMPT }])
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
                if (repetitionCut) break;

                // tw_stock_db客製: 見AI_REASONING_DEADEND_PROMPT說明——某些推理
                // 模型會在思考階段就自然觸發EOS，finishReason回報'stop'而非
                // 'length'，但fullContent到目前為止還是空的、只有reasoningContent
                // 有大量內容，代表這一輪「想了但沒有真的產出答案」，也要當成
                // 需要重試，不能只認'length'。
                lastRoundWasReasoningDeadEnd = !fullContent.trim() && reasoningContent.trim().length > 20;
                if (finishReason !== 'length' && !lastRoundWasReasoningDeadEnd) break;

                // tw_stock_db客製: 這一輪被max_tokens截斷——不是內容有問題，
                // 是「這一次API呼叫」的長度上限到了，自動用「請接續」重送一次，
                // 讓使用者不用手動追問。安全上限見MAX_AUTO_CONTINUE_ROUNDS。
                autoContinueRounds++;
                if (autoContinueRounds >= MAX_AUTO_CONTINUE_ROUNDS) break;
                this._log(lastRoundWasReasoningDeadEnd
                    ? `↻ 這一輪只輸出了思考過程、沒有產出答案，自動請AI直接回答（第${autoContinueRounds}次）…`
                    : `↻ 回覆超過單次長度上限，自動請AI接續（第${autoContinueRounds}次）…`);
            }
            if (repetitionCut) textSpan.innerText = fullContent;

            // tw_stock_db客製: 走到這裡如果finishReason還是'length'、或還卡在
            // lastRoundWasReasoningDeadEnd狀態，代表已經自動接續到
            // MAX_AUTO_CONTINUE_ROUNDS上限仍未寫完（極端情況，例如端點異常或
            // 模型卡在某種輸出模式），才需要提醒使用者——正常情況下自動接續
            // 機制會在使用者沒感覺到的狀況下把內容拼完整。
            if (!repetitionCut && (finishReason === 'length' || lastRoundWasReasoningDeadEnd)) {
                fullContent += lastRoundWasReasoningDeadEnd
                    ? '\n\n---\n⚠️ **已自動請AI直接回答多次，但這一輪模型每次都只產出思考過程、沒有真正的答案內容（可能是端點異常或模型卡在某種輸出模式）。** 可以直接追問一次，或換一個模型試試。'
                    : '\n\n---\n⚠️ **已自動請AI接續多次仍未寫完，這裡先停下來（可能內容真的很長，或端點異常）。** 可以直接追問「請繼續」。';
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
                const regex = /\[CALL:\s*([\p{L}\p{N}_]+)\(([\s\S]*?)\)(?=\]|$)/gu;
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
                    const nameMatch = fullContent.slice(callStart).match(/^\[CALL:\s*([\p{L}\p{N}_]+)\s*\(/u);
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
            let lastRoundWasReasoningDeadEnd = false; // 見AI_REASONING_DEADEND_PROMPT說明

            // tw_stock_db客製: 跟_loopFetch串流路徑同樣的自動接續機制（見那邊
            // 詳細說明）——finish_reason==='length'代表這一次API呼叫被max_tokens
            // 截斷，不是內容真的講完了，這裡自動用「請接續」重送，直到收到
            // 非length的finish_reason或觸及安全上限，而不是每次都直接顯示
            // 截斷警告要求使用者手動追問。
            while (true) {
                const requestMessages = autoContinueRounds === 0
                    ? this.messages
                    : lastRoundWasReasoningDeadEnd
                        // tw_stock_db客製: 死路重試沒有「上一段未完成的內容」可以
                        // 接續（finalContent就是空的），不附一則空白assistant訊息，
                        // 只補一句「剛才只想了沒有回答，現在請直接回答」的提醒。
                        ? this.messages.concat([{ role: 'user', content: AI_REASONING_DEADEND_PROMPT }])
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
                if (toolCalls.length) break; // 已經拿到工具呼叫，不需要（也不該）再接續

                // tw_stock_db客製: 見AI_REASONING_DEADEND_PROMPT說明——某些推理
                // 模型會在思考階段就自然觸發EOS，finish_reason回報'stop'而非
                // 'length'，但finalContent到目前為止還是空的、只有reasoningAccum
                // 有大量內容，代表這一輪「想了但沒有真的產出答案」，這種情況
                // 也要當成需要重試，不能只認'length'（否則使用者只會看到一則
                // 「這一輪模型只輸出了思考過程」的警告，而不是像length截斷一樣
                // 自動重試）。
                lastRoundWasReasoningDeadEnd = !finalContent.trim() && reasoningAccum.trim().length > 20;
                if (roundFinishReason !== 'length' && !lastRoundWasReasoningDeadEnd) break;

                autoContinueRounds++;
                if (autoContinueRounds >= MAX_AUTO_CONTINUE_ROUNDS) { hitContinueCap = true; break; }
                this._log(lastRoundWasReasoningDeadEnd
                    ? `↻ 這一輪只輸出了思考過程、沒有產出答案，自動請AI直接回答（第${autoContinueRounds}次）…`
                    : `↻ 回覆超過單次長度上限，自動請AI接續（第${autoContinueRounds}次）…`);
            }

            // tw_stock_db客製: 跟_loopFetch串流路徑同樣的理由（見那邊的詳細
            // 說明）——reasoningAccum只存進非可枚舉的_reasoningDisplay屬性，
            // 不接進finalContent/msg.content，避免模型的內部推理草稿被永久
            // 疊進送給API的對話歷史、造成context愈滾愈大。
            // tw_stock_db客製: 只有觸及安全上限仍未寫完才提醒使用者，正常情況
            // 下自動接續機制會無聲把內容拼完整，見_loopFetch串流路徑同樣的
            // 說明。
            if (hitContinueCap) {
                finalContent += lastRoundWasReasoningDeadEnd
                    ? '\n\n---\n⚠️ **已自動請AI直接回答多次，但這一輪模型每次都只產出思考過程、沒有真正的答案內容（可能是端點異常或模型卡在某種輸出模式）。** 可以直接追問一次，或換一個模型試試。'
                    : '\n\n---\n⚠️ **已自動請AI接續多次仍未寫完，這裡先停下來（可能內容真的很長，或端點異常）。** 可以直接追問「請繼續」。';
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

    // tw_stock_db客製: 階段5——從delegate_to_subagent工具callback抽出來的
    // 共用邏輯，讓互動viewer的subagent_panel元件（見_mountInteractiveViewer）
    // 可以呼叫同一套domain查找/委派邏輯，不用重複寫一份。回傳plain object
    // （不是JSON字串），呼叫端各自決定要不要JSON.stringify。
    async _delegateToSubagentDomain(domainKey, task) {
        const domain = SUBAGENT_DOMAIN_REGISTRY[domainKey];
        if (!domain || !domain.enabled) {
            const available = Object.entries(SUBAGENT_DOMAIN_REGISTRY).filter(([, d]) => d.enabled).map(([k]) => k);
            return { ok: false, error: `domain "${domainKey}" 尚未實作或不存在`, available_domains: available };
        }
        try {
            const result = await this._runSubAgentTask(task, SUBAGENT_DELEGATE_MAX_ROUNDS, {
                allowedToolNames: domain.toolNames,
                systemPrompt: domain.systemPrompt,
            });
            return { ok: true, domain: domainKey, result };
        } catch (err) {
            return { ok: false, error: String(err.message || err) };
        }
    }

    // tw_stock_db客製: 單一子任務的執行迴圈——跟主對話的_loopFetch/
    // _loopFetchNative是同樣的「送出請求→解析工具呼叫→執行→餵回結果→
    // 再送出」邏輯，但簡化成非串流、固定輪數上限、訊息歷史用區域變數
    // （不動this.messages），沒有streaming UI更新、沒有pruneContext（子
    // 任務本來就是短命、用完即丟，正常不會累積到需要壓縮；真的異常時
    // maxRounds上限會擋住，不會無限迴圈）。
    // tw_stock_db客製: options.allowedToolNames（非null時）+ options.systemPrompt
    // （非空字串時）給delegate_to_subagent的domain委派用——把這次子任務迴圈
    // 限制在指定的工具子集內、換上domain專屬system prompt，取代預設的
    // 「看得到全部工具+主system prompt」行為。runBatchSubAgents既有呼叫端
    // 沒有傳options，行為完全不變。
    async _runSubAgentTask(userPrompt, maxRounds = 6, options = {}) {
        const { apiKey, apiUrl, apiModel } = this._getApiConfig();
        const useNative = this._shouldUseNativeToolCalls(apiModel);
        const allowedToolNames = Array.isArray(options.allowedToolNames) ? options.allowedToolNames : null;
        const systemPrompt = (typeof options.systemPrompt === 'string' && options.systemPrompt.trim())
            ? options.systemPrompt
            : this._getFinalSystemPrompt();
        let messages = [
            { role: 'system', content: systemPrompt },
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
                body.tools = this._buildNativeToolsSchema(allowedToolNames);
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
                        const toolDef = this._getToolDefinition(fnName, allowedToolNames);
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
            const regex = /\[CALL:\s*([\p{L}\p{N}_]+)\(([\s\S]*?)\)(?=\]|$)/gu;
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
                    const nameMatch = rawContent.slice(callStart).match(/^\[CALL:\s*([\p{L}\p{N}_]+)\s*\(/u);
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
                    const toolDef = this._getToolDefinition(task.fnName, allowedToolNames);
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
                <div style="margin-top:4px; display:flex; align-items:center; gap:6px;">
                    <input type="checkbox" id="ai-show-trace-chk" ${this.advancedSettings.showInternalTrace === true ? 'checked' : ''} style="cursor:pointer;">
                    <label for="ai-show-trace-chk" style="font-size:12px; cursor:pointer; user-select:none; color:${palette.detailText};">顯示工具呼叫追蹤與思考過程（預設隱藏，圖片結果不受影響）</label>
                </div>

                <div style="margin-top:10px;">
                    <button id="ai-btn-advanced" type="button" style="width:100%; padding:8px 10px; border-radius:6px; border:1px solid ${palette.inputBorder}; background:${palette.detailBg}; color:${palette.detailText}; cursor:pointer;">Advance</button>
                </div>
            </div>
            <div id="ai-chat-body" style="flex:1; padding:15px; overflow-y:auto; background: ${palette.chatBg}; color: ${palette.chatText}; font-size: 14px;"></div>
            <div id="ai-autocomplete-bar" style="background:${palette.detailBg}; color:${palette.detailText}; font-size:11px; padding:4px 12px; display:none; border-top:1px solid ${palette.windowBorder};">
                💡 按 <kbd style="background:#fff;padding:1px 3px;border:1px solid #ccc;border-radius:3px;">Tab</kbd> 自動補全: <span id="ai-suggest-text"></span>
            </div>
            <div id="ai-input-wrap" style="padding:10px; background:${palette.windowBg}; border-top:1px solid ${palette.windowBorder}; position:relative;">
                <div id="ai-history-panel" style="display:none; position:absolute; left:10px; right:10px; bottom:100%; margin-bottom:6px; max-height:45vh; overflow-y:auto; background:${palette.windowBg}; border:1px solid ${palette.inputBorder}; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.25); z-index:20;"></div>
                <div id="ai-slash-menu" style="display:none; position:absolute; left:10px; right:10px; bottom:100%; margin-bottom:6px; max-height:30vh; overflow-y:auto; background:${palette.windowBg}; border:1px solid ${palette.inputBorder}; border-radius:8px; box-shadow:0 4px 16px rgba(0,0,0,0.25); z-index:21;"></div>
                <div id="ai-pending-attachments" style="display:none; flex-wrap:wrap; gap:6px; margin-bottom:6px;"></div>
                <input type="file" id="ai-attach-input" multiple style="display:none;">
                <div style="display:flex; align-items:stretch; gap:6px;">
                    <button id="ai-history-btn" type="button" title="歷史訊息（手機沒有上下鍵時可以用這個瀏覽/挑選之前輸入過的內容）" style="flex:0 0 auto; padding:0 10px; border:1px solid ${palette.inputBorder}; border-radius:6px; background:${palette.detailBg}; color:${palette.detailText}; font-size:15px; cursor:pointer;">🕘</button>
                    <button id="ai-attach-btn" type="button" title="附加檔案（AI 可以叫用檔案解讀能力讀取內容）" style="flex:0 0 auto; padding:0 10px; border:1px solid ${palette.inputBorder}; border-radius:6px; background:${palette.detailBg}; color:${palette.detailText}; font-size:15px; cursor:pointer;">📎</button>
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
            // tw_stock_db客製: 階段3——3D場景YAML跟imageMap同一套「非可枚舉
            // 屬性額外存一份」作法（見_buildToolResultMessage的_displayScene3DYaml
            // 說明）。
            const scene3DMap = {};
            // tw_stock_db客製: 階段4——通用繪圖SVG同一套作法（見
            // _buildToolResultMessage的_displayDrawingSvg說明）。
            const drawingMap = {};
            // tw_stock_db客製: 階段5——互動viewer YAML同一套作法（見
            // _buildToolResultMessage的_displayViewerYaml說明）。
            const viewerMap = {};
            // tw_stock_db客製: /benchmark-model的報告卡也是同一套「非可枚舉
            // 屬性額外存一份」作法（見_handleBenchmarkModelCommand的說明）——
            // 報告物件本身很小（沒有圖片/檔案位元組），直接整包存進
            // localStorage沒有fileMap那種「大檔案不該重複存」的顧慮。
            const benchmarkReportMap = {};
            // tw_stock_db客製: insertSuggestionChipsMessage()的建議操作訊息
            // 也是同一套「非可枚舉屬性額外存一份」作法，跟benchmarkReportMap
            // 同樣理由（chips陣列很小，沒有大檔案顧慮）。
            const chipsMap = {};
            this.messages.forEach((m, i) => {
                if (m._displayDataUrl) imageMap[i] = m._displayDataUrl;
                if (m._reasoningDisplay) reasoningMap[i] = m._reasoningDisplay;
                if (m._downloadFile) fileMap[i] = m._downloadFile;
                if (m._benchmarkReport) benchmarkReportMap[i] = m._benchmarkReport;
                if (m._suggestionChips) chipsMap[i] = m._suggestionChips;
                if (m._displayScene3DYaml) scene3DMap[i] = m._displayScene3DYaml;
                if (m._displayDrawingSvg) drawingMap[i] = m._displayDrawingSvg;
                if (m._displayViewerYaml) viewerMap[i] = m._displayViewerYaml;
            });
            (this.archivedDisplayBlocks || []).forEach((block, bi) => {
                (block.messages || []).forEach((m, mi) => {
                    if (m._displayDataUrl) imageMap[`${bi}:${mi}`] = m._displayDataUrl;
                    if (m._reasoningDisplay) reasoningMap[`${bi}:${mi}`] = m._reasoningDisplay;
                    if (m._downloadFile) fileMap[`${bi}:${mi}`] = m._downloadFile;
                    if (m._benchmarkReport) benchmarkReportMap[`${bi}:${mi}`] = m._benchmarkReport;
                    if (m._suggestionChips) chipsMap[`${bi}:${mi}`] = m._suggestionChips;
                    if (m._displayScene3DYaml) scene3DMap[`${bi}:${mi}`] = m._displayScene3DYaml;
                    if (m._displayDrawingSvg) drawingMap[`${bi}:${mi}`] = m._displayDrawingSvg;
                    if (m._displayViewerYaml) viewerMap[`${bi}:${mi}`] = m._displayViewerYaml;
                });
            });
            localStorage.setItem(this.CHAT_HISTORY_KEY, JSON.stringify({
                messages: this.messages,
                archivedDisplayBlocks: this.archivedDisplayBlocks,
                imageMap,
                reasoningMap,
                fileMap,
                benchmarkReportMap,
                chipsMap,
                scene3DMap,
                drawingMap,
                viewerMap,
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
            if (data.chipsMap) {
                Object.entries(data.chipsMap).forEach(([key, chips]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_suggestionChips', { value: chips, enumerable: false, configurable: true });
                });
            }
            if (data.scene3DMap) {
                Object.entries(data.scene3DMap).forEach(([key, yamlText]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_displayScene3DYaml', { value: yamlText, enumerable: false, configurable: true });
                    this._latestScene3DYaml = yamlText;
                });
            }
            if (data.drawingMap) {
                Object.entries(data.drawingMap).forEach(([key, svgText]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_displayDrawingSvg', { value: svgText, enumerable: false, configurable: true });
                });
            }
            if (data.viewerMap) {
                Object.entries(data.viewerMap).forEach(([key, yamlText]) => {
                    const msg = resolveMsg(key);
                    if (msg) Object.defineProperty(msg, '_displayViewerYaml', { value: yamlText, enumerable: false, configurable: true });
                    this._latestViewerYaml = yamlText;
                });
            }
        } catch (err) {
            console.warn('對話紀錄讀取失敗，改用空白對話:', err);
        }
    }

    // tw_stock_db客製: 使用者手動清除對話（🗑️按鈕，見_initEventListeners）
    // ，也是_loopFetch/_loopFetchNative在真的沒辦法解決400/413時建議使用者
    // 採取的動作（見那兩處錯誤訊息）。2026-08-24使用者要求清空對話後要
    // 重新插入一次建議操作訊息（見insertSuggestionChipsMessage()），跟
    // 建構子裡「完全沒有對話時才插入」是同一個原則——清空後的對話狀態
    // 等同「完全沒有對話」。
    _clearChatHistory() {
        this.messages = [];
        this.archivedDisplayBlocks = [];
        localStorage.removeItem(this.CHAT_HISTORY_KEY);
        // insertSuggestionChipsMessage()在chipsProvider沒回傳任何建議時會
        // 直接return、不會呼叫_renderMessageHistory()——這裡不能依賴它一定
        // 會重繪，得自己確保清空後的畫面（不管有沒有插入建議訊息）一定會
        // 更新，不然畫面會停留在清空前的舊內容。
        const beforeLength = this.messages.length;
        this.insertSuggestionChipsMessage();
        if (this.messages.length === beforeLength) this._renderMessageHistory();
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

        // tw_stock_db客製: 2026-09-05使用者實測回報——「我沒看到星空，重做」
        // 這種情境下，AI在同一輪對話裡連續呼叫好幾次render_3d_scene（或
        // render_drawing/render_interactive_viewer）試錯，原本每一次都是
        // 「一律顯示」的最終視覺結果，導致畫面被好幾張其實已經被取代的
        // 草稿灌爆——使用者要的是「交件之前都是對草稿的修改」，只有同一輪
        // 裡最後一次同類型的呼叫才算數。這裡在重繪之前先標記哪些訊息是
        // 「後來被同一輪更新的呼叫取代掉的草稿」，讓_renderSingleMessage
        // 把它們當成內部過程處理（受showInternalTrace開關控制，不是
        // 一律顯示），不是刪除訊息本身——AI仍然看得到完整的對話歷史。
        this._markSupersededVisualDrafts(this.messages);
        this.messages.forEach(msg => this._renderSingleMessage(msg, chatBody, palette));
        chatBody.scrollTop = wasNearBottomForRerender ? chatBody.scrollHeight : prevScrollTopForRerender;
        this._persistChatHistory();
    }

    // 「同一輪」定義為兩則role:'user'訊息之間的區間。同一輪內，同一種視覺
    // 類型（scene3d/drawing/viewer/image）如果出現不只一次，只有最後一次
    // 保持「一律顯示」，較早的幾次標記_visualSuperseded=true。每次呼叫都
    // 會把所有視覺訊息的旗標重新算過一次（configurable:true可以覆寫），
    // 不會有殘留的舊狀態。
    _markSupersededVisualDrafts(messages) {
        const KIND_PROPS = ['_displayScene3DYaml', '_displayDrawingSvg', '_displayViewerYaml', '_displayDataUrl'];
        let lastIdxByKind = {};
        messages.forEach((msg, idx) => {
            if (msg.role === 'user') { lastIdxByKind = {}; return; }
            for (const prop of KIND_PROPS) {
                if (!msg[prop]) continue;
                if (lastIdxByKind[prop] !== undefined) {
                    Object.defineProperty(messages[lastIdxByKind[prop]], '_visualSuperseded', { value: true, enumerable: false, configurable: true });
                }
                Object.defineProperty(msg, '_visualSuperseded', { value: false, enumerable: false, configurable: true });
                lastIdxByKind[prop] = idx;
            }
        });
    }

    // tw_stock_db客製: 2026-09-05使用者實測回報——「重做」時AI連續呼叫好
    // 幾次render_3d_scene，每次都被當成「一律顯示」的最終結果，畫面塞滿
    // 已經被取代的草稿。同一輪內被_markSupersededVisualDrafts標記過的
    // 視覺訊息改用這個helper：預設完全不畫（受showInternalTrace開關控制，
    // 跟其他內部過程一致），開關打開時才顯示一個收合的草稿卡，展開時才
    // 用mountFn懶惰掛載（沒人點開就不用花資源真的去建立3D場景/表單）。
    _renderSupersededDraftCard(container, label, mountFn) {
        if (this.advancedSettings.showInternalTrace !== true) return;
        const palette = this._getThemePalette();
        const draftEl = document.createElement('details');
        draftEl.style.cssText = `margin-bottom: 12px; font-size: 12px; background: ${palette.detailBg}; border-left: 4px solid #94a3b8; border-radius: 6px; padding: 6px 10px; color: ${palette.detailText}; max-width: 95%;`;
        draftEl.innerHTML = `<summary style="font-weight: bold; outline: none; user-select: none; cursor: pointer;">🗂️ ${this._escapeHtml(label)}（已被稍後版本取代，點擊展開查看草稿）</summary>`;
        const inner = document.createElement('div');
        inner.style.cssText = 'margin-top: 6px;';
        draftEl.appendChild(inner);
        let mounted = false;
        draftEl.addEventListener('toggle', () => {
            if (draftEl.open && !mounted) { mounted = true; mountFn(inner); }
        });
        container.appendChild(draftEl);
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

        // tw_stock_db客製: 見insertSuggestionChipsMessage()的說明——建議操作
        // 訊息用一般的文字內容當fallback（給沒有跑這段特殊渲染分支的情境，
        // 例如未來忘記處理的地方），這裡疊加真正的可點擊chip按鈕，點擊只
        // 填入輸入框、不自動送出。
        if (msg._suggestionChips && msg._suggestionChips.length) {
            const wrap = document.createElement('div');
            wrap.style.cssText = `margin-bottom: 12px; padding: 10px 14px; border-radius: 6px; max-width: 90%; background: ${palette.assistantBg}; color: ${palette.assistantText};`;
            const intro = document.createElement('div');
            intro.style.cssText = 'margin-bottom:8px; font-size:13px;';
            intro.textContent = '💡 建議操作（點擊可以快速填入輸入框）：';
            wrap.appendChild(intro);
            const chipRow = document.createElement('div');
            chipRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px;';
            msg._suggestionChips.forEach((c) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'ai-suggestion-chip';
                btn.style.cssText = `padding:4px 10px; border-radius:999px; border:1px solid ${palette.inputBorder}; background:${palette.detailBg}; color:${palette.detailText}; font-size:12px; cursor:pointer;`;
                btn.textContent = c.label || c.text;
                btn.addEventListener('click', () => {
                    const inputEl = document.getElementById('ai-input-text');
                    if (inputEl) { inputEl.value = c.text; inputEl.focus(); }
                });
                chipRow.appendChild(btn);
            });
            wrap.appendChild(chipRow);
            container.appendChild(wrap);
            return;
        }

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
                // tw_stock_db客製: 使用者實測回報PPTX下載被瀏覽器/系統誤判成zip
                // 檔——PPTX(OOXML)內部結構本來就是zip壓縮檔，Blob經過IndexedDB
                // 存取一輪後，record.blob自己的.type偶爾會遺失變成空字串（已知
                // 瀏覽器/IndexedDB結構化複製的行為，不是每次都會發生），這時
                // createObjectURL()產生的下載沒有明確MIME type可用，瀏覽器只能
                // 用內容本身猜測，猜出zip格式（技術上沒錯，但不是使用者要的
                // 結果）。record.mimeType是put()當初存進去、跟blob分開的獨立
                // 欄位，一直都在但從沒被實際用來設定下載內容——這裡用它明確
                // 重新包一次Blob，確保不管record.blob.type本身還在不在，下載
                // 出去的內容一律帶正確的PPTX/PDF/Markdown MIME type。
                const blobWithType = record.mimeType && record.blob.type !== record.mimeType
                    ? new Blob([record.blob], { type: record.mimeType })
                    : record.blob;
                const url = URL.createObjectURL(blobWithType);
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
            if (this.advancedSettings.showInternalTrace !== true) return;
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
            if (this.advancedSettings.showInternalTrace !== true) return;
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

            // tw_stock_db客製: 階段3——3D場景跟圖片同一個「一律顯示、不受
            // showInternalTrace開關影響」原則（使用者明講「除了產生圖片」
            // 這句話的精神延伸到3D場景，都是最終視覺產出，不是中間追蹤
            // 資訊）。_mount3DScene是非同步的（要動態載入three.js/js-yaml），
            // 這裡先同步插入容器保住訊息順序，掛載完成再非同步填入canvas。
            if (msg._displayScene3DYaml) {
                if (msg._visualSuperseded) {
                    this._renderSupersededDraftCard(container, '3D場景草稿', (inner) => { this._mount3DScene(inner, msg._displayScene3DYaml); });
                    return;
                }
                const sceneWrap = document.createElement('div');
                sceneWrap.style.cssText = 'margin-bottom: 12px; max-width: 95%;';
                sceneWrap.innerHTML = `<div style="font-size: 12px; font-weight: bold; color: #6366f1; margin-bottom: 4px;">🧊 3D場景（可用滑鼠拖曳/滾輪縮放）</div>`;
                // tw_stock_db客製: 2026-09-05使用者要求——canvas要包一層
                // position:relative容器，右下角疊一個「重設視角」按鈕
                // （position:absolute），下方另外一列放場景標題（如果場景
                // YAML有給title的話）+匯出按鈕（見_appendCardExportButton的
                // 說明，這是新增的、掛在卡片本身而不是訊息文字回覆上的匯出
                // 入口）。
                const canvasHolder = document.createElement('div');
                canvasHolder.style.cssText = 'position:relative;';
                const mountDiv = document.createElement('div');
                canvasHolder.appendChild(mountDiv);
                const resetBtn = document.createElement('button');
                resetBtn.type = 'button';
                resetBtn.title = '重設視角';
                resetBtn.textContent = '🔄';
                resetBtn.style.cssText = 'display:none; position:absolute; right:8px; bottom:8px; border:none; background:rgba(0,0,0,0.45); color:#fff; border-radius:6px; cursor:pointer; font-size:14px; padding:4px 8px; line-height:1.4;';
                canvasHolder.appendChild(resetBtn);
                sceneWrap.appendChild(canvasHolder);
                const footerRow = document.createElement('div');
                footerRow.style.cssText = 'display:flex; align-items:center; justify-content:space-between; margin-top:4px; gap:8px;';
                const titleDiv = document.createElement('div');
                titleDiv.style.cssText = 'font-size:12px; opacity:0.75; flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
                footerRow.appendChild(titleDiv);
                const btnGroup = document.createElement('div');
                btnGroup.style.cssText = 'display:flex; align-items:center; gap:4px; flex:0 0 auto;';
                footerRow.appendChild(btnGroup);
                sceneWrap.appendChild(footerRow);
                // tw_stock_db客製: 2026-09-05使用者要求——除了匯出PPTX/PDF，
                // 也要能直接下載/檢視這個場景的原始YAML（不經過任何轉檔）。
                this._appendCardSourceButtons(btnGroup, sceneWrap, () => msg._displayScene3DYaml, '3D場景', 'yaml');
                this._appendCardExportButton(btnGroup, async () => {
                    if (!msg._scene3DHandle || typeof msg._scene3DHandle.snapshotDataUri !== 'function') return null;
                    try { return { dataUrl: msg._scene3DHandle.snapshotDataUri(), kind: 'scene3d' }; } catch (_) { return null; }
                }, '3D場景');
                container.appendChild(sceneWrap);
                this._mount3DScene(mountDiv, msg._displayScene3DYaml).then((handle) => {
                    if (handle) {
                        // tw_stock_db客製: 存活的handle（含snapshotDataUri）
                        // 快取在訊息物件上，給匯出PPTX/PDF時直接用目前畫面上
                        // 正在跑的這個canvas截圖，不用另外off-screen重新掛載
                        // 一次（見_captureVisualSnapshot）。非可枚舉，避免
                        // JSON.stringify(this.messages)存檔時碰到THREE.js
                        // 物件的循環參照。
                        Object.defineProperty(msg, '_scene3DHandle', { value: handle, enumerable: false, configurable: true });
                        if (handle.title) titleDiv.textContent = handle.title;
                        resetBtn.style.display = 'block';
                        resetBtn.addEventListener('click', (e) => { e.stopPropagation(); handle.resetView(); });
                    }
                    if (handle && !handle.webglOk) {
                        const badge = document.createElement('div');
                        badge.style.cssText = 'font-size:10px; color:#dd6b20; margin-top:4px;';
                        badge.textContent = '⚠️ 這個瀏覽器/裝置無法啟用WebGL，已改用CPU軟體繪圖顯示（互動與動畫仍然可用，但不支援材質貼圖）。';
                        sceneWrap.appendChild(badge);
                    }
                }).catch((err) => {
                    mountDiv.innerHTML = `<div style="padding:8px; color:#e53e3e; font-size:12px;">⚠️ 3D場景渲染失敗：${this._escapeHtml(err.message || String(err))}</div>`;
                });
                return;
            }

            // tw_stock_db客製: 階段4——通用繪圖，跟圖片/3D場景同一個「一律
            // 顯示、不受showInternalTrace開關影響」原則。SVG在存進
            // _displayDrawingSvg之前已經在render_drawing工具callback裡經過
            // DOMPurify消毒，這裡直接innerHTML是安全的，不需要再消毒一次。
            if (msg._displayDrawingSvg) {
                if (msg._visualSuperseded) {
                    this._renderSupersededDraftCard(container, '繪圖草稿', (inner) => { inner.innerHTML = msg._displayDrawingSvg; });
                    return;
                }
                const drawWrap = document.createElement('div');
                drawWrap.style.cssText = 'margin-bottom: 12px; max-width: 95%;';
                drawWrap.innerHTML = `
                    <div style="font-size: 12px; font-weight: bold; color: #dd6b20; margin-bottom: 4px;">🎨 繪圖</div>
                    <div style="max-width:100%; overflow:auto; background:#fff; border-radius:6px; border:1px solid rgba(0,0,0,0.1); padding:8px;">${msg._displayDrawingSvg}</div>
                `;
                const drawFooter = document.createElement('div');
                drawFooter.style.cssText = 'display:flex; justify-content:flex-end; gap:4px; margin-top:4px;';
                drawWrap.appendChild(drawFooter);
                this._appendCardSourceButtons(drawFooter, drawWrap, () => msg._displayDrawingSvg, '繪圖', 'svg');
                this._appendCardExportButton(drawFooter, async () => {
                    try { return { dataUrl: await this._rasterizeSvgToDataUrl(msg._displayDrawingSvg, 800), kind: 'drawing' }; } catch (_) { return null; }
                }, '繪圖');
                container.appendChild(drawWrap);
                return;
            }

            // tw_stock_db客製: 階段5——互動viewer，同樣「一律顯示、不受
            // showInternalTrace開關影響」原則。掛載是非同步的（要載入
            // js-yaml），先同步插入容器保住訊息順序。
            if (msg._displayViewerYaml) {
                if (msg._visualSuperseded) {
                    this._renderSupersededDraftCard(container, '互動表單草稿', (inner) => {
                        const validation = this._validateInteractiveViewerYaml(msg._displayViewerYaml);
                        if (validation.ok) this._mountInteractiveViewer(inner, validation.viewer);
                        else inner.textContent = '格式錯誤: ' + validation.error;
                    });
                    return;
                }
                const viewerWrap = document.createElement('div');
                viewerWrap.style.cssText = 'margin-bottom: 12px; max-width: 95%;';
                viewerWrap.innerHTML = `<div style="font-size: 12px; font-weight: bold; color: #059669; margin-bottom: 4px;">📋 互動表單</div>`;
                const mountDiv = document.createElement('div');
                container.appendChild(viewerWrap);
                viewerWrap.appendChild(mountDiv);
                const viewerFooter = document.createElement('div');
                viewerFooter.style.cssText = 'display:flex; justify-content:flex-end; gap:4px; margin-top:4px;';
                viewerWrap.appendChild(viewerFooter);
                this._appendCardSourceButtons(viewerFooter, viewerWrap, () => msg._displayViewerYaml, '互動表單', 'yaml');
                this._appendCardExportButton(viewerFooter, async () => {
                    try { return { text: await this._summarizeViewerStateForExport(msg._displayViewerYaml), kind: 'viewer_summary' }; } catch (_) { return null; }
                }, '互動表單');
                (async () => {
                    const validation = this._validateInteractiveViewerYaml(msg._displayViewerYaml);
                    if (!validation.ok) {
                        mountDiv.innerHTML = `<div style="padding:8px; color:#e53e3e; font-size:12px;">⚠️ 互動viewer格式錯誤：${this._escapeHtml(validation.error)}</div>`;
                        return;
                    }
                    await this._mountInteractiveViewer(mountDiv, validation.viewer);
                })().catch((err) => {
                    mountDiv.innerHTML = `<div style="padding:8px; color:#e53e3e; font-size:12px;">⚠️ 互動viewer渲染失敗：${this._escapeHtml(err.message || String(err))}</div>`;
                });
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
            if (this.advancedSettings.showInternalTrace !== true) return;
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
            if (thinking.thinking && this.advancedSettings.showInternalTrace === true) {
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
                this._appendMarkdownExportButton(div, answerText, palette, msg);
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

        // tw_stock_db客製: 2026-08-28使用者要求——指令名稱打完、開始打參數時，
        // 如果該指令有宣告argChoices（見register_slash_command的說明），顯示
        // 「目前正在打的這個位置參數」的候選值清單，取代原本「打了空白就整個
        // 隱藏」的行為。回傳null代表這個情境不該顯示參數選單（呼叫端會retreat
        // 回command-name-matching模式或直接隱藏）。
        const renderArgMenu = (val) => {
            const firstSpace = val.indexOf(' ');
            const cmdPart = val.slice(0, firstSpace).toLowerCase();
            const entry = this.slashCommands.get(cmdPart);
            if (!entry || !entry.argChoices || !entry.argChoices.length) return false;
            const restText = val.slice(firstSpace + 1);
            const tokens = restText.split(/\s+/);
            const argIndex = tokens.length - 1; // 目前正在打第幾個參數(0-based)
            const currentToken = (tokens[argIndex] || '').toLowerCase();
            const rawChoices = entry.argChoices[argIndex];
            if (!Array.isArray(rawChoices) || !rawChoices.length) return false;
            const normalized = rawChoices.map(c => (typeof c === 'object' && c !== null) ? c : { value: c, label: c });
            const filtered = normalized.filter(c => String(c.value).toLowerCase().includes(currentToken) || String(c.label).toLowerCase().includes(currentToken));
            if (!filtered.length) return false;
            if (suggestBar) suggestBar.style.display = 'none';
            slashMenu.innerHTML = filtered.map((c) => `
                <div class="ai-slash-item" data-arg-value="${this._escapeAttr(String(c.value))}" data-arg-index="${argIndex}" style="padding:8px 12px; cursor:pointer; border-bottom:1px solid ${palette.windowBorder};">
                    <div style="font-size:13px; font-weight:bold; color:#76b900;">${this._escapeHtml(String(c.value))}</div>
                    ${c.label !== c.value ? `<div style="font-size:11px; color:${palette.detailText}; margin-top:2px;">${this._escapeHtml(String(c.label))}</div>` : ''}
                </div>
            `).join('');
            slashMenu.style.display = 'block';
            return true;
        };

        const renderMenu = () => {
            if (this.advancedSettings.slashCommandMenuEnabled === false) { hide(); return; }
            const val = inputText.value;
            if (!val.startsWith('/')) { hide(); return; }
            if (/\s/.test(val)) {
                if (!renderArgMenu(val)) hide();
                return;
            }
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
            if (item.dataset.cmd) {
                inputText.value = item.dataset.cmd + ' ';
            } else if (item.dataset.argValue !== undefined) {
                // 把「目前正在打的那個參數token」換成選中的值，前面已經打完的
                // 參數(如果有)原封不動保留。
                const val = inputText.value;
                const firstSpace = val.indexOf(' ');
                const cmdPart = val.slice(0, firstSpace);
                const restText = val.slice(firstSpace + 1);
                const tokens = restText.split(/\s+/);
                const argIndex = Number(item.dataset.argIndex);
                tokens[argIndex] = item.dataset.argValue;
                inputText.value = `${cmdPart} ${tokens.slice(0, argIndex + 1).join(' ')} `;
            }
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
    // breadcrumb讓使用者按下去當推薦詢問」，2026-08-24使用者回報這個常駐
    // 在輸入框上方的chip列在手機上會換成好幾行、很佔畫面空間，改成不再是
    // 常駐bar，只在「完全沒有對話」或「使用者輸入/suggest主動要求」時，
    // 把建議插入成對話裡的一則訊息（見下面insertSuggestionChipsMessage，
    // 在_renderSingleMessage()裡有對應的_suggestionChips渲染分支），平常
    // 捲動離開後不佔任何固定UI空間。跟register_slash_command()同一種
    // 「floating-assistant.js只提供機制、tw_stock_db自己的內容從index.html
    // 掛進來」設計，這裡不寫死任何跟股票/tw_stock_db有關的文字，只透過
    // options.chipsProvider這個callback（建構子傳入，跟既有的
    // contextProvider是同一種模式）取得建議內容。點擊chip只會把文字填進
    // 輸入框（不自動送出），讓使用者可以先看一眼/改字再送，比較不會誤觸發
    // 要花token或會產生檔案的動作（例如「口頭+pptx」）。
    insertSuggestionChipsMessage() {
        const chips = typeof this.options.chipsProvider === 'function' ? (this.options.chipsProvider() || []) : [];
        if (!chips.length) return;
        const content = '💡 建議操作（點擊可以快速填入輸入框）：\n' + chips.map(c => `- ${c.label || c.text}`).join('\n');
        const msg = { role: 'assistant', content };
        // 非可枚舉：跟_downloadFile/_benchmarkReport同一套作法（見
        // _persistChatHistory的chipsMap），不會被送進實際的LLM API request
        // body裡的訊息結構混淆——不過content本身是正常的可讀文字，就算哪個
        // call site忘了排除也不會出問題，這個屬性純粹是額外的互動式渲染
        // 提示。
        Object.defineProperty(msg, '_suggestionChips', { value: chips, enumerable: false, configurable: true });
        this.messages.push(msg);
        this._persistChatHistory();
        this._renderMessageHistory();
    }

    // tw_stock_db客製: 2026-08-26使用者要求——換股票（或任何會讓
    // chipsProvider()回傳內容改變的動作）時，如果對話「目前唯一的內容」
    // 就是建議操作訊息本身（代表使用者根本還沒開始聊，只是看看有什麼可以
    // 問），舊的建議會造成誤會——例如剛從2330切到2027，畫面卻還顯示
    // 「台積電(2330)持股診斷」，使用者會誤以為那是針對目前這檔的建議。
    // 這種「對話還沒真的開始」的情況下應該原地替換成新內容，不是插入
    // 新一則（避免同一個對話裡疊出兩則建議操作訊息）。如果使用者已經開始
    // 聊（除了那則建議還有其他訊息），維持insertSuggestionChipsMessage()
    // 既有的「不打斷對話」原則，完全不動、不呼叫也不插入。
    refreshSuggestionChipsIfUntouched() {
        const onlyMsg = this.messages.length === 1 ? this.messages[0] : null;
        if (!onlyMsg || !onlyMsg._suggestionChips) {
            if (!this.messages.length) this.insertSuggestionChipsMessage();
            return; // 已經有其他對話內容，不打斷，什麼都不做
        }
        const chips = typeof this.options.chipsProvider === 'function' ? (this.options.chipsProvider() || []) : [];
        if (!chips.length) return;
        const content = '💡 建議操作（點擊可以快速填入輸入框）：\n' + chips.map(c => `- ${c.label || c.text}`).join('\n');
        onlyMsg.content = content;
        Object.defineProperty(onlyMsg, '_suggestionChips', { value: chips, enumerable: false, configurable: true });
        this._persistChatHistory();
        this._renderMessageHistory();
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
        const showTraceChkBx = document.getElementById('ai-show-trace-chk');
        if (showTraceChkBx) {
            showTraceChkBx.addEventListener('change', (e) => {
                this.advancedSettings.showInternalTrace = e.target.checked;
                this._saveAdvancedSettings();
                this._renderMessageHistory();
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

        this._wireAttachmentUpload();
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
