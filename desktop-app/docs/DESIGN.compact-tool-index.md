# 設計：工具與領域的多層壓縮索引、路由快取、描述式申請工具

日期：2026-11-27。對應交接：`HANDOFF.compact-modes-port.md`。紅米端參考：`redmine_ai_chat` 的 `compact_index.rb`、`additional_tool_index.rb`、`additional_tool_request.rb`（唯讀）。移植的是設計，不是程式碼。

## 1. 調查結論（我們這邊現況，已用程式驗證）

1. 根層級工具清單：`_getRootToolNames()`（floating-assistant.js 約 129335）。模式 `off` 全給、`intent`（意圖過濾）用 `FaToolBudget.rank` 挑最相關的 14 個，其餘「只列名稱」（`_intentRosterNote`）。其他模式只給不受領域限制的工具，領域工具靠 `delegate_to_subagent`。
2. `get_tool_details`（約 112010）：只查得到「目前清單裡真的有」的工具。沒有「從沒給過的工具」的出口。
3. `request_additional_tools`：**只存在於子代理執行內**（`_runSubAgentTask` 約 164300，偽工具，不寫進 `this.tools`）。它已經有自然語言參數 `need`，流程是：先本地 `_focusPick`（詞彙檢索、不呼叫模型），挑不到才走 `_routeTaskToDomains`（路由模型）。**根層級沒有這個工具**。
4. 路由子代理（`_routeTaskToDomains` 約 163825）：每次都重新用 `_buildDomainCatalogSection` 組目錄文字（領域 → 工具一行摘要），先用 `_shortlistDomains` 本地檢索縮成最多 8 個領域。它的詞彙索引快取 `_domIndexCache` 的鍵是「領域代號＋標籤長度＋工具數」：工具描述改了不會失效，重新載入頁面就沒了，也沒有持久化。
5. `FaToolBudget`（tool_budget_core.js）已有：`shortOf`（一行摘要）、`tokens／buildIndex／rank`（中文雙字＋英文詞，稀有度加權）、`compactSchema`。都是純函式，可重用。
6. 紅米端做法：每個工具一段「介紹文字」，以雜湊為鍵快取（摘要＋關鍵字），工具的介紹變了才重算那一個；索引文字一次送出；`request_additional_tool(prompt)` 先用詞彙＋同義詞選，有模型節點時用模型在整份索引上選，兩者都只回索引裡真的有的名字。

## 2. 要補的三件事

### 2.1 多層壓縮索引（純模組 `renderer/src/tools/compact_index.js`）

- 輸入目錄：`{ 領域鍵: { label, tools: { 工具名: 完整說明 } } }`（由 floating-assistant.js 從 `this.domains`＋`_getCombinedToolEntries` 組出，**台股專屬技能只在台股網頁帶進來時才在目錄裡，模組本身不寫任何站別字眼**）。
- 三層：
  - 第 0 層（領域層）：每個領域一行：`鍵（標籤）：N 個工具：前幾個工具名`。領域再多也只是一行一個。
  - 第 1 層（工具層）：`- 工具名: 一行摘要`，依領域分組。用 `FaToolBudget.shortOf` 同一套切法。
  - 第 2 層（完整層）：完整說明與參數，只透過 `get_tool_details`／申請載入才給。
- 預算：`build(catalog, { budgetChars })`，超過預算時自動降級——第 1 層改成只列領域層，並標 `overBudget`。預算由呼叫端依 `contextWindowTokens` 按比例換算（不寫死）。
- 核心工具（常駐、完整 schema）由呼叫端傳入，索引裡不重複列。

### 2.2 快取（只有工具變了才重算）

- 單位：每個工具一個「介紹文字」＝`名稱 [領域鍵 (標籤)]: 完整說明`。雜湊用同步的 53 位元雜湊（不依賴 `crypto`，網頁、桌面、Node 都能跑）。
- 快取內容：`{ version, entries: { 雜湊 → { summary, keywords } }, routerText: { setHash, text } }`。
- 單工具失效：說明或所屬領域變了→雜湊變→只重算那一個；沒變就重用。
- 集合失效：整個工具集的雜湊（所有工具雜湊排序後再雜湊）變了，才重組路由用的索引文字。工具變多、變少、改名都會觸發；不變時直接用快取文字（路由提示的前綴也因此穩定）。
- 不含任何使用者資料，只放工具介紹。壞掉或版本不符＝當空的重建，永遠不丟錯。
- 儲存是可注入的轉接器（`get()/set(jsonString)`）：
  - 桌面版：存在使用者資料目錄（沿用既有的偏好儲存；實作時先找現成的那個出口）。
  - 網頁版：`localStorage`，容量不夠或不可用時退回 `IndexedDB`，再不行退回記憶體（只在這次頁面有效）。
  - 純模組本身只認轉接器，所以 Node 測試用記憶體轉接器。

### 2.3 描述式申請（`request_additional_tools` 加 `description`）

- 參數：`names`（舊用法，精確名稱，照舊）、`description`（新，自然語言）。兩個都給時，名稱優先，描述補充。
- 比對流程（程式為主，遵守「弱模型只答封閉題」）：
  1. 程式比對：用索引的詞彙檢索（工具名、摘要、領域標籤、關鍵字，加手寫同義詞橋接）得到候選與分數。
  2. 有把握（最高分明顯領先且命中詞數夠）→ 直接載入，回覆列出載入了哪些。
  3. 沒把握 → 不悄悄猜：回候選清單，編成字母選擇題（A、B、C…），模型回一個字母再申請；候選為空就老實說沒有，不准宣稱工具存在。
  4. 有模型節點時，可選用「整份第 1 層索引＋描述」讓模型選（只認索引裡的名字）；實驗開關預設關，先把程式比對做好。
- 載入的意思：把該工具（及必要時它的領域）併入這一輪的工具清單，下一輪給完整 schema。上限沿用既有的追加次數上限。
- 逃生口：模型說「沒有這個工具」時，程式自動放寬（沿用 `_intentWiden` 的做法）。

## 3. 接進提示組裝（實驗開關）

- 開關：`advancedSettings.compactToolIndex`，**預設 false**。關閉時所有提示、工具清單、`get_tool_details`、子代理的 `request_additional_tools` 與今天逐位元組相同。
- 開啟時：
  - 根層級：用壓縮索引取代 intent 模式的「只列名稱」區塊與其他模式下非核心工具的說明；並在根層級註冊 `request_additional_tools`（含 `description`）。
  - 路由子代理：目錄文字改用快取的索引文字（取代每次重組）。`_shortlistDomains` 的快取鍵改為內容雜湊（開啟時才換，預設不動）。

## 4. 測試與量測

- 單元測試（Node，純模組）：雜湊穩定、單工具失效、集合失效、損壞快取退回、預算降級、描述比對的可達性（至少 40 題，含中英文）、字母選擇題確認流程。
- 回歸：預設關閉時提示與工具清單與 HEAD 一致（先從 HEAD 抓基準）。
- 量測：用 `FaToolBudget.estimateTokens` 量前後提示大小，如實報告，不調估算。

## 5. 順序

1. 本文件。 2. `compact_index.js`＋測試。 3. 接進提示（開關預設關）。 4. 根層級 `request_additional_tools`（`description`）。 5. 回歸基準與量測。
