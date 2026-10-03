# QEMU 全系統模擬器：選項、-drive／-device／-netdev／-chardev／-machine 的子選項、機型與 CPU 清單、核心命令列參數
## qemu-system-arm | qemu-system-arm.exe | QEMU 的 32 位元 ARM 全系統模擬器：模擬整台 ARM 機器（CPU、記憶體、週邊），可直接載入核心或韌體執行 | qemu-system-arm -M 機型 [-cpu CPU] [-m 記憶體] [-kernel 核心] [-append 核心命令列] [選項...]
-M | 機型 | 指定要模擬的機型（板子），例如 virt（虛擬化用的通用板）、versatilepb、vexpress-a9、raspi2b、mps2-an385、lm3s6965evb；-M help 列出全部
-machine | 機型[,屬性] | 同 -M，可附屬性（例如 virt,gic-version=3,secure=on）
-cpu | CPU | 指定 CPU 型號（例如 cortex-a15、cortex-m3、max）；-cpu help 列出
-smp | 數量 | 模擬的核心數與拓撲（例如 -smp 4 或 cpus=4,sockets=1,cores=4）
-m | 大小 | 客體記憶體大小，單位預設 MB（例如 -m 512 或 -m 2G）
-mem-path | 路徑 | 用檔案（例如 hugetlbfs）當客體記憶體後端
-accel | 加速器 | 加速器：kvm（硬體虛擬化）、tcg（純軟體翻譯，預設）、hvf、whpx
-enable-kvm |  | 使用 KVM 硬體加速（客體與主機架構需相同）
-kernel | 檔案 | 直接載入核心映像（zImage／Image／ELF），不經開機載入器；是嵌入式 Linux 最常用的方式
-initrd | 檔案 | 載入初始 RAM 磁碟（initramfs）
-append | 命令列 | 核心命令列（例如 "console=ttyAMA0 root=/dev/vda rw"）
-dtb | 檔案 | 使用指定的裝置樹（Device Tree Blob）；沒有指定時 QEMU 會自己為 virt 等機型產生
-dumpdtb | 檔案 | 把機型產生的裝置樹寫到檔案後結束（搭配 -machine 屬性）
-bios | 檔案 | 指定 BIOS／韌體映像（例如 u-boot.bin、edk2 的 QEMU_EFI.fd）
-pflash | 檔案 | 把檔案當 parallel flash 載入（UEFI 韌體常用）
-drive | 參數 | 定義一個儲存裝置：file=、if=、format=、media= 等
-hda | 檔案 | 第一個 IDE 硬碟映像
-hdb | 檔案 | 第二個 IDE 硬碟映像
-cdrom | 檔案 | 光碟映像（ISO）
-sd | 檔案 | SD 卡映像
-mtdblock | 檔案 | 板載 flash 映像
-fda | 檔案 | 軟碟映像
-device | 裝置[,屬性] | 加入一個裝置（可重複）：例如 virtio-blk-device,drive=hd0；-device help 列出所有裝置
-netdev | 後端 | 定義網路後端：user、tap、bridge、socket；常搭配 -device 的 netdev=
-nic | 設定 | 一次建立網卡與後端的簡寫（例如 -nic user,model=virtio-net-pci,hostfwd=tcp::2222-:22）
-net | 設定 | 舊式網路選項（-net nic -net user）
-serial | 字元裝置 | 把客體序列埠導向主機端：stdio、mon:stdio（序列埠與監控共用標準輸入輸出）、null、pty、file:檔名、tcp::埠,server,nowait、telnet:、unix:
-monitor | 字元裝置 | 把 QEMU 監控器（命令介面）導向某處：stdio、none、telnet:…、unix:…
-qmp | 字元裝置 | 開 QMP（機器可讀的 JSON 控制介面）
-mon | 設定 | 詳細設定監控器：chardev=,mode=readline|control
-chardev | 後端 | 定義字元裝置後端，之後用 -serial chardev:ID、-device virtconsole,chardev=ID 引用
-display | 類型 | 顯示輸出類型：none、gtk、sdl、vnc=:0、curses
-nographic |  | 不開圖形視窗：預設把序列埠與監控接到終端機（等於 -display none -serial mon:stdio）；跑嵌入式 Linux 最常用，結束用 Ctrl+A 然後 X
-vnc | 位址 | 用 VNC 輸出畫面（例如 -vnc :1 為連接埠 5901）
-vga | 類型 | 虛擬顯示卡：std、virtio、cirrus、qxl、none
-sdl |  | 使用 SDL 視窗
-curses |  | 用文字模式顯示（curses）
-usb |  | 啟用 USB 控制器（舊式）
-usbdevice | 裝置 | 舊式 USB 裝置（mouse、tablet、keyboard）
-soundhw | 裝置 | 舊式音效卡
-audiodev | 後端 | 音訊後端
-object | 物件 | 建立 QEMU 物件（記憶體後端 memory-backend-file、rng-random、secret、iothread 等）
-fsdev | 後端 | 檔案系統分享後端（9p）
-virtfs | 設定 | 用 9p 分享主機資料夾給客體：-virtfs local,path=/src,mount_tag=host0,security_model=none
-s |  | 在 TCP 1234 開 gdb 伺服器（等於 -gdb tcp::1234）
-S |  | 啟動時 CPU 先暫停，等 gdb 或監控器下 continue 才開始跑
-gdb | 設備 | 開 gdb 伺服器於指定位址，例如 -gdb tcp::3333
-d | 項目 | 開啟偵錯記錄：in_asm（翻譯的客體指令）、cpu、int（中斷）、exec、guest_errors、unimp（未實作週邊）、mmu；以逗號分隔
-D | 檔案 | 把 -d 的偵錯記錄寫到檔案
-trace | 事件 | 開啟追蹤事件
-semihosting |  | 啟用半主機（讓客體透過特殊指令使用主機的檔案、主控台；裸機程式常用）
-semihosting-config | 設定 | 半主機詳細設定：enable=on,target=native,chardev=ID,arg=…
-snapshot |  | 唯讀使用磁碟映像：所有寫入丟到暫存，結束後消失
-loadvm | 名稱 | 啟動時載入虛擬機快照
-incoming | 位址 | 等待遷移的進入連線
-no-reboot |  | 客體要重新開機時改成結束 QEMU（除錯開機失敗時常用）
-no-shutdown |  | 客體關機後不結束 QEMU
-rtc | 設定 | 設定即時時鐘：base=utc|localtime、clock=host|vm
-icount | 設定 | 啟用指令計數時間（確定性模擬）：-icount shift=auto
-name | 名稱 | 設定客體名稱
-uuid | UUID | 設定客體 UUID
-boot | 設定 | 開機順序與選項：order=dc、once=d、menu=on
-global | 設定 | 設定驅動屬性預設值
-readconfig | 檔案 | 從設定檔讀取
-writeconfig | 檔案 | 把目前設定寫到檔案
-L | 目錄 | 指定 BIOS 與 ROM 檔搜尋目錄
-daemonize |  | 啟動後轉入背景
-pidfile | 檔案 | 寫入 PID
-sandbox | 設定 | 啟用 seccomp 沙盒
-numa | 設定 | 設定 NUMA 節點
-smbios | 設定 | 設定 SMBIOS 資訊
-fw_cfg | 設定 | 透過 fw_cfg 傳資料給韌體
-watchdog | 型號 | 模擬看門狗
-watchdog-action | 動作 | 看門狗觸發時的動作（reset、shutdown、poweroff、pause、debug、none）
-overcommit | 設定 | 記憶體與 CPU 超額配置設定
-parallel | 字元裝置 | 並列埠導向
-echr | 字元 | 設定終端機跳脫字元（預設 Ctrl+A）
-k | 鍵盤配置 | 設定鍵盤配置
-version |  | 顯示版本
-h |  | 顯示說明
-help |  | 顯示說明
-no-acpi |  | 停用 ACPI（x86）
-no-hpet |  | 停用高精度事件計時器（x86）
-cpu help |  | 列出支援的 CPU
@list machines
virt | 通用虛擬機型：為虛擬化設計、不對應真實硬體，使用 virtio 裝置與 GIC，記憶體位置與裝置樹由 QEMU 自動產生；跑 Linux 首選
versatilepb | ARM Versatile/PB（ARM926EJ-S）：老牌教學機型，許多教學範例與較舊核心用它
versatileab | ARM Versatile/AB（ARM926EJ-S）
vexpress-a9 | ARM Versatile Express，Cortex-A9 四核版
vexpress-a15 | ARM Versatile Express，Cortex-A15 版
realview-pb-a8 | ARM RealView Platform Baseboard for Cortex-A8
realview-eb | ARM RealView Emulation Baseboard
realview-eb-mpcore | ARM RealView EB with ARM11MPCore
realview-pbx-a9 | ARM RealView Platform Baseboard Explore for Cortex-A9
raspi0 | 樹莓派 Zero
raspi1ap | 樹莓派 A+
raspi2b | 樹莓派 2B（Cortex-A7 四核）
mps2-an385 | ARM MPS2 開發板（Cortex-M3，AN385）：嵌入式 RTOS、裸機 Cortex-M 常用
mps2-an386 | ARM MPS2（Cortex-M4，AN386）
mps2-an500 | ARM MPS2（Cortex-M7，AN500）
mps2-an505 | ARM MPS2 TZ（Cortex-M33，AN505）
mps2-an511 | ARM MPS2（Cortex-M3，AN511）
mps2-an521 | ARM MPS2 TZ（雙 Cortex-M33，AN521）
mps3-an524 | ARM MPS3（雙 Cortex-M33，AN524）
mps3-an547 | ARM MPS3（Cortex-M55，AN547）
musca-a | ARM Musca-A（Cortex-M33）
musca-b1 | ARM Musca-B1（Cortex-M33）
lm3s811evb | Stellaris LM3S811 評估板（Cortex-M3）
lm3s6965evb | Stellaris LM3S6965 評估板（Cortex-M3）：FreeRTOS／Zephyr 範例常用
microbit | BBC micro:bit（nRF51，Cortex-M0）
netduino2 | Netduino 2（STM32F205，Cortex-M3）
netduinoplus2 | Netduino Plus 2（STM32F405，Cortex-M4）
stm32vldiscovery | STM32VLDISCOVERY（STM32F100，Cortex-M3）
olimex-stm32-h405 | Olimex STM32 H405（Cortex-M4）
b-l475e-iot01a | ST B-L475E-IOT01A（STM32L475，Cortex-M4）
sabrelite | Freescale i.MX6 Quad SABRE Lite（Cortex-A9）
mcimx6ul-evk | NXP i.MX6UL 評估板
mcimx7d-sabre | NXP i.MX7 Dual SABRE
orangepi-pc | Orange Pi PC（Allwinner H3）
cubieboard | Cubietech Cubieboard（Allwinner A10）
bpim2u | Banana Pi BPI-M2U（Allwinner R40）
xilinx-zynq-a9 | Xilinx Zynq 平台基板（Cortex-A9）
smdkc210 | Samsung SMDKC210（Exynos4210）
n800 | Nokia N800 平板
n810 | Nokia N810 平板
sx1 | Siemens SX1（OMAP310）
kzm | ARM KZM（i.MX31）
emcraft-sf2 | SmartFusion2 SOM kit（Cortex-M3）
ast2500-evb | Aspeed AST2500 評估板（BMC）
ast2600-evb | Aspeed AST2600 評估板（BMC）
romulus-bmc | OpenPOWER Romulus BMC（AST2500）
witherspoon-bmc | OpenPOWER Witherspoon BMC（AST2500）
palmetto-bmc | OpenPOWER Palmetto BMC（AST2400）
npcm750-evb | Nuvoton NPCM750 評估板（BMC）
collie | Sharp SL-5500 Collie（SA1110）
tosa | Sharp SL-6000 Tosa（PXA255）
spitz | Sharp SL-C3000 Spitz（PXA270）
terrier | Sharp SL-C3200 Terrier（PXA270）
none | 沒有任何預設硬體：只有 CPU 與記憶體，自己用 -device 組裝
@list cpus
cortex-a7 | ARM Cortex-A7（32 位元應用處理器，省電，big.LITTLE 的小核）
cortex-a8 | ARM Cortex-A8（單核應用處理器）
cortex-a9 | ARM Cortex-A9（可多核）
cortex-a15 | ARM Cortex-A15（高效能，含虛擬化擴充）
cortex-a53 | ARM Cortex-A53（ARMv8，也可在 AArch32 模式）
cortex-a57 | ARM Cortex-A57（ARMv8）
cortex-a72 | ARM Cortex-A72（ARMv8）
cortex-m0 | ARM Cortex-M0（微控制器，Thumb-1）
cortex-m0plus | ARM Cortex-M0+
cortex-m3 | ARM Cortex-M3（微控制器，Thumb-2，無 FPU）
cortex-m4 | ARM Cortex-M4（Thumb-2，含 DSP 指令，可有 FPU）
cortex-m7 | ARM Cortex-M7（高效能微控制器，雙發射）
cortex-m33 | ARM Cortex-M33（ARMv8-M，含 TrustZone）
cortex-m55 | ARM Cortex-M55（ARMv8.1-M，含 Helium 向量）
cortex-r5 | ARM Cortex-R5（即時處理器）
cortex-r5f | ARM Cortex-R5F（含 FPU）
arm926 | ARM926EJ-S（ARMv5，舊式）
arm946 | ARM946E-S
arm1026 | ARM1026EJ-S
arm1136 | ARM1136（ARMv6）
arm1176 | ARM1176JZF-S（ARMv6，樹莓派 1 使用）
arm11mpcore | ARM11 MPCore
pxa250 | Intel PXA250
pxa270 | Intel PXA270
sa1100 | StrongARM SA-1100
max | 最大功能 CPU：開啟 QEMU 支援的所有功能，最方便的預設選擇
any | 任意 CPU（供 user-mode）
@sub drive
file | 磁碟映像檔路徑（raw、qcow2 等）
if | 介面類型：virtio（半虛擬化，效能好）、ide、scsi、sd（SD 卡）、mtd、pflash、none（只定義，之後用 -device 的 drive=ID 引用）
format | 映像格式：raw（原始）、qcow2（支援快照與稀疏）、vmdk、vdi
media | 媒體類型：disk 或 cdrom
index | 在介面上的索引編號
id | 裝置 ID，供 -device 的 drive= 引用
cache | 快取模式：none、writeback、writethrough、directsync、unsafe
aio | 非同步 I/O 模式：threads、native、io_uring
snapshot | on 表示寫入暫存、結束後丟棄
readonly | on 表示唯讀
unit | 在匯流排上的單元編號
bus | 匯流排編號
werror | 寫入錯誤時的處理：report、stop、ignore、enospc
rerror | 讀取錯誤時的處理
discard | 是否傳遞 discard／trim：on／off、unmap
detect-zeroes | 偵測寫入全零並以稀疏方式處理
@sub device
@type:virtio-blk-device | virtio 區塊裝置（MMIO 版，用於 virt、microvm 等無 PCI 的機型）
@type:virtio-blk-pci | virtio 區塊裝置（PCI 版）
@type:virtio-net-device | virtio 網卡（MMIO 版）
@type:virtio-net-pci | virtio 網卡（PCI 版，效能最好）
@type:virtio-scsi-pci | virtio SCSI 控制器
@type:virtio-serial-pci | virtio 序列埠（供 virtconsole、qemu-guest-agent 使用）
@type:virtio-gpu-pci | virtio 顯示卡（PCI）
@type:virtio-gpu-device | virtio 顯示卡（MMIO）
@type:virtio-rng-pci | virtio 亂數產生器
@type:virtio-rng-device | virtio 亂數產生器（MMIO）
@type:virtio-balloon-pci | virtio 記憶體氣球
@type:virtio-9p-pci | virtio 9p 檔案系統分享
@type:virtio-keyboard-pci | virtio 鍵盤
@type:virtio-mouse-pci | virtio 滑鼠
@type:vhost-user-fs-pci | vhost-user 檔案系統（virtiofs）
@type:e1000 | Intel 82540EM 網卡（相容性好）
@type:e1000e | Intel 82574L 網卡
@type:rtl8139 | Realtek 8139 網卡
@type:pcnet | AMD PCnet 網卡
@type:ne2k_pci | NE2000 PCI 網卡
@type:VGA | 標準 VGA 顯示卡
@type:cirrus-vga | Cirrus Logic 顯示卡
@type:qxl-vga | QXL（SPICE）顯示卡
@type:ramfb | 簡單的記憶體幀緩衝（ARM virt 用來給韌體顯示）
@type:usb-ehci | USB 2.0 控制器
@type:qemu-xhci | USB 3.0 控制器
@type:nec-usb-xhci | NEC USB 3.0 控制器
@type:usb-kbd | USB 鍵盤
@type:usb-mouse | USB 滑鼠
@type:usb-tablet | USB 平板（絕對座標指標，滑鼠整合最順）
@type:usb-storage | USB 儲存裝置
@type:usb-host | 直通主機的 USB 裝置
@type:ahci | AHCI SATA 控制器
@type:ich9-ahci | ICH9 AHCI SATA 控制器（q35 內建）
@type:ide-hd | IDE 硬碟
@type:ide-cd | IDE 光碟機
@type:scsi-hd | SCSI 硬碟
@type:scsi-cd | SCSI 光碟機
@type:nvme | NVMe 儲存裝置（需要 serial= 與 drive=）
@type:intel-hda | Intel HD Audio 控制器
@type:hda-duplex | HDA 音訊編解碼器（輸入輸出）
@type:AC97 | AC97 音效卡
@type:edu | QEMU 教學用的 PCI 裝置（開發驅動練習）
@type:pci-testdev | PCI 測試裝置
@type:isa-debugcon | ISA 除錯主控台（寫入 I/O 埠輸出字元）
@type:isa-debug-exit | ISA 除錯結束裝置（寫入 I/O 埠讓 QEMU 以指定退出碼結束，內核測試常用）
@type:pl011 | ARM PL011 UART
@type:loader | 通用載入器：把檔案或資料載入客體記憶體指定位址（-device loader,file=fw.bin,addr=0x40000000 或 data=…,data-len=…）
@type:vfio-pci | PCI 裝置直通（VFIO）
@type:vhost-vsock-pci | vsock（主機與客體通訊）
@type:virtconsole | virtio 主控台（搭配 virtio-serial）
@type:virtserialport | virtio 序列埠
@type:pci-bridge | PCI 橋
@type:pcie-root-port | PCIe 根連接埠
drive | 連到的 -drive 的 id
netdev | 連到的 -netdev 的 id
id | 這個裝置的 ID
bus | 要掛到的匯流排
addr | 在匯流排上的位址（PCI 的 slot 號；loader 的記憶體位址）
mac | 網卡的 MAC 位址
bootindex | 開機優先順序
romfile | 選項 ROM 檔
serial | 序列號字串（nvme 必要）
chardev | 連到的 -chardev 的 id
file | 載入的檔案（loader）
data | 載入的資料值（loader）
data-len | 資料長度位元組（loader）
cpu-num | 套用到哪個 CPU（loader）
multifunction | 多功能 PCI 裝置
num_queues | 佇列數量
queue-size | 佇列大小
iothread | 使用的 I/O 執行緒
logical_block_size | 邏輯區塊大小
physical_block_size | 實體區塊大小
share-rw | 是否允許與其他行程共享讀寫
@sub netdev
@type:user | 使用者模式網路（SLIRP）：不需要權限，客體透過 NAT 上網，內建 DHCP 與 DNS；客體預設位址 10.0.2.15、閘道 10.0.2.2
@type:tap | TAP 虛擬網卡：客體與主機橋接，需要權限與主機端設定
@type:bridge | 接到主機橋接器（需要 qemu-bridge-helper）
@type:socket | 以 socket 連接另一個 QEMU 執行個體
@type:vde | 連到 VDE 交換器
@type:hubport | 連到內部 hub
id | 這個網路後端的 ID，供 -device 的 netdev= 引用
hostfwd | 埠轉發主機到客體：hostfwd=tcp::2222-:22 代表主機 2222 轉到客體 22（SSH 常用）
guestfwd | 客體對某位址的連線轉到主機的命令或 socket
net | 客體網段（例如 10.0.2.0/24）
host | 客體看到的閘道位址
dhcpstart | DHCP 配發的起始位址
dns | 客體看到的 DNS 位址
hostname | DHCP 提供的主機名稱
restrict | on 表示客體不能存取主機網路
ipv4 | 啟用 IPv4
ipv6 | 啟用 IPv6
tftp | 內建 TFTP 伺服器的根目錄（網路開機用）
bootfile | TFTP 開機檔案名稱
smb | 內建 SMB 分享的主機資料夾
ifname | TAP 介面名稱
script | TAP 啟動時執行的腳本（no 表示不執行）
downscript | TAP 關閉時執行的腳本
br | 橋接器名稱
helper | 橋接輔助程式路徑
vhost | on 表示用 vhost 核心加速
listen | socket 後端監聽位址
connect | socket 後端連線位址
mcast | 多點傳送位址
model | 網卡型號（-nic 用）：virtio-net-pci、e1000、rtl8139、smc91c111（arm 舊板）
mac | MAC 位址
@sub chardev
@type:stdio | 主機的標準輸入輸出
@type:file | 輸出到檔案（path=）
@type:pipe | 具名管線
@type:socket | TCP 或 Unix socket（host=、port=、path=、server=on、wait=off）
@type:udp | UDP
@type:pty | 建立偽終端機並印出路徑
@type:serial | 主機的實體序列埠
@type:null | 丟棄
@type:vc | 虛擬主控台（圖形視窗內）
@type:msmouse | 微軟滑鼠協定
@type:mux | 多工：多個前端共享一個後端
id | 字元裝置 ID
path | 檔案或 socket 路徑
host | socket 主機
port | socket 埠
server | on 表示在本機監聽等人連入
wait | off 或 nowait 表示不等待對方連入就繼續開機
nowait | 不等待對方連入
telnet | 以 telnet 協定
mux | on 表示可多工
logfile | 同時記錄到檔案
signal | 是否把 Ctrl+C 當訊號
@sub machine
type | 機型名稱
accel | 加速器：kvm、tcg、hvf、whpx（可用 : 組合）
kernel_irqchip | 是否使用核心中斷控制器（on／off／split）
gic-version | ARM GIC 版本：2、3、4、host、max
secure | on 表示模擬 TrustZone 安全世界（ARM virt）
virtualization | on 表示模擬 EL2 虛擬化擴充（ARM virt，客體要跑虛擬機時用）
highmem | off 表示不使用 4GB 以上的位址（ARM virt）
iommu | 使用 IOMMU：smmuv3 等
dumpdtb | 把裝置樹輸出到檔案
mte | on 表示啟用記憶體標籤擴充（ARM）
usb | 啟用 USB 控制器
vmport | VMware 後門連接埠
dump-guest-core | 傾印時是否包含客體記憶體
mem-merge | 記憶體頁面合併
suppress-vmdesc | 不傳送虛擬機描述
@sub serial
stdio | 主機標準輸入輸出（序列埠印在目前終端機）
mon:stdio | 序列埠與 QEMU 監控器共用標準輸入輸出；Ctrl+A 然後 C 切換，Ctrl+A 然後 X 結束
null | 丟棄輸出
pty | 建立偽終端機，QEMU 啟動時印出 /dev/pts/N
vc | 圖形視窗內的虛擬主控台
none | 不接任何東西
file:* | 輸出到檔案
tcp:* | 透過 TCP（如 tcp::4444,server,nowait 表示在 4444 埠等人連入，不阻塞開機）
telnet:* | 透過 telnet 協定
unix:* | Unix socket
chardev:* | 使用先前定義的 chardev ID
server | 在本機監聽
nowait | 不等待連入
wait | 等待連入才開機
telnet | 使用 telnet 協定
@sub append
console=* | 核心主控台設備與參數：ttyS0（x86 序列埠）、ttyAMA0（ARM PL011）、tty0（螢幕）；可附鮑率如 ttyS0,115200
root=* | 根檔案系統所在裝置：/dev/vda（virtio 磁碟）、/dev/sda、/dev/mmcblk0p2、PARTUUID=、/dev/nfs
rootfstype=* | 根檔案系統型態（ext4、squashfs、9p …）
rootwait | 等待根裝置出現才掛載（USB／SD 開機常需要）
rootflags=* | 掛載根檔案系統的選項
rw | 以讀寫掛載根檔案系統
ro | 以唯讀掛載根檔案系統
init=* | 指定第一個使用者行程（預設 /sbin/init）；除錯常用 init=/bin/sh
earlycon | 啟用早期主控台（在正式主控台出現前就能看到核心訊息）
earlycon=* | 指定早期主控台（如 earlycon=pl011,0x9000000 ）
earlyprintk=* | x86 早期輸出（serial,ttyS0,115200）
nokaslr | 關閉核心位址隨機化（用 gdb 除錯核心時需要）
loglevel=* | 核心訊息等級 0 到 7（7 為 debug）
quiet | 隱藏大部分開機訊息
debug | 顯示除錯訊息
panic=* | 核心 panic 後 N 秒自動重開機（0 表示不重開）
maxcpus=* | 最多啟用的 CPU 數
mem=* | 限制使用的記憶體大小
ip=* | 核心啟動時設定網路（ip=dhcp 或 ip=客戶端:伺服器:閘道:遮罩）
nfsroot=* | 以 NFS 當根檔案系統
cma=* | 連續記憶體配置器大小
isolcpus=* | 隔離給特定用途的 CPU
systemd.unit=* | 指定 systemd 開機目標（如 rescue.target）
single | 單人模式開機
selinux=* | SELinux 開關
apparmor=* | AppArmor 開關
net.ifnames=* | 網卡命名規則（0 表示沿用 eth0 這種舊名稱）
elevator=* | 指定 I/O 排程器
hugepages=* | 預留巨頁數量
mitigations=* | CPU 漏洞緩解（off 關閉換取效能）
@sub display
none | 不顯示畫面
gtk | GTK 視窗
sdl | SDL 視窗
curses | 文字模式
vnc=* | VNC 伺服器（例如 vnc=:0 對應 5900 埠）
egl-headless | 無頭 EGL 繪圖
@sub smp
cpus | 啟動時的 CPU 數量
maxcpus | 最大可熱插拔 CPU 數
sockets | 處理器插座數
cores | 每個插座的核心數
threads | 每個核心的執行緒數
## qemu-system-aarch64 | qemu-system-aarch64.exe | QEMU 的 64 位元 ARM（ARMv8）全系統模擬器，也可跑 32 位元客體 | qemu-system-aarch64 -M 機型 -cpu CPU [-m 記憶體] [-kernel Image] [-append 核心命令列] [選項...]
@inherit qemu-system-arm
-bios | 檔案 | 指定韌體（例如 edk2-aarch64-code.fd 或 u-boot.bin）；aarch64 的 virt 機型要跑 UEFI 時常用
@list machines
virt | 通用 64 位元虛擬機型：使用 GICv2/v3、PCIe、virtio-mmio，裝置樹由 QEMU 產生；跑 aarch64 Linux 首選（可用 -machine virt,gic-version=3,virtualization=on,secure=on 調整）
raspi3b | 樹莓派 3B（Cortex-A53）
raspi3ap | 樹莓派 3A+（Cortex-A53）
raspi4b | 樹莓派 4B（Cortex-A72）
sbsa-ref | 伺服器基礎系統架構參考平台：用 UEFI 開機，貼近伺服器 ARM
xlnx-versal-virt | Xilinx Versal 虛擬平台
xlnx-zcu102 | Xilinx ZynqMP ZCU102 開發板
imx8mp-evk | NXP i.MX 8M Plus 評估板
nuri | Samsung NURI
orangepi-pc | Orange Pi PC
vexpress-a9 | ARM Versatile Express A9（32 位元客體）
fby35-bmc | Facebook FBY35 BMC
none | 沒有預設硬體
@list cpus
cortex-a35 | ARM Cortex-A35（ARMv8 省電小核）
cortex-a53 | ARM Cortex-A53（ARMv8 小核，最常用於教學）
cortex-a55 | ARM Cortex-A55（ARMv8.2）
cortex-a57 | ARM Cortex-A57（ARMv8 大核）
cortex-a72 | ARM Cortex-A72（ARMv8 大核，樹莓派 4）
cortex-a76 | ARM Cortex-A76（ARMv8.2）
neoverse-n1 | ARM Neoverse N1（伺服器）
neoverse-v1 | ARM Neoverse V1（伺服器，含 SVE）
a64fx | 富士通 A64FX（含 SVE，512 位元）
max | 最大功能 CPU：開啟 QEMU 支援的全部 ARMv8/v9 功能（含 SVE、MTE、PAuth）；用 TCG 時最方便
host | 與主機相同的 CPU（需要 KVM／HVF）
cortex-a15 | ARM Cortex-A15（32 位元）
cortex-a7 | ARM Cortex-A7（32 位元）
## qemu-system-x86_64 | qemu-system-x64,qemu-system-amd64,qemu-system-x86,qemu-system-i386,qemu-system-x86_64.exe,qemu-system-i386.exe,qemu-kvm | QEMU 的 x86／x86-64 全系統模擬器：模擬一台 PC（BIOS/UEFI 開機、PCI 匯流排、VGA、磁碟、網卡） | qemu-system-x86_64 [選項] [磁碟映像]
@inherit qemu-system-arm
-boot | 設定 | 開機順序：-boot order=dc（先光碟 d 再硬碟 c）、once=d（只這次先從光碟開機）、menu=on 顯示開機選單
-cdrom | 檔案 | 光碟映像（ISO），常用來安裝作業系統
-enable-kvm |  | 使用 KVM 硬體加速（Linux 主機，客體與主機都是 x86 才有意義）
-spice | 設定 | 用 SPICE 遠端桌面輸出
-smbios | 設定 | 設定 SMBIOS（DMI）資訊
-no-acpi |  | 停用 ACPI
-no-hpet |  | 停用高精度事件計時器
-no-fd-bootchk |  | 不檢查軟碟開機簽章
-vga | 類型 | 虛擬顯示卡：std（預設）、virtio、qxl、cirrus、vmware、none
-machine | 機型[,屬性] | 機型，例如 q35,accel=kvm；accel=、kernel_irqchip=、usb=、vmport= 等屬性
-kernel | 檔案 | 直接載入 Linux bzImage 並用 -append 傳核心命令列（略過 BIOS 開機載入器）
-bios | 檔案 | 指定 BIOS／UEFI 韌體（例如 OVMF.fd、seabios）
-soundhw | 裝置 | 舊式音效卡（例如 hda、ac97）
-usb |  | 啟用 USB
-usbdevice | 裝置 | 舊式 USB 裝置，如 tablet（絕對座標滑鼠，避免滑鼠游標偏移）
@list machines
pc | 標準 PC（i440FX＋PIIX 晶片組，預設）：相容性最好，ISA 與舊式 PCI 架構
q35 | 較新 PC（Q35＋ICH9 晶片組）：PCIe 匯流排、AHCI，較適合現代客體與裝置直通
microvm | 極簡虛擬機：沒有 PCI、ACPI 與 ISA 舊裝置，用 virtio-mmio；開機極快，用於容器式輕量虛擬化
isapc | 純 ISA PC（老舊 486 時代）
xenfv | Xen 全虛擬化 PC
pc-i440fx-8.2 | 固定版本的 i440FX 機型（跨 QEMU 版本保持相容，用於遷移）
pc-q35-8.2 | 固定版本的 Q35 機型
none | 沒有預設硬體
@list cpus
qemu64 | 預設 64 位元通用 CPU：只有基本功能（SSE2），跨主機最相容
qemu32 | 預設 32 位元通用 CPU
max | 開啟 QEMU 支援的所有 CPU 功能（TCG 時最方便；KVM 時等同 host 的可用功能）
host | 與主機 CPU 相同（需要 KVM、HVF 或 WHPX）
base | 最小功能 CPU，自己用旗標組裝
kvm64 | 供 KVM 客體用的通用 64 位元 CPU
Haswell | Intel Haswell（AVX2、FMA）
Skylake-Client | Intel Skylake 用戶端（AVX2）
Skylake-Server | Intel Skylake 伺服器（AVX-512）
Cascadelake-Server | Intel Cascade Lake 伺服器
Icelake-Server | Intel Ice Lake 伺服器
SapphireRapids | Intel Sapphire Rapids
Nehalem | Intel Nehalem（SSE4.2）
SandyBridge | Intel Sandy Bridge（AVX）
EPYC | AMD EPYC（Zen）
EPYC-Rome | AMD EPYC Rome（Zen 2）
Opteron_G5 | AMD Opteron G5
pentium3 | Intel Pentium III（32 位元）
pentium | Intel Pentium
486 | Intel 486
