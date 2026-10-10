# Floating Assistant 的 Cloudflare Worker

一個 Worker 做兩件事：

1. **保活**：每 5 天對兩個 Supabase 專案各送一個最輕的請求（不改資料），避免免費專案 7 天沒有活動被暫停。
2. **慢速信箱（Cloudflare KV）**：兩個 Supabase 專案都不能用時，遠端群組自動退到這裡。用輪詢收訊息，很慢（幾秒到幾十秒），
   只適合文字與少量訊息，不適合傳大檔。內容是端對端加密的，這裡只存加密後的資料與房間登記（代號＋由密碼推導的驗證值）。

網址：`https://lively-dream-c1f0.sunneo529.workers.dev`（App 裡寫死這個網址；要換網址得改 `renderer/src/remote/rg_host.js` 的 `KV3`）。

## 用 Cloudflare 後台網頁部署（不需要裝任何東西）

`wrangler` 需要 Node 22 與 64 位元系統，舊電腦裝不起來，直接用網頁後台：

1. **建立 KV**：Cloudflare 後台 → Storage & Databases → KV → Create → 名稱隨意（例如 `fa-kv`）。
2. **改程式**：Workers & Pages → 選 `lively-dream-c1f0` → 右上角 Edit code → 把整個編輯器內容換成這個資料夾裡 `worker.js` 的全部內容 → Deploy。
3. **綁定 KV**：同一個 Worker → Settings → Bindings → Add → KV namespace → **Variable name 填 `KV`（大寫，必須是這個）** → 選剛建立的 KV → Deploy。
4. **排程**：同一個 Worker → Settings → Trigger Events（Triggers）→ Cron Triggers → Add → `0 3 */5 * *`（每 5 天，凌晨 3 點 UTC）。
5. **驗證**：用瀏覽器打開 Worker 網址，應該看到 JSON：`"kv": true`，以及兩個專案的狀態
   - `status: 200`：專案正常；`404`：專案活著但還沒執行 `supabase/remote_group.sql`；5xx 或逾時：專案可能被暫停，到 Supabase 後台按 Restore。

原本的 Worker 內容會被取代；如果這個 Worker 之前有放別的東西，先備份。

## 免費方案的額度（這一層真正的上限）

| 項目 | 免費額度 | 這一層的用法 |
|---|---|---|
| KV 寫入 | 每天 1000 次 | 在線登記每 10 分鐘 1 次；每則訊息 1 次（同一個收件人連續的會合併）；房間 touch 每 6 小時 1 次 |
| KV 列舉 | 每天 1000 次 | 名單每 5 分鐘（有往來時每分鐘）1 次 |
| KV 讀取 | 每天 10 萬次 | 輪詢：有往來每 8 秒、閒置每 30 秒，每次讀「其他每台」1 次 |
| 同一個 key 寫入 | 每秒 1 次 | 傳輸層自動排隊 |

3 到 4 台機器、輕量使用沒問題；8 台以上長時間在線會超過讀取額度。超過額度時這一層會失敗，但不會影響前兩層。

## 安全

- 任何人知道網址都能呼叫它，但沒有密碼的人看不到內容（加密），也猜不到頻道名稱（由密碼推導）。
- 壞處是有人可以灌垃圾把寫入額度用光（拒絕服務）；真的發生時，換個 Worker 網址即可。
