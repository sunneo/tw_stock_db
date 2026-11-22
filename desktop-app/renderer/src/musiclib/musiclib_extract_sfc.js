/* SFC（超任）遊戲音樂擷取（UMD，純邏輯；不碰 DOM、不用網路）。
 *   classifySfc(name, bytes)        → { cls:'rom'|'nonrom', kind, label }   副檔名 .sfc／.smc；有 512 位元組 copier 檔頭也認
 *   parseSnesHeader(bytes)          → 去掉 copier 檔頭後的內部標頭（LoROM／HiROM、標題、校驗和是否吻合）
 *   packSpc(opts) / parseSpc(bytes) → 標準 .spc（0x10200 位元組：SPC700 RAM 64KB、DSP 暫存器 128、SPC700 暫存器、ID666 標籤）
 *   dspEventsToSong(events, opts)   → { song（與 FaMidi 同形）, stats }；退路：DSP 的 KON／KOFF／音高寫入 → MIDI
 *   sfcExtract(romBytes, opts)      → { stages[], ... }；每一階段各自寫明成功或失敗原因（目前主 CPU 執行器與 snes_spc 渲染器的接線尚未完成，見 stages）
 *
 * DSP 事件格式（呼叫端從 SPC700 寫 $F2／$F3 的紀錄整理出來）：
 *   { t: <DSP 取樣序號，32 kHz>, reg: 0–127, value: 0–255 }
 * 音高：每個聲道 14 位元（VxPITCHL + VxPITCHH 低 6 位），頻率 = 音高 × 32000 ÷ 4096 Hz（與 SPC 的 DSP 定義相同）。
 * 限制（會寫進 stats）：音高改變視為換音（不做滑音）；音量只用 VxVOLL／VxVOLR 的平均當力度；音色不還原（MIDI 用程式 80），那是退路。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibSfc = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var COPIER = 512, LO_HDR = 0x7FC0, HI_HDR = 0xFFC0, DSP_RATE = 32000;
  var SPC_SIZE = 0x10200, SPC_RAM = 0x100, SPC_DSP = 0x10100, SPC_EXTRA = 0x101C0;
  var SPC_SIG = 'SNES-SPC700 Sound File Data v0.30';
  var REG_KON = 0x4C, REG_KOFF = 0x5C;
  var STAGES = ['掃描辨識', '執行 ROM（主 CPU）', '偵測聲音上傳完成並傾印', '組成 .spc', 'SPC 渲染成 wav', 'wav 轉 mp3', '退路 MIDI'];

  function asU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }
  function ascii(b, o, n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(b[o + i] == null ? 0 : b[o + i]); return s; }
  function put(out, off, s, n) { for (var i = 0; i < n; i++) out[off + i] = i < s.length ? (s.charCodeAt(i) & 0xFF) : 0; }
  function getStr(b, off, n) { var s = ''; for (var i = 0; i < n; i++) { if (!b[off + i]) break; s += String.fromCharCode(b[off + i]); } return s; }

  // ───── 分類：.sfc／.smc；SNES 沒有固定檔頭，只能靠副檔名＋大小＋內部標頭校驗 ─────
  function classifySfc(name, bytes) {
    var b = asU8(bytes || []), ext = String(name || '').split('.').pop().toLowerCase();
    if (ext !== 'sfc' && ext !== 'smc') return { cls: 'nonrom', kind: 'other', label: '非 SNES ROM（副檔名不是 .sfc／.smc）' };
    if (b.length < 0x8000) return { cls: 'nonrom', kind: 'sfc-small', label: 'SNES 檔案太小（' + b.length + ' 位元組），不是 ROM' };
    var h = parseSnesHeader(b);
    return { cls: 'rom', kind: 'sfc', label: 'SNES ROM' + (h.copier ? '（含 512 位元組 copier 檔頭）' : '') + (h.ok ? '（' + (h.hirom ? 'HiROM' : 'LoROM') + '）' : '（內部標頭校驗不吻合，仍視為 ROM）') };
  }

  // ───── 內部標頭（LoROM 在 0x7FC0、HiROM 在 0xFFC0）─────
  // 校驗：$1C–$1D 是補數、$1E–$1F 是校驗和，兩者 XOR 要等於 0xFFFF。
  function parseSnesHeader(bytes) {
    var raw = asU8(bytes), copier = raw.length % 1024 === COPIER, b = copier ? raw.subarray(COPIER) : raw;
    var best = null;
    [[LO_HDR, false], [HI_HDR, true]].forEach(function (c) {
      var o = c[0];
      if (b.length < o + 0x20) return;
      var comp = b[o + 0x1C] | (b[o + 0x1D] << 8), sum = b[o + 0x1E] | (b[o + 0x1F] << 8);
      var ok = ((comp ^ sum) & 0xFFFF) === 0xFFFF;
      var mapMode = b[o + 0x15];
      if (!best || (ok && !best.ok)) best = { ok: ok, hirom: c[1], offset: o, title: ascii(b, o, 21).replace(/\s+$/, ''), mapMode: mapMode, romType: b[o + 0x16], sizeCode: b[o + 0x17] };
    });
    if (!best) return { ok: false, copier: copier, reason: '檔案太短，找不到內部標頭' };
    best.copier = copier; best.size = b.length;
    if (!best.ok) best.reason = '內部標頭校驗和不吻合（LoROM 與 HiROM 兩個位置都不符）';
    return best;
  }

  // ───── .spc 組裝（標準格式，0x10200 位元組）─────
  // opts: { ram:Uint8Array(65536), dsp:Uint8Array(128), pc, a, x, y, psw, sp, title, game, dumper, comments, artist, lengthSec, fadeMs, extraRam:Uint8Array(64) }
  function packSpc(o) {
    o = o || {};
    var out = new Uint8Array(SPC_SIZE);
    put(out, 0, SPC_SIG, 33); out[0x21] = 0x1A; out[0x22] = 0x1A; out[0x23] = 0x1A; out[0x24] = 0x1E;
    out[0x25] = (o.pc || 0) & 0xFF; out[0x26] = ((o.pc || 0) >> 8) & 0xFF;
    out[0x27] = o.a || 0; out[0x28] = o.x || 0; out[0x29] = o.y || 0; out[0x2A] = o.psw || 0;
    out[0x2B] = (o.sp || 0) & 0xFF; out[0x2C] = ((o.sp || 0) >> 8) & 0xFF;
    put(out, 0x2E, o.title || '', 32); put(out, 0x4E, o.game || '', 32); put(out, 0x6E, o.dumper || '', 16);
    put(out, 0x7E, o.comments || '', 32);
    put(out, 0xB1, o.artist || '', 32);
    var len = Math.max(0, Math.min(999, Math.round(o.lengthSec || 0)));
    put(out, 0xA9, String(len), 3);
    put(out, 0xAC, String(Math.max(0, Math.min(99999, o.fadeMs || 0))), 5);
    out.set(asU8(o.ram || new Uint8Array(65536)).subarray(0, 65536), SPC_RAM);
    out.set(asU8(o.dsp || new Uint8Array(128)).subarray(0, 128), SPC_DSP);
    if (o.extraRam) out.set(asU8(o.extraRam).subarray(0, 64), SPC_EXTRA);
    return out;
  }
  function parseSpc(bytes) {
    var b = asU8(bytes);
    if (b.length < SPC_SIZE || ascii(b, 0, 33) !== SPC_SIG) return { ok: false, reason: '不是 .spc 檔（簽章不符或長度不足 0x10200）' };
    return {
      ok: true, pc: b[0x25] | (b[0x26] << 8), a: b[0x27], x: b[0x28], y: b[0x29], psw: b[0x2A], sp: b[0x2B] | (b[0x2C] << 8),
      title: getStr(b, 0x2E, 32), game: getStr(b, 0x4E, 32), dumper: getStr(b, 0x6E, 16), artist: getStr(b, 0xB1, 32),
      lengthSec: parseInt(ascii(b, 0xA9, 3), 10) || 0,
      ram: b.subarray(SPC_RAM, SPC_RAM + 65536), dsp: b.subarray(SPC_DSP, SPC_DSP + 128), extraRam: b.subarray(SPC_EXTRA, SPC_EXTRA + 64)
    };
  }

  // ───── DSP 事件 → MIDI（退路）─────
  function pitchOf(regs, v) { return ((regs[v * 0x10 + 3] & 0x3F) << 8) | regs[v * 0x10 + 2]; }
  function midiOfPitch(p) { var f = p * DSP_RATE / 4096; return Math.round(69 + 12 * Math.log(f / 440) / Math.LN2); }
  function dspEventsToSong(events, opts) {
    opts = opts || {};
    var ppq = opts.ppq || 480, ticksPerSec = ppq * 2;       // 120 BPM：每秒 2 拍
    var regs = new Uint8Array(128), cur = [], notes = [], i, stats = { dspWrites: 0, kon: 0, koff: 0, pitchChanges: 0, samples: 0 };
    for (i = 0; i < 8; i++) { cur.push(null); notes.push([]); }
    function endVoice(v, t) { var n = cur[v]; if (!n) return; n.end = t; notes[v].push(n); cur[v] = null; }
    function startVoice(v, t) {
      var p = pitchOf(regs, v);
      if (p < 8) return;                                  // 音高太低（靜音或未設定）不轉
      var vol = (Math.abs((regs[v * 0x10] << 24) >> 24) + Math.abs((regs[v * 0x10 + 1] << 24) >> 24)) / 2;
      cur[v] = { start: t, n: Math.max(0, Math.min(127, midiOfPitch(p))), vel: Math.max(1, Math.min(127, Math.round(vol / 2))) };
    }
    var lastT = 0;
    (events || []).forEach(function (e) {
      if (!e || typeof e.reg !== 'number') return;
      stats.dspWrites++; lastT = Math.max(lastT, e.t | 0);
      var r = e.reg & 0x7F, val = e.value & 0xFF, t = e.t | 0;
      regs[r] = val;
      if (r === REG_KON) { for (var v = 0; v < 8; v++) if (val & (1 << v)) { stats.kon++; endVoice(v, t); startVoice(v, t); } return; }
      if (r === REG_KOFF) { for (var w = 0; w < 8; w++) if (val & (1 << w)) { stats.koff++; endVoice(w, t); } return; }
      if ((r & 0x0F) === 2 || (r & 0x0F) === 3) {
        var pv = r >> 4;
        if (pv < 8 && cur[pv]) { stats.pitchChanges++; endVoice(pv, t); startVoice(pv, t); }
      }
    });
    for (i = 0; i < 8; i++) endVoice(i, lastT + 1);
    stats.samples = lastT;
    var song = { ppq: ppq, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: opts.title || '', tracks: [] };
    for (i = 0; i < 8; i++) {
      if (!notes[i].length) continue;
      song.tracks.push({ name: '聲道 ' + i, channel: i, program: 80, drum: false, volume: 100, pan: 64,
        notes: notes[i].map(function (x) {
          var t0 = Math.round(x.start / DSP_RATE * ticksPerSec), t1 = Math.round(x.end / DSP_RATE * ticksPerSec);
          return { t: t0, d: Math.max(1, t1 - t0), n: x.n, v: x.vel };
        }) });
    }
    stats.notes = song.tracks.reduce(function (n, tr) { return n + tr.notes.length; }, 0);
    stats.seconds = Math.round(stats.samples / DSP_RATE * 10) / 10;
    return { song: song, stats: stats };
  }

  // ───── 整體流程（stages 每段各自說明）─────
  // 目前：ROM 掃描與標頭已做；主 CPU 執行與傾印需要 SNES 核心（見 DESIGN.TODO.music-rom-extract.md）；
  // snes_spc 渲染需要 wasm 工具鏈（emscripten 或 clang）。沒有就明確回報，不假裝完成。
  // opts.runner(romBytes, opts) → { uploaded, uploadFrame, entry, snapshots:[{frame, ramCopy, dsp, spc:{pc,a,x,y,psw,sp}}], cancelled, reason }
  //   （宿主用 FaMusicLibSnesBus.runRom 接上）
  // opts.renderSpc(spcBytes, opts) → { samples:Float32Array, sampleRate, durationSec } 或丟錯；沒有就停在「SPC 渲染」階段並寫明原因
  function sfcExtract(romBytes, opts) {
    opts = opts || {};
    var out = { ok: false, header: null, stages: [], spcs: [], song: null, reason: null, cancelled: false };
    function fail(i, why) { out.stages.push({ stage: STAGES[i], ok: false, reason: why }); out.reason = STAGES[i] + '：' + why; return out; }
    var h = parseSnesHeader(asU8(romBytes));
    out.header = h;
    out.stages.push({ stage: STAGES[0], ok: true, note: h.copier ? '已去掉 512 位元組 copier 檔頭' : '' });
    if (typeof opts.runner !== 'function') return fail(1, '主 CPU 執行器沒有接上');
    var r;
    try { r = opts.runner(asU8(romBytes), opts); }
    catch (e) { return fail(1, '執行階段例外：' + String((e && e.message) || e)); }
    if (r && r.cancelled) { out.cancelled = true; return fail(1, '已取消'); }
    if (!r || !r.uploaded) return fail(1, (r && r.reason) || '聲音程式上傳沒有完成');
    out.stages.push({ stage: STAGES[1], ok: true, note: '聲音程式上傳完成於第 ' + r.uploadFrame + ' 個畫面，入口 $' + (r.entry || 0).toString(16).padStart(4, '0') });
    if (!r.snapshots || !r.snapshots.length) return fail(2, '上傳完成後沒有拍到快照');
    out.stages.push({ stage: STAGES[2], ok: true, note: '傾印 ' + r.snapshots.length + ' 個時間點' });
    r.snapshots.forEach(function (s) {
      var bytes = packSpc({ ram: s.ramCopy, dsp: s.dsp, pc: s.spc.pc, a: s.spc.a, x: s.spc.x, y: s.spc.y, psw: s.spc.psw, sp: s.spc.sp, title: opts.title || '', game: opts.game || '' });
      out.spcs.push({ frame: s.frame, bytes: bytes });
    });
    out.stages.push({ stage: STAGES[3], ok: true, note: out.spcs.length + ' 個 .spc' });
    if (typeof opts.renderSpc !== 'function') {
      return fail(4, 'SPC700＋S-DSP 渲染核心沒有接上（ml-spcdsp 的 musiclib_spc_core.js 尚未合併）；' +
        '目前的聲音埠只跑 IPL 上傳協定，不執行 SPC700，所以 .spc 裡的 DSP 與 SPC700 狀態是占位值，不能當成音樂');
    }
    // 每個時間點各自渲染成一首；單一時間點失敗不影響其他（逐筆記錄）
    out.rendered = [];
    var errs = [];
    out.spcs.forEach(function (sp, i) {
      try { out.rendered.push({ index: i, frame: sp.frame, bytes: sp.bytes, out: opts.renderSpc(sp.bytes, opts) }); }
      catch (e) { errs.push('第 ' + i + ' 個：' + String((e && e.message) || e)); }
    });
    if (!out.rendered.length) return fail(4, '渲染失敗：' + errs.join('；'));
    out.stages.push({ stage: STAGES[4], ok: true, note: out.rendered.length + ' 首渲染成功' + (errs.length ? '；' + errs.join('；') : '') });
    out.ok = true;
    return out;
  }

  return {
    classifySfc: classifySfc, parseSnesHeader: parseSnesHeader, packSpc: packSpc, parseSpc: parseSpc,
    dspEventsToSong: dspEventsToSong, sfcExtract: sfcExtract, STAGES: STAGES, SPC_SIZE: SPC_SIZE, DSP_RATE: DSP_RATE
  };
}));
