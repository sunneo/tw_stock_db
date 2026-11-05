// 音訊模型原生路徑真 Electron 驗證（由 native_audio_e2e.js 複製到暫存、換掉 __MODELS__／__IDS__／__OUT__ 後用 FA_DEBUG_EVAL_FILE 執行）。
// 做三件事：①把使用者現有的模型檔（不下載）放進這個隔離 profile 的 IndexedDB 分片；②同一組輸入，原生 session（fa._nrAudioSession）對 WASM session 比輸出誤差與每次呼叫的端對端時間；
// ③用 fa._audioToMidi 對一段合成音訊跑完整流程兩次（原生開／關），比較結果與耗時。③只在 IDS 含 basic-pitch 時跑。
return (async () => {
    const MODELS = '__MODELS__', ALL_IDS = '__IDS__'.split(','), OUT = '__OUT__';
    const fsx = window.desktopAPI.rawfs, R = { steps: [], t0: Date.now() };
    const note = async (o) => { R.steps.push(o); try { await fsx.writeFile(OUT, { text: JSON.stringify(R, null, 1) }); } catch (_) { /* 寫不了就只靠回傳值 */ } };
    const store = FaAudioModels.idbStore(), REG = FaAudioModels.REGISTRY, CH = FaAudioModels.CHUNK;
    const IDS = ALL_IDS.filter((id) => REG[id]), DEPTH = ALL_IDS.indexOf('depth-anything-v2-small') >= 0; // 音訊模型走 IndexedDB 分片；深度走瀏覽器快取
    const b64u8 = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    // ① 放分片（從使用者現有檔案，不下載）
    for (const id of IDS) {
        const reg = REG[id], file = String(reg.url).split('/').pop(), src = MODELS + '/' + file; const pd = MODELS + '/../seed-' + id + '/p';
        const cc = await fsx.copyChunked(src, pd, CH); let i = 0;
        for (const p of cc.parts) { const r = await fsx.readFile(MODELS + '/../seed-' + id + '/' + p.name, 'base64'); await store.set('model:' + id + ':' + reg.sha256.slice(0, 8) + ':' + i, b64u8(r.base64)); i++; }
        await fsx.remove(MODELS + '/../seed-' + id, true);
        const st = await FaAudioModels.status(id, store); await note({ step: 'seed', id, complete: st.complete, chunks: st.chunks });
    }
    // 原生模式開啟：選 CPU、啟用原生執行包
    try { localStorage.setItem('fa.native.enabled', '1'); } catch (_) { /* */ }
    fa.advancedSettings = fa.advancedSettings || {}; fa.advancedSettings.offlineDevicePreference = 'cpu';
    const ort = await FaAudioRuntime.loadOrt();
    const bytesOf = async (id) => FaAudioModels.fetchModel(id, { fetchFn: () => { throw new Error('不該下載'); }, store, sha256: FaAudioModels.webSha256, sleep: () => Promise.resolve() });
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    const SPEC = { 'basic-pitch': { dims: [1, 43844, 1], rate: 22050, seg: 43844, n: 8 }, 'yamnet': { dims: [48000], rate: 16000, seg: 48000, n: 8 }, 'demucs-6s': { dims: [1, 2, 343980], rate: 44100, seg: 343980, n: 2 }, 'depth-anything-v2-small': { dims: [1, 3, 518, 518], n: 3 } };
    const mkInput = (id, q) => {
        const sp = SPEC[id], n = sp.dims.reduce((a, b) => a * b, 1), a = new Float32Array(n), r = rng(100 + q);
        if (sp.rate) for (let i = 0; i < n; i++) { const t = (i % sp.seg) / sp.rate; a[i] = (Math.sin(2 * Math.PI * (220 + 40 * q) * t) + 0.5 * Math.sin(2 * Math.PI * 330 * t)) * 0.3 + (r() - 0.5) * 0.02; }
        else for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.001 + q) * 0.8 + (r() - 0.5) * 0.1;
        return a;
    };
    // 信箱往返延遲（空請求 onnx_status）：固定成本的下限
    { const ts = []; for (let i = 0; i < 20; i++) { const t = performance.now(); await fa._nrCall('onnx_status', { id: 'x', file: 'x.onnx', bytes: 1 }, 5000); ts.push(Math.round((performance.now() - t) * 10) / 10); } await note({ step: 'mailbox_rtt_ms', median: median(ts), all: ts }); }
    // ② 逐模型：原生對 WASM
    for (const id of IDS) {
        const sp = SPEC[id], notes = [], say = (t) => { R.say = (R.say || []).concat([t]); };
        const bytes = await bytesOf(id);
        const nat = await fa._nrAudioSession(id, { REG, store, dl: async () => bytes, say, notes, ort, opt: id === 'demucs-6s' ? FaAudioRuntime.DEMUCS_OPT : undefined });
        if (!nat) { await note({ step: 'compare', id, error: '原生不可用', notes }); continue; }
        const w = await FaAudioRuntime.createSession(ort, bytes.slice(), ['wasm'], { opt: id === 'demucs-6s' ? FaAudioRuntime.DEMUCS_OPT : undefined });
        const inName = nat.session.inputNames[0], natT = [], wasT = []; let worst = 0, sse = 0, sref = 0;
        for (let q = 0; q < sp.n; q++) {
            const x = mkInput(id, q);
            let t = performance.now(); const o1 = await nat.session.run({ [inName]: new nat.ort.Tensor('float32', x.slice(), sp.dims) }); natT.push(Math.round(performance.now() - t)); (R.lastRuns = R.lastRuns || {})[id] = (R.lastRuns[id] || []).concat([nat.session.lastRun || (nat.session.native && nat.session.native.lastRun) || null]);
            t = performance.now(); const o2 = await w.session.run({ [inName]: new ort.Tensor('float32', x.slice(), sp.dims) }); wasT.push(Math.round(performance.now() - t));
            for (const name of nat.session.outputNames) { const a = o1[name].data, b = o2[name].data; for (let i = 0; i < a.length; i++) { const d = Math.abs(a[i] - b[i]); if (d > worst) worst = d; sse += d * d; sref += b[i] * b[i]; } }
        }
        await note({ step: 'compare', id, last_runs: R.lastRuns && R.lastRuns[id], backend: nat.session.backend, native_ms: natT, wasm_ms: wasT, native_median: median(natT), wasm_median: median(wasT), max_abs_err: worst, snr_db: sse ? 10 * Math.log10(sref / sse) : null, notes, say: R.say });
        await nat.session.release(); try { await w.session.release(); } catch (_) { /* */ }
    }
    // ③ 完整流程（只有 Basic Pitch 在清單內才跑）：合成 12 秒立體聲（C 和弦 → G 和弦），原生開與關各跑一次
    if (IDS.indexOf('basic-pitch') >= 0) {
        const sr = 44100, secs = IDS.indexOf('demucs-6s') >= 0 ? 16 : 40, n = sr * secs, ac = new OfflineAudioContext(2, n, sr), buf = ac.createBuffer(2, n, sr);
        for (let c = 0; c < 2; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) { const t = i / sr, ch = (t % 12) < 6 ? [261.63, 329.63, 392] : [196, 246.94, 293.66]; let v = 0; for (const f of ch) v += Math.sin(2 * Math.PI * f * t) * 0.18; d[i] = v * Math.min(1, (t % 6) * 6); } }
        const wavHeader = (len) => { const b = new ArrayBuffer(44), v = new DataView(b), s = (o, t) => { for (let i = 0; i < t.length; i++) v.setUint8(o + i, t.charCodeAt(i)); }; s(0, 'RIFF'); v.setUint32(4, 36 + len, true); s(8, 'WAVEfmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true); v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); s(36, 'data'); v.setUint32(40, len, true); return b; };
        const pcm = new Int16Array(n * 2); const L = buf.getChannelData(0), Rr = buf.getChannelData(1); for (let i = 0; i < n; i++) { pcm[2 * i] = Math.max(-1, Math.min(1, L[i])) * 32767; pcm[2 * i + 1] = Math.max(-1, Math.min(1, Rr[i])) * 32767; }
        const blob = new Blob([wavHeader(pcm.byteLength), pcm.buffer], { type: 'audio/wav' });
        const rec = await fa.fileCache.put('e2e-chords.wav', 'audio/wav', blob, 'uploaded'); const fid = rec && rec.id ? rec.id : rec;
        const runOnce = async (label, nativeOn, stems) => {
            try { localStorage.setItem('fa.native.enabled', nativeOn ? '1' : '0'); } catch (_) { /* */ }
            const t = performance.now(); const r = await fa._audioToMidi({ file_id: fid, stems: !!stems });
            return { label, native: nativeOn, ms: Math.round(performance.now() - t), ok: r.ok, error: r.error, tempo: r.tempo, tracks: r.tracks, skipped: r.skipped };
        };
        const a = await runOnce('原生開（第一次，含安裝模型到原生資料夾）', true, IDS.indexOf('demucs-6s') >= 0); await note({ step: 'e2e', run: a });
        const a2 = await runOnce('原生開（第二次，模型已安裝）', true, IDS.indexOf('demucs-6s') >= 0); await note({ step: 'e2e', run: a2 });
        const b = await runOnce('原生關（網頁版 WASM）', false, IDS.indexOf('demucs-6s') >= 0); await note({ step: 'e2e', run: b });
    }
    // ④ 深度估計：把使用者現有的模型檔放進這個 profile 的 transformers 快取（不下載），原生對網頁版跑同一張圖
    if (DEPTH) {
        const durl = 'https://huggingface.co/onnx-community/depth-anything-v2-small/resolve/main/onnx/model.onnx', dfile = MODELS + '/depth_anything_v2_small.onnx';
        const cc = await fsx.copyChunked(dfile, MODELS + '/../seed-depth/p', 8 * 1048576), parts = [];
        for (const p of cc.parts) parts.push(b64u8((await fsx.readFile(MODELS + '/../seed-depth/' + p.name, 'base64')).base64));
        const all = new Uint8Array(cc.size); let o = 0; for (const u of parts) { all.set(u, o); o += u.length; } await fsx.remove(MODELS + '/../seed-depth', true);
        const dc = await caches.open('transformers-cache'); await dc.put(durl, new Response(all, { headers: { 'content-length': String(all.length), 'content-type': 'application/octet-stream' } }));
        await note({ step: 'depth_seed', bytes: all.length });
        const cv = new OffscreenCanvas(640, 480), cx = cv.getContext('2d'); const g = cx.createLinearGradient(0, 0, 640, 480); g.addColorStop(0, '#3366aa'); g.addColorStop(1, '#ddaa44'); cx.fillStyle = g; cx.fillRect(0, 0, 640, 480);
        cx.fillStyle = '#cc2222'; cx.fillRect(100, 120, 180, 220); cx.fillStyle = '#22cc55'; cx.beginPath(); cx.arc(430, 300, 90, 0, 7); cx.fill(); cx.fillStyle = '#ffffff'; cx.fillRect(300, 40, 260, 60);
        const blob = await cv.convertToBlob({ type: 'image/png' });
        const runD = async (label, nativeOn) => { try { localStorage.setItem('fa.native.enabled', nativeOn ? '1' : '0'); } catch (_) { /* */ } const t = performance.now(); const r = await fa._depthEstimate({ blob, filename: 'e2e.png', silent: true, confirmed: true }); return { label, ms: Math.round(performance.now() - t), ok: r.ok, error: r.error, backend: r.backend || 'web', device: r.device, w: r.depth && r.depth.w, h: r.depth && r.depth.h, data: r.depth && r.depth.data }; };
        const n1 = await runD('原生（第一次，含安裝）', true), n2 = await runD('原生（第二次）', true), w1 = await runD('網頁版 WASM', false), w2 = await runD('網頁版 WASM（第二次）', false);
        let cmp = null;
        if (n2.data && w2.data && n2.data.length === w2.data.length) {
            const a = n2.data, b = w2.data, N = a.length; let ma = 0, mb = 0; for (let i = 0; i < N; i++) { ma += a[i]; mb += b[i]; } ma /= N; mb /= N; let sab = 0, saa = 0, sbb = 0, mx = 0, sd = 0;
            for (let i = 0; i < N; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; const d = Math.abs(a[i] - b[i]); if (d > mx) mx = d; sd += d; }
            let lo = Infinity, hi = -Infinity; for (let i = 0; i < N; i++) { if (b[i] < lo) lo = b[i]; if (b[i] > hi) hi = b[i]; }
            cmp = { pearson: sab / Math.sqrt(saa * sbb), max_abs_diff: mx, mean_abs_diff: sd / N, web_range: [lo, hi], mean_abs_diff_over_range: (sd / N) / (hi - lo) };
        }
        const strip = (r) => Object.assign({}, r, { data: undefined, n: r.data ? r.data.length : 0 });
        await note({ step: 'depth', runs: [n1, n2, w1, w2].map(strip), compare: cmp, same_size: !!(n2.data && w2.data && n2.w === w2.w && n2.h === w2.h) });
    }
    R.total_ms = Date.now() - R.t0; await note({ step: 'done' });
    return { ok: true, steps: R.steps.length };
})();
