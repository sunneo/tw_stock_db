# 日誌診斷規則：Linux 核心日誌（dmesg／kernel log）、kernel panic／Oops、systemd／journal、gdb 訊息、執行期錯誤
# 系統名：kernel、panic、journal、gdb、runtime；規則 re 的具名群組 errno（數字）會自動附上錯誤碼意義
## panic-not-syncing | any | root!
re: Kernel panic - not syncing: (?<why>[^\n]+)
what: 核心 panic（系統停擺）：{why}。這是 panic 的結論行，原因看它上面最後幾十行（Oops、BUG、Call Trace、驅動訊息）與括號內的原因。
cause: 核心遇到無法恢復的錯誤；或根檔案系統掛載失敗、init 行程死掉
fix: 先看 panic 訊息後面的原因文字；往上找第一個 Oops／BUG／WARNING 與 Call Trace；panic 前的最後一個驅動訊息常是線索
fix: 要抓完整記錄：序列主控台（console=ttyS0／ttyAMA0）、netconsole、pstore／ramoops、kdump
fix: 在 QEMU 可加 -no-reboot 讓 panic 後停住不重開
## panic-vfs-mount-root | any | root!
re: VFS: Unable to mount root fs on (?:unknown-block\((?<maj>\d+),(?<min>\d+)\)|(?<dev>\S+))|Cannot open root device ["'‘]?(?<dev>[^"'’ ]+)["'’]? or unknown-block\((?<maj>\d+),(?<min>\d+)\)
what: 核心找不到或不能掛載根檔案系統（root device {dev}，主次編號 {maj},{min}）。
cause: 核心沒有內建儲存裝置的驅動（virtio-blk、mmc、nvme、ahci）或檔案系統（ext4、squashfs），而 initramfs 沒提供
cause: root= 參數寫錯（裝置名稱、PARTUUID），或裝置還沒準備好（需要 rootwait）
cause: 磁碟映像是空的、損壞，或格式不是核心認得的
cause: 裝置樹／機型不符，儲存控制器沒有被啟用
fix: 看上面的 "Please append a correct root= boot option; here are the available partitions:" 列表，它列出核心實際看到的區塊裝置
fix: 開啟驅動與檔案系統為內建（=y，不是 =m）：例如 CONFIG_VIRTIO_BLK、CONFIG_EXT4_FS、CONFIG_DEVTMPFS
fix: 加 rootwait；QEMU 例：-drive file=rootfs.img,if=none,format=raw,id=hd0 -device virtio-blk-device,drive=hd0 -append "root=/dev/vda rw console=ttyAMA0"
## panic-kill-init | any | root!
re: Attempted to kill init! exitcode=0x(?<code>[0-9a-fA-F]+)
what: 第一個使用者行程（init，PID 1）結束了，核心只好 panic（exitcode=0x{code}：高位元組是退出碼，低位元組是訊號編號，例如 0x00007f00＝退出碼 127、0x0000000b＝被訊號 11 SIGSEGV 殺掉）。
cause: init 執行檔存在，但缺少它需要的動態函式庫或直譯器（退出碼 127）
cause: rootfs 的架構與核心不符（用 x86 的 rootfs 跑 ARM），或 libc 與核心不相容
cause: init 本身當掉（SIGSEGV／SIGILL）或啟動腳本失敗
fix: 用 init=/bin/sh 開機進入 shell 檢查；file /sbin/init 與 readelf -l 看它要的 interpreter；ldd 看缺少的函式庫；確認 rootfs 與目標架構相同
## panic-no-init | any | root!
re: (?:No working init found|Failed to execute (?<p>/\S+)(?: \(error (?<errno>-?\d+)\))?|Run /(?<p>\S+) as init process|Kernel panic - not syncing: No working init found)
what: 核心找不到可以執行的 init（{p}）。
cause: rootfs 裡沒有 /sbin/init、/etc/init、/bin/init、/bin/sh，或沒有執行權限
cause: 檔案存在但格式或架構不對（error -8 Exec format error）、缺直譯器（error -2 ENOENT 常指找不到動態連結器）
cause: 根檔案系統是空的或掛錯
fix: 檢查 rootfs 內容與權限；用 init=/path 指定；error -2 時檢查 ELF 的 interpreter 是否存在於 rootfs
## panic-initial-console
re: Warning: unable to open an initial console|Failed to open /dev/console|Warning: unable to open an initial console\.
what: 核心開不了 /dev/console：根檔案系統沒有主控台裝置節點。
cause: initramfs 或 rootfs 沒有 /dev/console（需要 devtmpfs 或事先建立）
fix: 開啟 CONFIG_DEVTMPFS 與 CONFIG_DEVTMPFS_MOUNT；initramfs 內預先建立 mknod -m 622 dev/console c 5 1
## oops-null-deref
re: (?:BUG: unable to handle (?:kernel )?NULL pointer dereference(?: at (?<addr>\S+))?|Unable to handle kernel NULL pointer dereference at virtual address (?<addr>\S+))
what: 核心 Oops：核心程式碼解參照了空指標（位址 {addr}，通常是 0 加上結構成員偏移）。
cause: 驅動或核心程式的 bug：使用了尚未初始化、已釋放或函式回傳 NULL 卻沒檢查的指標
cause: 在 probe／remove／中斷處理的時序問題（還沒初始化就被呼叫）
fix: 位址是小數字代表「NULL 指標加成員偏移」，偏移值可對照結構定義找成員
fix: 看 RIP／PC 那一行的函式與偏移（例如 foo_probe+0x34/0x120）；用 scripts/decode_stacktrace.sh vmlinux 或 gdb vmlinux 的 list *(foo_probe+0x34) 對到原始碼行
fix: 看 Call Trace 往上找第一個你的驅動函式；panic_on_oops 決定是否接著 panic
## oops-paging-request
re: (?:BUG: unable to handle (?:kernel )?paging request at (?<addr>\S+)|Unable to handle kernel paging request at virtual address (?<addr>\S+))
what: 核心 Oops：存取了無法對應到記憶體的位址 {addr}（野指標、已釋放的記憶體、或錯誤的位址計算）。
cause: use-after-free、緩衝區溢位破壞了指標、使用未對應的 MMIO 位址（沒有 ioremap）
cause: 驅動使用了錯誤的裝置樹位址或尚未初始化的資源
fix: 看位址的樣子：0xdead000000000100（LIST_POISON）代表使用了已刪除的鏈結串列節點；0x6b6b6b6b 代表使用已釋放的 slab（開 SLUB_DEBUG／KASAN 驗證）
fix: 用 decode_stacktrace.sh 或 gdb 對應 RIP 到原始碼；開 KASAN 找 use-after-free
## oops-kernel-bug
re: kernel BUG at (?<f>\S+):(?<ln>\d+)!|BUG: (?<kind>sleeping function called from invalid context|scheduling while atomic|spinlock (?:bad magic|lockup suspected|recursion)|Bad page state|workqueue lockup)[^\n]*
what: 核心主動回報 BUG（{f}:{ln} {kind}）：程式碼違反了核心的規則。
cause: BUG_ON() 條件成立（資料結構被破壞）
cause: 在不能睡眠的環境（中斷、持有 spinlock）呼叫了會睡眠的函式（sleeping function called from invalid context）
fix: 對照該行原始碼的 BUG_ON／might_sleep 條件；睡眠問題改用 GFP_ATOMIC 或把工作延後到 workqueue
## oops-warning
re: WARNING: CPU: (?<cpu>\d+) PID: (?<pid>\d+) at (?<f>\S+):(?<ln>\d+) (?<fn>\S+)
what: 核心 WARN_ON 觸發（{f}:{ln} 的 {fn}）：不致命，但表示出現了「不該發生」的狀況，後面的 Call Trace 是呼叫路徑。
fix: 看 WARN 附近的原始碼條件與 Call Trace；通常是驅動使用 API 的方式不對；若重複出現要修
## oops-internal-error
re: Internal error: (?<k>Oops[^\n]*|synchronous external abort[^\n]*|Attempting to execute userspace memory[^\n]*|undefined instruction[^\n]*|SError[^\n]*)
what: ARM／ARM64 核心 Oops：{k}。
cause: Oops：核心 bug；synchronous external abort：存取了不存在或沒供電的週邊暫存器（MMIO 位址錯、時脈或電源沒開）；undefined instruction：執行了不支援的指令
fix: 看 pc 與 lr 暫存器所指的函式；external abort 檢查週邊的時脈、reset、電源與裝置樹位址；用 addr2line -e vmlinux <pc>
## kasan
re: BUG: KASAN: (?<k>[a-z-]+) in (?<fn>\S+)
what: KASAN（核心記憶體檢查）偵測到 {k}，發生在 {fn}。
cause: use-after-free（用已釋放的記憶體）、slab-out-of-bounds（超出配置範圍）、global-out-of-bounds、stack-out-of-bounds、double-free
fix: 報告裡有「Allocated by／Freed by」兩段呼叫堆疊：看誰配置、誰釋放，與目前存取的位置比對
## lockdep
re: WARNING: (?<k>possible circular locking dependency detected|possible recursive locking detected|inconsistent lock state|possible irq lock inversion dependency detected)|INFO: possible (?<k>circular locking dependency|recursive locking)
what: lockdep 偵測到鎖的使用有死鎖風險：{k}。
cause: 兩條路徑以相反順序取得兩把鎖；或在中斷裡取了不是 irq-safe 的鎖
fix: 看報告裡列出的鎖與各自的取得堆疊，統一取鎖順序；中斷共用的鎖用 spin_lock_irqsave
## soft-lockup
re: (?:watchdog: )?BUG: soft lockup - CPU#(?<c>\d+) stuck for (?<s>\d+)s! \[(?<p>[^\]]+)\]
what: CPU {c} 被 {p} 佔住超過 {s} 秒沒有排程（soft lockup）：核心程式碼在迴圈裡出不來。
cause: 驅動在 spin 等待硬體永遠沒回應；無限迴圈；關閉了搶佔太久
fix: 看後面的 Call Trace 與 RIP，找出卡在哪個函式；等硬體的迴圈要加逾時
## hung-task
re: INFO: task (?<t>\S+):(?<pid>\d+) blocked for more than (?<s>\d+) seconds
what: 行程 {t}（{pid}）被卡住超過 {s} 秒（hung task）：處於不可中斷睡眠（D 狀態）。
cause: 等待磁碟、NFS 或裝置 I/O 沒有回應
cause: 等一把一直沒釋放的 mutex／rwsem（死鎖）
fix: 看 Call Trace 的最上層：在等 I/O（io_schedule、wait_on_page）→ 查儲存或網路磁碟；在等鎖（mutex_lock、rwsem_down）→ 找持有者；echo w > /proc/sysrq-trigger 傾印所有被卡住的任務
## rcu-stall
re: rcu(?:_sched|_preempt)?(?:: )?(?:INFO: )?(?:self-detected stall on CPU|detected stalls on CPUs/tasks)
what: RCU 偵測到 CPU 長時間沒有回報靜止狀態（stall）：該 CPU 被卡住或中斷風暴。
cause: 核心程式在不可搶佔區域跑太久、中斷處理太久、CPU 被虛擬機管理程式排擠
fix: 看緊接的 stack（"Task dump for CPU"）找出卡住的程式；虛擬機環境檢查主機是否過載
## oom-killer
re: (?:invoked oom-killer|Out of memory: (?:Killed|Kill) process (?<pid>\d+) \((?<name>[^)]+)\)|oom-kill:constraint=(?<c>\w+))
what: 系統記憶體耗盡，OOM killer 強制殺掉行程{name}（pid {pid}）以救回系統（範圍：{c}）。
cause: 某個行程記憶體洩漏或需求過大；系統（或 cgroup／容器）記憶體上限太小；沒有 swap
fix: 看報告裡的記憶體表（各行程的 rss）與 "Memory cgroup out of memory" 是否為容器上限；調高限制、修洩漏、加 swap；用 vm.overcommit_memory、oom_score_adj 保護關鍵行程
## userspace-segfault
re: (?<name>[\w.+-]+)\[(?<pid>\d+)\]: (?:segfault|trap invalid opcode|general protection fault)[^\n]*? at (?<addr>[0-9a-fA-Fx]+) ip (?<ip>[0-9a-fA-Fx]+) sp (?<sp>[0-9a-fA-Fx]+) error (?<err>\d+)(?: in (?<lib>\S+))?
what: 使用者空間的程式 {name}（{pid}）當掉：存取位址 {addr}，指令位址 {ip}，在 {lib} 裡（錯誤位元 {err}）。
cause: error 4＝讀取未映射位址、6＝寫入未映射位址、7＝寫入唯讀或權限不足；位址接近 0 代表空指標；ip 在 libc 內常是傳入壞指標
fix: 用 addr2line -e <執行檔或函式庫> -f <ip 減函式庫載入基底>（ip 要換算成模組內偏移）；用 gdb 與 core dump（ulimit -c unlimited）看回溯；用 valgrind／ASan 抓出原因
## disk-io-error
re: (?:blk_update_request: (?:critical )?I/O error, dev (?<d>\S+), sector (?<sec>\d+)|Buffer I/O error on dev (?<d>\S+)|ata\d+(?:\.\d+)?: (?:exception|failed command: (?<cmd>[A-Z ]+))|print_req_error: I/O error|nvme\d+: (?:I/O \d+ QID \d+ timeout|controller is down))
what: 儲存裝置 {d} 發生 I/O 錯誤（sector {sec}）。
cause: 磁碟壞軌或即將損壞、排線或電源不良、USB 隨身碟拔除、控制器逾時
cause: 虛擬磁碟（映像檔）所在的主機磁碟空間用完
fix: 用 smartctl -a 看 SMART；備份資料；換線與換埠；檔案系統 fsck；確認虛擬磁碟的底層沒有滿
## fs-error
re: (?:EXT4-fs (?:error )?\((?<d>[^)]+)\)[^\n]*|XFS \((?<d>[^)]+)\): [^\n]*(?:Corruption|corrupt|metadata I/O error)[^\n]*|BTRFS (?:error|critical) \(device (?<d>\S+)\)[^\n]*|Remounting filesystem read-only|Aborting journal on device (?<d>\S+))
what: 檔案系統 {d} 回報錯誤，系統可能把它改成唯讀（Remounting read-only）。
cause: 底層磁碟 I/O 錯誤、非正常關機造成日誌不一致、檔案系統損毀
fix: 卸載後 fsck（ext4 用 e2fsck -f、XFS 用 xfs_repair）；同時檢查磁碟健康；在嵌入式系統要確認電源穩定與正確關機
## fw-missing
re: (?:Direct firmware load for (?<f>\S+) failed with error (?<errno>-?\d+)|firmware: failed to load (?<f>\S+) \((?<errno>-?\d+)\)|Falling back to sysfs fallback for: (?<f>\S+)|(?<d>\S+): (?:Failed to load firmware|firmware load failed)[^\n]*)
what: 驅動需要韌體檔 {f}，但在 /lib/firmware 找不到（錯誤 {errno}）。
cause: 沒安裝對應的 linux-firmware 套件，或檔名／版本與驅動預期不同
cause: initramfs 沒有把韌體放進去（驅動在 initramfs 階段就需要）
fix: 安裝 linux-firmware 或對應的 firmware 套件；Yocto 用 linux-firmware 或自己的配方；把檔案放到 /lib/firmware/<路徑> 並更新 initramfs
## module-load
re: (?:module (?<m>\S+): (?:Unknown symbol (?<sym>\S+) \(err (?<errno>-?\d+)\)|disagrees about version of symbol (?<sym>\S+)|module verification failed: signature and/or required key missing - tainting kernel|Invalid module format)|(?<m>\S+): version magic ['"](?<a>[^'"]+)['"] should be ['"](?<b>[^'"]+)['"]|insmod: ERROR: could not insert module (?<m>\S+): (?<why>[^\n]+))
what: 載入核心模組 {m} 失敗：{why}{sym}。
cause: 模組不是用這個核心的版本與設定編譯（version magic 或符號 CRC 不符）
cause: 缺少它依賴的其他模組（Unknown symbol）
cause: 啟用了模組簽章強制（需要簽章）
fix: 用目前核心的標頭重新編譯模組；先載入相依模組（modprobe 會自動處理）；modinfo {m} 看 vermagic 與 depends；dmesg 看詳細原因
## driver-probe-failed
re: (?<d>[\w.@:/-]+): probe(?: of (?<d2>\S+))? failed with error (?<errno>-?\d+)|probe of (?<d>\S+) failed with error (?<errno>-?\d+)|(?<d>[\w.@:/-]+): failed to (?<what>[^\n]+?)(?:,| with)? (?:error |err )?(?<errno>-\d+)
what: 驅動 {d} 的 probe（初始化）失敗，錯誤碼 {errno}。
cause: -517（EPROBE_DEFER）不是真的失敗，是相依資源（時脈、電源、gpio）還沒準備好，核心稍後會重試
cause: -2（ENOENT）找不到資源或裝置樹節點；-22（EINVAL）裝置樹屬性值不對；-12（ENOMEM）記憶體不足；-19（ENODEV）裝置不存在；-110（ETIMEDOUT）硬體沒回應
fix: 依錯誤碼處理：看裝置樹（dts）該節點的 compatible、reg、clocks、interrupts、gpios 是否完整正確；確認提供資源的驅動已載入；dmesg 搜尋這個裝置名稱前後的訊息
## dt-missing
re: (?:OF: (?:fdt|Bad ?Ramdisk|no memory)[^\n]*|Failed to find device-?tree|No (?:device tree|DTB) (?:found|provided)|Machine model: (?<m>[^\n]+)|Unable to find matching (?<k>device|machine)[^\n]*)
what: 裝置樹（DTB）有問題或機型不符{m}。
cause: 沒傳入 DTB，或 DTB 與核心／機型不符（compatible 對不上）
fix: 確認開機載入器把正確的 .dtb 放到位址並傳給核心；QEMU 用 -M 對的機型（通常不需要 -dtb），或 -dtb 指定相符的檔案；-machine dumpdtb=x.dtb 可傾印目前機型的 DTB 來比對
## usb-error
re: usb (?<p>[\d.-]+): (?:device descriptor read/\d+, error (?<errno>-?\d+)|device not accepting address \d+, error (?<errno>-?\d+)|unable to enumerate USB device|can't set config #\d+, error (?<errno>-?\d+))
what: USB 裝置 {p} 枚舉失敗（錯誤 {errno}）。
cause: 線材或接頭不良、電源不足、裝置本身故障、供電不穩的 USB 集線器
cause: -71（EPROTO）或 -110（ETIMEDOUT）多半是訊號或電源問題
fix: 換線、換埠、改用有外接電源的集線器；dmesg 看是否反覆出現；lsusb 確認
## net-link
re: (?:NETDEV WATCHDOG: (?<d>\S+) \((?<drv>[^)]+)\): transmit queue (?<q>\d+) timed out|(?<d>\S+): (?:link is not ready|Link is Down)|nf_conntrack: table full, dropping packet|TCP: (?:request_sock_TCP|Possible SYN flooding)[^\n]*)
what: 網路層有問題：{d}（傳送佇列逾時、斷線、或連線追蹤表滿了）。
cause: 網路驅動或硬體卡住、線材斷、對端交換器問題；conntrack 表滿是連線數過多
fix: 檢查線與交換器；ethtool 看速率與連線；調大 nf_conntrack_max 或降低連線數；更新驅動韌體
## mmc-i2c
re: (?:mmc(?<n>\d+): (?:error -(?<errno>\d+) whilst initialising (?<k>\S+) card|Timeout waiting for hardware interrupt|cannot verify signal voltage switch)|i2c i2c-(?<n>\d+): (?<m>[^\n]*(?:timeout|NACK|arbitration lost|No ACK)[^\n]*))
what: 匯流排裝置（SD／MMC 或 I2C）通訊錯誤：{m}{k}。
cause: SD 卡接觸不良或相容性問題、電壓切換失敗；I2C 裝置位址錯、沒接上拉電阻、裝置沒電或沒回應
fix: SD：換卡、降低時脈、檢查裝置樹的電壓與 cd 設定；I2C：i2cdetect -y N 掃描位址、檢查接線與上拉
## hw-error
re: (?:mce: \[Hardware Error\]|\[Hardware Error\]: [^\n]+|EDAC [^\n]*(?:CE|UE) [^\n]*|Machine check events logged|Uncorrected hardware memory error|Memory failure: 0x[0-9a-f]+: [^\n]*)
what: 硬體回報錯誤（記憶體或 CPU：machine check／EDAC）。
cause: 記憶體位元錯誤（可糾正 CE 或不可糾正 UE）、CPU 過熱或供電問題
fix: 可糾正錯誤持續增加要換記憶體條；執行 memtest86+；檢查散熱與電源；記錄 mcelog
## stack-protector
re: stack-protector: Kernel stack is corrupted in: (?<f>\S+)|\*\*\* stack smashing detected \*\*\*|\*\*\* buffer overflow detected \*\*\*|\*\*\* (?<k>glibc detected|Error in)[^\n]*(?:double free|corrupted|invalid pointer)[^\n]*|free\(\): (?<k>invalid pointer|double free detected|corrupted)[^\n]*|malloc\(\): (?<k>corrupted top size|memory corruption)[^\n]*|corrupted (?:size vs\. prev_size|double-linked list)
what: 記憶體被破壞（堆疊或堆積）：{k}{f}。
cause: 緩衝區溢位寫壞了堆疊的 canary 或堆積管理結構；重複 free；使用已釋放的記憶體
fix: 用 AddressSanitizer（-fsanitize=address）或 valgrind 重現；找最近改過的陣列、memcpy、strcpy 邊界；核心版用 KASAN
## refcount
re: refcount_t: (?<k>underflow|overflow|saturated|addition on 0|decrement hit 0); use-after-free
what: 參考計數錯誤（{k}）：典型的 use-after-free 或重複釋放。
fix: 看 Call Trace 與該物件的 get／put 是否成對；開 KASAN 與 DEBUG_OBJECTS 驗證
## systemd-exec-status
re: status=(?<c>2\d\d)/(?<n>[A-Z_]+)|code=exited, status=(?<c>2\d\d)/(?<n>[A-Z_]+)
what: systemd 啟動服務程式「之前」的準備步驟 {n}（狀態 {c}）失敗，程式根本沒有開始執行。
cause: EXEC（203）：ExecStart 的檔案不存在、沒有執行權限、不是有效格式或路徑含空白未加引號
cause: CHDIR（200）：WorkingDirectory 不存在；USER／GROUP（217／216）：指定的使用者或群組不存在
cause: NAMESPACE（226）：PrivateTmp／ReadWritePaths 等沙盒設定的資料夾不存在；CAPABILITIES／SECCOMP／APPARMOR（218／228／231）：安全設定衝突；STDOUT／STDERR（209／222）：日誌輸出設定錯誤；RUNTIME_DIRECTORY／STATE_DIRECTORY（233／238）：資料夾建立失敗
fix: 203：systemctl cat 服務 看 ExecStart，ls -l 該檔案、chmod +x、確認直譯器存在、命令用絕對路徑
fix: 其他看 journalctl -u 服務 的 "Failed at step X spawning" 後面的原因；systemd-analyze verify 檢查單元檔
## systemd-exit-status
re: (?<u>[\w@.-]+\.service): Main process exited, code=(?<how>exited|killed|dumped), status=(?<s>[^\s/]+)(?:/(?<n>\S+))?
what: 服務 {u} 的主行程結束了：{how}，狀態 {s}/{n}。
cause: exited 且狀態非 0：程式自己回報失敗（退出碼 {s}）；killed：被訊號殺掉（{n}，例如 SEGV、KILL、TERM、ABRT）；dumped：被訊號殺掉並產生 core dump
cause: 退出碼 1 一般錯誤、2 用法錯誤、127 命令找不到、137／KILL 常是被 OOM killer 或 systemd 逾時殺掉、139／SEGV 記憶體錯誤
fix: 看同一服務上方的程式自己的輸出：journalctl -u {u} -b；手動用相同使用者與環境執行 ExecStart 重現；coredumpctl 看 core dump
## systemd-failed-result | any | cascade
re: (?<u>[\w@.-]+\.(?:service|socket|mount|timer|target)): (?:Failed with result|Unit entered failed state\.?)(?: ['"](?<r>[^'"]+)['"])?
what: 單元 {u} 失敗（結果：{r}）。這是 systemd 的結論，細節在前面的行。
cause: exit-code：程式非 0 離開；signal：被訊號終止；core-dump：當掉並傾印；timeout：啟動或停止逾時（TimeoutStartSec）；start-limit-hit：重啟太頻繁被禁止；resources：配置資源失敗；watchdog：看門狗逾時；dependency：依賴的單元失敗
fix: 依結果類型處理：timeout 調大 TimeoutStartSec 或檢查程式為何卡住；start-limit-hit 先修好根本原因再 systemctl reset-failed；dependency 去看被依賴的單元
## systemd-start-limit
re: (?<u>[\w@.-]+\.service): Start request repeated too quickly|Failed with result 'start-limit-hit'|start-limit-hit
what: 服務 {u} 在短時間內重啟太多次，systemd 暫時拒絕再啟動（start-limit-hit）。
cause: 服務一啟動就失敗，加上 Restart=always 造成重啟迴圈（超過 StartLimitBurst 次／StartLimitIntervalSec 秒）
fix: 先看每次失敗的原因（journalctl -u 服務）修好；再 systemctl reset-failed 服務；設計上可調整 RestartSec 與 StartLimit 參數
## systemd-dependency
re: Dependency failed for (?<d>[^\n.]+)|(?<u>[\w@.-]+\.(?:service|mount|socket)): (?:Job .* failed|Unit .* not found|Unit (?<x>\S+) could not be found)
what: {d}：依賴的單元失敗或不存在，所以這個單元沒有啟動。
cause: Requires／BindsTo 的單元失敗；掛載點（.mount）失敗連帶其他服務
fix: 往上找真正失敗的那個單元（通常是第一個 Failed）；systemctl list-dependencies 看依賴；檢查 /etc/fstab 的掛載選項（加 nofail）
## systemd-unit-not-found
re: Unit (?<u>\S+?) (?:could not be found|not found|not loaded)|Failed to (?:start|enable|restart) (?<u>\S+): Unit file (?<f>\S+) does not exist|Failed to load unit file|Unit (?<u>\S+) is masked
what: 找不到單元 {u}（沒有安裝、拼錯、或被 mask 封鎖）。
fix: systemctl list-unit-files | grep 名稱；確認套件已安裝；修改單元檔後要 systemctl daemon-reload；被 mask 用 systemctl unmask
## systemd-timeout
re: (?<u>[\w@.-]+\.(?:service|mount|device)): (?:start|stop|stop-sigterm|stop-final-sigterm|Start operation|Stopping timed out|Job .* timed out)[^\n]*timed out|A start job is running for (?<d>[^\n(]+)|Timed out waiting for device (?<dev>\S+)|Dependency failed for [^\n]*\n.*timed out
what: 等待超時：{u}{d}{dev}。
cause: 服務啟動太久（程式卡住、網路還沒好、等待資源）；開機時等不到磁碟裝置（fstab 寫了不存在的 UUID）
fix: 看該單元的日誌找卡在哪；等待裝置逾時要檢查 /etc/fstab 與 blkid 的 UUID，不重要的掛載加 nofail、x-systemd.device-timeout
## sshd-auth
re: sshd\[\d+\]: (?:Failed (?<m>password|publickey) for (?:invalid user )?(?<u>\S+) from (?<ip>\S+)|Invalid user (?<u>\S+) from (?<ip>\S+)|maximum authentication attempts exceeded for (?:invalid user )?(?<u>\S+) from (?<ip>\S+)|Connection closed by authenticating user (?<u>\S+) (?<ip>\S+)|error: (?<e>[^\n]+))
what: SSH 登入失敗：使用者 {u} 來自 {ip}（方式 {m}）{e}。
cause: 密碼或金鑰錯誤；帳號不存在；大量同來源的重複嘗試通常是網路掃描／暴力破解
cause: publickey 失敗常見原因：金鑰權限太寬（~/.ssh 與 authorized_keys 權限）、SELinux 標籤、用了錯的金鑰
fix: 自己的登入：ssh -vvv 看嘗試了哪些金鑰；檢查 ~/.ssh 700、authorized_keys 600；伺服器端 journalctl -u ssh
fix: 外部暴力破解：關閉密碼登入、改用金鑰、用 fail2ban、限制來源 IP
## selinux-avc
re: avc:\s+denied\s+\{ (?<perm>[^}]+) \} for .*?(?:comm|exe)=["']?(?<c>[^"'\s]+)["']? .*?scontext=(?<s>\S+) tcontext=(?<t>\S+) tclass=(?<k>\S+)
what: SELinux 拒絕了 {c} 對 {k} 的 {perm} 操作（來源標籤 {s}，目標標籤 {t}）。
cause: 檔案標籤不對（例如搬移檔案後沒重新標記）、服務需要新的權限、布林值沒開
fix: 先確認不是檔案標籤問題：restorecon -Rv 路徑；用 ausearch -m avc 與 audit2why 看原因；需要時用 audit2allow 產生政策模組（確認安全後再套用）；setsebool 開對應的布林值
## apparmor-denied
re: apparmor="(?:DENIED|ALLOWED)" operation="(?<op>[^"]+)" (?:class="[^"]+" )?profile="(?<p>[^"]+)" name="(?<n>[^"]+)"(?: pid=(?<pid>\d+) comm="(?<c>[^"]+)")?
what: AppArmor 拒絕了 {c} 在設定檔 {p} 之下對 {n} 做 {op}。
cause: 程式要存取的路徑不在它的 AppArmor 設定檔允許範圍
fix: 先確認這個存取是合理的；用 aa-logprof 或編輯 /etc/apparmor.d 設定檔加入該路徑規則；暫時除錯可用 aa-complain 切成抱怨模式
## runtime-missing-lib
re: (?<p>[^\s:]+): error while loading shared libraries: (?<lib>\S+): cannot open shared object file: No such file or directory
what: 程式 {p} 啟動時找不到共享函式庫 {lib}。
cause: 沒有安裝該函式庫的執行套件，或安裝在非標準位置
cause: 架構不同（把 32 位元程式放在沒有 32 位元函式庫的系統）
cause: 交叉編譯的程式拿到主機執行
fix: ldd {p} 看哪些找不到；安裝對應套件；非標準位置設 LD_LIBRARY_PATH 或加進 /etc/ld.so.conf.d 後 ldconfig
## runtime-exec-format
re: (?<p>[^\s:]+): (?:cannot execute binary file: Exec format error|Exec format error|cannot execute: required file not found|bad ELF interpreter: No such file or directory)|(?:bash|sh): (?<p>\S+): (?:No such file or directory|cannot execute: required file not found)
what: {p} 沒辦法執行：格式或架構不對，或它需要的直譯器／動態連結器不存在。
cause: 架構不符（x86 程式在 ARM 上、32 位元在純 64 位元系統）
cause: 檔案存在但 ELF 的 interpreter（例如 /lib/ld-linux-armhf.so.3）不在這個系統
cause: 腳本的第一行（shebang）指向不存在的直譯器，或檔案有 Windows 換行（#!/bin/sh^M）
fix: file {p} 與 readelf -l {p} | grep interpreter 檢查；dos2unix 修換行；用 qemu-user 或對的架構
## runtime-illegal-instruction
re: Illegal instruction(?: \(core dumped\))?|trap invalid opcode|SIGILL
what: CPU 遇到不認得的指令（SIGILL）。
cause: 程式用了這顆 CPU 沒有的指令（-march=native 在別台機器跑、AVX／AVX-512／NEON 不支援）
cause: 跑錯架構，或函式指標跳到資料區
fix: 用較通用的 -march（x86-64、armv8-a）重新編譯；檢查 /proc/cpuinfo 的 flags；gdb 看出錯的指令位址
## runtime-address-in-use
re: (?:bind(?:\(\))? failed|Address already in use|EADDRINUSE|Cannot assign requested address|OSError: \[Errno 98\])[^\n]*
what: 伺服器要綁定的位址（埠）已被占用或不可用。
cause: 另一個行程（或剛結束的行程處於 TIME_WAIT）佔用同一個埠
fix: ss -ltnp | grep :埠 找出占用者；伺服器設 SO_REUSEADDR；換埠
## gdb-signal
re: Program (?:received signal|terminated with signal) (?<sig>SIG[A-Z0-9]+), (?<name>[^.\n]+)\.
what: 被除錯的程式收到訊號 {sig}（{name}），gdb 停在發生的位置。
cause: SIGSEGV：存取無效記憶體（空指標、野指標、堆疊溢位）；SIGABRT：程式自己 abort（assert 失敗、記憶體被破壞）；SIGFPE：算術錯誤（整數除以零）；SIGILL：非法指令；SIGBUS：未對齊或存取不存在的檔案映射；SIGPIPE：寫入已關閉的連線；SIGTRAP：中斷點
fix: 用 bt 看呼叫堆疊、frame N 切到你的程式碼、info locals 與 print 指標看值；SIGSEGV 先 print $_siginfo._sifields._sigfault.si_addr 看出錯的位址；x/i $pc 看出錯的指令
## gdb-cannot-access
re: Cannot access memory at address (?<a>0x[0-9a-fA-F]+)
what: gdb 讀不到位址 {a} 的記憶體。
cause: 位址無效（空指標或未初始化的指標）；變數已經不在目前的堆疊框（超出範圍）
cause: 遠端目標（QEMU／板子）該位址沒有對應的記憶體或尚未映射（MMU 未啟用前用虛擬位址）
fix: 先確認指標值（print ptr）是否合理；info proc mappings 或 info mem 看可存取範圍；遠端目標用實體位址或等 MMU 設定後
## gdb-no-symbol
re: No symbol ["'‘](?<s>[^"'’]+)["'’] in current context|No symbol table is loaded\.\s+Use the ["']file["'] command|Cannot find bounds of current function
what: gdb 找不到符號 {s}（或根本沒有載入除錯符號／PC 不在已知函式內）。
cause: 程式沒有用 -g 編譯，或除錯符號被 strip 掉
cause: 目前所在的堆疊框看不到那個變數（作用域不同），或最佳化把它移除了
cause: PC 跑到無效位址（Cannot find bounds of current function）：函式指標壞掉、堆疊被破壞
fix: 用 -g -O0（或 -Og）重新編譯；file 載入有符號的檔案；frame／up 切換堆疊框；info scope 函式 看有哪些區域變數
## gdb-aslr
re: warning: Error disabling address space randomization: Operation not permitted
what: gdb 在這個環境不能關閉位址空間隨機化（常見於 Docker 容器）。
cause: 容器的 seccomp／權限限制了 personality 系統呼叫
fix: docker run --cap-add=SYS_PTRACE --security-opt seccomp=unconfined；或在 gdb 內 set disable-randomization off（然後每次位址會不同）
## gdb-remote
re: (?:Remote communication error\.\s+Target disconnected\.(?:: (?<m>[^\n]+))?|Remote connection closed|Ignoring packet error, continuing|Reply contains invalid hex digit|Connection (?:refused|timed out)\.|:\d+: Connection (?:refused|timed out))
what: gdb 與遠端目標（gdbserver、QEMU、板子）通訊中斷或連不上：{m}
cause: 目標端沒有在執行或已結束（QEMU 被關掉、程式崩潰）
cause: 位址或埠錯（QEMU 的 -s 預設 tcp::1234）；防火牆；序列線速率不對
cause: 架構不符造成封包解析錯誤
fix: 確認目標端先啟動並在等待（QEMU 加 -s -S）；target remote localhost:1234；用 netstat 或 ss 確認埠；重新連線前在 gdb 內 disconnect
## gdb-arch-mismatch
re: Remote ['"]?g['"]? packet reply is too long(?: \(expected (?<e>\d+) bytes, got (?<g>\d+) bytes\))?|warning: A handler for the OS ABI ["'](?<abi>[^"']+)["'] is not built into this configuration of GDB|The target architecture is set to ["'](?<a>[^"']+)["']|Selected architecture (?<a>\S+) is not compatible with reported target architecture (?<b>\S+)
what: gdb 的架構設定與目標不符（預期 {e} 位元組暫存器封包，收到 {g}；或 OS ABI {abi}）。
cause: 用 x86 的 gdb 連 ARM／AArch64 的目標，或 QEMU 在 x86-64 模式切換（從 16／32 位元切到 64 位元）造成暫存器集合改變
cause: 32 位元與 64 位元 ARM 混用
fix: 使用對應架構的 gdb（gdb-multiarch 或 aarch64-linux-gnu-gdb），並 set architecture aarch64（或 arm、i386:x86-64）；在 target remote 前先 file 載入 ELF；x86 模式切換後斷線重連並重新 set architecture
## gdb-breakpoint-insert
re: Cannot insert breakpoint (?<n>\d+)\.\s*(?:Cannot access memory at address (?<a>0x[0-9a-fA-F]+)|Error accessing memory address (?<a>0x[0-9a-fA-F]+): [^\n]+)
what: 無法在位址 {a} 插入中斷點 {n}：那個位址目前不可寫入或還沒映射。
cause: 程式碼在 ROM／flash（唯讀），軟體中斷點需要改寫指令
cause: 位址是虛擬位址但 MMU 還沒啟用，或程式還沒載入到那裡（共享函式庫尚未載入）
fix: 唯讀區域改用硬體中斷點 hbreak；等程式載入後再下中斷點（先 start 或 tbreak main）；裸機／核心早期用實體位址
## gdb-solib
re: warning: Could not load shared library symbols for (?<l>[^\n.]+)|Reading symbols from [^\n]*\(No debugging symbols found in [^\n]*\)|warning: (?<f>\S+): no debug info|warning: Unable to find libthread_db matching inferior's thread library|warning: Source file is more recent than executable
what: gdb 缺少除錯資訊（{l}{f}）：看不到那個函式庫或檔案的符號與原始碼，或原始檔比執行檔新（可能顯示錯行）。
cause: 沒安裝除錯符號套件（-dbg／-dbgsym／debuginfo），或函式庫在目標機器而不在主機
cause: 交叉除錯沒有設定 sysroot
cause: 原始碼編輯後沒有重新編譯
fix: 安裝 libc6-dbg 等除錯套件；交叉除錯 set sysroot <目標根檔案系統>、set solib-search-path；重新編譯並用 -g；source 路徑不同用 set substitute-path 舊 新
## gdb-ptrace
re: ptrace: Operation not permitted|Could not attach to process\.[^\n]*|Operation not permitted\.|ptrace_scope
what: gdb 不被允許附加（ptrace）到行程。
cause: 不是自己的行程、需要 root；系統的 Yama ptrace_scope 限制只能附加子行程；容器沒有 SYS_PTRACE 能力
fix: 用 sudo；或 echo 0 | sudo tee /proc/sys/kernel/yama/ptrace_scope；容器加 --cap-add=SYS_PTRACE；或讓 gdb 自己啟動程式（gdb ./程式）
## gdb-not-running
re: The program is not being run\.|Don't know how to run\.\s+Try ["']help target["']\.|No executable file specified\.|No frame selected\.|You can't do that without a process to debug\.
what: 目前沒有正在執行的程式（或沒載入執行檔），這個指令需要執行中的行程。
fix: 先 file 載入執行檔，再 run／start；遠端目標先 target remote，再 continue；core dump 用 gdb 程式 core 開啟
## gdb-autoload
re: warning: File ["'‘](?<f>[^"'’]+)["'’] auto-loading has been declined by your ['"‘]auto-load safe-path['"’]|auto-load safe-path
what: gdb 拒絕自動載入 {f}（安全路徑限制）。
fix: 在 ~/.gdbinit 加 add-auto-load-safe-path 該資料夾（或 set auto-load safe-path /）；確認來源可信
