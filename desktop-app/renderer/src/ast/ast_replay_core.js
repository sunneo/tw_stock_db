/* 照一棵真的樹（tree-sitter 解析出來的）回答建樹器的每個問題，用來證明「建樹器能表達這個程式」，也當測試的神諭。
 *   makeOracle(rootCstNode, source) → decider（給 FaAstBuild.build）
 * 做法：建樹器是深度優先、由左到右；神諭維護一疊「目前節點尚未被消耗的子節點（含固定的字）」，
 * 建樹器每回報一個固定的字（token）就從佇列前面消耗掉，每個問題就看佇列最前面的子節點是什麼種類。 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAstReplay = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ALIAS = { list_splat: ['list_splat_pattern'], list_splat_pattern: ['list_splat'], parenthesized_list_splat: ['parenthesized_expression'], parenthesized_expression: ['parenthesized_list_splat'], keyword_identifier: ['identifier'] };
    function makeOracle(rootNode, source) {
        const kids = (n) => { const o = []; for (let i = 0; i < n.childCount; i++) { const c = n.child(i); if (c.type === 'comment') continue; o.push(c); } return o; };
        const label = (c) => (c.isNamed() ? c.type : c.type); // 固定的字：type 就是字本身
        const stack = [{ q: kids(rootNode), type: 'module' }]; const top = () => stack[stack.length - 1];
        const front = () => top().q[0];
        const matches = (c, lab) => c && (label(c) === lab || (ALIAS[label(c)] || []).includes(lab));
        return {
            async enter(type) { const f = front(); if (f && f.isNamed() && !(matches(f, type)) && stack.length > 1) { /* 容忍別名差異 */ } if (stack.length === 1 && type === 'module') { stack.length = 0; stack.push({ q: kids(rootNode), type }); return; } const c = top().q.shift(); stack.push({ q: c ? kids(c) : [], type, node: c }); },
            async exit() { stack.pop(); },
            async token(text) { const f = front(); if (f && !f.isNamed() && f.type === text) { top().q.shift(); const g = front(); if (/ /.test(text) && g && !g.isNamed() && g.type === text) top().q.shift(); /* tree-sitter 對 not in／is not 這類別名固定字會產生兩個重複的子節點 */ } },
            async choice(q) {
                const f = front(); const labs = q.options.map((o) => o.label.replace(/（.*）$/, ''));
                if (q.kind === 'repeat') return f && (q.firstSet || []).some((l) => matches(f, l)) ? 0 : 1;
                if (q.kind === 'option') return f && (q.firstSet || []).some((l) => matches(f, l)) ? 0 : 1;
                if (!f) { const i = labs.indexOf('（都不加）'); return i >= 0 ? i : 0; }
                if (f.type === 'block' && labs.includes('⇥ 縮排區塊')) { const prev = f.previousSibling; const nl = prev && f.startPosition.row > prev.endPosition.row; if (nl) return labs.indexOf('⇥ 縮排區塊'); }
                // 同樣開頭的分支：用草圖對照佇列裡接下來的子節點，要整段都對得上，取最長的
                const cand = q.options.map((o, i) => [o, i]).filter(([o]) => matches(f, o.label.replace(/（.*）$/, '')));
                if (cand.length > 1) { let best = -1, bl = -1; for (const [o, i] of cand) { const sk = o.sketch || []; let ok = true; for (let k = 0; k < sk.length; k++) { const c = top().q[k]; if (!c || !sk[k].some((l) => matches(c, l))) { ok = false; break; } } if (ok && sk.length > bl) { bl = sk.length; best = i; } } if (best >= 0) return best; }
                let i = q.options.findIndex((o) => matches(f, o.label.replace(/（.*）$/, ''))); if (i < 0) i = labs.findIndex((l) => l === '（都不加）'); if (i < 0) throw new Error('神諭找不到選項：' + label(f) + '／可選：' + labs.slice(0, 12).join(','));
                return i;
            },
            async leaf(q) {
                const f = top().q.shift(); if (!f) throw new Error('神諭：沒有葉節點可讀（' + q.type + '）'); const text = source.slice(f.startIndex, f.endIndex);
                if (q.type === 'string') { const m = /^[rRbBuU]*("""|'''|"|')([\s\S]*)\1$/.exec(text); if (!m) throw new Error('神諭：不認得的字串寫法 ' + text); return m[2].replace(/\\(.)/g, (_, c) => (c === 'n' ? '\n' : c === 't' ? '\t' : c)); }
                return text;
            },
        };
    }
    return { makeOracle };
});
