// node scripts/remote-tests/rg_core.test.js -- 遠端群組核心：密碼規則、金鑰推導、加解密、群組（人數上限、名稱不重複、訊息切塊與重組）
const R = require('../../renderer/src/remote/rg_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 記憶體傳輸：模擬即時通道（廣播不送給自己、在線名單同步給同頻道的人）
class Hub {
    constructor() { this.ch = new Map(); }
    transport() {
        const hub = this; let name = null, id = null, h = null;
        return {
            async connect(channel, nodeId, handlers) { name = channel; id = nodeId; h = handlers; if (!hub.ch.has(name)) hub.ch.set(name, new Map()); hub.ch.get(name).set(id, { h, meta: null }); handlers.onStatus && handlers.onStatus('SUBSCRIBED'); },
            async track(payload) { hub.ch.get(name).get(id).meta = payload; hub.sync(name); },
            async send(payload) { for (const [nid, m] of hub.ch.get(name)) if (nid !== id) setTimeout(() => m.h.onBroadcast(JSON.parse(JSON.stringify(payload))), 0); },
            async disconnect() { if (name && hub.ch.get(name)) { hub.ch.get(name).delete(id); hub.sync(name); } },
        };
    }
    sync(name) { const st = {}; for (const [nid, m] of this.ch.get(name)) if (m.meta) st[nid] = [Object.assign({ presence_ref: nid }, m.meta)]; for (const [, m] of this.ch.get(name)) setTimeout(() => m.h.onPresence(JSON.parse(JSON.stringify(st))), 0); }
}

(async () => {
    // ---- 密碼規則
    check('空白密碼被擋', !R.passwordStrength('').ok);
    check('太短被擋', !R.passwordStrength('Ab1!xyz').ok);
    check('常見密碼被擋', !R.passwordStrength('password123456').ok && !R.passwordStrength('qwertyuiop1234').ok);
    check('全數字被擋', !R.passwordStrength('123456789012').ok);
    check('重複字元被擋', !R.passwordStrength('aaaaaaaaaaaaaaaa').ok);
    check('夠長又混合的通過', R.passwordStrength('Tr0ub4dor&3-xyzQ').ok);
    check('四個單字的密碼短語通過', R.passwordStrength('correct horse battery staple').ok);
    const gp = R.generatePassword(); check('產生的密碼：24 字元（20+4 個連字號）、通過規則、每次不同', gp.length === 24 && R.passwordStrength(gp).ok && gp !== R.generatePassword(), gp);

    // ---- 金鑰推導
    const IT = 2000;
    const k1 = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', IT), k2 = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', IT), k3 = await R.deriveKeys('Tr0ub4dor&3-xyzR', '12345678', IT), k4 = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '87654321', IT);
    check('同密碼同代號：頻道與驗證值一致', k1.channel === k2.channel && k1.verifier === k2.verifier && /^rg:[0-9a-f]{32}$/.test(k1.channel) && /^[0-9a-f]{64}$/.test(k1.verifier));
    check('不同密碼或不同代號：頻道與驗證值都不同', k1.channel !== k3.channel && k1.verifier !== k3.verifier && k1.channel !== k4.channel);

    // ---- 加解密
    const e1 = await R.encryptJson(k1, { a: 1, s: '你好' });
    check('加解密往返', JSON.stringify(await R.decryptJson(k2, e1)) === JSON.stringify({ a: 1, s: '你好' }));
    check('錯誤的密碼解不開', (await R.decryptJson(k3, e1)) === null);
    check('代號不同（綁定資料不同）解不開', (await R.decryptJson(k4, e1)) === null);
    check('被竄改解不開', (await R.decryptJson(k1, e1.slice(0, -4) + 'AAAA')) === null && (await R.decryptJson(k1, 'garbage')) === null);
    check('每次加密結果不同（隨機初始向量）', e1 !== (await R.encryptJson(k1, { a: 1, s: '你好' })));

    // ---- 群組
    const hub = new Hub();
    const mk = (keys, name, extra) => new R.Room(Object.assign({ transport: hub.transport(), keys, self: { name, kind: 'web', caps: ['sandbox'] }, settleMs: 40 }, extra || {}));
    const A = mk(k1, 'PC'), B = mk(k2, 'PC'), C = mk(k3, 'Other');
    const ra = await A.join(); check('A 加入（第一個）', ra.ok && A.members().length === 1);
    await sleep(20); const rb = await B.join(); await sleep(200);
    check('B 加入；名稱重複自動加編號', rb.ok && rb.name === 'PC-2', rb);
    check('雙方都看到 2 台，名稱與能力一致', A.members().length === 2 && B.members().length === 2 && A.members().map((m) => m.name).sort().join() === 'PC,PC-2' && A.members()[0].caps[0] === 'sandbox', A.members());
    const rc = await C.join(); check('密碼錯誤的人進到別的頻道：只看得到自己、看不到 A 與 B', rc.ok && C.members().length === 1 && A.members().length === 2);

    // 訊息
    const gotB = [], gotA = [], gotC = [];
    B.on('message', (m) => gotB.push(m)); A.on('message', (m) => gotA.push(m)); C.on('message', (m) => gotC.push(m));
    await A.send(B.self.nodeId, 'ping', { n: 1 }); await sleep(150);
    check('A→B 小訊息', gotB.length === 1 && gotB[0].type === 'ping' && gotB[0].body.n === 1 && gotB[0].from === A.self.nodeId, gotB);
    const big = 'x'.repeat(100000); await A.send(B.self.nodeId, 'blob', { big }); await sleep(200);
    check('大訊息（10 萬字元）自動切塊並重組', gotB.length === 2 && gotB[1].body.big.length === 100000);
    await B.send('*', 'hello', { t: 1 }); await sleep(150);
    check('廣播（*）：A 收到', gotA.length === 1 && gotA[0].type === 'hello');
    check('別的群組（密碼不同）完全收不到', gotC.length === 0);
    await A.send('不存在的節點', 'ping', {}); await sleep(150); check('送給不存在的節點：沒有人收到', gotB.length === 2);

    // 離開
    await B.leave(); await sleep(200); check('B 離開後 A 的名單剩 1 台', A.members().length === 1);

    // 人數上限（上限 2）
    const hub2 = new Hub(); let tick = Date.now(); const mk2 = (name) => new R.Room({ transport: hub2.transport(), keys: k1, self: { name, since: ++tick }, maxMembers: 2, settleMs: 40 });
    const r1 = mk2('a'), r2 = mk2('b'), r3 = mk2('c');
    await r1.join(); await sleep(20); await r2.join(); await sleep(20); const x3 = await r3.join();
    check('人數上限：第三台被拒絕（full）', !x3.ok && x3.reason === 'full', x3);
    await sleep(200); check('被拒絕後沒有留在名單裡', r1.members().length === 2);

    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'rg_core: ' + ok + ' passed');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
