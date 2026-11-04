// 子對話狀態模型（純函式，不碰 DOM、不做 I/O、不呼叫模型）。
// 子對話索引的 status 只會是下面四種之一；連結卡片用 summarize 產生顯示文字。
//
// 狀態：
//   running       進行中
//   done          已完成（終態）
//   waiting_user  等使用者回應（子對話出現需要使用者回答的卡片／對話框／權限確認）
//   failed        失敗（終態）
//
// 事件：
//   start   開始（或重新開始）一輪執行 → 任何狀態都回到 running
//   finish  這一輪正常結束 → running／waiting_user 變 done；終態不動
//   error   出錯 → running／waiting_user 變 failed；終態不動
//   ask     子對話出現需要使用者回應的東西 → running 變 waiting_user；終態不復活
//   answer  使用者已回應 → waiting_user 變 running；其他狀態不動
//
// 規則（測試會逐條驗證）：
//   - done 與 failed 是終態：之後收到 finish／error／ask／answer 都忽略，只有 start 能離開（「不復活」）。
//   - 未知的事件或狀態：原樣保留，不丟例外。
//   - prev 為 null／undefined 視為尚未開始，等同 running 前的狀態（只有 start 有意義，其他事件忽略）。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatSubStatus = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RUNNING = 'running';
  var DONE = 'done';
  var WAITING = 'waiting_user';
  var FAILED = 'failed';
  var STATUSES = [RUNNING, DONE, WAITING, FAILED];
  var EVENTS = ['start', 'finish', 'error', 'ask', 'answer'];

  var QUESTION_MAX = 30; // 等待回應時顯示的問題前幾個字
  var REASON_MAX = 40;   // 失敗時顯示的原因前幾個字

  function isTerminal(s) { return s === DONE || s === FAILED; }

  // 下一個狀態。不認得的組合原樣回傳 prev。
  function nextStatus(prev, event) {
    var s = prev == null ? null : prev;
    switch (event) {
      case 'start':
        return RUNNING;
      case 'finish':
        if (s === RUNNING || s === WAITING) return DONE;
        return s;
      case 'error':
        if (s === RUNNING || s === WAITING) return FAILED;
        return s;
      case 'ask':
        if (s === RUNNING) return WAITING;
        return s;
      case 'answer':
        if (s === WAITING) return RUNNING;
        return s;
      default:
        return s;
    }
  }

  // 把任意文字壓成單行並依「字元」截斷（不切斷字）；超過就加省略號
  function clip(s, max) {
    var t = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    var chars = Array.from(t);
    if (chars.length <= max) return t;
    return chars.slice(0, max).join('') + '…';
  }

  // 連結卡片顯示文字。info 可選：{ question } 等待回應時的問題，{ reason } 失敗時的原因。
  function summarize(status, info) {
    var i = info || {};
    if (status === RUNNING) return '進行中';
    if (status === DONE) return '已完成';
    if (status === WAITING) {
      var q = clip(i.question, QUESTION_MAX);
      return q ? '等你回應：' + q : '等你回應';
    }
    if (status === FAILED) {
      var r = clip(i.reason, REASON_MAX);
      return r ? '失敗：' + r : '失敗';
    }
    return '';
  }

  return {
    RUNNING: RUNNING,
    DONE: DONE,
    WAITING: WAITING,
    FAILED: FAILED,
    STATUSES: STATUSES,
    EVENTS: EVENTS,
    QUESTION_MAX: QUESTION_MAX,
    REASON_MAX: REASON_MAX,
    isTerminal: isTerminal,
    nextStatus: nextStatus,
    summarize: summarize
  };
}));
