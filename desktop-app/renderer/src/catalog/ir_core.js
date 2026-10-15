/* 呼叫格式（IR）與直譯器（UMD，純函式＋注入的執行器）：把「一串單元呼叫」寫成 JSON 程式，先靜態檢查（單元存在、參數齊全、型別接得上、副作用彙整、步數上限），
 * 再由直譯器依序執行（變數、引用前面步驟的結果、條件、有上限的迴圈、逾時、取消、確認閘），並留下完整的執行紀錄。
 * 單元怎麼真的被呼叫由 host.invoke 注入（工具走 fa.tools、Python 走 Pyodide），所以這個檔案在 node 裡就能完整測試。設計見 DESIGN.unit-catalog.md 第二十節。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./catalog_core.js'));
    else root.FaCatalogIR = factory(root.FaCatalog || (typeof FaCatalog !== 'undefined' ? FaCatalog : undefined));
})(typeof self !== 'undefined' ? self : this, function (Cat) {
    'use strict';
    const LIMITS = { steps: 60, depth: 4, each: 200, calls: 500, resultChars: 4000, wallMs: 600000, stepMs: 120000 };
    const ID_RE = /^[A-Za-z_][A-Za-z0-9_]{0,40}$/;

    // ===== 值：字面值，或 { $in: 名稱 }、{ $ref: "步驟.路徑" }、{ $item: 路徑 }（迴圈裡）、{ $list: […] }、{ $obj: {…} }（裡面可以再有引用）=====
    const isRefObj = (v) => v && typeof v === 'object' && !Array.isArray(v) && ('$in' in v || '$ref' in v || '$item' in v || '$list' in v || '$obj' in v);
    function parsePath(p) { const out = []; String(p || '').replace(/\[(\d+)\]|\[\*\]|([^.\[\]]+)/g, (m, i, k) => { out.push(i !== undefined ? Number(i) : (m === '[*]' ? '*' : k)); return m; }); return out; }
    function getPath(v, segs) {
        let cur = v; for (let i = 0; i < segs.length; i++) { const s = segs[i]; if (cur === null || cur === undefined) return undefined; if (s === '*') { const rest = segs.slice(i + 1); if (!Array.isArray(cur)) return undefined; return cur.map((x) => getPath(x, rest)); } cur = cur[s]; }
        return cur;
    }
    // 引用的靜態型別：步驟輸出的型別（回傳型別字串）沿著路徑往下找（object 欄位、list 元素）；找不到就是 any
    function typeAtPath(t, segs) {
        let cur = typeof t === 'string' ? Cat.parseType(t) : t; for (const s of segs) {
            if (!cur) return { k: 'any' }; if (cur.k === 'object') { cur = cur.fields[s]; continue; } if (cur.k === 'list') { cur = s === '*' ? { k: 'list', of: cur.of } : cur.of; continue; } if (cur.k === 'union') return { k: 'any' }; return { k: 'any' };
        }
        return cur || { k: 'any' };
    }
    function jsType(v) { if (v === null) return 'null'; if (Array.isArray(v)) return 'list'; if (typeof v === 'number') return Number.isInteger(v) ? 'int' : 'number'; if (typeof v === 'string') return 'text'; if (typeof v === 'boolean') return 'bool'; return 'dict'; }
    function literalFits(v, type) {
        const t = typeof type === 'string' ? Cat.parseType(type) : type; if (t.k === 'any') return true; if (t.k === 'union') return t.of.some((x) => literalFits(v, x));
        const jt = jsType(v); if (t.k === 'enum') return typeof v === 'string' && t.values.includes(v); if (t.k === 'list') return Array.isArray(v) && v.every((x) => literalFits(x, t.of));
        if (t.k === 'object') return jt === 'dict' && Object.keys(t.fields).every((k) => k in v ? literalFits(v[k], t.fields[k]) : true); if (t.k === 'dict' || t.k === 'json') return jt === 'dict' || jt === 'list';
        if (t.k === 'number') return jt === 'int' || jt === 'number'; if (t.k === 'int') return jt === 'int'; if (t.k === 'bool') return jt === 'bool'; if (t.k === 'null') return jt === 'null';
        if (t.k === 'bytes') return jt === 'text' || (v && typeof v === 'object' && '$bytes' in v); if (['text', 'path', 'url', 'yaml', 'code', 'query', 'file_id', 'pdf_file', 'video_file', 'audio_file', 'image_file', 'gif_file', 'subtitle_file'].includes(t.k)) return jt === 'text';
        return false;
    }

    // ===== 靜態檢查 =====
    // catalog: { units:[…] } 或單元陣列；opts: { allowEffects?: [...]（沒列在裡面的副作用會變成錯誤）, strict?: true（不明型別的引用也當錯誤）}
    function validate(program, catalog, opts) {
        opts = opts || {}; const units = Array.isArray(catalog) ? catalog : catalog.units; const byId = new Map(units.map((u) => [u.id, u])); const errors = [], warnings = []; const effects = new Set(); let count = 0;
        if (!program || typeof program !== 'object' || !Array.isArray(program.steps)) return { ok: false, errors: ['程式要是 { steps: […] }'], warnings, effects: [], inputs: {} };
        const inputs = program.inputs || {}; for (const [k, v] of Object.entries(inputs)) { if (!ID_RE.test(k)) errors.push('輸入名稱不合法：' + k); try { Cat.parseType((v && v.type) || 'any'); } catch (e) { errors.push('輸入 ' + k + ' 的型別不合法：' + e.message); } }
        const ids = new Set(); const types = new Map(); // 步驟 id → 輸出型別
        function checkValue(v, want, where, scope) {
            if (isRefObj(v)) {
                if ('$in' in v) { if (!(v.$in in inputs)) { errors.push(where + '：引用了沒宣告的輸入 ' + v.$in); return; } const it = (inputs[v.$in] && inputs[v.$in].type) || 'any'; typeCheck(Cat.parseType(it), want, where + '（輸入 ' + v.$in + '）'); }
                else if ('$ref' in v) { const segs = parsePath(v.$ref); const sid = segs.shift(); if (!scope.has(sid)) { errors.push(where + '：引用了還沒執行（或不存在）的步驟 ' + sid); return; } typeCheck(typeAtPath(types.get(sid), segs), want, where + '（' + v.$ref + '）'); }
                else if ('$item' in v) { if (!scope.has('$item')) { errors.push(where + '：$item 只能在 each 裡用'); return; } typeCheck(typeAtPath(scope.get('$item'), parsePath(v.$item)), want, where + '（$item' + (v.$item ? '.' + v.$item : '') + '）'); }
                else if ('$list' in v) { if (!Array.isArray(v.$list)) { errors.push(where + '：$list 要是陣列'); return; } const el = want && want.k === 'list' ? want.of : { k: 'any' }; v.$list.forEach((x, i) => checkValue(x, el, where + '[' + i + ']', scope)); }
                else if ('$obj' in v) { if (!v.$obj || typeof v.$obj !== 'object') { errors.push(where + '：$obj 要是物件'); return; } for (const [k, x] of Object.entries(v.$obj)) checkValue(x, want && want.k === 'object' && want.fields[k] ? want.fields[k] : { k: 'any' }, where + '.' + k, scope); }
                return;
            }
            if (want && !literalFits(v, want)) errors.push(where + '：字面值 ' + JSON.stringify(v).slice(0, 40) + ' 不是 ' + Cat.typeToString(want));
        }
        function typeCheck(have, want, where) {
            if (!want || want.k === 'any') return; if (have.k === 'any' || have.k === 'json') { (opts.strict ? errors : warnings).push(where + '：來源型別不明，要 ' + Cat.typeToString(want) + '（強制轉型，執行時檢查）'); return; }
            if (!Cat.isAssignable(have, want)) errors.push(where + '：型別接不上（' + Cat.typeToString(have) + ' → ' + Cat.typeToString(want) + '）');
        }
        function walk(steps, scope, depth, path) {
            if (depth > LIMITS.depth) { errors.push(path + '：巢狀太深（上限 ' + LIMITS.depth + '）'); return; }
            for (let i = 0; i < steps.length; i++) {
                const s = steps[i]; const where = path + (s && s.id ? s.id : '#' + (i + 1)); if (++count > LIMITS.steps) { errors.push('步驟太多（上限 ' + LIMITS.steps + '）'); return; }
                if (!s || typeof s !== 'object') { errors.push(where + '：步驟不是物件'); continue; } if (!s.id || !ID_RE.test(s.id)) { errors.push(where + '：步驟要有合法的 id'); continue; } if (ids.has(s.id)) { errors.push(where + '：id 重複'); continue; } ids.add(s.id);
                if (s.call) {
                    const u = byId.get(s.call); if (!u) { errors.push(where + '：目錄裡沒有單元 ' + s.call); scope.set(s.id, 'any'); types.set(s.id, 'any'); continue; }
                    const args = s.args || {}; const names = new Set(u.params.map((p) => p.name)); for (const k of Object.keys(args)) if (!names.has(k)) errors.push(where + '：' + s.call + ' 沒有參數 ' + k);
                    for (const p of u.params) { if (!(p.name in args)) { if (p.required) errors.push(where + '：缺少必填參數 ' + p.name + '（' + p.type + '）'); continue; } checkValue(args[p.name], Cat.parseType(p.type), where + '.' + p.name, scope); }
                    for (const e of u.effects) effects.add(e); if (u.effects.includes('unknown')) warnings.push(where + '：' + s.call + ' 的副作用不明');
                    if (u.tier !== 1) warnings.push(where + '：' + s.call + ' 還不是信任等級 1'); if (u.avail && !['builtin', 'installed'].includes(u.avail.state)) errors.push(where + '：' + s.call + ' 目前不可用（' + u.avail.state + '）');
                    const rt = u.returns && u.returns.type ? u.returns.type : 'any'; types.set(s.id, rt); scope.set(s.id, rt);
                } else if (s.if !== undefined) {
                    checkValue(s.if, { k: 'any' }, where + '.if', scope); if (!Array.isArray(s.then)) errors.push(where + '：if 要有 then 陣列'); else walk(s.then, new Map(scope), depth + 1, where + '.then/'); if (s.else !== undefined) { if (!Array.isArray(s.else)) errors.push(where + '：else 要是陣列'); else walk(s.else, new Map(scope), depth + 1, where + '.else/'); }
                    scope.set(s.id, 'any'); types.set(s.id, 'any');
                } else if (s.each !== undefined) {
                    checkValue(s.each, { k: 'list', of: { k: 'any' } }, where + '.each', scope); const max = s.max === undefined ? LIMITS.each : s.max; if (!Number.isInteger(max) || max < 1 || max > LIMITS.each) errors.push(where + '：max 要是 1 到 ' + LIMITS.each + ' 的整數（每個迴圈都要有上限）');
                    let itemT = { k: 'any' }; if (isRefObj(s.each) && '$ref' in s.each) { const segs = parsePath(s.each.$ref); const sid = segs.shift(); if (scope.has(sid)) { const lt = typeAtPath(types.get(sid), segs); if (lt.k === 'list') itemT = lt.of; } }
                    if (!Array.isArray(s.do)) errors.push(where + '：each 要有 do 陣列'); else { const inner = new Map(scope); inner.set('$item', itemT); walk(s.do, inner, depth + 1, where + '.do/'); }
                    scope.set(s.id, 'list<any>'); types.set(s.id, 'list<any>');
                } else errors.push(where + '：步驟要有 call、if 或 each');
            }
        }
        walk(program.steps, new Map(), 0, ''); if (program.return !== undefined) checkValue(program.return, { k: 'any' }, 'return', new Map(Array.from(ids).map((i) => [i, types.get(i) || 'any'])));
        if (opts.allowEffects) for (const e of effects) if (!opts.allowEffects.includes(e)) errors.push('副作用 ' + e + ' 不在允許的範圍內');
        return { ok: !errors.length, errors, warnings, effects: Cat.EFFECTS.filter((e) => effects.has(e)), inputs, steps: count };
    }

    // ===== 直譯器 =====
    // host: { invoke(unit, args, ctx) → Promise<結果>, confirm?(info) → Promise<boolean>, now?() }。opts: { effectsNeedConfirm?: [...], dryRun?, isCancelled?, onStep?, maxCalls?, stepMs?, wallMs? }
    async function run(program, inputs, catalog, host, opts) {
        opts = opts || {}; const units = Array.isArray(catalog) ? catalog : catalog.units; const byId = new Map(units.map((u) => [u.id, u]));
        const v = validate(program, units, opts); if (!v.ok) return { ok: false, stage: 'validate', errors: v.errors, warnings: v.warnings, trace: [], effects: v.effects };
        const inp = {}; for (const [k, d] of Object.entries(program.inputs || {})) { const val = inputs && k in inputs ? inputs[k] : (d && d.default); if (val === undefined) return { ok: false, stage: 'inputs', errors: ['缺少輸入 ' + k], warnings: v.warnings, trace: [], effects: v.effects }; if (d && d.type && !literalFits(val, d.type)) return { ok: false, stage: 'inputs', errors: ['輸入 ' + k + ' 不是 ' + d.type], warnings: v.warnings, trace: [], effects: v.effects }; inp[k] = val; }
        const vars = {}; const trace = []; let calls = 0; const t0 = Date.now(); const maxCalls = opts.maxCalls || LIMITS.calls, wall = opts.wallMs || LIMITS.wallMs, stepMs = opts.stepMs || LIMITS.stepMs; const confirmFx = new Set(opts.effectsNeedConfirm || []);
        const clip = (x) => { let s; try { s = JSON.stringify(x); } catch (_) { s = String(x); } return s === undefined ? 'undefined' : (s.length > LIMITS.resultChars ? s.slice(0, LIMITS.resultChars) + '…(' + s.length + ')' : s); };
        function evalV(x, item) {
            if (!isRefObj(x)) return x; if ('$in' in x) return inp[x.$in];
            if ('$ref' in x) { const segs = parsePath(x.$ref); const sid = segs.shift(); return getPath(vars[sid], segs); } if ('$item' in x) return getPath(item, parsePath(x.$item));
            if ('$list' in x) return x.$list.map((y) => evalV(y, item)); if ('$obj' in x) { const o = {}; for (const [k, y] of Object.entries(x.$obj)) o[k] = evalV(y, item); return o; }
        }
        const stop = (r) => Object.assign({ warnings: v.warnings, trace, effects: v.effects, calls, ms: Date.now() - t0 }, r);
        async function exec(steps, item) {
            for (const s of steps) {
                if (opts.isCancelled && opts.isCancelled()) return { ok: false, stage: 'cancelled', errors: ['已停止'] }; if (Date.now() - t0 > wall) return { ok: false, stage: 'timeout', errors: ['整個程式超過 ' + Math.round(wall / 1000) + ' 秒'] };
                if (s.call) {
                    const u = byId.get(s.call); const args = {}; for (const [k, x] of Object.entries(s.args || {})) args[k] = evalV(x, item); if (++calls > maxCalls) return { ok: false, stage: 'budget', errors: ['呼叫次數超過上限 ' + maxCalls] };
                    const needConfirm = u.effects.some((e) => confirmFx.has(e)); const rec = { step: s.id, call: s.call, args: clip(args), effects: u.effects };
                    if (opts.dryRun) { rec.dry = true; trace.push(rec); vars[s.id] = null; continue; }
                    if (needConfirm && host.confirm) { const okc = await host.confirm({ step: s.id, unit: u, args }); if (!okc) { rec.denied = true; trace.push(rec); return { ok: false, stage: 'denied', errors: ['使用者沒有同意步驟 ' + s.id + '（' + s.call + '，副作用 ' + u.effects.join('、') + '）'] }; } }
                    const t1 = Date.now(); let timer = null; try {
                        const res = await Promise.race([host.invoke(u, args, { step: s.id }), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('TIMEOUT')), stepMs); })]); clearTimeout(timer);
                        if (res && typeof res === 'object' && res.ok === false && res.error) { rec.error = String(res.error).slice(0, 300); rec.ms = Date.now() - t1; trace.push(rec); vars[s.id] = res; if (s.onError === 'continue') continue; return { ok: false, stage: 'step', errors: ['步驟 ' + s.id + '（' + s.call + '）失敗：' + rec.error] }; }
                        vars[s.id] = res; rec.result = clip(res); rec.ms = Date.now() - t1; trace.push(rec);
                    } catch (e) { clearTimeout(timer); rec.error = String((e && e.message) || e).slice(0, 300); rec.ms = Date.now() - t1; trace.push(rec); if (s.onError === 'continue') { vars[s.id] = { ok: false, error: rec.error }; continue; } return { ok: false, stage: rec.error === 'TIMEOUT' ? 'timeout' : 'step', errors: ['步驟 ' + s.id + '（' + s.call + '）' + (rec.error === 'TIMEOUT' ? '逾時' : '失敗：' + rec.error)] }; }
                } else if (s.if !== undefined) {
                    const c = evalV(s.if, item); const branch = c ? s.then : (s.else || []); trace.push({ step: s.id, if: clip(c), took: c ? 'then' : 'else' }); vars[s.id] = !!c; const r = await exec(branch, item); if (r) return r;
                } else if (s.each !== undefined) {
                    const arr = evalV(s.each, item); const max = s.max === undefined ? LIMITS.each : s.max; if (!Array.isArray(arr)) return { ok: false, stage: 'step', errors: ['步驟 ' + s.id + '：each 的來源不是清單（' + clip(arr).slice(0, 60) + '）'] };
                    const out = []; const n = Math.min(arr.length, max); if (arr.length > max) trace.push({ step: s.id, note: '清單有 ' + arr.length + ' 個，只做前 ' + max + ' 個' }); trace.push({ step: s.id, each: n });
                    for (let i = 0; i < n; i++) { const r = await exec(s.do, arr[i]); if (r) return r; const last = s.do.length ? s.do[s.do.length - 1].id : null; out.push(last ? vars[last] : null); } vars[s.id] = out;
                }
            }
            return null;
        }
        const r = await exec(program.steps, undefined); if (r) return stop(r);
        return stop({ ok: true, result: program.return !== undefined ? evalV(program.return) : (program.steps.length ? vars[program.steps[program.steps.length - 1].id] : null), vars: opts.keepVars ? vars : undefined });
    }

    // ===== 從型別接線的路徑（matrix_core.findPipelines 的結果）產生程式：前一步的輸出欄位接到下一步的參數，其他必填參數變成有型別的輸入 =====
    function fromPath(pathObj, catalog) {
        const units = Array.isArray(catalog) ? catalog : catalog.units; const byId = new Map(units.map((u) => [u.id, u])); const program = { version: 1, inputs: {}, steps: [] };
        pathObj.units.forEach((id, i) => {
            const u = byId.get(id); const sid = 's' + (i + 1); const args = {}; const via = i > 0 ? pathObj.via[i - 1] : null; const taken = via ? via.param : (pathObj.start || null);
            for (const p of u.params) {
                if (p.name === taken) { args[p.name] = i === 0 ? { $in: p.name } : { $ref: 's' + i + (via.out && via.out !== '$' ? '.' + via.out : '') }; if (i === 0) program.inputs[p.name] = { type: p.type }; continue; }
                if (!p.required) continue; const nm = (program.inputs[p.name] ? sid + '_' : '') + p.name; program.inputs[nm] = { type: p.type }; args[p.name] = { $in: nm };
            }
            program.steps.push({ id: sid, call: id, args });
        });
        program.return = { $ref: 's' + pathObj.units.length }; return program;
    }
    // 給人與模型看的簡短文字
    function toText(program) {
        const val = (x) => (isRefObj(x) ? ('$in' in x ? '輸入.' + x.$in : ('$ref' in x ? x.$ref : ('$item' in x ? '項目' + (x.$item ? '.' + x.$item : '') : (JSON.stringify(x))))) : JSON.stringify(x));
        const lines = []; (function w(steps, ind) { for (const s of steps) { if (s.call) lines.push(ind + s.id + ' = ' + s.call.replace(/^[a-z]+:/, '') + '(' + Object.entries(s.args || {}).map(([k, x]) => k + '=' + val(x)).join(', ') + ')'); else if (s.if !== undefined) { lines.push(ind + s.id + ': 如果 ' + val(s.if)); w(s.then || [], ind + '  '); if (s.else) { lines.push(ind + '否則'); w(s.else, ind + '  '); } } else if (s.each !== undefined) { lines.push(ind + s.id + ': 對 ' + val(s.each) + ' 的每一項（最多 ' + (s.max || LIMITS.each) + '）'); w(s.do || [], ind + '  '); } } })(program.steps, '');
        return (Object.keys(program.inputs || {}).length ? '輸入：' + Object.entries(program.inputs).map(([k, d]) => k + ':' + ((d && d.type) || 'any')).join('、') + '\n' : '') + lines.join('\n') + (program.return !== undefined ? '\n回傳 ' + val(program.return) : '');
    }

    return { LIMITS, validate, run, fromPath, toText, parsePath, getPath, typeAtPath, literalFits };
});
