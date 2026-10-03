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

## 10. 定義資料（pattern／語意表）的設計

### 10.1 兩份資料、三個層次

| 檔案 | 內容 | 用在哪 |
|---|---|---|
| `renderer/src/behavior/behavior_patterns.json` | 行為分類（47 類）× 語言的呼叫名稱表；`assembly_instruction_sets`（各指令集的助記符→分類→一句說明）；`assembly_idioms`（多指令組合）；`control_flow_nodes`、`structural_signals`、well-known 路徑／環境變數 | 掃描器歸類、組語／位元組碼／IR 文字的指令歸類、idiom 辨識 |
| `renderer/src/behavior/api_semantics.json` | 函式 → 一句摘要、每個位置引數的真實意義、回傳值各範圍的意義 | 逐行追蹤敘事（「引數 buf=… 是接收資料的緩衝區」「n <= 0 ＝ 對方關閉連線」） |
| 使用者／AI 補的定義（`fa_behavior_user_defs_v1`，`behavior_define`） | 同樣的結構，保存在本機 | 與內建合併，優先於內建；可匯出匯入 |

三個層次的合併順序：內建 → 使用者補的（同名者蓋掉內建）。分析引擎只認合併後的結果，所以任何來源補進來的定義立刻生效。

### 10.2 來源與規模（誠實記錄）

- **Domain Resolver 的 `behavior_patterns.yml`／`api_semantics.yml`**：完整匯入，逐項比對過沒有遺漏（呼叫名稱 1628、助記符 x86 118／x64 105／ARM 88／AArch64 87／POWER 55／MIPS 55／RISC-V 82／PTX 24／JVM 102、idiom 12 條、API 語意 C 21 個＋JavaScript 25 個）。這份參考資料本身規模不大，**沒有** LLVM IR、WASM、Python 位元組碼，也沒有 POSIX／WinAPI 的引數語意。
- **本專案依需求自行補寫的部分**（以使用者的需求為主，參考資料只是起點）：
  - x86／x64：約 450／440 個助記符（含 SSE／AVX／AVX-512、BMI、AES、SHA、TSX、系統與虛擬化指令）。
  - PTX 174、JVM 位元組碼 202（完整 opcode）、LLVM IR 116（含常用 intrinsic）、WASM 218、Python 位元組碼 139。
  - 函式名稱：POSIX／libc、pthread、WinAPI（行程、記憶體、登錄檔、服務、Winsock、WinINet／WinHTTP、加密、COM、視窗、Native API）、OpenGL／Vulkan／WebGL／WebGPU、CUDA／OpenCL／HIP、GLSL／HLSL 內建、Java 標準函式庫、Python／Node，合計約 4200 個。
  - API 語意：C 340 個（POSIX＋WinAPI）、JavaScript 38、Python 35、Java 17。
- 這些是依官方文件知識整理，**沒有逐條對照官方文件**；有錯用 `behavior_define`（`add_api`／`add_note`／`remove`）修正即可，不必改程式。

### 10.3 格式與擴充

- 助記符表：`assembly_instruction_sets.<架構>.<分類>[] = { name, format, description }`。名稱比對不分大小寫，且會逐段退回（`ld.global.f32` → `ld.global` → `ld`），所以 PTX、WASM 這類帶點的助記符不必列出所有變體。
- 架構鍵：`x86`、`x86_64`、`arm`、`aarch64`、`power`、`mips`、`riscv`、`ptx`、`jvm`、`llvm`、`wasm`、`pybc`（Python 位元組碼）。文字格式的組語／IR／位元組碼會拿全部架構的表比對；idiom 只在該架構有命中時才辨識。
- API 語意：`api.<語言>.<函式名稱> = { summary, parameters:[{name, meaning}], return:{ meaning, rules:[{when:{op,value}, meaning}] } }`；`op` 可用 `< <= > >= == !=`。回傳規則會跟著「緊接在呼叫之後的條件」套用；指標回傳的 NULL 視為 `== 0`。
- 大量匯入：`behavior_define` 的 `import` 直接吃 Domain Resolver 格式的 YAML／JSON（也吃匯出檔）。使用者自己的大量定義用這條路進來。
- 改了內建 JSON 之後：`node scripts/embed-code-ui.js`（把資料嵌進 `FA_BEHAVIOR_DATA`）→ `node build-assistant.js`。

### 10.4 已知缺口

- ARM／AArch64／POWER／MIPS／RISC-V 仍只有參考資料的 55 到 88 個助記符。
- Java 函式只有 17 個有引數語意，其餘只有分類名稱。
- 沒有 C++ 標準函式庫（STL）、Rust、Go 的名稱表。
- 語意文字用英文原句（沿用 Domain Resolver 的句型），尚未中文化。

## 11. 參考知識的標註與擴充定義（2026-10-04）

- 行為說明現在會用**離線訓練器的參考知識**（`FaRef`，見 `DESIGN.reference-knowledge.md`）：逐行追蹤的每一行若有錯誤碼常數（`ENOMEM`、`ERROR_ACCESS_DENIED`、`STATUS_ACCESS_VIOLATION`）、`exit(139)`、`errno == EACCES`、字串裡的命令（`system("qemu-system-arm …")`），會在敘事裡多一個 `Notes:`；`#pragma`（OpenMP、OpenACC、GCC）會附在緊接的迴圈上，函式內另有可折疊的「編譯指示」區塊。AI／使用者用 `ref_define` 補的資料同樣立刻生效。
- 函式語意擴充：OpenMP 執行期、MPI（MPICH／MVAPICH2／Open MPI）、BLAS／CBLAS／LAPACK、cuBLAS、cuDNN、CUDA 執行期與驅動 API、Linux 核心標頭函式（約 800 個，加上先前 POSIX／WinAPI，C 共約 1100 個）有摘要、引數意義、回傳值各範圍的意義。
- 引擎調整：成功碼常數表（`MPI_SUCCESS`、`cudaSuccess`、`CUBLAS_STATUS_SUCCESS`、`NULL`、`EOF`…→ 整數）讓 `rc != MPI_SUCCESS` 能套用規則；指標條件（`!p`、`if (p)`）可以套用以 `== 0`／`!= 0` 寫的規則；C 系語言的檔頭註解不再把 `#include`／`#pragma` 當成註解。
- 使用者補定義新增 `add_mnemonic`（`arch`、`category`、`name`、`description`）：補組合語言指令，`makeTaxonomy` 合併進指令集表。
- AI 自主擴充領域 `aidoc_knowledge_expander`：用 `explain_code` 找出還不認得的呼叫，查官方資料，用 `behavior_define`／`ref_define` 補定義（每筆附來源），再驗證。執行期補的定義可 `/ref export` 匯出，用 `scripts/promote-runtime-defs.js` 升級成內建。
