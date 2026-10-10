# Supabase 保活 Worker

免費的 Supabase 專案連續 7 天沒有任何請求會被自動暫停（要到後台手動 Restore，約要等幾十秒）。
這個 Worker 每 5 天對「主要」與「備援」兩個專案各送一個最輕的請求（不會改資料）。
App 本身啟動後每天也會各送一次，兩邊互相補位。

## 部署（只要做一次，需要你的 Cloudflare 帳號）

```bash
npm install -g wrangler
wrangler login
cd supabase/keepalive-worker
wrangler deploy
```

部署完用瀏覽器打開 Worker 網址，會回傳兩個專案的狀態：
- `status: 200`：正常。
- `status: 404`：專案活著，但還沒執行 `supabase/remote_group.sql`（備援專案要先執行一次）。
- 5xx、逾時：專案可能已經被暫停，到 Supabase 後台按 Restore。

排程在 Cloudflare 後台的 Worker → Triggers → Cron 可以看到，也可以手動觸發測試。
