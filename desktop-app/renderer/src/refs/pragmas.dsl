# C／C++ 的 #pragma：指令 | 白話說明；子句另列（OpenMP／OpenACC）
@pragma
once | 這個標頭檔只被引入一次（取代 include guard 的非標準但普遍支援的寫法）
pack | 結構成員的對齊方式：pack(push,1) 表示成員之間不補空洞（協定、硬體暫存器結構常用），pack(pop) 還原；改變對齊會影響效能與未對齊存取
message | 編譯時印出一段訊息
warning | 控制警告：warning(disable: 4996) 等（MSVC）
comment | 向連結器傳遞資訊（MSVC）：comment(lib, "ws2_32.lib") 表示連結該函式庫
region | 程式碼折疊區塊的標記（編輯器用，不影響編譯）
endregion | 結束折疊區塊
GCC visibility | 設定符號可見度（push(hidden)／pop），控制共享函式庫匯出哪些符號
GCC diagnostic | 控制編譯警告：push／pop 保存與還原狀態，ignored "-Wxxx" 關閉特定警告，error 把特定警告當錯誤
GCC optimize | 針對後續函式設定最佳化選項（例如 optimize("O3")）
GCC poison | 禁止使用某些識別字（使用就報錯）
GCC target | 針對後續函式啟用機器特定選項（例如 target("avx2")）
GCC unroll | 要求編譯器把緊接的迴圈展開 {v} 次
GCC ivdep | 告訴編譯器緊接迴圈的迭代之間沒有相依，可以安全向量化
GCC system_header | 把這個檔案當系統標頭（抑制警告）
GCC dependency | 若指定檔案比目前檔案新就警告
GCC pch_preprocess | 預編譯標頭用內部指令
clang loop | 調整緊接迴圈的最佳化：vectorize(enable)、unroll_count(N)、interleave_count(N)
clang diagnostic | 控制 clang 警告（用法同 GCC diagnostic）
unroll | 要求展開緊接的迴圈（clang／nvcc）{v}
nounroll | 禁止展開緊接的迴圈
ivdep | 迴圈迭代之間沒有相依（Intel／Cray／部分編譯器）
vector | 要求向量化（Intel）
simd | 要求向量化（OpenMP simd 的簡寫）
omp parallel | 建立一個平行區域：之後的區塊由多個執行緒同時執行同一段程式碼，區塊結束時隱含同步（barrier）
omp parallel for | 建立平行區域並把緊接的 for 迴圈的迭代分配給多個執行緒；迭代之間必須彼此獨立（或用 reduction／atomic 保護共享變數）
omp for | 在已存在的平行區域內，把緊接的 for 迴圈迭代分配給目前的執行緒群；結尾有隱含同步（可用 nowait 省略）
omp parallel sections | 建立平行區域並讓各個 section 由不同執行緒各自執行一次
omp sections | 在平行區域內分派各個 section 給不同執行緒
omp section | 標記 sections 中的一個獨立區塊
omp single | 只讓群組中的「一個」執行緒執行這個區塊（其他執行緒等待，除非 nowait）
omp master | 只讓主執行緒（編號 0）執行這個區塊，沒有隱含同步
omp masked | 只讓指定編號的執行緒執行（OpenMP 5.1 取代 master）
omp critical | 臨界區：同一時間只允許一個執行緒進入（可命名，同名共用同一把鎖）
omp atomic | 對單一記憶體位置做不可分割的更新（比 critical 輕量）
omp barrier | 所有執行緒在此等齊才能繼續
omp taskwait | 等待目前任務產生的子任務全部完成
omp taskgroup | 等待區塊內產生的所有任務（含後代任務）完成
omp task | 產生一個可由任何執行緒稍後執行的任務（遞迴、不規則平行常用）
omp taskloop | 把迴圈迭代切成任務
omp taskyield | 允許目前任務讓出給別的任務
omp flush | 讓執行緒對共享記憶體的視圖與記憶體一致（記憶體屏障）
omp ordered | 區塊內依迭代的原始順序執行
omp threadprivate | 讓全域或靜態變數在每個執行緒各有一份私有副本，且跨平行區域保留
omp simd | 要求把迴圈向量化（單一執行緒內的 SIMD 平行）
omp parallel for simd | 平行並向量化迴圈
omp declare simd | 宣告函式有向量版本，可在向量化迴圈中被呼叫
omp declare reduction | 自訂 reduction 運算
omp declare target | 把函式或變數也編譯成可在裝置（GPU）上使用的版本
omp end declare target | 結束 declare target 區段
omp target | 把緊接的區塊卸載到裝置（GPU 或加速器）執行
omp target data | 在裝置上建立資料環境，區塊內多次 target 之間資料保留在裝置
omp target enter data | 進入點：把資料映射到裝置
omp target exit data | 離開點：把資料從裝置取回或釋放
omp target update | 在主機與裝置之間同步資料
omp teams | 建立一組 team（GPU 的執行區塊），每個 team 有自己的執行緒
omp distribute | 把迴圈迭代分配給各個 team
omp target teams distribute parallel for | GPU 卸載常用的組合：卸載、建立 teams、把迭代分到 teams 再分給執行緒
omp target parallel for | 卸載並平行化迴圈
omp teams distribute parallel for | 在 teams 間分配並平行化迴圈
omp loop | 通用迴圈構造，由編譯器決定如何平行（OpenMP 5.0）
omp cancel | 請求取消目前的平行構造
omp cancellation point | 檢查是否有取消請求
omp requires | 要求實作提供某些功能（例如 unified_shared_memory）
omp depobj | 管理任務相依物件
omp scan | 掃描（前綴和）運算
omp unroll | 展開緊接的迴圈（OpenMP 5.1）
omp tile | 把迴圈分塊（OpenMP 5.1）
omp assume | 提供編譯器假設
omp allocate | 指定變數的配置器
acc parallel | OpenACC：在加速器上建立平行區域，由程式設計師明確指定平行方式
acc kernels | OpenACC：把區塊交給編譯器分析，自動切成多個加速器核心函式
acc parallel loop | OpenACC：平行區域加迴圈平行化
acc kernels loop | OpenACC：kernels 區域加迴圈
acc loop | OpenACC：把迴圈映射到加速器的 gang／worker／vector 階層
acc data | OpenACC：定義資料區域，控制資料何時搬到加速器
acc enter data | OpenACC：把資料搬進加速器
acc exit data | OpenACC：把資料搬出加速器
acc update | OpenACC：同步主機與加速器的資料
acc wait | OpenACC：等待非同步操作完成
acc routine | OpenACC：宣告函式可在加速器上被呼叫
acc declare | OpenACC：宣告資料的裝置生命週期
acc atomic | OpenACC：原子更新
acc host_data | OpenACC：在主機程式碼中使用裝置位址
@clause
parallel | OpenMP：用於 parallel for 等組合構造中，表示同時建立平行區域
num_threads | 指定平行區域使用 {v} 個執行緒
if | 條件為真才平行（{v}）；為假時序列執行
private | 變數 {v} 在每個執行緒各有一份未初始化的私有副本
firstprivate | 變數 {v} 每個執行緒各有一份私有副本，初值取自進入前的值
lastprivate | 變數 {v} 私有副本，離開時把「邏輯上最後一次迭代」的值複製回原變數
shared | 變數 {v} 由所有執行緒共用同一份（要自己避免資料競爭）
default | 沒有明確指定的變數的預設共享屬性：{v}（none 要求全部明確列出，建議用）
reduction | 對變數 {v} 做歸約：每個執行緒各算一份部分結果，最後依運算子合併（例如 +:sum 代表加總，max:m 取最大）
schedule | 迴圈迭代的分配方式 {v}：static 事先平均切塊、dynamic 做完一塊再領下一塊（負載不均時用）、guided 塊逐漸變小、auto 由執行期決定、runtime 由環境變數 OMP_SCHEDULE 決定
collapse | 把 {v} 層巢狀迴圈合併成一個迭代空間再分配，增加可平行的迭代數
nowait | 取消區塊結尾的隱含同步，執行緒做完就繼續往下
ordered | 迴圈內有 ordered 區塊，需要保留順序
copyin | 把主執行緒的 threadprivate 變數 {v} 的值複製給其他執行緒
copyprivate | single 區塊結束後把私有變數 {v} 的值廣播給其他執行緒
proc_bind | 執行緒與處理器綁定策略 {v}（master、close 靠近、spread 分散）
safelen | simd：向量化時迭代之間可安全同時處理的最大距離 {v}
simdlen | simd：偏好的向量長度 {v}
aligned | simd：變數 {v} 的位址已對齊，可用對齊的向量載入
linear | simd：變數 {v} 隨迭代以固定步長線性變化
map | target：資料映射到裝置 {v}（to 只送上去、from 只取回來、tofrom 雙向、alloc 只配置）
device | target：指定使用第 {v} 號裝置
is_device_ptr | target：{v} 已經是裝置位址，不用映射
num_teams | teams：建立 {v} 個 team
thread_limit | teams：每個 team 的執行緒上限 {v}
dist_schedule | distribute：迭代分配給 teams 的方式 {v}
depend | task：任務之間的資料相依 {v}（in 讀、out 寫、inout 讀寫）
priority | task：任務優先權 {v}
untied | task：任務可在不同執行緒間遷移
final | task：條件為真時，之後產生的任務都立即執行
mergeable | task：允許把任務合併
grainsize | taskloop：每個任務的迭代數 {v}
num_tasks | taskloop：總任務數 {v}
in_reduction | task 參與外層的歸約 {v}
hint | critical／atomic：給實作的同步提示 {v}
seq_cst | atomic：循序一致的記憶體順序
acq_rel | atomic：取得釋放順序
relaxed | atomic：鬆散順序（只保證原子性）
read | atomic：原子讀取
write | atomic：原子寫入
update | atomic：原子更新（預設）
capture | atomic：原子更新並取得舊值或新值
gang | OpenACC：把迴圈映射到 gang（粗粒度，對應 CUDA 的 block）
worker | OpenACC：映射到 worker（中粒度，對應 warp）
vector | OpenACC：映射到 vector（細粒度，對應 thread／SIMD）
num_gangs | OpenACC：gang 數量 {v}
num_workers | OpenACC：每個 gang 的 worker 數 {v}
vector_length | OpenACC：向量長度 {v}
async | OpenACC：非同步執行（佇列 {v}）
wait | OpenACC：等待佇列 {v} 完成
copy | OpenACC：資料進入區域時複製到裝置、離開時複製回主機 {v}
copyin | OpenACC：進入時複製到裝置 {v}（OpenMP 為 threadprivate 複製）
copyout | OpenACC：離開時複製回主機 {v}
create | OpenACC：在裝置配置但不複製 {v}
present | OpenACC：資料已經在裝置上 {v}
deviceptr | OpenACC：{v} 已經是裝置指標
independent | OpenACC：迴圈迭代彼此獨立
seq | OpenACC：迴圈循序執行
tile | OpenACC：把迴圈分塊 {v}
