// /edit-video: the in-browser job queue ("enqueue"). Pure state machine, no DOM, tested in Node: test/edit_video/video_jobs.test.js. Design: DESIGN.edit-video.md "逐字稿產生與瀏覽器工作佇列".
// ONE job runs at a time (a Whisper worker is heavy); the others wait in the order they were enqueued. A job is {id, kind, label, status, progress, error, createdAt, payload, result}.
//   status: queued -> running -> done | failed | canceled ;  a job that was queued/running when the page went away comes back as 'interrupted' (restore()) and can be retried.
//   var q = TwVideoJobs.create({ run(job, report) -> { promise, cancel() }, onChange(list) , now? })
//   q.enqueue({kind, label, payload}) -> id   q.cancel(id)   q.retry(id)   q.remove(id)   q.clearFinished()   q.patch(id, {..})   q.list()   q.get(id)   q.serialize()   q.restore(list)
//   run() is the only place that does real work: report(text) posts a progress line; the promise resolves with the job's result or rejects with an Error. The result is kept in memory only (serialize() leaves it out).
(function (root, factory) { if (typeof module === 'object' && module.exports) { module.exports = factory(); } else { root.TwVideoJobs = factory(); } }(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var MAX_JOBS = 50, FINAL = { done: 1, failed: 1, canceled: 1, interrupted: 1 };
  function create(o) {
    var jobs = [], seq = 0, current = null, handle = null, now = o.now || function () { return Date.now(); };
    function emit() { if (o.onChange) { try { o.onChange(jobs.map(copy)); } catch (e) { /* the UI's problem */ } } }
    function copy(j) { return Object.assign({}, j); }
    function find(id) { for (var i = 0; i < jobs.length; i++) { if (jobs[i].id === id) { return jobs[i]; } } return null; }
    function pump() {
      if (current) { return; }
      var j = jobs.filter(function (x) { return x.status === 'queued'; })[0]; if (!j) { return; }
      current = j; j.status = 'running'; j.progress = ''; emit();
      var finished = false;
      function end(status, patch) { if (finished || current !== j) { return; } finished = true; Object.assign(j, patch || {}, { status: status }); current = null; handle = null; emit(); pump(); }
      try {
        handle = o.run(copy(j), function (text) { if (current === j && j.status === 'running') { j.progress = String(text == null ? '' : text); emit(); } });
        Promise.resolve(handle && handle.promise).then(function (res) { end('done', { result: res, progress: '' }); }, function (e) { end('failed', { error: String((e && e.message) || e) }); });
      } catch (e) { end('failed', { error: String((e && e.message) || e) }); }
    }
    function enqueue(spec) {
      if (jobs.length >= MAX_JOBS) { jobs = jobs.filter(function (x) { return !FINAL[x.status]; }); if (jobs.length >= MAX_JOBS) { return null; } }
      var j = { id: 'j' + (++seq), kind: String(spec.kind || ''), label: String(spec.label || ''), status: 'queued', progress: '', error: '', createdAt: now(), payload: spec.payload || {}, result: null };
      jobs.push(j); emit(); pump(); return j.id;
    }
    function cancel(id) {
      var j = find(id); if (!j) { return false; }
      if (j.status === 'queued') { j.status = 'canceled'; emit(); return true; }
      if (j.status === 'running' && current === j) { var h = handle; j.status = 'canceled'; current = null; handle = null; try { if (h && h.cancel) { h.cancel(); } } catch (e) { /* already gone */ } emit(); pump(); return true; }
      return false;
    }
    function retry(id) { var j = find(id); if (!j || !(j.status === 'failed' || j.status === 'canceled' || j.status === 'interrupted')) { return false; } j.status = 'queued'; j.error = ''; j.progress = ''; j.result = null; emit(); pump(); return true; }
    function remove(id) { var j = find(id); if (!j || j.status === 'running') { return false; } jobs = jobs.filter(function (x) { return x !== j; }); emit(); return true; }
    function clearFinished() { jobs = jobs.filter(function (x) { return !FINAL[x.status]; }); emit(); }
    // keep something small about a finished job that must survive a refresh (e.g. where its output file is stored); shown in serialize()
    function patch(id, p) { var j = find(id); if (!j || !p || typeof p !== 'object') { return false; } Object.assign(j.payload, p); emit(); return true; }
    function serialize() { return jobs.map(function (j) { return { id: j.id, kind: j.kind, label: j.label, status: j.status, error: j.error, createdAt: j.createdAt, payload: j.payload }; }); }
    // a saved list: whatever was waiting or running is 'interrupted' now (nothing is resumed behind the user's back)
    function restore(list) {
      jobs = []; (Array.isArray(list) ? list : []).slice(0, MAX_JOBS).forEach(function (j) {
        if (!j || typeof j.id !== 'string' || !/^j\d+$/.test(j.id)) { return; }
        var st = FINAL[j.status] ? j.status : 'interrupted'; seq = Math.max(seq, +j.id.slice(1));
        jobs.push({ id: j.id, kind: String(j.kind || ''), label: String(j.label || ''), status: st, progress: '', error: String(j.error || ''), createdAt: +j.createdAt || 0, payload: j.payload && typeof j.payload === 'object' ? j.payload : {}, result: null });
      }); emit();
    }
    return { enqueue: enqueue, cancel: cancel, retry: retry, remove: remove, patch: patch, clearFinished: clearFinished, list: function () { return jobs.map(copy); }, get: function (id) { var j = find(id); return j ? copy(j) : null; }, serialize: serialize, restore: restore };
  }
  return { create: create, MAX_JOBS: MAX_JOBS };
}));
