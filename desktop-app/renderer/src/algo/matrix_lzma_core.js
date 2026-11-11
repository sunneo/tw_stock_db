/* G7 完整 LZMA1（DESIGN.matrix-fallback.md §13.4 阻礙 2 的解除）：
 *   在 matrix_range_core 的範圍編碼器上，補齊 LZMA 的比對（match）、四個重複距離（rep0～rep3）、短重複（shortrep）、
 *   長度樹（choice／low／mid／high）、距離槽（posSlot）、反向位元樹（posEnc）、對齊位元（align）與比對字面量（matched literal）。
 *   參數固定 lc=3 lp=0 pb=2（props=93），檔頭 13 位元組（props、dictSize、未壓縮大小）。
 *   解碼器同時支援「已知大小」與「未知大小＋結束標記」（xz／liblzma 的 FORMAT_ALONE 預設寫法）。
 *   編碼器：雜湊鏈（3 位元組雜湊、深度 32）找最長比對，先試四個重複距離，再試一般比對，最後才是字面量或 shortrep。
 *   驗證：我們寫的檔交給真的 liblzma 解；liblzma 壓的檔交給我們的解碼器解（兩個方向都要逐位元組一致）。
 * 純函式（UMD）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./matrix_range_core.js'));
    else root.FaMatrixLzma = factory(root.FaMatrixRange);
})(typeof self !== 'undefined' ? self : this, function (RC) {
    'use strict';
    const PROPS = 93, LC = 3, PB = 2, NSTATE = 12, MATCH_MIN = 2, MATCH_MAX = 273, END_DIST = 0xFFFFFFFF;

    // 位元樹（MSB 在前）、反向位元樹（LSB 在前）；probs 用絕對索引 base + m，m 從 1 起算
    function treeEnc(enc, probs, base, nb, v) { let m = 1; for (let b = nb - 1; b >= 0; b--) { const bit = (v >> b) & 1; enc.encodeBit(probs, base + m, bit); m = (m << 1) | bit; } }
    function treeDec(dec, probs, base, nb) { let m = 1; for (let b = 0; b < nb; b++) m = (m << 1) | dec.decodeBit(probs, base + m); return m - (1 << nb); }
    function revEnc(enc, probs, base, nb, v) { let m = 1; for (let i = 0; i < nb; i++) { const bit = (v >> i) & 1; enc.encodeBit(probs, base + m, bit); m = (m << 1) | bit; } }
    function revDec(dec, probs, base, nb) { let m = 1, sym = 0; for (let i = 0; i < nb; i++) { const bit = dec.decodeBit(probs, base + m); m = (m << 1) | bit; sym |= bit << i; } return sym; }

    function newLen() { return { c: RC.newProbs(2), low: RC.newProbs(16 * 8), mid: RC.newProbs(16 * 8), high: RC.newProbs(256) }; }
    function newModel() {
        return {
            isMatch: RC.newProbs(NSTATE * 16), isRep: RC.newProbs(NSTATE), isRepG0: RC.newProbs(NSTATE), isRepG1: RC.newProbs(NSTATE),
            isRepG2: RC.newProbs(NSTATE), isRep0Long: RC.newProbs(NSTATE * 16),
            lit: RC.newProbs(0x300 << LC), lenM: newLen(), repLen: newLen(),
            posSlot: RC.newProbs(4 * 64), posEnc: RC.newProbs(128), align: RC.newProbs(16),
        };
    }
    function encLen(enc, L, len0, ps) {
        if (len0 < 8) { enc.encodeBit(L.c, 0, 0); treeEnc(enc, L.low, ps * 8, 3, len0); }
        else if (len0 < 16) { enc.encodeBit(L.c, 0, 1); enc.encodeBit(L.c, 1, 0); treeEnc(enc, L.mid, ps * 8, 3, len0 - 8); }
        else { enc.encodeBit(L.c, 0, 1); enc.encodeBit(L.c, 1, 1); treeEnc(enc, L.high, 0, 8, len0 - 16); }
    }
    function decLen(dec, L, ps) {
        if (dec.decodeBit(L.c, 0) === 0) return treeDec(dec, L.low, ps * 8, 3);
        if (dec.decodeBit(L.c, 1) === 0) return 8 + treeDec(dec, L.mid, ps * 8, 3);
        return 16 + treeDec(dec, L.high, 0, 8);
    }
    function encDist(enc, M, dist, len0) {
        const ls = Math.min(len0, 3); let slot;
        if (dist < 4) slot = dist; else { const nb = 31 - Math.clz32(dist); slot = nb * 2 + ((dist >>> (nb - 1)) & 1); }
        treeEnc(enc, M.posSlot, ls * 64, 6, slot);
        if (slot < 4) return;
        const footer = (slot >> 1) - 1, base = (2 | (slot & 1)) * Math.pow(2, footer), red = dist - base;
        if (slot < 14) revEnc(enc, M.posEnc, base - slot, footer, red);
        else { enc.encodeDirect(Math.floor(red / 16), footer - 4); revEnc(enc, M.align, 0, 4, red & 15); }
    }
    function decDist(dec, M, len0) {
        const ls = Math.min(len0, 3), slot = treeDec(dec, M.posSlot, ls * 64, 6);
        if (slot < 4) return slot;
        const footer = (slot >> 1) - 1; let dist = (2 | (slot & 1)) * Math.pow(2, footer);
        if (slot < 14) dist += revDec(dec, M.posEnc, dist - slot, footer);
        else { dist += dec.decodeDirect(footer - 4) * 16; dist += revDec(dec, M.align, 0, 4); }
        return dist;
    }
    const nextState = { lit: (s) => (s < 4 ? 0 : s < 10 ? s - 3 : s - 6), match: (s) => (s < 7 ? 7 : 10), rep: (s) => (s < 7 ? 8 : 11), shortrep: (s) => (s < 7 ? 9 : 11) };
    const hash3 = (b, p) => Math.imul(b[p] | (b[p + 1] << 8) | (b[p + 2] << 16), 2654435761) >>> 16;

    // 編碼。opts.dictSize（預設 1<<20）；opts.stats 若給定，會累計各符號種類的次數（給測試檢查覆蓋率）。
    function lzmaEncode(bytes, opts) {
        const dictSize = (opts && opts.dictSize) || (1 << 20), stats = (opts && opts.stats) || null;
        const buf = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes), n = buf.length;
        const enc = new RC.RangeEncoder(), M = newModel();
        const head = new Int32Array(1 << 16).fill(-1), chain = new Int32Array(Math.max(n, 1));
        const rep = [0, 0, 0, 0]; let state = 0;
        const count = (k) => { if (stats) stats[k] = (stats[k] || 0) + 1; };
        const ins = (p) => { if (p + 2 < n) { const h = hash3(buf, p); chain[p] = head[h]; head[h] = p; } };
        const matchLen = (a, b, max) => { let k = 0; while (k < max && buf[a + k] === buf[b + k]) k++; return k; };
        const encLit = (pos, ps) => {
            enc.encodeBit(M.isMatch, (state << 4) + ps, 0);
            const base = 0x300 * (pos > 0 ? buf[pos - 1] >> 5 : 0), sym = buf[pos];
            let m = 1, matched = state >= 7; const mb = matched ? buf[pos - rep[0] - 1] : 0;
            for (let i = 7; i >= 0; i--) {
                const bit = (sym >> i) & 1;
                if (matched) { const mbit = (mb >> i) & 1; enc.encodeBit(M.lit, base + ((1 + mbit) << 8) + m, bit); m = (m << 1) | bit; if (mbit !== bit) matched = false; }
                else { enc.encodeBit(M.lit, base + m, bit); m = (m << 1) | bit; }
            }
            state = nextState.lit(state); count('lit');
        };
        const encRep = (r, len, ps) => {
            enc.encodeBit(M.isMatch, (state << 4) + ps, 1); enc.encodeBit(M.isRep, state, 1);
            if (r === 0) { enc.encodeBit(M.isRepG0, state, 0); enc.encodeBit(M.isRep0Long, (state << 4) + ps, 1); }
            else {
                enc.encodeBit(M.isRepG0, state, 1);
                if (r === 1) enc.encodeBit(M.isRepG1, state, 0);
                else { enc.encodeBit(M.isRepG1, state, 1); enc.encodeBit(M.isRepG2, state, r === 3 ? 1 : 0); }
                const d = rep[r]; for (let k = r; k > 0; k--) rep[k] = rep[k - 1]; rep[0] = d;
            }
            encLen(enc, M.repLen, len - 2, ps); state = nextState.rep(state); count('rep' + r);
        };
        const encShortRep = (ps) => {
            enc.encodeBit(M.isMatch, (state << 4) + ps, 1); enc.encodeBit(M.isRep, state, 1);
            enc.encodeBit(M.isRepG0, state, 0); enc.encodeBit(M.isRep0Long, (state << 4) + ps, 0);
            state = nextState.shortrep(state); count('shortrep');
        };
        const encMatch = (dist, len, ps) => {
            enc.encodeBit(M.isMatch, (state << 4) + ps, 1); enc.encodeBit(M.isRep, state, 0);
            encLen(enc, M.lenM, len - 2, ps); encDist(enc, M, dist, len - 2);
            rep[3] = rep[2]; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = dist; state = nextState.match(state); count('match');
        };
        let pos = 0;
        while (pos < n) {
            const ps = pos & ((1 << PB) - 1), maxLen = Math.min(MATCH_MAX, n - pos);
            let rLen = 0, rIdx = -1;
            for (let r = 0; r < 4; r++) { const src = pos - rep[r] - 1; if (src < 0) continue; const L = matchLen(src, pos, maxLen); if (L > rLen) { rLen = L; rIdx = r; } }
            let mLen = 0, mDist = 0;
            if (pos + 2 < n) {
                let cand = head[hash3(buf, pos)], depth = 0;
                while (cand >= 0 && depth < 32) {
                    const d = pos - cand - 1; if (d >= dictSize) break;
                    const L = matchLen(cand, pos, maxLen);
                    if (L > mLen) { mLen = L; mDist = d; if (L === maxLen) break; }
                    cand = chain[cand]; depth++;
                }
            }
            let adv;
            if (rLen >= MATCH_MIN && rLen + 1 >= mLen) { encRep(rIdx, rLen, ps); adv = rLen; }
            else if (mLen >= 3) { encMatch(mDist, mLen, ps); adv = mLen; }
            else if (pos - rep[0] - 1 >= 0 && buf[pos - rep[0] - 1] === buf[pos]) { encShortRep(ps); adv = 1; }
            else { encLit(pos, ps); adv = 1; }
            for (let k = 0; k < adv; k++) ins(pos + k);
            pos += adv;
        }
        const body = enc.finish(), hdr = new Uint8Array(13);
        hdr[0] = PROPS; for (let i = 0; i < 4; i++) hdr[1 + i] = (dictSize >>> (8 * i)) & 0xFF;
        let sz = n; for (let i = 0; i < 8; i++) { hdr[5 + i] = sz % 256; sz = Math.floor(sz / 256); }
        const out = new Uint8Array(13 + body.length); out.set(hdr, 0); out.set(body, 13); return out;
    }

    // 解碼：支援已知大小，以及未知大小（全 0xFF）＋結束標記。
    function lzmaDecode(file) {
        if (file.length < 13 || file[0] !== PROPS) throw new Error('標頭不是 lc=3 lp=0 pb=2（props 應為 93）');
        let size = 0, allFF = true;
        for (let i = 7; i >= 0; i--) { size = size * 256 + file[5 + i]; if (file[5 + i] !== 0xFF) allFF = false; }
        const known = !allFF;
        const dec = new RC.RangeDecoder(file.subarray(13)), M = newModel();
        const out = []; let state = 0; const rep = [0, 0, 0, 0];
        for (;;) {
            const pos = out.length;
            if (known && pos >= size) break;
            const ps = pos & ((1 << PB) - 1);
            if (dec.decodeBit(M.isMatch, (state << 4) + ps) === 0) {
                const base = 0x300 * (pos > 0 ? out[pos - 1] >> 5 : 0);
                let m = 1, matched = state >= 7;
                if (matched && pos - rep[0] - 1 < 0) throw new Error('比對字面量的來源位置無效');
                const mb = matched ? out[pos - rep[0] - 1] : 0;
                for (let i = 0; i < 8; i++) {
                    if (matched) { const mbit = (mb >> (7 - i)) & 1; const bit = dec.decodeBit(M.lit, base + ((1 + mbit) << 8) + m); m = (m << 1) | bit; if (mbit !== bit) matched = false; }
                    else m = (m << 1) | dec.decodeBit(M.lit, base + m);
                }
                out.push(m & 0xFF); state = nextState.lit(state); continue;
            }
            let len;
            if (dec.decodeBit(M.isRep, state) === 1) {
                if (pos === 0) throw new Error('第一個符號不能是重複');
                if (dec.decodeBit(M.isRepG0, state) === 0) {
                    if (dec.decodeBit(M.isRep0Long, (state << 4) + ps) === 0) {
                        if (rep[0] >= pos) throw new Error('短重複的距離超出已解碼範圍');
                        state = nextState.shortrep(state); out.push(out[pos - rep[0] - 1]); continue;
                    }
                } else {
                    let d;
                    if (dec.decodeBit(M.isRepG1, state) === 0) d = rep[1];
                    else { if (dec.decodeBit(M.isRepG2, state) === 0) d = rep[2]; else { d = rep[3]; rep[3] = rep[2]; } rep[2] = rep[1]; }
                    rep[1] = rep[0]; rep[0] = d;
                }
                len = decLen(dec, M.repLen, ps); state = nextState.rep(state);
            } else {
                len = decLen(dec, M.lenM, ps); state = nextState.match(state);
                const d = decDist(dec, M, len);
                if (d === END_DIST) { if (known) throw new Error('已知大小的串流出現結束標記'); break; }
                rep[3] = rep[2]; rep[2] = rep[1]; rep[1] = rep[0]; rep[0] = d;
            }
            const L = len + MATCH_MIN;
            if (rep[0] >= pos) throw new Error('比對的距離超出已解碼範圍');
            if (known && pos + L > size) throw new Error('比對超出已宣告的大小');
            for (let k = 0; k < L; k++) out.push(out[out.length - rep[0] - 1]);
        }
        if (known && out.length !== size) throw new Error('解碼長度與標頭不符');
        return Uint8Array.from(out);
    }

    return { lzmaEncode, lzmaDecode, PROPS, END_DIST };
});
