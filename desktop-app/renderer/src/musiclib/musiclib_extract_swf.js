/* Flash（SWF）音樂擷取器：純函式（UMD），不碰 DOM。解壓縮的 zlib／LZMA 由呼叫端注入，node 測試可用 zlib，瀏覽器用 DecompressionStream 與 FaMatrixLzma。
 *   parseSwf(bytes, deps) → Promise<{ version, sounds:[…], skipped:[…] }>
 *     deps: { inflate(u8) → Promise<Uint8Array>（zlib 格式）, lzmaDecode(u813) → Uint8Array（13 位元組 LZMA1 檔頭＋資料，已知大小）}
 *   sounds 每項：{ id, kind:'mp3'|'wav'|'mid', source:'sound'|'stream'|'binary', bytes:Uint8Array, sampleRate, channels, sampleCount, durationSec, format }
 *   kind mp3：原樣的 MP3 幀（SWF 的 MP3 去掉開頭的 SeekSamples）；wav：PCM 或 ADPCM 解碼後的 16 位元 wav；mid：內嵌的 MIDI。
 *   其他格式（Nellymoser 等）不解，記到 skipped，附原因。
 * 格式依據：SWF 規格的 DefineSound（tag 14）、SoundStreamHead（18）／Head2（45）、SoundStreamBlock（19）、DefineBinaryData（87）；
 *   ADPCM：FFmpeg libavcodec/adpcm.c 的 adpcm_swf_decode（逐字參照的表與迴圈），步進表是 IMA ADPCM 的 89 項。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMusicLibSwf = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var RATES = [5512, 11025, 22050, 44100];
  // FFmpeg adpcm.c 的 swf_index_tables（2～5 位元）
  var SWF_INDEX = [
    [-1, 2],
    [-1, -1, 2, 4],
    [-1, -1, -1, -1, 2, 4, 6, 8],
    [-1, -1, -1, -1, -1, -1, -1, -1, 1, 2, 4, 6, 8, 10, 13, 16]
  ];
  // IMA ADPCM 步進表（89 項）
  var STEP = [7, 8, 9, 10, 11, 12, 13, 14, 16, 17, 19, 21, 23, 25, 28, 31, 34, 37, 41, 45, 50, 55, 60, 66, 73, 80, 88, 97, 107, 118, 130, 143, 157, 173, 190, 209, 230, 253, 279, 307, 337, 371, 408, 449, 494, 544, 598, 658, 724, 796, 876, 963, 1060, 1166, 1282, 1411, 1552, 1707, 1878, 2066, 2272, 2499, 2749, 3024, 3327, 3660, 4026, 4428, 4871, 5358, 5894, 6484, 7132, 7845, 8630, 9493, 10442, 11487, 12635, 13899, 15289, 16818, 18500, 20350, 22385, 24623, 27086, 29794, 32767];

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function clip16(v) { return v > 32767 ? 32767 : v < -32768 ? -32768 : v; }

  // 解壓縮整個檔案成未壓縮的 FWS 位元組（頭 8 位元組保留，簽章改成 FWS）
  async function decompressSwf(bytes, deps) {
    var sig = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
    if (sig === 'FWS') return bytes;
    if (sig === 'CWS') {
      if (!deps.inflate) throw new Error('解壓失敗（CWS）：沒有 zlib 解壓函式');
      var body = await deps.inflate(bytes.subarray(8));
      var out = new Uint8Array(8 + body.length); out.set(bytes.subarray(0, 8), 0); out.set(body, 8); out[0] = 0x46; out[1] = 0x57; out[2] = 0x53;
      return out;
    }
    if (sig === 'ZWS') {
      if (!deps.lzmaDecode) throw new Error('解壓失敗（ZWS）：沒有 LZMA 解壓函式');
      var uncompLen = u32(bytes, 4);            // 未壓縮的整個檔案長度（含 8 位元組檔頭）
      var props = bytes.subarray(12, 17);      // 5 位元組：props(1) + dictSize(4)，接著才是 LZMA 資料
      var data = bytes.subarray(17);
      var hdr = new Uint8Array(13 + data.length);
      hdr.set(props, 0);
      var bodyLen = uncompLen - 8;
      for (var i = 0; i < 8; i++) hdr[5 + i] = i < 4 ? (bodyLen >>> (8 * i)) & 0xFF : 0;
      hdr.set(data, 13);
      var lz = await deps.lzmaDecode(hdr);
      var z = new Uint8Array(8 + lz.length); z.set(bytes.subarray(0, 8), 0); z.set(lz, 8); z[0] = 0x46; z[1] = 0x57; z[2] = 0x53;
      return z;
    }
    throw new Error('不是 SWF 檔（簽章是 ' + JSON.stringify(sig) + '）');
  }

  // RECT：前 5 位元是位元數 n，接著 4 個 n 位元的座標；回傳它佔的位元組數（對齊到位元組）
  function rectBytes(b, o) { var n = b[o] >> 3; return Math.ceil((5 + 4 * n) / 8); }

  // 讀標準 SWF 標籤（短格式或長格式）
  function* tags(b, start) {
    var p = start;
    while (p + 2 <= b.length) {
      var h = u16(b, p), code = h >> 6, len = h & 0x3F, hdrLen = 2;
      if (len === 0x3F) { if (p + 6 > b.length) return; len = u32(b, p + 2); hdrLen = 6; }
      var dataStart = p + hdrLen, dataEnd = dataStart + len;
      if (dataEnd > b.length) { yield { code: code, data: b.subarray(dataStart), truncated: true }; return; }
      yield { code: code, data: b.subarray(dataStart, dataEnd), truncated: false };
      p = dataEnd;
      if (code === 0) return; // End
    }
  }

  // 位元讀取（MSB 在前），給 ADPCM 用
  function bitReader(b) {
    var pos = 0, total = b.length * 8;
    return {
      total: total,
      pos: function () { return pos; },
      bits: function (n) { var v = 0; for (var i = 0; i < n; i++) { var byte = b[pos >> 3], bit = (byte >> (7 - (pos & 7))) & 1; v = (v << 1) | bit; pos++; } return v; },
      sbits: function (n) { var v = this.bits(n); return v >= (1 << (n - 1)) ? v - (1 << n) : v; }
    };
  }

  // SWF ADPCM → Int16 交錯 PCM（照 adpcm_swf_decode）
  function decodeAdpcmSwf(b, channels) {
    var br = bitReader(b), out = [];
    var nb = br.bits(2) + 2, table = SWF_INDEX[nb - 2], k0 = 1 << (nb - 2), signmask = 1 << (nb - 1);
    var size = br.total;
    var pred = [], idx = [];
    for (var c = 0; c < channels; c++) { pred.push(0); idx.push(0); }
    while (br.pos() <= size - 22 * channels) {
      for (var i = 0; i < channels; i++) {
        pred[i] = br.sbits(16); out.push(pred[i]);
        idx[i] = br.bits(6);
      }
      for (var count = 0; br.pos() <= size - nb * channels && count < 4095; count++) {
        for (var k2 = 0; k2 < channels; k2++) {
          var delta = br.bits(nb);
          var step = STEP[idx[k2]], vpdiff = 0, k = k0;
          do { if (delta & k) vpdiff += step; step >>= 1; k >>= 1; } while (k);
          vpdiff += step;
          if (delta & signmask) pred[k2] -= vpdiff; else pred[k2] += vpdiff;
          idx[k2] += table[delta & ~signmask];
          idx[k2] = idx[k2] < 0 ? 0 : idx[k2] > 88 ? 88 : idx[k2];
          pred[k2] = clip16(pred[k2]);
          out.push(pred[k2]);
        }
      }
    }
    return Int16Array.from(out);
  }

  // 16 位元 PCM 包成 wav 位元組
  function wavBytes(pcm, rate, channels) {
    var n = pcm.length, data = new Uint8Array(44 + n * 2), dv = new DataView(data.buffer);
    var w = function (o, s) { for (var i = 0; i < s.length; i++) data[o + i] = s.charCodeAt(i); };
    w(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt '); dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); dv.setUint16(22, channels, true); dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * 2, true);
    dv.setUint16(32, channels * 2, true); dv.setUint16(34, 16, true); w(36, 'data'); dv.setUint32(40, n * 2, true);
    for (var i = 0; i < n; i++) dv.setInt16(44 + i * 2, pcm[i], true);
    return data;
  }

  // DefineSound（14）或串流區塊：依格式產生 { kind, bytes, pcm?, rate, ch, count } 或丟「不支援」
  function decodeSoundData(fmt, rate, sizeBits, stereo, count, data, skipped, id) {
    var ch = stereo ? 2 : 1;
    if (fmt === 2) {                              // MP3：開頭 2 位元組是 SeekSamples
      return { kind: 'mp3', bytes: data.subarray(2), rate: rate, ch: ch, count: count };
    }
    if (fmt === 0 || fmt === 3) {                 // 未壓縮 PCM（0 = 原生順序，視為 LE；3 = LE）
      var n;
      if (sizeBits) { n = Math.floor(data.length / 2); var p16 = new Int16Array(n); for (var i = 0; i < n; i++) p16[i] = (data[2 * i] | (data[2 * i + 1] << 8)) << 16 >> 16; return { kind: 'wav', pcm: p16, rate: rate, ch: ch, count: count }; }
      var p8 = new Int16Array(data.length); for (var j = 0; j < data.length; j++) p8[j] = (data[j] - 128) << 8; return { kind: 'wav', pcm: p8, rate: rate, ch: ch, count: count };
    }
    if (fmt === 1) return { kind: 'wav', pcm: decodeAdpcmSwf(data, ch), rate: rate, ch: ch, count: count };
    skipped.push({ id: id, reason: '不支援的音訊格式 ' + fmt + '（Nellymoser 等需要另外的解碼器，本輪未實作）' });
    return null;
  }

  async function parseSwf(bytes, deps) {
    deps = deps || {};
    var b = await decompressSwf(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), deps);
    var version = b[3];
    var p = 8 + rectBytes(b, 8);
    p += 4;                                       // 影格速率（2）＋影格數（2）
    var sounds = [], skipped = [], streams = {};
    for (var tg of tags(b, p)) {
      var d = tg.data;
      if (tg.code === 14) {                      // DefineSound
        var id = u16(d, 0), fl = d[2], fmt = fl >> 4, rate = RATES[(fl >> 2) & 3], sizeBits = (fl >> 1) & 1, stereo = fl & 1;
        var count = u32(d, 3), payload = d.subarray(7);
        var r = decodeSoundData(fmt, rate, sizeBits, stereo, count, payload, skipped, id);
        if (r) sounds.push(toSound(r, id, 'sound', fmt));
      } else if (tg.code === 18 || tg.code === 45) { // SoundStreamHead / Head2
        var sfl = d[1], scomp = sfl >> 4, srate = RATES[(sfl >> 2) & 3], ssize = (sfl >> 1) & 1, sstereo = sfl & 1;
        var key = 'stream'; streams[key] = { fmt: scomp, rate: srate, sizeBits: ssize, stereo: sstereo, blocks: [] };
      } else if (tg.code === 19) {               // SoundStreamBlock
        var st = streams.stream;
        if (st) {
          if (st.fmt === 2) st.blocks.push(d.subarray(4));   // MP3：去掉 SampleCount＋SeekSamples
          else st.blocks.push(d);
        }
      } else if (tg.code === 87) {               // DefineBinaryData：內嵌 MIDI？
        var bid = u16(d, 0), bd = d.subarray(6);
        if (bd.length >= 4 && bd[0] === 0x4D && bd[1] === 0x54 && bd[2] === 0x68 && bd[3] === 0x64) sounds.push({ id: bid, kind: 'mid', source: 'binary', bytes: bd, sampleRate: 0, channels: 0, sampleCount: 0, durationSec: 0, format: 'MIDI' });
      }
    }
    // 串流：把所有區塊接成一個來源
    Object.keys(streams).forEach(function (k) {
      var st = streams[k];
      if (!st.blocks.length) return;
      var ch = st.stereo ? 2 : 1;
      if (st.fmt === 2) {
        var total = st.blocks.reduce(function (s, x) { return s + x.length; }, 0), mp3 = new Uint8Array(total), o = 0;
        st.blocks.forEach(function (x) { mp3.set(x, o); o += x.length; });
        sounds.push({ id: -1, kind: 'mp3', source: 'stream', bytes: mp3, sampleRate: st.rate, channels: ch, sampleCount: 0, durationSec: 0, format: 'MP3 串流' });
      } else if (st.fmt === 0 || st.fmt === 3 || st.fmt === 1) {
        var parts = st.blocks.map(function (x) {
          if (st.fmt === 1) return decodeAdpcmSwf(x, ch);
          if (st.sizeBits) { var n = Math.floor(x.length / 2), q = new Int16Array(n); for (var i = 0; i < n; i++) q[i] = (x[2 * i] | (x[2 * i + 1] << 8)) << 16 >> 16; return q; }
          var m = new Int16Array(x.length); for (var j = 0; j < x.length; j++) m[j] = (x[j] - 128) << 8; return m;
        });
        var len = parts.reduce(function (s, x) { return s + x.length; }, 0), pcm = new Int16Array(len), q2 = 0;
        parts.forEach(function (x) { pcm.set(x, q2); q2 += x.length; });
        sounds.push(toSound({ kind: 'wav', pcm: pcm, rate: st.rate, ch: ch, count: len / ch }, -1, 'stream', st.fmt));
      } else {
        skipped.push({ id: -1, reason: '串流格式 ' + st.fmt + ' 不支援' });
      }
    });
    return { version: version, sounds: sounds, skipped: skipped };
  }

  function toSound(r, id, source, fmt) {
    var bytes = r.kind === 'wav' ? wavBytes(r.pcm, r.rate, r.ch) : r.bytes;
    var count = r.count || 0;
    return { id: id, kind: r.kind, source: source, bytes: bytes, sampleRate: r.rate, channels: r.ch, sampleCount: count, durationSec: r.rate ? count / r.rate : 0, format: 'fmt ' + fmt };
  }

  return { parseSwf: parseSwf, decodeAdpcmSwf: decodeAdpcmSwf, wavBytes: wavBytes, STEP: STEP, SWF_INDEX: SWF_INDEX, rectBytes: rectBytes };
}));
