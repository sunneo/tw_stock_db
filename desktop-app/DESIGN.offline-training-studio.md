# 離線訓練工作室（`/offline-training-studio`）完整設計

> 文件性質：**整合版**，依「讀者想知道的順序」重排。2026-11-13 寫成，分支 `claude/studio-design-doc`（基底 `desktop-app` 的 `8176dbc5`）。
> 取代：`DESIGN.TODO.offline-training-studio.md`（§1–§26，時間序的原始紀錄，仍保留作為歷史與證據來源）。下列舊檔仍在，但以本檔為準：`DESIGN.lora-training.md`、`DESIGN.offline-trainer.md`、`DESIGN.offline-trainer-roadmap.md`、`DESIGN.offline-harness.md`、`DESIGN.native-all-models.md`。
> 本檔的狀態標記：**已實作並驗證**（有實測或真環境紀錄）、**已實作未驗證**（有程式與單元測試，沒有真環境跑過）、**設計未做**（只有設計或阻礙已寫清楚）。數字若標「推算」或「未量測」，代表不是實測。
> 本檔**沒有重跑任何測試**，所有狀態來自各舊檔的紀錄（出處列在 §10）。

---

## 1. 目標與使用者角色

### 1.1 要解決的問題
線上 AI 連不上、或使用者選了離線模式時，助理仍要能做事。離線模型要能「學會」使用者的任務，而且訓練出來的東西**屬於使用者**，可以保存、暫停、搬到別台、再接著訓。

### 1.2 目標（原則）
1. 一個 GUI：`/offline-training-studio`，網頁版與桌面版都能開。
2. 支援七類訓練：**LoRA**（低秩適應，語言模型的小型附加權重）、**blockly**（程式積木題）、**matrix**（矩陣演算法）、**uml**（UML 設計）、**colu**（工具排序模型）、**trainer**（符號式離線訓練器）、**工作室自身**（資料集與評量），外加 **LLM 匯出**（合併後輸出 ONNX 或 GGUF）。
3. 訓練產物是**使用者自己的資產**，可存在使用者授權的資料夾（fap）或瀏覽器的 IndexedDB，可暫停、匯出、匯入、續訓。
4. 資產可放進 repo 指定資料夾，經腳本處理後 commit 成**內建**資產（§7）。
5. 老師迴圈：線上 AI 以老師身分**擴充資料集**，不直接改權重；每筆資料要經程式驗證才收（§7.3）。
6. LoRA 訓練盡量跑在本機 CPU，或瀏覽器內的 WebAssembly／WebGPU；做不到的要誠實分層說明（§4）。

### 1.3 使用者角色
| 角色 | 會做什麼 | 介面 |
|---|---|---|
| 終端使用者 | 匯入資料、開始訓練、看評量、暫停續訓、匯出、註冊與移除 LoRA、選離線模型 | 工作室視窗（§6） |
| 老師（線上 AI） | 依缺口產生候選資料，由程式驗證後才收 | 老師分頁（§7.3），白名單工具 |
| 管理者（repo 維護者） | 把資產打包進 `builtin-training/`、重產嵌入、發布熱更新、管理執行包 | `scripts/training-studio.js`、`scripts/publish.sh`（§7、§9） |

---

## 2. 整體架構

```
┌──────────────────────── 瀏覽器（渲染程序，floating-assistant.js 嵌入）────────────────────────┐
│  工作室視窗（沙盒 iframe，假伺服器 mock.local，postMessage 通訊）                              │
│    ├ 分頁：資產／LoRA 登錄／資料匯入／資料集／評量／訓練／老師／流程／紀錄                    │
│    └ 假伺服器 studio_server_core.js（路由；純函式，依賴注入）                                 │
│  頁內宿主 h.webTrain / h.loraApply / h.llmWeb（網頁版與桌面版共用的瀏覽器端能力）             │
│    ├ webtrain_worker_core.js（Worker：WebAssembly 逐層訓練、onnxruntime-web 1.22.0）          │
│    ├ swap_store.js（IndexedDB：fa-train-swap、fa-train-ckpt）                                  │
│    └ lora_web_core.js（網頁版 LoRA：把 B·A 併進 q8 權重，攔截 fetch）                         │
└──────────────┬───────────────────────────────────────────────────────────┬──────────────────┘
               │ 桌面版：原生信箱 studio_*（main-ext.js，不改 preload／main.js）                    │
┌──────────────▼──────────── 桌面版主行程（Electron main，studio_host.js 內嵌）─────────────────┐
│  後端登錄 backend_core.js、基準 bench_core.js、檢查點 checkpoint_core.js                         │
│  cpu-py：子行程 lora-train/train_lora.py（PyTorch，CPU，nice 19）                              │
│  匯出：子行程 optimum／llama.cpp（llm_export_core.js 的步驟表）                                 │
│  原生推論：nr-engine.js（onnxruntime-node，執行包 native-runtime/<版本>）                        │
└──────────────────────────────────────────────────────────────────────────────────────────────┘
資產 kind：colu｜blockly｜matrix｜uml｜trainer｜lora｜llm（asset_core.js）
儲存：IndexedDB（記憶體）＋ fap（使用者資料夾）；可攜格式 .fatrain（zip）、.fackpt（續訓檢查點）
```

關鍵分層：
- **純核心**：全部是 UMD（Node 與瀏覽器都能載入）的純函式，測試用 Node 跑；`floating-assistant.js` 只做接線。
- **後端介面**（§4.3）與**訓練核心**分離：資料游標、損失、排程、檢查點、評量都在核心，後端只負責 `step`。
- **嵌入**：`scripts/embed-code-ui.js` 把核心模組包成 IIFE 嵌進 `floating-assistant.js`；桌面版主行程的 `studio_host.js` 等檔以 `FA_STUDIO_HOST_FILES` 寫到 `<userData>/studio-host/`。**改了核心要重產嵌入，`studio_embed.test.js` 才會綠**（§10）。

---

## 3. 資產模型與儲存

### 3.1 資產格式（`asset_core.js`）
所有產物收斂成同一種可攜資產 `fa-training-asset`：

```
asset/
  manifest.json   {format, version, kind, name, created, parent?, base?, compat, counts, eval, sha256:{檔→雜湊}, owner:'user'|'builtin'}
  data/           資料集（jsonl，各領域原生格式）
  state/          續訓狀態（檢查點，見 §3.4）
  weights/        產物（LoRA 分片 ≤20 MB、規則包、課程包、llm 的 ONNX／GGUF 外部檔）
  log.jsonl       訓練紀錄
```

| kind | 資料集 | 產物 | 狀態 |
|---|---|---|---|
| `trainer` | 成功案例、未解決紀錄 | 規則、語意模式、FSM、JS 工具（`_otBundleExport`／`_otBundleImport`，格式 `fa-offline-trainer` v2） | 已實作並驗證（核心 `sym_suites_core.js`、`sym_studio.test.js` 71 項） |
| `colu` | 採用／拒絕標註、體檢結果 | 排序模型（`rank_train.js`）、`coluProfile` | 已實作並驗證（留一組交叉驗證 F1，`sym_train_core.js`） |
| `blockly` | 題目與課、領域包 | 課（`deriveLesson`）；題目資料檔 `renderer/src/uml/seeds/domain_*.json` 共 21 檔、428 題（留存 120） | 題目搬進資料檔已實測（§26.1）；App 內判題未驗（§11） |
| `matrix` | 輸入輸出範例 | 範式（L0–L6 求解參數） | 已實作；評量在真 Electron 以真 Python 判題器 6/6 通過（§15.5） |
| `uml` | 情境與設計對 | 詞彙補強資產 | 已實作核心；**阻礙**：`uml_core` 的詞彙與模板是常數表，執行期無擴充接口 |
| `lora` | `lora-train/schema.md` 統一 JSONL | `adapter_model.safetensors` 分片＋`manifest.json`＋`model_card.json`（§6.5） | 已實作並驗證（§6.5、§10） |
| `vision` | 圖文問答（`lora-train/vlm/`，JSONL：`image`＋`messages` 兩則，`vlm_data.py` 校驗） | SmolVLM-256M 的 LoRA 小檔（`adapter_model.safetensors` 約 9.8 MB，2.44 M 參數，0.94%）；併回基底的完整模型（safetensors 約 1.03 GB，fp32） | **半成品（2026-11-13 改為半成品，原為只有設計）**：命令列訓練、評量、併回匯出都已實測（`DESIGN.lora-training.md` §34）；工作室的訓練按鈕、資料匯入、資產化與網頁版執行**未接**，所以 `model_types_core.js` 的輸出都是 `available:false`。 |
| `llm` | 不需要（產物即模型） | 匯出的 ONNX q8／fp32、GGUF Q8_0 外部檔，manifest 內 `llm{format,quant,recipe}` 與 `external{路徑:{bytes,location}}` | 部分（§13.4） |

### 3.2 儲存位置
- **記憶體**＝IndexedDB。注意：沿用 aiDoc 的 `FileCache` 會被 LRU 淘汰，**訓練資產不能只放 FileCache**（`DESIGN.project-index.md` §15.5 的教訓）。訓練用的交換空間是專屬資料庫（§3.3），不做 LRU。
- **fap**＝使用者授權的資料夾。網頁版用 `showDirectoryPicker` 的 handle（持久化於 IndexedDB `fa-file-handles`，重新授權需要手勢，所以開始長任務前要先取得）；桌面版直接用絕對路徑（`window.desktopAPI.rawfs`）。路徑慣例：`<fap>/.floating-assistant/training/<kind>/<name>/`。
- **寫入兩處**：有 fap 授權時 fap 為權威、記憶體為快取；沒授權就只在記憶體，UI 明說「瀏覽器資料被清掉會遺失」。
- **二進位寫入**：只能用 `_writeFapFileBytes`（`floating-assistant.js`）或 `rawfs`。`_fapReadFile`／`_fapWriteFile` 只處理文字，會拒絕二進位。

### 3.3 交換空間 `swap_store.js`（已實作並實測）
用途：網頁版逐層訓練把每一層的計算圖存在 IndexedDB，需要時才取出建立工作階段，用完釋放，讓 WebAssembly 記憶體只需容納一層（見 §12，提案 A）。

| 設計 | 內容 | 出處 |
|---|---|---|
| 專屬資料庫 | `fa-train-swap`（層圖）、`fa-train-ckpt`（檢查點），不和 aiDoc 共用 | `swap_store.js` 檔頭 |
| 不做 LRU | 悄悄淘汰會讓下一步失敗或用錯權重；超過配額丟 `SwapFullError`（帶已用、要存、配額），訓練停止、舊資料保留 | 同上 |
| 校驗 | 每筆記錄長度與 FNV-1a 校驗；讀回不符丟 `SwapCorruptError`。大於 4 MB 的檔案抽樣校驗（每 17 位元組取一），目的是抓截斷與寫壞，**不是密碼學校驗** | 同上 |
| 配額 | 預設 4 GB（程式碼）；網頁訓練設定 swap 3 GB、ckpt 2 GB（§5.6 階段 8） | `webtrain_worker_core.js` |
| 後端 | `createIdbSwap`（瀏覽器）、`createMemorySwap`（測試與無 IndexedDB 環境） | 同上 |

**實測**（真 IndexedDB，`swaptest.html`，§5.6 階段 4–6）：57 筆、每筆 18 MB，寫入 3.4 秒、讀回 4.9 秒、0 筆損壞；配額 1100 MB 時再寫 200 MB 被明確拒絕，舊資料完好。由此換算：寫入約 300 MB/s、讀回約 210 MB/s（推算，來自上述兩個數字）。瀏覽器估計配額約 245 GB（同一台機器的估計值）。

### 3.4 可攜的續訓檢查點（與後端無關）
```
state/ckpt.json   {format:'fa-ckpt', version:1, step, epoch, dtype:'float32',
                   cursor:{shard, offset, order_seed, consumed_tokens}, rng:{seed, algo:'pcg32', state},
                   optimizer:{kind:'adamw', lr, betas, eps, wd, step_count, schedule}, data_sha256,
                   compat:{base, base_sha256, rank, alpha, target_modules, prompt_format_version, tool_catalog_sha256},
                   produced_by:{backend, device_fingerprint, engine_version, precision}, loss_tail, sha256:{檔→雜湊}}
state/lora_A.f32、lora_B.f32、opt_m.f32、opt_v.f32   規範化 float32（依層名排序，檔頭有 shape 表）
```
- **實際實作與設計的差異**（誠實列出）：網頁版與 `wasm-web` 後端已用上述 float32 規範化格式（已實作並驗證，§5.6 階段 7–8，`.fackpt` 是存放式 zip，含 `ckpt.json` 與四個張量檔，**與 `.fatrain` 是同一種容器技術、內容不同**）。桌面版 `cpu-py` 用的是 HF Trainer 原生檔（`adapter_model.safetensors`、`optimizer.pt`、`rng_state.pth`），不是 `.f32`；rng 不是 PCG32；資料游標靠 seed 重現洗牌並跳過已看過的 micro-batch（`lora-train/train_lora.py`，`DESIGN.lora-training.md` §16 的 `differences` 欄位）。
- **續訓相容性**：`base_sha256`、`rank`、`alpha`、`target_modules`、`prompt_format_version`、`tool_catalog_sha256`、`data_sha256`、格式版本、優化器種類，任一不符一律拒絕續訓，提示以新資產 fork（`parent` 記來源）。**不比對後端與裝置**（兩者允許不同，只記錄）。
- **跨後端續訓的數值差異**：不保證逐位元相同。處理方式：續訓開始時用檢查點存的固定 4 筆評估批次在新後端算 loss，相對差 ≤2%（fp16 後端 ≤5%）才繼續；紀錄寫明「由 A 後端暫停、B 後端續訓」與比對結果。門檻是**設計初值**，階段 3 要以真實兩後端對拍校準（§11）。
- **同機續訓**門檻較嚴（§5.7 階段 1：續訓前 20 步 loss 相對差 ≤1e-5）。

### 3.5 傳輸與搬移
| 方式 | 狀態 |
|---|---|
| (a) 匯出 `.fatrain`（zip），自行搬移 | 已實作並驗證：`fatrain_core.test.js` 46 項，含 25 MB 的 llm 資產匯出 2 片（每片 ≤20 MB）、讀回 sha256 與位元組一致（§25.12）；真實 756 MB 的 q8 `.fatrain` 往返 37 片（§25.11） |
| (b) 存到 fap（網路磁碟、雲端同步資料夾），另一台打開 | 設計內，未實測（只有一台機器） |
| (c) 區網或遠端點對點傳送（需配對碼，只在使用者按下「傳送」後啟動） | **設計未做**；安全設計（配對、加密）未設計（§11） |

網頁版與桌面版互相匯入：格式相同。網頁版匯入後只能續訓它有可用後端的部分（目前是 `wasm-web`）。
同一瀏覽器內的「匯出續訓檢查點 → 另一個 store 匯入 → 續訓」已實測（§5.6 階段 8，真 Electron 頁面，60,636,714 位元組的 `.fackpt`）。

---

## 4. 運算後端與選擇規則

### 4.1 原則
- **誠實**：每個後端都寫清楚「現在做得到什麼、做不到什麼、阻礙是什麼、解除條件」。做不到就寫做不到，**不寫成「刻意不做」**。
- 符號式五類（trainer、colu、uml、blockly、matrix）本來就是純 JavaScript 計算，只宣告 `cpu-js`。沙盒驗證走判題器（桌面版 `judge-runner.js`，需要 Python ≥3.11 與 tree-sitter 快取；網頁版是否有可用沙盒未查證）。
- 後端下拉選單只對 `lora` 有意義；其他 kind 顯示「只需處理器」並灰掉。

### 4.2 後端清單與實測狀態
| 後端 | 推論 | 訓練（LoRA 反向） | 實測數字 | 第一版狀態 |
|---|---|---|---|---|
| `cpu-py`：桌面版 Python 子行程（`train_lora.py`，PyTorch CPU） | 可 | **已可用**。本機（Intel Core Ultra 7 155U，16 GB）實測約 60 token/s；4141 筆資料約 200 萬 token，一個 epoch 約 9–10 小時（`DESIGN.lora-training.md` §1、本檔 §5.4 的推算） | 60 token/s（訓練）。暫停續訓實測（真 PyTorch，§16）：步 4–6 的 loss 與未中斷的相同（小數六位） | **已實作並驗證**（需要 Python ≥3.11 與 torch、transformers、peft；本機 Python 3.10.12 不達標，§10） |
| `wasm-web`：網頁版或桌面渲染程序內的 WebAssembly（onnxruntime-web 1.22.0，單執行緒） | 可 | **可用但很慢**：整張 28 層大圖約 11.9 秒/步（T=32，≈2.7 token/s）；逐層常駐約 16.5 秒/步；逐層加 IndexedDB 交換約 26 秒/步 | 30 步對拍 PyTorch 參考，loss 最大相對差 5.3e-4（§5.6 階段 7） | **已實作並驗證**（頁內宿主，真 Electron，14 項檢查全過，§5.6 階段 8） |
| `webgpu`：瀏覽器 WebGPU（同一套 ONNX 圖，執行提供者換成 WebGPU） | 可 | 可用，逐層實測 10–12 秒/步（T=32，**一張舊的 Kepler 世代顯示卡**，無 `shader-f16`）；第一步含 57 個工作階段與著色器編譯約 59–72 秒 | 與 WASM 的 loss 最大相對差 1.6e-5（前 8 步），30 步內最大 2.8e-4 | **實作並在一張卡驗證；Studio 介面仍灰**（頁內宿主只接了 `wasm-web`，§5.6 階段 8） |
| `directml`（Windows） | 可，但 qwen3-0.6b 在 `SkipSimplifiedLayerNormalization` 節點已知失敗（ORT 1.22.0 與 1.31.1 皆然，`DESIGN.TODO.native-runner.md:273,321,416`） | **做不到（目前）**：ORT 的 DirectML 執行提供者是推論用；`torch-directml` 最新輪子約 2024-06，釘在 PyTorch 2.2，未驗證能否跑 LoRA 反向 | — | **設計未做**（解除條件見 §4.4） |
| `vulkan` | 可（llama.cpp 的 Vulkan 後端是成熟推論路線） | 有一條可能路線（Tether QVAC 研究頁稱 llama.cpp 加入 LoRA 微調流程），**上游主線、Qwen3 相容、算子覆蓋都未確認** | — | **設計未做** |

補充：本檔引用的兩份舊紀錄對本機硬體描述不一致（§5.6 階段 4–6 寫處理器為 Core i5-2320、顯示卡為 NVIDIA Kepler；§1 與 §5.2 寫為 Core Ultra 7 155U、沒有 NVIDIA）。本檔**不替它們選邊**，兩組數字都標明是哪一次量測（§11）。

### 4.3 後端介面（`backend_core.js`，已實作並驗證）
```
Backend {
  id            // 'cpu-js' | 'cpu-py' | 'wasm-web' | 'webgpu' | 'directml' | 'vulkan'
  probe()       -> {available, reason?, device, fingerprint}   // 不丟例外；reason 給使用者看（例如「找不到 Python」「此瀏覽器沒有 WebGPU」）
  benchmark(cfg,{signal}) -> {tokPerSec, peakMemBytes, stepMsP50, stepMsP95, numericCheck, samples}
  init(assetState|null, cfg) -> handle
  step(handle, batch) -> {loss, gradNorm}
  evalLoss(handle, batch) -> {loss}
  saveCheckpoint(handle) -> CheckpointF32     // 一律交出規範化 float32
  loadCheckpoint(handle, CheckpointF32)
  dispose(handle)
}
```
每個 kind 宣告支援的後端（寫在登錄表）：符號式五類 `['cpu-js']`；`lora` `['cpu-py','wasm-web','webgpu','directml','vulkan']`（依各後端實際點亮狀態動態可用）。訓練核心是狀態機（待機→執行→暫停→完成／失敗），以「步」為單位在可中斷點寫檢查點；後端失敗時由核心降級（§4.5）。

### 4.4 研究項的阻礙與解除條件（`backend_planned.js`）
- **webgpu**（網頁版純瀏覽器訓練）的路線比較與數字見 `DESIGN.TODO.offline-training-studio.md` §5.6。摘要：**沒有現成方案同時滿足 Qwen3、瀏覽器、q8、可用速度**（rullama 只支援 Gemma 4；ORT 網頁訓練只有 WASM 且官方訓練套件已棄用；tensorgrad 只有 f32 無 LoRA）。目前的路線是自己產生 ONNX 反向圖（純 JavaScript，`onnx_grad_core.js`），與 onnxruntime-web 執行，**不依賴 Python 或 ORT 訓練版**。
- **directml／vulkan**：解除條件是「在隔離資料夾跑通一個小 LoRA 優化步，並與 `cpu-py` 對拍（門檻見 §4.6）」。需要使用者同意下載（§5.7 階段 5）。

### 4.5 自動選擇與降級
1. 候選＝`probe` 可用且基準測試「數值一致性通過」的後端。
2. 從候選選實測 token/秒最高者；差距 <10% 時偏好較成熟者（`cpu-py` > `vulkan` > `directml` > `webgpu`）。
3. 基準測試結果**快取**，含硬體指紋（CPU 型號與核數、顯示卡名稱與驅動版本、WebGPU 的 adapter 資訊、後端引擎版本、模型 sha256）；指紋任一項改變即失效並提示重測。
4. **失敗自動降級**：訓練中後端失敗（裝置遺失、記憶體不足、NaN）→ 存檢查點 → 降到下一個候選 → 續訓，並在 `log.jsonl` 與畫面寫明原因與 step。降級續訓走 §3.4 的跨後端比對。
5. **使用者可釘選**後端：釘選後不自動換，失敗時停下並詢問，不悄悄降級。

狀態：`bench_core.js` 的快取、自動選擇、降級、釘選有單元測試（已實作並驗證於核心）；**App 內的端到端基準與降級未驗證**（§10）。

### 4.6 基準與一致性測試
- 基準：固定種子、16 筆樣本、序列長度 256、批次 1、30 步（先 3 步暖機不計）；輸出 token/秒中位數、步時間 p50 與 p95、峰值記憶體。整體上限 60 秒，超時中止並標「太慢」。
- 一致性（以 `cpu-py` 為參考）：第 1 步 loss 相對差 ≤1e-3；第 1 步後梯度範數相對差 ≤1e-2；30 步後 loss 相差 ≤3%（fp16 後端放寬到 5% 並標明）；全程無 NaN、Inf。**四項全過才標通過**，才可被「自動」選用。
- 這些門檻是**設計初值**，要以真實測量校準後再固定（§11）。實測紀錄（§5.6 階段 7）：第 1 步 loss 相對差 ≤3e-7，梯度範數 ≤1.1e-3，30 步 loss 最大相對差 WASM 5.3e-4、WebGPU 2.8e-4，全部在門檻內。**但對照的 PyTorch 參考用的是隨機 token 序列，沒有用真實訓練資料驗證收斂。**

### 4.7 網頁版 LoRA：併入權重（已實作，部分驗證）
- 做法（路線 c，`DESIGN.lora-training.md` §14.1）：載入時攔截 `fetch`，把 LoRA 的 B·A 併進標準 q8 權重（每欄一個縮放、細格化與抖動），**不需要託管槽版、不需要改 transformers.js 原始碼**。
- 併入的數值設計：細格（每欄 k 取 2 的冪，上限 64）＋抖動式四捨五入；零 adapter 時結果與基底位元相同（測試涵蓋）。
- 實測（真模型 `model_quantized.onnx`，617,687,575 位元組，Node 24，**不是瀏覽器**）：併入 63～73 秒（196 個目標）；ORT 載入 1.5～2.3 秒；每張量輸出相似度（變化量 0.5%）平均 0.960、最低 0.932。**但**：隨機 adapter 的整體輸出 KL（發散量）約 0.24～0.30，且與變化量大小幾乎無關（§14.2），所以**無法證明併入結果接近真正的 LoRA 分支**。
- 限制（誠實列出）：只對 `qwen3-0.6b` 的 CPU（WASM）q8 檔有效；有 LoRA 時強制 CPU；同時只能套一個 adapter；瀏覽器內的 WASM／fetch 攔截、WebGPU 都未實測。

---

## 5. 訓練種類逐一說明

每一類的資料、產物、評量與狀態：

### 5.1 LoRA（大型語言模型的附加權重）
- **資料**：`lora-train/schema.md` 統一 JSONL（`messages`＋`completion`，或 `chosen`／`answer`，或已分詞的 `ids`／`tgt`）；工作室側轉成 `{ids, tgt}`，只對答案 token 算損失（遮罩）。
- **訓練**：桌面版 `cpu-py`（PyTorch，§4.2）；網頁版 `wasm-web`（§4.2）。
- **產物**：`adapter_model.safetensors` 分片（≤20 MB），`manifest.json`（base、rank、`prompt_format_version`、`tool_catalog_sha256`、評量），`model_card.json`（§6.5）。
- **評量**：`eval_run.py` 分組（基底與微調同批），上線門檻，退步列出。
- **狀態**：訓練與續訓已驗證（§4.2）；**套用到推論**：桌面版已驗證（§5.2、§10）；網頁版併權重只有假模型與 Node 驗證（§4.7）。
- **已量到的品質**（以下是單一 adapter、單次量測，**不是統計結論**）：
  - `toolcall-r4`（rank 4，v1 權重，79 步，1,301 列）在留出 552 列（v2 判準，預先登記，§24）：格式合法率 111/202 → 156/202（+22.3 個百分點）；缺工具拒絕 0/55 → 53/55；範圍內無組別退步（依判準，`toolwire/wiring` 只少 1 列）；**範圍外（colu、think_stack、decompose）未量**。
  - 四顆產品視窗實測（每題型 3 題，§27.2）：decompose 格式 0/3 → 2/3；toolcall 參數正確 0/3 → 2/3；colu 與 plan 的內容仍錯。
  - 四顆同時套用（rank 4×4＝16，剛好填滿槽）：生成品質崩壞（§27.3），**多 adapter 串接在目前版本不可用**。

### 5.2 blockly（程式積木題）
- **資料**：題目與課。題目已搬進資料檔 `renderer/src/uml/seeds/domain_*.json`（`fa-domain-seeds` v1，每題有 `tests` 6 筆與 `hidden` 2 筆，21 個領域檔、428 題、留存 120）（§26.1，實測：`domain_harness.js` 的 `loadSeeds`，algo2 60/0、dsp 72/0、sync 32/0 通過）。
- **已知失敗**：par 領域的 12 題（load-span、load-cyc-loads、pick-span 的三種改寫）在 HEAD 與 Python 3.11 都失敗，原因是**領域包缺配方**（程式內容缺口，不是資料檔問題）（§26.6）。
- **訓練**：窮舉＋沙盒驗證收成課（`_pyLearnLesson`）；判題需要桌面版 Python 與 tree-sitter 快取。
- **評量**：乾淨留出（holdout）通過率；holdout 不可教。種子題在 App 內重跑**未做**（§11）。
- **狀態**：核心與資料檔實測（node）已驗證；App 內端到端未驗證（§26.6 三項原因）。

### 5.3 matrix（矩陣演算法）
- **資料**：輸入輸出範例。示範領域是 6 題獨立手寫參考解，2 筆擬合、20 筆隱藏驗證（`sym_suites_core.js`）。
- **訓練**：範式擬合。L0–L3 有真演算法；L4–L6 只有窮舉，**不保證**。
- **評量**：held-out；matrix 評量在真 Electron 以真 Python 判題器 6/6 通過（§15.5）。
- **狀態**：評量已驗證於 Electron；訓練包裝的端到端未在 App 內跑（§16.2、§16.3-5）。

### 5.4 uml（UML 設計）
- **資料**：情境與設計對（`uml_core.js`、`design_core.js`），經 `validateModel` 收錄。
- **產物**：詞彙補強資產。**阻礙**：`uml_core` 的詞彙與模板是常數表，沒有執行期擴充接口（解除條件：加 `extend()`，或由開發者合併）。
- **關鍵事實**：UML 的模板與決策表寫在程式裡，**不是使用者可訓練的資料**。所以 uml 在工作室裡實際只有「資料集（情境→設計對）＋評量」，沒有可儲存的權重，畫面要明說。
- **評量**：5 小題＋3 組合題 × actors／classes／usecases／sequences，程式先讀情境，不問模型。

### 5.5 colu（工具排序模型）
- **資料**：採用／拒絕標註（`feedback_core.js`，上限 1,500 筆）。
- **訓練**：留一組交叉驗證挑 l2、全資料訓練；產物是資產，**不自動換掉使用中的模型**。
- **評量**：排序命中率與留一組 F1；資料不足時寫明缺什麼。內建模型體檢（`coluProfile`）只顯示「已記錄」。
- **狀態**：已實作並驗證（核心測試；§15.1、§15.3）。

### 5.6 trainer（符號式離線訓練器）
- **資料**：成功案例、未解決紀錄；使用者手動升格規則。
- **訓練**：蒸餾（≥3 次重複才升格）、`/teacher-loop`（含回歸與回滾）。先拍前後兩份快照，訓練後可回滾。
- **評量**：離線自己做對的比例、回歸。內建規則自檢（正規式可編譯、工具存在、信心值合法）。
- **設計原則**：先讓離線自己試，做不到才交給 AI；AI 成功後離線要能自己重做並通過驗證，否則回滾（`DESIGN.offline-trainer.md` §1）。
- **狀態**：已實作並驗證（核心）。`DESIGN.offline-trainer-roadmap.md` 的第 3 階段（通用離線文字生成）與第 4 階段（通用推理鏈）**仍是規劃，未實作**。

### 5.7 工作室自身：資料集與評量
- 資料集逐筆編輯已實作並實跑（§23.3）：改、刪（先確認）、新增到尾端；壞行顯示行號並整份不給編；內建資產唯讀；寫回重算 manifest 與雜湊；評量結果標示「可能過期」。（實跑用的是暫存 harness，**不是嵌入版頁面**。）
- 評量分頁（§15.1）：分組評量、基準、退步、上線門檻、留出組只給通過率、改善比較。基準與門檻存在偏好（`evalBaseline`、`evalGate`）。

### 5.8 LLM 匯出（ONNX、GGUF）
- **流程**（`llm_export_core.js`）：合併（LoRA 併入基底）→ 轉換 → 量化 → 核對 → 寫入資產。ONNX 用 optimum 與 `quantize_dynamic`；GGUF 用 llama.cpp（`convert` 與 `quantize` 到 Q8_0）。
- **已實作並實測**（§25.2–25.9，§25.12）：
  - 合併後 HF 與 PEFT 首步 logits 最大絕對差 2.96e-5。
  - ONNX fp32 與 HF 的貪婪 token 96/96 逐字一致（6 題×16 token）。
  - ONNX q8（`full` 配方，所有 MatMul 量化，與官方 q8 同結構）：**首步 logits 餘弦平均 0.922，貪婪 token 39/96（2/6 題全對）**。這**不達標**：量化後的品質與 fp32 有明顯差距（§13.4）。
  - GGUF Q8_0（llama-server）：貪婪 70/96，3/6 題全對。
- **取消、暫停、續跑**（§25.12 第 5 項，真 `studio_host` 與子行程）：取消在 quantize 中途 → 步驟 `merge:完成, convert:完成, quantize:中斷, verify:未執行, pack:未執行`；續跑跳過已完成步驟，產出 7 個檔、sha256 全部相符。
- **工具偵測**（§23.1）：主行程只看 PATH 與設定檔是否存在，**不執行**；`onnxruntime` 尚未偵測（畫面寫「尚未實作」）。
- **狀態**：流程與 Python 腳本已實跑；工作室頁內 UI 的匯出按鈕與 Electron 實機匯出**未驗證**（§25.9 用驅動腳本代替）。

---

## 6. GUI：`/offline-training-studio`

### 6.1 入口與結構
- 入口：斜線指令 `/offline-training-studio`，設定頁 → AI → 離線訓練工作室。`/aidoc` 是模板（`floating-assistant.js` 註冊位置於 `slashCommands`）。
- 做法：複製 aiDoc 檢視器的架構（浮動視窗、沙盒 iframe、`mock.local` 假伺服器、`postMessage`），**不另起一套**。
- 分頁（§14、§19、§24）：資產清單、LoRA 登錄、資料匯入、資料集、評量、訓練、老師、流程、紀錄。

### 6.2 版面（`studio_layout_core.js`，核心與測試已實作；實機拖曳未驗證）
- 左右兩個分頁區，各自有分頁列。預設左區：資產、資料集、評量；右區：訓練、老師、紀錄。
- 分頁可拖到另一側（或右鍵「移到左／右」），兩側至少保留一個分頁；可關閉、可從「+」重新開啟；偏好存主程式 `localStorage`（iframe 沒有儲存空間），並有「還原版面」。
- 分隔線可拖曳調寬（有上下限，雙擊還原）；窄視窗（小於 640 px）改為上下堆疊。
- 每個分頁區可最大化／還原（另一區收起但不關閉、狀態保留）。
- 長時間訓練時視窗可關閉：桌面版在背景子行程執行，重開會接回進度；網頁版訓練限於符號式五類與 `wasm-web`，關閉分頁即暫停並寫出 `state/`。

### 6.3 訓練分頁
- 開始、暫停、續訓、停止；進度與 loss 曲線；匯出與打包；續訓檢查點匯出（`.fackpt`）與匯入。
- 後端下拉（只對 `lora`）：`自動（建議）｜純處理器（Python，桌面版）｜網頁處理器（頁內 WebAssembly）｜WebGPU（不可用）｜DirectML（不可用）｜Vulkan（不可用）`。不可用的灰掉，旁邊寫具體原因。
- 基準測試按鈕（§4.6）：一次一個後端；可中斷（3 秒內停止）。**App 內基準未驗證**（§10）。
- 桌面版執行的守則：子行程以 `nice -n 19` 執行，預設留一個核心（`studio_config_core.js`：自動＝N−1），視窗隱藏，不下載任何檔案。

### 6.4 流程總覽（`pipeline_core.js`、`pipeline_live_core.js`、`pipeline_view_core.js`）
- 五種訓練的階段圖（資料→產生→切分→訓練→評量→打包或匯出→按需載入）。狀態只看真實產物與標記，不自己宣稱完成。
- 即時狀態：`cpu-py` 的 `train.log` 逐行寫入；子行程 pid 寫在 `run.pid`；記憶體用 `/proc/<pid>/status` 的 VmRSS（Linux）或 `tasklist`（Windows）讀取（§19.1、§20.1）。
- 「下一次該加強什麼」：`train_advice_core.js` 的六條規則（regression、below-gate、few-rows、format-errors、content-errors、position-bias），每條附證據與數字；**證據不足不猜**（`position-bias` 因 `eval_run.py` 的 rows 沒有 `gold`、`pred` 欄位，目前一律證據不足）。
- 建議按鈕會切換到對應分頁（§20.1）。
- **狀態**：核心與路由測試已驗證；Electron 工作室的流程分頁**未驗證**（§24.3、§26.1 只驗了資產與 LoRA 分頁）。

### 6.5 LoRA 管理與 model card
- **登錄表**（`lora_registry_core.js`）：容量以 rank 計（`slotCapacity` 16、`usedRank`、`freeRank`）；預算 256 MiB（可調）、`maxActive` 4；卸載採 LRU（不在本次計畫內者）；`replace` 原子回滾（applyFn 失敗時還原）；`select` 依領域、觸發字、評量排序，同領域只留一個；評量缺資料不自動選（但 `KNOWN_EVAL` 表內的 `colu-r4`、`plan-r4` 例外，§27.6）。
- **按鈕**：載入、卸載、釘選、停用、替換、移除、介紹。按鈕可不可按由登錄表狀態推出提示，**權威規則仍在登錄表**。
- **model card**（`model_card.json`，由 lora-manager-2 產生）：必填 `format:"fa-lora-card"`、`version:1`、`id`、`name`、`base.name`、`created`、`capabilities`、`known_limits`；選填 `intro`、`version_tag`、`applicable`、`training`、`eval`（比率，0–1）。樣本少於 30 題警告「只供參考」，缺資料寫「無資料」。
- 兩種卡片要分清：登錄表卡片（eval 是贏與輸的 domain 清單）與 `model_card.json`（eval 是比率）。畫面兩個都顯示，不合併。
- **狀態**：介紹、移除、載入、卸載、釘選、替換已在暫存 harness 實跑（§24.2、§23.3）；`replace` 的「約 2 秒」是介面文字，**沒有實測**（§26.1）；`model_card.md` 只定了 JSON，沒有 Markdown 版本。

### 6.6 資料匯入
- 來源：本機路徑（桌面版）、多行＝多個資料夾、`fap:` 參照、GitHub wiki 或維基百科的網址（只抓文字、2 MB 上限、最多 40 頁、先列出要連線的網址請使用者確認、顯示每次連線的狀態與大小、不下載壓縮檔或二進位）、常用來源釘選（最多 30 個）。
- 網頁版不能用路徑讀本機檔（瀏覽器沙盒），畫面寫明並指向挑選器與 `fap:`。
- 清洗預覽與逐塊拒絕（§7.1）。

---

## 7. 資料匯入清洗與老師迴圈

### 7.1 匯入與清洗（`ingest_core.js`、`clean_core.js`，已實作並驗證）
流程：來源 → `ingest`（統一文件 `{text, code?, heading, meta}`）→ `cleanDocs`（語料塊 `kind:'corpus_chunk'`）→ 兩條出口。
- 四種來源轉接器：`fromWiki`（`.md`、`.html`、`.txt`，依標題切段）、`fromOpenSource`（偵測 LICENSE、SPDX 與特徵句，找不到＝`unknown`）、`fromBook`（只收使用者提供的文字，`user_supplied:true`，授權預設 `unknown`，**不提供網路抓書**）、`fromAiDoc`（支援 `fa-project-notes`、`{meta,notes,map}`、`fa-project-index-bundle`、wiki `index.json`、SQLite 匯出的列陣列）。
- 清洗：正規化（BOM、CRLF、零寬字元、全形空白）；切塊大小依 `contextWindowTokens` 比例（目標 1/8、上限 1/4、重疊 1/8、下限 1/10；未給視窗用 4096，**沒有寫死的 token 常數**）；個資與密鑰樣式（email、電話、身分證字號、私鑰、`sk-`、`ghp_`、`AKIA`、`Bearer`、JWT、`api_key=`）；品質過濾；去重（精確雜湊＋近似 simhash，8 段×8 位分桶，海明距離 ≤6，≥100 字元才比近似）。
- **授權政策**：只有寬鬆授權（MIT、Apache-2.0、BSD、ISC、CC0、CC-BY-4.0…）`builtin_allowed:true`；copyleft、`user-provided`、`unknown` 一律 `false`，只能留在使用者資產。**內建化的 `import-asset` 尚未檢查這個欄位**（§11）。
- **heldout**：路徑含 `holdout`、`heldout` 或 `meta.heldout:true` 的來源標為留出；去重時留出先入，訓練列的近似重複被丟（原因 `leaks_heldout`）；請求單與規則樣本都不使用留出。
- **實測輸入**（`ingest.test.js` 的輸出）：repo 的 `wiki/`（29 文件→29 塊）、`DESIGN.lora-training.md`＋`DESIGN.project-index.md`（55→56 塊）、aiDoc 的真實索引（135 文件→121 塊，11 近似重複、3 過短被拒）。
- **維基百科實測**（§26.5，經使用者同意）：15 頁、純文字 266,483 位元組。zh 版是簡體字，**與本專案繁體規範不同，這份文字沒有轉換**；部分標題因重新導向或改名與清單不同，已如實記錄。

### 7.2 兩條出口
1. **樣本生成請求單**（`buildSampleRequests`）：`kind:'sample_request'`、`status:'pending'`，記錄任務（qa、summary、instruction、code_explain）、輸入語料塊、驗證條件。語料塊**不是**訓練資料；交給老師生成後，用 `verifyTeacherSample` 驗證才收（schema、答案詞彙至少一半出現在語料塊、無個資、`split:'train'`、不得引用留出塊）。
2. **規則樣本**（`ruleSamples`）：不用 AI。標 `meta.author:'rule'`、`verified_by:'program_ground_truth'`；答案逐字擷取自語料塊（標題→摘要、程式碼前導註解→說明）。品質低於老師生成，只作補充。

### 7.3 老師迴圈（`teacher_core.js`，核心與替身測試已實作；真線上 AI 未驗證）
- **觸發**：使用者說「我要強化 X」，或 `/offline-training-studio teach <目標>`。缺口驅動：先看 `studio_gap_report`，針對弱項補資料，補完跑 `studio_eval`，沒改善就回報而不是繼續灌資料。
- **白名單工具（七個）**：`studio_dataset_list`、`studio_dataset_read`、`studio_dataset_add`、`studio_dataset_remove`、`studio_verify`、`studio_eval`、`studio_gap_report`。執行時才註冊進 `this.tools`，透過 `_runSubAgentTask({allowedToolNames})` 呼叫線上 AI，結束即移除。
- **鐵則，由程式強制**（不是只寫在提示詞裡）：
  1. 每筆資料要經程式驗證才收，記 `verified_by`；不收「模型說對」的答案。
  2. 只收 `split:'train'`；留出題內容相同者拒收；老師看不到留出題的答案。
  3. 每筆記 `author:'teacher'`、來源、時間、驗證證據；使用者可逐筆拒絕。
  4. 不自動開始訓練：產生資料與開始訓練是兩個動作。
  5. 單次上限 30 筆、60,000 字元、3 輪。
  6. 送出前顯示會送什麼與 hash，要 `confirmed` 才送（隱私：只送資料集條目與評量摘要，不送使用者檔案內容）。
- **驗證器**：uml（`validateModel`）、blockly（判題器 AC）、matrix（矩陣層自己重做＋隱藏測資）、lora（語料塊依據＋schema）。**colu 與 trainer 不給老師代做**（使用者決定，畫面寫明原因）。
- **限制**：沒有「試算」接口的 kind 加資料不會重新訓練，分數不會變；改善以「每筆都通過程式驗證」為準並在報告明說。只有有 `trial` 接口的 kind 才能做到「沒改善就回滾」；**目前沒有任何 kind 接上 trial**（回滾邏輯只有假接口的單元測試）。
- **狀態**：白名單、驗證、移除、commit 在 Electron 以替身驗證（§15.5）；**真線上 AI 沒有跑過**（沒有可用模型）。

### 7.4 老師與內建化的關係
老師產生的資料要進內建，需要先在使用者端驗證（§7.3），再經 §8 的內建化流程，`import-asset` 檢查授權與來源欄位。

---

## 8. 評量與路由

### 8.1 評量組（`eval_core.js`、`sym_suites_core.js`、`eval_run.py`）
| kind | 評量組 | 已實作狀態 |
|---|---|---|
| uml | 5 小題＋3 組合題 × actors、classes、usecases、sequences | 核心測試通過 |
| trainer | 內建規則自檢（正規式、工具存在、信心值） | 核心測試通過 |
| colu | 留一組交叉驗證 F1 | 核心測試通過 |
| blockly | 內建課「已記錄」；種子題需判題器（App 內無法重跑，§5.2） | 部分 |
| matrix | 6 題獨立手寫參考解；2 筆擬合、20 筆隱藏驗證 | 真 Electron 6/6 通過（§15.5） |
| lora | 讀資產 `manifest.eval`，由 `lora-train/eval_run.py` 產生 | 已實作並驗證（§6.5） |

### 8.2 留出與基準
- 基準（baseline）與上線門檻（gate）存在偏好。`/api/eval`（工作室的評量分頁列出 6 種 kind，**不列 llm**；`/api/eval/run` 對 llm 回 400）。
- 留出組只給通過率，不給題目與答案。改善比較以基準為準。

### 8.3 登錄表與路由（LoRA）
- `lora_registry_core.js`（登錄表）、`lora_route_core.js`（每輪路由，`fa._llmGenerate` 帶 `task`，§27）、`lora_manage_core.js`（畫面核心）、`lora_web_core.js`（網頁版併入）。
- 路由規則（`select`）：領域→觸發字（字串或正規表示式）→評量；`conflicts_with` 排除排序在後者；取前 `maxActive` 個。`KNOWN_EVAL` 表（§19 的留出集數字，只認 id 或名稱完全等於 `colu-r4`、`plan-r4`）讓兩顆在沒有卡片評量時也能被自動選用（§27.6）。
- **已知問題**（§27.4）：`colu`、`plan` 的任務文字含「工具」「呼叫」，會被 `toolcall-r4` 的觸發字搶走；§27.6 的修正是「任務領域已有符合的 adapter 時，只靠觸發字命中的別領域 adapter 讓位」，**修正後的實機路由未重跑**。
- 原生路徑的限制（§27.4 第 4 項、§27.6 第 4 項）：原生推論只做純文字；帶 `tools` 或 `prefill` 時會略過原生，改走網頁版。`FaVlm.nativeToolMessages` 把工具折進 system（格式同 Qwen3 官方樣板），歷史有 `tool` 角色或 `tool_calls` 時不處理；預填讓模型自己生成，輸出以預填開頭才採用，否則退回網頁版。**要讓預填一律走原生，需要執行包 1.22.0-3**（`nr-*` 是 md5 釘住的，改它要發新版）。

### 8.4 槽位與替換
- 槽數是**匯出時固定的**（`make_lora_onnx.py build` 的單一 LoRA 槽版）。換一個槽要重建工作階段，約 1.4～3 秒（實測，§27.6）；桌面版替換約 2 秒（介面文字，未實測）；網頁版 `maxActive=1`，數秒到數十秒。
- 替換與回滾：原子性，applyFn 失敗時還原（`lora_registry_core.replace`）。
- 同槽驗證（`DESIGN.lora-training.md` §26.3）：四顆同時載入，rank 加總 16（滿）；第五顆被拒並寫「計畫的 rank 總和超過槽容量 16」。

---

## 9. 發布與熱更新流程

### 9.1 資產內建化（`scripts/training-studio.js`）
- `train <kind>`：直接呼叫對應訓練（lora 走 `lora-train/train.sh`，其餘走各自核心）。
- `pack <kind> <name>`：打成 §3.1 格式放進 `desktop-app/builtin-training/<kind>/<name>/`（分片 ≤20 MB；GitHub 單檔上限 100 MB）。
- `embed`：把需要隨 app 載入的小資產（規則包、課程包、領域包）嵌入 `floating-assistant.js`（沿用 `scripts/embed-code-ui.js` 與標記慣例）。
- `verify all --deep`：核對 sha256、相容性與測試。
- `import-asset`：使用者匯出的 `.fatrain` 驗證後納入（驗證不過不收；`owner` 改 `builtin`，保留 `parent` 與作者；**授權欄位的檢查尚未接上**，§7.1）。
- **狀態**：`pack` 與 `verify` 有純邏輯端到端紀錄（§16.1，matrix 與 blockly 示範都通過）；**`builtin-training/` 目錄還沒有任何提交**（§16.3-1，需要先確認授權與來源欄位）。

### 9.2 大資產走 branch
- LoRA 權重（大檔）**不嵌入**，走 GitHub `lora-adapters` branch（分片＋manifest），App 依相容性載入（相容就抓、設定可開關、預設啟用；`DESIGN.lora-training.md` §10）。
- LoRA 執行包（原生）走 `native-runtime-1.22.0` branch：`manifest.json`（`runtimeVersion` 1.22.0-2）與 `parts/nr-*.part`（§27.6 更正：分支已在 `eb7fd2a4`，可下載）。舊版執行包（1.22.0-1）沒有 `lora` 功能，會回報「需要更新執行包」。

### 9.3 Live update（熱更新）
- 改 `floating-assistant.js`、`bootstrap.js`、`index.html` **只能經 `scripts/publish.sh`**：建置、commit、組 `desktop-app-patch` 分支、核對 checksum，`PATCH_VERSION` 單調遞增，不手組 patch，不動凍結的 `live-patch-compat`。
- 主行程邏輯放 **`main-ext.js`**（熱更新可送達），不改 preload 與 `main.js`，因此**不需要重新安裝**。`studio_host.js` 的 `FA_STUDIO_HOST_FILES` 由 `main-ext.js` 的原生信箱載入。
- 嵌入（`embed-code-ui.js`）與建置（`build-assistant.js`）不由 session 執行：**由總指揮統一重產**（§10 的 `studio_embed.test.js` 依賴這一步）。

### 9.4 版本與相容
- 資產與偏好都有版本號；讀到舊版或缺欄位要遷移，並以舊資料升級測試驗證（`DESIGN.knowledge-types.md` 的慣例）。
- LoRA 相容性欄位：`base`、`rank`、`prompt_format_version`、`tool_catalog_sha256`；提示格式變動一定重訓（`DESIGN.lora-training.md` §10）。
- 設定：`offlineLora`（預設開）、Studio 儲存位置偏好、老師每次擴充上限。

---

## 10. 驗證現況表

標記：**已驗證**＝有實測或真環境紀錄；**核心已驗證**＝純函式與單元測試過，App 內未跑；**未驗證**＝有程式或設計，沒有跑過。「出處」指向舊檔的節。

| # | 項目 | 狀態 | 出處與說明 |
|---|---|---|---|
| 1 | 資產格式、manifest、`.fatrain` 往返與分片 | 已驗證（核心） | `fatrain_core.test.js` 46 項；§25.12；真 756 MB 往返 §25.11 |
| 2 | 交換空間（IndexedDB）寫入與讀回、配額拒絕 | 已驗證（真瀏覽器頁面） | §5.6 階段 4–6，`swaptest.html`（57×18 MB） |
| 3 | 符號式五類的訓練包裝（暫停、進度、完成寫資產） | 核心已驗證 | `sym_studio.test.js` 71 項；§15.3；App 內 blockly、matrix 訓練未跑（§16.2） |
| 4 | `cpu-py` 真訓練（約 60 token/s） | 已驗證 | `DESIGN.lora-training.md` §1 |
| 5 | `cpu-py` 暫停續訓（真 PyTorch） | 已驗證（`train_lora.py`） | `DESIGN.lora-training.md` §16，步 4–6 loss 相同（小數六位） |
| 6 | `cpu-py` 的 Python 環境探測 | 已驗證（本機不達標） | §26.1：本機 python3 為 3.10.12，App 判為太舊；`/usr/bin/python3.11` 存在但 App 不會自動選用 |
| 7 | `cpu-py` 的規範化檢查點與跨後端續訓 | 未驗證 | §5.7 階段 1 寫「迷你模擬」；真實 `train_lora.py` 的規範化與 `--init_adapter` **未做**（TODO §5.3） |
| 8 | `wasm-web` 逐層訓練與 30 步對拍 PyTorch | 已驗證（部分） | §5.6 階段 7；**對照資料是隨機 token，未驗收斂** |
| 9 | `wasm-web` 頁內宿主與 `.fackpt` 往返 | 已驗證（真 Electron，14 項） | §5.6 階段 8；同一瀏覽器內，**跨機未驗證** |
| 10 | `webgpu` 逐層訓練 | 已驗證（一張舊卡） | §5.6 階段 4–6；**Studio 介面仍灰**；其他顯示卡與 `shader-f16` 未測 |
| 11 | `directml`、`vulkan` | 未驗證／設計未做 | §5.2；解除條件見 §4.4 |
| 12 | 基準測試、自動選擇、降級、釘選（核心） | 核心已驗證 | `bench_core.test.js`；App 內端到端未驗證 |
| 13 | 跨機續訓（兩台機器） | 未驗證 | 只有一台機器；同機跨 store 已驗證（#9） |
| 14 | 老師迴圈（白名單、驗證、commit） | 核心已驗證（替身） | §15.2、§15.5；**真線上 AI 未跑過** |
| 15 | 老師的 trial 回滾 | 未驗證（無 kind 接上） | §15.2 |
| 16 | wiki 網路抓取（15 頁） | 已驗證（經使用者同意） | §26.5；**抓到的內容沒有進訓練** |
| 17 | 清洗與切塊（含 aiDoc 真實索引） | 已驗證（核心） | `ingest.test.js` 77 項；§13.3 |
| 18 | LoRA 登錄、按需選用、預算與 LRU | 核心已驗證 | `lora_registry.test.js` 80 項 |
| 19 | 桌面版 LoRA 套用到原生推論（四顆，產品視窗） | 已驗證（3 題／型，樣本極小） | §27.1–27.2 |
| 20 | 四顆同時套用（rank 16） | 已驗證（品質不可用） | §27.3 |
| 21 | 原生工具呼叫（toolcall）與預填 | 部分（預填需要執行包 1.22.0-3） | §27.6 第 4 項；未驗「折進 system 後與網頁版生成的比較」 |
| 22 | `toolcall-r4` 格式合法率與缺工具拒絕 | 已驗證（單一權重，v2 判準） | §24；**範圍外（colu、think_stack、decompose）未量** |
| 23 | 網頁版併權重（真模型、Node 與 ORT 1.22.0） | 已驗證（載入與位元相同） | §14.2 |
| 24 | 網頁版併權重的輸出品質與瀏覽器 WASM | 未驗證 | §14.2 末段；**需要真的訓練 adapter 與任務指標** |
| 25 | LLM 匯出：ONNX fp32 與 HF 逐字一致 | 已驗證 | §25.3（96/96） |
| 26 | LLM 匯出：ONNX q8 品質 | 已驗證，**未達標** | §25.4（貪婪 39/96，首步餘弦 0.922） |
| 27 | LLM 匯出：GGUF Q8_0 | 已驗證（llama-server） | §25.3（70/96） |
| 28 | 匯出的取消、暫停、續跑（真 `studio_host`） | 已驗證 | §25.12 第 5 項（sha256 全相符） |
| 29 | 匯出在工作室 UI 內（按鈕、Electron 實機） | 未驗證 | §25.9 用驅動腳本代替 |
| 30 | 網頁版 llm 推論（ORT-web harness，Chrome） | 已驗證（harness 頁） | §25.12 第 2a 項：54/96（圖最佳化 disabled） |
| 31 | 網頁版 llm 工作室頁內生成 | 未驗證（路由測試） | §25.12 第 2c 項 |
| 32 | 資料集逐筆編輯 | 已驗證（暫存 harness，非嵌入版） | §23.3 |
| 33 | LoRA 介紹、移除、載入、卸載、釘選、替換 | 已驗證（暫存 harness） | §24.2；`replace` 的時間未量 |
| 34 | 評量分頁與各 kind 評量組 | 核心已驗證；matrix 評量在 Electron 已驗證 | §15.1、§15.5 |
| 35 | 流程總覽（核心、路由、畫面產生器） | 核心已驗證 | §19.4 的測試數字；**Electron 流程分頁未驗證** |
| 36 | 工作室 Electron 視窗（資產、LoRA 分頁、斜線指令） | 已驗證 | §26.1（xvfb，`/offline-training-studio` 打開，LoRA 空狀態） |
| 37 | 版面（左右分頁、拖曳、最大化） | 核心已驗證；實機未驗 | `studio_layout_core.test.js` 27 項 |
| 38 | 嵌入與 `studio_embed.test.js` | 已驗證（總指揮重產後） | §24.5：17 項全過（驗完已還原產生檔） |
| 39 | `builtin-training/` 內建資產 | 設計未做（未提交） | §16.3-1 |
| 40 | `scripts/training-studio.js` 的 `pack`、`verify` | 已驗證（純邏輯） | §16.1 |
| 41 | 視覺模型（Florence-2、SmolVLM、LLaVA-Interleave）真機時間 | 已驗證（開發機與使用者 GPU） | `DESIGN.offline-vision.md` §7；**不屬於工作室，見提案 A** |
| 42 | 影像生成（SDXS 本機一步） | unet 一步的時間與峰值已量（原生與 WASM，隨機輸入）；**生圖的端到端在真 Electron 只用假生圖模型驗證** | `DESIGN.native-all-models.md` §7.2；`DESIGN.edit-picture-diffusion.md`（測試說明） |

環境注意：本檔寫作時，`~/fa/` 與 `lora-train/models/` 不在此環境，所以本檔**沒有重讀**基底模型的 `config.json`（§13.1）。

---

## 11. 已知限制與待辦

### 11.1 已知限制（會影響使用者的）
1. **網頁版 LoRA 訓練**：只有 `wasm-web`（每步約 12–26 秒，T=32）可用；`webgpu` 沒接到 Studio。1,000 筆以上的資料實際上要用桌面版 `cpu-py`。
2. **網頁版併權重**：只對 `qwen3-0.6b` 的 CPU 版有效；同時只能一個 adapter；品質未經任務指標驗證（§4.7）。
3. **多 adapter 串接**：目前不可用（§27.3）。
4. **toolcall 與預填**：原生路徑不支援預填；預填要執行包 1.22.0-3。
5. **llm 匯出的 q8 品質不達標**（貪婪 39/96，§5.8）。
6. **GGUF 與 ONNX 的 q8 不能逐字對齊 HF**（§25.3）。
7. **資料集**：只讀 `messages`＋`completion`、`chosen`／`answer`、`ids`／`tgt` 三種格式；`tools` 欄位的實測沒做（`DESIGN.TODO.offline-training-studio.md` §26 之前的接手節，§14 的資料來源說明）。
8. **教學資料的隱私**：老師送出前要使用者確認；個資偵測只做樣式，人名與地址抓不到（`DESIGN.TODO.offline-training-studio.md` §11 第 13 項）。
9. **書本著作權**無法由程式判定，只能依使用者聲明。

### 11.2 待辦（依序，每項附阻礙與解除條件）
| # | 待辦 | 阻礙與解除條件 |
|---|---|---|
| 1 | 決定 `builtin-training/` 的示範資產是否進 repo | 需先確認授權與來源欄位；`import-asset` 的授權檢查要接上（§7.1、§9.1） |
| 2 | 教學領域種子題在 App 內重跑 | 判題需要桌面版 Python ≥3.11 與 tree-sitter 快取（`~/.cache/fa-ts`，本機沒有）；sym_suites 的題數與資料檔要接起來（§26.6） |
| 3 | par 領域補配方（12 題） | 程式內容缺口，要在領域包補三種題型的配方（§26.6） |
| 4 | Electron 驗證流程分頁、LLM 匯出按鈕、網頁版 llm 頁內生成 | 需要顯示環境；其他 session 的視窗不可干擾（§24.3、§26.1） |
| 5 | LoRA `replace` 的時間實測 | 需要真的 adapter 與登錄表（§26.1 第 3 項） |
| 6 | 多 adapter 串接的品質 | 需要改合併策略或改為逐顆套用的路線；未設計（§27.3） |
| 7 | 老師迴圈接上真線上 AI | 沒有可用模型；需使用者同意送出資料 |
| 8 | 老師的 trial 回滾 | 需要至少一個 kind 的試算接口（§7.3） |
| 9 | 跨機續訓（兩台） | 只有一台機器；需要第二台或隔離環境（§3.5、§10 第 13 項） |
| 10 | `wasm-web` 對拍真實訓練資料的收斂 | 需要真實資料的批次與訓練步數（§4.6） |
| 11 | 基準測試門檻校準 | 需要多台機器的量測資料（§4.6） |
| 12 | 區網傳輸的安全設計 | 未設計：配對碼、加密（§3.5） |
| 13 | `uml` 詞彙的執行期擴充 | `uml_core` 需加 `extend()`（§5.4） |
| 14 | `onnxruntime` 的工具偵測 | 主行程的偵測還沒寫（§5.8、畫面寫「尚未實作」） |
| 15 | 原生預填與 toolcall | 執行包 1.22.0-3 |
| 16 | 內部數字的不一致 | 本機硬體描述不一致（§4.2 補充）；`DESIGN.TODO.offline-training-studio.md` 開頭的「設計，尚未實作」已過時，本檔以各節為準 |

---

## 12. 設計提案 A：網頁版 VLM 與圖像生成使用 IndexedDB 作為交換空間

> **狀態（2026-11-13 更新）：M1 已實作並在 Node＋onnxruntime-node 上實測（§12.7）；M2～M4 未做。** 以下數字區分「實測」（有量測紀錄）、「推算」（由實測數字算出）、「未量測」（沒有資料，不編）。

### 12.1 現況與要解決的問題
- 網頁版的視覺模型（`vlm/`、`DESIGN.offline-vision.md`）與本機生圖（`imagegen/local_sd.js`，SDXS）都是一次把整個模型載入 onnxruntime-web 的 WebAssembly 工作階段。WebAssembly 的線性記憶體只有 32 位元，**單一模組上限 4 GiB**（`onnxruntime_webassembly.cmake` 設 `MAXIMUM_MEMORY=4294967296`）。
- 訓練工作室已經有交換空間（§3.3）；提案 A 問的是：**同一套做法能不能用在推論（VLM 與生圖）上？**

### 12.2 實際的模型大小（都來自 repo 紀錄）
| 模型 | 版本 | 檔案與大小 | 來源 |
|---|---|---|---|
| Florence-2 base | CPU／GPU | 約 208 MB／344 MB（總大小，組成未列） | `DESIGN.offline-vision.md` §2 |
| SmolVLM 256M | CPU／GPU | 約 203 MB／200 MB | 同上 |
| LLaVA-Interleave Qwen 0.5B（社群轉檔） | int8／fp16 | 約 1.4 GB／2.2 GB | 同上 |
| SDXS-512（生圖） | GPU fp16 | text_encoder 246 MB＋unet 632 MB＋vae_decoder 2.5 MB，約 880 MB | `imagegen/local_sd.js` 清單 |
| SDXS-512（生圖） | CPU int8 | text_encoder 238 MB＋unet 873 MB＋vae_decoder 4.9 MB，約 1.1 GB | 同上 |
| Qwen3-0.6B（語言） | q8 | `model_quantized.onnx` 617,687,575 位元組 | `DESIGN.lora-training.md` §14.2 |

### 12.3 實測的記憶體與時間（既有數字）
| 項目 | 數字 | 來源 |
|---|---|---|
| SDXS unet 一步（int8，隨機輸入，WASM） | 13,466 毫秒（原生 7,682 毫秒） | `DESIGN.native-all-models.md` §7.2 |
| SDXS unet 一步，整個 Electron 的峰值記憶體（含 624 MB 基線） | 4,555 MB | 同上 |
| SlimSAM 77 編碼器（q8，1024×1024，WASM），Electron 峰值 | 2,272 MB（原生子程序峰值 3,610 MB，改 `enableMemPattern:false` 後約 1.9 GB） | 同上，§9.3 |
| Depth Anything V2 Small（fp32，518×518），Electron 峰值 | 1,617 MB | 同上 |
| 視覺模型推論時間（開發機 CPU 與使用者 Intel GPU） | Florence-2 CPU 21–34 秒；LLaVA-Interleave CPU 140–150 秒、GPU 約 23 秒；SmolVLM CPU 16–38 秒、GPU 約 10 秒 | `DESIGN.offline-vision.md` §7 |
| IndexedDB 寫入、讀回（57×18 MB） | 寫入 3.4 秒（約 300 MB/s）、讀回 4.9 秒（約 210 MB/s） | §3.3（推算來自實測） |
| 配額 | 配額 1100 MB 時，再寫 200 MB 被明確拒絕，舊資料完好；瀏覽器估計配額約 245 GB | §5.6 |
| WebGPU（舊卡）單一緩衝區上限 | `maxStorageBufferBindingSize` 與 `maxBufferSize` 約 2 GB | §5.6 階段 4–6（Kepler 世代卡，一張） |
| Memory64（64 位元 WebAssembly 記憶體） | 本機 Chromium 152 可建立；**onnxruntime-web 沒有 64 位元二進位** | §5.6 階段 4–6 |

**未量測**：VLM 在 WebAssembly 內的堆積（heap）峰值（Electron 頁面模式只量到 JavaScript 堆）；各模型在 IndexedDB 讀取的分段延遲；OPFS 與 Cache Storage 的讀取速度。

### 12.4 限制逐項分析
**(a) WASM 4 GiB 位址空間**：一個工作階段的權重、激活、執行緒堆積都在同一個線性記憶體內。實測看到的壓力：SDXS unet 的 Electron 峰值 4.5 GB（但這是整個程序，拆不出 WASM 堆積的部分）；0.6B 語言模型的全圖訓練也在 4 GB 附近（§5.6 階段 3，3.85 GB，ORT 最佳化開啟時直接中止）。**結論**：單一模型小於約 1 GB 且激活可控時，不需要交換空間；超過時要分段。

**(b) 分階段釋放（VLM：視覺編碼器 → 語言模型 → 解碼）**：每一階段建立一個工作階段，用完釋放，權重從交換空間讀。
- 優點：同時只需要一個階段的權重與激活。
- 成本：每次切換要讀取該階段的權重，約 `大小 ÷ 210 MB/s` 秒（推算）。Florence-2 base 約 208 MB → 約 1 秒；LLaVA-Interleave 1.4 GB → 約 7 秒（推算，只算讀取，未含建立工作階段的時間）。
- **建議**：只在超過約 1 GB 的模型才啟用；小模型維持常駐。

**(c) 擴散模型逐區塊載入（生圖）**：SDXS 只做一步取樣，流程是 text_encoder → unet（一次）→ vae_decoder。**一步取樣的情況下，每個元件只用一次**，所以「分段讀取」的好處只有峰值降低，沒有重複讀取的成本。
- 實際問題是 unet 單檔 873 MB（CPU 版）＋激活：分階段（先 text_encoder，釋放，再 unet，再 vae）可以把三者的峰值相加改成取最大值（推算）。
- 「逐區塊」（把 unet 切成 down、mid、up 區塊）需要重新匯出模型，**設計未做**，現在沒有證據說明需要。

**(d) 自回歸解碼逐權杖換層（不可行，要量讀取頻寬）**：語言模型每產生一個權杖都要通過全部層。
- 若每個權杖都從交換空間讀完整的權重：Qwen3-0.6B q8 約 617 MB，以實測讀取約 210 MB/s 計算，**每個權杖至少約 2.9 秒（推算）**，即約 0.3 權杖/秒。這是**下限**（沒算計算時間與交換的額外開銷）。
- 更大的模型（4 GB 量級的 q8）：每個權杖約 19 秒（推算）。
- 與常駐做法比較：本檔沒有查到推論速度的實測數字（`lora-train` 的 60 token/s 是訓練吞吐，不能直接比較），所以這裡**不做倍數比較**，只說明逐權杖換層的讀取下限已經超過可用範圍。
- **結論**：自回歸生成不應逐權杖換層；可行的是「常駐」小模型，或只把**不常用的部分**（例如長上下文的 KV 快取，§13.3）放進交換空間。

**(e) WebGPU 緩衝**：單一緩衝區上限約 2 GB（一張舊卡的實測），權重要分塊綁定。激活與權重的分塊規則與 `qwen3_graph.js` 的做法相同（§5.6）。**未驗證**其他顯示卡的上限。

**(f) OPFS、Cache Storage、IndexedDB 比較**
| 方式 | 已知 | 未知 |
|---|---|---|
| IndexedDB（現有） | 已實測；可存 blob；非同步；寫入與讀回速度見 §12.3；`transformers.js` 不直接用它存模型 | 在不同瀏覽器的交易大小上限與效能 |
| Cache Storage（現在 `transformers-cache` 就用它存模型） | 模型已在這裡；與 `transformers.js` 同一套快取；URL 為鍵 | 不能做「只讀某段位元組」的隨機存取（推測，未查證）；讀取速度未量 |
| OPFS（Origin Private File System） | 在 Worker 內可用同步存取控制代碼（`SyncAccessHandle`），可以隨機讀寫而不必整個載入（推測，需查證各瀏覽器版本） | **未實測**；支援度與配額行為未查證 |

- **建議**：權重分段存放的候選是 **OPFS**（隨機讀取、不需要整檔進記憶體），但在實測前不宣稱。IndexedDB 作為第一個版本（已有實作，風險最低）。
- 注意：IndexedDB 的讀取約 210 MB/s 來自實測；OPFS 若要替代，必須先量同樣的讀取速度。

**(g) 配額、校驗、不淘汰**
- 配額：沿用 `swap_store.js` 的明確配額與 `SwapFullError`；**推論用的快取（可重新下載的模型）可以用 LRU**，與訓練交換不同（訓練的中間結果不能淘汰）。兩種規則要分開。
- 校驗：`swap_store.js` 的 FNV-1a 只抓截斷與寫壞，不是密碼學校驗。模型分片建議**寫入時算一次完整 sha256**（`asset_core.js` 已有純 JavaScript 的 sha256），讀取時只比長度；不要每次讀取都算完整雜湊（成本未量）。
- 不淘汰：工作中的層或分片不可被淘汰；配額不夠要明確失敗，不靜默降級。
- 持久化：瀏覽器可能在儲存壓力下清除資料。`navigator.storage.persist()` 可以請求持久化，**是否被允許取決於瀏覽器，未查證**；UI 要說明「清除瀏覽器資料會遺失」。

### 12.5 建議方案
1. **第一階段（風險最低）**：沿用 IndexedDB 與 `swap_store.js`，只對超過 1 GB 的推論模型啟用分段；小模型不動。
2. **第二階段**：SDXS 的生圖依「text → unet → vae」順序釋放（§12.4 c），量取最大值是否降到可接受（需要實測）。
3. **第三階段（研究）**：OPFS 做隨機讀取的權重分段，與 IndexedDB 比讀取速度與峰值記憶體。
4. **不做**：自回歸逐權杖換層（§12.4 d）。

### 12.6 里程碑與驗證方法
| 里程碑 | 驗證 | 完成條件 |
|---|---|---|
| M1：VLM 分階段（Florence-2，約 208 MB） | 與常駐版比輸出（同一張圖、同一提示，逐字比對）與峰值記憶體（WASM 堆積，以 `performance.memory` 或 Electron 程序 RSS，兩者都標明） | 輸出完全相同；峰值降低的幅度有數字；切換時間有數字 |
| M2：SDXS 依序釋放（CPU int8 版） | 同一隨機種子的輸出位元比對；峰值記憶體 | 輸出與常駐版相同（允許量化誤差的既有差距，§5.2 的 34.8 dB）；峰值有數字 |
| M3：OPFS 讀取速度 | 同樣的 57×18 MB 測試，比 IndexedDB | 有數字才決定要不要做 M4 |
| M4：快取鍵與校驗 | 寫入 sha256，讀取比長度；故意截斷一個分片 | 截斷時明確失敗並提示重下載 |

**驗證的硬性要求**：在真實的 Electron 頁面（不是 Node）量，並分開標示 WASM 堆積與程序 RSS；不宣稱沒量到的數字。

### 12.7 實作狀態（2026-11-13，分支 `claude/vlm-studio`）

**做了什麼**
- `renderer/src/vlm/staged_vlm_core.js`：Florence-2 的三階段（視覺 → 編碼 → 解碼）。每階段只載入自己需要的工作階段，用完釋放；權重用注入的 `store.get(名稱)` 讀（網頁版應接 `swap_store.js` 的 IndexedDB 後端）。常駐與分階段共用同一段數學程式 `runPipeline`，所以比對的是權重載入方式，不是兩套實作。
- 解碼用 KV 快取的貪婪解碼；編碼器的 KV 只在第一步算一次，之後沿用（第一步之後的 `present.*.encoder.*` 是空的，這是實作時踩到的坑，已修）。
- `renderer/src/vlm/staged_vlm_bench.js`（Node 量測工具）、`staged_vlm_prep.py`（前處理，與 Florence-2 處理器一致：768×768、雙三次插值、ImageNet 正規化）。
- 單檔測試 `renderer/src/vlm/staged_vlm_core.test.js`：15 項（替身工作階段）。

**沒有做**：網頁版（Electron WebAssembly）的接線與量測；`vlm/` 的 transformers.js Worker 尚未改用分階段；`swap_store` 的 IndexedDB 讀取沒有在這條路徑上量。

**實測（Node 22＋onnxruntime-node 1.22.0，CPU，量測機器同時有其他工作在跑，負載平均 60～80）**

| 項目 | 數字 | 條件 |
|---|---|---|
| 權重（量化版，四個檔） | vision 93.7 MB、encoder 43.7 MB、embed 39.4 MB、decoder 98.2 MB，合計 275 MB | `onnx-community/Florence-2-base-ft` 的 `*_quantized.onnx`，比 §12.2 的 208 MB 大；以實際檔案為準 |
| 輸出逐字比對 | **6／6 相同**（3 張圖 × 2 次，常駐 vs 分階段，每次 12–13 個權杖） | 同一前處理、同一提示詞 `What does the image describe?` |
| 峰值（程序 VmHWM，中位數） | 常駐 **1294 MB** → 分階段 **850 MB**，降低 **34.3%** | 每種模式獨立程序；啟動前基線 61 MB（Node＋ORT 本身） |
| 切換時間（分階段，中位數，n=6） | 視覺載入 1604 ms、編碼載入 400 ms、解碼載入 1032 ms；釋放 106／45／62 ms | 載入含「從檔案讀」與建立工作階段；儲存是檔案而非 IndexedDB |
| 整段生成時間（中位數） | 常駐 ≈ 8.35 秒、分階段 ≈ 8.95 秒（約 +7%） | 機器負載高，時間只能當方向，不當定論 |

**未量測（照規則不編）**：Electron／WebAssembly 的堆積峰值（只量到 Node 程序 RSS）；IndexedDB 的實際讀取延遲；OPFS；其他模型（Florence-2 的 fp32 版、LLaVA 等）。

**驗收對照（§12.6 M1）**：輸出完全相同 ✔（Node）；峰值有數字 ✔（Node RSS，不是 WASM 堆積，所以只算部分達成）；切換時間有數字 ✔。

---

## 13. 設計提案 B：用訓練工作室做出更大上下文、更深思考、原生函式呼叫的離線模型

> **狀態：設計提案，未實作。** 基底是 Qwen3-0.6B。問題逐項回答「可行性」與「代價」，不做承諾。

### 13.1 基底與上限（先查清楚）
**已確認的程式碼常數**（`renderer/src/studio/qwen3_graph.js`、`estimate06B`，`DESIGN.TODO.offline-training-studio.md` §5.6）：
- 28 層、隱藏維度 1024、前饋 3072、16 個 Q 頭、8 個 KV 頭、頭維度 128、詞表 151,936；綁定詞嵌入（`tie_word_embeddings`）。
- 參數：本體約 441M＋詞嵌入 155M，合計約 596M。

**查不到、要讀 config 才知道**：
- `max_position_embeddings`、`rope_theta`、`rope_scaling`（本機沒有基底的 `config.json`，`~/fa/` 也不在這個環境）。
- `lora-train/merge_and_export.py` 的註解說明：transformers 5.x 把 `rope_theta` 放進 `rope_parameters`，4.x 讀不到會退回預設 10000，所以合併時要沿用基底的 config（§25.2）。**這說明 `rope_theta` 是會被讀錯的數字，必須讀基底 config 才能定論。**
- 本檔**不編造**這兩個數字。

**ONNX 匯出中的旋轉位置編碼表**：`qwen3_graph.js` 的 `ropeTables` 從模型的 `cos_cache`、`sin_cache` 取值，形狀為 `[位置數, 頭維度/2]`，並檢查 `dims[1] === 64`。**這表示匯出的模型把旋轉表當成固定的初始值存著，位置數就是表的長度**。表的長度未讀取（本環境沒有 onnx 套件），所以**實際上限未知**。

**應用程式現況的上下文限制**：
- 原生推論（`nr-engine.js`）：預設 `maxTokens` 512（`opts.maxTokens || 512`），KV 快取逐步增長（`past_key_values` 每步拼接），**JavaScript 端沒有上下文長度上限**，上限由模型的位置表與記憶體決定。
- 網頁版（`llm_web_core.js`）：同樣逐步增長、沒有上限。
- 網頁版的記憶體：WebAssembly 4 GiB。**KV 快取大小是算術**：28 層 × 2（K、V）× 8 KV 頭 × 128 × 4 位元組（fp32，原生與網頁版目前都用 fp32）＝229,376 位元組/權杖（約 224 KiB）。

| 上下文長度 | KV 快取（fp32，推算） | 加上 q8 權重 617 MB（檔案大小）後的粗估 |
|---|---|---|
| 4,096 | 約 896 MiB（0.875 GiB） | 約 1.45 GiB |
| 8,192 | 約 1.75 GiB | 約 2.3 GiB |
| 32,768 | 約 7 GiB | 超過 WebAssembly 的 4 GiB，**不可行**（推算） |

4K 在算術上留有餘裕，8K 已經接近一半的位址空間，還沒算 ORT 自身與激活的開銷。fp16 KV 會把 KV 的數字減半（推算，但 `llm_web_core.js` 目前是 fp32，改 fp16 要驗證 ORT 與圖的支援）。這些是**算術估計**，沒有實測峰值。

### 13.2 上下文延伸

**(a) RoPE 縮放（YaRN 等）**
- 做法：改變旋轉位置編碼的頻率排程，讓模型在超過原訓練長度的位置上仍然合理。Qwen 官方文件描述 YaRN 可以靜態設定（**公開說法，本檔未查證**）。
- **關鍵事實**：我們的 ONNX 把旋轉表當作**固定的初始值**（§13.1）。所以「只改設定」**對已匯出的模型不成立**：要改頻率，必須重新計算 `cos_cache`、`sin_cache` 並重新匯出（匯出流程已存在，§5.8）。若表的長度不夠，還要更長的表。
- 代價（推算）：重算表與重匯出的時間不大；真正的成本是**品質**：靜態縮放通常會影響短文字的表現（公開說法，未量），所以必須在短文字與長文字兩組上同時量。
- 需要的資料：長文字的評量（§13.5），不需要新訓練資料即可量**是否退步**。

**(b) 少量長文字微調**
- 必要性：縮放後的模型在長位置上通常要短暫微調才穩定（公開說法，未量）。
- 資料：以 repo 的 `DESIGN.*.md` 等文件串接成長文件（§7.1 的清洗已能切塊，`contextWindowTokens` 可設到 8192），**不需要下載任何資料**。
- 訓練成本（推算）：`cpu-py` 的 60 token/s（訓練吞吐，§4.2）時，一筆 4,096 權杖的樣本約 68 秒/步；100 步約 1.9 小時。`wasm-web` 的 T=32 約 12 秒/步，**T 很大時的時間與記憶體未量測**（§5.6 只試了 T=16 與 32）。
- 記憶體：激活與 T 成正比（逐層檢查點可降低，§5.6 的逐層引擎已有），T=256 以上**未量**。

**(c) 品質與記憶體代價**：縮放後的長上下文品質要用 §13.5 的「取針」測試評量；沒有實測前不宣稱可用長度。

**(d) 工作室的圖形限制**：逐層引擎的圖形在建立時就固定序列長度 T（`LayeredEngine` 的 `T` 參數），**所以長上下文訓練要在建圖時選定長度，不能動態變**。

### 13.3 思考深度（更長的推理軌跡）

**(a) 資料**：老師迴圈目前產生的是題目與答案（§7.3），**沒有推理軌跡**。要做的是：讓老師對每題產生「推理過程＋答案」，程式只驗證**答案**（判題器可以驗證，例如 blockly、matrix），推理過程只作為訓練文字，不驗證其正確性。
- 這裡有一個**誠實的缺口**：推理過程錯、答案碰巧對，程式不會抓到。判題器只能驗答案。
- 送出資料給線上老師需要使用者確認（§7.3）。

**(b) 訓練格式**：Qwen3 的聊天樣板支援思考模式（`enable_thinking`）。repo 的 `lora_common.py` 目前用 `enable_thinking:false`（`DESIGN.TODO.offline-training-studio.md` §5.6 階段 8 的說明）。要訓練思考格式，必須：(1) 把推理包在樣板的思考區塊內；(2) 訓練與推論用同一個 `enable_thinking` 設定；(3) 推論端（`nr-engine.js` 的 `applyTemplate`）也要支援。**`nr-engine.js` 已經用 `applyTemplate(opts.template || 'qwen3-chatml', ..., { enable_thinking: false })`，也就是說推論端目前是固定關閉的。**

**(c) 代價**
- 序列變長：推理軌跡多為數百到數千權杖。訓練時間與 T 成正比（加上注意力的平方項，未量）。
- 推論時間：思考權杖要全部生成，延遲明顯增加（推算：與權杖數成正比；實際速度未量）。
- 網頁版在 WebAssembly 下推論速度未量測。

**(d) 0.6B 容量的誠實上限**：0.6B 是很小的模型，複雜推理的能力上限**沒有實測**。repo 有的相關數字：基底在 `think_stack/plan_check` 的有效率 52/60、`review_return` 0/60、`self_validate` 25/60（§22，基底未微調）。這些不是推理能力的直接量測，只能作為起點。**不宣稱 0.6B 可以深思考**，需要先定義一組可程式判分的推理題，量基底與微調的差距。

### 13.4 原生函式呼叫（function call）

**(a) 現況**（已實作並有數字）：
- `toolcall-r4` 權重（rank 4，v1）：格式合法率 111/202 → 156/202；缺工具拒絕 0/55 → 53/55（§24，v2 判準，**預先登記後量測**）。
- 範圍外（colu、think_stack、decompose）**未量**，所以「沒有退步」不能宣稱。
- 其他題型的產品視窗實測（每題型 3 題，§27.2）只證明路徑通、方向對，**不是統計結論**。
- **誠實紀錄**：§18.1 說明，第一次評量的「缺工具拒絕」判準有錯，之後是**在看過輸出後才修正判準**，這是事後修正（§18.2 與 §20 起改為預先登記）。

**(b) 原生路徑的限制**：
- 原生推論只做純文字：帶 `tools` 或 `prefill` 時會略過原生、改走網頁版（§27.4 第 4 項）。
- `nativeToolMessages`（`vlm_core.js`）把工具折進 system，格式同 Qwen3 官方樣板；**這是「照官方文字比對」，沒有跑同一題兩邊比輸出**（§27.6 未驗證項）。
- 預填：原生樣板接不到預填，讓模型自己生成，只在輸出以預填開頭時採用，否則退回網頁版。**要一律走原生，需要執行包 1.22.0-3。**

**(c) 完整微調後匯出 ONNX q8 或 GGUF 的路徑——現況與阻礙（修正原提案的說法）**

原始需求寫「fp32→ONNX 匯出與量化尚未實作」。**這一點與 repo 紀錄不符，需要更正：**
- 合併（`merge_and_export.py`）、ONNX fp32 匯出（`export_onnx.py`，convert 步驟）、ONNX q8 量化（`quantize_dynamic`，full 配方）、GGUF 轉換與 Q8_0 量化（`export_gguf.py`，llama.cpp b12286）**都已實作，並以真實 adapter 跑過**（§25.2–25.9，§25.12）。
- 完整微調（`train_full.py`）也已實作，**只跑過 4 步 smoke 與暫停續訓**（§25.5）。
- 因此真正的阻礙是**品質與驗證**，不是沒有匯出程式：
  1. **q8 的貪婪一致性不達標**：ONNX q8 與 HF 的貪婪 token 只對上 39/96（§25.4）。原因判斷是 `down_proj` 的離群值（推測，改成 fp32 後餘弦改善但貪婪反而變差，未驗證）。
  2. **完整微調的品質沒有評量**：4 步的 loss 跳動，**不能宣稱模型變強**（§25.5）。
  3. **桌面版對匯出模型的實機載入未驗證**：只用 Python ORT 1.31 與 Node 的 onnxruntime-node 1.22 驗證過（§25.11 第 3 項）。
  4. **匯出的 llm 資產**：`.fatrain` 往返、分片與登錄已完成（§25.11 第 1 項、§25.12 第 1 項）；網頁版頁內生成已有 harness（§25.12 第 2a 項），工作室頁內的點擊**未驗證**。
  5. **上下文延伸需要重新匯出旋轉表**（§13.2 a），匯出流程本身可用。
- 因此：「原生函式呼叫」的路徑是**現有 LoRA 槽版（rank 4）已可用**；「完整微調後匯出」**程式齊全、品質未達標**。

**(d) 多 adapter 的限制**：工具呼叫的 adapter 與其他領域的 adapter 同時套用會互相干擾（§27.3），**目前不可並用**。要同時具備多種能力，只能先選一個 adapter，或走完整微調。

### 13.5 評量方式（先定義，再量）

| 能力 | 評量 | 判分方式 | 目前狀態 |
|---|---|---|---|
| 長上下文（取針） | 在長度 L（例如 1K、4K、8K）的文字中，於不同深度（0%、25%、50%、75%、100%）埋一個事實，問答 | 字串比對（程式判分） | **設計未做**；需要生成測試文字（不需下載） |
| 長上下文（不退步） | 同一組短文字題，比縮放前後 | 同 §5.1 的留出判分 | 設計未做 |
| 思考（可程式判分） | blockly、matrix 的留出題：答案正確率、推理長度分布 | 判題器（需要 Python 與 tree-sitter，§5.2） | 判題器已有；App 內未跑 |
| 函式呼叫格式 | `eval_run.py` 的 toolcall 格式合法率與參數欄位正確率 | 程式解析 `<tool_call>` JSON | 已有（§24） |
| 函式呼叫的工具選擇 | 工具名稱與標準答案是否相同 | 精確比對（§27.2 用的方式） | 已有，**需擴大樣本**（目前每題型 3 題） |
| 量化 | 首步 logits 餘弦、KL、貪婪一致性（對 HF fp32） | 程式計算 | 已有（§25.3–25.4）；**缺分佈級指標（KL）**，§25.4 已指出 |

**預先登記**：所有上表的判準要先寫進 `EVAL_CRITERIA_*.md` 並提交，再量測（§18.2 的守則）。

### 13.6 需要下載的東西（列給使用者決定，本提案不下載）
| # | 項目 | 來源 | 大小 | 用途 | 狀態 |
|---|---|---|---|---|---|
| 1 | Qwen3-0.6B 的 `config.json` | Hugging Face `Qwen/Qwen3-0.6B` | 很小（KB 級，未量） | 讀 `max_position_embeddings`、`rope_theta`、`rope_scaling` | **需要使用者同意**。本環境找不到基底模型 |
| 2 | Qwen3-0.6B 基底權重（bf16） | 同上 | 約 1.5 GB（`DESIGN.lora-training.md` §25.1） | 重新合併、重新匯出、完整微調 | 先前在 `~/fa/desktop-app/lora-train/models/`，本環境不存在；**需要使用者同意** |
| 3 | 基底 ONNX q8（`model_quantized.onnx`） | `onnx-community/Qwen3-0.6B-ONNX` | 約 617 MB | 網頁版與原生推論的起點 | 本環境 `/tmp/slot-t/` 還有一份另一個 session 留下的副本（只讀，未用）；使用者的瀏覽器快取可能也有。**要用的話需要使用者同意** |
| 4 | 更大的基底（例如 Qwen3 的其他尺寸） | Hugging Face | **未查證大小** | 容量上限的比較 | **需要使用者決定**；大小要先查 |
| 5 | 推理與長文字資料 | 不需下載（repo 文件與老師生成） | 不適用 | §13.2 b、§13.3 a | 不需下載；老師生成需要送出資料，要使用者確認 |
| 6 | 執行包 1.22.0-3 | repo 的 `native-runtime` 分支（需要發新版） | 約 30 MB 級（1.22.0-2 的大小） | 預填一律走原生 | 需要管理者發版 |

### 13.7 建議順序（每步都有「做完的定義」）
1. **讀基底 config**（需要同意下載 KB 級檔案）。完成定義：`max_position_embeddings` 與 `rope_theta` 寫進本檔，取代「查不到」。
2. **長上下文取針評量**（不下載，只用生成的文字）。完成定義：基底在 1K、4K 的取針結果有數字（基底未修改）。
3. **旋轉表重算與短文字退步評量**（只做算術與匯出，不訓練）。完成定義：縮放後的模型在短文字留出題上的結果與基底的差距有數字；若退步超過門檻就停下回報，不往下做。
4. **少量長文字微調**（`cpu-py`）。完成定義：取針與短文字留出題都量了；長上下文要有改善、短文字不退步。
5. **思考資料**：先做判題器能驗的題目（blockly、matrix），量基底的正確率；只有基底量到可以改善的空間才生成推理軌跡。
6. **函式呼叫**：擴大留出樣本（目前每題型 3 題不足），先做範圍外的退步量測（§24 的未量項目），再決定是否重訓。
7. **完整微調匯出**：先量 q8 的分佈級指標（KL），再決定配方；**不宣稱品質，除非有任務指標**。

**停止條件**：任一步的退步超過預先登記的門檻，就停在該步並回報，不往下硬做（與 §4.6 的原則相同）。

---

## 14. 待辦路線：解凍基底模型、調整、再強化（2026-11-13，使用者同意排入）

使用者問「有辦法解開基底模型，調整，再強化嗎」，答：可以，`lora-train/train_full.py` 已能解凍全部權重並暫停續訓，但只跑過 4 步煙霧測試，品質未驗證。順序（前一步不過關不做下一步）：
1. 內建 LoRA（toolcall、plan、decompose、code-write、閱讀理解）完成並通過「不輸基底」評量（見 DESIGN.lora-training.md §27.8）。
2. 補 fp32 轉 ONNX 匯出與 q8 量化（目前沒有），輸入輸出須與 app 吃的圖一致（`input_ids／attention_mask／position_ids／past_key_values.*`）；先量分佈級指標（KL）。
3. 部分解凍（最後幾層加輸出層）與完整微調各做一次：訓練資料混入舊任務重播資料防遺忘；每組任務與舊基底比，退步的列出，贏了才換基底。
4. 換基底後，舊 LoRA 全部作廢，需對新基底重訓並重轉槽版模型。
未實作：部分解凍選項、重播資料混合、新基底的 LoRA 相容性檢查。

## 附：舊檔對照與讀法

| 舊檔 | 內容 | 本檔對應 |
|---|---|---|
| `DESIGN.TODO.offline-training-studio.md` | §1–§26 的原始紀錄（時間序，含多次接手節） | §2–§11 的主要來源；證據與實測數字仍以它為準 |
| `DESIGN.lora-training.md` | LoRA 管線、§14 網頁版併權重、§25 匯出、§27 四顆產品視窗 | §4.7、§5.1、§5.8、§8、§13 |
| `DESIGN.offline-trainer.md`、`DESIGN.offline-trainer-roadmap.md` | 符號式離線訓練器與成長迴圈 | §5.6 |
| `DESIGN.offline-harness.md` | 意圖切分與工具呼叫的通用 harness（影片領域） | 不屬於工作室（影片編輯的推理鏈）；只在 §5.6 提到相關性 |
| `DESIGN.native-all-models.md` | 其他模型的原生執行器（量測表與記憶體） | §12.3、§4.2 |
| `DESIGN.offline-vision*.md`、`DESIGN.edit-picture-diffusion.md` | 視覺模型與圖像細化 | §12 |

**讀法建議**：要知道「現在能做什麼」讀 §10 與 §11；要知道「怎麼做的」讀 §2–§9；要對一個數字追根源，用 §10 的出處列表回到舊檔。
