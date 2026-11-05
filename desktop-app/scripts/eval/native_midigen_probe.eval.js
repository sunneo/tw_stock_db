// midigenai 原生對 WASM 第一步（提示詞）logits 差異的探針：原生用不同圖形最佳化等級各跑一次，對網頁版比最大絕對誤差。（NAB_EVAL_FILE=native_midigen_probe.eval.js）
return (async () => {
    const MODELS = '__MODELS__', OUT = '__OUT__', fsx = window.desktopAPI.rawfs, R = { steps: [] };
    const note = async (o) => { R.steps.push(o); try { await fsx.writeFile(OUT, { text: JSON.stringify(R, null, 1) }); } catch (_) { /* */ } };
    const b64u8 = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const ID = 'midigenai-v5-cpu', reg = FaAudioModels.REGISTRY[ID];
    const cc = await fsx.copyChunked(MODELS + '/decoder-wasm-int8.onnx', MODELS + '/../seed-mg/p', 8 * 1048576), all = new Uint8Array(cc.size); let off = 0;
    for (const p of cc.parts) { const u = b64u8((await fsx.readFile(MODELS + '/../seed-mg/' + p.name, 'base64')).base64); all.set(u, off); off += u.length; }
    await fsx.remove(MODELS + '/../seed-mg', true);
    try { localStorage.setItem('fa.native.enabled', '1'); } catch (_) { /* */ }
    const ort = await FaAudioRuntime.loadOrt({ proxy: false });
    const M = FaMidigenBridge.MANIFEST, H = M.n_heads, D = M.head_dim, L = M.n_layers;
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    const pr = rng(5), prompt = Array.from({ length: 180 }, () => 1 + Math.floor(pr() * 500));
    const mk = (T) => { const f = { ids: new T('int64', BigInt64Array.from(prompt, (t) => BigInt(t)), [1, prompt.length]) }; for (let i = 0; i < L; i++) for (const c of 'kv') f['past_' + c + i] = new T('float32', new Float32Array(0), [1, 0, H, D]); return f; };
    const w = await FaAudioRuntime.createSession(ort, all.slice(), ['wasm'], {}); const wo = (await w.session.run(mk(ort.Tensor))).logits.data.slice();
    const box = await fa._nrBox(), sep = box.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/';
    const entry = { id: ID, file: 'decoder-wasm-int8.onnx', bytes: reg.bytes, sha256: reg.sha256 };
    const api = FaNativeOrt.create({ call: (op, p, t) => fa._nrCall(op, p, t), rawfs: fsx, box, sep });
    const st = await api.state(entry); if (!st.installed) await api.installFromBlob(entry, new Blob([all]), {});
    for (const g of ['all']) {
        await fa._nrCall('onnx_release', { id: ID }, 8000); const s = await api.open(entry, { threads: 4, graphOpt: g }); const t = performance.now();
        const o = (await s.run(mk(FaNativeOrt.Tensor))).logits.data; let mx = 0, am = 0, amw = 0; for (let j = 0; j < o.length; j++) { const d = Math.abs(o[j] - wo[j]); if (d > mx) mx = d; if (o[j] > o[am]) am = j; if (wo[j] > wo[amw]) amw = j; }
        await note({ g, max_abs_err: mx, argmax_native: am, argmax_wasm: amw, ms: Math.round(performance.now() - t), sample: [Array.from(o.slice(0, 4)), Array.from(wo.slice(0, 4))] });
    }
    // 逐步細分：KV 模式下 20 個單 token 步驟的子程序計算時間與端對端時間，對網頁版同樣步驟（無快取複製的下限）
    await fa._nrCall('onnx_release', { id: ID }, 8000); const ks = await api.open(entry, { threads: 4, kv: true });
    let r0 = await ks.run(mk(FaNativeOrt.Tensor)); const rows = {}; const nm = ks.outputNames.filter((n) => /^new_/.test(n)); let P = prompt.length; const steps = [];
    for (let k = 0; k < 20; k++) {
        const f = { ids: new FaNativeOrt.Tensor('int64', BigInt64Array.from([BigInt(7 + k)]), [1, 1]) }; for (let i = 0; i < L; i++) for (const c of 'kv') f['past_' + c + i] = new FaNativeOrt.Tensor('float32', new Float32Array(P * H * D), [1, P, H, D]);
        const t = performance.now(); await ks.run(f); P += 1; steps.push({ total: Math.round(performance.now() - t), child: ks.lastRun.childMs, call: ks.lastRun.callMs, prep: ks.lastRun.prepMs });
    }
    await note({ step: 'kv_steps', first: steps.slice(0, 5), median_total: steps.map((x) => x.total).sort((a, b) => a - b)[10], median_child: steps.map((x) => x.child).sort((a, b) => a - b)[10] });
    // 網頁版同樣的 20 步（無快取複製）
    const wf = (P0, tok) => { const f = { ids: new ort.Tensor('int64', BigInt64Array.from([BigInt(tok)]), [1, 1]) }; for (let i = 0; i < L; i++) for (const c of 'kv') f['past_' + c + i] = new ort.Tensor('float32', new Float32Array(P0 * H * D), [1, P0, H, D]); return f; };
    const wt = []; let P2 = prompt.length; for (let k = 0; k < 20; k++) { const t = performance.now(); await w.session.run(wf(P2, 7 + k)); P2 += 1; wt.push(Math.round(performance.now() - t)); }
    await note({ step: 'wasm_steps', median: wt.sort((a, b) => a - b)[10], all: wt });
    // 快取模式正確性（teacher forcing：兩邊餵一樣的 token）：原生 KV 模式（快取在子程序）對原生無快取模式（每步送完整快取），再對網頁版
    await fa._nrCall('onnx_release', { id: ID }, 8000); const sKv = await api.open(entry, { threads: 4, kv: true }), sFull = await api.open(entry, { threads: 4 });
    const ROW = H * D, names = []; for (let i = 0; i < L; i++) for (const c of 'kv') names.push(c + i);
    let bufF = names.map(() => new Float32Array(0)), bufW = names.map(() => new Float32Array(0)), Pn = 0; const toks = [prompt, [11], [22], [33], [44], [55], [66], [77]], diffs = [];
    const feedsFull = (T, ids, bufs, P) => { const f = { ids: new T('int64', BigInt64Array.from(ids, (t) => BigInt(t)), [1, ids.length]) }; names.forEach((n, j) => { f['past_' + n] = new T('float32', bufs[j].slice(0, P * ROW), [1, P, H, D]); }); return f; };
    const grow = (bufs, out, P) => names.map((n, j) => { const nb = new Float32Array(bufs[j].length + out['new_' + n].data.length); nb.set(bufs[j]); nb.set(out['new_' + n].data, bufs[j].length); return nb; });
    for (const ids of toks) {
        const f1 = feedsFull(FaNativeOrt.Tensor, ids, bufF, Pn); const oKv = await sKv.run(f1), oFull = await sFull.run(f1);
        const fW = feedsFull(ort.Tensor, ids, bufW, Pn); const oW = await w.session.run(fW);
        const d = (a, b) => { let m = 0; for (let j = 0; j < a.length; j++) m = Math.max(m, Math.abs(a[j] - b[j])); return +m.toExponential(2); };
        diffs.push({ rows: ids.length, kv_vs_full: d(oKv.logits.data, oFull.logits.data), full_vs_wasm: d(oFull.logits.data, oW.logits.data), kv_new_rows_vs_full: d(oKv.new_k0.data, oFull.new_k0.data) });
        bufF = grow(bufF, oFull); bufW = grow(bufW, { }.x || Object.fromEntries(names.map((n) => ['new_' + n, { data: oW['new_' + n].data.slice() }]))); Pn += ids.length;
    }
    await note({ step: 'kv_correctness', diffs });
    return { ok: true };
})();
