// 遠端收件對話（純函式，不碰 DOM、不做 I/O）。子對話 S6：遠端需求統一成子對話。
// 每個來源節點有一個「虛擬收件對話」當父對話：標題「遠端需求 · 〈節點名〉」，不呼叫模型，只收子對話。
// 所有函式都回傳新值，不修改傳入的物件。
//
// 收件對話的索引欄位：kind:'remote-inbox'、nodeName、parentId:null、shared:false。
// 遠端子對話的父欄位：parentId＝收件對話 id、nodeName＝來源節點名稱。
// 舊格式的遠端需求對話（有 remote 欄位、沒有 parentId）用 migrateRemoteChats 收進收件對話底下，只改索引欄位，不改對話內容。
//
// newId（選用）：產生新 id 的函式，預設產生 'rin_' 前綴的 id；測試時傳入固定值。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiRemoteInbox = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var INBOX_KIND = 'remote-inbox';
  var seq = 0;

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  function defaultNewId() {
    seq++;
    return 'rin_' + Date.now().toString(36) + seq.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function cleanName(s) { return typeof s === 'string' ? s.trim() : ''; }

  function titleFor(nodeName) { return '遠端需求 · ' + nodeName; }

  function isInbox(c) { return isObj(c) && c.kind === INBOX_KIND; }

  // 這個節點的收件對話（找到第一筆；同節點不該有兩筆，有就取第一筆）。沒有就回傳 null。
  function findInbox(chats, nodeName) {
    var n = cleanName(nodeName);
    if (!n) return null;
    var list = (Array.isArray(chats) ? chats : []).filter(isObj);
    for (var i = 0; i < list.length; i++) {
      if (isInbox(list[i]) && cleanName(list[i].nodeName) === n) return list[i];
    }
    return null;
  }

  // 找或決定該節點收件對話的 id 與標題。
  //   有：{ id, title, existing:true }
  //   沒有：{ id:null, title, existing:false }（id 由 ensureInbox 產生）
  //   nodeName 空白：{ id:null, title:null, existing:false, invalid:true }
  function inboxIdFor(chats, nodeName) {
    var n = cleanName(nodeName);
    if (!n) return { id: null, title: null, existing: false, invalid: true };
    var hit = findInbox(chats, n);
    if (hit) return { id: String(hit.id), title: String(hit.title || titleFor(n)), existing: true };
    return { id: null, title: titleFor(n), existing: false };
  }

  // 建立收件對話的索引項目（純資料）。
  function makeInboxEntry(nodeName, id, now) {
    var n = cleanName(nodeName), t = now || 0;
    return {
      id: id, title: titleFor(n), groupId: null, createdAt: t, updatedAt: t,
      touched: true, shared: false, kind: INBOX_KIND, nodeName: n, parentId: null, status: null,
    };
  }

  // 保證該節點有且只有一個收件對話。回傳 { chats（新陣列）, inboxId, created }。
  // 已經有就不建（只建一次）；沒有才加一筆（id 用 newId 產生）。
  function ensureInbox(chats, nodeName, opts) {
    var list = (Array.isArray(chats) ? chats : []).filter(isObj).slice();
    var n = cleanName(nodeName);
    if (!n) return { chats: list, inboxId: null, created: false };
    var hit = findInbox(list, n);
    if (hit) return { chats: list, inboxId: String(hit.id), created: false };
    var newId = (opts && typeof opts.newId === 'function') ? opts.newId : defaultNewId;
    var now = (opts && typeof opts.now === 'number') ? opts.now : Date.now();
    var id = String(newId());
    list.push(makeInboxEntry(n, id, now));
    return { chats: list, inboxId: id, created: true };
  }

  // 要寫進遠端子對話的父子欄位。
  //   回傳 { parentId, nodeName, chats（已確保收件對話存在的新陣列）, created }
  //   childEntry 只用來確認是物件；欄位由呼叫端自己合併（本函式不寫 status、summary 等）。
  //   nodeName 空白：parentId:null（呼叫端應視為根對話，或拒絕）。
  function attachRemoteChild(chats, nodeName, childEntry, opts) {
    var n = cleanName(nodeName);
    if (!isObj(childEntry) || !n) return { parentId: null, nodeName: n || null, chats: (Array.isArray(chats) ? chats : []).filter(isObj).slice(), created: false };
    var r = ensureInbox(chats, n, opts);
    return { parentId: r.inboxId, nodeName: n, chats: r.chats, created: r.created };
  }

  // 舊資料遷移：有 remote 欄位、沒有 parentId 的對話，收進對應節點的收件對話底下。
  //   節點名：先用 nodeName，沒有就用 remote.fromName。兩個都沒有就不動（留在根）。
  //   只補 parentId 與缺少的 nodeName；不改其他欄位，不改對話內容。
  //   已經有 parentId（含收件對話自己）一律不動。
  //   回傳新陣列；不修改傳入的物件。
  function migrateRemoteChats(chats, opts) {
    var out = (Array.isArray(chats) ? chats : []).filter(isObj).slice();
    for (var i = 0; i < out.length; i++) {
      var c = out[i];
      if (isInbox(c)) continue;
      if (c.parentId != null && c.parentId !== '') continue; // 已有 parentId（非字串也算）一律不動
      if (!isObj(c.remote)) continue; // 只處理有 remote 欄位的舊遠端需求對話
      var n = cleanName(c.nodeName) || cleanName(isObj(c.remote) ? c.remote.fromName : '');
      if (!n) continue;
      var r = ensureInbox(out, n, opts);
      out = r.chats;
      var next = Object.assign({}, c, { parentId: r.inboxId });
      if (!cleanName(c.nodeName)) next.nodeName = n;
      out[i] = next;
    }
    return out;
  }

  return {
    INBOX_KIND: INBOX_KIND,
    isInbox: isInbox,
    findInbox: findInbox,
    inboxIdFor: inboxIdFor,
    makeInboxEntry: makeInboxEntry,
    ensureInbox: ensureInbox,
    attachRemoteChild: attachRemoteChild,
    migrateRemoteChats: migrateRemoteChats,
  };
}));
