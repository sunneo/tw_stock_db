# 建置錯誤規則：BitBake／Yocto／OpenEmbedded
# BitBake 的輸出以 ERROR:／WARNING:／NOTE: 開頭；任務失敗時，建置的子程序輸出會以「| 」開頭印出（診斷引擎會去掉這個前綴再比對）。
## bb-task-failed-exec | any | cascade!
re: ERROR: (?<recipe>[A-Za-z0-9_.+-]+?)(?:-[0-9][^\s]*)?-r\d+ do_(?<task>[a-z_]+): (?:ExecutionError|Execution of ['"][^'"]*run\.do_[a-z_]+\.\d+['"] failed with exit code (?<code>\d+))
what: 配方 {recipe} 的 do_{task} 任務失敗。這一行只告訴你「哪個任務失敗」；真正的原因在它上面以「| 」開頭的輸出裡。
cause: 任務執行的 shell／Python 腳本裡有一個命令失敗
fix: 先看失敗訊息緊接著的 "Logfile of failure stored in:" 那個檔案（tmp/work/…/{recipe}/…/temp/log.do_{task}）
fix: 往上找第一個 error: 或 not found；用 bitbake -c cleansstate {recipe} 清乾淨再重跑確認不是舊狀態；bitbake -e {recipe} 看變數展開
fix: 要進去手動除錯：bitbake -c devshell {recipe}（或 devpyshell）
## bb-task-failed-summary | any | cascade!
re: ERROR: Task \((?<f>[^)]+?):do_(?<task>[a-z_]+)\) failed with exit code ['"]?(?<code>\d+)['"]?
what: 任務 do_{task}（{f}）失敗（連帶結果）。
cause: 上面該任務的某個命令失敗
fix: 找同一個配方上方的 "ERROR: …do_{task}" 與 log.do_{task}
## bb-nothing-provides
re: ERROR: Nothing (?<kind>PROVIDES|RPROVIDES) ['"](?<p>[^'"]+)['"](?: \((?<by>[^)]+)\))?
what: 沒有任何配方提供 {p}（{by}）。依賴它的配方沒辦法建置。
cause: 提供它的 layer 沒有加進 bblayers.conf
cause: 拼錯名稱，或 DEPENDS／RDEPENDS 的名稱與實際 PROVIDES 不同
cause: 配方存在但被跳過（COMPATIBLE_MACHINE、PNBLACKLIST、授權、版本不符）
cause: 版本（PV）指定不存在
fix: bitbake-layers show-recipes {p} 與 bitbake-layers show-layers 檢查；用 layers.openembedded.org 搜尋哪個 layer 有它
fix: 把缺少的 layer 加入（bitbake-layers add-layer）；修正 DEPENDS 的名稱
## bb-no-buildable-providers
re: ERROR: Required build target ['"](?<t>[^'"]+)['"] has no buildable providers\.\s*Missing or unbuildable dependency chain was: \[(?<chain>[^\]]+)\]
what: 要建置的目標 {t} 無法建置：相依鏈 [{chain}] 裡有配方找不到或被跳過。
cause: 鏈尾端的配方不存在、被標為不相容（COMPATIBLE_MACHINE／COMPATIBLE_HOST）或在黑名單
cause: 授權不被接受（LICENSE_FLAGS 沒有加入 LICENSE_FLAGS_ACCEPTED）
fix: 看鏈的最後一項，用 bitbake -e 或 bitbake-layers show-recipes 查它為什麼被跳過（NOTE: skipping 的訊息會寫原因）
## bb-skipped
re: NOTE: Skipping recipe (?<r>\S+) because: (?<why>.+)|ERROR: .* (?:was skipped|is skipped): (?<why>.+)
what: 配方 {r} 被跳過：{why}。
cause: 設定了 COMPATIBLE_MACHINE／COMPATIBLE_HOST／PNBLACKLIST（SKIP_RECIPE），或授權旗標沒接受
fix: 依原因調整：換機器設定、移除黑名單、在 local.conf 加 LICENSE_FLAGS_ACCEPTED
## bb-multiple-providers
re: ERROR: Multiple .bb files are due to be built which each provide (?<p>\S+)|NOTE: multiple providers are available for (?<p>\S+)
what: 有多個配方都提供 {p}，BitBake 不知道選哪個。
cause: 兩個 layer 都有同名或同 PROVIDES 的配方
fix: 在 local.conf 或 machine／distro 設定指定：PREFERRED_PROVIDER_{p} = "<配方名>"（版本用 PREFERRED_VERSION_<配方> = "1.2%"）
## bb-fetch-checksum
re: (?:ERROR: .*do_fetch: )?(?:Checksum failure encountered with download of (?<u>\S+)|(?:The )?SRC_URI checksums? (?:do not match|mismatch)|ERROR: [^\n]*do_fetch: Bitbake Fetcher Error: Checksum mismatch|sha256sum mismatch|md5sum mismatch|ERROR: [^\n]*(?:No checksum specified|Missing checksum))
what: 下載的來源 {u} 的雜湊值與配方記錄的不一致（或配方沒有記錄雜湊值）。
cause: 上游把同一個版本的壓縮檔重新打包或被替換（也可能是被竄改）
cause: 下載不完整、被代理伺服器改寫成錯誤頁面
cause: 配方裡的 SRC_URI[sha256sum] 打錯或升版後沒更新
fix: 先確認不是下載壞掉：刪掉 DL_DIR 裡的檔案再抓；確認上游確實有變更再更新配方的 SRC_URI[sha256sum]（錯誤訊息會印出實際值）
fix: 不要為了「讓它通過」亂改雜湊，先確認來源可信
## bb-fetch-failure
re: (?:ERROR: .*do_fetch: )?(?:Fetcher failure: (?<m>[^\n]+)|Fetcher failure for URL: ['"](?<u>[^'"]+)['"]|Unable to fetch URL from any source|Bitbake Fetcher Error: (?<m>[^\n]+)|FetchError\((?<m>[^)]+)\)|Failed to fetch URL (?<u>\S+))
what: 下載來源失敗：{u}{m}。
cause: 網路不通、DNS 或代理設定不對、需要憑證的內部網站
cause: 上游檔案已搬移或刪除（404）
cause: git 的分支或 tag 不存在、SRCREV 的 commit 不在 branch 上
cause: 防火牆擋 git:// 協定，需改用 https
fix: 先在同一台機器手動 curl／git clone 該 URL 確認；設定 http_proxy／https_proxy、BB_NO_NETWORK、MIRRORS；git:// 改 protocol=https
fix: 上游搬家就更新 SRC_URI；git 來源檢查 branch= 與 SRCREV
## bb-fetch-git
re: fatal: (?:unable to access|Could not resolve host|repository ['"][^'"]*['"] not found|could not read Username|Authentication failed|early EOF)[^\n]*|fatal: Remote branch (?<b>\S+) not found|fatal: reference is not a tree: (?<r>[0-9a-f]+)
what: git 取得來源失敗（網路、認證、分支或 commit 不存在）。
cause: 無法連線或解析主機；私有倉庫缺認證；分支被刪；SRCREV 指到的 commit 不在 branch 上（被 force push 改寫）
fix: 檢查網路與代理；私有倉庫設定 SSH 金鑰或 token；確認 branch 與 SRCREV；必要時加 nobranch=1（只在確定時）
## bb-patch-failed
re: ERROR: .*do_patch: (?:Applying patch (?<p>\S+) failed|Command Error: ['"]?quilt|Patch (?<p>\S+) does not apply)|Hunk #\d+ FAILED at \d+|patch: \*\*\*\* |can't find file to patch at input line|1 out of \d+ hunks? FAILED|Patch (?<p>\S+) does not apply
what: 補丁 {p} 套用失敗：補丁內容與目前的原始碼對不上。
cause: 升級了上游版本，舊補丁的前後文已改變
cause: 補丁的路徑層級（-p 數）不對，找不到要改的檔案
cause: 兩個補丁改同一處；或原始碼已經包含這個修正
fix: 看 log.do_patch 的 "Hunk FAILED" 與 .rej 檔；用 devtool modify <配方> 進去重做補丁；不再需要的補丁就移除；路徑層級用 ;striplevel=N
## bb-unpack
re: ERROR: .*do_unpack: (?:Unpack failed|Failed to unpack|Unable to extract|unrecognized archive format)[^\n]*|tar: (?:Error is not recoverable|This does not look like a tar archive)|gzip: stdin: not in gzip format
what: 解開來源壓縮檔失敗。
cause: 下載的檔案其實不是壓縮檔（常是 HTML 錯誤頁面或 Git LFS 指標檔），或下載一半
cause: 檔案格式與 SRC_URI 的副檔名不符
fix: 看 DL_DIR 裡的檔案（file 檔名）；刪掉重抓；確認 URL 直接給檔案
## bb-configure | any | cascade!
re: ERROR: .*do_configure: (?:Execution of|Failed|ExecutionError)[^\n]*|ERROR: .*do_configure: .* configure failed|ERROR: .*do_configure: (?:oe_runconf|autotools_do_configure|cmake_do_configure) failed
what: 配方的 do_configure（設定階段）失敗。
cause: 缺少相依的函式庫或工具（見 configure: error 或 CMake Error 訊息）
cause: 交叉編譯時偵測到的主機環境不對
fix: 看 config.log（在 tmp/work/…/build 或 ${B} 內）或 CMake 的 CMakeError.log；缺什麼就在 DEPENDS 加上；有些功能可用 PACKAGECONFIG 或 EXTRA_OECONF 關閉
## bb-compile-failed | any | cascade!
re: ERROR: .*do_compile: (?:oe_runmake failed|Execution of|ExecutionError|Error executing a python function)[^\n]*|ERROR: oe_runmake failed
what: 配方的 do_compile（編譯）失敗。oe_runmake failed 只是 make 失敗的包裝，原因在上面的編譯器訊息。
cause: 原始碼有錯誤（新編譯器更嚴格）、缺標頭、交叉編譯路徑錯誤
fix: 往上找第一個 error:（gcc 錯誤、undefined reference 等）依它處理；常見修正：在配方補 DEPENDS、加補丁、調整 EXTRA_OEMAKE／CFLAGS
## bb-install
re: ERROR: .*do_install: (?:Execution of|ExecutionError)[^\n]*|install: cannot (?:stat|create)[^\n]*['"‘](?<f>[^'"’]+)['"’]: (?<why>No such file or directory|Permission denied)|cp: cannot (?:stat|create)[^\n]*['"‘](?<f>[^'"’]+)['"’]: No such file or directory
what: do_install（安裝到暫存根目錄 ${D}）失敗：找不到要安裝的 {f}（{why}）。
cause: do_compile 沒有產生那個檔案，或檔名／路徑與配方寫的不同
cause: 上游的 make install 需要額外變數（DESTDIR、prefix）
cause: 目的資料夾沒有先 install -d 建立
fix: 看 ${B} 或 ${S} 裡實際有什麼檔案；配方 do_install 用 install -d ${D}${bindir} 再 install -m 0755；make install 要傳 DESTDIR=${D}
## bb-qa-installed-vs-shipped
re: QA Issue: (?<p>\S+): Files/directories were installed but not shipped in any package:\s*(?<files>.*)|\[installed-vs-shipped\]
what: 有檔案被安裝了，但沒有被任何套件（package）收錄：{files}
cause: 配方 do_install 裝了新的檔案或資料夾，但 FILES:${PN} 沒有涵蓋
cause: 上游新版多裝了檔案
fix: 把它加進適當的套件：FILES:${PN} += "路徑"（開發檔進 ${PN}-dev）；不要的檔案在 do_install:append 刪掉
## bb-qa-ldflags
re: QA Issue: [^\n]*No GNU_HASH in the ELF binary[^\n]*|QA Issue: [^\n]*\[ldflags\]|File .* in package .* doesn't have GNU_HASH
what: 二進位檔沒有使用建置系統傳入的 LDFLAGS（缺少 GNU_HASH）。
cause: 配方或上游的 Makefile 忽略了環境變數 LDFLAGS，自己寫死連結旗標
fix: 讓建置使用 ${LDFLAGS}（EXTRA_OEMAKE += 'LDFLAGS="${LDFLAGS}"'）；或在補丁修好；萬不得已才用 INSANE_SKIP:${PN} += "ldflags"
## bb-qa-textrel
re: QA Issue: [^\n]*(?:ELF binary has relocations in \.text|\[textrel\])
what: 二進位檔的 .text 區段有重定位（textrel），通常代表沒用位置獨立程式碼（PIC）。
cause: 組合語言或 C 沒有 -fPIC，或靜態函式庫以非 PIC 編譯
fix: 加 -fPIC；修好組合語言；確實無法時 INSANE_SKIP:${PN} += "textrel"（先確認安全影響）
## bb-qa-already-stripped
re: QA Issue: [^\n]*(?:already-stripped|File '[^']+' from [^\n]* was already stripped)
what: 這個檔案在放進套件前已被 strip 過，BitBake 沒辦法產生除錯套件。
cause: 上游 Makefile 的 install 規則用了 install -s 或 strip
fix: 改用不 strip 的 install（拿掉 -s、傳 STRIP=true）；或 INSANE_SKIP:${PN} += "already-stripped"
## bb-qa-file-rdeps
re: QA Issue: [^\n]*(?:file-rdeps|contains \S+ which is provided by|requires? \S+ but no providers found in RDEPENDS)
what: 執行時依賴的程式／函式庫沒有出現在這個套件的 RDEPENDS。
cause: 這個套件的檔案（腳本或二進位）需要別的套件，但配方沒宣告
fix: 在配方加 RDEPENDS:${PN} += "<提供它的套件>"
## bb-qa-dev-so
re: QA Issue: [^\n]*non -dev/-dbg/nativesdk- package contains symlink \.so|\[dev-so\]
what: 非 -dev 套件包含了指向 .so 的符號連結（開發用的連結）。
cause: libfoo.so 這種符號連結只該出現在 -dev 套件
fix: 把 ${libdir}/*.so 放進 FILES:${PN}-dev；或確實要在主套件時用 FILES_SOLIBSDEV = ""
## bb-qa-license-checksum
re: ERROR: .*do_populate_lic: .*(?:LIC_FILES_CHKSUM|license checksum)|LIC_FILES_CHKSUM[^\n]*(?:md5|checksum)[^\n]*(?:does not match|mismatch|changed)|The new md5 checksum is (?<new>[0-9a-f]+)|\[license-checksum\]|license-checksum
what: 授權檔案的雜湊值與配方的 LIC_FILES_CHKSUM 不符（授權文字被改過）。
cause: 上游升版時更改了授權檔案內容（可能換授權、更新年份或換行）
cause: LIC_FILES_CHKSUM 指的檔案路徑或行範圍不對
fix: 打開授權檔看實際變動；確認授權沒有實質改變（或 LICENSE 欄位需要更新）後，把 LIC_FILES_CHKSUM 換成新值（訊息裡有新的 md5：{new}）
## bb-qa-arch
re: QA Issue: [^\n]*Architecture did not match \((?<got>[^,]+), expected (?<exp>[^)]+)\)|\[arch\]
what: 二進位的架構（{got}）與目標架構（{exp}）不符。
cause: 配方用了主機工具鏈編譯，或上游 Makefile 忽略了交叉編譯器設定
cause: 預先編好的二進位（來自上游）是別的架構
fix: 確認 CC／CXX／CFLAGS 來自 BitBake（EXTRA_OEMAKE += "CC='${CC}'"）；預編譯二進位要依 COMPATIBLE_HOST 限制
## bb-qa-buildpaths
re: QA Issue: [^\n]*contains reference to TMPDIR|\[buildpaths\]|QA Issue: [^\n]*(?:host-user-contaminated|\[host-user-contaminated\])
what: 產出的檔案裡含有建置主機的路徑（TMPDIR），或擁有者是建置者本人。
cause: 上游把絕對路徑編進程式（__FILE__、除錯資訊、設定檔）
cause: 安裝時保留了建置使用者的擁有者
fix: 讓安裝不保留擁有者（install -o root -g root，或 cp --no-preserve=ownership）；加 -fdebug-prefix-map；必要時用 INSANE_SKIP
## bb-qa-useless-rpaths
re: QA Issue: [^\n]*(?:contains probably-redundant RPATH|\[useless-rpaths\]|invalid RPATH|\[rpaths\])
what: 二進位含有多餘或不正確的 RPATH。
cause: 上游連結時加了 -rpath 指向建置目錄
fix: 連結時不要加 -rpath（CMake 用 CMAKE_SKIP_RPATH=ON）；或用 chrpath 移除
## bb-qa-fatal | any | cascade!
re: ERROR: .*do_package_qa: Fatal QA errors? (?:were )?found|ERROR: .*do_package_qa: QA Issue
what: 套件品質檢查（QA）有致命的問題，詳細項目在上面的 "QA Issue: …[類型]" 訊息。
fix: 逐條看 QA Issue 後面的方括號類型（例如 installed-vs-shipped、ldflags、file-rdeps），依各類型處理；不要預設跳過 QA
## bb-rootfs-install
re: ERROR: .*do_rootfs: (?:Unable to install packages|Could not invoke dnf|Transaction check error|Cannot satisfy the following dependencies|Problem: package \S+ requires)[^\n]*|(?:Unable to find a match|No package ['"]?(?<p>\S+?)['"]? available|Cannot find (?:package|any package matching) ['"]?(?<p>\S+?)['"]?)|Solver encountered \d+ problem|nothing provides (?<p>\S+) needed by
what: 組 rootfs 時安裝套件失敗：套件 {p} 找不到，或相依無法滿足。
cause: IMAGE_INSTALL 寫了不存在的套件名（執行期套件名與配方名常不同）
cause: 套件被建出來但沒有 package feed（do_package_write 沒執行或被排除）
cause: 兩個套件互相衝突，或需要的相依沒有套件提供
fix: 用 oe-pkgdata-util list-pkgs 與 bitbake -g 檢查套件名；確認配方有建置成功並產生 -dev／主套件；解決衝突套件（RCONFLICTS）
## bb-rootfs-conflict
re: ERROR: .*do_rootfs: .*(?:conflicts with file from package|file \S+ from install of \S+ conflicts)|Transaction check error:\s*file (?<f>\S+) conflicts
what: 兩個套件都包含檔案 {f}，安裝進 rootfs 時衝突。
fix: 讓其中一個套件不要安裝該檔案（FILES 調整或 do_install:append 刪除）；或宣告 RCONFLICTS 讓兩者不同時安裝
## bb-parse-error
re: ERROR: ParseError at (?<f>\S+?):(?<ln>\d+): (?<m>[^\n]+)|ERROR: (?:Unable to parse|Failed to parse recipe) (?<f>\S+)|ParseError: (?<m>.*unparsed line[^\n]*)
what: 解析配方／設定檔失敗：{f} 第 {ln} 行：{m}
cause: 語法錯誤（引號未配對、縮排用空白造成 Python 縮排錯、多餘字元）
cause: 設定檔被合併衝突標記弄壞
fix: 看該行與上一行；BitBake 變數值要用引號；Python 函式內縮排要一致；用 bitbake -e 看是否能展開
## bb-expansion-error
re: ExpansionError: Failure expanding variable (?<v>\S+)[^\n]*|bb\.data_smart\.ExpansionError|NameError: name ['"](?<n>\w+)['"] is not defined|FileNotFoundError: [^\n]*inherit
what: 變數 {v} 展開失敗（BitBake 的設定計算出錯）。
cause: 變數裡的 Python 運算式有錯，或引用了不存在的變數／函式
fix: 看 Traceback 最底下的真正例外；用 bitbake -e <配方> | grep ^{v}= 檢視
## bb-inherit
re: ERROR: (?:Could not inherit file classes/(?<c>[\w-]+)\.bbclass|ParseError[^\n]*Could not inherit file (?<c>\S+))|Could not inherit file
what: 找不到要繼承的 class（{c}.bbclass）。
cause: 提供這個 class 的 layer 沒有加入，或 class 名稱拼錯
cause: BBFILES／BBPATH 沒涵蓋它
fix: 加入對應的 layer（bitbake-layers add-layer）；檢查 inherit 的名稱
## bb-layer-compat
re: ERROR: Layer ['"](?<l>[^'"]+)['"] depends on layer ['"](?<d>[^'"]+)['"], but this layer is not enabled|ERROR: Layer ['"](?<l>[^'"]+)['"] (?:is not compatible with the core layer|does not support the current series)|LAYERSERIES_COMPAT_\S+|LAYERDEPENDS_\S+
what: layer {l} 的相依或相容性有問題（依賴 {d} 但沒啟用，或不支援目前的 Yocto 版本）。
cause: bblayers.conf 少了相依的 layer
cause: layer 的分支與 poky 的版本代號（kirkstone、scarthgap…）不一致
fix: 把 {d} 加入 bblayers.conf；切到與 poky 相同版本代號的分支；必要時調整 LAYERSERIES_COMPAT（確認相容後）
## bb-sanity
re: ERROR: (?:OE-core's config sanity checker detected a potential misconfiguration|Your system needs to support the (?<loc>[\w.-]+) locale|Do not use Bitbake as root|Required host tools? (?:missing|are missing)|The following required tools[^\n]*|Please install the following missing utilities: (?<tools>[^\n]+))|Your host distribution[^\n]*|BitBake can't be run as root
what: BitBake 的環境檢查（sanity check）沒通過：{tools}{loc}。
cause: 主機缺少必要的工具（git、gcc、make、chrpath、diffstat、texinfo…）或不支援 en_US.UTF-8 locale
cause: 以 root 身分執行 BitBake（不允許）
cause: 沒有先 source oe-init-build-env
fix: 依訊息安裝缺少的套件；locale-gen en_US.UTF-8；改用一般使用者；先 source poky/oe-init-build-env
## bb-disk-space
re: ERROR: No space left on device|(?:WARNING|ERROR): The free (?:disk )?space on [^\n]*(?:is running low|has fallen below)|Insufficient free space|BB_DISKMON|OSError: \[Errno 28\]|No space left on device
what: 磁碟空間不足，BitBake 中止建置（或警告）。
cause: Yocto 建置需要非常多空間（TMPDIR 與 DL_DIR、SSTATE_DIR 常達上百 GB）
cause: inode 用完（大量小檔案）
fix: 清出空間（rm_work：INHERIT += "rm_work"）；把 TMPDIR／SSTATE／DL_DIR 放到大的磁碟；清掉舊的 sstate；用 df -h 與 df -i 檢查
## bb-taskhash
re: ERROR: .*Taskhash mismatch (?<a>[0-9a-f]+) versus (?<b>[0-9a-f]+) for \S+|Taskhash mismatch
what: 任務雜湊值前後不一致（sstate／signature 不穩定）。
cause: 配方裡有不確定的內容（時間、絕對路徑、機器相關變數）影響簽章
cause: 建置過程中修改了配方或設定
fix: 用 bitbake-diffsigs 比較兩次簽章找差異；修成確定性的寫法；必要時清除該配方的 sstate
## bb-python-func
re: ERROR: .*(?:Error executing a python function in|Python function (?<f>\S+) finished with exit code)[^\n]*|ERROR: Traceback \(most recent call last\):
what: BitBake 配方中的 Python 函式出錯。
cause: 函式裡的 Python 例外（拼字、None 呼叫、路徑不存在）
fix: 看 Traceback 最底下的例外類型與行號；bitbake -c <task> -v <配方> 重現
## bb-server
re: ERROR: (?:Unable to connect to bitbake server|Server (?:has )?(?:died|timeout)|Bitbake server didn't start)|bitbake-server[^\n]*(?:Address already in use|died)|ERROR: Only one copy of bitbake should be run against a build directory
what: BitBake 伺服器啟動或連線失敗，或同一個建置資料夾已有另一個 BitBake 在跑。
fix: 等前一個 bitbake 結束，或清掉殘留（bitbake.lock、bitbake.sock）；確認沒有殘留行程（pkill -f bitbake）
## bb-network-disabled
re: (?:ERROR: .*)?(?:BB_NO_NETWORK|Network access disabled through BB_NO_NETWORK|the fetcher[^\n]*cannot access the network)
what: 設定了禁止網路（BB_NO_NETWORK），但需要下載來源。
fix: 先在可連網環境把來源抓進 DL_DIR（bitbake --runall=fetch <目標>）；或放行網路
## bb-oom
re: (?:WARNING|ERROR): (?:Memory|Out of memory)[^\n]*|Cannot allocate memory|virtual memory exhausted: (?:Cannot allocate memory)?|The following processes? (?:were )?(?:killed|terminated)
what: 建置過程記憶體不足。
cause: BB_NUMBER_THREADS 與 PARALLEL_MAKE 太高，同時編譯太多大型專案（如 chromium、qtwebengine、llvm）
fix: 降低 BB_NUMBER_THREADS／PARALLEL_MAKE；增加 swap；單獨先建置大型配方
