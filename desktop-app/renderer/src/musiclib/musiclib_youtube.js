/* 音樂庫的 YouTube 清單來源（純函式，UMD）：不碰 DOM、不碰網路、不碰磁碟。
 *   parseInput(text) → { mode:'playlist', listId, videoId? } 或 { mode:'video', videoId } 或 { error }
 *       清單網址（含 list=）優先；網址同時有 v= 時，videoId 只拿來提示「這是清單中的一支」。沒有 list= 才當單支影片。
 *   inputNote(parsed) → 給畫面看的提示（清單網址裡夾了單支影片時說明會展開整個清單，可取消）；沒有就是空字串。
 *   buildFlatPlaylistScript(listId) → 要交給 Pyodide 的 yt-dlp 腳本（extract_flat，只列清單，不下載）。
 *   parseFlatPlaylist(jsonText 或物件) → { title, entries:[{ videoId, title, channel, durationSec }] }；去掉重複與無效 ID。
 *   createJob(opts) → 工作物件：每支影片一個項目（pending／skipped／failed／done），狀態只在記憶體裡。
 *       opts.autoIndex：下載登記後要不要自動排進旋律索引（記在 job.autoIndex，摘要才知道「索引未開啟」）。
 *   markDuplicates(job, existingIds) → 已在曲庫的影片直接標成略過（不重複下載）。
 *   classifySkip(reason) → 略過的分類：'license'（非本人頻道且非 Creative Commons）／'notfound'（查無此影片）／'other'。
 *   recordIndex(job, item, status, reason) → 旋律索引逐筆回報（runMelodyIndex 的事件）；一支影片的每個檔案都索引完才計一次。
 *   runJob(job, deps, hooks) → 逐支：範圍驗證 → 下載 → 寫入與登記。單支失敗不影響其他；可暫停、續跑、取消。
 *       deps 由 host 提供：verify(videoId) → { ok, reason, title, verification_skipped }（沿用 app 既有的範圍驗證，不另外放寬）
 *                          download(videoId, report) → { title, files:[{ kind, ext, bytes }] }
 *                          store(item, title, files) → Promise（寫檔＋登記；丟錯時附 err.stage 的話就用它，否則算「寫入」階段）
 *       hooks.onChange(job) 每次狀態改變時呼叫（畫面重繪用）。
 *   fileNameFor(title, videoId, kind, ext, multi) → 下載檔名，一律帶 [影片ID]，之後用來去重。
 *   videoIdFromName(name) → 從檔名拿回影片 ID（沒有就 null）。
 *   summarize(job) → 計數與一行摘要文字（下載、索引、略過依原因分組、失敗依階段分組）。
 * 失敗訊息格式：「階段失敗：原因（HTTP 狀態）」，階段是：展開、驗證、下載、寫入、登記。 */
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
    var vm = /[?&]v=([A-Za-z0-9_-]{11})/.exec(s);
    if (lm && LIST_RE.test(lm[1])) return { mode: 'playlist', listId: lm[1], videoId: vm ? vm[1] : null };
    var pats = [/youtube\.com\/watch\?(?:[^\s"'<>]*&)?v=([A-Za-z0-9_-]{11})/, /youtu\.be\/([A-Za-z0-9_-]{11})/, /youtube\.com\/embed\/([A-Za-z0-9_-]{11})/, /youtube\.com\/shorts\/([A-Za-z0-9_-]{11})/];
    for (var i = 0; i < pats.length; i++) {
      var m = pats[i].exec(s);
      if (m) return { mode: 'video', videoId: m[1] };
    }
    return { error: '找不到 YouTube 清單網址（含 list=）或影片連結' };
  }
  // 清單網址裡同時夾了單支影片（watch?v=…&list=…）：以清單為準，但要讓使用者知道、也能取消
  function inputNote(parsed) {
    if (parsed && parsed.mode === 'playlist' && parsed.videoId) return '這是清單中的一支，會展開整個清單（按「取消」可停止）';
    return '';
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

  // 略過的原因分類：授權規則（非本人頻道且非 Creative Commons）、查無此影片、其他（畫面上分組顯示）
  function classifySkip(reason) {
    var s = String(reason || '');
    if (/非本人頻道且非/.test(s)) return 'license';
    if (/查無此影片/.test(s)) return 'notfound';
    return 'other';
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
          status: 'pending', stage: null, reason: null, skipKind: null, verificationSkipped: false, path: null,
          recKeys: [], idxPending: 0, idxOk: false, idxCounted: false, idxReason: null, progressText: null };
      }),
      state: 'idle',          // idle → running → done／cancelled
      paused: false,
      cancelled: false,
      verificationSkipped: false,
      autoIndex: !!opts.autoIndex,
      index: { done: 0, failed: 0 },   // 旋律索引：一支影片的每個檔案都完成才計一次
      _wake: null,
    };
  }

  function markDuplicates(job, existingIds) {
    job.items.forEach(function (it) {
      if (it.status === 'pending' && existingIds && existingIds[it.videoId]) {
        it.status = 'skipped'; it.reason = '已在曲庫（重複，略過）'; it.skipKind = 'duplicate';
      }
    });
    return job;
  }

  // 旋律索引逐筆回報。status：done／skipped（已建過也算成功）／failed／cancelled；running、retry 不計數
  function recordIndex(job, item, status, reason) {
    if (!job.index) job.index = { done: 0, failed: 0 };
    if (status === 'running' || status === 'retry') return job;
    if (status === 'done' || status === 'skipped') item.idxOk = true;
    else item.idxReason = reason || (status === 'cancelled' ? '索引已取消' : '索引失敗');
    item.idxPending = Math.max(0, (item.idxPending || 0) - 1);
    if (item.idxPending === 0 && !item.idxCounted) {
      item.idxCounted = true;
      if (item.idxOk) job.index.done++; else job.index.failed++;
    }
    return job;
  }

  var SKIP_NAMES = { license: '非本人頻道且非 Creative Commons', notfound: '查無此影片（下架、不公開或 ID 錯）', duplicate: '已在曲庫', other: '其他' };
  // 略過分組：每一組一句，附第一個原因（其他類才附，讓使用者知道是什麼）
  function skipGroups(job) {
    var count = {}, first = {};
    job.items.forEach(function (it) {
      if (it.status !== 'skipped') return;
      var k = it.skipKind || 'other';
      count[k] = (count[k] || 0) + 1;
      if (!first[k]) first[k] = it.reason;
    });
    var out = [];
    ['license', 'notfound', 'duplicate', 'other'].forEach(function (k) {
      if (!count[k]) return;
      out.push(SKIP_NAMES[k] + '：' + count[k] + ' 支' + (k === 'other' && first[k] ? '（第一個：' + first[k] + '）' : ''));
    });
    return out;
  }
  // 失敗分組：依階段（下載、寫入、登記…）各一句；索引失敗另列
  function failGroups(job) {
    var byStage = {}, order = [];
    job.items.forEach(function (it) {
      if (it.status !== 'failed') return;
      var st = it.stage || '未知';
      if (!byStage[st]) { byStage[st] = { n: 0, first: String(it.reason || '').replace(/^[^：]*失敗：/, '') }; order.push(st); }
      byStage[st].n++;
    });
    var out = order.map(function (st) { return st + '失敗：' + byStage[st].n + ' 支（第一個原因：' + byStage[st].first + '）'; });
    var idxFail = job.items.filter(function (it) { return it.idxCounted && !it.idxOk; });
    if (idxFail.length) out.push('索引失敗：' + idxFail.length + ' 支（第一個原因：' + idxFail[0].idxReason + '）');
    return out;
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
    c.unverified = job.items.filter(function (it) { return it.status === 'done' && it.verificationSkipped; }).length;
    c.indexDone = job.index ? job.index.done : 0;
    c.indexFailed = job.index ? job.index.failed : 0;
    c.skipGroups = skipGroups(job);
    c.failGroups = failGroups(job);
    var parts = ['下載 ' + c.done + '／' + c.total];
    parts.push(job.autoIndex ? '索引 ' + c.indexDone + '／' + c.total : '索引未開啟');
    if (c.skipped) parts.push('略過 ' + c.skipped + '（' + c.skipGroups.join('；') + '）');
    var dlFail = c.failGroups.filter(function (x) { return x.indexOf('索引失敗') !== 0; });
    if (c.failed) parts.push('失敗 ' + c.failed + '（' + dlFail.join('；') + '）');
    if (c.unverified) parts.push('驗證沒做（沒設金鑰）：' + c.unverified + ' 支');
    if (c.pending + c.working) parts.push('待處理 ' + (c.pending + c.working));
    c.text = state + '：YouTube：' + parts.join('、')
      + (c.indexFailed ? '｜' + c.failGroups.filter(function (x) { return x.indexOf('索引失敗') === 0; })[0] : '')
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
          it.status = 'skipped'; it.reason = (v && v.reason) || '跳過：未通過下載範圍驗證'; it.skipKind = classifySkip(it.reason); change();
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
    inputNote: inputNote,
    buildFlatPlaylistScript: buildFlatPlaylistScript,
    parseFlatPlaylist: parseFlatPlaylist,
    fileNameFor: fileNameFor,
    videoIdFromName: videoIdFromName,
    existingIdsFrom: existingIdsFrom,
    classifySkip: classifySkip,
    createJob: createJob,
    markDuplicates: markDuplicates,
    recordIndex: recordIndex,
    summarize: summarize,
    pauseJob: pauseJob,
    resumeJob: resumeJob,
    cancelJob: cancelJob,
    runJob: runJob,
  };
});
