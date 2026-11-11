/* 網頁版 LoRA：把 LoRA 的 B·A 併進 q8（動態量化）權重，不需要槽版模型、不需要改計算圖（DESIGN.TODO.offline-training-studio.md §14 路線 c）。
 *  純函式核心（UMD）：Node 與瀏覽器（含 Worker）都能載入。
 *
 *  為什麼不能直接「反量化→加上 BA→用原本的縮放重新量化」：q8 每個張量只有一個縮放值，步距約等於整張權重範圍的 1/255，
 *  LoRA 的變化量（每個元素約步距的 0.3%～3%）比步距小得多，四捨五入後整個消失（數值實驗：與目標變化量的餘弦相似度 ≈ 0）。
 *  本核心的做法（細格＋抖動）：
 *   1. 每個輸出欄（column）自己一個縮放：新步距 = 舊步距 / k，k 是整數，取「該欄權重範圍還塞得進 8 位元」的最大值（上限 maxK）。
 *      因為 k 是整數，舊權重在新格子上「剛好落在格點」，基底權重不會多出量化誤差。
 *   2. 變化量 d（以新步距為單位）用「抖動式四捨五入」取整：floor(x + u)，u 是固定種子的均勻亂數。這樣期望值保留 d（不偏），
 *      即使 |d| 遠小於一格也不會消失；代價是每個元素多一點隨機雜訊（實驗：約基底輸出的 2%，比 q8 本身的誤差小很多）。
 *   3. 縮放值從「純量」變成「長度 dout 的向量」：計算圖裡 W_scale 只參與 Mul（廣播），零點維持純量不動，不需要每欄零點。
 *  零 adapter（全 0）時：idx 恰為整數，floor(idx + u) = idx → 權重值與基底完全相同（只是縮放向量 = 舊縮放 / k，反量化後相等）。
 *
 *  API：
 *   mergeTensor({q, dtype:'uint8'|'int8', zp, scale, din, dout, A, B, rank, seed, maxK, probes}) → {scales:Float32Array(dout), kMean, kMin, stats}
 *      q：Uint8Array（int8 也用 Uint8Array 視圖，內部以補數處理），原地修改；A：Float32Array din×rank（列優先）；B：Float32Array rank×dout
 *      stats：{dSq, effSq, dot, outCos, outRelErr, clipped, n}
 *   computeLayout(targets, rank) → {tensors:[{name,dims,offset,length}], total}   與 lora-train/make_lora_onnx.py 的版面完全相同
 *   mulberry32(seed)、hashSeed(str) */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaLoraMerge = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';
    const ALIGN = 64;
    const PROJ = ['q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj'];

    function hashSeed(s) { let h = 2166136261 >>> 0; s = String(s); for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return h >>> 0; }
    function mulberry32(a) { return function () { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
    function gauss(rnd) { let u = 0, v = 0; while (u === 0) u = rnd(); v = rnd(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }

    // targets：[{layer, proj, din, dout}]，依 make_lora_onnx.py 的順序（層遞增、PROJ 固定順序）；每個目標 A[din,rank] 再 B[rank,dout]，各自對齊 64 位元組
    function computeLayout(targets, rank) {
        const tensors = []; let off = 0;
        const order = (t) => t.layer * 100 + PROJ.indexOf(t.proj);
        const sorted = targets.slice().sort((a, b) => order(a) - order(b));
        for (const t of sorted) {
            for (const [ab, dims] of [['A', [t.din, rank]], ['B', [rank, t.dout]]]) {
                const length = dims[0] * dims[1] * 4;
                tensors.push({ name: 'lora.' + t.layer + '.' + t.proj + '.' + ab, dims, offset: off, length });
                off += Math.ceil(length / ALIGN) * ALIGN;
            }
        }
        return { tensors, total: off, rank };
    }

    function mergeTensor(o) {
        const { q, din, dout, A, B, rank } = o;
        const signed = o.dtype === 'int8';
        if (o.dtype !== 'uint8' && o.dtype !== 'int8') throw new Error('不支援的權重型別：' + o.dtype);
        if (q.length !== din * dout) throw new Error('權重長度 ' + q.length + ' 與 ' + din + '×' + dout + ' 不符');
        if (A.length !== din * rank || B.length !== rank * dout) throw new Error('A／B 長度與 rank 不符');
        const zp = o.zp | 0, s = Number(o.scale);
        if (!(s > 0) || !isFinite(s)) throw new Error('縮放值不是正數：' + o.scale);
        const lo = signed ? -128 : 0, hi = signed ? 127 : 255;
        const negCap = zp - lo, posCap = hi - zp;                 // 以「中心化值 c = q - zp」表示時的容量
        const maxK = o.maxK || 64;
        const cOf = signed ? (i) => (q[i] << 24 >> 24) - zp : (i) => q[i] - zp;
        // 每欄的極值
        const cmin = new Int32Array(dout).fill(0), cmax = new Int32Array(dout).fill(0);
        for (let i = 0; i < din; i++) { const base = i * dout; for (let j = 0; j < dout; j++) { const c = cOf(base + j); if (c < cmin[j]) cmin[j] = c; else if (c > cmax[j]) cmax[j] = c; } }
        const k = new Float64Array(dout), scales = new Float32Array(dout);
        let kSum = 0, kMin = Infinity;
        for (let j = 0; j < dout; j++) {
            const n = -cmin[j] + 1, p = cmax[j] + 1;               // 保留 1 個舊格當作變化量的餘裕
            let kj = Math.floor(Math.min(negCap / n, posCap / p));
            if (!(kj >= 1)) kj = 1;
            if (kj > maxK) kj = maxK;
            k[j] = kj; scales[j] = s / kj; kSum += kj; if (kj < kMin) kMin = kj;
        }
        const rnd = mulberry32(o.seed >>> 0);
        // 探針：x = 高斯 + 3√din·A·z（訓練出來的 adapter 看到的輸入會偏向 A 的列空間；與數值實驗相同），用來估「輸出空間」的保留程度
        const P = o.probes === undefined ? 4 : o.probes;
        const xs = [], yT = [], yE = [];
        for (let pi = 0; pi < P; pi++) {
            const x = new Float64Array(din); for (let i = 0; i < din; i++) x[i] = gauss(rnd);
            const z = new Float64Array(rank); for (let r = 0; r < rank; r++) z[r] = gauss(rnd);
            const sq = 3 * Math.sqrt(din);
            for (let i = 0; i < din; i++) { let a = 0; for (let r = 0; r < rank; r++) a += A[i * rank + r] * z[r]; x[i] += sq * a; }
            xs.push(x); yT.push(new Float64Array(dout)); yE.push(new Float64Array(dout));
        }
        const tmp = new Float64Array(dout);
        let dSq = 0, effSq = 0, dot = 0, clipped = 0;
        for (let i = 0; i < din; i++) {
            tmp.fill(0);
            for (let r = 0; r < rank; r++) { const a = A[i * rank + r]; if (a === 0) continue; const bo = r * dout; for (let j = 0; j < dout; j++) tmp[j] += a * B[bo + j]; }
            const base = i * dout;
            for (let j = 0; j < dout; j++) {
                const d = tmp[j], kj = k[j];
                const c = cOf(base + j);
                const x = c * kj + d * kj / s;                      // 新步距（s/kj）為單位的目標值
                let c2 = Math.floor(x + rnd());
                if (c2 < -negCap) { c2 = -negCap; clipped++; } else if (c2 > posCap) { c2 = posCap; clipped++; }
                q[base + j] = c2 + zp;                              // Uint8Array 會自動取模；int8 的補數表示同樣成立
                const eff = (c2 - c * kj) * s / kj;                 // 實際寫進去的變化量
                dSq += d * d; effSq += eff * eff; dot += d * eff;
                for (let pi = 0; pi < P; pi++) { const xi = xs[pi][i]; yT[pi][j] += xi * d; yE[pi][j] += xi * eff; }
            }
        }
        let tt = 0, ee = 0, te = 0, diff = 0;
        for (let pi = 0; pi < P; pi++) for (let j = 0; j < dout; j++) { const t = yT[pi][j], e = yE[pi][j]; tt += t * t; ee += e * e; te += t * e; diff += (e - t) * (e - t); }
        const outCos = tt > 0 && ee > 0 ? te / Math.sqrt(tt * ee) : (tt === 0 && ee === 0 ? 1 : 0);
        const outRelErr = tt > 0 ? Math.sqrt(diff / tt) : (ee === 0 ? 0 : Infinity);
        return { scales, kMean: kSum / dout, kMin, stats: { dSq, effSq, dot, outCos, outRelErr, clipped, n: din * dout } };
    }
    return { mergeTensor, computeLayout, mulberry32, hashSeed, PROJ, ALIGN };
});
