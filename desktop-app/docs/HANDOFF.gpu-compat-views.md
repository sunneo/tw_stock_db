# 交接：GPU 相容層窗格的簡易檢視／專業檢視與 Profile

## 現況（2026-11-18）：完成，已用真桌面版驗證

- 檢視規則：`faGpuCompatView(engineering, pref)`（`renderer/src/floating-assistant.js` 的 GPUVIEW 區段）。工程模式沒打勾一律簡易；打勾後依 `advancedSettings.gpuCompatView`（simple／pro）；壞值或讀取失敗退回簡易。
- 區塊編號（DOM 屬性 `data-gpu-block`）：簡易＝summary、quick、switches；專業＝簡易加 float64、matmulKernel、cpuShare、advanced、kernelTune。專業是全部內容。
- 切換列在窗格頂端（`#ai-gpu-compat-viewbar`），只有工程模式打勾才顯示；`_gpuCompatApplyView` 在每次 `_renderAdvancedSettings` 後重套。
- Profile（簡易檢視核心，`_gpuProfileRun`）：變體競賽（`startMatmulRace`，自帶量測互斥鎖）→ GPU 端對端計時（鎖內）→ CPU 池計時（`cpu_share.runCpuOnly`）→ `faProfilePlan`（`faProfileFit` 擬合固定成本與速率；卸載交界點；`hetero_split.decideSplit` 的分攤決策）→ 速率存 `hetero_rates`（IndexedDB）、結論存 localStorage `fa_gpu_profile`。沒有 WebGPU 只量 CPU。
- `scripts/embed-code-ui.js` 多暴露 `hetero`、`heteroRates`、`heteroIdb` 給設定頁用，發布前要重新 embed。

## 測試
- `scripts/gpu_compat_view.test.js`（21 項）、`scripts/gpu_profile_plan.test.js`（18 項）。
- 真桌面版評估：`scripts/eval/gpu-compat-view.eval.js`、`scripts/eval/gpu-compat-profile.eval.js`（獨立 user-data-dir、換埠 18777、`FA_DISABLE_MAIN_OVERLAY=1`、預先寫 main-ext-rev.txt）。結果：工程模式關閉只有簡易區塊且切換列隱藏；打勾後切換列出現，專業檢視六個專業區塊全顯示（含變體競賽表、基準表、float64、CPU 分擔、運算變體）；Profile 一次約 3 秒跑完，量測鎖結束後釋放，結論「GPU 比 CPU 快約 39 倍（GPU 41、CPU 1 GFLOP/s，最快核心 mm_tiled_f32）」；獨立再量 CPU 為 1.01 GFLOP/s，與結論一致。

## 沒做／沒查
- 存進 `hetero_rates` 的速率目前沒有任何執行路徑讀回來用（`cpu_share` 的 rateStore 沒接線，那是 CPU 矩陣乘那條線的範圍，我沒動）。
- 那次 GPU 41 GFLOP/s 是不是軟體模擬的 WebGPU，我沒查；真 GPU 機器上的數字沒量過。
- 簡易檢視的「後端狀態」要按「重新偵測」或 Profile 才會更新（開窗格時不主動建立 WebGPU 執行期）。
