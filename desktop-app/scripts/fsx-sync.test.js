'use strict';
// 桌面版終端機 /mnt 的同步後端（fsx-sync.js）：真的碰磁碟，在暫存資料夾裡測
const assert = require('assert'); const fs = require('fs'); const os = require('os'); const path = require('path');
const { create } = require('../fsx-sync.js'); const X = require('../renderer/src/terminal/fapfs_core.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fa-fsx-')); const root = path.join(tmp, 'proj'); fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
fs.writeFileSync(path.join(root, 'a.txt'), 'hello'); fs.writeFileSync(path.join(root, 'sub', 'b.txt'), 'bee');
const h = create({ find: (id) => (id === 'r1' ? { rootPath: root } : null) });
const call = (op, o) => h.handle(Object.assign({ op, rootId: 'r1' }, o));
const bad = []; let ok = 0; const t = (n, f) => { try { f(); ok++; } catch (e) { bad.push(n + ': ' + e.message); } };
t('stat／list：檔案、資料夾、不存在', () => {
    assert.deepStrictEqual(call('stat', { path: '/a.txt' }).st.kind, 'file'); assert.strictEqual(call('stat', { path: '/a.txt' }).st.size, 5); assert.strictEqual(call('stat', { path: '/sub' }).st.kind, 'directory'); assert.strictEqual(call('stat', { path: '/nope' }).st, null);
    assert.deepStrictEqual(call('list', { path: '/' }).entries.map((e) => e.name + ':' + e.kind).sort(), ['a.txt:file', 'sub:directory']); assert.strictEqual(call('list', { path: '/a.txt' }).entries, null);
});
t('路徑逃出授權資料夾被擋；沒有這個 root', () => {
    assert.strictEqual(call('stat', { path: '/../outside' }).error.code, 'EACCES'); assert.strictEqual(call('stat', { path: '/sub/../../x' }).error.code, 'EACCES'); assert.strictEqual(h.handle({ op: 'stat', rootId: 'zz', path: '/' }).error.code, 'ENOENT');
});
t('read：區塊讀、讀過檔尾回傳實際長度、身分', () => {
    const r = call('read', { path: '/a.txt', start: 1, end: 4 }); assert.strictEqual(Buffer.from(r.bytes).toString(), 'ell'); assert.strictEqual(r.size, 5); const r2 = call('read', { path: '/a.txt', start: 3, end: 100 }); assert.strictEqual(Buffer.from(r2.bytes).toString(), 'lo');
});
t('writeFile：原子替換、新檔、衝突、force', () => {
    const id0 = call('stat', { path: '/a.txt' }).st; let r = call('writeFile', { path: '/a.txt', bytes: Buffer.from('HELLO!'), expect: { size: id0.size, mtime: id0.mtime } }); assert.strictEqual(r.ok, true); assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'HELLO!');
    assert.ok(!fs.readdirSync(root).some((n) => /fa-tmp/.test(n)), '沒有留下暫存檔');
    r = call('writeFile', { path: '/a.txt', bytes: Buffer.from('X'), expect: { size: 1, mtime: 1 } }); assert.strictEqual(r.conflict, true); assert.strictEqual(fs.readFileSync(path.join(root, 'a.txt'), 'utf8'), 'HELLO!');
    r = call('writeFile', { path: '/new.txt', bytes: Buffer.from('N'), expect: null }); assert.strictEqual(r.ok, true); r = call('writeFile', { path: '/new.txt', bytes: Buffer.from('M'), expect: null }); assert.strictEqual(r.conflict, true, '新檔卻已經存在'); r = call('writeFile', { path: '/new.txt', bytes: Buffer.from('M'), expect: null, force: true }); assert.strictEqual(r.ok, true);
    assert.strictEqual(call('writeFile', { path: '/sub', bytes: Buffer.from('x'), expect: null }).error.code, 'EISDIR');
});
t('mkdir／rmdir／remove', () => {
    assert.strictEqual(call('mkdir', { path: '/d' }).ok, true); assert.strictEqual(call('mkdir', { path: '/d' }).error.code, 'EEXIST'); assert.strictEqual(call('rmdir', { path: '/d' }).ok, true); assert.strictEqual(call('rmdir', { path: '/sub' }).error.code, 'ENOTEMPTY'); assert.strictEqual(call('remove', { path: '/new.txt' }).ok, true); assert.strictEqual(call('remove', { path: '/sub' }).error.code, 'EISDIR'); assert.strictEqual(call('remove', { path: '/nope' }).error.code, 'ENOENT');
});
t('接上 FapMountFs：端到端（讀、寫、刪、衝突）', () => {
    const be = { stat: (p) => call('stat', { path: p }).st, list: (p) => call('list', { path: p }).entries, read: (p, s, e) => { const r = call('read', { path: p, start: s, end: e }); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r; }, writeFile: (p, b, ex, f) => { const r = call('writeFile', { path: p, bytes: b, expect: ex, force: f }); if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code }); return r; }, mkdir: (p) => call('mkdir', { path: p }), rmdir: (p) => call('rmdir', { path: p }), remove: (p) => call('remove', { path: p }) };
    const mfs = new X.FapMountFs(be, { label: 'proj' }); const n = mfs.statSync('/sub/b.txt').size; const buf = new Uint8Array(n); mfs.readSync('/sub/b.txt', buf, 0, n); assert.strictEqual(Buffer.from(buf).toString(), 'bee');
    mfs.createFileSync('/e2e.txt'); mfs.writeSync('/e2e.txt', Buffer.from('end-to-end'), 0); assert.strictEqual(mfs.flush().written, 1); assert.strictEqual(fs.readFileSync(path.join(root, 'e2e.txt'), 'utf8'), 'end-to-end');
    mfs.writeSync('/e2e.txt', Buffer.from('MINE'), 0); fs.writeFileSync(path.join(root, 'e2e.txt'), 'external!!!!'); assert.deepStrictEqual(mfs.flush().conflicts, ['/e2e.txt']); assert.strictEqual(fs.readFileSync(path.join(root, 'e2e.txt'), 'utf8'), 'external!!!!'); assert.strictEqual(mfs.flush({ force: true }).written, 1);
    mfs.unlinkSync('/e2e.txt'); mfs.flush(); assert.ok(!fs.existsSync(path.join(root, 'e2e.txt')));
});
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 暫存 */ }
console.log(ok + ' passed, ' + bad.length + ' failed', bad);
