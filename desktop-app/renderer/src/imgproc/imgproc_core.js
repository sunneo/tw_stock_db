/* 圖片處理核心（UMD，純函式，不碰 DOM／canvas／網路）：給「圖片轉 PDF」工具（images_to_pdf）處理每一頁的圖片用。
 * 影像物件：{ width, height, data: Uint8ClampedArray（RGBA） }。每個操作吃一個影像回傳一個影像（可能是同一個物件、也可能是新的）。
 * 操作（op）：灰階 grayscale、亮度 brightness、對比 contrast、飽和度 saturation、gamma、自動對比 auto_contrast、
 *   影像強化 enhance（自動對比＋輕微銳化＋飽和度）、色調強化 tone（自動白平衡＋對比＋飽和度＋色溫）、減少色彩 reduce_colors（中位切割，可抖色）、
 *   色階分離 posterize、二值化 threshold（預設 Otsu）、反相 invert、高斯模糊 blur、銳化 sharpen、馬賽克 mosaic（可只蓋一個區域）、
 *   旋轉 rotate（任意角度，順時針）、縮放 scale、裁切 crop、翻轉 flip。
 * 為什麼全部用純 JS 寫（不用 canvas filter）：可以在 Node 裡單元測試、結果可重現（不看瀏覽器版本）、可以放進 worker。
 * normalizeOps 先驗證整串操作（名稱、參數範圍）再開始處理——有一個錯就整串不跑，不會做到一半才失敗。 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) module.exports = factory();
    else root.FaImgProc = factory();
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const MAX_PIXELS = 120e6; // 單張處理後的像素上限（約 120MP），超過就拒絕（避免記憶體爆掉）
    const ALIASES = {
        grayscale: ['grayscale', 'gray', 'greyscale', 'grey', 'bw', '灰階', '灰度', '黑白'],
        brightness: ['brightness', '亮度'], contrast: ['contrast', '對比', '對比度'], saturation: ['saturation', '飽和度', '飽和'], gamma: ['gamma', '伽瑪'],
        auto_contrast: ['auto_contrast', 'autocontrast', 'auto_levels', 'levels', '自動對比', '自動色階'],
        enhance: ['enhance', 'enhancement', 'improve', '影像強化', '圖像強化', '強化', '增強'],
        tone: ['tone', 'tone_enhance', 'color_enhance', 'color_correct', '色調強化', '色調', '調色', '色彩強化'],
        reduce_colors: ['reduce_colors', 'reduce_colours', 'quantize', 'palette', 'color_reduce', '減少色彩', '減色', '色彩數'],
        posterize: ['posterize', '色階分離'], threshold: ['threshold', 'binarize', 'binary', '二值化', '黑白二值'], invert: ['invert', 'negative', '反相', '負片'],
        blur: ['blur', 'gaussian_blur', 'gaussian', 'gauss', '高斯模糊', '模糊'], sharpen: ['sharpen', 'unsharp', '銳化', '銳利化'],
        mosaic: ['mosaic', 'pixelate', 'pixelize', '馬賽克', '像素化'],
        rotate: ['rotate', 'rotation', '旋轉'], scale: ['scale', 'resize', 'zoom', '縮放', '調整大小', '縮小', '放大'], crop: ['crop', 'trim', '裁切', '裁剪'], flip: ['flip', 'mirror', '翻轉', '鏡像'],
    };
    const NAME_OF = Object.create(null);
    for (const [name, list] of Object.entries(ALIASES)) for (const a of list) NAME_OF[a.toLowerCase()] = name;
    const GEOMETRIC = new Set(['rotate', 'scale', 'crop', 'flip']);
    const num = (v, d) => { if (v === '' || v == null) return d; const n = Number(v); return Number.isFinite(n) ? n : d; };
    const clampN = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;
    const make = (w, h) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) });
    const clone = (img) => ({ width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) });

    function parseColor(c, fallback) {
        if (c == null || c === '') return fallback || [255, 255, 255, 255];
        if (Array.isArray(c)) return [c[0] | 0, c[1] | 0, c[2] | 0, c.length > 3 ? c[3] | 0 : 255];
        const s = String(c).trim().toLowerCase();
        if (s === 'transparent') return [0, 0, 0, 0];
        if (s === 'white' || s === '白') return [255, 255, 255, 255];
        if (s === 'black' || s === '黑') return [0, 0, 0, 255];
        let m = /^#?([0-9a-f]{6})$/.exec(s); if (m) return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16), 255];
        m = /^#?([0-9a-f]{3})$/.exec(s); if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16), 255];
        return fallback || [255, 255, 255, 255];
    }

    // ───────────────────────── 逐像素的操作 ─────────────────────────
    function grayscale(img) { const d = img.data; for (let i = 0; i < d.length; i += 4) { const y = luma(d[i], d[i + 1], d[i + 2]); d[i] = d[i + 1] = d[i + 2] = y; } return img; }
    function lutApply(img, lut) { const d = img.data; for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; } return img; }
    function brightness(img, p) { const a = clampN(num(p.amount, 0), -100, 100) * 2.55; const lut = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) lut[v] = v + a; return lutApply(img, lut); }
    function contrast(img, p) { const c = clampN(num(p.amount, 0), -100, 100) * 2.55; const f = (259 * (c + 255)) / (255 * (259 - c)); const lut = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) lut[v] = f * (v - 128) + 128; return lutApply(img, lut); }
    function gamma(img, p) { const g = clampN(num(p.value, 1), 0.1, 10); const lut = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) lut[v] = 255 * Math.pow(v / 255, 1 / g); return lutApply(img, lut); }
    function saturation(img, p) {
        const s = 1 + clampN(num(p.amount, 0), -100, 100) / 100, d = img.data;
        for (let i = 0; i < d.length; i += 4) { const y = luma(d[i], d[i + 1], d[i + 2]); d[i] = y + (d[i] - y) * s; d[i + 1] = y + (d[i + 1] - y) * s; d[i + 2] = y + (d[i + 2] - y) * s; }
        return img;
    }
    // 自動對比：用亮度直方圖找出兩端各 clip% 的位置，整個拉伸到 0..255（三個通道用同一條曲線，色相不跑掉）；per_channel 則各自拉伸（順便修偏色）
    function autoContrast(img, p) {
        const clip = clampN(num(p.clip, 0.5), 0, 10) / 100, d = img.data, n = img.width * img.height;
        const edges = (hist) => { let lo = 0, hi = 255, acc = 0; const cut = n * clip; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > cut) { lo = v; break; } } acc = 0; for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > cut) { hi = v; break; } } return [lo, hi]; };
        const mkLut = (lo, hi) => { const lut = new Uint8ClampedArray(256); if (hi - lo < 8) { for (let v = 0; v < 256; v++) lut[v] = v; return lut; } for (let v = 0; v < 256; v++) lut[v] = (v - lo) * 255 / (hi - lo); return lut; };
        if (p.per_channel) {
            const h = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
            for (let i = 0; i < d.length; i += 4) { h[0][d[i]]++; h[1][d[i + 1]]++; h[2][d[i + 2]]++; }
            const luts = h.map((x) => mkLut(...edges(x))); for (let i = 0; i < d.length; i += 4) { d[i] = luts[0][d[i]]; d[i + 1] = luts[1][d[i + 1]]; d[i + 2] = luts[2][d[i + 2]]; }
            return img;
        }
        const hist = new Uint32Array(256); for (let i = 0; i < d.length; i += 4) hist[luma(d[i], d[i + 1], d[i + 2]) | 0]++;
        return lutApply(img, mkLut(...edges(hist)));
    }
    // 自動白平衡（灰色世界假設）：把三個通道的平均拉到一樣；增益限制在 0.7..1.4，不會把整張圖染色
    function whiteBalance(img) {
        const d = img.data; let r = 0, g = 0, b = 0; const n = d.length / 4; if (!n) return img;
        for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
        r /= n; g /= n; b /= n; const m = (r + g + b) / 3 || 1; const gr = clampN(m / (r || 1), 0.7, 1.4), gg = clampN(m / (g || 1), 0.7, 1.4), gb = clampN(m / (b || 1), 0.7, 1.4);
        for (let i = 0; i < d.length; i += 4) { d[i] *= gr; d[i + 1] *= gg; d[i + 2] *= gb; }
        return img;
    }
    function warmth(img, p) { const w = clampN(num(p.warmth, 0), -100, 100) / 400, d = img.data; for (let i = 0; i < d.length; i += 4) { d[i] *= 1 + w; d[i + 2] *= 1 - w; } return img; }

    // 高斯模糊：三次方框模糊逼近（O(1)/像素，半徑再大也不慢；誤差約 3%）。radius＝標準差（像素）。只模糊 RGB，alpha 不動。
    function boxesForGauss(sigma, n) {
        const wIdeal = Math.sqrt((12 * sigma * sigma / n) + 1); let wl = Math.floor(wIdeal); if (wl % 2 === 0) wl--; const wu = wl + 2;
        const mIdeal = (12 * sigma * sigma - n * wl * wl - 4 * n * wl - 3 * n) / (-4 * wl - 4); const m = Math.round(mIdeal);
        const sizes = []; for (let i = 0; i < n; i++) sizes.push(i < m ? wl : wu); return sizes;
    }
    function boxBlurPlane(src, dst, w, h, r) { boxH(src, dst, w, h, r); boxT(dst, src, w, h, r); }
    function boxH(src, dst, w, h, r) {
        const iarr = 1 / (r + r + 1);
        for (let y = 0; y < h; y++) {
            let ti = y * w, li = ti, ri = ti + r; const fv = src[ti], lv = src[ti + w - 1]; let val = (r + 1) * fv;
            for (let j = 0; j < r; j++) val += src[ti + Math.min(j, w - 1)];
            for (let j = 0; j <= r; j++) { val += (ri < ti + w ? src[ri] : lv) - fv; ri++; dst[ti++] = Math.round(val * iarr); }
            for (let j = r + 1; j < w - r; j++) { val += (ri < ti - j + w ? src[ri] : lv) - src[li]; ri++; li++; dst[ti++] = Math.round(val * iarr); }
            for (let j = w - r; j < w; j++) { val += lv - src[li]; li++; dst[ti++] = Math.round(val * iarr); }
        }
    }
    function boxT(src, dst, w, h, r) {
        const iarr = 1 / (r + r + 1);
        for (let x = 0; x < w; x++) {
            let ti = x, li = ti, ri = ti + r * w; const fv = src[ti], lv = src[ti + w * (h - 1)]; let val = (r + 1) * fv;
            for (let j = 0; j < r; j++) val += src[ti + Math.min(j, h - 1) * w];
            for (let j = 0; j <= r; j++) { val += (ri < w * h ? src[ri] : lv) - fv; ri += w; dst[ti] = Math.round(val * iarr); ti += w; }
            for (let j = r + 1; j < h - r; j++) { val += (ri < w * h ? src[ri] : lv) - src[li]; ri += w; li += w; dst[ti] = Math.round(val * iarr); ti += w; }
            for (let j = h - r; j < h; j++) { val += lv - src[li]; li += w; dst[ti] = Math.round(val * iarr); ti += w; }
        }
    }
    function blur(img, p) {
        const sigma = clampN(num(p.sigma != null ? p.sigma : p.radius, 2), 0, 200); if (sigma < 0.3) return img;
        const w = img.width, h = img.height, n = w * h, d = img.data, boxes = boxesForGauss(sigma, 3);
        const a = new Uint8ClampedArray(n), b = new Uint8ClampedArray(n);
        for (let c = 0; c < 3; c++) {
            for (let i = 0, k = c; i < n; i++, k += 4) a[i] = d[k];
            for (const bs of boxes) { const r = Math.max(0, Math.min((bs - 1) >> 1, ((Math.min(w, h)) >> 1) - 1)); if (r > 0) boxBlurPlane(a, b, w, h, r); }
            for (let i = 0, k = c; i < n; i++, k += 4) d[k] = a[i];
        }
        return img;
    }
    // 銳化（unsharp mask）：原圖 + amount × (原圖 − 模糊圖)；差異小於 threshold 的不動（不放大雜訊）
    function sharpen(img, p) {
        const amount = clampN(num(p.amount, 1), 0, 5), radius = clampN(num(p.radius, 1.5), 0.3, 20), thr = clampN(num(p.threshold, 0), 0, 255);
        if (amount <= 0) return img;
        const blurred = blur(clone(img), { sigma: radius }), d = img.data, b = blurred.data;
        for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) { const diff = d[i + c] - b[i + c]; if (Math.abs(diff) > thr) d[i + c] = d[i + c] + amount * diff; }
        return img;
    }
    // 影像強化＝自動對比（頭尾各 0.4%）＋一點點飽和度＋銳化；strength 0..1（預設 0.6）
    function enhance(img, p) {
        const s = clampN(num(p.strength, 0.6), 0, 1);
        autoContrast(img, { clip: 0.4 }); saturation(img, { amount: 12 * s }); return sharpen(img, { amount: 0.4 + 0.9 * s, radius: 1.2, threshold: 2 });
    }
    // 色調強化＝自動白平衡（可關）＋對比＋飽和度＋色溫＋亮度
    function tone(img, p) {
        if (p.white_balance !== false && p.white_balance !== 0 && p.white_balance !== 'false') whiteBalance(img);
        const c = num(p.contrast, 20), s = num(p.saturation, 15), w = num(p.warmth, 0), b = num(p.brightness, 0);
        if (c) contrast(img, { amount: c }); if (s) saturation(img, { amount: s }); if (w) warmth(img, { warmth: w }); if (b) brightness(img, { amount: b });
        return img;
    }
    function posterize(img, p) { const L = Math.round(clampN(num(p.levels, 4), 2, 64)); const lut = new Uint8ClampedArray(256); for (let v = 0; v < 256; v++) lut[v] = Math.round(Math.round(v / 255 * (L - 1)) * 255 / (L - 1)); return lutApply(img, lut); }
    function invert(img) { const d = img.data; for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } return img; }
    function otsu(hist, total) {
        let sum = 0; for (let t = 0; t < 256; t++) sum += t * hist[t]; let sumB = 0, wB = 0, best = 0, thr = 128;
        for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sumB += t * hist[t]; const mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = t; } }
        return thr;
    }
    function threshold(img, p) {
        const d = img.data, n = img.width * img.height; let level;
        if (p.level == null || p.level === 'otsu' || p.level === 'auto') { const hist = new Uint32Array(256); for (let i = 0; i < d.length; i += 4) hist[luma(d[i], d[i + 1], d[i + 2]) | 0]++; level = otsu(hist, n); } else level = clampN(num(p.level, 128), 0, 255);
        const inv = !!p.invert;
        for (let i = 0; i < d.length; i += 4) { const on = luma(d[i], d[i + 1], d[i + 2]) > level; const v = (on !== inv) ? 255 : 0; d[i] = d[i + 1] = d[i + 2] = v; }
        return img;
    }
    // 馬賽克：每個 block×block 的格子填成平均色。region：{x,y,w,h}，單位 percent（0..100，預設）或 px（unit:'px'）；沒給就是整張
    function regionRect(img, r, unit) {
        if (!r) return { x: 0, y: 0, w: img.width, h: img.height };
        const px = unit === 'px', fx = px ? 1 : img.width / 100, fy = px ? 1 : img.height / 100;
        const x = Math.round(clampN(num(r.x, 0) * fx, 0, img.width)), y = Math.round(clampN(num(r.y, 0) * fy, 0, img.height));
        const w = Math.round(clampN(num(r.w != null ? r.w : r.width, px ? img.width : 100) * fx, 0, img.width - x)), h = Math.round(clampN(num(r.h != null ? r.h : r.height, px ? img.height : 100) * fy, 0, img.height - y));
        return { x, y, w, h };
    }
    function mosaic(img, p) {
        const rect = regionRect(img, p.region, p.unit); if (rect.w < 1 || rect.h < 1) return img;
        let bs = Math.round(num(p.block, 0)); if (!(bs >= 1)) bs = Math.max(4, Math.round(Math.max(img.width, img.height) * clampN(num(p.size_percent, 2), 0.2, 50) / 100));
        const d = img.data, W = img.width;
        for (let by = rect.y; by < rect.y + rect.h; by += bs) for (let bx = rect.x; bx < rect.x + rect.w; bx += bs) {
            const x1 = Math.min(bx + bs, rect.x + rect.w), y1 = Math.min(by + bs, rect.y + rect.h); let r = 0, g = 0, b = 0, a = 0, n = 0;
            for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const i = (y * W + x) * 4; r += d[i]; g += d[i + 1]; b += d[i + 2]; a += d[i + 3]; n++; }
            if (!n) continue; r /= n; g /= n; b /= n; a /= n;
            for (let y = by; y < y1; y++) for (let x = bx; x < x1; x++) { const i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; }
        }
        return img;
    }
    // 減少色彩：中位切割（median cut）。先把顏色量化成 5bit/通道的直方圖，再反覆把「範圍最大的盒子」從加權中位數切開，直到有 colors 個盒子，每個盒子的加權平均色就是調色盤。dither：Floyd–Steinberg
    function reduceColors(img, p) {
        const K = Math.round(clampN(num(p.colors, 16), 2, 256)), d = img.data, n = img.width * img.height;
        const hist = new Uint32Array(32768); for (let i = 0; i < d.length; i += 4) hist[((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3)]++;
        const cols = []; for (let k = 0; k < 32768; k++) if (hist[k]) cols.push(k);
        const rgbOf = (k) => [((k >> 10) & 31) << 3 | 4, ((k >> 5) & 31) << 3 | 4, (k & 31) << 3 | 4];
        let boxes = [cols];
        const range = (box) => { let mn = [255, 255, 255], mx = [0, 0, 0]; for (const k of box) { const c = rgbOf(k); for (let j = 0; j < 3; j++) { if (c[j] < mn[j]) mn[j] = c[j]; if (c[j] > mx[j]) mx[j] = c[j]; } } const r = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]]; const ch = r[0] >= r[1] && r[0] >= r[2] ? 0 : (r[1] >= r[2] ? 1 : 2); return { ch, size: r[ch] }; };
        while (boxes.length < K) {
            let bi = -1, bs = -1; boxes.forEach((b, i) => { if (b.length < 2) return; const r = range(b); if (r.size > bs) { bs = r.size; bi = i; } });
            if (bi < 0 || bs <= 0) break;
            const box = boxes[bi], ch = range(box).ch; box.sort((a, b) => rgbOf(a)[ch] - rgbOf(b)[ch]);
            let total = 0; for (const k of box) total += hist[k]; let acc = 0, cut = 1; for (let i = 0; i < box.length; i++) { acc += hist[box[i]]; if (acc >= total / 2) { cut = Math.max(1, Math.min(box.length - 1, i + 1)); break; } }
            boxes.splice(bi, 1, box.slice(0, cut), box.slice(cut));
        }
        const palette = boxes.map((box) => { let r = 0, g = 0, b = 0, t = 0; for (const k of box) { const c = rgbOf(k), w = hist[k]; r += c[0] * w; g += c[1] * w; b += c[2] * w; t += w; } return t ? [Math.round(r / t), Math.round(g / t), Math.round(b / t)] : [0, 0, 0]; });
        const near = (r, g, b) => { let bi = 0, bd = Infinity; for (let i = 0; i < palette.length; i++) { const q = palette[i], dr = r - q[0], dg = g - q[1], db = b - q[2], dd = dr * dr + dg * dg + db * db; if (dd < bd) { bd = dd; bi = i; } } return bi; };
        if (!p.dither) {
            const cache = new Int16Array(32768).fill(-1);
            for (let i = 0; i < d.length; i += 4) { const k = ((d[i] >> 3) << 10) | ((d[i + 1] >> 3) << 5) | (d[i + 2] >> 3); let pi = cache[k]; if (pi < 0) pi = cache[k] = near(d[i], d[i + 1], d[i + 2]); const q = palette[pi]; d[i] = q[0]; d[i + 1] = q[1]; d[i + 2] = q[2]; }
            return img;
        }
        const W = img.width, H = img.height; let cur = new Float32Array((W + 2) * 3), nxt = new Float32Array((W + 2) * 3);
        for (let y = 0; y < H; y++) {
            nxt.fill(0);
            for (let x = 0; x < W; x++) {
                const i = (y * W + x) * 4; const r = clampN(d[i] + cur[(x + 1) * 3], 0, 255), g = clampN(d[i + 1] + cur[(x + 1) * 3 + 1], 0, 255), b = clampN(d[i + 2] + cur[(x + 1) * 3 + 2], 0, 255);
                const q = palette[near(r, g, b)]; d[i] = q[0]; d[i + 1] = q[1]; d[i + 2] = q[2];
                const er = [r - q[0], g - q[1], b - q[2]];
                for (let c = 0; c < 3; c++) { cur[(x + 2) * 3 + c] += er[c] * 7 / 16; nxt[x * 3 + c] += er[c] * 3 / 16; nxt[(x + 1) * 3 + c] += er[c] * 5 / 16; nxt[(x + 2) * 3 + c] += er[c] / 16; }
            }
            const t = cur; cur = nxt; nxt = t;
        }
        void n; return img;
    }

    // ───────────────────────── 幾何操作 ─────────────────────────
    function flip(img, p) {
        const w = img.width, h = img.height, d = img.data, dir = String(p.direction || 'horizontal').toLowerCase(); const out = make(w, h), o = out.data;
        const v = dir === 'vertical' || dir === 'v' || dir === '垂直', both = dir === 'both';
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const sx = (v && !both) ? x : w - 1 - x, sy = (v || both) ? h - 1 - y : y; const s = (sy * w + sx) * 4, t = (y * w + x) * 4; o[t] = d[s]; o[t + 1] = d[s + 1]; o[t + 2] = d[s + 2]; o[t + 3] = d[s + 3]; }
        return out;
    }
    function crop(img, p) {
        const r = regionRect(img, { x: p.x, y: p.y, w: p.w != null ? p.w : p.width, h: p.h != null ? p.h : p.height }, p.unit);
        if (r.w < 1 || r.h < 1) throw new Error('裁切範圍是空的（x/y/w/h 要在圖片裡；預設單位是百分比 0～100，要用像素請加 unit:"px"）');
        const out = make(r.w, r.h); for (let y = 0; y < r.h; y++) { const s = ((r.y + y) * img.width + r.x) * 4; out.data.set(img.data.subarray(s, s + r.w * 4), y * r.w * 4); }
        return out;
    }
    function rotate(img, p) {
        let deg = num(p.degrees != null ? p.degrees : (p.angle != null ? p.angle : p.deg), 0); deg = ((deg % 360) + 360) % 360; if (deg === 0) return img;
        const w = img.width, h = img.height, d = img.data;
        if (deg === 90 || deg === 180 || deg === 270) { // 精確的直角旋轉（順時針）
            const ow = deg === 180 ? w : h, oh = deg === 180 ? h : w; const out = make(ow, oh), o = out.data;
            for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { let nx, ny; if (deg === 90) { nx = h - 1 - y; ny = x; } else if (deg === 180) { nx = w - 1 - x; ny = h - 1 - y; } else { nx = y; ny = w - 1 - x; } const s = (y * w + x) * 4, t = (ny * ow + nx) * 4; o[t] = d[s]; o[t + 1] = d[s + 1]; o[t + 2] = d[s + 2]; o[t + 3] = d[s + 3]; }
            return out;
        }
        const rad = deg * Math.PI / 180, cos = Math.cos(rad), sin = Math.sin(rad); const expand = p.expand !== false;
        const ow = expand ? Math.ceil(Math.abs(w * cos) + Math.abs(h * sin)) : w, oh = expand ? Math.ceil(Math.abs(w * sin) + Math.abs(h * cos)) : h;
        if (ow * oh > MAX_PIXELS) throw new Error('旋轉後的圖片太大（' + ow + '×' + oh + '）');
        const bg = parseColor(p.background, [255, 255, 255, 255]); const out = make(ow, oh), o = out.data; const cx = (w - 1) / 2, cy = (h - 1) / 2, ocx = (ow - 1) / 2, ocy = (oh - 1) / 2;
        for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
            const dx = x - ocx, dy = y - ocy; const sx = dx * cos + dy * sin + cx, sy = -dx * sin + dy * cos + cy; const t = (y * ow + x) * 4;
            if (sx < -0.5 || sy < -0.5 || sx > w - 0.5 || sy > h - 0.5) { o[t] = bg[0]; o[t + 1] = bg[1]; o[t + 2] = bg[2]; o[t + 3] = bg[3]; continue; }
            const x0 = Math.max(0, Math.min(w - 1, Math.floor(sx))), y0 = Math.max(0, Math.min(h - 1, Math.floor(sy))), x1 = Math.min(w - 1, x0 + 1), y1 = Math.min(h - 1, y0 + 1), fx = Math.max(0, sx - x0), fy = Math.max(0, sy - y0);
            for (let c = 0; c < 4; c++) { const a = d[(y0 * w + x0) * 4 + c], b = d[(y0 * w + x1) * 4 + c], e = d[(y1 * w + x0) * 4 + c], f = d[(y1 * w + x1) * 4 + c]; o[t + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (e * (1 - fx) + f * fx) * fy; }
        }
        return out;
    }
    // 一維重取樣的權重：縮小（s>1）用面積平均、放大用雙線性
    function weights(srcN, dstN) {
        const s = srcN / dstN, taps = [];
        for (let i = 0; i < dstN; i++) {
            if (s > 1) { const a = i * s, b = Math.min(srcN, (i + 1) * s); const lo = Math.floor(a), hi = Math.min(srcN - 1, Math.ceil(b) - 1); const idx = [], w = []; let tot = 0; for (let k = lo; k <= hi; k++) { const wt = Math.min(b, k + 1) - Math.max(a, k); if (wt > 0) { idx.push(k); w.push(wt); tot += wt; } } taps.push({ idx, w: w.map((x) => x / tot) }); }
            else { const c = (i + 0.5) * s - 0.5; const k0 = Math.max(0, Math.min(srcN - 1, Math.floor(c))), k1 = Math.min(srcN - 1, k0 + 1), f = Math.max(0, Math.min(1, c - k0)); taps.push({ idx: [k0, k1], w: [1 - f, f] }); }
        }
        return taps;
    }
    function resize(img, tw, th) {
        tw = Math.max(1, Math.round(tw)); th = Math.max(1, Math.round(th)); if (tw === img.width && th === img.height) return img;
        if (tw * th > MAX_PIXELS) throw new Error('縮放後的圖片太大（' + tw + '×' + th + '，上限約 ' + Math.round(MAX_PIXELS / 1e6) + ' 百萬像素）');
        const sw = img.width, sh = img.height, d = img.data, wx = weights(sw, tw), wy = weights(sh, th);
        const mid = new Float32Array(tw * sh * 4);
        for (let y = 0; y < sh; y++) for (let x = 0; x < tw; x++) { const t = wx[x]; let r = 0, g = 0, b = 0, a = 0; for (let k = 0; k < t.idx.length; k++) { const s = (y * sw + t.idx[k]) * 4, w = t.w[k]; r += d[s] * w; g += d[s + 1] * w; b += d[s + 2] * w; a += d[s + 3] * w; } const o = (y * tw + x) * 4; mid[o] = r; mid[o + 1] = g; mid[o + 2] = b; mid[o + 3] = a; }
        const out = make(tw, th), od = out.data;
        for (let y = 0; y < th; y++) { const t = wy[y]; for (let x = 0; x < tw; x++) { let r = 0, g = 0, b = 0, a = 0; for (let k = 0; k < t.idx.length; k++) { const s = (t.idx[k] * tw + x) * 4, w = t.w[k]; r += mid[s] * w; g += mid[s + 1] * w; b += mid[s + 2] * w; a += mid[s + 3] * w; } const o = (y * tw + x) * 4; od[o] = r; od[o + 1] = g; od[o + 2] = b; od[o + 3] = a; } }
        return out;
    }
    // scale：percent／factor（倍率）、width／height（像素，只給一個就等比）、都給＝塞進這個框（不變形；stretch:true 才拉伸）、max_side（長邊上限，只縮不放）
    function scale(img, p) {
        const w = img.width, h = img.height; let tw = w, th = h;
        if (p.percent != null) { const f = num(p.percent, 100) / 100; tw = w * f; th = h * f; }
        else if (p.factor != null) { const f = num(p.factor, 1); tw = w * f; th = h * f; }
        else if (p.max_side != null) { const m = num(p.max_side, 0), l = Math.max(w, h); if (m > 0 && l > m) { tw = w * m / l; th = h * m / l; } }
        else if (p.width != null && p.height != null) { const W = num(p.width, w), H = num(p.height, h); if (p.stretch) { tw = W; th = H; } else { const f = Math.min(W / w, H / h); tw = w * f; th = h * f; } }
        else if (p.width != null) { const f = num(p.width, w) / w; tw = w * f; th = h * f; }
        else if (p.height != null) { const f = num(p.height, h) / h; tw = w * f; th = h * f; }
        if (!(tw >= 1 && th >= 1)) throw new Error('縮放的大小不合理（要大於 0）');
        return resize(img, tw, th);
    }

    // ───────────────────────── 操作清單的驗證與執行 ─────────────────────────
    const PIXEL_FN = { grayscale, brightness, contrast, saturation, gamma, auto_contrast: autoContrast, enhance, tone, reduce_colors: reduceColors, posterize, threshold, invert, blur, sharpen, mosaic };
    const GEO_FN = { rotate, scale, crop, flip };
    const RANGE = { brightness: ['amount', -100, 100], contrast: ['amount', -100, 100], saturation: ['amount', -100, 100], gamma: ['value', 0.1, 10], reduce_colors: ['colors', 2, 256], posterize: ['levels', 2, 64], blur: ['radius', 0, 200], sharpen: ['amount', 0, 5] };
    // 縮寫：{op:'blur', radius:3}、"grayscale"、{grayscale:true}、{blur:3}、{rotate:90}、{scale:50}（單一數值的縮寫）
    const SHORT_ARG = { brightness: 'amount', contrast: 'amount', saturation: 'amount', gamma: 'value', reduce_colors: 'colors', posterize: 'levels', blur: 'radius', sharpen: 'amount', mosaic: 'block', rotate: 'degrees', scale: 'percent', threshold: 'level', enhance: 'strength', flip: 'direction', tone: 'contrast' };
    function normalizeOps(list) {
        const ops = [], errors = [];
        const arr = list == null || list === '' ? [] : (Array.isArray(list) ? list : [list]);
        arr.forEach((raw, i) => {
            let o = raw; const at = '第 ' + (i + 1) + ' 個處理';
            if (typeof o === 'string') { const m = /^\s*([^:=\s]+)\s*[:=]?\s*(.*)$/.exec(o); o = { op: m[1] }; if (m[2] !== '' && SHORT_ARG[NAME_OF[m[1].toLowerCase()]]) o[SHORT_ARG[NAME_OF[m[1].toLowerCase()]]] = m[2]; }
            if (!o || typeof o !== 'object') { errors.push(at + '：格式不對（要是 {"op":"名稱",…} 或名稱字串）'); return; }
            let nameRaw = o.op != null ? o.op : (o.name != null ? o.name : (o.type != null ? o.type : null)); let rest = Object.assign({}, o);
            if (nameRaw == null) { const k = Object.keys(o).find((x) => NAME_OF[String(x).toLowerCase()]); if (k) { nameRaw = k; const v = o[k]; delete rest[k]; if (v && typeof v === 'object') Object.assign(rest, v); else if (v !== true && v !== '' && SHORT_ARG[NAME_OF[String(k).toLowerCase()]]) rest[SHORT_ARG[NAME_OF[String(k).toLowerCase()]]] = v; } }
            delete rest.op; delete rest.name; delete rest.type;
            const name = nameRaw != null ? NAME_OF[String(nameRaw).trim().toLowerCase()] : null;
            if (!name) { errors.push(at + '：不認得的處理「' + nameRaw + '」。可用：' + Object.keys(ALIASES).join('、')); return; }
            const p = Object.assign({}, rest); const rg = RANGE[name];
            if (rg) { const key = rg[0]; let v = p[key]; if (v == null && name === 'blur') v = p.sigma; if (v != null) { const nv = Number(v); if (!Number.isFinite(nv)) { errors.push(at + '（' + name + '）：' + key + ' 要是數字'); return; } if (nv < rg[1] || nv > rg[2]) { errors.push(at + '（' + name + '）：' + key + ' 要在 ' + rg[1] + '～' + rg[2] + ' 之間（給了 ' + nv + '）'); return; } p[key] = nv; } }
            if (name === 'rotate') { const dv = p.degrees != null ? p.degrees : (p.angle != null ? p.angle : p.deg); if (dv == null || !Number.isFinite(Number(dv))) { errors.push(at + '（rotate）：要給 degrees（順時針角度，例如 90、-90、180、15）'); return; } p.degrees = Number(dv); }
            if (name === 'scale' && ['percent', 'factor', 'width', 'height', 'max_side'].every((k) => p[k] == null)) { errors.push(at + '（scale）：要給 percent（百分比）、factor（倍率）、width／height（像素）或 max_side（長邊上限）其中之一'); return; }
            if (name === 'scale') for (const k of ['percent', 'factor', 'width', 'height', 'max_side']) if (p[k] != null) { const nv = Number(p[k]); if (!(nv > 0)) { errors.push(at + '（scale）：' + k + ' 要大於 0'); return; } p[k] = nv; }
            if (name === 'crop' && ['x', 'y', 'w', 'h', 'width', 'height'].every((k) => p[k] == null)) { errors.push(at + '（crop）：要給 x、y、w、h（預設單位百分比 0～100；unit:"px" 用像素）'); return; }
            ops.push(Object.assign({ op: name }, p));
        });
        return { ok: !errors.length, ops, errors };
    }
    const isGeometric = (name) => GEOMETRIC.has(name);
    // 依序執行；回傳 { img, applied:[{op, ms}] }。hooks.onStep(op, i, n) 可選（回報進度）。不改傳入的物件（先複製一份）。
    function run(img, ops, hooks) {
        let cur = { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }; const applied = [];
        ops.forEach((o, i) => {
            if (hooks && hooks.onStep) hooks.onStep(o.op, i, ops.length);
            const t0 = Date.now(); const fn = PIXEL_FN[o.op] || GEO_FN[o.op]; if (!fn) throw new Error('不認得的處理：' + o.op);
            cur = fn(cur, o) || cur; applied.push({ op: o.op, ms: Date.now() - t0, size: cur.width + '×' + cur.height });
        });
        return { img: cur, applied };
    }
    function hasTransparency(img) { const d = img.data; for (let i = 3; i < d.length; i += 4) if (d[i] < 250) return true; return false; }
    // 把透明的部分鋪上底色（PDF 的 JPEG 沒有透明）
    function flatten(img, color) { const bg = parseColor(color, [255, 255, 255, 255]), d = img.data; for (let i = 0; i < d.length; i += 4) { const a = d[i + 3] / 255; if (a < 1) { d[i] = d[i] * a + bg[0] * (1 - a); d[i + 1] = d[i + 1] * a + bg[1] * (1 - a); d[i + 2] = d[i + 2] * a + bg[2] * (1 - a); d[i + 3] = 255; } } return img; }
    // 檔名的自然排序（img2 排在 img10 前面）
    function naturalCompare(a, b) { return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' }); }


    // ───────────────────────── PDF 頁面排版（純計算） ─────────────────────────
    const MM = 72 / 25.4;
    const PAGE_MM = { a3: [297, 420], a4: [210, 297], a5: [148, 210], a6: [105, 148], b4: [250, 353], b5: [176, 250], letter: [215.9, 279.4], legal: [215.9, 355.6], tabloid: [279.4, 431.8] };
    function pageBase(opts) {
        const ps = opts.page_size == null ? 'fit' : String(opts.page_size).trim().toLowerCase();
        if (ps === 'fit' || ps === '') return null;
        if (PAGE_MM[ps]) return PAGE_MM[ps].map((v) => v * MM);
        let m = /^(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*(mm|cm|in|pt)?$/.exec(ps);
        if (m) { const u = m[3] || 'mm', k = u === 'cm' ? 10 * MM : (u === 'in' ? 72 : (u === 'pt' ? 1 : MM)); return [Number(m[1]) * k, Number(m[2]) * k]; }
        if (opts.width_mm > 0 && opts.height_mm > 0) return [opts.width_mm * MM, opts.height_mm * MM];
        throw new Error('不認得的頁面大小「' + opts.page_size + '」。可用：fit、' + Object.keys(PAGE_MM).join('、') + '，或「210x297mm」這種寫法');
    }
    // 一頁怎麼排：回傳 { pw, ph, dx, dy, dw, dh }（單位 pt，原點在左下）。
    // page_size: fit（頁面＝圖片大小）或 a3／a4／a5／letter…／"210x297mm"；orientation: auto（寬圖用橫的）／portrait／landscape；
    // fit: contain（整張放進頁面，等比、置中——「Zoom／縮放置中」）、cover（填滿頁面、超出的裁掉）、stretch（拉伸變形）、actual（原始大小，太大才縮）；
    // zoom：在上述結果上再縮放的百分比（80＝留邊）；margin：pt；dpi：像素換 pt 用（預設 96）
    function layoutPage(imgW, imgH, o) {
        o = o || {}; const dpi = clampN(num(o.dpi, 96), 36, 1200), kpx = 72 / dpi; let base;
        base = pageBase(o); const zoom = clampN(num(o.zoom, 100), 5, 400) / 100;
        if (!base) { let k = 1; const lim = 14400; const w0 = imgW * kpx, h0 = imgH * kpx; if (Math.max(w0, h0) > lim) k = lim / Math.max(w0, h0); const pw = w0 * k, ph = h0 * k; return { pw, ph, dx: (pw - pw * zoom) / 2, dy: (ph - ph * zoom) / 2, dw: pw * zoom, dh: ph * zoom }; }
        const ori = String(o.orientation || 'auto').toLowerCase(); const lscape = ori === 'landscape' || (ori === 'auto' && imgW > imgH);
        const pw = lscape ? Math.max(base[0], base[1]) : Math.min(base[0], base[1]), ph = lscape ? Math.min(base[0], base[1]) : Math.max(base[0], base[1]);
        const m = clampN(num(o.margin, 0), 0, Math.min(pw, ph) / 3), aw = pw - 2 * m, ah = ph - 2 * m; const fit = String(o.fit || 'contain').toLowerCase();
        let dw, dh;
        if (fit === 'stretch') { dw = aw; dh = ah; }
        else if (fit === 'cover') { const s = Math.max(aw / imgW, ah / imgH); dw = imgW * s; dh = imgH * s; }
        else if (fit === 'actual') { const s = Math.min(kpx, aw / imgW, ah / imgH); dw = imgW * s; dh = imgH * s; }
        else { const s = Math.min(aw / imgW, ah / imgH); dw = imgW * s; dh = imgH * s; }
        dw *= zoom; dh *= zoom;
        // cover：超出頁面（可繪區域）的部分直接從圖片裁掉（crop 是來源像素的矩形），PDF 裡只放看得到的那一塊——檔案小、各種閱讀器／印表機行為一致，不靠剪裁路徑
        if (fit === 'cover' && (dw > aw + 0.01 || dh > ah + 0.01)) {
            const sx = dw / imgW, sy = dh / imgH, vw = Math.min(imgW, aw / sx), vh = Math.min(imgH, ah / sy);
            const cw = Math.max(1, Math.round(vw)), ch = Math.max(1, Math.round(vh)); const cx = Math.max(0, Math.min(imgW - cw, Math.round((imgW - cw) / 2))), cy = Math.max(0, Math.min(imgH - ch, Math.round((imgH - ch) / 2)));
            const ow = Math.min(dw, aw), oh = Math.min(dh, ah);
            return { pw, ph, dx: (pw - ow) / 2, dy: (ph - oh) / 2, dw: ow, dh: oh, crop: { x: cx, y: cy, w: cw, h: ch } };
        }
        return { pw, ph, dx: (pw - dw) / 2, dy: (ph - dh) / 2, dw, dh, crop: null };
    }
    // 一頁要做的處理：位置縮寫（rotate／scale）先做，接著是全部頁面共用的 ops，最後是這一頁自己的 ops
    function buildItemOps(globalOps, item) {
        const list = [];
        if (item && item.rotate != null && item.rotate !== '' && Number(item.rotate) !== 0) list.push({ op: 'rotate', degrees: item.rotate });
        if (item && item.scale != null && item.scale !== '') list.push(typeof item.scale === 'object' ? Object.assign({ op: 'scale' }, item.scale) : { op: 'scale', percent: item.scale });
        return normalizeOps([].concat(list, globalOps || [], (item && item.ops) || []));
    }

    return { PAGE_MM, layoutPage, buildItemOps, ALIASES, GEOMETRIC, normalizeOps, isGeometric, run, hasTransparency, flatten, naturalCompare, parseColor, ops: Object.assign({}, PIXEL_FN, GEO_FN), resize, MAX_PIXELS };
});
