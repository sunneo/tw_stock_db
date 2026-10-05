# 參考知識（Reference Knowledge）設計文件

> 2026-10-04。原始碼：`renderer/src/refs/`（`ref_engine.js` 查詢引擎、`*.dsl` 資料來源、`generic_builtin.json`）、`scripts/refs-dsl.js`（DSL 轉資料）、`scripts/promote-runtime-defs.js`（把執行期補的定義升級成內建）；嵌入 `floating-assistant.js` 的 `FA_REF_DATA`／`FaRef`（`scripts/embed-code-ui.js` 的 `embedRefs`）。主機端 `_ref*` 方法、工具與斜線指令見第 6 節。
> 相關：`DESIGN.offline-trainer.md`（離線路由與領域）、`DESIGN.behavior-analyzer.md`（行為說明如何使用這份知識）、`DESIGN.offline-trainer-roadmap.md`（隨使用成長、日誌診斷、離線文字生成與推理鏈的路線圖）。

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

## 11. 日誌診斷（建置錯誤、gdb、核心日誌、kernel panic、journal；2026-10-04）

目標：離線訓練器看到一段失敗的輸出，能**明確說明發生了什麼事**——不只是翻譯一行錯誤，而是指出根本原因、哪些只是連帶結果、錯誤是怎麼一層層傳上來的。路線圖見 `DESIGN.offline-trainer-roadmap.md`。

### 11.1 規則格式（`buildrules*.dsl`）

```
## 規則id | 系統 | 層級
re: 逐行比對的正規表示式（不分大小寫，可用具名群組 (?<名稱>…)；同名群組可以在不同分支重複）
start: / span: （選填，多行規則才用，見下）
what: 發生什麼事（白話；{名稱} 填入擷取到的值）
cause: 常見原因（可重複）
fix: 怎麼處理（可重複）
```

- 層級：`root`＝根本原因；`cascade`＝連帶結果（例如 make 的「Error 1」、ld 的「returned 1 exit status」、BitBake 的「Task failed」、CMake 的「Configuring incomplete」）；`warn`＝警告。層級後面加 `!` 表示整份日誌只報第一次（panic 結論、BitBake 任務失敗這類會重複出現的行）。比對到的行若是 `WARNING:`／`NOTE:`／`warning:` 開頭，根本原因類會自動降成警告。
- 具名群組叫 `errno` 時，數字會自動附上 Linux 錯誤碼的意義（例如驅動訊息 `probe failed with error -517` → `EPROBE_DEFER`）。
- 系統名只是篩選用：`any` 一律比對；`gcc`、`make`、`maven`、`cargo`… 只在偵測到該系統時比對（避免 `error: …` 這類通用字樣在別的日誌誤觸發）。
- 規則檔：`buildrules_compile.dsl`（gcc／ld）、`buildrules_make_cmake.dsl`（make、ninja、Meson、CMake、autotools、Kbuild）、`buildrules_bitbake.dsl`（BitBake／Yocto）、`buildrules_kernel_journal.dsl`（核心日誌、panic、journal、gdb、執行期）、`buildrules_other.dsl`（Maven、Gradle、npm、Cargo、pip、Go）；`buildrules_promoted.dsl` 放升級進來的規則（同 id 取代內建）。約 200 條。

### 11.2 診斷引擎（`FaRef.diagnoseLog`，`diagnoseBuild` 是別名）

1. 清理（去 ANSI 色碼、BitBake 子行程輸出的「| 」前綴）並**偵測系統**（make、cmake、bitbake、ninja、meson、gcc、ld、maven、gradle、npm、cargo、python、autotools、kbuild、kernel、panic、journal、gdb、runtime、java、go）。
2. 抽出**脈絡**：BitBake 的配方與任務與失敗日誌路徑、make 失敗的目標（檔案:行、退出碼）、ninja 的 FAILED 步驟、CMake 出錯的檔案行與指令、編譯器錯誤的檔案行欄。
3. 逐行套用規則；相同說明不重複報。
4. 整理輸出：`summary`（一段話）、`chain`（傳遞路徑，例如「原始錯誤（gcc）→ make 的目標 foo.o 的命令失敗，退出碼 1 → BitBake：配方 bar 的 do_compile 失敗」）、`root_causes`（附原因與處理）、`consequences`、`warnings`、`context`、`unmatched_error_lines`、`markdown`。
5. 退出碼會被解釋：127＝找不到命令、126＝不能執行、139＝程式當掉、137＝被殺掉（常是記憶體不足）。
6. 找不到根本原因時**明說**：「只看到連帶結果，要往上找第一個 error」，不亂猜。

### 11.3 涵蓋範圍（規則）

- **編譯／連結**：缺標頭、未宣告、隱式宣告（GCC 14 起變錯誤）、型別不符、重複定義、-Werror、編譯器內部錯誤與被 OOM 殺掉、不認得的選項、-march 不符、需要更新的語言標準、不完整型別、組譯錯誤；undefined reference（缺 -l、順序、C／C++ 混用）、vtable、multiple definition（-fno-common）、找不到函式庫與 crt 檔、需要 -fPIC、架構不符、DSO 缺失、記憶體區域溢位（嵌入式）、無 main、輸出檔無權限、連結器被殺掉、GLIBC 版本、LTO。
- **make／ninja／Meson／CMake／autotools／Kbuild**：No rule to make target、missing separator、遞迴變數、命令找不到、時鐘偏差、jobserver；CMake 找不到套件／編譯器／建置程式、版本太舊（含 CMake 4 的相容性移除）、快取位置不符、目標重複或不存在、來源不存在、install 錯誤；configure 找不到編譯器或套件、autotools 工具缺失；核心 modpost 未定義符號、設定過期、缺主機開發套件。
- **BitBake／Yocto**：Nothing PROVIDES、無法建置的相依鏈、配方被跳過、多個 provider、下載失敗與雜湊不符、git 取得失敗、補丁套用失敗、解壓失敗、do_configure／do_compile／do_install 失敗、QA 問題（installed-vs-shipped、ldflags、textrel、already-stripped、file-rdeps、dev-so、license-checksum、arch、buildpaths、useless-rpaths）、rootfs 安裝與檔案衝突、解析錯誤與變數展開、繼承 class 失敗、layer 相容性、環境檢查、磁碟空間、taskhash、Python 函式錯誤、伺服器、禁網路、記憶體不足。
- **核心與系統**：panic（找不到根檔案系統、init 死掉並解碼 exitcode、找不到 init、沒有主控台）、Oops（空指標、paging request、BUG、WARN、ARM 內部錯誤）、KASAN、lockdep、soft lockup、hung task、RCU stall、OOM、使用者程式 segfault（解讀錯誤位元）、磁碟與檔案系統錯誤、韌體缺失、模組載入、驅動 probe 失敗（附錯誤碼意義，-517 是延後不是失敗）、裝置樹、USB、網路、SD／I2C、硬體錯誤、記憶體破壞、refcount。
- **systemd／journal**：2xx 狀態碼（203/EXEC、217/USER、226/NAMESPACE…）、主行程退出方式、失敗結果類型、start-limit-hit、依賴失敗、單元不存在、逾時、sshd 登入失敗、SELinux avc 與 AppArmor 拒絕。
- **gdb**：收到訊號、Cannot access memory、找不到符號、位址隨機化警告、遠端連線中斷、架構不符（'g' packet reply too long）、無法插入中斷點、缺除錯符號、ptrace 被拒、沒有執行中的程式、auto-load 被拒。
- **執行期**：缺共享函式庫、Exec format error、Illegal instruction、位址已被使用。
- **其他建置系統**：Maven、Gradle、npm／node-gyp、Cargo、pip、Go。

### 11.4 工具與入口

- 工具 `diagnose_log{log}`；`explain_build_error{log}` 是別名（專給建置輸出）；斜線指令 `/ref diag <日誌>`。
- 離線路由：`core_rules` 的 `ref_log_diag`（日誌裡有 `make: ***`、`CMake Error`、`undefined reference to`、`Kernel panic`、`Call Trace:`、`Program received signal`、`Failed with result` 等特徵）加功能清冊 `ref-log-diagnose`。已在真實 Electron 驗證：貼上 make 錯誤行、kernel panic 行、systemd 狀態行、`Nothing PROVIDES`、`undefined reference` 都走到診斷工具。

### 11.5 成長機制

- **待學習清單**：每次診斷，沒有規則的錯誤行會被正規化（數字、路徑、十六進位換成佔位符）後去重、計次，存在 `localStorage['fa_ref_unmatched_v1']`（最多 200 筆，依次數排序）。查看：`/ref queue` 或 `ref_define{action:"queue"}`；清空：`queue_clear`。
- **補規則**：`ref_define{kind:"build_error_rule", id, system, level, re, what, cause, fix, example, source}`。**必須附 `example`（一行真實日誌）**，系統用它驗證規則真的比對得到；正規表示式要能編譯；沒有 `source` 不收。通過後保存，並把清單中對應的行移除。已在真實 Electron 驗證四種情況：沒有範例被拒、範例對不上被拒、無效的正規表示式被拒、正確的規則被收下並立刻生效（補完後原本沒規則的那行就被診斷了）。
- **AI 擴充領域**（`offline_knowledge_expander`）的提示已加「先看待學習清單」與規則的寫法與驗證要求。
- **升級成內建**：`/ref export` 的 `references.buildrules_dsl` 就是 `buildrules*.dsl` 的格式；`scripts/promote-runtime-defs.js` 以「整條規則」為單位合併進 `buildrules_promoted.dsl`（同 id 取代、檢查正規表示式可編譯），之後人或 Claude 覆核。

### 11.6 已知限制

- 規則是**逐行**比對，看不懂跨多行的結構（完整的 Call Trace、Python 例外鏈、CMake 的多行區塊）；多行規則在路線圖的下一步。
- 通用意義，不含你專案裡的特殊情況。
- 偵測「沒有規則的錯誤行」靠關鍵字（error、failed、fatal、denied…），沒有這些字樣的異常行不會進待學習清單。
- **多行規則**（Python Traceback、核心 Call Trace、CMake 多行錯誤、gcc 的 In file included from 包含鏈；規則檔 `buildrules_multiline.dsl`）：多兩個欄位 `start:`（觸發行的正規表示式，逐行比對）與 `span:`（區塊範圍），此時 `re:` 改成對「整個區塊」比對（`.` 可跨行、`^`／`$` 指行首行尾）。`span` 寫法：`indent`（接著的縮排行）、`indent+1`（再多收一行，Python 結尾的例外那行）、`lines N`、`until 正規表示式`（含該行）、`blank`。區塊內所有行都算「已比對」，不會再出現在待學習清單。`ref_define` 的 `build_error_rule` 也可以帶 `start`、`span`，`example` 可以是多行文字。Python Traceback 取最內層的 File 與例外類型；Call Trace 略過 dump_stack 等噪音與帶 ? 的不確定項目，指出事發函式。
- 規則量約 200 條，覆蓋最常見的情況，不是全部；新型態的錯誤要靠待學習清單與 AI 擴充逐步補。

## 12. 已知限制

- 命令選項是「重點選項」，不是 man 手冊的全文；沒收錄的選項會列在「還不認得的選項」，可請 AI 補。
- 引擎不執行任何命令，只解釋文字；展開 shell 變數、管線、`$(…)` 不處理（只取第一個命令）。
- 錯誤碼是通用意義，不含特定驅動或產品自訂的碼；Windows 的錯誤碼只收常見的幾百個中的一部分。
- OpenMP 子句解釋只做文字層級，不驗證子句組合是否合法。
- `ref_expand` 依賴線上模型與瀏覽器／網頁抓取工具；沒有網路時只能補使用者貼給它的文件。AI 補的資料品質取決於來源，所以每筆都要附來源並在升級成內建前人工覆核。
- 分詞規則（`tokenizer`）目前只能用 `FaRef.tokenize` 或查詢取得，還沒有接進行為分析去解析新語言；文法樣式、建置系統等通用知識則是可查詢的參考資料，不會自動改變解析結果。
