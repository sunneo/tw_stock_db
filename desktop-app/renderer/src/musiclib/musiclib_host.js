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
      try { r = await a.rawfs.readFile(record.path, 'base64'); } catch (e) { throw new Error('讀檔失敗：' + String((e && e.message) || e)); }
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
    async function readSource() { var r = await a.rawfs.readFile(rec.path, 'base64'); if (!r || r.base64 == null) throw new Error('讀檔失敗：讀不到這個檔案的內容'); return b64ToBytes(r.base64); }
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
    try { r = await a.rawfs.readFile(rec.path, 'base64'); } catch (e) { throw new Error('讀檔失敗：' + String((e && e.message) || e)); }
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
  async function playClip(path, startSec, endSec) {
    var a = api(); var r = await a.rawfs.readFile(path, 'base64');
    if (!r || r.base64 == null) throw new Error('讀不到這個檔案');
    var url = URL.createObjectURL(new Blob([b64ToBytes(r.base64)]));
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

  // 建立（或續跑）旋律索引：已建且檔案沒變的跳過；結果寫進音樂庫的紀錄（record.melody），再 lib.save()
  async function buildMelodyIndex(onEvent, useModel) {
    var L = getLib(); await L.ready;
    if (melodyState.running) throw new Error('旋律索引已在建立中');
    melodyState.running = true; melodyState.cancelled = false;
    var recs = L.records.filter(function (r) { return r.status === 'ok' && !r.pending; });
    var saveCount = 0;
    try {
      var sum = await FaMusicLibMelody.runMelodyIndex(recs, {
        extract: function (rec) { return extractMelody(rec, !!useModel); },
        save: async function () { if (++saveCount % 10 === 0) await L.save(); },
        onEvent: onEvent || function () {},
        isCancelled: function () { return melodyState.cancelled; },
        waitIfPaused: melodyGate
      });
      await L.save();
      return sum;
    } finally { melodyState.running = false; melodyState.paused = false; }
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
    if (opts.useText) {
      text = String(opts.textQuery || '').trim();
      if (!text && opts.blob) text = await transcribeHum(opts.blob);
      if (text) textHits = new Set(L.search(text, { scope: 'lyrics' }).map(function (x) { return x.record.key; }));
    }
    var res = FaMusicLibMelody.searchMelody(notes, entries, { minScore: opts.minScore, limit: opts.limit || 10, textHits: textHits, textWeight: 0.15 });
    res.textUsed = text;
    return res;
  }
  // 找不到時：把查到的旋律用 MIDI 演奏出來（用既有的 MIDI 編輯器與播放）
  function humAsMidi(notes, title) {
    var fa = window.fa, s = FaMidi.emptySong();
    s.title = title || '哼歌旋律';
    var mel = FaMusicLibMelody.melodyNotes(notes);
    s = FaMidi.addTrack(s, '哼歌旋律', 0, false);
    var ti = s.tracks.length - 1;
    mel.forEach(function (x) { s = FaMidi.addNote(s, ti, { t: FaMidi.secToTicks(s, x.t), d: Math.max(1, FaMidi.secToTicks(s, x.t + x.d) - FaMidi.secToTicks(s, x.t)), n: Math.round(x.n), v: 90 }); });
    return fa._midiPushEditor(FaMidi.validate(s), s.title, '🎵 哼歌找歌找不到，這是你哼的旋律（' + mel.length + ' 個音）。可以按「試聽」。');
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
    entries: function () { return melodyEntries(getLib()); }
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
    try { r = await a.rawfs.readFile(rec.path, 'base64'); } catch (e) { throw new Error('讀檔失敗（讀取階段）：' + String((e && e.message) || e)); }
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
      if (extractCancelled) { results.push({ name: rec.name, status: 'cancelled', reason: '', stage: null, elapsedMs: 0 }); continue; }
      var stage = null;
      try {
        var out = await extractGameSource(rec, Object.assign({}, opts, { onStage: function (s) { stage = s; if (opts.onEvent) opts.onEvent({ key: rec.key, stage: s }); } }));
        results.push({ name: rec.name, kind: rec.kind, status: out.skipped ? 'skipped' : 'done', reason: out.reason || '', stage: stage, children: out.children.length, skippedParts: out.skippedParts, method: out.method, dir: out.dir, elapsedMs: Date.now() - t0 });
      } catch (e) {
        var cancelledNow = !!(e && e.cancelled) || extractCancelled;
        results.push({ name: rec.name, kind: rec.kind, status: cancelledNow ? 'cancelled' : 'failed', reason: String((e && e.message) || e), stage: stage, children: 0, elapsedMs: Date.now() - t0 });
      }
    }
    var summary = { done: 0, skipped: 0, failed: 0, cancelled: 0 };
    results.forEach(function (x) { summary[x.status] = (summary[x.status] || 0) + 1; });
    return { results: results, summary: summary };
  }

  var PICK_HOST = { pickFolder: pickFolder, melody: MELODY_HOST, extract: { run: extractSources, cancel: function () { extractCancelled = true; } }, openNsf: openNsf };

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
    var r = await a.rawfs.readFile(rec.path, 'base64');
    if (!r || r.base64 == null) throw new Error('讀檔失敗：讀不到這個 NSF 的內容');
    var player = FaChipPlayer.createPlayer('nsf', b64ToBytes(r.base64), { sampleRate: 44100 });
    return FaChipPlayerUI.mount({ player: player, title: rec.name, host: CHIP_HOST });
  }

  return { methods: methods, getLib: getLib, pickFolder: pickFolder, walkFolder: walkFolder, whisperTranscribe: whisperTranscribe, melody: MELODY_HOST, extract: PICK_HOST.extract, openNsf: openNsf,
    exportBatch: exportBatch, verifyOutput: verifyOutput,
    // 取消批次輸出：正在跑的那個檔案在下一個步驟前中止，之後的檔案標示取消
    cancelExport: function () { exportCancelled = true; },
    setTranscriber: function (fn) { transcriber = typeof fn === 'function' ? fn : null; },
    // 調整佇列的無進展／重試政策（評測用；正式值見 musiclib_core 的常數）
    setQueuePolicy: function (p) { var L = getLib(); if (L.queue) L.queue.setPolicy(p); },
    // 取消所有歌詞轉錄工作（評測結束前、面板卡住時）
    cancelTranscribe: function () { var L = getLib(); if (L.queue) L.queue.cancelAll(); } };
})();
