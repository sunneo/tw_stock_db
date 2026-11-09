// keeplookup (藏書閣) group library v2, the pure part (DESIGN.keeplookup-objects.md): the OBJECTS a source is stored as on the server, the MANIFEST that lists them, and the 3-way merge of two manifests.
//   object  = gzip bytes of one of three things per source: text (lines + sections), vec (chunks + int8 vectors), mem (the AI memory); content-addressed: obj.sha256 = sha256 of the gzip bytes,
//             cut into blobs of at most BLOB_MAX bytes (blob sha = sha256 of its bytes). A manifest refers to an object as { sha256, bytes, blobs: [blob sha, ...] }.
//   manifest = { format: 2, sources: { uri: { text, vec, mem, m: {title, folder, tags, ...}, ts } }, removed: { uri: ts }, folders: [...], meta: {...} }
//   create({ gzip, gunzip, sha256 }) -> { encodeText, decodeText, encodeVec, decodeVec, encodeMem, decodeMem, makeObject, joinObject }   (all async; the defaults use CompressionStream / node zlib)
//   merge3(base, ours, theirs) -> manifest        entryParts(entry) -> every blob sha an entry refers to
(function (root) {
  'use strict';
  var BLOB_MAX = 4 * 1024 * 1024, FORMAT = 2, VEC_MAGIC = 'KLV1';
  var enc = new TextEncoder(), dec = new TextDecoder();

  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join(''); }
  function nodeZlib() { try { return typeof require === 'function' ? require('zlib') : null; } catch (e) { return null; } }
  function defaultGzip(bytes) {
    if (typeof CompressionStream !== 'undefined') { return new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
    var z = nodeZlib(); return new Promise(function (res, rej) { z.gzip(Buffer.from(bytes), { level: 6 }, function (e, o) { return e ? rej(e) : res(new Uint8Array(o)); }); });
  }
  function defaultGunzip(bytes) {
    if (typeof DecompressionStream !== 'undefined') { return new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer().then(function (b) { return new Uint8Array(b); }); }
    var z = nodeZlib(); return new Promise(function (res, rej) { z.gunzip(Buffer.from(bytes), function (e, o) { return e ? rej(e) : res(new Uint8Array(o)); }); });
  }
  function defaultSha(bytes) {
    if (root.AiChatHashes) { return Promise.resolve(new root.AiChatHashes.Digest().update(bytes).result().sha256); }
    return root.crypto.subtle.digest('SHA-256', bytes).then(hex);
  }
  function u8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

  function create(deps) {
    deps = deps || {};
    var gzip = deps.gzip || defaultGzip, gunzip = deps.gunzip || defaultGunzip, sha256 = deps.sha256 || defaultSha;

    function json(o) { return gzip(enc.encode(JSON.stringify(o))); }
    function unjson(bytes) { return gunzip(u8(bytes)).then(function (b) { return JSON.parse(dec.decode(b)); }); }

    // text: { meta: { kind, uri, mime, parser, bytes, quality }, lines: [{ no, locator, text }], sections: [{ depth, title, line_from, line_to }] }
    function encodeText(t) {
      return json({ v: 1, meta: t.meta, lines: (t.lines || []).map(function (l) { return [l.no, l.locator == null ? null : l.locator, l.text]; }),
        sections: (t.sections || []).map(function (s) { return [s.depth, s.title, s.line_from, s.line_to == null ? null : s.line_to]; }) });
    }
    function decodeText(bytes) {
      return unjson(bytes).then(function (o) {
        return { meta: o.meta, lines: o.lines.map(function (l) { return { no: l[0], locator: l[1], text: l[2] }; }),
          sections: o.sections.map(function (s) { return { depth: s[0], title: s[1], line_from: s[2], line_to: s[3] }; }) };
      });
    }

    // vec: { chunker, chunks: [{ line_from, line_to, model, dim, vec: Uint8Array }] }  ->  KLV1 | u32 header length | header JSON | the vectors one after the other
    function encodeVec(v) {
      var items = (v.chunks || []).map(function (c) { return [c.line_from, c.line_to, c.model, c.dim]; }), total = 0, i;
      (v.chunks || []).forEach(function (c) { total += c.vec.length; });
      var head = enc.encode(JSON.stringify({ chunker: v.chunker, items: items })), out = new Uint8Array(4 + 4 + head.length + total), dv = new DataView(out.buffer), at = 8 + head.length;
      for (i = 0; i < 4; i++) { out[i] = VEC_MAGIC.charCodeAt(i); }
      dv.setUint32(4, head.length, true); out.set(head, 8);
      (v.chunks || []).forEach(function (c) { out.set(u8(c.vec), at); at += c.vec.length; });
      return gzip(out);
    }
    function decodeVec(bytes) {
      return gunzip(u8(bytes)).then(function (b) {
        if (String.fromCharCode(b[0], b[1], b[2], b[3]) !== VEC_MAGIC) { throw new Error('not a keeplookup vector object'); }
        var n = new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(4, true), h = JSON.parse(dec.decode(b.subarray(8, 8 + n))), at = 8 + n;
        return { chunker: h.chunker, chunks: h.items.map(function (it) { var vec = b.slice(at, at + it[3]); at += it[3]; return { line_from: it[0], line_to: it[1], model: it[2], dim: it[3], vec: vec }; }) };
      });
    }

    // mem: { overview, keywords, model, created_at, parts: [{ level, line_from, line_to, md }] }
    function encodeMem(m) { return json({ v: 1, overview: m.overview, keywords: m.keywords, model: m.model, created_at: m.created_at, parts: (m.parts || []).map(function (p) { return [p.level, p.line_from, p.line_to, p.md]; }) }); }
    function decodeMem(bytes) {
      return unjson(bytes).then(function (o) { return { overview: o.overview, keywords: o.keywords, model: o.model, created_at: o.created_at, parts: o.parts.map(function (p) { return { level: p[0], line_from: p[1], line_to: p[2], md: p[3] }; }) }; });
    }

    // gzip bytes -> { sha256, bytes, blobs: [{ sha, data }] }   (the entry in a manifest keeps only the blob shas: see ref())
    function makeObject(gz) {
      gz = u8(gz); var pieces = [], at = 0;
      do { pieces.push(gz.subarray(at, Math.min(gz.length, at + BLOB_MAX))); at += BLOB_MAX; } while (at < gz.length);
      return Promise.all([sha256(gz)].concat(pieces.map(function (p) { return sha256(p); }))).then(function (h) {
        return { sha256: h[0], bytes: gz.length, blobs: pieces.map(function (p, i) { return { sha: h[i + 1], data: p }; }) };
      });
    }
    // the blobs' bytes in order (an array of Uint8Array) -> the object's gzip bytes, checked against its sha256
    function joinObject(ref, datas) {
      var total = 0, out, at = 0; datas.forEach(function (d) { total += d.length; });
      if (total !== ref.bytes) { return Promise.reject(new Error('an object arrived with the wrong size')); }
      out = new Uint8Array(total); datas.forEach(function (d) { out.set(u8(d), at); at += d.length; });
      return sha256(out).then(function (h) { if (h !== ref.sha256) { throw new Error('an object arrived damaged (sha256 differs)'); } return out; });
    }
    return { gzip: gzip, gunzip: gunzip, sha256: sha256, encodeText: encodeText, decodeText: decodeText, encodeVec: encodeVec, decodeVec: decodeVec, encodeMem: encodeMem, decodeMem: decodeMem, makeObject: makeObject, joinObject: joinObject };
  }

  // ---------------------------------------------------------------- manifest
  function ref(o) { return o ? { sha256: o.sha256, bytes: o.bytes, blobs: o.blobs.map(function (b) { return typeof b === 'string' ? b : b.sha; }) } : null; }
  function emptyManifest() { return { format: FORMAT, sources: {}, removed: {}, folders: [], meta: {} }; }
  function entryParts(e) {
    var out = []; ['text', 'vec', 'mem'].forEach(function (k) { if (e && e[k]) { e[k].blobs.forEach(function (b) { out.push(b); }); } }); return out;
  }
  function objSig(o) { return o ? o.sha256 : ''; }
  function metaSig(m) { return JSON.stringify(m || {}, Object.keys(m || {}).sort()); }
  // everything about an entry that counts as "changed"
  function sig(e) { return e ? [objSig(e.text), objSig(e.vec), objSig(e.mem), metaSig(e.m)].join('|') : ''; }
  // one side's state of a uri: { k: 'entry', e } | { k: 'tomb', ts } | { k: 'none' }
  function stateOf(man, uri) {
    if (man && man.sources && man.sources[uri]) { return { k: 'entry', e: man.sources[uri] }; }
    if (man && man.removed && man.removed[uri] != null) { return { k: 'tomb', ts: man.removed[uri] }; }
    return { k: 'none' };
  }
  function stateSig(s) { return s.k === 'entry' ? 'e:' + sig(s.e) : s.k === 'tomb' ? 't' : 'n'; }
  function tsOf(s) { return s.k === 'entry' ? Number(s.e.ts || 0) : s.k === 'tomb' ? Number(s.ts || 0) : 0; }

  // both sides changed the same source: take each part from the side that changed it (the other side left it as the base had it); the same part changed on both sides: the newer ts wins
  function mergeEntries(b, o, t) {
    var newer = Number(o.ts || 0) >= Number(t.ts || 0) ? o : t, out = { ts: Math.max(Number(o.ts || 0), Number(t.ts || 0)) };
    ['text', 'vec', 'mem'].forEach(function (k) {
      var bs = objSig(b && b[k]), os = objSig(o[k]), ts = objSig(t[k]);
      out[k] = os === ts ? o[k] : os === bs ? t[k] : ts === bs ? o[k] : newer[k];
    });
    var bm = metaSig(b && b.m), om = metaSig(o.m), tm = metaSig(t.m);
    out.m = om === tm ? o.m : om === bm ? t.m : tm === bm ? o.m : newer.m;
    // a vec object only fits the text it was computed for: when the text came from one side and the vec from the other, keep the vec only if both sides' text agree
    if (objSig(o.text) !== objSig(t.text)) { var tx = objSig(out.text); out.vec = objSig(o.text) === tx ? o.vec : t.vec; out.mem = objSig(o.text) === tx ? o.mem : t.mem; }
    return out;
  }

  function setMerge(base, ours, theirs) {
    var b = {}, o = {}, t = {}, out = [];
    (base || []).forEach(function (x) { b[x] = 1; }); (ours || []).forEach(function (x) { o[x] = 1; }); (theirs || []).forEach(function (x) { t[x] = 1; });
    Object.keys(Object.assign({}, o, t)).forEach(function (x) { if ((o[x] && t[x]) || (o[x] && !b[x]) || (t[x] && !b[x])) { out.push(x); } });
    return out.sort();
  }

  function merge3(base, ours, theirs) {
    base = base || emptyManifest(); ours = ours || emptyManifest(); theirs = theirs || emptyManifest();
    var out = emptyManifest(), uris = {};
    [base, ours, theirs].forEach(function (m) { Object.keys(m.sources || {}).concat(Object.keys(m.removed || {})).forEach(function (u) { uris[u] = 1; }); });
    Object.keys(uris).forEach(function (u) {
      var b = stateOf(base, u), o = stateOf(ours, u), t = stateOf(theirs, u), pick;
      if (stateSig(o) === stateSig(t)) { pick = o; }
      else if (stateSig(o) === stateSig(b)) { pick = t; }
      else if (stateSig(t) === stateSig(b)) { pick = o; }
      else if (o.k === 'entry' && t.k === 'entry') { pick = { k: 'entry', e: mergeEntries(b.k === 'entry' ? b.e : null, o.e, t.e) }; }
      else { pick = tsOf(o) >= tsOf(t) ? o : t; }   // a removal against a change: the later of the two wins
      if (pick.k === 'entry') { out.sources[u] = pick.e; } else if (pick.k === 'tomb') { out.removed[u] = pick.ts; }
    });
    out.folders = setMerge(base.folders, ours.folders, theirs.folders);
    var mk = Object.assign({}, base.meta, ours.meta, theirs.meta);
    Object.keys(mk).forEach(function (k) {
      var bv = JSON.stringify((base.meta || {})[k]), ov = JSON.stringify((ours.meta || {})[k]), tv = JSON.stringify((theirs.meta || {})[k]);
      var v = ov === tv ? (ours.meta || {})[k] : ov === bv ? (theirs.meta || {})[k] : (ours.meta || {})[k];
      if (v !== undefined) { out.meta[k] = v; }
    });
    return out;
  }
  // tombstones older than `days` days are forgotten (a stale save from before that is not expected any more)
  function pruneTombstones(man, nowMs, days) {
    var cut = nowMs - (days || 60) * 86400000; Object.keys(man.removed || {}).forEach(function (u) { if (Number(man.removed[u]) < cut) { delete man.removed[u]; } }); return man;
  }
  function equalManifests(a, b) {
    var ua = Object.keys(a.sources || {}), ub = Object.keys(b.sources || {});
    if (ua.length !== ub.length || Object.keys(a.removed || {}).length !== Object.keys(b.removed || {}).length) { return false; }
    return ua.every(function (u) { return b.sources[u] && sig(a.sources[u]) === sig(b.sources[u]); }) && Object.keys(a.removed || {}).every(function (u) { return b.removed && b.removed[u] === a.removed[u]; })
      && JSON.stringify(a.folders || []) === JSON.stringify(b.folders || []) && JSON.stringify(a.meta || {}, Object.keys(a.meta || {}).sort()) === JSON.stringify(b.meta || {}, Object.keys(b.meta || {}).sort());
  }

  var api = { create: create, ref: ref, emptyManifest: emptyManifest, entryParts: entryParts, merge3: merge3, mergeEntries: mergeEntries, pruneTombstones: pruneTombstones, equalManifests: equalManifests, sig: sig, BLOB_MAX: BLOB_MAX, FORMAT: FORMAT };
  root.KeepLookupPack = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
