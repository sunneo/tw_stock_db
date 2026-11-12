#!/usr/bin/env node
// 外部驗證：CABAC 位元與 ffmpeg 逐位元對照（以「全部 P_Skip」的 P 條帶為向量）。
// 做法：
//   1. 用 libx264（cabac=1）編一張 64×64 的 IDR（4×4 個巨集區塊），只取其中的 SPS、PPS、IDR 條帶（不採用 x264 的 P 條帶）。
//   2. 自寫一個 P 條帶：4×4 巨集區塊全部 mb_skip_flag＝1（上下文 ctxIdx 11，增量恆為 0，因為鄰居都是略過），
//      每個巨集區塊後送 end_of_slice_flag（終止二值，9.3.4.5）。上下文初始化用 domain_h264pb_core.js 的 P／B 表（ctxIdx 11）。
//   3. ffmpeg 解碼「SPS、PPS、IDR、P」：第二張影格必須與第一張（IDR）逐位元相同（P_Skip 的運動向量為 0、無殘差、關閉去區塊）。
//   4. 負向對照：把 ctxIdx 11 的初始 valMPS 故意翻轉，ffmpeg 解出來的第二張必須不同或報錯；否則這個測試沒有鑑別力。
// 這驗證的是：ctxIdx 11 在 cabac_init_idc 0、1、2 與多個 SliceQPY 下的初始化、算術編碼器（含位元欠款、收尾）與終止二值。
// 沒有驗證：ctxIdx 12、13 與非略過鄰居的增量（需要非略過的巨集區塊語法，未做）。
// 用法：node scripts/eval/cabac-pskip-ffmpeg.js
// 需要：ffmpeg 含 libx264（只用來產生 SPS、PPS、IDR）。沒有就印「略過」並以 0 結束。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const CB = require('../../renderer/src/uml/domain_h264cabac_core.js');
const PB = require('../../renderer/src/uml/domain_h264pb_core.js');

const RANGE = CB.RANGE_LPS, TL = CB.TRANS_LPS;
const W = 64, MBS = (W / 16) * (W / 16), FS = W * W * 3 / 2;   // 64×64、4×4 個巨集區塊、每張影格的位元組數
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cabac-pskip-'));
const ff = (args, opts) => cp.spawnSync('ffmpeg', ['-v', 'error'].concat(args), Object.assign({ encoding: 'buffer', maxBuffer: 1 << 26 }, opts || {}));

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

// ---------- 產生一個 P 條帶（全部 P_Skip）----------
// wrongInit：負向對照用，翻轉 ctxIdx 11 的 valMPS。
function pSkipNal({ idc, qpDelta, wrongInit }) {
    const mn = PB.PB_T[idc][11];
    const qp = Math.min(Math.max(23 + qpDelta, 0), 51);   // SliceQPY＝26＋pic_init_qp_minus26（−3）＋slice_qp_delta
    const pre = Math.min(Math.max(((mn[0] * qp) >> 4) + mn[1], 1), 126);
    let ctx = pre <= 63 ? { p: 63 - pre, m: 0 } : { p: pre - 64, m: 1 };
    // 負向對照：翻轉 valMPS（全部都是 MPS 的串流若只改 pStateIdx，5/9 仍會解出相同結果，鑑別力不足，已實測）
    if (wrongInit) ctx.m = 1 - ctx.m;
    const header = [
        ueBits(0),              // first_mb_in_slice
        ueBits(5),              // slice_type＝5（P，全部）
        ueBits(0),              // pic_parameter_set_id
        '0001',                 // frame_num（4 位元）
        '0',                    // num_ref_idx_active_override_flag
        '0',                    // ref_pic_list_modification_flag_l0
        '0',                    // adaptive_ref_pic_marking_mode_flag（nal_ref_idc≠0）
        ueBits(idc),            // cabac_init_idc
        seBits(qpDelta),        // slice_qp_delta
        ueBits(1),              // disable_deblocking_filter_idc＝1（關閉）
    ].join('');
    const bits = bitsOf(header);
    while (bits.length % 8 !== 0) bits.push(1);   // cabac_alignment_one_bit
    const enc = new Enc();
    for (let mb = 0; mb < MBS; mb++) {
        enc.decision(ctx, 1);                     // mb_skip_flag＝1
        enc.terminate(mb === MBS - 1 ? 1 : 0);          // end_of_slice_flag
    }
    while (enc.bits.length % 8 !== 0) enc.bits.push(0);
    return nalBytes(0x41, bits.concat(enc.bits)); // nal_ref_idc＝2、nal_unit_type＝1
}

// ---------- 解碼並比對 ----------
function decodeYuv(file) {
    const r = ff(['-i', file, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
    return { ok: r.status === 0 && r.stderr.length === 0, out: r.stdout, err: String(r.stderr || '') };
}

function main() {
    const probe = cp.spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (probe.status !== 0 || !/libx264/.test(probe.stdout)) { console.log('略過：ffmpeg 沒有 libx264'); process.exit(0); }
    const idrFile = path.join(tmp, 'idr.264');
    const enc = ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', 'yuv420p',
        '-c:v', 'libx264', '-profile:v', 'main', '-x264-params', 'cabac=1:keyint=1:bframes=0:ref=1:deblock=0,0:no-scenecut=1:weightp=0', '-f', 'h264', idrFile]);
    if (enc.status !== 0) { console.log('略過：x264 編碼失敗：' + enc.stderr); process.exit(0); }
    const nals = splitNals(fs.readFileSync(idrFile));
    const sps = nals.find((n) => (n[0] & 31) === 7), pps = nals.find((n) => (n[0] & 31) === 8), idr = nals.find((n) => (n[0] & 31) === 5);
    if (!sps || !pps || !idr) { console.log('FAIL 找不到 SPS、PPS、IDR'); process.exit(1); }
    const ann = (b) => Buffer.concat([Buffer.from([0, 0, 0, 1]), b]);
    const base = Buffer.concat([ann(sps), ann(pps), ann(idr)]);
    const basePath = path.join(tmp, 'base.264');
    fs.writeFileSync(basePath, base);
    const ref = decodeYuv(basePath);
    if (!ref.ok || ref.out.length !== FS) { console.log('FAIL 基底 IDR 解碼失敗：' + ref.err); process.exit(1); }
    const frame0 = ref.out;

    const cases = [];
    for (const idc of [0, 1, 2]) for (const qpDelta of [-6, 0, 10]) cases.push({ idc, qpDelta });
    let pass = 0, fail = [];
    for (const c of cases) {
        const f = path.join(tmp, 'p_' + c.idc + '_' + c.qpDelta + '.264');
        fs.writeFileSync(f, Buffer.concat([base, ann(pSkipNal(c))]));   // base 已含 SPS、PPS、IDR，末尾接 P 條帶
        const d = decodeYuv(f);
        const frames = d.out.length;
        const second = d.out.subarray(FS, 2 * FS);
        const same = d.ok && frames === 2 * FS && second.equals(frame0);
        if (same) pass++; else fail.push(JSON.stringify(c) + '：' + (d.ok ? '影格數 ' + (frames / FS) : '錯誤 ' + d.err.slice(0, 120)));
    }
    console.log('CABAC P_Skip 對 ffmpeg：' + pass + '/' + cases.length + ' 組第二張與 IDR 逐位元相同');
    fail.forEach((x) => console.log('  ✗ ' + x));

    // 負向對照：錯誤的 ctxIdx 11 初始化，ffmpeg 不得給出相同結果
    let negSame = 0;
    for (const c of cases) {
        const f = path.join(tmp, 'neg_' + c.idc + '_' + c.qpDelta + '.264');
        fs.writeFileSync(f, Buffer.concat([base, ann(pSkipNal(Object.assign({ wrongInit: true }, c)))]));
        const d = decodeYuv(f);
        if (d.ok && d.out.length === 2 * FS && d.out.subarray(FS, 2 * FS).equals(frame0)) negSame++;
    }
    console.log('負向對照（ctxIdx 11 的 valMPS 故意翻轉）：' + (cases.length - negSame) + '/' + cases.length + ' 組與正確結果不同或報錯（應為全部）');
    const okAll = pass === cases.length && negSame === 0;
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(okAll ? '通過' : 'FAIL');
    process.exit(okAll ? 0 : 1);
}

main();
