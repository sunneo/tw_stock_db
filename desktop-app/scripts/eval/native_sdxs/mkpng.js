// 用法：ELECTRON_RUN_AS_NODE=1 electron mkpng.js <local_sd.js> <pair 資料夾> <輸出資料夾> <名稱>
// 讀 img_native.bin／img_wasm.bin（[1,3,512,512] CHW），用 FaLocalSd.toRgba 轉 RGBA，輸出 <名稱>-native.png、-web.png、-side.png（左原生、右網頁版）
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [, , SDP, DIR, OUT, NAME] = process.argv; const SD = require(SDP); fs.mkdirSync(OUT, { recursive: true });
const rd = (n) => { const b = fs.readFileSync(path.join(DIR, n)); return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength)); };
const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
const png = (rgba, w, h) => { const raw = Buffer.alloc((w * 4 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1); } const ih = Buffer.alloc(13); ih.writeUInt32BE(w, 0); ih.writeUInt32BE(h, 4); ih[8] = 8; ih[9] = 6; return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]); };
const S = 512, a = SD.toRgba(rd('img_native.bin'), S, S), b = SD.toRgba(rd('img_wasm.bin'), S, S);
fs.writeFileSync(path.join(OUT, NAME + '-native.png'), png(a, S, S)); fs.writeFileSync(path.join(OUT, NAME + '-web.png'), png(b, S, S));
const side = new Uint8ClampedArray(S * 2 * S * 4 + 0); const W = S * 2 + 8; const sd = new Uint8ClampedArray(W * S * 4).fill(255);
for (let y = 0; y < S; y++) { sd.set(a.subarray(y * S * 4, (y + 1) * S * 4), y * W * 4); sd.set(b.subarray(y * S * 4, (y + 1) * S * 4), (y * W + S + 8) * 4); }
fs.writeFileSync(path.join(OUT, NAME + '-side.png'), png(sd, W, S)); console.log('ok', NAME);
