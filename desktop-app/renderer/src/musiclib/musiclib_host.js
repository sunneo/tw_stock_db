/* 音樂庫的 app 轉接層（原文嵌入 floating-assistant.js，定義 const FaMusicLibHost；依賴先嵌入的 FaMusicLib、FaMusicLibUI）。
 *   資料夾：用桌面版既有的資料夾瀏覽器（desktopAPI.roots.browse），遞迴走訪用 desktopAPI.rawfs.readdir（每 200 筆讓出執行緒，沒有上限）。
 *   檔頭：desktopAPI.rawfs.readHead（只讀前幾 MB）。
 *   儲存：IndexedDB（資料庫 fa-musiclib，鍵 library）。沒有 IndexedDB 時退回記憶體（畫面會提醒）。
 *   歌詞轉錄：預設接 app 既有的 Whisper 流程（window.fa 上的 _decodeAudioForWhisperWithFallback、_getWhisperTranscriber、_runWhisperWindowed，
 *     與 transcribe_media 工具用同一套；裝置順序同樣是 WebGPU 失敗退回 CPU）。音訊整檔解碼後，每 CHUNK_SEC 秒切一段跑，段與段之間檢查暫停。
 *     可用 FaMusicLibHost.setTranscriber(fn) 換成別的轉錄函式（評測用假轉錄）。 */
const FaMusicLibHost = (function () {
  'use strict';
  var DB_NAME = 'fa-musiclib', STORE = 'kv', KEY = 'library';
  var CHUNK_SEC = 600; // 長音檔每 10 分鐘一段跑（只是分段的大小，不是長度上限；超過的檔案會分成更多段）
  var lib = null, transcriber = null;

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

  // ───── 預設轉錄：接 app 既有的 Whisper 流程 ─────
  // 回傳 { segments:[{start,end,text}], language, durationSeconds, device }；暫停時丟出 err.paused = true
  // 下載 ffmpeg.wasm 的同意：已同意過（localStorage 簽章相符）就直接過；沒同意就把「等待使用者確認下載」做成明確階段（來源與大小寫進階段說明），
  // 再呼叫 app 原本的同意流程（對話裡的卡片）。等待期間不計無進展逾時；使用者拒絕或佇列的等待上限到了才失敗。不替使用者按、不預先寫入同意。
  function consentAlreadyGiven() {
    var sig = FaTranscodeFallback.consentSignature(FA_ASSET_URLS.ffmpegJs, FA_ASSET_URLS.ffmpegCore), saved = null;
    try { saved = localStorage.getItem('fa.ffmpeg.wasmConsent'); } catch (_) { saved = null; }
    return saved === sig;
  }
  function consentDetail() {
    try {
      return FaTranscodeFallback.consentText({ jsUrl: FA_ASSET_URLS.ffmpegJs, coreUrl: FA_ASSET_URLS.ffmpegCore });
    } catch (_) { return '下載 ffmpeg.wasm（約 30 MB）'; }
  }

  // 預設轉錄：每個階段都回報進展（report），讓佇列的無進展偵測知道目前在哪一段、做到哪裡。
  // 階段：decode（讀檔與解碼，單位 MB）、load（載入模型，模型下載的進度也算進展）、infer（推論，每段 CHUNK_SEC 秒，window 30 秒）。
  async function whisperTranscribe(record, opts) {
    var fa = (typeof window !== 'undefined' && window.fa) || null;
    if (!fa || typeof fa._decodeAudioForWhisperWithFallback !== 'function') throw new Error('找不到 Whisper 轉錄（需要桌面版的 app）');
    var a = api();
    if (!a || !a.rawfs || !a.rawfs.readFile) throw new Error('讀取音檔的通道不存在（需要桌面版）');
    var report = typeof opts.report === 'function' ? opts.report : function () {};
    var sizeMB = Math.max(1, (record.sizeBytes || 0) / 1048576);
    report('decode', { detail: '讀取檔案（' + Math.round(sizeMB) + ' MB）', units: sizeMB, window: sizeMB });
    var r;
    try { r = await a.rawfs.readFile(record.path, 'base64'); } catch (e) { throw new Error('讀檔失敗：' + String((e && e.message) || e)); }
    if (!r || r.base64 == null) throw new Error('讀檔失敗：讀不到這個檔案的內容');
    report('decode', { detail: '解碼音訊' });
    var blob = new Blob([b64ToBytes(r.base64)]);
    var audio, cstate = { consentDenied: false }, origConsent = fa._ffmpegWasmConsent;
    fa._ffmpegWasmConsent = async function () { // 只在這次解碼期間生效，之後還原
      if (consentAlreadyGiven()) return true;
      report('consent', { detail: consentDetail(), waitUser: true });
      var ans = await origConsent.call(fa);
      if (!ans) { cstate.consentDenied = true; return false; }
      report('decode', { detail: '已同意下載，載入 ffmpeg.wasm' });
      return true;
    };
    try {
      audio = await fa._decodeAudioForWhisperWithFallback({ filename: record.name, blob: blob }, function (m) { report('decode', { detail: m }); });
    } catch (e) {
      if (cstate.consentDenied) throw new Error('解碼失敗：使用者拒絕下載 ffmpeg.wasm（來源見上一段說明），這個格式無法解碼');
      throw new Error('解碼失敗：' + String((e && e.message) || e));
    } finally {
      fa._ffmpegWasmConsent = origConsent;
    }
    var language = opts.language || 'zh';
    var cpuOnly = fa.advancedSettings && (fa.advancedSettings.whisperDevicePreference === 'cpu' || fa.advancedSettings.offlineDevicePreference === 'cpu');
    var wantGpu = !cpuOnly && await fa._isWebGpuAvailable();
    var order = wantGpu ? ['webgpu', 'wasm'] : ['wasm'];
    var pcm = audio.pcm, rate = audio.sampleRate || 16000, chunk = CHUNK_SEC * rate, nChunks = Math.max(1, Math.ceil(pcm.length / chunk));
    var lastErr = null;
    for (var d = 0; d < order.length; d++) {
      var device = order[d];
      try {
        var segs = [];
        var label = device === 'webgpu' ? 'WebGPU' : 'CPU';
        report('load', { detail: '載入模型（' + label + '）' });
        var tr = await fa._getWhisperTranscriber(device, function (m) { report('load', { detail: m }); });
        for (var c = 0; c < nChunks; c++) {
          if (opts.shouldPause && opts.shouldPause()) { var pe = new Error('已暫停'); pe.paused = true; throw pe; }
          if (opts.onProgress) opts.onProgress(c / nChunks);
          var part = pcm.subarray(c * chunk, Math.min(pcm.length, (c + 1) * chunk));
          var partSec = part.length / rate;
          report('infer', { detail: label + ' 第 ' + (c + 1) + '/' + nChunks + ' 段', units: partSec, window: 30 });
          var merged = await fa._runWhisperWindowed(tr, part, language, device, function (m) { report('infer', { detail: m }); });
          var offset = (c * chunk) / rate;
          (merged && Array.isArray(merged.chunks) ? merged.chunks : []).forEach(function (ch) {
            var text = String((ch && ch.text) || '').trim();
            if (!text) return;
            var ts = Array.isArray(ch.timestamp) ? ch.timestamp : [null, null];
            segs.push({ start: ts[0] == null ? null : ts[0] + offset, end: ts[1] == null ? null : ts[1] + offset, text: text });
          });
        }
        if (opts.onProgress) opts.onProgress(1);
        return { segments: segs, language: language, durationSeconds: audio.durationSeconds, device: device };
      } catch (err) {
        if (err && err.paused) throw err;
        lastErr = err;
        fa._whisperTranscriber = null; fa._whisperTranscriberDevice = null;
      }
    }
    throw new Error('轉錄失敗：' + ((lastErr && lastErr.message) || lastErr || '未知錯誤'));
  }

  function getLib() {
    if (lib) return lib;
    var hasIdb = typeof indexedDB !== 'undefined';
    lib = FaMusicLib.createLibrary(hasIdb ? FaMusicLib.createJsonBackend(io) : FaMusicLib.createMemoryBackend());
    lib.persistent = hasIdb;
    lib.ready = lib.load().then(function () {
      // 佇列在載入後才建（建的時候會把上次沒跑完的「轉錄中」退回未轉錄）
      lib.queue = FaMusicLib.createLyricQueue(lib, function (rec, o) { return (transcriber || whisperTranscribe)(rec, o); }, { language: 'zh' });
    }, function (e) { lib.loadError = e; });
    return lib;
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
        var note = document.createElement('div'); note.style.cssText = 'font-size:12px;color:#59636e;padding:6px 8px'; note.textContent = '載入音樂庫…';
        wrap.appendChild(note);
        L.ready.then(function () {
          note.remove();
          if (L.loadError) { var er = document.createElement('div'); er.style.cssText = 'font-size:12px;color:#cf222e;padding:4px 8px'; er.textContent = '讀取音樂庫失敗：' + (L.loadError.message || L.loadError); wrap.appendChild(er); }
          if (!L.persistent) { var pn = document.createElement('div'); pn.style.cssText = 'font-size:12px;color:#9a6700;padding:4px 8px'; pn.textContent = '注意：這個環境沒有 IndexedDB，音樂庫只存在記憶體，重新開啟會不見。'; wrap.appendChild(pn); }
          FaMusicLibUI.mount(wrap, { library: L, host: PICK_HOST, queue: L.queue || null });
        });
      });
    },
    // 對話裡開音樂庫面板（一則 assistant 訊息，裡面掛畫面）
    _mlOpen() {
      var id = 'm' + Date.now().toString(36);
      this._pushAssistantMessage('🎵 音樂庫：加檔案、加資料夾，掃描後可以用檔名、專輯、標題、演出者，以及轉錄出來的歌詞搜尋（資料存在這台電腦）。\n\n```fa-musiclib\n' + JSON.stringify({ id: id }) + '\n```', null);
      try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* 顯示失敗不影響資料 */ }
    },
    _registerMusicLibCommand() {
      var self = this;
      this.register_slash_command('/musiclib', '', '音樂庫：加檔案或資料夾、掃描、用檔名／專輯／標題／演出者／歌詞搜尋；資料存在本機，重新開啟還在。', async function (argsText, run) {
        (run || self)._mlOpen();
      });
    }
  };

  return { methods: methods, getLib: getLib, pickFolder: pickFolder, walkFolder: walkFolder, whisperTranscribe: whisperTranscribe,
    setTranscriber: function (fn) { transcriber = typeof fn === 'function' ? fn : null; },
    // 調整佇列的無進展／重試政策（評測用；正式值見 musiclib_core 的常數）
    setQueuePolicy: function (p) { var L = getLib(); if (L.queue) L.queue.setPolicy(p); } };
})();
