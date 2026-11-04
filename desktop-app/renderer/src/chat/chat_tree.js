// 對話樹（純函式，不碰 DOM、不做 I/O）：子對話收在父對話底下的資料模型。
// 索引的 chats 陣列是平的；父子關係只靠每筆的 parentId 表示。
// 所有函式都回傳新值，不修改傳入的物件。
//
// 索引欄位（normalizeChatEntry 會補齊；舊資料沒有就補 null，既有欄位不動）：
//   parentId    父對話的 id；null＝根對話
//   status      running | done | waiting_user | failed | null
//   topicId     話題識別（S2 起使用）
//   fingerprint 話題指紋（S5 起使用）
//   summary     摘要（S3 起使用）
//   nodeName    所屬節點名稱（遠端需求建立的對話才有；本機為 null）
//
// 容錯規則：
//   - parentId 指向不存在的對話 → 視為根（孤兒子對話提升為根）
//   - parentId 形成環（含自己指自己）→ 環上每一筆都視為根，不無限迴圈
//   - 同層排序：根依建立時間新到舊（與側欄既有順序一致）；子對話依建立時間舊到新（第一個子對話在最上面）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatTree = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var STATUSES = ['running', 'done', 'waiting_user', 'failed'];
  var PLAIN_NULL_FIELDS = ['topicId', 'fingerprint', 'summary', 'nodeName'];

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }

  // 只接受非空字串當 parentId；其餘（undefined、空字串、數字、物件）一律視為根
  function parentKeyOf(node) {
    var p = node && node.parentId;
    return typeof p === 'string' && p !== '' ? p : null;
  }

  // 補齊新欄位。不改既有欄位；status 不在允許清單內就當 null。
  function normalizeChatEntry(entry) {
    if (!isObj(entry)) return entry;
    var out = Object.assign({}, entry);
    out.parentId = parentKeyOf(entry);
    out.status = STATUSES.indexOf(entry.status) >= 0 ? entry.status : null;
    PLAIN_NULL_FIELDS.forEach(function (f) { if (out[f] === undefined) out[f] = null; });
    return out;
  }

  function normalizeChats(chats) {
    return (Array.isArray(chats) ? chats : []).filter(isObj).map(normalizeChatEntry);
  }

  function keyOf(node) { return String(node.id); }

  // 建立樹的內部結構。
  //   byId       id → 第一個擁有該 id 的節點
  //   effParent  節點 → 有效父節點的 id（null＝根；環上的節點與孤兒都是 null）
  //   children   有效父 id → 子節點陣列（未排序）
  //   roots      根節點陣列（未排序）
  function buildTree(chats) {
    var list = (Array.isArray(chats) ? chats : []).filter(isObj);
    var byId = Object.create(null);
    list.forEach(function (c) { var k = keyOf(c); if (!(k in byId)) byId[k] = c; });

    // 找出所有位於環上的 id：從 start 沿 parentId 走，若走回 start，路徑上的 id 都在環上
    var onCycle = Object.create(null);
    list.forEach(function (c) {
      var start = keyOf(c), path = [start], cur = parentKeyOf(byId[start]), steps = 0;
      while (cur !== null && byId[cur] && steps <= list.length) {
        if (cur === start) { path.forEach(function (k) { onCycle[k] = true; }); break; }
        path.push(cur); cur = parentKeyOf(byId[cur]); steps++;
      }
    });

    var effParent = new Map();
    var children = Object.create(null);
    var roots = [];
    list.forEach(function (c) {
      var p = parentKeyOf(c);
      var eff = (onCycle[keyOf(c)] || p === null || !byId[p]) ? null : p;
      effParent.set(c, eff);
      if (eff === null) roots.push(c); else (children[eff] || (children[eff] = [])).push(c);
    });
    return { list: list, byId: byId, effParent: effParent, children: children, roots: roots };
  }

  // 新到舊（根用）
  function byNewest(a, b) {
    var d = (b.createdAt || 0) - (a.createdAt || 0);
    if (d !== 0) return d;
    return keyOf(a) < keyOf(b) ? -1 : keyOf(a) > keyOf(b) ? 1 : 0;
  }
  // 舊到新（子對話用）
  function byOldest(a, b) { return -byNewest(a, b); }

  // 直接子對話（舊到新）。id 不存在或沒有子對話時回傳空陣列。
  function childrenOf(chats, id) {
    var tree = buildTree(chats);
    return (tree.children[String(id)] || []).slice().sort(byOldest);
  }

  // 根對話（新到舊）
  function rootChats(chats) {
    return buildTree(chats).roots.slice().sort(byNewest);
  }

  // 給側欄用的扁平清單。父在前、子在後（深度優先）。
  //   expanded：{ [chatId]: true } 表示該父對話展開；沒有記錄或不是 true 都視為收合（預設收合）。
  //   opts.revealId：指定的對話若藏在收合的父對話底下，會連同祖先一起展開（例如目前正在看的子對話）。
  // 回傳 [{ chat, depth, childCount, open }]；childCount 是直接子對話數（收合時也顯示）。
  // 收合的父對話，其子對話不出現在結果裡。
  function flattenTree(chats, expanded, opts) {
    var tree = buildTree(chats);
    var open = Object.assign({}, isObj(expanded) ? expanded : {});
    var rows = [];
    var seen = new Set();

    if (opts && opts.revealId != null) {
      var cur = tree.byId[String(opts.revealId)], guard = 0;
      while (cur && guard <= tree.list.length) {
        var pk = tree.effParent.get(cur);
        if (pk === null || pk === undefined) break;
        open[pk] = true;
        cur = tree.byId[pk];
        guard++;
      }
    }

    function visit(node, depth) {
      if (seen.has(node)) return; // 防禦：重複 id 或異常資料時不重複輸出
      seen.add(node);
      var kids = (tree.children[keyOf(node)] || []).slice().sort(byOldest);
      var isOpen = open[keyOf(node)] === true;
      rows.push({ chat: node, depth: depth, childCount: kids.length, open: isOpen });
      if (isOpen) kids.forEach(function (k) { visit(k, depth + 1); });
    }
    tree.roots.slice().sort(byNewest).forEach(function (r) { visit(r, 0); });
    return rows;
  }

  return {
    STATUSES: STATUSES,
    normalizeChatEntry: normalizeChatEntry,
    normalizeChats: normalizeChats,
    buildTree: buildTree,
    childrenOf: childrenOf,
    rootChats: rootChats,
    flattenTree: flattenTree,
  };
}));
