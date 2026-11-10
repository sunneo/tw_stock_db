# 統一訓練資料格式（Unified SFT Example Schema）

所有領域產生器（`gen/*.js`）輸出同一種 JSONL 格式，每行一筆：

```jsonc
{
  "id": "string，跨檔唯一，建議 '<domain>:<來源檔>:<序號>'",
  "domain": "tool_routing | uml_design | think_stack | colu | blockly_matrix | fn_template",
  "stage": "string，例如 'choose_tool' | 'uml_actors' | 'uml_classes' | 'uml_members' | 'uml_relations' | 'uml_sequence' | 'plan_check' | 'review_return' | 'self_validate' | 'colu_letter_choice' | 'block_micro_select' | 'code_write' | 'code_rethink' | 'step_split_choice'",
  "messages": [
    { "role": "system", "content": "…（若production沒有system prompt就省略這則）" },
    { "role": "user", "content": "…完全比照production實際餵給模型的字串，含思考堆疊標頭／選單／規格…" }
  ],
  "completion": "模型應該輸出的字串，格式必須與production解析器能接受的格式一致（例如 {\"choice\": 3}、單一字母、UML DSL 一行、一段程式碼……)",
  "verified_by": "program_ground_truth | judge_pass | rejection_sampling",
  "split": "train | heldout",
  "source_file": "這筆資料衍生自哪個既有檔案（相對 desktop-app 的路徑）",
  "meta": { "...": "領域自訂的額外欄位，例如 level、tags、problem_id、retries" }
}
```

## 規則（所有產生器都要遵守）

1. **完全重用production的格式化函式**：產生器用 `require()` 載入真正的核心模組（`renderer/src/recipe/recipe_core.js`、`think_stack.js`、`renderer/src/uml/uml_core.js`、`design_core.js`、`algo_intent_core.js`、`py_paradigms_core.js`、`renderer/src/recipe/code_loop_core.js`、`judge_core.js`、`step_split_core.js`、`renderer/src/catalog/catalog_core.js`……)，呼叫它們既有的 prompt 組字函式產生 `messages`，**不要自己重新刻一份格式**（否則訓練出來的格式跟正式環境對不上）。這些模組全部是不碰 DOM／I/O 的純函式 UMD，可以直接在 plain `node`（不需要 Electron）裡 `require`。
2. **答案必須是程式已經知道、且驗證過的正確答案**，不是用別的模型生成的猜測：
   - `program_ground_truth`：程式本來就算得出正確選項／正確值（例如 recipe 的路由分數、UML 驗證表、矩陣 level 分類、paradigm 槽位的窮舉解）。
   - `judge_pass`：答案是一段程式碼，已經過 `judge_core.js`／`judge-runner.js` 的沙盒測資驗證為 Accepted。
   - `rejection_sampling`：用既有的 reference 解（`bench_lib.py` 產生題目時執行過的 `ref`）或既有語料庫裡已知正確的寫法，包成選擇題／程式碼完成題。
3. **held-out 紀律沿用既有規矩**：凡是來自 `heldout_all.jsonl`、`heldout2..6.jsonl`、`holdout_blockly.jsonl` 或任何檔名/欄位標明 `holdout`／`heldout` 的題目，一律標 `"split": "heldout"` 且**絕對不要被訓練腳本讀進訓練集**——只能用來最終評量。其餘來源一律 `"split": "train"`，但要切一塊（建議 10%）額外保留做訓練期間的驗證集（跟 heldout 不同，這塊仍然是訓練集的一部分抽樣，不是「從未見過的題型」）。
4. **思考堆疊標頭要原樣保留**：任何經過 `think_stack.js` 的 `header()`/`wrap()` 的題目，產生器要呼叫這兩個函式把標頭組進 `messages`，不要手動複製字串常數（標頭格式之後可能會改）。
5. **每筆資料都要可追溯**：`source_file` 與 `meta` 要足夠讓人回頭找到原始題目／原始程式碼，方便除錯與之後擴充。
6. **不要引入新的領域知識**：產生器只能讀既有的種子檔／bench 檔／核心模組，不要自己編題目或編答案；資料量不夠就老實記錄「目前只有 N 筆」，不要為了湊數虛構。

## 產生器清單與對應領域

| 檔案 | domain | 讀的核心模組 | 讀的資料來源 |
|---|---|---|---|
| `gen/gen_tool_routing.js` | `tool_routing` | `renderer/src/recipe/recipe_core.js`、`renderer/src/catalog/catalog_core.js` | 既有單元目錄／recipe 測試裡的範例情境 |
| `gen/gen_colu.js` | `colu` | `renderer/src/recipe/think_stack.js`（`coluChoose`/`parseLetter`）、`renderer/src/catalog/catalog_core.js` | CoLU 體檢用的情境與正確接線 |
| `gen/gen_uml_design.js` | `uml_design` | `renderer/src/uml/uml_core.js`、`renderer/src/uml/design_core.js` | 既有情境／UML DSL 範例（測試檔、DESIGN.uml-framework.md 範例） |
| `gen/gen_think_stack.js` | `think_stack` | `renderer/src/recipe/think_stack.js` | 上面各領域產生的多層任務，疊加 planCheck／reviewReturn／selfValidate |
| `gen/gen_blockly_matrix.js` | `blockly_matrix` | `renderer/src/uml/algo_intent_core.js`、`renderer/src/uml/py_paradigms_core.js` | `renderer/src/recipe/seed/*.jsonl`（bench/holdout 題庫） |
| `gen/gen_fn_template.js` | `fn_template` | `renderer/src/recipe/code_loop_core.js`、`renderer/src/recipe/judge_core.js`、`renderer/src/uml/step_split_core.js` | `renderer/src/recipe/seed/problems.jsonl` |

`gen/merge_dataset.js` 把上面全部輸出合併、去重、依 `split` 分檔，寫到 `lora-train/data/train.jsonl` 與 `lora-train/data/heldout.jsonl`，並印出每個 domain/stage 的筆數統計。

## 產生器的程式介面（所有 `gen/gen_*.js` 都要遵守）

每個產生器是一個 CommonJS 模組：

```js
// gen/gen_xxx.js
async function generate() {
  // 讀既有的核心模組／種子檔，回傳一個陣列，每個元素符合上面的統一格式。
  // 可以是 async function（幾乎一定要是——production 的 chooseTool／judge 之類本來就是 async），
  // merge_dataset.js 的 loadGenerator() 一律 await。
  return [ { id, domain, stage, messages, completion, verified_by, split, source_file, meta }, ... ];
}
module.exports = { generate };

// 也要能直接用 `node gen/gen_xxx.js` 執行，把同樣的陣列逐行印成 JSONL 到 stdout，
// 方便單獨跑、單獨檢查：
if (require.main === module) {
  (async () => { for (const row of await generate()) process.stdout.write(JSON.stringify(row) + '\n'); })();
}
```

- 路徑一律用 `path.join(__dirname, '..', '..', 'renderer', ...)` 這種相對 `__dirname` 的寫法，不要寫死絕對路徑（換機器會壞）。
- `require()` 核心模組時，確認是 plain Node（不是 Electron）也能載入——這些模組已確認是不碰 DOM 的純函式 UMD，直接 `require('<path>/xxx_core.js')` 即可拿到匯出的物件。
- 每個產生器自己要在 stderr 印一行統計（這個領域實際產生了幾筆、來源筆數、跳過了幾筆及原因），寫完就老實印，不要為了湊數字而虛構資料——資料不夠就是不夠，在 stderr 說清楚即可，`merge_dataset.js` 與之後的 DESIGN 文件會如實記錄每個 domain 目前的筆數。
- 完成後，自己用 `node gen/gen_xxx.js | node -e "let n=0;require('readline').createInterface({input:process.stdin}).on('line',l=>{JSON.parse(l);n++}).on('close',()=>console.log('lines:',n))"` 這類方式跑一次，確認每一行都是合法 JSON、欄位齊全（`messages`、`completion`、`split` 不可缺），再回報。

## 補充欄位（2026-11-11，對齊對照設計 DESIGN.edit-lora 的列格式）

除上面的欄位外，列可以帶：`tools`（Qwen3 chat template 的 `tools=`，Hermes `<tool_call>`）、`prefill`（接在生成提示後、不算 loss 的前綴，例如 `{"choice":`）、
`rejected`（錯誤行為範本，供 DPO）、`task`／`kind`／`group`／`tool`／`seen`（`seen`＝`unseen` 表示該列目標是 md5('rt:'+name)%5==0 的留出工具）。
`completion` 一律是 **prefill 之後的續寫**（例如 prefill `{"choice":`、completion ` 3}`）。`lora_common.normalize` 負責對應到訓練。
**留出工具規則**：heldout=true 的工具絕不出現在 split:"train" 列的 `tools`／選單裡（merge 後已檢查：0 列洩漏）。
新增產生器：`gen_tool_routing_full`、`gen_colu_full`、`gen_when2call`、`gen_natural`、`gen_agent`（含 writer）、`gen_wiring`、`gen_uml_edit`；共用 `w2c_common.js`；工具清單來自 `extract_tools.js`。

## 補充：`doc_knowledge` 領域（2026-11-11，資料匯入與清洗管線）
`renderer/src/studio/clean_core.js` 的 `ruleSamples`（`meta.author:'rule'`，純規則擷取）與老師生成並通過 `verifyTeacherSample` 的樣本使用 `domain:"doc_knowledge"`，`stage` 為 `rule_heading_summary`／`rule_code_comment`／老師自訂。
`meta` 必帶：`chunk_id`（對應語料塊）、`source`、`source_type`（wiki／open_source／book／aidoc）、`license`、`builtin_allowed`、`retrieved_at`。**授權 unknown／copyleft／使用者提供者 `builtin_allowed:false`，只能進使用者資產，不得內建化。**
