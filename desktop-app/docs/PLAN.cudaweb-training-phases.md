# cudaweb 訓練後端：多階段計畫（單一事實來源）

建立：2026-11-28。更新規則：每完成一階段，更新本檔的「狀態」與「證據」，並提交本檔。
來源：使用者原話（2026-11-28，逐字）：「請做成多個phase的計畫，務必完成」；前面的要求：「請優先把cudaweb當訓練的資源準備好」「就算硬體是舊的，時間很長，也是要可以」「我說的不是lora，如果使用的gpu夠強，也要讓cudaweb達成才對」「我日後還要支援用很多台群組內的cpu, cudaweb一起訓練」「我不接受吃不下這種說明跟技術限制」。

## 共通規則（每一階段都適用）

- **真值是 PyTorch，不是自己的 JS 參考**（設計 §6-1）。JS／WGSL 結果只能與 PyTorch 比對。
- **先屋頂線，再長測試**（§6-2）。實測超過理論上限 → 先查計時方法。
- **耗時拆成核心、上傳、讀回、同步**（§6-3）。四段之和要等於整步耗時（誤差範圍內）。
- **保留字**（§6-4）：分片路徑、欄位名、參數名不得與 JS 或 Python 保留字衝突（如 `class`、`import`、`default`）。
- **工作群上限 65535**（§6-5）：大矩陣 dispatch 超過就切段（既有 `chunkedCode`）。
- **單次提交過久會被重置顯卡（約 2 秒）**（§6-6）：每段提交要有耗時上限，超過就切段。
- **全有或全無運算覆蓋**（§4f）：缺任何運算 → 明確回報「缺 X」，不悄悄退回 CPU。
- **做不到不是結論**：每個缺口要寫「缺什麼、工作量多少、怎麼補」，並補上。
- **go／no-go**：每階段的完成標準全部通過才進下一階段；未通過就修，不跳過。
- **不發布、不推送、不合併**。提交只用明確路徑。
- **本機執行規則**：一次只開一個 Electron；獨立 `--user-data-dir`；自選埠不可用 17923；結束後用 Win32_Process 確認無殘留；不做大範圍遞迴 grep；使用者語言為純繁體中文。

## 踩過的坑（本計畫，逐條有證據）

1. **RoPE 交錯成對是錯的（2026-11-28 發現）**：trainer 與 PyTorch 參考原本用交錯成對（第 2i、2i+1 維）的 RoPE，但 `llm_scratch.py` 用 rotate-half（第 i 與 i+hd/2 維）。結果：cpu-py 對拍損失差 0.032、梯度差 1.0。修正：兩邊都改 rotate-half，之後 JS 與 PyTorch 對拍 ≤2.3e-15，cpu-py 差降到 4.5e-9。**規則**：對拍前先逐式核對架構的每個細節（RoPE 的配對方式、qk-norm 的位置、GQA 的頭對應），不要只看名稱相同。
2. **llm_scratch 的 RoPE 表是 float32 建的（2026-11-28）**：`.double()` 不會還原精度。影響：cpu-py 對拍差 8.4e-8（f64 表時 6.7e-16）。仍在 f32 門檻 1e-5 內，故通過；記為 llm_scratch 既有的精度選擇，不在本計畫改它。
3. **`lora_ref_train.js`、`nn_ops.rope`、`trainStepDevice` 的 RoPE 都是交錯成對，與基礎模型（llm_scratch、Qwen、推論）的 rotate-half 不一致（2026-11-28 以 PyTorch 證實）**：GPU 核心對交錯的誤差約 1e-7，對 rotate-half 約 1–2（`REPORT.rope-convention.md`）。影響：cudaweb 的 LoRA 訓練（GPU 與 JS）訓出的 LoRA 位置編碼與推論基礎模型不同，會傷害品質而不會報錯。已存在的 cudaweb LoRA 檢查點應視為無效。全參數路徑（`full_param_step_device`）已用排列轉成 rotate-half，不受影響。修不修由領導與使用者決定（選項見報告）。
4. **cudaweb 的 probe 在 studio 裡永遠不可用（2026-11-28）**：原本 `studio_host.js` 註冊時 `createCudawebBackend({})` 沒有傳 `getRuntime`。已改為傳入 `cudawebRuntime()`（讀 `self.FaCudawebRuntime`、`self.FaGpuNn`、`self.FaMmOps`，沒有就回 null）。**仍未完成**：渲染頁面沒有打包這三個全域（`floating-assistant.js` 內沒有 `FaCudawebRuntime`），所以產品上 probe 仍不可用；要補的是把 `cudaweb_runtime.js`、`nn_ops.js`、`mm_ops.js` 及相依打包進頁面（依 `scripts/embed-code-ui.js` 的做法，改源模組後重新嵌入）。與 P1 的數值正確性無關。
5. **評估檔讀不到磁碟（2026-11-28）**：`main.js` 的 `FA_DEBUG_EVAL_FILE` 在渲染頁執行，只有 `window.fa`，沒有 Node 模組。做法：`scripts/eval/gen_full_param_cudaweb_eval.js` 把模組原文與 fixture 內嵌進評估檔（輸出在暫存資料夾，不進版控）。
6. **全新的 `--user-data-dir` 會跳更新對話框**：要先寫 `main-ext-rev.txt`，內容是 `main-ext.js` 的 `REV` 字串（目前 `2026-10-26-vendor`）。見 `memory/reference_real_electron_eval_verification.md`。
7. **舊的 PyTorch 參考與 JS 的參數形狀不一致**：一開始 fixture 把陣列存成巢狀列表，JS 讀到錯的形狀、得到 NaN；改成一律攤平成行優先一維陣列後解決。**規則**：跨語言 fixture 一律攤平、附形狀。

## 階段總覽

| 階段 | 名稱 | 狀態 | 依賴 |
|---|---|---|---|
| P1 | 密集 transformer 全參數 SFT：cpu-py 與 cudaweb 對 PyTorch 對拍、屋頂線與耗時拆解、續訓 | 進行中（未通過）：已過：JS 對 PyTorch、GPU 矩陣乘＋前向逐元素＋AdamW 對拍、cpu-py 對拍、續訓、差分估計、全有或全無的 probe 缺項。未過：反向逐元素上 GPU、整步一次提交（目前每步 166 次呼叫）、產品頁面打包執行期、四段精確拆解（已改為差分估計）、model_types 閘門 | 無 |
| P2 | 資料入口與預訓練風格：fap 串流、分詞、打包、批次、讀取位置入檢查點；對 HF datasets 逐 token 一致；預訓練在 cpu 與 cudaweb 跑通 | 未開始 | P1 |
| P3 | 工作室引導入口與資料流水線（最小版，讓 P1／P2 能從 GUI 走完） | 未開始 | P1、P2 |
| P4 | MoE：路由、負載平衡損失、反向、cudaweb 對拍；接 function call 資料與評量（toolcall） | 未開始 | P1 |
| P5 | 推理與後訓練：思考＋答案格式、GRPO（可驗證獎勵）、DPO，各至少一個，cpu 與 cudaweb | 未開始 | P2、P4（MoE 非必要，見 P5 依賴細節） |
| P6 | 視覺語言模型全參數：影像前處理、視覺編碼器運算覆蓋、對拍 | 未開始 | P1、P2 |
| P7 | 擴散模型：UNet／DiT 訓練運算覆蓋、噪聲排程、對拍；從現有 SDXS LoRA 往全參數與從零推進 | 未開始 | P1 |
| P8 | 多節點資料平行：同機兩行程對單節點一致；接群組運算；異質節點依實測速度分配；節點離線可續 | 未開始 | P1、P2 |
| P9 | NVIDIA 公開資料真實演練：一個後訓練分片、一個預訓練分片端到端 | 未開始（**下載前必須先列檔名、來源、大小，等領導轉達使用者同意，不得自行下載**） | P2、P5、P8 |

---

## P1 密集 transformer 全參數 SFT

**目標**：`llm_scratch` 的密集模型（tiny 預設，不含 MoE），在 cpu-py 與 cudaweb 上用同一組超參數、同一份初始權重、同一批資料做全參數 SFT。cudaweb 的 loss 與梯度對 PyTorch CPU 在門檻內，並量出屋頂線與耗時拆解、續訓 loss 連續。

**依賴**：無。盤點已完成：`docs/INVENTORY.cudaweb-training.md`（缺口：基底權重 dW、嵌入梯度與權重共享、RMSNorm 增益梯度、clip_grad_norm、全參數 AdamW 套用、檢查點補全）。

**工作項**：
1. 補基底線性層的 dW（q、k、v、o、gate、up、down），在 cudaweb 上算出，與 PyTorch 逐步比對。
2. 補嵌入梯度（scatter-add）與權重共享（LM head 與 emb 共用，梯度相加）。
3. 補 RMSNorm 增益梯度。
4. 全參數 AdamW：套用到所有參數（沿用 `nn_ops.adamw`，對拍 PyTorch `AdamW`）。
5. 補 clip_grad_norm（全域範數，對拍 `torch.nn.utils.clip_grad_norm_`）。
6. 初始化：cudaweb 與 cpu-py 讀同一份權重檔（不靠兩邊各自的亂數）。
7. probe 全有或全無：列出密集模型需要的全部運算，缺項回報 `available:false` 並列出缺項（§4f）。
8. `model_types_core.js`：能跑的後端才列；測試更新並通過。
9. 屋頂線與耗時拆解（見工作項 11）。
10. 續訓：檢查點含 Adam 動量、亂數狀態、資料位置，沿用 `checkpoint_core.js` 格式；做「訓到一半停再續」測試。
11. 屋頂線：列一個訓練步的乘加次數與資料量，對本機（i5-2320＋GT 720，約 0.3 TFLOPS、頻寬十幾 GB/s）估算下限；實測拆成核心執行、上傳、讀回、同步（GPU 時間戳查詢；做不到要寫具體原因）；與 cpu-py 實測速度比較。

**完成標準**（可驗證）：
- S1：cudaweb 與 PyTorch 前 20 至 50 步的 loss，誤差在門檻內（門檻先量誤差分布再定，f32 約 1e-4～1e-3 量級，說明依據寫入本檔）。
- S2：梯度逐參數比對，最大相對誤差在門檻內。
- S3：cpu-py 與 PyTorch 同樣對拍一次（證明參考路徑本身正確）。
- S4：屋頂線表與耗時拆解表完成；耗時四段之和等於整步耗時（誤差範圍內）。
- S5：續訓測試通過：停在第 N 步、續訓至 M 步，loss 曲線與不停的版本連續（逐步一致或在門檻內）。
- S6：`model_types_core.test.js` 等相關測試通過；本機真跑一次（獨立 user-data-dir、非 17923、結束無殘留）。
- S7：若本機 WebGPU 不可用，改用 WebGL2 或 JS 層實測，並明寫層級，不得把 JS 結果說成 GPU 結果。

**已知風險與坑**：
- 權重初始化兩邊不同 → 對拍不成立（所以工作項 6 是前置條件）。
- llm_scratch 的 MoE 與 dense 共用 `Block`，P1 只跑 dense 分支，不能因此改壞 MoE 路徑。
- RoPE dir=-1 反向未確認（盤點第 4 節）。
- 單次提交過久被重置顯卡：全參數 dW 的矩陣較大，需切段（§6-6）。

**go／no-go**：S1 至 S7 全過才進 P2。

**證據**（2026-11-28，提交見 git log；未通過，見「狀態」）：

- 模型：P1 採用 `lora_ref_train.js` 的架構（RMSNorm、交錯成對 RoPE、因果注意力、SiLU 閘控 MLP、綁定輸出頭）。**與 llm_scratch 密集模型的差距**：缺 qk-norm 與分組查詢注意力（GQA）兩個運算（盤點 §1a）；這兩項列為 P1 待補項 S3b，未做。
- 檔案：`renderer/src/studio/full_param_train.js`（全參數前向、反向、裁剪、AdamW、檢查點）、`full_param_ref_torch.py`（PyTorch 真值，用 autograd）、`fixtures/full_param_parity_f64.json`（PyTorch fp64 產生）、`full_param_train.test.js`、`full_param_cudaweb_adapter.test.js`。
- S1／S2（JS 純 CPU f64 對 PyTorch fp64）：步 1 全部參數梯度最大絕對誤差 **2.0e-15**（相對 3.4e-12）；20 步損失最大絕對誤差 **1.8e-15**；梯度範數 4.2e-14；20 步後權重 2.4e-16。
- 數學正確性另外用有限差分驗證（中央差分，h=1e-6，抽樣每個參數 3 個元素）：最差相對誤差 3.2e-7（在差分雜訊內）。
- 量出的 f32 誤差（PyTorch f32 對 PyTorch f64，同一份 fixture）：20 步損失最大絕對誤差 **1.4e-6**；梯度範數 **1.0e-5**；步 1 梯度最大絕對誤差 **6.7e-7**；20 步後權重 **9.0e-7**。**GPU 門檻先定為**：損失與梯度範數絕對誤差 ≤ 1e-5（約為量到的 f32 誤差 7 倍餘裕）；梯度絕對誤差 ≤ 1e-5；相對誤差只在分母 ≥ 1e-3 的元素上比（因為極小梯度的相對誤差會被分母放大，f32 相對誤差在 4e-3 量級，見實測）。
- S5（續訓）：跑 10 步、`saveState` 存檔（fa-f32 容器＋sha256，沿用 `checkpoint_core.js` 的 `encodeTensors`／`sha256`；**偏離**：不用 `makeCheckpoint`，因為它的檔名寫死為 LoRA 的 `lora_A.f32` 等，改用 `params.f32`、`opt_m.f32`、`opt_v.f32`），全新物件載入後再跑 10 步。第 11–20 步損失對不停的版本：最大相對誤差 **1.1e-8**。竄改一個位元組的檢查點被拒絕（sha256 不符）。
- S6 接線（cudaweb 矩陣乘）：`cudawebBackend(rt)` 把所有 45 次每步矩陣乘經 `rt.matmul`。**只用假執行期（內部是 CPU 矩陣乘）測試接線**，結果與 CPU 後端逐位元相同；這不是 GPU 結果。

**未完成（P1 不能宣告通過的原因）**：

1. **真 GPU 對拍（S1、S2 在 cudaweb 上）**：未做。需要在 Electron 渲染行程裡用真的 `cudaweb_runtime` 跑 `fixtures/full_param_parity_f64.json`，逐步比對上面的門檻。目前只有 CPU 版對 PyTorch。
2. **逐元素運算仍在 CPU**：RMSNorm、softmax、SiLU、RoPE、AdamW 目前都在 CPU（f64）。對 cudaweb 的「全部在 GPU」要求，這些要改用 `nn_ops` 的 GPU 版並另外對拍；未做。
3. **S3（cpu-py 對 PyTorch）**：未做。cpu-py 跑的是 `llm_scratch.py`，它的模型含 qk-norm 與 GQA（待補 S3b），所以要先補這兩項，再做 cpu-py 對拍。
4. **S4（屋頂線與耗時拆解）**：未做。尚未量測 GPU 時間戳，也沒有拆成核心、上傳、讀回、同步四段。
5. **S7 與本機真跑**：未做。需要 Electron 真機（獨立 user-data-dir、非 17923 埠、結束用 Win32_Process 確認無殘留）。
6. **probe 全有或全無（工作項 7）**：未做。目前 `backend_cudaweb.js` 的 probe 還不列缺項。
7. **工作項 8（model_types_core）**：未做，因為目前 P1 尚未有 cudaweb 可用的全參數路徑（前項未通過前不應列出 cudaweb）。


**2026-11-28 第二輪進度（P1 剩餘項目）**：

- (1) qk-norm 與分組查詢注意力：**已完成**。`full_param_train.js` 與 `full_param_ref_torch.py` 新增 `kvH`、`qkNorm`（variant `gqa_qkn`，kvH=2、H=4、qk-norm）；RoPE 改為 rotate-half（對齊 `llm_scratch.py` 的 `rot_half`；先前交錯成對是錯的，已修正）。JS 對 PyTorch fp64：步1梯度 ≤2.3e-15、20 步損失 ≤8.9e-16（dense 與 gqa_qkn 兩個 fixture）。
- (3) cpu-py 對拍（S3）：**通過**。`full_param_cpu_py_check.py` 用 `llm_scratch.LM` 自己的模型跑 gqa_qkn 的同一批資料與初始權重，步1損失差 4.5e-9、梯度最大絕對誤差 8.4e-8（門檻 1e-5，f32 門檻）。診斷：`--rope64` 把 llm_scratch 的 RoPE 表改用 float64 重建後，差距降到 8.9e-16 與 6.7e-16。來源是 llm_scratch 的 RoPE 表在建構時用 float32，`.double()` 不會還原精度。這是 llm_scratch 既有的精度選擇，記錄在此，不改它。
- (2) cudaweb 真 GPU 逐步對拍：**已完成（評估檔，真 Electron，WebGPU 第 1 層 T1）**。結果：fp64 fixture 的 dense 與 gqa_qkn 兩份各 20 步、各 900 次矩陣乘都走 T1；對 PyTorch 的損失最大絕對誤差 2.0e-7、2.5e-7；梯度範數最大絕對誤差 1.9e-6、2.8e-6；門檻 1e-5 通過。注意：目前只有矩陣乘在 GPU，其餘逐元素仍在 CPU（見 (3)）。產品接線缺口仍在（見坑 4），評估檔不是產品路徑。原始紀錄：`scripts/eval/gen_full_param_cudaweb_eval.js`；(a) `renderer/src/studio/studio_host.js:62` 註冊 cudaweb 時是 `createCudawebBackend({})`，沒有傳入 `getRuntime`，所以 probe 永遠回報不可用；要接上必須改 studio 的源模組，再用 `scripts/embed-code-ui.js` 重新嵌入 floating-assistant.js（依 feedback_embedded_source_modules）。(b) 評估檔要在渲染行程裡讀 fixture（1.4MB），目前沒有已確認的讀檔方式（待查 `fa` 是否提供讀檔）。(c) 真 GPU 的 `rt.matmul` 結果尚未在 Electron 裡驗過。這三件要先做完，才能跑門檻 1e-5 的逐步對拍。
- (c) 差分估計（2026-11-28 第三輪，`REPORT` 第二節）：基準 1×1×1 呼叫 12.3 ms；輸入 2048 元素或輸出 1024 元素各增 ~4 ms；每元素約 2–4 µs，主要是 JS 陣列轉換。結論：瓶頸是每次呼叫的固定開銷與陣列往返，不是 GPU 頻寬。
- (e) 全有或全無：`renderer/src/studio/cudaweb_coverage.js` 列出 14 項運算、7 項不在 GPU（RMSNorm 反向、softmax 反向、SiLU 反向、注意力小矩陣乘、嵌入梯度、交叉熵、梯度裁剪）。probe 收到 `kind:"dense-full-param"` 時回報缺項、`available:false`，已有測試。**未完成**：model_types 的選單閘門（目前 llm_scratch 本來就只列 cpu-py，所以不會誤列 cudaweb；閘門本身還沒接）。
- (4) 屋頂線與耗時拆解：**部分完成**。數字與結論見 `docs/REPORT.full-param-cudaweb-speed.md`。量得：cudaweb 每步 3379 ms、純 JS 3924 ms、cpu-py 111 ms（同一設定，V2048 d256 L4 T128）；屋頂線每步 ≥8.1 ms（2.4 GFLOP、0.3 TFLOPS）。cudaweb 比 cpu-py 慢約 30 倍，瓶頸是每步 166 次 GPU 呼叫、每次約 15–20 ms 的固定開銷。**未完成**：核心／上傳／讀回／同步四段的精確拆解（需要 GPU 時間戳查詢，執行期未暴露）。
- (5) 本機 Electron 真跑：**已完成**（三次 Electron 執行，獨立 user-data-dir、埠 17931，結束後無殘留；評估檔在暫存資料夾）。原為：依 `memory/reference_real_electron_eval_verification.md` 的做法：`scripts/eval/<名稱>.eval.js`、`FA_DEBUG_EVAL_FILE`、全新 `--user-data-dir`、寫入 `main-ext-rev.txt` 防止更新對話框、`FA_BROWSER_CONTROL_PORT` 換埠、`FA_DISABLE_MAIN_OVERLAY=1`。electron.exe 已在 `node_modules/electron/dist/electron.exe`。依賴 (2)(a)(b)。
- (3) 逐元素運算上 GPU：**部分完成**。前向的 RMSNorm、softmax、SiLU、RoPE（經純資料排列走 nn_ops 的交錯核心，結果等價）與 AdamW 已走 GPU（`full_param_train.js` 的 `gpuOpsFrom`）。GPU 真機對拍：fp64 fixture 20 步，損失最大絕對誤差 1.0e-6、梯度範數最大絕對誤差 9.9e-6（門檻 1e-5，**通過但餘裕很小**，主要來源是 f32 逐元素核心的累積誤差，需要之後再收緊）。**未完成**：反向的逐元素（RMSNorm 反向、SiLU 反向、注意力反向、softmax 反向）仍在 CPU；注意力內的 QKᵀ、PV 小矩陣乘仍是 CPU 迴圈。這兩項要在整步提交（見 (4)）時一併補。

---

## P2 資料入口與預訓練風格

**目標**：經 fap 串流分片（parquet 與 jsonl）→ 分詞 → 打包 → 批次；讀取位置進檢查點；對 HF datasets 結果逐 token 一致；預訓練（無遮罩、打包）在 cpu 與 cudaweb 跑通。

**依賴**：P1（訓練核心與檢查點）。

**工作項**：
1. 串流讀取（fap）：分片逐片讀，不整檔載入（§6-7：峰值 RSS 要有上限）。
2. 分詞：與 llm_scratch 既有分詞器一致（位元組級合併、繁中）。
3. 打包：多個文件接成定長序列，文件間用結束標記分隔；無遮罩（預訓練）。
4. 批次與洗牌：固定種子，洗牌可重現。
5. 讀取位置（分片索引、片內偏移、洗牌狀態）入檢查點，續訓從正確位置接上。
6. 對拍：同一批原始文字，分詞與打包結果與 HF `datasets` 的 token 序列逐 token 一致。
7. 預訓練在 cpu-py 與 cudaweb 跑通（用 P1 的核心）。
8. gated 資料集：未同意條款時給明確錯誤（§6-8），不代填 token。

**完成標準**：
- S1：分詞與打包結果對 HF `datasets` 逐 token 一致（小樣本）。
- S2：峰值 RSS 在上限內（上限在本檔記錄）。
- S3：續訓從正確讀取位置接上，不重複、不遺漏樣本。
- S4：預訓練在 cpu-py 與 cudaweb 各跑通 N 步，loss 與 P1 一致。
- S5：無遮罩路徑的注意力與 P1 的因果遮罩分開測試，不互相影響。

**已知風險與坑**：parquet 一次讀整檔會爆記憶體（§6-7）；分片路徑的保留字（§6-4）；中文資料未查到（§6-11），先用自己的語料。

**go／no-go**：S1 至 S5 全過才進 P3。

**證據**：（待填）

---

## P3 工作室引導入口與資料流水線（最小版）

**目標**：讓 P1 與 P2 的目標能從工作室 GUI 走完，不需要命令列。

**依賴**：P1、P2。

**工作項**：依使用者定義的五根支柱，先做能讓 P1／P2 走完的最小版：
1. 引導分類入口（選模型型態、後端、資料來源）。
2. 流水線（資料 → 分詞 → 打包 → 訓練 → 匯出）。
3. 範本資料（每個型態一個可直接用的範本）。
4. 轉換篩選（資料過濾，最小版）。
5. 規則／線上 AI／離線 AI 引導轉換（最小版：規則轉換先做，AI 轉換接口留好並標明未接）。
6. **群組訓練節點勾選（P8 的 8.1、8.2 最小版，提早做）**：在群組 UI 加「分享這台機器當訓練節點」勾選（預設不勾）；勾選後廣播實測能力（CPU tokens/s、cudaweb 層級、可用記憶體）；取消勾選時不接新工作、正在做的工作依 8.2 安全交還。不做派工與結果合併（那些在 P8）。完成標準：勾選與取消勾選的狀態變化可在群組清單看到；能力數字附量測時間；有測試。

參考 `docs/DESIGN.TODO.studio-nvidia-data.md` 的矩陣與缺口 G1–G13。

**完成標準**：
- S1：從 GUI 選 P1 的型態與 cudaweb 後端，能開始、能停、能續訓。
- S2：從 GUI 走完 P2 的預訓練流程。
- S3：`model_types_core.test.js` 與 GUI 相關測試通過。
- S4：本機真跑一次，截圖或讀 DOM 確認（不得只靠單元測試宣稱完成）。

**已知風險**：GUI 範圍容易擴大；本階段只做最小版，範圍外的項目列入本檔「未做」並說明原因。

**go／no-go**：S1 至 S4 全過才進 P4。

**證據**：（待填）

---

## P4 MoE 與 function call

**目標**：專家混合（MoE）的路由、負載平衡損失、反向在 cudaweb 上與 PyTorch 對拍；接 function call 的資料與評量（toolcall）。

**依賴**：P1（主幹）。

**工作項**：
1. 路由：線性層＋softmax＋topk＋重新正規化（對拍 PyTorch）。
2. 稀疏分派：gather、逐專家矩陣乘、index_add（或改為稠密計算加權，數值須一致；選擇寫入本檔）。
3. 負載平衡輔助損失 `aux`（`E * sum(f.detach() * Pm)`）與其反向（對拍）。
4. 專家 `wg`、`wu`、`wd` 的三維參數與 AdamW。
5. 與 llm_scratch `MoE` 的 loss、梯度逐步比對。
6. toolcall：function call 資料格式（每行一筆，含工具定義、呼叫、結果）、評量（格式正確率、參數正確率）。

**完成標準**：
- S1：MoE 前向與 PyTorch 在門檻內。
- S2：`aux` 與其梯度對 PyTorch 在門檻內。
- S3：MoE 訓練 N 步，loss 對 PyTorch 一致。
- S4：toolcall 評量可跑，有至少一組對照數字（不宣稱品質，只量格式與參數正確率）。
- S5：probe 對 MoE 的缺項歸零（全有）。

**已知風險**：topk 與 index_add 在 WGSL 上需要自寫；稀疏與稠密的選擇會影響速度與記憶體，需量測（屋頂線）。

**go／no-go**：S1 至 S5 全過才進 P5。

**證據**：（待填）

---

## P5 推理與後訓練

**目標**：思考＋答案格式、GRPO（可驗證獎勵）與 DPO，各至少一個，在 cpu 與 cudaweb 上跑通。

**依賴**：P2（資料）、P4（若推理架構用 MoE；密集推理也可，見工作項 1）。

**工作項**：
1. 思考＋答案格式：資料與聊天樣板（沿用 llm_scratch 的 `<think>` 格式）。
2. 取樣：cudaweb 上的自回歸取樣（`sample_cached` 的對應實作），與 PyTorch 在固定種子下逐 token 一致。
3. GRPO：群組取樣、可驗證獎勵（算術題）、優勢值標準化、策略梯度與 KL（若有）。對拍 PyTorch。
4. DPO：成對偏好資料、參考模型的 log 機率、損失與梯度對拍。
5. cpu 與 cudaweb 各跑通至少一個。

**完成標準**：
- S1：取樣逐 token 一致（固定種子）。
- S2：GRPO 或 DPO 的損失與梯度對 PyTorch 在門檻內。
- S3：後訓練跑通 N 步，獎勵或偏好指標有改善（不宣稱品質，只量該指標）。
- S4：cpu 與 cudaweb 各一個跑通。

**已知風險**：取樣的亂數與 PyTorch 不同 → 必須固定取樣演算法（同一個 multinomial 方法）才可逐 token 比對；GRPO 獎勵函數要與 llm_scratch 的算術題驗證一致。

**go／no-go**：S1 至 S4 全過才進 P6。

**證據**：（待填）

---

## P6 視覺語言模型全參數

**目標**：影像前處理、視覺編碼器運算覆蓋、對拍，全參數訓練在 cudaweb 上跑通。

**依賴**：P1、P2。

**工作項**：
1. 盤點視覺編碼器的運算（卷積或 patch embedding、注意力、MLP、正規化）與 cudaweb 覆蓋（同 INVENTORY 格式）。
2. 缺的運算補上（卷積 dW、patch embedding 等），與 PyTorch 對拍。
3. 影像前處理（縮放、正規化）與 PyTorch／PIL 對拍。
4. 全參數 SFT（看圖問答）跑通，cpu 與 cudaweb 對拍。

**完成標準**：
- S1：視覺編碼器每個運算與 PyTorch 對拍在門檻內。
- S2：前處理對拍一致。
- S3：全參數訓練 N 步 loss 對 PyTorch 一致。

**已知風險**：卷積反向的工作量較大；影像張量大，記憶體需切段。

**go／no-go**：S1 至 S3 全過才進 P7。

**證據**：（待填）

---

## P7 擴散模型

**目標**：UNet 與 DiT 的訓練運算覆蓋、噪聲排程、對拍；從現有 SDXS LoRA 往全參數與從零推進。

**依賴**：P1。

**工作項**：
1. 盤點 UNet／DiT 的訓練運算（卷積、群組正規化、時間嵌入、注意力、上採樣與下採樣）與 cudaweb 覆蓋。
2. 缺的運算補上，與 PyTorch 對拍。
3. 噪聲排程（DDPM 線性或 cosine）與損失，對拍。
4. 全參數微調 SDXS（從現有 LoRA 的基底出發）跑通，cpu 與 cudaweb 對拍。
5. 從零訓練小型 DiT 跑通（資料量小，只證明流程）。

**完成標準**：
- S1：各運算對 PyTorch 在門檻內。
- S2：噪聲排程與損失對 PyTorch 一致。
- S3：SDXS 全參數微調跑通 N 步，loss 對 PyTorch 一致。
- S4：小型 DiT 從零訓練跑通（只驗證流程，不宣稱生成品質）。

**已知風險**：卷積與群組正規化的反向工作量；SDXS 權重大，記憶體與時間都要量測。

**go／no-go**：S1 至 S4 全過才進 P8。

**證據**：（待填）

---

## P8 多節點資料平行

**目標**：兩個節點（同機兩行程）對單節點結果一致；接群組運算；異質節點按實測速度分配；節點離線可續。

**依賴**：P1、P2。先讀 `docs/DESIGN.TODO.cpu-everywhere-and-group-compute.md`。

**相關現有零件（已用檔名查證，未大範圍搜尋）**：`DESIGN.remote-group.md`（群組設計，根目錄）、`docs/DESIGN.TODO.cpu-everywhere-and-group-compute.md`（群組分散計算的待辦與決定）、`renderer/src/remote/rg_core.js`、`rg_dispatch.js`（派工）、`rg_session.js`、`rg_host.js`、`rg_collab.js`、`rg_transport_supabase.js`（經雲端中繼；`rg_dispatch` 是派工協定，不適合每步同步，§6-16）、`rg_transport_kv.js`。群組 UI 與節點註冊的實際位置待 P8 第 8.1 項確認（本計畫撰寫時未讀完）。

**工作項（核心訓練）**：
1. 同機兩行程的資料平行：梯度聚合（all-reduce 或參數伺服器，依設計文件），與單節點逐步一致。
2. 梯度通訊：fp16 或 fp32，通訊量實測（§4h-4 比對）。
3. 每步同步不走派工通道（§6-16）。
4. 每個樣本序號只計入一次（§6-14）。
5. 陳舊梯度丟棄並計入日誌（§6-15）。
6. 異質節點依實測速度分配批次。
7. 節點離線可續：租約逾時重派，從檢查點續。

**工作項（群組訓練節點，使用者 2026-11-28 補充，逐字：「也要把群組支援訓練列入計畫，例如在group的ui，有地方可以check表示可以共享當訓練節點」；不得省略）**：

8.1 **群組 UI 勾選**：在現有群組介面加一個勾選「分享這台機器當訓練節點」，預設不勾（明確選擇加入）。勾選接到節點能力宣告（8.2）。P3 先做最小版（見 P3 工作項 6）。
8.2 **節點能力宣告**：勾選後，節點對群組廣播可提供的資源。所有數字用**實測**，不用規格：
   - CPU 核心數與實測 tokens/s（用 P1 的同一個訓練步量）；
   - cudaweb 是否可用與層級（WebGPU ／ WebGL2 ／ JS，依 probe 真實結果）；
   - 可用記憶體（實測，不是系統總量）；
   - 可提供的時段或忙碌度（依本機使用量的實測，使用者可設定上限）。
   - 取消勾選時：正在做的工作要安全交還（寫檢查點、工作單標記為待重新派發，不丟棄已算的樣本，也不把半成品梯度計入）。
8.3 **授權與安全**：
   - 只有勾選的節點才會被派訓練工作（取消勾選後立刻停止接新工作）。
   - 工作內容與資料不得超出該節點使用者同意的範圍（同意範圍由節點本地保存，協調者不能擴大它）。
   - UI 顯示目前被派了什麼、已用多久，並可隨時停止（停止＝走 8.2 的安全交還）。
   - 節點之間傳遞的資料（資料分片、梯度）要標註來源與授權；**來源資料授權不允許再散布時，不得派到他人機器**（與 §6-9 授權傳染一致）。
   - 資料分片與梯度的隱私：分片只傳給被派工的節點；梯度不含原始資料（但需註明：梯度可能洩漏部分資訊，本階段只記錄此風險，不宣稱已防禦）。
8.4 **協調者與派工**：
   - 發起訓練的那台是協調者，負責切分工作單、派發、收集結果、合併。
   - 工作量依各節點 8.2 的實測速度加權。
   - 節點中途加入：只接收新工作單，不回溯舊步。節點中途離線：租約逾時，工作單重新派發（§6-14 去重）。
   - 結果驗證（避免惡意或壞節點污染訓練）：每個工作單的梯度由協調者用**抽樣重算**核對（同一批資料抽幾個樣本，在協調者本機重算，比對梯度範數與數值誤差）；不通過的節點標記為不可信並排除；被排除的工作單重派。驗證的抽樣率與門檻寫入本節完成標準。
9. 8.1 至 8.4 的群組相關細節，以 `DESIGN.remote-group.md` 與 `DESIGN.TODO.cpu-everywhere-and-group-compute.md` 為準；若與現有設計衝突，先在本計畫記錄衝突，不自行覆寫對方的設計。

**完成標準**：
- S1：兩節點對單節點逐步一致（在門檻內，門檻沿用 P1 的 f32 門檻）。
- S2：通訊量實測與估算比對。
- S3：樣本不重複、不遺漏。
- S4：一個節點中途離線，另一節點接續，結果與不中斷一致或在門檻內。
- S5（群組 UI，對應 8.1、8.2）：勾選後節點出現在群組的可用節點清單，能力數字為實測值並附量測時間；取消勾選後清單移除。
- S6（授權與安全，對應 8.3）：未勾選的節點收到 0 個工作單；授權標記不允許散布的資料分片不會派到他人機器（有測試）；UI 顯示的「被派工作與已用時間」與實際一致；停止後不再接新工作。
- S7（協調，對應 8.4）：工作量按實測速度分配（比例與實測速度誤差在本節門檻內）；中途加入與離線的測試；一個惡意或壞節點（人為注入錯誤梯度）被抽樣驗證抓出並排除，訓練結果與單節點對 PyTorch 一致。
- S8（驗收，對應使用者第 5 項）：兩台（同機兩行程可）勾選後加入同一群組，發起一個小訓練，結果與單節點對 PyTorch 參考一致；取消勾選後該節點不再被派工；有測試與一次真跑記錄（真跑依 Electron 規則：獨立 user-data-dir、非 17923、結束用 Win32_Process 確認無殘留）。

**已知風險**：群組通道延遲；租約與重派的競爭條件；抽樣驗證無法抓到所有惡意梯度（只能降低風險，需明寫）；UI 勾選與真實派工的狀態不一致（需以協調者為準）。

**go／no-go**：S1 至 S8 全過才進 P9。

**證據**：（待填）

---

## P9 NVIDIA 公開資料真實演練

**目標**：取一個後訓練分片與一個預訓練分片，實跑端到端。

**前置條件（硬性）**：下載前必須先列出檔名、來源、大小，並等領導轉達使用者同意。**不得自行下載。**

**工作項**：
1. 列出候選分片（檔名、來源、大小），送領導等同意。
2. 同意後下載，經 P2 流程讀取、分詞、打包。
3. 後訓練分片：經 P5 流程跑通。
4. 預訓練分片：經 P2 流程跑通。
5. 端到端結果記錄於本檔。

**完成標準**：
- S1：使用者同意後才下載（證據：領導的同意訊息）。
- S2：兩個分片端到端跑通，無錯誤。
- S3：結果數字記錄於本檔，不宣稱品質。

**已知風險**：gated 資料集的條款（§6-8）；授權傳染（§6-9）；Tables-V1 與 nemotron-post-training-v3 HTTP 401 未確認（§6-12）。

**go／no-go**：S1 至 S3 全過即為計畫完成。

**證據**：（待填）

---

## 進度紀錄

- 2026-11-28：盤點完成（`docs/INVENTORY.cudaweb-training.md`，提交 c1e19f053）。
- 2026-11-28：本計畫建立。P1 仍在進行中，尚未做對拍。


**2026-11-28 第四輪：執行順序（領導指示，設計輸入）與現成零件**

設計原則：張量常駐 GPU（權重、激活、梯度都在 GPU buffer，禁止中間經 JS 陣列）；整步編譯成一個派發清單，只在需要時讀回損失與抽樣；每次提交 ≤300 ms（避免顯卡逾時被重置）。速度目標：先比現在（3379 ms/步）快 10 倍以上，再逼近屋頂線（≥8 ms/步）。

現成零件（已用檔名查證）：
- `renderer/src/gpu/nn_ops.js` 的 `createBatch(dev)`：一個命令編碼器內可串接多個派發，`upload` 只寫一次，中間結果以緩衝區句柄傳遞，不回讀；`submit` 後才讀回。
- `renderer/src/gpu/train_step_device.js` 的 `trainStepDevice`：**整步單次提交**的 LoRA 版本，已含 RMSNorm、注意力、SiLU 閘控的反向核心（`rms_bwd`、`attn_bwd_q/kv`、`mlp_bwd`）與 LoRA 反向。它是全參數版的起點，但目前只產生 LoRA 的 dA、dB，沒有基底權重的 dW、嵌入梯度、RMSNorm 增益梯度，也沒有交叉熵反向的 GPU 版接入。

下一步的具體工作（一步一提交）：
1. **全參數的整步路徑**：複製 `trainStepDevice` 的結構，改成對 Wq／Wk／Wv／Wo／Wg／Wu／Wd、嵌入、RMSNorm 增益求梯度（用 `loraBwd` 的 `dW = Xᵀ·dY` 形式，基底權重不再凍結）。對拍：fixture dense 與 gqa_qkn，20 步，門檻 1e-5。
2. **反向逐元素核心**：RMSNorm 增益梯度、交叉熵反向（`nn_ops.crossEntropy` 已有 dl）、RoPE 反向（`dir=-1`，已有）、softmax 反向（注意力，併在 `attn_bwd_*`）；每個單獨對 PyTorch 對拍後接入。
3. **整步單次提交**：整步 ≤ 300 ms 的提交數（目標 1–3 次），量每次提交的牆鐘。
4. **AdamW 在 GPU**：已有 `nn_ops.adamw`，接入整步派發清單。
5. 之後：渲染頁打包（d）、選單閘門（e 的 model_types 部分）。

本輪未開始實作（這是規劃，不是完成）。P1 狀態不變：未通過。
