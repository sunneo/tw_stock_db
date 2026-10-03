# 參考知識（Reference Knowledge）設計文件

> 2026-10-04。原始碼：`renderer/src/refs/`（`ref_engine.js` 查詢引擎、`*.dsl` 資料來源、`generic_builtin.json`）、`scripts/refs-dsl.js`（DSL 轉資料）、`scripts/promote-runtime-defs.js`（把執行期補的定義升級成內建）；嵌入 `floating-assistant.js` 的 `FA_REF_DATA`／`FaRef`（`scripts/embed-code-ui.js` 的 `embedRefs`）。主機端 `_ref*` 方法、工具與斜線指令見第 6 節。
> 相關：`DESIGN.offline-trainer.md`（離線路由與領域）、`DESIGN.behavior-analyzer.md`（行為說明如何使用這份知識）。

## 1. 要解決的事

1. **離線訓練器要能「讀懂」東西**：不只會做事，遇到錯誤碼、命令列、`#pragma` 也要能解釋。沒有 AI 時，這些問題直接由離線工具回答。
2. **同一份知識要同時用在程式行為說明**：行為說明遇到 `errno == EACCES`、`exit(139)`、`system("qemu-system-arm …")`、`#pragma omp parallel for` 時，要標註它的意思。離線訓練器與 AIDoc／行為分析共用同一份資料，不各維護一份。
3. **AI 可以自己找資料擴充**：範圍包括文法樣式、語意、分詞、組合語言、建置系統；補的每一筆都有來源、可驗證。
4. **執行期擴充的資料，將來可以交給 Claude 或其他 AI 協助升級成內建**：格式與內建來源檔相同，有現成的合併腳本。

## 2. 內建內容（2026-10-04）

| 類別 | 內容 | 規模 |
|---|---|---|
| Linux 錯誤 | errno（1 到 133 常用，含常見處理）、POSIX 訊號、shell 退出碼（126、127、128+N…） | 76／22／13 |
| Windows 錯誤 | Win32 錯誤碼（GetLastError）、HRESULT（含解碼：嚴重度、facility、代碼；`0x8007xxxx` 對回 Win32）、NTSTATUS（0xC0000005 等，也吃帶號整數 -1073741819）、Winsock | 88／52／61／32 |
| 命令與手冊 | gcc、g++、javac、java、python、node、gdb（選項與互動命令）、qemu-system-arm／aarch64／x86_64（含 x64 別名）、mpirun／mpicc、nvcc、nvidia-smi、compute-sanitizer、cuda-gdb、ncu、nsys、Slurm、以及約 70 個 Linux 常用命令（man 手冊重點） | 93 個命令，約 1400 個不重複的選項 |
| qemu | 選項、`-drive`／`-device`／`-netdev`／`-chardev`／`-machine`／`-serial`／`-append`（核心命令列）／`-display`／`-smp` 子選項、機型清單（arm 約 50、aarch64 13、x86 8）、CPU 清單 | 見 DSL |
| pragma | OpenMP（parallel、for、sections、task、target、teams、distribute、simd、atomic、critical…）、OpenACC、GCC／clang（pack、once、diagnostic、optimize、unroll、ivdep…） | 84 條指令、59 個子句 |
| 函式語意 | OpenMP 執行期、MPI（MPICH、MVAPICH2、Open MPI 共用的標準介面）、BLAS／CBLAS／LAPACK、cuBLAS、cuDNN、CUDA 執行期、CUDA 驅動、Linux 核心標頭函式（kmalloc、copy_to_user、request_irq、mutex、RCU、workqueue、platform／pci／i2c／spi／usb／netdev…）。每個函式有摘要、引數意義、回傳值各範圍的意義 | 約 800 個函式（加上先前的 POSIX／WinAPI，C 共約 1100 個） |
| 通用知識 | OpenMP／MVAPICH2／MPICH 環境變數、CUDA 執行模型、MPI 通訊語意、建置系統（make、CMake、Meson／Ninja、Bazel、Gradle／Maven、Kbuild、Cargo／npm／pip）、ARM／ARM64／x86-64／RISC-V 呼叫約定、C 回呼與 goto 錯誤處理樣式 | 17 筆 |

誠實說明：這些是依官方文件的知識整理，**沒有逐條對照官方文件**；錯誤碼的白話說明是整理過的，不是原文翻譯。有錯用 `ref_define` 修正（同 key 覆蓋）。

## 3. 資料來源格式（DSL）

純文字、`#` 開頭是註解、欄位用「 | 」分隔，好編輯、好 diff。`scripts/refs-dsl.js` 轉成物件。

- `errors*.dsl`：`@區段`（`linux_errno`／`win32`／`hresult`／`ntstatus`／`winsock`／`signal`／`exit`），每行 `代碼 | 名稱 | 原文訊息 | 白話說明`。
- `commands*.dsl`：`## 名稱 | 別名,… | 摘要 | 用法` 開一個命令；之後每行 `選項 | 參數 | 說明`。選項結尾 `*` 是前綴比對（`-O*`、`-l*`、`-fsanitize=*`），說明裡的 `{v}` 會換成實際值；沒有 `-` 開頭的選項（`restart`、`aux`、`install`）當作子命令。`@sub 名稱` 開子選項表（qemu 的 `-drive` 的 `file`、`if`…；`@type:xxx` 是第一段的類型，如 `-device virtio-blk-device`）；`@list 名稱` 開清單（機型、CPU、gdb 命令）；`@inherit 命令` 繼承另一個命令的選項、子選項與清單（可跨檔案：`mpicc` 繼承 `gcc`、`cuda-gdb` 繼承 `gdb`）。同名命令出現在多個檔案時**合併**（所以升級成內建的追加檔不會蓋掉原本的）。
- `pragmas*.dsl`：`@pragma` 每行 `指令 | 說明`；`@clause` 每行 `子句 | 說明`（`{v}` 是括號內的值）。
- `generic*.json`：`[{kind, key, text, tags, rules?, src}]`，放不屬於上面幾種的知識（語意、文法樣式、分詞規則、組合語言慣例、建置系統）。

檔名規則：`errors*.dsl`、`commands*.dsl`、`pragmas*.dsl`、`generic*.json` 都會被讀進來，新增檔案不用改程式。

## 4. 查詢引擎（FaRef）

純函式，不碰 DOM、不碰儲存；使用者定義由主機用 `setUser` 餵進去。

- `lookupError(查詢, {system})`：吃名稱（`EACCES`、`-ENOMEM`）、數字（`13`）、十六進位（`0x80070005`）、帶號整數（`-1073741819` 轉成 `0xC0000005`）、關鍵字（`connection refused`）。語境詞會縮小範圍（`errno` 只查 Linux errno、`GetLastError` 只查 Win32／Winsock、`exit code` 只查退出碼與訊號、`HRESULT`／`NTSTATUS`）。查不到的 HRESULT 會解碼（嚴重度、facility、代碼；facility 7 回推 Win32 錯誤）。
- `explainCommandLine(命令列)`：切字（引號、跳脫）、去掉 `sudo` 與環境變數前綴、認出命令（含別名與路徑、`.exe`），逐項解釋；合併短選項（`tar -xzvf`、`ls -la`）、`--opt=值`、前綴型（`-O2`、`-lm`）、子命令。qemu 另外產生**整體說明**（模擬什麼架構、機型、CPU、核心數、記憶體、直接載入的核心與命令列、儲存、網路、序列埠、是否開 GDB），gcc 另外說明停在哪個階段與最佳化等級。
- `lookupCommand(名稱, 選項)`：查命令或單一選項；gdb 的互動命令（`x`、`break`、`backtrace`…）用同一介面。
- `explainPragma(文字)`：找最長符合的指令，再解釋子句（`reduction(+:sum)`、`schedule(static)`、`num_threads(4)`、`collapse(2)`）。
- `annotateText(文字, 語言)`：給行為分析用——找出錯誤碼常數、`exit(N)`、`errno == X` 的比較、字串裡的命令（`system`／`popen`／`exec*`／`subprocess`／`CreateProcess` 的第一個字串引數）。
- `lookup(查詢)`：總入口，依內容分派（pragma、命令列、命令、錯誤碼、使用者補的通用知識，最後才做選項關鍵字搜尋）。
- `tokenize(規則, 文字)`：用 AI 補的分詞規則切字（`name:"skip"` 的會被略過）。
- `exportBuiltin(使用者定義)`：輸出內建來源檔的格式（第 7 節）。

## 5. 行為分析如何使用（AIDoc 的行為說明）

`_behExplainV2` 把 `FaRef` 傳進 `FaBeh2.explain(…, {ref})`：
- **逐行追蹤的每一行**會被標註：`Notes:` 之下列出該行出現的錯誤碼（`ENOMEM（12）＝記憶體不足…`）、退出碼意義（`exit(139)` ＝被 SIGSEGV 結束的慣例）、字串裡的命令（整句解釋，qemu 會講整台機器）。控制敘述只標註條件本身（括號內），不含同一行的主體，避免重複。
- **#pragma**：緊接在 pragma 下一行的迴圈或語句會帶「上一行 #pragma …：說明」，函式內另有一個「編譯指示」可折疊區塊列出每條 pragma 與子句。
- **函式語意**：OpenMP／MPI／BLAS／CUDA／核心的函式有引數與回傳值語意，回傳值條件會說成白話（`rc != MPI_SUCCESS` → 「since rc is MPI_Allreduce()'s return value: the call failed」；`!p` 接在 `kmalloc` 後 → 「allocation failed」）。為此行為引擎補了：成功碼常數表（`MPI_SUCCESS`、`cudaSuccess`、`CUBLAS_STATUS_SUCCESS`、`NULL`、`EOF`…對應整數），以及指標條件（`!p`、`if (p)`）可套用以 `== 0`／`!= 0` 寫的規則。
- 使用者／AI 用 `ref_define` 補的錯誤碼、選項、pragma 也立刻影響行為說明（引擎每次分析取目前的 `FaRef`）。

## 6. 主機端與工具

- 儲存：`localStorage['fa_ref_user_defs_v1']`（錯誤碼、命令、選項、pragma、子句、通用知識）；組語助記符與 API 語意走原本的 `fa_behavior_user_defs_v1`。
- 工具（離線可用）：`lookup_error_code{query,system?}`、`explain_command_line{command}`、`ref_lookup{query}`。
- 工具（補定義）：`ref_define`——`action:add`（預設）要給 `kind` 與 **`source`**（官方文件網址或文件名稱；使用者自己補寫 `user`；沒有來源不收，避免把猜測寫進知識庫）。kind：`error_code`、`command`、`option`、`pragma`、`clause`、`api`、`note`、`signature`、`mnemonic`、`idiom`、`semantics`、`grammar_pattern`、`tokenizer`（要給 `rules:[{name,re}]`，會驗證正規表示式）、`assembly`、`build_system`。其他 action：`list`、`remove`、`export`、`export_builtin`、`import`、`stats`。`api`／`note`／`signature`／`mnemonic`／`idiom` 轉給 `behavior_define`（新增 `add_mnemonic`：`arch`、`category`、`name`、`description`，行為引擎的 `makeTaxonomy` 會合併進指令集表）。
- 斜線指令 `/ref`：`/ref <查詢>`、`/ref cmd <命令列>`、`/ref expand <主題> [--aidoc]`、`/ref export`、`/ref stats`。

## 7. AI 自主擴充：兩個領域

兩個子代理領域（`SUBAGENT_DOMAIN_REGISTRY`），共用一組守則（`FA_EXPAND_COMMON`）：

| 領域 | 目的 | 工具 |
|---|---|---|
| `offline_knowledge_expander` | 讓離線模式讀懂更多：錯誤碼、命令與選項、pragma、API 語意、組合語言、文法 pattern、語意、分詞規則、建置系統 | ref_lookup、ref_define、lookup_error_code、explain_command_line、offline_trainer、behavior_define、explain_code、browser_search、fetch_web_page、讀檔 |
| `aidoc_knowledge_expander` | 讓行為說明越來越準：用 `explain_code` 找出「還不認得的呼叫」，讀文件補 `add_api`／`add_note`／`add_signature`／`add_mnemonic`／`add_idiom`，錯誤碼、選項、pragma 用 `ref_define` | explain_code、behavior_define、ref_lookup、ref_define、repo_map、repo_ask、repo_read_doc、讀檔、browser_search、fetch_web_page |

共同守則：先查現有（不重複補）→ 找官方文件（man7、kernel.org、Microsoft Learn、NVIDIA docs、MPICH／MVAPICH／OpenMP 規格、QEMU、GCC／GDB／Python／Node／Java 官方）→ **每筆附 source，沒查到來源就不寫** → 用 `ref_define` 寫入 → 重新驗證（查得到、說明正確）→ 回報（新增什麼、查不到什麼、來源、建議人工覆核的項目）。

入口：工具 `ref_expand{topic, domain?:"offline"|"aidoc", kind?, sources?}`（離線訓練器也會把「/ref expand …」路由到它）、斜線指令 `/ref expand <主題> [--aidoc]`，也可以 `delegate_to_subagent({domain, task})`。

## 8. 升級成內建（交給 Claude 或其他 AI 協助）

執行期補的資料有 `source`、`by`（ai／user）、`at`。流程：

1. 助理裡 `/ref export`（或 `ref_define {action:"export_builtin"}`）→ `fa-runtime-defs-日期.json`。內容：
   - `references`：`errors_dsl`、`commands_dsl`、`pragmas_dsl`（跟內建 DSL 同格式的文字）、`generic`（通用知識）；
   - `behavior`：行為分析的補充（`api`、`categories`、`mnemonics`、`idioms`、`notes`）；
   - `how_to_promote`：給接手的人或 AI 看的步驟說明。
2. 在 `desktop-app` 資料夾執行 `node scripts/promote-runtime-defs.js 匯出檔.json --dry-run` 看會新增什麼，沒問題再去掉 `--dry-run`。腳本只做「加法」：DSL 追加到 `errors_promoted.dsl`／`commands_promoted.dsl`／`pragmas_promoted.dsl`（同名命令與區段會合併、已存在的行略過），通用知識合併進 `generic_promoted.json`，行為分析補充合併進 `api_semantics.json`／`behavior_patterns.json`。可重複執行（冪等）。`notes`（函式的一句話說明）屬於使用者專案內容，不併進內建。
3. 接手的人／AI **逐筆覆核**：source 是否可信、文字是否正確（AI 補的可能有錯，錯的要改或刪）。
4. `node scripts/embed-code-ui.js`、`node build-assistant.js`，用真實環境驗證後 commit；匯出檔可一併附上當紀錄。

已在暫存目錄用真實匯出檔驗證：試跑與正式執行都正確、重跑時全部略過、合併後 `build()` 讀得到新的錯誤碼、選項與助記符。

## 9. 離線訓練器的路由

- 內建規則（`core_rules`）：`ref_error_code`（含 `errno`／`GetLastError`／`HRESULT`／`NTSTATUS`／`exit code` 的句子）、`ref_error_name`（單獨的 `EACCES`、`ERROR_*`、`STATUS_*`、`0x8…`）、`ref_command_line`（以 gcc／qemu／gdb／tar／curl…開頭的命令列）、`ref_pragma`（含 `#pragma`）。
- 功能清冊四項：`ref-error-codes`、`ref-command-explain`、`ref-lookup`、`ref-expand`，各有自己的範例語句，語意比對才會選對工具（早先用單一功能時，語意分數會讓所有查詢都選到第一個工具，所以拆開）。
- 驗證（真實 Electron，`_otRun dry_run`）：「errno 13 是什麼意思」→ `lookup_error_code`；「qemu-system-aarch64 -M virt …」與「gcc -O2 -fopenmp main.c」→ `explain_command_line`；「#pragma omp parallel for」與「gcc 的 -fPIC 是什麼」→ `ref_lookup`；「ERROR_ACCESS_DENIED」→ `lookup_error_code`；「/ref expand RISC-V 向量指令」→ `ref_expand`。

## 10. 已知限制

- 命令選項是「重點選項」，不是 man 手冊的全文；沒收錄的選項會列在「還不認得的選項」，可請 AI 補。
- 引擎不執行任何命令，只解釋文字；展開 shell 變數、管線、`$(…)` 不處理（只取第一個命令）。
- 錯誤碼是通用意義，不含特定驅動或產品自訂的碼；Windows 的錯誤碼只收常見的幾百個中的一部分。
- OpenMP 子句解釋只做文字層級，不驗證子句組合是否合法。
- `ref_expand` 依賴線上模型與瀏覽器／網頁抓取工具；沒有網路時只能補使用者貼給它的文件。AI 補的資料品質取決於來源，所以每筆都要附來源並在升級成內建前人工覆核。
- 分詞規則（`tokenizer`）目前只能用 `FaRef.tokenize` 或查詢取得，還沒有接進行為分析去解析新語言；文法樣式、建置系統等通用知識則是可查詢的參考資料，不會自動改變解析結果。
