/* 音樂庫的 YouTube 清單來源（純函式，UMD）：不碰 DOM、不碰網路、不碰磁碟。
 *   parseInput(text) → { mode:'playlist', listId } 或 { mode:'video', videoId } 或 { error }
 *       清單網址（含 list=）優先；沒有 list= 才當單支影片。
 *   buildFlatPlaylistScript(listId) → 要交給 Pyodide 的 yt-dlp 腳本（extract_flat，只列清單，不下載）。
 *   parseFlatPlaylist(jsonText 或物件) → { title, entries:[{ videoId, title, channel, durationSec }] }；去掉重複與無效 ID。
 *   createJob(opts) → 工作物件：每支影片一個項目（pending／skipped／failed／done），狀態只在記憶體裡。
 *   markDuplicates(job, existingIds) → 已在曲庫的影片直接標成略過（不重複下載）。
 *   runJob(job, deps, hooks) → 逐支：範圍驗證 → 下載 → 寫入與登記。單支失敗不影響其他；可暫停、續跑、取消。
 *       deps 由 host 提供：verify(videoId) → { ok, reason, title, verification_skipped }（沿用 app 既有的範圍驗證，不另外放寬）
 *                          download(videoId, report) → { title, files:[{ kind, ext, bytes }] }
 *                          store(item, title, files) → Promise（寫檔＋登記；丟錯時附 err.stage 的話就用它，否則算「寫入」階段）
 *       hooks.onChange(job) 每次狀態改變時呼叫（畫面重繪用）。
 *   fileNameFor(title, videoId, kind, ext, multi) → 下載檔名，一律帶 [影片ID]，之後用來去重。
 *   videoIdFromName(name) → 從檔名拿回影片 ID（沒有就 null）。
 *   summarize(job) → 計數與一行摘要文字。
 * 失敗訊息格式：「階段失敗：原因（HTTP 狀態）」，階段是：展開、驗證、下載、寫入。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibYoutube = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ID_RE = /^[A-Za-z0-9_-]{11}$/;
  var LIST_RE = /^[A-Za-z0-9_-]{2,64}$/;

  function errText(err) { return String((err && err.message) || err || '未知錯誤'); }
  // 訊息裡已經有 HTTP 狀態就不再重複附上
  function httpSuffix(err) { return err && err.status && errText(err).indexOf('HTTP ' + err.status) < 0 ? '（HTTP ' + err.status + '）' : ''; }

  // ───── 輸入解析 ─────
  function parseInput(text) {
    var s = String(text || '');
    var lm = /[?&]list=([A-Za-z0-9_-]+)/.exec(s);
    if (lm && LIST_RE.test(lm[1])) return { mode: 'playlist', listId: lm[1] };
    var pats = [/youtube\.com\/watch\?(?:[^\s"'<>]*&)?v=([A-Za-z0-9_-]{11})/, /youtu\.be\/([A-Za-z0-9_-]{11})/, /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/, /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].exec(s);
      if (m) return { mode: 'video', videoId: m[1] };
    }
    return { error: '找不到 YouTube 清單網址（含 list=）或影片連結' };
  }

  // ───── 清單展開（yt-dlp flat-playlist，不下載） ─────
  function buildFlatPlaylistScript(listId) {
    if (!LIST_RE.test(String(listId || ''))) throw new Error('清單 ID 格式不對：' + listId);
    return [
      'import yt_dlp, json as _fa_json_ml',
      "ydl_opts = {'quiet': True, 'no_warnings': True, 'skip_download': True, 'extract_flat': 'in_playlist'}",
      'with yt_dlp.YoutubeDL(ydl_opts) as ydl:',
      "    info = ydl.extract_info('https://www.youtube.com/playlist?list=" + String(listId) + "', download=False)",
      'out = []',
      "for e in (info.get('entries') or []):",
      '    if not e:',
      '        continue',
      "    out.append({'id': e.get('id'), 'title': e.get('title'), 'channel': e.get('channel') or e.get('uploader'), 'duration': e.get('duration')})",
      "_result = _fa_json_ml.dumps({'title': info.get('title'), 'entries': out})",
      '_result',
    ].join('\n');
  }

  function parseFlatPlaylist(raw) {
    var obj;
    if (typeof raw === 'string') {
      try { obj = JSON.parse(raw); } catch (e) { throw new Error('展開結果不是合法的 JSON：' + errText(e)); }
    } else obj = raw || {};
    var list = Array.isArray(obj.entries) ? obj.entries : [];
    var seen = {}, entries = [];
    list.forEach(function (e) {
      var id = e && typeof e.id === 'string' ? e.id : '';
      if (!ID_RE.test(id) || seen[id]) return;
      seen[id] = true;
      var d = e.duration == null ? null : Number(e.duration);
      entries.push({ videoId: id, title: e.title ? String(e.title) : null, channel: e.channel ? String(e.channel) : null, durationSec: d != null && isFinite(d) ? d : null });
    });
    if (!entries.length) throw new Error('展開後沒有任何影片（清單可能是空的、私人、或需要登入）');
    return { title: obj.title ? String(obj.title) : null, entries: entries };
  }

  // ───── 檔名與去重 ─────
  function safeName(s) { return String(s || '').replace(/[\\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 100) || 'video'; }
  function fileNameFor(title, videoId, kind, ext, multi) {
    var base = safeName(title) + ' [' + videoId + ']';
    return multi ? base + '.' + kind + '.' + ext : base + '.' + ext;
  }
  function videoIdFromName(name) {
    var m = /\[([A-Za-z0-9_-]{11})\](?:\.[^.\\\/]+)+$/.exec(String(name || ''));
    return m ? m[1] : null;
  }
  // 曲庫記錄 → 已存在的影片 ID（只算 ok 的記錄；消失的檔案不算，讓使用者可以重新下載）
  function existingIdsFrom(records) {
    var out = {};
    (records || []).forEach(function (r) {
      if (r.sourceType !== 'youtube' || r.status !== 'ok') return;
      var id = videoIdFromName(r.name || r.path);
      if (id) out[id] = true;
    });
    return out;
  }

  // ───── 工作 ─────
  function createJob(opts) {
    opts = opts || {};
    var entries = Array.isArray(opts.entries) ? opts.entries : [];
    return {
      id: 'yt' + Date.now().toString(36),
      source: { mode: opts.mode || 'playlist', listId: opts.listId || null, videoId: opts.videoId || null },
      title: opts.title || null,
      items: entries.map(function (e) {
        return { videoId: e.videoId, title: e.title || null, channel: e.channel || null, durationSec: e.durationSec == null ? null : e.durationSec,
          status: 'pending', stage: null, reason: null, verificationSkipped: false, path: null };
      }),
      state: 'idle',          // idle → running → done／cancelled
      paused: false,
      cancelled: false,
      verificationSkipped: false,
      _wake: null,
    };
  }

  function markDuplicates(job, existingIds) {
    job.items.forEach(function (it) {
      if (it.status === 'pending' && existingIds && existingIds[it.videoId]) {
        it.status = 'skipped'; it.reason = '已在曲庫（重複，略過）';
      }
    });
    return job;
  }

  function summarize(job) {
    var c = { total: job.items.length, done: 0, skipped: 0, failed: 0, pending: 0, working: 0 };
    job.items.forEach(function (it) {
      if (it.status === 'done') c.done++;
      else if (it.status === 'skipped') c.skipped++;
      else if (it.status === 'failed') c.failed++;
      else if (it.status === 'working') c.working++;
      else c.pending++;
    });
    var state = job.cancelled ? '已取消' : job.state === 'done' ? '完成' : job.paused ? '已暫停' : job.state === 'running' ? '進行中' : '待開始';
    c.state = state;
    c.verificationSkipped = !!job.verificationSkipped;
    c.text = state + '：成功 ' + c.done + '、略過 ' + c.skipped + '、失敗 ' + c.failed + '、待處理 ' + (c.pending + c.working) + '（共 ' + c.total + '）'
      + (job.verificationSkipped ? '｜⚠️ 沒有設定 YouTube Data API 金鑰／頻道 ID，這次沒有做範圍驗證' : '');
    return c;
  }

  function pauseJob(job) { if (job.state === 'running' && !job.cancelled) job.paused = true; return job; }
  function resumeJob(job) {
    job.paused = false;
    if (job._wake) { var w = job._wake; job._wake = null; w(); }
    return job;
  }
  function cancelJob(job) {
    job.cancelled = true;
    job.paused = false;
    if (job._wake) { var w = job._wake; job._wake = null; w(); }
    return job;
  }

  function waitWhilePaused(job) {
    if (!job.paused || job.cancelled) return Promise.resolve();
    return new Promise(function (resolve) { job._wake = resolve; });
  }

  // 逐支執行。單支失敗只標記該支，繼續下一支；暫停時等目前這支做完才停；取消時在下一支開始前停。
  async function runJob(job, deps, hooks) {
    hooks = hooks || {};
    var change = function () { if (typeof hooks.onChange === 'function') { try { hooks.onChange(job); } catch (_) { /* 畫面出錯不影響工作 */ } } };
    job.state = 'running';
    change();
    for (var i = 0; i < job.items.length; i++) {
      await waitWhilePaused(job);
      if (job.cancelled) break;
      var it = job.items[i];
      if (it.status !== 'pending') continue;
      var stage = '驗證';
      try {
        it.status = 'working'; change();
        var v = await deps.verify(it.videoId);
        if (v && v.title && !it.title) it.title = v.title;
        if (v && v.verification_skipped) { it.verificationSkipped = true; job.verificationSkipped = true; }
        if (!v || !v.ok) {
          it.status = 'skipped'; it.reason = (v && v.reason) || '跳過：未通過下載範圍驗證'; change();
          continue;
        }
        stage = '下載';
        var got = await deps.download(it.videoId, function (frac, text) { it.progressText = text; change(); });
        stage = '寫入';
        var title = it.title || (got && got.title) || it.videoId;
        it.title = title;
        await deps.store(it, title, (got && got.files) || []);
        it.status = 'done'; it.reason = null; it.stage = null;
      } catch (err) {
        var st = (err && err.stage) || stage;
        it.status = 'failed'; it.stage = st;
        it.reason = st + '失敗：' + errText(err) + httpSuffix(err);
      }
      it.progressText = null;
      change();
    }
    job.state = job.cancelled ? 'cancelled' : 'done';
    change();
    return job;
  }

  return {
    parseInput: parseInput,
    buildFlatPlaylistScript: buildFlatPlaylistScript,
    parseFlatPlaylist: parseFlatPlaylist,
    fileNameFor: fileNameFor,
    videoIdFromName: videoIdFromName,
    existingIdsFrom: existingIdsFrom,
    createJob: createJob,
    markDuplicates: markDuplicates,
    summarize: summarize,
    pauseJob: pauseJob,
    resumeJob: resumeJob,
    cancelJob: cancelJob,
    runJob: runJob,
  };
});
