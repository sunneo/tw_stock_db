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
| 擴充格式驗證（必要欄位、模板變數、正規表示式可編譯、未設定網址須標 optional） | 已驗證（單元測試） | `renderer/src/ext/ext_core.test.js` |
| 情境偵測（網址閘門、標題、代號）與原話（`text`）抽名稱、代號（字典 `nameToCode`） | 已驗證（單元測試，固定字串）；字典只有「大成鋼→2027」一筆，覆蓋率低 | 同上 |
| 來源規劃與缺條件跳過（缺日期、缺名稱、未設定網址） | 已驗證（單元測試） | 同上 |
| `json_rows`／`rss`（含 `maxAgeDays`）／`text` 抽取：固定的真實回應快照 | 已驗證（單元測試，快照＝2026-11-13 真實回應；T86 節錄） | `renderer/src/ext/fixtures/` |
| 數字核對（千分位先去掉）、買賣建議過濾、免責聲明、貢獻到 deck 的版面上限 | 已驗證（單元測試） | `ext_core.test.js` |
| 工具參數的日期優先順序（呼叫端明說的日期優先） | 已驗證（單元測試；修正過一個錯誤：原本被今天覆蓋） | 同上 |
| 合併 desktop-app 後嵌入區重新嵌入、無衝突標記、語法檢查、建置 | 已驗證（`embed-code-ui.js`、`build-assistant.js`、`node --check`） | 本分支 |
| **真 Electron：工具登錄在 `fa.tools`，歸入 host_tools（category host_app），簡報代理人（media-presentation）的系統提示借用到它，離線目錄搜尋（catalog）命中** | 已驗證（`scripts/eval/ext_points.run.js` + `ext_points.eval.js`，xvfb） | 最後一次實測紀錄（見下） |
| **線上雲端工具表（實際送給雲端模型的 tool 定義）** | 未直接驗證：只確認 `fa.tools` 有它，沒有抓雲端請求內容 | — |
| **真 Electron：離線路由（`_otPlan` → 目錄命中當 extraTools → `_recipeAnswer` planOnly、noModel）對「為什麼大成鋼今天下跌」選到 `ext_stock_drop_cause`，欄位 `text` 由程式填入** | 已驗證（同上；修正過一個缺陷：候選未依分數排序，命中的工具排在後面，`autoPick` 選不到） | 同上 |
| **真 Electron：執行工具，經產品的 CORS 代理抓真實公開頁面** | 部分驗證：TWSE 個股日成交 200、有資料；TWSE T86 200（今天尚未公布，查不到）；Google 新聞 RSS 經代理回 HTTP 403（查不到，如實標示） | 同上 |
| 真實公開頁面、node 直接抓取（不經產品代理）：TWSE STOCK_DAY、T86、Google 新聞 RSS | 已驗證（2026-11-13 curl 抓取，格式與欄位名稱已比對） | `renderer/src/ext/fixtures/` |
| 簡報每頁附來源、最後一頁為免責聲明 | 已驗證（真 Electron 產出的 deck 結構，與單元測試） | 同上 |
| 公開資訊觀測站重大訊息 | 未驗證（沒有網址模板，標示「未設定來源網址」） | — |
| 離線 CoLU 的完整輸入→工具→簡報流程（不只路由） | 未驗證（只到工具執行；簡報的 render_presentation 沒有在離線路徑裡跑） | — |
| 真實「今天」的完整資料（收盤後的 T86、新聞） | 未驗證（實測時間 11/13 中午，市場未收盤、T86 尚未公布） | — |

### 最後一次真 Electron 實測（2026-11-13，xvfb，隔離 userData）

- 離線路由：`為什麼大成鋼今天下跌` → 選到 `ext_stock_drop_cause`，參數 `{"text":"為什麼大成鋼今天下跌"}`；工具內解出 代號 2027、名稱 大成鋼。
- 實際抓取（產品代理）：
  - `https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?stockNo=2027&response=json&date=20261113`：ok，最後一列為 11/12（11/13 尚未有資料），收盤 49.05、漲跌 −1.05、成交股數 18,068,619。
  - `https://news.google.com/rss/search?q=%E5%A4%A7%E6%88%90%E9%8B%BC%202027&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`：HTTP 403（產品代理被拒），標示「查不到（抓取失敗：HTTP 403）」。
  - `https://www.twse.com.tw/rwd/zh/fund/T86?date=20261113&selectType=ALL&response=json`：ok 但無資料列（今天尚未公布），標示「查不到」。
  - 公開資訊觀測站：未設定來源，標示「查不到（未設定來源網址）」。
- 簡報結構：封面、報價與成交量（4 條、附來源）、近期新聞（查不到）、三大法人（查不到）、重大訊息（查不到）、免責聲明（最後一頁）。
- 實測耗時約 0.9 秒（工具內部）。


## 八、宿主頁面登記自己的擴充（register_extension，2026-11-13）

起因：股市網站要把自己的「調查個股」「全面分析報告」登記給 media-presentation 用，資料是頁面自己的本機資料庫（K 線、診斷、籌碼、鎖股），不是公開網址。

- **`fa.register_extension(ext, opts)`**：ext 是第三節的宣告式 JSON（同樣驗證），工具登記成宿主工具（沒有歸類，落在 host_tools／host_app，media-presentation 借用得到）。回傳 `{ok, replaced, tool}` 或 `{ok:false, errors}`。
- **`host:` 來源**：`research[].url` 可以寫 `host:<名稱>?code={code}&name={name}&date={date}`，由 `opts.fetchers[名稱](query, {ext, args})` 取文字（不上網、不經代理）。模板變數與缺條件跳過的規則跟網址一樣。
- **`extract.kind: "lines"`**：來源文字一行一條事實，不做關鍵字篩選。
- **不截斷**：`extract.maxFacts`（1～400）放寬每個來源的條數（預設仍是 8）；單條超過 220 字時依「。；;」拆成多條（一個字都不丟，也不加省略號），不再用「…」截掉。
- **宿主接線 opts**（都選填）：`getContext()`（目前頁面的情境，例如使用者正在看哪一檔）、`resolveText(原話)`（用宿主的名稱字典解出代號）、`wrapResult(out, {args, ext})`（宿主決定回給模型的格式，例如存進自己的結果倉庫、分頁；不給就回預設 JSON）。
- 買賣建議過濾、數字核對、免責聲明仍然由程式強制；`host:` 來源的文字也一樣（所以宿主組文字時避免用「停損」「目標價」等字，改用「防守位置」「幅度測量目標」）。
- 測試：`ext_core.test.js` 59 → 68 項（host: 與 lines 驗證、maxFacts 上限、條數放寬、長句拆開不丟字、建議字眼仍被過濾）。
- 還沒做：`unregister_extension`；使用者自訂擴充的匯入。
