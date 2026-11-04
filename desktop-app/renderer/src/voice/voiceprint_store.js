/* 聲紋儲存與比對（UMD，純邏輯；不碰麥克風、不碰模型、不碰 IndexedDB——持久化由呼叫端注入）。
 * 測試：scripts/voice-tests/voiceprint_store.test.js。設計見 DESIGN.TODO.live-voice.md「階段 C」。
 *
 * 規則：
 *   - 上限 N 介於 8 到 128，預設 8。只能由設定頁（Configure）改，這個模組沒有語音入口。
 *   - ID 從 1 開始遞增，刪除後不重用（避免誤指到別人的聲紋）。
 *   - 每筆聲紋記錄產生它的模型版本（modelId＋sha256）；版本不符的聲紋不參與比對，要求重新錄入。
 *   - 比對：與每筆聲紋做餘弦相似度，取最大值；超過門檻才算是本人。門檻由呼叫端傳入（實測後訂）。
 *   - 同一人可以錄多筆樣本；比對取最大值，不平均。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaVoiceprintStore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var LIMIT_MIN = 8, LIMIT_MAX = 128, LIMIT_DEFAULT = 8;

  function clampLimit(n) {
    var v = Math.round(Number(n));
    if (!Number.isFinite(v)) return LIMIT_DEFAULT;
    return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, v));
  }

  function normalize(vec) {
    var s = 0;
    for (var i = 0; i < vec.length; i++) s += vec[i] * vec[i];
    var n = Math.sqrt(s);
    if (!(n > 0)) throw new Error('聲紋向量是零向量，無法使用');
    var out = new Float32Array(vec.length);
    for (var j = 0; j < vec.length; j++) out[j] = vec[j] / n;
    return out;
  }

  function cosine(a, b) {
    if (a.length !== b.length) throw new Error('向量維度不同');
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;   // 兩個都已正規化，內積就是餘弦
  }

  // data：{ limit, nextId, entries:[{id,name,createdAt,modelId,modelSha256,vector:number[]}] }，可由 JSON 還原。
  function createVoiceprintStore(opts) {
    opts = opts || {};
    var model = opts.model || {};
    if (!model.id || !model.sha256) throw new Error('需要模型 id 與 sha256');
    var data = opts.data && typeof opts.data === 'object' ? opts.data : {};
    var limit = clampLimit(data.limit != null ? data.limit : LIMIT_DEFAULT);
    var nextId = Math.max(1, Math.floor(Number(data.nextId) || 1));
    var entries = Array.isArray(data.entries) ? data.entries.slice() : [];
    // 還原時 nextId 至少要大於現有最大 id，避免重用
    entries.forEach(function (e) { if (e && e.id >= nextId) nextId = e.id + 1; });

    function sameModel(e) { return e.modelId === model.id && e.modelSha256 === model.sha256; }

    function setLimit(n) { limit = clampLimit(n); return limit; }
    function getLimit() { return limit; }

    // 還沒有任何可用的聲紋（強制錄入的判斷用）
    function needsEnrollment() { return entries.filter(sameModel).length === 0; }

    function count() { return entries.length; }

    // 新增一筆。達到上限回傳 { ok:false, error }，不會自動刪除任何聲紋。
    function add(name, vector) {
      if (entries.length >= limit) return { ok: false, error: '已達聲紋上限（' + limit + '），請到設定提高上限或先刪除', limit: limit };
      var v = normalize(vector);
      var id = nextId++;
      entries.push({ id: id, name: String(name || ('聲紋' + id)), createdAt: Date.now(), modelId: model.id, modelSha256: model.sha256, vector: Array.from(v) });
      return { ok: true, id: id, report: '已將聲紋記錄為 ID ' + id };
    }

    // 刪除必須指定 ID。回傳是否真的刪到。ID 不會再被配發。
    function remove(id) {
      var idx = -1;
      for (var i = 0; i < entries.length; i++) if (entries[i].id === Number(id)) { idx = i; break; }
      if (idx < 0) return { ok: false, error: '沒有 ID ' + id + ' 的聲紋' };
      var gone = entries.splice(idx, 1)[0];
      return { ok: true, id: gone.id };
    }

    function list() { return entries.map(function (e) { return { id: e.id, name: e.name, usable: sameModel(e), createdAt: e.createdAt }; }); }

    // 比對：只跟目前模型版本的聲紋比。回傳 { accepted, bestId, score, threshold, compared }。
    function match(vector, threshold) {
      var t = Number(threshold);
      if (!Number.isFinite(t)) throw new Error('需要門檻');
      var v = normalize(vector);
      var best = null, compared = 0;
      entries.forEach(function (e) {
        if (!sameModel(e)) return;
        compared++;
        var s = cosine(v, e.vector);
        if (best === null || s > best.score) best = { id: e.id, score: s };
      });
      if (!best) return { accepted: false, bestId: null, score: null, threshold: t, compared: 0, reason: 'no_enrollment' };
      return { accepted: best.score >= t, bestId: best.id, score: best.score, threshold: t, compared: compared, reason: best.score >= t ? 'match' : 'below_threshold' };
    }

    // 可序列化的狀態（給呼叫端存進 IndexedDB）。
    function toJSON() {
      return { limit: limit, nextId: nextId, entries: entries.map(function (e) { return Object.assign({}, e, { vector: e.vector.slice() }); }) };
    }

    return {
      add: add, remove: remove, list: list, match: match, count: count,
      needsEnrollment: needsEnrollment, setLimit: setLimit, getLimit: getLimit, toJSON: toJSON,
      model: { id: model.id, sha256: model.sha256 }
    };
  }

  return { createVoiceprintStore: createVoiceprintStore, clampLimit: clampLimit, LIMIT_MIN: LIMIT_MIN, LIMIT_MAX: LIMIT_MAX, LIMIT_DEFAULT: LIMIT_DEFAULT };
});
