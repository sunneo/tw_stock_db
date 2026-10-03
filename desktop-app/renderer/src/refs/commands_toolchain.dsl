# 工具鏈命令：## 名稱 | 別名 | 摘要 | 用法 ；選項行：選項 | 參數 | 說明（結尾 * 為前綴比對，說明裡的 {v} 會換成實際值）
## gcc | cc,gcc-9,gcc-10,gcc-11,gcc-12,gcc-13,gcc-14,x86_64-linux-gnu-gcc,aarch64-linux-gnu-gcc,arm-linux-gnueabihf-gcc,arm-none-eabi-gcc,aarch64-none-elf-gcc,riscv64-linux-gnu-gcc,mingw32-gcc,x86_64-w64-mingw32-gcc | GNU C 編譯器驅動程式：依序做前處理、編譯、組譯、連結；可用選項讓流程停在任一階段 | gcc [選項] 檔案... [-o 輸出]
-c |  | 只編譯與組譯成目的檔（.o），不連結
-S |  | 只編譯成組合語言（.s），不組譯
-E |  | 只做前處理（展開 #include、巨集），結果輸出到標準輸出
-o | 檔案 | 指定輸出檔名
-x | 語言 | 指定輸入檔語言而不看副檔名（c、c++、assembler、assembler-with-cpp、none）
-O0 |  | 不最佳化（預設）；編譯最快，除錯最方便
-O1 |  | 基本最佳化
-O2 |  | 常用的一般最佳化（不含以空間換時間的展開）；發行版預設選擇
-O3 |  | 積極最佳化：更多內聯、迴圈展開與向量化；程式碼可能變大
-Os |  | 為縮小程式碼而最佳化（嵌入式常用）
-Oz |  | 比 -Os 更積極縮小（clang）
-Og |  | 為除錯體驗做的最佳化（除錯建置建議）
-Ofast |  | -O3 加上不嚴格遵守標準的數學最佳化（-ffast-math）；浮點結果可能不同
-g |  | 產生除錯資訊（預設 DWARF），讓 gdb 能顯示原始碼與變數
-g0 |  | 不產生除錯資訊
-g1 |  | 最少的除錯資訊（只有回溯所需）
-g2 |  | 一般除錯資訊（與 -g 相同）
-g3 |  | 除錯資訊含巨集定義
-ggdb |  | 產生 gdb 最適用的除錯資訊格式
-gdwarf-* |  | 指定 DWARF 版本 {v}
-Wall |  | 開啟大多數有用的警告（並不是「全部」）
-Wextra |  | 開啟額外的警告（未使用參數、比較有號與無號等）
-Werror |  | 把警告當成錯誤，有警告就編譯失敗
-Werror=* |  | 只把指定警告 {v} 當成錯誤
-Wpedantic |  | 嚴格依標準給出警告
-pedantic |  | 嚴格依 ISO 標準，拒絕非標準擴充
-pedantic-errors |  | 違反標準的地方直接當成錯誤
-Wno-* |  | 關閉警告 {v}
-W* |  | 開啟警告 -W{v}（例如 -Wshadow、-Wconversion、-Wformat=2、-Wunused）
-w |  | 關閉所有警告
-std=* |  | 指定語言標準 {v}（c99、c11、c17、gnu11、c++11、c++17、c++20、gnu++17 …）
-ansi |  | 等於 -std=c90
-I* |  | 增加標頭檔搜尋路徑 {v}
-isystem | 目錄 | 增加「系統」標頭檔搜尋路徑（警告會被抑制）
-iquote | 目錄 | 只用於 #include "..." 的搜尋路徑
-idirafter | 目錄 | 搜尋路徑最後才找的目錄
-include | 檔案 | 在每個原始檔最前面強制 #include 該檔
-L* |  | 增加函式庫搜尋路徑 {v}（連結階段）
-l* |  | 連結函式庫 lib{v}.so 或 lib{v}.a（例如 -lm 數學、-lpthread 執行緒、-ldl 動態載入、-lrt 即時）
-D* |  | 定義前處理巨集 {v}（-DNAME 等於 -DNAME=1）
-U* |  | 取消定義前處理巨集 {v}
-shared |  | 產生共享函式庫（.so／.dll），通常要搭配 -fPIC
-static |  | 靜態連結：把函式庫打包進可執行檔，不依賴執行時的共享函式庫
-static-libgcc |  | 靜態連結 libgcc
-static-libstdc++ |  | 靜態連結 C++ 標準函式庫
-pie |  | 產生位置獨立執行檔（配合 ASLR）
-no-pie |  | 不產生位置獨立執行檔
-rdynamic |  | 把所有符號匯出到動態符號表（讓 dlsym、backtrace_symbols 看得到）
-pthread |  | 啟用 POSIX 執行緒：編譯與連結都需要（等於 -D_REENTRANT -lpthread）
-fopenmp |  | 啟用 OpenMP：處理 #pragma omp 並連結 libgomp
-fopenacc |  | 啟用 OpenACC
-fPIC |  | 產生位置獨立程式碼（共享函式庫必要；大型 GOT 版本）
-fpic |  | 產生位置獨立程式碼（小型 GOT 版本）
-fPIE |  | 產生位置獨立的可執行檔程式碼
-fno-* |  | 關閉功能 -f{v}（例如 -fno-builtin、-fno-exceptions、-fno-rtti、-fno-omit-frame-pointer）
-fsanitize=* |  | 啟用執行期檢查工具：{v}（address 記憶體錯誤、undefined 未定義行為、thread 資料競爭、leak 洩漏）
-fstack-protector |  | 為有陣列的函式加堆疊保護（Canary）
-fstack-protector-strong |  | 更廣泛地加堆疊保護
-fstack-protector-all |  | 為所有函式加堆疊保護
-fvisibility=* |  | 預設符號可見度 {v}（hidden 讓共享函式庫預設不匯出）
-ffunction-sections |  | 每個函式放自己的段，讓連結器能搭配 --gc-sections 移除未使用的函式
-fdata-sections |  | 每個資料物件放自己的段
-flto |  | 連結時最佳化：跨檔案內聯與最佳化（編譯與連結都要加）
-fno-omit-frame-pointer |  | 保留框架指標，讓除錯與效能分析的回溯更準
-fomit-frame-pointer |  | 省略框架指標（-O1 以上預設）
-fno-strict-aliasing |  | 不假設嚴格別名規則（舊程式碼與核心常用）
-ffreestanding |  | 獨立環境：不假設有標準函式庫（核心、啟動碼、韌體）
-fno-builtin |  | 不把 memcpy、printf 等當成內建函式特別處理
-fcommon |  | 未初始化的全域變數放 common 區（GCC 10 起預設是 -fno-common）
-funroll-loops |  | 展開迴圈
-ffast-math |  | 放寬浮點規則以換取速度（不保證 IEEE 精確）
-fno-exceptions |  | 不支援 C++ 例外
-fno-rtti |  | 不產生 C++ 執行期型別資訊
-fprofile-generate |  | 產生剖析資料用的偵測程式碼（PGO 第一步）
-fprofile-use |  | 使用剖析資料最佳化（PGO 第二步）
-fverbose-asm |  | 組合語言輸出附上註解
-fdiagnostics-color=* |  | 診斷訊息上色：{v}
-fmax-errors=* |  | 最多報 {v} 個錯誤就停止
-m32 |  | 產生 32 位元程式碼（x86）
-m64 |  | 產生 64 位元程式碼（x86）
-mthumb |  | 產生 Thumb 指令集程式碼（ARM，較省空間）
-marm |  | 產生 ARM 指令集程式碼
-march=* |  | 指定目標指令集架構 {v}（例如 x86-64、native 為本機、armv7-a、armv8-a+crypto、rv64gc）
-mtune=* |  | 針對特定處理器調校排程 {v}（不改變可使用的指令）
-mcpu=* |  | 指定目標處理器 {v}（ARM：cortex-a53、cortex-m4 等；同時決定 -march 與 -mtune）
-mfpu=* |  | 指定 ARM 浮點單元 {v}（neon、vfpv4 …）
-mfloat-abi=* |  | ARM 浮點呼叫慣例 {v}（soft 軟體浮點、softfp、hard 硬體浮點暫存器傳參）
-mabi=* |  | 指定 ABI {v}（RISC-V：lp64d、ilp32 等）
-msse4.2 |  | 允許使用 SSE4.2 指令
-mavx |  | 允許使用 AVX 指令
-mavx2 |  | 允許使用 AVX2 指令
-mfma |  | 允許使用 FMA（融合乘加）指令
-mno-* |  | 關閉機器相關功能 -m{v}
-m* |  | 機器相關選項 -m{v}（依目標架構而異）
-pipe |  | 用管線取代暫存檔在各階段傳遞資料
-v |  | 顯示詳細的編譯過程（呼叫了哪些子程式、搜尋路徑）
--version |  | 顯示版本
-dumpmachine |  | 印出目標機器三元組（例如 x86_64-linux-gnu、arm-none-eabi）
-dumpversion |  | 印出編譯器版本
-print-search-dirs |  | 印出編譯器搜尋路徑
-print-file-name=* |  | 印出函式庫 {v} 的完整路徑
-save-temps |  | 保留中間檔（.i、.s、.o）
-M |  | 輸出相依規則（Makefile 格式）並停在前處理
-MM |  | 同 -M 但略過系統標頭
-MD |  | 編譯同時輸出 .d 相依檔（含系統標頭）
-MMD |  | 編譯同時輸出 .d 相依檔（不含系統標頭）；Makefile 增量編譯常用
-MP |  | 為每個標頭加一條空目標，避免標頭被刪除時 make 報錯
-MF | 檔案 | 指定相依檔輸出位置
-MT | 目標 | 指定相依規則的目標名稱
-Wl,* |  | 把逗號分隔的選項 {v} 傳給連結器（例如 -Wl,--gc-sections、-Wl,-rpath,/path、-Wl,-Map=out.map）
-Wa,* |  | 把選項 {v} 傳給組譯器
-Wp,* |  | 把選項 {v} 傳給前處理器
-Xlinker | 選項 | 把一個選項原樣傳給連結器
-Xassembler | 選項 | 把一個選項原樣傳給組譯器
-T | 腳本 | 使用指定的連結器腳本（嵌入式、核心常用）
-nostdlib |  | 不連結標準函式庫與啟動檔
-nostartfiles |  | 不連結標準啟動檔（crt0）
-nodefaultlibs |  | 不連結預設函式庫
-nostdinc |  | 不搜尋標準系統標頭目錄
-specs=* |  | 使用規格檔 {v}（例如 -specs=nosys.specs、nano.specs，嵌入式 newlib 常用）
--sysroot=* |  | 以 {v} 為根目錄搜尋標頭與函式庫（交叉編譯）
-B* |  | 增加編譯器子程式與資料檔的搜尋前綴 {v}
-pg |  | 產生 gprof 剖析用的程式碼
--coverage |  | 產生程式碼覆蓋率資訊（gcov），等於 -fprofile-arcs -ftest-coverage 並連結 gcov
-r |  | 產生可重定位的目的檔（部分連結）
-s |  | 連結後移除符號表（縮小檔案）
-z | 關鍵字 | 傳給連結器的 -z 選項（例如 noexecstack、relro、now）
-Q |  | 顯示每個函式編譯時的統計
-H |  | 顯示每個被引入的標頭
-trigraphs |  | 支援三字元序列
-C |  | 前處理時保留註解
-P |  | 前處理時不產生 #line 標記
-undef |  | 不預先定義系統特定的巨集
-fno-common |  | 未初始化全域變數不放 common 區（重複定義會連結失敗）
## g++ | c++,g++-9,g++-10,g++-11,g++-12,g++-13,g++-14,x86_64-linux-gnu-g++,aarch64-linux-gnu-g++,arm-linux-gnueabihf-g++,arm-none-eabi-g++ | GNU C++ 編譯器驅動程式：用法與 gcc 相同，但預設以 C++ 編譯 .c 以外的來源，並自動連結 libstdc++ | g++ [選項] 檔案... [-o 輸出]
@inherit gcc
-stdlib=* |  | 指定 C++ 標準函式庫 {v}（clang：libc++ 或 libstdc++）
-fexceptions |  | 啟用 C++ 例外（預設）
-frtti |  | 啟用執行期型別資訊（預設）
-fcoroutines |  | 啟用 C++20 協程
-fmodules-ts |  | 啟用 C++20 模組（實驗性）
-Weffc++ |  | 警告違反 Effective C++ 準則的寫法
-Woverloaded-virtual |  | 警告隱藏了基底類別虛擬函式的多載
-fconcepts |  | 啟用 C++ concepts（舊版 GCC）
-D_GLIBCXX_DEBUG |  | 啟用 libstdc++ 偵錯模式（容器越界檢查；巨集，用 -D 定義）
## javac | javac.exe | Java 編譯器：把 .java 原始碼編譯成 .class 位元組碼 | javac [選項] 原始檔...
-d | 目錄 | 指定 .class 輸出目錄（會依套件建立子資料夾）
-cp | 路徑 | 類別搜尋路徑（資料夾與 jar，分隔字元 Linux 用 : ，Windows 用 ;）
-classpath | 路徑 | 同 -cp
--class-path | 路徑 | 同 -cp
-sourcepath | 路徑 | 原始碼搜尋路徑
--source-path | 路徑 | 同 -sourcepath
-encoding | 編碼 | 原始檔編碼（例如 UTF-8）；編碼不對會出現亂碼或「unmappable character」
-source | 版本 | 原始碼相容的語言版本
-target | 版本 | 產生適用該 JVM 版本的位元組碼
--release | 版本 | 同時指定 source、target 並使用對應版本的標準函式庫 API（建議取代 -source/-target）
-g |  | 產生全部除錯資訊
-g:* |  | 指定除錯資訊 {v}（none、lines、vars、source）
-nowarn |  | 關閉警告
-Xlint |  | 啟用所有建議的警告
-Xlint:* |  | 啟用特定警告 {v}（unchecked、deprecation、rawtypes …）
-Werror |  | 警告當錯誤
-deprecation |  | 顯示已棄用 API 的細節
-verbose |  | 顯示編譯器正在做什麼
-processor | 類別 | 指定註解處理器
-processorpath | 路徑 | 註解處理器的搜尋路徑
-proc:* |  | 註解處理方式 {v}（none 不處理、only 只處理）
-parameters |  | 在 .class 保留方法參數名稱（反射、Spring 等用）
-p | 路徑 | 模組路徑（Java 9+）
--module-path | 路徑 | 模組路徑
--add-modules | 模組 | 額外加入的模組
--add-exports | 設定 | 把模組內的套件匯出給其他模組
--enable-preview |  | 啟用預覽語言功能
-version |  | 顯示版本
-J* |  | 把選項 {v} 傳給底層 JVM（例如 -J-Xmx2g）
-h | 目錄 | 產生 JNI 原生標頭檔（.h）的輸出目錄
-s | 目錄 | 指定產生的原始檔輸出目錄
-XDrawDiagnostics |  | 以原始格式輸出診斷（測試用）
## java | java.exe | Java 虛擬機：執行 .class、jar 或單一原始檔 | java [選項] 主類別|-jar 檔案.jar [引數...]
-jar | 檔案 | 執行 jar（主類別由 MANIFEST.MF 的 Main-Class 指定）
-cp | 路徑 | 類別搜尋路徑
-classpath | 路徑 | 同 -cp
--class-path | 路徑 | 同 -cp
-D* |  | 設定系統屬性 {v}（key=value），程式用 System.getProperty 讀取
-Xmx* |  | 設定堆積上限為 {v}（例如 -Xmx2g）
-Xms* |  | 設定初始堆積大小為 {v}
-Xss* |  | 設定每個執行緒堆疊大小為 {v}
-XX:* |  | 進階 JVM 選項 {v}（例如 +UseG1GC、MaxMetaspaceSize=256m、+HeapDumpOnOutOfMemoryError）
-verbose:* |  | 輸出詳細資訊 {v}（class 載入類別、gc 垃圾回收）
-ea |  | 啟用 assert 斷言
-enableassertions |  | 啟用 assert 斷言
-da |  | 停用 assert 斷言
-agentlib:* |  | 載入原生代理程式 {v}（例如 jdwp 遠端除錯）
-agentpath:* |  | 以路徑載入原生代理程式 {v}
-javaagent:* |  | 載入 Java 代理程式 {v}（位元組碼插樁）
-server |  | 使用 Server VM（現今預設）
-version |  | 印出版本後結束
--version |  | 印出版本後結束
-p | 路徑 | 模組路徑
--module-path | 路徑 | 模組路徑
-m | 模組/主類別 | 執行模組中的主類別
--add-modules | 模組 | 額外加入的模組
--add-opens | 設定 | 開放模組內部套件給反射使用（Java 9+ 常見的「Illegal reflective access」解法）
--enable-preview |  | 啟用預覽功能
-Dfile.encoding=* |  | 指定預設字元編碼 {v}
-Djava.library.path=* |  | 指定 JNI 原生函式庫搜尋路徑 {v}
-Xdebug |  | 啟用除錯（舊式）
-Xrunjdwp:* |  | 舊式遠端除錯設定 {v}
-Xshare:* |  | 類別資料共享 {v}
-Xint |  | 只用直譯器（不 JIT）
-Xcomp |  | 強制先編譯
-XX:+HeapDumpOnOutOfMemoryError |  | 發生 OutOfMemoryError 時傾印堆積到檔案
-XX:+UseG1GC |  | 使用 G1 垃圾回收器
-XX:+UseZGC |  | 使用 ZGC 低延遲垃圾回收器
## python | python3,python2,python.exe,py,python3.8,python3.9,python3.10,python3.11,python3.12,python3.13 | Python 直譯器：執行腳本、模組或互動模式 | python [選項] [-c 指令 | -m 模組 | 檔案 | -] [引數...]
-c | 程式碼 | 執行一段字串形式的程式碼
-m | 模組 | 以模組方式執行（例如 -m venv、-m pip、-m http.server、-m unittest、-m pytest、-m json.tool）
-i |  | 執行完腳本後進入互動模式
-u |  | 不緩衝標準輸出與錯誤（日誌即時輸出，管線與容器常用）
-O |  | 最佳化：移除 assert 與 __debug__ 程式碼
-OO |  | 再移除 docstring
-B |  | 不寫 .pyc 位元組碼檔
-E |  | 忽略 PYTHON* 環境變數
-I |  | 隔離模式：忽略環境變數與使用者站台目錄
-s |  | 不加入使用者站台目錄
-S |  | 不匯入 site 模組
-W | 動作 | 控制警告（例如 -W error 把警告當錯誤、-W ignore）
-X | 選項 | 實作特定選項（例如 -X utf8、-X dev、-X importtime、-X faulthandler）
-q |  | 互動模式不印版本與版權
-v |  | 詳細輸出（顯示每次匯入）
-V |  | 印出版本後結束
--version |  | 印出版本後結束
-h |  | 顯示說明
-b |  | 對 bytes 與 str 混用發出警告
-d |  | 除錯解析器
-x |  | 跳過第一行（非 Unix 的 #! 用）
-P |  | 不把腳本所在目錄或目前目錄放進 sys.path（3.11+）
-R |  | 啟用雜湊隨機化
## node | nodejs,node.exe | Node.js：用 V8 引擎在伺服端執行 JavaScript | node [選項] [腳本.js | -e 程式碼] [引數...]
-e | 程式碼 | 執行一段字串形式的 JavaScript
--eval | 程式碼 | 同 -e
-p | 程式碼 | 執行並印出結果
--print | 程式碼 | 同 -p
-r | 模組 | 啟動前預先載入模組（例如 -r ts-node/register、-r dotenv/config）
--require | 模組 | 同 -r
--import | 模組 | 預先載入 ES 模組
-i |  | 互動模式（REPL）
--inspect |  | 開啟除錯器（預設 127.0.0.1:9229），讓 Chrome DevTools 或 VS Code 連線
--inspect-brk |  | 開啟除錯器並在第一行暫停
--inspect-brk=* |  | 開啟除錯器於 {v} 並在第一行暫停
--inspect=* |  | 開啟除錯器於 {v}
--max-old-space-size=* |  | 老年代堆積上限 {v} MB（處理大資料或 OOM 時調高）
--max-semi-space-size=* |  | 新生代半空間大小 {v} MB
--stack-size=* |  | V8 堆疊大小 {v}
--expose-gc |  | 提供全域 gc() 函式
--trace-warnings |  | 警告時印出堆疊
--trace-deprecation |  | 棄用警告時印出堆疊
--no-deprecation |  | 不顯示棄用警告
--throw-deprecation |  | 棄用警告改丟出例外
--unhandled-rejections=* |  | 未處理的 Promise 拒絕的行為 {v}（strict、warn、throw）
--experimental-modules |  | 啟用實驗性 ES 模組（舊版）
--experimental-vm-modules |  | 啟用 vm 模組的 ESM 支援（Jest 的 ESM 常用）
--experimental-* |  | 啟用實驗功能 {v}
--enable-source-maps |  | 錯誤堆疊使用 source map
--watch |  | 檔案變動時自動重新執行
--env-file=* |  | 從 {v} 載入環境變數檔
--test |  | 執行內建測試執行器
--check |  | 只檢查語法
-c |  | 只檢查語法（--check）
--version |  | 印出版本
-v |  | 印出版本
--use-strict |  | 強制嚴格模式
--title=* |  | 設定行程標題 {v}
--preserve-symlinks |  | 解析模組時保留符號連結
--conditions=* |  | 自訂條件匯出 {v}
--cpu-prof |  | 輸出 CPU 剖析檔
--heap-prof |  | 輸出堆積剖析檔
--prof |  | 輸出 V8 剖析記錄
--openssl-legacy-provider |  | 啟用 OpenSSL 舊提供者（舊版 webpack 在 Node 17+ 出現 ERR_OSSL_EVP_UNSUPPORTED 時的臨時解法）
## gdb | gdb.exe,gdb-multiarch,arm-none-eabi-gdb,aarch64-linux-gnu-gdb | GNU 除錯器：載入程式、設中斷點、單步、檢視記憶體與暫存器，也可遠端連到 gdbserver 或 QEMU | gdb [選項] [程式 [核心檔|行程ID]]
--args |  | 之後的內容是要除錯的程式與它的命令列引數（gdb --args ./a.out -x 1）
-q |  | 不顯示啟動版權訊息
-quiet |  | 不顯示啟動版權訊息
-nx |  | 不讀取任何 .gdbinit 初始化檔
-x | 檔案 | 執行指定檔案中的 gdb 命令
-ex | 命令 | 執行一條 gdb 命令（可重複）
-iex | 命令 | 在載入檔案之前執行一條命令
-batch |  | 批次模式：執行完命令就結束（腳本化、CI）
-p | 行程ID | 附加到執行中的行程
-pid | 行程ID | 附加到執行中的行程
-c | 核心檔 | 使用核心傾印檔（core dump）進行事後除錯
-core | 核心檔 | 同 -c
-d | 目錄 | 加入原始碼搜尋目錄
-cd | 目錄 | 以指定目錄為工作目錄
-s | 檔案 | 從檔案讀取符號
-e | 檔案 | 使用檔案作為可執行檔
-tui |  | 啟動文字介面分割視窗（原始碼＋命令）
-w |  | 使用圖形介面（如果有）
-readnow |  | 一開始就讀完所有符號（啟動慢、之後快）
-b | 速率 | 設定序列埠傳輸速率
-l | 逾時 | 設定遠端除錯逾時（秒）
-ix | 檔案 | 在載入檔案前執行命令檔
--version |  | 顯示版本
-v |  | 顯示版本
--configuration |  | 顯示編譯組態
-return-child-result |  | 結束時使用被除錯程式的退出碼
-silent |  | 不顯示啟動訊息
-dbx |  | 模擬 dbx 指令風格
--eval-command=* |  | 同 -ex：執行命令 {v}
--command=* |  | 同 -x：執行檔案 {v}
--pid=* |  | 附加行程 {v}
--core=* |  | 使用核心檔 {v}
--directory=* |  | 加入原始碼目錄 {v}
--tty=* |  | 被除錯程式的輸出使用終端機 {v}
@list commands
run | 啟動被除錯的程式（r）；可帶引數，例如 run -v input.txt
start | 在 main 暫停地啟動程式
starti | 在第一條指令暫停地啟動（看啟動碼、核心、韌體時用）
continue | 繼續執行到下一個中斷點（c）
next | 單步執行一行，不進入函式（n）
step | 單步執行一行，會進入函式（s）
nexti | 單步執行一條機器指令，不進入呼叫（ni）
stepi | 單步執行一條機器指令（si）
finish | 執行到目前函式返回，並顯示回傳值
until | 繼續執行到比目前行更大的行（跳出迴圈）
advance | 執行到指定位置
return | 立即從目前函式返回（可指定回傳值）
jump | 從指定位置繼續執行
break | 設中斷點（b）：break 函式／break 檔案:行／break *位址／break 位置 if 條件
tbreak | 設一次性中斷點
rbreak | 對符合正則表示式的所有函式設中斷點
watch | 設監看點：變數被寫入時暫停
rwatch | 變數被讀取時暫停
awatch | 變數被讀或寫時暫停
catch | 設攔截點（系統呼叫 syscall、訊號 signal、例外 throw／catch、載入 load、fork、exec）
delete | 刪除中斷點／顯示表達式
disable | 停用中斷點
enable | 啟用中斷點
condition | 為中斷點設定條件
ignore | 忽略中斷點的前 N 次命中
commands | 為中斷點設定命中時自動執行的命令
info | 顯示資訊：info breakpoints／registers／locals／args／frame／threads／sharedlibrary／signals／proc／files／line／symbol
backtrace | 顯示呼叫堆疊（bt）；bt full 連同區域變數
frame | 選擇堆疊框（f 編號）
up | 往上一層呼叫者
down | 往下一層
print | 顯示表達式的值（p）：p var、p *ptr、p arr[0]@10 顯示 10 個元素、p/x 以十六進位
x | 檢視記憶體：x/NFU 位址（N 數量、F 格式 x d u o t a c f s i、U 單位 b h w g）；例如 x/16xb $sp、x/8i $pc 看反組譯
display | 每次暫停都自動顯示的表達式
undisplay | 取消自動顯示
output | 只輸出值，不加編號與換行
set | 設定變數或選項：set var x=1、set args、set listsize、set disassembly-flavor intel、set confirm off、set pagination off
show | 顯示 gdb 設定
list | 顯示原始碼（l）
disassemble | 反組譯函式或範圍（disas）；disassemble /s 夾雜原始碼，/r 顯示機器碼
ptype | 顯示型別的完整定義
whatis | 顯示表達式的型別
file | 載入要除錯的執行檔與符號
symbol-file | 載入符號檔
add-symbol-file | 在指定位址載入額外符號（動態載入模組、核心模組）
core-file | 載入核心傾印
attach | 附加到執行中的行程
detach | 與行程分離，讓它繼續跑
kill | 結束被除錯的程式
quit | 離開 gdb（q）
target | 指定除錯目標：target remote host:port 連到 gdbserver 或 QEMU 的 gdb stub；target extended-remote
monitor | 傳送命令給遠端目標（例如 QEMU 的 monitor：monitor info registers）
load | 把程式載入到遠端目標（嵌入式燒錄）
thread | 切換或顯示執行緒
inferior | 管理被除錯行程
signal | 以指定訊號繼續執行
handle | 設定 gdb 如何處理訊號（handle SIGUSR1 nostop noprint pass）
source | 執行命令檔
define | 定義自己的命令
python | 執行嵌入的 Python 腳本（擴充 gdb）
tui | 切換文字介面：tui enable／layout src／layout asm／layout regs
layout | 設定文字介面版面（src、asm、split、regs）
refresh | 重新整理文字介面
checkpoint | 建立行程檢查點（可回到該狀態）
record | 開始記錄執行以便反向除錯：reverse-step／reverse-continue／reverse-next
reverse-continue | 反向繼續執行
reverse-step | 反向單步
set follow-fork-mode | fork 後要追蹤 parent 或 child
set detach-on-fork | fork 後是否放開另一邊
set scheduler-locking | 單步時是否鎖定其他執行緒
set print pretty | 結構以易讀格式顯示
set breakpoint pending | 找不到位置時是否仍建立待定中斷點
info registers | 顯示通用暫存器；info registers rip 顯示指定暫存器；info all-registers 含浮點與向量
info frame | 顯示目前堆疊框細節（返回位址、儲存的暫存器）
info sharedlibrary | 顯示已載入的共享函式庫
info threads | 列出所有執行緒
info proc mappings | 顯示行程記憶體映射（讀 /proc/PID/maps）
info line | 顯示原始碼行對應的位址
info symbol | 顯示位址所屬的符號
info signals | 顯示訊號處理設定
info locals | 顯示目前函式的區域變數
info args | 顯示目前函式的引數
info breakpoints | 列出所有中斷點與監看點
