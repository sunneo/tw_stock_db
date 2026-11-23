/* RIX（軟體之星，AdLib OPL2 音樂）擷取器：純函式（UMD），不碰 DOM／網路。
 *   parseRix(bytes) → { ok:true, soundMode, instruments, song, stats } 或丟錯（訊息附階段）
 *   song 是標準 MIDI 曲子物件（與 FaMidi 同形：ppq／tempos／tracks，音符時間是 tick），之後的寫檔、渲染、曲庫登記都只看到普通 MIDI。
 * 格式依據（與 AdPlug 的 rix.cpp 一致，見 musiclib_extract_rix.test.js 的說明）：
 *   檔頭 20 位元組：0x00 u16 = 0x55AA；0x02 soundMode（0 旋律、1 打擊）；0x08 u16 insOffset（預設 0x14）；0x0C u16 patternOffset。
 *   樂器：insOffset + n*0x40，讀 28 個 u16（56 位元組）：前 13 個是調變器參數、接著 13 個是載波參數、最後兩個是波形（&3）。
 *   樂譜：u16 字，低位元組是資料、高位元組是控制；控制 0x80 結束；0x9x 選樂器、0xAx 音高彎曲、0xBx 音量、0xCx 音符（0 = 關音）；
 *     其餘字是延遲（值 = 高×256+低，單位 1/980 秒，由 70 Hz 計時遞減 14 推得）。
 *   音符：MIDI 音高 = 資料值（≥12；小於 12 的一律當 C0）。頻道 0..8 旋律；soundMode=1 時 6..8 當打擊（底鼓、小鼓、踩鑔）。
 *   音色：近似。依載波波形挑 GM 音色（正弦→長笛、方波→方波主音、其他→鋸齒主音）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibRix = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var SIG = 0x55AA, HDR_MIN = 0x0E, INS_SIZE = 0x40, INS_WORDS = 28;
  var PPQ = 480, TEMPO_BPM = 120;
  var TICKS_PER_BAND = (PPQ * 2) / 980;          // 1 拍 = 0.5 秒 = 480 tick；1 延遲單位 = 1/980 秒 = 0.98 tick（2 拍/秒）
  // 節奏通道對應的 GM 打擊音：6 底鼓 36、7 小鼓 38（OPL2 的 $BD 位元 0x08 是小鼓）、8 通通鼓 45、9 銅鈸 49、10 高帽 42
  var DRUM_NOTE = { 6: 36, 7: 38, 8: 45, 9: 49, 10: 42 };
  var PROGRAM_BY_WAVE = [73, 80, 81, 81];           // 載波波形 0 正弦→長笛 73；1 半正弦→方波主音 80；2/3 →鋸齒主音 81（近似）

  var OPL_MOD_OFF = [0, 1, 2, 8, 9, 10, 16, 17, 18];
  // MIDI 音高 → OPL2 的 block／F-number（頻率 = fnum × 49716 ÷ 2^(20−block)）；取能放進 10 位元 F-number 的最小 block（精度最高）
  function oplFreq(midi) {
    var hz = 440 * Math.pow(2, (midi - 69) / 12);
    for (var b = 0; b < 8; b++) {
      var fn = Math.round(hz * Math.pow(2, 20 - b) / 49716);
      if (fn <= 1023) return { block: b, fnum: Math.max(1, fn) };
    }
    return { block: 7, fnum: 1023 };
  }

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }

  // 讀一個樂器的 28 個字，回傳 { v:[…13 個調變器參數, …13 個載波參數], wave:[調變器, 載波] }
  function readInstrument(b, base) {
    var w = [];
    for (var i = 0; i < INS_WORDS; i++) w.push(u16(b, base + i * 2));
    var mod = w.slice(0, 13), car = w.slice(13, 26);
    return { mod: mod, car: car, wave: [w[26] & 3, w[27] & 3] };
  }

  // 主要解析：回傳標準 MIDI 曲子與統計；任何結構錯誤都丟出附階段的錯誤
  function parseRix(bytes) {
    var b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var len = b.length;
    if (len < HDR_MIN) throw new Error('解析失敗（檔頭）：檔案只有 ' + len + ' 位元組，短於 RIX 檔頭的 ' + HDR_MIN + ' 位元組');
    var sig = u16(b, 0);
    if (sig !== SIG) throw new Error('解析失敗（檔頭）：開頭不是 RIX 的 0x55AA，實際是 0x' + sig.toString(16));
    var soundMode = b[2];
    var insOffset = u16(b, 0x08), musBlock = u16(b, 0x0C);
    if (musBlock >= len) throw new Error('解析失敗（檔頭）：樂譜位置 ' + musBlock + ' 超出檔案長度 ' + len);

    // 樂器（只讀需要的：樂器表本身的範圍檢查由實際被選用時做）
    var insCache = {};
    function instrument(n) {
      if (insCache[n]) return insCache[n];
      var base = insOffset + n * INS_SIZE;
      if (base + INS_SIZE > len) throw new Error('解析失敗（樂器）：樂器 ' + n + ' 的位置 ' + base + ' 超出檔案');
      return (insCache[n] = readInstrument(b, base));
    }

    // 樂譜：依序解出各頻道的音符（時間以延遲單位累加）
    var t = 0, chIns = {}, active = {}, notes = {}, cmds = 0, delays = 0, bends = 0, vols = 0;
    function trackOf(ch) { return notes[ch] || (notes[ch] = []); }
    // OPL2 暫存器寫入序列（給晶片播放器用）。t 單位同延遲字（1/980 秒）；運算元位址 MOD_OFF[ch]，載波 +3。頻道 0..8 直接對應 OPL2 的 9 個頻道
    var regs = [], voice = {}, carTL = {};
    function reg(r, v) { regs.push({ t: t, r: r & 0xFF, v: v & 0xFF }); }
    // 樂器欄位（每個運算元 13 字，見 RIX_FIELD）打包成 OPL2 暫存器。欄位位置依 RIX 播放器的公開語意整理（見 docs/DESIGN.music-rix-opl.md）
    var F = { ksl: 0, mult: 1, fb: 2, ar: 3, sl: 4, egt: 5, dr: 6, rr: 7, tl: 8, am: 9, vib: 10, ksr: 11, cnt: 12 };
    var vol = {}, bendSemi = {};
    function opVolume(c) { return vol[c] == null ? 127 : vol[c]; }
    // 總音量（TL）：樂器的 TL 欄位依音量 0..127 縮放：TL = 63 − floor(((63 − tl) × vol × 2 + 127) ÷ 254)
    function totalLevel(tl, v) { return 63 - Math.floor(((63 - (tl & 0x3F)) * v * 2 + 127) / 254); }
    function writeOp(o, p, v) {
      reg(0x20 + o, ((p[F.am] ? 1 : 0) << 7) | ((p[F.vib] ? 1 : 0) << 6) | ((p[F.egt] ? 1 : 0) << 5) | ((p[F.ksr] ? 1 : 0) << 4) | (p[F.mult] & 0x0F));
      reg(0x40 + o, ((p[F.ksl] & 3) << 6) | totalLevel(p[F.tl], v));
      reg(0x60 + o, ((p[F.ar] & 0x0F) << 4) | (p[F.dr] & 0x0F));
      reg(0x80 + o, ((p[F.sl] & 0x0F) << 4) | (p[F.rr] & 0x0F));
    }
    function loadIns(c, n) {
      var ins = instrument(n), mo = OPL_MOD_OFF[c], co = mo + 3, m = ins.mod, k = ins.car;
      writeOp(mo, m, 127);                     // 調變器不受 B0 音量影響
      writeOp(co, k, opVolume(c));             // 載波依目前音量
      reg(0xE0 + mo, ins.wave[0]); reg(0xE0 + co, ins.wave[1]);
      reg(0xC0 + c, ((m[F.fb] & 7) << 1) | (m[F.cnt] ? 0 : 1));   // 回授；連接：mod 第 12 字為 0 時是加法（CNT=1）
      carTL[c] = k;
    }
    function setVolume(c, v) {                 // B0：音量 0..127，只影響載波的總音量
      vol[c] = v;
      if (carTL[c] == null) return;
      var k = carTL[c];
      reg(0x40 + OPL_MOD_OFF[c] + 3, ((k[F.ksl] & 3) << 6) | totalLevel(k[F.tl], v));
    }
    // 音高彎曲（A0）：中心 0x2000、範圍 ±1 半音（每半音 25 格，見設計文件）
    function bendOf(v) { return (v - 0x2000) / 0x2000; }
    function writePitch(c, midi, on) {
      var f = oplFreq(midi);
      voice[c] = f;
      reg(0xA0 + c, f.fnum & 0xFF);
      reg(0xB0 + c, (on ? 0x20 : 0) | (f.block << 2) | ((f.fnum >> 8) & 3));
    }
    function keyOn(c, midi) {
      if (voice[c] == null) { /* 新音 */ }
      reg(0xB0 + c, (voice[c] ? voice[c].block << 2 : 0));    // 先關掉（同一頻道重新觸發）
      writePitch(c, midi + (bendSemi[c] || 0), true);
    }
    function keyOff(c) {
      var f = voice[c]; if (!f) return;
      reg(0xB0 + c, (f.block << 2) | ((f.fnum >> 8) & 3));
      voice[c] = null;
    }
    // 節奏模式（檔頭 soundMode ≠ 0）：$BD 第 5 位是節奏開關，低 5 位是觸發位元。
    // 通道 6 的兩個運算元＝底鼓（BD）；通道 7 載波＝小鼓（SD）、通道 8 調變器＝通通鼓（TOM）、
    // 通道 9 的載波位址（21）＝銅鈸（CYM）、通道 10 的調變器位址（17）＝高帽（HH）。
    // 每個音符：先把該位元清掉，音符有效（資料 ≠ 0）再設回去 → 寫入 $BD 的上升緣即觸發一次。
    var rhythm = soundMode !== 0, bdMod = 0;
    var DRUM = { 6: { bit: 0x10, slot: 19 }, 7: { bit: 0x08, slot: 20 }, 8: { bit: 0x04, slot: 18 }, 9: { bit: 0x02, slot: 21 }, 10: { bit: 0x01, slot: 17 } };
    var drumP = {};                                  // 節奏運算元的參數（slot → { p 欄位, w 波形 }），音量變動時用
    function bdReg() { reg(0xBD, (rhythm ? 0x20 : 0) | bdMod); }
    function drumInstrument(ch, n) {                 // 通道 7..10 的樂器只寫調變器參數到固定運算元（與通道 6 不同）
      var ins = instrument(n), slot = DRUM[ch].slot;
      drumP[slot] = { p: ins.mod, w: ins.wave[0] };
      writeOp(slot, ins.mod, opVolume(ch));
      reg(0xE0 + slot, ins.wave[0]);
      if (ch === 8 || ch === 10) {                   // 回授由 mod 第 2 字給；通道 8 寫 C0+8，通道 10 寫 C0+7（與參考語意一致）
        var fbCh = ch === 8 ? 8 : 7;
        reg(0xC0 + fbCh, ((ins.mod[F.fb] & 7) << 1) | (ins.mod[F.cnt] ? 0 : 1));
      }
    }
    function drumVolume(ch, v) {
      vol[ch] = v;
      var slot = DRUM[ch].slot, d = drumP[slot]; if (!d) return;
      reg(0x40 + slot, ((d.p[F.ksl] & 3) << 6) | totalLevel(d.p[F.tl], v));
    }
    function drumPitch(ch, midi) {                   // 節奏通道的音高只寫頻率，不按鍵
      var f = oplFreq(midi);
      reg(0xA0 + ch, f.fnum & 0xFF);
      reg(0xB0 + ch, (f.block << 2) | ((f.fnum >> 8) & 3));
    }
    function drumHit(ch, data) {
      bdMod &= ~DRUM[ch].bit;                        // 先清掉並寫出（一次獨立的 $BD 寫入），音符有效再設回：造成上升緣
      bdReg();
      if (data !== 0) {
        var n = Math.max(12, data);                  // 與旋律音同樣的 C0 音高基準
        if (ch === 6) drumPitch(6, n);
        if (ch === 8) { drumPitch(8, n); drumPitch(7, n + 7); }   // 通道 7 的頻率由通道 8 的音符帶（與參考一致）
        bdMod |= DRUM[ch].bit;
      }
      bdReg();
    }
    function noteOff(ch, at) {
      var a = active[ch]; if (!a) return;
      if (ch <= 8) keyOff(ch);
      var d = at - a.t0; if (d > 0) trackOf(ch).push({ t: a.t0, d: d, n: a.n, v: a.v });
      active[ch] = null;
    }
    var pos = musBlock + 1;
    var guard = 0;
    if (rhythm) {                                   // 節奏模式初始化：通道 6..8 的頻率歸零、通道 7／8 的基準值（與參考一致）
      [0xA6, 0xA7, 0xA8, 0xB6, 0xB7, 0xB8].forEach(function (r) { reg(r, 0); });
      reg(0xA8, 0x87); reg(0xB8, 0x09); reg(0xA7, 0x03); reg(0xB7, 0x0F);
      bdReg();
    }
    while (pos < len && b[pos] !== 0x80) {
      var data = b[pos - 1], ctrl = b[pos];
      pos += 2;
      if (++guard > 2000000) throw new Error('解析失敗（樂譜）：字數超過 200 萬仍沒有結束字，疑似壞檔');
      var kind = ctrl & 0xF0, ch = ctrl & 0x0F;
      if (kind === 0x90) {                       // 選樂器
        if (ch <= 10) { chIns[ch] = data; instrument(data);
          if (rhythm && ch >= 7) drumInstrument(ch, data);
          else if (ch <= 8) loadIns(ch, data); }
        cmds++;
      } else if (kind === 0xA0) {                // 音高彎曲：資料 << 6，中心 0x2000
        var bend = Math.min(0x3FFF, data << 6);
        if (ch <= 10) { trackOf(ch).push({ bend: true, t: t, value: bend }); bends++; }
        if (ch <= 8) {
          bendSemi[ch] = bendOf(bend);
          if (voice[ch] && active[ch]) writePitch(ch, active[ch].n + bendSemi[ch], true);
        }
        cmds++;
      } else if (kind === 0xB0) {                // 音量（0..0x7F）
        if (ch <= 10) { trackOf(ch).push({ vol: true, t: t, value: Math.min(0x7F, data) }); vols++;
          if (rhythm && ch >= 7) drumVolume(ch, Math.min(0x7F, data));
          else if (ch <= 8) setVolume(ch, Math.min(0x7F, data)); }
        cmds++;
      } else if (kind === 0xC0) {                // 音符：先關掉此頻道的音，yy != 0 才開新音
        if (ch <= 10) {
          noteOff(ch, t);
          if (rhythm && DRUM[ch]) drumHit(ch, data);
          if (data !== 0) {
            var midi = data >= 12 ? data : 12;
            active[ch] = { t: t, t0: t, n: midi, v: 100 };
            if (ch <= 8 && !(rhythm && ch >= 6)) keyOn(ch, midi);
          }
        }
        cmds++;
      } else {                                   // 其餘（0x00..0x7F、0x81..0x8F、0xD0..0xFF）＝延遲字
        var delay = (ctrl << 8) + data;
        if (delay) { t += delay; delays++; }
      }
    }
    var stopped = pos < len && b[pos] === 0x80; // 找到結束字（0x80）才算完整；沒找到就是檔案被截斷
    // 結束：把還沒關的音在曲尾關掉
    Object.keys(active).forEach(function (k) { noteOff(+k, t); });
    if (rhythm) { bdMod = 0; bdReg(); }             // 曲尾：節奏位元全部清掉（與參考的曲尾收尾一致）

    // 組成 MIDI 曲子（tick）：每個頻道一軌；打擊模式的 6..8 併到一條打擊軌
    var song = { ppq: PPQ, tempos: [{ t: 0, bpm: TEMPO_BPM }], timesig: { n: 4, d: 4 }, title: '', tracks: [] };
    var drumNotes = [];
    var totalNotes = 0;
    Object.keys(notes).map(Number).sort(function (a, b) { return a - b; }).forEach(function (ch) {
      var evs = notes[ch];
      var nlist = [], bendList = [], volList = [];
      evs.forEach(function (e) {
        if (e.bend) bendList.push(e); else if (e.vol) volList.push(e); else nlist.push(e);
      });
      if (rhythm && DRUM_NOTE[ch] != null) {
        nlist.forEach(function (e) { drumNotes.push({ t: Math.round(e.t * TICKS_PER_BAND), d: Math.max(1, Math.round(PPQ / 8)), n: DRUM_NOTE[ch], v: 100 }); });
        totalNotes += nlist.length;
        return;
      }
      var ins = chIns[ch] != null ? instrument(chIns[ch]) : null;
      var wave = ins ? ins.wave[1] : 0;
      var track = {
        name: '頻道 ' + ch + (ins ? '（樂器 ' + chIns[ch] + '）' : ''),
        channel: ch, program: PROGRAM_BY_WAVE[wave], drum: false, volume: 100, pan: 64, notes: []
      };
      nlist.forEach(function (e) {
        var t0 = Math.round(e.t * TICKS_PER_BAND), d = Math.max(1, Math.round(e.d * TICKS_PER_BAND));
        track.notes.push({ t: t0, d: d, n: Math.max(0, Math.min(127, e.n)), v: e.v });
      });
      track.notes.sort(function (a, b) { return a.t - b.t || a.n - b.n; });
      totalNotes += track.notes.length;
      if (track.notes.length) song.tracks.push(track);
    });
    if (drumNotes.length) {
      drumNotes.sort(function (a, b) { return a.t - b.t || a.n - b.n; });
      song.tracks.push({ name: '打擊（近似）', channel: 9, program: 0, drum: true, volume: 100, pan: 64, notes: drumNotes });
      totalNotes += drumNotes.length;
    }
    if (!totalNotes) throw new Error('解析完成但沒有任何音符（可能是空的樂譜，或樂譜結構與預期不同）');
    var durSec = t / 980;
    return {
      ok: true, soundMode: soundMode, insOffset: insOffset, patternOffset: musBlock,
      song: song,
      regs: [{ t: 0, r: 0x01, v: 0x20 }].concat(regs), durationSec: durSec,
      stats: { stopped: stopped, commands: cmds, delays: delays, bends: bends, volumes: vols, notes: totalNotes, seconds: Math.round(durSec * 10) / 10, instrumentsUsed: Object.keys(chIns).length }
    };
  }

  return { parseRix: parseRix, SIG: SIG, PPQ: PPQ, TICKS_PER_BAND: TICKS_PER_BAND };
}));
