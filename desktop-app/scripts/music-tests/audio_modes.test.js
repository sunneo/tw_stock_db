// node scripts/music-tests/audio_modes.test.js -- 「簡化」「和弦」模式與方法清單:假轉譜器(旋律線 + 和弦)、不重跑模型、完整模式不變
const P = require('../../renderer/src/music/audio_pipeline.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const SR = 22050, LEN = 6;
const x = new Float32Array(SR * LEN); for (let i = 0; i < x.length; i++) x[i] = 0.1 * Math.sin(i * 0.05);
// 假轉譜器:旋律 C5 D5 E5 F5 每 0.5 秒一個,另加每 0.5 秒一組低音和弦 C3 E3 G3 B3 ... 同時發聲(全部段落相對時間)
async function fakeTranscriber(mono, sr) {
  const out = [];
  for (let k = 0; k < Math.floor(LEN / 0.5); k++) {
    const t = k * 0.5; const mel = [72, 74, 76, 77][k % 4];
    out.push({ t, d: 0.45, n: mel, v: 90 });
    [48, 52, 55, 59].forEach((n) => out.push({ t: t + 0.01, d: 0.45, n, v: 50 }));
  }
  return out;
}
(async () => {
  const input = { left: x, right: x, sampleRate: SR };
  const full = await P.run(input, { bpm: 120, transcriber: fakeTranscriber });
  const fullNotes = full.song.tracks.reduce((s, t) => s + t.notes.length, 0);
  check('full: no mode methods listed', full.report.methods.length === 0, full.report.methods);
  const mel = await P.run(input, { bpm: 120, transcriber: fakeTranscriber, mode: 'melody' });
  const melNotes = mel.song.tracks.reduce((s, t) => s + t.notes.length, 0);
  check('melody: methods say 只留旋律', mel.report.methods.indexOf('＋只留旋律') >= 0, mel.report.methods);
  check('melody: fewer notes than full', melNotes < fullNotes, [melNotes, fullNotes]);
  check('melody: every kept note is a melody pitch (72..77)', mel.song.tracks.every((t) => t.notes.every((n) => n.n >= 72 && n.n <= 77)), mel.song.tracks.map((t) => t.notes.map((n) => n.n)));
  check('melody: no drum track', mel.song.tracks.every((t) => !t.drum));
  const ch = await P.run(input, { bpm: 120, transcriber: fakeTranscriber, mode: 'chords' });
  const chNotes = ch.song.tracks.reduce((s, t) => s + t.notes.length, 0);
  check('chords: methods say 旋律加和弦', ch.report.methods.indexOf('＋旋律加和弦') >= 0, ch.report.methods);
  check('chords: more notes than melody-only', chNotes > melNotes, [chNotes, melNotes]);
  check('chords: contains chord-tone pitches below the melody', ch.song.tracks.some((t) => t.notes.some((n) => n.n < 72)));
  check('chords: keeps the melody line', ch.song.tracks.some((t) => t.notes.some((n) => n.n >= 72)));
  check('unknown mode falls back to full', (await P.run(input, { bpm: 120, transcriber: fakeTranscriber, mode: 'bogus' })).report.methods.length === 0);
  // 鼓:沒有分軌時用頻譜法在混音上找;簡化模式不留鼓
  const kick = (tt) => 0.9 * Math.exp(-tt * 22) * Math.sin(2 * Math.PI * (55 + 60 * Math.exp(-tt * 40)) * tt);
  const dx = new Float32Array(SR * 8);
  for (let b = 0; b < 16; b += 2) { const o = Math.floor((0.1 + b * 0.5) * SR); for (let i = 0; i < SR * 0.3 && o + i < dx.length; i++) dx[o + i] += kick(i / SR); }
  const dIn = { left: dx, right: dx, sampleRate: SR };
  const dFull = await P.run(dIn, { bpm: 120, transcriber: async () => [] });
  check('drums: no separator, frequency-method drum track added with method label', dFull.report.methods.indexOf('＋鼓軌（頻譜法）') >= 0 && dFull.song.tracks.some((t) => t.drum), dFull.report.methods);
  const dMel = await P.run(dIn, { bpm: 120, transcriber: async () => [], mode: 'melody' });
  check('drums: melody mode keeps no drum track', dMel.song.tracks.every((t) => !t.drum));
  // 分段接縫:65 秒、每秒一個音(第 k 秒的 0.3 處),跨 20 秒段、2 秒重疊,每個音要剛好出現一次
  const LONG = 65, lx = new Float32Array(SR * LONG);
  const grid = async (mono, sr) => { const out = []; for (let t = 0.3; t < mono.length / sr; t += 1) out.push({ t, d: 0.2, n: 60, v: 80 }); return out; };
  const lr = await P.run({ left: lx, right: lx, sampleRate: SR }, { bpm: 120, transcriber: grid, calibrate: false });
  const lts = lr.song.tracks.reduce((s, t) => s.concat(t.notes), []);
  check('seams: 65 s with 20 s segments and 2 s overlap gives each note exactly once', lr.report.chunks === 4 && lts.length === LONG, [lr.report.chunks, lts.length]);
  const starts = new Set(lts.map((n) => n.t)); check('seams: no duplicated note starts', starts.size === lts.length, [starts.size, lts.length]);
  console.log('audio_modes.test: ' + ok + ' ok, ' + bad.length + ' failed');
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
