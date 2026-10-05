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
