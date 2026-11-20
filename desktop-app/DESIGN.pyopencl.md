# Python＋OpenCL＋OpenGL：標準 pyopencl＋ICD 後端與執行期優化（2026-11-20）

使用者原話：「opencl輸出器要做，這是目前我們最貼近原生效率的平行運算，就是如果我們要加速運算，就是這條。或者也要補python+opencl+opengl」「a, opencl本來就是interface主導，但是實做可以用driver/icd達成，執行端要達到runtime optimization」。

## 1. 決定與理由

- **決定（使用者）**：Python 端用的就是**標準的 pyopencl**（公開名稱、簽名、行為都以真 pyopencl 為準），我們只在底下提供後端——OpenCL 本來就是介面主導、實作由驅動（ICD）提供，所以這跟 pygame-ce／PyOpenGL 完全同一條規則（`DESIGN.pygame-opengl-standard.md`），**不是例外**。
- **更正（2026-11-20，使用者糾正）**：本文件與記憶最初把它寫成「pip 規則的例外、出貨相容層」是錯的。不出貨名為 `pyopencl` 的自寫 API，不出貨墊片。
- **後端接在哪裡**：真 pyopencl 的結構是「一批純 Python 模組（`__init__`、`array`、`tools`、`elementwise` 等）＋ 一個 C 擴充 `pyopencl._cl`」。C 擴充就是它對 OpenCL ICD 的繫結；Pyodide 沒有它的 wheel，所以我們要提供的是 **`pyopencl._cl` 這一層的後端**（Platform、Device、Context、CommandQueue、Buffer、Program、Kernel、Event、`enqueue_*` 等原生型別與函式），由它呼叫 §2 的載入器。純 Python 的部分用真的（`array`、`elementwise` 等就自然能用）。

### 1.1 真 pyopencl 的實測檢視（2026-11-20，使用者同意下載到獨立資料夾檢視）

只取 wheel（`pip download --only-binary :all: --no-deps`），解開用 `unzip` 檢視，**沒有 import、沒有安裝、沒有執行包內任何程式碼**。檔案在 scratchpad 的 `dl-pyopencl/`（會被清掉，結論都記在這裡）。

- 版本 **pyopencl 2026.1.5**，授權 **MIT**，Python ≥ 3.10。wheel 是平台 wheel（`cp310-…-manylinux_x86_64`），所以 **Pyodide 的 micropip 不能直接裝它**（平台標籤不符）。
- 內容：純 Python 約 9000 行（`__init__` 1997、`array` 3569、`elementwise` 1286、`tools` 1670、`invoker` 412 行、`reduction`、`scan`、`clmath`、`clrandom`…）＋ **一個 C 擴充 `_cl.cpython-310-….so`**（859 KB）＋ 隨附的 `.libs/libOpenCL-*.so`（Khronos ICD 載入器）＋ `cl/*.cl` 資源。
- **`_cl.pyi`（58 KB 型別存根）就是 `_cl` 的精確介面**：97 個類別、40 個模組函式。其中約 55 個是列舉／常數類別（`status_code`、`mem_flags`、`device_type`、`device_info`…，共約 507 個成員）；約 40 個是真物件（`Platform／Device／Context／CommandQueue／Event／MemoryObject／Buffer／_Program／Kernel`、例外 `Error／MemoryError／LogicError／RuntimeError`，以及圖像、SVM、Pipe、PooledBuffer、GLBuffer 等）。
- **存根裡的列舉成員只寫 `auto()`，沒有數值**，所以常數表不能從存根機械產生；數值要從 OpenCL 標頭（`CL/cl.h`）取。
- 純 Python 層對 `_cl` 的呼叫很窄：`invoker.py` 只用 `_cl.enqueue_nd_range_kernel` 與 `_cl._sizeof_size_t`；`Program` 是 Python 類別（`__init__` 第 393 行），包著 `_cl._Program`；`enqueue_copy` 是 Python 函式，分派到 `_cl._enqueue_read_buffer／_write_buffer／_copy_buffer…`。圖像、SVM、GL 在 `__init__` 裡都有條件保護。
- 純 Python 層的第三方相依：`numpy`、`pytools`（`memoize_method`、`persistent_dict`、`py_codegen`）、`platformdirs`、`typing_extensions`，以及 **`mako`**（`_mymako.py` 硬 import；`elementwise`／`array` 用它產生核心）。**除 numpy 外，這些在 Pyodide 的取得方式都還沒驗證**（PyOpenGL 的先例是用 micropip 從 PyPI 裝，要有網路）。
- 取得與安裝方式（待驗證）：把真 pyopencl 的 `.py` 檔（不含 `.so`、`.libs`）放進 Pyodide 的 `/fa_pybridge/pyopencl/`，再加上我們的 `pyopencl/_cl.py`；不修改任何一個真檔案。需要使用者決定下載來源與是否隨產品出貨（MIT 要附授權文字）。

## 2. 分層

```
介面層     pyopencl 相容模組（Python，pybridge/pyopencl/）      llvm_host 的 cl* C API（wasm 指標；之後遷移）
              │ 橋接：JSON 指令＋二進位資料（Pyodide run_sync）        │ 指標編碼／解碼
              ▼                                                      ▼
載入器     renderer/src/gpu/cl_icd.js（FaClIcd.createLoader）：ICD 登記表＋物件模型＋執行期優化器（與驅動無關）
              │ 派送到物件所屬的驅動（= ICD dispatch table）
              ▼
驅動       makeKirDriver：OpenCL C 子集 →（cl_front）KIR → 裝置：WebGPU／WebGL2／JS（由 kir_host_hooks 選，已有）
           之後可加：cpu-shim 驅動（llvm_host 的 clCompile，支援 KIR 不收的型別）、cudaweb 驅動（PTX，預留）
```

- 載入器的物件 API 沒有指標：平台、裝置、內容、佇列、記憶體、程式、核心、事件都是 JS 物件。兩個介面層各自把自己的編碼（Python 物件、wasm 指標）對映到這組物件。
- 驅動介面（`cl_icd.js` 檔頭）很小：`compile／alloc／upload／download／free／launch` 加裝置資訊與 `probe`。這跟 `kir_host_hooks.js` 現有的裝置介面（`alloc／upload／download／dispatch／free`）一致，所以 WebGPU／WebGL2 裝置不用改就能當驅動的裝置。
- 探測失敗的驅動不列入 `platforms()`（相當於 ICD 檔存在但驅動載入失敗），原因在 `probeReport()`，不靜默降級。

## 3. `pyopencl._cl` 後端（第一批已實作並在一般 Python 對真載入器測過；Pyodide 路徑與真 pyopencl 純 Python 層尚未測）

### 3.1 範圍
- 以真 pyopencl 的 `_cl` 為尺，實作它暴露的原生型別與函式：`get_platforms`、`Platform`、`Device`、`Context`、`CommandQueue`、`Buffer`、`Program`、`Kernel`、`Event`、`enqueue_copy`、`enqueue_nd_range_kernel`、`mem_flags`／`device_type`／`status_code` 等常數、例外（`Error`／`MemoryError`／`LogicError`／`RuntimeError`）。每一個都對映到載入器（`cl_icd.js`）的物件 API。
- 驗收：真 pyopencl 的公開名稱與簽名逐一比對；標準範例（vector add、`pyopencl.array` 逐元素運算）**原封不動**跑得起來。
- 超出 KIR 範圍的（double、整數緩衝區、多維 NDRange、`__local`、barrier、原子）：`Program.build` 丟標準的 `pyopencl.RuntimeError`（BUILD_PROGRAM_FAILURE），build log 寫明原因，不默默降級。

### 3.2 橋接
- 沿用 `cudaweb.py` 的形狀：`_fa_opencl.call(op, json, bytes) → (json, bytes)`，Python 端用 `pyodide.ffi.run_sync` 等結果（資料走二進位）。
- 一般的 Python（沒有橋接）：`_cl` 載入時明確報錯並說明；若系統有真的 OpenCL，使用者直接用系統的 pyopencl，我們的後端不介入。

## 4. OpenGL
- Python 端 OpenGL 已是真 PyOpenGL＋WebGL2 後端（`DESIGN.pygame-opengl-standard.md`）。
- OpenCL↔OpenGL 互通宿主端已有（`cl_khr_gl_sharing`、標準 GL VBO，`HANDOFF.interop-standard.md`）。pyopencl 的互通 API（`pyopencl.GLBuffer`、`pyopencl.tools.get_gl_sharing_context_properties`）要在載入器加 GL 共享物件後才能接；**第一版不做**，列入 §7。

## 5. 執行期優化（執行端）

已做（`cl_icd.js`，有計數器 `stats()`，`cl_icd_test.js` 用裝置層真實呼叫次數證明）：

| # | 優化 | 作法 | 測試怎麼證明 |
|---|---|---|---|
| 1 | 建置快取 | （驅動＋原始碼＋選項）雜湊；跨 Program 物件共用，失敗結果也快取 | 三個相同 Program 只編譯一次；壞原始碼只編譯一次 |
| 2 | 主機／裝置副本延遲同步 | 寫入只動主機副本；核心要用才上傳；讀回只在主機副本過期時下載；核心鏈中間結果留在裝置 | 兩個核心串接：上傳 1 次、中途下載 0 次；重複讀取只下載 1 次 |
| 3 | 相同內容不重傳 | 寫入後上傳前比對內容雜湊（≤ 4 MB） | 相同內容再寫一次不增加上傳；內容變了才增加 |
| 4 | 純輸出不上傳 | 核心只寫、且主機端從沒寫過內容 → 只配置 | 純輸出不上傳。**主機端寫過的輸出緩衝區仍上傳**（核心可能只寫一部分，其餘要保留）——這點是自查時發現原本太激進，已改並有專門的正確性測試 |

破壞對照：關掉優化 1、3、4 的判斷或部分寫入前的主機同步，對應測試各自失敗（還原後 10/10）。

**還沒做**（照價值排序）：
1. 佇列層逐元素核心融合：連續兩個核心 B 只讀 A 的輸出、且 A 的輸出之後沒人讀 → 合成一個 KIR 核心，省一次派送與中間緩衝區。需要在佇列記錄命令（目前是立即派送），並做生命週期分析。
2. 依量測自動選驅動（異質）：`create_some_context` 先用探測排序（GPU 優先）；執行期依每個核心的實測毫秒／元素選驅動，需要跨驅動的副本搬移模型，現有的 `hetero_rates` 可借。
3. 工作群大小自適應（`kir_webgpu` 已有 workgroup 自適應，載入器還沒把 `local_size` 傳下去）。
4. 讀回合併：同一次 `finish` 前多個讀取合成一次打包下載（KIR 裝置層已有打包 view）。
5. 非阻塞傳輸與事件相依（`wait_for`）：目前所有操作循序完成。

## 6. 單一來源與遷移（尚未做，要做完才算符合「只留一份」）

目前 `uml/llvm_host.js` 的 `cl*`（約 120 行）有自己的一份物件模型與優化（`hostOk／devOk`、常駐裝置路徑、打包 view），跟 `cl_icd.js` 是**兩份重複的邏輯**——這是暫時的，不是設計。遷移步驟：
1. `cl_icd.js` 補齊 llvm_host 現有但載入器沒有的能力：打包 view、GL 共享物件（`clCreateFromGLBuffer`、acquire／release）、CPU 墊片驅動（`clCompile`，支援 int／uchar 等 KIR 不收的型別）、多個輸出的核心。
2. `llvm_host.js` 的 `cl*` 改成薄的指標編碼／解碼層，呼叫載入器。
3. 既有回歸全部要過：`nbody3d_cl.test.js`、`fluid3d_cl`、`opencl_vecadd`、`kir_*` 評測、`llc_host.eval.js`；真 Electron 的 nbody 三種後端數字不能退步（v490 的基準：GPU 0.063 s／step）。
4. 在第 3 步通過之前**不要動 llvm_host**（已發布 v484–v490）。

## 7. 現況與下一步

### 7.1 已完成（2026-11-20，Linux、node 20、python 3.10、numpy 1.26；都還沒提交）
| 檔案 | 內容 | 測試 |
|---|---|---|
| `renderer/src/gpu/cl_icd.js` | ICD 載入器＋KIR 驅動＋JS 裝置＋執行期優化 1–4（§5） | `cl_icd_test.js` 10 項 |
| `renderer/src/gpu/cl_host_ops.js` | JSON 指令＋二進位 → 載入器的派送層（回傳具名欄位，列舉數值留在 Python 端） | 透過下一列 |
| `renderer/src/gpu/cl_host_stdio.js` | 把派送層接到 stdin／stdout（框架：4 位元組 JSON 長度、4 位元組資料長度、JSON、資料），給一般 Python 測試用；不是產品路徑 | 同上 |
| `renderer/src/gpu/clc_js.js` | **OpenCL C 前端**（最小檔）→ JS，CPU 驅動用（§8）；`cl_icd.js` 的 `makeClcDriver` 把它接成驅動 | `clc_js_test.js` 36 項（含 17 項與 gcc 的差分）；`cl_icd_test.js` 12 項 |
| `renderer/src/pybridge/pyopencl_backend/_cl.py` | `pyopencl._cl` 後端：例外階層（`args[0]` 是 `_ErrorRecord`，與真 `_monkeypatch` 相容）、列舉（`gen_cl_enums.py` 從 `_cl.pyi`＋`cl.h` 產生，455／511 個成員有數值）、MemoryPool／配置器、「二進位」＝魔術標頭＋源碼（讓 pyopencl 的磁碟編譯快取運作）、Platform／Device／Context／CommandQueue／Event／Buffer／_Program／Kernel、`enqueue_nd_range_kernel`、`_enqueue_read／write／copy／fill_buffer`、傳輸（stdio；Pyodide 未測） | `_cl_test.py` 11 項，由 `cl_backend_py.test.js` 啟動；已登記進核心測試 |
| `pyopencl_backend/gen_cl_enums.py`、`verify_enums.py`、`test_support/siphash24.py`（純 Python 後備）、`_real_layer_test.py`、`fixtures/official_vecadd.py` | 產生與核對列舉、`siphash24` 後備（SipHash-2-4 官方向量驗證）、**真 pyopencl 純 Python 層＋`_cl` 的整合測試** | `siphash24_test.py` 6 項；`_real_layer_test.py` 2 項，由 `cl_real_layer.test.js` 啟動（沒下載相依就略過） |

驗證方式：一般 CPython → `_cl.py` → stdio → node → 載入器 → KIR JS 裝置；vector add 與 numpy 逐元素相同、build 失敗的錯誤類別與 log、參數型別／索引／工作群檢查、緩衝區讀寫複製填滿、事件計時、不支援功能的標準例外、優化經 `_cl` 生效（建置快取 1 次編譯 2 次命中；核心鏈只上傳 1 次、只下載 1 次；相同內容不重傳）。破壞對照：讀回不寫入 hostbuf、不檢查純量型別、例外一律 RuntimeError，各自讓對應測試失敗。

### 7.2 驗證結果與已知缺口（2026-11-20，使用者同意 MarkupSafe 下載、siphash24 走自寫純 Python 後備）

**已驗證（一般 CPython 3.10、numpy 1.26，真 pyopencl 2026.1.5 的 `.py` 檔未修改）：**
- `import pyopencl` 成功：真 layer 的 `_monkeypatch`（替列舉加 `to_string`、替各類別加 `get_info` 屬性）、`tools`、`array`、`cache` 等都載入。
- **官方「Getting started」vector add 範例原封不動跑通**（誤差範數 0.0），**連跑兩次**：第一次寫出 pyopencl 的編譯快取，第二次從快取（我們的「二進位」＝魔術標頭＋源碼）讀回。範例文字是憑對官方文件的記憶寫的，沒有對照原頁。
- 真 layer 的 `Program.build` 錯誤格式（`RuntimeError`、`Build on …`、log、`(options: …)`）、`status_code.to_string`、`mem_flags.to_string`、事件計時（`ev.profile`）、`pyopencl.tools.MemoryPool`（區塊還回後被重用）、`to_device`／`.get()`。
- **列舉已用 Khronos 的 `cl.h`、`cl_ext.h`、`cl_gl.h`（2026-11-20 下載，放在 scratchpad 的 `dl-clheaders/`、`dl-clheaders2/`）逐項核對**：`verify_enums.py` 一致 342、不符 0、找不到 0。`gen_cl_enums.py` 從 `_cl.pyi`（成員名單）與這三個標頭（數值）產生 55 個列舉類別，**511 個成員中 500 個有數值**；先前手補的 `PLATFORM_NOT_FOUND_KHR`（-1001）與 `gl_object_type` 四值（0x2000–0x2003）經標頭核對**都正確**，不再手補。剩下 **11 個沒有數值**（`device_info` 的 NV／EXT 私有成員、`device_topology_type_amd.PCIE`、`context_properties.OFFLINE_DEVICES_AMD`、`mem_flags.USE_PERSISTENT_MEM_AMD`、`channel_order` 的 `Rx／RGx／RGBx`），不在這三個標頭裡，列在 `_UNRESOLVED`、沒有編造。`program_kind` 是 pyopencl 內部列舉，數值是這個後端自己定的。**已知風險**：產生器對「最佳前綴只涵蓋不到一半成員」的類別不自動對應（曾因此抓到 `gl_object_type.BUFFER` 被誤對成無關巨集）。
- 為了讓真 layer 運作，修正了兩個我原本寫錯的地方：`Error` 的建構子只收 `_ErrorRecord`、`args[0]` 是紀錄（真 `_monkeypatch` 靠它）；`Kernel.get_work_group_info`。驅動端新增「刪除未被引用的全域常數宣告」（pyopencl 的編譯快取會在源碼尾端追加 `__constant int pyopencl_defeat_cache_… = 0;`）。

**沒做到／已知缺口：**
1. **`pyopencl.array` 已能跑（clc 驅動）**：逐元素運算、歸約（`sum`／`max`／`min`／`dot`／官方 `ReductionKernel`）、前綴和（`cumsum`）、`maximum`、`if_positive`、`arange`、切片視圖、轉置、`clmath.sin` 都與 numpy 一致，見 §8。複數與向量 dtype 也已能跑（§8）。**還不行的**：圖像、SVM、Pipe、子緩衝區、GLTexture，見 §11。
2. **Pyodide 路徑沒測**：`_PyodideTransport` 與 JS 端 `_fa_opencl.call` 的橋接都還沒寫／沒跑；真 pyopencl 純 Python 檔案與其相依（`pytools`、`platformdirs`、`mako`、`MarkupSafe`、`siphash24` 的後備）在 Pyodide 裡的取得與出貨方式還沒決定（`pytools`／`mako` 的 Pyodide 可用性沒查；`siphash24` 是 C 擴充，需要出貨自寫後備，MIT 授權文字也要附）。
3. 只用內建 JS 裝置；WebGPU／WebGL2 裝置、真 GPU、真 Electron 都沒驗證。
4. 範圍限制（會得到標準例外與說明）：KIR 的 float32／int32 純量與 float 緩衝區、一維 NDRange、循序佇列、無圖像／SVM／子緩衝區／`__local`／GL 互通；`USE_HOST_PTR` 不與主機記憶體別名。
5. 第三方檔案（pyopencl wheel、pytools、platformdirs、typing_extensions、mako、MarkupSafe、`cl.h`）都在 scratchpad（會被清掉），**不在儲存庫裡**；整合測試靠環境變數指到它們，沒設就略過。

### 7.3 下一步（依序）
1. ~~下載 `cl_ext.h` 與 `cl_gl.h` 核對列舉~~——已完成（見 §7.2 的列舉一點）。
2. ~~`get_gl_sharing_context_properties()`~~——已完成（使用者決定「web always 不會用真的 glx」，用我們的 GL 上下文回應屬性，見 §9.3）。
3. `_fa_opencl` 的 JS 橋接（Pyodide 的 `call`）與 `py_worker` 的登記，在真 Pyodide 驗證（也包含 `WebGL2Backend.read_buffer／write_buffer` 與 `getBufferSubData`——目前只在假後端測過）；決定真 pyopencl 純 Python 檔案與其相依（pytools、platformdirs、typing_extensions、mako、MarkupSafe、siphash24 的後備）在產品裡的取得與出貨方式。
4. 子緩衝區（`Buffer.get_sub_region`、`buf[a:b]`）；圖像／取樣器；SVM；Pipe；`#include` 之外的真實標頭。見 §11。
5. **接線**：把 `cl_host_page.js` 註冊成 Pyodide 的 `_fa_opencl`（`floating-assistant.js` 與 `_fa_cudaweb` 並列）、把新模組加進嵌入腳本、`fa_bridge.install_hooks` 已會呼叫 `fa_pyopencl.install()`（見 §10.3）；在真 Electron 驗證真 GPU（WebGPU／WebGL2）；GL 互通的零拷貝路徑（§9.4）。§6 的遷移（llvm_host 的 `cl*` 改走同一個載入器）與 §5 還沒做的優化。
6. `ir_out_opencl_core` 輸出的核心接進 `Program(ctx, src)`，做 Python 函式 → OpenCL C → 標準 pyopencl 的一條龍範例。

## 8. OpenCL C 前端（clc_js.js，2026-11-20）

使用者決定先做最小檔（「先做最小那檔，OpenCL C 前端，然後要跟 pyopengl 有 interop」）。

- **定位**：CPU 驅動（`makeClcDriver`）的編譯器：OpenCL C → JavaScript，執行時工作項循序跑。GPU 路徑（KIR）維持只收固定形狀的子集；兩者的選擇（KIR 先試、失敗退 clc）還沒做（§7.3 第 5 點）。
- **範圍**：前置處理（`#define` 含函式式（呼叫可跨行）與 `##`、`#if` 系列、`-D` 選項、預定義 `__OPENCL_C_VERSION__`／`CLK_*_MEM_FENCE`）、純量型別（`char…ulong`、`float`、`double`、`size_t`）、指標（含位元組偏移的指標轉型與運算）、區域陣列（含多維）、全域 `__constant` 純量與陣列、輔助函式（含遞迴）、**struct**（成員、巢狀、陣列成員、結構陣列、`.`／`->`、傳值複製、`&`、struct 指標當核心參數）、完整的 C 運算式與控制流（含 `switch`）、**`__local`（核心範圍的陣列與 `__local` 指標參數）＋`barrier`**、**原子操作**（`atomic_／atom_` 的 add sub inc dec xchg cmpxchg min max and or xor，含 64 位元）、`get_global_id` 等工作項函式（1–3 維、`global_work_offset`）、常用數學與整數內建函式。`long`／`ulong` 用 JS 數字（精確到 2^53）。
- **`barrier` 的做法**：程式用到 `barrier` 時，核心與所有函式編成產生器（`yield`＝barrier），執行器逐工作群、讓群內每個工作項跑到下一個 barrier 再一起繼續；群內有人結束、有人停在 barrier ＝發散，回報錯誤。沒有 barrier 的程式不付這個成本。`__local` 記憶體是每個工作群一份、群內共享。
- **寬容的頂層項目**：非核心的輔助函式／typedef／全域變數若含不支援的寫法（例如 `#include` 進來的 `pyopencl-complex.h` 整份用向量型別），只記原因、略過，**被用到時才報錯**；核心本身一律嚴格。
- **`#include`**：宿主沒有檔案系統，由 Python 端的 `_cl` 在 build 時依 `-I` 目錄展開（與真的 OpenCL 驅動在 build 時讀標頭同一個語意；`#pragma once` 只展開一次，找不到標頭回 BUILD_PROGRAM_FAILURE 並列出 `-I` 路徑）；`Program.compile(headers=…)`／`link` 也支援。
- **向量型別**：`float2/3/4/8/16` 等（`char…double`）：建構 `(float4)(…)`／`{…}`、廣播、分量與 swizzle（`.xy`／`.s01`／`.lo`／`.hi`／`.even`／`.odd`，可當左值）、逐分量運算與比較（結果 -1／0）、記憶體載入存儲（float3 佔 4 個元素）、`vloadN/vstoreN`、`convert_*`（含 `_sat` 與捨入）、`as_*`、`dot/length/distance/normalize/cross/any/all/select/shuffle`、數學內建函式逐分量套用；可當核心的緩衝區或純量參數、struct 的成員。另有 `union`（匿名成員、`aligned`）、`enum`、`&局部變數`（引用指標）、`sincos/modf/fract`、`native_divide/recip`。
- **不支援（明確報錯並帶行號）**：`half`、`goto`、`printf`、圖像、函式指標、指標的指標。
- **語意**：整數照 C（int 32 位元回繞、uint、除法向零取整、`%` 的正負號、移位）；float 每步 `fround`；一般算術轉換。**語意正確性用差分測試把關**：同一份「同時合法於 OpenCL C 與 C」的核心，一份交給 `clc_js`、一份加上前置宏後交給 gcc（`-fwrapv -O0 -ffp-contract=off`），逐元素比對（整數、float 位元精確；超越函式容差 2e-6）。5 種故意弄壞的實作各自被對應測試抓到。
- **記憶體模型**：指標是 `{v: 各型別視圖, o: 位元組偏移}`，緩衝區是 `ArrayBuffer`，所以任意整數型別、`double`、`(__global float *)((__global char *)base + offset)` 都能用——這正是 `pyopencl.array` 的逐元素核心需要的。寫入會在視圖上做標記，驅動據此只把**真的被寫過**的緩衝區標成已修改（核心參數常沒標 `const`，靠靜態標註會把輸入也當成被改過，造成多餘的讀回）。
- **接進真 pyopencl**：`pyopencl.array` 的 `+ - * /`、純量運算、取負、`abs`、比較（`char` 輸出）、`astype`、`float64`、`int64`、`zeros`／`fill`、官方文件的 `ElementwiseKernel`（`lin_comb`）、長度不是工作群大小倍數的大陣列，都在真 layer 上與 numpy 一致。為此 `_cl` 補了真 `_monkeypatch`／`invoker` 要的私有方法（`_set_enqueue_and_set_args`、`_set_arg_multi`／`_buf_multi`／`_buf_pack_multi`），`enqueue_nd_range_kernel` 的位置參數，以及 `_sizeof_size_t` 是函式。
- **沒做／限制**：`long` 超過 2^53；效能是直譯等級（`pyopencl.array` 對 10 萬元素沒問題，大量運算走 §10 的 GPU 驅動）。

## 9. PyOpenGL interop（2026-11-20）

- **API（標準的 pyopencl）**：`cl.GLBuffer(ctx, flags, vbo)`、`cl.enqueue_acquire_gl_objects(queue, [buf])`、`cl.enqueue_release_gl_objects(queue, [buf])`、`GLBuffer.get_gl_object_info()`、`cl.have_gl()`；GL 端是**真的 PyOpenGL**（`glGenBuffers`／`glBufferData`／`glBufferSubData`／`glGetBufferSubData`…）經 `fa_opengl_platform`。圖像與紋理（`GLTexture`、`GLRenderBuffer`）不支援（丟標準例外與說明）。
- **語意**：GL 緩衝區在 WebGL2（GPU），CL 緩衝區在載入器的驅動，是兩塊記憶體；acquire／release 是兩者的同步點，與標準相同（核心只能在 acquire 與 release 之間用）。
- **平台新增**（`fa_opengl_platform.py`）：每個緩衝區記大小與修訂號（`glBufferData`／`glBufferSubData`／`interop_write` 加一）；`glGetBufferSubData`、`glGetBufferParameteriv(GL_BUFFER_SIZE)`；鉤子 `interop_buffer_info／interop_read／interop_write`；`WebGL2Backend.read_buffer／write_buffer`（用 `COPY_READ_BUFFER`／`COPY_WRITE_BUFFER` 綁定點，不動使用者目前的 `ARRAY_BUFFER` 綁定）。這些在 `fa_opengl_test.py` 用記憶體假後端測過（不需要下載任何東西）。
- **執行期優化**：GL 端用修訂號、CL 端用內容版本號（`ver`，寫入／複製進來／核心寫過就加一），**沒變的方向不傳輸**。連續 5 幀「acquire、核心、release」：GL 只在第一次 acquire 時讀進 CL，之後只有 CL 真的寫過才寫回 GL；acquire 後什麼都沒做就 release 不寫回；使用者在 GL 端直接 `glBufferSubData` 之後，下一次 acquire 會讀進來、核心看得到。三種故意弄壞（一律讀、一律寫回、只讀一次）各自被測試抓到。
- **驗證**（`_real_layer_test.py`，真 PyOpenGL 3.1.5＋`fa_opengl_platform`＋真 pyopencl 層＋clc 驅動）：多幀結果與 numpy 一致、讀寫次數（用假後端計數）、GL 端改動被看到、錯誤碼（不存在或沒資料的 GL 緩衝區、重複 acquire、沒 acquire 就 release、GL 端重新指定大小、非 GLBuffer、緩衝區被刪）。
- **9.3 `get_gl_sharing_context_properties()`（已完成）**：真的函式在 `sys.platform == 'emscripten'` 會丟 `NotImplementedError`、Linux 要 GLX。使用者決定「web always 不會用真的 glx」，用我們的 GL 上下文回應屬性：`fa_pyopencl.install()`（由 `fa_bridge.install_hooks()` 呼叫，與 `fa_opengl_platform.register()`、`fa_pygame.install()` 同一類）裝一個 import 鉤子，在 `pyopencl.tools` **載入完成之後**替換這一個函式（不改任何檔案；不管誰先 import，`from pyopencl.tools import get_gl_sharing_context_properties` 都拿到替換後的版本）。回傳格式與真的一樣 `[(GL_CONTEXT_KHR, 目前 GL 上下文的代號), (EGL_DISPLAY_KHR, 1)]`；代號來自 `fa_opengl_platform.interop_context_handle()`，網頁上 GL 上下文就是那個 WebGL2 後端。`cl.Context(properties=…)` 會驗證：PLATFORM 要對、GL 屬性要與目前 GL 上下文相符，不符＝`INVALID_GL_SHAREGROUP_REFERENCE_KHR`（-1000），不認得的鍵＝`INVALID_PROPERTY`；`ctx.properties` 回傳 `[鍵, 值, …, 0]`。官方互通範例（`Context(properties=[(PLATFORM, platform)] + get_gl_sharing_context_properties(), devices=[dev])`）原封不動可用，已在整合測試驗證。
- **9.4 沒做／限制**：(1) **不是零拷貝**——每次傳輸都經過 CPU（WebGL2 `getBufferSubData`／`bufferSubData`），所以是「正確、有優化的同步」而不是 GPU 直接共享；真正的零拷貝要 KIR 與畫布共用 WebGL2 上下文（`HANDOFF.interop-standard.md` 的 llvm_host 路徑已有一種做法，Python 路徑要等真 GPU 驅動接上，§7.3 第 5 點）。(2) `WebGL2Backend.read_buffer／write_buffer` 沒在真 WebGL2／Pyodide 跑過（只在假後端測過）。(3) 沒有強制「核心只能在 acquire 與 release 之間用 GL 緩衝區」（真 OpenCL 對違規是未定義行為，這裡不報錯）。(4) 多個 GL 緩衝區綁定點：`glBufferData` 對 `ARRAY_BUFFER`／`ELEMENT_ARRAY_BUFFER` 之外的目標只記最後一個綁定的「其他」緩衝區。

## 10. GPU 裝置：以 cudaweb／WebGPU 為後台（2026-11-20）

使用者決定：「gpu device 要用 cudaweb／webgpu 來作為後台，要充分獲得優化」。

### 10.1 架構
- **GPU 驅動 `makeGpuDriver`**（`cl_icd.js`）：裝置層就是 cudaweb 的 KIR 裝置（`kir_host_hooks.setup` 依序選 **WebGPU（WGSL）→ WebGL2（GLSL）**，每一步失敗都記原因、不靜默降級）。OpenCL C 核心編譯兩份：KIR（GPU 路線）與 clc（主機路線，也涵蓋 KIR 不收的核心），所以任何核心都能跑，不會因為 GPU 路線不收而失敗。
- **路由（異質）**：驅動的 `route(核心, {N, 維度, offset, devOnly})` 決定 `dev`（GPU，緩衝區常駐）或 `host`（直接在載入器的主機副本上跑，零傳輸）：KIR 不收的核心（int／double／struct 緩衝區、`%`、`barrier`…）、二維以上、有 offset → 主機；**很小的問題（N < smallN，預設 4096）且資料在主機 → 主機**（派送與傳輸的成本大於計算）；其餘 → GPU。資料只在 GPU 上時（`devOnly`）不為了「小」而把它讀回來。
- **CPU 驅動（clc）**走主機路線：核心直接在載入器的主機副本（`ArrayBuffer`）上跑，**零上傳、零下載、零裝置配置**。
- **頁面端主機 `cl_host_page.js`**（`FaClHostPage.create`）：建載入器、依環境註冊驅動（GPU 排第一，所以 `create_some_context()` 預設選到它；沒有 GPU 就只有 CPU）、回傳 `_fa_opencl.call(op, argsJson, bytes) → {json, data}`，正是 Python 端 `_PyodideTransport` 要的介面。

### 10.2 執行期優化（GPU 路徑；都有計數器，測試用「裝置層真實呼叫次數」證明）
| # | 優化 | 怎麼證明 |
|---|---|---|
| 1 | 緩衝區常駐 GPU：核心鏈的中間結果不下載再上傳 | 兩個核心串接：上傳 1 次、中途下載 0 次 |
| 2 | 小問題走主機、大問題走 GPU（異質路由） | 小問題 GPU 派送／上傳／下載全為 0 |
| 3 | 純輸出不上傳（輸入／輸出判定用 KIR 的；clc 只看得到 `const`） | 輸出緩衝區不上傳 |
| 4 | 主機路線零拷貝；只有「真的被寫過」的緩衝區才標成已修改（執行期寫入追蹤） | 只讀的輸入不被當成改過 |
| 5 | 主機核心改了已上傳到 GPU 的緩衝區 → 裝置副本標過期，之後 GPU 核心重新上傳看到新資料（**正確性**） | 專門的測試；破壞對照會被抓到 |
| 6 | 派送不等 GPU 完成：命令編碼器批次提交，讀回或 `finish`（刷新＋`sync`）才同步 | `finish` 呼叫 `flush`／`sync` |
| 7 | 工作群大小：`local_work_size` 傳給 `setWorkgroup`；大問題第一次呼叫自動調校（`ensureTuned`） | 假裝置上驗證會呼叫；**真 GPU 的效果沒量過** |
| 8 | 建置快取、相同內容不重傳、GL 修訂號（§5、§9） | 同前 |

`kir_host_hooks.js` 現在把 WebGPU 裝置的 `flush`／`sync`／`setWorkgroup`／`ensureTuned` 透傳出來（原本的包裝層藏起來了）。

### 10.3 還沒做（必須誠實列出）
1. **沒有在真 GPU 驗證**：本機是 node，沒有 WebGPU／WebGL2；GPU 驅動只用「帶計數器的假裝置」測過路由、傳輸次數、正確性；WGSL／GLSL 的產生與真 GPU 的效能是 cudaweb 既有的（`DESIGN.webgpu-cuda.md` §13），**這一輪沒有重測**。工作群調校的實際收益沒量過。
2. **接線（部分完成）**：
   - 已做：(a) 新增的四個模組（`cl_icd.js`、`clc_js.js`、`cl_host_ops.js`、`cl_host_page.js`）已加進 `scripts/embed-code-ui.js` 的 KIR 嵌入（`FA_KIR_SRC`，模擬頁面的 `new Function` 載入驗證過：掛出 `FaClIcd`、`FaClc`、`FaClHostOps`、`FaClHostPage`）；`pyopencl_backend` 的測試與產生器工具不嵌入；(b) `cl_host_page.js` 的 `FaClHostPage.prepare(py, 選項)`：程式 `import pyopencl` 時才做事——寫入 Python 檔、註冊 `_fa_opencl`、**從 PyPI 取得真的 pyopencl（純 Python 檔案，執行時由使用者的瀏覽器下載，不隨產品出貨，授權 MIT）**、micropip 裝 pytools／platformdirs／mako（`deps=False`；`siphash24` 由我們的純 Python 後備取代）、`fa_pyopencl.install()`；(c) `gui/py_worker.js`：Worker 收到 `clSrc` 就在 Worker 裡建立載入器（GPU 用 Worker 自己的 `navigator.gpu`／`OffscreenCanvas`，資料不跨執行緒）並 `prepare`。
   - **還沒做（需要有寫入權限的帳號）**：`renderer/src/floating-assistant.js` 的三處手寫位置（`_openclPrepareRun` 方法、`_runPyodideScriptAsync` 在 `runPythonAsync` 前呼叫它、`_terminalRunPythonWorker` 的 init 訊息帶 `clSrc`）。這個檔只有 `hungfu.lee` 帳號能寫，所以做成**幂等的套用腳本 `scripts/apply-pyopencl-wiring.js`**（已在檔案複本上驗證：三個錨點唯一、套用後 `node --check` 通過、重跑會略過）。之後照平常流程：`node scripts/apply-pyopencl-wiring.js` → `node scripts/embed-code-ui.js` → `node build-assistant.js` → 發布（`publish-live-update-patch`）。
   - **`prepare` 整段沒有在真 Pyodide 驗證**（本機沒有 Pyodide）：`unpackArchive`、`micropip.install(..., deps=False)`、`loadPackage` 的套件名、PyPI JSON 與 wheel 下載的 CORS、`run_sync` 在主執行緒是否可用（`_fa_cudaweb` 的先例是可用，但要 JSPI）都是推測。
3. **Worker／主執行緒**：Pyodide 的 Python 在 Worker，GPU 在頁面（`_fa_cudaweb` 的先例是由頁面代為呼叫）；`_fa_opencl` 要走同樣的傳輸，二進位資料（緩衝區內容）要用可轉移的 `Uint8Array`，延遲與 JSON 化的成本沒量過。
4. **KIR 的限制**：GPU 路線只收一維、float 緩衝區、剛好一個輸出的核心；多個輸出、int／double 緩衝區的核心目前走主機。要讓更多核心上 GPU，要擴充 KIR 與它的 WGSL／GLSL 產生器。

## 11. 目前還不支援的功能與原因（沒有 NotImplementedError；都是標準的 OpenCL 錯誤，並且裝置如實回報）

使用者要求「盡可能實現，不要出現 not implementation exception」。以下不是丟 Python 的 `NotImplementedError`，而是 pyopencl 的標準例外（`pyopencl.LogicError`／`RuntimeError`，附說明），而且對應的裝置能力如實回報（`IMAGE_SUPPORT`＝false、`SVM_CAPABILITIES`＝0、`MAX_PIPE_ARGS`＝0），這是真的 OpenCL 裝置缺能力時的標準行為；`get_supported_image_formats` 回空清單。**但它們仍然是缺的功能，要做的清單如下：**
1. ~~向量型別~~——**已完成**（見 §8）：`float2/3/4/8/16` 等、建構、廣播、分量與 swizzle（可當左值）、逐分量運算與比較、`vloadN/vstoreN`、`convert_*`、`as_*`、`dot/length/normalize/cross/shuffle/select/any/all`、數學函式逐分量、float3 步幅 4；為了複數還補了 `union`（匿名成員、`aligned`）、`enum`、`&局部變數`（引用指標，`sincos(x, &c)`）、核心的 struct 傳值參數。`pyopencl.array` 的複數（`complex64`／`complex128` 的加減乘除、共軛、實虛部、`abs`、`sum`、`clmath.exp`）與向量 dtype 陣列、`cltypes.float4` 純量參數都與 numpy 一致。
2. ~~子緩衝區~~——**已完成**：`Buffer.get_sub_region`、`buf[a:b]`；與父共用同一塊記憶體（狀態記在父緩衝區），讀寫複製轉成父＋偏移，核心參數一律走主機路線帶位元組偏移（GPU 路線沒有偏移；KIR 驅動補了 `launchHost`）。
3. ~~圖像與取樣器~~——**已完成（2026-11-20／21）**：clc 前端有 `image1d/2d/3d_t`、`image1d/2d_array_t`、`image1d_buffer_t`、`sampler_t`（uint 位元欄位：正規化座標｜定址 NONE／CLAMP_TO_EDGE／CLAMP／REPEAT／MIRRORED_REPEAT｜過濾 NEAREST／LINEAR，含 1D／2D／3D 線性內插）、`read_image{f,i,ui}`／`write_image{f,i,ui}`、`get_image_*`；通道順序 R A RG RA RGBA BGRA ARGB INTENSITY LUMINANCE Rx RGx RGB RGBx，通道型別 UNORM／SNORM 8／16、SIGNED／UNSIGNED 8／16／32、HALF_FLOAT、FLOAT、打包的 565／555／101010（RGB／RGBx 只配打包型別，與規格一致）。主機端：`Image`／`ImageDescriptor`／`ImageFormat`／`Sampler`、`_enqueue_{read,write,copy}_image`、`copy_image_to_buffer`／`buffer_to_image`、`enqueue_fill_image`、`enqueue_map_image`、`get_supported_image_formats`（含 row／slice pitch 的主機陣列）。圖像在載入器裡是「緊密排列的緩衝區＋格式描述」，核心一律走主機路線（clc）；**IMAGE1D_BUFFER** 與緩衝區共用同一塊記憶體（結構同子緩衝區）。不支援：mip 層級、多重取樣（如實回報 0）。裝置只有 clc／GPU 驅動回報 `image_support`；KIR 驅動沒有。
4. ~~SVM~~——**已完成（粗粒度）**：`SVMAllocation`（主機端是 ctypes 配置的真記憶體，`svm_ptr` 是它的位址，numpy 直接建在上面，`csvm_empty`／`svm_empty`／`SVM(...)`／`SVMPool`／`SVMAllocator` 都照標準運作）、`_enqueue_svm_{memcpy,memfill,map,unmap,migrate_mem}`。同步：帶 SVM 參數的核心啟動前，主機端內容變了（crc32）才推上裝置；啟動後裝置端版本變了才拉回——佇列循序且同步，所以主機端在每次啟動完成後都是最新的，滿足（且超過）粗粒度 SVM 契約。指標位移用子緩衝區。`get_cl_header_version()` 回報 (2, 0)（真 pyopencl 只拿它決定要不要啟用 SVM 程式碼）。能力只回報 `COARSE_GRAIN_BUFFER`；細粒度與 SVM 原子如實拒絕。
5. ~~Pipe~~——**已完成**：`cl.Pipe(ctx, flags, packet_size, max_packets)`、`get_pipe_info`；clc 有 `pipe T` 型別、`read_pipe`／`write_pipe`（回 0／-1）、帶 reserve 的四引數版本、`reserve_{read,write}_pipe`、`commit_*`、`is_valid_reserve_id`、`get_pipe_{num,max}_packets`，封包可以是純量、向量或 struct。pipe 在載入器裡是 `[讀計數][寫計數]＋環狀封包` 的緩衝區，內容跨核心啟動保留。不支援：`work_group_*`／`sub_group_*` 的 pipe 函式（明確報錯）。**GLTexture／GLRenderBuffer**——**已完成**：`cl.GLTexture(ctx, flags, GL_TEXTURE_2D, level, tex, 2)` 與 `cl.GLRenderBuffer`，`fa_opengl_platform` 新增紋理／renderbuffer／framebuffer 的追蹤（`glGen/Bind/Delete*`、`glRenderbufferStorage`、`glFramebufferTexture2D／Renderbuffer`、`glCheckFramebufferStatus`）與 `interop_texture_*`／`interop_renderbuffer_*`；畫到綁定的 framebuffer（`glDraw*`、`glClear`）會讓附著物件的修訂號加一，acquire／release 與 GLBuffer 一樣只在版本變了的方向傳輸。支援的 GL 內部格式：RGBA8／RGBA16F／RGBA32F／R8／R32F／RG8／RG32F；目標只有 GL_TEXTURE_2D（3D／陣列／立方體紋理平台層沒有追蹤）；`WebGL2Backend` 的 `read/write_texture`／`read/write_renderbuffer`（renderbuffer 寫入走暫時紋理＋`blitFramebuffer`）**沒有在真 WebGL2 驗證**（只用記憶體假後端測過邏輯）。
6. 其餘：`DevicePointerEXT`、AMD 的 `DeviceTopologyAmd`、`create_with_built_in_kernels`（沒有內建核心，標準行為就是 INVALID_VALUE）、IL／SPIR-V 程式（`_create_program_with_il`、`set_specialization_constant`）。
7. clc 的 `long` 精確到 2^53；`#include` 以外的真實標頭（`cl_khr_*` 擴充標頭）。

