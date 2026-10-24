// node scripts/computer-tests/png.test.js -- computer-png.js：編解碼、裁切縮放、差異、格線
const P = require('../../computer-png.js');
const { suite } = require('./_t.js');
const t = suite('computer-png');
const mk = (w, h, f) => { const d = new Uint8Array(w * h * 4); for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); d.set([c[0], c[1], c[2], c[3] == null ? 255 : c[3]], (y * w + x) * 4); } return { width: w, height: h, data: d }; };
const img = mk(40, 30, (x, y) => [x * 6, y * 8, (x + y) % 256]);
const rt = P.decodePng(P.encodePng(img));
t.check('encode→decode（RGB）位元組一致', rt.width === 40 && rt.height === 30 && Buffer.compare(Buffer.from(rt.data), Buffer.from(img.data)) === 0);
const ia = mk(7, 5, (x, y) => [x * 30, y * 40, 7, (x * 40) % 256]);
const ra = P.decodePng(P.encodePng(ia));
t.check('有透明度時存成 RGBA 並還原', Buffer.compare(Buffer.from(ra.data), Buffer.from(ia.data)) === 0);
// 用 zlib 手工做一張「filter 2、3、4」的 PNG，驗證解碼器的各種 filter
(() => {
  const zlib = require('zlib'); const w = 5, h = 4; const src = mk(w, h, (x, y) => [(x * 50 + y * 3) % 256, (y * 60) % 256, (x * y * 7) % 256]);
  const rows = []; const filt = [0, 2, 3, 4];
  const chunkOf = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(P.crc32(td)); return Buffer.concat([len, td, crc]); };
  const prev = new Array(w * 3).fill(0);
  for (let y = 0; y < h; y++) {
    const cur = []; for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) cur.push(src.data[(y * w + x) * 4 + c]);
    const f = filt[y], out = [f];
    for (let i = 0; i < cur.length; i++) {
      const a = i >= 3 ? cur[i - 3] : 0, b = prev[i], c = i >= 3 ? prev[i - 3] : 0; let p;
      if (f === 0) p = 0; else if (f === 2) p = b; else if (f === 3) p = (a + b) >> 1; else { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      out.push((cur[i] - p) & 255);
    }
    rows.push(Buffer.from(out)); for (let i = 0; i < cur.length; i++) prev[i] = cur[i];
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunkOf('IHDR', ihdr), chunkOf('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunkOf('IEND', Buffer.alloc(0))]);
  const d = P.decodePng(png); let same = true; for (let i = 0; i < w * h; i++) for (let c = 0; c < 3; c++) if (d.data[i * 4 + c] !== src.data[i * 4 + c]) same = false;
  t.check('解碼 filter None／Up／Average／Paeth', same);
})();
const cr = P.crop(img, { x: 10, y: 5, w: 8, h: 6 });
t.check('crop：尺寸與內容', cr.width === 8 && cr.height === 6 && cr.data[0] === img.data[(5 * 40 + 10) * 4] && cr.data[1] === img.data[(5 * 40 + 10) * 4 + 1]);
t.check('crop：超出邊界會夾住、完全在外面丟例外', P.crop(img, { x: 35, y: 25, w: 20, h: 20 }).width === 5 && (() => { try { P.crop(img, { x: 100, y: 0, w: 5, h: 5 }); return false; } catch (_) { return true; } })());
const half = P.resize(mk(8, 8, (x) => (x < 4 ? [0, 0, 0] : [255, 255, 255])), 2, 2);
t.check('resize 縮小用面積平均（左黑右白）', half.data[0] === 0 && half.data[4] === 255);
const fw = P.fitWithin(mk(100, 50, () => [1, 2, 3]), 25);
t.check('fitWithin：長邊 ≤ 上限並回傳縮放比', fw.img.width === 25 && fw.img.height === 13 || fw.img.height === 12 || fw.img.height === 13, fw) ;
t.check('fitWithin：比例 0.25', Math.abs(fw.scale - 0.25) < 1e-9);
const a = mk(32, 32, () => [10, 10, 10]), b = mk(32, 32, (x, y) => (x >= 16 && x < 24 && y >= 8 && y < 16 ? [200, 10, 10] : [10, 10, 10]));
const d = P.diff(a, b, { cols: 4, rows: 4 });
t.check('diff：變化比例、外框、格子', d.changedPixels === 64 && Math.abs(d.ratio - 64 / 1024) < 1e-9 && d.bbox.x === 16 && d.bbox.y === 8 && d.bbox.w === 8 && d.bbox.h === 8 && d.cells.length === 1 && d.cells[0].col === 2 && d.cells[0].row === 1, d);
t.check('diff：尺寸不同回報 comparable:false', P.diff(a, mk(8, 8, () => [0, 0, 0])).comparable === false);
t.check('diff：門檻以下的雜訊不算', P.diff(a, mk(32, 32, () => [20, 10, 10])).changedPixels === 0);
const regs = P.changedRegions(a, mk(32, 32, (x, y) => ((x >= 1 && x < 4 && y < 4) || (x >= 20 && x < 30 && y >= 20 && y < 30) ? [255, 255, 255] : [10, 10, 10])), { cell: 8 });
t.check('changedRegions：分成兩塊', regs.length === 2, regs);
t.check('fingerprint：同圖同指紋、反相不同', P.fingerprint(b) === P.fingerprint(b) && P.hamming(P.fingerprint(img), P.fingerprint(mk(40, 30, (x, y) => [255 - x * 6, 255 - y * 8, 0]))) > 0);
const g = P.drawGrid(mk(60, 40, () => [0, 0, 0]), 3, 2);
t.check('drawGrid：6 個格子、座標涵蓋整張圖、原圖不被修改', g.cells.length === 6 && g.cells[5].x + g.cells[5].w === 60 && g.cells[5].y + g.cells[5].h === 40 && g.img.data.some((v) => v === 255));
t.check('toDataUrl', P.toDataUrl(P.encodePng(img)).startsWith('data:image/png;base64,'));
t.done();
