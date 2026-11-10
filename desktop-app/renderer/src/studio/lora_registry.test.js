// node renderer/src/studio/lora_registry.test.js
const R = require('./lora_registry_core.js'); const A = require('./asset_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 400) : '')); } };
const H = (c) => c.repeat(64);
const ENV = { base: 'Qwen/Qwen3-0.6B', rank_slots: [16], prompt_format_version: 3, tool_catalog_sha256: H('a') };
const MB = 1024 * 1024;
const good = { score: 1, groups: { tools: { adapter: 53, base: 6 }, ext: { adapter: 9, base: 7 } } };
const mk = (id, o) => Object.assign({ id, source: 'builtin', base: ENV.base, rank: 16, prompt_format_version: 3, tool_catalog_sha256: H('a'), domains: ['tool_routing'], location: 'fap:x/' + id, size: 40 * MB, sha256: H('b'), eval: good, added: 1 }, o || {});
function mkLoader() { const log = []; return { log, load: async (e) => { log.push('load ' + e.id); return { id: e.id }; }, unload: async (e) => { log.push('unload ' + e.id); } }; }
let t = 1000; const now = () => ++t;

(async () => {
    // 相容性
    const c0 = R.checkCompat(mk('a'), ENV); check('compat ok', c0.ok && c0.level === 'ok', c0);
    const c1 = R.checkCompat(mk('a', { base: 'Qwen/Qwen3-1.7B' }), ENV); check('base 不同 reject 帶原因', !c1.ok && c1.reasons[0].field === 'base' && /基底模型不同/.test(c1.reasons[0].message), c1);
    const c2 = R.checkCompat(mk('a', { rank: 32 }), ENV); check('rank 不在槽 reject', !c2.ok && c2.reasons[0].field === 'rank');
    const c3 = R.checkCompat(mk('a', { prompt_format_version: 2 }), ENV); check('提示格式不同 reject', !c3.ok && c3.reasons[0].field === 'prompt_format_version');
    const c4 = R.checkCompat(mk('a', { tool_catalog_sha256: H('c') }), ENV); check('工具清單變動只警告', c4.ok && c4.level === 'warn' && c4.warnings.length === 1, c4);
    const c5 = R.checkCompat(mk('a', { base_sha256: H('d') }), Object.assign({ base_sha256: H('e') }, ENV)); check('基底雜湊不同 reject', !c5.ok && c5.reasons[0].field === 'base_sha256');
    const c6 = R.checkCompat(mk('a', { base: 'x', rank: 8 }), ENV); check('多項不符全部列出', c6.reasons.length === 2);
    check('validateEntry 缺欄位', R.validateEntry({ id: 'x' }).length >= 5);
    let threw = false; try { R.createRegistry({ env: ENV }).register({ id: 'x' }); } catch (e) { threw = /不合法/.test(e.message); } check('register 拒絕不合法', threw);

    // 選用：領域、不相容、停用、無評量、輸給基底
    {
        const L = mkLoader(); const r = R.createRegistry({ env: ENV, loader: L, budgetBytes: 100 * MB, maxActive: 2, now });
        r.register(mk('ok1', { domains: ['tool_routing'] }));
        r.register(mk('uml1', { domains: ['uml_design'] }));
        r.register(mk('badbase', { domains: ['tool_routing'], base: 'other' }));
        r.register(mk('off', { domains: ['colu'], enabled: false }));
        r.register(mk('noeval', { domains: ['colu'], eval: null }));
        r.register(mk('lose', { domains: ['colu'], eval: { groups: { a: { adapter: 1, base: 5 } } } }));
        const s = r.select({ domain: 'tool_routing' });
        check('只選對領域且相容', s.plan.length === 1 && s.plan[0].id === 'ok1', s.plan.map((e) => e.id));
        const s2 = r.select({ domain: 'colu' });
        check('停用／無評量／輸基底都不選', s2.plan.length === 0 && s2.skipped.some((x) => x.id === 'off' && /停用/.test(x.reason)) && s2.skipped.some((x) => x.id === 'noeval' && /沒有評量/.test(x.reason)) && s2.skipped.some((x) => x.id === 'lose' && /輸給基底/.test(x.reason)), s2.skipped);
        check('不相容寫在 skipped', r.select({ domain: 'tool_routing' }).skipped.some((x) => x.id === 'badbase' && /不相容/.test(x.reason)));
        const s3 = r.select({ ids: ['noeval'] }); check('手動指定可繞過無評量', s3.plan.length === 1 && s3.plan[0].id === 'noeval');
        const s4 = r.select({ ids: ['badbase'] }); check('手動指定也不能繞過不相容', s4.plan.length === 0);
        const s5 = r.select({ domains: ['tool_routing', 'uml_design'] }); check('多領域一次選多個', s5.plan.map((e) => e.id).sort().join() === 'ok1,uml1');
        const s6 = r.select({ domain: 'nothing' }); check('無符合不選', s6.plan.length === 0);
        await r.setEnabled('ok1', false); check('停用後不再選', r.select({ domain: 'tool_routing' }).plan.length === 0);
    }
    // 同領域多個：來源優先、priority、評量、較新；conflicts_with；通用讓位
    {
        const r = R.createRegistry({ env: ENV, loader: mkLoader(), budgetBytes: 500 * MB, maxActive: 3, now });
        r.register(mk('b1', { source: 'builtin', priority: 9 }));
        r.register(mk('i1', { source: 'imported', priority: 0 }));
        r.register(mk('u1', { source: 'user', priority: 0 }));
        check('同領域：使用者資產勝過內建（即使內建 priority 高）', r.select({ domain: 'tool_routing' }).plan[0].id === 'u1');
        const sk = r.select({ domain: 'tool_routing' }).skipped; check('同領域其餘寫原因', sk.filter((x) => /同領域/.test(x.reason)).length === 2, sk);
        const r2 = R.createRegistry({ env: ENV, loader: mkLoader(), maxActive: 3, now });
        r2.register(mk('p1', { priority: 1 })); r2.register(mk('p5', { priority: 5 })); r2.register(mk('p3', { priority: 3, eval: { groups: { a: { adapter: 9, base: 1 }, b: { adapter: 9, base: 1 } } } }));
        check('同來源看 priority', r2.select({ domain: 'tool_routing' }).plan[0].id === 'p5');
        const r3 = R.createRegistry({ env: ENV, loader: mkLoader(), maxActive: 3, now });
        r3.register(mk('e1', { eval: { groups: { a: { adapter: 2, base: 1 } } } })); r3.register(mk('e3', { eval: { groups: { a: { adapter: 3, base: 1 }, b: { adapter: 3, base: 1 }, c: { adapter: 3, base: 1 } } } }));
        check('同 priority 看評量', r3.select({ domain: 'tool_routing' }).plan[0].id === 'e3');
        const r4 = R.createRegistry({ env: ENV, loader: mkLoader(), maxActive: 3, now });
        r4.register(mk('d1', { domains: ['tool_routing'] })); r4.register(mk('d2', { domains: ['colu'], conflicts_with: ['d1'], source: 'user' }));
        const s = r4.select({ domains: ['tool_routing', 'colu'] }); check('conflicts_with 排除排序在後者', s.plan.length === 1 && s.plan[0].id === 'd2' && s.skipped.some((x) => x.id === 'd1' && /衝突/.test(x.reason)), s);
        const r5 = R.createRegistry({ env: ENV, loader: mkLoader(), maxActive: 3, now });
        r5.register(mk('gen', { domains: [] })); r5.register(mk('spec', { domains: ['uml_design'] }));
        check('有專屬者時通用讓位', r5.select({ domain: 'uml_design' }).plan.map((e) => e.id).join() === 'spec');
        check('沒有專屬者時用通用', r5.select({ domain: 'colu' }).plan.map((e) => e.id).join() === 'gen');
        const r6 = R.createRegistry({ env: ENV, loader: mkLoader(), maxActive: 3, now });
        r6.register(mk('t1', { domains: ['writer'], triggers: ['寫信', 'email'] }));
        check('使用者指令觸發字', r6.select({ text: '幫我寫信給客戶' }).plan.length === 1 && r6.select({ text: '今天天氣' }).plan.length === 0);
        const r7 = R.createRegistry({ env: ENV, loader: mkLoader(), maxActive: 1, now });
        r7.register(mk('m1', { domains: ['a'] })); r7.register(mk('m2', { domains: ['b'] }));
        const s7 = r7.select({ domains: ['a', 'b'] }); check('maxActive 上限', s7.plan.length === 1 && s7.skipped.some((x) => /上限/.test(x.reason)), s7);
    }
    // 預算與 LRU 卸載
    {
        const L = mkLoader(); const r = R.createRegistry({ env: ENV, loader: L, budgetBytes: 100 * MB, maxActive: 3, now });
        for (const [id, d] of [['A', 'da'], ['B', 'db'], ['C', 'dc']]) r.register(mk(id, { domains: [d], size: 40 * MB }));
        await r.request({ domain: 'da' }); await r.request({ domain: 'db' });
        check('兩個 80MB 都駐留', r.loaded().length === 2);
        await r.request({ domain: 'da' }); // A 變成最近使用
        const res = await r.request({ domain: 'dc' });
        check('超預算時卸載最久沒用的（B）', res.unloaded.join() === 'B' && L.log.join('|') === 'load A|load B|unload B|load C', { res, log: L.log });
        check('A、C 駐留', r.loaded().map((x) => x.id).sort().join() === 'A,C');
        check('卸載順序記錄', L.log.indexOf('unload B') > L.log.indexOf('load B'));
        // 單一 adapter 就超過預算
        r.register(mk('HUGE', { domains: ['dh'], size: 200 * MB }));
        const rh = await r.request({ domain: 'dh' }); check('單一超預算不載、寫原因', rh.active.length === 0 && rh.skipped.some((x) => x.id === 'HUGE' && /預算/.test(x.reason)), rh);
        check('單一超預算沒把別人卸掉', r.loaded().length === 2);
        // 本次計畫內的不被卸載：兩個領域一次要、預算只夠一個
        const L2 = mkLoader(); const r2 = R.createRegistry({ env: ENV, loader: L2, budgetBytes: 50 * MB, maxActive: 2, now });
        r2.register(mk('X', { domains: ['x'], size: 40 * MB, priority: 2 })); r2.register(mk('Y', { domains: ['y'], size: 40 * MB, priority: 1 }));
        const r2r = await r2.request({ domains: ['x', 'y'] }); check('計畫超預算丟排序最後者', r2r.active.join() === 'X' && r2r.skipped.some((x) => x.id === 'Y'), r2r);
        // 停用會卸載
        await r.setEnabled('A', false); check('停用即卸載', r.loaded().map((x) => x.id).join() === 'C' && L.log.indexOf('unload A') >= 0);
        // 載入失敗
        const bl = { load: async () => { throw new Error('壞了'); }, unload: async () => {} };
        const r3 = R.createRegistry({ env: ENV, loader: bl, now }); r3.register(mk('F', {}));
        const rf = await r3.request({ domain: 'tool_routing' }); check('載入失敗回具體原因、不留駐留', rf.active.length === 0 && /載入失敗：壞了/.test(rf.skipped[0].reason) && r3.loaded().length === 0, rf);
        // 沒載入器
        let t2 = false; try { await R.createRegistry({ env: ENV }).ensure([]); } catch (e) { t2 = /載入器/.test(e.message); } check('沒載入器明確報錯', t2);
        // maxActive=1 換 adapter：先卸再載
        const L4 = mkLoader(); const r4 = R.createRegistry({ env: ENV, loader: L4, budgetBytes: 500 * MB, maxActive: 1, now });
        r4.register(mk('P', { domains: ['p'] })); r4.register(mk('Q', { domains: ['q'] }));
        await r4.request({ domain: 'p' }); await r4.request({ domain: 'q' });
        check('maxActive=1 切換領域卸舊載新', L4.log.join('|') === 'load P|unload P|load Q', L4.log);
        await r4.unloadAll(); check('unloadAll', r4.loaded().length === 0);
        // 取代載入中的項要擋
        await r4.request({ domain: 'q' }); let t3 = false; try { r4.register(mk('Q', {})); } catch (e) { t3 = /載入中/.test(e.message); } check('載入中不可取代', t3);
        // 快照往返
        const snap = JSON.parse(JSON.stringify(r4.snapshot())); const r5 = R.createRegistry({ env: ENV, loader: mkLoader(), now }); const rs = r5.restore(snap);
        check('快照往返', rs.bad.length === 0 && r5.list().length === 2);
    }
    // manifest 轉登錄項＋nr-engine 載入器
    {
        const man = { name: 'tools-r2', base: 'Qwen/Qwen3-0.6B', format: 'peft-lora', rank: 16, alpha: 32, target_modules: ['q_proj'], trained_on: { train_file_sha256: H('1'), tool_catalog_sha256: H('a') }, total_size: 4, sha256: A.sha256Hex(new Uint8Array([1, 2, 3, 4])), eval: good };
        const e = R.entryFromManifest(man, { location: 'fap:lora/tools-r2', domains: ['tool_routing'], prompt_format_version: 3 });
        check('manifest→登錄項', R.validateEntry(e).length === 0 && e.source === 'imported' && e.tool_catalog_sha256 === H('a'), R.validateEntry(e));
        const L = R.nrEngineLoader({ readBytes: async () => new Uint8Array([1, 2, 3, 4]), sha256Hex: A.sha256Hex });
        const h = await L.load(e); check('nrEngineLoader 回 {id, bytes}（nr-engine lora 接點）', h.id === e.id && h.bytes.length === 4);
        const L2 = R.nrEngineLoader({ readBytes: async () => new Uint8Array([9, 9, 9, 9]), sha256Hex: A.sha256Hex });
        let rej = false; try { await L2.load(e); } catch (err) { rej = /sha256 不符/.test(err.message); } check('雜湊不符拒載', rej);
    }
    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})();
