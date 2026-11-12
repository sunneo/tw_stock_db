'use strict';
// 領域包「二進位格式補洞」：xz 串流標頭（檢查類型名稱）與 8 位元調色盤 BMP 寫出。train＝教過的措辭；holdout＝另寫措辭／另一種輸出約定，只量測、不教。參考解獨立手寫（zlib／struct）。
const H = require('./domain_harness.js'); const { rnd, pick } = H;
const BF = require('./domain_binfmt_core.js');
const hex = (n) => Array.from({ length: n }, () => ('0' + rnd(0, 255).toString(16)).slice(-2)).join('');
const crcOf = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) { c ^= b; for (let i = 0; i < 8; i++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1; } return (c ^ 0xFFFFFFFF) >>> 0; };
const le32 = (v) => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255].map((x) => ('0' + x.toString(16)).slice(-2)).join('');
// xz 標頭：魔術（好 70%）、旗標（第二個位元組的低 4 位元＝檢查類型，常見 0／1／4／10，也有 2、7）、CRC（好 70%）
const xzGen = (b) => { const magic = rnd(0, 9) < 7 ? 'fd377a585a00' : 'fd377a585a' + pick(['01', '10', 'ff']); const ty = pick([0, 1, 4, 10, 10, 1, 2, 7, 15]); const fl = [0, ty]; const good = crcOf(fl); const crc = rnd(0, 9) < 7 ? good : (good ^ (1 << rnd(0, 31))) >>> 0; return magic + ('0' + fl[0].toString(16)).slice(-2) + ('0' + fl[1].toString(16)).slice(-2) + le32(crc) + '\n'; };
const XZREF = (fmt) => 'import sys, zlib\nd = bytes.fromhex(sys.stdin.read().strip())\nN = {0: "None", 1: "CRC32", 4: "CRC64", 10: "SHA-256"}\n' + fmt;
const XZ_OKFAIL = (okp, unk, bm, bc) => XZREF('if d[:6] != b"\\xfd7zXZ\\x00":\n    print(' + JSON.stringify(bm) + ')\nelif zlib.crc32(d[6:8]) != int.from_bytes(d[8:12], "little"):\n    print(' + JSON.stringify(bc) + ')\nelse:\n    t = d[7] & 15\n    print(' + JSON.stringify(okp) + ' + N[t] if t in N else ' + unk + ' % t)\n');
// BMP 8 位元：寬 1～7、高 1～5、k 色
const bmpGen = (b) => { const w = rnd(1, b ? 9 : 6), h = rnd(1, b ? 6 : 4), k = rnd(2, b ? 9 : 5); const pal = Array.from({ length: k }, () => hex(3)); const rows = Array.from({ length: h }, () => Array.from({ length: w }, () => rnd(0, k - 1)).join(' ')); return w + ' ' + h + ' ' + k + '\n' + pal.join(' ') + '\n' + rows.join('\n') + '\n'; };
const BMPREF = 'import sys, struct\nL = sys.stdin.read().split("\\n")\nw, h, k = map(int, L[0].split())\npal = L[1].split()\nrows = [list(map(int, L[2 + i].split())) for i in range(h)]\nstride = (w + 3) // 4 * 4\npix = b""\nfor r in reversed(rows):\n    pix += bytes(r) + bytes(stride - w)\nplt = b"".join(bytes([int(c[4:6], 16), int(c[2:4], 16), int(c[0:2], 16), 0]) for c in pal)\nhdr = b"BM" + struct.pack("<IHHI", 54 + len(plt) + len(pix), 0, 0, 54 + len(plt))\ndib = struct.pack("<IiiHHIIiiII", 40, w, h, 1, 8, 0, len(pix), 2835, 2835, k, 0)\nprint((hdr + dib + plt + pix).hex())\n';

H.main({ name: '領域包 binfmt', packs: [BF], seeds: H.loadSeeds(require('path').join(__dirname, 'seeds', 'domain_binfmt.json')), minSkeletons: 2, judge: { checker: 'tokens' } });
