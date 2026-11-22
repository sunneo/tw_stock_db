/* 音樂庫的 app 轉接層（原文嵌入 floating-assistant.js，定義 const FaMusicLibHost；依賴先嵌入的 FaMusicLib、FaMusicLibUI）。
 *   資料夾：用桌面版既有的資料夾瀏覽器（desktopAPI.roots.browse），遞迴走訪用 desktopAPI.rawfs.readdir（回傳名稱、類型、大小、修改時間）。
 *   檔頭：desktopAPI.rawfs.readHead（只讀前幾 MB，不整檔讀進來）。
 *   儲存：IndexedDB（資料庫 fa-musiclib）。關掉重開後還在；沒有 IndexedDB 時退回記憶體（重開會不見，畫面會說明）。
 *   走訪一次讓出一次執行緒（每 200 筆 setTimeout 0），大資料夾不卡畫面。沒有筆數上限。
 *   網頁版沒有 desktopAPI：資料夾按鈕會說明只能在桌面版使用；加檔案仍可用瀏覽器的檔案選取（畫面本身處理）。 */
const FaMusicLibHost = (function () {
  'use strict';
  var DB_NAME = 'fa-musiclib', STORE = 'kv', KEY = 'library';
  var lib = null;

  function idbOpen() {
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(DB_NAME, 1);
      rq.onupgradeneeded = function () { rq.result.createObjectStore(STORE); };
      rq.onsuccess = function () { res(rq.result); };
      rq.onerror = function () { rej(rq.error); };
    });
  }
  // fn(store) 回傳一個 IDBRequest；交易完成後才 resolve（讀取結果從 request.result 取）
  function idbRun(mode, fn) {
    return idbOpen().then(function (db) {
      return new Promise(function (res, rej) {
        var tx = db.transaction(STORE, mode), rq = fn(tx.objectStore(STORE)), out = null;
        rq.onsuccess = function () { out = rq.result; };
        tx.oncomplete = function () { db.close(); res(out); };
        tx.onerror = function () { db.close(); rej(tx.error); };
        tx.onabort = function () { db.close(); rej(tx.error || new Error('IndexedDB 交易中止')); };
      });
    });
  }
  var io = {
    read: function () { return idbRun('readonly', function (st) { return st.get(KEY); }).then(function (v) { return v == null ? null : v; }); },
    write: function (s) { return idbRun('readwrite', function (st) { return st.put(s, KEY); }).then(function () { /* 寫入完成 */ }); }
  };

  function getLib() {
    if (lib) return lib;
    var hasIdb = typeof indexedDB !== 'undefined';
    lib = FaMusicLib.createLibrary(hasIdb ? FaMusicLib.createJsonBackend(io) : FaMusicLib.createMemoryBackend());
    lib.persistent = hasIdb;
    lib.ready = lib.load().catch(function (e) { lib.loadError = e; });
    return lib;
  }

  function api() { return (typeof window !== 'undefined' && window.desktopAPI) || null; }
  function hasDesktopFs() { var a = api(); return !!(a && a.roots && a.roots.browse && a.rawfs && a.rawfs.readdir && a.rawfs.readHead); }
  function tick() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function basename(p) { return String(p || '').split(/[\\\/]/).filter(Boolean).pop() || String(p || ''); }
  function b64ToBytes(b64) { var bin = atob(b64 || ''), u = new Uint8Array(bin.length); for (var i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }

  // 遞迴走訪（用堆疊，不遞迴呼叫）：只收認得的音訊／影片／遊戲來源副檔名；每 200 筆讓出一次執行緒。
  async function walkFolder(root) {
    var a = api(), sep = /\\/.test(root) ? '\\' : '/', stack = [root], out = [], n = 0;
    while (stack.length) {
      var dir = stack.pop(), list;
      try { list = await a.rawfs.readdir(dir); } catch (_) { continue; } // 沒權限或已被刪：略過這個資料夾
      for (var i = 0; i < list.length; i++) {
        var e = list[i], full = dir + (/[\\\/]$/.test(dir) ? '' : sep) + e.name;
        if (e.isDirectory) stack.push(full);
        else if (e.isFile && FaMusicLib.isSupportedName(e.name)) out.push({ path: full, size: e.size || 0, mtimeMs: e.mtimeMs || 0 });
        if (++n % 200 === 0) await tick();
      }
    }
    return out;
  }

  // 按「加資料夾」：先選資料夾，再走訪；回傳畫面要的 { label, entries, readHead }，取消回傳 null
  async function pickFolder() {
    if (!hasDesktopFs()) { if (typeof alert === 'function') alert('資料夾加入只能在桌面版使用；網頁版請用「加檔案」。'); return null; }
    var p = await api().roots.browse();
    if (!p) return null;
    var entries = await walkFolder(p);
    return {
      label: basename(p),
      entries: entries,
      readHead: function (path, n) { return api().rawfs.readHead(path, n).then(function (r) { return r && r.base64 != null ? b64ToBytes(r.base64) : null; }); }
    };
  }

  var PICK_HOST = { pickFolder: pickFolder };

  var methods = {
    _mlLib() { return getLib(); },
    // 把 ```fa-musiclib 區塊換成音樂庫畫面（每次對話重新渲染時都會掛一次）
    _mlMount(mdDiv) {
      if (typeof FaMusicLibUI === 'undefined' || !FaMusicLibUI || !FaMusicLibUI.mount) return;
      mdDiv.querySelectorAll('pre > code.language-fa-musiclib').forEach(function (code) {
        var wrap = document.createElement('div');
        code.parentElement.replaceWith(wrap);
        var L = getLib();
        var panel = FaMusicLibUI.mount(wrap, { library: L, host: PICK_HOST });
        L.ready.then(function () { panel.refresh(); });
        if (!L.persistent) { var note = document.createElement('div'); note.style.cssText = 'font-size:12px;color:#9a6700;padding:4px 8px'; note.textContent = '注意：這個環境沒有 IndexedDB，音樂庫只存在記憶體，重新開啟會不見。'; wrap.appendChild(note); }
        if (L.loadError) { var er = document.createElement('div'); er.style.cssText = 'font-size:12px;color:#cf222e;padding:4px 8px'; er.textContent = '讀取音樂庫失敗：' + (L.loadError.message || L.loadError); wrap.appendChild(er); }
      });
    },
    // 對話裡開音樂庫面板（一則 assistant 訊息，裡面掛畫面）
    _mlOpen() {
      var id = 'm' + Date.now().toString(36);
      this._pushAssistantMessage('🎵 音樂庫：加檔案、加資料夾，掃描後可以用檔名、專輯、標題、演出者搜尋（資料存在這台電腦）。\n\n```fa-musiclib\n' + JSON.stringify({ id: id }) + '\n```', null);
      try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* 顯示失敗不影響資料 */ }
    },
    _registerMusicLibCommand() {
      var self = this;
      this.register_slash_command('/musiclib', '', '音樂庫：加檔案或資料夾、掃描、用檔名／專輯／標題／演出者搜尋；資料存在本機，重新開啟還在。', async function (argsText, run) {
        (run || self)._mlOpen();
      });
    }
  };

  return { methods: methods, getLib: getLib, pickFolder: pickFolder, walkFolder: walkFolder };
})();
