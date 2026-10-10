/* 遠端群組的傳輸層：Cloudflare KV 慢速信箱（最後的備援）。介面與 rg_transport_supabase.js 相同。
 * 用 Worker（cloudflare/fa-worker/worker.js）當信箱：訊息用輪詢收，所以很慢（幾秒到幾十秒），只適合文字與少量訊息。
 * 免費方案的額度（KV 每天約 1000 次寫入、1000 次列舉、10 萬次讀取）是這一層的真正上限：
 *   - 在線登記每 10 分鐘更新一次、名單每 5 分鐘（或遇到不認識的人時）重抓一次；
 *   - 同一個收件人的訊息會合併成一次寫入，且同一個 key 每 1.1 秒最多寫一次（KV 的限制）；
 *   - 輪詢：最近 2 分鐘有往來就每 8 秒，否則每 30 秒。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRemoteTransportKv = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    class KvTransport {
        // opts: { url, fetch?, activeMs?, idleMs?, rosterMs?, presMs?, flushGapMs?, touchMs? }
        constructor(opts) {
            this.url = String(opts.url || '').replace(/\/+$/, ''); this.fetch = opts.fetch || ((...a) => fetch(...a));
            this.activeMs = opts.activeMs || 8000; this.idleMs = opts.idleMs || 30000; this.rosterMs = opts.rosterMs || 5 * 60 * 1000; this.presMs = opts.presMs || 10 * 60 * 1000; this.gapMs = opts.flushGapMs || 1100; this.touchMs = opts.touchMs || 6 * 3600 * 1000;
            this.isKv = true; this.ch = null; this.lastTouch = 0;
        }
        async call(path, body) {
            let r; try { r = await this.fetch(this.url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch (e) { throw new Error('連不上慢速備援：' + ((e && e.message) || e)); }
            let j = null; try { j = await r.json(); } catch (_) { /* */ }
            if (!r.ok) { const e = new Error((j && j.error) || ('慢速備援回應 ' + r.status)); e.notInstalled = r.status === 500 && j && /綁定 KV/.test(j.error || ''); throw e; }
            if (!j || Array.isArray(j) || (j.ok === undefined && j.result === undefined)) { const e = new Error('慢速備援的 Worker 還沒更新成新版（請照 cloudflare/fa-worker/README.md 部署）'); e.notInstalled = true; throw e; }
            return j;
        }
        async rpc(fn, args) {
            if (fn === 'rg_touch_room') { if (Date.now() - this.lastTouch < this.touchMs) return true; }
            const j = await this.call('/rpc/' + fn, args); if (fn === 'rg_touch_room' && j.result) this.lastTouch = Date.now(); return j.result;
        }
        async connect(channel, nodeId, h) {
            this.stop(); this.ch = channel; this.node = nodeId; this.h = h; this.since = {}; this.roster = []; this.rosterAt = 0; this.activeUntil = Date.now() + 2 * 60 * 1000; this.fails = 0; this.queues = new Map(); this.stopped = false;
            await this.refreshRoster(); if (h.onStatus) h.onStatus('SUBSCRIBED');
            this.loop();
        }
        stop() { this.stopped = true; clearTimeout(this.pollTimer); clearTimeout(this.presTimer); this.pollTimer = null; }
        async refreshRoster() {
            const j = await this.call('/roster', { ch: this.ch }); this.rosterAt = Date.now(); this.roster = (j.out || []).map((x) => x.node);
            const st = {}; for (const x of (j.out || [])) st[x.node] = [{ e: x.e }]; if (this.h && this.h.onPresence) this.h.onPresence(st);
        }
        async track(payload) {
            this.lastTrack = payload; await this.call('/pres', { ch: this.ch, node: this.node, e: payload.e });
            clearTimeout(this.presTimer); const beat = () => { if (this.stopped) return; this.presTimer = setTimeout(async () => { try { await this.call('/pres', { ch: this.ch, node: this.node, e: this.lastTrack.e }); } catch (_) { /* 下次再試 */ } beat(); }, this.presMs); }; beat();
            this.rosterAt = 0; if (this.roster.length) this.refreshRoster().catch(() => {}); // 自己的登記好了就順便刷新名單
        }
        // 寄一則（一塊）訊息：同一個收件人的先排隊，合併後一次寫；回傳的 promise 在寫入完成後才結束
        async send(payload) {
            if (this.stopped || !this.ch) throw new Error('尚未連線');
            this.activeUntil = Date.now() + 2 * 60 * 1000;
            let targets; if (payload.to === '*') targets = this.roster.filter((n) => n !== this.node); else { if (!this.roster.includes(payload.to) && Date.now() - this.rosterAt > 20000) { try { await this.refreshRoster(); } catch (_) { /* */ } } targets = this.roster.includes(payload.to) ? [payload.to] : []; }
            await Promise.all(targets.map((to) => this.enqueue(to, payload)));
        }
        enqueue(to, payload) {
            let q = this.queues.get(to); if (!q) { q = { items: [], running: false, lastAt: 0 }; this.queues.set(to, q); }
            return new Promise((resolve, reject) => { q.items.push({ payload, resolve, reject }); this.flush(to, q); });
        }
        async flush(to, q) {
            if (q.running) return; q.running = true;
            try {
                while (q.items.length && !this.stopped) {
                    const wait = q.lastAt + this.gapMs - Date.now(); if (wait > 0) await sleep(wait); else await sleep(0); // 讓同一時間排進來的合併成一批
                    const batch = q.items.splice(0, 20);
                    try { await this.call('/send', { ch: this.ch, to, from: this.node, payloads: batch.map((b) => b.payload) }); q.lastAt = Date.now(); batch.forEach((b) => b.resolve()); }
                    catch (e) { q.lastAt = Date.now(); batch.forEach((b) => b.reject(e)); }
                }
            } finally { q.running = false; }
        }
        loop() {
            if (this.stopped) return; const ms = Date.now() < this.activeUntil ? this.activeMs : this.idleMs;
            this.pollTimer = setTimeout(async () => {
                try { await this.pollOnce(); this.fails = 0; }
                catch (e) { this.fails++; if (this.fails === 3 && this.h && this.h.onStatus) this.h.onStatus('CHANNEL_ERROR'); }
                this.loop();
            }, ms);
        }
        async pollOnce() {
            if (Date.now() - this.rosterAt > (Date.now() < this.activeUntil ? Math.min(this.rosterMs, 60000) : this.rosterMs)) await this.refreshRoster(); // 有往來時名單每分鐘刷新，閒置時才慢
            const from = this.roster.filter((n) => n !== this.node); if (!from.length) return;
            const j = await this.call('/poll', { ch: this.ch, node: this.node, from, since: this.since }); let unknown = false;
            for (const o of (j.out || [])) {
                if ((this.since[o.from] || 0) > o.seq) this.since[o.from] = 0; // 對方的信箱重新開始了（序號歸零）
                for (const m of o.msgs) { if (m.s <= (this.since[o.from] || 0)) continue; this.since[o.from] = m.s; this.activeUntil = Date.now() + 2 * 60 * 1000; try { this.h.onBroadcast && this.h.onBroadcast(m.p); } catch (_) { /* */ } }
            }
            if (j.out && j.out.some((o) => o.msgs.length) && !from.every((n) => this.roster.includes(n))) unknown = true; if (unknown) await this.refreshRoster();
        }
        async disconnect() {
            const ch = this.ch, node = this.node; this.stop(); this.ch = null;
            if (ch) { try { await this.call('/leave', { ch, node }); } catch (_) { /* 沒送成就等 30 分鐘自動消失 */ } }
        }
    }
    return { KvTransport };
});
