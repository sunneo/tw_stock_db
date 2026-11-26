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
  var MIN_VOTES = 20;                 // 命中的票數下限（校準：負面對照（不在索引的歌）最高 18 票；真命中最低約 200 票）
  var RATIO = 2.5;                    // 最高票的偏移，要比「其他偏移」最高票高這麼多倍，才算集中（不亂給）
  var SEP_Z = 3;                      // 自適應：比例不夠時，差距若大過次高票的 SEP_Z 倍平方根（泊松隨機波動）也算集中；背景票越多，需要的差距越大（喇叭→麥克風的殘響與噪音會把次高票墊高）
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

  // ───── 主旋律線（階段二，與地標、色度共用同一份頻譜，不另外解碼）─────
  // 每格算「諧波加總顯著度」：音高為 MIDI 33（55 Hz）～93（1760 Hz) 每半音一格，第 h 個諧波取最近的頻譜格（前後各看一格取最大）。
  // 每格再除以該格最強的音高、乘上「該格能量相對全曲最響」的閘門（安靜的格子不會把雜音當旋律）。
  // Viterbi：每格的狀態是「一個音高」或「靜音」；發射分數＝顯著度－MEL_THR，靜音＝0；換狀態一律扣 MEL_CHANGE（音高穩定、不亂跳）。
  // 取出一條線後把它的音高（±1 半音）的顯著度遮掉，再取下一條（第二聲部、低音），最多 MEL_LINES 條。
  // 已知限制：遮掉只到 ±1 半音，八度上下的重複音仍可能被第二條線拿去；頻譜格約 5.4 Hz，低音（55 Hz 附近）解析度不足。
  var MEL_MIDI0 = 33, MEL_NP = 61, MEL_HARM = [1, 0.7, 0.5, 0.4, 0.3, 0.25];
  var MEL_THR = 0.35, MEL_CHANGE = 1.0, MEL_MIN_RUN = 4, MEL_LINES = 3, MEL_MIN_NOTES = 8, MEL_MIN_VOICED = 0.08;
  // 低音域的懲罰：旋律通常在上面，低音（伴奏、貝斯）會把旋律線拖出一串八度下的音；低於 MEL_LOW_MIDI 的音每低一個八度扣 MEL_LOW_PEN
  var MEL_LOW_MIDI = 52, MEL_LOW_PEN = 0.3;
  var MEL_REGP = (function () { var out = new Float64Array(MEL_NP); for (var p = 0; p < MEL_NP; p++) out[p] = MEL_LOW_PEN * Math.max(0, MEL_LOW_MIDI - (MEL_MIDI0 + p)) / 12; return out; })();
  var MEL_HB = (function () {
    var H = MEL_HARM.length, out = new Int16Array(MEL_NP * H);
    for (var p = 0; p < MEL_NP; p++) for (var h = 0; h < H; h++) {
      var fr = 440 * Math.pow(2, (MEL_MIDI0 + p - 69) / 12) * (h + 1);
      var b = Math.round(fr * WIN / SR);
      out[p * H + h] = b < MAXBIN ? b : -1;
    }
    return out;
  })();
  // 每格的顯著度（0..1）與閘門（0..1）。回傳 { sal: Float32Array(F×MEL_NP), gate: Float32Array(F) }
  function salienceFrames(S, F) {
    var maxDb = -Infinity, i, f, p, h, k, H = MEL_HARM.length;
    for (i = 0; i < S.length; i++) if (S[i] > maxDb) maxDb = S[i];
    var sal = new Float32Array(F * MEL_NP), gate = new Float32Array(F), amp = new Float64Array(MAXBIN);
    for (f = 0; f < F; f++) {
      var o = f * MAXBIN, fmax = -Infinity;
      for (k = 0; k < MAXBIN; k++) { var v = S[o + k]; if (v > fmax) fmax = v; amp[k] = Math.pow(10, v / 20); }
      var g = (fmax - (maxDb - DB_RANGE)) / DB_RANGE;
      if (g <= 0) continue;
      g = Math.min(1, g); gate[f] = g;
      var mx = 0, row = f * MEL_NP;
      for (p = 0; p < MEL_NP; p++) {
        var s = 0;
        for (h = 0; h < H; h++) {
          var b = MEL_HB[p * H + h];
          if (b < 0) break;
          var m = amp[b];
          if (b > 0 && amp[b - 1] > m) m = amp[b - 1];
          if (b + 1 < MAXBIN && amp[b + 1] > m) m = amp[b + 1];
          s += MEL_HARM[h] * m;
        }
        sal[row + p] = s; if (s > mx) mx = s;
      }
      if (mx > 0) for (p = 0; p < MEL_NP; p++) sal[row + p] = sal[row + p] / mx * g;
    }
    return { sal: sal, gate: gate };
  }
  // Viterbi：回傳每格的狀態（0..MEL_NP-1 為音高，MEL_NP 為靜音）
  function viterbiPitch(sal, F) {
    var NS = MEL_NP + 1, V = new Float64Array(NS), NV = new Float64Array(NS), bp = new Uint8Array(F * NS), st = new Uint8Array(F);
    var f, q, e0, mArg, mBest, stay, go;
    for (q = 0; q < NS; q++) V[q] = q === MEL_NP ? 0 : sal[q] - MEL_THR - MEL_REGP[q];
    for (f = 1; f < F; f++) {
      mBest = -Infinity; mArg = MEL_NP;
      for (q = 0; q < NS; q++) if (V[q] > mBest) { mBest = V[q]; mArg = q; }
      var row = f * MEL_NP;
      for (q = 0; q < NS; q++) {
        e0 = q === MEL_NP ? 0 : sal[row + q] - MEL_THR - MEL_REGP[q];
        stay = V[q]; go = mBest - MEL_CHANGE;
        if (stay >= go) { NV[q] = stay + e0; bp[f * NS + q] = q; } else { NV[q] = go + e0; bp[f * NS + q] = mArg; }
      }
      var tmp = V; V = NV; NV = tmp;
    }
    var cur = 0, bv = -Infinity;
    for (q = 0; q < NS; q++) if (V[q] > bv) { bv = V[q]; cur = q; }
    for (f = F - 1; f >= 0; f--) { st[f] = cur; if (f > 0) cur = bp[f * NS + cur]; }
    return st;
  }
  // 狀態序列 → 音符（同音高連續格、長度 ≥ MEL_MIN_RUN 格）
  function runsToNotes(st, F) {
    var out = [], f = 0;
    while (f < F) {
      var p = st[f], g = f;
      while (g < F && st[g] === p) g++;
      if (p !== MEL_NP && g - f >= MEL_MIN_RUN) out.push({ t: round3(f * HOP / SR), d: round3((g - f) * HOP / SR), n: MEL_MIDI0 + p });
      f = g;
    }
    return out;
  }
  // 取出最多 MEL_LINES 條主旋律線（每條是音符陣列 [{t, d, n}]，秒與 MIDI 音高）
  function melodyLines(S, F) {
    var sg = salienceFrames(S, F), sal = sg.sal, lines = [], L, k;
    for (L = 0; L < MEL_LINES; L++) {
      var st = viterbiPitch(sal, F), notes = runsToNotes(st, F);
      var voiced = 0; for (k = 0; k < F; k++) if (st[k] !== MEL_NP) voiced++;
      if (notes.length < MEL_MIN_NOTES || voiced < MEL_MIN_VOICED * F) break;
      lines.push(notes);
      // 遮掉這條線用掉的能量（每格的這個音高 ±1 半音）
      for (k = 0; k < F; k++) {
        if (st[k] === MEL_NP) continue;
        for (var q = Math.max(0, st[k] - 1); q <= Math.min(MEL_NP - 1, st[k] + 1); q++) sal[k * MEL_NP + q] = 0;
      }
    }
    return lines;
  }

  // 主入口：samples 為單聲道（或多聲道陣列），srcRate 為取樣率。
  // 回傳 { v, sr, hop, frames, dur, hashes, times, cells, chroma, lines }；lines 是階段二的主旋律線（最多 3 條，每條 [{t, d, n}]）
  function fingerprint(samples, srcRate) {
    var x = resampleTo11025(toMono(samples), srcRate);
    var sp = spectrogram(x);
    var pk = findPeaks(sp.S, sp.F);
    var lm = landmarks(pk);
    var ch = chroma(sp.S, sp.F);
    var lines = melodyLines(sp.S, sp.F);
    return { v: FP_VERSION, sr: SR, hop: HOP, frames: sp.F, dur: round3(x.length / SR), hashes: lm.hashes, times: lm.times, cells: ch.cells, chroma: ch.bytes, lines: lines };
  }
  // 只要色度（哼歌查詢用，不做地標與旋律）：回傳 { cells, chroma }，格式與 fingerprint 的色度相同
  function chromaOf(samples, srcRate) {
    var x = resampleTo11025(toMono(samples), srcRate);
    var sp = spectrogram(x), ch = chroma(sp.S, sp.F);
    return { cells: ch.cells, chroma: ch.bytes, dur: round3(x.length / SR) };
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
  // 查詢用：同一段錄音在 QPHASES 個起點相位（每 HOP/QPHASES 個取樣）各算一次，地標合併。
  // 原因：索引的頻譜格固定從歌的開頭算起，查詢的段落起點任意，格子不對齊時峰值會變，命中票數掉到約 1/5（實測）。
  // 多相位讓查詢至少有一個相位與索引格子幾乎對齊；時間只到整格（誤差約半格，約 23 毫秒）。
  var QPHASES = 8;
  function fingerprintQuery(samples, srcRate) {
    var x = resampleTo11025(toMono(samples), srcRate);
    var hs = [], ts = [], chFp = null;
    for (var q = 0; q < QPHASES; q++) {
      var p = Math.floor(q * HOP / QPHASES);
      var sub = x.subarray(p);
      var sp = spectrogram(sub);
      var lm = landmarks(findPeaks(sp.S, sp.F));
      if (q === 0) chFp = chroma(sp.S, sp.F);
      var add = Math.round(p / HOP);
      for (var i = 0; i < lm.hashes.length; i++) { hs.push(lm.hashes[i]); ts.push(lm.times[i] + add); }
    }
    return { v: FP_VERSION, sr: SR, hop: HOP, frames: Math.ceil(x.length / HOP), dur: round3(x.length / SR), hashes: Uint32Array.from(hs), times: Uint32Array.from(ts), cells: chFp.cells, chroma: chFp.bytes };
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
    // 相鄰偏移（差 1 格）的票合計：量化抖動會把同一個偏移的票分到隔壁格子
    var smooth = new Map();
    votes.forEach(function (cnt, key) { smooth.set(key, cnt + (votes.get(key - 1) || 0) + (votes.get(key + 1) || 0)); });
    votes = smooth;
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
    if (top.votes < ratio * Math.max(1, second) && top.votes - second < SEP_Z * Math.sqrt(second + 1)) { result.reason = '票數不集中（最高 ' + top.votes + '，次高偏移 ' + second + '）'; return result; }
    result.ok = true;
    return result;
  }

  // ───── 和聲（色度）比對：哼歌用 ─────
  // 色度每格約 0.23 秒；比對時兩格併成一格（約 0.46 秒），每格轉成單位向量（全零＝沒有和聲，不算分）。
  var CH_MERGE = 2, CH_SEC = CH_MERGE * CH_CELL * HOP / SR;      // 併過後每格的秒數
  function chromaVectors(bytes, cells) {
    var m = Math.ceil(cells / CH_MERGE), out = new Float32Array(m * 12), acc = new Float64Array(12);
    for (var c = 0; c < m; c++) {
      acc.fill(0);
      for (var g = c * CH_MERGE; g < Math.min(cells, (c + 1) * CH_MERGE); g++) for (var p = 0; p < 12; p++) acc[p] += bytes[g * 12 + p];
      var nrm = 0; for (p = 0; p < 12; p++) nrm += acc[p] * acc[p];
      nrm = Math.sqrt(nrm);
      if (nrm > 0) for (p = 0; p < 12; p++) out[c * 12 + p] = acc[p] / nrm;
    }
    return { m: m, v: out };
  }
  // 查詢的色度向量 12 個調都試：第 p 維變成原本第 (p + k) 維（等於把哼歌的音高往下移 k 個半音去對歌；哼得比原曲高 k 個半音，k 就是那個數）
  function rotateVectors(v, m, k) {
    if (!k) return v;
    var out = new Float32Array(m * 12);
    for (var i = 0; i < m; i++) for (var p = 0; p < 12; p++) out[i * 12 + p] = v[i * 12 + ((p + k) % 12)];
    return out;
  }
  // 子序列 DTW：查詢（mq 格）可以從歌的任何格開始、任何格結束（自由起點、自由終點），中間允許快慢伸縮（水平或垂直移動）。
  // 格與格的相似度＝內積（兩個單位向量）；路徑上的平均相似度是分數（1 最像）。回傳 { score, start, end }（格號，end 含）
  function dtwSub(q, mq, s, ns) {
    var prev = new Float64Array(ns), cur = new Float64Array(ns), ps = new Int32Array(ns), cs = new Int32Array(ns), i, j, p;
    var bestEnd = Infinity, bestJ = 0;
    for (i = 0; i < mq; i++) {
      for (j = 0; j < ns; j++) {
        var dot = 0, qo = i * 12, so = j * 12;
        for (p = 0; p < 12; p++) dot += q[qo + p] * s[so + p];
        var d = 1 - dot;
        if (i === 0) { cur[j] = d; cs[j] = j; continue; }
        var best = prev[j], bs = ps[j];
        if (j > 0) {
          if (prev[j - 1] < best) { best = prev[j - 1]; bs = ps[j - 1]; }
          if (cur[j - 1] < best) { best = cur[j - 1]; bs = cs[j - 1]; }
        }
        cur[j] = best + d; cs[j] = bs;
      }
      var tmp = prev; prev = cur; cur = tmp; var ti = ps; ps = cs; cs = ti;
    }
    for (j = 0; j < ns; j++) if (prev[j] < bestEnd) { bestEnd = prev[j]; bestJ = j; }
    return { score: 1 - bestEnd / mq, start: ps[bestJ], end: bestJ };
  }
  // 色度比對：查詢（unpack 前的 { cells, chroma }）對每首歌（entries：[{ key, name, path, cells, chroma }]）做 12 個調的子序列 DTW，取最高分的調與段落。
  // 回傳依分數排序的前 limit 首：{ key, name, path, score, shift（哼歌要降幾個半音才對上歌）, startSec, endSec（歌內秒數） }
  // 查詢格數不足（少於 MIN_CH_CELLS 格有和聲）回傳空陣列，不硬比。
  var MIN_CH_CELLS = 4;
  // 和聲有把握：第一名的分數 ≥ CHROMA_OK，且比第二名高 CHROMA_MARGIN 以上（校準：合成資料上真命中 0.78–0.96、第二名 0.52–0.59；
  // 沒收錄的旋律：第一名 0.47–0.59 而且與第二名只差不到 0.05，所以只看分數不夠，要看邊際）
  var CHROMA_OK = 0.7, CHROMA_MARGIN = 0.12;
  function chromaSearch(query, entries, opts) {
    opts = opts || {};
    var limit = opts.limit || 10, qv = chromaVectors(query.chroma, query.cells), mq = qv.m;
    var nz = 0, i, p0;
    for (i = 0; i < mq; i++) { for (p0 = 0; p0 < 12; p0++) if (qv.v[i * 12 + p0] !== 0) { nz++; break; } }
    if (nz < MIN_CH_CELLS) return [];
    var rot = []; for (var k = 0; k < 12; k++) rot.push(rotateVectors(qv.v, mq, k));
    var out = [];
    (entries || []).forEach(function (e) {
      if (!e || !e.chroma || !e.cells) return;
      var sv = chromaVectors(e.chroma, e.cells);
      if (sv.m < 1) return;
      var best = null;
      for (var kk = 0; kk < 12; kk++) {
        var r = dtwSub(rot[kk], mq, sv.v, sv.m);
        if (!best || r.score > best.score) best = { score: r.score, shift: kk, start: r.start, end: r.end };
      }
      out.push({ key: e.key, name: e.name, path: e.path, score: round3(best.score), shift: best.shift, startSec: round3(best.start * CH_SEC), endSec: round3((best.end + 1) * CH_SEC) });
    });
    out.sort(function (a, b) { return b.score - a.score || String(a.name).localeCompare(String(b.name)); });
    return out.slice(0, limit);
  }
  // 名次融合（Reciprocal Rank Fusion）：每一層取前幾名，依名次加分 w / (K + 名次)；同一首歌在哪幾層出現、每層的名次與分數都保留，供畫面標示命中層
  // layers：{ 層名: [{ key, name, score, startSec, endSec, ... }] }（已依分數排序）；weights：{ 層名: 權重 }
  var RRF_K = 60;
  function fuseRanks(layers, weights) {
    var by = {}, names = Object.keys(layers || {});
    names.forEach(function (ln) {
      var w = weights && weights[ln] != null ? weights[ln] : 1;
      (layers[ln] || []).forEach(function (r, idx) {
        var e = by[r.key] || (by[r.key] = { key: r.key, name: r.name, path: r.path, fused: 0, layers: {} });
        e.fused += w / (RRF_K + idx + 1);
        e.layers[ln] = { rank: idx + 1, score: r.score, startSec: r.startSec, endSec: r.endSec, label: r.label || '', noteFrom: r.noteFrom, noteTo: r.noteTo, shift: r.shift };
      });
    });
    return Object.keys(by).map(function (k) { return by[k]; }).sort(function (a, b) { return b.fused - a.fused || String(a.name).localeCompare(String(b.name)); });
  }

  // 哼歌的判定（純函式）：融合名次＋有沒有把握。melody／chroma 都已依分數排序（每筆有 key、score、名稱等）。
  // 有把握＝旋律第一名分數 ≥ opts.melodyConfident，或和聲第一名 ≥ CHROMA_OK 且比第二名高 CHROMA_MARGIN 以上；
  // 而且融合後的第一名就是那一首。沒把握時 confident 為 false，畫面不假裝找到。
  // opts.fpTop：原曲指紋已通過判定的那一首（{ key, name, path }）→ 最有把握，直接算有把握
  // opts.polyphonic：查詢是多聲部（有伴奏）→ 旋律權重降為 0.25，且旋律第一名不能單獨成為有把握的依據
  function humVerdict(melody, chroma, opts) {
    var mc = opts && opts.melodyConfident != null ? opts.melodyConfident : 0.5;
    var fpTop = opts && opts.fpTop ? opts.fpTop : null, poly = !!(opts && opts.polyphonic);
    melody = melody || []; chroma = chroma || [];
    var layers = { 指紋: fpTop ? [{ key: fpTop.key, name: fpTop.name, path: fpTop.path, score: 1 }] : [], 旋律: melody, 和聲: chroma };
    var fused = fuseRanks(layers, { 指紋: 2, 旋律: poly ? 0.25 : 1, 和聲: 1 }).slice(0, 10);
    var sureKey = null, mTop = melody[0], cTop = chroma[0], cSec = chroma[1];
    if (fpTop) sureKey = fpTop.key;
    else if (!poly && mTop && mTop.score >= mc) sureKey = mTop.key;
    else if (cTop && cTop.score >= CHROMA_OK && (!cSec || cTop.score - cSec.score >= CHROMA_MARGIN)) sureKey = cTop.key;
    var top = fused[0] || null;
    return { fused: fused, top: top, confident: !!(top && sureKey != null && top.key === sureKey) };
  }
  // 多聲部程度（純函式）：每格（色度）同時活躍的音高類別數（≥ 該格最大值的一半）取平均；沒有和聲的格不算。
  // 實測（喇叭→麥克風合成）：哼唱約 1.3–1.6，播放原曲約 2.1–4.2；門檻由呼叫端依索引內歌曲的中位數自適應。
  function polyphony(c) {
    var sum = 0, n = 0, g, p, mx, k;
    for (g = 0; g < c.cells; g++) {
      mx = 0; for (p = 0; p < 12; p++) if (c.chroma[g * 12 + p] > mx) mx = c.chroma[g * 12 + p];
      if (mx <= 0) continue;
      k = 0; for (p = 0; p < 12; p++) if (c.chroma[g * 12 + p] >= 0.5 * mx) k++;
      sum += k; n++;
    }
    return n ? Math.round(sum / n * 100) / 100 : 0;
  }

  return {
    humVerdict: humVerdict, polyphony: polyphony,
    FP_VERSION: FP_VERSION, SR: SR, HOP: HOP, WIN: WIN,
    fingerprint: fingerprint, fingerprintQuery: fingerprintQuery, chromaOf: chromaOf, pack: pack, unpack: unpack,
    buildIndex: buildIndex, search: search, chromaSearch: chromaSearch, fuseRanks: fuseRanks, melodyLines: melodyLines,
    CH_SEC: CH_SEC, MEL_LINES: MEL_LINES, CHROMA_OK: CHROMA_OK, CHROMA_MARGIN: CHROMA_MARGIN,
    // 測試與除錯用
    _spectrogram: spectrogram, _findPeaks: findPeaks, _toMono: toMono, _resample: resampleTo11025, _b64enc: b64enc, _b64dec: b64dec
  };
}));
