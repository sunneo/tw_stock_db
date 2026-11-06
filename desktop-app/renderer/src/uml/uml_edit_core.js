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

    // 小模型常回字母（A／B）或加引號的數字：都接受，統一成 0 起算的索引；不合格回傳 -1
    function pickIndex(v, n) {
        let x = v && typeof v === 'object' ? v.choice : v;
        if (typeof x === 'string') { x = x.trim().replace(/["'.。、）)]/g, ''); if (/^[A-Za-z]$/.test(x)) x = x.toUpperCase().charCodeAt(0) - 64; else if (/^\d+$/.test(x)) x = Number(x); }
        return Number.isInteger(x) && x >= 1 && x <= n ? x - 1 : -1;
    }
    const LETTER = (i) => String.fromCharCode(65 + i);
    function chooseMessages(model, issue, cands) {
        const lines = cands.map((c, i) => LETTER(i) + '. ' + c.label).join('\n');
        const desc = String((issue && (issue.desc || (issue.kind === 'unneeded_step' ? '「' + issue.usecase + '」裡的 ' + issue.to + '.' + issue.msg + ' 可能不需要' : issue.msg) || issue.need || issue.kind)) || '').slice(0, 200);
        return [{ role: 'system', content: '你在修改一份 UML 設計。只輸出一個 JSON 物件，格式：{"choice": "字母"}，字母只能是選單裡有的（A、B、C…）。' },
            { role: 'user', content: '問題：' + desc + '\n選單：\n' + lines }];
    }
    // 小模型從候選裡挑一個；挑不出來就用程式的預設（標了 default 的，沒有就第一個）
    async function choose(model, issue, cands, opts) {
        opts = opts || {}; const def = cands.findIndex((c) => c.default); const defIdx = def >= 0 ? def : 0;
        if (cands.length === 1 || !opts.generate) return { index: defIdx, cand: cands[defIdx], by: 'program' };
        const n = cands.length;
        const r = await R.jsonStep({ generate: opts.generate, messages: chooseMessages(model, issue, cands), maxTokens: 40, maxTries: opts.maxTries || 2, prefill: '{"choice":', validate: (o) => (pickIndex(o, n) >= 0 ? [] : ['「choice」必須是選單裡的字母 A～' + LETTER(n - 1)]) });
        if (!r.ok) return { index: defIdx, cand: cands[defIdx], by: 'program', rejected: r.rejected };
        const pi = pickIndex(r.value, n); return { index: pi, cand: cands[pi], by: 'model', tries: r.tries };
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

    // ---------- 小窗口分段寫：一次只給一個「下一格」（DESIGN.think-stack.md、DESIGN.jsonl-paging.md）----------
    // 程式從目前的模型決定下一個該補的單位（參與者與使用案例 → 類別 → 每個空類別的成員 → 每個太短的使用案例 → 沒接上的類別），
    // 每格帶焦點標頭（目標、已定的、這格要做什麼）與兄弟已經用的命名（前後一致），模型只回這一格的 ops；apply 之後再問下一格。
    // 模型的窗口多小都做得完：它不需要記得整份設計，標頭每次由程式重組。
    const memberNames = (m) => [].concat(...m.classes.map((c) => [].concat((c.attrs || []).map((a) => a.name), (c.ops || []).map((o) => o.name))));
    function styleHint(m) {
        const names = memberNames(m).filter((n) => /^[A-Za-z_]/.test(n)); if (names.length < 2) return '';
        const k = (n) => (/_/.test(n) ? 'snake_case' : /^[a-z]+[A-Z]/.test(n) ? 'camelCase' : /^[A-Z]/.test(n) ? 'PascalCase' : '單字小寫'); const c = {}; names.forEach((n) => { const x = k(n); c[x] = (c[x] || 0) + 1; });
        const top = Object.entries(c).filter(([x]) => x !== '單字小寫').sort((a, b) => b[1] - a[1])[0]; const ex = names.filter((n) => top && k(n) === top[0]).slice(0, 3);
        return top ? '兄弟類別的成員用 ' + top[0] + '（例如 ' + ex.join('、') + '），照同樣的寫法' : '';
    }
    function nextUnit(model, opts) {
        const m = model || { actors: [], classes: [], usecases: [], relations: [] }; const classes = m.classes || [], ucs = m.usecases || [], rels = m.relations || [], actors = m.actors || [];
        const decided = [classes.length ? '類別：' + classes.map((c) => c.name).slice(0, 12).join('、') : '', ucs.length ? '使用案例：' + ucs.map((u) => u.name).slice(0, 10).join('、') : '', actors.length ? '參與者：' + actors.join('、') : ''].filter(Boolean).join('；');
        const total = { classes: classes.length, usecases: ucs.length };
        const mk = (unit, q, ex, why) => ({ done: false, unit, header: { goal: String((opts && opts.goal) || m.name || '把情境設計成 UML'), decided: decided || '（還沒有）', now: q }, question: q, answer_with: ex, why, style: styleHint(m) || undefined });
        if (!actors.length || !ucs.length) return mk('usecases', '列出參與者與使用案例（每個使用案例是參與者想完成的一件事）', { ops: [{ op: 'add_actor', name: 'Customer' }, { op: 'add_usecase', name: 'Checkout', actor: 'Customer', steps: [] }] }, '還沒有' + (!actors.length ? '參與者' : '使用案例'));
        if (!classes.length) return mk('classes', '列出系統需要的類別（名詞，PascalCase；先不用成員）', { ops: [{ op: 'add_class', name: 'Order', kind: 'class', members: [] }] }, '還沒有類別');
        const empty = classes.find((c) => c.kind !== 'enum' && !(c.attrs || []).length && !(c.ops || []).length);
        if (empty) return mk('class:' + empty.name, '替類別「' + empty.name + '」補上屬性與操作（2～5 個；只做這一個類別）', { ops: [{ op: 'add_member', cls: empty.name, member: 'total:float' }, { op: 'add_member', cls: empty.name, member: 'pay(amount:float):bool' }] }, '類別「' + empty.name + '」還是空的');
        const short = ucs.find((u) => (u.steps || []).length < 2);
        if (short) { const menu = [].concat(...classes.map((c) => (c.ops || []).slice(0, 4).map((o) => c.name + '.' + o.name))).slice(0, 14); return mk('usecase:' + short.name, '寫使用案例「' + short.name + '」（' + (short.actor || '') + '）的呼叫順序：至少 2 步，用已經有的類別與操作', { ops: [{ op: 'add_step', usecase: short.name, step: menu[0] || 'Order.pay(x)' }, { op: 'add_step', usecase: short.name, step: menu[1] || menu[0] || 'Order.pay(x)' }] }, '「' + short.name + '」只有 ' + (short.steps || []).length + ' 步（可用：' + (menu.join('、') || '還沒有操作') + '）'); }
        const used = new Set([].concat(...rels.map((r) => [r.from, r.to]), ...ucs.map((u) => (u.steps || []).map((s) => s.to))));
        const loose = classes.find((c) => c.kind !== 'enum' && !used.has(c.name)); if (loose && classes.length > 1) return mk('relation:' + loose.name, '類別「' + loose.name + '」沒有跟任何類別有關係、也沒被使用案例用到：接上一條關係，或刪掉它', { ops: [{ op: 'add_relation', from: classes.find((c) => c.name !== loose.name).name, to: loose.name, kind: 'assoc' }] }, '「' + loose.name + '」是孤立的');
        return { done: true, total, note: '每一格都補齊了；用 uml_edit({"auto_fix":true}) 再檢查一次問題，或 uml_to_code 產生程式骨架' };
    }

    return { nextUnit, styleHint, pickIndex, OPS, REL_KINDS, parseMemberText, parseStepText, applyOne, apply, diff, candidates, chooseMessages, choose, resolve };
});
