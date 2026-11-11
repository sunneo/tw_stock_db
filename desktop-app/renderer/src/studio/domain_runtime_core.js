/* 訓練工作室：使用者領域的執行期載入器（UMD，依賴注入，不碰 DOM／網路／檔案）。設計 §16.3。
 * 把「領域規格」編譯後，經既有的註冊介面接進離線 AI：
 *   blockly → FaDomains.register(pack, {AI, PAR})：讀題規則進 FaAlgoIntent.ALGOS（pri，領域詞彙優先於通用詞彙）、骨架進 FaPyParadigms，離線寫程式（_codeOffline）自然會用到；
 *   matrix  → FaMatrixSynth.register(name, fn, {order:35})：每個操作一個模組，矩陣層合成時依序試。
 * 啟用／停用：停用＝把這個領域登記進去的東西全部拿掉（不留痕跡）；啟用狀態存在偏好（prefs.domainEnabled：{ 'kind/名稱': true|false }），預設「沒寫＝停用」，要使用者明確啟用。
 * createRuntime(deps)：
 *   Domains  FaDomains（register／get／list）   AI  FaAlgoIntent（ALGOS／PARADIGMS）   PAR  FaPyParadigms（PARADIGMS／byId）   Synth  FaMatrixSynth（register／unregister／list）
 *   Spec     domain_spec_core（預設自動取得）    Expr  dsl_expr_core
 * 方法：
 *   ensure(spec) → async {ok, already?, kind, algos?, skeletons?, ops?, error?}   驗證→編譯→註冊；同雜湊已註冊就直接回 already；雜湊變了先拿掉舊的
 *   remove(id) → {ok, removed}          status() → [{id, kind, hash, algos, skeletons, ops}]
 *   syncEnabled({list(): [{kind,name}], load(kind,name): spec|null}, enabledMap) → {loaded[], removed[], failed[]}   依啟用表對齊目前登記狀態
 * 防撞規則：算法種類名稱不可與內建重名；骨架 id 不可與既有骨架重名（內建的優先，使用者的被拒絕並說明）。 */
(function (root, factory) {
    const S = (typeof module === 'object' && module.exports) ? require('./domain_spec_core.js') : root.FaStudioDomainSpec;
    const X = (typeof module === 'object' && module.exports) ? require('./dsl_expr_core.js') : root.FaStudioExpr;
    if (typeof module === 'object' && module.exports) module.exports = factory(S, X);
    else root.FaStudioDomainRuntime = factory(S, X);
})(typeof self !== 'undefined' ? self : this, function (SpecDefault, ExprDefault) {
    'use strict';
    function createRuntime(deps) {
        const Spec = deps.Spec || SpecDefault, Expr = deps.Expr || ExprDefault; const reg = new Map(); // id → {kind, hash, packId, algoKeys, skIds, names}
        let seq = 0; // 註冊表以 id 判斷「已註冊」且沒有移除介面，所以每次註冊都用新的 id（含雜湊與流水號），舊的標 disabled
        const tagId = (spec) => 'user-' + spec.id + '~' + Spec.hash(Spec.normalize(spec)).slice(0, 8) + '#' + (++seq);

        function removeBlockly(rec) {
            const A = deps.AI, P = deps.PAR;
            if (A && A.ALGOS) for (let i = A.ALGOS.length - 1; i >= 0; i--) if (A.ALGOS[i].userDomain === rec.id) A.ALGOS.splice(i, 1);
            if (A && A.PARADIGMS) for (const k of rec.algoKeys) delete A.PARADIGMS[k];
            if (P && P.PARADIGMS) for (let i = P.PARADIGMS.length - 1; i >= 0; i--) if (P.PARADIGMS[i].userDomain === rec.id) { delete P.byId[P.PARADIGMS[i].id]; P.PARADIGMS.splice(i, 1); }
            const pk = deps.Domains && deps.Domains.get(rec.packId); if (pk) pk.disabled = true; // 註冊表沒有移除介面：標停用，列表時用 userDomain／disabled 過濾
        }
        function remove(id) {
            const rec = reg.get(id); if (!rec) return { ok: true, removed: false };
            if (rec.kind === 'blockly') removeBlockly(rec); else if (deps.Synth) for (const n of rec.names) deps.Synth.unregister(n);
            reg.delete(id); return { ok: true, removed: true };
        }
        async function ensure(spec) {
            const v = Spec.validate(spec); if (!v.ok) return { ok: false, error: '規格沒通過驗證：' + v.errors.slice(0, 3).join('；') };
            const hash = Spec.hash(Spec.normalize(spec)); const cur = reg.get(spec.id);
            if (cur && cur.hash === hash) return { ok: true, already: true, kind: spec.kind };
            if (cur) remove(spec.id);
            const s = Spec.normalize(spec);
            if (s.kind === 'blockly') {
                if (!deps.Domains || !deps.AI || !deps.PAR) return { ok: false, error: '這個環境沒有領域註冊介面（FaDomains／FaAlgoIntent／FaPyParadigms）' };
                for (const a of s.algos) if (deps.AI.ALGOS.some((x) => x.key === a.key && !x.userDomain)) return { ok: false, error: '算法種類「' + a.key + '」與內建重名，請改名（內建優先，使用者領域不覆蓋）' };
                for (const k of s.skeletons) if (deps.PAR.byId[k.id]) return { ok: false, error: '骨架 id「' + k.id + '」與既有骨架重名，請改名' };
                for (const [oid, r] of reg) if (oid !== s.id && r.kind === 'blockly' && s.algos.some((a) => r.algoKeys.includes(a.key))) return { ok: false, error: '算法種類與另一個使用者領域（' + oid + '）重名' };
                const pack = Spec.compileBlockly(s, deps.PAR); pack.id = tagId(s);
                const r = deps.Domains.register(pack, { AI: deps.AI, PAR: deps.PAR }); if (!r.ok) return { ok: false, error: r.reason || '註冊失敗' };
                for (const a of deps.AI.ALGOS) if (pack.algos.some((x) => x.key === a.key) && !a.userDomain) a.userDomain = s.id; // 標記，才能拿掉
                for (const k of deps.PAR.PARADIGMS) if (pack.skeletons.some((x) => x.id === k.id)) k.userDomain = s.id;
                reg.set(s.id, { id: s.id, kind: 'blockly', hash, packId: pack.id, algoKeys: pack.algos.map((a) => a.key), skIds: pack.skeletons.map((k) => k.id), label: s.label });
                return { ok: true, kind: 'blockly', algos: r.algos, skeletons: r.skeletons, packId: pack.id };
            }
            if (!deps.Synth) return { ok: false, error: '沒有載入 matrix_synth_core' };
            const mods = Spec.compileMatrix(s, Expr); const names = [];
            for (const m of mods) { deps.Synth.register(m.name, m.fn, m.opts); names.push(m.name); }
            reg.set(s.id, { id: s.id, kind: 'matrix', hash, names, label: s.label });
            return { ok: true, kind: 'matrix', ops: mods.length, names };
        }
        const status = () => [...reg.values()].map((r) => ({ id: r.id, kind: r.kind, label: r.label, hash: r.hash, algos: (r.algoKeys || []).length, skeletons: (r.skIds || []).length, ops: (r.names || []).length }));
        async function syncEnabled(store, enabled) {
            enabled = enabled || {}; const out = { loaded: [], removed: [], failed: [] }; const want = new Map();
            for (const it of await store.list()) { if (enabled[it.kind + '/' + it.name] !== true) continue; let spec = null; try { spec = await store.load(it.kind, it.name); } catch (_) { /* */ } if (!spec) { out.failed.push({ ref: it.kind + '/' + it.name, error: '讀不到領域規格' }); continue; } want.set(spec.id, { spec, ref: it.kind + '/' + it.name }); }
            for (const id of [...reg.keys()]) if (!want.has(id)) { remove(id); out.removed.push(id); }
            for (const [id, w] of want) { const r = await ensure(w.spec); if (r.ok) { if (!r.already) out.loaded.push(id); } else out.failed.push({ ref: w.ref, error: r.error }); }
            return out;
        }
        return { ensure, remove, status, syncEnabled, has: (id) => reg.has(id) };
    }
    return { createRuntime };
});
