// node test/keeplookup/pack.test.js -- keeplookup group library v2: objects (encode / decode / blobs) and the 3-way merge of manifests
var path = require('path');
var root = path.join(__dirname, '..', '..', 'renderer', 'src', 'knowledge', 'repo');

var P = require(path.join(root, 'keeplookup_pack.js'));
var pass = 0, fail = 0;
function ok(c, m, x) { if (c) { pass++; } else { fail++; console.log('FAIL: ' + m + (x === undefined ? '' : ' ' + JSON.stringify(x))); } }

var K = P.create();
function ref(sha, n) { return { sha256: sha, bytes: n || 1, blobs: [sha + 'b'] }; }
function entry(text, o) { o = o || {}; return { text: ref(text), vec: o.vec ? ref(o.vec) : null, mem: o.mem ? ref(o.mem) : null, m: Object.assign({ title: 't', folder: '' }, o.m), ts: o.ts || 1 }; }
function man(sources, removed, folders, meta) { return { format: 2, sources: sources || {}, removed: removed || {}, folders: folders || [], meta: meta || {} }; }

(async function () {
  // ---- objects round trip
  var tx = { meta: { kind: 'file', uri: 'file:a.pdf', mime: 'application/pdf', parser: 'pdf', bytes: 99 }, lines: [{ no: 1, locator: 'p1', text: '你好 world' }, { no: 2, locator: null, text: 'second' }], sections: [{ depth: 1, title: 'T', line_from: 1, line_to: null }] };
  var gz = await K.encodeText(tx), back = await K.decodeText(gz);
  ok(JSON.stringify(back) === JSON.stringify(tx), 'a text object round-trips (utf-8, null locator, open section end)', back);
  var v = { chunker: 3, chunks: [{ line_from: 1, line_to: 2, model: 'm', dim: 4, vec: new Uint8Array([1, 2, 3, 250]) }, { line_from: 2, line_to: 5, model: 'm', dim: 4, vec: new Uint8Array([9, 8, 7, 6]) }] };
  var vb = await K.decodeVec(await K.encodeVec(v));
  ok(vb.chunker === 3 && vb.chunks.length === 2 && Array.prototype.join.call(vb.chunks[0].vec) === '1,2,3,250' && vb.chunks[1].line_to === 5 && vb.chunks[1].model === 'm', 'a vector object round-trips (bytes, ranges, model, chunker)', vb);
  var mem = { overview: 'ov', keywords: 'k', model: 'x', created_at: 7, parts: [{ level: 2, line_from: 1, line_to: 9, md: 'notes' }] };
  ok(JSON.stringify(await K.decodeMem(await K.encodeMem(mem))) === JSON.stringify(mem), 'a memory object round-trips');
  // ---- content addressing: same content = same sha, the blob list joins back, a damaged blob is refused
  var o1 = await K.makeObject(gz), o2 = await K.makeObject(await K.encodeText(tx));
  ok(o1.sha256 === o2.sha256 && o1.blobs.length === 1 && o1.blobs[0].sha === o1.sha256, 'the same content gives the same object sha (deterministic encoding); a small object is one blob');
  var big = new Uint8Array(P.BLOB_MAX + 10); for (var i = 0; i < big.length; i++) { big[i] = (i * 31) & 255; }
  var ob = await K.makeObject(big);
  ok(ob.blobs.length === 2 && ob.blobs[0].data.length === P.BLOB_MAX, 'an object bigger than a blob is cut into blobs');
  var joined = await K.joinObject(P.ref(ob), ob.blobs.map(function (b) { return b.data; }));
  ok(joined.length === big.length && joined[12345] === big[12345], 'the blobs join back into the object');
  var bad = ob.blobs.map(function (b) { return b.data.slice(); }); bad[1][3] ^= 1;
  var err = null; try { await K.joinObject(P.ref(ob), bad); } catch (e) { err = e; }
  ok(err && /damaged/.test(err.message), 'a damaged blob is refused (sha256 of the joined object)', err && err.message);
  ok(JSON.stringify(P.ref(ob).blobs) === JSON.stringify(ob.blobs.map(function (b) { return b.sha; })), 'a manifest reference keeps only blob shas');

  // ---- merge3
  var base = man({ a: entry('a1'), b: entry('b1') }, {}, ['F'], { x: 1 });
  var r;
  r = P.merge3(base, base, base); ok(P.equalManifests(r, base), 'nothing changed: the same manifest');
  // my change, nobody else
  r = P.merge3(base, man({ a: entry('a2', { ts: 5 }), b: entry('b1') }, {}, ['F'], { x: 1 }), base);
  ok(r.sources.a.text.sha256 === 'a2' && r.sources.b.text.sha256 === 'b1', 'only I changed a source: mine');
  // their change, nobody else
  r = P.merge3(base, base, man({ a: entry('a1'), b: entry('b2', { ts: 5 }) }, {}, ['F'], { x: 1 }));
  ok(r.sources.b.text.sha256 === 'b2', 'only they changed a source: theirs');
  // THE bug: I removed a, they did not touch it (still there, as in base) -> stays removed
  r = P.merge3(base, man({ b: entry('b1') }, { a: 10 }, ['F'], { x: 1 }), base);
  ok(!r.sources.a && r.removed.a === 10 && r.sources.b, 'I removed a source, the server copy still has it unchanged: it stays removed (the resurrection bug)');
  // they removed, I did not touch
  r = P.merge3(base, base, man({ b: entry('b1') }, { a: 10 }, ['F'], { x: 1 }));
  ok(!r.sources.a && r.removed.a === 10, 'they removed a source I did not touch: removed');
  // removed by me, changed by them later: the change wins; changed earlier than the removal: the removal wins
  r = P.merge3(base, man({ b: entry('b1') }, { a: 10 }), man({ a: entry('a3', { ts: 20 }), b: entry('b1') }));
  ok(r.sources.a && r.sources.a.text.sha256 === 'a3' && !r.removed.a, 'removed by me at 10, changed by them at 20: the newer change wins');
  r = P.merge3(base, man({ b: entry('b1') }, { a: 30 }), man({ a: entry('a3', { ts: 20 }), b: entry('b1') }));
  ok(!r.sources.a && r.removed.a === 30, 'removed at 30, changed at 20: the removal wins');
  // a copy re-adds a removed uri on purpose (entry newer than the tombstone)
  r = P.merge3(man({ a: entry('a1') }), man({ a: entry('a9', { ts: 50 }) }), man({}, { a: 40 }));
  ok(r.sources.a && r.sources.a.text.sha256 === 'a9' && !r.removed.a, 'a source copied in again after its removal comes back (its ts is later than the tombstone)');
  // both added the same uri with the same content / different content
  r = P.merge3(man(), man({ n: entry('n1', { ts: 3 }) }), man({ n: entry('n1', { ts: 4 }) }));
  ok(r.sources.n.text.sha256 === 'n1', 'both added the same content: one source');
  r = P.merge3(man(), man({ n: entry('nA', { ts: 3 }) }), man({ n: entry('nB', { ts: 4 }) }));
  ok(r.sources.n.text.sha256 === 'nB', 'both added different content under one uri: the newer');
  // I computed vectors, they added memory: both kept
  r = P.merge3(base, man({ a: entry('a1', { vec: 'v1', ts: 5 }), b: entry('b1') }, {}, ['F'], { x: 1 }), man({ a: entry('a1', { mem: 'm1', ts: 6 }), b: entry('b1') }, {}, ['F'], { x: 1 }));
  ok(r.sources.a.vec && r.sources.a.vec.sha256 === 'v1' && r.sources.a.mem && r.sources.a.mem.sha256 === 'm1', 'I added vectors, they added memory: the merged source has both');
  // I moved it to another folder, they added memory
  r = P.merge3(base, man({ a: entry('a1', { m: { title: 't', folder: 'X' }, ts: 5 }), b: entry('b1') }), man({ a: entry('a1', { mem: 'm1', ts: 6 }), b: entry('b1') }));
  ok(r.sources.a.m.folder === 'X' && r.sources.a.mem.sha256 === 'm1', 'I moved the source, they added memory: both kept');
  // the text changed on one side: a vec / mem computed for the OLD text of the other side must not be attached to the new text
  r = P.merge3(man({ a: entry('a1', { vec: 'v1' }) }), man({ a: entry('a2', { ts: 5 }) }), man({ a: entry('a1', { vec: 'v1', mem: 'm1', ts: 6 }) }));
  ok(r.sources.a.text.sha256 === 'a2' && !r.sources.a.vec && !r.sources.a.mem, 'new text on my side: their vectors / memory of the old text are dropped');
  // folders and meta
  r = P.merge3(man({}, {}, ['A', 'B']), man({}, {}, ['A', 'B', 'C']), man({}, {}, ['A']));
  ok(JSON.stringify(r.folders) === JSON.stringify(['A', 'C']), 'folders: B removed by them stays removed, C added by me is kept', r.folders);
  r = P.merge3(man({}, {}, [], { q: 1, z: 1 }), man({}, {}, [], { q: 2, z: 1 }), man({}, {}, [], { q: 1, z: 5 }));
  ok(r.meta.q === 2 && r.meta.z === 5, 'meta: each setting from the side that changed it', r.meta);
  // a lazily loaded source (never pulled) is simply the base entry on my side: nothing of mine, theirs wins
  r = P.merge3(base, base, man({ a: entry('a1'), b: entry('b2', { ts: 9 }) }, {}, ['F'], { x: 1 }));
  ok(r.sources.b.text.sha256 === 'b2' && r.sources.a.text.sha256 === 'a1', 'a source I never downloaded is not treated as removed');
  // tombstones expire
  var pm = P.pruneTombstones(man({}, { old: 1000, fresh: Date.now() }), Date.now(), 60);
  ok(!('old' in pm.removed) && 'fresh' in pm.removed, 'old tombstones are forgotten, fresh ones stay');
  ok(P.entryParts(entry('t1', { vec: 'v1', mem: 'm1' })).join() === 't1b,v1b,m1b', 'entryParts lists every blob of an entry');
  console.log('keeplookup pack: ' + pass + ' passed, ' + fail + ' failed'); process.exit(fail ? 1 : 0);
})();
