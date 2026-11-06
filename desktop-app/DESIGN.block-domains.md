# 多領域 block-writer：領域包（domain pack）

2026-11-06。block-writer 原本只會「競賽式算法題」（`algo_intent_core.js` 的 ALGOS＋`py_paradigms_core.js` 的骨架）。使用者要求擴成多領域：DSP、影像、分散式／平行（含同步）、虛擬化（含記憶體配置）、最佳化／啟發式、資料結構。本檔記領域包格式、怎麼新增領域、現況與待改善。**全部未提交、未發布。**

## 1. 領域包格式（`domain_registry_core.js`，`FaDomains`；Python 專屬）

`make(PAR)` 回傳：

| 欄位 | 內容 |
|---|---|
| `id`／`label` | 領域名稱 |
| `requires` | 相依的領域 id（要先註冊；缺了 `register` 回 `{ok:false}`）。領域間共用積木用這個：例如虛擬化的 best-fit 引用資料結構領域的「平衡樹 lower_bound」 |
| `algos` | `[{key, re}]` 算法種類詞彙；註冊時**插在通用 ALGOS 之前**（領域詞彙較具體，且 key 不可與既有重複） |
| `paradigms` | `{algo: [範式名…]}`，補進 `algo_intent_core.PARADIGMS` |
| `skeletons` | 與 `py_paradigms_core.PARADIGMS` 同格式：`{id, algo, paradigm, label, slots, py(c, N), when?}`；每個 ≤12 組合；`PAR.dsl = {S, O, code}` 是寫骨架的小工具 |
| `judge` | `{checker, eps}`，host 組判題題目時用 `judgeOf(algo)`（DSP＝`float`、1e-4） |
| `snippets` | 領域公開的程式片段，供相依它的領域用 `snippet(領域, 名稱)` 取（**介面已有、尚沒有領域用過**） |

`register(pack, {AI, PAR})`：`AI.addAlgos`、`PAR.addSkeletons`（骨架記 `domain`）。Host：`floating-assistant.js` 的 `_pyDomainsInit()` 在第一次 `_codeOffline` 時註冊；`_codeOffline` 的判題題目依領域補上 checker／eps。嵌入：`scripts/embed-code-ui.js` 的清單＋ `floating-assistant.js` 的 `DOMAINREG`／`DOMAINDSP` 標記。

## 2. 新增一個領域（步驟）

1. `renderer/src/uml/domain_<名>_core.js`（UMD，`make(PAR)` 回傳領域包）；骨架限制同 `DESIGN.ast-nodes.md` 7.3（**骨架不能含 `def`**、不用 `a = b = 0`；用到的槽位值要用 option 的 `v`，不是 id——曾因為把 id 當值而整題失敗）。
2. 讀取器：輸入形狀要是 `algo_intent_core.read` 認得的句型。已支援：`第一行 n k`、`第二行 n 個小數`（浮點清單）、`第二行小數 alpha`／`第二行小數 b0 b1 b2 a1 a2`（浮點純量）、`第三行 m 個小數記為 h`（第二個以上的清單要用「記為／稱為／每個」命名，否則預設都叫 a 會被當成同一個）。新句型加在 `read`，並補 `py_uml_pipeline_core.readInputCNL`。
3. 測試 `domain_<名>.test.js`：種子題（獨立寫的 Python 參考解＋隨機測資＋≥2 筆大的隱藏測資）、原敘述＋換變數名稱的改寫、選項反序（證明靠窮舉不靠排前面）；不給課、0 次模型。登記到 `scripts/run-core-tests.js`、embed 清單與標記。
4. 用 `/teacher-loop` 教課：領域題目走同一個老師迴圈（`_otTeacherLoop`），老師的解答由 `_pyLearnLesson` 抽成課；課可記 `paradigm`。

## 3. 現況

- **領域 1：DSP**（`domain_dsp_core.js`，17 個骨架，`domain_dsp.test.js` 18 題種子）：滑動平均、FIR 線性卷積、DFT 幅度、主頻、自相關、互相關落差、一階 IIR 低通、雙二階 IIR、漢寧／漢明窗、峰值偵測、降／升取樣、RMS、過零、差分、梯形積分、分幀能量。**驗證（我實測）**：36/36 AC（18 題×原敘述／改寫），選項反序 36/36，皆由指定範式解出、不給課、0 次模型、float 容差 1e-4、每題含 2 筆 n≈150～250 的隱藏測資。核心測試 203/203；真 Electron 通用題 `offline-code.eval.js` 仍 20/20（兩種模式）。
- 通用層改動：`algo_intent_core.js` 新增浮點清單／浮點純量讀取、「記為」命名、`addAlgos`；`py_paradigms_core.js` 新增 `addSkeletons`、`dsl`。

## 4. 待改善（如實）

- **其餘五個領域沒做**：影像、分散式／平行（含同步，需要可重用的確定性排程器／交錯窮舉元件）、虛擬化（含記憶體配置）、最佳化／啟發式（隨機演算法要固定種子＋品質門檻判題，判題器目前沒有「品質門檻」checker）、資料結構（含平衡樹，需要「不變量檢查」與隨機操作序列對照的判題）。領域間 `requires`／`snippets` 沒有實際用例，介面可能要調整。
- DSP：只有純 Python（沒有 numpy／scipy.signal 積木；沙盒不保證有 numpy）；複數只能輸出實部虛部兩個詞；沒有 FFT（遞迴 FFT 要 `def`，骨架不能用，目前只有 O(N²) 的 DFT）；浮點判題是「逐詞相對誤差」，沒有整體容差、沒有輸出位數檢查。DSP 領域沒有跑真 Electron 評測（只有 Node 測試），也沒有接 `/teacher-loop` 實測。
- 讀取器只認這幾個固定句型；敘述寫法不同就「程式讀不出」。
- 與矩陣評估的連動只在骨架的 `paradigm` 標記（`matrix-dft`、`matrix-toeplitz`、`state-space`），骨架本身沒有真的用矩陣乘法實作。
