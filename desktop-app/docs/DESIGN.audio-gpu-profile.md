# Demucs 在 WebGPU 圖形引擎上的真機量測（診斷報告）

日期：2026-11-26　範圍：桌面版（Electron）、Demucs 6 軌拆軌、cudaweb GPU 圖形 session

## 結論

1. **GPU 路徑每段約 268 至 278 秒**（7.8 秒音訊），和 WASM 每段約 12.6 秒（暖機）相比，慢約 21 倍。慢是每一段都慢，不是一次性成本。
2. **一次性成本很小**：同一次評測裡，第一段與第二段相差約 3 至 10 秒（見表）。權重上傳與著色器編譯不是主因。
3. **GPU 的拆軌結果數值不對**：取前 4000 點比較，GPU 六軌的最大振幅約 0.0001，WASM 約 0.001 至 0.27（吉他 0.27）。GPU 輸出近乎靜音，不是「慢但正確」。目前 `gpuShare` 與 NaN 檢查都不會攔住這種錯誤。
4. **瓶頸前三（依毫秒）**：MatMul 約 122 秒（約 45%）、Mul 約 43 秒（約 16%）、Add 約 34 秒（約 13%）。Mul、Add、Div、Sub、Erf、Sigmoid 在原始碼裡是 `binop`／`unop`：對每個元素呼叫一次 JavaScript 函式的純 CPU 迴圈（`onnx_interp.js`），**從來不走 GPU**。所以 Mul、Add 的時間是 CPU 元素運算的成本，不是 GPU 分派次數的成本。
5. **根因（正確性）**：GPU 的 1 維卷積（WGSL_CONV1D，`conv_ops.js`）在 Demucs 拆軌形狀上**全部輸出 0**。單獨量 Conv 時，GPU 路徑每個形狀的非零輸出數皆為 0；把「分批派發」關掉（診斷用暫時改動）後，同一批形狀輸出正確，與 CPU 參考的最大誤差約 2.4e-6 至 2.5e-5。所以錯誤在 `nn_ops.js` 的 `runWgsl` 分批派發路徑（扁平索引核心才走），不在卷積數學本身。這同時解釋了 GPU 拆軌的近零輸出（Demucs 的 90 個 Conv 都走這條路）。尚未找到分批路徑中的確切錯誤行，見下方「正確性」。
6. **看門狗 150 秒不是主要問題**：在這台機器每段都約 270 秒，無論 150 秒或放寬，GPU 路徑都比 WASM 慢得多，而且結果不對。看門狗改成暖機後計時不會讓 GPU 路徑變快。
5. **看門狗 150 秒不是主要問題**：在這台機器每段都約 270 秒，無論 150 秒或放寬，GPU 路徑都比 WASM 慢得多，而且結果不對。看門狗改成暖機後計時不會讓 GPU 路徑變快。

## 第二輪：正確性與定位（2026-11-26 續）

### 單一 MatMul（評測 `mm_correct`，1 次）

| 形狀 M×K×N | GPU 首次 | GPU 暖機 | CPU | 與 CPU 最大絕對誤差 | GPU 非零比例 | 路由層 |
|---|---|---|---|---|---|---|
| 64×64×64 | 0.006 秒 | 0.002 秒 | 0.005 秒 | 2.4e-6 | 100% | cpu-simd（未走 GPU） |
| 256×256×256 | 0.010 秒 | 0.007 秒 | 0.047 秒 | 5.2e-6 | 100% | cpu-simd（未走 GPU） |
| 512×512×512 | 0.254 秒 | 0.022 秒 | 0.381 秒 | 2.9e-5 | 100% | T1（GPU） |
| 1024×512×256 | 0.029 秒 | 0.031 秒 | 0.346 秒 | 3.1e-5 | 100% | T1（GPU） |

- 結論：單一 MatMul 的 GPU 核心**正確且快**（暖機 22 至 31 毫秒）。小形狀不走 GPU。
- 所以 Demucs 裡 MatMul 的 122 秒，**不是**單一大矩陣乘的成本。推測是批次矩陣乘（`matmulGpu` 在 `Bb !== 1` 或前導維不一致時退回 CPU 的 `matmulOp`）或大量小形狀落到 CPU。這一點未量到，列為下一步。

### 單一 Conv（評測 `conv_correct` 與 `conv_cpu_check`）

- 第一輪：「CPU 參考」其實也走了 GPU（`ops:false` 時，`conv1d` 的 `ops` 為 `undefined`，仍會先試 GPU），所以兩邊都是 0，這個結果不能當 CPU 參考。
- 第二輪：`conv_cpu_check` 改用 `ops:{gpu:false}`，真的走 CPU 路徑，與獨立 JS 參考的誤差約 1e-6。

| 形狀（C, L, O, k, stride, pad） | GPU 非零 | GPU 與 CPU 最大誤差 | CPU 最大振幅 |
|---|---|---|---|
| 16, 256, 32, 3, 1, 1 | 0／8192 | 8.348（＝全部） | 8.348 |
| 64, 1024, 128, 5, 1, 2 | 0／131072 | 25.468（＝全部） | 25.468 |
| 128, 1024, 256, 3, 2, 1 | 0／131072 | 30.220（＝全部） | 30.220 |

### 分批派發（`runWgsl` 的 chunked 路徑）是卷積輸出 0 的所在

| 設定 | GPU 與 CPU 最大誤差 | GPU 非零 |
|---|---|---|
| 分批開（預設） | 8.348、25.468、30.220（全部） | 0 |
| 分批關（診斷用，暫時改動，已還原） | 2.4e-6、2.5e-5、1.9e-5 | 全部非零 |
| 分批開，但每批一個獨立的參數緩衝（嘗試修正，已還原） | 8.348、25.468、30.220（全部） | 0 |

- 排除了「多批共用一個參數緩衝、寫入順序錯亂」這個假設（改成每批獨立緩衝後仍然全 0）。
- 尚未找到的：分批路徑中是哪一步讓輸出沒寫進去（候選：讀回時機、分批迴圈的 `await`、綁定的緩衝生命週期）。需要在 `runWgsl` 內加逐步診斷才能定位，這一輪沒有時間做。
- 目前源碼已還原（`nn_ops.js` 沒有保留任何未驗證的改動），所以 **GPU 卷積仍是錯的**。

### 逐運算 CPU 元素運算

- `binop`／`unop`（`onnx_interp.js`）：每元素一次 JavaScript 函式呼叫加上索引映射陣列，Mul、Add、Div、Sub、Erf、Sigmoid 全在 CPU。這是 Demucs 中 Mul、Add 時間高的原因（與 GPU 分派次數無關）。
- 可改進方向（未做）：這些運算改用 WGSL 逐元素核心，或至少把索引映射快取。

### 旗標的存放位置（已查明）

- `localStorage` 不是 Chromium 的一般 localStorage：`preload.js`、`main.js` 把 `window.localStorage` 換成代理，寫入 `<工作資料夾>\.floating-assistant\localStorage.json`。
- 開發模式（`electron .`）的工作資料夾 = 啟動時的 `cwd`。評測的 `cwd` 是 worktree 的 `desktop-app`，這個資料夾沒有 `.floating-assistant`，所以應用程式落到使用者家目錄：`C:\Users\sunneo\.floating-assistant\localStorage.json`。
- 那個檔案裡 `audioGpuSlow:demucs-6s` 的時間戳 `1795670007780`，與舊檔評測第 2 次執行的時間吻合，代表**我的評測寫進了使用者家目錄的工作資料**。
- 基底 checkout 的 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\.floating-assistant\localStorage.json` 有另一個 `audioGpuSlow` 旗標（時間戳 `1795612178630`，早於本次量測），是該資料夾的開發設定。
- 我沒有修改、也沒有清除任何上述檔案。要還原需要使用者決定。
- 之後的評測仍會讀寫家目錄的工作資料（因為 `cwd` 不在被認可的位置）。若要隔離，需要改評測的 `cwd` 或使用者決定。

## 量測條件

- GPU：adapter vendor `nvidia`、architecture `kepler`（系統自報，未核對）。
- limits：maxComputeInvocationsPerWorkgroup 1024、maxStorageBufferBindingSize 2147483644、maxComputeWorkgroupSizeX 1024、maxBufferSize 2147483648。
- features：`subgroups`，**沒有 shader-f16**。
- 樣本：`C:/Users/sunneo/Desktop/midi音樂/GrandfatherClock.mp3` 第 20 秒起 7.8 秒（單聲道取左聲道，另有右聲道）。
- 評測檔（worktree 內，未發布）：
  - `desktop-app/scripts/eval/audio_gpu_profile2.eval.js`：GPU 整段，看門狗只在記憶體內放寬到 1e9 毫秒，逐運算計時。
  - `desktop-app/scripts/eval/audio_wasm_profile.eval.js`：同樣本，gpuAccel 關閉，走 onnxruntime-web wasm。
  - 舊檔 `audio_gpu_profile.eval.js`：第一輪，看門狗未放寬。

## 量測鉤子（新增，預設關）

`renderer/src/gpu/onnx_interp.js` 的 `runNodes`：當 `globalThis.__FA_OP_TIMING` 有值時，依運算類型累計次數與毫秒；沒設時不做任何計時，正常路徑不變。

## 評測次數與結果

| 評測 | 次數 | 結果 |
|---|---|---|
| 舊檔 `audio_gpu_profile` | 2 | 第 1 次 GPU 被舊的「太慢」旗標略過，兩段 16.3 與 12.8 秒是退回路徑。第 2 次 GPU 第一段 254.4 秒（看門狗觸發），第二段 22.7 秒（WASM）。 |
| `audio_gpu_profile2`（GPU 整段） | 2 | 第 1 次 runner 500 秒逾時，GPU 第一段 270.5 秒、第二段未完成（逾時）。第 2 次（runner 放寬到 900 秒）：第 1 段 278.1 秒，第 2 段 267.6 秒。 |
| `audio_wasm_profile`（WASM） | 1 | 第 1 段 15.3 秒，第 2 段 12.6 秒（暖機）。 |

- 兩次 GPU 整段的第 1 段（270.5 與 278.1）與第 2 段（267.6）都在約 270 秒的範圍，跨次一致。
- 未出現裝置遺失或畫面變黑的回報。
- 每次評測結束後檢查：殘留 electron 行程 0 個。

## GPU 逐運算計時（整段，第 2 次評測，兩段一致）

| 運算 | 次數 | 毫秒（第 1 段） | 毫秒（第 2 段） |
|---|---|---|---|
| MatMul | 68 | 127,875 | 121,622 |
| Mul | 353 | 42,310 | 43,002 |
| Add | 605 | 34,136 | 34,439 |
| Erf | 56 | 17,201 | 17,034 |
| Softmax | 10 | 9,501 | 9,002 |
| Conv | 90 | 9,460 | 8,786 |
| Div | 82 | 6,367 | 6,327 |
| Sigmoid | 48 | 6,374 | 6,524 |
| Transpose | 116 | 3,143 | 2,728 |
| Pad | 7 | 2,937 | 2,659 |
| InstanceNormalization | 74 | 2,898 | 2,642 |
| Range | 697 | 2,689 | 2,725 |

- 合計約 260 秒，與牆鐘約 270 秒接近（差額是讀寫與其他開銷）。
- 上表的毫秒是該運算類型的時間加總，包含在運算內的上傳與讀回（若有），但不區分細項。

## 數值比對（GPU 對 WASM，前 4000 點）

| 軌 | GPU 最大振幅 | WASM 最大振幅 | 最大絕對差 |
|---|---|---|---|
| drums | 0.0001 | 0.0017 | 0.00165 |
| bass | 0.0001 | 0.0024 | 0.00234 |
| other | 0.0001 | 0.0010 | 0.00111 |
| vocals | 0.0001 | 0.0021 | 0.00200 |
| guitar | 0.0001 | 0.2684 | 0.2685 |
| piano | 0.0001 | 0.0012 | 0.00121 |

- 只比了前 4000 點（約 90 毫秒），樣本數少，不能當作完整誤差。
- 但 GPU 的振幅在所有軌都接近 0，與 WASM 差了一到三個數量級，這不是浮點誤差，是輸出錯誤。
- 需要的後續量測：全段比較、各層輸出的數值對照，找出是哪一層開始偏離。

## 三條路徑比較

| 路徑 | 第 1 段 | 第 2 段（暖機） | 數值 |
|---|---|---|---|
| cudaweb GPU 圖形引擎 | 278.1 秒 | 267.6 秒 | 不正確（振幅近 0） |
| onnxruntime-web WASM | 15.3 秒 | 12.6 秒 | 基準 |
| onnxruntime-web webgpu | **未量測** | — | — |

- ort webgpu 未量：`_audioLoadSeparator` 沒有公開 ort 物件給評測使用，需要另外取得入口，本次未做。這是未完成的項目。

## 看門狗（第 3 項）

- 程式：`renderer/src/floating-assistant.js` 的 `_audioGpuSession`，整段 150 秒計時，超時寫入 `audioGpuSlow:<模型id>` 旗標並永久停用直到重置。
- 量測：每段都約 270 秒，150 秒會每次都觸發，但放寬後 GPU 結果依然比 WASM 慢 21 倍、數值也錯。
- 因此看門狗不是瓶頸，不應把它放寬當作修正。在 GPU 結果正確、速度接近 WASM 之前，建議保留 GPU 路徑關閉（Demucs 在這台機器用 WASM）。

## 副作用與注意事項（必讀）

- 旗標位置（已查明，見第二輪）：不在 `--user-data-dir` 的 localStorage，而在工作資料夾的 `.floating-assistant\localStorage.json`。評測落到使用者家目錄的那個檔，所以評測確實動到了使用者的工作資料。
- 旗標時間戳在舊檔第 2 次執行時被更新（看門狗真的觸發寫入）。這是應用程式的寫入行為，不是評測直接寫入。
- 我沒有清除該旗標，因為可能影響使用者的實際設定。若要還原，需要先確認它的實際存放位置，並由使用者決定。
- 評測中在記憶體內忽略或放寬看門狗、忽略旗標，都只影響該次執行，沒有寫入儲存空間。

## 修正

- 本次沒有修正 GPU 路徑。
- 唯一的來源改動是 `onnx_interp.js` 的量測鉤子（預設關，不改變正常路徑）。

## 尚未做的建議

1. 找出 GPU 輸出錯誤的起點：逐層比對（GPU 與 WASM 的同一個中間張量），找出第一個偏離的運算。這比速度更優先。
2. 用微基準（單一 MatMul 形狀）量 WGSL 核心與 ort webgpu 在相同形狀上的時間，判斷 MatMul 的瓶頸是 tile 大小、工作群組或讀回。
3. 檢查 Mul 與 Add 單次約 100 毫秒是否來自每次運算的分派、讀回或 CPU 退層（需要 tiers 的實際路由資料）。
4. 量 ort webgpu 路徑（需要取得 ort 物件的入口）。
5. 在 GPU 結果正確之前，不建議移除 WASM 後備或放寬看門狗。
6. shader-f16 不存在，f16 路線不可行，不應列入短期方案。

## 仍是推測的部分

- adapter 的 `kepler` 世代是系統自報，未核對。
- Mul 與 Add 的每次約 100 毫秒是分派或讀回開銷，是推測。
- 數值差異只看了前 4000 點，全段誤差未量。
- 旗標存放位置未查明。
