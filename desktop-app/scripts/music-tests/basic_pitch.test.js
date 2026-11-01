// node scripts/music-tests/basic_pitch.test.js -- Basic Pitch 的視窗切分、串接、音符解碼(用真模型跑出來的輸出當固定資料)
const B = require('../../renderer/src/music/basic_pitch.js');
const fx = require('./fixtures-bp-two-tones.json');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 400) : '')); }
const dense = (sp) => { const a = new Float32Array(B.FRAMES * B.BINS); sp.forEach(([i, j, v]) => { a[i * B.BINS + j] = v; }); return a; };
// 固定資料:兩個 2 秒視窗裡 C4 與 E4 同時從 0.3 秒響到 1.8 秒(真模型 nmp.onnx 的輸出,0.2 以下的值省略)
const one = { frames: B.FRAMES, onset: dense(fx.onset), note: dense(fx.note) };
const notes = B.decode(one);
check('decode: real model output gives exactly C4 and E4', notes.length === 2 && notes.map((n) => n.n).join() === '60,64', notes);
check('decode: onset about 0.3 s and length about 1.5 s', notes.every((n) => Math.abs(n.t - 0.3) < 0.06 && Math.abs(n.d - 1.5) < 0.15), notes.map((n) => [n.t.toFixed(2), n.d.toFixed(2)]));
check('decode: nothing from an empty frame matrix', B.decode({ frames: 50, onset: new Float32Array(50 * 88), note: new Float32Array(50 * 88) }).length === 0);
// 視窗:5 秒(22050 Hz)要切成 3 個視窗,頭尾重疊;每個視窗長度固定
const x = new Float32Array(110250).map((_, i) => i % 7); const ws = B.windows(x);
check('windows: fixed length, enough to cover, first window starts with half-overlap padding', ws.length === 4 && ws.every((w) => w.length === B.WIN) && ws[0][0] === 0 && ws[0][3840] === x[0] && ws[0][3841] === x[1], ws.length);
// 串接:丟掉頭尾 15 幀,每窗留 142 幀;兩窗的標記值要落在連續的全域幀
const mk = (tag) => { const r = { onset: new Float32Array(B.FRAMES * B.BINS), note: new Float32Array(B.FRAMES * B.BINS) }; for (let f = 0; f < B.FRAMES; f++) r.onset[f * B.BINS] = tag * 1000 + f; return r; };
const st = B.stitch([mk(1), mk(2)], 60000);
check('stitch: trims 15 frames each side and keeps frames contiguous, capped to the real length', st.frames === Math.ceil(60000 / 256) && st.onset[0] === 1015 && st.onset[141 * 88] === 1156 && st.onset[142 * 88] === 2015, [st.frames, st.onset[0], st.onset[141 * 88], st.onset[142 * 88]]);
console.log(bad.length ? 'FAIL\n' + bad.join('\n') : 'ok'); console.log(ok + ' passed, ' + bad.length + ' failed'); process.exit(bad.length ? 1 : 0);
