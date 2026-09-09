# worker.js 部署說明

這是 tw_stock_db 網站共用的 Cloudflare Worker，同時服務好幾個不相關的用途
（TWSE 即時行情代理、AI 助理的 NVIDIA chat completions 代理、
`floating-assistant.js` 的 `browser_search` 工具代理、雲端設定同步轉發）。
完整路由列表跟每個路由的設計理由都寫在 `worker.js` 檔頭的長註解裡，這份
README 只講部署步驟。

## 部署步驟

1. 安裝 [wrangler](https://developers.cloudflare.com/workers/wrangler/)（需要
   Node.js 18+）：
   ```bash
   npm install -g wrangler
   wrangler login
   ```
2. 部署：
   ```bash
   wrangler deploy worker.js --name <你的worker名稱>
   ```
   或直接在 [Cloudflare Dashboard](https://dash.cloudflare.com/) 的線上編輯器
   貼上 `worker.js` 全文存檔部署。
3. 部署後拿到的網址（例如
   `https://<你的worker名稱>.<你的subdomain>.workers.dev`）就是
   `web/index.html` 裡 `TWSE_PROXY_BASE` 常數應該指向的值。

## 需要設定的環境變數 / Secret

| 名稱 | 必要性 | 用途 |
|---|---|---|
| `NVAPI_KEY` | 必要 | NVIDIA NIM 的 API 金鑰，AI 助理共用金鑰模式（`tw_stock_db_api:{sessionId}` 假金鑰）跟一般 fallback 都會用到 |
| `NV_API_KEY_DEFAULT` | 選用 | 想把「使用者沒填金鑰」這條路徑跟共用金鑰分開管理時才需要，沒設定會自動退回用 `NVAPI_KEY` |
| `RATE_LIMIT_KV` | 選用（KV binding，不是字串） | 共用金鑰的 per-session 流量控管，沒綁定就不擋流量 |
| `SHEET_SYNC_APPS_SCRIPT_URL` | 選用 | 雲端設定同步功能要轉發到的 Google Apps Script 網址，沒設定 `/sheet-sync` 會回傳明確的「尚未設定」錯誤，不影響其他路由 |

`/realtime`、`/holiday`、`/yahoo-intraday`、`/webfetch`、`/browser-search`
這幾個路由都不需要任何金鑰/環境變數，開箱即用。

## floating-assistant.js 的 browser_search 要另外在 Advance Settings 設定

`browser_search` 是 `floating-assistant.js` 內建、預設**關閉**的子 Agent
（見 `SUBAGENT_DOMAIN_REGISTRY.browser_search`），要啟用需要：

1. Advance Settings →「子Agent」分頁 → 勾選「啟用『網路搜尋』子Agent」。
2. 同一個分頁的「Cloudflare Worker 端點網址」欄位，填入**這個 worker 部署後的
   網址本身**（不要加任何路徑，例如 `https://xxx.workers.dev`）——
   `browser_search` 會自己在後面接上 `/browser-search`。

`web/index.html` 已經把同一個 worker 網址（`TWSE_PROXY_BASE`）當作
`browserSearchProxyUrl` 的建構子預設值傳進去，使用者只需要勾選啟用即可，
不需要自己填網址；如果是拿 `floating-assistant.js` 用在其他 host 頁面，就需要
host 自己決定要不要比照這個模式傳入 `browserSearchProxyUrl` 建構子選項，或
留給使用者自己在 Advance Settings 手動填。

## 已知限制

- `/browser-search` 沒有做任何速率限制/防濫用機制——`floating-assistant.js`
  端已經有 1 天 TTL 的結果快取（見 `SEARCH_CACHE_TTL_MS`）減少重複查詢，但如果
  多人共用同一個 Worker 部署仍可能被大量請求灌爆；如果之後需要，可以比照
  `checkAndIncrementRateLimit` 的做法另外加上去，這次沒有做。
- `/browser-search` 的 `google`/`sourceforge`/`codeproject`/`deepwiki` 四個
  來源是代打 DuckDuckGo 的 HTML 介面（非官方用途，沒有官方 API 文件保證格式
  穩定），`class="result__a"`/`class="result__snippet"` 這兩個 CSS class
  名稱如果 DuckDuckGo 之後改版可能失效；`deepwiki` 來源的搜尋結果品質最不
  穩定（DuckDuckGo 對它的索引很少，常常查無結果）；`codeproject` 部分結果的
  標題品質也較差（DuckDuckGo 索引到的頁面標題本身就是泛用文字）。這些都是
  worker.js 檔頭註解裡已經記錄過的已知限制，不是解析邏輯的 bug。
