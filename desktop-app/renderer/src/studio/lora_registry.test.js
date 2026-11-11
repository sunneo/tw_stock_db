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
    // 描述檔 fa-lora-descriptor v1（DESIGN §13.2）
    {
        const good = () => ({ format: 'fa-lora-descriptor', format_version: 1, id: 'decompose-r16', version: '1.0.0', base: 'Qwen/Qwen3-0.6B', rank: 16, prompt_format_version: 3,
            applies: { domains: ['decompose'], triggers: ['拆題|拆解'] }, size: 4, sha256: A.sha256Hex(new Uint8Array([1, 2, 3, 4])), location: 'asset:lora/decompose-r16', eval: null });
        const e = R.descriptorFromJson(good());
        check('描述檔合法 → 登錄項（版本、適用條件、位置都帶過去）', R.validateEntry(e).length === 0 && e.version === '1.0.0' && e.domains[0] === 'decompose' && e.triggers.length === 1 && e.location === 'asset:lora/decompose-r16' && e.size === 4, e);
        check('描述檔 id 與 source 預設（imported，可由 extra 覆蓋）', e.source === 'imported' && R.descriptorFromJson(good(), { source: 'user' }).source === 'user');
        const bad = (mut) => { const d = good(); mut(d); return R.descriptorErrors(d); };
        check('缺 version 拒絕', bad((d) => { delete d.version; }).some((x) => /缺 version/.test(x)));
        check('format_version 不是 1 拒絕', bad((d) => { d.format_version = 2; }).some((x) => /format_version/.test(x)));
        check('format 不對拒絕', bad((d) => { d.format = 'x'; }).some((x) => /format 必須/.test(x)));
        check('triggers 非法正規表示式拒絕', bad((d) => { d.applies.triggers = ['(']; }).some((x) => /正規表示式/.test(x)));
        check('sha256 格式錯拒絕', bad((d) => { d.sha256 = 'abc'; }).some((x) => /sha256/.test(x)));
        check('id 含大寫或空白拒絕', bad((d) => { d.id = 'Bad Id'; }).some((x) => /id 格式/.test(x)));
        check('多項錯誤全部列出', bad((d) => { delete d.version; d.rank = 0; d.size = -1; }).length >= 3);
        let thr = false; try { R.descriptorFromJson({ id: 'x' }); } catch (err) { thr = /描述檔不合法/.test(err.message); } check('descriptorFromJson 不合法就丟出原因', thr);
    }

    // 懶載入：註冊不載入；只載入被選到的
    {
        const L = mkLoader(); const r = R.createRegistry({ env: ENV, loader: L, budgetBytes: 500 * MB, maxActive: 3, now });
        r.register(mk('lz1', { domains: ['decompose'] })); r.register(mk('lz2', { domains: ['toolcall'] })); r.register(mk('lz3', { domains: ['plan'] }));
        check('註冊不呼叫載入器（懶載入）', L.log.length === 0 && r.loaded().length === 0, L.log);
        const q = await r.request({ domains: ['toolcall'] });
        check('請求只載入被選到的那一顆', JSON.stringify(q.active) === JSON.stringify(['lz2']) && L.log.join(',') === 'load lz2', L.log);
    }

    // resolve：永不丟例外，沒有可用 adapter 就退回基底
    {
        const noLoader = R.createRegistry({ env: ENV, now }); noLoader.register(mk('nl1', { domains: ['decompose'] }));
        const r1 = await noLoader.resolve({ domains: ['decompose'] });
        check('沒有載入器：resolve 不丟例外，退回基底', r1.fallback === 'base' && r1.active.length === 0 && /登錄表錯誤/.test(r1.skipped[0].reason), r1);
        const L = mkLoader(); L.load = async (e) => { if (e.id === 'bad1') throw new Error('讀不到權重檔'); L.log.push('load ' + e.id); return { id: e.id }; };
        const r2 = R.createRegistry({ env: ENV, loader: L, budgetBytes: 500 * MB, maxActive: 1, now });
        r2.register(mk('bad1', { domains: ['decompose'] }));
        const r2r = await r2.resolve({ domains: ['decompose'] });
        check('載入失敗：退回基底並附具體原因', r2r.fallback === 'base' && r2r.active.length === 0 && r2r.skipped.some((x) => /讀不到權重檔/.test(x.reason)) && r2r.handles.length === 0, r2r);
        r2.register(mk('good1', { domains: ['plan'] }));
        const r2b = await r2.resolve({ domains: ['plan'] });
        check('其他 adapter 不受失敗影響（照常載入）', r2b.fallback === 'lora' && r2b.active[0] === 'good1', r2b);
        const r3 = await r2.resolve({ domains: ['nothing_here'] });
        check('沒有符合的 adapter：fallback 為 base', r3.fallback === 'base' && r3.active.length === 0, r3);
    }

    // LRU：超過上限時先卸最久沒用的；計畫內的不卸
    {
        let t = 5000; const tnow = () => ++t; const L = mkLoader();
        const r = R.createRegistry({ env: ENV, loader: L, budgetBytes: 500 * MB, maxActive: 2, now: tnow });
        ['a1', 'a2', 'a3'].forEach((id) => r.register(mk(id, { domains: [id] })));
        await r.request({ domains: ['a1'] }); await r.request({ domains: ['a2'] });
        await r.request({ domains: ['a1'] });            // a1 最近用過，a2 最久沒用
        const q = await r.request({ domains: ['a3'] });   // maxActive=2 → 應卸 a2
        check('超過 maxActive：卸最久沒用的 a2，保留 a1 與 a3', L.log.indexOf('unload a2') >= 0 && r.loaded().map((x) => x.id).sort().join(',') === 'a1,a3' && q.active[0] === 'a3', { log: L.log, loaded: r.loaded() });
    }

        const ENV_SLOT = Object.assign({}, ENV, { rank_slots: [4, 8, 16] });   // 槽容量測試用：槽版 rank 16，允許 4／8 的 adapter
    // 槽容量（rank 總和）、釘選、推論中保護（DESIGN §14）
    {
        let t = 9000; const tn = () => ++t; const L = mkLoader();
        const r = R.createRegistry({ env: ENV_SLOT, loader: L, budgetBytes: 500 * MB, maxActive: 9, slotCapacity: 16, now: tn });
        r.register(mk('s8a', { rank: 8, domains: ['sa'] })); r.register(mk('s8b', { rank: 8, domains: ['sb'] })); r.register(mk('s4c', { rank: 4, domains: ['sc'] }));
        await r.request({ domains: ['sa'] }); await r.request({ domains: ['sb'] });   // 槽 8+8=16 滿
        const q1 = await r.request({ domains: ['sc'] });                                // 需要 4 → 卸最久沒用的 s8a
        check('槽滿時卸最久沒用者（LRU）騰出 rank', q1.unloaded.join() === 's8a' && q1.active.join() === 's4c' && r.status().usedRank === 12, { q1, st: r.status() });
        check('status：槽容量、已用、剩餘 rank', r.status().slotCapacity === 16 && r.status().freeRank === 4, r.status());
        // 釘選：s8b 被釘，下一次只能卸 s4c
        r.pin('s8b', true);
        r.register(mk('s8d', { rank: 8, domains: ['sd'] }));
        const q2 = await r.request({ domains: ['sd'] });
        check('釘選不被自動淘汰：卸 s4c，保留 s8b', q2.unloaded.join() === 's4c' && r.loaded().map((x) => x.id).sort().join() === 's8b,s8d', { q2, loaded: r.loaded() });
        // 推論中：s8b 釘選，s8d 推論中 → 新的 rank 8 放不下，寫原因
        r.pin('s8b', false); r.acquire('s8b'); r.acquire('s8d');
        r.register(mk('s8e', { rank: 8, domains: ['se'] }));
        const q3 = await r.request({ domains: ['se'] });
        check('推論中不可淘汰：放不下就寫原因（不硬塞）', q3.active.length === 0 && q3.skipped.some((x) => x.id === 's8e' && /槽已滿/.test(x.reason)), q3);
        r.release('s8b'); r.release('s8d');
        check('推論結束後可以淘汰', (await r.request({ domains: ['se'] })).active.join() === 's8e');
        // 手動卸載：釘選與推論中都拒絕
        r.pin('s8e', true);
        check('手動卸載：釘選拒絕', (await r.manualUnload('s8e')).ok === false);
        r.pin('s8e', false); r.acquire('s8e');
        check('手動卸載：推論中拒絕', (await r.manualUnload('s8e')).ok === false); r.release('s8e');
        check('手動卸載：正常可卸', (await r.manualUnload('s8e')).ok === true);
        check('卸載後模型卡仍保留最後使用時間（lastUsed）', r.card(r.get('s8e')).lastUsed !== null && r.card(r.get('s8e')).lastUsed > 0 && r.status().registered.find((c) => c.id === 's8e').lastUsed > 0);
        let pinThrow = false; try { r.pin('nope', true); } catch (_) { pinThrow = true; } check('釘選不存在的 adapter 報錯', pinThrow);
        // 描述檔 description 可選、帶過去
        const d = R.descriptorFromJson({ format: 'fa-lora-descriptor', format_version: 1, id: 'dsc', version: '1', base: 'Qwen/Qwen3-0.6B', rank: 4, prompt_format_version: 3, applies: { domains: ['x'] }, size: 4, sha256: H('e'), location: 'fap:x', description: '拆題用' });
        check('描述檔 description 帶過去', d.description === '拆題用' && R.descriptorErrors(Object.assign({}, { format: 'fa-lora-descriptor', format_version: 1, id: 'dsc', version: '1', base: 'b', rank: 4, prompt_format_version: 3, applies: {}, size: 4, sha256: H('e'), location: 'f', description: 5 })).length === 1);
    }

    // 替換：成功與各種回滾（DESIGN §14.4）
    {
        let t = 12000; const tn = () => ++t;
        const mkL = (failIn, failApply) => { const log = []; return { log, load: async (e) => { if (e.id === failIn) throw new Error('讀不到權重'); log.push('load ' + e.id); return { id: e.id, tag: e.id }; }, unload: async (e) => { log.push('unload ' + e.id); } }; };
        // 成功
        { const L = mkL(); const r = R.createRegistry({ env: ENV_SLOT, loader: L, budgetBytes: 500 * MB, maxActive: 2, slotCapacity: 16, now: tn });
          r.register(mk('ra', { rank: 8, domains: ['a'] })); r.register(mk('rb', { rank: 8, domains: ['b'] }));
          await r.request({ domains: ['a'] });
          let during = null;
          const x = await r.replace('ra', 'rb', { applyFn: async (hs) => { during = r.status().replacing; return { ok: true, n: hs.length }; } });
          check('替換成功：新的上線、舊的卸掉', x.ok && x.active.join() === 'rb' && L.log.indexOf('unload ra') > L.log.indexOf('load rb'), { x, log: L.log });
          check('替換進行中 status.replacing 為 {out, in}；結束後為 null', !!during && during.out === 'ra' && during.in === 'rb' && r.status().replacing === null, { during, after: r.status().replacing }); }
        // 新的載入失敗：原狀不動
        { const L = mkL('rc'); const r = R.createRegistry({ env: ENV_SLOT, loader: L, budgetBytes: 500 * MB, maxActive: 2, slotCapacity: 16, now: tn });
          r.register(mk('ra2', { rank: 8, domains: ['a'] })); r.register(mk('rc', { rank: 8, domains: ['c'] }));
          await r.request({ domains: ['a'] });
          const x = await r.replace('ra2', 'rc', {});
          check('替換：新的載入失敗 → 原狀保留（舊的還在）', !x.ok && x.active.join() === 'ra2' && /原狀保留/.test(x.error), x); }
        // 容量不夠：還原
        { const L = mkL(); const r = R.createRegistry({ env: ENV_SLOT, loader: L, budgetBytes: 500 * MB, maxActive: 2, slotCapacity: 16, now: tn });
          r.register(mk('ra3', { rank: 8, domains: ['a'] })); r.register(mk('rb3', { rank: 16, domains: ['b'] })); r.register(mk('keep3', { rank: 8, domains: ['k'] }));
          await r.request({ domains: ['a'] }); await r.request({ domains: ['k'] });   // 槽 8+8 滿；換 ra3 成 rb3 後需要 8+16=24 > 16
          const x = await r.replace('ra3', 'rb3', {});
          check('替換：扣掉舊的仍放不下 → 還原（舊的還在、新的已卸）', !x.ok && x.rolledBack && x.active.indexOf('ra3') >= 0 && x.active.indexOf('rb3') < 0 && L.log.indexOf('unload rb3') >= 0, { x, log: L.log }); }
        // 套用失敗：還原舊的並再套一次
        { const L = mkL(); const r = R.createRegistry({ env: ENV_SLOT, loader: L, budgetBytes: 500 * MB, maxActive: 2, slotCapacity: 16, now: tn });
          r.register(mk('ra4', { rank: 8, domains: ['a'] })); r.register(mk('rb4', { rank: 8, domains: ['b'] }));
          await r.request({ domains: ['a'] }); const seen = [];
          const x = await r.replace('ra4', 'rb4', { applyFn: async (hs) => { seen.push(hs.map((h) => h.id).join('+')); return hs.some((h) => h.id === 'rb4') ? { ok: false, error: '主程序拒絕' } : { ok: true }; } });
          check('替換：套用失敗 → 回報 rolledBack、舊的還原為 active', !x.ok && x.rolledBack && x.active.join() === 'ra4' && /主程序拒絕/.test(x.error), x);
          check('替換：套用失敗時先套新組合、再把舊組合還原套一次（applyFn 兩次）', seen.length === 2 && seen[0] === 'rb4' && seen[1] === 'ra4', seen); }
        // 釘選與推論中：拒絕
        { const L = mkL(); const r = R.createRegistry({ env: ENV_SLOT, loader: L, budgetBytes: 500 * MB, maxActive: 2, slotCapacity: 16, now: tn });
          r.register(mk('ra5', { rank: 8, domains: ['a'] })); r.register(mk('rb5', { rank: 8, domains: ['b'] }));
          await r.request({ domains: ['a'] }); r.pin('ra5', true);
          const x1 = await r.replace('ra5', 'rb5', {}); check('替換：釘選的舊 adapter 拒絕（先解除）', !x1.ok && /釘選/.test(x1.error));
          r.pin('ra5', false); r.acquire('ra5');
          const x2 = await r.replace('ra5', 'rb5', {}); check('替換：推論中的舊 adapter 拒絕', !x2.ok && /推論中/.test(x2.error));
          r.release('ra5'); const x3 = await r.replace('ra5', 'rb5', {}); check('替換：推論結束後可以替換', x3.ok && x3.active.join() === 'rb5'); } 
    }

    console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})();
