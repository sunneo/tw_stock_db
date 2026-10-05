# 知識擴充的一致性與移植（離線訓練器 → redmine 的 AI 聊天）

> 狀態：2026-10-06。這份文件回答：**另一個專案（例如 redmine 的 AI 聊天）要怎麼拿到離線訓練器這一輪的格式擴充（知識類型、版本與遷移、資料包帶知識、標註、骨架動畫），而且兩邊長期保持一致**。
> 先講限制：這個版本庫裡**沒有 redmine 專案的程式碼**，我沒有在 redmine 上跑過任何一步。下面的「host 要實作的介面」是依照這邊的接口寫的契約，redmine 的實際架構（前端是瀏覽器、後端存檔？還是伺服器端執行？）要你確認後才知道哪幾格要調整，見第 7 節。
> 相關：`DESIGN.knowledge-types.md`（類型註冊表、版本與遷移、各階段實作紀錄）、`DESIGN.porting-guide.md`（整體移植）、`DESIGN.offline-trainer.md`。

## 1. 結論（先看這裡）

**做法：兩邊共用同一批檔案，不要各自維護一份。** 這輪新增的東西已經盡量拆成「純函式的共用核心」＋「host 才要寫的薄薄一層」，搬過去只需要重寫後者。

| 層 | 內容 | 在哪 | 搬過去要做什麼 |
|---|---|---|---|
| L0 引擎（純函式） | 類型註冊、schema 驗證、遞迴展開（繼承、覆寫、循環偵測）、全庫驗證、**知識包（匯出／檢查／合併）**、**格式版本與遷移（偵測、預演、非破壞性檢查）** | `renderer/src/refs/ref_engine.js` | 原樣使用，不改 |
| L0 資料 | 內建類型與種子條目（顏色族群、人臉與五官、骨架與動作、詞庫…） | `renderer/src/refs/types_*.json`、`typed_*.json`、`generic_*.json`、`*.dsl`；`scripts/refs-dsl.js` 轉成資料 | 原樣使用；用同一支建置腳本產生 |
| L1 儲存（host） | 讀寫使用者資料、備份、還原、版本閘門（問使用者）、`ref_define` 的寫入流程 | `floating-assistant.js` 的 `_ref*` 方法（約 400 行） | **重寫成 redmine 的儲存**（第 3 節） |
| L2 工具（host） | AI 可呼叫的 `ref_lookup`、`ref_define`、`ref_types`、`ref_resolve`、`ref_validate` | 同上，`registerOptional('ref_…')` | 依 redmine 的工具登記方式註冊，參數 schema 照抄 |
| L3 資料包（host） | 離線訓練器資料包匯出／匯入時的知識區塊 | `_otBundleExport/_otBundleInspect/_otBundleImport` | 呼叫 L0 的 `exportPack/inspectPack/mergePack`；其餘（領域、規則、狀態機）是離線訓練器本身的移植 |
| L4 消費端（可選） | 標註核心、蒙皮核心、圖片分解的部位偵測（Python） | `renderer/src/annotator/annot_core.js`、`renderer/src/skin/skin_core.js`、`skills/image-decompose-redraw/` | 純函式原樣使用；視窗與檢視器（要瀏覽器）自己重寫或搬 |

「一致」靠三件事：**同一批檔案、固定版本（釘 commit SHA）、同一組測試**（第 6 節）。

## 2. 資料格式與版本（兩邊一定要一樣的合約）

| 資料 | 格式名稱／版本 | 規則 |
|---|---|---|
| 使用者知識資料 | `fa-ref-user-defs`，目前 v1；沒有 `_format` 欄位的一律叫 **v0** | 舊資料照舊運作（用不到新功能）；**只有用到新版功能才問使用者要不要遷移**，永遠不自動遷移；遷移前先備份；只向前；遷移後原本的每個欄位逐一比對、不一致就中止（`FaRef.migrationPlan`） |
| 知識類型（類型定義） | `{kind,label,description,version,schema}`，每個類型自己有版本 | 改欄位＝類型版本 +1；使用者的類型版本不能倒退 |
| 知識條目 | `{kind,key,text,tags,src,tv,customize}`，`tv`＝建立時的類型版本 | 同 kind＋key：使用者的蓋過內建的 |
| 離線訓練器資料包 | `fa-offline-trainer` v2，`payload.knowledge`（選填）＝`fa-knowledge-types` v1 | 舊版程式讀到新資料包：忽略 `knowledge` 欄位，其餘照常（相容）；新版讀舊資料包：沒有 `knowledge` 就跳過 |
| 部位偵測的知識檔 | `fa-visual-parts` v1（`parts.json`，含 `size`） | 由 `ref_resolve` 展開產生，不手寫 |
| 3D 場景 YAML 的蒙皮 | polygon 節點的選填 `skin` 區塊 | 沒有 `skin` 的節點行為不變 |
| 標註範例 | 知識類型 `visual_example` | 跟知識一起走資料包 |

相容矩陣（舊＝沒有這輪擴充的 redmine，新＝有）：

| 情況 | 結果 |
|---|---|
| 舊 redmine 匯入新資料包 | 忽略 `knowledge`，領域／規則／狀態機照常匯入 |
| 新 redmine 匯入舊資料包 | 照常匯入，沒有知識區塊 |
| 新 redmine 的使用者資料還是 v0 | 內建知識（種子）照常查詢與展開；要註冊類型、寫帶 `customize` 的條目、匯入知識包時才問要不要遷移到 v1 |
| 資料是比程式新的版本 | 唯讀，不遷移、不覆寫，請更新程式 |

## 3. host 要實作的介面（L1：儲存）

引擎只吃兩個東西：內建資料（`FaRef.create(data, userDefs)` 的 `data`）與使用者資料物件。**host 負責把使用者資料存到哪裡**。需要實作：

| 方法（本專案名稱） | 要做的事 | 備註 |
|---|---|---|
| 讀原始資料 `_refRawStore()` | 回傳 `{text, data, error}`：原始 JSON 字串與解析後物件；沒有資料時兩者為 null | 本專案用 `localStorage`；redmine 可存伺服器（見第 7 節）。引擎的版本偵測 `FaRef.formatInfo(raw)` 直接吃這個 |
| 取得使用者資料 `_refUserDefs()` | 讀出來、補預設欄位；全新安裝直接用最新格式（`_format`＋`types`＋`typed`），有舊資料但沒有 `_format` 的保持 v0 | 引擎物件 `FaRef.create(data, userDefs)` 在使用者資料改變後要重建 |
| 存檔 `_refSaveUserDefs()` | 寫回並讓引擎快取失效 | 伺服器存檔時建議樂觀鎖（版本欄位）避免兩個人互相覆蓋 |
| 備份 `_refBackup(label)` | 整份存成備份（本專案：下載卡片＋IndexedDB 最近 3 份） | redmine 可以存成一筆伺服器端附件／資料列 |
| 遷移 `_refMigrate({apply,target})` | 呼叫 `FaRef.migrationPlan(raw, target)` 預演 → 先備份（失敗就中止）→ 寫暫存 → 驗證 → 才換成正式資料 | 預演與非破壞性檢查在引擎裡，host 只做「備份、原子寫入」 |
| 版本閘門 `_refRequireFormat(minVersion, label)` | 資料夠新就放行；不夠新就**問使用者**「要 migration 到 vN 才能做到，要不要」；選不要就維持舊版 | 需要一個「問使用者」的對話框 |
| 還原 `_refRestore(text)` | 驗證備份格式與版本，先替目前的資料另備份，再覆蓋 | |
| 寫入流程 `_refDefine(p)` | `ref_define` 的實作：註冊類型、寫條目；寫入前用「加入這筆之後」的引擎驗證結構、引用、循環 | 約 200 行；驗證部分都在引擎，host 只是呼叫與存檔 |

L2 工具（參數 schema 與說明文字照 `registerOptional('ref_define' …)` 抄，不要改寫語意）：`ref_lookup`、`ref_define`、`ref_types`、`ref_resolve`、`ref_validate`；圖片相關（可選）：`image_decompose_redraw`、`image_parts_teach`、`image_parts_annotate`、`image_rig_animate`。

L3 資料包的知識區塊只有三個呼叫，語意都在引擎，兩邊不會分叉：

```js
// 匯出（使用者資料是 v1 以上才帶）：沒有東西就回 null
const pack = FaRef.exportPack(userDefs, FaRef.FORMAT.current);
// 檢查（不寫入）：用「現有知識庫＋這份」驗證類型、結構、引用、循環；不合法的列警告、不收
const { warnings, knowledge } = FaRef.inspectPack(builtinData, userDefs, bundle.payload.knowledge, FaRef.FORMAT.current);
// 合併：衝突一律保留使用者的（overwrite 才覆蓋），類型版本不倒退；之後 host 自己存檔
const r = FaRef.mergePack(userDefs, knowledge, { overwrite, when: Date.now() });
```

## 4. 搬移步驟（每一步都有檢查點）

1. **複製共用檔案**（或在 redmine 的建置裡直接引用本專案的檔案）：`renderer/src/refs/`（引擎、類型、種子、`tests/`）、`scripts/refs-dsl.js`。標註與蒙皮要用就加 `renderer/src/annotator/`、`renderer/src/skin/`。
2. **用 `scripts/refs-dsl.js` 產生內建資料**，跟引擎一起載入（本專案由 `scripts/embed-code-ui.js` 嵌進主檔；redmine 可以照做，或改成執行時載入 JSON）。
3. **跑 `node scripts/run-core-tests.js`**（或至少 `node renderer/src/refs/tests/ref_engine.test.js`）。全部通過再往下。這一步證明引擎與內建資料在新環境行為一致。
4. **寫 host 的儲存層**（第 3 節的表）。先只做「讀、存、版本偵測」，用一份 v0 的舊資料驗證：查詢照常、內建種子可展開、不會被誤遷移。
5. **接版本閘門與遷移**：用 v0 資料呼叫 `ref_define{kind:"knowledge_type"…}`，應該跳出詢問；選不要 → 資料完全不動；選要 → 先備份、再遷移、原欄位逐一不變。
6. **註冊 L2 工具**，用 `ref_types`、`ref_resolve`、`ref_validate` 做冒煙測試（內建 11 種類型、全庫驗證通過）。
7. **接離線訓練器資料包**：匯出／匯入時呼叫第 3 節的三個函式；用本專案匯出的資料包在 redmine 匯入，再反向一次。
8. （可選）標註、骨架動畫：核心是純函式；視窗與 three.js 檢視器要瀏覽器，沒有就先不搬。

## 5. 改動規則（避免兩邊慢慢分叉）

1. **只在這個版本庫改共用檔案**，redmine 引用它們；不要在 redmine 裡改引擎或種子。需要的修改回到這邊做、跑測試、再更新釘住的版本。
2. **改資料格式一定升版本**：知識資料格式改了 → `FaRef.FORMAT.current` +1，並在 `FaRef.MIGRATIONS` 加一步（宣告式：`default`／`rename`／`move`／`drop`／`stamp`）；類型欄位改了 → 該類型的 `version` +1。測試裡有「遷移步驟接得起來、沒有缺口」的檢查。
3. **內建種子不要原地改語意**：要改就換 key 或升 `tv`；使用者可以用同 key 覆蓋內建，所以原地改會讓人以為是自己的修改。
4. **新增知識類型**＝新增 `types_*.json` 一個條目＋種子 `typed_*.json`＋測試裡把類型名稱加進「內建核心類型」清單；不需要動引擎。
5. **釘住版本**：redmine 引用共用檔案時釘 commit SHA（跟網頁版載入 `floating-assistant.js` 同一招，分支網址擋不住快取）。換版時換 SHA、跑第 3 步的測試。

## 6. 驗證（兩層）

**純函式層（Node，秒級）**：`node scripts/run-core-tests.js`，目前 4 組：
- 知識引擎 66 項：類型驗證、展開、繼承、循環、全庫驗證、**知識包匯出／檢查／合併（含衝突、不倒退、往返）**、**格式偵測與遷移（含非破壞性、唯讀、步驟接得起來）**、內建種子完整性。
- 標註核心 22 項、蒙皮核心 17 項。
- 部位偵測（Python，要有 numpy 與 pillow，沒有就略過並說明）41 項。

**真實環境層（要在 redmine 實際跑，這邊的測試替代不了）**：
- v0 資料：查詢與展開照常；用到新功能才問；選「先不要」資料不動。
- 遷移：備份檔真的產生、遷移後筆數一致、能用備份還原。
- 資料包往返：本專案匯出 → redmine 匯入 → 再匯出 → 本專案匯入，條目與計數一致。
- 標註視窗與蒙皮檢視器（若有搬）：在目標瀏覽器開起來、儲存、重新載入後知識還在。
本專案這幾項是在打包好的 Electron 裡驗證過的；redmine 要自己驗。

## 7. redmine 專屬要先確認的事

我看不到 redmine 的程式，下面是需要你（或看過那邊程式碼的人）決定的：

1. **引擎跑在哪**：`ref_engine.js` 是純 JS，能在瀏覽器或 Node 跑。如果 redmine 的 AI 聊天邏輯在瀏覽器（跟這邊一樣），直接用；如果在伺服器端的 Ruby，需要 Node 子程序或把引擎的 API 包成一個小服務，**不建議重寫成 Ruby**（兩份語意一定會分叉）。
2. **使用者資料存哪**：這邊是瀏覽器的 `localStorage`（每個人各一份）。redmine 通常有伺服器端儲存，要決定三層怎麼分：內建（隨程式）→ **專案共用**（同專案的人共用的補充知識）→ 個人。引擎只認「內建＋一份使用者資料」，專案共用層可以在 host 合併成一份再丟給引擎，衝突規則照 `mergePack`（保留較具體的那層）。
3. **誰能改共用知識**：使用者資料的寫入（`ref_define`、匯入資料包）在 redmine 要接權限；這邊沒有權限概念。
4. **備份放哪**：伺服器端附件或資料列都可以；重點是「遷移前一定先有備份、備份失敗就中止」。
5. **同時編輯**：兩個人同時存會互相覆蓋，建議存檔帶版本欄位做樂觀鎖。
6. **工具呼叫格式**：redmine 的 LLM 呼叫若不是 OpenAI 風格的 function calling，工具登記與回傳格式要轉；工具參數 schema 與說明是語意的一部分，照抄。
7. **不能直接用的**：Pyodide 工作執行緒、`localStorage`、`indexedDB`、桌面版的檔案信箱。圖片分解（Python）在 redmine 若沒有瀏覽器沙盒，要換成伺服器端 Python 執行同一支 `run_geometric.py`（它只依賴 numpy 與 pillow，純函式，不碰網路）。

## 8. 已知阻礙與還沒做的

- 工具的登記與說明文字目前寫在主檔的 `registerOptional(…)` 裡，**不是獨立的資料檔**，redmine 要照抄。建議之後抽成 `tools_manifest.json`（名稱、說明、參數 schema）兩邊共用；這輪沒做，先在第 3 節列清楚名稱。
- `_refDefine`（約 200 行的寫入流程）還在主檔；它的驗證都已經在引擎，但流程本身（要什麼參數、錯誤訊息、寫哪些欄位）是 host 程式碼，搬的時候要照原行為。
- 標註視窗與蒙皮檢視器綁在這個助理的 DOM 與 three.js 載入方式上，只有核心是共用的。
- `gesture` 的狀態機驅動播放沒做（`machine` 欄位目前只存不跑）。
- 主檔太大、`this.*` 互相纏繞的問題見 `DESIGN.porting-guide.md` §9，這輪只把「知識」這一塊的純邏輯抽出來，沒有重構其他部分。
