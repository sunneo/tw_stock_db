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
