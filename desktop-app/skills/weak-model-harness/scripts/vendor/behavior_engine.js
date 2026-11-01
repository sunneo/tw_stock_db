'use strict';
// 由 scripts/pack.js 接起 renderer/src/behavior/engine_1～5；不要手改。
module.exports = (function () {
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


    // ================= 掃描（scan_c_behavior／_generic_scan_behavior 的單檔版）=================
    const BLOCK_MARGIN = /^\s*\*+\s?/;
    function leadingCommentText(fnNode, src) {
        let prev = fnNode.previousSibling;
        if (!prev || !prev.type.includes('comment')) return null;
        const comments = [prev]; let node = prev.previousSibling;
        while (node && node.type.includes('comment') && node.endPosition.row >= comments[comments.length - 1].startPosition.row - 1) { comments.push(node); node = node.previousSibling; }
        comments.reverse();
        const lines = [];
        for (const c of comments) {
            const text = T(c, src);
            if (text.startsWith('/*')) { let inner = text.slice(2); if (inner.endsWith('*/')) inner = inner.slice(0, -2); for (const rl of inner.split('\n')) { const cl = rl.replace(BLOCK_MARGIN, '').trim(); if (cl) lines.push(cl); } }
            else if (text.startsWith('//')) { const cl = text.replace(/^\/\/[\/!]*/, '').trim(); if (cl) lines.push(cl); }   // ///（Rust／C# 文件註解）、//!
            else if (text.startsWith('--[[')) { let inner = text.slice(4); if (inner.endsWith(']]')) inner = inner.slice(0, -2); for (const rl of inner.split('\n')) { const cl = rl.trim(); if (cl) lines.push(cl); } }   // Lua 區塊註解
            else if (text.startsWith('--')) { const cl = text.replace(/^-{2,}/, '').trim(); if (cl) lines.push(cl); }   // Lua／SQL
            else if (text.startsWith('#')) { const cl = text.replace(/^#+/, '').trim(); if (cl) lines.push(cl); }
            else if (text.startsWith('=begin')) { for (const rl of text.split('\n').slice(1)) { if (/^=end/.test(rl)) break; const cl = rl.trim(); if (cl) lines.push(cl); } }   // Ruby 區塊註解
            else { const cl = text.trim(); if (cl) lines.push(cl); }
        }
        // C# XML 文件註解：只留 <summary>，沒有就把標籤拿掉
        let joined = lines.join(' ');
        if (/<\/?(summary|param|returns|remarks|example|see|c|code)\b/i.test(joined)) { const sm = /<summary>([\s\S]*?)<\/summary>/i.exec(joined); joined = (sm ? sm[1] : joined).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
        return joined || null;
    }
    // Python：函式的 docstring（函式本體第一個字串）也算說明
    function pythonDocstring(fnNode, src) {
        const body = firstKid(fnNode, 'block'); if (!body) return null;
        const first = kids(body)[0]; if (!first || first.type !== 'expression_statement') return null;
        const s = kids(first)[0]; if (!s || s.type !== 'string') return null;
        return T(s, src).replace(/^[rRuUbBfF]*("""|'''|"|')/, '').replace(/("""|'''|"|')$/, '').replace(/\s+/g, ' ').trim() || null;
    }
    function jsdocText(fnNode, src) {
        let n = fnNode; while (n.parent && ['export_statement', 'variable_declarator', 'lexical_declaration', 'variable_declaration'].indexOf(n.parent.type) >= 0) n = n.parent;
        return leadingCommentText(n, src);
    }
    function docOf(fnNode, src, language) {
        if (language === 'python') { const d = pythonDocstring(fnNode, src); if (d) return d; }
        if (language === 'javascript') return jsdocText(fnNode, src);
        return leadingCommentText(fnNode, src);
    }
    function preprocessorGuards(fnNode, guardTypes, src) {
        const guards = []; let node = fnNode.parent;
        while (node) { if (guardTypes.has(node.type)) { let cond = null; for (const c of kids(node)) if (['identifier', 'binary_expression', 'preproc_defined', 'unary_expression'].indexOf(c.type) >= 0) { cond = T(c, src); break; } guards.push(cond ? node.type + ': ' + cond : node.type); } node = node.parent; }
        return guards.reverse();
    }
    function firstStringLiteralArg(callNode) { const al = firstKid(callNode, 'argument_list'); if (!al) return null; const f = kids(al).find((c) => c.type !== '(' && c.type !== ')' && c.type !== ','); return f && f.type === 'string_literal' ? f : null; }
    const PATH_ARG_CALLS = S(['open', 'open64', 'openat', 'fopen', 'freopen', 'creat']), ENV_ARG_CALLS = S(['getenv', 'secure_getenv']), SHELL_STR_CALLS = S(['system', 'popen']);
    function findCallsByName(fnNode, src, names) { const calls = []; collect(fnNode, 'call_expression', calls); return calls.filter((c) => names.has(cCallName(c, src))); }
    function detectPaths(fnNode, src, rules) { const hits = []; for (const c of findCallsByName(fnNode, src, PATH_ARG_CALLS)) { const a = firstStringLiteralArg(c); if (!a) continue; const text = unquote(T(a, src)); for (const r of rules) if (text.startsWith(r.prefix)) { hits.push({ path: text, call: cCallName(c, src), category: r.category, line: row(c) + 1 }); break; } } return hits; }
    function detectEnv(fnNode, src, rules) { const by = {}; rules.forEach((r) => { by[r.name] = r; }); const hits = []; for (const c of findCallsByName(fnNode, src, ENV_ARG_CALLS)) { const a = firstStringLiteralArg(c); if (!a) continue; const text = unquote(T(a, src)); const r = by[text]; if (r) hits.push({ name: text, call: cCallName(c, src), category: r.category, line: row(c) + 1 }); } return hits; }
    function tokenizeShellLine(text) { const cmds = []; for (const seg of text.split(/\|\||&&|[|;]/)) { const tokens = seg.trim().split(/\s+/).filter(Boolean); let idx = 0; while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx])) idx++; if (idx < tokens.length) cmds.push(tokens[idx].split('/').pop()); } return cmds; }
    function detectShellCmds(fnNode, src, shellLookup) { const hits = []; for (const c of findCallsByName(fnNode, src, SHELL_STR_CALLS)) { const a = firstStringLiteralArg(c); if (!a) continue; const text = unquote(T(a, src)); const commands = tokenizeShellLine(text); const matched = {}; for (const cmd of commands) { const cat = shellLookup[cmd]; if (cat) (matched[cat] = matched[cat] || new Set()).add(cmd); } const mc = {}; for (const [k, v] of Object.entries(matched)) mc[k] = sorted(v); hits.push({ call: cCallName(c, src), line: row(c) + 1, command_line: text, commands, matched_categories: mc }); } return hits; }
    // 一個檔案裡所有函式的掃描結果。profile：PROFILES[x]；language：taxonomy 用的語言名稱
    function uniqStr(a) { return Array.from(new Set(a.filter(Boolean))); }
    function scanTree(root, src, profile, tx, opts) {
        opts = opts || {}; const language = profile.language; const lookup = lookupFor(tx, profile.table_language || language);
        const cf = (tx.control_flow_nodes || {})[language] || {}; const branchTypes = S(cf.branch), loopTypes = S(cf.loop);
        const sig = tx.structural_signals || {};
        const asmTypes = S((sig.inline_assembly || {})[language]), guardTypes = S((sig.preprocessor_conditional || {})[language]);
        const sigTypes = {}; for (const [name, per] of Object.entries(sig)) { const set = S((per || {})[language]); if (set.size) sigTypes[name] = set; }
        const aLk = asmLookup(tx); const pathRules = tx.well_known_paths || [], envRules = tx.well_known_env_vars || []; const shellLookup = lookupFor(tx, 'shell');
        let fnNodes = []; collectTypes(root, profile.function_node_types, fnNodes);
        let wholeName = null; if (!fnNodes.length && opts.wholeFile) { fnNodes = [root]; wholeName = opts.path || '(file)'; }
        const functions = []; const unclassified = Object.create(null);
        for (const fn of fnNodes) {
            const name = wholeName || (language === 'c' ? cFunctionName(fn, src) : (language === 'javascript' ? jsFunctionNameBehavior(fn, src) : profile.get_function_name(fn, src, profile)));
            if (!name) continue;
            const callNodes = []; collectTypes(fn, profile.call_node_types, callNodes);
            const behaviors = {}; let callCount = 0; const allCalls = [];
            for (const c of callNodes) {
                const cands = profile.get_call_candidates(c, src); if (!cands || !cands.length) continue;
                callCount++; allCalls.push(cands[0]);
                // 接收者後面的單字泛用方法名（x.get／x.size／x.join／x.put…）不分類：太多物件有同名方法，會把 map.get 當成並行、names.size 當成檔案。
                // 要名稱夠特別（有大寫或底線、或長度 >= 9）、或語言明列放行（bare_ok）才算；沒有接收者的呼叫（open／print）和帶限定的名稱（Files.exists）不受影響。
                const skipBare = (cd) => profile.bare_specific && cands.length > 1 && cd !== cands[0] && cd.indexOf('.') < 0 && cd.indexOf('::') < 0 && !/[A-Z_]/.test(cd) && cd.length < 9 && !(profile.bare_ok && profile.bare_ok.has(cd));
                let cat = null; for (const cd of cands) { if (skipBare(cd)) continue; cat = lookup[cd]; if (cat) break; }
                if (cat) (behaviors[cat] = behaviors[cat] || new Set()).add(cands[0]); else if (!((profile.ignore_names && cands.some((cd) => profile.ignore_names.has(cd))) || (profile.ignore_prefixes && cands.some((cd) => profile.ignore_prefixes.some((pf) => cd.startsWith(pf)))))) unclassified[cands[0]] = (unclassified[cands[0]] || 0) + 1; // ignore_names：語言裡到處都是的小呼叫（Ok／Some／.clone…）不列進「未分類」
            }
            // 語法樹裡 ERROR 的區段（原始碼有語法錯誤，或文法不認得新語法）：裡面的呼叫沒有節點可用，改用文字比對，只補「查得到分類」的（不猜、不列入未分類）
            const errNodes = []; collectTypes(fn, new Set(['ERROR']), errNodes); let errCalls = 0;
            if (errNodes.length) {
                const seenErr = new Set();
                for (const en of errNodes) {
                    const txt = String(src.slice(en.startIndex, Math.min(en.endIndex, en.startIndex + 4000)) || '');
                    for (const m of txt.matchAll(/([A-Za-z_]\w*(?:(?:\.|::|->)[A-Za-z_]\w*)*)\s*\(/g)) {
                        const full = m[1].replace(/->/g, '.'), segs = full.split(/\.|::/), last = segs[segs.length - 1];
                        const cds = uniqStr([full, segs.length > 1 ? segs.slice(-2).join('.') : null, segs.length > 1 ? '.' + last : null, last]);
                        let cat = null, hit = null; for (const cd of cds) { if (profile.bare_specific && cd === last && segs.length > 1 && !/[A-Z_]/.test(last) && last.length < 9 && !(profile.bare_ok && profile.bare_ok.has(last))) continue; if (lookup[cd]) { cat = lookup[cd]; hit = cd; break; } }
                        if (cat && !seenErr.has(full)) { seenErr.add(full); errCalls++; (behaviors[cat] = behaviors[cat] || new Set()).add(full + '（語法錯誤區段）'); }
                    }
                }
            }
            const branch = countTypes(fn, branchTypes), loop = countTypes(fn, loopTypes);
            const asmBlocks = [];
            if (asmTypes.size) {
                const idiomArchs = Object.keys(tx.assembly_idioms || {}); const asmNodes = []; collectTypes(fn, asmTypes, asmNodes);
                for (const an of asmNodes) {
                    const mnemonics = extractAsmMnemonics(cAsmTemplateText(an, src)); const matchedCats = {}, matchedArchs = {}, meta = {};
                    for (const m of mnemonics) for (const [arch, cat, fmt, desc] of lookupAsmMnemonic(aLk, m)) { (matchedCats[cat] = matchedCats[cat] || new Set()).add(m); matchedArchs[arch] = (matchedArchs[arch] || 0) + 1; if (fmt || desc) meta[m] = { format: fmt, description: desc }; }
                    const idioms = []; const seen = new Set();
                    for (const arch of idiomArchs) { if (!(arch in matchedArchs)) continue; for (const id of recognizeIdioms(mnemonics, tx.assembly_idioms[arch])) { const k = id.start_index + '|' + id.name; if (seen.has(k)) continue; seen.add(k); idioms.push(Object.assign({}, id, { arch })); } }
                    const mc = {}; for (const [k, v] of Object.entries(matchedCats)) mc[k] = sorted(v);
                    asmBlocks.push({ line: row(an) + 1, mnemonics, matched_categories: mc, matched_archs: matchedArchs, mnemonic_info: meta, idioms });
                    for (const [cat, ms] of Object.entries(matchedCats)) if (tx.categories[cat]) { const set = behaviors[cat] = behaviors[cat] || new Set(); ms.forEach((x) => set.add('asm:' + x)); }
                    if (!Object.keys(matchedCats).length) (behaviors.low_level_hardware = behaviors.low_level_hardware || new Set()).add('asm:__unclassified_mnemonics__');
                }
            }
            const guards = guardTypes.size ? preprocessorGuards(fn, guardTypes, src) : [];
            let devPaths = [], envHits = [], shellCmds = [];
            if (language === 'c') {
                devPaths = detectPaths(fn, src, pathRules); devPaths.forEach((h) => { if (tx.categories[h.category]) (behaviors[h.category] = behaviors[h.category] || new Set()).add('devpath:' + h.path); });
                envHits = detectEnv(fn, src, envRules); envHits.forEach((h) => { if (tx.categories[h.category]) (behaviors[h.category] = behaviors[h.category] || new Set()).add('envvar:' + h.name); });
                shellCmds = detectShellCmds(fn, src, shellLookup); shellCmds.forEach((b) => { for (const [cat, cmds] of Object.entries(b.matched_categories)) if (tx.categories[cat]) cmds.forEach((c) => (behaviors[cat] = behaviors[cat] || new Set()).add('shell:' + c)); });
            }
            const structural = {}; for (const [sn, ts] of Object.entries(sigTypes)) { const n = countTypes(fn, ts); if (n) structural[sn] = n; }
            const bh = {}; for (const [k, v] of Object.entries(behaviors)) bh[k] = sorted(v);
            const doc = docOf(fn, src, language);
            functions.push({ name, line: row(fn) + 1, end_line: fn.endPosition.row + 1, line_count: fn.endPosition.row - fn.startPosition.row + 1, behaviors: bh, call_count: callCount, branch_count: branch, loop_count: loop, complexity: 1 + branch + loop, inline_asm: asmBlocks, preprocessor_guards: guards, device_paths: devPaths, env_vars: envHits, embedded_shell_commands: shellCmds, structural_signals: structural, has_leading_comment: !!(fn.previousSibling && fn.previousSibling.type.includes('comment')), leading_comment_text: doc, all_calls: sorted(new Set(allCalls)), _node: fn });
        }
        // 這個檔案自己定義的函式（含建構子）被呼叫，不算「還不認得」
        const definedHere = new Set(functions.map((f) => String(f.name).split(/[.:]+/).pop()));
        for (const k of Object.keys(unclassified)) if (definedHere.has(k.replace(/^(?:this|base)\./, '').split(/[.:]+/).pop())) delete unclassified[k];
        return { functions, unclassified: Object.entries(unclassified).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) };
    }

    // ================= API 語意（apisemantics_tools）=================
    const OPS = { '<': (v, n) => v < n, '<=': (v, n) => v <= n, '>': (v, n) => v > n, '>=': (v, n) => v >= n, '==': (v, n) => v === n, '!=': (v, n) => v !== n };
    const PROBE = { '<': [-1, -100], '<=': [0, -1], '>': [1, 100], '>=': [0, 1], '==': [0], '!=': [-1, 1] };
    const CONST_INT = { MPI_SUCCESS: 0, cudaSuccess: 0, CUDA_SUCCESS: 0, CUBLAS_STATUS_SUCCESS: 0, CUDNN_STATUS_SUCCESS: 0, CUSPARSE_STATUS_SUCCESS: 0, CUSOLVER_STATUS_SUCCESS: 0, ERROR_SUCCESS: 0, S_OK: 0, STATUS_SUCCESS: 0, NO_ERROR: 0, EXIT_SUCCESS: 0, EXIT_FAILURE: 1, SOCKET_ERROR: -1, EOF: -1, FALSE: 0, TRUE: 1, NULL: 0, false: 0, true: 1, nullptr: 0, WAIT_OBJECT_0: 0, WAIT_TIMEOUT: 258, WAIT_FAILED: -1 };
    function parseIntLit(s) { if (Object.prototype.hasOwnProperty.call(CONST_INT, s)) return CONST_INT[s]; if (/^-?0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16); if (/^-?\d+$/.test(s)) return parseInt(s, 10); if (/^-?0[0-7]+$/.test(s)) return parseInt(s, 8); return null; }
    function parseCondition(text) {
        text = text.trim(); if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim();
        let m = /^!\s*([A-Za-z_]\w*)$/.exec(text); if (m) return [m[1], 'falsy', null];
        m = /^([A-Za-z_]\w*)$/.exec(text); if (m) return [m[1], 'truthy', null];
        m = /^([A-Za-z_]\w*)\s*(==|!=|<=|>=|<|>)\s*(-?\w+)$/.exec(text);
        if (m) { const iv = parseIntLit(m[3]); return [m[1], m[2], iv !== null ? iv : m[3]]; }
        return null;
    }
    function ruleMatches(condOp, condValue, when) {
        const ro = when.op, rv = when.value;
        if (condOp === 'truthy' || condOp === 'falsy') { if (ro === condOp) return true; if ((ro in OPS) && typeof rv === 'number') return condOp === 'falsy' ? OPS[ro](0, rv) : [1, -1, 100].some((p) => OPS[ro](p, rv)); return false; }
        if (typeof condValue === 'string' || typeof rv === 'string') return condOp === ro && condValue === rv && condOp === '==';
        if (!(ro in OPS)) return false;
        return (PROBE[condOp] || [0]).map((o) => condValue + o).some((p) => OPS[ro](p, rv));
    }
    function matchedReturnMeanings(callName, op, value, api) { const spec = api[callName]; if (!spec || !spec.return) return []; const rules = spec.return.rules || []; return uniq(rules.filter((r) => ruleMatches(op, value, r.when || {})).map((r) => r.meaning)); }
    function explainCondition(condText, varCallNames, api) { const p = parseCondition(condText); if (!p) return null; const [v, op, val] = p; const cn = varCallNames[v]; if (!cn) return null; const m = matchedReturnMeanings(cn, op, val, api); if (!m.length) return null; return 'since `' + v + '` is ' + cn + "()'s return value: " + m.join('; or '); }
    function explainDirectCallCondition(callName, op, value, api) { const m = matchedReturnMeanings(callName, op, value, api); if (!m.length) return null; return 'since this is ' + callName + "()'s return value: " + m.join('; or '); }
    const ENUM_MEANING = /^(.*?)\(\s*(?:e\.g\.[,]?\s*)?(.+?)\s*\)\s*$/s, ENUM_ENTRY = /([A-Za-z0-9_]+(?:\s*\|\s*[A-Za-z0-9_]+)*)\s*=\s*/g, CONSTANT = /^(?:-?\d+|[A-Z][A-Z0-9_]*(?:\|[A-Z][A-Z0-9_]*)*)$/;
    const normalizeOr = (t) => t.trim().replace(/\s*\|\s*/g, '|');
    function parseEnumMeaning(inner) { const ms = Array.from(inner.matchAll(ENUM_ENTRY)); const entries = []; ms.forEach((m, i) => { const token = normalizeOr(m[1]); const start = m.index + m[0].length; const end = i + 1 < ms.length ? ms[i + 1].index : inner.length; entries.push([token, inner.slice(start, end).trim().replace(/[,;]+$/, '').trim()]); }); return entries; }
    function disambiguate(meaning, argText) {
        const m = ENUM_MEANING.exec(meaning); if (!m) return meaning; const base = m[1].trim(), inner = m[2]; const entries = parseEnumMeaning(inner); if (!entries.length) return meaning;
        const na = normalizeOr(argText); if (!CONSTANT.test(na)) return meaning; const lk = Object.fromEntries(entries);
        if (na in lk) return base + ', ' + lk[na];
        if (na.includes('|')) { const comps = na.split('|'); const descs = comps.filter((c) => c in lk).map((c) => lk[c]); if (descs.length && descs.length === comps.length) return base + ', ' + descs.join(' + '); }
        return meaning;
    }
    function callArguments(callNode, src) { const al = kids(callNode).find((c) => c.type === 'argument_list' || c.type === 'arguments'); if (!al) return []; return kids(al).filter((a) => a.type !== '(' && a.type !== ')' && a.type !== ',').map((a) => T(a, src)); }
    function callReceiverText(callNode, src) { const func = kids(callNode)[0]; if (!func) return null; let obj = null; if (func.type === 'member_expression') obj = func.childForFieldName('object'); else if (func.type === 'field_expression' && kids(func).length >= 2) obj = kids(func)[0]; else if (func.type === 'attribute') obj = func.childForFieldName('object'); if (!obj || obj.type === 'call_expression' || obj.type === 'new_expression') return null; return T(obj, src); }
    function explainCall(callNode, callName, src, api) {
        const spec = api[callName]; if (!spec) return null; const args = callArguments(callNode, src); const params = spec.parameters || []; const entries = [];
        args.forEach((a, i) => { if (i < params.length) entries.push(params[i].name + '=`' + a + '` (' + disambiguate(params[i].meaning, a) + ')'); else entries.push('`' + a + '`'); });
        let summary = spec.summary || '';
        if (summary.includes('{receiver}')) { const r = callReceiverText(callNode, src); summary = summary.split('{receiver}').join(r ? '`' + r + '`' : 'it'); }
        if (!entries.length) return summary + ' No arguments.';
        return summary + '\nArguments here:\n' + entries.map((e) => '- ' + e).join('\n');
    }

    // ================= 逐行追蹤（linetrace_tools）=================
    const NORMALIZE_KIND = { enhanced_for_statement: 'for_statement', for_in_statement: 'for_statement', c_style_for_statement: 'for_statement', foreach_statement: 'for_statement', switch_expression: 'switch_statement', match_statement: 'switch_statement', case_statement: 'switch_statement', elif_clause: 'if_statement', elseif_clause: 'if_statement', if_expression: 'if_statement', for_expression: 'for_statement', while_expression: 'while_statement', loop_expression: 'while_statement', match_expression: 'switch_statement', expression_switch_statement: 'switch_statement', type_switch_statement: 'switch_statement', select_statement: 'switch_statement', for_range_loop: 'for_statement', for_each_statement: 'for_statement', for_numeric_statement: 'for_statement', for_generic_statement: 'for_statement', repeat_statement: 'do_statement', if: 'if_statement', unless: 'if_statement', elsif: 'if_statement', if_modifier: 'if_statement', unless_modifier: 'if_statement', while: 'while_statement', until: 'while_statement', while_modifier: 'while_statement', until_modifier: 'while_statement', for: 'for_statement', case: 'switch_statement' };
    const normKind = (t) => NORMALIZE_KIND[t] || t;
    const CONTROL_KINDS = S(['if_statement', 'for_statement', 'while_statement', 'do_statement', 'switch_statement']);
    const headerText = (n, src) => T(n, src).split('\n', 1)[0].trim();
    function statementText(n, src, max) { max = max || 120; const text = T(n, src).trim(); const first = text.split('\n', 1)[0]; if (text.split('\n').length > 1 || first.length < text.length) return first.length > max ? first.slice(0, max) + ' ...' : first + ' ...'; return first.slice(0, max); }
    function childCond(node, src, p) { const c = p.get_condition_node(node, src, p); return c ? T(c, src).trim() : ''; }
    function cStyleForClauses(node, src) {
        const po = kids(node).find((c) => c.type === '('), pc = kids(node).find((c) => c.type === ')'); if (!po || !pc) return ['', '', ''];
        const lo = po.endIndex, hi = pc.startIndex; const semis = []; collect(node, ';', semis); const sp = semis.map((s) => s.startIndex).filter((x) => x >= lo && x < hi).sort((a, b) => a - b).slice(0, 2);
        const b = [lo].concat(sp, [hi]); while (b.length < 4) b.splice(b.length - 1, 0, b[b.length - 1]);
        const texts = []; for (let i = 0; i < 3; i++) { const s = i === 0 ? b[i] : b[i] + 1; texts.push(src.slice(s, b[i + 1]).trim()); } return texts;
    }
    function cStyleForExplanation(node, src) {
        const [i, c, u] = cStyleForClauses(node, src);
        if (!i && !c && !u) return 'Infinite loop (no condition of its own) - runs until an explicit break/return inside it.';
        const parts = []; if (i) parts.push('starts with `' + i + '`'); if (c) parts.push('continues while `' + c + '` holds'); else parts.push('has no exit condition of its own (relies on an explicit break/return)'); if (u) parts.push('runs `' + u + '` after each iteration');
        return 'Loop that ' + parts.join(', ') + '.';
    }
    const FOREACH_SKIP = S(['for', 'foreach', 'while', 'let', 'const', 'var', '(', ')', ':']);
    function foreachParts(node, src, p) {
        if (node.type === 'for_range_loop') { const d = node.childForFieldName('declarator'), r = node.childForFieldName('right'); return [d ? T(d, src).trim() : null, r ? T(r, src).trim() : null]; }
        const ch = kids(node); const ii = ch.findIndex((c) => c.type === 'in' || c.type === 'of'); if (ii < 0) return [null, null];
        const before = ch.slice(0, ii).filter((c) => !FOREACH_SKIP.has(c.type)); const v = before.map((c) => T(c, src)).join(' ').trim(); const after = [];
        for (const c of ch.slice(ii + 1)) { if (p.body_node_types.has(c.type) || c.type === ')') break; if (c.type === ';' || c.type === ':') continue; after.push(c); }
        return [v || null, after.map((c) => T(c, src)).join(' ').trim() || null];
    }
    function controlExplanation(node, src, p, nk) {
        if (p.control_explain) { const ce = p.control_explain(node, src, nk); if (ce) return ce; }
        if (nk === 'for_statement') { if (p.foreach_for_types.has(node.type)) { const [v, it] = foreachParts(node, src, p); if (it) return v ? 'For each `' + v + '` in `' + it + '`:' : 'For each element in `' + it + '`:'; return 'For each element in the collection/range:'; } return cStyleForExplanation(node, src); }
        const cond = childCond(node, src, p);
        if (nk === 'while_statement') return cond ? 'Loops while `' + cond + '` holds.' : 'Loops based on its own condition (see header text).';
        if (nk === 'do_statement') return 'Runs the loop body at least once, then repeats' + (cond ? ' while `' + cond + '` holds' : '') + ' (condition checked at the END of each pass).';
        if (nk === 'switch_statement') return cond ? 'Branches based on the value of `' + cond + '`.' : 'Branches on its own subject expression (see header text).';
        if (nk === 'if_statement') return cond ? 'Branches on: `' + cond + '`.' : 'Branches on its own condition (see header text).';
        return '';
    }
    function realBodyChildren(node, p) { let ch = kids(node).filter((c) => c.type !== '{' && c.type !== '}' && c.type !== ':' && c.childCount > 0); while (ch.length === 1 && p.transparent_types.has(ch[0].type)) ch = kids(ch[0]).filter((c) => c.type !== '{' && c.type !== '}' && c.type !== ':' && c.childCount > 0); return ch; }
    function isControlTransfer(stmt, src, p) { if (p.control_transfer_types.has(stmt.type)) return true; const calls = []; collectTypes(stmt, p.call_node_types, calls); for (const c of calls) { const n = p.get_call_name(c, src); if (p.noreturn_calls.has(n) || p.control_transfer_call_names.has(n)) return true; } return false; }
    function isGuardClause(ifNode, src, p) { const [cons, els] = p.get_if_branches(ifNode, p, src); if (els || !cons) return false; const rc = p.body_node_types.has(cons.type) ? realBodyChildren(cons, p) : [cons]; if (!rc.length) return false; return isControlTransfer(rc[rc.length - 1], src, p); }
    function isCStyleForEmpty(node) { let inside = false; for (const c of kids(node)) { if (c.type === '(') { inside = true; continue; } if (c.type === ')') break; if (inside && c.type !== ';') return false; } return true; }
    function isInfiniteLoop(node, src, p) { if (p.is_infinite_loop) return p.is_infinite_loop(node, src, p); if (p.foreach_for_types.has(node.type)) return false; if (p.c_style_for_types.has(node.type)) return isCStyleForEmpty(node); const c = p.get_condition_node(node, src, p); if (!c) return false; return p.infinite_loop_texts.has(T(c, src).trim()); }
    // C 專用：條件裡直接比較函式回傳值、變數曾經是某個函式的回傳值
    const FLIP = { '<': '>', '<=': '>=', '>': '<', '>=': '<=', '==': '==', '!=': '!=' };
    function literalValue(node, src) { const t = T(node, src).trim(); const v = parseIntLit(t); return v !== null ? v : t; }
    function extractConditionCall(cond, src) {
        if (!cond) return null; const ks = kids(cond);
        if (cond.type === 'call_expression') return [cond, 'truthy', null];
        if (cond.type === 'unary_expression' && ks.length === 2) { if (ks[0].type === '!' && ks[1].type === 'call_expression') return [ks[1], 'falsy', null]; return null; }
        if (cond.type === 'binary_expression' && ks.length === 3) { const [l, o, r] = ks; const op = o.type; if (!(op in FLIP)) return null; if (l.type === 'call_expression') return [l, op, literalValue(r, src)]; if (r.type === 'call_expression') return [r, FLIP[op], literalValue(l, src)]; }
        return null;
    }
    function directCallName(v, src) { if (v.type === 'call_expression') return cCallName(v, src); if (v.type === 'cast_expression') { const ks = kids(v); for (let i = ks.length - 1; i >= 0; i--) if (ks[i].type !== '(' && ks[i].type !== ')') return directCallName(ks[i], src); } return null; }
    function declIdent(node, src) { if (node.type === 'identifier') return T(node, src); for (const c of kids(node)) { const f = declIdent(c, src); if (f) return f; } return null; }
    function recordCallResultVars(stmt, src, vars) {
        if (stmt.type === 'declaration') { for (const c of kids(stmt)) if (c.type === 'init_declarator' && kids(c).length >= 3) { const id = declIdent(kids(c)[0], src); const v = kids(c)[kids(c).length - 1]; if (id) { const cn = directCallName(v, src); if (cn) vars[id] = cn; } } }
        else if (stmt.type === 'expression_statement') { const a = firstKid(stmt, 'assignment_expression'); if (a && kids(a).length >= 3 && kids(a)[1].type === '=') { const [l, , r] = kids(a); if (l.type === 'identifier') { const cn = directCallName(r, src); if (cn) vars[T(l, src)] = cn; } } }
    }
    function explainBest(callNode, cands, src, api) { for (const c of cands || []) { const e = explainCall(callNode, c, src, api); if (e) return e; } return null; }
    // 區塊上的註解：緊貼在語句前（同一行尾端或上一行）的註解節點
    function precedingCommentNote(node, src) {
        const picked = []; let sib = node.previousSibling; let edgeRow = node.startPosition.row;
        while (sib && sib.type.includes('comment') && sib.endPosition.row >= edgeRow - 1) { picked.unshift(sib); edgeRow = sib.startPosition.row; sib = sib.previousSibling; }
        if (!picked.length) { const nx = node.nextSibling; if (nx && nx.type.includes('comment') && nx.startPosition.row === node.endPosition.row) picked.push(nx); }
        if (!picked.length) return null;
        const lines = [];
        for (const c of picked) { let t = T(c, src); if (t.startsWith('/*')) { t = t.slice(2); if (t.endsWith('*/')) t = t.slice(0, -2); t = t.split('\n').map((l) => l.replace(BLOCK_MARGIN, '').trim()).filter(Boolean).join(' '); } else if (t.startsWith('--[[')) { t = t.slice(4); if (t.endsWith(']]')) t = t.slice(0, -2); t = t.split('\n').map((l) => l.trim()).filter(Boolean).join(' '); } else t = t.replace(/^(\/\/+!?|#+|;+|-{2,})\s*/, '').trim(); if (t) lines.push(t); }
        return lines.join(' ') || null;
    }
    function walkStatements(node, src, lookup, p, api, varCalls, depth, out, branch) {
        const isC = p.language === 'c';
        const proc = (child, depth, branch) => {
            if (p.transparent_types.has(child.type)) { walkStatements(child, src, lookup, p, api, varCalls, depth, out, branch); return; }
            if (p.control_statement_types.has(child.type)) {
                const nk = normKind(child.type); const calls = []; collectTypes(child, p.call_node_types, calls); const isIf = nk === 'if_statement'; let body = null, cons = null, els = null, ranges;
                if (isIf) { [cons, els] = p.get_if_branches(child, p, src); ranges = [cons, els].filter(Boolean).map((n) => [n.startIndex, n.endIndex]); }
                else { body = (p.get_control_body && p.get_control_body(child)) || kids(child).find((c) => p.body_node_types.has(c.type)) || null; ranges = body ? [[body.startIndex, body.endIndex]] : []; }
                const condCalls = calls.filter((c) => !ranges.some(([s, e]) => s <= c.startIndex && c.startIndex < e));
                const condNames = condCalls.map((c) => p.get_call_name(c, src)).filter(Boolean); const catOf = (c) => { if (p.multi_key) { for (const cd of (p.get_call_candidates(c, src) || [])) if (lookup[cd]) return lookup[cd]; return null; } const n = p.get_call_name(c, src); return n ? (lookup[n] || null) : null; };
                const entry = { line: row(child) + 1, depth, kind: nk, text: headerText(child, src), calls: condNames, categories: sorted(new Set(condCalls.map(catOf).filter(Boolean))), explanation: null, branch: branch || null, is_guard_clause: isIf && isGuardClause(child, src, p), is_infinite_loop: (nk === 'for_statement' || nk === 'while_statement' || nk === 'do_statement') && isInfiniteLoop(child, src, p), comment: precedingCommentNote(child, src) };
                const parts = [];
                if (isC && api) {
                    const cond = parenCondition(child); const dm = extractConditionCall(cond, src);
                    if (dm) { const [cn, op, val] = dm; const dname = cCallName(cn, src); if (dname) { const ce = explainCall(cn, dname, src, api); if (ce) parts.push(ce); const re = explainDirectCallCondition(dname, op, val, api); if (re) parts.push(re); } }
                    if (!parts.length) { let ct = null; const pe = firstKid(child, 'parenthesized_expression'); if (pe && ['if_statement', 'while_statement', 'do_statement', 'switch_statement'].indexOf(child.type) >= 0) { ct = T(pe, src).trim(); if (ct.startsWith('(') && ct.endsWith(')')) ct = ct.slice(1, -1).trim(); } if (ct) { const ve = explainCondition(ct, varCalls, api); if (ve) parts.push(ve); } }
                }
                if (!parts.length) { const g = controlExplanation(child, src, p, nk); if (g) parts.push(g); }
                entry.explanation = parts.join('\n') || null; out.push(entry);
                if (isIf) { if (cons) proc(cons, depth + 1, 'then'); if (els) proc(els, depth + 1, 'else'); }
                else if (body) walkStatements(body, src, lookup, p, api, varCalls, depth + 1, out, branch);
                return;
            }
            if (p.leaf_statement_types.has(child.type)) {
                const calls = []; collectTypes(child, p.call_node_types, calls); const names = calls.map((c) => p.get_call_name(c, src)).filter(Boolean); const exps = []; const catOfLeaf = (c) => { if (p.multi_key) { for (const cd of (p.get_call_candidates(c, src) || [])) if (lookup[cd]) return lookup[cd]; return null; } const n = p.get_call_name(c, src); return n ? (lookup[n] || null) : null; };
                if (api) for (const c of calls) { const e = explainBest(c, p.get_call_candidates(c, src) || [], src, api); if (e) exps.push(e); }
                out.push({ line: row(child) + 1, depth, kind: child.type, text: statementText(child, src), calls: names, categories: sorted(new Set(calls.map(catOfLeaf).filter(Boolean))), explanation: exps.join(' ') || null, branch: branch || null, is_guard_clause: false, is_infinite_loop: false, comment: precedingCommentNote(child, src) });
                if (isC) recordCallResultVars(child, src, varCalls);
                return;
            }
            walkStatements(child, src, lookup, p, api, varCalls, depth, out, branch);
        };
        for (const c of kids(node)) proc(c, depth, branch);
    }
    // 追蹤一個函式節點：回傳 {name, path, start_line, end_line, lines[]}
    function traceFunction(fnNode, src, profile, tx, name, path) {
        const lookup = lookupFor(tx, profile.table_language || profile.language); const api = apiFor(tx, profile.table_language || profile.language); const lines = [];
        const body = profile.get_body ? profile.get_body(fnNode) : kids(fnNode).find((c) => profile.body_node_types.has(c.type));
        if (body) walkStatements(body, src, lookup, profile, api, {}, 0, lines, null);
        return { name, path: path || '', start_line: row(fnNode) + 1, end_line: fnNode.endPosition.row + 1, lines };
    }
    function buildCompoundBlockTree(lines) {
        const root = []; const stack = [[-1, null]];
        for (const entry of lines) {
            const depth = entry.depth; while (stack[stack.length - 1][0] >= depth) stack.pop();
            const parent = stack[stack.length - 1][1]; const node = Object.assign({}, entry); let target;
            if (!parent) target = root; else if (parent.kind === 'if_statement' && entry.branch === 'else') target = parent.else_children = parent.else_children || []; else target = parent.children;
            if (CONTROL_KINDS.has(node.kind)) { node.children = []; target.push(node); stack.push([depth, node]); } else target.push(node);
        }
        return root;
    }


    // ================= 由下而上的敘事（linetrace_tools：fold／render）=================
    const INCREMENT_RE = /^(?:(\+\+|--)\s*(\*{0,2}[\w.$\[\]]+)|(\*{0,2}[\w.$\[\]]+)\s*(\+\+|--))$/;
    const COMPOUND_RE = /^(\*{0,2}[\w.$\[\]]+)\s*(\+=|-=|\*=|\/=|%=|\|=|&=|\^=)\s*(.+)$/;
    const PLAIN_RE = /^(\*{0,2}[\w.$\[\]]+)\s*=(?!=)\s*(.+)$/;
    const COMPOUND_VERBS = { '+=': 'increments {lhs} by {rhs}', '-=': 'decrements {lhs} by {rhs}', '*=': 'multiplies {lhs} by {rhs}', '/=': 'divides {lhs} by {rhs}', '%=': 'sets {lhs} to its remainder modulo {rhs}', '|=': 'bitwise-ORs {rhs} into {lhs}', '&=': 'bitwise-ANDs {rhs} into {lhs}', '^=': 'bitwise-XORs {rhs} into {lhs}' };
    function fallbackAssignmentPhrase(text) {
        text = text.trim().replace(/;+$/, '').trim(); let m = INCREMENT_RE.exec(text);
        if (m) { const target = m[2] || m[3]; const op = m[1] || m[4]; return (op === '++' ? 'increments' : 'decrements') + ' `' + target + '`'; }
        m = COMPOUND_RE.exec(text); if (m) return COMPOUND_VERBS[m[2]].replace('{lhs}', '`' + m[1] + '`').replace('{rhs}', '`' + m[3] + '`');
        m = PLAIN_RE.exec(text); if (m) return 'sets `' + m[1] + '` to `' + m[2] + '`';
        return null;
    }
    function fallbackLeafPhrase(node) {
        const kind = node.kind;
        if (kind === 'return_statement') { const v = (node.text || '').slice('return'.length).trim().replace(/;+$/, '').trim(); return v ? 'returns ' + v : 'returns'; }
        if (kind === 'break_statement') return 'breaks out of the loop';
        if (kind === 'continue_statement') return 'continues to the next iteration';
        if (kind === 'goto_statement') return (node.text || '').replace(/;+$/, '');
        if (kind === 'raise_statement' || kind === 'throw_statement') return 'raises/throws ' + (node.text || '').replace(/^(raise|throw)\s*/, '').replace(/;+$/, '');
        if (kind === 'flow_control_statement') { const t = (node.text || '').trim().replace(/;+$/, ''); const fw = t.split(/\s+/)[0] || ''; if (fw === 'break') return 'breaks out of the loop'; if (fw === 'continue') return 'continues to the next iteration'; if (fw === 'return') { const v = t.slice(6).trim(); return v ? 'returns ' + v : 'returns'; } }
        if (node.calls && node.calls.length) { const c = node.calls; if (c.length === 1 && c[0] === 'break') return 'breaks out of the loop'; if (c.length === 1 && c[0] === 'continue') return 'continues to the next iteration'; if (c.length === 1 && c[0] === 'return') return 'returns'; return 'calls ' + c.map((x) => '`' + x + '()`').join(', '); }
        return fallbackAssignmentPhrase(node.text || '');
    }
    function appendCalleeNarratives(desc, calls, resolve) {
        if (!resolve || !desc) return desc; const extras = [];
        for (const cn of calls || []) { const n = resolve(cn); if (n) extras.push('`' + cn + '()` itself: ' + n); }
        if (!extras.length) return desc;
        return desc.trimEnd().replace(/\.+$/, '') + ' (' + extras.join('; ') + ')';
    }
    const MERGEABLE = /^calls (`[^`]+\(\)`(?:, `[^`]+\(\)`)*)$/;
    function oxford(items) { if (items.length === 1) return items[0]; if (items.length === 2) return items[0] + ' and ' + items[1]; return items.slice(0, -1).join(', ') + ', and ' + items[items.length - 1]; }
    function mergeLeafFragments(phrases, subject) {
        subject = subject || 'it'; if (!phrases.length) return '';
        if (phrases.length === 1) { const f = phrases[0]; return /[.)]\s*$/.test(f) ? f : f.trimEnd() + '.'; }
        const cleaned = phrases.map((p) => p.trimEnd().replace(/\.+$/, '')); const groups = [];
        for (const p of cleaned) { const m = MERGEABLE.exec(p); if (m) { const objs = m[1].split(',').map((o) => o.trim()); if (groups.length && groups[groups.length - 1][0] === 'calls') groups[groups.length - 1][1].push(...objs); else groups.push(['calls', objs]); } else groups.push([null, [p]]); }
        const clauses = groups.map(([verb, objs]) => (verb === 'calls' ? 'calls ' + oxford(objs) : objs[0]));
        if (clauses.length === 1) return subject + ' ' + clauses[0] + '.';
        return subject + ' ' + clauses.slice(0, -1).join(', ') + ', and ' + clauses[clauses.length - 1] + '.';
    }
    function conditionPhrase(node) { let text = (node.text || '').replace(/\{+$/, '').trim(); for (const kw of ['if', 'while', 'switch']) if (text.startsWith(kw + ' ')) { text = text.slice(kw.length).trim(); break; } if (text.startsWith('(') && text.endsWith(')')) text = text.slice(1, -1).trim(); return text; }
    function emptyNarrativeMessage(lines) { return !lines.length ? '(empty function body)' : '(no call/return/branch to narrate - see the ' + lines.length + ' line-by-line statement(s) below for the raw effect)'; }
    // 區塊上的註解：文字重排後取最相關的句子（跟這個區塊真正呼叫的名稱、行為分類關鍵字比對）
    function rerankComment(comment, node, maxSentences) {
        const kw = (node.calls || []).concat(node.categories || []); return rerank(comment, kw, maxSentences || 2);
    }
    const trimDot = (s) => String(s || '').trim().replace(/[。.]+$/, '');
    function foldNodes(nodes, resolve, subject, opt) {
        opt = opt || {}; const fragments = []; let leaf = [];
        const flush = () => { if (leaf.length) { fragments.push(mergeLeafFragments(leaf, subject)); leaf = []; } };
        const withNote = (node, text) => (opt.useComments !== false && node.comment ? trimDot(rerankComment(node.comment, node)) + ' (' + text.replace(/\.+$/, '') + ').' : text);
        for (const node of nodes) {
            const kind = node.kind;
            if (kind === 'if_statement') {
                flush(); let cd = node.explanation || '`' + conditionPhrase(node) + '`'; cd = appendCalleeNarratives(cd, node.calls || [], resolve);
                if (node.is_guard_clause) { const aside = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'it stops here'; fragments.push('(guard: ' + (node.comment && opt.useComments !== false ? trimDot(rerankComment(node.comment, node)) + ' — ' : '') + cd + ' -- if so, ' + aside + ')'); }
                else { const then = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'nothing further'; const els = node.else_children; const pre = node.comment && opt.useComments !== false ? trimDot(rerankComment(node.comment, node)) + ' — ' : ''; if (els && els.length) fragments.push(pre + 'Checks: ' + cd + ' If so: ' + then + ' Otherwise: ' + foldNodes(els, resolve, undefined, opt).join(' ')); else fragments.push(pre + 'Checks: ' + cd + ' If so: ' + then); }
            } else if (kind === 'for_statement' || kind === 'while_statement' || kind === 'do_statement') {
                flush(); const body = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'nothing further'; const pre = node.comment && opt.useComments !== false ? trimDot(rerankComment(node.comment, node)) + ' — ' : '';
                if (node.is_infinite_loop) fragments.push(pre + 'As its ongoing/continuous behavior: ' + body);
                else { let ld = node.explanation || '`' + conditionPhrase(node) + '`'; ld = appendCalleeNarratives(ld, node.calls || [], resolve); if (ld.trimEnd().endsWith(':')) fragments.push(pre + ld + ' ' + body); else fragments.push(pre + 'Loop: ' + ld + ' Each pass: ' + body); }
            } else if (kind === 'switch_statement') {
                flush(); const body = foldNodes(node.children || [], resolve, undefined, opt).join(' ') || 'nothing'; let sd = node.explanation || '`' + conditionPhrase(node) + '`'; sd = appendCalleeNarratives(sd, node.calls || [], resolve); fragments.push('Branches: ' + sd + ' It will ' + body);
            } else {
                let frag = node.explanation || fallbackLeafPhrase(node);
                if (frag) { frag = appendCalleeNarratives(frag, node.calls || [], resolve); frag = withNote(node, frag); if (frag.includes('\n')) { flush(); fragments.push(/\.\s*$/.test(frag) ? frag : frag.trimEnd() + '.'); } else leaf.push(frag); }
            }
        }
        flush(); return fragments;
    }
    function foldFunctionNarrative(trace, resolve, opt) {
        const tree = buildCompoundBlockTree(trace.lines); const frags = foldNodes(tree, resolve, 'This function', opt);
        return frags.length ? frags.join(' ') : emptyNarrativeMessage(trace.lines);
    }
    const firstLine = (t) => t.split('\n', 1)[0];
    const contLines = (t) => t.split('\n').slice(1);
    function bulletWithCont(first, rest) { const out = ['- ' + first]; rest.forEach((l) => out.push('  ' + l)); return out; }
    function renderNarrativeLines(nodes, resolve, opt) {
        opt = opt || {}; const out = [];
        const noteOf = (n) => (opt.useComments !== false && n.comment ? trimDot(rerankComment(n.comment, n)) : '');
        for (const node of nodes) {
            const kind = node.kind; const note = noteOf(node);
            if (kind === 'if_statement') {
                const cd = node.explanation || '`' + conditionPhrase(node) + '`';
                if (node.is_guard_clause) { out.push('<details>', '<summary>Guard: ' + (note ? note + ' — ' : '') + firstLine(cd) + '</summary>', ''); out.push(...contLines(cd)); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>', ''); }
                else {
                    out.push(...bulletWithCont((note ? note + ' — ' : '') + 'Checks: ' + firstLine(cd), contLines(cd)));
                    out.push('', '<details open>', '<summary>If so...</summary>', ''); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>');
                    if (node.else_children && node.else_children.length) { out.push('<details open>', '<summary>Otherwise...</summary>', ''); out.push(...renderNarrativeLines(node.else_children, resolve, opt)); out.push('', '</details>'); }
                    out.push('');
                }
            } else if (kind === 'for_statement' || kind === 'while_statement' || kind === 'do_statement') {
                let summary, extra = [];
                if (node.is_infinite_loop) summary = 'Ongoing/continuous behavior (repeats until an explicit break/return)';
                else { const ld = node.explanation || '`' + conditionPhrase(node) + '`'; summary = 'Loop: ' + firstLine(ld); extra = contLines(ld); }
                out.push('<details open>', '<summary>' + (note ? note + ' — ' : '') + summary + '</summary>', ''); out.push(...extra); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>', '');
            } else if (kind === 'switch_statement') {
                const sd = node.explanation || '`' + conditionPhrase(node) + '`';
                out.push('<details open>', '<summary>Branches: ' + firstLine(sd) + '</summary>', ''); out.push(...contLines(sd)); out.push(...renderNarrativeLines(node.children || [], resolve, opt)); out.push('', '</details>', '');
            } else {
                const frag = node.explanation || fallbackLeafPhrase(node); if (!frag) continue;
                if (note) { out.push('- ' + note); out.push('  <details><summary>what it does</summary>', ''); out.push(...frag.split('\n').map((l) => '  ' + l)); out.push('', '  </details>'); }
                else out.push(...bulletWithCont(firstLine(frag), contLines(frag)));
                if (resolve) for (const cn of node.calls || []) { const md = resolve(cn); if (md) { out.push('<details>', '<summary>`' + cn + '()` itself...</summary>', ''); out.push(...md.split('\n')); out.push('', '</details>'); } }
            }
        }
        return out;
    }
    function renderFunctionNarrativeMarkdown(trace, resolve, opt) { const tree = buildCompoundBlockTree(trace.lines); const lines = renderNarrativeLines(tree, resolve, opt); return lines.length ? lines.join('\n') : emptyNarrativeMessage(trace.lines); }

    // ================= 文字重排（engine/textrank.py）=================
    const STOP = S('the a an and or but if then else of to in on for with as by at from is are was were be been being this that these those it its into via not no so than which who whom whose what when where how also can will would should could may might do does did has have had i you he she we they them him her his our your their there here'.split(/\s+/));
    function splitSentences(text) {
        text = String(text || '').replace(/\s+/g, ' ').trim(); if (!text) return []; const out = []; let start = 0;
        for (let i = 0; i < text.length; i++) { const ch = text[i]; if ('。！？'.indexOf(ch) >= 0) { out.push(text.slice(start, i + 1).trim()); start = i + 1; } else if ('.!?'.indexOf(ch) >= 0 && (i + 1 === text.length || text[i + 1] === ' ')) { out.push(text.slice(start, i + 1).trim()); start = i + 1; } }
        if (start < text.length) out.push(text.slice(start).trim()); return out.filter(Boolean);
    }
    function embedBlock(text) {
        const filtered = text.replace(/[A-Za-z][A-Za-z0-9_'\-]*/g, (w) => (STOP.has(w.toLowerCase()) ? '' : w)).trim() || text;
        if (typeof globalThis._faSemEmbed === 'function') return globalThis._faSemEmbed(filtered, 256, typeof globalThis.FA_SEM_LEX !== 'undefined' ? globalThis.FA_SEM_LEX : undefined);
        const v = new Float32Array(256); for (const t of (filtered.toLowerCase().match(/[a-z0-9]+|[㐀-鿿]/g) || [])) { let h = 2166136261; for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } v[h % 256] += 1; } let n = 0; for (let i = 0; i < 256; i++) n += v[i] * v[i]; n = Math.sqrt(n) || 1; for (let i = 0; i < 256; i++) v[i] /= n; return v;
    }
    const cosine = (a, b) => { let s = 0; const n = Math.min(a.length, b.length); for (let i = 0; i < n; i++) s += a[i] * b[i]; return s; };
    function pagerank(adj, damping, maxIter, tol) {
        damping = damping || 0.85; maxIter = maxIter || 100; tol = tol || 1e-4; const n = adj.length; if (!n) return []; if (n === 1) return [1];
        const rs = adj.map((r) => r.reduce((a, b) => a + b, 0)); let sc = new Array(n).fill(1 / n);
        for (let it = 0; it < maxIter; it++) { const ns = []; for (let i = 0; i < n; i++) { let inc = 0; for (let j = 0; j < n; j++) { if (i === j || rs[j] === 0) continue; inc += adj[j][i] / rs[j] * sc[j]; } ns.push((1 - damping) / n + damping * inc); } let diff = 0; for (let i = 0; i < n; i++) diff += Math.abs(ns[i] - sc[i]); sc = ns; if (diff < tol) break; }
        const tot = sc.reduce((a, b) => a + b, 0) || 1; return sc.map((s) => s / tot);
    }
    function similarityGraph(blocks, minSim) { const n = blocks.length; const vs = blocks.map(embedBlock); const adj = Array.from({ length: n }, () => new Array(n).fill(0)); for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const s = cosine(vs[i], vs[j]); if (s >= minSim) { adj[i][j] = s; adj[j][i] = s; } } return adj; }
    function rankBlocks(blocks, minSim) { const n = blocks.length; if (!n) return []; const sc = pagerank(similarityGraph(blocks, minSim === undefined ? 0.05 : minSim)); return blocks.map((t, i) => ({ index: i, text: t, score: sc[i] })); }
    function clusterBlocks(blocks, minSim) {
        const n = blocks.length; if (!n) return []; const adj = similarityGraph(blocks, minSim === undefined ? 0.4 : minSim); const parent = Array.from({ length: n }, (_, i) => i);
        const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
        for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (adj[i][j] > 0) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
        const groups = {}; for (let i = 0; i < n; i++) (groups[find(i)] = groups[find(i)] || []).push(i);
        return Object.values(groups).map((m) => { let rep = m[0]; if (m.length > 1) { const sub = m.map((a) => m.map((b) => adj[a][b])); const sc = pagerank(sub); rep = m[sc.indexOf(Math.max(...sc))]; } return { representative_index: rep, representative_text: blocks[rep], member_indices: m.slice().sort((a, b) => a - b), member_count: m.length }; }).sort((a, b) => b.member_count - a.member_count);
    }
    function summarizeBlocks(blocks, topN, minSim, diversity) {
        topN = topN || 5; diversity = diversity === undefined ? 0.4 : diversity; const ranked = rankBlocks(blocks, minSim); if (!ranked.length) return { summary: [], kept_count: 0, total_count: 0 };
        const vs = blocks.map(embedBlock); const cen = {}; ranked.forEach((r) => { cen[r.index] = r.score; }); const byScore = ranked.slice().sort((a, b) => b.score - a.score);
        const floor = 0.4 * (byScore[0] ? byScore[0].score : 0); let qualified = byScore.filter((r) => r.score >= floor).map((r) => r.index); if (qualified.length < topN) qualified = byScore.slice(0, topN).map((r) => r.index);
        const pool = new Set(qualified.slice(0, Math.max(topN * 3, qualified.length))); const selected = []; const remaining = new Set(pool);
        while (remaining.size && selected.length < topN) { let best = null, bv = null; for (const idx of remaining) { const red = selected.length ? Math.max(...selected.map((s) => cosine(vs[idx], vs[s]))) : 0; const val = (1 - diversity) * cen[idx] - diversity * red; if (bv === null || val > bv) { bv = val; best = idx; } } selected.push(best); remaining.delete(best); }
        const kept = selected.slice().sort((a, b) => a - b); return { summary: kept.map((i) => blocks[i]), kept_count: kept.length, total_count: blocks.length };
    }
    // 從一段文字挑出最相關的句子（保持原順序）
    function rerank(text, keywords, maxSentences) {
        const sents = splitSentences(text); if (sents.length <= (maxSentences || 2)) return sents.join(' ');
        const kw = new Set((keywords || []).map((k) => String(k).toLowerCase()).filter((k) => k.length > 1));
        const tok = (s) => new Set(s.toLowerCase().match(/[a-z_][a-z0-9_]+|[一-鿿]{2,}/g) || []); const sets = sents.map(tok);
        const score = sents.map((s, i) => { let sc = 0; for (const w of sets[i]) if (kw.has(w)) sc += 2; for (let j = 0; j < sents.length; j++) if (j !== i) { let o = 0; for (const w of sets[i]) if (sets[j].has(w)) o++; sc += o / Math.max(4, sets[i].size + sets[j].size); } return sc - i * 0.01; });
        const idx = score.map((v, i) => [v, i]).sort((a, b) => b[0] - a[0]).slice(0, maxSentences || 2).map((x) => x[1]).sort((a, b) => a - b);
        return idx.map((i) => sents[i]).join(' ');
    }
    function extractKeywords(text, topN, windowSize) {
        topN = topN || 10; windowSize = windowSize || 4; const words = [];
        for (const m of text.matchAll(/[A-Za-z][A-Za-z0-9_'\-]*|[一-鿿]+/g)) { const ch = m[0]; if (/^[一-鿿]+$/.test(ch)) { for (let i = 0; i < ch.length - 1; i++) words.push(ch.slice(i, i + 2)); } else { const l = ch.toLowerCase(); if (!STOP.has(l) && l.length > 2) words.push(l); } }
        const vocab = Array.from(new Set(words)).sort(); if (!vocab.length) return []; const idx = {}; vocab.forEach((w, i) => { idx[w] = i; }); const n = vocab.length; const adj = Array.from({ length: n }, () => new Array(n).fill(0));
        for (let i = 0; i < words.length; i++) for (let j = i + 1; j < Math.min(i + windowSize, words.length); j++) { const a = idx[words[i]], b = idx[words[j]]; if (a !== b) { adj[a][b] += 1; adj[b][a] += 1; } }
        const sc = pagerank(adj); return Array.from({ length: n }, (_, i) => i).sort((a, b) => sc[b] - sc[a]).slice(0, topN).map((i) => ({ word: vocab[i], score: sc[i] }));
    }
    const lengthUnits = (text) => { const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length; return cjk + (text.replace(/[㐀-鿿豈-﫿]+/g, ' ').match(/[A-Za-z0-9_]+/g) || []).length; };
    function selectWithinBudget(sentences, target, diversity) {
        diversity = diversity === undefined ? 0.45 : diversity; const ranked = rankBlocks(sentences); if (!ranked.length) return []; const vs = sentences.map(embedBlock); const cen = {}; ranked.forEach((r) => { cen[r.index] = r.score; });
        const remaining = new Set(sentences.map((_, i) => i)); const selected = []; let used = 0;
        while (remaining.size) { let best = null, bv = null; for (const idx of remaining) { const red = selected.length ? Math.max(...selected.map((s) => cosine(vs[idx], vs[s]))) : 0; const val = (1 - diversity) * cen[idx] - diversity * red; if (bv === null || val > bv) { bv = val; best = idx; } } const bu = lengthUnits(sentences[best]); if (selected.length && used + bu > target) break; selected.push(best); used += bu; remaining.delete(best); if (used >= target) break; }
        return selected.sort((a, b) => a - b);
    }


    // ================= 呼叫圖（callgraph_tools）：直接呼叫、函式指標回呼、vtable／struct 欄位綁定 =================
    function buildCallGraph(files) {
        // files：[{path, language, functions:[{name, line, all_calls, _node, _src}]}]
        const defs = Object.create(null), edges = Object.create(null), reverse = Object.create(null); const indirect = []; // 沒有原型：函式／呼叫名稱可能叫 toString、constructor
        for (const f of files) for (const fn of f.functions) { (defs[fn.name] = defs[fn.name] || []).push({ path: f.path, line: fn.line }); }
        for (const f of files) {
            for (const fn of f.functions) {
                const key = f.path + '::' + fn.name; const set = new Set();
                for (const c of fn.all_calls || []) { const nm = c.replace(/^.*[.:>]/, ''); if (defs[nm]) set.add(nm); }
                // 函式指標／回呼：函式名稱以「非呼叫」方式出現在引數或欄位指派（identifier 節點、父節點不是 call 的函式位置）
                if (fn._node && f.language === 'c') {
                    const stack = [fn._node];
                    while (stack.length) {
                        const n = stack.pop(); for (const ch of kids(n)) stack.push(ch);
                        if (n.type === 'identifier' && defs[T(n, f._src)] && n.parent) {
                            const p = n.parent; const nm = T(n, f._src);
                            if (p.type === 'call_expression' && p.childForFieldName('function') === n) continue;
                            if (p.type === 'function_declarator' || p.type === 'function_definition') continue;
                            if (p.type === 'argument_list') { indirect.push({ via: 'callback', from: fn.name, target: nm, line: row(n) + 1, path: f.path }); set.add(nm); }
                            else if (p.type === 'init_declarator' || p.type === 'assignment_expression' || p.type === 'initializer_pair') { const lhs = p.type === 'initializer_pair' ? (p.childForFieldName('designator') ? T(p.childForFieldName('designator'), f._src) : '') : (p.childForFieldName('left') ? T(p.childForFieldName('left'), f._src) : ''); indirect.push({ via: p.type === 'initializer_pair' ? 'vtable-field' : 'function-pointer', from: fn.name, target: nm, field: lhs, line: row(n) + 1, path: f.path }); set.add(nm); }
                        }
                    }
                }
                edges[key] = Array.from(set).sort();
                for (const t of set) (reverse[t] = reverse[t] || new Set()).add(fn.name);
            }
        }
        // 檔案層級的 struct 初始化器（vtable）：{ .open = my_open, ... }
        for (const f of files) if (f.root && f.language === 'c') {
            const stack = [f.root];
            while (stack.length) { const n = stack.pop(); for (const ch of kids(n)) stack.push(ch);
                if (n.type === 'initializer_pair') { const val = n.childForFieldName('value'); if (val && val.type === 'identifier' && defs[T(val, f._src)]) { let up = n.parent, inFn = false; while (up) { if (up.type === 'function_definition') { inFn = true; break; } up = up.parent; } if (!inFn) { const d = n.childForFieldName('designator'); indirect.push({ via: 'vtable-field', from: '(file scope)', target: T(val, f._src), field: d ? T(d, f._src) : '', line: row(n) + 1, path: f.path }); } } }
            }
        }
        const roots = []; for (const f of files) for (const fn of f.functions) if (!reverse[fn.name]) roots.push(fn.name);
        return { defs, edges, callers: Object.fromEntries(Object.entries(reverse).map(([k, v]) => [k, Array.from(v).sort()])), indirect, roots: Array.from(new Set(roots)).sort() };
    }
    // ================= 資料流（dataflow_tools）：來源→匯點的污染追蹤（單一函式內） =================
    const TAINT_SOURCES = { c: S(['recv', 'recvfrom', 'read', 'fread', 'fgets', 'getenv', 'scanf', 'gets', 'getline', 'recvmsg', 'accept']), javascript: S(['readFileSync', 'fetch', 'prompt', 'getItem']), python: S(['input', 'recv', 'read', 'readline', 'getenv']), java: S(['readLine', 'getParameter', 'getenv', 'read']), shell: S(['read']) };
    const TAINT_SINKS = { c: { system: '以 shell 執行（命令注入風險）', popen: '以 shell 執行（命令注入風險）', execve: '執行程式', execv: '執行程式', execl: '執行程式', strcpy: '字串複製（無長度檢查，緩衝區溢位風險）', strcat: '字串串接（無長度檢查）', sprintf: '格式化寫入（無長度檢查）', memcpy: '記憶體複製（長度由輸入決定時有溢位風險）', printf: '格式字串（格式字串漏洞風險）', fopen: '開檔（路徑由輸入決定）', open: '開檔（路徑由輸入決定）' }, javascript: { eval: '動態執行程式碼', Function: '動態執行程式碼', exec: '執行命令', execSync: '執行命令', spawn: '執行命令', innerHTML: '寫入 HTML（XSS 風險）', writeFileSync: '寫檔', readFileSync: '讀檔（路徑由輸入決定）' }, python: { eval: '動態執行程式碼', exec: '動態執行程式碼', system: '以 shell 執行', popen: '以 shell 執行', open: '開檔（路徑由輸入決定）', loads: '反序列化' }, java: { exec: '執行命令', forName: '動態載入類別', readObject: '反序列化', executeQuery: '資料庫查詢（SQL 注入風險）', executeUpdate: '資料庫更新（SQL 注入風險）' }, shell: { eval: '動態執行', bash: '執行命令', sh: '執行命令' } };
    function dataFlowOfTrace(trace, language) {
        const srcs = TAINT_SOURCES[language] || S([]); const sinks = TAINT_SINKS[language] || {}; const tainted = {}; const findings = [];
        const idents = (t) => (t.match(/[A-Za-z_$][\w$]*/g) || []);
        for (const e of trace.lines) {
            const t = e.text || ''; const m = /^(?:[A-Za-z_][\w\s\*<>\[\],:]*?\s+)?(\*?[A-Za-z_$][\w$]*)\s*=(?!=)\s*(.+)$/.exec(t); const rhsNames = new Set(idents(m ? m[2] : t));
            const fromSource = (e.calls || []).filter((c) => srcs.has(c.replace(/^.*[.:>]/, '')));
            if (m && (fromSource.length || Array.from(rhsNames).some((x) => tainted[x]))) { const origin = fromSource.length ? fromSource[0] + '()' : Array.from(rhsNames).find((x) => tainted[x]); tainted[m[1].replace(/^\*+/, '')] = { origin: fromSource.length ? fromSource[0] + '()' : tainted[origin].origin, line: e.line }; }
            else if (fromSource.length) { // 傳出參數（recv(fd, buf, ...)）：第二個以後的識別字視為被寫入
                const args = (/\((.*)\)/.exec(t) || [])[1]; if (args) args.split(',').slice(1).forEach((a) => { const id = (a.match(/[A-Za-z_]\w*/) || [])[0]; if (id) tainted[id] = { origin: fromSource[0] + '()', line: e.line }; });
            }
            for (const c of e.calls || []) { const nm = c.replace(/^.*[.:>]/, ''); if (sinks[nm]) { const hit = Array.from(rhsNames).filter((x) => tainted[x]); if (hit.length) findings.push({ line: e.line, sink: nm, meaning: sinks[nm], variables: hit, origin: tainted[hit[0]].origin, origin_line: tainted[hit[0]].line }); } }
        }
        return findings;
    }
    // ================= 文字格式的底層程式（組語／LLVM IR／PTX／WASM）=================
    const ASM_FN_PATTERNS = [
        [/^\s*define\s+[^@]*@([\w.$]+)\s*\(/, 'llvm'], [/^\s*\.(?:visible\s+)?\.?entry\s+([\w$.]+)/, 'ptx'], [/^\s*\.func\s+(?:\([^)]*\)\s*)?([\w$.]+)/, 'ptx'],
        [/^\s*\(func\s+\$?([\w.$]+)/, 'wasm'], [/^\s*([A-Za-z_.$][\w.$]*)\s*:\s*(?:[;#].*)?$/, 'asm'],
    ];
    function detectLowLevelKind(path, src) {
        const p = (path || '').toLowerCase(); if (/\.(ll)$/.test(p)) return 'llvm'; if (/\.ptx$/.test(p)) return 'ptx'; if (/\.(wat|wast)$/.test(p)) return 'wasm'; if (/\.(s|asm|nasm|masm)$/.test(p)) return 'asm';
        if (/^\s*define\s+.*@[\w.$]+\s*\(/m.test(src) && /\n\s*ret\b|\n\s*%\w+\s*=\s*/.test(src)) return 'llvm'; if (/^\s*\.version\s|\.visible\s+\.entry/m.test(src)) return 'ptx'; if (/^\s*\(module/m.test(src)) return 'wasm';
        return null;
    }
    function scanLowLevelText(path, src, tx, kind) {
        const lines = src.split('\n'); const fns = []; let cur = null; const aLk = asmLookup(tx);
        const commentOf = (i) => { const c = []; for (let j = i - 1; j >= 0; j--) { const t = lines[j].trim(); if (/^(;|#|\/\/)/.test(t)) c.unshift(t.replace(/^(;+|#+|\/\/+)\s?/, '')); else break; } return c.join(' ') || null; };
        const startNew = (name, i) => { if (cur) { cur.end_line = i; fns.push(cur); } cur = { name, line: i + 1, end_line: lines.length, body: [], comment: commentOf(i), blocks: [], labels: [] }; };
        for (let i = 0; i < lines.length; i++) {
            const ln = lines[i]; let hit = false;
            for (const [re, k] of ASM_FN_PATTERNS) { if ((kind === 'asm' && k !== 'asm') || (kind === 'llvm' && k !== 'llvm') || (kind === 'ptx' && k !== 'ptx') || (kind === 'wasm' && k !== 'wasm')) continue; const m = re.exec(ln); if (m) { if (k === 'asm' && cur && /^\.?L/.test(m[1])) { cur.labels.push({ name: m[1], line: i + 1, comment: commentOf(i) }); hit = true; break; } startNew(m[1], i); hit = true; break; } }
            if (hit) continue; if (!cur) continue;
            const lm = /^\s*([A-Za-z_.$%][\w.$%-]*):\s*(?:[;#].*)?$/.exec(ln); if (lm) cur.labels.push({ name: lm[1], line: i + 1, comment: commentOf(i) }); else cur.body.push({ line: i + 1, text: ln });
        }
        if (cur) fns.push(cur);
        const idiomArchs = Object.keys(tx.assembly_idioms || {});
        return fns.map((f) => {
            const mnemonics = []; const lineOf = [];
            for (const b of f.body) { const t = b.text.replace(/[;#].*$/, '').replace(/\/\/.*$/, '').trim(); if (!t || /^[.}{)]/.test(t) && kind === 'asm') continue; const w = /^(?:%[\w.]+\s*=\s*)?(?:[A-Za-z_.][\w.]*:\s*)?([A-Za-z_][\w.]*)/.exec(t); if (w) { const w1 = w[1].toLowerCase(); mnemonics.push(w1); lineOf.push(b.line); if (/^(rep|repe|repz|repne|repnz|lock)$/.test(w1)) { const rest = t.slice(t.toLowerCase().indexOf(w1) + w1.length).trim(); const w2 = /^([A-Za-z_][\w.]*)/.exec(rest); if (w2) { mnemonics.push(w2[1].toLowerCase()); lineOf.push(b.line); } } } }
            const matchedCats = {}, matchedArchs = {}; for (const m of mnemonics) for (const [arch, cat] of lookupAsmMnemonic(aLk, m)) { (matchedCats[cat] = matchedCats[cat] || new Set()).add(m); matchedArchs[arch] = (matchedArchs[arch] || 0) + 1; }
            const idioms = []; for (const arch of idiomArchs) { if (!(arch in matchedArchs)) continue; for (const id of recognizeIdioms(mnemonics, tx.assembly_idioms[arch])) idioms.push(Object.assign({ arch }, id)); }
            const behaviors = {}; for (const [c, ms] of Object.entries(matchedCats)) behaviors[c] = sorted(ms);
            return { name: f.name, line: f.line, end_line: f.end_line, line_count: f.end_line - f.line + 1, behaviors, call_count: 0, branch_count: 0, loop_count: 0, complexity: 1, inline_asm: [], preprocessor_guards: [], device_paths: [], env_vars: [], embedded_shell_commands: [], structural_signals: {}, has_leading_comment: !!f.comment, leading_comment_text: f.comment, all_calls: [], low_level: { kind, mnemonics, idioms, labels: f.labels, archs: matchedArchs, line_of: lineOf } };
        });
    }
    function lowLevelMarkdown(fn, tx) {
        const ll = fn.low_level; const out = []; const L = ll.labels; const m = ll.mnemonics; const idiomLines = ll.idioms || [];
        if (idiomLines.length) { out.push('<details open><summary>認得的 idiom（多指令組合的真正意圖）</summary>', ''); for (const id of idiomLines) out.push('- `' + id.name + '`：' + (id.template || id.description || '') + (id.arch ? '（' + id.arch + '）' : '')); out.push('', '</details>', ''); }
        const cats = Object.entries(fn.behaviors); if (cats.length) { out.push('<details open><summary>指令的行為分類</summary>', ''); for (const [c, ms] of cats) out.push('- ' + ((tx.categories[c] || {}).label || c) + '：' + ms.slice(0, 12).map((x) => '`' + x + '`').join(' ')); out.push('', '</details>', ''); }
        if (L.length) { out.push('<details><summary>基本區塊（' + L.length + ' 個標籤）</summary>', ''); for (const l of L.slice(0, 40)) out.push('- `' + l.name + '`（第 ' + l.line + ' 行）' + (l.comment ? '：' + rerank(l.comment, [], 2) : '')); out.push('', '</details>', ''); }
        if (!idiomLines.length && !cats.length) out.push('（沒有認得的指令；可用 behavior_define 補組語定義）');
        return out.join('\n');
    }
    function opCategories(ops, arch, tx) {
        const lk = asmLookup(tx); const by = {};
        for (const op of ops) for (const [a, cat, , desc] of (lk[String(op).toLowerCase()] || [])) { if (a !== arch) continue; (by[cat] = by[cat] || new Set()).add(op); }
        return by;
    }
    function opCategoryLines(ops, arch, tx) {
        const by = opCategories(ops, arch, tx); return Object.entries(by).map(([c, s]) => '- ' + ((tx.categories[c] || {}).label || c) + '：' + Array.from(s).slice(0, 14).map((x) => '`' + x + '`').join(' '));
    }
    // ================= JVM／Python byte code 文字（bytecode_tools）：javap -c 與 dis 輸出 =================
    const JVM_OPS = { invokestatic: '呼叫靜態方法', invokevirtual: '呼叫方法', invokespecial: '呼叫建構子／父類別方法', invokeinterface: '呼叫介面方法', invokedynamic: '動態呼叫（lambda／字串串接）', new: '建立物件', getfield: '讀欄位', putfield: '寫欄位', getstatic: '讀靜態欄位', putstatic: '寫靜態欄位', athrow: '丟出例外', monitorenter: '取得鎖', monitorexit: '釋放鎖', ifeq: '等於 0 則跳', ifne: '不等於 0 則跳', if_icmpeq: '整數相等則跳', if_icmpne: '整數不等則跳', goto: '無條件跳躍', ireturn: '回傳整數', areturn: '回傳物件', return: '回傳（void）', checkcast: '型別轉換檢查', instanceof: '型別判斷' };
    function parseJavap(text) {
        const methods = []; let cur = null;
        for (const ln of text.split('\n')) {
            const hm = /^\s{2,4}((?:public|private|protected|static|final|synchronized|native|abstract)\s[^;{]*?\)|[\w.<>\[\]]+\s+[\w<>$]+\([^)]*\))[^;]*;\s*$/.exec(ln);
            if (hm && !/^\s*\d+:/.test(ln)) { cur = { signature: hm[1].trim(), name: (/([\w<>$]+)\(/.exec(hm[1]) || [])[1] || hm[1], ops: [], calls: [] }; methods.push(cur); continue; }
            const om = /^\s*(\d+):\s+(\w+)\s*(.*)$/.exec(ln); if (om && cur) { cur.ops.push({ offset: +om[1], op: om[2], arg: om[3] }); const cm = /\/\/\s*(?:Method|InterfaceMethod)\s+(.+)$/.exec(om[3]); if (cm) cur.calls.push(cm[1].trim()); }
        }
        return methods;
    }
    function bytecodeMarkdown(methods, tx) {
        const lookup = lookupFor(tx, 'java'); const out = [];
        for (const m of methods) {
            out.push('<details><summary>`' + m.name + '`（' + m.ops.length + ' 個指令）</summary>', '');
            const cats = new Set(); for (const c of m.calls) { const cn = (c.split('.').pop() || '').split(':')[0].replace(/"?<init>"?/, 'new'); if (lookup[cn]) cats.add(lookup[cn]); }
            if (m.calls.length) out.push('- 呼叫：' + Array.from(new Set(m.calls)).slice(0, 12).map((c) => '`' + c + '`').join('、'));
            if (cats.size) out.push('- 行為：' + Array.from(cats).map((c) => (tx.categories[c] || {}).label || c).join('、'));
            const catLines = opCategoryLines(Array.from(new Set(m.ops.map((o) => o.op))), 'jvm', tx); if (catLines.length) { out.push('- 指令的行為分類：'); catLines.forEach((l) => out.push('  ' + l)); }
            const notable = Array.from(new Set(m.ops.map((o) => o.op))).filter((o) => JVM_OPS[o]).slice(0, 8); if (notable.length) out.push('- 指令：' + notable.map((o) => '`' + o + '`＝' + JVM_OPS[o]).join('；'));
            out.push('', '</details>', '');
        }
        return out.join('\n');
    }
    // ================= Python byte code（dis 輸出）=================
    const PYDIS_OPS = { RAISE_VARARGS: '丟出例外', RETURN_VALUE: '回傳', RETURN_CONST: '回傳常數', POP_JUMP_IF_FALSE: '條件為假則跳', POP_JUMP_IF_TRUE: '條件為真則跳', FOR_ITER: '迴圈下一個元素', SETUP_WITH: '進入 with', BEFORE_WITH: '進入 with', IMPORT_NAME: '匯入模組', STORE_ATTR: '寫屬性', DELETE_NAME: '刪除變數', YIELD_VALUE: '產出（generator）', SETUP_FINALLY: '進入 try', JUMP_BACKWARD: '往回跳（迴圈）' };
    function parsePyDis(text) {
        const fns = []; let cur = null;
        for (const ln of text.split('\n')) {
            const h = /^Disassembly of <code object (\S+) at/.exec(ln); if (h) { cur = { name: h[1], ops: [], calls: [] }; fns.push(cur); continue; }
            const m = /^\s*(?:\d+\s+)?(?:>>\s+)?(\d+)\s+([A-Z_]+)\s*(\d*)\s*(?:\((.*)\))?\s*$/.exec(ln); if (!m) continue;
            if (!cur) { cur = { name: '<module>', ops: [], calls: [] }; fns.push(cur); }
            cur.ops.push({ offset: +m[1], op: m[2], arg: m[4] || '' });
            if (/^(LOAD_GLOBAL|LOAD_NAME|LOAD_ATTR|LOAD_METHOD)$/.test(m[2]) && m[4]) cur.calls.push(m[4].replace(/^NULL \+ /, ''));
        }
        return fns;
    }
    function pyDisMarkdown(fns, tx) {
        const lookup = lookupFor(tx, 'python'); const out = [];
        for (const f of fns) {
            const calls = Array.from(new Set(f.calls)); const cats = new Set(calls.filter((c) => lookup[c]).map((c) => lookup[c]));
            out.push('## `' + f.name + '`（' + f.ops.length + ' 個指令）', '');
            if (cats.size) out.push('行為分類：' + Array.from(cats).map((c) => (tx.categories[c] || {}).label || c).join('、'), '');
            if (calls.length) out.push('<details open><summary>用到的名稱／呼叫</summary>', '', ...calls.slice(0, 30).map((c) => '- ' + c + (lookup[c] ? '：' + ((tx.categories[lookup[c]] || {}).label || lookup[c]) : '')), '', '</details>', '');
            const catLines = opCategoryLines(Array.from(new Set(f.ops.map((o) => o.op))), 'pybc', tx); if (catLines.length) out.push('指令的行為分類：', '', ...catLines, '');
            const notable = Array.from(new Set(f.ops.map((o) => o.op))).filter((o) => PYDIS_OPS[o]); if (notable.length) out.push('指令：' + notable.map((o) => o + '＝' + PYDIS_OPS[o]).join('；'), '');
        }
        return out.join('\n');
    }
    // ================= Java 設計模式（designpattern_tools）：以語法樹的類別結構判斷 =================
    function detectJavaDesignPatterns(root, src) {
        const out = []; const classes = []; collectTypes(root, S(['class_declaration', 'interface_declaration']), classes);
        for (const c of classes) {
            const nm = firstKid(c, 'identifier'); const name = nm ? T(nm, src) : '?'; const body = c.childForFieldName ? c.childForFieldName('body') : null; const text = T(c, src);
            const ctors = []; collectTypes(c, S(['constructor_declaration']), ctors); const privCtor = ctors.some((k) => /\bprivate\b/.test(T(k, src).split('{')[0]));
            const hasStaticInst = new RegExp('static\\s+(?:volatile\\s+)?' + name + '\\s+\\w+').test(text) || /\bstatic\b[^;(]*\b(instance|INSTANCE)\b/.test(text);
            if (privCtor && (hasStaticInst || /getInstance\s*\(/.test(text))) out.push({ pattern: 'Singleton', class: name, line: row(c) + 1, evidence: '私有建構子＋靜態實例' });
            if (/\bBuilder\b/.test(name) || (/return\s+this\s*;/.test(text) && /\bbuild\s*\(/.test(text))) out.push({ pattern: 'Builder', class: name, line: row(c) + 1, evidence: '鏈式 setter＋build()' });
            if (/List<\w*(Observer|Listener)\w*>|\b(addObserver|addListener|notifyObservers|fire\w+)\s*\(/.test(text)) out.push({ pattern: 'Observer', class: name, line: row(c) + 1, evidence: '觀察者清單／通知方法' });
            if (/static\s+\w[\w<>]*\s+create\w*\s*\(/.test(text) && /return\s+new\s+/.test(text) && /Factory/.test(name + text.slice(0, 200))) out.push({ pattern: 'Factory', class: name, line: row(c) + 1, evidence: 'create* 靜態方法回傳 new' });
            const impl = /\b(?:implements|extends)\s+(\w+)/.exec(text.split('{')[0]); if (impl && /\bprivate\s+(?:final\s+)?(\w+)\s+\w+\s*;/.test(text) && new RegExp('private\\s+(?:final\\s+)?' + impl[1] + '\\s+\\w+\\s*;').test(text)) out.push({ pattern: 'Decorator／Proxy', class: name, line: row(c) + 1, evidence: '實作 ' + impl[1] + ' 又持有一個 ' + impl[1] });
        }
        return out;
    }
    // ================= 參考知識的標註（FaRef）：錯誤碼常數、exit code、命令列字串、#pragma =================
    // 離線訓練器的參考知識（錯誤碼、命令、pragma，使用者與 AI 補的也算）直接用在行為說明上：同一份資料，兩邊共用。
    function pragmaNodes(root, src) { const arr = []; collectTypes(root, S(['preproc_call']), arr); return arr.map((n) => ({ line: row(n) + 1, text: T(n, src).trim() })).filter((p) => /^#\s*pragma\b/.test(p.text)); }
    function condOnly(text) { text = String(text || ''); const i = text.indexOf('('); if (i < 0) return text.split('{')[0]; let d = 0; for (let k = i; k < text.length; k++) { if (text[k] === '(') d++; else if (text[k] === ')') { d--; if (d === 0) return text.slice(0, k + 1); } } return text; }
    function annotateTrace(lines, ref, language, pragmas) {
        const used = new Set();
        for (const entry of lines) {
            const isCtl = CONTROL_KINDS.has(entry.kind);
            const notes = ref.annotateText(isCtl ? condOnly(entry.text) : (entry.text || ''), language);
            for (const p of pragmas || []) if (!used.has(p) && entry.line > p.line && p.expl) { used.add(p); notes.push('上一行 ' + p.text.replace(/^#\s*pragma\s+/, '#pragma ') + '：' + p.expl.desc + (p.expl.clauses.length ? '（' + p.expl.clauses.map((c) => c.clause).join('、') + '）' : '')); }
            if (!notes.length) continue;
            let base = entry.explanation; if (!base) base = isCtl ? '`' + conditionPhrase(entry) + '`' : fallbackLeafPhrase(entry);
            entry.explanation = base ? base + '\nNotes:\n' + notes.map((n) => '- ' + n).join('\n') : 'Notes: ' + notes.join('；');
        }
    }
    function pragmaMarkdown(list) {
        if (!list.length) return '';
        const out = ['<details open><summary>編譯指示（#pragma，' + list.length + '）</summary>', ''];
        for (const p of list) { out.push('- 第 ' + p.line + ' 行 `' + p.text + '`：' + (p.expl ? p.expl.desc : '（沒有收錄這個 pragma；可請 AI 查文件後用 ref_define 補）')); if (p.expl) for (const c of p.expl.clauses) out.push('  - `' + c.clause + '`：' + c.desc); }
        out.push('', '</details>', ''); return out.join('\n');
    }
    // ================= 總協調：把一份原始碼解釋成可折疊的 markdown =================
    const EXT_LANG = { c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp', ipp: 'cpp', cu: 'cpp', cuh: 'cpp', rs: 'rust', rust: 'rust', go: 'go', golang: 'go', glsl: 'c', frag: 'c', vert: 'c', hlsl: 'c', java: 'java', py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript', sh: 'shell', bash: 'shell', cs: 'csharp', csx: 'csharp', csharp: 'csharp', rb: 'ruby', rake: 'ruby', gemspec: 'ruby', ru: 'ruby', ruby: 'ruby', lua: 'lua' };
    function languageOfPath(path) { const m = /\.([A-Za-z0-9]+)$/.exec(path || ''); return m ? (EXT_LANG[m[1].toLowerCase()] || null) : null; }
    const FileCommentRe = /^\s*(?:\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+|(?:#[^\n]*\n?)+)/;
    function fileHeaderComment(src, language) {
        const hashOk = language === 'python' || language === 'shell' || language === 'ruby';
        if (language === 'lua') { const lm = /^\s*(?:--\[(=*)\[([\s\S]*?)\]\1\]|(?:--[^\n]*\n?)+)/.exec(src); if (!lm) return null; const raw = lm[2] != null ? lm[2] : lm[0]; return raw.split('\n').map((l) => l.replace(/^\s*-{2,}\s?/, '').trim()).filter(Boolean).join(' ') || null; }
        const m = (hashOk ? FileCommentRe : /^\s*(?:\/\*[\s\S]*?\*\/|(?:\/\/[^\n]*\n?)+)/).exec(src.replace(/^#!.*\n/, '').replace(/^# (?:frozen_string_literal|encoding|coding)[^\n]*\n/gm, '')); if (!m) return null;
        let t = m[0].split('\n').map((l) => l.replace(/^\s*(\/\*+|\*+\/|\*+|\/\/[\/!]*|#+)\s?/, '').replace(/\*\/\s*$/, '').trim()).filter(Boolean).join(' ');
        if (/<summary>/i.test(t)) { const sm = /<summary>([\s\S]*?)<\/summary>/i.exec(t); if (sm) t = sm[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); }
        return t || null;
    }
    const NOTE_LABEL = { user: 'aidoc 補充', comment: '原始碼註解', auto: '自動分析' };
    // deps.parse(language, src) → tree.rootNode（呼叫端提供 web-tree-sitter）；deps.notes[path|path::fn] 是 aidoc 的說明
    async function explainSource(path, src, opts) {
        src = String(src == null ? '' : src).replace(/\r\n/g, '\n'); // Windows 的 CRLF 會讓語法樹的錯誤恢復漏掉壞掉函式後面的函式（行號不變）
        opts = opts || {}; const tx = opts.taxonomy; const deps = opts.deps || {}; const target = opts.fn || null; const notes = Object.assign(Object.create(null), tx.__notes || {}, opts.notes || {});
        const out = []; const meta = { path, language: null, functions: 0, unclassified: [], sources: {} };
        const lowKind = detectLowLevelKind(path, src); const language = languageOfPath(path);
        const fileNote = notes[path] || notes['file::' + path]; const header = fileHeaderComment(src, language);
        out.push('# ' + path); out.push('');
        if (fileNote) { out.push('> **' + NOTE_LABEL.user + '**：' + fileNote); out.push(''); meta.sources.file = 'user'; }
        else if (header) { out.push('> **' + NOTE_LABEL.comment + '**：' + rerank(header, [], 3)); out.push(''); meta.sources.file = 'comment'; }
        // 組語系
        if (lowKind) {
            meta.language = lowKind; let fns = scanLowLevelText(path, src, tx, lowKind); if (target) fns = fns.filter((f) => f.name === target); meta.functions = fns.length;
            for (const f of fns) {
                const note = notes[path + '::' + f.name] || notes[f.name]; out.push('## `' + f.name + '`（' + lowKind + '，第 ' + f.line + '–' + f.end_line + ' 行）', '');
                if (note) { out.push('**' + NOTE_LABEL.user + '**：' + note, ''); meta.sources[f.name] = 'user'; } else if (f.leading_comment_text) { out.push('**' + NOTE_LABEL.comment + '**：' + rerank(f.leading_comment_text, f.low_level.mnemonics, 2), ''); meta.sources[f.name] = 'comment'; } else meta.sources[f.name] = 'auto';
                out.push(lowLevelMarkdown(f, tx), '');
            }
            return { markdown: out.join('\n'), meta, functions: fns };
        }
        if (/\.(javap|jvm)$/i.test(path) || /^Compiled from "|^\s*(public|private|protected)?\s*(static\s+)?class\s+[\w.]+\s*\{[\s\S]*\n\s+Code:/m.test(src)) {
            const methods = parseJavap(src); meta.language = 'jvm-bytecode'; meta.functions = methods.length; out.push(bytecodeMarkdown(methods, tx)); return { markdown: out.join('\n'), meta, functions: methods };
        }
        if (/\.dis$/i.test(path) || (!language && /^Disassembly of <code object|^\s*\d+\s+\d+\s+(?:RESUME|LOAD_CONST|LOAD_GLOBAL|LOAD_NAME)\b/m.test(src))) { const pf = parsePyDis(src); meta.language = 'python-bytecode'; meta.functions = pf.length; out.push(pyDisMarkdown(pf, tx)); return { markdown: out.join('\n'), meta, functions: pf }; }
        if (!language) return { markdown: out.join('\n') + '\n（不認得的檔案類型，無法分析）', meta, functions: [] };
        meta.language = language; const fam = language === 'cpp' ? 'c' : language; // C++：行為判斷沿用 C 的，語法樹與名稱表用 C++ 的
        if (!deps.parse) throw new Error('沒有可用的語法樹剖析器（deps.parse）');
        const root = await deps.parse(language, src); if (!root) throw new Error('語法樹剖析失敗：' + language);
        const profile = PROFILES[language]; const scan = scanTree(root, src, profile, tx, { path, wholeFile: !!opts.wholeFile });
        let fns = scan.functions.filter((f) => !(/^<anonymous/.test(f.name) && scan.functions.some((o) => o !== f && o.line <= f.line && o.end_line >= f.end_line && !/^<anonymous/.test(o.name)))); meta.unclassified = scan.unclassified.slice(0, 40).map((u) => u.name); meta.functions = fns.length;
        const ref = opts.ref || null; const allPragmas = ref && (fam === 'c') ? pragmaNodes(root, src).map((p) => Object.assign(p, { expl: ref.explainPragma(p.text) })) : [];
        const jp = language === 'java' ? detectJavaDesignPatterns(root, src) : []; const fileObj = { path, language: fam, functions: fns, root, _src: src };
        const cg = buildCallGraph([fileObj]);
        const resolveCache = Object.create(null);
        const resolveCallee = (cn) => { // 本檔內的呼叫端：取該函式自己的一句話說明（註解優先，其次行為分類）
            const nm = String(cn).replace(/^.*[.:>]/, ''); if (resolveCache[nm] !== undefined) return resolveCache[nm]; const f = fns.find((x) => x.name === nm); let r = null;
            if (f && f.name !== (cur || {}).name) { const n = notes[path + '::' + f.name] || notes[f.name]; if (n) r = n; else if (f.leading_comment_text) r = rerank(f.leading_comment_text, f.all_calls, 1); } resolveCache[nm] = r; return r;
        }; let cur = null;
        if (target) fns = fns.filter((f) => f.name === target);
        if (jp.length && !target) { out.push('<details><summary>設計模式（' + jp.length + '）</summary>', ''); for (const p of jp) out.push('- **' + p.pattern + '**：`' + p.class + '`（第 ' + p.line + ' 行；' + p.evidence + '）'); out.push('', '</details>', ''); }
        // 函式之間的關係：回呼、vtable
        if (cg.indirect.length && !target) { out.push('<details><summary>間接呼叫（函式指標／回呼／vtable，' + cg.indirect.length + '）</summary>', ''); for (const i of cg.indirect.slice(0, 30)) out.push('- 第 ' + i.line + ' 行：`' + i.target + '` 以' + ({ callback: '回呼', 'function-pointer': '函式指標', 'vtable-field': 'vtable 欄位' }[i.via]) + '被綁定' + (i.field ? '到 `' + i.field + '`' : '') + (i.from !== '(file scope)' ? '（在 `' + i.from + '`）' : '')); out.push('', '</details>', ''); }
        if (!target && fns.length > 1) { const sums = fns.map((f) => (notes[path + '::' + f.name] || f.leading_comment_text || '')).filter(Boolean); if (sums.length > 3) { const s = summarizeBlocks(sums, 3); out.push('**檔案重點**：' + s.summary.map((x) => rerank(x, [], 1)).join(' ／ '), ''); } }
        for (const f of fns) {
            cur = f; const note = notes[path + '::' + f.name] || notes[f.name]; const trace = traceFunction(f._node, src, profile, tx, f.name, path); const fnPragmas = allPragmas.filter((p) => p.line >= f.line && p.line <= f.end_line); if (ref) annotateTrace(trace.lines, ref, fam, fnPragmas);
            out.push('## `' + f.name + '`（第 ' + f.line + '–' + f.end_line + ' 行，複雜度 ' + f.complexity + '）', '');
            if (note) { out.push('**' + NOTE_LABEL.user + '**：' + note, ''); meta.sources[f.name] = 'user'; }
            else if (f.leading_comment_text) { out.push('**' + NOTE_LABEL.comment + '**：' + rerank(f.leading_comment_text, f.all_calls.concat(Object.keys(f.behaviors)), 2), ''); meta.sources[f.name] = 'comment'; }
            else meta.sources[f.name] = 'auto';
            const cats = Object.keys(f.behaviors).filter((c) => tx.categories[c]); if (cats.length) out.push('行為分類：' + cats.map((c) => tx.categories[c].label || c).join('、'), '');
            if (f.preprocessor_guards.length) out.push('編譯條件：' + f.preprocessor_guards.map((g) => '`' + g + '`').join('、'), '');
            const bodyMd = renderFunctionNarrativeMarkdown(trace, resolveCallee, { useComments: true });
            out.push('<details open><summary>由下而上的行為敘事（正向路徑為主，防呆分支已折疊）</summary>', '', bodyMd, '', '</details>', '');
            if (fnPragmas.length) out.push(pragmaMarkdown(fnPragmas));
            for (const a of f.inline_asm) if (a.idioms && a.idioms.length) { out.push('<details><summary>內嵌組合語言（第 ' + a.line + ' 行）</summary>', ''); for (const id of a.idioms) out.push('- `' + id.name + '`：' + (id.template || id.description || '')); out.push('', '</details>', ''); }
            const flows = dataFlowOfTrace(trace, fam); if (flows.length) { out.push('<details><summary>資料流警示（' + flows.length + '）</summary>', ''); for (const x of flows) out.push('- 第 ' + x.origin_line + ' 行 `' + x.origin + '` 的資料，經 `' + x.variables.join('、') + '`，到第 ' + x.line + ' 行 `' + x.sink + '()`：' + x.meaning); out.push('', '</details>', ''); f.dataflow = flows; }
            const callers = (cg.callers[f.name] || []); if (callers.length) out.push('被呼叫：' + callers.map((c) => '`' + c + '`').join('、'), '');
        }
        for (const f of scan.functions) delete f._node; delete fileObj.root;
        return { markdown: out.join('\n'), meta, functions: scan.functions.map((f) => { const c = Object.assign({}, f); delete c._node; return c; }), callgraph: cg, design_patterns: jp };
    }
    // 把 AI／使用者學到的說明寫回：notes 的鍵是 path::函式名稱 或 函式名稱
    function suggestNotes(result) { return (result.meta.unclassified || []).slice(0, 20); }


    // ================= 對外介面 =================
    // 剖析器載入：web-tree-sitter 與各語言的 wasm 由宿主提供（桌面：本機快取／CDN；網頁：CDN）。
    // host = { loadTreeSitter: async () => Parser, loadLanguageWasm: async (name) => Uint8Array|url }
    const WASM_NAME = { c: 'c', cpp: 'cpp', rust: 'rust', go: 'go', java: 'java', python: 'python', javascript: 'javascript', shell: 'bash', csharp: 'c_sharp', ruby: 'ruby', lua: 'lua' };
    function makeParser(host) {
        let ParserCls = null; const langs = {}; let parserByLang = {};
        return async function parse(language, src) {
            if (!ParserCls) { ParserCls = await host.loadTreeSitter(); }
            if (!langs[language]) { const wasm = await host.loadLanguageWasm(WASM_NAME[language] || language); langs[language] = await ParserCls.Language.load(wasm); }
            const p = parserByLang[language] || (parserByLang[language] = new ParserCls()); p.setLanguage(langs[language]);
            return p.parse(src).rootNode;
        };
    }
    function create(data, host, user) {
        let tx = makeTaxonomy(data, user); const parse = host ? makeParser(host) : null;
        return {
            setUser(u) { tx = makeTaxonomy(data, u); },
            taxonomy() { return tx; },
            languageOfPath, detectLowLevelKind,
            async explain(path, src, opts) { return explainSource(path, src, Object.assign({ taxonomy: tx, deps: { parse } }, opts || {})); },
            // 純文字工具（不需要剖析器）
            rerank, splitSentences, extractKeywords, summarizeBlocks, clusterBlocks, rankBlocks, selectWithinBudget,
            parseJavap, scanLowLevelText: (path, src, kind) => scanLowLevelText(path, src, tx, kind || detectLowLevelKind(path, src)),
        };
    }
    return { create, makeTaxonomy, languageOfPath, rerank, splitSentences, summarizeBlocks, clusterBlocks, extractKeywords, parseJavap, detectLowLevelKind };

})();
