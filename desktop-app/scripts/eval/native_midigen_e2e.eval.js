// midigenai v5 CPU 版原生路徑真 Electron 驗證（由 native_audio_e2e.js 以 NAB_EVAL_FILE=native_midigen_e2e.eval.js 啟動；__MODELS__ 內要有 decoder-wasm-int8.onnx）。
// A. 逐步比對：同一份 spec（同種子），網頁版 WASM 的 MidigenModel 對掛上原生 session 的 MidigenModel，比每步 logits 誤差、生成的 token 序列與耗時。
// B. 完整流程：fa._midigenEngine（真的模型管理、冒煙測試）原生開／關各一次。
// C. 部分原生與退回：不在註冊表、逐模型開關、離線原生總開關、載入失敗、執行到一半出錯（含 token 序列仍與網頁版相同）。
return (async () => {
    const MODELS = '__MODELS__', OUT = '__OUT__', fsx = window.desktopAPI.rawfs, R = { steps: [], t0: Date.now() };
    const note = async (o) => { R.steps.push(o); try { await fsx.writeFile(OUT, { text: JSON.stringify(R, null, 1) }); } catch (_) { /* */ } };
    const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    const b64u8 = (b64) => { const bin = atob(b64), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
    const ID = 'midigenai-v5-cpu', REG = FaAudioModels.REGISTRY, reg = REG[ID], store = FaAudioModels.idbStore(), CH = FaAudioModels.CHUNK;
    // 讀檔（不下載）：放進 IndexedDB 分片（給 B 用），同時留一份位元組（給 A、C 用）
    const cc = await fsx.copyChunked(MODELS + '/decoder-wasm-int8.onnx', MODELS + '/../seed-mg/p', CH), all = new Uint8Array(cc.size); let off = 0, i = 0;
    for (const p of cc.parts) { const u = b64u8((await fsx.readFile(MODELS + '/../seed-mg/' + p.name, 'base64')).base64); await store.set('model:' + ID + ':' + reg.sha256.slice(0, 8) + ':' + i++, u); all.set(u, off); off += u.length; }
    await fsx.remove(MODELS + '/../seed-mg', true);
    await note({ step: 'seed', bytes: all.length, complete: (await FaAudioModels.status(ID, store)).complete });
    try { localStorage.setItem('fa.native.enabled', '1'); } catch (_) { /* */ }
    fa.advancedSettings = fa.advancedSettings || {}; fa.advancedSettings.offlineDevicePreference = 'cpu';
    const base = new URL('vendor/midigenai/', document.baseURI).href, web = await import(base + 'midigen-web.mjs');
    const ort = await FaAudioRuntime.loadOrt({ proxy: false });
    const mkModel = () => web.loadModel({ ort, engine: 'cpu', base: 'https://midigenai.local/', manifest: FaMidigenBridge.MANIFEST, cache: false, fetchImpl: async () => new Response(all.slice()) });
    const rng = (seed) => { let s = seed >>> 0 || 1; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; };
    const pr = rng(5), prompt = Array.from({ length: 180 }, () => 1 + Math.floor(pr() * 500));
    const mkSpec = (n) => ({ prompt, max_new_tokens: n, seed: 7, vocab_size: 598, temperature: 1.0, top_k: 20, stop_ids: [], eos_id: null });
    const record = (m) => { const rec = { logits: [] }, s = m.session, run = s.run.bind(s); s.run = async (f) => { const o = await run(f); rec.logits.push(Float32Array.from(o.logits.data)); return o; }; return rec; };

    // ---- A. 逐步比對
    const mWeb = await mkModel(), mNat = await mkModel(); const nativeSessBefore = mNat.session;
    const att = await fa._midigenNativeAttach(mNat, all);
    if (!att) { await note({ step: 'A', error: '原生沒接上', why: fa._midigenNativeNote }); }
    else {
        const rw = record(mWeb), rn = record(mNat), N = 96; const tw = [], tn = []; let toksW, toksN, worst = 0;
        for (let k = 0; k < 3; k++) {
            rw.logits.length = 0; rn.logits.length = 0;
            let t = performance.now(); try { toksW = await mWeb.decode(mkSpec(N)); } catch (e) { await note({ step: 'A_error', who: 'web', k, err: String(e && e.stack || e).slice(0, 600) }); throw e; } tw.push(Math.round(performance.now() - t));
            t = performance.now(); try { toksN = await mNat.decode(mkSpec(N)); } catch (e) { await note({ step: 'A_error', who: 'native', k, backend: mNat.session.backend, why: fa._midigenNativeNote, err: String(e && e.stack || e).slice(0, 600) }); throw e; } tn.push(Math.round(performance.now() - t));
        }
        const perStep = []; for (let s = 0; s < rw.logits.length; s++) { const a = rw.logits[s], b = rn.logits[s]; let w = 0; for (let j = 0; j < a.length; j++) { const d = Math.abs(a[j] - b[j]); if (d > w) w = d; } perStep.push(+w.toExponential(2)); if (w > worst) worst = w; }
        R.perStep = perStep.slice(0, 12); R.logitLens = [rw.logits[0].length, rn.logits[0].length, rw.logits.length, rn.logits.length];
        await note({ step: 'A', tokens: toksW.length, same_tokens: JSON.stringify(toksW) === JSON.stringify(toksN), steps_compared: rw.logits.length, max_logit_abs_err: worst, wasm_ms: tw, native_ms: tn, wasm_median: median(tw), native_median: median(tn), ms_per_token_wasm: median(tw) / toksW.length, ms_per_token_native: median(tn) / toksN.length, backend: mNat.session.backend, note: fa._midigenNativeNote });
        // 單步細分：原生一步裡子程序自己的計算時間 vs 端對端
    }

    // ---- C. 部分原生與退回（先做，B 會改動註冊狀態）
    { let calls = 0; const orig = fa._nrCall.bind(fa); fa._nrCall = (...a) => { calls++; return orig(...a); };
        const gp = await fa._nrAudioSession('midigenai-v5-gpu', { REG, store, dl: async () => all, say: () => {}, notes: [], ort, opt: undefined }); const c1 = calls;
        const m1 = await mkModel(), s1 = m1.session; localStorage.setItem('fa.native.model.' + ID, '0'); const a1 = await fa._midigenNativeAttach(m1, all); const c2 = calls; localStorage.removeItem('fa.native.model.' + ID);
        localStorage.setItem('fa.native.enabled', '0'); const a2 = await fa._midigenNativeAttach(m1, all); const c3 = calls; localStorage.setItem('fa.native.enabled', '1');
        await note({ step: 'C_partial', outside_gpu_null: gp === null, outside_calls: c1, switch_off_null: a1 === null, switch_off_calls: c2 - c1, optin_off_null: a2 === null, optin_off_calls: c3 - c2, session_untouched: m1.session === s1, routed_cpu: FaNativeOrt.routed(ID, (k) => localStorage.getItem(k)).native, routed_gpu: FaNativeOrt.routed('midigenai-v5-gpu', (k) => localStorage.getItem(k)).native });
        fa._nrCall = orig; await m1.release();
        // 載入失敗：原生資料夾的檔被換成同大小垃圾
        const box = await fa._nrBox(), sep = box.indexOf(String.fromCharCode(92)) >= 0 ? String.fromCharCode(92) : '/', ud = box.slice(0, box.lastIndexOf(sep)), mp = ud + sep + 'native-models' + sep + ID + sep + 'decoder-wasm-int8.onnx';
        await fa._nrCall('onnx_release', { id: ID }, 8000); await fsx.writeFile(mp, { base64: btoa('x'.repeat(all.length)) });
        const m2 = await mkModel(), s2 = m2.session, a3 = await fa._midigenNativeAttach(m2, all); const why = fa._midigenNativeNote; const t2 = await m2.decode(mkSpec(8));
        await note({ step: 'C_load_fail', attach_null: a3 === null, why, session_untouched: m2.session === s2, web_decode_tokens: t2.length }); await m2.release();
        await fsx.remove(mp, false); try { await fsx.remove(mp + '.ok', false); } catch (_) { /* */ }
        // 執行到一半出錯：第 10 個 token 之後把主程序那邊的模型釋放 → 後面的步驟自動退回網頁版，整段 token 序列要跟純網頁版相同
        const m3 = await mkModel(), a4 = await fa._midigenNativeAttach(m3, all); const ref = await mWeb.decode(mkSpec(40)); let backendAt10 = null;
        const r0 = m3.session.run.bind(m3.session); let nrun = 0; m3.session.run = async (f) => { if (++nrun === 10) { backendAt10 = m3.session.backend; await fa._nrCall('onnx_release', { id: ID }, 8000); } return r0(f); };
        const toks = await m3.decode(mkSpec(40));
        await note({ step: 'C_midrun_fail', attached: !!a4, backend_before: backendAt10, backend_after: m3.session.backend, same_tokens_as_web: JSON.stringify(toks) === JSON.stringify(ref), reason: fa._midigenNativeNote }); await m3.release();
    }
    await mWeb.release(); await mNat.release(); await fa._nrCall('onnx_release', { id: ID }, 8000);

    // ---- B. 完整流程（真的 _midigenEngine：模型管理、裝置選擇、冒煙測試）
    { const run = async (label, nativeOn) => { try { localStorage.setItem('fa.native.enabled', nativeOn ? '1' : '0'); } catch (_) { /* */ } fa._midigenOk = null; fa._midigenRecSave({}); fa._midigenNativeNote = '';
            const t0 = performance.now(); const g = await fa._midigenEngine({ force: true }); const load = Math.round(performance.now() - t0); if (!g.engine) return { label, error: g.reason };
            const t1 = performance.now(); const sm = await FaMidigenBridge.smoke(g.engine); return { label, load_ms: load, smoke_ms: Math.round(performance.now() - t1), notes: sm.notes, device: g.device, midigen_note: fa._midigenNativeNote }; };
        const r1 = await run('原生開', true), r2 = await run('原生關（網頁版 WASM）', false); await note({ step: 'B_full', runs: [r1, r2] }); }
    R.total_ms = Date.now() - R.t0; await note({ step: 'done' });
    return { ok: true, steps: R.steps.length };
})();
