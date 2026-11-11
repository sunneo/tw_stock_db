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
| `webgpu`：瀏覽器 WebGPU，自寫 WGSL 計算著色器（網頁版與桌面版 Electron 渲染行程都能用） | 可（已用 onnxruntime-web WebGPU，`vlm_core` 有降級，`shader-f16` 檢查） | **無「現成可直接用」的方案**（2026-11-11 查證，詳見 §5.6）：ORT 網頁訓練只有 WASM 的 CPU 後端且官方訓練套件已棄用；rullama 有瀏覽器 LoRA 但只支援 Gemma 4；tensorgrad 只有 f32 無 LoRA。自寫路線＝只訓練 LoRA 的 A／B（約 10M 參數），基底凍結；需要自己寫各層前向與反向（RMSNorm、attention、MLP、q8 反量化矩陣乘、RoPE、softmax／交叉熵）。**可行性＝理論上可行，工程量大、數值風險高，沒有實測數字** | 零安裝，但每台顯示卡的 WGSL 行為、緩衝區上限（`maxStorageBufferBindingSize` 預設 128MB，0.6B 權重要分塊）、記憶體上限都要實測；瀏覽器分頁會被回收 | 瀏覽器（Chrome／Edge 預設有；Firefox／Safari 版本不一，未查證）；Electron 繼承 Chromium | 高：數值與反向的正確性（要與 `cpu-py` 對拍）、裝置遺失（device lost）要能從檢查點續跑 | **第一版不做完整 LoRA**；階段 4 只做可行性實驗（單層 LoRA 梯度對拍，再擴展），有數字才升格 |
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

網頁版 LoRA 訓練目前**沒有可用後端**（`webgpu` 未實測；`cpu-js` 的純 JS 反向已有參考實作與梯度驗證，但速度不足以訓練 0.6B，見 §5.6）。UI 顯示：「目前請用桌面版訓練，或匯入別台訓練好的 adapter／續訓包」，不假裝能訓練。`webgpu` 研究成功並通過 §5.8 後才解鎖。

### 5.6 網頁版瀏覽器內訓練 LoRA：路線查證與實測（2026-11-11 重寫，更正先前「沒有現成方案」的說法）

**更正**：先前寫的「尚無現成方案、要自寫 WebGPU 反向引擎」不準確。查證後**有現成的路線，但沒有一條同時滿足「Qwen3-0.6B、瀏覽器、可用速度」**。下表逐條列出，來源皆為 2026-11-11 查閱；標「未驗證」的沒有親自跑過。

| 路線 | 能否在瀏覽器訓練 | LoRA 反向 | 對 0.6B 的記憶體／速度 | 依賴與體積 | 風險 | 工作量 |
|---|---|---|---|---|---|---|
| (a) onnxruntime-web 訓練版（`onnxruntime-web/training`） | **可，但只有 CPU（WebAssembly）**：2024-02 官方部落格寫「ORT Web 訓練只支援 CPU，由 WebAssembly 實現」。訓練圖要離線產生（Python `generate_artifacts` → 訓練圖、優化器圖、評量圖、檢查點四個檔） | 理論上可（可指定凍結參數、只訓練 LoRA 參數），**但 Qwen3 全部算子是否都有梯度定義未驗證**；我們的前向圖含 q8 量化算子，訓練圖要用 fp32 的 PyTorch 匯出版本重做 | WASM 為 32 位元，單一分頁可定址約 4GB；0.6B fp32 權重 2.4GB 加激活與優化器已近上限（**阻礙**）；速度只會比現有 `cpu-py`（約 60 token/s）慢 | repo 已用 onnxruntime-web 1.22.0（CDN 載入）；**訓練版 wasm 另載，體積未量測** | **官方狀態不明**：ORT 1.20.0 發行說明稱「所有 ONNX Runtime Training 套件已棄用」（PyPI／NuGet／Maven 等，最後版本 1.19.2；列表未明確包含 npm 的 web 訓練）。`generate_artifacts` 若只存在於已棄用的 Python 訓練套件，就要用 1.19.x 時代工具鏈 | 中偏大，且被棄用風險高；**不建議當主路線** |
| (b) TensorFlow.js | 可（WebGPU／WASM 後端、自動微分），但官方文件與範例都是小模型與遷移學習（只換最後一層）；**查無** Qwen3 載入、transformer LoRA 範例 | 自動微分可求梯度，LoRA 要自己寫層；不支援 q8 量化矩陣乘 | 沒有 0.6B 實例；f32 權重 2.4GB、WebGPU 單緩衝區上限要分塊（未驗證） | repo 沒用 | 專案重心在推論；Qwen3 的 RoPE、GQA、RMSNorm 都要自己組 | 大，**不建議** |
| (c-1) Burn（Rust 編成 WebAssembly＋WebGPU） | README：自動微分是疊在後端上的裝飾器，WGPU 後端可編成 WebAssembly 在瀏覽器跑；**瀏覽器範例是推論（手寫數字辨識），未見文件記載瀏覽器內訓練大模型**（未驗證） | 框架有自動微分，LoRA 與 Qwen3 要自己寫 | 無 0.6B 數據 | 需 Rust 工具鏈與編譯產出（repo 沒有） | 版本變動快、docs.rs 0.22.0 建置失敗 | 大 |
| (c-2) **rullama**（Rust，wgpu；`rullama-finetune`，Apache-2.0 或 MIT 雙授權） | **可：README 明說瀏覽器（wasm＋WebGPU）內 LoRA 微調**；反向算子有 Q4_K／Q6_K 矩陣乘、RMSNorm、RoPE、GeGLU、注意力 dQ／dKV、交叉熵、Adam；梯度累積、梯度檢查點、混合精度、輸出 safetensors | **有**（q/k/v/o＋前饋） | README 只給推論速度（iPhone 16e 約 4.65 token/s、舊 AMD 顯示卡約 1 token/s，「naive kernels」），**沒有訓練 token/s 與記憶體數字**；訓練驗證只有「200 步過擬合單一樣本，loss 17.7→0」 | 需 Rust 1.91 以上＋wasm-pack 自行編譯，無 npm 套件；wasm 體積未知 | **只支援 Gemma 4**（README 寫明 llama／mistral／qwen／phi 不支援）；4 顆星、無下游使用者、0.x；GitHub 說明與 docs.rs 的套件名有出入 | 把 Qwen3 結構（GQA、q/k norm、SwiGLU）加進去：大。**當參考實作與算子清單很有價值，直接採用不可行** |
| (d-1) tensorgrad（npm，MIT，v0.5.2，只有 WebGPU） | 可：TypeScript 反向自動微分，Adam／AdamW，Worker 內訓練；文件有多頭注意力、`softmaxCausal`、`rope`、`RMSNorm`、嵌入 | **未內建 LoRA**（推論：凍結權重當輸入、A／B 當參數可手組，**未驗證**）；**只支援 f32 權重**、靜態形狀，無量化 | 0.6B f32 權重 2.4GB 要整塊放進顯示記憶體，超過多數瀏覽器單緩衝區與記憶體上限；**阻礙**：無量化、無分塊載入說明 | 零依賴，體積未知 | 新（約一個月前發版）、單人維護 | 中：小模型可試；0.6B 需先解權重分塊與 f16 |
| (d-2) Tapasya（示範頁，進化策略 EGGROLL 加 rank-8 LoRA，SmolLM-135M） | 可，**不用反向傳播**，只做前向（WebGPU；CPU 約慢 10 倍） | 不需要反向 | 135M 模型 2000 步約 8 分鐘（頁面自述，無 token/s）；下載約 540MB | 授權頁面未載（未取得） | 進化策略的樣本效率遠低於梯度法；**在我們的選擇題任務是否收斂沒有證據** | 中；列為低門檻備案，不是主線 |
| (d-3) WebLLM／transformers.js／tinygrad WebGPU | 都只做推論（tinygrad 有 GPT-2 124M 編成 WGSL 的推論範例）；**查無瀏覽器訓練** | 無 | — | — | — | 不適用 |
| 純 JS 自寫（本研究的參考實作） | 可，**已實作並驗證正確性**（見下） | 已完成 q/k/v/o LoRA 的手寫反向 | 純 JS 速度不足以訓練 0.6B | 零依賴 | 速度 | 見下方階段 |

#### 實測（本機，沒有 GPU、沒有 torch）

- 檔案：`renderer/src/studio/lora_ref_train.js`（前向＋手寫反向＋Adam）、`lora_ref_train.test.js`（已登錄 `scripts/run-core-tests.js`）。假模型：2 層、隱藏維度 64、4 個注意力頭、前饋 128、詞表 32、RMSNorm、因果注意力含 RoPE、SiLU 閘控前饋、綁定詞嵌入；LoRA 加在 q／k／v／o，rank 8。
- **梯度正確性**：手寫反向對 fp64 有限差分（中央差分，eps=1e-5），抽樣 96 個參數（2 層 × q／k／v／o × A／B），**最大相對誤差 3.9e-6**；`B=0` 時 A 的梯度精確為 0。
- **fp32 影響**：每個算子輸出做 `Math.fround` 模擬 fp32 捨入，整體梯度相對 L2 誤差 **2.7e-7**。這只含逐算子捨入，**不含 GPU 平行累加順序的差異**，所以是下限不是上限；§5.7 階段 4 的門檻（單層 1e-3、區塊 5e-3）有餘裕。
- **訓練行為**：固定一條 16 token 序列，30 步 Adam（學習率 0.02）loss 4.07 → 0.02（過擬合，只證明端到端反向可用）。純 JS 單執行緒 fp64 每步約 16 ms（T=16、約 2 萬 LoRA 參數）。
- **不是對 PyTorch 的對拍**：本機沒有 torch（匯入失敗），所以參考是「有限差分」而非 PyTorch；有限差分對反向公式是獨立的嚴格檢驗，但**與 `train_lora.py` 的 loss 對拍仍未做**，需要安裝 torch 與 Qwen3 權重（見回報的下載清單）。
- **WebGPU 本身沒有在這台機器驗證**：缺 (1) 有 WebGPU 的瀏覽器環境（Electron 渲染行程可以，但需開視窗或無頭 GPU 設定，依「不彈視窗」規則沒有跑）；(2) WGSL 著色器尚未寫。因此**沒有任何 WebGPU 訓練速度數字**，下列 0.6B 數字全是算術估算。

#### Qwen3-0.6B 全尺寸估算（算術，非實測；T=512、rank 16）

| 項目 | 數字 | 依據 |
|---|---|---|
| 基底參數 | 596M（本體 441M＋詞嵌入 155M） | 28 層、d=1024、前饋 3072、16 頭、8 個 KV 頭、頭維 128、詞表 151936（`estimate06B`） |
| LoRA 參數（q/k/v/o，rank 16） | 4.6M（rank 32 約 9.2M） | 同上；原先「約 10M」大約對應 rank 32 |
| 每 token 訓練計算量 | 2.38 GFLOP（逐層重算約 3.58 GFLOP） | 前向 2×參數，反向只算對輸入的梯度（基底凍結，不算權重梯度），LoRA 梯度可忽略 |
| 與已測 CPU 對照 | 60 token/s ≈ 0.14 TFLOPS 有效 | 2.38G × 60 |
| 權重記憶體 | f16 1137MB；q8 568MB | 596M × 2 或 × 1 |
| 激活 | 不做檢查點 1400MB；逐層檢查點 106MB | `estimate06B` 粗估；logits（f32）297MB，需分塊算損失 |
| 優化器狀態 | 約 55MB | LoRA 參數 × 4B × 3（參數、m、v） |
| 合計（q8 權重＋檢查點） | 約 1.0GB 顯示記憶體 | 單一緩衝區上限預設 128MB，權重須分塊綁定（`maxStorageBufferBindingSize`，可請求更高，要實測） |

速度（**推測，無實測**）：若內顯可持續 0.3–0.6 TFLOPS，約 **100–250 token/s**（比 CPU 快 2–4 倍）；若矩陣乘寫得保守只達 0.1 TFLOPS，則與 CPU 相當。要有實測才能承諾。記憶體上看是**可行**的（約 1GB），阻礙在算子正確性與調校，而不是容量。

#### 使用者要求（2026-11-11）：網頁版自己產生訓練圖，使用者端不必有 Python

先前說「訓練圖由開發者離線產生一次、使用者端不需要」是**繞過需求的說法，已作廢**。目標改為：網頁版（瀏覽器內，無 Python）自己從模型產生「前向＋反向＋優化器步」的圖並執行。

**步驟 1：Pyodide 路線的具體阻礙（查證，2026-11-11）**

| 項目 | 結果 | 來源 |
|---|---|---|
| Pyodide 內建套件 | 版本 314.0.7 的套件表**沒有** onnx、onnxruntime、onnxruntime-training、torch、tensorflow、jax；有 numpy、protobuf、scipy、safetensors、ml_dtypes | <https://pyodide.org/en/stable/usage/packages-in-pyodide.html> |
| 自行 micropip 安裝 | 只能裝純 Python 的 wheel；含編譯擴充的套件「需為 Pyodide 交叉編譯」 | <https://pyodide.org/en/stable/usage/faq.html> |
| `generate_artifacts` 能否在 Pyodide 跑 | **不能**：它呼叫 `build_gradient_graph`，而該函式需要原生的 `onnxruntime.capi._pybind_state`（`GradientGraphBuilder`、`get_optimized_model`，C++ 編譯） | 原始碼 <https://raw.githubusercontent.com/microsoft/onnxruntime/main/orttraining/orttraining/python/training/onnxblock/_training_graph_utils.py> |
| ORT 的 Pyodide 支援 | 只找到 2022 年已關閉的需求 pyodide/pyodide#3038，沒有後續 | GitHub 議題搜尋 |
| 能否取代原生 C++ 梯度圖建構 | 阻礙＝沒有 wasm 版 `onnxruntime-training`；解除條件＝自己編譯（emscripten 編整個 ORT 訓練模組，工程與體積都遠大於下一條路線）。**因此不走 Pyodide**，改用步驟 2 的純 JS 產生器（也不需要 Python） | — |
| 附帶事實 | npm 的 `onnxruntime-web@1.22.0`（實際解包檢查）**沒有訓練版**：`dist` 內 0 個含 train 的檔、`package.json` 無 `./training` 匯出；所以「ORT 網頁訓練版」在本專案使用的版本根本不存在，與官方訓練套件棄用的說法一致 | 本機實測 |

**步驟 2：主攻路線＝ONNX 反向圖產生器（純 JS，階段 1 已完成並實測）**

- 實作：`renderer/src/studio/onnx_grad_core.js`（靜態形狀圖建構器、反向模式自動微分、圖內 Adam、ONNX opset 17 序列化、純 JS 直譯器）；`lora_graph_model.js`（把參考小模型建成圖）；`onnx_grad_core.test.js`（已登錄）；`scripts/ort-grad-check.js`（交給真的 onnxruntime-web 執行對拍）。
- 輸出是**普通推論圖**（只用 Add／Sub／Mul／Div／Neg／Sqrt／Reciprocal／Log／Sigmoid／Softmax／MatMul／Transpose／Reshape／ReduceSum／ReduceMean／Expand／Gather／DequantizeLinear 這些標準運算子），可交給一般 onnxruntime-web（WASM 或 WebGPU），完全不依賴 ORT 訓練版或 Python。
- **實測（假模型：2 層、d=64、4 頭、LoRA rank 8 在 q/k/v/o）**：
  - 圖版本 loss 與純 JS 手寫參考（`lora_ref_train.js`，其反向已對有限差分 3.9e-6）完全一致（Δ=0）；16 個 LoRA 張量梯度對參考相對 L2 誤差 **9.7e-16**（fp64 直譯器）；基底改存 int8＋逐欄縮放的 `DequantizeLinear`（直通估計：權重凍結，梯度只穿過激活）同樣 **9.9e-16**；圖內 Adam 一步對參考 **2.4e-16**。
  - **真的 onnxruntime-web 1.22.0（WASM，Electron 內建 node 執行；node 16 會閃退，退出碼 3221226505）**執行序列化後的 610 節點訓練圖：17 個輸出（loss 與全部更新後參數）對 fp64 相對 L2 誤差 **3.2e-7**；單步（前向＋反向＋Adam）暖機後約 **5–6 ms**（序列長度 16，WASM 單執行緒），載入 2.5 秒。
  - 未列反向規則的運算子（測試用 `Erf`）會丟出「沒有反向規則的運算子」，不會產生錯的梯度。
- **真 Qwen3 的運算子清單與處理（`model_quantized.onnx`，1312 節點；數量為實際統計）**：

| 真模型運算子（數量） | 訓練圖中的處理 | 反向規則狀態 |
|---|---|---|
| MatMulInteger（196）＋DynamicQuantizeLinear（112）＋Cast（198）＋縮放用 Mul（448） | 降成 `DequantizeLinear(權重)`＋`MatMul`；**激活不量化＝直通估計**（與部署前向有量化雜訊差，需另量化差距） | MatMul、DequantizeLinear（常數）✔ 階段 1 以 int8 逐欄縮放驗證；真權重是 uint8＋零點，格式待階段 2 核對 |
| SimplifiedLayerNormalization（57）、SkipSimplifiedLayerNormalization（56） | 拆成 Mul／ReduceMean／Add／Sqrt／Reciprocal／Mul；Skip 版多一個殘差 Add | ✔（階段 1 用同樣基本運算子驗證） |
| RotaryEmbedding（56，微軟擴充運算子） | `x*cos + (x·R)*sin`，R 為固定 ±1 置換矩陣（Qwen3 是 rotate-half，只需換 R） | ✔（階段 1 驗證相鄰配對版；rotate-half 規則相同、置換矩陣不同，階段 2 驗證） |
| GroupQueryAttention（28，微軟擴充運算子，含 KV 快取） | 訓練圖用無快取版：Reshape／Transpose／KV 頭重複（Expand＋Reshape）／MatMul／Mul／加因果遮罩／Softmax | ✔ 各基本規則皆有（階段 1 驗證多頭因果注意力；GQA 的 KV 重複反向由 Expand 規則做 ReduceSum，階段 2 驗證） |
| Sigmoid（28）＋Mul（SiLU） | 原樣 | ✔ |
| Gather（嵌入，3）、MatMul（輸出頭，1） | 嵌入凍結，不對 Gather 資料求梯度；輸出頭 MatMul | ✔ |
| Shape／Constant／Unsqueeze／Sub／Concat／ReduceSum／Transpose（共約 15） | 位置、遮罩、KV 快取長度處理；訓練圖固定序列長度，改用常數 | 不需要（不在可訓練路徑上） |

  **誠實的限制**：真模型是 ORT-GenAI 融合圖，不是「通用 ONNX→ONNX 轉換」能直接吃的，必須**先降成基本運算子再微分**（上表第 1–4 列的降級）。降級是 Qwen3 專用的型樣辨識（依運算子與權重命名），不是任意模型通用；換架構要加新型樣。
- **對真 Qwen3 單一區塊的對拍（階段 2）**：見下方「階段 2 狀態」。

**階段 2 狀態（2026-11-11，真 Qwen3 第 0 層，`model_quantized.onnx`）**：`qwen3_graph.js` 從真模型讀出 uint8 權重（整張量縮放與零點，不是逐欄）、RMSNorm 增益、q_norm／k_norm、cos／sin 快取，建出含 7 個 LoRA 目標（q／k／v／o／gate／up／down）的區塊訓練圖（276 節點、14 個可訓練張量、T=8、rank 8）；`scripts/qwen3-block-check.js` 對拍（Electron 內建 node 執行）：

| 檢查 | 結果 |
|---|---|
| 梯度正確性：圖產生的梯度 vs 獨立的有限差分（fp64 直譯器，28 個抽樣） | 最大相對誤差 **4.6e-7**（門檻 1e-3） |
| 真 ORT-web 1.22.0（WASM，fp32）執行同一張圖 vs fp64 直譯器 | loss 相對誤差 5.4e-7；14 個梯度最大相對 L2 誤差 **2.1e-6** |
| 速度：ORT-web WASM 單執行緒，一個區塊前向＋反向（T=8） | 約 **95 ms**（暖機後）；外推 28 層約 2.7 秒／步（不含詞表輸出頭與逐層重算）。這是 WASM 單執行緒的下限數字，WebGPU 未測 |
| 前向對真模型：同樣 token 的第 0 層 key（含 k_norm＋RoPE）／value 對真模型輸出 `present.0.key／value` | key 相對 L2 誤差 **1.6e-2**、value **5.2e-2**。結構（RMSNorm、rotate-half RoPE、快取表索引）若有錯會是 O(1) 級誤差，所以這個量級是**激活 8 位元動態量化與浮點直通的差**；但我**沒有**把量化雜訊隔離量測（要在 ORT 內把激活量化加回圖才能證明），所以只能說「與量化雜訊一致」，不能說「已證明相同」 |

階段 2 **未涵蓋**：(1) 區塊內 q／GQA／前饋對真模型的前向沒有直接對照（真模型只在最後輸出 logits，中間節點取不出來；已被「梯度對有限差分」與 key／value 對照間接支持）；(2) 只做第 0 層、T=8；全 28 層、詞表輸出頭（151936 維，logits 297MB @T=512）、交叉熵損失圖、逐層檢查點、長序列都未做；(3) 激活量化的直通差距對訓練品質的影響未量測；(4) WebGPU 執行（缺環境）。

**下一步**：(a) 全模型 28 層＋輸出頭＋交叉熵＋圖內 Adam 的訓練圖，序列長度 64–256，量 WASM 與（有環境時）WebGPU 的步時間與記憶體；(b) 逐層梯度檢查點在 IR 層實作；(c) 與 `train_lora.py` 同資料同初始值的 loss 曲線對拍（需 torch 與 Qwen3 權重，需使用者另行同意下載超過 100MB 的權重）；(d) 若 (a) 量到步時間不可接受，才啟動下面的執行層編譯器。

**退路（正式需求）：網頁版小型編譯器，用 WebGPU／WASM 自己做訓練與產圖**

使用者最差狀況的要求：若「反向圖＋一般 onnxruntime-web」卡在算子或效能，就在網頁版自己做編譯器。**現在就把主攻路線做成它的前半段**，避免做兩次：

1. **輸入表示**：就是 `onnx_grad_core.js` 的靜態形狀圖 IR（節點＝運算子名＋輸入輸出張量＋屬性；張量＝名稱＋形狀＋dtype）。ONNX 與自訂來源都先轉成這個 IR；已有 `toOnnx` 可輸出給 ORT，編譯器則從同一份 IR 出發。
2. **運算子清單**：IR 的 17 個基本運算子（上面列的）；編譯器的第一版只支援這個集合，與主攻路線相同。
3. **反向規則表**：就是 `RULES`（運算子名＋形狀的純函式，輸出仍是 IR 節點），**編譯器直接重用**，不另寫第二份。
4. **WGSL 產生**：每個運算子一個著色器模板（元素逐項、廣播、Softmax／歸約、批次 MatMul 用分塊共享記憶體 16×16 或 8×8 tile、DequantizeLinear 融合進 MatMul 的載入段以省掉 f32 權重展開）；相鄰逐元素運算子融合成一個核心。WASM 路徑：同一份 IR 用 SIMD 核心（MatMul、Softmax、歸約），給沒有 WebGPU 的環境。
5. **記憶體規劃**：IR 是靜態形狀，所以編譯時做活躍區間分析（每個張量第一次寫入到最後一次讀取），用區間著色重用同一塊緩衝區；權重緩衝區分塊（受 `maxStorageBufferBindingSize` 限制）；逐層梯度檢查點在 IR 層做（把前向段標成可重算子圖）。
6. **排程**：拓撲序即可；單一命令編碼器內分派，每步一次提交；歸約與 MatMul 之間用儲存緩衝區屏障。
7. **與 ORT 路線共用**：IR、建構器、規則表、降級（融合運算子→基本運算子）、直譯器（正確性規格）、對拍測試全部共用；只有「執行層」不同（ORT 或自家 WGSL／WASM）。因此切換條件明確：**階段 2 若在真區塊上量到 ORT-web 的步時間或記憶體不可接受，才啟動執行層編譯器**，不必重做前面。
8. **目前阻礙／未驗證**：WGSL 著色器尚未寫；WebGPU 在本機未驗證（缺有 WebGPU 的瀏覽器環境）；效能數字全是估算（見上節）。

#### 結論與建議

1. **最短可用路線＝沿用 `cpu-py`（桌面版）做 LoRA 訓練；網頁版維持不能訓練**，直到下面的 WebGPU 路線做出實測數字。理由改成具體阻礙：沒有一條現成方案同時支援 Qwen3＋瀏覽器＋q8＋可用速度（rullama 只支援 Gemma 4；ORT 網頁訓練只有 WASM 且官方訓練套件已棄用；tensorgrad 只有 f32 無 LoRA；Burn／TensorFlow.js 沒有 Qwen3 實例）。
2. **網頁版最有希望的路線＝WebGPU 反向引擎，範圍比先前想的小，且已有正確性基準**：`lora_ref_train.js` 是可對拍的規格，rullama 的算子清單（矩陣乘反向、RMSNorm、RoPE、注意力 dQ／dKV、交叉熵、Adam）是現成參考；tensorgrad 可用來快速驗證「小模型 LoRA 在 WebGPU 跑得通」，免去先寫全部著色器。
3. **分階段與工作量（單人估，含對拍與除錯）**：
   - **A（約 2–3 天）**：用 tensorgrad 或手寫 WGSL，把假模型搬上 WebGPU，與參考實作比對損失與梯度（目標 1e-4 相對誤差），量每步時間。**缺：有 WebGPU 的瀏覽器環境；若用 tensorgrad 還缺該套件下載。**
   - **B（約 1 週）**：f16／q8 權重分塊綁定、GQA、q／k norm、RoPE 與 Qwen3 的形狀；用真實 0.6B 一層對拍 `train_lora.py` 同層梯度（目標 §5.7 的 1e-3）。**缺：torch 與 Qwen3 權重。**
   - **C（約 1–2 週）**：全模型一步、逐層檢查點、分塊損失、裝置遺失續跑；量 token/s 與峰值記憶體，才決定要不要點亮 `webgpu` 後端。
   - **備案**：Tapasya 式進化策略（只要前向，可用已驗證的推論路徑）；但樣本效率與收斂沒有證據，只在 A–C 失敗時評估。
4. **下一步**：先做 A；取得 WebGPU 環境與使用者同意下載後再進 B。任一階段沒過就停下回報阻礙，不往下硬做（維持 §5.7）。
5. **待查證**：(i) `onnxruntime-web` npm 上是否仍有 `training` 子模組與其 wasm 體積（只需查 npm 中繼資料，不需下載套件）；(ii) rullama 的 `rullama-lora` 與 `rullama-finetune` 哪個是現行套件；(iii) 表中標「未驗證」者。

來源（2026-11-11 查閱）：ORT 瀏覽器訓練部落格 <https://opensource.microsoft.com/blog/2024/02/06/on-device-training-training-a-model-in-browser>；官方文件 <https://onnxruntime.ai/docs/get-started/training-on-device.html>、<https://onnxruntime.ai/docs/tutorials/on-device-training/>；ORT 1.20.0 發行說明（棄用訓練套件）<https://newreleases.io/project/npm/onnxruntime-web/release/1.20.0>；Burn <https://docs.rs/crate/burn/latest/source/src/lib.rs>；rullama <https://github.com/Brainwires/rullama>、<https://docs.rs/crate/rullama/0.5.0>；tensorgrad <https://www.pkgstats.com/pkg:tensorgrad>；Tapasya <https://naklitechie.github.io/Tapasya/>；tinygrad WebGPU 推論範例 <https://huggingface.co/jik-wtf/tinygpt-webgpu>；TensorFlow.js WebGPU 後端 <https://www.npmjs.com/package/@tensorflow/tfjs-backend-webgpu>。

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

使用者要求：「網頁版也要可以支援LoRA。沒有託管的話有沒有辦法網頁版做到下載並在網頁上量化，或者只能切片並放入 branch」「如果支援需要修改transformer.js原始碼，請修改」。結論先講：**選路線 c（載入時把 LoRA 併進 q8 權重）已實作**；不需要託管槽版、不需要切片、不需要修改 transformers.js 原始碼。真模型＋真 ORT（桌面版執行包的 onnxruntime-node）已驗證載入與位元相同性，**但瀏覽器 WASM／transformers.js 與任務層級的準確度尚未實測**（見 §14.2）。

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

**採用的做法（細格＋抖動）**：(1) 每個輸出欄各自一個縮放值：新步距＝舊步距／k，k 取「該欄權重範圍仍塞得進 8 位元」的最大 **2 的冪**（上限 64；合成實驗用整數 k 平均約 11，真模型限 2 的冪後平均 2.55，見 §14.2）；因為 k 是 2 的冪，舊權重剛好落在新格點上且 32 位元浮點運算精確，基底位元相同。(2) 變化量以新步距為單位，用「抖動式四捨五入」（加固定種子的均勻亂數再取下整）：期望值不偏，即使遠小於一格也不消失。(3) 計算圖裡縮放值只參與 Mul（廣播），把純量改成長度 dout 的向量不用改圖；零點維持純量不動（不用每欄零點，避開 ORT 對逐欄零點的支援差異）。(4) 零 adapter 時併入結果與基底逐值相同（測試涵蓋）。

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

#### 14.2 真模型＋真 ORT 驗證結果（2026-11-11，用管理者下載的 `model_quantized.onnx`，617,687,575 位元組）
環境：Electron 的 Node（x64，Node 24，不開視窗）＋原生執行包 1.22.0-1 的 onnxruntime-node；adapter 是**隨機**的 rank 16 adapter（沒有真的訓練出來的 adapter 可用），輸入是隨機的詞元序列。**這不是網頁版 WASM 實測**（沒有在瀏覽器跑，也沒有經過 transformers.js），只驗證模型檔本身與 ORT 的行為。

**查到並修掉的真模型差異（假模型測不出來）**
1. 縮放值與零點存放在 `float_data`／`int32_data`，不是 `raw_data`：讀取器已支援。
2. q／k／v 三個目標**共用同一個輸入縮放**，原本靠輸入縮放找「這個目標的縮放 Mul」會把 k、v 的縮放全指到 q 的，換成錯的長度後 ORT 拒絕載入（`Mul … Incompatible dimensions`）。已改成沿資料流（MatMulInteger → Cast → Mul ← Mul）找，假模型也改成同樣的共用結構，測試能抓到這個錯。
3. **k 只能取 2 的冪**：k=3 這類非 2 的冪，數學上完全等價（零 adapter），輸出卻明顯偏掉（15 個詞元、116 個位置：平均 KL 0.11、top-1 一致率 0.75）；2 的冪則與原模型**位元相同**（KL 0、一致率 1.0）。原因判斷是 q8 動態量化的模型對浮點末位的差異很敏感（逐層二分已把偏掉的來源收斂到 k=3 的欄位，其餘 k 值全部精確）。已改成只取 2 的冪，代價是細格平均 k 從 3.09 降到 2.55。

**已證實**：真 ORT 能載入併入後的模型（縮放值為 [dout] 向量）；196 個目標全部找到並併入；只換縮放值不動權重時輸出與原模型位元相同（含關閉圖最佳化）；零 adapter 位元相同。

**實測數字（15 個詞元；Node 24 x64）**
| 項目 | 數字 |
|---|---|
| 併入耗時 | 約 63～73 秒（196 層，與外推的 77 秒相符） |
| 模型載入（ORT） | 約 1.5～2.3 秒；15 個詞元前向約 2～2.9 秒 |
| 併入後模型大小 | 619,064,223 位元組（比原檔多 1,376,648 位元組＝縮放向量） |
| 程序記憶體 | 讀檔後約 0.6 GB；併入加載入 ORT 後約 1.4～2.5 GB（同一程序連續多次，含尚未回收的舊副本；單次峰值未單獨量，網頁版 WASM 預期更高） |
| 每張量輸出相似度（真權重，變化量 0.5%） | 平均 0.960、最低 0.932 |
| 同上（2%） | 平均 0.994、最低 0.987 |
| 同上（5%，k 未限 2 的冪的版本） | 平均 0.999、最低 0.998 |

**無法分辨的部分（誠實寫出）**：對隨機 adapter、隨機詞元序列，併入後整體輸出與原模型的差距（KL）：變化量 1e-9 → 0.075；1e-4 → 0.24；1e-3 → 0.26；0.5% → 0.27；2% → 0.30；兩種抖動種子互比 0.27。也就是**只要基底不是位元相同，這個 q8 模型的輸出就會被推到 KL 0.25 左右的雜訊底線，與變化量大小幾乎無關**，所以這組實驗**無法證明或否定「併入結果接近真正的 LoRA 分支」**：沒有分支版本可比（槽版需要 Python 的 onnx 套件，本機沒有），而且分支版本相對於原模型同樣會落在這個底線上。同樣的敏感度意味著桌面版（原生分支）與網頁版（併入）、甚至不同 CPU 指令集之間，輸出都可能不位元相同。需要用**真的訓練出的 adapter**、**自然語句**、**任務層級的指標**（例如該 adapter 的評量集分數，或在固定提示下輸出是否符合訓練目標）來比較「原模型／桌面分支／網頁併入」三者，這一步還沒做，是 §14.1 路線 c 目前最大的未驗證項。
**其他未驗證**：瀏覽器 WASM 的 ORT 與 transformers.js 的 fetch 攔截、WebGPU 都沒測；網頁版記憶體峰值。
