// computer-png.js —— computer use 用的 PNG／像素小工具（只用 node 的 zlib，不需要 sharp／canvas）。
// 用途：截圖裁切與縮放、RFB 畫面轉 PNG、前後兩張圖的差異（探索 → 移動 → 拍照確認）、畫格線給視覺模型看。
// 影像格式一律是 { width, height, data }，data 為 RGBA（每像素 4 bytes）的 Uint8Array／Buffer。
"use strict";
const zlib = require("zlib");

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) { CRC_TABLE = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; } }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}

// ---------- 編碼 ----------
function encodePng(img) {
  const { width: w, height: h } = img, src = img.data;
  if (!(w > 0 && h > 0) || src.length < w * h * 4) throw new Error("encodePng：影像尺寸與資料不符");
  // 全不透明就存成 RGB（小 25%）
  let opaque = true;
  for (let i = 3; i < w * h * 4; i += 4) if (src[i] !== 255) { opaque = false; break; }
  const bpp = opaque ? 3 : 4, stride = w * bpp, raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1); raw[o] = 1; // filter 1 = Sub：對截圖（大片同色）壓縮效果很好
    for (let x = 0; x < w; x++) {
      for (let c = 0; c < bpp; c++) {
        const v = src[(y * w + x) * 4 + c], left = x ? src[(y * w + x - 1) * 4 + c] : 0;
        raw[o + 1 + x * bpp + c] = (v - left) & 0xff;
      }
    }
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([SIG, chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 6 })), chunk("IEND", Buffer.alloc(0))]);
}

// ---------- 解碼（8／16 bit，灰階／RGB／調色盤／灰階+alpha／RGBA，不支援交錯） ----------
function decodePng(buf) {
  buf = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  if (buf.length < 33 || !buf.subarray(0, 8).equals(SIG)) throw new Error("不是 PNG");
  let pos = 8, w = 0, h = 0, depth = 8, ctype = 6, interlace = 0, plte = null, trns = null; const idat = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString("latin1", pos + 4, pos + 8), d = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") { w = d.readUInt32BE(0); h = d.readUInt32BE(4); depth = d[8]; ctype = d[9]; interlace = d[12]; }
    else if (type === "PLTE") plte = d; else if (type === "tRNS") trns = d; else if (type === "IDAT") idat.push(d); else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (interlace) throw new Error("不支援交錯（interlaced）PNG");
  if (!w || !h) throw new Error("PNG 沒有 IHDR");
  const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ctype]; if (!chans) throw new Error("不支援的 PNG color type " + ctype);
  const bitsPP = chans * depth, bpp = Math.max(1, bitsPP >> 3), stride = Math.ceil((w * bitsPP) / 8);
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) throw new Error("PNG 資料不完整");
  const cur = Buffer.alloc(stride), prev = Buffer.alloc(stride), out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const o = y * (stride + 1), f = raw[o];
    for (let i = 0; i < stride; i++) {
      const x = raw[o + 1 + i], a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v;
      switch (f) {
        case 0: v = x; break; case 1: v = x + a; break; case 2: v = x + b; break; case 3: v = x + ((a + b) >> 1); break;
        case 4: { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c); break; }
        default: throw new Error("PNG filter 錯誤 " + f);
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4; let r, g, bl, al = 255;
      const sample = (ch) => { // 取第 ch 個 channel 的 8-bit 值
        if (depth === 8) return cur[x * chans + ch];
        if (depth === 16) return cur[(x * chans + ch) * 2];
        const bitPos = (x * chans + ch) * depth, byte = cur[bitPos >> 3], sh = 8 - depth - (bitPos & 7), v = (byte >> sh) & ((1 << depth) - 1);
        return ctype === 3 ? v : Math.round((v * 255) / ((1 << depth) - 1));
      };
      if (ctype === 0) { r = g = bl = sample(0); }
      else if (ctype === 2) { r = sample(0); g = sample(1); bl = sample(2); }
      else if (ctype === 3) { const idx = sample(0); r = plte ? plte[idx * 3] : 0; g = plte ? plte[idx * 3 + 1] : 0; bl = plte ? plte[idx * 3 + 2] : 0; if (trns && idx < trns.length) al = trns[idx]; }
      else if (ctype === 4) { r = g = bl = sample(0); al = sample(1); }
      else { r = sample(0); g = sample(1); bl = sample(2); al = sample(3); }
      out[q] = r; out[q + 1] = g; out[q + 2] = bl; out[q + 3] = al;
    }
    cur.copy(prev);
  }
  return { width: w, height: h, data: out };
}

// ---------- 裁切、縮放 ----------
function clampRect(img, r) {
  const x0 = Math.max(0, Math.floor(r.x)), y0 = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(img.width, Math.ceil(r.x + (r.w != null ? r.w : r.width))), y1 = Math.min(img.height, Math.ceil(r.y + (r.h != null ? r.h : r.height)));
  return { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) };
}
function crop(img, rect) {
  const r = clampRect(img, rect); if (!r.w || !r.h) throw new Error("裁切範圍在影像之外");
  const out = new Uint8Array(r.w * r.h * 4);
  for (let y = 0; y < r.h; y++) out.set(img.data.subarray(((r.y + y) * img.width + r.x) * 4, ((r.y + y) * img.width + r.x + r.w) * 4), y * r.w * 4);
  return { width: r.w, height: r.h, data: out };
}
// 縮小用面積平均（文字邊緣比最近點取樣乾淨，給視覺模型看比較好認）；放大用最近點（保持像素銳利）
function resize(img, nw, nh) {
  nw = Math.max(1, Math.round(nw)); nh = Math.max(1, Math.round(nh));
  if (nw === img.width && nh === img.height) return img;
  const out = new Uint8Array(nw * nh * 4), sx = img.width / nw, sy = img.height / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.floor(y * sy), y1 = Math.max(y0 + 1, Math.min(img.height, Math.ceil((y + 1) * sy)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.floor(x * sx), x1 = Math.max(x0 + 1, Math.min(img.width, Math.ceil((x + 1) * sx)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) { const q = (yy * img.width + xx) * 4; r += img.data[q]; g += img.data[q + 1]; b += img.data[q + 2]; a += img.data[q + 3]; n++; }
      const o = (y * nw + x) * 4; out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: nw, height: nh, data: out };
}
// 長邊縮到 maxSide 以內，回傳縮放比（影像像素／原始像素）——VLM 框要換算回螢幕座標時用
function fitWithin(img, maxSide) {
  const m = Math.max(img.width, img.height); if (!maxSide || m <= maxSide) return { img, scale: 1 };
  const s = maxSide / m; return { img: resize(img, img.width * s, img.height * s), scale: s };
}

// ---------- 差異 ----------
// 兩張同尺寸的圖：逐像素比（RGB 最大差超過 threshold 算變了），回傳變化比例、變化的外框、格子分布。
function diff(a, b, o) {
  o = o || {};
  if (a.width !== b.width || a.height !== b.height) return { comparable: false, reason: "尺寸不同", changedPixels: 0, ratio: 0, bbox: null, cells: [] };
  const thr = o.threshold == null ? 24 : o.threshold, cols = o.cols || 8, rows = o.rows || 8, w = a.width, h = a.height;
  let changed = 0, minX = w, minY = h, maxX = -1, maxY = -1; const cellCount = new Array(cols * rows).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const q = (y * w + x) * 4;
      const d = Math.max(Math.abs(a.data[q] - b.data[q]), Math.abs(a.data[q + 1] - b.data[q + 1]), Math.abs(a.data[q + 2] - b.data[q + 2]));
      if (d > thr) { changed++; if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; cellCount[Math.min(rows - 1, Math.floor((y * rows) / h)) * cols + Math.min(cols - 1, Math.floor((x * cols) / w))]++; }
    }
  }
  const cells = []; for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) { const n = cellCount[r * cols + c]; if (n) cells.push({ col: c, row: r, ratio: n / ((w / cols) * (h / rows)) }); }
  return { comparable: true, changedPixels: changed, ratio: changed / (w * h), bbox: maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 }, cells };
}
// 把「變了的格子」連成幾塊矩形（損壞區域 → 候選物件區）
function changedRegions(a, b, o) {
  o = o || {}; const cell = o.cell || 16, thr = o.threshold == null ? 24 : o.threshold, minPixels = o.minPixels || 4;
  const cols = Math.ceil(a.width / cell), rows = Math.ceil(a.height / cell), hit = new Uint8Array(cols * rows);
  for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) { const q = (y * a.width + x) * 4; if (Math.max(Math.abs(a.data[q] - b.data[q]), Math.abs(a.data[q + 1] - b.data[q + 1]), Math.abs(a.data[q + 2] - b.data[q + 2])) > thr) hit[Math.floor(y / cell) * cols + Math.floor(x / cell)]++; }
  const seen = new Uint8Array(cols * rows), regions = [];
  for (let i = 0; i < hit.length; i++) {
    if (!hit[i] || seen[i]) continue; const stack = [i]; seen[i] = 1; let c0 = cols, c1 = -1, r0 = rows, r1 = -1, px = 0;
    while (stack.length) {
      const j = stack.pop(), c = j % cols, r = (j - c) / cols; px += hit[j]; if (c < c0) c0 = c; if (c > c1) c1 = c; if (r < r0) r0 = r; if (r > r1) r1 = r;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) { const cc = c + dc, rr = r + dr; if (cc < 0 || rr < 0 || cc >= cols || rr >= rows) continue; const k = rr * cols + cc; if (hit[k] && !seen[k]) { seen[k] = 1; stack.push(k); } }
    }
    if (px >= minPixels) regions.push({ x: c0 * cell, y: r0 * cell, w: Math.min(a.width, (c1 + 1) * cell) - c0 * cell, h: Math.min(a.height, (r1 + 1) * cell) - r0 * cell, pixels: px });
  }
  return regions.sort((p, q) => q.pixels - p.pixels);
}
// 簡單的內容指紋（把圖縮成 8x8 灰階的平均雜湊）——比較「這兩塊是不是同一個畫面」用
function fingerprint(img) {
  const s = resize(img, 8, 8), g = []; let sum = 0;
  for (let i = 0; i < 64; i++) { const v = (s.data[i * 4] * 299 + s.data[i * 4 + 1] * 587 + s.data[i * 4 + 2] * 114) / 1000; g.push(v); sum += v; }
  const mean = sum / 64; return g.map((v) => (v >= mean ? "1" : "0")).join("");
}
const hamming = (a, b) => { let n = 0; for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) n++; return n; };

// ---------- 畫格線（給視覺模型看的格子標記；3x5 點陣數字） ----------
const DIGITS = { 0: "111101101101111", 1: "010110010010111", 2: "111001111100111", 3: "111001111001111", 4: "101101111001001", 5: "111100111001111", 6: "111100111101111", 7: "111001001001001", 8: "111101111101111", 9: "111101111001111", ",": "000000000010100", "-": "000000111000000" };
function putPx(img, x, y, rgb) { if (x < 0 || y < 0 || x >= img.width || y >= img.height) return; const q = (y * img.width + x) * 4; img.data[q] = rgb[0]; img.data[q + 1] = rgb[1]; img.data[q + 2] = rgb[2]; img.data[q + 3] = 255; }
function drawText(img, x, y, text, rgb, bg, px) {
  px = px || 2; let cx = x;
  for (const ch of String(text)) {
    const g = DIGITS[ch]; if (!g) { cx += 4 * px; continue; }
    for (let i = 0; i < 15; i++) { const gx = i % 3, gy = Math.floor(i / 3); for (let dy = 0; dy < px; dy++) for (let dx = 0; dx < px; dx++) { if (g[i] === "1") putPx(img, cx + gx * px + dx, y + gy * px + dy, rgb); else if (bg) putPx(img, cx + gx * px + dx, y + gy * px + dy, bg); } }
    cx += 4 * px;
  }
  return cx;
}
// 把影像分成 cols×rows 格，畫細線與每格左上角的「列,欄」編號（0 起算）。回傳新影像與格子清單（影像座標）。
function drawGrid(img, cols, rows, o) {
  o = o || {}; const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) }, cells = [], line = o.color || [255, 0, 255];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const x0 = Math.floor((c * img.width) / cols), x1 = Math.floor(((c + 1) * img.width) / cols), y0 = Math.floor((r * img.height) / rows), y1 = Math.floor(((r + 1) * img.height) / rows);
    cells.push({ col: c, row: r, x: x0, y: y0, w: x1 - x0, h: y1 - y0 });
    for (let x = x0; x < x1; x++) { putPx(out, x, y0, line); }
    for (let y = y0; y < y1; y++) { putPx(out, x0, y, line); }
    if (o.labels !== false) drawText(out, x0 + 2, y0 + 2, r + "," + c, [255, 255, 0], [0, 0, 0], o.labelPx || 2);
  }
  return { img: out, cells };
}
// 在影像上描框（驗證用的標示）
function drawRects(img, rects, rgb) {
  const out = { width: img.width, height: img.height, data: new Uint8Array(img.data) }; rgb = rgb || [255, 0, 0];
  for (const r of rects) { for (let x = r.x; x < r.x + r.w; x++) { putPx(out, x, r.y, rgb); putPx(out, x, r.y + r.h - 1, rgb); } for (let y = r.y; y < r.y + r.h; y++) { putPx(out, r.x, y, rgb); putPx(out, r.x + r.w - 1, y, rgb); } }
  return out;
}
const toDataUrl = (png) => "data:image/png;base64," + Buffer.from(png).toString("base64");

module.exports = { encodePng, decodePng, crop, resize, fitWithin, diff, changedRegions, fingerprint, hamming, drawGrid, drawRects, drawText, toDataUrl, crc32, clampRect };
