# Qwen3-0.6B LoRA 微調設計文件

> 原始碼：`lora-train/`（`schema.md` 統一資料格式、`gen/*.js` 各領域資料產生器、`train_lora.py`、`merge_and_export.py`）。
> 關聯文件：`DESIGN.think-stack.md`（CoLU＋UML-design 思考堆疊，已明文記錄「要更準需要 LoRA、較大模型、開思考」的結論）、`DESIGN.offline-recipes.md`、`DESIGN.offline-plans.md`、`DESIGN.fn-template.md`、`DESIGN.colu.md`、`DESIGN.uml-framework.md`、`DESIGN.blockly-curriculum.md`、`DESIGN.blockly-gap(s).md`、`DESIGN.matrix-fallback.md`、`DESIGN.offline-trainer.md`（名字很像但完全不同系統——見下方「與『離線訓練器』的關係」）、`DESIGN.TODO.native-runner.md`、`DESIGN.native-all-models.md`。

## 0. 為什麼要做這件事（現況）

這份專案裡，讓 0.6B 小模型「做得準」的所有努力，到目前為止**幾乎全部是非 ML 的工程手段**：更好的選單排版、堆疊標頭、嵌入檢索、確認閘門、手刻的家族骨架。這些手段已經逼近各自的天花板，而且作者在多處文件裡明文寫下「已測過、沒用、需要別的模型能力」：

- `DESIGN.think-stack.md`：選工具路由，JSON 封閉題＋堆疊標頭 40% 正確、CoLU 式字母選擇 20%、附定義字母選擇 8%～15%——都卡在「模型幾乎都選第一個選項」的位置偏誤，不是排版問題。原文結論：「要更準需要別的模型能力（LoRA、較大模型、開思考），不是排版技巧。」
- `DESIGN.offline-intent-pipeline.md`：「哪個 app/viewer」路由，字面比對 held-out 36%，加嵌入檢索到 75%／67%；模型自己猜對的比例低（4/16），得另外加「猜得對不對」確認閘門補救。
- `DESIGN.blockly-gap.md`／`blockly-gaps.md`：骨架是「列舉家族」，不在家族裡的新題目完全解不出來——這是離散符號系統先天的天花板，不是靠再寫一個骨架就能繞過的。
- `DESIGN.fn-template.md` §8：唯一一次真模型（原生 CPU qwen3-0.6b）跑過的 smoke test，連「29×37」這種純算術都需要開思考模式才答對；正式的 pass-rate／retry benchmark 表格到現在還是 `RESULTS_PLACEHOLDER`，從沒填過數字。

換句話說：**這是一個全新的（greenfield）建置，不是延伸既有的訓練管線**——全專案搜尋 `peft`／`torch`／`bitsandbytes`／`onnxruntime-genai`／`qlora`，在這次動工之前一個都沒有，也沒有任何 `requirements.txt`。「使用者決定 LoRA 評估由遠端 session 負責」這句話（`DESIGN.think-stack.md`）只是一個範圍界定的決定，底下沒有任何資料格式、腳本或結果——這份文件與 `lora-train/` 就是把這個「尚未開始」的項目真正建起來。

## 1. 硬體現實（先把期待對齊）

這台機器（Intel Core Ultra 7 155U、16GB RAM）：

| 元件 | 狀態 |
|---|---|
| NVIDIA GPU / CUDA | **沒有**（`nvidia-smi` 找不到、`torch.cuda.is_available()` 為 `False`） |
| Intel AI Boost NPU | **有**（`Intel(R) AI Boost`，PCI 裝置確認存在），但 NPU 是**純推論**加速器——目前沒有任何主流框架能在這顆 NPU 上做反向傳播訓練；`DESIGN.native-all-models.md` 也明記 DirectML（NPU／iGPU 這條路線）在 qwen3-0.6b 的某個節點**已知失敗**，Linux CUDA 只是規劃、從未真的跑過 |
| Intel 內顯（Arc／Xe-LPG） | 存在（`Intel(R) Graphics`），同樣只有 DirectML 推論路徑已知會壞；沒有可用的訓練加速路徑（IPEX／XPU 未安裝、未驗證） |
| CPU | Intel Core Ultra 7 155U，12 核 14 緒——這是目前**唯一驗證可行**的訓練路徑 |

**結論（使用者已確認採用）：LoRA 訓練跑在 CPU。** 0.6B 參數＋LoRA（只訓練小量 adapter 參數、凍結主幹）在 16GB RAM 下跑得動，只是比 GPU 慢；本文件與腳本全部以此為前提設計，不假裝有能用的 GPU／NPU 訓練路徑。NPU 之後仍可用於**推論**（例如微調完的模型量產階段的加速），但不是這一輪的訓練後端。

## 2. 與「離線訓練器」（`DESIGN.offline-trainer.md`）的關係——名字很像，完全不同的系統

這點容易混淆，先講清楚：

| | 離線訓練器（既有、已實作） | 這份文件：LoRA 微調（新建） |
|---|---|---|
| 本質 | 規則／pattern／FSM／JS 工具，**完全是符號系統**，0 次模型訓練 | 真正的神經網路梯度訓練（PEFT LoRA），改動模型權重 |
| 「學習」的意思 | 把成功的 function call 樣板記下來、升格成規則 | 讓模型的 attention/MLP 權重在特定任務分布上做梯度更新 |
| 執行環境 | Electron renderer（JS，瀏覽器／桌面版） | 獨立 Python venv（`lora-train/.venv`），與正式 app 完全分離 |
| 目標 | 連不上任何 AI 時仍能精準做事 | 讓本來就會用到 0.6B 模型的步驟（選工具、UML 填空、程式微選擇、寫程式）選得更準 |

兩者**不衝突、可以疊加**：離線訓練器學到的規則／pattern 讓程式能自己決定的部分越來越多（模型根本不用出場）；LoRA 微調改善的是「程式决定不了、真的要問模型」的那一小塊決策品質。`lora-train/` 的資料產生器刻意重用 production 的 prompt 組字函式，所以兩套系統看到的「模型何時被問」的界線是一致的。

## 3. 統一訓練資料格式與涵蓋範圍

完整格式規格見 [`lora-train/schema.md`](lora-train/schema.md)，摘要：

```jsonc
{"id": "...", "domain": "tool_routing|uml_design|think_stack|colu|blockly_matrix|fn_template",
 "stage": "...", "messages": [...], "completion": "...",
 "verified_by": "program_ground_truth|judge_pass|rejection_sampling",
 "split": "train|heldout", "source_file": "...", "meta": {...}}
```

六個 domain 對應使用者原始需求的五個方向：

| domain | 對應需求 | 讀的核心模組 | 讀的資料來源 |
|---|---|---|---|
| `tool_routing` | 「所有tool call的recipe」 | `renderer/src/recipe/recipe_core.js` | 既有測試／種子檔 |
| `colu` | 「CoLU」 | `renderer/src/recipe/think_stack.js`（`coluChoose`）、`renderer/src/catalog/catalog_core.js` | 既有測試／`DESIGN.colu.md` 體檢情境 |
| `uml_design` | 「UML-design逐層切割」 | `renderer/src/uml/uml_core.js`、`design_core.js` | 既有測試／`DESIGN.uml-framework.md` |
| `think_stack` | 「思考堆疊」 | `renderer/src/recipe/think_stack.js`（`planChecks`／`reviewReturn`／`selfValidate`／`header`／`wrap`） | 既有測試＋其他 domain 的多層任務疊加 |
| `blockly_matrix` | 「blockly-teach+matrix-algorithm…更精準」 | `renderer/src/uml/algo_intent_core.js`、`py_paradigms_core.js` | `renderer/src/recipe/seed/*.jsonl`（含凍結的 holdout 題庫） |
| `fn_template` | 「plan template規劃能力」 | `renderer/src/recipe/code_loop_core.js`、`judge_core.js`、`renderer/src/uml/step_split_core.js` | `renderer/src/recipe/seed/problems.jsonl` |

**核心紀律（三條，貫穿整個管線）**：

1. **只用程式已經重用、不是新刻的 prompt**：每個產生器 `require()` 真正的核心模組，呼叫它既有的組字函式產生 `messages`。不手刻字串常數——標頭、選單、DSL 格式之後會改，重複刻一份字串只會跟正式環境逐漸漂移。
2. **答案必須是程式驗證過的，不是另一個模型生成的猜測**。`verified_by` 老實標記驗證方式；資料不夠就是不夠，在產生器的 stderr 誠實印出筆數與原因，不湊數字。這點直接繼承 `DESIGN.blockly-gap.md`／`matrix-fallback.md` 反覆強調的「乾淨 holdout」紀律。
3. **held-out 檔案永遠不進訓練集**：`holdout_blockly.jsonl`、`heldout_all.jsonl`、`heldout2~6.jsonl` 這類檔案衍生出來的列一律標 `split: heldout`；`train_lora.py` 看到任何 `split != "train"` 的列會直接拒絕執行（寫死在腳本裡，不是口頭約定）。

## 4. 資料產生管線（Node）

```
lora-train/gen/gen_tool_routing.js   ─┐
lora-train/gen/gen_colu.js            │
lora-train/gen/gen_uml_design.js      ├─→ lora-train/gen/merge_dataset.js ─→ lora-train/data/{train,heldout}.jsonl
lora-train/gen/gen_think_stack.js     │
lora-train/gen/gen_blockly_matrix.js  │
lora-train/gen/gen_fn_template.js    ─┘
```

每個 `gen_*.js` 是 CommonJS 模組，匯出 `generate()`，也能直接 `node gen/gen_xxx.js` 印 JSONL 到 stdout（契約細節見 `schema.md`）。全部不碰 DOM／Electron——這些核心模組本來就是刻意設計成「不碰 DOM 的純函式 UMD」（`think_stack.js`、`recipe_core.js`、`uml_core.js`…… 檔頭註解都這樣寫），讓資料產生器能在 plain `node` 下載入，不需要啟動整個 Electron。

## 5. 訓練管線（Python，CPU）

獨立虛擬環境，刻意與全域 Python 環境隔離（教訓：第一次嘗試直接 `pip install datasets` 到全域環境，把 `transformers` 從 4.57.3 拉到 5.x，弄壞了 `docling`〔pdf/docx 技能用〕所需的 `transformers<5,huggingface_hub<1` 限制；已修復並改走 venv，之後任何人收斂這份文件都要記得**絕不對全域環境 `pip install`**）：

```bash
python -m venv lora-train/.venv
lora-train/.venv/Scripts/pip install torch --index-url https://download.pytorch.org/whl/cpu
lora-train/.venv/Scripts/pip install -r lora-train/requirements.txt
```

`train_lora.py`：
- 讀 `lora-train/data/train.jsonl`（拒絕任何 `split != "train"` 的列）。
- 用 tokenizer 自己的 `apply_chat_template`（`enable_thinking` 依每筆 `meta.thinking` 決定，預設 `False`，對齊 `nr-engine.js` 原生路徑的硬編碼預設）把 `messages` 轉成 prompt token，`completion` 接在後面＋`eos`，loss 遮罩只算 completion 部分（標準 SFT，不花梯度學著重現 prompt）。
- PEFT `LoraConfig`（預設 `r=16, alpha=32`，目標模組 `q/k/v/o_proj` 與 `gate/up/down_proj`），凍結主幹。
- 從 train 切一塊（預設 10%）當訓練期驗證集——這跟 heldout 不同，heldout 是「從沒看過的題型」，訓練期驗證集只是同分布抽樣，用來看 loss 有沒有過擬合。
- 全程 CPU、fp32（CPU 上 bf16/fp16 支援不穩定，優先正確性）。

`merge_and_export.py`：合併 adapter 回主幹權重，存成 safetensors。下一步（GGUF 轉檔給 `llama.cpp`／`mini_llama_server.py`，或 ONNX 轉檔給正式的 `nr-engine.js` 原生路徑）兩條路都沒有在這次做——見第 7 節「尚未做」。

## 6. 評量：怎麼知道真的變準了

既有的 eval 骨架（`bench_coverage.js`、`stack_consistency.js`、`code_loop_bench.js --backend http`）已經能打真模型，而且 `scripts/eval/mini_llama_server.py` 本來就是一個 Python 端、OpenAI-chat 相容、吃 GGUF 的推論伺服器，正是這些 JS harness 既有的呼叫介面之一。評量路徑（**不改動任何正式程式碼**）：

1. `merge_and_export.py` 合併出 fp32 safetensors。
2. 轉 GGUF（`llama.cpp` 的 `convert_hf_to_gguf.py`，這台機器目前沒裝 `llama.cpp`，屬於下一步）。
3. `mini_llama_server.py` 吃 GGUF 開伺服器。
4. 既有的 JS harness（`bench_coverage.js --files heldout_all.jsonl` 之類）分別打 base 模型與微調後模型，比較 heldout 分數——這直接回答 `DESIGN.think-stack.md` 留下的那個問題：LoRA 到底能不能把 40% 的工具路由正確率推高。

這條路徑完全重用既有基礎設施，不需要另外寫一套評分邏輯，也不需要改動 `nr-engine.js`／production 程式碼。

## 7. 現況與尚未做的事（誠實列出，不要假裝完工）

**這一輪做的**：統一 schema、六個領域的資料產生器（實際筆數以每個產生器 stderr 的誠實統計與 `merge_dataset.js` 的彙總為準——**不在這份文件寫死數字**，數字會隨產生器改進而變，寫死容易過期誤導）、隔離的 CPU 訓練環境、通用的 `train_lora.py`／`merge_and_export.py`。

**尚未做，列為後續**：
1. **還沒有跑過一次真正的訓練**——這份文件與腳本是管線，不是已經訓練好的 adapter。下一步是小規模 smoke test（`--max_steps` 設小一點，確認 loss 會降、資料真的能跑過一輪），再談正式訓練規模與要跑多久。
2. **GGUF／ONNX 轉檔都沒做**：沒有裝 `llama.cpp`，沒有試過 `optimum-cli export onnx`；§6 的評量路徑目前只是設計，没有實測過一次。
3. **各 domain 產生器的資料量多半很小**（照「不湊數字」的紀律，只收錄真的能驗證的筆數）——這代表第一版 adapter 大機率資料不夠，訓練效果有限；要擴大資料量，優先方向是：讓既有的 bench/holdout 產生器（`scripts/eval/gen_bench_*.py`、`gen_heldout*.py`）生出更多題目、讓 `/teacher-loop`／`/offline-trainer-by-ai` 跑出來的真實成功案例也喂進同一個統一格式（這些案例本來就有「老師教完、離線重做通過驗證」的真實正確答案，是目前全專案裡少數的大量、已驗證的模型決策紀錄來源）。
4. **部署目標：adapter 保持獨立小檔案，推論時動態套用，不要合併成單一大檔**（使用者 2026-11-10 明確要求的方向）：

   | 做法 | 下載量 | 切換 patch | 難度 |
   |---|---|---|---|
   | A（採用）：adapter 獨立一個小檔（約 10–20 MB），每次推論時額外餵進去 | 基底約 600 MB 下載一次，之後每個 patch 只要 10–20 MB | 不必重啟、不必重下基底，即時切換／疊加 | 高——`nr-engine.js`（ONNX-only、onnxruntime-node）與 transformers.js（網頁版）都**不是**為了動態套 LoRA delta 設計的，ONNX 圖是靜態的，要嘛 (a) 匯出時就把 adapter 的低秩矩陣當成額外的 initializer／node 內建進圖裡（`y = W0x + B(Ax)·scale`），之後只換那幾個小 initializer 的值就能切換 patch；要嘛 (b) 用 onnxruntime 的外部資料（external data）機制把 adapter 權重放在圖外的小檔，載入時指定不同檔案。兩條路都需要改 `nr-engine.js`／`vlm_core.js`／`transformers.js` 的載入程式碼，**目前都還沒做**。 |
   | B（不採用）：合併 adapter 回主幹權重，存成單一完整檔案 | 每個 patch／每次微調都要整份基底＋adapter 一起下載（0.6B fp32 約 2.4GB，q8 約 600MB） | 需要整份重新下載、重新載入 | 低——`merge_and_export.py` 已經寫好，是最簡單的路 |

   **這兩條路不是互斥的，分屬不同用途**：B（`merge_and_export.py`，已完成）是**評量用**的捷徑——合併後轉 GGUF、用既有的 `mini_llama_server.py` 開伺服器，讓既有的 JS eval harness（`bench_coverage.js` 等）直接打，用來回答「LoRA 到底有沒有讓正確率變高」這個問題，不需要先把 A 的執行期套用機制做出來。A 才是**正式部署**的目標架構——多個 patch（不同 domain、不同版本的微調結果）可以疊加／替換，不必每次都重下整個基底。順序：**先用 B 的路徑驗證某一版 adapter 真的有效，再投入 A 的執行期工程**，不要在還不知道 adapter 有沒有用之前就先把部署機制做複雜。A 的實作細節（ONNX 匯出時怎麼內建 LoRA 結構、`nr-engine.js`／`transformers.js` 怎麼改）是下一階段的獨立設計工作，這份文件目前只記下方向與做法比較，還沒有展開成可執行的計畫。
5. **思考堆疊／CoLU/blockly 的「路由」決策**（`HANDOFF.blockly-teach.md` 待辦項「I：路由堆疊實測，需模型」）目前資料量最少，因為這一層在既有程式碼裡幾乎沒有真正被模型決策過的紀錄可以重用——這是最值得之後投入「老師迴圈先跑出真實案例，再轉成訓練資料」的地方，而不是一開始就假裝已經有足夠資料直接訓練。
