// Where the picture editors (/edit-svg, /edit-picture) get pictures from the WEB, for the chat ("add this address", "find a picture of …"). Same sources and rules as the desktop assistant's find_photo
// (DESIGN.deck-topic.md): Wikimedia Commons first, Openverse as the second try -- both free licences, no key, and they allow the browser to talk to them directly; the result carries its
// licence and author so the credit stays with the object.
//
//   var PS = FaPictureSource.make({ fetch, relayUrl, timeoutMs })
//   PS.search(query, { limit }) -> Promise<{ ok, results:[{ title, thumb, full, width, height, source, license, creator, page, score }], error?, tried:[{source, ok, error?}] }>
//   PS.load(urlOrResult)        -> Promise<{ blob, mime, via:'browser'|'server' }>      the browser first (works for sites that allow it); else the server relays the bytes (a public site only,
//                                                                                        8 MB, checked to be a picture: AiChatPictureFetchController); data: URLs work as they are
//   PS.rank(query, results)     the order the results are in (words of the query found in the title, bigger pictures a little better)       PS.urls(text) -> the http(s) addresses in a sentence
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPictureSource = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var IMG = /^image\/(png|jpe?g|gif|webp|bmp|svg\+xml)$/i;
  function strip(html) { return String(html == null ? '' : html).replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim(); }
  function words(q) { return String(q || '').toLowerCase().split(/[^a-z0-9一-鿿]+/).filter(function (w) { return w.length > 1 || /[一-鿿]/.test(w); }); }
  function rank(query, results) {
    var ws = words(query);
    results.forEach(function (r) {
      var t = String(r.title || '').toLowerCase(), hit = 0; ws.forEach(function (w) { if (t.indexOf(w) >= 0) { hit++; } });
      r.score = hit * 10 + (r.width >= 800 ? 2 : r.width >= 400 ? 1 : 0) - (r.width && r.width < 200 ? 5 : 0) - (/logo|icon|map of|flag of|diagram|chart|stamp/i.test(r.title || '') && !/logo|icon|map|flag|diagram|chart|stamp/i.test(query) ? 3 : 0);
    });
    return results.slice().sort(function (a, b) { return b.score - a.score; });
  }
  function urls(text) { return (String(text || '').match(/https?:\/\/[^\s"'<>）)」』，。；：！？、]+/gi) || []).map(function (u) { return u.replace(/[.,;:!?。，；：！？]+$/, ''); }); }

  function make(cfg) {
    cfg = cfg || {};
    var F = cfg.fetch || (typeof fetch === 'function' ? fetch.bind(typeof window !== 'undefined' ? window : globalThis) : null), timeoutMs = cfg.timeoutMs || 15000;
    function get(url, opts) {
      if (!F) { return Promise.reject(new Error('no fetch here')); }
      var ctl = typeof AbortController === 'function' ? new AbortController() : null, timer = ctl ? setTimeout(function () { try { ctl.abort(); } catch (e) { /* done */ } }, timeoutMs) : null;
      return Promise.resolve(F(url, Object.assign({ signal: ctl ? ctl.signal : undefined }, opts || {}))).then(function (r) { if (timer) { clearTimeout(timer); } return r; }, function (e) { if (timer) { clearTimeout(timer); } throw e; });
    }
    function json(url) { return get(url).then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return r.json(); }); }
    var SOURCES = {
      commons: function (q, n) {
        var u = 'https://commons.wikimedia.org/w/api.php?action=query&format=json&origin=*&generator=search&gsrnamespace=6&gsrlimit=' + n + '&gsrsearch=' + encodeURIComponent(q + ' filetype:bitmap') + '&prop=imageinfo&iiprop=url%7Csize%7Cmime%7Cextmetadata&iiurlwidth=1024';
        return json(u).then(function (d) {
          var pages = (d && d.query && d.query.pages) || {};
          return Object.keys(pages).map(function (k) {
            var p = pages[k], ii = p.imageinfo && p.imageinfo[0]; if (!ii || !IMG.test(ii.mime || '')) { return null; } var em = ii.extmetadata || {};
            return { title: String(p.title || '').replace(/^File:/, '').replace(/\.[a-z0-9]+$/i, '').replace(/_/g, ' '), thumb: ii.thumburl || ii.url, full: ii.url, width: ii.width, height: ii.height, source: 'commons', license: strip(em.LicenseShortName && em.LicenseShortName.value) || '', creator: strip(em.Artist && em.Artist.value).slice(0, 80), page: ii.descriptionurl || '' };
          }).filter(Boolean);
        });
      },
      openverse: function (q, n) {
        return json('https://api.openverse.org/v1/images/?q=' + encodeURIComponent(q) + '&page_size=' + Math.max(n, 6)).then(function (d) {
          return ((d && d.results) || []).map(function (r) { return { title: String(r.title || ''), thumb: r.thumbnail || r.url, full: r.url, width: r.width, height: r.height, source: 'openverse', license: ((r.license || '') + ' ' + (r.license_version || '')).trim().toUpperCase(), creator: String(r.creator || '').slice(0, 80), page: r.foreign_landing_url || '' }; });
        });
      }
    };
    function search(query, opts) {
      opts = opts || {}; var q = String(query || '').trim(), n = Math.max(1, Math.min(12, opts.limit || 6)), tried = [], order = opts.sources || ['commons', 'openverse'];
      if (!q) { return Promise.resolve({ ok: false, error: 'what should it look for?', results: [], tried: tried }); }
      var i = 0;
      function next() {
        if (i >= order.length) { return Promise.resolve({ ok: false, error: 'no picture was found (' + tried.map(function (t) { return t.source + ': ' + (t.ok ? 'nothing' : t.error); }).join('; ') + ')', results: [], tried: tried }); }
        var name = order[i++];
        return SOURCES[name](q, n).then(function (res) {
          res = res.filter(function (r) { return r.thumb || r.full; }); tried.push({ source: name, ok: true, count: res.length });
          if (!res.length) { return next(); }
          var ranked = rank(q, res); return { ok: true, results: ranked.slice(0, n), tried: tried };
        }, function (e) { tried.push({ source: name, ok: false, error: String((e && e.message) || e).slice(0, 80) }); return next(); });
      }
      return next();
    }
    function blobOf(r) { return r.blob().then(function (b) { return { blob: b, mime: (b.type || '').toLowerCase() }; }); }
    function load(target) {
      var url = typeof target === 'string' ? target : (target.full || target.thumb);
      if (/^data:image\//i.test(url)) { return get(url).then(blobOf).then(function (o) { o.via = 'browser'; return o; }); }
      if (!/^https?:\/\//i.test(url)) { return Promise.reject(new Error('that is not a web address')); }
      var viaServer = function (why) {
        if (!cfg.relayUrl) { throw new Error('the picture cannot be read by the browser (' + why + ') and no server relay is configured'); }
        return get(cfg.relayUrl + (cfg.relayUrl.indexOf('?') < 0 ? '?' : '&') + 'url=' + encodeURIComponent(url), { credentials: 'same-origin' }).then(function (r) {
          if (!r.ok) { return r.json().then(function (j) { throw new Error((j && j.error) || 'the server answered HTTP ' + r.status); }, function () { throw new Error('the server answered HTTP ' + r.status); }); }
          return blobOf(r).then(function (o) { if (!IMG.test(o.mime)) { throw new Error('that address is not a picture'); } o.via = 'server'; return o; });
        });
      };
      return get(url, { mode: 'cors' }).then(function (r) { if (!r.ok) { throw new Error('HTTP ' + r.status); } return blobOf(r); }).then(function (o) {
        if (!IMG.test(o.mime)) { throw new Error('not a picture (' + (o.mime || 'unknown type') + ')'); } o.via = 'browser'; return o;
      }).then(null, function (e) { return viaServer(String((e && e.message) || e).slice(0, 60)); });
    }
    return { search: search, load: load, rank: rank, urls: urls, _sources: SOURCES };
  }
  return { make: make, rank: rank, urls: urls, strip: strip };
});
