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
  var DRUM_NOTE = { 6: 36, 7: 42, 8: 38 };         // 打擊：6 底鼓 36、7 踩鑔 42、8 小鼓 38（GM）
  var PROGRAM_BY_WAVE = [73, 80, 81, 81];           // 載波波形 0 正弦→長笛 73；1 半正弦→方波主音 80；2/3 →鋸齒主音 81（近似）

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
    function noteOff(ch, at) {
      var a = active[ch]; if (!a) return;
      var d = at - a.t0; if (d > 0) trackOf(ch).push({ t: a.t0, d: d, n: a.n, v: a.v });
      active[ch] = null;
    }
    var pos = musBlock + 1;
    var guard = 0;
    while (pos < len && b[pos] !== 0x80) {
      var data = b[pos - 1], ctrl = b[pos];
      pos += 2;
      if (++guard > 2000000) throw new Error('解析失敗（樂譜）：字數超過 200 萬仍沒有結束字，疑似壞檔');
      var kind = ctrl & 0xF0, ch = ctrl & 0x0F;
      if (kind === 0x90) {                       // 選樂器
        if (ch <= 10) { chIns[ch] = data; instrument(data); }
        cmds++;
      } else if (kind === 0xA0) {                // 音高彎曲：資料 << 6，中心 0x2000
        var bend = Math.min(0x3FFF, data << 6);
        if (ch <= 10) { trackOf(ch).push({ bend: true, t: t, value: bend }); bends++; }
        cmds++;
      } else if (kind === 0xB0) {                // 音量（0..0x7F）
        if (ch <= 10) { trackOf(ch).push({ vol: true, t: t, value: Math.min(0x7F, data) }); vols++; }
        cmds++;
      } else if (kind === 0xC0) {                // 音符：先關掉此頻道的音，yy != 0 才開新音
        if (ch <= 10) {
          noteOff(ch, t);
          if (data !== 0) {
            var midi = data >= 12 ? data : 12;
            active[ch] = { t0: t, n: midi, v: 100 };
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
      if (soundMode === 1 && DRUM_NOTE[ch] != null) {
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
      stats: { stopped: stopped, commands: cmds, delays: delays, bends: bends, volumes: vols, notes: totalNotes, seconds: Math.round(durSec * 10) / 10, instrumentsUsed: Object.keys(chIns).length }
    };
  }

  return { parseRix: parseRix, SIG: SIG, PPQ: PPQ, TICKS_PER_BAND: TICKS_PER_BAND };
}));
