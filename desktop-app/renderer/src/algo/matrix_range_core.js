/* G7 算術編碼（DESIGN.matrix-fallback.md §13.4）：LZMA 式的二進位範圍編碼器（自適應機率，11 位元精度，移位 5）。
 *   ① 範圍編碼器／解碼器（照 LZMA SDK 的 RangeEnc_ShiftLow 與 cache／carry 規則）；
 *   ② 位元樹（bit tree）：m 位元符號用 2^m 個機率，逐位元沿樹走；
 *   ③ LZMA1 串流（.lzma，FORMAT_ALONE）的「只有字面量」子集：每個位元組＝isMatch 位元 0＋8 位元字面量（lc=3、lp=0、pb=2）。
 *      用真的 liblzma（Python lzma 模組）解我們寫的檔，就是外部驗證；完整 LZMA（比對、重複距離）未做。
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixRange = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const TOP = 16777216, TWO32 = 4294967296, INIT = 1024;  // 2^24, 2^32；機率初值 = 2048/2

    class RangeEncoder {
        constructor() { this.low = 0; this.range = 0xFFFFFFFF; this.cache = 0; this.cacheSize = 1; this.out = []; }
        shiftLow() {
            if (this.low < 0xFF000000 || this.low >= TWO32) {
                const carry = this.low >= TWO32 ? 1 : 0; let temp = this.cache;
                do { this.out.push((temp + carry) & 0xFF); temp = 0xFF; } while (--this.cacheSize !== 0);
                this.cache = Math.floor((this.low % TWO32) / TOP) & 0xFF;
            }
            this.cacheSize++;
            this.low = (this.low % TOP) * 256;  // 低 32 位元取低 24 位元再左移 8
        }
        encodeBit(probs, i, bit) {
            const p = probs[i]; const bound = Math.floor(this.range / 2048) * p;
            if (bit === 0) { this.range = bound; probs[i] = p + ((2048 - p) >> 5); }
            else { this.low += bound; this.range -= bound; probs[i] = p - (p >> 5); }
            while (this.range < TOP) { this.range = this.range * 256; this.shiftLow(); }
        }
        encodeDirect(v, n) { for (let b = n - 1; b >= 0; b--) { this.range = Math.floor(this.range / 2); if ((v >> b) & 1) this.low += this.range; while (this.range < TOP) { this.range *= 256; this.shiftLow(); } } }
        finish() { for (let i = 0; i < 5; i++) this.shiftLow(); return Uint8Array.from(this.out); }
    }
    class RangeDecoder {
        constructor(data) {
            this.data = data; this.pos = 0; this.range = 0xFFFFFFFF; this.code = 0;
            if (data[this.pos++] !== 0) throw new Error('範圍編碼串流的第一個位元組必須是 0');
            for (let i = 0; i < 4; i++) this.code = (this.code * 256 + this.next()) % TWO32;
        }
        next() { if (this.pos >= this.data.length) throw new Error('範圍編碼串流提早結束'); return this.data[this.pos++]; }
        decodeBit(probs, i) {
            const p = probs[i]; const bound = Math.floor(this.range / 2048) * p; let bit;
            if (this.code < bound) { this.range = bound; probs[i] = p + ((2048 - p) >> 5); bit = 0; }
            else { this.code -= bound; this.range -= bound; probs[i] = p - (p >> 5); bit = 1; }
            while (this.range < TOP) { this.range = this.range * 256; this.code = (this.code * 256 + this.next()) % TWO32; }
            return bit;
        }
        decodeDirect(n) { let v = 0; for (let b = 0; b < n; b++) { this.range = Math.floor(this.range / 2); let bit = 0; if (this.code >= this.range) { this.code -= this.range; bit = 1; } v = (v << 1) | bit; while (this.range < TOP) { this.range *= 256; this.code = (this.code * 256 + this.next()) % TWO32; } } return v; }
    }
    const newProbs = (n) => new Array(n).fill(INIT);
    // 位元樹：probs 長 2^m；符號 v（m 位元，高位在前）
    function bitTreeEncode(enc, probs, m, v) { let idx = 1; for (let b = m - 1; b >= 0; b--) { const bit = (v >> b) & 1; enc.encodeBit(probs, idx, bit); idx = (idx << 1) | bit; } }
    function bitTreeDecode(dec, probs, m) { let idx = 1; for (let b = 0; b < m; b++) idx = (idx << 1) | dec.decodeBit(probs, idx); return idx - (1 << m); }

    // ③ LZMA1 字面量子集（lc=3, lp=0, pb=2）。檔頭：props(1)＋dictSize(4，LE)＋未壓縮大小(8，LE)。
    const LC = 3, PB = 2, PROPS = (PB * 5 + 0) * 9 + LC;  // 93
    function lzmaLiteralsEncode(bytes, dictSize) {
        const enc = new RangeEncoder(); const isMatch = newProbs(12 << 4); const lit = newProbs(0x300 << LC); let state = 0, prev = 0;
        for (let pos = 0; pos < bytes.length; pos++) {
            const posState = pos & ((1 << PB) - 1);
            enc.encodeBit(isMatch, (state << 4) + posState, 0);
            const base = 0x300 * (prev >> (8 - LC)); const sym = bytes[pos]; let m = 1;
            for (let b = 7; b >= 0; b--) { const bit = (sym >> b) & 1; enc.encodeBit(lit, base + m, bit); m = (m << 1) | bit; }
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6; prev = sym;
        }
        const body = enc.finish(); const hdr = new Uint8Array(13);
        hdr[0] = PROPS; for (let i = 0; i < 4; i++) hdr[1 + i] = (dictSize >>> (8 * i)) & 0xFF;
        let n = bytes.length; for (let i = 0; i < 8; i++) { hdr[5 + i] = n % 256; n = Math.floor(n / 256); }
        const out = new Uint8Array(13 + body.length); out.set(hdr, 0); out.set(body, 13); return out;
    }
    function lzmaLiteralsDecode(file) {
        if (file[0] !== PROPS) throw new Error('props 不是 lc=3 lp=0 pb=2');
        let size = 0; for (let i = 7; i >= 0; i--) size = size * 256 + file[5 + i];
        const dec = new RangeDecoder(file.subarray(13)); const isMatch = newProbs(12 << 4); const lit = newProbs(0x300 << LC);
        const out = new Uint8Array(size); let state = 0, prev = 0;
        for (let pos = 0; pos < size; pos++) {
            const posState = pos & ((1 << PB) - 1);
            if (dec.decodeBit(isMatch, (state << 4) + posState) !== 0) throw new Error('出現比對位元：這個解碼器只處理字面量子集');
            const base = 0x300 * (prev >> (8 - LC)); let m = 1;
            for (let b = 0; b < 8; b++) m = (m << 1) | dec.decodeBit(lit, base + m);
            const sym = m & 0xFF; out[pos] = sym;
            state = state < 4 ? 0 : state < 10 ? state - 3 : state - 6; prev = sym;
        }
        return out;
    }

    return { RangeEncoder, RangeDecoder, newProbs, bitTreeEncode, bitTreeDecode, lzmaLiteralsEncode, lzmaLiteralsDecode, PROPS };
});
