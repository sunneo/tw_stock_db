// 音樂領域階段 2:MIDI 編輯器的純函式層(封閉動作、中文指令、復原重做)。畫面在 midi_editor_ui(之後),這裡不碰 DOM。
// 動作是 { act, ... },全部由 apply 執行並回傳新曲子;AI 或使用者說的話先由 parseCommands 讀成動作,讀不懂才交給模型(模型也只能輸出這份動作清單)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./midi_core.js')); else root.FaMidiEdit = factory(root.FaMidi || (typeof FaMidi !== 'undefined' ? FaMidi : undefined)); })(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  const ACTS = ['add_note', 'remove_notes', 'move', 'transpose', 'quantize', 'set_program', 'add_track', 'remove_track', 'set_tempo', 'velocity', 'merge_tracks', 'split_pitch'];
  const GRID = { '全': 4, '二分': 2, '四分': 1, '八分': 0.5, '十六分': 0.25, '三十二分': 0.125 };
  const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
  function cnNum(s) { // 「十二」「二十」「三」或阿拉伯數字
    if (s == null) return NaN; s = String(s).trim(); if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
    if (!/^[零〇一二兩三四五六七八九十]+$/.test(s)) return NaN;
    if (s.length === 1) return CN[s];
    const i = s.indexOf('十'); if (i < 0) return NaN;
    const a = i === 0 ? 1 : CN[s.slice(0, i)], b = s.length > i + 1 ? CN[s.slice(i + 1)] : 0; return a * 10 + b;
  }
  const NOTE_RE = /([A-Ga-g])([#♯b♭]?)(-?\d)/;
  function pitchOf(str) { // C4 / c#5 / 60
    str = String(str).trim(); if (/^\d{1,3}$/.test(str)) return Math.min(127, Number(str));
    const m = NOTE_RE.exec(str); if (!m) return NaN; const base = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()];
    const acc = /[#♯]/.test(m[2]) ? 1 : /[b♭]/.test(m[2]) ? -1 : 0; return (Number(m[3]) + 1) * 12 + base + acc;
  }
  // 音色名稱(GS/GM 128 個的常用中文別名;只列常見,完整名單由 UI 的下拉選單提供)
  const PROGRAM_NAMES = [['鋼琴', 0], ['電鋼琴', 4], ['鋼片琴', 8], ['木琴', 13], ['管風琴', 19], ['風琴', 19], ['手風琴', 21], ['口琴', 22], ['吉他', 25], ['木吉他', 25], ['電吉他', 27], ['失真吉他', 30], ['貝斯', 33], ['電貝斯', 33], ['小提琴', 40], ['中提琴', 41], ['大提琴', 42], ['低音提琴', 43], ['弦樂', 48], ['豎琴', 46], ['合唱', 52], ['小號', 56], ['長號', 57], ['低音號', 58], ['法國號', 60], ['薩克斯風', 65], ['雙簧管', 68], ['單簧管', 71], ['長笛', 73], ['短笛', 72], ['笛', 73], ['合成主音', 80], ['合成器', 80], ['合成鋪底', 88], ['西塔琴', 104], ['鋼鼓', 114]];
  function programOf(str) { str = String(str); let best = null; for (const [n, p] of PROGRAM_NAMES) if (str.indexOf(n) >= 0 && (!best || n.length > best[0].length)) best = [n, p]; return best ? best[1] : null; }

  function trackIndex(song, ref) { // ref:數字(從 1 起算的第幾軌)、名稱片段
    if (ref == null) return null; if (typeof ref === 'number') return ref >= 0 && ref < song.tracks.length ? ref : null;
    const k = cnNum(ref); if (!isNaN(k) && k >= 1 && k <= song.tracks.length) return k - 1;
    const i = song.tracks.findIndex((t) => t.name && String(ref).indexOf(t.name) >= 0 || (t.name && t.name.indexOf(String(ref)) >= 0)); return i >= 0 ? i : null;
  }
  function beats(song, b) { return Math.round(Number(b) * song.ppq); }

  function apply(song, a) {
    if (!a || ACTS.indexOf(a.act) < 0) return { song, error: '不認得的動作:' + (a && a.act) };
    const ti = a.track == null ? null : trackIndex(song, a.track);
    if (a.track != null && ti == null && ['add_track', 'set_tempo'].indexOf(a.act) < 0) return { song, error: '找不到音軌:' + a.track };
    switch (a.act) {
      case 'add_note': { const t = ti == null ? 0 : ti; if (!song.tracks[t]) return { song, error: '還沒有音軌' }; return { song: M.addNote(song, t, { t: beats(song, a.beat || 0), d: beats(song, a.beats || 0.5), n: typeof a.pitch === 'string' ? pitchOf(a.pitch) : a.pitch, v: a.velocity || 90 }) }; }
      case 'remove_notes': return { song: M.removeNotes(song, ti == null ? 0 : ti, a.fromBeat == null ? 0 : beats(song, a.fromBeat), a.toBeat == null ? 1e9 : beats(song, a.toBeat), a.pitchLo, a.pitchHi).song };
      case 'move': return { song: M.shiftTime(song, beats(song, a.beats || 0), ti) };
      case 'transpose': return { song: M.transpose(song, a.semitones || 0, ti) };
      case 'quantize': return { song: M.quantize(song, beats(song, a.grid || 0.25), ti) };
      case 'set_program': { if (ti == null) return { song, error: '要指定哪一軌' }; return { song: M.setProgram(song, ti, a.program) }; }
      case 'add_track': return { song: M.addTrack(song, a.name, a.program || 0, !!a.drum) };
      case 'remove_track': { if (ti == null) return { song, error: '要指定哪一軌' }; return { song: M.removeTrack(song, ti) }; }
      case 'set_tempo': return { song: M.setTempo(song, a.bpm) };
      case 'velocity': return { song: M.scaleVelocity(song, a.factor || 1, ti) };
      case 'merge_tracks': { const b = trackIndex(song, a.with); if (ti == null || b == null) return { song, error: '要指定兩軌' }; return { song: M.mergeTracks(song, ti, b) }; }
      case 'split_pitch': { if (ti == null) return { song, error: '要指定哪一軌' }; return { song: M.splitByPitch(song, ti, typeof a.at === 'string' ? pitchOf(a.at) : a.at) }; }
    }
  }
  function applyAll(song, acts) { let s = song; const errors = []; for (const a of acts || []) { const r = apply(s, a); if (r.error) errors.push(r.error); else s = r.song; } return { song: s, errors }; }

  // 中文指令 → 動作。回 { actions, rest }:rest 是程式讀不懂的部分(交給模型,模型也只能回動作清單)
  function parseCommands(text, song) {
    const actions = [], rest = [];
    const parts = String(text || '').split(/[,，。;；\n]+|然後|接著|並且/).map((x) => x.trim()).filter(Boolean);
    for (const p of parts) {
      let m, a = null, track = null;
      const tm = /第\s*([一二兩三四五六七八九十\d]+)\s*軌/.exec(p); if (tm) track = cnNum(tm[1]);
      else { const t = song.tracks.find((x) => x.name && p.indexOf(x.name) >= 0); if (t) track = song.tracks.indexOf(t); }
      const tnum = track == null ? null : (tm ? track - 1 : track);
      if ((m = /(升|降|高|低)\s*([一二兩三四五六七八九十\d]+)\s*(?:個)?(半音|度|八度)/.exec(p))) {
        let n = cnNum(m[2]); if (m[3] === '八度') n *= 12; else if (m[3] === '度') n = n === 8 ? 12 : n; a = { act: 'transpose', semitones: /升|高/.test(m[1]) ? n : -n };
      } else if ((m = /(?:速度|節奏|bpm)\D{0,4}(\d{2,3})/i.exec(p)) || (m = /(\d{2,3})\s*bpm/i.exec(p))) a = { act: 'set_tempo', bpm: Number(m[1]) };
      else if ((m = /量化\D{0,3}(全|二分|四分|八分|十六分|三十二分)/.exec(p))) a = { act: 'quantize', grid: GRID[m[1]] };
      else if (/量化|對齊拍子/.test(p)) a = { act: 'quantize', grid: 0.25 };
      else if ((m = /(?:往後|向後|延後|晚)\s*([\d.一二兩三四五六七八九十]+)\s*拍/.exec(p))) a = { act: 'move', beats: cnNum(m[1]) };
      else if ((m = /(?:往前|向前|提早|早)\s*([\d.一二兩三四五六七八九十]+)\s*拍/.exec(p))) a = { act: 'move', beats: -cnNum(m[1]) };
      else if ((m = /(大聲|加強|強)\s*(?:一點)?/.exec(p)) && /聲|強|力度/.test(p)) a = { act: 'velocity', factor: 1.2 };
      else if (/小聲|減弱|弱一點/.test(p)) a = { act: 'velocity', factor: 0.8 };
      else if ((m = /(?:新增|加|多一|加一)(?:個|條|一軌|一條)?\s*(?:音軌|軌)?\s*(?:[:：]|,|用)?\s*(鼓|.{1,6})?/.exec(p)) && /(新增|加).*(軌|鼓)/.test(p)) {
        const drum = /鼓/.test(p); a = { act: 'add_track', name: drum ? '鼓' : undefined, program: drum ? 0 : (programOf(p) || 0), drum };
      } else if ((m = /(?:刪除|移除|刪掉)(?:第\s*[一二兩三四五六七八九十\d]+\s*軌|.*軌)/.exec(p)) && tnum != null) a = { act: 'remove_track', track: tnum };
      else if ((m = /(?:換成|改成|改用|換用)(.+)/.exec(p)) && programOf(m[1]) != null && tnum != null) a = { act: 'set_program', track: tnum, program: programOf(m[1]) };
      else if ((m = /在第\s*([\d.]+)\s*拍(?:放|加|新增)\s*([A-Ga-g][#♯b♭]?-?\d|\d{2,3})\s*(?:長\s*([\d.]+)\s*拍)?/.exec(p))) a = { act: 'add_note', beat: Number(m[1]) - 1, pitch: m[2], beats: m[3] ? Number(m[3]) : 1 };
      if (a) { if (tnum != null && a.act !== 'add_track' && a.act !== 'set_program' && a.act !== 'remove_track') a.track = tnum; actions.push(a); } else rest.push(p);
    }
    return { actions, rest: rest.join(',') };
  }

  // 復原／重做:存整份曲子的參考(編輯都回新物件,共用沒動到的部分之外不複製太多;上限保護記憶體)
  function history(initial, limit) {
    limit = limit || 50; const past = [], future = []; let cur = initial;
    return {
      get song() { return cur; },
      push(s) { if (s === cur) return cur; past.push(cur); if (past.length > limit) past.shift(); future.length = 0; cur = s; return cur; },
      undo() { if (!past.length) return cur; future.push(cur); cur = past.pop(); return cur; },
      redo() { if (!future.length) return cur; past.push(cur); cur = future.pop(); return cur; },
      canUndo() { return past.length > 0; }, canRedo() { return future.length > 0; },
    };
  }
  return { ACTS, apply, applyAll, parseCommands, history, pitchOf, programOf, cnNum, trackIndex };
});
