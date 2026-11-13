/* 語音辨識訓練的純函式核心（UMD，node 可測）。訓練本體在 sr_train.py（whisper-tiny ＋ LoRA，CPU）。
 * 這裡負責：資料格式檢查、文字正規化（與 sr_train.py 的 normalize 相同）、切分規則（與 sr_train.py 相同）、
 * 字錯率（WER）計算、產物清單（manifest）的組成。
 * 資料格式（data.jsonl，每行一筆）：{"id","audio"(相對路徑，.wav 16 kHz 單聲道 16 位元),"text","split":"train"|"eval"}
 * 測試：renderer/src/studio/sr_train_core.test.js */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else (root.FaSrTrain = factory()); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 小寫、去標點（保留撇號）、壓縮空白。與 sr_train.py 的 normalize 必須一致。
  function normalizeText(s) {
    return String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  }

  // 切分規則：列號（從 0 起算）% 4 == 0 為 eval，其餘 train。與 sr_train.py 的 prep 相同。
  function splitOf(index) { return index % 4 === 0 ? 'eval' : 'train'; }
  function splitRows(rows) { return rows.map(function (r, i) { return Object.assign({}, r, { split: splitOf(i) }); }); }

  // 檢查 data.jsonl 解析後的列：回傳 { ok, errors[], train, eval }
  function validateRows(rows) {
    var errors = [], train = 0, evals = 0, ids = {};
    if (!Array.isArray(rows) || rows.length === 0) return { ok: false, errors: ['資料是空的（沒有任何列）。'], train: 0, eval: 0 };
    rows.forEach(function (r, i) {
      var at = '第 ' + (i + 1) + ' 列：';
      if (!r || typeof r !== 'object') { errors.push(at + '不是物件。'); return; }
      if (typeof r.id !== 'string' || !r.id) errors.push(at + '缺少 id。');
      else if (ids[r.id]) errors.push(at + 'id 重複（' + r.id + '）。'); else ids[r.id] = true;
      if (typeof r.audio !== 'string' || !/\.wav$/i.test(r.audio)) errors.push(at + 'audio 必須是 .wav 檔的相對路徑。');
      else if (/^(\/|[a-zA-Z]:|\.\.)/.test(r.audio)) errors.push(at + 'audio 必須是相對路徑，不能是絕對路徑或含 ..。');
      if (typeof r.text !== 'string' || normalizeText(r.text) === '') errors.push(at + '沒有可用的參考文字。');
      if (r.split !== 'train' && r.split !== 'eval') errors.push(at + 'split 必須是 train 或 eval。');
      else if (r.split === 'train') train++; else evals++;
    });
    if (train === 0) errors.push('沒有訓練列（split=train）。');
    if (evals === 0) errors.push('沒有驗證列（split=eval），無法量測前後差異。');
    return { ok: errors.length === 0, errors: errors, train: train, eval: evals };
  }

  // 詞層級編輯距離（Levenshtein）。回傳 { errors, words }
  function editStats(refWords, hypWords) {
    var n = refWords.length, m = hypWords.length, prev = new Array(m + 1), cur = new Array(m + 1), i, j;
    for (j = 0; j <= m; j++) prev[j] = j;
    for (i = 1; i <= n; i++) {
      cur[0] = i;
      for (j = 1; j <= m; j++) {
        var cost = refWords[i - 1] === hypWords[j - 1] ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      var t = prev; prev = cur; cur = t;
    }
    return { errors: prev[m], words: n };
  }
  function wordErrorRate(ref, hyp) {
    var r = normalizeText(ref), h = normalizeText(hyp);
    var rw = r === '' ? [] : r.split(' '), hw = h === '' ? [] : h.split(' ');
    var s = editStats(rw, hw);
    return { errors: s.errors, words: s.words, wer: s.words === 0 ? (hw.length === 0 ? 0 : 1) : s.errors / s.words };
  }
  // 整批：語料級 WER＝總錯誤數 ÷ 總參考字數（不是逐句平均）。pairs: [{ref, hyp}]
  function corpusWer(pairs) {
    var e = 0, w = 0;
    (pairs || []).forEach(function (p) { var s = wordErrorRate(p.ref, p.hyp); e += s.errors; w += s.words; });
    return { errors: e, words: w, wer: w === 0 ? 0 : e / w, n: (pairs || []).length };
  }

  // 產物清單。sha256 是 檔名→雜湊 的物件。前後差異必須實測才會給 verified=true。
  function buildManifest(o) {
    var before = o.before || null, after = o.after || null;
    var improved = !!(before && after && after.wer < before.wer);
    return {
      format: 'fa-sr-lora', version: 1, kind: 'speech_recognition', base: o.base,
      adapter: { type: 'lora', target_modules: ['q_proj', 'v_proj'], rank: o.rank, alpha: o.alpha, dir: 'adapter' },
      train: { steps: o.steps, batch: o.batch, lr: o.lr, seed: o.seed, train_rows: o.trainRows, eval_rows: o.evalRows, loss_first: o.lossFirst, loss_last: o.lossLast },
      eval: { before: before, after: after, improved: improved, language: 'en', note: '驗證集為切分出的列，語言為英文（基底為多語言的 whisper-tiny）。' },
      sha256: o.sha256 || {}
    };
  }

  return { normalizeText: normalizeText, splitOf: splitOf, splitRows: splitRows, validateRows: validateRows,
    wordErrorRate: wordErrorRate, corpusWer: corpusWer, buildManifest: buildManifest };
});
