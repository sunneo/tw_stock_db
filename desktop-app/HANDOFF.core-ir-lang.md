# HANDOFF：中間語言各語言的「進／出」收尾（項目 7 擴充）

> **2026-11-10 更新（先看這段）**：下面第 3 節的待辦都已完成並提交；現況與驗證結果在 `DESIGN.core-ir.md` 第 11～14 節，剩餘待改善在 `DESIGN.TODO.md`「多語言中間語言與函式行為」。第二輪（2026-11-10）提交：C++ 補 18 個標準操作樣板（`e52d81c93`）、C++／C# 的「進」（`2fc5e32ab`）＋接進產品（`930f338ce`）、Ruby 的「進」（`addf063a0`）、Perl 的「進」自己寫的剖析器（`4696f8dc1`）、沒標型別處理 `needTypes`／`types`（`86b0f5c08`）、`to_uml`（`2804f57ac`）、真 Electron 驗證 `ir_langs.eval.js`（`2a3131c24`）。**都還沒發布**（管理者發布）。接手前的環境更正：這台現在有 Ruby（`J:\Ruby40-x64\bin\ruby.exe`），下面「Ruby 沒環境」的說法已過時；判題器的 C++ 在這台會崩潰（見 DESIGN §14）。改 `floating-assistant.js` 嵌入的模組後要 `node scripts/embed-code-ui.js`；真 Electron 驗證要先 `node build-assistant.js`，驗完還原受追蹤的建置產物（`git checkout -- renderer/floating-assistant.js renderer/floating-assistant.min.js renderer/update-manifest.json web-lazy`，不要提交）。

## 1. 開場提示（接手者收到的原文）

請從這份文件接手（`D:\Downloads\videos-嗨投資-desktop-app\desktop-app\HANDOFF.core-ir-lang.md`）。完整讀完，包括「使用者原話」與「工作方式」，照做。執行 low-context-long-run 技能：做下一個待辦，context 到 30% 就寫下一份交接並啟動自己的接手者。第一則訊息用一行確認你讀了文件、正要開始哪個待辦。

使用者原話（2026-11-08，經管理者轉述）：「the fuck? 我們不是有列出要implement進去?」——項目 7 要整個做完，不是待改善。

## 2. 概況

- 專案 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`，分支 `desktop-app`。管理者 session：`local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5`（回報給它；只有真的卡住才用 SendMessage 問一句）。
- 已提交：`9aa88306`（狀態機圖種、VM 結構化）、`4f1cf6d7`（Linux 行程樹／監聽佇列）、`26d3a129`（nodejs 與 java 的「進」：`renderer/src/ir/ir_in_brace_core.js`＋`ir_in_brace.test.js`，各 10/10 實跑一致）。**都還沒發布**（管理者發布）。
- 現有輸出器：`ir_out_python/js/java/c_core.js`。輸出樣板在 `ir_ops_core.js` 的 `cells`（語言鍵 `py nodejs java c cpp cs rb pl`），輔助函式在其 `HELPERS`（目前只有 nodejs／java／c 的內容）。測試樣本在 `ir_samples.js`，對照方式見 `ir.test.js`（nodejs 走判題器，java／c 直接編譯執行，輸出與 Python 逐行比）。

## 3. 待辦（使用者取消「待改善」退路，全部都要做完；每項各自提交）

本機工具鏈（我查過，證據可引用）：
- **C／C++**：必須用 `J:\msys64\mingw64\bin\gcc.exe`／`g++.exe`，且執行時 `PATH` 要把 `/j/msys64/mingw64/bin` 放最前面（否則 `J:\msys64\usr\bin\gcc` 找不到標頭，編譯失敗；C++ 用錯 DLL 會 segfault）。我已驗證 mingw64 的 gcc 編 `<stdio.h>`、g++ 編 `<iostream>` 並執行成功。**舊交接說「這台缺 C 編譯器標頭」是因為用到 usr\bin 那支**；`ir.test.js` 裡找 gcc 的邏輯要改成優先找 mingw64。
- **C#**：`dotnet` SDK 8.0.302（`C:\Program Files\dotnet`），建專案要 csproj（`net8.0`、`OutputType Exe`、`ImplicitUsings enable`），`dotnet build -nologo` 離線成功（約 20 秒），用 `dotnet bin/Debug/net8.0/<name>.dll` 或 `dotnet run --no-build` 執行。
- **Perl**：`J:\msys64\usr\bin\perl.exe` 可用（5.x）。
- **Ruby**：`where ruby` 沒有（PATH 與 `J:\msys64` 都沒有）→ 只有 ruby 可以標「這台沒環境，未實跑」，要附 `Get-Command ruby` 的輸出當證據；輸出器仍要寫、做靜態檢查。
- 範圍限制：不掃全機、不下載、不用 `find /`。

1. **輸出器＋實跑**：寫 `ir_out_cpp_core.js`、`ir_out_cs_core.js`、`ir_out_perl_core.js`、`ir_out_ruby_core.js`（可仿 `ir_out_js_core.js`／`ir_out_c_core.js`／`ir_out_java_core.js`）；在 `ir_ops_core.js` 補 `HELPERS.cpp/cs/pl/rb`（cells 已引用的 `fa_readLine`、`fa_floordiv`、`fa_mod`、`fa_splitInts`… 要有實作；`HDEPS` 補相依）。對 `ir_samples.js` 的樣本（`langs` 欄加上 cpp／cs／perl／ruby 能翻的）實際編譯／執行，輸出與 Python 逐行一致；也要有「天真對照組」證明樣本測得到語意差異（見 `ir.test.js` 現有寫法）。靜態語言（cpp、cs）遇到 unknown 型別要回報 error。新測試放 `ir_out_more.test.js`（略過條件：該工具鏈不存在時印原因並略過，不算失敗）。
2. **C 的「進」**：文法快取只有 python、javascript、java、cpp、c_sharp、rust，沒有 `tree-sitter-c.wasm`。**不要自己下載**；先試用 cpp 文法剖我們輸出的 C（`long long`、`IL` 結構、`fa_*` 輔助、`static` 函式），讓 `ir_in_brace_core.js` 加 `c` 轉接（`function_definition`／`declaration`／`for`…），Python→IR→C→IR→Python 實跑要與原輸出一致；做不到的構造如實寫進 DESIGN。若確實需要 c 文法再 SendMessage 問管理者放檔。順便補 c++、c#（有文法 cpp、c_sharp）、ruby／perl（沒文法，perl 專案內也沒有 → 如實寫「文法缺，進做不了」並附 `ls` 證據）的「進」能做的做。
3. **接進產品**：`convert_code` 工具要能吃 nodejs／java／c（及 c++、c#，若做了進）來源，轉 IR 再轉任意目標語言（含 cpp／cs／perl／ruby 輸出器）；`behavior_card` 對這些語言可用（來源語言參數放寬、行為分析器的非 Python 路徑沿用現有 `ir_behavior_core.js`）；AI 與 `/code` 都能呼叫（看現有 `convert_code`／`/code` 子指令在 `renderer/src/floating-assistant.js` 的接法：搜 `convert_code`、`behavior_card`、`FaIrIn`、`IRPY` 這類標記）。新的來源模組要登記進 `scripts/embed-code-ui.js` 並在 `floating-assistant.js` 加 BEGIN/END 標記（見 `HANDOFF.blockly-teach.md` §3a 的做法）；**改來源模組再 `node scripts/embed-code-ui.js`，改完立刻 `node --check renderer/src/floating-assistant.js`**。tree-sitter 文法載入沿用 `_behAsset`（`assets-tree-sitter` 分支下載；Node 測試用 `C:\Users\sunneo\.cache\fa-ts`）。
4. 補核心測試並登記 `scripts/run-core-tests.js`（先讀最新內容、只加自己的行；輸出要含 `N passed, M failed`）；更新 `DESIGN.core-ir.md`（第 0、5、11 節與新增節）與 `DESIGN.TODO.md` 最前面清單（做完的移掉）。
5. 最後回報管理者：**每個語言一列的明細表**——輸出器／實跑（通過 N/N 或「這台沒環境」＋證據）／進（通過 N/N 或缺文法證據）／接進產品與否；每項提交 hash；沒驗證的寫清楚。

## 4. 工作方式（使用者規則）

- 繁體中文，簡體字絕對不行；不夾英文縮寫（記憶：純中文回覆）；誠實區分「我驗證的／別人回報的／推測」；沒達標寫「待改善」不是「沒做」，但這次使用者明確要求不可用待改善當退路。
- 只提交自己的檔案，絕不 `git add -A`；工作樹裡 `judge-core.js`、`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/`、`.weak-harness/`、`progress.jsonl`、`../wiki/` 是別人的，不碰。commit 訊息結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 不發布、不動 `update-manifest.json`、不下載、不用 `find /`、不建根目錄 `package.json`／`node_modules`、不自動尋找編譯環境（只查 PATH 與使用者已告知的 `J:\msys64`）。
- **整套核心測試一天只跑一次，由管理者跑**；你只跑自己動到的測試檔加 `node --check`，別讓測試行程掛著。
- 改程式別用 shell 內嵌（heredoc／sed 會吃反斜線與引號）：用 Edit／Write 工具，或先用 Write 寫成腳本檔再執行；通過測試才 commit。做到一半也要先 commit（使用者 build 前會 `git checkout ./`）。
- 工作樹是 CRLF；測試讀原始碼要先統一換行；寫檔時保留原本換行。
- 測試用桌面版要設 `FA_BROWSER_CONTROL_PORT` 換埠，不要佔 17923。
- 環境：`PATH` 含 `D:\Downloads\fa-ts-cache\bin`（真的 python）；C／C++ 見上面的 mingw64 規則。
- 上下文用量到 30% 時照 low-context-long-run 交接（一次只一個接手者）。

## 5. 使用者原話（逐字，附日期）

- 2026-11-08：「接著照順序1,9,11,8,12,13,7...」「測試的時間太長了  接下來可以先把待辦做完再測entry test，一天做一次entry test就好」
- 2026-11-08：「the fuck? 我們不是有列出要implement進去?」（針對「c++、c#、ruby、perl 的實跑樣板沒做，維持待改善。『進』還沒接進產品，convert_code 仍只吃 Python 來源」）
- 管理者轉述的完整指示（2026-11-08）：項目 7 要整個做完，不是待改善；(1) c++、c#、ruby、perl 輸出器與樣板都要「實跑」，輸出與 python 版一致，某語言這台機器真的沒有執行環境才可標「這台沒有環境，未實跑」並附 `where` 輸出；(2) c 的「進」補完；(3) 把「進」接進產品：`convert_code` 吃 nodejs、java、c（以及 c++、c#、ruby、perl 做了進就吃），行為卡 `behavior_card` 對這些語言可用，AI 與 `/code` 都能呼叫；(4) 補測試、登記、更新 `DESIGN.core-ir.md` 與 `DESIGN.TODO.md`；做完回報每個語言「實跑通過／這台沒環境」的明細表，不要只寫總結。

## 6. 交接程序（自我遞迴）

執行 low-context-long-run 技能，THRESHOLD＝30%。每個完成並提交的批次邊界檢查 context（`mcp__ccd_session_mgmt__get_usage`）；到門檻就改寫本文件、commit（訊息寫是交接）、用 `mcp__ccd_session__start_session`（initiation "user_asked"、context "fresh"、同目錄）啟動下一個接手者、等它確認後再 `mark_completed` 並 `archive_session`。待辦清空就不交接，直接回報管理者。

## 7. 陷阱

- `ir_in_brace_core.js` 的樣式比對靠目錄樣板；樣板含 `$*` 或是純 `$0 + $1` 這類純二元運算會被略過（避免誤認）。JS／Java 的 `join` 有歧義（已選數字版）。
- 測試裡 `t()` 的失敗訊息會被截行，除錯時把 slice 放寬。
- tree-sitter-java 新版的 `if`／`while` 條件節點叫 `condition`（已在 `unwrap` 處理）；JS 的 `for` 條件是 `expression_statement`。
- 領域包新增範式：`limit` 要 ≥ 槽位組合總數；產生輸入要讓輸出非空。
- `where gcc` 先找到的是 `J:\msys64\usr\bin\gcc`（沒有標頭），一定要明確用 mingw64 那支。
