/* 多人同編的主機轉接層(接在 edit_host.js 後面,同一個 FaEditHost)。設計見 DESIGN.edit-remote.md §6.5;文件邏輯在 FaEditSession,訊息層在 FaEditCollab。
 * 流程:主持機在編輯器標題列按「👥 共編」→「分享給群組」;別台用 /edit-join 列出、/edit-join 編號 加入(把主持機的文件存成自己本機的一份專案,之後文件由主持機編號)。
 * 每個編輯器的 host 帶 collabUi(標題列按鈕)與 collab(已經在共編時的轉接器);外框(edit_shell.js)只認這個轉接器。
 * 目前還沒做:素材(圖片 ref)的自動取得、重開後自動重連、主持權轉移。 */
(function () {
    'use strict';
    const H = FaEditHost, T = H.T, M = H.methods;
    const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    M._edCollab = function () {
        const rg = this._rg; if (!rg || !rg.room || typeof FaEditCollab === 'undefined') return null;
        if (!rg.collab) rg.collab = new FaEditCollab.Collab({ room: rg.room, kinds: (k) => this._edRemoteKind(k), gate: (m) => this._rgGate(m), allow: () => { const st = this._rgSettings(); return !st.allowDispatch ? T('這台機器目前不接受遠端需求', 'This machine does not accept remote requests') : ''; }, log: (x) => this._rgLog(x), peer: rg.edit });
        return rg.collab;
    };
    // 外框用的轉接器:把 HostSession／Participant 包成同一個樣子
    M._edCollabAdapter = function (session) {
        return {
            session, spec: () => session.spec, diff: (a, b) => FaRemotePatch.diff(a, b), propose: (patch, meta) => Promise.resolve(session.propose(patch, meta)),
            undo: () => session.undo(), redo: () => session.redo(), undoable: () => session.undoable(), redoable: () => session.redoable(), members: () => session.members(), color: (n) => FaEditSession.color(n),
            status: () => session.state || 'online', queued: () => (session.queued ? session.queued() : 0), presence: (sel) => session.presence(sel), on: (e, f) => session.on(e, f),
        };
    };
    M._edShareNow = function (kind, id) {
        this._edShared = this._edShared || new Map(); const key = kind + ':' + id; if (this._edShared.has(key)) return this._edShared.get(key);
        const c = this._edCollab(); if (!c) throw new Error(T('還沒加入遠端群組', 'Not in a remote group'));
        const node = this._edEditors && this._edEditors.get(key); if (!node || !node._ed) throw new Error(T('編輯器還沒開好', 'The editor is not ready'));
        const spec = node._ed.getSpec(), hs = c.share({ sid: id, kind, title: spec.title || '', spec });
        const rec = { role: 'host', session: hs, adapter: this._edCollabAdapter(hs) }; this._edShared.set(key, rec); node._ed.attachCollab(rec.adapter); return rec;
    };
    M._edUnshare = function (kind, id) {
        const key = kind + ':' + id, rec = this._edShared && this._edShared.get(key); if (!rec) return; const node = this._edEditors && this._edEditors.get(key);
        try { if (rec.role === 'host') rec.session.close(); else rec.session.leave(); } catch (_) { /* */ } this._edShared.delete(key); try { if (node && node._ed) node._ed.detachCollab(); } catch (_) { /* */ }
    };
    // 開著的編輯器(重新掛載時)要接回去;剛加入的專案掛好就接上
    M._edCollabAttach = function (kind, id, node) {
        const key = kind + ':' + id, rec = this._edShared && this._edShared.get(key); if (rec && node._ed.attachCollab) node._ed.attachCollab(rec.adapter);
    };
    M._edCollabPanel = function (kind, id, el) {
        const self = this, key = kind + ':' + id; let box = el.querySelector('.collabpanel'); if (box) { box.remove(); return; }
        box = document.createElement('div'); box.className = 'collabpanel'; box.style.cssText = 'position:absolute;z-index:50;top:36px;left:40px;background:#fff;color:#222;border:1px solid #888;border-radius:8px;padding:10px;min-width:260px;max-width:360px;box-shadow:0 4px 18px rgba(0,0,0,.3);font-size:13px'; el.appendChild(box);
        const draw = () => {
            const rec = self._edShared && self._edShared.get(key), c = self._edCollab(); box.textContent = '';
            const add = (t, tag) => { const d = document.createElement(tag || 'div'); d.innerHTML = t; box.appendChild(d); return d; }, btn = (label, fn) => { const b = document.createElement('button'); b.textContent = label; b.style.cssText = 'margin:4px 6px 0 0'; b.onclick = fn; box.appendChild(b); return b; };
            add('<b>👥 ' + T('共同編輯', 'Co-editing') + '</b>');
            if (!c) { add(T('還沒加入遠端群組(右上角的遠端面板)。', 'Not in a remote group yet.')); btn(T('關閉', 'Close'), () => box.remove()); return; }
            if (!rec) { add(T('把這個編輯器分享給群組:別台用 /edit-join 加入,每個人都有完整副本,由這台排序;各人只復原自己的步驟。', 'Share this editor with the group: others join with /edit-join; everyone keeps a full copy, this machine orders the changes; undo only undoes your own steps.')); btn(T('分享給群組', 'Share with the group'), () => { try { self._edShareNow(kind, id); } catch (e) { add('⚠️ ' + esc(e.message)); return; } draw(); }); }
            else {
                add((rec.role === 'host' ? T('你是主持機。', 'You are the host. ') : T('已加入共編(主持機:', 'Joined (host: ') + esc(rec.session.hostNode ? rec.session.hostNode.name : '') + ')'));
                const ms = rec.session.members(); ms.forEach((m) => { const d = add('<span style="color:' + FaEditSession.color(m.name) + '">●</span> ' + (m.kind === 'web' ? '🌐 ' : '') + esc(m.name) + (m.host ? '(' + T('主持', 'host') + ')' : '') + (m.readonly ? '(' + T('唯讀', 'read-only') + ')' : '')); if (rec.role === 'host' && !m.host) { const b1 = document.createElement('button'); b1.textContent = m.readonly ? T('改成可編輯', 'Allow edit') : T('設為唯讀', 'Read-only'); b1.style.marginLeft = '8px'; b1.onclick = () => { rec.session.setReadonly(m.nodeId, !m.readonly); draw(); }; d.appendChild(b1); const b2 = document.createElement('button'); b2.textContent = T('移除', 'Remove'); b2.style.marginLeft = '4px'; b2.onclick = () => { rec.session.remove(m.nodeId); draw(); }; d.appendChild(b2); } });
                btn(rec.role === 'host' ? T('停止分享', 'Stop sharing') : T('離開共編(保留本機副本)', 'Leave (keep my copy)'), () => { self._edUnshare(kind, id); box.remove(); });
            }
            btn(T('關閉', 'Close'), () => box.remove());
        };
        draw();
    };
    // /edit-join:不帶編號=列出群組裡別台開著的編輯器;帶編號=加入
    M._edJoinSlash = async function (argsText, run) {
        const r = run || this, n = parseInt(String(argsText || '').trim(), 10);
        r.messages.push({ role: 'user', content: '/edit-join' + (argsText ? ' ' + argsText : '') });
        const say = (t) => { r._pushAssistantMessage(t, null); try { r._persistChatHistory(); r._renderMessageHistory(); } catch (_) { /* */ } };
        const c = this._edCollab(); if (!c) return say(T('還沒加入遠端群組,先到右上角的遠端面板加入。', 'Not in a remote group yet.'));
        if (!n) {
            const items = await c.list(); this._edJoinList = items;
            if (!items.length) return say(T('群組裡目前沒有人開放共同編輯。對方在編輯器標題列按「👥 共編」→「分享給群組」,你再下一次 /edit-join。', 'Nobody in the group is sharing an editor.'));
            return say(T('群組裡開著的編輯器(/edit-join 編號 加入):\n', 'Shared editors (/edit-join N):\n') + items.map((it, i) => (i + 1) + '. ' + it.host.name + ' · ' + (H.KINDS[it.kind] ? H.KINDS[it.kind].label() : it.kind) + ' · ' + (it.title || T('（未命名）', '(untitled)')) + ' · ' + it.online + T(' 人在線', ' online')).join('\n'));
        }
        const it = (this._edJoinList || [])[n - 1]; if (!it) return say(T('沒有這個編號,先下 /edit-join 看清單。', 'No such number; run /edit-join first.'));
        try {
            const p = await c.join(it.host, it.sid, { kind: it.kind }), K = H.KINDS[it.kind]; if (!K) { p.leave(); return say(T('這台沒有這種編輯器:', 'No such editor here: ') + it.kind); }
            const spec = p.spec; this._edPendingJoin = this._edPendingJoin || new Map();
            const res = await this._edOpen(it.kind, { spec, origin: { shared: { host: it.host.nodeId, name: it.host.name, sid: it.sid } } });
            if (!res || !res.ok) { p.leave(); return say(T('開不起來:', 'Could not open: ') + ((res && res.error) || '')); }
            this._edShared = this._edShared || new Map(); const rec = { role: 'joined', session: p, adapter: this._edCollabAdapter(p) }; this._edShared.set(it.kind + ':' + res.id, rec);
            for (let i = 0; i < 120; i++) { const node = this._edEditors && this._edEditors.get(it.kind + ':' + res.id); if (node && node._ed && node._ed.attachCollab) { node._ed.attachCollab(rec.adapter); break; } await new Promise((ok) => setTimeout(ok, 50)); }   // 編輯器下一個畫面才掛上來
            say(T('已加入 ' + it.host.name + ' 的共同編輯。', 'Joined ' + it.host.name + '\'s session.'));
        } catch (e) { say(T('加入失敗:', 'Could not join: ') + String((e && e.message) || e)); }
        return '';
    };
    M._registerEditCollabCommands = function () {
        this.register_slash_command('/edit-join', '[編號]', '加入群組裡別台開放的共同編輯:不帶編號列出清單,帶編號加入。對方先在編輯器標題列「👥 共編」分享。', (a, run0) => (run0 || this)._edJoinSlash(a, run0));
    };
    const prev = M._registerEditCommands; M._registerEditCommands = function () { if (prev) prev.call(this); this._registerEditCollabCommands(); };
})();
