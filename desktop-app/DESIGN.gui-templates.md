# 圖形介面程式設計範本（GUI 範本線）

> 日期：2026-11-14。使用者原話見 `docs/HANDOFF.gui-templates.md` 第 5 節。
> 狀態：第 1 節（現況）與第 2 節（設計）已完成；待辦 3 起為實作。行號是 2026-11-14 在分支 `desktop-app` 讀到的，`floating-assistant.js` 很大且常改，行號只當入口，請用字串再搜。

## 0. 設計原則（使用者最高目標，取捨時照它）

使用者原話（2026-11-14）：「我的理想是把概念上的「what you think is what you build」「gui應用程式就像自來水一樣，隨想隨生」」

1. **一句話就能生出可跑的程式**：預設值要完整；逐步詢問只問真正有歧義的，其餘直接套範本先生出來，生完再讓使用者在設計工作室微調。不做長問卷。
2. **速度快**：組合範本這一步全由程式完成（離線、弱模型也能做）；模型只負責選範本與填內容（參數）。
3. **想的和做的對得上**：每次生成都附分鏡，使用者馬上看出哪裡不符；改一處只重生那一處（範本是一對一對的小元件，重生範圍就是被改的那個元件）。
4. **一對檔案**：最小單位是 `<名稱>.jsonl` 加同名 `<名稱>.py`；客製化＝加行或覆寫行；超出範圍的客製化走外部呼叫（參考另一個 Python 檔的函式）。見第 4 節。
5. **所有設計都要能在 Python 模擬器裡跑**，套件相依性寫在每個範本檔的 `require` 紀錄裡；只在一般桌面 Python 跑過的不算完成。

（第 2 節是 2026-11-14 早先寫的第一版設計，用單一 JSON 規格；第 4 節的成對檔案格式取代它的 2.2、2.3，其餘（檢索、詢問、分鏡、工作室）仍有效。）

## 1. 現況（唯讀調查）

### 1.1 Python 端圖形介面能做什麼、缺什麼

| 能力 | 現況 | 出處 |
|---|---|---|
| 視窗 | `gui.Window(title, width, resizable, maximizable)`；一次最多 4 個視窗、每視窗 200 個節點、巢狀最深 8 層 | `renderer/src/pybridge/gui.py:31`；上限 `renderer/src/gui/gui_bridge.js:26` |
| 版面 | 只有 `row`、`column`、`expander` 三種容器，靠 `parent=` 套疊；沒有格線、分頁、分割窗、捲動區、對齊與間距設定 | `gui.py:60-70` |
| 控件（Python 已封裝） | label、button、entry、editor、table、multilist | `gui.py:49-94` |
| 控件（橋接與畫面層已支援、Python 沒封裝） | textarea、checkbox、progress、list；另有 `enabled`、`visible`、`placeholder`、`secret` 等屬性 | 種類表 `gui_bridge.js:36-55`；畫面 `gui_render.js:48-237`；`gui.py` 沒有對應方法，也沒有「改既有節點屬性」的方法（橋接有 `set`，見 `gui_bridge.js:228`） |
| 畫布 | `canvas(width,height,fps)`＋`draw(ops)`：clear／rect／circle／line／text／image，每幀最多 200 道指令；圖片每視窗 16 張、每張 256 KB | `gui.py:96-112`；`gui_bridge.js:30-35` |
| 事件 | click、close；背景處理 input／cell／toggle／select；畫布有 key、frame、mouse（down／up／move）、wheel、resize；`poll()` 不等待、`wait()` 阻塞 | `gui.py:114-156`；事件表 `gui_bridge.js:36-55` |
| 聲音 | **沒有**。pygame 相容層文件明寫「no sound」，沒有 mixer；橋接協定沒有聲音節點或指令。桌面版另有 `game_audio.js`（網頁音訊合成）但只服務遊戲編輯器，沒接到 Python 圖形介面 | `renderer/src/pybridge/pygame.py:28`；`renderer/src/game/game_audio.js` |
| 快捷鍵 | **沒有**視窗層級的快捷鍵登記；只有畫布會收 key 事件（需先點一下畫布取得鍵盤焦點），且 pygame 層只認方向鍵、空白、Enter、Esc 與單一字元 | `gui_render.js:205`；`pygame.py:50-76` |
| 配色與佈景 | **沒有**主題或配色設定：控件樣式由頁面端決定，Python 只能在畫布裡自己給顏色；沒有深淺色、字型、字級設定 | 畫面層全用 CSS 類別（`gui_render.js:51` `gui-row` 等） |
| 選單、對話框 | 視窗內**沒有**選單列、右鍵選單、對話框；檔案選擇、訊息框走另一條 `zenity`（殼層指令，不是 `gui.Window` 的一部分） | `renderer/src/gui/zenity.js` |
| 畫布繪圖限制 | 沒有離屏繪圖、沒有透明度設定、只有 1 或 0 的線寬、字級與字型由頁面決定 | `pygame.py:28-33` |
| pygame 相容層 | display／draw／Rect／font／image／event／key／mouse／time／transform；程式裡 `import pygame` 會被換成這層 | `pygame.py:1-47` |

結論：目前的圖形介面是「很薄的傳統控件＋畫布」。範本若要涵蓋版面、快捷鍵、配色、佈景、聲音，**有一半是 Python 端與橋接端目前沒有的能力**，待辦 3 必須補，不能只寫範本文字。

### 1.2 現有範例與驗證

- `scripts/eval/gui_examples/breakout.py`：唯一的畫布範例（打磚塊）。
- 真實桌面版驗證評估檔：`scripts/eval/gui_*.eval.js`（橋接、殼層、縮放、自動關閉、Python 工作執行緒、AI 上限、標準輸出位置）。
- 單元測試：`renderer/src/gui/*.test.js`、`gui_py_test.py`、`gui_pygame_test.py`。
- 設計紀錄：`DESIGN.gui-bridge-delta-for-redmine.md`（協定與限制的實機驗證清單）。

### 1.3 線上與離線 AI 現在怎麼寫圖形介面程式

- **線上 AI**：沒有圖形介面專用的引導。唯一的來源是 `gui.py`、`pygame.py` 的文件字串（整份被嵌進 `floating-assistant.js`，搜 `import gui\n    w = gui.Window` 與 `Supported: display`），加上 `python_execute`／`terminal_run` 的工具說明。AI 只能照文件字串自己寫，沒有版面、行為、配色的慣用法。
- **離線 AI**：寫程式走 `write_code` 工具與「依需求寫程式」的路由（`floating-assistant.js` 內 `code_program`，搜 `id: 'code_program'`）；沒有任何圖形介面的分流。語言設定裡 python 的規則只談標準輸入輸出（搜 `用 def 定義；從標準輸入讀`）。
- **遊戲是個別特例**：`renderer/src/game/`（`game_templates.js` 十個遊戲範本、`game_core.js` 規格驗證、`game_gen.js` 逐檔移植到各平台）已有「範本→起手場景→用說的延伸」機制，但它產出的是遊戲規格，不是用 `gui.py` 寫的程式；可借鏡其設計，不可直接重用資料。
- 偵測 `import gui`／`import pygame` 的程式碼在 `renderer/src/gui/py_async.js` 與 `py_worker.js`，決定程式要不要走圖形工作執行緒。

### 1.4 可重用機制盤點（各自怎麼存、怎麼檢索）

| 機制 | 存放 | 檢索／套用方式 | 對本線的用處 |
|---|---|---|---|
| 遊戲範本 | `renderer/src/game/game_templates.js`（純資料產生器：`list()`、`build(id,{name},libs)`，產出再交給 `FaGame.validate`） | 使用者選範本 id，程式展開 | 「範本→展開→驗證→再用說的延伸」的現成形狀；`.fagame` 遊戲包是「存成自己的檔、可持續編輯」的先例（`game_pack.js`） |
| 簡報主題欄位表 | `renderer/src/deck/deck_topics.json`，由 `get_presentation_topic` 取用；`deck_template.default.json`＋`deck_template_admin.js`（版面、配色、圖片角色的設定畫面，欄位表在 `S.data.schema`） | 依主題名取欄位說明給 AI；範本設定畫面存到本機 | 版面／配色／佈景的資料欄位範例，以及「範本設定畫面放在擁有該領域的功能內」的先例 |
| 食譜（Recipe） | `renderer/src/recipe/recipe_core.js`（`FaRecipe`），說明 `DESIGN.offline-recipes.md` | 程式管路由、欄位、驗證；模型只回編號選單或固定欄位；有決策記錄 | 離線逐步詢問的主幹：每個設計步驟＝一題封閉題 |
| 字母選擇題 CoLU | `DESIGN.colu.md`、`DESIGN.colu-porting.md` | 模型每次只答一個字母，程式檢查與預設退路 | 離線詢問版面／配色等選項時的標準形狀 |
| 逐層切割 UML design | `renderer/src/uml/design_core.js`、`DESIGN.uml-framework.md` | 由上而下切到不可再切 | 「領域→步驟→範本片段」的切割骨架；找不到範本時的自行設計路徑 |
| 函式範本庫 | `DESIGN.fn-template.md`（設計，第二階段，尚未實作） | 意圖比對→填槽位→產生→驗收→才回存 | 「使用者微調後存成範本，下次當參考案例」的晉升規則（驗收通過才回存）可沿用 |
| 擴充點 | `renderer/src/ext/ext_core.js`（`FaExt`，宣告式 JSON）、`DESIGN.extension-points.md` | 以宿主工具登記，線上與離線的工具表都看得到 | 把範本檢索、設計工作室登記成宿主工具的接法 |
| 工具目錄與離線路由 | `renderer/src/catalog/`（`route_core.js`、`select_core.js` 等） | 工具登記後，離線模型用編號選單挑 | 範本檢索工具登記後自動進離線路由，不必另寫 |
| 佈景（蒙皮） | `renderer/src/skin/skin_core.js` | 與使用者介面佈景**無關**（是三維蒙皮動畫）；調查結論：本專案**沒有**可重用的介面配色／佈景系統給 `gui.Window` | 配色與佈景範本要自己定義資料格式，並在畫面層加主題變數 |
| 設計工作室 | `renderer/src/studio/`（訓練工作室，非介面設計） | 與本線無關，只是同名 | 無；本線的「設計工作室」要另做，可借鏡 `game_ui.js` 與 `deck_edit_ui.js` 的編輯器外觀 |

### 1.5 缺口摘要（交給第 2 節設計、待辦 3 補）

1. 範本資料格式與檢索：沒有。
2. 逐步詢問流程（線上直接問、離線字母選擇題）：現有食譜與 CoLU 可借，但沒有圖形介面領域的步驟表。
3. Python 端缺：聲音、視窗快捷鍵、配色與佈景、選單列與對話框、格線／分頁／分割／捲動容器、改節點屬性、checkbox／progress／list／textarea 的封裝。
4. 分鏡（各場景畫面序列）、設計工作室、使用者範本庫：沒有。
5. 十三個領域各自的範例程式：沒有，只有一個打磚塊。

## 2. 設計

> 決定原則（歧義已自行決定，標「決定」）：程式能決定的不問模型（沿用食譜原則）；範本是**設計規格（資料）**，程式碼由組合器確定性產生，這樣使用者微調的是規格、不是程式文字，存成範本才可重用；桌面版優先，網頁版同一份資料也能跑。

### 2.1 總覽

```
使用者需求
  → 領域判斷（十三個領域＋「其他」）
  → 逐步詢問：版面 → 應用程式行為 → 配色 → 佈景 → 快捷鍵 → 聲音（每步先找範本，找不到才自行設計）
  → 設計規格（一份 JSON，七個區塊，見 2.2）
  → 組合器：規格 → Python 程式（確定性）
  → 驗收：語法檢查＋橋接協定檢查＋假橋接空跑（見 2.7）
  → 成品＋分鏡＋設計工作室（微調後可存成使用者範本）
```

### 2.2 設計規格（成品的中間格式，也是範本的內容）

存成 JSON，欄位如下（決定：用 JSON 不用 YAML，因為工具鏈與校驗已有，且使用者範本要程式讀寫）：

```json
{
  "format": "guitpl/1",
  "id": "text-editor-basic",
  "domain": "text-editor",
  "title": "基本文字編輯器",
  "source": "builtin | user | designed",
  "layout":    { "window": {"title":"…","width":640,"resizable":true},
                 "tree": [ {"kind":"column","children":[ … 節點樹，種類限橋接支援的，加上新容器 ]} ] },
  "behavior":  { "state": {"dirty":false},
                 "handlers": [ {"on":"click:save","do":"save_file"}, {"on":"input:editor","do":"mark_dirty"} ],
                 "loop": "wait | poll_frame" },
  "palette":   { "bg":"#1e1e1e","fg":"#dddddd","accent":"#4aa3ff","danger":"#e5534b","muted":"#888888" },
  "theme":     { "name":"dark","font":"monospace","size":14,"radius":4,"density":"normal" },
  "shortcuts": [ {"keys":"Ctrl+S","do":"save_file"}, {"keys":"Ctrl+Z","do":"undo"} ],
  "sound":     [ {"on":"save_file","tone":"ok"} ],
  "scenes":    [ {"id":"main","title":"主畫面","note":"…","shows":["layout.main"]},
                 {"id":"empty","title":"空白文件","state":{"dirty":false}} ],
  "slots":     { "app_name": "我的編輯器" }
}
```

- `layout.tree`：節點種類以橋接 `KINDS` 為準（`gui_bridge.js:36`），再加待辦 3 新增的 `grid`、`tabs`、`split`、`scroll`、`menubar`、`menu`。
- `behavior.do` 指到**動作表**（`actions`）的名稱；動作是一小段 Python 函式範本（見 2.3），規格只引用名稱。
- `palette` 欄位名稱固定（上列五個必有，其餘可加），佈景 `theme` 是版面細節（字型、字級、圓角、密度），與配色分開（決定：使用者原話把配色與佈景主題並列）。
- `shortcuts.keys` 寫法固定為 `Ctrl+Shift+Alt+<鍵>`，鍵是單一字元或 `F1`–`F12`、`Enter`、`Esc`、`Space`、方向鍵名。
- `scenes` 給分鏡用（2.8）；`slots` 是範本裡可替換的文字。

### 2.3 範本檔格式（領域 → 步驟 → 選項）

位置：`renderer/src/guitpl/data/<領域>.json`，一個領域一個檔；使用者範本存在使用者資料區（2.9）。

```json
{
  "format": "guitpl-domain/1",
  "domain": "text-editor",
  "label": "文字編輯器",
  "keywords": ["文字編輯","筆記","記事本","editor","notepad"],
  "steps": [
    { "id": "layout", "ask": "版面要哪一種？",
      "options": [ { "id":"menu-top", "label":"上方選單＋大編輯區＋狀態列",
                     "keywords":["傳統","選單"], "default":true,
                     "fragment": { "layout": { … 規格的 layout 區塊 … } },
                     "needs": ["menubar","scroll"] } ] },
    { "id": "behavior", … }, { "id": "palette", … }, { "id": "theme", … },
    { "id": "shortcuts", … }, { "id": "sound", "optional": true, … }
  ],
  "actions": { "save_file": { "params": [], "python": "def save_file(ctx):\n    …" } },
  "examples": [ "scripts/eval/gui_examples/text_editor.py" ]
}
```

- **組合規則**：每步選一個選項，把各選項的 `fragment` 依步驟順序合併進規格；同一個欄位後來的覆蓋先來的，但 `layout.tree` 與 `behavior.handlers` 是**附加**（串接）；`needs` 若是 Python 端還沒有的能力，組合器在驗收階段報「缺能力」而不是產出壞程式。
- **共用步驟選項**：配色、佈景、快捷鍵常用組合放 `data/_common.json`（例如 `palette: dark | light | high-contrast | warm`、`theme: compact | comfy`、`shortcuts: office | editor | game-wasd`），各領域用 `use: "_common:palette"` 引用，不重複寫（決定：十三個領域共用，減少維護）。
- **整套範本**：領域檔的 `presets` 可列「一次選好所有步驟」的套餐，使用者說「給我一個簡單的記事本」就直接套用，不逐步問。

### 2.4 檢索

純函式、確定性、不靠模型（離線也一樣）：

1. 領域分數：需求文字與各領域 `keywords` 的命中數（含中文詞與英文詞）；最高分且領先第二名一個門檻才算決定，否則走 2.5 問使用者。
2. 步驟內選項分數：需求文字與 `keywords`、`label` 的命中；平手取 `default`。
3. 使用者範本（`source:"user"`）**加權優先**，且完整規格案例會被列為「參考案例」附給 AI（2.6），不只是被套用。
4. 回傳 `{domain, preset?, picks:{步驟:選項}, confidence, reasons[]}`，供決策記錄使用。

### 2.5 逐步詢問流程

**共同骨架**：程式持有狀態（目前領域、已選步驟、未決步驟）；每一輪只問一個步驟；有 `default` 的步驟，信心夠就自動選並在結尾列出「我替你選了這些，想改再說」。

- **線上 AI**：宿主工具 `gui_template_find`（找領域與選項）、`gui_template_compose`（規格→程式）；系統提示加一段短指引：「寫圖形介面程式前先呼叫 `gui_template_find`；有範本就逐步確認；沒有就自行設計並走 2.6」。線上可直接用自然語言問使用者，使用者答一句話就視為選定。
- **離線 AI**：用食譜＋字母選擇題（`FaRecipe` 的編號選單）：每步產生 A、B、C… 的封閉題，模型只回一個字母；程式驗證字母合法、不合法退回、兩次退回後用預設。使用者若直接說了偏好（例如「深色」），程式先用檢索套用，不問模型（決定：能用程式決定就不問）。
- **跳過規則**：需求文字已包含該步驟的明確關鍵字就不問；使用者說「你決定」就全部走預設。

### 2.6 找不到範本時的自行設計

觸發：領域分數過低，或使用者要求的某一步沒有任何選項命中。

- 沿用 UML design 的逐層切割（`renderer/src/uml/design_core.js`）：需求 → 畫面（場景）→ 每個畫面的區塊 → 每個區塊的控件；切到的最小單位正好對應規格的節點樹與動作表。
- **只生成規格，不直接生成 Python**：模型（或離線的引導寫作）填同一份規格 JSON 的缺漏欄位，再交給同一個組合器。好處：驗收、分鏡、工作室對「自行設計」與「範本」完全一樣。
- **參考案例**：把檢索到的最相近的 1–3 份規格（含使用者範本）放進提示，離線版放進引導寫作的案例區；標明「僅供參考，依本次需求改」。
- 產生的規格 `source:"designed"`；使用者在工作室確認後才有資格存成範本（2.9）。

### 2.7 組合器與驗收

組合器 `renderer/src/guitpl/compose_core.js`（待辦 3）：規格＋動作表 → 一支完整 Python 程式，結構固定：`import gui` → 主題與配色呼叫 → 建節點樹 → 登記快捷鍵與選單 → 動作函式 → 事件迴圈（`wait` 或 `poll` 畫面）。

驗收三關，任一關不過不交付、不存範本：
1. `python -m py_compile` 同等的語法檢查（桌面版原生、網頁版用 Pyodide）。
2. 協定檢查：把節點樹丟給 `gui_bridge.js` 的驗證（種類、屬性、上限），不過就列出哪個節點。
3. 假橋接空跑：用測試用的假橋接（`gui_py_test.py` 的作法）跑一輪「建樹→送幾個事件→關閉」，確認動作表引用都存在、沒有未捕捉的例外。

### 2.8 分鏡（storyboard）

- 資料：`scenes[]`，每個場景 = 標題、說明、進入條件（狀態值）、節點樹快照（取規格的某個狀態）、可觸發的動作與去向場景。
- 產生：組合器從規格＋各場景狀態確定性展開（不跑 Python）；範本自帶 `scenes`，自行設計的由模型補場景清單。
- 輸出：一個 HTML 檔，一個場景一張卡，卡內用與 `gui_render.js` 相同的畫法畫出節點樹的靜態樣子（畫面層本來就能在一般頁面渲染，決定：不另寫第二套繪圖），卡之間用箭頭標動作；同時給純文字版（給離線 AI 與終端機）。
- 位置：成品旁邊的 `<名稱>.storyboard.html`，並可在對話裡以產出檔案的方式提供。

### 2.9 設計工作室與使用者範本

- **工作室**：一個 `gui.Window` 程式（吃自己的狗食）加桌面版專用的完整版：左邊場景清單與節點樹，中間即時預覽，右邊屬性（文字、配色、佈景、快捷鍵、聲音）。微調的對象是規格；每次改動重新驗收（2.7），預覽用同一組合器。
- **存成範本**：按「存成我的範本」→ 輸入名稱與關鍵字 → 驗收通過 → 寫入使用者範本庫。桌面版寫在使用者資料區的 `guitpl-user/*.json`（一範本一檔，可備份、可手改）；網頁版寫在 `persistentStorage` 的 `fa_guitpl_user`（已有的網頁端存放機制）。
- **回流**：使用者範本進 2.4 的檢索（加權優先）與 2.6 的參考案例；可匯出匯入（單檔 JSON）。
- **隱私**：範本只存在本機；不上傳、不寫進對外請求。

### 2.10 十三個領域的切法（待辦 4 的清單）

辦公、文件、遊戲設計、專案設計、投影片軟體、進銷存、美顏拍貼、證件照、MIDI 設計、文字編輯器、網頁設計、影像處理、多媒體編碼解碼與播放。各領域檔至少有：一個版面套餐、動作表、兩種配色、一種佈景、一組快捷鍵、一支範例程式（`scripts/eval/gui_examples/<領域>.py`）。圖像與影音類領域在 Python 端受限於畫布一幀 200 道指令與圖片大小（`gui_bridge.js:30-35`），範本要誠實標「簡化版預覽」，列入待改善而不是假裝做完。

### 2.11 Python 端與橋接要補的能力（待辦 3 清單，依優先）

1. `w.set(nid, **props)`（改屬性）、checkbox／progress／list／textarea 的封裝。
2. `w.theme(...)`（配色與佈景：頁面端以 CSS 變數套用，橋接新增 `theme` 操作與白名單欄位）。
3. `w.shortcut(keys, name)`（視窗層級快捷鍵，事件 `shortcut`）與 `menubar`／`menu`（選單項可帶快捷鍵提示）。
4. 容器：`grid`、`tabs`、`split`、`scroll`。
5. 聲音：`w.tone(name_or_freq, ms)`（頁面端網頁音訊合成短音效；桌面版可再接原生）；pygame 相容層補最小的 `mixer.Sound` 轉呼叫。
6. 對話框：`w.message(text)`、`w.confirm(text)`、`w.pick_file()`（走既有 zenity 路徑）。

每項補上都要有橋接測試、畫面測試與 Python 測試，且不改動既有協定的行為（舊程式照跑）。

### 2.12 目錄與檔案（待辦 3 起建立）

```
renderer/src/guitpl/
  guitpl_core.js          規格校驗、檢索、逐步詢問狀態機（純函式、UMD）
  compose_core.js         規格→Python 組合器
  storyboard_core.js      分鏡展開與 HTML 產生
  user_store.js           使用者範本庫（桌面檔案／網頁 persistentStorage 兩種後端）
  studio_gui.py           設計工作室（gui.Window 程式）
  data/_common.json  data/<領域>.json
  *.test.js
```

接線：`scripts/embed-code-ui.js` 加嵌入區塊（改來源模組，不改嵌入後的那份）；宿主工具用 2.5 的兩個工具名登記，離線自動進工具目錄。

### 2.13 待確認但已自行決定的歧義

- 範本格式用 JSON、不用 YAML（理由見 2.2）。
- 設計工作室微調規格而不是微調程式文字；使用者若要改程式本身，走原本的編輯流程，改完不能回存成範本（規格與程式會分叉）。
- 聲音用網頁音訊合成短音效，不做音檔播放（先求有，音檔列待改善）。
- 找不到範本時模型填規格而不直接寫程式（驗收一致）。

## 3. 實作現況（2026-11-14，交接 1 結束時）

已實作並提交（都有測試，詳見各測試檔）：

| 項目 | 檔案 | 說明 |
|---|---|---|
| 範本核心 | `renderer/src/guitpl/guitpl_core.js` | 規格檢查、領域檔檢查、共用步驟展開、領域檢索、逐步詢問狀態機、合併、離線字母選擇題 |
| 組合器 | `renderer/src/guitpl/compose_core.js` | 規格＋動作表 → Python 程式；事件含輪詢與等待兩種迴圈；音效名對照表 |
| 假橋接空跑 | `renderer/src/guitpl/fake_run.py` | 驗收第三關：假橋接送事件、回報例外 |
| 一條龍 | `renderer/src/guitpl/guitpl_run.js` | 載入 `data/*.json`、需求→領域→逐步選擇→程式；預設組、指定領域、「你決定」 |
| 範本資料 | `renderer/src/guitpl/data/_common.json`、`text-editor.json` | 共用配色四種與佈景四種；文字編輯器是第一個領域（兩版面、兩行為、兩快捷鍵、兩音效） |
| 橋接新能力 | `gui_bridge.js`、`gui_render.js`、`gui_host.js`、`py_worker.js`、`pybridge/gui.py` | `theme`（配色、字型、字級、圓角）、`shortcut`（視窗快捷鍵＋事件）、`tone`（短音效）、`set()` 改屬性、textarea／checkbox／progress／listbox 封裝、`grid`／`scroll` 容器 |

與 2.11 清單的對照：第 1、2、5（短音效部分）項與第 4 項的 `grid`、`scroll` 已完成；**未完成**：`tabs`、`split`、`menubar`／`menu`、對話框（`message`／`confirm`／`pick_file`）、pygame 相容層的 `mixer`。

決定記錄（實作時自行決定）：
- 快捷鍵事件名稱就是動作名稱（`w.shortcut("Ctrl+S", "save_file")`），組合器自動把快捷鍵併入事件路由。
- 沒有 Ctrl 或 Alt 的單鍵快捷鍵，在使用者於文字框輸入時不觸發（避免吃掉打字）。
- `tone` 用頁面的音訊合成，頁面不能播放時靜默，不讓程式失敗。
- 事件迴圈：只有 click 與 shortcut 用 `wait`；有 input／change／select／toggle／cell／frame／key／mouse 就改用 `poll`（`wait` 只回傳按鈕、快捷鍵、關閉）。
- 組合器對不支援的節點種類或屬性直接報錯，不產生壞程式。

## 4. 成對檔案格式與框架（2026-11-14 取代 2.2、2.3 的單一 JSON）

使用者原話：「我希望最核心的元件跟描述都是一個jsonl對一個python，達到最高的範本化與客製化」「所有的設計都要可以在python emulator達成，所以連套件相依性都是描述在每個範本檔裡面」。

**理由**：JSONL 每行一筆紀錄，Python 逐行 `json.loads` 就能讀，不需要額外套件（模擬器裡不保證有 YAML 套件）；一行一筆讓「客製化＝加行或覆寫行」成立，使用者範本只寫幾行；同名的 `.py` 是元件的核心，版面、配色、分鏡都是交給它的資料。YAML 可以之後當撰寫格式、轉成 JSONL。

- 實作：`renderer/src/pybridge/guitpl.py`（載入、引用解析含循環偵測、覆寫、相依收集與檢查、執行、外部呼叫、場景）；檢查工具 `renderer/src/guitpl/lint.py`；測試 `renderer/src/guitpl/guitpl_test.py`；範例 `renderer/src/guitpl/lib/`（`common/toolbar_basic`、`demo/notes`、`demo/notes_dark`、外部呼叫範例 `demo/ext_export.py`）。格式說明在 `guitpl.py` 開頭的文件字串（紀錄種類：meta、param、style、layout、slot、scene、shortcut、call、require）。
- 一個元件 = `<名稱>.jsonl` ＋ 同名 `<名稱>.py`，代號是相對於範本根目錄的路徑（`office/toolbar_basic`）。進入函式 `build(win, spec, slots)` 回傳字典，`handlers` 欄位 `{"click:save": fn(ctx)}` 接事件；`slots` 是子元件的回傳值（由下往上建）。
- 相依：每個元件的 jsonl 都要用 `require` 宣告 `.py` 用到的每個模組（標準函式庫與 `gui` 也要）；`check` 抓「用了沒宣告」與「宣告了模擬器沒有」，錯誤是中文並寫明哪個範本缺哪個套件。
- 客製化：新元件的 meta 寫 `"extends"`，只寫要改的行（同 kind 同 key 的行取代；style 是合併）；超出範圍的行為用 `call` 紀錄參考任何 `.py` 的函式，找不到檔案、找不到函式、函式丟例外都只回報、不讓程式掛掉。
- 分鏡：`scene` 紀錄（`show`／`hide` 節點名稱、`on` 事件觸發切換），`guitpl.storyboard(comp)` 取出純資料。
- 執行：`guitpl.run(代號, params, roots)` 直接載入並執行（主路徑）；「編譯成單一 Python 檔」尚未做。
- 驗收：meta 標 `"standalone": true` 的元件（整個領域的範本）用 `lint.py` 以假橋接真的執行，每個按鈕、輸入、快捷鍵、場景都走過。**只在桌面 Python 跑過不算完成；模擬器內的實際執行還需要真實桌面版驗證（待辦）。**
- 舊的單一 JSON 流程（`guitpl_core.js`、`compose_core.js`、`guitpl_run.js`、`data/*.json`）保留，檢索與逐步詢問（`findDomain`、`choiceMenu`）之後要改讀 jsonl 的 meta／param；`data/text-editor.json` 待轉成成對檔案。
