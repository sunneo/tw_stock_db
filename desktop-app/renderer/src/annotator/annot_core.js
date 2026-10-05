// 圖像標註的純演算法（不碰 DOM，node 與瀏覽器都能跑；嵌入成 FaAnnot，見 scripts/embed-code-ui.js）
// - 魔術棒：點一下物件，用 Lab 色差長出區域（外框、面積、平均色、顏色範圍）
// - 文字：切成字元格（水平／垂直，英文看間隙、漢字等寬切）、字形特徵、與範本比對、用常見字詞過濾（英文）、用字形碼過濾（倉頡／無蝦米／四角號碼）
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaAnnot = factory(); })(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // ---------- 色彩 ----------
    function _lin(c) { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
    function _f(t) { return t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116; }
    function rgb2lab(r, g, b) {
        const R = _lin(r), G = _lin(g), B = _lin(b);
        const X = (0.4124564 * R + 0.3575761 * G + 0.1804375 * B) / 0.95047, Y = 0.2126729 * R + 0.7151522 * G + 0.072175 * B, Z = (0.0193339 * R + 0.119192 * G + 0.9503041 * B) / 1.08883;
        const fx = _f(X), fy = _f(Y), fz = _f(Z);
        return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
    }
    // RGBA（ImageData.data）→ Lab 平面（Float32Array 3*w*h）；透明像素當白底
    function buildLab(data, w, h) {
        const out = new Float32Array(w * h * 3), cache = new Map();
        for (let i = 0, n = w * h; i < n; i++) {
            const a = data[i * 4 + 3] / 255; let r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
            if (a < 1) { r = r * a + 255 * (1 - a); g = g * a + 255 * (1 - a); b = b * a + 255 * (1 - a); }
            const key = (r << 16) | (g << 8) | b; let l = cache.get(key);
            if (!l) { l = rgb2lab(r, g, b); if (cache.size < 60000) cache.set(key, l); }
            out[i * 3] = l[0]; out[i * 3 + 1] = l[1]; out[i * 3 + 2] = l[2];
        }
        return out;
    }
    function grayOf(data, w, h) { const g = new Float32Array(w * h); for (let i = 0; i < w * h; i++) { const a = data[i * 4 + 3] / 255; g[i] = (0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2]) * a / 255 + (1 - a); } return g; }

    // ---------- 魔術棒 ----------
    // 從 (sx,sy) 長出色差在 tol（ΔE76）以內、且相鄰像素變化不超過 0.6×tol（不沿著漸層一路爬走）的 4 連通區域。maxFrac：最多佔整張圖的比例（防止溢出到整張背景）。
    function wand(lab, w, h, sx, sy, tol, maxFrac) {
        sx = Math.max(0, Math.min(w - 1, sx | 0)); sy = Math.max(0, Math.min(h - 1, sy | 0));
        tol = tol > 0 ? tol : 12; maxFrac = maxFrac > 0 ? maxFrac : 0.6;
        let L0 = 0, a0 = 0, b0 = 0, n0 = 0;
        for (let y = Math.max(0, sy - 1); y <= Math.min(h - 1, sy + 1); y++) for (let x = Math.max(0, sx - 1); x <= Math.min(w - 1, sx + 1); x++) { const k = (y * w + x) * 3; L0 += lab[k]; a0 += lab[k + 1]; b0 += lab[k + 2]; n0++; }
        L0 /= n0; a0 /= n0; b0 /= n0;
        const mask = new Uint8Array(w * h), stack = new Int32Array(w * h); let sp = 0, area = 0, truncated = false;
        const x0 = [sx, sy, sx, sy]; // minx,miny,maxx,maxy
        const dist = (k, L, a, b) => { const dL = lab[k] - L, da = lab[k + 1] - a, db = lab[k + 2] - b; return Math.sqrt(dL * dL + da * da + db * db); };
        const seed = sy * w + sx; mask[seed] = 1; stack[sp++] = seed;
        const limit = Math.floor(w * h * maxFrac); let sL = 0, sa = 0, sb = 0;
        while (sp) {
            const p = stack[--sp], px = p % w, py = (p / w) | 0, kp = p * 3;
            area++; sL += lab[kp]; sa += lab[kp + 1]; sb += lab[kp + 2];
            if (px < x0[0]) x0[0] = px; if (py < x0[1]) x0[1] = py; if (px > x0[2]) x0[2] = px; if (py > x0[3]) x0[3] = py;
            if (area > limit) { truncated = true; break; }
            const nb = [px > 0 ? p - 1 : -1, px < w - 1 ? p + 1 : -1, py > 0 ? p - w : -1, py < h - 1 ? p + w : -1];
            for (let i = 0; i < 4; i++) {
                const q = nb[i]; if (q < 0 || mask[q]) continue; const kq = q * 3;
                if (dist(kq, L0, a0, b0) <= tol && dist(kq, lab[kp], lab[kp + 1], lab[kp + 2]) <= tol * 0.6) { mask[q] = 1; stack[sp++] = q; }
            }
        }
        return { mask, bbox: [x0[0], x0[1], x0[2] + 1, x0[3] + 1], area, mean: [sL / area, sa / area, sb / area], seed_lab: [L0, a0, b0], truncated };
    }
    // 區域的顏色範圍（百分位數，略放寬）：給 color_family 條目用
    function colorRangeOf(lab, mask, p) {
        p = p == null ? 5 : p; const Ls = [], As = [], Bs = [];
        for (let i = 0; i < mask.length; i++) if (mask[i]) { Ls.push(lab[i * 3]); As.push(lab[i * 3 + 1]); Bs.push(lab[i * 3 + 2]); }
        if (!Ls.length) return null;
        const q = (arr, pc, pad) => { arr.sort((a, b) => a - b); const lo = arr[Math.floor(arr.length * pc / 100)], hi = arr[Math.min(arr.length - 1, Math.ceil(arr.length * (100 - pc) / 100) - 1)]; return [Math.round((lo - pad) * 10) / 10, Math.round((hi + pad) * 10) / 10]; };
        return { L: q(Ls, p, 3), a: q(As, p, 3), b: q(Bs, p, 3) };
    }
    function maskOutline(mask, w, h, bbox) { // 外框點（給預覽畫輪廓用）：區域內且有鄰居在區域外
        const pts = []; for (let y = bbox[1]; y < bbox[3]; y++) for (let x = bbox[0]; x < bbox[2]; x++) { const i = y * w + x; if (!mask[i]) continue; if (x === 0 || y === 0 || x === w - 1 || y === h - 1 || !mask[i - 1] || !mask[i + 1] || !mask[i - w] || !mask[i + w]) pts.push(i); } return pts;
    }
    // 外框相對於容器外框（容器的 0..1，可以超出）
    function relBox(box, cont) { const cw = cont[2] - cont[0], ch = cont[3] - cont[1]; return [(box[0] - cont[0]) / cw, (box[1] - cont[1]) / ch, (box[2] - cont[0]) / cw, (box[3] - cont[1]) / ch].map((v) => Math.round(v * 1000) / 1000); }

    // ---------- 文字：二值化、切格、字形特徵 ----------
    function otsu(vals) { // vals：0..1 灰階
        const hist = new Float64Array(256); for (let i = 0; i < vals.length; i++) hist[Math.max(0, Math.min(255, Math.round(vals[i] * 255)))]++;
        let total = vals.length, sum = 0; for (let i = 0; i < 256; i++) sum += i * hist[i];
        let wB = 0, sB = 0, best = -1, thr = 128;
        for (let t = 0; t < 256; t++) { wB += hist[t]; if (!wB) continue; const wF = total - wB; if (!wF) break; sB += t * hist[t]; const mB = sB / wB, mF = (sum - sB) / wF, v = wB * wF * (mB - mF) * (mB - mF); if (v > best) { best = v; thr = t; } }
        return (thr + 0.5) / 255; // 加半格：色階值剛好等於門檻的像素（float32 捨入）不會被誤判到另一邊
    }
    // 框內的「墨」遮罩：少數的那一類是墨（深字淺底或淺字深底都行）
    function inkMask(gray, w, box, inkIsDark) {
        const bw = box[2] - box[0], bh = box[3] - box[1], vals = new Float32Array(bw * bh);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) vals[y * bw + x] = gray[(box[1] + y) * w + box[0] + x];
        const thr = otsu(vals); let dark = 0; for (let i = 0; i < vals.length; i++) if (vals[i] <= thr) dark++;
        if (inkIsDark == null) inkIsDark = dark <= vals.length - dark;
        const m = new Uint8Array(bw * bh);
        for (let i = 0; i < vals.length; i++) m[i] = (vals[i] <= thr) === inkIsDark ? 1 : 0;
        return { mask: m, w: bw, h: bh, inkIsDark };
    }
    function _runs(profile, minGap) { // 連續非零的區段，間隙小於 minGap 的併起來
        const out = []; let s = -1, gap = 0;
        for (let i = 0; i <= profile.length; i++) {
            const on = i < profile.length && profile[i] > 0;
            if (on) { if (s < 0) s = i; gap = 0; } else if (s >= 0) { gap++; if (i === profile.length || gap > minGap) { out.push([s, i - gap + 1 > s ? i - gap + 1 : i]); s = -1; gap = 0; } }
        }
        return out.map((r) => [r[0], Math.min(r[1], profile.length)]);
    }
    // 把一行文字的框切成字元格。opts: {dir:'h'|'v', script:'latin'|'cjk'}
    // 回傳 [{box:[x0,y0,x1,y1], gapBefore:boolean}]（影像座標）。
    function splitCells(gray, w, box, opts) {
        opts = opts || {}; const vertical = opts.dir === 'v', cjk = opts.script === 'cjk';
        const ink = inkMask(gray, w, box, opts.inkIsDark), bw = ink.w, bh = ink.h;
        const along = vertical ? bh : bw, across = vertical ? bw : bh;
        const prof = new Float32Array(along);
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (ink.mask[y * bw + x]) prof[vertical ? y : x]++;
        // 一個字的高度（水平文字）或寬度（垂直文字）：用墨實際佔的範圍，不用框的大小（框通常比字大）
        let amin = across, amax = -1;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (ink.mask[y * bw + x]) { const ac = vertical ? x : y; if (ac < amin) amin = ac; if (ac > amax) amax = ac; }
        if (amax < 0) return [];
        const size = Math.max(4, amax - amin + 1);
        let runs = _runs(prof, Math.max(1, Math.round(size * (cjk ? 0.35 : 0.08))));
        if (!runs.length) return [];
        const cells = [];
        const widths = runs.map((r) => r[1] - r[0]); const narrow = widths.filter((x) => x < size * 1.1).sort((a, b) => a - b);
        const w0 = cjk ? size : Math.max(2, narrow.length ? narrow[Math.floor(narrow.length / 2)] : size * 0.55);
        runs.forEach((r, ri) => {
            const len = r[1] - r[0]; const n = Math.max(1, Math.round(len / (cjk ? size : Math.max(w0, size * 0.45)) * (cjk ? 1 : 0.95)));
            const gapBefore = ri > 0 && (r[0] - runs[ri - 1][1]) > size * (cjk ? 0.6 : 0.32);
            if (n <= 1 || len < size * 1.15) { cells.push({ a: r[0], b: r[1], gapBefore }); return; }
            let prev = r[0]; // 太寬的區段：在預期切點附近找投影的谷底
            for (let k = 1; k < n; k++) {
                const exp = r[0] + len * k / n, rad = Math.max(2, Math.round(len / n * 0.3)); let best = Math.round(exp), bv = Infinity;
                for (let x = Math.max(prev + 1, Math.round(exp) - rad); x <= Math.min(r[1] - 1, Math.round(exp) + rad); x++) if (prof[x] < bv) { bv = prof[x]; best = x; }
                let peak = 0; for (let x = r[0]; x < r[1]; x++) if (prof[x] > peak) peak = prof[x];
                if (bv > 0.22 * peak) continue; // 沒有真正的谷底：這是一個寬的字母（W、M…），不是兩個黏在一起的字
                cells.push({ a: prev, b: best, gapBefore: prev === r[0] ? gapBefore : false }); prev = best;
            }
            cells.push({ a: prev, b: r[1], gapBefore: prev === r[0] ? gapBefore : false });
        });
        return cells.map((c) => {
            // 在這格內再收緊垂直於書寫方向的墨範圍
            let lo = across, hi = -1;
            for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) { const al = vertical ? y : x; if (al < c.a || al >= c.b || !ink.mask[y * bw + x]) continue; const ac = vertical ? x : y; if (ac < lo) lo = ac; if (ac > hi) hi = ac; }
            if (hi < 0) { lo = 0; hi = across - 1; }
            const bx = vertical ? [box[0] + lo, box[1] + c.a, box[0] + hi + 1, box[1] + c.b] : [box[0] + c.a, box[1] + lo, box[0] + c.b, box[1] + hi + 1];
            return { box: bx, gapBefore: c.gapBefore, inkIsDark: ink.inkIsDark };
        });
    }
    // 字形特徵：框內二值化 → 裁到墨的外框 → 等比例縮進 N×N（保留長寬比，所以 l 跟 i、一跟二分得開）→ 輕微模糊 → 單位長度
    const GLYPH_N = 24;
    function glyphFeature(gray, w, box, N, inkIsDark) {
        N = N || GLYPH_N; const ink = inkMask(gray, w, box, inkIsDark), bw = ink.w, bh = ink.h;
        let x0 = bw, y0 = bh, x1 = -1, y1 = -1;
        for (let y = 0; y < bh; y++) for (let x = 0; x < bw; x++) if (ink.mask[y * bw + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) return null;
        const gw = x1 - x0 + 1, gh = y1 - y0 + 1, inner = N - 4, sc = inner / Math.max(gw, gh), tw = Math.max(1, Math.round(gw * sc)), th = Math.max(1, Math.round(gh * sc));
        const ox = Math.floor((N - tw) / 2), oy = Math.floor((N - th) / 2), f = new Float32Array(N * N);
        for (let ty = 0; ty < th; ty++) for (let tx = 0; tx < tw; tx++) {
            const sx0 = x0 + tx / sc, sx1 = x0 + (tx + 1) / sc, sy0 = y0 + ty / sc, sy1 = y0 + (ty + 1) / sc; let s = 0, n = 0;
            for (let y = Math.floor(sy0); y < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); y++) for (let x = Math.floor(sx0); x < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); x++) { if (x < 0 || y < 0 || x >= bw || y >= bh) continue; s += ink.mask[y * bw + x]; n++; }
            f[(oy + ty) * N + ox + tx] = n ? s / n : 0;
        }
        const g = new Float32Array(N * N);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { let s = 0, n = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue; const wgt = (dx === 0 && dy === 0) ? 4 : (dx === 0 || dy === 0 ? 2 : 1); s += f[yy * N + xx] * wgt; n += wgt; } g[y * N + x] = s / n; }
        let nm = 0; for (let i = 0; i < g.length; i++) nm += g[i] * g[i]; nm = Math.sqrt(nm) || 1; for (let i = 0; i < g.length; i++) g[i] /= nm;
        return { f: g, aspect: gw / gh, ink_box: [box[0] + x0, box[1] + y0, box[0] + x1 + 1, box[1] + y1 + 1] };
    }
    function similarity(a, b) { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; }
    // 一格對一組範本（[{ch, f, aspect}]）：回傳分數由高到低的候選。長寬比差太多的扣分（i 與 m 不該相像）
    function rankGlyph(feat, templates, k) {
        if (!feat) return [];
        const best = new Map();
        for (const t of templates) {
            const ar = Math.min(feat.aspect, t.aspect) / Math.max(feat.aspect, t.aspect), s = similarity(feat.f, t.f) * (0.6 + 0.4 * Math.sqrt(ar));
            if (!best.has(t.ch) || best.get(t.ch) < s) best.set(t.ch, s);
        }
        return Array.from(best, ([ch, score]) => ({ ch, score })).sort((a, b) => b.score - a.score).slice(0, k || 8);
    }

    // ---------- 英文：用常見字詞過濾 ----------
    // cells：[{cands:[{ch,score}], gapBefore}]；lexicon：字串陣列／Set（小寫）。
    // 每個字（用 gapBefore 分組）：直接讀（每格取最高分）與詞庫裡長度相同、逐字分數最高的字，一起列出；詞庫的字分數接近直接讀時優先。
    function guessWords(cells, lexicon, opts) {
        opts = opts || {}; const K = opts.k || 5, byLen = new Map();
        for (const wd of lexicon instanceof Set ? Array.from(lexicon) : lexicon) { const s = String(wd).toLowerCase(); if (!s) continue; if (!byLen.has(s.length)) byLen.set(s.length, []); byLen.get(s.length).push(s); }
        const groups = []; let cur = null;
        cells.forEach((c, i) => { if (!cur || c.gapBefore) { cur = []; groups.push(cur); } cur.push(c); });
        const scoreOf = (cands, letter) => { let b = 0; for (const x of cands) if (String(x.ch).toLowerCase() === letter && x.score > b) b = x.score; return b; };
        return groups.map((g) => {
            const direct = g.map((c) => (c.cands[0] ? c.cands[0].ch : '?')).join(''); const dScore = g.reduce((s, c) => s + (c.cands[0] ? c.cands[0].score : 0), 0) / g.length;
            const list = [];
            for (const wd of byLen.get(g.length) || []) { let s = 0; for (let i = 0; i < wd.length; i++) s += scoreOf(g[i].cands, wd[i]); s /= wd.length; list.push({ word: wd, score: s }); }
            list.sort((a, b) => b.score - a.score);
            const top = list.slice(0, K), pick = top[0] && top[0].score >= dScore * (opts.lexicon_bias || 0.88) ? top[0].word : direct;
            return { length: g.length, direct, direct_score: dScore, candidates: top, best: pick, from_lexicon: pick !== direct };
        });
    }

    // ---------- 漢字：用字形碼過濾（倉頡、無蝦米、四角號碼） ----------
    // table：[{ch, cangjie?, wuxiami?, four_corner?}]；q：{cangjie:'日?月', wuxiami:'..', four_corner:'4*21*'}；? 一個字元，* 任意長度；prefix:true 時只比前面幾碼。
    function _pat(p, prefix) { const re = '^' + String(p).toLowerCase().replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\?/g, '.').replace(/\*/g, '.*') + (prefix ? '' : '$'); return new RegExp(re); }
    function filterGlyphs(table, q, opts) {
        opts = opts || {}; const checks = [];
        ['cangjie', 'wuxiami', 'four_corner'].forEach((k) => { if (q && q[k]) checks.push([k, _pat(q[k], opts.prefix)]); });
        if (!checks.length) return table.slice(0, opts.limit || 200);
        return table.filter((r) => checks.every(([k, re]) => r[k] != null && re.test(String(r[k]).toLowerCase()))).slice(0, opts.limit || 200);
    }
    // 把「字<TAB>碼」的純文字表（倉頡、無蝦米…）或 Unihan 的 kCangjie／kFourCornerCode 檔讀成 [{ch, <scheme>}]
    function parseCodeTable(text, scheme) {
        const out = new Map();
        for (const line of String(text).split(/\r?\n/)) {
            if (!line || line[0] === '#') continue; const p = line.split(/\t| {2,}/);
            let ch, code;
            const u = /^U\+([0-9A-F]{4,6})$/i.exec(p[0] || '');
            if (u && p.length >= 3) { const key = p[1]; if (scheme === 'cangjie' && key !== 'kCangjie') continue; if (scheme === 'four_corner' && key !== 'kFourCornerCode') continue; ch = String.fromCodePoint(parseInt(u[1], 16)); code = p[2].split(' ')[0]; }
            else if (p.length >= 2 && p[0] && Array.from(p[0]).length === 1) { ch = p[0]; code = p[1].trim().split(/\s+/)[0]; }
            else continue;
            if (!out.has(ch)) out.set(ch, { ch }); const r = out.get(ch); if (r[scheme] == null) r[scheme] = code;
        }
        return Array.from(out.values());
    }

    return { rgb2lab, buildLab, grayOf, wand, colorRangeOf, maskOutline, relBox, otsu, inkMask, splitCells, glyphFeature, similarity, rankGlyph, guessWords, filterGlyphs, parseCodeTable, GLYPH_N };
});
