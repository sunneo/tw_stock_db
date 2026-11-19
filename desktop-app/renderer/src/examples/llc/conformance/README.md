# OpenCL 一致性套件

同一組標準 OpenCL C 核心，在框架的每個後端上跑，與 double 精度的參考解（及有解析解的案例的解析解）比對。**誤差超標就修框架，不放寬容差**。
這裡的東西是給你「照標準寫、拿來驗證」用的：`kernels.cl` 是全部核心的原始碼，沒有任何框架專屬寫法，可以直接抄進你的 OpenCL 程式。

## 比哪些後端

| 後端 | 說明 |
|---|---|
| `js` | KIR 的 JS 參考後端（每個 f32 運算都包 `Math.fround`），當對照基準 |
| `webgpu-t` | WebGPU，workgroup 共享記憶體分塊（tile）開啟 |
| `webgpu-u` | WebGPU，未分塊 |
| `webgl2` | WebGL2（RGBA32F 紋理＋全螢幕三角形） |

共 47 個案例、137 個（案例×規模）組合；邊界規模 N＝1、63、64、65、255、256、257、1000。

## 怎麼跑

**node（不需要 GPU，一秒內；只驗 JS 參考後端與案例本身的自洽）**

    node renderer/src/gpu/kir_conformance_test.js

**真 Electron（一個頁面，約 2 到 3 秒，四個後端全跑）**

    node scripts/eval/kir_conformance.build.js /tmp/kc.eval.js
    FA_EVAL_GL=gpu FA_EVAL_TIMEOUT_MS=600000 node scripts/eval/run_eval.js /tmp/kc.eval.js 17994

沒有真 GPU 的機器：`FA_EVAL_GL=swiftshader` 只有 WebGL2（沒有 WebGPU）；要連 WebGPU 一起測，用軟體 Vulkan（`--enable-unsafe-webgpu --enable-features=Vulkan --use-angle=swiftshader --enable-unsafe-swiftshader`）。
結果印在 `KCONF {…}`：`backends.<後端>.pass／total／fails`、`perCase`（每個案例每個後端的最大誤差）、`allPass`。

## 判定規則

每個輸出元素的「誤差 ÷ 該元素的量級」要 ≤ 容差；容差與 `gpu_core.tolerance` 同形式：8·√k·2⁻²³（k 是該案例累加的項數，見下表）。
標「逐位元相同」的案例（單一 IEEE 加、乘、比較、min、max）要求誤差恰為 0。簡諧振子另外對解析解（cos 與 sin 的閉式解）比。

## 案例

| 案例 | 群組 | 規模（N 或步數 S） | 判定 | 說明 |
|---|---|---|---|---|
| `vecadd` | elem | 1、63、64、65、255、256、257、1000 | 逐位元相同 | o = a + b（單一加法，應逐位元相同） |
| `saxpy` | elem | 1、63、64、65、255、256、257、1000 | 逐位元相同 | o = s·x + y（s 為純量；應逐位元相同：WGSL 不做 FMA 融合） |
| `sqrt` | elem | 1、63、64、65、255、256、257、1000 | 誤差／量級 ≤ 8·√1·2⁻²³ | o = √x（x ∈ [0, 100]） |
| `rsqrt` | elem | 1、63、64、65、255、256、257、1000 | 誤差／量級 ≤ 8·√1·2⁻²³ | o = 1/√x（x ∈ [0.01, 100]） |
| `sin` | elem | 1、63、64、65、255、256、257、1000 | 誤差／量級 ≤ 8·√1·2⁻²³ | o = sin x（x ∈ [-10, 10]） |
| `cos` | elem | 1、63、64、65、255、256、257、1000 | 誤差／量級 ≤ 8·√1·2⁻²³ | o = cos x（x ∈ [-10, 10]） |
| `exp` | elem | 1、63、64、65、255、256、257、1000 | 誤差／量級 ≤ 8·√1·2⁻²³ | o = eˣ（x ∈ [-5, 5]） |
| `floor` | elem | 1、63、64、65、255、256、257、1000 | 逐位元相同 | o = ⌊x⌋（x ∈ [-50, 50]，應逐位元相同） |
| `select` | elem | 1、63、64、65、255、256、257、1000 | 逐位元相同 | o = x > 0.5 ? x : −x（三元運算子，應逐位元相同） |
| `pow` | elem | 1、63、64、65、255、256、257、1000 | 誤差／量級 ≤ 8·√1·2⁻²³ | o = pow(x, y)（x ∈ [0.1, 10]，y ∈ [-2, 3]） |
| `min` | elem | 1、63、64、65、255、256、257、1000 | 逐位元相同 | o = min(a, b) |
| `max` | elem | 1、63、64、65、255、256、257、1000 | 逐位元相同 | o = max(a, b) |
| `bound_vecadd_N1` | bound | 1 | 逐位元相同 | vecadd，N＝1（應逐位元相同） |
| `bound_vecadd_N63` | bound | 63 | 逐位元相同 | vecadd，N＝63（應逐位元相同） |
| `bound_vecadd_N64` | bound | 64 | 逐位元相同 | vecadd，N＝64（應逐位元相同） |
| `bound_vecadd_N65` | bound | 65 | 逐位元相同 | vecadd，N＝65（應逐位元相同） |
| `bound_vecadd_N255` | bound | 255 | 逐位元相同 | vecadd，N＝255（應逐位元相同） |
| `bound_vecadd_N256` | bound | 256 | 逐位元相同 | vecadd，N＝256（應逐位元相同） |
| `bound_vecadd_N257` | bound | 257 | 逐位元相同 | vecadd，N＝257（應逐位元相同） |
| `bound_vecadd_N1000` | bound | 1000 | 逐位元相同 | vecadd，N＝1000（應逐位元相同） |
| `bound_empty` | bound | 0 | 逐位元相同 | N＝0（空輸入）：不派送、不報錯，輸出長度 0 |
| `loop_rowsum_n1` | loop | 1 | 誤差／量級 ≤ 8·√16·2⁻²³ | for 迴圈求和：每列 16 個元素，n＝1 |
| `loop_rowsum_n64` | loop | 64 | 誤差／量級 ≤ 8·√16·2⁻²³ | for 迴圈求和：每列 16 個元素，n＝64 |
| `loop_rowsum_n1000` | loop | 1000 | 誤差／量級 ≤ 8·√16·2⁻²³ | for 迴圈求和：每列 16 個元素，n＝1000 |
| `reduce2_N1` | loop | 1 | 誤差／量級 ≤ 8·√1·2⁻²³ | 兩階段歸約（部分和 ch＝32，再加總），N＝1 |
| `reduce2_N100` | loop | 100 | 誤差／量級 ≤ 8·√100·2⁻²³ | 兩階段歸約（部分和 ch＝32，再加總），N＝100 |
| `reduce2_N1000` | loop | 1000 | 誤差／量級 ≤ 8·√1000·2⁻²³ | 兩階段歸約（部分和 ch＝32，再加總），N＝1000 |
| `allpairs_N1` | tile | 1 | 誤差／量級 ≤ 8·√1·2⁻²³ | 全對全引力核心，N＝1（分塊版與未分塊版都要對） |
| `allpairs_N31` | tile | 31 | 誤差／量級 ≤ 8·√31·2⁻²³ | 全對全引力核心，N＝31（分塊版與未分塊版都要對） |
| `allpairs_N32` | tile | 32 | 誤差／量級 ≤ 8·√32·2⁻²³ | 全對全引力核心，N＝32（分塊版與未分塊版都要對） |
| `allpairs_N33` | tile | 33 | 誤差／量級 ≤ 8·√33·2⁻²³ | 全對全引力核心，N＝33（分塊版與未分塊版都要對） |
| `allpairs_N64` | tile | 64 | 誤差／量級 ≤ 8·√64·2⁻²³ | 全對全引力核心，N＝64（分塊版與未分塊版都要對） |
| `allpairs_N65` | tile | 65 | 誤差／量級 ≤ 8·√65·2⁻²³ | 全對全引力核心，N＝65（分塊版與未分塊版都要對） |
| `allpairs_N1000` | tile | 1000 | 誤差／量級 ≤ 8·√1000·2⁻²³ | 全對全引力核心，N＝1000（分塊版與未分塊版都要對） |
| `ho_leapfrog_S1` | integrator | 1 | 誤差／量級 ≤ 8·√1·2⁻²³ | 簡諧振子 leapfrog，步數 1（dt＝0.01；對照 double 同公式） |
| `ho_leapfrog_S2` | integrator | 2 | 誤差／量級 ≤ 8·√2·2⁻²³ | 簡諧振子 leapfrog，步數 2（dt＝0.01；對照 double 同公式） |
| `ho_leapfrog_S5` | integrator | 5 | 誤差／量級 ≤ 8·√5·2⁻²³ | 簡諧振子 leapfrog，步數 5（dt＝0.01；對照 double 同公式） |
| `ho_leapfrog_S10` | integrator | 10 | 誤差／量級 ≤ 8·√10·2⁻²³ | 簡諧振子 leapfrog，步數 10（dt＝0.01；對照 double 同公式） |
| `ho_leapfrog_S100` | integrator | 100 | 誤差／量級 ≤ 8·√100·2⁻²³ | 簡諧振子 leapfrog，步數 100（dt＝0.01；對照 double 同公式） |
| `ho_leapfrog_S1000` | integrator | 1000 | 誤差／量級 ≤ 8·√1000·2⁻²³ | 簡諧振子 leapfrog，步數 1000（dt＝0.01；對照 double 同公式） |
| `nbody16_S1` | integrator | 1 | 誤差／量級 ≤ 8·√4·2⁻²³ | 16 體引力（f32x4）leapfrog，步數 1（逐步對照 double） |
| `nbody16_S2` | integrator | 2 | 誤差／量級 ≤ 8·√8·2⁻²³ | 16 體引力（f32x4）leapfrog，步數 2（逐步對照 double） |
| `nbody16_S5` | integrator | 5 | 誤差／量級 ≤ 8·√20·2⁻²³ | 16 體引力（f32x4）leapfrog，步數 5（逐步對照 double） |
| `nbody16_S10` | integrator | 10 | 誤差／量級 ≤ 8·√40·2⁻²³ | 16 體引力（f32x4）leapfrog，步數 10（逐步對照 double） |
| `nbody16_S100` | integrator | 100 | 誤差／量級 ≤ 8·√400·2⁻²³ | 16 體引力（f32x4）leapfrog，步數 100（逐步對照 double） |
| `f32x4_vec4` | vec | 1、64、1000 | 逐位元相同 | f32x4：out.x＝in.x＋in.w，out.y＝in.y·2，out.z＝in.z−1，out.w＝in.w（應逐位元相同） |
| `multi_out` | vec | 1、63、64、65、1000 | 逐位元相同 | 多輸出核心：s＝a＋b、d＝a−b（兩個輸出都要對） |

## 目前結果（誠實的範圍）

- node：JS 參考後端 137／137 通過。
- 真 Electron（軟體 GL／軟體 Vulkan，**這台機器沒有真 GPU**）：`js`、`webgpu-t`、`webgpu-u`、`webgl2` 四個後端都 137／137 通過，頁面總計約 2 到 3 秒。
- **沒在真 GPU 上跑過這一版**（上一版在 NVIDIA 實跑過 nbody／fluid 的整合，不是這個套件）。有真 GPU 的人請跑上面的指令，結果貼回來。

## 這個套件抓到並修掉的框架問題

1. WebGL2 路徑：輸入紋理的寬度 uniform（`u_W_<名字>`）沒有設定（預設 0，取模為 0），N＞1 的核心全部算錯（137 項只過 16 項）。已在 `kir_webgl2.js`（`runGl` 與 `dispatchOne`）設定；同時放寬「輸入可以比輸出長」（例如 `a[i*k+j]`），與 WebGPU 一致。
2. `sin`／`cos`：GLSL 與 WGSL 內建函式的精度依驅動而不同（軟體實作的誤差約 2×10⁻⁴，超過容差約 200 倍）。`kir_gen.js` 改成自己做範圍縮減（Cody-Waite 三段 π/4）加 cephes 的 sinf／cosf 多項式，只用加減乘，各後端結果一致（|x|＞8192 才退回內建函式）。
