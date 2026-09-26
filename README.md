# festival-themes：floating-assistant 的台灣節慶套版

這個 branch 放 `floating-assistant.js`（網頁版、桌面版、aiweb 共用）在**台灣節慶**期間自動換上的視覺套版。
floating-assistant 執行時從這裡下載：`https://raw.githubusercontent.com/sunneo/tw_stock_db/festival-themes/…`。
使用者可以在「Configure → LLM 基礎設定 → 節慶套版」開關，預設開啟。

> **給之後要更新這個 branch 的 AI／人：先讀完這份，照「維護流程」做。**

## 鐵則

1. **這個 branch 永遠只有一個 commit。** 每次更新都重建成單一 commit 再 force push（見下面「維護流程」），不留歷史。
   理由：套版是純資產，歷史沒有價值，而且 raw.githubusercontent.com 的檔案要小、要快。
2. **每個套版（`themes/<id>/` 整個資料夾，含 theme.json 與所有 svg）不得超過 1MB。** `python tools/check.py` 會檢查，超過就不能 push。
   （目前每個套版約 10–110KB；執行時客戶端只下載「今天用得到」的那幾張，通常 < 10KB。）
3. **資產只放 SVG／JSON**，不放點陣圖、字型、程式碼。圖案一律用簡單幾何，才能維持很小。
4. **不要手改 `themes/`、`calendar.json`。** 它們是 `tools/build.py` 產生的；要改內容就改 `tools/build.py` 再重新產生。

## 內容

```
README.md            這份說明
calendar.json        節慶行事曆（build.py 產生）：哪一天套用哪個套版
themes/<id>/         每個套版一個資料夾（build.py 產生）
  theme.json         套版描述：配色、問候語、三個區域各用哪些圖（含漸進畫格）
  top-m7.svg …       上方區域的畫格（m=節日前幾天、p=節日第幾天起）
  bottom-m7.svg …    下方區域的畫格
  body.svg           中間對話區的低透明度花紋（可平鋪）
tools/build.py       行事曆資料（FESTIVALS）＋套版定義（THEMES）＋SVG 產生器
tools/check.py       驗證：格式、日期、資產齊全、每個套版 <= 1MB
tools/preview.html   本機預覽（見下面「預覽」）
```

## 套版怎麼決定

- 「今天」一律用 **Asia/Taipei** 的日期。
- `calendar.json` 的 `festivals[]`：`start`~`end` 是行政院人事行政總處**辦公日曆表**上的放假（含連假、補假）——
  **連假期間每一天都算同一個節慶**（例如 2026 春節 2/14–2/22 九天、兒童節＋清明 4/3–4/6 四天）。
- `lead`：連假前幾天就開始換套版（佈置期），由套版的 `lead` 決定（見 `THEMES`）。
- **不是真的放假的節慶只在「當天」出現（`lead=0`、`start=end`）**：元宵節、情人節、母親節（5 月第 2 個星期日）、
  父親節（8/8）、七夕、軍人節（9/3）、萬聖節。只有真的放假／連假的節慶（春節、和平紀念日、兒童節清明、勞動節、端午、
  中秋教師節、國慶、光復、行憲、跨年開國紀念日、教師節單日放假）才有佈置期與漸進畫面。
- `priority`：同一天有多個節慶時，數字大的優先（連假 90–100，一般節慶 40–60）。
  例：2026-02-14 同時是春節（100）與情人節（40）→ 用春節。
- 一個套版可以被多個節慶（不同年份、不同名稱）共用，例如 `christmas` 同時代表聖誕節與行憲紀念日。

## 三個區域

視窗分成三塊，各自有圖：

| 區域 | 位置 | 說明 |
| --- | --- | --- |
| `top` | 標題列（往下垂掛一點） | 垂掛的鞭炮／燈籠／燈串／月亮。貼右對齊，客戶端讓它避開左邊標題與右邊按鈕 |
| `body` | 中間對話區背景 | 可平鋪的 240×240 低透明度花紋（約 10%），不影響閱讀 |
| `bottom` | 視窗底邊 | 貼右對齊的一排小物（燈籠、花、禮物、南瓜…），避開左邊的狀態文字 |

## 越接近節日越豐富（漸進，progressive）

`theme.json` 的 `regions.top.frames`／`regions.bottom.frames` 是依 `offset` 排序的畫格：

- `offset` = 今天 − 連假第一天（負數＝節日前幾天，0＝節日第一天，之後維持最後一格）。
- 客戶端選「`offset` ≤ 今天偏移」的**最後一格**。
- 一般套版：`build.py` 的 `progress()` 讓「掛飾串數／數量」隨接近節日增加。
- **春節**（`top: crackers`）：節前 7 天開始在上方「高掛鞭炮」，越接近串數越多、越長，春節當天起冒火花。
- **中秋**（`top: moon`）：節前 15 天起每天一格**月相**（新月→漸盈→中秋滿月→漸虧），並逐漸掛起提燈與繁星。
- **聖誕**（`top: garland`）：節前 14 天起燈串逐漸拉長、變密。
- 只有「當天」的節慶（`lead=0`）沒有漸進，直接是完整畫面。

## 混合風（台灣＋國外）

節日同時有台灣與國外元素時，用**混合設計**，不要二選一：

- `christmas`（聖誕節＋行憲紀念日 12/25）：紅綠聖誕燈串上穿插**青天白日小旗**；聖誕樹頂星換成**青天白日**；配色紅／綠／藍／白。
- `new-year`（元旦／跨年＋開國紀念日）：煙火＋青天白日。
- `mid-autumn`（中秋＋教師節）：月亮、桂花、提燈，加上書本圖案。
- `spring`（兒童節＋清明節）：氣球與花。
新增混合節慶時，在 `THEMES[...]["blend"]` 放額外元素，`build_body`／`build_top`／`build_bottom` 會自動混進去。

## 維護流程

### 每年一次：補下一年的日期

政府通常在 8～11 月公布下一年度辦公日曆表。

1. 查行政院人事行政總處新聞稿「行政院核定○年（西元○年）政府行政機關辦公日曆表」
   （https://www.dgpa.gov.tw/ 的新聞稿／辦公日曆表），確認 3 日以上連續假期的起訖日與補假日。
   - 從 2025 下半年起是「補假不補班」：國定假日逢週六→前一個上班日補假，逢週日→次一個上班日補假。
   - 2025 起新增放假：勞動節（5/1）、教師節（9/28）、臺灣光復暨金門古寧頭大捷紀念日（10/25）、行憲紀念日（12/25）。
2. 在 `tools/build.py` 的 `FESTIVALS` 補那一年的節慶（照既有格式；`source` 寫核定的辦公日曆表）。
   非放假節慶（元宵＝農曆正月十五、七夕＝農曆七月初七、母親節＝5 月第 2 個星期日、父親節 8/8、軍人節 9/3、萬聖節 10/31）用規則推算，`lead` 一律 0（只當天），`source` 寫 `RULE…`。
   端午、中秋以辦公日曆表為準。
3. `python tools/build.py && python tools/check.py`
4. 用預覽頁看幾個 offset（見下面），確認沒有破版。
5. 依「重建單一 commit」發佈。

### 新增或調整一個套版

1. 在 `THEMES` 加一筆（`accent`、`lead`、`top`/`bottom` 畫法、`motifs`、`colors`、`greeting`、`particles`、`light`/`dark` 橫幅配色）。
2. 需要新圖案就在「SVG 圖案庫」加一個 `m_xxx(color)`（以 (0,0) 為中心、約 ±16）並登記到 `MOTIFS`／`HANG`。
3. 在 `FESTIVALS` 讓某個節慶指向它，build + check + 預覽。

### 重建單一 commit 並發佈（這個 branch 永遠只有一個 commit）

```bash
# 在一份乾淨的工作目錄（只放這個 branch 的內容）：
git checkout --orphan festival-themes-new
git add -A
git commit -m "festival-themes: <日期> <這次改了什麼>"
git branch -M festival-themes
git push --force origin festival-themes
```

或不切換分支、直接在現有 clone 內：`git commit --amend` 之後 `git push --force-with-lease origin festival-themes`。
**不要**在這個 branch 上疊第二個 commit。

## 預覽

在 branch 根目錄：

```bash
python -m http.server 8936
# 開 http://127.0.0.1:8936/tools/preview.html?c=mid-autumn:-15,-8,0,2;lunar-new-year:-7,-3,0;christmas:-14,0
```
`c=套版id:offset,offset;套版id:offset…`。每個畫面同時顯示深色／淺色。

## 客戶端約定（floating-assistant.js）

- 抓 `calendar.json`（一天最多抓一次，失敗就用本機快取，沒有快取就不套用任何套版）。
- 依「今天(Asia/Taipei)」找出生效節慶（`start - lead ≤ 今天 ≤ end`，`priority` 大者優先）。
- 只下載生效套版的 `theme.json` 與「今天那一格」的 svg，且先確認 `sizeBytes ≤ 1MB`，超過就不套用。
- 改了某個套版的內容時，把它的 `version` 加 1（`build.py` 的 `version`），客戶端才會丟掉舊快取。
- `theme.json` 的 `regions` 結構、欄位名稱是客戶端的契約，**改欄位名稱要同步改 floating-assistant.js**
  （`renderer/src/floating-assistant.js` 內搜尋 `festival`）。

## 校對過的日期（2026、2027）

| 節慶 | 2026 | 2027 |
| --- | --- | --- |
| 元旦／開國紀念日連假 | 1/1；12/31–1/3（跨年） | 12/31(2027)–1/2(2028) |
| 春節 | 2/14–2/22（9 天） | 2/4–2/10（7 天） |
| 和平紀念日 | 2/27–3/1 | 2/27–3/1 |
| 兒童節＋清明節 | 4/3–4/6 | 4/3–4/6 |
| 勞動節 | 5/1–5/3 | 4/30–5/2 |
| 端午節 | 6/19–6/21 | 6/9（單日） |
| 中秋節＋教師節 | 9/25–9/28 | 9/15（單日） |
| 國慶日 | 10/9–10/11 | 10/9–10/11 |
| 光復節 | 10/24–10/26 | 10/23–10/25 |
| 行憲紀念日 | 12/25–12/27 | 12/24–12/26 |

來源：行政院核定 115 年、116 年政府行政機關辦公日曆表。
