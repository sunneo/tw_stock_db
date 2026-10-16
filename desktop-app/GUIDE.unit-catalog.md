# 單元目錄 設計與使用指南

> 這份是「怎麼用、為什麼這樣設計、哪裡還不行」的總覽。每一節的細節與實測數字在 `DESIGN.unit-catalog.md`（括號裡是章節）。

## 一、一句話

把助理會的事（已登記的工具、Python 標準庫與第三方函式）整理成一份**有型別的單元目錄**，讓「需求 → 活動 → 單元 → 可檢查、可執行的呼叫程式」這條路**幾乎不靠模型**走完；模型（尤其是 0.6B 的小模型）只負責它做得到的小事：填參數、對單一候選回答是／否。

## 二、整條路的樣子

```
需求（UML 使用案例／一句話）
   │  ① 型別合約：UML 的參數與回傳型別 → 目錄的型別
   ▼
活動（使用案例的每一步：類別.操作(參數):回傳）
   │  ② 挑單元：名稱檢索（BM25）＋語意檢索（嵌入）→ 排名融合 → 型別打分
   ▼
單元（tool:… 或 py:…）
   │  ③ 資料流：同名優先、其次型別接得上；接不上用「型別接線矩陣」找橋接單元
   ▼
呼叫程式（JSON：輸入、步驟、條件、有上限的迴圈、引用）
   │  ④ 靜態檢查：單元存在、必填參數、型別、副作用彙整
   ▼
執行（catalog_run）：預算、逾時、取消、有風險的副作用先問使用者、可以只模擬
```

## 三、各層在做什麼、用什麼工具

| 層 | 做什麼 | 指令／工具 | 設計章節 |
|---|---|---|---|
| 單元目錄 | 把工具與函式變成有型別、有副作用標記、有信任等級的單元 | `/unit-catalog`、`catalog_query` | 一～九 |
| 抽取與探測 | 從 Python 簽名、型別存根、實際探測學出參數與回傳型別、純不純 | `catalog_onboard`、`/unit-catalog stubs`／`probe` | 十～十八 |
| 型別接線矩陣 | 單元 A 的輸出接得上單元 B 的哪個輸入；找「從甲型別走到乙型別」的前幾條路 | `catalog_query` 的 plan、`/unit-catalog plan` | 八～九 |
| 執行格式與直譯器 | 把一串單元接成程式、檢查、執行 | `catalog_run`、`/unit-catalog run` | 二十 |
| 回傳結構補齊 | 從過去成功呼叫的實際回傳值反推 JSON 結構，補「回傳型別不明」的單元 | `/unit-catalog shapes`（`scan`、`clear`） | 二十一 |
| 需求接線 | UML 使用案例 → 單元 → 呼叫程式，0 次模型呼叫 | `catalog_bind`、`/unit-catalog bind` | 二十一、二十三 |
| 中文用途說明 | 讓中文需求找得到英文名稱的單元 | `catalog_intent`、`/unit-catalog intents` | 二十三 |
| 語意檢索 | 嵌入模型＋BM25 排名融合；沒啟用就退回名稱檢索 | `/unit-catalog embed`（`enable`、`build`、`disable`） | 二十二、二十三 |
| 小模型評測 | 量 0.6B 挑單元、填參數的能力 | `/unit-catalog eval` | 十九 |

## 四、常見做法

**我有一份 UML，想知道哪些步驟已經有單元可以用**
`/unit-catalog bind <UML 文字>`（或讓 AI 呼叫 `catalog_bind`）。看三樣東西：每一步挑到哪個單元與怎麼挑的（`retrieval+contract`＝名稱對上、`semantic+contract`＝靠語意、`type-wiring`＝用型別接線）、`issues`（沒對上 `unbound`、沒接上 `unwired`、前一步回傳型別不明 `opaque_link`、信心低 `low_confidence`、語意挑的 `semantic_match`）、程式有沒有通過檢查。

**接通的程式想先看看會做什麼**
把 `catalog_bind` 給的 `program` 交給 `catalog_run`，先用 `dry_run:true`：只檢查、不呼叫，列出每一步與副作用。

**很多步驟顯示「回傳型別不明」**
用一陣子之後跑 `/unit-catalog shapes scan`，把對話與離線訓練器的紀錄補進來。成功呼叫過、回傳是 JSON 的工具才有樣本。

**中文說法找不到單元**
`/unit-catalog intents` 看還缺哪些；請 AI 用 `catalog_intent`（`action:"set"`）補一句中文。這是效益最大的一步（前 5 名命中率 60.5% → 92.1%）。

**想啟用語意檢索**
`/unit-catalog embed enable`，同意下載約 118MB，約 1 分鐘算完單元向量。之後 `catalog_bind` 自動使用；`/unit-catalog embed disable` 隨時關掉。

**認識一個新的 Python 函式庫**
`catalog_onboard`（PyPI 套件名稱，安裝每次都要同意）；完成後用 `catalog_intent` 補中文說明，再 `/unit-catalog embed build` 補向量。

## 五、設計原則（做決定時照這個）

1. **能用程式決定的就不要問模型。** 檢索、型別、接線、檢查都是程式；0.6B 實測從 5 個候選挑對的只有 28.9%（亂猜 20%），而且偏好第 1 個。
2. **寧可標示不確定，不要硬配。** 名稱對不上就不採用；沒有單元就說沒有；所有不確定的地方列在 `issues`。
3. **來源要看得出來。** 每個型別有 `type_src`（annotation、stub、schema、doc、name、probe、observed、curated）；回傳結構補齊的標 `observed` 並附樣本數與選填欄位。人工補的永遠優先。
4. **有風險的副作用先問人。** 檔案寫入、子行程、桌面、委派、網路：執行前整份程式一起問一次。
5. **只存型別，不存值。** 回傳結構的累積只留型別。
6. **壞了要能退回。** 嵌入沒啟用、載入失敗、向量不夠，一律退回名稱檢索並說明原因。

## 六、目前的限制（誠實版）

- 目錄裡**沒有**的單元就是沒有：例如沒有「數頁數」「寄信」「資料轉換」（取清單前幾個、字串相接）。
- 很多媒體工具的檔案參數是選填，不在「必填參數接得上」的接線範圍內。
- UML 只做直線流程，不會產生條件與迴圈。
- 名稱路徑先通過但不是最佳的（`getQueryParams` 配到 `urlparse` 而不是 `parse_qs`）、近義單元（`stdev`／`pstdev`、`exists`／`lexists`）只取最高分，不會問使用者。
- 回傳結構補齊只能補「用過」的；沒用過、回傳不是 JSON、永遠失敗的工具不會有樣本。
- 所有實測樣本都小（8～46 題）、題目由我寫、單一機器；數字看方向，不是精確指標。
- 高階函式（callable）、迭代器、事件、工作者（第十五節）、JavaScript／bash 的抽取器、區塊與組合語言層級的單元、「行為編成矩陣」（要先確認 RoLE 的形式）都還沒做。

## 七、檔案地圖

核心（都是純函式，Node 與瀏覽器共用，旁邊有 `.test.js`）在 `renderer/src/catalog/`：
`catalog_core`（單元與型別）、`matrix_core`（接線矩陣）、`extract_py.py`／`stub_to_types.py`／`probe_py.py`／`probe_core`／`onboard_core`（抽取、探測、認識新函式庫）、`ir_core`（呼叫格式與直譯器）、`select_core`（檢索與評測）、`shape_core`（回傳結構逆向推論）、`embed_core`（嵌入檢索）、`bind_core`（需求→活動→單元）。
資料在 `renderer/src/catalog/data/`（`stdlib_types.json` 標準庫型別表、`unit_intents.json` 中文用途說明）與 `eval/selection_set.json`（評測集）。
主程式整合在 `renderer/src/floating-assistant.js` 搜尋 `_unitCatalog`。
