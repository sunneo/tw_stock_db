# 多行規則：一個訊息分散在好幾行（Python Traceback、核心 Call Trace、CMake 多行錯誤、gcc 的標頭包含鏈）
# 欄位：start: 觸發行（逐行比對，不分大小寫）；span: 區塊範圍；re: 對「整個區塊」比對（不分大小寫，. 可以跨行，^ 與 $ 指行首行尾）
#   span 寫法：indent（接著的縮排行）／indent+1（再多收一行，例如 Python 結尾的例外那行）／lines N／until 正規表示式（含該行）／blank（到空白行前）
#   具名群組與一般規則一樣，what／cause／fix 可用 {名稱}
## py-traceback | any | root
start: ^Traceback \(most recent call last\):
span: indent+1
re: (?:.*File "(?<file>[^"]+)", line (?<ln>\d+), in (?<fn>[^\n]+)\n(?:[^\n]*\n)*?)?(?<exc>[A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|NotFound)\b):?[ ]?(?<msg>[^\n]*)(?![\s\S])
what: Python 程式丟出未處理的例外 {exc}：{msg}。出錯的地方在最底下那個（最內層）呼叫：{file} 第 {ln} 行，函式 {fn}；Traceback 由上往下是呼叫順序，最後一個 File 才是例外發生的地方。
cause: 例外沒有被 try／except 接住，Python 印出 Traceback 後結束
cause: 最內層的 File 若在 site-packages 或標準函式庫，通常是呼叫它的那一層（往上一個 File）傳錯東西
fix: 先看最底下的例外類型與訊息，再看最內層屬於自己程式碼的那個 File 與行號
fix: 要看完整原因鏈：留意「During handling of the above exception」與「The above exception was the direct cause」兩種串接，最上面那個才是最早發生的
fix: 用 python -X dev 或 faulthandler 可得到更多資訊
## py-traceback-chained | any | cascade!
start: ^(?:During handling of the above exception, another exception occurred|The above exception was the direct cause of the following exception):
span: lines 1
re: ^(?<how>During handling of the above exception|The above exception was the direct cause of the following exception)
what: 這是例外串接：前一個例外（Traceback 較上面那個）才是最早的原因，後面這個是處理它的時候又出錯，或是程式刻意用 raise … from … 包起來的。
cause: except 區塊裡的程式碼又丟了例外，或程式用 raise X from Y 轉換例外類型
fix: 往上找第一個 Traceback，那才是根本原因；後面的 Traceback 只是結果
## py-syntax-error-block | any | root
start: ^\s+File "[^"]+", line \d+\s*$
span: lines 5
re: File "(?<file>[^"]+)", line (?<ln>\d+)\s*\n(?<code>[^\n]*)\n(?:[ ]*[\^~]+[^\n]*\n)?(?<exc>SyntaxError|IndentationError|TabError): (?<msg>[^\n]+)
what: Python 語法錯誤（{exc}）：{msg}。位置 {file} 第 {ln} 行，那一行是「{code}」，^ 標記的是 Python 看不懂的地方（實際錯誤常在標記處的前一個符號或前一行）。
cause: 括號／引號沒有成對、冒號漏掉、縮排不一致（空白與 Tab 混用）、用了新版才有的語法（例如 match、:=、f-string 巢狀引號）
fix: 看標記的前一行：常是上一行少了右括號或逗號
fix: 縮排問題用編輯器顯示空白字元，統一用 4 個空白
fix: 確認 python --version 夠新，新語法在舊版會報語法錯誤
## kernel-call-trace | any | cascade!
start: Call Trace:
span: lines 30
re: Call Trace:[^\n]*(?:\n[^\n]*?)*?\n(?:[^\n]*?\]\s+|\s+)(?!\?)(?!(?:dump_stack\w*|dump_backtrace\w*|show_stack|__warn|warn_slowpath\w*|report_bug|handle_bug|bug_handler|die|die_kernel_fault|__die|exc_invalid_op|asm_\w+|do_trap\w*|el[01][a-z0-9_]*|do_mem_abort|do_translation_fault|__do_kernel_fault|__might_sleep|__schedule_bug)\+)(?<top>[A-Za-z_]\w*)\+0x[0-9a-f]+/0x[0-9a-f]+
what: 核心呼叫堆疊（Call Trace）：最上面真正有意義的函式是 {top}，也就是出事的地方；往下看是誰呼叫它。排除了 dump_stack、__warn 這類只是印堆疊的函式，也略過前面帶 ? 的不確定項目。
cause: 堆疊最上方（靠近 Call Trace: 這行）的函式是事發點，最下方是進入核心的入口（系統呼叫、中斷、工作佇列）
fix: 用 addr2line -e vmlinux 或 scripts/faddr2line vmlinux {top}+0x… 對回原始碼行
fix: 同時看堆疊上方的 BUG／Oops／WARNING 行與 RIP，它們說明是什麼錯；堆疊說明是誰呼叫
## cmake-error-block | cmake | root
start: ^CMake Error at \S+:\d+ \(\w+\):
span: indent
re: CMake Error at (?<f>[^:\s]+):(?<ln>\d+) \((?<cmd>\w+)\):\s*\n\s+(?<msg>[^\n]+)(?:\n\s+(?<more>[^\n]+))?
what: CMake 在 {f} 第 {ln} 行執行 {cmd}() 時出錯：{msg} {more}
cause: {cmd} 是 CMakeLists.txt 裡的命令，錯誤訊息在後面縮排的幾行
fix: 打開 {f} 第 {ln} 行看 {cmd}() 的參數；訊息裡提到的套件、變數或檔案要先備齊
fix: 完整原因通常在這個區塊的後面幾行（例如「Add the installation prefix of … to CMAKE_PREFIX_PATH」）
## gcc-include-chain | gcc | root
start: ^In file included from
span: until :\d+(?::\d+)?: (?:fatal )?(?:error|warning|note):
re: In file included from (?<inc>[^:,\n]+):(?<incln>\d+).*?(?<f>[^\s:]+):(?<ln>\d+)(?::\d+)?: (?:fatal )?error: (?<msg>[^\n]+)
what: 編譯錯誤發生在被包含的標頭檔 {f} 第 {ln} 行：{msg}；它是從 {inc} 第 {incln} 行 #include 進來的（「In file included from」那一串是包含鏈，由外到內）。
cause: 標頭檔本身有錯，或包含它的順序／前置宣告不對（缺少前面該先 include 的標頭、巨集沒定義）
fix: 先修標頭檔 {f} 第 {ln} 行；若標頭檔是系統或第三方的，多半是自己這邊缺了該先 include 的檔案或沒定義必要巨集
fix: 看包含鏈裡你自己的檔案（{inc}），調整 #include 的順序
## py-exc-filenotfound | python | root!
re: FileNotFoundError: \[Errno 2\] No such file or directory: ['"](?<p>[^'"]+)['"]
what: Python 找不到檔案或資料夾 {p}。
cause: 路徑寫錯、相對路徑依賴工作目錄（用 python 執行的目錄不是你以為的那個）、檔案還沒產生
fix: 印出 os.getcwd() 與 os.path.abspath 看實際找的位置；改用以 __file__ 為基準的路徑
## py-exc-keyerror | python | root!
re: ^KeyError: (?<k>[^\n]+)
what: 字典沒有鍵 {k}。
cause: 資料欄位名稱拼錯或大小寫不同、輸入資料缺欄位、上一步沒把值放進去
fix: 用 d.get(鍵, 預設值) 或先檢查 鍵 in d；印出 d.keys() 看實際有哪些
## py-exc-nonetype | python | root!
re: AttributeError: '?NoneType'? object has no attribute '(?<attr>[^']+)'
what: 對 None 取屬性 {attr}：前面某個函式回傳了 None（沒找到或沒有 return）。
cause: re.match／dict.get／find 找不到時回傳 None；函式忘了 return；原地修改的方法（list.sort）回傳 None
fix: 往上看是哪個值是 None，使用前先判斷 if x is None
## py-exc-import-name | python | root!
re: ImportError: cannot import name ['"](?<n>[^'"]+)['"] from ['"]?(?<mod>[^'"\s(]+)
what: 從 {mod} 匯入不到 {n}。
cause: 該版本沒有這個名稱（版本太舊或太新）、名稱拼錯、循環匯入（兩個模組互相 import）
fix: pip show 看套件版本，對照文件；循環匯入把 import 挪到函式內或拆出共用模組
## py-exc-recursion | python | root!
re: RecursionError: maximum recursion depth exceeded
what: 遞迴太深，超過 Python 的遞迴上限（預設約 1000 層）。
cause: 遞迴沒有結束條件或結束條件寫錯、資料量真的很大
fix: 先檢查結束條件；資料量大改成迴圈或明確的堆疊；不得已才用 sys.setrecursionlimit
## py-exc-unicode | python | root!
re: Unicode(?<dir>Decode|Encode)Error: '(?<codec>[^']+)' codec can't (?:decode|encode) (?:byte|character) [^\n]*
what: 文字編碼不符（{dir}）：用 {codec} 處理不了資料。
cause: 檔案其實不是 {codec} 編碼（常見是 Big5／CP950／UTF-16），或 Windows 預設編碼不是 UTF-8
fix: open(…, encoding="utf-8") 明確指定；不確定時用 chardet 偵測，或 errors="replace" 先看內容
## java-stacktrace | java | root
start: ^(?:Exception in thread "[^"]*" )?[\w$]+(?:\.[\w$]+)*(?:Exception|Error|Throwable)(?::|$)
span: indent 120 or ^(?:Caused by|Suppressed):
re: ^(?:Exception in thread "(?<thr>[^"]*)" )?(?<exc>[\w$.]+)(?:: (?<msg>[^\n]*))?(?:\n[^\n]*)*?\n\s+at (?<top>[^\n(]+)\((?<where>[^)\n]*)\)(?:[\s\S]*\nCaused by: (?<cause>[\w$.]+)(?:: (?<cmsg>[^\n]*))?)?
what: Java 例外 {exc}：{msg}（執行緒 {thr}）。堆疊最上面（事發的地方）是 {top}（{where}）；有「Caused by」串接時，最後一個才是根本原因：{cause} {cmsg}。
cause: 堆疊由上往下是呼叫順序的反向：第一個 at 是丟出例外的地方，越下面越是呼叫它的上層
cause: Caused by 是被包起來的原因，一路往下看到最後一個，那才是最早發生的錯
fix: 先看例外類型與訊息；再找堆疊裡第一個屬於你自己的套件（不是 java.／javax.／框架）的 at 行，那是要改的地方
fix: 「… N more」是省略掉跟上一段相同的堆疊，不是錯誤
## java-exc-npe | java | root!
re: java\.lang\.NullPointerException(?:: (?<msg>[^\n]*))?
what: 對 null 呼叫方法或取欄位（NullPointerException）：{msg}
cause: 物件沒有初始化、方法回傳 null 沒檢查、集合裡有 null 元素
fix: Java 14 以上的訊息會直接寫出哪個變數是 null（Cannot invoke "X" because "Y" is null），看 Y；往上追它是在哪裡被賦值的
## java-exc-classnotfound | java | root!
re: java\.lang\.(?<k>ClassNotFoundException|NoClassDefFoundError)(?:: (?<cls>[\w$./]+))?
what: 執行期找不到類別 {cls}（{k}）。
cause: classpath 缺少含這個類別的 jar；編譯時有、執行時沒有（依賴範圍 provided／compileOnly）；版本衝突或類別在初始化時失敗過
fix: 確認 jar 在 -cp／classpath 或打包進去；NoClassDefFoundError 常是靜態初始化失敗，往上找第一個 ExceptionInInitializerError
## java-exc-nosuchmethod | java | root!
re: java\.lang\.(?<k>NoSuchMethodError|NoSuchFieldError|AbstractMethodError|IncompatibleClassChangeError)(?:: (?<m>[^\n]*))?
what: 執行期對不上方法或欄位（{k}）：{m}
cause: 編譯用的函式庫版本跟執行用的不同；依賴衝突（同一個函式庫兩個版本）
fix: mvn dependency:tree／gradle dependencies 找重複的版本，統一版本；清掉舊的編譯產物重編
## java-exc-oom | java | root!
re: java\.lang\.OutOfMemoryError: (?<k>[^\n]*)
what: Java 記憶體不足：{k}。
cause: Java heap space＝堆積不夠或洩漏；Metaspace＝類別太多；unable to create native thread＝執行緒數量或系統限制；GC overhead limit exceeded＝一直在垃圾回收卻回收不了
fix: 加大 -Xmx；用 -XX:+HeapDumpOnOutOfMemoryError 取堆積傾印分析洩漏；native thread 看 ulimit -u 與執行緒是否失控
## java-exc-stackoverflow | java | root!
re: java\.lang\.StackOverflowError
what: Java 遞迴太深，堆疊爆了（StackOverflowError）。
cause: 遞迴沒有結束條件、兩個物件互相呼叫 toString／equals／hashCode、循環引用被序列化
fix: 看堆疊裡重複出現的那幾個方法；真的需要深遞迴可加 -Xss，但多半是邏輯問題
## rust-error-block | cargo | root
start: ^error(?:\[E\d{4}\])?:
span: indent 30 or ^\s*\d+ \|
re: ^error(?:\[(?<code>E\d{4})\])?: (?<msg>[^\n]*)\n\s*--> (?<f>[^:\n]+):(?<ln>\d+):(?<col>\d+)(?:[\s\S]*\n\s*= (?<kind>help|note): (?<help>[^\n]*))?
what: Rust 編譯錯誤{code}：{msg}。位置 {f} 第 {ln} 行第 {col} 欄。{kind} {help}
cause: 錯誤下面的 | 區塊是出錯的程式碼，^^^ 標出範圍，後面的文字是編譯器的說明
fix: 有 E 開頭的錯誤碼時，執行 rustc --explain E0xxx 看完整說明與範例
fix: 先修第一個錯誤，後面的常是連帶出現的
## rust-panic | cargo | root
start: ^thread '[^']*' panicked at
span: lines 40
re: thread '(?<thr>[^']*)' panicked at (?:'(?<msg1>[^']*)', )?(?<f>[^:\n]+):(?<ln>\d+):(?<col>\d+):?(?:\n(?<msg2>[^\n]*))?(?:[\s\S]*?\n\s*\d+: (?<fn>[^\n]+)\n\s+at (?<uf>(?!/rustc/|/root/\.cargo|/home/[^/\n]+/\.cargo|[^\n]*\.cargo/registry)[^\n]+))?
what: Rust 程式 panic（執行緒 {thr}）：{msg1}{msg2}。panic 的位置 {f}:{ln}:{col}；backtrace 裡第一個屬於你自己程式碼的呼叫：{fn}（{uf}）。
cause: 常見：unwrap()／expect() 碰到 None／Err、陣列索引越界、整數溢位（debug 模式）、除以零、RefCell 重複借用
fix: 設 RUST_BACKTRACE=1（更詳細用 full）看完整堆疊；到 panic 位置那行看是哪個 unwrap／索引
fix: 把 unwrap() 換成明確的錯誤處理（? 或 match），或用 expect("說明") 讓訊息更清楚
## arm32-backtrace | kernel | cascade!
start: ^(?:\[[^\]]*\]\s*)?Backtrace:
span: lines 30
re: Backtrace:[\s\S]*?\(\s*(?!(?:dump_backtrace|show_stack|dump_stack|__dump_stack|dump_stack_lvl|__warn|warn_slowpath\w*|report_bug|die|__die|do_DataAbort|do_PrefetchAbort|__dabt_svc|__und_svc|__irq_svc|__pabt_svc)\b)(?<top>[A-Za-z_]\w*)(?:\+0x[0-9a-f]+/0x[0-9a-f]+)?\s*\)
what: ARM 32 位元核心的回溯（Backtrace）：每行的格式是「[<位址>] (被呼叫的函式) from [<位址>] (呼叫它的函式)」，由內往外讀。排除 dump_backtrace、show_stack 這類只是印堆疊的函式後，最裡面的是 {top}。
cause: 括號裡的 函式+0x偏移/0x函式大小 就是出事的指令位置；__dabt_svc／__und_svc 是例外入口，代表這裡是資料中止或未定義指令
fix: 用 arm-linux-gnueabihf-addr2line -e vmlinux 位址，或 scripts/faddr2line vmlinux {top}+0x偏移 對回原始碼行
fix: 同時看前面的 Unable to handle kernel…、PC is at、LR is at，它們說明是什麼錯與出事的指令
## arm-pc-lr-at | kernel | root!
start: (?:^|\s)PC is at \S+\+0x
span: lines 3
re: (?:^|\s)PC is at (?<pc>[\w.]+)\+0x(?<pcoff>[0-9a-f]+)/0x(?<pcsize>[0-9a-f]+)(?:[\s\S]*?LR is at (?<lr>[\w.]+)\+0x)?
what: 出事的指令在 {pc}+0x{pcoff}（函式大小 0x{pcsize}），它是被 {lr} 呼叫的（PC 是程式計數器，LR 是返回位址）。
cause: PC is at 是當機當下執行到的位置；LR is at 是呼叫者
fix: 用 addr2line 或 faddr2line vmlinux {pc}+0x{pcoff} 對回原始碼行
## arm64-pc-lr | kernel | cascade!
start: (?:^|\s)pc : \S+\+0x
span: lines 3
re: pc : (?<pc>[\w.]+)\+0x(?<pcoff>[0-9a-f]+)/0x[0-9a-f]+(?:[^\n]*\n[^\n]*?\blr : (?<lr>[\w.]+)\+0x[0-9a-f]+/0x[0-9a-f]+)?
what: ARM 64 位元核心當機當下：pc 在 {pc}+0x{pcoff}（出事的指令），lr 是 {lr}（呼叫它的函式）。
cause: pc 是程式計數器、lr 是返回位址；後面的 sp、x0…x29 是暫存器內容，x0 常是第一個參數，可以看是不是 0 或亂碼
fix: 用 aarch64-linux-gnu-addr2line 或 scripts/faddr2line vmlinux {pc}+0x{pcoff} 對回原始碼行
fix: 同時看 Internal error: Oops 那行的 ESR（出事原因碼）與 Call trace:
## arm64-esr | kernel | root!
re: ESR = (?<esr>0x[0-9a-f]+)
what: ARM 64 位元例外症狀暫存器 ESR = {esr}：最前面幾個位元（EC）說明例外種類，例如 0x25 是核心資料中止、0x21 是核心指令中止、0x15 是系統呼叫、0x00 是未知。
cause: 資料中止通常是存取了不存在或沒有權限的位址（空指標、釋放後使用）；指令中止是跳到不能執行的位址
fix: 同一段訊息裡的 Unable to handle kernel … at virtual address 與 FAR 是被存取的位址；位址接近 0 通常是空指標
