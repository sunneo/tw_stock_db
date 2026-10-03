
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
            else if (text.startsWith('//')) { const cl = text.slice(2).trim(); if (cl) lines.push(cl); }
            else if (text.startsWith('#')) { const cl = text.slice(1).trim(); if (cl) lines.push(cl); }
            else { const cl = text.trim(); if (cl) lines.push(cl); }
        }
        return lines.length ? lines.join(' ') : null;
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
    function scanTree(root, src, profile, tx, opts) {
        opts = opts || {}; const language = profile.language; const lookup = lookupFor(tx, language);
        const cf = (tx.control_flow_nodes || {})[language] || {}; const branchTypes = S(cf.branch), loopTypes = S(cf.loop);
        const sig = tx.structural_signals || {};
        const asmTypes = S((sig.inline_assembly || {})[language]), guardTypes = S((sig.preprocessor_conditional || {})[language]);
        const sigTypes = {}; for (const [name, per] of Object.entries(sig)) { const set = S((per || {})[language]); if (set.size) sigTypes[name] = set; }
        const aLk = asmLookup(tx); const pathRules = tx.well_known_paths || [], envRules = tx.well_known_env_vars || []; const shellLookup = lookupFor(tx, 'shell');
        let fnNodes = []; collectTypes(root, profile.function_node_types, fnNodes);
        let wholeName = null; if (!fnNodes.length && opts.wholeFile) { fnNodes = [root]; wholeName = opts.path || '(file)'; }
        const functions = []; const unclassified = {};
        for (const fn of fnNodes) {
            const name = wholeName || (language === 'c' ? cFunctionName(fn, src) : (language === 'javascript' ? jsFunctionNameBehavior(fn, src) : profile.get_function_name(fn, src, profile)));
            if (!name) continue;
            const callNodes = []; collectTypes(fn, profile.call_node_types, callNodes);
            const behaviors = {}; let callCount = 0; const allCalls = [];
            for (const c of callNodes) {
                const cands = profile.get_call_candidates(c, src); if (!cands || !cands.length) continue;
                callCount++; allCalls.push(cands[0]);
                let cat = null; for (const cd of cands) { cat = lookup[cd]; if (cat) break; }
                if (cat) (behaviors[cat] = behaviors[cat] || new Set()).add(cands[0]); else unclassified[cands[0]] = (unclassified[cands[0]] || 0) + 1;
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
        return { functions, unclassified: Object.entries(unclassified).sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })) };
    }

    // ================= API 語意（apisemantics_tools）=================
    const OPS = { '<': (v, n) => v < n, '<=': (v, n) => v <= n, '>': (v, n) => v > n, '>=': (v, n) => v >= n, '==': (v, n) => v === n, '!=': (v, n) => v !== n };
    const PROBE = { '<': [-1, -100], '<=': [0, -1], '>': [1, 100], '>=': [0, 1], '==': [0], '!=': [-1, 1] };
    function parseIntLit(s) { if (/^-?0[xX][0-9a-fA-F]+$/.test(s)) return parseInt(s, 16); if (/^-?\d+$/.test(s)) return parseInt(s, 10); if (/^-?0[0-7]+$/.test(s)) return parseInt(s, 8); return null; }
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
        if (condOp === 'truthy' || condOp === 'falsy') return ro === condOp;
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
    const NORMALIZE_KIND = { enhanced_for_statement: 'for_statement', for_in_statement: 'for_statement', c_style_for_statement: 'for_statement', foreach_statement: 'for_statement', switch_expression: 'switch_statement', match_statement: 'switch_statement', case_statement: 'switch_statement', elif_clause: 'if_statement', elseif_clause: 'if_statement' };
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
        const ch = kids(node); const ii = ch.findIndex((c) => c.type === 'in' || c.type === 'of'); if (ii < 0) return [null, null];
        const before = ch.slice(0, ii).filter((c) => !FOREACH_SKIP.has(c.type)); const v = before.map((c) => T(c, src)).join(' ').trim(); const after = [];
        for (const c of ch.slice(ii + 1)) { if (p.body_node_types.has(c.type) || c.type === ')') break; if (c.type === ';' || c.type === ':') continue; after.push(c); }
        return [v || null, after.map((c) => T(c, src)).join(' ').trim() || null];
    }
    function controlExplanation(node, src, p, nk) {
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
    function isInfiniteLoop(node, src, p) { if (p.foreach_for_types.has(node.type)) return false; if (p.c_style_for_types.has(node.type)) return isCStyleForEmpty(node); const c = p.get_condition_node(node, src, p); if (!c) return false; return p.infinite_loop_texts.has(T(c, src).trim()); }
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
        for (const c of picked) { let t = T(c, src); if (t.startsWith('/*')) { t = t.slice(2); if (t.endsWith('*/')) t = t.slice(0, -2); t = t.split('\n').map((l) => l.replace(BLOCK_MARGIN, '').trim()).filter(Boolean).join(' '); } else t = t.replace(/^(\/\/+|#+|;+)\s*/, '').trim(); if (t) lines.push(t); }
        return lines.join(' ') || null;
    }
    function walkStatements(node, src, lookup, p, api, varCalls, depth, out, branch) {
        const isC = p.language === 'c';
        const proc = (child, depth, branch) => {
            if (p.transparent_types.has(child.type)) { walkStatements(child, src, lookup, p, api, varCalls, depth, out, branch); return; }
            if (p.control_statement_types.has(child.type)) {
                const nk = normKind(child.type); const calls = []; collectTypes(child, p.call_node_types, calls); const isIf = nk === 'if_statement'; let body = null, cons = null, els = null, ranges;
                if (isIf) { [cons, els] = p.get_if_branches(child, p, src); ranges = [cons, els].filter(Boolean).map((n) => [n.startIndex, n.endIndex]); }
                else { body = kids(child).find((c) => p.body_node_types.has(c.type)) || null; ranges = body ? [[body.startIndex, body.endIndex]] : []; }
                const condCalls = calls.filter((c) => !ranges.some(([s, e]) => s <= c.startIndex && c.startIndex < e));
                const condNames = condCalls.map((c) => p.get_call_name(c, src)).filter(Boolean);
                const entry = { line: row(child) + 1, depth, kind: nk, text: headerText(child, src), calls: condNames, categories: sorted(new Set(condNames.filter((n) => lookup[n]).map((n) => lookup[n]))), explanation: null, branch: branch || null, is_guard_clause: isIf && isGuardClause(child, src, p), is_infinite_loop: (nk === 'for_statement' || nk === 'while_statement' || nk === 'do_statement') && isInfiniteLoop(child, src, p), comment: precedingCommentNote(child, src) };
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
                const calls = []; collectTypes(child, p.call_node_types, calls); const names = calls.map((c) => p.get_call_name(c, src)).filter(Boolean); const exps = [];
                if (api) for (const c of calls) { const e = explainBest(c, p.get_call_candidates(c, src) || [], src, api); if (e) exps.push(e); }
                out.push({ line: row(child) + 1, depth, kind: child.type, text: statementText(child, src), calls: names, categories: sorted(new Set(names.filter((n) => lookup[n]).map((n) => lookup[n]))), explanation: exps.join(' ') || null, branch: branch || null, is_guard_clause: false, is_infinite_loop: false, comment: precedingCommentNote(child, src) });
                if (isC) recordCallResultVars(child, src, varCalls);
                return;
            }
            walkStatements(child, src, lookup, p, api, varCalls, depth, out, branch);
        };
        for (const c of kids(node)) proc(c, depth, branch);
    }
    // 追蹤一個函式節點：回傳 {name, path, start_line, end_line, lines[]}
    function traceFunction(fnNode, src, profile, tx, name, path) {
        const lookup = lookupFor(tx, profile.language); const api = apiFor(tx, profile.language); const lines = [];
        const body = kids(fnNode).find((c) => profile.body_node_types.has(c.type));
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
