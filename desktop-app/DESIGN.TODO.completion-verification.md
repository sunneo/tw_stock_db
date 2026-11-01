# 交接文件：補完與真實驗證（跨工作線，handoff 1，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.completion-verification.md`. 先完整讀完（含使用者原話與做法備忘），照做。工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。**開工前先確認音樂線的工作階段（「音樂領域 · handoff N」）沒有在跑，同一個工作樹同時只能有一個寫手；它在跑就先只讀不寫，回報後等管理層指示。** 第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。不要長篇規劃、不要問，直接查證、寫程式、測試、提交。發布由管理層代發：你不要執行發布腳本，每項提交後在回報最後一行寫「第 N 項已提交，可發布，commit <hash>」。到 context 門檻（30%）時更新本文件、提交，回報最後一行寫「需要接手，文件已更新，commit <hash>」（子工作階段在這個 app 不能自己啟動接手）。

## 2. 概況
各工作線做完後留下的「沒驗證」與「沒做」，整理成一份。每項都附證據位置，接手前先自己核對是否仍然成立（有些文件已過時）。

## 3. Todo（依序）
1. **AIDoc 除錯定位器：把 ELF 接進主機端並驗證**。`renderer/src/aidoc/elf.js`（`FaAidocElf`）是純函式模組：靜態讀 ELF 檔（符號表找函式、DWARF `.debug_line` 找檔名行號、build-id 比對版本），**不執行程式**，用 `File`／`Blob` 切片讀取。要做：① `/aidoc locate --elf <檔案>`（桌面版給路徑，網頁版選檔）與 `repo_ask` 的 `locate` 動作加 `elf`／`base`／`module` 參數，呼叫 `parseModuleFrames`／`resolveFrames`／`applyToFrames`，結果進定位報告（`reportLines`），build-id 不符要明講；② 驗證：這台是 Windows、沒有 gcc／addr2line，測試用**預先編好、提交進 repo 的小型 ELF 檔案（含除錯資訊）當夾具**，位址與預期的函式／檔案:行寫死在測試裡（可在 Linux 或 WSL 編一次；沒有就找現成小型 ELF 範例並註明來源與授權），`scripts/aidoc-tests/elf.test.js` 在 node 直接跑；③ 參考 `D:\Downloads\redmine_ai_chat` 的 `ai_chat_aidoc.js` 的 `locate`（765–945 行，**只讀不改 Redmine 資料夾**）。
2. **AIDoc 其他未驗證**：主機端 `_repoLocate`、檢視器端到端、`log_triage` 工具在桌面版實跑；測試版驗證（`scratchpad/el_test/deploy3.sh` 那套，若不存在就用 Electron 當 Node 跑自己寫的小驗證腳本）。結果寫進 `DESIGN.TODO.aidoc-locator-port.md` 的「未驗證」那段並更新。
3. **image-to-3d 真實驗證與殘留**：`DESIGN.TODO.image-to-3d.md` 列的「真實 App 還沒驗證」：設定頁卡片顯示、兩張圖貼上時的指令分流、GPU（fp16）路徑、SlimSAM 流程、編輯器真的開啟；新舊並排品質比較（舊的 image-decompose-redraw 充氣 vs 新的封閉立體，同一批圖）；第 33 行「edit-game-3d 還沒接」**已過時**（`e28dc585` 已接，見 `renderer/src/game/game_host.js` 約 110–120 行），把文件改正。用內建瀏覽器或 Electron 實跑，附截圖或數字。
4. **網頁版延遲載入第二階段**：核心 `web-lazy/core.js` 約 5.1 MB，非嵌入部分約 445 萬字元仍大。先用內建瀏覽器量**真實開頁**的下載量與解析時間（改前基準在 `DESIGN.lazy-loading.md`，改後沒量過），寫進文件；再盤點核心裡還能拆的大塊（聊天主程式以外的零碎工具），依「開頁一定碰到／只有某指令才用」分類，一批一批拆，規則同 `DESIGN.TODO.lazy-loading.md`（stub＋動態載入、每個新區塊檔都進 manifest、零功能退步、入口測試不得有新增失敗）。`DESIGN.TODO.lazy-loading.md` 第 32 行「沒有任何程式碼改動」已過時，改正。
5. **改圖（edit-picture）殘留**：使用者 2026-11-01 說 sd-turbo 已 drop（授權），確認屬實（`8f0e7490`、`fee59ca3` 已移除，只留 SDXS＋TAESD）。要做：① 把殘留的名字清乾淨——`renderer/src/imagegen/sd_turbo_core.js`／`FaSdTurbo`／`scripts/imagegen-tests/sd_turbo.test.js`／兩份 `DESIGN*sdturbo*.md` 改名成不含 sd-turbo 的名字（例如 `local_edit_core.js`／`FaLocalEdit`），同步改嵌入腳本、`run-core-tests.js`、`image_route.js`、`edit_host.js`、`floating-assistant.js` 的所有引用與註解，入口測試必須全過；② 遮罩選取區域改圖是否已完成（文件說「目前整張」，回報說選區重畫 v227 已發布，互相矛盾，讀程式核對）；③ 真實 App 驗證 SDXS＋TAESD 圖生圖（畫質、WebGPU）。
6. **入口測試的不穩定項**：電腦操作遠端協定探測（`scripts/computer-tests/remote.test.js`，RFB 探測）時過時不過；單獨跑探測是通過的（約 730 毫秒，預設等待窗 800 毫秒）。用重複跑 20 次記錄失敗率、在失敗時印出實際回傳值，找出原因（計時、埠重用、假伺服器），修成穩定，再把 `test-reports/known-failures.json` 那筆移除。
7. **工作樹雜物**：`skills/image-decompose-redraw/data/parts_builtin.json`（不知道誰改的，先 `git diff` 看內容，是生成檔就查是哪個腳本產生、是否該提交或加入 `.gitignore`）、`features/FEATURES.md`（清冊產生檔，`node scripts/ai-features.js build` 後若有差異就提交）、`wiki/`（未追蹤，先問管理層，不要刪）。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。**沒驗證就寫「未驗證」，不要寫「應該可以」。**
- 改來源模組，再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。新模組要加進嵌入清單。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 熱更新：舊版也要收得到、不准要求重裝、版本號單調、manifest 清單完整、拆出的檔案都要進 live patch 與網頁版清單。
- 入口測試：`node scripts/run-core-tests.js`，失敗分「新增」與「既有」，只有新增失敗讓它變紅；既有失敗登記在 `test-reports/known-failures.json`。這台 Node 沒有 `fetch`，遠端核對用 curl。
- 工作樹有不是你改的檔案：不要放進你的提交，也不要還原。

## 5. 使用者原話（逐字，2026-11-01）
- 「image-to-3d應該要整合到edit-game-3d」（已整合，見 Todo 3）
- 「aidoc除錯定位器--elf需要直接跑程式嗎，還是只是拿到真實執行檔評判?」→ 答覆：不執行，靜態讀檔；使用者回「好」（同意把 ELF 接進主機端並驗證，Todo 1）
- 「sd-turbo 應該drop掉，我記得我們改用sdsx的vae了」（Todo 5）
- 「我不知道有沒有哪個handoff漏掉?」（本文件就是回答）
- 一貫的態度：「JUST DO IT!」「不要再繼續plan了」。

## 6. 交接流程
同第 1 節：子工作階段不能自己啟動接手；到門檻時更新本文件、提交、回報「需要接手」。

## 7. 陷阱
- `elf.js` 的測試原本靠 Linux 的 gcc／addr2line 產生對照；這台沒有，改用提交進 repo 的夾具，不要依賴本機有沒有編譯器。
- 不要把 Redmine 資料夾（`D:\Downloads\redmine_ai_chat`）改動，只讀。
- 改名（Todo 5）會同時動到嵌入腳本、網頁版區塊、測試與文件，改完必須重跑入口測試、`node scripts/embed-code-ui.js`、`node build-assistant.js`，並確認 `web-lazy/manifest.json` 一致。
- 音樂線的工作階段若正在跑，不要跟它同時改 `renderer/src/floating-assistant.js` 與 `scripts/embed-code-ui.js`。
