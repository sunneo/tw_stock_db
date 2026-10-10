/* 遠端群組的傳輸層：Supabase 即時通道（廣播＋在線名單）。介面見 rg_core.js 開頭。
 * 只轉送加密後的封包；Supabase 看不到內容。*/
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaRemoteTransport = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    class SupabaseTransport {
        // opts: { url, key, loadLib: () => Promise（載入 supabase-js 的 UMD 版，之後 window.supabase 可用）, lib: window.supabase（測試用） }
        constructor(opts) { this.url = opts.url; this.key = opts.key; this.loadLib = opts.loadLib; this.lib = opts.lib || null; this.client = null; this.ch = null; }
        async ensureClient() {
            if (this.client) return this.client;
            if (!this.lib) { if (typeof window !== 'undefined' && window.supabase) this.lib = window.supabase; else { await this.loadLib(); this.lib = window.supabase; } }
            if (!this.lib || !this.lib.createClient) throw new Error('Supabase 用戶端函式庫載入失敗');
            this.client = this.lib.createClient(this.url, this.key, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, realtime: { params: { eventsPerSecond: 20 } } });
            return this.client;
        }
        async rpc(fn, args) {
            const c = await this.ensureClient(); const r = await c.rpc(fn, args);
            if (r.error) { const e = new Error(r.error.message || String(r.error)); e.code = r.error.code; e.notInstalled = /Could not find the function|schema cache|does not exist/i.test(r.error.message || ''); throw e; }
            return r.data;
        }
        async connect(channel, nodeId, h) {
            const c = await this.ensureClient(); this.handlers = h;
            const ch = c.channel(channel, { config: { broadcast: { self: false }, presence: { key: nodeId } } });
            ch.on('broadcast', { event: 'm' }, (p) => { try { h.onBroadcast && h.onBroadcast(p.payload); } catch (_) { /* */ } });
            ch.on('presence', { event: 'sync' }, () => { try { h.onPresence && h.onPresence(ch.presenceState()); } catch (_) { /* */ } });
            this.ch = ch; this.lastTrack = null;
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('連線即時通道逾時（20 秒）')), 20000); let first = true;
                ch.subscribe((status) => {
                    if (h.onStatus) h.onStatus(status);
                    if (status === 'SUBSCRIBED') { clearTimeout(timer); if (!first && this.lastTrack) ch.track(this.lastTrack).catch(() => {}); first = false; resolve(); }
                    else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') { if (first) { clearTimeout(timer); reject(new Error('即時通道連線失敗（' + status + '）')); } }
                });
            });
        }
        async track(payload) { this.lastTrack = payload; if (this.ch) await this.ch.track(payload); }
        async send(payload) { if (!this.ch) throw new Error('尚未連線'); const r = await this.ch.send({ type: 'broadcast', event: 'm', payload }); if (r && r !== 'ok') throw new Error('送出失敗：' + r); }
        async disconnect() { const ch = this.ch; this.ch = null; this.lastTrack = null; if (ch && this.client) { try { await ch.untrack(); } catch (_) { /* */ } try { await this.client.removeChannel(ch); } catch (_) { /* */ } } }
    }
    return { SupabaseTransport };
});
