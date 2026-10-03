# 建置錯誤規則：Maven／Gradle／Java、npm／node-gyp、Cargo／Rust、pip／Python 建置、Go
## mvn-compilation | maven | root
re: \[ERROR\] (?:COMPILATION ERROR|Failed to execute goal [^\n]*maven-compiler-plugin[^\n]*Compilation failure)
what: Maven 編譯 Java 原始碼失敗（compilation failure）。這是結論，具體錯誤是接著列出的 [ERROR] 檔案:[行,欄] 訊息。
fix: 往下看 [ERROR] /path/File.java:[12,8] 那幾行（cannot find symbol、package does not exist…）依它處理
## java-cannot-find-symbol | java | root
re: (?:error: )?cannot find symbol|\[ERROR\] [^\n]*cannot find symbol
what: Java 編譯：找不到符號（變數、方法或類別）。
cause: 拼字錯誤、沒有 import、缺少相依套件（pom.xml／build.gradle 沒加）、版本太舊沒有那個方法
fix: 看下一行 "symbol:" 與 "location:"；補 import 或相依；確認相依版本
## java-package-missing | java | root
re: package (?<p>[\w.]+) does not exist|error: package (?<p>[\w.]+) does not exist
what: Java：套件 {p} 不存在，找不到相依的函式庫。
cause: 沒有在 pom.xml／build.gradle 宣告提供該套件的相依，或相依下載失敗
fix: 加入正確的相依（groupId／artifactId）；用 mvn dependency:tree 或 gradle dependencies 確認
## java-version | java | root
re: (?:Unsupported class file major version (?<v>\d+)|invalid (?:target|source) release: (?<r>[\d.]+)|Source option (?<r>\d+) is no longer supported\. Use (?<u>\d+) or later|release version (?<r>\d+) not supported|class file has wrong version (?<v>[\d.]+), should be (?<s>[\d.]+)|UnsupportedClassVersionError)
what: Java 版本不相容：工具或程式需要的 Java 版本（{v}{r}）與目前的 JDK 不符。
cause: class file major version 52＝Java 8、55＝11、61＝17、65＝21：用較舊的 JDK／Gradle／ASM 讀較新的類別
cause: 專案設定的 source／target／release 比目前 JDK 新或太舊
fix: 用 java -version 與 JAVA_HOME 確認；切換到需要的 JDK；調整 maven.compiler.release 或 Gradle 的 toolchain；升級 Gradle／外掛以支援新版 Java
## mvn-dependency | maven | root
re: Could not resolve dependencies for project|Could not (?:find|transfer) artifact (?<a>\S+)|Non-resolvable parent POM|Failed to read artifact descriptor for (?<a>\S+)|Connect to [^\n]+ failed|Could not resolve all files for configuration|Could not (?:resolve|download) (?<a>\S+)
what: 相依套件 {a} 解析或下載失敗。
cause: 網路／代理／鏡像設定問題；私有倉庫缺認證；版本號不存在；本機倉庫（~/.m2）損毀
fix: 看是哪個 artifact 與倉庫；檢查 settings.xml 的 mirror／proxy；刪掉 ~/.m2/repository 中該套件的 _remote.repositories 與 lastUpdated 檔再 mvn -U；確認版本存在
## gradle-task-failed | gradle | root
re: (?:FAILURE: Build failed with an exception|Execution failed for task ['"](?<t>[^'"]+)['"]|\* What went wrong:)
what: Gradle 建置失敗，任務 {t}。真正的原因在 "What went wrong:" 後面的內容。
fix: 看 What went wrong 之後的說明與 Caused by；加 --stacktrace、--info 或 --scan 取得更多資訊
## gradle-heap | gradle | root
re: java\.lang\.OutOfMemoryError: (?<k>Java heap space|Metaspace|GC overhead limit exceeded)|Expiring Daemon because JVM heap space is exhausted
what: JVM 記憶體不足（{k}）。
cause: 建置或測試需要的記憶體超過 JVM 預設上限
fix: 調高 -Xmx：gradle.properties 設 org.gradle.jvmargs=-Xmx4g；Maven 設 MAVEN_OPTS=-Xmx2g；Metaspace 調 -XX:MaxMetaspaceSize
## npm-eresolve | npm | root
re: npm ERR! (?:code ERESOLVE|ERESOLVE (?:unable to resolve dependency tree|could not resolve)[^\n]*)|npm error code ERESOLVE|Could not resolve dependency:
what: npm 無法解出一組互相相容的相依版本（peer dependency 衝突）。
cause: 套件要求的 peer 版本互相矛盾（常見：React 版本與周邊套件）
fix: 看訊息指出哪兩個套件衝突；升級或降級其中一方；暫時繞過 npm install --legacy-peer-deps（確認不會造成執行期問題）
## npm-missing | npm | root
re: npm ERR! (?:code ENOENT|enoent|ENOENT:? [^\n]*(?<f>package\.json))|Could not read package\.json|npm error code ENOENT
what: npm 找不到檔案（常是 package.json）。
cause: 在錯的資料夾執行 npm
fix: cd 到有 package.json 的專案根目錄；npm init 建立
## npm-permission | npm | root
re: npm ERR! (?:code EACCES|EACCES: permission denied[^\n]*)|npm error code EACCES|EACCES: permission denied, (?:mkdir|open|access|symlink) ['"](?<p>[^'"]+)['"]
what: npm 沒有權限寫入 {p}。
cause: 全域安裝寫到系統資料夾（/usr/lib/node_modules）；之前用 sudo 安裝，檔案擁有者是 root
fix: 不要用 sudo 裝套件；設定 npm 的 prefix 到使用者目錄（npm config set prefix ~/.npm-global）或用 nvm；chown 修正擁有者
## npm-404 | npm | root
re: npm ERR! (?:code E404|404 Not Found[^\n]*)|npm error code E404|npm ERR! code ETARGET|No matching version found for (?<p>\S+)
what: npm 找不到套件或版本（{p}）。
cause: 套件名稱或版本打錯、私有套件沒有設定 registry 與認證、版本已被撤下
fix: npm view 套件 versions 看有哪些版本；確認 .npmrc 的 registry 與 token
## node-gyp | npm | root
re: gyp ERR! (?:find Python|configure error|build error|stack)[^\n]*|node-gyp rebuild[^\n]*failed|gyp ERR! (?:not ok)|Could not find any Python installation to use
what: node-gyp 編譯原生模組失敗。
cause: 缺少 Python、C++ 編譯器（build-essential／Visual Studio Build Tools）或 make
cause: Node 版本太新，原生模組還沒支援
fix: 安裝 python3、make、g++（Windows 安裝 Visual Studio Build Tools 的 C++ 工作負載）；換 Node LTS 版本；改用提供預編譯二進位的套件版本
## node-module-missing | npm | root
re: (?:Error: )?Cannot find module ['"](?<m>[^'"]+)['"]|ERR_MODULE_NOT_FOUND[^\n]*['"](?<m>[^'"]+)['"]|Module not found: Error: Can't resolve ['"](?<m>[^'"]+)['"]
what: Node／打包工具找不到模組 {m}。
cause: 沒有 npm install；相依沒列在 package.json；相對路徑或大小寫錯；ESM 要寫完整副檔名
fix: 執行 npm install；用 npm ls {m} 確認；檢查路徑與副檔名；套件放在 dependencies 而不是只在開發機的全域
## node-openssl | npm | root
re: ERR_OSSL_EVP_UNSUPPORTED|error:0308010C:digital envelope routines::unsupported
what: Node 17 以上使用 OpenSSL 3，舊版 webpack 用到的雜湊演算法（md4）不再支援。
fix: 升級 webpack／相關工具；暫時設 NODE_OPTIONS=--openssl-legacy-provider
## cargo-compile | cargo | root
re: error(?:\[(?<code>E\d{4})\])?: (?<msg>[^\n]+)\n?|error: could not compile ['"`](?<c>[^'"`]+)['"`]
what: Rust 編譯錯誤{code}：{msg}。
cause: E0432／E0433 找不到模組或 crate（use 路徑錯、沒在 Cargo.toml 加相依）；E0425 找不到名稱；E0382 使用已被移動的值（所有權）；E0499／E0502 借用規則衝突；E0308 型別不符
fix: 執行 rustc --explain {code} 看詳細說明；照編譯器給的 help: 建議修改；Rust 的錯誤訊息通常已指出怎麼改
## cargo-linker | cargo | root
re: error: linker [`'‘](?<l>[^'’`]+)['’`] not found|error: could not find native static library [`'‘](?<n>[^'’`]+)['’`]|note: (?:/usr/bin/ld|ld): cannot find -l(?<n>\S+)
what: Rust 找不到連結器 {l} 或原生函式庫 {n}。
cause: 沒裝 C 編譯器（build-essential／Xcode Command Line Tools／Visual Studio Build Tools）；缺少 -sys crate 需要的系統函式庫（openssl、zlib…）
fix: 安裝 gcc／clang 與 pkg-config 與對應的 -dev 套件（例如 libssl-dev）；交叉編譯設定 linker 在 .cargo/config.toml
## cargo-version-select | cargo | root
re: failed to select a version for the requirement [`'‘]?(?<c>[^'’`]+)[`'’]?|error: failed to (?:get|download|load source for) [`'‘]?(?<c>[^'’`]+)[`'’]?|failed to select a version for (?<c>\S+)
what: Cargo 無法為 {c} 選出相容的版本，或下載失敗。
cause: 版本要求互相衝突；crates.io 索引無法連線；rustc 版本低於 crate 要求的最低版本（MSRV）
fix: cargo tree 看相依；放寬或對齊版本；檢查網路與 registry 設定；rustup update 升級
## pip-gcc-failed | python | root
re: error: command ['"]?(?<c>gcc|g\+\+|cc|x86_64-linux-gnu-gcc)['"]? failed with exit (?:status|code) (?<n>\d+)|ERROR: Failed building wheel for (?<w>\S+)|Failed to build (?<w>[\w.-]+)|ERROR: Could not build wheels for (?<w>\S+)
what: pip 安裝 {w} 時需要編譯原生擴充（{c} 失敗，退出碼 {n}）。
cause: 沒有預編譯的 wheel（Python 版本太新或平台不支援），只好從原始碼編譯，而系統缺編譯器或標頭
fix: 往上看真正的編譯錯誤（常是 Python.h、某個 -dev 標頭或 libffi／openssl／libxml2）；安裝 python3-dev、build-essential 與對應開發套件；或升級 pip 與選有 wheel 的版本（pip install --upgrade pip setuptools wheel）
## pip-msvc | python | root
re: Microsoft Visual C\+\+ 14\.0 or greater is required|error: Microsoft Visual C\+\+|Unable to find vcvarsall\.bat
what: Windows 上從原始碼編譯 Python 擴充需要 Microsoft C++ 編譯器。
fix: 安裝 Visual Studio Build Tools 的「使用 C++ 的桌面開發」工作負載；或改用有 Windows wheel 的版本
## pip-no-version | python | root
re: ERROR: (?:Could not find a version that satisfies the requirement (?<r>\S+)|No matching distribution found for (?<r>\S+))
what: pip 找不到符合 {r} 的版本。
cause: 套件名稱拼錯、版本不存在、Python 版本或平台不支援該套件、離線或索引設定錯誤
fix: pip index versions 套件 看有哪些版本；檢查 Python 版本與 pip 版本；確認網路與 --index-url
## pip-externally-managed | python | root
re: error: externally-managed-environment|This environment is externally managed
what: 系統的 Python 由作業系統套件管理員管理（PEP 668），pip 不允許直接修改。
fix: 用虛擬環境：python3 -m venv .venv && . .venv/bin/activate；或 pipx 安裝命令列工具；最後手段才用 --break-system-packages
## python-module-missing | python | root
re: (?:ModuleNotFoundError|ImportError): No module named ['"](?<m>[^'"]+)['"]|ImportError: cannot import name ['"](?<n>[^'"]+)['"] from ['"](?<m>[^'"]+)['"]
what: Python 找不到模組 {m}（或模組裡沒有 {n}）。
cause: 沒安裝；用了錯的 Python／虛擬環境；模組名稱與套件名稱不同（cv2 對應 opencv-python）；版本太舊沒有那個名稱；自己的檔案名稱與標準模組同名造成遮蔽
fix: pip install 正確的套件；用 python -m pip 確保裝在同一個直譯器；檢查 sys.path；避免把自己的檔案命名成 random.py 之類
## go-build | go | root
re: (?:go: (?:downloading|finding)[^\n]*|cannot find package ["'](?<p>[^"']+)["']|no required module provides package (?<p>\S+)|go: (?<m>[^\n]*(?:missing go\.sum entry|checksum mismatch|module lookup disabled)[^\n]*)|[^\s:]+\.go:\d+:\d+: (?<e>undefined: \S+|imported and not used[^\n]*|declared (?:and|but) not used[^\n]*))
what: Go 建置問題：{e}{p}{m}。
cause: undefined：沒 import 或拼錯；imported and not used：import 了沒用（Go 視為錯誤）；找不到套件：沒 go get 或 go.mod 缺少；checksum 問題：go.sum 需要更新
fix: go mod tidy 補齊或清理相依；go get 套件@版本；刪掉未使用的 import 或變數
