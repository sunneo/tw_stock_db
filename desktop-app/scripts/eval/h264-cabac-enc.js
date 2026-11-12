'use strict';
// 共用：H.264 位元寫入、Annex B 切 NAL、CABAC 編碼器（9.3.4，含終止二值與 I_PCM 收尾）、NAL 組裝（防競爭位元組）。
// 由 cabac-pskip-ffmpeg.js 與 cabac-ipcm-ffmpeg.js 使用。
const CB = require('../../renderer/src/uml/domain_h264cabac_core.js');
const RANGE = CB.RANGE_LPS, TL = CB.TRANS_LPS;

// ---------- 讀 Annex B，切出 NAL（不含起始碼）----------
function splitNals(buf) {
    const out = []; let i = 0; const starts = [];
    while (i + 3 <= buf.length) {
        if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) { starts.push(i + 3); i += 3; } else i++;
    }
    for (let k = 0; k < starts.length; k++) {
        let end = k + 1 < starts.length ? starts[k + 1] - 3 : buf.length;
        while (end > starts[k] && buf[end - 1] === 0) end--;
        out.push(buf.subarray(starts[k], end));
    }
    return out;
}

// ---------- 位元寫入器 ----------
const bitsOf = (s) => s.split('').map((c) => (c === '1' ? 1 : 0));
const ueBits = (v) => { const x = v + 1; const n = Math.floor(Math.log2(x)); return '0'.repeat(n) + x.toString(2); };
const seBits = (v) => ueBits(v > 0 ? 2 * v - 1 : -2 * v);

// ---------- CABAC 編碼器（9.3.4.2、9.3.4.5）----------
class Enc {
    constructor() { this.low = 0; this.rng = 510; this.first = true; this.outst = 0; this.bits = []; }
    putBit(b) {
        if (this.first) this.first = false; else this.bits.push(b);
        while (this.outst > 0) { this.bits.push(1 - b); this.outst--; }
    }
    renorm() {
        while (this.rng < 256) {
            if (this.low < 256) this.putBit(0);
            else if (this.low >= 512) { this.low -= 512; this.putBit(1); }
            else { this.low -= 256; this.outst++; }
            this.rng <<= 1; this.low <<= 1;
        }
    }
    decision(ctx, bin) {
        const lps = RANGE[ctx.p][(this.rng >> 6) & 3];
        this.rng -= lps;
        if (bin !== ctx.m) {
            this.low += this.rng; this.rng = lps;
            if (ctx.p === 0) ctx.m = 1 - ctx.m;
            ctx.p = TL[ctx.p];
        } else {
            ctx.p = ctx.p < 62 ? ctx.p + 1 : ctx.p;
        }
        this.renorm();
    }
    terminate(bin) {
        this.rng -= 2;
        if (bin) { this.low += this.rng; this.flush(); } else this.renorm();
    }
    flush() {
        this.rng = 2; this.renorm();
        this.putBit((this.low >> 9) & 1);
        const w = ((this.low >> 7) & 3) | 1;
        this.bits.push((w >> 1) & 1, w & 1);   // 最後一位就是 rbsp_stop_one_bit
    }
}

// ---------- 組 NAL（加防競爭位元組）----------
function nalBytes(hdr, rbspBits) {
    const bytes = [hdr]; let zeros = 0;
    const rb = []; for (let i = 0; i < rbspBits.length; i += 8) {
        let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | (rbspBits[i + j] || 0);
        rb.push(v);
    }
    for (const v of rb) {
        if (zeros >= 2 && v <= 3) { bytes.push(3); zeros = 0; }
        bytes.push(v); zeros = v === 0 ? zeros + 1 : 0;
    }
    return Buffer.from([0, 0, 0, 1].concat(bytes));
}


// 重新初始化編碼引擎（9.3.4.1）：上下文狀態不動；用於 I_PCM 之後。
Enc.prototype.reinit = function () { this.low = 0; this.rng = 510; this.first = true; this.outst = 0; };

module.exports = { splitNals, bitsOf, ueBits, seBits, Enc, nalBytes };
