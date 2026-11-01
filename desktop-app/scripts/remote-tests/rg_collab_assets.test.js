// node scripts/remote-tests/rg_collab_assets.test.js -- 多人同編的素材：加入時取齊快照的圖、參與者新增的圖經主持機轉給大家、主持機自己新增的圖
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
const R = require('../../renderer/src/remote/rg_core.js'), F = require('../../renderer/src/remote/rg_files.js'), E = require('../../renderer/src/remote/rg_edit.js'), C = require('../../renderer/src/remote/rg_collab.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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


const store = () => { const m = new Map(); return { m, has: async (ns, id) => m.has(id), get: async (ns, id) => m.get(id) || null, put: async (ns, id, blob) => { m.set(id, blob); } }; };
const bytes = async (b) => Buffer.from(await b.arrayBuffer()).toString();
(async () => {
    const keys = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000); const hub = new Hub();
    const mkNode = async (name) => { const room = new R.Room({ transport: hub.transport(), keys, self: { name }, settleMs: 30 }); await room.join(); const st = store(); let peer = null;
        const files = new F.FileShare({ room, getFile: async (id) => peer.getOffered(id), allowed: (id, from) => peer.isAllowed(id, from), rtc: null });
        peer = new E.Peer({ room, files, kinds: () => null }); const kinds = (k) => (k === 'edit-x' ? { remote: { assets: st } } : null);
        const c = new C.Collab({ room, kinds, peer }); c.slow = 0.3; return { room, st, c }; };
    const H = await mkNode('主'), A = await mkNode('甲'), B = await mkNode('乙'); await sleep(250);
    H.st.m.set('img1', new Blob(['PNG-ONE'], { type: 'image/png' }));
    const doc0 = { objects: [{ id: 'o1', type: 'image', ref: 'img1' }] };
    const hs = H.c.share({ sid: 's', kind: 'edit-x', title: 't', spec: doc0 });
    const [it] = await A.c.list(300); const pa = await A.c.join(it.host, 's');
    check('加入前先取齊快照的素材', A.st.m.has('img1') && await bytes(A.st.m.get('img1')) === 'PNG-ONE');
    const pb = await B.c.join(it.host, 's'); check('第二個人也取到', B.st.m.has('img1'));
    // 參與者新增一張圖：主持機取回、再轉給另一人
    A.st.m.set('img2', new Blob(['PNG-TWO'], { type: 'image/png' }));
    const next = JSON.parse(JSON.stringify(pa.spec)); next.objects.push({ id: 'o2', type: 'image', ref: 'img2' });
    const r = await pa.propose(pa.replica.diffTo(next), { summary: '加圖' }); await sleep(600);
    check('提出成功', r.ok);
    check('主持機取回新圖', H.st.m.has('img2') && await bytes(H.st.m.get('img2')) === 'PNG-TWO');
    check('另一個參與者也拿到新圖', B.st.m.has('img2') && await bytes(B.st.m.get('img2')) === 'PNG-TWO');
    check('文件同步', pb.spec.objects.length === 2);
    // 主持機自己新增
    H.st.m.set('img3', new Blob(['PNG-3'], { type: 'image/png' })); let got = 0; pa.on('assets', (n) => { got += n; });
    const n2 = JSON.parse(JSON.stringify(hs.spec)); n2.objects.push({ id: 'o3', type: 'image', ref: 'img3' }); hs.propose(hs.replica.diffTo(n2), { summary: '主持機加圖' }); await sleep(700);
    check('主持機新增的圖大家拿得到，並通知畫面重畫', A.st.m.has('img3') && B.st.m.has('img3') && got >= 1, got);
    console.log('rg_collab_assets: ' + ok + ' passed, ' + bad.length + ' failed' + (bad.length ? '：\n  ' + bad.join('\n  ') : '')); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('例外', e); process.exit(1); });
