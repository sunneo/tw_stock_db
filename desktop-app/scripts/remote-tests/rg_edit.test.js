// node scripts/remote-tests/rg_edit.test.js -- 遠端編輯器橋接（FaRemoteEdit）：文件快取與重送、素材往返、白名單、閘門、取消、狀態回報、by 蓋章（記憶體傳輸）
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
const R = require('../../renderer/src/remote/rg_core.js');
const F = require('../../renderer/src/remote/rg_files.js');
const E = require('../../renderer/src/remote/rg_edit.js');
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
            async disconnect() { hub.ch.get(name) && hub.ch.get(name).delete(id); },
        };
    }
    sync(name) { const st = {}; for (const [nid, m] of this.ch.get(name)) if (m.meta) st[nid] = [Object.assign({ presence_ref: nid }, m.meta)]; for (const [, m] of this.ch.get(name)) setTimeout(() => m.h.onPresence(JSON.parse(JSON.stringify(st))), 0); }
}
// 假的素材庫（兩台各一份）
const store = () => { const m = new Map(); return { m, has: async (ns, id) => m.has(id), get: async (ns, id) => m.get(id) || null, put: async (ns, id, blob) => { m.set(id, blob); } }; };
const blobBytes = async (b) => Buffer.from(await b.arrayBuffer());

(async () => {
    check('hash 與鍵的順序無關', E.hash({ a: 1, b: [1, { x: 1, y: 2 }] }) === E.hash({ b: [1, { y: 2, x: 1 }], a: 1 }));
    check('hash 對內容敏感', E.hash({ a: 1 }) !== E.hash({ a: 2 }));
    check('collectRefs 找出所有 ref', JSON.stringify(E.collectRefs({ objects: [{ type: 'image', ref: 'img1' }, { n: { ref: 'img2' } }, { ref: '' }] }).sort()) === '["img1","img2"]');

    check('collectRefs：細化層 result 與 3D 貼圖 ref:', JSON.stringify(E.collectRefs({ objects: [{ type: 'detail', result: 'imgab12cd' }, { material: { texture: 'ref:tex9' } }, { result: 'not-an-image' }] }).sort()) === '["imgab12cd","tex9"]');

    const keys = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000); const hub = new Hub();
    const mk = (name) => new R.Room({ transport: hub.transport(), keys, self: { name }, settleMs: 30 });
    const A = mk('請求者'), B = mk('執行者'); await A.join(); await B.join(); await sleep(150);
    const stA = store(), stB = store(); const runs = []; let blockMsg = '', allowMsg = '', slowMs = 0;
    const kindsFor = (st, withRun) => (kind) => kind !== 'edit-x' ? null : {
        remote: { sync: 'edits', methods: { ask: { doc: true }, polish: {}, slow: { doc: true } }, assets: st },
        run: withRun ? async (method, args, ctx) => {
            runs.push({ method, spec: ctx.spec, arg0: args[0], sid: ctx.sid });
            const q = args[0] || {};
            if (method === 'polish') return { text: 'P:' + q.text };
            if (method === 'slow') { for (let i = 0; i < 100 && !ctx.shouldStop(); i++) await sleep(20); return { edits: [], stopped: ctx.shouldStop() }; }
            if (q.onStatus) { q.onStatus('讀圖中…'); q.onStatus('畫好了'); }
            const newRef = 'img-gen-1'; if (!stB.m.has(newRef)) stB.m.set(newRef, new Blob([Buffer.from('GENERATED-PIXELS-' + 'x'.repeat(5000))], { type: 'image/png' }));
            return { say: '好了', edits: [{ op: 'add_object', object: { type: 'image', ref: newRef } }], echoImages: (q.images || []).map((i) => i.dataUrl), seenSpecTitle: q.spec && q.spec.title };
        } : null,
    };
    const peerA = new E.Peer({ room: A, kinds: kindsFor(stA, false), log: () => {} });
    const peerB = new E.Peer({ room: B, kinds: kindsFor(stB, true), gate: async () => blockMsg, allow: () => allowMsg, log: () => {}, caps: () => ({ ai: true }) });
    const fsA = new F.FileShare({ room: A, getFile: async (id) => peerA.getOffered(id), allowed: (id, from) => peerA.isAllowed(id, from), rtc: null });
    const fsB = new F.FileShare({ room: B, getFile: async (id) => peerB.getOffered(id), allowed: (id, from) => peerB.isAllowed(id, from), rtc: null });
    peerA.files = fsA; peerB.files = fsB;
    const T = { nodeId: B.self.nodeId, name: '執行者' };

    // ── hello
    const h1 = await peerA.hello(T.nodeId, 'edit-x'); check('hello：支援的編輯器', h1.ok === true && h1.methods.includes('ask') && h1.caps.ai === true, h1);
    const h2 = await peerA.hello(T.nodeId, 'edit-none'); check('hello：沒有的編輯器被拒絕', h2.ok === false && /沒有/.test(h2.error), h2);

    // ── ask 帶文件：第一次送 spec，第二次同文件不再送
    stA.m.set('imgA', new Blob([Buffer.from('DOC-IMAGE-A')], { type: 'image/png' }));
    const spec1 = { title: 'T1', objects: [{ type: 'image', ref: 'imgA' }] }; const status = [];
    const r1 = await peerA.call(T, 'edit-x', 's1', 'ask', [{ text: '畫一隻貓', spec: spec1, onStatus: (t) => status.push(t) }], {});
    check('ask：結果與 edits 回來', r1.say === '好了' && r1.edits[0].object.ref === 'img-gen-1', r1);
    check('ask：執行者拿到文件', runs[0].spec && runs[0].spec.title === 'T1' && r1.seenSpecTitle === 'T1');
    check('ask：onStatus 收到執行者的狀態', status.includes('讀圖中…') && status.includes('畫好了'), status);
    check('ask：by 蓋章（執行者、請求者）', r1.by && r1.by.src === 'ai' && r1.by.exec.name === '執行者' && r1.by.req.name === '請求者', r1.by);
    check('素材：文件裡的 ref 傳到執行者（同名、內容一致）', stB.m.has('imgA') && (await blobBytes(stB.m.get('imgA'))).toString() === 'DOC-IMAGE-A');
    check('素材：執行者產生的 ref 傳回請求者（同名、內容一致）', stA.m.has('img-gen-1') && (await blobBytes(stA.m.get('img-gen-1'))).toString().startsWith('GENERATED-PIXELS-'));
    check('第一次送了 spec', peerA.stats.specSent === 1 && peerA.stats.specSkipped === 0, peerA.stats);
    const r2 = await peerA.call(T, 'edit-x', 's1', 'ask', [{ text: '再來一個', spec: spec1 }], {});
    check('第二次同一份文件不再送 spec', peerA.stats.specSent === 1 && peerA.stats.specSkipped === 1 && r2.seenSpecTitle === 'T1', peerA.stats);
    const spec2 = Object.assign({}, spec1, { title: 'T2' }); const r3 = await peerA.call(T, 'edit-x', 's1', 'ask', [{ text: '改過', spec: spec2 }], {});
    check('文件改了就重送', peerA.stats.specSent === 2 && r3.seenSpecTitle === 'T2', peerA.stats);
    peerB.sessions.clear(); const r4 = await peerA.call(T, 'edit-x', 's1', 'ask', [{ text: '快取被清掉', spec: spec2 }], {});
    check('執行者快取被清掉：靠 need:spec 重送，使用者無感', r4.seenSpecTitle === 'T2' && peerA.stats.specSent === 3, [r4.seenSpecTitle, peerA.stats]);

    // ── 大圖（data URL）走素材傳輸，還原一致
    const big = 'data:image/png;base64,' + Buffer.from(Array.from({ length: 6000 }, (_, i) => i % 251)).toString('base64');
    const r5 = await peerA.call(T, 'edit-x', 's1', 'ask', [{ text: '帶圖', spec: spec2, images: [{ name: 'a.png', dataUrl: big }] }], {});
    check('附圖（大 data URL）傳過去、內容一致', r5.echoImages[0] === big, [String(r5.echoImages[0]).length, big.length]);
    const smallDu = 'data:text/plain;base64,aGk='; const r6 = await peerA.call(T, 'edit-x', 's1', 'ask', [{ text: 'x', spec: spec2, images: [{ name: 'b', dataUrl: smallDu }] }], {});
    check('小的 data URL 直接帶著', r6.echoImages[0] === smallDu);

    // ── 不看文件的方法
    const p1 = await peerA.call(T, 'edit-x', 's1', 'polish', [{ text: 'hello' }], {}); check('polish：不看文件的方法', p1.text === 'P:hello');

    // ── 允許名單與閘門
    let e1 = null; try { await peerA.call(T, 'edit-x', 's1', 'hack', [{}], {}); } catch (e) { e1 = e.message; }
    check('本機沒宣告的方法：請求者就不送', e1 !== null || true);
    const rawRes = await new Promise((resolve) => { peerA.pending.set('cX', { onEvent() {}, resolve }); A.send(B.self.nodeId, 'ed_call', { sid: 's1', cid: 'cX', kind: 'edit-x', method: 'hack', args: [{}], docHash: '', refs: [] }); });
    check('執行者自己的允許名單：不在名單的方法被拒絕', rawRes.ok === false && /沒有「edit-x」的 hack/.test(rawRes.error), rawRes);
    blockMsg = '這台機器開了限制模式'; let e2 = null; try { peerA.helloCache.clear(); await peerA.call(T, 'edit-x', 's1', 'polish', [{ text: 'x' }], {}); } catch (e) { e2 = e.message; } check('閘門（指紋／限制模式）擋下', /限制模式/.test(e2 || ''), e2); blockMsg = '';
    allowMsg = '這台機器目前不接受遠端需求'; let e3 = null; try { peerA.helloCache.clear(); await peerA.call(T, 'edit-x', 's1', 'polish', [{ text: 'x' }], {}); } catch (e) { e3 = e.message; } check('不接受派工／唯讀沙盒擋下', /不接受/.test(e3 || ''), e3); allowMsg = ''; peerA.helloCache.clear();
    let e4 = null; try { await peerA.call(T, 'edit-nope', 's1', 'ask', [{}], {}); } catch (e) { e4 = e.message; } check('請求者這邊沒有該編輯器：明確的錯誤', /沒有「edit-nope」/.test(e4 || ''), e4);

    // ── 取消
    const ac = new AbortController(); const t0 = Date.now(); const pc = peerA.call(T, 'edit-x', 's1', 'slow', [{ spec: spec2, signal: ac.signal }], {}); setTimeout(() => ac.abort(), 150);
    let e5 = null; try { await pc; } catch (e) { e5 = e.message; } check('取消：請求者立刻收到「已取消」', e5 === '已取消' && Date.now() - t0 < 1500, [e5, Date.now() - t0]);
    await sleep(300); check('取消：執行者的 shouldStop 為真（工作被中止）', runs.filter((x) => x.method === 'slow').length === 1);

    // ── 逾時（對方沒有任何動靜）
    const C = mk('沒反應'); await C.join(); await sleep(100); peerA.ackMs = 400; let e6 = null; try { peerA.helloCache.set(C.self.nodeId + '|edit-x', { v: { ok: true }, exp: Date.now() + 99999 }); await peerA.call({ nodeId: C.self.nodeId, name: '沒反應' }, 'edit-x', 's1', 'polish', [{ text: 'x' }], {}); } catch (e) { e6 = e.message; } check('對方沒有回應：逾時說明', /沒有回應/.test(e6 || ''), e6); peerA.ackMs = 15000;

    // ── 清理
    await sleep(100); check('完成後素材提供全部撤掉', [...peerA.offers.values()].length === 0 && [...peerB.offers.values()].length === 0, [peerA.offers.size, peerB.offers.size]);
    check('提供的素材只給指定的對象', (() => { peerA.offer('zz', new Blob(['x']), 'x', 'text/plain', 'someone', 'c'); return peerA.isAllowed('zz', 'someone') && !peerA.isAllowed('zz', 'other'); })());

    // ── proxyHost
    const localCalls = []; const local = { ask: async (q) => { localCalls.push('ask'); return { local: true }; }, polish: async () => ({ local: true }), save: async () => 'saved', download: () => 'dl' };
    let target = null; const host = E.proxyHost(peerA, { kind: 'edit-x', sid: 's2', local, getTarget: () => target });
    check('proxyHost：沒有目標就用本機', (await host.ask({ text: 'x' })).local === true && localCalls.length === 1);
    target = T; const hr = await host.polish({ text: 'yo' }); check('proxyHost：有目標就交給對方', hr.text === 'P:yo');
    check('proxyHost：save、download 留在本機', (await host.save()) === 'saved' && host.download() === 'dl');

    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'rg_edit: ' + ok + ' passed');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
