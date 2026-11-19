# 環境基準線:依環境可用狀況調整預設值,模型跑完就卸載,寧可慢也不要 OOM

2026-10-31。核心 `renderer/src/env/env_profile.js`(`FaEnv`,純函式 UMD,瀏覽器與服務端都能用,測試 `scripts/env-tests/env_profile.test.js` 33 項)、主機層 `env_host.js`(`FaEnvHost`,混進 `FloatingAssistant.prototype`;embed 區塊 `ENV-BEGIN/END`)、eval `scripts/eval/env_baseline.eval.js`。**使用者的要求:跑得慢沒關係,不要造成 OOM 讓瀏覽器直接殺掉分頁;離線模型跑完一個任務就可以卸載;服務與網頁都依環境可用狀況調整 baseline。**

## 檔位(自動偵測,也可以指定)
`detect(raw)` → `tierOf(facts, override, degrade)`:最弱的指標決定——手機／觸控小螢幕、省流量、記憶體 ≤4GB、Chrome 的 JS heap 上限 <1.1GB 都是 **low**;桌機 8GB+8 核以上是 **high**,其他 **mid**;桌面版若能拿到主行程的真實記憶體(`desktopAPI.systemInfo()`,**還沒做,需要改 preload/main**)就用它(瀏覽器的 `deviceMemory` 最多只回報到 8)。電量很低又沒插電自動降一級;使用者指定的檔位(`advancedSettings.envProfile`,或 `/env low|mid|high`)優先;`envOverrides` 可以個別覆寫政策欄位。

| 政策 | low(手機等) | mid | high |
|---|---|---|---|
| 記憶體預算 | 600 MB | 1800 MB | 5000 MB |
| 模型卸載 | **跑完任務就卸載**(4 秒內又要用就不卸) | 閒置 2 分鐘 | 閒置 10 分鐘 |
| 同時重任務 / Worker | 1 / 2 | 2 / 4 | 3 / 8 |
| 圖最大邊 / 分塊 / 批次 | 1024 / 512 / 1 | 2048 / 1024 / 2 | 4096 / 2048 / 4 |
| 小模型優先 | 是 | 否 | 否 |

## 資源治理(`Governor`)
重資源(看圖模型 gpu／cpu、Whisper 已登記;TTS、本機生圖、圖→3D 還沒登記)登記 `unload()`／`bytes()`:
- **載入前 `acquire`**:先把別的閒置資源依最久沒用的順序卸載到放得下;還放不下但別人正在用 → **排隊等**(不超額同時載入);單一個就超過預算且沒人在用 → 回報 `fits:false`,呼叫端改用小模型或分塊,**不硬載**;等太久(預設 30 分鐘)丟明確的錯誤。
- **用完 `release`／`settle`**:依政策排程卸載(低檔跑完就卸、其他檔閒置才卸;`idleMs:Infinity` 不卸)。
- **壓力**(Chrome 的 `performance.memory`,5 秒一次):≥80% 卸載閒置的到預算 70%;≥92% 全卸並**降一級**(這個工作階段)。
- **OOM**:全域 `unhandledrejection`／`error` 與 `_envGuard(fn)` 認得各種「記憶體不足」說法(WebAssembly、WebGPU device lost、ArrayBuffer、onnxruntime 錯誤碼)→ 降級、全卸載、通知一次;重做時用較省的設定。
- **背景分頁**(手機切到別的 App)與 `pagehide`:低檔把沒在用的全卸載,避免作業系統為了記憶體殺掉分頁。
- `/env`:看目前檔位、偵測到的環境、政策、常駐資源;`/env auto|low|mid|high`、`/env unload`、`/env reset`。

## 模擬 swap(使用者提議:用 FAP／IndexedDB 當交換區,記憶體少也能用)
`renderer/src/env/swap.js`(`FaSwap`,測試 `scripts/env-tests/swap.test.js` 12 項):大塊的中間資料(解碼後的音訊、圖片、網格…)`put` 進來變成 handle,記憶體只留「最近用的」(熱區＝預算的 1/4),超過就把最久沒用的寫到 IndexedDB(瀏覽器把 Blob 存成磁碟檔),`get` 時讀回並算最近用的;`/env` 與記憶體壓力會讓熱區歸零(全寫出)。**慢一點,但不會因為同時握太多大塊資料被殺掉。** 主機層 `fa._envSwap()` 取得共用實例(啟動時清掉上次沒清乾淨的)。**目前只是函式庫,還沒有任何重運算改用它**——接手的人要把「同時握著多份大 buffer」的地方(Whisper 的 PCM 視窗、圖→3D 的深度圖與網格、影片燒錄的逐格、deck 的素材)改成 `put`／`get`／`drop`。桌面版也可以改用授權資料夾(FAP,`fa:fs:*`)當交換區,放得下更大的資料(`store` 可注入)。

## 已接上
- 卸載政策:VLM 閒置卸載(`_vlmScheduleIdle`)、Whisper(`_envSettle`、`_envGuard`)、**本機生圖(`localsd`,`_localSdGenerate` 包 `_envHeavy`)、本機 TTS(`tts`,`_generateTtsInWorker` 包 `_envHeavy`)**——載入前 `acquire` 讓位／排隊,OOM 由 `_envGuard` 接住。單一個就超過預算時**不拒絕**(沒有更小的替代):已卸掉所有別的,載不起來就降級重來。
- 政策欄位:`fileCacheMB`(`_getFileCacheLimitBytes`:設定值是預設 256 時視為沒自己設定,手機 64 MB)、`maxWorkers`(`_mpWorkerCap`;低檔時 `_omCores().hardware` 也封頂,Whisper／VLM 執行緒數)、`maxImagePx`(`FaEditPictures.decode` 夾在政策值以內)、`parallelTasks`(遠端接任務的 `max`、**圖→3D Worker 的 `_envLane`**,低檔一次一件並包 `_envGuard`)、`_i3dLite`、`renderScale`(3D 編輯器與圖片編輯器的畫布解析度上限,`window.__faRenderScale`,低檔 1)。換檔／降級／覆寫時 `_envApplyPolicy` 調整 fileCache 與 swap 熱區。
- `/env set key=值`(`budgetMB maxImagePx parallelTasks maxWorkers fileCacheMB tilePx batch renderScale fps graceMs`,夾在合理範圍)、`/env set reset`。
- 遠端:成員資料帶 `tier`(`_rgSelfInfo`、`_rgPublishSoon`),「交給」下拉標「（低檔）」;執行者接任務的上限取 `min(maxParallel, parallelTasks)`;編輯器遠端 `caps.tier` 早就有。
- 桌面版:`preload.js` 有 `desktopAPI.systemInfo()`、`main.js` 有 `fa:system:info`(**不能熱更新,隨 installer;舊版主程式 renderer 自動退回瀏覽器估計**)。
- 服務端:`FaEnv.rawFromNode(require('os'))`(含 v8 heap 上限)。

## 還沒做(接手的人從這裡開始)
1. MOSS TTS(`_mossLoadBuiltin`)、onnxruntime 其他管線(VLM 以外)、Kokoro 主執行緒退路登記到 Governor;`tilePx`／`batch`(分塊與批次大小:圖→3D、去背、深度)、`fps`(動畫與遊戲試玩)還沒有程式讀;deck 的 viewer3d.js 是獨立打包的原始碼,沒接 `renderScale`。
2. swap 實際接到「同時握多份大 buffer」的地方(Whisper PCM 視窗、圖→3D 深度圖、影片燒錄逐格、deck 素材)。
3. 「自動挑機器」避開 low(目前只顯示標籤)。
4. 設定頁的 UI(目前 `/env`、`/env set`、`advancedSettings.envProfile／envOverrides`)。

## run terminal 的 swap（2026-11-19）：Python `fa_swap`、node `swap`
把 `FaSwap` 接到終端機程式（第一個真正的使用者）。橋接新增 `swap.*`（`_pyBridgeSwap`）：`put`（base64 頁面）／`get`／`drop`／`close`／`stats`，每支程式一個 `space`，程式結束或被 Ctrl+C 殺掉時整個 space 丟掉（頁面經 `FaSwap` 的熱區放 JS 記憶體、其餘放 IndexedDB）。
- Python：`renderer/src/pybridge/fa_swap.py`（`SwapArray`：沿第 0 軸分頁、LRU 熱區、髒頁寫回；索引支援整數、切片含 step、整數序列、多軸；沒有橋接退回記憶體字典）。測試 `fa_swap_test.py`（假橋接），範例 `examples/python/gpgpu/swap_stream.py`。
- node：`gui/js_program.js` 的沙盒 shim 新增全域 `swap`（`array(長度, 型別)`、`get／set／map／fill／free`、`hotMB`、`stats`）與 canvas（`win.canvas／draw／set／poll`），測試 `gui/js_program_swap.test.js`（含三支範例）。
- 範例資料夾改成 `examples/{python,node,llc}`（`FA_PY_EXAMPLES` 的鍵是相對 examples 的路徑，播種到 `/work/examples/`）。
- llc（wasm）沒有 swap：wasm 程式碰不到 IndexedDB；llc 範例是 SDL2／OpenGL／GTK3／OpenCL 的 `.ll`，目前只能在真機編成原生執行（`examples/llc/README.md`）。
- 驗證現況：Python／node 用假橋接測過；**沒有在真 Electron／瀏覽器的 IndexedDB 上跑過**。
- 後續（使用者要求）：不依賴 terminal 的 job 執行層；SDL2／OpenGL／GTK3 走 wasm host import；OpenCL 墊片接 cudaweb（介面預留 PTX 後端）；code template 的 codegen 加 llc、node 目標。
