/* 音樂庫的音訊指紋（階段一）：一次掃描同時算兩樣東西，node 可直接跑（UMD，純函式，不碰 DOM、麥克風、網路）。
 *
 *   1. 地標雜湊（Shazam 式）：降成 11025 Hz 單聲道 → 頻譜（視窗 2048、每 512 點一格）→ 局部峰值 → 兩兩配對，
 *      每對打成一個 26 位元雜湊（頻率1、頻率2、時間差），連同錨點的格號存起來。查詢時同樣算一次，對每首歌的「時間偏移」投票。
 *   2. 色度序列：每 0.25 秒一格（約 5 個頻譜格），把 55–2000 Hz 的能量折成 12 個音名，每格位元組量化（0–255）。
 *
 * 整首 3 分鐘的歌在 node 要 ≤ 3 秒（見 musiclib_fingerprint.test.js）。
 * 存進音樂庫時用 pack()（base64），讀回用 unpack()。版本號 FP_VERSION 寫在 record.fp.v 裡。
 * 查詢：buildIndex(entries) 把所有歌的雜湊排序好（可快取），search(query, index) 回傳名次、命中的歌內秒數與票數。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibFP = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var FP_VERSION = 1;
  var SR = 11025, WIN = 2048, HOP = 512, MAXBIN = 512;      // 0..511 格 ≈ 0–2756 Hz（每格約 5.4 Hz）
  var FREQ_NEI = 10, TIME_NEI = 7;    // 局部峰值的鄰域：頻率 ±10 格、時間 ±7 格（約 ±0.33 秒）
  var DB_RANGE = 50;                  // 比全曲最響低 50 dB 以下的不取（相對音量，所以音量改變不影響）
  var BLOCK = 22;                     // 每 22 格（約 1 秒）
  var PEAKS_PER_BLOCK = 6;            // 每塊最多留幾個峰值（控制索引大小，約 6 個／秒）
  var FAN = 4;                        // 每個錨點最多配幾個目標點（取時間上最近的）
  var DT_MIN = 1, DT_MAX = 120;       // 目標點在錨點後 1～120 格（約 0.05～5.6 秒）
  var FREQ_SPAN = 200;                // 兩點頻率差上限（格）
  var CH_LO = 55, CH_HI = 2000;       // 色度只用這個頻率範圍
  var CH_CELL = Math.round(0.25 * SR / HOP);   // 色度每格的頻譜格數（約 0.23 秒）
  var MIN_VOTES = 8;                  // 命中的票數下限
  var RATIO = 2.5;                    // 最高票的偏移，要比「其他偏移」最高票高這麼多倍，才算集中（不亂給）
  var NEAR = 2;                       // 偏移差在這（格）內，視為同一個偏移（量化造成的抖動）
  var OFF_BIAS = 8388608, OFF_SPAN = 16777216;   // 票的鍵：歌序 × 2^24 + (偏移 + 2^23)

  var HANN = new Float64Array(WIN);
  for (var hi = 0; hi < WIN; hi++) HANN[hi] = 0.5 - 0.5 * Math.cos(2 * Math.PI * hi / WIN);
  var COS = new Float64Array(WIN / 2), SIN = new Float64Array(WIN / 2);
  for (var ci = 0; ci < WIN / 2; ci++) { COS[ci] = Math.cos(-2 * Math.PI * ci / WIN); SIN[ci] = Math.sin(-2 * Math.PI * ci / WIN); }
  var REV = new Uint16Array(WIN);
  (function () { var bits = Math.log2(WIN); for (var i = 0; i < WIN; i++) { var r = 0; for (var b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b); REV[i] = r; } })();
  // 每個頻譜格對應的音名（0–11），不在色度範圍內為 -1
  var PC = new Int8Array(MAXBIN);
  for (var pk = 1; pk < MAXBIN; pk++) {
    var fr = pk * SR / WIN;
    if (fr < CH_LO || fr > CH_HI) { PC[pk] = -1; continue; }
    PC[pk] = ((Math.round(12 * Math.log2(fr / 440)) + 69) % 12 + 12) % 12;
  }

  // ───── 基本工具 ─────
  function round3(x) { return Math.round(x * 1000) / 1000; }

  // 多聲道 → 單聲道（平均）。channels：Float32Array 陣列（或單一 Float32Array）
  function toMono(channels) {
    if (channels && channels.length !== undefined && typeof channels[0] === 'number') return channels;
    var chs = Array.isArray(channels) ? channels : [channels];
    if (chs.length === 1) return chs[0];
    var n = chs[0].length, out = new Float32Array(n), k = chs.length;
    for (var c = 0; c < k; c++) { var ch = chs[c]; for (var i = 0; i < n; i++) out[i] += ch[i] / k; }
    return out;
  }
  // 降到 11025 Hz：來源較高時做箱形平均（相當於低通，避免混疊）；來源較低時線性內插
  function resampleTo11025(x, srcRate) {
    if (srcRate === SR) return x;
    var ratio = srcRate / SR;
    if (ratio < 1) {
      var m = Math.floor((x.length - 1) / ratio) + 1, o = new Float32Array(m);
      for (var i = 0; i < m; i++) {
        var p = i * ratio, j = Math.floor(p), fr = p - j;
        o[i] = x[j] * (1 - fr) + (j + 1 < x.length ? x[j + 1] * fr : x[j] * (1 - fr));
      }
      return o;
    }
    var n = Math.floor(x.length / ratio), out = new Float32Array(n);
    for (var k = 0; k < n; k++) {
      var s = Math.floor(k * ratio), e = Math.min(x.length, Math.floor((k + 1) * ratio));
      if (e <= s) { out[k] = x[Math.min(s, x.length - 1)]; continue; }
      var acc = 0; for (var q = s; q < e; q++) acc += x[q];
      out[k] = acc / (e - s);
    }
    return out;
  }

  // 原地 FFT（長度 WIN，基二，時域→頻域）
  function fft(re, im) {
    for (var i = 0; i < WIN; i++) {
      var j = REV[i];
      if (j > i) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (var size = 2; size <= WIN; size <<= 1) {
      var half = size >> 1, step = WIN / size;
      for (var start = 0; start < WIN; start += size) {
        for (var k = 0; k < half; k++) {
          var idx = k * step, wr = COS[idx], wi = SIN[idx];
          var a = start + k, b = a + half;
          var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  // 頻譜：回傳 { S（每格 MAXBIN 個 dB 值，扁平陣列）, F（格數） }
  function spectrogram(x) {
    var F = x.length < WIN ? 1 : 1 + Math.floor((x.length - WIN) / HOP);
    var S = new Float32Array(F * MAXBIN), re = new Float64Array(WIN), im = new Float64Array(WIN);
    for (var f = 0; f < F; f++) {
      var base = f * HOP;
      for (var i = 0; i < WIN; i++) { var idx = base + i; re[i] = (idx < x.length ? x[idx] : 0) * HANN[i]; im[i] = 0; }
      fft(re, im);
      var o = f * MAXBIN;
      for (var k = 0; k < MAXBIN; k++) S[o + k] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-10);
    }
    return { S: S, F: F };
  }

  // 局部峰值：某格比頻率鄰域 ±FREQ_NEI 與時間鄰域 ±TIME_NEI 內的最大值都大（或相等），且不低於全曲最響 − DB_RANGE
  // 再每 BLOCK 格只留最響的 PEAKS_PER_BLOCK 個。回傳 { t: 格號陣列, k: 頻率格陣列 }，依時間排序
  function findPeaks(S, F) {
    var maxDb = -Infinity, i;
    for (i = 0; i < S.length; i++) if (S[i] > maxDb) maxDb = S[i];
    var floorDb = maxDb - DB_RANGE;
    var FM = new Float32Array(F * MAXBIN), f, k, j, g;
    for (f = 0; f < F; f++) {
      var o = f * MAXBIN;
      for (k = 0; k < MAXBIN; k++) {
        var m = -Infinity, lo = Math.max(0, k - FREQ_NEI), hi = Math.min(MAXBIN - 1, k + FREQ_NEI);
        for (j = lo; j <= hi; j++) if (S[o + j] > m) m = S[o + j];
        FM[o + k] = m;
      }
    }
    var raw = [];   // 每個元素：[t, k, value]
    for (f = 0; f < F; f++) {
      var g0 = Math.max(0, f - TIME_NEI), g1 = Math.min(F - 1, f + TIME_NEI);
      for (k = 0; k < MAXBIN; k++) {
        var v = S[f * MAXBIN + k];
        if (v < floorDb) continue;
        var mm = -Infinity;
        for (g = g0; g <= g1; g++) if (FM[g * MAXBIN + k] > mm) mm = FM[g * MAXBIN + k];
        if (v >= mm) raw.push([f, k, v]);
      }
    }
    // 每塊取前 PEAKS_PER_BLOCK（raw 已依時間排序，同一塊的是連續區段）
    var outT = [], outK = [], p = 0;
    while (p < raw.length) {
      var blk = Math.floor(raw[p][0] / BLOCK), q = p;
      while (q < raw.length && Math.floor(raw[q][0] / BLOCK) === blk) q++;
      var seg = raw.slice(p, q);
      if (seg.length > PEAKS_PER_BLOCK) {
        seg.sort(function (x, y) { return y[2] - x[2]; });
        seg = seg.slice(0, PEAKS_PER_BLOCK).sort(function (x, y) { return x[0] - y[0] || x[1] - y[1]; });
      }
      for (var s = 0; s < seg.length; s++) { outT.push(seg[s][0]); outK.push(seg[s][1]); }
      p = q;
    }
    return { t: outT, k: outK };
  }

  // 地標：每個錨點配上時間上最近的 FAN 個目標點（時間差 DT_MIN..DT_MAX、頻率差 ≤ FREQ_SPAN）
  // 雜湊：f1 (9 位元) << 17 | f2 (9 位元) << 8 | dt (8 位元)
  function landmarks(pk) {
    var T = pk.t, K = pk.k, n = T.length, H = [], TM = [];
    for (var i = 0; i < n; i++) {
      var t1 = T[i], k1 = K[i], cnt = 0;
      for (var j = i + 1; j < n && cnt < FAN; j++) {
        var dt = T[j] - t1;
        if (dt > DT_MAX) break;
        if (dt < DT_MIN) continue;
        var k2 = K[j];
        if (Math.abs(k2 - k1) > FREQ_SPAN) continue;
        H.push((((k1 & 511) << 17) | ((k2 & 511) << 8) | (dt & 255)) >>> 0);
        TM.push(t1);
        cnt++;
      }
    }
    return { hashes: Uint32Array.from(H), times: Uint32Array.from(TM) };
  }

  // 色度：每 CH_CELL 格一格，12 個音名的能量（格內加總）→ 除以該格最大值 → 0–255
  function chroma(S, F) {
    var cells = Math.ceil(F / CH_CELL), acc = new Float64Array(cells * 12), out = new Uint8Array(cells * 12);
    for (var f = 0; f < F; f++) {
      var c = Math.floor(f / CH_CELL) * 12, o = f * MAXBIN;
      for (var k = 1; k < MAXBIN; k++) {
        var p = PC[k];
        if (p < 0) continue;
        acc[c + p] += Math.pow(10, S[o + k] / 10);
      }
    }
    for (var cell = 0; cell < cells; cell++) {
      var mx = 0, b = cell * 12;
      for (var q = 0; q < 12; q++) if (acc[b + q] > mx) mx = acc[b + q];
      for (q = 0; q < 12; q++) out[b + q] = mx > 0 ? Math.round(255 * acc[b + q] / mx) : 0;
    }
    return { cells: cells, bytes: out };
  }

  // 主入口：samples 為單聲道（或多聲道陣列），srcRate 為取樣率。回傳 { v, sr, hop, frames, dur, hashes, times, cells, chroma }
  function fingerprint(samples, srcRate) {
    var x = resampleTo11025(toMono(samples), srcRate);
    var sp = spectrogram(x);
    var pk = findPeaks(sp.S, sp.F);
    var lm = landmarks(pk);
    var ch = chroma(sp.S, sp.F);
    return { v: FP_VERSION, sr: SR, hop: HOP, frames: sp.F, dur: round3(x.length / SR), hashes: lm.hashes, times: lm.times, cells: ch.cells, chroma: ch.bytes };
  }

  // ───── 存檔格式（base64，小端序）─────
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var B64R = new Int16Array(128).fill(-1);
  for (var bi = 0; bi < 64; bi++) B64R[B64.charCodeAt(bi)] = bi;
  function b64enc(u8) {
    var s = '', i;
    for (i = 0; i < u8.length; i += 3) {
      var a = u8[i], b = i + 1 < u8.length ? u8[i + 1] : 0, c = i + 2 < u8.length ? u8[i + 2] : 0, n = (a << 16) | (b << 8) | c;
      s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < u8.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < u8.length ? B64[n & 63] : '=');
    }
    return s;
  }
  function b64dec(s) {
    var clean = String(s || '').replace(/=+$/, ''), n = Math.floor(clean.length * 3 / 4), out = new Uint8Array(n), o = 0, buf = 0, bits = 0;
    for (var i = 0; i < clean.length; i++) {
      var v = B64R[clean.charCodeAt(i)];
      if (v < 0) continue;
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; if (o < n) out[o++] = (buf >> bits) & 255; }
    }
    return out.subarray(0, o);
  }
  function u32ToBytes(arr) {
    var dv = new DataView(new ArrayBuffer(arr.length * 4));
    for (var i = 0; i < arr.length; i++) dv.setUint32(i * 4, arr[i] >>> 0, true);
    return new Uint8Array(dv.buffer);
  }
  function bytesToU32(u8) {
    var n = Math.floor(u8.length / 4), out = new Uint32Array(n), dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (var i = 0; i < n; i++) out[i] = dv.getUint32(i * 4, true);
    return out;
  }
  // 存進紀錄的形式（JSON 可存）
  function pack(fp) {
    return { v: fp.v, sr: fp.sr, hop: fp.hop, frames: fp.frames, dur: fp.dur, n: fp.hashes.length, cells: fp.cells,
      h: b64enc(u32ToBytes(fp.hashes)), t: b64enc(u32ToBytes(fp.times)), c: b64enc(fp.chroma) };
  }
  function unpack(p) {
    if (!p || typeof p !== 'object') return null;
    return { v: p.v, sr: p.sr, hop: p.hop, frames: p.frames, dur: p.dur, n: p.n, cells: p.cells,
      hashes: bytesToU32(b64dec(p.h)), times: bytesToU32(b64dec(p.t)), chroma: b64dec(p.c) };
  }

  // ───── 查詢 ─────
  // entries：[{ key, name, path, fp（pack 後的紀錄）}]。沒有 fp 或版本不同的歌不進索引，回傳在 missing 裡
  // 排序後的陣列：SH（雜湊）、SS（歌序）、ST（錨點格號），同一個雜湊的連續一段
  function buildIndex(entries) {
    var songs = [], missing = [], total = 0, parsed = [];
    (entries || []).forEach(function (e) {
      if (!e || !e.fp || e.fp.v !== FP_VERSION) { missing.push(e); return; }
      var u = unpack(e.fp);
      if (!u || !u.hashes.length) { missing.push(e); return; }
      songs.push({ key: e.key, name: e.name, path: e.path, dur: u.dur, idx: songs.length });
      parsed.push(u); total += u.hashes.length;
    });
    var H = new Uint32Array(total), S = new Uint32Array(total), T = new Uint32Array(total), w = 0;
    parsed.forEach(function (u, si) { for (var i = 0; i < u.hashes.length; i++) { H[w] = u.hashes[i]; S[w] = si; T[w] = u.times[i]; w++; } });
    var order = new Uint32Array(total);
    for (var o = 0; o < total; o++) order[o] = o;
    order.sort(function (a, b) { return H[a] - H[b] || a - b; });
    var SH = new Uint32Array(total), SS = new Uint32Array(total), ST = new Uint32Array(total);
    for (var q = 0; q < total; q++) { var src = order[q]; SH[q] = H[src]; SS[q] = S[src]; ST[q] = T[src]; }
    return { songs: songs, missing: missing, SH: SH, SS: SS, ST: ST, total: total };
  }
  function lowerBound(A, x) {
    var lo = 0, hi = A.length;
    while (lo < hi) { var mid = (lo + hi) >>> 1; if (A[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
  }
  // query：fingerprint()（或 unpack()）的結果；index：buildIndex 的結果
  // 回傳 { ok, reason, top（最高票）, hits（每首最佳偏移，依票數排序，最多 limit 首）, queryHashes, missing（沒有新特徵的歌名）, dur }
  function search(query, index, opts) {
    opts = opts || {};
    var minVotes = opts.minVotes || MIN_VOTES, ratio = opts.ratio || RATIO, limit = opts.limit || 10;
    var qh = query.hashes, qt = query.times, votes = new Map(), SH = index.SH, SS = index.SS, ST = index.ST, n = SH.length;
    for (var i = 0; i < qh.length; i++) {
      var h = qh[i], t = qt[i];
      for (var j = lowerBound(SH, h); j < n && SH[j] === h; j++) {
        var key = SS[j] * OFF_SPAN + (ST[j] - t + OFF_BIAS);
        votes.set(key, (votes.get(key) || 0) + 1);
      }
    }
    // 每首的最佳偏移
    var bestBySong = new Map();
    votes.forEach(function (cnt, key) {
      var si = Math.floor(key / OFF_SPAN), off = key - si * OFF_SPAN - OFF_BIAS, cur = bestBySong.get(si);
      if (!cur || cnt > cur.votes) bestBySong.set(si, { si: si, off: off, votes: cnt });
    });
    var ranked = Array.from(bestBySong.values()).sort(function (a, b) { return b.votes - a.votes || a.si - b.si; });
    var result = { ok: false, reason: '', top: null, hits: [], queryHashes: qh.length, missing: (index.missing || []).map(function (e) { return e && e.name; }), dur: query.dur };
    if (!ranked.length) { result.reason = '沒有任何雜湊對得上'; return result; }
    var top = ranked[0];
    // 次高票：排除最高票自己那個偏移（±NEAR 格、同一首）
    var second = 0;
    votes.forEach(function (cnt, key) {
      var si = Math.floor(key / OFF_SPAN), off = key - si * OFF_SPAN - OFF_BIAS;
      if (si === top.si && Math.abs(off - top.off) <= NEAR) return;
      if (cnt > second) second = cnt;
    });
    result.top = { si: top.si, key: index.songs[top.si].key, name: index.songs[top.si].name, offsetSec: round3(top.off * HOP / SR), votes: top.votes, second: second, confidence: round3(top.votes / (top.votes + second)) };
    result.hits = ranked.slice(0, limit).map(function (r) {
      return { key: index.songs[r.si].key, name: index.songs[r.si].name, path: index.songs[r.si].path, offsetSec: round3(r.off * HOP / SR), votes: r.votes };
    });
    if (top.votes < minVotes) { result.reason = '最高票只有 ' + top.votes + '（需要 ' + minVotes + '）'; return result; }
    if (top.votes < ratio * Math.max(1, second)) { result.reason = '票數不集中（最高 ' + top.votes + '，次高偏移 ' + second + '）'; return result; }
    result.ok = true;
    return result;
  }

  return {
    FP_VERSION: FP_VERSION, SR: SR, HOP: HOP, WIN: WIN,
    fingerprint: fingerprint, pack: pack, unpack: unpack,
    buildIndex: buildIndex, search: search,
    // 測試與除錯用
    _spectrogram: spectrogram, _findPeaks: findPeaks, _toMono: toMono, _resample: resampleTo11025, _b64enc: b64enc, _b64dec: b64dec
  };
}));
