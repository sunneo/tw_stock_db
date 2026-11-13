/* 音樂作曲（music）訓練的純函式核心（UMD，node 可測）。訓練本體在 music_train.py（小型因果 Transformer，從零開始，CPU）。
 * 資料來源：程式作曲 renderer/src/music/music_compose.js（有種子，同種子同曲子）的主旋律軌。這不是人類作品，也不是預訓練模型的微調。
 * 符號：BOS、EOS、PAD、風格（S:pop…）、G0～G32（時間前進幾個 16 分音符，超過 32 就連用多個）、P<音高 55～91>、D1～D16（幾個 16 分音符）。
 * 一個音符＝ G* P D（先前進時間，再下音）。句子＝ BOS S:<風格> (G* P D)* EOS。
 * 量化：16 分音符＝120 ticks（ppq 480）。持續至少 1 格，最多 16 格（超過的會被截，記錄在 quant 統計）。
 * 命令列：
 *   node music_train_core.js gen <輸出目錄> <每風格首數> <種子起點> <留出數>  → train.jsonl、eval.jsonl、vocab.json、index.json
 *   node music_train_core.js decode <samples.jsonl> <輸出目錄> [MIDI 數]     → metrics.json＋前幾首 .mid（經 midi_core 驗證與寫出）
 * 測試：renderer/src/studio/music_train_core.test.js */
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('../music/music_compose.js'), require('../music/midi_core.js')); else (root.FaMusicTrain = factory(root.FaMusicCompose, root.FaMidi)); })(typeof self !== 'undefined' ? self : this, function (C, M) {
  'use strict';
  var GRID = 120, PAD = 0, BOS = 1, EOS = 2, PMIN = 55, PMAX = 91, DMAX = 16, GMAX = 32, MAXLEAP = 9;
  var STYLES = Object.keys((C && C.STYLES) || { pop: 1, rock: 1, jazz: 1, blues: 1, waltz: 1, folk: 1, lofi: 1, edm: 1, classical: 1 });

  // 詞彙表（固定順序，所以 id 穩定）
  function buildVocab() {
    var toks = ['<pad>', '<bos>', '<eos>'];
    STYLES.forEach(function (s) { toks.push('S:' + s); });
    var g, p, d;
    for (g = 0; g <= GMAX; g++) toks.push('G' + g);
    for (p = PMIN; p <= PMAX; p++) toks.push('P' + p);
    for (d = 1; d <= DMAX; d++) toks.push('D' + d);
    var id = {}; toks.forEach(function (t, i) { id[t] = i; });
    return { tokens: toks, id: id, size: toks.length };
  }
  var VOCAB = buildVocab();

  // 旋律軌 → 符號。回傳 { tokens:[字串], quant:{notes, clampedDur, clampedGap, outOfRange} }
  function songToTokens(song, style) {
    var lead = song && song.tracks && song.tracks[0], notes = (lead && lead.notes) || [];
    var out = ['<bos>', 'S:' + style], q = { notes: 0, clampedDur: 0, clampedGap: 0, outOfRange: 0 };
    var sorted = notes.slice().sort(function (a, b) { return a.t - b.t || a.n - b.n; });
    var cursor = 0; // 以格計
    sorted.forEach(function (n) {
      var on = Math.max(0, Math.round(n.t / GRID)), dur = Math.max(1, Math.round(n.d / GRID));
      if (n.n < PMIN || n.n > PMAX) { q.outOfRange++; return; }
      if (dur > DMAX) { dur = DMAX; q.clampedDur++; }
      var gap = on - cursor; if (gap < 0) { gap = 0; q.clampedGap++; }
      while (gap > GMAX) { out.push('G' + GMAX); gap -= GMAX; }
      out.push('G' + gap, 'P' + n.n, 'D' + dur);
      cursor = on; q.notes++;
    });
    out.push('<eos>');
    return { tokens: out, quant: q };
  }

  // 符號 → 音符（時間以格計，之後乘 GRID）。錯誤不丟例外，回傳 ok=false 與原因。
  function tokensToNotes(tokens) {
    var errs = [], notes = [], cursor = 0, state = 'start', pending = null, sawEos = false, i, t;
    if (!tokens || tokens[0] !== '<bos>') return { ok: false, errors: ['開頭不是 <bos>'], notes: [], cursor: 0, endedWithEos: false };
    if (tokens[1] && tokens[1].indexOf('S:') !== 0) errs.push('第二個符號不是風格');
    for (i = 2; i < tokens.length; i++) {
      t = tokens[i];
      if (sawEos) { errs.push('<eos> 之後還有符號'); break; }
      if (t === '<eos>') { sawEos = true; if (state === 'pitch' || pending) errs.push('音符缺持續時間'); continue; }
      if (/^G\d+$/.test(t)) { if (state === 'pitch') errs.push('G 出現在 P 與 D 之間'); var g = +t.slice(1); if (g > GMAX) errs.push('G 超出範圍'); if (state !== 'pitch') cursor += g; state = 'gap'; continue; }
      if (/^P\d+$/.test(t)) { if (state === 'pitch') errs.push('P 連續出現'); var p = +t.slice(1); if (p < PMIN || p > PMAX) errs.push('音高超出範圍'); pending = { n: p, start: cursor }; state = 'pitch'; continue; }
      if (/^D\d+$/.test(t)) { if (state !== 'pitch' || !pending) { errs.push('D 前面沒有 P'); state = 'gap'; continue; } var d = +t.slice(1); if (d < 1 || d > DMAX) errs.push('D 超出範圍'); notes.push({ n: pending.n, t: pending.start, d: d }); pending = null; state = 'dur'; continue; }
      errs.push('不認得的符號 ' + t); break;
    }
    if (!sawEos) errs.push('沒有 <eos>（句子沒有結束）');
    return { ok: errs.length === 0, errors: errs, notes: notes, cursor: cursor, endedWithEos: sawEos };
  }

  // 符號 → 可寫出的曲子（與 midi_core 同格式；速度與拍號用固定值）
  function tokensToSong(tokens, opts) {
    var o = opts || {}, parsed = tokensToNotes(tokens);
    var notes = parsed.notes.map(function (n) { return { t: n.t * GRID, d: n.d * GRID, n: n.n, v: o.velocity || 90 }; });
    var song = { ppq: 480, tempos: [{ t: 0, bpm: o.bpm || 105 }], timesig: { n: 4, d: 4 }, title: o.title || 'generated',
      tracks: [{ name: '旋律', channel: 0, program: 80, drum: false, volume: 100, pan: 64, notes: notes }] };
    return { song: M.validate(song), parsed: parsed };
  }

  // 指標：句子是否合格；相鄰音高跳進 ≤ 9 半音的比例（與 music_compose 的跳進規則同）
  function leapOkRate(notes) {
    var ok = 0, n = 0;
    for (var i = 1; i < notes.length; i++) { n++; if (Math.abs(notes[i].n - notes[i - 1].n) <= MAXLEAP) ok++; }
    return { ok: ok, total: n, rate: n === 0 ? 0 : ok / n };
  }
  function sampleMetrics(samples) {
    var valid = 0, tot = 0, leapOk = 0, leapN = 0, notesN = 0, pitchIn = 0;
    samples.forEach(function (tokens) {
      var p = tokensToNotes(tokens); tot++;
      if (p.ok) valid++;
      var l = leapOkRate(p.notes); leapOk += l.ok; leapN += l.total; notesN += p.notes.length;
      p.notes.forEach(function (x) { if (x.n >= PMIN && x.n <= PMAX) pitchIn++; });
    });
    return { songs: tot, grammar_valid: valid, grammar_valid_rate: tot ? valid / tot : 0, notes: notesN,
      leap_ok_rate: leapN ? leapOk / leapN : 0, pitch_in_range_rate: notesN ? pitchIn / notesN : 0 };
  }

  // 切分：第 k 首（依種子排序後）→ 留出；確定性（種子模 5 == 0 為留出）。實際留出數量由 gen 參數決定
  function songsFor(style, perStyle, seedBase) {
    var list = [];
    for (var k = 0; k < perStyle; k++) list.push({ style: style, seed: seedBase + k, bars: 16 });
    return list;
  }
  function generateCorpus(perStyle, seedBase, heldOutPerStyle) {
    var train = [], evals = [], st;
    STYLES.forEach(function (style) {
      var items = songsFor(style, perStyle, seedBase);
      items.forEach(function (it, k) {
        var r = C.compose({ style: style, key: 'C', bars: 16, seed: it.seed });
        var enc = songToTokens(r.song, style);
        var row = { style: style, seed: r.seed, ids: enc.tokens.map(function (t) { return VOCAB.id[t]; }), quant: enc.quant, warnings: r.warnings.length };
        (k < heldOutPerStyle ? evals : train).push(row);
      });
    });
    return { train: train, eval: evals };
  }

  return { VOCAB: VOCAB, STYLES: STYLES, GRID: GRID, PMIN: PMIN, PMAX: PMAX, buildVocab: buildVocab, songToTokens: songToTokens,
    tokensToNotes: tokensToNotes, tokensToSong: tokensToSong, leapOkRate: leapOkRate, sampleMetrics: sampleMetrics, generateCorpus: generateCorpus };
});

// ---- 命令列 ----
if (typeof require === 'function' && typeof module === 'object' && require.main === module) {
  var fs = require('fs'), path = require('path');
  var A = module.exports, cmd = process.argv[2];
  if (cmd === 'gen') {
    var outDir = process.argv[3], perStyle = parseInt(process.argv[4], 10), seedBase = parseInt(process.argv[5] || '1', 10), held = parseInt(process.argv[6] || '2', 10);
    fs.mkdirSync(outDir, { recursive: true });
    var corpus = A.generateCorpus(perStyle, seedBase, held);
    fs.writeFileSync(path.join(outDir, 'train.jsonl'), corpus.train.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'eval.jsonl'), corpus.eval.map(function (r) { return JSON.stringify(r); }).join('\n') + '\n');
    fs.writeFileSync(path.join(outDir, 'vocab.json'), JSON.stringify({ format: 'fa-music-vocab', version: 1, tokens: A.VOCAB.tokens }, null, 0));
    var q = corpus.train.reduce(function (s, r) { s.notes += r.quant.notes; s.clampedDur += r.quant.clampedDur; s.clampedGap += r.quant.clampedGap; s.outOfRange += r.quant.outOfRange; s.maxLen = Math.max(s.maxLen, r.ids.length); return s; }, { notes: 0, clampedDur: 0, clampedGap: 0, outOfRange: 0, maxLen: 0 });
    console.log(JSON.stringify({ train: corpus.train.length, eval: corpus.eval.length, vocab: A.VOCAB.size, train_quant: q, styles: A.STYLES.length }));
  } else if (cmd === 'decode') {
    var sPath = process.argv[3], dOut = process.argv[4], midiN = parseInt(process.argv[5] || '3', 10);
    fs.mkdirSync(dOut, { recursive: true });
    var rows = fs.readFileSync(sPath, 'utf8').split('\n').filter(function (l) { return l.trim(); }).map(function (l) { return JSON.parse(l); });
    var toks = rows.map(function (r) { return r.tokens.map(function (id) { return A.VOCAB.tokens[id]; }); });
    var m = A.sampleMetrics(toks);
    fs.writeFileSync(path.join(dOut, 'metrics.json'), JSON.stringify(m, null, 1));
    toks.slice(0, midiN).forEach(function (t, k) {
      var r = A.tokensToSong(t, { title: 'sample ' + k });
      if (r.parsed.ok) fs.writeFileSync(path.join(dOut, 'sample_' + k + '.mid'), Buffer.from(require('../music/midi_core.js').write(r.song)));
    });
    console.log(JSON.stringify(m));
  }
}
