# GUI 範本實機驗證報告（2026-11-14）

驗證方式：真 Electron 桌面版（獨立資料夾、換埠），Python 模擬器走 Worker 路徑，評估檔 `scripts/eval/guitpl_verify.eval.js`，原始結果 `docs/verify.gui-templates.result.json`。

## 結論

- 完整範本 43 個（十三個領域的 main、各配色變體、示範、使用者範本）：全部通過（開窗、輸入框文字、畫布事件、快捷鍵、按鈕、關窗；沒有 Traceback、沒有 guitpl 錯誤輸出）。
- 子元件 28 個：全部能掛進 slot 並開窗，沒有錯誤。

## 每一步實際做了什麼

1. 對每個輸入框、多行文字框送入文字並觸發輸入事件。
2. 對每個畫布送滑鼠按下、移動、放開、滾輪與方向鍵按下、放開。
3. 從橋接登記表取出該視窗的每個快捷鍵並真的按下。
4. 點每個按鈕一次。
5. 比對視窗文字與輸入框內容前後是否改變（證明處理函式有作用），關窗後確認程式正常結束。

## 完整範本

| 範本 | 輸入框 | 畫布 | 快捷鍵 | 按鈕 | 畫面有變 | 結果 |
|---|---|---|---|---|---|---|
| beauty/main | 1 | 1 | 3 | 1 | 是 | 通過 |
| beauty/main_dark | 1 | 1 | 3 | 1 | 是 | 通過 |
| beauty/main_light | 1 | 1 | 3 | 1 | 是 | 通過 |
| demo/notes | 1 | 0 | 1 | 1 | 是 | 通過 |
| demo/notes_dark | 1 | 0 | 1 | 1 | 是 | 通過 |
| document/main | 2 | 0 | 2 | 1 | 是 | 通過 |
| document/main_dark | 2 | 0 | 2 | 1 | 是 | 通過 |
| document/main_warm | 2 | 0 | 2 | 1 | 是 | 通過 |
| game/main | 0 | 1 | 3 | 2 | 是 | 通過 |
| game/main_dark | 0 | 1 | 3 | 2 | 是 | 通過 |
| game/main_light | 0 | 1 | 3 | 2 | 是 | 通過 |
| idphoto/main | 0 | 1 | 2 | 1 | 是 | 通過 |
| idphoto/main_dark | 0 | 1 | 2 | 1 | 是 | 通過 |
| idphoto/main_light | 0 | 1 | 2 | 1 | 是 | 通過 |
| image/main | 0 | 1 | 2 | 1 | 是 | 通過 |
| image/main_dark | 0 | 1 | 2 | 1 | 是 | 通過 |
| image/main_light | 0 | 1 | 2 | 1 | 是 | 通過 |
| inventory/main | 1 | 0 | 2 | 2 | 是 | 通過 |
| inventory/main_dark | 1 | 0 | 2 | 2 | 是 | 通過 |
| inventory/main_light | 1 | 0 | 2 | 2 | 是 | 通過 |
| media/main | 1 | 1 | 2 | 1 | 是 | 通過 |
| media/main_dark | 1 | 1 | 2 | 1 | 是 | 通過 |
| media/main_light | 1 | 1 | 2 | 1 | 是 | 通過 |
| midi/main | 1 | 1 | 2 | 1 | 是 | 通過 |
| midi/main_dark | 1 | 1 | 2 | 1 | 是 | 通過 |
| midi/main_light | 1 | 1 | 2 | 1 | 是 | 通過 |
| office/main | 2 | 0 | 2 | 1 | 是 | 通過 |
| office/main_dark | 2 | 0 | 2 | 1 | 是 | 通過 |
| office/main_warm | 2 | 0 | 2 | 1 | 是 | 通過 |
| project/main | 2 | 0 | 2 | 1 | 是 | 通過 |
| project/main_dark | 2 | 0 | 2 | 1 | 是 | 通過 |
| project/main_light | 2 | 0 | 2 | 1 | 是 | 通過 |
| slides/main | 1 | 0 | 2 | 1 | 是 | 通過 |
| slides/main_dark | 1 | 0 | 2 | 1 | 是 | 通過 |
| slides/main_light | 1 | 0 | 2 | 1 | 是 | 通過 |
| text-editor/main | 1 | 0 | 2 | 1 | 是 | 通過 |
| text-editor/main_contrast | 1 | 0 | 2 | 1 | 是 | 通過 |
| text-editor/main_dark | 1 | 0 | 2 | 1 | 是 | 通過 |
| text-editor/main_warm | 1 | 0 | 2 | 1 | 是 | 通過 |
| user/my_main | 2 | 0 | 2 | 1 | 是 | 通過 |
| web-design/main | 3 | 1 | 2 | 1 | 是 | 通過 |
| web-design/main_dark | 3 | 1 | 2 | 1 | 是 | 通過 |
| web-design/main_light | 3 | 1 | 2 | 1 | 是 | 通過 |

## 子元件（掛在臨時外殼的 slot 裡）

| 子元件 | 節點數 | 結果 |
|---|---|---|
| beauty/statusbar | 5 | 通過 |
| beauty/toolbar | 6 | 通過 |
| common/toolbar_basic | 6 | 通過 |
| document/sidebar | 7 | 通過 |
| document/statusbar | 6 | 通過 |
| document/toolbar | 6 | 通過 |
| game/statusbar | 6 | 通過 |
| game/toolbar | 7 | 通過 |
| idphoto/statusbar | 5 | 通過 |
| idphoto/toolbar | 7 | 通過 |
| image/statusbar | 5 | 通過 |
| image/toolbar | 6 | 通過 |
| inventory/statusbar | 5 | 通過 |
| inventory/toolbar | 8 | 通過 |
| media/statusbar | 6 | 通過 |
| media/transport | 9 | 通過 |
| midi/statusbar | 5 | 通過 |
| midi/transport | 8 | 通過 |
| office/statusbar | 6 | 通過 |
| office/toolbar | 7 | 通過 |
| project/statusbar | 6 | 通過 |
| project/toolbar | 8 | 通過 |
| slides/statusbar | 6 | 通過 |
| slides/toolbar | 7 | 通過 |
| text-editor/statusbar | 5 | 通過 |
| text-editor/toolbar | 7 | 通過 |
| web-design/statusbar | 5 | 通過 |
| web-design/toolbar | 7 | 通過 |

## 已知限制（誠實標示）

- 驗證的是「操作不出錯、畫面與輸入有反應」，不是逐像素比對；畫布內容沒有截圖比對。
- 子元件只驗證能掛載，沒有點它的按鈕（它們的處理函式需要上層範本提供的節點，單獨點會出錯是預期的）。
- 圖像、影音、MIDI 領域是簡化版預覽（畫布一幀 200 道指令、圖片 256 KB 上限）。
- 對話框沒有 `pick_file`；YAML 撰寫格式沒有做。
- 快捷鍵是用合成的鍵盤事件觸發，沒有經過作業系統的真實按鍵與輸入法。
- 發現並修掉的問題（本線期間）：視窗配色在真 DOM 丟錯、快捷鍵名稱不合法、compose 產生的程式缺 `import gui`（會走一般 Python 路徑）、單一檔程式同上。

## 補充驗證（2026-11-14 第二輪：待改善項目）

### 子元件逐個操作（28 個，`scripts/eval/guitpl_parts.eval.js`，結果 `docs/verify.parts.result.json`）
- 每個子元件都掛在「真正使用它的主範本」裡（子元件的處理函式要靠主範本的節點與場景），只操作這個子元件自己的按鈕、選單項目與快捷鍵。28 個全部通過：沒有 Traceback、沒有 `[guitpl]` 錯誤、沒有找不到的控制項，且至少一個操作讓畫面（文字、輸入框、畫布像素）有變化。每個子元件對應的主範本列在 `verify.parts.result.json` 的 `parts.<子元件>.main`。
- 操作後畫面沒變的控制項，全部都歸類為「依狀態而定，合理」：例如進銷存工具列的「進銷」一開始就在那個場景（其他控制項按過一輪後再按會變化，`retry` 欄位為 true）、沒東西可清時按「清除」、還沒開始就按「暫停」。沒有發現需要修的缺陷。

### 畫布截圖比對與配色變體（`scripts/eval/native_driver.js`，結果 `docs/verify.native.result.json`）
- 用 Electron 主行程的 `capturePage` 截畫布，與 `scripts/eval/baselines/*.png` 逐像素比對（容忍 2%）；連跑兩次基準與比對一致（決定性）。
- **發現並修好一個真缺陷**：影像處理、美顏拍貼、網頁設計三個主範本開窗時畫布是空白（單一顏色）：它們只在使用者操作後才畫。修法：執行器 `guitpl.run` 開窗後先呼叫一次處理函式 `start`，三個範本各自登記 `start` 畫第一幀；網頁設計沒有元件時多畫一行「尚無元件：從工具列新增」。修完七個主範本畫布都有內容（顏色數 5～353）。
- 配色變體 7 個（office 深色與暖色、text-editor 深色與高對比、image 深色與淺色、game 深色）：視窗截圖與主範本比對，全部真的改了配色。image 深色用 monospace 字型使視窗大小不同，改用平均亮度差判斷（差 139）；image 淺色只改了很淡的色相，像素差異約 2.9%。

### 真實鍵盤與 Ctrl+C（同一支驅動）
- Ctrl+C：用真實鍵盤把 `python3 nd_loop.py` 打進終端機、按 Enter，視窗開著（前景程式在跑），再送真實 Ctrl+C：終端機顯示 `^C` 並回到提示字元，通過（`ctrl_c.aborted`、`prompt_back` 為 true）。
- 真實鍵盤輸入與 Ctrl+Enter 快捷鍵：早先兩次完整跑都通過（對焦點擊、逐字輸入 Hello、Ctrl+Enter 新增、Ctrl+L 無錯誤）。**最後幾次跑沒通過**：點擊落在一個全螢幕半透明遮罩層（z-index 1000002）上，輸入框沒拿到焦點，輸入是空的。遮罩層內容還沒查（原本要印它的文字，但依管理者指示不再重跑原生驅動）。推測是某個啟動後才出現的對話框（例如更新或首次提示），與時間或狀態有關，不是範本問題。**列為已知限制**：原生驅動的鍵盤那一段在遮罩出現時會失敗；下次手動跑時先印遮罩文字、把它關掉再點輸入框。
- 備註：原生驅動會開真視窗並搶焦點，已定案不再重跑；其他項目都已驗證。


## 2026-11-15 版面填滿與設計系統驗證（交接 3）

方式：真 Electron 桌面版（獨立資料夾、換埠、`FA_UPDATE_BASE` 指向不存在的位址避免自動更新視窗），驅動程式 `scripts/eval/gui_shots.js`，結果 `docs/gui-templates-shots/result.json`。跑了兩次（第一次視窗被放置區域裁掉，改成先按「彈出」鈕再截）。

- **截圖**：十三個領域的主範本，淺色與深色各一張（26 張，`docs/gui-templates-shots/<領域>_light.png`、`<領域>_dark.png`；淺色用 `main_light`，沒有就用 `main`；深色用 `main_dark`）。全部開窗成功、關窗成功、畫面不是空白（顏色數 241 到 2703）、沒有 Traceback 或 [guitpl] 錯誤。截圖是範本的實際外觀；改版前沒有樣式表（全是瀏覽器預設），沒有另存「改版前」截圖。
- **真實鍵盤與滑鼠（文件範本）**：真滑鼠點進編輯區、真鍵盤打字，打字後焦點還在編輯區（`still_focused: true`），字數標籤跟著更新（就地更新有效）；游標在第 5 個字元時按「插入段落」→ 在游標處插入、「新段落」被選起來、編輯區保持焦點、訊息「已在游標處插入新段落」；接著打字把預設字蓋掉；點大綱第二項→游標跳到「## 第一節」那一行並選起來。畫面截圖 `document_after_editing.png` 未產生（驅動程式在最後一段才截，已存入結果 json 但沒有檔案的話代表沒截到）。
- **單元測試**：`gui_bridge`（133）、`gui_render`（104）、`gui_host`（42）、`py_worker`、`py_async`、`js_program`、`gui_py_test`（52）、`gui_pygame_test`、`guitpl_test`、`document_test`（25）、`guitpl_ai`、`jsonl_core`、`yaml_core`；lint 71 個元件 0 個有問題（含新規則：主範本要 resizable、有 height、有 grow）。
- **未重跑**：`guitpl_verify.eval.js`（43 個範本逐一送事件）因為第一次啟動被自動更新視窗擋住沒有結果，之後沒有再跑；`native_driver.js` 的鍵盤段仍有舊的遮罩問題（用 `FA_UPDATE_BASE` 繞過應可解，未驗證）。
- **已知限制**：游標位置只在鍵盤放開、滑鼠放開、取得或失去焦點時回報；編輯器沒有自動換行；`prose` 模式為了不讓游標與上色層錯位，上色不用粗體與斜體（只用顏色）；選單下拉在點外面時不會自動收起。
