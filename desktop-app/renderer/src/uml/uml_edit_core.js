/* UML 編修（FaUmlEdit）：反思或決策的結論 → 對 UML 的具體編修（補哪裡、刪哪裡）→ 程式套用並驗證 → 交給重建。
 *
 *   ① ops：一組小而封閉的編修指令（add/remove actor、class、member、relation、usecase、step，rename_class），可以直接寫成 JSON。
 *   ② apply：一個一個套用，每個之後都跑 normalize／validate；讓模型多出新錯誤的那一個會被退回並說明原因（不會悄悄壞掉）。
 *   ③ candidates：從「問題」（design_core.findIssues 的項目，或反思的結論）算出幾個候選編修（程式），
 *      choose 把它變成選擇題給小模型挑一個編號；模型挑不出來就用程式的預設（第一個）。
 *   ④ diff：編修前後差在哪（給使用者看，也給重建用）。
 * 純函式（UMD）；模型（generate）是注入的。
 */
(function (root, factory) {
    const R = (typeof FaRecipe !== 'undefined' && FaRecipe) || (root && root.FaRecipe) || (typeof require === 'function' ? require('../recipe/recipe_core.js') : null);
    const U = (typeof FaUml !== 'undefined' && FaUml) || (root && root.FaUml) || (typeof require === 'function' ? require('./uml_core.js') : null);
    const D = (typeof FaDesign !== 'undefined' && FaDesign) || (root && root.FaDesign) || (typeof require === 'function' ? require('./design_core.js') : null);
    if (typeof module === 'object' && module.exports) module.exports = factory(R, U, D);
    else root.FaUmlEdit = factory(R, U, D);
})(typeof self !== 'undefined' ? self : this, function (R, U, D) {
    'use strict';

    const OPS = ['add_actor', 'remove_actor', 'add_class', 'remove_class', 'rename_class', 'add_member', 'remove_member', 'add_relation', 'remove_relation', 'add_usecase', 'remove_usecase', 'add_step', 'remove_step'];
    const REL_KINDS = ['assoc', 'inherit', 'implement', 'compose', 'aggregate', 'depend'];
    const clone = (m) => JSON.parse(JSON.stringify(m));
    const cls = (m, n) => m.classes.find((c) => c.name === n);

    // 'pay(amount:float):bool' 或 'total:float' → { kind:'op'|'attr', op|attr }；讀不出來回傳 { error }
    function parseMemberText(text) {
        const t = String(text || '').trim(); if (!t) return { error: '成員是空的' };
        const r = U.parseDsl('model: T\nclass X { ' + t.replace(/[{}]/g, '') + ' }');
        if (r.errors.length) return { error: r.errors[0].msg };
        const c = r.model.classes[0]; if (!c) return { error: '讀不出成員：' + t };
        if (c.ops.length) return { kind: 'op', op: c.ops[0] };
        if (c.attrs.length) return { kind: 'attr', attr: c.attrs[0] };
        return { error: '讀不出成員：' + t };
    }
    // 'Order.pay(x)' 或 'Order.pay(x):bool' → 步驟（from 由 normalize 接起來）
    function parseStepText(text) {
        const sm = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)\s*(?:\((.*)\))?\s*(?::\s*(.+))?$/.exec(String(text || '').trim());
        if (!sm) return null;
        return { from: '', to: sm[1], msg: sm[2], args: sm[3] ? sm[3].split(',').map((x) => x.trim()).filter(Boolean) : [], returns: sm[4] ? sm[4].trim() : '' };
    }
    const stepText = (s) => s.to + '.' + s.msg + '(' + (s.args || []).join(',') + ')';

    function fail(msg) { return { ok: false, msg }; }
    function good(msg) { return { ok: true, msg }; }

    // 套用單一編修（直接改 model）；回傳 { ok, msg }
    function applyOne(model, e) {
        if (!e || OPS.indexOf(e.op) < 0) return fail('不認得的編修：' + (e && e.op));
        const needStr = (k) => typeof e[k] === 'string' && e[k].trim();
        switch (e.op) {
            case 'add_actor': {
                if (!needStr('name')) return fail('add_actor 需要 name');
                if (model.actors.includes(e.name)) return good('參與者 ' + e.name + ' 已存在（略過）');
                model.actors.push(e.name.trim()); return good('新增參與者 ' + e.name);
            }
            case 'remove_actor': {
                if (!model.actors.includes(e.name)) return fail('沒有這個參與者：' + e.name);
                if (model.usecases.some((u) => u.actor === e.name)) return fail('還有使用案例由 ' + e.name + ' 發起，先刪使用案例');
                model.actors = model.actors.filter((a) => a !== e.name); return good('刪除參與者 ' + e.name);
            }
            case 'add_class': {
                if (!needStr('name')) return fail('add_class 需要 name');
                if (!U.CLASS_NAME.test(e.name)) return fail('類別名稱要是英文 PascalCase：' + e.name);
                if (cls(model, e.name)) return good('類別 ' + e.name + ' 已存在（略過）');
                const c = { name: e.name, kind: ['class', 'interface', 'enum', 'abstract'].indexOf(e.kind) >= 0 ? e.kind : 'class', attrs: [], ops: [], values: [] };
                for (const mt of [].concat(e.members || [])) { const pm = parseMemberText(mt); if (pm.error) return fail('成員「' + mt + '」：' + pm.error); if (pm.kind === 'op') c.ops.push(pm.op); else c.attrs.push(pm.attr); }
                model.classes.push(c); return good('新增類別 ' + e.name);
            }
            case 'remove_class': {
                if (!cls(model, e.name)) return fail('沒有這個類別：' + e.name);
                model.classes = model.classes.filter((c) => c.name !== e.name); return good('刪除類別 ' + e.name + '（相關關係與呼叫由程式一併收拾）');
            }
            case 'rename_class': {
                if (!cls(model, e.from)) return fail('沒有這個類別：' + e.from);
                if (!needStr('to') || !U.CLASS_NAME.test(e.to)) return fail('新名稱要是英文 PascalCase：' + e.to);
                if (cls(model, e.to)) return fail('已經有叫 ' + e.to + ' 的類別');
                cls(model, e.from).name = e.to;
                const fixT = (t) => { if (!t) return; if (t.base === e.from) t.base = e.to; (t.args || []).forEach(fixT); };
                for (const c of model.classes) { c.attrs.forEach((a) => fixT(a.type)); c.ops.forEach((o) => { fixT(o.returns); o.params.forEach((p) => fixT(p.type)); }); }
                for (const r of model.relations) { if (r.from === e.from) r.from = e.to; if (r.to === e.from) r.to = e.to; }
                for (const u of model.usecases) { if (u.actor === e.from) u.actor = e.to; for (const s of u.steps) { if (s.to === e.from) s.to = e.to; if (s.from === e.from) s.from = e.to; } }
                return good('類別 ' + e.from + ' 改名為 ' + e.to);
            }
            case 'add_member': {
                const c = cls(model, e.cls); if (!c) return fail('沒有這個類別：' + e.cls);
                const pm = parseMemberText(e.member); if (pm.error) return fail(pm.error);
                if (pm.kind === 'op') { if (c.ops.some((o) => o.name === pm.op.name)) return good(e.cls + '.' + pm.op.name + ' 已存在（略過）'); c.ops.push(pm.op); return good('新增操作 ' + e.cls + '.' + pm.op.name); }
                if (c.attrs.some((a) => a.name === pm.attr.name)) return good(e.cls + '.' + pm.attr.name + ' 已存在（略過）'); c.attrs.push(pm.attr); return good('新增屬性 ' + e.cls + '.' + pm.attr.name);
            }
            case 'remove_member': {
                const c = cls(model, e.cls); if (!c) return fail('沒有這個類別：' + e.cls);
                const na = c.attrs.length, no = c.ops.length;
                c.attrs = c.attrs.filter((a) => a.name !== e.name); c.ops = c.ops.filter((o) => o.name !== e.name);
                if (c.attrs.length === na && c.ops.length === no) return fail(e.cls + ' 沒有成員 ' + e.name);
                return good('刪除成員 ' + e.cls + '.' + e.name + (c.ops.length < no ? '（用到它的呼叫步驟由程式一併收拾）' : ''));
            }
            case 'add_relation': {
                if (!cls(model, e.from) || !cls(model, e.to)) return fail('關係的兩端都要是已知類別：' + e.from + ' → ' + e.to);
                const kind = REL_KINDS.indexOf(e.kind) >= 0 ? e.kind : 'assoc';
                if (model.relations.some((r) => r.from === e.from && r.to === e.to && r.kind === kind)) return good('關係已存在（略過）');
                const r = { from: e.from, to: e.to, kind }; if (e.mult) r.mult = e.mult; model.relations.push(r); return good('新增關係 ' + e.from + ' ' + kind + ' ' + e.to);
            }
            case 'remove_relation': {
                const n = model.relations.length;
                model.relations = model.relations.filter((r) => !(r.from === e.from && r.to === e.to && (!e.kind || r.kind === e.kind)));
                return n === model.relations.length ? fail('沒有這條關係：' + e.from + ' → ' + e.to) : good('刪除關係 ' + e.from + ' → ' + e.to);
            }
            case 'add_usecase': {
                if (!needStr('name')) return fail('add_usecase 需要 name');
                if (model.usecases.some((u) => u.name === e.name)) return fail('已經有同名使用案例：' + e.name);
                if (!needStr('actor')) return fail('add_usecase 需要 actor');
                if (!model.actors.includes(e.actor) && !cls(model, e.actor)) model.actors.push(e.actor);
                const steps = []; for (const st of [].concat(e.steps || [])) { const s = parseStepText(st); if (!s) return fail('呼叫格式要是 類別.操作(參數)：' + st); steps.push(s); }
                model.usecases.push({ name: e.name.trim(), actor: e.actor, steps }); return good('新增使用案例「' + e.name + '」（' + steps.length + ' 步）');
            }
            case 'remove_usecase': {
                const n = model.usecases.length; model.usecases = model.usecases.filter((u) => u.name !== e.name);
                return n === model.usecases.length ? fail('沒有這個使用案例：' + e.name) : good('刪除使用案例「' + e.name + '」');
            }
            case 'add_step': {
                const u = model.usecases.find((x) => x.name === e.usecase); if (!u) return fail('沒有這個使用案例：' + e.usecase);
                const s = parseStepText(e.step); if (!s) return fail('呼叫格式要是 類別.操作(參數)：' + e.step);
                const at = Number.isInteger(e.at) ? Math.max(0, Math.min(u.steps.length, e.at)) : u.steps.length;
                u.steps.splice(at, 0, s); return good('「' + e.usecase + '」第 ' + (at + 1) + ' 步加入 ' + stepText(s));
            }
            case 'remove_step': {
                const u = model.usecases.find((x) => x.name === e.usecase); if (!u) return fail('沒有這個使用案例：' + e.usecase);
                let i = Number.isInteger(e.at) ? e.at : u.steps.findIndex((s) => (!e.to || s.to === e.to) && (!e.msg || s.msg === e.msg));
                if (i < 0 || i >= u.steps.length) return fail('「' + e.usecase + '」找不到要刪的步驟');
                const [gone] = u.steps.splice(i, 1); return good('「' + e.usecase + '」刪除第 ' + (i + 1) + ' 步 ' + stepText(gone));
            }
        }
        return fail('不認得的編修');
    }

    // 套用一組編修。回傳 { model, applied:[{op,msg}], rejected:[{op,msg}], normalized:[...], errors:[...] }
    // 每一個編修之後都 normalize 並比較驗證錯誤：讓模型多出新錯誤的編修會被退回（opts.strict === false 時只回報不退回）
    function apply(model, ops, opts) {
        opts = opts || {}; const strict = opts.strict !== false;
        let cur = clone(model); const applied = [], rejected = [], normalized = [];
        let baseErrs = new Set(U.validateModel(cur));
        for (const e of [].concat(ops || [])) {
            const trial = clone(cur); const r = applyOne(trial, e);
            if (!r.ok) { rejected.push({ op: e, msg: r.msg }); continue; }
            const log = D.normalize(trial); const errs = U.validateModel(trial); const fresh = errs.filter((x) => !baseErrs.has(x));
            if (strict && fresh.length) { rejected.push({ op: e, msg: r.msg + ' → 會造成新的錯誤，已退回：' + fresh[0] }); continue; }
            cur = trial; baseErrs = new Set(errs); applied.push({ op: e, msg: r.msg }); for (const l of log) normalized.push(l);
        }
        return { model: cur, applied, rejected, normalized, errors: U.validateModel(cur) };
    }

    // 編修前後差在哪（文字條列）
    function diff(a, b) {
        const out = []; const names = (m) => m.classes.map((c) => c.name);
        const na = new Set(names(a)), nb = new Set(names(b));
        for (const n of nb) if (!na.has(n)) out.push('＋類別 ' + n); for (const n of na) if (!nb.has(n)) out.push('－類別 ' + n);
        for (const n of nb) if (na.has(n)) {
            const ca = cls(a, n), cb = cls(b, n); const mem = (c) => new Set(c.attrs.map((x) => x.name).concat(c.ops.map((o) => o.name + '()')));
            const ma = mem(ca), mb = mem(cb); for (const x of mb) if (!ma.has(x)) out.push('＋成員 ' + n + '.' + x); for (const x of ma) if (!mb.has(x)) out.push('－成員 ' + n + '.' + x);
        }
        const rk = (r) => r.from + ' ' + r.kind + ' ' + r.to; const ra = new Set(a.relations.map(rk)), rb = new Set(b.relations.map(rk));
        for (const x of rb) if (!ra.has(x)) out.push('＋關係 ' + x); for (const x of ra) if (!rb.has(x)) out.push('－關係 ' + x);
        const ua = new Map(a.usecases.map((u) => [u.name, u])), ub = new Map(b.usecases.map((u) => [u.name, u]));
        for (const [n, u] of ub) { if (!ua.has(n)) out.push('＋使用案例「' + n + '」'); else { const sa = ua.get(n).steps.map(stepText).join('>'), sb = u.steps.map(stepText).join('>'); if (sa !== sb) out.push('～使用案例「' + n + '」的呼叫順序變了（' + ua.get(n).steps.length + ' → ' + u.steps.length + ' 步）'); } }
        for (const n of ua.keys()) if (!ub.has(n)) out.push('－使用案例「' + n + '」');
        const aa = new Set(a.actors), ab = new Set(b.actors); for (const x of ab) if (!aa.has(x)) out.push('＋參與者 ' + x); for (const x of aa) if (!ab.has(x)) out.push('－參與者 ' + x);
        return out;
    }

    // ---------- 從問題算候選編修（程式）----------
    // issue 是 design_core.findIssues 的項目，或反思的結論：
    //   { kind:'missing_capability', need:'語音合成', cls?:'Speech', op?:'speak(text:str)', usecase?, } → 補類別／成員／步驟
    //   { kind:'unneeded_step', usecase, to, msg }                                                    → 刪步驟（或保留）
    // 每個候選：{ id, label, ops:[...], default?:true }；一定包含「不改」，讓模型有退路
    function candidates(model, issue) {
        const out = []; const keep = { id: 'keep', label: '不改，維持現狀', ops: [] };
        const k = issue && issue.kind;
        if (k === 'orphan') {
            const n = (issue.region || '').replace(/^class:/, '') || issue.cls;
            out.push({ id: 'remove', label: '刪掉類別 ' + n + '（沒人用它）', ops: [{ op: 'remove_class', name: n }], default: true });
            const other = model.classes.find((c) => c.name !== n && c.kind === 'class');
            if (other) out.push({ id: 'relate', label: '把 ' + n + ' 接到 ' + other.name + '（加一條關係）', ops: [{ op: 'add_relation', from: other.name, to: n, kind: 'assoc' }] });
            out.push(keep);
        } else if (k === 'empty') {
            const n = (issue.region || '').replace(/^class:/, '') || issue.cls;
            out.push({ id: 'remove', label: '刪掉類別 ' + n + '（空的）', ops: [{ op: 'remove_class', name: n }], default: true });
            if (issue.member) out.push({ id: 'fill', label: '替 ' + n + ' 補上 ' + issue.member, ops: [{ op: 'add_member', cls: n, member: issue.member }] });
            out.push(keep);
        } else if (k === 'short_sequence') {
            const n = (issue.region || '').replace(/^usecase:/, '') || issue.usecase;
            out.push({ id: 'remove', label: '刪掉使用案例「' + n + '」（太短）', ops: [{ op: 'remove_usecase', name: n }] });
            if (issue.step) out.push({ id: 'extend', label: '替「' + n + '」補一步 ' + issue.step, ops: [{ op: 'add_step', usecase: n, step: issue.step }], default: true });
            out.push(keep);
        } else if (k === 'missing_capability') {
            const c = issue.cls || 'Helper', ops = [];
            if (!cls(model, c)) ops.push({ op: 'add_class', name: c, members: issue.op ? [issue.op] : [] });
            else if (issue.op) ops.push({ op: 'add_member', cls: c, member: issue.op });
            if (issue.usecase && issue.op) { const nm = /^([A-Za-z_]\w*)/.exec(issue.op); if (nm) ops.push({ op: 'add_step', usecase: issue.usecase, at: issue.at, step: c + '.' + nm[1] + '(' + (issue.args || []).join(',') + ')' }); }
            out.push({ id: 'add', label: '補上「' + (issue.need || c) + '」：' + (ops.length ? ops.map((o) => o.op === 'add_class' ? '類別 ' + o.name : o.op === 'add_member' ? '成員 ' + o.member : '一個呼叫步驟').join('、') : '無'), ops, default: true });
            out.push(keep);
        } else if (k === 'unneeded_step') {
            out.push({ id: 'remove', label: '刪掉「' + issue.usecase + '」裡的 ' + issue.to + '.' + issue.msg, ops: [{ op: 'remove_step', usecase: issue.usecase, to: issue.to, msg: issue.msg }], default: true });
            out.push(keep);
        } else if (k === 'god_class') {
            out.push(keep); out.__note = '責任太多的類別要拆開，需要重做那一區（reworkRegion），不是單一編修';
        } else out.push(keep);
        return out;
    }

    function chooseMessages(model, issue, cands) {
        const lines = cands.map((c, i) => (i + 1) + '. ' + c.label).join('\n');
        const desc = String((issue && (issue.msg || issue.need || issue.kind)) || '').slice(0, 200);
        return [{ role: 'system', content: '你在修改一份 UML 設計。只輸出一個 JSON 物件，格式：{"choice": 編號}。編號只能是選單裡有的數字。' },
            { role: 'user', content: '問題：' + desc + '\n選單：\n' + lines }];
    }
    // 小模型從候選裡挑一個；挑不出來就用程式的預設（標了 default 的，沒有就第一個）
    async function choose(model, issue, cands, opts) {
        opts = opts || {}; const def = cands.findIndex((c) => c.default); const defIdx = def >= 0 ? def : 0;
        if (cands.length === 1 || !opts.generate) return { index: defIdx, cand: cands[defIdx], by: 'program' };
        const n = cands.length;
        const r = await R.jsonStep({ generate: opts.generate, messages: chooseMessages(model, issue, cands), maxTokens: 40, maxTries: opts.maxTries || 2, prefill: '{"choice":', validate: (o) => (Number.isInteger(o.choice) && o.choice >= 1 && o.choice <= n ? [] : ['「choice」必須是 1～' + n + ' 之間的整數']) });
        if (!r.ok) return { index: defIdx, cand: cands[defIdx], by: 'program', rejected: r.rejected };
        return { index: r.value.choice - 1, cand: cands[r.value.choice - 1], by: 'model', tries: r.tries };
    }

    // 一次處理一批問題：每個問題 → 候選 → 選 → 套用。回傳 { model, steps:[{issue,choice,applied,rejected}], diff, applied, rejected }
    async function resolve(model, issues, opts) {
        opts = opts || {}; let cur = clone(model); const steps = [];
        for (const issue of [].concat(issues || [])) {
            const cands = candidates(cur, issue); const ch = await choose(cur, issue, cands, opts);
            const r = apply(cur, ch.cand.ops, opts); cur = r.model;
            steps.push({ issue, choice: ch.cand.id, label: ch.cand.label, by: ch.by, applied: r.applied, rejected: r.rejected });
        }
        return { model: cur, steps, diff: diff(model, cur), applied: steps.reduce((n, s) => n + s.applied.length, 0), rejected: steps.reduce((n, s) => n + s.rejected.length, 0) };
    }

    return { OPS, REL_KINDS, parseMemberText, parseStepText, applyOne, apply, diff, candidates, chooseMessages, choose, resolve };
});
