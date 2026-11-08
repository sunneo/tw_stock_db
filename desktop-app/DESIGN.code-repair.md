# 程式自動修正：語法修正、從任意程式碼接續修改，以及後續路線（2026-11-05）

> 範圍：第一階段（需求→思考→寫程式，見 [DESIGN.fn-template.md](DESIGN.fn-template.md)）之後的「修」。這份文件記錄已經做好的部分、實測數字與限制，以及使用者依序提出、**還沒做**的後續步驟（merge diff patcher、處理 merge conflict、行為修正與除錯器、每種語言各自的 CoLU 集合）。
> 狀態標記：「已實作並測試」＝有程式與測試；「評估」＝讀程式或實驗得到的事實；「未做」＝只有設計。

## 零、使用者的要求（原話，依提出順序）

1. 「下一步我也要建立自動修正問題的方法，先從修語法錯誤開始，他要從語法錯誤來找到當下的語法單元，再當下的錯誤位置選擇出當下位置最適合的token組合」
2. 「這個修正問題的方法要有能力做到edit code，從任意拿到的code來接續」
3. 「修正問題的方法完成的下一步是merge diff patcher，用現有的patch評估怎麼合併進去」
4. 「要有能力處理merge conflict」
5. 「patch修正器完成的下一步是程式行為的修正，要學會插入debug code來蒐集證據，取得執行的中間結果，也要有能力跑debugger」
6. 「我覺得不同語言要有不同的CoLU集合」

1、2 已實作；3～6 是路線圖，本文第四節只做評估與設計，**沒有實作**。

## 一、語法修正（已實作並測試）

`renderer/src/recipe/syntax_fix_core.js`（`FaSyntaxFix`，純函式；檢查器與模型都是注入的）。從「編譯器／直譯器說哪裡有語法錯誤」開始，到「選出該位置最適合的 token 編輯」：

| 步驟 | 做法 |
|---|---|
| 1. 取得錯誤 | `check(source)` 回 `CE` 與訊息；`parseErrors` 解出第一個錯誤的行、欄（python、node、gcc／g++、javac、mcs、ruby、perl、bash 各自的訊息格式，用真的編譯器產生的訊息測過） |
| 2. 找語法單元 | `lex` 把程式切 token（字串、註解、C 前處理行、Python 縮排與三引號、未結束的字串）；`unitOf` 回「錯誤所在的敘述＋前一條」（缺分號常在下一行才報錯；`for(;;)` 括號內的 `;` 不切） |
| 3. 產生候選 | 在錯誤位置附近（緊貼前一個 token 後面、上一行行尾、錯誤 token 前後、這行行尾、敘述結尾、檔尾）產生**極小的 token 編輯**：依括號堆疊補對的收括號、補 `;` `:` `,` `end` `fi` `done` `then` `do`、補字串引號、`=`→`==`、Python 補 `pass`／調縮排、刪掉多餘的標點、補開括號 |
| 4. 真的檢查器驗證 | 每個候選都交給 `check`：整個通過最好；沒通過的看「第一個錯誤有沒有往後移」（有進展）。排序：通過 > 進展 > 編輯成本。批次並行（預設 4）、有檢查次數上限 |
| 5. 選擇題 | 並列（結果同樣好、成本接近）時用選擇題讓模型挑（`ask` 沒給或問不出來就選成本最低的）；挑選記在 `choices`，誰挑的（model／program）看得到 |
| 6. 多輪 | 套用後重複，最多 4 輪（一份程式常常不只一個錯） |
| 7. 語意驗證（選用） | `verify`：在「都能通過語法」的候選裡用測試（例如判題器 AC）挑。純語法檢查會接受語意錯的修法（見下） |

只改必要的 token：縮排、CRLF、註解完全保留；回傳結構化 `edits`（行、欄、原文、新文、說明、對應的編譯器訊息）與統一格式的 `diff`。支援 python、nodejs、c、cpp、java、csharp、perl、ruby、bash；組語沒有候選（回 `unsupported_lang`）。

**刪除是破壞性的**：實驗發現「刪掉字串 `"%lld %lld"`」讓 `scanf( &a, &b)` 通過編譯、「刪掉 `)`」讓 `printa + b` 通過編譯——語法對、語意錯。所以只允許刪標點（不刪字串、數字、識別字），成本也調高。

### 選 token 時要看語意（2026-11-05 使用者校正）

使用者原話：「語法對，語意錯。那為什麼遇到compilation error?這就不算語法對」「所以他在挑，在選擇token跟組合進去時，應該要從思考堆疊與自己的樹中去評估語意」。

**術語更正**：`check` 通過＝編譯器／解析器接受。編譯型語言（C、Java、C#）的編譯器除了語法還做名稱解析與型別檢查，所以那些語言的 CE 本來就含一部分語意；解釋型語言只解析，`printa + b` 要到執行時才 NameError。編譯器**不知道作者的意圖**：`int mainvoid()` 是合法宣告、`scanf( &a, &b)` 能編譯。所以選候選時不能只看「編譯器接受」。

**做法**：對每個候選比較「套用前後的語意問題集合」，新引入的問題扣分、解決掉的問題加分（×0.5），併入候選的**有效成本**（排序、並列判斷都用有效成本）：

| 語意問題 | 說明 | 權重 |
|---|---|---|
| `glue` 識別字黏合 | 沒定義過、只出現一次、能拆成兩個已知的詞（`printa`＝`print`＋`a`、`mainvoid`＝`main`＋`void`）——刪掉了中間的符號 | 3 |
| `arity` 引數個數 | 呼叫已知簽名的函式，引數個數不符（簽名來自同一份程式、或外部注入） | 2.5 |
| `format_count`／`format_missing` | C／C++ 的 `printf`／`scanf` 家族：格式字串的轉換說明個數與引數個數不符，或第一個引數不是字串 | 2.5 |
| `unknown_call` | 呼叫沒定義的名稱——**只在解釋型語言查**（編譯型語言的編譯器會報，不重複） | 0.8 |

候選生成也看語意：發現識別字黏合時，會產生「在拆點補回 `(` 或空白」的候選（只有語意分析看得出來，編譯器看到的只是一個陌生的名字）。

**語意來自設計樹與思考堆疊**（`semantic: {symbols, hints}`、`wrap`）：
- 寫程式迴圈：計畫的函式簽名（名稱、引數個數）與「函式 sig：用途」的已定決定；
- 專案模式：UML 的類別名、屬性名、方法名與引數個數；
- 任意程式碼（`editCode`）：同一份程式裡的函式定義就是樹；
- 並列時的選擇題附上「已定的設計」與各選項的語意注意事項，並用思考堆疊的 `wrap` 放進焦點標頭（目標、路徑、已定）。

效果（C，真編譯器；同一批刪 token 的壞變體，這次**不再排除**「刪掉後識別字黏合」的變體）：純語法 12/17→語意評分後 13/18 判題 AC，`printa + b)` 修成 `print(a + b)`、`int mainvoid)` 修成 `int main(void)`、`scanf("%lld %lld" &a, &b)` 補逗號而不是刪字串。語意分析是**手寫的啟發式**（識別字黏合、引數個數、printf 格式），不是完整的型別系統，抓得到的只是這幾類。

### 判題器對解釋型語言的修正

解釋型語言的語法錯誤是**啟動時**才報的，原本被歸成 `RE`，迴圈裡「CE → 先讓程式修語法」對 python／nodejs／ruby／perl／bash 永遠不會觸發。現在判題器的 `startupSyntaxError` 識別「解析階段」的格式並歸成 `CE`（帶訊息）；執行期才丟出的例外（`ZeroDivisionError`、`eval("1+")` 丟的 `SyntaxError`、非 0 結束碼）仍是 `RE`。

### 實測數字（`syntax-fix.test.js`，真的編譯器）

評估方法：對每種語言的 A+B 參考解，一次刪掉一個結構性 token（`; ( ) [ ] { } : , end fi done then do`），排除「刪掉後前後識別字黏成一個詞」的變體（那不是典型的 token 缺失，也修不回來），拿剩下的壞變體跑修正。

| 語言 | 壞掉的變體 | 修到能編譯 | 純語法修完判題 AC | 用測試挑後 AC | 平均編譯檢查次數 |
|---|---|---|---|---|---|
| python | 10 | 10 | 6 | 7 | 28.8 |
| nodejs | 16 | 13 | 8 | 8 | 33.6 |
| c | 18 | 18 | 17 | 17 | 25.9 |
| cpp | 9 | 9 | 9 | 9 | 28 |
| java | 21 | 21 | 21 | 21 | 29.6 |
| csharp | 28 | 24 | 23 | 23 | 43 |
| perl | 6 | 3 | 2 | 2 | 10.5 |
| ruby | 2 | 2 | 1 | 1 | 8 |
| bash | 4 | 4 | 2 | 2 | 5.5 |

（2026-11-06 在這台機器上用真的編譯器跑的，**文法驅動候選＋語意排序＋每語言備援詞彙**之後。這一版評估**不再排除**「刪掉後前後識別字黏成一個詞」的變體，所以樣本比舊版更難、更多；舊版（手寫詞彙）的數字：C 15/17 能編譯、12 AC；C++ 7/9、7；Java 15/18、14；C# 17/22、16——變體數不同，只能看趨勢。ruby 只有 2 個變體、bash 4 個，樣本太小，只能當參考；ruby／perl／bash 沒有文法，仍是備援詞彙。這裡的「模型」是不問的（沒給 ask）：由程式選有效成本最低的；有 ask 時改由模型在過濾後的選項裡選。）

**怎麼讀這些數字**：
- 這是「單一 token 缺失」這種最簡單的錯誤，程式只有一兩行，不代表任意語法錯誤都修得好；
- 「修到能編譯」遠高於「修完 AC」：缺 `(` 或 `)` 放進呼叫表達式時，放哪裡要靠語意才知道，純語法檢查給不出答案；有測試的話用 `verify` 挑可以改善，但仍有候選集裡根本沒有正確答案的情況；
- perl 的 `perl -c` 錯誤訊息很少帶位置、錯誤常連鎖，修復率最低；
- 測試門檻只擋「明顯退步」（修復率 ≥ 50%、用測試挑不比純語法差），不是能力宣稱。
- 修復現在由**文法分析驅動**（見 [DESIGN.grammar-guided.md](DESIGN.grammar-guided.md)）：文法算出錯誤位置合法的下一步 → 候選 → 文法預檢 → 語意排序 → 編譯器驗證 → 模型（開思考）做選擇題；紀錄可用 `formatTrace` 看。

## 二、從任意程式碼接續修改（已實作並測試）

`renderer/src/recipe/code_edit_core.js`（`FaCodeEdit`）。拿到一份不知道來歷的程式碼，不需要函式清單、UML 或原本的計畫：

- `splitUnits(lang, source)`：把程式切成函式（方法）單元，範圍用 offset。python（縮排＋裝飾器＋標頭缺冒號的壞程式也不會崩）、c／c++／java／c#／nodejs（`{` 前是 `)` 當函式標誌，java／c# 看類別裡面）、ruby（`def…end` 計數）、perl（`sub`）、bash（`name() {`）。原樣放回去位元組不變（測試驗證）。
- `editCode({source, lang, problem?, check, judge?, ask?, write?, repair?})`：
  1. 先修語法（`repairSyntax`；有測試時用測試挑）。修不好且有 `write`：讓模型只重寫「出錯所在的單元」（帶編譯訊息）；
  2. 有測試：判題 → 沒過 → 選擇題挑單元 → 帶回饋重寫**那一個**函式 → 拼回去（python／ruby 重新對齊縮排）→ 再修語法 → 再判題，最多 `maxRethink` 次；
  3. 其餘位元組不變；結果有 `diff`、`edits`（`by: syntax | rewrite`）、`units`；沒有測試就誠實標 `verified:false`。
- `FaCodeAgent.runCode({source, …})` 就是這個入口；語言沒說時用 `detectLangFromCode` 從程式碼猜（猜不出來回 `null`，不亂猜）。
- 迴圈（`code_loop_core`、`code_project_core`）在 `CE` 時也先呼叫 `repair`（程式修、不花模型呼叫），修補用 `patchCodes` 對應回函式／類別的程式碼，之後重新組裝才不會把修補弄丟；對應不回去就記 gap。

## 三、驗證與限制

- 已跑：`syntax-fix.test.js`、`code-edit.test.js`、`code-loop.test.js`、`judge-runner.test.js`、`renderer/src/recipe/*.test.js`；真的編譯器與判題器，模型是腳本化的假模型。**沒有任何小模型實測**（這台機器沒有模型檔）。
- 判題器仍然**不是安全沙盒**：沒有記憶體上限、沒有檔案與網路隔離。`fix_code` 會在本機編譯並執行使用者給的程式碼，只能用在使用者信任的程式。
- 語法修正的候選是手寫的詞彙（每個語言家族一份），沒有用 grammar 的預測集；複雜的語法錯誤（巨集、模板、跨行字串拼接、heredoc）可能修不好。
- `splitUnits` 是詞法層級的啟發式：C++ 模板與 lambda、Python 的巢狀函式、Ruby 修飾詞 `if` 等邊界情況沒有逐一驗證。
- 宿主接線（`write_code`／`fix_code` 工具、IPC）見下一節的狀態表與 DESIGN.fn-template.md。

## 四、後續路線（使用者依序提出，**未做**）

### 4.1 merge diff patcher（評估＋設計）

使用者要求：「用現有的patch評估怎麼合併進去」。

**現有機制（評估，讀程式與實驗）**

| 位置 | 做了什麼 | 缺什麼 |
|---|---|---|
| `coding-edit.js` `applyEdits` | 「找這段、換成那段」：exact → 忽略行尾空白 → 忽略縮排，唯一才改、all-or-nothing、找不到回最接近的實際內容；`unifiedDiff`（自己的 LCS）產生標準 diff | 不吃 unified diff；沒有「位置位移」的概念（靠內容找，不靠行號）；沒有三方合併 |
| `main.js` `fa:git:applyPatch`、`coding-tools.js` | `git apply --check` 乾跑通過才套用；失敗整份不動 | **不模糊套用**（實測：在 hunk 中間插入一個函式讓 context 不連續，整份失敗）、不做 3-way、失敗只回 stderr |
| `coding-workspace.js` | 暫存工作區＋manifest 記原檔 hash；deploy 時 hash 不同＝檔案層級衝突，不覆蓋（`force` 才覆蓋） | 只有檔案層級，沒有 hunk／行層級 |
| `git apply --3way`（實驗） | base blob 在物件庫時可三方合併 | 需要 repo 索引裡有 base；結果留衝突標記、工作區進入 `UU` 狀態 |
| `git merge-file --diff3`（實驗） | 純三方合併（不需 repo），改動互不重疊時**完全正確**（實測：ours 在別處插函式＋theirs 改一行 → 乾淨合併） | **真衝突時衝突區塊太寬**：實測 ours 改 `mul` 的那一行、旁邊另外新增了一個 `sub` 函式，標記把無關的 `sub` 整個吞進 `<<<<<<<` 區塊；沒有語法單元的概念 |

**實作狀態（2026-11-08，已實作並測試；第 1～4 點與第 5 點的「合併後驗證」做了，「接進 `editCode`」未做）**

檔案：`renderer/src/recipe/code_patch_core.js`（`FaCodePatch`，純函式 UMD）、測試 `renderer/src/recipe/code_patch.test.js`（64 項，已登記到 `scripts/run-core-tests.js`）、產品入口 `merge_patch` 工具＋`_codePatch`（`floating-assistant.js`）、真 Electron 評估 `scripts/eval/code_patch.eval.js`（用 `node scripts/eval/code_patch.run.js` 啟動）。

- **解析**：`parseDiff` 容忍 CRLF、標頭行數寫錯（用實際內容重算並警告）、沒有檔頭、`@@` 沒數字、程式碼圍欄、`\ No newline at end of file`；二進位（NUL、`GIT binary patch`）與超大（>2 MB、>6 萬行）直接拒絕。
- **策略鏈**（每個 hunk 的結果不靜默：`applied｜relocated｜fuzzy｜unit｜merged｜already｜conflict｜ambiguous｜failed`，附行號與位移）：原位置精確 → 全檔唯一精確（行號位移，位移會帶給下一個 hunk）→ 忽略空白（python 另要求相對縮排一致，整段縮排位移時新增的行會跟著對齊）→ 已套用過偵測（連使用者改過脈絡也認得）→ 去掉兩端 1～2 行脈絡 → 函式邊界（`splitUnits` 找到函式，函式內用「只出現一次的行」當錨點）＋三方合併（base＝hunk 舊側、theirs＝新側、ours＝目前那一區，保留使用者的修改）→ 衝突。重複片段有歧義時**不猜**：有檢查器／判題器就逐一候選驗證，恰好一個通過才採用，否則拒絕並列出位置。
- **三方合併**：純 JS 的 diff3（Myers 最長共同子序列＋git 的「相鄰衝突合併」「兩側再精修」規則）。對照 `git merge-file`（本機 git 2.29）：手選 14 組逐字一致；固定種子隨機 400 組（基底每行不同）×（預設樣式、`--diff3` 樣式）＝800 組**全部逐字一致**；基底大量重複行時（Myers 有多個等價解）400 組只有 379 組衝突與否一致、356 組逐字一致，git 判乾淨的 248 組中 233 組一致——**重複行很多時和 git 會分歧**，所以產品路徑只用在「錨點唯一」的區域，且合併結果一律再過語法＋判題。
- **驗證與回滾**：合併後先 `check`（語法），有 tests 再 `judge`（沙盒），任何一步不過、或有 hunk 衝突／找不到／有歧義，整份不動（`rolledBack:true`，`source` 仍是原程式），`reason` 寫原因。全部或全不；多檔 `applyPatchFiles` 任一檔失敗整批回滾。沒有檢查器就誠實標 `verified:false`（`requireVerify` 可改成拒絕）。
- **每個語言各自一份**：`PROFILES`（python、nodejs、c、cpp、java、csharp、ruby、perl、bash）各有「縮排是否有意義」「函式標頭怎麼認」。函式邊界沿用 `code_edit_core.splitUnits`（各語言各自的切分）。

**實測**：node 單元測試 64 項（真 python 當語法檢查與判題；C 用 gcc；git 對照見上）。**真 Electron**（獨立 `--user-data-dir`、換埠 17987、`FA_DISABLE_MAIN_OVERLAY=1`，載入的是工作目錄的 `renderer/floating-assistant.js`，語言用 nodejs，因為這台 Windows 的判題器找不到 python3）：使用者編輯過的程式（上面加註解與函式、脈絡行加註解）＋修補 → `fuzzy@11+7` 合併、語法通過、判題 AC、使用者修改全保留；語法壞的修補回滾（語法檢查沒過，附錯誤行）；答案錯的修補回滾（WA，附「合併前是 AC」）；與使用者同一行都改 → conflict 回滾；已套用的修補再套 → `already_applied` 且沒動；`merge_patch` 工具入口 `merged`。

**限制／待改善**：函式邊界用詞法切分，沒用 tree-sitter 語法樹；hunk 必須由上而下依序；衝突只回報（附雙方版本）不自動解（那是 4.2：縮小衝突、候選＋驗證）；「接進 `editCode`」（patch 當候選編輯）沒做；判題器不是安全沙盒；python 這台機器上的真 Electron 判題跑不了（找不到 python3），python 只有 node 測試覆蓋；hunk 順序顛倒的 diff 會失敗；一致性只在給的測資上驗證。

**第二批（2026-11-08，測試 `code_patch_repair.test.js` 97 項）**

- **4.2 衝突階梯**（`conflictCandidates`）：縮小衝突（相鄰但不重疊的改動分開合併）→ 詞元層級合併（同一行兩邊改不同的詞）→ 兩邊插同一處的兩種順序（要有判題器）。每個候選都過語法檢查與判題，成本最低者採用；成本相同且都通過時，有 `ask` 就問一次，否則程式選並寫進 `gaps`、`chosenBy`。刻意不自動取一邊、也不把兩個版本都留下（會留死碼卻騙過測試）；解不開就留標準衝突標記並回滾，`attempts` 列出每個候選為何沒過。
- **亂序片段**：行號不遞減走原路徑；亂序時全檔找、不蓋已套用區域，位移依原始行號位置累計，有脈絡的先、純插入後處理（靠前者校準使用者位移）。
- **語法樹（Python）**：`treeUnits`（巢狀函式、方法、非同步、裝飾器，有 `qual` 路徑）、`treeStrings`（多行字串）。同名函式多個時逐一嘗試、唯一成功才採用；弱證據比對與錨點區域不落在 docstring 內；語法樹有錯誤時退回詞法切分。沒有 `parser` 時行為同第一批（會改到 docstring 範例，測試有記錄）。
- **editCode**：`editCode({patch, patchFile?, parser?})` 先合併修補，通過驗證則 `edits` 加 `by:'patch'`（欄位同單元重寫），沒過回滾並寫 `gaps`，再走原流程；結果附 `patch` 報告。
- 真 Electron（nodejs）重跑 6 個情境，結果與第一批相同；產品內嵌的 `FaCodePatch` 已同步。

**第二批尚缺**：產品端沒傳 `parser`／`patch`；其他語言文法；C++ 模板邊界；重複行很多時衝突候選的品質沒量過。

**原設計（保留供對照）**

1. 解析 unified diff → hunks（舊側、新側、context）。
2. 套用策略鏈，每個 hunk 獨立、結果**不靜默**（`applied｜relocated｜fuzzy｜merged｜conflict`，附位置與理由）：
   - ① 原位置 exact；② 用 context 在檔案內找唯一位置（行號位移）；③ 忽略空白／縮排（沿用 `coding-edit.js` 的 `fuzzyLineMatches`）；④ 用本專案的 `lex` 做 token 層級比對（忽略格式差異）；⑤ 三方合併（base＝hunk 舊側、theirs＝hunk 新側、ours＝目前區域）；⑥ 衝突。
3. 三方合併用純 JS 的 diff3（renderer／網頁版沒有 git），**用 `git merge-file` 當測試對照**（開發環境有 git 2.34）：同樣輸入結果必須一致。
4. 套用結果交給 `check`／`judge` 驗證（沿用語法修正的「真檢查器當裁判」做法）；不過就回報、不自動接受。
5. 接進 `editCode`：patch 也是一種「候選編輯」，與語法修正、單元重寫共用 diff 與 edits 的格式。

### 4.2 處理 merge conflict（設計）

評估的關鍵事實是上面那個：**行層級的三方合併，衝突區塊會吞掉旁邊無關的改動**。設計一條由便宜到貴的階梯，每一階都用真的檢查器／測試當裁判：

1. **無損的先排除**：兩邊改成一樣、只差空白、只有一邊動。
2. **縮小衝突**：用 `lex`／`unitOf` 把衝突區塊切成語法單元（敘述、函式），只留下**真的兩邊都改了同一個單元**的部分，其餘各自合併（修掉上面 `sub` 被吞的問題）。
3. **候選＋驗證**（沿用語法修正的模式）：對每個真衝突產生候選 {ours、theirs、兩者依序都保留、兩者交換順序、取交集}，逐一用 `check`／`judge` 驗證，只留通過的。
4. **並列時選擇題**：通過的候選不只一個時，用選擇題讓模型挑（附兩邊的改動意圖與 diff）；沒有 `ask` 就選成本最低的並標 `chosen_by: program`。
5. **仍解不開**：保留標準衝突標記（`<<<<<<<`／`|||||||`／`=======`／`>>>>>>>`），列出衝突清單與已嘗試的候選，交給使用者；**不假裝解決**。
- 檔案層級衝突（`coding-workspace` 的 hash 不同）維持現狀：不覆蓋、報告、`force` 才覆蓋。

### 4.3 程式行為的修正：插入 debug code 與跑 debugger（設計）

使用者要求：「要學會插入debug code來蒐集證據，取得執行的中間結果，也要有能力跑debugger」。語法錯誤有編譯器告訴我們位置；行為錯誤只有「輸出不對」，要先**蒐集證據**。

**這台機器可用的除錯器（評估，實際檢查過）**：gdb、valgrind、jdb、strace、ltrace、python 的 `pdb`、`node inspect`、perl 內建 `-d`；Ruby 沒有 `rdbg`／debug gem（只有已淘汰的 `-rdebug`）、沒有 lldb。

**設計（未做）**

1. **插探針（instrumentation）**：用 `splitUnits` 與 `lex` 在函式進入／離開、分支、迴圈、被懷疑的敘述前後插入輸出敘述（各語言一份模板，輸出固定標記 `__DBG__ {json}` 到 stderr，避免污染 stdout 的答案）。編輯用 offset，**一定可還原**：探針的 edits 與修復的 edits 分開記，最後驗證時移除；結果程式碼裡不得殘留探針（測試驗證）。
2. **跑並收集**：用判題器的執行器跑失敗的那筆測試，收集 `__DBG__` 行，與期望輸出比對，找出「第一個偏離的位置」，把證據（變數值、分支走向）做成給模型的精簡回饋（不洩漏 hidden 測試的內容，沿用現有規則）。
3. **假說循環**：模型看證據 → 提出假說（選擇題：哪個函式、哪個變數）→ 再插更窄的探針或直接修 → 驗證。次數與呼叫有上限。
4. **除錯器**：gdb（`-batch -ex`，C／C++）、`python -m pdb` 與 `-c` 指令（Python）、`jdb`（Java）、`node inspect`（Node）、`perl -d`（Perl）。以子行程＋指令腳本驅動、擷取輸出、設逾時與輸出上限；沒有除錯器的語言（ruby、bash、c#）退回探針。
5. **風險**：除錯器與探針都會**執行**程式；與判題器一樣沒有隔離，且除錯器可以在被除錯程式裡執行任意指令。要走桌面版既有的「有副作用工具要使用者同意」，並在說明中誠實標示。

### 4.4 每種語言各自的 CoLU 集合（設計）

使用者要求：「我覺得不同語言要有不同的CoLU集合」。

**現況（評估）**：已經按語言分的有——判題器的編譯／執行／檢查命令（`judge-runner.js` `LANGS`）、寫程式的語言規則與入口慣例（`code_loop_core.js` `LANGS`）、專案模式的類別規則（`code_project_core.js` `PLANGS`）、語法修正的候選詞彙（按語言家族）、單元切分（`splitUnits`）。**沒有按語言分的**是 CoLU 本體（`plan_core.js` 的 `CAPS` 能力表、`GOALS`、`FAILURE_RULES` 決策樹）：目前一份全域表。

**設計（未做）**：
- `plan_core` 的 `CAPS`／`GOALS`／`FAILURE_RULES` 各項加選用欄位 `langs: [...]`（沒寫＝所有語言）；`buildPlan` 與 `advance` 接受 `lang`，只看適用的項。語言由 `detectLang`／`detectLangFromCode` 或使用者指定。
- 每種語言一份「CoLU 集合」資料（資料不是程式）：可用的檢查／除錯／格式化工具（python：`py_compile`、`pdb`；c／c++：`gcc -fsyntax-only`、`gdb`、`valgrind`；java：`javac`、`jdb`…）、典型失敗與該怎麼決策（例如 C 的 `RE` 先 `valgrind`／`gdb`，Python 的 `RE` 先看 traceback 的行；Java 的 CE 看缺 import）、寫程式與修正時的語言規則。
- 缺的語言／工具走既有的 UNAVAILABLE 路線：誠實說這台機器沒有，不假裝。
- 測試：同一個目標在不同語言得到不同的計畫（例如「修好這份程式」在 C 的計畫含 valgrind 步驟、在 Python 沒有）；沒有適用項時退回通用集合。

### 4.2 接進產品（2026-11-08）

- `merge_patch` 工具（`_codePatch`）在 Python 時載入內建語法樹剖析器（`_codePatchParser`，沿用離線寫程式的 Python 剖析器）傳給 `applyPatch`；載入失敗就退回詞法切分。
- `write_code`／`fix_code` 的入口（`_codeAgent`）新增 `patch` 參數（相容 `diff`）：有 `source` 時把 `patch`、`patchFile`、剖析器一起傳給 `runCode` → `editCode`（`code_agent_core.runCode0` 已轉傳）。
- 真 Electron 驗證（`scripts/eval/code_patch_parser.eval.js`，用 `node scripts/eval/real_electron.run.js code_patch_parser` 跑）：docstring 裡有一模一樣範例碼、使用者改過真正函式時寧可回滾，範例不動；只有行號位移時只改一處且測資 AC；對照沒有剖析器時會改到 docstring；`merge_patch` 工具入口與 `_codeAgent` 帶 patch 都成功。
- 限制不變：語法樹只有 Python；其他語言文法需下載，待使用者同意。

### 4.5 建議的實作順序

1. merge diff patcher（4.1）：最小可行＝unified diff 解析＋策略鏈 ①②③＋`git merge-file` 對照測試的 diff3。
2. 衝突處理（4.2）：先做「縮小衝突」（語法單元切分已有），再做候選＋驗證。
3. 每語言 CoLU 集合（4.4）：資料表＋`langs` 篩選；可以和 1、2 平行。
4. 行為修正（4.3）：探針先於除錯器（探針只需要執行器，不需要額外工具）；除錯器最後，且要先決定安全邊界。
