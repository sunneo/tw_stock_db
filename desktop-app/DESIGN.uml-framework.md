# UML → 程式骨架 framework：設計語意 → UML → framework（top-down，每一區都是 template）

> 構想：以前常用「文字情境（user scenario）→ UML → 程式碼」。UML 確定之後，接下來多半是選架構、選各領域的 library——那是選擇題與填空題；UML 設計階段本身也可以 top-down 遞迴 rework，並對應到離線訓練器。弱的小模型（離線模型，或比較弱的線上模型）就能一路從設計語意走到程式骨架。
> 核心：`renderer/src/uml/uml_core.js`（`FaUml`）、`renderer/src/uml/design_core.js`（`FaDesign`），純函式 UMD，測試 `uml_core.test.js`（60 項）、`design_core.test.js`（47 項）。與 `DESIGN.offline-recipes.md`、`DESIGN.offline-plans.md` 同一套原則：**程式能決定的就程式決定，模型只做封閉的小決策，每一步驗證，每個決定都記錄。**

## 1. 管線

```
情境（文字）
  ⓪ 程式讀情境（詞彙表＋動作表）──讀得出來就整份設計由程式決定（模型 0 次呼叫）
  ① 讀不出才走模型階段：參與者與使用案例 → 類別 → 每個類別的成員 → 關係 → 呼叫順序（一次一個封閉的小問題）
  ② top-down rework：由上而下找問題，只重做有問題的那一區
  ③ 圖（程式）：Mermaid 類別圖／循序圖／使用案例圖、PlantUML
  ④ 抉擇（程式＋選擇題）：架構風格、各關注點的 library
  ⑤ 展開（程式，template）：專案 → 類別檔 → 成員 → service／repository／api／cli → 測試 → 依賴清單 → README 與設計決策表
```

### UML 的文字 DSL（一行一件事，弱模型友善）
```
model: 線上書店
actor: Customer, Admin
interface Payable { pay(amount:float):bool }
enum OrderStatus { NEW, PAID }
abstract class Entity { +id:int }
class Order extends Entity implements Payable { status:OrderStatus; +pay(amount:float):bool }
Cart o-- Book : contains *          # 聚合；*-- 組成；--> 關聯；..> 依賴
usecase Checkout: Customer -> Cart.add(book) -> Order.pay(total):bool
```
每一行獨立解析、獨立報錯（行號＋原因），壞的一行不影響其他行；沒有結尾的大括號遇到下一個頂層陳述就結束，不會吞掉後面。型別：`int float str bool date datetime decimal any`、`List<T> Map<K,V> Optional<T>`（也接受 `T[]`、`T?` 與常見同義詞如 `string`、`double`）或已定義的類別。驗證：型別必須是基本型別或已知類別、`implement` 的對象必須是 interface、繼承不能有環、使用案例呼叫的操作必須存在（不存在時程式自動補進類別）、重複成員、類別名稱 PascalCase。

## 2. ⓪ 程式先讀情境（為什麼）
實測（打包版 Electron、Qwen3 0.6B）：叫它「從中文情境直接寫出 JSON 設計」，它會**改用散文回答**，或把系統提示詞當成參與者（「UML 設計助手」）、用中文當類別名稱。兩個修法：
1. **prefill**：Worker 支援把回覆的開頭先寫進提示詞（`{"actors":["`），模型只需要接著寫完；回傳的文字包含這個開頭。實測從散文變成合法 JSON——但內容仍是幻覺（參與者「UML 設計助手」），所以光靠 prefill 不夠。
2. **把「讀情境」搬回程式**（設計判斷標準：能程式決定的就不要問模型）：
   - **詞彙表**（資料）：中文詞 → 英文類別名稱、種類（參與者／實體）、常見屬性（書籍 → `Book { title, author, price }`、購物車 → `Cart`、訂單 → `Order`…）。
   - **動作表**（資料）：中文動詞 → 使用案例名稱的動詞、會呼叫哪些「類別.操作」（`結帳` → `Cart.checkout → Order.create`、`付款` → `Payment.pay`、`加入購物車` → `Cart.add`、`上架書籍` → `Book.publish`）；`$obj` 是句子裡的名詞所對應的類別（取動詞之後最近的名詞），輔助類別（Payment、AuthService…）自動補。
   - **句型**：「<參與者> 可以／能／會／需要 … A、B 並 C」→ 參與者與一串使用案例；段落沒有新參與者就沿用上一個。
   - **關係表**：兩個類別都出現就加（`Cart o-- Book`、`Order --> Payment`…）。
   - 讀得出參與者、使用案例與至少兩個類別 → **整份設計由程式決定，模型 0 次呼叫**（決策記錄 `by: program`）；程式不認得的參與者列在警告（可補詞彙表）；讀不出就走模型階段。
   - 詞彙表可擴充：設定 `umlGlossary`（`{ 中文詞: { en, kind, attrs } }`），也是離線訓練器可以養的詞彙（見 §6）。

範例：「顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。」→ 4 個使用案例 `BrowseBook`、`AddToCart`、`CheckoutPay`（`Cart.checkout → Order.create → Payment.pay`）、`PublishBook`，類別 `Book／Cart／Order／Payment`，關係 `Cart o-- Book`、`Order --> Payment`…，**0 次模型呼叫**。

## 3. ① 模型階段（讀不出時）
每個階段一個封閉的小問題，回覆都被驗證，**模型沒有前面階段的記憶**，不合格就退回（只帶它自己最後一次的回覆與精確的錯誤，最多 2 次，連續兩次相同提前停止）：

| 階段 | 問題 | 驗證 |
|---|---|---|
| actors | 參與者與使用案例 | 1～4 個、英文 PascalCase、使用案例的 actor 必須在 actors 裡 |
| classes | 有哪些類別（class／interface／enum） | 2～10 個、PascalCase、不重複、kind 合法 |
| members（每個類別一次） | 屬性與操作（至多 6＋6） | 名稱 camelCase、型別必須是基本型別／已知類別、列舉要 2～8 個大寫值 |
| relations（每個類別一次） | 跟誰有什麼關係 | 對方必須是已知類別、種類在選單內、implement 對象必須是 interface、inherit 不能指向 interface |
| sequence（每個使用案例一次） | 呼叫順序 | 類別與操作來自選單（真的存在的操作），不存在可以填新的 camelCase 名稱（自動補進類別） |

提示詞不放範例值（小模型會照抄）；每個回覆都有 prefill。任何階段連續失敗只退成「保守預設＋警告」，不會讓整條掛掉；第一階段就失敗就明說失敗，不編設計。

## 4. ② top-down 遞迴 rework（`reworkModel`）
`findIssues` 由上而下找問題並指出「哪一區」：模型層（沒有使用案例、類別過多）→ 類別（沒有成員、操作太多＝責任太多、孤兒類別）→ 關係 → 使用案例（呼叫順序少於 2 步、呼叫不存在的操作）＋驗證器的每個錯誤。**只重做有問題的那一區**：沿用同一個階段的封閉問題，並附上「目前這一區的內容」與「要修正的問題」；回覆合格就套用，之後 `normalize`（程式）收拾下層——拿掉指向不存在類別的關係與步驟、補不存在的操作。最多 2 輪；沒有問題就**零次模型呼叫**；模型一直答不好就把剩下的問題原樣報告，不壞掉。每輪記錄「哪一區、什麼問題、誰修的、重試幾次、被退回的原因」。`packagesOf` 用關係與使用案例的連通分量把類別分群（程式）。

## 5. ④ 抉擇與預先建立的 framework（`design_core.js`）
**架構風格**（5 種）：分層（api → service → repository → domain，預設）、六角、命令列、函式庫、事件驅動，各有適用條件、說明、取捨。**關注點**（9 個）：對外介面（REST／命令列／函式庫）、資料儲存（記憶體／SQLite／關聯式＋ORM／文件型）、驗證、測試、記錄、呼叫外部服務、認證、排程、訊息。每個選項有關鍵字、**各語言對應的 library**（Python／TypeScript／Java：fastapi／express／spring-boot、typer／commander／picocli、sqlalchemy／prisma／spring-data-jpa、pydantic／zod／jakarta-validation、pytest／vitest／junit…）與取捨；依賴清單的實際套件與版本也是資料。

**推薦（`recommend`）**：從情境關鍵字算每個選項的分數 → **贏的程式決定**（附原因，例如「情境提到：資料庫、會員」）→ **平手才變成選擇題**（`resolveAmbiguous`：模型只回答 `{"choice": 編號}`，選單列出每個選項的取捨）→ 沒有線索用預設（標示 `default`，不問模型）。優先順序：**呼叫者指定（constraints）> 使用者／離線訓練器記得的偏好（prefs）> 程式依關鍵字 > 預設**。每個決定都標明由誰決定，寫進 README 的「設計決策」表。

**常見設計片段（`FRAGMENTS`，8 個預先建好的 UML＋抉擇先驗）**：CRUD 實體、購物車與訂單、登入與權限、Observer、Strategy、Factory、狀態機、庫存、定時工作。情境符合就當**種子**（`seedModel`：合併進設計，類別名稱衝突就跳過），它的抉擇（例如購物車 → 資料庫＋HTTP 客戶端）餵給推薦當先驗。

## 6. 對應到離線訓練器（以及線上 AI）
- **內建知識**：每個片段註冊成離線訓練器的內建領域 `uml_design`（`trainerPatterns`）：語意範例（片段名稱＋觸發詞組）、說明、UML 片段、抉擇。實測「購物車系統要怎麼設計」→ 訓練器比對到 `uml_shopping_cart`（0.85），**不經過任何模型**就能回答片段的 UML。也自動進離線模型的參考資料包（`_offlineReferences`）。
- **養成**：離線設計做完且沒有警告 → 養回訓練器（領域 `learned_designs`，語意範例＝情境、UML＝設計；照「自動訓練」設定）；使用者在 `uml_to_code` 用 `remember:true` 指定的抉擇存成**偏好**（`designPrefs`），之後推薦優先採用；詞彙表（`umlGlossary`）是使用者／訓練器可以擴充的詞彙。top-down rework 的每一步（哪一區、什麼問題、怎麼修）都有決策記錄，是訓練器日後可以學的「設計修正樣式」。
- **工具（離線訓練器與線上 AI 共用，強弱都行）**：
  - `uml_to_code`：UML 文字 → 驗證 → 專案 zip。**線上 AI（強或弱）自己寫 UML 文字呼叫它**：格式錯誤精確回報到哪一行；弱一點的線上模型只要寫一行一件事的 DSL，不用手寫整個專案的樣板。
  - `design_choices`：列出架構與各關注點的選項、各語言的 library、取捨，以及依情境的推薦與符合的片段——線上 AI 只需要「選」，不需要「想」。
  - `uml_design`：用離線小模型一步一步設計（⓪～②），給沒有強模型可用的情況；強線上 AI 不需要它。
  - 三個都是 domain-gated（`coding` 與 `drawing` 領域；桌面版 `bootstrap.js` 的 `coding` 領域也補上了），不佔根層級的 context；程式設計領域的提示詞教 AI 的流程：`design_choices` → 自己寫 UML → `uml_to_code`。
  - 離線計畫：目標 `uml_code`（情境→UML→程式碼骨架：`local_uml_design` → `uml_to_code`，UML 以種類 `uml` 在步驟之間傳遞）與 `uml_only`；使用者說「設計一個…系統，從情境做 uml 再產生程式骨架」就會走這條。

## 7. ⑤ 產生的專案（template，由上而下）
- **專案**：`README.md`（類別圖、使用案例圖、每個使用案例的循序圖，全是 Mermaid；原始情境；**設計決策表**：決策／選擇／由誰決定／原因）、`docs/model.uml.txt`（DSL 原文）、依賴清單（`requirements.txt`／`package.json`／`pom-dependencies.xml.txt`，依選到的 library）。
- **分層架構**：`domain/`（類別檔：Python dataclass／Enum／ABC、TypeScript class／interface／enum、Java class／interface／enum；compose／aggregate／關聯推出的欄位自動補，多重性帶 `*` 就是 List）、`services/`（每個使用案例一個 service，方法本體是 stub，註解寫出該使用案例的呼叫順序）、`repositories/`（資料儲存不是 none 時，每個實體一個 repository 介面＋記憶體實作）、`api/`（FastAPI／Express／Spring controller，每個使用案例一個 endpoint）、進入點（`main`／`cli`）、`tests/`（每個使用案例一個測試骨架，列出呼叫順序，預設 skip／Disabled）。命令列架構換成 typer／commander 指令；函式庫架構只輸出 domain。
- 方法本體是 stub（`raise NotImplementedError`／`throw new Error`／`UnsupportedOperationException`），不是亂猜的邏輯。
- **實測（編譯／型別檢查）**：產生的 Python 全部 `compileall` 通過且 domain 模組可以 import；Java 的 domain／services／repositories 用 `javac` 編譯通過；TypeScript 用 `deno check` 型別檢查通過（domain／services／repositories）。
- **語言可擴充**：新增語言＝加一組 `LANGS` 條目（型別對照＋class／test template）與 `PKG` 依賴對照，管線其他部分不用改。

## 8. 實測（打包版 Electron、CPU 4 執行緒、Qwen3 0.6B）
- `uml_to_code`：給 DSL＋scenario → 16 個檔案的 Python 專案 zip（分層、FastAPI、sqlalchemy、pydantic、pyjwt，README 設計決策表正確標出「情境提到：資料庫、會員」）；壞的 DSL 精確回報「第 2 行：大括號沒有結尾」；使用案例呼叫不存在的操作自動補上並警告。
- `design_choices`：推薦與選項、符合的片段（auth_login、shopping_cart）。
- 離線訓練器：「購物車系統要怎麼設計」命中內建片段。
- 離線計畫：「設計一個線上書店系統：顧客可以瀏覽書籍、加入購物車並結帳付款，管理員可以上架書籍。請從情境做 uml 再產生程式骨架」→ 目標由模型從兩個符合的目標（`uml_code`、`uml_only`）挑 `uml_code` → 程式讀情境（0 次模型）→ `uml_to_code` → **35 個檔案的專案 zip 完成**；主執行緒最大延遲 90 毫秒。
- 修掉的坑：模型改用散文／幻覺參與者 → prefill＋程式先讀情境；`{{this}}` 在字串陣列裡印成 `[object Object]`；沒有結尾的大括號吞掉後面的行；單字母類別名稱被 PascalCase 規則擋；Java 參數誤用 boxed 型別；分層架構的測試 import 路徑；`coding` 領域的工具清單被桌面版覆蓋所以工具不在裡面；行尾 `//` 註解吃掉後面的程式（寫 patch 時）。

## 9. 限制（誠實）
- 詞彙表與動作表目前有 33 個名詞詞、30 個動詞、25 個參與者詞（同義詞各算一個）；沒收的詞會走模型階段，而 0.6B 在模型階段的內容品質很差（prefill 只保證格式）。實用上要靠擴充詞彙表（設定 `umlGlossary`、之後由訓練器養）或用比較強的模型。
- 模型階段在 CPU 上每個階段幾十秒，整條模型路徑要好幾分鐘。
- 句型只認「X 可以／能／會… 做 A、B 並 C」；複雜條件、否定、例外流程讀不出來。
- 方法本體是 stub；沒有狀態圖／活動圖，循序圖只有單向呼叫鏈（沒有分支與迴圈）。
- 目前三種語言（Python／TypeScript／Java）；TypeScript 的 service／repository 沒有依賴注入；Java 只有 controller、service、repository 介面、application 類別（沒有 JPA entity 註解）。
- 偏好（`designPrefs`）與詞彙表（`umlGlossary`）目前只能由設定／工具參數寫入，還沒有圖形介面。
- GPU 路徑沒在這台機器實測。

## 10. 移植到 redmine
帶走 `uml_core.js`＋`design_core.js`＋測試（只依賴 `recipe_core.js` 的 `jsonStep`／`chooseTool`）。宿主提供：`generate`（強制 JSON 的文字生成，支援 prefill）、zip 輸出、訓練器的詞彙與偏好。redmine 的 `scene3d`／`block_diagram` 等食譜與這裡是同一套「程式決定、模型只做封閉小決策」的做法；UML 可以用它的 Mermaid 渲染工具顯示。
