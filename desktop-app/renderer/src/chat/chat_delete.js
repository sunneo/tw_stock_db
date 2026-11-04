// 批次刪除子對話（純函式，不碰 DOM、不做 I/O、不呼叫模型）。子對話 S7。
// 只刪「子對話」（有效 parentId 的對話）。永遠不刪根對話、孤兒（視為根）、遠端收件對話（kind:'remote-inbox'）。
// 子對話的子孫一併刪除（由 descendantsDeleted 回報數量）。
// 進行中（status 為 running 或 waiting_user，或 busyIds 裡的）：預設跳過；includeRunning 為真才包含（執行端要先中止再刪）。
// 進行中的判斷含子孫：子樹裡任一筆進行中，整棵子樹跳過（避免只刪掉其中一段）。
//
// planDelete(chats, opts) → { toDelete:[{id,title}], skipped:[{id,title,reason}], descendantsDeleted:n, error? }
//   opts.parentId        父對話 id（filter 不是 'ids' 時必填）
//   opts.filter          'done' | 'failed' | 'done_or_failed' | 'all' | 'ids'
//   opts.ids             filter 為 'ids' 時的 id 清單（可含不存在或根對話，會列入 skipped）
//   opts.includeRunning  是否包含進行中的（預設 false）
//   opts.busyIds         執行端額外標記為進行中的 id 清單（例如 ctx.isResponding）
//
// skipped 的 reason：not_found | not_child | not_under_parent | remote_inbox | in_progress | descendant_in_progress | remote_inbox_descendant
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./chat_tree.js'));
  } else {
    root.AiChatDelete = factory(root.AiChatTree);
  }
}(typeof self !== 'undefined' ? self : this, function (Tree) {
  'use strict';

  var FILTERS = ['done', 'failed', 'done_or_failed', 'all', 'ids'];
  var IN_PROGRESS = ['running', 'waiting_user'];

  function isRemoteInbox(c) { return !!c && c.kind === 'remote-inbox'; }

  function planDelete(chats, opts) {
    var o = opts || {};
    var out = { toDelete: [], skipped: [], descendantsDeleted: 0 };
    if (FILTERS.indexOf(o.filter) < 0) { out.error = 'unknown_filter'; return out; }
    var includeRunning = o.includeRunning === true;
    var busy = Object.create(null);
    (Array.isArray(o.busyIds) ? o.busyIds : []).forEach(function (id) { busy[String(id)] = true; });

    var list = Tree.normalizeChats(Array.isArray(chats) ? chats : []);
    var tree = Tree.buildTree(list);
    var byId = tree.byId;
    var parentId = o.parentId == null || o.parentId === '' ? null : String(o.parentId);
    if (o.filter !== 'ids' && parentId === null) { out.error = 'no_parent'; return out; }

    function titleOf(n) { return n ? String(n.title || '') : ''; }
    function skip(id, n, reason) { out.skipped.push({ id: id, title: titleOf(n), reason: reason }); }
    function isInProgress(n) { return IN_PROGRESS.indexOf(n.status) >= 0 || !!busy[String(n.id)]; }
    function isChild(n) { return !!tree.effParent.get(n); }
    // n 是否在 ancestorId 底下（直接或間接）；沿有效父鏈往上走，帶步數上限防環
    function isUnder(n, ancestorId) {
      var cur = n; var guard = 0;
      while (cur && guard++ < list.length + 1) {
        var p = tree.effParent.get(cur);
        if (p === null || p === undefined) return false;
        if (String(p) === ancestorId) return true;
        cur = byId[String(p)];
      }
      return false;
    }
    // 子樹（不含自己），深度優先，visited 防環
    function subtreeOf(n) {
      var acc = []; var visited = Object.create(null); visited[String(n.id)] = true;
      var stack = (tree.children[String(n.id)] || []).slice();
      while (stack.length) {
        var k = stack.pop(); var key = String(k.id);
        if (visited[key]) continue; visited[key] = true; acc.push(k);
        (tree.children[key] || []).forEach(function (x) { stack.push(x); });
      }
      return acc;
    }

    // 1. 收集候選（explicit）
    var candidates = [];
    if (o.filter === 'ids') {
      var ids = Array.isArray(o.ids) ? o.ids.map(String) : [];
      var picked = Object.create(null);
      ids.forEach(function (id) {
        if (picked[id]) return; picked[id] = true;
        var n = byId[id];
        if (!n) { skip(id, null, 'not_found'); return; }
        if (isRemoteInbox(n)) { skip(id, n, 'remote_inbox'); return; }
        if (!isChild(n)) { skip(id, n, 'not_child'); return; }
        if (parentId !== null && !isUnder(n, parentId)) { skip(id, n, 'not_under_parent'); return; }
        candidates.push(n);
      });
    } else {
      var direct = (tree.children[parentId] || []).slice();
      direct.forEach(function (c) {
        var st = c.status;
        var match = o.filter === 'all' ||
          (o.filter === 'done' && st === 'done') ||
          (o.filter === 'failed' && st === 'failed') ||
          (o.filter === 'done_or_failed' && (st === 'done' || st === 'failed'));
        if (match) candidates.push(c);
      });
    }

    // 2. 逐一處理候選：進行中或含受保護收件對話的子樹整棵跳過；其餘加入刪除清單（子孫一併）
    var seen = Object.create(null);
    candidates.forEach(function (n) {
      var key = String(n.id);
      if (seen[key]) return;
      if (isRemoteInbox(n)) { skip(key, n, 'remote_inbox'); return; }
      var sub = subtreeOf(n);
      if (!includeRunning) {
        if (isInProgress(n)) { skip(key, n, 'in_progress'); return; }
        if (sub.some(isInProgress)) { skip(key, n, 'descendant_in_progress'); return; }
      }
      if (sub.some(isRemoteInbox)) { skip(key, n, 'remote_inbox_descendant'); return; }
      seen[key] = true;
      out.toDelete.push({ id: key, title: titleOf(n) });
      sub.forEach(function (d) {
        var dk = String(d.id);
        if (seen[dk]) return;
        seen[dk] = true;
        out.toDelete.push({ id: dk, title: titleOf(d) });
        out.descendantsDeleted++;
      });
    });
    return out;
  }

  return { planDelete: planDelete, FILTERS: FILTERS };
}));
