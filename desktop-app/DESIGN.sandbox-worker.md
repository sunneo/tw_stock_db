# DESIGN — 網頁開發沙盒（`sandbox_worker`／`sandbox_mock`／`sandbox_html`／`sandbox_py_app`）

> 涵蓋範圍：程式設計領域（programming domains）裡「先實驗再設計」的沙盒實驗後端——
> 前端頁面沙盒（iframe／瀏覽器分頁／彈出視窗）、Web Worker 伺服器沙盒（`sandbox_worker`）、
> **模擬後端**（`sandbox_mock`：頁面照常寫 `fetch`／`XMLHttpRequest`／`EventSource`／`WebSocket`，
> 沙盒把它們接到 Worker 裡的伺服器程式，資料持久化在 IndexedDB，並可匯出成 Node／Cloudflare Workers 部署檔）、
> Python web app 沙盒（`sandbox_py_app`），以及把這些實驗串進 playbook 狀態機的方式。
>
> 對象檔案：`desktop-app/renderer/src/floating-assistant.js`（唯一可編輯原始碼）。桌面版／網頁版共用同一份引擎。
> 行號會飄移，本文件以**函式／常數名稱**為準（用名稱搜尋）。
>
> 撰寫日期：2026-10-03（涵蓋 2026-10-02 當天的實作：模擬後端、補齊 XHR／EventSource／瀏覽器分頁後端、
> 沙盒不使用 Cloudflare 流量、專案結構追蹤對沙盒檔案的支援）。

---

## 0. 設計動機與原則

使用者要的是：AI 在寫「網頁開發」類的程式時，**先在隔離環境做實驗、確認行為，再設計、再實作**；而且實驗要
盡量貼近真實——前端要能連到「後端」，後端要能存資料、推 WebSocket／SSE，最後同一份程式要能**真的部署**。

| 原則 | 具體做法 |
|---|---|
| **實驗先於設計** | playbook 狀態機的 `evaluate → experiment → design → implement → verify → deliver`；`experiment` 階段至少要有一次沙盒實驗紀錄 |
| **測試時能跑、部署也能跑** | 頁面程式碼**完全不為測試改動**（攔截層只存在沙盒、不寫進使用者檔案）；伺服器程式用標準 `Request`／`Response`；`export` 產生 Node／Cloudflare 部署檔 |
| **隔離** | iframe `sandbox` 屬性、全新 `about:blank` 分頁、Worker 沒有 DOM；Worker 內 `fetch` 被限制；**沙盒不使用 Cloudflare Worker 的流量** |
| **持久** | 沙盒檔案系統與 mock 資料存在 IndexedDB（`sandboxFsCache`），重新整理後還在 |
| **誠實** | 沙盒做不到的（真實埠、真實資料庫、TLS、Service Worker、OpenMP／MPI／CUDA…）一律進 verify 階段的 `unverified`，不得宣稱已驗證 |
| **可重現** | 每次實驗帶 `task_id` 會自動記錄成這個任務的一次實驗（backend、expected、observed、ok） |

---

## 1. 總覽

```
 AI（子任務／主對話）
   │  sandbox_capabilities   ← 先問：這個環境有哪些後端可用？
   ▼
 ┌────────────────────────────── 沙盒後端 ───────────────────────────────┐
 │ 前端頁面     sandbox_html   ── iframe │ browser tab(about:blank) │ popup │
 │ 伺服器邏輯   sandbox_worker ── Web Worker（無DOM；fs.* 持久檔案系統）     │
 │ 模擬後端     sandbox_mock   ── Worker 伺服器 + 持久 db/fs + WS/SSE        │
 │                 └─ 與 sandbox_html({mock}) 搭配：頁面端攔截層接到 Worker   │
 │ Python app   sandbox_py_app ── Pyodide（WSGI／ASGI，micropip 套件）      │
 │ 終端機       run-terminal（busybox ash）                                  │
 └────────────────────────────────────────────────────────────────────────┘
   │ task_id
   ▼
 playbook_state（狀態機）＋ _playbookLogExperiment（實驗紀錄）
```

工具（皆 `registerOptional`）：`sandbox_capabilities`、`sandbox_html`、`sandbox_worker`、`sandbox_mock`、`sandbox_py_app`；
狀態機工具 `playbook_state`、領域管理 `programming_domains`。

---

## 2. 能力偵測 `_sandboxCapabilities`

AI 做任何實驗前**必須先呼叫** `sandbox_capabilities`。回傳：

- `environment`：`desktop`（有 `window.desktopAPI`）或 `web`。
- `backends`：
  - `iframe`：永遠可用；`sandbox` 屬性隔離，讀不到本頁資料／網路／儲存。沒給 html 時可「複製目前畫面」快照（`_sandboxCurrentPageDoc`）來實驗 CSS／DOM 修改。
  - `browser_tab`：需要瀏覽器控制（Chrome 擴充功能）已啟用、已允許目前網站，且擴充功能 `capabilities` 含 `eval_js`
    （擴充功能 **v1.3.0** 起有 `tab_set_html`／`tab_eval`）；舊版會回報原因。是全新 `about:blank` 分頁（AI Controlled 群組），與本頁完全無關。
  - `popup`：`window.open` 可用；彈出視窗裡再放一層 sandbox iframe；**需要使用者按一下畫面上出現的按鈕**（瀏覽器的彈出視窗必須由使用者手勢觸發，`_sandboxPopupViaGesture`）。
  - `worker`：`typeof Worker !== 'undefined'`，`persistent_fs: true`。
  - `mock_server`：同樣依賴 Worker，`persistent: true`。
  - `python`：Pyodide＋micropip。
  - `terminal`：busybox ash＋`python -c`（見 `DESIGN.run-terminal.md`）。
  - `service_worker`：**不可用**——Service Worker 必須由同源 script 檔案網址註冊，瀏覽器不接受 blob／data 網址，網頁版無法註冊 AI 剛寫的內容；回傳替代做法。
- `server_programs`：Node／Worker 風格用 `sandbox_worker`；WSGI／ASGI 用 `sandbox_py_app`；真實埠／資料庫／TLS 只能列進 `unverified`。
- `recommendation`：有瀏覽器分頁後端 → `browser_tab`、`iframe`、`worker`、`python`；否則 `iframe`、`popup`…。

---

## 3. 前端頁面沙盒 `sandbox_html`

### 3.1 流程（`_sandboxHtmlRun`）

1. `backend: auto` → 有分頁後端用 `tab`，否則 `iframe`；`tab` 不可用自動降級 `iframe`（附 `notes`）。
2. 帶 `mock` 時先 `_mockOpen`（開 mock 伺服器 Worker，見 §5），把 hub 與設定（hosts／prefixes／block_external）掛到文件。
3. `_sandboxBuildDoc` 組出完整文件：注入偵測程式 **`FA_SANDBOX_BOOTSTRAP_JS`**（收集 console、錯誤、頁面文字，並讓外部用 postMessage 下指令：`report`／`query`／`click`／`type`／`eval`／`wait`），
   有 mock 時再注入 **mock 攔截層 `__faMockShim`**。純 ES5、不含 `</script>`。
4. 依後端開啟：`_sandboxOpenIframe`／`_sandboxOpenTab`／彈出視窗。
5. 依 `steps` 自動操作並檢查，回報 console、錯誤、頁面文字、每個 step 是否成功、`page_ok`、`mock` 摘要。
6. 預設做完就關閉（`keep_open:true` 才保留，讓使用者看）。

### 3.2 `steps` 動作

`click`、`type`、`drag`（dx／dy）、`wait`（ms）、`eval`（js）、`query`（selector）、`expect_text`（contains）、`expect_visible`。
手機畫面實驗：`width:360,height:800`。

### 3.3 傳輸

- iframe：postMessage（父頁面是主頁面）。
- 瀏覽器分頁：沒有父頁面可 postMessage，改成**佇列＋主頁面輪詢**（`cfg.transport === "poll"`，經擴充功能 `tab_eval` 取出訊息、回寫結果）。

---

## 4. Worker 伺服器沙盒 `sandbox_worker`

適合伺服器邏輯、演算法、平行運算實驗（沒有 DOM）。`_sandboxWorkerRun`＋`_sandboxWorkerSource`。

- **程式碼＝async 函式本體**（`AsyncFunction`）：可 `await`、`console.*`；
  - `fs.read(path)`／`fs.write(path,內容)`／`fs.list(prefix)`／`fs.remove(path)`：持久檔案系統（Worker 內以 RPC 轉交主頁面的 `_sandboxFsOp`，存在 IndexedDB）。
  - 想測 web service：定義 `async function handler(request){ return new Response(...) }`，再用 `requests` 參數送測試請求
    （`[{method,path|url,headers,json|body}]`，最多 50 個），回傳每個請求的 `status`／`headers`／`body`（截 3000 字）／`ms`。
  - 想回資料：設 `const result = ...`。
  - 平行運算：程式裡可以 `new Worker`。
- `files`：執行前預先寫入檔案。
- **逾時**預設 10 秒、最多 60 秒（`Promise.race`；超時 `terminate()` 並回報「可能是無窮迴圈或沒有結束的 await」）。
- Worker 內 `self.fetch` 被覆寫：**`_sandboxDenyHosts()`** 列出的主機一律擋下（`*.workers.dev`、`*.pages.dev`、使用者設定的所有 proxy 網址的主機）——
  這是「**沙盒不使用 Cloudflare Worker 流量**」的實作；`localhost／127.0.0.1／[::1]` 不在擋下清單。
- 協定訊息：`__run`、`__rpc`／`__rpc_res`、`__log`、`__done`。

---

## 5. 模擬後端 `sandbox_mock`

### 5.1 為什麼需要它

被測試的頁面通常寫 `fetch("/api/todos")`、`new WebSocket("/chat")`、`new EventSource("/events")`。沙盒裡沒有真的伺服器、沒有可連的埠。
解法：**只在沙盒裡**把這些 API 接到一個 Web Worker 裡的伺服器程式；頁面程式碼一個字都不用改，部署時直接打真伺服器。

### 5.2 元件

```
 頁面（iframe／分頁）                主頁面（本引擎）                     Worker（伺服器）
 ┌───────────────────┐   postMessage/poll   ┌──────────────┐   postMessage    ┌─────────────────┐
 │ __faMockShim      │ ───────────────────▶ │ hub          │ ───────────────▶ │ __faMockWorkerMain│
 │ fetch/XHR/ES/WS   │ ◀─────────────────── │ (_mockOpen)  │ ◀─────────────── │ + __faMockPrelude │
 └───────────────────┘                      │  store(rpc)  │   db/file RPC    │  使用者伺服器程式  │
                                            └──────┬───────┘                  └─────────────────┘
                                                   ▼
                                    IndexedDB（sandboxFsCache）
                                    mock/<name>/server.js｜db/<key>｜fs/<path>｜export/<target>/…
```

三個函式都**必須自給自足**（不能引用外面變數），因為會用 `toString()` 塞進 Worker／iframe／匯出檔：

| 函式 | 位置 | 職責 |
|---|---|---|
| `__faMockPrelude` | Worker＋匯出檔 | 伺服器端的標準庫：`json／text／fail／coerce／router／wsHub／resolve／sse／channel` |
| `__faMockWorkerMain(P)` | Worker | 載入使用者程式、處理 http／WebSocket 訊息、`env.db`／`env.fs` 轉 RPC |
| `__faMockShim(cfg)` | 頁面 | 攔截 `fetch`／`XMLHttpRequest`／`EventSource`／`WebSocket`，二進位用 base64 編解碼 |
| `__faMockBuildExport(target,code,name)` | 匯出 | 把同一份伺服器程式包成 Node／Cloudflare 部署檔 |

### 5.3 伺服器程式的三種寫法（擇一）

```js
// (1) 最簡單：router
const app = router();
app.crud("/api/todos", "todos");                  // GET/POST/PUT/DELETE 自動存 env.db
app.get("/api/ping", () => ({ ok: true }));
app.post("/api/x", async (req, env) => { const b = await req.json(); return json({ got: b }, 201); });
app.ws("/chat", (ws, req, env) => { ws.on("message", (m) => ws.broadcast(m, { includeSelf: true })); });

// (2) handler / onWebSocket
async function handler(request, env) { return json({ ... }); }
function onWebSocket(ws, req, env) { ... }

// (3) Cloudflare 風格
export default { fetch(request, env) { ... } }
```

可用：`env.db.get/set/delete/list(前綴)/clear/nextId(集合名)`（JSON 值，持久）、`env.fs.read/write/list/remove`（文字檔，持久）、
`json(data,status)`／`text()`／`fail(status,msg)`／`sse(setup)`／`channel`、`env.ws.broadcast(path,data)`、`async function init(env)`（載入時跑一次，可放種子資料）。
`ws` 物件：`send／close／on("message"|"close")／broadcast／path／query`。

### 5.4 持久儲存 `_mockStoreOp`

全部放在 `sandboxFsCache` 的 `mock/<name>/` 底下：`server.js`、`db/<key>`（JSON）、`fs/<path>`、`db/_seq/<集合>`（`nextId`）。
操作經 `hub.chain`（Promise 串）**序列化**，避免並行寫入互相覆蓋。

### 5.5 hub（`_mockOpen`）

- `name` 只允許 `[A-Za-z0-9_-]{1,40}`（`_mockNameOk`）。
- 開啟時若同名 hub 已存在先關閉；`reset:true` 先清資料；沒給 `code` 就讀上次 deploy 存的 `server.js`；兩者都沒有就報錯。
- Worker 初始化**逾時 5 秒**；初始化回傳 `routes`／`ws_routes`／`has_on_websocket`。
- `hub.calls` 最多保留 300 筆請求紀錄；`consoleLogs` 最多 300 筆；`hub.summary()` 產生 `mock` 欄位（每個請求的狀態碼、404、5xx、WebSocket 事件）。
- 串流回應（SSE）以 chunk 回傳，`call` 會等 `collect_ms`（預設 300、最多 3000）收集事件，之後 `cancelStream`。

### 5.6 頁面端攔截層 `__faMockShim` 的規則

- **只攔 mock 範圍**：`cfg.hosts`（`mock.local`、頁面自己的 host、使用者指定的 hosts）＋ `cfg.prefixes`（預設有目前畫面時為 `["/api/"]`；空白頁預設所有相對路徑）。
- **範圍外走瀏覽器真實網路**，但 `cfg.deny`（`_sandboxDenyHosts`）的主機一律擋下（`block_external:true` 時全部外部都擋）。
- 保留 `RealWS`／`RealXHR`／`RealES`／`realFetch`；二進位 body 用 base64 傳輸。
- `window.__fa_mock` 暴露 `hosts／prefixes／base／transport`，方便偵測是否已安裝。
- WebSocket 網址請用 `(location.protocol==="https:"?"wss://":"ws://")+location.host+"/路徑"` 或相對路徑，不要用 `location.origin` 拼。

### 5.7 動作 `sandbox_mock`（`_mockToolRun`）

| action | 說明 |
|---|---|
| `deploy` | 存伺服器程式並檢查，回 `routes`／`ws_routes`／`server_console`；之後用 `call` 測 |
| `call` | 送 `requests`（`expect_status` 比對 → `pass`）與 `ws` 多人情境（`clients`＋`script`：`send`／`wait_ms`／`close`），回 `responses`／`failed_expectations`／`mock`／`db_keys`；結束 `hub.close()` |
| `db` | `list／get／set／delete／clear` 檢視或修改持久資料 |
| `list` | 列出所有 mock 伺服器（名稱、db key 數、檔案數） |
| `reset` | `what:"data"` 只清資料；`"all"` 連伺服器程式一起刪 |
| `export` | `target:"node"` 或 `"cloudflare"`：產生部署檔，存回 `mock/<name>/export/<target>/…` |

頁面端整合用 `sandbox_html({mock:"名稱", ...})`；`mock` 也可以是 `{name, code, hosts, prefixes, block_external, reset}` 一次定義。

### 5.8 匯出（`__faMockBuildExport`）

同一份伺服器程式，換掉 `env.db`／`env.fs` 的實作：

| | 沙盒 | Node | Cloudflare Workers |
|---|---|---|---|
| `env.db` | IndexedDB | `DATA_DIR/db/*.json`（`PORT`、`DATA_DIR`、`PUBLIC_DIR` 可用環境變數調整） | KV |
| `env.fs` | IndexedDB | `DATA_DIR/fs/…` | KV |
| 啟動 | — | `npm install && npm start` | 以 Cloudflare Workers 部署（匯出檔內有說明） |

回傳會附 `parity`（三邊一致與差異）與 `unverified`：**匯出的檔案沒有在真實 Node／Cloudflare 執行過**；Cloudflare 的 WebSocket 需要 Durable Objects，匯出檔只提供骨架。

---

## 6. Python web app 沙盒 `sandbox_py_app`

Pyodide 內跑 Flask／Bottle（WSGI）或 Starlette／FastAPI（ASGI）。沙盒不能開埠，所以**直接把請求丟給 app**。
`packages` 用 micropip 安裝（純 Python 套件；第一次較慢）；`requests` 格式同 `sandbox_worker`；`kind` 預設 `auto`（自動判斷 WSGI／ASGI）。

---

## 7. 與 playbook 狀態機的整合

`playbook_state`（`_playbookRun`／`_playbookAction`／`_playbookGuide`）：

| 階段 | 需要什麼 |
|---|---|
| `evaluate` | goal、risks、environment、**backend**（iframe｜tab｜popup｜worker｜python｜terminal）、experiments；程式設計領域另需 layer（改動在哪一層） |
| `experiment` | 實驗用 `sandbox_*({..., task_id})`，結果自動記錄；提交 `verdict`（confirmed／refuted／inconclusive）、conclusion、learned（各 ≥10 字） |
| `design` | 設計文件（Markdown），**必須含該領域的每個必要標題**（缺一個退回）＋ todos（每項要有 test） |
| `implement` | 逐項 TODO：`pending → in_progress → done`；全部完成自動進 verify |
| `verify` | commands、result（≥6 字）、`passed`、`unverified`（沙盒無法驗證的項目；`verification` 為 `sandbox` 的領域可為空） |
| `deliver` | summary（≥10 字）、limitations |

`_playbookLogExperiment(taskId, {backend,title,expected,observed,ok})`：每個 `sandbox_*` 工具帶 `task_id` 時自動呼叫，回傳 `logged_to_task`。
領域資料在 `FA_PROGRAMMING_PLAYBOOKS`（平行、HPC、**Web Service**、生態系、繪圖、嵌入式、BMC、BIOS／UEFI、Android、Windows、iOS）；
`prog_webservice` 的設計標題包含「API 契約」「資料模型與儲存」「驗證與安全」「部署目標」「測試計畫」，實驗建議用 `sandbox_worker`／`sandbox_py_app`。
`verification` 欄位（`sandbox`／`simulated`）決定哪些能在沙盒驗證、哪些只能列 `unverified`。

---

## 8. 安全與隔離

| 風險 | 緩解 |
|---|---|
| AI 寫的頁面讀到本頁資料 | iframe `sandbox`、全新 about:blank 分頁、彈出視窗內再包 iframe |
| 沙盒流量打到使用者的 Cloudflare Worker／proxy | `_sandboxDenyHosts()`：`*.workers.dev`、`*.pages.dev`、所有 `*proxy*url` 設定的主機，在 Worker `fetch` 與頁面 shim 兩邊都擋 |
| Worker 無窮迴圈 | 逾時 `terminate()` |
| mock 資料互相污染 | 每個 `name` 一個命名空間；`reset` 可清 |
| 匯出檔被誤當成已驗證 | 回傳 `unverified` 明講未在真實環境執行 |

---

## 9. 已知限制

- 沒有真實網路埠、資料庫、TLS、Service Worker（網頁版）；這些只能出現在 `unverified`。
- Cloudflare 匯出的 WebSocket 需要 Durable Objects（骨架）。
- 瀏覽器分頁後端需要 Chrome 擴充功能 ≥ 1.3.0 並已允許目前網站。
- 彈出視窗需要使用者按按鈕。
- 沙盒的 `python` 是同步執行，不能在終端機裡 `await micropip.install`（用 `sandbox_py_app` 的 `packages`）。

---

## 10. 驗證紀錄（2026-10-02）

在真實 Electron 與網頁版 harness 驗證過：模擬後端的 fetch／XHR／EventSource／WebSocket 全部接到 Worker；
瀏覽器分頁後端以輪詢傳輸；`export` 的 Node／Cloudflare 檔案產生；沙盒不使用 Cloudflare 流量（`*.workers.dev`／`*.pages.dev`／proxy 主機被擋）。
匯出檔本身**沒有**在真實 Node／Cloudflare 環境跑過。

---

## 附錄 A：函式索引

| 類別 | 名稱 |
|---|---|
| 能力 | `_sandboxCapabilities`、`_sandboxTag` |
| 頁面 | `_sandboxHtmlRun`、`_sandboxBuildDoc`、`_sandboxOpenIframe`、`_sandboxOpenTab`、`_sandboxPopupViaGesture`、`_sandboxCurrentPageDoc`、`FA_SANDBOX_BOOTSTRAP_JS` |
| Worker | `_sandboxWorkerRun`、`_sandboxWorkerSource`、`_sandboxFsOp`、`_sandboxDenyHosts` |
| 模擬後端 | `_mockToolRun`、`_mockOpen`、`_mockStoreOp`、`_mockWorkerSource`、`_mockWsScenario`、`_mockNameOk`、`__faMockPrelude`、`__faMockWorkerMain`、`__faMockShim`、`__faMockBuildExport` |
| Python | `_sandboxPyAppRun`、`_sandboxPyAppRunInner` |
| playbook | `_playbookRun`、`_playbookAction`、`_playbookGuide`、`_playbookView`、`_playbookLogExperiment`、`FA_PROGRAMMING_PLAYBOOKS` |
