# 交接文件：實作 `/image-to-3d`（離線模型、物件封閉，handoff 1，2026-10-29）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.image-to-3d.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要再做規劃、不要再問，直接寫程式、測試、提交。**

使用者的關鍵指示（逐字）：「JUST DO IT!」「不要再繼續plan了, fuck」「原本的decompose redraw已經是浮雕  請不要又推翻我現在的要求!我已經受夠了浮雕」。

## 1.5 進度（handoff 1 的接手結果，2026-10-29）
已完成並提交（78ed8270、af19d6ed、ebbae2d8、c299ac6c、62299721）：Todo 1（核心＋25 項測試）、2（深度模型登錄＋工作執行緒＋`_depthEstimate`）、3 的無新模型版（去背遮罩連通區分物件）、4（`/image-to-3d`、`image_to_3d`，在 `renderer/src/edit/edit3d_host.js`）、6（嵌入 FaImage3d、清冊、重建）。
**未做**：3 的 MobileSAM 分物件、5 的 UniK3D（選用、未驗證）。**未驗證**：真實 App 內下載深度模型、跑一張真圖、在編輯器開啟（只用合成資料在 node 模擬過整條管線，全部封閉、編輯器檢查通過）。發布未做（要使用者說「發布」）。

## 1.6 收尾（2026-10-30，第二輪）
新增：分割模型登錄 `slimsam-77-uniform`（MobileSAM 官方沒有 Transformers.js 轉檔，改用同家族的 SlimSAM，Apache-2.0；工作執行緒 `sam` 架構＋`_segmentObjects`；核心 `labelsFromMasks`；`--segment`）、背景差分（核心 `diffMask`；兩張圖＋「背景差分」或 `--bg`，來自使用者 2026-10-30「可以加上背景差分法來取出背景」）。UniK3D：**只做了離線模型設定頁的自備匯出步驟說明，推論沒接**（沒驗證過瀏覽器能跑、不知道匯出檔輸入輸出名稱、授權非商業）；景物照片的選擇題判斷因此也沒做（沒有消費者）。
**真實 App 還沒驗證**：(1) 下載並載入 depth-anything-v2-small（fp16／int8 的檔名與 dtype 對照）、`predicted_depth` 輸出形狀；(2) SlimSAM 的 `get_image_embeddings`＋逐點 `processor(image,{input_points})`＋`post_process_masks` 流程與 `iou_scores`；(3) 真圖跑完整 `/image-to-3d` 並在編輯器看到物件；(4) 背景差分在真實照片的門檻（預設 40）；(5) 設定頁新卡片的顯示；(6) 兩張圖貼上時的指令分流。發布未做。

## 2. 概況
- 目標：新增斜線指令 `/image-to-3d` 與同名工具 `image_to_3d`：圖片 → 離線模型 → **每個物件各自封閉的立體**（不是浮雕）→ 放進 `/edit-3d-model` 的場景（自訂形狀物件，`mesh:'polygon'`，`extra:{vertices,faces,uvs?}`）。
- 設計全在 `DESIGN.image-to-3d.md`（已提交，69998292）：封閉策略、UniK3D 評估、決定。**那份是規格，照做，不要再改方向。**
- 分支 `desktop-app`，工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。上一個工作（AIDoc 除錯定位器）已完成並發布 v211，與這個無關。
- 還沒有任何程式碼。沒部署。

## 3. Todo（依序，每項做完測試、提交）
1. **純函式核心** `renderer/src/media/image3d_core.js`（UMD，全域 `FaImage3d`，仿 `renderer/src/aidoc/trace.js` 的包法；測試 `scripts/media-tests/image3d_core.test.js`，用 node 跑）：
   - 輸入：物件遮罩（二維 0/1 陣列或遮罩輪廓多邊形）＋深度圖（相對深度，每像素一個數）＋選項 `{shape:'auto'|'cylinder'|'blocks', maxFaces, thickness}`。
   - 輸出：封閉網格 `{vertices:[[x,y,z]…], faces:[[a,b,c]…]}`。
   - 兩種粗殼：**柱體**（輪廓沿深度軸擠出，前表面貼深度）、**方塊**（樂高式：只留物件佔到的格子，外表面為殼；格子逐層對半細切，每層都封閉，到面數或誤差上限停）。厚度（背面）依輪廓寬度乘比例推測。
   - `isClosed(mesh)`：每條邊剛好兩個面共用、沒有退化面；不合格的物件退回較粗的殼。
   - 背景補洞：物件被切走的地方，用周圍深度插值補平。
   - 測試：圓形遮罩→封閉；L 形遮罩→封閉；兩個物件加背景；`isClosed` 負面案例；面數上限（編輯器自訂形狀約 1.2 萬面）。
2. **深度模型**：在 `renderer/src/vlm/vlm_core.js` 的模型登錄加 `depth-anything-v2-small`（`task:'depth-estimation'`，repo `onnx-community/depth-anything-v2-small`，Apache-2.0），並讓工作執行緒（`faVlmWorkerMain()`，`floating-assistant.js`）支援 `depth-estimation` 任務（Transformers.js 的 `pipeline('depth-estimation', …)`）。沿用現有 WebGPU 降級 CPU 與下載進度卡片。
3. **分物件**：先做不需要新模型的版本——使用者指定「整張圖當一個物件」或用現有的去背（看 `subject_3d.js`／找圖→3D 那條路用的切背景函式）取前景遮罩；再把 MobileSAM 這類分割模型做成同樣的模型登錄（不阻塞前面的項目）。
4. **指令與工具**：`/image-to-3d [--close objects|all] [--shape auto|cylinder|blocks]`＋附圖或 file_id；工具 `image_to_3d`。封閉選擇由程式先解析（「物件要封閉」「要能列印」→ all；預設 objects），解析不出才用封閉式選擇題問模型，答案由程式核對。結果：每個物件一個自訂形狀、背景一個，放同一個群組，用既有的 `edit_3d_open`／`_convertModelFileToSceneYaml` 路徑開編輯器（先看 `renderer/src/edit/edit3d_host.js`）。工具說明文字用中文引號，不要用反引號 code span。
5. **景物照片加強（UniK3D，選用，最後做）**：視覺模型用封閉選擇題（A 景物照片／B 單一物件／C 人像／D 插畫或圖示）判斷，程式核對；只有 A 且使用者已在「媒體→離線模型」設定頁指定自己匯出的 `.onnx` 才走。**不內建、不下載、不碰授權散布**（CC BY-NC 4.0）。設定頁附匯出步驟說明（官方 `export.py`，`vits`，462×630）。這項未驗證能否在瀏覽器跑，做不出來就跳過，不卡住前面。
6. 補 `features/ai-features.yaml` 清冊（`node scripts/ai-features.js check` 通過再 `build`）、`node scripts/embed-code-ui.js`（新增模組要加進腳本的嵌入清單，參考 `embedAidoc()`）、`node build-assistant.js`；發布只在使用者說「發布」時，用 `PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`。

## 4. 做法備忘（使用者的規則）
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組，再 `node scripts/embed-code-ui.js`；不要改嵌入後那份（`floating-assistant.js` 裡嵌入的區塊）。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線**（`\n` 變真換行），需要寫反斜線或中文正則時，用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 會混，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新名單別擴大；不要要求使用者重裝；push 到自己 remote 可以，deploy／發布要使用者當輪說。
- 新增資料庫結構或記憶格式要定義版本與 migration。
- 失敗訊息要附具體事實（HTTP 狀態、耗時…），暫時性失敗要自己重試。
- 這台 Windows 的 Node 沒有 `node:sqlite`；需要時用 Electron 當 Node：`ELECTRON_RUN_AS_NODE=1 <scratchpad>/…/FloatingAssistantApp.exe <腳本>`。

## 5. 使用者原話（逐字，2026-10-29）
- 「幫我評估實現image to 3d使用離線模型的方式，來服務image to 3d的需求，使用onnx的unik3d，要在media裡面」
- 「如果unik3d可行，image decompose redraw就可以改成把pipeline專攻image to svg跟多圖層 然後上述的就改成slashcommand image-to-3d」
- 「雲端精煉我們可以用我們自己的長時間的處理，像是編輯器跟 save case, 變成offline trainer。那先以混合架構為主，而如果是從 vlm得知那是一張景物照片，可以做一個unik3d的處理，我們不內建，只使用他的模型，而單機可以從media offline model去手動下載」
- 「或者這邊要有選擇，人臉，或個別物件，都要用物件自己的邊界去封閉，封閉的時候，弄成像是cylinder或樂高的方形來封閉，再去細切，或者使用者在要求裡面就是物件要封閉，那就物件統一都要封閉，例如分出一個東西是背景，那些地方是一團物件，例如場景中的一顆蘋果，那蘋果應該要封閉」
- 「原本的decompose redraw已經是浮雕  請不要又推翻我現在的要求!我已經受夠了浮雕」
- 「JUST DO IT!」「不要再繼續plan了, fuck」

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、同一個工作目錄）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- 不要再把底層做成「前表面網格再補背面」——那是浮雕，使用者明說受夠了。
- 單張圖看不到背面：背面依輪廓推測，輸出要寫明，不要假裝知道。
- UniK3D 官方只發 PyTorch 權重，不是 ONNX；手動下載的使用者必須自己匯出。授權非商業，我們不散布。
- 我查證的資料來源與「未驗證」清單在 `DESIGN.image-to-3d.md` 文末與第一節，別把未驗證的當事實（例如 `wasm-marching-cubes`、`wasm-poisson` 可能不存在）。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat` 是否變成整檔，整檔差異要確認只是行尾。
