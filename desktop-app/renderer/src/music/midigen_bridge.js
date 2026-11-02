// midigenai 與我們作曲樹的橋(設計見 DESIGN.music.md「midigenai 查證與整合設計」)。三層退路:模型生成 → 由上而下拆解作曲(compose_tree)→ 範本(compose_tree 內各節點)。
// midigenai 的輸入是 MIDI 不是文字:先由作曲樹產生種子(旋律、和弦、貝斯、鼓),只把旋律軌交給模型,請它補貝斯、鼓、和弦聲部;
// 每個聲部獨立:生成 → 程式驗證修正(吸附到調內、音域、小節數、鼓軌是鼓)→ 不合格重生(最多 retries 次)→ 仍不合格那個聲部用作曲樹的原聲部。
//   unsupported(tree) → '' 或超出模型範圍的原因   FaMidigenBridge.compose(tree, seed, { engine, timeoutMs, retries, onStep }) → Promise<{ song, layer, layers, reason, warnings, fixes, tries, sections, seed }>
//   engine:{ accompany(bytes, { bars, instrument, seed, tempoBpm }) → Promise<{ midi: Uint8Array }> },沒有就整首用作曲樹並寫明原因;engine 丟出 { fatal:true } 代表模型壞了,其餘聲部不再試
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./midi_core.js'), require('./music_compose.js'), require('./compose_tree.js')); else root.FaMidigenBridge = factory(root.FaMidi || (typeof FaMidi !== 'undefined' ? FaMidi : undefined), root.FaMidiCompose || (typeof FaMidiCompose !== 'undefined' ? FaMidiCompose : undefined), root.FaComposeTree || (typeof FaComposeTree !== 'undefined' ? FaComposeTree : undefined)); })(typeof self !== 'undefined' ? self : this, function (M, C, T) {
  'use strict';
  const FAMILY = ['Piano', 'ChromPerc', 'Organ', 'Guitar', 'Bass', 'Strings', 'Ensemble', 'Brass', 'Reed', 'Pipe', 'SynthLead', 'SynthPad', 'SynthFX', 'Ethnic', 'Percussive', 'SoundFX'];
  const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10], MAX_BARS = 16;
  const withTimeout = (p, ms) => new Promise((res, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('逾時 ' + Math.round(ms / 1000) + ' 秒'), { timeout: true })), ms); Promise.resolve(p).then((v) => { clearTimeout(t); res(v); }, (e) => { clearTimeout(t); rej(e); }); });
  // 超出模型範圍(使用者:模型處理不了才退回拆解):拍號不是 4/4、超過一次能處理的小節數、速度在模型標頭範圍外
  function unsupported(tree) {
    const st = C.STYLES[tree.style]; if (!st) return '不認得的風格'; if (st.timesig[0] !== 4 || st.timesig[1] !== 4) return '這個風格不是 4/4 拍,模型只認 4/4';
    if (tree.bars > MAX_BARS) return '曲子 ' + tree.bars + ' 小節,超過模型一次能補的 ' + MAX_BARS + ' 小節'; if (tree.tempo < 40 || tree.tempo > 220) return '速度 ' + tree.tempo + ' 超出模型標頭的範圍'; return '';
  }
  const voicesOf = (tree, song) => {
    const st = C.STYLES[tree.style]; const out = [{ id: 'bass', label: '貝斯', ti: 2, instrument: 'Bass', range: [24, 67], pitched: true }];
    if (song.tracks[3] && song.tracks[3].drum) out.push({ id: 'drums', label: '鼓', ti: 3, instrument: 'Drums', range: [27, 87], pitched: false });
    out.push({ id: 'chords', label: '和弦', ti: 1, instrument: FAMILY[Math.min(15, Math.floor(st.inst.chord / 8))], range: [40, 88], pitched: true }); return out;
  };
  // 驗證與修正一個模型生成的聲部;回傳 { notes, fixes } 或 { problem }
  function checkVoice(track, v, tree, ppq) {
    if (!track || !track.notes || !track.notes.length) return { problem: '模型沒生成音符' }; const k = 480 / (ppq || 480); const bpbT = 4 * 480, endT = tree.bars * bpbT + 240; let fixes = 0;
    if (!v.pitched && !track.drum) return { problem: '鼓聲部生成的不是鼓軌' }; if (v.pitched && track.drum) return { problem: '要的是有音高的聲部,生成了鼓軌' };
    const steps = tree.mode === 'minor' ? MINOR : MAJOR, pc0 = C.KEYS[tree.key] == null ? 0 : C.KEYS[tree.key]; const inScale = (pc) => steps.indexOf(((pc - pc0) % 12 + 12) % 12) >= 0;
    const notes = []; track.notes.forEach((n) => {
      const t = Math.round(n.t * k), d = Math.max(1, Math.round(n.d * k)); if (t >= endT) { fixes++; return; } let p = n.n;
      if (v.pitched) { while (p < v.range[0]) { p += 12; fixes++; } while (p > v.range[1]) { p -= 12; fixes++; } if (!inScale(p)) { p += inScale(p - 1) ? -1 : 1; fixes++; } }
      notes.push({ t, d: Math.min(d, endT - t), n: p, v: n.v });
    });
    const bars = new Set(notes.map((n) => Math.floor(n.t / bpbT))); if (bars.size < Math.ceil(tree.bars * 0.6)) return { problem: '只覆蓋 ' + bars.size + ' / ' + tree.bars + ' 小節' };
    if (notes.length < tree.bars * (v.pitched ? 1 : 2)) return { problem: '音符太少(' + notes.length + ')' };
    return { notes, fixes };
  }
  async function compose(tree, seed, o) {
    o = o || {}; const step = o.onStep || (() => {}); seed = Number(seed) || 1; const retries = o.retries == null ? 2 : o.retries, timeoutMs = o.timeoutMs || 90000;
    const base = T.compose(tree, seed); const res = { song: base.song, layer: 'tree', layers: [], reason: '', warnings: (base.warnings || []).slice(), fixes: 0, tries: base.tries, sections: base.sections, seed: base.seed, style: base.style, options: base.options };
    const why = !o.engine ? (o.noEngineReason || '模型沒下載或沒載入') : unsupported(tree); const voices = voicesOf(tree, base.song);
    if (why) { res.reason = why; res.layers = voices.map((v) => ({ voice: v.id, label: v.label, layer: 'tree', reason: why })); return res; }
    if (base.fallback) { res.reason = '作曲樹自己退回了範本,沒有種子可交給模型'; res.layers = voices.map((v) => ({ voice: v.id, label: v.label, layer: 'tree', reason: res.reason })); return res; }
    const lead = base.song.tracks[0]; const bytes = M.write(Object.assign({}, base.song, { tracks: [lead] })); let dead = '';
    const song = JSON.parse(JSON.stringify(base.song));
    for (const v of voices) {
      const L = { voice: v.id, label: v.label, layer: 'tree', reason: '', tries: 0 }; res.layers.push(L);
      if (dead) { L.reason = dead; continue; }
      for (let a = 0; a <= retries && L.layer !== 'model'; a++) {
        L.tries = a + 1; step('請模型補「' + v.label + '」第 ' + (a + 1) + ' 次…');
        try {
          const r = await withTimeout(o.engine.accompany(bytes, { bars: tree.bars, instrument: v.instrument, seed: seed * 7 + a, tempoBpm: tree.tempo }), timeoutMs);
          const parsed = M.parse(r.midi); const gen = parsed.tracks.slice(1).filter((t) => t.notes && t.notes.length)[0]; const c = checkVoice(gen, v, tree, parsed.ppq);
          if (c.problem) { L.reason = c.problem; step('「' + v.label + '」' + c.problem); continue; }
          song.tracks[v.ti].notes = c.notes; res.fixes += c.fixes; L.layer = 'model'; L.reason = c.fixes ? '程式修正了 ' + c.fixes + ' 處(吸附調內、音域、超出小節)' : '';
        } catch (e) {
          L.reason = e && e.timeout ? String(e.message) : '模型出錯:' + String((e && e.message) || e); step('「' + v.label + '」' + L.reason); if (e && e.fatal) { dead = L.reason; break; } if (e && e.timeout) break;
        }
      }
      if (L.layer !== 'model') L.reason = '用作曲樹的原聲部(' + (L.reason || '沒有結果') + ')';
    }
    const n = res.layers.filter((l) => l.layer === 'model').length; res.layer = n === 0 ? 'tree' : n === res.layers.length ? 'model' : 'partial';
    if (n === 0) res.reason = '模型沒有任何聲部通過驗證,整首用作曲樹'; res.song = M.validate(song); return res;
  }
  // 找已下載的模型:跟離線模型管理列表用同一個 FaAudioModels.status;沒找到時說明每個候選找了哪個鍵、看到幾片、缺哪幾片、多少位元組
  async function findModel(ids, statusFn) {
    const facts = [];
    for (const id of ids) {
      let st = null, err = '';
      try { st = await statusFn(id); } catch (e) { err = String((e && e.message) || e); }
      if (st && st.complete) return { id, status: st };
      if (err) facts.push(id + ':讀取下載狀態失敗(' + err + ')');
      else if (st) facts.push(id + ':找鍵 ' + (st.keyPrefix || '') + '0~' + (st.total - 1) + ',看到 ' + st.chunks + ' / ' + st.total + ' 片、' + st.have + ' / ' + st.bytes + ' 位元組' + (st.chunks && st.missing && st.missing.length ? ',缺第 ' + st.missing.map((i) => i + 1).join('、') + ' 片' : ''));
    }
    const part = facts.some((f) => /看到 [1-9]/.test(f));
    return { id: null, reason: (part ? '模型只下載了一部分(' : '模型還沒下載(') + facts.join(';') + ')。到 Configure → 離線模型管理 → 音樂 → midigenai v5 ' + (part ? '續傳' : '下載') };
  }
  const MANIFEST = { version: 'v5', vocab_size: 598, n_layers: 12, n_heads: 12, head_dim: 64, opset: 17, files: { gpu: { file: 'decoder-webgpu-q4.onnx', bytes: 73151835, sha256: '7c5de98ff7460bd88d07acc537c6e238f0a4afce29b8c9ad488eb97f99bdbfdf', quant: 'q4', cache: 'present, (1,H,P,D)' }, cpu: { file: 'decoder-wasm-int8.onnx', bytes: 114561179, sha256: '5ca00f42ba3900aeb6d98821d4e8b559a880c8d99d62dbdc0d1555a38c1eed65', quant: 'int8', cache: 'new-rows, time-major (1,P,H,D)' } } };
  return { MANIFEST, findModel, unsupported, compose, checkVoice, voicesOf, MAX_BARS };
});
