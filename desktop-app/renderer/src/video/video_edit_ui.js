// /edit-video: the editor FRAME (DOM). Left: the object bar (the video, later the dubs) -- resizable by its splitter, hideable. Middle: the video player. Right: tabs (transcript | job queue).
// The frame itself is an AiChatWindow viewer: docked in the conversation, floating window, maximized. Design: DESIGN.edit-video.md.
//   TwVideoEditUI.mount({ id, project, container, host: { save(project), loadFile(id), putFile(File) }, restoring }) -> element (el._ve = { project, setVideo(file|{id}), tab(name), panel(hidden?), panelWidth(w) })
(function (root) {
  'use strict';
  var C = function () { return root.TwVideoEdit; };
  function zh() { return /^zh/i.test(String((root.document.documentElement && root.document.documentElement.lang) || (root.navigator && root.navigator.language) || '')); }
  function T(a, b) { return zh() ? a : b; }
  function el(tag, cls, text) { var e = root.document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function css() {
    if (root.document.getElementById('tw-ve-css')) { return; }
    var s = root.document.createElement('style'); s.id = 'tw-ve-css';
    s.textContent = '.tw-ve{display:flex;flex-direction:column;border:1px solid #888;border-radius:8px;overflow:hidden;background:var(--ai-win-bg,#fff);color:var(--ai-win-fg,inherit);height:560px;min-height:240px}' +
      '.tw-ve-bar{display:flex;align-items:center;gap:.5em;padding:.3em .6em;border-bottom:1px solid #ccc;background:rgba(120,140,200,.10);flex:0 0 auto}.tw-ve-bar strong{white-space:nowrap}.tw-ve-name{opacity:.7;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}' +
      '.tw-ve-bar button,.tw-ve-tabs button{border:1px solid #8250df;border-radius:6px;background:transparent;color:inherit;padding:2px 9px;cursor:pointer}.tw-ve-bar button.on,.tw-ve-tabs button.on{background:#8250df;color:#fff}' +
      '.tw-ve-body{flex:1 1 auto;min-height:0;display:flex}.tw-ve-panel{flex:0 0 auto;overflow:auto;border-right:1px solid #ccc;padding:6px;box-sizing:border-box}.tw-ve-panel h4{margin:0 0 6px;font-size:13px}' +
      '.tw-ve-split{flex:0 0 6px;cursor:ew-resize;background:rgba(120,140,200,.18)}.tw-ve-split:hover{background:#8250df}.tw-ve-hidden{display:none!important}' +
      '.tw-ve-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column}.tw-ve-stage{flex:1 1 55%;min-height:80px;background:#000;display:flex;align-items:center;justify-content:center;position:relative}' +
      '.tw-ve-stage video{max-width:100%;max-height:100%;display:block}.tw-ve-empty{color:#ccc;text-align:center;padding:10px}.tw-ve-tabs{display:flex;gap:6px;padding:4px 6px;border-top:1px solid #ccc;flex:0 0 auto}' +
      '.tw-ve-tabbody{flex:1 1 45%;min-height:60px;overflow:auto;padding:6px}.tw-ve-objrow{padding:3px 6px;border:1px solid #bbb;border-radius:6px;margin:3px 0;font-size:12px}.tw-ve-note{font-size:12px;opacity:.7}.tw-ve-tool{position:sticky;top:-6px;z-index:2;display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin:-6px -6px 6px;padding:6px;background:var(--ai-win-bg,#fff);border-bottom:1px solid #ccc}.tw-ve-tool button{border:1px solid #8250df;border-radius:6px;background:transparent;color:inherit;padding:2px 9px;cursor:pointer}.tw-ve-tool button:disabled{opacity:.4;cursor:default}.tw-ve-tool button.on{background:#8250df;color:#fff}.tw-ve-err{color:#cf222e;font-size:12px}.tw-ve-job{display:flex;gap:6px;align-items:center;padding:4px 6px;border:1px solid #bbb;border-radius:6px;margin:3px 0;font-size:12px}.tw-ve-job .st{font-weight:600;min-width:64px}.tw-ve-job .pg{flex:1;opacity:.75;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tw-ve-job button{border:1px solid #8250df;border-radius:6px;background:transparent;color:inherit;padding:1px 7px;cursor:pointer}.tw-ve-tool select{padding:1px 3px}.tw-ve-dub{display:flex;gap:4px;align-items:center;flex-wrap:wrap;cursor:pointer}.tw-ve-dub input{width:62px;padding:1px 3px}.tw-ve-dub .x{border:0;background:transparent;cursor:pointer;color:#cf222e;font-size:14px;margin-left:auto}.tw-ve-bar button.rec{background:#cf222e;border-color:#cf222e;color:#fff}.tw-ve-stage:fullscreen video{width:100%;height:100%;max-width:none;max-height:none}.tw-ve-stage:fullscreen .tw-ve-sub{font-size:3vw;bottom:9%}.tw-ve-fs{position:absolute;top:6px;right:6px;z-index:3;border:1px solid #fff8;border-radius:6px;background:rgba(0,0,0,.45);color:#fff;padding:1px 7px;cursor:pointer;opacity:.7}.tw-ve-fs:hover{opacity:1}.tw-ve-menu{position:absolute;right:8px;top:34px;z-index:7;display:flex;flex-direction:column;gap:4px;padding:6px;border:1px solid #888;border-radius:8px;background:var(--ai-win-bg,#fff);color:var(--ai-win-fg,inherit);box-shadow:0 2px 8px rgba(0,0,0,.3)}.tw-ve-menu button{border:1px solid #8250df;border-radius:6px;background:transparent;color:inherit;padding:3px 10px;cursor:pointer;text-align:left}.tw-ve-cue .tts{position:absolute;right:30px;bottom:3px;border:1px solid #8250df;border-radius:50%;width:20px;height:20px;line-height:16px;padding:0;background:var(--ai-win-bg,#fff);cursor:pointer;font-size:11px}.tw-ve-ask{display:flex;flex-direction:column;gap:6px}.tw-ve-asklog>div{padding:4px 6px;border-radius:6px;margin:3px 0;font-size:12px;white-space:pre-wrap}.tw-ve-ask-me{background:rgba(130,80,223,.14);margin-left:24px!important}.tw-ve-ask-ai{border:1px solid #bbb}.tw-ve-ask-err{color:#cf222e}.tw-ve-askin{display:flex;gap:6px;align-items:flex-end}.tw-ve-askin textarea{flex:1;min-height:40px;font:inherit;padding:3px 5px}.tw-ve-askin button,.tw-ve-prop button{border:1px solid #8250df;border-radius:6px;background:transparent;color:inherit;padding:3px 12px;cursor:pointer}.tw-ve-prop{border:1px dashed #8250df;border-radius:6px;padding:6px;font-size:12px}.tw-ve-prop button.go{background:#8250df;color:#fff}.tw-ve-sub{position:absolute;left:4%;right:4%;bottom:12%;text-align:center;color:#fff;font-size:17px;line-height:1.3;white-space:pre-wrap;pointer-events:none;text-shadow:0 0 3px #000,0 0 3px #000,1px 1px 2px #000}' +
      '.tw-ve-cue{position:relative;display:flex;gap:6px;align-items:flex-start;padding:4px;border:1px solid #bbb;border-radius:6px;margin:3px 0;cursor:pointer}.tw-ve-cue.on{border-color:#8250df;background:rgba(130,80,223,.14)}.tw-ve-cue input{width:70px;padding:2px 3px}.tw-ve-cue input.bad{border-color:#cf222e;background:rgba(207,34,46,.12)}.tw-ve-cue textarea{flex:1;min-width:120px;min-height:34px;resize:vertical;padding:2px 4px;font:inherit}.tw-ve-cue .add{position:absolute;right:4px;bottom:3px;border:1px solid #8250df;border-radius:50%;width:20px;height:20px;line-height:16px;padding:0;background:var(--ai-win-bg,#fff);color:#8250df;cursor:pointer;font-size:14px}.tw-ve-cue textarea{padding-bottom:22px}.tw-ve-cue .x{border:0;background:transparent;cursor:pointer;color:#cf222e;font-size:15px}';
    root.document.head.appendChild(s);
  }
  function mount(o) {
    css();
    var core = C(), project = o.project || core.newProject(''), host = o.host || {}, lay = core.layout(project.layout), url = null;
    var box = el('div', 'tw-ve'); box.setAttribute('data-tw-ve', o.id || '');
    var bar = el('div', 'tw-ve-bar'); bar.appendChild(el('strong', '', '🎬 ' + T('影片逐字稿編輯器', 'Video transcript editor')));
    var name = el('span', 'tw-ve-name', project.video ? project.video.name : ''); bar.appendChild(name);
    var slot = el('span', 'ai-win-btns-slot'); slot.style.cssText = 'margin-left:auto;display:inline-flex;gap:.4em;align-items:center';
    var bLoad = el('button', '', '📂 ' + T('載入影片', 'Load video')), bPanel = el('button', '', '☰ ' + T('物件列', 'Objects')); bLoad.type = bPanel.type = 'button'; bLoad.setAttribute('data-ve', 'load'); bPanel.setAttribute('data-ve', 'panel');
    var pick = el('input'); pick.type = 'file'; pick.accept = 'video/*,audio/*,.mkv,.mov'; pick.style.display = 'none';
    var bRec = el('button', '', '🎤 ' + T('配音', 'Dub')); bRec.type = 'button'; bRec.setAttribute('data-ve', 'rec'); bRec.title = T('從目前播放位置開始錄麥克風配音(建議戴耳機);再按一次停止', 'Record a voice-over from the microphone starting at the playhead (headphones recommended); press again to stop');
    slot.appendChild(bRec); slot.appendChild(bLoad); slot.appendChild(bPanel); slot.appendChild(pick); bar.appendChild(slot); box.appendChild(bar);
    var body = el('div', 'tw-ve-body');
    var panel = el('div', 'tw-ve-panel'); panel.setAttribute('data-ve', 'objbar'); panel.appendChild(el('h4', '', T('物件', 'Objects')));
    var objMsg = el('div', 'tw-ve-err'); objMsg.setAttribute('data-ve', 'obj-msg'); panel.appendChild(objMsg);
    var objs = el('div'); panel.appendChild(objs);
    var split = el('div', 'tw-ve-split'); split.setAttribute('data-ve', 'split'); split.title = T('拖曳調整物件列寬度', 'Drag to resize the object bar');
    var main = el('div', 'tw-ve-main'), stage = el('div', 'tw-ve-stage'), empty = el('div', 'tw-ve-empty', T('按「載入影片」選一個影片檔', 'Press "Load video" and pick a video file')); stage.appendChild(empty);
    var tabs = el('div', 'tw-ve-tabs'), tabBody = el('div', 'tw-ve-tabbody'), tabBtn = {};
    var LABEL = { transcript: T('逐字稿', 'Transcript'), ask: T('Ask AI', 'Ask AI'), jobs: T('工作佇列', 'Job queue') };
    core.TABS.forEach(function (t) { var b = el('button', '', LABEL[t]); b.type = 'button'; b.setAttribute('data-ve-tab', t); b.addEventListener('click', function () { setTab(t); }); tabs.appendChild(b); tabBtn[t] = b; });
    main.appendChild(stage); main.appendChild(tabs); main.appendChild(tabBody);
    body.appendChild(panel); body.appendChild(split); body.appendChild(main); box.appendChild(body);

    var cues = core.normalize(project.cues), hist = core.history(cues), errBox = null, listBox = null;
    function dur() { var v = box._ve && box._ve.video; return v && isFinite(v.duration) ? v.duration : 0; }
    function now() { var v = box._ve && box._ve.video; return v ? v.currentTime || 0 : 0; }
    function commit(next) { cues = next; project.cues = cues; hist.push(cues); save(); if (lay.tab === 'transcript') { renderTranscript(); } }
    function flash(msg) { if (errBox) { errBox.textContent = msg || ''; } }
    var ERR = { negative: T('時間不能小於 0', 'Time cannot be negative'), order: T('結束時間要大於開始時間', 'End must be after start'), beyond: T('超過影片長度', 'Beyond the end of the video'), time: T('時間格式:mm:ss.s 或秒數', 'Time format: mm:ss.s or seconds'), full: T('逐字稿列數已達上限', 'Transcript is full'), missing: T('找不到這一列', 'Line not found') };
    function edit(id, patch) { var r = core.updateCue(cues, id, patch, dur()); if (!r.ok) { renderTranscript(); flash(ERR[r.error] || r.error); return; } commit(r.cues); }
    function addAt(t) { var r = core.addCue(cues, { at: t, duration: dur() }); if (!r.ok) { flash(ERR[r.error] || r.error); return; } commit(r.cues); var row = listBox && listBox.querySelector('[data-cue="' + r.id + '"] textarea'); if (row) { row.focus(); } }
    function seek(t) { var v = box._ve && box._ve.video; if (v) { v.currentTime = t; } }
    var subEl = null, curBlob = null, jobsBox = null, q = null;
    var JST = { queued: T('排隊中', 'Queued'), running: T('進行中', 'Running'), done: T('完成', 'Done'), failed: T('失敗', 'Failed'), canceled: T('已取消', 'Canceled'), interrupted: T('中斷', 'Interrupted') };
    function applyTranscript(job, res) {
      var add = core.fromSegments(res && res.segments, job.payload && job.payload.startSec, dur());
      if (!add.length) { throw new Error(T('沒有辨識出任何文字', 'No speech was recognized')); }
      commit(core.normalize(cues.concat(add))); flash(T('辨識完成,新增 ', 'Done: added ') + add.length + T(' 列(可復原;原有的列都保留)', ' lines (undo available; existing lines are kept)'));
      return { added: add.length };
    }
    function runJob(job, report) {
      if (job.kind !== 'transcribe' && job.kind !== 'burn') { return { promise: Promise.reject(new Error('unknown job kind ' + job.kind)) }; }
      if (!curBlob) { return { promise: Promise.reject(new Error(T('沒有影片', 'No video loaded'))) }; }
      if (job.kind === 'burn') {
        if (!host.burn) { return { promise: Promise.reject(new Error(T('這裡不能燒錄字幕', 'Burning subtitles is not available here'))) }; }
        var pd = job.payload.mix === 'all' ? (job.payload.dubs || []) : [], hb = null, gone = false;
        var prep = pd.length ? Promise.all(pd.map(function (d) {
          var a = audios[d.id]; if (a && a.blob) { return Promise.resolve({ start: d.start, blob: a.blob }); }
          return (d.fileId && host.loadFile ? host.loadFile(d.fileId).then(function (r) { return { start: d.start, blob: new root.Blob([r.arrayBuffer], { type: r.mimeType || 'audio/webm' }) }; }) : Promise.reject(new Error('no file'))).catch(function () { return null; });
        })).then(function (l) { var got = l.filter(Boolean); if (got.length < pd.length) { report(T('有 ', '') + (pd.length - got.length) + T(' 個配音讀不到,沒有混進去', ' dubs could not be read and are left out')); } return got; }) : Promise.resolve([]);
        return { cancel: function () { gone = true; if (hb) { hb.cancel(); } }, promise: prep.then(function (list) {
          if (gone) { throw new Error('canceled'); }
          hb = host.burn(curBlob, job.payload.segments || [], report, (project.video && project.video.name) || 'video', { dubs: list });
          return hb.promise; }).then(function (res) { var cur = q.get(job.id); if (!cur || cur.status !== 'running') { return null; } q.patch(job.id, { out: res.id ? { id: res.id, name: res.name } : null }); return { name: res.name, bytes: res.bytes, id: res.id }; }) };
      }
      if (!host.transcribe) { return { promise: Promise.reject(new Error(T('這裡不能做語音辨識', 'Speech recognition is not available here'))) }; }
      var h = host.transcribe(curBlob, { language: job.payload.language || null, startSec: job.payload.startSec || 0, lenSec: job.payload.lenSec || 0 }, report);
      return { cancel: h.cancel, promise: h.promise.then(function (res) { var cur = q.get(job.id); if (!cur || cur.status !== 'running') { return null; } return applyTranscript(job, res); }) };
    }
    function jobsChanged(list) {
      project.jobs = q ? q.serialize() : []; var n = list.filter(function (j) { return j.status === 'queued' || j.status === 'running'; }).length;
      if (tabBtn.jobs) { tabBtn.jobs.textContent = LABEL.jobs + (n ? ' (' + n + ')' : ''); }
      if (lay.tab === 'jobs') { renderJobs(); }
      save();
    }
    function renderJobs() {
      tabBody.textContent = ''; jobsBox = el('div'); jobsBox.setAttribute('data-ve', 'jobs'); var list = q.list();
      if (!list.length) { jobsBox.appendChild(el('div', 'tw-ve-note', T('沒有工作。在「逐字稿」分頁按「🎙 產生逐字稿」會排進這裡。', 'No jobs. "🎙 Generate transcript" in the Transcript tab queues one here.'))); }
      else { var tool = el('div', 'tw-ve-tool'), bc = el('button', '', T('清除已結束', 'Clear finished')); bc.type = 'button'; bc.setAttribute('data-ve', 'jobs-clear'); bc.addEventListener('click', function () { q.clearFinished(); }); tool.appendChild(bc); jobsBox.appendChild(tool); }
      list.forEach(function (j) {
        var r = el('div', 'tw-ve-job'); r.setAttribute('data-job', j.id); r.setAttribute('data-status', j.status);
        r.appendChild(el('span', 'st', JST[j.status] || j.status)); r.appendChild(el('span', '', (j.kind === 'burn' ? '🔥 ' : '🎙 ') + j.label)); r.appendChild(el('span', 'pg', j.status === 'failed' ? j.error : j.progress));
        function btn(txt, tag, fn) { var b = el('button', '', txt); b.type = 'button'; b.setAttribute('data-ve', tag); b.addEventListener('click', fn); r.appendChild(b); }
        if (j.status === 'queued' || j.status === 'running') { btn(T('取消', 'Cancel'), 'job-cancel', function () { q.cancel(j.id); }); }
        else { if (j.kind === 'burn' && j.status === 'done') { btn('⬇ ' + T('下載', 'Download'), 'job-download', function () { downloadJob(j); }); var oid = j.payload && j.payload.out && j.payload.out.id; if (oid && host.openEditor) { btn('✏️ ' + T('繼續編輯輸出', 'Edit the output'), 'job-edit-output', function () { host.openEditor(oid); }); } }
          if (j.status !== 'done') { btn(T('重試', 'Retry'), 'job-retry', function () { q.retry(j.id); }); } btn('✕', 'job-remove', function () { q.remove(j.id); }); }
        jobsBox.appendChild(r);
      });
      tabBody.appendChild(jobsBox);
    }
    function enqueueBurn() {
      if (!curBlob) { flash(T('先載入影片', 'Load a video first')); return; }
      if (!cues.length) { flash(T('沒有逐字稿可燒錄', 'No transcript to burn')); return; }
      var mix = lay.burnMix === 'all' && dubs.length > 0, nm = (project.video && project.video.name) || '', id = q.enqueue({ kind: 'burn', label: nm + ' (' + cues.length + T(' 列', ' lines') + (mix ? ' + ' + dubs.length + T(' 配音', ' dubs') : '') + ')', payload: { segments: cues.map(function (c) { return { start: c.start, end: c.end, text: c.text }; }), mix: mix ? 'all' : 'subs', dubs: mix ? dubs.map(function (d) { return { id: d.id, start: d.start, fileId: d.fileId }; }) : [] } });   // what is on screen NOW is what gets burned
      flash(id ? T('已排入工作佇列(看「工作佇列」分頁)', 'Queued (see the Job queue tab)') : T('工作佇列已滿', 'The job queue is full'));
    }
    function download(blob, name) { var url = root.URL.createObjectURL(blob), a = el('a'); a.href = url; a.download = name; root.document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { root.URL.revokeObjectURL(url); }, 4000); }
    function downloadJob(j) {
      var out = j.payload && j.payload.out, nm = (j.result && j.result.name) || (out && out.name) || 'video-subtitled.mp4';
      if (j.result && j.result.bytes) { download(new root.Blob([j.result.bytes], { type: 'video/mp4' }), nm); return; }
      if (out && out.id && host.loadFile) { host.loadFile(out.id).then(function (rec) { download(new root.Blob([rec.arrayBuffer], { type: 'video/mp4' }), nm); }, function () { flash(T('輸出檔已不在這個瀏覽器的檔案儲存裡,請重新燒錄', 'The output is no longer in this browser\'s file storage; burn again')); }); return; }
      flash(T('沒有可下載的輸出(重新燒錄)', 'No output to download (burn again)'));
    }
    function enqueueTranscribe(language, fromPlayhead) {
      if (!curBlob) { flash(T('先載入影片', 'Load a video first')); return; }
      var start = fromPlayhead ? Math.round(now() * 100) / 100 : 0, nm = (project.video && project.video.name) || '';
      var id = q.enqueue({ kind: 'transcribe', label: nm + (start ? ' @' + core.clock(start) + ' +' + core.CUE_SECONDS + T(' 秒', ' s') : ''), payload: { language: language || null, startSec: start, lenSec: start ? core.CUE_SECONDS : 0 } });
      flash(id ? T('已排入工作佇列(看「工作佇列」分頁)', 'Queued (see the Job queue tab)') : T('工作佇列已滿', 'The job queue is full'));
    }
    function updateOverlay() { if (!subEl) { return; } var a = lay.subs ? core.activeCue(cues, now()) : null, t = a ? a.text : ''; if (subEl.textContent !== t) { subEl.textContent = t; } subEl.style.display = t ? '' : 'none'; }
    var raf = 0;
    function loop() { updateOverlay(); highlight(); syncDubs(); var v = box._ve && box._ve.video; raf = v && !v.paused && !v.ended ? root.requestAnimationFrame(loop) : 0; }
    function startLoop() { if (!raf) { raf = root.requestAnimationFrame(loop); } }
    function importText(text, nm) {
      var r = core.parseSrt(text); if (!r.cues.length) { flash(T('讀不到任何字幕(支援 .srt / .vtt)', 'No subtitles could be read (.srt / .vtt)') + (r.skipped ? ' — ' + r.skipped + T(' 段時間不正確', ' blocks with bad times') : '')); return false; }
      commit(r.cues); flash(T('已匯入 ', 'Imported ') + r.cues.length + T(' 列', ' lines') + (r.skipped ? T(',略過 ', ', skipped ') + r.skipped : '') + T('(可復原)', ' (undo available)')); return true;
    }
    function exportSrt() {
      if (!cues.length) { flash(T('沒有逐字稿可匯出', 'Nothing to export')); return; }
      var base = String((project.video && project.video.name) || project.name || 'transcript').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'transcript';
      var url = root.URL.createObjectURL(new root.Blob([core.formatSrt(cues)], { type: 'application/x-subrip;charset=utf-8' })), a = el('a'); a.href = url; a.download = base + '.srt'; root.document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { root.URL.revokeObjectURL(url); }, 4000);
    }
    function highlight() {
      updateOverlay();
      if (!listBox) { return; } var a = core.activeCue(cues, now()), id = a ? a.id : null;
      [].forEach.call(listBox.querySelectorAll('.tw-ve-cue'), function (r) { var on = r.getAttribute('data-cue') === id; if (on !== r.classList.contains('on')) { r.classList.toggle('on', on); if (on && !listBox.contains(root.document.activeElement)) { r.scrollIntoView({ block: 'nearest' }); } } });
    }
    function renderTranscript() {
      tabBody.textContent = ''; var tool = el('div', 'tw-ve-tool'), bAdd = el('button', '', '➕ ' + T('在播放位置新增', 'Add at playhead')), bUndo = el('button', '', '↶'), bRedo = el('button', '', '↷');
      var bImp = el('button', '', '📥 ' + T('匯入 SRT', 'Import SRT')), bExp = el('button', '', '📤 ' + T('匯出 SRT', 'Export SRT')), bSub = el('button', lay.subs ? 'on' : '', '💬 ' + T('字幕', 'Subtitles')), fin = el('input'); fin.type = 'file'; fin.accept = '.srt,.vtt,.txt,text/*'; fin.style.display = 'none'; fin.setAttribute('data-ve', 'srt-file');
      bImp.setAttribute('data-ve', 'srt-import'); bExp.setAttribute('data-ve', 'srt-export'); bSub.setAttribute('data-ve', 'subs'); bSub.title = T('播放時在影片上顯示字幕', 'Show the subtitles over the video while playing');
      bImp.addEventListener('click', function () { fin.click(); });
      fin.addEventListener('change', function () { var f = fin.files && fin.files[0]; fin.value = ''; if (f) { f.text().then(function (tx) { importText(tx, f.name); }, function (e) { flash((e && e.message) || String(e)); }); } });
      bExp.addEventListener('click', exportSrt);
      bSub.addEventListener('click', function () { lay.subs = !lay.subs; bSub.classList.toggle('on', lay.subs); updateOverlay(); save(); });
      var bGen = el('button', '', '🎙 ' + T('產生逐字稿', 'Generate transcript')), selL = el('select'), scope = el('select');
      [['zh', '中文'], ['en', 'English'], ['', T('自動', 'Auto')]].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; selL.appendChild(op); }); selL.value = (/^en/i.test(String(root.document.documentElement.lang || '')) ? 'en' : 'zh'); selL.setAttribute('data-ve', 'gen-lang');
      [['whole', T('整支影片', 'Whole video')], ['playhead', T('播放位置起 ', 'At playhead ') + core.CUE_SECONDS + T(' 秒', ' s')]].forEach(function (o) { var op = el('option', '', o[1]); op.value = o[0]; scope.appendChild(op); }); scope.value = lay.genScope; scope.addEventListener('change', function () { lay.genScope = scope.value === 'whole' ? 'whole' : 'playhead'; save(); }); scope.setAttribute('data-ve', 'gen-scope'); scope.title = T('辨識的範圍:只辨識播放位置起短短 ' + core.CUE_SECONDS + ' 秒(和「在播放位置新增」一樣長),或整支影片', 'What to recognize: only a few seconds (' + core.CUE_SECONDS + ' s, as long as a line added at the playhead) from the playhead, or the whole video');
      bGen.setAttribute('data-ve', 'gen'); bGen.title = T('在瀏覽器裡用 Whisper 辨識(第一次要下載約 77MB 模型);排進工作佇列,可繼續編輯', 'Recognize with Whisper in this browser (first use downloads a ~77 MB model); queued, you can keep editing');
      bGen.addEventListener('click', function () { enqueueTranscribe(selL.value, scope.value === 'playhead'); });
      var bBurn = el('button', '', '🔥 ' + T('燒錄字幕', 'Burn subtitles')); bBurn.setAttribute('data-ve', 'burn'); bBurn.title = T('把目前的逐字稿燒進影片,輸出 <影片名>-subtitled.mp4(排進工作佇列)', 'Burn the current transcript into the video, output <name>-subtitled.mp4 (queued)'); bBurn.addEventListener('click', enqueueBurn);
      bGen.type = 'button'; tool.appendChild(bGen); tool.appendChild(scope); tool.appendChild(selL); [bAdd, bUndo, bRedo, bImp, bExp, bSub, bBurn].forEach(function (b) { b.type = 'button'; tool.appendChild(b); });
      var mixSel = el('select'); [['all', T('字幕+配音', 'Subtitles + dubs')], ['subs', T('僅字幕', 'Subtitles only')]].forEach(function (o2) { var op = el('option', '', o2[1]); op.value = o2[0]; mixSel.appendChild(op); }); mixSel.value = lay.burnMix; mixSel.setAttribute('data-ve', 'burn-mix'); mixSel.title = T('燒錄輸出要不要把配音(麥克風、TTS)混進聲音', 'Whether the burned video also gets the dubs (microphone, TTS) mixed into its audio'); mixSel.addEventListener('change', function () { lay.burnMix = mixSel.value === 'subs' ? 'subs' : 'all'; save(); }); tool.appendChild(mixSel); tool.appendChild(fin); bAdd.setAttribute('data-ve', 'cue-add'); bUndo.setAttribute('data-ve', 'undo'); bRedo.setAttribute('data-ve', 'redo'); bUndo.title = T('復原', 'Undo'); bRedo.title = T('重做', 'Redo');
      bUndo.disabled = !hist.canUndo(); bRedo.disabled = !hist.canRedo();
      bAdd.addEventListener('click', function () { addAt(now()); });
      bUndo.addEventListener('click', function () { cues = hist.undo(); project.cues = cues; save(); renderTranscript(); }); bRedo.addEventListener('click', function () { cues = hist.redo(); project.cues = cues; save(); renderTranscript(); });
      tool.appendChild(el('span', 'tw-ve-note', cues.length + T(' 列', ' lines'))); errBox = el('span', 'tw-ve-err'); errBox.setAttribute('data-ve', 'cue-msg'); tool.appendChild(errBox); tabBody.appendChild(tool);
      listBox = el('div'); listBox.setAttribute('data-ve', 'cues');
      if (!cues.length) { listBox.appendChild(el('div', 'tw-ve-note', T('還沒有逐字稿:按「在播放位置新增」(產生逐字稿、匯入 SRT 之後會加上)', 'No transcript yet: press "Add at playhead" (generate and SRT import come later)'))); }
      cues.forEach(function (c) {
        var row = el('div', 'tw-ve-cue'); row.setAttribute('data-cue', c.id);
        var a = el('input'), b = el('input'), tx = el('textarea'), x = el('button', 'x', '✕'); a.value = core.clock(c.start); b.value = core.clock(c.end); tx.value = c.text; x.type = 'button'; x.title = T('刪除', 'Delete');
        a.setAttribute('data-f', 'start'); b.setAttribute('data-f', 'end'); tx.setAttribute('data-f', 'text'); x.setAttribute('data-f', 'del');
        function timeField(inp, key) { inp.addEventListener('change', function () { var t = core.parseT(inp.value); if (t === null) { inp.classList.add('bad'); flash(ERR.time); return; } var o = {}; o[key] = t; edit(c.id, o); }); }
        timeField(a, 'start'); timeField(b, 'end');
        tx.addEventListener('change', function () { edit(c.id, { text: tx.value }); });
        x.addEventListener('click', function (e) { e.stopPropagation(); var r = core.removeCue(cues, c.id); if (r.ok) { commit(r.cues); } });
        row.addEventListener('click', function (e) { if (e.target.closest('input,textarea,button')) { return; } seek(c.start); highlight(); });
        var plus = el('button', 'add', '+'); plus.type = 'button'; plus.setAttribute('data-f', 'add-after'); plus.title = T('在這一列後面新增一列(從播放位置起;播放位置在這列結束前就從這列結束時間起)', 'Add a line after this one (at the playhead; from the end of this line when the playhead is earlier)');
        plus.addEventListener('click', function (e) { e.stopPropagation(); addAt(Math.max(now(), c.end)); });
        var tb = el('button', 'tts', '🔊'); tb.type = 'button'; tb.setAttribute('data-f', 'cue-tts'); tb.title = T('用 TTS 唸這一句,加成配音(從這句開始時間起)', 'Speak this line with TTS and add it as a dub (starting at this line)');
        tb.addEventListener('click', function (e) { e.stopPropagation(); openTts({ text: tx.value, start: c.start }); });
        row.appendChild(a); row.appendChild(b); row.appendChild(tx); row.appendChild(x); row.appendChild(plus); if (canTts()) { row.appendChild(tb); } listBox.appendChild(row);
      });
      tabBody.appendChild(listBox); highlight();
    }
    // ---- Ask AI: say what to change; the program (plain sentences) or the online model (closed JSON actions) answers with a PROPOSAL, shown first; "Apply" makes it ONE undo step of the transcript (and then speaks the TTS dubs it asked for)
    var askLog = [], askProp = null, askBusy = false, askDraft = '', Ai = function () { return root.TwVideoEditAi; };
    function askSay(kind, text, lines) { askLog.push({ k: kind, t: text, l: lines || [] }); if (lay.tab === 'ask') { renderAsk(); } }
    function lineSummary(list, bad) { return list.map(function (a) { return '• ' + a.text; }).concat(bad.map(function (x) { return '✗ ' + x.text; })); }
    function askModel(text, base) {
      var P = Ai().editPrompt(base, text, { duration: dur() });
      return host.ai.chat(P.system, P.user).then(function (rep) {
        var pr = Ai().parseReply(rep); if (!pr.ok) { return { edits: [], say: T('AI 的回覆我讀不懂(要是 JSON 動作)。換個說法再試,或用程式讀得懂的句子,例如「第 3 句改成…」。', 'I could not read the AI\'s answer (it has to be JSON actions). Rephrase, or use a sentence the program reads, e.g. "set line 3 to …".'), dropped: [] }; }
        var ap = Ai().applyEdits(base, pr.edits, dur(), true), problems = ap.rejected.map(function (x) { return x.op + ': ' + x.error; }).concat(pr.droppedOps.map(function (o) { return o + ': not an allowed action'; }));
        if (!problems.length) { return { edits: pr.edits, say: pr.say, dropped: [] }; }
        // one more round: the model gets the reasons and corrects itself; what is still wrong is shown, never dropped silently
        return host.ai.chat(P.system, P.user + '\n\nYour previous answer:\n' + String(rep).slice(0, 1800) + '\n\nProblems found (fix them, answer the complete JSON again):\n- ' + problems.join('\n- ')).then(function (rep2) {
          var p2 = Ai().parseReply(rep2); return p2.ok ? { edits: p2.edits, say: p2.say, dropped: p2.droppedOps } : { edits: pr.edits, say: pr.say, dropped: pr.droppedOps };
        }, function () { return { edits: pr.edits, say: pr.say, dropped: pr.droppedOps }; });
      });
    }
    function submitAsk(text) {
      text = String(text || '').trim(); if (!text || askBusy) { return Promise.resolve(); }
      askProp = null; askDraft = ''; askSay('me', text); askBusy = true; var base = cues, local = Ai().localParse(text, cues, { now: now(), duration: dur() }), p;
      if (local.edits.length) { p = Promise.resolve({ edits: local.edits, say: T('程式讀懂了你的句子。', 'Read your sentence directly.'), dropped: [] }); }
      else { p = (host.ai ? host.ai.mode() : Promise.resolve('none')).then(function (m) { return m === 'online' ? askModel(text, base) : { edits: [], say: T('這句話程式讀不懂,而且現在沒有線上 AI 可問。可以說「第 3 句改成…」「全部提早 0.5 秒」「刪掉空白句」「把第 3 句用英文配音」「把 A 換成 B」「合併第 2 句」。', 'The program could not read this and no online AI is available. Try "set line 3 to …", "shift all 0.5 s earlier", "delete empty lines", "dub line 3 in English", "replace A with B", "merge line 2".'), dropped: [] }; }); }
      return p.then(function (res) {
        askBusy = false; var ap = Ai().applyEdits(base, res.edits, dur(), /^zh/i.test(String(root.document.documentElement.lang || '')));
        var bad = ap.rejected.concat((res.dropped || []).map(function (o) { return { text: o + T(':不在可做的清單裡,沒有執行', ': not an allowed action, not run') }; }));
        if (ap.applied.length) { askProp = { base: base, ap: ap }; }
        askSay('ai', res.say || (ap.applied.length ? '' : T('沒有任何變更。', 'No change.')), lineSummary(ap.applied, bad));
      }, function (e) { askBusy = false; askSay('err', '⚠️ ' + ((e && e.message) || e)); });
    }
    function applyAsk() {
      var pr = askProp; if (!pr || askBusy) { return Promise.resolve(); } askProp = null;
      if (cues !== pr.base) { askSay('err', T('逐字稿在這之間改過了,請再說一次。', 'The transcript changed in the meantime; say it again.')); return Promise.resolve(); }
      if (JSON.stringify(pr.ap.cues) !== JSON.stringify(cues)) { commit(pr.ap.cues); }
      askSay('ok', T('已套用(逐字稿分頁的 ↶ 可以一次復原)。', 'Applied (↶ in the Transcript tab undoes it in one step).'));
      askBusy = true; var voices = host.voices ? host.voices() : [];
      return pr.ap.tts.reduce(function (chain, t) {
        return chain.then(function () {
          var v = voices.filter(function (x) { return x.id === t.voice; })[0] || (host.pickVoice ? host.pickVoice(t.text, t.lang) : null), vid = v ? v.id : '', lang = t.lang || (v && v.lang) || '';
          askSay('ai', T('TTS 配音 ', 'TTS dub ') + core.clock(t.start) + T(':合成中…', ': synthesizing…'));
          return addTtsDub({ text: t.text, lang: lang, voiceId: vid, start: t.start }).then(function () { askSay('ok', '🔊 ' + core.clock(t.start) + T(' 已加入配音(在物件列,按播放就會混音)', ' dub added (object bar; press play to hear the mix)')); }, function (e) { askSay('err', '✗ TTS ' + core.clock(t.start) + ': ' + ((e && e.message) || e)); });
        });
      }, Promise.resolve()).then(function () { askBusy = false; if (lay.tab === 'ask') { renderAsk(); } });
    }
    function renderAsk() {
      tabBody.textContent = ''; var wrap = el('div', 'tw-ve-ask'), log = el('div', 'tw-ve-asklog'); wrap.setAttribute('data-ve', 'ask'); log.setAttribute('data-ve', 'ask-log');
      if (!askLog.length) { log.appendChild(el('div', 'tw-ve-note', T('說你要怎麼改逐字稿或加配音,例如:「第 3 句改成…」「全部提早 0.5 秒」「刪掉空白句」「把第 2 句用英文配音」「把整段翻成英文」(最後一種需要線上 AI)。先給你看會改什麼,按「套用」才生效,可復原。', 'Say how to change the transcript or add a dub, e.g. "set line 3 to …", "shift all 0.5 s earlier", "delete empty lines", "dub line 2 in English", "translate everything to English" (the last one needs the online AI). You see what would change first; "Apply" makes it happen, undo works.'))); }
      askLog.forEach(function (e) { var r = el('div', 'tw-ve-ask-' + e.k, e.t); e.l.forEach(function (ln) { r.appendChild(el('div', /^✗/.test(ln) ? 'tw-ve-err' : '', ln)); }); log.appendChild(r); });
      wrap.appendChild(log);
      if (askProp) {
        var pb = el('div', 'tw-ve-prop'), go = el('button', 'go', T('套用 ', 'Apply ') + askProp.ap.applied.length + T(' 項', ' change(s)')), no = el('button', '', T('放棄', 'Discard')); go.type = no.type = 'button'; pb.setAttribute('data-ve', 'ask-proposal'); go.setAttribute('data-ve', 'ask-apply'); no.setAttribute('data-ve', 'ask-discard');
        go.addEventListener('click', function () { applyAsk(); }); no.addEventListener('click', function () { askProp = null; askSay('ok', T('已放棄。', 'Discarded.')); }); pb.appendChild(go); pb.appendChild(no); wrap.appendChild(pb);
      }
      var inRow = el('div', 'tw-ve-askin'), ta = el('textarea'), sb = el('button', '', askBusy ? '…' : T('送出', 'Send')); ta.setAttribute('data-f', 'ask-text'); sb.setAttribute('data-f', 'ask-send'); sb.type = 'button'; ta.value = askDraft; ta.placeholder = T('例如:第 2 句用英文配音', 'e.g. dub line 2 in English'); sb.disabled = askBusy;
      ta.addEventListener('input', function () { askDraft = ta.value; }); ta.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); submitAsk(ta.value); } }); sb.addEventListener('click', function () { submitAsk(ta.value); });
      inRow.appendChild(ta); inRow.appendChild(sb); wrap.appendChild(inRow); tabBody.appendChild(wrap); log.scrollTop = log.scrollHeight;
    }
    function save() { project.layout = lay; if (host.save) { try { host.save(project); } catch (e) { /* the editor works without saving */ } } }
    function applyPanel() {
      var total = box.clientWidth || root.innerWidth || 800; lay.panelW = core.clampPanelWidth(lay.panelW, total);
      panel.style.width = lay.panelW + 'px'; panel.classList.toggle('tw-ve-hidden', lay.panelHidden); split.classList.toggle('tw-ve-hidden', lay.panelHidden); bPanel.classList.toggle('on', !lay.panelHidden);
    }
    function setTab(t) {
      lay.tab = core.TABS.indexOf(t) >= 0 ? t : 'transcript'; core.TABS.forEach(function (k) { tabBtn[k].classList.toggle('on', k === lay.tab); });
      tabBody.textContent = ''; tabBody.setAttribute('data-ve-active', lay.tab);
      listBox = null; errBox = null;
      if (lay.tab === 'transcript') { renderTranscript(); } else if (lay.tab === 'ask') { renderAsk(); } else { renderJobs(); }
      save();
    }
    var dubs = core.normalizeDubs(project.dubs), audios = {}, rec = null;
    var DERR = { negative: T('時間不能小於 0', 'Time cannot be negative'), beyond: T('起始時間超過影片長度', 'Start is beyond the end of the video'), time: T('時間格式:mm:ss.s 或秒數', 'Time format: mm:ss.s or seconds'), full: T('配音已達上限', 'Too many dubs'), missing: T('找不到這個配音', 'Dub not found') };
    function msg(t) { objMsg.textContent = t || ''; }
    function commitDubs(next) { dubs = next; project.dubs = dubs; save(); renderObjs(); }
    function freeAudio(id) { var a = audios[id]; if (a) { try { if (a.el) { a.el.pause(); } if (a.url) { root.URL.revokeObjectURL(a.url); } } catch (e) { /* gone */ } delete audios[id]; } }
    // one <audio> per dub, made on first need (from the blob just recorded, or read back from the file storage after a refresh)
    function audioFor(d) {
      var a = audios[d.id]; if (a && a.el) { return a; } if (a && a.loading) { return null; }
      if (!a) { a = audios[d.id] = { el: null, url: null, blob: null }; } a.loading = true;
      var got = a.blob ? Promise.resolve(a.blob) : (d.fileId && host.loadFile ? host.loadFile(d.fileId).then(function (r) { return new root.Blob([r.arrayBuffer], { type: r.mimeType || 'audio/webm' }); }) : Promise.reject(new Error('no file')));
      got.then(function (b) { if (audios[d.id] !== a) { return; } a.url = root.URL.createObjectURL(b); a.el = new root.Audio(a.url); a.el.preload = 'auto'; a.loading = false; syncDubs(); }, function () { /* the dub stays silent */ });
      return null;
    }
    // the dubs that cover the playhead play (from the right offset), the others are silent; nothing plays while the video is paused
    function syncDubs() {
      var v = box._ve && box._ve.video, t = v ? v.currentTime : 0, play = v && !v.paused && !v.ended, act = core.activeDubs(dubs, t).map(function (d) { return d.id; });
      dubs.forEach(function (d) {
        var on = play && act.indexOf(d.id) >= 0, a = on ? audioFor(d) : audios[d.id];
        if (!a || !a.el) { return; }
        if (!on) { if (!a.el.paused) { a.el.pause(); } return; }
        var want = t - d.start; if (Math.abs(a.el.currentTime - want) > 0.3) { a.el.currentTime = Math.max(0, want); } if (a.el.paused) { a.el.play().catch(function () { /* autoplay refused */ }); }
      });
    }
    function renderObjs() {
      objs.textContent = '';
      var r = el('div', 'tw-ve-objrow', project.video ? '🎞 ' + project.video.name : T('(還沒有影片)', '(no video yet)')); r.setAttribute('data-ve', 'obj-video'); objs.appendChild(r);
      if (!dubs.length) { objs.appendChild(el('div', 'tw-ve-note', T('按標題列的「🎤 配音」錄音或用 TTS 唸文字;配音會列在這裡(起始時間、時長)', 'Press "🎤 Dub" in the title bar to record or to speak a text (TTS); dubs are listed here (start time, length)'))); }
      dubs.forEach(function (d) {
        var row = el('div', 'tw-ve-objrow tw-ve-dub'); row.setAttribute('data-dub', d.id);
        var st = el('input'); st.value = core.clock(d.start); st.setAttribute('data-f', 'dstart'); st.title = T('起始時間', 'Start time');
        var du = el('span', '', T('時長 ', 'len ') + core.clock(d.duration)); du.setAttribute('data-f', 'ddur'); var x = el('button', 'x', '✕'); x.type = 'button'; x.setAttribute('data-f', 'ddel'); x.title = T('刪除配音', 'Delete the dub');
        st.addEventListener('change', function () { var t = core.parseT(st.value), vd = box._ve && box._ve.video, m = t === null ? { ok: false, error: 'time' } : core.moveDub(dubs, d.id, t, vd && isFinite(vd.duration) ? vd.duration : 0); if (!m.ok) { renderObjs(); msg(DERR[m.error] || m.error); return; } msg(''); commitDubs(m.dubs); });
        x.addEventListener('click', function (e) { e.stopPropagation(); var m = core.removeDub(dubs, d.id); if (m.ok) { freeAudio(d.id); commitDubs(m.dubs); } });
        row.addEventListener('click', function (e) { if (e.target.closest('input,button')) { return; } seek(d.start); });
        var nm = el('span', '', (d.kind === 'tts' ? '🔊 ' : '🎤 ') + d.name); if (d.kind === 'tts') { nm.title = d.text + (d.voiceId ? ' · ' + d.voiceId : ''); } row.appendChild(nm); row.appendChild(st); row.appendChild(du); row.appendChild(x); objs.appendChild(row);
      });
    }
    function micError(e) { var n = e && e.name; return n === 'NotAllowedError' || n === 'SecurityError' ? T('麥克風被拒絕(請在瀏覽器允許麥克風;需要 https 或 localhost)', 'Microphone was refused (allow it in the browser; needs https or localhost)') : n === 'NotFoundError' ? T('找不到麥克風', 'No microphone found') : T('無法錄音:', 'Cannot record: ') + ((e && e.message) || e); }
    function stopRec() { if (rec && rec.mr && rec.mr.state !== 'inactive') { rec.mr.stop(); } }
    function startRec() {
      var v = box._ve && box._ve.video; if (!v) { msg(T('先載入影片', 'Load a video first')); return; }
      if (!root.navigator.mediaDevices || !root.navigator.mediaDevices.getUserMedia || typeof root.MediaRecorder === 'undefined') { msg(T('這個瀏覽器不能錄音', 'This browser cannot record audio')); return; }
      msg(''); var start = v.currentTime || 0;
      root.navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        var types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'], mt = ''; types.some(function (t) { if (root.MediaRecorder.isTypeSupported && root.MediaRecorder.isTypeSupported(t)) { mt = t; return true; } return false; });
        var mr = mt ? new root.MediaRecorder(stream, { mimeType: mt }) : new root.MediaRecorder(stream), chunks = [], t0 = root.performance.now();
        rec = { mr: mr, timer: null }; bRec.classList.add('rec');
        function tick() { bRec.textContent = '⏹ ' + core.clock((root.performance.now() - t0) / 1000); } tick(); rec.timer = root.setInterval(tick, 200);
        mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) { chunks.push(ev.data); } };
        mr.onstop = function () {
          root.clearInterval(rec.timer); rec = null; bRec.classList.remove('rec'); bRec.textContent = '🎤 ' + T('配音', 'Dub'); stream.getTracks().forEach(function (tr) { tr.stop(); }); if (!v.paused) { v.pause(); }
          var elapsed = (root.performance.now() - t0) / 1000, blob = new root.Blob(chunks, { type: mr.mimeType || mt || 'audio/webm' });
          if (!blob.size) { msg(T('沒有錄到聲音', 'Nothing was recorded')); return; }
          finishDub(blob, start, elapsed).then(null, function () { /* shown by msg */ });
        };
        mr.start(); if (v.paused) { v.play().catch(function () { /* the user can press play */ }); }
      }, function (e) { msg(micError(e)); });
    }
    // the length is the DECODED length of the recording when the browser can decode it (a MediaRecorder file has no reliable header length), else the time it was recording
    function finishDub(blob, start, elapsed, extra) {
      var Ctx = root.AudioContext || root.webkitAudioContext;
      var len = Ctx ? blob.arrayBuffer().then(function (ab) { return new Ctx().decodeAudioData(ab); }).then(function (b) { return b.duration; }, function () { return elapsed; }) : Promise.resolve(elapsed);
      return len.then(function (d) {
        var ext = /wav/.test(blob.type) ? 'wav' : /mpeg|mp3/.test(blob.type) ? 'mp3' : /mp4/.test(blob.type) ? 'm4a' : /ogg/.test(blob.type) ? 'ogg' : 'webm', file = new root.File([blob], 'dub-' + Date.now().toString(36) + '.' + ext, { type: blob.type });
        var save1 = host.putFile ? host.putFile(file).catch(function () { return null; }) : Promise.resolve(null);
        return save1.then(function (fileId) {
          var m = core.addDub(dubs, Object.assign({ start: start, duration: d > 0.05 ? d : elapsed, fileId: fileId }, extra || {})); if (!m.ok) { msg(DERR[m.error] || m.error); throw new Error(DERR[m.error] || m.error); }
          audios[m.id] = { el: null, url: null, blob: blob }; commitDubs(m.dubs); if (!fileId) { msg(T('做好了,但存不進瀏覽器檔案儲存:重新整理後會消失', 'Done, but it could not be saved in this browser: it is gone after a refresh')); } return m.id;
        });
      });
    }
    // "Dub": while recording, a press stops it; otherwise the choice -- the microphone, or text-to-speech (only when this page has voices)
    var menu = null;
    function closeMenu() { if (menu) { menu.remove(); menu = null; root.document.removeEventListener('click', outsideMenu, true); } }
    function outsideMenu(e) { if (menu && !menu.contains(e.target) && e.target !== bRec) { closeMenu(); } }
    function canTts() { return !!(host.synthesize && host.voices && host.voices().length); }
    // a dub made from text: the host speaks it (this browser's Kokoro / the server's CJK relay), the audio becomes a dub starting at `start` -- the same kind of object as a microphone one, played with the video from then on
    function addTtsDub(r) {
      if (!host.synthesize) { return Promise.reject(new Error(T('這裡不能語音合成', 'Text to speech is not available here'))); }
      if (!box._ve || !box._ve.video) { return Promise.reject(new Error(T('先載入影片', 'Load a video first'))); }
      msg(T('合成中… ', 'Synthesizing… ') + String(r.text).slice(0, 20));
      return host.synthesize(r.text, r.voiceId, r.lang).then(function (blob) { return finishDub(blob, r.start, 1, { kind: 'tts', text: r.text, lang: r.lang, voiceId: r.voiceId, name: 'TTS ' + String(r.text).replace(/\s+/g, ' ').slice(0, 14) }); }).then(function (id) { msg(''); return id; }, function (e) { msg('⚠️ ' + ((e && e.message) || e)); throw e; });
    }
    function openTts(pre) {
      if (!box._ve || !box._ve.video) { msg(T('先載入影片', 'Load a video first')); return; }
      root.TwVideoTtsDialog.open({ container: box, T: T, text: pre.text, lang: pre.lang, voiceId: pre.voiceId, voices: host.voices(), pickVoice: host.pickVoice }).then(function (r) { if (r) { addTtsDub({ text: r.text, lang: r.lang, voiceId: r.voiceId, start: pre.start }).then(null, function () { /* shown by msg */ }); } });
    }
    bRec.addEventListener('click', function () {
      if (rec) { stopRec(); return; } if (menu) { closeMenu(); return; } if (!canTts()) { startRec(); return; }
      menu = el('div', 'tw-ve-menu'); menu.setAttribute('data-ve', 'dub-menu');
      var m1 = el('button', '', '🎤 ' + T('麥克風錄音', 'Record with the microphone')), m2 = el('button', '', '🔊 ' + T('TTS 文字轉語音…', 'Text to speech…')); m1.type = m2.type = 'button'; m1.setAttribute('data-ve', 'dub-mic'); m2.setAttribute('data-ve', 'dub-tts');
      m1.addEventListener('click', function () { closeMenu(); startRec(); }); m2.addEventListener('click', function () { closeMenu(); openTts({ text: '', start: now() }); });
      menu.appendChild(m1); menu.appendChild(m2); box.appendChild(menu); root.document.addEventListener('click', outsideMenu, true);
    });
    // full screen is the STAGE's (the video + the subtitle layer + the dubs keep playing), not the <video>'s own: the native one would show the picture alone, without the subtitles
    var fsBtn = el('button', 'tw-ve-fs', '⛶'); fsBtn.type = 'button'; fsBtn.setAttribute('data-ve', 'fullscreen'); fsBtn.title = T('全螢幕(字幕會一起顯示);Esc 離開', 'Full screen (the subtitles stay); Esc to leave');
    function toggleFs() { var d = root.document; if (d.fullscreenElement) { d.exitFullscreen(); } else if (stage.requestFullscreen) { stage.requestFullscreen().then(null, function () { msg(T('這個瀏覽器不允許全螢幕', 'Full screen is not allowed here')); }); } }
    fsBtn.addEventListener('click', toggleFs);
    function showVideo(blob, nm) {
      curBlob = blob;
      if (url) { root.URL.revokeObjectURL(url); } url = root.URL.createObjectURL(blob);
      stage.textContent = ''; var v = el('video'); v.controls = true; v.src = url; v.setAttribute('data-ve', 'video'); v.addEventListener('timeupdate', highlight); v.addEventListener('seeked', highlight); v.addEventListener('play', function () { startLoop(); syncDubs(); }); v.addEventListener('pause', syncDubs); v.addEventListener('ended', syncDubs); v.addEventListener('seeked', syncDubs); subEl = el('div', 'tw-ve-sub'); subEl.setAttribute('data-ve', 'subtitle'); subEl.style.display = 'none'; v.setAttribute('controlsList', 'nofullscreen'); stage.appendChild(v); stage.appendChild(subEl); stage.appendChild(fsBtn); box._ve.video = v; name.textContent = nm || ''; renderObjs();
    }
    function setVideo(src) {
      if (src && typeof src.arrayBuffer === 'function' && host.putFile) {         // a File the user picked: keep it in this browser's file storage so a refresh can load it again
        return host.putFile(src).then(function (id) { project.video = { id: id, name: src.name }; showVideo(src, src.name); save(); return id; });
      }
      if (src && typeof src.arrayBuffer === 'function') { project.video = { id: null, name: src.name }; showVideo(src, src.name); save(); return Promise.resolve(null); }
      if (src && src.id && host.loadFile) {
        return host.loadFile(src.id).then(function (rec) { var b = new root.Blob([rec.arrayBuffer], { type: rec.mimeType || 'video/mp4' }); project.video = { id: src.id, name: rec.filename || src.name || '' }; showVideo(b, project.video.name); if (host.pin) { host.pin(src.id); } save(); });
      }
      return Promise.reject(new Error(T('這個影片來源讀不到', 'cannot read this video source')));
    }
    bLoad.addEventListener('click', function () {
      if (!root.TwVideoSourcePicker || !(host.chatFiles || host.fapFolders || host.storedFiles)) { pick.click(); return; }
      root.TwVideoSourcePicker.open({ container: box, T: T, mediaKind: root.TwVideoIntent ? root.TwVideoIntent.mediaKind : function () { return 'video'; }, chatFiles: host.chatFiles, fapFolders: host.fapFolders, storedFiles: host.storedFiles, computer: function () { pick.click(); }, start: 'chat' }).then(function (f) {
        if (!f) { return; }
        (f.twClientFileId ? setVideo({ id: f.twClientFileId }) : setVideo(f)).then(null, function (e) { msg('⚠️ ' + ((e && e.message) || e)); });
      });
    });
    pick.addEventListener('change', function () { var f = pick.files && pick.files[0]; pick.value = ''; if (f) { setVideo(f).then(null, function (e) { stage.textContent = '⚠️ ' + ((e && e.message) || e); }); } });
    bPanel.addEventListener('click', function () { lay.panelHidden = !lay.panelHidden; applyPanel(); save(); });
    split.addEventListener('pointerdown', function (e) {
      e.preventDefault(); var x0 = e.clientX, w0 = lay.panelW;
      var mv = function (m) { lay.panelW = core.clampPanelWidth(w0 + m.clientX - x0, box.clientWidth); applyPanel(); };
      var up = function () { root.document.removeEventListener('pointermove', mv); root.document.removeEventListener('pointerup', up); save(); };
      root.document.addEventListener('pointermove', mv); root.document.addEventListener('pointerup', up);
    });
    root.addEventListener('resize', applyPanel);

    q = root.TwVideoJobs.create({ run: runJob, onChange: jobsChanged }); q.restore(project.jobs);
    box._ve = { project: project, say: msg, dubs: function () { return dubs; }, dubAudio: function (id) { return audios[id] && audios[id].el; }, queue: q, enqueueBurn: enqueueBurn, enqueueTranscribe: enqueueTranscribe, importText: importText, ask: submitAsk, applyAsk: applyAsk, addTtsDub: addTtsDub, cues: function () { return cues; }, addAt: addAt, edit: edit, video: null, setVideo: setVideo, tab: setTab, panel: function (hidden) { if (hidden !== undefined) { lay.panelHidden = !!hidden; applyPanel(); save(); } return !lay.panelHidden; },
      panelWidth: function (w) { if (w !== undefined) { lay.panelW = core.clampPanelWidth(w, box.clientWidth); applyPanel(); save(); } return lay.panelW; }, layout: function () { return lay; } };
    (o.container || root.document.body).appendChild(box);
    var FW = o.windowApi || root.FaWin || (typeof FaWin !== 'undefined' ? FaWin : null);   // desktop-app: the shared window shell (pop out / maximize / dock); the plugin uses AiChatWindow
    if (FW && FW.decorate) { box._win = FW.decorate(box, { id: 'ev:' + (o.id || ''), title: T('影片逐字稿編輯器', 'Video transcript editor'), bar: bar, minW: 520, minH: 360 }); }
    else if (root.AiChatWindow) { root.AiChatWindow.attach(box, { key: 'edit-video/' + (o.id || ''), title: T('影片逐字稿編輯器', 'Video transcript editor'), bar: bar, body: body, minW: 420, minH: 300 }); }
    applyPanel(); renderObjs(); setTab(lay.tab);
    if (project.video && project.video.id) { setVideo({ id: project.video.id, name: project.video.name }).then(null, function () { stage.textContent = ''; stage.appendChild(el('div', 'tw-ve-empty', T('影片不在這個瀏覽器的檔案儲存裡了,請重新載入', 'The video is no longer in this browser\'s file storage; load it again'))); }); }
    return box;
  }
  root.TwVideoEditUI = { mount: mount };
}(typeof window !== 'undefined' ? window : globalThis));
