'use strict';
const assert = require('assert'); const path = require('path'); const { pathToFileURL } = require('url');
const X = require('./fapfs_core.js'); const { FapMountFs, mountRouter, MemoryBackend } = X;
const bad = []; let ok = 0; const tests = []; const t = (n, f) => tests.push([n, f]);
const dec = (u) => new TextDecoder().decode(u); const enc = (s) => new TextEncoder().encode(s);
const readAll = (fs, p) => { const n = fs.statSync(p).size; const b = new Uint8Array(n); if (n) fs.readSync(p, b, 0, n); return dec(b); };
// 假的基底 store（只要 statSync／readdirSync／… 的最小實作，路由測試用）
function tinyBase(seed) { const files = new Map(Object.entries(seed || {})); const dirs = new Set(['/', '/mnt', '/work']); return { statSync(p) { if (files.has(p)) return { size: files.get(p).length, mode: 0o100644 }; if (dirs.has(p)) return { size: 0, mode: 0o040755 }; const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; }, readdirSync(p) { return Array.from(files.keys()).filter((k) => k.startsWith(p === '/' ? '/' : p + '/')).map((k) => k.split('/').pop()); }, readSync() {}, writeSync() {}, createFileSync(p) { files.set(p, ''); }, mkdirSync(p) { dirs.add(p); }, unlinkSync(p) { files.delete(p); }, rmdirSync() {}, renameSync() {}, linkSync() {}, touchSync() {}, syncSync() {} }; }
const mk = (files, opts) => { const be = new MemoryBackend(files); const fs = new FapMountFs(be, Object.assign({ label: 'x' }, opts)); return { be, fs }; };

t('符合 wasi-sh 的檔案系統契約（官方符合性套件，經 FAP 掛載＋路由）', async () => {
    const mod = await import(pathToFileURL(path.join(__dirname, 'vendor', 'wasi-sh-fs-conformance.mjs')).href);
    const be = new MemoryBackend({}); const fs = new FapMountFs(be, { label: 'x' }); const base = tinyBase(); const router = mountRouter(base); router.mount('x', fs);
    // 每個案例做完 flush，確保寫回後的狀態仍然符合
    const wrapped = new Proxy(router, { get(t0, k) { const v = t0[k]; return typeof v === 'function' ? (...a) => { const r = v.apply(t0, a); if (/Sync$/.test(String(k)) && k !== 'syncSync') { /* 指令邊界在案例之間，不在每個呼叫 */ } return r; } : v; } });
    const res = mod.checkConformance(() => wrapped, { prefix: '/mnt/x/c' });
    // 已知且刻意的差異（設計如此）：資料夾改名不支援（回 EXDEV，busybox 的 mv 會改成複製＋刪除）——FAP 沒有原子的資料夾搬移
    const real = res.failed.filter((f) => !/renameSync moves a directory/.test(f.name)); if (real.length) throw new Error(real.map((f) => f.name + ': ' + f.error.message).join(' | '));
    assert.ok(res.passed.length >= 20, 'passed ' + res.passed.length);
    // 寫回後（模擬指令結束）再跑一次：驗證經過 flush 的狀態
    const be2 = new MemoryBackend({}); const fs2 = new FapMountFs(be2, { label: 'y' }); const r2 = mountRouter(tinyBase()); r2.mount('y', fs2);
    const res2 = mod.checkConformance(() => { const p = new Proxy(r2, { get(t0, k) { const v = t0[k]; if (typeof v !== 'function') return v; return (...a) => { const out = v.apply(t0, a); t0.flushAll(); t0.newEpoch(); return out; }; } }); return p; }, { prefix: '/mnt/y/c' });
    const real2 = res2.failed.filter((f) => !/renameSync moves a directory/.test(f.name)); if (real2.length) throw new Error('每次呼叫後都寫回：' + real2.map((f) => f.name + ': ' + f.error.message).join(' | '));
});
t('讀：只碰到用到的區塊；stat 與列表在同一個 epoch 內只問一次', () => {
    const big = new Uint8Array(3 * 1024 * 1024 + 10).fill(65); const { be, fs } = mk({ '/a/big.bin': big, '/a/small.txt': 'hi' });
    fs.statSync('/a/small.txt'); fs.statSync('/a/small.txt'); fs.readdirSync('/a'); fs.readdirSync('/a'); assert.strictEqual(be.log.filter((l) => l === 'stat /a/small.txt').length, 1); assert.strictEqual(be.log.filter((l) => l === 'list /a').length, 1);
    const buf = new Uint8Array(100); fs.readSync('/a/big.bin', buf, 2 * 1024 * 1024 + 5, 2 * 1024 * 1024 + 105); assert.strictEqual(buf[0], 65); assert.strictEqual(be.log.filter((l) => l.startsWith('read /a/big.bin')).length, 1, '只讀了一個區塊');
    assert.ok(be.log.some((l) => l === 'read /a/big.bin ' + 2 * 1024 * 1024 + '-' + 3 * 1024 * 1024));
    fs.readSync('/a/big.bin', buf, 2 * 1024 * 1024 + 5, 2 * 1024 * 1024 + 105); assert.strictEqual(be.log.filter((l) => l.startsWith('read /a/big.bin')).length, 1, '第二次讀走快取');
    fs.newEpoch(); fs.statSync('/a/small.txt'); assert.strictEqual(be.log.filter((l) => l === 'stat /a/small.txt').length, 2, '新 epoch 重新問');
});
t('外部改過檔案：區塊快取（鍵含 size:mtime）失效、重讀', () => {
    const { be, fs } = mk({ '/f.txt': 'old content' }); assert.strictEqual(readAll(fs, '/f.txt'), 'old content'); be.external('/f.txt', 'new!'); fs.newEpoch(); assert.strictEqual(readAll(fs, '/f.txt'), 'new!');
});
t('讀的當下檔案被換掉（stat 與 read 身分不同）也能自我修正', () => {
    const { be, fs } = mk({ '/f.txt': 'AAAAAAAA' }); fs.statSync('/f.txt'); be.external('/f.txt', 'BBBB'); const b = new Uint8Array(4); fs.readSync('/f.txt', b, 0, 4); assert.strictEqual(dec(b), 'BBBB');
});
t('寫：進記憶體、指令結束才寫回；寫回前真檔不變', () => {
    const { be, fs } = mk({ '/n.txt': 'one' }); fs.writeSync('/n.txt', enc('TWO!'), 0); assert.strictEqual(dec(be.files.get('/n.txt').bytes), 'one'); assert.strictEqual(readAll(fs, '/n.txt'), 'TWO!');
    const r = fs.flush(); assert.strictEqual(r.written, 1); assert.strictEqual(dec(be.files.get('/n.txt').bytes), 'TWO!'); assert.strictEqual(fs.dirtyCount(), 0);
});
t('新檔：建立＋寫入，寫回後真檔出現；列表合併尚未寫回的新檔', () => {
    const { be, fs } = mk({ '/d/a.txt': 'a' }); fs.createFileSync('/d/b.txt'); fs.writeSync('/d/b.txt', enc('bee'), 0); assert.deepStrictEqual(fs.readdirSync('/d').sort(), ['a.txt', 'b.txt']); assert.strictEqual(be.files.has('/d/b.txt'), false);
    fs.flush(); assert.strictEqual(dec(be.files.get('/d/b.txt').bytes), 'bee');
});
t('刪除是墓碑：寫回才真的刪；刪了又建合併成覆寫（沒有刪掉真檔的空窗）', () => {
    const { be, fs } = mk({ '/x.txt': 'orig' }); fs.unlinkSync('/x.txt'); assert.ok(be.files.has('/x.txt'), '還沒真的刪'); assert.throws(() => fs.statSync('/x.txt'), /ENOENT/); assert.deepStrictEqual(fs.readdirSync('/'), []);
    fs.createFileSync('/x.txt'); fs.writeSync('/x.txt', enc('again'), 0); fs.flush(); assert.strictEqual(dec(be.files.get('/x.txt').bytes), 'again'); assert.ok(!be.log.some((l) => l === 'remove /x.txt'), '合併成覆寫，不呼叫刪除');
    fs.unlinkSync('/x.txt'); fs.flush(); assert.ok(!be.files.has('/x.txt'));
});
t('一致性：外部改過就不覆蓋、回報衝突；force 才覆蓋', () => {
    const { be, fs } = mk({ '/c.txt': 'base' }); fs.writeSync('/c.txt', enc('MINE'), 0); be.external('/c.txt', 'THEIRS'); let r = fs.flush(); assert.deepStrictEqual(r.conflicts, ['/c.txt']); assert.strictEqual(dec(be.files.get('/c.txt').bytes), 'THEIRS'); assert.strictEqual(fs.dirtyCount(), 1, '沒丟掉我的寫入');
    r = fs.flush({ force: true }); assert.strictEqual(r.written, 1); assert.strictEqual(dec(be.files.get('/c.txt').bytes), 'MINE');
    const t2 = mk({ '/d.txt': 'base' }); t2.fs.unlinkSync('/d.txt'); t2.be.external('/d.txt', 'changed'); assert.deepStrictEqual(t2.fs.flush().conflicts, ['/d.txt']); assert.ok(t2.be.files.has('/d.txt'), '被外部改過的檔案不刪');
});
t('改名（檔案）：複製＋刪除；資料夾不支援（EXDEV），跨掛載 EXDEV', () => {
    const { be, fs } = mk({ '/a.txt': 'AAA', '/dir/f': 'f' }); fs.renameSync('/a.txt', '/b.txt'); assert.strictEqual(readAll(fs, '/b.txt'), 'AAA'); assert.throws(() => fs.statSync('/a.txt'), /ENOENT/); fs.flush(); assert.ok(!be.files.has('/a.txt') && be.files.has('/b.txt'));
    assert.throws(() => fs.renameSync('/dir', '/dir2'), (e) => e.code === 'EXDEV');
    const router = mountRouter(tinyBase({ '/work/w.txt': 'w' })); router.mount('x', fs); assert.throws(() => router.renameSync('/work/w.txt', '/mnt/x/w.txt'), (e) => e.code === 'EXDEV'); assert.throws(() => router.renameSync('/mnt/x/b.txt', '/work/b.txt'), (e) => e.code === 'EXDEV');
});
t('唯讀掛載：寫入回 EROFS 並提示 sync --push', () => {
    const { fs } = mk({ '/r.txt': 'r' }, { writable: false }); assert.strictEqual(readAll(fs, '/r.txt'), 'r'); assert.throws(() => fs.writeSync('/r.txt', enc('x'), 0), (e) => e.code === 'EROFS' && /--push/.test(e.message)); assert.throws(() => fs.createFileSync('/n'), (e) => e.code === 'EROFS'); assert.throws(() => fs.unlinkSync('/r.txt'), (e) => e.code === 'EROFS');
});
t('超過水位自動寫回；超大檔案 EFBIG', () => {
    const { be, fs } = mk({}); const chunk = new Uint8Array(40 * 1024 * 1024).fill(7); for (let i = 0; i < 4; i++) { fs.createFileSync('/f' + i); fs.writeSync('/f' + i, chunk, 0); }
    assert.ok(be.files.size >= 1, '超過 128 MB 水位已經自動寫回'); fs.flush(); assert.strictEqual(be.files.size, 4);
    fs.createFileSync('/huge'); assert.throws(() => fs.writeSync('/huge', new Uint8Array(1), 300 * 1024 * 1024), (e) => e.code === 'EFBIG');
});
t('寫入只在第一次寫時讀進整個檔案；沒被寫的大檔任意大小都只讀用到的區塊', () => {
    const big = new Uint8Array(20 * 1024 * 1024).fill(1); const { be, fs } = mk({ '/big': big }); const b = new Uint8Array(10); fs.readSync('/big', b, 19 * 1024 * 1024, 19 * 1024 * 1024 + 10); assert.strictEqual(be.log.filter((l) => l.startsWith('read')).length, 1);
    fs.writeSync('/big', enc('Z'), 0); assert.ok(be.log.filter((l) => l.startsWith('read')).length >= 20, '寫入時整檔讀進來（20 個區塊，已快取的不重讀）');
});
t('資料夾：mkdir／rmdir 立即生效；rmdir 非空 ENOTEMPTY；根目錄不能刪', () => {
    const { be, fs } = mk({ '/d/f': 'x' }); fs.mkdirSync('/n'); assert.ok(be.dirs.has('/n')); assert.throws(() => fs.rmdirSync('/d'), (e) => e.code === 'ENOTEMPTY'); fs.unlinkSync('/d/f'); fs.rmdirSync('/d'); assert.ok(be.files.has('/d/f') === true && be.dirs.has('/d') === false, 'rmdir 立即；檔案還沒寫回刪除'); assert.throws(() => fs.rmdirSync('/'), (e) => e.code === 'EBUSY');
});
t('路由：/mnt/<label> 整個走 FAP，其餘走原本的 store；沒掛載的 label 走原本的佔位', () => {
    const base = tinyBase({ '/work/a.txt': 'a', '/mnt/other/.keep': '' }); const { fs } = mk({ '/p/q.txt': 'q' }); const router = mountRouter(base); router.mount('x', fs);
    assert.deepStrictEqual(router.readdirSync('/mnt/x'), ['p']); assert.strictEqual(readAll(router, '/mnt/x/p/q.txt'), 'q'); assert.strictEqual(router.statSync('/work/a.txt').size, 1); assert.deepStrictEqual(router.readdirSync('/mnt/other'), ['.keep']);
    router.createFileSync('/mnt/x/new'); router.writeSync('/mnt/x/new', enc('N'), 0); assert.strictEqual(router.dirtyCount(), 1); const r = router.flushAll(); assert.strictEqual(r.written, 1); assert.strictEqual(router.dirtyCount(), 0); assert.throws(() => router.rmdirSync('/mnt/x'), (e) => e.code === 'EBUSY');
});
t('flushAll 回報衝突時帶完整路徑', () => {
    const { be, fs } = mk({ '/z.txt': 'a' }); const router = mountRouter(tinyBase()); router.mount('x', fs); router.writeSync('/mnt/x/z.txt', enc('b'), 0); be.external('/z.txt', 'zzz'); assert.deepStrictEqual(router.flushAll().conflicts, ['/mnt/x/z.txt']);
});
(async () => {
    for (const [n, f] of tests) { try { await f(); ok++; } catch (e) { bad.push(n + ': ' + (e && e.message || e)); } }
    console.log(ok + ' passed, ' + bad.length + ' failed', bad);
})();
