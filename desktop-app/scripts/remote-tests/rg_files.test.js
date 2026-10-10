// node scripts/remote-tests/rg_files.test.js -- 遠端群組的內容傳輸（轉送備援路徑、雜湊核對、權限、取消、大檔案限制）。直連（WebRTC）路徑在瀏覽器裡測。
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
const R = require('../../renderer/src/remote/rg_core.js');
const F = require('../../renderer/src/remote/rg_files.js');
const nodeCrypto = require('crypto');
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

(async () => {
    const keys = await R.deriveKeys('Tr0ub4dor&3-xyzQ', '12345678', 2000); const hub = new Hub();
    const mk = (name) => new R.Room({ transport: hub.transport(), keys, self: { name }, settleMs: 30 });
    const A = mk('提供者'), B = mk('要求者'); await A.join(); await B.join(); await sleep(150);
    const data = nodeCrypto.randomBytes(100 * 1000); const files = { f1: { blob: new Blob([data], { type: 'application/octet-stream' }), name: 'data.bin', mime: 'application/octet-stream' } };
    const announced = new Set(['f1']);
    const prov = new F.FileShare({ room: A, getFile: async (id) => files[id] || null, allowed: (id, from) => announced.has(id) && from === B.self.nodeId, rtc: null });
    const req = new F.FileShare({ room: B, getFile: async () => null, allowed: () => false, rtc: null });

    // 轉送：100 KB（5 塊）
    const prog = []; const r = await req.fetch(A.self.nodeId, 'f1', { onProgress: (d, t, via) => prog.push([d, t, via]) });
    const got = Buffer.from(await r.blob.arrayBuffer());
    check('轉送備援：內容一致、名稱與雜湊對', got.equals(data) && r.meta.name === 'data.bin' && r.meta.sha === await F.sha256(files.f1.blob) && r.via === '轉送', [got.length, r.via]);
    check('進度回報到完成', prog.length > 0 && prog[prog.length - 1][0] === 100000 && prog[prog.length - 1][2] === '轉送');

    // 沒有宣告 / 不存在
    let e1 = null; try { await req.fetch(A.self.nodeId, 'f2'); } catch (e) { e1 = e.message; } check('沒有宣告的檔案被拒絕', /沒有這個檔案|沒有宣告/.test(e1 || ''), e1);
    files.f2 = { blob: new Blob(['x']), name: 'x', mime: 'text/plain' }; let e2 = null; try { await req.fetch(A.self.nodeId, 'f2'); } catch (e) { e2 = e.message; } check('存在但沒宣告給你的檔案被拒絕', /沒有宣告|沒有這個檔案/.test(e2 || ''), e2);
    announced.add('f2'); delete files.f2; let e3 = null; try { await req.fetch(A.self.nodeId, 'f2'); } catch (e) { e3 = e.message; } check('宣告了但檔案已不在', /已經不在/.test(e3 || ''), e3);

    // 雜湊核對：提供者在傳輸途中檔案內容被換掉（meta 的雜湊是舊的）→ 收到後核對失敗
    files.f3 = { blob: new Blob([nodeCrypto.randomBytes(60000)]), name: 'swap.bin', mime: '' }; announced.add('f3');
    const origGet = prov.getFile; let calls = 0; prov.getFile = async (id) => { if (id === 'f3' && ++calls > 1) return { blob: new Blob([nodeCrypto.randomBytes(60000)]), name: 'swap.bin', mime: '' }; return origGet(id); };
    let e4 = null; try { await req.fetch(A.self.nodeId, 'f3'); } catch (e) { e4 = e.message; } check('內容在傳輸中被換掉：雜湊不符被丟棄', /雜湊不符/.test(e4 || ''), e4);
    prov.getFile = origGet;

    // 取消
    files.f4 = { blob: new Blob([nodeCrypto.randomBytes(200 * 1000)]), name: 'big.bin', mime: '' }; announced.add('f4'); const cancel = { cancelled: false };
    const pCancel = req.fetch(A.self.nodeId, 'f4', { cancel, onProgress: () => { cancel.cancelled = true; } }); let e5 = null; try { await pCancel; } catch (e) { e5 = e.message; } check('取消', /取消/.test(e5 || ''), e5);

    // 超過轉送上限且沒有直連
    files.f5 = { blob: { size: F.RELAY_MAX + 1, type: '', arrayBuffer: async () => new ArrayBuffer(8), slice() { return this; } }, name: 'huge.bin', mime: '' }; announced.add('f5');
    prov.shaCache.set('f5', 'x'.repeat(64)); let e6 = null; try { await req.fetch(A.self.nodeId, 'f5'); } catch (e) { e6 = e.message; } check('超過轉送上限：明確說明原因', /超過 16 MB/.test(e6 || ''), e6);

    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'rg_files: ' + ok + ' passed');
    process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
