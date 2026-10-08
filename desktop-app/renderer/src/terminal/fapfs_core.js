/* 終端機的 /mnt/<label>：即時的 FAP 檔案系統（純 JS，UMD；設計見 DESIGN.run-terminal.md §11 與 DESIGN.sqlite-fap.md §17）。
 *
 * 舊做法是「hydrate-and-flush」：第一次提到某個 label，就把整個真實資料夾逐檔讀進記憶體（71,752 檔、含 1.3 GB 的索引庫的專案會直接卡死），
 * 那只是複製品。這裡改成比照 ext 檔案系統：頁面快取＋寫回。
 *
 *   dentry／inode 快取 → stat 與列表快取，只在「一個指令內」有效（每個指令開頭 newEpoch()）
 *   page cache         → 檔案以 1 MB 區塊快取（LRU，最多 128 塊），鍵含 size:mtime，外部改過就重讀
 *   writeback          → 寫入進記憶體緩衝（髒檔），每個指令結束、sync、超過 128 MB 水位時寫回
 *   一致性             → 寫回前檢查檔案是否還是讀進來時的 size:mtime；被外部改過就不覆蓋並回報衝突（force 才覆蓋）
 *   刪除               → 先記成墓碑，寫回時才真的刪；「刪了又建」合併成覆寫（沒有刪掉真檔後才寫的空窗）
 *
 * wasi-sh 的 store 契約是同步的（客體是 wasm 堆疊最底層，沒有東西可以 await），而 FAP 只有非同步 API，
 * 所以這裡只認一個「同步後端」介面（backend）；真正的後端在 fapfs_transport.js（SharedArrayBuffer＋worker），測試用記憶體假後端。
 *
 * 後端介面（全部同步）：
 *   stat(path)                      -> null | {kind:'file'|'directory', size, mtime}
 *   list(path)                      -> null（不是資料夾）| [{name, kind}]
 *   read(path, start, end)          -> {bytes:Uint8Array, size, mtime}   // 回傳的 size／mtime 是讀的當下檔案的身分
 *   writeFile(path, bytes, expect, force) -> {ok:true, size, mtime} | {ok:false, conflict:true, size, mtime}   // expect＝{size,mtime}｜null（新檔）
 *   mkdir(path)  rmdir(path)  remove(path)
 * 路徑一律以 '/' 開頭、相對於這個掛載的根。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaFapFs = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ERRNO = { EPERM: 1, ENOENT: 2, EIO: 5, EBADF: 9, EACCES: 13, EBUSY: 16, EEXIST: 17, EXDEV: 18, ENOTDIR: 20, EISDIR: 21, EINVAL: 22, EFBIG: 27, ENOSPC: 28, EROFS: 30, ENOSYS: 38, ENOTEMPTY: 39 };
    function fsError(code, path, hint) { const e = new Error((path === undefined ? code : code + ': ' + path) + (hint ? '（' + hint + '）' : '')); e.code = code; e.errno = ERRNO[code]; if (path !== undefined) e.path = path; return e; }
    const S_IFMT = 0o170000, S_IFDIR = 0o040000, S_IFREG = 0o100000;
    const BLOCK = 1024 * 1024, MAX_BLOCKS = 128, HIGH_WATER = 128 * 1024 * 1024, MAX_WRITE_FILE = 256 * 1024 * 1024;
    const normalize = (p) => { const st = []; for (const x of String(p).split('/')) { if (!x || x === '.') continue; if (x === '..') st.pop(); else st.push(x); } return '/' + st.join('/'); };
    const parentOf = (p) => { const i = p.lastIndexOf('/'); return i > 0 ? p.slice(0, i) : '/'; };
    const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
    const idOf = (st) => st.size + ':' + st.mtime;

    class FapMountFs {
        constructor(backend, opts) {
            opts = opts || {}; this.be = backend; this.label = opts.label || ''; this.writable = opts.writable !== false; this.now = opts.now || (() => Date.now());
            this.statCache = new Map(); this.listCache = new Map(); this.ov = new Map(); this.blocks = new Map(); this.inos = new Map(); this.nextIno = 1000000; this.dirtyBytes = 0; this.meta = new Map(); // path -> {mode, mtimeMs, uid, gid, id}（虛擬的權限位元與時間戳）
            this.stats = { statCalls: 0, listCalls: 0, readCalls: 0, writeCalls: 0, blockHits: 0, blockMisses: 0 };
        }
        // ---- 快取 ----
        newEpoch() { this.statCache.clear(); this.listCache.clear(); }
        dropCaches() { this.newEpoch(); this.blocks.clear(); }
        _ino(p) { let i = this.inos.get(p); if (!i) { i = this.nextIno++; this.inos.set(p, i); } return i; }
        _rstat(p) { // 遠端 stat（一個 epoch 內快取）；null＝不存在
            if (this.statCache.has(p)) return this.statCache.get(p);
            this.stats.statCalls++; const r = p === '/' ? { kind: 'directory', size: 0, mtime: 0 } : this.be.stat(p); this.statCache.set(p, r || null); return r || null;
        }
        _rlist(p) {
            if (this.listCache.has(p)) return this.listCache.get(p);
            this.stats.listCalls++; const r = this.be.list(p); this.listCache.set(p, r); return r;
        }
        _inode(p, kind, size, mtime) {
            const isDir = kind === 'directory'; let m = this.meta.get(p); if (m && m.id !== (isDir ? 'd' : size + ':' + mtime) && !m.keep) { this.meta.delete(p); m = null; }
            const mt = m && m.mtimeMs !== undefined ? m.mtimeMs : mtime;
            return { ino: this._ino(p), nlink: isDir ? 2 : 1, size: isDir ? 0 : size, mode: (isDir ? S_IFDIR : S_IFREG) | (m && m.mode !== undefined ? m.mode & 0o7777 : (isDir ? 0o755 : 0o644)), uid: m && m.uid !== undefined ? m.uid : 0, gid: m && m.gid !== undefined ? m.gid : 0, atimeMs: m && m.atimeMs !== undefined ? m.atimeMs : mt, mtimeMs: mt, ctimeMs: m && m.ctimeMs !== undefined ? m.ctimeMs : mt, birthtimeMs: mt };
        }
        _need(path) { const p = normalize(path); const o = this.ov.get(p); if (o) { if (o.state === 'deleted') throw fsError('ENOENT', path); return { p, kind: 'file', size: o.data.length, mtime: o.mtime, ov: o }; } const r = this._rstat(p); if (!r) throw fsError('ENOENT', path); return { p, kind: r.kind, size: r.size, mtime: r.mtime }; }
        _rw(path) { if (!this.writable) throw fsError('EROFS', path, '這個掛載是唯讀；用 sync ' + (this.label || '<label>') + ' --push 申請寫入權限'); }
        // ---- 契約 ----
        statSync(path) { const n = this._need(path); return this._inode(n.p, n.kind, n.size, n.mtime); }
        readdirSync(path) {
            const n = this._need(path); if (n.kind !== 'directory') throw fsError('ENOTDIR', path);
            const names = new Set((this._rlist(n.p) || []).map((e) => e.name));
            for (const [p, o] of this.ov) { if (parentOf(p) !== n.p) continue; if (o.state === 'deleted') names.delete(baseOf(p)); else names.add(baseOf(p)); }
            return Array.from(names);
        }
        _requireParentDir(p, path) { const par = parentOf(p); const r = this.ov.has(par) ? null : this._rstat(par); if (!r || r.kind !== 'directory') throw fsError(r ? 'ENOTDIR' : 'ENOENT', path); }
        createFileSync(path) {
            this._rw(path); const p = normalize(path); let exists = false; try { exists = this._need(p).kind != null; } catch (_) { exists = false; } if (exists) throw fsError('EEXIST', path);
            this._requireParentDir(p, path); const prev = this.ov.get(p); const now = this.now();
            this.ov.set(p, { state: 'dirty', data: new Uint8Array(0), base: prev ? prev.base : null, mtime: now, created: !(prev && prev.base) }); // 刪了又建＝覆寫（沿用被刪那份的身分）
            this.statCache.delete(p); return this._inode(p, 'file', 0, now);
        }
        mkdirSync(path) {
            this._rw(path); const p = normalize(path); let exists = false; try { this._need(p); exists = true; } catch (_) { exists = false; } if (exists) throw fsError('EEXIST', path);
            this._requireParentDir(p, path); this.be.mkdir(p); this.statCache.delete(p); this.listCache.delete(parentOf(p)); return this._inode(p, 'directory', 0, this.now());
        }
        rmdirSync(path) {
            this._rw(path); const n = this._need(path); if (n.p === '/') throw fsError('EBUSY', path); if (n.kind !== 'directory') throw fsError('ENOTDIR', path);
            if (this.readdirSync(n.p).length) throw fsError('ENOTEMPTY', path); this.be.rmdir(n.p); this.statCache.delete(n.p); this.listCache.delete(n.p); this.listCache.delete(parentOf(n.p));
        }
        unlinkSync(path) {
            this._rw(path); const n = this._need(path); if (n.kind === 'directory') throw fsError('EISDIR', path);
            const o = this.ov.get(n.p);
            if (o && o.state === 'dirty') { this.dirtyBytes -= o.data.length; if (o.created || !o.base) this.ov.delete(n.p); else this.ov.set(n.p, { state: 'deleted', data: null, base: o.base, mtime: this.now() }); }
            else { const r = this._rstat(n.p); this.ov.set(n.p, { state: 'deleted', data: null, base: { size: r.size, mtime: r.mtime }, mtime: this.now() }); }
            this.statCache.delete(n.p); this.listCache.delete(parentOf(n.p));
        }
        renameSync(from, to) {
            this._rw(from); const src = normalize(from), dst = normalize(to); const s = this._need(src); if (src === dst) return;
            if (s.kind === 'directory') throw fsError('EXDEV', from, '資料夾不能在 FAP 掛載內改名；busybox 的 mv 會改成複製＋刪除'); // 與設計一致：資料夾 rename 不支援
            let d = null; try { d = this._need(dst); } catch (_) { d = null; } if (d && d.kind === 'directory') throw fsError('EISDIR', to); this._requireParentDir(dst, to);
            const data = this._wholeFile(src); const prev = this.ov.get(dst);
            this.ov.set(dst, { state: 'dirty', data: data.slice(), base: prev ? prev.base : (d ? (() => { const r = this._rstat(dst); return r ? { size: r.size, mtime: r.mtime } : null; })() : null), mtime: this.now(), created: !d && !(prev && prev.base) }); this.dirtyBytes += data.length; this.statCache.delete(dst);
            this.unlinkSync(src); this.listCache.delete(parentOf(dst)); this._checkHigh();
        }
        linkSync(target, link) { throw fsError('ENOSYS', link, 'FAP 掛載不支援連結'); }
        _wholeFile(p) { // 讀整個檔案（含髒的），給 rename／寫入用
            const o = this.ov.get(p); if (o && o.state === 'dirty') return o.data; const r = this._rstat(p); if (!r) throw fsError('ENOENT', p); if (r.size > MAX_WRITE_FILE) throw fsError('EFBIG', p, '要寫入的檔案超過 ' + Math.round(MAX_WRITE_FILE / 1048576) + ' MB');
            if (!r.size) return new Uint8Array(0); const out = new Uint8Array(r.size); this.readSync(p, out, 0, r.size); return out;
        }
        readSync(path, buffer, start, end) {
            const n = this._need(path); if (n.kind === 'directory') throw fsError('EISDIR', path);
            const o = this.ov.get(n.p); if (o && o.state === 'dirty') { const sl = o.data.subarray(start, end); const t = Math.min(sl.length, buffer.length); buffer.set(sl.subarray(0, t), 0); if (t < buffer.length) buffer.fill(0, t); return; }
            let st = this._rstat(n.p); if (!st) throw fsError('ENOENT', path); let want = Math.min(end, st.size); let filled = 0;
            for (let attempt = 0; attempt < 2; attempt++) {
                const id = idOf(st); const first = Math.floor(start / BLOCK), last = want > start ? Math.floor((want - 1) / BLOCK) : first - 1; let changed = false; filled = 0;
                for (let b = first; b <= last; b++) {
                    const key = n.p + '|' + id + '|' + b; let blk = this.blocks.get(key);
                    if (blk) { this.blocks.delete(key); this.blocks.set(key, blk); this.stats.blockHits++; }
                    else {
                        this.stats.blockMisses++; this.stats.readCalls++; const r = this.be.read(n.p, b * BLOCK, Math.min((b + 1) * BLOCK, st.size));
                        if (idOf(r) !== id) { st = { kind: 'file', size: r.size, mtime: r.mtime }; this.statCache.set(n.p, st); this.blocks.forEach((_, k) => { if (k.startsWith(n.p + '|')) this.blocks.delete(k); }); want = Math.min(end, st.size); changed = true; break; } // 外部改過：重讀
                        blk = r.bytes; this.blocks.set(key, blk); if (this.blocks.size > MAX_BLOCKS) this.blocks.delete(this.blocks.keys().next().value);
                    }
                    const bs = b * BLOCK; const from = Math.max(start, bs), to = Math.min(want, bs + blk.length); if (to > from) { buffer.set(blk.subarray(from - bs, to - bs), from - start); filled = Math.max(filled, to - start); }
                }
                if (!changed) break;
            }
            if (filled < buffer.length) buffer.fill(0, filled);
        }
        _dirtyFile(p) { // 取得（必要時建立）這個檔案的髒緩衝：第一次寫入才把整個檔案讀進來
            let o = this.ov.get(p); if (o && o.state === 'dirty') return o;
            const r = this._rstat(p); const data = r ? this._wholeFile(p).slice() : new Uint8Array(0);
            o = { state: 'dirty', data, base: r ? { size: r.size, mtime: r.mtime } : (o && o.base) || null, mtime: this.now(), created: !r && !(o && o.base) }; this.ov.set(p, o); this.dirtyBytes += data.length; return o;
        }
        writeSync(path, buffer, offset) {
            this._rw(path); const n = this._need(path); if (n.kind === 'directory') throw fsError('EISDIR', path);
            const end = offset + buffer.length; if (end > MAX_WRITE_FILE) throw fsError('EFBIG', path); const o = this._dirtyFile(n.p);
            if (end > o.data.length) { const g = new Uint8Array(end); g.set(o.data, 0); this.dirtyBytes += end - o.data.length; o.data = g; } o.data.set(buffer, offset); o.mtime = this.now(); this.statCache.delete(n.p); this._checkHigh();
        }
        touchSync(path, md) {
            md = md || {}; const n = this._need(path); if (md.size !== undefined && n.kind === 'file') { this._rw(path); const o = this._dirtyFile(n.p); if (md.size !== o.data.length) { const g = new Uint8Array(md.size); g.set(o.data.subarray(0, Math.min(md.size, o.data.length)), 0); this.dirtyBytes += g.length - o.data.length; o.data = g; } o.mtime = this.now(); this.statCache.delete(n.p); this._checkHigh(); }
            // mode／uid／gid／時間戳：FAP 沒有這些概念，只記在記憶體（chmod／touch 才不會失敗，且讀回來是剛設的值）
            if (md.mode !== undefined || md.uid !== undefined || md.gid !== undefined || md.atimeMs !== undefined || md.mtimeMs !== undefined || md.ctimeMs !== undefined) {
                const cur = this.statSync(path); const m = this.meta.get(n.p) || { id: n.kind === 'directory' ? 'd' : cur.size + ':' + (n.ov ? n.mtime : (this._rstat(n.p) || {}).mtime) };
                for (const k of ['mode', 'uid', 'gid', 'atimeMs', 'mtimeMs', 'ctimeMs']) if (md[k] !== undefined) m[k] = md[k];
                if (md.mtimeMs !== undefined && n.ov) n.ov.mtime = md.mtimeMs; m.keep = !!n.ov; this.meta.set(n.p, m);
            }
        }
        syncSync() { const r = this.flush(); if (r.conflicts.length) { const e = fsError('EBUSY', r.conflicts[0], '外部改過這個檔案，沒有覆蓋；sync ' + this.label + ' --force 才覆蓋'); throw e; } }
        _checkHigh() { if (this.dirtyBytes > HIGH_WATER) this.flush(); }
        // ---- 寫回 ----
        dirtyCount() { return this.ov.size; }
        flush(o) {
            o = o || {}; const force = !!o.force; const out = { written: 0, deleted: 0, conflicts: [], errors: [] };
            const writes = [], dels = []; for (const [p, v] of this.ov) (v.state === 'dirty' ? writes : dels).push([p, v]);
            for (const [p, v] of writes) {
                try { const r = this.be.writeFile(p, v.data, v.base, force); if (r.ok) { out.written++; this.dirtyBytes -= v.data.length; this.ov.delete(p); this.statCache.set(p, { kind: 'file', size: r.size, mtime: r.mtime }); this.blocks.forEach((_, k) => { if (k.startsWith(p + '|')) this.blocks.delete(k); }); this.listCache.delete(parentOf(p)); } else out.conflicts.push(p); }
                catch (e) { out.errors.push(p + ': ' + (e && e.message || e)); }
            }
            for (const [p, v] of dels) {
                try {
                    const cur = this.be.stat(p); if (!cur) { this.ov.delete(p); continue; }
                    if (!force && v.base && (cur.size !== v.base.size || cur.mtime !== v.base.mtime)) { out.conflicts.push(p); continue; }
                    this.be.remove(p); out.deleted++; this.ov.delete(p); this.statCache.delete(p); this.listCache.delete(parentOf(p)); this.blocks.forEach((_, k) => { if (k.startsWith(p + '|')) this.blocks.delete(k); });
                } catch (e) { out.errors.push(p + ': ' + (e && e.message || e)); }
            }
            if (this.ov.size === 0) this.dirtyBytes = 0; return out;
        }
        discard() { this.ov.clear(); this.dirtyBytes = 0; this.dropCaches(); }
        pending() { return Array.from(this.ov, ([p, v]) => ({ path: p, state: v.state, bytes: v.data ? v.data.length : 0 })); }
    }

    // ---- 路由：/mnt/<label>/… 走 FAP，其餘走原本的記憶體 store ----
    function mountRouter(base) {
        const mounts = new Map();
        const route = (path) => {
            const p = normalize(path); const m = /^\/mnt\/([^/]+)(\/.*)?$/.exec(p);
            if (m && mounts.has(m[1])) return { fs: mounts.get(m[1]), path: m[2] || '/', label: m[1] };
            return { fs: base, path: p, label: null };
        };
        const router = {
            base, mounts,
            mount(label, fs) { mounts.set(label, fs); }, unmount(label) { mounts.delete(label); }, isMounted: (label) => mounts.has(label),
            statSync(p) { const r = route(p); return r.fs.statSync(r.path); },
            readdirSync(p) { const r = route(p); return r.fs.readdirSync(r.path); },
            createFileSync(p, o) { const r = route(p); return r.fs.createFileSync(r.path, o); },
            mkdirSync(p, o) { const r = route(p); return r.fs.mkdirSync(r.path, o); },
            rmdirSync(p) { const r = route(p); if (r.label && r.path === '/') throw fsError('EBUSY', p); return r.fs.rmdirSync(r.path); },
            unlinkSync(p) { const r = route(p); return r.fs.unlinkSync(r.path); },
            renameSync(a, b) { const x = route(a), y = route(b); if (x.fs !== y.fs) throw fsError('EXDEV', a, '不同檔案系統之間不能改名；mv 會改成複製＋刪除'); return x.fs.renameSync(x.path, y.path); },
            linkSync(t, l) { const x = route(t), y = route(l); if (x.fs !== y.fs) throw fsError('EXDEV', l); return x.fs.linkSync(x.path, y.path); },
            readSync(p, buf, s, e) { const r = route(p); return r.fs.readSync(r.path, buf, s, e); },
            writeSync(p, buf, off) { const r = route(p); return r.fs.writeSync(r.path, buf, off); },
            touchSync(p, md) { const r = route(p); return r.fs.touchSync(r.path, md); },
            syncSync() { router.flushAll(); },
            // 指令邊界
            newEpoch() { for (const f of mounts.values()) f.newEpoch(); },
            flushAll(o) { const out = { written: 0, deleted: 0, conflicts: [], errors: [], byLabel: {} }; for (const [l, f] of mounts) { const r = f.flush(o); out.written += r.written; out.deleted += r.deleted; out.conflicts.push(...r.conflicts.map((c) => '/mnt/' + l + c)); out.errors.push(...r.errors.map((e) => '/mnt/' + l + e)); out.byLabel[l] = r; } return out; },
            dirtyCount() { let n = 0; for (const f of mounts.values()) n += f.dirtyCount(); return n; },
        };
        // 其他沒包到的方法（例如 memoryFs 的內部欄位）直接轉給 base
        return new Proxy(router, { get(t, k) { if (k in t) return t[k]; const v = base[k]; return typeof v === 'function' ? v.bind(base) : v; } });
    }

    // ---- 測試與參考用的記憶體假後端（同一個介面，非同步行為用 latency 模擬在外面）----
    class MemoryBackend {
        constructor(files) { this.files = new Map(); this.dirs = new Set(['/']); this.clock = 1000; this.log = []; for (const [p, c] of Object.entries(files || {})) this._put(normalize(p), typeof c === 'string' ? new TextEncoder().encode(c) : c); }
        _put(p, bytes) { let d = parentOf(p); const chain = []; while (d !== '/') { chain.push(d); d = parentOf(d); } chain.forEach((x) => this.dirs.add(x)); this.files.set(p, { bytes, mtime: ++this.clock }); }
        stat(p) { this.log.push('stat ' + p); const f = this.files.get(p); if (f) return { kind: 'file', size: f.bytes.length, mtime: f.mtime }; if (this.dirs.has(p)) return { kind: 'directory', size: 0, mtime: 1 }; return null; }
        list(p) { this.log.push('list ' + p); if (!this.dirs.has(p)) return null; const out = []; const pre = p === '/' ? '/' : p + '/'; for (const d of this.dirs) if (d !== '/' && parentOf(d) === p) out.push({ name: baseOf(d), kind: 'directory' }); for (const k of this.files.keys()) if (parentOf(k) === p) out.push({ name: baseOf(k), kind: 'file' }); void pre; return out; }
        read(p, start, end) { this.log.push('read ' + p + ' ' + start + '-' + end); const f = this.files.get(p); if (!f) { const e = new Error('ENOENT'); e.code = 'ENOENT'; throw e; } return { bytes: f.bytes.slice(start, end), size: f.bytes.length, mtime: f.mtime }; }
        writeFile(p, bytes, expect, force) { this.log.push('write ' + p + ' ' + bytes.length); const f = this.files.get(p); if (!force) { if (f && (!expect || f.bytes.length !== expect.size || f.mtime !== expect.mtime)) return { ok: false, conflict: true, size: f.bytes.length, mtime: f.mtime }; if (!f && expect) return { ok: false, conflict: true, size: 0, mtime: 0 }; } this._put(p, bytes.slice()); const g = this.files.get(p); return { ok: true, size: g.bytes.length, mtime: g.mtime }; }
        mkdir(p) { this.log.push('mkdir ' + p); this.dirs.add(p); }
        rmdir(p) { this.log.push('rmdir ' + p); this.dirs.delete(p); }
        remove(p) { this.log.push('remove ' + p); this.files.delete(p); }
        external(p, text) { this._put(normalize(p), typeof text === 'string' ? new TextEncoder().encode(text) : text); } // 模擬外部程式改檔案
    }
    return { FapMountFs, mountRouter, MemoryBackend, fsError, ERRNO, normalize, BLOCK, MAX_BLOCKS, HIGH_WATER, MAX_WRITE_FILE };
});
