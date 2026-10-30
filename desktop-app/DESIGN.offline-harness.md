# 離線模型的通用 harness(意圖細切 → 語意推導 → UML → CoLU 接線 → 工具呼叫)

> 為什麼:小模型整段讀一個需求會漏、會編。這條路讓**程式**把需求切成小而封閉的步驟,模型只在歧義時選一個字母。UML 細切 + CoLU 接線本來就是為了讓小模型也能處理需求(使用者回報:先前的結果約 70% 成功)。這份文件是**通用**的;`/edit-video` 是第一個接上來的領域(`DESIGN.edit-video.md`)。之後要補的 NLP 意圖推理,掛在「推理器」這個擴充點(見下)。
> 程式:`renderer/src/harness/intent_harness.js`(`FaHarness`,純函式 UMD)、`harness_host.js`(`FaHarnessHost`,混進 `FloatingAssistant.prototype`);embed 區塊 `HARNESS-BEGIN/END`。測試:`scripts/video-tests/video_semantics.test.js`(核心+領域)、`scripts/eval/video_harness.eval.js`(真 Electron)。

## 管線
```
一句需求 ─① decompose─→ 意圖們 { op, args, derived[], gaps[] }      推理器(reasoner)做;內建的是 frames
         ─② derive────→ 說法沒給、但狀態推得出的 → 參數(「後半段」「最後 10 秒」「第 3 句那一段」「沒有字幕的地方」),每個推導都記下來;推不出來 = 缺口(封閉的小問題),不猜
         ─③ toUml─────→ UML 使用案例  User -> Editor.removeSegment(start,end) -> Editor.setTransition(...)
         ─④ wiring────→ CoLU 單元目錄 catalog_bind(0 次模型呼叫):操作名稱 + 領域給單元的白話說明(中英)做檢索(有設嵌入就加語意檢索),再用型別合約打分
         ─⑤ callsOf───→ 單元的參數依「名稱」從 intent.args 填入 → 工具呼叫 [{ tool, args, by, wired }];必填缺的 = 缺口;沒接上的步驟退回該操作自己指定的工具(by:'fallback',接線品質可以量)
         ─⑥ 領域自己的檢查(例如編輯器的 applyEdits)→ 先預覽再套用
```

## 擴充點
- **領域**(`FaHarness.registerDomain`):`{ id, label, className, ops:{ opName:{ params:'a:str,b:int', ret, tool(退路) } }, unitIntents:{ toolName:'白話(中英)' }, frames:[{ name, test(子句,state), build(子句,state)→[intent] }], clauseSplit?, mergeReasoners? }`。要被接線的工具必須是單元目錄裡的 tier-1 單元(工具名稱要讓 `catalog_core.js` 的 EFFECT_RULES 認得副作用,說明裡寫「回傳 {…}」讓回傳型別推得出來)。
- **推理器**(`FaHarness.registerReasoner(domainId|'*', { id, priority, decompose(text, state, domain) → { intents, gaps?, derived? } | null })`):priority 高的先試,第一個回傳意圖的就用(領域設 `mergeReasoners` 則後面的可以補)。**NLP 意圖推理就掛在這裡**:它只要產出 `{ op, args }`(op 是領域 ops 裡的名稱),後面的 UML、接線、檢查、預覽全部沿用;內建的 frames 留在最後當退路。`removeReasoner` 可拿掉。
- **接線的單元**:不用改接線程式;新工具註冊成 agent 工具、補 EFFECT_RULES、在 `unitIntents` 寫白話。

## 目前的領域
- `video`(`renderer/src/video/video_semantics.js`):frames = 刪除(無字幕的地方、只保留、前/後 N 秒、前/後半段、中間、第 N 句那一段、第 N 個片段、A 到 B)、分割(正中間、第 N 句開始/結束處)、轉場(種類、第 N 個/全部、秒數)、辨識(範圍、每 N 秒、語言)、配音(第 N 句、範圍內的句子、全部、引號裡的字)、改字、平移、加入素材。

## 量測
`scripts/eval/video_harness.eval.js` 的 `semantic_bench` 是一組小的自寫案例(10 句)加一次接線探針(單元接上幾個、是 `retrieval+contract` 還是 `fallback`)——**案例是跟程式一起寫的,所以通過率只能當回歸檢查,不是成功率**;NLP 推理器要比較的話,請用沒看過程式的句子集。

## 還沒做
- 領域的 frames 是資料但還沒有圖形介面;使用者教的說法目前只能走離線訓練器的學回去(`_videoLearn`)。
- 語意檢索(嵌入)只在單元目錄的嵌入已設定時才加進接線;沒設就是 BM25 + 型別合約。
- 跨領域的意圖(一句話同時要改影片又要寫簡報)沒做:一個領域一條 harness。
