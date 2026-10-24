// node scripts/computer-tests/rfb_codec.test.js -- rfb-codec.js：DES、持續狀態的 inflate、ZRLE 磁磚
const zlib = require('zlib');
const C = require('../../rfb-codec.js');
const { suite } = require('./_t.js');
const t = suite('rfb-codec');
const hex = (h) => Buffer.from(h, 'hex');

t.check('DES 標準測試向量（133457799BBCDFF1 / 0123456789ABCDEF → 85E813540F0AB405）', C.desEncryptBlock(hex('133457799BBCDFF1'), hex('0123456789ABCDEF')).toString('hex') === '85e813540f0ab405');
t.check('DES 解密還原', C.desDecryptBlock(hex('133457799BBCDFF1'), hex('85E813540F0AB405')).toString('hex') === '0123456789abcdef');
t.check('DES 另一組向量（全零金鑰、全零明文 → 8CA64DE9C1B123A7）', C.desEncryptBlock(hex('0000000000000000'), hex('0000000000000000')).toString('hex') === '8ca64de9c1b123a7');
// 跟 OpenSSL 比對（如果這個 openssl 有開 legacy provider 才比）
try {
  const cr = require('crypto'); const key = hex('0123456789abcdef'); const c = cr.createCipheriv('des-ecb', key, null); c.setAutoPadding(false);
  const a = Buffer.concat([c.update(hex('1122334455667788')), c.final()]);
  t.check('跟 node crypto 的 des-ecb 一致', a.toString('hex') === C.desEncryptBlock(key, hex('1122334455667788')).toString('hex'));
} catch (_) { t.skip('跟 node crypto 的 des-ecb 比對', '這個 node/OpenSSL 沒有 DES（正是自己實作的原因）'); }
t.check('VNC 金鑰：補零並反轉位元（"a" = 0x61 → 0x86）', C.vncKey('a').toString('hex') === '8600000000000000' && C.vncKey('password12345').length === 8);
t.check('VNC 驗證回應：16 bytes、決定性、不同密碼不同結果', (() => { const ch = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex'); const a = C.vncAuthResponse(ch, 'secret'), b = C.vncAuthResponse(ch, 'secret'), c = C.vncAuthResponse(ch, 'Secret'); return a.length === 16 && a.equals(b) && !a.equals(c); })());
// 已知答案：RFB 規格範例的做法（password "password"，challenge 全 0x00 的第一區塊）由 DES 向量涵蓋；這裡驗證「加密再用同金鑰解密會還原 challenge」
t.check('VNC 驗證回應可用同一把 VNC 金鑰解回 challenge', (() => { const ch = Buffer.from('f0e1d2c3b4a5968778695a4b3c2d1e0f', 'hex'), r = C.vncAuthResponse(ch, 'hunter2'), k = C.vncKey('hunter2'); return Buffer.concat([C.desDecryptBlock(k, r.subarray(0, 8)), C.desDecryptBlock(k, r.subarray(8, 16))]).equals(ch); })());

// ---- Inflater：node 的串流 deflate 每次 Z_SYNC_FLUSH 一段，我們的 inflate 要能接續解出（跨段參照前面的視窗）
async function inflateRoundTrip(parts, level) {
  const d = zlib.createDeflate({ level: level == null ? 6 : level }); const chunks = [];
  const out = []; d.on('data', (c) => out.push(c));
  const segs = [];
  for (const p of parts) { out.length = 0; d.write(p); await new Promise((r) => d.flush(zlib.constants.Z_SYNC_FLUSH, r)); segs.push(Buffer.concat(out)); }
  d.destroy();
  const inf = new C.Inflater(); return segs.map((s) => inf.push(s));
}
(async () => {
  const lorem = Buffer.from('The quick brown fox jumps over the lazy dog. '.repeat(200) + '中文也要能壓縮。'.repeat(50));
  const rnd = Buffer.alloc(3000); let seed = 12345; for (let i = 0; i < rnd.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; rnd[i] = seed >> 16; }
  const parts = [lorem, Buffer.concat([lorem.subarray(100, 900), rnd, lorem.subarray(0, 500)]), Buffer.alloc(0), Buffer.alloc(70000, 7), lorem];
  await t.acheck('Inflater：多段 Z_SYNC_FLUSH 串流（含跨段參照、空段、隨機資料、長重複）', async () => { const res = await inflateRoundTrip(parts, 6); return res.every((r, i) => r.equals(parts[i])); });
  await t.acheck('Inflater：level 0（stored 區塊）與 level 9', async () => { const a = await inflateRoundTrip(parts.slice(0, 3), 0), b = await inflateRoundTrip(parts.slice(0, 3), 9); return a.every((r, i) => r.equals(parts[i])) && b.every((r, i) => r.equals(parts[i])); });
  await t.acheck('Inflater：固定 Huffman（很短的資料 node 會選固定表）', async () => { const res = await inflateRoundTrip([Buffer.from('abcabcabc'), Buffer.from('abcabcabcxyz')]); return res[0].toString() === 'abcabcabc' && res[1].toString() === 'abcabcabcxyz'; });
  await t.acheck('Inflater：壞資料丟例外', async () => { const inf = new C.Inflater(); try { inf.push(Buffer.from([0x78, 0x9c, 0xff, 0xff, 0xff])); return false; } catch (_) { return true; } });

  // ---- ZRLE：手工編碼各種磁磚，解碼後逐像素比對
  const W = 70, H = 70, fb = new Uint8Array(W * H * 4), want = new Uint8Array(W * H * 4);
  const setW = (x, y, c) => { const q = (y * W + x) * 4; want[q] = c[0]; want[q + 1] = c[1]; want[q + 2] = c[2]; want[q + 3] = 255; };
  const body = [];
  const col = (r, g, b) => [r, g, b];
  // 磁磚 (0,0) 64x64：solid（subenc 1）
  body.push(1, 10, 20, 30); for (let y = 0; y < 64; y++) for (let x = 0; x < 64; x++) setW(x, y, col(10, 20, 30));
  // 磁磚 (64,0) 6x64：raw（subenc 0）
  body.push(0); for (let y = 0; y < 64; y++) for (let x = 0; x < 6; x++) { const c = col(x * 40, y * 3, 99); body.push(...c); setW(64 + x, y, c); }
  // 磁磚 (0,64) 64x6：packed palette 4 色（subenc 4，2 bit/pixel，每列 byte 對齊）
  const pal4 = [col(255, 0, 0), col(0, 255, 0), col(0, 0, 255), col(255, 255, 0)]; body.push(4); for (const c of pal4) body.push(...c);
  for (let y = 0; y < 6; y++) { const row = []; for (let x = 0; x < 64; x++) row.push((x + y) % 4); for (let i = 0; i < 64; i += 4) body.push((row[i] << 6) | (row[i + 1] << 4) | (row[i + 2] << 2) | row[i + 3]); for (let x = 0; x < 64; x++) setW(x, 64 + y, pal4[row[x]]); }
  // 磁磚 (64,64) 6x6：plain RLE（subenc 128）：兩個 run，其中一個長度 > 255 不會出現；用 run=20 與 16
  body.push(128); body.push(1, 2, 3, 19); body.push(4, 5, 6, 15); for (let n = 0; n < 36; n++) setW(64 + (n % 6), 64 + Math.floor(n / 6), n < 20 ? col(1, 2, 3) : col(4, 5, 6));
  const data = Buffer.from(body); const used = C.decodeZrle(data, 0, 0, W, H, fb, W, 3);
  let same = true; for (let i = 0; i < fb.length; i++) if (fb[i] !== want[i]) { same = false; break; }
  t.check('ZRLE：solid／raw／packed palette／plain RLE 四種磁磚逐像素一致、資料剛好用完', same && used === data.length, { used, len: data.length });
  // palette RLE：單磁磚 8x2，palette 2 色（subenc 130），run 以 128|index 起頭、後面接長度
  const fb2 = new Uint8Array(8 * 2 * 4);
  const d2 = Buffer.from([130, 9, 9, 9, 200, 100, 50, /* idx0 一次 */ 0, /* idx1 run=5：128|1, len-1=4 */ 129, 4, /* idx0 x1 */ 0, /* idx1 x 9 */ 129, 8]);
  C.decodeZrle(d2, 0, 0, 8, 2, fb2, 8, 3);
  const px = (i) => [fb2[i * 4], fb2[i * 4 + 1], fb2[i * 4 + 2]].join(',');
  t.check('ZRLE：palette RLE', px(0) === '9,9,9' && px(1) === '200,100,50' && px(5) === '200,100,50' && px(6) === '9,9,9' && px(7) === '200,100,50' && px(15) === '200,100,50', [px(0), px(1), px(5), px(6), px(7), px(15)]);
  t.check('ZRLE：資料不足丟例外', (() => { try { C.decodeZrle(Buffer.from([0]), 0, 0, 4, 4, new Uint8Array(64), 4, 3); } catch (_) { return true; } return false; })());
  t.done();
})();
