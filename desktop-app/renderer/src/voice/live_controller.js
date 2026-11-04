/* 全語音 Live 的控制器（UMD，純邏輯；不碰麥克風、不碰 DOM、不直接送聊天）。
 * 接收「一段一段的辨識文字」，決定：是不是給 AI 的（主詞）、是不是取消指令、要不要排入佇列；
 * 排入後依先進先出（FIFO）一個一個交給 submit 執行，並在排入時呼叫 chime。
 * 測試：scripts/voice-tests/live_controller.test.js。設計見 DESIGN.TODO.live-voice.md「階段 B」。
 *
 * 依賴（全部注入，方便測試；桌面版與網頁版共用）：
 *   queue   ：renderer/src/voice/live_queue.js 的 createLiveQueue 回傳物件
 *   submit  ：async (text, ctl) => void；ctl.isCancelled() 在被取消後回 true，讓執行端中途停止
  （提示音不在這裡：呼叫端建立 queue 時傳 onEnqueue 播放提示音即可）
 *   accept  ：(utterance) => boolean；階段 D 的聲紋閘門接在這裡，預設全部接受
 *   wakeWords：主詞清單，預設 ['AI', '欸哀']（主詞設定由呼叫端決定，只用其中一個時傳單一個）
 *
 * 規則：
 *   - 只有以主詞開頭的一段話才是指令；主詞後面的標點與空白會被去掉。沒有主詞的話直接忽略。
 *   - 三句取消指令（主詞後完整比對，忽略標點）：「取消前一個指令」「停止前面的動作」「取消前面所有指令」。
 *   - 其他指令先經 queue.feed 蒐集（超過 1000 token 會切段），再 flush 成一個指令排入。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FaLiveController = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var CANCEL_LAST = '取消前一個指令';
  var STOP_RUNNING = '停止前面的動作';
  var CANCEL_ALL = '取消前面所有指令';

  // 危險動作（會改動外部狀態）：刪除、送出、發布、付款、關閉程式等。命中就要先二次確認。
  var DANGER_RE = /(刪除|刪掉|移除檔|清空|格式化|覆蓋|送出|寄出|寄信|發信|傳送給|發布|發佈|上傳|貼文|付款|支付|匯款|轉帳|購買|下單|結帳|買進|賣出|關閉(?:程式|電腦|視窗|應用)|關機|重新開機|結束程式|解除安裝|移到垃圾|delete|remove|send|publish|post|pay|purchase|transfer|shutdown|quit)/i;
  function defaultIsDangerous(text) { return DANGER_RE.test(String(text || '')); }

  function norm(s) { return String(s || '').replace(/[\s，。！？、,.!?：:；;]+/g, ''); }

  // 回傳 { word, rest }：文字是否以某個主詞開頭；rest 是主詞後面的內容（已去掉開頭標點與空白）。
  function matchWake(text, wakeWords) {
    var t = String(text || '').replace(/^[\s，。！？、,.!?：:；;]+/, '');
    var words = (wakeWords || []).slice().sort(function (a, b) { return b.length - a.length; }); // 長的先比
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w && t.toLowerCase().indexOf(w.toLowerCase()) === 0) {
        return { word: w, rest: t.slice(w.length).replace(/^[\s，。！？、,.!?：:；;]+/, '') };
      }
    }
    return null;
  }

  function createLiveController(opts) {
    opts = opts || {};
    if (!opts.queue) throw new Error('需要 queue');
    if (typeof opts.submit !== 'function') throw new Error('需要 submit');
    var queue = opts.queue;
    var submit = opts.submit;
    var accept = typeof opts.accept === 'function' ? opts.accept : function () { return true; };
    var wakeWords = Array.isArray(opts.wakeWords) && opts.wakeWords.length ? opts.wakeWords : ['AI', '欸哀'];
    var vpCmd = typeof opts.voiceprintCommand === 'function' ? opts.voiceprintCommand : null;
    var isDangerous = typeof opts.isDangerous === 'function' ? opts.isDangerous : defaultIsDangerous;
    var speak = typeof opts.speak === 'function' ? opts.speak : function () {};   // 語音（TTS）
    var card = typeof opts.card === 'function' ? opts.card : function () {};      // 語音回答卡片（文字＋語音，顯示在聊天）
    var setT = typeof opts.setTimer === 'function' ? opts.setTimer : function (f, ms) { return setTimeout(f, ms); };
    var clearT = typeof opts.clearTimer === 'function' ? opts.clearTimer : function (h) { clearTimeout(h); };
    var confirmMs = Number(opts.confirmTimeoutMs) > 0 ? Number(opts.confirmTimeoutMs) : 15000;
    var pendingCmd = null;      // 等待「確認」的危險指令 { text, timer }
    var pendingDelete = null;   // 等待「確認」的聲紋 ID
    var enabled = false;
    var running = null;          // 目前執行中的指令 { item, cancelled }
    var pumping = false;
    var ignored = 0;

    function setEnabled(v) { enabled = !!v; if (!enabled) { dropPending(); cancelAll(); } }

    function dropPending() { if (pendingCmd) { clearT(pendingCmd.timer); pendingCmd = null; } }
    function say(kind, text, extra) { card(Object.assign({ kind: kind, text: text }, extra || {})); speak(text); }
    function enqueueNow(text) {
      queue.feed(text);
      var it = queue.flush();
      pump();
      return it;
    }

    // 一段辨識結果（一次說完的話）。回傳這段做了什麼：{ action: 'ignored'|'queued'|'cancel'|'stop'|'cancelAll'|'disabled', ... }
    function onUtterance(text) {
      if (!enabled) return { action: 'disabled' };
      var u = { text: String(text || '') };
      if (!accept(u)) { ignored++; return { action: 'ignored', reason: 'gate' }; }
      var m = matchWake(u.text, wakeWords);
      // 等待確認時，不帶主詞的「確認」「取消」也算回答（聲紋閘門已先擋掉別人的聲音）。
      if (pendingCmd && !m) {
        var bare = norm(u.text);
        if (bare === '確認' || bare === '取消') m = { word: '', rest: bare };
      }
      if (!m) { ignored++; return { action: 'ignored', reason: 'no_wake' }; }
      var cmd = norm(m.rest);
      // 聲紋指令（階段 C）：新增聲紋；刪除聲紋N 要再說一次「確認」才真的刪（危險動作二次確認）。其他指令會取消待確認的刪除。
      if (cmd === '新增聲紋') { pendingDelete = null; if (vpCmd) vpCmd({ kind: 'enroll' }); return { action: 'vp', kind: 'enroll' }; }
      var dm = /^刪除聲紋(\d+)$/.exec(cmd);
      if (dm) { dropPending(); pendingDelete = Number(dm[1]); return { action: 'vpPendingDelete', id: pendingDelete }; }
      if (pendingCmd && (cmd === '確認' || cmd === '取消')) {
        var pc = pendingCmd; dropPending();
        if (cmd === '取消') { say('confirmCancelled', '已取消：' + pc.text, { command: pc.text }); return { action: 'confirmCancelled', text: pc.text }; }
        var cit = enqueueNow(pc.text);
        say('confirmed', '已確認，開始執行：' + pc.text, { command: pc.text });
        return { action: 'confirmed', item: cit };
      }
      if (cmd === '確認') {
        if (pendingDelete === null) { ignored++; return { action: 'ignored', reason: 'no_pending_confirm' }; }
        var did = pendingDelete; pendingDelete = null;
        if (vpCmd) vpCmd({ kind: 'delete', id: did });
        return { action: 'vp', kind: 'delete', id: did };
      }
      pendingDelete = null;
      dropPending();   // 說了別的指令，等待中的危險指令視為放棄
      if (cmd === norm(CANCEL_LAST)) { var c = cancelLast(); return { action: 'cancel', item: c }; }
      if (cmd === norm(STOP_RUNNING)) { var s = stopRunning(); return { action: 'stop', item: s }; }
      if (cmd === norm(CANCEL_ALL)) { return { action: 'cancelAll', count: cancelAll() }; }
      if (!m.rest) { ignored++; return { action: 'ignored', reason: 'empty' }; }
      if (isDangerous(m.rest)) {
        var text = m.rest;
        var timer = setT(function () {
          if (pendingCmd && pendingCmd.timer === timer) {
            pendingCmd = null;
            say('confirmTimeout', '逾時未確認，已放棄：' + text, { command: text });
          }
        }, confirmMs);
        pendingCmd = { text: text, timer: timer };
        say('confirmAsk', '這是危險動作：' + text + '。確認嗎？請說「確認」或「取消」。', { command: text, timeoutMs: confirmMs });
        return { action: 'confirmAsk', text: text };
      }
      return { action: 'queued', item: enqueueNow(m.rest) };
    }

    function cancelLast() {
      var it = queue.cancelLast();
      if (it && running && running.item.id === it.id) running.cancelled = true;
      return it;
    }
    function stopRunning() {
      var it = queue.stopRunning();
      if (it && running && running.item.id === it.id) running.cancelled = true;
      return it;
    }
    function cancelAll() {
      var n = queue.cancelAll();
      if (running) running.cancelled = true;
      return n;
    }

    // 依 FIFO 一個一個執行；同時間只跑一個。
    async function pump() {
      if (pumping) return;
      pumping = true;
      try {
        for (;;) {
          var item = queue.next();
          if (!item) break;
          running = { item: item, cancelled: false };
          var ctl = { isCancelled: function () { return !!(running && running.cancelled); } };
          try { await submit(item.text, ctl); } catch (e) { /* 執行失敗：指令標記完成，不卡住後面的指令 */ }
          queue.complete(item.id);
          running = null;
        }
      } finally {
        pumping = false;
      }
    }

    return {
      setEnabled: setEnabled,
      isEnabled: function () { return enabled; },
      onUtterance: onUtterance,
      cancelLast: cancelLast,
      stopRunning: stopRunning,
      cancelAll: cancelAll,
      pump: pump,
      hasPendingConfirm: function () { return !!pendingCmd; },
      isRunning: function () { return !!running; },
      ignoredCount: function () { return ignored; }
    };
  }

  return { createLiveController: createLiveController, matchWake: matchWake, defaultIsDangerous: defaultIsDangerous, CANCEL_LAST: CANCEL_LAST, STOP_RUNNING: STOP_RUNNING, CANCEL_ALL: CANCEL_ALL };
});
