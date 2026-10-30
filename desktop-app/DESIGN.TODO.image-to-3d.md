# 交接文件：`/image-to-3d`（離線模型、物件封閉，handoff 3，2026-10-30）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.image-to-3d.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要再做規劃、不要再問，直接寫程式、測試、提交。不發布（使用者沒說發布）。**

使用者的關鍵指示（逐字）：「JUST DO IT!」「不要再繼續plan了, fuck」「原本的decompose redraw已經是浮雕  請不要又推翻我現在的要求!我已經受夠了浮雕」。

## 2. 概況
- 分支 `desktop-app`，目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。規格在 `DESIGN.image-to-3d.md`（別改方向）。舊進度說明在本檔下方「附：先前進度」。
- 已提交：核心 `renderer/src/media/image3d_core.js`（柱體／方塊封閉殼、isClosed、背景補洞、buildScene、prepareInput、labelsFromMasks、diffMask 背景差分、parseOptions、toSpec 含貼圖座標、**buildPanorama／bendCylinder／readExif／orbitKind**）＋測試 `scripts/media-tests/image3d_core.test.js`（32 項過）；深度模型登錄與 `_depthEstimate`、SlimSAM 登錄與 `_segmentObjects`（`renderer/src/vlm/vlm_core.js` ＋ `floating-assistant.js` 工作執行緒）；`/image-to-3d`、`image_to_3d`（`renderer/src/edit/edit3d_host.js`，預設貼材質）；清冊；嵌入腳本。最近提交 ec530e68（貼材質）。
- **未提交**：`vlm_core.js` 的深度模型 CPU dtype 改 fp32（下面第 2 項實驗發現）與重新嵌入的 `floating-assistant.js`；接手第一件事先 `node scripts/embed-code-ui.js`、跑測試、`node build-assistant.js`、提交。

## 3. Todo（handoff 2 全部做完，2026-10-30）

### 新增（handoff 3，2026-10-30，**先做這一項**，發布在完成後直接做，使用者已授權）
**A. 「只要主體」的選用參數**：`image-to-3d`（斜線指令與工具）、`edit-3d-model`、`edit-game-3d` 都要支援。例子：照片是一個咖啡杯放在桌上，使用者說要把咖啡杯擺到桌子模組上，只要一個咖啡杯，不要桌子、背景。
1. 純函式核心 `renderer/src/media/image3d_core.js`：`parseOptions` 增加主體選項（例如 `subject:'main'|'all'`，斜線參數 `--subject main`）；**從使用者的話判斷**：「只要／只想要／只放／把某某擺到…上」＋名詞＝只要那個主體；名詞若能從話裡取出（咖啡杯），就用它當主體名稱。程式先解析（中文關鍵字、「把…擺到／放到…」句型），解析不出再用封閉式選擇題問模型，答案由程式核對。預設不變（所有物件）。
2. 主體怎麼選：分出物件後，若有主體名稱，用視覺模型對每個物件的裁切圖做封閉選擇題（A 是／B 不是），程式核對；沒有名稱就選「最大且最靠中間的物件」。只保留主體，背景與其他物件丟掉（主體被切走的地方不必補背景）。主體仍然是封閉立體（柱體或方塊殼，不是浮雕）。
3. 接進 `edit-3d-model`／`edit-game-3d` 的 AI 工具與貼圖流程（`renderer/src/edit/edit3d_host.js`；遊戲 3D 的對應處自己找 `renderer/src/game/`）：使用者貼圖＋話裡有「只要主體」意思時，自動帶 `subject`；輸出一個物件（不是群組＋背景），可直接擺到場景裡的桌子等物件上（底面貼地／貼在目標物件頂面，沿用既有 `place`）。
4. 補核心測試（`scripts/media-tests/image3d_core.test.js`）與主機端模擬測試、功能清冊（`node scripts/ai-features.js check`）、`node scripts/embed-code-ui.js && node build-assistant.js`。
5. 完成、測試全過、提交後**直接發布**（使用者說過完成就可以更新網頁、發布 patch）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再用 curl 查遠端 `manifest.v2.json` 版本。
注意：工作樹有一個不是你改的未提交檔 `skills/image-decompose-redraw/data/parts_builtin.json`，不要把它放進提交，也不要還原。

### 先前項目（handoff 2 之前，已完成並發布 v212）
全部完成並提交（9f0bb01f smooth 殼、b9420411 SlimSAM 實測、fa09b044 全景接主機端＋測試清單）。**沒有待辦了，不要再交接。**
- smooth 殼：`shape:'smooth'`，auto 優先用；測試 37 項過。
- SlimSAM：瀏覽器（CPU、q8）實測載入約 6 秒、編碼約 16 秒、16 點約 28 秒；合成圖分出 3 個物件（蘋果、盒子、地面）。背景大遮罩（>50% 圖面）預設丟掉（maxAreaFrac 0.5）。
- 全景：`/image-to-3d --panorama`、單張寬高比 ≥2、多張 EXIF 方向（`_i3dPanoPlan`、`_imageToPanorama`）。

### 追加（來自上層工作階段，2026-10-30）已做
- 使用者原話（逐字，2026-10-30）：「這個功能如果跟我們的edit-3d-model, edit-game-3d 也不錯吧? 這樣就可以把之前編輯期間提到 "不認識的物件->上網找OBJ->上網找圖片->轉3D物件 " 有更穩定的結合方式」
- ① edit-3d-model：貼圖＋「把這張圖變成 3D 物件」→ `_i3dAttachedEdits`（edit3d_host.js）直接用離線管線做封閉物件放進場景。**edit-game-3d 還沒接**（它走遊戲編輯器自己的 host，不經 `_subjResolve`）。
- ② 找圖那一階 `_subjImage3d` 先試 `_i3dSubjectSolid`（每個物件封閉），失敗才退回舊浮雕（結果註明）；`subjectMesh` 核心有測試。
- ③ 新舊並排品質比較**沒做**（舊做法在 Pyodide 裡跑，沒在這裡驗證）；新做法失敗會自動退回舊的，所以不會比以前更糟，但品質是否更好未實測。
- ④ 清冊、測試已補。

### 真實 App 還沒驗證
設定頁卡片顯示、兩張圖貼上時的指令分流、全景在真實 App 的完整流程（核心有單元測試，主機端 `_imageToPanorama` 沒跑過）、`inward` 轉圈照片只用第一張、GPU（fp16）路徑（深度與 SlimSAM）、SlimSAM 在 App 工作執行緒的 `sam` 分支（實驗頁照同流程驗證過）、VR 頭戴裝置觀看、在編輯器真的開啟 smooth 殼的外觀。發布未做。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組，再 `node scripts/embed-code-ui.js`；不要改嵌入後那份（`floating-assistant.js` 裡嵌入的區塊）。工作執行緒 `faVlmWorkerMain` 與 `_depthEstimate`／`_segmentObjects` 只存在於 `renderer/src/floating-assistant.js` 本身，可直接改。
- **Bash 裡的 Python heredoc 會吃掉反斜線**（`\n` 變真換行、`\b` 消失）：需要寫反斜線或含正規表達式／字串換行的程式時，用 Write 工具寫 `.py` 再執行，或用 Edit 工具。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問。
- 熱更新名單別擴大；不要要求使用者重裝；push 到自己 remote 可以，deploy／發布要使用者當輪說。
- 提交訊息結尾加 `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`。
- 這台 Windows 的 Node 沒有 `node:sqlite`。

## 5. 使用者原話（逐字）
- 2026-10-29：「幫我評估實現image to 3d使用離線模型的方式，來服務image to 3d的需求，使用onnx的unik3d，要在media裡面」
- 2026-10-29：「如果unik3d可行，image decompose redraw就可以改成把pipeline專攻image to svg跟多圖層 然後上述的就改成slashcommand image-to-3d」
- 2026-10-29：「雲端精煉我們可以用我們自己的長時間的處理，像是編輯器跟 save case, 變成offline trainer。那先以混合架構為主，而如果是從 vlm得知那是一張景物照片，可以做一個unik3d的處理，我們不內建，只使用他的模型，而單機可以從media offline model去手動下載」
- 2026-10-29：「或者這邊要有選擇，人臉，或個別物件，都要用物件自己的邊界去封閉，封閉的時候，弄成像是cylinder或樂高的方形來封閉，再去細切，或者使用者在要求裡面就是物件要封閉，那就物件統一都要封閉，例如分出一個東西是背景，那些地方是一團物件，例如場景中的一顆蘋果，那蘋果應該要封閉」
- 2026-10-29：「原本的decompose redraw已經是浮雕  請不要又推翻我現在的要求!我已經受夠了浮雕」
- 2026-10-29：「JUST DO IT!」「不要再繼續plan了, fuck」
- 2026-10-30：「可以加上背景差分法來取出背景」
- 2026-10-30：「另外是如果使用者提供多張照片裡面有地理資訊，明顯是轉圈，或一張全景照片，可以實現成一個類似遠景近景的模型，可以做成類似vr能用的」
- 2026-10-30：「可以試著用離線的image generation / diffusion生一張圖，或從svg->png->3D來實驗，我要看一下效果」
- 2026-10-30：「可以轉換好後，用three.js 然後幫貼材質?」

- 「image-to-3d 在edit-3d-model, edit-game-3d或image-to-3d要可以支援optional參數，是只放主體，例如把一個咖啡杯的照片要擺到桌子模組上，想得到一個咖啡杯，要可以從prompt知道使用者只是想要咖啡杯」（2026-10-30）
- 「完成就可以更新網頁，發布patch」（2026-10-30）
- 「這個功能如果跟我們的edit-3d-model, edit-game-3d 也不錯吧? 這樣就可以把之前編輯期間提到 "不認識的物件->上網找OBJ->上網找圖片->轉3D物件 " 有更穩定的結合方式」（2026-10-30，已完成）

## 6. 實驗頁（給接手者）
- `C:\Users\sunneo\AppData\Local\Temp\claude\D--Downloads-videos-----desktop-app\acde8070-44bc-47ee-a80b-a3a0c379809e\scratchpad\exp\index.html`（同資料夾有 `image3d_core.js`、`subject_3d.js` 的複本，改核心後要重新複製）。用 `python -m http.server 8765 --bind 127.0.0.1` 在該資料夾開（可能已經死了，重開），再用內建瀏覽器開新分頁（不要用已顯示本機檔案的分頁）看 `http://127.0.0.1:8765/index.html?v=N`。流程：SVG→PNG→真的深度模型（fp32、CPU，transformers.js 3.7.5）→去背→`FaImage3d`→three.js 貼材質旋轉預覽。
- 2026-10-30 實測結果：深度模型載入約 2 秒、估計約 8～10 秒（512×384）、深度圖品質很好（蘋果球、盒子、地面都對）；全部物件封閉＝true；**但**只分出 1 個物件（去背把地面橢圓連在一起）、柱體殼前表面有細長條紋（Todo 1、2 要解決）；貼材質正確（正面像原圖，側面是邊緣顏色拉伸）。
- 沒做：用離線擴散模型生圖（這台沒有可用的離線圖像生成管線可以在此快速驗證，改用 SVG→PNG 代替）。

## 7. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。Todo 清空就不要再交接，直接回報完成。

## 8. 陷阱
- 不要把底層做成「前表面網格再補背面」（浮雕）。
- 單張圖看不到背面：背面依輪廓推測，輸出要寫明。
- int8／uint8／quantized 的深度模型在 CPU（WebAssembly）跑不起來（缺 ConvInteger）；fp32 可用。
- 去背（`bgMask`）會把地面陰影、桌面連成一塊；要分物件請用 `--segment` 或背景差分。
- `scripts/embed-code-ui.js` 會重寫 `floating-assistant.js`；提交前看 `git diff --stat`。
- 內建瀏覽器分頁若顯示的是「本機檔案」，頁面工具不能用，要開新分頁。
- UniK3D 只有自備匯出說明，推論沒接（CC BY-NC，不內建）。

## 附：先前進度
- handoff 1 結果：Todo 1～4、6 完成（78ed8270、af19d6ed、ebbae2d8、c299ac6c、62299721）；第二輪加 SlimSAM、`--segment`、背景差分、UniK3D 說明（4e292b25）；全景核心（48dbb22c）；貼材質（ec530e68）。
- 真實 App 還沒驗證：設定頁卡片顯示、兩張圖貼上時的指令分流、GPU（fp16）路徑、SlimSAM 流程（Todo 2 會測）、在編輯器真的開啟。發布未做。
