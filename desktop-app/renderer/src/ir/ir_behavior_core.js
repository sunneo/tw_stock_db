/* 行為描述（第一層）：每個函式一份語言中立的描述——簽名、說明與註解、呼叫關係、用到的標準操作（與完整中間語言共用同一份操作目錄）、
 * 副作用、控制流摘要、行為分類。來源有兩條：
 *   ① describe：現有行為分析器（FaBeh2，tree-sitter，11 種語言）的函式紀錄＋輕量簽名抽取＋由操作目錄反向建的「呼叫名稱→標準操作」索引（不需要完整節點樹）
 *   ② fromIr：從完整中間語言（ir_design_core.extract）轉成同一個形狀（第二層：行為描述是中間語言的上層摘要）
 * 純函式 UMD。設計見 DESIGN.core-ir.md 第 4 節。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./ir_core.js'), require('./ir_ops_core.js'), require('./ir_design_core.js')); else root.FaIrBehavior = factory(root.FaIr, root.FaIrOps, root.FaIrDesign); })(typeof self !== 'undefined' ? self : this, function (IR, OPS, DES) {
    'use strict';
    const VERSION = 1;
    // ---- 反向索引：語言 → 呼叫名稱 → [操作 id]（由目錄的樣板自動建，不另維護）----
    function cellsOf(c) { return c == null ? [] : typeof c === 'string' ? [c] : Object.keys(c).map((k) => c[k]).filter((x) => typeof x === 'string'); }
    function buildIndex() {
        const idx = {};
        OPS.LANGS.forEach((L) => {
            const m = (idx[L] = {}); const put = (name, id) => { (m[name] = m[name] || []); if (m[name].indexOf(id) < 0) m[name].push(id); };
            OPS.ids().forEach((id) => {
                const o = OPS.get(id);
                cellsOf(o.cells[L]).forEach((tpl0) => {
                    const tpl = tpl0.replace(/^\((?:long long|long|double|int)\)\s*/, '').replace(/^\*/, ''); let mm;
                    if ((mm = /^[@$]\d\.([A-Za-z_]\w*)\(/.exec(tpl))) put('.' + mm[1], id);         // 方法：@0.push(...)
                    else if ((mm = /^([A-Za-z_][\w.]*)\(/.exec(tpl))) put(mm[1], id);                  // 函式或模組函式：len(...)、Math.floor(...)
                });
                (o.h[L] || []).forEach((h) => put(h, id));                                            // 輔助函式（中間語言輸出器貼的 fa_xxx）
            });
        });
        return idx;
    }
    let INDEX = null; const index = () => INDEX || (INDEX = buildIndex());
    // 行為分析器給的呼叫文字（"input().split"、"console.log"、"t.split"、"total"）→ 候選操作
    function recognize(lang, callText) {
        const L = OPS.LANG_OF[lang] || lang, ix = index()[L] || {}; const t = String(callText).replace(/\(\)/g, '');
        if (ix[t]) return ix[t].slice();
        const last = t.split('.').pop(); if (t.indexOf('.') >= 0 && ix['.' + last]) return ix['.' + last].slice();
        if (t.indexOf('.') < 0 && ix[t]) return ix[t].slice(); return [];
    }
    const CAT_EFFECT = { logging_output: '寫標準輸出', file_io: '讀寫檔', network: '網路', process: '啟動行程', random: '亂數' };

    // ---- 簽名抽取（tree-sitter；python 與 javascript 兩種，其餘語言沿用行為分析器，只有名稱與行號）----
    function sigsFromTree(lang, rootNode, src) {
        const out = {}; const txt = (n) => (n.text != null ? n.text : src.slice(n.startIndex, n.endIndex)); const named = (n) => n.namedChildren || n.children.filter((c) => c.isNamed());
        const walk = (n) => {
            if (lang === 'python' && n.type === 'function_definition') {
                const ps = n.childForFieldName('parameters'), rt = n.childForFieldName('return_type'), body = n.childForFieldName('body');
                const params = named(ps).filter((c) => c.type !== 'comment').map((p) => (p.type === 'identifier' ? { name: txt(p) } : p.type === 'typed_parameter' ? { name: txt(named(p)[0]), type: txt(p.childForFieldName('type')) } : { name: txt(p.childForFieldName('name') || p) }));
                const f0 = named(body).filter((c) => c.type !== 'comment')[0]; const doc = f0 && f0.type === 'expression_statement' && named(f0)[0] && named(f0)[0].type === 'string' ? txt(named(f0)[0]).replace(/^["']{1,3}|["']{1,3}$/g, '') : '';
                out[txt(n.childForFieldName('name'))] = { params, ret: rt ? txt(rt) : null, doc };
            }
            if (lang === 'javascript' && (n.type === 'function_declaration' || n.type === 'method_definition')) {
                const ps = n.childForFieldName('parameters'); out[txt(n.childForFieldName('name'))] = { params: named(ps).filter((c) => c.type !== 'comment').map((p) => ({ name: txt(p) })), ret: null, doc: '' };
            }
            named(n).forEach(walk);
        };
        // 靜態語言：java／c／c++／c#（型別在簽名上，直接收）
        const walkS = (n) => {
            let hit = false;
            if (lang === 'java' && n.type === 'method_declaration') {
                const ps = n.childForFieldName('parameters'); out[txt(n.childForFieldName('name'))] = { params: named(ps).filter((p) => /formal_parameter|spread_parameter/.test(p.type)).map((p) => ({ name: txt(p.childForFieldName('name')), type: txt(p.childForFieldName('type')) })), ret: txt(n.childForFieldName('type')), doc: '' }; hit = true;
            }
            if ((lang === 'c' || lang === 'cpp') && n.type === 'function_definition') {
                let d = n.childForFieldName('declarator'); while (d && d.type !== 'function_declarator' && d.childForFieldName('declarator')) d = d.childForFieldName('declarator');
                if (d && d.type === 'function_declarator') {
                    const nm = d.childForFieldName('declarator'); const ps = d.childForFieldName('parameters');
                    out[txt(nm).split('::').pop()] = { params: named(ps).filter((p) => p.type === 'parameter_declaration').map((p) => { const dd = p.childForFieldName('declarator'); let nn = dd; while (nn && nn.childForFieldName && nn.childForFieldName('declarator')) nn = nn.childForFieldName('declarator'); const ptr = dd ? (txt(dd).match(/^[*&]+/) || [''])[0] : ''; return { name: nn ? txt(nn).replace(/^[*&\s]+|\[.*$/g, '') : '', type: txt(p.childForFieldName('type')) + ptr }; }), ret: txt(n.childForFieldName('type')), doc: '' }; hit = true;
                }
            }
            if (lang === 'csharp' && n.type === 'method_declaration') {
                const ps = n.childForFieldName('parameters'); out[txt(n.childForFieldName('name'))] = { params: named(ps).filter((p) => p.type === 'parameter').map((p) => ({ name: txt(p.childForFieldName('name')), type: txt(p.childForFieldName('type')) })), ret: txt(n.childForFieldName('type') || n.childForFieldName('returns')), doc: '' }; hit = true;
            }
            named(n).forEach(walkS); return hit;
        };
        if (lang === 'java' || lang === 'c' || lang === 'cpp' || lang === 'csharp') { walkS(rootNode); return out; }
        walk(rootNode); return out;
    }

    // ---- ① 由行為分析器的函式紀錄建行為描述 ----
    function describe(lang, fnRec, sig, definedNames) {
        const defined = {}; (definedNames || []).forEach((n) => { defined[n] = 1; });
        const calls = [], std = [], lib = []; const seen = {};
        (fnRec.all_calls || []).forEach((c) => {
            const base = String(c).replace(/\(\)/g, '').split('.').pop();
            if (defined[base] && !seen['u' + base]) { seen['u' + base] = 1; calls.push(base); return; }
            const cand = recognize(lang, c);
            if (cand.length) cand.forEach((id) => { if (!seen[id]) { seen[id] = 1; std.push({ op: id, via: c, ambiguous: cand.length > 1 }); } });
            else if (!seen['l' + c]) { seen['l' + c] = 1; lib.push(c); }
        });
        const effects = []; std.forEach((s) => DES.effectsOf(s.op).forEach((e) => { if (effects.indexOf(e) < 0) effects.push(e); }));
        Object.keys(fnRec.behaviors || {}).forEach((cat) => { if (CAT_EFFECT[cat] && effects.indexOf(CAT_EFFECT[cat]) < 0 && cat !== 'string_formatting') effects.push(CAT_EFFECT[cat]); });
        return {
            v: VERSION, level: 1, lang, name: fnRec.name, pos: [fnRec.line, fnRec.end_line], params: (sig && sig.params) || null, ret: (sig && sig.ret) || null,
            doc: (sig && sig.doc) || fnRec.leading_comment_text || '', calls, std, lib, behaviors: Object.keys(fnRec.behaviors || {}),
            control: { loops: fnRec.loop_count, branches: fnRec.branch_count, complexity: fnRec.complexity }, effects,
            pure: effects.length === 0 && lib.length === 0 ? true : (effects.length === 0 ? 'unknown' : false)
        };
    }
    // ---- ② 由完整中間語言轉成同一個形狀 ----
    function fromIr(ir) {
        const d = DES.extract(ir);
        return d.functions.map((f) => ({
            v: VERSION, level: 2, lang: (ir.src && ir.src.lang) || 'unknown', name: f.name, pos: f.pos ? [f.pos[0], f.pos[2]] : null, params: f.params.map((p) => ({ name: p.name, type: p.type })), ret: f.returns, doc: f.doc || '',
            calls: f.calls.slice(), std: f.std.map((s) => ({ op: s.op, via: s.op, ambiguous: false })), lib: [], behaviors: [], control: { loops: f.loops, branches: f.branches, complexity: f.branches + f.loops + 1 }, effects: f.effects.slice(), pure: f.pure
        }));
    }
    // 兩份描述（不同來源或不同語言）的一致程度
    function agree(a, b) {
        const eq = (x, y) => JSON.stringify(x.slice().sort()) === JSON.stringify(y.slice().sort());
        const sa = a.std.map((s) => s.op), sb = b.std.map((s) => s.op); const inter = sa.filter((x) => sb.indexOf(x) >= 0).length, uni = new Set(sa.concat(sb)).size;
        return { name: a.name === b.name, calls: eq(a.calls, b.calls), loops: a.control.loops === b.control.loops, effects: eq(a.effects, b.effects), stdJaccard: uni ? inter / uni : 1, arity: !a.params || !b.params || a.params.length === b.params.length };
    }
    // 沒有函式本體時，只靠行為描述能產生的東西：簽名＋說明＋註解＋「用到哪些標準操作」的提示，本體留待實作（誠實：不重現行為）
    function skeleton(bd, lang) {
        const doc = [bd.doc, bd.std.length ? '用到標準操作：' + bd.std.map((s) => s.op).join('、') : '', bd.effects.length ? '副作用：' + bd.effects.join('、') : ''].filter(Boolean);
        const names = (bd.params || []).map((p) => p.name);
        if (lang === 'nodejs') return '/**\n' + doc.map((l) => ' * ' + l).join('\n') + '\n */\nfunction ' + bd.name + '(' + names.join(', ') + ') {\n    throw new Error("待實作：" + "' + bd.name + '");\n}\n';
        if (lang === 'java') { const T = { int: 'long', float: 'double', str: 'String', bool: 'boolean' }; const ty = (t) => { t = String(t || ''); const m = /^list<(\w+)>$/.exec(t) || /^List\[(\w+)\]$/.exec(t); if (m) return 'List<' + ({ int: 'Long', float: 'Double', str: 'String', bool: 'Boolean' }[m[1]] || 'Object') + '>'; return T[t] || 'Object'; };
            return '    /**\n' + doc.map((l) => '     * ' + l.replace(/\*\//g, '* /').replace(/[^\x20-\x7e]/g, (c) => '\\u' + ('0000' + c.charCodeAt(0).toString(16)).slice(-4))).join('\n') + '\n     */\n    static ' + ty(bd.ret === 'None' ? 'void' : bd.ret).replace('Object', 'void') + ' ' + bd.name + '(' + (bd.params || []).map((p) => ty(p.type) + ' ' + p.name).join(', ') + ') {\n        throw new RuntimeException("待實作：' + bd.name + '");\n    }\n'; }
        return null;
    }
    // 行為卡：一個函式一張，給人看（只讀，不產生程式碼）
    function card(bd) {
        const sig = bd.name + '(' + (bd.params ? bd.params.map((p) => p.name + (p.type ? ': ' + p.type : '')).join(', ') : '…') + ')' + (bd.ret ? ' → ' + bd.ret : '');
        const L = ['### ' + sig, ''];
        if (bd.doc) L.push(bd.doc, '');
        L.push('- 位置：' + (bd.pos ? '第 ' + bd.pos[0] + '–' + bd.pos[1] + ' 行' : '未知') + '；來源層級 ' + bd.level + (bd.level === 1 ? '（行為分析器）' : '（完整中間語言）'));
        L.push('- 控制流：' + bd.control.loops + ' 個迴圈、' + bd.control.branches + ' 個分支、複雜度 ' + bd.control.complexity);
        L.push('- 呼叫：' + (bd.calls.length ? bd.calls.join('、') : '沒有呼叫本檔其他函式'));
        L.push('- 標準操作：' + (bd.std.length ? bd.std.map((s) => s.op + (s.ambiguous ? '（候選）' : '')).join('、') : '無'));
        if (bd.lib && bd.lib.length) L.push('- 未認得的呼叫：' + bd.lib.join('、'));
        L.push('- 副作用：' + (bd.effects.length ? bd.effects.join('、') : bd.pure === 'unknown' ? '看不出（有未認得的呼叫）' : '無（純函式）'));
        if (bd.behaviors && bd.behaviors.length) L.push('- 行為分類：' + bd.behaviors.join('、'));
        return L.join('\n');
    }
    return { VERSION, index, recognize, sigsFromTree, describe, fromIr, agree, skeleton, card };
});
