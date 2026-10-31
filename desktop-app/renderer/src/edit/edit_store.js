// Where /edit-svg and /edit-picture keep their projects (IndexedDB of THIS browser; nothing on the server): the project (document + the editor's own steps and talk) under  project/<kind>/<id>,
// and every PICTURE once under  img/<ref>  as a Blob -- the document only holds the short ref, so forty undo steps do not hold forty copies of a photo.
//   FaEditStore.saveProject(kind, id, obj)   loadProject(kind, id)   putImage(blob) -> Promise<ref>   getImage(ref) -> Promise<Blob|null>   imageUrl(ref) -> data URL once loaded (sync)   preload(refs) -> Promise
//   dataUrl(blob) -> Promise<string>      newId(prefix)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaEditStore = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var DB = null, urls = {}, blobs = {};
  function idb() {
    if (!DB) { DB = new Promise(function (res, rej) { var rq = indexedDB.open('tw_edit', 1); rq.onupgradeneeded = function () { rq.result.createObjectStore('kv'); }; rq.onsuccess = function () { res(rq.result); }; rq.onerror = function () { rej(rq.error || new Error('IndexedDB is not available')); }; }); }
    return DB;
  }
  function tx(mode, fn) { return idb().then(function (db) { return new Promise(function (res, rej) { var t = db.transaction('kv', mode), rq = fn(t.objectStore('kv')); t.oncomplete = function () { res(rq && rq.result !== undefined ? rq.result : undefined); }; t.onerror = function () { rej(t.error); }; t.onabort = function () { rej(t.error); }; }); }); }
  function dataUrl(blob) { return new Promise(function (res, rej) { var fr = new FileReader(); fr.onload = function () { res(String(fr.result)); }; fr.onerror = function () { rej(fr.error); }; fr.readAsDataURL(blob); }); }
  function newId(p) { return (p || 'e') + Date.now().toString(36) + Math.random().toString(36).slice(2, 5); }
  function saveProject(kind, id, obj) { return tx('readwrite', function (s) { return s.put(JSON.stringify(obj), 'project/' + kind + '/' + id); }); }
  function loadProject(kind, id) { return tx('readonly', function (s) { return s.get('project/' + kind + '/' + id); }).then(function (t) { if (t == null) { return null; } try { return JSON.parse(t); } catch (e) { return null; } }); }
  function putImage(blob) {
    var ref = newId('img'); blobs[ref] = blob;
    return tx('readwrite', function (s) { return s.put(blob, 'img/' + ref); }).then(function () { return dataUrl(blob); }).then(function (u) { urls[ref] = u; return ref; });
  }
  // 遠端編輯器橋接用：把別台傳來的素材存成「同一個 ref」（文件只存 ref，兩台對得上）
  function putImageAs(ref, blob) { if (!/^[A-Za-z0-9_-]{1,64}$/.test(String(ref))) { return Promise.reject(new Error('bad ref')); } blobs[ref] = blob; return tx('readwrite', function (s) { return s.put(blob, 'img/' + ref); }).then(function () { return dataUrl(blob); }).then(function (u) { urls[ref] = u; return ref; }); }
  function hasImage(ref) { if (blobs[ref]) { return Promise.resolve(true); } return tx('readonly', function (s) { return s.get('img/' + ref); }).then(function (b) { return !!b; }); }
  function getImage(ref) { if (blobs[ref]) { return Promise.resolve(blobs[ref]); } return tx('readonly', function (s) { return s.get('img/' + ref); }).then(function (b) { if (b) { blobs[ref] = b; } return b || null; }); }
  function preload(refs) { return Promise.all((refs || []).filter(function (r) { return !urls[r]; }).map(function (r) { return getImage(r).then(function (b) { return b ? dataUrl(b).then(function (u) { urls[r] = u; }) : null; }); })); }
  function imageUrl(ref) { return urls[ref] || ''; }
  return { saveProject: saveProject, loadProject: loadProject, putImage: putImage, putImageAs: putImageAs, hasImage: hasImage, getImage: getImage, preload: preload, imageUrl: imageUrl, dataUrl: dataUrl, newId: newId };
});
