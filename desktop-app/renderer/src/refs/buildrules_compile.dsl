# 建置錯誤規則：編譯器（gcc／g++／clang）與連結器（ld）
# 格式見 scripts/refs-dsl.js：## id | 系統 | 層級；re／what／cause／fix（cause、fix 可重複）；{名稱} 是 re 的具名群組
## gcc-header-not-found | gcc | root
re: (?<file>[^\s:]+):\d+(?::\d+)?: fatal error: (?<hdr>[^\s:]+): No such file or directory
what: 編譯 {file} 時找不到標頭檔 {hdr}。
cause: 沒有安裝提供這個標頭檔的開發套件（-dev／-devel）
cause: 沒有用 -I 指定標頭檔所在的資料夾
cause: 標頭檔名稱拼錯或大小寫不符（Linux 檔名區分大小寫）
cause: 交叉編譯時用到主機的標頭，或 sysroot 沒設好
fix: 先找哪個套件提供它（apt-file search {hdr}、dnf provides '*/{hdr}'），裝對應的 -dev 套件
fix: Makefile 的 CFLAGS 加 -I<資料夾>；CMake 用 target_include_directories
fix: Yocto／BitBake：在配方的 DEPENDS 加上提供該標頭的配方
## gcc-header-python
re: fatal error: Python\.h: No such file or directory
what: 找不到 Python.h：缺少 Python 的開發標頭，沒辦法編譯 Python C 擴充模組。
cause: 只裝了 Python 直譯器，沒裝 python3-dev（Debian／Ubuntu）或 python3-devel（Fedora）
fix: sudo apt install python3-dev（或 python3-devel）；虛擬環境要確認用的是同一版本
## gcc-undeclared
re: error: '(?<sym>[^']+)' undeclared(?: \(first use in this function\))?|error: use of undeclared identifier '(?<sym>[^']+)'|error: '(?<sym>[^']+)' was not declared in this scope
what: 使用了還沒宣告的名稱 {sym}。
cause: 忘了 #include 提供它的標頭檔
cause: 名稱拼錯，或大小寫不對
cause: 變數宣告在別的範圍（區塊）裡，用的地方看不到
cause: C++ 要加命名空間（std::）或 using
cause: 新的編譯器版本把某些標頭的間接引入拿掉了（例如 <cstdint>、<limits>）
fix: 找到它的定義補上對應的 #include；C++ 標準函式庫常見的是 <cstdint>、<cstring>、<algorithm>、<memory>
fix: 檢查拼字與命名空間
## gcc-implicit-decl
re: (?:warning|error): implicit declaration of function '(?<fn>[^']+)'
what: 呼叫了還沒宣告的函式 {fn}（C 語言）：編譯器不知道它的簽名。
cause: 沒有 include 該函式的標頭（例如 string.h、stdlib.h、unistd.h）
cause: GCC 14 起這個警告升級為錯誤（C99 以後不允許隱式宣告）
cause: 函式要啟用某個巨集才會宣告（_GNU_SOURCE、_POSIX_C_SOURCE）
fix: 補上正確的 #include；用 man {fn} 看需要哪個標頭
fix: 需要特殊巨集時在最前面 #define _GNU_SOURCE
## gcc-unknown-type
re: error: unknown type name '(?<t>[^']+)'|error: '(?<t>[^']+)' does not name a type|error: unknown type name ‘(?<t>[^’]+)’
what: 不認得型別 {t}。
cause: 缺少定義這個型別的標頭檔
cause: 標頭檔互相包含造成循環，型別在使用時還沒定義
cause: 型別名稱拼錯，C++ 少了命名空間
cause: 沒有啟用對應的語言標準（例如 bool 要 <stdbool.h> 或 C99）
fix: 補上提供型別的 #include，或用前向宣告（struct X;）打斷循環相依
fix: 檢查 -std= 是否夠新
## gcc-syntax-expected
re: error: expected (?<what>[^\n]*?) before (?:'[^']*'|\S+)|error: expected (?<what>'[^']+') (?:at end of input|before)|error: expected (?<what>[^\n,;]+) at end of input
what: 語法錯誤：這裡應該要有 {what}。
cause: 上一行少了分號、右括號或大括號（編譯器常在「下一行」才發現）
cause: 巨集展開後語法不完整
cause: 括號或引號沒有成對
fix: 看錯誤行「上面」一兩行有沒有漏掉 ; ) }
fix: 用 gcc -E 看巨集展開後的樣子
## gcc-conflicting-types
re: error: conflicting types for '(?<sym>[^']+)'
what: 函式或變數 {sym} 的宣告前後型別不一致。
cause: 標頭宣告與實作的參數或回傳型別不同
cause: 兩個標頭宣告了同名但不同型態的東西
cause: 先使用才宣告（隱式宣告成 int 回傳），後面才看到真正宣告
fix: 讓宣告與定義一致；把宣告放在被使用之前（引入正確標頭）
## gcc-redefinition
re: error: redefinition of '(?<sym>[^']+)'|error: '(?<sym>[^']+)' redeclared as different kind of symbol|error: redefinition of ‘(?<sym>[^’]+)’
what: {sym} 被定義了兩次。
cause: 標頭檔沒有 include guard（#ifndef／#pragma once），被同一個編譯單元引入兩次
cause: 在標頭檔裡定義（而不是宣告）變數或函式
cause: 兩個檔案各定義同名東西
fix: 標頭檔加 #pragma once 或 include guard；標頭裡的函式加 static inline，變數用 extern 宣告並在一個 .c 定義
## gcc-incompatible-pointer
re: (?:warning|error): (?:assignment|initialization|passing argument \d+ of '[^']+'|return) (?:from|to) (?:incompatible pointer type|makes pointer from integer|makes integer from pointer)|error: invalid conversion from '(?<from>[^']+)' to '(?<to>[^']+)'|error: cannot convert '(?<from>[^']+)' to '(?<to>[^']+)'
what: 型別不相容的轉換{from}→{to}。
cause: 指標型別不一致（char* 與 uint8_t* 等）
cause: 忘了取址（&）或解參照（*）
cause: GCC 14 起「整數與指標互轉」和「不相容指標型別」預設是錯誤，不再只是警告
fix: 確認正確的型別；必要時明確轉型，但先確認不是邏輯錯誤
## gcc-no-member
re: error: '(?<cls>[^']+)' has no member named '(?<mem>[^']+)'|error: request for member '(?<mem>[^']+)' in something not a structure or union
what: {cls} 沒有叫 {mem} 的成員。
cause: 成員名稱拼錯，或版本不同的標頭（結構定義改了）
cause: 把指標當物件用（要用 -> 而不是 .），或相反
cause: 用到的標頭版本與編譯的函式庫版本不一致
fix: 對照結構定義；指標用 ->；確認標頭與函式庫的版本一致
## gcc-no-matching-function
re: error: no matching function for call to '(?<fn>[^']+)'|error: no matching function for call to ‘(?<fn>[^’]+)’
what: C++：找不到可以接受這組引數的 {fn}。
cause: 引數型別或數量與所有多載都不符
cause: 缺少 const、參考或隱含轉換
cause: 範本推導失敗
fix: 看下面「candidate:」列出的候選與它們為什麼不符；調整引數型別
## gcc-too-many-few-args
re: error: too (?<which>many|few) arguments to function '(?<fn>[^']+)'
what: 呼叫 {fn} 時引數數量不對（{which}：many 太多、few 太少）。
cause: 函式簽名改了但呼叫端沒更新
cause: 標頭與實作版本不一致
fix: 對照函式宣告補齊或刪除引數
## gcc-werror
re: (?:cc1(?:plus)?|gcc|g\+\+): all warnings being treated as errors|error: \[-Werror=(?<w>[^\]]+)\]|error: .*\[-Werror=(?<w>[^\]]+)\]
what: 因為 -Werror，警告被當成錯誤而中止編譯（{w}）。
cause: 新版編譯器多了新的警告，舊程式碼過去沒事
cause: 建置腳本統一加了 -Werror
fix: 修正警告本身最好；暫時繞過可加 -Wno-error 或 -Wno-error={w}
fix: Yocto／autotools 可在配方設定 CFLAGS:append = ' -Wno-error'
## gcc-ice
re: internal compiler error: (?<msg>.*)
what: 編譯器本身當掉了（internal compiler error）：{msg}。
cause: 編譯器的 bug（特定程式碼觸發）
cause: 記憶體不足造成的 Segmentation fault 或被殺掉
fix: 先降低最佳化等級（-O2 改 -O1）、關掉 LTO；降低平行度（make -j1）；換編譯器版本；到編譯器的 bug 追蹤回報時附上 -save-temps 的前處理檔
## gcc-oom-killed
re: (?:g\+\+|gcc|cc1plus|cc1): fatal error: Killed signal terminated program (?<p>cc1plus|cc1)|Killed signal terminated program (?<p>cc1plus|cc1)|c\+\+: internal compiler error: Killed
what: 編譯器 {p} 被系統強制殺掉，幾乎都是記憶體用完（OOM killer）。
cause: 平行編譯（-j）太多，同時開太多個吃記憶體的編譯器
cause: 單一檔案很大（大量範本、unity build、LTO）
cause: 容器或 CI 的記憶體上限太小
fix: 降低平行度（make -j2 或 -j1）；增加 swap 或記憶體；關閉 LTO；拆分大檔案
fix: Yocto：調低 PARALLEL_MAKE 與 BB_NUMBER_THREADS
## gcc-unrecognized-option
re: (?:gcc|g\+\+|cc1|cc1plus|clang|c\+\+): error: unrecognized (?:command[- ]line )?option '(?<opt>[^']+)'|error: unknown argument: '(?<opt>[^']+)'
what: 編譯器不認得選項 {opt}。
cause: 編譯器版本太舊，不支援這個選項（或太新已移除）
cause: 把給 gcc 的選項傳給了 clang（或相反）、或給 C++ 的選項用在 C
cause: 選項拼錯
fix: 確認編譯器版本（gcc --version）；換版本或刪除該選項；跨編譯器時依編譯器分別設定旗標
## gcc-bad-march
re: (?:error|Error): (?:bad value|unknown value) ['‘]?(?<v>[^'’ ]+)['’]? for ['‘]?-m(?<k>arch|cpu|tune)|unknown (?:architecture|CPU|target CPU) ['‘]?(?<v>[^'’ ]+)|selected processor does not support [`'‘](?<insn>[^'’]+)['’] in (?<mode>ARM|Thumb) mode
what: -m{k} 的值或指令集不被接受（{v}{insn}）。
cause: 編譯器版本不認得這個 CPU 名稱
cause: -march／-mcpu 與目標不符（例如對 armv5 目標用了 armv7 才有的指令）
cause: Thumb 與 ARM 模式的指令不相容
fix: 對照 gcc 手冊支援的 -march／-mcpu 值（gcc -march=help 或 -mcpu=help）；用 -mthumb／-marm 與目標一致
## gcc-std-needed
re: error: ['‘]?(?<what>nullptr|auto|constexpr|decltype|static_assert|override|final|char16_t|char32_t)['’]? (?:was not declared in this scope|does not name a type|is not a type)|error: 'for' loop initial declarations are only allowed in C99 or C11 mode|error: ISO C\+\+ forbids|error: expected unqualified-id before ['‘]?(?:using|namespace|template)['’]?|requires C\+\+(?<std>\d+)
what: 用到的語法需要比目前更新的語言標準（{what}）。
cause: 編譯器預設標準太舊（GCC 5 以前預設 gnu++98 或 gnu90）
cause: 專案要求 C++11／14／17／20 或 C99／C11 但旗標沒設
fix: 加 -std=c++17（或 gnu++17）、-std=c11 等；CMake 設 CMAKE_CXX_STANDARD；Makefile 的 CXXFLAGS 加上
## gcc-incomplete-type
re: error: invalid use of incomplete type '(?<t>[^']+)'|error: storage size of '(?<v>[^']+)' isn't known|error: field '(?<v>[^']+)' has incomplete type|error: dereferencing pointer to incomplete type
what: 使用了還不完整的型別 {t}{v}：只有前向宣告，沒有完整定義。
cause: 缺少定義該型別的標頭（只 include 了宣告它存在的標頭）
cause: 循環相依造成定義順序不對
fix: include 提供完整定義的標頭；把需要完整型別的程式碼移到 .c／.cpp
## gcc-stray
re: error: stray '\\(?<code>\d+)' in program|error: stray ['‘]?(?<ch>[^'’ ]+)['’]? in program
what: 程式裡有編譯器不認得的怪字元（stray）。
cause: 從網頁或文件複製的程式碼帶了全形引號、不換行空白、或 BOM（UTF-8 位元組順序記號）
cause: 檔案編碼不是 UTF-8 或被其他工具改壞
fix: 用編輯器顯示隱藏字元找出來，換成半形；檔案存成不含 BOM 的 UTF-8
## gcc-unterminated
re: error: missing terminating (?<q>["'])  character|error: unterminated comment|warning: missing terminating|error: unterminated (?<what>argument list|#if|#ifdef|#ifndef)
what: 字串、註解或前處理區塊沒有結尾（{what}{q}）。
cause: 少了結尾的引號或 */，或 #if 沒有對應的 #endif
fix: 從錯誤行往前找沒有成對的符號；用編輯器的括號對應功能
## gcc-hash-error
re: error: #error (?<msg>.*)
what: 原始碼裡的 #error 主動中止編譯：{msg}
cause: 專案用 #error 檢查必要的設定、平台或版本（條件不滿足）
fix: 依訊息內容處理（常見：缺少定義的巨集、不支援的平台、需要 -D 選項）；看這行附近的 #if 條件
## gcc-source-missing
re: (?:gcc|g\+\+|cc|c\+\+|clang): error: (?<f>[^:]+): No such file or directory|(?:gcc|g\+\+|cc|c\+\+): fatal error: no input files
what: 編譯器找不到要編譯的檔案 {f}（或根本沒給輸入檔）。
cause: 路徑錯、工作目錄不對、檔案被刪除或還沒產生
cause: Makefile 的變數是空的，結果指令變成沒有輸入
fix: 確認檔案存在、路徑與大小寫；檢查變數是否有展開（make -n 看實際命令）
## gcc-jump-case
re: error: jump to case label|crosses initialization of
what: switch 的 case 跳過了變數初始化（C++）。
cause: case 區塊裡宣告了有初始化的變數，沒有加大括號
fix: 把 case 的內容用 { } 包起來
## gcc-lvalue
re: error: lvalue required as (?:left operand of assignment|increment operand)|error: assignment of read-only (?:variable|location|member) '(?<v>[^']+)'|error: assignment of member '(?<v>[^']+)' in read-only object
what: 對不能被指派的東西做了指派（或修改唯讀的 {v}）。
cause: 把 == 寫成 =，或對運算結果指派
cause: 修改 const 物件
fix: 檢查是否打錯運算符；去掉不必要的 const 或改設計
## gcc-static-assert
re: error: static assertion failed(?:: (?<msg>.*))?
what: 編譯期檢查（static_assert）失敗：{msg}
cause: 型別大小、對齊、範本條件不符合程式的假設（常因平台不同：32／64 位元）
fix: 看訊息指出的條件，檢查目標平台與結構定義
## gcc-narrowing
re: error: narrowing conversion of '(?<v>[^']+)' from '(?<from>[^']+)' to '(?<to>[^']+)'
what: C++11 的大括號初始化不允許縮窄轉換（{from} → {to}）。
cause: 用 {} 初始化時把較大的型別放進較小的
fix: 明確轉型（static_cast），或確認數值範圍
## gcc-asm-error
re: Error: (?:no such instruction|unknown mnemonic|bad instruction|invalid instruction|operand type mismatch|junk at end of line|too many memory references)[^\n]*|Error: (?:invalid|unsupported) ?(?:register|operand|instruction)[^\n]*
what: 組譯器（as）不接受這行組合語言。
cause: 指令不屬於目標架構（例如 x86 的組合語言用在 ARM）
cause: -march／-mcpu 沒啟用這個擴充（例如 SIMD、crypto）
cause: 語法風格不符（AT&T 與 Intel）、運算元型別不對
fix: 確認目標架構與 -march；用 -masm=intel 切換語法（x86）；對照 CPU 手冊
## ld-undefined-reference
re: undefined reference to [`'‘](?<sym>[^'’]+)['’]
what: 連結時找不到 {sym} 的實作（只宣告了、沒有定義，或沒有連結提供它的函式庫）。
cause: 缺少連結函式庫：沒有加 -l<lib>（例如數學函式要 -lm、執行緒要 -pthread、dlopen 要 -ldl）
cause: 函式庫的順序不對：靜態函式庫要放在使用它的目的檔「之後」
cause: 實作的 .c／.cpp 沒有被編進來（Makefile 漏檔、CMake 沒 add 進來）
cause: C 與 C++ 混用沒有 extern "C"，名稱修飾不同（mangling）
cause: 函式庫版本與標頭不一致，函式已被改名或移除
cause: 把函式宣告成 static 或 inline，沒有可連結的符號
fix: 用 nm -C 函式庫.a | grep {sym} 找出哪個函式庫有它，加上 -l 或 target_link_libraries
fix: 調整順序：gcc main.o -lfoo -lm（依賴者在前，被依賴者在後）
fix: 在 C 標頭用 #ifdef __cplusplus extern "C" { #endif 包起來
fix: 確認實作檔在 Makefile／CMakeLists 的來源清單裡
## ld-undefined-vtable
re: undefined reference to [`'‘](?:vtable|typeinfo) for (?<cls>[^'’]+)['’]
what: 找不到 {cls} 的虛擬函式表（vtable）：C++ 類別至少有一個虛擬函式沒有定義。
cause: 宣告了 virtual 函式卻沒有實作（含解構函式）
cause: 實作所在的 .cpp 沒有編進來
fix: 把每個非純虛擬函式都實作（含 virtual ~{cls}()）；確認該 .cpp 在建置清單裡
## ld-multiple-definition
re: multiple definition of [`'‘](?<sym>[^'’]+)['’]
what: {sym} 在多個目的檔都有定義，連結器不知道用哪個。
cause: 在標頭檔裡定義了變數或非 inline 函式，被多個 .c 引入
cause: GCC 10 起預設 -fno-common，舊程式碼在標頭用「沒有 extern 的全域變數」會重複定義
cause: 同一個 .c 被編進來兩次（萬用字元重複、函式庫與目的檔都有）
fix: 標頭只宣告（extern int x;），在一個 .c 定義；函式加 static inline
fix: 暫時繞過：加 -fcommon（不建議）；檢查來源清單有沒有重複
## ld-cannot-find-lib
re: (?:/usr/bin/)?(?:ld|ld\.lld|ld\.gold|ld\.bfd)?:? ?(?:error: )?(?:cannot find -l(?<lib>[\w.+-]+)|unable to find library -l(?<lib>[\w.+-]+)|library not found for -l(?<lib>[\w.+-]+))
what: 連結器找不到函式庫 lib{lib}（.so 或 .a）。
cause: 沒有安裝該函式庫的開發套件（只裝了執行用的 .so.N，沒有 .so 符號連結）
cause: 函式庫在非標準資料夾，沒有用 -L 指定
cause: 交叉編譯時沒有目標架構的函式庫（sysroot）
cause: 想連靜態版本（-static）但只有動態版
fix: 安裝 lib{lib}-dev（或 -devel）；用 -L<資料夾> 指定；CMake 用 find_library／target_link_libraries
fix: 用 ldconfig -p | grep {lib} 與 gcc -print-search-dirs 檢查搜尋路徑
## ld-cannot-find-crt
re: cannot find (?<f>crt1\.o|crti\.o|crtn\.o|Scrt1\.o|-lc|-lgcc_s?|-lgcc)|ld: cannot find (?<f>-lc)
what: 連結器找不到基本的 C 執行階段檔 {f}。
cause: 缺少 libc 的開發檔（libc6-dev）或交叉編譯的 sysroot 沒設好
cause: 使用 --sysroot 或 -nostdlib 的設定不對
fix: 安裝 libc6-dev／glibc-devel；交叉編譯確認 --sysroot 指向目標的根檔案系統；Yocto 檢查 sysroot 是否由 do_prepare_recipe_sysroot 建立
## ld-pic-required
re: relocation (?<r>R_[A-Z0-9_]+) against .* can not be used when making a shared object; recompile with -fPIC|recompile with -fPIE|relocation R_X86_64_32 against
what: 要做成共享函式庫（或 PIE 可執行檔）的程式碼不是位置獨立的，需要用 -fPIC 重新編譯（{r}）。
cause: 把沒有 -fPIC 的靜態函式庫（.a）或目的檔連進 .so
cause: 編譯旗標沒加 -fPIC
fix: 所有要進 .so 的目的檔都用 -fPIC 編譯（CMake：set(CMAKE_POSITION_INDEPENDENT_CODE ON)）
fix: 若是可執行檔，加 -no-pie 或確保依賴也是 PIE
## ld-wrong-format
re: (?:file in wrong format|is incompatible with .* output|skipping incompatible|cannot read file data: Is a directory|file format not recognized|Relocations in generic ELF|can't link (?:soft-float|hard-float)|uses VFP register arguments)
what: 要連結的檔案與目標架構不一致（位元數、CPU 架構或浮點 ABI 不同）。
cause: 混用 32 位元與 64 位元的目的檔或函式庫
cause: 把主機（x86）編的函式庫連進交叉編譯的目標（ARM）
cause: ARM 的 soft-float 與 hard-float 混用（-mfloat-abi 不一致）
cause: 檔案根本不是目的檔（例如下載失敗得到 HTML，或是 Git LFS 指標檔）
fix: 用 file 檔案名稱 看它的格式；確認所有輸入都是同一架構；統一 -m32／-m64、-mfloat-abi
## ld-dso-missing
re: DSO missing from command line|undefined reference to symbol '(?<sym>[^']+)'|error adding symbols: DSO missing from command line
what: 符號 {sym} 在某個共享函式庫裡，但命令列沒有明確連結它（新版連結器不再自動帶入間接相依）。
cause: 依賴的函式庫沒有出現在連結命令列（例如只連了 libfoo，但 foo 又用到 libbar 的符號）
fix: 補上 -l<那個函式庫>；CMake 在 target_link_libraries 明確列出
## ld-region-overflow
re: region [`'‘](?<r>\w+)['’] overflowed by (?<n>\d+) bytes|will not fit in region [`'‘](?<r>\w+)['’]|section [`'‘](?<s>[.\w]+)['’] will not fit in region
what: 程式太大，放不進記憶體區域 {r}（超過 {n} 位元組，區段 {s}）。
cause: 嵌入式目標的 Flash／RAM 不夠，程式或資料太大
cause: 最佳化等級太低（-O0）、除錯資訊或日誌字串佔空間
cause: 連結器腳本的區域大小設定不對
fix: 改 -Os，開 -ffunction-sections -fdata-sections 搭配 -Wl,--gc-sections；移除不用的功能；檢查 .map 檔哪些符號最大；調整連結腳本
## ld-no-main
re: undefined reference to [`'‘](?:main|_start|WinMain)['’]|(?:ld|collect2): .*undefined reference to `main'
what: 連結時找不到程式進入點 main（或 _start）。
cause: 沒有任何來源檔定義 main，或該檔沒有被編進來
cause: 把函式庫當成可執行檔連結
cause: 使用 -nostartfiles／-nostdlib 卻沒有自己提供 _start
fix: 確認 main 所在檔案在來源清單；要做函式庫請加 -shared 或用 ar；嵌入式要提供啟動碼與連結腳本的 ENTRY
## ld-permission
re: cannot open output file (?<f>[^:]+): (?<why>Permission denied|Text file busy|No such file or directory|Is a directory)
what: 連結器無法寫出輸出檔 {f}：{why}。
cause: 執行檔正在執行中（Text file busy），或沒有寫入權限，或輸出資料夾不存在
fix: 先結束執行中的程式；檢查資料夾與權限（ls -ld）；先 mkdir -p 輸出資料夾
## ld-killed
re: ld terminated with signal (?<sig>\d+) \[(?<name>[^\]]+)\]|collect2: fatal error: ld terminated with signal 9|ld: fatal error: (?<m>.*Killed)
what: 連結器被訊號 {sig} 終止（{name}），多半是記憶體不足。
cause: 連結大型專案（尤其含除錯資訊或 LTO）吃光記憶體
fix: 降低平行度；改用 lld 或 gold（-fuse-ld=lld）；移除除錯資訊（-g0 或 strip）；增加 swap
## ld-collect2 | any | cascade
re: collect2: error: ld returned (?<n>\d+) exit status|clang: error: linker command failed with exit code (?<n>\d+)|ld returned (?<n>\d+) exit status
what: 連結器失敗（退出碼 {n}）。這一行只是連帶結果，真正的原因在它上面的 undefined reference、cannot find 或 multiple definition 等訊息。
cause: 連結階段有一個以上的錯誤
fix: 往上找第一個 ld 的錯誤訊息，先處理它
## ld-glibc-version
re: version [`'‘]GLIBC(?:XX)?_(?<v>[\d.]+)['’] not found|version [`'‘]GLIBCXX_(?<v>[\d.]+)['’] not found|version [`'‘]CXXABI_(?<v>[\d.]+)['’] not found
what: 程式需要的 GLIBC／GLIBCXX {v} 比系統上的新。
cause: 在較新的系統編譯，拿到較舊的系統執行
cause: 動態載入到版本太舊的 libstdc++／libc
fix: 在較舊的系統（或舊版容器）編譯；靜態連結 libstdc++（-static-libstdc++ -static-libgcc）；升級目標系統的函式庫
## ld-hidden-symbol
re: hidden symbol [`'‘](?<sym>[^'’]+)['’] in .* is referenced by DSO
what: 符號 {sym} 是隱藏的，不能被共享函式庫外部使用。
cause: 函式庫用 -fvisibility=hidden 編譯，卻想從外部連結某個沒標示匯出的符號
fix: 在要匯出的符號加 __attribute__((visibility("default")))；或不要隱藏
## ld-lto
re: lto1: (?:fatal )?error|lto-wrapper: fatal error|plugin needed to handle lto object|lto-wrapper: warning
what: LTO（連結時最佳化）階段出錯。
cause: 編譯器與 ar／ld／nm 的版本或外掛不一致（例如用 gcc 編譯卻用沒有 LTO 外掛的 ar）
cause: LTO 時記憶體不足
fix: 使用 gcc-ar／gcc-nm／gcc-ranlib；或暫時關閉 -flto；確認所有物件都是同一編譯器產生
