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
    function lookupFor(tx, language) {
        if (tx.__lookupCache[language]) return tx.__lookupCache[language];
        const m = {};
        for (const [cid, cat] of Object.entries(tx.categories || {})) for (const name of ((cat.languages || {})[language] || [])) m[name] = cid;
        tx.__lookupCache[language] = m; return m;
    }
    function apiFor(tx, language) { return (tx.__api && tx.__api[language]) || {}; }
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
    PROFILES.cpp = Object.assign({}, PROFILES.c, { language: 'c' });
