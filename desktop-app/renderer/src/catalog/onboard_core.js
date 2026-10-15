/* catalog_onboard 的核心（UMD，純函式）：請求驗證與安全關卡、結果摘要、持久化格式與合併、為什麼沒晉升、單元查詢。
 * 實際的安裝／抽取／探測在 floating-assistant.js（Pyodide Worker）。設計見 DESIGN.unit-catalog.md 第十六節。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'));
    else root.FaCatalogOnboard = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat) {
    'use strict';
    const LIMITS = { modules: 20, packages: 5, unitsTotal: 3000, installMs: 120000, extractMs: 60000, probeBatchMs: 30000, probeUnitMs: 8000, storeUnits: 20000, records: 50 };
    // 匯入就會做事（開視窗、開瀏覽器、跑圖形介面）的標準庫模組：不給匯入
    const DENY_MODULES = new Set(['antigravity', 'this', 'tkinter', 'turtle', 'turtledemo', 'idlelib', 'webbrowser', 'pydoc', 'pdb', 'code', 'codeop', 'site', '__main__', 'ensurepip', 'venv', 'pip', 'setuptools', 'pkg_resources', 'distutils', 'lib2to3', 'test', 'xmlrpc.server', 'http.server', 'socketserver', 'asyncio.__main__']);
    const MOD_RE = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/;
    const PKG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,60}(==[A-Za-z0-9][A-Za-z0-9._!+-]{0,30})?$/;

    // ===== 請求驗證 =====
    // args: { modules: string[], packages?: string[], probe?: boolean }
    function validateRequest(args, env) {
        env = env || {}; args = args || {}; const errors = [];
        let modules = Array.isArray(args.modules) ? args.modules : (typeof args.modules === 'string' ? args.modules.split(/[\s,]+/) : []); modules = Array.from(new Set(modules.map((x) => String(x).trim()).filter(Boolean)));
        let packages = Array.isArray(args.packages) ? args.packages : (typeof args.packages === 'string' ? args.packages.split(/[\s,]+/) : []); packages = Array.from(new Set(packages.map((x) => String(x).trim()).filter(Boolean)));
        if (!modules.length) errors.push('modules 不能是空的（要抽取哪些模組，例如 ["statistics"]；安裝套件時是它匯入時的名稱，例如 "yaml"）');
        if (modules.length > LIMITS.modules) errors.push('一次最多 ' + LIMITS.modules + ' 個模組');
        if (packages.length > LIMITS.packages) errors.push('一次最多安裝 ' + LIMITS.packages + ' 個套件');
        for (const m of modules) { if (!MOD_RE.test(m)) errors.push('模組名稱不合法：' + m); else if (DENY_MODULES.has(m) || DENY_MODULES.has(m.split('.')[0])) errors.push('不給匯入：' + m + '（匯入就會開視窗、開瀏覽器或啟動伺服器）'); }
        for (const p of packages) {
            if (/^(git\+|https?:|ssh:|file:)|[\/\\@: ]/.test(p.replace(/==.*/, ''))) errors.push('不支援這種套件來源：' + p + '（只接受 PyPI 套件名稱，可加 ==版本；git 網址、本機路徑、任意網址都不行——瀏覽器沙盒裡沒有 git，也不讓模型指定任意網址）');
            else if (!PKG_RE.test(p)) errors.push('套件名稱不合法：' + p);
        }
        const allow = new Set((env.allowlist || []).map((x) => String(x).toLowerCase())); const normName = (p) => p.replace(/==.*/, '').toLowerCase().replace(/[_.]+/g, '-');
        const needConfirm = packages.filter((p) => !allow.has(normName(p)) && !allow.has(p.toLowerCase()));
        return { ok: !errors.length, errors, modules, packages, probe: args.probe !== false, needConfirm, install: packages.length > 0 };
    }
    function confirmText(req) {
        return '要安裝並匯入這些套件，好讓 AI 學會使用它們：\n\n' + req.needConfirm.map((p) => '- ' + p).join('\n') + '\n\n會發生什麼：從 PyPI 下載（只有純 Python 套件與 Pyodide 官方編好的套件裝得起來），在隔離的 Python 沙盒（Worker）裡安裝並匯入模組：' + req.modules.join('、') + '。\n⚠️ 安裝與匯入本身會執行套件裡的程式碼。沙盒擋下網路連線、子行程與開啟瀏覽器，但不保證安全——只安裝你信任的套件。抽取只讀不呼叫函式；探測只對判斷為純函式的單元，擋下檔案與網路。';
    }

    // ===== 為什麼沒晉升（信任等級 0 的原因）=====
    function heldReasons(units) {
        const out = { no_signature: 0, untyped_params: 0, effects_unknown: 0, has_callable: 0, unavailable: 0, no_tests_or_return: 0, type_conflict: 0, probe_failed: 0, other: 0 }; const examples = {};
        const note = (k, u) => { out[k]++; (examples[k] = examples[k] || []).length < 5 && examples[k].push(u.name); };
        for (const u of units) {
            if (u.tier === 1) continue;
            if (u.type_conflict) note('type_conflict', u); else if (u.call && u.sig_src === 'none') note('no_signature', u); else if (u.avail && !['builtin', 'installed'].includes(u.avail.state)) note('unavailable', u);
            else if (u.effects.includes('unknown')) note('effects_unknown', u); else if (u.params.some((p) => p.type === 'callable') || (u.returns && u.returns.type === 'callable')) note('has_callable', u);
            else if (u.params.some((p) => p.type_src === 'none' || p.type === 'any')) note('untyped_params', u); else if (u.probe && u.probe.ok === 0) note('probe_failed', u);
            else if (!(u.tests && u.tests.length) && !(u.returns && u.returns.type !== 'any')) note('no_tests_or_return', u); else note('other', u);
        }
        return { counts: out, examples };
    }

    // ===== 結果摘要（給模型看的，要短）=====
    function summarize(units, extra) {
        extra = extra || {}; const st = Cat.stats(units); const t1 = units.filter((u) => u.tier === 1); const held = heldReasons(units);
        const probed = units.filter((u) => u.probe); const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null);
        return { units: units.length, trusted: t1.length, trusted_pct: pct(t1.length, units.length), params_typed_pct: st.typed_param_pct, probed: probed.length, verified: probed.filter((u) => u.verified).length, type_conflicts: units.filter((u) => u.type_conflict).length,
            trusted_examples: t1.slice(0, 12).map((u) => u.name + '(' + u.params.map((p) => p.name + ':' + p.type).join(', ') + ') → ' + u.returns.type), held_reasons: Object.fromEntries(Object.entries(held.counts).filter(([, v]) => v)), held_examples: held.examples, ...extra };
    }

    // ===== 持久化：{ version, python, records:[…], units:[…] } =====
    function emptyStore() { return { version: 1, python: null, records: [], units: [] }; }
    function mergeStore(store, newUnits, record) {
        const s = store && store.units ? { version: 1, python: store.python || null, records: (store.records || []).slice(), units: store.units.slice() } : emptyStore(); const byId = new Map(s.units.map((u, i) => [u.id, i]));
        // 同一個模組重新抽取：先清掉這個模組舊的單元（套件升版後函式可能消失，不要留殘影）
        const mods = new Set(newUnits.map((u) => u.call && u.call.import).filter(Boolean)); s.units = s.units.filter((u) => !(u.call && mods.has(u.call.import))); byId.clear(); s.units.forEach((u, i) => byId.set(u.id, i));
        for (const u of newUnits) { if (byId.has(u.id)) s.units[byId.get(u.id)] = u; else { byId.set(u.id, s.units.length); s.units.push(u); } }
        if (s.units.length > LIMITS.storeUnits) s.units = s.units.slice(s.units.length - LIMITS.storeUnits);
        if (record) { s.records.push(record); if (s.records.length > LIMITS.records) s.records = s.records.slice(-LIMITS.records); s.python = record.python || s.python; }
        return s;
    }
    // 目錄裡的單元過期判斷：套件版本或 Python 版本與目前不同
    function staleUnits(store, current) { const stale = []; for (const u of (store.units || [])) { const rec = (store.records || []).slice().reverse().find((r) => r.modules && r.modules.includes(u.call && u.call.import)); if (!rec) continue; const pkgChanged = current && current.packages && Object.keys(rec.versions || {}).some((k) => current.packages[k] && current.packages[k] !== rec.versions[k]); const pyChanged = current && current.python && rec.python && current.python.split('.').slice(0, 2).join('.') !== rec.python.split('.').slice(0, 2).join('.'); if (pkgChanged || pyChanged) stale.push(u.id); } return stale; }
    function makeRecord(req, res, units, now) { return { when: now || new Date().toISOString(), python: res.python, modules: req.modules, packages: req.packages, versions: res.pkg_versions || {}, source: req.install ? 'pypi' : 'stdlib', units: units.length, trusted: units.filter((u) => u.tier === 1).length, probed: req.probe }; }

    // ===== 查詢（給 catalog_query 與模型用）=====
    function score(u, words) { let s = 0; const hay = (u.name + ' ' + (u.summary || '') + ' ' + u.params.map((p) => p.name).join(' ')).toLowerCase(); for (const w of words) { if (u.name.toLowerCase() === w) s += 10; else if (u.name.toLowerCase().includes(w)) s += 4; else if (hay.includes(w)) s += 1; } return s; }
    function search(units, text, opts) {
        opts = opts || {}; const words = String(text || '').toLowerCase().split(/[\s,，、]+/).filter((w) => w.length >= 2); const limit = Math.min(opts.limit || 10, 30); let pool = units;
        if (opts.onlyTrusted) pool = pool.filter((u) => u.tier === 1); if (opts.runtime) pool = pool.filter((u) => u.runtime === opts.runtime);
        if (opts.takes) { try { pool = pool.filter((u) => u.params.some((p) => Cat.isAssignable(opts.takes, p.type) && p.type !== 'any')); } catch (_) { /* 型別字串不合法就不篩 */ } }
        if (opts.returns) { try { pool = pool.filter((u) => u.returns.type !== 'any' && u.returns.type !== 'json' && Cat.isAssignable(u.returns.type, opts.returns)); } catch (_) { /* */ } }
        const ranked = pool.map((u) => ({ u, s: words.length ? score(u, words) : 1 })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || b.u.tier - a.u.tier || (a.u.name < b.u.name ? -1 : 1)).slice(0, limit);
        return ranked.map((x) => brief(x.u));
    }
    function brief(u) { return { id: u.id, signature: u.name + '(' + u.params.map((p) => p.name + (p.required ? '' : '?') + ':' + p.type).join(', ') + ') → ' + u.returns.type, summary: (u.summary || '').slice(0, 100), trusted: u.tier === 1, effects: u.effects, verified: !!u.verified, call: u.call || null }; }

    return { LIMITS, DENY_MODULES, validateRequest, confirmText, heldReasons, summarize, emptyStore, mergeStore, staleUnits, makeRecord, search, brief };
});
