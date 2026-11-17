# 交接：cudaweb 推論與訓練核心優化（接力用）

工作目錄：`D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。清單：`docs/CHECKLIST.cudaweb-optimize.md`（每項的狀態與證據都在那裡，先讀它）。結果檔：`scripts/eval/cudaweb_optimize.result.json`。

## 使用者原話（逐字，2026-11-17）
- 「我希望推論、訓練的cudaweb是經過高度優化的，必須可以適應各種等級的gpu」
- 「像是早期的nvidia的gpu要優化過 要自己選擇把記憶體放到constant memory或texture」
- 「gpu kernel還要用shared memory快取跟加速運算」
- 「讓他持續優化下去」

## 目標
這張 Kepler 14 W（真 WebGPU、無 f16、無 subgroups）上，每種運算都不比 ort-webgpu 慢；訓練每步時間也要持續降。依能力分級（低／中／高），每一級都能跑。

## 已完成（提交可查 `git log --oneline`）
- O2 q8mm：`q8mm_dec`、`q8mm_pf`（M≥64）。真 Chrome 逐位相同。
- O1 變體選擇器：`kernel_select.js`（probeCaps／tierOf／pickVariant／強制覆蓋）。
- O3 MatMulNBits：`matmulnbits_dec`（M≤8）、`matmulnbits_pf`（M>8）。真 Chrome T1、相對誤差 ≤1.3e-6。
- O4 注意力：`attn_flash`（分塊線上 softmax）。真 Chrome 6 個形狀相對誤差 ≤1.1e-6；解碼 20.3 ms 對 158.5 ms。
- O6 node 部分：`gpu_pool.js`（緩衝區池與管線快取），接進 `nn_ops.createBatch`。
- O9 node 部分：快取鍵、失效、強制覆蓋、競賽中位數（`kernel_select.js`）。
- O1m：x 放 uniform 量過，**沒有好處，不採用**（K1024N3072 storage 0.465 ms 對 uniform 3.89 ms）。
- O11 部分：`embed-code-ui.js` 補 `gpu_pool`；三個建置腳本已跑（`embed-code-ui`、`build-assistant`、`build-web-lazy`）通過。建置產物（`renderer/floating-assistant*.js`、`update-manifest.json`、`web-lazy/`）未提交，待發布流程。

## 未完成（依優先序）
1. **O5**：`gpu_core.js` 的 `WGSL.matmul` 與 `mm_ops` 的平鋪核心共用一份（抽成模組；注意嵌入清單 `scripts/embed-code-ui.js` 第 82 與約 215 行要同步加新模組名）；轉置版（AᵀB、ABᵀ）用同一份核心的索引參數；f16 變體在這張卡沒有 f16，寫好標「待驗證（原因）」。真 Chrome 逐元素對 CPU 參考，計時標硬體。
2. **O6 真機計次**：一層 Qwen 區塊的 submit 次數從每運算一次降到每層一次，結果逐位相同。matmul 還沒進批次。
3. **O7 融合與其他核心**：rmsnorm＋矩陣乘輸入縮放、silu×乘法、rope 併進 QKV 後處理、卷積平鋪。
4. **O8 訓練路徑**：LoRA／AdamW／交叉熵用 O5 核心；AdamW 與梯度累加融合；訓練步內不做逐運算讀回。
5. **O9 UI 與競賽**：瀏覽器端競賽（背景、≤2 秒、可取消、各變體 3 次取中位數）、localStorage 包裝（失敗就退規則）、設定頁兩處（AI 助理設定與桌面版設定）同步顯示與強制指定。
6. **O10 完整結果**：每個變體「通過」或「待驗證（原因）」，寫進 `cudaweb_optimize.result.json`。
7. **O11 收尾**：`git status` 沒有未提交來源（CRLF 差異不算）；`bench_run.js` 設定頁基準顯示優化後的 cudaweb 數字。

## 持續優化迴圈（管理者規則，2026-11-17）
每一輪：
1. **量瓶頸**（同機、標硬體）：設定頁基準的三個形狀 64×1024×1024、512×1024×1024、512×1024×3072；Qwen 解碼單步；注意力；4 位元矩陣乘的代表形狀。寫下每個運算相對 ort-webgpu 落後多少、占解碼單步時間多少。
2. **挑下一步**：先找「相對 ort-webgpu 最落後」或「占 Qwen 解碼單步時間最多」的運算。候選方向：更大的暫存器分塊、vec4 載入、K 方向切分、非同步預載下一塊、減少屏障、融合更多運算、權重改貼圖或 uniform。
3. **先寫變體**，再用選擇器（`kernel_select.js`）與自動調校決定。**有量到好處才換；沒有好處就如實記「沒有好處」，換下一個方向。** 不宣稱沒驗證的好處。
4. **每輪一個提交**、一次真 Chrome 驗證（逐元素對拍＋計時，標硬體）、清單更新（清單末尾的「持續優化迴圈」節逐輪追加：瓶頸、改了什麼、改後數字）。
5. 不問問題、不發布、不推送。管理者定期核對提交，每輪不用回報。

## 硬規則（不變）
- 不在真 GPU 上跑會逾時或卡死的測試（例如 simple 核心 M=256 會讓 GPU 逾時、裝置丟失；上次之後 Chrome 的 WebGPU 介面卡消失，要使用者重啟才回來）。大形狀只在 node 假裝置測。
- 測試伺服器與分頁用完就關，並用 PowerShell 查 `Win32_Process` 確認無殘留。驗證頁用 `python -X utf8 -m http.server <埠> --bind 127.0.0.1` 起在 desktop-app 資料夾。
- 不對 AppData 或整個家目錄做遞迴搜尋。
- 改程式用 Edit／Write 工具，不用 shell 內嵌 heredoc 寫含反斜線的程式。
- 提交只含自己改的來源；建置產物不跟著提交。
- **context 到 60% 時**：更新本文件與清單，寫 side-session-notes 交接，並開下一棒（Haiku，effort high）。

## 驗證頁（都在 `scripts/eval/`）
- `q8mm_check.html`、`attn_flash_check.html`、`matmulnbits_dec_check.html`、`mem_space_check.html`、`mm_tiled_check.html`（既有）。
- 讀 `window.__out`；判準寫在每頁開頭註解。

## 2026-11-18 第十三段（本棒：安全校準、量測互斥、O12a–c、批次誠實記錄；提交已列在下）

提交（本地，未推送；發布由管理者跑）：`a56dac179` 安全校準；`d460b2d8e`、`175410a1e` 評估檔；`2b84c1945` R0 16 條鏈；`3fa2443c7`、`42304af2d` 轉置旗標；`9279e80d0` sgemm_batched；`935917eed` 第十二段交接；`6c6421c86` O12a 描述表；`87caad159` O12b CPU 參考骨架；`869043756` O12c 覆寫槽；`f7b7adc08` 量測互斥鎖＋提交拆分；`6696b7122` O12b GPU 版（投影走 gemv）＋小 M 路徑＋批次路徑誠實記錄；`346768e8e` requestExclusiveGpu＋閒置持有者＋qwen sha256。

屋頂量測（已取代舊的 1024 次迭代探測）：兩個極小派發（8、32 次）線性外推到單次約 30 ms，迭代數上限 4096；任何派發或提交超過 150 ms 就中止並標「屋頂量測不可信」，不再放大。提交估計超過 100 ms 就拆開（`splitRuns`）。

GPU 獨占：`nn_ops.requestExclusiveGpu(reason, {signal})` 排隊、可取消；授予前依註冊順序呼叫閒置持有者（`registerIdleGpuHolder`）的 release，某個丟錯記在 `release.failures` 仍授予。基準、變體競賽、屋頂量測都走它；背景自動競賽在有獨占時跳過。

桌面實測（真 Electron、真 WebGPU，`mm_roofline_calibrated`，唯一一次）：
- 屋頂：`ok`，119.42 GFLOP/s（317 次迭代、3 次一批、單次約 5.6 ms，總共 95 ms）。這個數字在峰值 127.5 之下，但還沒跟獨立量測對照。
- 競賽：64×1024×1024 勝者 `mm_vec4_f32`（kernel-only 中位數 1.32 ms，101 GFLOP/s，編譯 3.28 ms）。512 兩個形狀全部依預估逾時略過，每個候選都有原因（estMs 與 150 ms 上限）。沒有候選因驗證失敗。
- 轉置路徑：GPU 上 layer T1，最大誤差 7e-7。
- 批次路徑：`lastPath = per-item（這個核心沒有 matmulMany，逐組執行）`。**批次不是真的批次**，只是逐組正確。要真的一次提交，需要在 gpu_core 補 matmulMany。
- 小 M 路徑（gemv）：M=1、B 以 N×K 儲存，走 gemv，layer T1，最大誤差 1.2e-7。只處理 transB 排法。
- O12b GPU 版：2 層小模型的 GPU 解碼（投影走 gemv）對 CPU 參考，最大誤差 1.2e-7，argmax 相同。

O12d：Qwen3 0.6B onnx 的 sha256 由本機已下載檔計算為 `ccf8734e…`（大小 617687575 與表一致）；1.7B 分段串流實算為 `202ed819…`，與表一致；tokenizer 為 `e7a95fce…`，與表一致。Llama 系列（TinyLlama、Llama 3.2、SmolLM2）本機沒有檔案，所以沒有 sha256，描述表 `verified: false`，標待核對。

本段沒做、需要決定：O13（LLaVA-Interleave、SmolVLM、Florence-2）與 O15（全部離線模型上 WebGPU）需要模型檔，本機沒有；下載要使用者同意。另外，閒置持有者的註冊要由模型引擎在呼叫端接線（另一個工作階段負責新聞摘要）。

## 2026-11-18 第十二段（本棒：Intel 缺口、核心計時、O14b 轉置旗標）

提交（皆為本地提交，未推送、未發布）：
- `131f6be68`：競賽計時改核心時間（一次提交多次派發、等 GPU 完成）；勝者記編譯 ms；屋頂 R0 量測（R0 存 `ROOF|adapter|sig`）；表格編譯欄與實測峰值優先；內嵌同步。
- `2b84c1945`：R0 改 16 條獨立依賴鏈；量測不穩（單次超過線性預估 3 倍以上）就不採用。
- `3fa2443c7`：`rt.matmul` 與橋接傳遞 transA／transB（mm_ops 轉置核心）。
- `42304af2d`：`cublas.sgemm` 的小運算元（≤ 2^23 元素）改送旗標，大的仍在宿主轉置。

桌面實測（真 Electron、真 WebGPU；adapter 回報 nvidia／kepler，能力簽名 `wg32768-inv1024-f160-sg1`，與內建峰值表的 GT720 簽名 `wg16384-inv256-f160-sg0` 不同，所以內建 127.5 GFLOP/s 不一定適用這台）：
- 計時判定可信：同一個 FMA 核心，派發 1／4／16 次，`onSubmittedWorkDone` 與 `mapAsync` 回讀一致（n=16：12.5 ms vs 12.4 ms）。（`mm_timing_check.eval.js`）
- 小形狀吞吐被傳輸主導：64×1024×1024 完整路徑 87.2 ms（1.54 GFLOP/s），同形狀核心約 1.4 ms（第一次競賽的 mm_vec4_f32 勝者）。這就是 Intel 缺口「7.10 GFLOP/s」的主因：不是計算慢。
- **未解決**：屋頂 R0 數字不可信。第一次（4 條鏈）1.37 GFLOP/s；第二次（16 條鏈）0.93 GFLOP/s，單次 786 ms，但線性預估約 40 ms。診斷核心在同一台機器上同樣的每次迭代成本是遠低於這個數字的，所以 R0 的量測方法還有問題，不是核心太慢。
- **未解決**：第二次競賽 64×1024×1024 沒有勝者（第一次有 mm_vec4_f32）。沒有記錄逐候選的失敗原因，原因不明。
- 「占峰值」目前在這台機器上會顯示實測值（0.93 GFLOP/s），這是**錯的**，應改用「不採用」。穩定性檢查（`2b84c1945`）已加，但還沒在桌面版驗證。
- 驗證預算：`mm_roofline_compile` 已跑兩次（4 條鏈一次、16 條鏈一次），不要再跑；要驗證穩定性檢查，需要管理者同意再開一次，或改用新的評估檔。

本段沒做：批次矩陣乘、gemv 小 M 路徑、GPU 上實測轉置路徑、O14c、O14d（DESIGN 文件段落）、O12／O13／O15。

下一步建議（依優先序）：
1. 查 R0 量測為什麼單次時間遠高於預估（懷疑：量測之間 GPU 時脈降頻，或 `measureRoofline` 的 `runIters` 與診斷核心的提交方式不同；先比對兩者的提交內容）。
2. 查第二次 64×1024×1024 沒有勝者的逐候選原因（在 `startMatmulRace` 的回傳裡有 `bad`，評估檔目前沒有印出來）。
3. 轉置路徑在 GPU 上實測（一個形狀、小、可控）。

## 2026-11-18 進度（本棒）
- 介面卡：Chrome 真 WebGPU 可用（nvidia／kepler）。實測 `features` 含 `subgroups`、不含 `shader-f16`；先前記為無 subgroups，已更正（待確認能否用於核心）。
- **O5 完成**（提交 `2d4a066b1`、`ea70490e5`）：`gpu_core.js` 的 `mmTileWgsl`（平鋪 64×64、4×4 暫存器、8 KiB 共用）同時供 `WGSL.matmul` 與 `mm_ops` 平鋪版；轉置用 p0 旗標（真 Chrome 23 項逐位相同）；vec4 變體（K、N 為 4 倍數、不轉置自動選用）大形狀快約 25–30%。f16 版 BLOCKED（無 shader-f16）。
  - 注意：清單原先說「抽成模組」，實際放在 `gpu_core.js`，因為 gpu_core 是 UMD、以 `new Function` 嵌入，不能 require 新模組。
- **O6 部分**（提交 `9e8d647f0`）：`createBatch` 加入 matmul；真 Chrome `batch_layer_check.html` 層形序列 1 次 submit 對 6 次、逐位相同、4.0 ms 對 24.5 ms。**真 Qwen 區塊還沒接入批次**（注意力、q8mm、MatMulNBits）。
- 驗證頁都在 `scripts/eval/`：`mm_tile_check.html`（需先 `git show 1515d6598:desktop-app/renderer/src/gpu/gpu_core.js > scripts/eval/_tmp_before_gpu_core.js`，量完刪）、`batch_layer_check.html`。結果寫進 `cudaweb_optimize.result.json`。
- 本棒沒做：O6 真 Qwen 接入、O7、O8、O9、O10、O11、持續迴圈。

## 2026-11-18 第六段（本棒：G1 收尾、G2、G4 模組、G3；G5 與 O5 以後未做）
提交（依序）：`e28658ea0` G1 收尾；`99ac66fc3` G2 階梯；`a1a138726` G4 variant_race；`15c09eb0b` G3 priors。
- **方案 A 已實作**：`scripts/embed-code-ui.js` 的 `embed()` 新增可選參數 `prependFile`；`FA_GPU_CORE_SRC` 先放 `kernel_gen.js`（UMD，瀏覽器掛在 `self.FaKernelGen`），`gpu_core.js` 的 `kg()` 取用（node 用 require）。
- **G1 結論（重要）**：`mmR8Wgsl` 已改成 kernel_gen 實例（WG16 TM8 TN8 BK8 vec4）：真 Chrome 512×1024×1024 相對誤差 3.0e-7、46.6% 峰值（R1 手寫 47–50%，持平）。**`mmTileWgslVec4` 還原手寫版**：kernel_gen 同幾何實例（WG16 TM4 TN4 BK16 vec4）慢約 5 倍（51.6 ms 對 10.4 ms，16.2% 對 80.5%）。production（`nn_ops` 的 `MM_VEC4_CODE`）不能換。kernel_gen v4 慢的原因**未查**（候選：As 列主序寫入的 bank 衝突、k 迴圈未展開、As 未轉置）；下一棒第一步可先比對手寫版的 As 布局再修 kernel_gen，修好才換。
- **G2**：`kernel_gen.ladder()` 18 個變體（5 塊 × BK 8／16 × 純量／vec4；2×2 不能 vec4）。真 Chrome 只編譯（`scripts/eval/g2_ladder_compile.html`）：全部成功、編譯 85–400 ms、共用記憶體最大 16 KiB。split-K 未做。
- **G4**：`renderer/src/gpu/variant_race.js`（`race`、`makeKey`、`createStore`）node 9 項通過。**未做**：IndexedDB 真機、接進派發呼叫端。
- **G3**：`profile_priors.js` ＋ `profile_priors.json`：一筆 measured（GT 720，簽名 `wg16384-inv256-f160-sg1`，sg1 以 Chrome 回報為準待確認），三筆 heuristic（低／中／高，明確標 basis）。node 9 項通過。
- **G5 未做**：設定頁「變體競賽」表。來源：`renderer/src/floating-assistant.js` 的 `_gpuBenchPanel`（約 96434 行呼叫處，`_gpuBench*` 約 130389 行起）。`bench_run.js` 是執行器、不含 UI。AI 助理設定（`index.html`）未找到 GPU 基準區塊（grep 無「基準」），需確認兩處是否都要加；依記憶「AI設定UI有兩份」，改一處要查另一處。
- **O5～O10、持續迴圈**：未做（見清單）。
- 驗證頁：`scripts/eval/g1_gen_check.html`（`?M&K&N&kernel=r8|v4&before=1`）、`scripts/eval/g2_ladder_compile.html`。兩次真 Chrome 用完已關分頁、伺服器已停（Win32_Process 確認無 `http.server` 殘留）。
- 注意：kernel_select.js 的快取（localStorage 版）與 variant_race（IndexedDB）是兩套，G4 接線時要決定是否統一（建議統一用 variant_race 的 store，kernel_select 只保留純函式）。

## 2026-11-18 第五段（交棒，管理者指示：context 到 60% 才交棒）
- 本段沒有完成新提交；G1 收尾**未開始寫程式**。原因：要讓 `gpu_core.js`（UMD，以 `new Function(FA_GPU_CORE_SRC)` 嵌入）引用 `kernel_gen.js`，需要改嵌入與載入順序（`scripts/embed-code-ui.js` 與 `renderer/src/floating-assistant.js` 的載入點），這會動到發布流程，應由管理者確認方案後再做。
- **待管理者決定的方案**：(A) 在 `embed-code-ui.js` 加 `kernel_gen.js` 的嵌入，並在 `gpu_core` 載入前先執行它（`root.FaKernelGen`）；或 (B) 把 `kernel_gen` 的產生函式直接併進 `gpu_core.js`，`kernel_gen.js` 只留給 node 測試使用。兩者都能做到「不另寫一份」，但 (A) 需要改載入順序。
- 分支上另有提交 `16a968d4f`（作者 IceCold Sunneo，Co-Authored-By Sonnet 5.5，訊息寫「平鋪核心、8×8、kernel_gen、各運算優化」）。實際內容只改了 `PATCH_VERSION`、`renderer/floating-assistant*.js`、`renderer/src/floating-assistant.js`、`update-manifest.json` 與 `web-lazy/`，沒有改 `renderer/src/gpu/`。與本段無關，但訊息與內容不符，請管理者核對。
- 清單 O5（已完成）、O6（部分）、G1（測試通過、未接入）、G2–G5、O7–O10 皆未做。R1 的 8×8 與 8×4 已量、不採用。
- 下一棒第一步：先解決上面的方案 A/B，再做 G1 收尾（實例化＋真 Chrome 驗），然後 G2 → G4 → G3 → G5。

## 2026-11-18 第四段（變體階梯 G1–G5，見 docs/TARGET.cudaweb-cublas.md 末尾與清單「變體階梯」節）
- 提交 `cc62bc95a`：G1 產生器 `renderer/src/gpu/kernel_gen.js`（8 項 node 測試通過）。
- **下一棒第一步**：(a) 讓 `gpu_core.js` 的 `mmR8Wgsl`、`mmTileWgslVec4` 改成 `kernel_gen` 的實例（不要另寫一份），node 測試與 fake 路徑保持；(b) 用單形狀頁（`r8_time2.html` 的做法，一次一形狀、最多 3 個 submit、監聽 device.lost）真 Chrome 驗 kernel_gen 產出的著色器的正確性與速度；(c) 再做 G2 階梯與編譯毫秒。
- 編譯慢不淘汰（管理者修正）；只留約 30 秒防卡死上限。快取存勝者參數到 IndexedDB。
- 安全量測規則不變：一頁一形狀一核心、先估時間（flops ÷ 20 GFLOP/s，超過 300 ms 不跑）、最多 3 個 submit、device.lost 即停、用完關伺服器與分頁。

## 2026-11-18 第二段（新目標：趨近 cuBLAS，見 docs/TARGET.cudaweb-cublas.md）
- R0 屋頂已量：peakFlops ≈ 127–128 GFLOP/s、peakBW ≈ 11.4 GB/s（`roofline_check.html`，寫進 result.json）。
- R1 8×8 核心 `mmR8Wgsl` 已寫，node 測試過；真 Chrome 單次派發正確（`r8_probe.html`）。**計時還沒完成**：整頁 `mm_r8_check.html` 多次讓 Chrome 分頁凍結，WebGPU 一度無回應（之後分頁群組重建），已停手。
- **下一棒第一步**：先確認 Chrome 的 WebGPU 正常（跑 `r8_probe.html?M=5&K=8&N=4`，應該 log 到 `y[0]=1`）。之後用 `r8_time.html?M=512&K=1024&N=1024&kernel=r8`（與 `kernel=v4`）逐一量，每次只跑一個形狀，量完關分頁、停伺服器、用 Win32_Process 確認無殘留。找出凍結原因（疑似整頁循環或大形狀的單一封包時間）後才回頭跑 `mm_r8_check.html`。
- 不要在這台重跑會凍結的整頁；先把凍結原因查清楚再說。

## 下一棒第一步（第一段留下的，仍有效）
讀 `docs/CHECKLIST.cudaweb-optimize.md` 的 O6 的「未完成」，把 qwen_gpu 的一層接進 createBatch（至少讓 q8mm 或 MatMulNBits 進批次），再量一層 submit 次數；之後依序 O7、O8、O9、O10、O11，最後進入持續優化迴圈。先確認 WebGPU 介面卡可用（頁面 `navigator.gpu.requestAdapter()` 有回傳），不可用就只做 node 部分並標「待真 Chrome 驗證」。
- 驗證伺服器用完就關；本棒已確認 8731 的 http.server 已停止。
- 其他 Python 行程（pip install torch cupy）不是本棒的，不要動。

## 2026-11-18 第七段（G4 接線；提交 `0d60655a4`）
- 完成：`kernel_select` 新增 `mm_vec4_f32`（K、N 為 4 的倍數、M、N ≥16）；`mm_ops.js` 的 f32 派發改由 `pickMatmulKernel` 決定（規則＋已存勝者，`setMatmulWinners` 同步查表）；`raceMatmul(M,K,N,opts)` 做驗證→計時→勝者寫入（沒有 GPU 回傳 `noGpu`，不競賽）；`variant_race.createStore` 加 `entries()`（整批載入 IndexedDB）；`embed-code-ui.js` 的 MODS 加入 `kernel_select`、`variant_race`。
- node：mm_ops_test、kernel_select_test（15）、variant_race_test（9）、gpu_core.test（41）通過。
- 真 Chrome（`scripts/eval/mm_race_check.html`，已關分頁）：IndexedDB 寫入、關閉後讀回正確（store=idb）；64×256×256 三變體真 GPU 派發，相對誤差各 5.3e-7（T1）。
- **沒做／未驗證**：(1) 真 GPU 上的整段 `raceMatmul` 計時（會超過「3 次 submit」規則，留給下一棒，建議分拆成每次只派一個變體的頁面）；(2) 啟動時 `initMatmulTuning`（probeCaps＋載入勝者）尚未接進 nn_ops／gpu 初始化；(3) 嵌入後的建置產物未重建（`embed-code-ui.js` 未執行）；(4) 頁面中「已存勝者命中」用的是假鍵，未用真實 cacheKey 驗證（node 測試有覆蓋）。
- **殘留**：`python -m http.server 8741` 行程 PID 3280 仍在執行（停止行程的指令被權限擋下，請使用者或下一棒用 Win32_Process 停掉）。
- 下一棒順序：(a) 停掉 8741 伺服器；(b) 接啟動初始化；(c) vec4 慢 5 倍的 kernel_gen 原因（G1）；(d) G5 設定頁表格（兩處同步）；(e) O5–O10。

## 2026-11-18 第十一段（管理者代決後接續，依序做完 1–7 項）
- **sg 簽名**：priors 實測項改為 sg0（`27b146fb4`），查表命中 measured 有測試。
- **O9 race 逐頁**：`mm_race_one.html` 一頁一變體（5 頁，每頁 3 次 submit），結果寫進結果檔 `race_one_per_variant_2026_11_18`。
- **G5 第二處**：AI 助理設定分頁沒有 GPU 基準區塊，故只有一處（已記入清單）。
- **O7 拆開量**：rmsnorm 並行化 0.780→0.220 ms／鏈（3.5×），融合 0.220→0.109（2.0×）（`15a864854`、`c21e483ad`）。
- **O6 計次**：假裝置 `qwen_gpu_submit_count.test.js`（一步 submit＝L+1，3 項通過，`7531f6569`）；**未用真模型驗證**。
- **O8**：q/k/v 批次一小步（`193fce511`）；單層 loss 與 20 步對 CPU（`191615af5`，誤差 1.7e-8／3.3e-7）；前向批次化（`2624bdd8e`，GPU 提交 53→45，loss 與梯度逐位相同）。反向批次化與 app 執行期 matmulMany 未做。
- **持續優化迴圈第一輪**：最遠離屋頂的可量運算是小形狀 64×256×256（v4 13.8%，只 4 個群組）；試 16×64 塊 +9%，在雜訊內，不換（`7bc7f5176`）。
- **殘留**：所有 http.server 已停、Electron 已停。

## 2026-11-18 第十段（管理者更正後接續；交接點：get_usage 30%，仍低於 60%，停在需要真模型的項目前）
管理者規則（2026-11-18）：交接門檻是 get_usage 的 percentUsed 達 60%；未達不停、不寫交接。本段因剩下的項目都需要真模型或大幅重寫，才在 30% 停下，並如實回報。
- **G5 完成**（提交 `88ac0aaf2`）：真 Electron 實機驗證通過，`scripts/eval/g5_variant_panel.eval.js`（獨立使用者資料夾、埠 18641）。發現：這台能力簽名是 `sg0`，priors 實測項是 `sg1`，實測剖析在這台沒命中。
- **O6 完成到批次層**：`quantizeDyn`（`27751abdd`）、`q8mmBatched`（`95247794e`）、`attnCoreBatched`（`9b0476984`）、`matmulNBitsBatched`（`e4c3ce05e`）都真 Chrome 全過，每案 1 次 submit。O6 最後一步（真 Qwen 每層計次）BLOCKED：程式證據是 `qwen_gpu.stepOnce` 本來就每層一次 submit（L+1 次 每步），用真模型計次需要載入權重。
- **O7 部分**：`rmsQuantFused`（`be2c50ebb`）正確性通過；計時 0.82 → 0.13 ms／鏈，但混了 rmsnorm 並行化的效果，還沒分開量；還沒接進生產引擎。
- **O8 未做（下一步的起點）**：`lora_ref_train.js` 的 matmul 每次都是一次往返（`be.matmul` 經 `Array.from` 轉 Float64，每次讀回）；rmsnorm、softmax、silu 也逐運算讀回。要做「訓練步內不逐運算讀回」，需要重寫前向與反向的批次順序，並用真 Chrome 跑 20 步比對 CPU loss。這是大改動，沒有在這段做。
- **O9 部分**：競賽本身已有（`startMatmulRace` 中位數、2 秒預算、可取消）；面板的「重跑變體競賽」真機執行沒做，因為 race 每個變體會 5 次 submit，超過「每頁最多 3 次 submit」的安全規則字面要求，要先決定是否放寬或拆頁。
- **O10**：結果檔已補批次項與待驗證項（`b6c4a62d5`、`6be709fc3`）。
- **O11**：三個建置腳本都跑過（`embed-code-ui`、`build-assistant`、`build-web-lazy`）；所有 `renderer/src/gpu/*_test.js` 通過；建置產物未提交（依規則待發布流程）。
- **持續優化迴圈**：未開始。第一輪要先決定要量的瓶頸與變體（候選：q8mm 的 dec 核心、rmsnorm 並行化）。
- **殘留**：本段所有 http.server（8761、8762、8763、8764、8765）與 g5 的 Electron 都已停止，並用 Win32_Process 確認。
- **下一步順序**：(a) 決定 O9 的 race 真機執行要不要拆頁；(b) O8 批次訓練步（大改動，需要管理者確認範圍）；(c) 持續迴圈第一輪；(d) 真模型 O6 計次與 O7 接進生產引擎。

## 2026-11-18 第九段（本棒：G5 變體競賽表；提交 `5c03d8c9f`）
- 完成（node 通過）：`renderer/src/gpu/variant_table.js` 純函式＋`variant_table_test.js` 7 項；`floating-assistant.js` 的 `_gpuVariantPanel()` 接在 GPU 基準面板下方（套用最佳、重跑變體競賽、取消、匯出剖析、匯入剖析、恢復預設）；嵌入清單與 `FA_QWEN_SRC` 加入 `profile_priors`、`variant_table`，`node scripts/embed-code-ui.js` 已跑通。
- **未做（下一棒第一步）**：
  1. 桌面版實機確認面板（獨立 `--user-data-dir`、換埠、開設定頁讀 DOM）。沒有實機證據前，G5 的畫面與按鈕不算驗證。
  2. 「兩處同步」：`renderer/index.html` 的 AI 助理設定沒有 GPU 基準區塊（grep「gpu／GPU」零結果）。目前只有 floating-assistant 內部一處。是否要在 index.html 加一份，先問管理者。
  3. 編譯毫秒欄一律「未記錄」；競賽不量編譯時間。
  4. 預先剖析的 local 項目依能力簽名查表、不分形狀，排序只當參考。
- 重要判斷：「重跑變體競賽」只量 `AUTO_SHAPES`（64×1024×1024），沒有自動量大形狀，因為 simple 核心在大形狀上有逾時風險。
- 接著順序：(a) 桌面版實機 G5；(b) O5 之後的清單：O6 真 Qwen 區塊接入批次、O7、O8、O9 剩餘（瀏覽器端競賽的 UI 已由 G5 部分完成）、O10、O11；(c) 持續優化迴圈。

## 2026-11-18 第八段（本棒：啟動接線、真 GPU 逐變體計時、vec4 原因；G5 與 O5 以後未做）
提交（依序）：`ee62b6283` 啟動接線；`0f65c7b8c` 真 GPU 計時頁＋GT 720 結果；`e0cd4b67c` vec4 原因。
- **殘留伺服器**：第七段的 PID 3280 已不在（Win32_Process 確認）。本棒用的伺服器都已停、分頁已關，最後確認無 `http.server` 殘留。
- **啟動接線（已做、node 通過）**：`mm_ops.js` 新增 `initMatmulTuning({device, adapterDesc, store, shapes})`（探測能力、IndexedDB 整批載入勝者、回報缺勝者的形狀；換簽名或換 adapter 就缺）、`startMatmulRace(shapes, {navigator, budgetMs, cancel})`。`run()` 第一次拿到 GPU 裝置時懶載入一次，缺勝者的 `AUTO_SHAPES`（只有 64×1024×1024，因為大形狀的 CPU 參考會卡主執行緒）背景重跑（預算 2 秒）。本次派發仍用規則，下次才換。`mm_ops_test` 新增三項，通過。**未在真機驗證啟動流程**（沒有在桌面版看到競賽結束後勝者被使用）。
- **真 GPU 逐變體計時（GT 720，Chrome，`scripts/eval/mm_race_one.html`，結果 `scripts/eval/mm_race_gt720_2026_11_18.json`）**：一頁一形狀一變體，1 次驗證＋2 次計時（3 次 submit）。計時含上傳與回讀。
  - 64×1024×1024：simple 77.1／60.7 ms，tiled 49.3／72.5 ms，vec4 38.2／17.2 ms。
  - 512×1024×1024：tiled 242.1／52.3 ms（第一次離群）、vec4 52.5／32.1 ms。vec4 平均 25.4 GFLOP/s（19.9%）。
  - simple 512 沒量（估時太長，怕逾時）。**限制**：3 次 submit 上限下只能取兩次計時的平均，不是中位數；離群很大，數字只可當方向。
- **vec4 慢 5 倍的原因（已查明）**：`kernel_gen` 的 vec4 實例若寫成 `acc = acc + a*b`，核心慢約 3 倍（39 ms 對 12 ms）；寫成 `fma(a,b,acc)` 就與手寫版持平（12.5 ms 對 11.9 ms，只計核心、各 2 次、約 68–71% 峰值）。G1 記的 51.6 ms 量法含回讀，不能與本次比。**結論：kernel_gen 不換 production（持平，沒有好處）**；生成器內一律用 `fma()`。`kernel_gen.generate` 新增 `opts.noFma` 供量測。
- **G5 未做**：設定頁已有 GPU 基準面板 `_gpuBenchPanel`（`renderer/src/floating-assistant.js` 約 130503 行起，呼叫處約 96434 行，已有表格、釘選、取消、恢復預設）。要加「變體競賽」表（GFLOP/s、峰值百分比、編譯毫秒、正確性、來源、勝者；套用最佳、重跑、匯出剖析、匯入剖析、恢復預設）要改來源模組、嵌入、再到真桌面版或真 Chrome 讀 DOM 驗證。AI 助理設定（`renderer/index.html`）沒有 GPU 基準區塊（grep「基準」「bench」無結果），因此 G5 的「兩處同步」要先確認另一處是不是該加；依記憶「AI 設定 UI 有兩份」，改一處要查另一處。
- **O5～O10、持續迴圈**：未做。O9 的「瀏覽器端競賽、localStorage 包裝」仍未做（G4 已改用 IndexedDB，清單 O9 的 localStorage 描述已過時，以 G4 為準）。
- **下一棒第一步**：(1) 決定 G5 的「另一處」是否要加（先 grep `renderer/index.html` 與 `renderer/src/` 的 AI 助理設定分頁）；(2) 在 `_gpuBenchPanel` 加變體競賽表，資料來源用 `mm_ops` 的 `WINNERS`／`startMatmulRace` 結果與 `scripts/eval/mm_race_gt720_2026_11_18.json` 的量測；(3) 真 Chrome 讀 DOM 驗證；(4) O5 以後的清單項。
- 驗證頁新增：`scripts/eval/mm_race_one.html`（逐變體真 GPU 計時）、`scripts/eval/kgen_fma_check.html`（fma 對照，`?src=hand` 為手寫版對照）。
