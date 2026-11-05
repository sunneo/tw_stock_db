// 瀏覽器端（WASM）量測：在真的 Electron 渲染程序內，用跟產品相同的做法載入 onnxruntime-web 1.22.0（audio_runtime.js 的 loadOrt 同一套設定：proxy 開、執行緒數同規則）。
// 這個檔案會被 run_bench.js 複製到工作資料夾並把 __WORK__／__MODELS__／__ONLY__ 換成實際值，再用 FA_DEBUG_EVAL_FILE 執行。不下載任何模型檔。
return (async () => {
    const WORK = '__WORK__', MODELS = '__MODELS__', ONLY = '__ONLY__' ? '__ONLY__'.split(',') : null;
    const fsx = window.desktopAPI.rawfs;
    const b64 = async (p) => { const r = await fsx.readFile(p, 'base64'); const bin = atob(r.base64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const readJson = async (p) => JSON.parse((await fsx.readFile(p)).text);
    const cfg = await readJson(WORK + '/bench-config.json'), man = await readJson(WORK + '/inputs/manifest.json');
    const OUT = WORK + '/wasm.jsonl'; const lines = [];
    const emit = async (o) => { lines.push(JSON.stringify(Object.assign({ backend: 'wasm', ts: new Date().toISOString() }, o))); await fsx.writeFile(OUT, { text: lines.join('\n') + '\n' }); };
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    const ORT_VERSION = '1.22.0';
    const ort = await import('https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/ort.webgpu.min.mjs');
    let threads = 1;
    try { new MessageChannel().port1.postMessage(new SharedArrayBuffer(1)); threads = Math.min(4, navigator.hardwareConcurrency || 2); } catch (_) { threads = 1; }
    ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@' + ORT_VERSION + '/dist/'; ort.env.wasm.proxy = true; ort.env.wasm.numThreads = Math.min(threads, cfg.threads);
    const T0 = Date.now(), TYPED = { float32: Float32Array, int64: BigInt64Array, int32: Int32Array, uint8: Uint8Array };
    await emit({ event: 'start', ort: ORT_VERSION, threads: ort.env.wasm.numThreads, coi: self.crossOriginIsolated, ua: navigator.userAgent.slice(0, 80), cores: navigator.hardwareConcurrency });
    for (const m of cfg.models) {
        if (ONLY && !ONLY.includes(m.id)) continue;
        if (Date.now() - T0 > cfg.time_cap_ms) { await emit({ model: m.id, aborted: 'time_cap' }); continue; }
        const fp = MODELS + '/' + m.file;
        let st = null; try { st = await fsx.stat(fp); } catch (_) { st = null; }
        if (!st || st.error || st.exists === false) { await emit({ model: m.id, skipped: 'needs_download', needs_download: { file: m.file, source: m.source, bytes: m.bytes } }); continue; }
        try {
            let bytes;
            if (st.size > 150 * 1048576) { // 超過字串上限的大檔：先用 copyChunked 切成 64 MB 小片，再一片一片讀進同一個緩衝區（片檔讀完就刪）
                const pd = WORK + '/parts/' + m.id + '/'; const cc = await fsx.copyChunked(fp, pd + 'p', 64 * 1048576);
                bytes = new Uint8Array(cc.size); let o = 0;
                for (const p of cc.parts) { const u = await b64(pd + p.name); bytes.set(u, o); o += u.length; }
                await fsx.remove(pd, true);
            } else bytes = await b64(fp);
            if (m.bytes && bytes.length !== m.bytes) { await emit({ model: m.id, ok: false, error: '位元組數不符 ' + bytes.length + ' / ' + m.bytes }); continue; }
            const tl = Date.now();
            const so = { executionProviders: ['wasm'], graphOptimizationLevel: m.graph_opt || 'all' };
            const sess = await ort.InferenceSession.create(bytes, so);
            await emit({ model: m.id, event: 'loaded', load_ms: Date.now() - tl, inputs: sess.inputNames, outputs: sess.outputNames, js_heap_mb: Math.round((performance.memory || {}).usedJSHeapSize / 1048576) });
            if (!Array.isArray(m.inputs)) { await emit({ model: m.id, skipped: 'special_inputs_not_implemented' }); continue; }
            for (let q = 0; q < cfg.queries; q++) {
                const raws = []; // 代理模式會把傳進去的緩衝轉移給背景執行緒，所以每次呼叫都要用新的副本（跟產品每窗一個新張量相同）；建副本的時間不計入
                for (const it of man.items.filter((x) => x.model === m.id && x.q === q)) raws.push({ it, u: await b64(WORK + '/inputs/' + it.file) });
                const mkFeeds = () => { const f = {}; for (const { it, u } of raws) { const C = TYPED[it.dtype]; f[/^auto\d+$/.test(it.input) ? sess.inputNames[+it.input.slice(4)] : it.input] = new ort.Tensor(it.dtype, new C(u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength)), it.dims); } return f; };
                const times = []; let outs = null, err = null;
                for (let r = 0; r < cfg.warmup + (m.runs || cfg.runs); r++) {
                    const feeds = mkFeeds(); const t = performance.now();
                    try { outs = await sess.run(feeds); } catch (e) { err = String((e && e.message) || e); break; }
                    const ms = Math.round(performance.now() - t); if (r >= cfg.warmup) times.push(ms);
                    if (ms > cfg.timeout_ms) { err = 'timeout ' + ms; break; }
                }
                if (err) { await emit({ model: m.id, q, ok: false, error: err }); continue; }
                const parts = [];
                for (const name of sess.outputNames) {
                    const d = outs[name].data; const b = new Uint8Array(d.buffer, d.byteOffset, d.byteLength); parts.push(b);
                    let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
                    await fsx.writeFile(WORK + '/out/wasm/' + m.id + '_q' + q + '_' + name.replace(/[^\w.-]/g, '_') + '.bin', { base64: btoa(s) });
                }
                const all = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
                await emit({ model: m.id, q, ok: true, ms: median(times), all_ms: times, out_hash: hex(await crypto.subtle.digest('SHA-256', all)), out_dims: sess.outputNames.map((n) => outs[n].dims), out_names: sess.outputNames, js_heap_mb: Math.round((performance.memory || {}).usedJSHeapSize / 1048576) });
            }
            await sess.release();
        } catch (e) { await emit({ model: m.id, ok: false, error: String((e && e.stack) || e).slice(0, 400) }); }
    }
    await emit({ event: 'done', total_ms: Date.now() - T0 });
    return 'done';
})();
