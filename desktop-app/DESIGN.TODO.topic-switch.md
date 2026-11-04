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

## 步驟 3 待確認

- Configure → LLM 基礎設定面板的位置：尚未核對（之前記錄約 57589、79087、100399 行，需以 Grep `LLM基礎設定` 重新確認）。
- 另一份獨立維護的 AI 設定 UI（`index.html` 的 AI 助理設定分頁）是否有「LLM 基礎設定」：尚未查。

## 步驟 4 待確認

- `executeChat` 中 `_checkTopicTransition` 呼叫處（約 102549 行，需以 Grep 重新確認）。
- `_checkTopicTransition` 定義處（約 95871 行，需以 Grep 重新確認）。

## 量測結果

（步驟 4 完成後填入：`scripts/eval/send_latency.eval.js` 修前與修後的模型呼叫序列）

## 教訓

（若走歪，在此新增一條：錯在哪、下次怎麼做）
