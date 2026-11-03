// GUI 視窗主機：擁有一個終端機 session 的所有 GUI 視窗（開、關、重繪、事件佇列）。
// 協定由 AiChatGuiBridge 檢查（上限 4 視窗、每視窗節點數等）；畫面由 AiChatGuiRender 畫進 container 裡的浮層。
// 這裡不直接碰 DOM 的細節：doc、container、bridge、render 都由呼叫端傳入，所以 node 測試可以用假的 render。
// 事件先進每視窗的佇列（上限 50）：frame 只留最新一個，連續的 mouse move 合併成一個。
(function (root, factory) {
  if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.AiChatGuiHost = factory(); }
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var QUEUE_MAX = 50;

  // opts: { doc, container, bridge, render, onClosed(winId) }
  function createHost(opts) {
    var doc = opts.doc, container = opts.container, bridge = opts.bridge, render = opts.render;
    var session = bridge.createSession();
    var layer = null, views = {}, queues = {}, waiters = {}, pictures = {};

    function ensureLayer() {
      if (!layer) {
        layer = doc.createElement('div');
        layer.className = 'ai-gui-layer';
        container.appendChild(layer);
      }
      return layer;
    }

    // one event line from the page, queued for the window (frame and mouse move are merged)
    function enqueue(winId, name, line) {
      var q = queues[winId] || (queues[winId] = []);
      var move = name === 'mouse' && /"kind":"move"/.test(line);
      if (name === 'frame') { for (var i = q.length - 1; i >= 0; i--) { if (q[i].name === 'frame') { q.splice(i, 1); } } }
      else if (move && q.length && q[q.length - 1].move) { q.pop(); }
      q.push({ name: name, line: line, move: move });
      if (q.length > QUEUE_MAX) { q.shift(); }
      var w = waiters[winId];
      if (w && q.length) { delete waiters[winId]; w(take(winId)); }
    }
    function take(winId) { var q = queues[winId] || []; return q.length ? q.shift().line : null; }

    function onEventFor(winId) {
      return function (name, nodeId, value) {
        var line = bridge.eventLine(session, winId, nodeId, name, value);
        if (line) { enqueue(winId, name, line); }
      };
    }

    // pictures: the decoded Image for a canvas picture name (created once from the checked data URL)
    function picture(winId, nodeId, name) {
      var win = session.windows[winId], node = win && win.nodes[nodeId];
      var data = node && node.images && node.images[name];
      if (!data) { return null; }
      var key = winId + '/' + nodeId + '/' + name;
      if (!pictures[key] || pictures[key].src !== data) {
        var img = new (doc.defaultView || root).Image();
        img.src = data;
        img.onload = function () { repaintCanvas(winId, nodeId); };
        pictures[key] = img;
      }
      return pictures[key].complete ? pictures[key] : null;
    }

    function removeView(winId) {
      var v = views[winId];
      if (v && v.parentNode) { v.parentNode.removeChild(v); }
      delete views[winId];
    }

    function show(winId) {
      var snap = bridge.snapshot(session, winId);
      if (!snap) { return; }
      removeView(winId);
      var view = render.renderWindow(doc, snap, onEventFor(winId), function () { close(winId); }, {
        image: function (nodeId, name) { return picture(winId, nodeId, name); }
      });
      views[winId] = view;
      ensureLayer().appendChild(view);
    }

    function repaintCanvas(winId, nodeId) {
      var view = views[winId];
      var el = view && view.querySelector ? view.querySelector('[data-node="' + nodeId + '"]') : null;
      var win = session.windows[winId], node = win && win.nodes[nodeId];
      if (!el || !node || node.kind !== 'canvas') { return; }
      var ctx = el.getContext ? el.getContext('2d') : null;
      if (!ctx) { return; }
      render.paintFrame(ctx, node.frame || [], el.width, el.height, function (name) { return picture(winId, nodeId, name); });
    }

    function paint(winId) {
      var win = session.windows[winId];
      if (!win) { return; }
      Object.keys(win.nodes).forEach(function (nid) { if (win.nodes[nid].kind === 'canvas') { repaintCanvas(winId, nid); } });
    }

    // close: removes the window and everything queued for it; the program's wait gets null
    function close(winId) {
      if (!session.windows[winId]) { return; }
      bridge.apply(session, { v: 1, op: 'close', id: winId });
      teardown(winId);
    }
    // everything a closed window leaves behind: its view, its queue, a waiting program, and the caller's notice
    function teardown(winId) {
      removeView(winId);
      delete queues[winId];
      var w = waiters[winId];
      if (w) { delete waiters[winId]; w(null); }
      if (opts.onClosed) { opts.onClosed(winId); }
    }

    // apply one "@gui" line (or an already parsed message). Returns {ok} or {ok:false, error}; never throws.
    function apply(line) {
      var parsed = bridge.parseLine(line);
      if (!parsed) { return { ok: false, error: 'not a GUI line' }; }
      if (parsed.error) { return { ok: false, error: parsed.error }; }
      var msg = parsed.msg, result = bridge.apply(session, msg);
      if (!result.ok) { return result; }
      if (msg.op === 'open') { show(msg.id); }
      else if (msg.op === 'close') { teardown(msg.id); }
      else if (msg.op === 'add' || msg.op === 'set' || msg.op === 'remove') { show(msg.id); }
      else if (msg.op === 'draw') { paint(msg.id); }
      else if (msg.op === 'image') { repaintCanvas(msg.id, msg.node); }
      return { ok: true };
    }

    // gui wait: resolves with the next event line of the window, or null when the window closes (timeout is the caller's job)
    function wait(winId) {
      if (!session.windows[winId]) { return Promise.resolve(null); }
      if (queues[winId] && queues[winId].length) { return Promise.resolve(take(winId)); }
      return new Promise(function (resolve) { waiters[winId] = resolve; });
    }

    function poll(winId) { return take(winId); }

    function isOpen(winId) { return !!session.windows[winId]; }

    // the window's current snapshot (for tests and for the caller's own checks)
    function snapshot(winId) { return bridge.snapshot(session, winId); }

    return { apply: apply, wait: wait, poll: poll, close: close, paint: paint, isOpen: isOpen, snapshot: snapshot, session: session, queueLength: function (winId) { return (queues[winId] || []).length; } };
  }

  return { createHost: createHost, QUEUE_MAX: QUEUE_MAX };
}));
