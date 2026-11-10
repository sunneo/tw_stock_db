# lora-train：離線模型（Qwen3-0.6B）的 LoRA 訓練

## 用途

讓 app 內的離線小模型（Qwen3-0.6B）在「程式決定不了、真的要問模型」的步驟選得更準：選工具、該呼叫／反問／直接答／做不到、CoLU 字母選單、UML 設計封閉題、思考堆疊、blockly 範式槽位、寫程式。訓練只改一個小的 LoRA adapter（約 40 MB），不動基底模型。

設計與取捨見 [`../DESIGN.lora-training.md`](../DESIGN.lora-training.md)。

## 什麼時候要重新訓練

| 情況 | 要不要重訓 |
|---|---|
| 只新增或改了工具描述，留出工具的評量仍不輸基底 | 不用，沿用現有 adapter |
| 留出組的準確率比上次掉超過 5 個百分點，或整批工具家族／參數格式改變 | 要 |
| 提示格式變動（選單文字、`menuMessages`、思考堆疊標頭、工具呼叫格式） | 一定要 |
| 想擴充新領域資料（新增產生器） | 要 |

CPU 訓練很慢（約 1–5 小時，視資料量），所以請嚴格看上表，不要每次小改都重訓。

## 一鍵訓練（從頭到尾，可中斷續跑）

需要：Python 3.11+、Node.js。第一次執行會自動建立隔離的 `.venv`（CPU 版 torch），**不會動全域 Python**。

```bash
./train.sh --name r3          # Linux / macOS / Git-Bash
train.bat --name r3           # Windows cmd
.\train.ps1 --name r3         # PowerShell
```

階段（依序，完成後記錄在 `out/runs/<name>/done/`，重跑會跳過；`--force` 重做）：

| 階段 | 做什麼 | 產物 |
|---|---|---|
| `tools` | 掃描 `floating-assistant.js` 抽出全部註冊工具，標 20% 留出 | `data/real_tools_all.json` |
| `data` | 各領域產生器合併；答案一律程式驗證 | `data/train.jsonl`、`data/heldout.jsonl` |
| `sft` | LoRA SFT（CPU） | `out/runs/<name>/sft` |
| `eval_sft` | 基底 vs 微調，每個分組都列、退步標 REGRESSION、輸出上線門檻 | `out/runs/<name>/eval_sft.json` |
| `dpo` | DPO（沒有任何 `rejected` 列就跳過） | `out/runs/<name>/dpo` |
| `eval_dpo` | 同上 | `out/runs/<name>/eval_dpo.json` |
| `pack` | 打包成可發佈格式 | `out/release/<name>/` |

常用參數：`--stages sft,eval_sft,pack`（只跑部分）、`--epochs 2`、`--lr 2e-4`、`--blockly-files …`。環境變數：`LORA_THREADS`、`LORA_BATCH`、`LORA_SEQ`、`LORA_EVAL_EVERY`（評量抽樣，基底與微調用同一值）、`DPO_MAX`。

## 產物格式與發佈

`out/release/<name>/`：`adapter_model.safetensors.partNN`（每片 20 MB）、`adapter_config.json`、`manifest.json`（基底、rank、sha256、訓練資料與工具清單雜湊、評量）、`join.js`（`node join.js` 重組並核對 sha256）。

發佈：把該資料夾複製到 GitHub 的 `lora-adapters` branch 的 `<name>/` 下（新版用新資料夾，不覆蓋舊版）。**只有各分組都不輸基底、目標組別明顯贏的版本才值得發佈**；沒有評量資料的版本不要自動啟用。

## 檔案

| 檔案 | 用途 |
|---|---|
| `train.sh` / `train.bat` / `train.ps1` | 建 venv 並呼叫 `train.py` |
| `train.py` | 階段式、可續跑的主流程 |
| `train_lora.py`、`train_dpo.py` | SFT、DPO（自寫，CPU） |
| `eval_run.py` | 規則評分的分組評量與上線門檻 |
| `pack_adapter.js` | 打包 20 MB 分片與 manifest |
| `extract_tools.js` | 抽取全部註冊工具 |
| `gen/` | 各領域資料產生器與 `merge_dataset.js`；格式見 `schema.md` |
| `lora_common.py` | 共用的資料正規化與編碼（訓練與評量一致） |
| `merge_and_export.py` | 把 adapter 合併回基底（評量／轉檔用） |
| `portable/` | 打包成單一壓縮檔，到另一台機器一個指令跑完 |

## 限制

- 沒有 CUDA；NPU 只能推論，不能訓練。目前只走 CPU。
- 產生的 adapter 是 PEFT 格式；app 內要實際套用需要「ONNX 動態套用 LoRA」，尚未完成（見設計文件 §7、§10）。
- 評量是規則評分，不等於真實使用者體驗；沒有留出資料的領域不能宣稱變準。
