# Python API 轉接層（技能包腳本）設計文件

> 原始碼：`renderer/src/pybridge/*.py`（`fa_bridge.py`、`fa_run.py`、`playwright/sync_api.py`），由 `scripts/embed-code-ui.js` 嵌入 `renderer/src/floating-assistant.js` 的 `FA_PYBRIDGE_FILES`；主機端 `_pyBridge*` 方法；桌面版啟動改寫在 `renderer/bootstrap.js` 的 `run_command`。

## 為什麼

技能包的腳本常是為別的環境（例如 Claude）寫的，例如用 Playwright 連 Chrome 遠端除錯埠。靠提示叫弱模型「讀懂再改寫」不保證它照做，也不能假設腳本用的是哪些公開 API。所以多加一層**不依賴模型理解**的保險：腳本照原樣執行，但執行期間部分公開 API 實際是接到助理自己的工具／領域。

## 範圍與開關

- 只在**執行技能包期間**生效（`_delegateToSubagentDomain` 對 `skill_*` 領域計數 `_pyBridgeDepth`），一般的 python／run_command 不受影響。
- 設定 `pythonApiBridge`：`skill`（預設）／`off`。
- 桌面版與網頁版都支援（兩種傳輸，同一套主機端分派 `_pyBridgeDispatch`）。

## 兩種傳輸

| | 桌面版（run_command，真的 Python） | 網頁版／Pyodide（python_execute） |
|---|---|---|
| 啟動 | 把 `python x.py …` 改寫成 `python fa_run.py --rpc <信箱> -- x.py …`（含 `cd … && python x.py` 的一行指令、與 command＋args 兩種寫法） | 執行前把檔案寫進 Pyodide 檔案系統 `/fa_pybridge`，放進 `sys.path` 最前面 |
| 通道 | 檔案信箱 `.floating-assistant/pybridge/rpc/<runId>/req-*.json → res-*.json`，主程式在腳本執行期間輪詢處理；不開網路埠、不需要改主程式 | 註冊 JS 模組 `_fa_pybridge`，Python 用 `asyncio.run` 呼叫（與既有 subprocess 橋接相同的 JSPI 作法） |
| 等待 | `time.sleep` | `_fa_pybridge.sleep`（不能卡住頁面） |

截圖等檔案一律由 Python 端寫檔（兩種環境的檔案系統不同，相對路徑以腳本自己的工作目錄為準）。

## 轉接的 API

- `playwright.sync_api`：`sync_playwright()`、`chromium/firefox/webkit.connect_over_cdp()/launch()`、browser／context／page／locator 的常用子集（goto、inner_text、locator.first/count/screenshot、evaluate、wait_for_*、close…），每個動作對應到瀏覽器控制的 `tab_create／tab_navigate／get_page_text／tab_eval／screenshot／tab_close`。使用者的登入狀態就是他自己 Chrome 的狀態。
- `openai`、`anthropic`：全路由，見下方「LLM 轉接」。
- 沒支援的功能丟出說明清楚的 `NotImplementedError`，指向 `fa_bridge.tool(...)`／`fa_bridge.domain(...)`。
- 通用通道：`fa_bridge.tool("browser_…", …)`（僅開放瀏覽器控制工具）、`fa_bridge.domain("browser_control", "任務")`（委派給任何已啟用的領域）。

## 回報

`run_command` 結果多一個 `python_api_bridge: {used, calls, ops, note}`，讓上層 AI 知道哪些呼叫被轉接；腳本 stderr 會印一行 `[fa-bridge] …`。

## 驗證

桌面版：原封不動的 `host_capture.py`（用 `connect_over_cdp`、`locator().screenshot()`）在沒有 Chrome 除錯埠、以假的瀏覽器控制回應下執行成功，輸出數字與截圖檔；網頁版：Pyodide 內 `python_execute` 同樣成功；關閉設定後轉接版從 `sys.path` 移除。

## LLM 轉接（openai、anthropic、直接送 HTTP）

模組：`fa_llm.py`（格式轉換與共用呼叫）、`openai/`、`anthropic/`、`fa_sim.py`（模擬）、`fa_http.py`（requests／httpx／urllib 攔截）、`fa_net.py`（一般 HTTP 與 http.client）、`fa_fs.py`（網頁版檔案導向 fap）。腳本自己的 base_url、金鑰、model 都忽略，一律由助理已設定的 LLM Model 回答。

**主機端 op**：`llm.info`、`llm.complete`（聊天）、`llm.upstream`（embeddings／圖片／語音，帶 `cap`）、`sim.note`（登記哪些 API 是模擬）、`fs.*`、`net.local`、`net.fetch`。

**涵蓋範圍**：同步、非同步（`AsyncOpenAI`／`AsyncAnthropic`）、串流（把完整回應切塊，不是真的邊產生邊送）、`with_raw_response`；OpenAI 的 chat.completions、responses、completions、embeddings、images、audio（轉文字、翻譯、語音合成）、tools、vision、models、舊版模組層級呼叫；Claude 的 messages（含 stream、tool_use／tool_result、count_tokens）、舊版 completions、models。

**依能力挑 Model**（不是預設就不支援）：
- 工具呼叫、讀圖：依各 Model 的 `abilityTags`——標 true 的先、沒測過的其次、標 false 的不用。
- embeddings、圖片、語音：用各 Model 設定的網址查 `GET /models`，用名稱特徵挑候選，逐一嘗試。
- 全部 Model 都不支援才丟 `NotSupported`（`openai.NotSupportedError`／`anthropic.NotSupportedError`，同時是 `NotImplementedError`；走原始 HTTP 則回 501）。**不會**用假結果頂替。

**模擬**（沒有對應的上游能力時，回傳標示 `fa_simulated` 並登記進 `python_api_bridge.simulated`）：moderation、files（記憶體內）、batches（每一行真的送給 Model）、threads／runs／assistants／vector stores；fine-tuning 回報不支援。

**直接送 HTTP**：攔截 `requests.Session.send`、`httpx.Client／AsyncClient.send`、`urllib.request.urlopen`、`http.client`（之後才 import 的 requests／httpx 也會補上）。依路徑後綴判斷是不是 LLM 端點：OpenAI 標準（/chat/completions、/responses、/completions、/embeddings、/images/*、/audio/*、/moderations、/models）與 Claude（/messages、/messages/count_tokens），主機不拘；回應格式跟被呼叫的端點一樣，串流回 SSE。`FA_HTTP_BYPASS_HOSTS=host1,host2` 可讓指定主機不被攔截。

## 一般 HTTP 與 http.client（`fa_net.py`）

非 LLM 端點的請求有兩個去處：

1. **本機網址**（127.0.0.1、localhost、[::1]、`*.localhost`、`*.local`）：沙盒有 **mock 伺服器**（`sandbox_mock`，跟 AIDoc 模擬 web request／websocket 同一層，資料存在 IndexedDB 的持久儲存）就接給它。`<名稱>.local` 指定該名稱；其他本機網址用開著的那一個；沒有開著但之前部署過、且只有一個（或網址指名）就自動開起來。沒有 mock 伺服器：網頁版回 `ConnectionRefusedError`（說明要先部署）；桌面版照原本連真的本機伺服器。
2. **外部網址（只有網頁版）**：Pyodide 沒有 socket 又有 CORS，改走 `_terminalHttpFetch`——有設定 proxy／Cloudflare Worker（`assetBackupProxyUrl`）就經過它，沒設定就直接 fetch。桌面版外部網址照原本連網。

`http.client` 的 `HTTPConnection／HTTPSConnection.request()` 會先問路由；有人接手就不連線，`getresponse()` 回標準 `HTTPResponse`（HEAD 無本文）。urllib、requests（urllib3）底層都用它，所以也走同一個出口。

## WebSocket（`fa_ws.py`）

Python 的 WebSocket 用戶端連本機網址時接到同一個 mock 伺服器（`hub.wsOpen`）：`websocket-client`（`create_connection`、`WebSocketApp.run_forever`）與 `websockets`（`sync.client.connect`、`connect()`／`asyncio.client.connect` 的 `async with`、`await`、`async for`）。主機端 op：`ws.open／send／recv／close`；收訊息是短輪詢（每次最多等 250 毫秒），非同步程式同時收送不會互相卡住。規則與 HTTP 一樣：有 mock 伺服器就接；沒有則網頁版丟 `ConnectionRefusedError`、桌面版照原本連；外部網址網頁版丟 `ConnectionError`（沒有 WebSocket 出口）、桌面版照原本連。模組之後才被 import（例如 Pyodide 用 micropip 現裝）也會補上。

## 網頁版檔案導向 fap（`fa_fs.py`）

Pyodide 的檔案寫入繞進 fap：`/fap/<名稱>/…`、`fap:<名稱>/…` 指定，一般路徑走預設 fap（設定 `pythonBridgeFap`→第一個已授權的→OPFS 工作區 `ws-<名稱>`→第一個）。讀取先抓到快取資料夾 `/fa_fap_cache`，寫入在關檔時推回。`/tmp`、`/proc`、`/dev`、`/lib`、`/usr`、`/fa_pybridge`、`/fa_fap_cache`、`/work`（python_execute 的工作目錄，是工具自己的輸出管道）等系統路徑留在本地。轉接關閉時（`fa_bridge.ACTIVE = False`）全部放行。注意 Pyodide 的 `sys.prefix` 是 `/`，不能拿來當系統路徑前綴。

## 已知限制

- 串流是模擬的（完整回應切塊），不是邊產生邊送。
- 不攔 `aiohttp`、自己用 `putrequest／putheader／endheaders` 逐步組請求的 http.client 程式、`aiohttp` 的 WebSocket、`websocket-client` 的底層 `WebSocket` 類別（只攔 `create_connection` 與 `WebSocketApp`）。
- Realtime API 不支援。
- `shutil.rmtree`、`os.walk` 在 fap 路徑上支援有限。
- 網頁版外部網址沒有 proxy 時可能被 CORS 擋下。

## 驗證

- 單元測試（假的主機端）：LLM 路由 35 項、一般 HTTP 10 項、WebSocket 19 項（`websocket-client` 用最小的假模組驗證包裝邏輯，沒有用真的套件測）。
- 真實 Electron：桌面版真的 Python 與網頁版 Pyodide——聊天、工具、串流、embeddings、圖片（無模型時丟 NotSupported）、原始 HTTP（requests／httpx／urllib／http.client）、非同步、fap 寫檔（OPFS 工作區實際出現檔案與追加內容）、`http.client` 連 127.0.0.1 接到 mock 伺服器（GET／POST／CRUD、urllib）、`websockets`（真的套件）同步與非同步連 mock 伺服器收發（桌面版真的 Python、網頁版 Pyodide 用 micropip 現裝）、外部網址經 proxy、沒有 mock 伺服器時網頁版拒絕、桌面版放行。

## 之後可擴充

新增別的公開 API 的轉接（例如 `selenium`）：在 `renderer/src/pybridge/` 加一個同名套件、在 `_pyBridgeDispatch` 加對應 op 即可。

## 圖片訊息的轉接（2026-10-06）

腳本用 openai／anthropic 送**圖片訊息**時，host 不再直接打線上 LLM，改走外層抽象的 vision API（`_visionDescribe`）：依設定 `visionBackendPolicy` 決定線上視覺模型或離線模型的優先順序與備援（沒有可用的視覺模型或全部失敗 → 離線模型，已下載才會用）。回傳維持 OpenAI 形狀，走離線時 `model` 是 `offline:<模型>` 並多一個 `x_vision` 診斷欄位。另提供直接呼叫：op `vision.describe`／Python `fa_llm.vision_describe(image, prompt)`（`image` 可以是 bytes、檔案路徑、data URL、網址）。提示詞格式（OCR／描述／問答、各模型自己的格式）由抽象層處理。詳見 `DESIGN.offline-vision.md` §8。

## GPU 相容層（numba／cupy／torch／pycuda，2026-11-15）

目標：既有的 CUDA／GPU Python 程式（`from numba import cuda`、`import cupy`、`import torch`、`import pycuda.autoinit`）**不改一行、不需要 `import cudaweb`**，就能在 Python 模擬器（桌面版真的 Python、網頁版 Pyodide）裡執行。執行的是瀏覽器的 WebGPU／WebGL2（或 CPU），**不是真 CUDA**；執行時 stderr 會印一行 `[fa-bridge] CUDA 相容層：目前使用 <層>（<原因>）`（只印一次）。

**設計與實作（已完成的部分）**

- 墊片放在 `renderer/src/pybridge/`：`fa_gpu.py`（共用核心）、`numba/`、`cupy/`、`torch/`、`pycuda/`。
- **一份墊片、兩種傳輸**：桌面版經 `fa_bridge` 的檔案信箱（`gpu.call`／`gpu.info`，`python fa_run.py --rpc …`）；網頁版經 Pyodide 的 JS 模組 `_fa_gpu`（不依賴技能包的橋接開關）。主機端 `_pyBridgeGpu` 把 op 轉給 `_cudawebCall`（`renderer/src/gpu/gpu_core.js`，同一個 cudaweb 執行期）。
- **大陣列不走 JSON**（桌面版）：float32 `.bin` 放在信箱資料夾，op 只傳路徑與長度；結果同樣寫成 `.bin`，讀完即刪。網頁版仍傳 list（尚未改成直接傳 TypedArray）。
- **真套件優先、不遮蔽**：`fa_gpu.install()` 安裝一個 meta-path 尋找器。最上層名稱是 `numba`／`cupy`／`torch`／`pycuda` 時，若 `sys.path` 裡找得到真套件就回傳真套件的 spec；找不到才提供墊片。子模組交給父套件的 `__path__`。測試用 `FA_GPU_FORCE_SHIM=1` 一律用墊片。
- **衝突規則**：只攔上面四個名稱；`cudaweb` 仍是獨立的明確 import（`renderer/src/pybridge/cudaweb.py`），不受本層影響。
- **設定**：`advancedSettings.cudaCompat`，`'on'`（預設）／`'off'`。`pythonApiBridge` 原有設定不變。網頁版每次 Pyodide 執行前依設定安裝或拿掉尋找器。桌面版由主機把設定傳給 `fa_run.py`（`--cuda-compat on|off`、`--cuda-f64 auto|f32|exact`），`fa_run.py` 設成環境變數 `FA_CUDA_COMPAT`、`FA_CUDA_F64`；關閉設定在技能包與一般 run_command 都生效。
- **設定介面**（2026-11-15）：`_gpuCompatControls()` 是唯一的建構函式，掛在 AI 助理設定的 `ai` 分組（分頁「GPU 相容層（numba／cupy／torch）」）與桌面版設定頁（`bootstrap.js`，「GPU 相容層（numba／cupy／torch／pycuda）」區塊）。內容：開關 `cudaCompat`（預設開）、`cudaCompatFloat64` 下拉（auto 預設／f32／exact，附精度與速度差異）、按「重新偵測」顯示 `backendInfo` 摘要（WebGPU 是否可用、原因），以及最近一次執行的層與原因。開啟設定時不會自動偵測。`index.html` 沒有 AI 助理設定分頁，所以只有上面兩處。
- **一般 run_command 的 GPU-only 模式**（2026-11-15）：不在技能包裡時，`cudaCompat` 為 on 且腳本 import numba／cupy／torch／pycuda，指令才改寫成 `fa_run.py --gpu-only …`；這個模式只接受 `gpu.*` 操作，不開 LLM、瀏覽器等其他轉接，其他 Python 指令照原樣執行。腳本讀不到（相對路徑又沒有 cwd_abs）時交給 `fa_run.py` 判斷，不需要墊片的腳本照原樣執行。判斷規則與網頁版 `gpu_preload.js` 的 `scriptNeedsNumpy` 相同（`scriptNeedsShim` 匯出）。
- **回報**：宿主回傳 `layer`、`reason`，墊片記在 `fa_gpu.STATS`（`layer`、`reason`、`calls`、`ops`）。`python_api_bridge.gpu = {layer, reason, calls}`：桌面版（技能包或 GPU-only 的 run_command 結果）與網頁版（`python_execute` 結果）都有；每次執行開始歸零，`layer` 是最後一次 call／kernel 實際執行的層（`T1`＝WebGPU，`CPU`＝本機 Python 模擬，其餘見 DESIGN.webgpu-cuda.md）。

**支援矩陣（第一階段）**

| 套件 | 支援 | 不支援（呼叫時丟出的錯誤會指出行號或名稱，並給建議） |
|---|---|---|
| `numba.cuda` | `@cuda.jit`、`@cuda.jit('簽名')`（簽名只記錄）、`kernel[blocks, threads](args)`（整數或最多三維 tuple）、`cuda.grid(1|2|3)`、`threadIdx／blockIdx／blockDim／gridDim`、`cuda.syncthreads()`（有屏障時用執行緒加屏障模擬）、`cuda.shared.array`、`cuda.atomic.add`、`to_device`、`device_array`、`device_array_like`、`copy_to_host()`、`is_available`、`synchronize`、`get_current_device()` | `device=True`、`stream`、`event`、`compile_ptx`；核心內的 `try／with／yield／lambda／推導式／遞迴／print／巢狀函式／global／raise`；未列入的 `cuda.*` 與 `print` |
| `cupy` | `array／asarray／zeros／ones／empty／arange`、四則運算與 `@`、`matmul／dot`（二維與一維走 GPU）、`sum`（一維走 GPU）、`mean／max／min`、`exp／log／sqrt／tanh`、`asnumpy`、`cuda.Device`、`cuda.runtime.getDeviceCount`；其餘 numpy 同名項目退回 numpy | `RawKernel`、`ElementwiseKernel`、`cupyx.*`（丟 `CupyCompatError`，建議用 numpy 或 `@numba.cuda.jit`） |
| `torch` | `tensor／zeros／ones／randn／rand／arange／from_numpy／manual_seed`；`.to('cuda')／.cuda()／.cpu()／.numpy()／.item()`；`torch.cuda.is_available／device_count`；`matmul／mm／softmax／relu／sigmoid／tanh／exp／log／sqrt`；`nn.Module／Parameter／Linear／ReLU／Sigmoid／Tanh／Softmax／LayerNorm／Sequential／MSELoss／CrossEntropyLoss`；`nn.functional` 的 softmax、relu、sigmoid、tanh、silu、gelu（tanh 近似）、layer_norm、rms_norm、mse_loss、cross_entropy；`optim.SGD（momentum、weight_decay）／AdamW`；`backward()` 用小型 numpy 自動微分 | `bmm`、`cat`、`compile`、`autograd.grad`、`nn.Conv2d` 等（丟 `TorchCompatError`，訊息格式「未支援：torch.<名稱>，建議 <替代>」）；Tensor 上未實作的方法（如 `argmax`）為一般 `AttributeError` |
| `pycuda` | `pycuda.autoinit`、`pycuda.driver`（`init`、`Device`、`mem_alloc`、`memcpy_htod`、`memcpy_dtoh`） | `SourceModule`（CUDA C）：明確回報「尚不支援 CUDA C 原始碼，請改用 `@cuda.jit`」 |

**執行層（誠實說明）**

- `numba.cuda` 核心先轉成 WGSL（`renderer/src/pybridge/numba/wgsl.py`，`DESIGN.webgpu-cuda.md` §4 的第一批），交給宿主的 `kernel` 操作在 WebGPU（T1）執行。支援範圍：逐元素一維與二維 `cuda.grid`、二維陣列索引、`for i in range(…)`、if／else、算術與比較、`cuda.atomic.add`（int32 陣列，WGSL `atomicAdd`）、純量參數（寫成常數）。
- **float64（Python 預設的浮點）由設定 `advancedSettings.cudaCompatFloat64` 決定**（預設 `auto`；宿主在 `gpu.info` 回傳 `f64Mode`，墊片讀取）：
  - `exact`：float64 陣列保持與 CUDA 同精度，核心退回本機 Python 模擬（訊息說明原因）。
  - `f32`：float64 陣列轉成 float32 在 WebGPU 執行，結果轉回 float64；stderr 印一行「精度降為 float32」。
  - `auto`（預設）：雙 float32（double-float，`hi + lo`，TwoSum／TwoProd、WGSL `fma`）在 WebGPU 執行，有效精度約 48 位元。**與原先的假設不同**：沒有要求輸入先能無損表示成 float32；雙 float32 比單 float32 精度高，所以直接用它。寫回前做抽樣檢查：Python 模擬只跑第一個區塊，與 GPU 結果比對（相對誤差 1e-9），不一致就退回模擬並說明。核心含原子加時無法抽樣，直接退回模擬。
  - 雙 float32 支援逐元素的 `+ − ×`、比較（`< <= > >= == !=`）、`min／max／abs`；除法、次方、取餘、`math.*` 在 dd 模式直接拒絕並說明（退回模擬）。
  - **未驗證**：WGSL 的 dd 程式沒有在真的 GPU 上執行過；測試只用 Python 鏡像演算法（`np.float32` 逐步模擬）驗證精度約 1e-13 量級，以及假宿主的傳輸與寫回。
- **退回本機 Python 模擬的情況**（每次都會印出具體原因）：核心含 shared 記憶體或 `cuda.syncthreads`（需要工作群組共享記憶體，下一批）、float32 原子、三維 blocks／threads、每個工作群組超過 256 個執行緒、宿主沒有 WebGPU（此時 WebGL2 沒有任意核心的執行路徑）、dd 不支援的運算、或 WGSL 執行失敗。訊息格式：「此核心因為 <原因> 在本機 Python 模擬執行，沒有用到 GPU」。
- `cuda.device_array` 預設 dtype 為 float64（與 numba 相同）；舊的 float32 預設已改掉。
- WGSL 的正確性只能在真的 GPU 上驗證（測試宿主只驗證傳輸與寫回，見下方「測試」）。
- **核心原始碼怎麼取得**：`@cuda.jit` 需要函式的原始碼。先用 `inspect.getsource`（桌面版跑檔案時成立）；網頁版助理用字串執行腳本（`runPythonAsync`），沒有檔案，所以主機端在每次執行前用 `fa_gpu.register_script` 登記腳本文字，墊片依函式名稱、起始行與編譯後的程式碼對應出區塊（裝飾器與多行簽名都包含）。都找不到時的錯誤會說明原因（python -c、REPL、exec 產生的程式）與解法。
- `cupy` 的 matmul、dot、一維 sum 與 `torch` 的 cuda 裝置前向 matmul 會經過 GPU 橋接（cudaweb）；GPU 橋接失敗時退回 numpy 並說明。
- `torch` 的反向傳播一律在 numpy 做（第一階段）。

**未完成（列出來，不靜默）**

- 網頁版陣列尚未改成直接傳 TypedArray（目前是 list）。
- GPU-only 判斷用的規則會把字串裡的 `import numba` 也判成需要（與網頁版相同的誤判方向：只多裝墊片，不改輸出）。
- 網頁版 `python_execute` 的 `python_api_bridge.gpu` 只在非同步執行路徑回報；同步路徑（`_runPyodideScriptSync`）不回報（目前沒有呼叫端需要）。
- 雙 float32（auto）的 WGSL 在真機上只有管理者在使用者 Chrome 的一項實測（見 DESIGN.webgpu-cuda.md §9.w），桌面路徑（真 Electron）的 GPU-only 與設定傳遞還沒有真機驗證；目前是假的宿主與子行程測試。

**測試**

- `renderer/src/gpu/gpu_kernel_test.js`：4 項（假 WebGPU 裝置：綁定、寫回、無 GPU 與執行失敗的原因）。
- `renderer/src/gpu/fa_gpu_py_test.py`：48 項（一般 run_command 的 GPU-only 模式：純腳本不動、墊片腳本只裝墊片、cudaCompat off、float64 模式傳遞（子行程跑 fa_run）；float64 三種模式、抽樣檢查失敗退回、dd 的 WGSL 文字與拒絕訊息、pack／unpack 往返、dd 演算法的 Python 鏡像精度；另含安裝清單與目錄掃描比對、桌面版與網頁版過濾後的真實 import、WGSL 文字檢查、端到端傳輸），用假的宿主（照 `_pyBridgeGpu` 協定，陣列走 float32 `.bin`）證明：不 import cudaweb 就能跑 NVIDIA 教學寫法的範例（numba 向量加、矩陣乘與原子直方圖、torch MLP 訓練迴圈、cupy 陣列運算）並與 numpy 一致；`syncthreads`＋共用記憶體；子集外語法的錯誤訊息；cupy 與 torch 的 GPU 橋接路徑與失敗退回；`.bin` 清理；stderr 只印一次；真套件優先的尋找器；pycuda 記憶體搬移。
- 範例：`renderer/src/gpu/examples/numba_vector_add.py`、`numba_matmul_hist.py`、`cupy_basic.py`、`torch_mlp_train.py`。
- **未驗證**：宿主 JS（`_pyBridgeGpu`、`_fa_gpu`）只做了 `node --check` 與靜態閱讀，沒有在真的 Electron 或瀏覽器裡跑過；真 WebGPU 的端到端驗證留給管理者用使用者的 Chrome 做。

## WebGL2 畫布、`gl3d` 與 run terminal 範例（2026-11-18）

目標（使用者要求）：run terminal 的預設資料夾 `/work/examples/python/{gui,game,gpgpu}/` 要有可直接執行的範例；圖形層要有 3D／OpenGL 整合；gpgpu 範例要能切換計算來源（純 CPU／GPU）。

### 協定（`renderer/src/gui/gui_bridge.js`、`gui_render.js`、`gui_host.js`）
- `canvas` 節點多一個屬性 `gl: true`，就是 WebGL2 畫布；鍵盤、滑鼠、滾輪、`fps` 的 frame、`resize`、`fit` 全部沿用 2D 畫布。
- 三個新操作（只能對 `gl` 畫布）：`glbuf`（具名緩衝區，base64 位元組，型別 `f32`／`u16`／`u32`，每個 ≤4 MB、每畫布 ≤24 個；`data: null` 移除）、`glprog`（具名 GLSL ES 3.00 程式，頂點與片段各 ≤16000 字元，必須以 `#version 300 es` 開頭，每畫布 ≤12 個）、`glframe`（一幀的指令串，≤256 條）。2D 的 `draw`／`image` 對 `gl` 畫布會被拒絕，反之亦然。
- 幀指令：`clear`、`state`（depth／blend／additive／cull；additive＝加成混合 `SRC_ALPHA, ONE`，重疊的光點會相加）、`use`、`uf`（1／2／3／4／9／16 個浮點＝float／vec2／vec3／vec4／mat3／mat4）、`ui`、`attr`（屬性名、f32 緩衝區、size、stride、offset、divisor）、`index`（**只作用於下一個 `draw`**）、`draw`（points／lines／line_strip／triangles／triangle_strip、first、count、instances）。橋接層檢查形狀與上限、檢查 `use`／`attr`／`index` 指到的程式與緩衝區確實存在；繪製端（`paintGl`）才編譯與上傳（依版本號只做一次），失敗以 `glerror` 事件回報給程式（≤400 字）。
- 著色器是在使用者 GPU 上執行的程式，橋接層只能限制大小與格式，**無法**防止無窮迴圈的著色器卡住 GPU；文件與 `gl3d.py` 檔頭都寫明。
- 單行上限：一般訊息仍是 8192 位元組；`image` 與 `glbuf`（承載資料的操作）放寬到 6 MB（操作名必須在行首 120 字元內）。這同時修了既有問題：圖片走終端機的 Worker 路徑時，超過約 6 KB 就被 8192 位元組上限擋掉，與「圖片 ≤256 KB」不一致。
- `resize` 事件到達時主機用最新資料重畫該畫布（改畫布尺寸會清空 2D 與 WebGL 的緩衝區；只在狀態改變時才畫的程式原本會變空白）。
- 圖片：`Window.image(..., name=)` 同名重註冊取代舊圖、不佔 16 張上限（連續更新畫面用）；主機在新圖解碼完成前繼續顯示舊圖（不閃爍）；`["image", name, x, y, w, h, flip_x, flip_y]` 翻轉。

### Python 端
- `gui.py`：`canvas(..., gl=True)`、`glbuf`、`glprog`、`glframe`。
- `gl3d.py`（`renderer/src/pybridge/`，隨 `FA_PYBRIDGE_FILES` 嵌入）：mat4 數學（column-major 16 浮點）、軌道相機 `Camera`、幾何（`cube`、`sphere`、`grid_lines`、`axes_lines`）、內建程式 `flat`／`lit`／`points`／`dots`、`FrameBuilder`（`mesh`、`lines`、`points` 與原始指令）、`View`（畫布＋相機＋程式＋事件轉送）。**不是 PyOpenGL**：沒有全域 GL 環境與 `glXxx` 函式。
- 圖形 Worker：`py.loadPackagesFromImports(src)` 先載入 numpy 等內建套件；`fa_gpu._rpc` 在 Worker 內沒有 `_fa_gpu` 時改走 `fa_bridge.call("gpu."+op)`（頁面端 `_pyBridgeDispatch` 已分派 `gpu.*`）。所以 `from numba import cuda` 的核心在圖形程式裡也能上 GPU。

### 範例與預設資料夾
- 原始碼 `renderer/src/examples/python/{game,gui,gpgpu}/*.py` 與 `README.md`，`scripts/embed-code-ui.js` 嵌成 `FA_PY_EXAMPLES`（`/* PYEXAMPLES-BEGIN */`），新終端機 session 建檔案系統時播種到 `/work/examples/python/…`（`_ensureTerminalFsStore` 的 `seedFiles`）。`_` 開頭的檔案（測試台 `_harness.py`）不嵌入。
- gpgpu：`nbody3d.py`（照 `/home/hungfu.lee/下載/SRC/sdlmm/exams/nbody3d.c` 移植，見下）、`fluid3d.py`（SPH 流體，兩個核心：密度、力）。計算來源：視窗上的 CPU／GPU 按鈕、`--device cpu|gpu|auto`、`--bench`（不開視窗，兩邊計時並比對結果）。GPU 來源用 numba `@cuda.jit`；若相容層退回 Python 逐執行緒模擬（比 numpy 慢很多），程式偵測 `fa_gpu.STATS["fallbacks"]` 增加就自動退回 CPU 並在畫面說明。
- `nbody3d.py` 對齊 C 版：NVIDIA nbody 的軟化重力（`F = G·m_j·r / (r²+ε²)^1.5`）、質量 200–299、盒內均勻隨機初始與零初速、`clampf` 軟夾制（超過上限往回移一半，不是截斷）、每 2000 幀印出「N 秒」並在同樣範圍內重新隨機化 MAX_X/Y/Z、MAX_Velocity、Gravity_Coef、SOFTENING 後重來、預設 3072 個、重力位能最高者附近（半徑 100、權重 質量/(距離+1)）的星團中心追蹤、相機位置公式與平滑過渡、青色系 `glowColors`、座標縮 0.1、粒子大小與模擬係數兩個滑桿、`C`／`R`／`H`／`+-`／方向鍵／滑鼠拖曳。繪圖用 `gl3d` 的 `glow`（高斯點精靈＋additive）。刻意的差異（檔頭也寫了）：① C 版以 OpenMP 就地更新位置（資料競爭），這裡同一幀所有天體看到同樣位置（確定性）；② 相機是右手座標（C 版是左手），畫面左右鏡像；③ C 版一開始「追蹤開、快照中心 0」，雲團大半在畫面外，要按兩次 `C` 才置中；這裡每個週期開始時把快照設成新盒子中心，第一幀就置中（按 `C` 仍照 C 版快照星團中心）。計算來源：`pairwise_cpu`（numpy）與 numba 核心 `nbody_kernel`（每個天體一個執行緒、迴圈全部天體，輸出三軸加速度總和與位能）；積分與 `clampf` 在主機端 numpy。核心已用 `wgsl.compile_kernel` 轉成 WGSL，模擬執行與 numpy 版相對誤差約 1e-7。
- 無頭測試台 `examples/python/_harness.py`（close 只送一次，pygame 的 `event.get()` 會一直 poll 到 None；先前每次都回 close 會無限迴圈，由 game 範例的子代理發現並修正）：假的 `fa_bridge`，照橋接層上限檢查（2D 每幀 ≤200 指令、圖片、GL 緩衝區／程式／幀指令、`use`／`attr` 指到已註冊的物件）。

### 驗證現況（誠實）
- 單元測試：`gui_bridge.test.js`（200）、`gui_render.test.js`（143，含假 GL 的指令順序、版本快取、索引只作用一次、無 WebGL2 的單次回報）、`gui_host.test.js`（44）、`gl3d_test.py`（數學、幾何、指令、並把送出的訊息交給真的 JS 橋接層驗證）。
- **真 Electron（Chromium，SwiftShader 軟體 WebGL2，無頭＋xvfb）**：`paintGl` 畫出索引三角形（像素值與預期相符）、換 uniform 的第二幀、壞著色器的編譯錯誤回報；`gl_scene.py`、`nbody3d.py`、`fluid3d.py` 實際送出的訊息經**真的 bridge＋host＋render** 畫出，截圖肉眼確認（立方體、球、格線、點雲、水塊與箱框）。這只證明鏈路正確，**不是真 GPU**：這台沒有可用的獨立 GPU 驗證，WebGPU 路徑（numba 核心實際在 GPU 執行）**沒有驗證**。
- numba 核心：三個核心（`accel_kernel`、`density_kernel`、`force_kernel`）都能由 `wgsl.compile_kernel` 轉成 WGSL；用 Python 模擬執行與 numpy 版比對，相對誤差約 1e-7（N-body）與 8e-6（流體）。
- 未在完整桌面版（含 Pyodide Worker、真終端機）跑過範例；Worker 內 `loadPackagesFromImports` 與 `fa_gpu` 的 `fa_bridge` 後備路徑只做了單元層級檢查。

### 追加（2026-11-18，使用者實跑回報後）
- **疊放容器 `stack`**：子節點畫在同一個區域、後面的在上層，各自撐滿（CSS grid 單一儲存格）。搭配 `canvas(transparent=True)`（2D 畫布每幀從透明開始，不是黑底）可以在 3D 畫面**上面**畫 HUD，而不是把視窗切成上下兩塊。最上層的畫布接收所有滑鼠與鍵盤事件，所以程式要把下層需要的（例如相機拖曳）自己轉過去。`nbody3d.py` 用這個做出和 C 版一樣的覆蓋層：文字、兩個滑桿、CPU／GPU 按鈕都畫在 HUD 上，按在滑桿或按鈕以外的地方拖曳就是旋轉相機（對應 C 版的 `mousefnc`／`mousemotion`）。
- **彈出視窗的疊放順序**：`FaWin`（`renderer/src/ui/win_shell.js`）彈出的視窗原本從 z-index 100000 起算，低於助理主面板與浮動按鈕（999999），所以 GUI 視窗會被蓋在主面板下面。改成基準 1000000（高於主面板、低於應用程式自己的對話框 1000002 以上），並且每次拉到最前面時把所有彈出視窗重新緊湊編號（1000001、1000002…），不再無限往上加而蓋過對話框。實測（Electron）：蓋滿畫面的 999999 面板下，兩個視窗可以互相切換上下層，連點 30 次仍在 1000001–1000002。
- **WebGPU 儲存緩衝區上限**：預設每個階段只有 8 個儲存緩衝區，numba 核心用到更多參數會在建立管線時失敗（使用者實跑 `fluid3d.py` 的力核心有 10 個陣列，退回 Python 逐執行緒模擬，慢到要 Ctrl+C）。`gpu_core.js` 要求裝置時，若介面卡支援超過 8 個，就要求 `maxStorageBuffersPerShaderStage`（最多 16）；要求失敗就退回不帶限制的要求。範例端也改成不依賴這個：`fluid3d.py` 把座標、速度、加速度各打包成一個 N×3 陣列（力核心 4 個綁定），而且兩個 gpgpu 範例啟動前都先用很小的問題試跑一次核心（`probe_gpu()`），跑不起來就直接留在 CPU 並把相容層回報的原因顯示在畫面上。
