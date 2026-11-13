# 工作室六種新型別：真實桌面版實測（2026-11-13）

分支 `desktop-app`，工作目錄 `desktop-app/`。只驗證，未修改產品程式。

## 結論（先看這裡）

- **六種型別在真實桌面版裡，使用者無法把型別選成功。** 選了「語音合成」等型別後，下拉選單會被重畫回「語言模型」，輸出選項也一樣。原因是工作室視窗是沙盒 iframe（沒有 `allow-same-origin`），`localStorage` 會丟 `SecurityError`，而模型類型函式把錯誤吞掉、讀回預設值。這是**阻擋性缺陷**（D1）。
- 為了繼續測「按開始」，我在工作室 iframe 內把 `window.localStorage` 換成記憶體版本（測試墊片，不是產品修正）。之後的所有型別操作都在這個墊片下進行。**在沒有墊片的產品版本上，六種型別的按鈕都還不能被實際選到。**
- 六種型別的「按開始」都用真的滑鼠事件點擊。下拉選單的原生 popup 送不進 CDP 的點擊與按鍵，所以型別選擇用 `select` 的 `value` 加上 `change` 事件（與使用者選取走同一個 `onchange`）。
- 按開始後，作曲、語音辨識、語音合成、音訊轉音符都跑完，輸出資料夾存在，結果區顯示「完成。輸出在：…」。看圖說文字與圖像生成按停止可取消。
- 另外發現兩個缺陷：不可用的輸出仍可開始訓練（D2）；Python 路徑不存在時，錯誤訊息說是「缺套件」（D3）。

## 環境與方法

- 真實 Electron 桌面版：`desktop-app/` 下 `node_modules/electron`，以 `xvfb-run -a` 啟動，獨立使用者資料夾 `~/fa-work/studio-live/ud`，`--remote-debugging-port=9555`。`desktop-settings.json` 設 `execEnabled:true, execConfirmRequired:false`，與既有探測相同。
- 驅動：Node 22 內建 WebSocket 連 CDP。點擊用 `Input.dispatchMouseEvent`，文字輸入用 `Input.insertText`，讀取用 DOM。工作室 iframe 是獨立的 CDP target（`type: iframe`），分開連線。
- 先執行 `node scripts/embed-code-ui.js` 與 `node build-assistant.js`（已授權）。產生的內嵌程式碼與原本相同，只有 `renderer/update-manifest.json` 的 `generatedAt` 不同（未 commit，見下方「副作用」）。
- 應用程式啟動時跳出「發現新版本」視窗（遠端 399，會更新 `renderer/floating-assistant.js`、`renderer/floating-assistant.min.js`、`main-ext.js`）。**我按了「取消」，沒有套用遠端更新。**
- 主機上另有兩個 Electron 實例（`jolly-pike-54970d` worktree 與 `fa/round3/ud-native`）。我沒有碰它們。我的實例已在測試後關閉。
- 訓練所需的基底模型與資料都來自 `~/fa-work/` 既有檔案。每次執行都另外指定輸出名稱，沒有覆寫。

### 測試用墊片與變通（全部列出）

| 項目 | 原因 | 影響 |
|---|---|---|
| 工作室 iframe 內把 `window.localStorage` 換成記憶體版本 | D1：沙盒內 `localStorage` 會丟 `SecurityError` | 測試的型別／輸出選擇靠這個墊片才能保留。產品版本沒有這個墊片。 |
| 型別下拉用 `select.value`＋`change` 事件設定 | 原生 popup 無法用 CDP 點擊或按鍵 | 與使用者選取走同一個 `onchange` handler，但不是真正的 popup 點擊 |
| 音訊轉音符用包裝腳本 `~/fa-work/studio-live/py-a2n` | 本機沒有任何 Python 同時有 `onnx2torch` 與 `onnx`。我把 `onnx` 與 `onnx2torch` 裝到 `~/fa-work/studio-live/a2n-deps`，包裝腳本設 `PYTHONPATH` 後轉給 `fa-work/venv` | 只影響 a2n 的成功路徑。自動偵測的 Python 失敗訊息是真實的（見 (4)）。 |
| 「已停止」與「缺套件」的結束判斷 | 測試驅動的 regex 一開始漏掉「缺套件」，程式跑到逾時才停 | 只影響測試腳本，不影響產品 |

## (1) 設定頁「顯示半成品的功能」

- 開關前：工作室型別清單 8 項：語言模型、離線訓練器、語音合成、音樂作曲、語音辨識、音訊轉音符、圖像生成、看圖說文字。
- 開關後（勾選、完成、重新開啟工作室）：同樣 8 項。
- `model_types_core.js` 的 `listFor(false)` 與 `listFor(true)` 都是這 8 項，且 8 項的 `status` 全部是 `done`（我用 `node` 直接呼叫確認）。所以目前沒有半成品或只有設計的型別，開關不改變清單。與 `model_types_core.js` 一致。
- 證據：`01-settings-half-off.png`、`02-settings-half-on.png`、`03-studio-half-on-8-types.png`。

## (2) 六種型別：選型別、選輸出、不可用原因、限制文字

「輸出」是 `select` 旁的兩個按鈕（卡片內按鈕，依序為 LoRA 與完整模型）。"disabled" 表示按鈕停用，hover 的 `title` 是原因。

| 型別 | LoRA 輸出 | 完整模型輸出 | 不可用原因（畫面上的文字） | 限制文字（畫面上 `.todo` 區塊） |
|---|---|---|---|---|
| 語音合成 | 可用（風格偏移小檔） | 停用 | 沒有整個語音合成模型的微調與匯出路徑 | 只看留出句的損失，沒有主觀聆聽評分；訓練資料是基底模型自己合成的音訊；風格偏移只有 256 個數字 |
| 音樂作曲 | 停用 | 可用（權重與設定） | 這個類型訓練的是從零開始的小型模型，不產生 LoRA 小檔 | 只在程式作曲的資料上驗證，沒有和真實作曲比較過音樂品質；輸出還沒進工作室資產；作曲流程不會換用訓練出的模型 |
| 語音辨識 | 可用 | 停用 | 還沒有把 LoRA 併回基底的匯出路徑 | **字錯率沒有下降**；LoRA 還沒接進應用程式的聽寫流程；輸出還沒進工作室資產 |
| 音訊轉音符 | 停用 | 可用（ONNX） | 這個類型微調的是整個轉譜模型，不產生 LoRA 小檔 | 只有合成資料；沒有真實錄音驗證；還沒接進應用程式 |
| 圖像生成 | 可用（SDXS LoRA） | 停用 | 還沒有 SDXS 的完整模型匯出路徑 | 只用合成資料，沒有人工評量；LoRA 還沒接進網頁或桌面的 ONNX 生圖執行環境（未驗證） |
| 看圖說文字 | 可用 | 停用 | 還沒有併回基底的匯出路徑接進工作室 | 只有合成資料，題型很單純；只評量顏色與形狀；沒有人工評量 |

- 不可用輸出的原因與介面一致。`model_types_core.js` 的 `reason` 字串在畫面上逐字顯示。
- 選到不可用輸出時，畫面會顯示「⚠️「LoRA 小檔」目前不能輸出：…請改選其他輸出。」。證據：`06-music-lora-unavailable-reason.png`。
- 限制文字在選型別後就顯示，「開始」前能看到。`ASR` 的「字錯率沒有下降」與音樂、音訊轉音符的「只在合成資料上驗證」都有寫。
- 型別與輸出的截圖：`04`（D1 證據，未加墊片時選語音合成，畫面仍是語言模型）、`05`、`07`–`10`。

## (3) 按「開始訓練」實測

所有開始與停止都是真的滑鼠點擊。數值輸入是 `Input.insertText`。

| 型別 | 輸出 | 步數 | Python | 結果 | 證據 |
|---|---|---|---|---|---|
| 音樂作曲 | LoRA（不可用，見 D2） | 20 | 留空（自動 → `python3.11`） | 進度出現（產生資料 → 訓練 → 重新載入核對）；12 秒完成；「完成。輸出在：…/music/music-a-1（還沒收進工作室資產）」；`model.pt` 2,269,569 bytes、`vocab.json`、`config.json`、取樣檔存在 | `11-music-run-finished.png`；`music-a-1-ext_job.json`、`music-a-1-train_meta.json` |
| 語音辨識 | LoRA | 5 | 留空（自動 → `python3.11`） | 進度出現（訓練 → 核對）；18 秒完成；訊息含「驗證集的字錯率沒有下降（實測 15.81%→15.81%）」；`adapter/`、`hyp_*.json` 存在 | `12-asr-run-finished.png` |
| 語音合成 | 風格偏移（LoRA） | 2 | `~/fa-work/speech-train-20261113-1942/venv/bin/python`（手動指定） | 進度出現（訓練風格偏移 → 合成一句核對）；24 秒完成；`voice_trained.bin` 522,240 bytes、`delta.pt`、`check.wav` 存在 | `13-tts-run-finished.png`；`tts-live-1-summary.json` |
| 音訊轉音符 | 完整模型（ONNX） | 5 | `py-a2n` 包裝（見上） | 進度出現（產生資料 → 微調 → 匯出 → 重新載入核對）；6 秒完成；`model.onnx`、`train_meta.json`、`pred_*` 存在 | `14-a2n-run-finished.png`；`a2n-live-2-train_meta.json` |
| 圖像生成 | LoRA | 40（僅啟動） | `~/fa-work/sdxs-lora/venv/bin/python` | 按開始後 2 秒內出現進度「執行中：訓練圖像 LoRA；已跑 2 秒」；約 8 秒後按停止；約 3 秒後顯示「已停止：使用者停止（停在「訓練圖像 LoRA」）」 | `15-image-stopped.png`；`image-ss.log` |
| 看圖說文字 | LoRA | 300（僅啟動） | `~/fa-work/vlm-studio/vlmenv/bin/python` | 進度出現（「訓練看圖 LoRA」，步數 1，損失 8.4994）；約 10 秒後按停止，「要求停止中…」，約 2 秒後「已停止：使用者停止（停在「訓練看圖 LoRA（含合成資料）」）」；停止後無殘留行程 | `16-vision-stopped.png`；`vision-ss.log` |

注意：
- 音樂作曲的進度列在完成時只顯示「步數 1」（訓練腳本只記錄一次 step 行）。20 步的 run 看不出總步數。這是觀察，不是錯誤。
- 語音辨識與音訊轉音符的訊息一開始就顯示限制（字錯率、只用合成資料）。

## (4) 失敗路徑

| 情境 | 畫面訊息（逐字） | 判斷 |
|---|---|---|
| 語音合成，Python 留空（自動） | 訓練環境缺套件：kokoro、soundfile | 清楚，指名套件。`17-tts-missing-packages-auto-python.png` |
| 音訊轉音符，Python 留空（自動） | 失敗：步驟「微調轉譜模型」失敗：缺少 Python 套件「onnx2torch」。請在訓練環境安裝它後再試。 | 清楚，指名步驟與套件（由 `ext_job_core.js` 翻譯） |
| 語音辨識，資料格式錯（`bad-sr.jsonl` 第 1 行缺 `text`，第 2 行不是 JSON） | 語音資料格式不對：第 1 行缺 audio（錄音相對路徑）或 text（參考文字） | 清楚。`18-asr-bad-data-format.png`；檔案在 `~/fa-work/studio-live/bad-sr.jsonl` |
| 語音辨識，Python 指向不存在的路徑 `/home/hungfu.lee/fa-work/no-such-venv/bin/python` | **訓練環境缺套件：torch、transformers、peft** | **誤導**：真正原因是 Python 路徑不存在（D3） |
| 輸出名稱重複（音訊轉音符第一次失敗後的資料夾再用同名） | 輸出資料夾已有內容（換一個名稱，不覆寫） | 清楚，且符合「不覆寫」的設計 |
| 輸出名稱空白 | 名稱不合法（英數、中文、點、底線、連字號，最長 64 字） | 清楚 |
| 停止 | 已停止：使用者停止（停在「…」） | 清楚 |

## 缺陷

### D1（阻擋）：沙盒 iframe 讓型別與輸出選擇無法保留

- 現象：在真實桌面版選「語音合成」後，下拉與面板被重畫回「語言模型」；輸出按鈕也回到預設。證據：`04-defect-type-reverts-to-llm.png`。在 iframe 內 `localStorage.getItem` 實測拋出 `SecurityError: Failed to read the 'localStorage' property from 'Window': The document is sandboxed and lacks the 'allow-same-origin' flag.`。
- 原因：
  - `renderer/src/floating-assistant.js:94445`（`_wgBuildStudio`）的 `iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals')` 沒有 `allow-same-origin`。
  - `renderer/src/studio/studio-viewer.template.html:492–496`（`mtGet`／`mtSet`／`mtOut`／`mtOutSet`）用 `try { localStorage… } catch(e){}` 吞掉錯誤。讀取失敗時回 `'llm'`／`'lora'`。
  - 同一份模板已嵌入 `renderer/src/floating-assistant.js`（`FA_STUDIO_VIEWER_HTML`）與 `renderer/floating-assistant.min.js`，所以問題在三個地方都存在。
- 建議（不改，由作者決定）：把型別與輸出的狀態存到主行程（經 mock 伺服器的 `/api/prefs`），或在沙盒內用記憶體後備。若要用 `allow-same-origin`，要先評估安全性。
- 重現：見 `test-reports/studio-six-live/studio.js`（`setType`）。未加墊片時，`setType('music')` 之後 `select.value` 仍是 `llm`。

### D2（中）：不可用的輸出仍然可以開始訓練

- 現象：音樂作曲預設輸出為 LoRA（不可用）。畫面顯示「⚠️「LoRA 小檔」目前不能輸出…請改選其他輸出。」，但「開始訓練」仍可按。按下後任務正常執行並完成（`music-a-1`）。
- 證據：`ext_request.json` 只帶 `type`、`name`、`params`、`python`、`paths`，**沒有輸出欄位**，主行程無法檢查輸出是否可用。
- 位置：`renderer/src/studio/studio-viewer.template.html:535`（`bGo.onclick`）沒有呼叫 `mtGuard(t)`。`mtStartBtn`（非外部型別）才有守門。
- 建議：外部型別的開始按鈕也要用 `mtGuard`，且請求要帶 `outputId`。

### D3（中）：Python 路徑不存在時，錯誤訊息說是「缺套件」

- 現象：語音辨識，Python 指向不存在的路徑，畫面只顯示「訓練環境缺套件：torch、transformers、peft」。
- 原因：
  - `renderer/src/studio/studio_host.js:268`（`extPython`）直接回傳使用者指定的路徑，不檢查存在。
  - `renderer/src/studio/studio_host.js:273–277`（`extModules`）把 `spawn` 錯誤（ENOENT）當成「缺模組」。
  - `studio_host.js:288` 把它組成「訓練環境缺套件」。
- 建議：在 `extCheck` 先確認 Python 存在；不存在時回「找不到訓練用的 Python 路徑：…」。

### 觀察（非缺陷）

- 進度列的「步數」只反映訓練腳本的 step 行，短的 run 只顯示「步數 1」。
- 失敗的 run 會留下部分輸出資料夾（例如 `a2n-live-1` 只有 `train_data`、`eval_data`）。之後用同名會得到「輸出資料夾已有內容」。訊息清楚，但使用者可能需要手動清理。
- 本機沒有任何 Python 同時有 `onnx2torch`、`onnx`、`onnxruntime`。音訊轉音符在本機只能靠自動偵測失敗（見 (4)）或包裝腳本。

## 未做／未驗證

- 型別下拉的原生 popup 點擊未實測（見上方「測試用墊片與變通」）。
- 圖像生成與看圖說文字只做到「開始→進度→停止」，沒有等跑完（依指示）。
- 音訊轉音符的成功 run 需要包裝腳本（`PYTHONPATH` 指向 `a2n-deps`）。在作者的一般環境應該要有 `onnx2torch`。
- 輸出沒有進工作室資產（與介面說明一致，是既有限制）。
- 沒有測試網頁版（web-train）路徑。

## 副作用

- `renderer/update-manifest.json`：`node build-assistant.js` 重新產生，只改了 `generatedAt`。**未 commit**。
- 沒有套用遠端更新（已取消）。
- 我的 Electron 實例與 `~/fa-work/studio-live/` 下的輸出仍在（已關閉行程）。其他實例未受影響。

## 證據檔案（`test-reports/studio-six-live/`）

- 截圖 `01`–`19`：設定、型別、按開始後、失敗訊息、停止。
- 記錄：`electron-main.log`、`sr-bad.log`、`sr-nopy.log`、`a2n-auto.log`、`a2n-venv.log`、`tts-venv.log`、`image-ss.log`、`vision-ss.log`。
- 執行資料：`music-a-1-*.json`、`tts-live-1-summary.json`、`a2n-live-2-train_meta.json`、`asr-live-1-train_meta.json`。
- 驅動腳本：`cdp.js`、`studio.js`、`run-ext.js`、`gaps.js`。
