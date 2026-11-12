#!/usr/bin/env node
// 外部驗證：CABAC I 條帶（全部 I_PCM 巨集區塊）與 ffmpeg 逐位元對照。
// 做法：
//   1. x264 只提供 SPS、PPS（取自 64×64 的 CABAC 編碼，不採用其 IDR 條帶）。
//   2. 自寫 IDR 的 I 條帶：4×4 個巨集區塊，每個都是 I_PCM。mb_type 的第 0 個二值用上下文 ctxIdx 3＋增量，
//      增量＝（左邊有鄰居）＋（上面有鄰居）＝0、1、2，因此用到 ctxIdx 3、4、5；第 1 個二值是終止二值（1 表示 I_PCM）。
//      I_PCM 後：對齊位元補 0、384 個位元組的原始樣本、重新初始化編碼引擎（上下文狀態不動），再送 end_of_slice_flag。
//   3. ffmpeg 解出的影像必須與送進去的樣本逐位元相同（I_PCM 直接複製樣本，不經變換與預測）。
//   4. 負向對照：ctxIdx 3 的 valMPS 故意翻轉，解出的影像必須不同或報錯。
// 驗證的是：I 條帶 ctxIdx 3、4、5 的初始化（與 domain_h264cabac_core.js 的 ctxinit 表一致）、終止二值作為 I_PCM 旗標、
// 終止後的收尾與位元對齊、以及引擎重新初始化。沒有驗證：非 PCM 巨集區塊的語法（殘差、預測）。
// 用法：node scripts/eval/cabac-ipcm-ffmpeg.js   需要 ffmpeg 含 libx264（只用來產生 SPS、PPS）。
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { splitNals, bitsOf, ueBits, seBits, Enc, nalBytes } = require('./h264-cabac-enc.js');

const W = 64, MBW = W / 16, MBS = MBW * MBW, FS = W * W * 3 / 2;
// ctxIdx 3、4、5 的 (m, n)：與 domain_h264cabac_core.js 的 ctxinit 表相同（I 條帶 0 至 10 與所有條帶共用）
const MN = { 3: [20, -15], 4: [2, 54], 5: [3, 74] };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cabac-ipcm-'));
const ff = (args) => cp.spawnSync('ffmpeg', ['-v', 'error'].concat(args), { encoding: 'buffer', maxBuffer: 1 << 26 });

function initCtx(ctxIdx, qpDelta, wrong) {
    const [m, n] = MN[ctxIdx]; const qp = Math.min(Math.max(23 + qpDelta, 0), 51);
    const pre = Math.min(Math.max(((m * qp) >> 4) + n, 1), 126);
    const c = pre <= 63 ? { p: 63 - pre, m: 0 } : { p: pre - 64, m: 1 };
    if (wrong && ctxIdx === 3) c.m = 1 - c.m;
    return c;
}

// 產生固定的 PCM 樣本（每個巨集區塊：256 個亮度、64 個 Cb、64 個 Cr），依巨集區塊順序
function makeSamples(seed) {
    let s = seed; const rnd = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return (s >> 8) & 255; };
    const mbs = []; for (let i = 0; i < MBS; i++) { const y = [], u = [], v = []; for (let k = 0; k < 256; k++) y.push(rnd()); for (let k = 0; k < 64; k++) u.push(rnd()); for (let k = 0; k < 64; k++) v.push(rnd()); mbs.push({ y, u, v }); }
    return mbs;
}

// 依巨集區塊樣本組出 yuv420p 影格（與 ffmpeg 的平面順序一致）
function toYuv(mbs) {
    const Y = new Uint8Array(W * W), U = new Uint8Array(W * W / 4), V = new Uint8Array(W * W / 4);
    mbs.forEach((mb, i) => {
        const mx = i % MBW, my = Math.floor(i / MBW);
        for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) Y[(my * 16 + r) * W + mx * 16 + c] = mb.y[r * 16 + c];
        for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { U[(my * 8 + r) * (W / 2) + mx * 8 + c] = mb.u[r * 8 + c]; V[(my * 8 + r) * (W / 2) + mx * 8 + c] = mb.v[r * 8 + c]; }
    });
    return Buffer.concat([Buffer.from(Y), Buffer.from(U), Buffer.from(V)]);
}

function idrNal(mbs, qpDelta, wrong) {
    const header = [
        ueBits(0),          // first_mb_in_slice
        ueBits(7),          // slice_type＝7（I，全部）
        ueBits(0),          // pic_parameter_set_id
        '0000',             // frame_num
        ueBits(0),          // idr_pic_id
        '0', '0',           // no_output_of_prior_pics_flag、long_term_reference_flag
        seBits(qpDelta),    // slice_qp_delta
        ueBits(1),          // disable_deblocking_filter_idc＝1
    ].join('');
    const bits = bitsOf(header);
    while (bits.length % 8 !== 0) bits.push(1);
    const enc = new Enc();
    // 上下文狀態跨巨集區塊保留（每個 ctxIdx 只初始化一次）
    const ctxs = { 3: initCtx(3, qpDelta, wrong), 4: initCtx(4, qpDelta, wrong), 5: initCtx(5, qpDelta, wrong) };
    mbs.forEach((mb, i) => {
        const mx = i % MBW, my = Math.floor(i / MBW);
        const inc = (mx > 0 ? 1 : 0) + (my > 0 ? 1 : 0);
        enc.decision(ctxs[3 + inc], 1);                        // mb_type bin0＝1（不是 I_NxN）
        enc.terminate(1);                                      // mb_type bin1＝終止二值 1（I_PCM），內含 EncodeFlush
        while (enc.bits.length % 8 !== 0) enc.bits.push(0);    // pcm_alignment_zero_bit
        for (const b of [...mb.y, ...mb.u, ...mb.v]) for (let j = 7; j >= 0; j--) enc.bits.push((b >> j) & 1);
        enc.reinit();                                          // 9.3.1.2：PCM 後重新初始化引擎
        enc.terminate(i === MBS - 1 ? 1 : 0);                  // end_of_slice_flag
    });
    while (enc.bits.length % 8 !== 0) enc.bits.push(0);
    return nalBytes(0x65, bits.concat(enc.bits));              // nal_ref_idc＝3、nal_unit_type＝5
}

function main() {
    const probe = cp.spawnSync('ffmpeg', ['-hide_banner', '-encoders'], { encoding: 'utf8' });
    if (probe.status !== 0 || !/libx264/.test(probe.stdout)) { console.log('略過：ffmpeg 沒有 libx264'); process.exit(0); }
    const seedFile = path.join(tmp, 'seed.264');
    const e = ff(['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=1:duration=1', '-frames:v', '1', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-profile:v', 'main',
        '-x264-params', 'cabac=1:keyint=1:bframes=0:ref=1:deblock=0,0:no-scenecut=1:weightp=0', '-f', 'h264', seedFile]);
    if (e.status !== 0) { console.log('略過：x264 編碼失敗：' + e.stderr); process.exit(0); }
    const nals = splitNals(fs.readFileSync(seedFile));
    const sps = nals.find((n) => (n[0] & 31) === 7), pps = nals.find((n) => (n[0] & 31) === 8);
    if (!sps || !pps) { console.log('FAIL 找不到 SPS 或 PPS'); process.exit(1); }
    const ann = (b) => Buffer.concat([Buffer.from([0, 0, 0, 1]), b]);
    const head = Buffer.concat([ann(sps), ann(pps)]);
    const cases = [-6, 0, 10];
    const mbs = makeSamples(20261112);
    const expect = toYuv(mbs);
    let pass = 0; const fails = [];
    for (const qpDelta of cases) {
        const f = path.join(tmp, 'ipcm_' + qpDelta + '.264');
        fs.writeFileSync(f, Buffer.concat([head, ann(idrNal(mbs, qpDelta, false))]));
        const d = ff(['-i', f, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
        if (d.status === 0 && d.stderr.length === 0 && d.stdout.length === FS && d.stdout.equals(expect)) pass++;
        else fails.push('qpDelta ' + qpDelta + '：' + (d.stderr.length ? String(d.stderr).slice(0, 120) : '影格位元組 ' + d.stdout.length + '，與樣本不同'));
    }
    console.log('CABAC I_PCM 對 ffmpeg：' + pass + '/' + cases.length + ' 組影像與送入的樣本逐位元相同');
    fails.forEach((x) => console.log('  ✗ ' + x));
    let negSame = 0;
    for (const qpDelta of cases) {
        const f = path.join(tmp, 'neg_' + qpDelta + '.264');
        fs.writeFileSync(f, Buffer.concat([head, ann(idrNal(mbs, qpDelta, true))]));
        const d = ff(['-i', f, '-f', 'rawvideo', '-pix_fmt', 'yuv420p', '-']);
        if (d.status === 0 && d.stderr.length === 0 && d.stdout.equals(expect)) negSame++;
    }
    console.log('負向對照（ctxIdx 3 的 valMPS 故意翻轉）：' + (cases.length - negSame) + '/' + cases.length + ' 組與正確結果不同或報錯（應為全部）');
    const okAll = pass === cases.length && negSame === 0;
    fs.rmSync(tmp, { recursive: true, force: true });
    console.log(okAll ? '通過' : 'FAIL');
    process.exit(okAll ? 0 : 1);
}

if (require.main === module) main();
module.exports = { makeSamples, toYuv, idrNal, MBS, FS };
