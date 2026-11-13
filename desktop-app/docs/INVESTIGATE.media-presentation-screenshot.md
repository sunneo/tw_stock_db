# 調查報告：media-presentation 的網頁截圖與格式錯誤迴圈

> 範圍：只讀程式碼與設定（desktop-app 分支，工作目錄 `desktop-app`）。沒有改任何現有檔案、沒有 commit、沒有跑整套測試、沒有啟動真的桌面程式或瀏覽器。
> 唯一新增的檔案是這一份報告。
> 行號以調查當下的檔案為準。

## 0. 結論摘要

1. **有截圖與裁切的能力，而且不只一種。** `browser_screenshot` 已支援 `region`（框選範圍）、`scale`（放大）、`interpret`（讓模型看懂截圖內容）、`save`（存成檔案代號）。media-presentation 的領域工具名單裡也有它（`deck_tools.js:410`）。所以不是「沒有工具」，是**提示文字沒教它用**。
2. **提示文字把截圖排在最後一順位，而且只說「整頁截圖不合這一頁的重點」。** 沒有一句話說「要裁切」「要框選區域」「截圖會太小」「可以放多張裁切圖」「純文字就改畫示意圖」。這解釋了為什麼新聞來源只用 `browser_get_page_text` 讀文字、完全沒截圖。
3. **版面端的文字反而鼓勵整頁截圖放大。** `layout` 主題寫「一張大圖、寬表格或**截圖** → visual（整頁畫面）」。沒有任何程式會檢查圖片解析度、長寬比或是否太小。
4. **格式錯誤迴圈的根因在驗證流程，不是 AI 單純笨。** 三個機制疊在一起：
   - 驗證是**分段**的：核心格式有錯時，2D 圖形的檢查根本不跑（`deck_tools.js:495-502`），所以修完一批才會冒出下一批。
   - 2D 圖形的嚴格驗證**遇到第一個錯就 return**（`floating-assistant.js` 約 118240 行），一次只報一個圖形、每個圖形也只報第一個缺欄位。
   - `get_presentation_topic` 第二次要同一主題時，**只回一句提醒、不再給內容**（`deck_tools.js:631-633`）。模型若忘了欄位名稱，就沒有辦法再拿到說明，只好改去讀網頁「查格式」。
5. **正確欄位的說明其實存在**（`deck_topics.json` 的 `visuals` 主題：circle 用 `radius`、rect 用 `width`/`height`、line/polygon 用 `points`、text 用 `content`、圖形放在 `scene.shapes`）。問題是它只是一長段說明文字，沒有「錯誤訊息附正確欄位名」的對照，也沒有最小範例。
6. **「（共9927字）」這個截斷標記在程式碼裡找不到。** `get_presentation_topic` 的回傳沒有截斷（`deck_tools.js:637` 直接回全文）。截斷可能發生在宿主的工具結果顯示層，這一點本次未能確認，需要實測。

---

## A. 現有截圖與裁切能力

### A-1. `browser_screenshot`（來源：`renderer/src/floating-assistant.js` 約 85747–85830 行）

| 參數 | 作用 | 位置 |
|---|---|---|
| `region: {x, y, width, height}` | 只截分頁可視區內的指定範圍（像素，左上角 0,0）。`full_page: true` 時改用整頁座標 | 85762–85771、85814 |
| `scale`（1~3） | 放大小範圍，讓文字更清楚 | 85815 |
| `interpret: true` + `question` | 用支援讀圖的模型看這張截圖，把描述放進回傳結果 | 85757 的說明文字 |
| `save: true` | 存成檔案，回傳 `file_id`（可當 `client-file/<id>` 用） | 85757 的說明文字 |
| `full_page: true` | 截整頁（最高 8000px） | 85757 的說明文字 |

- 裁切的實作有兩層：擴充功能支援時直接截範圍；舊版擴充功能會忽略 `region`，這時程式用 `_cropDataUrl` 在本機裁（85774–85779，函式定義在 84079 行）。
- 說明文字第一句就寫：「預設你只拿到尺寸與標題、**看不到像素**」。也就是說，模型若沒帶 `interpret: true`，等於沒看到截圖內容。
- **與預期不符的地方**：媒體簡報的系統提示裡，`region`、`interpret`、`scale` 三者一個都沒有提到（只在 `deck_tools.js:1023` 的錯誤訊息裡出現一次「可帶 region 只截圖片那一塊」）。

### A-2. 簡報端的圖片版面（`renderer/src/deck/deck_core.js:1652–1670`）

- `visual.fit` 只有 `cover`（填滿，多出來的部分被裁掉）與 `contain`（完整放進去，周圍留白加陰影），預設值未在這段指定。
- `cover` 是**置中裁切**，截圖的上下左右重點可能被切掉；`contain` 在寬截圖上會變成很小的一條。
- 簡報端**沒有裁切功能**。`visual` 的 `callouts`（橘框標記，`deck_topics.json` 的 `visuals` 主題）只能「標出位置」，不能把畫面放大。
- 所以要讓截圖清楚，**裁切只能在截圖那一步做**（用 `region`）。

### A-3. 其他可用的截圖相關工具

- `get_elements` / `browser_get_elements` 會給元素座標（`region` 的座標與 `browser_get_elements` 同一套，見 85757）。模型可以先取得元素座標，再用 `region` 截那一塊。這是最省事的做法，但提示文字沒有寫。
- `browser_get_page_structure` 有 `images` 清單，可以用 `import_image_url` 把文章自己的圖拉進來。這是提示文字的第一順位，已經寫在 `deck_tools.js:353`。

**結論 A**：有能力（`region`、`interpret`、`save`、`get_elements` 座標），沒有被媒體簡報的提示文字教給模型。

---

## B. 提示文字與主題文字的相關規定

### B-1. 系統提示 `SYSTEM_PROMPT`（`renderer/src/deck/deck_tools.js:339–401`）

| 行號 | 內容 | 與調查問題的關係 |
|---|---|---|
| 347 | STEP 3：圖片順序「文章自己的 @imgN → generate_image → **截圖最後**」 | 截圖排最後，所以新聞沒截圖 |
| 353 | 「`browser_screenshot` 是整頁畫面，**不符合一張投影片的重點**，只在前兩者都沒有時才用」 | 有提到「整頁不合重點」，但**沒有**說太小、失焦、要裁切、要多張 |
| 353 | 「真實新聞事件用中性示意圖（會議室、文件、建築、圖表），不要用真人」 | 有「示意圖」，但只限於「生成圖片」情境，沒有寫「純文字來源就改畫示意圖」 |
| 354 | 找照片用 `find_photo`；瀏覽器工具可自行搜尋／截圖 | 沒有寫怎麼截圖、怎麼裁切 |
| 366 | DIGEST：「截圖與示意圖要在講到的部分加標記（callouts）」 | 只在「照抄範例」段落提到 callouts |
| 383 | 「`browser_screenshot` 帶 `save: true` 得到檔案代號」 | 只提到存檔，沒提 `region` |
| 388–400 | RULES THAT MATTER | **沒有任何一條與截圖、裁切、圖片大小有關** |

- 第 383 行「with callouts pointing at what changed」出現在「照抄另一份模型的做法」段落裡，不是一般規則。
- **整份系統提示找不到**：「截圖」「裁切」「太小」「失焦」「多張」「看不清」「重點區域」等字眼（只有 353、383、366 有零星提到截圖）。

### B-2. `get_presentation_topic` 各主題（`renderer/src/deck/deck_topics.json`）

| 主題 | 相關文字 | 評估 |
|---|---|---|
| `layout` | 「A big diagram, a wide table or **a screenshot -> visual**」 | **鼓勵整頁截圖放大**，與調查方向相反 |
| `visuals` | `image` 行：「`callouts` … **point at the part of a screenshot** the narration is talking about」 | 有提到「指向截圖的一部分」，但用的是橘框，不是裁切 |
| `sources` | 「A website: read the page with the browser tools (browser_get_page_text, browser_screenshot; a screenshot result has a short "client_file_url") and keep the text」 | 把截圖當成和文字一樣的來源，沒有說要裁切 |
| `style` / `format` / `cues` / `3d` / `interactive` / `ai_features` | 沒有截圖相關文字 | — |

**結論 B**：
- **沒有**告訴模型：整頁截圖放進投影片會太小、失焦。
- **沒有**告訴模型：應該裁切重點區域（標題、關鍵數字段落）。
- **沒有**告訴模型：可以放多張裁切圖。
- **沒有**告訴模型：純文字內容就改畫示意圖（只有生成圖片的情境有「示意圖」一詞）。
- **反而有**：`layout` 把截圖導向整頁 visual 版面。

---

## C. 圖片版面的長寬比與解析度檢查

- `deck_core.js` 的驗證：`fit` 只檢查是不是 `contain` / `cover`（471 行）。沒有任何地方讀圖片的寬高。
- `deck_tools.js` 的 `ImageCatalog` 條目只有 `ref`、`url`、`alt`、`from`、`context`（77 行），**沒有寬高欄位**，所以 `resolveImages` 也無從判斷。
- `resolveImages`（`deck_tools.js` 約 268–296 行）只檢查 handle 是否存在。
- 有一個地方讀了寬高：`deck_core.js:1658` 的繪製，但只用來算排版，不產生任何警告。
- `_deckFindPhoto` 會檢查下載的照片要夠大（寬 600、高 400，`deck_tools.js:651`），這是**唯一**的尺寸門檻，而且只在找圖流程裡，截圖與匯入截圖都不走這條。

**結論 C**：沒有偵測機制，也沒有「圖太小看不清」的警告。

**最小可行的改法**（未實作）：
1. 在截圖回傳（`browser_screenshot` 的 `meta`，`floating-assistant.js` 85788 附近）加上 `width`/`height` 與 `full_page`、`region_applied` 旗標（已有 `meta.width`，可再加高度與旗標）。
2. 在簡報匯入截圖的路徑（`deck_tools.js` 約 1023 行附近的 `_deckImportImageBlob`）把寬高寫進 `ImageCatalog` 條目。
3. 在 `_deckCheck` 的非嚴格警告（`checked.warnings`，不會擋下）加一條：`visual` 用到整頁截圖（沒有 `region_applied`）或寬高比超過 3:1 時，警告「整頁截圖，文字可能看不清，建議用 region 裁切」。
4. 門檻要跟版面的實際像素寬度按比例算（本次未查清模板的畫布像素寬度，不要寫死常數）。

---

## D. 格式錯誤迴圈（約 10 輪）

### D-1. 驗證為什麼一次只報一部分

| 機制 | 位置 | 效果 |
|---|---|---|
| **分段驗證** | `deck_tools.js:495–502`：先跑核心驗證 `Core.validate`，只有「沒有任何錯誤」時才跑 `_deckValidateScenes`（2D／3D 圖形）；再沒錯才跑圖片解析 | 修好核心錯誤後，才會冒出 2D 圖形錯誤，修完再冒出圖片錯誤。**每一段都要一輪。** |
| **每個 2D 圖形只報第一個錯** | `_validate2DShapeShape`（`floating-assistant.js` 約 118175 行）每個圖形只回傳第一個問題 | 同一個圖形的 `w` 與 `h` 同時錯，只會報 `width/height` 中的一個 |
| **整份 2D 動畫遇到第一個壞圖形就 return** | `_validate2DAnimationYaml` 嚴格模式（`floating-assistant.js` 約 118240 行）：`if (!lenient) return { ok: false, error: err };` | **一次只報一個圖形**。10 個圖形裡有 10 個錯，要跑 10 輪 |
| **錯誤訊息沒有索引、沒有正確欄位清單** | 例如「rect 類型缺少 width/height」（118190 行附近） | 不知道是 `shapes` 的第幾個，也不會列出合法欄位；模型只能猜 |
| **最多顯示 25 條** | `deck_tools.js:9`、505 行 | 超過的部分只說「and N more」 |
| **`fill` 只檢查字串或漸層** | `_validate2DShapeShape` 的 fill 檢查 | 驗證器**不會**檢查顏色名稱。`heading`、`accent` 這類名稱會通過驗證，到繪製時才會出問題（**本次未實測**）。顏色名稱清單來自 `deck.colors`（`deck_core.js:844`），那是整頁的配色，不是圖形的 fill。 |

### D-2. 說明文字為什麼被截斷、為什麼會「查不到」

- `get_presentation_topic` 的實作（`deck_tools.js:629–638`）回傳完整的 `T[topic]`，程式碼裡沒有截斷。
- **但**：同一主題第二次要求時，只回傳「You already have the ... rules above」的提醒，**不再給內容**（`deck_tools.js:631–633`）。
- 所以如果模型在長對話中「忘了」`visuals` 的欄位，程式不會再給它。模型於是改去讀網頁（使用者紀錄裡的 `browser_get_page_text`），是可以預期的結果。
- 「（共9927字）」這個字樣在 `renderer/src` 找不到。最可能來自宿主對工具結果的顯示層，本次**無法確認**，需實測。

### D-3. `yaml_id` 加 `edits` 為什麼找不到文字

- `applyEdits`（`deck_tools.js` 約 231–240 行）用**完全相同**的字串比對 `find`（`indexOf`）。
- 縮排、換行、全形半形只要有一個字元不同就失敗，錯誤訊息只說「找不到」，不列出附近的實際文字。
- 這就是使用者紀錄裡「find 因縮排或換行對不上」的原因。

### D-4. 有沒有一份完整的 shapes 欄位對照？

- **有**，在 `deck_topics.json` 的 `visuals` 主題，`shapes` 那段（約 `shapes   {scene: {width, height, duration, background, shapes: [...]}}` 開頭）：
  - circle 用 `radius`
  - rect 用 `width` / `height`
  - line / polygon 用 `points: [[x,y],...]`
  - text 用 `content` / `font_size`
  - 共同欄位 `fill`、`stroke`、`stroke_width`、`animation`、`id`
  - 圖形在 `visual.scene.shapes` 底下（符合驗證器的 `check2d`，`deck_tools.js:517–520`）
- **沒有**的：`path` 不在合法類型清單裡（`TWODANIM_SHAPE_TYPES`，`floating-assistant.js:72325`：circle／rect／polygon／line／text／image）。
- 使用者紀錄裡的錯誤（w/h、text、r、x1..y2、path）**全部都能從現有錯誤訊息推出正確欄位**，但是要一輪一個地推。

### D-5. 降低往返次數的具體做法

1. **一次回報全部錯誤**：`_validate2DAnimationYaml` 嚴格模式改成收集所有圖形的錯誤再回傳（把 118240 行的 `return` 改成 `push`）；`_validate2DShapeShape` 改成回傳陣列。
2. **核心錯誤與 2D 錯誤一起跑**：`_deckCheck`（`deck_tools.js:495–502`）不要「有錯就跳過後面」，而是兩組都跑、合併後一次回傳。
3. **錯誤訊息附正確欄位**：例如「shapes[3] 的 rect 要 width／height（你寫的是 w／h）」，並附該類型的完整合法欄位清單與一個正確範例。
4. **說明可以再取得**：`_deckTopicOne` 的重複呼叫不要只回提醒，改為回一份**精簡的欄位對照表**（幾百字，只列欄位名與型別），或允許 `get_presentation_topic(topic, part)` 分段取得。
5. **`edits` 比對寬鬆一點**：`applyEdits` 失敗時，先試「每行去掉前後空白」的比對；仍失敗就回傳該行附近的實際文字，讓模型照抄。
6. **提供最小範例**：系統提示或 `visuals` 主題裡放一段「一個 rect + 一個 text + 一個 circle」的完整可通過範例（模型照抄成功率高）。

---

## E. 修正建議（依影響大小排序）

| # | 影響 | 改什麼 | 檔案與函式 | 類型 |
|---|---|---|---|---|
| 1 | **大**：截圖失焦問題的根本來源 | 系統提示加一條規則：**不把整頁截圖放進投影片**；先用 `get_elements` 取得重點元素座標，再用 `browser_screenshot` 帶 `region` 裁切（1～3 張）；要讓模型看懂就帶 `interpret: true` 與 `question`；純文字來源（新聞、文章）改畫示意圖（`svg_picture`／`shapes`）；使用者明確要求「截證據」時，截圖不再排最後 | `renderer/src/deck/deck_tools.js` `SYSTEM_PROMPT`（約 347、353、383、388–400 行附近） | **改提示文字** |
| 2 | **大**：`layout` 把截圖導向整頁 visual | `layout` 主題那句「a screenshot -> visual」改成「a **cropped** screenshot (region) -> visual; a whole page is never the picture」 | `renderer/src/deck/deck_topics.json` 的 `layout` 鍵 | **改提示文字** |
| 3 | **大**：格式錯誤迴圈 | 2D 驗證改為收集所有錯誤；核心驗證與 2D 驗證一起跑 | `renderer/src/floating-assistant.js` `_validate2DAnimationYaml`（約 118240 行）、`_validate2DShapeShape`（約 118175 行）；`renderer/src/deck/deck_tools.js` `_deckCheck`（495–502 行） | **改工具** |
| 4 | **中**：錯誤訊息不足以一次修好 | 錯誤附圖形索引與合法欄位清單；`rect` 的錯誤要點出 `w/h` 是錯的欄位名 | 同上 `_validate2DShapeShape` | **改工具** |
| 5 | **中**：說明查不回來 | 同一主題重複要求時回精簡欄位表（不再只回提醒）；`visuals` 主題加一段最小範例 | `renderer/src/deck/deck_tools.js` `_deckTopicOne`（629–638 行）；`deck_topics.json` 的 `visuals` 鍵 | **改工具＋改提示文字** |
| 6 | **中**：整頁截圖沒有任何警告 | 截圖回傳加寬高與 `region_applied`；簡報匯入截圖時寫入 `ImageCatalog`；非嚴格警告：整頁截圖或極寬截圖 | `renderer/src/floating-assistant.js` `browser_screenshot`（約 85757–85830 行）；`deck_tools.js` `ImageCatalog`（約 77 行）與 `_deckCheck` 警告 | **改工具** |
| 7 | **中**：`find` 對不上 | `applyEdits` 加寬鬆比對，失敗時回傳附近實際文字 | `renderer/src/deck/deck_tools.js` `applyEdits`（約 231–240 行） | **改工具** |
| 8 | **小**：`layout` 與 `sources` 的截圖提及 | `sources` 那句補上「截圖請用 region 裁切」 | `deck_topics.json` 的 `sources` 鍵 | **改提示文字** |
| 9 | **小，待實測**：顏色名稱是否真的造成錯誤 | 先實測後再決定；提示文字可寫明「圖形的 fill 用 `#rrggbb`」 | 待定 | 待定 |

### E-1. 桌面版與網頁版的共用關係（重要）

- **原始碼只有一份**：`renderer/src/floating-assistant.js`（約 2.1MB、3 萬多行，`build-assistant.js` 檔頭註解）。
- 桌面版讀的是 `renderer/floating-assistant.js`，那是**壓縮後的輸出**（`build-assistant.js` 產生）。網頁版用 `fetch` 讀同一個 `renderer/floating-assistant.js`（同一支檔案）。所以**改一次、兩邊都會生效**。
- 媒體簡報的提示與工具分散在**來源模組**，再由 `scripts/embed-code-ui.js` 的 `embedDeck()`（325–337 行）嵌入：
  - `renderer/src/deck/deck_tools.js`（提示與工具）與 `deck_host.js` → 嵌入 `renderer/src/floating-assistant.js` 的 `DECKHOST` 區塊
  - `renderer/src/deck/deck_core.js`、`deck_topics.json`、`deck.css` → 嵌入 `DECKSRC` 區塊
- **修改規則**（見記憶「嵌入的來源模組」）：改 `deck_tools.js`、`deck_core.js`、`deck_topics.json` 之後，**要執行 `node scripts/embed-code-ui.js`**，再執行 `node build-assistant.js`。不要直接改 `renderer/src/floating-assistant.js` 裡的嵌入副本，否則下一次嵌入會被蓋掉。
- 另外，2D 驗證器（`_validate2DAnimationYaml`、`browser_screenshot`）**直接寫在** `renderer/src/floating-assistant.js` 裡，沒有來源模組，要直接改那一份，然後同樣跑 `build-assistant.js`。
- 發布 patch 的流程另有技能（`publish-live-update-patch`），本次調查不涉及發布。

---

## F. 與預期不符、需要明講的地方

1. 使用者紀錄裡「簡報前三張都是同一張 `render_stock_chart` 的 K 線圖」：本次只查到提示文字的優先順序（圖表與工具先於網頁截圖），**沒有查到**為什麼三張都選同一張圖。這需要看對話紀錄，不在本次範圍。
2. 「（共9927字）」截斷標記：程式碼裡找不到，見 D-2。
3. 顏色名稱是否造成錯誤（第 9 項實測結果）：`scripts/deck-tests/deck_tools.test.js` 的「第9項實測」兩條：圖形 `fill: "heading"` **驗證器放行**（只看型別是字串），`fill: 5`（數字）才會被擋。放行後能不能畫出正確顏色要看繪製端：`viewer2d.js` 直接把 fill 交給 canvas，`heading` 不是合法的 CSS 顏色，canvas 會忽略這個賦值、沿用前一個顏色（這是 canvas 的標準行為，**沒有在真的瀏覽器裡量到**）。結論：驗證器不擋顏色名稱是事實，建議提示文字寫明「fill 用 #rrggbb」（已加在 `TOPIC_RECAP.visuals` 的欄位對照表，見 H 節；主題原文沒有單獨寫這一條）。
4. 原本調查期間沒有跑測試；實作之後的測試結果見 H 節。
5. 追加項 B 的根因已用真的 2D 繪製引擎重現（見 H 節 B-1），不是只靠讀程式推論。
5. `layout` 主題的「a screenshot -> visual」與 E 項第 1、2 點的建議互相衝突，建議以 E 為準（改成「裁切後的截圖」）。

## G. 未處理（本次範圍外，列為後續）

- 整套測試：未執行。修改 `deck_tools.js` 後，相關測試為 `scripts/deck-tests/deck_tools.test.js` 與 `deck_core.test.js`（見 `scripts/run-core-tests.js:315、368`）。
- 真實桌面版與網頁版的截圖效果：未驗證。

---

## H. 實作狀態（2026-11-13）

本節是實作後的結果。E 節的 1～9 項與兩個追加項都已處理；沒有 push、沒有發布、沒有動版本號。

| 項目 | 狀態 | 主要位置 |
|---|---|---|
| E-1 提示文字：不放整頁截圖、先取元素座標再裁切、純文字改畫示意圖 | 已做 | `deck_tools.js` 的 `SYSTEM_PROMPT`（PICTURE PRIORITY、新段 SCREENSHOTS OF WEB PAGES、RULES）；`deck_topics.json` 的 `sources` |
| E-2 `layout` 的截圖改成裁切後的截圖 | 已做 | `deck_topics.json` 的 `layout` |
| E-3 2D 驗證一次回報全部錯誤；核心、圖形、圖片檢查一起跑 | 已做 | `floating-assistant.js` `_validate2DAnimationYaml`（收集 `problems`）；`deck_tools.js` `_deckCheck`、`_deckValidateScenes` |
| E-4 錯誤附圖形索引、寫錯的欄位、合法欄位與最小範例 | 已做 | `floating-assistant.js` `_validate2DShapeProblems`、`TWODANIM_SHAPE_FIELDS`、`TWODANIM_FIELD_ALIASES` |
| E-5 同一主題重複要求回欄位對照表；`visuals` 加最小範例 | 已做 | `deck_tools.js` `TOPIC_RECAP`、`_deckTopicOne`；`deck_topics.json` 的 `visuals` |
| E-6 整頁截圖警告（寬高、是否整頁、是否框選） | 已做 | `floating-assistant.js` `browser_screenshot` 的回傳；`deck_tools.js` `ImageCatalog.markShot`、`shotWarnings` |
| E-7 `edits` 寬鬆比對；找不到時回最接近的實際原文 | 已做 | `deck_tools.js` `findInYaml`、`reindentText`、`nearestYamlLines`、`applyEdits` |
| E-8 `sources` 補上 region 裁切 | 已做 | `deck_topics.json` 的 `sources` |
| E-9 顏色名稱 | 已實測（見 F-3） | `deck_tools.test.js`「第9項實測」 |
| 追加 A 字幕對比 | 已做（播放端；匯出路徑未逐一檢查） | `deck_core.js` `pickSubtitleText`、`subtitleInk`、`checkSubtitleContrast` |
| 追加 B 圖形擠在原點 | 根因已用真的 2D 繪製引擎重現，已修（驗證器＋警告＋提示） | 見下 B-1～B-4 |

### 追加 B 的結論

**B-1 根因（已重現）。** 用 `renderer/src/deck/viewer2d.js`（簡報播放器實際用的 2D 引擎）、加上記錄用的假畫布，畫使用者描述的那份 deck：

- 沒寫 `width`／`height`，畫布落回預設 480×320。
- 座標寫成 `x: 0.1`、`y: 0.15` 這類比例，引擎把它當像素用。三個圖形的繪製位置是 `(0.1,0.15)`、`(0.3,0.4)`、`(0.5,0.6)`，全部擠在左上角一個像素內。
- `fontSize` 不認得，文字退回 16px。`r` 不認得，圓的 `arc` 半徑是 `null`，畫不出來。`strokeWidth` 不認得，描邊寬度沒有生效。
- 同一段內容改成像素座標、寫上 `width`／`height: 960／540`、用正確欄位名，三個圖形畫在 `(120,80)`、`(300,200)`、`(600,380)`，字是 40px。

所以「擠在一起」的原因就是**比例座標＋沒寫畫布大小＋欄位名不對**。引擎只讀 `position`（或 `x`／`y`／`cx`／`cy` 當像素）、`font_size`、`stroke_width`、`radius`；`anchor`、`weight` 沒有這個功能。

**B-2 驗證器（已做）。** 在 `_validate2DShapeProblems` 加了每種型別的合法欄位清單（`TWODANIM_ALLOWED_FIELDS`）與共用欄位清單。不在清單裡的欄位都會報錯，並點名正確的名字：`x`／`y`／`cx`／`cy` 改 `position: [x, y]`、`r` 改 `radius`、`fontSize` 改 `font_size`、`strokeWidth` 改 `stroke_width`、`w`／`h` 改 `width`／`height`、`text` 改 `content`、`path` 改 `points`。`anchor`、`weight`、`bold` 會說明不支援與替代做法。`position` 不是兩個數字也會報錯。另外，**座標全部落在 0～1 之間**（至少兩個圖形）會報錯，說明座標是像素、要寫 `width`／`height`。這些都是 strict 模式（生成時）的檢查，播放舊動畫的 lenient 模式不受影響。

**B-3 分數座標：選擇「不支援、明確報錯」，沒有讓繪製端改吃比例。** 理由：繪製端的座標一律是像素；沒寫畫布大小時的預設是 480×320，比例座標和像素座標無法可靠區分；若把 0～1 當比例，已經發佈過的動畫裡本來就是小座標的圖形位置會變。報錯加上明確的替代寫法，比猜測安全。提示文字（`visuals` 主題、SYSTEM_PROMPT）也寫明「座標是像素、不要寫 0～1」。

**B-4 缺 `width`／`height`（已做）。** 在 `deck_core.js` `validateVisual` 加一條非嚴格警告：「no width/height: the shapes are drawn on a 480×320 canvas by default」。不擋存檔。

**B-5 回歸測試（已做）。** `deck_core.test.js` 用真的 `viewer2d` 畫固定寫法的三個圖形，斷言位置各自正確、字級是 40px；`deck_tools.test.js` 用使用者那份 deck 的寫法，斷言每一類錯誤都被點名（比例座標、x／y、fontSize、strokeWidth、r、anchor、weight），而像素座標正常通過。

### 追加 A 的結論

- `pickSubtitleText`：沒寫 `subtitleText` 時，白字對條的對比夠（≥4.5）就用白字，否則用深字（`#1B1B1B`）。明寫的字幕文字如果對比不足，也會換成對比較高的那個（照「對比不足時也自動改」）。透明度不算進底色，以條本身的顏色算。
- 校驗（不擋存檔）：明寫的字幕文字與字幕條對比不足，警告；字幕條是亮色而沒寫深色字幕文字，也警告。
- 提示文字：`SYSTEM_PROMPT` 與 `format` 主題的 colors 段都加了「亮色字幕條要同時給深色字幕文字」。
- 沒有逐一檢查 PPTX／MP4 匯出的字幕路徑；本次只改了播放端的繪製（`deck_core.js` 的字幕繪製）。

### 測試結果（實際輸出）

- `node scripts/deck-tests/deck_core.test.js` → `deck_core: 94 passed, 0 failed`
- `node scripts/deck-tests/deck_tools.test.js` → `deck_tools: 76 passed`
- `node scripts/deck-tests/deck_topic.test.js` → `deck_topic: 37 passed`
- `node scripts/deck-tests/deck_interactive.test.js` → `97 passed`
- `node scripts/deck-tests/deck_voice.test.js` → `PASS 簡報字幕與配音備援：28 passed, 0 failed`
- `node scripts/offline-gate-embed.test.js` → `9 passed, 0 failed`
- `node scripts/deck-tests/deck_url_wiring.test.js` → `19 passed, 1 failed`。失敗的那條（「程式組簡報不看有沒有附件／網址」）是比對式用 LF，工作目錄的檔案是 CRLF，與本次改動無關，沒有改它。另外把「提示詞寫了圖片優先順序」那條的 `LAST resort` 改成新的截圖段落用語（那段文字是本次刻意移除的）。

### 沒有驗證的部分

- 沒有開真的 Electron 或瀏覽器，沒有在真的畫布上看字幕與圖形的最後樣子（只有假畫布記錄與引擎內部的位置計算）。
- 沒有跑整套核心測試（依使用者規則，只跑動到的測試檔）。
- 沒有驗證模型實際寫出的 deck 會不會照新規則寫（提示文字的效果要靠真實對話觀察）。
- `browser_screenshot` 的 `region`、`whole_page` 與高度量測，只在程式上接好，沒有在真的擴充功能上量過。
- E-9 的「fill 用顏色名稱」只測到驗證器的行為；繪製時 canvas 的實際表現沒有量測。
