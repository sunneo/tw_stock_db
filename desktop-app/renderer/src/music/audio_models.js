// 音訊轉 MIDI 用的模型登錄與下載:分片(8 MB)、可續傳(每片存起來,中斷後只補缺的)、核對大小與 SHA-256、每片失敗自己重試。
// 三個模型的大小與檢查碼 2026-11-01 從 Hugging Face 檔案清單與實際下載核對過(下載後 SHA-256 與清單的 LFS 值一致)。
//   fetchFn(url, headers) → { status, headers.get(name), arrayBuffer() }  (瀏覽器就是 fetch)
//   store { get(key), set(key, Uint8Array), del(key) }  (瀏覽器用 IndexedDB;測試用 Map)
//   sha256(Uint8Array) → Promise<hex>
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAudioModels = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const MB = 1024 * 1024;
  const REGISTRY = {
    'basic-pitch': { id: 'basic-pitch', label: 'Basic Pitch(多音轉譜)', url: 'https://huggingface.co/daserge/basic-pitch-onnx/resolve/main/nmp.onnx', bytes: 230444, sha256: '2c3c1d144bfa61ad236e92e169c13535c880469a12a047d4e73451f2c059a0ec', license: 'Apache-2.0', source: 'spotify/basic-pitch' },
    'yamnet': { id: 'yamnet', label: 'YAMNet(樂器分類)', url: 'https://huggingface.co/audiomagic/yamnet-onnx/resolve/main/yamnet.onnx', bytes: 16093355, sha256: 'd3835ffbbd4a1bb3e777f0ca217b5007907f5171dd5d17c4236b95b2af8f908e', license: 'Apache-2.0(類別名稱 CC BY 4.0,Google AudioSet)', source: 'tensorflow/models yamnet' },
    'demucs-6s': { id: 'demucs-6s', label: 'Demucs 6 軌(分軌:鼓、貝斯、其他、人聲、吉他、鋼琴)', url: 'https://huggingface.co/adowu/htdemucs-6s-onnx/resolve/main/htdemucs_6s_fp16weights.onnx', bytes: 136428532, sha256: '7ce55792e2231c93fbf92de95f5fd5b3a5e6c89f7db690dfd693e8f1dce56869', license: 'MIT', source: 'facebookresearch/demucs' }
  };
  const CHUNK = 8 * MB;
  function cat(parts, total) { const out = new Uint8Array(total); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; }
  async function getChunk(m, i, opts) {
    const a = i * CHUNK, b = Math.min(m.bytes, a + CHUNK) - 1, want = b - a + 1; let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      if (opts.signal && opts.signal.aborted) throw Object.assign(new Error('已中斷'), { aborted: true });
      const t0 = Date.now();
      try {
        const r = await opts.fetchFn(m.url, { Range: 'bytes=' + a + '-' + b });
        if (r.status !== 206 && r.status !== 200) throw new Error('HTTP ' + r.status);
        let buf = new Uint8Array(await r.arrayBuffer());
        if (r.status === 200 && buf.length === m.bytes) buf = buf.subarray(a, b + 1); // 伺服器不支援 Range,回了整檔
        if (buf.length !== want) throw new Error('片段大小 ' + buf.length + ' 不等於 ' + want);
        return buf;
      } catch (e) { last = (e && e.message || e) + '(第 ' + (attempt + 1) + ' 次,' + (Date.now() - t0) + ' 毫秒)'; if (opts.sleep) await opts.sleep(500 * Math.pow(2, attempt)); }
    }
    throw new Error('下載 ' + m.label + ' 第 ' + (i + 1) + ' 片失敗,重試 4 次仍然失敗:' + last);
  }
  async function fetchModel(id, opts) {
    const m = REGISTRY[id]; if (!m) throw new Error('沒有這個模型:' + id); const n = Math.ceil(m.bytes / CHUNK), key = (i) => 'model:' + id + ':' + m.sha256.slice(0, 8) + ':' + i, onP = opts.onProgress || (() => {});
    const parts = []; let have = 0, resumed = 0;
    for (let i = 0; i < n; i++) {
      let c = await opts.store.get(key(i)); const want = Math.min(m.bytes, (i + 1) * CHUNK) - i * CHUNK;
      if (c && c.length === want) resumed++; else { c = await getChunk(m, i, opts); await opts.store.set(key(i), c); }
      parts.push(c); have += c.length; onP({ model: id, done: have, total: m.bytes, chunk: i + 1, chunks: n, resumed });
    }
    const all = cat(parts, have); if (all.length !== m.bytes) throw new Error(m.label + ' 大小不符:' + all.length + ' / ' + m.bytes);
    const h = await opts.sha256(all);
    if (h !== m.sha256) { for (let i = 0; i < n; i++) await opts.store.del(key(i)); throw new Error(m.label + ' 檢查碼不符(' + h.slice(0, 12) + '… 應為 ' + m.sha256.slice(0, 12) + '…),已清掉快取,請重試'); }
    return all;
  }
  // 瀏覽器端的 IndexedDB 儲存(資料庫 fa-a2m-models)
  function idbStore() {
    const open = () => new Promise((res, rej) => { const q = indexedDB.open('fa-a2m-models', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
    const run = async (mode, f) => { const db = await open(); return new Promise((res, rej) => { const tx = db.transaction('kv', mode), r = f(tx.objectStore('kv')); tx.oncomplete = () => { db.close(); res(r && r.result); }; tx.onerror = () => rej(tx.error); }); };
    return { get: (k) => run('readonly', (s) => s.get(k)), set: (k, v) => run('readwrite', (s) => s.put(v, k)), del: (k) => run('readwrite', (s) => s.delete(k)) };
  }
  async function webSha256(u8) { const d = await crypto.subtle.digest('SHA-256', u8); return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''); }
  return { REGISTRY, CHUNK, fetchModel, idbStore, webSha256 };
});
