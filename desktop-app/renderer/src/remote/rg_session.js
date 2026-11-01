/* 多人同編的核心（UMD、純函式、不碰網路與畫面）。設計見 DESIGN.edit-remote.md §6 / §6.5。
 *   一筆 commit 一律是 id 定址的 patch（FaRemotePatch）：提出者在自己的副本上算好「改完的文件」，送 diff(改前, 改後)；
 *   所以不管編輯器是 edits / patch / snapshot 模式、有沒有相機或選取這類本機 env，每個副本套出的都是同一份文件（不需要 resolve）。
 *   FaEditSession.createHost({ spec, keys, maxLog }) → host
 *     host.propose(by, { base, patch, summary, text, src, kind }) → { ok, commit?, rejected, error? }   主持機唯一編 rev；唯讀者被拒；套不上的動作略過並回報；全部套不上就不編號
 *     host.join(by) / host.leave(nodeId) / host.setReadonly(nodeId, bool) / host.remove(nodeId) / host.members() / host.snapshot() / host.since(rev) → commits 或 null（太舊要整份）
 *   FaEditSession.createReplica({ spec, rev, keys, nodeId }) → replica
 *     replica.receive(commit) → 'ok' | 'dup' | 'gap' | 'diverged'；replica.reset(snapshot)；replica.spec / rev
 *     replica.undoable() / redoable()；replica.undoPatch() / redoPatch() → 要提出的 patch（各人只復原自己的步驟）；replica.noteOwn(commit) 內部呼叫
 *   FaEditSession.color(name) → 固定色；FaEditSession.hash(spec) */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./rg_patch.js'));
    else root.FaEditSession = factory(root.FaRemotePatch || (typeof FaRemotePatch !== 'undefined' ? FaRemotePatch : undefined));
})(typeof self !== 'undefined' ? self : this, function (P) {
    'use strict';
    const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
    function hash(spec) { const s = JSON.stringify(spec); let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0).toString(16); }
    function color(name) { let h = 0; const s = String(name || ''); for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return 'hsl(' + (h % 360) + ',65%,55%)'; }
    const sameWho = (a, b) => !!a && !!b && a.nodeId === b.nodeId;

    function createHost(cfg) {
        cfg = cfg || {}; const keys = cfg.keys || {}, maxLog = cfg.maxLog || 400;
        let spec = clone(cfg.spec), rev = cfg.rev | 0; const log = []; const mem = new Map();   // nodeId → { by, readonly, joinedAt }
        function snapshot() { return { rev, spec: clone(spec), hash: hash(spec), members: members() }; }
        function members() { return [...mem.values()].map((m) => ({ nodeId: m.by.nodeId, name: m.by.name, kind: m.by.kind, readonly: !!m.readonly })); }
        function join(by) { if (!by || !by.nodeId) return { ok: false, error: 'no-id' }; if (!mem.has(by.nodeId)) mem.set(by.nodeId, { by: { nodeId: by.nodeId, name: by.name, kind: by.kind }, readonly: false, joinedAt: rev }); else mem.get(by.nodeId).by = { nodeId: by.nodeId, name: by.name, kind: by.kind }; return { ok: true, snapshot: snapshot() }; }
        function propose(by, req) {
            if (!by || !by.nodeId) return { ok: false, error: 'no-id', rejected: [] };
            const m = mem.get(by.nodeId); if (m && m.readonly) return { ok: false, error: 'readonly', rejected: [] };
            const patch = (req && req.patch) || [];
            if (!patch.length) return { ok: false, error: 'empty', rejected: [] };
            const r = P.apply(spec, patch, keys);
            if (!r.applied.length) return { ok: false, error: 'all-rejected', rejected: r.rejected || [] };
            const applied = r.applied;
            spec = r.doc; rev++;
            const c = { rev, by: { nodeId: by.nodeId, name: by.name, kind: by.kind, src: (req && req.src) || 'user', exec: req && req.exec, req: req && req.req }, patch: applied, summary: (req && req.summary) || '', text: (req && req.text) || '', kind: (req && req.kind) || 'edit', reqId: req && req.reqId, base: req && req.base, hashAfter: hash(spec) };
            log.push(c); if (log.length > maxLog) log.shift();
            return { ok: true, commit: c, rejected: r.rejected || [] };
        }
        return {
            get rev() { return rev; }, get spec() { return spec; }, snapshot, members, join, propose,
            leave(id) { mem.delete(id); },
            remove(id) { mem.delete(id); },
            setReadonly(id, v) { const m = mem.get(id); if (m) m.readonly = !!v; return !!m; },
            since(r) { if (r >= rev) return []; if (!log.length || log[0].rev > r + 1) return null; return log.filter((c) => c.rev > r); },
            log() { return log.slice(); },
        };
    }

    function createReplica(cfg) {
        cfg = cfg || {}; const keys = cfg.keys || {}; const me = cfg.nodeId; let spec = clone(cfg.spec), rev = cfg.rev | 0;
        let undo = [], redo = [];   // 只記自己的步驟：{ rev, inverse, forward, summary }
        const queue = [];           // 主持機離線時暫存的 patch
        function receive(c) {
            if (!c || typeof c.rev !== 'number') return 'diverged';
            if (c.rev <= rev) return 'dup';
            if (c.rev !== rev + 1) return 'gap';
            const before = spec, r = P.apply(spec, c.patch || [], keys);
            spec = r.doc; rev = c.rev;
            if (c.hashAfter && c.hashAfter !== hash(spec)) return 'diverged';
            if (me && c.by && c.by.nodeId === me) {
                if (c.kind === 'undo') { /* 已在 undoPatch() 搬過 */ }
                else if (c.kind === 'redo') { /* 同上 */ }
                else { undo.push({ rev: c.rev, inverse: P.diff(spec, before, keys), forward: c.patch, summary: c.summary }); redo = []; if (undo.length > 200) undo.shift(); }
            }
            return 'ok';
        }
        function reset(s) { spec = clone(s.spec); rev = s.rev | 0; }
        return {
            get spec() { return spec; }, get rev() { return rev; }, receive, reset,
            undoable() { return undo.length > 0; }, redoable() { return redo.length > 0; },
            // 取出要提出的「復原」patch：以現在的文件重算（別人改過的地方不會被蓋掉；被別人刪掉的對象略過）
            undoPatch() { const e = undo.pop(); if (!e) return null; redo.push(e); return { patch: e.inverse, summary: '復原：' + (e.summary || ''), kind: 'undo' }; },
            redoPatch() { const e = redo.pop(); if (!e) return null; undo.push(e); return { patch: e.forward, summary: '重做：' + (e.summary || ''), kind: 'redo' }; },
            // 復原的提出被主持機整個拒絕（例如全被別人改掉）：把步驟放回去
            undoFailed() { const e = redo.pop(); if (e) undo.push(e); }, redoFailed() { const e = undo.pop(); if (e) redo.push(e); },
            enqueue(p) { queue.push(p); return queue.length; }, queued() { return queue.slice(); }, drain() { return queue.splice(0); },
            diffTo(next) { return P.diff(spec, next, keys); },
            resetUndo() { undo = []; redo = []; },
        };
    }
    return { createHost, createReplica, hash, color, sameWho };
});
