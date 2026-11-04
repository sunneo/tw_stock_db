# 子對話 S4b：補完 S4 的缺口（進行中）

依據：`DESIGN.TODO.subchat-s4.md`（已知缺口 1～5）、`DESIGN.TODO.chat-subsessions.md` 第 10 節。
範圍：只做 S4b。不做 S5（拉回舊話題、`@` 輸入）、S6（遠端統一）、S7（批次刪除）。
位置說明：以下行號都是源頭 `renderer/src/floating-assistant.js`（已排版，行號有效）。建置產物 `renderer/floating-assistant.js` 是長行，不用行號。

## 步驟 1：子對話工具清單與父對話不同的根因（只調查，未改程式）

### 結論（靜態證據，步驟 2 會用評估實測）

`ask_user_card` 在父對話的根層級清單裡就**不存在**（預設模式 `full` 下）。子對話的清單與父對話一樣缺它，這不是子對話獨有的分歧。根因是它被歸類成「domain-gated」（需要透過領域委派才拿得到的工具），而不是根層級工具。

所以 S4 的「已知缺口 5」寫的「子對話送出的清單不含 ask_user_card」是事實，但不是子對話的錯，而是**父對話也沒有**。管理層要的「子對話與父對話一致」在這個根因下會是一致的，但子對話要問父對話使用者的能力，也因此沒有了。

### 程式依據

1. 預設模式：`multiSubAgentMode: 'full'`（`floating-assistant.js` 57646）。
2. 根層級清單：`_getRootToolNames()`（74749–74761）
   - `mode === 'off'` 才會列出全部內建工具。
   - 其他模式：`rootBuiltins = Object.keys(this.tools).filter(n => !this._domainGatedToolNames.has(n))`（74756）。domain-gated 的工具不進根層級。
   - 再加上 `_rootTaskHints()` 的專用工具（74758），以及 `intent` 模式的過濾（74759）。
3. 分類來源：`_domainGatedToolNames` 由 `registerOptional()` 填入（59429–59432）。`_registerBuiltinAiTools` 註解（59407–59428）寫明：「這批通用內建工具（共 23 個）用 registerOptional 註冊，讓 `_getRootToolNames()` 知道哪些工具要從根層級排除」。
4. `ask_user_card` 用 `registerOptional` 註冊：61073–61084。也就是說它屬於 gated 集合。
5. 專用工具提示（`FA_TASK_TOOL_HINTS`，47191 起）**沒有** `ask_user_card`（用 `grep` 全檔搜尋確認，只出現在 1041、14751、25205、61073、96064 行，其中 25205 是階段 `ph_design` 的工具列表，不是提示）。所以使用者說什麼都不會把它補進根層級。
6. 階段 `ph_design`（25205）與領域 `design` 的工具清單有它，所以只有委派到設計領域的子 agent 才拿得到。

### 子對話與父對話送出清單的路徑是同一條

- 送出的 `tools` 都是 `this._buildNativeToolsSchema(this._getRootToolNames())`（`_loopFetchNative` 的 103546；另一處 102222 是 benchmark，同一邏輯）。
- 子對話與父對話用同一個 `_getRootToolNames()`。差異只能來自「狀態」：
  - `_currentTurnUserText`、`messages`：在 `FA_CHAT_CTX_KEYS`（51017–51027），每個對話各一份。
  - `_intentPlanCache`、`_intentRecent`、`_intentExtra`、`_intentWiden`、`_intentMiss`、`_intentHidden`：**不在** `FA_CHAT_CTX_KEYS`，只在 `intent` 模式下有作用（75609 `_intentOn()`）。預設 `full` 模式下不生效。
- `_focusTools`（77765）只在領域子 agent 執行（104051），不在對話送出的路徑上，**不是**原因。
- `_domainGatedToolNames` 是 app 實例上的 Set，子對話與父對話讀到的一樣。

### 排除的其他可能（照實寫）

- 工具預算／聚焦（`FaToolBudget`、`_focusTools`）：只在領域子 agent 路徑，不影響對話請求。排除。
- 意圖過濾（`intent`）：預設不是 `intent` 模式，不是原因；但若使用者切到 `intent`，`ask_user_card` 會變成「根層級候選」，會不會留下要看它的詞彙分數（75619），步驟 2 不處理這個模式，只在文件註明。
- 新對話沒登記某些工具：不是。子對話與父對話用同一個 `this.tools`。
- ctx 沒帶設定：不是。`multiSubAgentMode` 是 app 層設定，不是 ctx 欄位。

### 還沒確定的（步驟 2 用評估確認）

- 「父對話在 `full` 模式下送出的清單真的不含 `ask_user_card`」是靜態推論，還沒實測。步驟 2 的評估會先跑修前版本，同一句話在父對話與子對話各抓一次 `tools`。
- `_domainGatedToolNames` 收錄的確切數目（註解寫 23 個，現在可能更多）：未查，不影響結論。

## 修正方向（給步驟 2，管理層決定：自己決定並寫理由）

選項比較：

- A. 在子對話的 ctx 上額外加入 `ask_user_card`（只改子對話）：會讓子對話與父對話不一致，違反管理層決定 (1)。不採用。
- B. 把 `ask_user_card` 從 gated 移到根層級（改成一般 `register_openai_tool`，不經 `registerOptional`）：父對話與子對話都會有它，符合「工具能力一致」。代價：根層級多一個工具的 schema 大約幾百 token。**採用此方案**。理由：`ask_user_card` 是對話層級的互動能力（問使用者），不是某個領域的專用工具，放在 gated 集合是分類錯誤。
- C. 只在 `ask_user_card` 加到提示表（`FA_TASK_TOOL_HINTS`）：靠關鍵字，不可靠。不採用。

## 步驟 2：修根因，工具清單一致（已驗證）

### 改了什麼（源頭 `renderer/src/floating-assistant.js`）

- `_registerBuiltinAiTools` 裡 `ask_user_card` 從 `registerOptional(...)` 改成 `this.register_openai_tool(...)`（約 61073 行，附註解）。它不再屬於 `_domainGatedToolNames`，所以 `_getRootToolNames()` 在 `full`／`router` 模式下會列出它。說明、參數、回傳格式都沒改。
- 選了方案 B（見上面「修正方向」）：A 只改子對話會造成不一致，C 靠關鍵字不可靠。
- 代價：根層級每一輪多一個工具的 schema（約幾百 token）。父對話行為會多一種能力：可以主動開互動卡片。步驟 6 要確認工具預算相關評估沒有變紅。

### 評估

`scripts/eval/subchat_tools.eval.js`，真桌面版，埠 17967，假 LLM 抓 `body.tools`。同一句「幫我畫一張貓的圖」：父對話（話題偵測關閉）與子對話（經 `_subchatSend`，閒置 → 新一輪）各抓一次請求。

| 檢查 | 修前 | 修後 |
|---|---|---|
| parentCaptured／childCaptured | true／true | true／true |
| sameNameSet（名稱集合完全相同） | true | true |
| parentHasAskCard | **false** | true |
| childHasAskCard | **false** | true |
| loadedWorkdirImpl | （修前沒有此項） | true |
| 工具數（父／子） | 9／9 | 10／10 |
| allPass | false | **true** |

修前的重點：父與子的名稱集合本來就相同，兩邊都缺 `ask_user_card`。所以管理層預期的「子對話與父對話不同」在這個根因下不成立，差異是**父子都缺**。修前失敗來自 `parentHasAskCard`、`childHasAskCard`。

### 建置注意

- 建置後的 `renderer/floating-assistant.js` 把單引號改成雙引號（`register_openai_tool("ask_user_card",`），而且行數與排版都不同。判準不能只找單引號字串；評估改成兩種引號都接受的 regex。
- 建置前已把 `renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/core.js`、`web-lazy/manifest.json`、`test-reports/core-tests-latest.*`、`skills/image-decompose-redraw/data/parts_builtin.json` 備份到暫存資料夾（不提交）。

## 教訓

- 步驟 1：`ask_user_card` 被歸為 domain-gated 是分類錯誤，不是子對話的錯。之後遇到「子對話少了某工具」先確認父對話有沒有，不要直接在子對話加。
- 步驟 2：建置會改寫引號與排版，評估判準要用 regex 接受兩種引號，不要寫死單引號字串。一開始 `loadedWorkdirImpl` 因此誤判成 false，不是載入錯檔；修判準後重跑才通過。
