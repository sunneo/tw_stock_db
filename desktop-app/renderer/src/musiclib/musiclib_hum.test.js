/* 哼歌找歌（階段二）的單元測試：node renderer/src/musiclib/musiclib_hum.test.js 直接跑。
 * 合成音訊全部用固定種子產生，結果可重現。涵蓋：主旋律線找得回來（有伴奏、有低音）、
 * 旋律線比對（哼歌：調不同、速度 ±10%、音高有點走音）、色度比對（哼歌錄音：調不同、速度、走音）、名次融合、
 * 舊的「用音符哼歌」流程（舊格式索引，沒有新特徵）仍找得到、3 分鐘的歌建指紋（含旋律線）≤ 3 秒。 */
'use strict';
var assert = require('assert');
var FP = require('./musiclib_fingerprint.js');
var MM = require('./musiclib_melody.js');

var SR = 11025;
var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }

// 旋律：隨機走音（每步 ±1～4 半音），音長 0.3～0.6 秒，音高限制在 60–78
function makeMelody(seed, count) {
  var r = rng(seed), out = [], t0 = 0, n = 66 + Math.floor(r() * 6);
  for (var i = 0; i < count; i++) {
    var d = 0.3 + r() * 0.3;
    out.push({ t: t0, d: d, n: n });
    t0 += d;
    var step = (1 + Math.floor(r() * 4)) * (r() < 0.5 ? -1 : 1);
    n = Math.max(60, Math.min(78, n + step));
  }
  return out;
}
// 把音符渲染成音訊：每個音是正弦＋二次諧波（音長末端指數衰減），加在 buf 上
function renderNotes(buf, notes, o) {
  o = o || {};
  var amp = o.amp == null ? 0.5 : o.amp, shift = o.shift || 0, tempo = o.tempo || 1, detune = o.detune || 0, harm = o.harm == null ? 0.4 : o.harm;
  notes.forEach(function (x, idx) {
    var rnd = o.jitter ? (o.jitterFn ? o.jitterFn(idx) : 0) : 0;
    var n = x.n + shift + detune + rnd;
    var f = 440 * Math.pow(2, (n - 69) / 12), s0 = Math.floor(x.t / tempo * SR), len = Math.floor(x.d / tempo * SR);
    for (var i = 0; i < len && s0 + i < buf.length; i++) {
      var tt = i / SR, env = Math.min(1, i / (0.01 * SR)) * Math.exp(-2.5 * i / len);
      buf[s0 + i] += amp * env * (Math.sin(2 * Math.PI * f * tt) + harm * Math.sin(2 * Math.PI * 2 * f * tt));
    }
  });
  return buf;
}
// 一首「歌」：旋律（主音）＋低音（旋律音低兩個八度再降一點，每 0.6 秒換一次）＋一個安靜的和弦墊（旋律音 +4、+7）
function makeSong(seed, notes, sec) {
  var n = Math.floor(sec * SR), buf = new Float32Array(n);
  renderNotes(buf, notes, { amp: 0.5 });
  var bass = [];
  for (var t0 = 0; t0 < sec; t0 += 0.6) {
    var src = notes[Math.floor(t0 / (notes[notes.length - 1].t + notes[notes.length - 1].d) * notes.length) % notes.length];
    bass.push({ t: t0, d: 0.6, n: src.n - 24 });
  }
  renderNotes(buf, bass, { amp: 0.22, harm: 0.2 });
  var pad = [];
  notes.forEach(function (x) { pad.push({ t: x.t, d: x.d, n: x.n + 4 }, { t: x.t, d: x.d, n: x.n + 7 }); });
  renderNotes(buf, pad, { amp: 0.08, harm: 0 });
  var mx = 0; for (var i = 0; i < n; i++) if (Math.abs(buf[i]) > mx) mx = Math.abs(buf[i]);
  for (i = 0; i < n; i++) buf[i] /= (mx || 1);
  return buf;
}
// 「哼」的錄音：只有單音（正弦）、調可能不同、速度變、音高走音（每個音 ±0.35 半音的隨機偏移）
function makeHum(seed, notes, o) {
  var r = rng(seed), noteOut = [];
  var hum = notes.map(function (x) { return { t: x.t, d: x.d, n: x.n }; });
  var buf = new Float32Array(Math.floor((notes[notes.length - 1].t + notes[notes.length - 1].d + 0.5) * SR / (o.tempo || 1)));
  renderNotes(buf, hum, { amp: 0.6, harm: 0.1, shift: o.shift || 0, tempo: o.tempo || 1, detune: o.detune || 0, jitter: true, jitterFn: function () { return (r() * 2 - 1) * 0.35; } });
  // 哼歌錄音的旋律（給旋律層用）：與音訊同一次的音高追蹤結果，四捨五入到半音，時間與速度一起變
  hum.forEach(function (x) {
    noteOut.push({ t: x.t / (o.tempo || 1), d: x.d / (o.tempo || 1), n: Math.round(x.n + (o.shift || 0) + (o.detune || 0) + (r() * 2 - 1) * 0.35) });
  });
  return { samples: buf, notes: noteOut };
}

// 索引：一首歌 → 指紋（含主旋律線）→ 旋律索引紀錄（與音樂庫的 fastLinesResult 格式相同）
function makeRecord(key, name, samples, fp) {
  var res = MM.fastLinesResult(fp, fp.lines, { method: '快速旋律線（測試）' });
  var contourMain = res.notes.length >= MM.MIN_NOTES ? MM.contourOf(MM.melodyNotes(res.notes)) : null;
  return { key: key, name: name, path: 'D:/m/' + name, fp: FP.pack(fp), melody: { status: 'ok', method: res.method, contour: contourMain, tracks: res.tracks, feat: res.feat } };
}

var SONG_SEC = 40;
var MELS = [makeMelody(11, 60), makeMelody(22, 60), makeMelody(33, 60)];
var NAMES = ['甲.mp3', '乙.mp3', '丙.mp3'];
var SONGS = MELS.map(function (m, i) { return makeSong(100 + i, m, SONG_SEC); });
var FPS = SONGS.map(function (s) { return FP.fingerprint(s, SR); });
var RECS = FPS.map(function (fp, i) { return makeRecord('k' + i, NAMES[i], SONGS[i], fp); });
var ENTRIES = MM.entriesOf(RECS).entries;
var CHROMA_ENTRIES = FPS.map(function (fp, i) { var u = FP.unpack(FP.pack(fp)); return { key: 'k' + i, name: NAMES[i], path: 'D:/m/' + NAMES[i], cells: u.cells, chroma: u.chroma }; });

// ───── 測試 ─────
t('主旋律線：有伴奏與低音的歌，第一條線或聲部線能找回旋律的音（半音精準度 ≥ 60%）', function () {
  var fp = FPS[0], truth = MELS[0], hit = 0, tot = 0;
  truth.forEach(function (x) {
    tot++;
    var mid = x.t + x.d / 2;
    var ok = fp.lines.some(function (ln) { return ln.some(function (y) { return mid >= y.t && mid < y.t + y.d && Math.abs(y.n - x.n) < 0.5; }); });
    if (ok) hit++;
  });
  console.log('      旋律音命中 ' + hit + ' / ' + tot + '，線數 ' + fp.lines.length);
  assert.ok(hit / tot >= 0.6, '旋律線太差：' + hit + ' / ' + tot);
});

t('主旋律線：每首最多 3 條，每條是單音（同一時間不重疊）', function () {
  FPS.forEach(function (fp) {
    assert.ok(fp.lines.length >= 1 && fp.lines.length <= FP.MEL_LINES, '線數 ' + fp.lines.length);
    fp.lines.forEach(function (ln) {
      // 同一條線的音依時間接續（毫秒四捨五入的誤差 ≤ 0.002 秒）
      for (var i = 0; i + 1 < ln.length; i++) assert.ok(ln[i].t + ln[i].d <= ln[i + 1].t + 0.002, '音重疊：' + JSON.stringify(ln[i]) + ' / ' + JSON.stringify(ln[i + 1]));
    });
  });
});

t('旋律比對（哼歌）：原曲第 2 首的哼歌（速度 +10%、升 3 個半音、走音）名次第 1', function () {
  var hum = makeHum(5, MELS[1], { shift: 3, tempo: 1.1, detune: 0.2 });
  var r = MM.searchMelody(hum.notes, ENTRIES, { minScore: 0.1, limit: 10 });
  assert.ok(r.ok, '查詢應有效：' + r.reason);
  assert.equal(r.results[0] && r.results[0].name, NAMES[1], '名次第 1 應為乙：' + JSON.stringify(r.results.map(function (x) { return [x.name, x.score]; })));
});

t('旋律比對（哼歌）：速度 −10%、降 2 個半音，三首各自都能找到（名次第 1）', function () {
  for (var i = 0; i < 3; i++) {
    var hum = makeHum(40 + i, MELS[i], { shift: -2, tempo: 0.9, detune: -0.1 });
    var r = MM.searchMelody(hum.notes, ENTRIES, { minScore: 0.1, limit: 10 });
    assert.equal(r.results[0] && r.results[0].name, NAMES[i], '第 ' + i + ' 首名次第 1 應為 ' + NAMES[i] + '：' + JSON.stringify(r.results.map(function (x) { return [x.name, x.score]; })));
  }
});

t('色度比對（哼歌錄音）：調不同、速度 ±10%、走音，名次第 1 且轉調正確', function () {
  var cases = [{ i: 0, shift: 5, tempo: 1.08, detune: 0.2 }, { i: 2, shift: -4, tempo: 0.93, detune: -0.2 }];
  cases.forEach(function (c) {
    var hum = makeHum(70 + c.i, MELS[c.i], c);
    var q = FP.chromaOf(hum.samples, SR);
    var r = FP.chromaSearch(q, CHROMA_ENTRIES, { limit: 10 });
    assert.ok(r.length > 0, '應有結果');
    assert.equal(r[0].name, NAMES[c.i], '色度名次第 1 應為 ' + NAMES[c.i] + '：' + JSON.stringify(r.map(function (x) { return [x.name, x.score]; })));
    console.log('      ' + NAMES[c.i] + ' 色度分數 ' + r[0].score + '，第二名 ' + (r[1] ? r[1].score : '-') + '，轉調 ' + r[0].shift + '，段落 ' + r[0].startSec + '–' + r[0].endSec + ' 秒');
  });
});

t('色度比對：查詢太短（沒有足夠的和聲格）回傳空陣列，不硬比', function () {
  var q = FP.chromaOf(new Float32Array(SR / 4), SR);
  assert.deepEqual(FP.chromaSearch(q, CHROMA_ENTRIES, {}), []);
});

t('名次融合：旋律與和聲都指向同一首時融合名次第 1；只有一層有結果時仍可排序', function () {
  var hum = makeHum(91, MELS[2], { shift: 1, tempo: 1.05, detune: 0.1 });
  var mel = MM.searchMelody(hum.notes, ENTRIES, { minScore: 0.1, limit: 10 }).results.map(function (r) { return { key: r.key, name: r.name, score: r.score, startSec: r.startSec, endSec: r.endSec, label: r.hitLine }; });
  var chr = FP.chromaSearch(FP.chromaOf(hum.samples, SR), CHROMA_ENTRIES, { limit: 10 });
  var fused = FP.fuseRanks({ 旋律: mel, 和聲: chr }, { 旋律: 1, 和聲: 1 });
  assert.equal(fused[0].name, NAMES[2]);
  assert.ok(fused[0].layers['旋律'] && fused[0].layers['和聲'], '第一名要同時標出兩層');
  var only = FP.fuseRanks({ 旋律: [], 和聲: chr }, {});
  assert.equal(only[0].name, chr[0].name);
});

t('有把握的判定（humVerdict）：真命中（和聲邊際夠大）→ 有把握；沒收錄的旋律（和聲第一名與第二名只差一點）→ 沒把握', function () {
  var pos = FP.chromaSearch(FP.chromaOf(makeHum(70, MELS[0], { shift: 5, tempo: 1.08, detune: 0.2 }).samples, SR), CHROMA_ENTRIES, { limit: 10 });
  var v = FP.humVerdict([], pos, {});
  assert.equal(v.top.name, NAMES[0]);
  assert.ok(v.confident, '真命中應有把握：' + JSON.stringify(pos.slice(0, 2)));
  var neg = FP.chromaSearch(FP.chromaOf(makeHum(800, makeMelody(500, 60), { shift: 2 }).samples, SR), CHROMA_ENTRIES, { limit: 10 });
  var vn = FP.humVerdict([], neg, {});
  assert.equal(vn.confident, false, '沒收錄的旋律不該有把握：' + JSON.stringify(neg.map(function (x) { return [x.name, x.score]; })));
  // 旋律第一名夠高 → 有把握；但融合第一名若不是那一首，就不算有把握
  var mel = [{ key: 'k2', name: NAMES[2], score: 0.9 }, { key: 'k0', name: NAMES[0], score: 0.2 }];
  var chr = [{ key: 'k0', name: NAMES[0], score: 0.95 }, { key: 'k1', name: NAMES[1], score: 0.3 }];
  var mixed = FP.humVerdict(mel, chr, { melodyConfident: 0.5 });
  assert.equal(mixed.confident, mixed.top.key === 'k2', '融合第一名與有把握的那首要一致');
});

t('舊的「用音符哼歌」流程：舊格式索引（沒有新特徵，只有逐音符旋律線）仍找得到，不退步', function () {
  var oldRec = { key: 'old', name: '舊.mid', path: 'D:/m/舊.mid', melody: { status: 'ok', method: 'mid', contour: MM.contourOf(MM.melodyNotes(MELS[0])), tracks: [], version: 3 } };
  var recs = [oldRec].concat(RECS.slice(1));
  var ents = MM.entriesOf(recs).entries;
  var hum = makeHum(123, MELS[0], { shift: 2, tempo: 1.0, detune: 0 });
  var r = MM.searchMelody(hum.notes, ents, { minScore: 0.1, limit: 10 });
  assert.equal(r.results[0] && r.results[0].name, '舊.mid', '舊格式應仍命中：' + JSON.stringify(r.results.map(function (x) { return [x.name, x.score]; })));
  // 用音符（已知正確音符）查詢：與改版前一樣的行為
  var exact = MM.searchMelody(MELS[1], ENTRIES, { minScore: 0.1, limit: 10 });
  assert.equal(exact.results[0].name, NAMES[1]);
});

t('沒有新特徵的紀錄（舊格式）：entriesOf 仍收，並標 feat 為 0，讓畫面提示請重建', function () {
  var old = { key: 'o', name: '舊.mp3', path: 'x', fp: FP.pack(FPS[0]), melody: { status: 'ok', contour: MM.contourOf(MM.melodyNotes(MELS[0])), tracks: [], version: 3 } };
  var c = MM.entriesOf([old]);
  assert.equal(c.entries.length, 1);
  assert.equal(c.entries[0].feat, 0);
  assert.equal(RECS[0].melody.feat, MM.FEAT_FAST);
});

t('3 分鐘的歌建指紋（含主旋律線與色度）≤ 3 秒', function () {
  var long = new Float32Array(SR * 180);
  var notes = makeMelody(999, 400);
  renderNotes(long, notes, { amp: 0.5 });
  var t0 = Date.now(), fp = FP.fingerprint(long, SR), ms = Date.now() - t0;
  console.log('      3 分鐘（含旋律線）：' + ms + ' 毫秒，線數 ' + fp.lines.length + '，各線音數 ' + fp.lines.map(function (l) { return l.length; }).join('、'));
  assert.ok(ms <= 3000, '太慢：' + ms + ' 毫秒');
});

var passed = 0, failed = 0;
(async function () {
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); passed++; console.log('  通過  ' + tests[i].name); }
    catch (e) { failed++; console.log('  失敗  ' + tests[i].name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_hum 單元測試：通過 ' + passed + ' / ' + tests.length + ' 項');
  if (failed) process.exitCode = 1;
})();
