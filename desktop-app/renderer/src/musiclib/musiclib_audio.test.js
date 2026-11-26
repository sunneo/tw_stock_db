/* 音樂庫音訊→MIDI 的單元測試：node renderer/src/musiclib/musiclib_audio.test.js
 * 用的是真的 audio_pipeline.js（與 audio_to_midi.js）跑合成音訊，不需要瀏覽器、不需要模型。 */
'use strict';
var assert = require('assert');
var A = require('./musiclib_audio.js');
var MM = require('./musiclib_melody.js');
var Pipeline = require('../music/audio_pipeline.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }
var SR = 22050;

// 合成：一串音（midi 音高、秒數），每個音是純正弦波，中間不留空
function synthNotes(list, sr) {
  var total = list.reduce(function (s, x) { return s + x.d; }, 0);
  var out = new Float32Array(Math.ceil(total * sr)), pos = 0;
  list.forEach(function (x) {
    var f = 440 * Math.pow(2, (x.n - 69) / 12), n = Math.floor(x.d * sr);
    for (var i = 0; i < n && pos + i < out.length; i++) out[pos + i] = 0.3 * Math.sin(2 * Math.PI * f * i / sr);
    pos += n;
  });
  return out;
}
function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function melodyList(seed, n) {
  var r = rng(seed), out = [];
  for (var i = 0; i < n; i++) out.push({ n: 55 + Math.floor(r() * 25), d: [0.25, 0.375, 0.5][Math.floor(r() * 3)] });
  return out;
}

t('拆軌：給了 separator 就傳進流程並標「＋Demucs 拆軌」；分軌那步丟錯就退回不分軌並寫明原因', async function () {
  var seen = [];
  var fakeP = { run: async function (inp, o) { seen.push(o); if (o.separator && o.separator.boom) throw new Error('模型炸了'); return { song: { tracks: [] }, tempo: { bpm: 100 }, report: { skipped: [] } }; } };
  var input = { channels: [new Float32Array(100)], sampleRate: 100 };
  var ok = await A.songFromAudio(input, { Pipeline: fakeP, separator: function () {}, stems: ['drums', 'bass'] });
  assert.ok(seen[0].separator && seen[0].stems.length === 2, 'separator 與 stems 要傳進流程');
  assert.ok(/＋Demucs 拆軌/.test(ok.method), ok.method);
  seen.length = 0;
  var bad = function () {}; bad.boom = true;
  var fb = await A.songFromAudio(input, { Pipeline: fakeP, separator: bad });
  assert.equal(seen.length, 2, '先試分軌、失敗再退回不分軌');
  assert.ok(!seen[1].separator, '退回的那次不帶 separator');
  assert.ok(/拆軌沒成功.*模型炸了/.test(fb.method), fb.method);
  seen.length = 0;
  var plain = await A.songFromAudio(input, { Pipeline: fakeP });
  assert.ok(!/拆軌/.test(plain.method) && !seen[0].separator, '沒給 separator 就跟以前一樣');
});

t('單聲道合成與切片：兩聲道取平均，切片不超過整段', function () {
  var m = A.monoOf([new Float32Array([1, 1]), new Float32Array([0, 3])]);
  assert.deepEqual(Array.from(m), [0.5, 2]);
  var s = A.sliceChannels([new Float32Array(100)], 10, 3);
  assert.equal(s[0].length, 30, '3 秒 × 10 Hz');
  assert.equal(A.sliceChannels([new Float32Array(20)], 10, 99)[0].length, 20, '超過整段就給整段');
});

t('沒有模型：單音音高追蹤能抓到 440 Hz（MIDI 69），方法標「簡易轉譜」', async function () {
  var x = synthNotes([{ n: 69, d: 1.5 }], SR);
  var r = await A.songFromAudio({ channels: [x], sampleRate: SR }, { Pipeline: Pipeline });
  var notes = r.song.tracks.reduce(function (s, tr) { return s.concat(tr.notes); }, []);
  assert.ok(notes.length >= 1, '有音符');
  assert.ok(notes.some(function (n) { return n.n === 69; }), '抓到 A4(69)：' + JSON.stringify(notes.map(function (n) { return n.n; })));
  assert.equal(r.method, A.METHOD_PITCH);
});

t('有 Basic Pitch（注入的轉譜函式）：用它的音符，方法標 Basic Pitch', async function () {
  var x = synthNotes([{ n: 60, d: 0.5 }, { n: 64, d: 0.5 }], SR);
  var called = 0;
  var tr = async function (mono, sr) { called++; return [{ t: 0.0, d: 0.5, n: 60, v: 90 }, { t: 0.5, d: 0.5, n: 64, v: 90 }]; };
  var r = await A.songFromAudio({ channels: [x], sampleRate: SR }, { Pipeline: Pipeline, transcriber: tr });
  assert.ok(called >= 1, '確實呼叫了轉譜函式');
  assert.equal(r.method, A.METHOD_BASIC);
  var pitches = r.song.tracks.reduce(function (s, tk) { return s.concat(tk.notes.map(function (n) { return n.n; })); }, []);
  assert.ok(pitches.indexOf(60) >= 0 && pitches.indexOf(64) >= 0, '音符來自轉譜：' + pitches);
});

t('Basic Pitch 丟錯：整段退回單音追蹤，方法寫明失敗原因（不會整個失敗）', async function () {
  var x = synthNotes([{ n: 69, d: 1 }], SR);
  var tr = async function () { throw new Error('模型推論失敗（測試）'); };
  var r = await A.songFromAudio({ channels: [x], sampleRate: SR }, { Pipeline: Pipeline, transcriber: tr });
  assert.ok(/模型推論失敗/.test(r.method) && /退回/.test(r.method), '方法寫明退回原因：' + r.method);
  assert.ok(r.song.tracks.length >= 1);
});

t('沒有 Pipeline 或沒有音訊：明確丟錯', async function () {
  await assert.rejects(A.songFromAudio({ channels: [new Float32Array(5)], sampleRate: 10 }, {}), /缺少 FaAudioPipeline/);
  await assert.rejects(A.songFromAudio({ channels: [], sampleRate: 10 }, { Pipeline: Pipeline }), /沒有音訊樣本/);
});

t('端到端：合成哼歌（音訊）→ 單音音高追蹤 → 旋律 → 比對，命中來源旋律', async function () {
  var src = [{ key: 'S', name: '來源', list: melodyList(7, 30) }, { key: 'X1', name: '別首1', list: melodyList(70, 30) }, { key: 'X2', name: '別首2', list: melodyList(71, 30) }];
  var entries = src.map(function (s) {
    var notes = []; var t0 = 0;
    s.list.forEach(function (x) { notes.push({ t: t0, d: x.d, n: x.n }); t0 += x.d; });
    return { key: s.key, name: s.name, contour: MM.contourOf(MM.melodyNotes(notes)) };
  });
  // 哼的是來源的一段（12 個音），音訊合成後走整條路線
  var hum = src[0].list.slice(4, 16);
  var x = synthNotes(hum, SR);
  var r = await A.songFromAudio({ channels: [x], sampleRate: SR }, { Pipeline: Pipeline });
  var song = r.song;
  var notes = MM.melodyFromSong(song);
  assert.ok(notes.length >= 6, '從音訊抽出足夠的音：' + notes.length);
  var res = MM.searchMelody(notes, entries, { minScore: 0 });
  assert.equal(res.results[0].key, 'S', '第一名是來源：' + JSON.stringify(res.results.map(function (x) { return [x.key, x.pitchScore]; })));
});


// 哼歌：音量衰減的尾巴與背景雜音不能變成多出來的音符
t('humNotes：衰減尾與雜音不產生多餘音符', function () {
  var AM = require('../music/audio_to_midi.js'), seq = [60, 64, 67, 64], r = rng(7), parts = [];
  seq.forEach(function (n) {
    var f = 440 * Math.pow(2, (n - 69) / 12), len = Math.floor(0.6 * SR), seg = new Float32Array(len + Math.floor(0.2 * SR));
    for (var i = 0; i < len; i++) { var env = 0.4 * Math.exp(-3.2 * i / len); seg[i] = env * Math.sin(2 * Math.PI * f * i / SR); }
    for (var j = len; j < seg.length; j++) seg[j] = 0.004 * (r() - 0.5);   // 間隙：很小的雜音
    for (var q = 0; q < len; q++) seg[q] += 0.003 * (r() - 0.5);
    parts.push(seg);
  });
  var total = parts.reduce(function (s, x) { return s + x.length; }, 0), all = new Float32Array(total), pos = 0;
  parts.forEach(function (x) { all.set(x, pos); pos += x.length; });
  var res = A.humNotes({ channels: [all], sampleRate: SR }, { AudioToMidi: AM });
  var got = res.notes.map(function (x) { return x.n; });
  assert.deepEqual(got, seq, '音符序列應該只有哼的四個音：' + JSON.stringify(got));
});


// 哼歌：遠低於旋律的底噪音（像 110 Hz 的嗡聲）要丟掉，不能混進旋律
t('查詢轉譜路線：多聲部且有模型 → basicPitch；其餘（單人哼唱、沒有模型）→ viterbi', function () {
  assert.equal(A.queryPathFor({ polyphonic: true, hasModel: true }), 'basicPitch');
  assert.equal(A.queryPathFor({ polyphonic: true, hasModel: false }), 'viterbi');
  assert.equal(A.queryPathFor({ polyphonic: false, hasModel: true }), 'viterbi');
  assert.equal(A.queryPathFor(), 'viterbi');
});
t('humNotes：離旋律太遠的低頻底噪音被丟掉', function () {
  var AM = require('../music/audio_to_midi.js'), seq = [62, 64, 65, 67, 65, 64, 62, 64], list = [];
  seq.forEach(function (n, i) { list.push({ n: n, d: 0.4 }); if (i === 3 || i === 6) list.push({ n: 45, d: 0.3 }); });
  var res = A.humNotes({ channels: [synthNotes(list, SR)], sampleRate: SR }, { AudioToMidi: AM });
  var got = res.notes.map(function (x) { return x.n; });
  assert.ok(got.every(function (x) { return x >= 60; }), '不該留下 45：' + JSON.stringify(got));
  assert.ok(got.length >= 7, '旋律音要留住：' + JSON.stringify(got));
});

// ───── 執行 ─────
(async function () {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); pass++; console.log('  通過  ' + tests[i].name); }
    catch (e) { failed.push(tests[i].name); console.log('  失敗  ' + tests[i].name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_audio 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
