# TWSE 即時資料 CORS 代理

## 這是什麼、為什麼需要

台股追蹤網頁想在收盤前、本地資料庫還沒有當天資料時，直接向證交所抓即時
股價，畫出當天還在成形中的K棒。但實測過，證交所這兩個公開資料源都**沒有
回傳 CORS header**，瀏覽器會直接擋下跨網域的 `fetch()`：

```bash
curl -sD - -o /dev/null "https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=tse_2330.tw&json=1" \
  -H "Origin: https://sunneo.github.io"
# 回應標頭裡完全沒有 Access-Control-Allow-Origin

curl -sD - -o /dev/null "https://openapi.twse.com.tw/v1/holidaySchedule/holidaySchedule" \
  -H "Origin: https://sunneo.github.io"
# 一樣沒有
```

所以網頁沒辦法直接呼叫，需要一個中繼站：原樣把請求轉給證交所，再幫回應
加上 CORS header 後回傳。這個資料完全公開、不需要登入或金鑰，Worker
只是單純轉發 + 加 header，不做任何資料處理或儲存使用者資訊。

**這個功能是共用你既有的 Worker**（`https://dawn-disk-778c.sunneo529.workers.dev/`，
原本用來代理 NVIDIA chat completions），新增 `/realtime` 和 `/holiday`
兩個路由，原本的 `/api`、`/chat/completions` 路由邏輯不變。

## ⚠️ 先處理：API key 不要寫死在原始碼裡

原本的 `worker.js` 把 NVIDIA API key 直接寫死在字串裡。這個檔案現在放進
`tw_stock_db`（**公開** repo）的 `web/cloudflare-worker/worker.js`，寫死
金鑰等於直接公開金鑰，所以已經改成從 Cloudflare 的 Secret 讀取
（`env.NVAPI_KEY`），前端自己帶 `Authorization` header 的話還是優先用
前端帶的那組，行為跟原本一樣。

**你在對話裡貼出的那組 `nvapi-...` 金鑰已經以明文留在對話紀錄裡，建議去
NVIDIA 那邊把它註銷、重發一組新的**，然後照下面步驟把新金鑰設成 Secret，
不要再貼在任何會進 git 的檔案裡。

設定 Secret（擇一）：

- **Cloudflare Dashboard**：Workers & Pages → 選這個 Worker
  （`dawn-disk-778c`）→ Settings → Variables and Secrets → 新增一個
  Secret，名稱 `NVAPI_KEY`，值貼上新金鑰 → Save and Deploy。
- **wrangler CLI**：`npx wrangler secret put NVAPI_KEY`（互動式輸入值）。

## 這個 Worker 新增的路由

| 路由 | 對應證交所來源 | 說明 |
|---|---|---|
| `GET /realtime?ex_ch=tse_2330.tw` | MIS 即時行情 API | 單一個股即時報價；上市代號用 `tse_` 開頭，上櫃用 `otc_` 開頭。可用 `\|` 分隔一次查多檔，例如 `tse_2330.tw\|otc_6488.tw` |
| `GET /holiday` | OpenAPI 休市日曆 | 用來判斷今天是不是交易日；這個路由在 Cloudflare 邊緣快取 24 小時，減少對證交所的請求量 |
| `GET /yahoo-intraday?symbol=2330.TW` | Yahoo 股市圖表 API | 今日 1 分K（開盤到現在），上市用 `.TW`、上櫃用 `.TWO` 結尾。只在使用者切到「走勢圖」分頁那一刻打一次，用來墊補開盤到打開網頁之間、證交所自己補不回來的那段空白（見下方「為什麼多一個 Yahoo 來源」） |

原本的 `/api`、`/chat/completions` 兩個路由完全不受影響。

回應內容跟上游原始回應格式完全一樣，只是多了 CORS header，網頁端可以
直接照原本的欄位解析。

### 為什麼多一個 Yahoo 來源

證交所自己完全沒有「個股當日已發生的分時/逐筆歷史」這種公開資料——
`getStockInfo.jsp` 只給「這一瞬間」的快照，`MI_5MINS` 這類彙總資料又只在
收盤後才發布前一個交易日的內容（實測過，見上面 CORS 調查那節），所以
走勢圖如果純粹靠輪詢 `/realtime` 累積，使用者收盤前才打開網頁的話，
開盤到打開網頁那段時間永遠是空的、原理上補不回來。

Yahoo 股市的公開圖表 API（`query1.finance.yahoo.com/v8/finance/chart/...`，
同樣沒有 CORS header）剛好有「當日 1 分K」這份資料，拿來墊這段空白的大致
輪廓——這不是官方資料，只在切到走勢圖分頁那一刻打一次，之後的即時更新
還是靠 `/realtime` 輪詢，不會每 20 秒重打 Yahoo。

## 部署（更新既有的 Worker）

### 方式一：Cloudflare Dashboard（跟你原本維護方式一樣）

1. 打開 Cloudflare Dashboard → Workers & Pages → 選 `dawn-disk-778c`。
2. 進線上編輯器，把整份 `worker.js` 的內容貼進去覆蓋掉原本的。
3. 依照上面「先處理」那節設定好 `NVAPI_KEY` Secret。
4. Save and Deploy。

### 方式二：wrangler CLI

```bash
cd web/cloudflare-worker
npx wrangler login        # 第一次要先登入
npx wrangler secret put NVAPI_KEY
npx wrangler deploy
```

## 網頁端設定

`web/index.html` 裡的 `TWSE_PROXY_BASE` 已經指向你現有的 Worker：

```js
const TWSE_PROXY_BASE = 'https://dawn-disk-778c.sunneo529.workers.dev';
```

這個常數留空的話，即時擷取功能（LiveFeed/TradingCalendar）會整個自動
關閉，不影響其他功能；不需要再自己改這行，除非你之後換了 Worker 網址。

## 測試

部署完可以直接用瀏覽器或 curl 測試：

```bash
# 即時行情（要在開盤時段測試才有當天資料，收盤後會回傳前一個交易日的最後報價）
curl "https://dawn-disk-778c.sunneo529.workers.dev/realtime?ex_ch=tse_2330.tw"

# 休市日曆
curl "https://dawn-disk-778c.sunneo529.workers.dev/holiday"

# 今日1分K backfill（上市用 .TW、上櫃用 .TWO）
curl "https://dawn-disk-778c.sunneo529.workers.dev/yahoo-intraday?symbol=2330.TW"

# 確認原本的 NVIDIA 代理沒被動到
curl -X POST "https://dawn-disk-778c.sunneo529.workers.dev/api" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <你的新nvapi key>" \
  -d '{"model":"...", "messages":[...]}'
```

看到 JSON 內容且沒有錯誤訊息就代表成功。也可以在瀏覽器開發者工具的
Network 分頁確認回應標頭有 `access-control-allow-origin`。

## 使用限制與禮貌呼叫的考量

- 網頁端只在**當天交易時段（09:00–13:30）**、**本地資料庫還沒有當天資料**
  時才會呼叫 `/realtime`，而且只針對使用者當下正在看的那一檔股票，每
  20 秒才 refresh 一次，不會對證交所造成明顯負擔。
- `/holiday` 有 24 小時邊緣快取，一天最多對證交所發一次請求。
- `/yahoo-intraday` 只在切到走勢圖分頁/選股當下打一次（前端有記憶，同一檔
  股票同一天不會重打），不會跟著 20 秒的即時輪詢一起打，避免對這個非正式
  資料源造成不必要的負擔或被限流。
- Cloudflare Workers 免費方案（每天 10 萬次請求）對這種個人使用的專案
  綽綽有餘，跟原本的 NVIDIA 代理共用額度也不會有問題。
- 如果之後想調整呼叫頻率，網頁端對應的常數在 `web/index.html` 的
  `LIVE_POLL_MS`（預設 20000，單位毫秒）。

## 疑難排解

- **網頁還是抓不到即時資料**：先確認 `TWSE_PROXY_BASE` 有沒有結尾斜線
  （不應該有）。再用上面的 curl 指令直接測 Worker 本身是否正常。
- **NVIDIA 代理回 401**：多半是 `NVAPI_KEY` Secret 沒設好，或前端沒帶
  `Authorization` header 又沒設 Secret 當 fallback。
- **收盤後 / 非交易日抓到舊資料**：這是預期行為，`getStockInfo.jsp` 在
  非開盤時段會回傳「上一個交易日收盤時的最後報價」而不是空值。網頁端會
  檢查回應裡的日期欄位是不是今天，不是的話就不會寫入，所以不會誤把舊
  資料當成今天的即時資料。
