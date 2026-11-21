// rfb-codec.js —— RFB（VNC）用戶端需要的純演算法：DES（VNC 密碼驗證）、可持續狀態的 inflate（ZRLE 的 zlib 串流跨矩形不重置）、ZRLE 磁磚解碼。
// 為什麼自己寫 DES：Electron 的 BoringSSL／新版 OpenSSL 3 的預設 provider 不一定有 DES-ECB，VNC 驗證只需要加密兩個 8 byte 區塊，自己實作最穩。
// 為什麼自己寫 inflate：ZRLE 的所有矩形共用「同一條」zlib 串流（每個矩形結尾用 Z_SYNC_FLUSH），後面的資料會參照前面的視窗；
// node 的 zlib.inflateSync 每次呼叫都是新狀態，串流版又是非同步的，所以這裡寫一個保留 32KB 視窗的純 JS 版本（見 Inflater）。
"use strict";

// ================= DES =================
const IP = [58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24, 16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39, 31, 23, 15, 7];
const FP = [40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21, 61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9, 49, 17, 57, 25];
const EXP = [32, 1, 2, 3, 4, 5, 4, 5, 6, 7, 8, 9, 8, 9, 10, 11, 12, 13, 12, 13, 14, 15, 16, 17, 16, 17, 18, 19, 20, 21, 20, 21, 22, 23, 24, 25, 24, 25, 26, 27, 28, 29, 28, 29, 30, 31, 32, 1];
const PP = [16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4, 25];
const PC1 = [57, 49, 41, 33, 25, 17, 9, 1, 58, 50, 42, 34, 26, 18, 10, 2, 59, 51, 43, 35, 27, 19, 11, 3, 60, 52, 44, 36, 63, 55, 47, 39, 31, 23, 15, 7, 62, 54, 46, 38, 30, 22, 14, 6, 61, 53, 45, 37, 29, 21, 13, 5, 28, 20, 12, 4];
const PC2 = [14, 17, 11, 24, 1, 5, 3, 28, 15, 6, 21, 10, 23, 19, 12, 4, 26, 8, 16, 7, 27, 20, 13, 2, 41, 52, 31, 37, 47, 55, 30, 40, 51, 45, 33, 48, 44, 49, 39, 56, 34, 53, 46, 42, 50, 36, 29, 32];
const SHIFTS = [1, 1, 2, 2, 2, 2, 2, 2, 1, 2, 2, 2, 2, 2, 2, 1];
const SBOX = [
  [14, 4, 13, 1, 2, 15, 11, 8, 3, 10, 6, 12, 5, 9, 0, 7, 0, 15, 7, 4, 14, 2, 13, 1, 10, 6, 12, 11, 9, 5, 3, 8, 4, 1, 14, 8, 13, 6, 2, 11, 15, 12, 9, 7, 3, 10, 5, 0, 15, 12, 8, 2, 4, 9, 1, 7, 5, 11, 3, 14, 10, 0, 6, 13],
  [15, 1, 8, 14, 6, 11, 3, 4, 9, 7, 2, 13, 12, 0, 5, 10, 3, 13, 4, 7, 15, 2, 8, 14, 12, 0, 1, 10, 6, 9, 11, 5, 0, 14, 7, 11, 10, 4, 13, 1, 5, 8, 12, 6, 9, 3, 2, 15, 13, 8, 10, 1, 3, 15, 4, 2, 11, 6, 7, 12, 0, 5, 14, 9],
  [10, 0, 9, 14, 6, 3, 15, 5, 1, 13, 12, 7, 11, 4, 2, 8, 13, 7, 0, 9, 3, 4, 6, 10, 2, 8, 5, 14, 12, 11, 15, 1, 13, 6, 4, 9, 8, 15, 3, 0, 11, 1, 2, 12, 5, 10, 14, 7, 1, 10, 13, 0, 6, 9, 8, 7, 4, 15, 14, 3, 11, 5, 2, 12],
  [7, 13, 14, 3, 0, 6, 9, 10, 1, 2, 8, 5, 11, 12, 4, 15, 13, 8, 11, 5, 6, 15, 0, 3, 4, 7, 2, 12, 1, 10, 14, 9, 10, 6, 9, 0, 12, 11, 7, 13, 15, 1, 3, 14, 5, 2, 8, 4, 3, 15, 0, 6, 10, 1, 13, 8, 9, 4, 5, 11, 12, 7, 2, 14],
  [2, 12, 4, 1, 7, 10, 11, 6, 8, 5, 3, 15, 13, 0, 14, 9, 14, 11, 2, 12, 4, 7, 13, 1, 5, 0, 15, 10, 3, 9, 8, 6, 4, 2, 1, 11, 10, 13, 7, 8, 15, 9, 12, 5, 6, 3, 0, 14, 11, 8, 12, 7, 1, 14, 2, 13, 6, 15, 0, 9, 10, 4, 5, 3],
  [12, 1, 10, 15, 9, 2, 6, 8, 0, 13, 3, 4, 14, 7, 5, 11, 10, 15, 4, 2, 7, 12, 9, 5, 6, 1, 13, 14, 0, 11, 3, 8, 9, 14, 15, 5, 2, 8, 12, 3, 7, 0, 4, 10, 1, 13, 11, 6, 4, 3, 2, 12, 9, 5, 15, 10, 11, 14, 1, 7, 6, 0, 8, 13],
  [4, 11, 2, 14, 15, 0, 8, 13, 3, 12, 9, 7, 5, 10, 6, 1, 13, 0, 11, 7, 4, 9, 1, 10, 14, 3, 5, 12, 2, 15, 8, 6, 1, 4, 11, 13, 12, 3, 7, 14, 10, 15, 6, 8, 0, 5, 9, 2, 6, 11, 13, 8, 1, 4, 10, 7, 9, 5, 0, 15, 14, 2, 3, 12],
  [13, 2, 8, 4, 6, 15, 11, 1, 10, 9, 3, 14, 5, 0, 12, 7, 1, 15, 13, 8, 10, 3, 7, 4, 12, 5, 6, 11, 0, 14, 9, 2, 7, 11, 4, 1, 9, 12, 14, 2, 0, 6, 10, 13, 15, 3, 5, 8, 2, 1, 14, 7, 4, 10, 8, 13, 15, 12, 9, 0, 3, 5, 6, 11],
];
const bitsOf = (buf, n) => { const o = []; for (let i = 0; i < n; i++) o.push((buf[i >> 3] >> (7 - (i & 7))) & 1); return o; };
const perm = (bits, table) => table.map((i) => bits[i - 1]);
function desSubkeys(key8) {
  const k = perm(bitsOf(key8, 64), PC1); let c = k.slice(0, 28), d = k.slice(28); const out = [];
  for (const s of SHIFTS) { c = c.slice(s).concat(c.slice(0, s)); d = d.slice(s).concat(d.slice(0, s)); out.push(perm(c.concat(d), PC2)); }
  return out;
}
function desBlock(subkeys, block8, decrypt) {
  const ip = perm(bitsOf(block8, 64), IP); let l = ip.slice(0, 32), r = ip.slice(32);
  for (let round = 0; round < 16; round++) {
    const sk = subkeys[decrypt ? 15 - round : round], e = perm(r, EXP).map((b, i) => b ^ sk[i]), f = [];
    for (let s = 0; s < 8; s++) { const o = s * 6, row = (e[o] << 1) | e[o + 5], col = (e[o + 1] << 3) | (e[o + 2] << 2) | (e[o + 3] << 1) | e[o + 4], v = SBOX[s][row * 16 + col]; f.push((v >> 3) & 1, (v >> 2) & 1, (v >> 1) & 1, v & 1); }
    const nr = perm(f, PP).map((b, i) => b ^ l[i]); l = r; r = nr;
  }
  const bits = perm(r.concat(l), FP), out = Buffer.alloc(8); for (let i = 0; i < 64; i++) out[i >> 3] |= bits[i] << (7 - (i & 7)); return out;
}
const desEncryptBlock = (key8, block8) => desBlock(desSubkeys(key8), block8, false);
const desDecryptBlock = (key8, block8) => desBlock(desSubkeys(key8), block8, true);
// VNC 的怪習慣：密碼補零／截成 8 bytes，而且每個 byte 的位元順序要反過來當 DES 金鑰
function vncKey(password) {
  const pw = Buffer.alloc(8); Buffer.from(String(password == null ? "" : password), "latin1").copy(pw, 0, 0, 8);
  for (let i = 0; i < 8; i++) { let b = pw[i], r = 0; for (let j = 0; j < 8; j++) { r = (r << 1) | (b & 1); b >>= 1; } pw[i] = r; }
  return pw;
}
function vncAuthResponse(challenge16, password) {
  const sk = desSubkeys(vncKey(password));
  return Buffer.concat([desBlock(sk, challenge16.subarray(0, 8), false), desBlock(sk, challenge16.subarray(8, 16), false)]);
}

// ================= Inflater（持續狀態的 DEFLATE 解碼） =================
const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CLORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];
function buildHuff(lengths) {
  const count = new Array(16).fill(0), symbol = new Array(lengths.length).fill(0);
  for (const l of lengths) count[l]++;
  count[0] = 0; const offs = [0, 0]; for (let l = 1; l < 15; l++) offs[l + 1] = offs[l] + count[l];
  for (let s = 0; s < lengths.length; s++) if (lengths[s]) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}
let FIXED = null;
function fixedTables() {
  if (FIXED) return FIXED; const l = []; for (let i = 0; i < 144; i++) l.push(8); for (let i = 144; i < 256; i++) l.push(9); for (let i = 256; i < 280; i++) l.push(7); for (let i = 280; i < 288; i++) l.push(8);
  FIXED = { lit: buildHuff(l), dist: buildHuff(new Array(30).fill(5)) }; return FIXED;
}
class Inflater {
  constructor() { this.hist = Buffer.alloc(0); this.headerDone = false; }
  // 餵入一段（完整區塊、byte 對齊結尾）壓縮資料，回傳這一段解出來的 Buffer；視窗狀態保留給下一次
  push(chunk) {
    let pos = 0; chunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!this.headerDone) { if (chunk.length < 2 || (chunk[0] & 0x0f) !== 8) throw new Error("ZRLE：不是 zlib 串流"); if (chunk[1] & 0x20) throw new Error("ZRLE：不支援預設字典"); pos = 2; this.headerDone = true; }
    let bitBuf = 0, bitCnt = 0; const hist = this.hist, hl = hist.length; let out = Buffer.alloc(Math.max(4096, chunk.length * 6)), op = 0;
    const need = (n) => { while (bitCnt < n) { if (pos >= chunk.length) throw new Error("INFLATE_EOF"); bitBuf |= chunk[pos++] << bitCnt; bitCnt += 8; } };
    const bits = (n) => { if (n === 0) return 0; need(n); const v = bitBuf & ((1 << n) - 1); bitBuf >>>= n; bitCnt -= n; return v; };
    const grow = (extra) => { if (op + extra > out.length) { const nb = Buffer.alloc(Math.max(out.length * 2, op + extra)); out.copy(nb, 0, 0, op); out = nb; } };
    const decodeSym = (h) => { let code = 0, first = 0, index = 0; for (let len = 1; len <= 15; len++) { code |= bits(1); const cnt = h.count[len]; if (code - cnt < first) return h.symbol[index + (code - first)]; index += cnt; first += cnt; first <<= 1; code <<= 1; } throw new Error("inflate：無效的 Huffman 碼"); };
    const codes = (lit, dist) => {
      for (;;) {
        const sym = decodeSym(lit);
        if (sym < 256) { grow(1); out[op++] = sym; continue; }
        if (sym === 256) return;
        const li = sym - 257; if (li >= 29) throw new Error("inflate：無效的長度碼");
        const len = LBASE[li] + bits(LEXT[li]), ds = decodeSym(dist); if (ds >= 30) throw new Error("inflate：無效的距離碼");
        const d = DBASE[ds] + bits(DEXT[ds]); if (d > hl + op) throw new Error("inflate：距離超出視窗");
        grow(len);
        for (let i = 0; i < len; i++) { const src = op - d; out[op] = src >= 0 ? out[src] : hist[hl + src]; op++; }
      }
    };
    try {
      for (;;) {
        // 區塊邊界：資料用完且沒有殘留位元就結束（Z_SYNC_FLUSH 之後正好 byte 對齊）
        if (pos >= chunk.length && bitCnt < 8 && (bitBuf & ((1 << bitCnt) - 1)) === 0) break;
        let final, type; try { final = bits(1); type = bits(2); } catch (e) { if (e.message === "INFLATE_EOF") break; throw e; }
        if (type === 0) {
          bitBuf = 0; bitCnt = 0; if (pos + 4 > chunk.length) throw new Error("inflate：stored 區塊標頭被截斷");
          const len = chunk.readUInt16LE(pos), nlen = chunk.readUInt16LE(pos + 2); pos += 4; if ((len ^ 0xffff) !== nlen) throw new Error("inflate：stored 區塊長度檢查失敗");
          if (pos + len > chunk.length) throw new Error("inflate：stored 區塊被截斷"); grow(len); chunk.copy(out, op, pos, pos + len); op += len; pos += len;
        } else if (type === 1) { const t = fixedTables(); codes(t.lit, t.dist); }
        else if (type === 2) {
          const nlen = bits(5) + 257, ndist = bits(5) + 1, ncode = bits(4) + 4, lengths = new Array(19).fill(0);
          for (let i = 0; i < ncode; i++) lengths[CLORDER[i]] = bits(3);
          const lc = buildHuff(lengths), ll = []; let idx = 0;
          while (idx < nlen + ndist) {
            const sym = decodeSym(lc);
            if (sym < 16) { ll[idx++] = sym; }
            else { let prev = 0, rep; if (sym === 16) { if (idx === 0) throw new Error("inflate：沒有前一個長度可重複"); prev = ll[idx - 1]; rep = 3 + bits(2); } else if (sym === 17) rep = 3 + bits(3); else rep = 11 + bits(7); for (let k = 0; k < rep; k++) ll[idx++] = prev; }
          }
          codes(buildHuff(ll.slice(0, nlen)), buildHuff(ll.slice(nlen, nlen + ndist)));
        } else throw new Error("inflate：無效的區塊型別");
        if (final) break;
      }
    } catch (e) { if (e.message === "INFLATE_EOF") throw new Error("inflate：資料被截斷"); throw e; }
    const res = out.subarray(0, op), all = Buffer.concat([hist, res]); this.hist = all.length > 32768 ? all.subarray(all.length - 32768) : all;
    return res;
  }
}

// ================= ZRLE 磁磚解碼 =================
// data：解壓縮後的 ZRLE 內容；寫入 RGBA 的 fb（寬 fbW）。cp＝CPIXEL 的位元組數（我們協商的格式是 3：R、G、B，最低有效的三個 byte）。
function decodeZrle(data, x0, y0, w, h, fb, fbW, cp) {
  cp = cp || 3; let p = 0;
  const pix = (o) => { if (o + 3 > data.length) throw new Error("ZRLE：資料不足"); return [data[o], data[o + 1], data[o + 2]]; };
  const nb = () => { if (p >= data.length) throw new Error("ZRLE：資料不足"); return data[p++]; };
  const put = (x, y, c) => { const q = (y * fbW + x) * 4; fb[q] = c[0]; fb[q + 1] = c[1]; fb[q + 2] = c[2]; fb[q + 3] = 255; };
  for (let ty = 0; ty < h; ty += 64) {
    const th = Math.min(64, h - ty);
    for (let tx = 0; tx < w; tx += 64) {
      const tw = Math.min(64, w - tx); if (p >= data.length) throw new Error("ZRLE：資料不足");
      const sub = data[p++], rle = !!(sub & 128), psize = sub & 127;
      const fill = (cb) => { for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) put(x0 + tx + x, y0 + ty + y, cb(x, y)); };
      if (!rle && psize === 0) { for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { put(x0 + tx + x, y0 + ty + y, pix(p)); p += cp; } }
      else if (!rle && psize === 1) { const c = pix(p); p += cp; fill(() => c); }
      else if (!rle && psize >= 2 && psize <= 16) {
        const pal = []; for (let i = 0; i < psize; i++) { pal.push(pix(p)); p += cp; }
        const bpp = psize === 2 ? 1 : psize <= 4 ? 2 : 4, rowBytes = Math.ceil((tw * bpp) / 8);
        for (let y = 0; y < th; y++) { if (p + rowBytes * th > data.length) throw new Error("ZRLE：資料不足"); const row = p + y * rowBytes; for (let x = 0; x < tw; x++) { const bit = x * bpp, v = (data[row + (bit >> 3)] >> (8 - bpp - (bit & 7))) & ((1 << bpp) - 1); put(x0 + tx + x, y0 + ty + y, pal[v] || pal[0]); } }
        p += rowBytes * th;
      }
      else if (rle && psize === 0) {
        let n = 0; const total = tw * th;
        while (n < total) {
          const c = pix(p); p += cp; let run = 1; for (;;) { const b = nb(); run += b; if (b !== 255) break; }
          for (let i = 0; i < run && n < total; i++, n++) put(x0 + tx + (n % tw), y0 + ty + Math.floor(n / tw), c);
        }
      }
      else if (rle && psize >= 2) {
        const pal = []; for (let i = 0; i < psize - 0; i++) { pal.push(pix(p)); p += cp; }
        // 注意：palette RLE 的 sub 低 7 位元就是 palette 大小（130~255 → 2~127）
        let n = 0; const total = tw * th;
        while (n < total) {
          let idx = nb(), run = 1;
          if (idx & 128) { idx &= 127; run = 1; for (;;) { const b = nb(); run += b; if (b !== 255) break; } }
          const c = pal[idx] || pal[0];
          for (let i = 0; i < run && n < total; i++, n++) put(x0 + tx + (n % tw), y0 + ty + Math.floor(n / tw), c);
        }
      }
      else throw new Error("ZRLE：無效的磁磚型別 " + sub);
    }
  }
  return p;
}

module.exports = { desEncryptBlock, desDecryptBlock, vncKey, vncAuthResponse, Inflater, decodeZrle };
