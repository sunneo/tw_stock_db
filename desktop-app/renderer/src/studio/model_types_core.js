/* 模型類型登錄表（純函式，UMD，node 可測）。工作室「訓練」分頁的模型類型選單、說明卡片與開始守門，全部從這裡產生；
 * 之後新增類型只改 TYPES（不必改介面程式）。
 * 狀態（status）：
 *   done   ＝ 已完成可用（有訓練核心、資料格式與匯出路徑）。不受「顯示半成品的功能」影響，一律顯示。
 *   half   ＝ 半成品（有部分資料準備或推論，缺訓練核心）。設定頁開啟「顯示半成品的功能」才顯示，標「半成品」。
 *   design ＝ 只有設計（目前只有推論，沒有訓練核心）。同樣要開啟才顯示，標「只有設計」。
 * 輸出（outputs）：lora＝LoRA 小檔（疊在基底上）；full＝完整模型（合併匯出，格式見 formats）。
 * 守門：canStart(typeId, outputId, showHalf) 回傳 { level: 'run'|'partial'|'blocked', ok, message, can[], cannot[] }。
 *   done 且輸出可用 → run；half → partial（說明目前能做到哪一步，不假裝能訓練）；design／輸出不可用 → blocked（寫原因與替代做法）。
 * 測試：renderer/src/studio/model_types_core.test.js。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaStudioModelTypes = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var STATUS_LABEL = { done: '已完成可用', half: '半成品', design: '只有設計' };
  var TYPES = [
    { id: 'llm', name: '語言模型', status: 'done', goal: 'lora',
      summary: '用你的對話或問答資料，訓練一顆小的語言模型調整檔（LoRA），或把它併回基底模型，匯出完整模型。',
      sources: ['資料匯入產生的資料集（.jsonl，每行一筆）', '已匯入或內建的資料集'],
      backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }, { id: 'wasm-web', label: '網頁處理器（頁內 WebAssembly，慢但正確）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔（疊在基底上）', available: true, formats: ['工作室資產（.fatrain 可匯出）'], note: '檔案小，可以跟其他 LoRA 一起套用（最多同時幾顆見「LoRA 登錄」）。' },
        { id: 'full', label: '完整模型（合併匯出）', available: true, formats: ['ONNX q8（桌面版預設）', 'GGUF Q8_0（llama.cpp）'], note: '先訓練 LoRA，再到進階模式最下方的匯出區（ONNX／GGUF）併回基底。目前是手動的第二步，只在桌面版執行。' },
      ],
      can: ['訓練 LoRA 小檔', '併回基底匯出完整模型（ONNX／GGUF，桌面版）'], cannot: [] },
    { id: 'symbolic', name: '離線訓練器（積木課、矩陣層、UML、CoLU、訓練器本身）', status: 'done', goal: 'symbolic',
      summary: '符號式的訓練：用題目與回饋重訓排名模型、整理積木課或矩陣層的操作。結果存成工作室資產。',
      sources: ['題目資產（積木課、矩陣層）', '情境配對（UML）', '採用／退回回饋（CoLU）'],
      backends: [{ id: 'cpu-js', label: '處理器（不需要安裝任何東西）' }],
      outputs: [{ id: 'asset', label: '工作室資產', available: true, formats: ['工作室資產'], note: '' }],
      can: ['訓練後存成工作室資產'], cannot: [] },
    { id: 'speech', name: '語音合成（念出文字）', status: 'done', ext: 'speech',
      summary: '把文字念成聲音。以語音合成基底模型與一個基底語音包為起點，只訓練語音包的風格偏移（256 維），其餘權重凍結。輸出是一個與語音包同格式的檔案。',
      sources: ['配對資料夾（每行一筆的 .jsonl 訓練檔與留出檔，附錄音；錄音由基底模型合成，不需要你另外錄）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: '風格偏移小檔（語音包）', available: true, formats: ['語音包檔（與基底同格式，522,240 位元組）'], note: '只改語音包的風格，不是 LoRA，也不是整個模型的微調。' },
        { id: 'full', label: '完整模型', available: false, formats: [], reason: '沒有整個語音合成模型的微調與匯出路徑。' } ],
      gap: '實測：30 步，留出句的損失由 2.103 降到 1.308；合成一句並核對可以載入。限制：只看留出句的損失，沒有主觀聆聽評分；訓練資料是基底模型自己合成的音訊；風格偏移只有 256 個數字。',
      can: ['從工作室按開始訓練風格偏移（處理器，30 步約 1 分鐘）', '訓練完合成一句並核對'], cannot: ['訓練整個語音合成模型', '匯出完整語音合成模型'] },
    { id: 'music', name: '音樂作曲（輸出音符）', status: 'done', ext: 'music',
      summary: '依程式作曲的旋律資料，從零開始訓練一個小型作曲模型（約 46 萬參數），訓練後取樣並核對重新載入的結果。不是預訓練模型的微調，也不是用真實作曲資料訓練。',
      sources: ['作曲資料（程式作曲產生，自動準備，不需要你另外提供資料）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '這個類型訓練的是從零開始的小型模型，不產生 LoRA 小檔。' },
        { id: 'full', label: '完整模型（權重與設定）', available: true, formats: ['權重檔加設定檔與詞彙表'], note: '輸出放在工作室的外部訓練資料夾，還沒有收進工作室資產，也還沒接到作曲流程。' } ],
      gap: '實測：留出 90 首，損失由 4.756 降到 1.150；取樣 36 首中語法合格由 2 首升到 27 首；從磁碟重新載入後 36 首逐首相同。限制：只在程式作曲的資料上驗證，沒有和真實作曲比較過音樂品質；輸出還沒進工作室資產；作曲流程不會換用訓練出的模型。',
      can: ['從工作室按開始訓練（產生資料、訓練、重新載入核對；處理器約 1 分鐘）', '輸出權重、設定、詞彙表與取樣樣本'], cannot: ['用真實作曲資料訓練', '在作曲流程中換用訓練出的模型', '把輸出收進工作室資產'] },
    { id: 'speech_recognition', name: '語音辨識（聽寫成文字）', status: 'done', ext: 'speech_recognition',
      summary: '把錄音聽寫成文字。以小型語音辨識基底（39M 參數）為底，只在注意力的查詢與值投影掛 LoRA 小檔，用處理器訓練。',
      sources: ['語音辨識資料（每行一筆的 .jsonl 檔：16 千赫、單聲道的錄音相對路徑、參考文字、切分）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔', available: true, formats: ['LoRA 小檔（資料夾內含權重與設定）'], note: '注意：驗證集的字錯率沒有下降（實測 15.81%→15.81%；120 步反而變差到 17.28%）。損失下降不代表辨識變好。' },
        { id: 'full', label: '完整模型', available: false, formats: [], reason: '還沒有把 LoRA 併回基底的匯出路徑。' } ],
      gap: '實測：40 步訓練損失由 1.061 降到 0.053；同設定重新載入後的輸出與訓練時逐位元相同。限制：字錯率沒有下降；LoRA 還沒接進應用程式的聽寫流程；輸出還沒進工作室資產。',
      can: ['從工作室按開始訓練 LoRA（處理器，40 步約 30 秒）', '訓練完重新載入並核對輸出'], cannot: ['把語音辨識 LoRA 併回基底匯出完整模型', '在應用程式內換用這個 LoRA'] },
    { id: 'audio_to_notes', name: '音訊轉音符（把錄音轉成樂譜）', status: 'done', ext: 'audio_to_notes',
      summary: '把錄音轉成音符。以轉譜模型為底，全參數微調（凍結前端的頻譜特徵層），匯出 ONNX，形狀與原檔相同。',
      sources: ['合成資料（已知音符的鋼琴式音色，由程式產生，不需要你準備資料）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '這個類型微調的是整個轉譜模型，不產生 LoRA 小檔。' },
        { id: 'full', label: '完整模型（ONNX）', available: true, formats: ['ONNX（形狀與原檔相同）'], note: '輸出放在外部訓練資料夾，還沒有收進工作室資產；應用程式的轉譜流程仍用原版模型。' } ],
      gap: '實測（300 步，約 25 秒）：合成訓練 200 段、留出 40 段；訓練腳本的音符準確度由 0.927 升到 0.957；匯出的模型可以重新載入。先前紀錄：應用程式解碼器在留出 100 段上由 0.735 升到 0.941。限制：只有合成資料；沒有真實錄音驗證；還沒接進應用程式。',
      can: ['從工作室按開始微調（產生資料、訓練、匯出並重新載入核對；處理器約 25 秒）', '輸出 ONNX 模型'], cannot: ['用真實錄音訓練或驗證', '在應用程式內換用微調後的模型'] },
    { id: 'image', name: '圖像生成（SDXS 類快速模型）', status: 'done', ext: 'image',
      summary: '用合成的圖文配對，在 SDXS 快速模型上訓練 LoRA 小檔（只掛在注意力層），疊在基底上依文字畫圖。',
      sources: ['圖文配對（由程式合成的圖與描述，不需要你準備資料）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔（疊在 SDXS 基底上）', available: true, formats: ['LoRA 檔（格式版本 1）'], note: '同種子前後比對，以及從檔案重新載入的結果都逐位元相同（實測）。' },
        { id: 'full', label: '完整模型（合併匯出）', available: false, formats: [], reason: '還沒有 SDXS 的完整模型匯出路徑（合併與驗證都沒做）。目前只輸出 LoRA。' } ],
      gap: '實測（40 步，訓練 35 秒）：重複生圖與跨程序生圖逐位元相同；LoRA 確實改變了輸出（平均像素差 94／255）。這只說明 LoRA 有作用，不代表畫得好。限制：只用合成資料，沒有人工評量；LoRA 還沒有接進網頁或桌面的 ONNX 生圖執行環境（未驗證）。',
      can: ['從工作室按開始訓練 LoRA（處理器，512 解析度，約 1 秒／步）', '訓練完生一張圖核對'], cannot: ['輸出完整模型', '在 ONNX 生圖執行環境套用 LoRA（未驗證）'] },
    { id: 'vision', name: '看圖說文字（視覺語言模型）', status: 'done', ext: 'vision',
      summary: '看圖回答或描述圖片。以小型看圖模型為底，只掛 LoRA 小檔。資料由程式合成（顏色與形狀的圖），留出的顏色與形狀組合不進訓練。',
      sources: ['合成的圖文問答（由程式產生，不需要你準備資料）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔', available: true, formats: ['LoRA 資料夾（權重與設定）'], note: '評量只看顏色與形狀是否說對，沒有人工評量。' },
        { id: 'full', label: '完整模型', available: false, formats: [], reason: '還沒有併回基底的匯出路徑接進工作室（合併匯出的腳本存在，但沒有驗證）。' } ],
      gap: '實測（300 步，約 4.4 分鐘）：合成的留出 12 題，顏色、形狀與兩者都對都是 12/12（100%）；4 步冒煙時是 0.58。限制：只有合成資料，題型很單純；只評量顏色與形狀；沒有人工評量。',
      can: ['從工作室按開始訓練 LoRA（處理器，約 1 秒／步）', '載入 LoRA 重跑留出題'], cannot: ['輸出完整模型', '在應用程式內換用這個 LoRA'] },
    { id: 'llm_scratch', name: '建立語言模型（從零開始）', status: 'done', ext: 'llm_scratch',
      summary: '從語料開始建一顆語言模型：清理語料 → 訓練分詞器（位元組級合併，繁體中文）→ 預訓練 → 指令微調（聊天樣板）→ 匯出 ONNX q8 → 重新載入核對。模型是 Qwen3 同型（約 1 千 3 百萬到 2 千萬參數），應用程式的原生執行環境能直接載入。',
      sources: ['你自己的文字檔或資料夾；留空＝內建小語料（只夠示範）', '指令微調資料（每行一筆對話的 .jsonl）；留空＝內建 34 筆範例'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '這個類型是從零開始建整顆模型，不產生 LoRA 小檔。要在這顆模型上訓練 LoRA，請用輸出裡的標準格式資料夾當基底，走「語言模型」類型。' },
        { id: 'full', label: '完整模型（ONNX q8 與標準格式）', available: true, formats: ['ONNX q8（模型檔加分詞器檔）', '標準 Qwen3 格式（safetensors、設定檔、分詞器檔）'], note: '輸出放在外部訓練資料夾；還沒有自動收進「離線模型」清單，要手動複製到離線模型資料夾。GGUF 沒做。' } ],
      gap: '實測（迷你 13,480,288 參數，語料 1.6 百萬字，只訓練 150 步、約 7.7 萬個詞元）：分詞器在留出文字上 3.19 位元組／詞元（1.73 字／詞元），編碼後可還原；預訓練留出損失 8.336→7.224（困惑度 4170→1372）；指令微調留出損失 8.263→6.598（困惑度 3877→734）；ONNX 全精度與訓練框架的輸出最大差約百萬分之二，q8 與全精度的貪婪輸出一致；重新載入逐字一致；原生執行環境載入並回答一題，兩次獨立程序輸出相同。限制：模型訓練得太少，生成的文字是重複的標點（不是能回答的助理）；指令微調只有 34 筆範例；模型只能調寬度（原生執行環境寫死層數、鍵值頭數與每頭維度）；結束標記不在原生執行環境的停止清單裡，會生成到字數上限；只在忙碌的機器上量過時間。',
      can: ['從工作室按開始，跑完清理、分詞器、預訓練、指令微調、匯出、核對（處理器；預設約 2 小時，實測在忙碌機器上）', '輸出 ONNX q8 與標準格式，兩者都用另一條路徑載入核對過', '用自己的語料與指令微調資料'], cannot: ['訓練出能可靠回答問題的模型（需要數十倍以上的詞元與時間）', '輸出 GGUF', '改層數、鍵值頭數或每頭維度（原生執行環境寫死）', '自動註冊進離線模型清單'] },
  ];

  function find(id) { for (var i = 0; i < TYPES.length; i++) if (TYPES[i].id === id) return TYPES[i]; return null; }
  function isVisible(t, showHalf) { return t.status === 'done' || showHalf === true; }
  // 介面用的清單：已完成的一律有；半成品與只有設計的要開啟開關。每筆帶 badge（已完成沒有徽章）與 label（下拉選單用）
  function listFor(showHalf) {
    return TYPES.filter(function (t) { return isVisible(t, showHalf); }).map(function (t) {
      return { id: t.id, name: t.name, status: t.status, badge: t.status === 'done' ? '' : STATUS_LABEL[t.status], label: t.name + (t.status === 'done' ? '' : '（' + STATUS_LABEL[t.status] + '）'), summary: t.summary, sources: t.sources.slice(), backends: t.backends.slice(), outputs: t.outputs.map(function (o) { return Object.assign({}, o, { formats: (o.formats || []).slice() }); }), gap: t.gap || '', can: t.can.slice(), cannot: t.cannot.slice(), goal: t.goal || null };
    });
  }
  // 守門：決定按「開始」時能不能真的訓練、能做到哪一步
  function canStart(typeId, outputId, showHalf) {
    var t = find(typeId);
    if (!t) return { level: 'blocked', ok: false, message: '找不到這個模型類型（' + typeId + '）。請重新選擇。', can: [], cannot: [] };
    if (!isVisible(t, showHalf)) return { level: 'blocked', ok: false, message: '「' + t.name + '」是' + STATUS_LABEL[t.status] + '，要先到設定開啟「顯示半成品的功能」才能選。', can: [], cannot: [] };
    if (t.status === 'done') {
      var o = t.outputs.filter(function (x) { return x.id === outputId; })[0] || t.outputs[0];
      if (o.available) return { level: 'run', ok: true, message: '可以訓練：' + t.name + '，輸出「' + o.label + '」。', can: t.can.slice(), cannot: [] };
      return { level: 'blocked', ok: false, message: '「' + o.label + '」目前不能輸出：' + (o.reason || '還沒有這種輸出。') + '請改選其他輸出。', can: t.can.slice(), cannot: [] };
    }
    if (t.status === 'half') return { level: 'partial', ok: false, message: '「' + t.name + '」目前是半成品，工作室還不能產生模型。目前能做到：' + t.can.join('；') + '。還不能做：' + t.cannot.join('；') + '。' + t.gap, can: t.can.slice(), cannot: t.cannot.slice() };
    return { level: 'blocked', ok: false, message: '「' + t.name + '」目前只有設計，還沒有訓練核心，不會產生任何檔案。' + t.gap, can: [], cannot: t.cannot.slice() };
  }
  return { TYPES: TYPES, STATUS_LABEL: STATUS_LABEL, find: find, listFor: listFor, canStart: canStart, isVisible: isVisible };
});
