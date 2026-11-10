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
- **載入**：**目前做不到**——app 的原生推論（`nr-engine.js`，onnxruntime-node）與網頁版（transformers.js）只吃 ONNX，不能直接載 PEFT adapter。必須先完成 §7 第 4 點的做法 A（量化後在 196 個目標線性層插入 LoRA 分支、adapter 存成外部資料檔、換 adapter 只重建 session），並先查證 onnxruntime-node 是否支援同樣的 `externalData`。在那之前，設定、下載、核對、相容性檢查與設定頁可以先做並以假 adapter 測試，但「真的改變模型輸出」這一步要等做法 A。
- **安全**：只下載本專案 repo 指定 branch 的檔案；只接受 sha256 吻合者；不執行任何下載內容（adapter 是純權重）；使用者可隨時停用。
- **改到 renderer 檔案時**：`floating-assistant.js`／`bootstrap.js`／`index.html` 的變更需走 live-update patch 發佈流程。
