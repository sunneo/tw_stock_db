> **整合版已出**：完整設計（依讀者順序，含驗證現況表與兩份設計提案）見 [DESIGN.offline-training-studio.md](DESIGN.offline-training-studio.md)。本檔保留為時間序的原始紀錄與證據來源，以整合版為準。
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

## 8. 落差對照：另一份成熟的 Qwen3-0.6B LoRA 設計（`DESIGN.edit-lora`，2026-11-10 使用者提供）

比對同樣是 Qwen3-0.6B LoRA 的另一份設計文件後，整理出我們**還沒有、或做法不同**的部分，標「已有」的不重複討論。那邊的文件也誠實寫著「訓練結果還沒出來」——兩邊都還沒有一個真正訓練完成、上線的 adapter，所以我們不算落後在「有沒有成果」，落後的是下面這些廣度與紀律。

| 主題 | 對照設計的做法 | 我們目前 | 落差與行動 |
|---|---|---|---|
| 工具清單來源 | `extract_tools.rb` 從 Ruby `tool_registry.rb`＋各 `*_tools.rb`＋`domain_registry.rb` 讀出 205 個工具＋33 個領域，寫成 `real_tools_all.json`，之後資料產生器只讀這份 JSON | **沒有單一登記檔**：`renderer/src/floating-assistant.js:73594` 的 `registerOptional(name, desc, cb, schema)` 在巨大的類別建構式裡逐一呼叫 `this.register_openai_tool(...)`，粗略計數約 **206 個**工具名稱（巧合地跟對照設計的 205 幾乎一樣）；另外還有第二種型態（`sheet_set_cell`／`sheet_add_row` 這類，直接寫死 `domain:` 欄位的資料表），兩種型態並存，不是單一來源。沒有統一的 33 領域結構——`registerOptional` 呼叫完全沒有 domain 欄位，只有 `_domainGatedToolNames` 這種扁平的名稱集合。`catalog_core.js` 的 `buildCatalog(tools, domains, opts)` 是純函式，**吃**工具清單當輸入，不是工具清單本身的來源。 | **行動**：要做到對照設計那種「205 個工具、held-out 20%」規模的涵蓋，必須先寫一支類似 `extract_tools.rb` 的抽取器——既然沒有乾淨的登記物件可以 `require()`，大概率要用正規表示式掃 `floating-assistant.js`（這份檔案本身已經在第 59249 行附近這樣掃過自己，可以照抄同一套規則），把 `registerOptional` 與 `sheet_*` 兩種型態都收斂成同一份 `real_tools_all.json` 等價格式，再讓 `gen_tool_routing.js`／`gen_colu.js` 改吃這份清單，而不是目前的 `stack_route_cases.js`（5 個工具）／`offline_stack.test.js`（2-3 個候選）兩個小 fixture。**尚未動工**。 |
| 工具涵蓋廣度（目前的實際落差） | 205 個工具全部有 call／ask 樣本，20% 完全 held-out（連 distractor 都不出現），`coverage_v2.json` 誠實列出未覆蓋原因 | `tool_routing`＋`colu` 合計 23 筆，來自 2 個小測試 fixture（5 個工具＋2-3 個候選），**沒有任何 held-out 工具名**——`colu/ext`（對照設計裡「完全沒見過的工具名」這組，基底模型只有 7/40，是全表現最差的組別之一）這種「泛化到新工具」的題型我們現在**完全沒有對應的評量資料**，連題型都還沒建。 | **行動**：等上面的抽取器做出來，照 schema.md 既有的 heldout 紀律（`split:"heldout"` 永不進訓練）切一批「訓練時從沒出現過、連當選單幹擾項都沒出現過」的工具名，才能測這個。 |
| when2call 行為分類 | 五種：`call`（填必要參數）／`ask`（缺參數→反問）／`direct`（寒暄）／`nofit`（沒有工具能做）／`missing`（要求的工具不存在→回報「不存在，最接近的是 X」，不可再呼叫搜尋工具，對應「nick.lin 失敗模式」） | 只有 `choose_tool`（≈`call`＋隱含的「都不是」≈`nofit`）；`ask`、`direct`、`missing` 三種**完全沒有** | `ask`：確認 `recipe_core.js` 只有「欄位不知道填 null，不要猜」（`recipe_core.js:232`），**沒找到**一個「把 null 的必填欄位變成一句反問丟回使用者」的獨立程式路徑（上層的 offline-intent-pipeline 填槽階段是否有這段，這次沒查證，列為不確定，不是「沒有」）。`missing`：在 `recipe_core.js` 裡**沒找到**任何「名字很近似但找不到工具→回報最接近的是誰」的邏輯（對應文件說的 nick.lin 失敗模式，這邊的程式目前就是沒有這塊）。**行動**：這兩塊如果程式層都真的沒有，那不是「資料產生器沒收到」的問題，而是 production 程式碼本身缺這個行為——要嘛先補 production 的這段邏輯再產生訓練資料（讓資料跟著真實行為走，不要訓練一個 production 做不到的行為），要嘛先設計、再決定要不要讓 LoRA 自己學會這個分支（風險：模型學會的「不存在時怎麼回答」沒有程式驗證把關，可能學到看起來像、其實亂猜最接近工具的壞習慣）。 |
| 不照抄／反面訓練 | `writer` 三種（answer／unsure／copycode）＋`agent/use`：專門訓練「不要把範例當答案抄」「不要在答案後面多附不確定」 | 沒有對應領域 | 這是我們六個 domain 之外的新問題類型，不屬於任何一個既有 domain，需要新增一個（例如 `anti_pattern` 或併入 `tool_routing` 的新 stage）——**尚未規劃，先記下來**。 |
| ONNX 做法 A（adapter 獨立小檔＋推論時動態套用） | **已實作並部分驗證**：量化後對 196 個目標線性層（28 層×7 個投影）動手術插入 `y = y_base + (x·A)·B` 分支，A／B 存成 external-data（`lora.bin`，fp32 40.4MB／fp16 20.2MB）；transformers.js 3.7.5／4.2.0 都能用 `session_options.externalData` 直接載入，**不需要 fork**；已驗證零 adapter 輸出與基底 q8 完全一致、onnxruntime-web WASM 載入成功且與 python top-1 一致（約 2 秒）；尚未驗證真瀏覽器、WASM 速度成本、fp16 版、與合併版輸出一致性 | 只在 §7 第 4 點記了方向與兩條路的比較表，**完全沒有動工** | 這是整份對照裡最值得直接借用的一塊：對照設計已經把「ONNX 圖手術＋transformers.js 原生支援 externalData」這個最大的不確定性驗證掉了。我們的 native 路徑是 `nr-engine.js`（onnxruntime-**node** 子行程），不是 onnxruntime-web——`externalData` 這個 session option 在 onnxruntime-node 是否同樣支援、我們自己匯出的 q8 ONNX 圖結構（量化方式、目標線性層數量）是否跟對照設計的一致，都要先查證，不能直接假設搬過來就動；但做法本身（圖手術＋外部資料檔）不必重新研究一遍。**行動**：等我們自己訓出一版 adapter、用 §6 的 GGUF／mini_llama_server.py 捷徑證明有效之後，優先嘗試照抄這個技術方案，而不是自己重新摸索。 |
| 版本相容性與何時重訓 | adapter manifest 記 `tool_catalog_hash`／`prompt_format_version`／`base`（模型id+檔案sha）／`rank_slot`／`trained_on`；載入時比對，三種不符三種處理（拒絕載入／拒絕載入／允許但提示重訓）；§2.3 明定「只新增工具且 held-out 類還不輸基底→不用重訓；held-out 準確率掉超過 5 個百分點或參數格式整批變→要重訓；提示格式變動→一定要重訓」 | 完全沒有 | 現在談這個還早（連第一版 adapter 都沒有），但這份文件應該先把「以後要有 manifest／相容性檢查」記下來，免得等有了 adapter 之後才發現工具清單一變就不知道要不要重訓。**行動**：列入 §7 待辦，暫不展開。 |
| 可攜訓練包 | `make_bundle.sh` 打包腳本＋資料（1.7MB，不含模型／venv）成單一 tar.gz，另一台機器 `./run_all.sh` 一條指令跑完建 venv→下載基底→估計時間→SFT→評估→DPO→評估→打包，可分段續跑、自動偵測核心數/記憶體 | 沒有；`requirements.txt` 需要手動建 venv，訓練要自己一支一支腳本跑 | 考慮到我們的 CPU（14 緒）比對照設計實測的 24 核心慢，若使用者手上有更好的機器，這個「打包可攜、自動續跑」的做法值得抄——**尚未規劃**。 |
| 評量紀律 | 全部工具總表＋三個重點組＋從未訓練的留出工具/領域＋覆蓋率＋選項位置分布，每組都與基底並列；**任何一組輸給基底都要列出，不能只挑贏的報**；上線條件＝「每個報告組別都不輸基底、目標組別明顯贏」 | 只有 §6 的設計（還沒真的跑過一次） | 這份「不能只報喜、每組都要對照基底、有輸要照實寫」的紀律值得原文借用為我們 §6 評量設計的具體準則，不要等真的訓練完才臨時決定怎麼報。**已在 §6 的方向上，但還沒寫成這麼具體的規則，之後補。** |

**這次沒有查證、留白的點**：`renderer/src/offline/intent_gate.js`（可能也有登記/領域邏輯，這次沒看）；offline-intent-pipeline 的「填槽」階段是否真的有「反問使用者」這條路徑（只確認了 `recipe_core.js` 本身沒有，没有再往上層查）。

## 9. 第一批實測結果（2026-11-11，CPU，SFT r=16，`eval_adapter.py`，貪婪解碼）

- 第一輪：124 列、3 epoch；驗證 loss 0.193→0.159→0.193（第 3 epoch 回升，輕微過擬合）。
- 第二輪（adapter_r2）：378 列（含 `tool_routing_full` 254 列）、2 epoch；驗證 loss 0.184→0.160。
- **留出工具選工具（61 題，訓練時連干擾項都沒出現過）：基底 6/61、adapter 53/61。** 答案位置分布 1/2/3/4＝18/12/16/15，沒有偏單一位置。
- 限制：問句由工具描述程式合成，偏制式偏易；基底 6/61 低於隨機（25%），很可能含大量格式失敗（沒穩定輸出 `{"choice": N}`），所以增益有一部分是學會格式；只量了這一組，其他領域（UML、CoLU、blockly、寫程式）沒有留出資料，只知道 loss 下降，**不能宣稱變準**；未在 q8 量化模型或真實 app 路徑上驗證。

## 10. App 內的使用方式：離線模型自動取用 GitHub 上相容的 LoRA（設計，2026-11-11，尚未實作）

目標：離線模型（Qwen3-0.6B）啟動時，若 GitHub `lora-adapters` branch 上有「相容且足夠強化」的 adapter，就下載、驗證、載入；由設定決定啟用或停用，**預設啟用**。

- **設定**：`offlineLora`（`on`｜`off`，預設 `on`）、`offlineLoraChannel`（預設 `lora-adapters`）；設定頁「AI → 離線模型」顯示目前啟用的 adapter 名稱、大小、sha256、評量結果、「檢查更新」「停用」「刪除快取」。`off` 時完全不連網、不載入，行為與沒有 adapter 完全一致。
- **取得**：讀 branch 上各版資料夾的 `manifest.json`（已有：`pack_adapter.js` 產生），挑選「相容」且「評量較好」的最新版；下載 `adapter_model.safetensors.partNN` 分片（每片 20MB），逐片與整檔核對 sha256，通過才存進本機快取（沿用離線模型的快取與釘版慣例）。網路失敗或任何核對不符：**靜默退回無 adapter**，不影響使用。
- **相容性（載入前必查，任一不符就不載）**：`base`（模型 id 與檔案 sha）、`rank`／rank 槽、`prompt_format_version`（提示格式版本，格式一改一定要換版）；`tool_catalog_sha256` 不符則允許載入但在設定頁提示「工具清單已變動，建議更新」。manifest 需補 `prompt_format_version` 與 `min_eval`（用來判斷「足夠強化」的門檻，例如留出組不輸基底）。
- **足夠強化的判斷**：只自動採用 manifest 的 `eval` 顯示每個報告組別都不輸基底、目標組別有贏的版本；沒有評量資料的版本不自動啟用（可手動選）。
- **載入**：**桌面版已接（2026-11-11）**：adapter 為 `lora.bin`（做法 A：量化後在 196 個目標線性層插入 LoRA 分支、A／B 存成外部資料，`make_lora_onnx.py`），經 `nr-engine.js` 的 `externalData` 交給 onnxruntime-node 1.22.0（已實測選項可用），換 adapter 只重建 session。需要執行包 1.22.0-2（尚未發佈，發佈前舊執行包會明說需要更新），細節見 `DESIGN.TODO.native-runner.md` §9。**網頁版（transformers.js）尚未接**：阻礙與解除條件見 `DESIGN.TODO.offline-training-studio.md` §14。一次只能套一個 adapter（單一 LoRA 槽）。
- **安全**：只下載本專案 repo 指定 branch 的檔案；只接受 sha256 吻合者；不執行任何下載內容（adapter 是純權重）；使用者可隨時停用。
- **改到 renderer 檔案時**：`floating-assistant.js`／`bootstrap.js`／`index.html` 的變更需走 live-update patch 發佈流程。

## 11. 標準版 q8 轉成槽版（JavaScript，免 Python）（2026-11-11，進行中）

- 目的：使用者不需要 Python 也能把自己下載的標準版 Qwen3-0.6B q8 ONNX 改成 LoRA 槽版（不託管模型）。
- 做法與細節見 `DESIGN.TODO.native-runner.md` §9.6；程式：`lora-slot-build.js`、`native-slot-model.js`、`tests/native/lora_slot_build.test.js`。
- 實測：轉換 4.2 秒、峰值 RSS 約 37.6 MB（617 MB 輸入，串流）。
- **尚未通過等價驗證**：全零 adapter 位元相同；非零 adapter 的槽版與網頁版併權重結果不一致（首步 logits cos 約 0.968）。查出原因前，不得宣稱「與 make_lora_onnx.py 等價」或「網頁版與原生版一致」。
  - **2026-11-12 更新**：原因已查明（§11.1）：槽版與 fp32 真值一致，差異來自網頁版併權重的抖動雜訊。真模型上仍未驗證。
- 已知阻礙：studio-viewer 的既有語法錯誤（符號式擬合區段）使 LoRA 卡片無法在畫面驗證。

### 11.1 查明結果（2026-11-11～11-12，假圖重現；真模型見 §11.2–11.4）

**結論：非零 adapter 的「槽版 vs 網頁版併權重」不一致，不是槽版的錯。** 槽版與 fp32 真值（基底輸出 + x·A·B）逐值一致（相對誤差 0）。網頁版併權重的誤差來自抖動式四捨五入，是零均值的隨機雜訊，屬於 `lora-merge` 核心（`renderer/src/studio/lora_merge_core.js`）的既有設計（`DESIGN.TODO.offline-training-studio.md` §14）。先前把「網頁版併權重」當等價基準是錯的：它本身是近似，不是真值。

實測（假的 q8 圖：1 層 × 7 目標，rank 4，onnxruntime-node 1.22.0；可重現，見 `tests/native/lora_slot_equiv.test.js`）：

| 假設 | 實測 | 判定 |
|---|---|---|
| 轉置（A、B 方向） | 非方陣（8×12 等）下，槽版 vs 真值相對誤差 0 | 排除 |
| rank 槽順序（版面 offset） | 槽版 vs 真值 0；網頁版 vs 槽版 cos 約 0.9999～1。把 q 與 k 的 A 寫錯位置時，測試失敗（突變測試） | 排除 |
| 縮放取 2 的冪 | 槽版不併權重，與 k 無關；強制 k=1 時網頁版誤差幾乎不變（約 0.9%） | 排除 |
| 動態量化輸入（網頁版的 LoRA 項吃量化後的 x） | 改用量化後的 x 算真值，網頁版誤差 0.0049 vs 0.0048 | 排除 |
| 抖動捨入 | 單一種子的 ΔW 對 A·B 相對誤差 0.994（B 很小時）；32 個種子平均後降到 0.179（約 1/√32，零均值）。誤差隨「量化步距 ÷ ΔW」增大（0.26 → 2.6 → 26 時，網頁版對真值相對誤差 0.5% → 0.7%～1%；LoRA 本身的輸出效應只有約 0.04%） | **主因** |

判讀：小 adapter（ΔW 小於一格）時，併入的雜訊比 LoRA 效果本身還大；這正是 `lora_web_core.js` 的 `minCos` 門檻要擋的情況。真模型上 0.968 的首步 logits 餘弦，推測是 196 層的雜訊累積到 logits 的結果，**未在真模型上驗證**。

**修正與測試**
- 槽版程式（`lora-slot-build.js`、`native-slot-model.js`）不需要改。
- 等價基準改為 fp32 真值：槽版相對誤差 < 1e-5；網頁版與真值相對誤差 < 3%（實測 0.5%～1.3%）。網頁版與槽版不再要求逐值相近。
- `tests/native/lora_slot_equiv.test.js`：8 項通過（A 段權重層級，不需要 onnxruntime；B 段需要執行包，沒有就略過並說明）。`tests/native/lora_slot_build.test.js` 仍 36 項通過。
- 網頁版降雜訊：評估後**不改程式**。確定性捨入會產生偏差（不再是零均值）；多種子平均要併入多次、成本高；而且沒有真模型的量測，無法證明改善。要改，先在真模型上量測再決定。

**尚未驗證（誠實列出）**
1. ~~真模型上的驗證~~ 已於 2026-11-12 完成，見 §11.2（槽版轉換器）、§11.3（網頁版差異的來源）、§11.4（結論與待改善）。仍未驗證：真實訓練的 adapter（本機沒有，以下全部用隨機 adapter）與瀏覽器內的網頁版執行。
2. 真模型上的「量化步距 ÷ ΔW」比值，決定網頁版實際雜訊大小。只靠 PyTorch 權重無法精確算出，需要真 q8 檔。
3. 小型重現的 ΔW 與步距比例是人為設定，不代表真 adapter 的分布。

### 11.2 槽版轉換器：真模型逐目標驗證（2026-11-12，通過）

- 檔案：標準版 q8 ONNX `models/Qwen3-0.6B-ONNX/onnx/model_quantized.onnx`（617,687,575 位元組，唯讀使用，未下載）。
- 方法（`scripts/eval/lora_slot_branch_check.js`）：在基底與槽版的 graph 尾端加上 y（目標輸出）、y_base（槽版內的原輸出）、x（目標啟動值）為圖輸出，並關閉圖最佳化（否則部分中間名稱會被融合掉、不回傳）。隨機 adapter（rank 16，種子 7，B 幅度 0.02，A 幅度 1）；prompt 為 22 個 token（聊天樣板）。
- 比較：每個目標的旁支輸出（槽版 y − y_base）對 x·A·B，x 取自**同一次槽版執行**（不能用基底的啟動值：上游層的旁支會改變下游的啟動值，這是先前比對失效的原因），全部用 fp32 計算。
- 結果：196 個目標，平均相對誤差 **2.23e-7**，最差 **3.56e-7**（`layers.10/attn/o_proj`）。抽樣的 `layers.0/attn/q_proj` 餘弦 1.0000、長度比 1.0000。
- 結論：槽版轉換器在真模型上的旁支與 fp32 真值一致（在 float32 精度內）；位置、rank 槽順序、轉置都正確。
- 基底不變：LoRA 全零時，槽版與基底的首步 logits 位元相同，前 4 步貪婪 token 相同（`tests/native/lora_slot_build.test.js` 與本節的全零實測一致）。
- 範圍：這個判準只涵蓋旁支的數學與接線；其餘網路與基底相同（由全零位元相同保證）。端到端 logits 不能當判準，見 §11.3。

### 11.3 網頁版（併權重）與槽版的差異：來源（真模型診斷，2026-11-12）

- 方法（`scripts/eval/lora_slot_web_equiv.js`）：同一份隨機 adapter（rank 16）、同一個 prompt，比較四條路徑：base（標準版）、slot（槽版，fp32 旁支，正式轉換器）、slotdq（旁支吃「DynamicQuantizeLinear 之後再反量化」的啟動值，builder 選項 `dqLoraInput`，僅供診斷）、web（`patchQwen3Q8` 併權重）。報告首步 logits 餘弦、各方式 LoRA 增量對槽版增量的相對誤差、前 8 步貪婪 token。

| adapter B 幅度 | slot–slotdq 餘弦 | slotdq–web 餘弦 | slot–web 餘弦 | 增量相對誤差：slotdq 對 slot | web 對 slot | web 對 slotdq | web 剪裁元素數 |
|---|---|---|---|---|---|---|---|
| 0.02 | — | — | 0.026 | — | — | — | 28,473,118 |
| 0.002 | 0.8706 | 0.8812 | 0.8614 | 0.565 | 0.746 | 0.648 | 15,058 |
| 0.0002 | 0.9905 | 0.9896 | 0.9846 | 0.572 | 0.719 | 0.589 | 44 |
| 0.00002 | 0.9861 | 0.9863 | 0.9778 | 0.860 | 1.135 | 1.189 | 2 |
| 0（全零） | 1 | 1 | 1 | 0 | 0 | 0 | 0 |

（基底首步 logits 範數 2109；B=0.002 時 base 對 slot 的增量範數 1554，B=0.0002 時 608，B=0.00002 時仍有 426。）

判讀（分三個來源）：

1. **啟動值量化（最大，且不是網頁版獨有問題）**：slot 與 slotdq 的增量差 57%～86%。用真模型量：112 個目標的啟動值（`scripts/eval/lora_activation_probe.js`）最大值對中位數的比 26～75,173（中位數 67），也就是有離群通道；對隨機 LoRA 項，量化造成的相對誤差平均 5.3%、最大 18.2%。併權重的網頁版把 LoRA 乘進 int8 權重，因此 LoRA 項只能吃量化後的啟動值，槽版的 fp32 旁支沒有這一項。
2. **權重側（抖動捨入＋飽和）**：web 對 slotdq 的增量差 59%～119%。merge 自己用探針估的每目標輸出誤差平均 8.5%（B=0.0002）到 12%（B=0.02）；大 adapter 時飽和（剪裁）很多：B=0.02 有 2,847 萬個元素被剪，而 `minCos` 門檻仍放行（merge 的探針估計 outCosMean 0.9946），也就是**門檻看不到飽和**。
3. **端到端 logits 會放大小擾動**：B=0.00002 時槽版與基底的增量範數仍有 426，遠大於 adapter 的實際大小。原因是下游的啟動值量化會因為上游的微小改變跳一格（離散跳動）。所以端到端 logits 的餘弦或相對誤差**不能當等價判準**；先前看到的 0.968 就屬於這種情況。

結論：**網頁版併權重不可能與槽版端到端等價**，即使權重側誤差降到零，來源 1（啟動值量化）也還在。這不是實作錯誤，是「把 LoRA 併進 int8 權重」這個做法的限制。

### 11.4 網頁版降雜訊：評估結論、待改善與阻礙（2026-11-12）

**降雜訊：評估後不改 `lora_merge_core.js`。** 理由（由 §11.3 的實測與機制推得）：

1. 確定性四捨五入會把小於一格的變化量整個丟掉（有偏差）。抖動（dither）是保留小變化量的必要做法，不能去掉。
2. 多種子平均能消除權重側的零均值部分（§11.1 實測：32 個種子平均後誤差降到約 1/√32），但要併入多次、成本高；而啟動值量化的誤差不是零均值隨機雜訊，平均消不掉（§11.3 來源 1）。
3. 每欄的縮放 k 受 8 位元範圍限制（真模型上 kMean 約 2.5），沒有更細的格子可用。
4. 不做改動，就沒有可能退步的風險；網頁版現況與 §14 的設計一致。

**待改善（需要決定，本次未做）**

- **飽和要納入門檻**：`minCos` 只看探針估計，看不到剪裁。B=0.02 時 28,473,118 個元素被剪，門檻仍放行（outCosMean 0.9946）。建議：把剪裁比例（`stats.clipped / stats.n`）也納入 `patchQwen3Q8` 的拒絕條件，超過門檻就回報「adapter 太大，網頁版無法可靠套用」。這會讓部分 adapter 從「放行但錯」變成「明確拒絕」，需要決定門檻值（建議先在真 adapter 上量）。
- **探針估計不可靠**：merge 報告的 outRelErrMean 與端到端不一致（B=0.002 時 0.9%，B=0.0002 時 8.5%，但端到端 B=0.002 的差異反而較大）。報告數字只能當粗略參考，不能當準確度指標。

**真正的解法與阻礙（未實作）**

- 要讓網頁版與槽版等價，LoRA 項必須吃 fp32 啟動值，也就是網頁版改用「LoRA 分支」圖（槽版），而不是併權重。
- 阻礙一：lora.bin 要交給 transformers.js（ORT-web）。目前 fetch 攔截只能換掉模型位元組；需要確認 ORT-web 是否支援 externalData，且 lora 檔能經由攔截交付。**未確認。** 依指示不採用「嵌入 adapter 進模型」的做法。
- 阻礙二：網頁版的實際執行只能在瀏覽器內驗證，本機沒有可用的瀏覽器環境來做端到端測試。
- 阻礙三：這會改變網頁版的產品路徑（§14 的設計是併權重），需要使用者同意。

**尚未驗證（誠實列出）**

1. 真實訓練的 adapter：本機沒有（`lora-train/out` 只有評量與煙霧測試輸出），以上全部是隨機 adapter。隨機 adapter 的 ΔW 幅度可能與真 adapter 不同，數字只用來判斷機制。
2. 瀏覽器內的網頁版執行（transformers.js + 攔截）。
3. 真模型上端到端的貪婪輸出品質（不在本次範圍；§11.3 已說明端到端 logits 不能當判準）。

## 12. 資料擴充：函式層切割與思考堆疊（2026-11-12，Linux 機器）

**起因**：§7 第 3、5 點與實跑 `merge_dataset.js` 的結果——UML 切割、思考堆疊、計畫樣板資料各只有 1～20 列，留出集也沒有這幾塊，訓練了也量不出是否變準。

**發現**：種子題庫 377 題的參考解全部只有一個 `main()`，只有 14 題另有函式；所以「由參考解反推切割」沒有現成素材，必須自己重構（見下）。

**新增**
- `lora-train/gen/refactor_split.py`：用 `ast` 把單一 `main()` 機械式重構成 `read_input()`／`solve(...)`／`main()`（前段讀入、後段 print 留在 main、其餘是運算；import 提到最上面）。已有多函式的 14 題沿用原本的函式與呼叫關係。377 題中 190 題可重構、137 題沒有「中段運算」（讀入後直接 print 運算式）、28 題 main 裡有 return／global、8 題開頭沒讀輸入。
- `lora-train/gen/gen_code_split.js`（已登記在 `merge_dataset.js`）：用**真正的** `CodeLoop.solve()`，`ask` 回呼攔截並回答切割題、`write` 回呼攔截並回答逐函式寫作題，組好的整份程式交 `judge-runner.js` 跑 tests＋hidden，沒 AC 的整題丟掉（2 題 RE 被丟）。產出 `fn_template/code_split` 與 `fn_template/code_write_fn`，messages 帶真正的思考堆疊標頭。
- 同一支另跑 `stackChecks:true` 三種版本（clean／第一次寫壞／一直寫壞），收集堆疊自己的三種封閉題 `think_stack/plan_check`、`self_validate`、`review_return`。**答案由程式用結構檢查算出**（函式有沒有定義、參數個數與簽名是否一致、內容是不是只有 `pass`），負例是故意改函式名／拿掉一個參數／換成 `pass`。刻意**不**做「模型讀程式碼判斷對錯」的標籤——0.6B 不能執行程式，那只會學到瞎猜。
- `lora-train/eval_gen.py`＋`score_gen.js`：批次產生輸出（每個 stage 各自的長度上限）、用判題器評分。切割題看 valid（JSON 合法、有 main、calls 都指到清單內）／names／calls；逐函式寫作看「放進標準答案的其他函式後判題器是否 AC」；自問與核對看 ok 欄位。

**資料量（`merge_dataset.js`，2026-11-12）**：總 6294 列、訓練 4170、留出 2124。新增 `code_split` 202（訓練 67）、`code_write_fn` 596（194）、`plan_check` 203（68）、`self_validate` 836（277）、`review_return` 219（76）。

**誠實限制**
- **可用的訓練題只有 67 題**：種子題庫大多放在凍結的 heldout／holdout 檔（135 題），依紀律不進訓練集。要更多訓練題，需要用 `gen_bench_*.py` 的產生器生新題，不是放寬留出。
- 切法是機械式「讀入／運算／輸出」，purpose 是固定句型，不是人類設計師各式各樣的切法；可能讓模型學成固定三段式。要看它在沒見過的題目上有沒有幫助，不能只看 loss。
- `review_return` 的負例只有 13 筆，`self_validate` 的負例 248 對正例 584，比例偏正。
- `uml_design` 的 actors／classes／relations 仍只有 1～4 列（只有單一固定情境），這一輪**沒有**補。
- 基底在這批題上的起點（`eval_gen.py` 抽 8 題煙霧）：切割題 valid 0/8（基底輸出 JSON 陣列而不是要求的物件）、自問 ok 3/8。完整基準與微調結果見下一節（有跑才寫）。

## 13. 多顆 LoRA 註冊與按需載入（2026-11-12，設計）

需求（使用者原話，2026-11-12）：「floating assistant 要可以註冊多個 LoRA，這些 LoRA 要 on demand loading / lazy loading」。

### 13.1 現況（已存在，本節不重做）

- `renderer/src/studio/lora_registry_core.js`：登錄表（`register`、`select`、`ensure`、`request`）、LRU 卸載、記憶體預算（`budgetBytes`，預設 256 MiB）、同時啟用上限（`maxActive`：桌面版 4、網頁版 1）、相容性檢查（基底、rank 槽、提示格式版本、工具清單）、評量門檻（任一組輸給基底就不自動選用）。`lora_registry.test.js` 原有 43 項，§13 新增後為 60 項。
- 桌面版載入路徑：`studio_server_core.js` 的 `/api/lora/load` → `registry.request` → `lora_apply_core.js`（寫信箱 → 主程序 `lora_apply`／`lora_apply_set`）。
- 缺口（本節補的）：
  1. 沒有統一的「描述檔」格式。現有只有 `pack_adapter.js` 產生的 `manifest.json`，而且沒有 `version` 欄位。
  2. `request` 在沒有載入器時會丟例外，呼叫端沒有統一的「退回基底模型」出口。
  3. 每一輪聊天依任務類型路由的呼叫點還沒接（見 13.5）。

### 13.2 描述檔格式：`fa-lora-descriptor` v1（與 lora-manager-2 的約定）

每顆 adapter 的資料夾內放一份 `lora.descriptor.json`，欄位如下：

| 欄位 | 型別 | 必要 | 說明 |
|---|---|---|---|
| `format` | 字串 | 是 | 固定為 `fa-lora-descriptor` |
| `format_version` | 整數 | 是 | 目前為 `1`；未知版本一律拒絕 |
| `id` | 字串 | 是 | 全域唯一，小寫英數與 `-._`，例如 `decompose-r16` |
| `version` | 字串 | 是 | adapter 版本，例如 `1.0.0`（同一 id 換權重就要加版本） |
| `name` | 字串 | 否 | 顯示名稱 |
| `base` | 字串 | 是 | 基底模型 id，例如 `Qwen/Qwen3-0.6B` |
| `base_sha256` | 64 位十六進位 或 null | 否 | 基底模型檔案雜湊（同名不同檔時拒絕） |
| `rank` | 正整數 | 是 | LoRA 秩；必須落在模型的 rank 槽內 |
| `alpha` | 數字 | 否 | 與 PEFT 的 `lora_alpha` 相同 |
| `prompt_format_version` | 整數或字串 | 是 | 提示格式版本；格式改變就要換版 |
| `tool_catalog_sha256` | 64 位十六進位 或 null | 否 | 訓練時的工具清單雜湊；不符只警告 |
| `applies` | 物件 | 是 | 適用條件：`domains`（任務類型陣列）與 `triggers`（正規表示式字串陣列，使用者指令命中就視為想用） |
| `size` | 非負整數 | 是 | 權重總位元組數（分片加總） |
| `sha256` | 64 位十六進位 | 是 | 權重整檔的雜湊；載入前核對 |
| `location` | 字串 | 是 | 檔案位置：`asset:lora/<id>`（工作室資產庫）、`fap:…`（執行包內）或絕對路徑；由載入器解讀 |
| `eval` | 物件 或 null | 否 | 評量結果（`groups` 每組 `{adapter, base}`）；沒有就不自動選用 |

規則：

- 描述檔只描述，不含權重；權重檔以 `size` 與 `sha256` 核對。
- `applies.domains` 的標籤由 lora-manager-2 定義：`decompose`（拆題）、`toolcall`（工具呼叫格式）、`colu`（選單）、`plan`（規劃）。空陣列表示通用，只在沒有領域專屬者時才補上。
- 同一資料夾也可以有 `manifest.json`（`pack_adapter.js` 產生）。有描述檔時，`id`、`version`、`applies`、`location` 以描述檔為準。

### 13.3 註冊、按需載入與快取

- **註冊不載入**：註冊只讀描述檔（與可選的 manifest），不讀權重，不呼叫載入器。
- **選用（路由）**：依 `applies.domains`（任務類型）與 `applies.triggers`（指令比對）選出候選；停用、不相容、沒有評量資料（手動指定除外）、評量輸給基底的不選；同領域只留排序最前者；`conflicts_with` 衝突者跳過。
- **按需載入**：只有被選到的才呼叫載入器；載入成功後進入快取。沒被用到的 adapter 不占記憶體。
- **快取上限**：同時駐留的位元組總和不超過 `budgetBytes`；同時啟用不超過 `maxActive`。超過時卸載 `lastUsed` 最小者（LRU），但不卸載本次計畫內的 adapter。
- **失敗退回基底**：單顆載入失敗（檔案讀不到、雜湊不符、主程序拒絕）只讓該顆進 `skipped`，寫出具體原因，其餘照常。計畫內全部失敗，`active` 為空，呼叫端走基底模型（`fallback: 'base'`）。新增的 `resolve()` 保證不丟例外：沒有載入器或任何未預期錯誤都回基底並附原因。
- **相容性不符**：`reject`，不載入，寫出原因（例如基底不同、rank 不在槽內）。

### 13.4 兩個平台

- **桌面版（nr-engine 原生推論）**：多顆依 rank 串接成一個槽檔，由主程序 `lora_apply_set` 套用，容量不足的逐項拒絕（不截斷）。換組合＝重建推論 session（數秒）。
- **網頁版（transformers.js＋併權重）**：**限制**：`maxActive=1`。併權重必須從原始 q8 位元組重新併入，所以換 adapter 等於重新 patch 整個模型（617 MB，數秒到數十秒），不支援同時多顆。併權重的數值限制（啟動值量化、飽和）見 §11.3–11.4，網頁版的結果**不與桌面版槽版等價**。網頁版若沒有可用的 q8 模型，registry 回基底。

### 13.5 尚未接的部分（阻礙）

- **每一輪聊天依任務類型路由**的呼叫點在 `renderer/src/floating-assistant.js`。該檔內嵌 studio 核心（`scripts/embed-code-ui.js` 的 UMD 清單），改動需要重跑 embed 與 live-update 發佈流程。依指示本次不跑 embed、不發佈，所以這一步尚未接。
- 目前「按需載入」只在工作室的 `/api/lora/load` 生效（使用者在工作室觸發）。
- 接上時的做法：聊天送出前呼叫 `registry.resolve({text, domains})`，回傳的 `handles` 交給 `lora_apply`；`active` 與上一輪相同就不重建 session。

### 13.6 給 lora-manager-2 的產出要求

- 每顆 adapter 一個資料夾，內含 `adapter_model.safetensors`（或 `.partNN` 分片）、`adapter_config.json`、`manifest.json`（`pack_adapter.js`）、`lora.descriptor.json`（本節格式）。
- 描述檔的 `size`、`sha256` 與 manifest 一致；`version` 只在權重改變時增加。
- 四顆：`decompose`、`toolcall`、`colu`、`plan`，各自的 `applies.domains` 與 `applies.triggers` 由 lora-manager-2 填。

### 13.7 測試（`lora_registry.test.js`）

- 描述檔解析：合法、缺 `version`、`format_version` 不是 1、`triggers` 不是合法正規表示式、`size` 或 `sha256` 格式錯誤。
- 註冊不呼叫載入器（懶載入）。
- `resolve()`：沒有載入器時回基底且不丟例外；載入失敗時回基底並附原因。
- LRU：超過 `maxActive` 時卸載最久沒用者；計畫內的不卸。

### 13.8 未驗證

- 真實 adapter 的按需載入延遲（本機沒有真 adapter；載入器是注入的假載入器測試）。
- 聊天呼叫點（13.5）與網頁版的瀏覽器執行。

## 14. 槽位管理：滿了怎麼替換（2026-11-12，實測＋設計）

需求（指揮轉達的使用者問題）：「如果載入的槽用完，有辦法按需要 replace LoRA 嗎」。

### 14.1 槽數是匯出時固定的（已確認）

- 槽版 ONNX 的 LoRA 形狀寫在圖裡：每個目標的 A 是 `[din, R]`、B 是 `[R, dout]`，R 是 `buildSlotModel` 的 `rank`（現在 16）。`layout.json` 的版面也由 R 決定。改 R＝重新轉換（真模型約 4 秒、輸出 617 MB），不是執行期可調。
- 「槽」在程式裡有兩層意思：(a) 總容量 R（rank 總和上限，多顆依 rank 串接，見 DESIGN.TODO.native-runner.md §9.2）；(b) 同時啟用數 `maxActive`（登錄表的上限）。本節的「槽滿」指 (a)，`maxActive` 另外限制。
- 因此每顆 adapter 占用 `rank` 個槽列；R=16 時，rank 8 兩顆就滿。

### 14.2 替換一個槽：要重建工作階段（實測）

真模型（標準版轉成的槽版，rank 16，`scratch` 實測，2 顆 CPU 核心，每項一次）：

| 量測 | 毫秒 |
|---|---|
| 建立基底 session（對照） | 3,898 |
| 基底一次 22 token 前向 | 546 |
| 建立槽版 session（含 lora.bin 外部資料） | 2,157 |
| 槽版一次 22 token 前向 | 533 |
| 換成另一顆 lora.bin 後重建 session | 1,897 |
| 重建後的一次 22 token 前向 | 548 |

**熱換不可行（實測）**：在同一個 session 還活著時，把 `lora.bin` 原地覆寫成另一顆，再跑一次前向，輸出與覆寫前逐值相同（最大差 0）；重建 session 後的輸出則與覆寫前不同（最大差 5.49）。結論：ORT 在建立 session 時把外部資料讀進來，之後檔案改了也不影響既有 session。**替換＝釋放舊 session＋重建**，成本約 2 秒（再加上前向）。

- 推測（未測）：主行程經信箱傳送 40 MB 的 lora.bin（base64）本身也要時間，這段**未量測**，實際替換延遲會更長。
- 推測（未測、需要改圖）：若把 A、B 改成圖的輸入（每次前向餵入），就能不重建 session 直接換，代價是每次前向都要傳 40 MB 或做成常駐張量；這需要改 `lora-slot-build.js` 並重新驗證，本次不做。

### 14.3 淘汰策略（預設）

- 候選＝已載入、**沒釘選**、**沒在推論中**、**不在本次計畫內**的 adapter。
- 依最久未用（LRU，`lastUsed`）卸載，直到新的 adapter 放得下（rank 總和 ≤ R、同時數 ≤ maxActive、位元組 ≤ budgetBytes）。
- 卸不掉（候選都釘選或推論中）：新的那顆寫出原因（「槽已滿，且沒有可卸載的」），不硬塞、不影響已載入的。
- 計畫內的 adapter 一定不被淘汰；計畫本身超過槽容量時，排序最後的那顆被丟棄並寫原因。

### 14.4 替換與回滾（原子性）

`replace(outId, inId, {applyFn})` 的步驟：

1. **先載入新的**。失敗：原狀不動，回報「載入 … 失敗，原狀保留」。
2. **扣掉舊的後看容量**。放不下：卸掉新的、把舊的放回去，回報 `rolledBack`。
3. **通知推論端**（`applyFn(新的組合)`，桌面版是 `lora_apply_set`）。失敗：卸掉新的、重新載入舊的、再套一次舊組合，回報 `rolledBack` 與原因。舊的若無法還原，回報 `state: 'degraded'`，由呼叫端退回基底。
4. **都成功**：釋放舊的，回報 `ok` 與新的 `active` 組合。

限制：舊的釘選或推論中一律拒絕（釘選可用 `force` 繞過，推論中不行）。替換期間新舊 adapter 的位元組會同時駐留一小段時間（記憶體峰值多一顆），這是為了失敗時能還原。

### 14.5 手動替換與卸載

- 手動替換＝`replace`（指定換出與換入）。
- 手動卸載＝`manualUnload`：釘選與推論中都拒絕，與自動淘汰同一套保護。
- 釘選＝`pin(id, on)`，只在記憶體（重啟後要重新釘選；持久化待決定）。
- 推論中＝`acquire(id)`／`release(id)`，推論開始與結束時由呼叫端成對呼叫。

### 14.6 給 LoRA 管理畫面的介面（與 studio-domain-author 對齊）

登錄表（`lora_registry_core.js`）提供：

- `status()` → `{slotCapacity, usedRank, freeRank, maxActive, budget, usedBytes, slots:[…], registered:[model card…]}`。
  - `slots[]`：`{id, name, version, rank, size, loaded:true, pinned, inUse, lastUsed}`，依最後使用時間新到舊排序。
  - `registered[]`：每顆 adapter 的 model card（見下）。
- `card(entry)` → model card：`{id, name, version, description, base, rank, size, domains, triggers, prompt_format_version, source, enabled, location, eval:{lose, win}|null, compat:'ok'|'warn'|'reject', compatReasons, pinned}`。
- 操作：`pin(id, on)`、`manualUnload(id)`、`replace(outId, inId, {applyFn, force})`、`request({domains|text|ids})`（載入）、`register`／`unregister`（註冊移除）、`setEnabled`。
- 每一個操作都回傳 `ok`、`error`（具體原因）與 `active`（目前組合），畫面不需要自己猜狀態。

model card 欄位以 `description`（一句話，來自描述檔，§13.2）與 `version` 為新增；畫面的標題用 `name`，副標題用 `description`，能力標籤用 `domains`，觸發字用 `triggers`。

### 14.7 限制與未驗證

- **網頁版**：`maxActive=1`，換 adapter＝重新併權重（617 MB，數秒到數十秒，未在瀏覽器實測）。網頁版沒有槽，只有「換一顆」。
- **替換延遲的主行程部分未量測**（信箱寫入 40 MB、base64 解碼、主行程的 `lora_apply_set`）。
- 「改圖讓 A、B 成為輸入、可熱換」是推測，未實作、未測。
- 所有實測在 2 顆 CPU 核心（`taskset -c 12-13`）、隨機 adapter 上完成；真實 adapter 的權重值不影響載入時間，但實際機器的核心數會改變數字。

## 15. 聊天每輪 LoRA 路由：源碼與整合步驟清單（2026-11-12，源碼已提交，未 embed）

本節是給整合者（指揮）照做的清單。**本 session 沒有跑 embed，也沒有 build**；下列位置都以本分支目前的源碼為準，行號會因後續修改而變，動手前先用關鍵字確認。

### 15.1 已完成的源碼

| 提交 | 檔案 | 內容 | 測試 |
|---|---|---|---|
| `658843da` | `renderer/src/studio/lora_route_core.js` | 純函式：任務類型→領域（`decompose`、`toolcall`、`colu`、`plan`），`taskDomain`、`decideTurn`、`routeTurn` | `lora_route.test.js` 18 項通過 |
| `f15febb6` | `renderer/src/studio/studio_server_core.js` | `createServer` 回傳 `registry()`（不需要 HTTP 監聽） | `studio_server_core.test.js` 105 項通過 |
| `9084c355` | `renderer/src/floating-assistant.js` | 路由掛鉤：`_loraCore`、`_loraRouteTurn`、`_loraSwitch`、`_llmGenerate`（包裝）、`_llmGenerateInner`（原函式改名，本體未動），三個呼叫點標上 `task` | `node --check` 通過；尚未在瀏覽器實測 |

`routeTurn(registry, task, { prevActive })` 回傳 `{ task, domain, action, active, handles, skipped, fallback, reason }`，`action` 為 `keep`、`switch` 或 `clear`。

### 15.2 每輪行為（以程式為準）

1. **沒有 `task`**（`_loraRouteTurn` 回傳 `null`）：不決定、不切換，維持目前載入的 LoRA。
2. **有 `task`，但沒有對應領域**：回基底（`fallback: 'base'`），不載入任何 LoRA；若目前有載入的，動作為 `clear`，否則 `keep`。
3. **有 `task` 且有對應領域**：向登錄表要該領域的 LoRA（`resolve`）；組合與目前相同就 `keep`，不同就 `switch`（先 clear 再 apply 新組合）。
4. **套用失敗**：清空、回基底，`applied: false`，`applyError` 記原因，`fallback: 'base'`。
5. **推論期間**：生成前對 `active` 逐顆 `acquire`，生成結束（含例外）`release`，推論中不會被淘汰。
6. **路由本身出錯**：`_llmGenerate` 的 `catch` 改為基底，不中斷生成。

### 15.3 整合步驟清單（依序做）

**步驟 A：`scripts/embed-code-ui.js`，第 532 行（`const UMD = [...]`）**
- 在 `'lora_registry_core'` 與 `'lora_apply_core'` 之間插入 `'lora_route_core'`，成為 `'lora_registry_core', 'lora_route_core', 'lora_apply_core'`。
- 理由：`FaLoraRoute` 是全域物件（`lora_route_core.js` 的 UMD 匯出 `root.FaLoraRoute`），`floating-assistant.js` 執行時會讀它；它本身不依賴其他模組。
- 確認 `'studio_server_core'` 仍在同一陣列（已確認，第 532 行含此名）；`_loraCore` 依賴 `FaStudio.FaStudioServer.createServer`。

**步驟 B：`scripts/run-core-tests.js`，第 146 行之後**
- 新增一列（與第 146 行同格式）：
  `['訓練工作室 LoRA 每輪路由（任務→領域、保留／切換／回基底、無領域不載入）', 'renderer/src/studio/lora_route.test.js'],`
- 第 143 行的 `studio_server_core.test.js` 項目已涵蓋 `createServer` 的 `registry()` 與各端點，不需要另加。

**步驟 C：`renderer/src/floating-assistant.js`（源碼已在位，不需再改；整合者只需確認下列標記存在）**

| 位置（本分支目前行號） | 標記 | 作用 |
|---|---|---|
| 約 87358 | `// ===== LoRA 每輪路由（DESIGN.lora-training.md §15）` | 區段註解，之後的四個方法都屬於這段 |
| 約 87360 | `_loraCore()` | 懶建立 `createServer(this._studioHostApi())`，只取登錄表 |
| 約 87362 | `_loraRouteTurn(task)` | 決定本輪路由 |
| 約 87375 | `_loraSwitch(route)` | 依路由 clear／apply，失敗回基底 |
| 約 87384 | `_llmGenerate(model, a, cb)` | 包裝：路由 → 切換 → acquire → `_llmGenerateInner` → release |
| 約 120607 | `_llmGenerateInner(model, a, cb)` | 原本的 `_llmGenerate` 本體，**不要刪、不要改名回去** |

**步驟 D：`task` 標記的呼叫點（已標）**

| 行號 | 呼叫 | 標記 |
|---|---|---|
| 約 117569 | 選單（`SEL.selectionMessages`） | `task: 'colu'` |
| 約 117574 | 工具參數（`SEL.argsMessages`） | `task: 'toolcall'` |
| 約 120746 | 工具階段（`FaVlm.TOOL_STAGE_SYSTEM`） | `task: 'toolcall'` |

**步驟 E：`decompose` 與 `plan` 的呼叫點（2026-11-12 總指揮已接上，見提交 a07d68cd；下面的搜尋結果是接上之前的紀錄）**
- 實際呼叫點：食譜規劃與 UML design 都經 `_planModel`（`floating-assistant.js`）；它的生成預設標 `task: 'plan'`，`_umlModel`（UML design 拆解、寫函式、自我驗證）呼叫 `_planModel({ task: 'decompose' })`。線上模型路徑不看 `task`，不受影響。
- 驗證：`lora_route_wiring.test.js` 10 項（原始碼接線）；尚未重新建置、未在產品視窗實測。
- 搜尋結果：`floating-assistant.js` 內沒有以 `task: 'decompose'` 或 `task: 'plan'` 呼叫 `_llmGenerate` 的地方。
- 同名的 `decompose`／`plan` 都不是 LLM 呼叫：`FaHarness.decompose`（約 59158，離線規則）、`TP.expand`（約 61833，離線模板）、`planBatch`（約 32722，瀏覽器代理）。
- 因此目前這兩類任務在聊天中**沒有**切到對應 LoRA；依 15.2 第 1 點，它們會沿用目前載入的 LoRA（若有）。
- 待辦：找出「拆解」與「規劃」真正送進模型的生成呼叫，補上 `task: 'decompose'`／`task: 'plan'`。找到之前，這兩類不要宣稱已接好。

### 15.4 核心測試清單（整合後應全部通過）

| 檔案 | 項數 | 來源 |
|---|---|---|
| `renderer/src/studio/lora_route.test.js` | 18 | 步驟 B 新增 |
| `renderer/src/studio/lora_registry.test.js` | 79 | 既有（`run-core-tests.js` 第 146 行） |
| `renderer/src/studio/studio_server_core.test.js` | 105 | 既有（第 143 行） |
| `tests/native/lora_slot_equiv.test.js` | 8 | 原生（槽版等價） |
| `tests/native/lora_slot_build.test.js` | 38 | 原生（槽版轉換） |
| native_lora | 65 | 原生 manifest 已 refreeze（`ffc28738`） |

### 15.5 未驗證（整合後要補的）

- 瀏覽器中的網頁版路由未實測；網頁版 `maxActive=1`，切換時要重新併權重（見 §14.7）。
- `decompose`、`plan` 的呼叫點未找到（15.3 步驟 E）。
- 真實聊天中的切換延遲與回基底的體感，未量測。
- embed 後的 UMD 載入順序（步驟 A）未在打包產物中驗證。

### 15.6 合併狀態與順序（2026-11-12）

本分支 `claude/lora-slot-equiv`（`e9cc0b4b`）相對 `desktop-app`（`4c5b5e15`）領先 19 個提交、落後 0 個。**尚未合併任何分支，也沒有 push。**

#### 15.6.1 與其他分支的關係

| 對象 | 共同基底 | 雙方都改的檔案 | 結果 |
|---|---|---|---|
| `desktop-app` | `4c5b5e15` | 無 | fast-forward，無衝突 |
| `claude/studio-domain-author-dcb72c`（`55bba55b`，領先 21 個提交） | `4c5b5e15` | `studio_server_core.js`、`studio_server_core.test.js`、`scripts/embed-code-ui.js` 第 532 行 | 見下 |
| `lora-train-eval`（`0d638c0e`，領先 7 個提交） | `4c5b5e15` | `DESIGN.lora-training.md`（只有這個檔） | 程式無衝突；文件要手動合併 |

與 studio 分支的衝突點：

- `studio_server_core.js`：雙方都改，但自動合併成功。
- `studio_server_core.test.js`：一個衝突區塊，在 `/api/info` 的分頁數。對方為 10 個分頁（新增「流程」分頁），我方為 9 個。**取對方**，並保留對方的 `/api/pipeline`、`/api/advice` 檢查；我方的 `/api/lora/replace`、`status.replacing` 檢查位於別的區塊，會自動保留。
- `scripts/embed-code-ui.js` 第 532 行（`const UMD = [...]`）：對方改了同一行。步驟 A 要在 `'lora_registry_core'` 後面插入 `'lora_route_core'`，整合時要連同對方的新增項一起保留，不是取其中一邊。

驗證（暫存 worktree，已刪除，未 commit）：以 `git merge -X theirs claude/studio-domain-author-dcb72c` 合併後，`studio_server_core.test.js` 109 項、`lora_registry.test.js` 80 項、`lora_route.test.js` 18 項全部通過。`-X theirs` 只影響衝突區塊；不加這個參數時，衝突只有上面那一個區塊。

#### 15.6.2 `DESIGN.lora-training.md` 的合併規則

- 雙方都新增了 §13 起的段落，編號衝突：我方 §13（多顆 LoRA 註冊與按需載入）、§14（槽位管理）、§15（本節）；對方 `lora-train-eval` 也用 §13、§14、§15（其中 §15 是「訓練要點調整」）。
- 規則：**我方保留 §13–§15**，因為程式註解已引用這些編號（`lora_registry_core.js` 的 §13／§14、`floating-assistant.js` 的 §15）。對方的段落改為 §16 起，並更新它段落內的交叉引用。
- 合併後檢查：`grep -n "^## 1[3-9]" DESIGN.lora-training.md` 每個編號只能出現一次。
- 這一條需要 `lora-train-eval` 那邊的作者同意改編號；我沒有改對方的文字。

#### 15.6.3 建議合併順序

1. `desktop-app` ← 本分支（fast-forward）。
2. `claude/studio-domain-author-dcb72c`：衝突點見 15.6.1，兩處已驗證。
3. `lora-train-eval`：依 15.6.2 手動處理 DESIGN 文件。
4. 最後才做 15.3 的步驟 A、B（embed UMD 與核心測試清單）；embed 與 build 由整合者執行，不在本分支做。

### 15.7 接手節（給下一位接手的人）

- **已提交**：`97ee7942`（§15 整合清單）、`e9cc0b4b`（替換端點 `outId`／`inId` 與 `status().replacing`）；之前的路由與登錄表提交見 15.1。
- **既有失敗已修**：native_lora 2 項（`ffc28738`，refreeze `nr-engine.js` 的內嵌清單）、studio_server_core 2 項（`7bc932da`，版面期望值）。目前 native_lora 65 項、native_lora_merge 20 項、studio_server_core 106 項全部通過。
- **未完成**：
  - `decompose`、`plan` 的生成呼叫點尚未找到（15.3 步驟 E）。
  - 步驟 A、B 與 embed／build（整合者做）。
  - 15.6.3 的合併順序（需要使用者或指揮決定執行）。
  - 網頁版路由的瀏覽器實測（§14.7）。

## 16. 可暫停、可接續訓練（2026-11-12，實測）

**做了什麼**（`lora-train/train_lora.py`）
- 每個 checkpoint（`save_steps`）寫一份 `checkpoint-N/fa-ckpt.json`，對照 `DESIGN.TODO.offline-training-studio.md` §3.1：step、epoch、cursor（seed 重現的洗牌＋已消耗的 micro-batch 數）、rng、optimizer（lr、linear schedule）、data_sha256、compat（base、rank、alpha、target_modules、prompt_format_version、tool_catalog_sha256）、produced_by、loss_tail。
- **與 §3.1 的差異（寫在檔內 `differences` 欄位）**：權重與優化器仍是 HF Trainer 原生檔（adapter_model.safetensors、optimizer.pt、scheduler.pt、rng_state.pth），不是 lora_A/B.f32、opt_m/opt_v；rng 不是 PCG32；資料游標沒有 shard/offset，靠 seed 重現洗牌並跳過已看過的 micro-batch。
- `val_fraction=0` 現在代表不建驗證集（之前會保留 1 列）。
- 測試用環境變數 `LORA_TRACE_FILE`：每個 micro-batch 寫一行內容雜湊。

**實測**（`lora-train/test_resume.sh`，48 列、6 步、gradient accumulation 2、checkpoint 每 3 步）
- A：一次跑完。B：跑到第 4 步中途 `kill -9`（B 的 trace 有 9 行，已超過第 4 步開始處）。C：從 `B/checkpoint-3` 續訓到第 6 步。
- **loss**：步 1–6 的 loss 在 A 與 C 完全相同（小數六位）。步 4–6 是續訓後的部分，相同代表 optimizer、scheduler、RNG（dropout）都正確還原。
- **資料**：B 前 7 行與 A 相同；C 的前 6 行等於 A 第 7–12 行（步 4–6 的 micro-batch 內容相同，沒有重複也沒有漏掉）。A 與 C 都在最後多一行雜湊，推測是 Trainer 預先取下一批（不參與訓練，未在原始碼確認）。
- 第一次實測失敗（`target_modules` 是 set，JSON 寫不出來）已修；第二次因為評估批次混進 trace 與讀錯 loss 檔路徑無效；第三次有效。測試腳本的通過條件改成比對 `C[:6]==A[6:12]`，這個比對是用同一份 trace 檔人工核對的，腳本改完後沒有重跑。

**尚未做**：`train_multi.sh` 的整批續跑（已完成的顆跳過、做到一半的顆從最新 checkpoint 續）；工作室端的「暫停／續訓」接線；toolcall 目前沒有檢查點，無法從中途接續，這一顆要等它跑完。

## 17. 第一顆 adapter：`decompose`（2026-11-12，實跑）

**訓練**：`out/multi/decompose/`，rank 4、alpha 8、7 個投影、學習率 2e-4、一輪、序列 768、batch 1×累積 8（共 84 步，實跑約 9,425 秒，約 2.6 小時；機器負載 20–60）。資料 677 列（`uml_design` 396、`fn_template` 281；`data/multi/decompose.jsonl`）。驗證集 3%（實際有 eval 的那次）。checkpoint 當時每 100 步，沒有中途檢查點。
**評量資料**：`heldout_v1.jsonl`（與基底基準同一批）。拆題的 135 個留出題與 77 個訓練題**沒有題目重疊**（problem_id 比對，0 重疊）。

| 組別 | 指標 | 基底 | 微調 | 判定 |
|---|---|---|---|---|
| fn_template/code_split | valid（JSON、有 main、呼叫指向函式） | 0/60 | 60/60 | 進步 |
| fn_template/code_split | names（函式名集合相同） | 0/60 | 55/60 | 進步 |
| fn_template/code_split | calls（呼叫關係相同） | 0/60 | 55/60 | 進步 |
| fn_template/code_write_fn | def | 60/60 | 60/60 | 持平 |
| fn_template/code_write_fn | judge（判題器通過） | 8/60 | 20/60 | 進步 |
| uml_design/uml_edit_real | 選擇 | 18/30 | 30/30 | 進步 |
| uml_design/uml_edit_shuf | 選擇 | 16/30 | 30/30 | 進步 |
| think_stack/plan_check | valid | 52/60 | 59/60 | 進步 |
| think_stack/review_return | items | 0/60 | 0/60 | 持平（未改善） |
| think_stack/self_validate | ok | 25/60 | 25/60 | 持平 |
| think_stack/self_validate | neg_ok（負例） | 2/17 | 9/17 | 進步 |
| think_stack/self_validate | **pos_ok（正例）** | **23/43** | **16/43** | **退步** |

**退步**：`think_stack/self_validate` 的正例 23→16。依規則（沒有退步才 pack），**`decompose` 目前不 pack**。
**沒做**：uml 的 actors／classes／members／relations／sequence 留出題（留出檔裡只有 edit 題），所以 uml 結構階段沒有量到。

**接下來（待決定）**：(a) 在 `decompose` 的訓練集裡加入 self_validate 的正例（與 plan 分工，或讓 self_validate 只歸 plan 那顆）；(b) 接受「self_validate 只在 plan 顆處理」，把 decompose 的適用條件（`applies`）限制成拆題提示，然後重新評量。兩者都要用同一批留出題重評。

### 17.1 decompose v1 打包（限縮範圍後，2026-11-12）
- **適用範圍（內）**：code_split、code_write_fn、uml 逐層切割與編輯（`applies.domains=["decompose"]`，`triggers` 為拆題相關的關鍵字）。**範圍外（明確排除）**：think_stack 的 self_validate、review_return、plan_check。排除是設定的意圖；路由是否真的排除，要等 lora-slot-js 的任務路由實作後才算驗證。
- **範圍內退步**：無（code_split valid 0→60/60、names 0→55/60、calls 0→55/60、judge 8→20/60；uml edit 18→30、16→30；def 持平）。
- **範圍外退步**：self_validate 正例 23/43→16/43；負例 2/17→9/17；整體 ok 25/60 持平；review_return 0/60 持平（未訓練）。
- **打包**：`out/release/decompose-r4/`（`pack_adapter.js`，id `decompose-r4`、版本 `1.0.0`、rank 4、20 MB 分片 1 個，大小 10,143,496 位元組）。model_card 的評量數字由 `make_metrics.py` 從 `score_gen.js` 實跑輸出解析（不手寫），只放拆題合法率；function call 格式合法率沒有放（不在本顆範圍）。
- **descriptor 沒有 eval 欄位**：打包時沒有傳評量 JSON，所以描述檔的 `eval` 是 null，lora-slot-js 的「只自動採用有評量者」規則不會自動選它，只能手動選。
- **v2 準備中**：`data/multi/decompose_v2.jsonl` = v1 677 列 ＋ self_validate 正例 191 ＋ review_return 265（正負都收）＝ 1,133 列；排在 toolcall／plan／colu 之後自動開跑（`out/multi/run_v2.log`）。v2 只加正例，負例仍欠缺，評量時會看 neg 是否再退步。

### 17.2 decompose v2 實測（2026-11-12，未取代 v1）

**訓練**：`data/multi/decompose_v2.jsonl`（1,133 列，v1 677 列 ＋ self_validate 正例 191 ＋ review_return 265）；`out/multi/decompose_v2/`，一輪，08:02 正常完成（train_loss 0.398，pid 1219294 為自我比對的卡住監看程序，已殺，沒有影響訓練）。
**評量**：與 v1、基底同一批留出（`heldout_v1.jsonl` 各組 60 列；uml 留出 60 列）。`score_gen.js` 輸出 `out/eval/decompose_v2_scored.txt`；uml 用 `eval_run.py`（`out/eval/decompose_v2_uml.json`）。判準沿用 §6／§18.2（n<20 只報告，不判退步）。

| 範圍 | 組別 | 基底 | v1 | v2 | 與基底比 |
|---|---|---|---|---|---|
| 範圍內 | code_split valid | 0/60 | 60/60 | 60/60 | 進步 |
| 範圍內 | code_split names | 0/60 | 55/60 | 56/60 | 進步 |
| 範圍內 | code_split calls | 0/60 | 55/60 | 56/60 | 進步 |
| 範圍內 | code_write_fn def | 60/60 | 60/60 | 60/60 | 持平 |
| 範圍內 | code_write_fn judge | 8/60 | 20/60 | **16/60** | 進步（但比 v1 少 4） |
| 範圍內 | uml edit_real | 18/30 | 30/30 | 30/30 | 進步 |
| 範圍內 | uml edit_shuf | 16/30 | 30/30 | 30/30 | 進步 |
| 範圍外 | plan_check valid | 52/60 | 59/60 | 60/60 | 進步 |
| 範圍外 | review_return items | 0/60 | 0/60 | 3/60 | 進步 |
| 範圍外 | self_validate ok | 25/60 | 25/60 | 43/60 | 進步 |
| 範圍外 | self_validate 正例 | 23/43 | 16/43 | **43/43** | 進步 |
| 範圍外 | self_validate 負例 | 2/17 | 9/17 | **0/17** | 退步（n=17 < 20，只報告） |

**判讀**
- 範圍內沒有退步（相對基底）。judge 比 v1 少 4 列，這是 v1 → v2 的退步，要記下來。
- 範圍外：正例全對、負例全錯。整體 ok 從 25/60 升到 43/60，但這是「幾乎全判 ok」的模式（43 = 43 正例 ＋ 0 負例），不是真的學會分辨「有缺漏」。這比 v1 的退步更糟：v1 的負例是 9/17。依 §18.2 第 3 條，負例只有 17 列，不能判成退步，但這個模式本身就是問題，不能當成正面結果。
- uml 結構階段仍然沒有留出列（與 v1 相同），沒有量到。

**決定：v2 不取代 v1，也不打包 v2。** 雖然依 n<20 規則不構成退步，但「self_validate 負例全錯、整體偏向 ok」是實質的行為偏差，不應該用只有 17 列的計數規則放過。v1（`decompose-r4` 1.0.0，已依範圍限縮打包）維持不變。若要改進 v2，需要先補 self_validate 負例（且負例要夠多，至少 20 列），並重新登記判準後，依 §18.2 只量一次。

## 18. 第二顆 adapter：`toolcall`（2026-11-12 實跑）

**訓練**：`out/multi/toolcall/`，rank 4、alpha 8、7 個投影、學習率 2e-4、一輪、序列 768，79 步，約 2.5 小時（負載 20–60）。資料 1,301 列（`tool_routing` 264、`toolwire` 144、`when2call` 435、`agent` 250、`writer` 146、`natural` 62；`when2call`／`agent`／`toolwire` 降取樣 40%）。**沒有中途檢查點**（這一顆是在可接續改善之前開始的）。
**評量資料**：`heldout_toolcall_v1.jsonl`（留出 528 列取每 2 列 ＝ 264 列；與基底同一批）。

**function call 格式合法率**（gold 是 tool call 的留出列 80 筆；模型輸出能解析出合法 `<tool_call>` JSON）：**基底 36/80 → 微調 60/80**。

| 組別（節錄） | 基底 | 微調 |
|---|---|---|
| TOTAL（全部留出列） | 126/264 | 186/264 |
| rtool/call（工具參數正確） | 13/55 | 30/55 |
| natural/call | 2/19 | 11/19 |
| tool_routing/choose_tool_full | 3/31 | 25/31 |
| toolwire/wiring | 58/63 | 59/63 |
| seen/unseen/wiring | 28/31 | 28/31 |
| rtool/missing（工具不存在要拒絕） | 0/31 | 0/31 |
| seen/unseen/missing | 0/31 | 0/31 |

**退步**（ship gate：沒有組別退步，且目標組別明顯勝出）：
- **範圍內（function call 任務）**：`group/git` 1/2 → 0/2。n 只有 2，是否為雜訊不能判斷。
- **未勝出**：`rtool/missing`、`seen/unseen/missing`（兩者都是 0 → 0，**不能拒絕不存在的工具**，沒有學到）。
- **範圍外**：這次只評了 toolcall 的留出列，**沒有評 colu、think_stack、decompose 的留出列**，範圍外退步尚未量。

**結論**：依規則不 pack（有一個退步組別，且缺工具拒絕沒學到）。格式合法率明確提升。下一步：補「不存在的工具要拒絕」的訓練資料與留出；範圍外（colu、think_stack）留出評量。

### 18.1 更正：缺工具拒絕其實有學到（事後修正，2026-11-12）
- 我先前寫「缺工具要拒絕 0→0、沒有學到」，**這是錯的**。實際輸出（`out/eval/toolcall.json` 的 `tuned_out`）顯示微調模型會拒絕，句型是「工具清單裡沒有「X」這個工具。最接近的是「Y」…」。
- 原因：`eval_run.py` 的 missing 判準只接受英文句型或「沒有這個」，而拒絕句的工具名夾在「」之間，所以被判成錯。
- 修正：判準加入「工具清單裡沒有」與「沒有「…」這個工具」，然後用 `regrade_toolcall.py` 對已存輸出重新評分（**沒有重跑模型**）。
- **重評結果**：rtool/missing 基底 0/31 → 微調 31/31。group/git 基底 1/2 → 微調 1/2（不是先前算的 1→0；先前的退步是在判準錯誤下算出來的）。重評後**沒有任何組別退步**，原本的 gate 例外不再需要。
- **誠實註記**：判準是在看過輸出之後才修正的。這屬於事後修正，不是預先定義的判準；如果要在正式報告裡使用，應該在新的留出批次上用預先登記的判準再量一次。
- 卡片已更新（toolcall-r4 1.0.0，known_limits 已改寫）。
- 缺工具拒絕的訓練資料其實已經存在（`when2call` 的 `w2c_missing`，訓練列 230 筆，`toolcall` 這顆降取樣 40%）。因此 v2 不需要重新生成這類資料；v2 的重點應該放在留出評量的規模（全部 528 列）與 group/git 的樣本數（目前只有 2 列）。

### 18.2 評量守則（自 2026-11-12 起生效）
1. **先凍結判準，再看輸出**：任何評量的判準（指標定義、句型、門檻、留出範圍）要先寫成檔案並提交，報告引用該提交編號。
2. **判準改了就重新開批次**：看過輸出之後改判準，只能算事後修正，結論要標明「待預先登記判準的新批次驗證」，不可寫成已驗證。
3. **退步判定要有樣本數**：n < 20 的組只報告，不作退步判定；可以用來提出疑問，但不能拿來 pack 或否決。
4. **範圍內與範圍外分欄**：報告退步表要分「適用範圍內」與「範圍外」兩欄，範圍外沒評的要寫「未量」。
5. **已存輸出可以重新評分**（`regrade_*.py`），但重評要註明用的是哪一版判準。
6. **只量一次**：同一批留出列在同一組判準下只量一次。要再量，就要先擴充留出（新批次）並重新登記，不可以拿同一批反覆量到過為止。

## 19. 第三、第四顆 adapter：`plan`、`colu`（2026-11-12 實跑，已打包 v1）

**共同注意**：判準沿用既有的 `score_gen.js`／`eval_run.py`，沒有在看輸出前新登記（這不符合 §18.2 第 1 條的理想流程，已在卡片的已知限制註明）。範圍外沒有量。留出與訓練無題目或 id 重疊（已核對）。

**plan**（rank 4，855 列，think_stack 的 plan_check、review_return、self_validate；留出 60 列 × 3 組，每組抽樣）

| 組別 | 基底 | 微調 | 判定 |
|---|---|---|---|
| plan_check valid | 52/60 | 60/60 | 進步 |
| review_return items | 0/60 | 50/60 | 進步 |
| self_validate ok | 25/60 | 47/60 | 進步 |
| self_validate 正例 | 23/43 | 32/43 | 進步 |
| self_validate 負例 | 2/17 | 15/17 | 進步 |

範圍內沒有退步。與 decompose 不同，plan 在 self_validate 正例上是進步（decompose 是退步 23→16）。

**colu**（rank 4，657 列，colu 541 ＋ blockly_matrix 116；留出 114 列）

| 組別 | 基底 | 微調 | 判定 |
|---|---|---|---|
| colu_letter_choice | 11/57 | 30/57 | 進步 |
| colu_letter_choice_nonefirst | 0/57 | 25/57 | 進步 |

範圍內沒有退步。blockly_matrix 沒有評量。

**打包**：`out/release/plan-r4/`、`out/release/colu-r4/`，各 1 個分片、10,143,496 位元組。卡片的 eval 欄位沒有放（欄位只定義拆題與 function call 格式），數字記在這裡。

**下一步**：`decompose_v2`（1,133 列，約 141 步）正在訓練；v2 的評量依 `EVAL_CRITERIA_v2.md` 的判準（全量 528 列、group/git ≥ 20）。

## 20. toolcall v2 評量（預先登記，2026-11-12；本節只寫判準與步驟，結果在下一次提交補上）

**登記順序（照指揮要求）**
1. 判準：`lora-train/EVAL_CRITERIA_v2.md`，提交 `8df5bad1`，看 v2 輸出之前寫好。計分器 `eval_run.py`、`regrade_toolcall.py` 沒有改動（最後一次修改在 `4242dc62`）。
2. 留出擴充：`lora-train/gen/gen_git_heldout.js`，與本節同一提交。group/git 新增 24 列（git_status、git_log、git_pull、git_push、git_commit、git_clone 各 4 句；人工寫的口語句，不是模板）。腳本以工具 schema 驗證參數（未知參數、缺必填、enum 錯都丟掉），並與訓練檔的使用者句逐字比對，有重複就中止；本次比對結果為 0 重複。
3. 留出檔：`data/heldout_toolcall_v2.jsonl` ＝ v1 的 528 列 ＋ 新增的 24 列 ＝ **552 列**。group/git 由 4 列增至 **28 列**（≥ 20，符合判準）。sha256：`98cba02dc4053eb3fa65e107e6cb04fd166ac5ffed6ea89c6689ed4da7737f1c`。檔案本身不入 git（`data/*.jsonl` 被 `.gitignore` 忽略），由上述腳本與參數重現；新增列的 sha256 為 `a407b5856cd515b472a9d86b10f69287086af9995856cb86cbae836c73d42a61`。
4. 量測：`eval_run.py`，`LORA_EVAL_EVERY=1`（全部列），基底與 toolcall-r4 同一批 552 列，只量一次。判準同 `EVAL_CRITERIA_v2.md`：格式合法率（主要，微調 ≥ 基底 + 10 個百分點）；缺工具拒絕（句型表）；退步＝n ≥ 20 且微調少 ≥ 2 列；範圍內（toolcall）與範圍外（colu、think_stack、decompose）分欄，範圍外若沒量就寫「未量」。

**本次不重訓**：v2 量的是 toolcall-r4 的權重（v1 訓練的那版），在上述凍結判準下的表現。缺工具拒絕的訓練資料（`when2call` 的 `w2c_missing`，訓練池 `data/train.jsonl` 內 230 列，`data/multi/toolcall.jsonl` 降取樣後 103 列）本來就在 v1 的訓練集內，不需要重新生成；沒有其他指定的新增訓練資料，所以不重訓。若要重訓，須先指定新增資料，視為新版本，並開新的留出批次。

**事後修正的紀錄方式**：量完之後若要改判準，只能寫成事後修正，附上判準改動的提交與理由，結論標明「待新批次以預先登記判準驗證」，不可寫成已驗證。

## 21. 完整微調與匯出（GGUF／ONNX）：`lora-train/` 側骨架與需求（2026-11-12，只有設計，尚未下載任何工具）

使用者原話：「我希望我們的訓練工作室不只用來產生LoRA，也能基於基礎的那包qwen，經過資料輸入訓練，產生更強的model，可以選gguf, onnx，預設以當下環境(網頁/desktop-app native) 優先」。

**app 實際吃的格式**：桌面版 `nr-engine.js` 只吃 ONNX（onnxruntime-node）；網頁版是 transformers.js／ort-web 的 ONNX q8。GGUF 目前只用於評量（`scripts/eval/mini_llama_server.py`）與候選的 Vulkan 後端。所以預設格式不能寫死：`lora-train/export_plan.js` 的 `pickFormats(env)` 依「網頁／桌面」與「有哪些後端」回傳可用格式與預設（網頁→ONNX q8、桌面→ONNX q8、有 llama.cpp 後端才把 GGUF 列為可用），並列出缺的工具。純函式、有自測（`node lora-train/export_plan.js`），已驗證通過的只有這個函式本身。

**兩條路**
1. **LoRA 訓練後合併再匯出（較實際）**：`merge_and_export.py`（已有，輸出 fp32 safetensors）→ 匯出 ONNX（要 optimum 或自寫 `torch.onnx.export`，輸入輸出必須與 app 吃的 q8 圖一致：`input_ids`／`attention_mask`／`position_ids`／`past_key_values.*`）→ q8 量化；或 `convert_hf_to_gguf.py` → `llama-quantize`。
2. **全參數微調**：記憶體粗估 fp32 權重 2.4 GB＋梯度 2.4 GB＋AdamW 狀態 4.8 GB≈10 GB 再加啟動記憶體；這台 CPU 能跑，但每步比 LoRA 慢很多，沒有實測；網頁版 WASM 做不到。

**缺的東西（都要下載，需使用者直接同意後才做，這一節不下載）**：`optimum`（pip）、llama.cpp（`convert_hf_to_gguf.py`、`llama-quantize`）、ONNX 量化用的函式庫。**尚未驗證**：匯出圖與 app 的 q8 圖輸入輸出是否一致、量化後精度。工作室 GUI 那一側由 studio-domain-author／指揮線負責。

### 13.1 匯出工具與實測（2026-11-12，使用者已同意兩項下載，範圍僅限這兩項）
- **llama.cpp**：`github.com/ggml-org/llama.cpp` 標籤 **b12286**（`archive/refs/tags/b12286.tar.gz`，38,850,877 位元組，sha256 `52fa612d…ab8e7`），解在 `~/fa/third_party/llama.cpp-b12286/`（不進倉庫）；用 cmake＋g++ 編出 `llama-quantize`。
- **optimum**：PyPI `optimum-onnx[onnxruntime]==0.1.0`（連帶 optimum 2.1.0、transformers 4.57.6、onnxruntime 1.31.1、onnx 1.23.2、huggingface_hub 0.36.2 等）。optimum 2.x 把 ONNX 匯出拆到 optimum-onnx，且釘 `transformers<4.58`，若裝進訓練用 `.venv`（transformers 5.22.2）會被降版，所以改裝在**獨立的 `~/fa/desktop-app/lora-train/.venv-export`**（240 MB；用一個 .pth 借用訓練 venv 的 torch，沒有重新下載 torch）。訓練 `.venv` 驗證過沒被動到（transformers 仍 5.22.2）。這與「裝進 .venv」的指示不同，原因就是上述版本衝突。
- **GGUF（基底實測）**：`convert_hf_to_gguf.py`（`PYTHONPATH=gguf-py`）→ f16 1,509,347,264 位元組 → `llama-quantize Q8_0` 804,753,344 位元組，數秒完成。**尚未用 llama.cpp 跑推論核對品質。**
- **ONNX（基底實測）**：`optimum-cli export onnx --task text-generation-with-past --dtype fp32 --no-post-process`（不加 `--no-post-process` 時後處理步驟丟錯）。輸出圖輸入 59 個、輸出 57 個，名稱與 app 吃的 `onnx-community/Qwen3-0.6B-ONNX` q8 圖**完全相同**（`input_ids／attention_mask／position_ids／past_key_values.*`）。fp32 ONNX 對 HF 的最後位置 logits：cos 1.0、top1 3/3（3 個提示）。
- **q8 量化**：`onnxruntime.quantization.quantize_dynamic`。整層共用一個縮放（預設）cos 最差 0.669；`per_channel=True,QUInt8` 三個提示 cos 0.943／0.787／0.796；`per_channel=True,QInt8` 0.940／0.853／0.910；**官方 q8 圖本身對 fp32 是 0.926／0.748／0.785**。所以採 per_channel＋QUInt8（權重型別與官方圖相同，品質不比官方差）。q8 模型 754 MB。
- **沒驗證**：量化圖與官方 q8 圖的節點結構不同（官方是 ORT 融合後的 SimplifiedLayerNormalization／RotaryEmbedding、`attn.q_proj.MatMul.weight_quantized` 命名），`lora-slot-build.js` 槽版轉換器能不能直接吃我們量化出的圖，**尚未驗證**；桌面版與網頁版載入執行也未驗證。腳本：`lora-train/export_onnx.py`（一條命令：匯出→量化→logits 核對）。

## 22. 基底完整基準（2026-11-12，`eval_gen.py --per_stage 60`，留出檔，貪婪解碼，基底 Qwen3-0.6B，`node score_gen.js`）
| 組別 | 指標 | 基底 |
|---|---|---|
| fn_template/code_split | valid／names／calls | 0/60、0/60、0/60 |
| fn_template/code_write_fn | def／judge（判題器 AC） | 60/60、8/60 |
| think_stack/plan_check | valid | 52/60 |
| think_stack/review_return | items | 0/60 |
| think_stack/self_validate | ok（負例 ok／正例 ok） | 25/60（2/17、23/43） |
既有領域（when2call、agent、wiring、colu…）的基底分數要在微調評量時由 `eval_run.py` 同批算出（它一次跑基底與微調）。

## 23. 訓練要點調整（2026-11-12 使用者原話）：未知題目拆題＋function call 格式、多顆可按需載入的 LoRA

使用者原話：「我想要我們LoRA訓練的要點是對於未知題目拆題，function call格式有足夠的能力。float assistant要可以註冊多個LoRA，這些LoRA要on demand loading / lazy loading」。

**1. 優先順序與評量**
- 訓練優先：(a) 未知題目拆題（`fn_template/code_split`、`code_write_fn` 與 UML 逐層切割 `uml_design/*`）；(b) function call 格式（所有 tool call 的 recipe：輸出格式合法率、參數欄位正確率；既有的 `when2call`／`agent`／`wiring`／`tool_routing` 與 `natural`）。
- 評量一律用沒進過訓練的題：現有留出檔（`heldout_v1.jsonl`，與基底基準同一批）；另外要有一組「題型完全沒進過訓練」的 unseen 組（拆題用留出題庫的 135 題中的重構切法、未出現在任何訓練題種子的題；function call 用沒有進訓練的工具名）。報告固定列：拆題合法率（`code_split valid`）、function call 格式合法率與參數欄位正確率，**基底對微調**，退步組別逐一列出。
- 基底現況（§22）：拆題 valid 0/60；review_return 0/60；code_write_fn judge 8/60。function call 組要等 `eval_run.py` 的基底欄位。**尚未做**：unseen 組的正式切分與基底數字。

**2. 多顆 LoRA（不訓練一顆大的）**
- 依領域切成可獨立載入的多顆，各自訓練、評量、打包：`decompose`（拆題：code_split／uml 切割）、`toolcall`（function call 格式：when2call／agent／wiring／tool_routing／natural）、`colu`（選單選擇）、`plan`（plan 規劃／think_stack）。各顆預設 rank 8（合計不超過載入端的槽數，槽數上限待 lora-slot-js 回覆）。
- **描述檔**：沿用 `pack_adapter.js` 的 `manifest.json`，新增 `id`、`version`、`description`、`applies_when:{stages:[…],prompt_format_version}`；既有的 `size`（`total_size`）、`base`、`rank`、`eval` 保留。格式已用 `SendMessage` 提給 lora-slot-js（載入／註冊由它實作），**尚未收到回覆**，回覆後依它的介面調整。
- **載入**：按需（on demand／lazy）：註冊時只讀描述檔；第一次遇到符合 `applies_when` 的提示才載入該顆權重。實作歸 lora-slot-js。
- **取捨（尚未驗證）**：多顆各自 rank 8 的總表達力與一顆 rank 16 的比較、多顆同時合併時互相干擾，都還沒實測。
## 24. toolcall v2 量測結果（2026-11-12，預先登記見 §20，判準見 `EVAL_CRITERIA_v2.md`，登記提交 `18180851`）

**量測**：`toolcall-r4` 權重（v1 訓練那版，**未重訓**），`data/heldout_toolcall_v2.jsonl`（552 列，sha256 `98cba02d…737f1c`），`eval_run.py`，`LORA_EVAL_EVERY=1`，只量一次。輸出 `out/eval/toolcall_v2.json`、`out/eval/toolcall_v2.log`、`out/eval/toolcall_v2_metrics.json`。

**判準逐條**（`EVAL_CRITERIA_v2.md`）

| 條 | 內容 | 結果 | 判定 |
|---|---|---|---|
| 1 | 格式合法率（gold 含 tool_call 的 202 列，主要指標，微調 ≥ 基底 + 10 pp） | 基底 111/202（0.5495）→ 微調 156/202（0.7723），+22.3 pp | **通過** |
| 2 | 缺工具拒絕（`rtool/missing`、`seen/unseen/missing`，同 55 列） | 0/55 → 53/55 | **通過** |
| 3 | 退步（n ≥ 20 且微調少 ≥ 2 列） | 無組別符合。`toolwire/wiring`（n=126）117 → 116，`seen/unseen/wiring`（n=62）57 → 56，都只少 1 列 | **無退步（依判準）** |
| 4 | 範圍：範圍內＝toolcall；範圍外＝colu、think_stack、decompose | 範圍內見上；**範圍外本次未量** | 未量 |

**注意：`eval_run.py` 自己的 ship gate 與判準不同。** 它的「no group regresses」會把少 1 列也算退步，所以標成 FAIL，列出 `toolwire/wiring` 與 `seen/unseen/wiring`。依 EVAL_CRITERIA_v2 第 3 條（少 ≥ 2 列才算），這兩組不構成退步；兩份結果都保留，不改判準。另外它的「clearly win」目標組判定只有 `group/worksheet`（n=6，0 → 1）沒過，屬於 ship gate 的啟發式，不在 v2 判準內。

**主要分組（節錄）**

| 組別 | 基底 | 微調 |
|---|---|---|
| TOTAL（552 列） | 258/552 | 435/552 |
| rtool/call | 20/110 | 58/110 |
| seen/unseen/call | 21/116 | 64/116 |
| seen/seen/call | 22/56 | 34/56 |
| tool_routing/choose_tool_full | 6/61 | 47/61 |
| group/git（全部 28 列） | 15/28 | 17/28 |
| 　其中新增的 24 列 | 14/24 | 15/24 |
| 　其中原本的 4 列（`git_inspect`） | 1/4 | 2/4 |

**觀察（不改判準）**
- 新增的 git 列幾乎沒有提升（14 → 15，24 列）。失敗多數是參數 `ref` 漏了 `fap:` 前綴（例如輸出 `"報告"`、`"tools-repo"`），或是模型回了拒絕句。計分器是精確比對參數，所以這些算錯。這表示 group/git 的進步主要來自原本的 `git_inspect` 那幾列，樣本太少，不能當成 git 能力已學好的證據。
- `toolwire/wiring` 少 1 列，屬於邊界內的雜訊，但仍應在報告中看到。

**結論**：`toolcall-r4` 的 v1 權重在凍結判準下通過（格式合法率、缺工具拒絕、範圍內無退步）。範圍外（colu、think_stack、decompose）還沒量，所以「範圍外無退步」不能宣稱。已打包的 `toolcall-r4` 1.0.0 的卡片數字還是 v1 的 80 列（0.45 → 0.75），沒有改成這次 v2 的數字；要不要改成這次的數字、以及是否補量範圍外，待指揮決定，這次沒有重新打包。


## 25. 訓練出新模型並匯出 ONNX／GGUF（2026-11-12，路徑 A 與 B 實測；工作室接線已寫、已測核心，待嵌入）

使用者原話（2026-11-12）：「我希望我們的訓練工作室不只用來產生LoRA，也能基於基礎的那包qwen，經過資料輸入訓練，產生更強的model，可以選gguf, onnx，預設以當下環境(網頁/desktop-app native) 優先」、「麻煩讓離線訓練工作室達成可以訓練出新的onnx,gguf!」。

**結論先講**
- 路徑 A（LoRA → 合併 → ONNX q8／GGUF Q8_0）**流程全通**：fp32 ONNX 與 HF（PyTorch）逐字一致（96/96 貪婪 token）；GGUF Q8_0 用 llama.cpp 的 llama-server 實際推論，**貪婪 token 不能逐字對上**。
- **q8 品質不達標**：ONNX q8（動態量化）與 HF 的貪婪 token 只有 19–39／96 連續對上（全部 6 題都對上的只有 0–2 題）。改善後首步 logits 餘弦平均由 0.922 提到 0.989，但貪婪 token 沒有跟著變好，所以**不能宣稱 q8 與基底等價**。GGUF Q8_0 的貪婪對得比 ONNX q8 好（70/96），但仍非逐字一致。
- 路徑 B（完整微調）**能跑、能暫停續訓、輸出能走路徑 A 的匯出**，只跑了 4 步 smoke；沒有做品質訓練，**不宣稱模型變強**。

### 25.1 工具與來源（已同意的下載，不重下）
| 項目 | 來源與版本 | 位置（專案樹外） | 實際大小／備註 |
|---|---|---|---|
| llama.cpp | `ggml-org/llama.cpp` b12286（§13.1） | `~/fa/third_party/llama.cpp-b12286/` | 本次另外編出 `llama-cli`、`llama-server`（cmake target，已 build）；`llama-quantize` 沿用 |
| optimum＋onnxruntime 匯出環境 | §13.1：`.venv-export`（optimum-onnx 0.1.0、transformers 4.57.6、onnxruntime 1.31.1） | `~/fa/desktop-app/lora-train/.venv-export` | 沿用，未重裝 |
| 基底 Qwen3-0.6B | 既有 | `~/fa/desktop-app/lora-train/models/Qwen3-0.6B`（bf16，1.5 GB） | 沿用 |
| adapter `toolcall-r4` | 既有（PEFT，rank 4，alpha 8） | `~/fa/lora-export-work/adapter`（由 `join.js` 重組，sha256 `65b3247f…2376bac` 與 manifest 相符） | 10,143,496 位元組 |

**沒有新增任何下載**。`onnx_ir`（weight-only 量化要的）沒裝，因為它不在已同意的清單裡，所以 weight-only 方案**未試**。

### 25.2 路徑 A 的實作與修正
- `lora-train/merge_and_export.py`（改寫）：tokenizer 取自基底；合併前後首步 logits 最大絕對差 **2.96e-05**（PEFT vs 合併後）。
- **重要修正（實測發現）**：transformers 5.22.2 存的 `config.json` 把 `rope_theta` 改放進 `rope_parameters`，transformers 4.57.6 讀不到就退回預設 10000。實測 4.57 讀 5.x 存的合併權重，首步 logprob 偏掉約 0.2（`-3.297` vs 正確的 `-3.09`；llama.cpp 與 5.x 一致）。修正：合併與訓練存檔都改回基底的 `config.json`（架構相同）。**在這個修正之前產出的任何數字都作廢。**
- `lora-train/export_onnx.py`（改寫，分 convert／quantize／verify／pack 四步，每步印一行 JSON）。
- `lora-train/export_gguf.py`（新增，同樣四步；verify 用 llama-server `/completion`，`temperature 0`，`top_k 1`，`return_tokens`）。

### 25.3 路徑 A 實測（`~/fa/lora-export-work/run2`，參考＝合併後模型的 HF fp32，6 個提示，每個 16 個貪婪 token）
| 產物 | 大小（位元組） | 首步 logits 餘弦（平均／最小） | top-1 | 貪婪 token 連續對上（逐題全對） |
|---|---:|---|---|---|
| ONNX fp32 | 3,007,960,375 | 1.000000／1.000000 | 6/6 | 96/96（6/6） |
| ONNX q8，recipe=full（所有 MatMul 量化，與官方 q8 同結構） | 756,736,915 | 0.9221／0.8324 | 4/6 | 39/96（2/6） |
| ONNX q8，recipe=mixed（`down_proj` 保留 fp32） | 1,020,789,092 | 0.9886／0.9794 | 3/6 | 19/96（0/6） |
| GGUF f16 | 1,198,182,240 | 未量（llama-server 不回完整 logits） | — | —（只做轉換） |
| GGUF Q8_0（llama-server） | 639,446,880 | 未量 | — | 70/96（3/6） |

- 合併後 safetensors：2,384,234,968 位元組（fp32）。
- 這些數字與 `check.json`／`check_gguf.json`（`~/fa/lora-export-work/run2/`）相同。

### 25.4 q8 品質：查明原因與改善嘗試（全部用同一參考）
- **原因（有證據）**：ORT 的 `quantize_dynamic` 對啟動值用**每個張量一個縮放**（per-tensor，uint8）。Qwen3 的 `down_proj` 輸入（SwiGLU 之後）有大離群值，這一層的量化誤差最大。把 28 層 `down_proj` 留在 fp32，餘弦平均從 0.922 升到 0.989（最小從 0.83 升到 0.98）。
- **沒用的**：排除 `lm_head`（它本來就是 fp32，只是讓圖變大）；QInt8 權重（`C_pc_QInt8`，對比 QUInt8 沒有更好，見 `scratch` 探測，未納入產物）。
- **沒有改善貪婪一致性**：mixed 的餘弦最好，貪婪反而不如 full（19 vs 39）。原因推測：這個模型在測試提示上的首步分佈很平（top-1 機率只有約 0.04），貪婪解碼對很小的誤差很敏感。這是**推測**，未驗證；要判定需要更大的留出集與分佈級的指標（例如 KL）。
- **與官方 q8 比較：沒有重做**。§13.1 的舊比較是「q8 對 fp32 ONNX」的另一種指標，不能和這裡的「對 HF」直接比。
- **recipe 的取捨（已寫進預設）**：預設 `full`（與官方 q8 同結構，`lora-slot-build.js` 的 196 個 `MatMulInteger` 目標都在，**可以再套 LoRA 槽**）；`mixed` 餘弦較好但**不能再套 LoRA 槽**（槽轉換器要求每層都是 `MatMulInteger`）。

### 25.5 路徑 B：完整微調（`lora-train/train_full.py`，新增）
- 沿用 `train_lora.py` 的資料類別、collator、`StopFileCallback`；**不包 PEFT**，整個模型 fp32 可訓練（可訓練參數 596,049,920）。
- smoke（`~/fa/lora-export-work/full-smoke`）：資料 `~/fa/desktop-app/lora-train/data/train.jsonl`（4,746 筆），batch 2、grad accum 1、seq 512、lr 1e-5、4 步：**訓練 18.3 秒（約 4 秒／步）**，**峰值 RSS 14,494 MB**，總耗時約 26 秒（含載入與存檔）。
- 暫停／續訓（`full-pause`）：`--stop_file` 存在 → 第 1 步後存 `checkpoint-1` 並停（`[paused] step=1`）；`--resume_from_checkpoint checkpoint-1` 接續到第 4 步（`steps=4`）。`fa-ckpt.json` 的 `step` 為 1。
- 輸出（HF 資料夾，`config.json` 已換回基底）→ **走路徑 A 的匯出**：`pathB-export`：fp32 ONNX cos 1.000000、96/96；q8 full cos 平均 0.9247、top-1 3/6、貪婪 20/96；GGUF Q8_0 貪婪 61/96。
- **沒有品質評量**：4 步 smoke 的 loss 在 1.8 到 0.37 之間跳（batch 2，無法判斷趨勢），**不宣稱變好**。完整訓練（資料量、步數、留出評量）不在本次範圍。
- 磁碟：完整微調每個 checkpoint 另有約 4.8 GB 優化器狀態；`save_total_limit=2`。

### 25.6 工作室接線（已寫、已測核心；未嵌入）
- `renderer/src/studio/llm_export_core.js`（改寫）：`EXPORT_PLANS` 的五步全部 `runner: true`（腳本存在）；工具改為 `optimum`、`onnxruntime`、`llamaCpp`、`peft`；新增 `buildStepCommands(format, o)`（純函式，argv 陣列、不經 shell）、`runExportSteps(cmds, runner, opts)`（依序執行，遇錯停止，後續標「未執行」）、`parseStepResult`。`LLM_TRAIN_MODES.full` 改為 `implemented: true`（有腳本、只跑過 smoke）。
- `renderer/src/studio/studio_host.js`（改寫）：探測不再只看 PATH——`lora-train/.venv`（peft）、`lora-train/.venv-export`（onnxruntime、optimum-cli）、`<userData>/studio-host/llm-export-config.json` 的 `{llamaBin, llamaSrc, trainPython, exportPython}`（llama.cpp 只能設定）。新 op：`studio_llm_export`（背景執行、每次新工作資料夾、工具不齊直接拒絕、不啟動子行程）、`studio_llm_export_status`。
- `renderer/src/studio/studio_server_core.js`（改寫）：`GET /api/llm/tools`、`POST /api/llm/export`、`GET /api/llm/export/status`；網頁版回 `notDesktop`。
- `renderer/src/studio/studio-viewer.template.html`（改寫）：「訓練」分頁底部新增「LLM 匯出（ONNX／GGUF）」：格式、LoRA 資料夾、基底資料夾、匯出按鈕、檢查工具、每一步狀態（網頁版顯示「只能匯出設定、實際匯出在桌面版」）。
- 工作資料夾結構：`<workDir>/merged`（合併後 HF）、`<workDir>/<onnx|gguf>/…`、`<workDir>/export_job.json`；ONNX 與 GGUF 的 `manifest.json`（檔名、大小、sha256）與 `check*.json`。
- **未做**：（a）**資產列表**：`asset_core.js` 的 `KINDS` 沒有 `llm`，而且資產是記憶體中的 `{manifest, files}`，放不下 3 GB 的 ONNX；目前成果只在輸出資料夾，**沒有進資產列表**。（b）**桌面版載入**：`nr-engine.js` 的 `loadModel(modelPath, tokenizerPath, …)` 接受任意路徑，匯出資料夾已經放了 tokenizer 檔；但設定頁沒有選單，也**沒有實際載入驗證**（沒有執行 Electron）。（c）**取消匯出**：沒有做。

**需要總指揮嵌入的檔案**（`scripts/embed-code-ui.js` 的來源；`studio_embed.test.js` 目前會因為嵌入還是舊的而失敗，這是預期的）：
- `renderer/src/studio/llm_export_core.js`（嵌入 `floating-assistant.js` 的 STUDIO 區塊，名稱 `FaStudioLlmExport`）
- `renderer/src/studio/studio_host.js`（主行程端）
- `renderer/src/studio/studio_server_core.js`
- `renderer/src/studio/studio-viewer.template.html`（`STUDIOVIEW-BEGIN`／`STUDIOVIEW-END` 區塊）

### 25.7 測試
- `renderer/src/studio/llm_export_core.test.js`：**38 項全過**（2026-11-12 最後一次執行）（步驟表、缺工具與未實作分開、可用性、偵測、命令組裝、執行器用注入的假 runner：全成功、中途失敗、退出碼 0 但沒 JSON、runner 丟例外、事件順序）。已登記於 `scripts/run-core-tests.js`（原本就有一行）。
- `renderer/src/studio/studio_host.test.js`：**33 項全過**（最後一次執行）（改寫匯出偵測段：沒有匯出環境、只看檔案存在、工具不齊時拒絕且不啟動子行程、未知格式、基底不存在、狀態 idle）。
- `renderer/src/studio/studio_server_core.test.js` 126 項全過；`pipeline_routes_core.test.js` 31、`pipeline_core.test.js` 31 全過。
- `renderer/src/studio/studio_embed.test.js`：14 過、3 敗，**原因是嵌入還沒更新**（見 25.6），不是程式錯；嵌入後應全過，尚未驗證。
- **略過**：Python 匯出腳本（`export_onnx.py`、`export_gguf.py`、`merge_and_export.py`、`train_full.py`）沒有放進 `run-core-tests`，因為它們需要 `.venv-export`、2.4 GB 權重與 llama.cpp；它們的驗證是 25.2–25.5 的實跑記錄。

### 25.8 已驗證／未驗證
- **已驗證（實跑）**：合併數值、ONNX fp32 與 HF 逐字一致、ONNX q8 的數值（上表）、GGUF 轉換與 Q8_0 量化、llama-server 貪婪推論、完整微調 smoke、暫停與續訓、完整微調產物走匯出。
- **已驗證（核心測試）**：`llm_export_core` 與 `studio_host` 的匯出路徑（用假 runner／假子行程）。
- **未驗證**：（1）`studio_host` 真的以子行程跑完整匯出（需要 Electron 主行程，只用 `buildStepCommands`＋真實子行程的驅動腳本跑過，見 25.9）；（2）桌面版 onnxruntime-node 1.22 載入 q8 與 mixed 圖（只用 Python ORT 1.31 驗證）；（3）`lora-slot-build.js` 能否吃 `full` 產物（結構上應可，未實測）；（4）網頁版（不在範圍）。

### 25.9 端到端：用 `llm_export_core` 的執行器跑（不經 Electron）
- 驅動：`~/fa/lora-export-work/driver/run_export.js`（不在專案樹內）。與主行程用同一組 `buildStepCommands` 與 `runExportSteps`，只把 runner 換成真的子行程。
- 結果（2026-11-12，同一個 adapter `toolcall-r4`，工作資料夾 `~/fa/lora-export-work/studio-onnx-20261112-125938`、`studio-gguf-20261112-125938`）：
  - ONNX：merge 完成、convert 完成、quantize（full）完成、verify 完成、pack 完成；`check.json` 與 25.3 的 run2 數字相同（fp32 cos 1.000000、96/96；q8 cos 平均 0.9221、top-1 4/6、貪婪 39/96）。產物：`fp32/model.onnx`＋`model.onnx_data`（3,007,960,375）、`q8/model_quantized.onnx`（756,736,915）、tokenizer 檔、`manifest.json`（每個檔的 sha256）。
  - GGUF：merge、convert（f16 1,198,182,240）、quantize（Q8_0 639,446,880）、verify（llama-server，貪婪 70/96、全對 3/6）、pack 全部完成。
  - 每次執行的 `export_job.json` 都寫進工作資料夾，`steps` 是每一步的 JSON 結果。
- **這次沒有經過 Electron 主行程**：驅動腳本用的是同一份 `buildStepCommands`＋`runExportSteps`，只把執行器換成真的子行程。主行程的 `studio_llm_export`（`spawn` 與 `probeLlmTools`）只有假子行程的測試（25.7），沒有實跑。

### 25.10 接續點
1. 總指揮：嵌入上面四個檔案，重跑 `studio_embed.test.js`。
2. 資產列表：決定 `llm` 的形式（建議：只登錄「輸出資料夾＋manifest」路徑，不放進記憶體資產）。
3. 桌面版設定頁的模型選單（指向匯出資料夾，`tokenizerPath` 用同一資料夾）；用真的 `nr-engine` 載入一次。
4. q8 品質：要的話用更大的留出集（KL 或分佈級指標），試 weight-only（需要 `onnx_ir`，要先取得同意）；目前不宣稱達標。
5. 完整微調的品質訓練：資料、步數、留出評量都還沒做。

### 25.11 指揮追加的七項（2026-11-12，同一分支；誠實版本：哪些做完、哪些沒做完）

| # | 要求 | 狀態 | 實測／原因 |
|---|---|---|---|
| 1 | 資產列表 kind:'llm'（KINDS、storage、server 列表／詳情／登錄、分片、sha256、.fatrain 往返） | **部分** | 完成：`KINDS` 加 `llm`；`llm` 資產的 manifest 有 `llm{format,quant,recipe}` 與 `external{路徑:{bytes,location}}`（權重不進記憶體，sha256 表仍包含）；`verifyFiles` 只跳過宣告為 external 的檔；`POST /api/llm/export/register` 把匯出結果登錄成資產（小檔進資產、權重記外部位置）；資產清單的 LLM 群組已加（`asset_core.test.js` 60 項、`storage_core` 30、`studio_server_core` 126、`studio_embed` 17 全過）。**未做**：`.fatrain` 往返（外部權重需要分片串流，現在 `fatrain_core` 會明確拒絕並說明原因）；分片；網頁版實際讀取（外部位置只在這台機器有效）。 |
| 2 | 模型選單（桌面 nr-engine 載入；網頁 onnxruntime-web；GGUF 列出、匯出、下載） | **部分** | 完成（桌面）：`POST /api/llm/use` 把 ONNX 資產寫成 `<userData>/studio-host/llm-model-choice.json`；`main-ext.js` 的 `baseModel`／`baseTokenizer` 優先讀它（環境變數仍最優先）。**未實跑**（沒有開 Electron）。**未做**：網頁版 onnxruntime-web 載入（需要把 q8 圖與分詞器送到瀏覽器，尚未設計）；GGUF 在網頁版的下載（資產列表會列出，但沒有下載路由）；LoRA 槽與自選模型的互斥（目前 LoRA 仍以標準版為基底，選了 llm 之後兩者可能不一致，這是已知缺口）。 |
| 3 | 用桌面版的 onnxruntime-node 1.22 驗證匯出的 ONNX | **部分** | 完成（同一個執行包內的套件，以一般 Node 載入，不是在 Electron 裡）：`~/.config/floating-assistant-desktop/native-runtime/1.22.0-1/node_modules/onnxruntime-node`（版本 1.22.0）。fp32 ONNX：貪婪 16 token 對 HF 96/96 逐字一致（6/6 題全對）；q8 full：44/96（2/6 題全對，比 Python ORT 1.31 的 39/96 略好，差異來自 ORT 版本）。**未做**：Electron 內用 `xvfb-run … electron . --no-sandbox` 與 `FA_DEBUG_EVAL_FILE` 實跑（下一步：寫一個 eval 檔，讀取匯出的模型並生成）。 |
| 4 | lora-slot-build.js 吃 full 產物並跑出 LoRA 槽版 | **完成** | 原本的建置器只認官方 q8 的命名（`attn/…/MatMul/output_0`），對 optimum＋quantize_dynamic 的圖報「找不到目標層」。改成兩種命名都認（`self_attn/…/MatMul_output_0` 也接受）。結果：rank 4，196 個目標層，`lora.bin` 10,092,544 位元組（與 adapter 的 rank 相同）。驗證：(a) 全零 lora.bin 的槽版與 q8 的貪婪 token 完全相同（ORT 1.22）；(b) 把 toolcall-r4 adapter 用 `make_lora_onnx.pack`（alpha/r 摺進 B）打包後，槽版首步 logits 對 PEFT 參考的餘弦平均 0.926（top-1 多數相同）；貪婪 token 10/96（與 q8 本身的量化誤差同一量級，LoRA 分支本身無法單獨判斷好壞）。 |
| 5 | 匯出可取消、可暫停、可續跑 | **完成（主行程模組的實測）** | 核心：`runExportSteps` 支援 `skip`（續跑）與 `isStopRequested`（停止要求在步驟之間生效；被打斷的步驟標「中斷」、不算失敗）。主行程：`studio_llm_export_pause`、`_cancel`、`_resume`；子行程以 `nice -n 19` 執行（與訓練一致）、用 process group 結束；續跑前清掉未完成步驟的殘留輸出。路由：`POST /api/llm/export/pause|cancel|resume`，UI 有對應按鈕。**實測**（`~/fa/lora-export-work/driver/host_e2e.js`，真的 `studio_host.js` 與真的子行程）：ONNX 匯出在 quantize 中途暫停 → 狀態「paused」、步驟 merge／convert 完成、quantize「中斷」；續跑 → merge、convert 標「略過（已完成）」，quantize、verify、pack 完成（`finished`）。**取消**走同一段程式（只是狀態名不同），沒有另外做 e2e。 |
| 6 | Python 匯出腳本的測試（迷你 Qwen3 smoke；大資源另標 measureOnly） | **完成（小型）／未做（大型）** | `lora-train/test_export_smoke.py`：用隨機初始化的迷你 Qwen3（2 層、hidden 64）＋ 迷你 LoRA，跑 merge → ONNX（convert／quantize full／verify／pack）→ GGUF（convert／quantize／verify／pack，llama-server）→ `train_full.py`（smoke、stop_file 暫停、checkpoint 續訓）。結果：**18 passed, 0 failed**（需要的 python、tokenizer、llama.cpp 都有時）；缺哪個就略過該段並印出原因。已登記於 `scripts/run-core-tests.js`（匯出環境 python 不在時印「略過」）。**大型（Qwen3-0.6B 全量的 train_full、真實 ONNX 匯出）未登記 measureOnly**：跑法是 `FA_QWEN3_TOKENIZER=<Qwen3-0.6B> lora-train/.venv-export/bin/python lora-train/test_export_smoke.py` 以及 §25.5 的 smoke 指令（沒有寫成自動測試，因為單次需要約 15 GB 記憶體與數分鐘）。 |
| 7 | 在分支 commit（不 push／publish）；embed-code-ui 與 build-assistant；grep 確認 | **完成** | `node scripts/embed-code-ui.js` 與 `node build-assistant.js`（build 需要 `node_modules`：工作樹建了指向主 checkout 的符號連結，**未提交**）。grep 確認：`renderer/floating-assistant.js` 與 `.min.js` 都含 `studio_llm_export_pause`、`/api/llm/export/register`、`llm-model-choice.json`、`buildStepCommands`、`fa-llm-actions`、`LLM 模型（匯出）`；`web-lazy/chunks/studio.js` 與 `studioview.js` 也含對應字串。`studio_embed.test.js` 17 項全過。 |

**沒做完、要寫清楚的理由與下一步**
- 網頁版 onnxruntime-web 載入 llm 資產（項目 2）：需要設計瀏覽器端的模型來源（資產是外部檔，網頁版拿不到路徑）；下一步＝決定網頁版要從 studio 伺服器的路由串流 q8 檔，還是只支援 fp32／小模型，然後接 `backend_wasm_web` 的 onnxruntime-web。
- `.fatrain` 往返與分片（項目 1）：下一步＝外部權重不進 zip，而是 `.fatrain` 內只帶 manifest 與小檔，大權重以 20 MB 分片的獨立檔案匯出，匯入時串流寫回；需要改 `fatrain_core` 的寫入與讀取。
- Electron 實跑（項目 2、3）：下一步＝寫 `FA_DEBUG_EVAL_FILE` 腳本，在真的桌面版裡呼叫 `studio_llm_use` 後生成一次，並比對貪婪 token。
- LoRA 槽與自選模型的互斥（項目 2）：下一步＝選 llm 時停用 LoRA 槽，或為選定的 llm 建立它自己的槽版。
- 登錄路由（`/api/llm/export/register`）目前只有「主行程 bundle＋伺服器端 manifest 組裝」的程式路徑，沒有經過真的 HTTP 測試；`llm_export_core` 與 host 的測試都過。

### 25.12 第三輪指揮要求（2026-11-12，同一分支；逐項實測，做不到的寫出具體錯誤）

| # | 要求 | 狀態 | 實測／原因 |
|---|---|---|---|
| 1a | `.fatrain` 不再明確拒絕 llm 外部檔 | **完成** | `fatrain_core.exportAsset`：拒絕條件改成「外部檔的位元組不在資產內」才回錯誤，訊息列出缺的檔。llm 登錄時權重就是資產的一般檔案（進儲存層），所以正常路徑不會遇到。 |
| 1b | 分片（20 MB）、sha256、匯入後權重進儲存層 | **完成** | `fatrain_core.test.js` 新增 25 MB 的 llm 資產：匯出 2 片（每片 ≤ 20 MB）、讀回 sha256 與位元組一致、`saveAsset`→`loadAsset` 取回位元相同、缺位元組時回報缺的檔。`node renderer/src/studio/fatrain_core.test.js` → **46 passed, 0 failed**。另見 25.11：756 MB 的真實 q8 `.fatrain` 往返（37 片）與匯入儲存層，先前已實測。 |
| 2a | 網頁版：onnxruntime-web 讀 q8 ONNX | **完成（頁面 harness）** | `renderer/src/studio/llm_web_core.js`（UMD，純函式，分詞器＋ KV 貪婪解碼）。`~/fa/web-ort-test/index.html` 在 Chrome（Claude 瀏覽器窗格）內從 CDN 載入 **onnxruntime-web 1.22.0**（wasm EP，1 執行緒），讀 756 MB q8、跑 6 題×16 token，對照 `check.json` 的 q8 參考：**圖最佳化 disabled：54/96（全對 2/6）；圖最佳化 all：28/96**。同一份核心在 Node 的 onnxruntime-node 1.22（cpu EP，圖最佳化 all）：44/96。這是 q8 本身的品質（與 HF fp32 的差距，見 25.4），不是路徑錯誤；網頁版預設改為 disabled。 |
| 2b | 網頁版：llm 資產可讀、權重在儲存層、GGUF 可列出／匯出／下載 | **完成** | `GET /api/llm/web/models`（列出 kind:llm，ready 與不可用原因；GGUF 標「不在網頁版推論範圍」）、`POST /api/asset/download`（交給 `h.download`，檔名＝路徑最後一段）。資產列表的詳情頁每個檔案都有「下載」鈕。`llm_web_route.test.js` → **13 passed, 0 failed**。GGUF 的匯出在桌面版（llama.cpp）做，登錄後可在網頁版下載。 |
| 2c | 網頁版模型選單與頁內生成 | **完成（程式與路由），UI 未在完整工作室頁面內點擊實測** | 檢視器「網頁版模型」區塊（`webLlmBox`）：下拉選 ready 的 llm 資產、提示、最多 token、生成；路由 `POST /api/llm/web/generate` 用注入的 `h.llmWeb.loadOrt`（`floating-assistant.js` 的 `_studioHostApi`，網頁版＝CDN 的 onnxruntime-web 1.22.0，桌面版不注入）。路由測試用假的 ORT 驗證串接（session 用 wasm EP、第二次沿用 session、空提示 400、GGUF 400、缺資產 404、沒注入時說明原因）。 |
| 3a | 桌面版：Electron 內 ORT 1.22 真實測試 | **部分** | 真的 Electron（`xvfb-run ~/fa-electron/dist/electron . --no-sandbox --disable-gpu`，`FA_DEBUG_EVAL_FILE`）：`FaLlmWeb`、`FaStudioServer` 在渲染程序中存在；`desktop: true`；主機回應 `studio_export_tools`（optimum／onnxruntime／llamaCpp／peft）；`studio_llm_use_current` 回 `choice: null`；`/api/llm/web/models` 回 200（新的使用者資料夾，沒有 llm 資產）。**沒做**：Electron 內的 nr-child 用 ORT 1.22 生成（沒找到能從 eval 腳本直接驅動生成的 nr 操作，沒接上）；Electron 內的 `studio_llm_use` → 重啟離線模型 → 生成。ORT 1.22 的數值驗證改在執行包的 onnxruntime-node 1.22（同版本）做，見 2a。 |
| 3b | 桌面版：模型選單 | **完成（主行程端）** | `studio_llm_use` 寫 `<userData>/studio-host/llm-model-choice.json`，`main-ext.js` 的 baseModel／baseTokenizer 優先讀它；ONNX 才能設（GGUF 400）。端到端＝未在 Electron 內實跑（見 3a）。 |
| 4 | lora-slot：full 產物 | **完成（沿用 25.11 的實測，本輪程式沒改）** | `ort122_slot_zero.json`：零 LoRA 的 slot 圖在 onnxruntime-node 1.22 上 **44/96（與 q8 一致）**。`ort122_slot_adapter.json`：帶 toolcall-r4 adapter 的 slot 圖 **10/96（全對 0/6）**。注意：這個 10/96 是對 **合併後 HF fp32** 的參考，不是對「PEFT adapter」的參考；adapter 的正確性目前只有 25.11 的 first-step cos 0.926，沒有 adapter 版的貪婪比對。 |
| 5 | 取消／暫停／續跑 | **完成（真的 studio_host＋子行程）** | `~/fa/lora-export-work/driver/host_cancel_e2e.js`：啟動 ONNX 匯出 → quantize 開始時取消 → `state: cancelled`，步驟 `merge:完成, convert:完成, quantize:中斷, verify:未執行, pack:未執行`；`export_state.json` 的 done＝`[merge, convert]` → 續跑 → `merge:略過（已完成）, convert:略過（已完成）, quantize/verify/pack:完成` → bundle 7 個檔（q8 756,736,915 位元組；fp32 排除）**sha256 全部 MATCH**。暫停（pause）路徑在 25.9 已跑過。 |
| 6 | Python smoke 進 run-core-tests | **完成** | `run-core-tests.js` 的「匯出 smoke」區塊：直接執行 `lora-train/test_export_smoke.py`（迷你 Qwen3）→ **18 passed, 0 failed, 0 skipped**（輸出行：`匯出 smoke（Python，迷你 Qwen3）：18 passed, 0 failed, 0 skipped`）。大型權重不在 smoke 內（沒有 measureOnly 的大型執行，寫明：完整 Qwen3-0.6B 的匯出見 25.3）。 |
| 7 | 修到 run-core-tests 全綠 | **未全綠（環境因素，逐項列在下方）** | 本輪修正：`/api/eval` 不列 llm（`/api/eval/run` 對 llm 回 400）；`studio_server_core.test.js` 種類數改為 6（126 passed）。完整執行 `scripts/run-core-tests.js` 三次：第三次（最後）結果 **360/378 組通過，18 組標失敗**：（a）13 組需要 `~/.cache/fa-ts`（tree-sitter 快取）與 1 組需要 ruby 文法，這台沒有，執行器印「略過」但計為失敗；（b）膠水、merge diff 三組：`python` 在 PATH 上是 Python 2.7，單獨用 python3 當 `python` 重跑全過（膠水 23、code_patch 64、code_patch_repair 97、code_patch_wire 7）；（c）程式優化的 prefix-sum 加速比在多工負載下 2.4 倍（門檻 3）、獨自執行 13/13 通過。另：`ingest.test.js` 需要主 checkout 的 `wiki/`，worktree 沒有，以符號連結補上後 67 passed。匯出 smoke 在 run-core-tests 內：18 passed。 |

**沒做完、要寫清楚的**
- 網頁版模型選單沒有在完整工作室頁面內用瀏覽器點擊實測（只有 harness 頁與路由測試）。
- Electron 內的 ORT 1.22 生成與「設為離線模型 → 重啟 → 生成」沒做（見 3a）。
- adapter 版 slot 的貪婪比對對象應改成 PEFT adapter 的 greedy，目前沒有這份參考。
- 網頁版 q8 的品質：6 題 16 token 的全對只有 2/6，與 HF 的差距仍在（25.4）。

## 26. LoRA 管理缺口：盤點、補完與實測（2026-11-12，分支 lora-train-eval）

**來源**：唯讀盤點（14 項，commit 20d5c2f5 時的程式），加上本輪自己找到的 UI 缺口。下表每項都標明：已補（有測試）、部分、未補（原因）。

### 26.1 盤點結果（逐項）

| # | 缺口 | 狀態 | 做了什麼／為什麼沒做 |
|---|---|---|---|
| 1 | 四顆 r4 只能同時載一顆（登錄表用槽寬 16 當 rank；mergeSlots 其實依有效秩串接） | **已補** | `entryFromManifest`：`rank`＝訓練秩（manifest.extra.lora.trained_rank），`slot_rank`＝槽寬 16（相容性用）。實測：四顆 r4 同時載入，秩加總 16；第五顆被拒並寫原因。 |
| 2 | 自動選用失效（card 評量格式 `{split_legal_rate:{base,tuned,n}}` 不被 evalVerdict 認得） | **已補** | `evalVerdict` 認得 card 格式（微調 > 基底＝贏，< ＝輸）。實測：decompose／toolcall 的 card 判為贏；plan／colu 沒有評量數字，仍不自動選用（寫明原因）。 |
| 3 | 描述檔與權重不一致（size／sha256 指 PEFT 檔，實際權重是 lora.bin；base 是本機路徑） | **已補** | `build-lora-asset.js`：描述檔 size／sha256 ＝ 實際 lora.bin，base ＝ `Qwen/Qwen3-0.6B`，本機路徑存 `base_local`。`scripts/build-lora-asset.test.js` 讀回驗證。 |
| 4 | 版本與說明遺失（版本顯示「未標註」） | **已補** | manifest.extra.lora 帶 version、description、known_limits；登錄表映射。 |
| 5 | 路由窄（triggers 沒用；網頁版路由被擋） | **部分** | 桌面版：triggers 現在會參與選用（`routeTurn` 傳入這一輪的話；測試：任務是 toolcall 也能靠 UML 觸發字選到 decompose）。網頁版路由仍被 `_studioDesktop()` 擋，需要改網頁路徑（未補）。 |
| 6 | 網頁版只能套一顆、minCos 0.5 會拒絕小 adapter | **未補** | 需要演算法或槽版網頁路徑（不是 UI 能解的）。 |
| 7 | §10 的「自動取 GitHub lora-adapters、offlineLora 設定、sha 核對、靜默退回」程式不存在 | **未補** | 需要網路下載的同意流程與設定頁；下載要先經使用者同意。 |
| 8 | 靜默略過（無權重的 lora 資產直接 continue；build 不驗證） | **已補** | 沒有權重的 lora 資產改列為 `dataOnly`（畫面上看得到，不是 adapter）；讀不到 manifest 進 `invalid`。build 先驗描述檔、model_card、lora.bin 大小；缺任何一項就拒絕產出。 |
| 9 | 相容性警告丟失（card() 只回 reasons；LORA_ENV 沒有基底雜湊與工具清單雜湊） | **部分** | 警告已保留並顯示（`compatWarnings`）。但 LORA_ENV 仍沒有工具清單雜湊，所以「工具清單是否過期」目前無法判斷，畫面會寫「adapter 沒記錄工具清單雜湊」而不是假裝通過。要補需要 app 端的工具清單雜湊，未做。 |
| 10 | 評量呈現不全（METRIC_KEYS 只有 2 項；toolcall 卡片是 v1 數字；範圍外未量） | **部分** | toolcall 卡片已更新為 §24 的 v2 數字（1.1.0）。plan／colu 的數字在 DESIGN §19，但 fa-lora-card 的 eval 只定義了兩個指標（split_legal_rate、fc_format_rate），沒有 plan_check／colu 的格式，所以沒有寫進卡片（要改 card schema，未做）。範圍外退步仍未量。 |
| 11 | 原生套用的正確性未證（槽圖 10/96 等） | **未驗證** | 盤點報告提到的數字我沒有重跑，不在這裡宣稱。真模型的數值比對需要 onnxruntime-node，這台沒有裝，安裝屬於下載，需要使用者同意。 |
| 12 | 測試缺口（無 build 測試；無真實 manifest→登錄項測試；route wiring 用正則） | **部分** | 補了 build 測試（12 項）、真實 manifest→登錄項與四顆 r4 同槽的測試（registry 測試）。`lora_route_wiring.test.js` 仍用正則比原始碼，未換掉。 |
| 13 | 文件與程式不符 | **部分** | `pipeline_core.js` 的 llm 匯出／按需載入改為已接上（附說明），測試同步改寫。§10、§13.5、§15.5 的舊敘述本節不改寫原文，以本節為準：§10 的「一次只能套一個」是桌面版舊狀態，現在桌面版可以同時載入多顆（rank 槽）；路由已接（見 floating-assistant.js 的 `_loraRouteTurn`）。 |
| 14 | 出貨不可重現（manifest 有 data_sha256，build 不產生） | **未補** | 需要把訓練資料的雜湊帶進 build；訓練資料在 runtime 資料夾，尚未設計由誰提供。 |

### 26.2 本輪新增的 UI（都有測試）

- **匯入 .fatrain（LoRA）的相容性說明**：`Reg.importReport`；匯入確認頁顯示會不會被拒、可載但要注意的事、卡片揭露、與同名現有資產的版本差異。測試：`studio_server_core.test.js`（基底不同 → reject 並寫原因；同名版本差異與新增限制）。
- **版本比較**：`GET /api/lora/compare?a=&b=` 與畫面上的兩個下拉選單；`renderCompareHTML`。測試：`lora_manage_core.test.js`、`studio_server_core.test.js`（不存在回 404）。
- **評量結果**：登錄表卡片顯示 card 的評量數字（拆題合法率、function call 格式合法率）與相容性提醒。
- **卡片揭露**：已知限制裡提到「退步」「未量」「沒有量」「不可用於」的，放在卡片最上面（`disclosuresOf`）。decompose-r4-v2 的 self_validate 負例退步與範圍外未量都會這樣顯示。
- **原生套用狀態**：`/api/lora/status` 多一個 `native` 欄位（主行程的 `lora_status`），畫面顯示「已套用／未套用＋原因」。桌面版接線在 `floating-assistant.js` 的 `loraStatus`。
- **槽版轉換狀態與失敗原因**：既有的 `slotCard` 已顯示 phase 與 error（`native-slot-model.js` 的 `status()` 會回 error）。這輪只確認沒有改動，未額外補測試。

### 26.3 實測（逐項，這台）

- 單元測試：`lora_registry.test.js` 90 項、`lora_manage_core.test.js` 47 項、`studio_server_core.test.js` 135 項、`lora_route.test.js` 20 項、`pipeline_core.test.js` 31 項、`scripts/build-lora-asset.test.js` 12 項、`studio_embed.test.js` 17 項、`lora_route_wiring.test.js` 11 項，全部通過。
- 五個 .fatrain（decompose-r4、decompose-r4-v2、toolcall-r4 1.1.0、plan-r4、colu-r4）用新的 build 重新產出；讀回驗證：描述檔 size／sha256 與 lora.bin 相符，base＝`Qwen/Qwen3-0.6B`，訓練秩 4、槽寬 16，相容性 ok。`plan-r4`、`colu-r4` 的卡片沒有評量數字（畫面會寫「無資料」）。
- 同槽驗證：decompose-r4、decompose-r4-v2、toolcall-r4、colu-r4 同時載入，秩加總 16（容量滿）；plan-r4 被拒並寫「計畫的 rank 總和超過槽容量 16」。
- 沒有做的實測：真模型（617 MB）上的原生推論比對（§26.1 第 11 項）。

### 26.4 誠實的剩餘項目

第 6、7、9（工具清單雜湊）、10（plan／colu 數字與範圍外量測）、11、14，以及網頁版路由（第 5 項後半）。原因都寫在 26.1 表格中。


## 27. 四顆 LoRA 產品視窗實測（2026-11-12，分支 desktop-app）

目的：在產品視窗（xvfb 下的真 Electron 44.4.0，`FA_DEBUG_EVAL_FILE`）實測 `decompose-r4-v2`、`toolcall-r4`、`colu-r4`、`plan-r4` 四顆，走產品自己的路徑：匯入工作室儲存層 → LoRA 登錄表（`lora_registry`）→ 每輪路由（`lora_route`，`fa._llmGenerate` 帶 `task`）→ 主程序 `lora_apply`／`lora_apply_set`（槽版模型 `native-lora/slot-model`）→ 原生推論。未改任何產品程式；`decompose-r4.fatrain`（舊版）沒測。

### 27.1 環境與來源（沒有下載）

- 腳本（都在 `scripts/eval/`）：`lora_four_adapters.run.js`（啟動器）、`lora_four_adapters.eval.js`（渲染程序內的評估）、`lora_four_adapters.make_items.py`（題目抽樣）、`lora_four_adapters.items.json`（12 題）。重現：`PATH=/tmp/pyshim:$PATH xvfb-run -a nice -n 19 node scripts/eval/lora_four_adapters.run.js --runtime=<1.22.0-2 執行包資料夾> --restore-slot=1`（`--restore-slot=0` 即量產品原樣）。一次約 6 分鐘。
- 資產來源：本機 `/home/hungfu.lee/fa-adapters-int/assets/`，實際大小（bytes）：`decompose-r4-v2.fatrain` 40,377,272；`toolcall-r4.fatrain` 40,376,888；`colu-r4.fatrain` 40,374,710；`plan-r4.fatrain` 40,375,167。每顆 lora.bin 40,370,176、rank 4（槽寬 16、alpha 8）。匯入各約 1.7 秒，`Fatrain.importAsset` 回 `action: create`。
- 執行包：本機原有的 `native-runtime/1.22.0-1` 是舊版（`legacy`，沒有 `lora` 功能，不能套 adapter）。用 `scripts/native-runtime-pack.js` 以本機已有的 onnxruntime-node 1.22.0 加上目前的 `nr-*.js` 重新打成 1.22.0-2（37 個檔案、30.0 MB），以 `FA_NATIVE_RUNTIME_LOCAL_SRC` 安裝到隔離的 userData。全程沒有網路下載。
- 模型：標準版 q8 `model_quantized.onnx` 617,687,575 bytes（從本機複製到隔離 userData，沒有下載）。槽版由產品的 `slot_prepare` 現轉：輸出 617,790,864 bytes（含 40,370,176 bytes 的全零 lora.bin 與 layout.json），轉換 618 毫秒，峰值 RSS 約 108 MB，加輪詢共 1.5 秒。本機原有的 589MB 槽版不能直接複製使用：快取鍵含「路徑｜大小｜修改時間」，換位置就不被認得。
- 登錄表：預算 256 MiB、`maxActive` 4；四顆相容性都是 ok；評量 verdict：decompose（split_legal_rate 贏基底）、toolcall（fc_format_rate 贏基底）已知，colu、plan 卡片沒有評量數字（`known:false`）。
- 題目：每題型 3 題，取自留出集（不在訓練集內；`lora-train/data/heldout*.jsonl`，依 id 均勻抽樣），並以確定性解碼、不開思考。因為產品的原生路徑只做純文字（呼叫帶 `tools` 或 `prefill` 會被略過），toolcall 的 tools 依 Qwen3 聊天樣板格式折進 system 訊息，各題型都不帶預填。

### 27.2 每個題型的結果（原生推論，3 題／型）

「格式」＝輸出符合該題型格式；「對」＝與留出集標準答案相同（decompose 比函式名稱集合、toolcall 比工具名稱與參數、colu 比字母、plan 比整段 JSON）。

| 題型 | 選到哪顆 | 套用 | 基底（不套用）格式／對 | 套用後 格式／對 | 延遲（中位數，基底→套用） |
|---|---|---|---|---|---|
| decompose（分解） | 每輪路由自動選到 `decompose-r4-v2`（登錄表 verdict 贏） | 成功（`lora_apply` 647 毫秒，原生 `lora_status` 回報該 adapter） | 0/3、0/3：全是 ```json 圍欄的陣列、簡體字、沒有 `{"functions":[…]}` | 2/3、2/3：輸出直接是 `{"functions":[{name,signature,purpose,calls,complex}]}`，有 `main`、calls 指向清單內；第 3 題缺 `main`（`read_input,solve,write_output`） | 8.0 秒 → 10.2 秒（輸出變成結構完整的 JSON，不是更慢的推論）；第一題含重建 session 12.1 秒 |
| toolcall（工具呼叫 JSON） | 自動選到 `toolcall-r4`（verdict 贏） | 成功（653 毫秒） | 3/3、0/3：基底本來就會寫 `<tool_call>`，但參數帶簡體字或多編的欄位（`"预算表"`、`"diff content"`） | 3/3、2/3：參數與題目一致；第 2 題選了 `fap_find_file`，標準答案是 `fap_copy_to_storage`（選錯工具） | 6.5 秒 → 6.3 秒；第一題含重建 session 8.8 秒 |
| colu（排名／選單字母） | 自動路由沒選到 `colu-r4`：卡片沒有評量數字，登錄表寫「沒有評量資料，不自動選用」，且被任務文字裡的「工具」觸發字改選 `toolcall-r4`（見 27.4 第 3 項）。改走工作室手動載入（`/api/lora/load` 帶 ids）選到 `colu-r4` | 成功（1.6 秒） | 單一字母 1/3、對 1/3：其餘輸出 `A.`、`E. 都不是` | 單一字母 3/3、對 2/3（B、A 對；一題答 D，標準答案 B） | 0.6 秒 → 0.9 秒；第一題含重建 session 2.1 秒 |
| plan（規劃 plan_check） | 同 colu：自動路由因沒有評量數字不選 `plan-r4`，改選 `toolcall-r4`（「呼叫」觸發字）；改手動載入選到 `plan-r4` | 成功（1.6 秒） | 合格 JSON 2/3（圍欄；第 3 題是陣列沒有 `checks`）、對 0/3 | 純 JSON 2/3（第 3 題 JSON 後面接了一段 python 碼）、對 0/3；內容品質差：一題 `checks: []`、一題只有一項 | 5.2 秒 → 5.6 秒（一題長輸出 13.2 秒） |

觀察：套用 adapter 之後，decompose、colu 的輸出格式明顯貼近訓練格式（基底完全做不到 → 2/3、3/3）；toolcall 的格式基底本來就可以，改善在參數內容（0/3 → 2/3）；plan 的格式改善有限、內容仍錯。樣本只有 3 題，不是統計結論，只證明「路徑通、adapter 有效、方向對」。

各題原文（節錄）與逐題記錄在評估輸出（`[eval-file] result:`）；加上不套用的基底對照，12 題基底 12/12 都走原生（log「後端：原生」），沒有 LoRA 的路徑完全不受影響。

### 27.3 四顆同時套用（`lora_apply_set`，rank 4×4＝16，剛好填滿槽）

- 套用成功：4 個 adapter 依 rank 串接成一個 `merged-…`（rank 0–3 toolcall、4–7 decompose、8–11 plan、12–15 colu），耗時 3.96 秒；登錄表記憶體 4×40,370,176 ≈ 161.5 MB，在 256 MiB 預算內，同時啟用上限 4 也夠。
- **但生成品質崩壞**：12 題中 decompose 0/3、toolcall 0/3 沒有任何合格格式（輸出變成重複的「清單」「讀」碎片或「工具清單裡沒有…」），colu 2/3 單一字母但 0/3 對，plan 1/3 合格；延遲也變成 30 秒級（亂輸出一路跑到上限）。串接等於把四顆的 ΔW 全部相加套在每一題上，互相干擾。原因只是推論（沒有逐項驗證）；沒有試過降低 `weight`。**結論：不要把四顆同時啟用當成預設，請維持「每輪只開對應題型那一顆」的路由。**

### 27.4 阻礙與缺陷清單（數字都是這次實測量到的）

1. **產品缺陷：`lora_apply`／`lora_clear` 會把槽版模型刪掉，之後所有帶 LoRA 的原生生成都失敗，且畫面看不出來。** `main-ext.js` 第 926 行（`keep` 集合只有新的 adapter id 或 `_merged`）與第 932 行（`clear()` 全刪）清理的是整個 `<userData>/native-lora`，而轉換好的槽版就放在 `native-lora/slot-model`。實測（臨時除錯腳本，未提交）：套用前 `native-lora` 底下是 `["slot-model"]`，套用後只剩 `["zero-41dfffca"]`，`slot_status` 的 `slot` 變 `null`；之後 `run` 的 `model_path` 變回標準版，子行程回 `load_failed：目前的模型不是 LoRA 槽版（沒有 layout.json）`。渲染程序會「原生失敗 → 改用 WASM」，所以 **`lora_apply` 回 `applied:true`、路由回 `fallback:'lora'`，實際生成卻是沒有 LoRA 的 WASM 結果**。產品原樣實測：LoRA 之後的 26 題（auto-route 8、manual-load 6、all4 12）全部 `load_failed` 退 WASM，輸出與基底相同，只有 log 看得到。解除條件：清理時保留 `slot-model`（`keep` 加上 `"slot-model"`，`clear()` 跳過它）。本次的繞法：啟動器（不是產品）在槽版目錄消失時用硬連結備份即時還原（`--restore-slot=1`，這次還原 7 次）；繞過後四種題型才得到 27.2 的結果。
2. **預設的離線模型裝置是 `gpu`，沒有 WebGPU 的機器永遠不問原生。** `_omSettings().device` 預設 `gpu`，`wantsNativeBackend('gpu', …)` 為假，整個退到 WASM（第一次實跑 12 題全是 WASM：「載入模型到 CPU（WASM，24 個執行緒）」，LoRA 完全沒生效）。評估腳本用產品自己的設定 `offlineDevicePreference='cpu'` 才走原生。解除條件：沒有 WebGPU 時預設選 auto/cpu，或在畫面提示。
3. **colu、plan 兩顆不會被自動選用，還會被別的 adapter 的觸發字搶走。** 兩顆卡片沒有評量數字（`eval:null`），登錄表依規則「沒有評量資料，不自動選用」；而 colu 的任務文字含「工具」、plan 的含「呼叫」，命中 `toolcall-r4` 的 `triggers`（`工具|呼叫|tool|function call|參數`），結果這兩個題型的每輪路由選到 `toolcall-r4`（實測：colu 路由 `active: ["toolcall-r4"]`，輸出 `E. 都不是（`；plan 輸出簡體字、格式不合）。解除條件：補上 colu、plan 的評量數字（DESIGN §19 有數字，卡片 eval 欄位只定義兩個指標），並收斂 toolcall 的觸發字。
4. **產品的真實 toolcall 呼叫不會用到 LoRA。** 原生路徑只做純文字（`a.tools` 或 `a.prefill` 非空就略過原生），而工具呼叫會帶 tools 與預填 `{`，所以走 WASM、沒有 LoRA。本次把 tools 折進 system 文字才量到 adapter 的效果。解除條件：原生路徑支援 tools 樣板與預填，或網頁版 LoRA 路徑接上。
5. **執行包 1.22.0-2 尚未發佈。** 本機舊的 1.22.0-1 不支援 LoRA（`legacy`）。本次自行以本機檔案重新打包（見 27.1）。
6. **四顆同時啟用：容量與記憶體夠、品質不行。** 見 27.3；rank 容量剛好用完（16/16），再多一顆會被拒絕。
7. **範圍與樣本。** 每題型只有 3 題；原生推論的記憶體用量沒有量（只量到槽版轉換的峰值 RSS 108 MB）；plan 的 `plan_check` 之外的 `self_validate`、`review_return` 沒測；`decompose-r4`（舊版）沒測；網頁版路徑沒測（設計上桌面版才能套用）。

### 27.6 阻礙 1～5 的處理（2026-11-12，同一天）

- **第 1 項（slot-model 被刪）**：v385 已修並有迴歸測試。
- **第 2 項（沒有 WebGPU 不走原生）**：`FaVlm.effectiveDevicePref`：偏好 gpu 但沒有 WebGPU 視同 auto（選項本來就做不到，resolveDevice 只會退到 WASM）；有 WebGPU 時完全不變（選 WebGPU 不碰原生的規則沒動）。渲染端 `_llmGenerateInner` 的三處判斷改用它。
- **第 3 項（colu／plan 不自動選用、被觸發字搶走）**：登錄表加 `KNOWN_EVAL`（§19 的留出集數字，只認 id／名稱完全是 `colu-r4`／`plan-r4`），登錄時卡片沒評量就查這張表，所以兩顆會被自動選用。另外 `select`：任務領域已有符合的 adapter 時，只靠觸發字命中的別領域 adapter 讓位；沒有任務領域或領域沒有符合者，觸發字照舊可選用。
- **第 4 項（toolcall 帶 tools／預填走 WASM）**：`FaVlm.nativeToolMessages` 把工具折進 system（格式同 Qwen3 官方樣板：`# Tools … <tools>…</tools> … <tool_call>`，工具以 `JSON.stringify` 逐行）；歷史有 `tool` 角色或 `tool_calls` 時不處理，改走網頁版。預填：原生樣板接不到預填（`nr-*` 是 md5 釘住的執行包，改它要發 1.22.0-3），所以讓模型自己生成，輸出以預填開頭才採用（回完整字串，與網頁版一致），否則退回網頁版重做。這是「正確優先」的做法：不一致就走舊路徑，不會靜默輸出錯誤。要讓預填一律走原生，需要執行包 1.22.0-3。
- **第 5 項（執行包 1.22.0-2「尚未發佈」）**：更正：分支 `native-runtime-1.22.0` 在 `eb7fd2a4`，`manifest.json`（`runtimeVersion` 1.22.0-2）與 `parts/nr-*.part` 都可下載，`NATIVE_GITHUB_BASE` 已指向它；先前的說法來自舊註解，已不成立。
- 未驗證：這三項在真實桌面視窗裡的生成效果（只有單元測試與註冊／樣板的字串核對）；工具折進 system 後與 WASM 樣板的逐字等同只對照了官方樣板文字，沒有跑同一題兩邊比輸出。

未列入阻礙但值得記：套用後第一次生成會重建 session，多花約 1.4～3 秒；`lora_apply` 一次約 0.65 秒（寫 40 MB 到信箱），工作室手動載入約 1.6 秒，四顆一起 3.96 秒。

## 27.7 §27.6 三項修正的產品視窗驗證：未完成（2026-11-13，分支 claude/lora-verify）

結論：**沒有在產品視窗實測**。阻礙是資產與執行包，不是程式；本次沒有改任何程式，只補這一節。

### 27.7.1 環境查核（這台，2026-11-13）

- 四顆 `.fatrain`（decompose-r4-v2、toolcall-r4、colu-r4、plan-r4）不在本機：全機 `find` 找不到；`/home/hungfu.lee/fa-adapters-int/` 不存在。唯一找到的 `.fatrain` 是測試用的 `/tmp/fa-build-lora-*/out-good/demo-r4.fatrain`，不是四顆之一，沒有拿來當替代。重新產生需要 `lora-train/` 訓練，不在本次範圍，也沒有下載。
- 執行包 1.22.0-2 未安裝；本機只有 1.22.0-1（legacy，不支援 LoRA）。可用 `scripts/native-runtime-pack.js` 由既有的 onnxruntime-node 1.22.0 打包，本次未做。
- Electron 有：主倉庫 `desktop-app/node_modules/electron/dist`。worktree 沒有 `node_modules`。`scripts/eval/lora_four_adapters.run.js` 把 exe 寫死在 `<app>/node_modules/electron`，所以在 worktree 直接跑會失敗。
- 模型：`~/.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8` 存在；`native-lora/slot-model` 存在（舊的槽版，未重新驗證）。

### 27.7.2 靜態查核（已驗過，只跑相關單檔）

| 檔案 | 結果 |
|---|---|
| `renderer/src/vlm/vlm_core.test.js` | 150 通過、0 失敗（含 `effectiveDevicePref`、`wantsNativeBackend`、`nativeToolMessages`） |
| `renderer/src/studio/lora_route_wiring.test.js` | 13 通過、0 失敗 |
| `renderer/src/studio/lora_registry.test.js` | 96 通過、0 失敗 |
| `renderer/src/studio/lora_route.test.js` | 20 通過、0 失敗 |

逐項對照程式碼（只是讀程式，沒有實跑）：

- §27.4 第 1 項（`slot-model` 被刪）：`main-ext.js` 的 `applySet` 保留清單含 `"slot-model"`，`clear()` 也跳過它。修正在程式裡。
- §27.6 第 2 項（沒有 WebGPU 不走原生）：`FaVlm.effectiveDevicePref`（`vlm_core.js`）把 `gpu` 且沒有 WebGPU 視為 `auto`；`floating-assistant.js` 的 `_llmGenerateInner` 用它判斷原生。
- §27.6 第 3 項（colu／plan 自動選用）：`KNOWN_EVAL` 只有 `colu-r4`（30:11、25:0）與 `plan-r4`（60:52、50:0、47:25），數字與 §19 相同，只認 id 或名稱完全相同。
- §27.6 第 4 項（工具與預填）：`nativeToolMessages` 把工具折進 system；歷史有 `tool` 角色或 `tool_calls` 時回 `ok:false`。`nativeWithPrefill` 輸出不以預填開頭時回 `null`，`_nrRunNative` 把它當失敗，呼叫端退回網頁版。這條路沒有看到會靜默輸出錯誤的分支。

### 27.7.3 未驗證（誠實列出）

- (1) 無 WebGPU 時 LoRA 真的走原生：**未在產品視窗實跑**。只有單元測試。
- (2) colu／plan 被自動路由選到、且不被 `toolcall-r4` 的觸發字搶走：**未實跑**。依賴的四顆 `.fatrain` 不在本機，無法做真實路由。
- (3) 帶 tools／預填的呼叫，原生輸出與網頁版 WASM 是否一致：**未量**。沒有同一題兩邊的輸出比對。
- 槽版（`slot-model`）在真實 `lora_apply` 後存活：**未在產品視窗重驗**，只有程式碼與既有測試。

### 27.7.4 要完成這一節，需要做的事（依序）

1. 把四顆 `.fatrain` 放進一個資料夾，用 `--assets=<資料夾>` 傳給啟動器。
2. 用 `node scripts/native-runtime-pack.js <輸出資料夾> --ort-src <含 node_modules/onnxruntime-node 1.22.0 的資料夾>` 打出 1.22.0-2，再以 `--runtime=` 傳入。
3. 讓 worktree 能找到 Electron（symlink `node_modules`，或把 `run.js` 的 exe 路徑改成可設定）。
4. 跑 `xvfb-run -a taskset -c 0-1 nice -n 19 node scripts/eval/lora_four_adapters.run.js --runtime=… --assets=… --restore-slot=0`（`--restore-slot=0` 才是產品原樣）。

### 27.7.5 提交與共用檔

- 本次只改 `desktop-app/DESIGN.lora-training.md`（新增本節）。沒有改程式、沒有改 `renderer/src/floating-assistant.js`，因此**不需要重新嵌入**。
- 沒有 embed、build、推送或發布。

## 28. LoRA 缺口第二輪（#9、#11、#12、#14，2026-11-13，分支 lora-train-eval）

總指揮接力後的範圍：先併入 `desktop-app` 最新（fast-forward 到 787e5bb8），再補下列四項。沒有發布、沒有推送、沒有下載。

| # | 項目 | 狀態 | 做了什麼 | 還沒做／限制 |
|---|---|---|---|---|
| 14 | 可重現建置（data_sha256） | **完成** | `scripts/build-lora-asset.js` 以訓練檔「內容」算 `data_sha256`，寫入描述檔、`compat.data_sha256`、`extra.lora.data_sha256`。訓練檔來源：`--train-file`，或描述檔的 `train_file`（相對 release 目錄）。拿不到訓練檔、或描述檔記的雜湊（`data_sha256`／`trained_on.train_file_sha256`）與實算不符，都拒絕產出。測試 19 項（含同輸入兩次雜湊相同）。 | 工具清單與程式版本仍未寫進資產（只有雜湊）；`pack_adapter.js` 的 `train_file_sha256` 只在 `data/train.jsonl` 存在時有值。 |
| 9 | 工具目錄雜湊（漂移偵測） | **部分** | 新格式 `shape-v1`（`lora_registry_core.js` 的 `toolCatalogShapeText`）：只取工具名稱＋參數結構（名稱、型別、必填、enum），**不取說明文字**（主程式說明含 `${…}` 平台插值，執行時與離線掃描不會逐字相同，比對會永遠誤報）。`pack_adapter.js` 以 `shape-v1` 算 `tool_catalog_sha256` 並寫 `tool_catalog_scheme`；主程式用 `_builtinToolNameSnapshot`（啟動時的內建工具）算同一雜湊，經 `h.toolCatalogSha256()` 進 `LORA_ENV`。舊格式（沒有 scheme 的檔案位元組雜湊）會明說「無法比對」；主程式算不出會明說。 | **未實測**：沒有跑 Electron，所以主程式算出的雜湊與訓練端 `real_tools_all.json` 的雜湊是否相等**未驗證**（離線掃描 322 個工具，主程式內建數量與平台條件可能不同）。說明文字改動偵測不到。現有 toolcall-r4 是舊格式，會顯示「無法比對」直到重新打包。 |
| 12 | lora_route_wiring 接線測試 | **部分** | `renderer/src/studio/lora_route_wiring.test.js` 改為行為測試：從 `floating-assistant.js` 抽出 `_loraRouteTurn`、`_llmGenerate`、`_planModel` 的真實方法本體，放進 vm 沙箱，用假的 this 與真的 `lora_route_core` 執行。檢查：工具任務→領域＋這一輪的話；路由文字取最後一則 user；生成前 acquire、生成後 release（含生成丟錯）；路由丟錯→基底；`_planModel` 預設 plan、UML 拆解 decompose。27 項。 | 閉包內的三個呼叫點（選單 colu、工具參數 toolcall、工具階段 toolcall）跑不到，仍只做原始碼標記檢查，測試輸出中標為「[閉包]」。 |
| 11 | 原生推論正確性 | **部分（不是原本的 10/96）** | 原本 10/96 的 toolcall-r4 adapter、heldout 與 `ort122_slot_adapter.json` 參考檔在 `~/fa` 清除時一起不見，**無法逐字重跑**。改用現有的 studio bench adapter（rank 16，sha256 `b463bbe8…`，40,422,168 位元組）做等價量測：HF fp32 合併參考 vs onnxruntime-node 1.22.0（app 原生執行包 `1.22.0-1`，已安裝，未下載）。見下表。 | 不是同一顆 adapter，數字不能和 10/96 比；沒在 Electron 內跑；沒有驗證 app 的 `lora.bin`（sha `41dfffca…`）是哪一顆 adapter 產出的。 |

#### 28.1 #11 量測（greedy 16 token × 6 題 = 96 位置，逐位置比對）

| 原生組 | 對 HF fp32＋bench adapter | 對 HF fp32 基底（無 adapter） |
|---|---|---|
| (a) q8 基底，無 adapter | 9/96 | 26/96 |
| (b) 槽版圖，零 lora.bin | 9/96（與 a 逐字相同） | 26/96 |
| (c) 槽版圖，bench lora.bin | **45/96** | 12/96 |

- 來源與大小：q8 基底 `~/.config/floating-assistant-desktop/native-models/qwen3-0.6b-q8/onnx/model_quantized.onnx`（617,687,575 位元組）；槽版圖 `native-lora/slot-model/ccf8734e…/model_quantized.onnx`（617,790,864 位元組，唯讀，硬連結到暫存資料夾）；lora.bin 由 bench adapter 以 `pack_bench.py`（`make_lora_onnx.py` 的 pack_bytes 同規則；原檔需要 `onnx` 套件，這台 `fa-work/venv` 沒裝）打包，40,370,176 位元組，392 個張量與槽版 layout 相符。
- 結論能說的：零 adapter 的槽版圖與 q8 基底逐字相同，圖手術本身沒有改變輸出；載入 bench adapter 後，首步 logits 在六題上都往 adapter 參考靠近（餘弦約 0.79–0.87，無 adapter 的 q8 為 −0.20–0.86）。
- 不能說的：不能說原生路徑與 fp32 加 adapter 一致（q8 噪聲本身就把 9/96 拉低）；位置一致率對第一次分歧很敏感，數字會低估接近程度；這不是 10/96 的重現。
- 腳本：`lora-train/native_check/`（`prompts.js`、`hf_ref.py`、`pack_bench.py`、`native_run.js`）；結果 JSON 在 `~/fa-work/native_check/native_results.json`（不在版本庫）。

#### 28.2 沒有做的事（誠實列出）

- 桌面版 Electron 內實跑（需要 `xvfb-run` 與 `FA_DEBUG_EVAL_FILE`，本輪沒做）。
- 主程式工具雜湊與訓練端的相等性（需要 Electron 內算出 `toolCatalogSha256()` 再與 `real_tools_all.json` 比對）。
- 重新打包 toolcall-r4 成 `shape-v1`（它的 adapter 與發布目錄已不在磁碟上）。
- 發布、推送、熱更新送達：這次只有 commit，沒有發布。

## 29. LoRA 缺口第三輪（總指揮接力，2026-11-13，分支 lora-train-eval）

接力範圍：(1) 用原本那顆 adapter 重測原生推論；(2) runtime 與訓練端工具目錄雜湊相等性；(3) 三處閉包呼叫點改行為測試；(4) decompose_v2 評量與管理介面缺口。

| # | 項目 | 狀態 | 結果 |
|---|---|---|---|
| 1 | 原生推論（原 adapter） | **部分** | 找到原 adapter：`keen-williamson-f167f3/desktop-app/lora-train/out/multi/toolcall/adapter_model.safetensors`（rank 4、alpha 8、10,143,496 位元組）。**§28 說它已不在磁碟上是錯的**，只有它的 release 目錄不見了。用同一套腳本量測：見 29.1。仍不是 10/96 的重現（原 10/96 的 HF 參考與題組設定已無法確認）。 |
| 2 | 工具目錄雜湊相等 | **未相等（離線模擬）** | 見 29.2。這是 #9 的實質缺陷，不是量測不到。 |
| 3 | 三處閉包呼叫點 | **完成** | `lora_route_wiring.test.js` 不再有原始碼標記：`_unitCatalogEvalStep`（colu、toolcall）、`_umlModel`（decompose 經真的 `_planModel`）、`_omToolBench`（toolcall）整個外層方法執行，檢查實際送進 `_llmGenerate` 的任務類型。30 項通過。 |
| 4 | decompose_v2 評量與管理介面 | **部分** | 見 29.3。 |

### 29.1 原 adapter（toolcall-r4，rank 4）的原生量測

- 腳本：`lora-train/native_check/`（`hf_ref.py`、`pack_bench.py`、`native_run.js` 新增 `FA_ADAPTER`／`FA_TAG` 環境變數，預設行為不變）。`pack_bench.py` 以 layout.json 打包，`scale = alpha/r = 2.0`，392 個張量，lora.bin 40,370,176 位元組。
- 同一題組（6 題 × 16 token = 96 位置）、onnxruntime-node 1.22.0、q8 基底與槽版圖同前。

| 原生組 | 對 HF fp32＋toolcall adapter | 對 HF fp32 基底 |
|---|---|---|
| (a) q8 基底，無 adapter | 16/96 | 26/96 |
| (b) 槽版圖，全零 lora.bin | 16/96（與 a 逐 token 相同） | 26/96 |
| (c) 槽版圖，toolcall lora.bin | 22/96 | 14/96 |

- 結果檔：`~/fa-work/native_check/native_results_toolcall.json`（不在版本庫）。
- 能說的：零 adapter 的槽版圖與 q8 逐 token 相同；toolcall adapter 載入後與 HF＋adapter 的一致數高於與無 adapter 的 q8（22 > 16），但仍遠低於 96。
- 不能說的：不能說原生與 fp32＋adapter 一致；q8 量化噪聲本身就把一致數拉低；未在 Electron 內跑。

### 29.2 工具目錄雜湊：離線模擬的比對結果（未相等）

`lora-train/tool_catalog_compare.js`：vm 執行 `floating-assistant.js` 的 `_registerBuiltinAiTools` 本體（工具替身 no-op，登記表真的），用 `lora_registry_core.toolCatalogShapeText` 算 shape-v1，與 `real_tools_all.json`（322 列）比。

- app 登記名稱 214、訓練端 322；雜湊不相等。
- 只在訓練端：114（例如 `computer_*`、`add_chapters`、`begin_presentation`，這些在別的登記路徑或條件式模組中登記）。
- 只在 app：6（`get_tool_details`、`delegate_to_subagent`、`chat_*`，在建構子其他位置直接登記）。
- 同名但形狀不同：1（`convert_code`，參數結構不同，待查）。
- **含意**：#9 目前的實作把兩邊定義成不同的集合（訓練端＝全部靜態盤點；app＝建構子快照的內建名單）。一旦 adapter 寫入的是訓練端雜湊，app 每次都會回報「工具清單已變動」，是誤報。這不是單純的量測沒做，要修的是「雜湊涵蓋哪個集合」的合約。
- 未解的限制：離線模擬沒有執行整個建構子；它也不含條件式模組。要得到真正的主程式值，需要 Electron 內呼叫 `toolCatalogSha256()`。
- 待決定：合約採用哪一種（(a) 訓練端改成只算「建構子快照」那批名單，需要重新產出 adapter 的 env 資料；(b) app 改算完整靜態集合；(c) 只比名稱集合、不比形狀）。這會影響所有已打包 adapter 的相容性判定，所以沒有擅自改。

### 29.3 decompose_v2 評量與管理介面

- **評量**：`out/eval/decompose-r4-v2.json` 目前還沒有；另一個 session 的 `eval_run.py`（keen 工作樹，pid 1463607，06:09 起）正在跑 360 列，06:16 為 144/360。這台機器負載約 25，沒有再開第二個。它只量拆題組；範圍外（toolcall、colu、plan）退步仍未量，需要另外排程（每組 110～412 列，CPU 上很花時間）。
- **管理介面（確認的缺口，已修）**：`lora_manage_core.js` 的 `DISCLOSURE_RE` 認不得 decompose-r4-v2 卡片的兩條實際限制（「範圍外…沒有保證」、「可能偏向判 ok」），所以卡片頂端的「卡片揭露」橫幅不會出現。§26.2 原本寫「decompose-r4-v2 會顯示」是錯的。已把「沒有保證」「偏向」「範圍外」加入，測試 49 項通過（新增兩條 decompose-r4-v2 的實際文字）。
- **管理介面（待決定）**：登錄表的自動選用依 `split_legal_rate` 判 decompose-r4-v2 為「贏」，但 §17.2 已記錄它的 self_validate 負例全錯、整體偏向判 ok（實質行為偏差，§17.2 的決定是「v2 不取代 v1」，之後 §26 改為打包 v2，兩者不一致）。卡片會揭露，但自動選用不看揭露。要不要讓「有揭露的退步」擋住自動選用，是產品政策，沒有擅自改。

### 29.4 測試與提交

- 通過：`lora_route_wiring.test.js` 30、`lora_manage_core.test.js` 49。
- 腳本未入測試：`native_check/*`、`tool_catalog_compare.js`（診斷用，手動執行）。
- 沒有推送、沒有發布、沒有熱更新送達。

### 29.5 工具雜湊缺陷的修正（shape-v2，指揮要求）

- **原因**：§29.2 的不相等來自輸入不同——訓練端用全部靜態盤點（322），主程式用建構子登記的內建快照（214）。正規化函式本來就是同一個。
- **修正**：
  - 新的唯一輸入：`lora-train/data/app_snapshot_tools.json`（214 列，由 `lora-train/tool_snapshot.js --write` 從 floating-assistant.js 的 `_registerBuiltinAiTools` 產生）。
  - 新的共用函式：`lora_registry_core.toolCatalogHash(tools, shaOfBytes)`。訓練端（`pack_adapter.js`，manifest 的 `trained_on.tool_catalog_sha256`）與主程式（`_toolCatalogSha256`）都呼叫它。
  - 格式名稱由 `shape-v1` 改為 `shape-v2`（輸入定義變了，舊雜湊不能比）。沒有已打包的 shape-v1 adapter，舊格式的 adapter 仍會得到「舊格式」警告。
- **測試**：`renderer/src/studio/tool_catalog_equal.test.js` 9 項通過，包括：快照檔與原始碼一致（漂移守門）、主程式的真方法本體與訓練端雜湊相等、少一個工具或改一個型別會變、說明文字不影響。另外 `lora_registry.test.js` 109、`studio_server_core.test.js` 138、`lora_manage_core.test.js` 49、`lora_route_wiring.test.js` 30、`build-lora-asset.test.js` 19 通過。pack_adapter 用假 adapter 試跑，記錄的雜湊與共用函式算出的相等。
- **仍未證明**：快照是從原始碼以替身執行得到的。主程式執行期會依設定分支的登記，替身只走預設分支。真正的執行期值仍需 Electron 內呼叫 `toolCatalogSha256()` 才能確認；目前的相等是「同一份輸入、同一個函式」，不是「執行期實測相等」。

## 30. decompose-r4-v2 評量結果與登錄缺口（2026-11-13）

評量：`out/eval/decompose-r4-v2.json`（keen 工作樹，360 列，`eval_r4.sh decompose_v2`，07:11 完成）。這裡只記結果與判讀，沒有重新打包。

| 組 | 基底 | 微調 | n | 判讀 |
|---|---|---|---|---|
| fn_template/code_split | 0 | 23 | 60 | 贏 |
| fn_template/code_write_fn | 0 | 8 | 60 | 贏 |
| heldout/fn_template | 0 | 31 | 120 | 贏 |
| heldout/think_stack | 0 | 36 | 180 | 贏 |
| uml/edit_real、seen/unseen/edit_real | 18 | 30 | 30 | 贏 |
| uml/edit_shuf、seen/unseen/edit_shuf、group/uml/edit_* | 16 | 30 | 30 | 贏 |
| think_stack/review_return | 0 | 15 | 60 | 贏 |
| think_stack/self_validate | 0 | 21 | 60 | 贏（見下） |
| think_stack/plan_check | 0 | 0 | 60 | 沒贏（不是退步） |

- 沒有任何一組輸給基底（`regress: []`）。`eval_run.py` 的判準：所有目標組都要贏 ≥10% 且 ≥2 列；`plan_check` 沒過，判 **DO NOT SHIP**。
- **self_validate 的「贏」是假的**：60 列裡 38 列的標準答案是 `ok:false`（`once` 題），微調全部答錯；贏的 21 列全是 `ok:true` 的乾淨題，微調只是一律答 `ok:true`。基底在這組是 0，所以任何「一律 ok:true」都會被算成贏。這就是 §17.2 記的「負例全錯、偏向判 ok」，在組級指標上被遮住了。
- 登錄判斷：`evalVerdict` 讀的是 `{adapter, base, n}`（`package_r4.sh` 轉換的格式，已確認相符）。以這份 groups 計算，decompose-r4-v2 `known: true, lose: []` → **會被自動選用**。也就是說，目前的登錄規則不會擋住它。

### 30.1 登錄與管理介面缺口

1. **自動選用看不見負例**：組級「贏」不分正負例，遮住了上面的偏向。這不是格式問題，是指標定義：沒有任何欄位能讓 `evalVerdict` 知道負例錯了。
2. **卡片揭露文字不準**：decompose-r4-v2 卡片寫「可能偏向判 ok」，但沒有寫出 0/38 的數字。這次 regex 已能標出，但數字本身還沒進卡片。
3. **需要決定的政策**（沒有擅自改）：
   - (a) 負例偏向的 adapter 不自動選用，只能手動指定，直到重訓（建議）。
   - (b) 維持自動選用，只在卡片頂端揭露「負例 0/38」。
   - (c) 評量時加入「負例通過率」分組，`evalVerdict` 看到負例 lose 就擋住。這要改評量腳本（keen 工作樹的 `eval_run.py`／`score_gen.js`），不在本分支。

### 30.2 沒做的事

- 沒有重新打包 decompose-r4-v2（它的 eval 會變成這份新結果）。
- 沒有改 `eval_run.py`，沒有重訓。
- plan_check 的 0/0 沒有分析原因。
