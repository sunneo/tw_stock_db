// bench_run.js — GPU 運算後端基準的執行器（不依賴 DOM；計時、讓出主執行緒、取消、ORT 會話都可以注入，方便假裝置測試）。
//   runCase(deps, spec) → Promise<row>   spec = { op, shape, ref, candidates: [{ id, run: async () => Float32Array }] }
//     每個候選：暖機 WARMUP 次（不計）→ 量測 MEASURE 次。計時包含上傳＋運算＋讀回（run 內部全做完才回傳）。
//     每次之前讓出主執行緒（deps.yieldTo），取消（deps.isCancelled）只在樣本之間檢查，不存半成品。
//     正確性：第一次輸出與 ref 的整體相對誤差 ≤ TOL；超過就記為錯誤、無效。
//     ORT 失敗：該次記錯誤（errors、errorMsgs），不是靜默；呼叫端據此退回 cudaweb 並顯示。
//   row = { op, shape, id, stats, valid, errors, errorMsgs, relErr, cancelled }
//   makeMatmulInputs(M, K, N, seed) / matmulRef(a, ad, b, bd) / onnxMatMulBytes(M, K, N)
//   ortMatmul(ort, backendId, M, K, N, cache) → async (a, b) → Float32Array   （ORT 會話快取 key 含運算種類與形狀）
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory(require('./bench_core.js'));
    else root.FaGpuBenchRun = factory(root.FaGpuBench);
}(typeof self !== 'undefined' ? self : this, function (C) {
    'use strict';
    const TOL = 1e-3;

    // 確定性的隨機輸入（同一個 seed 每次一樣，各後端比的是同一份資料）
    function makeMatmulInputs(M, K, N, seed) {
        let s = (seed >>> 0) || 1; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296 * 2 - 1; };
        const a = new Float32Array(M * K), b = new Float32Array(K * N);
        for (let i = 0; i < a.length; i++) a[i] = rnd();
        for (let i = 0; i < b.length; i++) b[i] = rnd();
        return { a, b, ad: [M, K], bd: [K, N] };
    }
    // CPU 參考（float64 累加，最後轉 float32）
    function matmulRef(a, ad, b, bd) {
        const M = ad[0], K = ad[1], N = bd[1]; const y = new Float32Array(M * N);
        for (let i = 0; i < M; i++) for (let j = 0; j < N; j++) { let acc = 0; for (let k = 0; k < K; k++) acc += a[i * K + k] * b[k * N + j]; y[i * N + j] = acc; }
        return y;
    }

    // ---- 最小的 ONNX 編碼（只為了一個 MatMul 圖）：protobuf 的 varint 與長度前綴欄位 ----
    function varint(n) { const out = []; let v = n >>> 0; while (v >= 128) { out.push((v & 127) | 128); v >>>= 7; } out.push(v); return out; }
    function key(field, wire) { return varint((field << 3) | wire); }
    function bytesField(field, arr) { return key(field, 2).concat(varint(arr.length), arr); }
    function strField(field, s) { return bytesField(field, Array.from(Buffer_from(s))); }
    function intField(field, v) { return key(field, 0).concat(varint(v)); }
    function Buffer_from(s) { return typeof TextEncoder !== 'undefined' ? new TextEncoder().encode(s) : Array.from(unescape(encodeURIComponent(s)), (c) => c.charCodeAt(0)); }
    function dimMsg(d) { return intField(1, d); }   // Dimension.dim_value = 1
    function tensorType(dims) { // TypeProto.tensor_type = 1 → Tensor { elem_type = 1 (FLOAT), shape = 2 }
        const shape = dims.reduce((acc, d) => acc.concat(bytesField(1, dimMsg(d))), []);
        return bytesField(1, intField(1, 1).concat(bytesField(2, shape)));
    }
    function valueInfo(name, dims) { return strField(1, name).concat(bytesField(2, tensorType(dims))); }
    // 回傳 Uint8Array：model { ir_version=8, opset_import=[{version=13}], graph { node MatMul(A,B→Y), input A[M,K] B[K,N], output Y[M,N] } }
    function onnxMatMulBytes(M, K, N) {
        const node = strField(1, 'A').concat(strField(1, 'B'), strField(2, 'Y'), strField(4, 'MatMul'));
        const graph = bytesField(1, node).concat(strField(2, 'matmul'), bytesField(11, valueInfo('A', [M, K])), bytesField(11, valueInfo('B', [K, N])), bytesField(12, valueInfo('Y', [M, N])));
        const opset = strField(1, '').concat(intField(2, 13));
        const model = intField(1, 8).concat(bytesField(8, opset), bytesField(7, graph));
        return Uint8Array.from(model);
    }

    // 一個 (op, shape) 的量測。deps: { now(), yieldTo(), isCancelled(), warmup, measure, tol }
    async function runCase(deps, spec) {
        const d = deps || {}; const now = d.now || (() => Date.now());
        const yieldTo = d.yieldTo || (() => Promise.resolve());
        const warm = d.warmup != null ? d.warmup : C.WARMUP, meas = d.measure != null ? d.measure : C.MEASURE, tol = d.tol != null ? d.tol : TOL;
        const rows = [];
        for (const cand of spec.candidates) {
            const row = { op: spec.op, shape: spec.shape, id: cand.id, stats: null, valid: false, errors: 0, errorMsgs: [], relErr: null, cancelled: false };
            const samples = []; let checked = false;
            const one = async (store) => {
                const t0 = now(); const out = await cand.run(); const t1 = now();
                if (!checked && spec.ref) { checked = true; row.relErr = C.relErr(out, spec.ref); if (!(row.relErr <= tol)) { row.errors++; row.errorMsgs.push('輸出與參考不符（整體相對誤差 ' + row.relErr + '）'); } }
                if (store) samples.push(t1 - t0);
            };
            try {
                for (let i = 0; i < warm + meas; i++) {
                    if (d.isCancelled && d.isCancelled()) { row.cancelled = true; break; }
                    await yieldTo();
                    try { await one(i >= warm); }
                    catch (e) { row.errors++; row.errorMsgs.push(String((e && e.message) || e).slice(0, 200)); }
                }
            } finally { /* 取消時不存半成品：cancelled 的列不會被採用 */ }
            row.stats = C.stats(samples);
            row.valid = !row.cancelled && C.validResult({ valid: row.errors === 0, errors: row.errors, stats: row.stats });
            rows.push(row);
            if (row.cancelled) break;
        }
        return rows;
    }

    // CPU 參考，分片讓出主執行緒（大形狀，例如 512×1024×3072，同步算會凍結頁面）
    async function matmulRefYield(a, ad, b, bd, yieldTo, rowsPerChunk) {
        const M = ad[0], K = ad[1], N = bd[1]; const y = new Float32Array(M * N); const step = Math.max(1, rowsPerChunk || 4);
        for (let i0 = 0; i0 < M; i0 += step) {
            for (let i = i0; i < Math.min(M, i0 + step); i++) for (let j = 0; j < N; j++) { let acc = 0; for (let k = 0; k < K; k++) acc += a[i * K + k] * b[k * N + j]; y[i * N + j] = acc; }
            if (yieldTo) await yieldTo();
        }
        return y;
    }
    // 矩陣乘的候選：cudaweb（呼叫 mm.matmul）與 ORT 的 WebGPU／WASM 後端。env.ref 有就用它（分片算好的參考）。
    // mm: { matmul(a, ad, b, bd) → Promise<{ y }> }   ort: 注入的 ORT 模組（InferenceSession、Tensor）
    function matmulCandidates(spec, env) {
        const { M, K, N } = spec; const cache = (env && env.cache) || {};
        const data = makeMatmulInputs(M, K, N, (env && env.seed) || 7);
        const ref = env && env.ref ? env.ref : matmulRef(data.a, data.ad, data.b, data.bd);
        const cands = [{ id: 'cudaweb', run: async () => { const r = await env.mm.matmul(data.a, data.ad, data.b, data.bd, {}); return Float32Array.from(r.y); } }];
        for (const id of ['ort-webgpu', 'ort-wasm']) {
            cands.push({ id, run: async () => ortMatmul((env.orts && env.orts[id]) || env.ort, id, M, K, N, cache)(data.a, data.b) });   // 每個後端用自己的 ORT 組建（webgpu 組建 ≠ wasm 組建）
        }
        return { ref, data, cands };
    }
    // ORT 會話：key 含後端、運算種類（matmul）與形狀（softmax 與 RMSNorm 同形狀時不能共用）
    function ortMatmul(ort, backendId, M, K, N, cache) {
        const ep = backendId === 'ort-webgpu' ? 'webgpu' : 'wasm';   // 後端 id（ort-webgpu）≠ EP 名稱（webgpu）
        const k = ['matmul', backendId, M, K, N].join('|');
        return async (a, b) => {
            if (!ort || !ort.InferenceSession) throw new Error('ORT 沒有載入（' + backendId + '）');
            if (!cache[k]) cache[k] = ort.InferenceSession.create(onnxMatMulBytes(M, K, N), { executionProviders: [ep] });
            const sess = await cache[k];
            const feeds = { A: new ort.Tensor('float32', a, [M, K]), B: new ort.Tensor('float32', b, [K, N]) };
            const res = await sess.run(feeds);
            const data = res.Y.getData ? await res.Y.getData() : res.Y.data;   // getData() 可能回 promise
            return Float32Array.from(data);
        };
    }

    return { runCase, matmulCandidates, ortMatmul, makeMatmulInputs, matmulRef, matmulRefYield, onnxMatMulBytes, TOL };
}));
