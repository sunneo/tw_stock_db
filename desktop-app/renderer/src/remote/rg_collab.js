/* 多人同編的訊息層（UMD、不碰畫面）。設計見 DESIGN.edit-remote.md §6.5；文件邏輯（編號、副本、各人復原）在 FaEditSession。
 *   const c = new FaEditCollab.Collab({ room, kinds, gate, allow, log })      kinds(kind) → 有這個編輯器就回物件（跟 FaRemoteEdit.Peer 同一個函式）；gate(m)／allow() 同 Peer
 *   const hs = c.share({ sid, kind, title, spec, keys })                       我是主持機：hs.propose(patch, meta) 本地提出；hs.onCommit/onMembers/onPresence(fn)；hs.setReadonly(id, v)/remove(id)/presence(sel)/close()
 *   const items = await c.list()                                               群組裡各台開著且允許加入的編輯器 [{ host:{nodeId,name}, sid, kind, title, online }]
 *   const p = await c.join(hostNode, sid)                                      我是參與者：p.spec/rev/members；p.propose(patch, meta) → { ok, rejected, error, queued };p.undo()/redo()；p.onCommit/onMembers/onPresence/onStatus(fn)；p.presence(sel)/leave()
 * 訊息：ed_list(_ack)、ed_join(_ack)、ed_leave、ed_commit_req／ed_commit_ack、ed_commit、ed_sync_req／ed_sync、ed_members、ed_presence、ed_shared_close。
 * by 由主持機依「通道上已驗證的寄件者」蓋章，不信 payload 自稱的身分；exec／req（AI 由誰執行、應誰要求）是資訊，照帶。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./rg_session.js'));
    else root.FaEditCollab = factory(root.FaEditSession || (typeof FaEditSession !== 'undefined' ? FaEditSession : undefined));
})(typeof self !== 'undefined' ? self : this, function (S) {
    'use strict';
    const rnd = () => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6);
    const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
    class Emitter { constructor() { this.fns = {}; } on(k, f) { (this.fns[k] = this.fns[k] || []).push(f); return this; } emit(k, v) { (this.fns[k] || []).forEach((f) => { try { f(v); } catch (_) { /* */ } }); } }

    class Collab {
        constructor(o) {
            this.room = o.room; this.kinds = o.kinds || (() => null); this.gate = o.gate || (async () => ''); this.allow = o.allow || (() => ''); this.log = o.log || (() => {});
            this.shared = new Map(); this.joined = new Map(); this.asks = new Map(); this.slow = 1; this.askMs = 8000;
            this.room.on('message', (m) => { if (m && typeof m.type === 'string' && /^ed_(list|join|leave|commit|sync|members|presence|shared_close)/.test(m.type)) this.handle(m).catch((e) => this.log('多人同編訊息處理失敗：' + ((e && e.message) || e))); });
            this.room.on('members', () => { for (const p of this.joined.values()) p._checkHost(); });
        }
        who(id) { const m = (this.room.members() || []).find((x) => x.nodeId === id); return { nodeId: id, name: m ? m.name : id.slice(0, 6), kind: m ? m.kind : 'web' }; }
        ask(to, type, body, ms) {
            const rid = rnd();
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => { this.asks.delete(rid); reject(new Error('對方沒有回應')); }, (ms || this.askMs) * this.slow);
                this.asks.set(rid, (v) => { clearTimeout(t); this.asks.delete(rid); resolve(v); });
                this.room.send(to, type, Object.assign({ rid }, body || {})).catch((e) => { clearTimeout(t); this.asks.delete(rid); reject(e); });
            });
        }
        share(o) { const hs = new HostSession(this, o); this.shared.set(o.sid, hs); return hs; }
        async list(ms) {
            const rid = rnd(), out = [];
            this.asks.set(rid, (v) => out.push(v));
            await this.room.send('*', 'ed_list', { rid }).catch(() => {});
            await new Promise((r) => setTimeout(r, (ms || 1200) * this.slow)); this.asks.delete(rid);
            const items = []; for (const v of out) for (const it of v.items || []) items.push(Object.assign({ host: v.host }, it)); return items;
        }
        async join(host, sid) {
            const r = await this.ask(host.nodeId, 'ed_join', { sid, kind: (arguments[2] || {}).kind });
            if (!r.ok) throw new Error(r.error || '加入失敗');
            const p = new Participant(this, host, sid, r); this.joined.set(host.nodeId + '|' + sid, p); return p;
        }
        async handle(m) {
            const b = m.body || {}, t = m.type;
            if (b.rid && this.asks.has(b.rid) && /_ack$|^ed_sync$/.test(t) && t !== 'ed_commit_req') { this.asks.get(b.rid)(Object.assign({ from: m.from, host: this.who(m.from) }, b)); return; }
            if (t === 'ed_list') {
                if (await this.gate(m) || this.allow()) return;
                const items = [...this.shared.values()].filter((h) => h.open && this.kinds(h.kind)).map((h) => ({ sid: h.sid, kind: h.kind, title: h.title, online: h.host.members().length + 1 }));
                if (items.length) this.room.send(m.from, 'ed_list_ack', { rid: b.rid, items }).catch(() => {}); return;
            }
            const key = (t === 'ed_commit' || t === 'ed_members' || t === 'ed_shared_close' || t === 'ed_sync' || (t === 'ed_presence' && this.joined.has(m.from + '|' + b.sid))) ? m.from + '|' + b.sid : null;
            if (key) { const p = this.joined.get(key); if (p) p._onMsg(t, b); return; }
            const hs = this.shared.get(b.sid); if (!hs) { if (b.rid) this.room.send(m.from, t === 'ed_join' ? 'ed_join_ack' : 'ed_commit_ack', { rid: b.rid, ok: false, error: '對方已經沒有開這個編輯器了' }).catch(() => {}); return; }
            await hs._onMsg(m, t, b);
        }
    }

    class HostSession extends Emitter {
        constructor(c, o) { super(); this.c = c; this.sid = o.sid; this.kind = o.kind; this.title = o.title || ''; this.open = o.open !== false; this.host = S.createHost({ spec: o.spec, keys: o.keys, rev: o.rev }); this.me = o.me || c.room.self; this.replica = S.createReplica({ spec: o.spec, rev: o.rev | 0, nodeId: this.me.nodeId, keys: o.keys }); this.parts = new Set(); this.pres = new Map(); }
        get spec() { return this.host.spec; } get rev() { return this.host.rev; }
        members() { return [{ nodeId: this.me.nodeId, name: this.me.name, kind: this.me.kind, host: true }].concat(this.host.members().filter((m) => m.nodeId !== this.me.nodeId)); }
        _fan(type, body, except) { for (const id of this.parts) if (id !== except) this.c.room.send(id, type, body).catch(() => {}); }
        _commit(r) { if (!r.ok) return r; this.replica.receive(r.commit); this._fan('ed_commit', { sid: this.sid, commit: r.commit }); this.emit('commit', r.commit); return r; }
        // 主持機自己的提出（本地、馬上編號）
        propose(patch, meta) { return this._commit(this.host.propose(this.me, Object.assign({ patch }, meta || {}))); }
        undo() { const u = this.replica.undoPatch(); if (!u) return null; const r = this.propose(u.patch, { summary: u.summary, kind: 'undo' }); if (!r.ok) this.replica.undoFailed(); return r; }
        redo() { const u = this.replica.redoPatch(); if (!u) return null; const r = this.propose(u.patch, { summary: u.summary, kind: 'redo' }); if (!r.ok) this.replica.redoFailed(); return r; }
        undoable() { return this.replica.undoable(); } redoable() { return this.replica.redoable(); }
        _members() { const ms = this.members(); this._fan('ed_members', { sid: this.sid, members: ms }); this.emit('members', ms); }
        setReadonly(id, v) { this.host.setReadonly(id, v); this._members(); } remove(id) { this.host.remove(id); this.parts.delete(id); this.c.room.send(id, 'ed_shared_close', { sid: this.sid, reason: '已被主持人移出' }).catch(() => {}); this._members(); }
        presence(sel) { this._fan('ed_presence', { sid: this.sid, by: this.me.nodeId, sel }); }
        close() { this._fan('ed_shared_close', { sid: this.sid, reason: '主持人關閉了這個編輯器' }); this.c.shared.delete(this.sid); this.open = false; }
        async _onMsg(m, t, b) {
            const c = this.c, reply = (type, o) => c.room.send(m.from, type, Object.assign({ rid: b.rid }, o)).catch(() => {});
            if (t === 'ed_join') {
                const gerr = await c.gate(m); if (gerr) return reply('ed_join_ack', { ok: false, error: gerr });
                const aerr = c.allow(); if (aerr) return reply('ed_join_ack', { ok: false, error: aerr });
                if (!this.open) return reply('ed_join_ack', { ok: false, error: '主持人沒有開放別人加入' });
                const by = c.who(m.from), j = this.host.join(by); this.parts.add(m.from);
                reply('ed_join_ack', { ok: true, kind: this.kind, title: this.title, snapshot: j.snapshot, members: this.members() }); this._members(); return;
            }
            if (!this.parts.has(m.from)) { if (t === 'ed_commit_req') reply('ed_commit_ack', { ok: false, error: '你還沒有加入' }); return; }
            if (t === 'ed_leave') { this.host.leave(m.from); this.parts.delete(m.from); this._members(); return; }
            if (t === 'ed_commit_req') { const r = this._commit(this.host.propose(c.who(m.from), { patch: b.patch, summary: b.summary, text: b.text, src: b.src, exec: b.exec, req: b.req, kind: b.kind, base: b.base })); reply('ed_commit_ack', { ok: r.ok, rev: r.commit && r.commit.rev, rejected: r.rejected, error: r.error }); return; }
            if (t === 'ed_sync_req') { const cs = this.host.since(b.rev | 0); reply('ed_sync', cs ? { sid: this.sid, commits: cs } : { sid: this.sid, snapshot: this.host.snapshot() }); return; }
            if (t === 'ed_presence') { this._fan('ed_presence', { sid: this.sid, by: m.from, sel: b.sel }, m.from); this.emit('presence', { by: c.who(m.from), sel: b.sel }); }
        }
    }

    class Participant extends Emitter {
        constructor(c, host, sid, r) { super(); this.c = c; this.hostNode = host; this.sid = sid; this.kind = r.kind; this.title = r.title; this.membersList = r.members || []; this.me = c.room.self; this.replica = S.createReplica({ spec: r.snapshot.spec, rev: r.snapshot.rev, nodeId: this.me.nodeId }); this.state = 'online'; this.syncing = false; }
        get spec() { return this.replica.spec; } get rev() { return this.replica.rev; } members() { return this.membersList; } queued() { return this.replica.queued().length; }
        _hostHere() { return (this.c.room.members() || []).some((x) => x.nodeId === this.hostNode.nodeId); }
        _setState(s) { if (s !== this.state) { this.state = s; this.emit('status', s); } }
        _checkHost() { if (this._hostHere()) { if (this.state === 'offline') this._reconnect(); } else this._setState('offline'); }
        async _reconnect() {
            try { const r = await this.c.ask(this.hostNode.nodeId, 'ed_join', { sid: this.sid }, 4000); if (!r.ok) { this._setState('closed'); return; } this._apply(r.snapshot.rev === this.rev ? [] : null, r.snapshot); this.membersList = r.members || []; this._setState('online'); this.emit('members', this.membersList);
                for (const it of this.replica.drain()) { const x = await this._send(it); this.emit('flushed', x); } } catch (_) { /* 還沒回來,下次 members 事件再試 */ }
        }
        _apply(commits, snap) {
            if (commits === null) { this.replica.reset(snap); this.replica.resetUndo(); this.emit('reset', this.replica.spec); return; }
            for (const cm of commits) { const x = this.replica.receive(cm); if (x === 'diverged') { this._sync(true); return; } if (x === 'gap') { this._sync(); return; } if (x === 'ok') this.emit('commit', cm); }
        }
        async _sync(force) {
            if (this.syncing) return; this.syncing = true;
            try { const r = await this.c.ask(this.hostNode.nodeId, 'ed_sync_req', { sid: this.sid, rev: force ? -1 : this.rev }); if (r.commits && !force) this._apply(r.commits); else this._apply(null, r.snapshot || (r.commits ? null : null)); } catch (_) { /* */ } finally { this.syncing = false; }
        }
        _onMsg(t, b) {
            if (t === 'ed_commit') { const x = this.replica.receive(b.commit); if (x === 'ok') this.emit('commit', b.commit); else if (x === 'gap') this._sync(); else if (x === 'diverged') this._sync(true); return; }
            if (t === 'ed_members') { this.membersList = b.members || []; this.emit('members', this.membersList); return; }
            if (t === 'ed_presence') { this.emit('presence', { by: this.c.who(b.by), sel: b.sel }); return; }
            if (t === 'ed_shared_close') { this._setState('closed'); this.emit('closed', b.reason || ''); }
        }
        async _send(meta) {
            const r = await this.c.ask(this.hostNode.nodeId, 'ed_commit_req', { sid: this.sid, base: this.rev, patch: meta.patch, summary: meta.summary, text: meta.text, src: meta.src, exec: meta.exec, req: meta.req, kind: meta.kind });
            return { ok: r.ok, rejected: r.rejected || [], error: r.error, rev: r.rev };
        }
        // 提出：回傳時（ok）已經套在自己的副本上了（commit 先到、ack 後到）;主持機離線就暫存
        async propose(patch, meta) {
            const m = Object.assign({ patch }, meta || {});
            if (this.state === 'closed') return { ok: false, error: '這個共編已經結束了', rejected: [] };
            if (this.state === 'offline' || !this._hostHere()) { this._setState('offline'); this.replica.enqueue(m); return { ok: false, queued: true, error: '主持機離線，已暫存', rejected: [] }; }
            try { return await this._send(m); } catch (e) { this._setState('offline'); this.replica.enqueue(m); return { ok: false, queued: true, error: '主持機沒有回應，已暫存', rejected: [] }; }
        }
        async undo() { const u = this.replica.undoPatch(); if (!u) return null; const r = await this.propose(u.patch, { summary: u.summary, kind: 'undo' }); if (!r.ok) this.replica.undoFailed(); return r; }
        async redo() { const u = this.replica.redoPatch(); if (!u) return null; const r = await this.propose(u.patch, { summary: u.summary, kind: 'redo' }); if (!r.ok) this.replica.redoFailed(); return r; }
        undoable() { return this.replica.undoable(); } redoable() { return this.replica.redoable(); }
        presence(sel) { this.c.room.send(this.hostNode.nodeId, 'ed_presence', { sid: this.sid, sel }).catch(() => {}); }
        leave() { this.c.room.send(this.hostNode.nodeId, 'ed_leave', { sid: this.sid }).catch(() => {}); this.c.joined.delete(this.hostNode.nodeId + '|' + this.sid); }
    }
    return { Collab, HostSession, Participant };
});
