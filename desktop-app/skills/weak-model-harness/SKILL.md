---
name: weak-model-harness
description: 弱模型（例如 claude-haiku-5.5）的帶領技能，包含三部分。一是封閉題迴圈：程式負責路由、欄位、核對與預設退路，模型每次只回答一題封閉題，做完把程式驗證過的成功存成經驗。二是老師端的派工與驗收輔助（teacher_gate：dispatch 記下使用者原話，verify 核對提交範圍、共識、驗收指令與「沒有出入」之類的宣稱，observe 記下老師視角的記錄）。三是共識閘門與路線經驗（共識檔的必須與禁止條款、正路與分支與反思的 JSON）。四是速度守則（等待間隔、逾時上限、乾跑與並行，派工時附上，驗收時掃描超限數字）。當你要處理安排會議、單位換算、批次改檔名這類有固定欄位的任務，或要派工、驗收弱模型的工作、驗證它的執行品質時使用。
---

# 弱模型 harness

你不需要自己規劃整件事。照下面的迴圈做，每一步只回答程式問你的那一題。

## 迴圈

```bash
node scripts/harness.js start "使用者的原話"
node scripts/harness.js next
node scripts/harness.js answer "你的答案"
```

重複 next 與 answer，直到 next 說「工作已結束」。

規則：

1. next 印出的就是你要回答的題目。選擇題只回一個字母（例如 B）；填空題只回一個 JSON 物件，鍵只能是題目列出的欄位。
2. 使用者的話裡沒有提到、你不確定的欄位，一律填 null。不要猜，不要編數字：數字只能用使用者說過的。
3. 答案不合格時，answer 會告訴你精確的原因，再答一次。最多兩次；兩次都不合格，程式會改用它的預設退路，並在判定裡標記，這次經驗就不會被收進學習層。
4. 能由程式決定的（關鍵字路由、唯一命中的選項、唯一的列舉值、唯一的數字）程式已經決定了，不會問你。
5. 不要在回答裡加解釋、前言或程式碼框。

## 結束之後

```bash
node scripts/harness.js status
node scripts/harness.js learn
```

status 的判定由程式算出：ok（全部由程式或你答對）、degraded（用過預設退路）、failed（缺必填欄位或路由不到）。learn 把這件事送進經驗閘門：只收 ok 的成功，去重、去識別、有大小上限；通過的寫進 `trainer-patterns.json`（離線訓練器的語意 pattern，來源標 harness）；失敗的只記成 UML 編修候選（`uml-candidates.json`），不直接變成知識。

## 內建的離線訓練器與程式行為分析

這個資料夾自給自足：scripts/vendor/ 內附專案「離線訓練器」的語意與規則核心（特徵雜湊嵌入、概念詞典、槽位擷取、規則比對、參數樣板）與「程式行為分析」引擎（tree-sitter 語法樹為基礎）。任何人匯入這個 skill 都直接擁有，不需要 Floating Assistant。

```bash
node scripts/harness.js trainer "使用者的話" [--domains 離線訓練器匯出檔.json]
node scripts/harness.js behavior 某個原始碼檔
```

- trainer：乾跑離線訓練器，列出最像的規則或範例句、填好的參數與缺的槽位，完全不呼叫模型。harness 學到的經驗（trainer-patterns.json）會自動一起比對。
- behavior：把原始碼解釋成由下而上的行為敘事（函式做了什麼、分支、迴圈）。第一次需要網路下載語法樹，之後用快取；失敗會明確回報，不猜。
- 改了來源（recipe_core、離線訓練器核心、行為引擎）之後執行 node scripts/pack.js 重新產生 vendor/，並一起提交。

## 資料放哪裡

預設在目前資料夾的 `.weak-harness/`：`session.json`（可中斷續跑）、`experience.json`、`trainer-patterns.json`、`uml-candidates.json`。用 `--dir` 換位置，`--json` 取得機器可讀輸出。範本在 `references/templates.json`，題型說明在 `references/closed-questions.md`。

## 為什麼這樣設計

小模型整段讀需求會漏、會編。這個迴圈把需求切成小而封閉的題目，程式核對每一個答案，模型只當「字母神諭」。它跟專案的離線訓練器、UML design、CoLU 是同一套思路：字母選擇題、程式檢查、程式預設退路。離線訓練器因此不只是離線備援，而是這個 harness 的學習層。

## 路線經驗

除了「封閉題經驗」，這個資料夾還有 `references/path-experiences.json`：記錄一個任務從頭到尾**走過的路線**，包括正路（實際成功的步驟與每步的程式驗收）、分支（當時的選項、選了哪個、結果、是否繞遠路）與反思（如果重來，捷徑、前置檢查、該拆小的步驟、該早點問的決定）。格式：`{ "version":1, "records":[ {id, task, kind, stage, steps:[{do,check}], alternatives:[{option,outcome,chosen}], lesson, evidence, verified} ] }`，`kind` 只能是 `positive_path`、`branch`、`reflection`。每筆的 `evidence` 必須寫來源（工作階段名加提交號或文件行號），沒有來源的不收。

**何時讀取**：開新的同類任務（例如另一個 CoLU 型的思考外殼、又要接計畫與反思的功能）之前，先讀同類任務的 `positive_path` 與 `reflection`，依 `task` 欄位判斷是否同類。碰到相同性質的卡點（例如「評估 0 次呼叫」「量測用的是舊檔」「逾時值沒依裝置」）時，先看有沒有對應的 `branch`。

**與 `experience.json` 的差別**：`experience.json`（放在目前資料夾的 `.weak-harness/`）只收 `learn` 時 `status` 為 ok 的封閉題成功經驗，由程式驗證，每筆是「一題怎麼答對」。路線經驗是人工整理的任務層級記錄，不由 `learn` 寫入，也不經程式核對，所以 `verified` 欄位要如實標示（只有重跑過測試才標 true）。兩者不要混用：封閉題經驗給離線的答題用，路線經驗給開工前的人與模型讀。

詳細整理與待辦建議見 `DESIGN.TODO.md（原檔：path-experience）`。

### 共識閘門

老師每次派工，簡報都要附共識檔（`references/consensus/<名稱>.json`）：`must` 列必須出現的片語，`forbid` 列已被使用者否決或未同意的方案與片語，`allow` 列例外（例如 CDN 網址、註明禁止的句子）。Haiku 提交前自己跑一次：`node scripts/consensus_check.js references/consensus/<名稱>.json --root <專案資料夾>`；管理層驗收時也跑一次。結束碼 1 代表違反，要退回重做，不能靠記憶判斷「應該沒問題」。

為什麼要這樣做：弱模型在設計時會把已被否決的方案當成「選用」或「之後再說」列進去，文字上看起來有出入，但依然違反共識。條款與程式檢查比說明文字可靠，所以共識要寫成條款。

## 老師迴圈的程式輔助

老師（管理層）也會犯「沒有照原話核對」的錯。所以老師端有 `scripts/teacher_gate.js`，三個子指令：

1. **派工前 dispatch**：把使用者原話逐句記下來（每句一個 `--quote`），寫明共識檔與允許修改的檔案或資料夾（資料夾要以 `/` 結尾）。
   ```bash
   node skills/weak-model-harness/scripts/teacher_gate.js dispatch --task 任務名 --quote "原話一" --quote "原話二" --consensus skills/weak-model-harness/references/consensus/某共識.json --allow 某檔.md --verify "node scripts/harness-tests/portable.test.js"
   ```
   紀錄寫到目前資料夾的 `.weak-harness/dispatch/<任務>.json`。

2. **驗收時 verify**：傳入提交 hash 與報告文字檔。程式自動做五件事：(1) 用 `git diff-tree` 核對提交只動了允許的檔案；(2) 讀提交內的檔案內容跑共識檢查（不是工作目錄）；(3) 跑派工時記下的驗收指令，收集結束碼；(4) 掃描宣稱詞（「沒有出入」「一致」「已完成」「全過」等），每一句要附證據：可解析的提交 hash 或指令輸出；比較型宣稱（「一致」「沒有出入」「完全相同」）光附 hash 不算，要附比對輸出或逐條對照（句中寫「已對照」）；(5) 原話逐條對照欄，預設全部「否」，老師用 `--confirm` 檔逐條填「是」才算通過。結束碼 0 才可接受，1 不可接受，驗收單寫到 `.weak-harness/dispatch/<任務>.verdict.md`，並印在畫面上。

   ```bash
   node skills/weak-model-harness/scripts/teacher_gate.js verify --task 任務名 --hash 提交hash --report 報告.txt --confirm 對照.json
   ```

3. **驗收後 observe**：老師從觀察者角度追加一筆記錄（`--kind` 為 positive_path、branch 或 reflection，`--stage`、`--lesson`、`--evidence` 必填）。驗收單最後會提示「請補老師觀察」。

**老師守則**（寫進每次驗收的習慣，不靠記憶）：

- (a) 不接受只有文字的「沒有出入」或「一致」。要嘛有程式檢查的輸出，要嘛逐條對照使用者原話並在驗收單上填「是」。
- (b) 偏離共識也要記一筆 branch（`observe --kind branch`），並在 `path-experiences.json` 留下來源。偏離不是只靠事後修正就算了。

## 正路與觀察者並列（observer 欄位）

`references/path-experiences.json` 每筆有 `observer` 欄位：`self` 是弱模型自己的記錄（原本的 42 筆）；`teacher` 是老師（觀察者）的記錄（9 筆來自 `teacher-observations.json`，合併後保留 id 與內容；之後新的老師記錄用 `teacher_gate.js observe` 寫入，不再手動改 JSON）。`teacher-observations.json` 只當合併時的來源快照，之後以 `path-experiences.json` 為準。

規則：每個階段結束，弱模型寫自己的正路、分支與反思（`self`），老師另外寫觀察者的正路、分支與反思（`teacher`）。兩者並列才算完整經驗。開新階段前，兩種都要讀，先看正路與反思，再看有沒有相同性質的分支。

## 速度守則

弱模型做事慢，常見原因是等待方式錯誤：長間隔排程空等、逾時設得很大、每改一點就跑完整測試、真評估前沒有先乾跑、互不依賴的步驟排隊進行。證據與來源見 `DESIGN.TODO.md（原檔：path-experience）` 第 8 節。下列條款寫在 `references/consensus/speed-rules.json`，每個數字都是上限：

1. **等待間隔**：不超過 3 分鐘，等待期間要有逐步進度（進度檔或逐行輸出），不准空等。
2. **逾時**：任何逾時設定不超過預期耗時的 4 倍，且不超過 5 分鐘，除非使用者批准。
3. **測試**：開發中只跑相關測試；提交前才跑一次完整核心測試。
4. **乾跑**：真評估或真量測前，先用假資料乾跑，10 秒內完成。
5. **並行**：互不依賴的步驟並行進行；寫入同一檔案的步驟仍一次一個寫檔者（不同檔案的寫入除外）。
6. **一輪完成**：一輪內做完整個階段再回報，不為小事提早結束一輪。
7. **耗時回報**：每個步驟回報實際耗時；實際耗時超過預估 2 倍時，要說明原因。
8. **排程**：禁止設超過 5 分鐘的排程喚醒；要等的事情用可見的進度檢查。

`teacher_gate.js dispatch` 會把這些條款與上限自動附進派工紀錄。`teacher_gate.js verify` 會掃描報告與提交新增行中的超限數字（排程秒數、「N 分鐘後」、「等待 N 分鐘」、`timeout` 毫秒、`sleep` 與 `setTimeout` 的數字），列為「速度檢查」警告。警告不改變通過與否，但老師要在驗收單上回應。

## 打包

`scripts/pack.js` 只重新產生 `scripts/vendor/`，不會產生 zip。來源改了要先跑 `node scripts/pack.js`，再重新打包 `weak-model-harness.zip`（在 `skills/weak-model-harness` 底下用 PowerShell 的 Compress-Archive 把內容打包到根層，不包含 zip 本身）。
