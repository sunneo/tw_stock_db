/* JPEG 熵編碼（DESIGN.matrix-fallback.md §13.3，第 3 項的「霍夫曼熵編碼」）：
 *   灰階、基線（baseline）、單一元件：DC 差分＋類別碼、AC 的行程（游程）＋類別碼、ZRL（0xF0）與 EOB（0x00）、位元欄位的 1 補數、掃描資料的 0xFF 位元組填充。
 *   霍夫曼表用 ITU T.81 Annex K 的標準亮度表（DC 亮度 12 符號、AC 亮度 162 符號）：這兩張表是從 libjpeg（PIL）輸出的標準表讀出來的，測試會再比對一次。
 *   碼字建法照 Annex C（與 DEFLATE 的 canonical 同一套規則，但位元是「高位在前」寫入）。
 * 純函式（UMD）。不做：彩色（4:2:0）、漸進式、自訂表的最佳化（optimize）、檔案標頭（SOI／DQT／SOF／DHT／SOS／EOI，見測試）。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixJpegEntropy = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // Annex K.3.3.1：DC 亮度（bits[1..16] 每長度的符號數，vals 依序）
    const DC_LUMA = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
    // Annex K.3.3.2：AC 亮度
    const AC_LUMA = {
        bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 125],
        vals: [
        1, 2, 3, 0, 4, 17, 5, 18, 33, 49, 65, 6, 19, 81, 97, 7,
        34, 113, 20, 50, 129, 145, 161, 8, 35, 66, 177, 193, 21, 82, 209, 240,
        36, 51, 98, 114, 130, 9, 10, 22, 23, 24, 25, 26, 37, 38, 39, 40,
        41, 42, 52, 53, 54, 55, 56, 57, 58, 67, 68, 69, 70, 71, 72, 73,
        74, 83, 84, 85, 86, 87, 88, 89, 90, 99, 100, 101, 102, 103, 104, 105,
        106, 115, 116, 117, 118, 119, 120, 121, 122, 131, 132, 133, 134, 135, 136, 137,
        138, 146, 147, 148, 149, 150, 151, 152, 153, 154, 162, 163, 164, 165, 166, 167,
        168, 169, 170, 178, 179, 180, 181, 182, 183, 184, 185, 186, 194, 195, 196, 197,
        198, 199, 200, 201, 202, 210, 211, 212, 213, 214, 215, 216, 217, 218, 225, 226,
        227, 228, 229, 230, 231, 232, 233, 234, 241, 242, 243, 244, 245, 246, 247, 248,
        249, 250,
        ],
    };

    // Annex C：由 bits／vals 建碼字表。回傳 Map：符號 → { code, len }
    function buildCodes(table) {
        const map = new Map(); let code = 0, k = 0;
        for (let len = 1; len <= 16; len++) {
            for (let n = 0; n < table.bits[len - 1]; n++) { map.set(table.vals[k++], { code, len }); code++; }
            code <<= 1;
        }
        return map;
    }
    // 類別（magnitude category）：|v| 的位元數，0 為 0
    function category(v) { let a = Math.abs(v), s = 0; while (a) { s++; a >>= 1; } return s; }
    // 位元欄位：正數照寫，負數寫 v + 2^s − 1（1 補數）
    function magBits(v, s) { return v >= 0 ? v : v + (1 << s) - 1; }

    // 位元寫入（高位在前），掃描資料加 0xFF 填充（遇 0xFF 後補 0x00），最後補 1 到位元組邊界
    function bitWriter() {
        const out = []; let acc = 0, n = 0;
        function putByte(b) { out.push(b); if (b === 0xFF) out.push(0x00); }
        return {
            bits(v, len) { for (let i = len - 1; i >= 0; i--) { acc = (acc << 1) | ((v >> i) & 1); n++; if (n === 8) { putByte(acc); acc = 0; n = 0; } } },
            finish() { while (n !== 0) { acc = (acc << 1) | 1; n++; if (n === 8) { putByte(acc); acc = 0; n = 0; } } return Uint8Array.from(out); },
        };
    }

    // 編碼：blocks 是陣列，每個是 64 個量化係數（Z 字形順序，index 0 是 DC）。回傳掃描資料（已填充）。
    function encodeScan(blocks, dcTable = DC_LUMA, acTable = AC_LUMA) {
        const dc = buildCodes(dcTable), ac = buildCodes(acTable); const w = bitWriter(); let prev = 0;
        for (const blk of blocks) {
            const diff = blk[0] - prev; prev = blk[0];
            const s = category(diff); const c = dc.get(s); if (!c) throw new Error('DC 符號 ' + s + ' 不在表內');
            w.bits(c.code, c.len); if (s) w.bits(magBits(diff, s), s);
            let r = 0;
            for (let k = 1; k < 64; k++) {
                const v = blk[k];
                if (v === 0) { r++; continue; }
                while (r > 15) { const z = ac.get(0xF0); w.bits(z.code, z.len); r -= 16; }
                const sz = category(v); const sym = (r << 4) | sz; const e = ac.get(sym);
                if (!e) throw new Error('AC 符號 ' + sym.toString(16) + ' 不在表內');
                w.bits(e.code, e.len); w.bits(magBits(v, sz), sz); r = 0;
            }
            if (r > 0) { const eob = ac.get(0x00); w.bits(eob.code, eob.len); }
        }
        return w.finish();
    }

    // 解碼：data 是掃描資料（含填充），讀 nBlocks 個區塊。回傳 Z 字形順序的係數陣列。
    function decodeScan(data, nBlocks, dcTable = DC_LUMA, acTable = AC_LUMA) {
        const rev = (t) => { const m = new Map(); for (const [sym, c] of buildCodes(t)) m.set(c.len * 65536 + c.code, sym); return m; };
        const dcR = rev(dcTable), acR = rev(acTable);
        let pos = 0, acc = 0, n = 0;
        function bit() {
            if (n === 0) {
                if (pos >= data.length) throw new Error('掃描資料提早結束');
                let b = data[pos++];
                if (b === 0xFF) { const nb = data[pos++]; if (nb !== 0x00) throw new Error('掃描資料出現標記 0xFF' + nb.toString(16)); }
                acc = b; n = 8;
            }
            n--; return (acc >> n) & 1;
        }
        function bits(len) { let v = 0; for (let i = 0; i < len; i++) v = (v << 1) | bit(); return v; }
        function sym(map) { let code = 0; for (let len = 1; len <= 16; len++) { code = (code << 1) | bit(); const hit = map.get(len * 65536 + code); if (hit !== undefined) return hit; } throw new Error('找不到霍夫曼碼字'); }
        function extend(v, s) { return s === 0 ? 0 : v < (1 << (s - 1)) ? v - (1 << s) + 1 : v; }
        const out = []; let prev = 0;
        for (let b = 0; b < nBlocks; b++) {
            const blk = new Array(64).fill(0);
            const s = sym(dcR); const diff = extend(bits(s), s); prev += diff; blk[0] = prev;
            let k = 1;
            while (k < 64) {
                const rs = sym(acR); const r = rs >> 4, sz = rs & 15;
                if (sz === 0) { if (r === 15) { k += 16; continue; } break; }  // ZRL 或 EOB
                k += r; blk[k] = extend(bits(sz), sz); k++;
            }
            out.push(blk);
        }
        return out;
    }

    return { DC_LUMA, AC_LUMA, buildCodes, category, encodeScan, decodeScan };
});
