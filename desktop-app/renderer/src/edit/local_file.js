// 編輯器的「本機檔案綁定」核心（UMD、純邏輯；平台差異由呼叫端傳進來的轉接器處理，所以 Node 用假的轉接器就能測）。設計見 DESIGN.edit-docs.md §3。
//   const LF = FaLocalFile.create({ desk, web, store })
//     desk（桌面版，絕對路徑）：{ stat(path) → {size, mtimeMs}, read(path) → Uint8Array, write(path, bytes) }          （desktopAPI.rawfs：writeFile 不是原子的、也沒有 rename，所以寫完會讀回檢查，並且寫之前先比對檔案有沒有在外面被改過）
//     web（瀏覽器 File System Access）：{ pick(opts) → handle|null, pickSave(opts) → handle|null, file(handle) → { bytes, size, mtimeMs, name }, write(handle, bytes), allowed(handle, write) → Promise<bool> }（寫入用 createWritable，關閉時才一次換上，本身就接近原子）
//     store（只有 web 要）：{ get(key), set(key, handle), del(key) }，存 FileSystemFileHandle（IndexedDB 可以存）
//   binding：{ v:1, via:'desktop'|'web', name, path?, size, mtimeMs, hash, enc?, auto? }——存在專案的 origin.file；不跟著遠端共筆傳給別人（每台機器各自的）
//   LF.bindDesktop(path) → { binding, bytes }    LF.bindWeb(key, opts) → { binding, bytes } | null    LF.saveAsDesktop(path, bytes, opts) / LF.saveAsWeb(key, bytes, opts) → { binding }
//   LF.read(binding, key) → { binding, bytes }（重新載入）    LF.check(binding, key) → { changed, missing?, current }    LF.save(binding, key, bytes, { force }) → { ok, binding } | { ok:false, conflict:true, current } | { ok:false, error }
//   LF.hash(bytes)    LF.looksLikePath(text)    LF.supported() → { desktop, web }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaLocalFile = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  function hash(bytes) { var h = 2166136261, n = bytes.length; for (var i = 0; i < n; i++) { h ^= bytes[i]; h = Math.imul(h, 16777619); } return (h >>> 0).toString(16) + ':' + n; }
  function baseName(p) { return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || String(p); }
  function looksLikePath(t) { t = String(t || '').trim().replace(/^["「]|["」]$/g, ''); return /^([A-Za-z]:[\\/]|\\\\|\/|~[\\/])/.test(t) && /[\\/]/.test(t.slice(1)); }
  function create(cfg) {
    cfg = cfg || {}; var desk = cfg.desk || null, web = cfg.web || null, store = cfg.store || null;
    function mk(via, name, st, bytes, extra) { return Object.assign({ v: 1, via: via, name: name, size: st.size, mtimeMs: st.mtimeMs, hash: hash(bytes) }, extra || {}); }
    async function handleOf(key) { if (!store) { throw new Error('這裡沒有保存檔案控制代碼的地方'); } var h = await store.get(key); if (!h) { throw new Error('找不到這個檔案的控制代碼（可能被清掉了），請重新綁定'); } return h; }
    return {
      supported: function () { return { desktop: !!desk, web: !!(web && web.pick) }; }, hash: hash, looksLikePath: looksLikePath, baseName: baseName,
      async bindDesktop(path) { if (!desk) { throw new Error('這裡不能用路徑開檔'); } path = String(path || '').trim().replace(/^["「]|["」]$/g, ''); var st = await desk.stat(path); if (st.isDirectory) { throw new Error('這是資料夾，不是檔案'); } var bytes = await desk.read(path); return { binding: mk('desktop', baseName(path), st, bytes, { path: path }), bytes: bytes }; },
      async bindWeb(key, opts) { if (!web || !web.pick) { throw new Error('這個瀏覽器不能直接開本機檔案（要 Chrome 或 Edge）'); } var h = await web.pick(opts || {}); if (!h) { return null; } var f = await web.file(h); if (store) { await store.set(key, h); } return { binding: mk('web', f.name, f, f.bytes), bytes: f.bytes }; },
      async saveAsDesktop(path, bytes, opts) { if (!desk) { throw new Error('這裡不能用路徑存檔'); } path = String(path || '').trim().replace(/^["「]|["」]$/g, ''); var exists = null; try { exists = await desk.stat(path); } catch (e) { exists = null; } if (exists && exists.isDirectory) { throw new Error('這是資料夾'); } if (exists && !(opts && opts.overwrite)) { return { ok: false, exists: true }; } await desk.write(path, bytes); var st = await desk.stat(path), back = await desk.read(path); if (hash(back) !== hash(bytes)) { throw new Error('寫入後讀回來的內容不一樣'); } return { ok: true, binding: mk('desktop', baseName(path), st, bytes, { path: path }) }; },
      async saveAsWeb(key, bytes, opts) { if (!web || !web.pickSave) { throw new Error('這個瀏覽器不能直接存到本機檔案（要 Chrome 或 Edge）'); } var h = await web.pickSave(opts || {}); if (!h) { return null; } await web.write(h, bytes); if (store) { await store.set(key, h); } var f = await web.file(h); return { ok: true, binding: mk('web', f.name, f, bytes) }; },
      async read(b, key) { if (b.via === 'desktop') { var st = await desk.stat(b.path), bytes = await desk.read(b.path); return { binding: Object.assign({}, b, { size: st.size, mtimeMs: st.mtimeMs, hash: hash(bytes) }), bytes: bytes }; } var h = await handleOf(key); if (web.allowed && !(await web.allowed(h, false))) { throw new Error('沒有讀取這個檔案的權限'); } var f = await web.file(h); return { binding: Object.assign({}, b, { name: f.name, size: f.size, mtimeMs: f.mtimeMs, hash: hash(f.bytes) }), bytes: f.bytes }; },
      // 檔案在外面被改過嗎：先比大小與修改時間；不同才讀內容，內容跟上次讀寫的一樣就不算改過（有些系統的修改時間會被同步軟體動到）
      async check(b, key) {
        try {
          if (b.via === 'desktop') { var st = await desk.stat(b.path); if (st.size === b.size && st.mtimeMs === b.mtimeMs) { return { changed: false, current: st }; } var bytes = await desk.read(b.path); return { changed: hash(bytes) !== b.hash, current: st }; }
          var h = await handleOf(key), f = await web.file(h); if (f.size === b.size && f.mtimeMs === b.mtimeMs) { return { changed: false, current: f }; } return { changed: hash(f.bytes) !== b.hash, current: f };
        } catch (e) { return { changed: false, missing: true, error: String((e && e.message) || e) }; }
      },
      async save(b, key, bytes, opts) {
        opts = opts || {};
        try {
          if (!opts.force) { var c = await this.check(b, key); if (c.changed) { return { ok: false, conflict: true, current: c.current }; } }
          if (b.via === 'desktop') {
            await desk.write(b.path, bytes); var st = await desk.stat(b.path), back = await desk.read(b.path);
            if (hash(back) !== hash(bytes)) { await desk.write(b.path, bytes); back = await desk.read(b.path); if (hash(back) !== hash(bytes)) { return { ok: false, error: '寫入後讀回來的內容不一樣，檔案可能壞了——請用「另存」存到別的地方' }; } }
            return { ok: true, binding: Object.assign({}, b, { size: st.size, mtimeMs: st.mtimeMs, hash: hash(bytes) }) };
          }
          var h = await handleOf(key); if (web.allowed && !(await web.allowed(h, true))) { return { ok: false, error: '沒有寫入這個檔案的權限（瀏覽器要你按允許）' }; } await web.write(h, bytes); var f = await web.file(h);
          return { ok: true, binding: Object.assign({}, b, { name: f.name, size: f.size, mtimeMs: f.mtimeMs, hash: hash(bytes) }) };
        } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
      },
    };
  }
  return { create: create, hash: hash, looksLikePath: looksLikePath, baseName: baseName };
});
