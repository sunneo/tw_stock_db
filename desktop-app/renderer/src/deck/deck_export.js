// Exports of a prepared "/media-presentation" deck (see ai_chat_deck_player.js): MP4, PPTX, the original .deck.yaml,
// subtitles (.srt/.vtt) and a bundle (.zip). Every export first waits until every slide is prepared (narration synthesised,
// pictures loaded) -- it reuses what the player already prepared, nothing is made twice.
//
// MP4 reuses ai_chat_video_export.js (the same WebCodecs + mp4-muxer path the 2D/3D viewers use) and calls the SAME
// renderFrame the player draws with, so the video is the playback. PPTX reuses the branded slide styles of
// ai_chat_markdown.js (pptxKit); animation and transitions cannot live in a PPTX made this way, so each slide shows the
// finished picture and the narration goes into the speaker notes.
(function (window) {
  'use strict';

  var Core = window.AiChatDeckCore;

  function safeName(s) { return String(s || 'presentation').replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 60) || 'presentation'; }
  function download(blob, name) {
    var url = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1500);
  }

  // ------------------------------------------------------------------ the progress panel
  // Every export shows a card over the player: the steps it has (done / running / waiting), a bar for the whole export and for the running
  // step, what is happening right now, the time left, and a Cancel button. P is also callable: P(text) just sets the detail line.
  var STEPS = {
    mp4: ['準備旁白與圖片', '渲染畫面並編碼影片(含旁白、字幕)', '封裝並存成檔案'],
    pptx: ['準備旁白與圖片', '組合投影片(截圖與表格)', '產生 .pptx 檔'],
    zip: ['準備旁白與圖片', '加入描述檔、字幕與旁白音檔', '壓縮成 .zip'],
    pack: ['準備旁白與圖片', '收集簡報用到的圖片與檔案', '加入描述檔、旁白、字幕與作答紀錄', '壓縮成簡報封包'],
    srt: ['準備旁白(取得每句的時間)', '產生字幕檔'],
    vtt: ['準備旁白(取得每句的時間)', '產生字幕檔']
  };
  var TITLES = { mp4: '匯出 MP4 影片', pptx: '匯出 PPTX 投影片', zip: '匯出完整封包', pack: '匯出簡報封包(可再開啟播放)', srt: '匯出字幕 (.srt)', vtt: '匯出字幕 (.vtt)' };

  function mk(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function fmtTime(sec) { sec = Math.max(0, Math.round(sec)); var m = Math.floor(sec / 60), r = sec % 60; return m + ':' + (r < 10 ? '0' : '') + r; }

  function makeProgress(box, title, labels, onText) {
    var card = mk('div', 'ai-chat-deck-export-card'), head = mk('div', 'ai-chat-deck-export-title', title);
    var overall = mk('div', 'ai-chat-deck-export-bar'), overallFill = mk('div', 'ai-chat-deck-export-bar-fill'); overall.appendChild(overallFill);
    var overallText = mk('div', 'ai-chat-deck-export-overall', '');
    var list = mk('ol', 'ai-chat-deck-export-steps'), items = labels.map(function (l) { var li = mk('li', 'waiting'); li.appendChild(mk('span', 'ai-chat-deck-export-icon', '○')); li.appendChild(mk('span', null, l)); list.appendChild(li); return li; });
    var stepBar = mk('div', 'ai-chat-deck-export-bar small'), stepFill = mk('div', 'ai-chat-deck-export-bar-fill'); stepBar.appendChild(stepFill);
    var detail = mk('div', 'ai-chat-deck-export-detail', '');
    var actions = mk('div', 'ai-chat-deck-export-actions'), cancel = mk('button', 'ai-chat-deck-btn', '取消'), close = mk('button', 'ai-chat-deck-btn', '關閉');
    cancel.type = close.type = 'button'; close.style.display = 'none'; actions.appendChild(cancel); actions.appendChild(close);
    [head, overall, overallText, list, stepBar, detail, actions].forEach(function (n) { card.appendChild(n); });
    box.appendChild(card);
    var st = { i: 0, f: 0, t0: Date.now(), cancelled: false, over: false };
    function render() {
      var n = labels.length, frac = Math.min(1, (st.i + st.f) / n);
      overallFill.style.width = (frac * 100) + '%'; stepFill.style.width = (st.f * 100) + '%';
      overallText.textContent = st.over ? '' : '步驟 ' + Math.min(st.i + 1, n) + ' / ' + n + ' · 整體 ' + Math.round(frac * 100) + '%';
      items.forEach(function (li, k) {
        var state = k < st.i ? 'done' : (k === st.i && !st.over ? 'running' : 'waiting');
        li.className = state; li.firstChild.textContent = state === 'done' ? '✓' : (state === 'running' ? '▶' : '○');
      });
    }
    function P(text) { detail.textContent = text; if (onText) { onText(text); } }
    P.step = function (i, text) { st.i = i; st.f = 0; st.t0 = Date.now(); render(); if (text) { P(text); } };
    P.frac = function (f, text) {
      st.f = Math.max(0, Math.min(1, f)); render();
      var eta = st.f > 0.03 && st.f < 1 ? (Date.now() - st.t0) / 1000 / st.f * (1 - st.f) : null;
      P((text || '') + (eta != null ? ' · 剩約 ' + fmtTime(eta) : ''));
    };
    P.isCancelled = function () { return st.cancelled; };
    P.check = function () { if (st.cancelled) { throw new Error('已取消匯出'); } };
    P.done = function (msg) { if (st.over) { return; } st.i = labels.length; st.f = 0; st.over = true; render(); overallText.textContent = '完成'; P(msg || ''); cancel.style.display = 'none'; close.style.display = ''; setTimeout(function () { if (card.parentNode) { card.remove(); } }, 8000); };
    P.fail = function (msg) { if (st.over) { return; } st.over = true; render(); card.classList.add('failed'); overallText.textContent = st.cancelled ? '已取消' : '失敗'; P(msg || ''); cancel.style.display = 'none'; close.style.display = ''; };
    // Cancel must not wait for a long step (preparing narration, a terminal that never answers) to finish: anything awaited through
    // P.raceCancel(promise) is abandoned the moment Cancel is pressed (the work itself goes on in the background, e.g. the preheat).
    var hooks = [];
    P.raceCancel = function (promise) {
      return Promise.race([promise, new Promise(function (_res, rej) { if (st.cancelled) { rej(new Error('已取消匯出')); } else { hooks.push(function () { rej(new Error('已取消匯出')); }); } })]);
    };
    // Safety net: whatever step is running, 3 seconds after Cancel the card is finished as cancelled (the work stops by itself later); the
    // card can never sit on "取消中…".
    var forcedReject = null;
    P.forced = new Promise(function (_res, rej) { forcedReject = rej; });
    P.forced.catch(function () { /* handled by run() */ });
    cancel.addEventListener('click', function () {
      if (st.cancelled) { return; }
      st.cancelled = true; cancel.disabled = true; cancel.textContent = '取消中…'; hooks.splice(0).forEach(function (h) { h(); });
      setTimeout(function () { if (!st.over && forcedReject) { forcedReject(new Error('已取消匯出(背景工作還在收尾)')); } }, 3000);
    });
    close.addEventListener('click', function () { card.remove(); });
    P.step(0);
    return P;
  }

  function prepareAll(session, P) {
    var total = session.preps.length, ready = session.preps.filter(function (_p, i) { return session.isReady(i); }).length;
    P.step(0, '正在準備旁白與圖片…(' + ready + ' / ' + total + ' 頁已預熱，已經好的會直接略過)');
    // pages already prepared by the player's preheat resolve at once; only the remaining ones cost time (and each is shown as it finishes)
    return P.raceCancel(session.whenAllReady(function (done, n) { P.frac(done / n, '旁白與圖片:第 ' + done + ' / ' + n + ' 頁'); })).then(function () {
      P.check();
      return session.settleTerminals ? P.raceCancel(Promise.resolve(session.settleTerminals(function (d, t) { P.frac(d / t, '終端機:執行第 ' + d + ' / ' + t + ' 個'); }))) : null;
    }).then(function () { P.check(); });
  }

  // ------------------------------------------------------------------ MP4
  function askMp4Options() {
    return new Promise(function (resolve) {
      var overlay = document.createElement('div'); overlay.className = 'ai-chat-dialog-overlay';
      var dlg = document.createElement('div'); dlg.className = 'ai-chat-dialog';
      dlg.innerHTML = '<h3>匯出 MP4 影片</h3>' +
        '<div style="margin-bottom:0.8em;"><label class="block">解析度<br><select class="dk-res" style="width:100%;"><option value="1280">720p (1280×720)</option><option value="1920">1080p (1920×1080,較慢)</option></select></label></div>' +
        '<div style="margin-bottom:0.8em;"><label class="block">每秒影格<br><select class="dk-fps" style="width:100%;"><option value="24">24</option><option value="30" selected>30</option></select></label></div>' +
        '<div style="margin-bottom:0.8em;"><label><input type="checkbox" class="dk-sub" checked> 把字幕燒進影片</label></div>' +
        '<div class="ai-chat-dialog-actions"><span class="ai-chat-dialog-actions-spacer"></span><button type="button" class="dk-cancel">取消</button><button type="button" class="dk-ok">匯出</button></div>';
      overlay.appendChild(dlg); document.body.appendChild(overlay);
      function close(v) { document.body.removeChild(overlay); resolve(v); }
      overlay.addEventListener('click', function (e) { if (e.target === overlay) { close(null); } });
      dlg.querySelector('.dk-cancel').addEventListener('click', function () { close(null); });
      dlg.querySelector('.dk-ok').addEventListener('click', function () {
        close({ width: parseInt(dlg.querySelector('.dk-res').value, 10), fps: parseInt(dlg.querySelector('.dk-fps').value, 10), subtitles: dlg.querySelector('.dk-sub').checked });
      });
    });
  }

  function exportMp4(session, P) {
    if (!window.AiChatVideoExport) { return Promise.reject(new Error('the video export script is not loaded')); }
    return askMp4Options().then(function (opt) {
      if (!opt) { throw new Error('已取消匯出'); }
      return prepareAll(session, P).then(function () {
        P.step(1, '正在設定編碼器與磁碟暫存…');
        var deck = session.deck, tl = session.tl, w = opt.width, h = Math.round(w * 9 / 16), fps = opt.fps;
        var canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
        var ctx = canvas.getContext('2d');
        var info = session.info({ width: w, height: h, subtitles: opt.subtitles });
        var frames = Math.max(1, Math.ceil(tl.total * fps));
        var audio = session.audioSource();   // produced chunk by chunk while encoding -- never one big array
        var started = Date.now();
        // an export shows the stage's default camera, not wherever the viewer last dragged it
        var stage = session.stage3d, savedView = stage ? Object.assign({}, stage.view) : null;
        if (stage) { stage.resetView(); }
        function restoreView() { if (stage && savedView) { Object.assign(stage.view, savedView); } }
        // The file is written to the browser's private disk storage while it is encoded (a 30 minute video is ~1 GB, far too much to
        // hold in memory); the bitrate is lower for 720p so a long deck stays a sane size.
        var options = { stream: true, bitrate: w >= 1920 ? 5000000 : 2500000 };
        if (audio) { options.audio = audio; }
        return window.AiChatVideoExport.encodeCanvasFramesToMp4(canvas, frames, fps, function (i) {
          P.check();
          Core.renderFrame(ctx, deck, tl, i / fps, info);
        }, function (done, total) {
          var sec = done / fps;
          P.frac(done / total, '編碼影格 ' + done + ' / ' + total + '(影片 ' + fmtTime(sec) + ' / ' + fmtTime(total / fps) + ')· 請保持此分頁開啟');
        }, options).then(function (result) {
          restoreView();
          P.step(2, '正在存成檔案並下載…');
          download(result.blob, safeName(deck.deck.title) + '.mp4');
          if (result.cleanup) { setTimeout(result.cleanup, 20 * 60 * 1000); }
          var silent = session.preps.filter(function (p) { return !p.audio && p.timing && !p.timing.silent; }).length;
          return 'MP4 已匯出' + (result.streamed ? '' : '(此瀏覽器沒有磁碟暫存,影片是在記憶體中組成的;很長的簡報請改用 Chrome / Edge)') +
            (!audio ? '(沒有旁白音軌:此環境沒有語音)' : (result.audioDropped ? '(此瀏覽器無法編碼音訊,影片沒有聲音)' : '')) + (silent && audio ? ';' + silent + ' 頁旁白失敗,該頁靜音' : '');
        }, function (err) { restoreView(); throw err; });
      });
    });
  }

  // ------------------------------------------------------------------ PPTX
  function canvasToDataUri(canvas) { return canvas.toDataURL('image/png'); }

  function exportPptx(session, P) {
    var kit = window.AiChatMarkdown && window.AiChatMarkdown.pptxKit;
    if (!kit) { return Promise.reject(new Error('the PPTX kit is not available')); }
    return prepareAll(session, P).then(function () { P.step(1, '正在載入 PPTX 元件…'); return kit.ensureLibs(); }).then(function () {
      var deck = session.deck, pres = new window.PptxGenJS();
      pres.defineLayout({ name: 'AI_CHAT_16X9', width: kit.slideW, height: kit.slideH });
      pres.layout = 'AI_CHAT_16X9';
      pres.title = deck.deck.title;
      var k = kit.slideW / Core.W; // design px -> inches
      var lastChapter = -1;
      var stageInfo = session.info({ width: 1920, height: 1080, subtitles: false });
      var stageSlides = 0;

      // A slide on the 3D stage: the stage as it looks NOW (the viewer's current camera angle, the model at the end of its animation)
      // is the slide background, the flat layer (tables, images, 2D overlays, group items) a transparent picture over it, and the
      // title / bullets stay native, editable text.
      function addStageSlide(slide) {
        var bgCanvas = document.createElement('canvas'); bgCanvas.width = 1920; bgCanvas.height = 1080;
        Core.renderStageSnapshot(bgCanvas.getContext('2d'), deck, slide, stageInfo, 1920, 1080);
        var s = pres.addSlide();
        s.background = { data: bgCanvas.toDataURL('image/jpeg', 0.92) };
        var layer = document.createElement('canvas'); layer.width = 1920; layer.height = 1080;
        Core.renderStageFlatLayer(layer.getContext('2d'), slide, stageInfo);
        if (slide.visual) { s.addImage({ data: canvasToDataUri(layer), x: 0, y: 0, w: kit.slideW, h: kit.slideH }); }
        var white = 'FFFFFF';
        if (slide.layout === 'title' || slide.layout === 'topic') {
          s.addText(slide.title, { x: 0.8, y: 2.4, w: kit.slideW - 1.6, h: 1.6, fontSize: 40, bold: true, color: white, fontFace: kit.font, align: 'center', valign: 'middle', shadow: { type: 'outer', color: '000000', blur: 6, offset: 2, angle: 45, opacity: 0.8 } });
          if (slide.subtitle) { s.addText(slide.subtitle, { x: 0.8, y: 4.1, w: kit.slideW - 1.6, h: 0.6, fontSize: 20, bold: true, color: kit.colorAccent, fontFace: kit.font, align: 'center' }); }
        } else {
          s.addText(slide.title, { x: 0.3, y: 0.2, w: 9.5, h: 0.7, fontSize: 26, bold: true, color: white, fontFace: kit.font, valign: 'middle', fill: { color: '082238', transparency: 30 } });
          if (slide.bullets.length) {
            s.addText(slide.bullets.map(function (b) { return { text: b, options: { bullet: { code: '25CF', color: kit.colorAccent }, breakLine: true, paraSpaceAfter: 8 } }; }),
              { x: 0.3, y: 1.15, w: slide.visual ? 3.9 : 8, h: Math.min(4.6, 0.55 * slide.bullets.length + 0.5), fontSize: 18, color: white, fontFace: kit.font, valign: 'top', fill: { color: '082238', transparency: 35 } });
          }
        }
        stageSlides++;
        return s;
      }

      deck.slides.forEach(function (slide) {
        P.check();
        P.frac(slide.index / deck.slides.length, '組合第 ' + (slide.index + 1) + ' / ' + deck.slides.length + ' 頁:' + slide.title);
        var prep = session.preps[slide.index];
        var before = pres.slides.length;
        if (Core.stageSlide(deck, slide, stageInfo) && !Core.viewportSlide(slide)) {
          if (slide.chapter !== lastChapter && deck.chapters[slide.chapter].first === slide.index && slide.layout !== 'title' && slide.layout !== 'topic') { kit.addTopicSlide(pres, slide.chapterTitle); before = pres.slides.length; }
          try { addStageSlide(slide); } catch (e) { console.warn('[deck] pptx stage slide: ' + (e && e.message || e)); }
        }
        else if (slide.layout === 'title') { kit.addTitleSlide(pres, slide.title, slide.subtitle || (deck.deck.title !== slide.title ? deck.deck.title : ' ')); }
        else if (slide.layout === 'topic') { kit.addTopicSlide(pres, slide.title); }
        else {
          // a chapter divider the first time a chapter starts (the deck's chapters become the template's topic slides)
          if (slide.chapter !== lastChapter && deck.chapters[slide.chapter].first === slide.index) { kit.addTopicSlide(pres, slide.chapterTitle); }
          var s = pres.addSlide(), bg = kit.assetSource('pptxContentBackground');
          if (bg) { s.background = bg; }
          s.addText(slide.title, { x: kit.contentHeader.x, y: kit.contentHeader.y, w: kit.contentHeader.w, h: kit.contentHeader.h, fontSize: 28, bold: true, color: kit.colorHeading, fontFace: kit.font, valign: 'middle' });
          var a = Core.GEO.area, split = slide.layout === 'split';
          if (slide.bullets.length) {
            s.addText(slide.bullets.map(function (b) { return { text: b, options: { bullet: { code: '25CF', color: kit.colorAccent }, breakLine: true, paraSpaceAfter: 10 } }; }),
              { x: a.x * k, y: a.y * k, w: (split ? 790 : a.w) * k, h: a.h * k, fontSize: 20, color: kit.colorBody, fontFace: kit.font, valign: 'top' });
          }
          var v = slide.visual;
          if (v) {
            var r = Core.visualRect(split ? 'split' : 'visual');
            if (v.kind === 'table') {
              var head = v.header.map(function (h) { return { text: String(h), options: { bold: true, color: 'FFFFFF', fill: { color: kit.colorHeading }, fontFace: kit.font, fontSize: 14 } }; });
              var rows = v.rows.map(function (row) { return row.map(function (c) { return { text: String(c), options: { color: kit.colorBody, fontFace: kit.font, fontSize: 13 } }; }); });
              s.addTable([head].concat(rows), { x: r.x * k, y: r.y * k, w: r.w * k, border: { type: 'solid', color: 'D0D0D0', pt: 0.5 }, autoPage: false });
            } else if (v.kind === 'quiz' && window.AiChatDeckQuiz) {
              // PPTX cannot interact: the card becomes plain text -- the question and options, and, if the viewer answered, "你的回答" and
              // "我們回應:" (what the answer key or the AI grader said), so the answers travel with the file
              var sm = window.AiChatDeckQuiz.summary(v, prep.visual && prep.visual.quiz && prep.visual.quiz.state), runs = [];
              function line(text, o) { runs.push({ text: text, options: Object.assign({ breakLine: true, fontFace: kit.font, color: kit.colorBody, fontSize: 16 }, o || {}) }); }
              line(sm.label, { color: kit.colorAccent, bold: true, fontSize: 14 });
              line(sm.question, { color: kit.colorHeading, bold: true, fontSize: 22, paraSpaceAfter: 8 });
              sm.options.forEach(function (o) { line(o, { fontSize: 18 }); });
              if (sm.answered) {
                line(' ', { fontSize: 8 });
                line('你的回答', { bold: true, color: kit.colorHeading, fontSize: 16 });
                line(sm.yours || '(沒有回答)', { fontSize: 16 });
                line('我們回應:' + (sm.score ? '(' + sm.score + ')' : ''), { bold: true, color: kit.colorAccent, fontSize: 16 });
                line(sm.reply || '', { fontSize: 16 });
              }
              s.addText(runs, { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k, valign: 'top', fit: 'shrink' });
            } else if (v.kind === 'widget') {
              // an AI-written widget cannot run in PPTX: what it is (its fallback text) and what the viewer got out of it
              var wst = prep.visual && prep.visual.widget && prep.visual.widget.state || {}, wr = [], res = wst.result;
              function wline(text, o) { wr.push({ text: text, options: Object.assign({ breakLine: true, fontFace: kit.font, color: kit.colorBody, fontSize: 18 }, o || {}) }); }
              wline('互動小工具' + (v.title ? ' · ' + v.title : ''), { color: kit.colorAccent, bold: true, fontSize: 14 });
              wline(v.fallback || '', { fontSize: 20, paraSpaceAfter: 8 });
              if (res || wst.summary) {
                wline(' ', { fontSize: 8 });
                wline('你的結果', { bold: true, color: kit.colorHeading });
                wline((res ? res.got + ' / ' + res.points + ' 分' : '') + (wst.summary ? (res ? '\n' : '') + wst.summary : ''));
                if (res && res.feedback) { wline('我們回應:', { bold: true, color: kit.colorAccent }); wline(res.feedback); }
              }
              s.addText(wr, { x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k, valign: 'top', fit: 'shrink' });
            } else {
              var snap = document.createElement('canvas'); snap.width = Math.round(r.w); snap.height = Math.round(r.h);
              var sctx = snap.getContext('2d');
              sctx.setTransform(1, 0, 0, 1, -r.x, -r.y);
              try {
                Core.renderVisualSnapshot(sctx, slide, prep, r);
                // a 3D model: the picture is the view through the viewport at the camera angle the viewer has now, over the flat items
                if (Core.stageSlide(deck, slide, stageInfo)) {
                  var vp = Core.viewportOf(slide, prep), vc = document.createElement('canvas'); vc.width = Math.round(vp.w); vc.height = Math.round(vp.h);
                  Core.renderViewportSnapshot(vc.getContext('2d'), deck, slide, stageInfo, vc.width, vc.height);
                  sctx.setTransform(1, 0, 0, 1, 0, 0); sctx.clearRect(0, 0, snap.width, snap.height);
                  sctx.drawImage(vc, vp.x - r.x, vp.y - r.y, vp.w, vp.h);
                  sctx.setTransform(1, 0, 0, 1, -r.x, -r.y);
                  Core.renderStageFlatLayer(sctx, slide, stageInfo);
                }
                s.addImage({ data: canvasToDataUri(snap), x: r.x * k, y: r.y * k, w: r.w * k, h: r.h * k }); } catch (e) { console.warn('[deck] pptx visual: ' + e.message); }
            }
          }
        }
        // narration + notes of every slide kind go into the speaker notes of the slide just added
        var added = pres.slides[pres.slides.length - 1];
        if (added && pres.slides.length > before && (slide.narration || slide.notes) && added.addNotes) { added.addNotes([slide.narration, slide.notes].filter(Boolean).join('\n\n')); }
        lastChapter = slide.chapter;
      });
      P.step(2, '正在產生 .pptx 檔並下載…');
      return pres.writeFile({ fileName: safeName(deck.deck.title) + '.pptx' });
    }).then(function () { return 'PPTX 已匯出(動畫與轉場不會保留;3D 舞台頁保留當下角度的截圖;旁白在備忘稿)'; });
  }

  // ------------------------------------------------------------------ yaml / subtitles / bundle
  function exportYaml(session) {
    download(new Blob([session.raw], { type: 'application/x-yaml' }), safeName(session.deck.deck.title) + '.deck.yaml');
    return Promise.resolve('已下載原始描述檔');
  }

  function exportSubtitles(session, P, format) {
    return prepareAll(session, P).then(function () {
      P.step(1, '正在產生字幕…');
      var text = Core.buildSubtitleFile(session.deck, session.tl, session.preps.map(function (p) { return p.timing; }), format);
      download(new Blob([text], { type: 'text/plain;charset=utf-8' }), safeName(session.deck.deck.title) + '.' + format);
      return '字幕已匯出(' + format + ')';
    });
  }

  function exportZip(session, P) {
    var kit = window.AiChatMarkdown && window.AiChatMarkdown.pptxKit;
    if (!kit) { return Promise.reject(new Error('the zip library loader is not available')); }
    return prepareAll(session, P).then(function () { P.step(1, '正在載入壓縮元件…'); return kit.ensureLibs(); }).then(function () {
      P.step(1, '正在加入描述檔、字幕與每頁旁白音檔…');
      var zip = new window.JSZip(), name = safeName(session.deck.deck.title);
      zip.file(name + '.deck.yaml', session.raw);
      var timings = session.preps.map(function (p) { return p.timing; });
      zip.file(name + '.srt', Core.buildSubtitleFile(session.deck, session.tl, timings, 'srt'));
      zip.file(name + '.vtt', Core.buildSubtitleFile(session.deck, session.tl, timings, 'vtt'));
      session.preps.forEach(function (p, i) { if (p.audio) { zip.file('audio/' + (i < 9 ? '0' : '') + (i + 1) + '-' + session.deck.slides[i].id + '.mp3', p.audio.mp3); } });
      zip.file('README.txt', 'media-presentation bundle\n' + name + '.deck.yaml is the source description (open it again in the chat to replay / re-export).\naudio/*.mp3 is the narration of each slide; the .srt/.vtt are the subtitles on the same timeline.\n');
      P.step(2, '正在壓縮…');
      return zip.generateAsync({ type: 'blob' }, function (meta) { P.frac(meta.percent / 100, '壓縮 ' + Math.round(meta.percent) + '%'); });
    }).then(function (blob) { download(blob, safeName(session.deck.deck.title) + '.deck.zip'); return '封包已匯出'; });
  }

  // The whole presentation as one file that opens again (ai_chat_deck_pack.js): description with relative asset paths, the assets, the
  // narration, the subtitles, and the viewer's answers / scores.
  function exportPack(session, P) {
    var Pack = window.AiChatDeckPack, kit = window.AiChatMarkdown && window.AiChatMarkdown.pptxKit, Quiz = window.AiChatDeckQuiz;
    if (!Pack || !kit) { return Promise.reject(new Error('the pack script is not loaded')); }
    var name = safeName(session.deck.deck.title), collected;
    return prepareAll(session, P).then(function () {
      P.step(1, '正在收集簡報用到的圖片與檔案…');
      return Promise.all([kit.ensureLibs(), window.AiChat2D.ensureJsYamlLoaded()]);
    }).then(function () {
      return Pack.collectAssets(window.jsyaml.load(session.raw), window.AiChatDeck._internal.fetchBlob, function (done, total) { P.frac(done / Math.max(total, 1), '檔案 ' + done + ' / ' + total); });
    }).then(function (col) {
      collected = col; P.step(2, '正在加入描述檔、旁白、字幕與作答紀錄…');
      var zip = new window.JSZip(), timings = session.preps.map(function (p) { return p.timing; });
      zip.file('deck.yaml', window.jsyaml.dump(col.doc, { lineWidth: -1 }));
      col.files.forEach(function (f) { zip.file(f.path, f.blob); });
      session.preps.forEach(function (p, i) { if (p.audio) { zip.file('audio/' + (i < 9 ? '0' : '') + (i + 1) + '-' + session.deck.slides[i].id + '.mp3', p.audio.mp3); } });
      zip.file('subtitles.srt', Core.buildSubtitleFile(session.deck, session.tl, timings, 'srt'));
      zip.file('subtitles.vtt', Core.buildSubtitleFile(session.deck, session.tl, timings, 'vtt'));
      // what the viewer answered: restored when the pack is opened, and readable as it is ("你的回答" / "我們回應:")
      var items = {}, readable = [], per = {}, tot = { got: 0, max: 0 };
      session.quizItems().forEach(function (it) {
        var n = per[it.slide] || 0, id = session.deck.slides[it.slide].id; per[it.slide] = n + 1;
        if (!it.pv) { return; }
        var st = it.v.kind === 'quiz' ? it.pv.quiz.state : it.pv.widget.state, rec = {};
        Object.keys(st).forEach(function (k) { if (k !== '_r' && k !== 'busy') { rec[k] = st[k]; } });
        items[id + '#' + n] = rec;
        if (Quiz) {
          tot.max += Quiz.points(it.v); if (it.result) { tot.got += it.result.got; }
          var sm = it.v.kind === 'quiz' ? Quiz.summary(it.v, st) : { label: '互動小工具', question: it.v.fallback, yours: st.summary || '', reply: it.result ? it.result.feedback : '', score: it.result ? it.result.got + ' / ' + it.result.points + ' 分' : '', answered: !!it.result };
          readable.push({ slide: it.slide + 1, title: session.deck.slides[it.slide].title, label: sm.label, question: sm.question, answered: sm.answered, 你的回答: sm.yours, 我們回應: sm.reply, 得分: sm.score });
        }
      });
      // the last screen of every terminal, with its colours (what MP4 / PPTX show; a reopened pack paints it back, like a refreshed terminal)
      var terminals = {}, tper = {};
      session.terminalItems().forEach(function (it) {
        var n = tper[it.slide] || 0, id = session.deck.slides[it.slide].id; tper[it.slide] = n + 1;
        var snap = it.tv.handle ? it.tv.handle.snapshot(true) : it.tv.saved;
        if (snap) { terminals[id + '#' + n] = snap; }
      });
      zip.file('results.json', JSON.stringify({ version: 1, total: tot, items: items, terminals: terminals, readable: readable }, null, 1));
      zip.file('manifest.json', JSON.stringify({ format: Pack.FORMAT, version: Pack.VERSION, title: session.deck.deck.title, slides: session.deck.slides.length, created: new Date().toISOString(), warnings: collected.warnings }, null, 1));
      zip.file('README.txt', 'media-presentation pack (' + Pack.PACK_EXT + ')\nOpen it again: drop this file into the AI chat (or attach it) and the presentation plays from the pack alone.\ndeck.yaml = the description, assets/ = pictures and files it uses, audio/ = narration, results.json = answers and scores.\n' + (collected.warnings.length ? '\nNot included:\n' + collected.warnings.join('\n') + '\n' : ''));
      P.step(3, '正在壓縮…');
      return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' }, function (meta) { P.frac(meta.percent / 100, '壓縮 ' + Math.round(meta.percent) + '%'); });
    }).then(function (blob) { download(blob, name + Pack.PACK_EXT); return '簡報封包已匯出' + (collected.warnings.length ? '(' + collected.warnings.length + ' 個檔案無法收進去,見封包內 README.txt)' : ''); });
  }

  // run(format, session, box, onText): shows the progress card inside `box` (the player), runs the export, resolves with the final message.
  function run(format, session, box, onText) {
    if (format === 'yaml') { return exportYaml(session); }
    if (!STEPS[format]) { return Promise.reject(new Error('unknown export format ' + format)); }
    var P = makeProgress(box, TITLES[format], STEPS[format], onText), job;
    switch (format) {
      case 'mp4': job = exportMp4(session, P); break;
      case 'pptx': job = exportPptx(session, P); break;
      case 'pack': job = exportPack(session, P); break;
      case 'srt': case 'vtt': job = exportSubtitles(session, P, format); break;
      default: job = exportZip(session, P);
    }
    return Promise.race([job, P.forced]).then(function (msg) { P.done(msg); return msg; }, function (err) { P.fail(P.isCancelled() ? '已取消匯出' : '失敗:' + (err && err.message || err)); throw err; });
  }

  window.AiChatDeckExport = { run: run, STEPS: STEPS, _internal: { safeName: safeName } };
})(window);
