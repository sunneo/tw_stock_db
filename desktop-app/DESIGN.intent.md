# 意圖解析（intent-to-bugfix、intent-to-testcase 的設計指引）

> 範圍：2026-10-18。程式：`renderer/src/uml/user_intent_core.js`（`FaUserIntent`，純函式、無相依，75 項測試）；宿主的 `intent_parse` 工具（`_intentParse`）。
> 相關：[UML 框架](DESIGN.uml-framework.md)、[CoLU](DESIGN.colu.md)、[反思](DESIGN.reflection.md)、[技能→食譜](DESIGN.skill-recipes.md)、[橋接](DESIGN.llm-bridge.md)、[CoLU 移植包](DESIGN.colu-porting.md)。
> 名稱注意：日誌探勘那一份另有一個 `FaIntent`（`logmine/intent_core.js`），這份叫 `FaUserIntent`，檔案在 `uml/user_intent_core.js`，嵌入標記是 `UINTENT`。

---

## 一、動機

弱的模型（離線小模型、退化的線上模型）只有有限的專注力。ITS（議題追蹤）的描述、使用者的話，要變成 bug 的修正計畫或測試案例，不能靠它「整段讀完再想」。

做法跟 CoLU 同一個形狀：**程式把文字切細、讀出角色與行為，缺什麼就問封閉的小問題，才交給模型或下一個流程**。目標是：

- 例如讓它讀懂 ITS 的描述，呼叫 testcase writer／testcase design 這類工具；
- 離線時照樣做得到：文字切割 → 語意切割 → 語意意象 → 行為 → UML 的各個行為描述；
- 從描述裡找出**驗證步驟**與**期待修正後（或隱含正常）的狀態**——明確寫的、隱含的都要。

## 二、管線

```
文字 ──① segment──→ 段落（章節標題／編號步驟／列點／句子／程式碼／log）
     ──② classify─→ 角色：環境／前置條件／動作／觀察到的／期待的／驗證／原因／修正建議／雜訊（明確 vs 隱含分開記）
     ──③ behavior─→ 語意意象 → 行為：{ actor, acts:[{verb(正規化), object, value?}], state, polarity }
     ──④ implied──→ 隱含關係：壞掉的觀察 → 隱含的期待；沒有驗證 → 隱含的驗證
     ──⑤ gaps─────→ 缺什麼 → 封閉的小問題（不猜）
     ──⑥ toUml／toTestCase → UML（使用案例的呼叫順序＋期待的狀態）／測試案例
```

只有一種情況問模型：**歧義**（第一名與第二名的分數差 ≤ 1 且分數不高）。問的是封閉選擇題（選項 ≤ 4），模型挑不出來、越界、出錯，一律用程式的第一名。

### ① 文字切割（`segment`）
- 章節標題（單獨一行或同一行「預期結果：…」）：重現步驟／預期結果／實際結果／環境／前置條件／驗證／原因／修正／備註（中英都認，標題後面沒有字母數字才算，中文不靠 `\b`）。
- 編號步驟（`1.`、`1)`、`①`、`Step 1`、`步驟 1`）、列點、句子（`。！？；. ! ?` 切開）、程式碼區塊（```）、log 行（時間戳、`[ERROR]`、堆疊）。每段帶所屬的章節。

### ② 語意切割（`classify`）
分數＝章節標題（6）＋句型提示詞（`應該／should／expected` → 期待 3、`確認／verify／check that` → 驗證 3、`實際／卻／but／instead` → 觀察 2、動詞開頭 → 動作 2…）＋壞掉的狀態（觀察 2）；「不應該／should not」是期待。
- `explicit`：章節標題或明確的提示詞。沒有章節、只靠句型的標成隱含。
- 詞表是資料（`SECTIONS`／`CUES`），宿主可以用 `lex.cues` 疊加自己領域的詞。

### ③ 語意意象 → 行為（`behaviorOf`）
- **動詞表**（雙語，正規化成英文動詞）：`click／select／open／close／input／run／connect／login／upload／save／delete／add／install／set／reboot／boot／flash／upgrade／read／write／switch／wait…`。
- **一句多個動作**：「開機後按 Del 進入 Setup」→ `boot, click(Del), open(Setup)`。
- **中文句子裡的英文名稱不當動詞**：「把 Boot Mode 改成 UEFI」是 `set(Boot Mode → UEFI)`，不是 `boot`。
- **狀態詞**：`crash／stuck／error／timeout／missing／wrong／ok`；**極性**：壞掉（-1）／否定（無法、不能、沒有、cannot、fail…）／正常（+1）。
- **角色**：Tester／Developer／Admin／User／System。

### ④ 隱含關係（`build` 裡）
| 描述 | 隱含出來的 | 標記 |
|---|---|---|
| 「系統無法開機」 | 期待：應該能開機（`invert`：無法／不能／不會／沒有 X → 應該能 X；`cannot X` → `should X`） | `implicit: true`、`basis`＝依據的那句 |
| 「系統當機」（只有狀態詞） | 期待：不應該當機／崩潰 | 同上 |
| 標題本身是壞掉的描述、沒有「實際結果」 | 觀察（隱含）＋它的反面 | 同上 |
| 沒有明確的驗證方式 | 驗證：照重現步驟再做一次，確認期待的狀態 | `implicit: true` |
| 「修正後…」「應該…」「expected…」 | 明確的期待 | `explicit: true` |

**隱含的東西一律標出來、附依據**，使用者與下游工具看得到「這是推的，不是你寫的」。

### ⑤ 缺口與封閉的小問題（`gapsOf`／`questionsOf`）
bugfix／testcase：沒有步驟、沒有（明確或隱含的）期待、沒有觀察（bugfix）、沒有環境、類型不明 → 各一個問題，選項至少 3 個且含「照預設／不知道」。**不猜**。

### ⑥-A 到 UML（`toUml`，intent-to-bugfix 的下一步）
輸出 FaUml 的文字 DSL（能被 `parseDsl`＋`validateModel` 通過，測試保證）：
```
model: <標題>
actor: User, System            # 有 Tester 就是 Tester
class SystemUnderTest { +boot():void; +clickF10():void; +observeCrash():bool; +expectOk1():bool }
usecase Reproduce: User -> SystemUnderTest.boot() -> … -> SystemUnderTest.observeCrash()
usecase VerifyFix: User -> … -> SystemUnderTest.expectOk1()     # testcase 類是 VerifyExpected
```
- `Reproduce`＝重現步驟＋觀察到的壞狀態；`VerifyFix`＝重現步驟＋期待的狀態（`expect…():bool`）。
- 連續重複的呼叫只留一次。再用既有的 `uml_to_code`／`uml_edit` 往下走。

### ⑥-B 到測試案例（`toTestCase`，intent-to-testcase 的下一步）
- `TC-1`（positive）：前置（含環境）、步驟、預期（明確／隱含分開標）、驗證（隱含的標出來）。
- 每個壞掉的觀察一個迴歸案例（`regression`）：預期＝原本的現象不再發生（隱含）。
- 回傳 `gaps`／`questions`；對應的測試工具（例如 qarobotz testcase writer／design）由宿主接，這裡只給結構。

## 三、中英翻譯輔助與媒合（使用者的補充）

詞表是雙語的，但使用者的寫法千百種，工具與目錄的說明多半是英文。所以**媒合與計算意象時可以用中英互譯**（`translate` 是注入的：`async (text, to) → 譯文｜null`；宿主接離線的中英互譯 `translateText`，離線模式預設開）：

1. **讀不出的段落**（雜訊、動作沒有認得的動詞、沒有狀態）先翻成另一種語言，再用同一批規則讀一次。「畫面一直轉圈圈沒有動靜」→ "The screen keeps spinning with no response" → 狀態 `stuck`。標 `via: 'translate'`、附譯文；**讀得出來的段落不翻**（省時間，離線 CPU 上翻譯不便宜）；翻譯出錯或沒有譯文 → 用程式的結果、不丟錯。
2. **意象**（`imagery`）：一份意圖的雙語詞集合——原文的詞、正規化的英文動詞、狀態詞、譯文的詞。
3. **媒合**（`match`）：拿意象去配候選（目錄單元、工具、技能）的名稱與說明；名稱的詞加權 ×2、依候選長度正規化；宿主用在 `intent_parse({match:true})` 配現有工具（例如 testcase 類工具），門檻 0.6。
   - 中文描述配英文說明：「按下 F10 儲存並離開」譯成 "Press F10 to save and exit" 後，才配得到 `save_bios_settings`（說明 "Press F10 to save the BIOS setup settings and exit"）；沒有翻譯只靠 F10／動詞也配得到一部分，但分數較低。

## 四、intent-to-bugfix 與 intent-to-testcase 的設計指引

**intent-to-bugfix**（議題 → 修正計畫）
1. `intent_parse({text, uml:true})`：看 `steps／observations／expectations／verifications／gaps`。
2. `gaps` 不空就**先問**（封閉選項），不要硬做。
3. 重現與驗證的使用案例（`Reproduce`／`VerifyFix`）是修正的驗收：修好之後 `VerifyFix` 要通過；期待是隱含的就在計畫裡寫明「期待是推的」。
4. 原因（`causes`）與修正建議（`fixes`）只當線索，不當結論。
5. 弱模型的工作拆成：每個 `Reproduce` 步驟一個小任務（一次一個動作＋它的預期），不是整段。

**intent-to-testcase**（需求／議題 → 測試案例）
1. `intent_parse({text, testcase:true, match:true})`：`testcases` 是結構化的案例，`matched_tools` 是配到的現有工具。
2. 預期要分明確與隱含；隱含的預期要讓人確認（或標成「推測」）。
3. 迴歸案例保護「原本的現象不再發生」；正向案例驗證期待的行為。
4. 缺環境、缺預期就問，不要編。

## 五、資料與設定

| 項目 | 位置 |
|---|---|
| 核心（無相依） | `renderer/src/uml/user_intent_core.js`（嵌入標記 `UINTENT`） |
| 工具 | `intent_parse`（在 `coding` 領域，跟 `uml_*` 一起） |
| 擴充詞表 | `parse(text, {lex: {cues: [[role, regex, score]]}})` |
| 測試 | `node renderer/src/uml/user_intent_core.test.js`（75 項） |

## 六、搬到別的宿主（例如 Redmine 的 ToolWire）

- `user_intent_core.js` 是 UMD、純函式、**沒有任何相依**：整支複製即可；宿主要做的只有兩件事：
  1. 給它 `translate`（沒有就不翻，其餘照常）；歧義的挑選 `pick`（沒有就用程式的第一名）。
  2. 把 `toTestCase` 的結構對到自己的測試工具、把 `toUml` 的 DSL 接到自己的 UML／設計流程。
- 詞表換成自己領域的（ITS 欄位名稱、機型、模組名稱）：`SECTIONS`（章節標題）、`CUES`、`VERBS`、`STATE` 都是資料，用 `lex` 疊加。
- ITS 的欄位（標題、描述、重現步驟、預期結果、環境）如果本來就是結構化的，直接當章節餵進去：「欄位名稱：內容」會被當成章節標題讀。

## 七、驗證

- 核心 75 項：切割（章節、同一行的「預期結果：…」、步驟、程式碼、log、英文章節）、角色（明確／隱含／歧義）、行為（一句多動作、英文名稱不當動詞、極性、狀態、角色）、隱含的反面（中英）、整體解析（中文／英文／口語）、缺口與問題、UML（解析＋驗證通過）、測試案例、模型輔助（歧義才問、越界／出錯退回程式）、翻譯輔助（認不出才翻、翻譯出錯不丟錯、意象與媒合）。
- 桌面版（測試用 app）：一份 BIOS 儲存當機的議題 → `bugfix`、3 個步驟、2 個隱含的期待（不應該當機、應該能反應）、隱含的驗證、UML 通過 `parseDsl`、3 個測試案例（1 正向＋2 迴歸）；離線模式下「畫面一直轉圈圈沒有動靜」呼叫一次翻譯、讀到 `stuck`；只有「登入頁面有問題」→ 問缺少預期、現象、環境。

## 八、限制與下一步

1. 詞表偏中文與英文的常見說法，沒有拿大量真實的 ITS 描述量過準確度；步驟動詞認不得的會落到雜訊／歧義。
2. 物件（object）的抽取是規則（動詞後的第一個名詞片語），複雜的句子會抓不到或抓偏。
3. 隱含的期待只做「反面」這一種；因果、時序（「之後」「重開機後」）的隱含關係還沒有。
4. `intent_parse` 沒有自動接進 `uml_design`／食譜：目前是 AI 或使用者先呼叫、再把 DSL 交給 `uml_to_code`。下一步：把它接成離線橋接與 `plan_route` 的前置，並把 `behaviors` 登記成 UML catalog 的單元候選。
5. `matched_tools` 的媒合是詞的重疊，沒有語意向量；候選的說明太短時分數不穩。
6. 沒有對接 qarobotz 的 testcase writer／design（不知道它們的介面）：`toTestCase` 給的是通用結構，要接的人自己對欄位。

## 九、決策紀錄

- **先切細再讀**：弱模型的專注力有限，段落、角色、行為都由程式決定；模型只在歧義時挑。
- **隱含的一律標出來**：`implicit`＋`basis`，不把推測當成使用者寫的。
- **缺什麼就問、不猜**：封閉的選項，含「不知道」。
- **翻譯只用來讀、不改原文**：認不出才翻，標 `via`。
- **UML 用既有的 DSL**：能被 `parseDsl`／`validateModel` 通過，直接接 `uml_to_code`／`uml_edit`。
- **整支無相依**：方便授權與移植（ToolWire）。
