# 交接：終端機 python／內建範例／selftest（2026-11-20 起）

**接手者請先讀**：`DESIGN.run-terminal.md` 最後幾段（v502–v512）。目前最新發版是 **v512**（desktop-app `92b067cda`，網頁版已釘 `92b067cd`，main `a63876c2b`）。

## 使用者要求（原話摘要，2026-11-20）
內建範例（`renderer/src/examples/python/gpgpu/nbody3d.py`、`fluid3d.py`、`swap_stream.py`、`llc/gpgpu/nbody3d_cl.ll`）必須在手機終端機開箱即用；卡住或沒輸出是我們的缺陷。使用者極度不耐煩被中斷，**不要問、歧義自決、做完才回報**。

## 已完成（可以信任的部分）
- 看門狗與各階段硬上限已移除（v512）；指令只會被 Ctrl-C 中斷。
- `llo` 這類不存在的指令立即回 `command not found`（v510–v511，busybox applet 清單由 `scripts/gen-busybox-applets.js` 從 wasm 生成）。
- 掛載清單改背景快取（v510）；`_refreshTerminalFapLabels` 不再每個指令 await IndexedDB（v512）——這是 FAP 15 秒的根因。
- **Pyodide 實跑（node，`pyodide@0.27.7`，暫存目錄 `scratchpad/pyodide_run/run.mjs`，不在 repo）**：
  - `nbody3d.py --bench 256` → 通過（CPU 1.0 ms/步，退出碼 0）。
  - `fluid3d.py --bench` → 通過（CPU 24 ms/步）。
  - `swap_stream.py` → `ModuleNotFoundError: fa_swap`（它依賴 App 注入的模組，非標準套件）。
  - 注意：runner 必須把 `SystemExit` 當退出碼處理（範例 `sys.exit(main())`）。
- nbody3d 的 numba 是可選的（`cuda = None` 時退回 CPU），`--bench` 在 Pyodide 裡可跑。

## 未完成（依使用者指定順序）
1. ~~**`selftest examples`**~~ **（v513 已完成，模擬＋node Pyodide 驗證）**：無視窗模式（`--bench` 小 N）＋ lli 範例；每項有逾時與進度；印通過／失敗／原因／耗時；支援 `selftest examples nbody3d` 單項。
   - `fa_swap`（v513 已注入：`renderer/src/pybridge/fa_swap.py` 寫入 Pyodide 的 `/fa_terminal` 並加入 sys.path；沒有 fa_bridge 時退回記憶體後端）。原本只在技能包執行或 Worker 路徑注入，主執行緒的終端機 python 沒有。（`grep -n fa_swap renderer/src`），讓終端機的 python 也能 import；找不到就在 selftest 標明「缺 fa_swap」並做最小版本。
2. **視窗式範例**（nbody3d 預設、fluid3d 互動模式）：「視窗已開啟」狀態提示（「按 Ctrl-C 或關閉視窗結束」）；手機觸控驗證。**無法在模擬中驗到手機觸控**，寫成待使用者確認。
3. **numpy 與內建套件離線化**：目前 numpy 由 Pyodide 從 jsDelivr 現場下載（`loadPackage`）。要做：wheel 用 Cache API 快取、下載有進度、失敗重試、設定頁「從檔案匯入」。
4. **python Worker 路徑進度與 micropip 逐包進度**：`_terminalRunPythonWorker`（約 `floating-assistant.js` 118753）在 Worker 裡自己載入 Pyodide，進度沒有回報到終端機；`_terminalTryPythonAsync` 只在 `needsAsync` 時走 Worker。
5. **A（IndexedDB 慢的根因）**：diag 已有「IndexedDB 開啟」耗時欄位（v512，`_listAllFapAccessPoints` 的 `openMs`），但需要手機上的數字。已知 `_ensureTerminalFsStore` 的「檔案系統初始化 5193ms」在 v509 之前出現；v510 之後指令路徑不等 IndexedDB，應該已消失——**需用手機 diag 確認**。
6. **C（diag）**：python（Pyodide）狀態目前只看主執行緒的 `_pyodideInstance`，Worker 裡載入的套件（numpy、micropip）不會反映，要讓 Worker 回報狀態。「最後一次輸出」與「檔案系統初始化」耗時已在 v512 的 diag（`_terminalDiagText`）。
7. **C 版下載狀態區（設定頁）**：每個資源一行（狀態、大小、進度），控制項只有「下載／重試」「清除快取」「從檔案匯入」。目前設定頁仍有舊的來源下拉與自訂網址（v504），要精簡。

## 注意事項
- **網頁版 SHA 釘點**流程見 `scratchpad` 的 python worktree 腳本（或 `/tmp/claude-1001/qwen/pub.sh`）：改 `origin/main` 的 `web/index.html` 與 `web/aiweb/index.html` 的 `SHA = '…'`／`@<sha>/desktop-app`，同時更新頁面 `web-build-tag`。釘版前先 curl 檢查 `web-lazy/core.js` 回 200（jsDelivr 偶爾回 403，重試即可）。
- **版本標記**：`renderer/src/floating-assistant.js` 的 `_terminalBuildTag()`，每次發版手動改。
- **測試**：`renderer/src/terminal/terminal_{progress,hang,input,fastpath}.test.js`，逐一 `node` 執行，`terminal_hang` 只剩 7 項。

## 不要做
- 不要把看門狗加回來（使用者明確拒絕）。
- 不要在指令路徑上 await IndexedDB 或 PyPI。
- 不要編造真機結果；「模擬通過」與「待手機確認」必須分開列。
