// node scripts/music-tests/audio_to_midi.test.js -- audio→MIDI pure parts on synthetic audio: drum rules, pitch tracking, notes, tempo, assembly
const A = require('../../renderer/src/music/audio_to_midi.js');
const M = require('../../renderer/src/music/midi_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const SR = 22050; let seed = 11; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
function mix(len) { return new Float32Array(Math.floor(SR * len)); }
function addKick(x, t) { const o = Math.floor(t * SR); for (let i = 0; i < SR * 0.25 && o + i < x.length; i++) { const tt = i / SR; x[o + i] += 0.8 * Math.exp(-tt * 18) * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-tt * 40)) * tt); } }
function addSnare(x, t) { const o = Math.floor(t * SR); for (let i = 0; i < SR * 0.2 && o + i < x.length; i++) { const tt = i / SR; x[o + i] += 0.5 * Math.exp(-tt * 22) * (rnd() * 1.6 + 0.4 * Math.sin(2 * Math.PI * 190 * tt)); } }
function addHat(x, t, len) { const o = Math.floor(t * SR); let p = 0; for (let i = 0; i < SR * len && o + i < x.length; i++) { const tt = i / SR, n = rnd(); const hp = n - p; p = n; x[o + i] += 0.5 * Math.exp(-tt * (len < 0.1 ? 60 : 9)) * hp * 2; } }
// 120 bpm 四四拍兩小節:底鼓在 1、3 拍,小鼓在 2、4 拍,閉踩鑔每八分音符
const dr = mix(4.2); for (let b = 0; b < 8; b++) { const t = 0.1 + b * 0.5; if (b % 2 === 0) addKick(dr, t); else addSnare(dr, t); addHat(dr, t + 0.25, 0.05); }
const hits = A.drumHits(dr, SR); const by = (n) => hits.filter((h) => h.note === n).length;
check('drums: finds the hits (8 beats + 8 off-beat hats, at least 12 of 16)', hits.length >= 12 && hits.length <= 20, hits.length);
check('drums: kicks are classified as bass drum (36), at least 3 of 4', by(36) >= 3, hits.map((h) => h.note).join());
check('drums: snares are classified as snare (38), at least 3 of 4', by(38) >= 3, hits.map((h) => h.note).join());
check('drums: hats are classified as closed hat (42), at least 5 of 8', by(42) >= 5, hits.map((h) => h.note).join());
const tempo = A.estimateTempo(hits.filter((h) => h.note === 36 || h.note === 38).map((h) => h.t));
check('tempo: 8 beats of 0.5 s are read as 120 bpm (or its fold)', Math.abs(tempo.bpm - 120) <= 3, tempo);
// 單音旋律:C4 E4 G4 C5,每個 0.4 秒,中間有間隙
const mel = mix(2.0); [[60, 0.1], [64, 0.55], [67, 1.0], [72, 1.45]].forEach(([n, t]) => { const f = 440 * Math.pow(2, (n - 69) / 12), o = Math.floor(t * SR); for (let i = 0; i < SR * 0.4; i++) { const tt = i / SR; mel[o + i] += 0.4 * Math.min(1, tt / 0.02) * Math.min(1, (0.4 - tt) / 0.03) * (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt)); } });
const tr = A.pitchTrack(mel, SR); const notes = A.framesToNotes(tr);
check('pitch: four notes with the right pitches', notes.length === 4 && notes.map((n) => n.n).join() === '60,64,67,72', notes.map((n) => n.n));
check('pitch: onsets within 40 ms and lengths about 0.4 s', notes.every((n, i) => Math.abs(n.t - [0.1, 0.55, 1.0, 1.45][i]) < 0.04 && Math.abs(n.d - 0.4) < 0.08), notes.map((n) => [n.t.toFixed(2), n.d.toFixed(2)]));
check('pitch: silence gives no notes', A.framesToNotes(A.pitchTrack(mix(1), SR)).length === 0);
check('labels: instrument label → GM program, unknown → null', A.labelToProgram('Acoustic guitar') === 25 && A.labelToProgram('Violin, fiddle') === 40 && A.labelToProgram('Electric guitar') === 27 && A.labelToProgram('Piano') === 0 && A.labelToProgram('Dishes') === null);
check('range fallback: low → bass, mid → piano, high → lead', A.rangeProgram([{ n: 36 }]) === 33 && A.rangeProgram([{ n: 55 }]) === 0 && A.rangeProgram([{ n: 70 }]) === 80);
const built = A.buildSong({ drums: hits, bass: [{ t: 0.1, d: 0.4, n: 36, v: 90 }, { t: 0.6, d: 0.4, n: 43, v: 90 }], vocals: notes, other: [{ name: '吉他', label: 'Acoustic guitar', notes: [{ t: 0.1, d: 0.5, n: 52, v: 80 }] }] }, { bpm: 120 });
check('buildSong: tracks for vocals, other, bass, drums with the right programs', built.song.tracks.map((t) => t.name).join() === '人聲(旋律),吉他,貝斯,鼓' && built.song.tracks[1].program === 25 && built.song.tracks[3].drum, built.song.tracks.map((t) => t.name));
check('buildSong: quantized onsets land on the grid and survive a MIDI round trip', built.song.tracks[0].notes.every((n) => n.t % 120 === 0) && M.parse(M.write(built.song)).tracks.length === 4, built.song.tracks[0].notes.map((n) => n.t));
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
