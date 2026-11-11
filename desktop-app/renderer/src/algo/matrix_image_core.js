/* 圖片壓縮的矩陣化（DESIGN.matrix-fallback.md §13 第 3 項）：JPEG 式的流程與 PNG 濾波器。
 *   ① DCT-II：基矩陣 C（正交），二維變換 F = C·X·Cᵀ，反變換 X = Cᵀ·F·C（兩次矩陣乘法）。
 *   ② YCbCr（JFIF）：色彩轉換是 3×3 矩陣＋偏移向量；反轉換是另一個 3×3 矩陣。
 *   ③ 量化：逐元素除以量化表再取整（非線性，取整）；反量化是逐元素乘回去。量化表用 JPEG 標準 Annex K 亮度表＋IJG 品質縮放。
 *   ④ Z 字形掃描：8×8 的索引順序（JPEG 標準的對角線走法），是一個置換矩陣。
 *   ⑤ PNG 濾波器：Sub（x − 左）與 Up（x − 上）是模 256 的線性式，可寫成矩陣；Average 與 Paeth 含整數除法與比較，不是線性，這裡只給直接實作，明說「不矩陣化」。
 * 純函式（UMD）。不做：霍夫曼熵編碼、彩色子取樣的 4:2:0 細節、檔案格式（JFIF／PNG chunk）的讀寫。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaMatrixImage = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    function matMul(A, B) {
        const n = A.length, m = B[0].length, k = B.length; const C = [];
        for (let i = 0; i < n; i++) { const row = new Array(m).fill(0); for (let t = 0; t < k; t++) { const a = A[i][t]; if (a === 0) continue; for (let j = 0; j < m; j++) row[j] += a * B[t][j]; } C.push(row); }
        return C;
    }
    function transpose(A) { return A[0].map((_, j) => A.map((r) => r[j])); }

    // ① DCT-II 正交基矩陣（N×N）：C[k][n] = s(k)·cos((2n+1)kπ / 2N)，s(0)=√(1/N)，其餘 √(2/N)
    function dctMatrix(N) {
        const C = [];
        for (let k = 0; k < N; k++) {
            const s = k === 0 ? Math.sqrt(1 / N) : Math.sqrt(2 / N); const row = [];
            for (let n = 0; n < N; n++) row.push(s * Math.cos(((2 * n + 1) * k * Math.PI) / (2 * N)));
            C.push(row);
        }
        return C;
    }
    function dct2(X) { const C = dctMatrix(X.length); return matMul(matMul(C, X), transpose(C)); }
    function idct2(F) { const C = dctMatrix(F.length); return matMul(matMul(transpose(C), F), C); }

    // ② YCbCr（JFIF，8 位元）：Y/Cb/Cr = M·(R,G,B) + (0,128,128)；反轉換 = M⁻¹ 近似（JFIF 係數）
    const RGB2YCC = [[0.299, 0.587, 0.114], [-0.168736, -0.331264, 0.5], [0.5, -0.418688, -0.081312]];
    const YCC2RGB = [[1, 0, 1.402], [1, -0.344136, -0.714136], [1, 1.772, 0]];
    function rgbToYcc(rgb) { return RGB2YCC.map((row, i) => row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2] + (i === 0 ? 0 : 128)); }
    function yccToRgb(ycc) { return YCC2RGB.map((row) => row[0] * ycc[0] + row[1] * (ycc[1] - 128) + row[2] * (ycc[2] - 128)); }

    // ③ 量化：JPEG Annex K.1 亮度表（列優先）與 IJG 品質縮放
    const LUMA = [
        [16, 11, 10, 16, 24, 40, 51, 61], [12, 12, 14, 19, 26, 58, 60, 55], [14, 13, 16, 24, 40, 57, 69, 56], [14, 17, 22, 29, 51, 87, 80, 62],
        [18, 22, 37, 56, 68, 109, 103, 77], [24, 35, 55, 64, 81, 104, 113, 92], [49, 64, 78, 87, 103, 121, 120, 101], [72, 92, 95, 98, 112, 100, 103, 99]];
    function qualityTable(q) {
        const quality = Math.min(100, Math.max(1, Math.round(q)));
        const scale = quality < 50 ? 5000 / quality : 200 - 2 * quality;
        return LUMA.map((row) => row.map((t) => Math.min(255, Math.max(1, Math.floor((t * scale + 50) / 100)))));
    }
    function quantize(F, Q) { return F.map((row, i) => row.map((v, j) => Math.round(v / Q[i][j]))); }
    function dequantize(q, Q) { return q.map((row, i) => row.map((v, j) => v * Q[i][j])); }

    // ④ Z 字形：回傳 64 個（列, 欄）索引，依 JPEG 的對角線走法（先右上、再左下交替）
    function zigzagOrder(N) {
        const out = []; let i = 0, j = 0;
        for (let k = 0; k < N * N; k++) {
            out.push([i, j]);
            if ((i + j) % 2 === 0) { // 向右上
                if (j === N - 1) i++; else if (i === 0) j++; else { i--; j++; }
            } else { // 向左下
                if (i === N - 1) j++; else if (j === 0) i++; else { i++; j--; }
            }
        }
        return out;
    }

    // ⑤ PNG 濾波器（bpp＝每像素位元組數；左邊界以 0 補）
    function pngSub(row, bpp) { return row.map((x, i) => (x - (i >= bpp ? row[i - bpp] : 0) + 256) % 256); }
    function pngUp(row, prev) { return row.map((x, i) => (x - prev[i] + 256) % 256); }
    function pngAverage(row, prev, bpp) { return row.map((x, i) => (x - Math.floor(((i >= bpp ? row[i - bpp] : 0) + prev[i]) / 2) + 256) % 256); }
    function paeth(a, b, c) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
    function pngPaeth(row, prev, bpp) { return row.map((x, i) => { const a = i >= bpp ? row[i - bpp] : 0, c = i >= bpp ? prev[i - bpp] : 0; return (x - paeth(a, prev[i], c) + 256) % 256; }); }
    // Sub 的矩陣形式：S[i][j] = 1（j=i）、−1（j=i−bpp）；模 256 後是矩陣乘法（與 pngSub 一致）
    function subMatrix(n, bpp) { return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (j === i ? 1 : j === i - bpp ? 255 : 0))); }
    function matVecMod256(M, v) { return M.map((row) => row.reduce((s, a, j) => (s + a * v[j]) % 256, 0)); }

    return { matMul, transpose, dctMatrix, dct2, idct2, rgbToYcc, yccToRgb, qualityTable, quantize, dequantize, zigzagOrder, pngSub, pngUp, pngAverage, pngPaeth, subMatrix, matVecMod256, LUMA };
});
