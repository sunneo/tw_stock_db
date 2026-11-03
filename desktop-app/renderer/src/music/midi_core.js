// 音樂領域的純函式核心 FaMidi(node 與瀏覽器都能跑;設計見 DESIGN.music.md)。
// 事件模型(一份 MIDI 就是一個物件,時間單位是 tick,每四分音符 ppq 個):
//   song = { ppq:480, tempos:[{t:0, bpm:120}…], timesig:{n:4, d:4}, title,
//            tracks:[{ name, channel(0-15), program(0-127), drum:bool, volume(0-127), pan(0-127),
//                      notes:[{ t, d, n(0-127), v(1-127) }…] }…] }
// 解析(parse)吃 Uint8Array,寫出(write)回 Uint8Array(Format 1,第一軌放速度與拍號)。
// 所有編輯函式回傳新物件,不改原物件;壞輸入一律夾進合法範圍,不丟例外(parse 遇到不是 MIDI 檔才丟)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMidi = factory(); })(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const PPQ = 480;
  const LIM = { tracks: 64, notes: 200000, name: 60 };
  const clampI = (v, lo, hi, d) => { v = Math.round(Number(v)); return isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d; };
  const clone = (o) => JSON.parse(JSON.stringify(o));
  const str = (v) => String(v == null ? '' : v).replace(/\u0000/g, '').slice(0, LIM.name);

  function decodeName(d) { const raw = String.fromCharCode.apply(null, Array.from(d)); try { return decodeURIComponent(escape(raw)); } catch (e) { return raw; } }

  function emptyTrack(name, channel, program) { return { name: str(name), channel: clampI(channel, 0, 15, 0), program: clampI(program, 0, 127, 0), drum: false, volume: 100, pan: 64, notes: [] }; }
  function emptySong() { return { ppq: PPQ, tempos: [{ t: 0, bpm: 120 }], timesig: { n: 4, d: 4 }, title: '', tracks: [] }; }

  // ───────────────────────── 解析
  function parse(bytes) {
    const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const u32 = (o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const u16 = (o) => (b[o] << 8) | b[o + 1];
    if (b.length < 14 || b[0] !== 0x4d || b[1] !== 0x54 || b[2] !== 0x68 || b[3] !== 0x64) throw new Error('不是標準 MIDI 檔(找不到 MThd)');
    const hl = u32(4), nTrk = u16(10); let div = u16(12);
    if (div & 0x8000) div = PPQ; // 以時間碼為單位的檔案不支援,當成預設解析度(時間會不準)
    div = div || PPQ;
    const scale = PPQ / div;
    const song = emptySong(); song.tempos = [];
    let pos = 8 + hl; let parsedTracks = 0;
    const out = [];
    while (pos + 8 <= b.length && parsedTracks < nTrk && out.length < LIM.tracks * 16) {
      const id = String.fromCharCode(b[pos], b[pos + 1], b[pos + 2], b[pos + 3]); const len = u32(pos + 4); const end = Math.min(b.length, pos + 8 + len);
      pos += 8;
      if (id !== 'MTrk') { pos = end; continue; }
      parsedTracks++;
      let t = 0, status = 0, trackName = '';
      const chan = {}; // channel → { track, open:{note→{t,v}} }
      const getCh = (c) => { if (!chan[c]) chan[c] = { name: trackName, program: 0, volume: 100, pan: 64, notes: [], open: {} }; return chan[c]; };
      const readVar = () => { let v = 0, k = 0; while (pos < end && k++ < 4) { const x = b[pos++]; v = (v << 7) | (x & 0x7f); if (!(x & 0x80)) break; } return v; };
      while (pos < end) {
        t += readVar();
        let st = b[pos];
        if (st === undefined) break;
        if (st & 0x80) { pos++; status = st; } else st = status;
        const tick = Math.round(t * scale);
        if (st === 0xff) {
          const type = b[pos++]; const l = readVar(); const d = b.subarray(pos, pos + l); pos += l;
          if (type === 0x51 && l === 3) song.tempos.push({ t: tick, bpm: Math.round(60000000 / ((d[0] << 16) | (d[1] << 8) | d[2]) * 100) / 100 });
          else if (type === 0x58 && l >= 2 && !song._ts) { song.timesig = { n: d[0] || 4, d: Math.pow(2, d[1]) || 4 }; song._ts = 1; }
          else if (type === 0x03) { trackName = decodeName(d); if (!song.title && parsedTracks === 1) song.title = str(trackName); }
          else if (type === 0x2f) break;
        } else if (st === 0xf0 || st === 0xf7) { const l = readVar(); pos += l; }
        else {
          const hi = st & 0xf0, c = st & 0x0f;
          const two = hi === 0xc0 || hi === 0xd0;
          const d1 = b[pos++], d2 = two ? 0 : b[pos++];
          if (hi === 0x90 && d2 > 0) { const ch = getCh(c); if (ch.open[d1]) { const o = ch.open[d1]; ch.notes.push({ t: o.t, d: Math.max(1, tick - o.t), n: d1, v: o.v }); } ch.open[d1] = { t: tick, v: d2 }; }
          else if (hi === 0x80 || (hi === 0x90 && d2 === 0)) { const ch = getCh(c); const o = ch.open[d1]; if (o) { ch.notes.push({ t: o.t, d: Math.max(1, tick - o.t), n: d1, v: o.v }); delete ch.open[d1]; } }
          else if (hi === 0xc0) { const ch = getCh(c); if (!ch.notes.length && !Object.keys(ch.open).length) ch.program = d1; else if (!ch.progLater) ch.progLater = d1; }
          else if (hi === 0xb0) { const ch = getCh(c); if (d1 === 7) ch.volume = d2; else if (d1 === 10) ch.pan = d2; }
        }
      }
      for (const c of Object.keys(chan)) {
        const ch = chan[c]; for (const n of Object.keys(ch.open)) ch.notes.push({ t: ch.open[n].t, d: Math.max(1, t * scale - ch.open[n].t | 0), n: +n, v: ch.open[n].v });
        if (!ch.notes.length) continue;
        const tr = emptyTrack(ch.name || ('軌道 ' + (out.length + 1)), +c, ch.program);
        tr.drum = +c === 9; tr.volume = ch.volume; tr.pan = ch.pan; tr.notes = ch.notes.sort((x, y) => x.t - y.t || x.n - y.n);
        out.push(tr);
      }
      pos = end;
    }
    delete song._ts;
    if (!song.tempos.length || song.tempos[0].t > 0) song.tempos.unshift({ t: 0, bpm: 120 });
    song.tempos.sort((a, c) => a.t - c.t);
    song.tracks = out.slice(0, LIM.tracks);
    return validate(song);
  }

  // ───────────────────────── 驗證(夾進合法範圍)
  function validate(song) {
    const s = emptySong(); if (!song || typeof song !== 'object') return s;
    s.title = str(song.title);
    s.ppq = PPQ;
    s.tempos = (Array.isArray(song.tempos) ? song.tempos : []).map((x) => ({ t: clampI(x && x.t, 0, 1e9, 0), bpm: Math.max(20, Math.min(400, Number(x && x.bpm) || 120)) })).sort((a, b) => a.t - b.t).slice(0, 512);
    if (!s.tempos.length) s.tempos = [{ t: 0, bpm: 120 }]; s.tempos[0].t = 0;
    const ts = song.timesig || {}; const d = clampI(ts.d, 1, 32, 4); s.timesig = { n: clampI(ts.n, 1, 32, 4), d: [1, 2, 4, 8, 16, 32].includes(d) ? d : 4 };
    let total = 0;
    for (const tr of (Array.isArray(song.tracks) ? song.tracks : []).slice(0, LIM.tracks)) {
      if (!tr || typeof tr !== 'object') continue;
      const t = emptyTrack(tr.name, tr.channel, tr.program);
      t.drum = !!tr.drum || t.channel === 9; if (t.drum) t.channel = 9;
      t.volume = clampI(tr.volume, 0, 127, 100); t.pan = clampI(tr.pan, 0, 127, 64);
      for (const n of Array.isArray(tr.notes) ? tr.notes : []) {
        if (total >= LIM.notes) break;
        if (!n) continue;
        t.notes.push({ t: clampI(n.t, 0, 1e9, 0), d: clampI(n.d, 1, 1e8, PPQ / 2), n: clampI(n.n, 0, 127, 60), v: clampI(n.v, 1, 127, 90) }); total++;
      }
      t.notes.sort((a, b) => a.t - b.t || a.n - b.n);
      s.tracks.push(t);
    }
    return s;
  }

  // ───────────────────────── 寫出(Format 1)
  function varLen(v) { v = Math.max(0, v | 0); const a = [v & 0x7f]; v >>>= 7; while (v > 0) { a.unshift((v & 0x7f) | 0x80); v >>>= 7; } return a; }
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const be16 = (v) => [(v >> 8) & 255, v & 255];
  const ascii = (s) => Array.from(unescape(encodeURIComponent(s))).map((c) => c.charCodeAt(0) & 255);
  function chunk(id, data) { return [].concat(Array.from(id).map((c) => c.charCodeAt(0)), be32(data.length), data); }
  function trackBytes(events) { // events: [{t, order, bytes}]
    events.sort((a, b) => a.t - b.t || a.order - b.order);
    const out = []; let last = 0;
    for (const e of events) { out.push.apply(out, varLen(e.t - last)); out.push.apply(out, e.bytes); last = e.t; }
    out.push(0, 0xff, 0x2f, 0);
    return chunk('MTrk', out);
  }
  function write(song) {
    const s = validate(song);
    const ev0 = [];
    if (s.title) { const nb = ascii(s.title); ev0.push({ t: 0, order: 0, bytes: [0xff, 0x03].concat(varLen(nb.length), nb) }); }
    const dd = Math.round(Math.log2(s.timesig.d));
    ev0.push({ t: 0, order: 1, bytes: [0xff, 0x58, 4, s.timesig.n, dd, 24, 8] });
    for (const tp of s.tempos) { const mpq = Math.round(60000000 / tp.bpm); ev0.push({ t: tp.t, order: 2, bytes: [0xff, 0x51, 3, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255] }); }
    const parts = [trackBytes(ev0)];
    for (const tr of s.tracks) {
      const ev = []; const c = tr.channel;
      const nb = ascii(tr.name); ev.push({ t: 0, order: 0, bytes: [0xff, 0x03].concat(varLen(nb.length), nb) });
      if (!tr.drum) ev.push({ t: 0, order: 1, bytes: [0xc0 | c, tr.program] });
      ev.push({ t: 0, order: 1, bytes: [0xb0 | c, 7, tr.volume] }, { t: 0, order: 1, bytes: [0xb0 | c, 10, tr.pan] });
      for (const n of tr.notes) { ev.push({ t: n.t, order: 3, bytes: [0x90 | c, n.n, n.v] }, { t: n.t + n.d, order: 2, bytes: [0x80 | c, n.n, 0] }); }
      parts.push(trackBytes(ev));
    }
    const head = chunk('MThd', [].concat(be16(1), be16(parts.length), be16(PPQ)));
    return Uint8Array.from([].concat(head, ...parts));
  }

  // ───────────────────────── 時間
  function ticksToSec(song, tick) { // 依速度表換算
    const tp = song.tempos; let sec = 0, last = 0, bpm = tp[0].bpm;
    for (let i = 1; i < tp.length && tp[i].t < tick; i++) { sec += (tp[i].t - last) / song.ppq * 60 / bpm; last = tp[i].t; bpm = tp[i].bpm; }
    return sec + (tick - last) / song.ppq * 60 / bpm;
  }
  function secToTicks(song, sec) {
    const tp = song.tempos; let acc = 0, last = 0, bpm = tp[0].bpm;
    for (let i = 1; i < tp.length; i++) { const seg = (tp[i].t - last) / song.ppq * 60 / bpm; if (acc + seg > sec) break; acc += seg; last = tp[i].t; bpm = tp[i].bpm; }
    return Math.round(last + (sec - acc) * bpm / 60 * song.ppq);
  }
  function endTick(song) { let e = 0; for (const tr of song.tracks) for (const n of tr.notes) e = Math.max(e, n.t + n.d); return e; }
  function durationSec(song) { return ticksToSec(song, endTick(song)); }
  function noteCount(song) { return song.tracks.reduce((s, t) => s + t.notes.length, 0); }

  // ───────────────────────── 編輯(全部回傳新物件)
  function transpose(song, semis, trackIdx) { // 鼓軌不移調
    const s = clone(song); semis = clampI(semis, -48, 48, 0);
    s.tracks.forEach((tr, i) => { if (tr.drum || (trackIdx != null && i !== trackIdx)) return; tr.notes.forEach((n) => { n.n = Math.max(0, Math.min(127, n.n + semis)); }); });
    return s;
  }
  function quantize(song, grid, trackIdx, opts) { // grid 單位:tick;opts.keepEnd 為 false 時音長也量化
    const s = clone(song); grid = Math.max(1, clampI(grid, 1, song.ppq * 4, song.ppq / 4));
    s.tracks.forEach((tr, i) => { if (trackIdx != null && i !== trackIdx) return; tr.notes.forEach((n) => { n.t = Math.round(n.t / grid) * grid; if (!(opts && opts.keepLength)) n.d = Math.max(grid, Math.round(n.d / grid) * grid); }); tr.notes.sort((a, b) => a.t - b.t || a.n - b.n); });
    return s;
  }
  function shiftTime(song, ticks, trackIdx) {
    const s = clone(song); ticks = clampI(ticks, -1e7, 1e7, 0);
    s.tracks.forEach((tr, i) => { if (trackIdx != null && i !== trackIdx) return; tr.notes.forEach((n) => { n.t = Math.max(0, n.t + ticks); }); });
    return s;
  }
  function setTempo(song, bpm) { const s = clone(song); s.tempos = [{ t: 0, bpm: Math.max(20, Math.min(400, Number(bpm) || 120)) }]; return s; }
  // 等比縮放整張速度表:第一個速度改成 bpm,後面的變速點照比例跟著變(保留速度起伏);只有一個速度時等同 setTempo
  function scaleTempo(song, bpm) { const s = clone(song); const to = Math.max(20, Math.min(400, Number(bpm) || 120)); const f = to / song.tempos[0].bpm; s.tempos = s.tempos.map((x) => ({ t: x.t, bpm: Math.max(20, Math.min(400, Math.round(x.bpm * f * 100) / 100)) })); s.tempos[0].bpm = to; return s; }
  function scaleVelocity(song, factor, trackIdx) {
    const s = clone(song); factor = Math.max(0.1, Math.min(3, Number(factor) || 1));
    s.tracks.forEach((tr, i) => { if (trackIdx != null && i !== trackIdx) return; tr.notes.forEach((n) => { n.v = clampI(n.v * factor, 1, 127, 90); }); });
    return s;
  }
  function addTrack(song, name, program, drum) {
    const s = clone(song); if (s.tracks.length >= LIM.tracks) return s;
    const used = new Set(s.tracks.map((t) => t.channel)); let ch = 0; while (ch < 16 && (used.has(ch) || ch === 9)) ch++;
    const t = emptyTrack(name || ('軌道 ' + (s.tracks.length + 1)), drum ? 9 : (ch > 15 ? 0 : ch), program); t.drum = !!drum; s.tracks.push(t); return s;
  }
  function removeTrack(song, idx) { const s = clone(song); if (idx >= 0 && idx < s.tracks.length) s.tracks.splice(idx, 1); return s; }
  function setProgram(song, idx, program) { const s = clone(song); if (s.tracks[idx]) s.tracks[idx].program = clampI(program, 0, 127, 0); return s; }
  function mergeTracks(song, a, b) { // 把 b 併進 a(同時間同音高只留較強的)
    const s = clone(song); if (!s.tracks[a] || !s.tracks[b] || a === b) return s;
    s.tracks[a].notes = s.tracks[a].notes.concat(s.tracks[b].notes).sort((x, y) => x.t - y.t || x.n - y.n);
    s.tracks.splice(b, 1); return s;
  }
  function splitByPitch(song, idx, splitNote) { // 以音高切成上下兩軌(例如鋼琴左右手)
    const s = clone(song); const tr = s.tracks[idx]; if (!tr) return s;
    const sp = clampI(splitNote, 1, 127, 60);
    const hi = clone(tr), lo = clone(tr); hi.name = tr.name + '(高音)'; lo.name = tr.name + '(低音)';
    hi.notes = tr.notes.filter((n) => n.n >= sp); lo.notes = tr.notes.filter((n) => n.n < sp);
    const parts = [hi, lo].filter((t) => t.notes.length);
    s.tracks.splice(idx, 1, ...parts); return s;
  }
  function addNote(song, idx, note) { const s = clone(song); const tr = s.tracks[idx]; if (!tr || noteCount(s) >= LIM.notes) return s; tr.notes.push({ t: clampI(note.t, 0, 1e9, 0), d: clampI(note.d, 1, 1e8, song.ppq / 2), n: clampI(note.n, 0, 127, 60), v: clampI(note.v, 1, 127, 90) }); tr.notes.sort((a, b) => a.t - b.t || a.n - b.n); return s; }
  function removeNotes(song, idx, from, to, pitchLo, pitchHi) { // 範圍內的音符(tick 與音高),回 {song, removed}
    const s = clone(song); const tr = s.tracks[idx]; let removed = 0; if (!tr) return { song: s, removed };
    const lo = pitchLo == null ? 0 : pitchLo, hi = pitchHi == null ? 127 : pitchHi;
    tr.notes = tr.notes.filter((n) => { const hit = n.t >= from && n.t < to && n.n >= lo && n.n <= hi; if (hit) removed++; return !hit; });
    return { song: s, removed };
  }
  // 摘要(給 AI 看的文字,不放全部音符)
  function summary(song) {
    const bpm = song.tempos[0].bpm;
    const lines = ['拍號 ' + song.timesig.n + '/' + song.timesig.d + ',速度 ' + bpm + ',長度 ' + Math.round(durationSec(song)) + ' 秒,共 ' + song.tracks.length + ' 軌 ' + noteCount(song) + ' 個音'];
    song.tracks.forEach((t, i) => { const ns = t.notes; const lo = ns.length ? Math.min.apply(null, ns.map((n) => n.n)) : 0, hi = ns.length ? Math.max.apply(null, ns.map((n) => n.n)) : 0; lines.push((i + 1) + '. ' + t.name + (t.drum ? '(鼓組)' : '(音色 ' + t.program + ')') + ',' + ns.length + ' 個音,音域 ' + noteName(lo) + '–' + noteName(hi)); });
    return lines.join('\n');
  }
  const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  function noteName(n) { return NAMES[n % 12] + (Math.floor(n / 12) - 1); }

  return { PPQ, LIM, emptySong, emptyTrack, parse, write, validate, ticksToSec, secToTicks, endTick, durationSec, noteCount, transpose, quantize, shiftTime, setTempo, scaleTempo, scaleVelocity, addTrack, removeTrack, setProgram, mergeTracks, splitByPitch, addNote, removeNotes, summary, noteName };
});
