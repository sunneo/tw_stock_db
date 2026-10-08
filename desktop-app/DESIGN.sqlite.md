# SQLite 工具集：引擎、終端機 sqlite3、sqlitebrowser、Python 橋接、專案索引

> 設計來源：Redmine 外掛那邊的 DESIGN.sqlite-fap.md／DESIGN.project-index.md（網頁版、sqlite-wasm＋唯讀 VFS＋寫回式 VFS）。這份記錄的是**這個專案**（桌面版＋網頁版）實際做了什麼、和那份設計不同的地方、以及還沒做的。專案索引見 [DESIGN.project-index.md](DESIGN.project-index.md) §15，終端機 `/mnt` 見 [DESIGN.run-terminal.md](DESIGN.run-terminal.md) §17。

## 1. 兩個引擎，同一個協定

| | 桌面版 | 網頁版 |
|---|---|---|
| 引擎 | 主行程的 `node:sqlite`（Electron 44，SQLite 3.53.4、含 FTS5），`sqlite-engine.js`；每個連線一個子行程 | sqlite-wasm（官方套件 `@sqlite.org/sqlite-wasm` 3.53.4，預設從 jsDelivr 載入，設定 `sqliteWasmUrl` 可換），每個連線一個 worker（`wasm_ops.js`／`wasm_engine.js`） |
| 資料庫在哪 | 磁碟上的真實檔案，SQLite 自己用 `PRAGMA cache_size`（64 MB）管快取，與檔案大小無關 | wasm 記憶體（deserialize 進來、export 出去寫回），上限約 1 GB，適合小～中型 |
| 取消／逾時 | 砍子行程，SQLite 下次開啟自動回滾 | 砍 worker，連線標成已中斷（未寫回的變更遺失） |
| 呼叫 | `desktopAPI.sql.call(op, args)`（IPC `fa:sql:call`） | `FaWasmEngine.WasmSqlEngine.call(op, args)` |

協定（宿主的 `_sqlCall(op, args)` 統一）：`open`／`exec`／`query`／`schema`／`pragma`／`status`／`checkpoint`／`close`／`cancel`／`list`，桌面版另有 `stage`／`move`／`stat`，網頁版另有 `export`。BLOB＝`{$blob:base64}`；超過 2^53 的整數＝`{$int:"…"}`；`typed:true` 時整數值的實數＝`{$real:"1.0"}`（命令列輸出 `1` 與 `1.0` 不同才分得出來）。結果列是陣列（同名欄位 `a.id, b.id` 不會互相覆蓋）。`exec` 的語句切分（`sql_split.js`）處理字串、引號識別字、註解、觸發器 BEGIN…END、CASE…END；同一段輸入遇到錯誤就停（與真的 sqlite3 一致）。

**為什麼桌面版要用子行程而不是 worker_thread**：`node:sqlite` 是同步的原生呼叫，`worker.terminate()` 中止不了正在跑的查詢（一個遞迴查詢會讓 terminate 一直卡住，實測）。砍行程才能取消。子行程以 `ELECTRON_RUN_AS_NODE` 啟動、限制 V8 堆積（`--max-old-space-size=512 --expose-gc`），大結果後主動 GC；`temp_store` 用預設（檔案），大排序不吃記憶體。

**檔案來源（ref）解析順序**：`:memory:` → `file:`／`host:`／磁碟機代號開頭的真實路徑（桌面版直接開；網頁版明確報錯）→ `fap:<名稱>/<路徑>`（桌面版對應到授權資料夾的真實檔案直接開、不複製；網頁版把位元組讀進來）→ 終端機沙盒內的路徑（暫存副本，in-memory 優先，不會碰到別處同名檔案）。暫存副本唯讀就丟掉、可寫就在 `commit`／關閉時寫回原處。

## 2. 終端機 `sqlite3`／`sqlite`

核心 `renderer/src/sql/shell_core.js`（純 JS，行為對齊真的 sqlite3）：14 種輸出模式、點指令（`.mode .headers .separator .nullvalue .width .tables .schema .indexes .databases .dump .import .read .output .once .print .echo .bail .timer .show .open .quit`）、選項（`-cmd -init -readonly -bail -echo -header -json -csv -column …`）、REPL 提示字元。`-csv` 與 `.mode csv` 的列尾不同（與真的一致）。對真引擎 16 項整合測試（`scripts/sqlite-shell.itest.js`）；預期輸出依對 sqlite3 行為的認識撰寫，本機沒有 sqlite3 可逐字比對。

終端機整合（虛擬指令，非同步引擎）：選項、`-cmd`／`-init`、多段 SQL 引數、stdin、管線尾端（`echo … | sqlite3 db`：前段在沙盒跑完、輸出當 stdin）、重導向 `< > >> 2>&1 2>/dev/null`、互動模式（`sqlite> `／`   ...> `、多行、↑↓歷史、Ctrl-C 清除未完成語句、Ctrl-D／`.quit` 結束）。限制：`fap:` 或需要非同步引擎的資料庫不能放在 `<` 之後的位置（管線尾端與重導向已處理）；`.restore`／`.system`／`.shell`／`.cd`／`.load` 不支援。

## 3. `sqlitebrowser`

`renderer/src/sql/browser_core.js`（純函式，9 項測試）＋`browser_ui.js`（視窗，z-index 高於終端機等浮動視窗）。四個分頁：資料庫結構（建表、加欄位、建索引、刪除——**所有 DDL 先顯示 SQL 再確認**）、瀏覽資料（分頁、欄位標頭一列過濾框：`abc` 含有、`=abc` 相等、`<>x`、`>5 >=5 <5 <=5`、`a..b` 範圍、`*.c` GLOB、`NULL`／`!NULL`、`/regex/` 只過濾本頁；點標頭排序；儲存格雙擊編輯／檢視；BLOB 十六進位與圖片預覽；新增／刪除列；匯出 CSV／JSON／Markdown）、執行 SQL（多語句、歷史、Explain、取消、危險語句確認、結果匯出）、Pragmas（含 integrity_check）。**編輯先暫存在開著的交易，Write Changes（Ctrl+S）才 COMMIT 並寫回來源；Revert 回滾；關閉有變更時問 寫入／放棄／取消；beforeunload 警告。** 所有過濾都是參數化 SQL。入口：終端機 `sqlitebrowser [-readonly] [檔案]`、`/sqlite-browser`。

## 4. Python：`fa_sqlite`

`renderer/src/pybridge/fa_sqlite.py`：sqlite3 相容（DB-API 風格）介面，走同一個引擎；`connect`／`cursor`／`execute`／`executemany`／`executescript`／`commit`（暫存副本寫回）／`rollback`／`Row`／交易語意（`isolation_level`）／錯誤型別對應。host 端是 `_pyBridgeDispatch` 的 `sqlite.*` op。**只在執行技能包的腳本裡可用**（橋接的既有範圍）；一般的 Python 想開本機資料庫直接用標準函式庫的 sqlite3 就好（網頁版 Pyodide 內建的 sqlite3 開不到 fap）。測試 `scripts/test_fa_sqlite.py`（11 項，用標準 sqlite3 假冒引擎來對照行為）。

## 5. AI 工具 `repo_sql`

對專案索引（SQLite）下**唯讀** SQL：一次一句 SELECT／WITH／EXPLAIN、最多 500 列、每格 400 字、不回 BLOB、不能 ATTACH／PRAGMA。只有桌面版、SQLite 索引的專案。補足 `repo_ask` 回答不了的統計類問題。

## 6. 和 Redmine 那份設計不同的地方

- **三層 VFS 都做了（網頁版，`renderer/src/sql/wasm_vfs.js`）**：①唯讀 `fapfile`（File.slice＋FileReaderSync，256KB 區塊、LRU 256 塊）；②寫回式（髒頁以 4096 位元組為單位，超過 32MB 溢出到 OPFS，只在交易外的提交點／sync／關閉／髒量 >64MB／閒置 30 秒寫回，寫回前比對大小與修改時間，衝突時拒絕、`force` 才覆蓋）；③建庫用 OPFS 同步存取檔（journal OFF、sync OFF、獨佔），完成後 `copyOut` 串流複製進專案資料夾。專案索引在網頁版因此也是專案資料夾裡的 SQLite 檔（`fap:` 專案，需要 OPFS；不支援時才退回舊的記憶體索引）。實測（OPFS 當作 FAP）：6000 個檔案／78,000 個定義，建庫約 40 秒、頁面 JS 記憶體持平約 20MB，精確查詢約 10～100ms，repo_ask 約 0.3 秒。尚未用真實的 showDirectoryPicker 資料夾與 7 萬～50 萬檔的規模實測。
- 備註（notes）沒有搬進獨立的 `notes.sqlite3`：仍在地圖裡（小），問答時合併進問題用的小型資料庫。
- 沒有增量索引（SQLite 模式建索引中途停止或失敗，下次從頭分析）。
- 沒有 `persistentStorage` 的 `update`／`pin`（`client-file/<id>` 當資料庫來源）。

## 7. 驗證

- 純函式測試（`scripts/run-core-tests.js`）：`sql_split`（14）、`browser_core`（9）、`fapfs_core`（15，含 wasi-sh 官方符合性套件）、`fsx-sync`（6）、`test_fa_sqlite.py`（11）。
- 整合測試（需要 Electron 內建的 Node：`ELECTRON_RUN_AS_NODE=1 <Electron 執行檔> scripts/<名稱>.itest.js`）：`sqlite-engine`（12）、`sqlite-shell`（16）、`sqlite-index`（4，含 2 萬檔／300 萬符號）、`sqlite-wasm`（9，需 `FA_SQLITE_WASM_DIR`）。
- 真實應用程式：終端機 sqlite3（選項、管線、重導向、沙盒檔案、REPL）、sqlitebrowser（3000 列資料表的分頁／過濾／排序／編輯／寫回／回滾／危險語句確認）、Python 橋接、`repo_sql`、專案索引（21,600 檔、約 1,000 萬符號）、終端機 `/mnt`；網頁版模式（關掉 `node:sqlite`）下終端機／sqlitebrowser／Python 橋接。
