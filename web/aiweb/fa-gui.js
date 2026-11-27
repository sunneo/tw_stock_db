/* 全螢幕 GUI 入口（web/aiweb/<指令>/ 的共用腳本）。
   由 desktop-app/scripts/gen-aiweb-pages.js 產生到網頁版 repo 的 web/aiweb/fa-gui.js，請勿手改產物；
   來源模板是 desktop-app/scripts/aiweb-gui/fa-gui.template.js，SHA 由產生腳本代入。

   做法：跟 web/aiweb/index.html（AI 助理頁）同一套載入方式——SHA 釘住的 jsDelivr 優先、raw 退路、
   8 秒連線逾時、分塊預抓——然後建立同一個 FloatingAssistant（同源，所以 IndexedDB、localStorage、
   fap 檔案全部跟網頁版原本的一樣），最後直接呼叫登錄表裡該指令的 handler 把 GUI 打開，
   整個頁面只留這個 GUI 佔滿視窗。指令名稱從頁面的 <meta name="fa-gui-cmd"> 讀。 */
(function () {
  'use strict';

  var RAW = 'https://raw.githubusercontent.com/sunneo/tw_stock_db';
  var VENDOR = RAW + '/vendor-assets/vendor';
  var WORKER_BASE = 'https://dawn-disk-778c.sunneo529.workers.dev';
  var FA_SHA = 'e0d3e8a73a4e1fd7bba67a78a76c9ea92b8a91c5';
  var FA_JSD = 'https://cdn.jsdelivr.net/gh/sunneo/tw_stock_db@' + FA_SHA + '/desktop-app/web-lazy/';
  var FA_RAWB = RAW + '/' + FA_SHA + '/desktop-app/web-lazy/';
  var FA_ROOTS = [FA_JSD, FA_RAWB];
  var FA_TIMEOUT_MS = 8000;
  var CMD = ((document.querySelector('meta[name="fa-gui-cmd"]') || {}).content || '').trim();

  // ---- 樣式：只有頂列與佔滿的 GUI 區，不含聊天外框（注入一次，不依賴外部 css） ----
  (function injectStyle() {
    var css = 'html,body{margin:0;height:100%;overflow:hidden;background:#0d1117;}' +
      'body.fa-gui-page{display:flex;flex-direction:column;}' +
      '#fa-gui-top{flex:0 0 auto;display:flex;align-items:center;gap:12px;padding:6px 12px;' +
      'background:#161b22;border-bottom:1px solid #30363d;color:#cbd5e1;font:12px -apple-system,"Segoe UI","Noto Sans TC",sans-serif;}' +
      '#fa-gui-top a{color:#cbd5e1;text-decoration:none;border:1px solid #30363d;border-radius:6px;padding:3px 10px;background:#21262d;}' +
      '#fa-gui-top a:hover{background:#30363d;}' +
      '#fa-gui-top .fa-gui-cmd{font-weight:600;}' +
      '#fa-gui-top .fa-gui-status{margin-left:auto;opacity:.8;}' +
      '#app{flex:1 1 auto;min-height:0;width:100%;display:block;position:relative;}' +
      '.fa-gui-err{padding:16px;color:#f87171;font:14px -apple-system,"Segoe UI","Noto Sans TC",sans-serif;}' +
      /* 全螢幕焦點模式：聊天區只留最新一則（就是 GUI 本身），舊對話與自動補全列隱藏；
         標題列與輸入框保留，因為有些編輯器要靠下面的輸入框用說的改。 */
      'body.fa-gui-mode #ai-chat-body .fa-msg-wrap:not(.fa-gui-focus){display:none !important;}' +
      'body.fa-gui-mode #ai-autocomplete-bar{display:none !important;}' +
      /* 真正全螢幕：隱藏聊天外框（標題列、狀態列、輸入框），GUI 撐滿剩下的整個視窗。
         輸入框預設收起，頂列「⌨ 輸入框」按鈕可以叫出來（有些編輯器要靠它用說的改）。 */
      'body.fa-gui-mode #ai-window-header,body.fa-gui-mode #ai-status-log,body.fa-gui-mode #ai-input-wrap{display:none !important;}' +
      'body.fa-gui-mode.fa-gui-show-input #ai-input-wrap{display:flex !important;}' +
      'body.fa-gui-mode #ai-floating-window{position:relative !important;top:0 !important;left:0 !important;margin:0 !important;flex:1 1 auto !important;min-height:0;width:100% !important;height:auto !important;max-height:none !important;display:flex !important;flex-direction:column;}' +
      'body.fa-gui-mode #ai-chat-body{flex:1 1 auto;min-height:0;height:auto;padding:0 !important;overflow:auto;}' +
      'body.fa-gui-mode #ai-chat-body .fa-msg-wrap.fa-gui-focus{flex:1 1 auto;min-height:100%;box-sizing:border-box;}' +
      'body.fa-gui-mode #app{position:relative;display:flex !important;flex-direction:column;}' +
      '#fa-gui-input-toggle{background:#21262d;color:#cbd5e1;border:1px solid #30363d;border-radius:6px;padding:3px 10px;cursor:pointer;font-size:12px;}' +
      'body.fa-gui-mode #ai-chat-body .fa-msg-wrap.fa-gui-focus{max-width:none !important;margin:0 !important;position:relative;}' +
      /* GUI 本身（視窗外殼 fwin-host）一律撐滿這一則訊息、蓋掉上面的 AI 說明文字。網站同源的 localStorage 可能記著「彈出成小視窗」，
         那會讓它變成固定位置的小窗、原位留一個虛線佔位框；全螢幕頁不吃那個狀態，一律滿版，佔位框藏起來。 */
      'body.fa-gui-mode .fa-gui-focus .fwin-host.fwin-host{position:fixed !important;left:0 !important;right:0 !important;bottom:0 !important;top:var(--fa-gui-top,40px) !important;width:auto !important;height:auto !important;max-width:none !important;max-height:none !important;margin:0 !important;border-radius:0 !important;box-shadow:none !important;transform:none !important;z-index:5 !important;overflow:auto;}' +
      'body.fa-gui-mode .fa-gui-focus .fwin-ph{display:none !important;}' +
      /* 音樂庫：整個畫面直向排，清單區吃掉剩下的高度 */
      'body.fa-gui-mode .fa-gui-focus .fml{min-height:100%;display:flex;flex-direction:column;border-radius:0;border:none;}' +
      'body.fa-gui-mode .fa-gui-focus .fml .fml-wrap{max-height:none;flex:1 1 auto;min-height:200px;resize:none;}' +
      /* 撐滿（2026-11-25 量測）：焦點訊息本身、訊息卡（.ai-msg）、說明卡（.ai-markdown-body）原本只有 86.5% 寬、內容高度，
         改成整個訊息區滿寬、滿高，卡片直向排、內容區吃掉剩下的高度。 */
      'body.fa-gui-mode .fa-gui-focus{display:flex !important;flex-direction:column;box-sizing:border-box;width:100% !important;max-width:none !important;height:100% !important;min-height:100% !important;margin:0 !important;padding:0 !important;}' +
      'body.fa-gui-mode .fa-gui-focus .ai-msg{flex:1 1 auto;display:flex !important;flex-direction:column;min-height:0;box-sizing:border-box;width:100% !important;max-width:none !important;height:100% !important;margin:0 !important;padding:0 !important;}' +
      'body.fa-gui-mode .fa-gui-focus .ai-markdown-body{flex:1 1 auto;display:flex;flex-direction:column;min-height:0;box-sizing:border-box;width:100%;max-width:none;}' +
      /* 內容區要撐滿到 98% 以上（2026-11-25 補量）：作者標籤（「🤖 AI:」）與 GUI 上面的說明句不佔高度（說明句的內容保留在對話紀錄裡，
         GUI 自己的標題與狀態列已經說明用法）；訊息的匯出列與終端機標題列搬到頂列收納區（見 moveChrome），不另外吃高度。
         文字卡頁的說明卡本身就是內容，不隱藏。 */
      'body.fa-gui-mode .fa-gui-focus .ai-msg > div:first-child:not(.ai-markdown-body){display:none !important;}' +
      'body.fa-gui-mode .fa-gui-focus .ai-markdown-body:has(.fa-midi-edit,.ai-terminal-embed,.fwin-host) > p:first-child{display:none !important;}' +
      'body.fa-gui-mode .fa-gui-focus .ai-terminal-embed{padding:0 !important;}' +
      /* 頂列固定高度：收納區的零件（匯出列、終端機標題列）放在頂列裡，不會把頂列撐高 */
      '#fa-gui-top{height:38px;box-sizing:border-box;}' +
      '#fa-gui-chrome{display:flex;align-items:center;gap:6px;margin-left:auto;min-width:0;white-space:nowrap;}' +
      /* 搬進頂列的零件原本是聊天訊息的絕對定位（貼在訊息右下角），這裡改成一般流排版；匯出選單的下拉仍可以展開 */
      '#fa-gui-chrome > *{position:relative !important;top:auto !important;bottom:auto !important;left:auto !important;right:auto !important;width:auto !important;flex:0 0 auto;z-index:10;}' +
      '#fa-gui-chrome > div > div{top:calc(100% + 4px) !important;bottom:auto !important;margin-bottom:0 !important;}' +
      '#fa-gui-chrome > .fwd-bar{background:transparent !important;padding:0 !important;font-size:12px;}' +
      '#fa-gui-chrome > .fwd-bar .t{max-width:360px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      /* 全螢幕頁忽略「彈出成小視窗」的狀態（同源 localStorage 記的，或 GUI 開啟時自己彈出）：彈出副本可能已被搬到 body 底下，
         所以整頁的 fwin-pop 一律收起，留下的就是滿版那一份（不會再冒出 520×520 的浮動小窗蓋住 GUI）。 */
      'body.fa-gui-mode .fwin-host.fwin-pop{display:none !important;}' +
      /* 編輯器的起手式面板（無參數時出現，置中、沒有文字輸入框；不把說明文字推進對話） */
      '#fa-gui-start{position:absolute;left:0;top:0;right:0;bottom:0;z-index:20;overflow:auto;background:#0d1117;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box;}' +
      '#fa-gui-start.fa-gui-start-drop{outline:2px dashed #58a6ff;outline-offset:-12px;}' +
      '#fa-gui-start .fa-gui-start-box{max-width:880px;width:100%;text-align:center;color:#e6edf3;font:14px -apple-system,"Segoe UI","Noto Sans TC",sans-serif;}' +
      '#fa-gui-start h2{margin:0 0 8px;font-size:22px;font-weight:600;}' +
      '#fa-gui-start .fa-gui-start-lead{margin:0 auto 20px;max-width:640px;color:#9da7b3;line-height:1.6;}' +
      /* 起手式面板出現時隱藏說明文字（2026-11-26 合併時的約定：全螢幕頁不顯示說明句，GUI 自己的標題與按鈕已經說明用法） */
      'body.fa-gui-mode #fa-gui-start .fa-gui-start-lead{display:none !important;}' +
      /* 起手式面板撐滿視窗：內容框直向排滿整個面板，大按鈕的格子吃掉剩下的高度，檔案區固定在下面 */
      'body.fa-gui-mode #fa-gui-start .fa-gui-start-box{max-width:none;width:100%;height:100%;display:flex;flex-direction:column;}' +
      'body.fa-gui-mode #fa-gui-start .fa-gui-start-grid{flex:1 1 auto;min-height:0;grid-auto-rows:1fr;}' +
      'body.fa-gui-mode #fa-gui-start .fa-gui-start-file{flex:0 0 auto;}' +
      '#fa-gui-start .fa-gui-start-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px;text-align:left;}' +
      '#fa-gui-start .fa-gui-start-grid button{background:#161b22;color:inherit;border:1px solid #30363d;border-radius:12px;padding:16px;cursor:pointer;font:inherit;text-align:left;}' +
      '#fa-gui-start .fa-gui-start-grid button:hover{border-color:#58a6ff;background:#1c2330;}' +
      '#fa-gui-start .fa-gui-start-grid b{display:block;font-size:16px;margin-bottom:6px;}' +
      '#fa-gui-start .fa-gui-start-grid span{display:block;color:#9da7b3;font-size:12px;line-height:1.5;}' +
      '#fa-gui-start .fa-gui-start-file{margin-top:18px;border:1px dashed #30363d;border-radius:12px;padding:18px;color:#9da7b3;}' +
      '#fa-gui-start .fa-gui-start-file button{background:#21262d;color:#cbd5e1;border:1px solid #30363d;border-radius:8px;padding:8px 16px;cursor:pointer;font:inherit;margin-bottom:6px;}' +
      '#fa-gui-start .fa-gui-start-file button:hover{background:#30363d;}';
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
    // GUI 用 fixed 定位撐滿「頂列以下」的整個視窗：頂列高度量出來放進 CSS 變數（字型、換行會讓它不是固定值）
    function setTop() { var b = document.getElementById('fa-gui-top'); if (b) document.documentElement.style.setProperty('--fa-gui-top', b.offsetHeight + 'px'); }
    setTop(); window.addEventListener('resize', setTop); setTimeout(setTop, 300); setTimeout(setTop, 2000);
  })();

  // 頂列「⌨ 輸入框」切換：收起時 GUI 滿版，叫出來時底部出現輸入框
  (function bindInputToggle() {
    var btn = document.getElementById('fa-gui-input-toggle');
    if (!btn) return;
    btn.addEventListener('click', function () {
      var on = document.body.classList.toggle('fa-gui-show-input');
      btn.textContent = on ? '⌨ 收起輸入框' : '⌨ 輸入框';
    });
  })();

  // 頂列的收納區（聊天零件搬過來用，見 moveChrome）
  (function makeChromeBox() {
    var bar = document.getElementById('fa-gui-top');
    if (!bar || document.getElementById('fa-gui-chrome')) return;
    var box = document.createElement('div'); box.id = 'fa-gui-chrome'; bar.appendChild(box);
  })();

  function setStatus(text) {
    var el = document.getElementById('status');
    if (el && text) el.textContent = text;
  }

  // ---- 跟 aiweb/index.html 同一套：同一組 localStorage 金鑰，AI 設定與主頁共用 ----
  try {
    if (!localStorage.getItem('floating_ai_api_key')) {
      var sid = localStorage.getItem('tw_stock_db_ai_session_id');
      if (!sid) { sid = crypto.randomUUID(); localStorage.setItem('tw_stock_db_ai_session_id', sid); }
      localStorage.setItem('floating_ai_api_key', 'tw_stock_db_api:' + sid);
    }
    if (!localStorage.getItem('floating_ai_base_url_key')) {
      localStorage.setItem('floating_ai_base_url_key', WORKER_BASE);
    }
  } catch (_) { /* 隱私模式等情況下 localStorage 不可用，仍可手動填 AI 設定 */ }

  // ---- 分塊載入（與 aiweb/index.html 相同的 jsDelivr → raw 退路） ----
  window.__FA_LAZY_BASES = [FA_JSD + 'chunks/', FA_RAWB + 'chunks/'];
  window.__FA_LAZY_BASE = FA_RAWB + 'chunks/';
  window.__FA_PREFETCH = {};

  function faReadBody(r) {
    return r.text();
  }
  function faFetchFirst(rel) {
    var i = 0;
    function attempt() {
      var root = FA_ROOTS[i];
      var t0 = performance.now();
      var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      var headersTimer = ctl ? setTimeout(function () { ctl.abort(); }, FA_TIMEOUT_MS) : null;
      return fetch(root + rel, ctl ? { signal: ctl.signal } : undefined)
        .then(function (r) {
          clearTimeout(headersTimer);
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return faReadBody(r);
        })
        .then(function (text) { clearTimeout(headersTimer); return { text: text, source: root }; }, function (e) {
          clearTimeout(headersTimer);
          var msg = (e && e.name === 'AbortError') ? '連線 ' + (FA_TIMEOUT_MS / 1000) + ' 秒內沒有回應' : ((e && e.message) || String(e));
          console.warn('[網頁版載入] ' + rel + ' 從 ' + root + ' 失敗：' + msg + '，耗時 ' + Math.round(performance.now() - t0) + ' 毫秒' + (i + 1 < FA_ROOTS.length ? '，改用下一個來源' : '，已無退路'));
          if (++i < FA_ROOTS.length) return attempt();
          throw e;
        });
    }
    return attempt();
  }
  function loadAssistantScript() {
    var bootP = faFetchFirst('boot.json').then(function (x) { return JSON.parse(x.text); }, function () { return null; });
    var coreP = faFetchFirst('core.js');
    return Promise.all([coreP, bootP]).then(function (res) {
      var b = res[1];
      var names = Array.isArray(b) ? b : (b && Array.isArray(b.names) ? b.names : []);
      setStatus('載入分塊 0/' + names.length);
      var done = 0;
      return Promise.all(names.map(function (n) {
        return faFetchFirst('chunks/' + n + '.js').then(function (x) { window.__FA_PREFETCH[n] = x.text; }, function () { /* 沒預抓到，核心會同步載入 */ })
          .then(function () { done++; setStatus('載入分塊 ' + done + '/' + names.length); });
      })).then(function () { return res[0].text; });
    }).then(function (text) {
      return new Promise(function (resolve, reject) {
        var url = URL.createObjectURL(new Blob([text], { type: 'application/javascript' }));
        var s = document.createElement('script');
        s.src = url;
        s.onload = function () { URL.revokeObjectURL(url); resolve(); };
        s.onerror = function () { URL.revokeObjectURL(url); reject(new Error('floating-assistant.js 執行失敗')); };
        document.head.appendChild(s);
      });
    });
  }

  // 把聊天區最新的一則標成 fa-gui-focus（CSS 只留它）。handler 可能非同步推訊息、聊天區也會重畫，
  // 所以用 MutationObserver 持續標記（頁面存活期間一直觀察；標記本身很便宜）。找不到聊天區就什麼都不做。
  function startFocus() {
    var body = document.getElementById('ai-chat-body');
    if (!body || typeof MutationObserver === 'undefined') return;
    var pending = false;
    function mark() {
      pending = false;
      var all = body.querySelectorAll('.fa-msg-wrap');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('fa-gui-focus', i === all.length - 1);
      if (all.length) moveChrome(all[all.length - 1]);
    }
    // 聊天零件搬到頂列收納區（搬的是原節點，按鈕的事件綁定跟著走，不靠複製）：
    // 焦點訊息的匯出列（ai-msg 最後一個子元素，不是說明卡）、終端機的標題列（含匯出／視窗按鈕）。
    // 每次標記都重算：屬於已被換掉的訊息的零件移除；匯出列只保留最新一個。
    function moveChrome(focus) {
      var box = document.getElementById('fa-gui-chrome');
      if (!box) return;
      Array.prototype.slice.call(box.children).forEach(function (c) {
        if (!c._faOwner || !focus.contains(c._faOwner)) box.removeChild(c);
      });
      var msg = focus.querySelector('.ai-msg');
      if (msg) {
        var kids = Array.prototype.slice.call(msg.children);
        var last = kids[kids.length - 1];
        if (kids.length > 1 && last && last !== msg.firstElementChild && !last.classList.contains('ai-markdown-body')) {
          Array.prototype.slice.call(box.children).forEach(function (c) { if (c._faKind === 'footer') box.removeChild(c); });
          last._faKind = 'footer'; last._faOwner = focus; box.appendChild(last);
        }
      }
      Array.prototype.forEach.call(focus.querySelectorAll('.ai-terminal-export-slot'), function (slot) {
        var row = slot.parentElement && slot.parentElement.parentElement;
        if (!row || box.contains(row)) return;
        row._faKind = 'term'; row._faOwner = row.parentElement; box.appendChild(row);
      });
      // 訓練工作室等視窗卡片自己的標題列（.fwd-bar：標題＋✕）也搬進頂列，讓 iframe 吃掉整個內容高度
      Array.prototype.forEach.call(focus.querySelectorAll('.fwd > .fwd-bar'), function (bar) {
        if (box.contains(bar)) return;
        bar._faKind = 'bar'; bar._faOwner = bar.parentElement; box.appendChild(bar);
      });
    }
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      (window.requestAnimationFrame || setTimeout)(mark);
    }).observe(body, { childList: true, subtree: true });
    mark();
  }

  // ---- 起手式面板：編輯器沒帶參數時全頁置中（沒有文字輸入框，也不把說明文字推進對話）。
  // 按鈕一律呼叫原指令的 handler 並帶起手式 id，不另做一份開啟流程；📂 先用空白起手式開起來，再點（或丟檔案到）編輯器自己的 📂，走同一條讀檔路。
  function showStarterPanel(fa, entry, sl) {
    var app = document.getElementById('app');
    if (!app) return;
    function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
    function runEntry(id) {
      return Promise.resolve(entry.handler(id, fa)).then(function () { setStatus('就緒'); }, function (e) { setStatus('開啟失敗：' + String((e && e.message) || e).slice(0, 80)); });
    }
    function openFile(file) {
      setStatus('開啟 ' + CMD + ' …');
      if (typeof sl.openFile === 'function') {   // 編輯器自己會開檔（例如 MIDI 直接讀進來），不走編輯器的 📂 按鈕
        Promise.resolve(sl.openFile(fa, file)).then(function () { setStatus('就緒'); }, function (e) { setStatus('開啟失敗：' + String((e && e.message) || e).slice(0, 80)); });
        return;
      }
      Promise.resolve(entry.handler(sl.openId, fa)).then(function () { return waitOpenButton(6000); }).then(function (btn) {
        if (!btn) { setStatus('這個編輯器還不能開檔'); return; }
        if (file) {
          var dt = new DataTransfer(); dt.items.add(file);
          btn.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        } else { btn.click(); }
        setStatus('就緒');
      }, function (e) { setStatus('開啟失敗：' + String((e && e.message) || e).slice(0, 80)); });
    }

    var panel = el('div', ''); panel.id = 'fa-gui-start';
    var box = el('div', 'fa-gui-start-box');
    box.appendChild(el('h2', '', sl.label));
    box.appendChild(el('p', 'fa-gui-start-lead', sl.lead));
    var grid = el('div', 'fa-gui-start-grid');
    sl.starters.forEach(function (s) {
      var b = el('button', ''); b.type = 'button';
      b.appendChild(el('b', '', s.label)); b.appendChild(el('span', '', s.desc));
      b.addEventListener('click', function () { panel.remove(); setStatus('開啟 ' + CMD + ' …'); runEntry(s.id); });
      grid.appendChild(b);
    });
    box.appendChild(grid);
    var fileBox = el('div', 'fa-gui-start-file', '或開一個本機檔案（也可以直接把檔案拖進這個頁面）');
    var openB = el('button', '', '📂 開啟檔案'); openB.type = 'button';
    openB.addEventListener('click', function () { panel.remove(); openFile(null); });
    fileBox.appendChild(document.createElement('br'));
    fileBox.appendChild(openB);
    box.appendChild(fileBox);
    panel.appendChild(box);
    panel.addEventListener('dragover', function (ev) { ev.preventDefault(); panel.classList.add('fa-gui-start-drop'); });
    panel.addEventListener('dragleave', function () { panel.classList.remove('fa-gui-start-drop'); });
    panel.addEventListener('drop', function (ev) {
      ev.preventDefault();
      var f = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      panel.remove();
      openFile(f || null);
    });
    app.appendChild(panel);
  }
  // 等編輯器掛上來，回傳它的「📂 開啟檔案」按鈕（data-fa-open-file，由 edit_shell 加上）；逾時回 null
  function waitOpenButton(ms) {
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function poll() {
        var all = document.querySelectorAll('#app [data-fa-open-file]');
        if (all.length) return resolve(all[all.length - 1]);
        if (Date.now() - t0 > ms) return resolve(null);
        setTimeout(poll, 150);
      })();
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[<>&"]/g, function (c) { return { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]; });
  }
  function showError(msg) {
    setStatus('載入失敗');
    var app = document.getElementById('app');
    if (app) {
      app.innerHTML = '<div class="fa-gui-err">' + escapeHtml(msg) + '<br>可能是網路問題，請<a href="" onclick="location.reload();return false;">重新整理</a>再試，或回<a href="../gui/">指令清單</a>。</div>';
    }
  }

  if (!CMD) {
    showError('這個頁面沒有指定指令（缺少 fa-gui-cmd）。');
    return;
  }

  setStatus('載入 AI 引擎中…');
  loadAssistantScript().then(function () {
    if (typeof FloatingAssistant === 'undefined') throw new Error('FloatingAssistant 未定義');
    if (FloatingAssistant.setAssetUrls) {
      // 匯出與 3D 等用到的外部函式庫，同 aiweb/index.html 改用 repo 自己 vendor 的版本
      FloatingAssistant.setAssetUrls({
        pptxgenjs: VENDOR + '/pptxgenjs/pptxgen.bundle.js',
        pdfmake: VENDOR + '/pdfmake/pdfmake.min.js',
        pdfmakeFonts: VENDOR + '/pdfmake/vfs_fonts.js',
        cjkFontRegular: VENDOR + '/fonts-noto-sans-tc/chinese-traditional-400-normal.ttf',
        cjkFontBold: VENDOR + '/fonts-noto-sans-tc/chinese-traditional-700-normal.ttf',
        marked: VENDOR + '/marked/marked.min.js',
        dompurify: VENDOR + '/dompurify/purify.min.js',
        katexJs: VENDOR + '/katex/katex.min.js',
        katexCss: VENDOR + '/katex/katex.min.css',
        jszip: VENDOR + '/jszip/jszip.min.js',
        threejs: VENDOR + '/three/three.min.js',
        threeOrbitControls: VENDOR + '/three/OrbitControls.js',
        threeSTLLoader: VENDOR + '/three/STLLoader.js',
        threeOBJLoader: VENDOR + '/three/OBJLoader.js',
        three3MFLoader: VENDOR + '/three/3MFLoader.js',
        threeFBXLoader: VENDOR + '/three/FBXLoader.js',
        threeFflate: VENDOR + '/three/fflate.min.js',
      });
    }
    var app = document.getElementById('app');
    if (app) app.innerHTML = '';
    var fa = new FloatingAssistant({
      mountSelector: '#app',
      buttonStyle: 'display:none;',
      windowStyle: 'position:static; width:100%; height:100%; max-height:none; box-shadow:none; border-radius:0; z-index:1;',
      chatList: false,
    });
    window.fa = fa;
    fa.toggleWindow(); // 這頁本來就該一直展開（同 aiweb/index.html）

    var entry = fa.slashCommands && fa.slashCommands.get(CMD);
    if (!entry || typeof entry.handler !== 'function') throw new Error('這個版本沒有「' + CMD + '」指令');
    document.body.classList.add('fa-gui-mode');
    startFocus(); // 一直觀察：聊天區會重新渲染節點，標記要跟著新節點走
    // 編輯器沒帶參數：起手式面板（不推說明文字進對話）。沒有起手式的指令照舊（handler('')）。
    var sl = typeof fa._edStarterList === 'function' ? fa._edStarterList(CMD) : null;
    if (!sl && typeof fa._midiStarterList === 'function') sl = fa._midiStarterList(CMD);   // MIDI 不是簡報／遊戲那種編輯器，自己給清單與開檔
    if (sl) { showStarterPanel(fa, entry, sl); setStatus('就緒'); return; }
    setStatus('開啟 ' + CMD + ' …');
    return Promise.resolve(entry.handler('', fa)).then(function () { setStatus('就緒'); });
  }).catch(function (e) {
    showError((e && e.message) || String(e));
  });
})();
