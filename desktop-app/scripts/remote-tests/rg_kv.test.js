// 慢速信箱（Cloudflare KV）：用記憶體裡的假 KV 直接呼叫 Worker，驗證登記、信箱、名單、加密群組、重連
const path = require('path');
const R = require(path.join(__dirname, '../../renderer/src/remote/rg_core.js'));
const { KvTransport } = require(path.join(__dirname, '../../renderer/src/remote/rg_transport_kv.js'));
let ok = 0; const bad = []; const check = (n, c, d) => { if (c) ok++; else bad.push(n + (d !== undefined ? ' → ' + JSON.stringify(d).slice(0, 200) : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 舊版 Node 沒有 Request／Response：用最小的替身
if (typeof Response === 'undefined') {
    global.Response = class { constructor(b, o) { this.body = b; this.status = (o && o.status) || 200; this.ok = this.status < 300; this.headers = (o && o.headers) || {}; } async json() { return JSON.parse(this.body); } async text() { return String(this.body); } };
    global.Request = class { constructor(u, i) { this.url = String(u); this.method = (i && i.method) || 'GET'; this.b = i && i.body; } async json() { return JSON.parse(this.b); } };
}
(async () => {
    const src = require('fs').readFileSync(path.join(__dirname, '../../cloudflare/fa-worker/worker.js'), 'utf8').replace('export default', 'module.exports =');
    const m = { exports: {} }; new Function('module', 'exports', src)(m, m.exports); const worker = m.exports;
    class FakeKV {
        constructor() { this.m = new Map(); this.writes = 0; this.lists = 0; }
        async get(k) { const e = this.m.get(k); if (!e) return null; if (e.exp && e.exp < Date.now()) { this.m.delete(k); return null; } return e.v; }
        async put(k, v, o) { this.writes++; this.m.set(k, { v, exp: o && o.expirationTtl ? Date.now() + o.expirationTtl * 1000 : 0 }); }
        async delete(k) { this.m.delete(k); }
        async list(o) { this.lists++; const keys = []; for (const [k, e] of this.m) if (k.startsWith(o.prefix) && (!e.exp || e.exp > Date.now())) keys.push({ name: k }); return { keys: keys.slice(0, o.limit || 1000) }; }
    }
    const kv = new FakeKV(), env = { KV: kv };
    const fakeFetch = (url, init) => worker.fetch(new Request(url, init), env);
    const mk = () => new KvTransport({ url: 'https://w.example', fetch: fakeFetch, activeMs: 60, idleMs: 200, rosterMs: 400, presMs: 100000, flushGapMs: 30 });

    // 房間登記（與 Supabase 的 rg_* 函式同樣的回傳）
    const t0 = mk(); const keys = await R.deriveKeys('correct horse battery 99', '12345678');
    check('登記：第一次建立成功', (await t0.rpc('rg_create_room', { p_code: '12345678', p_verifier: keys.verifier })) === true);
    check('登記：同代號再建立回 false', (await t0.rpc('rg_create_room', { p_code: '12345678', p_verifier: 'x' })) === false);
    check('登記：不存在的代號', (await t0.rpc('rg_join_room', { p_code: '87654321', p_verifier: 'x' })) === 'not_found');
    check('登記：正確的驗證值', (await t0.rpc('rg_join_room', { p_code: '12345678', p_verifier: keys.verifier })) === 'ok');
    check('登記：錯的驗證值', (await t0.rpc('rg_join_room', { p_code: '12345678', p_verifier: 'wrong' })) === 'bad_password');
    const w0 = kv.writes; await t0.rpc('rg_touch_room', { p_code: '12345678', p_verifier: 'wrong' }); check('touch：錯的驗證值不寫入', kv.writes === w0);
    for (let i = 0; i < 8; i++) await t0.rpc('rg_join_room', { p_code: '12345678', p_verifier: 'wrong' });
    check('登記：連續猜錯 8 次鎖住', (await t0.rpc('rg_join_room', { p_code: '12345678', p_verifier: keys.verifier })) === 'locked');
    const kv2 = new FakeKV(); const t00 = new KvTransport({ url: 'https://w', fetch: (u, i) => worker.fetch(new Request(u, i), { KV: kv2 }), touchMs: 100000 });
    await t00.rpc('rg_create_room', { p_code: '11112222', p_verifier: 'v' }); const wa = kv2.writes; await t00.rpc('rg_touch_room', { p_code: '11112222', p_verifier: 'v' }); await t00.rpc('rg_touch_room', { p_code: '11112222', p_verifier: 'v' });
    check('touch：6 小時內只寫一次', kv2.writes === wa + 1, kv2.writes - wa);
    const bad1 = await fakeFetch('https://w.example/send', { method: 'POST', body: JSON.stringify({ ch: 'bad', to: 'x', from: 'y', payloads: [{}] }) }); check('參數不對回 400', bad1.status === 400);
    const noKv = await worker.fetch(new Request('https://w/send', { method: 'POST', body: '{}' }), {}); check('沒有綁定 KV 回 500 並說明', noKv.status === 500 && /KV/.test((await noKv.json()).error));

    // 加密群組跑在 KV 傳輸上
    const A = new R.Room({ transport: mk(), keys, self: { name: 'A', kind: 'desktop', caps: [] }, maxMembers: 16, settleMs: 100 });
    const B = new R.Room({ transport: mk(), keys, self: { name: 'B', kind: 'web', caps: [] }, maxMembers: 16, settleMs: 100 });
    const gotA = [], gotB = []; A.on('message', (x) => gotA.push(x)); B.on('message', (x) => gotB.push(x));
    const ra = await A.join(); await sleep(150); const rb = await B.join(); await sleep(1500);
    check('A、B 都加入', ra.ok && rb.ok, [ra, rb]);
    check('名單：雙方看到 2 台', A.members().length === 2 && B.members().length === 2, [A.members().map((x) => x.name), B.members().map((x) => x.name)]);
    await A.send(B.self.nodeId, 'ping', { n: 1 }); await sleep(800); check('A→B 小訊息', gotB.length === 1 && gotB[0].type === 'ping' && gotB[0].body.n === 1 && gotB[0].from === A.self.nodeId, gotB);
    const big = 'y'.repeat(100000); await B.send(A.self.nodeId, 'blob', { big }); await sleep(1500); check('B→A 大訊息（10 萬字元，自動切塊）', gotA.length === 1 && gotA[0].body.big.length === 100000, gotA.length);
    await A.send('*', 'hello', { t: 1 }); await sleep(800); check('廣播', gotB.some((x) => x.type === 'hello'));
    const wb = kv.writes; await Promise.all([1, 2, 3, 4, 5].map((i) => A.send(B.self.nodeId, 'burst', { i }))); await sleep(1000);
    const bursts = gotB.filter((x) => x.type === 'burst').map((x) => x.body.i);
    check('連續 5 則：全部收到、順序不亂', bursts.join() === '1,2,3,4,5', bursts);
    check('連續 5 則合併寫入（寫入次數少於 5）', kv.writes - wb < 5, kv.writes - wb);
    // 別的群組（密碼不同）完全收不到
    const k2 = await R.deriveKeys('another password 123 abc', '12345678'); const C = new R.Room({ transport: mk(), keys: k2, self: { name: 'C', kind: 'web', caps: [] }, maxMembers: 16, settleMs: 100 });
    const gotC = []; C.on('message', (x) => gotC.push(x)); await C.join(); await sleep(500);
    await A.send('*', 'secret', { s: 1 }); await sleep(800); check('別的群組：看不到名單也收不到', C.members().length === 1 && gotC.length === 0, [C.members().length, gotC.length]);
    // 重連
    await B.reconnect(); await sleep(1200); await A.send(B.self.nodeId, 'after', { ok: 1 }); await sleep(900); check('重連後仍能收訊息', gotB.some((x) => x.type === 'after'));
    // 離開
    await B.leave(); await sleep(300); const r = await mk().call('/roster', { ch: keys.channel }); check('離開後名單移除', !r.out.some((x) => x.node === B.self.nodeId), r.out.map((x) => x.node));
    await A.leave(); await C.leave();
    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'rg_kv: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
