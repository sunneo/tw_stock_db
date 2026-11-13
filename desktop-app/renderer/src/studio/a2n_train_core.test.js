// node renderer/src/studio/a2n_train_core.test.js -- 音訊轉音符核心：合成資料（確定性）、幀級目標、F1 計算
const A = require('./a2n_train_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }

// 合成：同種子同結果；長度與取值範圍
const c1 = A.synthClip(7), c2 = A.synthClip(7), c3 = A.synthClip(8);
check('synth: same seed gives identical samples', c1.samples.length === A.WIN && c1.samples.every(function (v, i) { return v === c2.samples[i]; }));
check('synth: different seed differs', c1.samples.some(function (v, i) { return v !== c3.samples[i]; }));
check('synth: peak normalized to 0.8', Math.abs(Math.max.apply(null, Array.from(c1.samples).map(Math.abs)) - 0.8) < 1e-4);
check('synth: notes count 1..4, midi 40..84, on<off, inside window', [7, 8, 9, 10, 11, 12, 13, 14, 15, 16].every(function (s) {
  var c = A.synthClip(s), dur = A.WIN / A.SR;
  return c.notes.length >= 1 && c.notes.length <= 4 && c.notes.every(function (n) { return n.midi >= 40 && n.midi <= 84 && n.on < n.off && n.on >= 0 && n.off <= dur; });
}));
// 隨機數：確定性與範圍
var r = A.rngFrom(3), rs = []; for (var k = 0; k < 100; k++) rs.push(r());
check('rng: values in [0,1) and reproducible', rs.every(function (v) { return v >= 0 && v < 1; }) && A.rngFrom(3)() === rs[0]);

// 幀級目標：note 幀落在 [on, off)；onset 落在四捨五入的起音幀
var tg = A.frameTargets([{ midi: 60, on: 0.3, off: 1.0 }], A.FRAMES);
var b60 = 60 - A.LOW, noteFrames = []; for (var f = 0; f < A.FRAMES; f++) if (tg.note[f * A.BINS + b60]) noteFrames.push(f);
check('targets: note frames start at ceil(on*SR/HOP) and end before off', noteFrames[0] === Math.ceil(0.3 * A.SR / A.HOP) && noteFrames[noteFrames.length - 1] === Math.ceil(1.0 * A.SR / A.HOP) - 1, [noteFrames[0], noteFrames[noteFrames.length - 1]]);
var onFrames = []; for (f = 0; f < A.FRAMES; f++) if (tg.onset[f * A.BINS + b60]) onFrames.push(f);
check('targets: exactly one onset frame at round(on*SR/HOP)', onFrames.length === 1 && onFrames[0] === Math.round(0.3 * A.SR / A.HOP), onFrames);
var sumN = 0; for (f = 0; f < tg.note.length; f++) sumN += tg.note[f];
check('targets: only the played bin is set', sumN === noteFrames.length);
check('targets: out-of-range midi ignored', A.frameTargets([{ midi: 10, on: 0.1, off: 0.5 }], A.FRAMES).note.every(function (v) { return v === 0; }));

// 幀級 F1
var truth = new Uint8Array(A.FRAMES * A.BINS); truth[10 * A.BINS + 5] = 1; truth[11 * A.BINS + 5] = 1; truth[50 * A.BINS + 9] = 1;
var perfect = new Float32Array(truth.length); for (var q = 0; q < truth.length; q++) perfect[q] = truth[q] ? 0.9 : 0.01;
var pp = A.prf(perfect, truth, 0.5, 0);
check('prf: perfect prediction gives F1 1', pp.f1 === 1 && pp.tp === 3 && pp.fp === 0 && pp.fn === 0, pp);
var empty = new Float32Array(truth.length);
var pe = A.prf(empty, truth, 0.5, 0);
check('prf: empty prediction gives F1 0 with 3 misses', pe.f1 === 0 && pe.fn === 3 && pe.fp === 0, pe);
var off1 = new Float32Array(truth.length); off1[9 * A.BINS + 5] = 0.9; off1[50 * A.BINS + 9] = 0.9;
var p0 = A.prf(off1, truth, 0.5, 0), p1 = A.prf(off1, truth, 0.5, 1);
check('prf: one frame off counts as a miss with tol 0, a hit with tol 1', p0.tp === 1 && p1.tp === 2 && p1.fp === 0, [p0, p1]);
var extra = new Float32Array(truth.length); extra[0] = 0.9;
check('prf: a false positive lowers precision', A.prf(extra, truth, 0.5, 0).fp === 1 && A.prf(extra, truth, 0.5, 0).precision === 0);
check('prf: threshold respected', A.prf(perfect, truth, 0.95, 0).tp === 0);
var pool = A.pooledF1([{ tp: 1, fp: 1, fn: 0 }, { tp: 1, fp: 0, fn: 3 }]);
check('pooledF1: sums counts first (P=2/3, R=2/5)', pool.tp === 2 && pool.fp === 1 && pool.fn === 3 && Math.abs(pool.precision - 2 / 3) < 1e-9 && Math.abs(pool.recall - 2 / 5) < 1e-9, pool);

console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
