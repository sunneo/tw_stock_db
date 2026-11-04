/* 全語音 Live 的指令佇列與切段（UMD，純函式，不碰 DOM、麥克風、網路、模型；桌面版與網頁版共用）。
 * 測試：scripts/voice-tests/live_queue.test.js。設計見 DESIGN.TODO.live-voice.md「階段 B」。
 *
 * 規則（使用者決定 2026-11-04）：
 *   - 連續收進來的文字先蒐集；蒐集到 maxTokens（預設 1000）就切成一個指令排入佇列。
 *   - 所有指令都是先進先出（FIFO）。佇列沒有「滿」的上限。
 *   - 每次排入都呼叫 onEnqueue（用來播放提示音）。
 *   - 每個指令都可以向前管理：取消最後排入的（cancelLast）、停止正在跑的（stopRunning）、取消全部（cancelAll）。
 *
 * 注意：token 數由呼叫端注入 countTokens；沒注入時用字元數估計（每字元算 1），這不是真的 token 數，
 * 階段 B 接線前要換成專案實際的 tokenizer（尚未確認有哪一個可用）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaLiveQueue = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_MAX_TOKENS = 1000;

  function defaultCount(text) { return String(text).length; }

  // 在 text 裡找最長的前綴，其 token 數不超過 max；回傳前綴的字元長度（至少 1，避免死循環）。
  function prefixLenWithin(text, max, count) {
    var lo = 1, hi = text.length, best = 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (count(text.slice(0, mid)) <= max) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return best;
  }

  function createLiveQueue(opts) {
    opts = opts || {};
    var maxTokens = Number(opts.maxTokens) > 0 ? Number(opts.maxTokens) : DEFAULT_MAX_TOKENS;
    var count = typeof opts.countTokens === 'function' ? opts.countTokens : defaultCount;
    var onEnqueue = typeof opts.onEnqueue === 'function' ? opts.onEnqueue : function () {};
    var nextId = 1;
    var buffer = '';          // 還在蒐集、尚未成為指令的文字
    var items = [];           // 全部指令，依排入順序（FIFO）；狀態：queued／running／done／cancelled
    var log = [];             // 事件紀錄（測試與除錯用）

    function newItem(text) {
      var it = { id: nextId++, text: text, status: 'queued' };
      items.push(it);
      log.push({ type: 'enqueue', id: it.id });
      onEnqueue(it);
      return it;
    }

    // 收進一段文字：蒐集；每累積到 maxTokens 就切一個指令出來。回傳這次新排入的指令陣列。
    function feed(text) {
      buffer += String(text == null ? '' : text);
      var made = [];
      while (buffer.length && count(buffer) > maxTokens) {
        var n = prefixLenWithin(buffer, maxTokens, count);
        made.push(newItem(buffer.slice(0, n)));
        buffer = buffer.slice(n);
      }
      return made;
    }

    // 把目前蒐集到的文字當成一個指令排入（例如斷句偵測到句尾、使用者停頓）。沒有文字就不動作。
    function flush() {
      if (!buffer.length) return null;
      var it = newItem(buffer);
      buffer = '';
      return it;
    }

    // 取出佇列最前面的一個開始執行（FIFO）。已經有正在跑的就不取出（一次只跑一個）。
    function next() {
      if (items.some(function (x) { return x.status === 'running'; })) return null;
      var it = items.find(function (x) { return x.status === 'queued'; });
      if (!it) return null;
      it.status = 'running';
      log.push({ type: 'start', id: it.id });
      return it;
    }

    // 正在跑的指令完成。
    function complete(id) {
      var it = find(id);
      if (it && it.status === 'running') { it.status = 'done'; log.push({ type: 'done', id: id }); }
      return !!it && it.status === 'done';
    }

    function find(id) { return items.find(function (x) { return x.id === id; }) || null; }

    // 「取消前一個指令」：取消最後排入、還沒開始的那一個；沒有排隊中的，就取消正在跑的那一個。回傳被取消的指令或 null。
    function cancelLast() {
      var queued = items.filter(function (x) { return x.status === 'queued'; });
      var target = queued.length ? queued[queued.length - 1] : items.find(function (x) { return x.status === 'running'; });
      if (!target) return null;
      target.status = 'cancelled';
      log.push({ type: 'cancel', id: target.id });
      return target;
    }

    // 「停止前面的動作」：停止正在跑的那一個（排隊中的不動）。回傳被停止的指令或 null。
    function stopRunning() {
      var target = items.find(function (x) { return x.status === 'running'; });
      if (!target) return null;
      target.status = 'cancelled';
      log.push({ type: 'stop', id: target.id });
      return target;
    }

    // 「取消前面所有指令」：取消全部排隊中與正在跑的指令，並清掉還在蒐集的文字。回傳被取消的數量。
    function cancelAll() {
      var n = 0;
      items.forEach(function (x) {
        if (x.status === 'queued' || x.status === 'running') { x.status = 'cancelled'; n++; }
      });
      buffer = '';
      log.push({ type: 'cancelAll', count: n });
      return n;
    }

    function pending() { return items.filter(function (x) { return x.status === 'queued' || x.status === 'running'; }).map(function (x) { return x.id; }); }

    return {
      feed: feed,
      flush: flush,
      next: next,
      complete: complete,
      cancelLast: cancelLast,
      stopRunning: stopRunning,
      cancelAll: cancelAll,
      pending: pending,
      buffered: function () { return buffer; },
      items: function () { return items.map(function (x) { return { id: x.id, text: x.text, status: x.status }; }); },
      log: function () { return log.slice(); },
      maxTokens: maxTokens
    };
  }

  return { createLiveQueue: createLiveQueue, DEFAULT_MAX_TOKENS: DEFAULT_MAX_TOKENS };
});
