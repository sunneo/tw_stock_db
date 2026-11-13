/* 語音合成訓練的資料格式與驗證（純函式，UMD，node 可測）。
 * 訓練本身在 lora-train/speech/speech_train.py（PyTorch，CPU）；這裡負責：
 *   1. 配對資料（JSONL，每行一句：文字、音素、音訊檔、取樣率、教師時長）的解析與驗證；
 *   2. 訓練／留出的切分，並擋住「留出句與訓練句相同」的洩漏；
 *   3. 語音包 .bin 的大小與形狀（510 列 × 256 維 float32，522,240 位元組，與 Kokoro 的 voices/*.bin 相同格式）；
 *   4. 訓練摘要（summary.json）的檢查：格式、留出損失是否下降、檔案雜湊格式。
 * 不做任何數值運算的訓練；損失下降與否以 Python 實測紀錄為準，這裡只檢查紀錄的格式與一致性。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaSpeechCore = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SR = 24000;
  var VOICE_ROWS = 510;
  var STYLE_DIM = 256;
  var VOICE_BIN_BYTES = VOICE_ROWS * STYLE_DIM * 4;
  var SPLITS = ['train', 'heldout'];

  // 語音包大小檢查（.bin）。回傳 { ok, reason }，不丟例外。
  function checkVoiceBinSize(bytes) {
    if (typeof bytes !== 'number' || !isFinite(bytes)) return { ok: false, reason: '大小不是數字' };
    if (bytes !== VOICE_BIN_BYTES) return { ok: false, reason: '語音包大小是 ' + bytes + ' 位元組，應為 ' + VOICE_BIN_BYTES + '（510 列 × 256 維 float32）' };
    return { ok: true, reason: '' };
  }

  // 把一行 JSON 解析成資料列並驗證。錯誤回報行號。
  function parseDatasetJsonl(text) {
    var rows = [], errors = [], seen = {};
    String(text || '').split(/\r?\n/).forEach(function (line, i) {
      if (!line.trim()) return;
      var r;
      try { r = JSON.parse(line); } catch (e) { errors.push({ line: i + 1, reason: '不是合法 JSON' }); return; }
      var why = checkRow(r);
      if (!why && seen[r.id]) why = 'id 重複：' + r.id;
      if (why) { errors.push({ line: i + 1, reason: why }); return; }
      seen[r.id] = true;
      rows.push(r);
    });
    return { rows: rows, errors: errors };
  }

  // 單列檢查。回傳空字串＝通過，否則是原因。
  function checkRow(r) {
    if (!r || typeof r !== 'object') return '不是物件';
    if (typeof r.id !== 'string' || !r.id) return '缺 id';
    if (typeof r.text !== 'string' || !r.text.trim()) return '文字是空的';
    if (typeof r.phonemes !== 'string' || !r.phonemes) return '缺音素（phonemes）';
    if (typeof r.audio !== 'string' || !r.audio || /^(\/|[a-zA-Z]:|\\)/.test(r.audio) || r.audio.split(/[\\/]/).indexOf('..') >= 0) return '音訊路徑必須是資料夾內的相對路徑';
    if (r.sr !== SR) return '取樣率必須是 ' + SR + '，實際 ' + r.sr;
    if (SPLITS.indexOf(r.split) < 0) return 'split 只能是 train 或 heldout';
    if (!Array.isArray(r.pred_dur) || !r.pred_dur.length) return '缺教師時長（pred_dur）';
    for (var i = 0; i < r.pred_dur.length; i++) { var d = r.pred_dur[i]; if (typeof d !== 'number' || d < 1 || Math.floor(d) !== d) return '時長必須是正整數'; }
    return '';
  }

  // 切分：訓練與留出各取 split 欄位。留出句（文字）若出現在訓練中，直接拒絕（洩漏）。
  function splitRows(rows) {
    var train = rows.filter(function (r) { return r.split === 'train'; });
    var heldout = rows.filter(function (r) { return r.split === 'heldout'; });
    if (!train.length) return { ok: false, reason: '沒有訓練句', train: [], heldout: [] };
    if (!heldout.length) return { ok: false, reason: '沒有留出句（至少要有一句用來量泛化）', train: train, heldout: [] };
    var trainText = {};
    train.forEach(function (r) { trainText[r.text.trim()] = true; });
    var leak = heldout.filter(function (r) { return trainText[r.text.trim()]; }).map(function (r) { return r.id; });
    if (leak.length) return { ok: false, reason: '留出句與訓練句文字相同（洩漏）：' + leak.join('、'), train: train, heldout: heldout };
    return { ok: true, reason: '', train: train, heldout: heldout };
  }

  // 損失趨勢：前段平均與後段平均比較。losses 是數字陣列（依步數排序）。
  function lossTrend(losses) {
    var xs = (losses || []).filter(function (x) { return typeof x === 'number' && isFinite(x); });
    if (xs.length < 2) return { ok: false, reason: '損失點不足 2 個', decreased: false, ratio: null };
    var k = Math.max(1, Math.floor(xs.length / 4));
    var head = mean(xs.slice(0, k)), tail = mean(xs.slice(xs.length - k));
    return { ok: true, reason: '', decreased: tail < head, ratio: head > 0 ? tail / head : null, head: head, tail: tail };
  }
  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : NaN; }

  // 訓練摘要（summary.json）檢查：格式、留出損失是否真的下降、語音包與雜湊。
  function verifySummary(s) {
    var errs = [];
    if (!s || s.format !== 'fa-speech-style') errs.push('格式不是 fa-speech-style');
    if (!s || s.version !== 1) errs.push('版本不是 1');
    if (s && !(s.steps > 0)) errs.push('步數必須大於 0');
    if (s && !(s.train_rows > 0 && s.heldout_rows > 0)) errs.push('訓練與留出句數必須都大於 0');
    if (s && !(typeof s.heldout_loss_before === 'number' && typeof s.heldout_loss_after === 'number')) errs.push('缺留出損失');
    else if (s && !(s.heldout_loss_after < s.heldout_loss_before)) errs.push('留出損失沒有下降（before ' + s.heldout_loss_before + '，after ' + s.heldout_loss_after + '）');
    var vb = s && s.voice_bin;
    var sizeOk = checkVoiceBinSize(vb && vb.bytes);
    if (!sizeOk.ok) errs.push(sizeOk.reason);
    if (!vb || !/^[0-9a-f]{64}$/.test(vb.sha256 || '')) errs.push('語音包 sha256 格式不對');
    return { ok: errs.length === 0, errors: errs };
  }

  return { SR: SR, VOICE_ROWS: VOICE_ROWS, STYLE_DIM: STYLE_DIM, VOICE_BIN_BYTES: VOICE_BIN_BYTES, checkVoiceBinSize: checkVoiceBinSize, parseDatasetJsonl: parseDatasetJsonl, checkRow: checkRow, splitRows: splitRows, lossTrend: lossTrend, verifySummary: verifySummary };
});
