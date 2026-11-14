# 圖形介面程式設計範本（GUI 範本線）

> 日期：2026-11-14。使用者原話見 `docs/HANDOFF.gui-templates.md` 第 5 節。
> 狀態：第 1 節（現況）已完成；第 2 節起（設計）尚未寫。行號是 2026-11-14 在分支 `desktop-app` 讀到的，`floating-assistant.js` 很大且常改，行號只當入口，請用字串再搜。

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

（待寫：範本資料格式、逐步詢問、找不到範本的自行設計路徑、分鏡格式、設計工作室與使用者範本回流。）
