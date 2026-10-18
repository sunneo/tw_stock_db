# 技能→食譜（skill to recipe）與 runtime 設計出來的工具

> 範圍：2026-10-18。內建技能（media-presentation）的做法拆成程式食譜；匯入的 SKILL 由編譯器讀成同一種食譜；缺的能力交給 UML design，登記成「設計出來的工具」，之後進食譜、CoLU、工具搜尋。
> 核心：`renderer/src/recipe/skill_compile_core.js`（45→48 項測試）；宿主在 `floating-assistant.js`（`_skillRecipes`、`_skillRecipeRun`、`_skillCompile`、`_skillDesignGaps`、`_designed*`）。
> 相關：[橋接](DESIGN.llm-bridge.md)、[反思](DESIGN.reflection.md)、[離線食譜](DESIGN.offline-recipes.md)、[CoLU](DESIGN.colu.md)。

---

## 一、動機（使用者原話整理）

- 「media presentation 線上一直都能產生，離線這邊無法產生，就應該去拆解 media presentation 在做什麼」→ 內建技能要有**技能轉食譜**的能力。
- 「builtin skill 要能 recipe、能呼叫 uml_design、能 CoLU，甚至要對**匯入的 SKILL 做語義解讀**成 recipe、uml_design、CoLU」→ 編譯器。
- 「uml_design 創造好的工具，之後也要可以進入 CoLU，要有一個 runtime 設計的 tool 的 domain，AI 也要有管理介面」→ 設計出來的工具。
- 「離線模型不能輕易放棄，必須做好自己去 CoLU、uml_design」。

## 二、食譜的形狀

沿用食譜引擎（`FaRecipe.runRecipe`：`tool`／`compute`／`phrase`／`render`，`{{slots.x}}`／`{{vars.sN.text}}` 插值，驗證、步數上限 12、每一步記錄）：

```
{ id, skill, builtinId?, label,
  needs: ['image'|'url'|'text'|'doc'|'pdf'…],      // 手上要有的東西（任一種）
  triggers: ['簡報|投影片|…'],                      // 字串形式的正規表示式，任一個符合
  steps: [ …, { …, final: true } ],                 // 最後一步是呼叫端的工具，不在橋接裡執行，回 tool_calls
  status: builtin | compiled | draft, gaps: [...] }
```

- 執行器 `_skillRecipeRun(task, 呼叫端的工具名, log)`：依觸發字與手上的東西挑食譜（內建的＋存下來的＋匯入技能現場編的）；除了 `final` 以外的步驟在這裡跑；`final` 步驟的參數用 `{{…}}` 算出來，**空值的欄位不送**（使用者沒說的聲音、語速不塞給工具）。
- 食譜沒做成（例如這份不適用）就試下一份；全部都不行回最後一個錯誤。
- 技能被停用，它的食譜就不用。

### 內建食譜（media-presentation）

拆解 media-presentation 的 persona prompt 對「附圖片」與「整理文章」做的事：

| 食譜 | 觸發條件 | 做法（全部由程式，不靠小模型寫 yaml） |
|---|---|---|
| `deck_from_images` | 簡報／投影片／slide／presentation／deck／配音 ＋ 有圖片附件 | 每張圖 `import_uploaded_image` → "@imgN"；`_imageToText`（離線圖像模型 OCR）讀字；整理成句（`Halloween!Trick` 補空白、依標點分句、去版權／期號雜訊、英文簡報只留英文句）；每張圖一頁（版面 split：條列＝讀到的句子、旁白＝同一批句子）；語言／聲音（`af_jessica`）／語速（0.75）從請求抓進 `deck.lang／voice／speed` |
| `deck_from_article` | 同上觸發 ＋ 有網址／文件／夠長的文字 | **取得全文**（附件：`parse_uploaded_file` 或直接讀；網址：`fetch_web_page`；「維基今日歷史」沒給網址 → 今天日期的維基頁；其餘「查／搜尋」→ `browser_search` 取第一個非搜尋引擎的結果）→ **整理**（清掉標記、依標題分段、清單項目每 5 項一頁、散文抽重點句、略過「參考資料／外部連結」等段落、旁白不念清單的連字號、最多 12 頁）→ `render_presentation` |

沒有素材（沒有附件、網址、夠長的文字）：老實說需要素材，不編、不做示範簡報（跟線上子 agent 的守則一致）。

## 三、技能編譯器（FaSkillC）

CoLU 的形狀：**程式讀、程式綁、程式檢查；歧義用封閉選單；對不上的不猜，列成缺口**。

1. **extract**：從 SKILL.md／persona 抽出名稱與說明（frontmatter）、**觸發詞**（技能名稱的字、說明的關鍵詞）、**步驟**（編號清單、`Step N`、`步驟 N`、沒有編號就用列點；縮排接續行併進上一步）、**每步提到的工具**（只認工具表裡真的有的名稱，要是完整的字）、提到的腳本（`scripts/xxx.py`）。
2. **bindSlot**：工具欄位依「名稱＋型別」綁到手上有的東西——`file_id／image／pdf…` → 第一個附件、`url` → 網址、`query／text／question／prompt…` → 使用者的話、`voice／speed／lang` → 使用者說的選項、有預設值就用預設值；綁不到的必填欄位 → 缺口。
3. **資料流**：這一步的文字欄位如果在講「上一步的結果／逐字稿／摘要…」，接上一步的輸出（`{{vars.sN.text}}`，工具結果取 `text／transcript／description／content／summary／result／answer` 第一個字串）。
4. **缺口**（不放進食譜、不猜）：沒指名工具的動作句、提到的工具不存在、必填欄位綁不到、要跑腳本、步驟太多。每個缺口附相近的現有工具（`cap_reflect` 搜尋）或給 uml_design 的情境（`gapScenario`）。
5. 結果：沒缺口 → `compiled`；有缺口 → `draft`（**不自動使用**）。最後一個 tool 步驟標 `final`。
6. **匯入技能現場編**：匯入的技能沒有存過的食譜時，第一次用到才編（記憶體快取，技能內容或工具表改了就重編）；只用 `compiled` 的。

入口：`skill_compile({skill?, save?, design?})`（AI／使用者可叫）；管理介面在 Advance Settings →「設計出來的工具」分頁底下的「技能食譜」（工程模式；啟用／停用／刪除）。

## 四、缺口 → UML design → 設計出來的工具

`skill_compile({design:true})`（`_skillDesignGaps`）：

1. 要設計的缺口＝要跑腳本的、或沒有相近現有工具（分數 ≥ 8）的；最多 4 個。
2. **手動模式先問**一次（列出缺口、說明離線 CPU 上每個要幾分鐘）；**自動模式**（`routeMode: auto` 或 `auto:true`）直接做。
3. 對每個缺口 `_umlDesign({scenario, model:'offline'})`（離線小模型一次一小題設計）→ 登記成**「待實作」的設計工具**：`enabled:false`、`draft:true`、`fromSkill:<技能名>`、帶 UML 與情境、處理程式是「還沒實作」的 `throw`。
4. 你（或更強的模型）補上處理程式、按啟用 → 再編譯一次：搜尋第一名是**已啟用的設計出來的工具**時，那一步改用它，缺口消失，食譜變 `compiled`。
5. 不是設計出來的相近工具**不會**自動換（只當建議）。

## 五、runtime 設計出來的工具（`designed_tools` 領域）

- 資料：`advancedSettings.designedTools[]` ＝ `{ id, name, description, parametersSchema, handlerScript(JS), uml, scenario, enabled, draft, fromSkill, designedAt, runs, lastError }`。
- 登記：`register_designed_tool`（名稱不能蓋掉內建工具或自訂技能；處理程式先過語法檢查；同名更新）、`list_designed_tools`、`remove_designed_tool`；領域 `designed_tools` 管理它們。
- 登記後同步進 `this.tools`（有名稱、說明、參數結構），所以**食譜的路由選單與欄位補齊、工具反思的搜尋、橋接的 `tool_calls`、技能編譯器的步驟綁定**都自動看得到。說明與情境被當成搜尋別名（使用者用自己的話說）。
- 執行：`_executeCustomTool`（JS，可 `await`，參數在 `args`，回傳值就是結果）；執行次數與最近的錯誤記在工具上。
- 管理介面：Advance Settings →「設計出來的工具」（**只在工程模式**，一般人不會用）：列表、啟用／停用、看 UML 與程式、試跑（輸入 JSON 參數）、刪除、匯入／匯出；待實作的標出「待實作（UML 已設計，來自技能 xxx）」。

## 六、資料與設定一覽

| 項目 | 位置 |
|---|---|
| 設計出來的工具 | `advancedSettings.designedTools` |
| 編譯過的技能食譜 | `advancedSettings.skillRecipes`（`status`、`enabled`、`skillId`、`gaps`） |
| 內建食譜 | 程式裡 `_builtinSkillRecipes()` |
| 路線模式（手動／自動） | `advancedSettings.routeMode`（`/route`） |

## 七、測試與驗證

- 核心：`node renderer/src/recipe/skill_compile_core.test.js`（48 項：frontmatter／觸發詞、步驟（含中文「步驟 N」、列點、縮排接續）、工具名要是完整的字、欄位綁定、資料流、缺口種類、必填綁不到不放進食譜、同一工具只算一步、缺口對上設計出來的工具、persona 沒有 frontmatter）。
- 桌面版（測試用 app）：
  - 簡報（圖片）：自己畫一張有四句話的圖，離線約 24 秒做出合法簡報（`af_jessica`、0.75、英文，四句拆成條列），通過 `render_presentation` 驗證。
  - 簡報（文章）：模擬的維基今日歷史（Markdown），62 毫秒做出 5 頁，略過「參考資料」，通過驗證；沒有素材時回「需要素材」。
  - 匯入技能：編成草稿（缺口＝要跑腳本）、存檔重載還在、草稿不自動使用；改成已編好後用假工具跑，資料從第 2 步傳到第 3 步，沒說的語速／聲音不送。
  - 缺口設計：手動模式選「不用」→ 不設計；選「照這個做」→ 登記出待實作的工具（停用、有 UML、不在工具表）；實作並啟用後重編 → `compiled`、缺口為零。

## 八、限制與下一步

1. 只認編號清單、`Step N`、`步驟 N`、列點；散文寫的流程或沒寫工具名稱的步驟會變成缺口。
2. 觸發詞是從名稱與說明抽的，可能誤觸發或抓不到；沒有拿多份真實技能量過準確度。
3. 缺口只做到「設計出 UML、登記待實作」，**處理程式還是要別人補**。下一步：由線上強模型依 UML 寫處理程式，用範例輸入試跑驗證後才啟用。
4. 設計出來的工具只支援 JavaScript 處理程式；UML 骨架（Python／TypeScript／Java）不會自動變成工具。
5. 網頁抓取與「自動搜尋」兩條路寫了、沒測。
6. 食譜欄位的綁定是名稱規則，沒有語意判斷；綁錯的會在執行時被工具的驗證擋下，不會默默做錯。

## 九、決策紀錄

- **內建技能用手寫食譜、匯入技能用編譯器，兩者同一個執行器**：內建的先求穩、可驗證；匯入的靠同一套檢查。
- **有缺口的食譜是草稿**：不自動使用，避免做一半。
- **缺口不猜**：交給現有工具（建議）或 UML design（登記待實作），讓能力累積而不是每次臨時湊。
- **工具呼叫由呼叫端執行**：食譜只決定參數；簡報的播放器、確認、重試都不用改。
- **簡報由程式組、模型不寫 yaml**：離線小模型寫不出整份文件；程式組出來的簡報可驗證、可重複。
- **設計出來的工具進 `this.tools`**：不另開一套，食譜、搜尋、橋接全部自動適用。
- **管理介面只在工程模式**：一般人不會用。
