/* NES 遊戲音樂擷取（UMD，純邏輯＋執行器；不碰 DOM、不用網路）。
 *   classifyFile(name, bytes)      → { cls:'rom'|'nonrom', kind, label }   先看檔頭，副檔名只補存檔類
 *   parseInes(bytes)               → iNES 檔頭與 PRG／CHR
 *   packNsf(opts) / parseNsf(b)    → 標準 NSF（128 位元組頭）；opts.banks 是 8 個銀行初值（非 0 即啟用銀行切換）
 *   inferPlay(events, opts)        → { ok, play, init, playFrames, firstPlayFrame, reason, initReason }
 *   apuTraceToSong(events, opts)   → { song（FaMidi 同形）, stats }；退路：錄 APU 寫入→MIDI
 *   wav16(samples, rate)           → 16 位元單聲道 WAV
 *   traceRom(romBytes, NES, opts)  → Promise<trace>；用 jsnes 真的執行 ROM（NES 類別由呼叫端注入）
 *   extractNsf(romBytes, NES, opts)→ Promise<結果>；NSF（有入口才有）＋退路 MIDI＋wav（APU 音訊）各自說明成功或失敗原因
 *
 * 執行紀錄（traceRom 產生）：
 *   { k:'vblank', f, samples, active }   每跑完一個畫面（nes.frame 回傳）
 *   { k:'frame', handler }               畫面中斷（NMI）進入
 *   { k:'call', target }                 JSR；{ k:'ret' } RTS；{ k:'ret', rti:true } RTI（結束 NMI）
 *   { k:'apu', addr, value }             寫 $4000–$4017
 * 掛鉤：APU 寫入掛在 nes.papu.writeReg（mapper 動態呼叫它）；指令層包 cpu.emulate。
 * 輸入：每 150 畫面按一次 Start（與 A），讓遊戲離開標題畫面；時長自適應：活動過後安靜夠久就停（上限 MAX_FRAMES）。
 * NSF 的銀行：ROM 切成 4KB 頁，NSF 銀行初值取第一個播放畫面的 $8000–$FFFF 對應內容（與 ROM 逐頁比對，對不上的頁直接收進來）。
 * 限制（會寫進結果）：NSF 規格只在 $5FF8–$5FFF 切銀行，遊戲若在播放中自己寫 mapper 暫存器切銀行，NSF 播放器不一定跟得上。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibNes = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PRG_BANK = 16384, CHR_BANK = 8192, TRAINER = 512, PAGE = 4096;
  var CPU_NTSC = 1789773;          // NES CPU 時脈（NTSC），脈衝／三角波的頻率換算用
  var FRAME_NTSC = 60.0988;        // 每秒畫面數（NTSC）
  var AUDIO_RATE = 44100;          // wav 取樣率
  var MAX_FRAMES = 9000;           // 約 150 秒遊戲時間的上限
  var QUIET_MIN = 900;             // 活動過後至少安靜這麼多畫面才算停（另見 traceRom 的自適應規則）
  var NOISE_PERIOD = [4, 8, 16, 32, 64, 96, 128, 160, 202, 254, 380, 508, 762, 1016, 2034, 4068];
  // jsnes 的 src/mappers/index.js 有的 mapper 編號（核心不支援的，先回報，不執行）
  var CORE_MAPPERS = [0, 1, 2, 3, 4, 5, 7, 9, 11, 34, 38, 65, 66, 67, 71, 73, 79, 94, 118, 119, 140, 180, 240, 241];

  function ascii(b, o, n) { var s = ''; for (var i = 0; i < n; i++) s += String.fromCharCode(b[o + i] == null ? 0 : b[o + i]); return s; }
  function asU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x); }

  // ───── 分類：先看檔頭；只有存檔（沒有固定檔頭）才看副檔名 ─────
  function classifyFile(name, bytes) {
    var b = asU8(bytes || []), ext = String(name || '').split('.').pop().toLowerCase();
    if (b.length >= 4 && ascii(b, 0, 4) === 'NES\u001a') return { cls: 'rom', kind: 'ines', label: 'iNES ROM' };
    if (b.length >= 5 && ascii(b, 0, 5) === 'NESM\u001a') return { cls: 'nonrom', kind: 'nsf', label: 'NSF 音樂（已是音樂容器，不需擷取）' };
    if (b.length >= 4 && ascii(b, 0, 4) === 'FDS\u001a') return { cls: 'nonrom', kind: 'fds', label: 'FDS 磁碟映像（不是卡帶 ROM；核心不支援）' };
    if (b.length >= 15 && b[0] === 1 && ascii(b, 1, 14) === '*NINTENDO-HVC*') return { cls: 'nonrom', kind: 'fds', label: 'FDS 磁碟映像（不是卡帶 ROM；核心不支援）' };
    if (b.length >= 4 && ascii(b, 0, 4) === 'UNIF') return { cls: 'nonrom', kind: 'unif', label: 'UNIF 格式（核心不支援）' };
    if (b.length >= 4 && ascii(b, 0, 4) === 'PK\u0003\u0004') return { cls: 'nonrom', kind: 'zip', label: '非 ROM：zip 壓縮檔' };
    if (b.length >= 6 && b[0] === 0x37 && b[1] === 0x7A && b[2] === 0xBC && b[3] === 0xAF) return { cls: 'nonrom', kind: '7z', label: '非 ROM：7z 壓縮檔' };
    if (b.length >= 4 && ascii(b, 0, 4) === 'Rar!') return { cls: 'nonrom', kind: 'rar', label: '非 ROM：rar 壓縮檔' };
    if (/^(sta|st\d|sav|srm)$/.test(ext)) return { cls: 'nonrom', kind: 'save', label: '非 ROM：存檔（即時存檔／電池存檔）' };
    return { cls: 'nonrom', kind: 'other', label: '非 ROM：不是 iNES 檔頭' };
  }

  // ───── iNES 檔頭 ─────
  function parseInes(bytes) {
    var b = asU8(bytes);
    if (b.length < 16) return { ok: false, reason: '檔案只有 ' + b.length + ' 位元組，短於 iNES 檔頭 16' };
    if (b[0] !== 0x4E || b[1] !== 0x45 || b[2] !== 0x53 || b[3] !== 0x1A) return { ok: false, reason: '不是 iNES 檔（開頭不是 NES 加 0x1A）' };
    var prgBanks = b[4], chrBanks = b[5], f6 = b[6], f7 = b[7];
    // NES 2.0（頭部位元組 7 的位元 2–3 = 10）：mapper 多四位元（位元組 8）、PRG／CHR 大小的高位元（位元組 9）；這裡只取 NROM 到 MMC 系列會用到的欄位
    var nes2 = (f7 & 0x0C) === 0x08;
    if (nes2) { if ((b[9] & 0x0F) === 0x0F) return { ok: false, reason: 'NES 2.0 指數式 ROM 大小未處理' }; prgBanks = b[4] | ((b[9] & 0x0F) << 8); chrBanks = b[5] | ((b[9] & 0xF0) << 4); }
    var trainer = !!(f6 & 4), mapper = (f6 >> 4) | (f7 & 0xF0) | (nes2 ? ((b[8] & 0x0F) << 8) : 0);
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
    var b = asU8(bytes);
    if (b.length < 0x80 || ascii(b, 0, 5) !== 'NESM\u001a') return { ok: false, reason: '不是 NSF 檔（開頭不是 NESM 0x1A）' };
    function s32(o) { var a = []; for (var i = 0; i < 32; i++) { if (!b[o + i]) break; a.push(b[o + i]); } return String.fromCharCode.apply(null, a); }
    function u16(o) { return b[o] | (b[o + 1] << 8); }
    return {
      ok: true, version: b[5], songs: b[6], start: b[7], load: u16(8), init: u16(10), play: u16(12),
      name: s32(0x0E), artist: s32(0x2E), copyright: s32(0x4E), ntscSpeed: u16(0x6E),
      banks: Array.from(b.subarray(0x70, 0x78)), palSpeed: u16(0x78), pal: !!(b[0x7A] & 1),
      data: b.subarray(0x80)
    };
  }

  // ───── 推導 PLAY／INIT（事件流 → 入口）─────
  // 每個畫面（兩次 vblank 之間）裡，寫聲音暫存器時堆疊上、而且是這個畫面才開始的副程式都算一次。
  // PLAY ＝ 次數夠多的副程式裡，離畫面起點最近（最外層）的那個；畫面中斷處理器本身不算（NSF 要的是 RTS 結尾的副程式）。
  // INIT ＝ 第一個畫面之前、已經返回、而且之內有寫聲音的最外層呼叫。
  function inferPlay(events, opts) {
    opts = opts || {};
    var minFrames = opts.minFrames || 3;
    if (!events || !events.length) return { ok: false, reason: '沒有執行紀錄（事件為空）' };
    var useV = events.some(function (e) { return e.k === 'vblank'; });
    var frameIdx = 0, frames = 0, base = 0, stack = [];
    var tally = {}, initCand = {}, inlineFrames = 0, lastInline = -1, topApu = {};
    events.forEach(function (e) {
      if (e.k === 'vblank') { frameIdx = e.f + 1; frames++; base = stack.length; return; }
      if (e.k === 'frame') {
        if (!useV) { frameIdx++; frames++; base = stack.length; }
        stack.push({ target: e.handler, kind: 'nmi', pushedFrame: frameIdx, depth: stack.length, writes: 0 });
        return;
      }
      if (e.k === 'call') {
        if (stack.length > 512) stack.length = 0;          // 堆疊失衡（例如用 JMP 跳出）：重新開始，不無限長
        stack.push({ target: e.target, kind: 'call', pushedFrame: frameIdx, depth: stack.length, writes: 0 });
        return;
      }
      if (e.k === 'ret') {
        var top = stack.pop();
        if (top && top.kind === 'call' && top.writes > 0) {
          var c = initCand[top.target];
          if (!c) initCand[top.target] = { depth: top.depth, writes: top.writes, firstFrame: top.pushedFrame };
          else { if (top.depth < c.depth) c.depth = top.depth; if (top.writes > c.writes) c.writes = top.writes; if (top.pushedFrame < c.firstFrame) c.firstFrame = top.pushedFrame; }
        }
        return;
      }
      if (e.k === 'apu') {
        if (stack.length === 0) { var hist = topApu[e.addr] || (topApu[e.addr] = []); hist.push({ f: frameIdx, v: e.value }); if (hist.length > 64) hist.shift(); }
        var counted = {}, sawCall = false, i;
        for (i = 0; i < stack.length; i++) stack[i].writes++;
        for (i = stack.length - 1; i >= 0; i--) {
          var en = stack[i];
          if (en.pushedFrame !== frameIdx || en.kind === 'nmi') continue;
          sawCall = true;
          if (counted[en.target]) continue;
          counted[en.target] = true;
          var rel = i - base;
          var t = tally[en.target];
          if (!t) t = tally[en.target] = { frames: 0, lastFrame: -1, rel: rel, firstFrame: frameIdx, list: [] };
          if (t.lastFrame !== frameIdx) { t.frames++; t.lastFrame = frameIdx; t.list.push(frameIdx); }
          if (rel < t.rel) t.rel = rel;
        }
        if (!sawCall && lastInline !== frameIdx && stack.some(function (x) { return x.kind === 'nmi' && x.pushedFrame === frameIdx; })) { inlineFrames++; lastInline = frameIdx; }
      }
    });
    if (!frames) return { ok: false, frames: 0, reason: '執行紀錄裡沒有畫面中斷，也沒有畫面結束紀錄，無法判斷每畫面的聲音副程式' };
    var keys = Object.keys(tally), bestN = 0;
    keys.forEach(function (k) { if (tally[k].frames > bestN) bestN = tally[k].frames; });
    var cands = keys.filter(function (k) { return tally[k].frames >= minFrames; });
    if (!cands.length) {
      if (inlineFrames >= minFrames) return { ok: false, frames: frames, playFrames: inlineFrames, reason: '播放入口在畫面中斷處理器本身（沒有獨立的副程式；NSF 需要改寫結尾，未實作）' };
      return { ok: false, frames: frames, playFrames: bestN, reason: '無法抽出播放入口：沒有一個副程式在至少 ' + minFrames + ' 個畫面裡寫聲音（最多 ' + bestN + ' 個畫面，共 ' + frames + ' 個畫面）' };
    }
    var maxF = 0; cands.forEach(function (k) { if (tally[k].frames > maxF) maxF = tally[k].frames; });
    var pool = cands.filter(function (k) { return tally[k].frames >= maxF * 0.5; });
    pool.sort(function (a, b) { return (tally[a].rel - tally[b].rel) || (tally[b].frames - tally[a].frames) || (+a - +b); });
    var play = +pool[0], pt = tally[pool[0]];
    // INIT：第一次播放之前（含當時）已經返回、而且寫過聲音的最外層呼叫；每畫面都在呼叫的是 PLAY，不算
    var init = null, best = null;
    Object.keys(initCand).forEach(function (k) {
      var c = initCand[k];
      if (tally[k] && tally[k].frames >= minFrames) return;
      if (c.firstFrame > pt.firstFrame) return;
      if (!best || c.depth < best.depth || (c.depth === best.depth && (c.writes > best.writes || (c.writes === best.writes && c.firstFrame < best.firstFrame)))) { best = c; init = +k; }
    });
    // 頂層寫入：第一次播放之前，每個位址最後寫的值（給 INIT 存根重放用）
    var topWrites = [];
    Object.keys(topApu).map(Number).sort(function (a, b) { return a - b; }).forEach(function (addr) {
      var hs = topApu[addr], pick = null;
      hs.forEach(function (h) { if (h.f <= pt.firstFrame) pick = h; });
      if (pick) topWrites.push({ addr: addr, value: pick.v });
    });
    topWrites.sort(function (a, b) { return (a.addr === 0x4015 ? -1 : 0) - (b.addr === 0x4015 ? -1 : 0) || a.addr - b.addr; });
    return {
      ok: true, play: play, playFrames: pt.frames, frames: frames, firstPlayFrame: pt.firstFrame, playFrameList: pt.list, topWrites: topWrites,
      init: init, initReason: init == null ? 'INIT 無法確定：第一次播放之前沒有已返回、寫過聲音的最外層呼叫' : null
    };
  }

  // ───── 退路：APU 暫存器寫入序列 → MIDI ─────
  // 脈衝 1（$4000–$4003）、脈衝 2（$4004–$4007）、三角波（$4008–$400B）、雜訊（$400C–$400F）。
  // 音符在暫存器寫入時開始、在 $4015 關掉該聲道或被新音取代時結束。DPCM（$4010–$4013）不轉，只計數。
  function apuTraceToSong(events, opts) {
    opts = opts || {};
    var ticksPerSec = (opts.ppq || 480) * 2;           // 120 BPM：每秒 2 拍
    var useV = events.some(function (e) { return e.k === 'vblank'; });
    var frame = 0, reg = {}, enable = 0, cur = { p1: null, p2: null, tri: null, noise: null }, notes = { p1: [], p2: [], tri: [], noise: [] }, stats = { apuWrites: 0, dpcmWrites: 0, frames: 0 };
    function sec(f) { return f / FRAME_NTSC; }
    function endNote(ch) { var n = cur[ch]; if (!n) return; n.end = frame; notes[ch].push(n); cur[ch] = null; }
    function startNote(ch, midi) { endNote(ch); cur[ch] = { start: frame, n: midi }; }
    function pulseMidi(period) { var f = CPU_NTSC / (16 * (period + 1)); return Math.round(69 + 12 * Math.log(f / 440) / Math.LN2); }
    events.forEach(function (e) {
      if (e.k === 'vblank' || (!useV && e.k === 'frame')) { frame++; stats.frames++; return; }
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
      if (a === 0x4003 && (enable & 1)) { var p1 = ((v & 7) << 8) | (reg[0x4002] || 0); if (p1 >= 8) startNote('p1', pulseMidi(p1)); else endNote('p1'); }
      if (a === 0x4007 && (enable & 2)) { var p2 = ((v & 7) << 8) | (reg[0x4006] || 0); if (p2 >= 8) startNote('p2', pulseMidi(p2)); else endNote('p2'); }
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
    [['p1', '脈衝 1', 0, 80], ['p2', '脈衝 2', 1, 80], ['tri', '三角波', 2, 79]].forEach(function (c) {
      if (notes[c[0]].length) song.tracks.push(toTrack(notes[c[0]], c[2], c[1], c[3], false));
    });
    var drumList = notes.noise.map(function (x) { return { start: x.start, end: x.end, n: x.n }; });
    if (drumList.length) song.tracks.push(toTrack(drumList, 9, '雜訊（打擊，近似）', 0, true));
    stats.notes = notes.p1.length + notes.p2.length + notes.tri.length + notes.noise.length;
    stats.seconds = Math.round(sec(frame) * 10) / 10;
    return { song: song, stats: stats };
  }

  // ───── wav（16 位元單聲道 PCM）─────
  function wav16(samples, rate) {
    var n = samples.length, buf = new Uint8Array(44 + n * 2), dv = new DataView(buf.buffer);
    function put(o, s) { for (var i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); }
    put(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); put(8, 'WAVE'); put(12, 'fmt ');
    dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
    dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); put(36, 'data'); dv.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      dv.setInt16(44 + i * 2, s < 0 ? Math.round(s * 32768) : Math.round(s * 32767), true);
    }
    return buf;
  }

  // ───── 執行 ROM（jsnes）─────
  function romToBinaryString(b) { var s = ''; for (var i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, Math.min(b.length, i + 0x8000))); return s; }
  function yieldNow() { return new Promise(function (r) { setTimeout(r, 0); }); }
  function fnvPage(mem, off) {
    var h = 0x811C9DC5;
    for (var i = 0; i < PAGE; i++) { h = (h ^ mem[off + i]) >>> 0; h = Math.imul(h, 0x01000193) >>> 0; }
    return h;
  }
  // 按鍵排程：每 150 畫面 Start（20–25、100–103）與 A（60–65），讓遊戲離開標題畫面
  function padAt(f) { var m = f % 150; return { 3: (m >= 20 && m < 26) || (m >= 100 && m < 104), 0: (m >= 60 && m < 66) }; }

  async function traceRom(romBytes, NES, opts) {
    opts = opts || {};
    var maxFrames = opts.maxFrames || MAX_FRAMES, yieldEvery = opts.yieldEvery || 30;
    var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
    var events = [], slotHashes = [], pages = new Map();
    var audio = new Float32Array(Math.ceil(maxFrames * AUDIO_RATE / FRAME_NTSC) + 4096), audioN = 0;
    var nes = new NES({
      onFrame: function () {}, emulateSound: true, sampleRate: AUDIO_RATE,
      onAudioSample: function (l, r) { if (audioN < audio.length) audio[audioN++] = (l + r) * 0.5; }
    });
    nes.loadROM(romToBinaryString(asU8(romBytes)));
    var cpu = nes.cpu, mem = cpu.mem, papu = nes.papu;
    var nmiVec = mem[0xFFFA] | (mem[0xFFFB] << 8);
    var apuThisFrame = 0;
    var origWrite = papu.writeReg;
    papu.writeReg = function (addr, value) {
      events.push({ k: 'apu', addr: addr & 0xFFFF, value: value & 0xFF }); apuThisFrame++;
      return origWrite.call(this, addr, value);
    };
    var origEmu = cpu.emulate, inNmi = false;
    cpu.emulate = function () {
      var pc = this.REG_PC, op = this.mem[pc];
      if (pc === nmiVec && !inNmi) { events.push({ k: 'frame', handler: nmiVec }); inNmi = true; }
      if (op === 0x20) events.push({ k: 'call', target: this.mem[(pc + 1) & 0xFFFF] | (this.mem[(pc + 2) & 0xFFFF] << 8) });
      else if (op === 0x60) events.push({ k: 'ret' });
      else if (op === 0x40 && inNmi) { events.push({ k: 'ret', rti: true }); inNmi = false; }
      return origEmu.call(this);
    };
    function slotsNow() {
      var v = new Uint32Array(8);
      for (var s = 0; s < 8; s++) {
        var off = 0x8000 + s * PAGE, h = fnvPage(mem, off);
        v[s] = h;
        if (!pages.has(h) && pages.size < 256) pages.set(h, mem.slice(off, off + PAGE));
      }
      return v;
    }
    var held = { 0: false, 3: false }, quit = 'maxFrames', crashed = null, lastApu = -1, activeFrames = 0, ran = 0, f;
    for (f = 0; f < maxFrames; f++) {
      if (isCancelled()) { quit = 'cancelled'; break; }
      var want = padAt(f);
      [0, 3].forEach(function (b) {
        if (want[b] !== held[b]) { held[b] = want[b]; if (want[b]) nes.buttonDown(1, b); else nes.buttonUp(1, b); }
      });
      try { nes.frame(); } catch (e) { crashed = String((e && e.message) || e); quit = 'crashed'; break; }
      ran++;
      if (typeof opts.onProgress === "function" && f % 900 === 0) opts.onProgress(f);
      var active = apuThisFrame > 0;
      if (active) { activeFrames++; lastApu = f; }
      events.push({ k: 'vblank', f: f, samples: audioN, active: active });
      apuThisFrame = 0;
      slotHashes.push(slotsNow());
      // 自適應停止：有過活動、而且之後安靜的時間夠長（至少 QUIET_MIN，且不短於活動畫面數的一半）就停
      if (activeFrames >= QUIET_MIN && f - lastApu >= Math.max(QUIET_MIN, activeFrames / 2)) { quit = 'quiet'; break; }
      if (f % yieldEvery === yieldEvery - 1) await yieldNow();
    }
    return {
      events: events, slotHashes: slotHashes, pages: pages, audio: audio.subarray(0, audioN), sampleRate: AUDIO_RATE,
      frames: ran, activeFrames: activeFrames, quit: quit, crashed: crashed, nmiVector: nmiVec,
      apuWrites: events.reduce(function (n, e) { return n + (e.k === 'apu' ? 1 : 0); }, 0)
    };
  }

  // 只留「第一次寫聲音」所在的畫面起（退路 MIDI 從有聲音開始算，不含開機靜音）
  function trimToSound(events) {
    var first = -1;
    for (var i = 0; i < events.length; i++) if (events[i].k === 'apu') { first = i; break; }
    if (first < 0) return [];
    var start = 0;
    for (var j = first; j >= 0; j--) if (events[j].k === 'vblank') { start = j + 1; break; }
    return events.slice(start);
  }

  // 把 ROM 的 PRG 切成 4KB 頁，對照第一個播放畫面的 $8000–$FFFF 內容，得到銀行初值（8 個頁號）與要收進來的額外頁
  function bankLayout(rom, trace, frameIdx) {
    var prg = rom.prg, n = prg.length / PAGE, pagesArr = [], hashes = [];
    for (var i = 0; i < n; i++) { var p = prg.subarray(i * PAGE, (i + 1) * PAGE); pagesArr.push(p); hashes.push(fnvPage(p, 0)); }
    var row = trace.slotHashes[frameIdx] || trace.slotHashes[0];
    var bankInit = [], extra = [];
    for (var s = 0; s < 8; s++) {
      var h = row[s], idx = hashes.indexOf(h);
      if (idx < 0) {
        var known = trace.pages.get(h);
        if (!known) return { ok: false, reason: '銀行 ' + s + ' 的內容既不在 ROM 也沒有擷取到（可能是遊戲自己在 RAM 裡產生的程式）' };
        var k2 = extra.findIndex(function (x) { return x.h === h; });
        if (k2 < 0) { extra.push({ h: h, bytes: known }); k2 = extra.length - 1; }
        idx = n + k2;
      }
      bankInit.push(idx);
    }
    var all = pagesArr.concat(extra.map(function (x) { return x.bytes; }));
    return { ok: true, bankInit: bankInit, pages: all, extraPages: extra.length };
  }

  // INIT 存根：依序 LDA #value ／ STA addr，最後 RTS
  function initStubBytes(writes) {
    var b = [];
    writes.forEach(function (w) { b.push(0xA9, w.value & 0xFF, 0x8D, w.addr & 0xFF, (w.addr >> 8) & 0xFF); });
    b.push(0x60);
    return b;
  }
  // 在 buf 前 limit 個位元組中找一段連續 len 個的填充（全 0xFF 或全 0x00）；找不到回傳 -1
  function findPadding(buf, len, limit) {
    var run = 0, val = -1;
    for (var i = 0; i < limit; i++) {
      var v = buf[i];
      if ((v === 0xFF || v === 0x00) && (run === 0 || v === val)) { val = v; run++; }
      else { run = (v === 0xFF || v === 0x00) ? 1 : 0; val = v; }
      if (run >= len) return i - len + 1;
    }
    return -1;
  }

  // 抽出：回傳一個結果物件，各輸出各自說明成功或失敗（不會只回一個總結）。
  //   out.nsf（Uint8Array|null）、out.nsfStage／out.nsfReason、out.song（MIDI 樂譜|null）、out.midiReason、
  //   out.wav（Uint8Array|null）、out.samples（Float32Array|null，給 mp3 編碼用）、out.stats、out.mode
  async function extractNsf(romBytes, NES, opts) {
    opts = opts || {};
    var out = { ok: false, mode: 'none', cls: null, mapper: null, nsf: null, nsfStage: null, nsfReason: null, nsfNote: null,
      play: null, init: null, bankInit: null, song: null, midiReason: null, wav: null, samples: null, sampleRate: AUDIO_RATE,
      stage: null, reason: null, cancelled: false, stats: {} };
    var rom = parseInes(romBytes);
    if (!rom.ok) { out.stage = '檔頭'; out.reason = rom.reason; out.cls = classifyFile(opts.name || '', romBytes).label; return out; }
    out.mapper = rom.mapper;
    if (!NES.mappers || !NES.mappers[rom.mapper]) { out.stage = '執行'; out.reason = '核心不支援 mapper ' + rom.mapper + '（jsnes 與擴充檔都沒有）'; return out; }
    var tr;
    try { tr = await traceRom(romBytes, NES, { maxFrames: opts.maxFrames, isCancelled: opts.isCancelled, yieldEvery: opts.yieldEvery, onProgress: opts.onProgress }); }
    catch (e) { out.stage = '執行'; out.reason = 'ROM 執行失敗：' + String((e && e.message) || e); return out; }
    out.stats = { frames: tr.frames, activeFrames: tr.activeFrames, quit: tr.quit, crashed: tr.crashed, apuWrites: tr.apuWrites };
    if (tr.quit === 'cancelled') { out.stage = '已取消'; out.reason = '已取消'; out.cancelled = true; return out; }
    if (tr.quit === 'crashed') out.nsfNote = '遊戲在第 ' + tr.frames + ' 個畫面當掉：' + tr.crashed;

    // 退路 MIDI（不論 NSF 成不成功都先算）
    var mid = apuTraceToSong(trimToSound(tr.events), { title: opts.name || '' });
    if (mid.stats.notes > 0) { out.song = mid.song; out.stats.notes = mid.stats.notes; out.stats.seconds = mid.stats.seconds; }
    else out.midiReason = tr.apuWrites ? '有聲音暫存器寫入，但沒有可轉成音符的聲音（脈衝週期太小、只有 DPCM 等）' : '執行期間完全沒有聲音暫存器寫入';

    // wav：從第一次有聲音的畫面起的 APU 輸出（與 ROM 同一個 APU 模擬器）
    var firstActive = null;
    for (var i = 0; i < tr.events.length; i++) { var e = tr.events[i]; if (e.k === 'vblank' && e.active) { firstActive = e; break; } }
    if (firstActive && tr.audio.length) {
      var prevSamples = 0;
      for (var j = 0; j < tr.events.length; j++) { var e2 = tr.events[j]; if (e2.k === 'vblank' && e2.f === firstActive.f - 1) { prevSamples = e2.samples; break; } }
      out.samples = tr.audio.subarray(prevSamples);
      out.wav = wav16(out.samples, AUDIO_RATE);
      out.stats.durationSec = Math.round(out.samples.length / AUDIO_RATE * 10) / 10;
    }

    // NSF（需要 PLAY 與 INIT 兩個入口，且位址在 $8000 以上）
    var inf = inferPlay(tr.events, {});
    if (!inf.ok) { out.nsfStage = '入口'; out.nsfReason = inf.reason; }
    else if (inf.init == null && !(inf.topWrites && inf.topWrites.length)) { out.play = inf.play; out.nsfStage = '入口'; out.nsfReason = inf.initReason; }
    else if (inf.play < 0x8000 || (inf.init != null && inf.init < 0x8000)) { out.play = inf.play; out.init = inf.init; out.nsfStage = '打包'; out.nsfReason = '入口在 RAM 裡（PLAY $' + inf.play.toString(16) + '、INIT $' + inf.init.toString(16) + '），NSF 放不下'; }
    else {
      out.play = inf.play;
      var initAddr = inf.init, stub = null, fail = null, pack = null, layout = null, dataBytes = null, loadAddr = 0x8000;
      if (inf.init == null) { stub = initStubBytes(inf.topWrites); out.initMode = 'APU 重放存根'; }
      if (rom.mapper === 0) {
        dataBytes = new Uint8Array(rom.prg);
        loadAddr = rom.prgBanks === 1 ? 0xC000 : 0x8000;
        if (stub) {
          var off0 = findPadding(dataBytes, stub.length, dataBytes.length - 6);
          if (off0 < 0) fail = 'INIT 無法確定，且 PRG 裡找不到 ' + stub.length + ' 位元組的填充空間放 APU 重放存根';
          else { dataBytes.set(stub, off0); initAddr = loadAddr + off0; }
        }
      } else {
        layout = bankLayout(rom, tr, inf.firstPlayFrame);
        if (!layout.ok) fail = layout.reason;
        else {
          if (stub) {
            var placed = false;
            for (var s2 = 0; s2 < 8 && !placed; s2++) {
              var k2 = layout.bankInit[s2], pg = layout.pages[k2];
              var o2 = findPadding(pg, stub.length, pg.length - (s2 === 7 ? 6 : 0));
              if (o2 >= 0) { var cp = new Uint8Array(pg); cp.set(stub, o2); layout.pages[k2] = cp; initAddr = 0x8000 + s2 * PAGE + o2; placed = true; }
            }
            if (!placed) fail = 'INIT 無法確定，且銀行裡找不到 ' + stub.length + ' 位元組的填充空間放 APU 重放存根';
          }
          if (!fail) {
            dataBytes = new Uint8Array(layout.pages.length * PAGE);
            layout.pages.forEach(function (p, k) { dataBytes.set(p, k * PAGE); });
            out.bankInit = layout.bankInit;
          }
        }
      }
      if (fail) { out.nsfStage = '入口'; out.nsfReason = fail; out.init = null; }
      else {
        out.init = initAddr;
        if (rom.mapper === 0) {
          pack = packNsf({ prg: dataBytes, load: loadAddr, init: initAddr, play: inf.play, songs: 1, start: 1, name: opts.name || '' });
        } else {
          pack = packNsf({ prg: dataBytes, load: 0x8000, init: initAddr, play: inf.play, songs: 1, start: 1, name: opts.name || '', banks: layout.bankInit });
          // 播放中銀行有沒有變：有變就要說明（NSF 的切換只有 $5FF8，這類遊戲的音樂可能不完整）
          var rowsDiffer = 0, ref = tr.slotHashes[inf.firstPlayFrame] || [];
          (inf.playFrameList || []).forEach(function (fi) {
            var row = tr.slotHashes[fi]; if (!row) return;
            for (var s = 0; s < 8; s++) if (row[s] !== ref[s]) { rowsDiffer++; break; }
          });
          if (rowsDiffer) out.nsfNote = '播放中銀行切換了 ' + rowsDiffer + ' 個畫面；NSF 只能用 $5FF8 切換，這類遊戲的音樂可能不完整';
        }
        if (stub) out.nsfNote = (out.nsfNote ? out.nsfNote + '；' : '') + 'INIT 找不到返回的音效初始化呼叫，改用 APU 重放存根（只重放第一次播放前頂層寫入的聲音暫存器，不還原遊戲 RAM）';
      }
      if (pack) out.nsf = pack;
    }
    out.ok = !!out.nsf;
    out.mode = out.nsf && out.song ? 'nsf+midi' : out.nsf ? 'nsf' : out.song ? 'midi' : 'none';
    if (!out.nsf && !out.song) { out.stage = out.nsfStage || '入口'; out.reason = out.nsfReason || out.midiReason; }
    return out;
  }

  return {
    classifyFile: classifyFile, parseInes: parseInes, packNsf: packNsf, parseNsf: parseNsf, inferPlay: inferPlay,
    apuTraceToSong: apuTraceToSong, wav16: wav16, traceRom: traceRom, extractNsf: extractNsf, bankLayout: bankLayout,
    trimToSound: trimToSound, fnvPage: fnvPage, padAt: padAt,
    CORE_MAPPERS: CORE_MAPPERS, NOISE_PERIOD: NOISE_PERIOD, CPU_NTSC: CPU_NTSC, FRAME_NTSC: FRAME_NTSC, AUDIO_RATE: AUDIO_RATE, MAX_FRAMES: MAX_FRAMES
  };
}));
