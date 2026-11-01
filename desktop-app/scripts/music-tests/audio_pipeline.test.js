// node scripts/music-tests/audio_pipeline.test.js -- 音訊轉 MIDI 流程:假分軌器、假轉譜器、假分類器、分段、續跑、中斷
const P = require('../../renderer/src/music/audio_pipeline.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const SR = 22050; let seed = 5; const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
const LEN = 20; const x = new Float32Array(SR * LEN);
// 旋律:每 0.5 秒一個音,C4 E4 G4 C5 循環,每個 0.35 秒
const seq = [60, 64, 67, 72]; for (let i = 0; i < LEN * 2 - 2; i++) { const n = seq[i % 4], f = 440 * Math.pow(2, (n - 69) / 12), o = Math.floor((0.1 + i * 0.5) * SR); for (let k = 0; k < SR * 0.35; k++) { const tt = k / SR; x[o + k] += 0.4 * Math.min(1, tt / 0.02) * Math.min(1, (0.35 - tt) / 0.03) * (Math.sin(2 * Math.PI * f * tt) + 0.3 * Math.sin(4 * Math.PI * f * tt)); } }
(async () => {
  const input = { left: x, right: x, sampleRate: SR };
  // 1. 沒有分軌器:整個混音單音追蹤,誠實列出跳過的部分,分三段以上
  const prog = []; const r1 = await P.run(input, { bpm: 120, onProgress: (p) => prog.push(p) });
  check('no separator: one mono track with the melody, many notes across chunks', r1.song.tracks.length === 1 && r1.song.tracks[0].notes.length >= 36, r1.song.tracks.map((t) => t.notes.length));
  check('no separator: report says what was skipped', r1.report.skipped.some((s) => /沒有分軌模型/.test(s)) && r1.report.skipped.some((s) => /不保證準確/.test(s)), r1.report.skipped);
  check('chunks: 20 s in 7.8 s segments = 3 chunks, progress reported', r1.report.chunks === 3 && prog.filter((p) => p.chapter === '轉譜').length === 3, r1.report);
  const ts = r1.song.tracks[0].notes.map((n) => n.t); check('chunks: no duplicated or lost notes at the segment seams', new Set(ts).size === ts.length, ts.length);
  // 2. 假分軌器:吉他軌給旋律,貝斯軌給旋律降八度的複本,鼓軌靜音
  const sepCalls = []; const separator = async (c) => { sepCalls.push(c.left.length); const z = new Float32Array(c.left.length); return { drums: z, bass: z, other: c.left, vocals: z }; };
  const store = new Map(); const st = { get: async (k) => store.get(k) || null, set: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } };
  const r2 = await P.run(input, { bpm: 120, separator, store: st, classifier: async () => 'Acoustic guitar' });
  check('separator: other stem gets a guitar program from the classifier label', r2.song.tracks.length === 1 && r2.song.tracks[0].program === 25 && r2.report.stems[0].label === 'Acoustic guitar', r2.report);
  check('separator: silent drum/bass/vocal stems give no tracks', r2.song.tracks.every((t) => !t.drum));
  // 3. 續跑:同一首再跑,分軌器不再被呼叫
  const n0 = sepCalls.length; const r3 = await P.run(input, { bpm: 120, separator, store: st, classifier: async () => 'Acoustic guitar' });
  check('resume: second run uses stored chunk results and never calls the separator', sepCalls.length === n0 && r3.report.resumed === 3 && r3.song.tracks[0].notes.length === r2.song.tracks[0].notes.length, [sepCalls.length, n0, r3.report.resumed]);
  // 4. 中斷
  const sig = { aborted: false }; let err = null; try { await P.run(input, { signal: sig, separator: async (c) => { sig.aborted = true; return { other: c.left }; } }); } catch (e) { err = e; }
  check('abort: stops after the current chunk and tells the resume id', err && err.aborted && /^a2m:/.test(err.resumeId), err && err.message);
  // 5. 分類器對不到 GM 或丟錯:退回音域規則並寫明
  const r5 = await P.run(input, { bpm: 120, separator, classifier: async () => 'Dishes' });
  check('classifier miss: falls back to range rule and says so', r5.song.tracks[0].program === 80 && r5.report.skipped.some((s) => /對不到 GM/.test(s)), r5.report.skipped);
  const r6 = await P.run(input, { bpm: 120, separator, classifier: async () => { throw new Error('boom'); } });
  check('classifier error: falls back and reports the error text', r6.report.skipped.some((s) => /boom/.test(s)));
  // 6. 假轉譜器:多音轉譜結果有被收進去
  const r7 = await P.run(input, { bpm: 120, separator: async (c) => ({ guitar: c.left, piano: c.left }), stems: ['guitar', 'piano'], transcriber: async (m, sr, s) => [{ t: 1, d: 0.5, n: s === 'guitar' ? 52 : 60, v: 80 }] });
  check('transcriber: guitar and piano tracks with fixed programs, one note per chunk', r7.song.tracks.length === 2 && r7.song.tracks[0].program === 25 && r7.song.tracks[1].program === 0 && r7.song.tracks[0].notes.length === 3, r7.song.tracks.map((t) => [t.program, t.notes.length]));
  check('helpers: resample length and fingerprint stability', P.resample(x, SR, 11025).length === Math.floor(x.length / 2) && P.fingerprint(x, SR) === P.fingerprint(x.slice(), SR));
  console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
})();
