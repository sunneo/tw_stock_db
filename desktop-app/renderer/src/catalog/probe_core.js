/* 探測執行的核心（UMD，純函式）：依參數型別產生測試輸入、把探測結果套回單元（驗證型別、補測試案例、重新評信任等級）。
 * 實際執行在 probe_py.py（Pyodide 或 CPython）。設計見 DESIGN.unit-catalog.md。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'));
    else root.FaCatalogProbe = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat) {
    'use strict';
    const b64 = (s) => (typeof Buffer !== 'undefined' ? Buffer.from(s, 'utf8').toString('base64') : btoa(s));

    // ===== 候選輸入：依型別（與參數名稱的提示）產生幾個確定的值（不用亂數，結果可重現）=====
    function candidates(type, name) {
        const t = typeof type === 'string' ? Cat.parseType(type) : type; const n = String(name || '');
        switch (t.k) {
            case 'int': return /(^|_)(n|k|i|j|count|size|width|length|ndigits|places|base)$/i.test(n) ? [1, 2, 5, 3] : [0, 1, 5, -3];
            case 'number': return [0.5, 1.5, 2.0, 0.25];
            case 'bool': return [true, false];
            case 'text': return /(^|_)(format|fmt)$/i.test(n) ? ['%Y-%m-%d', '%H:%M'] : ['abc', 'Hello, World', '12', ''];
            case 'query': return ['a.*b', '\\d+', 'abc'];
            case 'bytes': return [{ $bytes: b64('abc') }, { $bytes: b64('Hello, World') }];
            case 'path': return ['/tmp/x.txt', 'a/b/c.py', 'dir/file', 'archive.tar.gz'];
            case 'url': return ['https://example.com/a/b?x=1&y=2', 'http://localhost:8080/path'];
            case 'null': return [null];
            case 'dict': return [{ a: 1, b: 2 }, { x: 'y' }];
            case 'enum': return t.values.slice(0, 4);
            case 'union': { const lists = t.of.map((x) => candidates(x, name)); const out = []; for (let i = 0; i < 4; i++) for (const l of lists) if (i < l.length) out.push(l[i]); return out.slice(0, 5); }
            case 'list': {
                const el = t.of; if (el.k === 'number') return [[0.5, 1.5, 2.0, 0.25], [1, 2, 3, 4], [10, 20, 30, 40, 50]];
                if (el.k === 'int') return [[1, 2, 3, 4], [5, 3, 8, 1], [10, 20, 30]]; if (el.k === 'text') return [['a', 'b', 'c'], ['x', 'yy']];
                if (el.k === 'bool') return [[true, false, true]]; if (el.k === 'any') return [[1, 2, 3, 4], [4, 2, 9, 7]];
                const sub = candidates(el, name); return sub.length ? [sub.slice(0, 3)] : [];
            }
            default: return []; // any、callable、yaml、code、file_id…：沒有可靠的產生方式
        }
    }

    // 為一個單元產生探測案例。每個必填參數都要有候選，否則回傳 { skip: 原因 }。案例 i 對每個參數取第 i 個候選（輪流），所以多個同型別的清單長度一致。
    function buildCases(unit, opts) {
        opts = opts || {}; const maxCases = opts.maxCases || 6; const req = unit.params.filter((p) => p.required), opt = unit.params.filter((p) => !p.required);
        for (const p of unit.params) if (p.type === 'callable') { if (p.required) return { skip: '參數 ' + p.name + ' 是函式，不能用 JSON 傳' }; }
        const cand = new Map(); for (const p of unit.params) { let c; try { c = candidates(p.type, p.name); } catch (_) { c = []; } cand.set(p.name, c); }
        for (const p of req) if (!cand.get(p.name).length) return { skip: '必填參數 ' + p.name + '（' + p.type + '）沒有可靠的測試輸入' };
        const cases = []; const seen = new Set();
        const mk = (i, withOpt) => {
            const args = [], kwargs = {}; let positionalOk = true;
            for (const p of req) { const c = cand.get(p.name); const v = c[i % c.length]; if (p.kind === 'positional') { if (!positionalOk) return null; args.push(v); } else kwargs[p.name] = v; }
            if (withOpt) { const c = cand.get(withOpt.name); if (!c.length || withOpt.kind === 'positional') return null; kwargs[withOpt.name] = c[i % c.length]; }
            const key = JSON.stringify([args, kwargs]); if (seen.has(key)) return null; seen.add(key); return { args, kwargs };
        };
        const n = Math.max(1, Math.max(0, ...req.map((p) => Math.min(4, cand.get(p.name).length)))); // 必填參數候選最多的那個決定輪流幾輪
        for (let i = 0; i < n && cases.length < maxCases; i++) { const c = mk(i); if (c) cases.push(c); }
        for (const p of opt) { if (cases.length >= maxCases) break; const c = mk(0, p); if (c) cases.push(c); }
        if (!cases.length) return { skip: '產生不出不重複的案例' }; return { cases };
    }

    // ===== 把探測結果套回單元 =====
    function typeOk(observed, declared) { try { return Cat.isAssignable(observed, declared); } catch (_) { return false; } }
    function collapse(types) { const u = Array.from(new Set(types)); if (u.includes('number')) return u.filter((x) => x !== 'int').length === 1 ? 'number' : 'union<' + u.filter((x) => x !== 'int').join('|') + '>'; return u.length === 1 ? u[0] : 'union<' + u.join('|') + '>'; }
    function retier(u) {
        const typedAll = u.params.every((q) => q.type_src !== 'none' && q.type !== 'any' && q.type !== 'callable'); const rt = u.returns && u.returns.type !== 'any' && u.returns.type !== 'json';
        const avail = u.avail && (u.avail.state === 'builtin' || u.avail.state === 'installed');
        u.tier = (typedAll && !u.effects.includes('unknown') && avail && u.returns.type !== 'callable' && !u.type_conflict && (u.tests.length > 0 || rt) && !(u.probe && u.probe.ok === 0)) ? 1 : 0; return u.tier;
    }
    function applyProbe(unit, job, cases, opts) {
        opts = opts || {}; const u = unit; const res = job.cases || []; const ok = res.filter((r) => r.ok); const blocked = res.filter((r) => r.blocked).length;
        const REJ = /^(TypeError|ValueError|OverflowError|ZeroDivisionError|KeyError|IndexError|AttributeError|ArithmeticError|LookupError|UnicodeError)$/; // 輸入被拒絕（我們產生的輸入不合這個函式的要求），不是程式壞掉
        const rejected = res.filter((r) => !r.ok && !r.blocked && [r.exc].concat(r.bases || []).some((x) => REJ.test(x || ''))).length;
        const nondet = ok.filter((r) => !r.det).length; const observed = ok.length ? collapse(ok.map((r) => r.type)) : null;
        u.probe = { cases: res.length, ok: ok.length, rejected, blocked, nondeterministic: nondet, observed, import_error: job.import_error || null, errors: res.filter((r) => !r.ok).slice(0, 3).map((r) => r.exc + ': ' + (r.msg || '').slice(0, 60)) };
        if (job.import_error) { u.probe.ok = 0; retier(u); return u; }
        if (nondet) u.nondeterministic = true; if (!ok.length) { retier(u); return u; }
        // 回傳型別：宣告不明 → 以觀察到的為準（標 probe）；宣告明確 → 每個觀察值都放得進宣告才算驗證過，否則記錄衝突
        const declared = u.returns && u.returns.type; const unknownDeclared = !declared || declared === 'any' || declared === 'json';
        if (unknownDeclared) { if (observed && observed !== 'any' && !/^union/.test(observed)) { u.returns = { type: observed, type_src: 'probe', verified: true }; } }
        else { const bad = ok.filter((r) => !typeOk(r.type, declared)); if (bad.length) u.type_conflict = { declared, observed: collapse(bad.map((r) => r.type)) }; else u.returns.verified = true; }
        // 參數：有成功案例用到的參數視為「接受這種型別」（不代表會拒絕別的型別）
        const used = new Set(); (cases || []).forEach((c, i) => { if (res[i] && res[i].ok) { Object.keys(c.kwargs || {}).forEach((k) => used.add(k)); (u.params.filter((p) => p.kind === 'positional' && p.required)).slice(0, (c.args || []).length).forEach((p) => used.add(p.name)); } });
        for (const p of u.params) if (used.has(p.name)) p.verified = true;
        // 測試案例：成功、決定性、能轉成 JSON 的呼叫，最多 3 個（連同原本的文件範例總共最多 5 個）
        // 關鍵字呼叫失敗、改用位置參數才成功的（例如 math.log）：把這些參數的種類改成 positional，測試案例也用位置參數記
        (cases || []).forEach((c, i) => { if (res[i] && res[i].ok && res[i].positional) for (const k of Object.keys(c.kwargs || {})) { const p = u.params.find((q) => q.name === k); if (p) p.kind = 'positional'; } });
        const add = []; (cases || []).forEach((c, i) => { const r = res[i]; if (r && r.ok && r.det && r.jsonable && add.length < 3) add.push(r.positional ? { args: (c.args || []).concat(Object.values(c.kwargs || {})), kwargs: {}, expect: r.json === undefined ? null : r.json, src: 'probe' } : { args: c.args, kwargs: c.kwargs, expect: r.json === undefined ? null : r.json, src: 'probe' }); });
        u.tests = (u.tests || []).concat(add).slice(0, 5); u.verified = !u.type_conflict && !nondet;
        retier(u); return u;
    }
    function probeStats(units) {
        const pr = units.filter((u) => u.probe); const n = pr.length; const pct = (a) => (n ? Math.round((a / n) * 1000) / 10 : 0);
        return { probed: n, any_ok: pr.filter((u) => u.probe.ok > 0).length, all_failed: pr.filter((u) => u.probe.ok === 0).length, verified: pr.filter((u) => u.verified).length, conflicts: pr.filter((u) => u.type_conflict).length, nondeterministic: pr.filter((u) => u.nondeterministic).length, blocked: pr.filter((u) => u.probe.blocked).length, with_probe_tests: pr.filter((u) => (u.tests || []).some((t) => t.src === 'probe')).length, verified_pct: pct(pr.filter((u) => u.verified).length), tier1: units.filter((u) => u.tier === 1).length };
    }
    return { candidates, buildCases, applyProbe, retier, probeStats, collapse };
});
