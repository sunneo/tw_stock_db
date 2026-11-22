/* 旋律找歌核心的單元測試：node renderer/src/musiclib/musiclib_melody.test.js 直接跑（不需要麥克風、不需要瀏覽器）。
 * 旋律全部用固定種子的亂數產生，結果可重現。 */
'use strict';
var assert = require('assert');
var MM = require('./musiclib_melody.js');

var tests = [];
function t(name, fn) { tests.push({ name: name, fn: fn }); }

// ───── 產生旋律的小工具 ─────
function rng(seed) { var s = seed >>> 0; return function () { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
// 合成旋律：n 個音，音高在 55..79 之間均勻隨機（音程分布夠寬，無關旋律才分得開；
// 若用隨機游走，音程都很小，任兩段都很像，合成資料會誤判），音長從 0.125／0.25／0.5 秒挑
function makeMelody(seed, n) {
  var r = rng(seed), notes = [], t0 = 0;
  for (var i = 0; i < n; i++) {
    var p = 55 + Math.floor(r() * 25);
    var d = [0.125, 0.25, 0.5][Math.floor(r() * 3)];
    notes.push({ t: t0, d: d, n: p, v: 90 });
    t0 += d;
  }
  return notes;
}
// 查詢用變形：transpose 調高、scale 變速（音長與時間都乘上 k）、drop 漏掉的索引、wrong 錯音、extra 多插一個音、jitter 加雜訊（半音）
function variant(seg, o) {
  o = o || {};
  var k = o.scale || 1, shift = o.transpose || 0, out = [];
  seg.forEach(function (x, i) {
    if ((o.drop || []).indexOf(i) >= 0) return;
    var n = x.n + shift;
    if ((o.wrong || []).indexOf(i) >= 0) n += 2;
    if (o.jitter) n += (rng(i * 7 + 3)() - 0.5) * o.jitter;
    out.push({ t: x.t * k, d: x.d * k, n: n });
    if ((o.extra || []).indexOf(i) >= 0) out.push({ t: (x.t + x.d / 2) * k, d: x.d * k * 0.5, n: n + 1 });
  });
  return out;
}
function contourFor(notes) { return MM.contourOf(MM.melodyNotes(notes)); }
function entriesFrom(list) { return list.map(function (x) { return { key: x.key, name: x.name, contour: contourFor(x.notes) }; }); }

// ───── 測試 ─────
t('相對音程：升 5 調、速度變慢 1.3 倍，仍命中同一首（分數高）', function () {
  var target = makeMelody(11, 60), seg = target.slice(5, 25);
  var q = variant(seg, { transpose: 5, scale: 1.3 });
  var res = MM.searchMelody(q, entriesFrom([{ key: 'A', name: '目標', notes: target }, { key: 'X', name: '別首', notes: makeMelody(99, 60) }]));
  assert.ok(res.ok);
  assert.equal(res.results[0].key, 'A', '排第一的是目標');
  assert.ok(res.results[0].score > 0.9, '變調變速後分數應該很高：' + res.results[0].score);
});

t('容許錯音、漏音、多音與加雜訊，仍命中目標，命中時間點落在片段附近', function () {
  var target = makeMelody(21, 80), seg = target.slice(10, 34);
  var q = variant(seg, { transpose: -3, scale: 0.8, drop: [4, 11], wrong: [7], extra: [14], jitter: 0.4 });
  var res = MM.searchMelody(q, entriesFrom([{ key: 'A', name: '目標', notes: target }, { key: 'B', name: 'b', notes: makeMelody(5, 80) }, { key: 'C', name: 'c', notes: makeMelody(6, 80) }]));
  assert.equal(res.results[0].key, 'A', '排第一');
  assert.ok(res.results[0].pitchScore > 0.55, '音高分數：' + res.results[0].pitchScore);
  var expectStart = target[10].t * 0.8 ; // 查詢的音長已乘上 scale 0.8
  assert.ok(Math.abs(res.results[0].startSec - expectStart) < 1.5, '命中開始時間約 ' + expectStart.toFixed(2) + ' 秒，實際 ' + res.results[0].startSec.toFixed(2));
});

t('不相關旋律不命中（分數低於門檻，或遠低於目標）', function () {
  var target = makeMelody(31, 60), seg = target.slice(0, 20);
  var q = variant(seg, {});
  var others = [1, 2, 3, 4].map(function (s) { return { key: 'O' + s, name: 'o' + s, notes: makeMelody(100 + s, 60) }; });
  var res = MM.searchMelody(q, entriesFrom([{ key: 'A', name: '目標', notes: target }].concat(others)), { minScore: 0.0, limit: 10 });
  var top = res.results[0];
  assert.equal(top.key, 'A');
  var worstOther = res.results.filter(function (r) { return r.key !== 'A'; }).reduce(function (m, r) { return Math.max(m, r.pitchScore); }, 0);
  // 合成資料上：目標約 0.7，最像的無關旋律約 0.5（多個候選視窗取最大，會有一些抬高）
  assert.ok(top.pitchScore - worstOther > 0.15, '目標比最像的無關旋律高出：' + top.pitchScore + ' vs ' + worstOther);
  // 門檻：無關旋律全部低於預設門檻（不會被當成命中）
  var strict = MM.searchMelody(variant(makeMelody(777, 20).slice(0, 20), {}), entriesFrom(others));
  assert.equal(strict.results.length, 0, '完全無關的哼歌不應出現結果');
});

t('排序：分數高的在前；門檻與太短的查詢', function () {
  var target = makeMelody(41, 50);
  var res = MM.searchMelody(variant(target.slice(0, 15), { transpose: 2 }), entriesFrom([
    { key: 'A', name: 'a', notes: target }, { key: 'B', name: 'b', notes: makeMelody(42, 50) }
  ]), { minScore: 0.0 });
  for (var i = 1; i < res.results.length; i++) assert.ok(res.results[i - 1].score >= res.results[i].score, '降冪排序');
  var short = MM.searchMelody([{ t: 0, d: 0.5, n: 60 }, { t: 0.5, d: 0.5, n: 62 }], entriesFrom([{ key: 'A', name: 'a', notes: target }]));
  assert.equal(short.ok, false);
  assert.ok(/太短/.test(short.reason));
});

t('文字加分：可關閉；命中的歌加上加權分數', function () {
  var target = makeMelody(51, 50), other = makeMelody(52, 50);
  var q = variant(target.slice(0, 16), { transpose: 1 });
  var es = entriesFrom([{ key: 'A', name: 'a', notes: target }, { key: 'B', name: 'b', notes: other }]);
  var plain = MM.searchMelody(q, es, { minScore: 0, textHits: null });
  var withText = MM.searchMelody(q, es, { minScore: 0, textHits: new Set(['B']), textWeight: 0.3 });
  var bPlain = plain.results.filter(function (r) { return r.key === 'B'; })[0];
  var bText = withText.results.filter(function (r) { return r.key === 'B'; })[0];
  assert.equal(bPlain.textBonus, 0);
  assert.ok(Math.abs(bText.textBonus - 0.3) < 1e-9, '命中文字時加權');
  assert.ok(bText.score > bPlain.score + 0.25, '加權後分數變高');
});

t('節奏分數：同一個節奏換音高、變速，節奏分數高；隨機節奏低；打擊只比間隔比例', function () {
  var beats = [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.25, 3.5, 4.0, 4.5, 5.0];
  var fast = beats.map(function (b) { return b * 0.6; }); // 變速
  var same = MM.rhythmScore(beats, fast);
  assert.ok(same.score > 0.95, '同節奏變速：' + same.score);
  var r = rng(8), random = [], tt = 0;
  for (var i = 0; i < 12; i++) { tt += 0.1 + r() * 0.9; random.push(tt); }
  var diff = MM.rhythmScore(beats, random);
  assert.ok(diff.score < same.score - 0.2, '隨機節奏明顯較低：' + diff.score);
  assert.equal(MM.rhythmScore([0, 1], beats).score, 0, '打擊太少回 0 並附原因');
});

t('mid 直接取旋律：鼓軌不算、同群起音取最高音', function () {
  var song = { tracks: [
    { drum: false, notes: [{ t: 0, d: 480, n: 60 }, { t: 0, d: 480, n: 67 }, { t: 480, d: 480, n: 62 }] },
    { drum: true, notes: [{ t: 0, d: 120, n: 36 }] }
  ] };
  var mel = MM.melodyFromSong(song);
  assert.deepEqual(mel.map(function (x) { return x.n; }), [67, 62], '同時起音取最高音，鼓不算');
  assert.ok(Math.abs(mel[1].t - 0.5) < 1e-9, 'tick 480 在 120 BPM 是 0.5 秒（時間要換成秒，不是 tick）');
});

t('索引：建好的跳過；檔案變了重建；暫時性失敗重試後成功；永久失敗附原因；取消後剩下的不跑', async function () {
  var recs = [
    { key: 'ok1', path: 'a', size: 10, mtimeMs: 1 },
    { key: 'bad', path: 'b', size: 10, mtimeMs: 1 },
    { key: 'flaky', path: 'c', size: 10, mtimeMs: 1 },
    { key: 'late', path: 'd', size: 10, mtimeMs: 1 }
  ];
  var calls = {}, saved = [];
  var notesOf = function (seed) { return makeMelody(seed, 20); };
  var extract = async function (rec, ctx) {
    calls[rec.key] = (calls[rec.key] || 0) + 1;
    if (rec.key === 'bad') throw new Error('解碼失敗：格式不明');
    if (rec.key === 'flaky' && ctx.attempt === 1) throw new Error('network error 假的');
    return { notes: notesOf(rec.key.length * 3), method: '單音追蹤（簡易轉譜）' };
  };
  var events = [];
  var sum = await MM.runMelodyIndex(recs, { extract: extract, save: async function (r) { saved.push(r.key); }, onEvent: function (e) { events.push(e); }, sleep: function () { return Promise.resolve(); } });
  assert.deepEqual(sum, { done: 3, skipped: 0, failed: 1, cancelled: 0 });
  assert.equal(recs[1].melody.status, 'failed');
  assert.ok(/解碼失敗/.test(recs[1].melody.reason));
  assert.equal(calls.bad, 1, '永久失敗不重試');
  assert.equal(calls.flaky, 2, '暫時性失敗重試一次後成功');
  assert.equal(recs[2].melody.status, 'ok');
  assert.ok(events.some(function (e) { return e.status === 'retry'; }));

  // 第二次：成功的跳過，失敗的（檔案沒變）會再試一次；檔案變了要重建
  recs[0].size = 999;
  var sum2 = await MM.runMelodyIndex(recs, { extract: extract, sleep: function () { return Promise.resolve(); } });
  assert.equal(sum2.skipped, 2, 'ok1 被改過要重建，所以跳過的是 flaky 與 late');
  assert.equal(calls.ok1, 2, '檔案大小變了要重建');
  assert.equal(sum2.failed, 1, '失敗的那首再試，仍失敗');
});

t('索引：取消後剩下的不跑；暫停等待由呼叫端控制', async function () {
  var recs = [{ key: 'a', size: 1, mtimeMs: 1 }, { key: 'b', size: 1, mtimeMs: 1 }, { key: 'c', size: 1, mtimeMs: 1 }];
  var ran = [], cancel = false;
  var sum = await MM.runMelodyIndex(recs, {
    extract: async function (rec) { ran.push(rec.key); cancel = true; return { notes: makeMelody(9, 10), method: 'x' }; },
    isCancelled: function () { return cancel; }, sleep: function () { return Promise.resolve(); }
  });
  assert.deepEqual(ran, ['a']);
  assert.equal(sum.done, 1);
  assert.equal(sum.cancelled, 2);
  var paused = 0;
  await MM.runMelodyIndex([{ key: 'p', size: 1, mtimeMs: 1 }], {
    extract: async function () { return { notes: makeMelody(10, 10), method: 'x' }; },
    waitIfPaused: async function () { paused++; }
  });
  assert.equal(paused, 1, '每首開始前都會呼叫暫停等待');
});

// ───── 執行 ─────
(async function () {
  var pass = 0, failed = [];
  for (var i = 0; i < tests.length; i++) {
    try { await tests[i].fn(); pass++; console.log('  通過  ' + tests[i].name); }
    catch (e) { failed.push(tests[i].name); console.log('  失敗  ' + tests[i].name + '\n        ' + (e && e.message)); }
  }
  console.log('musiclib_melody 單元測試：通過 ' + pass + ' / ' + tests.length + ' 項');
  if (failed.length) process.exitCode = 1;
})();
