// node scripts/env-tests/swap.test.js -- 模擬 swap：熱區上限、最久沒用的先寫出、讀回、丟掉、讀不回來的錯誤
if (typeof Blob === 'undefined') global.Blob = require('buffer').Blob;
const S = require('../../renderer/src/env/swap.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const mkStore = () => { const m = new Map(); return { m, writes: 0, async put(id, b) { this.writes++; m.set(id, b); }, async get(id) { return m.get(id) || null; }, async del(id) { m.delete(id); }, async clear() { m.clear(); } }; };
const bytes = (n, c) => new Uint8Array(n).fill(c);
(async () => {
    let clock = 0; const store = mkStore(); const sw = S.create({ store, hotBytes: 250, now: () => ++clock });
    const a = await sw.put(bytes(100, 1)), b = await sw.put(bytes(100, 2)); check('熱區內不寫出', store.writes === 0 && sw.stats().hotBytes === 200);
    const c = await sw.put(bytes(100, 3)); check('超過熱區：最久沒用的（a）寫到儲存層', store.writes === 1 && store.m.has(a.id) && sw.stats().hotBytes === 200 && sw.stats().diskBytes === 100, sw.stats());
    const ga = await sw.get(a); check('讀回：內容一致', Buffer.from(await ga.arrayBuffer()).equals(Buffer.from(bytes(100, 1))));
    check('讀回後 a 變成最近用的、換 b 寫出', store.m.has(b.id) && sw.stats().hotBytes === 200, sw.stats());
    await sw.get(a); await sw.get(c); check('在記憶體的不會重複寫出', store.writes === 2, store.writes);
    const d = await sw.put(bytes(300, 4)); check('單一個比熱區還大：自己留著（剛放進去的不被踢），其他都寫出', sw.stats().items === 4 && (await sw.get(d)).size === 300);
    await sw.drop(a); check('drop：記憶體與儲存層都清掉', !store.m.has(a.id)); let e = null; try { await sw.get(a); } catch (x) { e = x.message; } check('drop 之後讀取有明確錯誤', /丟掉/.test(e || ''), e);
    store.m.delete(b.id); let e2 = null; try { await sw.get(b); } catch (x) { e2 = x.message; } check('儲存層被清掉：明確的錯誤', /讀不回來/.test(e2 || ''), e2);
    await sw.setHotBytes(0); check('setHotBytes(0)：全部寫出（跑完任務、壓力大時用）', sw.stats().hotBytes <= 300, sw.stats());
    await sw.clear(); check('clear', sw.stats().items === 0 && store.m.size === 0);
    const sw2 = S.create({ store: mkStore(), hotBytes: 10 }); const h = await sw2.put(Buffer.from('hello'), 'text/plain'); check('也接受 Buffer／ArrayBuffer，並記得型別', h.type === 'text/plain' && h.size === 5);
    console.log(bad.length ? 'FAILED:\n  ' + bad.join('\n  ') : 'swap: ' + ok + ' passed'); process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('EXCEPTION', e && e.stack || e); process.exit(1); });
