// ============================================================
// FaBeh2：Domain Resolver behavior_analyzer 的 JavaScript 移植（以 web-tree-sitter 的真正語法樹為基礎）。
// 對應 Python 原版：tools/behavior_tools.py（掃描）、langprofiles.py（各語言的語法樹詞彙）、linetrace_tools.py（逐行追蹤＋由下而上敘事）、
// callgraph_tools.py、dataflow_tools.py、apisemantics_tools.py、summarize_tools.py、designpattern_tools.py、bytecode_tools.py、idiom_tools.py。
// 設計要點（原版的原則，移植時保留）：事實由語法樹決定，不靠函式名稱猜；比對不到就不解釋；positive path 為主、guard 收成旁註。
// 檔案分成數段（engine_1_core … engine_N），由 scripts/embed-code-ui.js 接成同一個函式範圍、嵌進 floating-assistant.js（const FaBeh2 = (function(){ … return API; })()）。
// ============================================================
    // ---------- 語法樹節點的小工具（對應 Python 的 _node_text 等；web-tree-sitter 的位置是 UTF-16 索引，直接對字串切片）----------
    const T = (node, src) => src.slice(node.startIndex, node.endIndex);
    const kids = (n) => n.children || [];
    const firstKid = (n, type) => kids(n).find((c) => c.type === type) || null;
    const firstKidOf = (n, types) => kids(n).find((c) => types.has ? types.has(c.type) : types.indexOf(c.type) >= 0) || null;
    const row = (n) => n.startPosition.row;
    function collect(node, type, out) { if (node.type === type) out.push(node); for (const c of kids(node)) collect(c, type, out); }
    function collectTypes(node, types, out) { if (types.has(node.type)) out.push(node); for (const c of kids(node)) collectTypes(c, types, out); }
    function countTypes(node, types) { let n = types.has(node.type) ? 1 : 0; for (const c of kids(node)) n += countTypes(c, types); return n; }
    const S = (arr) => new Set(arr || []);
    const sorted = (it) => Array.from(it).sort();
    const uniq = (arr) => Array.from(new Set(arr));
    function descIdent(node, src, idTypes) { if (idTypes.has(node.type)) return T(node, src); for (const c of kids(node)) { const f = descIdent(c, src, idTypes); if (f) return f; } return null; }
    const unquote = (t) => (t.startsWith('"') && t.endsWith('"') && t.length >= 2 ? t.slice(1, -1) : t);

    // ---------- 分類表（taxonomy）----------
    // data：{patterns:<behavior_patterns>, api:<api_semantics>}；user：使用者補的定義（見 _faBehMerge）
    function makeTaxonomy(data, user) {
        const tx = JSON.parse(JSON.stringify(data.patterns));
        const api = JSON.parse(JSON.stringify(data.api || {}));
        if (user) {
            for (const [k, c] of Object.entries(user.categories || {})) {
                const t = tx.categories[k] = tx.categories[k] || { label: c.label || k, description: c.description || '', languages: {} };
                t.languages = t.languages || {};
                for (const [l, names] of Object.entries(c.languages || {})) t.languages[l] = uniq((t.languages[l] || []).concat(names));
            }
            for (const [l, fns] of Object.entries(user.api || {})) api[l] = Object.assign(api[l] || {}, fns);
            for (const [arch, cats] of Object.entries(user.mnemonics || {})) { tx.assembly_instruction_sets = tx.assembly_instruction_sets || {}; const set = tx.assembly_instruction_sets[arch] = tx.assembly_instruction_sets[arch] || {}; for (const [cat, rows] of Object.entries(cats || {})) set[cat] = (set[cat] || []).concat(rows); }
            tx.assembly_idioms = tx.assembly_idioms || {};
            for (const [a, list] of Object.entries(user.idioms || {})) tx.assembly_idioms[a] = (list || []).concat(tx.assembly_idioms[a] || []);
        }
        tx.__api = api; tx.__notes = (user && user.notes) || {};
        tx.__lookupCache = {};
        return tx;
    }
    // 語言鍵：'cpp' ＝ C 的表再疊上 C++ 標準函式庫（cpp）的表；'go' 的 pkg.Func 找不到時退回 .Func（任何接收者的方法）
    function withMethodFallback(m) {
        return new Proxy(m, { get(tg, k) { if (typeof k !== 'string' || k in tg) return tg[k]; const i = k.lastIndexOf('.'); if (i > 0) { const b = '.' + k.slice(i + 1); if (b in tg) return tg[b]; } return undefined; } });
    }
    function lookupFor(tx, language) {
        if (tx.__lookupCache[language]) return tx.__lookupCache[language];
        const m = Object.create(null); // 沒有原型：呼叫名稱 toString／constructor／valueOf 不能撞到 Object.prototype 的東西
        for (const lg of (language === 'cpp' ? ['c', 'cpp'] : [language])) for (const [cid, cat] of Object.entries(tx.categories || {})) for (const name of ((cat.languages || {})[lg] || [])) m[name] = cid;
        tx.__lookupCache[language] = language === 'go' ? withMethodFallback(m) : m; return tx.__lookupCache[language];
    }
    function apiFor(tx, language) {
        const a = tx.__api || {};
        if (language === 'cpp') return Object.assign(Object.create(null), a.c || {}, a.cpp || {});
        const m = Object.assign(Object.create(null), a[language] || {}); return language === 'go' ? withMethodFallback(m) : m;
    }
    function asmLookup(tx) {
        if (tx.__asm) return tx.__asm;
        const lk = {};
        for (const [arch, cats] of Object.entries(tx.assembly_instruction_sets || {})) for (const [cat, entries] of Object.entries(cats || {})) for (const e of (entries || [])) {
            const name = typeof e === 'object' ? e.name : e; const fmt = typeof e === 'object' ? (e.format || '') : ''; const desc = typeof e === 'object' ? (e.description || '') : '';
            if (name) (lk[String(name).toLowerCase()] = lk[String(name).toLowerCase()] || []).push([arch, cat, fmt, desc]);
        }
        tx.__asm = lk; return lk;
    }
    function lookupAsmMnemonic(lk, mnemonic) { const parts = mnemonic.split('.'); for (let i = parts.length; i > 0; i--) { const c = parts.slice(0, i).join('.'); if (lk[c]) return lk[c]; } return []; }

    // ---------- 組合語言助記符／idiom ----------
    const ASM_REP = S(['rep', 'repe', 'repz', 'repne', 'repnz', 'lock']);
    function extractAsmMnemonics(asmText) {
        const out = [];
        for (const raw of asmText.replace(/;/g, '\n').split(/\r?\n/)) {
            let line = raw.trim();
            if (!line || /^(#|\/\/|\/\*|\*)/.test(line)) continue;
            if (line.includes(':') && /^[A-Za-z0-9]+$/.test(line.split(':', 1)[0].trim().replace(/_/g, ''))) line = line.slice(line.indexOf(':') + 1).trim();
            if (!line) continue;
            const tokens = line.split(/\s+/); if (!tokens.length) continue;
            const token = tokens[0].replace(/^,+|,+$/g, '').toLowerCase();
            if (token) { out.push(token); if (ASM_REP.has(token) && tokens.length > 1) { const f = tokens[1].replace(/^,+|,+$/g, '').toLowerCase(); if (f) out.push(f); } }
        }
        return out;
    }
    function recognizeIdioms(mnemonics, patterns) {
        if (!patterns || !patterns.length || !mnemonics.length) return [];
        const ordered = patterns.slice().sort((a, b) => (b.pattern || []).length - (a.pattern || []).length);
        const matches = []; let i = 0; const n = mnemonics.length;
        while (i < n) {
            let hit = null;
            for (const e of ordered) { const p = e.pattern || []; if (!p.length || i + p.length > n) continue; if (mnemonics.slice(i, i + p.length).join('\u0001') === p.join('\u0001')) { hit = [e, p.length]; break; } }
            if (hit) { matches.push({ start_index: i, length: hit[1], name: hit[0].name, template: hit[0].template, matched_mnemonics: mnemonics.slice(i, i + hit[1]) }); i += hit[1]; } else i++;
        }
        return matches;
    }
    const ESC = { '\\n': '\n', '\\t': '\t', '\\\\': '\\', '\\"': '"' };
    function cStringLiteralText(node, src) {
        const parts = [];
        for (const c of kids(node)) { if (c.type === 'string_content') parts.push(T(c, src)); else if (c.type === 'escape_sequence') { const r = T(c, src); parts.push(ESC[r] !== undefined ? ESC[r] : r); } }
        if (parts.length) return parts.join('');
        let t = T(node, src); if (t.startsWith('"') && t.endsWith('"') && t.length >= 2) t = t.slice(1, -1); return t;
    }
    function cAsmTemplateText(asmNode, src) {
        const parts = [];
        for (const n of kids(asmNode)) { if (n.type === 'string_literal') parts.push(cStringLiteralText(n, src)); else if (n.type === 'concatenated_string') for (const c of kids(n)) if (c.type === 'string_literal') parts.push(cStringLiteralText(c, src)); }
        return parts.join('\n');
    }

    // ---------- 呼叫名稱／候選（各語言）----------
    function cCallName(callNode, src) {
        const func = kids(callNode)[0]; if (!func) return null;
        if (func.type === 'identifier') return T(func, src);
        if (func.type === 'field_expression') { const ks = kids(func); for (let i = ks.length - 1; i >= 0; i--) if (ks[i].type === 'field_identifier') return T(ks[i], src); }
        if (func.type === 'qualified_identifier' || func.type === 'template_function') { const t = T(func, src); return t.split('::').pop().replace(/<.*$/, ''); }
        return null;
    }
    function cFunctionName(fnNode, src) {
        const find = (n) => { if (n.type === 'function_declarator') return n; for (const c of kids(n)) { const f = find(c); if (f) return f; } return null; };
        const decl = find(fnNode); if (!decl) return null;
        for (const c of kids(decl)) { if (c.type === 'identifier') return T(c, src); if (c.type === 'qualified_identifier' || c.type === 'field_identifier' || c.type === 'destructor_name' || c.type === 'operator_name') return T(c, src).split('::').pop(); }
        return null;
    }
    function javaFunctionName(fnNode, src) { let saw = false, last = null; for (const c of kids(fnNode)) { if (c.type === 'formal_parameters') { saw = true; break; } if (c.type === 'identifier') last = c; } return saw && last ? T(last, src) : null; }
    function javaLeftmostIdent(node, src) { if (node.type === 'identifier') return T(node, src); const ks = kids(node); if (ks.length) return javaLeftmostIdent(ks[0], src); return null; }
    function javaTypeNameCandidates(typeNode, src) { let base = typeNode; if (base.type === 'generic_type') base = kids(base).find((c) => c.type === 'type_identifier' || c.type === 'scoped_type_identifier') || base; const full = T(base, src); if (base.type === 'scoped_type_identifier') { const parts = full.split('.'); if (parts.length > 1) return [full, parts[parts.length - 1]]; } return [full]; }
    function javaCallCandidates(callNode, src) {
        const ch = kids(callNode); const ai = ch.findIndex((c) => c.type === 'argument_list');
        if (callNode.type === 'object_creation_expression') { if (ai <= 0) return null; return javaTypeNameCandidates(ch[ai - 1], src); }
        if (ai <= 0) return null; const nameNode = ch[ai - 1]; if (nameNode.type !== 'identifier') return null;
        const method = T(nameNode, src); const receiver = ai >= 3 && ch[ai - 2].type === '.' ? ch[ai - 3] : null;
        if (!receiver) return [method];
        const rt = T(receiver, src); const full = rt + '.' + method; const parts = rt.split('.'); const cands = [full];
        if (parts.length > 1) cands.push(parts[parts.length - 1] + '.' + method);
        if (receiver.type === 'method_invocation') { const lm = javaLeftmostIdent(receiver, src); if (lm && cands.indexOf(lm + '.' + method) < 0) cands.push(lm + '.' + method); }
        cands.push(method); return cands;
    }
    function pythonFunctionName(fnNode, src) { for (const c of kids(fnNode)) if (c.type === 'identifier') return T(c, src); return null; }
    function pythonCallCandidates(callNode, src) {
        const func = kids(callNode)[0]; if (!func) return null;
        if (func.type === 'identifier') return [T(func, src)];
        if (func.type === 'attribute') { const full = T(func, src); const parts = full.split('.'); const c = [full]; if (parts.length > 1) { c.push(parts[parts.length - 2] + '.' + parts[parts.length - 1]); c.push(parts[parts.length - 1]); } return c; }
        return null;
    }
    function jsEnclosingClassName(fnNode, src) { let n = fnNode.parent; while (n) { if (n.type === 'class_declaration' || n.type === 'class') { const id = kids(n).find((c) => c.type === 'identifier'); return id ? T(id, src) : null; } n = n.parent; } return null; }
    function jsFunctionNameBehavior(fnNode, src) {
        if (fnNode.type === 'function_declaration' || fnNode.type === 'generator_function_declaration') { for (const c of kids(fnNode)) if (c.type === 'identifier') return T(c, src); return null; }
        if (fnNode.type === 'method_definition') { for (const c of kids(fnNode)) if (c.type === 'property_identifier') { const name = T(c, src); if (name === 'constructor') { const cn = jsEnclosingClassName(fnNode, src); if (cn) return cn; } return name; } return null; }
        if (fnNode.type === 'arrow_function' || fnNode.type === 'function_expression' || fnNode.type === 'function') { const p = fnNode.parent; if (p && p.type === 'variable_declarator') for (const c of kids(p)) if (c.type === 'identifier') return T(c, src); return '<anonymous:' + (row(fnNode) + 1) + '>'; }
        return null;
    }
    function jsIsSimpleMemberChain(node) { while (node.type === 'member_expression') { node = node.childForFieldName('object'); if (!node) return true; } return node.type === 'identifier' || node.type === 'this'; }
    function jsLeftmostIdent(node, src) { for (;;) { if (node.type === 'call_expression') { node = kids(node)[0]; if (!node) return null; continue; } if (node.type === 'member_expression') { const o = node.childForFieldName('object'); if (!o) return null; node = o; continue; } if (node.type === 'identifier' || node.type === 'this') return T(node, src); return null; } }
    function jsMemberCandidates(member, src) {
        const prop = member.childForFieldName('property'); const trailing = prop ? T(prop, src) : null;
        if (jsIsSimpleMemberChain(member)) { const full = T(member, src); const parts = full.split('.'); const c = [full]; if (parts.length > 2) c.push(parts.slice(-2).join('.')); if (trailing && c.indexOf(trailing) < 0) c.push(trailing); return c; }
        const lm = jsLeftmostIdent(member, src); const c = []; if (lm && trailing) c.push(lm + '.' + trailing); if (trailing) c.push(trailing); return c.length ? c : null;
    }
    function jsCallCandidates(callNode, src) {
        if (callNode.type === 'new_expression') { let target = null; for (const c of kids(callNode)) if (c.type === 'identifier' || c.type === 'member_expression') { target = c; break; } if (!target) return null; if (target.type === 'identifier') return [T(target, src)]; return jsMemberCandidates(target, src); }
        const func = kids(callNode)[0]; if (!func) return null;
        if (func.type === 'identifier') return [T(func, src)];
        if (func.type === 'member_expression') return jsMemberCandidates(func, src);
        return null;
    }
    function shellFunctionName(fnNode, src) { for (const c of kids(fnNode)) if (c.type === 'word') return T(c, src); return null; }
    function shellCallCandidates(callNode, src) { for (const c of kids(callNode)) if (c.type === 'command_name') return [T(c, src)]; return null; }

    // ---------- Rust／Go（2026-10-06）：呼叫名稱候選要跟 names_cpp_rust_go.json 的鍵寫法一致 ----------
    // Rust：路徑呼叫 a::b::c → [完整路徑, 最後兩段 b::c, 最後一段 c]；方法呼叫 x.foo() → ['.foo']；巨集 println! → ['println!']
    const rustPathText = (n, src) => T(n, src).replace(/\s+/g, '').replace(/::<[^<>]*>/g, '').replace(/<[^<>]*>/g, '');
    function rustFuncCandidates(func, src) {
        if (func.type === 'identifier') return [T(func, src)];
        if (func.type === 'generic_function') { const f = func.childForFieldName('function'); return f ? rustFuncCandidates(f, src) : null; }
        if (func.type === 'scoped_identifier') { const full = rustPathText(func, src), segs = full.split('::'); const out = [full]; if (segs.length > 2) out.push(segs.slice(-2).join('::')); out.push(segs[segs.length - 1]); return uniq(out); }
        if (func.type === 'field_expression') { const f = func.childForFieldName('field'); return f ? ['.' + T(f, src)] : null; }
        return null;
    }
    function rustCallCandidates(callNode, src) {
        if (callNode.type === 'macro_invocation') {
            const m = callNode.childForFieldName('macro'); if (!m) return null; const t0 = rustPathText(m, src), segs = t0.split('::'); const out = [t0 + '!'];
            if (segs.length > 2) out.push(segs.slice(-2).join('::') + '!'); if (segs.length > 1) out.push(segs[segs.length - 1] + '!'); return uniq(out);
        }
        const func = callNode.childForFieldName('function') || kids(callNode)[0]; return func ? rustFuncCandidates(func, src) : null;
    }
    // Go：套件函式 os.Open → ['os.Open', '.Open']；其他接收者的方法 mu.Lock → ['mu.Lock', '.Lock']；內建 make → ['make']
    function goCallCandidates(callNode, src) {
        const func = callNode.childForFieldName('function') || kids(callNode)[0]; if (!func) return null;
        if (func.type === 'identifier') return [T(func, src)];
        if (func.type === 'selector_expression') {
            const f = func.childForFieldName('field'), op = func.childForFieldName('operand'); if (!f) return null; const name = T(f, src);
            if (op && (op.type === 'identifier' || op.type === 'selector_expression')) return [T(op, src) + '.' + name, '.' + name]; return ['.' + name];
        }
        return null;
    }
    const fieldText = (n, f, src) => { const c = n.childForFieldName(f); return c ? T(c, src) : null; };
    const rustFunctionName = (fn, src) => fieldText(fn, 'name', src);
    const goFunctionName = (fn, src) => fieldText(fn, 'name', src);
    function rustParamNames(fn, src) { const ps = fn.childForFieldName('parameters'); if (!ps) return []; const out = []; for (const p of kids(ps)) if (p.type === 'parameter') { const pat = p.childForFieldName('pattern'); if (pat) out.push(T(pat, src)); } return out; }
    function goParamNames(fn, src) { const ps = fn.childForFieldName('parameters'); if (!ps) return []; const out = []; for (const p of kids(ps)) if (p.type === 'parameter_declaration' || p.type === 'variadic_parameter_declaration') for (const c of kids(p)) if (c.type === 'identifier') out.push(T(c, src)); return out; }
    const rustCondition = (node) => node.childForFieldName('condition') || node.childForFieldName('value') || null;
    function goCondition(node) {
        if (node.type === 'for_statement') { const fc = firstKid(node, 'for_clause'); if (fc) return fc.childForFieldName('condition') || null; if (firstKid(node, 'range_clause')) return null; return kids(node).find((c) => c.type !== 'for' && c.type !== 'block' && c.childCount > 0) || null; }
        return node.childForFieldName('condition') || node.childForFieldName('value') || null;
    }
    const fieldIfBranches = (ifNode) => [ifNode.childForFieldName('consequence') || null, ifNode.childForFieldName('alternative') || null];
    // Go 的 for 有三種寫法（for_clause 像 C、range_clause 走訪、只有條件／什麼都沒有）；switch 的 case 直接是子節點
    function goControlExplain(node, src, nk) {
        if (nk !== 'for_statement') return null;
        const rc = firstKid(node, 'range_clause');
        if (rc) { const l = rc.childForFieldName('left'), r = rc.childForFieldName('right'); return 'For each ' + (l ? '`' + T(l, src) + '` in ' : 'element in ') + '`' + (r ? T(r, src) : 'the collection') + '`:'; }
        const fc = firstKid(node, 'for_clause');
        if (fc) { const i = fc.childForFieldName('initializer'), c = fc.childForFieldName('condition'), u = fc.childForFieldName('update'); const parts = []; if (i) parts.push('starts with `' + T(i, src) + '`'); if (c) parts.push('continues while `' + T(c, src) + '` holds'); else parts.push('has no exit condition of its own (relies on an explicit break/return)'); if (u) parts.push('runs `' + T(u, src) + '` after each iteration'); return 'Loop that ' + parts.join(', ') + '.'; }
        const cond = goCondition(node); return cond ? 'Loops while `' + T(cond, src) + '` holds.' : 'Infinite loop (no condition of its own) - runs until an explicit break/return inside it.';
    }
    const goIsInfinite = (node) => node.type === 'for_statement' && !firstKid(node, 'for_clause') && !firstKid(node, 'range_clause') && !goCondition(node);
    function rustControlExplain(node, src, nk) { if (node.type === 'loop_expression') return 'Infinite loop (no condition of its own) - runs until an explicit break/return inside it.'; return null; }
    const rustIsInfinite = (node, src, p) => node.type === 'loop_expression';

    // ---------- 語言設定檔（LanguageProfile）：每個欄位都是真正的 grammar 節點名稱 ----------
    const ARG_PUNCT = S(['(', ')', ',', '[', ']']);
    const bracketedArgs = (node, type) => { const al = firstKid(node, type); return al ? kids(al).filter((a) => !ARG_PUNCT.has(a.type)) : []; };
    function shellCallArgs(callNode, src) { const out = []; for (const c of kids(callNode)) { if (c.type === 'command_name' || c.type === 'command_argument_sep' || !c.type.trim()) continue; if (c.type === 'command_elements') { for (const e of kids(c)) if (e.type !== 'command_argument_sep' && e.type.trim() && T(e, src).trim()) out.push(e); continue; } out.push(c); } return out; }
    const _lastCand = (fn) => (n, s) => { const c = fn(n, s); return c && c.length ? c[c.length - 1] : null; };
    const _single = (fn) => (n, s) => { const x = fn(n, s); return x ? [x] : null; };
    function cParamNames(fnNode, src, p) { const names = []; const lists = []; collect(fnNode, 'parameter_list', lists); if (!lists.length) return names; for (const pd of kids(lists[0])) if (pd.type === 'parameter_declaration' || pd.type === 'optional_parameter_declaration') { const n = descIdent(pd, src, p.identifier_types); if (n) names.push(n); } return names; }
    function javaParamNames(fnNode, src) { const names = []; const fp = firstKid(fnNode, 'formal_parameters'); if (!fp) return names; for (const p of kids(fp)) if (p.type === 'formal_parameter' || p.type === 'spread_parameter') { const ids = kids(p).filter((c) => c.type === 'identifier'); if (ids.length) names.push(T(ids[ids.length - 1], src)); } return names; }
    function pythonParamNames(fnNode, src, p) { const names = []; const params = firstKid(fnNode, 'parameters'); if (!params) return names; for (const x of kids(params)) { if (x.type === 'identifier') names.push(T(x, src)); else if (['default_parameter', 'typed_parameter', 'typed_default_parameter', 'list_splat_pattern', 'dictionary_splat_pattern'].indexOf(x.type) >= 0) { const n = descIdent(x, src, p.identifier_types); if (n) names.push(n); } } return names; }
    function jsParamNames(fnNode, src, p) { const names = []; const fp = firstKid(fnNode, 'formal_parameters'); if (!fp) return names; for (const x of kids(fp)) { if (x.type === 'identifier') names.push(T(x, src)); else if (['assignment_pattern', 'rest_pattern', 'object_pattern', 'array_pattern'].indexOf(x.type) >= 0) { const n = descIdent(x, src, p.identifier_types); if (n) names.push(n); } } return names; }
    const noParams = () => [];
    function jsFunctionNameP(fnNode, src) {
        if (fnNode.type !== 'arrow_function') { const id = firstKidOf(fnNode, ['identifier', 'property_identifier']); if (id) { const name = T(id, src); if (name === 'constructor' && fnNode.type === 'method_definition') { const cn = jsEnclosingClassName(fnNode, src); if (cn) return cn; } return name; } }
        const p = fnNode.parent; if (p && p.type === 'variable_declarator') { const pid = firstKid(p, 'identifier'); if (pid) return T(pid, src); } return null;
    }
    const cppCondition = (node) => { const cc = firstKid(node, 'condition_clause'); if (cc) return cc.childForFieldName('value') || kids(cc).find((c) => c.type !== '(' && c.type !== ')' && c.type !== 'init_statement') || null; return parenCondition(node); };
    const parenCondition = (node) => { const p = firstKid(node, 'parenthesized_expression'); if (!p) return null; return kids(p).find((c) => c.type !== '(' && c.type !== ')') || null; };
    function pythonCondition(node, src, p) { for (const c of kids(node)) { if (['if', 'while', 'elif', ':'].indexOf(c.type) >= 0) continue; if (p.body_node_types.has(c.type) || p.else_clause_types.has(c.type)) return null; return c; } return null; }
    const bashCondition = (node) => firstKidOf(node, ['test_command', 'command', 'pipeline']);
    function genericIfBranches(ifNode, p, src) {
        const condNode = p.get_condition_node(ifNode, src, p); let consequence = null; let started = !condNode;
        for (const c of kids(ifNode)) {
            if (!started) { if (c.startIndex <= condNode.endIndex) continue; started = true; }
            if (p.else_clause_types.has(c.type) || p.elif_clause_types.has(c.type)) break;
            if (c.childCount === 0) continue;
            consequence = c; break;
        }
        let elseNode;
        if (p.elif_clause_types.has(ifNode.type)) { let sib = ifNode.nextSibling; while (sib && !p.elif_clause_types.has(sib.type) && !p.else_clause_types.has(sib.type)) sib = sib.nextSibling; elseNode = sib; }
        else { elseNode = firstKidOf(ifNode, p.elif_clause_types); if (!elseNode) elseNode = firstKidOf(ifNode, p.else_clause_types); }
        return [consequence, elseNode || null];
    }
    function javaIfBranches(ifNode) { let consequence = null, elseNode = null, seen = false; for (const c of kids(ifNode)) { if (c.type === 'else') { seen = true; continue; } if (c.type === 'if' || c.type === 'parenthesized_expression') continue; if (seen) { elseNode = c; break; } if (!consequence) consequence = c; } return [consequence, elseNode]; }
    const P = (o) => Object.assign({ elif_clause_types: S([]), noreturn_calls: S([]), control_transfer_call_names: S([]), callback_param_funcs: {}, output_param_funcs: {}, path_arg_calls: S([]), c_style_for_types: S([]), foreach_for_types: S([]), switch_like_types: S([]) }, o);
    const PROFILES = {
        c: P({ language: 'c', function_node_types: S(['function_definition']), call_node_types: S(['call_expression']), body_node_types: S(['compound_statement']), control_statement_types: S(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement']), leaf_statement_types: S(['expression_statement', 'declaration', 'return_statement', 'break_statement', 'continue_statement', 'goto_statement']), transparent_types: S(['compound_statement', 'labeled_statement', 'case_statement', 'else_clause']), identifier_types: S(['identifier']), string_literal_types: S(['string_literal']), assignment_types: S(['assignment_expression']), declaration_types: S(['declaration']), declarator_types: S(['init_declarator']), else_clause_types: S(['else_clause']), control_transfer_types: S(['return_statement', 'continue_statement', 'break_statement', 'goto_statement']), loop_node_types: S(['for_statement', 'while_statement', 'do_statement']), infinite_loop_texts: S(['1', 'true', 'TRUE', 'True']), c_style_for_types: S(['for_statement']), switch_like_types: S(['switch_statement']), get_call_name: cCallName, get_call_candidates: _single(cCallName), get_call_arguments: (n) => bracketedArgs(n, 'argument_list'), get_function_name: cFunctionName, get_parameter_names: cParamNames, get_if_branches: genericIfBranches, get_condition_node: parenCondition, noreturn_calls: S(['exit', '_exit', '_Exit', 'abort', 'quick_exit']), callback_param_funcs: { pthread_create: [2], pthread_cleanup_push: [0], pthread_once: [1], signal: [1], atexit: [0], at_quick_exit: [0], qsort: [3], qsort_r: [3], bsearch: [4], tsearch: [1], twalk: [1] }, output_param_funcs: { sprintf: 0, snprintf: 0, vsprintf: 0, vsnprintf: 0, strcpy: 0, strncpy: 0, strcat: 0, strncat: 0, strlcpy: 0, strlcat: 0, memcpy: 0, memmove: 0, stpcpy: 0, recv: 1, recvfrom: 1, read: 1, pread: 1 }, path_arg_calls: S(['open', 'open64', 'openat', 'fopen', 'freopen', 'creat']) }),
        java: P({ language: 'java', function_node_types: S(['method_declaration', 'constructor_declaration']), call_node_types: S(['method_invocation', 'object_creation_expression']), body_node_types: S(['block', 'constructor_body']), control_statement_types: S(['if_statement', 'for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement', 'switch_expression']), leaf_statement_types: S(['expression_statement', 'local_variable_declaration', 'return_statement', 'break_statement', 'continue_statement', 'throw_statement', 'yield_statement']), transparent_types: S(['block', 'constructor_body', 'switch_block', 'switch_block_statement_group', 'labeled_statement', 'catch_clause', 'finally_clause', 'try_statement', 'synchronized_statement']), identifier_types: S(['identifier']), string_literal_types: S(['string_literal']), assignment_types: S(['assignment_expression']), declaration_types: S(['local_variable_declaration']), declarator_types: S(['variable_declarator']), else_clause_types: S([]), control_transfer_types: S(['return_statement', 'continue_statement', 'break_statement', 'throw_statement']), loop_node_types: S(['for_statement', 'enhanced_for_statement', 'while_statement', 'do_statement']), infinite_loop_texts: S(['true']), c_style_for_types: S(['for_statement']), foreach_for_types: S(['enhanced_for_statement']), switch_like_types: S(['switch_expression']), get_call_name: _lastCand(javaCallCandidates), get_call_candidates: javaCallCandidates, get_call_arguments: (n) => bracketedArgs(n, 'argument_list'), get_function_name: javaFunctionName, get_parameter_names: javaParamNames, get_if_branches: javaIfBranches, get_condition_node: parenCondition, noreturn_calls: S(['exit', 'halt']), output_param_funcs: { arraycopy: 2, get: 0 } }),
        python: P({ language: 'python', function_node_types: S(['function_definition']), call_node_types: S(['call']), body_node_types: S(['block']), control_statement_types: S(['if_statement', 'elif_clause', 'for_statement', 'while_statement', 'match_statement']), leaf_statement_types: S(['expression_statement', 'return_statement', 'break_statement', 'continue_statement', 'raise_statement', 'pass_statement', 'assert_statement', 'delete_statement', 'global_statement']), transparent_types: S(['block', 'else_clause', 'except_clause', 'finally_clause', 'case_clause', 'with_statement', 'try_statement']), identifier_types: S(['identifier']), string_literal_types: S(['string']), assignment_types: S(['assignment', 'augmented_assignment']), declaration_types: S([]), declarator_types: S([]), else_clause_types: S(['else_clause']), elif_clause_types: S(['elif_clause']), control_transfer_types: S(['return_statement', 'continue_statement', 'break_statement', 'raise_statement']), loop_node_types: S(['for_statement', 'while_statement']), infinite_loop_texts: S(['True', '1']), foreach_for_types: S(['for_statement']), switch_like_types: S(['match_statement']), get_call_name: _lastCand(pythonCallCandidates), get_call_candidates: pythonCallCandidates, get_call_arguments: (n) => bracketedArgs(n, 'argument_list'), get_function_name: pythonFunctionName, get_parameter_names: pythonParamNames, get_if_branches: genericIfBranches, get_condition_node: pythonCondition, noreturn_calls: S(['exit', 'quit', '_exit']), callback_param_funcs: { register: [0] }, path_arg_calls: S(['open']) }),
        javascript: P({ language: 'javascript', function_node_types: S(['function_declaration', 'function_expression', 'function', 'arrow_function', 'method_definition', 'generator_function_declaration']), call_node_types: S(['call_expression', 'new_expression']), body_node_types: S(['statement_block']), control_statement_types: S(['if_statement', 'for_statement', 'for_in_statement', 'while_statement', 'do_statement', 'switch_statement']), leaf_statement_types: S(['expression_statement', 'lexical_declaration', 'variable_declaration', 'return_statement', 'break_statement', 'continue_statement', 'throw_statement']), transparent_types: S(['statement_block', 'switch_body', 'switch_case', 'switch_default', 'else_clause', 'catch_clause', 'finally_clause', 'labeled_statement', 'try_statement']), identifier_types: S(['identifier', 'property_identifier']), string_literal_types: S(['string', 'template_string']), assignment_types: S(['assignment_expression', 'augmented_assignment_expression']), declaration_types: S(['lexical_declaration', 'variable_declaration']), declarator_types: S(['variable_declarator']), else_clause_types: S(['else_clause']), control_transfer_types: S(['return_statement', 'continue_statement', 'break_statement', 'throw_statement']), loop_node_types: S(['for_statement', 'for_in_statement', 'while_statement', 'do_statement']), infinite_loop_texts: S(['true', '1']), c_style_for_types: S(['for_statement']), foreach_for_types: S(['for_in_statement']), switch_like_types: S(['switch_statement']), get_call_name: _lastCand(jsCallCandidates), get_call_candidates: jsCallCandidates, get_call_arguments: (n) => bracketedArgs(n, 'arguments'), get_function_name: jsFunctionNameP, get_parameter_names: jsParamNames, get_if_branches: genericIfBranches, get_condition_node: parenCondition, callback_param_funcs: { addEventListener: [1], on: [1], once: [1], setTimeout: [0], setInterval: [0], setImmediate: [0], then: [0], catch: [0], forEach: [0], map: [0], filter: [0], nextTick: [0], subscribe: [0] }, path_arg_calls: S(['readFile', 'readFileSync', 'writeFile', 'writeFileSync', 'open', 'openSync', 'createReadStream', 'createWriteStream']) }),
        shell: P({ language: 'shell', function_node_types: S(['function_definition']), call_node_types: S(['command']), body_node_types: S(['compound_statement', 'do_group']), control_statement_types: S(['if_statement', 'for_statement', 'c_style_for_statement', 'while_statement', 'case_statement']), leaf_statement_types: S(['command', 'variable_assignment', 'declaration_command', 'unset_command', 'pipeline', 'list', 'subshell', 'redirected_statement']), transparent_types: S(['compound_statement', 'do_group', 'else_clause', 'elif_clause', 'case_item', 'program']), identifier_types: S(['variable_name', 'word']), string_literal_types: S(['string', 'raw_string', 'word']), assignment_types: S(['variable_assignment']), declaration_types: S(['declaration_command']), declarator_types: S([]), else_clause_types: S(['else_clause', 'elif_clause']), control_transfer_types: S(['return_statement', 'continue_statement', 'break_statement']), loop_node_types: S(['for_statement', 'c_style_for_statement', 'while_statement']), infinite_loop_texts: S(['true', ':', '1']), c_style_for_types: S(['c_style_for_statement']), foreach_for_types: S(['for_statement']), switch_like_types: S(['case_statement']), get_call_name: _lastCand(shellCallCandidates), get_call_candidates: shellCallCandidates, get_call_arguments: shellCallArgs, get_function_name: shellFunctionName, get_parameter_names: noParams, get_if_branches: genericIfBranches, get_condition_node: bashCondition, noreturn_calls: S(['exit']), control_transfer_call_names: S(['return', 'break', 'continue']) }),
    };
    // C++：語法樹用 C++ 的 grammar（class／template／namespace／range-for／lambda）；名稱表用 C 加上 C++ 標準函式庫（table_language: 'cpp'），其餘行為判斷沿用 C 的（language: 'c'）
    PROFILES.cpp = Object.assign({}, PROFILES.c, {
        language: 'c', table_language: 'cpp', get_condition_node: cppCondition,
        control_statement_types: S(['if_statement', 'for_statement', 'for_range_loop', 'while_statement', 'do_statement', 'switch_statement']), loop_node_types: S(['for_statement', 'for_range_loop', 'while_statement', 'do_statement']),
        foreach_for_types: S(['for_range_loop']), transparent_types: S(['compound_statement', 'labeled_statement', 'case_statement', 'else_clause', 'try_statement', 'catch_clause']),
    });
    // 語言裡到處都是、不代表行為的小呼叫：不列進「未分類」（只有沒命中名稱表時才會被忽略）
    PROFILES.python.ignore_names = S(['len', 'range', 'str', 'int', 'float', 'bool', 'bytes', 'list', 'dict', 'set', 'tuple', 'frozenset', 'enumerate', 'zip', 'map', 'filter', 'sorted', 'reversed', 'isinstance', 'issubclass', 'super', 'repr', 'abs', 'min', 'max', 'sum', 'any', 'all', 'round', 'iter', 'next', 'id', 'hash', 'callable', 'append', 'extend', 'items', 'keys', 'values', 'get', 'pop', 'update', 'add', 'remove', 'count', 'index', 'copy', 'strip', 'lower', 'upper', 'startswith', 'endswith', 'encode', 'decode', 'start', 'join']);
    PROFILES.java.ignore_names = S(['toString', 'equals', 'hashCode', 'getClass', 'length', 'size', 'isEmpty', 'get', 'put', 'add', 'remove', 'contains', 'containsKey', 'getMessage', 'getCause', 'append', 'valueOf', 'intValue', 'longValue', 'doubleValue', 'iterator', 'hasNext', 'next', 'stream', 'map', 'filter', 'collect', 'forEach', 'orElse', 'isPresent', 'close', 'build', 'Exception', 'RuntimeException', 'IllegalArgumentException', 'IllegalStateException', 'FileNotFoundException', 'IOException', 'Object', 'String']);
    PROFILES.javascript.ignore_names = S(['push', 'pop', 'shift', 'unshift', 'map', 'filter', 'forEach', 'slice', 'splice', 'includes', 'indexOf', 'join', 'keys', 'values', 'entries', 'trim', 'split', 'toString', 'toFixed', 'toUpperCase', 'toLowerCase', 'replace', 'startsWith', 'endsWith', 'Error', 'TypeError', 'RangeError', 'Array', 'Object', 'String', 'Number', 'Boolean', 'require', 'bind', 'call', 'apply', 'on', 'text', 'json', 'update', 'digest', 'dirname', 'basename']);
    PROFILES.python.bare_specific = true; PROFILES.python.bare_ok = S(['cursor', 'execute', 'executemany', 'executescript', 'commit', 'rollback', 'fetchone', 'fetchall', 'fetchmany', 'read', 'readline', 'readlines', 'write', 'writelines']);
    PROFILES.java.bare_specific = true; PROFILES.java.bare_ok = S(['send', 'submit', 'sendAsync']);
    PROFILES.javascript.bare_specific = true; PROFILES.javascript.bare_ok = S(['on', 'once', 'off', 'emit', 'then', 'catch', 'exec', 'spawn', 'fork']);
    PROFILES.cpp.ignore_names = S(['runtime_error', 'logic_error', 'invalid_argument', 'out_of_range', 'exception', 'begin', 'end', 'cbegin', 'cend', 'size', 'empty', 'c_str', 'data', 'get', 'at', 'front', 'back', 'move', 'forward', 'swap', 'what', 'milliseconds', 'seconds', 'microseconds', 'string', 'vector', 'map', 'ref', 'cref', 'pair', 'tie', 'tuple', 'min', 'max']);
    // Rust：以運算式為主（if／match／loop 都是 *_expression）；expression_statement 不當葉子（裡面可能是 if／for），改成往下走到真正的語句
    PROFILES.rust = P({
        language: 'rust', multi_key: true, function_node_types: S(['function_item']), call_node_types: S(['call_expression', 'macro_invocation']), body_node_types: S(['block', 'match_block']),
        control_statement_types: S(['if_expression', 'for_expression', 'while_expression', 'loop_expression', 'match_expression']),
        leaf_statement_types: S(['let_declaration', 'call_expression', 'macro_invocation', 'return_expression', 'break_expression', 'continue_expression', 'assignment_expression', 'compound_assignment_expr', 'try_expression', 'await_expression', 'const_item', 'static_item']),
        transparent_types: S(['block', 'else_clause', 'unsafe_block', 'async_block', 'expression_statement', 'match_arm']), identifier_types: S(['identifier']), string_literal_types: S(['string_literal', 'raw_string_literal']),
        assignment_types: S(['assignment_expression', 'compound_assignment_expr']), declaration_types: S(['let_declaration']), declarator_types: S([]), else_clause_types: S(['else_clause']),
        control_transfer_types: S(['return_expression', 'break_expression', 'continue_expression']), loop_node_types: S(['for_expression', 'while_expression', 'loop_expression']),
        infinite_loop_texts: S(['true']), foreach_for_types: S(['for_expression']), switch_like_types: S(['match_expression']),
        get_call_name: (n, s) => { const c = rustCallCandidates(n, s); return c && c.length ? c[0] : null; }, get_call_candidates: rustCallCandidates, get_call_arguments: (n) => bracketedArgs(n, 'arguments'),
        get_function_name: rustFunctionName, get_parameter_names: rustParamNames, get_if_branches: fieldIfBranches, get_condition_node: rustCondition,
        noreturn_calls: S(['panic!', 'unreachable!', 'unimplemented!', 'todo!', 'process::exit', 'std::process::exit', 'process::abort', 'std::process::abort']),
        control_explain: rustControlExplain, is_infinite_loop: rustIsInfinite,
        ignore_names: S(['Ok', 'Err', 'Some', 'None', '.clone', '.is_empty', '.len', '.iter', '.iter_mut', '.into_iter', '.map', '.filter', '.filter_map', '.collect', '.as_ref', '.as_mut', '.as_str', '.cloned', '.copied', '.enumerate', '.zip', '.rev', '.take', '.skip', '.join', '.is_some', '.is_none', '.is_ok', '.is_err', '.unwrap_or', '.unwrap_or_default', '.map_err', '.to_string', '.to_owned', '.success', '.ok', '.ok_or', '.get', '.insert', '.remove', '.contains', '.keys', '.values', '.new', 'String::new', 'Vec::new', 'drop']),
    });
    // Go：for 有三種寫法、switch／select 的 case 直接是子節點（get_control_body 回傳節點本身，讓走訪器逐個 case 往下）
    PROFILES.go = P({
        language: 'go', multi_key: true, function_node_types: S(['function_declaration', 'method_declaration']), call_node_types: S(['call_expression']), body_node_types: S(['block']),
        control_statement_types: S(['if_statement', 'for_statement', 'expression_switch_statement', 'type_switch_statement', 'select_statement']),
        leaf_statement_types: S(['short_var_declaration', 'assignment_statement', 'call_expression', 'return_statement', 'break_statement', 'continue_statement', 'goto_statement', 'var_declaration', 'const_declaration', 'defer_statement', 'go_statement', 'inc_statement', 'dec_statement', 'send_statement']),
        transparent_types: S(['block', 'expression_statement', 'labeled_statement', 'expression_case', 'default_case', 'type_case', 'communication_case']), identifier_types: S(['identifier']), string_literal_types: S(['interpreted_string_literal', 'raw_string_literal']),
        assignment_types: S(['assignment_statement', 'short_var_declaration']), declaration_types: S(['var_declaration', 'short_var_declaration']), declarator_types: S(['var_spec']), else_clause_types: S([]),
        control_transfer_types: S(['return_statement', 'break_statement', 'continue_statement', 'goto_statement']), loop_node_types: S(['for_statement']), infinite_loop_texts: S(['true']), foreach_for_types: S([]), switch_like_types: S(['expression_switch_statement', 'type_switch_statement', 'select_statement']),
        get_call_name: (n, s) => { const c = goCallCandidates(n, s); return c && c.length ? c[0] : null; }, get_call_candidates: goCallCandidates, get_call_arguments: (n) => bracketedArgs(n, 'argument_list'),
        get_function_name: goFunctionName, get_parameter_names: goParamNames, get_if_branches: fieldIfBranches, get_condition_node: goCondition,
        noreturn_calls: S(['panic', 'os.Exit', 'log.Fatal', 'log.Fatalf', 'log.Fatalln', 'runtime.Goexit', 'log.Panic', 'log.Panicf', 'log.Panicln']),
        control_explain: goControlExplain, is_infinite_loop: goIsInfinite, get_control_body: (node) => (/switch|select/.test(node.type) ? node : null),
        ignore_names: S(['len', 'cap', 'new', 'string', 'int', 'int64', 'float64', 'byte', 'error', '.Error', '.String', '.Len', '.Close', '.Get', '.Set', '.Add', '.Do', '.Run', '.Next', '.Wait']),
    });

    // ---------- C#／Ruby／Lua（2026-10-14）：呼叫名稱候選的寫法要跟 names_more_langs.json 一致 ----------
    // C#：靜態呼叫 File.ReadAllText → ['File.ReadAllText', '.ReadAllText']；實例方法 client.GetAsync → ['client.GetAsync', '.GetAsync']；泛型去掉（JsonSerializer.Deserialize<T> → JsonSerializer.Deserialize）；new Thread(…) → ['Thread']
    const csClean = (n, src) => { let t = T(n, src).replace(/\s+/g, ''), p; do { p = t; t = t.replace(/<[^<>]*>/g, ''); } while (t !== p); return t; };   // 泛型一層一層去掉（Dictionary<string,List<int>>）
    function csFuncCandidates(func, src) {
        if (func.type === 'identifier') return [T(func, src)];
        if (func.type === 'generic_name') { const id = firstKid(func, 'identifier'); return id ? [T(id, src)] : null; }
        if (func.type === 'member_binding_expression') { const nm = func.childForFieldName('name'); return nm ? ['.' + csClean(nm, src)] : null; }
        if (func.type === 'member_access_expression') {
            const nameN = func.childForFieldName('name'), expr = func.childForFieldName('expression'); if (!nameN) return null; const nm = csClean(nameN, src);
            if (expr && ['identifier', 'member_access_expression', 'predefined_type', 'qualified_name', 'generic_name', 'this_expression', 'base_expression'].indexOf(expr.type) >= 0) { const full = csClean(expr, src) + '.' + nm, segs = full.split('.'); const out = [full]; if (segs.length > 2) out.push(segs.slice(-2).join('.')); out.push('.' + nm); return uniq(out); }
            return ['.' + nm];
        }
        return null;
    }
    function csCallCandidates(callNode, src) {
        if (callNode.type === 'object_creation_expression') { const t = callNode.childForFieldName('type'); if (!t) return null; const full = csClean(t, src); return uniq([full, full.split('.').pop()]); }
        if (callNode.type === 'conditional_access_expression') return null; // 裡面的 invocation_expression 會自己被算一次
        const f = callNode.childForFieldName('function') || kids(callNode)[0]; return f ? csFuncCandidates(f, src) : null;
    }
    function csFunctionName(fn, src) {
        const nm = fn.childForFieldName('name'); if (nm) return (fn.type === 'destructor_declaration' ? '~' : '') + T(nm, src);
        if (fn.type === 'operator_declaration') { const op = kids(fn).find((c) => !c.isNamed || /operator/.test(c.type)); return 'operator ' + (fn.childForFieldName('operator') ? T(fn.childForFieldName('operator'), src) : (op ? T(op, src) : '?')); }
        return null;
    }
    function csParamNames(fn, src) { const ps = fn.childForFieldName('parameters') || firstKid(fn, 'parameter_list'); if (!ps) return []; const out = []; for (const p of kids(ps)) if (p.type === 'parameter') { const n = p.childForFieldName('name'); if (n) out.push(T(n, src)); } return out; }
    // while／do 在這版 grammar 沒有 condition 欄位：取括號之間的那個節點
    function csCondition(node) {
        const c = node.childForFieldName('condition'); if (c) return c;
        const ks = kids(node); const lp = ks.findIndex((k) => k.type === '('), rp = ks.findIndex((k, i) => i > lp && k.type === ')'); if (lp >= 0 && rp > lp + 1) return ks[lp + 1];
        return null;
    }
    function csControlExplain(node, src, nk) { if (node.type === 'for_each_statement') { const l = node.childForFieldName('left'), r = node.childForFieldName('right'); return 'For each ' + (l ? '`' + T(l, src) + '` in ' : 'element in ') + '`' + (r ? T(r, src) : 'the collection') + '`:'; } return null; }
    // Ruby：method 的敘述直接是它的子節點（沒有 body 包裝）；呼叫是 call（receiver／method／arguments）；`code` 反引號是 subshell
    function rubyCallCandidates(callNode, src) {
        if (callNode.type === 'subshell') return ['`'];
        const m = callNode.childForFieldName('method'); if (!m) return null; const name = T(m, src); const recv = callNode.childForFieldName('receiver');
        if (!recv) return [name];
        if (['constant', 'identifier', 'scope_resolution', 'instance_variable', 'self', 'class_variable', 'global_variable'].indexOf(recv.type) >= 0) { const full = T(recv, src).replace(/\s+/g, '') + '.' + name, segs = full.split(/\.|::/); const out = [full]; if (recv.type === 'scope_resolution' || recv.type === 'constant') { const last2 = segs.slice(-2).join('.'); if (last2 !== full) out.push(last2); } out.push('.' + name); return uniq(out); }
        return ['.' + name];
    }
    function rubyFunctionName(fn, src) { const nm = fn.childForFieldName('name'); if (!nm) return null; if (fn.type === 'singleton_method') { const o = fn.childForFieldName('object'); return (o ? T(o, src) : 'self') + '.' + T(nm, src); } return T(nm, src); }
    function rubyParamNames(fn, src) { const ps = fn.childForFieldName('parameters'); if (!ps) return []; const out = []; for (const p of kids(ps)) { if (p.type === 'identifier') out.push(T(p, src)); else { const n = p.childForFieldName('name') || firstKid(p, 'identifier'); if (n) out.push(T(n, src)); } } return out; }
    function rubyIfBranches(n) { if (/_modifier$/.test(n.type)) return [n.childForFieldName('body') || null, null]; return [n.childForFieldName('consequence') || null, n.childForFieldName('alternative') || null]; }
    function rubyCondition(n) { return n.childForFieldName('condition') || n.childForFieldName('value') || null; }
    function rubyControlExplain(node, src, nk) {
        const c = rubyCondition(node); const ct = c ? '`' + T(c, src).trim() + '`' : null;
        if (node.type === 'unless' || node.type === 'unless_modifier') return ct ? 'Runs only when ' + ct + ' is FALSE (unless).' : 'Branches on its own condition (unless).';
        if (node.type === 'until' || node.type === 'until_modifier') return ct ? 'Loops until ' + ct + ' becomes true.' : 'Loops until its own condition becomes true.';
        if (node.type === 'for') { const p = node.childForFieldName('pattern'), v = node.childForFieldName('value'); const it = v ? T(v, src).replace(/^in\s+/, '').trim() : null; return 'For each ' + (p ? '`' + T(p, src) + '` in ' : 'element in ') + '`' + (it || 'the collection') + '`:'; }
        if (node.type === 'case') return ct ? 'Branches based on the value of ' + ct + '.' : 'Branches on its own subject (see header text).';
        return null;
    }
    // Lua：函式名稱 M.load／M:fetch 是 variable 節點的文字；呼叫 call 的 function 欄位是 variable（io.open、f:read）
    function luaCallCandidates(callNode, src) {
        const f = callNode.childForFieldName('function') || kids(callNode)[0]; if (!f) return null;
        const full = T(f, src).replace(/\s+/g, '').replace(/:/g, '.'); if (!/^[A-Za-z_][\w.]*$/.test(full)) return null;
        const segs = full.split('.'); if (segs.length === 1) return [full];
        const out = [full]; if (segs.length > 2) out.push(segs.slice(-2).join('.')); out.push('.' + segs[segs.length - 1]); return uniq(out);
    }
    function luaFunctionName(fn, src) { const nm = fn.childForFieldName('name'); if (!nm) return null; return T(nm, src).replace(/\s+/g, ''); }
    function luaParamNames(fn, src) { const ps = fn.childForFieldName('parameters') || firstKid(fn, 'parameter_list'); if (!ps) return []; return kids(ps).filter((c) => c.type === 'identifier').map((c) => T(c, src)); }
    function luaControlExplain(node, src, nk) {
        if (node.type === 'repeat_statement') { const c = node.childForFieldName('condition'); return 'Repeats the body until ' + (c ? '`' + T(c, src).trim() + '`' : 'its own condition') + ' becomes true (condition checked at the END of each pass, so the body runs at least once).'; }
        if (node.type === 'for_numeric_statement') { const ns = kids(node).filter((c) => c.type === 'number' || c.type === 'variable' || c.type === 'binary_expression' || c.type === 'call'); const v = node.childForFieldName('name'); return 'Loops `' + (v ? T(v, src) : 'i') + '` from `' + (ns[0] ? T(ns[0], src) : '?') + '` to `' + (ns[1] ? T(ns[1], src) : '?') + '`' + (ns[2] ? ' step `' + T(ns[2], src) + '`' : '') + '.'; }
        if (node.type === 'for_generic_statement') { const l = node.childForFieldName('left'), r = node.childForFieldName('right'); return 'For each `' + (l ? T(l, src) : 'element') + '` in `' + (r ? T(r, src) : 'the iterator') + '`:'; }
        return null;
    }
    PROFILES.csharp = P({
        language: 'csharp', multi_key: true, function_node_types: S(['method_declaration', 'constructor_declaration', 'local_function_statement', 'destructor_declaration', 'operator_declaration']), call_node_types: S(['invocation_expression', 'object_creation_expression']), body_node_types: S(['block', 'switch_body']),
        control_statement_types: S(['if_statement', 'for_statement', 'for_each_statement', 'while_statement', 'do_statement', 'switch_statement']),
        leaf_statement_types: S(['expression_statement', 'local_declaration_statement', 'return_statement', 'break_statement', 'continue_statement', 'throw_statement', 'yield_statement', 'goto_statement', 'local_function_statement']),
        transparent_types: S(['block', 'switch_body', 'switch_section', 'try_statement', 'catch_clause', 'finally_clause', 'using_statement', 'lock_statement', 'checked_statement', 'unsafe_statement', 'fixed_statement', 'labeled_statement']),
        identifier_types: S(['identifier']), string_literal_types: S(['string_literal', 'verbatim_string_literal', 'interpolated_string_expression', 'raw_string_literal']),
        assignment_types: S(['assignment_expression']), declaration_types: S(['local_declaration_statement']), declarator_types: S(['variable_declarator']), else_clause_types: S([]),
        control_transfer_types: S(['return_statement', 'continue_statement', 'break_statement', 'throw_statement', 'goto_statement']), loop_node_types: S(['for_statement', 'for_each_statement', 'while_statement', 'do_statement']),
        infinite_loop_texts: S(['true']), c_style_for_types: S(['for_statement']), foreach_for_types: S(['for_each_statement']), switch_like_types: S(['switch_statement']),
        get_call_name: (n, s) => { const c = csCallCandidates(n, s); return c && c.length ? c[0] : null; }, get_call_candidates: csCallCandidates, get_call_arguments: (n) => bracketedArgs(n, 'argument_list'),
        get_function_name: csFunctionName, get_parameter_names: csParamNames, get_if_branches: fieldIfBranches, get_condition_node: csCondition, control_explain: csControlExplain,
        noreturn_calls: S(['Environment.Exit', 'Application.Exit', 'Environment.FailFast']),
        ignore_prefixes: ['base.'],
        ignore_names: S(['Size', 'SizeF', 'Point', 'PointF', 'Rectangle', 'RectangleF', '.ToString', '.Equals', '.GetHashCode', '.GetType', '.Dispose', '.Add', '.Contains', '.Count', '.ToList', '.ToArray', '.Where', '.Select', 'nameof', 'typeof', 'Exception', 'ArgumentException', 'ArgumentNullException', 'InvalidOperationException', 'NotImplementedException', 'FileNotFoundException', 'IOException', 'NotSupportedException', 'KeyNotFoundException', 'DirectoryNotFoundException', 'TimeoutException', 'UnauthorizedAccessException']),
    });
    PROFILES.ruby = P({
        language: 'ruby', multi_key: true, function_node_types: S(['method', 'singleton_method']), call_node_types: S(['call', 'subshell']), body_node_types: S(['body_statement', 'then', 'do', 'else']),
        control_statement_types: S(['if', 'unless', 'elsif', 'while', 'until', 'for', 'case', 'if_modifier', 'unless_modifier', 'while_modifier', 'until_modifier']),
        leaf_statement_types: S(['call', 'assignment', 'operator_assignment', 'return', 'break', 'next', 'redo', 'retry', 'yield', 'subshell']),
        transparent_types: S(['body_statement', 'then', 'do', 'else', 'when', 'begin', 'rescue', 'ensure', 'do_block', 'block']),
        identifier_types: S(['identifier']), string_literal_types: S(['string', 'bare_string', 'heredoc_body']),
        assignment_types: S(['assignment', 'operator_assignment']), declaration_types: S([]), declarator_types: S([]), else_clause_types: S(['else']), elif_clause_types: S([]),
        control_transfer_types: S(['return', 'break', 'next', 'redo', 'retry']), loop_node_types: S(['while', 'until', 'for', 'while_modifier', 'until_modifier']),
        infinite_loop_texts: S(['true']), foreach_for_types: S(['for']), switch_like_types: S(['case']),
        get_call_name: (n, s) => { const c = rubyCallCandidates(n, s); return c && c.length ? c[0] : null; }, get_call_candidates: rubyCallCandidates, get_call_arguments: (n) => bracketedArgs(n, 'argument_list'),
        get_function_name: rubyFunctionName, get_parameter_names: rubyParamNames, get_if_branches: rubyIfBranches, get_condition_node: rubyCondition, control_explain: rubyControlExplain,
        get_body: (fn) => fn, // method 的敘述是它自己的子節點
        noreturn_calls: S(['exit', 'exit!', 'abort', 'raise', 'fail']), control_transfer_call_names: S(['raise', 'fail', 'throw']),
        ignore_names: S(['.each', '.map', '.select', '.reject', '.collect', '.each_with_index', '.each_with_object', '.inject', '.reduce', '.new', '.to_s', '.to_i', '.to_f', '.to_a', '.to_h', '.to_sym', '.length', '.size', '.count', '.nil?', '.empty?', '.first', '.last', '.push', '.pop', '.shift', '.include?', '.key?', '.merge', '.keys', '.values', '.fetch', '.dup', '.freeze', '.strip', '.split', '.downcase', '.upcase', '.zero?', '.message', '.backtrace', '.class', '.name', '.is_a?', '.kind_of?', '.instance_of?', '.new', 'new', 'require', 'require_relative', 'attr_reader', 'attr_accessor', 'attr_writer', 'include', 'extend', 'prepend', 'private', 'public', 'protected', 'module_function', 'lambda', 'proc', 'block_given?', 'yield', 'super']),
    });
    PROFILES.lua = P({
        language: 'lua', multi_key: true, function_node_types: S(['function_definition_statement', 'local_function_definition_statement']), call_node_types: S(['call']), body_node_types: S(['block']),
        control_statement_types: S(['if_statement', 'elseif_clause', 'for_numeric_statement', 'for_generic_statement', 'while_statement', 'repeat_statement']),
        leaf_statement_types: S(['call', 'variable_assignment', 'local_variable_declaration', 'return_statement', 'break_statement', 'goto_statement']),
        transparent_types: S(['block', 'else_clause', 'do_statement']),
        identifier_types: S(['identifier']), string_literal_types: S(['string']),
        assignment_types: S(['variable_assignment']), declaration_types: S(['local_variable_declaration']), declarator_types: S([]), else_clause_types: S(['else_clause']), elif_clause_types: S(['elseif_clause']),
        control_transfer_types: S(['return_statement', 'break_statement', 'goto_statement']), loop_node_types: S(['for_numeric_statement', 'for_generic_statement', 'while_statement', 'repeat_statement']),
        infinite_loop_texts: S(['true']), foreach_for_types: S(['for_generic_statement']), switch_like_types: S([]),
        get_call_name: (n, s) => { const c = luaCallCandidates(n, s); return c && c.length ? c[0] : null; }, get_call_candidates: luaCallCandidates, get_call_arguments: (n) => { const al = firstKid(n, 'argument_list'); if (!al) return []; const el = firstKid(al, 'expression_list'); return el ? kids(el).filter((a) => a.type !== ',') : []; },
        get_function_name: luaFunctionName, get_parameter_names: luaParamNames, get_if_branches: genericIfBranches, get_condition_node: (n) => n.childForFieldName('condition') || null, control_explain: luaControlExplain,
        noreturn_calls: S(['error', 'os.exit']), control_transfer_call_names: S(['error']),
        ignore_names: S(['type', 'ipairs', 'pairs', 'select', 'next', '.insert', '.remove', '.concat', '.sort', '.gsub', '.gmatch', '.find', '.match', '.sub', '.len', '.upper', '.lower', '.rep', '.floor', '.ceil', '.max', '.min', '.abs', '.sqrt', '.close']),
    });
