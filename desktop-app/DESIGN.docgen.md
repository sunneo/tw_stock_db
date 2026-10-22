# 文件撰寫器（/user-guide、/design-guide）

為專案寫設計文件與使用手冊。桌面版與網頁版共用同一份 renderer 程式，沒有任何 Electron 專屬功能。

## 組成

| 檔案 | 角色 |
| --- | --- |
| `renderer/src/docgen/docgen_core.js`（`FaDocgen`） | 純函式：指令參數、掃描、事實（透鏡）、架構比對、範本、組文件、驗證、潤飾驗收 |
| `renderer/src/docgen/docgen_render.js`（`FaDocRender`） | 純函式：文件模型 → md／mediawiki／html／pdfmake 定義／docx 各部件 |
| `floating-assistant.js`（`_docgen*`） | 讀來源、叫線上模型潤飾、輸出檔案卡片、⚙ 設定視窗、指令與工具 |

測試：`node scripts/docgen-tests/docgen.test.js`。

## 流程（計畫四步）

1. 蒐集來源：`fap:` 資料夾（網頁版用已授權資料夾，桌面版也可以是絕對路徑）、📎 上傳檔（zip 會展開）、`wiki:` 網址。
2. 取事實：逐行規則＋整檔規則，每筆都帶 `path:line`。透鏡：建置、進入點、命令列、設定、路由／介面、資料模型、硬體存取、重點項目（RTOS 任務、IPC 頻道、子命令…）、相依套件。第三方與測試檔不算。
3. 比對架構、選範本、組文件：加權訊號（只看原始碼與專案設定檔），顯示分數上限 100、排序用原始分數；專用範本要 ≥28 分且贏過通用（20）。使用者自訂範本優先於同架構的內建範本。
4. 驗證並輸出：每個引用的檔案都要存在、章節標題不重複；通過才輸出。

## 原則

- 找不到的東西不編：沒有素材的章節不出現，列進「待確認與風險」。
- 過程記錄是程式寫的陳述句（掃了幾個檔案、找到什麼、為何選這個範本），顯示在進度卡片的記錄裡；`analysis` 選項才多附「分析附錄」。
- 線上模型只做說明段落的潤飾，每段都驗收（識別字、路徑、數字、網址不能被動到，不能多標題或清單，長度 0.5–1.8 倍）；沒通過就用程式寫的原文；連續失敗兩次就停止。`noai` 或設定關閉＝全程不呼叫模型。
- 判斷線上可不可用沿用 `_kiLlm` 的耐心規則（見記憶 online-offline-judgement），這裡不允許離線小模型改寫。

## 範本

內建：設計文件 11 種（通用、openbmc、rtos、bios、kernel-driver、web-service、cgi、system-service、gui、distributed、plugin-cli）、使用手冊 8 種（通用、bmc、gui、service、cli、web-api、driver、plugin-cli）。自訂範本存在 `advancedSettings.docgen.templates`，章節可用代號或「自訂:標題|內文」。範本畫面在 ⚙ 設定視窗（領域設定的慣例，見記憶 domain-configure-button）。

## 入口

- 指令：`/user-guide`、`/design-guide`（`fap:`、`wiki:`、`format:`、`template:`、`lang:`、`level:`、`analysis`、`noai`、`version:`）。
- 工具：`docgen_user_guide`、`docgen_design_guide`、`docgen_list_templates`；領域 `docgen`。不做 wiki-to-pdf 工具。

## 還沒做

- 使用手冊與設計文件一律不碰Knowledge Inventory，也沒有相關選項（使用者指示）。
- 透鏡共 12 種（建置、進入點、命令列、設定、路由、通訊協定、資料、硬體、效能與並行、覆寫與客製、重點項目、相依套件）；通訊協定、效能、覆寫三種只記「第一個證據＋幾個檔案提到」，不逐行列。
- 圖只有頂層目錄的 Mermaid（箭頭關係需人工補）。
- PDF／DOCX 的圖以原始碼文字呈現，沒有轉成圖片。
- 真實專案（OpenBMC、RTOS）只用合成範例驗證過，沒有用真的大型專案實測。
