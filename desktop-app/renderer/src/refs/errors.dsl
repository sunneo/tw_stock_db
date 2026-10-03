# 錯誤碼：代碼 | 名稱 | 原文訊息 | 白話說明
# 來源：Linux errno（asm-generic/errno-base.h、errno.h）、Windows winerror.h／ntstatus.h／winsock、POSIX 訊號、shell 退出碼慣例
@linux_errno
1 | EPERM | Operation not permitted | 沒有權限做這個操作（行程能力不足，例如要 root 或 CAP_*；不是單純的檔案權限）
2 | ENOENT | No such file or directory | 檔案或資料夾不存在（路徑拼錯、工作目錄不對、動態函式庫或直譯器路徑找不到）
3 | ESRCH | No such process | 找不到指定的行程（pid 已經結束）
4 | EINTR | Interrupted system call | 系統呼叫被訊號打斷，通常要重試
5 | EIO | Input/output error | 硬體或驅動層的輸入輸出錯誤（磁碟壞軌、裝置拔掉）
6 | ENXIO | No such device or address | 找不到對應的裝置或位址
7 | E2BIG | Argument list too long | 參數與環境變數總長度超過上限（萬用字元展開太多檔案時常見）
8 | ENOEXEC | Exec format error | 不是可執行格式（架構不符、缺 shebang、檔案損毀）
9 | EBADF | Bad file descriptor | 檔案描述子無效或已關閉，或開啟模式不符（讀寫方向錯）
10 | ECHILD | No child processes | 沒有子行程可等待
11 | EAGAIN | Resource temporarily unavailable | 暫時沒有資源：非阻塞 I/O 還沒好、資源暫時不足，稍後重試（和 EWOULDBLOCK 同值）
12 | ENOMEM | Cannot allocate memory | 記憶體不足（或位址空間、ulimit、cgroup 限制）
13 | EACCES | Permission denied | 檔案或資料夾的權限不允許（rwx、擁有者、SELinux／AppArmor、掛載選項 noexec）
14 | EFAULT | Bad address | 傳給核心的指標無效（常是程式 bug）
15 | ENOTBLK | Block device required | 需要區塊裝置
16 | EBUSY | Device or resource busy | 裝置或資源忙碌中（正被使用、掛載點正在使用）
17 | EEXIST | File exists | 檔案已經存在（建立時不能覆蓋）
18 | EXDEV | Invalid cross-device link | 不能跨檔案系統做硬連結或 rename，改用複製再刪除
19 | ENODEV | No such device | 沒有這個裝置（驅動沒載入、不支援的操作）
20 | ENOTDIR | Not a directory | 路徑中的某一段不是資料夾
21 | EISDIR | Is a directory | 對資料夾做了只能對檔案做的操作
22 | EINVAL | Invalid argument | 參數無效（旗標組合不合法、長度或對齊不對、值超出範圍）
23 | ENFILE | Too many open files in system | 系統層級開啟的檔案數已滿
24 | EMFILE | Too many open files | 行程開啟的檔案數超過上限（ulimit -n），常是忘了 close（檔案描述子洩漏）
25 | ENOTTY | Inappropriate ioctl for device | 這個裝置不支援該 ioctl（常見：對非終端機呼叫終端機操作）
26 | ETXTBSY | Text file busy | 執行檔正在被執行，無法寫入
27 | EFBIG | File too large | 檔案超過大小上限
28 | ENOSPC | No space left on device | 磁碟空間不足（也可能是 inode 用完、或 inotify 監看數用完）
29 | ESPIPE | Illegal seek | 對管線或 socket 做了 seek
30 | EROFS | Read-only file system | 檔案系統是唯讀的
31 | EMLINK | Too many links | 連結數過多
32 | EPIPE | Broken pipe | 寫入時對方已關閉（會同時收到 SIGPIPE）
33 | EDOM | Numerical argument out of domain | 數學函式的引數超出定義域
34 | ERANGE | Numerical result out of range | 結果超出範圍，或緩衝區太小
35 | EDEADLK | Resource deadlock avoided | 偵測到鎖死
36 | ENAMETOOLONG | File name too long | 檔名或路徑太長
37 | ENOLCK | No locks available | 沒有可用的鎖
38 | ENOSYS | Function not implemented | 這個系統呼叫在目前核心／架構沒實作
39 | ENOTEMPTY | Directory not empty | 資料夾不是空的，無法刪除
40 | ELOOP | Too many levels of symbolic links | 符號連結層級太多（可能形成迴圈）
61 | ENODATA | No data available | 沒有資料（例如 getxattr 找不到該屬性）
62 | ETIME | Timer expired | 計時器逾時
71 | EPROTO | Protocol error | 協定錯誤
74 | EBADMSG | Bad message | 訊息格式錯誤
75 | EOVERFLOW | Value too large for defined data type | 值太大，放不進資料型別
84 | EILSEQ | Invalid or incomplete multibyte or wide character | 多位元組字元序列無效（編碼不符）
88 | ENOTSOCK | Socket operation on non-socket | 對非 socket 做了 socket 操作
89 | EDESTADDRREQ | Destination address required | 需要目的位址
90 | EMSGSIZE | Message too long | 訊息太長（超過 UDP／socket 限制）
91 | EPROTOTYPE | Protocol wrong type for socket | socket 類型與協定不符
92 | ENOPROTOOPT | Protocol not available | 這個協定不支援該選項
93 | EPROTONOSUPPORT | Protocol not supported | 不支援這個協定
95 | EOPNOTSUPP | Operation not supported | 這個操作不被支援（也是 ENOTSUP）
97 | EAFNOSUPPORT | Address family not supported by protocol | 不支援的位址家族
98 | EADDRINUSE | Address already in use | 位址（埠號）已被使用；伺服器重啟時常見，可設 SO_REUSEADDR
99 | EADDRNOTAVAIL | Cannot assign requested address | 無法使用該位址（本機沒有這個 IP）
100 | ENETDOWN | Network is down | 網路介面停用
101 | ENETUNREACH | Network is unreachable | 網路不可達（沒有路由）
103 | ECONNABORTED | Software caused connection abort | 連線被本機軟體中止
104 | ECONNRESET | Connection reset by peer | 連線被對方重設（對方行程崩潰、防火牆、對方強制關閉）
105 | ENOBUFS | No buffer space available | 沒有緩衝區空間
106 | EISCONN | Transport endpoint is already connected | 已經連線
107 | ENOTCONN | Transport endpoint is not connected | 尚未連線
110 | ETIMEDOUT | Connection timed out | 連線逾時（對方沒回應或被防火牆丟棄）
111 | ECONNREFUSED | Connection refused | 連線被拒絕（對方埠沒有服務在聽）
112 | EHOSTDOWN | Host is down | 主機關機
113 | EHOSTUNREACH | No route to host | 找不到通往主機的路由
114 | EALREADY | Operation already in progress | 操作已在進行中
115 | EINPROGRESS | Operation now in progress | 非阻塞連線正在進行（要等可寫再檢查 SO_ERROR）
116 | ESTALE | Stale file handle | 檔案控制代碼過期（NFS）
122 | EDQUOT | Disk quota exceeded | 超過磁碟配額
125 | ECANCELED | Operation canceled | 操作被取消
130 | EOWNERDEAD | Owner died | 持有互斥鎖的行程已死
131 | ENOTRECOVERABLE | State not recoverable | 狀態無法復原
133 | EHWPOISON | Memory page has hardware error | 記憶體頁有硬體錯誤
512 | ERESTARTSYS | To be restarted if SA_RESTART is set | 核心內部：被訊號打斷、可能重啟（不會傳到使用者空間）
@signal
1 | SIGHUP | Hangup | 終端機掛斷或控制行程結束；常用來通知常駐程式重新讀設定
2 | SIGINT | Interrupt | 使用者按 Ctrl+C
3 | SIGQUIT | Quit | 使用者按 Ctrl+\，會產生 core dump
4 | SIGILL | Illegal instruction | 執行了非法指令（跑錯架構的程式、程式碼損毀、用了 CPU 不支援的指令）
5 | SIGTRAP | Trace/breakpoint trap | 除錯中斷點（int3）
6 | SIGABRT | Aborted | 程式呼叫 abort()：assert 失敗、glibc 偵測到 heap 損毀、未捕捉的 C++ 例外
7 | SIGBUS | Bus error | 匯流排錯誤：未對齊存取、存取 mmap 檔案已被截斷的區域
8 | SIGFPE | Floating point exception | 算術例外：整數除以零、溢位（不一定是浮點）
9 | SIGKILL | Killed | 被強制結束，無法捕捉；常是 OOM killer 或 kill -9
10 | SIGUSR1 | User defined signal 1 | 使用者自訂訊號 1
11 | SIGSEGV | Segmentation fault | 存取了無效記憶體位址：空指標、野指標、堆疊溢位、寫入唯讀區
12 | SIGUSR2 | User defined signal 2 | 使用者自訂訊號 2
13 | SIGPIPE | Broken pipe | 寫入已關閉的管線或 socket（預設會終止行程；伺服器常設為忽略）
14 | SIGALRM | Alarm clock | alarm() 計時到
15 | SIGTERM | Terminated | 請求結束（kill 預設、systemd stop），可以捕捉做清理
17 | SIGCHLD | Child exited | 子行程結束或暫停
18 | SIGCONT | Continued | 繼續被暫停的行程
19 | SIGSTOP | Stopped (signal) | 暫停行程，無法捕捉
20 | SIGTSTP | Stopped | 使用者按 Ctrl+Z
24 | SIGXCPU | CPU time limit exceeded | 超過 CPU 時間限制
25 | SIGXFSZ | File size limit exceeded | 超過檔案大小限制
31 | SIGSYS | Bad system call | 錯誤的系統呼叫（被 seccomp 擋下常見）
@exit
0 | SUCCESS | Success | 成功
1 | GENERAL | General error | 一般性錯誤（程式自訂；很多工具用 1 表示失敗；grep 用 1 表示沒找到）
2 | MISUSE | Misuse of shell builtins / usage error | 用法錯誤：參數不對（bash 內建與許多 CLI 的慣例）
126 | NOT_EXECUTABLE | Command invoked cannot execute | 找到命令但不能執行（沒有執行權限、是資料夾、格式不對）
127 | NOT_FOUND | Command not found | 找不到命令（PATH 沒有、拼錯、或腳本的直譯器路徑不存在）
128 | INVALID_EXIT | Invalid argument to exit | exit 的引數無效
130 | SIGINT | Terminated by Ctrl+C | 被 Ctrl+C（SIGINT）結束，即 128+2
134 | SIGABRT | Aborted | 被 SIGABRT 結束，即 128+6（assert／abort）
137 | SIGKILL | Killed | 被 SIGKILL 結束，即 128+9（OOM killer 或 kill -9；容器記憶體超限常見）
139 | SIGSEGV | Segmentation fault | 被 SIGSEGV 結束，即 128+11（記憶體存取錯誤）
141 | SIGPIPE | Broken pipe | 被 SIGPIPE 結束，即 128+13
143 | SIGTERM | Terminated | 被 SIGTERM 結束，即 128+15（正常的停止請求）
255 | OUT_OF_RANGE | Exit status out of range | 退出碼超出範圍或 ssh 連線層級失敗（ssh 用 255 表示連線錯誤）
@win32
0 | ERROR_SUCCESS | The operation completed successfully. | 成功
1 | ERROR_INVALID_FUNCTION | Incorrect function. | 功能無效（常見：對不支援的裝置呼叫 DeviceIoControl）
2 | ERROR_FILE_NOT_FOUND | The system cannot find the file specified. | 找不到檔案（路徑、檔名錯誤）
3 | ERROR_PATH_NOT_FOUND | The system cannot find the path specified. | 找不到路徑（中間的資料夾不存在）
4 | ERROR_TOO_MANY_OPEN_FILES | The system cannot open the file. | 開啟的檔案太多
5 | ERROR_ACCESS_DENIED | Access is denied. | 存取被拒：權限不足、需要以系統管理員身分執行、檔案被獨占鎖定、UAC／完整性層級
6 | ERROR_INVALID_HANDLE | The handle is invalid. | 控制代碼無效（已關閉、未初始化、類型不對）
8 | ERROR_NOT_ENOUGH_MEMORY | Not enough memory resources are available to process this command. | 記憶體不足
13 | ERROR_INVALID_DATA | The data is invalid. | 資料無效
14 | ERROR_OUTOFMEMORY | Not enough storage is available to complete this operation. | 記憶體（儲存空間）不足
15 | ERROR_INVALID_DRIVE | The system cannot find the drive specified. | 找不到磁碟機代號
17 | ERROR_NOT_SAME_DEVICE | The system cannot move the file to a different disk drive. | 不能跨磁碟移動
18 | ERROR_NO_MORE_FILES | There are no more files. | 列舉已經結束（FindNextFile 的正常結尾，不是錯誤）
19 | ERROR_WRITE_PROTECT | The media is write protected. | 媒體寫入保護
21 | ERROR_NOT_READY | The device is not ready. | 裝置未就緒（光碟機沒碟、網路磁碟機斷線）
23 | ERROR_CRC | Data error (cyclic redundancy check). | 資料錯誤（CRC），常是儲存媒體損壞
24 | ERROR_BAD_LENGTH | The program issued a command but the command length is incorrect. | 命令長度不對（結構大小欄位沒設）
31 | ERROR_GEN_FAILURE | A device attached to the system is not functioning. | 連接的裝置無法運作（一般裝置失敗）
32 | ERROR_SHARING_VIOLATION | The process cannot access the file because it is being used by another process. | 檔案被另一個行程以不相容的共用模式開著（防毒、編輯器、另一個執行個體）
33 | ERROR_LOCK_VIOLATION | The process cannot access the file because another process has locked a portion of the file. | 檔案區段被別的行程鎖住
38 | ERROR_HANDLE_EOF | Reached the end of the file. | 讀到檔案結尾
50 | ERROR_NOT_SUPPORTED | The request is not supported. | 不支援這個要求
53 | ERROR_BAD_NETPATH | The network path was not found. | 找不到網路路徑（主機名稱或共用名稱錯誤）
55 | ERROR_DEV_NOT_EXIST | The specified network resource or device is no longer available. | 網路資源或裝置已消失
65 | ERROR_NETWORK_ACCESS_DENIED | Network access is denied. | 網路存取被拒
67 | ERROR_BAD_NET_NAME | The network name cannot be found. | 找不到網路名稱（共用資料夾名稱錯誤）
80 | ERROR_FILE_EXISTS | The file exists. | 檔案已存在
82 | ERROR_CANNOT_MAKE | The directory or file cannot be created. | 無法建立
87 | ERROR_INVALID_PARAMETER | The parameter is incorrect. | 參數不正確：旗標組合不合法、結構欄位未初始化、值超出範圍
89 | ERROR_NO_PROC_SLOTS | The system cannot start another process at this time. | 暫時無法再啟動行程
109 | ERROR_BROKEN_PIPE | The pipe has been ended. | 管線已結束（對方關閉）
112 | ERROR_DISK_FULL | There is not enough space on the disk. | 磁碟空間不足
122 | ERROR_INSUFFICIENT_BUFFER | The data area passed to a system call is too small. | 緩衝區太小：用回傳的所需大小重新配置後再呼叫
123 | ERROR_INVALID_NAME | The filename, directory name, or volume label syntax is incorrect. | 檔名、資料夾名稱或磁碟標籤的語法錯誤（含非法字元）
126 | ERROR_MOD_NOT_FOUND | The specified module could not be found. | 找不到模組：LoadLibrary 載入 DLL 失敗，常因缺少相依的 DLL（用 Dependencies 工具檢查）
127 | ERROR_PROC_NOT_FOUND | The specified procedure could not be found. | 找不到函式：GetProcAddress 失敗，DLL 版本不符或匯出名稱錯
145 | ERROR_DIR_NOT_EMPTY | The directory is not empty. | 資料夾不是空的
158 | ERROR_NOT_LOCKED | The segment is already unlocked. | 已經解除鎖定
170 | ERROR_BUSY | The requested resource is in use. | 資源使用中
183 | ERROR_ALREADY_EXISTS | Cannot create a file when that file already exists. | 已經存在（建立檔案、具名物件如 mutex／event 時；常用來偵測程式重複執行）
193 | ERROR_BAD_EXE_FORMAT | %1 is not a valid Win32 application. | 不是有效的 Win32 應用程式（32／64 位元不符、檔案損毀）
206 | ERROR_FILENAME_EXCED_RANGE | The filename or extension is too long. | 檔名或路徑太長（超過 MAX_PATH 260；可用 \\?\ 前綴或啟用長路徑）
216 | ERROR_EXE_MACHINE_TYPE_MISMATCH | This version of %1 is not compatible with the version of Windows you're running. | 執行檔的 CPU 架構與系統不符
231 | ERROR_PIPE_BUSY | All pipe instances are busy. | 具名管線的所有執行個體都忙碌
232 | ERROR_NO_DATA | The pipe is being closed. | 管線正在關閉
234 | ERROR_MORE_DATA | More data is available. | 還有更多資料：緩衝區放不下，需再讀或加大緩衝區（不是失敗）
258 | WAIT_TIMEOUT | The wait operation timed out. | 等待逾時
259 | ERROR_NO_MORE_ITEMS | No more data is available. | 列舉結束
267 | ERROR_DIRECTORY | The directory name is invalid. | 資料夾名稱無效（或對檔案當資料夾用）
298 | ERROR_TOO_MANY_POSTS | Too many posts were made to a semaphore. | 號誌釋放次數過多
299 | ERROR_PARTIAL_COPY | Only part of a ReadProcessMemory or WriteProcessMemory request was completed. | 只完成部分記憶體讀寫（目標位址部分不可存取）
317 | ERROR_MR_MID_NOT_FOUND | The system cannot find message text for message number in the message file. | 找不到訊息文字（FormatMessage 常見）
377 | ERROR_NOT_ENOUGH_QUOTA | Not enough quota is available to process this command. | 配額不足
487 | ERROR_INVALID_ADDRESS | Attempt to access invalid address. | 存取無效位址
534 | ERROR_ARITHMETIC_OVERFLOW | Arithmetic result exceeded 32 bits. | 算術結果溢位
535 | ERROR_PIPE_CONNECTED | There is a process on other end of the pipe. | 管線另一端已有行程連上（ConnectNamedPipe 的正常情況）
536 | ERROR_PIPE_LISTENING | Waiting for a process to open the other end of the pipe. | 等待另一端開啟管線
565 | ERROR_TOO_MANY_THREADS | Too many threads. | 執行緒太多
577 | ERROR_INVALID_IMAGE_HASH | Windows cannot verify the digital signature for this file. | 無法驗證檔案的數位簽章（驅動或程式簽章問題）
593 | ERROR_INVALID_CREATE_FLAGS | Invalid flags. | 旗標無效
740 | ERROR_ELEVATION_REQUIRED | The requested operation requires elevation. | 需要提高權限（以系統管理員身分執行）
997 | ERROR_IO_PENDING | Overlapped I/O operation is in progress. | 重疊 I/O 進行中（非同步的正常回傳，不是失敗）
998 | ERROR_NOACCESS | Invalid access to memory location. | 記憶體存取無效
1004 | ERROR_INVALID_FLAGS | Invalid flags. | 旗標無效
1008 | ERROR_NO_TOKEN | An attempt was made to reference a token that does not exist. | 參考不存在的權杖
1058 | ERROR_SERVICE_DISABLED | The service cannot be started, either because it is disabled or because it has no enabled devices associated with it. | 服務已停用，無法啟動
1060 | ERROR_SERVICE_DOES_NOT_EXIST | The specified service does not exist as an installed service. | 服務不存在
1062 | ERROR_SERVICE_NOT_ACTIVE | The service has not been started. | 服務沒有啟動
1053 | ERROR_SERVICE_REQUEST_TIMEOUT | The service did not respond to the start or control request in a timely fashion. | 服務沒有及時回應啟動或控制要求
1056 | ERROR_SERVICE_ALREADY_RUNNING | An instance of the service is already running. | 服務已在執行
1067 | ERROR_PROCESS_ABORTED | The process terminated unexpectedly. | 行程意外終止
1168 | ERROR_NOT_FOUND | Element not found. | 找不到項目
1210 | ERROR_INVALID_COMPUTERNAME | The format of the specified computer name is invalid. | 電腦名稱格式無效
1219 | ERROR_SESSION_CREDENTIAL_CONFLICT | Multiple connections to a server or shared resource by the same user are not allowed. | 同一使用者以不同認證連到同一伺服器衝突
1223 | ERROR_CANCELLED | The operation was canceled by the user. | 使用者取消
1225 | ERROR_CONNECTION_REFUSED | The remote system refused the network connection. | 遠端系統拒絕連線
1326 | ERROR_LOGON_FAILURE | The user name or password is incorrect. | 使用者名稱或密碼錯誤
1331 | ERROR_ACCOUNT_DISABLED | This user account has been disabled. | 帳戶已停用
1332 | ERROR_NONE_MAPPED | No mapping between account names and security IDs was done. | 帳戶名稱找不到對應的 SID
1314 | ERROR_PRIVILEGE_NOT_HELD | A required privilege is not held by the client. | 缺少所需的特殊權限（例如 SeDebugPrivilege、SeBackupPrivilege）；要用 AdjustTokenPrivileges 啟用，或以系統管理員執行
1450 | ERROR_NO_SYSTEM_RESOURCES | Insufficient system resources exist to complete the requested service. | 系統資源不足
1455 | ERROR_COMMITMENT_LIMIT | The paging file is too small for this operation to complete. | 分頁檔太小，提交記憶體超過上限
1722 | RPC_S_SERVER_UNAVAILABLE | The RPC server is unavailable. | RPC 伺服器不可用（服務沒啟動、防火牆、名稱解析）
1784 | ERROR_INVALID_USER_BUFFER | The supplied user buffer is not valid for the requested operation. | 使用者緩衝區無效
1813 | ERROR_RESOURCE_TYPE_NOT_FOUND | The specified resource type cannot be found in the image file. | 映像檔裡找不到該資源類型
1814 | ERROR_RESOURCE_NAME_NOT_FOUND | The specified resource name cannot be found in the image file. | 映像檔裡找不到該資源名稱
1920 | ERROR_CANT_ACCESS_FILE | The file cannot be accessed by the system. | 系統無法存取該檔案
2250 | ERROR_NOT_CONNECTED | The network connection does not exist. | 網路連線不存在
@winsock
10004 | WSAEINTR | A blocking operation was interrupted by a call to WSACancelBlockingCall. | 阻塞操作被中斷
10009 | WSAEBADF | The file handle supplied is not valid. | 控制代碼無效
10013 | WSAEACCES | An attempt was made to access a socket in a way forbidden by its access permissions. | socket 權限不允許（例如綁定到被獨占的埠、廣播未設選項）
10014 | WSAEFAULT | The system detected an invalid pointer address in attempting to use a pointer argument of a call. | 指標位址無效
10022 | WSAEINVAL | An invalid argument was supplied. | 參數無效（常見：未先 bind 就 listen／accept）
10024 | WSAEMFILE | Too many open sockets. | socket 太多
10035 | WSAEWOULDBLOCK | A non-blocking socket operation could not be completed immediately. | 非阻塞操作暫時無法完成，稍後再試（不是真的錯誤）
10036 | WSAEINPROGRESS | A blocking operation is currently executing. | 有阻塞操作正在進行
10037 | WSAEALREADY | An operation was attempted on a non-blocking socket that already had an operation in progress. | 非阻塞 socket 已有操作在進行
10038 | WSAENOTSOCK | An operation was attempted on something that is not a socket. | 對非 socket 做 socket 操作（socket 已關閉或值無效）
10040 | WSAEMSGSIZE | A message sent on a datagram socket was larger than the internal message buffer. | 資料報太大或接收緩衝區太小
10043 | WSAEPROTONOSUPPORT | The requested protocol has not been configured into the system. | 不支援的協定
10047 | WSAEAFNOSUPPORT | An address incompatible with the requested protocol was used. | 位址家族不支援
10048 | WSAEADDRINUSE | Only one usage of each socket address (protocol/network address/port) is normally permitted. | 位址（埠）已被使用
10049 | WSAEADDRNOTAVAIL | The requested address is not valid in its context. | 位址在此環境無效（本機沒有這個 IP）
10050 | WSAENETDOWN | A socket operation encountered a dead network. | 網路掛了
10051 | WSAENETUNREACH | A socket operation was attempted to an unreachable network. | 網路不可達
10053 | WSAECONNABORTED | An established connection was aborted by the software in your host computer. | 連線被本機軟體中止（逾時、通訊協定錯誤）
10054 | WSAECONNRESET | An existing connection was forcibly closed by the remote host. | 連線被遠端強制關閉（對方崩潰、重設、防火牆）
10055 | WSAENOBUFS | An operation on a socket could not be performed because the system lacked sufficient buffer space or because a queue was full. | 緩衝區空間不足
10056 | WSAEISCONN | A connect request was made on an already connected socket. | 已經連線
10057 | WSAENOTCONN | A request to send or receive data was disallowed because the socket is not connected. | socket 尚未連線
10058 | WSAESHUTDOWN | A request to send or receive data was disallowed because the socket had already been shut down in that direction. | 該方向已 shutdown
10060 | WSAETIMEDOUT | A connection attempt failed because the connected party did not properly respond after a period of time. | 連線逾時
10061 | WSAECONNREFUSED | No connection could be made because the target machine actively refused it. | 對方主動拒絕（埠沒有服務在聽）
10064 | WSAEHOSTDOWN | A socket operation failed because the destination host was down. | 目的主機關機
10065 | WSAEHOSTUNREACH | A socket operation was attempted to an unreachable host. | 找不到通往主機的路由
10091 | WSASYSNOTREADY | Network subsystem is unavailable. | 網路子系統不可用
10093 | WSANOTINITIALISED | Successful WSAStartup not yet performed. | 還沒呼叫 WSAStartup
11001 | WSAHOST_NOT_FOUND | No such host is known. | 找不到主機（DNS 查詢失敗）
11002 | WSATRY_AGAIN | This is usually a temporary error during hostname resolution. | 名稱解析暫時失敗，稍後再試
11004 | WSANO_DATA | The requested name is valid, but no data of the requested type was found. | 名稱有效但沒有該類型的紀錄
@hresult
0x00000000 | S_OK | Operation successful | 成功
0x00000001 | S_FALSE | Operation successful (false) | 成功但結果為「否」
0x80004001 | E_NOTIMPL | Not implemented | 沒有實作
0x80004002 | E_NOINTERFACE | No such interface supported | 物件不支援要求的介面（QueryInterface 失敗）
0x80004003 | E_POINTER | Pointer that is not valid | 指標無效（傳了 NULL）
0x80004004 | E_ABORT | Operation aborted | 操作中止
0x80004005 | E_FAIL | Unspecified failure | 未指定的失敗（沒有更細的原因，需看其他日誌）
0x8000FFFF | E_UNEXPECTED | Catastrophic failure | 嚴重／非預期的失敗
0x80070005 | E_ACCESSDENIED | General access denied error | 存取被拒（即 Win32 ERROR_ACCESS_DENIED）
0x80070006 | E_HANDLE | Handle that is not valid | 控制代碼無效
0x8007000E | E_OUTOFMEMORY | Failed to allocate necessary memory | 記憶體不足
0x80070057 | E_INVALIDARG | One or more arguments are not valid | 參數無效（即 ERROR_INVALID_PARAMETER 87）
0x800700B7 | HRESULT_ALREADY_EXISTS | Cannot create a file when that file already exists | 已存在（Win32 183）
0x80070002 | HRESULT_FILE_NOT_FOUND | The system cannot find the file specified | 找不到檔案（Win32 2）
0x80070003 | HRESULT_PATH_NOT_FOUND | The system cannot find the path specified | 找不到路徑（Win32 3）
0x8007007E | HRESULT_MOD_NOT_FOUND | The specified module could not be found | 找不到模組／DLL（Win32 126）
0x800704C7 | HRESULT_CANCELLED | The operation was canceled by the user | 使用者取消（Win32 1223）
0x80040154 | REGDB_E_CLASSNOTREG | Class not registered | COM 類別沒註冊（DLL／TLB 沒 regsvr32，或位元數不符）
0x80040150 | REGDB_E_READREGDB | Could not read key from registry | 讀不到登錄機碼
0x800401F0 | CO_E_NOTINITIALIZED | CoInitialize has not been called | 沒有呼叫 CoInitialize
0x800401F3 | CO_E_CLASSSTRING | Invalid class string | CLSID／ProgID 字串無效
0x80010106 | RPC_E_CHANGED_MODE | Cannot change thread mode after it is set | 執行緒的 COM 模型（STA／MTA）已設定，不能改
0x80010108 | RPC_E_DISCONNECTED | The object invoked has disconnected from its clients | 被呼叫的物件已與用戶端斷線
0x800706BA | RPC_S_SERVER_UNAVAILABLE_HR | The RPC server is unavailable | RPC 伺服器不可用
0x800706BE | RPC_S_CALL_FAILED | The remote procedure call failed | 遠端程序呼叫失敗
0x80020009 | DISP_E_EXCEPTION | Exception occurred | IDispatch 呼叫發生例外
0x80020005 | DISP_E_TYPEMISMATCH | Type mismatch | 型別不符
0x8002000E | DISP_E_BADPARAMCOUNT | Invalid number of parameters | 參數數量不對
0x80030005 | STG_E_ACCESSDENIED | Access denied | 結構化儲存存取被拒
0x80070490 | HRESULT_NOT_FOUND | Element not found | 找不到項目（Win32 1168）
0x8007139F | HRESULT_INVALID_STATE | The group or resource is not in the correct state to perform the requested operation | 狀態不正確，無法執行
0x80072EE2 | WININET_E_TIMEOUT | The operation timed out | 網路操作逾時（WinINet）
0x80072EE7 | WININET_E_NAME_NOT_RESOLVED | The server name or address could not be resolved | 無法解析伺服器名稱
0x80072EFD | WININET_E_CANNOT_CONNECT | A connection with the server could not be established | 無法連到伺服器
0x80072F8F | WININET_E_DECODING_FAILED | A security error occurred | TLS／安全連線錯誤（時間不對或憑證）
0x887A0005 | DXGI_ERROR_DEVICE_REMOVED | The video card has been physically removed from the system, or a driver upgrade has occurred | 顯示卡被移除或驅動更新，裝置遺失，需重建 D3D 裝置
0x887A0006 | DXGI_ERROR_DEVICE_HUNG | The application's device failed due to badly formed commands | 顯示裝置掛住（GPU 超時、命令錯誤）
0x887A0007 | DXGI_ERROR_DEVICE_RESET | The device failed due to a badly formed command | 裝置重設
0x887A0001 | DXGI_ERROR_INVALID_CALL | The application made a call that is invalid | DXGI 呼叫無效
0x8876086C | D3DERR_INVALIDCALL | Invalid call | D3D9 呼叫無效
0x80090016 | NTE_BAD_KEYSET | Keyset does not exist | 金鑰容器不存在（CryptoAPI）
0x8009000F | NTE_EXISTS | Object already exists | 物件已存在
0x80090008 | NTE_BAD_ALGID | Invalid algorithm specified | 演算法無效
0x80090305 | SEC_E_SECPKG_NOT_FOUND | The specified security package does not exist | 安全套件不存在
0x80090308 | SEC_E_INVALID_TOKEN | The token supplied to the function is invalid | 權杖無效
0x8009030C | SEC_E_LOGON_DENIED | The logon attempt failed | 登入失敗
0x80092004 | CRYPT_E_NOT_FOUND | Cannot find object or property | 找不到憑證或屬性
0x800B0109 | CERT_E_UNTRUSTEDROOT | A certificate chain processed, but terminated in a root certificate which is not trusted | 憑證鏈的根憑證不受信任
0x800B010A | CERT_E_CHAINING | A certificate chain could not be built to a trusted root authority | 無法建立到受信任根的憑證鏈
0x800B0101 | CERT_E_EXPIRED | A required certificate is not within its validity period | 憑證過期或尚未生效
0x80240022 | WU_E_ALL_UPDATES_FAILED | Operation failed for all the updates | Windows Update 所有更新失敗
0x8024402C | WU_E_PT_WINHTTP_NAME_NOT_RESOLVED | Windows Update Agent could not resolve the proxy or server name | Windows Update 無法解析名稱（網路或 proxy）
@ntstatus
0x00000000 | STATUS_SUCCESS | STATUS_SUCCESS | 成功
0x00000103 | STATUS_PENDING | The operation that was requested is pending completion | 操作進行中（非同步）
0x40000000 | STATUS_OBJECT_NAME_EXISTS_INFO | An object name already exists | 資訊：物件名稱已存在
0x80000005 | STATUS_BUFFER_OVERFLOW | The data was too large to fit into the specified buffer | 緩衝區放不下（警告）：已填入部分資料
0x80000006 | STATUS_NO_MORE_FILES | No more files were found which match the file specification | 沒有更多檔案
0x80000011 | STATUS_DEVICE_BUSY | The device is currently busy | 裝置忙碌
0x80000026 | STATUS_LONGJUMP | A long jump has been executed | 執行了 longjmp
0x80000002 | STATUS_DATATYPE_MISALIGNMENT | A datatype misalignment was detected in a load or store instruction | 載入／儲存指令的資料型別未對齊
0x80000003 | STATUS_BREAKPOINT | A breakpoint has been reached | 中斷點（int3；除錯器）
0x80000004 | STATUS_SINGLE_STEP | A single step or trace operation has just been completed | 單步執行完成
0xC0000001 | STATUS_UNSUCCESSFUL | {Operation Failed} The requested operation was unsuccessful | 操作未成功（通用失敗）
0xC0000002 | STATUS_NOT_IMPLEMENTED | {Not Implemented} The requested operation is not implemented | 沒有實作
0xC0000005 | STATUS_ACCESS_VIOLATION | The instruction at 0x%p referenced memory at 0x%p. The memory could not be %s | 記憶體存取違規：讀／寫了無效或未配置的位址（空指標、野指標、使用已釋放記憶體、DEP 阻擋執行）；程式崩潰最常見的原因，等同 Linux 的 SIGSEGV
0xC0000008 | STATUS_INVALID_HANDLE | An invalid HANDLE was specified | 控制代碼無效
0xC000000D | STATUS_INVALID_PARAMETER | An invalid parameter was passed to a service or function | 參數無效
0xC000000F | STATUS_NO_SUCH_FILE | The file does not exist | 檔案不存在
0xC0000017 | STATUS_NO_MEMORY | {Not Enough Quota} Not enough virtual memory or paging file quota is available | 記憶體或分頁檔額度不足
0xC0000022 | STATUS_ACCESS_DENIED | {Access Denied} A process has requested access to an object, but has not been granted those access rights | 存取被拒
0xC0000023 | STATUS_BUFFER_TOO_SMALL | The buffer is too small to contain the entry | 緩衝區太小
0xC0000034 | STATUS_OBJECT_NAME_NOT_FOUND | Object Name not found | 找不到物件名稱
0xC0000035 | STATUS_OBJECT_NAME_COLLISION | Object Name already exists | 物件名稱已存在
0xC000003A | STATUS_OBJECT_PATH_NOT_FOUND | The path does not exist | 路徑不存在
0xC0000043 | STATUS_SHARING_VIOLATION | A file cannot be opened because the share access flags are incompatible | 共用違規：檔案被別人以不相容模式開著
0xC0000054 | STATUS_FILE_LOCK_CONFLICT | A requested read/write cannot be granted due to a conflicting file lock | 檔案鎖衝突
0xC000005A | STATUS_INVALID_OWNER | Indicates a particular security ID may not be assigned as the owner of an object | 無效的擁有者
0xC0000094 | STATUS_INTEGER_DIVIDE_BY_ZERO | {EXCEPTION} Integer divide by zero | 整數除以零
0xC0000095 | STATUS_INTEGER_OVERFLOW | {EXCEPTION} Integer overflow | 整數溢位
0xC000001D | STATUS_ILLEGAL_INSTRUCTION | {EXCEPTION} Illegal Instruction | 非法指令
0xC0000025 | STATUS_NONCONTINUABLE_EXCEPTION | {EXCEPTION} Windows cannot continue from this exception | 無法從這個例外繼續
0xC0000026 | STATUS_INVALID_DISPOSITION | An invalid exception disposition was returned by an exception handler | 例外處理器回傳無效處置
0xC000008C | STATUS_ARRAY_BOUNDS_EXCEEDED | {EXCEPTION} Array bounds exceeded | 陣列越界
0xC000008E | STATUS_FLOAT_DIVIDE_BY_ZERO | {EXCEPTION} Floating-point division by zero | 浮點除以零
0xC0000090 | STATUS_FLOAT_INVALID_OPERATION | {EXCEPTION} Floating-point invalid operation | 浮點無效運算
0xC00000FD | STATUS_STACK_OVERFLOW | A new guard page for the stack cannot be created | 堆疊溢位（無限遞迴、過大的區域變數）
0xC0000135 | STATUS_DLL_NOT_FOUND | {Unable To Locate Component} This application has failed to start because %hs was not found | 找不到 DLL：程式啟動失敗（缺少 VC++ 執行階段或相依 DLL），常見訊息「0xC0000135」
0xC0000139 | STATUS_ENTRYPOINT_NOT_FOUND | The procedure entry point could not be located in the dynamic link library | 在 DLL 中找不到匯出函式（DLL 版本不符）
0xC0000142 | STATUS_DLL_INIT_FAILED | {DLL Initialization Failed} Initialization of the dynamic library %hs failed | DLL 初始化失敗，行程將結束
0xC0000148 | STATUS_INVALID_PARAMETER_MIX | An invalid combination of parameters was specified | 參數組合無效
0xC000014B | STATUS_PIPE_BROKEN | The pipe operation has failed because the other end of the pipe has been closed | 管線另一端已關閉
0xC0000194 | STATUS_POSSIBLE_DEADLOCK | {EXCEPTION} Possible deadlock condition | 可能死鎖
0xC000010A | STATUS_PROCESS_IS_TERMINATING | An attempt was made to access an exiting process | 行程正在結束
0xC000012D | STATUS_COMMITMENT_LIMIT | {Out of Virtual Memory} Your system is low on virtual memory | 虛擬記憶體（提交額度）用完
0xC0000185 | STATUS_IO_DEVICE_ERROR | The I/O device reported an I/O error | I/O 裝置錯誤
0xC000020C | STATUS_CONNECTION_DISCONNECTED | The transport connection is now disconnected | 傳輸連線已斷開
0xC000021A | STATUS_SYSTEM_PROCESS_TERMINATED | {Fatal System Error} The system process terminated unexpectedly | 系統行程意外終止（會藍屏）
0xC0000225 | STATUS_NOT_FOUND | Not Found | 找不到
0xC0000227 | STATUS_ALREADY_COMMITTED | The specified address range is already committed | 位址範圍已提交
0xC0000240 | STATUS_REQUEST_ABORTED | The request was aborted | 要求被中止
0xC000026E | STATUS_VOLUME_DISMOUNTED | An operation was attempted to a volume after it was dismounted | 磁碟區已卸載
0xC0000374 | STATUS_HEAP_CORRUPTION | A heap has been corrupted | 堆積（heap）損毀：重複釋放、緩衝區溢位、寫入已釋放記憶體
0xC0000409 | STATUS_STACK_BUFFER_OVERRUN | The system detected an overrun of a stack-based buffer in this application | 偵測到堆疊緩衝區溢位（/GS、__fastfail，也用於 fail-fast 例外）
0xC0000417 | STATUS_INVALID_CRUNTIME_PARAMETER | An invalid parameter was passed to a C runtime function | 傳給 C 執行階段函式的參數無效
0xC0000420 | STATUS_ASSERTION_FAILURE | An assertion failure has occurred | 斷言失敗
0xC0000602 | STATUS_FAIL_FAST_EXCEPTION | A fail fast exception occurred | Fail-fast 例外：程式偵測到嚴重錯誤主動終止
0xC06D007E | VCPP_E_MOD_NOT_FOUND | Delay-load module not found | 延遲載入的模組找不到（Visual C++）
0xC06D007F | VCPP_E_PROC_NOT_FOUND | Delay-load procedure not found | 延遲載入的函式找不到
0xE06D7363 | CXX_EXCEPTION | Microsoft C++ exception | 未被處理的 C++ 例外（例外碼 'msc'）：看例外類型與訊息，常是 std::exception
0xE0434352 | CLR_EXCEPTION | .NET CLR exception | 未處理的 .NET 例外（'CCR'）
0x40010005 | DBG_CONTROL_C | Control-C | 使用者按 Ctrl+C
0x40010006 | DBG_PRINTEXCEPTION_C | Debug print exception | OutputDebugString 產生的例外（除錯器用）
0x406D1388 | MS_VC_EXCEPTION | Thread name exception | 設定執行緒名稱的特殊例外（除錯器用，可忽略）
