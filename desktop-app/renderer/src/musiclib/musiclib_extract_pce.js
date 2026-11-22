/* PC Engine（TurboGrafx-16）遊戲音樂擷取（UMD，純邏輯；不碰 DOM、不用網路）。
 *   classifyPce(name, bytes)        → { cls:'rom', kind:'pce', label, headerBytes }   .pce 有或沒有 512 位元組檔頭都認
 *   psgNew() / psgWrite(st, r, v) / psgTick(st) / psgMix(st)   六聲道 PSG（依 jspce 的暫存器規則移植，見下）
 *   psgRender(writes, opts)         → Float32Array（單聲道，44100 Hz）：用記錄下來的 PSG 寫入重播出來
 *   psgToSong(writes, opts)         → { song（FaMidi 同形）, stats }：退路 MIDI（脈衝與噪音音符）
 *   traceRom(romBytes, opts)        → Promise<trace>：用 HuC6280 真的執行 ROM，錄下 PSG 寫入（時間單位：主時脈）
 *   extractPce(romBytes, opts)      → Promise<結果>：MIDI 與 wav（mp3 由宿主用既有編碼器）；每個輸出都寫明成功或失敗原因
 *
 * PSG 來源與授權：暫存器規則（$0800 選聲道、$0802–$0803 頻率、$0804 控制、$0805 左右音量、$0806 波形、$0807 噪音、$0808–$0809 LFO）
 * 與混音方式移植自 jspce（MIT，yhzmr442/jspce，commit d4339bae5fb2253b8b3d110e256405d928a3afc4）的 PCE.js；授權全文見 renderer/vendor/jspce/LICENSE。
 * jspce 的音訊輸出綁在 Web Audio 上，這裡改成離線重播（不需要 AudioContext），其餘行為一致。
 *
 * 限制（會寫進結果）：沒有按鍵輸入，遊戲停在標題畫面時就只錄到標題音樂；Hudson 的 T 旗標記憶體運算與影像未實作（見 musiclib_pce_cpu.js）。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibPce = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var PSG_HZ = 3579545;             // PSG 時脈（主時脈的一半）
  var MASTER_HZ = 7159090;          // 主時脈（與 musiclib_pce_cpu.js 同）
  var FRAME_TICKS = 119318;         // 一個畫面的主時脈數
  var AUDIO_RATE = 44100;
  var MAX_FRAMES = 3600;            // 約 60 秒遊戲時間的上限（每幀約 1/60 秒）
  var CHUNK = 30;                   // 每跑這麼多畫面讓出一次執行緒
  var TAIL_SEC = 1.5;               // 最後一次寫入之後多錄的尾音
  // 正規化：六聲道、訊號最大 ±16、音量最大 15*31、全域音量最大 15
  var NORM = 6 * 16 * (15 * 31) * 15;
  var PSG_PPQ = 480;

  // ───── 分類 ─────
  function asU8(x) { return x instanceof Uint8Array ? x : new Uint8Array(x || []); }
  function classifyPce(name, bytes) {
    var b = asU8(bytes), ext = String(name || '').split('.').pop().toLowerCase();
    if (ext !== 'pce') return { cls: 'nonrom', kind: 'other', label: '非 PC Engine ROM' };
    var hdr = (b.length % 8192 === 512) ? 512 : 0;
    if (b.length < 8192 + hdr) return { cls: 'rom', kind: 'pce', label: 'PC Engine ROM（檔案太短）', headerBytes: hdr };
    return { cls: 'rom', kind: 'pce', label: 'PC Engine ROM' + (hdr ? '（含 512 位元組檔頭）' : ''), headerBytes: hdr };
  }

  // ───── PSG（移植自 jspce）─────
  function psgNew() {
    var ch = [];
    for (var i = 0; i < 6; i++) {
      ch.push({ R: new Array(10).fill(0), keyon: false, dda: false, freq: 0, count: 0, vol: 0, leftvol: 0, rightvol: 0,
        noiseon: false, noisefreq: 0, noise: 0x8000, index: 0, wave: new Array(32).fill(0) });
    }
    return { ch: ch, sel: 0, wl: 0, wr: 0, lfoOn: false, lfoCtl: 0, lfoFreq: 0 };
  }
  // 寫入一個 PSG 暫存器（r 為 $0800 起算的偏移 0–9）；對應 jspce 的 SetPSG
  function psgWrite(st, r, data) {
    data &= 0xFF;
    if (r === 0) { st.sel = data & 7; return; }
    if (st.sel > 5) return;
    var c = st.ch[st.sel];
    c.R[r] = data;
    switch (r) {
      case 1: st.wl = (data & 0xF0) >> 4; st.wr = data & 0x0F; return;
      case 2: case 3: c.freq = ((c.R[3] << 8) | c.R[2]) & 0x0FFF; return;
      case 4:
        c.keyon = (data & 0x80) === 0x80;
        c.dda = (data & 0x40) === 0x40;
        if (data & 0x40) c.index = 0;
        c.vol = data & 0x1F;
        psgBalance(c); return;
      case 5: psgBalance(c); return;
      case 6:
        if (!c.dda) { c.wave[c.index] = data & 0x1F; c.index = (c.index + 1) & 0x1F; }
        return;
      case 7: c.noiseon = (data & 0x80) === 0x80; c.noisefreq = (data & 0x1F) ^ 0x1F; return;
      case 8: st.lfoFreq = data; return;
      case 9: st.lfoOn = (data & 0x80) === 0x80; st.lfoCtl = data & 0x03; return;
    }
  }
  function psgBalance(c) {
    var vol = c.R[4] & 0x1F;
    c.leftvol = ((c.R[5] & 0xF0) >> 4) * vol;
    c.rightvol = (c.R[5] & 0x0F) * vol;
  }
  // 一個 PSG 時脈（對應 jspce 的 PSGRun 內迴圈的一次）
  function psgTick(st) {
    var j0 = 0, c0, c1, ft, j, c;
    if (st.lfoOn) {
      c0 = st.ch[0]; c1 = st.ch[1];
      if (c0.keyon) {
        if (c0.count === 0) {
          c0.index = (c0.index + 1) & 0x1F;
          ft = 0;
          if (st.lfoCtl !== 0) {
            ft = c1.wave[c1.index];
            ft = ft > 0x0F ? ft - 0x20 : ft & 0x0F;
            ft <<= 4 * (st.lfoCtl - 1);
          }
          ft = c0.freq + ft;
          if (ft < 0) ft = 0;
          c0.count = ft;
        } else c0.count--;
        if (c1.count === 0) { c1.index = (c1.index + 1) & 0x1F; c1.count = c1.freq * st.lfoFreq; } else c1.count--;
      }
      j0 = 2;
    }
    for (j = j0; j < 6; j++) {
      c = st.ch[j];
      if (j < 4 || !c.noiseon) {
        if (c.keyon && !c.dda) {
          if (c.count === 0) { c.index = (c.index + 1) & 0x1F; c.count = c.freq; } else c.count--;
        }
      } else if (c.keyon && !c.dda) {
        if (c.count === 0) {
          c.index = (c.index + 1) & 0x1F;
          if (c.index === 0) c.noise = (c.noise >> 1) | (((c.noise << 12) ^ (c.noise << 15)) & 0x8000);
          c.count = c.noisefreq;
        } else c.count--;
      }
    }
  }
  // 混音：回傳左右聲道（已正規化到約 ±1 的範圍，未截波）；對應 jspce 的 SoundSet
  function psgMix(st) {
    var L = 0, R = 0, j, c, out, sgn;
    for (j = 0; j < 6; j++) {
      if (j === 1 && st.lfoOn) continue;
      c = st.ch[j];
      if (j < 4 || !c.noiseon) out = c.keyon ? (c.dda ? (c.R[6] & 0x1F) : c.wave[c.index]) : 16;
      else out = (c.noise & 1) ? 31 : 0;
      sgn = out - 16;
      L += sgn * c.leftvol; R += sgn * c.rightvol;
    }
    return { l: (L * st.wl) / NORM, r: (R * st.wr) / NORM };
  }

  // ───── 重播（離線）─────
  // writes：[{t（主時脈，已扣掉起點）, r, v}]，依時間排序。回傳單聲道 Float32Array（左右平均）。
  function psgRender(writes, opts) {
    opts = opts || {};
    var rate = opts.sampleRate || AUDIO_RATE;
    var endT = opts.endTicks != null ? opts.endTicks : (writes.length ? writes[writes.length - 1].t : 0) + TAIL_SEC * MASTER_HZ;
    var n = Math.ceil(endT / (MASTER_HZ / rate)) + 1;
    var out = new Float32Array(n), st = psgNew(), wi = 0, acc = 0;
    var psgPerSample = PSG_HZ / rate, masterPerSample = MASTER_HZ / rate;
    for (var k = 0; k < n; k++) {
      var tm = k * masterPerSample;
      while (wi < writes.length && writes[wi].t <= tm) { psgWrite(st, writes[wi].r, writes[wi].v); wi++; }
      acc += psgPerSample;
      var ticks = Math.floor(acc); acc -= ticks;
      for (var q = 0; q < ticks; q++) psgTick(st);
      var m = psgMix(st);
      var s = (m.l + m.r) * 0.5;
      out[k] = s > 1 ? 1 : s < -1 ? -1 : s;
    }
    return out;
  }
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

  // ───── 退路 MIDI：重播寫入，依每次寫入後的音高／音量狀態開音、關音 ─────
  function pitchOf(freq) {
    var f = PSG_HZ / (32 * (freq + 1));
    return Math.round(69 + 12 * Math.log(f / 440) / Math.LN2);
  }
  function psgToSong(writes, opts) {
    opts = opts || {};
    var ticksPerSec = PSG_PPQ * 2;     // 120 BPM：每秒 2 拍
    var st = psgNew();
    var active = [null, null, null, null, null, null], notes = [[], [], [], [], [], []], drum = [];
    var stats = { writes: writes.length, keyOn: 0, ddaWrites: 0, lfoWrites: 0, notes: 0, drumNotes: 0 };
    function toTicks(t) { return Math.round((t / MASTER_HZ) * ticksPerSec); }
    function endAt(j, t) {
      var a = active[j]; if (!a) return;
      var t0 = toTicks(a.t), t1 = toTicks(t);
      var rec = { t: t0, d: Math.max(1, t1 - t0), n: Math.max(0, Math.min(127, a.n)), v: a.v };
      if (a.drum) drum.push(rec); else notes[j].push(rec);
      active[j] = null;
    }
    function desiredFor(j) {
      var c = st.ch[j];
      if (j >= 4 && c.noiseon) {
        if (!c.keyon || c.dda) return null;
        return { key: 'N' + c.noisefreq, n: 36 + (c.noisefreq % 24), v: velOf(c), drum: true };
      }
      if (!c.keyon || c.dda || c.freq === 0) return null;
      var n = pitchOf(c.freq);
      if (n < 0 || n > 127) return null;
      return { key: 'P' + n, n: n, v: velOf(c), drum: false };
    }
    function velOf(c) { var m = Math.max(c.leftvol, c.rightvol); return Math.max(1, Math.min(127, Math.round(m / (15 * 31) * 127))); }
    var last = 0;
    writes.forEach(function (w) {
      last = w.t;
      if (w.r === 4 && (w.v & 0x80)) stats.keyOn++;
      if (w.r === 6 && st.ch[st.sel] && st.ch[st.sel].dda) stats.ddaWrites++;
      if (w.r === 9 && (w.v & 0x80)) stats.lfoWrites++;
      psgWrite(st, w.r, w.v);
      for (var j = 0; j < 6; j++) {
        var want = desiredFor(j), a = active[j];
        var key = want ? want.key : null;
        var curKey = a ? a.key : null;
        if (key === curKey) continue;
        if (a) endAt(j, w.t);
        if (want) active[j] = { key: want.key, n: want.n, v: want.v, t: w.t, drum: want.drum };
      }
    });
    for (var j2 = 0; j2 < 6; j2++) endAt(j2, last + TAIL_SEC * MASTER_HZ);
    var endLast = last + TAIL_SEC * MASTER_HZ;
    var song = { ppq: PSG_PPQ, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: opts.title || '', tracks: [] };
    var names = ['PSG 聲道 1', 'PSG 聲道 2', 'PSG 聲道 3', 'PSG 聲道 4', 'PSG 聲道 5', 'PSG 聲道 6'];
    for (var k = 0; k < 6; k++) {
      if (!notes[k].length) continue;
      song.tracks.push({ name: names[k], channel: k, program: 80, drum: false, volume: 100, pan: 64, notes: notes[k] });
      stats.notes += notes[k].length;
    }
    if (drum.length) { song.tracks.push({ name: '雜訊（打擊，近似）', channel: 9, program: 0, drum: true, volume: 100, pan: 64, notes: drum }); stats.drumNotes = drum.length; }
    stats.notes += drum.length;
    stats.seconds = Math.round((endLast / MASTER_HZ) * 10) / 10;
    return { song: song, stats: stats };
  }

  // 按鍵排程：每 10 畫面依序按 RUN、I、II、SELECT、上、下、左、右（高 4 位元 I/II/SELECT/RUN，低 4 位元 上右下左）。
  // 實測 P2001：只按 RUN 或 I 不會離開選單（遊戲只輪詢搖桿、不進音樂）；循環按完所有鍵後 2530 次按音。
  var PAD_SEQ = [0x80, 0x10, 0x20, 0x40, 0x01, 0x04, 0x08, 0x02];
  function padAt(f) { return PAD_SEQ[Math.floor(f / 10) % PAD_SEQ.length]; }

  // ───── 執行 ROM（HuC6280，自寫；cpu 模組由呼叫端注入）─────
  // 錄下每次 PSG 寫入（$0800–$0809）與畫面結束；停止規則：到 maxFrames，或有過聲音之後安靜 900 幀（至少 300 幀有聲音）。
  async function traceRom(romBytes, opts) {
    opts = opts || {};
    var CPU = opts.cpu;
    if (!CPU || !CPU.createMachine) throw new Error('沒有注入 HuC6280 模組（opts.cpu）');
    var maxFrames = opts.maxFrames || MAX_FRAMES;
    var isCancelled = typeof opts.isCancelled === 'function' ? opts.isCancelled : function () { return false; };
    var writes = [], activeSet = {}, nAct = 0, lastAct = -1;
    var m = CPU.createMachine(romBytes, {
      pad: padAt,
      onPsg: function (t, r, v) {
        writes.push({ t: t, r: r, v: v });
        var fr = Math.floor(t / FRAME_TICKS);
        if (!activeSet[fr]) { activeSet[fr] = 1; nAct++; if (fr > lastAct) lastAct = fr; }
      }
    });
    var quit = 'maxFrames', crashed = null;
    try {
      while (true) {
        if (isCancelled()) { quit = 'cancelled'; break; }
        var target = Math.min(maxFrames, m.frames() + CHUNK);
        var res = m.run(target, isCancelled);
        if (res.reason === 'cancelled') { quit = 'cancelled'; break; }
        if (res.reason === 'unknown-ops') { quit = 'unknown-ops'; break; }
        if (m.frames() >= maxFrames) break;
        if (nAct >= 300 && m.frames() - lastAct >= 900) { quit = 'quiet'; break; }
        if (typeof opts.onProgress === 'function') opts.onProgress(m.frames());
        await new Promise(function (r) { setTimeout(r, 0); });
      }
    } catch (e) { crashed = String((e && e.message) || e); quit = 'crashed'; }
    return { writes: writes, frames: m.frames(), quit: quit, crashed: crashed, cpu: m.cpu, unknown: m.cpu.unknown, unknownOps: m.cpu.unknownOps, activeFrames: nAct };
  }

  // ───── 抽出（結果逐項說明）─────
  // out.song（MIDI）、out.midiReason；out.wav（Uint8Array）、out.samples（Float32Array）、out.sampleRate、out.wavReason；out.stats
  async function extractPce(romBytes, opts) {
    opts = opts || {};
    var out = { ok: false, mode: 'none', song: null, midiReason: null, wav: null, samples: null, sampleRate: AUDIO_RATE, wavReason: null, reason: null, cancelled: false, stats: {} };
    var info = classifyPce(opts.name || 'x.pce', romBytes);
    var body = asU8(romBytes);
    if (info.headerBytes) body = body.subarray(info.headerBytes);
    if (body.length < 8192) { out.reason = 'ROM 太短（' + body.length + ' 位元組）'; return out; }
    var tr;
    try { tr = await traceRom(romBytes, { cpu: opts.cpu, maxFrames: opts.maxFrames, isCancelled: opts.isCancelled, onProgress: opts.onProgress }); }
    catch (e) { out.reason = 'ROM 執行失敗：' + String((e && e.message) || e); return out; }
    out.stats = { frames: tr.frames, quit: tr.quit, crashed: tr.crashed, psgWrites: tr.writes.length, activeFrames: tr.activeFrames, unknownOps: tr.unknown };
    if (tr.quit === 'cancelled') { out.cancelled = true; out.reason = '已取消'; return out; }
    if (tr.crashed) out.stats.note = '執行中斷：' + tr.crashed;
    if (tr.quit === 'unknown-ops') out.stats.note = '執行到太多未實作的操作碼，提前停止';
    if (!tr.writes.length) {
      out.midiReason = '執行 ' + tr.frames + ' 個畫面，沒有任何 PSG 寫入（$0800–$0809）';
      out.wavReason = out.midiReason;
      out.reason = out.midiReason;
      return out;
    }
    // 起點：第一次按音（r=4、bit7）所在的畫面起；之前的寫入只保留狀態（時間壓到 0）
    var firstKey = null;
    for (var i = 0; i < tr.writes.length; i++) { var w = tr.writes[i]; if (w.r === 4 && (w.v & 0x80)) { firstKey = w; break; } }
    var t0 = firstKey ? Math.floor(firstKey.t / FRAME_TICKS) * FRAME_TICKS : 0;
    var shifted = tr.writes.map(function (w) { return { t: Math.max(0, w.t - t0), r: w.r, v: w.v }; });
    if (!firstKey) {
      out.midiReason = '有 PSG 寫入，但沒有按音（$0804 bit 7 從未設定）';
      out.wavReason = out.midiReason;
      out.reason = out.midiReason;
      return out;
    }
    var mid = psgToSong(shifted, { title: opts.name || '' });
    if (mid.stats.notes > 0) { out.song = mid.song; out.stats.notes = mid.stats.notes; out.stats.seconds = mid.stats.seconds; out.stats.ddaWrites = mid.stats.ddaWrites; out.stats.keyOn = mid.stats.keyOn; }
    else out.midiReason = '有按音但沒有可轉成音符的聲音（頻率為 0 或只有 DDA 取樣）';
    var samples = psgRender(shifted, {});
    out.samples = samples; out.wav = wav16(samples, AUDIO_RATE);
    out.stats.durationSec = Math.round(samples.length / AUDIO_RATE * 10) / 10;
    out.mode = out.song ? 'midi+wav' : 'wav';
    out.ok = !!(out.song || samples.length);
    return out;
  }

  return {
    classifyPce: classifyPce, psgNew: psgNew, psgWrite: psgWrite, psgTick: psgTick, psgMix: psgMix,
    psgRender: psgRender, psgToSong: psgToSong, wav16: wav16, traceRom: traceRom, extractPce: extractPce,
    PSG_HZ: PSG_HZ, MASTER_HZ: MASTER_HZ, FRAME_TICKS: FRAME_TICKS, AUDIO_RATE: AUDIO_RATE, MAX_FRAMES: MAX_FRAMES
  };
}));
