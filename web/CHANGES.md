# CHANGES.md

`floating-assistant.js`（AI聊天widget，host-agnostic，tw_stock_db/piano-web共用）
的逐日異動摘要。詳細技術細節（涉及的函式/行號/實測數據）見同資料夾的
`DESIGN-INDEX.md`，這份文件只做濃縮版的「今天做了什麼、為什麼」，方便快速掃過
歷史脈絡，不用整份翻`DESIGN-INDEX.md`。新的一天永遠加在最上面。

## 2026-09-14（下午）

背景：使用者回報AI直接呼叫media_av子agent時被告知「沒有工具可以合併多個音檔」
（實際貼了8個file_id的真實工具回應），另外對語音合成子Agent的設定UI提出三點
意見：語音包安裝下拉選單多餘、想要試聽按鈕、想要調整語速；同一則訊息也要求
中文語音API預設enable。

1. **新增`concat_audio`工具**：`_concatAudioFiles`用`OfflineAudioContext`把多個
   已上傳音檔依指定順序解碼、依序排程（`src.start(cursor)`、`cursor+=duration`）
   混流成一軌後用既有`_encodeMp3`編碼，純瀏覽器端、不上傳。註冊進`media_av`
   domain（`toolNames`加入、`systemPrompt`補一句明講不要回報做不到）。
2. **`text_to_speech`新增`speed`參數（0.5~2.0）**：實測確認kokoro-js的
   `engine.generate()`本來就支援`speed`參數（直接讀minified原始碼確認），Edge
   TTS API這邊的Cloudflare Worker `/edge-tts`路由也早就支援`rate`欄位（讀
   `worker.js`確認，不用改worker）——這次只需要把`speed`從`_synthesizeSpeech`
   一路穿到本地Kokoro（含Worker版）跟API路徑（換算成`rate`百分比字串）兩條
   pipeline。新增`advancedSettings.ttsDefaultSpeed`（預設1.0）當使用者沒指定
   speed時的後備值。
3. **`ttsApiEnabled`預設改成`true`**：`_createDefaultAdvancedSettings`與設定
   normalize邏輯都改成「未設定＝啟用，只有明確存過`false`才維持關閉」，呼應
   使用者「中文語音API幫我預設enable」的要求。
4. **語音合成設定UI簡化＋新增試聽/語速**：移除「語音包管理」的安裝下拉選單＋
   安裝按鈕（改成選好預設語音、第一次試聽/合成時自動下載，跟原本的自動下載
   邏輯本來就一致，只是拿掉多餘的手動安裝步驟），本地/API語音的預設語音選單
   旁都加一個「🔊 試聽」按鈕（`_previewTtsVoice`依語言挑一句簡短示範文字，
   用目前語速合成後掛進既有的`_mountAudioPlayer`播放器），新增一個共用的語速
   滑桿（0.5~2.0x）同時控制試聽跟`text_to_speech`預設語速。瀏覽器實測：本地
   Kokoro試聽端到端跑通（真實模型合成、掛出播放器）；語速滑桿調到2.0x時實測
   輸出音檔長度從2.78s變成1.61s（非線性但方向正確，跟先前session量到的
   speed:1.5→1.61倍縮短一致）；API試聽在沒有真實Worker端點時正確顯示錯誤訊息、
   不crash。

## 2026-09-14（上午）

背景：使用者要求`/media-text-to-speech`（以及mp3/wav/ogg類音檔）除了下載連結
還要有真正的播放器；後續實測時發現並回報了兩個相關問題，一併修正。

1. **音檔/影片內建播放器**：新增`_mountMediaPlayer`（這個專案第一個
   `<audio>`/`<video>`元素）——play/pause、可拖曳進度條、回到開頭/跳到結尾、
   目前秒數/總秒數顯示，樣式跟widget既有palette一致。`_downloadFile`交付卡片
   （`_deliverExistingCacheFile`產生的下載訊息）現在音檔自動掛`_mountAudioPlayer`
   （隱藏引擎+全自訂UI）、影片自動掛`_mountVideoPlayer`（可見畫面，
   max-width 360px），兩者共用同一套控制邏輯。
2. **AI直接呼叫媒體工具時檔案沒有交付到對話裡（使用者實測發現的真實bug）**：
   `text_to_speech`/`transcribe_media`/`extract_audio`/`burn_subtitles`/
   `compose_video`這5個工具的callback本身（AI在一般對話或透過`media_av`
   domain委派時走的路徑）從來沒有呼叫過`_deliverExistingCacheFile`——只有
   對應的5個`/media-*`斜線指令會交付檔案，AI自己呼叫工具時使用者完全看不到
   下載連結/播放器，只看得到LLM用文字描述的file_id。新增
   `_deliverToolResultFile`共用helper，5個工具現在都會自動交付檔案，不影響
   斜線指令本身（走不同的程式碼路徑，不會重複交付）。
3. **`/media-text-to-speech`會卡住UI一陣子**：找到並修正`_faLamejsEncode`
   （純JS MP3編碼器）完全同步、沒有任何yield的問題，改成每16個chunk
   `await`一次讓出主執行緒（第一版門檻設200，實測10秒音訊完全沒生效，
   修正為16才真的有效）。⚠️已知限制：這只解決編碼階段的卡頓，本地Kokoro
   TTS模型推論本身（WASM、CPU同步執行）仍可能造成短暫卡頓，徹底解決需要
   把Kokoro搬進Web Worker，這次沒有做。
4. **AI用SSML控制發音，被Kokoro逐字唸出XML標記本身（使用者實測抓到、
   自己聽出來的真實bug）**：使用者要「m m moon」裡的m發「嗯」音，AI試著用
   `<speak><phoneme alphabet="ipa" ph="...">`這類SSML語法控制發音，但這條
   TTS pipeline完全不支援SSML，把整段XML標記原封不動餵給Kokoro，結果被
   逐字唸成「Speak version equals one point o XML and S equals HTTP...」
   長達24秒——這也是問題3那次UI嚴重卡到Chrome跳出「網頁無回應」對話框的
   直接原因（文字被SSML標記撐長很多倍，推論時間跟著大幅拉長）。修正：
   `_synthesizeSpeech`在送進任何引擎之前，先用正規表示式偵測XML/HTML標記
   （`<phoneme ...>`、`<speak ...>`等），偵測到就直接拒絕並回傳明確錯誤
   （不接受SSML、要求改用純文字/同音近似拼法），不會再讓引擎默默把垃圾
   標記唸出一大段音檔；`text_to_speech`工具的description也同步補充明講
   不支援SSML。
5. **Kokoro TTS搬進Web Worker，真正解決卡頓根因（不再只是已知限制）**：
   模型推論`engine.generate()`（WASM、CPU、完全同步）原本佔用主執行緒，
   這次搬進持久化的module worker（`FA_TTS_WORKER_SRC`），worker基礎設施
   有問題時自動退回main thread（完整保留原本邏輯當fallback）。實測：真實
   模型透過worker完整合成一次，main thread在~23.7秒合成期間完全沒被卡住
   （interval tick正常持續觸發，對照問題3修lamejs前「完全卡住、0 tick」
   的量測方法）。
6. **同一輪內AI連續呼叫text_to_speech等工具，只保留最後一個結果**：延伸
   既有「同一輪內同類型視覺輸出只留最後一次」機制（`_markSupersededVisualDrafts`）
   到`_downloadFile`（音檔/影片/其他交付檔案），較早的版本自動收合成
   草稿卡（預設隱藏），不會每次都各自顯示一張完整卡片。
7. **AI回應中途重繪會打斷正在播放的音檔/影片、重設3D viewer視角**：
   `_renderMessageHistory()`每次都整個清空重繪所有訊息，音檔/影片播放器
   跟3D viewer完全沒有「這則訊息沒變、不用重新掛載」的判斷，每次工具呼叫
   觸發的重繪都會讓播放位置歸零、3D視角被重設回預設值。新增
   `this._liveWidgetCache`（WeakMap），這兩種「有live互動狀態」的widget
   類型改成重用已掛載的DOM節點，不重新建立——實測確認重繪前後是**同一個
   物件參照**，播放位置/3D視角真的被保留。

## 2026-09-13

背景：使用者計畫把floating-assistant.js整合進piano-web（鋼琴多音軌編輯器），並
預期piano-web未來會需要大量（上百種）音樂曲風的subagent。今天圍繞著「怎麼讓
subagent機制撐得住這種規模、同時不污染主對話」這個主軸做了兩項延伸。

1. **Skill(自訂工具)改走subagent domain委派，不再無條件掛根層級**
   （commit `c9740921`）
   - Advance Settings「Skill」分頁的自訂工具（`advancedSettings.customTools`）
     原本無條件曝光在根層級對話工具清單，Skill越加越多會稀釋根模型注意力/塞爆
     system prompt。改成新增一個`custom_skills`虛擬domain（`toolNames`即時讀
     `advancedSettings.customTools`），跟9/6~9/9做好的內建工具domain委派機制
     共用同一套路由/執行邏輯——`router`/`full`模式下Skill不再無條件曝光，只能
     透過`delegate_to_subagent`委派給子agent按需查詢/呼叫；`off`模式（沒有
     subagent機制）維持直接掛根層級不變。
   - 新增`_importSkillFolder`（File System Access API）：除了既有的`.skill`
     zip附件匯入，現在也能直接選一個本機資料夾（結構跟zip解開後一樣：
     `SKILL.md`+`tools/*.js`）匯入，不用先手動打包成zip。刻意不持久化授權、
     不自動重新掃描——每次都是使用者主動選一次資料夾的單次匯入動作。
   - 順便確認（沒有改code）：RAG知識圖譜（`rag_lookup`domain）在這套委派機制下
     依然可用——路由子agent本來就能一次選多個domain，任務需要「Skill+過去成功
     案例/關聯經驗」時，`custom_skills`跟`rag_lookup`會被合併進同一次委派，實測
     驗證過。

2. **兩層domain路由（類別→細分domain）+ subagent執行中動態追加工具**
   （commit `f0dced72`）
   - 新增`multiSubAgentMode`第4個值`'hierarchical'`：domain數大到像「上百種
     曲風」這種規模時，既有的扁平單層路由（一次列出全部domain目錄）會塞爆
     路由子agent的注意力。改成選配的兩層路由——先選「類別」，選中的類別再
     各自平行問一次「該用哪個細分domain」。用tw_stock_db共用金鑰模式對
     `nvidia/nemotron-3-super-120b-a12b`做過真實LLM benchmark：45個domain時
     兩層式省58%路由token、但延遲多6-7秒；精準度測試裡扁平模式在45個domain
     時真的漏判一題，兩層式全對——這組實測數據是把它做成「選配」而非取代
     既有模式的依據，domain少時不建議用。
   - 新增`register_domain_category`+`register_domain`的`category`選填參數，
     讓host頁面（piano-web之後可以自己註冊）能把domain分類。
   - 新增`request_additional_tools`偽工具：子agent執行到一半才發現需要一個
     原本沒拿到的domain工具時，可以在**同一次執行**裡原地申請追加（直接擴充
     這次執行的可用工具清單、下一輪立刻生效），不需要跳出去重新委派一次
     整個流程——避免使用者擔心的「查完GitHub才發現要查wiki」這類多階段任務
     卡在工具不夠用。有申請次數上限（3次）防止失控。
   - 路由prompt同步補一句引導：任務如果是多階段的，路由時要盡量把預期會用到
     的domain一次選齊，降低事後才發現不夠的機率（零額外LLM往返成本的prompt
     wording調整，不是加一輪驗證呼叫）。

3. **快速設定面板整併進Advance設定對話框 + 子Agent執行進度可視化**
   - 使用者回報：開啟「顯示工具呼叫追蹤與思考過程」後還是看不到委派出去的
     子agent在忙什麼——因為`_runSubAgentTask`從以前開始就完全靜默執行，過程
     故意不碰主對話的訊息陣列。新增`options.onProgress`回呼＋
     `_createSubagentProgressWidget`，只在「顯示工具呼叫追蹤與思考過程」開啟
     時才在對話裡顯示一張即時更新的進度卡片（判斷委派給哪個領域、每輪呼叫了
     哪個工具、有沒有申請追加工具），關閉時維持完全靜默、零回歸。
   - 同時把原本散落在⚙️快速設定面板的設定（API KEY/URL/MODEL NAME、生成/
     取樣參數、Hermes自我演化、slash選單、顯示追蹤）全部搬進Advance設定
     對話框，新增三個分頁放在最前面：「LLM 基礎設定」「LLM 生成取樣參數」
     「LLM Debug」。快速設定面板整個移除，⚙️改成直接開啟Advance對話框。

兩項今天都只做在`floating-assistant.js`這個共用引擎本身，piano-web實際要用
（幫每個曲風`register_domain`帶`category`、累積曲風knowledge等）是piano-web
之後自己要做的事，這次沒有處理piano-web的實際曲風資料/MIDI分類管線。
