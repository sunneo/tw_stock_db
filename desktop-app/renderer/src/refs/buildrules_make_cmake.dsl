# 建置錯誤規則：make／ninja／meson／CMake／autotools／Kbuild
## make-error-cascade | make | cascade
re: make(?:\[\d+\])?: \*\*\* \[(?:(?<f>[^:\]]+):(?<ln>\d+): )?(?<t>[^\]]+)\] Error (?<code>\d+)
what: make 的目標 {t} 的命令失敗了（退出碼 {code}）。這是連帶結果，不是原因：真正的錯誤訊息在它「上面」，是那個命令自己印出的。
cause: 目標的食譜（recipe）裡有一個命令回傳非 0 的退出碼
fix: 往上找這一行之前第一個 error:／fatal error:／cannot／not found；退出碼 127 是找不到命令、126 是不能執行、2 是一般失敗（常是子 make 失敗）、139 是程式當掉、137 是被殺掉
fix: 要看實際執行的命令：make V=1（多數專案）或 make -n；要在第一個錯誤就停：make -j1，或加 --output-sync 讓平行輸出不交錯
## make-no-rule
re: make(?:\[\d+\])?: \*\*\* No rule to make target ['‘`](?<t>[^'’`]+)['’`](?:, needed by ['‘`](?<by>[^'’`]+)['’`])?
what: make 不知道怎麼產生 {t}（被 {by} 需要）：這個檔案不存在，Makefile 裡也沒有能產生它的規則。
cause: 檔案被刪掉、改名或路徑寫錯（大小寫也算）
cause: 要的是產生出來的檔案，但產生它的步驟還沒跑或失敗了
cause: 舊的 .d 相依檔還參照已經刪除的標頭檔
cause: 在錯的資料夾執行 make（工作目錄不對）
cause: 目標名稱拼錯（例如 make instal）
fix: 確認檔案存在：ls {t}；用 make -n 看它從哪裡被需要
fix: 標頭被刪除的情況：刪掉對應的 .d 檔或 make clean 後重來（Makefile 可加 -MP 避免）
fix: 用 -C 指定正確的資料夾
## make-no-makefile
re: make(?:\[\d+\])?: \*\*\* No targets specified and no makefile found
what: 這個資料夾沒有 Makefile，也沒有指定目標。
cause: 在錯的資料夾執行 make
cause: 專案要先設定才有 Makefile（./configure、cmake、qmake）
fix: cd 到正確的資料夾；先執行 ./configure 或 cmake -S . -B build，再到產生的建置資料夾 make
## make-missing-separator
re: (?<f>[^\s:]+):(?<ln>\d+): \*\*\* missing separator(?:\.  Stop\.|\s*\(did you mean TAB instead of 8 spaces\?\))?
what: {f} 第 {ln} 行的語法不對：make 需要在命令行開頭用 Tab，或遇到不是規則的行。
cause: 命令行開頭用了空白而不是 Tab
cause: 編輯器自動把 Tab 換成空白
cause: 合併衝突標記（<<<<<<<）還留在檔案裡
cause: 把非 Makefile 的內容放進 Makefile（例如 shell 腳本語法）
fix: 把那行開頭換成真正的 Tab 字元；檢查有沒有 <<<<<<< ======= >>>>>>>
## make-commands-commence
re: \*\*\* commands commence before first target
what: Makefile 一開始就出現命令行，但還沒有任何目標。
cause: 縮排的行（開頭是 Tab）出現在第一個目標之前
cause: 前一個規則的目標行被刪掉或寫壞
fix: 檢查這行上面是不是少了「目標: 相依」；命令行要屬於某個目標
## make-recursive-var
re: \*\*\* Recursive variable [`'‘](?<v>[^'’`]+)['’`] references itself
what: 變數 {v} 的值引用了自己，展開會無窮遞迴。
cause: 用 = 定義變數，右邊又用到同名變數（例如 CFLAGS = $(CFLAGS) -O2）
fix: 改用 := 立即展開，或用 += 追加；Yocto／BitBake 要用 :append 而不是 =
## make-unterminated
re: \*\*\* (?:unterminated variable reference|missing [`'‘]?endif['’`]?|extraneous [`'‘]?endif|missing rule before recipe|mixed implicit and normal rules|target pattern contains no [`'‘]%['’`]|multiple target patterns|Extraneous text after [`'‘]else['’`] directive)
what: Makefile 的語法錯誤（括號、endif 或模式規則寫得不完整）。
cause: $( 少了右括號；ifeq／ifdef 沒有 endif；模式規則的目標沒有 %
fix: 依訊息指出的行號修正；用編輯器的括號對應檢查
## make-sh-not-found
re: (?:/bin/sh|sh|bash): (?:\d+: )?(?<cmd>[\w./+-]+): (?:command )?not found|make(?:\[\d+\])?: (?<cmd>[\w./+-]+): (?:No such file or directory|Command not found)
what: 食譜裡呼叫的命令 {cmd} 在這台機器上找不到。
cause: 沒有安裝這個工具（例如 cmake、python3、flex、bison、gperf、pkg-config）
cause: 工具不在 PATH（Yocto 的原生工具在 recipe-sysroot-native）
cause: 交叉編譯前綴不對（arm-linux-gnueabihf-gcc 找不到）
cause: 腳本的 shebang 指向不存在的直譯器
fix: 安裝缺少的工具（apt install {cmd} 或對應套件）；確認 PATH；交叉工具鏈要確認 CROSS_COMPILE
fix: Yocto：在配方加 DEPENDS += "xxx-native"
## make-permission-denied
re: (?:/bin/sh|sh|bash): (?:\d+: )?(?<f>[^:]+): Permission denied|make(?:\[\d+\])?: (?<f>[^:]+): Permission denied
what: 執行 {f} 被拒絕：沒有執行權限或檔案不能被執行。
cause: 腳本沒有 x 權限（git 沒保存權限、從 zip 解開）
cause: 檔案系統用 noexec 掛載（例如 /tmp）
fix: chmod +x {f}；改到沒有 noexec 的位置建置
## make-clock-skew
re: make(?:\[\d+\])?: (?:warning: )?(?:Clock skew detected|File [`'‘][^'’`]+['’`] has modification time .* s in the future)
what: 檔案時間戳記在未來（或時鐘不同步），make 可能誤判需要重建。
cause: 系統時間不對，或從別台機器（NFS／容器）複製來的檔案時間較新
fix: 校正系統時間（NTP）；touch 相關檔案；make clean 後重建
## make-jobserver
re: warning: jobserver unavailable|jobserver unavailable: using -j1
what: 子 make 拿不到平行工作資源，退回單執行緒（-j1）。
cause: 上層 Makefile 用 $(MAKE) 以外的方式呼叫 make，或規則前沒有 + 號
fix: 子 make 一律寫 $(MAKE)；或在命令前加 +
## make-interrupt
re: make(?:\[\d+\])?: \*\*\* \[[^\]]*\] (?:Interrupt|Terminated|Killed)
what: make 被中斷（Ctrl+C）或被訊號終止／殺掉。
cause: 人為中斷；或記憶體不足被系統殺掉；或 CI 逾時
fix: 若不是人為，看 dmesg 是否有 Out of memory；降低平行度
## make-error-code-127 | any | cascade
re: make(?:\[\d+\])?: \*\*\* \[[^\]]*\] Error 127
what: 命令找不到（退出碼 127）。
cause: 食譜裡的命令不存在或不在 PATH
fix: 往上看是哪個命令（通常有 not found 訊息），安裝或設定 PATH
## make-error-code-139 | any | cascade
re: make(?:\[\d+\])?: \*\*\* \[[^\]]*\] Error 139|Segmentation fault \(core dumped\)
what: 某個命令當掉了（Segmentation fault）。
cause: 編譯器或建置工具本身有 bug 或記憶體損壞；或程式測試時當掉
fix: 重跑確認可重現；用 gdb 或 core dump 追；工具可能要升級
## ninja-failed
re: ^FAILED: (?<t>.+)$
what: ninja 的步驟 {t} 失敗。這是連帶結果，真正的錯誤訊息接在它下面（那個命令的輸出）。
cause: 該步驟的命令（編譯、連結、產生程式碼）回傳非 0
fix: 看 FAILED 這行下面第一個 error；ninja -v 看完整命令；ninja -k 0 繼續建置其他目標以看全部錯誤
## ninja-stopped | any | cascade
re: ninja: build stopped: subcommand failed|ninja: build stopped: cannot make progress
what: ninja 因為有步驟失敗而停止（連帶結果）。
cause: 上面某個 FAILED 步驟
fix: 往上找 FAILED: 行與它的錯誤輸出
## ninja-no-build
re: ninja: error: loading ['‘]build\.ninja['’]: No such file or directory
what: ninja 在這個資料夾找不到 build.ninja：還沒有用 CMake／Meson 產生建置檔。
fix: 先 cmake -S . -B build -G Ninja（或 meson setup build），再 ninja -C build
## ninja-missing-dep
re: ninja: error: ['‘](?<f>[^'’]+)['’], needed by ['‘](?<by>[^'’]+)['’], missing and no known rule to make it
what: ninja 要 {by} 但缺少 {f}，也沒有規則可以產生它。
cause: 檔案被刪除、改名，或產生它的步驟不在建置圖裡
fix: 重新執行 cmake／meson 重新產生建置檔；確認檔案存在
## meson-dependency
re: ERROR: Dependency ['"‘](?<d>[^'"’]+)['"’] not found|Run-time dependency (?<d>[\w.+-]+) found: NO|ERROR: Could not find (?<d>[\w.+-]+)
what: Meson 找不到相依套件 {d}。
cause: 沒有安裝開發套件，pkg-config 或 CMake 找不到它
cause: 套件在非標準位置，PKG_CONFIG_PATH 沒設
fix: 安裝 {d} 的 -dev 套件；設定 PKG_CONFIG_PATH；meson setup 加 -Dprefix 或 --pkg-config-path
## meson-program
re: ERROR: Program ['"‘](?<p>[^'"’]+)['"’] not found|ERROR: Unknown compiler\(s\)|meson\.build:\d+:\d+: ERROR: (?<msg>.*)
what: Meson 設定失敗：{msg}{p}
cause: 缺少建置需要的程式（找不到 {p}）或編譯器
fix: 安裝缺少的程式；交叉編譯要提供 --cross-file；看 meson-logs/meson-log.txt
## cmake-no-cmakelists
re: CMake Error: The source directory ["'‘](?<d>[^"'’]+)["'’] does not appear to contain CMakeLists\.txt|CMake Error: (?:Could not find CMAKE_ROOT|The source ["'‘][^"'’]+["'’] does not match the source)
what: {d} 裡沒有 CMakeLists.txt，CMake 不知道要建置什麼。
cause: cmake 指到錯的資料夾（常見：少了 -S 或寫成 cmake build）
cause: 專案的 CMakeLists.txt 在子資料夾
fix: 用 cmake -S <有 CMakeLists.txt 的資料夾> -B <建置資料夾>
## cmake-package-not-found
re: Could not find a package configuration file provided by ["'](?<pkg>[\w.+-]+)["']|By not providing ["']Find(?<pkg>[\w.+-]+)\.cmake["'] in CMAKE_MODULE_PATH
what: CMake 找不到套件 {pkg} 的設定檔（{pkg}Config.cmake）。
cause: 沒有安裝這個套件的開發版本
cause: 套件裝在非標準位置，CMAKE_PREFIX_PATH 或 {pkg}_DIR 沒指向它
cause: 交叉編譯時找的是主機的套件，不是目標的（CMAKE_FIND_ROOT_PATH 設定）
fix: 安裝 {pkg} 的 -dev 套件；cmake -D{pkg}_DIR=<含 {pkg}Config.cmake 的資料夾> 或 -DCMAKE_PREFIX_PATH=<安裝根目錄>
fix: Yocto：在配方的 DEPENDS 加上提供它的配方
## cmake-could-not-find
re: Could NOT find (?<pkg>[\w.+-]+) \(missing: (?<what>[^)]+)\)
what: CMake 的 Find 模組找不到 {pkg}（缺少：{what}）。
cause: 沒裝開發套件（標頭與函式庫），或路徑不在預設搜尋範圍
fix: 安裝對應的 -dev 套件；或用 -D{pkg}_INCLUDE_DIR=… -D{pkg}_LIBRARY=… 手動指定
## cmake-unknown-command
re: CMake Error at [^\n]*: Unknown CMake command ["'](?<c>[\w]+)["']|Unknown CMake command ["'](?<c>[\w]+)["']
what: CMake 不認得指令 {c}。
cause: 這個指令屬於某個模組，還沒 include／find_package（例如 FetchContent_Declare 要 include(FetchContent)）
cause: CMake 版本太舊，還沒有這個指令
fix: 加上對應的 include() 或 find_package()；升級 CMake；檢查 cmake_minimum_required
## cmake-version
re: CMake (?:Error: )?(?<req>[\d.]+) or higher is required\.\s+You are running version (?<cur>[\d.]+)|CMake (?:Error )?at [^\n]*cmake_minimum_required[^\n]*|Compatibility with CMake < (?<v>[\d.]+) has been removed
what: CMake 版本不符：需要 {req}，目前 {cur}；或專案的 cmake_minimum_required 太舊（CMake 4 起移除相容 {v} 以下）。
cause: 系統的 CMake 太舊
cause: CMake 4.x 不再接受 cmake_minimum_required(VERSION 低於 3.5)
fix: 升級 CMake（pip install cmake 或官方安裝檔）
fix: 舊專案暫時加 -DCMAKE_POLICY_VERSION_MINIMUM=3.5
## cmake-compiler-not-found
re: No CMAKE_(?<l>C|CXX|ASM|CUDA)_COMPILER could be found|The (?<l>C|CXX) compiler ["'](?<c>[^"']+)["'] is not able to compile a simple test program|CMake Error: CMAKE_(?<l>C|CXX)_COMPILER[^\n]*not (?:set|found)
what: CMake 找不到或無法使用 {l} 編譯器 {c}。
cause: 沒有安裝編譯器，或不在 PATH
cause: 編譯器存在但連簡單測試程式都編不過（旗標壞了、缺 libc、sysroot 錯、交叉編譯沒設 CMAKE_SYSTEM_NAME）
cause: 之前用別的編譯器設定過，快取（CMakeCache.txt）裡還是舊的
fix: 安裝編譯器（build-essential）；看 build/CMakeFiles/CMakeError.log 找測試程式為什麼失敗
fix: 換編譯器要刪掉 CMakeCache.txt 再設定；交叉編譯用 -DCMAKE_TOOLCHAIN_FILE
## cmake-no-build-program
re: CMake was unable to find a build program corresponding to ["'](?<g>[^"']+)["']|CMAKE_MAKE_PROGRAM is not set
what: CMake 找不到產生器 {g} 對應的建置程式（make 或 ninja）。
fix: 安裝 make 或 ninja；或改用 -G "Unix Makefiles"／-G Ninja
## cmake-cache-mismatch
re: The current CMakeCache\.txt directory (?<a>.+) is different than the directory (?<b>.+) where CMakeCache\.txt was created|CMake Error: The source ["'][^"']+["'] does not match the source ["'][^"']+["'] used to generate cache
what: 建置資料夾的 CMakeCache.txt 是在另一個位置產生的（資料夾被搬移或複製過）。
cause: 把整個專案或 build 資料夾搬到別的路徑
fix: 刪掉 build 資料夾（或其中的 CMakeCache.txt 與 CMakeFiles）重新設定
## cmake-target-not-found
re: (?:Target ["'](?<t>[^"']+)["'] links to target ["'](?<d>[^"']+)["'] but the target was not found|Cannot specify link libraries for target ["'](?<t>[^"']+)["'] which is not built by this project|add_dependencies called with non-existent target ["'](?<t>[^"']+)["'])
what: 目標 {t} 引用了不存在的目標 {d}，或對不屬於這個專案的目標操作。
cause: 目標名稱拼錯，或定義它的 add_subdirectory 沒執行
cause: 需要先 find_package 才有匯入目標（例如 Threads::Threads、OpenSSL::SSL）
fix: 檢查名稱；確認 add_subdirectory／find_package 的順序；匯入目標用 find_package(... REQUIRED)
## cmake-duplicate-target
re: add_(?:library|executable) cannot create target ["'](?<t>[^"']+)["'] because another target with the same name already exists
what: 目標名稱 {t} 重複。
cause: 兩個子專案定義同名目標，或同一個目錄被 add_subdirectory 兩次
fix: 改名；用 if(NOT TARGET {t}) 包起來
## cmake-source-missing
re: Cannot find source file:\s*(?<f>\S+)|No SOURCES given to target: (?<t>\S+)|CMake Error[^\n]*Cannot find source file
what: add_executable／add_library 列的來源 {f} 不存在（或目標 {t} 沒有任何來源）。
cause: 檔名拼錯、檔案還沒產生、路徑相對的基準不對（相對於 CMakeLists.txt 所在目錄）
cause: file(GLOB) 沒有找到任何檔案（資料夾位置不對）
fix: 確認檔案存在與路徑；GLOB 結果為空時檢查路徑；用 CMAKE_CURRENT_SOURCE_DIR 組路徑
## cmake-toolchain-missing
re: Could not find toolchain file: (?<f>\S+)
what: 找不到工具鏈檔案 {f}。
fix: 檢查 -DCMAKE_TOOLCHAIN_FILE 的路徑（要用絕對路徑或相對於目前目錄）
## cmake-install
re: file INSTALL cannot (?:find|copy file) ["'](?<f>[^"']+)["']|install TARGETS given no (?<w>\w+) DESTINATION|file INSTALL cannot set permissions
what: cmake --install 安裝時出錯（{f}）：要安裝的檔案不存在，或沒有指定安裝目的地。
cause: 還沒建置就安裝；install(TARGETS) 少了 DESTINATION；目的地沒有寫入權限
fix: 先建置再 install；補上 DESTINATION；用 -DCMAKE_INSTALL_PREFIX 或 DESTDIR 指定可寫的位置
## cmake-configure-incomplete | any | cascade
re: -- Configuring incomplete, errors occurred!|CMake Error: Error in cmake code at|-- Generating incomplete
what: CMake 設定階段失敗（連帶結果）。真正的原因是上面的 CMake Error 訊息。
fix: 往上找第一個 CMake Error 與它的檔案行號（CMake Error at CMakeLists.txt:N）；看 CMakeFiles/CMakeError.log、CMakeOutput.log
## cmake-policy
re: CMake (?:Warning|Error) \(dev\) at [^\n]*(?:Policy (?<p>CMP\d+)|policy (?<p>CMP\d+))
what: CMake 政策 {p} 的行為在新舊版本不同，專案沒有明確設定。
cause: cmake_minimum_required 的版本比 CMake 實際版本舊很多
fix: 提高 cmake_minimum_required 或用 cmake_policy(SET {p} NEW)；多半只是開發者警告
## cmake-imported-missing-path
re: Imported target ["'](?<t>[^"']+)["'] includes non-existent path|The imported target ["'](?<t>[^"']+)["'] references the file
what: 匯入目標 {t} 參照的路徑或檔案不存在。
cause: 套件只裝了一部分（缺 -dev）；或套件被搬移
fix: 安裝完整的開發套件；重新安裝該套件
## autotools-compiler-cannot-create
re: configure: error: C(?:\+\+)? compiler cannot create executables|configure: error: (?:cannot run C compiled programs|no acceptable C compiler found in \$PATH)
what: configure 用編譯器編一個小測試程式失敗，通常不是專案的問題，而是工具鏈環境問題。
cause: 沒裝編譯器或 libc 開發檔；交叉編譯沒有指定 --host
cause: CFLAGS／LDFLAGS 有壞掉的旗標；sysroot 錯
cause: 交叉編譯時試圖執行目標的程式（跑不起來）
fix: 看 config.log 最後面（搜尋 "error:" 之前的命令與輸出）；交叉編譯要加 --host=<三元組>
## autotools-package-missing
re: configure: error: (?:Package requirements \([^)]*\) were not met|[Pp]ackage (?<p>[\w.+-]+) (?:not found|was not found in the pkg-config search path))|No package ['"](?<p>[\w.+-]+)['"] found|Package ['"]?(?<p>[\w.+-]+)['"]? was not found in the pkg-config search path
what: configure 或 pkg-config 找不到套件 {p}。
cause: 沒有安裝開發套件；.pc 檔不在 PKG_CONFIG_PATH
cause: 交叉編譯時 pkg-config 找到主機的而不是目標的
fix: 安裝 {p} 的 -dev 套件；設定 PKG_CONFIG_PATH（交叉編譯用 PKG_CONFIG_SYSROOT_DIR 與 PKG_CONFIG_LIBDIR）
fix: Yocto：在 DEPENDS 加上提供它的配方，並確認繼承 pkgconfig
## autotools-generic-not-found
re: configure: error: (?<what>[^\n]*?) (?:not found|not installed|is required|could not be found)|checking for (?<what>[^\n.]+)\.\.\. no\s*$
what: configure 檢查不到必要的東西：{what}。
cause: 缺少開發套件、工具或函式庫
fix: 看 config.log 找出測試的命令與失敗原因；安裝後重新 ./configure；有些功能可用 --disable-xxx 關閉
## autotools-missing-tool
re: (?:aclocal|autoconf|automake|autoreconf|libtoolize|autoheader)(?:-[\d.]+)?: (?:command not found|not found)|(?:Makefile|configure)\.(?:am|ac):\d+: (?:error|warning): [^\n]+|missing(?: )?(?:: )?(?<t>aclocal|automake|autoconf)[^\n]*(?:is missing|not found)|WARNING: ['‘](?<t>aclocal|automake|autoconf)[^\n]* is (?:missing|probably too old)
what: autotools 工具（{t}）缺失或版本不符，需要重新產生 configure。
cause: 從 git 取得的原始碼沒有預先產生 configure；時間戳記讓 make 想自動重產
fix: 安裝 autoconf automake libtool；執行 autoreconf -fi；或用發行 tarball
## autotools-config-status
re: config\.status: error: cannot find input file: ['‘`]?(?<f>[^'’`]+)['’`]?|config\.status: error: (?<m>.+)
what: config.status 找不到輸入檔 {f}。
fix: 執行 autoreconf -fi 重新產生；確認原始碼完整（沒有漏掉 .in 檔）
## kbuild-modpost
re: (?:ERROR: )?modpost: ["'‘](?<sym>[^"'’]+)["'’] \[(?<mod>[^\]]+)\] undefined!|WARNING: modpost: missing MODULE_LICENSE|ERROR: modpost: [^\n]+
what: 核心模組 {mod} 用到的符號 {sym} 在核心裡沒有（modpost 階段）。
cause: 核心沒有開啟提供該符號的 CONFIG 選項，或模組與核心版本不一致
cause: 該符號沒有被 EXPORT_SYMBOL（或只有 GPL 版本）而模組授權不是 GPL
fix: 開啟對應的 CONFIG_*（make menuconfig）；確認用的是同一份核心的標頭與符號（Module.symvers）；授權相容時改用 MODULE_LICENSE("GPL")
## kbuild-config
re: (?:Kernel configuration is invalid|include/generated/autoconf\.h or include/config/auto\.conf are missing|Run ['"]?make oldconfig['"]? (?:&&|and) ['"]?make prepare|\*\*\* Configuration file ["'‘]\.config["'’] not found)
what: 核心還沒設定或設定過期（沒有 .config 或 autoconf.h）。
cause: 第一次建置，還沒有 .config
cause: 換了核心版本或分支，設定檔過期
fix: make defconfig（或 make <板子>_defconfig）；已有舊設定用 make olddefconfig；外部模組要先在核心樹跑 make modules_prepare
## kbuild-missing-dev
re: (?:fatal error: )?(?:openssl/[\w.]+|gelf\.h|libelf\.h|asm/[\w.]+|linux/[\w./]+|ncurses\.h|curses\.h): No such file or directory|Cannot generate ORC metadata|Please install (?:libelf|openssl|libssl-dev|ncurses)
what: 建置核心或核心模組所需的主機工具標頭不存在。
cause: 沒裝 libelf-dev、libssl-dev、libncurses-dev、flex、bison、bc 等
cause: 外部模組找不到核心標頭（沒有 linux-headers-$(uname -r)）
fix: sudo apt install build-essential libelf-dev libssl-dev libncurses-dev flex bison bc linux-headers-$(uname -r)
## kbuild-error-in-file | any | cascade
re: (?:make\[\d+\]: \*\*\* \[scripts/Makefile\.build:\d+: (?<o>[^\]]+)\] Error \d+|scripts/Makefile\.build:\d+: [^\n]*)
what: 核心建置在編 {o} 時失敗（連帶結果）。
fix: 往上找這個檔案編譯時的第一個 error；核心的 warning 在新版編譯器常變成 error（-Werror），可能需要對應的編譯器版本
