// keeplookup (藏書閣) group library v2, the SYNC ENGINE (DESIGN.keeplookup-objects.md): talks to the group workspace's blob / root API and keeps the local library (SQLite, in the worker) in step with the repository.
//   httpFor({ url, csrf, fetch }) -> http   the five calls of AiChatGroupWorkspacesController (blobs_missing, blob, root); url = '.../group_workspaces/<group id>'
//   create({ http, rpc, Pack, onProgress, now }) -> { sync(name), loadObjects(name, tasks, opts), tasks(name), baseInfo() }
//     rpc(op, args) -> Promise   the database ops of ai_chat_keeplookup_syncops.js (+ meta / setMeta)
//   sync(name)     push what changed here (only changed objects), merge with what others pushed (3-way, per source), apply removals / folders / meta, remember the result as the new base;
//                  -> { version, pushed: { sources, objects, blobs, bytes }, removed, tasks: [...objects still to download], merged }
//   loadObjects(name, tasks, opts)  download and apply the objects of `tasks`, the text + vectors of every source first, the memory afterwards (lazy: each source is usable as soon as its text is in)
(function (root) {
  'use strict';

  // ---------------------------------------------------------------- the HTTP side
  function httpFor(deps) {
    var f = deps.fetch || root.fetch.bind(root);
    function go(path, opts) { return f(deps.url + '/' + path, Object.assign({ credentials: 'same-origin' }, opts || {})); }
    function post(path, body, type) { return go(path, { method: 'POST', headers: { 'X-CSRF-Token': deps.csrf(), 'Content-Type': type || 'application/octet-stream' }, body: body }); }
    function fail(r, what) {
      return r.text().then(function (t) { var j = null; try { j = JSON.parse(t); } catch (e) { /* not json */ } var e = new Error(what + ': ' + r.status + (j && j.error ? ' ' + j.error : '')); e.status = r.status; e.body = j; throw e; });
    }
    function retry(fn, n) { return fn().then(null, function (e) { if (n <= 0 || (e && e.status && e.status < 500 && e.status !== 408)) { throw e; } return retry(fn, n - 1); }); }
    return {
      blobsMissing: function (shas) {
        var out = [], i = 0;
        function next() {
          if (i >= shas.length) { return Promise.resolve(out); }
          var part = shas.slice(i, i + 4000); i += 4000;
          return post('blobs_missing', JSON.stringify({ shas: part }), 'application/json').then(function (r) { return r.ok ? r.json() : fail(r, 'blobs_missing'); }).then(function (j) { out = out.concat(j.missing || []); return next(); });
        }
        return next();
      },
      putBlob: function (sha, data) { return retry(function () { return post('blob?sha=' + encodeURIComponent(sha), data).then(function (r) { return r.ok ? true : fail(r, 'put blob'); }); }, 2); },
      getBlob: function (sha) { return retry(function () { return go('blob?sha=' + encodeURIComponent(sha)).then(function (r) { return r.ok ? r.arrayBuffer().then(function (b) { return new Uint8Array(b); }) : fail(r, 'get blob'); }); }, 2); },
      // the facts of the group's library on the server (v1 single / parts library, v2 roots): which format it is in
      status: function (name) { return go('library_status?name=' + encodeURIComponent(name || 'default'), { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : fail(r, 'library_status'); }); },
      getRoot: function (name) {
        return go('root?name=' + encodeURIComponent(name || 'default'), { cache: 'no-store' }).then(function (r) { if (r.status === 204) { return null; } return r.ok ? r.json() : fail(r, 'get root'); });
      },
      commitRoot: function (name, rootObj, baseVersion) {
        return post('root?name=' + encodeURIComponent(name || 'default') + '&base_version=' + encodeURIComponent(baseVersion == null ? '' : baseVersion), JSON.stringify(rootObj), 'application/json').then(function (r) {
          if (r.status === 409) { return r.json().then(function (j) { var e = new Error('the library changed on the server'); e.conflict = true; e.latest = j.latest_version; throw e; }); }
          return r.ok ? r.json() : fail(r, 'commit root');
        });
      }
    };
  }

  // ---------------------------------------------------------------- the engine
  function create(deps) {
    var http = deps.http, rpc = deps.rpc, Pack = deps.Pack, K = Pack.create(deps.packDeps), now = deps.now || function () { return Date.now(); }, tell = deps.onProgress || function () {};
    var manifestCache = {};   // manifest object sha256 -> manifest (a manifest is immutable)
    var enc = new TextEncoder(), dec = new TextDecoder();

    function clone(o) { return JSON.parse(JSON.stringify(o)); }
    function metaSigOf(m) { return JSON.stringify(m || {}, Object.keys(m || {}).sort()); }
    function shaOf(o) { return o ? o.sha256 : ''; }

    function pool(items, limit, fn) {
      var i = 0, out = new Array(items.length);
      function worker() { if (i >= items.length) { return Promise.resolve(); } var k = i++; return Promise.resolve(fn(items[k], k)).then(function (r) { out[k] = r; return worker(); }); }
      var ws = []; for (var w = 0; w < Math.min(limit, items.length); w++) { ws.push(worker()); }
      return Promise.all(ws).then(function () { return out; });
    }

    // the bytes of an object (all of its blobs, verified)
    function fetchObject(refObj) {
      return pool(refObj.blobs, 4, function (sha) { return http.getBlob(sha); }).then(function (datas) { return K.joinObject(refObj, datas); });
    }
    function loadManifest(refObj) {
      if (manifestCache[refObj.sha256]) { return Promise.resolve(manifestCache[refObj.sha256]); }
      return fetchObject(refObj).then(function (zb) { return K.gunzip(zb); }).then(function (b) {
        var m = JSON.parse(dec.decode(b)); manifestCache[refObj.sha256] = m; return m;
      });
    }
    function getBase() {
      return rpc('repoBase', {}).then(function (r) {
        var m = null; try { m = r.manifest ? JSON.parse(r.manifest) : null; } catch (e) { m = null; }
        return { manifest: m || Pack.emptyManifest(), version: r.version == null || r.version === '' ? '' : String(r.version) };
      });
    }
    function setBase(man, version) {
      return rpc('repoSetBase', { manifest: JSON.stringify(man), version: String(version == null ? '' : version) });
    }

    // ---- what goes up: the dirty sources become new entries (only the objects that changed are encoded), the rest stays as the base had it
    var encCache = {};
    function encodeOf(inv, which) {
      var key = inv.uri + '|' + which + '|' + inv.srcSha + '|' + inv.nEmb + '|' + inv.memSig;
      if (encCache[key]) { return Promise.resolve(encCache[key]); }
      return rpc('packEncode', { id: inv.id, which: which }).then(function (o) { encCache[key] = o || { none: true }; return encCache[key]; });
    }
    function buildOurs(base, theirs) {
      return Promise.all([rpc('syncDirty', {}), rpc('syncState', {}), rpc('foldersGet', {})]).then(function (x) {
        var d = x[0], state = x[1], ours = clone(base), t0 = now(), blobs = {}, marks = [], forgets = [], done = 0;
        d.deleted.forEach(function (uri) {
          if (base.sources[uri] || theirs.sources[uri]) { delete ours.sources[uri]; ours.removed[uri] = t0; }
          forgets.push(uri);
        });
        return pool(d.items, 1, function (item) {
          var inv = item.inv, uri = inv.uri, be = base.sources[uri], st = state[uri];
          // vectors and memory belong to the text they were made for: when the text of the server's copy is newer than ours (not yet applied here), they are not sent
          var aligned = item.isNew || !be || !st || st.text_obj === shaOf(be.text);
          var entry = be ? clone(be) : { text: null, vec: null, mem: null, m: {}, ts: 0 };
          var what = {}, objs = {};
          var needText = !!(item.text || !be || !be.text);
          // the text goes when it changed; vectors / memory go when they changed or the text goes (they belong to it) -- but not when the server's text is newer than ours (they would be for the old one)
          var plan = { text: needText, vec: (needText || item.vec) && (aligned || needText), mem: (needText || item.mem) && (aligned || needText) };
          function take(which) {
            if (!plan[which]) { return null; }
            return encodeOf(inv, which).then(function (o) {
              what[which] = 1;
              if (o.none) { entry[which] = null; objs[which] = ''; return; }
              entry[which] = Pack.ref(o); objs[which] = o.sha256; o.blobs.forEach(function (bl) { blobs[bl.sha] = bl.data; });
            });
          }
          return Promise.resolve(take('text')).then(function () { return take('vec'); }).then(function () { return take('mem'); }).then(function () {
            if (item.meta || needText) { what.meta = 1; }
            entry.m = inv.meta; entry.ts = t0; ours.sources[uri] = entry; delete ours.removed[uri];
            marks.push({ uri: uri, inv: inv, what: what, objs: objs });
            done++; tell({ stage: 'pack', done: done, total: d.items.length });
          });
        }).then(function () { ours.folders = x[2] || []; return { ours: ours, blobs: blobs, marks: marks, forgets: forgets, dirty: d.items.length + d.deleted.length }; });
      });
    }

    function referenced(man) { var s = {}; Object.keys(man.sources || {}).forEach(function (u) { Pack.entryParts(man.sources[u]).forEach(function (b) { s[b] = 1; }); }); return s; }

    function upload(shas, blobs) {
      if (!shas.length) { return Promise.resolve({ blobs: 0, bytes: 0 }); }
      return http.blobsMissing(shas).then(function (missing) {
        var total = 0, sent = 0; missing.forEach(function (s) { total += blobs[s] ? blobs[s].length : 0; });
        return pool(missing, 3, function (sha) {
          if (!blobs[sha]) { throw new Error('a blob the server lacks is not here either (' + sha.slice(0, 12) + ')'); }
          return http.putBlob(sha, blobs[sha]).then(function () { sent += blobs[sha].length; tell({ stage: 'upload', unit: 'bytes', done: sent, total: total }); });
        }).then(function () { return { blobs: missing.length, bytes: total }; });
      });
    }

    function sync(name, opts) {
      opts = opts || {}; name = name || 'default';
      var report = { pushed: { sources: 0, objects: 0, blobs: 0, bytes: 0 }, removed: 0, rounds: 0 };
      function round(n) {
        if (n > 5) { return Promise.reject(new Error('the library keeps changing on the server: try again')); }
        report.rounds = n + 1;
        return Promise.all([getBase(), http.getRoot(name)]).then(function (x) {
          var base = x[0], rootRes = x[1];
          return (rootRes ? loadManifest(rootRes.root.manifest) : Promise.resolve(Pack.emptyManifest())).then(function (theirs) {
            var tv = rootRes ? String(rootRes.version) : '';
            return buildOurs(base.manifest, theirs).then(function (b) {
              var merged = Pack.pruneTombstones(Pack.merge3(base.manifest, b.ours, theirs), now(), 60), changed = !Pack.equalManifests(merged, theirs) || (!rootRes && b.dirty > 0);
              if (!changed) { return finish(name, merged, tv, b, base, report); }
              // the blobs this merge adds on top of the server's copy, then the manifest, then the root
              var have = referenced(theirs), need = Object.keys(referenced(merged)).filter(function (s) { return !have[s]; });
              return upload(need, b.blobs).then(function (u) {
                report.pushed.blobs += u.blobs; report.pushed.bytes += u.bytes;
                return K.gzip(enc.encode(JSON.stringify(merged))).then(function (zb) { return K.makeObject(zb); }).then(function (mo) {
                  var mblobs = {}; mo.blobs.forEach(function (bl) { mblobs[bl.sha] = bl.data; });
                  return upload(mo.blobs.map(function (bl) { return bl.sha; }), mblobs).then(function () {
                    return http.commitRoot(name, { format: Pack.FORMAT, lib: name, manifest: Pack.ref(mo), created: now() }, tv).then(function (res) {
                      manifestCache[mo.sha256] = merged;
                      return finish(name, merged, String(res.version), b, base, report);
                    }, function (e) { if (e && e.conflict) { return round(n + 1); } throw e; });
                  });
                });
              });
            });
          });
        });
      }
      return round(0);
    }

    // after the root is settled: bookkeeping of what was pushed, removals by others, folders, the base for the next merge, and the list of objects still to download
    function finish(name, merged, version, b, base, report) {
      var ps = [];
      b.marks.forEach(function (m) { report.pushed.sources++; report.pushed.objects += Object.keys(m.objs).filter(function (k) { return m.objs[k]; }).length; ps.push(function () { return rpc('markSynced', { inv: m.inv, what: m.what, objs: m.objs }); }); });
      b.forgets.forEach(function (u) { ps.push(function () { return rpc('forgetSynced', { uri: u }); }); });
      return ps.reduce(function (p, fn) { return p.then(fn); }, Promise.resolve()).then(function () { return rpc('syncState', {}); }).then(function (state) {
        var gone = Object.keys(merged.removed || {}).filter(function (u) { return state[u]; });
        return gone.reduce(function (p, u) { return p.then(function () { report.removed++; return rpc('removeByUri', { uri: u }).then(function () { return rpc('forgetSynced', { uri: u }); }); }); }, Promise.resolve()).then(function () {
          return rpc('foldersSet', { folders: merged.folders || [] });
        }).then(function () { return setBase(merged, version); }).then(function () { return tasksFor(merged, null); }).then(function (tasks) {
          report.version = version; report.merged = merged; report.tasks = tasks; return report;
        });
      });
    }

    // what is still to be downloaded or applied: per source, which objects the local copy lacks (compared with the object shas recorded when they were applied / pushed)
    function tasksFor(man, stateIn) {
      return (stateIn ? Promise.resolve(stateIn) : rpc('syncState', {})).then(function (state) {
        var out = [];
        Object.keys(man.sources).forEach(function (uri) {
          var e = man.sources[uri], s = state[uri], t = { uri: uri, entry: e, text: false, vec: false, mem: false, meta: false };
          if (!s || s.text_obj !== shaOf(e.text)) { t.text = true; t.vec = !!e.vec; t.mem = !!e.mem; }
          else { t.vec = !!e.vec && s.vec_obj !== shaOf(e.vec); t.mem = !!e.mem && s.mem_obj !== shaOf(e.mem); }
          if (s && s.meta_sig !== metaSigOf(e.m)) { t.meta = true; }
          if (t.text || t.vec || t.mem || t.meta) { out.push(t); }
        });
        return out;
      });
    }
    // the integrity check, run after every sync: a source of this copy that lacks vectors the server HAS (a lost write, an interrupted load) gets them from the server's vector object -- never computed again
    function heal() {
      return Promise.all([getBase(), rpc('embeddingBySource', {}), rpc('sources', {})]).then(function (x) {
        var man = x[0].manifest, per = x[1], uriOf = {}, rep = { checked: per.length, gaps: 0, fixed: 0, vectors: 0 };
        x[2].forEach(function (s) { uriOf[s.id] = s.uri; });
        var bad = per.filter(function (p) { return p.chunks > p.embedded; });
        rep.gaps = bad.length;
        var fixable = bad.filter(function (p) { var e = man.sources[uriOf[p.source_id]]; return e && e.vec; });
        return fixable.reduce(function (chain, p) {
          return chain.then(function () {
            var uri = uriOf[p.source_id], e = man.sources[uri];
            return fetchObject(e.vec).then(function (bytes) { return rpc('applyObject', { kind: 'vec', uri: uri, bytes: bytes }); }).then(function (r) {
              rep.fixed++; rep.vectors += (r && r.vectors) || 0; return rpc('markSynced', { uri: uri, what: { vec: 1 }, objs: { vec: shaOf(e.vec) } });
            });
          });
        }, Promise.resolve()).then(function () { return rep; });
      });
    }
    function tasks(name) { return getBase().then(function (b) { return tasksFor(b.manifest); }); }

    // download + apply. Text and vectors of every source first (each source is searchable as soon as its text is in), the memory afterwards; `first` = uris wanted before the rest
    function loadObjects(name, list, opts) {
      opts = opts || {}; var first = {}; (opts.first || []).forEach(function (u) { first[u] = 1; });
      var stop = opts.shouldStop || function () { return false; };
      var metaOnly = list.filter(function (t) { return t.meta && !t.text; }), main = list.filter(function (t) { return t.text || t.vec; }), memTasks = list.filter(function (t) { return t.mem; });
      main.sort(function (a, b) { return (first[b.uri] ? 1 : 0) - (first[a.uri] ? 1 : 0); });
      var counts = { text: { done: 0, total: main.length }, mem: { done: 0, total: memTasks.length } }, report = { text: 0, vec: 0, mem: 0, failed: [] };
      function bump(uri, stage) { var c = counts[stage]; c.done++; tell({ stage: 'load', phase: stage, done: c.done, total: c.total, uri: uri }); }   // each phase counts for itself (text + vectors, then memory)
      function fetchApply(t, kind) {
        var e = t.entry, refObj = e[kind];
        return fetchObject(refObj).then(function (bytes) { return rpc('applyObject', { kind: kind, uri: t.uri, bytes: bytes, meta: e.m }); });
      }
      function markApplied(t, what, objs) { return rpc('markSynced', { uri: t.uri, what: what, objs: objs }); }
      var chain = Promise.resolve();
      metaOnly.forEach(function (t) { chain = chain.then(function () { return rpc('applyMeta', { uri: t.uri, meta: t.entry.m }).then(function () { return markApplied(t, { meta: 1 }, {}); }); }); });
      // text + vectors: the next source's blobs are fetched while this one is applied (a window of 3)
      var prefetched = {};
      function prefetch(i) {
        var t = main[i]; if (!t || prefetched[i]) { return; }
        prefetched[i] = Promise.all([t.text ? fetchObject(t.entry.text) : null, t.vec && t.entry.vec ? fetchObject(t.entry.vec) : null]).then(null, function (e) { return { error: e }; });
      }
      main.forEach(function (t, i) {
        chain = chain.then(function () {
          if (stop()) { return null; }
          prefetch(i); prefetch(i + 1); prefetch(i + 2);
          return prefetched[i].then(function (got) {
            if (got && got.error) { throw got.error; }
            delete prefetched[i];
            var p = Promise.resolve();
            if (t.text) {
              p = p.then(function () { return rpc('applyObject', { kind: 'text', uri: t.uri, bytes: got[0], meta: t.entry.m }); }).then(function (r) {
                if (!r || !r.ok) { throw new Error('applying the text failed' + (r && r.error ? ': ' + r.error : '')); }
                report.text++;
                // the vectors / memory of the OLD text are gone with it: record that, so they are not mistaken for changes made here
                return markApplied(t, { text: 1, vec: 1, mem: 1, meta: 1 }, { text: shaOf(t.entry.text), vec: '', mem: '' });
              });
            }
            if (t.vec && t.entry.vec) {
              p = p.then(function () { return rpc('applyObject', { kind: 'vec', uri: t.uri, bytes: got[1] }); }).then(function (r) { report.vec++; return markApplied(t, { vec: 1 }, { vec: shaOf(t.entry.vec) }); });
            }
            return p.then(function () { bump(t.uri, 'text'); });
          }).then(null, function (e) { report.failed.push({ uri: t.uri, error: String(e && e.message || e) }); bump(t.uri, 'text'); });
        });
      });
      // memory last, in the background
      memTasks.forEach(function (t) {
        chain = chain.then(function () {
          if (stop()) { return null; }
          return fetchApply(t, 'mem').then(function (r) { report.mem++; return markApplied(t, { mem: 1 }, { mem: shaOf(t.entry.mem) }); }).then(function () { bump(t.uri, 'mem'); }, function (e) { report.failed.push({ uri: t.uri, error: String(e && e.message || e) }); bump(t.uri, 'mem'); });
        });
      });
      return chain.then(function () { return report; });
    }

    return { heal: heal, sync: sync, loadObjects: loadObjects, tasks: tasks, baseInfo: getBase, tasksFor: tasksFor, loadManifest: loadManifest };
  }

  var api = { create: create, httpFor: httpFor };
  root.KeepLookupRepo = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
