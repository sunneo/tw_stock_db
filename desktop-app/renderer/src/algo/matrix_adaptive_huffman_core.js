/* G7 動態霍夫曼（DESIGN.matrix-fallback.md §13.4）：自適應霍夫曼，編碼端與解碼端各自維護同一份計數表，
 *   每送出一個符號後：計數 +1（初始每個符號計數 1，免除逃逸符號），計數總和超過上限就全部減半（至少 1），
 *   然後由計數重建最佳霍夫曼碼長、再用 matrix_dyn_core 的 canonical 規則配碼字。
 *   注意：這是「每符號後整張重建」的動態霍夫曼，不是 FGK／Vitter 的增量樹更新（那個要維護兄弟性質與轉換，未做）。
 *   正確性：往返一致；每一步的碼長在 Kraft 和＝1 且加權成本等於獨立 Python heapq 的最佳成本（見測試）。
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./matrix_dyn_core.js'));
    else root.FaMatrixAdaptiveHuffman = factory(root.FaMatrixDyn);
})(typeof self !== 'undefined' ? self : this, function (D) {
    'use strict';
    const DEFAULT_LIMIT = 512;

    // 最佳霍夫曼碼長（確定性：權重小者先，同權重取較小索引）。n 個符號都是 ≥1 的權重。
    function huffmanLengths(counts) {
        const n = counts.length;
        if (n === 1) return [1];
        const nodes = counts.map((w, i) => ({ w, syms: [i] }));
        const depth = new Array(n).fill(0);
        while (nodes.length > 1) {
            nodes.sort((a, b) => a.w - b.w || a.syms[0] - b.syms[0]);
            const a = nodes.shift(), b = nodes.shift();
            for (const s of a.syms) depth[s]++;
            for (const s of b.syms) depth[s]++;
            nodes.push({ w: a.w + b.w, syms: a.syms.concat(b.syms) });
        }
        return depth;
    }
    function currentCodes(counts) {
        const L = huffmanLengths(counts);
        if (Math.max(...L) > D.MAXBITS) throw new Error('碼長超過 15');
        return D.canonicalCodes(L);
    }
    function bump(counts, s, limit) {
        counts[s]++;
        if (counts.reduce((a, b) => a + b, 0) > limit) for (let i = 0; i < counts.length; i++) counts[i] = Math.max(1, Math.ceil(counts[i] / 2));
    }

    function encode(n, symbols, opts) {
        const limit = (opts && opts.limit) || DEFAULT_LIMIT;
        const counts = new Array(n).fill(1); const bits = [];
        for (const s of symbols) {
            if (s < 0 || s >= n) throw new Error('符號超出字母表：' + s);
            const c = currentCodes(counts)[s];
            for (let b = c.len - 1; b >= 0; b--) bits.push((c.code >> b) & 1);
            bump(counts, s, limit);
        }
        return bits;
    }
    function decode(n, bits, nSyms, opts) {
        const limit = (opts && opts.limit) || DEFAULT_LIMIT;
        const counts = new Array(n).fill(1); const out = []; let i = 0;
        for (let k = 0; k < nSyms; k++) {
            const codes = currentCodes(counts); const map = new Map();
            codes.forEach((c, sym) => { if (c) map.set(c.len * 65536 + c.code, sym); });
            let code = 0, len = 0, sym = -1;
            while (sym < 0) {
                if (i >= bits.length) throw new Error('位元流提早結束');
                code = (code << 1) | bits[i++]; len++;
                const hit = map.get(len * 65536 + code); if (hit !== undefined) sym = hit;
                if (len > D.MAXBITS) throw new Error('找不到碼字');
            }
            out.push(sym); bump(counts, sym, limit);
        }
        return { symbols: out, consumed: i };
    }

    return { huffmanLengths, currentCodes, encode, decode, DEFAULT_LIMIT };
});
