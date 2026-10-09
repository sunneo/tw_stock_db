// The deck pack of "/media-presentation": ONE compressed file holding a whole presentation -- the description, every picture / 2D scene /
// 3D scene / code file it uses, the narration of each slide, the subtitles, and what the viewer answered (answer cards, widget scores) --
// so it can be sent around and opened again later, on another machine, with nothing else (no attachment urls to resolve).
//
//   <name>.deckpack   (a zip; the extension is the one constant PACK_EXT below -- ".vtt" would clash with the WebVTT subtitle file)
//     manifest.json   {format: "ai-chat-deckpack", version, title, slides, created, warnings}
//     deck.yaml       the description; every url of a picture / ref / src is rewritten to a relative "assets/..." path
//     assets/*        the files those urls pointed at
//     audio/NN-<slide id>.mp3   narration
//     results.json    the viewer's answers and scores, and the last screen (with colours) of every terminal (restored when the pack is opened)
//     subtitles.srt / subtitles.vtt, README.txt
//
// Exporting is a format of ai_chat_deck_export.js (it owns the progress card); this file has the pieces both directions share and the
// opening side: AiChatDeckPack.open(blobOrFile, container) -> a Player on a Session whose assets / narration / answers come from the pack.
(function (window) {
  'use strict';

  var PACK_EXT = '.deckpack';
  var FORMAT = 'ai-chat-deckpack';
  var VERSION = 1;
  var URL_KEYS = { src: 1, ref: 1, url: 1, image: 1 };
  var MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', yaml: 'text/yaml', yml: 'text/yaml', txt: 'text/plain', json: 'application/json', mp3: 'audio/mpeg' };

  // a pack (.deckpack) or the older "完整封包" bundle (.deck.zip: description + narration + subtitles, no assets)
  function isPackFile(name) { var n = String(name || '').toLowerCase(); return n.slice(-PACK_EXT.length) === PACK_EXT || /\.deck\.zip$/.test(n); }

  // A value that points at something outside the description (and so has to travel with the pack)
  function isFetchable(v) {
    if (typeof v !== 'string' || !v) { return false; }
    if (/^(data:|assets\/)/i.test(v)) { return false; }
    var sink = window.AiChatFileSink;
    return /^(https?:\/\/|\/|blob:)/i.test(v) || !!(sink && v.indexOf(sink.CLIENT_FILE_PREFIX) === 0);
  }
  function extOf(url, blob) {
    var m = /\.([a-z0-9]{1,5})(?:[?#]|$)/i.exec(String(url).split('?')[0] + '?');
    if (m && MIME[m[1].toLowerCase()]) { return m[1].toLowerCase(); }
    var t = blob && blob.type || '';
    for (var k in MIME) { if (MIME[k] === t) { return k; } }
    return 'bin';
  }

  // Walks every visual of a parsed deck document (chapters[].slides[].visual, group items, overlays) and calls fn(owner, key, value) for each url-ish field.
  function walkUrls(doc, fn) {
    function node(o) {
      if (Array.isArray(o)) { o.forEach(node); return; }
      if (!o || typeof o !== 'object') { return; }
      Object.keys(o).forEach(function (k) {
        if (URL_KEYS[k] && typeof o[k] === 'string') { fn(o, k, o[k]); }
        else if (o[k] && typeof o[k] === 'object') { node(o[k]); }
      });
    }
    (doc.chapters || []).forEach(function (ch) { (ch.slides || []).forEach(function (sl) { node(sl.visual); }); });
  }

  // Export side: fetch every external file the deck uses (fetchBlob(url) -> Promise<Blob>), rewrite the document to relative paths.
  // -> Promise<{doc, files: [{path, blob}], warnings: [string]}>; a file that cannot be fetched keeps its url and is listed in warnings.
  function collectAssets(doc, fetchBlob, onProgress) {
    var urls = [], seen = {};
    walkUrls(doc, function (o, k, v) { if (isFetchable(v) && !seen[v]) { seen[v] = true; urls.push(v); } });
    var map = {}, files = [], warnings = [], done = 0;
    return urls.reduce(function (chain, url, i) {
      return chain.then(function () {
        return fetchBlob(url).then(function (blob) {
          var path = 'assets/' + String(i + 1).padStart(3, '0') + '.' + extOf(url, blob);
          map[url] = path; files.push({ path: path, blob: blob });
        }, function (e) { warnings.push('could not include ' + String(url).slice(0, 120) + ': ' + (e && e.message || e)); })
          .then(function () { done++; if (onProgress) { onProgress(done, urls.length); } });
      });
    }, Promise.resolve()).then(function () {
      walkUrls(doc, function (o, k, v) { if (map[v]) { o[k] = map[v]; } });
      return { doc: doc, files: files, warnings: warnings };
    });
  }

  // Opening side.
  function ensureZip() {
    var kit = window.AiChatMarkdown && window.AiChatMarkdown.pptxKit;
    return kit ? kit.ensureLibs().then(function () { if (!window.JSZip) { throw new Error('the zip library did not load'); } return window.JSZip; }) : Promise.reject(new Error('the zip library loader is not available'));
  }

  // -> Promise<Player>. Everything the pack holds becomes blob: urls / in-memory bytes; nothing is fetched from Redmine.
  function open(file, container) {
    var Core = window.AiChatDeckCore, Deck = window.AiChatDeck;
    var status = document.createElement('div'); status.className = 'ai-chat-deck-loading'; status.textContent = '開啟簡報封包中…'; container.appendChild(status);
    var zip, manifest;
    return Promise.all([ensureZip(), window.AiChat2D ? window.AiChat2D.ensureJsYamlLoaded() : Promise.reject(new Error('js-yaml loader is not available'))]).then(function () {
      return window.JSZip.loadAsync(file);
    }).then(function (z) {
      zip = z;
      var mf = zip.file('manifest.json'), dk = zip.file('deck.yaml');
      if (!mf || !dk) {
        // the older "完整封包" (.deck.zip): <name>.deck.yaml + audio/NN-<slide id>.mp3 + subtitles. Its pictures stay the Redmine urls the description
        // names (they load while you can reach that Redmine); there are no saved answers.
        var legacy = zip.file(/\.deck\.yaml$/i)[0];
        if (!legacy) { throw new Error('this is not a presentation file: neither a .deckpack (manifest.json + deck.yaml) nor a .deck.zip (<name>.deck.yaml)'); }
        manifest = { format: FORMAT, version: VERSION, legacy: true };
        return legacy.async('string');
      }
      return mf.async('string').then(function (t) {
        manifest = JSON.parse(t);
        if (manifest.format !== FORMAT) { throw new Error('this is not a deck pack (format "' + manifest.format + '")'); }
        if (manifest.version > VERSION) { throw new Error('this pack was made by a newer version (' + manifest.version + '); update the plugin to open it'); }
        return dk.async('string');
      });
    }).then(function (yamlText) {
      var doc = window.jsyaml.load(yamlText), paths = {}, jobs = [];
      walkUrls(doc, function (o, k, v) { if (/^assets\//.test(v)) { paths[v] = true; } });
      Object.keys(paths).forEach(function (p) {
        var f = zip.file(p); if (!f) { return; }
        jobs.push(f.async('arraybuffer').then(function (buf) { var ext = (/\.([a-z0-9]+)$/i.exec(p) || [])[1] || ''; paths[p] = URL.createObjectURL(new Blob([buf], { type: MIME[ext.toLowerCase()] || 'application/octet-stream' })); }));
      });
      var audio = {}, audioJobs = [];
      zip.file(/^audio\/.+\.mp3$/).forEach(function (f) {
        var m = /^audio\/\d+-(.+)\.mp3$/.exec(f.name); if (!m) { return; }
        audioJobs.push(f.async('arraybuffer').then(function (buf) { audio[m[1]] = buf; }));
      });
      var rf = zip.file('results.json'), resultsP = rf ? rf.async('string').then(function (t) { try { return JSON.parse(t); } catch (e) { return null; } }) : Promise.resolve(null);
      return Promise.all(jobs.concat(audioJobs)).then(function () { return resultsP; }).then(function (results) {
        walkUrls(doc, function (o, k, v) { if (typeof paths[v] === 'string') { o[k] = paths[v]; } });
        var raw = window.jsyaml.dump(doc, { lineWidth: -1 }), deck = Core.parseDeck(raw, window.jsyaml);
        var session = new Deck.Session(deck, raw, '');
        session.packAudio = audio; session.packResults = results && results.items || {}; session.packTerminals = results && results.terminals || {};
        status.remove();
        container._deckPlayer = new Deck.Player(session, container);
        return container._deckPlayer;
      });
    }).catch(function (e) { status.textContent = '開啟封包失敗:' + (e && e.message || e); status.className = 'ai-chat-deck-loading ai-chat-deck-error'; throw e; });
  }

  window.AiChatDeckPack = { PACK_EXT: PACK_EXT, FORMAT: FORMAT, VERSION: VERSION, isPackFile: isPackFile, walkUrls: walkUrls, collectAssets: collectAssets, isFetchable: isFetchable, open: open };
})(window);
