# 擴充點（extension points）：內建技能可以被注入強化

> 日期：2026-11-13。分支 `claude/ext-points`。
> 核心：`renderer/src/ext/ext_core.js`（`FaExt`，UMD、純函式、node 可測）；範例：`renderer/src/ext/examples/stock_drop_cause.json`；宿主接線：`renderer/floating-assistant.js` 的 `EXT-BEGIN`／`EXT-END` 區塊與 `_extRegisterTools()`；嵌入：`scripts/embed-code-ui.js` 的 `embedExt()`。
> 使用者原話（2026-11-13）：「可以讓內建 skill 具備類似 inject／enhancement 的註冊點能力嗎？例如我用股市的網頁，我希望它增加開不同網頁調查『為什麼大成鋼今天下跌』然後貢獻到 media-presentation」；更正：「不一定是食譜，online 跟 offline AI 都要有辦法」。

## 一、已有零件地圖（先收斂，不重做）

| 零件 | 位置 | 這次怎麼用 |
|---|---|---|
| 宿主頁面的功能分類 `host_app` | `floating-assistant.js` `_registerHostToolsDomain`、`_buildInheritedDomainsNote` | 內建 `media-presentation` 的 `includeDomains: ['category:host_app']` 已經會借用宿主登記的工具。擴充的工具登記成宿主工具，media-presentation 自動看得到，**不用改技能本身**。 |
| 宿主工具登記 `register_openai_tool(name, description, callback, parametersSchema)` | `floating-assistant.js` 約 81960 行 | 擴充工具用它登記；線上 AI 的工具表、離線工具目錄都從 `this.tools` 來。 |
| 離線工具目錄與 CoLU 路由 | `renderer/src/catalog/`、`renderer/src/recipe/recipe_core.js` 的 `chooseTool`／`menuMessages` | 登記後，離線模型用既有的編號選單挑工具；不需要另寫路由。 |
| 食譜引擎 `FaRecipe.runRecipe` | `renderer/src/recipe/recipe_core.js` | 本次**不做**確定性食譜（見第六節），離線路線先走工具目錄。 |
| 抽取檢查 `checkExtractive` | `recipe_core.js` | 抽出的段落先過它（有 `FaRecipe` 時）；沒有時退回純數字檢查。 |
| 簡報資料格式 | `renderer/src/deck/deck_core.js` | 貢獻的頁面是 `chapters[].slides[]`；`layout` 用 `content`（條列），每頁條列 ≤ 6 條、每條 ≤ 220 字、一章 ≤ 30 章。 |
| 網頁抓取代理 | `floating-assistant.js` `fetch_web_page` 的 `_resolveWebFetchProxyUrl()` | 研究來源用同一個代理抓原始文字（不寫進 persistentStorage）。 |
| 內建技能定義 | `floating-assistant.js` `BUILTIN_SKILLS` 約 70872 行 | 不改；擴充點是**宿主工具**，不是改技能。 |

## 二、缺口（這次要補的）

1. 沒有「擴充清單」的資料格式，宿主無法用宣告的方式注入調查流程。
2. 沒有情境偵測（由網址、標題、選取文字抽股票代號與名稱）。
3. 沒有研究來源的宣告與抽取（網址模板、來源格式、抽不到時的誠實標示）。
4. 沒有把整理好的段落貢獻到簡報的規則（章、頁、來源、免責聲明）。
5. 沒有「不給買賣建議」的程式檢查。

## 三、資料格式（擴充宣告，JSON）

```json
{
  "id": "stock_drop_cause",
  "name": "股票下跌原因調查",
  "description": "在股票網頁上，調查某檔股票今天為什麼漲跌，整理成簡報的一章。",
  "enabled": true,
  "context": {
    "urlPattern": "stock|quote|twse|tpex",
    "codeRe": "^\\d{4,6}$",
    "patterns": [
      { "re": "([^\\s()（）]{2,12})[（(](\\d{4,6})[)）]", "name": 1, "code": 2 },
      { "re": "[/=](\\d{4,6})(?!\\d)", "code": 1 }
    ]
  },
  "tool": {
    "name": "ext_stock_drop_cause",
    "description": "調查一檔股票今天為什麼下跌或上漲（報價、新聞、法人買賣超），整理成可貢獻給簡報的段落。缺股票代號時會用目前網頁的代號與名稱。"
  },
  "research": [
    { "id": "quote", "label": "報價與成交量", "url": "https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo={code}&response=json&date={date}", "extract": { "kind": "json_rows", "rowsKey": "data", "fieldsKey": "fields", "pick": "last", "count": 1, "show": ["收盤價", "成交股數", "漲跌價差"] } },
    { "id": "news", "label": "近期新聞（Google 新聞搜尋，只留查詢日前兩天內）", "url": "https://news.google.com/rss/search?q={name}%20{code}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant", "needs": ["name"], "extract": { "kind": "rss", "max": 5, "maxAgeDays": 2, "must": ["{name}", "{code}"] } },
    { "id": "institutional", "label": "三大法人買賣超", "url": "https://www.twse.com.tw/rwd/zh/fund/T86?date={date}&selectType=ALL&response=json", "extract": { "kind": "json_rows", "rowsKey": "data", "fieldsKey": "fields", "match": { "col": 0, "equals": "{code}" }, "show": ["外陸資買賣超股數(不含外資自營商)", "投信買賣超股數", "自營商買賣超股數"] } },
    { "id": "announce", "label": "公開資訊觀測站重大訊息", "url": "", "optional": true, "note": "需要 POST 表單，未驗證；沒有網址模板就標示「未設定來源」並跳過。", "extract": { "kind": "text" } }
  ],
  "contribute": { "target": "media-presentation", "chapter": "{name}（{code}）下跌原因調查", "position": "end", "maxBulletsPerSlide": 5 },
  "disclaimer": "本簡報為公開資料整理，僅供參考，不構成任何投資建議。"
}
```

- `context.patterns`：依序試；第一個命中的給代號（必要）與名稱（可選）。`urlPattern` 不命中就不偵測。
- `research[].url`：模板變數 `{code}`、`{name}`（URL 編碼）、`{date}`。缺值的來源標記為 `skipped`，原因寫明缺哪個變數，不猜。
- `extract.kind`：`json_rows`（JSON 陣列列，可用 `match` 篩選、`pick: last` 取最後幾列，欄位名從 `fieldsKey` 對應）、`rss`（抽 `<item>` 的標題與日期，`must` 要求標題含這些字，`maxAgeDays` 只留查詢日前幾天內的新聞）、`text`（去標籤後取含關鍵字的句子）。
- 工具參數固定由 `toolSpec` 產生：`code`、`name`、`date` 三個選填字串（不用宣告）。
- `contribute`：整理成一章，章名模板同上；最後一頁**固定**是免責聲明（即使宣告裡沒寫，程式也會補上）。

## 四、掛點（什麼時候被呼叫）

| 掛點 | 做法 | 線上 AI | 離線 AI |
|---|---|---|---|
| `context` | 工具呼叫時，宿主給 `{url, title, selection}`；`detectContext` 抽代號與名稱 | 模型也可以直接給 `code`、`name` | 離線模型同樣由工具參數或情境偵測取得，不需要模型自己抽 |
| `research` | `planResearch` 產生來源清單（含跳過原因）；宿主逐一抓取；`extractSource` 抽取、`verifyFacts` 核對 | 工具內部執行，回傳結果 | 同一個工具；工具目錄路由選到它 |
| `contribute` | `buildSections` 組段落；`contributeToDeck` 把段落加成新的一章，附來源與免責聲明 | media-presentation 代理人拿到 `deck` 片段，用 `render_presentation` 存 | 同上（離線簡報仍靠既有的主題簡報食譜，這次不改） |

## 五、安全與誠實規則（程式強制，不靠模型）

1. **數字必須出現在來源**：抽出的每一條若含數字，數字（去掉千分位）必須出現在來源原文裡；不符就丟掉這一條，計入 `dropped`。有 `FaRecipe` 時另外過 `checkExtractive`。
2. **抽不到就寫「查不到」**：來源失敗、被跳過、或沒有符合的資料，段落裡寫「查不到（原因）」，不補猜測。
3. **每筆附來源**：每條事實帶來源名稱與網址（`source.label`、`source.url`），簡報頁底下以「來源：…」顯示。
4. **不給買賣建議**：含「買進、賣出、加碼、減碼、停損、停利、目標價、必漲、必跌、穩賺」等字的句子直接丟掉，計入 `advice_removed`。
5. **免責聲明固定最後一頁**，即使宣告沒寫也會補。
6. **需要登入的頁面**：抓到的內容若是登入頁（抽不到任何條目），標示「需要登入，未取得」，不當成查不到的資料。
7. **只讀公開頁面**，不送個資，不帶 cookie（代理抓取沒有使用者帳號）。

## 六、這次不做的（如實）

- **確定性食譜（離線程式路線）沒有實作**。使用者說「不一定是食譜」：離線 AI 走工具目錄與 CoLU 路由選同一個工具即可。`ext_core` 不產生食譜；若之後要，可以用 `FaRecipe.runRecipe` 的 `tool` 步驟包裝 `planResearch` 的結果。
- **不做因果推論**。段落只整理抓到的事實（價格、成交量、法人數字、新聞標題）；「為什麼下跌」的解讀仍由線上模型寫，離線只給事實。
- **重大訊息來源未驗證**：公開資訊觀測站需要 POST 表單，範例沒有網址模板，會標示「未設定來源」。
- **擴充的熱更新**：範例 JSON 在嵌入時變成 `FA_EXT_BUILTIN` 常數，隨 renderer 的熱更新送達；使用者自訂的擴充（匯入）還沒做。

## 七、驗證現況表

**真實抓取（2026-11-13，只讀、不登入、不帶任何個人資料，User-Agent 只寫通用名稱）**：
- `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=2027&response=json&date=20261112`：200，個股日成交，最後一列 11/12 收盤 49.05、漲跌 −1.05（與範例的欄位名稱相符）。
- `https://www.twse.com.tw/rwd/zh/fund/T86?date=20261112&selectType=ALL&response=json`：200，三大法人；2027 那列的欄位名稱全部對得上（外陸資買賣超股數、投信買賣超股數、自營商買賣超股數）。
- `https://news.google.com/rss/search?q=大成鋼 2027&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`：200，32 則含名稱的項目；查詢日前兩天內只剩 1 則。
- 注意：範例早先誤用 2001 當大成鋼的代號，實際是 **2027**；2001 不是大成鋼（抓 2001 的 STOCK_DAY 回「沒有符合條件的資料」）。已改成固定快照用 2027。
- 2026-11-13 中午查 11/13 當日的 STOCK_DAY 尚無資料，程式會標示「沒有資料列」，不會猜。


| 項目 | 狀態 | 證據 |
|---|---|---|
| 擴充格式驗證（必要欄位、模板變數、正規表示式可編譯） | 已驗證（單元測試） | `renderer/src/ext/ext_core.test.js` |
| 情境偵測（網址、標題、代號） | 已驗證（單元測試，固定字串） | 同上 |
| 來源規劃與跳過原因 | 已驗證（單元測試） | 同上 |
| `json_rows`／`rss`／`text` 抽取（固定快照） | 已驗證（單元測試，快照為手寫的仿真格式） | 同上 |
| 數字核對、免責聲明、買賣建議過濾 | 已驗證（單元測試） | 同上 |
| 貢獻到簡報片段符合 deck 格式（章、頁數、條列數上限） | 已驗證（單元測試，跟 `deck_core` 的 `LIMITS` 比對） | 同上 |
| 真實公開頁面抽取（2026-11-13 抓取，見下） | 已驗證（固定快照＝真實回應；T86 節錄） | `renderer/src/ext/fixtures/` |
| 宿主工具登記後，線上工具表與離線目錄看得到 | 未驗證（程式已接線，語法與建置通過；沒有啟動 Electron 看工具表） | — |
| 離線 AI 經由 CoLU 路由選到這個工具 | 未驗證 | — |
| 公開資訊觀測站重大訊息 | 未驗證（沒有網址模板，標示「未設定來源」） | — |
| 桌面版（Electron）端到端 | 未驗證 | — |
