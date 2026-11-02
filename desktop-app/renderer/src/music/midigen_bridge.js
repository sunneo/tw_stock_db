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
    if (tree.tempo < 40 || tree.tempo > 220) return '速度 ' + tree.tempo + ' 超出模型標頭的範圍'; return '';
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
  // 長曲子分段補:每段最多 MAX_BARS 小節,後一段的開頭和前一段重疊 ov 小節(重疊處以前一段已定的音當條件,只收自己負責的部分,不重複寫入也不漏)
  function segmentsOf(bars, maxSeg, ov) {
    maxSeg = maxSeg || MAX_BARS; ov = ov == null ? 2 : ov; if (bars <= maxSeg) return [{ s: 0, e: bars, own: 0 }]; const out = []; let s = 0;
    for (;;) { const e = Math.min(bars, s + maxSeg); out.push({ s, e, own: out.length ? s + ov : 0 }); if (e >= bars) break; s = e - ov; } return out;
  }
  const BPB_T = 4 * 480; const cloneTrack = (tr, notes) => Object.assign({}, tr, { notes });
  async function compose(tree, seed, o) {
    o = o || {}; const step = o.onStep || (() => {}); seed = Number(seed) || 1; const retries = o.retries == null ? 2 : o.retries, timeoutMs = o.timeoutMs || 90000, budgetMs = o.budgetMs || timeoutMs * 4, ov = o.overlap == null ? 2 : o.overlap;
    const base = T.compose(tree, seed); const res = { song: base.song, layer: 'tree', layers: [], reason: '', warnings: (base.warnings || []).slice(), fixes: 0, tries: base.tries, sections: base.sections, seed: base.seed, style: base.style, options: base.options };
    const why = !o.engine ? (o.noEngineReason || '模型沒下載或沒載入') : unsupported(tree); const voices = voicesOf(tree, base.song);
    if (why) { res.reason = why; res.layers = voices.map((v) => ({ voice: v.id, label: v.label, layer: 'tree', reason: why })); return res; }
    if (base.fallback) { res.reason = '作曲樹自己退回了範本,沒有種子可交給模型'; res.layers = voices.map((v) => ({ voice: v.id, label: v.label, layer: 'tree', reason: res.reason })); return res; }
    const lead = base.song.tracks[0]; const song = JSON.parse(JSON.stringify(base.song)); const segs = segmentsOf(tree.bars, MAX_BARS, ov); const deadline = Date.now() + budgetMs; let dead = '';
    const inRange = (notes, from, to) => notes.filter((n) => n.t >= from && n.t < to);
    for (const v of voices) {
      const L = { voice: v.id, label: v.label, layer: 'tree', reason: '', tries: 0, segments: [] }; res.layers.push(L); const treeNotes = base.song.tracks[v.ti].notes || []; const decided = [];
      for (let k = 0; k < segs.length; k++) {
        const g = segs[k]; const SR = { from: g.own + 1, to: g.e, layer: 'tree', reason: '', tries: 0 }; L.segments.push(SR); const label = segs.length > 1 ? '(第 ' + (g.own + 1) + '–' + g.e + ' 小節)' : '';
        const fallbackNotes = () => decided.push(...inRange(treeNotes, g.own * BPB_T, g.e * BPB_T).map((n) => Object.assign({}, n)));
        if (dead) { SR.reason = dead; fallbackNotes(); continue; }
        // 這一段的條件:旋律軌切出 [s, e) 平移到 0;不是第一段就再附上重疊處已定的伴奏音(平移後同樣在開頭)
        const leadSeg = cloneTrack(lead, inRange(lead.notes, g.s * BPB_T, g.e * BPB_T).map((n) => Object.assign({}, n, { t: n.t - g.s * BPB_T, d: Math.min(n.d, g.e * BPB_T - n.t) })));
        const ctxNotes = k ? inRange(decided, g.s * BPB_T, g.own * BPB_T).map((n) => Object.assign({}, n, { t: n.t - g.s * BPB_T })) : []; const tracksIn = ctxNotes.length ? [leadSeg, cloneTrack(base.song.tracks[v.ti], ctxNotes)] : [leadSeg];
        const bytes = M.write(Object.assign({}, base.song, { tracks: tracksIn })); const segTree = Object.assign({}, tree, { bars: g.e - g.s });
        for (let a = 0; a <= retries && SR.layer !== 'model'; a++) {
          const remain = deadline - Date.now(); if (remain <= 0) { SR.reason = '整體時間預算用完(' + Math.round(budgetMs / 1000) + ' 秒)'; dead = dead || SR.reason; break; }
          SR.tries++; L.tries++; step('請模型補「' + v.label + '」' + label + '第 ' + (a + 1) + ' 次…');
          try {
            const r = await withTimeout(o.engine.accompany(bytes, { bars: g.e - g.s, instrument: v.instrument, seed: seed * 7 + a + k * 101, tempoBpm: tree.tempo }), Math.min(timeoutMs, remain));
            const parsed = M.parse(r.midi); const gen = parsed.tracks.slice(tracksIn.length).filter((t) => t.notes && t.notes.length)[0]; const c = checkVoice(gen, v, segTree, parsed.ppq);
            if (c.problem) { SR.reason = c.problem; step('「' + v.label + '」' + label + c.problem); continue; }
            decided.push(...c.notes.map((n) => Object.assign({}, n, { t: n.t + g.s * BPB_T })).filter((n) => n.t >= g.own * BPB_T && n.t < g.e * BPB_T + 240)); res.fixes += c.fixes; SR.layer = 'model'; SR.reason = c.fixes ? '程式修正了 ' + c.fixes + ' 處(吸附調內、音域、超出小節)' : '';
          } catch (e) {
            SR.reason = e && e.timeout ? String(e.message) : '模型出錯:' + String((e && e.message) || e); step('「' + v.label + '」' + label + SR.reason); if (e && e.fatal) { dead = SR.reason; break; } if (e && e.timeout) break;
          }
        }
        if (SR.layer !== 'model') { SR.reason = '用作曲樹的結果(' + (SR.reason || '沒有結果') + ')'; fallbackNotes(); }
      }
      const okSeg = L.segments.filter((x) => x.layer === 'model').length; L.layer = okSeg === 0 ? 'tree' : okSeg === L.segments.length ? 'model' : 'partial';
      if (okSeg) song.tracks[v.ti].notes = decided.sort((x, y) => x.t - y.t || x.n - y.n);
      if (L.segments.length === 1) L.reason = L.layer === 'model' ? L.segments[0].reason : '用作曲樹的原聲部(' + L.segments[0].reason.replace(/^用作曲樹的結果\(|\)$/g, '') + ')';
      else { const lab = (x) => '第 ' + x.from + '–' + x.to + ' 小節'; const okL = L.segments.filter((x) => x.layer === 'model').map(lab), bad = L.segments.filter((x) => x.layer !== 'model'); L.reason = (okL.length ? '模型:' + okL.join('、') : '') + (bad.length ? (okL.length ? ';' : '') + '作曲樹:' + bad.map((x) => lab(x) + ' ' + x.reason).join('、') : ''); if (!okL.length) L.reason = '用作曲樹的原聲部(' + L.reason + ')'; }
    }
    const n = res.layers.filter((l) => l.layer === 'model').length, np = res.layers.filter((l) => l.layer !== 'tree').length; res.layer = np === 0 ? 'tree' : n === res.layers.length ? 'model' : 'partial';
    if (np === 0) res.reason = '模型沒有任何聲部通過驗證,整首用作曲樹'; res.segments = segs.length; res.song = M.validate(song); return res;
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
  // ---------- 裝置選擇(跟其他離線模型一樣:依「運算裝置」偏好排順序,失敗自動降級,記住已驗證的裝置) ----------
  // 對使用者 midigenai 是「一個模型」;webgpu 對應 4 位元 GPU 檔、wasm 對應 8 位元 CPU 檔,哪個檔下載、哪個裝置用由程式決定。
  const DEV_NAME = { webgpu: 'WebGPU', wasm: 'CPU' }, DEV_FILE = { webgpu: 'midigenai-v5-gpu', wasm: 'midigenai-v5-cpu' };
  // o:{ order:['webgpu','wasm'], has(dev)→bool(這個裝置要的檔已下載), ensure(dev)→{ok,reason}(沒下載時依靜默下載設定下載或先問), load(dev)→engine, smoke(engine,dev)→{ms}, record:{verified,failures}(會被改寫,呼叫端存起來), envKey, now() }
  // 規則:已下載的裝置排前面(不為了更快的裝置去多下載一份);同一個環境(ort 版本、顯示卡、偏好)記錄過失敗的裝置不重踩(除非沒有別的可試);已驗證的裝置下次不再跑冒煙測試;
  // 載入或冒煙測試失敗就記原因並換下一個裝置;檔案沒下載成(使用者取消、下載失敗)不算裝置的失敗。
  async function openSession(o) {
    const rec = o.record = o.record || {}; rec.failures = rec.failures || {}; const now = o.now || (() => Date.now()); const msg = (e) => String((e && e.message) || e);
    const present = [], missing = []; for (const d of o.order) ((await o.has(d)) ? present : missing).push(d); const list = present.concat(missing);
    let usable = list.filter((d) => !(rec.failures[d] && rec.failures[d].env === o.envKey)); const skipped = list.filter((d) => usable.indexOf(d) < 0);
    if (!usable.length) { usable = list.slice(-1); skipped.splice(skipped.indexOf(usable[0]), 1); } const tried = [];
    for (const dev of usable) {
      const t0 = now();
      try {
        const e = await o.ensure(dev); if (!e || !e.ok) { tried.push({ device: dev, ok: false, file: true, reason: (e && e.reason) || '檔案沒準備好' }); continue; }
        const engine = await o.load(dev); const v = rec.verified && rec.verified.device === dev && rec.verified.env === o.envKey; let ms = v ? rec.verified.ms : null;
        if (!v) { const sm = await o.smoke(engine, dev); ms = sm && sm.ms != null ? sm.ms : now() - t0; rec.verified = { device: dev, env: o.envKey, ms, at: now() }; }
        delete rec.failures[dev]; tried.push({ device: dev, ok: true, ms }); return { engine, device: dev, tried, skipped, record: rec };
      } catch (err) {
        const reason = DEV_NAME[dev] + '(' + DEV_FILE[dev] + ')失敗,耗時 ' + Math.round((now() - t0) / 1000) + ' 秒:' + msg(err); rec.failures[dev] = { reason, env: o.envKey, at: now() }; if (rec.verified && rec.verified.device === dev) delete rec.verified; tried.push({ device: dev, ok: false, reason });
      }
    }
    const parts = tried.map((x) => x.reason).concat(skipped.map((d) => DEV_NAME[d] + ' 這個環境之前失敗過,先不重試(' + rec.failures[d].reason + ';換偏好、ort 版本或顯示卡後會再試)'));
    return { engine: null, device: null, tried, skipped, reason: '模型沒有裝置能用:' + parts.join(';'), record: rec };
  }
  // 冒煙測試:用作曲樹範本的旋律軌當條件,補貝斯 2 小節;要真的有音符才算通過
  async function smoke(engine) {
    const t0 = Date.now(); const tree = await T.plan({ fields: {}, options: { style: 'pop', key: 'C', tempo: 100, bars: 4 } }, {}); const c = T.compose(tree, 1);
    const bytes = M.write(Object.assign({}, c.song, { tracks: [c.song.tracks[0]] })); const r = await engine.accompany(bytes, { bars: 2, instrument: 'Bass', seed: 1, tempoBpm: 100 });
    const p = M.parse(r.midi); const n = p.tracks.slice(1).reduce((a, t) => a + ((t.notes && t.notes.length) || 0), 0); if (!n) throw new Error('冒煙測試:模型沒有生成任何音符'); return { ms: Date.now() - t0, notes: n };
  }
  const MANIFEST = { version: 'v5', vocab_size: 598, n_layers: 12, n_heads: 12, head_dim: 64, opset: 17, files: { gpu: { file: 'decoder-webgpu-q4.onnx', bytes: 73151835, sha256: '7c5de98ff7460bd88d07acc537c6e238f0a4afce29b8c9ad488eb97f99bdbfdf', quant: 'q4', cache: 'present, (1,H,P,D)' }, cpu: { file: 'decoder-wasm-int8.onnx', bytes: 114561179, sha256: '5ca00f42ba3900aeb6d98821d4e8b559a880c8d99d62dbdc0d1555a38c1eed65', quant: 'int8', cache: 'new-rows, time-major (1,P,H,D)' } } };
  return { segmentsOf, MANIFEST, openSession, smoke, DEV_NAME, DEV_FILE, findModel, unsupported, compose, checkVoice, voicesOf, MAX_BARS };
});
