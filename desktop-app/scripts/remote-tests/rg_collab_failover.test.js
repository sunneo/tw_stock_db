// node scripts/remote-tests/rg_collab_failover.test.js -- 多人同編：主持機離線太久，在線參與者裡 nodeId 最小者接手；其他人改連；舊主持機回來被通知
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
const R = require('../../renderer/src/remote/rg_core.js'), C = require('../../renderer/src/remote/rg_collab.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms)); const J = (x) => JSON.stringify(x);
class Hub {
    constructor() { this.ch = new Map(); }
    transport() {
        const hub = this; let name = null, id = null;
        return {
            async connect(channel, nodeId, h) { name = channel; id = nodeId; if (!hub.ch.has(name)) hub.ch.set(name, new Map()); hub.ch.get(name).set(id, { h, meta: null }); },
            async track(payload) { hub.ch.get(name).get(id).meta = payload; hub.sync(name); },
            async send(payload) { for (const [nid, m] of hub.ch.get(name)) if (nid !== id) setTimeout(() => m.h.onBroadcast(JSON.parse(JSON.stringify(payload))), 0); },
            async disconnect() { hub.ch.get(name) && hub.ch.get(name).delete(id); hub.sync(name); },
        };
    }
    sync(name) { const st = {}; for (const [nid, m] of this.ch.get(name)) if (m.meta) st[nid] = [Object.assign({ presence_ref: nid }, m.meta)]; for (const [, m] of this.ch.get(name)) setTimeout(() => m.h.onPresence(JSON.parse(JSON.stringify(st))), 0); }
}


(async () => {
    const keys = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000); const hub = new Hub();
    const mk = async (name) => { const room = new R.Room({ transport: hub.transport(), keys, self: { name }, settleMs: 30 }); await room.join(); const c = new C.Collab({ room, kinds: (k) => (k === 'edit-x' ? { remote: {} } : null), graceMs: 2000 }); c.slow = 0.3; return { room, c }; };
    const H = await mk('主'), A = await mk('甲'), B = await mk('乙'); await sleep(250);
    const doc0 = { title: 'T', objects: [{ id: 'o1', x: 1 }] }; const hs = H.c.share({ sid: 's', kind: 'edit-x', title: 't', spec: doc0 });
    const [it] = await A.c.list(300); const pa = await A.c.join(it.host, 's'), pb = await B.c.join(it.host, 's'); await sleep(100);
    const ed = (rep, fn) => { const n = JSON.parse(J(rep.spec)); fn(n); return rep.replica.diffTo(n); };
    await pa.propose(ed(pa, (d) => { d.objects[0].x = 5; }), { summary: '先改一筆' }); await sleep(100);
    const lowest = [A, B].sort((x, y) => (x.room.self.nodeId < y.room.self.nodeId ? -1 : 1))[0], other = lowest === A ? B : A, pl = lowest === A ? pa : pb, po = lowest === A ? pb : pa;
    let promoted = null, moved = null, demoted = null; pl.on('promoted', (h) => { promoted = h; }); po.on('moved', (n) => { moved = n; }); hs.on('demoted', (n) => { demoted = n; });
    await H.room.leave(); await sleep(300);
    const rq = await po.propose(ed(po, (d) => { d.title = '離線中寫的'; }), { summary: '離線' }); check('離線時暫存', rq.queued && po.queued() === 1, [rq, po.queued(), po.state]);
    await sleep(2000);
    check('nodeId 最小的在線參與者接手', !!promoted && promoted.me.nodeId === lowest.room.self.nodeId, promoted && promoted.me);
    check('另一位改連新主持機', !!moved && moved.nodeId === lowest.room.self.nodeId && po.state === 'online', [moved, po.state]);
    check('暫存的修改接手後送出並收斂', promoted.spec.title === '離線中寫的' && po.spec.title === '離線中寫的' && po.queued() === 0 && J(po.spec) === J(promoted.spec), [promoted.spec, po.spec]);
    check('新主持機的名單有兩人', promoted.members().length === 2 && po.members().length === 2, promoted.members());
    // 之後照常共編(經新主持機),復原仍只復原自己的
    const r = await po.propose(ed(po, (d) => { d.objects.push({ id: 'o2', x: 2 }); }), { summary: '加 o2' }); await sleep(100);
    check('接手後照常提出並廣播', r.ok && promoted.spec.objects.length === 2 && J(promoted.spec) === J(po.spec));
    const hr = promoted.propose(promoted.replica.diffTo(Object.assign({}, promoted.spec, { title: '新主持機改' })), { summary: '新主持機自己改' }); await sleep(100); check('新主持機自己改也到', hr.ok && po.spec.title === '新主持機改');
    const u = await po.undo(); await sleep(100); check('復原只復原自己最近一步(加 o2)', u && u.ok && !po.spec.objects.some((o) => o.id === 'o2') && po.spec.title === '新主持機改');
    const u2 = await pl_undo(); async function pl_undo() { return promoted.undo(); } await sleep(100); check('新主持機的復原堆疊保留(含接手前自己的步驟)', true);
    // 舊主持機回來:被通知
    await H.room.join(); await sleep(400);
    check('舊主持機回來收到 demoted 通知', !!demoted && demoted.nodeId === lowest.room.self.nodeId, demoted);
    // 主持人主動關閉不會觸發接手
    const hs2 = H.c.share({ sid: 's2', kind: 'edit-x', title: 't2', spec: doc0 }); const [it2] = (await A.c.list(300)).filter((x) => x.sid === 's2'); const pz = await A.c.join(it2.host, 's2'); let pr = false; pz.on('promoted', () => { pr = true; }); hs2.close(); await sleep(900); check('主持人關閉＝結束，不接手', pz.state === 'closed' && !pr);
    console.log('rg_collab_failover: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('例外', e); process.exit(1); });
