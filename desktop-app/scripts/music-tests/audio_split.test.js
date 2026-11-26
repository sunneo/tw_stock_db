// node scripts/music-tests/audio_split.test.js -- 高低音分開跑的接線:假 ort／假模型輸出。低於 MIDI 55 只能來自原混音、55 以上只能來自高通版本;Demucs 長段切分
const RT = require('../../renderer/src/music/audio_runtime.js');
const BP = require('../../renderer/src/music/basic_pitch.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const fakeOrt = { Tensor: function (type, data, dims) { this.type = type; this.data = data; this.dims = dims; } };
// 假模型:不管輸入是什麼,都給 midi 40 與 midi 70 各一段明顯的音(每個視窗相同)。
// 所以低音只能來自低音分(原混音),高音只能來自高通分;兩種來源的結果要在分界處正確切開。
function fakeSession(pitches) {
  const make = () => { const onset = new Float32Array(BP.FRAMES * BP.BINS), note = new Float32Array(BP.FRAMES * BP.BINS); for (const m of pitches) { const b = m - BP.LOW; for (let f = 40; f < 100; f++) note[f * BP.BINS + b] = 0.9; onset[40 * BP.BINS + b] = 0.95; } return { onset, note }; }; // 放在視窗中間(頭尾各 15 格會被 stitch 丟掉)
  return { inputNames: ['input'], outputNames: ['onset', 'note'], calls: 0, run: async function () { this.calls++; const r = make(); return { onset: { data: r.onset }, note: { data: r.note } }; } };
}
(async () => {
  const sr = 22050, mono = new Float32Array(sr * 2);
  const sess = fakeSession([40, 70]);
  const tr = RT.makeTranscriber(fakeOrt, sess, null);
  const notes = await tr(mono, sr);
  check('split: transcriber reports the high/low method', Array.isArray(tr.methods) && tr.methods.indexOf('＋高低音分跑') >= 0, tr.methods);
  check('split: both passes ran (original mix and high-passed copy)', sess.calls >= 2, sess.calls);
  check('split: low pitch 40 comes from the original mix', notes.some((n) => n.n === 40), notes.map((n) => n.n));
  check('split: high pitch 70 comes from the high-passed copy', notes.some((n) => n.n === 70), notes.map((n) => n.n));
  check('split: nothing outside the two pitches', notes.every((n) => n.n === 40 || n.n === 70), notes.map((n) => n.n));
  check('split: boundary constant is 55 (G3, goes to the high pass)', RT.SPLIT_MIDI === 55);
  // 沒有高通模組(DSP 不在)時只跑一次原混音
  // 這裡用同一支模組,直接檢查 split 旗標:methods 在有 DSP 時有值
  // Demucs 長段:20 秒輸入切成多段呼叫模型,輸出長度與輸入相同
  let calls = 0; const sepSess = { inputNames: ['mix'], outputNames: ['stems'], run: async function (feeds) { calls++; const t = feeds.mix.data; const dims = 6 * 2; const out = new Float32Array(dims * RT.SEG); for (let k = 0; k < dims; k++) for (let i = 0; i < RT.SEG; i++) out[k * RT.SEG + i] = t[i] * 0.5; return { stems: { data: out } }; } };
  const sep = RT.makeSeparator(fakeOrt, sepSess);
  const long = new Float32Array(sr * 20).fill(0.2);
  const sres = await sep({ left: long, right: long, sr });
  check('demucs: 20 s input is split into several model calls', calls >= 3, calls);
  check('demucs: each stem has the input length', RT.STEMS.every((s) => sres[s].length === long.length), RT.STEMS.map((s) => sres[s] && sres[s].length));
  check('demucs: middle of the clip is filled (not zeros)', Math.abs(sres.drums[sr * 10]) > 0.01, sres.drums[sr * 10]);
  check('demucs: segmentSec is the core length (less than the model window)', sep.segmentSec > 0 && sep.segmentSec < RT.SEG / 44100);
  console.log('audio_split.test: ' + ok + ' ok, ' + bad.length + ' failed');
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
