---
name: weak-model-harness
description: 讓小模型或弱模型（例如 claude-haiku-5.5）也能把事情做對的封閉題迴圈。程式負責路由、欄位、核對與預設退路，模型每次只回答一題封閉題（一個字母或固定欄位的 JSON）。做完還會把「程式驗證過的成功」存成經驗，回流給離線訓練器。當你（或你所在的弱模型）要處理安排會議、單位換算、問題分級、批次改檔名這類有固定欄位的任務，或要驗證弱模型在帶領下的執行品質時使用。
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

詳細整理與待辦建議見 `DESIGN.TODO.path-experience.md`。

### 共識閘門

老師每次派工，簡報都要附共識檔（`references/consensus/<名稱>.json`）：`must` 列必須出現的片語，`forbid` 列已被使用者否決或未同意的方案與片語，`allow` 列例外（例如 CDN 網址、註明禁止的句子）。Haiku 提交前自己跑一次：`node scripts/consensus_check.js references/consensus/<名稱>.json --root <專案資料夾>`；管理層驗收時也跑一次。結束碼 1 代表違反，要退回重做，不能靠記憶判斷「應該沒問題」。

為什麼要這樣做：弱模型在設計時會把已被否決的方案當成「選用」或「之後再說」列進去，文字上看起來有出入，但依然違反共識。條款與程式檢查比說明文字可靠，所以共識要寫成條款。
