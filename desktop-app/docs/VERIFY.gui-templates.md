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
