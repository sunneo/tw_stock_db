// Configure > Presentation template: edit the look of every /media-presentation slide -- colours, fonts, the four pictures and the layout of each
// kind of slide -- with a live preview drawn by the real deck renderer (AiChatDeckCore). The template lives in two folders of the AI service account's
// workspace: "current" (what decks use, what is edited here) and "default" (what "reset" goes back to). The server side is
// AiChatDeckTemplateController / RedmineAiChat::DeckTemplateStore.
//
// Not a part of the plugin settings <form>: no element here has a name= attribute, every action talks to its own endpoint.
(function ($) {
  'use strict';

  var Core = window.AiChatDeckCore;
  var app, S = { data: null, draft: null, busy: false };
  var LANG = /^zh/i.test(document.documentElement.lang || navigator.language || '') ? 'zh' : 'en';
  var T = {
    zh: {
      loading: '載入簡報樣板中…', notConfigured: '還不能使用簡報樣板:請先到「一般」分頁指定「工作區專案」與「服務帳號」,並按下設定頁的儲存,再回到這裡。目前缺少:',
      missing: { service_account: '服務帳號', project: '工作區專案' }, usingBuiltin: '在那之前,簡報一律使用內建的樣板(預設)。',
      save: '儲存目前樣板', reset: '退回預設', promote: '把目前設為新的預設', exportJson: '匯出 JSON', importJson: '匯入 JSON…',
      saved: '已儲存。新開的簡報頁面會套用。', resetDone: '已用預設資料夾覆蓋目前樣板。', promoted: '已把目前樣板複製成新的預設。',
      confirmReset: '確定要退回預設?你對「目前樣板」做的所有修改(含上傳的圖片)都會被預設資料夾的內容取代。', confirmPromote: '確定把目前樣板設為新的預設?之後「退回預設」會回到現在這個樣子,原本的預設會被覆蓋。',
      images: '圖片', colors: '顏色', fonts: '字型', layout: '版面', preview: '預覽(即時,尚未儲存的修改也會顯示)',
      upload: '上傳圖片…', noImage: '不使用圖片', restoreImage: '還原預設圖片', current: '目前', def: '預設', none: '(無)', builtin: '(內建)',
      font: '畫面與影片的字型(CSS font-family)', pptxFont: 'PPTX 的字型(單一字型名稱)', def2: '預設', undo: '還原', changed: '與預設不同',
      uploading: '上傳中…', saving: '儲存中…', imageHint: '建議 1920×1080 的 PNG / JPEG / WebP,每張最大 4 MB。標誌通常是透明背景的 PNG。',
      layoutHint: '座標與大小以 1920×1080 的設計空間計算(PPTX 匯出時 144 單位 = 1 英寸)。數字旁的藍色標題代表與預設不同,按「還原」回到預設值。',
      importFail: '不是有效的樣板 JSON:', exportName: 'presentation-template.json',
      roles: { titleBg: '標題頁背景', topicBg: '章節頁背景', contentBg: '內容頁背景', logo: '標誌(標題頁)' },
      colorNames: { heading: '標題文字(內容頁)/表頭底色', body: '內文', accent: '強調色(要點圓點、色條)', soft: '淡灰(分隔線、框)', white: '白(表頭文字)', dark: '深色底(無背景圖時)', stripe: '表格斑馬紋', contentBg: '內容頁底色(無背景圖時)', titleText: '標題頁/章節頁文字', subtitleBar: '字幕條底色(可半透明 rgba)', subtitleText: '字幕文字' },
      sections: { logo: '標誌位置(標題頁)', title: '標題頁', topic: '章節頁', header: '內容頁標題列', contentBar: '內容頁頂端色條', area: '內容區', split: '左右分欄', bullets: '要點', subtitle: '字幕條' },
      keys: { x: '左', y: '上', w: '寬', h: '高', size: '字級', minSize: '最小字級', subtitleSize: '副標字級', topBar: '頂端色條高', rule: '底線', labelSize: '章節標籤字級', labelY: '章節標籤 Y', bulletsW: '要點欄寬', visualX: '視覺區 X', visualW: '視覺區寬', gap: '間距', dot: '圓點半徑', radius: '圓角' }
    },
    en: {
      loading: 'Loading the presentation template...', notConfigured: 'The presentation template is not available yet: choose the "Workspace project" and the "Service account" in the General tab and save the settings first. Missing: ',
      missing: { service_account: 'service account', project: 'workspace project' }, usingBuiltin: 'Until then every deck uses the built-in template (default).',
      save: 'Save current template', reset: 'Reset to default', promote: 'Make current the new default', exportJson: 'Export JSON', importJson: 'Import JSON...',
      saved: 'Saved. Newly opened presentation pages use it.', resetDone: 'The current template was replaced by the default folder.', promoted: 'The current template was copied to the default folder.',
      confirmReset: 'Reset to the default? Everything you changed in the current template (pictures included) is replaced by the default folder.', confirmPromote: 'Make the current template the new default? "Reset" will then return to this look; the old default is overwritten.',
      images: 'Pictures', colors: 'Colours', fonts: 'Fonts', layout: 'Layout', preview: 'Preview (live, unsaved edits included)',
      upload: 'Upload...', noImage: 'No picture', restoreImage: 'Restore default picture', current: 'Current', def: 'Default', none: '(none)', builtin: '(built-in)',
      font: 'Font of the picture and the video (CSS font-family)', pptxFont: 'Font of the PPTX (one font name)', def2: 'default', undo: 'Undo', changed: 'differs from the default',
      uploading: 'Uploading...', saving: 'Saving...', imageHint: 'Best 1920x1080 PNG / JPEG / WebP, 4 MB at most. A logo is usually a PNG with a transparent background.',
      layoutHint: 'Positions and sizes are in the 1920x1080 design space (144 units = 1 inch in the PPTX export). A blue label means the value differs from the default; Undo goes back to it.',
      importFail: 'Not a valid template JSON: ', exportName: 'presentation-template.json',
      roles: { titleBg: 'Title slide background', topicBg: 'Chapter slide background', contentBg: 'Content slide background', logo: 'Logo (title slide)' },
      colorNames: { heading: 'Heading text (content) / table header', body: 'Body text', accent: 'Accent (bullet dots, bars)', soft: 'Light grey (lines, frames)', white: 'White (table header text)', dark: 'Dark fill (no background picture)', stripe: 'Table stripe', contentBg: 'Content fill (no background picture)', titleText: 'Title / chapter slide text', subtitleBar: 'Subtitle bar (rgba allowed)', subtitleText: 'Subtitle text' },
      sections: { logo: 'Logo position (title slide)', title: 'Title slide', topic: 'Chapter slide', header: 'Content slide header', contentBar: 'Content slide top bar', area: 'Content area', split: 'Left / right split', bullets: 'Bullets', subtitle: 'Subtitle bar' },
      keys: { x: 'Left', y: 'Top', w: 'Width', h: 'Height', size: 'Font size', minSize: 'Min font size', subtitleSize: 'Subtitle size', topBar: 'Top bar height', rule: 'Rule', labelSize: 'Chapter label size', labelY: 'Chapter label Y', bulletsW: 'Bullets width', visualX: 'Visual X', visualW: 'Visual width', gap: 'Gap', dot: 'Dot radius', radius: 'Corner radius' }
    }
  };
  // behind the reverse proxy a root-relative url must carry the mount prefix (see ai_chat_mount_root.js); a no-op on the normal domain
  function rooted(u) { return typeof window.AiChatRooted === 'function' ? window.AiChatRooted(u) : u; }
  function t(k) { return (T[LANG][k] != null ? T[LANG][k] : T.en[k]); }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function csrf() { var m = document.querySelector('meta[name="csrf-token"]'); return m ? m.content : ''; }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function getPath(o, path) { return path.reduce(function (a, k) { return a == null ? a : a[k]; }, o); }
  function setPath(o, path, v) { var a = o; path.slice(0, -1).forEach(function (k) { a = a[k]; }); a[path[path.length - 1]] = v; }
  function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

  function api(method, url, body, isForm) {
    url = rooted(url);
    var opts = { method: method, credentials: 'same-origin', headers: { Accept: 'application/json', 'X-CSRF-Token': csrf() } };
    if (body !== undefined) { if (isForm) { opts.body = body; } else { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); } }
    return fetch(url, opts).then(function (r) { return r.json().then(function (j) { if (!r.ok) { var e = new Error(j && j.error || ('HTTP ' + r.status)); e.status = r.status; throw e; } return j; }); });
  }

  function say(text, kind) { var s = app.querySelector('.dt-status'); if (s) { s.textContent = text || ''; s.className = 'dt-status' + (kind ? ' ' + kind : ''); } }

  // ------------------------------------------------------------------ load / render
  function load() {
    return api('GET', app.dataset.url).then(function (d) { S.data = d; S.draft = d.configured ? clone(d.current.template) : null; render(); }, function (e) { app.textContent = 'Error: ' + e.message; });
  }

  function render() {
    var d = S.data;
    app.textContent = '';
    if (!d.configured) {
      var w = el('div', 'dt-warn');
      w.appendChild(el('strong', null, t('notConfigured') + (d.missing || []).map(function (m) { return t('missing')[m] || m; }).join(', ')));
      w.appendChild(el('div', null, t('usingBuiltin')));
      app.appendChild(w);
      return;
    }
    var bar = el('div', 'dt-bar');
    [['save', save, true], ['reset', reset], ['promote', promote], ['exportJson', exportJson], ['importJson', importJson]].forEach(function (b) {
      var btn = el('button', b[2] ? 'button-small' : 'button-small', t(b[0])); btn.type = 'button'; btn.addEventListener('click', b[1]); bar.appendChild(btn);
    });
    bar.appendChild(el('span', 'dt-status'));
    app.appendChild(bar);
    var cols = el('div', 'dt-cols'), form = el('div', 'dt-form'), prev = el('div', 'dt-preview');
    form.appendChild(imagesBox()); form.appendChild(colorsBox()); form.appendChild(fontsBox()); form.appendChild(layoutBox());
    prev.appendChild(el('h4', null, t('preview')));
    ['title', 'topic', 'content', 'split'].forEach(function (k) { var c = document.createElement('canvas'); c.width = 960; c.height = 540; c.dataset.kind = k; prev.appendChild(c); });
    cols.appendChild(form); cols.appendChild(prev); app.appendChild(cols);
    drawPreview();
  }

  function box(title) { var f = el('fieldset', 'box'); f.appendChild(el('legend', null, title)); return f; }

  // a field shows a "differs from the default" mark and an Undo to the DEFAULT FOLDER's value
  function field(label, path, input, defaultValue) {
    var wrap = el('div', 'dt-field'), cur = getPath(S.draft, path), changed = !same(cur, defaultValue);
    if (changed) { wrap.className += ' changed'; wrap.title = t('changed'); }
    var l = el('label', null, label); wrap.appendChild(l); wrap.appendChild(input);
    var hint = el('span', 'dt-def', t('def2') + ': ' + (typeof defaultValue === 'object' ? JSON.stringify(defaultValue) : defaultValue));
    if (changed) { var u = el('button', 'dt-undo', '↺ ' + t('undo')); u.type = 'button'; u.addEventListener('click', function () { setPath(S.draft, path, clone(defaultValue)); render(); }); hint.appendChild(u); }
    wrap.appendChild(hint);
    return wrap;
  }

  function defaults() { return S.data.default.template; }

  function imagesBox() {
    var b = box(t('images')), cur = S.draft.images;
    b.appendChild(el('p', 'ai-chat-help', t('imageHint')));
    S.data.schema.imageRoles.forEach(function (role) {
      var row = el('div', 'dt-img'), info = S.data.current.images[role], mode = cur[role];
      row.appendChild(el('div', 'role', t('roles')[role] || role));
      var th = el('div', 'thumb'); var url = mode === 'none' ? null : rooted(S.data.current.imageUrls[role] || S.data.builtinImages[role]);
      if (url) { th.style.backgroundImage = 'url("' + url + '")'; } else { th.textContent = t('none'); }
      var cap = el('div'); cap.appendChild(th); cap.appendChild(el('div', 'dt-def', t('current') + (info.source === 'builtin' ? ' ' + t('builtin') : '')));
      row.appendChild(cap);
      var dth = el('div', 'thumb'), durl = defaults().images[role] === 'none' ? null : rooted(S.data.default.imageUrls[role] || S.data.builtinImages[role]);
      if (durl) { dth.style.backgroundImage = 'url("' + durl + '")'; } else { dth.textContent = t('none'); }
      var dcap = el('div'); dcap.appendChild(dth); dcap.appendChild(el('div', 'dt-def', t('def'))); row.appendChild(dcap);
      var file = document.createElement('input'); file.type = 'file'; file.accept = 'image/png,image/jpeg,image/webp'; file.style.display = 'none';
      file.addEventListener('change', function () { if (file.files[0]) { upload(role, file.files[0]); } });
      var up = el('button', null, t('upload')); up.type = 'button'; up.addEventListener('click', function () { file.click(); });
      var none = el('button', null, t('noImage')); none.type = 'button'; none.addEventListener('click', function () { S.draft.images[role] = 'none'; render(); });
      var rest = el('button', null, t('restoreImage')); rest.type = 'button'; rest.addEventListener('click', function () { restoreImage(role); });
      var btns = el('div'); [up, none, rest, file].forEach(function (x) { btns.appendChild(x); btns.appendChild(document.createTextNode(' ')); });
      row.appendChild(btns); b.appendChild(row);
    });
    return b;
  }

  function colorsBox() {
    var b = box(t('colors')), g = el('div', 'dt-grid');
    S.data.schema.colors.forEach(function (k) {
      var path = ['colors', k], val = S.draft.colors[k], inp;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) { inp = document.createElement('input'); inp.type = 'color'; inp.value = val; }
      else { inp = document.createElement('input'); inp.type = 'text'; inp.value = val; }
      inp.addEventListener('input', function () { setPath(S.draft, path, inp.value); drawPreview(); });
      inp.addEventListener('change', function () { render(); });
      g.appendChild(field(t('colorNames')[k] || k, path, inp, getPath(defaults(), path)));
    });
    b.appendChild(g); return b;
  }

  function fontsBox() {
    var b = box(t('fonts')), g = el('div', 'dt-grid');
    [['font', 'font'], ['pptxFont', 'pptxFont']].forEach(function (p) {
      var inp = document.createElement('input'); inp.type = 'text'; inp.style.width = '420px'; inp.value = S.draft[p[0]];
      inp.addEventListener('input', function () { S.draft[p[0]] = inp.value; drawPreview(); });
      inp.addEventListener('change', function () { render(); });
      g.appendChild(field(t(p[1]), [p[0]], inp, defaults()[p[0]]));
    });
    b.appendChild(g); return b;
  }

  function numberInput(path, lo, hi) {
    var inp = document.createElement('input'); inp.type = 'number'; inp.min = lo; inp.max = hi; inp.step = 1; inp.value = getPath(S.draft, path);
    inp.addEventListener('input', function () { var v = parseFloat(inp.value); if (isFinite(v)) { setPath(S.draft, path, v); drawPreview(); } });
    inp.addEventListener('change', function () { render(); });
    return inp;
  }

  function layoutBox() {
    var b = box(t('layout')), sc = S.data.schema;
    b.appendChild(el('p', 'ai-chat-help', t('layoutHint')));
    Object.keys(sc.sections).forEach(function (sec) {
      var f = el('fieldset', 'box'), g = el('div', 'dt-grid');
      f.appendChild(el('legend', null, t('sections')[sec] || sec));
      sc.sections[sec].forEach(function (row) {
        var k = row[0], path = [sec, k];
        g.appendChild(field((t('keys')[k] || k), path, numberInput(path, row[1], row[2]), getPath(defaults(), path)));
      });
      var nested = sc.nested[sec];
      if (nested) {
        sc.rect.forEach(function (row) {
          var path = [sec, nested, row[0]];
          g.appendChild(field((t('keys')[nested] || nested) + ' ' + (t('keys')[row[0]] || row[0]), path, numberInput(path, row[1], row[2]), getPath(defaults(), path)));
        });
      }
      f.appendChild(g); b.appendChild(f);
    });
    return b;
  }

  // ------------------------------------------------------------------ preview (the real renderer)
  var imgCache = {};
  function loadImg(url) {
    if (!url) { return Promise.resolve(null); }
    if (!imgCache[url]) { imgCache[url] = new Promise(function (res) { var i = new Image(); i.onload = function () { res(i); }; i.onerror = function () { res(null); }; i.src = url; }); }
    return imgCache[url];
  }
  var SAMPLE = { deck: { title: 'Template preview', lang: 'zh-TW' }, chapters: [{ title: 'Chapter', slides: [
    { title: '簡報標題 Presentation Title', subtitle: '副標題 Subtitle', layout: 'title', narration: '這是標題頁的字幕條預覽。' },
    { title: '章節標題 Chapter Title', layout: 'topic', narration: '這是章節頁的字幕條預覽。' },
    { title: '內容頁標題 Content slide', bullets: ['第一個要點 First point', '第二個要點 Second point', '第三個要點 Third point'], layout: 'content', narration: '第一句。第二句。第三句。這是內容頁的字幕條預覽。' },
    { title: '左右分欄 Split layout', bullets: ['左邊是要點', '右邊是視覺'], layout: 'split', narration: '一。二。這是分欄頁的字幕條預覽。', visual: { kind: 'table', header: ['項目', '數值'], rows: [['甲', '1'], ['乙', '2'], ['丙', '3']] } }] }] };

  var drawing = 0;
  function drawPreview() {
    if (!Core || !S.draft) { return; }
    var my = ++drawing, tpl = S.draft;
    var urls = {};
    S.data.schema.imageRoles.forEach(function (role) { urls[role] = tpl.images[role] === 'none' ? null : rooted(S.data.current.imageUrls[role] || S.data.builtinImages[role]); });
    Promise.all([loadImg(urls.titleBg), loadImg(urls.topicBg), loadImg(urls.contentBg), loadImg(urls.logo)]).then(function (imgs) {
      if (my !== drawing) { return; }
      var assets = { titleBg: imgs[0], topicBg: imgs[1], contentBg: imgs[2], logo: imgs[3] };
      Core.applyTemplate(tpl);
      var deck = Core.normalize(SAMPLE), timings = deck.slides.map(function (s) { return Core.timingFor(s, 0, 0); }), tl = Core.buildTimeline(deck, timings);
      var info = { width: 960, height: 540, subtitles: true, assets: assets, makeCanvas: function (w, h) { var c = document.createElement('canvas'); c.width = w; c.height = h; return c; },
        preps: deck.slides.map(function (s, k) { return { timing: timings[k], visual: null }; }) };
      var order = { title: 0, topic: 1, content: 2, split: 3 };
      Array.prototype.forEach.call(app.querySelectorAll('.dt-preview canvas'), function (c) {
        var i = order[c.dataset.kind], ctx = c.getContext('2d');
        try { Core.renderFrame(ctx, deck, tl, tl.segs[i].end - 0.05, info); } catch (e) { ctx.fillStyle = '#fff'; ctx.fillText('preview: ' + e.message, 10, 20); }
      });
    });
  }

  // ------------------------------------------------------------------ actions
  function busy(on) { S.busy = on; Array.prototype.forEach.call(app.querySelectorAll('button'), function (b) { b.disabled = on; }); }
  function apply(d, msg) { S.data = d; S.draft = clone(d.current.template); render(); say(msg, 'ok'); }
  function fail(e) { busy(false); say(e.message, 'err'); }

  function save() { busy(true); say(t('saving')); api('PUT', app.dataset.url, { template: S.draft }).then(function (d) { apply(d, t('saved')); }, fail); }
  function reset() { if (!window.confirm(t('confirmReset'))) { return; } busy(true); api('POST', app.dataset.resetUrl).then(function (d) { apply(d, t('resetDone')); }, fail); }
  function promote() { if (!window.confirm(t('confirmPromote'))) { return; } busy(true); api('POST', app.dataset.promoteUrl).then(function (d) { apply(d, t('promoted')); }, fail); }
  function upload(role, file) {
    var fd = new FormData(); fd.append('file', file); busy(true); say(t('uploading'));
    // pictures are stored at once; the other unsaved edits stay in the draft
    var keep = clone(S.draft);
    api('POST', app.dataset.imageUrl.replace('__ROLE__', role), fd, true).then(function (d) { S.data = d; S.draft = keep; S.draft.images[role] = 'file'; render(); say(t('saved'), 'ok'); }, fail);
  }
  function restoreImage(role) {
    busy(true); var keep = clone(S.draft);
    api('POST', app.dataset.imageRestoreUrl.replace('__ROLE__', role)).then(function (d) { S.data = d; S.draft = keep; S.draft.images[role] = d.current.template.images[role]; render(); }, fail);
  }
  function exportJson() {
    var blob = new Blob([JSON.stringify(S.draft, null, 2)], { type: 'application/json' }), a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = t('exportName'); document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
  }
  function importJson() {
    var file = document.createElement('input'); file.type = 'file'; file.accept = '.json,application/json';
    file.addEventListener('change', function () {
      if (!file.files[0]) { return; }
      file.files[0].text().then(function (txt) {
        var o; try { o = JSON.parse(txt); } catch (e) { say(t('importFail') + e.message, 'err'); return; }
        if (!o || typeof o !== 'object' || Array.isArray(o)) { say(t('importFail') + 'not an object', 'err'); return; }
        S.draft = Core.mergeTemplate(S.data.builtin, o); render(); say('');
      });
    });
    file.click();
  }

  $(function () {
    app = document.getElementById('ai-chat-deck-template-app');
    if (app) { load(); }
  });
})(jQuery);
