# 交接文件：`/image-to-3d`（離線模型、物件封閉，handoff 2，2026-10-30）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.image-to-3d.md`. 先完整讀完（含使用者原話與做法備忘），照做。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要再做規劃、不要再問，直接寫程式、測試、提交。不發布（使用者沒說發布）。**

使用者的關鍵指示（逐字）：「JUST DO IT!」「不要再繼續plan了, fuck」「原本的decompose redraw已經是浮雕  請不要又推翻我現在的要求!我已經受夠了浮雕」。

## 2. 概況
- 分支 `desktop-app`，目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`。規格在 `DESIGN.image-to-3d.md`（別改方向）。舊進度說明在本檔下方「附：先前進度」。
- 已提交：核心 `renderer/src/media/image3d_core.js`（柱體／方塊封閉殼、isClosed、背景補洞、buildScene、prepareInput、labelsFromMasks、diffMask 背景差分、parseOptions、toSpec 含貼圖座標、**buildPanorama／bendCylinder／readExif／orbitKind**）＋測試 `scripts/media-tests/image3d_core.test.js`（32 項過）；深度模型登錄與 `_depthEstimate`、SlimSAM 登錄與 `_segmentObjects`（`renderer/src/vlm/vlm_core.js` ＋ `floating-assistant.js` 工作執行緒）；`/image-to-3d`、`image_to_3d`（`renderer/src/edit/edit3d_host.js`，預設貼材質）；清冊；嵌入腳本。最近提交 ec530e68（貼材質）。
- **未提交**：`vlm_core.js` 的深度模型 CPU dtype 改 fp32（下面第 2 項實驗發現）與重新嵌入的 `floating-assistant.js`；接手第一件事先 `node scripts/embed-code-ui.js`、跑測試、`node build-assistant.js`、提交。

## 3. Todo（依序，每項做完測試、提交）
1. **（實驗發現的主要缺點）新增 `shape:'smooth'`，並讓 `auto` 優先用它。** 實驗（見第 6 節）顯示柱體殼的前表面有一條條細長三角形（ear clipping 切出來的長條，內部沒有頂點，深度只在邊界取）。做法：方塊格子的占用判斷沿用 `blocksMesh`，但頂面頂點「共用」——每個格子角落一個頂點，高度＝周圍有佔到的格子高度平均；頂面每格兩個三角形，背面平的，側牆只在外輪廓與洞邊（牆頂邊界＝頂面邊界、牆底在背面平面）。對角相接的格子沿用現有補格修正。`isClosed` 必須過；加進 `buildObject` 的層級迴圈（層級 n=4..96，取面數上限內最細且封閉的），加測試（圓形、L 形、有洞、隨機遮罩固定種子）。`--shape` 與 `parseOptions` 加 `smooth`。
2. 實驗頁加 SlimSAM：同一張合成圖（蘋果＋藍盒＋地面橢圓）用 `--segment` 流程試，現在去背遮罩把蘋果、盒子、地面橢圓連成一個物件（只分出 1 個）。載入 `Xenova/slimsam-77-uniform`（`SamModel`、`dtype:'q8'` 或 `fp32`），照 `floating-assistant.js` 工作執行緒 `sam` 分支的流程跑，看能不能分出 2～3 個物件；按實測修 `sam` 分支與登錄的 dtype／檔案大小。
3. **全景／轉圈照片接到主機端**（核心已做好並測過）：`/image-to-3d --panorama`；單張寬高比 ≥ 2:1 自動走全景；多張圖用 `FaImage3d.readExif` 讀 GPS／方向，`orbitKind` 回 `outward`（站在原地轉圈，依方向排序拼成一條橫幅）就走全景，`inward`（繞著物體轉）老實說明做不到、改用第一張。每張各估深度（各自正規化，說明是近似），橫向拼接後 `buildPanorama({w,h,data},{fovDeg,bands:3,radius:5})`，`toSpec` 時編輯器相機放原點（`spec.camera.position=[0,1.6,0]`，往外看）；貼材質：圓柱座標的貼圖座標（目前 `toSpec` 的 uvs 是正面投影，全景要改成 u＝角度）。結果寫明「遠景／中景／近景」三層，可匯出 glTF 給 VR 用；**VR 觀看沒驗證**要照實寫。
4. `renderer/src/media` 新增的測試要加進 `scripts/run-core-tests.js`（若它有清單）。
5. 重建：`node scripts/embed-code-ui.js`、`node scripts/ai-features.js check` 再 `build`、`node build-assistant.js`、提交。**不發布。**
6. 最後把「真實 App 還沒驗證」清單更新到本檔，結束。

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
