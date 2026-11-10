# DESIGN.TODO.offline-training-studio — 離線訓練工作室（`/offline-training-studio`）

> 狀態：**設計，尚未實作**（2026-11-11）。交給其他 session 實作。§12 是對 `renderer/src/floating-assistant.js`（約 12.7 萬行）實際核對過的接口位置（行號會隨編輯漂移，以函式名為準）；§2–§11 內標「待核對」的是 §12 沒有涵蓋的部分。
> 相關：`DESIGN.lora-training.md`（LoRA 管線、ONNX 動態套用 §7／§10）、`DESIGN.offline-trainer.md`（符號式離線訓練器與 bundle）、`DESIGN.project-index.md`（aiDoc 檢視器、假伺服器、AI 佇列）、`DESIGN.colu.md`、`DESIGN.blockly-curriculum.md`、`DESIGN.matrix-fallback.md`、`DESIGN.uml-framework.md`、`DESIGN.knowledge-types.md`。

## 1. 目標

1. 一個 GUI：**`/offline-training-studio`**，網頁版與桌面版都能用，管理並執行「離線模型相關的訓練」。
2. 支援六種訓練：**CoLU、blockly-teach、matrix-algorithm、uml-design、離線訓練器（規則／FSM／工具）、LoRA**。
3. 終端使用者訓練出來的東西是**使用者自己的資產**：可存到 fap（使用者授權的資料夾）或記憶體（IndexedDB），可**暫停、匯出、帶到別處匯入後續訓**。
4. 資產可打包成**統一格式**，放進 repo 指定資料夾，經 repo 腳本執行後 commit 成**內建**。
5. app 內有類似 aiDoc 的介面：**線上 AI 以老師身分，依需求擴充訓練集**（資料集，不是直接改權重）。
6. LoRA 訓練盡量走 **CPU／WebGPU**；做不到的要誠實分層說明。

## 2. 資產模型（核心）：Training Asset

所有訓練的產物都收斂成同一種可攜資產 `fa-training-asset`（版本號、可遷移）：

```
asset/
  manifest.json   {format:'fa-training-asset', version, kind, name, created, parent?, base?, compat:{...}, counts:{...}, eval:{...}, sha256:{file→hash}, owner:'user'|'builtin'}
  data/           資料集（jsonl／各領域原生格式）
  state/          可續訓的狀態（檢查點、optimizer、步數、亂數種子、資料游標）
  weights/        產物（LoRA 分片 20MB、規則包、課程包…）
  log.jsonl       訓練紀錄（可回放進度、暫停點）
```

`kind` ∈ `colu｜blockly｜matrix｜uml｜trainer｜lora`。各 kind 的 `data/`、`weights/` 內容：

| kind | 資料集 | 產物 | 既有對應（待核對） |
|---|---|---|---|
| `trainer` | 成功案例、未解決紀錄 | 規則／pattern／FSM／JS 工具 | `_otBundleExport`／`_otBundleImport`、`fa-offline-trainer` v2 |
| `colu` | 採用／拒絕標註、體檢結果 | 排序模型（`rank_train.js`）、`coluProfile` | `feedback_core.js`、`rank_train.js` |
| `blockly` | 題目＋課（lesson）、領域包 | domain pack（algos／paradigms／skeletons／seeds） | `domain_*_core.js`、`deriveLesson`、`DESIGN.block-domains.md` |
| `matrix` | 輸入輸出範例 | 範式／模板（L0–L6 求解參數） | `DESIGN.matrix-fallback.md`（該層由另一位維護，只讀接口，不改其核心） |
| `uml` | 情境→設計（決策表、模板） | 詞彙表、決策表、模板樹 | `uml_core.js`、`design_core.js` |
| `lora` | `lora-train/schema.md` 統一 JSONL | `adapter_model.safetensors` 分片＋manifest | `lora-train/pack_adapter.js` |

`lora` 資產的 manifest 沿用 `lora-train` 現有格式（分片、sha256、基底、rank、`prompt_format_version`、`tool_catalog_sha256`、評量），載入前相容性檢查見 `DESIGN.lora-training.md` §10。

## 3. 儲存：fap、記憶體、可搬移

- **記憶體**＝IndexedDB（沿用現有 FileCache／repoMapCache 風格的 store；注意既有的 LRU 配額——大檔 adapter／檢查點要分塊存，單筆不要過大，見 `DESIGN.project-index.md` §15.5 的教訓）。
- **fap**＝使用者授權的資料夾：網頁版 `showDirectoryPicker` handle（持久化在 IndexedDB，`queryPermission` 靜默檢查，**需要手勢才能重新授權**，授權要在開始長任務前取得）；桌面版直接用絕對路徑。路徑慣例：`<fap>/.floating-assistant/training/<kind>/<name>/`（隱藏資料夾、自帶 `.gitignore`）。
- **兩處同步**：寫入同時寫記憶體（快取）與 fap（權威，若有授權）；沒授權就只在記憶體並在 UI 明說「瀏覽器資料被清掉會遺失」。
- **匯出／匯入**：單一檔 `.fatrain`（zip 容器，內容即 §2 的資產；LoRA 權重已分片所以也可直接當資料夾）。匯入時檢查 `format`／`version`／sha256／相容性，顯示摘要請使用者確認後才合併（沿用 bundle 匯入的確認慣例）。
- **暫停與搬移**：任何時候可「暫停」→ 寫出 `state/`（步數、optimizer、資料游標、隨機種子、目前資料雜湊）；「匯出訓練包」帶走；到別台（含桌面版 `lora-train/train.sh`）匯入後從 `state/` 續訓。**續訓只在 `base`／rank／`prompt_format_version`／資料雜湊相容時允許**，否則要求以新資產 fork（`parent` 欄位記來源）。

## 4. GUI：`/offline-training-studio`

做法：**複製 aiDoc 檢視器的架構**（浮動視窗＋沙盒 iframe＋`mock.local` 假伺服器＋`postMessage`／WebSocket 推播，`DESIGN.project-index.md` §8），不另起一套。斜線指令註冊、自動完成、設定頁入口比照 `/aidoc`（待核對註冊表位置）。

版面：**左右兩個分頁區（pane），各自有分頁列**，不再是固定三欄。
- **左分頁區**（預設：資產／資料集／評量）：分頁＝`資產清單`（依 kind 分組；內建／我的／匯入；儲存位置圖示：記憶體／fap）、`資料集`（瀏覽與編輯）、`評量`（每組都列、退步標紅、上線門檻）。
- **右分頁區**（預設：訓練／老師／紀錄）：分頁＝`訓練`（開始／暫停／續訓／停止、進度與 loss 曲線、匯出／打包）、`老師`（§6）、`紀錄`。
- **分頁可搬移**：任何分頁都可以拖到另一側的分頁列（或用右鍵「移到左／右」），兩側都至少保留一個分頁；分頁可關閉、可從「+」選單重新開啟；偏好（各分頁位置、順序、啟用中的分頁）記在主程式 `localStorage`（比照 aiDoc 的 `fa_aidoc_view_prefs_v1`，iframe 沒有儲存空間，所以由主程式存、經 `GET／POST /api/prefs` 讀寫），並有「還原版面」按鈕。
- **可調整大小（resize）**：左右兩區之間有分隔線，拖曳調寬（有上下限，雙擊還原預設）；整個視窗也可拖曳邊角縮放（沿用 `FaWin.decorate`）。窄視窗（小於 640px）自動改成上下堆疊，分隔線改成上下拖曳。
- **最大化（max）**：每個分頁區標題列有「最大化／還原」按鈕（雙擊分頁列空白處同效）：把該區撐滿整個視窗、另一區暫時收起（不關閉、狀態保留），再按還原；整個視窗另有自己的最大化／還原（沿用 aiDoc 的雙擊標題列行為，最大化時不記住全螢幕尺寸）。可再提供「隱藏另一區」切換，與最大化的差別是保留分頁列。
- 長時間訓練時視窗可關閉：桌面版訓練在背景子行程，重新開啟 Studio 會接回進度（網頁版訓練限於符號式五類，關閉分頁即暫停並寫出 `state/`）。

路由（假伺服器，示意）：`GET /api/assets｜/asset｜/dataset｜/runs`、`POST /api/train {kind,name,opts}`、`POST /api/pause｜resume｜stop`、`POST /api/export｜import`、`POST /api/teach {goal,kind}`、`WS /ws`（`run_progress`、`teach_progress`、`asset_changed`）。

## 5. 訓練後端（分層，誠實）

| kind | 計算性質 | 後端 | 備註 |
|---|---|---|---|
| `trainer`／`colu`／`uml`／`blockly`／`matrix` | 符號式或小型統計（邏輯回歸、規則升格、窮舉＋沙盒驗證） | **純 JS，主執行緒或 Worker，CPU** | 現有程式本來就在跑；Studio 只是包成可暫停（以資料游標＋已完成項目為檢查點）的工作。沙盒驗證要走判題器（桌面版 `judge-runner.js`；網頁版需確認可用的沙盒——**網頁版是否能跑 python／gcc 判題待核對**，不能的話 blockly／matrix 的「驗證訓練」在網頁版降級為只做資料集管理與匯出，訓練交給桌面版） |
| `lora` | 梯度訓練，0.6B | 見下表 | 唯一需要 GPU 級運算的 |

**LoRA 訓練後端（由可靠到不確定）**：

1. **桌面版＋Python 子行程（CPU）**：呼叫 `lora-train/train.py`（已完成、已實測：此機器 CPU 約 60 token/s）。需要使用者機器有 Python；沒有就提示安裝或改用匯出訓練包到別台。Studio 負責資料集、參數、啟動、讀進度、收產物（`pack_adapter.js` 的格式）。**這是第一階段要做的**。
2. **匯出訓練包到別台**：`lora-train/portable/` 打包（資料＋腳本），別台跑完把 `.fatrain` 匯回。零新技術風險，網頁版也能用（網頁版只當資料集與老師工具）。
3. **瀏覽器內 WebGPU／CPU（WASM）訓練——目前沒有現成可用方案，列為研究項**：
   - `onnxruntime-web` 的訓練支援與我們用的推論套件不同、需要離線產生訓練圖（ORT training artifacts），且 WebGPU 後端的訓練算子覆蓋不足；**這個 repo 目前沒有任何訓練圖或 training build（待核對確認）**。
   - 較可行的路線：**只訓練 LoRA 的 A／B（約 10M 參數），基底凍結量化**。前向沿用我們已驗證的「基底 q8＋LoRA 分支」ONNX（`make_lora_onnx.py`，A/B 為外部資料）；反向需要自己實作：對 196 個目標線性層，已知 `y = y_base + (x·A)·B`，梯度 `dB = (xA)ᵀ·dy`、`dA = xᵀ·(dy·Bᵀ)`，需要各層的輸入 `x` 與輸出梯度 `dy`——`dy` 要穿過整個 transformer 反向傳播（attention、RMSNorm、MLP、量化矩陣乘的 straight-through），即**等於要寫一個 0.6B 的 WebGPU 反向傳播引擎**。工作量大、數值風險高，**不建議列入第一階段**。
   - 折衷：先做小規模 **WebGPU 微調 head／偏置式 adapter（只訓練最後幾層或 logit 偏置）** 的可行性實驗，量測 token/s 與記憶體後再決定；網頁版 16GB 以下機器上 0.6B fp16 全模型已佔 1.2GB，加上激活與 optimizer 要實測。
   - 結論寫進 UI：網頁版 LoRA 顯示「目前請用桌面版訓練或匯入別台訓練好的 adapter」，不假裝能訓練。
4. **速度現實（已實測，CPU）**：約 60 token/s；4141 筆資料約 200 萬 token，一個 epoch 約 9–10 小時。因此 Studio 必須有：時間估計、暫停／續訓、子集試跑（先 1000 筆驗證）、不需要常開視窗（桌面版用背景子行程）。

## 6. 老師介面（線上 AI 擴充訓練集）——仿 aiDoc

目標：使用者（或線上 AI 自己）說「我要強化 X」，線上 AI 以**老師**身分產生**資料集擴充**（不是直接改模型），產物進資產的 `data/`，由使用者審核後才進訓練。

- 入口：Studio 右側「老師」面板＋`/offline-training-studio teach <目標>`；沿用 aiDoc 的 AI 佇列（一次一個、`_runSubAgentTask`、工具白名單）與 `/offline-trainer-by-ai` 的老師迴圈（先讓離線自己試，做不到才由老師教，老師教完離線要能自己重做並通過驗證，否則回滾）。
- 老師可用的工具（白名單，示意）：`studio_dataset_list／read／add／remove`、`studio_verify`（用程式驗證候選資料：判題器、`chooseTool` 解析、schema 檢查）、`studio_eval`（跑評量看缺口）、`studio_gap_report`（目前分組的弱項）。
- **鐵則（沿用 `DESIGN.lora-training.md`）**：
  1. 老師產生的每筆資料都要**經程式驗證**才收（`verified_by`），不收「模型說對」的答案；
  2. 預設 `split:"train"`；任何標為留出的來源不得進訓練；老師**不能**看或使用 heldout 題的答案；
  3. 每筆記 `author:'teacher'`、來源、時間、與（若有）驗證證據；使用者可逐筆拒絕；
  4. 不自動開始訓練——產生資料與開始訓練是兩個動作；
  5. 單次擴充有上限（筆數、token），避免一次灌爆。
- 缺口驅動：老師先呼叫 `studio_gap_report`（例如 `colu/ext` 弱、`rtool/missing` 弱），再針對弱項補資料，補完跑 `studio_eval` 看有沒有改善，沒改善就回報而不是繼續灌資料。
- 隱私：送給線上 AI 的只有資料集條目與評量摘要，不送使用者檔案內容；在送出前顯示會送什麼（沿用既有的確認慣例）。

## 7. 內建化：從 repo 執行並 commit 成為內建

兩條對稱路徑，格式相同（§2 的資產）：

- **使用者端**：Studio 訓練 → 資產存 fap／記憶體 → 屬於使用者，`owner:'user'`，可匯出、可刪，不影響內建。載入優先序：使用者啟用的 > 內建；使用者可停用內建。
- **repo 端（內建）**：資產放 `desktop-app/builtin-training/<kind>/<name>/`（指定資料夾，分片≤20MB，單檔上限遵守 GitHub 100MB），由 repo 腳本處理：
  - `scripts/training-studio.js`（待實作）：`train <kind>`（直接呼叫對應訓練：lora 走 `lora-train/train.sh`，其餘走各自核心）、`pack <kind> <name>`（打成 §2 格式放進 `builtin-training/`）、`embed`（把需要隨 app 載入的小資產——規則包、課程包、領域包——嵌入 `floating-assistant.js`，沿用既有 embed 腳本與「只含自己的區塊」標記慣例，待核對 `scripts/embed-*.js`）、`verify`（核對 sha256／相容性／測試）。
  - 大資產（LoRA 權重）**不嵌入**，走 GitHub `lora-adapters` branch（分片＋manifest），App 依 `DESIGN.lora-training.md` §10 的「相容就抓、設定可開關、預設啟用」載入。
  - commit 流程：`node scripts/training-studio.js pack …` → 檢查 `git status` 只有預期檔案 → commit。改到 `floating-assistant.js` 時走 `publish-live-update-patch`。
- **使用者資產升級為內建**：Studio 匯出 `.fatrain` → 放到 repo `builtin-training/<kind>/` → 同一支腳本 `import-asset` 驗證後納入（驗證不過不收；`owner` 改 `builtin`、保留 `parent` 與作者）。

## 8. 六種訓練的 Studio 內行為摘要

| kind | 資料集動作 | 訓練動作 | 評量 |
|---|---|---|---|
| `trainer` | 看成功案例／未解決紀錄、手動升格規則 | 蒸餾（≥3 次重複才升格）、`/teacher-loop`（含回歸與回滾） | 離線自己做對比例、回歸 |
| `colu` | 採用／拒絕標註 | 重訓排序模型；體檢 | 排序命中率、`coluProfile` |
| `blockly` | 新增題目／領域包、老師補課 | 窮舉＋沙盒驗證收成課 | 乾淨 holdout 通過率（holdout 不可教） |
| `matrix` | 輸入輸出範例 | 範式擬合（L0–L3 有真演算法，L4–L6 只有窮舉） | held-out；明示 L4–L6 不保證 |
| `uml` | 情境與設計對 | 決策表／詞彙表補強 | 結構驗證通過率 |
| `lora` | 見 `lora-train/schema.md`，老師擴充 | §5 後端 | `eval_run.py` 分組＋上線門檻 |

## 9. 版本、遷移、相容

- 所有資產與 Studio 偏好有版本號；讀到舊版／缺欄位要遷移並以舊資料升級測試驗證（沿用 `DESIGN.knowledge-types.md` 的版本化慣例）。
- LoRA 相容性欄位：`base`、`rank`、`prompt_format_version`、`tool_catalog_sha256`；提示格式變動一定重訓（見 `DESIGN.lora-training.md` §10）。
- 設定：`offlineLora`（預設 on）、Studio 的儲存位置偏好、老師每次擴充上限。

## 10. 分階段實作建議（每步可獨立上線、可回退）

1. **資產格式＋匯出入＋儲存層**（記憶體／fap）；先接 `trainer` 現有 bundle，確認 `.fatrain` 可往返。
2. **Studio 視窗**（clone aiDoc 檢視器）＋資產清單與資料集瀏覽，先唯讀。
3. **符號式五類訓練的包裝**（trainer／colu／uml／blockly／matrix）：可暫停、進度、評量。
4. **LoRA 桌面版後端**（子行程呼叫 `lora-train/train.py`）＋暫停／匯出／續訓；`.fatrain` 與 `lora-train` 打包格式對齊。
5. **老師面板**（白名單工具、驗證鐵則、缺口驅動）。
6. **repo 內建化腳本**（`scripts/training-studio.js`、`builtin-training/`、embed、`lora-adapters` 抓取與設定開關）。
7. **研究項**：瀏覽器 WebGPU LoRA 訓練可行性實驗（§5.3），**沒有實測數字前不承諾**。

## 11. 待核對／未驗證

- 斜線指令註冊表、aiDoc 檢視器可複用的函式名、fap 讀寫函式、embed 腳本清單與標記規則——**都要在動工前對原始碼逐一確認**。
- 網頁版是否有可用的程式沙盒（blockly／matrix 的驗證依賴 python／gcc 判題器）。
- onnxruntime-web 訓練能力、WebGPU 反向傳播可行性、網頁版記憶體上限——全部未量測。
- 桌面版沒有 Python 的使用者怎麼辦（內建便攜 Python？下載？只匯出訓練包？）——產品決策。
- 老師送資料給線上 AI 的隱私與費用提示。

## 12. 已核對的接口位置（`renderer/src/floating-assistant.js`，行號僅供定位）

- **斜線指令**：`this.slashCommands = new Map()`（:70580）；`register_slash_command(cmd, hint, desc, handler, argChoices)`（:113888）；`/aidoc` 註冊在 :70764（handler `run._aidocCommand`；挑資料夾需要使用者手勢，之前不可 `await`）；`/offline-trainer-by-ai` :70808、別名 `/teacher-loop` :70818（別名＝`slashCommands.set(alias, Object.assign({}, e, {cmd: alias, desc}))`，`_menuHidden:true` 可從選單隱藏）。自動完成選單 `_wireSlashCommandMenu`（:66821）、分派 `slashCommands.get(tok)`（:67499 等）。→ `/offline-training-studio` 新增一筆註冊，比照 `/aidoc`。
- **設定頁**：`_riRegisterPane`（:83997，呼叫處 :125402）；離線訓練器的是 `_otRegisterPane`。
- **檢視器視窗**：`_wgBuilders()`（:114997）新增 widget kind（例如 `studioview`）；仿 `_wgBuildAidoc`（:115021）：卡片＋標題列＋沙盒 iframe（`sandbox="allow-scripts allow-forms allow-modals"`，無 same-origin）、注入 HTML 與 `__faMockShim`（:60089，host `mock.local`、`block:true`）、`FaWin.decorate(...)`、iframe `postMessage`→`srv.handle(d, reply)`。假伺服器仿 `_aidocServer(key)`（:82737），有 `srv.push`、`srv.hooks`、一次一個的 AI 佇列 `pump`。偏好存主程式 `localStorage`（aiDoc 用 `fa_aidoc_view_prefs_v1`，iframe 自己沒有儲存空間）。
- **老師的 AI 工具白名單**：`_runSubAgentTask(prompt, maxRounds, {systemPrompt, allowedToolNames})`（:121546）；白名單是對 `Object.keys(me.tools)` 的 regex（:82752、:82769）；老師迴圈用 `_otTeacherAllowedTools()`＋`FA_OT_TEACHER_PROTOCOL`（:82084）。→ `studio_*` 工具要註冊成工具，再加進白名單。
- **fap**：參照格式 `fap:<名稱或id>[/路徑]`；解析 `_resolveFapFileParent(ref, {mode, create})`；`_fapListFiles`（:78984）、`_fapReadFile`（:79037，**只讀文字，二進位被拒**）、`_fapWriteFile`（:79055，文字）、`_writeFapFileBytes(ref, bytes, mime)`（:101308，二進位）；AI 工具 `fap_*`（:74019）；handle 持久化在 IndexedDB `fa-file-handles`（:51676）；桌面版絕對路徑走 `window.desktopAPI.rawfs`，使用者資料夾 `_faUserDataDir()`。→ LoRA 分片與檢查點要用 `_writeFapFileBytes`／`rawfs`，不能用文字版讀寫。
- **記憶體儲存**：`FileCache`（:482，IndexedDB blob、LRU，預設 256 MB，設定 `fileCacheLimitMB` 1–2048，:71757）、`KVStore`（:1210，小 JSON、無淘汰）、`repoMapCache`（512 MB）。→ adapter（約 40 MB）與檢查點（optimizer 約 2×）會碰到 LRU 淘汰：訓練資產**不可只放 FileCache**，要放 `KVStore`／專屬 store 或 fap，並在 UI 提示。
- **既有資產**：離線訓練器 bundle `_otBundleExport`（:81820）／`_otBundleInspect`（:81844）／`_otBundleImport`（:81880），格式 `{format:'fa-offline-trainer', version:2, payload:{domains, solutions, synonyms, turns?}, checksum}`；blockly 課 `deriveLesson`（:16423）、執行期課存 `localStorage['fa_py_runtime_lessons']`（`_pyLessonsLoad／Save` :115386）、匯出 `_pyLessonsExport`→`py_lessons_builtin.js`（由 `scripts/teach-builtin-lessons.js` 產生）；領域包 `uml/domain_*_core.js` 經 `FaDomains.register`（`uml/domain_registry_core.js`）；CoLU 回饋 `catalog/feedback_core.js`（上限 1500 筆）＋`catalog/rank_train.js`，`coluProfile` 在模型預設（:62597）；matrix 層 `catalog/matrix_core.js`、`algo/matrix_*_core.js`；UML 的模板／決策表**寫在程式裡，不是使用者可訓練的資料**（→ `uml` 這個 kind 在 Studio 內實際上只有「資料集（情境→設計對）＋評量」，沒有可儲存的權重，要在 UI 明說）。
- **內建化（embed）**：`scripts/embed-code-ui.js` 把 `/* X-BEGIN */…/* X-END */` 標記之間的內容換成包成 IIFE 的核心模組（例：`PLAN`、`UML`、`DOMAINLZ`）；新資產要加標記＋加進該腳本的 embed 清單。blockly 內建課走 `scripts/teach-builtin-lessons.js`。
- **未找到**（實作時要自己確認或新增）：CoLU 回饋紀錄的執行期儲存位置、matrix 層的使用者資料位置、knowledge-types pack 的執行期位置與格式。
- **運算**：onnxruntime-web 1.22.0（:8989）；`vlm/vlm_core.js` 有 WebGPU→WASM 降級與 `shader-f16` 檢查（:80–85）；transformers.js 走 CDN；原生是 `nr-engine.js`＋onnxruntime-node（CPU，子行程 `nr-child.js`／`nr-host.js`）。**整個 repo 沒有任何 ORT 訓練圖或 `TrainingSession`**（`lora-train/ref` 之外）。桌面版 `main-ext.js:361` 會探測 node／npm／npx／python，Python 橋接（`FA_PYBRIDGE_FILES`）跑技能腳本，**沒有內建 Python 執行環境**。
- **發佈**：改 `floating-assistant.js`／`bootstrap.js`／`index.html` 只能經 `scripts/publish.sh`（建置、commit、組 `desktop-app-patch` 分支、核對 checksum；`PATCH_VERSION` 單調遞增；不手組 patch；凍結的 `live-patch-compat` 不動；大檔分片）。
