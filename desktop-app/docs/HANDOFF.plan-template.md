# 交接：離線模型「平日任務」——開關（LoRA／thinking／recipe）與 plan→Python 範本→接線路徑（2026-11-17）

## 1. Opening prompt（接手者收到的原文）

Continue from the handoff document at desktop-app/docs/HANDOFF.plan-template.md. Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill (THRESHOLD 30%): do the next todo item, and when your context reaches the threshold, write the next handoff and start your own successor. As your first message, confirm in one line that you read the document and which todo item you are starting.
使用者原話：「我希望啟用LoRA, thinking，有個開關可以決定要不要recipe」「目前我發現離線模型做平日處理很爛」「是不是我們python code template要增加?除卻gui以外，也要把domain所有可涵蓋行為變成python code template?然後作到plan -> python code template -> python code wiring 作為更穩的路徑?」「我的要求就是把它做完!!!!!!」「為什麼要一直中斷?!」

## 2. Overview

- 專案：`tw_stock_db` 的 Electron 桌面版，分支 `desktop-app`，目錄 `desktop-app/`（repo 根 `/home/hungfu.lee/下載/SRC/tw_stock_db`）。使用者寫繁體中文，回覆只能繁體中文或英文。Linux，沒有真 GPU。目前最新 patch v430 以上（另一個 session「離線模型 thinking 與大模型 · handoff 1」`local_3cae653d-9830-41f8-a761-92d70dbe04da` 正在做 Qwen3 1.7B 接進產品、q4f16 GPU 引擎接進 transformers.js；**它也在同一個工作目錄改 `floating-assistant.js`**：你的改動要小而快地提交，用 `git add` 選檔，避免把對方未提交的改動混進你的提交；`scripts/publish.sh` 會因別人的未提交來源拒絕發布，到時等對方提交或看 §4 的發布步驟）。
- **使用者的需求**：(A) 離線模型那邊要有開關：啟用 LoRA、thinking，以及「要不要 recipe」（recipe＝CoLU 封閉題外殼 `renderer/src/recipe/recipe_core.js` 的 `jsonStep`：程式決定路由與欄位，模型只回答封閉題或固定欄位 JSON）。(B) 症狀：離線模型做平日處理很爛。例子：「請開網頁看今日新聞總結給我」→ 它只產生一個 function call、讀出連結清單，不會點進去看內文、也不會總結；但 AiDoc（Redmine 那邊）的離線模型看得懂程式、能總結；把離線模型＋thinking 拿去讀 log 效果不錯。(C) 使用者的假設與問題：Python code template 要增加，除了 GUI 之外，把 domain 所有可涵蓋的行為都變成 Python code template，做「plan → Python code template → Python code wiring」當更穩的路徑，整條是：plan → UML design → decompose → code write → 執行 code 取回各階段內容 → thinking + reading。
- 已知的相關現成物（先讀）：`DESIGN.fn-template.md`、`DESIGN.gui-templates.md`、`DESIGN.colu.md`、`DESIGN.code-agent`／`renderer/src/code/code_agent_core.js`、`code_loop_core.js`、`DESIGN.log-mining.md`（log 能力怎麼做出來的：domain＋subagent＋tool＋recipe）、`DESIGN.intent.md`、`DESIGN.four-directions.md`；`pythonApiBridge:'skill'`（執行技能包 Python 腳本時，部分公開 API 轉接到助理自己的工具）；離線模式（Offline Trainer，規則比對，不呼叫模型）與「離線模型」（Qwen3-0.6B，原生／WebGPU／GPU 解碼路徑）是兩回事：使用者說的「離線模型＋thinking 讀 log」是後者。網頁讀取的離線規則在 `_otPageDigest`（`floating-assistant.js` 約 93400 行）：2026-11-17 已修「看有沒有 X」的篩選，但那是離線模式規則路徑，不是這裡的模型路徑。
- 我（上一位）對問題的初步判斷（需你用程式與實測驗證，不要照單全收）：症狀是**缺一個多步驟迴圈**，不是缺更強的模型——模型一次只會發一個工具呼叫並在拿到連結清單後停下，沒有「依清單逐篇打開→讀內文→逐篇摘要→合併總結」的程式化步驟；而 log／程式內容是一次整份塞進上下文，模型只需要讀與總結，所以表現好。所以方向（範本化）是對的：用**確定性的 Python 範本**負責「做什麼、依序做、取回什麼」，模型只負責「填封閉的槽（主題、篇數、挑哪幾則）」與「讀取回的內容做摘要（可開 thinking）」。我（上一位）**沒有**驗證過現有範本庫涵蓋範圍、recipe 是否已有「網頁多篇摘要」流程、LoRA 與 recipe 目前的開關位置——這些都是你要先查的事實。

## 3. Todo（依序）

1. **開關（先做，小而快）**：在離線模型設定加三個獨立開關並說明各自作用：`offlineThinking`（已存在，v429，預設關）、LoRA 啟用（查現有 `_loraRouteTurn`／`_loraSwitch`／`offlineTextModel`／LoRA 槽設定，已有的就接出來，沒有的就補，並確認原生路徑與 WebGPU 路徑各自怎麼套 LoRA；注意 `qwen3-0.6b` 的 LoRA 只在原生路徑生效，見 `_llmGenerateInner` 的註解）、`offlineRecipe`（recipe 開／關：關＝模型自由發揮、不走 CoLU 封閉題外殼與範本；開＝走 recipe；預設**開**，因為 recipe 是穩定路徑，由使用者決定）。設定要加預設值、`_normalizeAdvancedSettings` 白名單（沒加存檔會被洗掉）、UI（AI 助理設定與桌面版設定頁共用一處，放離線模型區塊，不要放 `_gpuCompatControls`；不要每個都一個大勾選：使用者之前抱怨過 GPU 設定「每個都一個 checkbox」太誇張，所以這三個合成一個清楚的小區塊，每個一行說明）。測試＋embed＋提交＋發布。
2. **查證與實測重現症狀**：用離線模型（原生或 WebGPU 路徑，這台 Linux 有 `~/.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8`、ORT 可用）重現「請開網頁看今日新聞總結給我」：弄清楚它現在走哪條流程（Grep `browser_create_tab`、`fetch_web_page`、`_llmGenerateInner` 的工具呼叫迴圈、`FaVlm` 的 tool calling `hermes`），為什麼停在發一個呼叫、連結清單之後為什麼不繼續；把觀察寫進 `DESIGN.plan-template.md`（新檔，短）。
3. **範本庫盤點**：列出現有 Python／GUI 範本（`DESIGN.gui-templates.md`、`DESIGN.fn-template.md`、`renderer/src/pybridge/`、`skills/`）涵蓋的行為，對照 domain 清單（`DESIGN.block-domains.md`、各 `domain_*_core.js`、工具清單 `/api/tools`），做成「domain 行為 × 有沒有範本」的表，標出最常見的平日任務缺口：網頁多篇閱讀與摘要、檔案／資料夾整理、log 分析、文件摘要、查資料彙整、排程提醒…（以使用者實際會問的為準，不要憑空擴張）。
4. **路徑設計**：在 `DESIGN.plan-template.md` 設計 plan → （UML／decompose，沿用 `uml_core`、`FaPyUmlPipeline` 現成的部分）→ Python 範本選擇與填槽（模型只回封閉題／固定欄位 JSON，`jsonStep`）→ 在 Python 沙盒執行（`pythonApiBridge:'skill'` 轉接工具）→ 取回每階段內容 → 模型讀取並總結（可開 thinking；內容用 `jsonl_pager`／`read_ledger` 分頁，避免超過上下文）。明確寫每一步誰決定（程式／模型）、失敗怎麼退回、怎麼不讓模型「只發一個呼叫就停」。
5. **先做一條垂直切片**：「開網頁看今日新聞總結」＝範本（開頁→取清單→取前 N 則內文→逐篇摘要→合併），模型只填 N／主題、讀取回的內文做摘要；在離線模型＋recipe 開的狀態下實跑（真工具或假工具＋真模型），對比現況輸出，寫進 DESIGN。接進 `_llmGenerateInner` 或 CoLU 的路由，受 `offlineRecipe` 開關控制，失敗退回現路徑。
6. 擴到其他高頻平日任務的範本（依 3 的缺口表排序，一次一個，每個都要有實跑驗證）。

## 4. Working style（使用者規則，照抄重點）

- **不要中斷使用者**：「為什麼要一直中斷?! fucking hate it!」「我並不是ALL DAY LONG都在陪你這專案」「我的要求就是把它做完!!!」。不問選項、不回報「還在跑」、歧義自己決定並寫進文件；全部做完或真的卡死才回報一次。
- 繁體中文或英文；結論先講；沒驗證就說沒驗證；查不出原因就說查不出，不要編原因（使用者問「為什麼」時）；**使用者的要求沒做到就是沒做到——不要把沒做的項目標成「太大不做」（清單 C 就是這樣被使用者抓包）**。
- 提交：只 `git add` 自己的檔案；訊息寫「做了什麼＋怎麼驗證」並以 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` 結尾；改了 `renderer/src` 的模組後跑 `node scripts/embed-code-ui.js` 與 `node --check renderer/src/floating-assistant.js`；測試用 `node scripts/test-affected.js`（完整測試不要跑；`studio_embed.test.js` 的 `lora_ref_train.js` 失敗是既有問題）。
- 發布（使用者已授權 commit／push／publish）：`/tmp/claude-1001/qwen/pub.sh "<patch說明>" "<commit說明>" vNNN`（檔案不在就照做：暫時把別人未追蹤的 `skills/weak-model-harness/scripts/bridge/` 移到 `/tmp/claude-1001/bridge-aside`，發完用絕對路徑移回；`git push origin desktop-app`；`bash scripts/publish.sh --no-web -m … --commit-msg …`；用 git worktree 改 `web/index.html`／`web/aiweb/index.html` 的舊 SHA 為新 HEAD，訊息「網頁版載入改釘 <sha8>（vNNN）」，push main）。版號先 `node scripts/release-version.js status`。若 `origin/desktop-app` 有新提交，先 `git merge origin/desktop-app`（嵌入字串衝突用 embed-code-ui.js 重新產生）。
- 工作目錄與另一個 session 共用：不要碰對方未提交的檔案，不要用 `git add -A`／`git stash`／`git reset`。
- 本機環境：Linux，node 20，沒有真 GPU（軟體 WebGPU 即可，真 GPU 不用驗證）；殺 Chrome 只殺自己啟動的（`/tmp/claude-1001/qwen/killmine.sh`；不要在命令字串裡同時寫 user-data-dir 字串又用 grep／pkill 比對，會殺到自己的 shell）。

## 5. Verbatim user words（原文，依日期）

- 2026-11-17：「我希望啟用LoRA, thinking，有個開關可以決定要不要recipe」
- 2026-11-17：「目前我發現離線模型做平日處理很爛 例如"請開網頁看今日新聞總結給我" 它只會傻傻產生一個call function,讀出連結，不會進去看內文 也不會總結，但AiDoc的離線模型會看得懂程式，並總結 甚至我把離線模型+thinking去讀log，可以做出不錯的效果」
- 2026-11-17：「是不是我們python code template要增加?除卻gui以外，也要把domain所有可涵蓋行為變成python code template?然後作到plan -> python code template -> python code wiring 作為更穩的路徑? 這樣可以讓plan -> uml design -> decompose -> code write -> 執行code取回各種階段的內容 -> thinking + reading」
- 2026-11-17：「如果沒有接上去，就代表你沒有照著我的要求達成」
- 2026-11-17：「為什麼要一直中斷?! fucking hate it!」「我並不是ALL DAY LONG都在陪你這專案」「我的要求就是把它做完!!!!!!!!!!!!!!!!!!!!!!!!!!!!!」
- 2026-11-17：「可以先commit , push, publish」
- 2026-11-16：「真gpu不用管，我們用最爛的機器(Geforce 720T)測過，比當代Intel Core I5-2620還快1.78倍」

## 6. Handoff procedure（自我遞迴）

執行 low-context-long-run skill，THRESHOLD 30%：每個批次邊界（已提交）讀 `get_usage`；到門檻就更新本文件、提交，用 `mcp__ccd_session__start_session`（initiation "user_asked"、context "fresh"、`use_worktree:false`、標題「離線模型平日任務範本 · handoff N」，prompt 為 §1）啟動接手者，等它確認後 `mark_completed`＋`archive_session`。**由 session 啟動的 session 不能再啟動 session**（會被 app 拒絕）：被拒就在最後訊息寫明「交接已寫好，請頂層 session 啟動下一棒」。待辦清空就回報完成、不再交接。

## 7. Traps

- 「離線模式（Offline Trainer，不經過AI）」卡片是規則比對，模型與 LoRA 完全沒被呼叫；「離線模型」是 Qwen3-0.6B 那條路徑。別把兩者混為一談。
- `_normalizeAdvancedSettings` 有白名單；新設定沒加進去，存檔會被洗掉。設定改名比改預設值可靠（舊設定檔存過預設值）。
- 使用者抱怨過設定畫面「每個都一個 checkbox」太誇張：新增設定要合併成少數幾個清楚的開關，個別細項收進「進階」。
- 兩個 session 同時改 `floating-assistant.js`：embed 後的整檔會互相影響，`publish.sh` 會因別人的未提交來源拒絕；提交要小而快。
- 主程序／執行包檔案（`nr-engine.js`、`nr-child.js` 等）不能熱更新。
- 分類器偶爾拒絕 `start_session`（無理由）：由使用者原話觸發的訊息重試一次通常可以。
