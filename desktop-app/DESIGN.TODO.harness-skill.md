# 交接文件：把弱模型 harness（offline-trainer、UML design、CoLU）做成 skill，並讓經驗回流（handoff 1，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.harness-skill.md`. 先完整讀完（含使用者原話與做法備忘），照做。工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。**開工前先確認沒有別的工作階段（音樂線、補完與驗證線）正在跑並改同一個工作樹；有就先只讀、寫設計文件，不碰 `renderer/src/floating-assistant.js` 與 `scripts/embed-code-ui.js`。** 第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。不要長篇規劃、不要問，直接讀、寫、測、提交。發布由管理層代發：你不要執行發布腳本，每項提交後在回報最後一行寫「第 N 項已提交，可發布，commit <hash>」。到 context 門檻（30%）時更新本文件、提交，回報最後一行寫「需要接手，文件已更新，commit <hash>」（子工作階段在這個 app 不能自己啟動接手）。**本週額度已用到約 88%：跑模型的實驗（第 4 項）要小樣本、記錄用量，不要大量呼叫。**

## 2. 結論與大方向（先說）
**有機會，而且大部分零件已經存在。** 使用者的想法：offline-trainer、UML design、CoLU 這一整套「讓小模型／弱模型也能把事情做對」的機制，其實是一個**弱模型 harness**；它可以包成 **skill**（Claude 格式 `SKILL.md`＋`scripts/`＋`references/`），讓像 `claude-haiku-5.5` 這種小模型在它的帶領下執行任務，品質有保證；而 harness 處理問題時得到的**經驗，適合的要回流補進 offline-trainer**——也就是 offline-trainer 不只是名義上的離線訓練器，而是 harness 的「學習層」。

做法的骨架（細節由接手者依現有文件落實）：
1. **harness 當 skill**：`SKILL.md` 教模型用「迴圈」：呼叫 `node scripts/harness.js next` 拿到一題**封閉選擇題／填空**（字母、編號、固定欄位），模型只回答，`node scripts/harness.js answer <答案>` 交給程式核對、前進下一步；程式負責路由、欄位、驗證、預設退路，模型只當「字母神諭」。這跟專案現有的 CoLU 形狀一致（字母選擇題、程式檢查、程式預設退路）。純函式核心（UMD）在 node 就能跑，不需要 Electron。
2. **Haiku 當試金石**：用 `claude-haiku-5.5`（模型代號以 Claude Code 當下可用的為準，名稱不確定就先查）當「故意選的小模型」，A/B 比較：**光桿 Haiku** vs **Haiku＋harness**，同一組任務、同一套評分（沿用 `renderer/src/catalog/colu_bench_core.js` 的評測題與評分），證明 harness 確實拉高品質、而且穩定。
3. **經驗回流**：harness 每次跑完留下一筆「經驗紀錄」（任務簽名、走的路線、每步的選擇與程式核對結果、最後判定）；**回流閘門**（程式決定，不靠模型自述）：只收「程式驗證過的成功」，去重（簽名相同只留一筆並累計次數）、去識別（路徑、金鑰、個資遮蔽）、大小上限；通過的寫進 offline-trainer（成功案例／語意 pattern，來源標 `harness`，使用者可停用、可刪）；失敗的產生 UML 編修候選（`renderer/src/uml/uml_edit_core.js`），不直接寫進知識。
4. **改名定位**：UI 與文件把 offline-trainer 的定位改為「harness 的學習層」（名稱可保留，旁邊加說明），避免只被當成「離線用」。

## 3. Todo（依序）
1. **讀與對照（短）**：讀 `DESIGN.offline-harness.md`、`DESIGN.offline-trainer.md`、`DESIGN.offline-trainer-roadmap.md`、`DESIGN.colu.md`、`DESIGN.colu-porting.md`、`DESIGN.uml-framework.md`、`DESIGN.skill-recipes.md`、`DESIGN.offline-recipes.md`、`DESIGN.offline-plans.md`；看 `renderer/src/catalog/`（`colu_bench_core.js`、`relu_core.js`、`select_core.js`、`reflect_core.js`、`rank_train.js`）、`renderer/src/recipe/`（`recipe_core.js`、`plan_core.js`、`skill_compile_core.js`＝技能→食譜編譯器）、`renderer/src/uml/`。寫 `DESIGN.harness-skill.md`（新檔，一頁）：harness 的零件地圖（哪個檔案負責路由／規劃／選擇／驗證／學習）、已有什麼、缺什麼，**缺口要具體到檔案與函式**。已有就說已有，不要重做。
2. **skill 套件**：`skills/weak-model-harness/`（參考既有的 `skills/image-decompose-redraw/` 格式與 `.claude/skills/publish-live-update-patch/`）：`SKILL.md`（frontmatter＋迴圈使用說明，用中文，**說明裡不要出現反引號包住的 code span 造成歧義的寫法？——SKILL.md 是檔案不受 JS 字串限制，可用**）、`scripts/harness.js`（命令列：`start <任務>`、`next`、`answer <答案>`、`status`、`learn`，狀態存成 JSON 檔以便跨呼叫、可中斷續跑）、`references/`（封閉題型說明）。核心用 `require` 載入現有 UMD 模組（路徑相對於 repo；套件要能搬走時，另有打包腳本把用到的核心複製進 `scripts/vendor/`）。測試：`scripts/harness-tests/`（用假模型跑完整迴圈：完美、亂答、沉默、連線失敗，程式核對與預設退路都要驗到）。
3. **經驗與回流閘門** `renderer/src/harness/experience_core.js`（`FaHarnessExp`，UMD，測試 `scripts/harness-tests/experience.test.js`）：紀錄格式、簽名、去重累計、去識別、大小上限、`gate(record)`→`{accept, reason}`（所有拒絕都附原因）、`toTrainer(record)`→訓練器 pattern／案例（沿用 `editor_cases` 的存法：`renderer/src/edit/edit_cases.js`，成品大的放獨立資料表，pattern 小）、`toUmlEdit(record)`→UML 編修候選。接進 harness.js 的 `learn`。**新增資料格式要定義版本與 migration。**
4. **Haiku 實驗（小樣本，記用量）**：先 `mcp__ccd_session_mgmt__get_usage` 記下起點；用 `claude -p --model <haiku 代號> --output-format json`（無頭模式）或使用者設定的金鑰，跑固定的小題組（例如 CoLU bench 抽 12～20 題，涵蓋路由、填欄位、接線、規劃），**兩組**：光桿 Haiku、Haiku＋harness（迴圈由腳本驅動，模型每次只收到一題封閉題）。記錄：通過率、重試次數、格式違規率、平均每題 token；結果與用量寫進 `DESIGN.harness-skill.md`。**如果無頭模式或模型代號不可用，照實寫「未驗證」並用假模型示範，不要編造數字。**
5. **回流前後對照**：把第 4 項裡「程式驗證過的成功」經 `gate` 寫入訓練器，再跑一次同題組，記錄有沒有進步（尤其是路由與預設值的命中），誠實報告沒進步的部分。
6. **UI 與文件定位**：離線訓練器的說明文字與設定頁（`floating-assistant.js` 搜 `offline_trainer`／訓練器面板）加上「harness 的學習層」與「來自 harness 的經驗」來源標示、可停用可刪；`features/ai-features.yaml` 清冊新增條目（`node scripts/ai-features.js check` 通過再 `build`）；`node scripts/embed-code-ui.js && node build-assistant.js`；`node scripts/run-core-tests.js` 沒有新增失敗（新測試加進清單）。
7. 發布由管理層代發；把「做到哪、哪些未驗證」寫進文件。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。沒驗證就寫「未驗證」。
- **UML design 的意思**（使用者定義）：由上而下持續規劃、細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程。CoLU 思考外殼：字母選擇題、程式檢查、程式預設退路；模型輸出一律由程式核對。
- 回流只收**程式驗證過**的成功，不信模型自述（記憶：宣稱要用磁碟驗證）。
- 改來源模組再嵌入；不要改嵌入後那份。改檔用 Edit／Write；Bash heredoc 內的 Python 會吃掉反斜線與中文，需要時用 Write 工具寫 `.py` 檔再執行。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 資料庫結構或記憶格式有改，必須定義版本與 migration。
- 工具說明文字用中文引號，不要反引號 code span（JS 字串內）。
- 熱更新：舊版也要收得到、不准要求重裝；新檔案要進 live patch 與網頁版清單。
- 工作樹有不是你改的檔案：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字，2026-11-01）
- 「我有一個想法，幫我實現，我們的offline-trainer, uml-design, CoLU可以是小模型，弱模型的harness，他有沒有機會成為skill。舉例來說，我們可以故意拿claude-haiku-5.5 當小模型的案例，來確保執行品質。 在這個harness處理問題時得到的經驗、適合回流進去處理的，可以補回到offline-trainer，也就是offline-trainer不是名義上的offline-trainer，而是harness的一塊」
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」；發布：「由你代發」（管理層代發）。

## 6. 交接流程
子工作階段不能自己啟動接手；到門檻時更新本文件、提交、回報「需要接手，文件已更新，commit <hash>」，由管理層啟動下一個。

## 7. 陷阱
- 「skill」在本專案有兩個意思：① Claude 格式的 skill 套件（`SKILL.md`，給 Claude Code／Claude 應用載入）；② 專案內建的 BUILTIN_SKILLS 與「技能→食譜編譯器」（把 skill 編成離線食譜）。使用者這次要的是①，同時可以沿用②的編譯器把 skill 的步驟轉成 harness 的題型。
- 不要把經驗回流做成「模型說成功就收」；閘門的依據是程式核對的結果。
- 本週額度很吃緊（約 88%）：第 4 項的實驗要小樣本，且先記用量。
- 無頭 `claude -p` 的模型代號、可用性我沒驗證；查不到就標未驗證。
- 同一個工作樹同時只能一個寫手；`floating-assistant.js`／`embed-code-ui.js` 是衝突熱點。
