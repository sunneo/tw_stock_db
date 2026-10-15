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
