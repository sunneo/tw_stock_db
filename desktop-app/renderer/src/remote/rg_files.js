/* 遠端群組的內容傳輸（第 3 階段）。設計見 DESIGN.remote-group.md 第 8 節。
 * 一台機器（提供者）把自己檔案快取裡的檔案「宣告」給某個要求者之後，要求者才能拿；拿的方式：
 *   1. 點對點直連（WebRTC 資料通道）：協商訊息（rtc_offer／rtc_answer／rtc_ice）走房間通道，檔案本體不經過 Supabase；
 *   2. 直連失敗（逾時或連線失敗）且檔案不大時，改用房間通道切塊轉送（file_pull／file_chunk，已被房間金鑰加密）。
 * 兩種方式都在收完後用 SHA-256 核對大小與雜湊，不符就丟掉。
 * 這個模組只依賴 Room 的介面（send、on('message')），可以用記憶體傳輸測試轉送路徑；直連路徑在瀏覽器裡測。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRemoteFiles = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const DC_CHUNK = 16 * 1024;            // 資料通道每塊 16KB（各瀏覽器都能互通）
    const RELAY_CHUNK = 24 * 1024;         // 轉送每塊 24KB 原始資料（base64 後約 32KB，在即時通道的訊息上限內）
    const RELAY_MAX = 16 * 1024 * 1024;    // 轉送備援只用在 16MB 以下的檔案
    const P2P_TIMEOUT = 12000;
    const hex = (u8) => Array.from(u8, (b) => b.toString(16).padStart(2, '0')).join('');
    const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return typeof btoa === 'function' ? btoa(s) : Buffer.from(u8).toString('base64'); };
    const unb64 = (s) => { if (typeof atob === 'function') { const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; } return new Uint8Array(Buffer.from(s, 'base64')); };
    const getCrypto = () => (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : require('crypto').webcrypto;
    async function sha256(blob) { const buf = blob.arrayBuffer ? await blob.arrayBuffer() : blob; return hex(new Uint8Array(await getCrypto().subtle.digest('SHA-256', buf))); }
    const rnd = () => Math.random().toString(36).slice(2, 10);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

    class FileShare {
        // opts: { room, getFile: async (id) => ({blob, name, mime}) | null, allowed: (id, fromNodeId) => boolean, rtc?: { RTCPeerConnection, iceServers }, log? }
        constructor(opts) {
            this.room = opts.room; this.getFile = opts.getFile; this.allowed = opts.allowed || (() => false); this.log = opts.log || (() => {});
            this.RTC = opts.rtc === undefined ? (typeof RTCPeerConnection !== 'undefined' ? RTCPeerConnection : null) : (opts.rtc && opts.rtc.RTCPeerConnection) || null;
            this.iceServers = (opts.rtc && opts.rtc.iceServers) || [{ urls: 'stun:stun.cloudflare.com:3478' }];
            this.shaCache = new Map(); this.pending = new Map(); this.sessions = new Map(); this.disableP2p = false;
            this.room.on('message', (m) => { this.handle(m).catch((e) => this.log('傳輸訊息處理失敗：' + (e && e.message || e))); });
        }
        // 向某台機器要東西並等回覆
        ask(nodeId, type, body, replyType, ms) {
            const rid = rnd() + rnd();
            return new Promise((resolve, reject) => {
                const t = setTimeout(() => { this.pending.delete(rid); reject(new Error('對方沒有回應')); }, ms || 8000);
                this.pending.set(rid, { replyType, resolve: (v) => { clearTimeout(t); this.pending.delete(rid); resolve(v); }, reject: (e) => { clearTimeout(t); this.pending.delete(rid); reject(e); } });
                this.room.send(nodeId, type, Object.assign({ rid }, body || {})).catch((e) => { clearTimeout(t); this.pending.delete(rid); reject(e); });
            });
        }
        async handle(m) {
            const b = m.body || {};
            // ---- 回覆（要求者這一邊）
            if (b.rid && this.pending.has(b.rid) && this.pending.get(b.rid).replyType === m.type) { const p = this.pending.get(b.rid); if (b.error) p.reject(new Error(b.error)); else p.resolve(b); return; }
            if (m.type === 'rtc_answer' || m.type === 'rtc_ice') { const s = this.sessions.get(b.sid); if (s && s.onSignal) await s.onSignal(m.type, b); return; }
            // ---- 要求（提供者這一邊）
            if (m.type === 'file_req') {
                if (!this.allowed(b.id, m.from)) return this.room.send(m.from, 'file_meta', { rid: b.rid, error: '沒有這個檔案，或沒有宣告給你' });
                const f = await this.getFile(b.id); if (!f) return this.room.send(m.from, 'file_meta', { rid: b.rid, error: '檔案已經不在了' });
                if (!this.shaCache.has(b.id)) this.shaCache.set(b.id, await sha256(f.blob));
                return this.room.send(m.from, 'file_meta', { rid: b.rid, id: b.id, name: f.name, mime: f.mime || f.blob.type || '', size: f.blob.size, sha: this.shaCache.get(b.id), p2p: !!this.RTC && !this.disableP2p });
            }
            if (m.type === 'file_pull') {
                if (!this.allowed(b.id, m.from)) return this.room.send(m.from, 'file_chunk', { rid: b.rid, error: '沒有宣告給你' });
                const f = await this.getFile(b.id); if (!f) return this.room.send(m.from, 'file_chunk', { rid: b.rid, error: '檔案已經不在了' });
                const start = b.index * RELAY_CHUNK, part = new Uint8Array(await f.blob.slice(start, start + RELAY_CHUNK).arrayBuffer());
                return this.room.send(m.from, 'file_chunk', { rid: b.rid, index: b.index, data: b64(part) });
            }
            if (m.type === 'rtc_offer') return this.serveRtc(m, b);
        }
        // ---- 提供者：接受直連，依要求串流檔案
        async serveRtc(m, b) {
            if (!this.RTC || this.disableP2p) return;
            if (!this.allowed(b.id, m.from)) return;
            const pc = new this.RTC({ iceServers: this.iceServers }); const sess = { pc, closed: false };
            const close = () => { if (!sess.closed) { sess.closed = true; try { pc.close(); } catch (_) { /* */ } this.sessions.delete(b.sid); } };
            sess.onSignal = async (type, body) => { if (type === 'rtc_ice' && body.cand) { try { await pc.addIceCandidate(body.cand); } catch (_) { /* */ } } };
            this.sessions.set(b.sid, sess); setTimeout(close, 10 * 60 * 1000);
            pc.onicecandidate = (e) => { if (e.candidate) this.room.send(m.from, 'rtc_ice', { sid: b.sid, cand: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }).catch(() => {}); };
            pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close(); };
            pc.ondatachannel = (ev) => {
                const dc = ev.channel; dc.binaryType = 'arraybuffer'; dc.bufferedAmountLowThreshold = 1 << 20;
                dc.onmessage = async (me) => {
                    let req; try { req = JSON.parse(me.data); } catch (_) { return; }
                    if (req.t !== 'get' || !this.allowed(req.id, m.from)) { dc.send(JSON.stringify({ t: 'err', error: '沒有宣告給你' })); return; }
                    const f = await this.getFile(req.id); if (!f) { dc.send(JSON.stringify({ t: 'err', error: '檔案已經不在了' })); return; }
                    const size = f.blob.size; let off = Math.max(0, Number(req.offset) || 0);
                    dc.send(JSON.stringify({ t: 'start', size, offset: off }));
                    while (off < size && dc.readyState === 'open') {
                        if (dc.bufferedAmount > (4 << 20)) { await new Promise((res) => { const h = () => { dc.removeEventListener('bufferedamountlow', h); res(); }; dc.addEventListener('bufferedamountlow', h); setTimeout(res, 2000); }); continue; }
                        const part = await f.blob.slice(off, Math.min(size, off + DC_CHUNK)).arrayBuffer(); dc.send(part); off += part.byteLength;
                    }
                    if (dc.readyState === 'open') dc.send(JSON.stringify({ t: 'end', size }));
                };
            };
            await pc.setRemoteDescription({ type: 'offer', sdp: b.sdp });
            const ans = await pc.createAnswer(); await pc.setLocalDescription(ans);
            await this.room.send(m.from, 'rtc_answer', { sid: b.sid, sdp: ans.sdp });
        }
        // ---- 要求者：取得檔案（Blob）。opts: { onProgress(done,total,via), cancel: {cancelled:boolean} }
        async fetch(nodeId, id, opts) {
            opts = opts || {}; const cancel = opts.cancel || { cancelled: false };
            const meta = await this.ask(nodeId, 'file_req', { id }, 'file_meta', 10000);
            const progress = (done, via) => { if (opts.onProgress) opts.onProgress(done, meta.size, via); };
            let blob = null, via = '', p2pErr = null;
            if (this.RTC && !this.disableP2p && meta.p2p !== false) { try { blob = await this.fetchP2p(nodeId, id, meta, progress, cancel); via = '直連'; } catch (e) { p2pErr = e; if (cancel.cancelled) throw e; this.log('直連失敗，改用轉送：' + (e && e.message || e)); } }
            if (!blob) {
                if (meta.size > RELAY_MAX) throw new Error('直連失敗（' + (p2pErr ? p2pErr.message : '不支援') + '），而且檔案超過 ' + (RELAY_MAX >> 20) + ' MB，轉送備援不處理這麼大的檔案');
                blob = await this.fetchRelay(nodeId, id, meta, progress, cancel); via = '轉送';
            }
            if (blob.size !== meta.size) throw new Error('收到的大小不符（' + blob.size + ' ≠ ' + meta.size + '）');
            if ((await sha256(blob)) !== meta.sha) throw new Error('內容雜湊不符：檔案在傳輸中損壞，已丟棄');
            return { blob, meta, via };
        }
        async fetchRelay(nodeId, id, meta, progress, cancel) {
            const n = Math.max(1, Math.ceil(meta.size / RELAY_CHUNK)); const parts = new Array(n); let got = 0, next = 0;
            const worker = async () => { while (next < n) { if (cancel.cancelled) throw new Error('已取消'); const i = next++; const r = await this.ask(nodeId, 'file_pull', { id, index: i }, 'file_chunk', 15000); parts[i] = unb64(r.data); got += parts[i].length; progress(Math.min(got, meta.size), '轉送'); } };
            await Promise.all([worker(), worker(), worker(), worker()]);
            return new Blob(parts, { type: meta.mime || 'application/octet-stream' });
        }
        fetchP2p(nodeId, id, meta, progress, cancel) {
            return new Promise((resolve, reject) => {
                const sid = rnd() + rnd(); const pc = new this.RTC({ iceServers: this.iceServers }); const dc = pc.createDataChannel('file', { ordered: true }); dc.binaryType = 'arraybuffer';
                const parts = []; let got = 0, started = false, done = false;
                const finish = (err, val) => { if (done) return; done = true; clearTimeout(timer); clearInterval(poll); this.sessions.delete(sid); try { dc.close(); } catch (_) { /* */ } try { pc.close(); } catch (_) { /* */ } err ? reject(err) : resolve(val); };
                const timer = setTimeout(() => finish(new Error(started ? '直連傳輸逾時' : '直連建立逾時（' + P2P_TIMEOUT / 1000 + ' 秒）')), P2P_TIMEOUT);
                const bump = () => { /* 有進度就延長逾時 */ };
                const poll = setInterval(() => { if (cancel.cancelled) finish(new Error('已取消')); }, 300);
                this.sessions.set(sid, { onSignal: async (type, b) => { if (type === 'rtc_answer') { try { await pc.setRemoteDescription({ type: 'answer', sdp: b.sdp }); } catch (e) { finish(e); } } else if (type === 'rtc_ice' && b.cand) { try { await pc.addIceCandidate(b.cand); } catch (_) { /* */ } } } });
                pc.onicecandidate = (e) => { if (e.candidate) this.room.send(nodeId, 'rtc_ice', { sid, cand: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate }).catch(() => {}); };
                pc.onconnectionstatechange = () => { if (pc.connectionState === 'failed') finish(new Error('直連連線失敗')); };
                dc.onopen = () => { clearTimeout(timer); dc.send(JSON.stringify({ t: 'get', id, offset: 0 })); started = true; timer2(); };
                let t2 = null; const timer2 = () => { clearTimeout(t2); t2 = setTimeout(() => finish(new Error('直連傳輸停住了（30 秒沒有資料）')), 30000); };
                dc.onmessage = (me) => {
                    if (typeof me.data === 'string') { let c; try { c = JSON.parse(me.data); } catch (_) { return; } if (c.t === 'err') finish(new Error(c.error)); else if (c.t === 'end') { clearTimeout(t2); finish(null, new Blob(parts, { type: meta.mime || 'application/octet-stream' })); } return; }
                    parts.push(me.data); got += me.data.byteLength; progress(got, '直連'); timer2(); bump();
                };
                dc.onerror = () => finish(new Error('資料通道錯誤'));
                pc.createOffer().then((o) => pc.setLocalDescription(o)).then(() => this.room.send(nodeId, 'rtc_offer', { sid, id, sdp: pc.localDescription.sdp })).catch(finish);
            });
        }
    }
    return { FileShare, sha256, DC_CHUNK, RELAY_CHUNK, RELAY_MAX };
});
