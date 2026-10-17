# 單元目錄（Unit Catalog）：第 1 步——呼叫原型抽取器

> 這份是逐步累積的設計與實測紀錄（第一到三十五節）。**要看整體怎麼想、每一塊負責什麼、要改從哪裡下手，先看 [DESIGN.colu.md](DESIGN.colu.md)（CoLU 設計指南）。**

2026-10-15。背景：想讓弱模型（Qwen3 0.6B）離線也能組出程式——把行為變成「有固定介面、可組合的單元」，程式負責接線與驗證，模型只在少數候選裡挑、填參數。這份只設計**第 1 步**：從三個執行環境（JavaScript、Python／Pyodide、bash 模擬器）自動抽出呼叫原型，產生單元目錄。直譯器、型別矩陣、規劃、編譯是後面的步驟，不在這裡。

## 一、目標與不做的事

**目標**：給定一個執行環境與一個模組（或指令），輸出一份機器可讀的目錄：每個可呼叫的東西是一個「單元」，有名稱、參數、型別（盡量）、副作用、可用性、測試案例（盡量）。

**不做**：
- 不執行不明的函式（有副作用的只讀簽名，不呼叫）。
- 不猜語意（不認得的型別就標 `any`，不編造）。
- 不處理類別的繼承關係（第一版只收函式與類別的公開方法，類別本身當建構函式一個單元）。
- 不在使用者離線時才抽取（見第六節：抽取在建置或有網路時做，產物當資料包發出去）。

## 二、單元描述（輸出格式）

```json
{
  "id": "py:statistics.mean",
  "runtime": "python",
  "module": "statistics", "name": "mean", "version": "3.11",
  "summary": "Return the sample arithmetic mean of data.",
  "params": [
    { "name": "data", "kind": "positional", "type": "list<number>", "type_src": "doc", "required": true }
  ],
  "returns": { "type": "number", "type_src": "doc" },
  "effects": [],
  "pure": true,
  "avail": { "needs": [], "state": "builtin" },
  "tests": [ { "args": { "data": [1, 2, 3, 4] }, "expect": 2.5, "src": "doctest" } ],
  "tier": 1
}
```

- **type_src**（型別從哪來）：`annotation`（原始碼的註解）、`stub`（型別存根檔）、`doc`（文件字串解析）、`name`（參數名稱的規則）、`probe`（探測執行）、`curated`（人工）、`none`（不明）。規劃時信任度依序遞減，`curated` 最高。
- **effects**：`fs.read`、`fs.write`、`net`、`proc`、`time`、`random`、`env`、`desktop`（要走桌面版主程式）。空陣列＋`pure:true` 才可以被探測執行。
- **avail.state**：`builtin`（執行環境本來就有）、`installed`（已安裝在目前的 Pyodide）、`cached`（套件已下載到快取，離線可裝）、`needs-network`、`unavailable`（沒有純 Python 版本或 Pyodide 沒有編好的版本，網頁版裝不起來）。離線規劃只用前三種。
- **tier**：1＝信任度夠、規劃會用；0＝只有索引、規劃預設不用（只有名稱與簽名）。

## 三、各執行環境怎麼抽

### Python（Pyodide 內執行，用 `inspect`）
- 簽名：`inspect.signature`。內建 C 函式有些拿不到（見下面實測），退回解析文件字串第一行的簽名寫法。
- 型別：先看註解，再看型別存根（見第四節），再看文件字串。
- 副作用：看模組與函式用了什麼（第五節）。
- 套件：抽之前先用 `micropip` 裝好；只有純 Python 套件與 Pyodide 官方編好的套件能裝，其他標 `unavailable`。

### JavaScript
- 內建物件與全域函式：用 `Function.length` 加手寫表（瀏覽器的內建函式沒有統一的簽名資訊）。
- 套件：有 `.d.ts` 就用型別宣告；沒有就用 JSDoc；都沒有只有名稱與參數個數。
- 我們自己登記的工具（`register_openai_tool`）：參數結構本來就有 JSON Schema，直接轉成單元，不用猜——這一塊最準，優先做。

### bash（模擬器）
- 指令沒有型別：輸入輸出都是文字串流。第一版只抽「指令名稱、`--help` 能解析出的選項」，型別一律 `text`，並標 `type_src:"none"`。
- 副作用用指令表（`cat` 讀檔、`rm` 寫檔、`curl` 網路…）手維護一份。

## 四、實測：Python 標準庫能自動抽到多少（用來校正期望）

在本機 CPython 3.10 上，對 20 個常用模組（json、re、math、statistics、csv、datetime、itertools、functools、string、textwrap、base64、hashlib、urllib.parse、collections、operator、random、os.path、shutil、zlib、html）的公開函式（不含類別）做了統計，共 292 個：

| 項目 | 數量 | 比例 |
|---|---|---|
| 拿得到簽名 | 281 | 96.2% |
| 有文件字串 | 289 | 99.0% |
| **有型別註解** | **0** | **0%** |
| 文件字串裡有可執行範例（doctest） | 20 | 6.8% |

這些數字改變了我先前的期望，要如實記下：
1. **簽名幾乎都有，名稱與參數沒問題**——索引這一層可以全自動。
2. **標準庫完全沒有型別註解。** 型別在 Python 另外的存根檔裡（執行時看不到），所以「自動抽型別」在標準庫上要靠別的來源，不是靠註解。
3. **文件範例只有約 7% 的函式有**，不能當測試案例的主要來源。我之前說「文件範例等於免費測試案例」太樂觀。主要集中在 `statistics` 這類模組（18 個函式裡 17 個有）。
4. 缺簽名的主要是 `csv` 的 C 實作函式（7 個全拿不到）和少數 `math`、`functools`，這些要靠解析文件字串補。

限制：這是本機 CPython 3.10，不是 Pyodide；Pyodide 的 Python 版本可能不同，標準庫大同小異，但數字要在 Pyodide 裡重跑一次才算數。

## 五、補型別與副作用

**型別補齊（由便宜到貴，每個欄位記錄來源）**
1. 註解（第三方套件常有）。
2. **型別存根**：把標準庫與常用套件的存根檔在建置時轉成型別表一起發出去（只取參數與回傳的型別名稱，簡化成我們自己的型別詞彙：`text`、`number`、`bool`、`list<T>`、`dict`、`bytes`、`path`、`any`…）。
3. 文件字串：解析 `:param x: ...`、`Parameters\n----------` 這類常見格式。
4. 參數名稱規則：`path`、`url`、`n`、`text`、`data` 等常見命名對應型別，信任度低，標 `name`。
5. **探測執行**（只對 `pure:true` 的函式）：依型別與預設值產生幾組輸入，在沙盒裡跑，記錄實際回傳型別，順便把成功的輸入輸出存成測試案例。
6. 人工補強：一份覆寫檔（`curated`），最常用的幾十個單元由人確認。

**副作用判斷（規則，不執行）**
- 所屬模組或函式呼叫了 `open`、`os`、`shutil`、`pathlib`（寫）、`socket`、`urllib.request`、`subprocess`、`time`、`random`、`os.environ`…→ 對應的 effects。
- 查不出來的，保守標 `effects:["unknown"]`，規劃預設不碰。
- 桌面版才有的能力（真實磁碟、系統指令）一律標 `desktop`，走現有的主程式通道與確認機制，不能被自動組合偷偷用。

## 六、什麼時候抽、產物放哪

- **抽取在「建置時或有網路時」做**，不是使用者離線時才做：Pyodide 載入與套件下載都貴。
- 產物是 JSON 資料包（接現有的「知識類型與資料包」機制），離線訓練器與規劃器直接讀，不需要載入 Pyodide 就能規劃。
- 檔案：`catalog/<runtime>/<模組>.json`，加一個 `index.json`（單元 id、名稱、摘要、tier、avail），索引單獨載入，細節按需載入。
- 預算：一個單元約 300 到 800 位元組，一萬個單元約 3 到 8 MB，要壓縮與分檔。

## 七、評量（第 1 步要回答的問題）

在 Pyodide 裡，對下面這組模組跑一次，量：

| 指標 | 怎麼算 | 過關（初步） |
|---|---|---|
| 簽名覆蓋率 | 有簽名的函式 ÷ 公開函式 | ≥ 95% |
| 型別覆蓋率（不含 `any`） | 有確定型別的參數 ÷ 全部參數 | tier 1 單元 ≥ 80% |
| 型別正確率 | 抽樣 100 個，人工核對 | ≥ 90% |
| 副作用判斷：漏報率 | 抽樣核對有副作用卻標純的 | 0（寧可多標） |
| 測試案例覆蓋率 | 有至少一組測試的單元 ÷ 純函式 | 先量，不設門檻 |
| 探測的安全 | 探測期間有沒有真的寫檔／連網 | 0 次（沙盒攔截） |

門檻先抓初步值，量完第一次再調；不過關的指標決定要補哪一種型別來源，而不是直接放寬門檻。

## 八、實作計畫

1. `renderer/src/catalog/catalog_core.js`（純函式，可在 node 測）：單元描述的驗證、型別詞彙、型別字串解析、副作用規則、文件字串解析。
2. `renderer/src/catalog/extract_py.py`：在 Pyodide 裡跑的抽取腳本（只用標準庫；輸出 JSON）。
3. `renderer/src/catalog/extract_tools.js`：把已登記的工具（JSON Schema）轉成單元——最準、最先做。
4. 評量腳本：在 Pyodide 與本機都能跑，輸出第七節的表。
5. 測試：`catalog_core.test.js`（格式驗證、型別解析、副作用規則、各來源的優先順序）。

## 九、風險

- **型別覆蓋率可能不夠**：標準庫 0% 註解已經證實；若存根轉換加文件解析仍不到目標，只收 tier 1 的人工清單，其餘當索引。
- **探測執行的安全**：探測是整個流程裡唯一會真的執行不明函式的地方，只限 `pure:true`、在沙盒內、有時間與輸出上限；任何一次碰到禁止的能力就中止並降級成 `unknown`。
- **版本漂移**：Pyodide 升級後單元要重抽，目錄要帶 `version` 欄，不符就標過期，不要沿用。

## 十、第 1 步（已登記工具 → 單元）實作與實測

程式：`renderer/src/catalog/catalog_core.js`（`FaCatalog`，純函式，測試 `catalog_core.test.js` 76 項）；指令 `/unit-catalog [json]`（顯示統計，加 json 會存成 `unit-catalog-<平台>.json`）。

規則：
- 參數型別從 JSON Schema 轉：`string → text`，名稱含 path／url／file_id／yaml／code／query 的細分（標 `name`）；`integer → int`、`number`、`boolean → bool`；陣列 `list<T>`；列舉 `enum<a|b>`；`oneOf` `union<…>`；有屬性的物件 `object{k:T}`；沒型別但名稱像數字（seconds、limit、fps…）推成 `number`（標 `name`）；其餘 `any`（標 `none`）。
- 副作用只看工具名稱的規則表（不執行任何東西），名稱規則對不上的標 `unknown`，`unknown` 的單元一律是信任等級 0。
- 信任等級 1＝有參數結構、有說明、型別都明確、副作用已判斷、這個平台能用（網頁版遇到 `desktop` 的工具標 `unavailable`）。
- 型別字串可解析成語法樹，`isAssignable(from, to)` 判斷接得上接不上（path → text 可以，反過來不行；int → number；列表協變；列舉子集；聯集；物件欄位），之後建接線矩陣用。

**實測（桌面版，200 個已登記工具）**

| 指標 | 結果 |
|---|---|
| 單元數 | 200（沒有參數結構的 7 個） |
| 格式驗證不合法 | 0 |
| 信任等級 1 | 185（92.5%） |
| 參數型別明確 | 838 個參數中 99.0%（參數結構寫明 85.4%、靠名稱猜 13.6%） |
| 型別還不明的參數 | 8 個：behavior_define.data、compose_video.captions、extract_video_frames.times、offline_trainer.last_tool_result、offline_trainer.pattern、ref_define.data、sandbox_mock.value、start_dubbing_session.ranges |
| 副作用有規則對上 | 100%（只代表規則有對上，**不代表判斷正確**） |
| 沒有參數結構 | add_ai_function、call_ai_function、delete_ai_function、list_ai_functions、rag_delete、rag_query_graph、rag_store_graph_node |

注意與限制：
1. **「副作用 100%」是規則有對上，不是人工核對過的正確率**。第七節要求的「漏報率 0」還沒量。寫這個版本時就發現規則會漏：中文語音（走 API 轉接）與轉逐字稿（第一次下載模型）原本只標了讀寫狀態、沒標連網，已補上。其他工具還需要抽樣核對。
2. 型別有 13.6% 是靠參數名稱猜的，信任度比 JSON Schema 低；規劃時應該看 `type_src`。
3. 沒有參數結構的 7 個、型別不明的 8 個參數，是工具定義本身該補的（補完單元自動變好），不是抽取器的問題。
4. 回傳值型別目前一律是 `json`（`type_src:"none"`）：工具都回傳 JSON 字串，沒有宣告回傳結構。要做接線矩陣前，這一塊必須補（見下一步）。
5. 沒有測試案例（`tests:[]`），工具有副作用，不能探測執行；測試案例來源要另外想（例如離線訓練器蒸餾時的成功呼叫紀錄）。

## 十一、回傳型別與接線矩陣（第 1 步的延伸）

程式：`catalog_core.js` 的 `inferReturns`、`renderer/src/catalog/matrix_core.js`（`FaCatalogMatrix`，測試 `matrix_core.test.js` 51 項）；指令 `/unit-catalog`（統計含矩陣）、`/unit-catalog path <起始型別> <目標型別> [cast]`。

### 回傳型別怎麼推
工具回傳的都是 JSON 字串，Schema 沒有回傳結構。依序：
1. **人工補強**（`advancedSettings.unitCatalogReturns[工具名稱] = 型別字串`，標 `curated`）。
2. **說明文字裡的欄位清單**：找「回傳／返回／returns」後面配對的 `{…}`，每個欄位依名稱／字面值推型別（標 `doc`）：`ok`→bool、`*_file_id`→file_id（`pdf_file_id`→pdf_file 等依媒體種類細分）、`*Seconds`→number、`*count/*Pages/sizeBytes`→int、`*_url`→url、`*_path`→path，複數名稱→list<any>，其餘 any。
3. **工具名稱**：`is_／has_`→bool、`get_*_yaml`→yaml、`list_*`→list<dict>（標 `name`）。
4. 都推不出來 → `json`（萬用結構，標 `none`）。

### 不明型別怎麼處理（萬用結構）
統一當 `json`（任意 JSON 值），**預設不接線**：它接不到任何具體輸入（file_id、path、url…），否則整張圖會被雜訊淹沒。要用就明確打開 `cast`：不明輸出可以「強制轉型」接到任何輸入，邊分數固定 0.2，路徑上標 `cast`，執行時必須檢查實際內容符不符合（漸進型別）。同樣的，`list<any>` 不能當具體清單用，只能走強制轉型。

### 檔案識別碼的細分
`file_id` 太粗：PDF、影片、音訊、字幕都是 file_id，把 PDF 接去燒字幕在型別上「合法」但沒意義。所以細分成 `pdf_file`、`video_file`、`audio_file`、`image_file`、`gif_file`（也是 image_file）、`subtitle_file`，都是 `file_id` 的子型別：子型別可以放進一般 file_id 的位置，反過來不行；種類不明的 `file_id` 接到指定種類只給 0.5 分。來源：欄位名稱（`video_file_id`）、參數名稱（`video`、`subtitle`，且說明有提到 file_id）。

### 接線矩陣
- 單元 A 的輸出（整個回傳值，加上物件的每個欄位）接得上單元 B 的哪個參數 → 邊；邊分數＝接收端型別的具體程度（file_id／path／url 1.0，列表與物件 0.25–0.8，text 0.15，數字／bool 0.1，不明 0）。預設只收分數 ≥ 0.5 的邊，所以 text 對 text 這種幾乎什麼都接得上的不算接線。
- 只收信任等級 1、副作用已知、這個平台可用的單元。
- 布林矩陣用位元列存，`boolMul` 做連乘，`reachWithin(A, L)` 算「最多 L 步可達」；路徑搜尋用它剪枝（走到某個節點後，剩下的步數內到不了任何終點就不再展開），另有展開次數上限。
- 路徑得分＝起點分數 × 每條邊分數 × 終點分數 × 0.9^(步數−1) × 每個還缺必填參數的單元 1/(1+0.1×缺的個數)；同分時短的優先。
- `cast` 邊分數固定 0.2，所以型別明確的路徑一定排在前面。

### 實測（桌面版，200 個已登記工具）
| 指標 | 結果 |
|---|---|
| 回傳型別已知 | 23%（說明文字推出 35、名稱推出 11；不明 154） |
| 矩陣 | 182 × 182（只收等級 1、可用的單元），邊 375，密度 1.14%，完全沒有出入邊的單元 131 |
| 搜尋速度 | 一次路徑查詢 1–5 毫秒；矩陣建構約 40 毫秒 |
| 允許 cast | 邊數增加到約 2 萬 4 千（密度約 74 倍），全部是 0.2 分的低信心邊 |

**這個矩陣目前只在「檔案流」上有訊息**：由 PDF、影片、音訊、字幕、圖片的產生與消費串起來的鏈（例如逐字稿 → 字幕 → 燒字幕 → 動態 GIF）。其餘 131 個單元沒有任何邊，因為它們的回傳型別不明。

### 要老實講的問題（實測看到的）
1. **種類不明的 file_id 參數會產生看起來合理、實際沒意義的接線。** 例如影片 → 擷取 PDF 頁面：`extract_pdf_pages` 的參數只寫「file_id」沒寫是 PDF，型別上放得進去。解法是人工補這些工具的參數種類（見下面清單，優先補檔案類工具）。
2. **只問「起始型別 → 目標型別」的路徑會有大量一步就達成的平凡答案**（任何一個吃 file_id 又吐 file_id 的單元）。真正有用的是指定起點單元與終點單元，或加上語意（之後由離線訓練器的意圖比對給目標單元）。
3. 回傳型別只有 23% 已知，矩陣在文字、狀態、瀏覽器、程式碼類工具上是空的。這些工具要靠人工補強，或之後讓離線訓練器蒸餾時記錄實際回傳結構。
4. 欄位型別是從名稱／字面值猜的（標 `doc`、`name`），不是從實際回傳值學來的；規劃時要看來源，不要當成保證。

### 回傳型別不明的工具（154 個，統一當萬用結構；請人工補強熱門的幾十個）
add_chapters, analyze_large_file, apply_git_patch, attachment_apply_patch, bash_execute, begin_presentation, big_content, browser_activate_tab, browser_click, browser_close, browser_create_tab, browser_create_tab_group, browser_get_elements, browser_get_page_structure, browser_get_page_text, browser_list_downloads, browser_list_tabs, browser_mouse, browser_navigate, browser_press_key, browser_scroll, browser_status, browser_type_text, browser_wait_download, call_ai_function, ci_connections, ci_guide, ci_triage, coding_edit, coding_patch_tool, coding_read_file, coding_run_check, coding_run_tests, coding_task_state, coding_workspace, compare_images, define_snippet, delegate_to_machine, delegate_to_subagent, delete_ai_function, design_choices, diagnose_log, explain_build_error, explain_code, extract_pdf_images, extract_pptx_images, extract_video_frames, fap_apply_patch, fap_copy_from_storage, fap_copy_to_storage, fap_download_url, fap_find_file, fap_list_files, fap_write_file, fetch_web_page, fs_find_file, fs_grep, fs_list_files, fs_mkdir, fs_read_file, fs_remove, fs_stat, fs_write_file, gerrit, get_3d_scene_topic, get_large_file_analysis_chunk, get_presentation_topic, get_saved_script, get_tool_details, get_viewer_state, git_clone, git_commit, git_inspect, git_log, git_pull, git_push, git_status, github_ci, glue_define, glue_list, glue_report, image_decompose_redraw, image_parts_annotate, image_parts_teach, image_rig_animate, image_to_text, import_2d_animation_attachment, import_3d_model_attachment, import_fap_image, import_image_url, import_interactive_viewer_attachment, import_uploaded_image, interpret_image, jenkins, language_explore, log_ask, log_learn, mix_highlight, office_export_slide_images, open_existing_presentation, parse_uploaded_file, pipeline_inspect, playbook_state, pptx_inspect, pptx_to_deck, programming_domains, programming_knowledge, python_execute, rag_chunk_document, rag_delete, rag_query_graph, rag_store_graph_node, read_skill_file__4f8a41c9-5d9c-449f-869c-f3442fa7c794, read_skill_file__ba5a3f00-a78e-4967-a540-20f0aae6b175, read_skill_file__d999c385-cc44-410d-a789-064828afccce, ref_define, ref_expand, ref_lookup, ref_resolve, ref_types, ref_validate, register_saved_script, render_2d_animation, render_3d_scene, render_chart, render_drawing, render_interactive_viewer, repo_ask, repo_map, repo_read_doc, repo_sql, repo_wiki, run_command, sandbox_capabilities, sandbox_html, set_viewer_state, skill_create, skill_list, skill_read, summarize_large_text, terminal_cp_from, terminal_cp_to, terminal_get_text, terminal_list, tmux_capture_pane, tmux_kill_session, tmux_list_sessions, tmux_send_keys, tmux_start_session, uefi_parse, uml_design, uml_guide, uml_to_code, youtube_download

## 十二、不認得的函式庫 → 單元：Python 抽取器（第 3 步的第一個環境）

程式：`renderer/src/catalog/extract_py.py`（只用標準庫，只讀不呼叫被抽取的函式）、`catalog_core.js` 的 `unitFromPyProto`／`pyTypeToType`、指令 `/unit-catalog extract python <模組…> [install=套件,…]`（在 Pyodide 裡跑，抽出的單元放進目錄，`/unit-catalog json` 一起存出）；測試 `extract_py.test.js`（41 項，有 python 時會真的跑一次抽取腳本）。

單元多了「怎麼叫它」的資訊：`call: { runtime: 'python', import: 'statistics', qualname: 'mean', via: 'pyodide' }`（launch path）、`sig_src`（簽名從哪來：inspect 或解析文件字串）、`version`、`tests`（文件範例）。

型別來源（Python）：註解（標 `annotation`）→ 參數名稱（`path`、`url`…，標 `name`）→ 預設值（`True`→bool、`3`→int，標 `default`）→ 不明（`any`／`none`）。`str`、`list[str]`、`Optional[int]`、`int | None`、`Union`、`Literal`、`Path` 等註解字串會轉成我們的型別詞彙；對不上的不猜。`*args`／`**kwargs` 不進參數；`Callable` 參數不能用 JSON 傳，單元一律信任等級 0。

信任等級 1 的條件（Python）：簽名完整、參數型別都明確、副作用已知、可用（內建或已安裝）、**而且有測試案例或回傳型別明確**。沒有東西可以驗證的，不管簽名多完整都不信任。

**實測（桌面版 Pyodide，Python 3.14.2，4 個標準庫模組 113 個函式，約 4.4 秒）**
| 指標 | 結果 |
|---|---|
| 拿得到簽名 | 100% |
| 參數型別全部明確 | **9.7%** |
| 有文件範例當測試 | 17.7% |
| 判斷為純函式 | 87.6%（用模組白名單，不是驗證出來的） |
| 副作用還不明 | 0% |
| 信任等級 1 | **1 個（0.9%）** |

結論：**簽名與副作用可以全自動，型別與測試是瓶頸。** 標準庫沒有型別註解，所以信任等級 1 幾乎是空的。下一步要補的是（由便宜到貴）：
1. **型別存根**：把常用標準庫與套件的存根檔（`.pyi`）在建置時轉成型別表（標 `stub`），`ast` 就能解析，不需要新工具。
2. **探測執行**（只對純函式、沙盒內、有時間與輸出上限）：依參數名稱與文件字串猜幾組輸入，真的執行，記錄實際輸入輸出型別與成功的呼叫當測試案例（標 `probe`）。型別由「執行驗證過」比「猜的」可靠。
3. **讓 0.6B 看文件字串提型別建議，再由探測驗證**：模型的建議只是候選，驗證失敗就丟掉。
4. 文件範例（doctest）有些依賴前面的設定行（例如先定義別名 `F`），單獨執行會失敗，驗證時要先檢查範例用到的名稱解析得到，解析不到的不算測試。

限制：目前只抽模組層級的函式，類別（建構子與方法）、非 Python 的環境（JavaScript、bash）還沒做；`install=` 只裝得起純 Python 套件與 Pyodide 官方編好的套件；抽取腳本沒有做逾時保護（有些模組匯入時會有副作用，應該限定在 Worker 內並加逾時）。

## 十三、型別存根轉換（把標準庫的型別補進來）

程式：`renderer/src/catalog/stub_to_types.py`（只用標準庫的 `ast`，建置時跑一次）、`catalog_core.js` 的 `unitFromPyProto`（有存根表就查，標 `stub`）、指令 `/unit-catalog stubs`（附上型別表載入，存進檔案快取 `unit-catalog-stubs.json`，之後自動使用）；測試 `stub_to_types.test.js`（33 項）。資料 `renderer/src/catalog/data/stdlib_types.json`（來源與授權見同資料夾 README）。

轉換做的事：
- 只收模組層級的函式（含 `@overload`、`async def`、`*args`／`**kwargs`、僅位置／僅關鍵字參數）。類別與方法第一版不收。
- 依目標 Python 版本與平台選 `if sys.version_info >= (3, 13):`、`if sys.platform == "win32":` 的分支。
- **TypeVar 展開**：有限制條件→聯集（`_NumberT` → `float | Decimal | Fraction`）、有 bound→bound、都沒有→Any。
- **型別別名展開**（含跨檔案，`StrPath` 在 `_typeshed`）；遞迴別名只展開 3 層，之後當 Any；一個函式的註解展開後超過 600 字元就放棄（Any）。展開時必須複製節點（`NodeTransformer` 會就地修改，共用節點會被改成循環）——這是第一次跑整個 typeshed 時踩到的坑（15 個函式遞迴爆掉）。
- **多載合併**：每個參數的註解取聯集、回傳型別取聯集；不是每個多載都有的參數標成選填。
- **轉出**：`from genericpath import exists as exists`、`from posixpath import *` 這種，把來源模組的函式也算在這個模組底下（`os.path` 的函式定義在 genericpath／posixpath）。
- 轉成我們的型別詞彙：`SupportsFloat`→number、`SupportsIndex`→int、`StrPath`／`PathLike`→path、`ReadableBuffer`→bytes、`float | Decimal | Fraction`→number（int 併入 number；text 與 path 並列時取 path）。

**實測**（typeshed commit `86d68f86`，2026-10-14，752 個存根檔 2.8 MB，轉換約 3 秒；產出 490 個模組、3412 個函式、690 KB JSON，轉換錯誤 0）：

在 Pyodide（Python 3.14.2）裡對 `statistics`、`json`、`os.path`、`math` 的 113 個函式抽取：

| | 沒有存根 | 有存根 |
|---|---|---|
| 參數型別全部明確 | 9.7% | **74.3%** |
| 信任等級 1 | 1（0.9%） | **81（71.7%）** |
| 標 `stub` 的參數 | 0 | 143 個 |

（本機 CPython 3.10 抽出的 133 個函式、7 個模組另測：回傳型別明確 0% → 79.7%，信任等級 1：1 → 87。）

**抽樣核對**：信任等級 1 裡每三個取一個、共 30 個，我逐個讀型別，沒有看到明顯錯誤（例如 `statistics.correlation(x: list<number>, y: list<number>) → number`、`math.comb(n: int, k: int) → int`、`os.path.isfile(path) → bool`）。**這不是設計文件第七節要求的「100 個抽樣、正確率 ≥ 90%」**，只是一個粗略的檢查。

要老實講的限制：
1. **存根是「宣告的型別」，不保證執行時真的如此**，也沒有用執行驗證過。信任等級 1 的意思是「型別已知，而且有範例或回傳型別可以對照」，不是「驗證過」。探測執行才是下一步。
2. 型別表是 Python 3.14、linux 的版本；其他版本的函式簽名可能不同（例如 3.13 才有的 `statistics.kde`）。
3. 仍然不明的參數（`Any`、`SupportsCeil[T]` 這類泛型協定、類別型別）會保持不明，不猜：這次樣本裡有 28 個單元有不明參數。
4. `Callable` 參數與回傳 `Callable` 的函式一律信任等級 0（不能用 JSON 傳）。
5. typeshed 的授權：多數檔案是 Apache-2.0 與 MIT 雙授權；型別表只留函式名稱、參數名稱與註解文字，散布時要附來源說明（已寫在資料夾 README）。
6. 重新產生時 typeshed 的版本會變，轉換結果也會變，資料 README 記了 commit。

## 十四、探測執行（把「宣告的型別」升級成「驗證過的型別」）

程式：`renderer/src/catalog/probe_py.py`（在 Pyodide／CPython 裡跑）、`probe_core.js`（`FaCatalogProbe`：產生輸入、把結果套回單元）、指令 `/unit-catalog probe [模組…]`（只探測 `/unit-catalog extract` 抽出、而且判斷為純函式的單元）；測試 `probe_core.test.js`（50 項，有 python 時真的跑一次探測腳本）。

流程：
1. **產生輸入**（確定的，不用亂數）：依參數型別與名稱提示。int→`0,1,5,-3`（名稱像 n、k 的用正數）、number→`0.5,1.5,2.0,0.25`、text、bytes（`{"$bytes":"<base64>"}`）、path、url、`list<number>`（幾條等長的清單，所以同型別的兩個清單參數長度一致）、enum（每個值）、union（交錯）。any／callable／file_id 這類沒有可靠產生方式的，必填參數沒有候選就略過並說明原因。最多 6 個案例（必填參數輪流取候選，再各補一個選填參數）。
2. **執行與防護**：每個案例執行兩次；稽核掛鉤（`sys.addaudithook`）擋下檔案開啟、網路、子行程、系統呼叫、刪改檔案、`exec`／`compile` 這類事件（碰到就中止那次呼叫，記成 blocked）；`SystemExit` 等也只記成失敗，不會結束程序；結果與 repr 截短，repr 裡的記憶體位址去掉再比較。**逾時由主程式終止整個 Worker**（卡在 C 函式裡的呼叫沒辦法從裡面中斷），下一次重新載入 Pyodide。
3. **關鍵字呼叫失敗改位置參數**（例如 `math.log`，存根寫關鍵字、實際是僅位置參數）：重試一次並記錄，單元的參數種類改成 positional。
4. **套回單元**：
   - 回傳型別：宣告不明（`any`）→ 以觀察到的為準（標 `probe`，`verified:true`；混合型別不猜）；宣告明確 → 每個觀察值都放得進宣告才算驗證過，否則記 `type_conflict` 並降成信任等級 0。
   - 參數：有成功案例用到的參數標 `verified`（只代表「接受這種型別」，不代表會拒絕別的型別）。
   - **測試案例**：成功、結果穩定、能轉成 JSON 的呼叫最多 3 個，標 `src:"probe"`（連同文件範例最多 5 個）。
   - 結果不穩定（兩次不同）標 `nondeterministic`，不拿來當測試。
   - 全部案例都失敗 → 信任等級 0（記下前三個錯誤）；失敗是「輸入被拒絕」（TypeError／ValueError／其子類別）還是別的錯誤會分開計。

**實測（桌面版 Pyodide，Python 3.14.2，16 個純標準庫模組、242 個函式；有型別存根）**
| 指標 | 結果 |
|---|---|
| 探測的單元 | 162（其餘 80 個沒有可靠的測試輸入，例如參數是 any、callable） |
| 至少一個案例成功 | 148 |
| 驗證過（有成功案例、型別相符、結果穩定） | **148（91.4%）** |
| 型別衝突（存根宣告與實際不符） | 0 |
| 結果不穩定 | 0（修掉 repr 位址誤判之前是 15，全是物件預設 repr 帶記憶體位址） |
| 被擋下的危險呼叫 | 0（這批本來就都是純函式；防護靠測試另外驗證：`open`、`os.system` 被擋、檔案沒有被建立） |
| 探測總時間 | 341 毫秒 |
| 信任等級 1（這 242 個） | 129（探測前 134，探測讓 5 個依賴「存根寫的參數種類」的單元降級，例如 `math.log` 的關鍵字問題——這就是探測該抓到的事） |
| 新增探測測試案例 | 118 個單元 |
| 逾時保護 | 跑 `time.sleep(100)` 在 4.0 秒被終止，之後 Worker 重新啟動，下一個探測正常 |

全部失敗的 14 個多半是「我們產生的輸入不合這個函式的要求」，不是函式壞掉：`json.loads`（一般文字不是合法 JSON）、`base64.b64decode` 等（不是合法 base64 字串）、`zlib.decompress`（不是壓縮資料）、`urllib.parse.urlunparse`（要 7 個元素的序列）。補法是依函式名稱、文件字串加輸入提示，或讓 0.6B 提候選輸入再由探測驗證。

限制（要老實講）：
1. **「型別相符」只代表這幾組輸入沒有打臉存根**，輸入是我們猜的，涵蓋不到的情況（負數、空字串、極端值）沒有驗。「驗證過」不是「證明正確」。
2. **衝突 0 也可能是檢查太鬆**：`isAssignable` 對 any 兩邊都通，存根寫得寬（例如 `Any`、`Iterable[Any]`）就不太會衝突。
3. 只探測純函式（模組白名單）。有副作用的（檔案、網路）不探測，要走別的（有沙盒檔案系統、模擬網路的）驗證，還沒做。
4. 稽核掛鉤會擋 `open`：函式內部第一次 `import` 一個還沒載入的模組也會觸發，會被誤擋；這批沒有看到，但換別的模組可能出現。被擋的次數在統計裡有列。

## 十五、還沒解決的：callable、回呼、觀察者、背景工作

**現狀**：參數或回傳值是 `Callable` 的單元一律信任等級 0（JSON 傳不了函式）。回呼（callback）、觀察者（observer）、工作者（worker）、執行緒（thread）也一樣——它們不是「傳一個值」，而是「傳一段行為」或「事後才發生的事」。這是呼叫格式本身要擴充的部分，不是型別存根能解決的。

**分階段做（由容易到難）**：
1. **高階函式（callable 參數）**：型別詞彙新增 `fn<(A,B)->R>`（存根的 `Callable[[float], float]` 已經有簽名，直接轉）。呼叫格式新增兩種「函式值」：`{"$ref": "py:math.sqrt"}`（引用目錄裡一個單元）與 `{"$lambda": {"params":["x"], "body": <呼叫格式>}}`（用我們自己的呼叫格式寫的小函式，由直譯器包成 Python 的 callable）。矩陣上多一種邊：單元的簽名符合 `fn<…>` 的槽就能接進去。探測時從一個小的候選函式庫（恆等、加倍、取反、是否偶數、轉字串…）依簽名挑來傳。可以驗證 `sorted(key=…)`、`functools.reduce`、`map`、`filter`。
2. **迭代器與產生器**：回傳 `Iterator[T]`／`Generator` 的單元，直譯器一律「取前 N 個」物化成 `list<T>`（有上限、有逾時），型別標成 `stream<T>`，接到下游時才展開。
3. **觀察者／事件**：註冊回呼加上之後才發生的事件。在沙盒裡用「有限次數、有逾時」的方式捕捉：註冊、觸發（單元提供或探測腳本自己觸發）、收集前 N 個事件，記成 `stream<Event>`。不支援長時間常駐的訂閱。
4. **工作者與執行緒**：Pyodide 沒有真正的執行緒，JavaScript 有 Web Worker。呼叫格式新增 `spawn`（回傳 `task<T>` 控制代碼）、`await`、`channel`，副作用標 `proc`（並發）；驗證用「確定的排程」（固定順序、有逾時與取消）才有可重現的測試案例。不做共享記憶體。

每一階段都要先有「怎麼驗證」才算完成：沒有可重現的測試案例，就不能升到信任等級 1。

## 十六、整份打包成 AI 可呼叫的建置工具（自我演化）

構想：模型遇到一個全新的 Python 套件時，自己呼叫一個工具，把「取得套件 → 抽取 → 補型別 → 探測 → 登記」整條流程在 Python 模擬器裡跑完並記錄起來。

**可行，而且零件都已經有了**：`micropip` 安裝（`install=`）、抽取（`extract_py.py`）、型別存根（`stub_to_types.py`＋型別表）、探測（`probe_py.py`）、單元格式與驗證（`catalog_core.js`）、矩陣（`matrix_core.js`）。缺的是：
1. **一個工具外殼**（暫名 `catalog_onboard`）：參數是套件名稱（或 git 網址）、要抽的模組、要不要探測；回傳統計與新單元的摘要。進度要分階段回報（安裝、抽取、探測），每階段有逾時與取消。
2. **取得來源**：`micropip`（只有純 Python 套件與 Pyodide 官方編好的套件）；`git clone` 在瀏覽器裡要走 CORS 代理或 isomorphic-git，只能讀公開的小倉庫；桌面版可以直接用真實的 git，但那就離開沙盒了，要走既有的確認機制。
3. **持久化與版本**：單元目錄要存進 IndexedDB／檔案快取，帶套件版本、抽取時間、來源（pypi／git commit）、Python 版本；套件升版要標過期，不能沿用舊的單元。
4. **品質關卡（自動晉升的條件）**：不是抽出來就能用。信任等級 1 要滿足：型別已知、有探測或範例測試、至少一次驗證成功、沒有衝突、副作用已判斷。副作用不明的、全部探測失敗的，只放在索引、規劃預設不用。AI 想用信任等級 0 的單元，要明確標示風險並經過確認。
5. **安全**：**安裝套件與匯入模組本身就會執行不明程式碼**（`setup`、模組層級的程式碼）。必須在隔離的 Worker 裡做，不給檔案系統與網路以外的能力，匯入也要受稽核掛鉤與逾時保護；探測只對純函式；有副作用的單元不自動探測。供應鏈風險（套件被投毒、名稱搶註）要有來源白名單或人工確認，不能讓模型自己決定去裝任何套件。
6. **資源上限**：套件下載大小、抽取的函式數量、探測次數、總時間都要有上限，超過就停並回報。

**「自我演化」的邊界**：它能讓系統**認識新的工具**（目錄長大）、**驗證自己認識得對不對**（探測、測試案例），但**不能自己決定要不要信任它**（晉升條件由人定、風險動作要確認），也不會改自己的程式碼。目錄長大之後，由離線訓練器的意圖比對與型別矩陣去組合，這一層才是「創造力」。

## 十七、catalog_onboard：認識新函式庫的工具外殼（已做）

程式：`renderer/src/catalog/onboard_core.js`（`FaCatalogOnboard`：請求驗證與安全關卡、摘要、持久化合併、過期判斷、查詢；測試 `onboard_core.test.js` 52 項）、`floating-assistant.js` 的 `_unitCatalogOnboard`（管線）。入口三個：
- 工具 `catalog_onboard {modules, packages?, probe?}`（給模型用）；
- 工具 `catalog_query {action: search|show|path|stats, …}`（查已認識的單元：關鍵字、吃什麼型別／回什麼型別、只看可信任的、型別接線）；
- 指令 `/unit-catalog onboard <模組…> [install=套件,…] [noprobe]`。
兩個工具在新的領域 `unit_catalog`（提示：先查目錄有沒有、再 onboard；不要替使用者決定安裝；回報要誠實，沒信任的要講原因）。

**管線**（有進度卡片，可停止）：驗證 → （PyPI 套件）使用者同意 → 乾淨的 Worker → 安裝並抽取 → 補型別（存根） → 探測純函式 → 登記 → 存檔（檔案快取 `unit-catalog-python.json`，重新載入後自動讀回；同一個模組重新抽取會先清掉舊的單元，不留已經消失的函式）→ 丟掉安裝過套件的 Worker。

**安全關卡**（這是整件事最需要小心的地方）：
1. 只接受 PyPI 套件名稱（可加 `==版本`）：網址、`git+`、本機路徑、`@`、空白、`-r…` 一律拒絕；一次最多 20 個模組、5 個套件。模型不能指定任意來源。
2. **要安裝的套件每次都要使用者同意**（跳出對話框，說明「安裝與匯入本身會執行套件裡的程式碼」），除非套件在 `advancedSettings.unitCatalogPackageAllowlist`。標準庫模組不需要同意。
3. 匯入就會做事的模組不給匯入（`antigravity`、`tkinter`、`turtle`、`webbrowser`、`http.server`、`pip`…）。
4. 匯入期間用稽核掛鉤擋下網路、子行程、開瀏覽器、系統呼叫；探測期間再擋檔案與刪改。
5. 安裝與匯入在乾淨的 Worker 裡做、結束後終止（不留下被套件改過的狀態）；每階段有逾時（安裝加抽取 120 秒、探測整批 30 秒、單一函式 8 秒），逾時就終止 Worker。
6. 探測只對純函式。第三方模組的「純」是**靜態判斷**（模組原始碼沒有匯入 os、socket、subprocess…、沒有呼叫 open、eval、exec…），只是疑似純：靜態純的單元**一定要探測驗證過才升信任等級 1**；探測時被稽核掛鉤擋下的事件會**學成副作用**（只增不減），靜態判斷錯了在這裡改正。

**實測（桌面版 Pyodide）**
| 情境 | 結果 |
|---|---|
| 標準庫 4 個模組（`statistics`、`math`、`json`、`os.path`）一次做完 | 4.6 秒；113 個單元，**可信任 84（74.3%）**；探測 83 個、驗證過 81；全程沒有詢問使用者（標準庫不需要） |
| 沒晉升的原因 | 參數型別不明 22、有 callable 6、探測全部失敗 1 |
| 壞請求（`antigravity`、`git+https://…`、空 modules、`os;rm`） | 全部在驗證階段被擋，沒有詢問、沒有執行任何東西 |
| 要安裝套件、使用者按取消 | 回傳「使用者沒有同意，沒有做任何事」，沒有安裝 |
| 重新載入頁面 | 存檔的 113 個單元與 1 筆紀錄自動讀回；`catalog_query` 的 search、show、takes／returns 篩選、path 都能用 |
| 真的用 micropip 安裝 PyPI 的 `six`（使用者同意） | 5.6 秒；six 1.17.0；43 個單元、**可信任 0**：`six` 用了 `exec`、匯入 `sys`／`types`，靜態判斷不純，副作用不明 → 信任等級 0（原因：副作用不明 40、沒有簽名 3）。這是對的：不明的東西不該自動信任 |

第一次安裝套件失敗，原因是隔離的 Worker 沒有預先載入 micropip（`pyodide_js.loadPackage("micropip")` 要先做），已修。

要老實講的限制：
1. **第三方套件目前幾乎拿不到信任等級 1**：很多套件會匯入 os／sys 之類，靜態判斷保守地判不純，副作用就是「不明」。要提高比例，需要把「不純」細分出副作用種類（目前只有探測被擋下的事件能學到），或讓使用者確認某些套件的副作用。
2. 探測輸入是猜的；`math.prod` 這類回傳型別由探測填的單元，我加了保護（輸入可能是小數時，只看到 int 就放寬成 number，標 `widened`），但整體上「探測驗證過」不是「證明正確」。
3. `git clone` 沒有做（瀏覽器沙盒沒有 git，也不讓模型指定任意網址）。桌面版真實的 git 屬於離開沙盒，要走另外的確認。
4. 套件過期判斷（`staleUnits`）已寫好、已測，但還沒接到「載入時提醒」。
5. 沒有 `catalog_onboard` 的取消按鈕測試：停止鈕會在階段之間生效，卡在一次安裝或匯入裡時只能等逾時。
6. 只做了 Python；JavaScript、bash 的 onboard 沒有。

## 十八、副作用細分（第三方函式庫的函式層級靜態分析）

問題：第三方套件的函式原本只有「疑似純」或「不明」兩種，信任等級 1 幾乎拿不到（`six` 43 個函式裡副作用已知的只有 3 個）。做法：對每個模組層級的函式（含類別的建構與方法）讀原始碼，分析它「直接做的事」和「呼叫了誰」，再沿呼叫鏈合併。程式在 `extract_py.py` 的 `analyze_module`。

**直接做的事（看 AST，不執行）**
- `open(...)`：看模式字串，預設與 `"r"`／`"rb"` 是 `fs.read`；含 `w`／`a`／`x` 是 `fs.write`；含 `+` 兩者都算；模式不是常數字串兩者都算。
- `os` 依函式名稱分：`getenv`／`putenv` 是 `env`、`listdir`／`stat`／`getcwd` 是 `fs.read`、`remove`／`rename`／`mkdir` 是 `fs.write`、`system`／`popen`／`exec*`／`spawn*`／`fork` 是 `proc`、`urandom` 是 `random`；`os` 裡沒分類到的函式標 unknown（不默默當成純）。
- `subprocess` 是 `proc`、`socket` 與常見網路函式庫（`requests`、`httpx`、`urllib3`、`aiohttp`…）是 `net`、`time` 是 `time`、`random` 是 `random`、`logging` 與 `print` 是 `ui`、`pathlib` 建構 `Path` 與取 `.name` 是純、`.read_text()` 是 `fs.read`、`sys` 呼叫是 `env`（`getsizeof` 之類除外）。
- 接收者不明的方法呼叫：只有「名稱幾乎只做這件事」的才算（`connect`／`sendall` 是 `net`、`write_text` 是 `fs.write`、`unlink`／`rmdir`…）；`read`／`write`／`remove` 太常見（在 list、檔案物件、參數上都有）不算。
- `global` 陳述、修改模組層級容器（`_cache.append(…)`）、指定給匯入模組的屬性（`sys.stdout = …`）是 `state.write`；只讀模組層級的值不算。
- 呼叫「參數」（回呼）與對「傳進來的檔案物件」讀寫：效果屬於呼叫者傳入的東西，不算這個函式的副作用。
- `eval`／`exec`／`compile`／`__import__`：unknown（推不了）。

**沿著呼叫鏈合併**：呼叫同模組的函式或類別（類別取它所有方法的聯集），遞迴與互相呼叫會停；同一次抽取裡先分析過的別的第三方模組，呼叫它們時取它們的結果；呼叫不認得的第三方模組是 unknown，並記下是哪個（`effect_evidence` 裡的 `unresolved 模組.函式`，統計會列出最常擋住判斷的呼叫，補規則表就能解開）。

**信任規則**
- 沒有任何效果、完全解析得開：疑似純（`pure_src:"static"`），**一定要探測驗證過**才升信任等級 1（原本就有的規則）。
- 有確定的效果、沒有 unknown：可以升信任等級 1，但標 `effects_src:"static"`——這是**證據推出來的下限**，沒有驗證。onboard 的回報會分開列：可信任裡副作用靠靜態分析推的有幾個、純函式且探測驗證過的有幾個。
- 只要有一個呼叫解析不開，就帶 unknown，信任等級 0。
- 探測時被稽核掛鉤擋下的事件仍然會學成副作用（只增不減），靜態分析漏報的在這裡補。

**實測**
- 測試：`extract_py.test.js` 從 49 項到 71 項，用一個 40 多個函式的假模組逐項驗證上面每條規則，包含：`open` 各種模式、遞迴、兩層呼叫鏈、類別建構、巢狀函式、跨模組、回呼參數、`pathlib`、`sys`、`os` 未分類。
- 真的用 micropip 安裝 PyPI 的 `six` 1.17.0：副作用已知的單元從 3 個（只有原本判的）變成 15 個（全是疑似純）；仍然 unknown 的 28 個（`six` 大量用 `exec`／動態屬性，這是真的推不了）。
- **信任等級 1 仍然是 0。** 原因不是副作用：`six` 沒有型別註解，參數型別不明（12 個單元）→ 沒辦法產生探測輸入 → 純函式無法驗證 → 不能升級。

要老實講的限制：
1. **靜態分析會漏報。** 動態屬性、`getattr`、`exec` 產生的程式、猴子補丁、C 擴充模組、框架的隱含行為都看不到；`state.write` 只認我列出的幾種寫法。這就是為什麼純的一定要探測驗證、而有效果的標「靜態推的、沒驗證」。
2. 接收者不明的方法呼叫用名稱猜，可能把別的東西誤判成 I/O（例如自訂類別的 `.connect()`），誤判的方向是多報，風險較小。
3. **下一個瓶頸是沒有型別註解的第三方套件：** 沒有型別就產生不出探測輸入。要解的話：從預設值與文件字串推型別；讓 0.6B 看文件字串提型別候選、再用探測驗證；或接受人工補強。
4. 只做 Python。

## 十九、實測 Qwen3 0.6B：挑單元與填參數（2026-10-16，筆電 CPU、WebAssembly 後端）

測試集：46 題（33 個 Python 題、21 個工具題裡能達到信任等級 1 的部分，另有 8 題「清單裡沒有正解」的負面題）、18 題填參數。單元全集 314 個當干擾項；每題用固定亂數種子洗牌；一共 186 次呼叫、約 17 分鐘。

### 結果

| 項目 | 結果 | 備註 |
|---|---|---|
| 檢索（BM25）正解進前 5 名 | 純文字 60.5%；加上中文用途說明 92.1% | 英文函式庫只有英文簽名時，中文需求幾乎檢索不到；補中文用途說明是最大的單一改善 |
| 檢索第 1 名就是正解 | 純文字 36.8%；加用途說明 73.7% | |
| 0.6B 從 5 個候選裡挑（正解一定在裡面） | 28.9%（隨機 20%） | 只比亂猜好一點 |
| 0.6B 從 10 個候選裡挑 | 39.5%（隨機 10%） | 候選多反而較高，是因為樣本小且位置偏好剛好蓋到，不能解讀成「越多越好」 |
| 檢索 5 個候選再讓 0.6B 挑 | 23.7% | 比「直接取檢索第 1 名」的 73.7% 差很多 |
| 負面題（沒有正解）能拒絕 | 13% | 強迫它選一個時，幾乎都硬選 |
| 位置偏好 | 76 次裡有 39 次選第 1 個，而正解在第 1 個的只有 10 次 | 明顯偏好第一個 |
| 填參數（給定正確單元） | JSON 合法 100%、必填齊全 100%、完全一致 66.7%、欄位正確 68.4%、多寫不存在的欄位 5.6% | 這部分堪用 |

### 提示改動的教訓

第一版提示寫「沒有適合的就回答 0」，結果 0.6B 常拿 0 偷懶：正解就在清單裡也有 62.5%（8 題小樣本）回 0。改成一定要選一個後拒絕率歸零，但「沒有正解」的題就變成硬選（拒絕 13%）。拒絕要另外做：用「這個工具能完成這個需求嗎（是／否）」二次確認（`verifyMessages`／`parseYesNo` 已寫好並有測試，**還沒有實測**）。

### 結論（誠實版）

- 0.6B **不能**當「從一堆候選裡挑對的」那一步：接近亂猜，而且偏好第一個。這一步該由檢索（加用途說明）負責，取第 1 名就有 73.7%。
- 0.6B 可以做的：把需求轉成參數（JSON 合法率 100%、約三分之二完全一致）；以及（待實測）對單一候選回答是／否。
- 所以「弱模型 + 單元目錄」的分工應該是：檢索縮小範圍 → 型別接線矩陣再縮小 → 0.6B 只做填參數與單點確認，**不做開放式選擇**。
- 限制：樣本小（46 題）、單一種子、單一機器、題目由我寫（可能偏好單元描述寫法）；數字用來判斷方向，不是精確指標。

## 二十、執行格式（IR）與直譯器

程式：`renderer/src/catalog/ir_core.js`（`FaCatalogIR`，純函式加注入的執行器，測試 `ir_core.test.js` 56 項）；主機端 `_unitCatalogInvoke`／`_unitCatalogRunProgram`；工具 `catalog_run`、`catalog_query` 的 `plan`；指令 `/unit-catalog plan <起點> <終點>`、`/unit-catalog run <JSON>`。

**為什麼要有它**：前面的單元目錄、型別接線矩陣都只是「查得到、接得上」，沒有東西能執行一條組合。0.6B 不寫程式碼，它只在候選裡挑單元、填參數；挑出來的東西要有一個**確定的、可檢查的、可停止的**格式來承載，才不會又回到「叫模型寫一段會炸的程式」。

**格式**（JSON）：
```json
{ "inputs": { "link": { "type": "url" } },
  "steps": [
    { "id": "dl",  "call": "tool:download", "args": { "url": { "$in": "link" } } },
    { "id": "pdf", "call": "tool:to_pdf",   "args": { "file_id": { "$ref": "dl.file_id" } } },
    { "id": "each1", "each": { "$ref": "se.urls" }, "max": 3, "do": [ { "id": "g", "call": "tool:download", "args": { "url": { "$item": "" } } } ] },
    { "id": "i", "if": { "$ref": "dl.ok" }, "then": [ … ], "else": [ … ] } ],
  "return": { "$ref": "pdf" } }
```
- **值**：字面值、`{$in:輸入名稱}`、`{$ref:"步驟id.路徑"}`（路徑支援 `a.b[0].c`、`a[*].x`）、`{$item:路徑}`（each 裡的當前項）、`{$list:[…]}`、`{$obj:{…}}`（裡面還能再引用）。
- **控制流只有兩種，而且都有上限**：`if`／`else`、`each`（每個迴圈一定要有 `max`，上限 200）。沒有 while、沒有遞迴、沒有自訂函式。巢狀最多 4 層、最多 60 個步驟、整個程式最多 500 次呼叫、整個程式 10 分鐘、單一步驟 2 分鐘。這是刻意的：弱模型寫出來的程式一定要能保證會停。
- **沒有任何運算**：資料處理一律是呼叫單元（`py:statistics.mean`、`py:json.loads`…），格式本身只負責接線。

**靜態檢查**（執行前，錯一個都不執行）：單元存在且可用；必填參數齊全、沒有多餘參數；字面值符合參數型別（含列舉、清單元素）；引用的輸入有宣告、引用的步驟在前面；**引用的型別接得上參數的型別**（用矩陣同一套 `isAssignable`；沿著回傳型別的欄位往下找，`list<url>` 的元素是 url）；`each` 的來源必須是清單；彙整所有步驟的副作用，可以限定允許的範圍。不明型別的來源（回傳 json／any）預設只給警告（標「強制轉型，執行時檢查」），`strict` 時當錯誤。信任等級不是 1 或副作用不明的單元也只給警告。

**直譯器**：照順序執行、把每步的結果放進變數、依 `$ref` 取值；每步有逾時、可取消、有確認閘（指定的副作用要先問）、有模擬執行（`dryRun`：只檢查與記錄「會做什麼」，不呼叫任何東西）；步驟回 `ok:false` 或丟例外就停（`onError:"continue"` 才繼續，並把錯誤放在那一步的結果裡）；每一步都留執行紀錄（參數、結果摘要、副作用、耗時）。呼叫怎麼真的發生由 `host.invoke` 注入：工具單元走 `fa.tools`（回傳 JSON 字串就解析）、Python 單元**只限純函式**，丟進 Pyodide 沙盒（稽核掛鉤擋檔案與網路）呼叫一次，結果必須能轉成 JSON 才能傳給下一步。

**從矩陣到程式**：`fromPath(路徑)` 把 `findPipelines` 找到的一條接線轉成程式——第一步的起點參數成為有型別的輸入，前一步輸出欄位接到下一步參數（`{$ref:"s1.file_id"}`），其他必填參數變成有型別的輸入。這個骨架是通過靜態檢查的，模型之後要做的只是「選哪條」和「填輸入」。

**執行前的同意**：程式的副作用含 `fs.write`、`proc`、`desktop`、`delegate`、`net` 其中任何一個時，執行前跳出對話框，顯示整個程式（人看得懂的文字）和副作用，使用者同意才開始；模擬執行不需要。

**限制**：
1. 沒有資料轉換原語。像「取清單前 3 個」「把兩段文字接起來」這種小事要靠目錄裡有對應的單元。
2. 回傳型別大多不明的工具（約四分之三），引用它們的欄位只能是強制轉型。
3. Python 單元只能執行純函式；有副作用的 Python 函式（檔案、網路）還沒有可驗證的執行環境。
4. 只有工具與 Python 兩種單元；JavaScript、bash 的單元沒有。
5. 高階函式（callable 參數）、迭代器、事件、工作者都還不支援（第十五節）。

## 二十一、語意補強與需求接線（2026-10-16）

### A. 歷史呼叫逆向推論（`shape_core.js`，`FaCatalogShape`）

目的：工具回傳都是 JSON 字串，Schema 沒寫回傳結構。第七節的做法是從說明文字、工具名稱推，推不出來就是不明（json／any），沒辦法接線。這裡改成**從過去成功的呼叫留下的實際回傳值**反推。

- 樣本來源：①對話紀錄裡 assistant 的 tool_calls 配上後面 role:tool 的完整回傳（完整樣本）；②離線訓練器 turns 裡 `calls[].res`（只有第一層純量欄位，部分樣本）；③之後每次工具成功，`_callToolGuarded` 順手累積（`_unitCatalogObserve`，同步、很便宜，8 秒合併存檔）。
- 失敗的呼叫（`ok:false`、有 `error`）不採用；超過 20 萬字元的不看。
- 單一值 → 型別：布林、int／number、字串（網址看值；path／各種 file_id／yaml／code 看欄位名稱，沿用第七節的欄位規則）、清單（元素合併）、物件（最多 16 個欄位、3 層，超過退回 dict；欄位名稱不合法退回 dict）。
- 多個樣本合併：int＋number→number；字串的細分型別退回共同上層（pdf_file＋video_file→file_id、path＋url→text）；null＋X→X（標可為空）；缺的欄位標成選填（`returns.optional`）；型別衝突做聯集，超過三種退回 any；空清單的元素型別等看到非空的才補。
- **只存型別，不存值**（部分樣本也在存進去之前轉成型別）。狀態是 JSON，存在 fileCache 的 `unit-catalog-shapes.json`，下次接著累積。
- 套進目錄的規則（`buildOverrides`）：只補不明的。回傳是 json／any／dict → 整個換成觀察到的（`type_src:'observed'`，附樣本數與選填欄位）；文件推出來的物件裡某些欄位只有 any／list<any> → 只換那些欄位；人工補的（curated）、探測的、型別註解、存根的一律不蓋。Python 單元不動。
- 手動覆寫 `advancedSettings.unitCatalogReturns` 的優先權最高。
- 指令：`/unit-catalog shapes`（看現況）、`/unit-catalog shapes scan`（把目前對話與離線訓練器紀錄補進來）、`/unit-catalog shapes clear`。

實測（新的測試設定檔，幾乎沒有歷史）：工具單元回傳不明 155 個；呼叫了安全、不用必填參數的 fs_stat、skill_list、glue_list 各兩次後，變成 154 個不明、3 個 observed（例如 fs_stat → `object{ok:bool,path:path,isDirectory:bool,isFile:bool,size:int,mtimeMs:number}`）。**這只證明機制通了，不代表 155 個會補完**：補得了多少取決於使用者實際用過哪些工具；沒有用過的工具、回傳不是 JSON 的工具、永遠失敗的工具，都不會有樣本。新設定檔裡零參數又無副作用的只有 2 個可以安全主動呼叫，我沒有去呼叫有副作用或需要參數的工具。

限制：①觀察到的是「這幾次看到的」，沒看過的分支（例如錯誤時多出來的欄位）不在裡面；樣本少的型別要看 `samples`；②部分樣本無法確定「沒有其他欄位」，所以只有部分樣本的工具所有欄位都是選填；③清單元素最多看 20 個，混雜的元素型別只做聯集；④檔案識別碼的種類是從欄位名稱判斷（`pdf_file_id`→pdf_file），名稱沒帶種類的只能是 file_id。

### B. 需求 → 活動 → 單元（`bind_core.js`，`FaCatalogBind`）

目的：UML 的使用案例原本只呼叫「類別.操作」（第二十節之前，沒有接到單元）。這裡把每個步驟接到單元目錄的單元，產出可以直接 `catalog_run` 的呼叫程式。**整個流程 0 次模型呼叫**。

流程（對每個使用案例的每個步驟）：
1. **型別合約**：UML 型別 → 目錄型別（str→text、int、float／decimal→number、bool、date／datetime→text、List<T>→list<T>、Map→dict、Optional<T>→T、列舉→enum<…>、有屬性的類別→object{…}、Url／Path／PdfFile／Yaml 等名稱→對應的具體型別，認不得的→any、void→沒有回傳）。
2. **挑單元**：用「類別＋操作名稱」檢索（BM25，跟第十九節同一套；可以帶中文用途說明 intents）。操作名稱裡的每個字有多少比例出現在單元的名稱或說明裡（含單複數），低於 60% 的不採用（實測發現只靠一個共同字會錯配：countPages 配到 remove_pdf_pages、sendEmail 配到 tmux_send_keys）。名稱完全一樣的優先。
3. **打分**：檢索相對分數 × (0.4＋0.6×必填參數接得上的比例) × (0.5＋0.5×回傳符不符合 UML 宣告的回傳；回傳物件裡有一個欄位符合也算 0.9；回傳不明給 0.6)。低於 0.25 不採用；低於 0.5 列為「信心偏低」。
4. **資料流**：第一步的 UML 參數就是使用案例的輸入。之後每個單元參數：同名的資料優先，其次型別接得上（得分 ≥ 0.3）的最近一個；接不上就用型別接線矩陣從手上的資料找一小段橋接單元（例如 url →下載→ file_id →轉 PDF→ pdf_file）；找不到才變成輸入，UML 有宣告同名參數的當輸入不算問題，沒宣告的標 `unwired`。前一步回傳型別不明、導致後面只能當輸入的，標 `opaque_link`——這就是任務 A 的效益所在：補了回傳結構，這個警告才會消失、資料才接得起來。
5. **沒有單元對得上**，但 UML 有明確的輸入與回傳型別：直接用矩陣從輸入型別走到回傳型別（`type-wiring`），並標 `wired_by_type`。
6. 輸出的程式一定經過 `FaCatalogIR.validate`；`issues` 列出所有不確定的地方（沒對上、沒接上、信心低、靠型別勉強接上）。

介面：`catalog_bind` 工具（給 UML 文字）、`/unit-catalog bind <UML>`。

實測（真實目錄，311 個信任等級 1 的單元，矩陣 311×311、544 條邊）：
- 用真實工具寫的 UML（removePdfPages、fsStat、getPresentationYaml→renderPresentation）：4 步全部對上正確的單元，3 個程式檢查通過、完全接通，0 次模型呼叫、約 110 毫秒。renderPresentation 的 name 參數是使用案例的輸入，yaml 接前一步的輸出。
- 用目錄裡**沒有**的東西寫的 UML（countPages、sendEmail、convert）：正確地回報找不到，沒有亂配。這也是真實限制：目錄裡很多媒體工具的檔案參數是選填，不在「必填參數接得上」的接線範圍內；沒有數頁數、寄信的單元。

限制：①檢索靠名稱與說明，UML 命名跟單元名稱差太遠（或中文操作名稱）就對不上——語意檢索（神經嵌入、重排）還沒做，這是下一步；②目前只看必填參數；③只做直線流程，UML 沒有分支與迴圈的語意，所以不會產生 if／each；④多個單元都合理時只取最高分，其他在 `candidates` 裡；⑤不會執行，執行用 `catalog_run`。

## 二十二、實測神經嵌入與語意重排（2026-10-16）

模型：`Xenova/multilingual-e5-small`（8 位元量化，約 118MB，WebAssembly，主執行緒）。查詢加 `query: `、單元文字加 `passage: ` 前綴，平均池化後正規化，用餘弦相似度。單元文字＝名稱＋說明＋必填參數名稱（「加用途說明」的版本再接上中文用途說明）。測試集同第十九節：38 題有正解、8 題沒有正解；候選全集 314 個信任等級 1 的單元。

| 方法 | 第 1 名 | 前 3 | 前 5 | 前 10 | 平均倒數排名 |
|---|---|---|---|---|---|
| BM25（純文字） | 36.8% | 52.6% | 60.5% | 63.2% | 0.455 |
| 神經嵌入（純文字） | 39.5% | 50.0% | 63.2% | 73.7% | 0.500 |
| BM25＋中文用途說明 | 73.7% | 84.2% | 92.1% | 94.7% | 0.807 |
| 神經嵌入＋中文用途說明 | 73.7% | 89.5% | 94.7% | 97.4% | 0.823 |
| 兩者排名融合（RRF，純文字） | 47.4% | 63.2% | 63.2% | 65.8% | 0.555 |
| **兩者排名融合（RRF）＋中文用途說明** | **84.2%** | **94.7%** | **97.4%** | 97.4% | **0.888** |
| BM25 前 20 名再用嵌入重排＋用途說明 | 81.6% | 97.4% | 97.4% | 97.4% | 0.882 |
| 分數加權融合（0.3 BM25）＋用途說明 | 78.9% | 92.1% | 97.4% | 97.4% | 0.860 |

### 結論
- **中文用途說明是最大的單一改善**（前 5 名 60.5% → 92.1%），神經嵌入單獨用在純文字上只小幅改善（前 10 名 63.2% → 73.7%）。也就是說 multilingual-e5-small 沒有真的補上「中文需求 vs 英文函式名稱」的缺口，補這個缺口靠的是人（或 AI）寫的中文說明。
- 在有用途說明的前提下，嵌入加 BM25 的融合最好：第 1 名 73.7% → 84.2%，前 5 名 92.1% → 97.4%。這個提升是真的，但**樣本只有 38 題，一題就是 2.6 個百分點**，第 1 名多對的是 4 題。
- 重排（BM25 取前 20 再用嵌入排）跟融合差不多，前 3 名反而最高（97.4%）；沒有明顯贏過 RRF，實作上 RRF 比較簡單（不用先決定取前幾名）。
- 唯一沒進前 5 名的題：「把這份資料畫成長條圖」→ `render_chart`（排在第 183 名），兩種方法都沒辦法找到——該單元的說明沒有提到圖表。
- **拒絕（清單裡沒有正解）**：用「最高相似度」分正解題和無正解題，面積指標 0.961（加用途說明）／0.901（純文字）。但分布有重疊：有正解的最低 0.832，沒正解的最高 0.859，所以固定門檻會誤殺少數正解題；比 0.6B 的「是／否」確認（還沒實測）更便宜，可以先當第一道篩選。
- 成本：載入模型約 8 秒；314 個單元文字嵌入約 50 秒（每個變體），查詢每句約 0.15 秒（主執行緒、WebAssembly、這台機器）。單元文字只需要算一次並存檔，查詢的成本可以接受。

### 限制（要看清楚）
1. 38 題太少，差距在 5 個百分點以內不要當真。
2. 中文用途說明是我跟測試集一起寫的，可能剛好貼近題目的說法，「加用途說明」的數字偏樂觀；真實使用者的說法會更雜。
3. 只測了一個嵌入模型（沒有比 paraphrase-multilingual-MiniLM、Qwen3-Embedding-0.6B）。
4. 沒有實測 UML 操作名稱（英文駝峰）當查詢的情況。
5. 這一節只是量測，**還沒接進產品**：目前的檢索（挑單元、`catalog_bind`）仍是 BM25。若要接，做法是：單元嵌入算一次存檔（跟單元目錄同版本），查詢時 BM25 與嵌入各取排名，RRF 融合；嵌入模型沒下載或載入失敗時退回 BM25。

## 二十三、把中文用途說明與語意檢索接進 catalog_bind（2026-10-16）

### 中文用途說明（intents）
- 內建一份 `renderer/src/catalog/data/unit_intents.json`（單元 id → 一句中文）：原本評測用的 33 個，加上這次補的 124 個（13 個英文說明的工具、111 個 Python 標準庫函式：math、statistics、posixpath、base64、urllib.parse…）。補完後，信任等級 1 的 311 個單元裡，「說明不是中文、也沒有用途說明」的剩 0 個。
- 使用者／AI 補的存在 `unit-catalog-intents.json`（fileCache），優先於內建。
- 工具 `catalog_intent`：`action:"missing"` 列出還缺的（id、英文說明、必填參數）；`action:"set"` 一次補多個（驗證：單元要存在、2～80 字、要有中文）；`action:"list"`。指令 `/unit-catalog intents`。以後 `catalog_onboard` 認識新函式庫後，缺的說明就是請 AI 用這個工具補。
- 用途說明同時用在 BM25 與嵌入的單元文字；說明改了，該單元的向量自動失效重算。

### 語意檢索（嵌入）
- 模型：`Xenova/multilingual-e5-small`（8 位元量化約 118MB，WebAssembly，頁面主執行緒，分批並讓出執行緒不卡畫面）。**第一次啟用要使用者同意下載**（`/unit-catalog embed enable` 會跳確認視窗）；下載後在瀏覽器快取，之後載入約 2 秒。
- 向量：311 個單元約 47 秒算完，存在 `unit-catalog-embeddings.json`（Float32 → base64，每個單元附文字雜湊）。單元的說明、用途說明、必填參數任何一個變了，只重算那一個。
- 指令：`/unit-catalog embed`（狀態）、`enable`、`build`（補算）、`disable`。
- 沒啟用、模型載入失敗、或向量覆蓋率低於 50% 時，`catalog_bind` 自動退回名稱檢索（BM25），並在結果的 `semantic_note` 說明原因；不會因為嵌入壞掉而整個失敗。

### catalog_bind 怎麼用嵌入
1. 每個步驟的查詢句（類別名稱＋操作名稱的字）同時做 BM25 與嵌入排名，用倒數排名融合（RRF）取前 14 名。
2. 原本的門檻「操作名稱的字要有 60% 出現在單元名稱／說明裡」保留。新增第二條路：嵌入排名第 1，而且**比這句話對全部單元的平均餘弦高 3 個標準差以上**，也算對得上（`by:'semantic+contract'`，並在 issues 加 `semantic_match` 讓人看得到）。
3. 為什麼用「高於平均幾個標準差」而不是固定餘弦門檻：實測英文駝峰操作名稱（`computeStandardDeviation`）的餘弦整體落在 0.79～0.88，比第二十二節中文查詢的範圍低，固定 0.86 會把對的都擋掉；改看相對平均的離群程度比較穩，但 3 這個數字是我從幾個例子挑的，**沒有經過大量資料校準**。
4. 型別合約、資料流、橋接、程式檢查全都照舊。

### 實測（真實目錄，311 個單元、8 個英文駝峰操作名稱的 UML）
| 操作 | 只用名稱檢索 | 加語意檢索 |
|---|---|---|
| `computeStandardDeviation(data)` | 沒對上 | `statistics.stdev`（語意；pstdev 是第二名，兩者本來就難分） |
| `wrapLongText(text)` | `textwrap.wrap` | `textwrap.wrap` |
| `splitUrl(url)` | 沒對上 | `urllib.parse.urlsplit`（語意） |
| `getQueryParams(qs)` | `urllib.parse.urlparse`（**不是最好的**） | 一樣（名稱路徑先贏了；嵌入第 1 名其實是正確的 `parse_qs`） |
| `checkPathExists(path)` | `posixpath.exists` | 一樣 |
| `fsStat(path)` | `fs_stat` | 一樣 |
| `drawBarGraph(type, categories, series)` | `render_chart` | 一樣 |
| `sendEmail(to)`（目錄裡沒有） | 沒對上 | 沒對上（最高只有 2.93 個標準差，沒過門檻） |

對上的步驟 5/8 → 7/8，多對上的 2 個都是正確的選擇，沒有新增錯配；負面題沒被硬配。

### 限制（要看清楚）
1. 只有 8 個步驟，是我寫的；這只是可行性驗證，不是基準測試。
2. `getQueryParams` 這種「名稱路徑先通過、但不是最佳」的錯配沒有被語意檢索修正；`exists` 與 `lexists`、`stdev` 與 `pstdev` 這類近義單元，目前是取最高分，不會問使用者。
3. 3 個標準差的門檻、14 名的融合長度都是經驗值。
4. 嵌入模型在主執行緒跑，算單元向量時介面會間歇卡頓（每批 8 個之間有讓出，但不是獨立 Worker）。
5. 向量檔約 640KB，單元數增加到幾千個時要改成分檔或 IndexedDB。

## 二十四、錯配修正（2026-10-16）

起因：`getQueryParams(qs)` 被配到 `urlparse`（名稱路徑先通過，語意檢索排名第 1 的 `parse_qs` 被擋在外面）。這是「合格候選之間怎麼比」的問題，不只是這一個例子，所以改的是比較方式，不是補特例。

### 改了什麼（`bind_core.js`）
1. **合格集合再排一次**：名稱路徑（操作名稱的字 ≥60% 出現在單元名稱／說明）或語意路徑（嵌入排名前 3、高於平均 ≥3 個標準差）通過的候選，一起用 `final` 分數排：
   `final ＝ 原分數 × (1＋0.4×參數名稱吻合) × (1＋0.3×名稱命中) × (0.8＋0.2×名稱精準度) × 嵌入加成`
   - **參數名稱吻合**：UML 操作的參數名稱跟單元必填參數名稱相同的比例（`getQueryParams(qs)` 對 `parse_qs(qs)`＝1，對 `urlparse(url)`＝0）。
   - **名稱命中**：操作名稱的字有幾成是單元『名稱』裡的整個字（`exists` 對 `posixpath.exists`，不是 `lexists`）。斷詞把字母串與數字串分開（`b64encode` → 64、encode；`base64` → base、64），才分得出 b64 與 b32。
   - **名稱精準度**：單元名稱的字有幾成被操作名稱說中（`median` 比 `median_high` 精準）；完全沒說中的給中間值，不處罰。
2. **光靠語意（名稱對不上）時**，參數名稱至少要有一個吻合，否則要高於平均 ≥5 個標準差才採用——擋掉了 `sendTextMessage` 被配到 `text_to_speech` 的誤配。
3. **難分的要標出來**：合格候選裡 `final` 差不到 10% 的，在 issues 加 `ambiguous`，並把備選放在 `alternatives`，不再默默取最高分。

### 實測（真實目錄；30 個英文駝峰操作＋3 個目錄裡沒有的；其中 21 個的正解單元在信任等級 1 的範圍內）
| | 對 | 錯 | 沒對上 | 負面題硬配 | 標「難分」 | 標難分且答案在裡面 |
|---|---|---|---|---|---|---|
| 只用名稱檢索（改前→改後） | 13 → 13 | 4 → 4 | 4 → 4 | 0 → 0 | 4 → 4 | 3 → 3 |
| 加語意檢索（改前） | 15 | 6 | 0 | **1** | 7 | 7 |
| 加語意檢索（改後） | **16** | 5 | 0 | **0** | 6 | 5 |

- 原本的例子：`getQueryParams` 現在配到 `parse_qsl`，不再是 `urlparse`——**但正解是 `parse_qs`，仍然沒有對**，只是從「完全不同的功能」變成「近親」。
- 剩下的 5 個錯全是近親單元：`pvariance`→`variance`、`parse_qs`→`parse_qsl`、`fnmatch`→`fnmatchcase`、`b64encode`→`b32encode`、`convertDegreesToRadians`→`degrees`（方向詞 To 沒有語意）。其中 5 個被標成難分的裡面有正解，也就是「錯」的多半有被標出來，讓人能複核。
- 負面題（`sendEmail`、`uploadToBucket`、`sendTextMessage`）：改後不再硬配。

### 限制
1. 30 題是我寫的，**而且我是看著失敗的例子調的權重**（中位數、b64、exists 這幾個都是調出來的），所以這組數字偏樂觀；沒有留一組沒看過的題來驗證。
2. 近親單元（`quote`／`quote_plus`、`stdev`／`pstdev`）只能靠標示難分來處理，程式沒辦法知道使用者要哪個。
3. 類別名稱會影響檢索（`Web.getQueryParams` 跟 `Net.getQueryParams` 結果不同）。
4. 「To／From」這類方向詞沒有語意處理。

## 二十五、找資料、讀懂別人的程式、缺口驅動的探索迴圈（2026-10-16）

起因：使用者的期待是「離線小模型要能讀 wiki、StackOverflow、GitHub README、使用手冊、設計文件，理解別人現有的程式，拼湊起來實現並自我修正」（例如給它一個拍貼機加美顏的需求，看它會不會自己找資料、了解各開源專案能做什麼、拼起來）。這一節把這條路拆成五步，先量弱模型（Qwen3 0.6B）每一步做得到多少，再把需要的程式補起來。

### 一、五步實驗（0.6B 對程式）
資料：6 個需求（拍貼機＋美顏、圖片合成 PDF、掃 QR code、資料畫長條圖、調整圖片大小、讀 Excel）、17 個真實專案的 README（face-api.js、jsPDF、pdf-lib、jsQR、Chart.js、sharp、Pillow…，從 GitHub API 取得，不放進版本庫），標註是我讀過後標的。評測集的標註在 `renderer/src/catalog/eval/discover_set.json`。0.6B 共 270 次呼叫，平均 4.4 秒。

| 步驟 | 衡量 | 0.6B | 程式（第一版） | 程式（調整後*） |
|---|---|---|---|---|
| ① 需求 → 英文搜尋關鍵字 | 關鍵概念涵蓋 | **83%** | 67%（只丟中文原文 19%） | 94% |
| ② 專案能不能完成需求 | 精確率／召回率 | **永遠回「是」**：11.8%／100%（跟亂猜一樣） | 62.5%／41.7%（用最好的門檻） | 66.7%／83.3%（預設門檻）；第 1 名正確 5/6、前 3 名有正解 6/6 |
| ③ README → 語言 | 正確率 | **100%** | 88% | 100% |
| ③ README → 能不能在瀏覽器跑 | 正確率 | 53%（讀開頭）／59%（讀地圖縮放挑的片段） | 82% | 88% |
| ④ 缺口偵測（這幾個專案裡有沒有人能做） | 正確率（亂猜 50%） | 8%（12 題有 11 題回答不是「有／沒有」） | 75% | 92% |
| ⑤ 錯誤訊息 → 下一步（6 選 1） | 正確率（亂猜 17%） | 29% | 100% | 100% |

\* 「調整後」是我看了第一版的失敗再改（詞庫擴充、相關度改成概念覆蓋率、泛用字降權、JavaScript 環境猜測…），**用的是同一組題**，所以偏樂觀；只有「第一版」那欄跟 0.6B 是在同樣沒看過的條件下比的。⑤ 的規則是我照這六類錯誤寫的，題目也是我照這六類出的，100% 不代表真實的錯誤訊息也能這樣。

結論：
- 0.6B **能做**：把中文需求改寫成英文搜尋關鍵字（比詞庫泛用，詞庫沒有的詞它也寫得出來）、判斷程式語言。
- 0.6B **不能做**：判斷專案能不能用（永遠說是）、看出環境、判斷缺口、從錯誤訊息選對策——這些交給程式。
- 長文：把 README 切片、縮放挑重點對 0.6B 判斷環境只多 6 個百分點，沒有解決問題；問題不在文字太長，在它判斷力不夠。
- 所以分工是：**程式讀長文、抽事實、投票、排名、歸類錯誤；模型只負責改寫搜尋關鍵字（可選，`use_model:true`）**。

### 二、JavaScript 單元抽取（`extract_js.js`）
語法樹由呼叫端提供（Node 測試用 acorn；應用程式第一次用到才從 CDN 載入 acorn，之後在瀏覽器快取）。找出對外提供的函式與類別方法：ES module 的 export、CommonJS（`module.exports`、`exports.x`）、UMD／IIFE 工廠函式（包含 `(function(){…}).call(this)`）回傳的物件、瀏覽器全域的頂層函式與類別、`Foo.prototype.bar`、靜態方法 `Foo.bar =`。參數來自簽名（預設值、解構、剩餘參數略過），型別來自 JSDoc `@param`／`@returns`、預設值、參數名稱（camelCase 轉 snake 再套欄位規則）。副作用靜態分析函式本體：網路、DOM／畫布（ui）、相機與檔案選擇器（desktop）、localStorage（state）、fs、child_process、亂數、時間、eval（unknown），並順著同一份檔案的呼叫鏈合併；方法用到 `this` 就不是純的。信任等級一律 0（沒有執行驗證）；規劃時用 `includeUntrusted`、`includeUnavailable`（矩陣與 `catalog_bind` 都加了這兩個選項）。
- 工具 `catalog_js`、指令 `/unit-catalog js <網址>`。
- 實測：CamanJS（118KB、CoffeeScript 編出來的檔案、完全沒有 JSDoc）抽出 127 個單元，匯出方式 static／prototype／umd；有型別的參數 14/162（因為沒有註解）。限制：壓縮過的檔案（函式名稱被縮短）抽出來沒什麼用；單元的實際「呼叫」還沒做（沒有 JavaScript 的探測與執行環境）；動態產生的匯出（迴圈裡 `exports[name] = …`）抓不到。

### 三、能力卡片（`card_core.js`）
- **切片**：依標題建章節樹（含 setext 標題、HTML 標題、維基 `== 標題 ==`）；程式碼區塊不拆開；太長的章節依段落切並保留重疊；每片大小可隨模型上下文長度調整（`contextTokens`）。
- **地圖縮放**：先只看地圖（標題與大小），依章節重要性在字數預算內由大到小放大讀（預設 12000 字）；重要性依文件種類（`readme`、`qa`、`wiki`、`guide`、`design`）有不同規則（例如問答的「答案」章節最重、維基的「歷史」「參考資料」最輕、設計文件重視架構與原則）；`wantTitle` 可以指名要放大哪一章。
- **每片段抽事實**（程式規則）：安裝指令（npm、pip、cargo、go…）、CDN 網址、語言（安裝指令、程式碼圍欄語言標籤、import 語法、文字線索）、執行環境、主要呼叫的函式、能力描述（條列項與開頭幾句的「動詞＋受詞」，過濾掉貢獻、測試、文件這類句子）、需要的條件（相機、WebGL、模型檔、API 金鑰、ffmpeg…）、是否停止維護、授權。
- **投票融合**：各片段的票依章節權重加總；欄位取得票最多的並附信心；能力與函式用相似度合併同義的；模型或其他來源可以用 `votes` 多投一票。另外有一句話說明（開頭第一個像樣的段落）與「讀過的字」供排名使用。
- 工具 `catalog_card`、指令 `/unit-catalog card <網址>`；GitHub 倉庫網址自動取 README（API）與倉庫描述，其他網址轉成文字。
- 速度：17 份真實 README（最大 61KB）每份平均 2 毫秒、最慢 14 毫秒。

### 四、缺口驅動的探索迴圈（`discover_core.js`）
需求（UML 或能力清單）→ `catalog_bind` 接線（含信任等級 0 與未安裝的單元）→ 沒有單元可用的步驟就是缺口 → 每個缺口產生**短**搜尋關鍵字（實測 GitHub 搜尋要每個字都出現，「pdf image pdf library」0 筆、「pdf image library javascript」十筆好的）→ `browser_search`（github、sourceforge、codeproject、stackoverflow）→ 讀每個候選的說明 → 能力卡片 → 依缺口排名 → （可選）有未壓縮的 CDN 檔就抽成單元再接一次線 → 計畫。
- **維基、問答、文章是「參考資料」**，不是採用對象（實測曾把維基的 PDF 條目當成「合成 PDF」的最佳專案）；計畫的 `references` 另外列出。
- **排名**用概念覆蓋率（絕對分數，不是每題最高分正規化成 1）：需求拆成概念組（詞庫命中的一個詞條是一組同義詞），泛用字（file、data、image、read…）降權；專案自己的名稱／一句話說明說中的算全額，只在 README 某處出現的算一半；環境不相容（Python 專案要瀏覽器）重扣、JavaScript 函式庫環境不明只輕扣；停止維護減半；不像函式庫的頁面（沒安裝方式、函式、語言）減半；需要 API 金鑰或伺服器扣分。
- **自我修正**：`classifyError` 把錯誤訊息歸成 11 類（缺套件、沒定義、API 用錯、權限、網路／跨來源、資源、語法、參數、非同步、逾時、找不到檔案）各對應下一步；`nextAttempt` 同一個候選＋同一個動作不重複、同一種錯在同一個候選最多修 2 次、修不動就換備選、備選用完放棄、看不出原因交給人。迴圈有 `tryRun` 掛鉤，沒有就只規劃。
- 工具 `catalog_discover`、指令 `/unit-catalog discover <UML>` 或 `need: 能力1; 能力2`。**只規劃，不安裝也不執行。**
- 全部用假的主機（搜尋、讀取、抽取、試跑）測試迴圈的每個分支（41 個檢查）。

### 五、真實環境的檢查（應用程式裡，連網）
- `catalog_card`：jsQR、glfx.js 的 GitHub 網址取得 README，語言、環境、安裝、函式、一句話說明都對。
- `catalog_js`：文字範例 3 個單元（含 `[net]`、`[state.write]`、`[ui]` 副作用）；CamanJS 原始碼網址 127 個單元，登記進目錄後目錄裡有 130 個 JavaScript 單元。
- `catalog_discover`（需求清單：擷取相機畫面、美顏濾鏡、把圖片合成 PDF）：3 個缺口都找到候選。美顏 → `WebAR-rocks/WebAR.rocks.face`（臉部偵測、追蹤、特徵點、WebGL，合理）；合成 PDF → `julianfbeck/localpdfmerger`（合併 PDF，接近但不是「圖片合成」）；**擷取相機畫面 → `alzin/SkyPath`（無人機鏡頭飛行路徑視覺化，錯的）**，備選裡的 `camera-capture` 比較對。這是靠詞比對的排名會犯的錯，沒有修好。
- 第一次實跑時發現並修掉的問題：詞庫的單字「畫」誤中「畫面」；查詢太長導致 GitHub 搜尋 0 筆；維基被當成採用對象；`fetchText` 要能回傳種類與描述。

### 六、限制（要看清楚）
1. 實驗題目少（6 個需求、17 個專案、14 個錯誤），標註是我標的，「調整後」那欄是對同一組題調的，偏樂觀。
2. 排名靠詞比對，沒有用嵌入（第二十二節的嵌入模型可以接，這裡沒接）；同義說法與歧義（「相機畫面」）會錯。
3. 能力描述（動詞＋受詞）品質普通；很多 README 把用途寫在連結的文件頁，README 本身只有安裝與連結。
4. 缺口驅動迴圈只規劃，沒有真的安裝套件、也沒有真的把候選拼進程式執行；「抽成單元再接線」只處理有未壓縮 CDN 檔的 JavaScript 卡片。`tryRun` 掛鉤已寫好、有測試，但應用程式端還沒有接上真正的試跑。
5. 搜尋用既有的 `browser_search`（需在進階設定開啟子 agent）；StackOverflow 的搜尋結果沒有網址，目前被略過；SourceForge／CodeProject 常回空或 403。
6. 弱模型在這條路上的角色很小（只有改寫關鍵字）；使用者希望 0.6B 自己讀懂 wiki、StackOverflow、README、使用手冊、設計文件——目前的結論是它的判斷力撐不起來，由程式做；要不要在某些步驟加更大的模型或線上 AI 當後援，是之後的決定。

## 二十六、排名接上嵌入模型（語意重排）與學出來的排名模型（2026-10-16）

使用者的想法：用傳統 NLP——語意重排、嵌入、迴歸——讓程式讀懂 StackOverflow、README、維基。這一節把第二十五節的排名改成「詞比對決定能不能採用，嵌入決定過關的誰排前面」，並實測用迴歸學權重。

### 一、第一次接法是錯的（量到才知道）
第一版把嵌入的相似度加進相關度分數。在 6 個需求×17 個專案上，精確率從 66.7% 掉到 47.6%、最好的 F1 從 60.6 掉到 30.5。原因：e5 對任何英文軟體說明的餘弦值都落在 0.8 附近，加進去之後不相關的專案也過了門檻。**嵌入拿來排同一題裡誰比較像是好的，拿來判斷『夠不夠像』是不行的。**

### 二、文件怎麼表示、查詢怎麼寫（同一個模型 multilingual-e5-small，每題一個查詢）
| 文件表示 | 查詢 | 第 1 名 | 前 3 名 | MRR | AUC |
|---|---|---|---|---|---|
| 名稱＋說明＋能力＋函式（原本） | 詞庫攤平的英文 | 5/6 | 6/6 | 0.92 | 0.84 |
| 只有一句話說明 | 詞庫攤平的英文 | 4/6 | 6/6 | 0.81 | 0.72 |
| 說明＋前三個能力 | 中文原句＋詞庫英文 | 6/6 | 6/6 | 1.00 | 0.80 |
| **README 開頭 600 字** | **詞庫攤平的英文** | **6/6** | **6/6** | **1.00** | **0.89** |
| README 開頭 600 字 | 中文原句（多語言模型直接比） | 5/6 | 5/6 | 0.88 | 0.75 |

README 開頭 600 字最好；讓多語言模型直接拿中文原句去比英文文件不如先用詞庫轉成英文。

### 三、現在的排名（`discover_core.rank`）
1. 詞比對算出分數（概念覆蓋率＋環境、停止維護、是不是函式庫…的加減分），**門檻（預設 0.35）決定能不能採用**，沒有改。
2. 過門檻、而且分數不低於最高分 60% 的候選，用嵌入（README 開頭 600 字，卡片的 `head`）對需求句的餘弦重排；其他的照詞比對分數。品質明顯差的（不像函式庫、停止維護、環境不合）不能靠語意相似擠到前面——實測第一版重排曾把一個 Spark AR 小遊戲排在 WebAR.rocks.face 前面。
3. 主機沒有提供嵌入（沒啟用 `/unit-catalog embed enable`、模型載不起來）就只用詞比對；嵌入出錯記在 trace，迴圈繼續。
4. 詞庫補了「擷取／抓取／截取」。

實測（6 個需求×17 個專案，同一組標註）：門檻上的精確率／召回率不變（66.7%／83.3%），**第 1 名正確 5/6 → 6/6、MRR 0.92 → 1.00**。樣本只有 6 題，一題差 17 個百分點，只能說方向。
真實環境（連網，3 個缺口）：
- 擷取相機畫面：原本選到無人機視覺化的 SkyPath（錯），現在選 `yusufsefasezer/javascript-camera-capture`（Take photos via webcam with JavaScript）——**修好了**。
- 美顏濾鏡：`WebAR-rocks/WebAR.rocks.face`（臉部偵測與追蹤，合理）。
- 圖片合成 PDF：`julianfbeck/localpdfmerger`（合併 PDF，接近但不是圖片轉 PDF）。

### 四、用迴歸學排名（`rank_train.js` ＋ `discover_core.featurize`／`predict`）
每個（缺口，候選）變成 13 個特徵（概念覆蓋、README 開頭覆蓋、餘弦、餘弦離群程度、餘弦名次、環境相符、環境不合、停止維護、有安裝方式、函式名稱對得上、像不像函式庫、需要金鑰或伺服器、有授權）；邏輯迴歸（L2、類別不平衡加權、特徵標準化）；留一個需求交叉驗證。訓練出來的模型是一個小 JSON，`rank(…, { model })` 直接用。
實測（留一個需求，不含訓練資料，是比較誠實的數字）：

| | 精確率 | 召回率 | F1 | 第 1 名 |
|---|---|---|---|---|
| 手調（詞比對，**在同一組題上調過，偏樂觀**） | 66.7 | 83.3 | 74.1 | 5/6 |
| 學出來：只有詞彙特徵 | 66.7 | 66.7 | 66.7 | 5/6 |
| 學出來：詞彙＋嵌入特徵 | 66.7 | 66.7 | 66.7 | 5/6 |
| 學出來：只有嵌入特徵＋少數旗標 | 29.6 | 66.7 | 41.0 | 5/6 |
| 學出來：精簡特徵 | 69.2 | 75.0 | 72.0 | 4/6 |

**結論：在這個資料量（102 筆、12 個正例）學出來的沒有贏手調的，加嵌入特徵也沒有幫助**；嵌入特徵單獨用很差（F1 41），它的價值是同一題裡排序，不是判斷好壞。迴歸要能贏，需要更多有標註的（需求，專案）配對——之後可以從使用者對 `catalog_discover` 計畫的採用／退回累積。機制（特徵、訓練、交叉驗證、模型載入）已經就位並有測試，目前沒有啟用學出來的模型。

### 五、限制
1. 6 個需求、17 個專案：所有「改善」都是方向性的；重排從 5/6 到 6/6 只是一題。
2. 嵌入的文件表示、查詢寫法、60% 門檻都是看這組題選的。
3. 沒有測 StackOverflow 問答、維基、設計文件的排名（只測了 README 專案頁）；那些在迴圈裡只當參考資料。
4. 嵌入模型 multilingual-e5-small 對「相機畫面」這種歧義有幫助，但對「圖片合成 PDF」與「合併 PDF」分不開。

## 二十七、採用／退回的回饋累積（2026-10-16）

目的：第二十六節的結論是「學出來的排名要贏手調，需要更多有標註的（需求，專案）配對」。這一節做累積標註的機制：探索計畫裡推薦的專案，使用者採用或退回、拿它試跑成功或失敗，都自動變成結構化標註，累積成排名模型的訓練資料。

### 一、流程
1. `catalog_discover` 產生計畫時，把每個缺口的推薦與備選連同**排名當下的特徵**（取決於當時那批候選，事後算不回來）和壓縮過的卡片記在記憶體裡（最近 12 個計畫），回傳 `plan_id`。
2. 使用者說採用／退回，或你在沙盒試過之後，呼叫 `catalog_feedback`（`plan_id`＋`gap`＋`verdict`）；`/unit-catalog feedback adopt|reject [缺口] [原因]` 也可以。`url` 可以指定要評的是備選。
3. 記成一筆標註存進 `unit-catalog-feedback.json`（fileCache）：需求句、執行環境、專案網址與名稱、標籤（1／0）、來源、失敗種類、當時的特徵、壓縮卡片、備選（附各自的特徵與卡片）。
4. `/unit-catalog feedback`（或 `catalog_feedback` 的 `stats`）看累積多少、還缺多少才夠訓練；`train` 做留一個需求的交叉驗證（四種正則化強度挑最好的）；`train save` 存模型（資料沒到門檻不存，除非 `force`）；`catalog_discover` 加 `use_learned:true` 才會用存下來的模型。`export` 匯出 JSON；`clear` 清掉。

### 二、標註的可信度（權重）
| 來源 | 標籤 | 權重 | 為什麼 |
|---|---|---|---|
| 使用者採用 | 1 | 1.0 | 明講的 |
| 使用者退回 | 0 | 1.0 | 明講的 |
| 試跑成功 | 1 | 0.6 | 間接，可能只是簡單的情境 |
| 試跑失敗：API 用錯／沒定義／缺套件 | 0 | 0.3～0.4 | 可能是專案不合，也可能是整合寫錯 |
| 試跑失敗：權限、網路、資源、逾時 | — | 0（不用） | 環境的問題，不是專案不好 |
| 使用者採用某個專案時，同缺口其他列出的備選 | 0 | 0.3 | 只是「這次沒被選」 |

覆蓋規則：使用者的結論和試跑的結果分開算；使用者改變主意以最新的為準，試跑也以最新的為準；**試跑失敗（例如權限被擋）不會蓋掉使用者說的「採用」**；使用者後來明講對某個備選的結論，會取代原本「備選＝輕的負例」。
資料量：一筆最壞約 6.4KB（含 3 個備選的壓縮卡片），上限 1500 筆約 10MB，超過丟最舊的。只存卡片的摘要欄位與 README 開頭 600 字，不存整份 README。

### 三、「可以訓練了嗎」
至少 8 個需求組、10 個正例、20 個負例（交叉驗證才有意義）。沒到的時候 `train` 仍然會跑，但會標出缺多少，數字只當參考。`rank_train.fit` 支援樣本權重。

### 四、實測（應用程式裡，連網）
跑 `catalog_discover`（擷取相機畫面、美顏濾鏡）→ 2 個缺口都有推薦，回傳的 JSON 沒有卡片與特徵（太大）→ 對一個缺口 adopt、對另一個 reject（附原因）、對第一個缺口記權限被擋的失敗（權重 0，不算）再記 API 用錯的失敗（權重 0.4）、故意給不存在的缺口（回錯誤訊息）。結果：存檔成功（`persisted` 1 份）、統計正確（正 1／負 4、2 組）、`train` 在資料不夠時跑完並標出「groups 2/8、positives 1/10、negatives 4/20」。
**修掉的問題**：第一版原始卡片（沒有安裝指令的）會繞過壓縮，一筆變成 29KB；改用明確的 `compact` 標記。

### 五、限制
1. 現在每一筆標註都要靠人（或 AI）呼叫 `catalog_feedback`；沒有「使用者看了計畫沒反對就算採用」這種隱含訊號，也沒有從 `catalog_run` 的執行結果自動關聯回專案——執行的是單元程式，跟「採用了哪個專案」之間沒有對應。
2. 計畫只留在記憶體，重開應用程式之後舊計畫的 `plan_id` 就對不回去（已存的標註不受影響）。
3. 訓練出來的模型要不要比手調好，等資料夠了才知道（第二十六節的結論：102 筆時沒有）；`use_learned` 預設關閉。
4. 標註反映的是這個使用者、這幾種需求的偏好，不是客觀對錯。

## 二十八、計畫分歧時才問使用者（2026-10-17）

### 一、為什麼不把「沒反對」當成採用
沉默不等於同意：使用者可能沒看、看不懂，弱模型的計畫又常有隱藏的假設。把沉默記成採用，會讓錯的計畫變成訓練的正樣本，排名越學越歪。每個計畫都出選擇題又太吵。所以：**沒有分歧就直接用推薦的；只有真的有分歧才問。**

### 二、分歧用程式規則判斷（`catalog/branch_core.js`）
不讓弱模型自己決定要不要問——弱模型最容易漏掉「這裡其實有兩種做法」。依序（重要的先問）：
1. **取捨**（70）：推薦的需要 API 金鑰或伺服器，而分數差在 0.25 內的備選不需要。不需要的排第一當建議。
2. **接近**（60＋備選數）：備選分數離推薦的不到 max(0.05, 推薦分數的 12%)，且過門檻（0.35）。
3. **找不到**（50）：這個需求沒有夠像的候選。建議選項是先略過，也可以直接打字給網址或做法。
4. **勉強合格**（40）：推薦的只比門檻高不到 0.12，而且沒有備選。
一次最多問 3 題（`max_questions` 可調到 6），其餘用推薦的，並在計畫裡註明。沒有分歧的缺口只算個數、不打擾。

### 三、使用者的回答
- 點選項：記成最可信的標註（`user_adopt`，權重 1.0）；勉強合格時選略過記成 `user_reject`。使用者沒選（按「照推薦的做」）不記，只在計畫裡標成預設。
- 不點、直接在輸入框打字：當成補充（`allowSupplement`，見 `_tryFeedPendingAsk`）。內容放進 `plan.user_notes`，裡面的網址放進 `plan.user_urls` 並加進參考資料，之後可以用 `catalog_card` 讀。
- 打字**不會**被當成同意：只有明確帶 `allowSupplement` 的選擇題（跟互動卡片）接受打字；執行程式、安裝、刪除這類表單不接受。

### 四、接線
`_unitCatalogDiscover` 算出計畫、記住之後呼叫 `_unitCatalogAskBranches`（`ask:false` 可關掉）。`catalog_discover` 工具和 `/unit-catalog discover` 都走這條。工具回傳多了 `decisions`、`user_notes`、`user_urls`，說明裡教模型照決定做、不要再問一次。

### 五、限制
1. 門檻（0.05／12%／0.25／0.12）是憑現有排名分數的分布訂的初值，等回饋資料累積後該用資料校正。
2. 只接在 `catalog_discover`；其他流程（例如多個 MCP 候選）還是各自的表單，沒有接上分歧規則。
3. 問題出現時如果使用者切到別的對話，會標成「等你確認」，等回來才顯示。

### 六、「不要再問，統一走建議」（2026-10-17）
使用者可以一次說「以後都照建議的」，之後計畫有分歧就不再跳題。
- **三種說法**：選擇題上的按鈕「之後都照建議的，不要再問」；打字說「不要再問了」「別問了」「統一走建議」「一律用推薦的」（只認 40 字以內的短句，長指令裡剛好出現這幾個字不算）；`/ask-mode recommended`。恢復用 `/ask-mode ask`，或說「可以再問我」「恢復詢問」（只有目前是不再問的狀態才認）。
- **設定**：`advancedSettings.branchAskMode`（`ask`／`recommended`），存在設定裡，重開還在。
- **行為**：模式是 recommended 時，`askBranchChoice` 不跳表單，直接回建議的選項；`_unitCatalogAskBranches` 把所有分歧（含超過題數上限的）都依建議套用。建議的是什麼：取捨題換成不需要金鑰的、勉強合格照用、找不到就略過。
- **不當成使用者的選擇**：這種自動套用記成 `auto`，不記採用／退回標註（使用者沒有真的表態，不能拿來訓練排名）。計畫裡每一項寫「依建議…」，並提醒怎麼恢復。
- **在等答案時說**：卡片或表單還開著時說「不要再問」，這題也用建議的。`ask_user_card` 工具會回傳 `use_defaults:true`，說明教模型自己用最合理的預設做、並在回覆裡簡短講用了什麼，之後同類分歧不要再問。
- **範圍**：只影響「計畫分歧」這類選擇。執行程式、安裝、刪除這類要使用者同意的表單，不受影響，永遠要問。
- **限制**：沒有設定頁的開關，只有按鈕、打字與 `/ask-mode`。

## 二十九、命名與定義：CoLU（2026-10-17）

### 一、名字
**CoLU**＝**Co**nnect **L**ibrary **U**nits（連接函式庫單元）。這份文件（單元目錄）從第一節到第二十八節描述的整套做法，統稱 CoLU。只是名字：程式裡的識別名稱（`FaCatalog*`、`unit-catalog` 等）不改。

### 二、定義
CoLU 是把 Python、TypeScript 等函式庫的**方法呼叫**抽成**單元**（名稱、參數型別、回傳型別、副作用、環境），再用**型別接線矩陣**算出「哪個單元的輸出接得上哪個單元的輸入」，最後用布林矩陣連乘找出「從起始型別走到目標型別」的合法接線的方法。
- 單元：第二節。接線矩陣與路徑搜尋：第十一節（`matrix_core.js`）。需求接到單元：第二十一、二十三節（`bind_core.js`）。可執行的呼叫程式：第二十節（IR 與直譯器）。不認得的函式庫：第十二、二十五節（抽取、探索迴圈）。
- **核心性質：整個過程 0 次模型呼叫。** 模型最多只在排序與填參數時介入；接線是否合法由型別合約決定，不由模型自述。所以線上模型再弱、再退化，接線這一層的結果不受影響。

### 三、跟 Handwired 的關係
Handwired（Cheng Lou，把 JavaScript 編譯成手寫權重的神經網路，條件判斷用兩個 ReLU 相減做成 0／1 開關）是這個想法的**起點**：程式邏輯可以變成矩陣。CoLU 取了「程式 → 矩陣」這個方向，但目的和做法都不同：

| | Handwired | CoLU |
|---|---|---|
| 矩陣表示什麼 | 程式的**執行**（權重、ReLU） | 單元之間的**型別接線**（布林鄰接矩陣） |
| 用來做什麼 | 讓程式變成可微分、能在 GPU 批次跑的網路 | 找出合法的呼叫組合、檢查型別、排出計畫 |
| 執行程式 | 在網路裡跑，輸出與原程式一致 | 由 IR 直譯器跑（精確，也是 0 次模型呼叫） |
| 可微分 | 是 | 否 |
CoLU 沒有複製 Handwired 的編譯器，也沒有用到 ReLU。要不要吸收它的「在網路裡精確執行」，等遇到大量批次執行規則的瓶頸再評估（目前沒有）。

### 四、CoLU 不做的事
開放式問答、寫作、推理——這些沒有函式庫可以組合出答案，仍然要靠模型。單元目錄沒收錄的函式庫，要先走探索迴圈（第二十五節）找出來、抽成單元。

### 五、之後怎麼用這個名字
- 對外說明、設定頁、`/help` 講到這套功能時用「CoLU」。
- 模型體檢（評估模型該靠哪一層輔助）若加「接線題」，題目名稱叫「CoLU 接線題」：同一個需求，比較「模型自己規劃」與「CoLU 給計畫、模型只填參數」的成功率。

## 三十、CoLU 的 ReLU 形式與「接線題」模型體檢（2026-10-17）

### 一、ReLU 形式（`catalog/relu_core.js`）
把 CoLU 的核心運算寫成「矩陣連乘＋ReLU」，概念上跟 Handwired 同一種語言：
- 三個零件（非負整數時精確）：`relu(x)=max(0,x)`；`sat(x)=x−relu(x−1)`＝min(1,x)，把「有幾條路」壓成「有／沒有」；`max2(a,b)=b+relu(a−b)`＝max(a,b)。
- **可達性**：`P_k = sat(P_{k-1}·A)`、累計 `= sat(累計 + P_k)`，等於位元版的 `reachWithin`。
- **真正的 ReLU 網路**（`reachNet`／`forward`）：一步 `R' = sat((I+Aᵀ)R)` ＝一層 `relu([M;M]·R + [0;−1])` 再接線性的 `[I −I]`，併進下一層後就是純粹的 relu 層疊，共 L+1 層。輸入起點向量，輸出「最多走 L 步到得了」的單元。
- **最佳接線分數**（`bestPipeline`）：分數都 ≤ 1，走迴圈不會更好，所以「最佳的走法」＝「最佳的不重複走法」，可以用動態規劃，其中的 max 全用 `max2`。等於 `findPipelines` 的第一名。
- **後端可替換**：所有矩陣連乘都經過 `matmul(X,Y,n)`；`use({matmul})` 換後端；`selfCheck(candidate)` 是一致性檢查——新的後端（Web Worker 平行版、WebGPU 版）要先通過才可以啟用（乘積逐位元相同、壓縮後的可達矩陣相同）。算錯的後端會被擋下來（有測試）。

**驗證**：隨機矩陣 27 組（含 31／32／33／65 這些位元邊界）可達性逐位元相同；ReLU 網路對每個起點輸出相同；隨機目錄 72 組起訖、真實目錄 56 組起訖（311 個單元）最佳分數都等於 `findPipelines` 第一名。數值是 Float32，計數在 2^24 以內精確，分數誤差遠小於 0.001（比對容許 0.0006，因為 `findPipelines` 把分數四捨五入到小數點後三位）。

**速度（真實目錄 311 個單元、495 條接線，Electron 內實測）**：可達性（L=3）位元版 0.18 ms、ReLU 密集版 7.9 ms（慢約 40 倍）；最佳分數 DFS 4.0 ms、ReLU 動態規劃 4.2 ms（差不多）。合成稀疏矩陣：n=1000 時位元版 8 ms、ReLU 密集版 206 ms。ReLU 形式不是為了快——位元壓縮是 n³/32 加跳過 0，密集是 n³。價值在於概念一致、可以替換後端、之後能接進計算圖。預設仍用位元版。

### 二、CoLU 接線題（`catalog/colu_bench_core.js`、模型列上的「CoLU」按鈕、`/colu-bench`）
評估模型串接多個工具的能力，建議要用哪種輔助方式。題目從單元目錄的接線矩陣出：
- 出題：走一條只經過高分接線（≥0.9）的 2～3 步路，起訖只用具體的型別（`file_id`、`audio_file` 這種，不用 `text`／`json`），清單裡加 5 個干擾函式；出完先用評分器驗證出題那條自己是對的、清單沒有同名函式。
- **A. 自己排**：要模型排出呼叫順序，評分用型別接線判定（第一個吃得下起始型別、每相鄰兩步接得上、最後一個產出目標型別、不重複、都在清單裡）。不要求跟出題那條一樣，只要合法都算對。
- **B. CoLU 先給計畫**：程式算好 3 條合法接線，需求用白話說（優先用函式的說明），要模型選對那一條。
- **C. CoLU 直接排**：不呼叫模型，只統計「CoLU 第一名剛好是出題那條」的比例當參考。
- 另外量輸出格式正確率、退化（空白、只有思考、同一行或同一段重複）、中位耗時，並算「隨機亂排碰巧合法的機率」當對照。
- **建議**：自己排 ≥ 0.8 且不常退化 → `self`；否則給計畫選 ≥ 0.8 → `guided`；都不穩 → `auto`（串接交給 CoLU 直接排）；能用的回應太少 → `unknown`。每題至少各 3 次回應才下判斷；題數少會註明只是粗略估計。
- 開始前會先問使用者（顯示呼叫次數），失敗的例子會附上實際看到的原因（HTTP 狀態、finish_reason、退化種類）。
- **連到實際使用**：結果存在模型列的 `coluProfile`。之後用這個模型開新對話時，`guided`／`auto` 會在系統提示加一句，叫它串接工具前先用 `catalog_query`（`path`／`plan`）取得算好的接線。

### 三、限制
1. 「合法」只代表型別接得上，不代表語意正確。`file_id` 是樞紐型別，很多 App 工具互相接得上，亂猜也有一定機率碰巧合法，所以報告會附亂猜基準。語意由 B 題（需求描述選接線）補一部分。
2. 目前只測「接線」。沒有測 UML 拆解、寫程式、解題本身的能力。
3. 提示只在新對話建立時加進系統提示；對話進行中重測不會改既有對話。
4. 結果會過期（模型端會默默更新），報告有測試時間。
5. 真實模型還沒跑過：測試用的是假模型（完美、只會選、什麼都不會、只有思考、全部失敗）。

## 三十一、CoLU 的完整流程（弱模型寫程式與自我演化）與探索時的反思（2026-10-17）

### 一、目標
弱模型不靠長篇大論的注意力，而是走固定的路：**計畫 → 用 UML 切成極小的單元 → CoLU 接線 → 找現有實作 → 沒有的才新寫 → 寫好抽成單元回填目錄**。每一步都是小而封閉的問題，用程式檢查，模型只做選擇和填空；回填讓目錄越用越完整（自我演化）。統一叫 CoLU。

### 二、流程與現況（誠實對照）
| 步驟 | 做法 | 現況 |
|---|---|---|
| 1. 拆解 | `uml_guide`（互動卡片，不需模型）、`uml_design`（離線小模型，一次只回一個封閉小問題，每個回覆都驗證，只重做有問題的那一區） | 已有 |
| 2. 接線 | `catalog_bind`：UML 使用案例 → 單元，型別合約打分，矩陣補橋接單元；0 次模型呼叫（第十一、二十一、二十三節）；ReLU 形式見第三十節 | 已有 |
| 3. 找現有實作 | `catalog_discover`：缺口 → 搜尋（Wiki、StackOverflow、GitHub、SourceForge、CodeProject、DeepWiki）→ 讀 README → 能力卡片 → 排名（第二十五、二十六節） | 已有 |
| 4. README → 結構 | `card_core`：依標題切成章節樹（地圖），章節按角色加權（簡介、安裝、用法、API…），長章節再切片，多片段投票出卡片；GitHub 這類搜尋「每個字都要出現」所以每組關鍵字只放 2～3 個字 | **部分**：有章節樹加角色，但還不是完整的「語意樹」（API → 函式 → 參數 → 範例互相連起來） |
| 5. 型態呼叫與接線 | 卡片裡的函式簽名 → 單元；`catalog_onboard` 抽取（JS／Python）、型別存根、探測執行 | 已有 |
| 6. **反思** | 找不到時先問：打錯字？還是新的？（本節） | **本次新增** |
| 7. 沒有現成的：新寫 | 用 UML 拆到極小單元，現有部分接線，缺的才新寫 | 有拆解與接線；「新寫的程式自動抽成單元回填」還沒串成一條自動的路 |
| 8. 驗證與執行 | IR 直譯器、`tryRun` 自我修正、失敗歸類成下一步（第二十節、二十五節） | 已有 |
| 9. 評估弱模型 | 模型列上的「CoLU」按鈕與 `/colu-bench`：測自己排接線 vs. 給計畫選 | 已有（只測接線；**還沒測 UML 拆解與寫程式**） |

### 三、反思（`catalog/reflect_core.js`）
找不到（或只勉強過門檻）的缺口，不直接說「沒有」，先想兩件事，全由程式判斷：
1. **也許打錯字**——從他的概念去找：
   - 英文：詞庫（探索用的詞庫＋單元目錄裡單元的名稱與說明）裡找編輯距離 1（長字 2）以內的字，插入、刪除、替換、相鄰對調都算；認得的字（含複數）不動。
   - 中文：詞庫的詞條沒出現，但有一段等長、只差一個字的。兩個字的詞只有「常見同音近形字」才算（像／相、截／擷…），不然「相簿」會被當成「相機」；三個字以上差一個字就算。已經認得的詞裡面不亂找。
   - 有嫌疑就**問使用者**：改成猜的那個（建議）、不是打錯、或直接打自己的說法（當成新的需求句去找）。統一走建議時不問，直接用猜的。
   - 改正後再探索一次；還是沒有 → 只用認得的概念再找一次；再沒有才往下。
2. **也許是新的**：詞庫不認得、不像打錯字、搜尋也沒有（或最像的不到 35 分）。標成 `plan.novel`，不是「失敗」。分歧問題裡多一個選項：「當成新的需求，用 UML 拆解來做」（建議），旁邊是略過。計畫文字會附 `NOVEL_NEXT`：用 UML 拆成極小單元、現有的用 `catalog_bind` 接線、沒有的才新寫、寫好用 `catalog_onboard` 回填。

上限：一份計畫最多反思 3 個缺口，每個最多多搜兩次（避免無止境）。`catalog_discover` 的 `reflect:false` 可以關掉。

### 四、限制
1. 詞庫是這個專案的詞庫（109 個中文詞條、約 1400 個英文字），沒涵蓋的領域，「不認得」常常只是詞庫小，不一定是新的。所以「可能是新的」只是提示，最後仍問使用者。
2. 中文錯字只認詞庫詞條的近似；沒有拼音比對（同音但字形差很多的）。
3. 英文只處理拼錯，不處理縮寫與簡稱（例如 ffmpeg 寫成 ff）。
4. 概念再找會把不認得的字拿掉，句子可能變得很空（例如「做 風格轉換」）。
5. 還沒用真實使用者的對話校正過門檻。

## 三十二、UML 拆解題（2026-10-17）

### 一、為什麼測這個
弱模型走 CoLU 路線（計畫 → UML 拆成極小單元 → 接線）最依賴的不是接線，是**自己把需求拆成極小的 UML 單元**的能力。接線題（第三十節）測的是接線；這一題測拆解。

### 二、怎麼測（`uml/uml_bench_core.js`）
- 用**真正的拆解流程** `scenarioToModel`，強制走模型（`program:false`，不讓程式讀情境代勞）：參與者與使用案例 → 類別 → 每個類別的成員 → 每個類別的關係 → 每個使用案例的呼叫順序。每一步是一個封閉的小問題，回覆由程式驗證，不合格就把「它自己的回覆＋精確的錯誤」退回重來（最多兩次）。
- 固定 5 個情境（網路商店、圖書館、會員系統、課程預約、診所掛號），預設跑前 3 個。每個情境「該有的東西」由人事先寫好：參與者、類別、使用案例的關鍵字（同義詞與中文都算，例如商品 ＝ Product／Item／Goods）。
- 評分全由程式判定：完成率、驗證通過率、**各階段第一次就合格**的比例、**含退回重來之後**合格的比例、該有的參與者／類別／使用案例找到幾成、使用案例的呼叫順序有沒有兩步以上、退化（空白、重複）。
- **建議**：
  - `self`：完成 ≥ 0.8、各階段第一次就合格 ≥ 0.75、該有的東西找到 ≥ 60% → 可以自己拆（仍然用一次一小題）。
  - `stepwise`：退回重來之後合格 ≥ 0.8 → 要用一次一小題＋退回重來的流程，不要整份一次生成。
  - `program_first`：連退回重來之後也撐不住 → UML 由程式先讀情境、用片段當種子，模型只補程式讀不出的部分。
  - `unknown`：能用的回應不到 5 次（例如呼叫都失敗），不亂給建議，並附上失敗原因。
- 報告會講出「最容易出錯的階段」和「常見被退回的原因」（實際看到的），不只給一個結論。

### 三、跟接線題一起
模型列的「CoLU」按鈕開始前先問：「接線題＋UML 拆解題」（多約 42 次呼叫）、「只做接線題」、取消。結果都存在模型列的 `coluProfile`（UML 的在 `coluProfile.uml`）；只做接線題不會洗掉上次的 UML 結果。列上顯示「接線：… ｜UML：…」。

### 四、連到實際使用
之後用這個模型開新對話時，系統提示依兩項建議各加一句：接線不穩 → 串接前先用 `catalog_query`；UML 不穩（`program_first`）→ 設計系統前先用 `uml_guide` 讓程式讀情境、逐步確認；（`stepwise`）→ 用 `uml_design` 或 `uml_guide` 一次處理一小塊。

### 五、限制
1. ~~`uml_design` 只能跑在離線文字模型上~~ 已解決，見下一節。
2. 情境只有 5 個，預設 3 個，只是粗略估計；關鍵字是人寫的，模型用我們沒列的同義詞就會被判成沒找到。
3. 驗證（`validate`）對成員與關係階段很寬鬆（空答案也合格），所以「第一次合格」在這兩個階段偏高。
4. 用 `prefill`（替模型寫好回覆開頭）是離線模型的做法；線上模型這裡沒有用，測的是它不靠這個輔助的表現。
5. 測試用的是假模型（完美、亂答、靠退回重來、連線失敗、空白）。真實模型還沒跑過。

### 六、`uml_design` 可以用線上模型的列（2026-10-17）
`uml_design`（以及設計檢視器的「重做這一區」「補成員」）原本只能跑在離線小模型上。現在由 `_umlModel` 選模型，介面一樣（`ensure`／`gen`），線上的用同一個模型列去呼叫：
- `model: 'offline'`：只用離線。`model: 'online'`：只用線上——而且只會用**在模型列按過「CoLU」、UML 拆解題結果是 `self` 或 `stepwise`** 的模型列；沒有就說明原因與怎麼補（不會偷偷用一個沒驗證過的線上模型）。
- 不指定（自動）：線上模型證明自己拆得好（`self`）就用它；否則離線可用就離線；離線不能用、而線上有 `stepwise` 的才用線上；兩者都沒有就說明。
- `program_first` 的模型永遠不會被選去拆 UML（它連退回重來都撐不住）；這種模型要走 `uml_guide`（程式讀情境、卡片逐步確認，不需要模型）。
- 回傳的 `model_used` 說明這次用了哪個，進度卡片標題也會寫。每次呼叫最多等 60 秒；使用者停止會中斷。
- 限制：線上模型沒有用離線模型的 `prefill`（先替模型寫好回覆開頭）；跑起來比離線快，但會用掉額度。

## 三十三、大問題：直接做，做不完就用 UML design 補救（2026-10-17）

### 一、體檢真正要回答的問題
前兩節（接線題、UML 小題）量的是零件能力。真正的問題是：**對大問題，這個模型自己一次做得完嗎？做不完的話，它能用 UML design 補救嗎？** 所以 UML 那一半改成兩條路、同一個大問題、同一套標準：
- **大問題**：把三個領域併成一個綜合情境（`BIG`，3 個：約 10 個使用案例、6 個以上參與者、6～8 個類別）。
- **路線 A 直接做**：一次要模型寫出整份 UML 文字（程式能解析的一行一件事格式）；不合格就把精確的錯誤退回，最多兩次。
- **路線 B 走 UML design**：先由程式把大問題切成小塊，每塊各自一次一小題拆完，再合併（`scenarioToModelBig`）。
- **同一套成功標準**：完成、驗證通過、該有的參與者／類別／使用案例**各自**都找到七成以上（取最低的；平均會把缺掉的一大塊蓋掉）、使用案例的呼叫順序有兩步以上的至少一半。
- **結論**：A 達標 ≥ 0.8 → `direct`（大問題可以直接做）；A 不行但 B ≥ 0.67 → `uml`（用 UML design 補救）；兩條都不行 → `program_first`（UML 由程式先讀情境，`uml_guide`）；能用的回應太少 → `unknown`。

### 二、UML design 要能補救大問題：先切塊
原本的一次一小題流程，每階段都有上限（參與者 1～4、使用案例 1～6、類別 2～10），那是為超小模型設計的，大問題一次丟進去第一階段就被擋掉。補上（`uml_core.js`）：
- `splitScenario`：依句子切（標題每塊都帶著，每塊最多 2 句、一句裡項目太多的獨立一塊）。
- 每塊各自走 `scenarioToModel`；`mergeModels` 合併：參與者聯集、同名類別合併成員、關係聯集（指向不存在類別的拿掉）、使用案例同名加編號、呼叫步驟接回前一步，最後 `ensureOps`。
- `scenarioToModelBig`：小情境直接走一次（`chunks=1`），大的才切；某一塊拆不出來只警告那一塊，其餘照合併；全部都拆不出來才失敗。`designProject`（`uml_design`）改用它。

### 三、UML design 是線上模型的補救能力
- **預設開放**：`uml_design` 預設用目前的線上模型拆（`_umlModel`），不必先跑過體檢；離線小模型要下載、在 CPU 上慢。只有體檢結果是 `program_first`（連一次一小題的流程都沒跑通）的模型不用，那種改走離線模型或 `uml_guide`。`model:'offline'|'online'` 可以指定。
- **離線超小模型能做，線上模型不該比它差**：所以線上模型在這個流程上失敗，優先懷疑流程與端點（輸出預算、格式、服務暫時過載），不是「模型太弱」。實例：推理模型被我設的 1024 輸出上限卡住（思考用完、內容空白，`finish_reason=length`），改成 4096 就答得很好。
- **提示**：所有模型的系統提示都有「大問題做不下去時用 uml_design 補救」；體檢結果是 `uml` 的改成「大問題不要自己一次做完，先用 uml_design 拆」；`program_first` 指向 `uml_guide`。

### 四、限制
1. 大問題只有 3 個，每個都是現有領域的組合，關鍵字是人寫的；用我們沒列的同義詞會被判成沒找到。
2. 路線 B 的切塊靠句子，句子裡跨領域的需求（一句話牽涉兩個領域）會被當成同一塊。
3. 成本：每個大問題路線 B 約 35 次呼叫、路線 A 最多 2 次，三個大問題約 110 次。
4. 整個測試都是用真實端點的結果，端點過載（503）、逾時會讓結果變成「資料不足」，不會被當成模型的能力問題。

## 三十四、內建預設模型的測試結果（2026-10-17）
用真實端點測的（`FA_PRESET_MODEL_STATE`，新安裝的預設模型列直接帶著；既有的同名模型列沒有自己的結果時沿用，使用者自己重測會蓋掉；狀態裡沒有任何金鑰）。接線題每種 6 題、大問題 3 個。

| 模型 | 工具呼叫 | 視覺 | 接線題 | 大問題 |
|---|---|---|---|---|
| `nemotron-3.5-super-vl-120b-a12b` | 支援 | 支援 | 自己排 6/6、給計畫選 6/6 → 自己排就好 | 直接做 0/3、走 UML design 2/3 → **用 UML design 補救** |
| `gpt-oss-20b` | 支援 | 不支援 | 6/6、6/6 → 自己排就好 | 直接做 0/3、走 UML design 3/3 → **用 UML design 補救** |
| `nemotron-3-nano-omni-30b-a3b-reasoning` | **不支援**（預設表原本寫支援，已改成實測值） | 支援 | 6/6、5/5 → 自己排就好 | **沒測到**（重測時服務端 503），沿用「大問題做不下去時用 uml_design 補救」的通用提示 |

**沒測到、不寫進內建狀態**：
- `nemotron-3.5-lightning-30b-a3b`：測試當下連最簡單的呼叫都逾時（超過 120 秒沒回應）。
- `nemotron-3-ultra-550b-a55b`：測試當下持續回 503「服務暫時過載」，重試也一樣。
- `openrouter/free`：OpenRouter 會把請求配給任意模型，測出來的結果不屬於任何固定的模型，所以不測。
連不上不會被寫成「不支援」。這三個模型在服務恢復後，在模型列按「CoLU」即可補測。

**觀察**：兩個測到的模型，大問題「直接做」都 0/3，最常見的是呼叫順序不足（找到的使用案例沒有寫兩步以上）或格式不合；走 UML design（先切塊）則 2/3 與 3/3——印證了「大問題要拆」。super-vl 有 1 個大問題沒達標（該有的東西最少的一項只找到 63%）。

## 三十五、「沒有這個工具」要先反思；動作明確的需求程式直接做（2026-10-17）

### 一、事件
使用者說「用英文語音說 Goodnight sleepy head」。模型（`nemotron-3-ultra`）回「我沒有語音合成工具」，建議自己用別的服務；使用者糾正「你有 TTS，它不是 skill」後，重來的結果還是不對，最後使用者自己用 `/media-text-to-speech` 才成功。原因：`text_to_speech` 在「影音處理」領域，最上層工具清單沒有列出；模型說沒有之前**完全沒有反思**「別的領域會不會有」。

### 二、三層修正（都是程式，不靠模型自覺）
1. **動作明確的需求，程式直接做**（`tools/tts_intent.js`）：「用英文語音說 xxx」「請用語音念：xxx」「把「xxx」念出來」「朗讀 xxx」「tts: xxx」「read aloud: xxx」，程式認得就直接走 `/media-text-to-speech` 同一條路，畫面上放使用者原本那句話，念的字**一個字都不改**，不經過模型。提問（怎麼用語音合成？你有語音功能嗎）、單純的「說明一下…」「念書」「讀一下檔案」、只剩功能名稱、有附件、離線模式，都不當成命令，交給模型。
2. **較鬆散的說法，最上層直接拿到工具**：`FA_TASK_TOOL_HINTS` 補 `text_to_speech`（偵測到語音／朗讀／念出來／TTS；排除語音辨識、逐字稿、怎麼用／設定）。最上層會看到這個工具，並附一段做法提醒：text 原樣、voice 留空、它是工具不是 skill。
3. **模型說「我沒有某某工具」，程式替它反思**（`tools/cap_reflect.js`）：偵測回覆開頭的宣稱（中英文），取出它在找的概念詞（「沒有〔語音合成〕的工具」中間那段）；程式搜尋**所有領域的所有工具**（名稱與說明的 CJK 雙字詞＋英文字，依稀有度加權，名稱命中 2.5 倍，領域標籤只算 0.4 倍，最低 5 分且不低於最高分的一半），找到就以系統訊息退回：列出工具、所在領域、怎麼用（最上層有就直接呼叫，沒有就 `delegate_to_subagent` 指定領域），並要求原樣用使用者的字；都不符合才可以說沒有，並說明查過哪些。每一輪最多 2 次；這一輪已經委派過、查過工具細節就不再提醒。這是「探索時的反思」（第三十一節）用在工具發現上。

### 三、驗證
真實工具清單（215 個工具、領域工具清單有些是函式）上：
- 語音命令：「用英文語音說Goodnight sleepy head」→ 合成的文字就是 `Goodnight sleepy head`，模型呼叫 0 次；「把「晚安，好夢」念出來」→ `晚安，好夢`；「怎麼用語音合成？」→ 交給模型。
- 反思：模型說沒有語音工具 → 找到 `text_to_speech`（領域 `media_av`）；說沒有 PDF 工具 → `images_to_pdf`；說沒有影片轉 gif → `convert_to_animated_gif`；真的沒有對應工具的需求（寄信、股價、量子、翻譯）→ 不打擾。
- 抓到並修掉的錯：某些領域的 `toolNames` 是函式（動態），直接當陣列走訪會丟錯被吞掉，反思永遠回空。

### 四、限制
1. 搜尋是字面比對。像「畫一隻貓」只靠「繪圖」命中、而工具說明裡寫的是「畫 SVG」，分數不到門檻，不會提醒。門檻優先求不打擾（寧可漏掉）。
2. 宣稱偵測看回覆開頭 320 字；模型先做了一堆事、很後面才說沒有，不會觸發。
3. 語音命令的辨識是句型比對，沒涵蓋的說法會落到第 2、3 層（鬆散提示、反思）。

### 五、別名只在反思階段用，不佔 context（2026-10-17）
- **放哪**：別名是程式端的查詢表，只有 `cap_reflect.search` 搜尋時讀；**不放進系統提示、不放進工具說明、不傳給模型**。實測系統提示長度不受影響。
- **什麼時候才花 context**：只有模型說「我沒有某某工具」、而且搜尋命中時，才會多一則約 450 字的退回提醒（列出 1～3 個工具）。沒觸發就是 0。
- **兩個來源**：
  1. **內建口語別名（種子）**：`SEED_ALIASES`，25 個常用工具，寫的是使用者平常怎麼說這件事（念出來、畫畫、做簡報、PDF 接起來…），不是工具說明裡寫的字。別名命中的分數是一般說明的 1.6 倍，工具名稱命中 2.5 倍，領域標籤 0.4 倍。
  2. **學來的別名**：反思退回提醒之後，模型的下一個最終回覆不再說「沒有工具」＝反思成功，就把使用者那句話記成找到的第一名工具的別名（每個工具最多 3 句、最多 400 個工具，存在 fileCache 的 `tool-aliases.json`）。提醒了兩次它還是說沒有，就不學。`/tool-aliases` 看、`/tool-aliases clear` 清。
- **限制**：
  1. 「反思成功」是用「不再說沒有」判斷，不能保證它真的用了那個工具（它也可能改口說別的）；所以只學第一名一個工具、每個工具最多 3 句，且可以清掉。
  2. 種子表要人工維護；其他工具靠學。
  3. 學來的是整句話，換個說法就搜不到（雙字詞比對）。

## 三十六、中英互譯：`translate_text`（2026-10-17）

### 一、為什麼不是嵌入與重排
嵌入模型（`multilingual-e5-small`）只能把句子變成向量、量「兩句話意思像不像」，**不能產生句子**。它做得到的是詞彙層級的查字典（術語表比對），翻整句話不行。所以產生譯文的是另外兩條引擎，嵌入與詞彙表只負責「術語一致」。

### 二、引擎與流程（`tools/translate_core.js` ＋主程式 `translateText`）
1. **判斷方向**：沒指定就依原文（中文翻英文、英文翻中文，中英夾雜依比例）；原文已經是目標語言就不翻並說明。
2. **引擎**（`engine`）：`auto`（預設）＝線上語言模型 → 譯文沒通過程式檢查就把問題退回重來一次 → 還是不行換離線翻譯模型；離線模式只用離線；也可以指定 `online`／`offline`。呼叫失敗（429 等）也換離線。
3. **離線翻譯模型**：瀏覽器端的專用翻譯模型 OPUS-MT（Helsinki-NLP），中→英與英→中各一個，量化版約 118MB。第一次用前會先問使用者；同意後記住。
4. **程式檢查譯文**：硬問題（退回或換引擎）＝空的、跟原文一樣（沒翻）、語言不對、一直重複、網址或信箱被改掉、佔位符被模型吃掉；軟警告（只回報）＝數字對不上、術語表的詞沒照用、長度差太多。
5. 長文自動切句（保留換行、段落、原本的空白），翻完照原樣接回去；翻成英文時句子之間補空格。

### 三、離線翻譯模型怎麼取得：釘版、切片、放在 `vendor-models` 分支
- 模型檔放在專案的 `vendor-models` 分支（單一提交，慣例同 `db-snapshot`）：`vendor/opus-mt-zh-en`、`vendor/opus-mt-en-zh`。來源是 Hugging Face 的 `Xenova/opus-mt-zh-en@39d480d5…`、`Xenova/opus-mt-en-zh@046f55ae…`（Helsinki-NLP OPUS-MT 的 ONNX 轉檔，量化 q8）。授權：zh-en 為 CC-BY-4.0、en-zh 為 Apache-2.0，`README.md` 與 `manifest.json` 有標示來源與授權。
- 大檔案（量化後的 encoder 50MB、decoder 57MB）切成 40MB 一片；`manifest.json` 記錄每個檔案與每一片的大小與 sha256。
- 程式用**完整的提交 SHA** 取檔（`FA_VENDOR_MODELS.sha`），內容不可變；每片下載後核對 sha256，接起來再核對整個檔案，不符就丟錯、不載入。核對過的檔案放進 Cache Storage（`fa-vendor-models`），下次不用再下載。
- 載入：用 transformers.js（與嵌入模型同一個釘版 3.7.5）的 `customCache`，只在建立翻譯管線的那一段時間改成「從已核對的檔案取」，建好就還原設定（`useCustomCache`、`useBrowserCache`、`allowLocalModels`），嵌入模型等別的載入不受影響。實測還原正確。
- 更新模型的方法：重新下載、切片、重建分支（強制推送單一提交），把新的提交 SHA 寫進 `FA_VENDOR_MODELS`。

### 四、專用翻譯模型的已知習性與處理
| 現象 | 處理 |
|---|---|
| 信箱、網址、程式名稱被亂翻（`TypeScript`→`radScipt`、`React`→「反應」） | **翻之前換成佔位符 `<1>`、`<2>`…，翻完換回去**。實測 `<1>` 在兩個方向都能穿過模型（`[1]`、`{1}`、`@@1@@`、`§1` 會被弄壞，`X1` 次之）。中翻英：中文句子裡的拉丁字母詞一律保護；英翻中：保護網址、信箱、`程式碼`、駝峰與三個字母以上的全大寫詞、含數字的詞、常見技術名稱。`PM`、`Taipei` 這類不保護（要被翻） |
| 模型把 `<2>` 改寫成 `" 2 "`、`「2」`、`[2]`、全形 | 還原時也認得（只認清單裡有的號碼，每個號碼換一次） |
| 佔位符被模型吃掉 | 回報哪些遺失，當成不合格（不交付少了名稱的譯文） |
| 很短的輸入（一個字）一直重複同一個詞 | 把連續重複 3 次以上的片段收成一次；整段長串重複仍由檢查擋下 |
| 英翻中輸出簡體、半形標點、用空格當逗號 | 簡轉台灣繁體（opencc-js，`twp` 含慣用詞）、半形標點轉全形、中文字之間的空格當逗號、句尾依原文補 。？！、標點前不留空格 |
| 中翻英的輸入是繁體 | 先轉簡體再翻（模型訓練資料以簡體為主） |
| 術語 | 使用者詞彙表（`umlGlossary`）的術語走佔位符：保證照用 |

### 五、入口
- 工具 `translate_text`（領域 `translate`，所以反思搜尋找得到、可以委派）；斜線指令 `/translate [en|zh] <文字>`。
- 自然語言命令**程式直接做**（不經過模型）：「把這句翻成英文：…」「翻成中文 …」「中翻英：…」「translate to Chinese: …」「翻譯：…」；提問（翻譯怎麼用？）、功能名稱、太長，都不當命令。
- 較鬆散的說法（「請把這份報告翻成英文」）：最上層直接拿到 `translate_text`（`FA_TASK_TOOL_HINTS`）；別名種子也有翻譯的說法。

### 六、實測（桌面版，真實模型）
第一次含下載：中→英 27 秒、英→中 21 秒（網路好的情況）；之後一句不到 1 秒；一小段多句長文約 2.4～3 秒。11 個測試句（單字、問句、多句、換行、信箱、程式名稱、數字）都通過。例：「請在三月十二日下午五點前把報告寄到 abc@example.com。」→ "The report should be sent to abc@example.com by 5 p.m. on 12 March."；「我用 React 和 TypeScript 做了一個網站。」→ "I made a website with React and TypeScript."；"Our team built a website with React and TypeScript." →「我們的團隊建立了一個網站，網站有 React 和 TypeScript。」

### 七、限制
1. **品質是專用小模型的水準**：能通順、保留名稱，但會漏掉細節（第一個例句把「今天」翻丟了）、直譯、偶爾怪（"I'm gonna bring an umbrella"）。重要的文件請用線上語言模型。
2. 只做中英。其他語言（日韓等）沒做；「翻成日文」會明確說只支援中英。
3. 英翻中時，原文裡一般的英文單字（不在保護清單的）會被翻成中文，專有名詞若不在清單（人名、產品名）可能被亂翻；可以放進詞彙表。
4. 一次最多切成每片 260 字翻；很長的文章會慢（每句約 0.3～1 秒）。
5. 第一次用要下載（約 118MB／方向）；網頁版同樣要下載，且需要能連到 GitHub raw 與 jsdelivr。

## 三十七、UML 編修（`uml_edit`，2026-10-17）

反思或決策的結論要能變成「補哪裡、刪哪裡」。`catalog/../uml/uml_edit_core.js`：13 種編修指令（加減參與者、類別、成員、關係、使用案例、呼叫步驟，類別改名），每個編修套用後都 normalize＋validate，讓設計出新錯誤的會被退回並說明；刪類別或成員時關係與呼叫步驟由程式一併收拾。`candidates` 從問題（孤兒類別、空類別、太短的呼叫順序、缺能力、多餘步驟）算出候選編修，小模型只挑字母（A／B／C，也接受加引號的數字），挑不出來用程式的預設。`uml_edit` 套用後重建專案並同步檢視器。

## 三十八、達成路線（`plan_route`、`/route`，2026-10-17）

找不到工具時不猜、不放棄。`catalog/route_core.js`：程式把缺口分成 external_action（寄信、發文、付款…）、model（翻譯、語音、辨識…，走 Hugging Face／離線模型）、program（寫程式；桌面 Python／JavaScript／bash，網頁版 Python（Pyodide）／JavaScript／bash（busybox 模擬））、design（先用 UML design 拆）。外部動作給三條路：使用者提供 API、瀏覽器控制、範本讓使用者自己送。閘門：手動模式（預設）先送計畫問使用者；自動模式直接做；**有副作用的步驟（送出、付款、刪除、發佈）兩種模式一律先問**。缺的能力可轉成 UML 的「缺能力」問題接 `uml_edit`。`/route auto|manual` 切換。

## 三十九、瀏覽器控制的穩定生成（`browser_task`，2026-10-17）

離線小模型邊想邊下指令會不穩定，所以：**先計畫每個動作 → CoLU 檢查 → 才執行**。`browser/bcplan_core.js`：
- 動作表對應真正存在的瀏覽器控制指令，每個動作有參數型別、需要什麼狀態（tab／elements／text）、會讓什麼失效。`check` 照順序模擬狀態：沒開分頁不能點、沒觀察過元素不能按座標、換頁或點擊或捲動後元素失效、不接受 javascript:／file: 網址、不替使用者輸入密碼或卡號；有副作用的點擊與送出會被標出來。
- `planBatch`：決策表把選單縮到 2～4 個最合理的選項（小模型一次選 11 個選不出來），模型只挑字母；點擊／輸入只能從剛觀察到的元素挑，輸入的文字必須出自使用者的話；點擊不選輸入框、點過的座標不再點；模型選不出來就用程式建議的第一個（選項本來就都是合法動作）。做到一次觀察（read／look）就停，看到結果再計畫下一批；每批是一個 UML 使用案例（`toModel`／`fromModel`），可以用 `uml_edit` 補或刪步驟。
- 執行：先 `waitConnected`（探測 ping 不開瀏覽器，輪詢到連上為止、有逾時；連不上提示**常見原因是瀏覽器停在「誰在使用 Chrome？」設定檔選擇器——擴充功能那時還沒載入，要使用者自己選，不替使用者選帳號**）；逐步執行並驗證；暫時性逾時重試一次；失敗就重新觀察再計畫（有次數上限）。手動模式先給使用者看計畫；有副作用的步驟一律先問。
- 探測用的 ping 帶 `probe:true`，不會自動開 Chrome（否則每次查能力都彈出設定檔選擇器）。
