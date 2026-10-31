/* 遠端編輯器的橋接層（骨架）。設計見 DESIGN.edit-remote.md。
 * 編輯器照常在本機顯示；編輯器裡的「請求」（ask、polish、detail、transcribe…）交給群組裡選定的機器執行，
 * 文件與素材傳過去、改動（edits）與產生的素材傳回來。純邏輯（UMD、不碰畫面），建立在 Room 的介面上（send、on('message')、self、members）
 * 與 FaRemoteFiles.FileShare（素材傳輸），所以可以用記憶體傳輸測試。
 *
 *   const peer = new FaRemoteEdit.Peer({ room, files, kinds, gate, allow, caps, log })
 *     kinds(kind) → { remote:{ sync, methods:{ ask:{doc:true, longRunning?}, … }, assets:{ has, get, put } }, run(method, args, ctx) }  (沒有就是這台不支援)
 *       run 是「執行者」這邊真正做事的函式（呼叫本機的 host 方法）；assets 是素材轉接器（ns 一律 'ref'）
 *     gate(m) → 錯誤文字或 ''（指紋核對、限制模式）；allow() → 錯誤文字或 ''（允許派工、唯讀沙盒）
 *   peer.call(target, kind, sid, method, args, opts) → Promise(值；物件結果會多一個 by 欄位)
 *   FaRemoteEdit.proxyHost(peer, { kind, sid, local, getTarget }) → 一個 host：宣告為遠端的方法交給 getTarget() 那台，沒有目標就用本機
 * 訊息：ed_hello/ed_hello_ack、ed_call、ed_event、ed_result、ed_cancel、ed_ack、ed_close（本機當文件的主人；執行者只存「快取」，見設計 §3、§9）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRemoteEdit = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const rnd = () => Math.random().toString(36).slice(2, 10);
    const OFFER_TTL = 15 * 60 * 1000, SESSION_MAX = 8, HELLO_TTL = 60 * 1000;

    // 穩定序列化（鍵排序）與雜湊：只用來對齊「執行者手上的快取是不是這一版」，不是安全用途
    function canon(v) {
        if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
        if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
        return '{' + Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
    }
    function hash(v) {
        const s = canon(v); let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
        for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 2654435761); h2 = Math.imul(h2 ^ c, 1597334677); }
        h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909); h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
        return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16) + ':' + s.length;
    }
    // 文件或結果裡出現的素材代號：叫 ref 的字串欄位（svg／picture 的圖片物件）、picture 擴散細化層的 result（img 開頭的代號）、3D 貼圖的「ref:代號」字串。
    // 編輯器可以在宣告裡給 remote.refsOf(值) → [代號] 取代這個通用規則
    function collectRefs(v, out) {
        out = out || [];
        if (Array.isArray(v)) v.forEach((x) => collectRefs(x, out));
        else if (v && typeof v === 'object') { for (const k of Object.keys(v)) { const x = v[k]; if (k === 'ref' && typeof x === 'string' && x) out.push(x); else if (k === 'result' && typeof x === 'string' && /^img[A-Za-z0-9]{2,60}$/.test(x)) out.push(x); else collectRefs(x, out); } }
        else if (typeof v === 'string') { const m = /^ref:([A-Za-z0-9_-]{1,64})$/.exec(v); if (m) out.push(m[1]); }
        return out;
    }
    const refsOf = (k, v) => (k && k.remote && typeof k.remote.refsOf === 'function' ? k.remote.refsOf(v) : collectRefs(v)) || [];
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64'); };
    const unb64 = (s) => { if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } return new Uint8Array(Buffer.from(s, 'base64')); };
    function dataUrlToBlob(du) {
        const m = /^data:([^;,]*)((?:;[^;,]*)*),([\s\S]*)$/.exec(du); if (!m) throw new Error('不是 data URL');
        const mime = m[1] || 'application/octet-stream', isB64 = /;base64/i.test(m[2]);
        return new Blob([isB64 ? unb64(m[3]) : new TextEncoder().encode(decodeURIComponent(m[3]))], { type: mime });
    }
    async function blobToDataUrl(blob) { return 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + b64(new Uint8Array(await blob.arrayBuffer())); }
    const isBlob = (x) => typeof Blob !== 'undefined' && x instanceof Blob;

    class Peer {
        constructor(o) {
            this.room = o.room; this.files = o.files || null; this.kinds = o.kinds || (() => null); this.gate = o.gate || (async () => ''); this.allow = o.allow || (() => ''); this.caps = o.caps || (() => ({})); this.log = o.log || (() => {});
            this.slow = 1; this.idleMs = 120000; this.longIdleMs = 600000; this.ackMs = 15000;
            this.offers = new Map(); this.pending = new Map(); this.asks = new Map(); this.sessions = new Map(); this.known = new Map(); this.helloCache = new Map(); this.cancelled = new Set();
            this.lock = Promise.resolve(); this.queued = 0; this.stats = { specSent: 0, specSkipped: 0, blobsOffered: 0, calls: 0 };
            this.room.on('message', (m) => { if (m && typeof m.type === 'string' && m.type.startsWith('ed_')) this.handle(m).catch((e) => this.log('編輯器橋接訊息處理失敗：' + ((e && e.message) || e))); });
        }
        // ───────── 素材提供（給 FileShare 的 getFile／allowed 用）
        getOffered(id) { const o = this.offers.get(id); return o && o.exp > Date.now() ? { blob: o.blob, name: o.name, mime: o.mime } : null; }
        isAllowed(id, from) { const o = this.offers.get(id); return !!(o && o.exp > Date.now() && o.to === from); }
        offer(id, blob, name, mime, to, cid) { this.offers.set(id, { blob, name: name || id, mime: mime || blob.type || 'application/octet-stream', to, cid, exp: Date.now() + OFFER_TTL }); this.stats.blobsOffered++; if (this.offers.size > 400) this.prune(); }
        prune() { const now = Date.now(); for (const [k, v] of this.offers) if (v.exp < now) this.offers.delete(k); }
        dropOffers(cid) { for (const [k, v] of this.offers) if (v.cid === cid) this.offers.delete(k); }
        // ───────── 編碼／解碼：Blob 與很長的 data URL 換成 {$blob}，內容走素材傳輸
        async encode(v, cid, to) {
            let n = 0; const self = this;
            const handle = (blob, name, as) => { const id = 'ed:' + cid + ':' + (n++); self.offer(id, blob, name, blob.type, to, cid); return { $blob: { id, as: as || '', name: name || '', mime: blob.type || '', size: blob.size } }; };
            async function w(x) {
                if (x === undefined || typeof x === 'function') return undefined;
                if (x === null) return null;
                if (isBlob(x)) return handle(x, x.name || 'blob', '');
                if (typeof x === 'string') { if (x.length > 2000 && /^data:[^;,]*(;[^;,]*)*,/.test(x)) { try { return handle(dataUrlToBlob(x), 'data', 'dataUrl'); } catch (_) { return x; } } return x; }
                if (Array.isArray(x)) { const out = []; for (const i of x) { const r = await w(i); out.push(r === undefined ? null : r); } return out; }
                if (typeof x === 'object') { const out = {}; for (const k of Object.keys(x)) { const r = await w(x[k]); if (r !== undefined) out[k] = r; } return out; }
                return x;
            }
            return w(v);
        }
        async decode(v, from, cancel) {
            const self = this;
            async function w(x) {
                if (Array.isArray(x)) { const out = []; for (const i of x) out.push(await w(i)); return out; }
                if (x && typeof x === 'object') {
                    if (x.$blob && typeof x.$blob.id === 'string') { if (!self.files) throw new Error('沒有素材傳輸通道'); const r = await self.files.fetch(from, x.$blob.id, { cancel: cancel || { cancelled: false } }); return x.$blob.as === 'dataUrl' ? blobToDataUrl(r.blob) : r.blob; }
                    const out = {}; for (const k of Object.keys(x)) out[k] = await w(x[k]); return out;
                }
                return x;
            }
            return w(v);
        }
        // ───────── 問答
        ask(to, type, body, replyType, ms) {
            const rid = rnd() + rnd();
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => { this.asks.delete(rid); reject(new Error('對方沒有回應')); }, (ms || 8000) * this.slow);
                this.asks.set(rid, { replyType, resolve: (v) => { clearTimeout(t); this.asks.delete(rid); resolve(v); } });
                this.room.send(to, type, Object.assign({ rid }, body || {})).catch((e) => { clearTimeout(t); this.asks.delete(rid); reject(e); });
            });
        }
        async hello(to, kind) {
            const key = to + '|' + kind, c = this.helloCache.get(key); if (c && c.exp > Date.now()) return c.v;
            const v = await this.ask(to, 'ed_hello', { kind }, 'ed_hello_ack'); this.helloCache.set(key, { v, exp: Date.now() + HELLO_TTL }); return v;
        }
        // ───────── 請求者：把一次方法呼叫交給 target（{nodeId, name}）
        async call(t, kind, sid, method, args, o) {
            o = o || {}; this.stats.calls++;
            const k = this.kinds(kind); if (!k || !k.remote || !k.remote.methods) throw new Error('這台機器沒有「' + kind + '」的遠端橋接宣告');
            const h = await this.hello(t.nodeId, kind); if (!h.ok) throw new Error(h.error || (t.name + ' 不能做「' + kind + '」'));
            const def = k.remote.methods[method] || {}, cid = rnd() + rnd(), req0 = args[0] && typeof args[0] === 'object' && !isBlob(args[0]) && !Array.isArray(args[0]) ? args[0] : null;
            const onStatus = req0 && typeof req0.onStatus === 'function' ? req0.onStatus : null, signal = req0 && req0.signal;
            const spec = def.doc && req0 ? req0.spec : undefined, key = t.nodeId + '|' + sid;
            const send = async (forceSpec) => {
                const refs = [];
                if (spec !== undefined && k.remote.assets) { for (const ref of new Set(refsOf(k, spec))) { let blob = null; try { blob = await k.remote.assets.get('ref', ref); } catch (_) { /* 沒有就不送 */ } if (blob) { const id = 'ed:' + cid + ':r:' + ref; this.offer(id, blob, ref, blob.type, t.nodeId, cid); refs.push({ ref, id }); } } }
                const wireArgs = await this.encode(args.map((a, i) => (i === 0 && req0 ? Object.assign({}, a, { spec: undefined }) : a)), cid, t.nodeId);
                const dh = spec !== undefined ? hash(spec) : '', sendSpec = spec !== undefined && (forceSpec || this.known.get(key) !== dh);
                if (spec !== undefined) { if (sendSpec) this.stats.specSent++; else this.stats.specSkipped++; }
                const body = { sid, cid, kind, method, args: wireArgs, docHash: dh, refs }; if (sendSpec) body.spec = spec;
                return { body, dh };
            };
            const wait = (idleMs) => new Promise((resolve, reject) => {
                let idle = null, ack = null, done = false; const ms = (idleMs || (def.longRunning ? this.longIdleMs : this.idleMs)) * this.slow;
                const fin = (fn, v) => { if (done) return; done = true; clearTimeout(idle); clearTimeout(ack); this.pending.delete(cid); fn(v); };
                const bump = () => { clearTimeout(idle); idle = setTimeout(() => fin(reject, new Error(t.name + ' 太久沒有動靜（' + Math.round(ms / 1000) + ' 秒），已放棄。對方可能離線或被瀏覽器凍結了。')), ms); };
                ack = setTimeout(() => fin(reject, new Error(t.name + ' 沒有回應（' + Math.round(this.ackMs * this.slow / 1000) + ' 秒）。對方可能已離線。')), this.ackMs * this.slow);
                this.pending.set(cid, { onEvent: (ev) => { clearTimeout(ack); bump(); if (ev && ev.text && onStatus) { try { onStatus(String(ev.text)); } catch (_) { /* */ } } }, resolve: (r) => fin(resolve, r) }); bump();
                if (signal) { const ab = () => { this.room.send(t.nodeId, 'ed_cancel', { cid }).catch(() => {}); fin(reject, new Error('已取消')); }; if (signal.aborted) ab(); else if (signal.addEventListener) signal.addEventListener('abort', ab, { once: true }); }
            });
            try {
                let { body, dh } = await send(false), p = wait(); await this.room.send(t.nodeId, 'ed_call', body); let r = await p;
                if (r && r.need === 'spec' && spec !== undefined) { this.known.delete(key); ({ body, dh } = await send(true)); p = wait(); await this.room.send(t.nodeId, 'ed_call', body); r = await p; }
                if (!r || r.ok === false) throw new Error((r && r.error) || (t.name + ' 沒有做成'));
                if (spec !== undefined) this.known.set(key, dh);
                // 對方產生的素材：先全部抓回來存好，才把結果交給編輯器套用（不會有「物件有了、圖還沒到」的半成品）
                if (Array.isArray(r.refs) && r.refs.length && k.remote.assets) { for (const x of r.refs) { if (await k.remote.assets.has('ref', x.ref)) continue; const f = await this.files.fetch(t.nodeId, x.id, { cancel: { cancelled: false } }); await k.remote.assets.put('ref', x.ref, f.blob, { name: x.ref }); } }
                const value = await this.decode(r.value, t.nodeId);
                this.room.send(t.nodeId, 'ed_ack', { cid }).catch(() => {});
                const me = this.room.self || {};
                if (value && typeof value === 'object' && !Array.isArray(value)) value.by = { src: 'ai', exec: { nodeId: t.nodeId, name: t.name }, req: { nodeId: me.nodeId, name: me.name } };
                return value;
            } finally { this.dropOffers(cid); this.pending.delete(cid); }
        }
        cancel(cid, to) { this.room.send(to, 'ed_cancel', { cid }).catch(() => {}); }
        closeSession(to, sid) { this.known.delete(to + '|' + sid); this.room.send(to, 'ed_close', { sid }).catch(() => {}); }
        // ───────── 訊息處理
        async handle(m) {
            const b = m.body || {};
            if (m.type === 'ed_hello_ack') { const a = this.asks.get(b.rid); if (a && a.replyType === m.type) a.resolve(b); return; }
            if (m.type === 'ed_event') { const p = this.pending.get(b.cid); if (p) p.onEvent(b); return; }
            if (m.type === 'ed_result') { const p = this.pending.get(b.cid); if (p) { p.onEvent({}); p.resolve(b); } return; }
            if (m.type === 'ed_ack') { this.dropOffers(b.cid); return; }
            if (m.type === 'ed_cancel') { this.cancelled.add(b.cid); setTimeout(() => this.cancelled.delete(b.cid), OFFER_TTL); return; }
            if (m.type === 'ed_close') { this.sessions.delete(m.from + '|' + b.sid); return; }
            if (m.type === 'ed_hello') { return this.onHello(m); }
            if (m.type === 'ed_call') { this.queued++; this.room.send(m.from, 'ed_event', { cid: b.cid, kind: 'ack', text: this.queued > 1 ? '對方正在忙，已排隊（前面還有 ' + (this.queued - 1) + ' 個）' : '' }).catch(() => {}); const run = this.lock.then(() => this.exec(m)); this.lock = run.catch(() => {}); try { await run; } finally { this.queued--; } }
        }
        async onHello(m) {
            const b = m.body || {}, reply = (o) => this.room.send(m.from, 'ed_hello_ack', Object.assign({ rid: b.rid }, o)).catch(() => {});
            const gerr = await this.gate(m); if (gerr) return reply({ ok: false, error: gerr });
            const aerr = this.allow(); if (aerr) return reply({ ok: false, error: aerr });
            const k = this.kinds(b.kind); if (!k || !k.remote || !k.remote.methods) return reply({ ok: false, error: '這台機器沒有「' + b.kind + '」編輯器（版本太舊或被停用了）' });
            let caps = {}; try { caps = this.caps(b.kind) || {}; } catch (_) { caps = {}; }
            reply({ ok: true, kind: b.kind, methods: Object.keys(k.remote.methods), caps, name: (this.room.self || {}).name });
        }
        // ───────── 執行者：真正做事
        async exec(m) {
            const b = m.body || {}, cid = b.cid, to = m.from;
            const reply = (o) => this.room.send(to, 'ed_result', Object.assign({ cid }, o)).catch(() => {});
            const ev = (text) => this.room.send(to, 'ed_event', { cid, kind: 'status', text: String(text == null ? '' : text).slice(0, 300) }).catch(() => {});
            try {
                const gerr = await this.gate(m); if (gerr) return reply({ ok: false, error: gerr });
                const aerr = this.allow(); if (aerr) return reply({ ok: false, error: aerr });
                const k = this.kinds(b.kind), def = k && k.remote && k.remote.methods && k.remote.methods[b.method];
                if (!k || !def || typeof k.run !== 'function') return reply({ ok: false, error: '這台機器沒有「' + b.kind + '」的 ' + b.method + '（版本太舊，或沒有這個編輯器）' });
                if (this.cancelled.has(cid)) return reply({ ok: false, error: '已取消' });
                const skey = to + '|' + b.sid; let sess = this.sessions.get(skey);
                if (def.doc) {
                    if (b.spec !== undefined) { if (hash(b.spec) !== b.docHash) return reply({ ok: false, error: '文件在傳輸中被改變（雜湊不符），已丟棄' }); sess = { kind: b.kind, spec: b.spec, hash: b.docHash, used: Date.now() }; this.sessions.set(skey, sess); this.trimSessions(); }
                    else if (!sess || sess.hash !== b.docHash) return reply({ ok: false, need: 'spec' });
                    sess.used = Date.now();
                }
                const cancelObj = { get cancelled() { return false; } };
                if (Array.isArray(b.refs) && b.refs.length && k.remote.assets) { for (const x of b.refs) { if (await k.remote.assets.has('ref', x.ref)) continue; ev('取得素材…'); const f = await this.files.fetch(to, x.id, { cancel: cancelObj }); await k.remote.assets.put('ref', x.ref, f.blob, { name: x.ref }); } }
                const args = await this.decode(b.args, to, cancelObj), req0 = args[0] && typeof args[0] === 'object' && !isBlob(args[0]) && !Array.isArray(args[0]) ? args[0] : null;
                if (req0) { if (def.doc && sess) req0.spec = sess.spec; req0.onStatus = (t) => ev(t); req0.shouldStop = () => this.cancelled.has(cid); }
                ev('開始處理…');
                const value = await k.run(b.method, args, { sid: b.sid, from: to, spec: sess && sess.spec, shouldStop: () => this.cancelled.has(cid) });
                if (this.cancelled.has(cid)) return reply({ ok: false, error: '已取消' });
                const refs = [];
                if (k.remote.assets) { for (const ref of new Set(refsOf(k, value))) { let blob = null; try { blob = await k.remote.assets.get('ref', ref); } catch (_) { /* */ } if (blob) { const id = 'ed:' + cid + ':o:' + ref; this.offer(id, blob, ref, blob.type, to, cid); refs.push({ ref, id }); } } }
                const wire = await this.encode(value === undefined ? null : value, cid, to);
                reply({ ok: true, value: wire, refs });
            } catch (e) { reply({ ok: false, error: String((e && e.message) || e).slice(0, 500) }); }
            finally { setTimeout(() => this.cancelled.delete(cid), 1000); }
        }
        trimSessions() { if (this.sessions.size <= SESSION_MAX) return; const arr = [...this.sessions.entries()].sort((a, b) => a[1].used - b[1].used); while (arr.length > SESSION_MAX) this.sessions.delete(arr.shift()[0]); }
    }

    // 一個 host：宣告成遠端的方法交給 getTarget() 那台（沒有目標＝用本機），其餘（save、download、toChat…）留在本機
    function proxyHost(peer, o) {
        const k = peer.kinds(o.kind), methods = (k && k.remote && k.remote.methods) || {}, local = o.local, host = Object.assign({}, local);
        Object.keys(methods).forEach((name) => {
            const fn = local && local[name]; if (typeof fn !== 'function') return;   // 本機沒有的方法（例如離線時沒有 polish）不替它造一個，介面才不會多出會失敗的按鈕
            host[name] = function () {
                const args = Array.prototype.slice.call(arguments), t = o.getTarget && o.getTarget();
                if (!t) return fn.apply(local, args);
                return peer.call(t, o.kind, o.sid, name, args, {});
            };
        });
        return host;
    }
    return { Peer, proxyHost, canon, hash, collectRefs, dataUrlToBlob, blobToDataUrl };
});
