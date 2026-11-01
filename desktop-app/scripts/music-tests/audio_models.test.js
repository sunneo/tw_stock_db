// node scripts/music-tests/audio_models.test.js -- 模型分片下載:續傳、核對、重試、不支援 Range、檢查碼錯誤
const crypto = require('crypto');
const D = require('../../renderer/src/music/audio_models.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const data = crypto.randomBytes(D.CHUNK * 2 + 12345); const sha = (u8) => Promise.resolve(crypto.createHash('sha256').update(u8).digest('hex'));
D.REGISTRY.test = { id: 'test', label: '測試模型', url: 'http://x/t.onnx', bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex') };
const mkStore = () => { const m = new Map(); return { m, get: async (k) => m.get(k) || null, set: async (k, v) => { m.set(k, Uint8Array.from(v)); }, del: async (k) => { m.delete(k); } }; };
const mkFetch = (o) => { o = o || {}; o.calls = 0; return async (url, h) => { o.calls++; if (o.fail && o.calls <= o.fail) return { status: 503, arrayBuffer: async () => new ArrayBuffer(0) }; const mt = /bytes=(\d+)-(\d+)/.exec(h.Range); const buf = o.noRange ? data : data.subarray(+mt[1], +mt[2] + 1); return { status: o.noRange ? 200 : 206, arrayBuffer: async () => Uint8Array.from(buf).buffer }; }; };
(async () => {
  let st = mkStore(), o = {}, prog = [];
  let r = await D.fetchModel('test', { fetchFn: mkFetch(o), store: st, sha256: sha, onProgress: (p) => prog.push(p) });
  check('full download matches, three chunks, progress reaches total', Buffer.compare(Buffer.from(r), data) === 0 && o.calls === 3 && prog[prog.length - 1].done === data.length && prog.length === 3, [o.calls, prog.length]);
  const o2 = {}; r = await D.fetchModel('test', { fetchFn: mkFetch(o2), store: st, sha256: sha });
  check('second run is served from the store without any request', o2.calls === 0 && r.length === data.length);
  st.m.delete([...st.m.keys()][1]); const o3 = {}; r = await D.fetchModel('test', { fetchFn: mkFetch(o3), store: st, sha256: sha });
  check('resume: only the missing chunk is requested', o3.calls === 1 && r.length === data.length, o3.calls);
  const o4 = { fail: 2 }; r = await D.fetchModel('test', { fetchFn: mkFetch(o4), store: mkStore(), sha256: sha, sleep: async () => {} });
  check('transient 503s are retried on their own', r.length === data.length && o4.calls === 5, o4.calls);
  let err = null; try { await D.fetchModel('test', { fetchFn: mkFetch({ fail: 99 }), store: mkStore(), sha256: sha, sleep: async () => {} }); } catch (e) { err = e; }
  check('persistent failure says HTTP status and attempt count', err && /HTTP 503/.test(err.message) && /4 次/.test(err.message), err && err.message);
  const o5 = { noRange: true }; r = await D.fetchModel('test', { fetchFn: mkFetch(o5), store: mkStore(), sha256: sha });
  check('server that ignores Range (full 200) still works', Buffer.compare(Buffer.from(r), data) === 0);
  const st6 = mkStore(); err = null; try { await D.fetchModel('test', { fetchFn: mkFetch(), store: st6, sha256: async () => 'deadbeef' + '0'.repeat(56) }); } catch (e) { err = e; }
  check('wrong checksum throws and clears the cache', err && /檢查碼不符/.test(err.message) && st6.m.size === 0, err && err.message);
  check('registry sizes and checksums are the verified ones', D.REGISTRY['basic-pitch'].bytes === 230444 && D.REGISTRY['yamnet'].bytes === 16093355 && D.REGISTRY['demucs-6s'].bytes === 136428532 && Object.values(D.REGISTRY).every((m) => m.id === 'test' || /^[0-9a-f]{64}$/.test(m.sha256)));
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
})();
