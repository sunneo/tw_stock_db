# 交接：GPU 設定集中到「GPU 相容層（numba／cupy／torch）」窗格

目標（管理者 G6 更正、使用者要求）：GPU 相關設定只留在 AI 助理設定 → 「GPU 相容層（numba／cupy／torch）」窗格（註冊於 `ai` 分組，`gpu-compat`）。桌面版設定頁、Configure、模型頁都不放 GPU 開關或 GPU 設定；模型頁只顯示目前狀態。Configure 不留連結。儲存鍵一律不改名，既有使用者的設定原樣保留。

## 盤點（2026-11-18，以 `renderer/src/floating-assistant.js` 與 `renderer/bootstrap.js` 為準）

### A. 已經在 GPU 相容層窗格（`_gpuCompatControls()`，不動）

| 項目 | 儲存鍵 | 位置（行號以盤點時為準） |
|---|---|---|
| 開啟 GPU 相容層 | `advancedSettings.cudaCompat`（on／off） | 96324 |
| float64 處理 | `advancedSettings.cudaCompatFloat64`（auto／f32／exact） | 96336 |
| GPU 加速（預設開） | `advancedSettings.gpuAccel`（on／off） | 96347 |
| 進階：個別路徑強制開啟 | 下列各鍵 | 96352 起 |
| └ 不用 GPU 的 lm_head（NR） | `nrGpuHead` | 96425 |
| └ 不用 GPU 的 lm_head（LLM） | `llmGpuHead` | 96434 |
| └ Qwen3 q8 整段 GPU 解碼 | `qwenGpuDecode` | 96443 |
| └ Qwen3 q4f16 整段 GPU 解碼 | `qwenGpuQ4` | 96452 |
| └ MOSS 語音 | `mossGpu` | 96461 |
| └ MIDI 作曲 | `midiGpu` | 96470 |
| └ Whisper 編碼器 | `whisperGpu` | 96479 |
| └ 音訊分析 | `audioGpu` | 96488 |
| └ 本機生圖 SDXS（GPU 圖形 session） | `sdxsGpu` | 96497 |
| └ Kokoro 語音合成 | `kokoroGpu` | 96506 |
| 裝置自動選擇（自動決定開關的結果） | 讀 `gpuAccel`、`_gpuAutoDec` | 96523 |
| 重新偵測（能力與 GPU 層） | 無（按鈕） | 96516 起 |
| GPU 運算後端基準（表格、重跑、取消、釘選、恢復預設） | `gpuBenchShapes`、`gpuBenchPins`；localStorage `fa_gpu_bench:<env>` | 96512、130590 起 |
| 變體競賽表（套用最佳、重跑、匯出／匯入、恢復預設） | 競賽結果存 `variant_race` 儲存（IndexedDB，記憶體退路） | 96513、130668 起 |

### B. 其他地方的 GPU 設定（需要移動或改成只顯示狀態）

| 位置 | 控制項 | 儲存鍵 | 處理 |
|---|---|---|---|
| 離線模型管理頁（`offline-models` 窗格，約 131104） | 「運算裝置」下拉：GPU（不支援時自動降級成 CPU）／CPU | `advancedSettings.offlineDevicePreference`（'gpu'／'cpu'），寫入點 131454 | **移到 GPU 相容層窗格**（新增「運算裝置（離線模型共用）」下拉，寫同一個鍵）。離線模型頁改成只顯示目前狀態文字。 |
| Whisper（`ai-whisper-device`，約 138285） | 「運算裝置（跟離線模型管理是同一個設定）」：自動／CPU | 寫 `offlineDevicePreference`（'gpu'／'cpu'）**與** `whisperDevicePreference`（'auto'／'cpu'），寫入點 141840 起 | **移除控制項**；窗格的下拉要同樣寫兩個鍵（保留舊行為：選 GPU 時 `whisperDevicePreference` 回到 'auto'）。Whisper 頁改成顯示目前狀態。 |
| 本機生圖（`ai-imgcfg-device`，約 105278） | 「本機小模型用什麼算」：自動／GPU（WebGPU）／CPU | `advancedSettings.imageGen.localDevice`（'auto'／'webgpu'／'cpu'），寫入點 105297（經 `_imageGenSave`） | **移到 GPU 相容層窗格**（新增「本機生圖用什麼算」下拉，寫同一個物件欄位，其餘欄位保留）。生圖頁改成只顯示目前狀態。 |

### C. 不在 GPU 相容層、維持原位（不是 GPU 開關）

- 離線模型的「CPU 核心上限」（`offlineMaxCpuCores`，離線模型頁與 Whisper 的執行緒數）：不是 GPU 設定，維持原位。
- 離線模型各自的模型選擇（`imageToTextModel`、`offlineTextModel`）：維持原位。
- 生圖的 provider、模型（`imageGen.provider`、`imageGen.model`）：維持原位。

### D. 已處理

- 桌面版設定頁的 GPU 相容層整塊：已在 `a251e711c` 移除（`renderer/bootstrap.js` 不再掛 `_gpuCompatControls()`）。桌面版設定頁其他項目（系統匣、關閉縮到系統匣、工作區資料夾）原樣不動。
- Configure：盤點確認沒有 GPU 內容，不留連結（管理者更正）。

### E. 重複檢查結果

- 模型頁的「用 GPU」開關（midiGpu、whisperGpu、sdxsGpu、kokoroGpu、mossGpu、audioGpu、qwenGpuQ4、qwenGpuDecode、nrGpuHead、llmGpuHead）：賦值點只在 `_gpuCompatControls()` 內，**模型頁沒有重複的開關**。
- 裝置偏好：有三處下拉控制同一件事（B 節的三項），這是本次要處理的重複。

## 移動清單（執行順序）

1. [ ] `_gpuCompatControls()` 加兩個下拉：「運算裝置（離線模型共用）」（寫 `offlineDevicePreference`，並同步 `whisperDevicePreference`）、「本機生圖用什麼算」（寫 `imageGen.localDevice`，保留其餘欄位）。
2. [ ] 離線模型管理頁：「運算裝置」下拉改成狀態文字（讀 `offlineDevicePreference`），文案寫「在 AI 助理設定 → GPU 相容層（numba／cupy／torch）窗格修改」。
3. [ ] Whisper 頁：移除 `ai-whisper-device` 下拉，改成狀態文字（同上）。
4. [ ] 本機生圖頁：移除 `ai-imgcfg-device` 下拉，改成狀態文字（同上）。
5. [ ] node 測試：窗格內有 cudaCompat、cudaCompatFloat64、gpuAccel、進階 10 個鍵、兩個新下拉、基準、變體競賽；其他窗格沒有 `offlineDevicePreference`／`imageGen.localDevice` 的寫入。
6. [ ] 真桌面版：桌面版設定頁沒有 GPU 區塊；GPU 相容層窗格內容完整；按鈕能用（重新偵測、重跑變體競賽、新下拉改值後重新讀出）。

## 注意事項

- 儲存鍵不改名。舊設定檔中的 `whisperDevicePreference`、`offlineDevicePreference`、`imageGen.localDevice` 原樣讀取。
- `floating-assistant.js` 是共用檔，另一個工作階段有未提交的修改與已暫存的內容。提交時只提交本次改動的部分，不能整檔提交。
- 建置檔（`renderer/floating-assistant.js`、`.min.js`）由 `build-assistant.js` 從來源產生；桌面版載入的是建置檔，改來源後要重建才會生效。
