# Knowledge Inventory 的磁碟 swap（桌面版）：原生磁碟檔

> 對應 WebServices/Redmine 那邊的 `DESIGN.keeplookup-swap.md`（keeplookup 磁碟 swap）。同一個目標：**庫不受 wasm 記憶體上限（約 1–2 GB）限制**。桌面版不需要自寫 VFS／swap，直接讓原生 SQLite 開磁碟上的 `.keeplookup`。

## 結論：桌面版已經有原生引擎，這次補的是「位置、自動切換、串流搬家、設定」
- **引擎**：`sqlite-engine.js`（主行程子行程，Electron 44 內建 `node:sqlite`，SQLite 3.53.4，含 FTS5＋trigram，實測可用）。**不用 better-sqlite3**（要編譯原生模組、`node:sqlite` 已經在 DESIGN.sqlite.md 的引擎裡）。`file:` 位置本來就是原生直開；儲存層（`knowledge_store.js`）仍在 renderer，經既有的 `desktopAPI.sql.call`（`fa:sql:call`）下 SQL，所以**沒有另寫一套 `fa:knowledge:<op>` 的 OPS**——那是 Redmine 版 worker 在 server 端才需要的。檔案格式不變，和網頁版／Redmine 版互通。
- **開庫參數**（`open` 新增 `cacheMB`、`durable`）：`PRAGMA cache_size=-<MB×1024>`（設定「頁面快取」，預設 96 MB）、`journal_mode=DELETE`、`synchronous=FULL`（寫到一半被殺也只剩整筆交易）。
- **`fa:knowledge:call`**（`knowledge-native.js`，由 `main-ext.js` 載入、preload 暴露 `desktopAPI.knowledge.call`）：`info`（app 資料夾 `knowledge/`、剩餘空間）、`stat`、`writeChunk`（8 MB 分段寫 `.part`、fsync、原子改名、回傳 sha256）、`readChunk`、`copy`（串流複製＋來源/目的 sha256 核對）、`hash`、`remove`。只接受絕對路徑、副檔名 `.keeplookup`。

## 位置與搬家（`knowledge_host.js`）
- 位置新增 `native`（桌面版）：實際存成 `file:<userData>/knowledge/<名>.keeplookup`（預設 `main`）；不覆蓋既有檔案。`idb`／`fap` 維持現有行為（小庫，暫存副本，上限 512 MB）。
- 搬家沿用「複製 → 開新位置 → 比對來源/片段/向量數 → 才切換設定」。磁碟↔磁碟走主行程串流複製；idb／fap→磁碟分段寫（不產生整檔 base64）並核對 sha256；磁碟→idb／fap 分段讀。
- **自動切換**（設定「知識庫儲存」：自動／一律記憶體／一律磁碟，門檻預設 256 MB）：非磁碟位置的庫超過門檻（自動），或模式為一律磁碟，下一次動作前自動搬成原生磁碟檔，舊位置的副本保留，結果寫在 `status.tier_note`（設定面板顯示）。失敗就維持原位置並記下原因。
- UI：設定面板新增「儲存」區塊，並直接說這個環境能不能用原生磁碟檔（網頁版：不能，庫在記憶體，上限約 1 GB）。`knowledge_location` 工具與 `/knowledge migrate native [檔名]` 同步。

## 網頁版（沒有主程序）：後續
OPFS VFS＋swap（`ai_chat_keeplookup_vfs.js`／`_swap.js` 整套，見 HANDOFF-ai-bmc-rack-sync.md F 節）**尚未做**。`knowledge_host.js` 的位置／設定／決策已經是同一份，之後只要把 rpc 接到 OPFS 引擎。

## 驗證
`scripts/knowledge-tests/knowledge_native.test.js`（15 項，含 kill -9 ×4 後 quick_check）與既有 core／store 測試，用 `ELECTRON_RUN_AS_NODE=1 node_modules/electron/dist/electron <test>` 跑（要 node:sqlite）。大庫實測 `knowledge_native_bench.js`（手動）：1.5 GB／358,000 片段（含 FTS 與 384 維向量）、頁面快取 16 MB 時引擎行程 RSS 約 107 MB；串流複製＋雙 sha256 9 秒；複本重開數量一致；寫到一半 SIGKILL 後 `quick_check=ok`。真 Electron 端對端（`FA_DEBUG_EVAL_FILE`）：idb→自動 native、native→file 串流、file→idb→native 全部數量一致、查詢可用。
