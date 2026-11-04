// 本地話題偵測（純函式，不碰 DOM、不做 I/O、不呼叫模型）。
// 取代「每則訊息都等模型判斷話題轉移」的 _checkTopicTransition（子對話 S2）。
// 所有函式都回傳新值，不修改傳入的物件。
//
// 指紋（fingerprint）：可序列化的詞頻表 { token: count }，JSON 友善。
//   - 中文（CJK）：連續中文字取二元組（bigram）；單一中文字取一元組
//   - 英文與數字：小寫單字
//   - 常見虛詞與口頭禪（見 STOP_TOKENS）不計入，避免「幫我」「一張」讓所有話題都像
//
// 判斷流程（detectShift）：
//   1. 沒有目前話題（對話剛開始）→ 不判轉移（呼叫端把這則設為目前話題）
//   2. 沒有實質內容（只有「好」「繼續」「謝謝」等）→ 不判轉移
//   3. 與目前話題相似度 >= sameThreshold → 同話題，不轉移
//   4. 與某個候選話題（舊話題的指紋）相似度 >= matchThreshold → 轉移，matchedTopicId 指向它
//   5. 以「再／又／加／改／換成／also／again…」開頭的短句 → 視為延續（例如「再加一隻狗」），不轉移
//   6. 其餘 → 轉移（新話題）
//
// 門檻自己決定的理由（使用者決定「選速度快的方式，誤判寧可多開」，所以偏向判轉移）：
//   - sameThreshold = 0.25：兩則訊息的餘弦相似度要有四分之一的詞重疊才算同話題。
//     手算「再畫一張狗的圖」與畫圖話題約 0.34，「幫我創作一首音樂」與畫圖約 0（測試中可驗證）。
//     0.25 比 0.5 寬鬆，能接住「同一任務換個東西」的訊息，但不會讓無關話題被算成同一個。
//   - matchThreshold = 0.25：與舊話題的判定門檻與 sameThreshold 相同，避免兩套標準互相打架。
//   - 這兩個值是經驗值，用測試案例校準，可由 opts 覆寫；真實使用者訊息的誤判率尚未量測。
//
// 指紋大小：mergeFingerprint 預設只保留前 40 個詞。理由：話題的核心詞會反覆出現，
//   次數高的留下，一次性的詞被擠掉；40 個詞大約能容納十來則內容訊息，又不會讓比對變慢。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiTopicLocal = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_MAX_TERMS = 40;
  var DEFAULT_SAME_THRESHOLD = 0.25;
  var DEFAULT_MATCH_THRESHOLD = 0.25;

  // 中文二元組停用：虛詞、量詞組、客套語。這些出現在幾乎所有話題裡，不代表話題內容。
  var STOP_CJK_BIGRAMS = [
    '幫我', '我的', '你的', '請你', '可以', '一張', '一隻', '一首', '一個', '一下',
    '這個', '那個', '什麼', '怎麼', '一些', '還是', '然後', '但是', '因為', '所以',
    '如果', '就是', '我們', '你們', '這樣', '那樣', '不要', '需要', '已經', '謝謝',
    '繼續', '好的', '我要', '要的', '麻煩'
  ];
  var STOP_EN_WORDS = [
    'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'is', 'are',
    'it', 'this', 'that', 'please', 'can', 'you', 'me', 'my', 'i', 'be', 'do'
  ];
  var STOP_CJK = {};
  STOP_CJK_BIGRAMS.forEach(function (w) { STOP_CJK[w] = true; });
  var STOP_EN = {};
  STOP_EN_WORDS.forEach(function (w) { STOP_EN[w] = true; });

  // 整句就是這些（去掉句尾標點、小寫後比對）→ 沒有新話題內容，不判轉移
  var TRIVIAL = {
    '好': 1, '好的': 1, '好啊': 1, '繼續': 1, '謝謝': 1, '謝謝你': 1, '對': 1, '對的': 1,
    '是': 1, '是的': 1, '不是': 1, '嗯': 1, '喔': 1, '了解': 1, '再來一個': 1, '改一下': 1,
    'ok': 1, 'okay': 1, 'yes': 1, 'no': 1, 'thanks': 1, 'thank you': 1, 'continue': 1,
    'sure': 1, 'good': 1, 'cool': 1, 'right': 1
  };

  // 延續的開頭：中文「再／又／也／還」可加可不加，接「加／多／來／改／換成／換一／同樣／一樣／繼續／接著」；
  // 英文整詞開頭 also／again／another／more／add／continue。
  // 注意：「再畫一張狗的圖」不符合（畫不在清單內），交給候選話題比對處理。
  var CONTINUATION_RE = /^((再|又|也|還)?(加|多|來|改|換成|換一|同樣|一樣|繼續|接著))|^(also|again|another|more|add|continue|one more)\b/i;

  var CJK_RUN = /[㐀-鿿豈-﫿]+/g;
  var ASCII_RUN = /[a-z0-9]+/g;

  function tokensOf(text) {
    var s = String(text == null ? '' : text).toLowerCase();
    var out = [];
    var m;
    CJK_RUN.lastIndex = 0;
    while ((m = CJK_RUN.exec(s)) !== null) {
      var run = m[0];
      if (run.length === 1) {
        out.push(run);
      } else {
        for (var i = 0; i + 1 < run.length; i++) {
          var bg = run.substr(i, 2);
          if (!STOP_CJK[bg]) out.push(bg);
        }
      }
    }
    ASCII_RUN.lastIndex = 0;
    while ((m = ASCII_RUN.exec(s)) !== null) {
      if (!STOP_EN[m[0]]) out.push(m[0]);
    }
    return out;
  }

  // 文字 → 詞頻表（純物件，可 JSON 序列化）
  function fingerprintOf(text) {
    var fp = {};
    var toks = tokensOf(text);
    for (var i = 0; i < toks.length; i++) {
      fp[toks[i]] = (fp[toks[i]] || 0) + 1;
    }
    return fp;
  }

  function isEmptyFp(fp) {
    return !fp || typeof fp !== 'object' || Object.keys(fp).length === 0;
  }

  // 把新訊息併入話題指紋，並只保留次數最多的 max 個詞（同次數依詞字典序，結果確定）
  function mergeFingerprint(fp, text, max) {
    var limit = typeof max === 'number' && max > 0 ? max : DEFAULT_MAX_TERMS;
    var merged = {};
    var src = fp && typeof fp === 'object' ? fp : {};
    Object.keys(src).forEach(function (k) { merged[k] = src[k]; });
    var add = fingerprintOf(text);
    Object.keys(add).forEach(function (k) { merged[k] = (merged[k] || 0) + add[k]; });
    var keys = Object.keys(merged);
    if (keys.length <= limit) return merged;
    keys.sort(function (a, b) {
      if (merged[b] !== merged[a]) return merged[b] - merged[a];
      return a < b ? -1 : a > b ? 1 : 0;
    });
    var kept = {};
    keys.slice(0, limit).forEach(function (k) { kept[k] = merged[k]; });
    return kept;
  }

  // 餘弦相似度，範圍 0–1；任一邊為空回傳 0
  function similarity(a, b) {
    if (isEmptyFp(a) || isEmptyFp(b)) return 0;
    var small = Object.keys(a).length <= Object.keys(b).length ? a : b;
    var large = small === a ? b : a;
    var dot = 0;
    Object.keys(small).forEach(function (k) {
      if (large[k]) dot += small[k] * large[k];
    });
    if (dot === 0) return 0;
    var na = 0; Object.keys(a).forEach(function (k) { na += a[k] * a[k]; });
    var nb = 0; Object.keys(b).forEach(function (k) { nb += b[k] * b[k]; });
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }

  function isTrivial(text) {
    var t = String(text == null ? '' : text).trim().toLowerCase().replace(/[。！？!?．,，、~～]+$/g, '').trim();
    // 少於 2 個字元（例如單獨一個「我」）視為太短，不足以代表一個新話題
    return t.length < 2 || TRIVIAL[t] === 1;
  }

  // candidates：[{ id, fingerprint }]，通常是舊的（已被轉出的）話題或子對話
  function detectShift(current, candidates, text, opts) {
    var o = opts || {};
    var sameT = typeof o.sameThreshold === 'number' ? o.sameThreshold : DEFAULT_SAME_THRESHOLD;
    var matchT = typeof o.matchThreshold === 'number' ? o.matchThreshold : DEFAULT_MATCH_THRESHOLD;
    var none = { isShifted: false, score: 0, matchedTopicId: null, reason: '' };

    if (isEmptyFp(current)) { none.reason = 'no-current-topic'; return none; }

    var fp = fingerprintOf(text);
    if (isTrivial(text) || isEmptyFp(fp)) { none.reason = 'trivial'; return none; }

    var sCur = similarity(fp, current);
    if (sCur >= sameT) return { isShifted: false, score: sCur, matchedTopicId: null, reason: 'same-topic' };

    var best = null;
    var list = Array.isArray(candidates) ? candidates : [];
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (!c || isEmptyFp(c.fingerprint)) continue;
      var s = similarity(fp, c.fingerprint);
      if (s >= matchT && (best === null || s > best.score)) best = { id: c.id, score: s };
    }
    if (best) return { isShifted: true, score: sCur, matchedTopicId: best.id, reason: 'returned-to-earlier-topic' };

    if (CONTINUATION_RE.test(String(text).trim())) {
      return { isShifted: false, score: sCur, matchedTopicId: null, reason: 'continuation-phrase' };
    }
    return { isShifted: true, score: sCur, matchedTopicId: null, reason: 'new-topic' };
  }

  return {
    fingerprintOf: fingerprintOf,
    mergeFingerprint: mergeFingerprint,
    similarity: similarity,
    detectShift: detectShift,
    DEFAULT_MAX_TERMS: DEFAULT_MAX_TERMS,
    DEFAULT_SAME_THRESHOLD: DEFAULT_SAME_THRESHOLD,
    DEFAULT_MATCH_THRESHOLD: DEFAULT_MATCH_THRESHOLD
  };
}));
