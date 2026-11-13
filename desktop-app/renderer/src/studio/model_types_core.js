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
    { id: 'music', name: '音樂作曲（輸出音符）', status: 'design',
      summary: '依指定的風格與長度作曲，輸出音符資料。目前只能用既有的作曲模型推論。',
      sources: [], backends: [],
      outputs: [{ id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '沒有作曲模型的訓練核心與音符資料格式。' }, { id: 'full', label: '完整模型', available: false, formats: [], reason: '沒有可以匯出的作曲模型格式。' }],
      gap: '缺：訓練核心、音符訓練資料格式、匯出路徑。已有：瀏覽器內的作曲推論。',
      can: [], cannot: ['訓練作曲模型', '匯出作曲模型'] },
    { id: 'speech_recognition', name: '語音辨識（聽寫成文字）', status: 'design',
      summary: '把錄音聽寫成文字。目前只有既有的聽寫推論。',
      sources: [], backends: [],
      outputs: [{ id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '沒有語音辨識的訓練核心。' }, { id: 'full', label: '完整模型', available: false, formats: [], reason: '沒有語音辨識的訓練與匯出路徑。' }],
      gap: '缺：訓練核心、標註資料格式、匯出路徑。已有：既有的聽寫推論。',
      can: [], cannot: ['訓練語音辨識模型'] },
    { id: 'audio_to_notes', name: '音訊轉音符（把錄音轉成樂譜）', status: 'design',
      summary: '把錄音轉成音符。目前只有既有的轉換管線推論。',
      sources: [], backends: [],
      outputs: [{ id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '沒有音訊轉音符的訓練核心與配對資料。' }, { id: 'full', label: '完整模型', available: false, formats: [], reason: '沒有可匯出的訓練成果。' }],
      gap: '缺：訓練核心、音訊與音符配對資料格式、匯出路徑。已有：轉換管線推論。',
      can: [], cannot: ['訓練音訊轉音符模型'] },
    { id: 'image', name: '圖像生成（SDXS 類快速模型）', status: 'done',
      summary: '用你的圖文配對（圖片加文字描述），在電腦處理器上訓練 SDXS 類快速模型的 LoRA 小檔，疊在基底模型上依文字畫圖。',
      sources: ['圖文配對（每行一筆的 .jsonl 檔：圖片相對路徑加文字描述）'], backends: [{ id: 'cpu-py', label: '純處理器（Python，桌面版）' }],
      outputs: [
        { id: 'lora', label: 'LoRA 小檔（疊在 SDXS 基底上）', available: true, formats: ['LoRA 檔（格式版本 1）'], note: '只在注意力層的查詢、鍵、值、輸出加小矩陣。純處理器上每步約 20 秒（512 解析度）。' },
        { id: 'full', label: '完整模型（合併匯出）', available: false, formats: [], reason: '還沒有 SDXS 的完整模型匯出路徑（ONNX／GGUF 的合併與驗證都沒做）。目前只輸出 LoRA。' },
      ],
      gap: '未做：LoRA 套用到網頁或桌面的 ONNX 生圖執行、完整模型匯出、工作室介面接上訓練按鈕。已做：純處理器訓練、LoRA 檔載入與同種子前後比對（見設計文件的已驗證段落）。',
      can: ['訓練 SDXS 512 的 LoRA 小檔（純處理器）'], cannot: ['輸出完整模型', '在 ONNX 執行環境套用 LoRA（未驗證）'] },
    { id: 'vision', name: '看圖說文字（視覺語言模型）', status: 'design',
      summary: '看圖回答或描述圖片。目前只有既有的看圖推論。',
      sources: [], backends: [],
      outputs: [{ id: 'lora', label: 'LoRA 小檔', available: false, formats: [], reason: '沒有視覺語言模型的訓練核心與圖文問答格式。' }, { id: 'full', label: '完整模型', available: false, formats: [], reason: '沒有視覺語言模型的訓練與匯出路徑。' }],
      gap: '缺：訓練核心、圖文問答資料格式、匯出路徑。已有：看圖推論。',
      can: [], cannot: ['訓練視覺語言模型'] },
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
