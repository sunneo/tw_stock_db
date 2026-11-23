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
  var FA_SHA = '416bfb79b12098a9d7056de7a807453c8a9b2480';
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
      'body.fa-gui-mode .fa-gui-focus .fml .fml-wrap{max-height:none;flex:1 1 auto;min-height:200px;resize:none;}';
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
    }
    new MutationObserver(function () {
      if (pending) return;
      pending = true;
      (window.requestAnimationFrame || setTimeout)(mark);
    }).observe(body, { childList: true, subtree: true });
    mark();
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
    setStatus('開啟 ' + CMD + ' …');
    return Promise.resolve(entry.handler('', fa)).then(function () { setStatus('就緒'); });
  }).catch(function (e) {
    showError((e && e.message) || String(e));
  });
})();
