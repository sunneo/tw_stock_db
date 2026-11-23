/* MD5（RFC 1321，公共領域演算法）的純 JS 實作，UMD。WebCrypto 沒有 MD5，所以自己寫。
 *   md5Create() → { update(bytes), hex() }：分段輸入，結果與一次輸入相同；hex() 之後不可再 update。
 *   md5Hex(bytesOrString) → 小寫十六進位（字串用 UTF-8 編碼）。
 * 只用在桌面版主行程算不到（舊版 app）時的退路，所以不追求速度，但不會把整個檔案放進記憶體以外的地方。 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(); else root.FaMd5 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  var S = [7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
    5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
    4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
    6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21];
  var K = [];
  for (var i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) | 0;

  function rotl(x, c) { return (x << c) | (x >>> (32 - c)); }
  // 處理一個 64 位元組的區塊（m[o..o+63]）
  function transform(st, m, o) {
    var X = new Array(16), j;
    for (j = 0; j < 16; j++) { var p = o + j * 4; X[j] = m[p] | (m[p + 1] << 8) | (m[p + 2] << 16) | (m[p + 3] << 24); }
    var a = st[0], b = st[1], c = st[2], d = st[3], f, g;
    for (var k = 0; k < 64; k++) {
      if (k < 16) { f = (b & c) | (~b & d); g = k; }
      else if (k < 32) { f = (d & b) | (~d & c); g = (5 * k + 1) % 16; }
      else if (k < 48) { f = b ^ c ^ d; g = (3 * k + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * k) % 16; }
      var tmp = d; d = c; c = b;
      b = (b + rotl((a + f + K[k] + X[g]) | 0, S[k])) | 0;
      a = tmp;
    }
    st[0] = (st[0] + a) | 0; st[1] = (st[1] + b) | 0; st[2] = (st[2] + c) | 0; st[3] = (st[3] + d) | 0;
  }
  function toBytes(x) {
    if (typeof x === 'string') return new TextEncoder().encode(x);
    return x instanceof Uint8Array ? x : new Uint8Array(x);
  }

  function md5Create() {
    var st = [0x67452301, 0xefcdab89 | 0, 0x98badcfe | 0, 0x10325476];
    var buf = new Uint8Array(64), bl = 0, total = 0, done = false;
    return {
      update: function (input) {
        if (done) throw new Error('md5：已經算完（hex 之後不能再 update）');
        var u = toBytes(input), pos = 0;
        total += u.length;
        if (bl > 0) {
          var take = Math.min(64 - bl, u.length);
          buf.set(u.subarray(0, take), bl); bl += take; pos = take;
          if (bl === 64) { transform(st, buf, 0); bl = 0; }
        }
        while (pos + 64 <= u.length) { transform(st, u, pos); pos += 64; }
        if (pos < u.length) { buf.set(u.subarray(pos), 0); bl = u.length - pos; }
        return this;
      },
      hex: function () {
        if (done) throw new Error('md5：hex 只能呼叫一次');
        done = true;
        var padLen = (bl < 56) ? (56 - bl) : (120 - bl);
        var tail = new Uint8Array(padLen + 8);
        tail[0] = 0x80;
        var bitsLo = (total * 8) >>> 0, bitsHi = Math.floor(total / 536870912) >>> 0; // total*8 的低 32 位與高 32 位
        for (var i = 0; i < 4; i++) { tail[padLen + i] = (bitsLo >>> (8 * i)) & 0xff; tail[padLen + 4 + i] = (bitsHi >>> (8 * i)) & 0xff; }
        var all = new Uint8Array(bl + tail.length);
        all.set(buf.subarray(0, bl), 0); all.set(tail, bl);
        for (var p = 0; p < all.length; p += 64) transform(st, all, p);
        var out = '';
        for (var w = 0; w < 4; w++) for (var b = 0; b < 4; b++) out += ((st[w] >>> (8 * b)) & 0xff).toString(16).padStart(2, '0');
        return out;
      }
    };
  }
  function md5Hex(input) { return md5Create().update(input).hex(); }
  return { md5Create: md5Create, md5Hex: md5Hex };
});
