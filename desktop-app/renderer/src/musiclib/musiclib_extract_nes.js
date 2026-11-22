/* NES → NSF 的純邏輯（UMD，不碰 DOM、不跑 6502）。Worker 友善：沒有 window、沒有 fetch。
 *   parseInes(bytes)         → { ok, prg, chr, mapper, mirroring, battery, trainer, prgBanks, chrBanks, reason? }
 *   packNsf(opts)            → Uint8Array（標準 NSF：頭 0x80 位元組＋資料）
 *   parseNsf(bytes)          → { header 欄位…, data }
 *   inferPlay(events, opts)  → { ok, play, init, playFrames, reason }
 *   apuTraceToSong(events, opts) → { song(FaMidi 同形), stats }   退路：錄開機後播放的音樂（APU 暫存器寫入 → MIDI）
 *
 * 事件流（由跑 ROM 的執行器提供；jsnes 的掛鉤還沒接，見下方說明）：
 *   { k:'frame', handler }       NMI 進入（畫面中斷），handler 是 NMI 向量指到的位址
 *   { k:'call', target }         JSR 到 target
 *   { k:'ret' }                  RTS
 *   { k:'apu', addr, value }     寫 $4000–$4017（聲音暫存器）；寫入時的副程式由 call／ret 堆疊決定
 *
 * 跑 ROM 這一步（jsnes＋掛鉤）還沒有：jsnes 原始碼不在專案內，取得它需要網路下載，尚待使用者同意。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibNes = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PRG_BANK = 16384, CHR_BANK = 8192, TRAINER = 512;
  var CPU_NTSC = 1789773;          // NES CPU 時脈（NTSC），脈衝／三角波的頻率換算用
  var FRAME_NTSC = 60.0988;        // 每秒畫面數（NTSC NMI 頻率）
  var NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];

  // ───── iNES 檔頭 ─────
  function parseInes(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 16) return { ok: false, reason: '檔案只有 ' + b.length + ' 位元組，短於 iNES 檔頭 16' };
    if (b[0] !== 0x4E || b[1] !== 0x45 || b[2] !== 0x53 || b[3] !== 0x1A) return { ok: false, reason: '不是 iNES 檔（開頭不是 NES 加 0x1A）' };
    var prgBanks = b[4], chrBanks = b[5], f6 = b[6], f7 = b[7];
    var nes2 = (f7 & 0x0C) === 0x08;
    if (nes2) return { ok: false, reason: 'NES 2.0 格式未處理（頭部位元組 7 是 0x' + f7.toString(16) + '）' };
    var trainer = !!(f6 & 4), mapper = (f6 >> 4) | (f7 & 0xF0);
    var prgStart = 16 + (trainer ? TRAINER : 0), prgSize = prgBanks * PRG_BANK, chrSize = chrBanks * CHR_BANK;
    if (prgBanks === 0) return { ok: false, reason: 'PRG 區段為 0（頭部位元組 4 = 0）' };
    if (b.length < prgStart + prgSize) return { ok: false, reason: 'ROM 被截斷：需要 ' + (prgStart + prgSize) + ' 位元組，只有 ' + b.length };
    return {
      ok: true, mapper: mapper, prgBanks: prgBanks, chrBanks: chrBanks,
      mirroring: (f6 & 8) ? 'four-screen' : (f6 & 1) ? 'vertical' : 'horizontal',
      battery: !!(f6 & 2), trainer: trainer,
      prg: b.subarray(prgStart, prgStart + prgSize),
      chr: chrSize ? b.subarray(prgStart + prgSize, prgStart + prgSize + chrSize) : new Uint8Array(0)
    };
  }

  // ───── NSF（標準格式，128 位元組頭）─────
  function fillStr(out, off, s) { var str = String(s || ''), bytes = []; for (var j = 0; j < str.length && j < 31; j++) bytes.push(str.charCodeAt(j) & 0xFF); for (var i = 0; i < 32; i++) out[off + i] = i < bytes.length ? bytes[i] : 0; }
  function le16(out, off, v) { out[off] = v & 255; out[off + 1] = (v >> 8) & 255; }
  function packNsf(o) {
    o = o || {};
    var data = o.prg instanceof Uint8Array ? o.prg : Uint8Array.from(o.prg || []);
    var h = new Uint8Array(0x80 + data.length);
    h.set([0x4E, 0x45, 0x53, 0x4D, 0x1A], 0);              // "NESM" 0x1A
    h[5] = 1;                                              // 版本
    h[6] = o.songs || 1;
    h[7] = o.start || 1;
    le16(h, 8, o.load == null ? 0x8000 : o.load);
    le16(h, 10, o.init == null ? 0x8000 : o.init);
    le16(h, 12, o.play == null ? 0x8000 : o.play);
    fillStr(h, 0x0E, o.name); fillStr(h, 0x2E, o.artist); fillStr(h, 0x4E, o.copyright);
    le16(h, 0x6E, o.ntscSpeed || 16639);                   // 1/1000000 秒，約 60 Hz
    var bankInit = o.banks || [0, 0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < 8; i++) h[0x70 + i] = bankInit[i] || 0;
    le16(h, 0x78, o.palSpeed || 19997);
    h[0x7A] = o.pal ? 1 : 0;
    h[0x7B] = o.chipBits || 0;
    h.set(data, 0x80);
    return h;
  }
  function parseNsf(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    if (b.length < 0x80 || b[0] !== 0x4E || b[1] !== 0x45 || b[2] !== 0x53 || b[3] !== 0x4D || b[4] !== 0x1A) return { ok: false, reason: '不是 NSF 檔（開頭不是 NESM 0x1A）' };
    function s32(o) { var a = []; for (var i = 0; i < 32; i++) { if (!b[o + i]) break; a.push(b[o + i]); } return String.fromCharCode.apply(null, a); }
    function u16(o) { return b[o] | (b[o + 1] << 8); }
    return {
      ok: true, version: b[5], songs: b[6], start: b[7], load: u16(8), init: u16(10), play: u16(12),
      name: s32(0x0E), artist: s32(0x2E), copyright: s32(0x4E), ntscSpeed: u16(0x6E),
      banks: Array.from(b.subarray(0x70, 0x78)), palSpeed: u16(0x78), pal: !!(b[0x7A] & 1),
      data: b.subarray(0x80)
    };
  }

  // ───── 推導 PLAY／INIT ─────
  // 規則：每個畫面（NMI）內寫聲音暫存器的副程式（堆疊頂端）。在最多畫面數寫聲音的副程式就是 PLAY。
  // INIT：第一個畫面之前、最外層（堆疊深度 1）、而且它之下的呼叫裡有寫聲音的那個呼叫。
  function inferPlay(events, opts) {
    opts = opts || {};
    var minFrames = opts.minFrames || 3;
    if (!events || !events.length) return { ok: false, reason: '沒有執行紀錄（事件為空）' };
    var frames = 0, firstFrameIdx = -1;
    var stack = [], perFrame = [], cur = null, initCand = {};
    events.forEach(function (e, idx) {
      if (e.k === 'frame') {
        if (firstFrameIdx < 0) firstFrameIdx = idx;
        frames++; cur = {}; perFrame.push(cur);
        stack = [e.handler];
      } else if (e.k === 'call') {
        stack.push({ target: e.target, writes: 0, depth: stack.length, before: frames === 0, outer: stack.length === 0 });
      } else if (e.k === 'ret') {
        var top = stack.pop();
        if (top && typeof top === 'object' && top.writes > 0 && stack.length) { var p = stack[stack.length - 1]; if (typeof p === 'object') p.writes += top.writes; }
        if (top && typeof top === 'object' && top.before && top.outer && top.writes > 0) initCand[top.target] = (initCand[top.target] || 0) + 1;
      } else if (e.k === 'apu') {
        var r = stack[stack.length - 1];
        var routine = typeof r === 'object' ? r.target : r;
        if (typeof r === 'object') r.writes++;
        if (cur) cur[routine] = (cur[routine] || 0) + 1;
      }
    });
    if (!frames) return { ok: false, reason: '執行紀錄裡沒有畫面中斷（NMI），無法判斷每畫面的聲音副程式' };
    var tally = {};
    perFrame.forEach(function (f) { Object.keys(f).forEach(function (k) { tally[k] = (tally[k] || 0) + 1; }); });
    var best = null, bestN = 0;
    Object.keys(tally).forEach(function (k) { if (tally[k] > bestN) { bestN = tally[k]; best = +k; } });
    if (best == null || bestN < minFrames) return { ok: false, playFrames: bestN, frames: frames, reason: '無法抽出播放入口：沒有一個副程式在至少 ' + minFrames + ' 個畫面裡寫聲音（最多 ' + bestN + ' 個畫面，共 ' + frames + ' 個畫面）' };
    var init = null, initN = 0;
    Object.keys(initCand).forEach(function (k) { if (initCand[k] > initN) { initN = initCand[k]; init = +k; } });
    return {
      ok: true, play: best, playFrames: bestN, frames: frames,
      init: init, initReason: init == null ? 'INIT 無法確定：第一個畫面之前沒有最外層的寫聲音呼叫' : null
    };
  }

  // ───── 退路：APU 暫存器寫入序列 → MIDI ─────
  // 脈衝 1（$4000–$4003）、脈衝 2（$4004–$4007）、三角波（$4008–$400B）、雜訊（$400C–$400F）。
  // 音符在暫存器寫入時開始（$4003／$400B／$400F）、在 $4015 關掉該聲道或被新音取代時結束。時間以畫面數換算（約 16.7 毫秒的解析度）。
  // DPCM（$4010–$4013）不轉，只計數（stats.dpcmWrites）。
  function apuTraceToSong(events, opts) {
    opts = opts || {};
    var ticksPerSec = (opts.ppq || 480) * 2;           // 120 BPM：每秒 2 拍
    var frame = 0, reg = {}, enable = 0, cur = { p1: null, p2: null, tri: null, noise: null }, notes = { p1: [], p2: [], tri: [], noise: [] }, stats = { apuWrites: 0, dpcmWrites: 0, frames: 0 };
    function sec(f) { return f / FRAME_NTSC; }
    function endNote(ch) { var n = cur[ch]; if (!n) return; n.end = frame; notes[ch].push(n); cur[ch] = null; }
    function startNote(ch, midi) { endNote(ch); cur[ch] = { start: frame, n: midi }; }
    function pulseMidi(period) { var f = CPU_NTSC / (16 * (period + 1)); return { f: f, n: Math.round(69 + 12 * Math.log(f / 440) / Math.LN2) }; }
    events.forEach(function (e) {
      if (e.k === 'frame') { frame++; stats.frames++; return; }
      if (e.k !== 'apu') return;
      stats.apuWrites++;
      var a = e.addr, v = e.value & 0xFF;
      reg[a] = v;
      if (a >= 0x4010 && a <= 0x4013) { stats.dpcmWrites++; return; }
      if (a === 0x4015) {
        enable = v;
        if (!(v & 1)) endNote('p1'); if (!(v & 2)) endNote('p2'); if (!(v & 4)) endNote('tri'); if (!(v & 8)) endNote('noise');
        return;
      }
      if (a === 0x4003 && (enable & 1)) { var p1 = ((v & 7) << 8) | (reg[0x4002] || 0); if (p1 >= 8) startNote('p1', pulseMidi(p1).n); else endNote('p1'); }
      if (a === 0x4007 && (enable & 2)) { var p2 = ((v & 7) << 8) | (reg[0x4006] || 0); if (p2 >= 8) startNote('p2', pulseMidi(p2).n); else endNote('p2'); }
      if (a === 0x400B && (enable & 4)) { var pt = ((v & 7) << 8) | (reg[0x400A] || 0); if (pt >= 2) { var f = CPU_NTSC / (32 * (pt + 1)); startNote('tri', Math.round(69 + 12 * Math.log(f / 440) / Math.LN2)); } else endNote('tri'); }
      if (a === 0x400F && (enable & 8)) { startNote('noise', (reg[0x400E] & 0x80) ? 38 : 42); }
    });
    ['p1', 'p2', 'tri', 'noise'].forEach(endNote);
    function toTrack(list, ch, name, prog, drum) {
      return { name: name, channel: ch, program: prog, drum: drum, volume: 100, pan: 64, notes: list.map(function (x) {
        var t0 = Math.round(sec(x.start) * ticksPerSec), t1 = Math.round(sec(x.end) * ticksPerSec);
        return { t: t0, d: Math.max(1, t1 - t0), n: Math.max(0, Math.min(127, x.n)), v: 100 };
      }) };
    }
    var song = { ppq: opts.ppq || 480, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: opts.title || '', tracks: [] };
    var drumList = notes.noise.map(function (x) { return { start: x.start, end: x.end, n: x.n }; });
    [['p1', '脈衝 1', 0, 80], ['p2', '脈衝 2', 1, 80], ['tri', '三角波', 2, 79]].forEach(function (c) {
      if (notes[c[0]].length) song.tracks.push(toTrack(notes[c[0]], c[2], c[1], c[3], false));
    });
    if (drumList.length) song.tracks.push(toTrack(drumList, 9, '雜訊（打擊，近似）', 0, true));
    stats.notes = notes.p1.length + notes.p2.length + notes.tri.length + notes.noise.length;
    stats.seconds = Math.round(sec(frame) * 10) / 10;
    return { song: song, stats: stats };
  }

  // ───── 執行 ROM（jsnes，由呼叫端注入 NES 類別）─────
  // 掛鉤：APU 寫入（nes.papu.writeReg，mapper 會動態呼叫它）；指令層（cpu.emulate 包一層，記下 JSR／RTS／RTI 與 NMI 進入）。
  function romToBinaryString(b) { var s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(b.length, i + 0x8000))); return s; }
  function traceRom(romBytes, NES, opts) {
    opts = opts || {};
    var frames = opts.frames || 600, events = [], crashed = null, ran = 0;
    var nes = new NES({ onFrame: function () {}, onAudioSample: null });
    nes.loadROM(romToBinaryString(romBytes));
    var cpu = nes.cpu, mem = cpu.mem;
    var nmiVec = mem[0xFFFA] | (mem[0xFFFB] << 8);
    var papu = nes.papu, origWrite = papu.writeReg;
    papu.writeReg = function (addr, value) { events.push({ k: 'apu', addr: addr & 0xFFFF, value: value & 0xFF }); return origWrite.call(this, addr, value); };
    var origEmu = cpu.emulate, inHandler = false;
    cpu.emulate = function () {
      var pc = this.REG_PC, op = this.mem[pc];
      if (pc === nmiVec && !inHandler) { events.push({ k: 'frame', handler: nmiVec }); inHandler = true; }
      if (op === 0x20) events.push({ k: 'call', target: this.mem[(pc + 1) & 0xFFFF] | (this.mem[(pc + 2) & 0xFFFF] << 8) });
      else if (op === 0x60) events.push({ k: 'ret' });
      else if (op === 0x40) inHandler = false;          // RTI：NMI 結束
      return origEmu.call(this);
    };
    try { for (ran = 0; ran < frames; ran++) nes.frame(); }
    catch (e) { crashed = String((e && e.message) || e); }
    return { events: events, nmiVector: nmiVec, framesRun: ran, crashed: crashed };
  }

  // 抽出 NSF（mapper 0）；同時產生退路 MIDI。回傳 { ok, mode:'nsf'|'midi', nsf?, play?, init?, song, stats, reason? }
  function extractNsf(romBytes, NES, opts) {
    opts = opts || {};
    var rom = parseInes(romBytes);
    if (!rom.ok) return { ok: false, stage: '檔頭', reason: rom.reason };
    var tr;
    try { tr = traceRom(romBytes, NES, { frames: opts.frames || 600 }); }
    catch (e) { return { ok: false, stage: '執行', reason: 'ROM 執行失敗：' + String((e && e.message) || e) }; }
    var midi = apuTraceToSong(tr.events, { title: opts.title || '' });
    var base = { song: midi.song, stats: Object.assign({ framesRun: tr.framesRun, crashed: tr.crashed }, midi.stats), mapper: rom.mapper };
    var inf = inferPlay(tr.events, {});
    if (!inf.ok) return Object.assign(base, { ok: false, stage: '入口', mode: 'midi', reason: inf.reason });
    if (inf.init == null) return Object.assign(base, { ok: false, stage: '入口', mode: 'midi', play: inf.play, reason: inf.initReason });
    if (rom.mapper !== 0) return Object.assign(base, { ok: false, stage: '打包', mode: 'midi', play: inf.play, init: inf.init, reason: 'NSF 打包目前只支援 mapper 0（NROM）；這個 ROM 是 mapper ' + rom.mapper + '，需要銀行初值（未實作）' });
    var load = rom.prgBanks === 1 ? 0xC000 : 0x8000;
    var nsf = packNsf({ prg: rom.prg, load: load, init: inf.init, play: inf.play, songs: 1, start: 1, name: opts.name || '' });
    return Object.assign(base, { ok: true, mode: 'nsf', nsf: nsf, play: inf.play, init: inf.init, load: load });
  }

  return {
    traceRom: traceRom, extractNsf: extractNsf,
    parseInes: parseInes, packNsf: packNsf, parseNsf: parseNsf, inferPlay: inferPlay, apuTraceToSong: apuTraceToSong,
    NOISE_PERIOD: NOISE_PERIOD, CPU_NTSC: CPU_NTSC, FRAME_NTSC: FRAME_NTSC
  };
}));
