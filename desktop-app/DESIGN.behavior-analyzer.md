# 程式行為分析（Behavior Analyzer）設計文件

> 來源：Domain Resolver（`D:\Downloads\SRC\DomainResolver.tar.gz`）的 `behavior_analyzer` 設計，移植成助理內建的基底能力。
> 原始碼：`renderer/src/floating-assistant.js`（`_faBeh*` 引擎、`_behExplain`／`_behDefine`、工具 `explain_code`／`behavior_define`、`/aidoc explain`）、資料 `renderer/src/behavior/*.json`（由 `scripts/embed-code-ui.js` 嵌入 `FA_BEHAVIOR_DATA`）。

## 1. 要解決的事

把原始碼、組合語言、byte code 這些「最底層的事實」，由下而上解釋成人看得懂、可折疊、**沿正向路徑**的行為說明，而且：

1. 函式、翻譯單元（檔案）自己有說明或註解，**優先使用**。
2. 函式裡的 basic block、複合區塊（if／迴圈／try／switch）有註解，**部分採用**——先做文字重排（只取跟實際呼叫最相關的句子），再掛在該區塊上，區塊可折疊。
3. aidoc 裡 AI 或使用者補的說明比自動產生的更優先。
4. 都沒有時，用「呼叫了什麼」的事實（引數／回傳值語意、行為分類、組合語言 idiom）產生敘述；不認得的就標成 unclassified，**不猜**。
5. 是基底：離線訓練器、aidoc、AI 的程式設計領域都用同一份；AI 可以從對話、RAG、aidoc 互動中補定義，越用越完整。

## 2. 分層（由下而上）

| 層 | 內容 |
|---|---|
| 最底層 | 組合語言（x86／ARM…）、LLVM IR、PTX、WASM 文字格式：以標籤切 basic block；多指令 idiom（例如 `rep stosb`＝清空記憶體）、條件跳躍用比較結果說成白話 |
| 呼叫語意 | `api_semantics`：每個已知函式的摘要、每個位置引數的真實意義、回傳值各範圍的意義（`n <= 0` 緊接在 `n = recv()` 之後 → 「recv 失敗或對方關閉連線」）；常數引數會消歧義 |
| 行為分類 | `behavior_patterns`：47 個分類（檔案 I/O、網路、行程、記憶體、並行、驅動、GPU、UEFI…）× 語言的呼叫名稱表（C 約 940 筆） |
| 區塊 | 掃描器切出語句樹：if／else／迴圈（含無限迴圈）／switch／try；guard clause（提前離開）折成旁註 |
| 函式／檔案 | 註解 → 重排 → 摘要；aidoc notes 覆蓋 |

positive path：主線只敘述正常流程；guard、例外處理、`else` 的防呆分支收進 `<details>`；無限迴圈標成「持續執行」。

## 3. 優先序（誰說了算）

函式摘要：`aidoc 說明（AI／使用者補的）` ＞ `原始碼註解（文字重排後）` ＞ `依呼叫事實自動產生`。
區塊標題：區塊上的註解（重排後最多兩句）＞ 自動產生的白話。
翻譯單元：檔案開頭的註解；aidoc 有檔案說明就補上。
呼叫的解釋：內建 api_semantics ＞ 使用者補的 note ＞ 行為分類標籤。

## 4. 支援的語言

C／C++（含 GNU 內嵌組合語言，辨識裡面的 idiom）、Java、JavaScript／TypeScript、Python（縮排）、Shell、PowerShell、Batch、GLSL／HLSL、x86／ARM 組合語言、LLVM IR、PTX、WASM 文字格式（後四種目前只有「函式切分＋呼叫＋idiom」，語意表跟 C 共用）。

## 5. 學習與擴充（讓它越來越完整）

- 工具 `explain_code`：回傳 markdown、unclassified_calls 與 `learn_hint`。
- 工具 `behavior_define`：`add_api`／`add_note`／`add_signature`／`add_idiom`／`import`／`export`／`list`／`remove`。保存在本機（`fa_behavior_user_defs_v1`），與內建合併，立即生效。
- **匯入大量定義**：`import` 直接吃 Domain Resolver 的 `behavior_patterns.yml`／`api_semantics.yml`（YAML 文字或物件）與匯出檔。使用者自己的 x86／x64 asm、PTX、JVM／Python byte code、LLVM IR、GLSL／WebGL、WASM、POSIX／WinAPI 等大量 pattern 定義，用這條路進來，不需要改程式。
- 學習來源：對話（AI 讀過原始碼確認後補）、RAG、aidoc 深入探討（`FA_DIVE_PROTOCOL` 已提示用 `explain_code` 取得事實骨架、用 `behavior_define` 補定義）。

## 6. aidoc 整合

- `/aidoc explain <檔案> [函式]`：用專案索引裡的說明與註解產生行為說明。
- 互動檢視器：檔案頁多一顆「行為說明（可折疊）」，路由 `GET /api/explain?path=&fn=`。
- 當作 top-down 定義的參考資料：說明裡的 `<details>` 結構可以直接放進百科頁面或匯出。

## 7. 離線訓練器

`explain_code`、`behavior_define` 進入功能清冊（`features/ai-features.yaml`），離線訓練器依清冊自動長出對應的語意 pattern：離線也能解釋原始碼；AI 補的定義同樣會被分析引擎用到。

## 8. 引擎版本（v2：語法樹）

- v2 是 Domain Resolver 的完整移植（`renderer/src/behavior/engine_1..5_*.js`，嵌入成 `FaBeh2`）：用 web-tree-sitter 0.20.8 的真正語法樹（C／C++、Java、Python、JavaScript／TypeScript、Shell）。第一次從 CDN 下載剖析器與語言 wasm，存進本機快取，之後離線可用。
- 包含：行為分類掃描（47 類）、api_semantics 引數／回傳值語意、逐行追蹤→複合區塊樹→由下而上的 positive-path 敘事（guard 折疊、無限迴圈＝持續行為）、區塊註解重排後掛在區塊標題、呼叫圖（含函式指標、回呼、vtable 欄位綁定）、資料流（來源→匯點的污染追蹤）、Java 設計模式、javap 位元組碼、組語／LLVM IR／PTX／WASM 文字的函式與基本區塊切分＋idiom、文字重排與摘要（相似度圖＋PageRank）。
- 剖析器載入失敗（離線第一次、CDN 擋住）時自動退回 v1 輕量掃描器，回傳裡 `engine` 標明用了哪一個、`fallback_reason` 說明原因；`explain_code` 可用 `engine:"v1"` 強制舊引擎。
- 驗證：用 Domain Resolver 範例（rdma_sim、task_queue、asm_idioms）在真實 Electron 跑過，三份都由 v2 完成。

## 9. 誠實的限制

- 巨集展開、C++ 模板、跨檔呼叫圖（目前一次分析一個檔案）沒有。
- 資料流是單一函式內的污染追蹤，不跨函式。
- `cluster_functions_by_behavior`、`teach_function_role` 還沒移植；JVM 位元組碼只讀 javap -c 的輸出、Python 位元組碼只讀 dis 輸出（以名稱與指令歸類，不重建流程）。
- 敘事句型是 api_semantics 的英文原文加中文連接詞，沒有全面中文化。
- 組合語言語意只靠 pattern 表；使用者自己的大量定義用 `behavior_define import` 匯入。
