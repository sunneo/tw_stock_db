/* AST 空位的選單（純函式，UMD）。使用者的定義：AST 就是 Abstract Syntax Tree——程式是一棵節點樹，
 * 每個空位有型別，機械演算法列出「這個空位合法的節點種類」，模型只在裡面選。
 * 資料來源是 tree-sitter 文法本身（grammar.json）：每條規則是依序的清單（固定的字、有名字的欄位空位、可有可無、可重複），
 * 隱藏規則（名字以 _ 開頭）與 supertype 會展開，直到碰到具名節點或固定的字。
 *   load(grammarJson)           → schema
 *   menu(schema, item)          → 這個空位的選項 [{label, kind:'node'|'token', node?, token?, items}]
 *       item 是規則樹的一塊（SYMBOL／CHOICE／SEQ／…）；items 是選了這個選項之後接下來要走的清單
 */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAstMenu = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const hidden = (n) => n[0] === '_';
    function load(g) { return { rules: g.rules, supertypes: new Set(g.supertypes || []), externals: g.externals || [], extras: g.extras || [] }; }
    const unwrap = (n) => { while (n && (n.type.startsWith('PREC') || n.type === 'FIELD' || n.type === 'TOKEN' || n.type === 'IMMEDIATE_TOKEN' && false)) n = n.content; return n; };
    // 展開成「選項」：每個選項 = 一個具名節點、或以某個固定的字開頭的一條路。展開時穿過隱藏規則、CHOICE、PREC、FIELD。
    function menu(S, item, depth) {
        depth = depth || 0; if (depth > 12) return [];
        const out = []; const add = (o) => { if (!out.some((x) => x.label === o.label)) out.push(o); };
        const walk = (n, d) => {
            if (!n || d > 14) return; const t = n.type;
            if (t.startsWith('PREC') || t === 'FIELD') return walk(n.content, d + 1);
            if (t === 'CHOICE') { for (const m of n.members) walk(m, d + 1); return; }
            if (t === 'BLANK') return;
            if (t === 'ALIAS') { if (n.named) return add({ label: n.value, kind: 'node', node: n.value, alias: true }); return walk(n.content, d + 1); }
            if (t === 'SYMBOL') { if ((hidden(n.name) || S.supertypes.has(n.name)) && S.rules[n.name]) return walk(S.rules[n.name], d + 1); /* 隱藏規則與 supertype 不是真的節點：往下展開 */ return add({ label: n.name, kind: 'node', node: n.name }); }
            if (t === 'STRING') return add({ label: n.value, kind: 'token', token: n.value });
            if (t === 'SEQ') { if (n.members.length) walk(n.members[0], d + 1); return; }
            if (t === 'REPEAT' || t === 'REPEAT1') return walk(n.content, d + 1);
            if (t === 'TOKEN' || t === 'IMMEDIATE_TOKEN') return add({ label: 'token', kind: 'token' });
            if (t === 'PATTERN') return add({ label: 'pattern', kind: 'token' });
        };
        walk(item, 0); return out;
    }
    return { load, menu, hidden };
});
