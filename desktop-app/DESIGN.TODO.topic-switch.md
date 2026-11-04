# 話題更動檢查開關（topicShiftCheck）

日期：2026-11-04　分支：desktop-app　負責：子工作階段（Haiku）

## 背景

使用者原話：「我在評估我們還有沒有需要檢測'話題更動' 來避免執著 可以把檢查的功能做成configure的LLM基礎設定，預設不檢查話題更動，因為目前架構還不錯，且長期的對話應該也會隨著拉遠而不再執著」「這個每一句對話都要等一下很不好」。

現況：`executeChat` 裡 `await this._checkTopicTransition(userText)`，訊息數 ≥ 3 後每則都會阻塞呼叫一次模型；判成話題轉移時再多一次摘要呼叫。目前沒有任何開關。

## 目標

- 新增設定 `advancedSettings.topicShiftCheck`，布林，**預設 false**。
- 關閉時：`executeChat` 完全不呼叫 `_checkTopicTransition`，不產生話題摘要，也不把舊訊息換成摘要。
- 開啟時：行為與現在完全相同。

## 步驟 1 — 行號盤點（已用 Grep / Read 驗證，2026-11-04）

來源檔：`renderer/src/floating-assistant.js`（只改來源，不改嵌入複本）

| 行號 | 內容 | 本功能要做的事 |
|---|---|---|
| 57009 | `this.advancedSettings = this._loadAdvancedSettings();`（建構子載入） | 不用改 |
| 57695 | 預設值區塊，`image3dMaxFaces: 60000,` 所在行 | **加 `topicShiftCheck: false,`** |
| 59003 | `_normalizeAdvancedSettings(raw)` 開頭 | 不用改 |
| 59125 | normalize 內 `image3dMaxFaces: (() => …)()` | **加 `topicShiftCheck: raw.topicShiftCheck === true,`** |
| 59320 | `_loadAdvancedSettings` 讀 localStorage 後呼叫 normalize | 不用改（經過 normalize 即得 false） |
| 59328 | 讀取後再 normalize 一次 | 不用改 |
| 59330 | `_saveAdvancedSettings` 寫 localStorage | 不用改（整個物件序列化，欄位自動保存） |
| 82114 | 匯出：`advancedSettings: JSON.parse(JSON.stringify(this.advancedSettings))` | 不用改（整包複製，欄位自動帶出） |
| 82237–82238 | 匯入：`this._normalizeAdvancedSettings(config.advancedSettings)` | 不用改（經過 normalize 即得 false 或保留的 true） |
| 66612 | 離線判斷 `FaVlm.shouldUseOfflineLlm(d, this.advancedSettings)` | 無關，不動 |

`image3dMaxFaces` 另外出現在 `renderer/src/edit/edit3d_host.js:211–220`、`:327` 與 `floating-assistant.js:37667–37783`，那些是圖片轉 3D 的面數 UI，與本功能無關，不動。

## 步驟 3 — 核取方塊（已完成，2026-11-04）

- 面板代號：`llm-basic`（「LLM 基礎設定」，約 81596 行的標籤對照；`data-pane="llm-basic"` 在 105475 行）。使用者說的 Configure 即此對話框（`_openAdvancedModal` 在 80980 行）。
- 新增核取方塊 `#ai-topic-shift-chk`：105488 行起的 HTML（checkbox＋標籤＋說明）；同步在 `_renderAdvancedSettings` 的 81672–81673 行；點擊寫入事件在 108407 行起（呼叫 `_saveAdvancedSettings`）。
- 另一份 UI 查證：`renderer/index.html` 只有 CSS 覆蓋（`.ai-advanced-*`），沒有「LLM 基礎設定」或任何 `ai-*-chk` 控制項，對話框 DOM 來自 `floating-assistant.js`。因此沒有第二份需要改的面板。
- 評估：`scripts/eval/topic_shift_ui.eval.js`（真 Electron）通過：控制項存在、標籤正確、預設未勾、點擊後設定值 true、再點回 false。
- 注意：`renderer/floating-assistant.js` 必須重建（`node scripts/embed-code-ui.js && node build-assistant.js`）後評估才看得到新控制項。

## 步驟 4 待確認

- `executeChat` 中 `_checkTopicTransition` 呼叫處（約 102549 行，需以 Grep 重新確認）。
- `_checkTopicTransition` 定義處（約 95871 行，需以 Grep 重新確認）。

## 步驟 4 — executeChat 加條件（已完成，2026-11-04）

- 改動：`renderer/src/floating-assistant.js` 約 102553 行，`executeChat` 的 `_checkTopicTransition` 呼叫改為 `if (this.advancedSettings.topicShiftCheck === true) await this._checkTopicTransition(userText);`，`stopRequested` 檢查保留。
- `_checkTopicTransition` 是唯一呼叫處（Grep 驗證）。`topicData.currentTopic` 只在它內部讀寫，其餘只有重設（約 79551、106615 行），關閉時沒有殘留依賴。
- 評估檔：`scripts/eval/send_latency.eval.js` 改成兩組（先 `_clearChatHistory()` 再送同樣三則），`off`＝預設、`on`＝開啟。

### 量測（真桌面版，2026-11-04）

| 則 | 修前（舊程式，無論設定都判斷） | 修後 off（預設） | 修後 on（開啟） |
|---|---|---|---|
| 1 畫貓 | 步驟有跑但無模型呼叫（訊息數不足 3 就提早 return）→ 主模型 | 主模型 | 步驟有跑但無模型呼叫 → 主模型 |
| 2 創作音樂 | 判斷 → 摘要 → 主模型 | 主模型 | 判斷 → 摘要 → 主模型 |
| 3 再畫狗 | 判斷 → 主模型 | 主模型 | 判斷 → 主模型 |

- 修前第 1 則：`_checkTopicTransition` 有出現在步驟列，但模型呼叫只有主模型（訊息數不足 3 會提早 return）。
- 修後 off：三則都沒有 `_checkTopicTransition` 步驟，模型呼叫只有主模型。第 2 則沒有判斷與摘要。
- 修後 on：與修前第 2、3 則完全相同（判斷 → 摘要 → 主模型；判斷 → 主模型），證明開啟時行為不變。
- 第 2 則修前耗時約 29.9 ms、修後 off 約 11.9 ms（同一機器單次量測，僅供參考，不是統計結論）。

## 驗證總結

- 步驟 2：`scripts/eval/topic_shift_setting.eval.js` 真桌面版全部通過（預設 false、舊設定 false、只接受布林、匯出匯入保留 true）。
- 步驟 3：`scripts/eval/topic_shift_ui.eval.js` 真桌面版全部通過（核取方塊存在、預設未勾、點擊改設定值）。
- 步驟 4：`scripts/eval/send_latency.eval.js` 真桌面版，見上表。
- 每次評估都在全新暫存資料夾、換埠（17941–17944）執行；每次都先重建嵌入檔才評估。
- 評估載入的是工作目錄的實作：修後 off 組沒有判斷步驟，修前有，這個差異只可能來自本次改動。

## 教訓

（若走歪，在此新增一條：錯在哪、下次怎麼做）
