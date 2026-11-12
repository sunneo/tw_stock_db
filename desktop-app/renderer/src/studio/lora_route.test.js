// node renderer/src/studio/lora_route.test.js
const Rt = require('./lora_route_core.js'); const R = require('./lora_registry_core.js');
let ok = 0, bad = 0; const check = (n, c, x) => { if (c) ok++; else { bad++; console.log('FAIL ' + n + (x !== undefined ? ' ' + JSON.stringify(x).slice(0, 300) : '')); } };
const H = (c) => c.repeat(64);
const ENV = { base: 'Qwen/Qwen3-0.6B', rank_slots: [16], prompt_format_version: 3, tool_catalog_sha256: H('a') };
const MB = 1024 * 1024;
const mk = (id, o) => Object.assign({ id, source: 'builtin', base: ENV.base, rank: 16, prompt_format_version: 3, tool_catalog_sha256: H('a'), domains: [], location: 'fap:x/' + id, size: 4 * MB, sha256: H('b'), enabled: true, eval: { score: 1, groups: { g: { adapter: 2, base: 1 } } } }, o);
const mkLoader = () => { const log = []; return { log, load: async (e) => { log.push('load ' + e.id); return { id: e.id }; }, unload: async (e) => { log.push('unload ' + e.id); } }; };

(async () => {
    // 任務類型對應
    check('拆題 → decompose', Rt.taskDomain('decompose') === 'decompose');
    check('工具呼叫 → toolcall（toolcall、tool_call 都認）', Rt.taskDomain('toolcall') === 'toolcall' && Rt.taskDomain('tool_call') === 'toolcall');
    check('選單 → colu；規劃 → plan', Rt.taskDomain('colu') === 'colu' && Rt.taskDomain('plan') === 'plan');
    check('大小寫與空白不影響', Rt.taskDomain('  Decompose ') === 'decompose');
    check('未知任務類型 → null', Rt.taskDomain('chitchat') === null && Rt.taskDomain(undefined) === null);
    check('toString 等名稱不會誤判（原型鏈）', Rt.taskDomain('constructor') === null && Rt.taskDomain('__proto__') === null);

    // 決定：保留／切換／回基底
    check('同一組 → keep', Rt.decideTurn(['a', 'b'], ['b', 'a']) === 'keep');
    check('換組合 → switch', Rt.decideTurn(['a'], ['b']) === 'switch');
    check('沒有 → clear（之前有）', Rt.decideTurn(['a'], []) === 'clear');
    check('沒有且之前也沒有 → keep', Rt.decideTurn([], []) === 'keep');

    // 路由：沒有對應 LoRA 不載入；有對應只載入那一顆
    {
        const L = mkLoader(); const reg = R.createRegistry({ env: ENV, loader: L, budgetBytes: 500 * MB, maxActive: 1, now: () => 1 });
        reg.register(mk('decompose', { domains: ['decompose'], triggers: ['拆題'] }));
        reg.register(mk('plan', { domains: ['plan'] }));
        const a = await Rt.routeTurn(reg, 'colu', {});
        check('沒有 colu 的 LoRA：用基底，不載入', a.fallback === 'base' && a.active.length === 0 && L.log.length === 0 && a.action === 'keep', { a, log: L.log });
        const b = await Rt.routeTurn(reg, 'decompose', {});
        check('拆題：只載入 decompose', b.fallback === 'lora' && b.active.join() === 'decompose' && L.log.join() === 'load decompose' && b.action === 'switch', { b, log: L.log });
        const c = await Rt.routeTurn(reg, 'decompose', { prevActive: ['decompose'] });
        check('同一任務連續兩輪：keep，不重新載入', c.action === 'keep' && L.log.length === 1, { c, log: L.log });
        const d = await Rt.routeTurn(reg, 'plan', { prevActive: ['decompose'] });
        check('換任務：切換，maxActive=1 會卸掉舊的再載入新的', d.action === 'switch' && d.active.join() === 'plan' && L.log.indexOf('unload decompose') >= 0, { d, log: L.log });
        const e = await Rt.routeTurn(reg, 'chitchat', { prevActive: ['plan'] });
        check('未知任務：回基底、action 為 clear（之前有 LoRA）', e.fallback === 'base' && e.action === 'clear' && e.handles.length === 0, e);
    }

    // 失敗：載入失敗回基底並附原因；登錄表沒有 resolve 也回基底
    {
        const L = mkLoader(); L.load = async () => { throw new Error('讀不到權重檔'); };
        const reg = R.createRegistry({ env: ENV, loader: L, budgetBytes: 500 * MB, maxActive: 1, now: () => 1 });
        reg.register(mk('toolcall', { domains: ['toolcall'] }));
        const f = await Rt.routeTurn(reg, 'toolcall', {});
        check('載入失敗：回基底並附原因', f.fallback === 'base' && f.active.length === 0 && f.skipped.some((x) => /讀不到權重檔/.test(x.reason)), f);
        const g = await Rt.routeTurn({}, 'toolcall', {});
        check('沒有登錄表：回基底、不丟例外', g.fallback === 'base' && /沒有登錄表/.test(g.reason), g);
        const h = await Rt.routeTurn({ resolve: async () => { throw new Error('壞掉'); } }, 'plan', {});
        check('登錄表丟例外：回基底並附原因', h.fallback === 'base' && /登錄表錯誤/.test(h.reason), h);
    }
    // 觸發字：applies.triggers 在這一輪的話裡出現時，即使任務類型不同也會選用（第三輪，對應 DESIGN §26）
{
  const reg = R.createRegistry({ env: ENV, slotCapacity: 16, maxActive: 4, loader: { load: async (x) => ({ id: x.id }), unload: async () => {} } });
  const good = { score: 1, groups: { g: { adapter: 9, base: 5 } } };
  reg.register({ id: 'uml-dec', name: 'uml-dec', source: 'imported', base: ENV.base, rank: 4, slot_rank: 16, prompt_format_version: 3, tool_catalog_sha256: H('a'), domains: ['decompose'], triggers: ['UML'], location: 'asset:lora/uml-dec', size: 40 * MB, sha256: H('b'), eval: good, enabled: true });
  const withText = await Rt.routeTurn(reg, 'toolcall', { prevActive: [], text: '請用 UML 幫我拆' });
  check('觸發字命中：任務是 toolcall 也會選到 decompose 的 adapter', withText.active.join() === 'uml-dec', withText);
  const noText = await Rt.routeTurn(reg, 'toolcall', { prevActive: [] });
  check('沒有文字：不靠觸發字，維持原本行為（沒有符合就用基底）', noText.fallback === 'base' && noText.active.length === 0, noText);
}
console.log(ok + ' passed, ' + bad + ' failed'); process.exit(bad ? 1 : 0);
})();
