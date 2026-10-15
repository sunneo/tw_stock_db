# 單元目錄（Unit Catalog）：第 1 步——呼叫原型抽取器

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
