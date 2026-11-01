# 交接文件：音樂領域（MIDI／mp3 轉 MIDI／音色庫瘦身，handoff 5，2026-11-01）

## 1. 開場提示（給接手的工作階段）
Continue from the handoff document at `D:\Downloads\videos-嗨投資-desktop-app\desktop-app\DESIGN.TODO.music.md`. 先完整讀完（含使用者原話與做法備忘），照做。工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`（產品程式在這裡）；參考專案 `D:\Downloads\SRC\piano-web` 只讀不改（若沒有權限讀，先用目錄授權工具請求該目錄）。執行 low-context-long-run 技能（門檻 30%）：做 Todo 的第一項，context 到門檻就更新這份文件並啟動你的接手工作階段（`mcp__ccd_session__start_session` 是延遲載入的工具，先用 ToolSearch 載入）。第一則訊息用一行說明你讀完了、要開始哪一項。回覆一律繁體中文、不要夾英文縮寫。**不要做長篇規劃、不要問，直接查證、寫程式、測試、提交。**

使用者的原話在第 5 節（逐字）。

## 2. 結論與大方向（已定案，不再評估）
做一整條音樂線，全部放在 FloatingAssistant（網頁版與桌面版共用），**新模組一律走延遲載入**（網頁版用 `web-lazy` 區塊機制，見 `DESIGN.lazy-loading.md` 與 `README.FloatingAssitant.md`；桌面版整份檔案不變）。分八個階段，**依序做，每階段可獨立使用、獨立提交**：

| 階段 | 內容 | 重點 |
|---|---|---|
| 0 | 查證與量測（短，不寫長報告） | 音色庫分析工具、轉譜模型可行性、授權 |
| 1 | MIDI 核心＋播放卡片＋MIDI 轉 mp3＋domain `music` 知識 | 先讓「放得出聲、轉得出檔」 |
| 2 | MIDI 編輯器（只用 GS 音色）＋內建問 AI＋遠端卡片與遠端編輯 | 參考 piano-web 的多音軌編輯 |
| 3 | MIDI 的 AI 創作（風格範本＋CoLU＋UML design） | 程式決定結構，模型只做選擇題 |
| 4 | 音色庫瘦身工具與迷你 GS 音色庫 | 找重複、重新取樣、壓縮 |
| 5 | mp3 → MIDI（拆樂器軌、轉成 GS 音色與音軌） | 離線小模型，WebGPU／WASM／CPU |
| 6 | 接進簡報（media-presentation）、2D／3D 遊戲、影片剪輯當配樂 | 一條共用的「配樂」介面 |
| 7 | 風格知識：瀏覽器查維基的風格介紹、風格設計範本 | 與階段 3 共用 |

## 3. Todo（依序；階段 0–4 已做完，階段 5 做了規則部分）

### 下一步（midigenai 當首選，管理層追加，2026-11-02，**最新**）
使用者原話：「可以用midigenai當首選，一樣在離線模型裡面管理，我們的管線跟處理方式可以當額外參考，用類似/image 的diffusion一樣，將使用者需求轉為midigenai的prompt」；「而相關內容無法處理，才fallback為我們的拆分方式」。查證與設計已提交（DESIGN.music.md「midigenai 查證與整合設計」，commit 9aa5d818）：MIT、v5 約 1.13 億參數、輸入是 MIDI 不是文字、有 JS 端與 ONNX（wasm 8 位元 115 MB／WebGPU 4 位元 73 MB）、資料集授權未確認。**卡在需要同意的兩件事**：① 把 MIT 原始碼（midigenai/web 下約 7 個檔）複製進專案並附授權；② 下載 115 MB 模型做實機量測。同意後照文件批次五到七做。

### 下一步（作曲家升級，管理層派工，2026-11-02，（上一項，已完成））：AI 真的是作曲家，不只是選範本
使用者原話（2026-11-02）：「請問照這樣，有哪個是他透過api去填入midi 的note的?感覺只是讓ai選種子」；「yes，他必須是一個作曲家，像是在拆uml一樣，divide and conquer, 然後組裝起整體」；先前：「他好歹要LLM學會...」。UML design 的意思（使用者定義）：由上而下持續規劃、細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程。
- 設計寫在 DESIGN.music.md「作曲樹」章節。新模組 renderer/src/music/compose_tree.js（FaComposeTree）：規格 → 曲式 → 每段和聲 → 每段聲部分工 → 主題動機 → 程式發展與組裝 → 整體檢查；每個節點小而封閉、程式驗證、失敗只重做該節點（嚴格版重問，再不行用該節點範本）、結果卡片以樹狀列出每個節點來源（AI 決定／程式修正／範本預設）。
- 進度（每批提交後更新這裡）：批次一～三已提交：設計文件、compose_tree.js 核心＋假模型測試 65 項、宿主接線＋樹狀卡片（重做/改成…）＋經驗回流＋入口測試（細節見 DESIGN.music.md「作曲樹實作紀錄」）。真模型小樣本實測：未驗證（沒有金鑰）。可再加強：旋律發展手法只有原樣/模進/反行/逆行/答句，沒有變奏節奏；每段只問和聲不問段內小節級的細節；失敗案例進 UML 編修候選仍未做。
- 階段七（音樂知識與維基風格查詢）仍暫緩。管理層代發，不要自己執行發布腳本；context 到 30% 自己更新本段、提交，回報「需要接手，文件已更新，commit <hash>」。

### 下一步（handoff 7 接手，2026-11-02，（前一輪））：讓作曲真的由 LLM「學會」理解需求
使用者原話（2026-11-02）：「他好歹要LLM學會...我們handoff7 有辦法enable這件事情嗎？」；實測 v267 的 /media-compose-midi 顯示：「這次沒有用 AI，用的是範本規則（AI 的回答讀不懂（The user wants to create tech-style musi…））」。

**現況（已提交 6b16b71a）：** renderer/src/music/compose_plan.js（FaComposePlan：decide／parseAnswer／questionOf／toOptions／edit／describe）、宿主 renderer/src/floating-assistant.js 的 _midiComposeFlow／_midiComposeFinish／_midiRecompose／_mountComposeCards（卡片 fa-compose）；斜線 /media-compose-midi 與工具 midi_compose 都走 _midiComposeFlow；測試 scripts/music-tests/compose_plan.test.js（27 項，假 AI：完美、亂答、無 JSON、部分答對、沉默、逾時、丟錯、重試）。AI 呼叫是 this._callSimpleCompletion(user, { systemPrompt, maxTokens: 300, temperature: 0, noBudgetRetry: true })，逾時 25 秒，最多 2 次。

**失敗原因（推測，尚未用真模型驗證）：** 現在是「一次要整包 JSON」（questionOf 一段長系統提示 + 六個字母欄位 + purpose）。有些模型會先回英文的思考文字（「The user wants to create…」），沒有 JSON，parseAnswer 讀不到，整段退回規則。maxTokens 300 對會先思考的模型也可能不夠（思考吃光上限，答案是空的；_callSimpleCompletion 的預算加倍重試被 noBudgetRetry 關掉了）。

**管理層查到的原因（補充，未用該模型驗證）：**
- renderer/src/floating-assistant.js 約 73788 行（_midiComposeFlow）：ask 呼叫 _callSimpleCompletion(user, { systemPrompt, maxTokens: 300, temperature: 0, noBudgetRetry: true })。
- renderer/src/music/compose_plan.js：questionOf() 一次要整包 JSON（七個欄位）；parseAnswer() 只取第一個 {…} 並 JSON.parse，不剝思考文字、不寬容；decide() 第二次重問是同一題原樣重送，不會有不同結果。
- 使用者看到的回覆開頭是英文「The user wants to create tech-style musi…」：推測是帶思考過程的模型在 maxTokens 300 內把 token 用在思考，回覆被截斷、JSON 還沒出現。要先確認 _callSimpleCompletion 會不會把思考內容混進回覆、有沒有 reasoning 參數可關或可分離。
- 我在內建瀏覽器用假模型回「The user wants to create tech-style music…」重現了同樣的症狀（兩次都讀不懂、退回規則）；進度卡現在會寫出模型名稱與回了什麼前 80 字。

**這一輪已加（進度卡，使用者另外回報「按斜線指令沒有任何處理中的卡片」）：** _midiComposeFlow 現在會放一張「🎼 作曲」進度卡（【理解需求】【核對】【作曲】，含模型名稱、AI 回答的欄位或回的前 80 字、退回規則的原因）；compose_plan.js 的 decide 多了 onStep 回呼與 report.aiRaw。尚未做：逐欄診斷（哪一欄、回了什麼）要在逐欄提問改好後再補。

**要做的事（照使用者要求，沿用 CoLU／弱模型 harness 做法）：**
1. 一次問一欄、字母作答，不要整包 JSON；每題前面放 2～3 個範例（few-shot），明講「只回一個字母，不要解釋」；用途（purpose）另外一題，回一句話。
2. 解析要寬容：剝掉思考區塊（<think>、英文思考）與前後文字，在回覆裡找第一個／最後一個合法字母或欄位值；仍讀不懂就用同一題「更嚴格版」重問一次（把上次的回覆貼回去，說明格式錯在哪），兩次都失敗才退回「那一欄」的預設，只退那一欄。maxTokens 要夠（思考型模型）或開預算加倍重試。
3. 診斷要誠實：失敗時卡片要寫出是哪一欄、模型回了什麼（前 80 字）、用了哪個模型（this._getApiConfig().apiModel），方便判斷是模型問題還是提示問題。FaComposePlan.decide 的 report 要多帶 perField 診斷。
4. 經驗回流（harness 的學習層）：使用者最後接受的結果（沒按「換一首」、直接用或下載）當作程式驗證過的成功，經 renderer/src/harness/experience_core.js 的閘門寫進離線訓練器；之後類似說法（「科技感／電子／用來描述某產品」）由程式直接對到正確範本與配器，不必每次問 AI；失敗案例進 UML 編修候選，不直接當知識。先讀 skills/weak-model-harness 與 DESIGN.TODO.harness-skill.md、experience_core.js 的介面。
5. 用 skills/weak-model-harness 的假模型測試法測：完美、亂答、英文思考文字、沉默、逾時、只回一半，每種的欄位與退路；再用真模型（claude-haiku-5-5 或使用者設定的模型）小樣本實測一次並記用量；沒實測的寫「未驗證」。
測完跑整套入口測試（tray_dialog 與遠端協定探測是偶發既有項，單獨跑通過即可）、提交，回報最後一行「已提交，可發布，commit <hash>」。

**其他已完成、別重做：** 階段 6 配樂（bb43a845）、音色庫換瘦身版（99371b76，記得 v262 起預設 6.3 MB）、播放卡片清混音（a29bd77f）、說明文字與離線模型管理音樂區（f43774ff）、作曲說法路由與成品卡片（448917dc）。階段 7 仍暫緩。

### 已完成（handoff 7 接手，2026-11-02）：作曲「理解需求」改成逐欄提問
- **查證結果**：`_callSimpleCompletion` 只讀 `choices[0].message.content`，標準的 `reasoning_content` 不會混進回覆；但有些模型（或轉接服務）會把英文思考直接寫在 content 裡（使用者看到的「The user wants to create tech-style musi…」就是這種），而且舊的整包 JSON 一次要七欄，模型先思考就讀不到 JSON。`maxTokens: 300` + `noBudgetRetry: true` 讓「思考吃光額度、回空白」無法自動加倍重試。這些是讀程式的結論，**沒有用真模型驗證**。沒有找到可關閉思考的通用參數（`reasoning_effort` 只在進階取樣設定，不通用），所以改成問得短、讀得寬。
- `compose_plan.js`：`questionOf(欄位, 需求, strict)` 一次問一欄（風格、情緒、速度、調式、主奏、長度、用途），每題附三個範例、明講只回一個字母；`parseLetter` 先剝思考區塊（含沒關的 think），再找 JSON、開頭字母、「答案是 X」、整句只有選項名稱，長篇英文思考文字不亂猜；第二次用「更嚴格版」（貼回上次回覆、說明不合法）；兩次都讀不懂只那一欄退回規則／預設。使用者已經說了的欄位（風格詞、bpm、小調／大調、樂器、小節數、用途）不問。連線類錯誤連兩次就不再問後面的欄位，前三欄一個都沒答對也停（避免每欄都等逾時）。`report.perField` 帶每欄的次數、回覆前 80 字、錯誤，卡片的提醒會寫「AI 沒答對的欄位改用程式預設：欄位（原因）」，進度卡寫模型名稱。
- 宿主 `_midiComposeFlow`：maxTokens 改 400（用途 200），**不再關預算加倍重試**。
- 經驗回流：結果卡片多了「👍 就用這個」按鈕（使用者按了才算接受）。`_composeLearn` 經 `FaHarnessExp` 閘門（只收程式驗證過的、去識別、去重、上限）存本機 `fa_compose_experience`，並把 pattern 送進離線訓練器 `harness_experience` 領域（預設停用）。之後類似說法（字元二連詞相似度 ≥ 0.7）由 `FaComposePlan.matchLearned` 直接對到字母，那幾欄不再問 AI，來源顯示「以前學到的」。程式猜的與預設的欄位不收。失敗案例進 UML 編修候選：**未做**（只有成功回流）。
- 測試 `scripts/music-tests/compose_plan.test.js` 43 項：加了 parseLetter／parsePurpose、六種假模型（完美、亂答、英文思考文字、沉默、逾時、只回一半）與嚴格版重問、學到的說法。
- **未驗證**：真模型小樣本實測（這個環境沒有 API 金鑰）；「就用這個」按鈕在真實介面的點擊與離線訓練器匯入；快取／網頁版載入。使用者實測時請看卡片的提醒文字，會寫出哪一欄、模型回了什麼。
- 限制：用途（purpose）那題若模型亂回短句，程式只擋英文思考開頭與過長，擋不掉一句不相干的中文。

### 階段 6 已提交（handoff 7）
- 新模組 renderer/src/music/soundtrack.js（FaSoundtrack：規格、淡入淡出、循環鋪滿、wav、播放控制；真渲染測試 scripts/music-tests/soundtrack.html）、工具 soundtrack_make。簡報：deck.soundtrack（set_deck 的 soundtrack、編輯器簡報屬性裡的配樂列，播放接在旁白下、匯出 MP4 混進去）；遊戲：set_bgm 的 soundtrack 參數、場景面板與聲音分頁的「🎼 配樂」按鈕、播放端非同步取緩衝；影片剪輯：「🎼 配樂」鋪滿時間軸存成一筆配音。MIDI 遠端卡片：卡片的 fa-midi 區塊內含 base64（90 KB 以下），遠端收到同樣會掛載播放卡片（讀程式確認，沒有兩台機器實測）。
- 限制：獨立遊戲包不帶配樂（退回風格合成）；影片剪短後配樂不跟著變短；簡報拖進度時配樂重接，未做旁白時壓低；階段 7 依使用者指示暫緩。

### 音色庫驗證結果（handoff 7，2026-11-01，**最新**）
- **結論（已更新）：七項波形門檻沒有全過（10 個位置），但使用者 2026-11-01 決定接受，用最好的一版（22 kHz、SF3 品質 3、6.6 MB）取代原版。已推到 soundfont-assets 分支（commit 9ee509dd06ec0e9c0bcebaaea7c7645294a5edff，單片 GeneralUser-GS-22k.sf3.part000，md5 c6f01d650e1ba739f1a7c84bacf2d661，sha256 與清單一致），FA_ASSET_URLS.gsSoundbankBase 已填，原始 sf2 網址保留當退路。桌面版沒有放進 live patch 清單。**
- 使用者接受的未過位置：頻譜距離 GM 72、5、12、15；重心位移 GM 61、116、7、88；包絡相關 GM 110、83；高頻損失 GM 42。
- 驗證（內建瀏覽器、本機伺服器）：開 renderer/index.html 後資源請求清單沒有 sf2／sf3／spessasynth 檔；第一次播放才出現 spessasynth-processor、spessasynth-lib、manifest.json、GeneralUser-GS-22k.sf3.part000，進度訊息「下載音色庫 第 1 / 1 片」到「就緒」；遠端這一片的 md5 與清單一致。沒驗證：快取後離線播放、桌面版（桌面版同一段程式，沒另外跑）。
- 新增：sf-compare.html 改成七項（靜音、均方根差 ≤3 dB、11 kHz 以下對數頻譜距離 ≤5 dB、重心位移 ≤12%、包絡相關 ≥0.9、接縫爆音、高頻損失清單）；sf-loop.js 加逐樣本波形檢查（改 loop 的樣本照 loop 播放比頻譜與重心，不過就退回原樣本）與高頻分級（11 kHz 以上能量多的樣本不降取樣，用 --hi-share-db=-35）；sf-slim.js 不動兩類樣本：sampleModes=3（鬆鍵後繼續播 loop 後尾段）與用到起訖／loop 位移產生器的（共 135 個）。這兩類被截尾是上一版 GM 35 等大量失敗的原因，修完 131 個比對位置從 44 個失敗降到 10 個。
- 目前最好一版（22 kHz、SF3 品質 3、6.6 MB）：沒有靜音、沒有接縫爆音、高頻損失只剩 GM 42（9.4 dB）。**仍未過的 10 項**：頻譜距離 GM 72（7.4）、GM 5（7.1）、GM 12（6.9）、GM 15（5.0）；重心位移 GM 61（32%）、GM 116（14%）、GM 7（41%）、GM 88（39%）；包絡相關 GM 110（0.58）、GM 83（0.65）。提高 SF3 品質到 7（8.9 MB）只修好 GM 15 並多出 GM 9，所以不是壓縮品質，是降取樣或剩下的 loop 處理造成。
- 下一步（若要繼續）：對這幾個音色的樣本逐一用 --max-rate 不降、--no-add-loop 試，看是哪一步造成；重現指令：node scripts/sf-slim.js 原版.sf2 輸出.sf3 --max-rate=22050 --sf3 --hi-share-db=-35，再 node 小伺服器開 scripts/music-tests/sf-compare.html?a=原版&b=輸出&from=0&to=128。

### 目前狀態（handoff 6，2026-11-01，**最新，先看這段**）
- **階段 5 已提交（2eb0a0c5，入口測試 162/163，唯一失敗是既有的遠端協定探測）**：`renderer/src/music/` 新增 `audio_pipeline.js`、`basic_pitch.js`、`instrument_classify.js`、`audio_models.js`、`audio_runtime.js`；工具 `audio_to_midi`、斜線 `/audio-to-midi [拆軌]`、功能清冊 `music-audio-to-midi`。三個模型都真的下載並在瀏覽器實測（結果寫在 DESIGN.music.md「階段 5 實測」）。限制：Demucs 要關最佳化、只能 wasm、很慢，預設不拆軌；鼓分類門檻與 YAMNet 對真實錄音的準確度未驗證；`/audio-to-midi` 在整個 App 裡沒有手動點過（只測了零件與流程）。
- **下一步：階段 6**（配樂共用介面：先看 `game_audio.js`、簡報 `media-presentation`、影片剪輯 `edit-video` 現有音訊欄位，一個一個接），然後階段 7。發布仍由管理層代發。
- 測試用本機伺服器：scratchpad 的 `srv.js`（`node srv.js <folder>`，埠改用沒被占的，8778 被別人占了），測試頁在 `scripts/music-tests/a2m-*.html`。
- 想還原誤改的檔案時，`git checkout <檔>` 會被權限擋下；改用重新跑 embed/build 讓產生檔回到來源內容。

### 目前狀態（handoff 5 接手時，2026-11-01，管理層寫入，**先看這段**）
- 已完成並提交：階段 0～4。階段 1／2／3 已由管理層發布（v257／v258／v259）。階段 4（音色庫瘦身，cc17af7e）只有腳本與測試，沒有隨 patch 發出的檔案，所以沒發布。階段 5 的模型查證已提交（787c1623：Demucs 6 軌 fp16 約 136 MB、MIT；Basic Pitch Apache-2.0；都沒下載或實跑，Basic Pitch 檔案大小與張量形狀、WebGPU 能否跑沒查到，仍是「未驗證」）。
- **工作樹有上一個接手做到一半、尚未提交的階段 5 規則部分**（`renderer/src/floating-assistant.js`、`scripts/embed-code-ui.js`、`scripts/run-core-tests.js` 等有修改，另有新檔）：它回報「規則部分已寫好、單元測試…」但被截斷、沒提交。**第一件事：看 `git status`／`git diff` 弄清楚這些修改是什麼，跑對應的測試與 `node scripts/run-core-tests.js`，沒有新增失敗就提交；有壞掉的就修好或還原那一段（只還原你確認是上一個接手寫的、不是別人的）。**
- 然後做階段 5 剩下的（拆軌模型的載入與執行、Basic Pitch 轉譜、樂器分類選擇題、分群退路、輸出進 `/edit-midi`），再階段 6、7。
- **等使用者決定、你不要自己做**：① 5.8 MB 瘦身版 SF3（`gs-22k.sf3`，在 scratchpad）要不要取代原版當預設音色庫；② 要不要把音色庫 5 片推到 `soundfont-assets` 分支並填入 `gsSoundbankBase`。聽感尚未用耳朵確認。
- **發布由管理層代發**（使用者 2026-11-01 說「由你代發」）：你**不要執行發布腳本**。每完成一個階段（測試全過、入口測試沒有新增失敗、已提交），在回報最後一行寫「階段 N 已提交，可發布，commit <hash>」，然後立刻接著做下一個階段。若這個階段沒有隨 patch 發出的檔案，註明「只有腳本與文件」。
- **這個 app 不允許子工作階段自己啟動接手**（上一個接手試過）。所以到 context 門檻時：更新本文件、提交，然後在回報最後一行寫「需要接手，文件已更新，commit <hash>」，由管理層啟動下一個。


**已完成並提交（細節與實測結果見 `DESIGN.music.md` §1–§5）：**
- 階段 0：`scripts/sf-analyze.js`（結論：重複樣本不到 0.05 MB，瘦身要靠降取樣與 SF3 壓縮）、轉譜模型查證、piano-web 盤點（c6a21abf）。
- 階段 1 程式：`renderer/src/music/{midi_core,midi_play,midi_ui,music_knowledge}.js`＋測試 `scripts/music-tests/`（41 項全過，已接進 `scripts/run-core-tests.js`）、播放卡片 `fa-midi`、工具 `midi_play`／`midi_to_mp3`／`music_topic`、斜線 `/midi`、`/midi-to-mp3`、domain `music`、合成器程式庫放 `renderer/vendor/spessasynth/`（提交 2befe2d0…最新見 git log）。瀏覽器實測有聲、卡片可播（測試頁 `scripts/music-tests/browser.html`、`card.html`；音色庫本機副本放在 TEMP 的 gs.sf2，**不要放進 scripts/ 以免 publish.sh 的 git add -A 把 32 MB 提交進去**）。

**階段 1 補充（handoff 3 做完的）：** 功能清冊 `features/ai-features.yaml` 已加 `music-midi`（FEATURES.md 是產生檔，不要手改）；mp3 編碼是重用既有 `_encodeMp3`（lamejs，TTS 與抽音訊走同一條，已實用過），未單獨真機跑一次；網頁版合成器路徑推導（__FA_LAZY_BASE 往上兩層＝desktop-app/，再接 renderer/vendor/spessasynth/）檢查過邏輯，**發布後要用 curl 對釘住的 commit 查 200**；合成器程式庫是 fetch 文字後用 data: 網址載入，所以 CDN 的 MIME 類型不是問題。

**階段 2、3、4 已完成並提交（handoff 5）：** 階段 2、3 已由管理層發布（v258、v259）。階段 4 已提交 cc17af7e 並回報管理層（只加腳本與測試，不影響主程式）：`scripts/sf-loop.js`、`scripts/sf-slim.js`、`scripts/music-tests/sf-compare.html`；實測 GeneralUser GS 本來就設好短 loop，找 loop 只省約 5%，降到 22 kHz 加 SF3 從 32.3 MB 剩 5.8 MB（瘦身版放在 scratchpad 的 gs-22k.sf3，**沒有進 repo**，要不要當預設音色庫由使用者決定）。音色庫分片推送（soundfont-assets 分支）仍等使用者決定，**不要推、不要填 gsSoundbankBase**。

**發布一律由管理層代發**：每階段提交、入口測試（node scripts/run-core-tests.js，約 3 分鐘，用 run_in_background 輸出到 /tmp 再用 Monitor 等；遠端協定探測那組是不穩定的既有測試）無新增失敗後，用 SendMessage 回報 local_49f6c57d-8f18-427b-a8f1-7b1d23efc5f5「階段 N 已提交，可發布，commit <hash>」，然後立刻接著做。**app 不允許在自動事件回合用 start_session（會被拒），所以接手工作階段要由使用者或管理層在對話裡要求才起得來；本工作階段 context 過門檻（34%）後停在這裡。**

**第一項（現在就做）：階段 5 的剩餘部分**（查證結果已寫進 DESIGN.music.md「階段 5 查證」，規則部分已完成）：
- 已提交：`renderer/src/music/audio_to_midi.js`（鼓軌規則拆解、YIN 單音音高追蹤、音符切分、速度估計、量化、樂器標籤對應 GM、音域退路、組裝多軌）＋ `scripts/music-tests/audio_to_midi.test.js`（12 項，**用合成音訊調的門檻，真實錄音還沒試過**，鼓分類門檻要用真實鼓樣本再調）。已加進 embed 清單與入口測試。
- 待做 1：`FaAudioToMidiPipeline`（新檔 `renderer/src/music/audio_pipeline.js`）：解碼（WebAudio decodeAudioData，重新取樣到 44.1 kHz 立體聲）→ 可插拔分軌器（`separator(chunk) → {drums,bass,other,vocals,guitar,piano}`，沒有就把整個混音當一軌，鼓用 drumHits、其餘用 Basic Pitch 介面或單音追蹤）→ 逐軌轉譜 → 分類標籤 → buildSong；長曲分段（7.8 秒一段、重疊相加）、可中斷續跑（每段結果存 IndexedDB）、進度只出一張卡。介面用假的分軌器與假的轉譜器寫測試。
- 待做 2：模型登錄與下載（沿用 FaVlm 的登錄與工作執行緒，`renderer/src/vlm/vlm_core.js`、`faVlmWorkerMain()`）：Demucs 6 軌 ONNX（adowu/htdemucs-6s-onnx，fp16 版 136 MB，MIT）、Basic Pitch nmp.onnx（Apache-2.0，大小未驗證）、YAMNet ONNX（約 15 MB，Apache-2.0）；WebGPU／WASM／CPU 三條路；下載要進度、續傳、核對大小與檢查碼；**檔案大小、輸入輸出張量、瀏覽器速度都未驗證，先下載一個真的跑一次再寫進文件**。
- 待做 3：工具 `audio_to_midi({file_id})` 與斜線 `/audio-to-midi`，結果用 `_midiPushEditor` 進編輯器，並在回覆誠實寫明：拆樂器只到鼓／貝斯／人聲／其他（模型有就多吉他與鋼琴）、沒有模型時哪些部分被跳過、不保證準確。加進功能清冊 `features/ai-features.yaml`、domain music 的 toolNames 與提示詞。
- 之後：階段 6（配樂共用介面：先看 `game_audio.js` 與簡報、影片編輯器現有音訊欄位，一個一個接）、階段 7（風格知識工具 music_style_lookup 與範本）。

**之後各階段（做完前一階段再做下一階段，不要問）：階段 2 → 7，內容見原文如下（階段 1 已完成的部分略）。**
- **階段 2**：MIDI 編輯器 `/edit-midi`（仿 `FaEditShell` 外框：音軌欄、鋼琴捲簾、屬性、復原重做、底部 AI 對話框；**音色只能選 GS 音色**，GM 128＋鼓組；piano-web 的多音軌設計可參考，但不要整個搬）；**內建問 AI**：編輯器底部對話框用封閉動作（add_note、move、transpose、quantize、set_program、add_track、delete…）加 `parseCommands`（程式先讀中文），讀不懂才問模型；**遠端**：MIDI 播放卡片要能在遠端卡片裡顯示（看 `REMOTE` 區塊與遠端卡片機制，`renderer/src/remote/`），**遠端編輯**（遠端的人改同一份 MIDI，沿用現有遠端群組的訊息通道；衝突用「較新者勝＋事件層級合併」，每次編輯是一個事件）。
- **階段 3**：AI 創作。UML design 的意思（使用者定義）：「由上而下持續規劃，細切到不可再切，再用 CoLU 接線；弱到不能規劃時用樣板；不是寫死流程」。做法：風格→段落結構（前奏／主歌／副歌…）→和弦進行（從風格範本挑，程式驗證調內和弦）→旋律（節奏型範本＋和弦音約束，程式驗證音域與不超過跳進上限）→伴奏／貝斯／鼓（範本）→配器（GM 音色對應）。模型只做封閉選擇題與填空（挑風格、挑進行、挑速度），生成的音符由程式產生並檢查；檢查失敗自動重來（暫時性失敗要自己重試到底）。輸出直接進 `/edit-midi`。可存成功案例進離線訓練器（`editor_cases` 種類 `edit-midi`）。
- **階段 4**：依階段 0 的分析報告，做 `scripts/sf-slim.js`：去掉未使用樣本、合併完全相同的樣本、近似重複改成共用（調整調音偏移）、降取樣率（依音高與用途，例如 22.05 kHz／16 kHz）、截短循環前多餘的尾段、壓縮（Ogg Vorbis 的 sf3，SpessaSynth 若支援 sf3 就用；不支援就用自訂分檔格式＋解壓）。目標：**迷你 GS 音色庫**（使用者說 Roland Virtual Sound Canvas SC-88 的安裝包與音色檔非常小，GeneralUser GS 太大，要最小化音色並找出重複區）。**階段 4 更正（使用者 2026-11-01）：「找重複」是指每個樣本波形內部的 loop，像壓縮演算法，不是樣本之間的重複（階段 0 已證明幾乎沒有）。** 做法：① 自相關／週期偵測找基頻週期與穩定段，找可無縫循環的起訖點（對齊零交越、相位連續、能量一致，避免喀嚓聲）；② 有 loop 的樣本，loop 結束點之後的資料不會被播放，直接截掉；穩定段太長的只留整數個週期當 loop，其餘丟掉；③ 沒有 loop 的持續音（弦樂、管樂、合唱等）嘗試自動找 loop 並加上，打擊類單擊音不加；④ 再降取樣率與 SF3 壓縮。聽感比對工具要加：同一份 MIDI 用原版與瘦身版各渲染一次，算頻譜差異與接縫處的不連續度，列出差異最大的音色。
**重要：Roland 的音色資料有版權，只能當「大小目標」參考，絕對不要抽取、轉換或散布 Roland 的樣本。** 只對 GeneralUser GS（允許修改散布，保留授權文字）做瘦身；每次瘦身要附**聽感比對工具**（同一份 MIDI 用原版與瘦身版各渲染一次，算頻譜差異，列出差異最大的音色給人聽）。
- **階段 5**：mp3→MIDI：解碼（WebAudio）→（可選）拆四軌（人聲／鼓／貝斯／其他）→逐軌轉譜（Basic Pitch 類）→樂器指派（貝斯軌→GM 貝斯、鼓軌→鼓組、其他→用封閉選擇題＋程式核對挑 GM 音色，例如鋼琴／吉他／弦樂）→量化→輸出 MIDI 進 `/edit-midi`。三種執行環境：WebGPU、WASM、CPU 降級，沿用 `FaVlm` 的模型登錄與工作執行緒（`renderer/src/vlm/vlm_core.js`、`faVlmWorkerMain()`）、下載進度卡（只出一張進度卡，記錄分「章節／主角／行為」，沿用 image-to-3d 的做法）。**拆成「多種樂器」只能到四軌＋鼓；更細的樂器分離沒有可靠的離線小模型，要在結果裡誠實寫明。** 長曲子分段處理、可中斷續跑。
- **階段 5 採用的順序（使用者 2026-11-01 同意；模型名稱、檔案大小、授權、能否在瀏覽器跑都是未驗證，開做前先查證並寫進 DESIGN.music.md，查不到標「未驗證」）：** ① 6 軌版 Demucs（人聲／鼓／貝斯／其他＋吉他＋鋼琴，MIT 授權待確認，有沒有 ONNX 待查）＋ Basic Pitch 逐軌轉譜；鼓軌用規則拆底鼓／小鼓／踩鑔／通鼓／鈸（偵測打擊起點，再看頻帶能量：底鼓低頻、小鼓寬頻雜訊、踩鑔高頻）對應 GM 鼓組音符；人聲與貝斯是單音，用音高追蹤（pYIN 類）。② 「其他」軌再用樂器分類（YAMNet／PANNs／AST／Essentia 之一，擇可在瀏覽器跑者）對每段打標籤，封閉選擇題＋程式核對挑 GM 音色。③ 分類不準退回：音符頻譜特徵（質心、MFCC）分群，每群指派一個 GM 音色；最後才用音域規則當預設。可評估用 GS 音色樣本當字典做非負矩陣分解，只做實驗不當預設。④ MT3／YourMT3+ 太大，只當桌面版「使用者自備、選用」，不內建。⑤ 三種執行環境沿用 FaVlm；下載只出一張進度卡；長曲分段可續跑；結果誠實寫明拆樂器只到這幾軌。輸出進 /edit-midi。
發布前入口測試（node scripts/run-core-tests.js）不能有新增失敗；發布被權限檢查擋下就回報使用者，不要繞過。
- **階段 6**：「配樂」共用介面：簡報（`media-presentation`）、2D／3D 遊戲（`edit-game-2d`、`edit-game-3d`）、影片剪輯（`edit-video`）都能選一個 MIDI 或 mp3 當配樂（循環、淡入淡出、音量）；先看這四個編輯器現有的音訊欄位（遊戲有 `game_audio.js`），一個一個接，不要一次大改。
- **階段 7**：風格知識。工具 `music_style_lookup`：用瀏覽器查維基（`browser_search`／`fetch_web_page` 已存在）找某個風格的介紹，程式抽出「速度範圍、拍號、典型和弦進行、典型樂器、節奏特徵」存成**風格範本**（使用者可停用／刪除，存進離線訓練器的領域知識，仿 `editor_cases`）；內建一批常見風格的範本（離線可用）。階段 3 的創作優先用範本。

**完成後直接發布**（使用者慣例：完成一個階段、測試全過就更新網頁、發布 patch；**沒有全過不要發布**）：`PUBLISH_TRAILER="Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>" bash scripts/publish.sh -m "…"`，再 curl 查遠端 `manifest.v2.json` 版本。發布前確認：新模組的網頁版區塊檔都在 `web-lazy/manifest.json`、都在釘住的 commit 下回應 HTTP 200（這台 Node 沒有 `fetch`，`web-lazy-check.js --remote` 會失敗，改用 curl 逐一核對檢查碼）；桌面版整份檔案所以不受影響。如果發布腳本被權限檢查擋下，回報給使用者確認，不要繞過。

## 4. 做法備忘（使用者的規則）
- 發布被權限檢查擋下就回報使用者，不要繞過。
- 繁體中文、結論先說、不要在中文裡夾英文縮寫；做完誠實說哪些沒驗證。
- 改來源模組（`renderer/src/music/*.js`），再 `node scripts/embed-code-ui.js && node build-assistant.js`；不要改嵌入後那份。新模組要加進 `scripts/embed-code-ui.js` 的嵌入清單，並確認 `web-lazy` 建置有把它拆成區塊。
- 改檔用 Edit／Write 工具；**Bash heredoc 內的 Python 會吃掉反斜線與中文**，需要時用 Write 工具寫 `.py` 檔再執行。`floating-assistant.js` 行尾 CRLF／LF 混合，改前用 `s.count()` 試兩種。
- 編譯前會清工作目錄：做到一半也先 commit。給了順序就做到底，不要中途問「接著做哪個」。
- 熱更新：舊版也要收得到、不准要求重裝、版本號單調、manifest 清單完整（見 `.claude/skills/publish-live-update-patch/SKILL.md`）。
- 設計畫面放在擁有該工具的 domain，⚙ 按鈕彈出 popup（範本／設定）。
- CoLU 思考外殼：字母選擇題、程式檢查、程式預設退路；模型輸出一律由程式核對。
- 暫時性失敗要自己重試到底，失敗訊息附具體事實（HTTP 狀態、耗時、後端），不要靠換模型復原。
- 所有下載（模型、音色庫）要有進度、可中斷續傳、核對大小；公開產品，授權不明就不內建、改使用者自備。
- 工具說明文字用中文引號，不要反引號 code span。
- 工作樹有不是你改的檔案（`skills/image-decompose-redraw/data/parts_builtin.json`、`test-reports/*`、`features/FEATURES.md` 之類）：不要放進你的提交，也不要還原。

## 4b. 發布與音色庫的做法（使用者新增，2026-11-01）
- **發布**：每完成一個階段，測試全過、入口測試沒有新增失敗，就執行 publish.sh 發布，再用 curl 核對遠端 manifest.v2.json 版本與網頁版區塊檔，然後接著做下一階段。**注意：這句授權是別的工作階段轉述的；發布屬於正式環境部署，被權限檢查擋下就不要繞過，把「第幾版沒發出去」記在這裡與回報裡，繼續下一階段。** 使用者本人在對話裡當輪確認時才算數。
- **音色庫不占開頁**：GS 的 sf2（日後瘦身後的 sf3）與 renderer/vendor/spessasynth 合成器程式庫不放進核心、也不放進網頁版一開頁載入的檔案；只在第一次播放／編輯／轉 mp3 時下載。大檔放獨立 branch（先例：sql.js 的 vendor-assets branch，搜 floating-assistant.js 的 vendor-assets；可沿用或新開 soundfont-assets，git plumbing 單一 commit、force push，同 desktop-app-patch 慣例），分片每片 ≤ 8 MB、逐片核對 md5、合併後核對總大小，網址用完整 commit SHA 釘住。下載一張進度卡、可中斷續傳、存 Cache Storage／IndexedDB（網頁版）或使用者資料夾（桌面版），第二次直接用快取。桌面版不把音色庫放進 live patch 的 manifest（舊主程式單檔 8 MB 上限），需要時由 App 從 branch 下載。驗證：網頁版開頁的網路請求清單不得出現 sf2／sf3／spessasynth 檔案，第一次按播放才出現；快取後離線可播。階段 4 瘦身後沿用同一套（版本號、md5 清單）。**這件事要在下一個階段發布前一併處理。**

## 5. 使用者原話（逐字，2026-11-01）
- 「我有下一個計劃想執行，是音樂領域」
- 「mp3->midi  (用可以onnx, webgpu/cpu, wasm網頁執行的小model，拆成多種樂器，再轉soundfont樂器跟音軌)」
- 「midi的ai創作設計」「midi的播放器」「midi轉mp3」
- 「midi編輯器，可以參考piano-web的多音軌編輯的設計，但是要改成只用soundfont-gs做為樂器」
- 「midi跟mp3可以在media-presentation, edit-game-2d, edit-game-3d, edit-video使用來做維配樂」
- 「midi播放卡片也要支援遠端卡片」「midi要遠端編輯」
- 「幫我設計domain裡面的音樂知識描述，在這邊也要有能力用瀏覽器找wiki關於各種音樂的風格介紹，要有風格設計的範本與CoLU」
- 「音樂編輯器也要有內建ask ai」
- 「這個應該也是可以lazy-loading」
- 「然後我希望裡面用到的generic可以重新評估、取樣跟壓縮，因為我有買過一個roland virtual canvas sc88，但他整個安裝包跟音色檔非常小。這個gs的soundfont音色太大。想要最小化音色，來找出重複區」
- 「那幫我在階段四，除了壓縮格式外也把loop找出來最小化音色」（2026-11-01）
- 「我說的找重複不是音色重複，是類似壓縮演算法，例如找到聲音裡面的loop區段」（2026-11-01）
- 「好，階段五採用你的建議，先照著順序往下做」（2026-11-01）
- 「請完成每一個就自動發布，並接著往下做」（2026-11-01，經 desktop-app 工作階段轉述）
- 「音色我們可以放到branch或者lazy-loading，避免網頁一進去就占用」（2026-11-01，經 desktop-app 工作階段轉述）
- 標準發布指令（歷來）：「更新網頁，發布patch」「完成就可以更新網頁，發布patch」；態度：「JUST DO IT!」「不要再繼續plan了」。

## 6. 交接流程（自我遞迴）
執行 low-context-long-run 技能（門檻 30%）：每個批次邊界用 `mcp__ccd_session_mgmt__get_usage` 看 context，≥30% 就更新本文件、提交、用 `start_session`（initiation `user_asked`、context `fresh`、工作目錄 `D:\Downloads\videos-嗨投資-desktop-app\desktop-app`、`use_worktree:false`）啟動接手，確認後 `mark_completed`＋`archive_session`（被拒就跳過並告知，不要重試迴圈）。

## 7. 陷阱
- **Roland 版權**：SC-88／Virtual Sound Canvas 的音色不能抽取或散布，只當大小目標。piano-web 的 `gs-engine.js` 檔頭記載使用者先前用過 Nuked-SC55（需要使用者自備 ROM、而且是非商業授權），後來換成 SpessaSynth＋GeneralUser GS，原因就是授權；不要走回頭路。
- piano-web 是獨立專案（`D:\Downloads\SRC\piano-web`，有自己的 git）：只讀；要用的程式「移植」進本專案，不要讓本專案依賴那個資料夾。
- 音色庫 43 MB（base64）絕不能進核心檔；音色與合成引擎都是延遲載入的區塊或使用者下載。
- 轉譜模型多半只能到四軌（人聲／鼓／貝斯／其他）；不要在說明裡承諾能分出任意樂器。
- 遠端編輯要先看現有遠端機制能不能傳「事件」而不是整份檔案，大 MIDI 整份傳會卡。
- 網頁版是離線優先：區塊下載失敗要明確提示、已載入的能用。
- `scripts/embed-code-ui.js` 會把 `floating-assistant.js` 整份重寫（行尾可能被統一）；提交時看 `git diff --stat`。

## 8. 階段 1 學到的坑（handoff 2 新增）
- 離線渲染（OfflineAudioContext＋SpessaSynth）送完事件後要等一下才能 startRendering，否則整段靜音（事件經訊息埠非同步到處理器執行緒）；`renderOffline` 已處理。
- 瀏覽器窗格隱藏時下載與計時會被節流：測試用本機伺服器＋本機音色庫副本；`javascript_tool` 不要回傳大量日誌（進度回呼只存最後一則）。
- `scripts/publish.sh` 會 `git add -A renderer scripts web-lazy`：scripts/ 底下不能放大檔；其他工作階段未提交的檔案也會被帶進去，發布前看 `git status`。
- 本機 python http.server 在這台會回 404（cwd 問題），改用 scratchpad 內的小 node 伺服器（`node srv.js <資料夾>`，埠 8777）。
- 嵌入 `floating-assistant.js` 的模組 factory 取不到另一個嵌入模組要用 `root.X || (typeof X !== "undefined" ? X : undefined)`（見 midi_play.js 開頭）。
- 對 `floating-assistant.js` 的大改用 Write 寫一次性補丁腳本（scratchpad），錨點必須唯一，CRLF/LF 混合所以錨點用單行。
