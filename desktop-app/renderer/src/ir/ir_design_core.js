/* 抽回設計：核心 IR → 設計（函式簽名、呼叫關係、標準操作用量、每個函式的語意摘要、副作用、資料流）→ UML 模型（uml_core 形狀）；
 * 以及對設計的編修（改名、改參數／回傳型別）回寫到 IR——之後交給各語言「出」重新產生程式碼。純函式 UMD，語言中立。
 *   extract(ir) → { module, entry, functions:[…], callGraph:[[from,to]], stdUsage:{op:[fn…]}, effects:[…] }
 *   toUmlModel(design, {moduleName}) → uml_core 模型（單一類別放模組層函式，使用案例＝入口的呼叫順序）
 *   applyEdit(ir, edit) → { ok, ir, errors }   edit: {kind:'rename_function'|'set_param_type'|'set_return'|'add_param', …} */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js')); else root.FaIrDesign = factory(root.FaIr, root.FaIrOps); })(typeof self !== 'undefined' ? self : this, function (IR, OPS) {
    'use strict';
    const EFFECT_WORDS = [['標準輸入', '讀標準輸入'], ['標準輸出', '寫標準輸出'], ['讀檔', '讀檔'], ['覆寫檔案', '寫檔'], ['時鐘', '讀時鐘'], ['亂數', '亂數'], ['就地', '就地修改參數或變數']];
    function effectsOf(op) { const o = OPS.get(op); if (!o) return []; const out = []; const sem = o.sem || ''; EFFECT_WORDS.forEach((w) => { if (sem.indexOf(w[0]) >= 0) out.push(w[1]); }); return out; }
    function typeName(t) { return t ? IR.tyStr(t) : '未標註'; }

    function extract(ir) {
        const fns = IR.funcs(ir); const names = {}; fns.forEach((f) => { names[f.name] = true; });
        const functions = [], callGraph = [], stdUsage = {}, effects = {};
        fns.forEach((f) => {
            const calls = {}, std = {}, eff = {}; let loops = 0, branches = 0, returns = 0, natives = 0;
            IR.walkStmts(f.body, (s) => { if (s.k === 'while' || s.k === 'forrange' || s.k === 'foreach') loops++; if (s.k === 'if') branches++; if (s.k === 'ret') returns++; if (s.k === 'native') natives++; });
            IR.eachExpr(f.body, (e) => {
                if (e.k === 'call' && e.fn && names[e.fn]) calls[e.fn] = (calls[e.fn] || 0) + 1;
                if (e.k === 'call' && e.op) { std[e.op] = (std[e.op] || 0) + 1; effectsOf(e.op).forEach((x) => { eff[x] = 1; }); (stdUsage[e.op] = stdUsage[e.op] || {})[f.name] = 1; }
                if (e.k === 'native') natives++;
            });
            // 巢狀迴圈深度
            let maxDepth = 0; (function dive(body, d) { (body || []).forEach((s) => { const isLoop = s.k === 'while' || s.k === 'forrange' || s.k === 'foreach'; if (isLoop) { maxDepth = Math.max(maxDepth, d + 1); dive(s.body, d + 1); } else { ['then', 'else', 'body'].forEach((k) => dive(s[k], d)); } }); })(f.body, 0);
            const info = {
                name: f.name, params: (f.params || []).map((p) => ({ name: p.name, type: typeName(p.ty) })), returns: typeName(f.ret), doc: f.doc || '', comment: [(f.c && f.c.a) || ''].concat((f.body[0] && f.body[0].c && f.body[0].c.b) || []).filter(Boolean),
                calls: Object.keys(calls), std: Object.keys(std).map((op) => ({ op, count: std[op], sem: (OPS.get(op) || {}).sem || '' })), effects: Object.keys(eff), pure: !Object.keys(eff).length && !natives,
                loops, branches, loopDepth: maxDepth, natives, pos: f.pos || null
            };
            const eq = (fields) => fields.filter(Boolean).join('；');
            info.summary = eq([
                '函式 ' + f.name + '(' + info.params.map((p) => p.name + ': ' + p.type).join(', ') + ') → ' + info.returns,
                info.doc ? '說明：' + info.doc : '',
                info.std.length ? '用到標準操作：' + info.std.map((s) => s.op + (s.count > 1 ? '×' + s.count : '')).join('、') : '沒有用到標準操作',
                info.calls.length ? '呼叫：' + info.calls.join('、') : '',
                loops || branches ? '含 ' + loops + ' 個迴圈（最深 ' + maxDepth + ' 層）、' + branches + ' 個分支' : '直線程式',
                info.effects.length ? '副作用：' + info.effects.join('、') : '無副作用（純函式）',
                natives ? '有 ' + natives + ' 處原生區塊（未翻譯）' : ''
            ]);
            Object.keys(calls).forEach((c) => callGraph.push([f.name, c])); info.effects.forEach((x) => { effects[x] = 1; });
            functions.push(info);
        });
        const usage = {}; Object.keys(stdUsage).forEach((op) => { usage[op] = Object.keys(stdUsage[op]); });
        return { module: ir.name, entry: ir.entry || null, functions, callGraph, stdUsage: usage, effects: Object.keys(effects) };
    }

    // IR 型別 → uml_core 的型別 {base,args}
    function umlType(t) {
        if (!t || t.t === 'unknown') return { base: 'any', args: [] };
        const m = { int: 'int', float: 'float', str: 'str', bool: 'bool', void: 'void', any: 'any' };
        if (m[t.t]) return { base: m[t.t], args: [] };
        const nm = { list: 'List', dict: 'Map', set: 'Set', tuple: 'List' }[t.t]; return { base: nm, args: (t.a || []).map(umlType) };
    }
    const PASCAL = (s) => String(s).replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (m, a, b) => b.toUpperCase()).replace(/^[^A-Za-z]+/, '') || 'Module';
    function toUmlModel(design, opts, ir) {
        const cls = PASCAL((opts && opts.moduleName) || design.module);
        const fnIR = {}; if (ir) IR.funcs(ir).forEach((f) => { fnIR[f.name] = f; });
        const ops = design.functions.map((f) => {
            const src = fnIR[f.name];
            return { name: f.name, params: f.params.map((p, i) => ({ name: p.name, type: umlType(src && src.params[i] && src.params[i].ty) })), returns: umlType(src && src.ret), visibility: '+', static: true, steps: [f.summary], doc: f.doc || f.summary };
        });
        const steps = []; if (design.entry) { const e = design.functions.find((f) => f.name === design.entry); if (e) e.calls.forEach((c) => steps.push({ from: 'User', to: cls, msg: c, args: [], returns: '' })); }
        // 入口沒有呼叫本檔的其他函式：使用案例就是「使用者呼叫入口」這一步（DSL 要求使用案例至少一步）；沒有入口就不放使用案例，不憑空編
        if (!steps.length && design.entry) steps.push({ from: 'User', to: cls, msg: design.entry, args: [], returns: '' });
        return { name: cls, actors: ['User'], classes: [{ name: cls, kind: 'class', attrs: [], ops, values: [] }], relations: [], usecases: steps.length ? [{ name: design.entry || 'main', actor: 'User', steps }] : [] };
    }

    // ---- 編修設計 → 回寫 IR ----
    function applyEdit(ir0, edit) {
        const ir = IR.clone(ir0); const errors = []; const fn = (n) => IR.funcs(ir).find((f) => f.name === n);
        const mapCalls = (fnName, fnNew) => IR.eachExpr(ir.body, (e) => { if (e.k === 'call' && e.fn === fnName) e.fn = fnNew; });
        switch (edit && edit.kind) {
            case 'rename_function': {
                const f = fn(edit.from); if (!f) { errors.push('找不到函式 ' + edit.from); break; } if (fn(edit.to)) { errors.push('已經有函式 ' + edit.to); break; } if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(edit.to || '')) { errors.push('名稱不合法：' + edit.to); break; }
                f.name = edit.to; mapCalls(edit.from, edit.to); if (ir.entry === edit.from) ir.entry = edit.to; break;
            }
            case 'set_return': { const f = fn(edit.fn); if (!f) { errors.push('找不到函式 ' + edit.fn); break; } f.ret = IR.tyParse(edit.type); break; }
            case 'set_param_type': { const f = fn(edit.fn); const p = f && f.params.find((x) => x.name === edit.param); if (!p) { errors.push('找不到參數 ' + edit.fn + '.' + edit.param); break; } p.ty = IR.tyParse(edit.type); break; }
            case 'add_param': {
                const f = fn(edit.fn); if (!f) { errors.push('找不到函式 ' + edit.fn); break; } if (edit.default == null) { errors.push('新增參數必須給預設值（否則既有的呼叫會壞）'); break; }
                // 目標語言不一定有預設參數（Java、C 都沒有）→ 在每個呼叫處明確補上預設值，簽名不帶預設
                f.params.push({ name: edit.name, ty: IR.tyParse(edit.type) }); IR.eachExpr(ir.body, (e) => { if (e.k === 'call' && e.fn === edit.fn) e.args.push(IR.clone(edit.default)); }); break;
            }
            default: errors.push('不認得的編修：' + (edit && edit.kind));
        }
        if (errors.length) return { ok: false, ir: ir0, errors };
        const v = IR.validate(ir, { ops: { has: OPS.has } }); if (!v.ok) return { ok: false, ir: ir0, errors: v.errors };
        return { ok: true, ir, errors: [] };
    }
    // ---- UML 模型的差異（uml_edit 編修前後）→ IR 編修 ----
    // 刪掉一個操作＝刪函式（還有人呼叫就拒絕並說明）；新增一個操作＝加一個函式骨架（body 是「待實作」原生區塊，之後交寫程式管線補）；
    // 改名在 UML 是「刪＋加」，這裡以「參數與型別完全相同、名稱不同」推斷為改名，推斷不出就當刪加。
    function modelOps(model) { const out = {}; (model.classes || []).forEach((c) => (c.ops || []).forEach((o) => { out[o.name] = o; })); return out; }
    const sigOf = (o) => (o.params || []).map((p) => p.name + ':' + JSON.stringify(p.type)).join(',') + '->' + JSON.stringify(o.returns);
    function diffModels(before, after) {
        const a = modelOps(before), b = modelOps(after), added = Object.keys(b).filter((n) => !a[n]), removed = Object.keys(a).filter((n) => !b[n]); const renamed = [];
        removed.slice().forEach((r) => { const m = added.find((n) => sigOf(b[n]) === sigOf(a[r])); if (m) { renamed.push({ from: r, to: m }); added.splice(added.indexOf(m), 1); removed.splice(removed.indexOf(r), 1); } });
        return { added, removed, renamed };
    }
    function applyModelDiff(ir0, before, after) {
        const d = diffModels(before, after); let ir = IR.clone(ir0); const errors = [], log = [];
        d.renamed.forEach((r) => { const x = applyEdit(ir, { kind: 'rename_function', from: r.from, to: r.to }); if (x.ok) { ir = x.ir; log.push('改名 ' + r.from + ' → ' + r.to); } else errors.push(x.errors.join(';')); });
        d.removed.forEach((n) => {
            const callers = []; IR.funcs(ir).forEach((f) => { if (f.name !== n) IR.eachExpr(f.body, (e) => { if (e.k === 'call' && e.fn === n && callers.indexOf(f.name) < 0) callers.push(f.name); }); });
            if (callers.length) { errors.push('不能刪除 ' + n + '：還被 ' + callers.join('、') + ' 呼叫'); return; } ir.body = ir.body.filter((s) => !(s.k === 'func' && s.name === n)); if (ir.entry === n) ir.entry = undefined; log.push('刪除函式 ' + n);
        });
        const bo = modelOps(after);
        d.added.forEach((n) => {
            const o = bo[n]; const back = (t) => { if (!t || t.base === 'any') return IR.T.unknown; const m = { int: 'int', float: 'float', str: 'str', bool: 'bool', void: 'void' }[t.base]; if (m) return { t: m }; const g = { List: 'list', Map: 'dict', Set: 'set' }[t.base]; return g ? { t: g, a: (t.args || []).map(back) } : IR.T.unknown; };
            ir.body.push({ k: 'func', name: n, params: (o.params || []).map((p) => ({ name: p.name, ty: back(p.type) })), ret: back(o.returns), doc: o.doc || undefined, body: [{ k: 'native', lang: 'todo', src: '待實作：' + n, why: '由設計新增的函式骨架，尚無內容' }] }); log.push('新增函式骨架 ' + n);
        });
        if (errors.length) return { ok: false, ir: ir0, errors, log };
        const v = IR.validate(ir, { ops: { has: OPS.has } }); return v.ok ? { ok: true, ir, errors: [], log } : { ok: false, ir: ir0, errors: v.errors, log };
    }
    return { extract, toUmlModel, applyEdit, diffModels, applyModelDiff, umlType, effectsOf };
});
