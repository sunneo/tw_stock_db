/* 遠端群組的核心（純邏輯＋ WebCrypto，UMD；不碰畫面、不碰網路）。設計見 DESIGN.remote-group.md。
 *   - 密碼規則與強度、產生密碼
 *   - 由「密碼＋房間代號」推導：頻道名稱、加密金鑰、驗證值（PBKDF2）
 *   - 加解密（AES-GCM），錯誤的金鑰解不開
 *   - Room：在任何「傳輸層」（Supabase 即時通道或測試用的記憶體傳輸）上建立加密的群組：
 *       在線名單（成員資料加密）、人數上限、名稱不重複、訊息（自動切塊與重組）
 * 傳輸層介面：connect(channelName, nodeId, handlers) / track(payload) / send(payload) / disconnect()
 *   handlers = { onPresence(stateObject), onBroadcast(payload), onStatus(status) }  */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRemoteGroup = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ITERATIONS = 600000;
    const CHUNK = 32 * 1024;           // 單則廣播的字元數上限（即時通道實測 64KB 可以、256KB 不行）
    const enc = new TextEncoder(), dec = new TextDecoder();
    const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64'); };
    const unb64 = (s) => { if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } return new Uint8Array(Buffer.from(s, 'base64')); };
    function getCrypto() { return (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : require('crypto').webcrypto; }

    // ---------------------------------------------------------------- 密碼
    const COMMON = ['password', 'passw0rd', 'qwerty', 'qwertyuiop', 'asdfgh', 'zxcvbn', '123456', '1234567', '12345678', '123456789', 'iloveyou', 'admin', 'welcome', 'letmein', 'monkey', 'dragon', 'abc123', '111111', '000000', 'sunneo', 'floating', 'assistant'];
    function passwordStrength(pw) {
        pw = String(pw == null ? '' : pw); const reasons = [];
        if (!pw) return { ok: false, bits: 0, label: '空白', reasons: ['不接受空白密碼'] };
        if (pw.length < 12) reasons.push('至少 12 個字元（目前 ' + pw.length + '）');
        const low = pw.toLowerCase();
        const hit = COMMON.find((w) => low.includes(w));
        if (hit && hit.length >= Math.ceil(pw.length / 2)) reasons.push('太常見（包含「' + hit + '」）');
        if (/^[0-9]+$/.test(pw)) reasons.push('不能全是數字');
        if (/(.)\1{3,}/.test(pw)) reasons.push('不要連續重複同一個字元');
        let charset = 0; if (/[a-z]/.test(pw)) charset += 26; if (/[A-Z]/.test(pw)) charset += 26; if (/[0-9]/.test(pw)) charset += 10; if (/[^A-Za-z0-9]/.test(pw)) charset += 33;
        const unique = new Set(pw).size; const eff = unique + 0.5 * (pw.length - unique);
        const seq = /(abcd|bcde|cdef|1234|2345|3456|4567|5678|6789|qwer|wert|asdf|sdfg|zxcv)/i.test(pw) ? 6 : 0; // 順序／鍵盤排列扣分
        const bits = Math.max(0, Math.floor(eff * Math.log2(Math.max(charset, 2)) - seq * 3));
        if (bits < 60) reasons.push('強度不夠（約 ' + bits + ' 位元，要 60 以上）：加長，或混用大小寫、數字與符號');
        return { ok: reasons.length === 0, bits, label: bits >= 90 ? '很強' : bits >= 60 ? '夠用' : '太弱', reasons };
    }
    // 產生密碼：20 個不易混淆的字元（約 115 位元），每 4 個一組以「-」相連，好抄好念
    function generatePassword(groups) {
        groups = groups || 5; const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; const n = groups * 4;
        const buf = new Uint8Array(n * 2); getCrypto().getRandomValues(buf); let out = '', k = 0;
        for (let i = 0; i < n; i++) { let v; do { v = buf[k++ % buf.length]; if (k > buf.length * 4) getCrypto().getRandomValues(buf); } while (v >= 224); out += alphabet[v % alphabet.length]; if (i % 4 === 3 && i < n - 1) out += '-'; }
        return out;
    }

    // ---------------------------------------------------------------- 金鑰推導與加解密
    // password + code → { channel: 'rg:<32 hex>', key: CryptoKey(AES-GCM), verifier: <64 hex> }
    async function deriveKeys(password, code, iterations) {
        const c = getCrypto(), s = c.subtle;
        const base = await s.importKey('raw', enc.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
        const bits = new Uint8Array(await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('fa-remote-group/v1/' + String(code)), iterations: iterations || ITERATIONS }, base, 96 * 8));
        const key = await s.importKey('raw', bits.slice(16, 48), 'AES-GCM', false, ['encrypt', 'decrypt']);
        const verifier = hex(new Uint8Array(await s.digest('SHA-256', bits.slice(48, 80))));
        return { channel: 'rg:' + hex(bits.slice(0, 16)), key, verifier, code: String(code) };
    }
    async function encryptJson(keys, obj) {
        const c = getCrypto(), iv = c.getRandomValues(new Uint8Array(12));
        const ct = new Uint8Array(await c.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(keys.code) }, keys.key, enc.encode(JSON.stringify(obj))));
        return b64(iv) + '.' + b64(ct);
    }
    // 解不開（金鑰不對、被竄改、格式不對）一律回 null
    async function decryptJson(keys, text) {
        try {
            const i = String(text).indexOf('.'); if (i < 0) return null;
            const pt = await getCrypto().subtle.decrypt({ name: 'AES-GCM', iv: unb64(text.slice(0, i)), additionalData: enc.encode(keys.code) }, keys.key, unb64(text.slice(i + 1)));
            return JSON.parse(dec.decode(pt));
        } catch (_) { return null; }
    }
    async function fingerprint(text) { const d = new Uint8Array(await getCrypto().subtle.digest('SHA-256', enc.encode(String(text)))); return hex(d.slice(0, 5)).replace(/(.{4})(?=.)/g, '$1-'); }
    // ---- 機器身分：每台機器一把簽章金鑰（ECDSA P-256），公鑰放進在線名單；指紋 = 公鑰的雜湊。敏感訊息（派工、改設定、搬家）會簽名，
    // 收的人用名單上的公鑰驗證——這樣群組裡別的成員無法冒用某台機器的名義送出這些訊息。
    const canon = (v) => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : (v && typeof v === 'object') ? '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
    async function makeIdentity(saved) {
        const c = getCrypto(); let priv, pub;
        try { if (saved && saved.priv && saved.pub) { priv = await c.subtle.importKey('jwk', saved.priv, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); pub = saved.pub; } } catch (_) { priv = null; }
        let exported = null;
        if (!priv) { const kp = await c.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']); const pj = await c.subtle.exportKey('jwk', kp.publicKey), sj = await c.subtle.exportKey('jwk', kp.privateKey); pub = { kty: pj.kty, crv: pj.crv, x: pj.x, y: pj.y }; priv = await c.subtle.importKey('jwk', sj, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']); exported = { pub, priv: sj }; }
        return { pub, exported, sign: async (text) => b64(new Uint8Array(await c.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, enc.encode(String(text))))) };
    }
    async function verifySig(pub, text, sig) {
        try { const k = await getCrypto().subtle.importKey('jwk', Object.assign({ ext: true }, pub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']); return await getCrypto().subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, k, unb64(sig), enc.encode(String(text))); } catch (_) { return false; }
    }
    const pubFingerprint = (pub) => fingerprint(pub ? pub.x + '.' + pub.y : '');
    const randomId = () => hex(getCrypto().getRandomValues(new Uint8Array(8)));

    // ---------------------------------------------------------------- 群組
    class Room {
        // opts: { transport, keys, self:{name,kind,caps}, maxMembers, settleMs, now }
        constructor(opts) {
            this.t = opts.transport; this.keys = opts.keys; this.max = opts.maxMembers || 16; this.settleMs = opts.settleMs == null ? 2500 : opts.settleMs;
            this.self = Object.assign({ nodeId: randomId(), name: 'machine', kind: 'web', caps: [], since: Date.now() }, opts.self || {});
            this.membersMap = new Map(); this.handlers = {}; this.partial = new Map(); this.state = 'idle'; this.seq = 0; this.status = 'idle';
        }
        on(ev, fn) { (this.handlers[ev] = this.handlers[ev] || []).push(fn); return this; }
        emit(ev, a) { (this.handlers[ev] || []).forEach((fn) => { try { fn(a); } catch (e) { /* 事件處理錯誤不影響連線 */ } }); }
        members() { return Array.from(this.membersMap.values()).sort((a, b) => a.since - b.since); }
        async publishSelf() { await this.t.track({ e: await encryptJson(this.keys, this.self) }); }
        // 加入頻道；等在線名單穩定後檢查人數上限與名稱重複。回傳 {ok:true, members} 或 {ok:false, reason}
        async join() {
            this.state = 'joining';
            await this.t.connect(this.keys.channel, this.self.nodeId, {
                onPresence: (st) => this.onPresence(st),
                onBroadcast: (p) => this.onBroadcast(p),
                onStatus: (s) => { this.status = s; this.emit('status', s); },
            });
            await this.publishSelf();
            await new Promise((r) => setTimeout(r, this.settleMs));
            await this.refreshPresence();
            const others = this.members().filter((m) => m.nodeId !== this.self.nodeId);
            const earlier = others.filter((m) => m.since < this.self.since || (m.since === this.self.since && m.nodeId < this.self.nodeId));
            if (earlier.length >= this.max) { await this.leave(); return { ok: false, reason: 'full' }; }
            // 名稱重複：比我早到的人同名，我改名加編號
            const taken = new Set(others.map((m) => m.name)); let name = this.self.name, n = 2;
            if (taken.has(name)) { while (taken.has(this.self.name + '-' + n)) n++; name = this.self.name + '-' + n; this.self.name = name; await this.publishSelf(); }
            this.state = 'joined'; this.emit('members', this.members());
            return { ok: true, members: this.members(), name };
        }
        // 通道掉線後重新連回（沿用同一組處理函式），並重新登記在線狀態
        async reconnect() {
            if (this.state === 'left') return false;
            try { await this.t.disconnect(); } catch (_) { /* 舊通道已經壞了 */ }
            await this.t.connect(this.keys.channel, this.self.nodeId, { onPresence: (st) => this.onPresence(st), onBroadcast: (p) => this.onBroadcast(p), onStatus: (s) => { this.status = s; this.emit('status', s); } });
            await this.publishSelf(); return true;
        }
        async leave() { this.state = 'left'; try { await this.t.disconnect(); } catch (_) { /* 已斷線 */ } this.membersMap.clear(); this.emit('members', []); }
        onPresence(st) { this.lastPresence = st; this.refreshPresence(); }
        async refreshPresence() {
            const st = this.lastPresence || {}; const next = new Map();
            for (const key of Object.keys(st)) {
                for (const meta of (st[key] || [])) {
                    const e = meta && (meta.e || (meta.payload && meta.payload.e)); if (!e) continue;
                    const info = await decryptJson(this.keys, e);
                    if (info && info.nodeId) next.set(info.nodeId, info); // 解不開的（不是這個群組的、或被竄改的）直接略過
                }
            }
            const before = JSON.stringify(this.members().map((m) => [m.nodeId, m.name])); this.membersMap = next;
            if (this.state === 'joined' && before !== JSON.stringify(this.members().map((m) => [m.nodeId, m.name]))) this.emit('members', this.members());
        }
        // 傳訊息給某台（to=nodeId，'*' 是所有人）：整包加密後切塊廣播
        async send(to, type, body) {
            const id = this.self.nodeId + ':' + (++this.seq); const text = await encryptJson(this.keys, { type, body, from: this.self.nodeId, at: Date.now() });
            const total = Math.max(1, Math.ceil(text.length / CHUNK));
            for (let i = 0; i < total; i++) await this.t.send({ to, from: this.self.nodeId, id, i, n: total, c: text.slice(i * CHUNK, (i + 1) * CHUNK) });
            return id;
        }
        async onBroadcast(p) {
            if (!p || typeof p.c !== 'string' || (p.to !== '*' && p.to !== this.self.nodeId)) return;
            let slot = this.partial.get(p.id); if (!slot) { slot = { parts: new Array(p.n), got: 0, at: Date.now() }; this.partial.set(p.id, slot); }
            if (!slot.parts[p.i]) { slot.parts[p.i] = p.c; slot.got++; }
            if (this.partial.size > 64) { const old = Array.from(this.partial.entries()).sort((a, b) => a[1].at - b[1].at).slice(0, 32); old.forEach(([k]) => this.partial.delete(k)); }
            if (slot.got < p.n) return;
            this.partial.delete(p.id);
            const m = await decryptJson(this.keys, slot.parts.join(''));
            if (m && m.type) this.emit('message', { type: m.type, body: m.body, from: m.from, at: m.at, id: p.id });
        }
    }
    return { ITERATIONS, CHUNK, passwordStrength, generatePassword, deriveKeys, encryptJson, decryptJson, fingerprint, randomId, canon, makeIdentity, verifySig, pubFingerprint, Room, hex, b64, unb64 };
});
