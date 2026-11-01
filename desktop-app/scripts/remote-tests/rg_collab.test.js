// node scripts/remote-tests/rg_collab.test.js -- 多人同編訊息層（記憶體傳輸）：列表、加入、提出與廣播、by 蓋章、唯讀、各人復原、presence、漏補、主持機離線暫存與回來
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
const R = require('../../renderer/src/remote/rg_core.js');
const C = require('../../renderer/src/remote/rg_collab.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const J = (x) => JSON.stringify(x);
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
    const mk = (name, kind) => new R.Room({ transport: hub.transport(), keys, self: { name, kind }, settleMs: 30 });
    const rooms = { h: mk('小明', 'desktop'), a: mk('阿華', 'web'), b: mk('小美', 'desktop') };
    for (const k in rooms) await rooms[k].join(); await sleep(200);
    const kinds = (k) => (k === 'edit-x' ? { remote: {} } : null); let blocked = '';
    const cs = {}; for (const k in rooms) { cs[k] = new C.Collab({ room: rooms[k], kinds, gate: async () => (k === 'h' ? blocked : ''), allow: () => '' }); cs[k].slow = 0.2; }
    const doc0 = { title: 'T', objects: [{ id: 'o1', x: 1 }, { id: 'o2', x: 2 }] };
    const hs = cs.h.share({ sid: 's1', kind: 'edit-x', title: '共編測試', spec: doc0 });
    // 列表
    let items = await cs.a.list(300); check('列出別台開著的編輯器', items.length === 1 && items[0].sid === 's1' && items[0].host.name === '小明' && items[0].title === '共編測試', items);
    check('自己的不在自己的列表', (await cs.h.list(300)).length === 0);
    blocked = '指紋不符'; check('閘門擋下時不出現在列表', (await cs.a.list(300)).length === 0); blocked = '';
    // 加入
    blocked = '指紋不符'; let err = ''; try { await cs.a.join(items[0].host, 's1'); } catch (e) { err = e.message; } check('閘門擋下加入並說明原因', /指紋不符/.test(err), err); blocked = '';
    const pa = await cs.a.join(items[0].host, 's1'), pb = await cs.b.join(items[0].host, 's1'); await sleep(100);
    check('加入拿到完整副本', J(pa.spec) === J(doc0) && pa.rev === 0 && pa.kind === 'edit-x');
    check('在線名單三人（含主持機與網頁標記）', pa.members().length === 3 && pa.members().find((m) => m.name === '阿華' || m.nodeId === rooms.a.self.nodeId) && hs.members().length === 3, pa.members());
    // 參與者提出 → 全部收斂,by 由主持機蓋章
    const seen = { h: [], b: [] }; hs.on('commit', (c) => seen.h.push(c)); pb.on('commit', (c) => seen.b.push(c));
    const edit = (rep, fn) => { const n = JSON.parse(J(rep.spec)); fn(n); return rep.replica.diffTo(n); };
    let r = await pa.propose(edit(pa, (d) => { d.objects[0].x = 10; }), { summary: '移動', src: 'user' }); await sleep(80);
    check('提出成功且已套在自己的副本', r.ok && r.rev === 1 && pa.spec.objects[0].x === 10 && pa.rev === 1, r);
    check('主持機與別的參與者都收斂', hs.spec.objects[0].x === 10 && pb.spec.objects[0].x === 10 && seen.h.length === 1 && seen.b.length === 1);
    check('by 是主持機蓋的（名字來自通道，不是自稱）', seen.b[0].by.name === '阿華' && seen.b[0].by.kind === 'web' && seen.b[0].by.nodeId === rooms.a.self.nodeId, seen.b[0].by);
    // 主持機自己改
    hs.propose(hs.replica.diffTo(Object.assign({}, hs.spec, { title: 'T2' })), { summary: '標題' }); await sleep(80);
    check('主持機自己改也廣播', pa.spec.title === 'T2' && pb.spec.title === 'T2' && pb.rev === 2);
    // AI 資訊(exec／req)
    r = await pb.propose(edit(pb, (d) => { d.objects.push({ id: 'o3', x: 3 }); }), { summary: 'AI 加', src: 'ai', exec: { nodeId: rooms.h.self.nodeId, name: '小明' }, req: { nodeId: rooms.b.self.nodeId, name: '小美' } }); await sleep(80);
    check('AI 的 by 帶執行者與請求者', seen.b[seen.b.length - 1].by.src === 'ai' && seen.b[seen.b.length - 1].by.exec.name === '小明' && seen.b[seen.b.length - 1].by.req.name === '小美');
    // 衝突：對象被刪 → 回報給提出者
    hs.propose(hs.replica.diffTo({ title: 'T2', objects: hs.spec.objects.filter((o) => o.id !== 'o2') }), { summary: '刪 o2' }); await sleep(80);
    const stale = [{ op: 'set', at: ['objects', { k: 'id', v: 'o2' }, 'x'], value: 99 }];
    r = await pa.propose(stale, { summary: '改 o2' }); check('改到被刪的對象：回報略過、不編號', !r.ok && r.error === 'all-rejected' && r.rejected.length === 1 && hs.rev === 4, r);
    // 唯讀
    hs.setReadonly(rooms.a.self.nodeId, true); await sleep(80); check('在線名單反映唯讀', pa.members().find((m) => m.nodeId === rooms.a.self.nodeId).readonly === true);
    r = await pa.propose(edit(pa, (d) => { d.title = 'x'; }), {}); check('唯讀者被拒', !r.ok && r.error === 'readonly'); hs.setReadonly(rooms.a.self.nodeId, false); await sleep(50);
    // 各人復原(經網路)
    const t0 = hs.spec.title; r = await pa.undo(); await sleep(80); check('A 復原自己最近一步（x 回 1），別人的改動留著', r && r.ok && pa.spec.objects.find((o) => o.id === 'o1').x === 1 && hs.spec.title === 'T2' && hs.spec.objects.some((o) => o.id === 'o3') && J(pb.spec) === J(hs.spec), hs.spec);
    r = await pa.redo(); await sleep(80); check('A 重做', r && r.ok && pa.spec.objects.find((o) => o.id === 'o1').x === 10);
    r = await pb.undo(); await sleep(80); check('B 復原自己的（o3 被移掉）', r.ok && !hs.spec.objects.some((o) => o.id === 'o3') && pa.spec.objects.find((o) => o.id === 'o1').x === 10);
    r = hs.undo(); await sleep(80); check('主持機也有自己的復原堆疊', r && r.ok && J(pa.spec) === J(hs.spec));
    // presence
    const pres = []; pb.on('presence', (p) => pres.push(p)); pa.presence({ id: 'o1' }); await sleep(100); check('presence 經主持機轉給別人，帶名字', pres.length === 1 && pres[0].by.name === '阿華' && pres[0].sel.id === 'o1', pres);
    // 漏掉 commit：丟掉 b 收到的一筆 → 下一筆來時偵測 gap 並補齊
    const origEmit = pb._onMsg.bind(pb); let dropped = false; pb._onMsg = (t, b) => { if (t === 'ed_commit' && !dropped) { dropped = true; return; } origEmit(t, b); };
    hs.propose(hs.replica.diffTo(Object.assign({}, hs.spec, { title: 'G1' })), {}); await sleep(60); hs.propose(hs.replica.diffTo(Object.assign({}, hs.spec, { title: 'G2' })), {}); await sleep(300);
    check('漏了一筆之後自動補齊', dropped && pb.spec.title === 'G2' && pb.rev === hs.rev, [pb.rev, hs.rev]); pb._onMsg = origEmit;
    // 離線暫存與回來
    const states = []; pa.on('status', (s) => states.push(s)); await rooms.h.leave(); await sleep(250);
    check('主持機離線被偵測', pa.state === 'offline' && states.includes('offline'), states);
    r = await pa.propose(edit(pa, (d) => { d.title = '離線改'; }), { summary: '離線' }); check('離線時暫存', r.queued && pa.queued() === 1);
    const flushed = []; pa.on('flushed', (x) => flushed.push(x)); await rooms.h.join(); await sleep(500);
    check('回來後自動送出暫存', pa.state === 'online' && hs.spec.title === '離線改' && pa.queued() === 0 && flushed.length === 1 && flushed[0].ok, [pa.state, hs.spec.title, flushed]);
    // 離開與關閉
    pb.leave(); await sleep(100); check('離開後名單少一人', hs.members().length === 2);
    let closed = ''; pa.on('closed', (x) => { closed = x; }); hs.close(); await sleep(100); check('主持人關閉通知參與者', pa.state === 'closed' && /關閉/.test(closed));
    r = await pa.propose([{ op: 'set', at: ['title'], value: 'z' }], {}); check('結束後不能再提出', !r.ok);
    console.log('rg_collab: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('例外', e); process.exit(1); });
