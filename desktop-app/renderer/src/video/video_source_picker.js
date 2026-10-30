// /edit-video: "where is the video?" -- a picker inside the editor, like the terminal's file-transfer window: this computer, the files of the CHAT (what was attached or generated in it, kept in this browser
// or stored as Redmine attachments), and the File Access (FAP) folders the user authorized. Only the DOM and the three lists live here; opening a chat file is the host's job (host.chatFiles).
//   TwVideoSourcePicker.open({ container, T, mediaKind(name), chatFiles() / storedFiles() -> Promise<[{ name, size?, from, open() -> Promise<File> }]>, fapFolders() -> Promise<[{ label, handle }]>, computer() }) -> Promise<File | null>
(function (root) {
  'use strict';
  function el(tag, cls, text) { var e = root.document.createElement(tag); if (cls) { e.className = cls; } if (text != null) { e.textContent = text; } return e; }
  function css() {
    if (root.document.getElementById('tw-ve-pk-css')) { return; }
    var s = root.document.createElement('style'); s.id = 'tw-ve-pk-css';
    s.textContent = '.tw-ve-pk{position:absolute;inset:0;z-index:5;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center}.tw-ve-pk-box{background:var(--ai-win-bg,#fff);color:var(--ai-win-fg,inherit);border:1px solid #888;border-radius:8px;width:min(560px,92%);max-height:86%;display:flex;flex-direction:column;overflow:hidden}' +
      '.tw-ve-pk-hd{display:flex;gap:6px;align-items:center;padding:6px 8px;border-bottom:1px solid #ccc}.tw-ve-pk-hd button,.tw-ve-pk-body button{border:1px solid #8250df;border-radius:6px;background:transparent;color:inherit;padding:2px 9px;cursor:pointer}.tw-ve-pk-hd button.on{background:#8250df;color:#fff}.tw-ve-pk-hd .sp{flex:1}' +
      '.tw-ve-pk-body{padding:8px;overflow:auto;min-height:120px}.tw-ve-pk-row{display:flex;gap:8px;align-items:center;padding:4px 6px;border:1px solid #bbb;border-radius:6px;margin:3px 0;cursor:pointer}.tw-ve-pk-row:hover{border-color:#8250df}.tw-ve-pk-row .n{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tw-ve-pk-row .m{opacity:.65;font-size:12px}.tw-ve-pk-note{font-size:12px;opacity:.7;margin:4px 0}';
    root.document.head.appendChild(s);
  }
  function size(n) { n = +n; return !n ? '' : n > 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function open(o) {
    css(); var T = o.T || function (a) { return a; };
    return new Promise(function (resolve) {
      var ov = el('div', 'tw-ve-pk'), box = el('div', 'tw-ve-pk-box'), hd = el('div', 'tw-ve-pk-hd'), body = el('div', 'tw-ve-pk-body'), tabBtn = {}, gen = 0;
      ov.setAttribute('data-ve', 'picker'); body.setAttribute('data-ve', 'picker-body'); box.appendChild(hd); box.appendChild(body); ov.appendChild(box);
      function done(f) { ov.remove(); resolve(f || null); }
      function busy(msg) { body.textContent = ''; body.appendChild(el('div', 'tw-ve-pk-note', msg)); }
      function pickFrom(label, getFile) { busy(T('讀取 ', 'Reading ') + label + '…'); getFile().then(done, function (e) { busy('⚠️ ' + ((e && e.message) || e)); }); }
      function fileRow(name, meta, onClick, tag) { var r = el('div', 'tw-ve-pk-row'); r.setAttribute('data-pk', tag || 'file'); r.appendChild(el('span', 'n', name)); r.appendChild(el('span', 'm', meta || '')); r.addEventListener('click', onClick); return r; }
      var TABS = [['computer', T('這台電腦', 'This computer')], ['chat', T('聊天 / Redmine 檔案', 'Chat / Redmine files')], ['fap', T('授權資料夾 (FAP)', 'Authorized folders (FAP)')], ['stored', T('這個瀏覽器的檔案', 'Kept in this browser')]];
      TABS.forEach(function (t) { var b = el('button', '', t[1]); b.type = 'button'; b.setAttribute('data-pk-tab', t[0]); b.addEventListener('click', function () { show(t[0]); }); hd.appendChild(b); tabBtn[t[0]] = b; });
      hd.appendChild(el('span', 'sp')); var x = el('button', '', '✕'); x.type = 'button'; x.setAttribute('data-pk', 'close'); x.addEventListener('click', function () { done(null); }); hd.appendChild(x);
      ov.addEventListener('click', function (e) { if (e.target === ov) { done(null); } });
      function show(tab) {
        var my = ++gen; Object.keys(tabBtn).forEach(function (k) { tabBtn[k].classList.toggle('on', k === tab); }); body.textContent = '';
        if (tab === 'computer') {
          body.appendChild(el('div', 'tw-ve-pk-note', T('從這台電腦的檔案選一個影片或音訊檔。', 'Pick a video or audio file from this computer.')));
          var b = el('button', '', '📂 ' + T('選擇檔案…', 'Choose a file…')); b.type = 'button'; b.setAttribute('data-pk', 'computer'); b.addEventListener('click', function () { done(null); if (o.computer) { o.computer(); } }); body.appendChild(b);
        } else if (tab === 'chat') {
          busy(T('讀取聊天檔案…', 'Reading the chat files…'));
          Promise.resolve(o.chatFiles ? o.chatFiles() : []).then(function (list) {
            if (my !== gen) { return; } body.textContent = '';
            if (!list.length) { body.appendChild(el('div', 'tw-ve-pk-note', T('聊天裡還沒有影片或音訊檔(附加檔案或上傳後會列在這裡)。', 'No video or audio files in the chat yet (attach or upload one and it shows up here).'))); return; }
            list.forEach(function (f) { body.appendChild(fileRow('🎞 ' + f.name, (f.from === 'redmine' ? 'Redmine · ' : T('聊天 · ', 'chat · ')) + size(f.size), function () { pickFrom(f.name, f.open); }, 'chat-file')); });
          }, function (e) { if (my === gen) { busy('⚠️ ' + ((e && e.message) || e)); } });
        } else if (tab === 'stored') {
          busy(T('讀取這個瀏覽器保存的檔案…', 'Reading the files kept in this browser…'));
          Promise.resolve(o.storedFiles ? o.storedFiles() : []).then(function (list) {
            if (my !== gen) { return; } body.textContent = '';
            body.appendChild(el('div', 'tw-ve-pk-note', T('編輯器輸出的影片(燒錄結果)和你載入的影片都保存在這裡,可以隨時拿來繼續編輯。', 'Videos the editor made (burn results) and the videos you loaded are kept here, so you can keep editing them.')));
            if (!list.length) { body.appendChild(el('div', 'tw-ve-pk-note', T('目前沒有。', 'None yet.'))); return; }
            list.forEach(function (f) { body.appendChild(fileRow('🎞 ' + f.name, size(f.size), function () { pickFrom(f.name, f.open); }, 'stored-file')); });
          }, function (e) { if (my === gen) { busy('⚠️ ' + ((e && e.message) || e)); } });
        } else {
          busy(T('讀取授權資料夾…', 'Reading the authorized folders…'));
          Promise.resolve(o.fapFolders ? o.fapFolders() : []).then(function (folders) {
            if (my !== gen) { return; } body.textContent = '';
            if (!folders.length) { body.appendChild(el('div', 'tw-ve-pk-note', T('還沒有授權任何資料夾(Configure > File Access 可以新增)。', 'No folder authorized yet (add one in Configure > File Access).'))); return; }
            body.appendChild(el('div', 'tw-ve-pk-note', T('選一個資料夾:', 'Choose a folder:')));
            folders.forEach(function (rec) { var r = fileRow('📁 ' + rec.label, '', function () { browse(rec, [rec.handle], [rec.label], my); }, 'fap-folder'); body.appendChild(r); });
          }, function (e) { if (my === gen) { busy('⚠️ ' + ((e && e.message) || e)); } });
        }
      }
      // one directory level at a time: sub-folders first, then the media files (the others are not listed)
      function browse(rec, stack, names, my) {
        var dir = stack[stack.length - 1];
        function listIt() {
          busy(T('讀取資料夾…', 'Reading the folder…'));
          var dirs = [], files = [];
          return (async function () { for await (var ent of dir.entries()) { var nm = ent[0], h = ent[1]; if (h.kind === 'directory') { dirs.push([nm, h]); } else if (o.mediaKind(nm)) { files.push([nm, h]); } } })().then(function () {
            if (my !== gen) { return; } body.textContent = '';
            var path = el('div', 'tw-ve-pk-note', '📁 ' + names.join(' / ')); path.setAttribute('data-pk', 'path'); body.appendChild(path);
            if (stack.length > 1) { body.appendChild(fileRow('⬆ ..', '', function () { browse(rec, stack.slice(0, -1), names.slice(0, -1), my); }, 'fap-up')); }
            else { body.appendChild(fileRow('⬆ ' + T('選別的資料夾', 'Other folders'), '', function () { show('fap'); }, 'fap-up')); }
            dirs.sort(function (a, b) { return a[0].localeCompare(b[0]); }).forEach(function (d) { body.appendChild(fileRow('📁 ' + d[0], '', function () { browse(rec, stack.concat([d[1]]), names.concat([d[0]]), my); }, 'fap-dir')); });
            files.sort(function (a, b) { return a[0].localeCompare(b[0]); }).forEach(function (f) { body.appendChild(fileRow('🎞 ' + f[0], '', function () { pickFrom(f[0], function () { return f[1].getFile(); }); }, 'fap-file')); });
            if (!dirs.length && !files.length) { body.appendChild(el('div', 'tw-ve-pk-note', T('這個資料夾裡沒有影片/音訊檔或子資料夾。', 'No video / audio files or sub-folders here.'))); }
          }, function (e) { if (my === gen) { busy('⚠️ ' + ((e && e.message) || e)); } });
        }
        Promise.resolve(rec.handle.queryPermission ? rec.handle.queryPermission({ mode: 'read' }) : 'granted').then(function (st) {
          if (st === 'granted') { return listIt(); }
          body.textContent = ''; body.appendChild(el('div', 'tw-ve-pk-note', T('「', 'The folder "') + rec.label + T('」需要重新授權讀取。', '" needs permission to be read again.')));
          var g = el('button', '', T('授權讀取', 'Allow reading')); g.type = 'button'; g.setAttribute('data-pk', 'fap-grant');
          g.addEventListener('click', function () { rec.handle.requestPermission({ mode: 'read' }).then(function (r) { if (r === 'granted') { listIt(); } else { busy(T('沒有授權,不能讀這個資料夾', 'Permission was not granted')); } }, function (e) { busy('⚠️ ' + ((e && e.message) || e)); }); });
          body.appendChild(g);
        }, function (e) { busy('⚠️ ' + ((e && e.message) || e)); });
      }
      (o.container || root.document.body).appendChild(ov); show(o.start || 'chat');
    });
  }
  root.TwVideoSourcePicker = { open: open };
}(typeof window !== 'undefined' ? window : globalThis));
