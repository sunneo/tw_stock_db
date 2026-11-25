// node scripts/edit-tests/picture_import.test.js -- /edit-picture 📂 開啟圖片：副檔名、圖層、畫布大小、存放區注入、錯誤
// Node 16 沒有全域 Blob：測試用最小替身（只需要 type）
if (typeof Blob === 'undefined') { global.Blob = class { constructor(parts, o) { this.parts = parts; this.type = (o && o.type) || ''; } }; }
const P = require('../../renderer/src/edit/picture_import.js');
const C = require('../../renderer/src/edit/edit_picture_core.js');
let ok = 0; const bad = [];
function check(name, cond, extra) { if (cond) ok++; else bad.push(name + (extra !== undefined ? ' ' + JSON.stringify(extra).slice(0, 300) : '')); }
const bytes = new Uint8Array([137, 80, 78, 71]);

(async () => {
  check('mimeOf', P.mimeOf('a.PNG') === 'image/png' && P.mimeOf('b.jpg') === 'image/jpeg' && P.mimeOf('c.jpeg') === 'image/jpeg' && P.mimeOf('d.webp') === 'image/webp' && P.mimeOf('e.gif') === 'image/gif' && P.mimeOf('f.svg') === null && P.mimeOf('noext') === null);

  // 1. 有尺寸：畫布跟著圖走，第一個圖層是 image、ref 來自存放區
  const calls = [];
  const deps = { putImage: async (blob) => { calls.push(blob.type); return 'ref_abc123'; }, size: async () => ({ w: 640, h: 480 }) };
  const spec = await P.specFromImage(bytes, '貓.png', deps);
  check('存放區收到正確 mime', calls[0] === 'image/png', calls);
  check('畫布＝圖的尺寸', spec.canvas.w === 640 && spec.canvas.h === 480, spec.canvas);
  check('文件標題取檔名', spec.title === '貓', spec.title);
  const img = spec.objects.filter((o) => o.type === 'image');
  check('一個 image 圖層', img.length === 1 && img[0].ref === 'ref_abc123' && img[0].w === 640 && img[0].h === 480 && img[0].x === 0 && img[0].y === 0, spec.objects);
  check('文件通過驗證', C.validate(spec).problems.length === 0, C.validate(spec).problems);

  // 2. 量不到尺寸：預設 800×600
  const spec2 = await P.specFromImage(bytes, 'x.webp', { putImage: async () => 'ref_zz', size: async () => null });
  check('量不到就用 800×600', spec2.canvas.w === 800 && spec2.canvas.h === 600, spec2.canvas);
  // 3. 沒有 size 函式也行
  const spec3 = await P.specFromImage(bytes, 'y.gif', { putImage: async () => 'ref_yy' });
  check('沒有 size 依賴也能開', spec3.objects.some((o) => o.type === 'image' && o.ref === 'ref_yy'));

  // 4. 不支援的格式、沒有存放區：丟出可讀的錯誤
  let e1 = null; try { await P.specFromImage(bytes, 'a.svg', deps); } catch (e) { e1 = e; }
  check('svg 不走這裡', e1 && /png、jpg、gif、webp/.test(e1.message), e1 && e1.message);
  let e2 = null; try { await P.specFromImage(bytes, 'a.png', {}); } catch (e) { e2 = e; }
  check('沒有存放區丟錯', e2 && /存放區/.test(e2.message), e2 && e2.message);

  // 5. fromBytes 接受 ArrayBuffer 與 Uint8Array
  const s5 = await P.fromBytes(bytes.buffer, 'z.jpg', { putImage: async () => 'ref_jj', size: async () => ({ w: 64, h: 48 }) });
  check('fromBytes 接受 ArrayBuffer', s5.canvas.w === 64 && s5.canvas.h === 48, s5.canvas);

  console.log('picture_import: ' + ok + ' 通過，' + bad.length + ' 失敗');
  if (bad.length) { console.log(bad.join('\n')); process.exit(1); }
})().catch((e) => { console.error(e); process.exit(1); });
