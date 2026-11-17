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
