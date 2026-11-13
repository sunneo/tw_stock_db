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
    { id: 'speech', name: '語音合成（念出文字）', status: 'half',
      summary: '把文字念成聲音。語音樣本的錄音、清理與切段已經有，但還沒有訓練核心。',
      sources: ['語音錄音樣本（整理切段、去雜音）'], backends: [],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '還沒有語音合成的訓練核心，也沒有訓練資料格式。' },
        { id: 'full', label: '完整模型', available: false, formats: [], reason: '還沒有可以合併匯出的語音合成模型。' } ],
      gap: '缺：訓練核心、訓練資料格式、匯出路徑。已有：錄音、樣本清理與切段，以及語音合成的推論。',
      can: ['整理語音樣本（錄音、清理、切段）'], cannot: ['訓練語音合成模型', '匯出語音合成模型'] },
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
    { id: 'audio_to_notes', name: '音訊轉音符（把錄音轉成樂譜）', status: 'half',
      summary: '把錄音轉成音符。轉譜模型的全參數微調已用命令列實測，工作室按鈕還沒接上。',
      sources: ['音訊與音符配對（可由命令列產生已知音符的合成資料）'], backends: [],
      outputs: [{ id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '這個類型微調的是整個轉譜模型，不產生 LoRA 小檔。' },
        { id: 'full', label: '完整模型（ONNX）', available: false, formats: ['ONNX（形狀與原檔相同，可直接給轉譜管線使用）'], reason: '微調後的模型還沒有收進工作室資產，也沒有接到應用程式的轉譜管線；換用需要新的模型登錄項與發佈，還沒做。' }],
      gap: '已有：微調核心（命令列）、合成資料產生器、用 ONNX 執行器載入與比對。實測：在 100 段留出的合成資料上，應用程式自己的解碼器，音符準確度（精確率與召回率的調和平均）由 0.735 升到 0.941。缺：真實錄音的驗證；工作室按鈕與接線；新模型的登錄與發佈（應用程式目前仍用原版）。',
      can: ['用命令列微調轉譜模型（處理器，約 3 分鐘／300 步）', '匯出 ONNX 並用執行器重新載入'], cannot: ['從工作室按鈕開始訓練', '在應用程式內換用微調後的模型', '用真實錄音驗證準確度'] },
    { id: 'image', name: '圖像生成（SDXS 類快速模型）', status: 'half',
      summary: '用你的圖文配對（圖片加文字描述），在電腦處理器上訓練 SDXS 類快速模型的 LoRA 小檔，疊在基底模型上依文字畫圖。',
      sources: ['圖文配對（每行一筆的 .jsonl 檔：圖片相對路徑加文字描述）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔（疊在 SDXS 基底上）', available: true, formats: ['LoRA 檔（格式版本 1）'], note: '只在注意力層的查詢、鍵、值、輸出加小矩陣。純處理器上每步約 20 秒（512 解析度）。' },
        { id: 'full', label: '完整模型（合併匯出）', available: false, formats: [], reason: '還沒有 SDXS 的完整模型匯出路徑（ONNX／GGUF 的合併與驗證都沒做）。目前只輸出 LoRA。' },
      ],
      gap: '缺：LoRA 套用到網頁或桌面的 ONNX 生圖執行、完整模型匯出、工作室介面接上訓練按鈕。已有：純處理器訓練、LoRA 檔載入與同種子前後比對（見設計文件的已驗證段落）。',
      can: ['訓練 SDXS 512 的 LoRA 小檔（純處理器）'], cannot: ['輸出完整模型', '在 ONNX 執行環境套用 LoRA（未驗證）'] },
    { id: 'vision', name: '看圖說文字（視覺語言模型）', status: 'half',
      summary: '看圖回答或描述圖片。已有小型看圖模型的 LoRA 訓練核心（命令列，用電腦處理器就能跑；資料格式、評量與匯出都實測過）。工作室的介面還沒接上，所以按鈕不會產生模型。',
      sources: ['圖文問答資料（一行一筆的 .jsonl，圖片用相對路徑，加上兩則訊息）'], backends: [],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '命令列可以訓練並匯出 LoRA（已實測），但工作室的介面還沒有接上看圖訓練，按開始不會執行它。' },
        { id: 'full', label: '完整模型', available: false, formats: [], reason: '命令列可以把 LoRA 併回基底並匯出權重檔（已實測），但工作室還沒有接上這條匯出路徑。' } ],
      gap: '缺：工作室的訓練按鈕與資料匯入（目前只能用命令列）、匯出進工作室資產的路徑、網頁版執行。已有：命令列訓練核心、圖文問答格式與檢查、評量、併回匯出。',
      can: ['命令列訓練看圖 LoRA（小型看圖模型，用電腦處理器，不需要顯示卡）', '命令列把 LoRA 併回基底，匯出完整模型的權重檔'], cannot: ['在工作室按鈕訓練看圖模型', '把看圖模型存成工作室資產'] },
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
