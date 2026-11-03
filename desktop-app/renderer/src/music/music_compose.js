// 音樂領域階段 3:AI 創作(程式決定結構與音符,模型只做封閉選擇題:風格、調、速度、和弦進行編號)。
// 做法(由上而下切細,最後才出音符):風格範本 → 段落結構 → 每段和弦進行(從範本挑,程式驗證調內)→ 旋律(節奏型範本＋和弦音約束)→ 貝斯／和弦伴奏／鼓(範本)→ 配器(GM 音色)。
// 全程用有種子的亂數:同樣的參數產生同樣的曲子;檢查失敗(音域、跳進、空小節)自動換種子重來,最後仍失敗就退回最保守的版本(不丟錯給使用者)。
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./midi_core.js')); else root.FaMidiCompose = factory(root.FaMidi || (typeof FaMidi !== 'undefined' ? FaMidi : undefined)); })(typeof self !== 'undefined' ? self : this, function (M) {
  'use strict';
  const PPQ = 480;
  const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];
  const KEYS = { C: 0, 'C#': 1, Db: 1, D: 2, Eb: 3, E: 4, F: 5, 'F#': 6, Gb: 6, G: 7, Ab: 8, A: 9, Bb: 10, B: 11 };
  // 和弦進行:[級數(0 起算), 和弦性質] 'M' 大三、'm' 小三、'7' 屬七、'm7'、'M7'、'd' 減三;minor 代表用自然小調的音階
  const P = (x) => x.map((c) => ({ d: c[0], q: c[1] }));
  // 鼓型:每 16 分音符一格(16 格＝一小節 4/4),k 底鼓 s 小鼓 h 閉踩 o 開踩 t 通鼓 c 鈸;音高對應 GM 鼓組
  const DRUM_NOTE = { k: 36, s: 38, h: 42, o: 46, t: 45, c: 49, r: 51 };
  const STYLES = {
    pop: { name: '流行', tempo: [90, 120], mode: 'major', timesig: [4, 4], progs: [P([[0, 'M'], [4, 'M'], [5, 'm'], [3, 'M']]), P([[0, 'M'], [5, 'm'], [3, 'M'], [4, 'M']]), P([[5, 'm'], [3, 'M'], [0, 'M'], [4, 'M']])], inst: { lead: 80, chord: 0, bass: 33 }, drum: ['k...h...s...h...'.replace(/\./g, '.'), 'k.h.s.h.k.h.s.h.'], bass: 'root8', melody: ['q q q q', 'e e q e e q', 'q e e q q'] },
    rock: { name: '搖滾', tempo: [110, 150], mode: 'major', timesig: [4, 4], progs: [P([[0, 'M'], [3, 'M'], [4, 'M'], [3, 'M']]), P([[0, 'M'], [6, 'M'], [3, 'M'], [0, 'M']])], inst: { lead: 29, chord: 30, bass: 34 }, drum: ['k.h.s.h.k.h.s.h.'.replace(/h/g, 'h'), 'k.hhs.hhk.hhs.hh'], bass: 'root8', melody: ['e e e e q q', 'q q e e q', 'e e q e e q'] },
    jazz: { name: '爵士', tempo: [100, 160], mode: 'major', timesig: [4, 4], progs: [P([[1, 'm7'], [4, '7'], [0, 'M7'], [0, 'M7']]), P([[0, 'M7'], [5, 'm7'], [1, 'm7'], [4, '7']])], inst: { lead: 65, chord: 0, bass: 32 }, drum: ['r..rr..rr..rr..r', 'r..rr..rr..rr.sr'], bass: 'walk', melody: ['e e e e q q', 'q e e q e e', 'e e q q q'] },
    blues: { name: '藍調', tempo: [70, 110], mode: 'major', timesig: [4, 4], progs: [P([[0, '7'], [0, '7'], [0, '7'], [0, '7'], [3, '7'], [3, '7'], [0, '7'], [0, '7'], [4, '7'], [3, '7'], [0, '7'], [4, '7']])], inst: { lead: 27, chord: 18, bass: 33 }, drum: ['k..hs..hk..hs..h'], bass: 'walk', melody: ['e e q q q', 'q q e e q'] },
    waltz: { name: '圓舞曲', tempo: [120, 180], mode: 'major', timesig: [3, 4], progs: [P([[0, 'M'], [4, 'M'], [0, 'M'], [3, 'M']]), P([[0, 'M'], [3, 'M'], [4, '7'], [0, 'M']])], inst: { lead: 40, chord: 48, bass: 42 }, drum: null, bass: 'oompah', melody: ['q q q', 'q e e q', 'h q'] },
    folk: { name: '民謠', tempo: [80, 110], mode: 'major', timesig: [4, 4], progs: [P([[0, 'M'], [3, 'M'], [0, 'M'], [4, 'M']]), P([[0, 'M'], [4, 'M'], [5, 'm'], [3, 'M']])], inst: { lead: 73, chord: 24, bass: 32 }, drum: null, bass: 'root4', melody: ['q q q q', 'q e e q q', 'h q q'] },
    lofi: { name: '低傳真', tempo: [70, 90], mode: 'minor', timesig: [4, 4], progs: [P([[1, 'm7'], [4, '7'], [0, 'M7'], [5, 'm7']]), P([[0, 'm7'], [3, 'm7'], [6, 'M7'], [2, 'M7']])], inst: { lead: 4, chord: 4, bass: 33 }, drum: ['k..h..s.k.h.s..h'.slice(0, 16), 'k...h..sk.k.h.s.'], bass: 'root4', melody: ['q e e h', 'e e q q q', 'h q q'] },
    edm: { name: '電子舞曲', tempo: [120, 135], mode: 'minor', timesig: [4, 4], progs: [P([[0, 'm'], [5, 'M'], [2, 'M'], [6, 'M']]), P([[5, 'M'], [2, 'M'], [6, 'M'], [0, 'm']])], inst: { lead: 81, chord: 90, bass: 38 }, drum: ['k...k...k...k...', 'k...k.h.k...k.hs'], bass: 'root8', melody: ['e e e e e e e e', 'q e e q q', 'e e q e e q'] },
    classical: { name: '古典', tempo: [76, 112], mode: 'major', timesig: [4, 4], progs: [P([[0, 'M'], [3, 'M'], [4, 'M'], [0, 'M']]), P([[0, 'M'], [5, 'm'], [3, 'M'], [4, '7']])], inst: { lead: 40, chord: 48, bass: 42 }, drum: null, bass: 'root4', melody: ['q e e q q', 'e e e e q q', 'h q q'] },
  };
  const ALIAS = { 流行: 'pop', 抒情: 'pop', 搖滾: 'rock', 爵士: 'jazz', 藍調: 'blues', 圓舞曲: 'waltz', 華爾滋: 'waltz', 三拍: 'waltz', 民謠: 'folk', 吉他: 'folk', 低傳真: 'lofi', lofi: 'lofi', 放鬆: 'lofi', 電子: 'edm', 舞曲: 'edm', 古典: 'classical', 巴洛克: 'classical' };
  const STRUCT = { short: ['A', 'B'], song: ['前奏', '主歌', '副歌', '主歌', '副歌', '尾奏'] };

  function rng(seed) { let a = (seed >>> 0) || 1; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
  const pick = (r, arr) => arr[Math.floor(r() * arr.length) % arr.length];
  const DUR = { w: 4, h: 2, q: 1, e: 0.5, s: 0.25 };

  function chordTones(root, q) { // 回傳相對 root 的半音(0 起算)
    return { M: [0, 4, 7], m: [0, 3, 7], '7': [0, 4, 7, 10], m7: [0, 3, 7, 10], M7: [0, 4, 7, 11], d: [0, 3, 6] }[q] || [0, 4, 7];
  }
  function scaleOf(key, mode) { const base = KEYS[key] == null ? 0 : KEYS[key]; return { base, steps: mode === 'minor' ? MINOR : MAJOR }; }
  function chordRoot(sc, d) { return sc.base + sc.steps[((d % 7) + 7) % 7]; }
  function inScale(sc, pc) { return sc.steps.indexOf(((pc - sc.base) % 12 + 12) % 12) >= 0; }

  // 程式檢查:調內和弦(根音在音階內)、旋律音域與最大跳進、每小節都有音
  function validate(song, info) {
    const problems = []; const lead = song.tracks[0]; const per = info.beatsPerBar * song.ppq;
    if (!lead || !lead.notes.length) return ['沒有旋律'];
    const lo = Math.min.apply(null, lead.notes.map((n) => n.n)), hi = Math.max.apply(null, lead.notes.map((n) => n.n));
    if (lo < 55 || hi > 91) problems.push('旋律音域超出範圍 ' + lo + '-' + hi);
    for (let i = 1; i < lead.notes.length; i++) if (Math.abs(lead.notes[i].n - lead.notes[i - 1].n) > 9) { problems.push('第 ' + i + ' 個音跳進超過九個半音'); break; }
    const bars = new Set(lead.notes.map((n) => Math.floor(n.t / per))); let empty = 0; for (let b = 0; b < info.bars; b++) if (!bars.has(b) && info.leadBars.has(b)) empty++;
    if (empty) problems.push(empty + ' 個小節沒有旋律');
    info.chords.forEach((c, i) => { if (!inScale(info.scale, c.root)) problems.push('第 ' + (i + 1) + ' 個和弦根音不在調內'); });
    return problems;
  }

  function build(o, seed) {
    const st = STYLES[o.style]; const r = rng(seed); const sc = scaleOf(o.key, st.mode);
    const [tn, td] = st.timesig; const beatsPerBar = tn * (4 / td); const bars = o.bars;
    const prog = st.progs[o.progression % st.progs.length];
    let song = M.emptySong(); song.title = o.title || (st.name + '・' + o.key); song.tempos = [{ t: 0, bpm: o.tempo }]; song.timesig = { n: tn, d: td };
    song = M.addTrack(song, '旋律', Number.isInteger(o.lead) ? o.lead : st.inst.lead); song = M.addTrack(song, '和弦', st.inst.chord); song = M.addTrack(song, '貝斯', st.inst.bass); if (st.drum) song = M.addTrack(song, '鼓', 0, true);
    const chords = [], leadBars = new Set(); const add = (ti, t, d, n, v) => { song = M.addNote(song, ti, { t: Math.round(t * PPQ), d: Math.max(1, Math.round(d * PPQ)), n, v }); };
    const sections = []; { const names = bars >= 16 ? STRUCT.song : STRUCT.short; const per = Math.max(2, Math.floor(bars / names.length)); names.forEach((nm, i) => sections.push({ name: nm, from: i * per, to: i === names.length - 1 ? bars : (i + 1) * per })); }
    let prev = 72 + sc.base % 12 - 12 * (sc.base % 12 > 5 ? 1 : 0); prev = Math.max(62, Math.min(76, prev));
    for (let b = 0; b < bars; b++) {
      const ch = prog[b % prog.length]; const root = chordRoot(sc, ch.d), tones = chordTones(root, ch.q); chords.push({ root, q: ch.q });
      const t0 = b * beatsPerBar; const sec = sections.find((s) => b >= s.from && b < s.to) || sections[0]; const intro = sec.name === '前奏' || sec.name === '尾奏';
      // 和弦伴奏:每小節一個和弦(低八度的和弦音),前奏／尾奏力度小
      const cv = intro ? 60 : 72; tones.forEach((tn2) => add(1, t0, beatsPerBar - 0.1, 48 + ((root % 12) + tn2) % 12 + 12, cv));
      // 貝斯
      const bn = 36 + (root % 12); if (st.bass === 'root8') for (let i = 0; i < beatsPerBar * 2; i++) add(2, t0 + i * 0.5, 0.45, bn + (i % 4 === 3 ? 7 * (r() < 0.3 ? 1 : 0) : 0), 85);
      else if (st.bass === 'walk') for (let i = 0; i < beatsPerBar; i++) add(2, t0 + i, 0.95, bn + [0, tones[1 % tones.length], tones[2 % tones.length], tones[1 % tones.length]][i % 4] % 12 * (i ? 1 : 0), 80);
      else if (st.bass === 'oompah') { add(2, t0, 0.95, bn, 85); for (let i = 1; i < beatsPerBar; i++) add(2, t0 + i, 0.5, bn + 7, 60); }
      else for (let i = 0; i < beatsPerBar; i++) add(2, t0 + i, 0.95, bn, i === 0 ? 90 : 70);
      // 鼓:每小節重複同一型(前奏只有踩鑔)
      if (st.drum) { const pat = st.drum[(o.drumIdx | 0) % st.drum.length]; for (let i = 0; i < 16 * (beatsPerBar / 4); i++) { const c = pat[i % pat.length]; if (c === '.' || (intro && c !== 'h' && c !== 'r')) continue; add(3, t0 + i * 0.25, 0.2, DRUM_NOTE[c] || 42, c === 'k' || c === 's' ? 100 : 70); } }
      // 旋律:前奏第一小節與尾奏最後一小節留白;其餘依節奏型,強拍用和弦音、弱拍用調內音級步進
      if (b === 0 && sec.name === '前奏' && bars >= 16) continue; if (b === bars - 1 && bars >= 16) { add(0, t0, beatsPerBar, tones.map((x) => 60 + ((root + x) % 12))[0] + 12 * 0, 90); leadBars.add(b); prev = 60 + (root % 12); continue; }
      const rh = pick(r, st.melody).split(' '); let t = t0, total = 0; rh.forEach((x) => { total += DUR[x]; }); const scale = beatsPerBar / total;
      rh.forEach((x, i) => {
        const d = DUR[x] * scale; const strong = Math.abs(t - Math.round(t)) < 1e-6 && (Math.round(t - t0)) % 2 === 0;
        let cand = []; for (let n = 60; n <= 84; n++) { const pc = ((n - root) % 12 + 12) % 12; if (strong ? tones.indexOf(pc) >= 0 : inScale(sc, n)) cand.push(n); }
        cand = cand.filter((n) => Math.abs(n - prev) <= 5).sort((a, b2) => Math.abs(a - prev) - Math.abs(b2 - prev)); // 取離上個音最近的幾個,有點隨機
        if (cand.length > 1 && r() < 0.8) cand = cand.filter((x) => x !== prev); // 少重複同一個音
        const n = cand.length ? cand[Math.min(cand.length - 1, Math.floor(r() * r() * 3))] : prev; add(0, t, d * 0.95, n, strong ? 92 : 80); prev = n; t += d;
      });
      leadBars.add(b);
    }
    return { song, info: { bars, beatsPerBar, chords, scale: sc, leadBars, sections } };
  }

  // 主要入口:o = { style, key, tempo, bars, progression, seed, title };缺的欄位用風格預設。檢查失敗換種子重來(最多 12 次),都失敗就回最後一次並附 warnings
  function compose(o) {
    o = o || {}; const style = STYLES[o.style] ? o.style : 'pop'; const st = STYLES[style];
    const opts = { style, key: KEYS[o.key] != null ? o.key : 'C', tempo: Math.max(40, Math.min(220, Number(o.tempo) || Math.round((st.tempo[0] + st.tempo[1]) / 2))), bars: Math.max(4, Math.min(64, Number(o.bars) || 16)), progression: Number(o.progression) || 0, title: o.title, lead: Number.isInteger(o.lead) && o.lead >= 0 && o.lead <= 127 ? o.lead : undefined, drumIdx: Math.max(0, o.drumIdx | 0) };
    let seed = Number(o.seed) || 1, last = null, tries = 0;
    for (; tries < 12; tries++, seed++) { last = build(opts, seed); const problems = validate(last.song, last.info); if (!problems.length) return { song: M.validate(last.song), style, options: opts, seed, tries: tries + 1, warnings: [], sections: last.info.sections, styleNote: o.styleNote || '' }; last.problems = problems; }
    return { song: M.validate(last.song), style, options: opts, seed, tries, warnings: last.problems, sections: last.info.sections, styleNote: o.styleNote || '' };
  }
  // 中文描述 → 選擇題的答案(風格、調、速度、小節數);沒說的留空讓 compose 用預設
  // 九種範本以外的風格、作曲家、樂派:對到最接近的範本,並在結果裡明講(styleNote);完全對不到時用流行並明講,不讓路由放棄
  const CLOSE = { 貝多芬: 'classical', 莫札特: 'classical', 巴哈: 'classical', 蕭邦: 'classical', 李斯特: 'classical', 舒伯特: 'classical', 舒曼: 'classical', 布拉姆斯: 'classical', 海頓: 'classical', 韓德爾: 'classical', 韋瓦第: 'classical', 德布西: 'classical', 拉赫曼尼諾夫: 'classical', 柴可夫斯基: 'classical', 孟德爾頌: 'classical', 浪漫樂派: 'classical', 古典樂派: 'classical', 交響: 'classical', 奏鳴曲: 'classical', 協奏曲: 'classical', 小夜曲: 'classical', 月光: 'classical', 歡樂頌: 'classical', 重金屬: 'rock', 金屬: 'rock', 龐克: 'rock', 硬搖滾: 'rock', 另類: 'rock', 搖擺: 'jazz', 波薩諾瓦: 'jazz', 森巴: 'jazz', 拉丁: 'jazz', 鄉村: 'folk', 民俗: 'folk', 嘻哈: 'lofi', 饒舌: 'lofi', 咖啡廳: 'lofi', 電音: 'edm', 浩室: 'edm', 鐵克諾: 'edm', 流行樂: 'pop', 情歌: 'pop', 兒歌: 'folk', 進行曲: 'rock' };
  const CLOSE_EN = { beethoven: 'classical', mozart: 'classical', bach: 'classical', chopin: 'classical', schubert: 'classical', debussy: 'classical', metal: 'rock', punk: 'rock', swing: 'jazz', bossa: 'jazz', latin: 'jazz', country: 'folk', 'hip hop': 'lofi', hiphop: 'lofi', house: 'edm', techno: 'edm', trance: 'edm', symphony: 'classical', sonata: 'classical' };
  // 知名作品／系列的「特徵查表」:只有調、調式、速度、樂器、和弦進行這類事實,不含旋律(不抄作品);值是整理出來的常見印象,不一定逐字精確。
  // 用途:(1) 沒有 AI 時補風格／調／速度;(2) 有 AI 時當「作品特徵」附在需求後面,AI 才知道這個名字代表什麼(選和聲、調式、樂器、情緒時參考)。
  const WORKS = [
    { name: '歌劇魅影', keys: ['歌劇魅影', 'phantom of the opera', 'phantom'], style: 'classical', key: 'D', mode: 'minor', tempo: 120, hint: '歌劇魅影:D 小調、戲劇性、教堂管風琴為主加弦樂與合唱感,低音持續音與下行線條,和弦常見 i VI III VII、i iv V' },
    { name: '卡農', keys: ['卡農', 'canon in d', 'pachelbel', 'canon'], style: 'classical', key: 'D', mode: 'major', tempo: 70, hint: '帕海貝爾卡農:D 大調、弦樂(小提琴、大提琴)、低音反覆 8 個音,和弦進行 I V vi iii IV I IV V(搖滾版常把節奏加快、加電吉他與鼓)' },
    { name: 'Final Fantasy', keys: ['final fantasy', '最終幻想', '太空戰士', 'ff7', 'ff10'], style: 'classical', key: 'C', mode: 'major', tempo: 110, hint: 'Final Fantasy:遊戲配樂風,開頭常用琶音(豎琴或鋼琴)上行下行,管弦樂編制、史詩感,和弦常見 I V vi IV、vi IV I V 並加入調外的轉折' }
  ];
  // 查過網路學到的作品(使用者機器上的離線目錄):由 music_work_learn 驗證後存下,下次直接查表,不必再上網
  let LEARNED = []; function setLearnedWorks(l) { LEARNED = Array.isArray(l) ? l.filter((w) => w && Array.isArray(w.keys) && w.keys.length) : []; }
  function workOf(text) { const low = String(text || '').toLowerCase(); return WORKS.concat(LEARNED).filter((w) => w.keys.some((k) => low.indexOf(String(k).toLowerCase()) >= 0)); }
  // 程式核對模型從網路查到的作品特徵(封閉欄位:調、調式、速度、風格都在範圍內;出處網址必填;旋律不收):回傳 { work } 或 { error }
  function validateWork(w) {
    w = w || {}; const str = (x, n) => String(x == null ? '' : x).replace(/\s+/g, ' ').trim().slice(0, n); const name = str(w.name, 40); if (!name) return { error: '缺作品名稱' };
    if (WORKS.some((x) => x.keys.some((k) => k.toLowerCase() === name.toLowerCase()) || x.name.toLowerCase() === name.toLowerCase())) return { error: '「' + name + '」程式已經內建,不必再記' };
    const key = str(w.key, 3); if (KEYS[key] == null) return { error: '調要是 C、D、Eb、F# 這類主音(你給了「' + key + '」)' };
    const mode = w.mode === 'minor' || w.mode === 'major' ? w.mode : ''; if (!mode) return { error: 'mode 要是 major 或 minor' };
    const tempo = Math.round(Number(w.tempo)); if (!(tempo >= 40 && tempo <= 220)) return { error: '速度要在 40 到 220 之間(你給了 ' + w.tempo + ')' };
    const style = str(w.style, 20); if (!STYLES[style]) return { error: '風格要是 ' + Object.keys(STYLES).join('、') + ' 其中之一' };
    const hint = str(w.hint, 300); if (hint.length < 10) return { error: 'hint 至少寫一句話(調、樂器、和弦進行等事實,不要寫旋律)' };
    const src = str(w.source_url, 300); if (!/^https?:\/\//i.test(src)) return { error: '要附出處網址(http 或 https 開頭),沒有查過就不要記' };
    const keys = [name].concat(Array.isArray(w.aliases) ? w.aliases : []).map((x) => str(x, 40)).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).slice(0, 8);
    return { work: { name, keys, style, key, mode, tempo, hint: name + ':' + hint, source: src, learned: true } };
  }

  function workHints(text) { const ws = workOf(text); return ws.length ? '\n作品特徵(程式查表,供參考,只是風格事實不是旋律):' + ws.map((w) => w.hint).join(';') : ''; }
  function parseRequest(text) {
    text = String(text || ''); const out = {}; for (const k of Object.keys(ALIAS)) if (text.indexOf(k) >= 0) { out.style = ALIAS[k]; break; }
    if (!out.style) {
      const low = text.toLowerCase(); let hit = null; for (const k of Object.keys(CLOSE)) if (text.indexOf(k) >= 0) { hit = [k, CLOSE[k]]; break; } if (!hit) for (const k of Object.keys(CLOSE_EN)) if (low.indexOf(k) >= 0) { hit = [k, CLOSE_EN[k]]; break; }
      if (hit) { out.style = hit[1]; out.styleNote = '沒有「' + hit[0] + '」專屬的範本,用最接近的「' + STYLES[hit[1]].name + '」範本(' + STYLES[hit[1]].progs.length + ' 種和弦進行、速度 ' + STYLES[hit[1]].tempo[0] + '–' + STYLES[hit[1]].tempo[1] + ');旋律是程式依範本產生的,不是' + hit[0] + '的真實作品'; }
      else if (/風格|style|式的|派|樂風|味道/i.test(text)) { out.styleNote = '沒有對得上的風格範本,用「流行」範本;想換可以指定 pop、rock、jazz、blues、waltz、folk、lofi、edm、classical'; }
    }
    const ws = workOf(text); if (ws.length) { const w = ws[0]; if (!out.style) { out.style = w.style; out.styleNote = '沒有「' + ws.map((x) => x.name).join('、') + '」專屬的範本,用查表整理出的特徵(' + w.key + (w.mode === 'minor' ? ' 小調' : ' 大調') + '、約 ' + w.tempo + ' 拍/分)配最接近的「' + STYLES[w.style].name + '」範本;旋律是程式依範本產生的,不是真實作品'; out.fromWork = w.name; } }
    const m = /([A-G][#b]?)\s*(?:大調|小調|調)?/.exec(text); if (m && KEYS[m[1]] != null) out.key = m[1];
    if (ws.length && !out.key && out.fromWork) out.key = ws[0].key; if (ws.length && out.fromWork) { out.workTempo = ws[0].tempo; out.workMode = ws[0].mode; }
    const t = /(\d{2,3})\s*(?:bpm|拍\/分|拍每分)/i.exec(text) || /速度\D{0,3}(\d{2,3})/.exec(text); if (t) out.tempo = Number(t[1]);
    const b = /(\d{1,2})\s*小節/.exec(text); if (b) out.bars = Number(b[1]);
    if (out.workTempo && !out.tempo && !/快|慢/.test(text)) out.tempo = out.workTempo; delete out.workTempo;
    if (/快/.test(text) && !out.tempo) out.fast = true; if (/慢/.test(text) && !out.tempo) out.slow = true;
    const stl = STYLES[out.style]; if (stl && out.fast) out.tempo = stl.tempo[1]; if (stl && out.slow) out.tempo = stl.tempo[0]; delete out.fast; delete out.slow;
    return out;
  }
  const choices = () => Object.keys(STYLES).map((k) => ({ id: k, name: STYLES[k].name, tempo: STYLES[k].tempo, progressions: STYLES[k].progs.length, mode: STYLES[k].mode }));
  return { WORKS, setLearnedWorks, validateWork, workOf, workHints, STYLES, KEYS, chordTones, compose, parseRequest, validate, choices };
});
