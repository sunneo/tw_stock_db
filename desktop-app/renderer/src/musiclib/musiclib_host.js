/* 音樂庫的 app 轉接層（原文嵌入 floating-assistant.js，定義 const FaMusicLibHost；依賴先嵌入的 FaMusicLib、FaMusicLibUI、FaMusicLibYoutube）。
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

  // 絕對路徑：磁碟機開頭（C:\ 或 C:/）、網路路徑（\\）、或 / 開頭。瀏覽器選檔只給檔名，不算絕對路徑。
  function isAbsPath(p) { return /^([a-zA-Z]:[\\\/]|\\\\|\/)/.test(String(p || '')); }
  // 讀檔前確認是完整路徑；只有檔名的舊紀錄（舊版選檔加入）會被 app 資料夾當成相對路徑而找不到，先講清楚原因
  function absPath(p) {
    if (!isAbsPath(p)) throw new Error('這筆紀錄只有檔名、沒有完整路徑（' + p + '），無法讀取。請把它移除後，用「＋加檔案」重新加入。');
    return p;
  }

  // 勾選檔案的小視窗：列出資料夾內認得的檔案，回傳勾選的項目陣列；取消回傳 null
  function chooseFilesDialog(dir, files) {
    return new Promise(function (resolve) {
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.35);z-index:2147483000;display:flex;align-items:center;justify-content:center';
      var box = document.createElement('div');
      box.style.cssText = 'background:#fff;color:#1f2328;border-radius:8px;padding:12px;width:min(560px,92vw);max-height:80vh;display:flex;flex-direction:column;gap:8px;font:13px sans-serif';
      var title = document.createElement('div'); title.textContent = '勾選要加入的檔案（資料夾：' + dir + '）'; title.style.cssText = 'word-break:break-all';
      var listBox = document.createElement('div'); listBox.style.cssText = 'overflow:auto;border:1px solid #d0d7de;padding:4px;flex:1';
      var boxes = files.map(function (f) {
        var row = document.createElement('label'); row.style.cssText = 'display:block;padding:2px 4px;cursor:pointer';
        var cb = document.createElement('input'); cb.type = 'checkbox'; cb.style.marginRight = '6px';
        row.appendChild(cb); row.appendChild(document.createTextNode(f.name)); listBox.appendChild(row);
        return cb;
      });
      var bar = document.createElement('div'); bar.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;align-items:center';
      var all = document.createElement('button'); all.textContent = '全選／全不選';
      var ok = document.createElement('button'); ok.textContent = '加入';
      var no = document.createElement('button'); no.textContent = '取消';
      var allOn = false;
      all.onclick = function () { allOn = !allOn; boxes.forEach(function (c) { c.checked = allOn; }); };
      function done(v) { try { document.body.removeChild(ov); } catch (_) { /* */ } resolve(v); }
      ok.onclick = function () { var got = files.filter(function (f, i) { return boxes[i].checked; }); done(got.length ? got : null); };
      no.onclick = function () { done(null); };
      bar.appendChild(all); bar.appendChild(no); bar.appendChild(ok);
      box.appendChild(title); box.appendChild(listBox); box.appendChild(bar); ov.appendChild(box); document.body.appendChild(ov);
    });
  }

  // 按「加檔案」：桌面版的選檔框拿不到完整路徑（Electron 新版 File 沒有 path），
  // 所以改成先用資料夾瀏覽器選資料夾，再勾選裡面的檔案，每個檔案都帶完整路徑。
  // 回傳 { label, entries, readHead }；取消回傳 null；不是桌面版回傳 undefined（畫面改用瀏覽器選檔）。
  async function pickFiles() {
    if (!hasDesktopFs()) return undefined;
    var p = await api().roots.browse();
    if (!p) return null;
    var list;
    try { list = await api().rawfs.readdir(p); } catch (e) { if (typeof alert === 'function') alert('讀不到這個資料夾：' + String((e && e.message) || e)); return null; }
    var files = list.filter(function (e) { return e.isFile && FaMusicLib.isSupportedName(e.name); }).sort(function (x, y) { return x.name.localeCompare(y.name); });
    if (!files.length) { if (typeof alert === 'function') alert('這個資料夾裡沒有認得的音樂、影片或遊戲檔案'); return null; }
    var chosen = await chooseFilesDialog(p, files);
    if (!chosen) return null;
    var sep = /\\/.test(p) ? '\\' : '/';
    return {
      label: chosen.length === 1 ? chosen[0].name : chosen.length + ' 個檔案',
      entries: chosen.map(function (e) { return { path: p + (/[\\\/]$/.test(p) ? '' : sep) + e.name, size: e.size || 0, mtimeMs: e.mtimeMs || 0 }; }),
      readHead: function (path, n) { return api().rawfs.readHead(path, n).then(function (r) { return r && r.base64 != null ? b64ToBytes(r.base64) : null; }); }
    };
  }

  // ───── 預設轉錄：接 app 既有的 Whisper 流程 ─────
  // 回傳 { segments:[{start,end,text}], language, durationSeconds, device }；暫停時丟出 err.paused = true
  // ffmpeg.wasm 的同意完全沿用 app 既有流程（_decodeAudioForWhisperWithFallback → _ffmpegWasmConsent，
  // localStorage fa.ffmpeg.wasmConsent 記住一次同意）；音樂庫不另加同意階段，也不替換那個函式。

  // 預設轉錄：每個階段都回報進展（report），讓佇列的無進展偵測知道目前在哪一段、做到哪裡。
  // 階段：decode（讀檔與解碼，單位 MB）、load（載入模型，模型下載的進度也算進展）、infer（推論，每段 CHUNK_SEC 秒，window 30 秒）。
  async function whisperTranscribe(record, opts) {
    var fa = (typeof window !== 'undefined' && window.fa) || null;
    if (!fa || typeof fa._decodeAudioForWhisperWithFallback !== 'function') throw new Error('找不到 Whisper 轉錄（需要桌面版的 app）');
    var a = api();
    var report = typeof opts.report === 'function' ? opts.report : function () {};
    var sizeMB = Math.max(1, (record.sizeBytes || record.blob && record.blob.size || 0) / 1048576);
    var blob;
    if (record.blob) { blob = record.blob; } // 哼歌錄音：已經在記憶體裡，不用讀檔
    else {
      if (!a || !a.rawfs || !a.rawfs.readFile) throw new Error('讀取音檔的通道不存在（需要桌面版）');
      report('decode', { detail: '讀取檔案（' + Math.round(sizeMB) + ' MB）', units: sizeMB, window: sizeMB });
      var r;
      try { r = await a.rawfs.readFile(absPath(record.path), 'base64'); } catch (e) { throw new Error('讀檔失敗：' + String((e && e.message) || e)); }
      if (!r || r.base64 == null) throw new Error('讀檔失敗：讀不到這個檔案的內容');
      blob = new Blob([b64ToBytes(r.base64)]);
    }
    report('decode', { detail: '解碼音訊' });
    var audio;
    try {
      audio = await fa._decodeAudioForWhisperWithFallback({ filename: record.name, blob: blob }, function (m) { report('decode', { detail: m }); });
    } catch (e) {
      throw new Error('解碼失敗：' + String((e && e.message) || e));
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

  // ───── 批次輸出（mid／mp3）：桌面版通道 ─────
  var exportCancelled = false;
  function bytesToB64(u8) { var s = '', CH = 0x8000; for (var i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH)); return btoa(s); }
  // 解碼一律用 app 既有的 _decodeAudioBuffer（extract_audio 同一條：瀏覽器原生 decodeAudioData，保留原取樣率，不碰 ffmpeg.wasm）
  async function decodeAudioBytes(u8) { return await window.fa._decodeAudioBuffer(new Blob([u8])); }
  // 取前 sec 秒的樣本，回傳 _encodeMp3 吃得下的最小介面（numberOfChannels／sampleRate／getChannelData）
  function viewSeconds(buf, sec) {
    var n = sec == null ? buf.length : Math.min(buf.length, Math.floor(sec * buf.sampleRate));
    var chans = []; for (var c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c).subarray(0, n));
    return { numberOfChannels: buf.numberOfChannels, sampleRate: buf.sampleRate, length: n, duration: n / buf.sampleRate, getChannelData: function (c) { return chans[c]; } };
  }
  // 截短 MIDI：只留開始時間在限制內的音符，超出的長度剪到限制
  function trimSong(song, limitSec) {
    if (limitSec == null) return song;
    var lim = FaMidi.secToTicks(song, limitSec);
    var s = JSON.parse(JSON.stringify(song));
    s.tracks.forEach(function (tr) { tr.notes = tr.notes.filter(function (n) { return n.t < lim; }).map(function (n) { return { t: n.t, d: Math.min(n.d, lim - n.t), n: n.n, v: n.v }; }); });
    return s;
  }
  function joinPath(dir, name) { var sep = dir.indexOf('\\') >= 0 ? '\\' : '/'; return dir.replace(/[\\\/]+$/, '') + sep + name; }

  // 一個檔案的步驟執行（步驟序列由 FaMusicLib.planExport 決定）
  async function exportRunStep(ctx) {
    var a = api(), fa = window.fa, rec = ctx.item.record, st = { expectSec: null, expectNotes: null, bytes: null, buf: null, view: null, song: null };
    if (!a || !a.rawfs) throw new Error('讀寫檔案的通道不存在（需要桌面版）');
    function checkCancel() { if (exportCancelled || ctx.isCancelled()) { var e = new Error('已取消'); e.cancelled = true; throw e; } }
    async function readSource() { var r = await a.rawfs.readFile(absPath(rec.path), 'base64'); if (!r || r.base64 == null) throw new Error('讀檔失敗：讀不到這個檔案的內容'); return b64ToBytes(r.base64); }
    for (var i = 0; i < ctx.steps.length; i++) {
      checkCancel();
      var step = ctx.steps[i];
      ctx.onStage(step);
      if (step === 'decode') { st.buf = await decodeAudioBytes(await readSource()); }
      else if (step === 'slice') {
        var w = FaMusicLib.sliceWindow(st.buf.duration, ctx.limitSec);
        st.view = viewSeconds(st.buf, ctx.limitSec); st.expectSec = w.endSec;
      }
      else if (step === 'encode-mp3') { var blob = await fa._encodeMp3(st.view, 128); st.bytes = new Uint8Array(await blob.arrayBuffer()); }
      else if (step === 'parse-mid') { st.song = FaMidi.parse(await readSource()); }
      else if (step === 'trim-mid') {
        st.song = trimSong(st.song, ctx.limitSec);
        st.expectNotes = FaMidi.noteCount(st.song);
        st.expectSec = ctx.limitSec == null ? FaMidi.durationSec(st.song) : Math.min(ctx.limitSec, FaMidi.durationSec(st.song));
      }
      else if (step === 'render-synth') {
        var rb = await FaMidiPlay.renderOffline(st.song, fa._midiSources(), { tail: 0 });
        st.buf = rb;
      }
      else if (step === 'write-mid') { st.bytes = FaMidi.write(st.song); }
      else if (step === 'to-song') {
        // 既有 FaAudioPipeline：ctx.useModel 才試 Basic Pitch（沒模型或失敗就單音追蹤，並記在 st.method）
        var sg = await songFromMedia(chansOf(st.view), st.view.sampleRate, !!ctx.useModel, basename(rec.name), !!ctx.allowDownload);
        st.song = sg.song; st.method = sg.method;
        st.expectNotes = FaMidi.noteCount(st.song);
        st.expectSec = st.view.duration;
      }
      else { throw new Error('未知步驟：' + step); }
    }
    checkCancel();
    if (!st.bytes) throw new Error('輸出是空的（步驟沒有產生位元組）');
    var name = FaMusicLib.outputName(rec.name, ctx.item.format, ctx.minutes);
    var path = joinPath(ctx.outDir, name);
    ctx.onStage('write');
    var wr = await a.rawfs.writeFile(path, { base64: bytesToB64(st.bytes) });
    return { path: path, sizeBytes: wr && wr.sizeBytes, format: ctx.item.format, expectSec: st.expectSec, expectNotes: st.expectNotes, method: st.method || null };
  }

  // 寫完後讀回磁碟檢查：大小一致、mp3 用原生解碼器量長度、mid 用 FaMidi 解析並比對音符數
  async function verifyOutput(out) {
    var a = api();
    var r = await a.rawfs.readFile(out.path, 'base64');
    if (!r || r.base64 == null) return { ok: false, detail: '寫入後讀不回檔案' };
    var u8 = b64ToBytes(r.base64);
    if (u8.length === 0) return { ok: false, detail: '檔案大小為 0' };
    if (out.sizeBytes != null && u8.length !== out.sizeBytes) return { ok: false, detail: '讀回大小 ' + u8.length + ' 與寫入 ' + out.sizeBytes + ' 不一致' };
    if (out.format === 'mp3') {
      var head = (u8[0] === 0x49 && u8[1] === 0x44 && u8[2] === 0x33) || (u8[0] === 0xff && (u8[1] & 0xe0) === 0xe0);
      if (!head) return { ok: false, detail: '檔頭不是 MP3（沒有 ID3 或幀同步）' };
      var dec = await decodeAudioBytes(u8);
      if (Math.abs(dec.duration - out.expectSec) > 1.0) return { ok: false, detail: 'MP3 長度 ' + dec.duration.toFixed(2) + ' 秒，預期 ' + out.expectSec.toFixed(2) + ' 秒' };
      return { ok: true, detail: 'MP3 ' + dec.duration.toFixed(2) + ' 秒（預期 ' + out.expectSec.toFixed(2) + '），' + u8.length + ' 位元組' };
    }
    var song = FaMidi.parse(u8);
    var ns = FaMidi.noteCount(song), dur = FaMidi.durationSec(song);
    if (out.expectNotes != null && ns !== out.expectNotes) return { ok: false, detail: 'MIDI 音符數 ' + ns + '，預期 ' + out.expectNotes };
    if (out.expectSec != null && Math.abs(dur - out.expectSec) > 1.0) return { ok: false, detail: 'MIDI 長度 ' + dur.toFixed(2) + ' 秒，預期 ' + out.expectSec.toFixed(2) + ' 秒' };
    return { ok: true, detail: 'MIDI ' + dur.toFixed(2) + ' 秒，' + ns + ' 個音符' };
  }

  // 批次輸出入口。records：勾選的曲目；opts: { format:'mid'|'mp3', minutes:'whole'|數字, outDir（省略則跳出資料夾選擇）, onEvent }
  async function exportBatch(records, opts) {
    var a = api();
    if (!a || !a.roots || !a.roots.browse || !a.rawfs) throw new Error('批次輸出需要桌面版');
    if (typeof FaMidi === 'undefined' || typeof FaMidiPlay === 'undefined') throw new Error('MIDI 模組不存在（需要桌面版）');
    exportCancelled = false;
    var outDir = opts.outDir || await a.roots.browse();
    if (!outDir) return { cancelled: true, results: [], summary: {} };
    var items = records.map(function (r) { return { id: r.key, name: r.name, format: opts.format, record: r }; });
    return FaMusicLib.runExportBatch(items, {
      minutes: opts.minutes,
      isCancelled: function () { return exportCancelled; },
      onEvent: opts.onEvent,
      runStep: function (ctx) { ctx.outDir = outDir; ctx.minutes = opts.minutes; ctx.useModel = !!opts.useModel; ctx.allowDownload = !!opts.useModel; return exportRunStep(ctx); },
      verify: function (out) { return verifyOutput(out); }
    }).then(function (res) { res.outDir = outDir; return res; });
  }

  // ───── 旋律找歌：轉接層 ─────
  // 音訊轉音符一律用既有的 audio_to_midi（FaAudioToMidi.pitchTrack／framesToNotes），不用模型，所以索引標「簡易轉譜」。
  // Basic Pitch（既有 FaAudioModels／FaAudioRuntime 的載入方式，與 _audioToMidi 相同）。
  // 模型沒下載過：allowDownload 為 false 就回傳 null（呼叫端退回單音追蹤並標明）；為 true 才用既有 fetchModel 下載。
  async function basicPitchTranscriber(allowDownload) {
    var store = FaAudioModels.idbStore(), id = 'basic-pitch';
    var st = await FaAudioModels.status(id, store);
    if (!st.complete && !allowDownload) return { transcriber: null, note: 'Basic Pitch 模型還沒下載' };
    var bytes = await FaAudioModels.fetchModel(id, {
      fetchFn: function (u, h) { return fetch(u, { headers: h }); }, store: store,
      sha256: FaAudioModels.webSha256, sleep: function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    });
    var ort = await FaAudioRuntime.loadOrt();
    var s = await FaAudioRuntime.createSession(ort, bytes, ['wasm'], {});
    return { transcriber: FaAudioRuntime.makeTranscriber(ort, s.session), note: '' };
  }
  // 音訊（已解碼的 AudioBuffer 或 Blob）→ 歌曲：走既有 FaAudioPipeline；useModel 才試 Basic Pitch
  async function songFromMedia(channelsBuf, sr, useModel, title, allowDownload) {
    var tr = { transcriber: null, note: '' };
    if (useModel) tr = await basicPitchTranscriber(!!allowDownload);
    var chans = Array.isArray(channelsBuf) ? channelsBuf : [];
    var r = await FaMusicLibAudio.songFromAudio({ channels: chans, sampleRate: sr }, {
      Pipeline: FaAudioPipeline, transcriber: tr.transcriber, title: title,
      modelNote: useModel ? tr.note : ''
    });
    return r;
  }
  function chansOf(buf) { var out = []; for (var c = 0; c < buf.numberOfChannels; c++) out.push(buf.getChannelData(c)); return out; }
  // 索引用：mid 直接取旋律；音訊先用既有 _decodeAudioBuffer 解碼，再 songFromMedia（可選 Basic Pitch）。失敗丟錯，訊息附階段
  async function extractMelody(rec, useModel) {
    var a = api(), fa = window.fa;
    var r;
    try { r = await a.rawfs.readFile(absPath(rec.path), 'base64'); } catch (e) { throw new Error('讀檔失敗：' + String((e && e.message) || e)); }
    if (!r || r.base64 == null) throw new Error('讀檔失敗：讀不到這個檔案的內容');
    var u8 = b64ToBytes(r.base64);
    if (/\.midi?$/i.test(rec.name)) {
      var song = FaMidi.parse(u8);
      return { notes: FaMusicLibMelody.melodyFromSong(song), method: 'mid' };
    }
    var buf;
    try { buf = await fa._decodeAudioBuffer(new Blob([u8])); } catch (e) { throw new Error('解碼失敗：' + String((e && e.message) || e)); }
    var sg;
    try { sg = await songFromMedia(chansOf(buf), buf.sampleRate, !!useModel, rec.name, !!useModel); } catch (e) { throw new Error('轉譜失敗：' + String((e && e.message) || e)); }
    return { notes: FaMusicLibMelody.melodyFromSong(sg.song), method: sg.method };
  }
  // 查詢用：錄下的哼歌或選的音檔 → 音符（同索引的音訊路線）
  async function notesFromHum(blob, useModel) {
    var buf = await window.fa._decodeAudioBuffer(blob);
    var sg = await songFromMedia(chansOf(buf), buf.sampleRate, !!useModel, '哼歌', !!useModel);
    return { notes: FaMusicLibMelody.melodyFromSong(sg.song), method: sg.method };
  }
  // 試聽：從音樂庫的檔案讀出來，用 new Audio(objectURL)（與 app 的 TTS 試聽同一寫法），從 startSec 開始，endSec 後停
  // 切出 [fromSec, toSec] 這一段：音符平移到 0 起算（跨界的音符截斷），速度取該段開頭的速度（段內的速度變化保留）
  function clipMidiSong(song, fromSec, toSec) {
    var t0 = FaMidi.secToTicks(song, fromSec), t1 = FaMidi.secToTicks(song, toSec);
    var s = JSON.parse(JSON.stringify(song));
    var tempos = (song.tempos || [{ t: 0, bpm: 120 }]).slice().sort(function (x, y) { return x.t - y.t; });
    var startBpm = tempos[0].bpm; tempos.forEach(function (x) { if (x.t <= t0) startBpm = x.bpm; });
    s.tempos = [{ t: 0, bpm: startBpm }].concat(tempos.filter(function (x) { return x.t > t0 && x.t < t1; }).map(function (x) { return { t: x.t - t0, bpm: x.bpm }; }));
    s.tracks.forEach(function (tr) {
      tr.notes = (tr.notes || []).filter(function (n) { return n.t < t1 && n.t + n.d > t0; }).map(function (n) {
        var a = Math.max(n.t, t0), b = Math.min(n.t + n.d, t1);
        return Object.assign({}, n, { t: a - t0, d: Math.max(1, b - a) });
      });
    });
    s.tracks = s.tracks.filter(function (tr) { return tr.notes.length; });
    return s;
  }
  async function playClip(path, startSec, endSec) {
    var a = api(); var r = await a.rawfs.readFile(absPath(path), 'base64');
    if (!r || r.base64 == null) throw new Error('讀不到這個檔案');
    var bytes = b64ToBytes(r.base64);
    // MIDI 不是瀏覽器的音訊檔，<audio> 播不了（會報「找不到支援的來源」）；旋律索引收的主要就是 MIDI，
    // 所以命中段改用 app 的 MIDI 播放器播：把命中前後的音符切出來，回傳播放卡片節點（畫面把它插在結果旁邊）。
    if (bytes.length > 4 && bytes[0] === 0x4D && bytes[1] === 0x54 && bytes[2] === 0x68 && bytes[3] === 0x64) {
      if (typeof FaMidi === 'undefined' || typeof FaMidiUI === 'undefined') throw new Error('MIDI 播放器不存在（需要桌面版）');
      var fa = window.fa; if (!fa || !fa._midiHost) throw new Error('MIDI 播放器不存在（需要桌面版）');
      var clip = clipMidiSong(FaMidi.parse(bytes), Math.max(0, startSec - 0.3), endSec + 1);
      var node = await FaMidiUI.mount({ song: clip, title: '命中段 ' + startSec.toFixed(1) + '–' + endSec.toFixed(1) + ' 秒', host: fa._midiHost(), M: FaMidi });
      return { node: node };
    }
    var url = URL.createObjectURL(new Blob([bytes]));
    var au = new Audio(url);
    au.onloadedmetadata = function () { try { au.currentTime = Math.max(0, startSec - 0.3); } catch (_) { /* */ } };
    await au.play();
    setTimeout(function () { try { au.pause(); } catch (_) { /* */ } URL.revokeObjectURL(url); }, Math.max(1, (endSec - startSec) + 1) * 1000);
    return au;
  }
  // 麥克風錄音：getUserMedia（同 app 其他錄音的寫法），錄 seconds 秒，回傳 Blob
  async function recordHum(seconds) {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('這個環境沒有麥克風權限 API');
    var stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    return new Promise(function (resolve, reject) {
      var chunks = [], rec;
      try { rec = new MediaRecorder(stream); } catch (e) { stream.getTracks().forEach(function (t) { t.stop(); }); reject(e); return; }
      rec.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
      rec.onstop = function () { stream.getTracks().forEach(function (t) { t.stop(); }); resolve(new Blob(chunks, { type: rec.mimeType || 'audio/webm' })); };
      rec.start();
      setTimeout(function () { try { rec.stop(); } catch (_) { /* */ } }, Math.max(1, seconds) * 1000);
    });
  }

  // 索引狀態：暫停用一個共用的 gate，取消用旗標（同歌詞轉錄的做法，但這裡是逐首序列跑）
  var melodyState = { running: false, paused: false, cancelled: false, resumeWaiters: [], counts: {} };
  function melodyGate() { if (!melodyState.paused) return Promise.resolve(); return new Promise(function (r) { melodyState.resumeWaiters.push(r); }); }
  function melodyResume() { melodyState.paused = false; var w = melodyState.resumeWaiters.splice(0); w.forEach(function (f) { f(); }); }

  // 排隊：一次只跑一批（手動「建立索引」與 YouTube 自動索引共用這條佇列）。正在跑時新批次排進 pending，由同一個迴圈依序跑完，不會同時開多個解碼。
  var melodyPending = [];
  var melodyExtractOverride = null;   // 測試用：換掉「抽旋律」的步驟（正式版不設）
  // 一批：keys 為 null 代表全部曲庫（手動建立）；否則只收這些 key。回傳 runMelodyIndex 的摘要（全部時另附收錄範圍的統計）
  async function runMelodyBatch(L, batch) {
    var recs = [], excludedCount = 0, excludedByReason = {}, groups = { source: 0, mp3: 0, wav: 0, other: 0 };
    L.records.forEach(function (r) {
      if (batch.keys && !batch.keys[r.key]) return;
      var e = FaMusicLib.melodyEligible(r);
      if (e.ok) recs.push(r);
      else if (!batch.keys) { excludedCount++; groups[FaMusicLib.melodyGroup(r)]++; excludedByReason[e.reason] = (excludedByReason[e.reason] || 0) + 1; }
    });
    // 每個要求的 key 都要有結局（呼叫端靠事件計數）：沒跑到的（不在收錄範圍、或取消）補一筆失敗事件
    var seen = {}, onEvent = function (ev) { if (ev && ev.key != null) seen[ev.key] = true; if (batch.onEvent) batch.onEvent(ev); };
    var saveCount = 0;
    var sum = await FaMusicLibMelody.runMelodyIndex(recs, {
      extract: function (rec) { return (melodyExtractOverride || extractMelody)(rec, !!batch.useModel); },
      save: async function () { if (++saveCount % 10 === 0) await L.save(); },
      onEvent: onEvent,
      isCancelled: function () { return melodyState.cancelled; },
      waitIfPaused: melodyGate
    });
    if (batch.keys) Object.keys(batch.keys).forEach(function (k) {
      if (!seen[k]) onEvent({ key: k, status: 'failed', reason: melodyState.cancelled ? '索引已取消' : '不在旋律索引的收錄範圍' });
    });
    await L.save();
    sum.excluded = excludedCount; sum.excludedByReason = excludedByReason; sum.groups = groups;
    sum.failures = recs.filter(function (r) { return r.melody && r.melody.status === 'failed'; }).map(function (r) { return { name: r.name, reason: r.melody.reason }; });
    return sum;
  }
  // 跑佇列：first 先跑，之後把排隊中的批次依序跑完；結束時（含丟錯）把沒跑的排隊收掉，等它的人不會永遠等
  async function melodyRunLoop(first) {
    melodyState.running = true; melodyState.cancelled = false;
    try {
      var L = getLib(); await L.ready;
      var result = await runMelodyBatch(L, first);
      while (melodyPending.length) {
        var nb = melodyPending.shift();
        try { nb.resolve(await runMelodyBatch(L, nb)); } catch (e) { nb.reject(e); }
      }
      return result;
    } finally {
      melodyState.running = false; melodyState.paused = false;
      melodyPending.splice(0).forEach(function (p) { p.resolve({ done: 0, skipped: 0, failed: 0, cancelled: 0 }); });
    }
  }
  // 建立（或續跑）旋律索引：已建且檔案沒變的跳過；結果寫進音樂庫的紀錄（record.melody），再 lib.save()
  function buildMelodyIndex(onEvent, useModel) {
    if (melodyState.running) return Promise.reject(new Error('旋律索引已在建立中'));
    return melodyRunLoop({ keys: null, onEvent: onEvent, useModel: useModel });
  }
  // 排入一批指定的影片記錄（YouTube 自動索引）：正在跑就併入佇列（回傳的 Promise 在它跑完時 resolve），否則立刻開始
  function melodyQueueKeys(keyList, onEvent, useModel) {
    var keys = {}; keyList.forEach(function (k) { keys[k] = true; });
    var batch = { keys: keys, onEvent: onEvent, useModel: !!useModel };
    if (melodyState.running) return new Promise(function (resolve, reject) { batch.resolve = resolve; batch.reject = reject; melodyPending.push(batch); });
    return melodyRunLoop(batch);
  }
  // 查詢用的索引項目（只取建好的）
  function melodyEntries(L) {
    return L.records.filter(function (r) { return r.melody && r.melody.status === 'ok'; }).map(function (r) {
      return { key: r.key, name: r.name, contour: r.melody.contour, method: r.melody.method, path: r.path };
    });
  }
  // 哼歌的文字：先用既有轉錄（whisperTranscribe，同歌詞轉錄的 Whisper 流程）取文字；面板手動填的文字優先
  async function transcribeHum(blob) {
    var r = await whisperTranscribe({ blob: blob, name: 'hum.webm', sizeBytes: blob.size }, { report: function () {} });
    return ((r && r.segments) || []).map(function (s) { return s.text; }).join(' ').trim();
  }
  // 找歌：notes（查詢音符）＋可選的文字加分（可關閉）。文字來源：手動填的，或從哼歌錄音轉錄
  async function searchHum(notes, opts) {
    var L = getLib(), entries = melodyEntries(L), textHits = null, text = '';
    opts = opts || {};
    var t0 = Date.now();
    // 先只用旋律比對（索引已建好，這一步通常不到一秒）並立刻回報；文字轉錄（要載入語音模型，可能要很久）放在後面
    var base = FaMusicLibMelody.searchMelody(notes, entries, { minScore: opts.minScore, limit: opts.limit || 10, textHits: null, textWeight: 0.15 });
    base.textUsed = ''; base.matchMs = Date.now() - t0; base.entryCount = entries.length; base.partial = !!opts.useText;
    var manual = opts.useText ? String(opts.textQuery || '').trim() : '';
    if (!opts.useText || !base.ok) { base.partial = false; return base; }
    if (!manual && !opts.blob) { base.partial = false; return base; }
    if (opts.onPartial) { try { opts.onPartial(base); } catch (_) { /* 畫面出錯不影響搜尋 */ } }
    text = manual;
    var t1 = Date.now();
    if (!text) { try { text = await transcribeHum(opts.blob); } catch (e) { base.partial = false; base.textError = String((e && e.message) || e); return base; } }
    if (text) textHits = new Set(L.search(text, { scope: 'lyrics' }).map(function (x) { return x.record.key; }));
    var res = FaMusicLibMelody.searchMelody(notes, entries, { minScore: opts.minScore, limit: opts.limit || 10, textHits: textHits, textWeight: 0.15 });
    res.textUsed = text; res.matchMs = base.matchMs; res.transcribeMs = Date.now() - t1; res.entryCount = entries.length; res.partial = false;
    return res;
  }
  // 找不到時：把查到的旋律用 MIDI 演奏出來（用既有的 MIDI 編輯器與播放）
  // 回傳 { node }：MIDI 播放卡片，由畫面插在按鈕下面（舊做法是把編輯器訊息塞到對話最下面，音樂庫面板在上面看不到，像是按了沒反應）
  async function humAsMidi(notes, title) {
    var fa = window.fa, s = FaMidi.emptySong();
    if (!fa || !fa._midiHost || typeof FaMidiUI === 'undefined') throw new Error('MIDI 播放器不存在（需要桌面版）');
    s.title = title || '哼歌旋律';
    var mel = FaMusicLibMelody.melodyNotes(notes);
    s = FaMidi.addTrack(s, '哼歌旋律', 0, false);
    var ti = s.tracks.length - 1;
    mel.forEach(function (x) { s = FaMidi.addNote(s, ti, { t: FaMidi.secToTicks(s, x.t), d: Math.max(1, FaMidi.secToTicks(s, x.t + x.d) - FaMidi.secToTicks(s, x.t)), n: Math.round(x.n), v: 90 }); });
    if (!mel.length) throw new Error('沒有可演奏的音符');
    var node = await FaMidiUI.mount({ song: FaMidi.validate(s), title: (s.title || '哼歌旋律') + '（' + mel.length + ' 個音）', host: fa._midiHost(), M: FaMidi });
    return { node: node };
  }

  var MELODY_HOST = {
    buildIndex: buildMelodyIndex,
    cancelIndex: function () { melodyState.cancelled = true; melodyResume(); },
    pauseIndex: function () { melodyState.paused = true; },
    resumeIndex: function () { melodyResume(); },
    indexState: function () { return { running: melodyState.running, paused: melodyState.paused }; },
    recordHum: recordHum,
    notesFromHum: notesFromHum,
    search: searchHum,
    humAsMidi: humAsMidi,
    playClip: playClip,
    basicPitchStatus: function () { return FaAudioModels.status('basic-pitch', FaAudioModels.idbStore()); },
    entries: function () { return melodyEntries(getLib()); },
    // 測試用：換掉「抽旋律」步驟（不讀檔、不解碼）；正式版不呼叫
    setExtractForTest: function (fn) { melodyExtractOverride = typeof fn === 'function' ? fn : null; }
  };
  // ───── 遊戲音樂來源擷取（RIX、Flash、NES）：輸出標準 MIDI／mp3／wav，登記成來源的子曲目 ─────
  // 衍生檔預設放在「來源檔所在資料夾的旁邊」的「音樂庫衍生檔」資料夾（不寫進 repo）；面板可指定別的根資料夾。
  // 來源沒變（大小與修改時間相同）且子曲目已在 → 略過（子曲目記著 derivedSig）。
  var extractCancelled = false;
  var DERIVED_DIR_NAME = '音樂庫衍生檔';
  function stemOf(name) { return String(name || 'track').replace(/\.[^.]+$/, '').replace(/[\\\/:*?"<>|]/g, '_'); }
  function dirOf(p) { var s = String(p), i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/')); return i >= 0 ? s.slice(0, i) : '.'; }
  function sepOf(p) { return /\\/.test(String(p)) ? '\\' : '/'; }
  function derivedDirFor(rec, userRoot) {
    var stem = stemOf(rec.name);
    if (userRoot) return joinPath(userRoot, stem);
    var parent = dirOf(rec.path), beside = dirOf(parent);   // 來源檔所在資料夾的旁邊
    return joinPath(joinPath(beside, DERIVED_DIR_NAME), stem);
  }
  // zlib 解壓（瀏覽器原生 DecompressionStream；SWF 的 CWS 用）
  async function inflateZlib(u8) {
    if (typeof DecompressionStream === 'undefined') throw new Error('這個環境沒有 DecompressionStream（無法解 zlib）');
    var s = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate'));
    return new Uint8Array(await new Response(s).arrayBuffer());
  }
  async function writeDerivedFile(dir, name, bytes) {
    var full = joinPath(dir, name);
    await api().rawfs.writeFile(full, { base64: bytesToB64(bytes) });
    return { path: full, sizeBytes: bytes.length };
  }

  // 擷取一個來源（rec 是 kind 為 rix、swf 或 nes 的曲庫記錄）。回傳 { skipped, children, skippedParts, method, dir }；失敗丟錯，訊息附階段
  async function extractGameSource(rec, opts) {
    opts = opts || {};
    var L = getLib(); await L.ready;
    var fa = window.fa, a = api(), now = Date.now();
    var sig = FaMusicLibMelody.sigOf(rec);
    var existing = L.records.filter(function (r) { return r.derivedFrom === rec.key; });
    if (!opts.force && existing.length && existing.every(function (r) { return r.derivedSig === sig; })) {
      return { skipped: true, reason: '來源沒變，沿用上次的子曲目', children: existing.map(function (r) { return r.key; }), skippedParts: [], method: existing[0].derivedMethod, dir: dirOf(existing[0].path) };
    }
    var r;
    try { r = await a.rawfs.readFile(absPath(rec.path), 'base64'); } catch (e) { throw new Error('讀檔失敗（讀取階段）：' + String((e && e.message) || e)); }
    if (!r || r.base64 == null) throw new Error('讀檔失敗（讀取階段）：讀不到這個檔案的內容');
    var u8 = b64ToBytes(r.base64);
    var dir = derivedDirFor(rec, opts.userRoot), stem = stemOf(rec.name);
    var outs = [], method = '', skippedParts = [];
    var emit = opts.onStage || function () {};
    var cancelled = function () { return extractCancelled; };
    if (rec.kind === 'rix') {
      emit('解析 RIX');
      var px;
      try { px = FaMusicLibRix.parseRix(u8); } catch (e) { throw new Error('RIX 解析失敗：' + String((e && e.message) || e)); }
      method = 'RIX（OPL2 暫存器序列）→ MIDI（GM 音色近似）';
      var song = FaMidi.validate(px.song);
      emit('寫出 MIDI');
      outs.push({ kind: 'mid', name: stem + '.mid', bytes: FaMidi.write(song), method: method, durationSec: px.stats.seconds, title: stem });
      if (cancelled()) throw Object.assign(new Error('已取消'), { cancelled: true });
      emit('合成音訊（既有 GM 合成器）');
      var buf;
      try { buf = await FaMidiPlay.renderOffline(song, fa._midiSources(), { tail: 1.5 }); } catch (e) { throw new Error('合成失敗（合成階段）：' + String((e && e.message) || e)); }
      emit('編碼 mp3');
      var mp3 = await fa._encodeMp3(buf, 160);
      outs.push({ kind: 'mp3', name: stem + '.mp3', bytes: new Uint8Array(await mp3.arrayBuffer()), method: method, durationSec: buf.duration, title: stem });
      outs.push({ kind: 'wav', name: stem + '.wav', bytes: new Uint8Array(await _faEncodeWav(buf).arrayBuffer()), method: method, durationSec: buf.duration, title: stem });
    } else if (rec.kind === 'swf') {
      emit('解析 Flash');
      var sw;
      try {
        sw = await FaMusicLibSwf.parseSwf(u8, {
          inflate: inflateZlib,
          lzmaDecode: function (hdr) { if (typeof FaMatrixLzma === 'undefined') throw new Error('沒有 LZMA 解碼器（FaMatrixLzma 未嵌入）'); return FaMatrixLzma.lzmaDecode(hdr); }
        });
      } catch (e) { throw new Error('SWF 解析失敗：' + String((e && e.message) || e)); }
      method = 'Flash（SWF）音訊標籤解出（' + (String.fromCharCode(u8[0], u8[1], u8[2]) === 'FWS' ? '未壓縮' : '已解壓') + '）';
      sw.sounds.forEach(function (s, i) {
        var ext = s.kind === 'mid' ? 'mid' : s.kind === 'mp3' ? 'mp3' : 'wav';
        var tag = s.source === 'stream' ? '串流' : ('聲音' + s.id);
        outs.push({ kind: ext, name: stem + '_' + (i + 1) + '_' + tag + '.' + ext, bytes: s.bytes, method: method + '，' + s.format, durationSec: s.durationSec, title: stem + ' ' + tag });
      });
      skippedParts = sw.skipped.map(function (x) { return (x.id >= 0 ? '聲音' + x.id : '串流') + '：' + x.reason; });
      if (!outs.length) throw new Error('SWF 內沒有可擷取的音訊' + (skippedParts.length ? '（' + skippedParts.join('；') + '）' : ''));
    } else if (rec.kind === 'nes') {
      // NES：用 jsnes 真的執行 ROM，同時錄 APU 寫入（退路 MIDI）、錄 APU 音訊（wav／mp3），能找到入口就產生 NSF
      emit('執行 ROM（jsnes）');
      if (typeof FaJsnes === 'undefined' || typeof FaMusicLibNes === 'undefined' || typeof FaMusicLibNesMappers === 'undefined') throw new Error('NES 模組沒有嵌入（FaJsnes／FaMusicLibNes 不存在）');
      var nr;
      try {
        if (FaMusicLibNesMappers && FaMusicLibNesMappers.install) FaMusicLibNesMappers.install(FaJsnes.NES);
        nr = await FaMusicLibNes.extractNsf(u8, FaJsnes.NES, {
          name: stem, isCancelled: cancelled,
          onProgress: function (fr) { if (fr % 900 === 0) emit('執行 ROM（第 ' + fr + ' 個畫面）'); }
        });
      } catch (e) { throw new Error('NES 執行失敗（執行階段）：' + String((e && e.message) || e)); }
      if (nr.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
      var modeLabel = nr.mode === 'nsf+midi' ? '有 NSF，並有退路 MIDI' : nr.mode === 'nsf' ? '有 NSF' : nr.mode === 'midi' ? '只有退路 MIDI' : '兩者都沒有';
      method = 'NES（jsnes 執行 ROM，' + modeLabel + '）' + (nr.nsfNote ? '；' + nr.nsfNote : '');
      if (nr.nsf) outs.push({ kind: 'nsf', name: stem + '.nsf', bytes: nr.nsf, method: method, durationSec: null, title: stem + ' NSF' });
      if (nr.song) {
        var nsong = FaMidi.validate(nr.song);
        outs.push({ kind: 'mid', name: stem + '_APU.mid', bytes: FaMidi.write(nsong), method: method + '；APU 暫存器→MIDI（退路）', durationSec: nr.stats.durationSec, title: stem + ' MIDI' });
      }
      if (nr.wav && nr.samples && nr.samples.length) {
        emit('編碼 mp3');
        outs.push({ kind: 'wav', name: stem + '_APU.wav', bytes: nr.wav, method: method + '；APU 音訊', durationSec: nr.stats.durationSec, title: stem + ' APU' });
        var abuf = new AudioBuffer({ length: nr.samples.length, sampleRate: nr.sampleRate, numberOfChannels: 1 });
        abuf.copyToChannel(nr.samples, 0);
        var nmp3 = await fa._encodeMp3(abuf, 160);
        outs.push({ kind: 'mp3', name: stem + '_APU.mp3', bytes: new Uint8Array(await nmp3.arrayBuffer()), method: method + '；APU 音訊', durationSec: nr.stats.durationSec, title: stem + ' APU' });
      }
      skippedParts = [];
      if (!nr.nsf) skippedParts.push('NSF 沒有產生［' + (nr.nsfStage || '?') + '］' + (nr.nsfReason || ''));
      if (!nr.song) skippedParts.push('退路 MIDI 沒有：' + (nr.midiReason || ''));
      if (!outs.length) throw new Error('NES 擷取失敗：' + skippedParts.join('；'));
    } else if (rec.kind === 'pce') {
      // PC Engine：自寫 HuC6280 執行 ROM，錄 PSG 寫入；退路 MIDI，並用 PSG 重播成 wav（再編 mp3）
      emit('執行 ROM（HuC6280）');
      if (typeof FaMusicLibPce === 'undefined' || typeof FaMusicLibPceCpu === 'undefined') throw new Error('PCE 模組沒有嵌入（FaMusicLibPce／FaMusicLibPceCpu 不存在）');
      var pr;
      try {
        pr = await FaMusicLibPce.extractPce(u8, {
          name: stem, cpu: FaMusicLibPceCpu, isCancelled: cancelled,
          onProgress: function (fr) { if (fr % 900 === 0) emit('執行 ROM（第 ' + fr + ' 個畫面）'); }
        });
      } catch (e) { throw new Error('PCE 執行失敗（執行階段）：' + String((e && e.message) || e)); }
      if (pr.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
      method = 'PC Engine（HuC6280 執行 ROM，自寫六聲道 PSG 重播）' + (pr.stats && pr.stats.note ? '；' + pr.stats.note : '');
      if (pr.song) {
        var psong = FaMidi.validate(pr.song);
        outs.push({ kind: 'mid', name: stem + '_PSG.mid', bytes: FaMidi.write(psong), method: method + '；PSG 寫入→MIDI', durationSec: pr.stats.seconds, title: stem + ' MIDI' });
      }
      if (pr.wav && pr.samples && pr.samples.length) {
        outs.push({ kind: 'wav', name: stem + '_PSG.wav', bytes: pr.wav, method: method + '；PSG 重播', durationSec: pr.stats.durationSec, title: stem + ' PSG' });
        emit('編碼 mp3');
        var pbuf = new AudioBuffer({ length: pr.samples.length, sampleRate: pr.sampleRate, numberOfChannels: 1 });
        pbuf.copyToChannel(pr.samples, 0);
        var pmp3 = await fa._encodeMp3(pbuf, 160);
        outs.push({ kind: 'mp3', name: stem + '_PSG.mp3', bytes: new Uint8Array(await pmp3.arrayBuffer()), method: method + '；PSG 重播', durationSec: pr.stats.durationSec, title: stem + ' PSG' });
      }
      skippedParts = [];
      if (!pr.song) skippedParts.push('退路 MIDI 沒有：' + (pr.midiReason || pr.reason || ''));
      if (!pr.wav) skippedParts.push('wav 沒有：' + (pr.wavReason || pr.reason || ''));
      if (!outs.length) throw new Error('PCE 擷取失敗：' + skippedParts.join('；'));
    } else if (rec.kind === 'sfc') {
      // SFC：自寫 65816 跑 ROM → 聲音埠接 SPC700＋S-DSP 核心 → 每個時間點傾印 .spc → 同一個核心渲成 wav → 編 mp3
      emit('執行 ROM（超任主 CPU）');
      if (typeof FaMusicLibSfc === 'undefined' || typeof FaMusicLibSnesBus === 'undefined' || typeof FaMusicLibSnesCpu === 'undefined') {
        throw new Error('SFC 模組沒有嵌入（FaMusicLibSfc／FaMusicLibSnesBus／FaMusicLibSnesCpu 其中之一不存在）');
      }
      if (typeof FaMusicLibSpcCore === 'undefined') {
        throw new Error('SFC 擷取失敗：SPC700＋S-DSP 核心（FaMusicLibSpcCore）沒有嵌入，無法執行聲音程式，也無法渲染 .spc');
      }
      var sfcRes = FaMusicLibSfc.sfcExtract(u8, {
        title: stem, game: stem,
        runner: function (rom) {
          return FaMusicLibSnesBus.runRom(rom, {
            Cpu: FaMusicLibSnesCpu, apu: FaMusicLibSnesBus.createSpcApu(FaMusicLibSpcCore.createCore({})),
            maxFrames: 3600, isCancelled: cancelled,
            onProgress: function (f) { if (f % 300 === 0) emit('執行 ROM（第 ' + f + ' 個畫面）'); }
          });
        },
        renderSpc: function (spcBytes) {
          var core = FaMusicLibSpcCore.fromSpc(FaMusicLibSfc.parseSpc(spcBytes));
          var n = 32000 * 60, L = new Float32Array(n), R = new Float32Array(n);
          core.renderStereo(L, R, 0, n);
          return { L: L, R: R, sampleRate: 32000, durationSec: 60 };
        }
      });
      if (sfcRes.cancelled) throw Object.assign(new Error('已取消'), { cancelled: true });
      skippedParts = sfcRes.stages.filter(function (s) { return !s.ok; }).map(function (s) { return s.stage + '：' + s.reason; });
      if (!sfcRes.ok) throw new Error('SFC 擷取失敗：' + (skippedParts.join('；') || sfcRes.reason || '未知'));
      method = '超任（自寫 65816 執行 ROM，SPC700＋S-DSP 核心渲染）';
      for (var ri = 0; ri < (sfcRes.rendered || []).length; ri++) {
        var rd = sfcRes.rendered[ri], sname = stem + '_' + (rd.index + 1), o = rd.out;
        outs.push({ kind: 'spc', name: sname + '.spc', bytes: rd.bytes, method: method + '；傾印自第 ' + rd.frame + ' 個畫面', durationSec: null, title: sname });
        var mono = new Float32Array(o.L.length);
        for (var si = 0; si < mono.length; si++) mono[si] = (o.L[si] + o.R[si]) / 2;
        emit('編碼 mp3');
        var sbuf = new AudioBuffer({ length: mono.length, sampleRate: o.sampleRate, numberOfChannels: 1 });
        sbuf.copyToChannel(mono, 0);
        var smp3 = await fa._encodeMp3(sbuf, 160);
        outs.push({ kind: 'mp3', name: sname + '.mp3', bytes: new Uint8Array(await smp3.arrayBuffer()), method: method + '；SPC700 渲染', durationSec: o.durationSec, title: sname });
      }
      skippedParts = skippedParts.concat(sfcRes.rendered && sfcRes.rendered.length ? [] : ['沒有任何時間點渲染成功']);
      if (!outs.length) throw new Error('SFC 擷取失敗：' + skippedParts.join('；'));
    } else {
      throw new Error('這個種類不支援擷取：' + rec.kind);
    }
    // 寫檔 → 子曲目記錄（record 與普通檔案同形，只多 derivedFrom／derivedSig）
    var recs = [];
    for (var i = 0; i < outs.length; i++) {
      if (cancelled()) throw Object.assign(new Error('已取消'), { cancelled: true });
      emit('寫檔 ' + (i + 1) + '/' + outs.length);
      var w = await writeDerivedFile(dir, outs[i].name, outs[i].bytes);
      var c = FaMusicLib.buildDerivedRecord(rec, { index: i, kind: outs[i].kind, path: w.path, sizeBytes: w.sizeBytes, method: outs[i].method, durationSec: outs[i].durationSec, title: outs[i].title }, now);
      c.derivedSig = sig;
      recs.push(c);
    }
    FaMusicLib.replaceDerived(L, rec.key, recs);
    await L.save();
    return { skipped: false, children: recs.map(function (x) { return x.key; }), skippedParts: skippedParts, method: method, dir: dir };
  }
  // 批次擷取（勾選的 rix／swf／nes，沒勾就全部）：單一來源失敗不影響其他來源；結果逐筆回傳
  async function extractSources(recs, opts) {
    opts = opts || {};
    extractCancelled = false;
    var results = [];
    for (var i = 0; i < recs.length; i++) {
      var rec = recs[i], t0 = Date.now();
      // 每做完一個就通知一次（含序號與總數），畫面才能逐筆更新，不用等全部做完
      var emitDone = function () { if (opts.onEvent) { try { opts.onEvent({ type: 'result', index: i, total: recs.length, result: results[results.length - 1] }); } catch (_) { /* 畫面出錯不影響擷取 */ } } };
      if (extractCancelled) { results.push({ name: rec.name, status: 'cancelled', reason: '', stage: null, elapsedMs: 0 }); emitDone(); continue; }
      var stage = null;
      try {
        var out = await extractGameSource(rec, Object.assign({}, opts, { onStage: function (s) { stage = s; if (opts.onEvent) opts.onEvent({ key: rec.key, stage: s, index: i, total: recs.length, name: rec.name }); } }));
        results.push({ name: rec.name, kind: rec.kind, status: out.skipped ? 'skipped' : 'done', reason: out.reason || '', stage: stage, children: out.children.length, skippedParts: out.skippedParts, method: out.method, dir: out.dir, elapsedMs: Date.now() - t0 });
      } catch (e) {
        var cancelledNow = !!(e && e.cancelled) || extractCancelled;
        results.push({ name: rec.name, kind: rec.kind, status: cancelledNow ? 'cancelled' : 'failed', reason: String((e && e.message) || e), stage: stage, children: 0, elapsedMs: Date.now() - t0 });
      }
      emitDone();
    }
    var summary = { done: 0, skipped: 0, failed: 0, cancelled: 0 };
    results.forEach(function (x) { summary[x.status] = (summary[x.status] || 0) + 1; });
    return { results: results, summary: summary };
  }

  // ───── 通用播放與曲庫移除的 app 端（給 musiclib_play.js 的 host 介面，與面板的移除流程）─────
  var MIME_BY_EXT = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', flac: 'audio/flac', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg',
    mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska' };
  var DERIVED_SEP_RE = new RegExp('[\\\\/]' + DERIVED_DIR_NAME + '[\\\\/]');
  function userDerivedRoot() { try { return String(localStorage.getItem('fa.musiclib.derivedDir') || '').trim(); } catch (_) { return ''; } }
  // 認可刪除的衍生檔：在「音樂庫衍生檔」資料夾裡，或在使用者指定的衍生資料夾底下。原始檔永遠不認可。
  function isDerivedPath(p) {
    p = String(p || '');
    if (!p) return false;
    if (DERIVED_SEP_RE.test(p)) return true;
    var root = userDerivedRoot();
    if (!root) return false;
    var sep = root.indexOf('\\') >= 0 ? '\\' : '/';
    return p.indexOf(root.replace(/[\\\/]+$/, '') + sep) === 0;
  }
  function readHeadBytes(p, n) { return api().rawfs.readHead(p, n).then(function (r) { return r && r.base64 != null ? b64ToBytes(r.base64) : null; }); }
  // 讀位元組：選檔拿到的 File，或桌面版的實體路徑
  async function readBytesOf(rec) {
    if (rec.file) return new Uint8Array(await rec.file.arrayBuffer());
    var a = api(); if (!a || !a.rawfs || !a.rawfs.readFile) throw new Error('讀取檔案的通道不存在（需要桌面版）');
    var r = await a.rawfs.readFile(absPath(rec.path), 'base64');
    if (!r || r.base64 == null) throw new Error('讀不到這個檔案的內容（' + rec.path + '）');
    return b64ToBytes(r.base64);
  }
  // 來源檔要擷取、或要登記時，需要曲庫裡的紀錄（有 key、sourceId）；不在曲庫的實體檔就登記成一個來源（/media-play 的 ROM 會走到這裡）
  async function ensureLibRecord(rec) {
    if (!rec || rec.file || !rec.path) return rec;
    var L = getLib(); await L.ready;
    if (rec.key) { var hit = L.records.filter(function (r) { return r.key === rec.key; })[0]; if (hit) return hit; }
    var same = L.records.filter(function (r) { return r.path === rec.path && !r.derivedFrom; })[0];
    if (same) return same;
    var a = api(); if (!a || !a.rawfs || !a.rawfs.stat) throw new Error('需要桌面版才能把檔案登記進曲庫');
    var st = await a.rawfs.stat(rec.path);
    if (!st || !st.isFile) throw new Error('這不是一個檔案：' + rec.path);
    var sid = L.addSource('file', rec.name || basename(rec.path));
    await L.scan(sid, [{ path: rec.path, size: st.size || 0, mtimeMs: st.mtimeMs || 0 }], readHeadBytes);
    await L.save();
    return L.records.filter(function (r) { return r.path === rec.path && !r.derivedFrom; })[0] || rec;
  }
  function basename(p) { return String(p || '').split(/[\\\/]/).pop(); }
  var nsfWired = false;
  // 晶片後端：nsf 的後端要先接上（與 openNsf 同一寫法），之後 createPlayer 才找得到
  function ensureChipBackends() {
    if (typeof FaChipPlayer === 'undefined' || nsfWired) return;
    // 每種晶片後端各自接上（缺哪個就略過哪個，不能因為缺 nsf 而讓 spc 也接不上）
    if (typeof FaChipNsf !== 'undefined' && typeof FaJsnes !== 'undefined') {
      try { FaChipPlayer.getBackend('nsf'); } catch (_) { FaChipPlayer.registerBackend(FaChipNsf.createBackend(FaJsnes.NES)); }
    }
    if (typeof FaChipSpc !== 'undefined') {
      try { FaChipPlayer.getBackend('spc'); } catch (_) { FaChipPlayer.registerBackend(FaChipSpc.createBackend()); }
    }
    nsfWired = true;
  }
  function chipKinds() { ensureChipBackends(); return typeof FaChipPlayer === 'undefined' ? [] : FaChipPlayer.listBackends().map(function (b) { return b.kind; }); }
  var PLAY_HOST = {
    records: function () { return getLib().records; },
    chipKinds: chipKinds,
    resolve: ensureLibRecord,
    // 來源 ROM 擷取：沒有實體路徑（選檔拿到的）就說明原因；有路徑就登記後擷取（與面板的擷取同一條路）
    extract: function (rec) {
      if (rec.file || !rec.path) return Promise.resolve({ results: [{ name: rec.name, status: 'failed', stage: null, reason: '這個檔案是用選檔拿到的（沒有實體路徑），擷取需要完整路徑；請用 /media-play 輸入完整路徑' }] });
      return ensureLibRecord(rec).then(function (lr) { return extractSources([lr], { userRoot: userDerivedRoot() || null }); });
    },
    mountMidi: async function (rec) {
      if (typeof FaMidi === 'undefined' || typeof FaMidiUI === 'undefined') throw new Error('MIDI 播放器不存在（需要桌面版）');
      var song = FaMidi.parse(await readBytesOf(rec));
      var fa = window.fa; if (!fa || !fa._midiHost) throw new Error('MIDI 播放器不存在（需要桌面版）');
      return FaMidiUI.mount({ song: song, title: rec.name, host: fa._midiHost(), M: FaMidi });
    },
    mountChip: async function (rec) {
      var bytes = await readBytesOf(rec);
      ensureChipBackends();
      if (typeof FaChipPlayer === 'undefined' || typeof FaChipPlayerUI === 'undefined') throw new Error('晶片播放器還沒有內嵌（缺 FaChipPlayer／FaChipPlayerUI）');
      var player = FaChipPlayer.createPlayer(rec.kind, bytes, { sampleRate: 44100 });
      return FaChipPlayerUI.mount({ player: player, title: rec.name, host: CHIP_HOST });
    },
    mediaUrl: async function (rec) {
      var bytes = await readBytesOf(rec);
      var k = String(rec.kind || String(rec.name || '').split('.').pop() || '').toLowerCase();
      var mime = MIME_BY_EXT[k] || '';
      return URL.createObjectURL(new Blob([bytes], mime ? { type: mime } : undefined));
    }
  };
  // ───── md5 指紋：背景逐個算（一次一個，小檔先算），算完才做搬家對應（planRelocation／applyRelocation）。
  // 算法：1) 桌面版主行程 knowledge.call('hashFile')：任意大小串流計算，hashKind='md5-full'。
  //       2) 舊版 app 不認得 hashFile（回傳不認得的操作）：≤ 64 MB 用 rawfs.readFile 整檔算，hashKind='md5-full'；
  //          更大的用開頭 4 MB＋大小，hashKind='md5-head4M+size'（近似特徵，畫面上會明講；app 更新後會自動重算成整檔）。
  var MD5_FALLBACK_MAX = 64 * 1024 * 1024, MD5_HEAD_BYTES = 4 * 1024 * 1024;
  var md5State = { running: false, cancelled: false, done: 0, total: 0, current: '', big: false, startedAt: 0, fallback: false, lastMsg: '' };
  function md5Lib() { return typeof FaMd5 !== 'undefined' ? FaMd5 : null; }
  async function md5OfPath(rec) {
    var a = api(), abs = absPath(rec.path);
    if (!a || !a.rawfs) throw new Error('算 md5 需要桌面版（讀檔通道不存在）');
    if (!md5State.fallback && a.knowledge && a.knowledge.call) {
      var r = await a.knowledge.call('hashFile', { path: abs, algo: 'md5' });
      if (r && r.ok) return { hex: r.hex, kind: FaMusicLib.HASH_FULL };
      if (!(r && /不認得的操作/.test(r.error || ''))) throw new Error((r && r.error) || '讀不到檔案');
      md5State.fallback = true;   // 舊版 app：之後都走退路
    }
    var st = await a.rawfs.stat(abs);
    var size = st && st.size != null ? st.size : (rec.sizeBytes || 0);
    if (!md5Lib()) throw new Error('md5 模組沒有載入');
    if (size <= MD5_FALLBACK_MAX) {
      var f = await a.rawfs.readFile(abs, 'base64');
      if (!f || f.base64 == null) throw new Error('讀檔失敗：讀不到這個檔案的內容');
      return { hex: md5Lib().md5Hex(b64ToBytes(f.base64)), kind: FaMusicLib.HASH_FULL };
    }
    var head = await a.rawfs.readHead(abs, MD5_HEAD_BYTES);
    if (!head || head.base64 == null) throw new Error('讀檔失敗：讀不到這個檔案的開頭');
    var hh = md5Lib().md5Create().update(b64ToBytes(head.base64)).update('size=' + size).hex();
    return { hex: hh, kind: FaMusicLib.HASH_HEAD };
  }
  var MD5_HOST = {
    // 算 md5 並對應：opts.newKeys＝這一次掃到的新紀錄（只有它們能被配成搬家後的位置）；onEvent({phase, done, total, name, big, startedAt})
    run: async function (opts) {
      opts = opts || {};
      var L = getLib(); await L.ready;
      if (md5State.running) throw new Error('md5 已在計算中');
      md5State.running = true; md5State.cancelled = false; md5State.fallback = md5State.fallback && !opts.retryHashFile;
      var emit = opts.onEvent || function () {};
      var todo = L.records.filter(FaMusicLib.needsHash).sort(function (x, y) { return (x.sizeBytes || 0) - (y.sizeBytes || 0); });
      md5State.total = todo.length; md5State.done = 0; var saves = 0, failures = [];
      try {
        for (var i = 0; i < todo.length && !md5State.cancelled; i++) {
          var rec = todo[i];
          md5State.current = rec.name; md5State.big = (rec.sizeBytes || 0) > MD5_FALLBACK_MAX; md5State.startedAt = Date.now();
          emit({ phase: 'hash', done: i, total: todo.length, name: rec.name, big: md5State.big, startedAt: md5State.startedAt });
          try { var h = await md5OfPath(rec); FaMusicLib.setHash(rec, { hex: h.hex, kind: h.kind }); }
          catch (e) { rec.hashError = String((e && e.message) || e); failures.push({ name: rec.name, reason: rec.hashError }); }
          md5State.done = i + 1;
          if (++saves % 20 === 0) await L.save();
        }
        await L.save();
        var summary = { hashed: md5State.done, total: todo.length, failures: failures, cancelled: md5State.cancelled, text: '' };
        if (!md5State.cancelled && Object.keys(opts.newKeys || {}).length) {
          var plan = FaMusicLib.planRelocation(L, { newKeys: opts.newKeys || {} });
          var applied = FaMusicLib.applyRelocation(L, plan);
          await L.save();
          summary.plan = plan; summary.applied = applied;
          summary.text = FaMusicLib.describeRelocation(plan, applied);
          if (failures.length) summary.text += ' md5 算失敗 ' + failures.length + ' 個（' + failures.slice(0, 3).map(function (x) { return x.name + '：' + x.reason; }).join('；') + '）。';
        } else if (md5State.cancelled) summary.text = 'md5 已取消（算到 ' + md5State.done + '／' + todo.length + '）；已算好的會保留，沒有做對應。';
        else summary.text = todo.length ? '已算好 ' + todo.length + ' 個檔案的 md5。' : '';
        return summary;
      } finally { md5State.running = false; md5State.current = ''; md5State.big = false; }
    },
    cancel: function () { md5State.cancelled = true; },
    // 目前狀態（給主畫面一行）：算了多少、還有多少沒算（決定什麼時候可以安全重整資料夾）
    state: function () {
      var L = getLib(), pending = L.records.filter(FaMusicLib.needsHash).length;
      return { running: md5State.running, done: md5State.done, total: md5State.total, current: md5State.current, big: md5State.big, startedAt: md5State.startedAt, pending: pending, fallback: md5State.fallback };
    },
    // 重新對應前先看一次現況：每筆紀錄的檔案還在不在（不在就標為消失，資料保留）；回傳 { missing, back }
    refreshStatus: async function () {
      var L = getLib(); await L.ready;
      var paths = L.records.map(function (r) { return r.path; });
      var m = await LIB_HOST.statMany(paths), missing = 0, back = 0;
      L.records.forEach(function (r) {
        var st = m[r.path];
        if (!st && r.status === 'ok' && !r.pending) { r.status = 'missing'; missing++; }
        else if (st && r.status === 'missing') { r.status = 'ok'; r.sizeBytes = st.size; r.mtimeMs = st.mtimeMs; back++; }
      });
      await L.save();
      return { missing: missing, back: back };
    }
  };

  // 移除實體檔：只刪衍生資料夾裡的檔案（isDerivedPath 把關），刪完再 stat 確認真的消失
  var LIB_HOST = {
    isDerivedPath: isDerivedPath,
    // 匯入用：一次查一批路徑的現況（{size, mtimeMs} 或 null＝不存在），給 planImport 判斷 sig 與是否消失
    statMany: async function (paths) {
      var a = api(), out = {};
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        if (!a || !a.rawfs || !a.rawfs.stat) { out[p] = null; continue; }
        try { var st = await a.rawfs.stat(absPath(p)); out[p] = st && st.isFile !== false ? { size: st.size, mtimeMs: st.mtimeMs } : null; }
        catch (_) { out[p] = null; }
      }
      return out;
    },
    // 匯出：讓使用者選資料夾（desktopAPI.roots.browse），檔案寫進去（rawfs.writeFile）；取消回傳 null
    exportToFolder: async function (text, fileName) {
      var a = api(); if (!a || !a.roots || !a.roots.browse || !a.rawfs || !a.rawfs.writeFile) throw new Error('匯出的通道不存在（需要桌面版）');
      var dir = await a.roots.browse();
      if (!dir) return null;
      var full = joinPath(dir, fileName);
      await a.rawfs.writeFile(full, { base64: bytesToB64(new TextEncoder().encode(text)) });
      return { path: full };
    },
    removeFiles: async function (paths) {
      var a = api(); if (!a || !a.rawfs || !a.rawfs.remove) throw new Error('刪除檔案的通道不存在（需要桌面版）');
      var out = [];
      for (var i = 0; i < paths.length; i++) {
        var p = paths[i];
        if (!isDerivedPath(p)) { out.push({ path: p, ok: false, reason: '路徑不在衍生資料夾內，拒絕刪除' }); continue; }
        try { await a.rawfs.remove(p, false); } catch (e) { out.push({ path: p, ok: false, reason: '刪除失敗：' + String((e && e.message) || e) }); continue; }
        var gone = false;
        try { await a.rawfs.stat(p); } catch (_) { gone = true; }
        out.push(gone ? { path: p, ok: true } : { path: p, ok: false, reason: '刪除後檔案仍然存在' });
      }
      return out;
    }
  };

  var PICK_HOST = { pickFolder: pickFolder, pickFiles: pickFiles, melody: MELODY_HOST, md5: MD5_HOST, extract: { run: extractSources, cancel: function () { extractCancelled = true; } }, openNsf: openNsf, play: PLAY_HOST, library: LIB_HOST,
    startYoutubeList: function (text, onUpdate) { return startYoutubeList(text, onUpdate); }, youtubeControl: function (a) { return youtubeControl(a); }, youtubeJob: function () { return youtubeJob(); } };

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
    // /media-play：任何音樂或影片檔，不用進音樂庫。每個檔案一張播放卡片（```fa-mediaplay 區塊，見 _mpMount）
    _mpExt(name) { var m = /\.([^.\\\/]+)$/.exec(String(name || '')); return m ? m[1].toLowerCase() : ''; },
    _mpOpen(argsText) {
      var paths = (typeof FaMediaPlay !== 'undefined') ? FaMediaPlay.parseArgs(argsText).filter(Boolean) : [];
      if (!paths.length) { this._mpPickFiles(); return; }
      var self = this;
      paths.forEach(function (p) { self._mpPushItem({ path: p, name: p.split(/[\\\/]/).pop(), kind: self._mpExt(p) }); });
    },
    // 沒給路徑：開檔案選擇器（renderer 的 <input type=file>，拿到的是 File，不是實體路徑）
    _mpPickFiles() {
      var self = this;
      // 桌面版：用帶完整路徑的選檔（來源 ROM 才能擷取、重新整理後也能繼續播）；不是桌面版（undefined）才用瀏覽器選檔
      if (hasDesktopFs()) {
        pickFiles().then(function (src) { if (src) src.entries.forEach(function (e) { self._mpPushItem({ path: e.path, name: basename(e.path), kind: self._mpExt(e.path) }); }); });
        return;
      }
      var inp = document.createElement('input');
      inp.type = 'file'; inp.multiple = true;
      inp.onchange = function () {
        Array.prototype.slice.call(inp.files || []).forEach(function (f) { self._mpPushItem({ file: f, name: f.name, kind: self._mpExt(f.name) }); });
      };
      inp.click();
    },
    _mpPushItem(item) {
      this._mpItems = this._mpItems || new Map();
      var id = 'mp' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      this._mpItems.set(id, item);
      var ref = { id: id, name: item.name, kind: item.kind, path: item.path || null };
      this._pushAssistantMessage('🎵 播放：' + item.name + '\n\n```fa-mediaplay\n' + JSON.stringify(ref) + '\n```', null);
      try { this._persistChatHistory(); this._renderMessageHistory(); } catch (_) { /* 顯示失敗不影響資料 */ }
    },
    // 把 ```fa-mediaplay 區塊換成通用播放卡片（每次對話重新渲染時都會掛一次）
    _mpMount(mdDiv) {
      if (typeof FaMediaPlay === 'undefined' || typeof PLAY_HOST === 'undefined') return;
      var self = this;
      mdDiv.querySelectorAll('pre > code.language-fa-mediaplay').forEach(function (code) {
        var ref = null; try { ref = JSON.parse(code.textContent); } catch (_) { /* */ }
        var holder = code.parentElement;
        var item = ref && self._mpItems && self._mpItems.get(ref.id);
        if (!item && ref && ref.path) item = { path: ref.path, name: ref.name, kind: ref.kind };
        if (!item) {
          var w = document.createElement('div'); w.style.cssText = 'padding:8px;opacity:.8;font-size:12px';
          w.textContent = '⚠️ 這張播放卡片是用選檔拿到的，重新整理後檔案要重選（請用 /media-play 加完整路徑，就能一直播）。';
          holder.replaceWith(w); return;
        }
        var rec = { key: null, name: item.name, kind: item.kind, path: item.path || null, file: item.file || null, status: 'ok', pending: false, derivedFrom: null };
        holder.replaceWith(FaMediaPlay.mount(rec, PLAY_HOST));
      });
    },
    _registerMediaPlayCommand() {
      var self = this;
      this.register_slash_command('/media-play', '[檔案路徑…]', '播放任何音樂或影片檔（不用進音樂庫）。可以一次列出多個路徑（路徑有空白就加引號）；不給路徑就開檔案選擇器。', async function (argsText, run) {
        (run || self)._mpOpen(argsText);
      });
    },
    _registerMusicLibCommand() {
      var self = this;
      this.register_slash_command('/musiclib', '', '音樂庫：加檔案或資料夾、掃描、用檔名／專輯／標題／演出者／歌詞搜尋；資料存在本機，重新開啟還在。', async function (argsText, run) {
        (run || self)._mlOpen();
      });
    }
  };

  // NSF 晶片播放（曲庫的 NSF 子曲目）：讀檔 → 晶片播放核心建立 nsf 播放器 → 掛上共用卡片。
  // 需要 FaChipPlayer（核心）、FaChipNsf（後端）、FaChipPlayerUI（卡片）都已內嵌；缺一就丟錯，面板會顯示原因。
  var CHIP_HOST = {
    encodeMp3: function (view, kbps) { var fa = window.fa; if (!fa || !fa._encodeMp3) throw new Error('mp3 編碼不可用'); return fa._encodeMp3(view, kbps); },
    download: function (name, bytes, mime) {
      var u = URL.createObjectURL(new Blob([bytes], { type: mime })), A = document.createElement('a');
      A.href = u; A.download = name; document.body.appendChild(A); A.click(); A.remove();
      setTimeout(function () { URL.revokeObjectURL(u); }, 2000);
    },
    midiBytes: function (song) { return FaMidi.write(FaMidi.validate(song)); }
  };
  async function openNsf(rec) {
    var a = api();
    if (!a || !a.rawfs || !a.rawfs.readFile) throw new Error('讀取檔案的通道不存在（需要桌面版）');
    if (typeof FaChipPlayer === 'undefined' || typeof FaChipNsf === 'undefined' || typeof FaChipPlayerUI === 'undefined') throw new Error('晶片播放器還沒有內嵌（缺 FaChipPlayer／FaChipNsf／FaChipPlayerUI）');
    try { FaChipPlayer.getBackend('nsf'); } catch (_) { FaChipPlayer.registerBackend(FaChipNsf.createBackend(FaJsnes.NES)); }
    var r = await a.rawfs.readFile(absPath(rec.path), 'base64');
    if (!r || r.base64 == null) throw new Error('讀檔失敗：讀不到這個 NSF 的內容');
    var player = FaChipPlayer.createPlayer('nsf', b64ToBytes(r.base64), { sampleRate: 44100 });
    return FaChipPlayerUI.mount({ player: player, title: rec.name, host: CHIP_HOST });
  }


  // ───── YouTube 清單：展開 → 逐支「既有範圍驗證 → 下載 → 寫進資料夾 → 登記」（純邏輯在 musiclib_youtube.js）─────
  // 驗證與下載都直接呼叫 app 既有的 _youtubeCheckLicenseAndOwnership、_youtubeDownloadOne（同一套範圍限制，不另外放寬）。
  // 只能在桌面版做（寫檔＋曲庫登記都要磁碟路徑）。同一時間只跑一個清單；暫停、續跑、取消由 youtubeControl 控制。
  var ytJob = null, ytOnUpdate = null, ytBusy = false, ytCancelRequested = false;
  function ytNotify() { if (ytOnUpdate && ytJob) { try { ytOnUpdate(ytJob, FaMusicLibYoutube.summarize(ytJob)); } catch (_) { /* 畫面出錯不影響工作 */ } } }
  // 設定：下載後自動建旋律索引（localStorage fa.musiclib.ytAutoIndex，沒設過就是開）；手動索引的 Basic Pitch 勾選同一個鍵（fa.musiclib.melodyBasicPitch）
  function ytAutoIndexOn() { try { var v = localStorage.getItem('fa.musiclib.ytAutoIndex'); return v == null ? true : v === '1'; } catch (_) { return true; } }
  function melodyUseBasicPitch() { try { return localStorage.getItem('fa.musiclib.melodyBasicPitch') === '1'; } catch (_) { return false; } }
  function ytBridge() {
    var fa = (typeof window !== 'undefined' && window.fa) || null;
    if (!fa || !fa._youtubeCheckLicenseAndOwnership || !fa._youtubeDownloadOne || !fa._ensureYtDlpLoaded) throw new Error('YouTube 功能還沒準備好（範圍驗證或 yt-dlp 不可用）');
    return fa;
  }
  function ytErr(stage, err) { var e = new Error(String((err && err.message) || err || '未知錯誤')); e.stage = stage; if (err && err.status) e.status = err.status; return e; }

  // 展開清單：用 app 既有的 yt-dlp（Pyodide）列出影片，不下載
  async function ytExpand(listId) {
    var fa = ytBridge(), instance;
    try { instance = await fa._ensureYtDlpLoaded(); } catch (e) { throw ytErr('展開', e); }
    var raw;
    try { raw = await instance.runPythonAsync(FaMusicLibYoutube.buildFlatPlaylistScript(listId)); } catch (e) { throw ytErr('展開', e); }
    try { return FaMusicLibYoutube.parseFlatPlaylist(String(raw)); } catch (e) { throw ytErr('展開', e); }
  }

  // 開始一個 YouTube 清單（或單支影片）。回傳 { ok, summary, error }；onUpdate(job, summary) 在每次狀態改變時呼叫。
  async function startYoutubeList(text, onUpdate) {
    if (ytBusy) return { ok: false, error: '已有一個 YouTube 清單在進行中，等它完成或先取消' };
    var parsed = FaMusicLibYoutube.parseInput(text);
    if (parsed.error) return { ok: false, error: parsed.error };
    if (!hasDesktopFs()) return { ok: false, error: 'YouTube 清單只能在桌面版使用（影片要寫進你選的資料夾，曲庫才能登記）' };
    ytBusy = true; ytCancelRequested = false; ytJob = null;
    var indexing = [];   // 每支登記後排進旋律索引的 Promise；全部跑完才結束（索引失敗只記在該支上）
    try {
      var folder = await api().roots.browse();
      if (!folder) return { ok: false, cancelled: true, error: '已取消（沒有選下載資料夾）' };
      ytOnUpdate = typeof onUpdate === 'function' ? onUpdate : null;
      var L = getLib();
      await L.ready;
      var entries, listTitle = null;
      if (parsed.mode === 'playlist') {
        var pl = await ytExpand(parsed.listId);
        entries = pl.entries; listTitle = pl.title;
      } else {
        entries = [{ videoId: parsed.videoId, title: null }];
      }
      if (ytCancelRequested) return { ok: false, cancelled: true, error: '已取消（清單還沒開始下載）' };
      var label = listTitle || (parsed.mode === 'video' ? parsed.videoId : parsed.listId);
      var autoIndex = ytAutoIndexOn(), useModel = melodyUseBasicPitch();
      ytJob = FaMusicLibYoutube.createJob({ mode: parsed.mode, listId: parsed.listId || null, videoId: parsed.videoId || null, title: label, entries: entries, autoIndex: autoIndex });
      FaMusicLibYoutube.markDuplicates(ytJob, FaMusicLibYoutube.existingIdsFrom(L.records));
      var sid = L.addSource('youtube', 'YT清單：' + label);
      ytNotify();
      var fa = ytBridge();
      var keyItem = {};   // 旋律索引的記錄 key → 那一支影片的項目（索引事件回來時對應）
      var deps = {
        verify: async function (id) {
          var checks = await fa._youtubeCheckLicenseAndOwnership([id]);
          return checks[id] || { ok: false, reason: '跳過：驗證沒有回傳結果' };
        },
        download: async function (id, report) {
          var rep = function (frac, text) { report(frac, text); return Promise.resolve(); };
          return await fa._youtubeDownloadOne(id, false, rep);
        },
        store: async function (item, title, files) {
          if (!files || !files.length) throw ytErr('下載', new Error('下載沒有回傳任何檔案'));
          var multi = files.length > 1, written = [], writtenPaths = {};
          for (var i = 0; i < files.length; i++) {
            var f = files[i], name = FaMusicLibYoutube.fileNameFor(title, item.videoId, f.kind, f.ext, multi);
            try { var w = await writeDerivedFile(folder, name, f.bytes); } catch (e) { throw ytErr('寫入', e); }
            written.push({ path: w.path, size: w.sizeBytes, mtimeMs: Date.now() });
            writtenPaths[w.path] = true;
          }
          // 登記：同一來源目前的檔案＋剛寫的一起交給 lib.scan（沒變的沿用，不重讀）
          try {
            var known = L.records.filter(function (r) { return r.sourceId === sid && r.status === 'ok'; })
              .map(function (r) { return { path: r.path, size: r.sizeBytes, mtimeMs: r.mtimeMs }; });
            await L.scan(sid, known.concat(written), ytReadHead);
            await L.save();
          } catch (e) { throw ytErr('登記', e); }
          item.path = written[0].path;
          // 剛登記的記錄（這支影片的每個檔案）→ 排進旋律索引；索引失敗只影響這一支，不丟回下載迴圈
          var keys = L.records.filter(function (r) { return r.sourceId === sid && r.status === 'ok' && writtenPaths[r.path]; }).map(function (r) { return r.key; });
          item.recKeys = keys;
          if (!autoIndex || !keys.length) return;
          item.idxPending = keys.length;
          var reported = {};
          keys.forEach(function (k) { keyItem[k] = item; });
          indexing.push(melodyQueueKeys(keys, function (ev) {
            var it = keyItem[ev.key];
            if (!it || ev.status === 'running' || ev.status === 'retry') return;
            reported[ev.key] = true;
            FaMusicLibYoutube.recordIndex(ytJob, it, ev.status, ev.reason);
            ytNotify();
          }, useModel).catch(function (e) {
            keys.forEach(function (k) { if (!reported[k]) { reported[k] = true; FaMusicLibYoutube.recordIndex(ytJob, item, 'failed', String((e && e.message) || e)); } });
            ytNotify();
          }));
        },
      };
      await FaMusicLibYoutube.runJob(ytJob, deps, { onChange: ytNotify });
      ytNotify();
      await Promise.all(indexing);
      ytNotify();
      return { ok: true, summary: FaMusicLibYoutube.summarize(ytJob), job: ytJob };
    } catch (e) {
      ytNotify();
      return { ok: false, error: (e && e.stage ? e.stage + '失敗：' : '') + String((e && e.message) || e) };
    } finally {
      ytBusy = false;
    }
  }
  function ytReadHead(path, n) { return api().rawfs.readHead(path, n).then(function (r) { return r && r.base64 != null ? b64ToBytes(r.base64) : null; }); }
  // action：'pause'｜'resume'｜'cancel'；沒有進行中的清單回傳 false
  function youtubeControl(action) {
    // 還在展開清單（還沒有工作）：取消只記旗標，展開完成後就停，不開始下載
    if (!ytJob) { if (action === 'cancel' && ytBusy) { ytCancelRequested = true; return true; } return false; }
    if (action === 'pause') FaMusicLibYoutube.pauseJob(ytJob);
    else if (action === 'resume') FaMusicLibYoutube.resumeJob(ytJob);
    else if (action === 'cancel') FaMusicLibYoutube.cancelJob(ytJob);
    else return false;
    ytNotify();
    return true;
  }
  function youtubeJob() { return ytJob ? { job: ytJob, summary: FaMusicLibYoutube.summarize(ytJob) } : null; }

  return { methods: methods, getLib: getLib, clipMidiSong: clipMidiSong, pickFolder: pickFolder, pickFiles: pickFiles, md5: MD5_HOST, isAbsPath: isAbsPath, walkFolder: walkFolder, whisperTranscribe: whisperTranscribe, melody: MELODY_HOST, extract: PICK_HOST.extract, openNsf: openNsf, play: PLAY_HOST, library: LIB_HOST,
    startYoutubeList: startYoutubeList, youtubeControl: youtubeControl, youtubeJob: youtubeJob,
    youtubeInputNote: function (text) { return FaMusicLibYoutube.inputNote(FaMusicLibYoutube.parseInput(text)); },
    exportBatch: exportBatch, verifyOutput: verifyOutput,
    // 取消批次輸出：正在跑的那個檔案在下一個步驟前中止，之後的檔案標示取消
    cancelExport: function () { exportCancelled = true; },
    setTranscriber: function (fn) { transcriber = typeof fn === 'function' ? fn : null; },
    // 調整佇列的無進展／重試政策（評測用；正式值見 musiclib_core 的常數）
    setQueuePolicy: function (p) { var L = getLib(); if (L.queue) L.queue.setPolicy(p); },
    // 取消所有歌詞轉錄工作（評測結束前、面板卡住時）
    cancelTranscribe: function () { var L = getLib(); if (L.queue) L.queue.cancelAll(); } };
})();
