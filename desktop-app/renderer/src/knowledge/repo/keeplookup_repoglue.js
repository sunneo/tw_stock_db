// keeplookup (藏書閣) group library v2, the PAGE side (DESIGN.keeplookup-objects.md): which libraries are repository libraries, when they sync, the background download of their objects, progress for the UI.
//   create({ rpc, groupUrl: () => url | null, csrf, diag(lib, text), emit(lib, event), Pack, Repo, fetch? }) -> {
//     isRepo(lib), setRepo(lib, on), probe(lib) -> 'v2' | 'v1' | 'new',
//     push(lib) -> Promise   sync now (serialized per library); resolves when the push / merge is done -- the download of the objects that arrived goes on in the background
//     idle(lib) -> Promise   resolves when nothing is syncing or downloading,   progress(lib) -> { loading: { done, total } | null },   forget(lib) }
(function (root) {
  'use strict';
  var SERVER_LIB = 'default';   // the name of the library on the server (one library per group)

  function create(env) {
    var libs = {}, flags = {}, engines = {};
    function S(name) { return libs[name] || (libs[name] = { chain: Promise.resolve(), want: 0, active: 0, pending: [], loading: null, first: [] }); }
    function groupId(name) { return Number(String(name).replace('group-', '')); }
    function http(name) { return env.Repo.httpFor({ url: env.groupUrl() + '/' + encodeURIComponent(groupId(name)), csrf: env.csrf, fetch: env.fetch }); }
    function engine(name) {
      if (engines[name]) { return engines[name]; }
      var s = S(name);
      engines[name] = env.Repo.create({ http: http(name), Pack: env.Pack, rpc: function (op, args) { return env.rpc(op, Object.assign({ lib: name }, args || {})); },
        onProgress: function (p) {
          if (p.stage === 'pack') { env.emit(name, { sync: { unit: 'items', phase: 'export', done: p.done, total: p.total } }); }
          else if (p.stage === 'upload') { env.emit(name, { sync: { unit: 'bytes', phase: 'upload', done: p.done, total: p.total } }); }
          else if (p.stage === 'load') {
            s.loading = { done: p.done, total: p.total };
            env.emit(name, { sync: { unit: 'items', phase: p.phase === 'mem' ? 'memory' : 'load', done: p.done, total: p.total }, sourcesChanged: true });
          }
        } });
      return engines[name];
    }
    function enqueue(name, fn) { var s = S(name); s.active++; var p = s.chain.then(fn); s.chain = p.then(null, function () { return null; }).then(function () { s.active--; }); return p; }

    // the library is as complete as the server's: check this copy against it (vectors lost on the way are taken from the server, not computed), then let the organizer look at what is really missing
    function settle(name) {
      return engine(name).heal(SERVER_LIB).then(function (rep) {
        if (rep.gaps) { env.diag(name, 'repository: integrity check: ' + rep.gaps + ' source(s) lacked vectors, ' + rep.fixed + ' completed from the server (' + rep.vectors + ' vectors), ' + (rep.gaps - rep.fixed) + ' the server does not have either'); }
        if (rep.fixed) { env.emit(name, { sourcesChanged: true }); }
      }, function (e) { env.diag(name, 'repository: integrity check failed: ' + String(e && e.message || e)); }).then(function () { env.emit(name, { repoSettled: true }); });
    }
    function doSync(name) {
      var s = S(name); s.want = Math.max(0, s.want - 1);
      env.diag(name, 'repository: sync started');
      return engine(name).sync(SERVER_LIB).then(function (r) {
        env.emit(name, { sync: null });
        env.diag(name, 'repository: version ' + r.version + ' (' + r.rounds + ' round(s)); pushed ' + r.pushed.sources + ' source(s), ' + r.pushed.objects + ' object(s), ' + r.pushed.blobs + ' blob(s), ' + Math.round(r.pushed.bytes / 1024) + ' KB; removed here ' + r.removed + '; to download ' + r.tasks.length);
        s.pending = r.tasks;
        if (r.removed || r.tasks.length) { env.emit(name, { sourcesChanged: true }); }
        if (r.tasks.length) { enqueue(name, function () { return doLoad(name); }); } else if (s.want === 0) { return settle(name).then(function () { return r; }); }   // nothing to download: the library is complete as far as the server knows
        return r;
      }, function (e) { env.emit(name, { sync: null }); env.diag(name, 'repository: sync failed: ' + String(e && e.message || e)); throw e; });
    }
    function doLoad(name) {
      var s = S(name), tasks = s.pending; if (!tasks.length || s.want > 0) { return Promise.resolve(null); }
      env.diag(name, 'repository: downloading ' + tasks.length + ' source(s) (text and vectors first, memory after)');
      var t0 = Date.now();
      return engine(name).loadObjects(SERVER_LIB, tasks, { first: s.first, shouldStop: function () { return s.want > 0; } }).then(function (rep) {
        s.loading = null; env.emit(name, { sync: null, sourcesChanged: true });
        if (s.want > 0) { return rep; }   // a sync is waiting: it works out what is left and starts the download again
        s.pending = [];
        env.diag(name, 'repository: loaded ' + rep.text + ' text, ' + rep.vec + ' vector, ' + rep.mem + ' memory object(s) in ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s' + (rep.failed.length ? '; FAILED ' + rep.failed.length + ': ' + rep.failed.slice(0, 3).map(function (f) { return f.uri + ' (' + f.error + ')'; }).join(', ') : ''));
        // a few sources may have failed (a damaged blob): they stay "to download" and the next sync tries them again
        return settle(name).then(function () { return rep; });
      }, function (e) { s.loading = null; env.emit(name, { sync: null }); env.diag(name, 'repository: download failed: ' + String(e && e.message || e)); throw e; });
    }

    return {
      isRepo: function (name) { return !!flags[name]; },
      setRepo: function (name, on) { if (on) { flags[name] = true; } else { delete flags[name]; } },
      // what the group's library is on the server: 'v2' (a root exists), 'v1' (the old single-file library), 'new' (nothing yet)
      probe: function (name) {
        var h = http(name);
        return h.getRoot(SERVER_LIB).then(function (root) {
          if (root) { return 'v2'; }
          return h.status(SERVER_LIB).then(function (st) { return st && st.usable ? 'v1' : 'new'; });
        });
      },
      push: function (name) { var s = S(name); s.want++; return enqueue(name, function () { return doSync(name); }); },
      // sources to bring in first (the one the user is looking at)
      prefer: function (name, uris) { S(name).first = uris || []; },
      idle: function (name) { var s = S(name); return (function loop() { var c = s.chain; return c.then(function () { return s.chain === c ? null : loop(); }); })(); },
      // true while a sync is queued / running or objects are still to be downloaded: what is on this copy is not complete yet (the background organizer must not compute what the server already has)
      busy: function (name) { var s = S(name); return s.active > 0 || s.pending.length > 0; },
      progress: function (name) { var s = S(name); return { loading: s.loading, pending: s.pending.length }; },
      forget: function (name) { delete libs[name]; delete flags[name]; delete engines[name]; }
    };
  }
  var api = { create: create, SERVER_LIB: SERVER_LIB };
  root.KeepLookupRepoGlue = api;
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
