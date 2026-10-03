# 平行與 GPU 工具鏈：MPI（MPICH、MVAPICH2、Open MPI）啟動器與編譯包裝、CUDA 編譯與除錯、OpenMP 環境變數
## mpirun | mpiexec,mpiexec.hydra,mpiexec.mpich,orterun,mpirun.mpich,mpirun_rsh | 啟動 MPI 程式（MPICH／MVAPICH2 用 Hydra，Open MPI 用 orterun）：在一或多台機器上開 N 個行程 | mpirun -np N [選項] 程式 [引數...]
-np | 數量 | 啟動的 MPI 行程總數
-n | 數量 | 同 -np
-ppn | 數量 | 每個節點啟動幾個行程（Hydra）
--map-by | 規則 | 行程如何分配到節點與核心（Open MPI，例如 ppr:2:node、socket）
--bind-to | 目標 | 把行程綁到核心、插座或不綁（core、socket、none）；效能與可重現性相關
-hosts | 主機清單 | 以逗號分隔的主機名稱（Hydra）
-f | 檔案 | 主機清單檔（Hydra 的 hostfile）
-hostfile | 檔案 | 主機清單檔
--hostfile | 檔案 | 主機清單檔（Open MPI）
-machinefile | 檔案 | 主機清單檔
-host | 主機 | 指定主機（Open MPI）
-x | 變數 | 把環境變數傳給所有行程（Open MPI）
-genv | 變數 值 | 設定所有行程的環境變數（Hydra），例如 -genv MV2_ENABLE_AFFINITY 0
-genvall |  | 傳遞所有環境變數
-env | 變數 值 | 為單一程式設定環境變數（Hydra）
-wdir | 目錄 | 工作目錄
-launcher | 方式 | 遠端啟動方式（ssh、rsh、slurm、ll…）
-bootstrap | 方式 | 同 -launcher（Hydra）
-prepend-rank |  | 在每行輸出前加上行程編號
-l |  | 同 -prepend-rank
-oversubscribe |  | 允許行程數超過核心數（Open MPI）
--mca | 參數 值 | 設定 Open MPI 元件參數（例如 btl ^openib）
-verbose |  | 顯示啟動過程
-v |  | 顯示啟動過程（詳細）
-iface | 介面 | 使用的網路介面
-nolocal |  | 不在本機啟動行程
-launcher-exec | 程式 | 指定遠端啟動程式
--allow-run-as-root |  | 允許以 root 執行（Open MPI）
## mpicc | mpicxx,mpic++,mpif90,mpifort,mpif77,mpicc.mpich,mpicxx.mpich | MPI 編譯包裝：呼叫底層編譯器並自動加上 MPI 的標頭路徑與函式庫（用法同 gcc／g++／gfortran） | mpicc [選項] 檔案... -o 輸出
@inherit gcc
-show |  | 只印出實際呼叫的完整編譯命令，不執行（MPICH／MVAPICH2）
-showme |  | 只印出實際呼叫的完整編譯命令，不執行（Open MPI）
-cc=* |  | 指定底層 C 編譯器 {v}（MPICH／MVAPICH2）
-cxx=* |  | 指定底層 C++ 編譯器 {v}
-compile-info |  | 顯示編譯時的選項（MPICH）
-link-info |  | 顯示連結時的選項（MPICH）
## nvcc | nvcc.exe | NVIDIA CUDA 編譯器：把 .cu 拆成主機程式碼（交給 gcc／MSVC）與裝置程式碼（編成 PTX 或 cubin） | nvcc [選項] 檔案.cu -o 輸出
-o | 檔案 | 輸出檔名
-c |  | 只編譯成目的檔
-arch=* |  | 目標 GPU 架構 {v}（例如 sm_80 為 Ampere；compute_80 只產生 PTX；native 為本機 GPU）
-gencode | 設定 | 指定要產生的虛擬與實體架構組合，例如 arch=compute_80,code=sm_80（可重複，產生支援多種 GPU 的 fatbin）
-code=* |  | 要產生的實體架構 {v}
-O0 |  | 不最佳化主機程式碼
-O1 |  | 主機最佳化等級 1
-O2 |  | 主機最佳化等級 2
-O3 |  | 主機最佳化等級 3
-G |  | 產生裝置端除錯資訊（會關閉裝置最佳化，變慢，cuda-gdb 用）
-g |  | 產生主機端除錯資訊
-lineinfo |  | 在最佳化的裝置程式碼中保留行號資訊（效能分析用，nsight 可對到原始碼行）
-std=* |  | C++ 標準 {v}（c++14、c++17、c++20）
-I* |  | 增加標頭路徑 {v}
-L* |  | 增加函式庫路徑 {v}
-l* |  | 連結函式庫 {v}（例如 -lcublas、-lcudnn、-lcurand、-lcufft、-lcudart）
-D* |  | 定義巨集 {v}
-Xcompiler | 選項 | 傳給主機編譯器的選項（例如 -Xcompiler -fopenmp,-Wall）
-Xlinker | 選項 | 傳給主機連結器的選項
-Xptxas | 選項 | 傳給 PTX 組譯器 ptxas（例如 -Xptxas -v 顯示暫存器與共用記憶體用量）
--ptxas-options=* |  | 傳給 ptxas 的選項 {v}（-v 顯示每個核心函式的暫存器、共用記憶體、spill 數）
-maxrregcount=* |  | 限制每個執行緒最多使用 {v} 個暫存器（提高佔用率，可能造成 spill）
--use_fast_math |  | 使用快速但精度較低的數學函式
-ftz=* |  | 把非正規化浮點數視為零 {v}
-prec-div=* |  | 除法精確度 {v}
-prec-sqrt=* |  | 平方根精確度 {v}
-rdc=* |  | 可重定位的裝置程式碼 {v}（true 才能跨檔案呼叫 __device__ 函式，也是動態平行必要）
-dc |  | 編譯成可重定位裝置目的檔（等於 -rdc=true -c）
-dlink |  | 連結可重定位的裝置程式碼
-ptx |  | 只產生 PTX 檔
-cubin |  | 只產生 cubin（特定架構的機器碼）
-fatbin |  | 只產生 fatbin
-keep |  | 保留所有中間檔（可看 .ptx、.cubin）
-lcuda |  | 連結 CUDA 驅動程式 API
-shared |  | 產生共享函式庫
-Xcudafe | 選項 | 傳給 CUDA 前端的選項（例如 --diag_suppress=）
-extended-lambda |  | 允許在 __host__ __device__ 與 __global__ 的 lambda 使用擴充語法
--expt-relaxed-constexpr |  | 讓裝置程式碼可呼叫主機的 constexpr 函式
--expt-extended-lambda |  | 同 -extended-lambda
-v |  | 顯示編譯步驟
--version |  | 顯示版本
-ccbin | 編譯器 | 指定主機編譯器
-pg |  | 剖析
-t | 數量 | 平行編譯多個架構的執行緒數
--threads | 數量 | 平行編譯執行緒數
## nvidia-smi | nvidia-smi.exe | NVIDIA 系統管理介面：查看與管理 GPU（使用率、記憶體、溫度、執行中的行程、拓撲） | nvidia-smi [選項]
-L |  | 列出所有 GPU 與 UUID
-l | 秒數 | 每隔幾秒重複顯示
-i | 編號 | 只看指定 GPU
-q |  | 顯示所有詳細資訊
-d | 類別 | 只顯示指定類別（MEMORY、UTILIZATION、ECC、TEMPERATURE、POWER、CLOCK、PIDS…）
--query-gpu=* |  | 查詢指定欄位 {v}（例如 name,memory.used,utilization.gpu）
--format=* |  | 輸出格式 {v}（csv、noheader、nounits）
-pm | 0|1 | 設定持久模式（需要 root）
-pl | 瓦數 | 設定功耗上限（需要 root）
-c | 模式 | 設定運算模式（DEFAULT、EXCLUSIVE_PROCESS）
-r |  | 重設 GPU
-ac | 設定 | 設定應用程式時脈
dmon |  | 持續監看每張 GPU 的功耗、溫度、使用率等
pmon |  | 持續監看每個行程的 GPU 使用
topo |  | 顯示 GPU 與網卡的互連拓撲（topo -m 為矩陣：NV# 為 NVLink、PIX／PXB／PHB／SYS 為不同 PCIe 距離）
nvlink |  | 顯示 NVLink 狀態
mig |  | 管理多執行個體 GPU（MIG）
-mig |  | 啟用或停用 MIG 模式
--gpu-reset |  | 重設 GPU
## compute-sanitizer | cuda-memcheck | NVIDIA 的 CUDA 錯誤檢查工具：偵測越界存取、競爭條件、未初始化記憶體與同步錯誤 | compute-sanitizer [選項] 程式 [引數...]
--tool | 工具 | 檢查工具：memcheck（記憶體錯誤，預設）、racecheck（共用記憶體資料競爭）、initcheck（未初始化的全域記憶體）、synccheck（同步錯誤）
--leak-check | full|no | 是否回報記憶體洩漏
--show-backtrace | 模式 | 是否顯示呼叫堆疊
--log-file | 檔案 | 輸出到檔案
--print-limit | 數量 | 最多印出幾筆錯誤
--error-exitcode | 碼 | 發現錯誤時的退出碼
## cuda-gdb |  | NVIDIA 的 GPU 除錯器（gdb 的擴充）：可在 GPU 核心函式中設中斷點、檢視執行緒與暫存器 | cuda-gdb [gdb 選項] 程式
@inherit gdb
-q |  | 不顯示啟動訊息
## ncu | nv-nsight-cu-cli | Nsight Compute：針對單一 CUDA 核心函式做詳細效能分析（佔用率、記憶體吞吐、指令混合） | ncu [選項] 程式
--set | 集合 | 要收集的指標集合（basic、full、detailed）
-o | 檔案 | 輸出報告檔
-k | 名稱 | 只分析名稱符合的核心函式
-c | 數量 | 只分析前幾次呼叫
--target-processes | 範圍 | 要分析的行程（application-only、all）
--metrics | 指標 | 指定要收集的指標
--page | 頁面 | 要顯示的報告頁面
--section | 區段 | 要收集的區段
-f |  | 覆蓋既有輸出檔
## nsys | nsight-systems | Nsight Systems：整個應用程式的時間軸效能分析（CPU、GPU、CUDA API、MPI、記憶體傳輸） | nsys profile [選項] 程式
profile |  | 開始剖析並執行程式
stats |  | 對產生的報告做統計
-o | 檔案 | 輸出報告檔
-t | 追蹤項目 | 要追蹤的 API（cuda、nvtx、osrt、cublas、cudnn、mpi、openmp）
--stats=* |  | 結束時是否輸出統計 {v}
-f |  | 覆蓋既有輸出檔
--force-overwrite=* |  | 是否覆蓋既有輸出檔 {v}
-d | 秒數 | 剖析持續時間
--delay | 秒數 | 延後多久開始剖析
--cuda-memory-usage=* |  | 是否追蹤 CUDA 記憶體用量 {v}
## srun | sbatch,salloc,squeue,scancel | Slurm 叢集排程：srun 在叢集上執行工作、sbatch 提交批次腳本、salloc 配置資源、squeue 看佇列、scancel 取消 | srun [選項] 程式
-n | 數量 | 行程（task）數
--ntasks | 數量 | 行程數
-N | 數量 | 節點數
--nodes | 數量 | 節點數
-c | 數量 | 每個 task 的 CPU 數（OpenMP 執行緒數常用）
--cpus-per-task | 數量 | 每個 task 的 CPU 數
--gres=* |  | 要求通用資源 {v}（例如 gpu:4 要四張 GPU）
--gpus=* |  | 要求 GPU 數 {v}
-p | 分區 | 使用的分區（佇列）
--partition | 分區 | 使用的分區
-t | 時間 | 時間上限（例如 02:00:00）
--time | 時間 | 時間上限
--mem=* |  | 每個節點的記憶體 {v}
--mpi=* |  | MPI 啟動方式 {v}（pmix、pmi2）
--ntasks-per-node=* |  | 每個節點的 task 數 {v}
-J | 名稱 | 工作名稱
-o | 檔案 | 標準輸出檔
-e | 檔案 | 標準錯誤檔
--pty |  | 配置偽終端機（互動式 shell）
--exclusive |  | 獨占節點
-w | 節點 | 指定節點
--export=* |  | 環境變數傳遞方式 {v}
