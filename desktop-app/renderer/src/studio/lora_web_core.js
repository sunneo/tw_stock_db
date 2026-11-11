/* 網頁版 LoRA 套用（DESIGN.TODO.offline-training-studio.md §14 路線 c）：載入標準 Qwen3-0.6B 的 q8 模型（onnx-community 的 model_quantized.onnx）時，
 *  在位元組層級把 LoRA 的 B·A 併進權重（lora_merge_core），用 onnx_patch_core 換掉縮放值，再從「攔截後的 fetch」交給 transformers.js。
 *  不需要槽版模型、不需要託管、不需要修改 transformers.js 原始碼（它從 CDN 載入，本專案沒有複本；攔截 fetch 是唯一接點，且不碰它的內部）。
 *  純函式核心（UMD）：Node 與瀏覽器（含 Worker）都能載入；依賴注入：sha256Hex、fetch 範圍物件。
 *
 *  API：
 *   patchQwen3Q8(modelBytes, loraBytes, opts) → {ok, parts, length, report} | {ok:false, error, report?}
 *      modelBytes 會被「原地修改」（權重位元組）；opts：{rank=16, minCos=0.5, maxK, onProgress(done,total,name), sha256Hex, verify, loraSha256}
 *   installFetchPatch(scope, {match(url), transform(bytes,url)→{parts,length}|throw, cacheName, envs}) → {hits, errors, uninstall()}
 *   createWebLoraApplier({state, loadModel, sha256Hex}) → {apply(handles), clear(), status()}
 *      state：與載入端共用的物件，載入端讀 state.lora = {id, bytes, sha256}；loadModel()：重新載入文字模型並回 {ok, report?, error?}
 *      誠實原則：載入後 report.ok 才回 ok:true；攔截沒被用到（hits=0）、品質不足、模型結構不符一律回具體原因。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./onnx_patch_core.js'), require('./lora_merge_core.js'));
    else root.FaLoraWeb = factory(root.FaOnnxPatch, root.FaLoraMerge);
})(typeof self !== 'undefined' ? self : this, function (Onnx, Merge) {
    'use strict';
    const NODE_RE = /^\/model\/layers\.(\d+)\/(attn|mlp)\/(q_proj|k_proj|v_proj|o_proj|gate_proj|up_proj|down_proj)\/MatMul_quant$/;
    const f32 = (raw) => new DataView(raw.buffer, raw.byteOffset, 4).getFloat32(0, true);

    function findTargets(bytes, idx) {
        const targets = [];
        for (const n of idx.nodes) {
            if (n.op !== 'MatMulInteger') continue;
            const m = NODE_RE.exec(n.name); if (!m) continue;
            const where = n.name;
            const W = idx.inits.get(n.inputs[1]);
            if (!W) return { error: '找不到權重初始值：' + where };
            if (W.external) return { error: '權重存放在外部資料檔，不支援（' + where + '）' };
            if (W.otherData || W.rawStart < 0) return { error: '權重不是 raw_data 格式（' + where + '）' };
            if (W.dataType !== Onnx.DT.UINT8 && W.dataType !== Onnx.DT.INT8) return { error: '權重不是 8 位元整數（' + where + '，data_type=' + W.dataType + '），這不是 q8 模型' };
            if (W.dims.length !== 2) return { error: '權重不是二維（' + where + '）' };
            const [din, dout] = W.dims;
            if (W.rawEnd - W.rawStart !== din * dout) return { error: '權重資料長度與形狀不符（' + where + '）' };
            let zp = 0;
            if (n.inputs[3]) {
                const Z = idx.inits.get(n.inputs[3]);
                if (!Z || Z.rawStart < 0 || Z.rawEnd - Z.rawStart !== 1 || (Z.dims.length && Z.dims.reduce((a, b) => a * b, 1) !== 1)) return { error: '權重零點不是純量（' + where + '），可能是逐通道量化的模型，不支援' };
                zp = W.dataType === Onnx.DT.INT8 ? (bytes[Z.rawStart] << 24 >> 24) : bytes[Z.rawStart];
            }
            const dq = idx.producers.get(n.inputs[0]);
            if (!dq || dq.op !== 'DynamicQuantizeLinear') return { error: '輸入不是 DynamicQuantizeLinear（' + where + '），不是 quantize_dynamic 的圖' };
            const xs = dq.outputs[1];
            const mul = (idx.consumers.get(xs) || []).find((c) => c.op === 'Mul' && c.inputs.some((i) => i !== xs && idx.inits.has(i)));
            if (!mul) return { error: '找不到縮放值的 Mul 節點（' + where + '）' };
            const scaleName = mul.inputs.find((i) => i !== xs && idx.inits.has(i));
            const S = idx.inits.get(scaleName);
            if (S.dataType !== Onnx.DT.FLOAT || S.rawStart < 0 || S.rawEnd - S.rawStart !== 4 || S.external) return { error: '縮放值不是 raw_data 的單一 float（' + where + '）' };
            if ((idx.consumers.get(scaleName) || []).length !== 1) return { error: '縮放值被多個節點共用（' + where + '），不能改成逐欄向量' };
            targets.push({ layer: Number(m[1]), proj: m[3], din, dout, dtype: W.dataType === Onnx.DT.INT8 ? 'int8' : 'uint8', zp, scale: f32(bytes.subarray(S.rawStart, S.rawStart + 4)), W, scaleName, nodeName: n.name });
        }
        return { targets };
    }

    function patchQwen3Q8(modelBytes, loraBytes, opts) {
        opts = opts || {};
        const t0 = Date.now(), rank = opts.rank || 16, minCos = opts.minCos === undefined ? 0.5 : opts.minCos;
        if (!(loraBytes instanceof Uint8Array) || !loraBytes.length) return { ok: false, error: 'lora.bin 是空的' };
        let idx;
        try { idx = Onnx.indexModel(modelBytes); } catch (e) { return { ok: false, error: '解析模型失敗：' + String((e && e.message) || e) }; }
        const ft = findTargets(modelBytes, idx);
        if (ft.error) return { ok: false, error: ft.error };
        const targets = ft.targets;
        if (!targets.length) return { ok: false, error: '模型裡找不到 Qwen3 的 q8 目標層（節點名稱不符 /model/layers.N/…/MatMul_quant），這不是 onnx-community 的 Qwen3 q8 模型' };
        const layers = new Set(targets.map((t) => t.layer));
        if (targets.length !== layers.size * 7) return { ok: false, error: '每層應有 7 個目標，實際 ' + targets.length + ' 個／' + layers.size + ' 層' };
        const layout = Merge.computeLayout(targets, rank);
        if (layout.total !== loraBytes.length) return { ok: false, error: 'lora.bin 大小 ' + loraBytes.length + ' 與標準圖推得的版面 ' + layout.total + ' 不符（rank 槽應為 ' + rank + '、目標層 ' + targets.length + ' 個）' };
        const lay = new Map(layout.tensors.map((t) => [t.name, t]));
        const view = (name, n) => { const t = lay.get(name); const c = loraBytes.slice(t.offset, t.offset + t.length); return new Float32Array(c.buffer, 0, n); };
        const replacements = new Map(); const per = [];
        let done = 0, skipped = 0, clipped = 0;
        const loraSha = opts.loraSha256 || '';
        for (const t of targets.slice().sort((a, b) => a.layer * 100 + Merge.PROJ.indexOf(a.proj) - (b.layer * 100 + Merge.PROJ.indexOf(b.proj)))) {
            const tag = 'lora.' + t.layer + '.' + t.proj;
            const A = view(tag + '.A', t.din * rank), B = view(tag + '.B', rank * t.dout);
            let zero = true; for (let i = 0; i < B.length; i++) if (B[i] !== 0) { zero = false; break; }
            if (zero) { skipped++; done++; if (opts.onProgress) opts.onProgress(done, targets.length, tag); continue; }
            const q = modelBytes.subarray(t.W.rawStart, t.W.rawEnd);
            const r = Merge.mergeTensor({ q, dtype: t.dtype, zp: t.zp, scale: t.scale, din: t.din, dout: t.dout, A, B, rank, seed: Merge.hashSeed(loraSha + '|' + tag), maxK: opts.maxK });
            replacements.set(t.scaleName, Onnx.encodeTensor({ name: t.scaleName, dataType: Onnx.DT.FLOAT, dims: [t.dout], raw: new Uint8Array(r.scales.buffer, r.scales.byteOffset, r.scales.byteLength) }));
            per.push({ tag, outCos: r.stats.outCos, outRelErr: r.stats.outRelErr, kMean: r.kMean, kMin: r.kMin }); clipped += r.stats.clipped;
            done++; if (opts.onProgress) opts.onProgress(done, targets.length, tag);
        }
        const mean = (k) => per.length ? per.reduce((a, x) => a + x[k], 0) / per.length : 1;
        const report = { targets: targets.length, merged: per.length, skippedZero: skipped, rank, outCosMean: mean('outCos'), outCosMin: per.length ? Math.min(...per.map((x) => x.outCos)) : 1, outRelErrMean: per.length ? mean('outRelErr') : 0, kMean: mean('kMean'), kMin: per.length ? Math.min(...per.map((x) => x.kMin)) : 0, clipped, ms: 0, method: '細格＋抖動併入（每欄縮放）' };
        if (!per.length) { report.ms = Date.now() - t0; return { ok: false, error: 'adapter 全部是零（B 矩陣全 0），沒有東西可併入', report }; }
        if (report.outCosMean < minCos) { report.ms = Date.now() - t0; return { ok: false, error: 'LoRA 的變化量比 q8 的解析度小太多，併入後只剩雜訊（輸出相似度平均 ' + report.outCosMean.toFixed(3) + ' < ' + minCos + '）。這個 adapter 在網頁版 q8 路徑無法可靠套用', report }; }
        const rw = Onnx.rewrite(modelBytes, idx, replacements);
        report.ms = Date.now() - t0; report.mergedLength = rw.length;
        const out = { ok: true, parts: rw.parts, length: rw.length, report };
        if (opts.verify) {
            let idx2; const full = Onnx.concatParts(rw.parts, rw.length);
            try { idx2 = Onnx.indexModel(full); } catch (e) { return { ok: false, error: '核對失敗：重新解析合併後的模型出錯：' + String((e && e.message) || e), report }; }
            if (idx2.nodes.length !== idx.nodes.length || idx2.inits.size !== idx.inits.size) return { ok: false, error: '核對失敗：節點或初始值數量改變', report };
            for (const t of targets) {
                const S = idx2.inits.get(t.scaleName), W = idx2.inits.get(t.W.name);
                if (!S || !W) return { ok: false, error: '核對失敗：找不到 ' + t.scaleName, report };
                if (W.rawEnd - W.rawStart !== t.din * t.dout) return { ok: false, error: '核對失敗：權重長度改變 ' + t.nodeName, report };
                const want = replacements.has(t.scaleName) ? String(t.dout) : idx.inits.get(t.scaleName).dims.join();
                if (S.dims.join() !== want || S.rawEnd - S.rawStart !== (replacements.has(t.scaleName) ? t.dout * 4 : 4)) return { ok: false, error: '核對失敗：縮放值形狀不對 ' + t.scaleName, report };
            }
            report.verified = true;
        }
        return out;
    }

    function installFetchPatch(scope, spec) {
        const handle = { hits: 0, errors: [], uninstall() { if (scope.fetch === wrapped) scope.fetch = orig; for (const [e, f] of envOrig) e.fetch = f; } };
        const orig = scope.fetch;
        const cacheName = spec.cacheName || 'transformers-cache';
        const wrap = (base) => async function (input, init) {
            const url = typeof input === 'string' ? input : (input && input.url) || String(input);
            if (!spec.match(url)) return base.apply(this, arguments);
            let r = null;
            try { if (scope.caches) { const c = await scope.caches.open(cacheName); r = await c.match(url); } } catch (_) { r = null; }
            if (!r) {
                r = await base.apply(this, arguments);
                if (r && r.ok) { try { if (scope.caches) { const c = await scope.caches.open(cacheName); await c.put(url, r.clone()); } } catch (_) { /* 快取不到就算了，原檔照樣用 */ } }
            }
            if (!r || !r.ok) return r;
            try {
                const bytes = new Uint8Array(await r.arrayBuffer());
                const out = await spec.transform(bytes, url);
                handle.hits++;
                return new Response(new Blob(out.parts, { type: 'application/octet-stream' }), { status: 200, headers: { 'content-type': 'application/octet-stream', 'content-length': String(out.length) } });
            } catch (e) { handle.errors.push(String((e && e.message) || e)); throw e; }
        };
        const wrapped = wrap(orig);
        scope.fetch = wrapped;
        const envOrig = [];
        for (const e of (spec.envs || [])) if (e && typeof e.fetch === 'function') { envOrig.push([e, e.fetch]); e.fetch = wrap(e.fetch); }
        return handle;
    }

    function createWebLoraApplier(d) {
        d = d || {};
        let last = null;
        async function apply(handles) {
            if (!d.state || !d.loadModel) return { ok: false, error: '網頁版沒有接上文字模型載入（內部設定缺漏）' };
            const hs = (handles || []).filter((h) => h && h.bytes && h.bytes.length);
            if (!hs.length) return { ok: false, error: '沒有可套用的 adapter（載入結果是空的）' };
            const h = hs[0], extra = hs.slice(1).map((x) => x.id);
            const sha = d.sha256Hex ? await d.sha256Hex(h.bytes) : '';
            const prev = d.state.lora;
            d.state.lora = { id: h.id, bytes: h.bytes, sha256: sha };
            let r;
            try { r = await d.loadModel(); } catch (e) { r = { ok: false, error: String((e && e.message) || e) }; }
            if (!r || r.ok === false || !(r.report && r.report.ok !== false)) {
                d.state.lora = prev || null;
                const why = (r && (r.error || (r.report && r.report.error))) || '載入沒有回報合併結果';
                last = { ok: false, error: why };
                return { ok: false, error: why, report: r && r.report };
            }
            last = { ok: true, id: h.id, report: r.report };
            const rp = r.report;
            return { ok: true, id: h.id, report: rp, note: '已併入網頁版 q8 模型（' + rp.merged + '／' + rp.targets + ' 層，輸出相似度平均 ' + Number(rp.outCosMean).toFixed(3) + '）' + (extra.length ? '；同時只能套一個 adapter，未套用：' + extra.join('、') : '') };
        }
        async function clear() { if (d.state) d.state.lora = null; if (d.unloadModel) { try { await d.unloadModel(); } catch (_) { /* 下次載入就是原版 */ } } last = null; return { ok: true }; }
        function status() { return { ok: true, last, active: !!(d.state && d.state.lora) }; }
        return { apply, clear, status };
    }
    return { patchQwen3Q8, installFetchPatch, createWebLoraApplier, findTargets, NODE_RE };
});
