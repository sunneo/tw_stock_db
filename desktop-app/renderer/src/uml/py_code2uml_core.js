/* Python：程式碼 → tree-sitter → UML（含指令層級的敘述樹 body）→ 程式碼。純函式 UMD，Python 專屬（每個語言各自一份，不共用）。
 * 輸入的節點是 tree-sitter（web-tree-sitter 或 node-tree-sitter）的節點：type、children、namedChildren、childForFieldName、text。
 *
 *   fromTree(rootNode, {moduleName}) → { model, coverage:{stmts, raws, rawKinds} }
 *     model 是 uml_core 的模型形狀（actors／classes／relations／usecases），再加：
 *       model.prelude : [S]   模組層的敘述（import、常數、其他）
 *       class.ops[i].body : [S]  操作內部的敘述樹（指令層級）；op.params[i].default／kind；op.static
 *       名為 moduleName（預設 Module）的類別放模組層函式（static 操作）
 *   toPython(model) → 原始碼
 *
 * 敘述 S：assign{t,v} aug{t,op,v} expr{e} if{c,a,b} for{t,i,a,b} while{c,a} ret{e} break cont pass def{name,ps,a} raw{src}
 * 運算式 E：name int float str const call attr idx slice bin un cmp bool not cond list tuple set dict comp lambda star dstar kw raw
 * 沒有轉成結構的語法（try／with／import…）收成 raw（保留原文），coverage.raws 會如實計數——那是指令層級還沒到的地方。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaPyCode2Uml = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ANY = { base: 'any', args: [] };
    function fromTree(rootNode, opts) {
        const src = String((opts && opts.source) || ''); const modName = String((opts && opts.moduleName) || 'Module').replace(/(^|[^A-Za-z0-9]+)([A-Za-z0-9])/g, (m, a, b) => b.toUpperCase()).replace(/^[^A-Za-z]+/, '') || 'Module'; const cov = { stmts: 0, raws: 0, rawKinds: {} };
        const txt = (n) => (n.text != null ? n.text : src.slice(n.startIndex, n.endIndex));
        const named = (n) => (n.namedChildren || n.children.filter((c) => c.isNamed())).filter((c) => c.type !== 'comment');
        const f = (n, name) => n.childForFieldName(name);
        const raw = (n, kind) => { cov.raws++; cov.rawKinds[kind || n.type] = (cov.rawKinds[kind || n.type] || 0) + 1; const t = txt(n); const col = n.startPosition ? n.startPosition.column : 0; const lines = t.split('\n').map((l, i) => (i === 0 ? l : l.slice(Math.min(col, l.length - l.trimStart().length)))); return { src: lines.join('\n') }; };
        const rawE = (n) => Object.assign({ n: 'raw' }, raw(n));
        const tokensBetween = (n, a, b) => { const out = []; for (const c of n.children) { if (c.startIndex >= a.endIndex && c.endIndex <= b.startIndex && !c.isNamed()) out.push(c.type); } return out; };
        function expr(n) {
            if (!n) return null; const t = n.type;
            switch (t) {
                case 'identifier': return { n: 'name', v: txt(n) };
                case 'integer': return { n: 'int', v: txt(n) };
                case 'float': return { n: 'float', v: txt(n) };
                case 'string': return { n: 'str', v: txt(n) };
                case 'concatenated_string': return { n: 'str', v: named(n).map(txt).join(' ') };
                case 'true': case 'false': case 'none': return { n: 'const', v: txt(n) };
                case 'parenthesized_expression': { const k = named(n); return k.length === 1 ? expr(k[0]) : rawE(n); }
                case 'call': { const fn = expr(f(n, 'function')); const a = f(n, 'arguments'); const args = []; if (a && a.type === 'argument_list') for (const c of named(a)) args.push(c.type === 'keyword_argument' ? { n: 'kw', k: txt(f(c, 'name')), v: expr(f(c, 'value')) } : expr(c)); else if (a) args.push(expr(a)); return { n: 'call', f: fn, a: args }; }
                case 'attribute': return { n: 'attr', o: expr(f(n, 'object')), a: txt(f(n, 'attribute')) };
                case 'subscript': { const k = named(n); const v = f(n, 'value'); return { n: 'idx', o: expr(v), i: k.filter((c) => c.id !== v.id && c.startIndex !== v.startIndex).map(expr) }; }
                case 'slice': { const parts = [[], [], []]; let p = 0; for (const c of n.children) { if (!c.isNamed() && c.type === ':') p++; else if (c.isNamed()) parts[p].push(expr(c)); } return { n: 'slice', lo: parts[0][0] || null, hi: parts[1][0] || null, st: p >= 2 ? (parts[2][0] || null) : undefined }; }
                case 'binary_operator': return { n: 'bin', op: txt(f(n, 'operator')), l: expr(f(n, 'left')), r: expr(f(n, 'right')) };
                case 'unary_operator': return { n: 'un', op: txt(f(n, 'operator')), e: expr(f(n, 'argument')) };
                case 'not_operator': return { n: 'not', e: expr(f(n, 'argument')) };
                case 'boolean_operator': return { n: 'bool', op: txt(f(n, 'operator')), l: expr(f(n, 'left')), r: expr(f(n, 'right')) };
                case 'comparison_operator': { const xs = named(n); const ops = []; for (let i = 0; i + 1 < xs.length; i++) { const toks = tokensBetween(n, xs[i], xs[i + 1]); let o = toks.join(' '); const h = toks.length; if (h === 2 && toks[0] === toks[1] && / /.test(toks[0])) o = toks[0]; ops.push(o); } return { n: 'cmp', ops, xs: xs.map(expr) }; }
                case 'conditional_expression': { const k = named(n); return { n: 'cond', a: expr(k[0]), c: expr(k[1]), b: expr(k[2]) }; }
                case 'list': return { n: 'list', xs: named(n).map(expr) };
                case 'tuple': case 'expression_list': case 'pattern_list': case 'tuple_pattern': return { n: 'tuple', xs: named(n).map(expr) };
                case 'list_pattern': return { n: 'list', xs: named(n).map(expr) };
                case 'set': return { n: 'set', xs: named(n).map(expr) };
                case 'dictionary': return { n: 'dict', ps: named(n).map((c) => (c.type === 'pair' ? { k: expr(f(c, 'key')), v: expr(f(c, 'value')) } : null)) };
                case 'list_comprehension': case 'set_comprehension': case 'generator_expression': case 'dictionary_comprehension': {
                    const body = f(n, 'body'); const cl = named(n).filter((c) => c.type === 'for_in_clause' || c.type === 'if_clause').map((c) => (c.type === 'if_clause' ? { if: expr(named(c)[0]) } : { t: expr(f(c, 'left')), i: expr(f(c, 'right')), async: /^async/.test(txt(c)) }));
                    const kind = t === 'list_comprehension' ? 'list' : t === 'set_comprehension' ? 'set' : t === 'generator_expression' ? 'gen' : 'dict';
                    if (kind === 'dict') return { n: 'comp', kind, k: expr(f(body, 'key')), v: expr(f(body, 'value')), cl }; return { n: 'comp', kind, e: expr(body), cl };
                }
                case 'lambda': { const ps = f(n, 'parameters'); return { n: 'lambda', ps: ps ? named(ps).map(param) : [], e: expr(f(n, 'body')) }; }
                case 'ellipsis': return { n: 'const', v: '...' };
                case 'await': return { n: 'await', e: expr(named(n)[0]) };
                case 'yield': { const k = named(n); const fr = /^yield\s+from\b/.test(txt(n)); return { n: 'yield', e: k.length ? (k.length === 1 ? expr(k[0]) : { n: 'tuple', xs: k.map(expr) }) : null, from: fr }; }
                case 'named_expression': return { n: 'walrus', t: txt(f(n, 'name')), v: expr(f(n, 'value')) };
                case 'list_splat': return { n: 'star', e: expr(named(n)[0]) };
                case 'dictionary_splat': return { n: 'dstar', e: expr(named(n)[0]) };
                case 'list_splat_pattern': return { n: 'star', e: expr(named(n)[0]) };
                default: return rawE(n);
            }
        }
        function param(c) {
            const t = c.type; if (t === 'identifier') return { name: txt(c), type: ANY };
            if (t === 'default_parameter') return { name: txt(f(c, 'name')), type: ANY, default: expr(f(c, 'value')) };
            if (t === 'typed_parameter') return { name: txt(named(c)[0]), type: ANY, annotation: txt(f(c, 'type')) };
            if (t === 'typed_default_parameter') return { name: txt(f(c, 'name')), type: ANY, annotation: txt(f(c, 'type')), default: expr(f(c, 'value')) };
            if (t === 'list_splat_pattern') return { name: txt(named(c)[0]), type: ANY, kind: '*' };
            if (t === 'dictionary_splat_pattern') return { name: txt(named(c)[0]), type: ANY, kind: '**' };
            return { name: txt(c), type: ANY, kind: 'raw' };
        }
        function block(n) { if (!n) return []; const out = []; for (const c of named(n)) for (const s of stmt(c)) out.push(s); return out; }
        function stmt(n) {
            cov.stmts++; const t = n.type;
            if (t === 'expression_statement') { const k = named(n); if (k.length !== 1) return [Object.assign({ k: 'raw' }, raw(n))]; const e = k[0];
                if (e.type === 'assignment') { // a = b = c（右邊只算一次）；有型別註解的先收成 raw
                    if (f(e, 'type')) { const r0 = f(e, 'right'); if (r0 && r0.type === 'assignment') return [Object.assign({ k: 'raw' }, raw(n))]; return [{ k: 'ann', t: expr(f(e, 'left')), ty: txt(f(e, 'type')), v: r0 ? expr(r0) : null }]; }
                    const lefts = []; let cur = e, rhs = null; for (;;) { lefts.push(f(cur, 'left')); const r = f(cur, 'right'); if (r && r.type === 'assignment' && !f(r, 'type')) { cur = r; continue; } rhs = r; break; }
                    if (!rhs) return [Object.assign({ k: 'raw' }, raw(n))];
                    return [{ k: 'assign', t: expr(lefts[0]), ts: lefts.length > 1 ? lefts.map(expr) : undefined, v: expr(rhs) }];
                }
                if (e.type === 'augmented_assignment') return [{ k: 'aug', t: expr(f(e, 'left')), op: txt(f(e, 'operator')).replace(/=$/, ''), v: expr(f(e, 'right')) }];
                return [{ k: 'expr', e: expr(e) }]; }
            if (t === 'return_statement') { const k = named(n); return [{ k: 'ret', e: k.length ? (k.length === 1 ? expr(k[0]) : { n: 'tuple', xs: k.map(expr) }) : null }]; }
            if (t === 'pass_statement') return [{ k: 'pass' }]; if (t === 'break_statement') return [{ k: 'break' }]; if (t === 'continue_statement') return [{ k: 'cont' }];
            if (t === 'if_statement') {
                const node = { k: 'if', c: expr(f(n, 'condition')), a: block(f(n, 'consequence')), b: [] }; let tail = node.b; const alts = named(n).filter((c) => c.type === 'elif_clause' || c.type === 'else_clause');
                for (const c of alts) { if (c.type === 'elif_clause') { const sub = { k: 'if', c: expr(f(c, 'condition')), a: block(f(c, 'consequence')), b: [] }; tail.push(sub); tail = sub.b; } else tail.push(...block(f(c, 'body'))); } return [node];
            }
            if (t === 'for_statement') { const alt = named(n).find((c) => c.type === 'else_clause'); return [{ k: 'for', t: expr(f(n, 'left')), i: expr(f(n, 'right')), a: block(f(n, 'body')), b: alt ? block(f(alt, 'body')) : [] }]; }
            if (t === 'while_statement') { const alt = named(n).find((c) => c.type === 'else_clause'); return [{ k: 'while', c: expr(f(n, 'condition')), a: block(f(n, 'body')), b: alt ? block(f(alt, 'body')) : [] }]; }
            if (t === 'assert_statement') { const k = named(n); return [{ k: 'assert', c: expr(k[0]), m: k[1] ? expr(k[1]) : null }]; }
            if (t === 'raise_statement') { const k = named(n); const fr = f(n, 'cause'); const e = k.find((c) => !fr || c.startIndex !== fr.startIndex); return [{ k: 'raise', e: e ? expr(e) : null, cause: fr ? expr(fr) : null }]; }
            if (t === 'global_statement' || t === 'nonlocal_statement') return [{ k: 'global', kind: t === 'global_statement' ? 'global' : 'nonlocal', names: named(n).map(txt) }];
            if (t === 'delete_statement') { const k = named(n); const x = k.length === 1 && k[0].type === 'expression_list' ? named(k[0]) : k; return [{ k: 'del', es: x.map(expr) }]; }
            if (t === 'try_statement') {
                const node = { k: 'try', a: block(f(n, 'body')), h: [], els: [], fin: [] };
                for (const c of named(n)) {
                    if (c.type === 'except_clause' || c.type === 'except_group_clause') { const kids = named(c); const bl = kids[kids.length - 1]; const first = kids.length > 1 ? kids[0] : null; let ty = null, as = null; if (first) { if (first.type === 'as_pattern') { ty = expr(named(first)[0]); const al = f(first, 'alias') || named(first)[1]; as = al ? txt(al) : null; } else ty = expr(first); } node.h.push({ ty, as, star: c.type === 'except_group_clause', a: block(bl) }); }
                    else if (c.type === 'else_clause') node.els = block(f(c, 'body')); else if (c.type === 'finally_clause') node.fin = block(named(c)[0]);
                } return [node];
            }
            if (t === 'with_statement') { const wc = named(n).find((c) => c.type === 'with_clause'); const items = []; for (const it of wc ? named(wc) : []) { const v = it.type === 'with_item' ? f(it, 'value') : it; if (v && v.type === 'as_pattern') { const al = f(v, 'alias') || named(v)[1]; items.push({ e: expr(named(v)[0]), as: al ? expr(al.type === 'as_pattern_target' ? named(al)[0] : al) : null }); } else items.push({ e: expr(v), as: null }); } return [{ k: 'with', async: /^async\b/.test(txt(n)), items, a: block(f(n, 'body')) }]; }
            if (t === 'class_definition') { const sup = f(n, 'superclasses'); return [{ k: 'class', name: txt(f(n, 'name')), bases: sup ? named(sup).map((c) => (c.type === 'keyword_argument' ? { n: 'kw', k: txt(f(c, 'name')), v: expr(f(c, 'value')) } : expr(c))) : [], a: block(f(n, 'body')) }]; }
            if (t === 'decorated_definition') { const inner = stmt(f(n, 'definition'))[0]; inner.dec = named(n).filter((c) => c.type === 'decorator').map((c) => expr(named(c)[0])); cov.stmts--; return [inner]; }
            if (t === 'import_statement' || t === 'import_from_statement') { const mod = f(n, 'module_name'); const names = named(n).filter((c) => c !== mod && (!mod || c.startIndex !== mod.startIndex)).map((c) => (c.type === 'aliased_import' ? { name: txt(f(c, 'name')), as: txt(f(c, 'alias')) } : { name: txt(c) })); const wild = named(n).some((c) => c.type === 'wildcard_import'); return [{ k: 'import', from: mod ? txt(mod) : null, names: wild ? [{ name: '*' }] : names }]; }
            if (t === 'function_definition') return [{ k: 'def', name: txt(f(n, 'name')), async: /^async\b/.test(txt(n)), ret: f(n, 'return_type') ? txt(f(n, 'return_type')) : undefined, ps: named(f(n, 'parameters')).map(param), a: block(f(n, 'body')) }];
            return [Object.assign({ k: 'raw' }, raw(n))];
        }
        // ---- UML 組裝 ----
        const model = { name: modName, actors: ['User'], classes: [], relations: [], usecases: [], prelude: [], order: [] };
        const mod = { name: modName, kind: 'class', attrs: [], ops: [], values: [] }; const classNames = new Set(); const fnNames = new Set();
        const unwrap = (c) => (c.type === 'decorated_definition' ? { node: f(c, 'definition'), dec: named(c).filter((x) => x.type === 'decorator').map((x) => expr(named(x)[0])) } : { node: c, dec: [] });
        const top = named(rootNode).map((c) => { const u = unwrap(c); u.node._dec = u.dec; return u.node; });
        for (const c of top) { if (c.type === 'class_definition') classNames.add(txt(f(c, 'name'))); if (c.type === 'function_definition') fnNames.add(txt(f(c, 'name'))); }
        const isStaticDec = (c) => (c._dec || []).some((d) => d.n === 'name' && d.v === 'staticmethod');
        const mkOp = (c, isStatic) => ({ name: txt(f(c, 'name')), async: /^async\b/.test(txt(c)), dec: c._dec || [], ret: f(c, 'return_type') ? txt(f(c, 'return_type')) : undefined, params: named(f(c, 'parameters')).map(param).filter((p) => !(p.name === 'self' && !isStatic)), returns: ANY, visibility: '+', static: !!isStatic, body: block(f(c, 'body')) });
        for (const c of top) {
            if (c.type === 'function_definition') { const o = mkOp(c, true); mod.ops.push(o); model.order.push({ t: 'f', o }); }
            else if (c.type === 'class_definition') {
                const name = txt(f(c, 'name')); const cls = { name, kind: 'class', attrs: [], ops: [], values: [], dec: c._dec || [] }; const sup = f(c, 'superclasses');
                if (sup) for (const b of named(sup)) { const bn = txt(b); if (classNames.has(bn)) model.relations.push({ from: name, to: bn, kind: 'inherit', label: '' }); else cls.extern = (cls.extern || []).concat([bn]); }
                for (const m0 of named(f(c, 'body') || { namedChildren: [], children: [] })) { const um = unwrap(m0); const m = um.node; m._dec = um.dec;
                    if (m.type === 'function_definition') { const op = mkOp(m, isStaticDec(m)); cls.ops.push(op); (cls.order = cls.order || []).push({ t: 'o', o: op }); }
                    else if (m.type === 'expression_statement' && named(m)[0] && named(m)[0].type === 'assignment' && f(named(m)[0], 'left').type === 'identifier' && !f(named(m)[0], 'type') && f(named(m)[0], 'right').type !== 'assignment') { const l = f(named(m)[0], 'left'); const at = { name: txt(l), type: ANY, visibility: '+', static: true, default: txt(f(named(m)[0], 'right')) }; cls.attrs.push(at); (cls.order = cls.order || []).push({ t: 'a', a: at }); }
                    else { const ss = stmt(m0); cls.classBody = (cls.classBody || []).concat(ss); for (const x of ss) (cls.order = cls.order || []).push({ t: 's', s: x }); }
                }
                const init = cls.ops.find((o) => o.name === '__init__'); const seen = new Set();
                for (const o of cls.ops) walkS(o.body, (s) => { if (s.k === 'assign' && s.t.n === 'attr' && s.t.o.n === 'name' && s.t.o.v === 'self' && !seen.has(s.t.a)) { seen.add(s.t.a); cls.attrs.push({ name: s.t.a, type: ANY, visibility: '+', static: false }); } });
                model.classes.push(cls); model.order.push({ t: 'c', c: cls });
            } else for (const s of stmt(c)) { model.prelude.push(s); model.order.push({ t: 's', s }); }
        }
        model.classes.unshift(mod);
        // 依賴與使用案例（從 main 的呼叫順序）
        for (const o of mod.ops.concat(...model.classes.map((c) => c.ops))) walkE(o.body, (e) => { if (e.n === 'call' && e.f.n === 'name' && classNames.has(e.f.v)) { const owner = ownerOf(o); if (owner && owner !== e.f.v && !model.relations.some((r) => r.from === owner && r.to === e.f.v && r.kind === 'depend')) model.relations.push({ from: owner, to: e.f.v, kind: 'depend', label: '' }); } });
        function ownerOf(op) { for (const c of model.classes) if (c.ops.includes(op)) return c.name; return null; }
        const main = mod.ops.find((o) => o.name === 'main');
        if (main) { const steps = []; let prev = 'User'; walkE(main.body, (e) => { if (e.n !== 'call' || e.f.n !== 'name') return; const nm = e.f.v; if (fnNames.has(nm)) { steps.push({ from: prev, to: modName, msg: nm, args: [], returns: '' }); prev = modName; } else if (classNames.has(nm)) { steps.push({ from: prev, to: nm, msg: '__init__', args: [], returns: '' }); prev = nm; } }); model.usecases.push({ name: 'main', actor: 'User', steps }); }
        return { model, coverage: cov };
    }
    // 走訪：先序，依原始碼順序
    function walkS(list, fn) { for (const s of list || []) { fn(s); walkS(s.a, fn); walkS(s.b, fn); walkS(s.els, fn); walkS(s.fin, fn); for (const h of s.h || []) walkS(h.a, fn); } }
    function walkE(list, fn) {
        const E = (e) => { if (!e || typeof e !== 'object') return; if (Array.isArray(e)) return e.forEach(E); if (e.n) { for (const k of ['f', 'o', 'l', 'r', 'e', 'c', 'a', 'b', 'lo', 'hi', 'st', 'k', 'v', 'i']) if (e[k] && typeof e[k] === 'object') E(e[k]); ['xs', 'ps', 'cl'].forEach((k) => { if (Array.isArray(e[k])) e[k].forEach((x) => x && E(x.k || x.v || x.t || x.i || x.if ? Object.assign({}, x, { n: 'box' }) : x)); }); if (e.n === 'call') { fn(e); } else fn(e); } else { for (const k of Object.keys(e)) if (e[k] && typeof e[k] === 'object') E(e[k]); } };
        const S = (l) => { for (const s of l || []) { for (const k of ['t', 'v', 'e', 'c', 'i']) if (s[k] && typeof s[k] === 'object') E(s[k]); S(s.a); S(s.b); } };
        // 為了保持原始碼順序：呼叫的外層先於引數內的呼叫
        const E2 = (e) => { if (!e || typeof e !== 'object') return; if (Array.isArray(e)) return e.forEach(E2); if (e.n === 'call') { fn(e); E2(e.f); E2(e.a); return; } if (e.n) fn(e); for (const k of Object.keys(e)) if (k !== 'n' && e[k] && typeof e[k] === 'object') E2(e[k]); };
        const S2 = (l) => { for (const s of l || []) { for (const k of ['t', 'v', 'e', 'c', 'i', 'm', 'cause']) if (s[k] && typeof s[k] === 'object' && !Array.isArray(s[k])) E2(s[k]); (s.es || []).forEach(E2); (s.items || []).forEach((it) => { E2(it.e); if (it.as) E2(it.as); }); S2(s.a); S2(s.b); S2(s.els); S2(s.fin); for (const h of s.h || []) { if (h.ty) E2(h.ty); S2(h.a); } } };
        void E; void S; S2(list);
    }

    // ---------- 回程 codegen：UML＋body → Python ----------
    const PREC = { lambda: 0, cond: 1, or: 2, and: 3, not: 4, cmp: 5, '|': 6, '^': 7, '&': 8, '<<': 9, '>>': 9, '+': 10, '-': 10, '*': 11, '/': 11, '//': 11, '%': 11, '@': 11, un: 12, '**': 13, post: 15, atom: 16 };
    function toPython(model) {
        const P = (e, min) => { const [s, p] = ex(e); return p < min ? '(' + s + ')' : s; };
        const args = (a) => a.map((x) => (x.n === 'kw' ? x.k + '=' + P(x.v, 1) : x.n === 'star' ? '*' + P(x.e, 5) : x.n === 'dstar' ? '**' + P(x.e, 5) : P(x, 1))).join(', ');
        const ps = (l) => l.map((p) => (p.kind === '*' ? '*' : p.kind === '**' ? '**' : '') + p.name + (p.annotation ? ': ' + p.annotation : '') + (p.default ? (p.annotation ? ' = ' : '=') + P(p.default, 1) : '')).join(', ');
        function ex(e) {
            switch (e.n) {
                case 'name': case 'int': case 'float': case 'str': case 'const': return [e.v, PREC.atom];
                case 'raw': return [e.src, PREC.lambda];
                case 'call': return [P(e.f, PREC.post) + '(' + args(e.a) + ')', PREC.post];
                case 'attr': return [(e.o.n === 'int' ? '(' + e.o.v + ')' : P(e.o, PREC.post)) + '.' + e.a, PREC.post];
                case 'idx': return [P(e.o, PREC.post) + '[' + e.i.map((x) => P(x, 1)).join(', ') + (e.i.length === 1 && e.i[0].n === 'tuple' ? '' : '') + ']', PREC.post];
                case 'slice': return [(e.lo ? P(e.lo, 1) : '') + ':' + (e.hi ? P(e.hi, 1) : '') + (e.st !== undefined ? ':' + (e.st ? P(e.st, 1) : '') : ''), PREC.atom];
                case 'bin': { const p = PREC[e.op]; const right = e.op === '**'; return [P(e.l, right ? p + 1 : p) + ' ' + e.op + ' ' + P(e.r, right ? p : p + 1), p]; }
                case 'un': return [e.op + P(e.e, PREC.un), PREC.un];
                case 'not': return ['not ' + P(e.e, PREC.not), PREC.not];
                case 'bool': { const p = PREC[e.op]; return [P(e.l, p) + ' ' + e.op + ' ' + P(e.r, p + 1), p]; }
                case 'cmp': return [e.xs.map((x, i) => P(x, PREC.cmp + 1) + (i < e.ops.length ? ' ' + e.ops[i] + ' ' : '')).join(''), PREC.cmp];
                case 'cond': return [P(e.a, PREC.cond + 1) + ' if ' + P(e.c, PREC.cond + 1) + ' else ' + P(e.b, PREC.cond), PREC.cond];
                case 'list': return ['[' + e.xs.map((x) => P(x, 1)).join(', ') + ']', PREC.atom];
                case 'tuple': return ['(' + e.xs.map((x) => P(x, 1)).join(', ') + (e.xs.length === 1 ? ',' : '') + ')', PREC.atom];
                case 'set': return ['{' + e.xs.map((x) => P(x, 1)).join(', ') + '}', PREC.atom];
                case 'dict': return ['{' + e.ps.map((x) => (x ? P(x.k, 1) + ': ' + P(x.v, 1) : '')).join(', ') + '}', PREC.atom];
                case 'comp': { const cl = e.cl.map((c) => (c.if ? ' if ' + P(c.if, PREC.cond + 1) : (c.async ? ' async' : '') + ' for ' + P(c.t, PREC.or) + ' in ' + P(c.i, PREC.or))).join(''); const body = e.kind === 'dict' ? P(e.k, 1) + ': ' + P(e.v, 1) : P(e.e, 1); const [o, c2] = e.kind === 'list' ? ['[', ']'] : e.kind === 'gen' ? ['(', ')'] : ['{', '}']; return [o + body + cl + c2, PREC.atom]; }
                case 'await': return ['await ' + P(e.e, PREC.post), 14];
                case 'yield': return ['yield' + (e.from ? ' from ' : e.e ? ' ' : '') + (e.e ? P(e.e, 1) : ''), PREC.lambda];
                case 'walrus': return [e.t + ' := ' + P(e.v, 1), PREC.lambda];
                case 'lambda': return ['lambda' + (e.ps.length ? ' ' + ps(e.ps) : '') + ': ' + P(e.e, 1), PREC.lambda];
                case 'star': return ['*' + P(e.e, 5), PREC.lambda]; case 'dstar': return ['**' + P(e.e, 5), PREC.lambda];
                default: return ['None', PREC.atom];
            }
        }
        const lines = [];
        const pad = (d) => '    '.repeat(d);
        function body(list, d) { if (!list || !list.length) { lines.push(pad(d) + 'pass'); return; } for (const s of list) st(s, d); }
        function st(s, d) {
            const I = pad(d);
            switch (s.k) {
                case 'assign': lines.push(I + (s.ts || [s.t]).map((x) => (x.n === 'tuple' && x.xs.length > 1 ? x.xs.map((y) => P(y, 1)).join(', ') : P(x, 1))).join(' = ') + ' = ' + P(s.v, 1)); break;
                case 'ann': lines.push(I + P(s.t, 1) + ': ' + s.ty + (s.v ? ' = ' + P(s.v, 1) : '')); break;
                case 'aug': lines.push(I + P(s.t, 1) + ' ' + s.op + '= ' + P(s.v, 1)); break;
                case 'expr': lines.push(I + P(s.e, 1)); break;
                case 'ret': lines.push(I + 'return' + (s.e ? ' ' + P(s.e, 1) : '')); break;
                case 'pass': lines.push(I + 'pass'); break; case 'break': lines.push(I + 'break'); break; case 'cont': lines.push(I + 'continue'); break;
                case 'if': { lines.push(I + 'if ' + P(s.c, 1) + ':'); body(s.a, d + 1); let b = s.b; while (b.length === 1 && b[0].k === 'if') { lines.push(I + 'elif ' + P(b[0].c, 1) + ':'); body(b[0].a, d + 1); b = b[0].b; } if (b.length) { lines.push(I + 'else:'); body(b, d + 1); } break; }
                case 'for': lines.push(I + 'for ' + (s.t.n === 'tuple' && s.t.xs.length > 1 ? s.t.xs.map((x) => P(x, 1)).join(', ') : P(s.t, 1)) + ' in ' + P(s.i, 1) + ':'); body(s.a, d + 1); if (s.b && s.b.length) { lines.push(I + 'else:'); body(s.b, d + 1); } break;
                case 'while': lines.push(I + 'while ' + P(s.c, 1) + ':'); body(s.a, d + 1); if (s.b && s.b.length) { lines.push(I + 'else:'); body(s.b, d + 1); } break;
                case 'assert': lines.push(I + 'assert ' + P(s.c, 1) + (s.m ? ', ' + P(s.m, 1) : '')); break;
                case 'raise': lines.push(I + 'raise' + (s.e ? ' ' + P(s.e, 1) : '') + (s.cause ? ' from ' + P(s.cause, 1) : '')); break;
                case 'global': lines.push(I + s.kind + ' ' + s.names.join(', ')); break;
                case 'del': lines.push(I + 'del ' + s.es.map((x) => P(x, 1)).join(', ')); break;
                case 'try': { lines.push(I + 'try:'); body(s.a, d + 1); for (const h of s.h) { lines.push(I + 'except' + (h.star ? '*' : '') + (h.ty ? ' ' + P(h.ty, 1) : '') + (h.as ? ' as ' + h.as : '') + ':'); body(h.a, d + 1); } if (s.els.length) { lines.push(I + 'else:'); body(s.els, d + 1); } if (s.fin.length) { lines.push(I + 'finally:'); body(s.fin, d + 1); } break; }
                case 'with': lines.push(I + (s.async ? 'async ' : '') + 'with ' + s.items.map((it) => P(it.e, 1) + (it.as ? ' as ' + P(it.as, 1) : '')).join(', ') + ':'); body(s.a, d + 1); break;
                case 'class': { for (const dd of s.dec || []) lines.push(I + '@' + P(dd, 1)); lines.push(I + 'class ' + s.name + (s.bases.length ? '(' + args(s.bases) + ')' : '') + ':'); body(s.a, d + 1); break; }
                case 'def': for (const dd of s.dec || []) lines.push(I + '@' + P(dd, 1)); lines.push(I + (s.async ? 'async ' : '') + 'def ' + s.name + '(' + ps(s.ps) + ')' + (s.ret ? ' -> ' + s.ret : '') + ':'); body(s.a, d + 1); break;
                case 'import': { const nm = s.names.map((x) => x.name + (x.as ? ' as ' + x.as : '')).join(', '); lines.push(I + (s.from ? 'from ' + s.from + ' import ' + nm : 'import ' + nm)); break; }
                case 'raw': for (const l of String(s.src).split('\n')) lines.push(I + l); break;
                default: lines.push(I + 'pass');
            }
        }
        const decs = (x, ind) => { for (const dd of x.dec || []) lines.push(ind + '@' + P(dd, 1)); };
        const emitF = (o) => { decs(o, ''); lines.push((o.async ? 'async ' : '') + 'def ' + o.name + '(' + ps(o.params) + ')' + (o.ret ? ' -> ' + o.ret : '') + ':'); body(o.body, 1); lines.push(''); };
        const bases = (c) => model.relations.filter((r) => r.from === c.name && r.kind === 'inherit').map((r) => r.to).concat(c.extern || []);
        const emitO = (o) => { const decNames = (o.dec || []).map((x) => (x.n === 'name' ? x.v : '')); decs(o, '    '); const needSelf = !o.static && !decNames.includes('classmethod'); lines.push('    ' + (o.async ? 'async ' : '') + 'def ' + o.name + '(' + ps((needSelf ? [{ name: 'self' }] : []).concat(o.params)) + ')' + (o.ret ? ' -> ' + o.ret : '') + ':'); body(o.body, 2); };
        const emitC = (c) => {
            const bs = bases(c); decs(c, ''); lines.push('class ' + c.name + (bs.length ? '(' + bs.join(', ') + ')' : '') + ':'); let any = false;
            if (c.order) { for (const it of c.order) { any = true; if (it.t === 'o') emitO(it.o); else if (it.t === 'a') lines.push('    ' + it.a.name + ' = ' + it.a.default); else st(it.s, 1); } }
            else { for (const a of c.attrs.filter((x) => x.static)) { lines.push('    ' + a.name + ' = ' + a.default); any = true; } for (const x of c.classBody || []) { st(x, 1); any = true; } for (const o of c.ops) { emitO(o); any = true; } }
            if (!any) lines.push('    pass'); lines.push('');
        };
        if (model.order && model.order.length) { for (const it of model.order) { if (it.t === 's') st(it.s, 0); else if (it.t === 'f') emitF(it.o); else emitC(it.c); } }
        else {
            for (const x of model.prelude || []) st(x, 0);
            const order = []; const seen = new Set(); const byName = {}; model.classes.forEach((c) => { byName[c.name] = c; });
            const visit = (c) => { if (seen.has(c.name)) return; seen.add(c.name); for (const b of bases(c)) if (byName[b]) visit(byName[b]); order.push(c); }; model.classes.forEach(visit);
            for (const c of order) { if (c.name === model.name && c.ops.every((o) => o.static)) { for (const o of c.ops) emitF(o); continue; } emitC(c); }
        }
        return lines.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
    }
    return { fromTree, toPython };
});
