// node scripts/music-tests/note_postprocess.test.js -- 音符後處理純函式:併回假切、最短音、和弦對齊、旋律線、模式簡化、立體聲反相、起音證據
const NP = require('../../renderer/src/music/note_postprocess.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const near = (a, b, eps) => Math.abs(a - b) <= (eps || 1e-6);
const F = NP.FRAME_SEC;

// 1. 起音證據門檻(邊界)
check('cut: strong onset 0.8 cuts', NP.shouldCutAtOnset({ onset: 0.8, dip: 0, rise: 0 }) === true);
check('cut: onset 0.79 with no dip/rise does not cut', NP.shouldCutAtOnset({ onset: 0.79, dip: 0, rise: 0 }) === false);
check('cut: dip exactly 0.35 cuts', NP.shouldCutAtOnset({ onset: 0.5, dip: 0.35, rise: 0 }) === true);
check('cut: dip 0.34 does not cut', NP.shouldCutAtOnset({ onset: 0.5, dip: 0.34, rise: 0 }) === false);
check('cut: rise 0.3 cuts', NP.shouldCutAtOnset({ onset: 0.5, dip: 0, rise: 0.3 }) === true);
check('cut: no evidence does not cut', NP.shouldCutAtOnset(null) === false);

// 2. 併回假切:同音高、空隙小、沒有明顯起音 → 併成一個音
const evWeak = () => ({ onset: 0.55, dip: 0, rise: 0 });
const evStrong = () => ({ onset: 0.9, dip: 0, rise: 0 });
const split = [{ t: 0.5, d: 0.5, n: 60, v: 80 }, { t: 1.02, d: 0.5, n: 60, v: 90 }];
const joined = NP.joinSplitNotes(split, evWeak);
check('join: weak-onset same-pitch split merged into one', joined.length === 1, joined);
check('join: merged duration spans both, velocity is max', joined.length === 1 && near(joined[0].d, 1.02 + 0.5 - 0.5) && joined[0].v === 90, joined);
check('join: strong onset keeps split', NP.joinSplitNotes(split, evStrong).length === 2);
check('join: gap 0.13 is beyond MAX_JOIN_GAP, not merged', NP.joinSplitNotes([{ t: 0.5, d: 0.5, n: 60, v: 80 }, { t: 1.13, d: 0.5, n: 60, v: 80 }], evWeak).length === 2);
check('join: different pitch never merged', NP.joinSplitNotes([{ t: 0.5, d: 0.5, n: 60, v: 80 }, { t: 1.0, d: 0.5, n: 62, v: 80 }], evWeak).length === 2);
check('join: no evidence function leaves notes as they are', NP.joinSplitNotes(split, null).length === 2);
check('join: dip alone (not onset) also keeps split', NP.joinSplitNotes(split, () => ({ onset: 0.55, dip: 0.5, rise: 0 })).length === 2);

// 3. 和弦對齊:60 毫秒內起點對齊到中間值,結束時間保留
const chord = [{ t: 1.0, d: 1.0, n: 60, v: 80 }, { t: 1.03, d: 1.0, n: 64, v: 80 }, { t: 1.05, d: 1.0, n: 67, v: 80 }];
const al = NP.alignChordOnsets(chord);
check('align: three onsets within 60 ms all move to median 1.03', al.every((x) => near(x.t, 1.03)), al);
check('align: each note keeps its original end time', al.every((x, i) => near(x.t + x.d, chord[i].t + chord[i].d)), al);
check('align: even count uses mean of two middle values', near(NP.alignChordOnsets([{ t: 1, d: 1, n: 1, v: 1 }, { t: 1.02, d: 1, n: 2, v: 1 }, { t: 1.04, d: 1, n: 3, v: 1 }, { t: 1.05, d: 1, n: 4, v: 1 }])[0].t, 1.03));
const far = NP.alignChordOnsets([{ t: 1.0, d: 1, n: 60, v: 80 }, { t: 1.07, d: 1, n: 64, v: 80 }]);
check('align: 70 ms apart stays apart', near(far[0].t, 1.0) && near(far[1].t, 1.07), far);

// 4. 最短音:4 格以下丟掉;4~7 格只有證據明顯才留;8 格以上留
const L = (f) => f * F;
check('min: 3 frames dropped', NP.enforceMinLength([{ t: 0, d: L(3), n: 60, v: 80 }]).length === 0);
check('min: 4 frames kept when no evidence', NP.enforceMinLength([{ t: 0, d: L(4), n: 60, v: 80 }]).length === 1);
check('min: 6 frames kept with no evidence function', NP.enforceMinLength([{ t: 0, d: L(6), n: 60, v: 80 }]).length === 1);
check('min: 6 frames with onset 0.5 dropped', NP.enforceMinLength([{ t: 0, d: L(6), n: 60, v: 80 }], () => ({ onset: 0.5, dip: 0, rise: 0 })).length === 0);
check('min: 6 frames with onset 0.6 kept (boundary)', NP.enforceMinLength([{ t: 0, d: L(6), n: 60, v: 80 }], () => ({ onset: 0.6, dip: 0, rise: 0 })).length === 1);
check('min: 8 frames kept even with weak evidence', NP.enforceMinLength([{ t: 0, d: L(8), n: 60, v: 80 }], () => ({ onset: 0, dip: 0, rise: 0 })).length === 1);

// 5. 旋律線:高音的連續線是頂線(旋律),低音和弦不是
const melLine = [0, 1, 2, 3].map((i) => ({ t: i * 0.5, d: 0.5, n: 72 + (i % 2), v: 80 }));
const bg = [0, 1, 2, 3].map((i) => ({ t: i * 0.5, d: 0.5, n: 48, v: 40 }));
const fl = NP.melodyFlags(melLine.concat(bg));
check('melody: four-note top line flagged', fl.slice(0, 4).every((x) => x === true), fl);
check('melody: low background notes not flagged', fl.slice(4).every((x) => x === false), fl);
check('melody: a single top note alone is not a melody (run < 3)', NP.melodyFlags([{ t: 0, d: 0.5, n: 80, v: 80 }, { t: 0.1, d: 0.5, n: 50, v: 80 }])[0] === false);
const gapLine = [{ t: 0, d: 0.3, n: 70, v: 80 }, { t: 0.3, d: 0.3, n: 72, v: 80 }, { t: 2.0, d: 0.3, n: 74, v: 80 }, { t: 2.3, d: 0.3, n: 76, v: 80 }];
check('melody: gap over MELODY_MAX_GAP breaks the run (only 2 + 2 -> none)', NP.melodyFlags(gapLine).every((x) => x === false), NP.melodyFlags(gapLine));

// 6. 旋律拉高、背景降低(背景只降低力度不高於中位數的音)
const em = NP.emphasizeMelody(melLine.concat([{ t: 0.2, d: 0.2, n: 50, v: 20 }]));
check('emphasize: melody velocity boosted by MELODY_BOOST', em[0].v === Math.round(80 * NP.MELODY_BOOST), em);
check('emphasize: quiet background note lowered', em[4].v < 20, em[4]);

// 7. 模式簡化
const mix = melLine.concat([{ t: 0.0, d: 0.5, n: 48, v: 40 }, { t: 0.01, d: 0.5, n: 52, v: 40 }, { t: 0.02, d: 0.5, n: 55, v: 40 }, { t: 0.03, d: 0.5, n: 60, v: 40 }, { t: 0.04, d: 0.5, n: 64, v: 40 }]);
const mel = NP.simplifyForMode(mix, 'melody');
check('mode melody: only melody notes remain', mel.every((x) => x.n === 72 || x.n === 73), mel.map((x) => x.n));
const chords = NP.simplifyForMode(mix, 'chords');
const chordNotes = chords.filter((x) => !(x.n === 72 || x.n === 73));
check('mode chords: at most CHORD_MAX_VOICES pitches in the chord group', chordNotes.length <= NP.CHORD_MAX_VOICES, chordNotes.map((x) => x.n));
check('mode chords: keeps the melody notes', chords.filter((x) => x.n === 72 || x.n === 73).length === 4);
check('mode full: returns all notes sorted', NP.simplifyForMode(mix, 'full').length === mix.length);
const legatoIn = [{ t: 0, d: 1.0, n: 72, v: 80 }, { t: 0.5, d: 0.5, n: 74, v: 80 }, { t: 1.0, d: 0.5, n: 76, v: 80 }, { t: 1.5, d: 0.5, n: 77, v: 80 }];
const legato = NP.simplifyForMode(legatoIn, 'melody');
check('mode melody: overlap is cut so the line is monophonic', legato.every((x, i) => i + 1 >= legato.length || x.t + x.d <= legato[i + 1].t + 1e-9), legato);

// 8. 立體聲:相關係數夠負 → 取較響的聲道;同相 → 平均
const N = 2000; const a = new Float32Array(N), b = new Float32Array(N);
for (let i = 0; i < N; i++) { a[i] = Math.sin(i / 7) * 0.2; b[i] = -2 * a[i]; }
const sm = NP.stereoToMono(a, b);
check('stereo: strong anti-phase picks the louder channel (not silence)', sm.length === N && near(sm[100], b[100], 1e-6), [sm[100], b[100]]);
const same = new Float32Array(N); for (let i = 0; i < N; i++) same[i] = a[i];
const avg = NP.stereoToMono(a, same);
check('stereo: identical channels average to the same values', near(avg[50], a[50], 1e-6));
const partial = new Float32Array(N); for (let i = 0; i < N; i++) partial[i] = -0.3 * a[i] + 0.19 * Math.sin(i / 3);
let sLR = 0, sLL = 0, sRR = 0; for (let i = 0; i < N; i++) { sLR += a[i] * partial[i]; sLL += a[i] * a[i]; sRR += partial[i] * partial[i]; }
const corrP = sLR / Math.sqrt(sLL * sRR);
check('stereo: precondition correlation is between ANTI_CORR and 0', corrP > NP.ANTI_CORR && corrP < 0, corrP);
const avgP = NP.stereoToMono(a, partial);
check('stereo: correlation above ANTI_CORR averages', near(avgP[10], 0.5 * (a[10] + partial[10]), 1e-6));
check('stereo: no right channel returns left', NP.stereoToMono(a, null) === a);

// 9. 起音證據:由 stitch 結果的矩陣算出 onset / dip / rise
const BINS = 88, FR = 100; const onset = new Float32Array(FR * BINS), note = new Float32Array(FR * BINS);
const bin = 60 - 21; // MIDI 60
onset[20 * BINS + bin] = 0.9;
for (let f = 20; f < 100; f++) note[f * BINS + bin] = 0.9; // 持續音
const st = { onset, note, frames: FR };
const ev = NP.evidenceFromActivations(st)(20 * F, 60);
check('evidence: onset value read at the onset frame', near(ev.onset, 0.9, 1e-6), ev);
check('evidence: sustained note after onset has no rise and no dip', ev.rise < 0.05 && ev.dip < 0.05, ev);
const note2 = new Float32Array(FR * BINS); for (let f = 0; f < 100; f++) note2[f * BINS + bin] = (f >= 17 && f <= 19) ? 0.0 : 0.9; // 起音前先凹陷(起音在 20 格)
const ev2 = NP.evidenceFromActivations({ onset, note: note2, frames: FR })(20 * F, 60);
check('evidence: dip before onset is detected', ev2.dip >= 0.8, ev2);
const note3 = new Float32Array(FR * BINS); for (let f = 0; f < 100; f++) note3[f * BINS + bin] = f >= 23 ? 0.9 : 0.1; // 起音(20 格)後急升,到 23 格已經很高
const ev3 = NP.evidenceFromActivations({ onset: new Float32Array(FR * BINS), note: note3, frames: FR })(20 * F, 60);
check('evidence: rise after onset is detected', ev3.rise >= 0.7, ev3);
check('evidence: out-of-range pitch returns null', NP.evidenceFromActivations(st)(1, 10) === null);

// 10. 組合:慢起音的合成音墊(兩段同音高、起音弱)合成一個音,而且短音規則生效
const pad = [{ t: 1.0, d: 0.4, n: 64, v: 70 }, { t: 1.42, d: 0.6, n: 64, v: 70 }, { t: 3.0, d: 0.02, n: 64, v: 70 }];
const pp = NP.postprocess(pad, { evidenceAt: () => ({ onset: 0.55, dip: 0, rise: 0 }) });
check('postprocess: slow pad with weak onset becomes one note; 0.02 s blip dropped', pp.length === 1 && near(pp[0].d, 1.02), pp);

console.log('note_postprocess.test: ' + ok + ' ok, ' + bad.length + ' failed');
if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
