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

## 資料放哪裡

預設在目前資料夾的 `.weak-harness/`：`session.json`（可中斷續跑）、`experience.json`、`trainer-patterns.json`、`uml-candidates.json`。用 `--dir` 換位置，`--json` 取得機器可讀輸出。範本在 `references/templates.json`，題型說明在 `references/closed-questions.md`。

## 為什麼這樣設計

小模型整段讀需求會漏、會編。這個迴圈把需求切成小而封閉的題目，程式核對每一個答案，模型只當「字母神諭」。它跟專案的離線訓練器、UML design、CoLU 是同一套思路：字母選擇題、程式檢查、程式預設退路。離線訓練器因此不只是離線備援，而是這個 harness 的學習層。
