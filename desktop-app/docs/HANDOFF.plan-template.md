# 交接：離線模型「平日任務」——開關（LoRA／thinking／recipe）與 plan→Python 範本→接線路徑（2026-11-17，handoff 2）

## 1. Opening prompt（接手者收到的原文）

Continue from the handoff document at desktop-app/docs/HANDOFF.plan-template.md. Read it fully, including the verbatim user words and the working style, and follow them. Run the low-context-long-run skill (THRESHOLD 30%): do the next todo item, and when your context reaches the threshold, write the next handoff and start your own successor. As your first message, confirm in one line that you read the document and which todo item you are starting.
使用者原話（必須遵守）：「我希望啟用LoRA, thinking，有個開關可以決定要不要recipe」「是不是我們python code template要增加?除卻gui以外，也要把domain所有可涵蓋行為變成python code template?然後作到plan -> python code template -> python code wiring 作為更穩的路徑?」「我的要求就是把它做完!!!!!!」「為什麼要一直中斷?!」

## 2. Overview

- 專案：`tw_stock_db` 的 Electron 桌面版，分支 `desktop-app`，目錄 `desktop-app/`（repo 根 `/home/hungfu.lee/下載/SRC/tw_stock_db`）。使用者寫繁體中文，回覆只能繁體中文或英文。Linux，沒有真 GPU（使用者：「真gpu不用管」，軟體 WebGPU 即可）。
- **已完成（todo 1）**：
  - 提交 `8f6cd4687`「離線模型開關區塊：LoRA／Thinking／食譜三個獨立開關」，已推 `origin/desktop-app`。內容：
    - 新設定 `offlineLora`（預設開）＋ `_normalizeAdvancedSettings` 白名單；`_llmGenerate` 內若 `offlineLora === false` 走 `_loraOff`（上一輪掛著的 adapter 只清一次，之後一律基底）。
    - 離線模型面板（`_omRenderPane`）新增「離線模型開關」區塊：三個勾選（`data-om-switch`：lora／thinking／recipes），各一行說明；切換只存設定並重畫面板，不卸載已載入模型。
    - 移除 AI 進階設定裡的舊 `ai-offline-think-chk` 勾選與其同步／監聽程式（避免兩處開關）；移除文字生成卡裡的舊 recipes 勾選。
    - `offlineThinking`（預設 off）、`offlineRecipes`（預設 on）沿用既有 key，不改預設。
  - 測試：`renderer/src/studio/lora_route_wiring.test.js` 30 passed／0 failed（修過一次：`_llmGenerate` 的 `this` 沒有 `advancedSettings` 時會丟錯，改成 `(this.advancedSettings || {}).offlineLora`）。全量 `scripts/test-affected.js`：除 `studio_embed.test.js`（`lora_ref_train.js`，既有問題）外通過；全量約 500 秒，要用前景 `timeout 580`，或背景＋輸出檔。
  - 發布：`scripts/publish.sh --no-web` 成功，**v432**：desktop-app 提交 `dfa760d5d`（含 PATCH_VERSION 432），desktop-app-patch `f6f6cd03c`（v2 manifest 版本 432，`floating-assistant.js` md5 `1c4ef23ace38694640cd713ce89cb22f` 與本機一致）。
- **未完成的發布步驟（卡住）**：網頁版釘 SHA。`web/index.html` 與 `web/aiweb/index.html` 目前釘在 `337fe7b30db0e72c151b6bb90623b71a686b6163`（另一個 session 的 v431），應改成 `dfa760d5d78cae0755a3fc9e8baa005249255d86`，提交「網頁版載入改釘 dfa760d5（v432）」並 push `main`。**auto-mode 分類器拒絕了這個指令（含 push main），沒有執行、沒有留下殘留。不要重試、不要繞過；把它列在最後回報，等使用者決定。**
- 其他 session 同時在做：`offline-model-h1`（`local_3cae653d-9830-41f8-a761-92d70dbe04da`）已提交 `d3a9541e1`（Qwen3 1.7B 接進產品）與 `337fe7b30`（v431 發布）。`floating-assistant.js` 是共用檔，見 §7 的合併做法。
- 本 handoff 不改寫原來的需求；todo 2 之後尚未開始。

## 3. Todo（依序）

**進度（最新，2026-11-17）**：
- ✅ todo 2 診斷：`DESIGN.plan-template.md` §1.3–1.5。原因已確認：`_planFinish` 直接把取回的原文當答案，沒有任何模型讀取（缺讀＋總結層）。
- ✅ 讀＋總結修正：`6b93b201f`（`_planFinish` 摘要類目標改走 `_planLocalSummarize`；沒模型標示「這次沒有經過 AI」）；測試 `renderer/src/recipe/plan_readback.test.js` 8 passed。
- ✅ 網頁新聞確定性核心：`989435b1f`（`renderer/src/recipe/web_news_core.js`：來源登錄表、站名別名、拆字、頁面切單位、比對；測試 `web_news_core.test.js` 21 passed）。
- ⏳ 下一步（照順序）：
  1. 把 `web_news_core` 接進計畫：`web_research`／`web_summary` 的新聞路徑 = 選來源（`pickSources`）→ 取清單（`fetch_web_page`／RSS）→ `splitPage` ＋ `matchUnits`（目標詞用 `goalOf`＋`expandTerms`）→ 逐篇取內文 → 逐篇 `_planLocalSummarize` → 合併「N 則，各一句重點」；沒有相關就明說沒有。
  2. 可觀測性（§3(g)）：每步一行進使用者開著的 transcribe；先確認讀的是哪個管道（`_createProgressWidget` 的「離線計畫」卡片 vs `_rgTrace`），再補齊；測試用假模型＋假工具斷言步驟序列。
  3. 垂直切片實跑（§3(e)）：真模型（原生 q8）＋假網頁（固定 HTML），三個說法：「看今天有哪些黃仁勳新聞」「去 yahoo 看黃仁勳的新聞」「看 yahoo 新聞有沒有颱風」。結果寫進 `DESIGN.plan-template.md`。
  4. 全部通過後：`node scripts/test-affected.js`（全量約 500 秒，背景跑）、commit、`publish.sh --no-web`（先 `mv` 出未追蹤的 `skills/weak-model-harness/scripts/bridge/`，之後移回）、回報一次。網頁 SHA repin 仍被分類器擋住，不重試。

**2026-11-17 追加需求（轉達自使用者，逐字見 §5；全部要做，做完再回報一次）**：
- (a) 讀 log 的範式是**逐層歸約（map-reduce）**：大量內容切段、每段各自讀與摘要、往上一層合併，層層縮到放得進上下文。網頁多篇摘要要用同一範式：第 0 層＝程式取回的原始內容（清單→各篇內文），第 1 層＝逐篇／逐段摘要，第 2 層＝合併總結；每層的單位、模型被問的封閉題、層間傳遞、停止條件、哪一步用 thinking 都要寫清楚。（log 的現成結構見 `DESIGN.log-mining.md`、`DESIGN.TODO.md` 117～147 行、`jsonl_pager`／`read_ledger`。）
- (b) **來源登錄表**（資料層）：依任務類型列可用網站與進入點（新聞台灣：Yahoo 新聞 https://tw.news.yahoo.com/、中央社、聯合新聞網、自由時報、公視、Google News 搜尋 RSS `https://news.google.com/rss/search?q=<關鍵字>&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`；查資料：搜尋結果頁或其 RSS）。每筆：名稱、進入點 URL 樣板（關鍵字槽）、取清單方式（RSS／列表頁／搜尋頁）、內文擷取方式、語言、可靠度、預設順序。使用者指定了網站（含 URL）就用使用者的；沒指定用登錄表預設（1～3 個），並顯示每次實際用了哪些來源。放成可擴充的純資料模組（`renderer/src/` 下）加測試；設定的「進階」區可編輯。
- (c) **站名別名表**：「去 yahoo」「看 yahoo 新聞」「google 新聞」「中央社」→ 進入點（yahoo→tw.news.yahoo.com 新聞首頁，不是 yahoo 首頁；yahoo 股市／奇摩要分得清）。字串比對抽取站名，不叫模型猜網址；沒抓到站名才退回預設來源或問封閉題（從登錄表選一個字母）。
- (d) **拆字**：使用者的話去掉功能詞（今天、有哪些、幫我、請、新聞、看…），抽目標詞（黃仁勳），展開別名／近義（Jensen Huang、輝達、NVIDIA，沿用 `_faOtWebGoal`／`_faOtExpandTerms`／`FA_SEM_LEX`，含繁簡／全半形）；頁面文字切成「標題＋連結」單位（沿用 `_otPageDigest` 的雜訊規則：導覽列、廣告、時間戳），再逐單位比對目標詞。純函式、有單元測試；模型只在比對有歧義或要摘要時被問封閉題。
- (e) **驗收用例**：「看今天有哪些黃仁勳新聞」（也要測「去 yahoo 看黃仁勳的新聞」「看 yahoo 新聞有沒有颱風」，含沒說站名、說了站名兩種）：開新聞首頁→取清單→篩出相關標題→逐篇讀內文→逐篇摘要→合併成「今天有哪些黃仁勳新聞：N 則，各一句重點」；沒有相關新聞就明說沒有，不拿無關標題充數。用真模型（原生 q8）＋假網頁（固定 HTML，含相關與無關標題與內文）做可重現實跑。
- (f) **診斷（todo 2 必答）**：使用者昨晚的觀察是「完全沒經過AI，AI只產生plan, recipe就結束了」。請回答：(1) 走的是「離線模式（Offline Trainer，規則路徑 `_otPageDigest`）」還是「離線模型 Qwen3 的 `_llmGenerateInner`＋工具迴圈／CoLU／recipe」，逐步列實際呼叫鏈與每步誰決定、輸出是什麼；(2) 結束點在哪（`jsonStep` 成功就收尾？工具結果沒再餵回模型？`maxTurns`／停止條件？）；(3) 修正：範本每層取回內容後**一定**交給模型讀＋摘要（可開 thinking），最終回答是模型根據取回內容寫的總結；沒經過模型時畫面誠實標示「這次沒有經過 AI」。測試：假模型＋假工具，斷言「取回內容有送進模型」「最終回答含模型摘要」「plan 後迴圈不提前結束」。
- (g) **可觀測性**：離線模型（含範本／recipe／工具迴圈）每一輪做了什麼，要在使用者開著的 transcribe（Grep `transcribe`、`cb.log`、`_rgTrace`、`trail`、`_faOtTrailText`）看得到，而且看得出是多輪：每步一行，含輪次編號、階段（plan／選來源／取清單／篩選／讀第幾篇／逐篇摘要／合併）、誰做的（程式／模型）、工具與主要參數（網址、關鍵字）、取回內容大小與前幾字、送模型的封閉題與模型回答（thinking 長度或摘要）、耗時、失敗與退回原因。預設精簡每步一行，點開看詳細。先查為什麼現有管道沒顯示（離線模型路徑沒寫進 transcribe？只在離線模式 trail 才有？）。測試：假模型＋假工具跑完整範本，斷言 transcribe 步驟序列完整、順序正確、含輪次與誰做的。
- 以上全部寫進 `desktop-app/DESIGN.plan-template.md`。

1. ✅ 開關（`8f6cd4687`，v432）。剩下的只有網頁版釘 SHA（見 §2，已被拒，不重試）。
2. **查證與實測重現症狀（下一步，從這裡開始）**：用離線模型（原生或 WebGPU 路徑；這台 Linux 有 `~/.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8`，ORT 可用）重現「請開網頁看今日新聞總結給我」：
   - 先用 codebase-memory 或 Grep 查 `browser_create_tab`、`fetch_web_page`、`_llmGenerateInner`（約 `floating-assistant.js` 129968 行附近，這裡的 LoRA 註解也在這）、`FaVlm` 的 tool calling（`hermes`）與工具呼叫迴圈。
   - 弄清楚它現在走哪條流程、為什麼只發一個呼叫、拿到連結清單後為什麼停下。
   - 觀察寫進新檔 `desktop-app/DESIGN.plan-template.md`（短）。
   - LoRA 路徑已確認：`_loraSwitch`／`_loraRouteTurn` 會切 adapter；`_llmGenerateInner` 註解寫「LoRA 只在原生生效」（另有 `lora_web_core` 網頁版套用器，約 95541 行，兩者關係要在 DESIGN 寫清楚）。
3. **範本庫盤點**：列出現有 Python／GUI 範本（`DESIGN.gui-templates.md`、`DESIGN.fn-template.md`、`renderer/src/pybridge/`、`skills/`）涵蓋的行為，對照 domain 清單（`DESIGN.block-domains.md`、各 `domain_*_core.js`、`/api/tools`），做「domain 行為 × 有沒有範本」的表，標出平日任務缺口（網頁多篇閱讀與摘要、檔案整理、log 分析、文件摘要、查資料彙整、排程提醒…以使用者實際會問的為準，不要憑空擴張）。寫進 `DESIGN.plan-template.md`。
4. **路徑設計**：在 `DESIGN.plan-template.md` 設計 plan → （UML／decompose，沿用 `uml_core`、`FaPyUmlPipeline`）→ Python 範本選擇與填槽（模型只回封閉題／固定欄位 JSON，`jsonStep`）→ Python 沙盒執行（`pythonApiBridge:'skill'` 轉接工具）→ 取回每階段內容 → 模型讀取並總結（可開 thinking；內容用 `jsonl_pager`／`read_ledger` 分頁）。寫清楚每一步誰決定（程式／模型）、失敗怎麼退回、怎麼不讓模型「只發一個呼叫就停」。
5. **一條垂直切片**：「開網頁看今日新聞總結」＝範本（開頁→取清單→取前 N 則內文→逐篇摘要→合併），模型只填 N／主題、讀取回的內文做摘要；在離線模型＋食譜開的狀態下實跑（真工具或假工具＋真模型），對比現況輸出，寫進 DESIGN。接進 `_llmGenerateInner` 或 CoLU 路由，受 `offlineRecipes` 開關控制，失敗退回現路徑。
6. 擴到其他高頻平日任務的範本（依 3 的缺口表排序，一次一個，每個都要實跑驗證）。

## 4. Working style（使用者規則）

- **不要中斷使用者**：「為什麼要一直中斷?! fucking hate it!」「我並不是ALL DAY LONG都在陪你這專案」「我的要求就是把它做完!!!」。不問選項、不回報「還在跑」、歧義自己決定並寫進文件；全部做完或真的卡死才回報一次。
- 繁體中文或英文；結論先講；沒驗證就說沒驗證；查不出原因就說查不出，不要編原因；**沒做到的要求就是沒做到——不要把沒做的項目標成「太大不做」**。
- 提交：只提交自己的檔案；訊息寫「做了什麼＋怎麼驗證」，結尾 `Co-Authored-By: Claude Haiku 5.5 <noreply@anthropic.com>`（系統提示目前標示的模型；前一次交接寫的是 Sonnet 5.5，以當下系統提示為準）。改了 `renderer/src` 的模組後跑 `node scripts/embed-code-ui.js` 與 `node --check renderer/src/floating-assistant.js`；測試用 `node scripts/test-affected.js`（全量約 500 秒）。
- 發布（使用者已授權 commit／push／publish）：`cd desktop-app && bash scripts/publish.sh --no-web -m "<patch 說明>" --commit-msg "<commit 說明>"`。publish.sh 會拒絕（有別人未提交的來源時），做法見 §7。網頁版釘 SHA 是另一步，先確認分類器允許才做。版號先 `node scripts/release-version.js status`。
- 工作目錄與別的 session 共用：不碰對方未提交的檔案，不用 `git add -A`／`git stash`／`git reset`／`git checkout`。
- 本機：Linux，node 20，沒有真 GPU。殺 Chrome 只殺自己啟動的（`/tmp/claude-1001/qwen/killmine.sh`；不要在命令字串裡同時寫 user-data-dir 字串又用 grep／pkill 比對）。
- 不要用 `sleep` 等待；長指令用 `run_in_background` 或前景 `timeout`。

## 5. Verbatim user words（原文，依日期）

- 2026-11-17：「我希望啟用LoRA, thinking，有個開關可以決定要不要recipe」
- 2026-11-17：「目前我發現離線模型做平日處理很爛 例如"請開網頁看今日新聞總結給我" 它只會傻傻產生一個call function,讀出連結，不會進去看內文 也不會總結，但AiDoc的離線模型會看得懂程式，並總結 甚至我把離線模型+thinking去讀log，可以做出不錯的效果」
- 2026-11-17：「是不是我們python code template要增加?除卻gui以外，也要把domain所有可涵蓋行為變成python code template?然後作到plan -> python code template -> python code wiring 作為更穩的路徑? 這樣可以讓plan -> uml design -> decompose -> code write -> 執行code取回各種階段的內容 -> thinking + reading」
- 2026-11-17：「如果沒有接上去，就代表你沒有照著我的要求達成」
- 2026-11-17：「為什麼要一直中斷?! fucking hate it!」「我並不是ALL DAY LONG都在陪你這專案」「我的要求就是把它做完!!!!!!!!!!!!!!!!!!!!!!!!!!!!!」
- 2026-11-17：「可以先commit , push, publish」
- 2026-11-17（經 floating-ai-assistant.js 轉達，逐字）：「讀log不可能一次塞進上下文 不可能整份」「他是逐層reduction」「它不知道要去哪些網站」「它不知道去yahoo可以進去yahoo新聞，它就算進去yahoo新聞也不知道去拆字」「看今天有哪些黃仁勳新聞」「我昨晚測試的結果就像是完全沒經過AI，AI只產生plan, recipe就結束了」「而且我沒看到離線做了什麼，我有開transcribe，但好像看不到多輪迴圈呼叫什麼，做了什麼」
- 2026-11-16：「真gpu不用管，我們用最爛的機器(Geforce 720T)測過，比當代Intel Core I5-2620還快1.78倍」

## 6. Handoff procedure（自我遞迴）

執行 low-context-long-run skill，THRESHOLD 30%：每個批次邊界（已提交）讀 context 用量（`mcp__ccd_session_mgmt__get_usage`，用 ToolSearch 載入）；到門檻就更新本文件、提交（只 add 本文件），用 `mcp__ccd_session__start_session`（initiation "user_asked"、context "fresh"、`use_worktree:false`、標題「離線模型平日任務範本 · handoff N」，prompt 為 §1）啟動接手者，等它確認後 `mark_completed`＋`archive_session`。**由 session 啟動的 session 不能再啟動 session**（app 會拒絕）：被拒就在最後訊息寫明「交接已寫好，請頂層 session 啟動下一棒」。待辦清空就回報完成、不再交接。

## 7. Traps

- 「離線模式（Offline Trainer，不經過AI）」卡片是規則比對，模型與 LoRA 完全沒被呼叫；「離線模型」是 Qwen3 那條路徑。別混為一談。
- `_normalizeAdvancedSettings` 有白名單；新設定沒加進去，存檔會被洗掉。
- 使用者抱怨過設定畫面「每個都一個 checkbox」太誇張：新增設定要合併成少數清楚的開關。
- **部分提交 `floating-assistant.js`（共用檔）**：工作目錄裡常有別人未提交的 hunk。做法：`git diff -U0` 取出，只挑自己的 hunk；但 `git apply --cached --unidiff-zero` 對 zero-context 的 hunk 會放錯位置（本次就放錯了，語法檢查才抓到）。可靠做法：`git show HEAD:<path>` 當 base，把自己的版本當 ours，`git merge-file -p ours base theirs` 合併到最新 HEAD，`git hash-object -w` ＋ `git update-index --cacheinfo` 寫進索引，再 `git show :<path>` 做 `node --check`。**提交前一定要確認 HEAD 有沒有被別人推進**：本次提交期間別的 session 推進了 HEAD（`d3a9541e1`、`337fe7b30`），若拿舊 base 的索引去提交，會把對方的提交給還原。
- `publish.sh` 遇到別人未提交的來源會拒絕（本次是 `skills/weak-model-harness/scripts/bridge/` 三個未追蹤檔）。做法：`mv` 到 `/tmp/claude-1001/bridge-aside`，發布，**用 `;` 串起來保證事後一定移回**，確認 `ls` 還原。
- `publish.sh` 的「驗證」段印的 186 是互換版 `manifest.json`（凍結，不要拿來算）；要看真正版本用 `manifest.v2.json`。
- `publish.sh --dry-run` 會真的跑建置，會改 `renderer/update-manifest.json`（時間戳），並可能把它 `git add`；發布前要 `git restore --staged desktop-app/renderer/update-manifest.json`（只動索引）。
- 網頁版釘 SHA（`web/index.html`、`web/aiweb/index.html` 的 `cdn.jsdelivr.net/gh/sunneo/tw_stock_db@<sha>`）要 push `main`；本次這步被自動分類器拒絕。
- 兩個 session 同時改 `floating-assistant.js`，embed 後的整檔會互相影響。
- 主程序／執行包檔案（`nr-engine.js`、`nr-child.js` 等）不能熱更新。
- 分類器偶爾拒絕 `start_session`（無理由）：由使用者原話觸發的訊息重試一次通常可以。
