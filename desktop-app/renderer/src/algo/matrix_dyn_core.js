/* G7 動態表（DESIGN.matrix-fallback.md §12.3 G7、§13）：
 *   ① canonical Huffman 編碼表（RFC 1951 §3.2.2：由各符號的碼長直接算出碼字，DEFLATE 動態區塊就是這樣建表）；
 *   ② 位元流解碼（用碼長建的表逐位元讀，無前綴衝突）；
 *   ③ MTF（移到前面）動態表：每讀一個符號就改動表的順序，輸出的是「在表中的位置」——這是 LZMA／bzip2 一類的動態狀態。
 * 純函式（UMD）。不做的：FGK／Vitter 動態霍夫曼（每次編碼後重建樹）、LZMA 機率表的二進位算術編碼——見 §13 未做清單。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixDyn = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const MAXBITS = 15;

    // ① 碼長 → 碼字（RFC 1951 §3.2.2 的演算法，照字面實作）。lengths[i] = 符號 i 的碼長（0＝不用）。
    function canonicalCodes(lengths) {
        const blCount = new Array(MAXBITS + 1).fill(0);
        for (const l of lengths) { if (l < 0 || l > MAXBITS) throw new Error('碼長超出範圍：' + l); if (l) blCount[l]++; }
        const nextCode = new Array(MAXBITS + 2).fill(0);
        let code = 0;
        for (let bits = 1; bits <= MAXBITS; bits++) { code = (code + blCount[bits - 1]) << 1; nextCode[bits] = code; }
        // 碼長 0 的 blCount[0] 不參與，RFC 規定 bl_count[0] = 0
        const codes = lengths.map((l) => (l ? nextCode[l]++ : -1));
        // Kraft 檢查：碼字不能超過 2^len（不完整或過度的碼長表）
        let kraft = 0; for (const l of lengths) if (l) kraft += Math.pow(2, -l);
        if (kraft > 1 + 1e-12) throw new Error('碼長表過度（Kraft 和 > 1）');
        return codes.map((c, i) => (lengths[i] ? { len: lengths[i], code: c } : null));
    }

    // ② 解碼：bits 是 0/1 陣列（依讀取順序，碼字以高位在前讀入），讀到 nSyms 個符號為止。
    function decodeHuffman(lengths, bits, nSyms) {
        const table = new Map();
        canonicalCodes(lengths).forEach((c, sym) => { if (c) table.set(c.len * 1e6 + c.code, sym); });
        const out = []; let i = 0;
        while (out.length < nSyms) {
            let code = 0, len = 0, sym = -1;
            while (sym < 0) {
                if (i >= bits.length) throw new Error('位元流提早結束');
                code = (code << 1) | bits[i++]; len++;
                if (len > MAXBITS) throw new Error('找不到碼字');
                const hit = table.get(len * 1e6 + code);
                if (hit !== undefined) sym = hit;
            }
            out.push(sym);
        }
        return { symbols: out, consumed: i };
    }

    // 編碼（對應的反向，用來測試往返）：符號序列 → 位元陣列
    function encodeHuffman(lengths, symbols) {
        const cc = canonicalCodes(lengths); const bits = [];
        for (const s of symbols) { const c = cc[s]; if (!c) throw new Error('符號 ' + s + ' 沒有碼'); for (let b = c.len - 1; b >= 0; b--) bits.push((c.code >> b) & 1); }
        return bits;
    }

    // ③ MTF 動態表：alphabet 是初始排列（陣列），encode 回傳每個符號當時的位置，然後把它移到最前面。
    function mtfEncode(alphabet, symbols) {
        const table = alphabet.slice(); const ranks = [];
        for (const s of symbols) {
            const r = table.indexOf(s); if (r < 0) throw new Error('符號不在表內：' + s);
            ranks.push(r); table.splice(r, 1); table.unshift(s);
        }
        return { ranks, table };
    }
    function mtfDecode(alphabet, ranks) {
        const table = alphabet.slice(); const out = [];
        for (const r of ranks) {
            if (r < 0 || r >= table.length) throw new Error('位置超出表：' + r);
            const s = table[r]; out.push(s); table.splice(r, 1); table.unshift(s);
        }
        return { symbols: out, table };
    }

    return { canonicalCodes, decodeHuffman, encodeHuffman, mtfEncode, mtfDecode, MAXBITS };
});
