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

### 3.1 跨後端可攜的檢查點格式（暫停→傳到另一台續訓）

檢查點放在 `state/`，**與後端無關**：

```
state/
  ckpt.json     {format:'fa-ckpt', version:1, step, epoch, dtype:'float32',
                 cursor:{shard, offset, order_seed, consumed_tokens}, rng:{seed, algo:'pcg32', state},
                 optimizer:{kind:'adamw', lr, betas, eps, wd, step_count, schedule:{type, warmup, total}},
                 data_sha256, compat:{base, base_sha256, rank, alpha, target_modules[], prompt_format_version, tool_catalog_sha256},
                 produced_by:{backend, device_fingerprint, engine_version, precision}, loss_tail:[最近N步loss], sha256:{檔→雜湊}}
  lora_A.f32    規範化 float32（依層名排序，檔頭有 shape 表）
  lora_B.f32
  opt_m.f32     優化器一階動量（同順序）
  opt_v.f32     優化器二階動量
```

- **一律以 float32 規範化存放**；fp16 後端在 `saveCheckpoint` 時由後端持有的 fp32 主權重輸出（後端若只有 fp16 權重，就要在 `produced_by.precision` 標明並接受精度損失，續訓比對門檻改用較寬的一檔）。
- **資料游標與亂數種子**：資料順序由 `order_seed` 決定的洗牌＋`cursor` 重現，亂數用與後端無關的 PCG32（不用各後端自己的亂數，否則續訓後的 dropout／洗牌不同）。
- **相容性檢查欄位**（不符一律拒絕續訓，提示以新資產 fork，`parent` 記來源）：`base_sha256`、`rank`、`alpha`、`target_modules`、`prompt_format_version`、`tool_catalog_sha256`、`data_sha256`、`format`／`version`（舊版先遷移）、優化器種類。**不看**後端與裝置：這兩者允許不同，只記錄。
- **跨後端續訓的數值差異**：不同後端的浮點加總順序、融合算子、fp16／fp32 不同，所以**不保證逐位元相同**。處理方式：(1) 續訓開始時先對檢查點存的 `eval_batch`（固定 4 筆）在新後端 `evalLoss`，與 `ckpt.json` 記下的 loss 比對，相對差 ≤ 2%（fp16 後端 ≤ 5%）才繼續，否則停下並提示「此後端與原後端數值差異過大」；(2) 續訓後前 N=20 步的 loss 與 `ckpt.json` 的 `loss_tail` 趨勢比對（只作警示，不作拒絕條件，因為資料批次不同）；若原後端仍可用，另用同批資料在兩個後端各跑 N 步互相對照（相對差在上述門檻內）；(3) 紀錄寫明「由 A 後端暫停、B 後端續訓」與比對結果；(4) 同後端續訓的門檻較嚴（§5.7 階段 1：≤ 1e-5）。
- **傳輸**：檢查點與資產用 `.fatrain`（zip）；大張量分片（沿用 20MB 分片與 sha256）。傳遞方式：(a) 匯出 `.fatrain` 檔，自行搬移；(b) 存到 fap 資料夾（網路磁碟或雲端同步資料夾）後在另一台打開同一資料夾；(c) 區網／遠端傳輸（桌面版暫時開啟的點對點傳送，需配對碼，**只在使用者按下「傳送」後啟動**；階段 3 後的後續項目，第一版只做 (a)(b)）。網頁版與桌面版互相匯入：格式相同，網頁版匯入後只能續訓它有可用後端的部分（目前無，故只能存放與轉交給桌面版）。

## 4. GUI：`/offline-training-studio`

做法：**複製 aiDoc 檢視器的架構**（浮動視窗＋沙盒 iframe＋`mock.local` 假伺服器＋`postMessage`／WebSocket 推播，`DESIGN.project-index.md` §8），不另起一套。斜線指令註冊、自動完成、設定頁入口比照 `/aidoc`（待核對註冊表位置）。

版面：**左右兩個分頁區（pane），各自有分頁列**，不再是固定三欄。
- **左分頁區**（預設：資產／資料集／評量）：分頁＝`資產清單`（依 kind 分組；內建／我的／匯入；儲存位置圖示：記憶體／fap）、`資料集`（瀏覽與編輯）、`評量`（每組都列、退步標紅、上線門檻）。
- **右分頁區**（預設：訓練／老師／紀錄）：分頁＝`訓練`（開始／暫停／續訓／停止、進度與 loss 曲線、匯出／打包）、`老師`（§6）、`紀錄`。
- **分頁可搬移**：任何分頁都可以拖到另一側的分頁列（或用右鍵「移到左／右」），兩側都至少保留一個分頁；分頁可關閉、可從「+」選單重新開啟；偏好（各分頁位置、順序、啟用中的分頁）記在主程式 `localStorage`（比照 aiDoc 的 `fa_aidoc_view_prefs_v1`，iframe 沒有儲存空間，所以由主程式存、經 `GET／POST /api/prefs` 讀寫），並有「還原版面」按鈕。
- **可調整大小（resize）**：左右兩區之間有分隔線，拖曳調寬（有上下限，雙擊還原預設）；整個視窗也可拖曳邊角縮放（沿用 `FaWin.decorate`）。窄視窗（小於 640px）自動改成上下堆疊，分隔線改成上下拖曳。
- **最大化（max）**：每個分頁區標題列有「最大化／還原」按鈕（雙擊分頁列空白處同效）：把該區撐滿整個視窗、另一區暫時收起（不關閉、狀態保留），再按還原；整個視窗另有自己的最大化／還原（沿用 aiDoc 的雙擊標題列行為，最大化時不記住全螢幕尺寸）。可再提供「隱藏另一區」切換，與最大化的差別是保留分頁列。
- 長時間訓練時視窗可關閉：桌面版訓練在背景子行程，重新開啟 Studio 會接回進度（網頁版訓練限於符號式五類，關閉分頁即暫停並寫出 `state/`）。

### 4.1 訓練分頁的「運算後端」

- **下拉選單**（只對 `lora` 啟用）：`自動（建議）｜純處理器｜WebGPU｜DirectML｜Vulkan`。各項由 `Backend.probe()` 決定可用性；**不可用的灰掉，旁邊顯示具體原因**（例如「找不到 Python」「此瀏覽器沒有 WebGPU」「DirectML 在 qwen3-0.6b 已知失敗」「Vulkan 後端尚未實作」）。網頁版預設只有「WebGPU（研究中）」與「匯出訓練包」可見。其他五種 kind 顯示「只需處理器」。
- **「跑基準測試」按鈕**：對所有可用後端依序跑 §5.8 的基準測試（一次一個）。表格逐列顯示：後端、實測 token/秒、峰值記憶體、步時間 p50／p95、數值一致性（通過／失敗項目）、測試時間、硬體指紋。可中斷（按鈕變「停止」，3 秒內停）。
- **基準測試守則（遵守「電腦要保持可用」）**：小（30 步、16 筆）；桌面版在背景子行程執行、視窗隱藏、命令走排隊、最多用 N−1 核（至少留 1 核）；不下載任何檔案、不掃整台機器；WebGPU 測試放 Worker、單次計算分段讓出事件迴圈；測試中偵測到使用者操作變卡頓（事件迴圈延遲超過門檻）自動降低強度或暫停。
- **「自動」的選擇規則**：
  1. 候選＝`probe` 可用且基準測試「數值一致性通過」的後端；
  2. 從候選中選實測 token/秒最高者；同速（差 <10%）偏好較成熟的（`cpu-py` > `vulkan` > `directml` > `webgpu`）；
  3. 基準測試結果**快取**（含硬體指紋：CPU 型號／核數、顯示卡名稱與驅動版本、WebGPU 的 adapter info、後端引擎版本、模型 sha256），**指紋任一項改變即失效並提示重測**；沒有快取時，第一次按「開始訓練」前先自動跑一次小型基準測試（可略過，略過則用 `cpu-py`）；
  4. **失敗自動降級**：訓練中後端失敗（裝置遺失、記憶體不足、NaN）→ 存檢查點 → 依序降到下一個候選 → 續訓，並在 `log.jsonl` 與 UI 寫明「由 X 後端失敗降級到 Y，原因：…，降級時 step=…」；降級續訓走 §3.1 的跨後端比對；
  5. **使用者可釘選**後端：釘選後不自動換，失敗時停下並詢問而不是悄悄降級。

路由（假伺服器，示意）：`GET /api/assets｜/asset｜/dataset｜/runs`、`POST /api/train {kind,name,opts}`、`POST /api/pause｜resume｜stop`、`POST /api/export｜import`、`POST /api/teach {goal,kind}`、`WS /ws`（`run_progress`、`teach_progress`、`asset_changed`）。

## 5. 運算後端與訓練核心（2026-11-11 重寫：後端可選、可自動配對、可跨後端續訓）

### 5.1 原則

- **訓練核心與運算後端分離**：訓練核心（資料游標、損失、優化器排程、檢查點、評量）只跟「後端介面」（§5.3）講話，不知道底下是處理器還是顯示卡。
- **誠實**：每個後端都標「現在做得到什麼、做不到什麼、阻礙是什麼、解除阻礙的條件」。做不到就寫做不到，**不寫成「刻意不做」**。
- 符號式五類（`trainer`／`colu`／`uml`／`blockly`／`matrix`）本來就是純 JS 的處理器計算，**只宣告 `cpu-js` 一個後端**；沙盒驗證要走判題器（桌面版 `judge-runner.js`；網頁版是否有可用沙盒待核對，不能的話網頁版這幾類只做資料集管理與匯出、訓練交給桌面版）。後端選單只對 `lora` 有意義，其他 kind 在 UI 顯示「只需處理器」並灰掉選單。

### 5.2 後端清單與誠實狀態

「現況」欄只寫已查證的；未查證的標「未查證」，查證方法見 §11。

| 後端代號 | 推論 | 訓練（LoRA 反向傳播） | 依賴與體積 | 跨平台 | 風險 | 第一版 |
|---|---|---|---|---|---|---|
| `cpu-py`：桌面版 Python 子行程（`lora-train/train.py`，PyTorch CPU） | 可 | **已可**：本機實測約 60 token/s（Core Ultra 7 155U，見 `DESIGN.lora-training.md` §1） | 使用者機器要有 Python＋`lora-train/requirements.txt`（torch 約數百 MB～GB 級，未逐項量測）；桌面版**沒有內建 Python**（`main-ext.js:361` 只探測） | Windows／Linux／macOS 皆可（只實測 Windows） | 無 Python 的使用者要安裝或改匯出訓練包 | **做**（階段 1） |
| `cpu-js`：純 JS／WASM（Worker） | 可（onnxruntime-web WASM） | **做不到（目前）**：repo 沒有任何 ORT 訓練圖或 `TrainingSession`，LoRA 反向要自己寫 0.6B 的反向傳播；符號式五類是例外（本來就是它） | 無額外依賴 | 全平台 | 速度遠低於 `cpu-py`（沒有最佳化的矩陣核心） | LoRA：**不做**；阻礙＝沒有反向引擎；解除條件＝§5.6 的 WebGPU 反向引擎做出來後，同一套算子可降級成 WASM 版；符號式：**做** |
| `webgpu`：瀏覽器 WebGPU，自寫 WGSL 計算著色器（網頁版與桌面版 Electron 渲染行程都能用） | 可（已用 onnxruntime-web WebGPU，`vlm_core` 有降級，`shader-f16` 檢查） | **尚無現成方案**：onnxruntime-web 推論套件不含訓練；ORT 的 on-device training 是否有 WebGPU 後端未查證（官方文件的搜尋結果未提及）。自寫路線＝只訓練 LoRA 的 A／B（約 10M 參數），基底凍結；需要自己寫各層前向與反向（RMSNorm、attention、MLP、q8 反量化矩陣乘、RoPE、softmax／交叉熵）。**可行性＝理論上可行，工程量大、數值風險高，沒有實測數字** | 零安裝，但每台顯示卡的 WGSL 行為、緩衝區上限（`maxStorageBufferBindingSize` 預設 128MB，0.6B 權重要分塊）、記憶體上限都要實測；瀏覽器分頁會被回收 | 瀏覽器（Chrome／Edge 預設有；Firefox／Safari 版本不一，未查證）；Electron 繼承 Chromium | 高：數值與反向的正確性（要與 `cpu-py` 對拍）、裝置遺失（device lost）要能從檢查點續跑 | **第一版不做完整 LoRA**；階段 4 只做可行性實驗（單層 LoRA 梯度對拍，再擴展），有數字才升格 |
| `directml`：桌面版 Windows DirectML | 可，但 **qwen3-0.6b 已知失敗**：`DESIGN.TODO.native-runner.md:321,416`——onnxruntime-node 1.22.0 與 1.31.1 都在 `SkipSimplifiedLayerNormalization` 節點 E_INVALIDARG | **做不到（目前）**：onnxruntime 的 DirectML 執行提供者是推論用（官方文件：accelerates inference；開發轉維護模式，新功能移往 WinML——搜尋摘要，2026-11-11，見 §11 來源）；PyTorch 路線的 `torch-directml` 最新輪子約 2024-06（0.2.2.dev240614）、釘在 PyTorch 2.2、專案維護模式，**未驗證能否跑 LoRA 反向與 Qwen3 的全部算子**；`nr-engine.js` 的 onnxruntime-node 是 1.22.0，Windows 套件內含 `DirectML.dll`（`DESIGN.TODO.native-runner.md:120` 為 1.31.1 的觀察；1.22.0 是否含未逐檔核對）。**本 repo 沒有 `onnxruntime-node` 安裝**（`package.json` 無此依賴、`node_modules` 無此資料夾；它在使用者機器的執行包 `userData/native-runtime/` 內，按需下載） | `torch-directml` 約數百 MB（未量測）＋Python；DirectML.dll 為 ORT 套件內建 | 僅 Windows 10/11；任何 DX12 顯示卡（含 Intel 內顯） | 高：算子覆蓋、與 CPU 數值差、官方走向 WinML | **第一版不做**；阻礙＝沒有已驗證能跑 LoRA 反向的路徑；解除條件＝在隔離資料夾實測 `torch-directml` 能跑通 `train_lora.py` 前向／反向且與 CPU 數值對得上（見 §5.7 階段 5） |
| `vulkan`：桌面版 Vulkan | 可（llama.cpp 的 Vulkan 後端為成熟的推論後端；ncnn 的 Vulkan 為推論用，**ncnn 有無訓練未查證**） | **有一個可能路線但未驗證**：Tether QVAC 研究頁（2026-11-11 查）稱在 llama.cpp 加入含 Vulkan 後端的 LoRA 微調流程（初始化、訓練、檢查點、續訓、儲存、合併，凍結基底、只更新 LoRA 張量、輸出 GGUF adapter）；**未確認是否已進 llama.cpp 主線、是否支援 Qwen3、是否涵蓋所需算子（如 `OUT_PROD`、`OPT_STEP_ADAMW` 在 Vulkan 的實作）**。此外它的輸出是 GGUF adapter，要轉成我們的 safetensors／ONNX LoRA 槽格式（`make_lora_onnx.py`）才能互通，轉換未做 | 需預編譯的 llama.cpp 二進位（含 Vulkan）＋GGUF 基底（0.6B 約 0.4–0.7GB，視量化）；Vulkan 驅動由顯示卡廠商提供 | Windows／Linux（macOS 走 MoltenVK，未查證） | 高：上游功能成熟度、格式轉換、與 PyTorch 路徑的數值差 | **第一版不做**；阻礙＝上游訓練支援與 Qwen3 相容性未驗證、格式轉換未寫；解除條件＝讀上游原始碼與 PR 確認算子、在隔離資料夾跑通一次小訓練並與 `cpu-py` 對拍 |

補充：本機（Core Ultra 7 155U）**沒有 NVIDIA 顯示卡**；Intel 內顯與 NPU 都沒有已驗證的訓練路徑（`DESIGN.lora-training.md` §1）。因此「在本機上驗證 GPU 後端」只能用 Intel 內顯＋DirectML／Vulkan／WebGPU，結果不代表其他顯示卡。

### 5.3 後端抽象層（統一介面）

訓練核心依賴下列介面，後端各自實作；**每個後端都要通過同一套一致性測試（§5.8）才能在選單上點亮**：

```
Backend {
  id            // 'cpu-js' | 'cpu-py' | 'webgpu' | 'directml' | 'vulkan'
  probe()       -> {available, reason?, device:{name,vendor,memBytes?,fp16?,limits?}, fingerprint}
                // 不丟例外；reason 是給使用者看的具體原因（例如「沒有 python」「WebGPU 無 shader-f16」「DirectML 在此模型已知失敗」）
  benchmark(cfg,{signal}) -> {tokPerSec, peakMemBytes, stepMsP50, stepMsP95, numericCheck:{pass, maxRelErr, lossDelta}, samples}
                // 小、可中斷（signal.aborted 立刻停）；結果寫進快取（§4.1）
  init(assetState|null, cfg) -> handle     // 載入基底、建 LoRA A/B（或從檢查點載入）
  step(handle, batch) -> {loss, gradNorm}  // 一個優化步；內部可累積梯度
  evalLoss(handle, batch) -> {loss}        // 不更新，用於續訓比對
  saveCheckpoint(handle) -> CheckpointF32  // 一律交出規範化 float32（§3.1），不洩漏後端專有張量格式
  loadCheckpoint(handle, CheckpointF32)
  dispose(handle)
}
```

- **每個 kind 宣告支援後端**（寫在 manifest 與 Studio 的 kind 註冊表）：`trainer／colu／uml／blockly／matrix: ['cpu-js']`；`lora: ['cpu-py','webgpu','directml','vulkan']`（依各後端實際點亮狀態動態可用；`cpu-js` 對 `lora` 不宣告，原因見 §5.2）。
- 訓練核心是一個**狀態機**（待機→執行→暫停→完成／失敗），以「步」為單位在可中斷點寫檢查點；後端失敗（裝置遺失、記憶體不足、數值發散）時由核心處理降級（§4.1）。
- 不同後端間的差異只允許出現在 `step` 內部；資料游標、亂數種子、學習率排程、分組評量都在核心，與後端無關。

### 5.4 LoRA 訓練後端的現實排序（取代舊版四點）

1. **`cpu-py`**（桌面版＋Python 子行程）：唯一已實測的訓練路徑，**階段 1 就做**。Studio 負責資料集、參數、啟動、讀進度、收產物（`pack_adapter.js` 格式）。沒有 Python 的使用者：提示安裝，或走第 2 點。
2. **匯出訓練包到別台**：`lora-train/portable/`（資料＋腳本）；別台跑完把 `.fatrain` 匯回；網頁版當資料集與老師工具。與 §3.1 的「暫停後傳遞」是同一件事。
3. **`webgpu` 研究項**（§5.6），沒有實測數字前不承諾。
4. **`vulkan`／`directml`**：只在 §5.7 階段 5 做可行性驗證，阻礙與解除條件見 §5.2。
5. **速度現實（CPU 已實測）**：約 60 token/s；4141 筆資料約 200 萬 token，一個 epoch 約 9–10 小時。Studio 必須有時間估計、暫停／續訓、子集試跑（先 1000 筆）、不需常開視窗（桌面版背景子行程，且遵守「電腦要保持可用」：預設留一個核心、隱藏視窗、命令排隊）。

### 5.5 網頁版 LoRA 現況（維持誠實）

網頁版 LoRA 訓練目前**沒有可用後端**（`webgpu` 未實測、`cpu-js` 無反向引擎）。UI 顯示：「目前請用桌面版訓練，或匯入別台訓練好的 adapter／續訓包」，不假裝能訓練。`webgpu` 研究成功並通過 §5.8 後才解鎖。

### 5.6 WebGPU 反向引擎研究（階段 4 內容）

前向沿用已驗證的「基底 q8＋LoRA 分支」ONNX（`make_lora_onnx.py`，A／B 為外部資料）；反向要自己實作：對 196 個目標線性層，`y = y_base + (x·A)·B`，`dB = (xA)ᵀ·dy`、`dA = xᵀ·(dy·Bᵀ)`，而 `dy` 需穿過整個 transformer 反向（attention、RMSNorm、MLP、q8 straight-through）。研究分三步，每步都要有可量測的完成條件（§5.7）：(a) 單一線性層＋LoRA 的 WGSL 前向／反向與 CPU 浮點對拍；(b) 單一 transformer 區塊；(c) 全模型小批次一個優化步，量 token/秒與峰值記憶體。折衷備案：只訓練最後幾層或 logit 偏置式 adapter。網頁版 16GB 以下機器上 0.6B fp16 全模型已佔 1.2GB，加激活與優化器狀態必須實測。

### 5.7 分階段順序與完成條件

| 階段 | 內容 | 可驗證的完成條件 |
|---|---|---|
| 1 | 後端介面＋`cpu-py` 後端＋可暫停續訓＋規範化檢查點（同一後端） | 介面型別測試過；`cpu-py` 的 `probe` 在有／無 Python 兩種環境都回正確 `reason`；暫停→重開→續訓：續訓前 20 步 loss 與未暫停對照最大相對差 ≤ 1e-5（同後端同種子）；`.fatrain` 往返 sha256 一致 |
| 2 | 基準測試＋自動選擇＋GUI 下拉（§4.1） | 基準測試在 60 秒內可中斷完成，中斷後 3 秒內停止；不彈視窗、同時只用 N−1 核（以行程清單與視窗清單驗證）；自動選擇規則的單元測試（快取命中／指紋失效／降級／釘選）通過 |
| 3 | 跨機續訓（桌面版⇄桌面版、桌面版⇄網頁版匯入匯出） | 兩台（或兩個隔離環境）互傳 `.fatrain` 後相容性檢查欄位全過；續訓前 N=20 步 loss 與原機對照在 §3.1 容許誤差內；欄位不符時**拒絕並提示 fork**（有負向測試） |
| 4 | `webgpu` 研究（§5.6 a→b→c） | (a) 單層梯度與 CPU 最大相對誤差 ≤ 1e-3（fp32）；(b) 區塊梯度 ≤ 5e-3；(c) 全模型 20 步 loss 曲線與 `cpu-py` 同種子對拍，每步 loss 差 ≤ 2%，並記錄 token/秒與峰值記憶體。**任一步沒過就停在該步並回報阻礙，不往下硬做** |
| 5 | `vulkan`／`directml` 可行性（隔離資料夾、使用者同意後才下載任何東西） | 各自：能否跑通一個小 LoRA 優化步並與 `cpu-py` 對拍（同 §5.8 門檻）；不通過就在 §5.2 更新阻礙與解除條件，後端保持灰掉 |

**已實作（2026-11-11，階段 1–2 的核心邏輯；GUI 下拉與 Configure 視窗、`.fatrain` 往返屬其他階段）**：`renderer/src/studio/` 的 `backend_core.js`（介面、登錄表、kind 宣告）、`backend_cpu_js.js`（含迷你訓練器）、`backend_cpu_py.js`（子行程、暫停續訓、進度解析、safetensors 轉規範化檢查點）、`backend_planned.js`（webgpu／directml／vulkan 的具體阻礙）、`checkpoint_core.js`（§3.1）、`bench_core.js`（§5.8、快取、自動選擇、降級）、`studio_config_core.js`（Configure：訓練核心數，自動＝N−1）。測試 5 組已登錄 `scripts/run-core-tests.js`，皆為 `N passed, 0 failed`；暫停續訓 ≤1e-5 是**迷你訓練器模擬**，真實 `train_lora.py` 的續訓精度與整合測試因本機 Python 3.10.4 缺 torch／transformers／peft（且不下載）**尚未實測**；`cpu-py` 的規範化檢查點拿不到優化器動量（torch 專有 optimizer.pt），跨後端進 `cpu-py` 續訓需 `train_lora.py` 加 `--init_adapter`，尚未做。

### 5.8 基準測試與一致性測試設計

- **基準測試**（每個後端同一套，固定種子、固定 16 筆樣本、序列長度 256、批次 1、30 個優化步，先跑 3 步暖機不計）：輸出 token/秒（中位數）、步時間 p50／p95、峰值記憶體（子行程取工作集峰值；WebGPU 取已配置緩衝區總和）。整體上限 60 秒，超時即中止並標「太慢」。
- **數值一致性檢查**（以 `cpu-py` 為參考）：同一份初始 LoRA（A 以固定種子、B 為零）與同一批資料，比較 (1) 第 1 步的 loss（相對差 ≤ 1e-3）、(2) 第 1 步後 LoRA 梯度範數（相對差 ≤ 1e-2）、(3) 30 步後 loss 與參考相差 ≤ 3%、(4) 全程無 NaN／Inf。fp16 後端（`webgpu`、`directml`、`vulkan` 的 fp16 模式）門檻可放寬到 (3) ≤ 5%，但必須在結果裡標明用了 fp16。
- **通過門檻**：四項全過才標「通過」，後端才可被「自動」選用；未通過的後端仍可手動選，但 UI 顯示紅色警告與具體失敗項目。
- 門檻數值是**設計初值**，階段 2 以真實測量校準後再固定（不先假設）。

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
   - 已實作（2026-11-11）：`renderer/src/studio/` 的 `asset_core.js`、`fatrain_core.js`、`storage_core.js`、`trainer_adapter.js` 與各自的 `*.test.js`（共 142 項：53＋40＋30＋19，全過；已登錄 `scripts/run-core-tests.js`）。尚未接進 floating-assistant.js（把 fap／FileCache 外的專屬 IndexedDB store 與 `_writeFapFileBytes`／`rawfs` 注入 `createStorage`，屬步驟 2 之後）。
2. **Studio 視窗**（clone aiDoc 檢視器）＋資產清單與資料集瀏覽，先唯讀。
3. **符號式五類訓練的包裝**（只宣告 `cpu-js` 後端）：可暫停、進度、評量。
4. **後端介面＋`cpu-py` 後端＋規範化檢查點＋暫停續訓**（§5.7 階段 1），子行程呼叫 `lora-train/train.py`；`.fatrain` 與 `lora-train` 打包格式對齊。
5. **基準測試＋自動選擇＋GUI「運算後端」下拉**（§5.7 階段 2、§4.1）。
6. **跨機續訓**（§5.7 階段 3、§3.1）：桌面版⇄桌面版、桌面版⇄網頁版匯入匯出。
7. **老師面板**（白名單工具、驗證鐵則、缺口驅動）。
8. **repo 內建化腳本**（`scripts/training-studio.js`、`builtin-training/`、embed、`lora-adapters` 抓取與設定開關）。
9. **研究項**：`webgpu` 反向引擎（§5.6，§5.7 階段 4）、`vulkan`／`directml` 可行性（階段 5）。**沒有實測數字前不承諾**，沒過就保持灰掉並在 §5.2 更新阻礙。

## 11. 待核對／未驗證

**已核對（來源）**
- repo 無 `onnxruntime-node` 依賴與安裝：`package.json` 無、`node_modules` 無（2026-11-11 `ls`／`grep` 唯讀核對）；它是按需下載到 `userData/native-runtime/`，版本 1.22.0（`main-ext.js:746-799`、`nr-engine.js:1,16`）。
- DirectML 在 qwen3-0.6b 失敗：`DESIGN.TODO.native-runner.md:273,321,416`（1.22.0 與 1.31.1 皆在 `SkipSimplifiedLayerNormalization` E_INVALIDARG）。1.31.1 的 Windows 套件含 `DirectML.dll`（`DESIGN.TODO.native-runner.md:120`）。
- 本機無 NVIDIA；Intel 內顯／NPU 無訓練路徑：`DESIGN.lora-training.md` §1。
- CPU 約 60 token/s：`DESIGN.lora-training.md`、本文 §5.4。
- 搜尋所得（2026-11-11，WebSearch 摘要，**僅摘要未讀原文**）：DirectML 執行提供者為推論、進入維護模式，新功能移往 WinML（<https://onnxruntime.ai/docs/execution-providers/DirectML-ExecutionProvider>）；`torch-directml` 最新輪子約 2024-06、PyTorch 2.2、維護模式（<https://pypi.org/project/torch-directml>、<https://blogs.windows.com/windowsdeveloper/2024/05/24/build-the-next-wave-of-ai-on-windows-with-directml-support-for-pytorch-2-2/>）；ORT 1.17 發佈說明有「瀏覽器端 on-device training」與 WebGPU 執行提供者（<https://onnxruntime.ai/blogs/ort-1-17-release>）；Tether QVAC 稱 llama.cpp 加入含 Vulkan 的 LoRA 微調（<https://qvac.tether.io/?p=175>）。

**待核對（各附核對方法）**
1. 1.22.0 的 Windows 套件是否含 `DirectML.dll`：在隔離資料夾用 `npm pack` 取 tarball 清單（需使用者同意下載，或讀使用者機器上已存在的 `userData/native-runtime/`）。
2. ORT on-device training 在 web 上實際用哪個後端、是否支援 WebGPU：讀 <https://onnxruntime.ai/docs/tutorials/on-device-training/> 與 `onnxruntime-web` 原始碼的 training 目錄。
3. llama.cpp 的 LoRA 訓練是否已併入主線、Vulkan 後端是否有 `OUT_PROD`／`OPT_STEP_ADAMW` 實作、是否支援 Qwen3：讀 `ggml/src/ggml-vulkan/` 與訓練範例原始碼（唯讀 `gh api`／瀏覽），再在隔離資料夾跑一次小訓練。
4. ncnn 是否有訓練支援：讀其 GitHub 文件（目前**未查證**，預設視為只有推論）。
5. `torch-directml` 能否跑通 `train_lora.py`（Qwen3 全部算子、反向）：隔離資料夾實測，需使用者同意下載。
6. WebGPU：`maxStorageBufferBindingSize`、`shader-f16`、裝置遺失行為在使用者顯示卡上的實值：階段 4 用 `adapter.limits` 實測；Firefox／Safari 的 WebGPU 支援版本未查證。
7. 本文 §5.8 的所有門檻數值是設計初值，階段 2 校準。
8. 跨後端續訓的容許誤差（2%／5%）同為初值，階段 3 以真實兩後端對拍校準。
9. 斜線指令註冊表、aiDoc 檢視器可複用的函式名、fap 讀寫函式、embed 腳本清單與標記規則——動工前對原始碼逐一確認。
10. 網頁版是否有可用的程式沙盒（blockly／matrix 驗證依賴 python／gcc 判題器）。
11. 網頁版記憶體上限、`onnxruntime-web` 訓練能力——未量測。
12. 桌面版沒有 Python 的使用者怎麼辦（內建便攜 Python？下載？只匯出訓練包？）——產品決策。
13. 老師送資料給線上 AI 的隱私與費用提示。
14. 區網／遠端傳輸（§3.1 (c)）的安全設計（配對碼、加密）尚未設計。


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


## 13. LoRA 按需載入與資料匯入清洗（已實作，2026-11-11）

使用者需求：「訓練出來的LoRA要有辦法給主程式按需求載入，例如我也想要將來可以有資料匯入跟清洗器，將資料從wiki或open source或書本內容, aiDoc來變成LoRA」。三個純核心（UMD、依賴注入、Node 與瀏覽器都能載入），都在 `renderer/src/studio/`；測試登錄在 `scripts/run-core-tests.js`。

### 13.1 檔案
| 檔案 | 內容 |
|---|---|
| `lora_registry_core.js` | LoRA 登錄表、相容性檢查、依需求選用（路由）、預算與 LRU 卸載、載入器介面、`entryFromManifest`（由 `pack_adapter.js` 的 manifest 轉登錄項）、`nrEngineLoader`（把 nr-engine 接點包成載入器，載入前核對 sha256） |
| `ingest_core.js` | 四種來源轉接器 `fromWiki`／`fromOpenSource`／`fromBook`／`fromAiDoc`，與分派 `ingest(source, input, opts)`；輸出統一「文件」`{text, code?, heading, meta}` |
| `clean_core.js` | 清洗管線 `cleanDocs`、切塊、去個資與密鑰、品質過濾、去重、授權政策、老師請求單 `buildSampleRequests`、老師樣本驗證 `verifyTeacherSample`、純規則樣本 `ruleSamples`、schema 檢查 `validateRow(s)` |
| `lora_registry.test.js`、`ingest.test.js` | 43＋77 項斷言 |

### 13.2 按需載入（lora_registry_core.js）
- 登錄項欄位：`id, name, source('builtin'|'user'|'imported'), base, base_sha256?, rank, alpha?, prompt_format_version, tool_catalog_sha256?, domains[], triggers[], conflicts_with[], priority, location, size, sha256, enabled, eval, added`。
- `checkCompat(entry, env)`：base、基底雜湊、rank 不在槽（`env.rank_slots`）、提示格式版本不符 → `reject` 並回 `{field, expected, actual, message}`；`tool_catalog_sha256` 不符或缺 → `warn`（對應 DESIGN.lora-training §10）。
- `select({domain, domains, text, ids})` → `{plan, skipped:[{id, reason}]}`：停用／不相容／無評量資料／有組別輸給基底者不自動選用（手動 `ids` 可繞過「無評量」與「輸基底」，**不能**繞過不相容）；同領域只留一個，排序＝來源（使用者 > 匯入 > 內建，沿用 §7）→ `priority` → 評量 → 較新；`conflicts_with` 排除排序在後者；通用（`domains` 空）只在沒有專屬者時補上；`text` 以 `triggers`（字串或正規表示式）比對使用者指令；取前 `maxActive` 個。
- `ensure(plan)`／`request(req)`：預算（`budgetBytes`，預設 256 MiB）不夠就依 LRU 卸載不在本次計畫內者；單靠計畫就超預算則丟排序最後者並寫原因；載入失敗回具體原因、不留駐留。`setEnabled(id,false)` 會同時卸載。`snapshot()`／`restore()` 供存進 Studio 儲存層。
- **載入器介面**：`{load(entry) → handle, unload(entry, handle)}`。**現有主程式接點**：`nr-engine.js` 的 `loadModel(modelPath, tokenizerPath, threads, lora)`（約第 22 行；`lora = {id, bytes}`，bytes＝`lora.bin`，以 onnxruntime 的 `externalData` 交給 session；換 adapter＝傳不同 id／bytes，session 重建）；`nr-engine.js` 呼叫處 `opts.lora`（約第 53 行）。`nrEngineLoader({readBytes, sha256Hex})` 回傳的 handle 正好是這個 `{id, bytes}`。
- **尚未完成與具體阻礙**：
  1. **同時套多個 adapter 做不到**：`nr-engine.js` 一個 session 只吃一個 `lora.bin`（模型是 `make_lora_onnx.py build` 的單一 LoRA 槽版），所以 `maxActive` 預設 1；要多個同時作用，需新增「多槽版」ONNX 或在載入前把多個 adapter 的 A／B 依 rank 槽合併（兩者都要改 `make_lora_onnx.py`，本階段未做）。
  2. 網頁版（transformers.js 的 `session_options.externalData`）接點在 `floating-assistant.js`／`vlm_core.js`，使用者規則禁止本階段改 `floating-assistant.js`，所以尚未接線；登錄表本身網頁版也能載入。
  3. 登錄表持久化（存進 fap／KVStore）與設定頁 UI 沒做，只提供 `snapshot()`／`restore()`；GitHub `lora-adapters` branch 的下載與分片重組沿用 §10 設計，未做。
  4. 領域標籤來源：manifest 目前沒有 `domains` 與 `prompt_format_version` 欄位（`pack_adapter.js` 沒寫），`entryFromManifest` 需呼叫端補；`pack_adapter.js` 要補寫這兩欄才能全自動。

### 13.3 資料匯入與清洗
流程：來源 → `ingest`（文件）→ `cleanDocs`（語料塊 `kind:'corpus_chunk'`）→ 兩條出口：
1. `buildSampleRequests`：**樣本生成請求單**（`kind:'sample_request'`，`status:'pending'`，記錄任務〔qa／summary／instruction／code_explain〕、輸入語料塊、輸出格式與 `verify` 驗證條件；`author:'teacher'`）。語料塊**不是**訓練資料；請求單交給老師（§6）生成後，用 `verifyTeacherSample` 驗證（schema、答案詞彙至少一半出現在語料塊、無個資、`split:'train'`、不得引用 heldout 塊）才收。heldout 塊不產生請求單。
2. `ruleSamples`：不用 AI 的純規則樣本，標 `meta.author:'rule'`、`verified_by:'program_ground_truth'`（答案逐字擷取自語料塊）：標題→摘要（`rule_heading_summary`）、程式碼前導註解→說明（`rule_code_comment`）。品質低於老師生成，只作補充。
- 來源轉接器：wiki（`.md`／`.html`／`.txt`，依標題切段，程式碼區塊內的 `#` 不算標題；HTML 去 script／style／nav、保留標題與 pre）、open source（偵測 LICENSE／COPYING，SPDX 與特徵句，最近上層優先，找不到＝`unknown`；跳過 lock、minified、二進位、過大檔）、書本（只收使用者提供文字，`user_supplied:true`，`\f` 分頁記頁碼，沒有分頁符不編造頁碼，授權預設 `unknown`）、aiDoc（核對過 `_repoIndexSnapshot` 與 `index.sqlite3` 實際結構，支援 `fa-project-notes`、`{meta,notes,map}`〔`/aidoc save`〕、`fa-project-index-bundle`、wiki `index.json`、SQLite 匯出的列陣列；AI 寫的說明記 `note_by`，自動產生的草稿頁跳過）。
- 清洗：正規化（BOM、CRLF、零寬字元、全形空白）、切塊大小＝`contextWindowTokens` 的比例（目標 1/8、上限 1/4、重疊目標的 1/8、下限目標的 1/10，未給視窗用 4096；**無寫死的 token 常數**）、個資與密鑰樣式（email、電話、身分證字號、私鑰、sk-/ghp_/AKIA/Bearer/JWT/`api_key=`；預設改成佔位字並在 `meta.redactions` 記數，`dropOnSecret:true` 則整塊丟棄）、品質（過短、亂碼、文字比例、重複行比例）、去重（精確雜湊＋近似 simhash，8 段×8 位分桶、海明距離 ≤6，≥100 字元才比近似）。
- 授權與來源：每塊 `meta` 記 `source, source_type, license, license_policy{builtin_allowed, kind, note}, url, path, title, heading, page, retrieved_at, redactions, user_supplied`。**只有寬鬆授權（MIT、Apache-2.0、BSD、ISC、CC0、CC-BY-4.0…）`builtin_allowed:true`；copyleft、`user-provided`、`unknown` 一律 `false`，只能留在使用者資產**（內建化 §7 的 `import-asset` 應拒收這類來源，該檢查尚未接上）。
- heldout：路徑含 `holdout`／`heldout` 或 `meta.heldout:true` 的來源標 `split:'heldout'`；去重時 heldout 先入、train 的近似重複被丟（原因 `leaks_heldout`），請求單與規則樣本都不使用 heldout；`validateRows` 另查 train 列有沒有引用 heldout 語料塊。預設 `split:'train'`。
- schema 檢查：`lora-train/gen/merge_dataset.js` 的 `validateRow` 沒有匯出且載入即執行 `main`，無法重用，`clean_core.validateRow` 照同一組必要欄位與 `split` 規則另寫（另加 messages 角色、`verified_by`、`domain` 清單檢查）。新增領域 `doc_knowledge`（已寫進 `lora-train/schema.md` 補充段）；`merge_dataset.js`、`train_lora.py` 尚未認識這個領域（沒有對應的 `gen_*.js`，要把規則樣本／老師樣本併入訓練集需新增產生器或匯入步驟）。
- 實測輸入（`ingest.test.js` 印出）：repo 的 `wiki/`（29 文件→29 塊）、`DESIGN.lora-training.md`＋`DESIGN.project-index.md`（55→56 塊，2 塊過短被拒）、`asset_core.js`＋`storage_core.js`＋`lora-train/README.md`、aiDoc 的 `renderer/src/logmine/.floating-assistant/index/index.sqlite3`（用 python `sqlite3` 唯讀 immutable 轉列陣列，135 文件→121 塊，11 近似重複、3 過短被拒）；規則樣本全數通過 schema 檢查。

### 13.4 未完成（具體阻礙）
- **老師真的生成樣本**：需要線上 AI 與 §6 的老師迴圈（`_runSubAgentTask`＋`studio_*` 工具白名單），都在 `floating-assistant.js`，本階段不得修改；請求單與驗證函式已備好。
- **GUI**（匯入來源挑選、清洗預覽、逐塊拒絕）：屬 §4 的 Studio 視窗，未做。
- **近似去重的規模**：8 桶線性比對，超過約十萬塊時需改成排序合併（目前未實測大語料）。
- **個資偵測只做樣式比對**（email、台灣電話、身分證、常見金鑰格式），人名、地址抓不到；使用者資料進線上老師前仍須 §6 的送出前確認。
- **書本的著作權**無法由程式判定，只能依使用者聲明；不提供「從網路抓書」的功能。

## 14. 整合進主程式（已實作，2026-11-11）
- 架構：瀏覽器端核心（資產／.fatrain／儲存層／trainer 轉接／版面／LoRA 登錄／資料匯入／清洗／假伺服器路由）嵌成 `FaStudio`（`scripts/embed-code-ui.js` 的 `embedStudio`，標記 STUDIO／STUDIOVIEW）；Node 端（後端登錄、基準、檢查點、cpu-py、`studio_host.js`、`lora-train/train_lora.py`）內嵌成 `FA_STUDIO_HOST_FILES`，執行時寫到 `<userData>/studio-host/`，由 `main-ext.js` 的原生信箱 `studio_*` 操作載入，不改 preload／main.js、不需重裝。
- 入口：`/offline-training-studio`、設定頁 → AI → 離線訓練工作室。八個分頁：資產清單、LoRA 登錄、資料匯入、資料集、評量、訓練、老師、紀錄；版面規則見 §4，核心 `studio_layout_core.js`。
- LoRA 登錄：由 kind=lora 且含 `weights/*.bin|.safetensors` 的資產建立登錄項；相容性、評量判定、按需選用、手動載入（讀回權重＋核對雜湊）已可用。**桌面版套用已接（2026-11-11 第三輪）**：載入後經 `h.loraApply`（`lora_apply_core.js`）→ 主程序 `lora_apply`（`main-ext.js` 的 NRL）→ `nr-host`／`nr-child`／`nr-engine` 轉傳到 onnxruntime 的 `externalData`；完整資料流、執行包發佈與升級、降級行為見 `DESIGN.TODO.native-runner.md` §9。**執行包 1.22.0-2 尚未發佈**（等管理者推 GitHub 分支並釘住 commit）：在此之前，已安裝 1.22.0-1 的使用者按「手動載入」會看到「需要更新執行包」，`applied` 為假；網頁版與沒有橋接的環境也維持「尚未套用」。未實測的部分見 native-runner §9.5。
  - **網頁版 LoRA（2026-11-11 第四輪：已實作路線 c，程式與假模型測試完成，真模型端到端尚未實測）**——詳見下方 §14.1。舊版「阻礙一／二」已被 §14.1 的查證與選擇取代：不再需要槽版模型與託管，也不需要修改 transformers.js 原始碼。
- 資料匯入：wiki／開源／書本／aiDoc → 清洗 → 語料塊＋請求單＋規則樣本，可逐塊拒絕、存成 kind=lora 的資料資產（`data/corpus.jsonl`、`requests.jsonl`、`train.jsonl`）；老師領取／驗證／回交接口 `/api/teacher/claim｜submit｜release` 已可用，**老師迴圈本身（呼叫線上 AI）仍是 §10 步驟 7 未做**。
- 驗證：`scripts/eval/studio.eval.js`（真 Electron，38 項；cpu-py 真訓練因本機缺 torch 未能跑）。


### 14.1 網頁版 LoRA：查證、三條路比較、選擇與實作（2026-11-11 第四輪）

使用者要求：「網頁版也要可以支援LoRA。沒有託管的話有沒有辦法網頁版做到下載並在網頁上量化，或者只能切片並放入 branch」「如果支援需要修改transformer.js原始碼，請修改」。結論先講：**選路線 c（載入時把 LoRA 併進 q8 權重）已實作**；不需要託管槽版、不需要切片、不需要修改 transformers.js 原始碼。真模型端到端尚未實測（見末段清單，等你決定下載）。

#### 查證（只讀 repo，沒有下載任何東西）
- **載入處**：`floating-assistant.js` 的 `faVlmWorkerMain`（Worker）→ `load()` 的 `causal-lm` 分支：`AutoModelForCausalLM.from_pretrained(repo, {dtype, device})`；主執行緒由 `_vlmEnsureLoaded` 決定裝置順序並送 `load` 訊息。
- **transformers.js 與 ORT 的來源**：`FA_ASSET_URLS.transformersJs`＝CDN 的 transformers 3.7.5（WASM／CPU），`transformersJsWebGpu`＝CDN 的 4.2.0（WebGPU）。**repo 沒有內嵌複本，node_modules 也沒有 transformers 或 onnxruntime-web**（桌面版的 ORT 在原生執行包裡），所以原始碼本機讀不到、也不能直接改檔；若真要改只能「補丁覆蓋」。ORT 版本由 transformers 套件內含決定，未讀原始碼，不寫版本號。`moss_worker.js` 以 `externalData` 載入 MOSS 的外部資料，證明網頁版 ORT 的工作階段選項支援它。
- **模型**：`qwen3-0.6b`，GPU 用 `q4f16`（約 543 MB，四位元分塊量化）、CPU 用 `q8`（約 589 MB，onnx-community 的 `onnx/model_quantized.onnx`，動態量化：權重 8 位元整數、每個張量一個縮放純量、後接 Mul 乘縮放）。`make_lora_onnx.py` 針對的就是這份 q8 圖。
- **需要讀 npm 原始碼才能確定、因此未確定的事**：transformers.js 是否把 `session_options.externalData` 傳給 ORT（影響路線 a、b），以及它取模型檔是否經過全域 `fetch`（影響路線 c 的攔截）。路線 c 把第二項做成執行時檢查（沒經過就報錯，不假裝成功），所以不必先讀原始碼。若你要我讀，需下載：`@huggingface/transformers@3.7.5` 與 `@4.2.0` 的 npm 套件壓縮檔（各約數 MB 至十餘 MB，實際大小未查），來源 registry.npmjs.org；你同意前我不下載。

#### 三條路比較
| | (a) 瀏覽器內改圖＋量化 | (b) 槽版切片放 branch | (c) 載入時併入權重（選這條） |
|---|---|---|---|
| 做法 | 下載標準 q8，在 JS 內改寫 ONNX：196 個目標各插 3 個節點、改名輸出、加 392 個外部初始值，A／B 以 `externalData` 給 ORT | 本機用 `make_lora_onnx.py build` 產生槽版（約 600 MB），切成 ≤20 MB 分片推到 branch，網頁版下載重組後載入 | 下載標準 q8，攔截 `fetch`，在位元組層級把 B·A 併進權重並把縮放值改成每欄一個，原地換掉再交給 transformers.js |
| 需要託管 | 否 | **是**（約 600 MB，約 30 片；每次重建槽版歷史再多 600 MB，GitHub 建議倉庫 1 GB 內） | 否 |
| 需要改 transformers.js | 要確認 `externalData` 會被傳遞（未驗證）；不通就要補丁覆蓋 | 同左 | 否（只攔截 fetch） |
| 圖改寫 | 要（protobuf 讀寫我已寫好，但節點插入、拓撲順序、輸出改名是新增風險；GPU 的 q4f16 圖是另一種結構要另寫） | 不用（本機用 Python 做） | **不用**，只換 196 個縮放初始值與權重位元組 |
| 「在頁面上量化」 | 對 q8 基底不需要（已量化）；從 fp 基底做要下載 1.2～2.4 GB 並在 JS 內量化，記憶體與時間更差，沒有理由 | 不適用 | 不適用 |
| 網頁版額外下載 | 無 | **多一份 600 MB**（與標準版並存，瀏覽器快取共 1.2 GB） | 無 |
| 推論成本 | 每層多兩個矩陣乘 | 同左 | **無**（併入後與基底同樣大小） |
| 精度 | 與桌面版相同（A／B 保持 32 位元浮點） | 同左 | 有損，見下表 |
| 換 adapter | 重建工作階段 | 重建工作階段 | 重新下載（讀快取）＋重新併入，約一分鐘級 |
| 能同時套多個 adapter | 否（一個槽） | 否 | 可以先把多個 B·A 相加再併（本輪只做一個，未做） |

**選 c 的理由**：(1) 不需託管，沒有 600 MB 下載與倉庫膨脹的問題；(2) 不依賴未驗證的 `externalData` 傳遞，也不改圖，失敗面小；(3) 推論成本與基底相同；(4) 唯一代價是精度有損，而這可以事先用數值實驗量出來並在執行時量測。**什麼情況下改選 a 或 b**：實測發現 c 的精度對你的 adapter 不夠（執行時量到的輸出相似度過低，系統會拒絕套用並說明）時，才需要保留 32 位元 A／B 的路線；那時 b 比 a 穩（圖改寫在本機做）。

#### 路線 c 的精度：數值實驗
**為什麼不能「反量化→加 BA→用原縮放重新量化」**：q8 每個張量只有一個縮放值，步距約為整張權重範圍的 1/255；LoRA 的變化量每個元素只有步距的 0.3%～3%，四捨五入後整個消失。實驗（合成權重 1024×2048、rank 16，輸入含 A 對齊成分；權重分兩種：t 分佈 df=3、高斯加稀疏離群值）量「併入後輸出的變化 vs 真正 LoRA 分支的變化」的餘弦相似度：

| 方法 | 變化量 1%（對權重範數） | 變化量 3% | 基底輸出多出的雜訊 |
|---|---|---|---|
| 直接用舊縮放四捨五入 | 0.000（全部消失） | 0.000 | 0.04～0.24 |
| 每張量隨機進位 | 0.80 | 0.90 | 0.06～0.12 |
| 每欄重新量化（新縮放不整除舊格） | 0.83～0.96 | 0.99 | 0.02～0.05 |
| 每欄細格＋四捨五入 | 0.60～0.86 | 0.97 | 0.04～0.07 |
| **每欄細格＋抖動（採用）** | **0.967～0.979** | **0.993～0.996** | **0.017～0.028** |

參考：q8 本身相對 32 位元浮點的輸出誤差約 13～30%（合成重尾權重，偏嚴苛），所以多出的 2% 雜訊遠小於基底原有的量化誤差。**限制**：變化量低於約 0.5% 時相似度會明顯下降（單元測試 0.05% 的情形量到 < 0.9）；真實 adapter 的變化量大小未知，且合成權重不等於真的 Qwen3 權重——**這些數字是設計依據，不是真模型的結果**。程式在套用時對每個張量用探針輸入實際量測輸出相似度，平均低於 0.5 就拒絕套用並回報數字。

**採用的做法（細格＋抖動）**：(1) 每個輸出欄各自一個縮放值：新步距＝舊步距／k，k 是整數，取「該欄權重範圍仍塞得進 8 位元」的最大值（上限 64，實驗平均約 11）；因為 k 是整數，舊權重剛好落在新格點上，基底不增加量化誤差。(2) 變化量以新步距為單位，用「抖動式四捨五入」（加固定種子的均勻亂數再取下整）：期望值不偏，即使遠小於一格也不消失。(3) 計算圖裡縮放值只參與 Mul（廣播），把純量改成長度 dout 的向量不用改圖；零點維持純量不動（不用每欄零點，避開 ORT 對逐欄零點的支援差異）。(4) 零 adapter 時併入結果與基底逐值相同（測試涵蓋）。

**成本**：單一張量實測（Node 16、1024×3072、rank 16）約 176 ns／元素，全模型約 4.4 億個權重元素，外推約 77 秒（在 Worker 內，不卡畫面；外推值，真機未量）。記憶體：原檔 589 MB＋併入後的副本（Blob 串接，只多出縮放向量）＋ORT 載入時再複製，峰值約為模型大小的 2～3 倍；機器記憶體不足會在載入時失敗並回報，不會靜默。

#### 實作
| 檔案 | 內容 |
|---|---|
| `renderer/src/studio/onnx_patch_core.js` | 最小 ONNX protobuf 讀寫：索引節點與初始值、編碼新張量、只重寫被換掉的初始值並用零拷貝切片串接；遇到外部資料、非 raw_data、`graph.input` 含該初始值就丟明確錯誤 |
| `renderer/src/studio/lora_merge_core.js` | 細格＋抖動併入（uint8 與 int8 都支援）、輸出相似度探針、`lora.bin` 版面計算（與 `make_lora_onnx.py` 的 A／B 順序與 64 位元組對齊一致，網頁版不需要 `layout.json`） |
| `renderer/src/studio/lora_web_core.js` | `patchQwen3Q8`（找 196 個目標、核對大小／結構、併入、品質閘門、可選重新解析核對）、`installFetchPatch`（攔截 fetch，從瀏覽器快取取原檔並不寫回併入結果）、`createWebLoraApplier`（與桌面版同介面 `apply／clear／status`） |
| `renderer/src/floating-assistant.js` | Worker `load()` 在有 `lora` 時才攔截並併入；`_vlmEnsureLoaded` 有 LoRA 時強制 CPU、已載入判斷納入 LoRA 雜湊；`_studioWebLoraApplier` 接進 Studio 的 `h.loraApply`（網頁版）；`scripts/embed-code-ui.js` 嵌入三個核心與 Worker 用原始碼字串 `FA_WEBLORA_WORKER_SRC` |
| `renderer/src/studio/lora_web.test.js` | 54 項斷言，已登錄 `scripts/run-core-tests.js` |

- **核對（applied 為真的條件）**：`lora.bin` 大小與由標準圖推得的版面完全相等；196 個目標的結構（節點名、DynamicQuantizeLinear、純量縮放、權重型別）全部符合；品質閘門通過；`fetch` 攔截確實被 transformers.js 用到（`hits ≥ 1`）；Worker 回報合併報告，主執行緒收到才回 `ok:true`。任何一項不成立都回具體原因並把狀態退回前一個 adapter。雜湊：登錄表載入時已核對 `lora.bin` 的 sha256，併入的抖動亂數種子也由該雜湊決定（同一份 adapter 每次併入結果相同）。
- **沒有 LoRA 時與現在完全一致**：Worker 只在 `m.lora` 存在時執行攔截；主執行緒只在 `this._webLora.lora` 有值時改裝置順序與載入參數（測試涵蓋「不相符網址原樣通過」「沒有 LoRA 不安裝攔截」，載入路徑的其餘程式碼未動；`vlm_core.test.js` 143 項仍全過）。
- **限制（誠實列出）**：只對 `qwen3-0.6b` 的 CPU（WASM）q8 檔有效；有 LoRA 時即使偏好 GPU 也改用 CPU（q4f16 是四位元分塊量化，併入會被量化吃掉，本輪不支援）；同時只套一個 adapter；rank 槽固定 16（與登錄表的 `rank_slots` 一致）；`lora.bin` 約 39 MB（28 層×7 個目標，A、B 以 32 位元浮點）。

#### 未實測的部分與需要你決定的清單
單元測試用自己編碼的假 ONNX 與假 fetch，**沒有跑過真的 ORT 與真的 transformers.js**，以下是風險與驗證步驟：
1. **ORT 能否接受縮放值變成 [dout] 向量**（圖裡 `value_info` 可能仍宣告純量，預期只是警告，但未驗證）；**transformers.js 3.7.5 是否經過全域 fetch**（沒有的話本功能會明確報錯「沒有經過 fetch」而不是靜默失效，此時才需要讀它的原始碼或改用 `env.customCache`）；**瀏覽器快取名稱** 假設為 `transformers-cache`（對不上時會重新下載原檔，不影響正確性）。
2. 記憶體峰值（約模型的 2～3 倍）在低階機器上是否過不了。
3. 真實 adapter 的輸出相似度與語意效果（有／無 adapter 的同一提示輸出是否符合訓練目標）。

驗證步驟（需你同意下載）：(1) 瀏覽器載入 `onnx-community/Qwen3-0.6B-ONNX` 的 `onnx/model_quantized.onnx`，約 589 MB，來源 huggingface.co（應用程式自己下載到瀏覽器快取，使用者若已用過離線 Qwen3 CPU 版就已經有）；另有 tokenizer 與設定小檔合計約 3 MB。(2) 一份真的 `lora.bin`（約 39 MB，本機 `lora-train` 流程用 `pack` 產生，不需下載；沒有的話我可以用隨機 adapter 做結構驗證，但看不到語意效果）。(3) 在網頁版訓練工作室載入 LoRA，檢查 `applied` 為真、合併報告（併入層數、輸出相似度、耗時）、同一提示有／無 adapter 的輸出差異、記憶體峰值。**不需要推送任何東西到 GitHub**；`floating-assistant.js` 有改動，發布 live-update 補丁由你決定時機。
