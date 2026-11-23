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
  assert.deepEqual(sum, { done: 3, skipped: 0, failed: 1, cancelled: 0, rebuilt: 0 });
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

// ───── v2：每軌旋律線、重複音合併、離群音、粗輪廓、多線命中、索引版本、合成資料校準 ─────
// 三軌合成曲：主旋律（隨機游走，步進式，最像真的旋律）、高音琶音（主旋律上方和弦音）、低音（慢）。游走比均勻隨機更難分，較接近真實旋律。
function walkMelody(r, n) {
  var out = [], p = 60 + Math.floor(r() * 12), t = 0;
  for (var i = 0; i < n; i++) {
    var x = r(), step = x < 0.75 ? Math.floor(r() * 9) - 4 : Math.floor(r() * 15) - 7;
    p = Math.max(52, Math.min(81, p + step));
    var d = [0.25, 0.25, 0.5, 0.375][Math.floor(r() * 4)];
    out.push({ t: t, d: d, n: p }); t += d;
  }
  return out;
}
function songSet(r, n) {
  var mel = walkMelody(r, n), arp = [], bass = [];
  mel.forEach(function (x) { for (var k = 0; k < 2; k++) arp.push({ t: x.t + k * x.d / 2, d: x.d / 2, n: Math.min(100, x.n + 12 + [0, 4, 7, 12][Math.floor(r() * 4)]) }); });
  for (var b = 0; b < mel[mel.length - 1].t + 0.5; b += 1) bass.push({ t: b, d: 0.9, n: 36 + Math.floor(r() * 5) * 2 });
  return { mel: mel, tracks: [mel, arp, bass] };
}
// 哼歌變形（相對於片段）：每個音 20% 機率錯 ±1 半音；丟 1–2 個音；多 1 個音；音長抖動 ±15%；整體拉伸 1.2 倍；可選：尾端離群音 +24、一個音拆成兩段重複音
function humVariant(r, seg, o) {
  o = o || {};
  var out = [], drop = o.drop == null ? 2 : o.drop, dropSet = {}, extra = Math.floor(r() * seg.length);
  for (var q = 0; q < drop; q++) dropSet[Math.floor(r() * seg.length)] = true;
  seg.forEach(function (x, i) {
    if (dropSet[i]) return;
    var n = x.n + (o.wrong === false ? 0 : (r() < 0.2 ? (r() < 0.5 ? -1 : 1) : 0));
    var jit = o.noJitter ? 1 : 1 + (r() - 0.5) * 0.3;
    out.push({ t: x.t * 1.2, d: x.d * 1.2 * jit, n: n });
    if (o.split && i === 3) { out[out.length - 1].d /= 2; out.push({ t: (x.t + x.d / 2) * 1.2, d: x.d * 1.2 / 2 * 0.95, n: n }); }
    if (i === extra && o.extra !== false) out.push({ t: (x.t + x.d * 0.5) * 1.2, d: x.d * 0.6, n: n + (r() < 0.5 ? 3 : -3) });
  });
  if (o.outlier) { var last = out[out.length - 1]; out.push({ t: last.t + last.d + 0.1, d: 0.3, n: last.n + 24 }); }
  return out;
}
function songOf(list) {
  return { ppq: 480, tempos: [{ t: 0, bpm: 120 }], tracks: list.map(function (x, i) {
    return { name: x.name || ('T' + i), channel: x.channel == null ? i : x.channel, drum: !!x.drum,
      notes: x.notes.map(function (n) { return { t: Math.round(n.t * 960), d: Math.max(1, Math.round(n.d * 960)), n: n.n, v: 90 }; }) };
  }) };
}
function linesOf(key, name, song) {
  var L = MM.songLines(song);
  return { key: key, name: name, lines: [{ label: '合併', track: null, mode: 'merged', contour: MM.contourOf(L.mix) }].concat(L.tracks.map(function (x) { return { label: x.label, track: x.track, mode: x.kind, contour: x.contour }; })) };
}

t('重複音合併：同音高、空隔小於 0.05 秒的連續音併成一個；空隔較大或音高不同不併', function () {
  var out = MM.melodyNotes([{ t: 0, d: 0.25, n: 60 }, { t: 0.26, d: 0.2, n: 60 }, { t: 0.7, d: 0.2, n: 60 }, { t: 1.0, d: 0.2, n: 62 }]);
  assert.deepEqual(out.map(function (x) { return x.n; }), [60, 60, 62], '前兩個 60 併成一個，第三個 60 空隔 0.24 秒不併');
  assert.ok(Math.abs(out[0].d - 0.46) < 1e-9, '併起來的長度蓋到第二個音的結尾：' + out[0].d);
});

t('離群音：查詢最前或最後一個音與鄰音相差 18 半音以上就丟掉；中間的大跳不丟', function () {
  var base = makeMelody(61, 10);
  var tail = base.concat([{ t: base[9].t + 0.5, d: 0.25, n: base[9].n + 24 }]);
  var head = [{ t: -0.5, d: 0.25, n: base[0].n - 24 }].concat(base);
  var mid = base.slice(0, 5).concat([{ t: base[4].t + 0.5, d: 0.25, n: base[4].n + 24 }], base.slice(5));
  assert.equal(MM.dropOutliers(MM.melodyNotes(tail)).length, 10, '尾端離群丟掉');
  assert.equal(MM.dropOutliers(MM.melodyNotes(head)).length, 10, '頭端離群丟掉');
  assert.equal(MM.dropOutliers(MM.melodyNotes(mid)).length, 11, '中間的大跳不丟（可能是真的旋律）');
});

t('粗輪廓：音程分 7 級（持平 0、小 ±1、中 ±2、大 ±3；上下分開）', function () {
  assert.deepEqual([0, 1, -2, 3, -5, 6, -12].map(MM.levelOf), [0, 1, -1, 2, -2, 3, -3]);
});

t('每軌旋律線：每個非鼓軌一條、帶 channel；鼓軌不算；音數少於 8 的軌略過；音程近乎相同的軌只留一條（八度複製）；最多 11 條軌線', function () {
  var a = makeMelody(81, 30), short = makeMelody(82, 5);
  var s = songOf([
    { notes: a, channel: 0 },
    { notes: a.map(function (x) { return { t: x.t, d: x.d, n: x.n + 12 }; }), channel: 1 },   // 八度複製：音程序列完全相同，只留第一條
    { notes: short, channel: 2 },                                                                  // 少於 8 個音，略過
    { notes: a, channel: 9, drum: true }                                                           // 鼓軌不算
  ]);
  var L = MM.songLines(s);
  assert.deepEqual(L.tracks.map(function (x) { return x.channel; }), [0], '只剩第 0 軌');
  assert.equal(L.tracks[0].notes.length > 0, true, '每軌帶音符（秒、音高）');
  var many = []; for (var i = 0; i < 15; i++) many.push({ notes: makeMelody(100 + i, 20), channel: i });
  assert.ok(MM.songLines(songOf(many)).tracks.length <= 11, '每首軌線最多 11 條（加上合併線共 12 條）');
});

t('多線命中：每首取所有線中最高分那條，回報命中的線（主旋律在頻道 0；合併線與其他軌不命中）', function () {
  var r = rng(71), set = songSet(r, 40), others = songSet(rng(72), 40);
  var ents = [linesOf('A', '目標', songOf([{ notes: set.tracks[0], channel: 0 }, { notes: set.tracks[1], channel: 3 }, { notes: set.tracks[2], channel: 4 }])),
    linesOf('B', '別首', songOf([{ notes: others.tracks[0], channel: 0 }, { notes: others.tracks[1], channel: 3 }]))];
  var q = humVariant(rng(73), set.mel.slice(5, 25), { drop: 1 });
  var res = MM.searchMelody(q, ents);
  assert.equal(res.results[0].key, 'A', '排第一的是目標');
  assert.equal(res.results[0].hitLine, '頻道 0', '命中的是主旋律軌：' + res.results[0].hitLine);
});

t('索引格式版本：沒有版本或版本較舊的索引，下次建立時自動重建，並計入 rebuilt；版本相同的沿用', async function () {
  var recs = [
    { key: 'new', size: 1, mtimeMs: 1, melody: { sig: '1:1', status: 'ok', version: MM.INDEX_VERSION, contour: null, tracks: [] } },
    { key: 'old', size: 1, mtimeMs: 1, melody: { sig: '1:1', status: 'ok', method: 'mid', contour: null } }
  ];
  var calls = [];
  var sum = await MM.runMelodyIndex(recs, {
    extract: async function (rec) { calls.push(rec.key); return { notes: makeMelody(3, 12), method: 'mid', tracks: [] }; },
    sleep: function () { return Promise.resolve(); }
  });
  assert.deepEqual(calls, ['old'], '只有舊格式的那首重建');
  assert.equal(sum.rebuilt, 1);
  assert.equal(sum.skipped, 1);
  assert.equal(recs[1].melody.version, MM.INDEX_VERSION, '重建後寫入新版本');
});

t('合成資料校準：6 首目標曲各 4 種哼歌變形（錯音、漏音、離群音、重複音拆分）＋ 20 首隨機對照，第一名命中目標的主旋律軌；印出分數分布', function () {
  var r = rng(7), tg = [], dist = [], queries = [];
  for (var i = 0; i < 6; i++) tg.push(songSet(r, 48 + i));
  for (var j = 0; j < 20; j++) dist.push(songSet(r, 48 + j));
  var ents = tg.map(function (s, k) { return linesOf('T' + k, 'T' + k, songOf([{ notes: s.tracks[0], channel: 0 }, { notes: s.tracks[1], channel: 3 }, { notes: s.tracks[2], channel: 4 }])); })
    .concat(dist.map(function (s, k) { return linesOf('D' + k, 'D' + k, songOf([{ notes: s.tracks[0], channel: 0 }, { notes: s.tracks[1], channel: 3 }, { notes: s.tracks[2], channel: 4 }])); }));
  tg.forEach(function (s, k) {
    var seg = s.mel.slice(8, 30);
    queries.push({ k: k, kind: '錯音（20% 機率 ±1）', q: humVariant(r, seg, { drop: 0, extra: false, noJitter: true }) });
    queries.push({ k: k, kind: '漏 2 音＋音長抖動', q: humVariant(r, seg, { drop: 2, extra: false }) });
    queries.push({ k: k, kind: '多 1 音＋尾端離群', q: humVariant(r, seg, { drop: 0, outlier: true, wrong: false }) });
    queries.push({ k: k, kind: '重複音拆分＋拉伸 1.2 倍', q: humVariant(r, seg, { drop: 1, split: true }) });
  });
  var top1 = 0, tgtScores = [], distMax = [], distAll = [];
  queries.forEach(function (x) {
    var res = MM.searchMelody(x.q, ents, { minScore: 0, limit: 40 });
    var ok = res.results[0].key === 'T' + x.k && res.results[0].hitLine === '頻道 0';
    if (ok) top1++;
    var tgtR = res.results.filter(function (y) { return y.key === 'T' + x.k; })[0];
    tgtScores.push(tgtR ? tgtR.score : 0);
    var ds = res.results.filter(function (y) { return y.key[0] === 'D'; }).map(function (y) { return y.score; });
    distMax.push(ds.length ? Math.max.apply(null, ds) : 0);
    distAll = distAll.concat(ds);
  });
  var avg = distAll.reduce(function (a, b) { return a + b; }, 0) / (distAll.length || 1);
  var med = function (a) { var s = a.slice().sort(function (x, y) { return x - y; }); return s[s.length >> 1]; };
  console.log('    校準：第一名正確 ' + top1 + '/' + queries.length + '；目標分數 中位數 ' + med(tgtScores).toFixed(3) + '、最低 ' + Math.min.apply(null, tgtScores).toFixed(3) +
    '；對照每查詢最高分 中位數 ' + med(distMax).toFixed(3) + '、最高 ' + Math.max.apply(null, distMax).toFixed(3) + '；對照平均 ' + avg.toFixed(3));
  assert.ok(top1 >= 18, '第一名正確應該至少 18/24（實測見上面的數字）：' + top1 + '/' + queries.length);
  assert.ok(med(tgtScores) > med(distMax) + 0.05, '目標分數的中位數要明顯高於對照的最高分中位數');
});

t('中間聲部：同一軌三聲部（低音、旋律在中間、上面高音琶音蓋住）→ 有中聲部線，哼歌命中中聲部而不是最高音或最低音線', function () {
  var r = rng(91), mel = walkMelody(r, 40);
  // 低音與高音都「不平行」於旋律（音程隨機），所以它們的線不會因為音程一樣而誤中
  var notes = [];
  mel.forEach(function (x) {
    notes.push({ t: x.t, d: x.d, n: x.n - 10 - Math.floor(r() * 5) });        // 低音
    notes.push({ t: x.t, d: x.d, n: x.n });                                    // 旋律（中間聲部）
    notes.push({ t: x.t, d: x.d, n: x.n + 12 + Math.floor(r() * 5) });        // 高音琶音
  });
  var target = linesOf('A', '目標', songOf([{ notes: notes, channel: 0 }]));
  var other = linesOf('B', '別首', songOf([{ notes: walkMelody(rng(93), 40), channel: 0 }]));
  var labels = target.lines.map(function (x) { return x.label; });
  assert.ok(labels.indexOf('頻道 0 中聲部') >= 0 && labels.indexOf('頻道 0 最高音') >= 0 && labels.indexOf('頻道 0 最低音') >= 0, '三聲部都要有線：' + labels.join('、'));
  var q = humVariant(rng(92), mel.slice(6, 26), { drop: 1 });
  var res = MM.searchMelody(q, [target, other]);
  assert.equal(res.results[0].key, 'A', '排第一的是目標');
  assert.equal(res.results[0].hitLine, '頻道 0 中聲部', '命中的是中聲部：' + res.results[0].hitLine);
  var scoreOf = function (label) {
    var one = { key: 'A', name: 'A', lines: target.lines.filter(function (x) { return x.label === label; }) };
    var rr = MM.searchMelody(q, [one], { minScore: 0 });
    return rr.results[0] ? rr.results[0].score : 0;
  };
  assert.ok(scoreOf('頻道 0 中聲部') > scoreOf('頻道 0 最高音') + 0.2, '中聲部線明顯高於最高音線：' + scoreOf('頻道 0 中聲部') + ' vs ' + scoreOf('頻道 0 最高音'));
  assert.ok(scoreOf('頻道 0 中聲部') > scoreOf('頻道 0 最低音') + 0.2, '中聲部線明顯高於最低音線');
});

t('每首線數上限：超過 12 條時，音數多的優先、音域離中段近的優先，與已留下的重複的略過', function () {
  // 一軌有很多音（音數最多）、音域偏高；另一軌音數少、在中段。上限 11 條軌線時，音數多的先留
  var list = [];
  for (var c = 0; c < 14; c++) list.push({ notes: walkMelody(rng(200 + c), 20 + c), channel: c });
  var L = MM.songLines(songOf(list));
  assert.equal(L.tracks.length, 11, '軌線上限 11 條');
  // 音數以「合併重複音後」為準：保留的 11 條，音數都不少於被擠掉的 3 條
  var cnt = function (c) { return MM.melodyNotes(list[c].notes).length; };
  var keptCh = L.tracks.map(function (x) { return x.channel; }), dropCh = [];
  for (var c2 = 0; c2 < 14; c2++) if (keptCh.indexOf(c2) < 0) dropCh.push(c2);
  assert.equal(dropCh.length, 3, '被擠掉的應該是 3 條：' + keptCh.join(','));
  var minKept = Math.min.apply(null, keptCh.map(cnt)), maxDrop = Math.max.apply(null, dropCh.map(cnt));
  assert.ok(minKept >= maxDrop, '音數多的先留（保留最少 ' + minKept + '，被擠掉最多 ' + maxDrop + '）');
});

t('索引還原：每條線由 base＋semis＋times＋durs 還原的音高序列，與原線逐音一致（每軌的最高音／最低音／中聲部／單聲部，與合併線）', function () {
  var r = rng(91), mel = walkMelody(r, 40), notes = [];
  mel.forEach(function (x) {
    notes.push({ t: x.t, d: x.d, n: x.n - 10 - Math.floor(r() * 5) });        // 低音
    notes.push({ t: x.t, d: x.d, n: x.n });                                    // 旋律（中間）
    notes.push({ t: x.t, d: x.d, n: x.n + 12 + Math.floor(r() * 5) });        // 高音琶音
  });
  var song = songOf([{ notes: notes, channel: 0 }, { notes: walkMelody(rng(7), 30), channel: 1 }]);
  var L = MM.songLines(song);
  assert.ok(L.tracks.length >= 4, '應該有三聲部線加單聲部線：' + L.tracks.map(function (x) { return x.label; }).join('、'));
  L.tracks.forEach(function (x) {
    var rs = MM.restoreNotes(x.contour);
    assert.ok(rs, '索引有 base＋semis：' + x.label);
    assert.equal(rs.length, x.notes.length, '音數一致：' + x.label);
    rs.forEach(function (y, k) {
      assert.equal(y.n, x.notes[k][2], '音高逐音一致：' + x.label + ' #' + k);
      assert.equal(Math.round(y.t * 1000) / 1000, x.notes[k][0], '起點一致：' + x.label + ' #' + k);
      assert.equal(Math.round(y.d * 1000) / 1000, x.notes[k][1], '長度一致：' + x.label + ' #' + k);
    });
  });
  var mg = MM.contourOf(L.mix);
  assert.deepStrictEqual(MM.restoreNotes(mg).map(function (y) { return y.n; }), L.mix.map(function (x) { return x.n; }), '合併線音高逐音一致');
  assert.ok(L.tracks.some(function (x) { return x.label === '頻道 0 最低音'; }), '有最低音線');
});

t('命中資訊：結果帶出命中的軌（索引）、模式與音符索引範圍；命中的是那條軌，不是合併線；重建的那段音符時間對得上命中時間', function () {
  var mel = walkMelody(rng(61), 40), other = walkMelody(rng(62), 40);
  var song = songOf([{ notes: other, channel: 0 }, { notes: mel, channel: 3 }]);   // 第 2 軌（索引 1）、頻道 3 是目標
  var target = linesOf('A', '目標', song);
  var q = humVariant(rng(63), mel.slice(5, 25), { drop: 1, wrong: false, extra: false });
  var res = MM.searchMelody(q, [target, linesOf('B', '別首', songOf([{ notes: walkMelody(rng(64), 40), channel: 0 }]))]);
  assert.equal(res.results[0].key, 'A', '排第一的是目標');
  var h = res.results[0].hit;
  assert.equal(h.track, 1, '命中的是第 2 軌（索引 1）：' + JSON.stringify(h));
  assert.equal(h.mode, 'one', '單聲部軌的模式是 one');
  assert.equal(h.label, '頻道 3', '標籤');
  assert.equal(res.results[0].hitLine, h.label, 'hitLine 與 hit.label 一致');
  assert.ok(h.noteFrom >= 0 && h.noteTo >= h.noteFrom, '音符索引範圍：' + h.noteFrom + '–' + h.noteTo);
  assert.ok(h.line && Array.isArray(h.line.semis), 'hit 帶著索引的線（base＋semis）');
  var rb = MM.restoreNotes(h.line);
  assert.ok(Math.abs(rb[h.noteFrom].t - res.results[0].startSec) < 1e-9, '範圍起點時間對得上命中開始');
  assert.ok(Math.abs(rb[h.noteTo].t + rb[h.noteTo].d - res.results[0].endSec) < 1e-9, '範圍終點時間對得上命中結束');
});

t('命中資訊：三聲部的軌，命中中聲部時模式是 mid；合併線命中時 track 為 null、mode 為 merged', function () {
  var r = rng(91), mel = walkMelody(r, 40), notes = [];
  mel.forEach(function (x) {
    notes.push({ t: x.t, d: x.d, n: x.n - 10 - Math.floor(r() * 5) });
    notes.push({ t: x.t, d: x.d, n: x.n });
    notes.push({ t: x.t, d: x.d, n: x.n + 12 + Math.floor(r() * 5) });
  });
  var target = linesOf('A', '目標', songOf([{ notes: notes, channel: 0 }]));
  var other = linesOf('B', '別首', songOf([{ notes: walkMelody(rng(93), 40), channel: 0 }]));
  var q = humVariant(rng(92), mel.slice(6, 26), { drop: 1 });
  var res = MM.searchMelody(q, [target, other]);
  assert.equal(res.results[0].hit.mode, 'mid', '命中中聲部：' + JSON.stringify(res.results[0].hit));
  assert.equal(res.results[0].hit.track, 0);
  var mergedOnly = MM.searchMelody(q, [{ key: 'M', name: 'M', lines: [{ label: '合併（所有軌）', track: null, mode: 'merged', contour: MM.contourOf(MM.songLines(songOf([{ notes: notes, channel: 0 }])).mix) }] }], { minScore: 0 });
  assert.equal(mergedOnly.results[0].hit.track, null, '合併線：track 為 null');
  assert.equal(mergedOnly.results[0].hit.mode, 'merged');
});

t('對照聽的音符：命中段整段以八度平移，中位音高落在哼歌 ±6 半音內；音程與音長不變；哼歌與命中段間隔 0.8 秒；超出音域的音也跟著平移不截斷', function () {
  var seg = walkMelody(rng(71), 16);
  var hum = seg.map(function (x) { return { t: x.t * 1.2, d: x.d * 1.2, n: x.n + 5 }; });   // 哼歌：同一段，唱高 5 半音、慢 1.2 倍
  [19, -25, 0, 30].forEach(function (off) {
    var hit = seg.map(function (x) { return { t: 10 + x.t, d: x.d, n: x.n + off }; });   // 命中段在原曲的 10 秒起，音域偏移 off
    var c = MM.compareNotes(hum, hit);
    assert.equal(c.shift % 12, 0, '平移是八度（12 的倍數）：' + c.shift);
    assert.ok(Math.abs(c.hitMedian - c.humMedian) <= 6, 'off ' + off + '：命中段中位 ' + c.hitMedian + '，哼歌中位 ' + c.humMedian);
    var humEnd = Math.max.apply(null, hum.map(function (x) { return x.t + x.d; }));
    assert.ok(Math.abs(c.hit[0].t - (humEnd + 0.8)) < 1e-9, 'off ' + off + '：間隔 0.8 秒');
    assert.equal(c.hit.length, hit.length, '音數不變（不截斷）');
    c.hit.forEach(function (x, k) {
      assert.equal(x.n - hit[k].n, c.shift, '整段同一個平移量');
      assert.ok(Math.abs(x.d - hit[k].d) < 1e-12, '音長不變');
      assert.ok(Math.abs((x.t - c.hit[0].t) - (hit[k].t - hit[0].t)) < 1e-9, '段內時間不變');
    });
  });
});

t('對照聽：哼歌跟命中段的音程，容許哼歌誤差（錯音、漏音、拉伸），大部分音程仍相同', function () {
  var seg = walkMelody(rng(81), 24);
  var hum = humVariant(rng(82), seg, { drop: 0, extra: false, noJitter: true });
  var hit = seg.map(function (x) { return { t: 20 + x.t, d: x.d, n: x.n + 14 }; });
  var c = MM.compareNotes(hum, hit);
  var iv = function (ns) { var o = []; for (var i = 0; i + 1 < ns.length; i++) o.push(ns[i + 1].n - ns[i].n); return o; };
  var a = iv(c.hum), b = iv(c.hit.map(function (x) { return { n: x.n - c.shift }; }));   // 把平移還回去，只比音程
  var ok = 0; for (var k = 0; k < Math.min(a.length, b.length); k++) if (Math.abs(a[k] - b[k]) <= 2) ok++;
  assert.ok(ok / Math.min(a.length, b.length) >= 0.75, '音程相同或只差 ≤2 半音的比例：' + ok + '/' + Math.min(a.length, b.length));
  // 哼歌的音數與段內的音程序列都不因平移而改變
  assert.equal(c.hum.length, hum.length, '哼歌音數不變');
});

t('索引存 base＋semis：base 是第一音，semis 是未截斷的相鄰差，比對用的 intervals 仍截斷到 ±12；舊版（沒有 semis）還原回傳 null', function () {
  var mel = [{ t: 0, d: 1, n: 60 }, { t: 1, d: 1, n: 80 }, { t: 2, d: 1, n: 79 }];
  var c = MM.contourOf(mel);
  assert.equal(c.base, 60, 'base 是第一音');
  assert.deepStrictEqual(c.semis, [20, -1], 'semis 未截斷');
  assert.deepStrictEqual(c.intervals, [12, -1], '比對用的 intervals 仍截斷到 ±12');
  assert.deepStrictEqual(MM.restoreNotes(c).map(function (y) { return y.n; }), [60, 80, 79], '還原的音高');
  assert.equal(MM.restoreNotes({ n: 2, times: [0, 1], durs: [1, 1], intervals: [1] }), null, '舊版索引沒有 semis：null');
});

t('對照聽只改 base：命中段以八度平移（base 改 12 的倍數）；音程不變；中位音高落在哼歌 ±6 內', function () {
  var mel = walkMelody(rng(61), 40), other = walkMelody(rng(62), 40);
  var song = songOf([{ notes: other, channel: 0 }, { notes: mel, channel: 3 }]);
  var target = linesOf('A', '目標', song);
  var q = humVariant(rng(63), mel.slice(5, 25), { drop: 1, wrong: false, extra: false });
  var hit = MM.searchMelody(q, [target]).results[0].hit;
  var res = MM.compareHit(hit.line, hit, q);
  assert.equal(res.shift % 12, 0, '平移是八度');
  assert.equal(res.base, hit.line.base + res.shift, 'base 只加上平移量');
  assert.ok(Math.abs(res.cmp.hitMedian - res.cmp.humMedian) <= 6, '中位音高在哼歌 ±6 內');
  var seg = MM.restoreNotes(hit.line).slice(hit.noteFrom, hit.noteTo + 1);
  var iv = function (ns) { var o = []; for (var i = 0; i + 1 < ns.length; i++) o.push(ns[i + 1].n - ns[i].n); return o; };
  assert.deepStrictEqual(iv(res.cmp.hit), iv(seg), '音程與原線相同（只移位）');
});

t('對照聽：舊版索引（沒有 semis）不能對照，回傳「請重建旋律索引」的訊息', function () {
  var hum = [{ t: 0, d: 0.5, n: 60 }, { t: 0.5, d: 0.5, n: 62 }];
  assert.throws(function () { MM.compareHit({ n: 2, times: [0, 1], durs: [1, 1], intervals: [2] }, { noteFrom: 0, noteTo: 1 }, hum); }, /請重建旋律索引/);
});

t('索引格式版本升為 3（舊版 2 的索引下次建立會自動重建）', function () {
  assert.equal(MM.INDEX_VERSION, 3);
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
