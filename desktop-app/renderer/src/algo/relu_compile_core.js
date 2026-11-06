/* ReLU 網路 → 決策樹（CoLU 的離散分支）的編譯器（評估用，不進產品）。對應 DESIGN.matrix-algorithms.md 第 12 節。
 *
 * 做法：網路是分段線性函數。依拓撲順序走每個 ReLU 神經元：它的前激活值在目前這條路徑上是輸入的一個仿射函數 p；
 * 把「p>0」當成分支，正側神經元＝p、負側＝0；葉子放各輸出的仿射映射。
 *   exact 模式：不剪枝（除了 p 是常數時不用分支）→ 對所有實數輸入都與網路相同，葉子數最壞 2^(神經元數)。
 *   domain 模式：給一個「整數輸入點集合」，只保留兩側都有點的分支 → 樹小很多，但只保證在這些整數點上相同（區域裡沒有整數點就被剪掉）。
 * 樹可以序列化成 JSONL（一行一個節點），也可以轉成 matrix_machine_core 的機器程式（守衛＝仿射算出來放暫存器再比較）。純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./matrix_machine_core.js'));
    else root.FaReluCompile = factory(root.FaMatrixMachine);
})(typeof self !== 'undefined' ? self : this, function (MM) {
    'use strict';
    const zeroAff = (n) => ({ w: new Array(n).fill(0), c: 0 });
    const affEval = (a, x) => a.c + a.w.reduce((s, c, i) => s + c * x[i], 0);
    const isConst = (a) => a.w.every((c) => c === 0);
    function boxPoints(ranges) { let pts = [[]]; for (const [lo, hi] of ranges) { const nx = []; for (const p of pts) for (let v = lo; v <= hi; v++) nx.push(p.concat([v])); pts = nx; } return pts; }
    // 編譯：net 是 relu_core 的 Net；pts＝null 為 exact 模式
    function compile(net, pts) {
        const nIn = net.nIn;
        const walk = (i, aff, P) => {
            for (; i < net.nodes.length; i++) {
                const nd = net.nodes[i];
                if (nd.in !== undefined) { const w = new Array(nIn).fill(0); w[nd.in] = 1; aff[i] = { w, c: 0 }; }
                else if (nd.lin) { const a = zeroAff(nIn); a.c = nd.c; for (const [k, co] of nd.lin) { for (let j = 0; j < nIn; j++) a.w[j] += co * aff[k].w[j]; a.c += co * aff[k].c; } aff[i] = a; }
                else { const p = aff[nd.relu];
                    if (isConst(p)) { aff[i] = p.c > 0 ? p : zeroAff(nIn); continue; }
                    let pos = null, neg = null; if (P) { pos = P.filter((x) => affEval(p, x) > 0); neg = P.filter((x) => !(affEval(p, x) > 0)); if (!pos.length) { aff[i] = zeroAff(nIn); continue; } if (!neg.length) { aff[i] = p; continue; } }
                    const a1 = aff.slice(); a1[i] = p; const a0 = aff.slice(); a0[i] = zeroAff(nIn);
                    return { guard: p, pos: walk(i + 1, a1, pos), neg: walk(i + 1, a0, neg) };
                }
            }
            return { leaf: net.out.map((o) => aff[o]) };
        };
        return { nIn, nOut: net.out.length, root: walk(0, [], pts) };
    }
    const evalTree = (tree, x) => { let n = tree.root; while (n.guard) n = affEval(n.guard, x) > 0 ? n.pos : n.neg; return n.leaf.map((a) => affEval(a, x)); };
    function stats(tree) { let leaves = 0, internal = 0, depth = 0; const go = (n, d) => { depth = Math.max(depth, d); if (n.guard) { internal++; go(n.pos, d + 1); go(n.neg, d + 1); } else leaves++; }; go(tree.root, 0); return { leaves, internal, depth }; }
    // JSONL：第一行 {nIn,nOut}，之後每行一個節點 {id, guard:{w,c}, pos, neg} 或 {id, leaf:[{w,c}…]}（根的 id 是 0）
    function toJsonl(tree) {
        const lines = [JSON.stringify({ nIn: tree.nIn, nOut: tree.nOut })]; let next = 0; const rows = [];
        const go = (n) => { const id = next++; const row = { id }; rows[id] = row; if (n.guard) { row.guard = n.guard; row.pos = go(n.pos); row.neg = go(n.neg); } else row.leaf = n.leaf; return id; };
        go(tree.root); return lines.concat(rows.map((r) => JSON.stringify(r))).join('\n') + '\n';
    }
    function fromJsonl(text) {
        const L = text.split('\n').filter(Boolean).map((l) => JSON.parse(l)); const head = L[0], rows = L.slice(1); const build = (id) => { const r = rows[id]; return r.guard ? { guard: r.guard, pos: build(r.pos), neg: build(r.neg) } : { leaf: r.leaf }; };
        return { nIn: head.nIn, nOut: head.nOut, root: build(0) };
    }
    // 轉成 CoLU 風格的機器（matrix_machine_core）：暫存器 0..nIn-1 = 輸入、nIn = 守衛暫存器、之後是輸出。
    // 每個內部節點：一個 mat 狀態把仿射算進守衛暫存器、一個 if 狀態比較（p>0 ⇔ p ≥ 1，整數語意）；葉子：一個 mat 狀態寫出輸出再停機。
    function toMachine(tree) {
        const nIn = tree.nIn, nOut = tree.nOut, R = nIn + 1 + nOut, S = {}; for (let i = 0; i < nIn; i++) S['in' + i] = { read: i, next: i + 1 < nIn ? 'in' + (i + 1) : 'n0', eof: 'n0' };
        let k = 0; const row = (a, dst) => { const spec = { c: a.c }; a.w.forEach((c, j) => { if (c) spec[j] = c; }); return [dst, spec]; };
        const go = (n) => { const id = 'n' + (k++);
            if (n.guard) { const pos = go(n.pos), neg = go(n.neg); S[id] = { mat: MM.aff(R, [row(n.guard, nIn)]), next: id + 'g' }; S[id + 'g'] = { if: { op: 'lt', a: nIn, c: 1 }, then: neg, else: pos }; }
            else S[id] = { mat: MM.aff(R, n.leaf.map((a, o) => row(a, nIn + 1 + o))), next: id + 'h' }, S[id + 'h'] = { halt: 'done' };
            return id; };
        go(tree.root); return { R, start: nIn ? 'in0' : 'n0', states: S };
    }
    const runMachine = (prog, nIn, x) => { const r = MM.run(prog, x); return r.regs.slice(nIn + 1); };
    return { boxPoints, compile, evalTree, stats, toJsonl, fromJsonl, toMachine, runMachine, affEval };
});
