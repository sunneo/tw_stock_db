// 圖片轉PDF（images_to_pdf／_imagesToPdfAdvanced）的端到端檢查，真實 Electron：合成圖片 → 排序／A4 置中／旋轉／處理／資料夾／存檔／錯誤訊息／EXIF 方向。
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/images-to-pdf.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --user-data-dir=$(mktemp -d)
const fa = window.fa; const raw = window.desktopAPI.rawfs; const R = {}; const check = (k, v) => { R[k] = v; };
const mkImg = async (w, h, color, label, type = 'image/png', q) => { const c = document.createElement('canvas'); c.width = w; c.height = h; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, w, h); g.fillStyle = '#000'; g.fillRect(0, 0, Math.max(4, w / 10), Math.max(4, h / 10)); g.fillStyle = '#fff'; g.font = Math.floor(h / 4) + 'px sans-serif'; g.fillText(label, w / 4, h / 2); return await new Promise((r) => c.toBlob(r, type, q)); };
const put = async (name, blob) => await fa.fileCache.put(name, blob.type, blob, 'uploaded');
const names = ['12_c.png', '1_a.png', '10_b.png', '2_a.png', '3_a.png']; const dims = { '12_c.png': [300, 200], '1_a.png': [200, 300], '10_b.png': [400, 400], '2_a.png': [320, 180], '3_a.png': [180, 320] };
const ids = {}; for (const n of names) ids[n] = await put(n, await mkImg(dims[n][0], dims[n][1], '#3366cc', n.split('_')[0]));
const PL = async (bytes) => await PDFLib.PDFDocument.load(bytes);
const bytesOf = async (id) => new Uint8Array(await (await fa.fileCache.get(id)).blob.arrayBuffer());
// 1) 沒有 pages/files：附件候選（這裡用 files 全給＋sort:name）→ 數字自然順序
let r = await fa._imagesToPdfAdvanced({ files: names.map((n) => ids[n]), sort: 'name', page_size: 'a4' }); check('natural_order', r.ok && r.pages.map((p) => p.source));
let doc = await PL(await bytesOf(r.pdf_file_id)); const A4 = [595.28, 841.89]; check('page_count', doc.getPageCount());
check('a4_sizes', doc.getPages().map((p) => [Math.round(p.getWidth()), Math.round(p.getHeight())].join('x')));
// 2) 照給的順序（不排序）、直式強制
r = await fa._imagesToPdfAdvanced({ files: [ids['3_a.png'], ids['1_a.png']], page_size: 'a4', orientation: 'portrait' }); check('given_order', r.ok && r.pages.map((p) => p.source)); doc = await PL(await bytesOf(r.pdf_file_id)); check('portrait_sizes', doc.getPages().map((p) => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight())));
// 3) pages：每頁不同的旋轉／處理；回傳說明做了什麼
r = await fa._imagesToPdfAdvanced({ pages: [{ file: ids['1_a.png'], rotate: 90 }, { file: ids['2_a.png'], ops: [{ op: 'mosaic', block: 20 }, { op: 'grayscale' }] }, { file: ids['10_b.png'], scale: 50 }], ops: [{ op: 'enhance' }], page_size: 'a4', filename: 'x.pdf' });
check('pages_report', r.ok ? r.pages.map((p) => [p.source, p.input, p.output, p.ops.join('>'), p.format].join('|')) : r.error);
// 3b) cover：超出頁面的部分真的從圖片裁掉（不是靠剪裁路徑）——輸出的像素比例＝A4，PDF 只放看得到的那塊
r = await fa._imagesToPdfAdvanced({ files: [ids['12_c.png'], ids['1_a.png']], page_size: 'a4', orientation: 'portrait', fit: 'cover' }); check('cover', r.ok ? r.pages.map((p) => p.input + ' -> ' + p.output) : r.error);
if (r.ok) { const d = await PL(await bytesOf(r.pdf_file_id)); check('cover_pages', d.getPages().map((p) => Math.round(p.getWidth()) + 'x' + Math.round(p.getHeight()))); }
// 4) 處理結果的像素：灰階＋馬賽克＋旋轉
const dec = await fa._imgPdfDecode(await mkImg(40, 20, '#ff0000', 'x'), 0); const out1 = FaImgProc.run(dec, FaImgProc.normalizeOps([{ op: 'rotate', degrees: 90 }, 'grayscale']).ops).img; check('rotate_dims', [out1.width, out1.height]); check('gray_pixel', [out1.data[0], out1.data[1], out1.data[2]]);
// 5) 錯誤：未知處理、範圍、缺 file、未知頁面大小、找不到檔案——一次講完、不產生檔案
for (const [k, spec] of [['err_op', { files: [ids['1_a.png']], ops: [{ op: 'sparkle' }, { op: 'blur', radius: 9999 }] }], ['err_size', { files: [ids['1_a.png']], page_size: 'a9' }], ['err_nofile', { files: ['does-not-exist.png'] }], ['err_page', { pages: [{ rotate: 90 }] }]]) { const e = await fa._imagesToPdfAdvanced(spec); check(k, e.ok ? 'UNEXPECTED_OK' : String(e.error).slice(0, 160)); }
// 6) 資料夾＋存檔（絕對路徑）：桌面版
const base = '/tmp/claude-1001/-home-hungfu-lee----SRC-tw-stock-db/7a1df795-07d2-4983-9896-25a210dd410a/scratchpad/imgpdf-test';
try { await raw.remove(base, true); } catch (_) {} await raw.mkdir(base + '/in');
for (const [n, w, h] of [['10_x.png', 100, 200], ['2_x.png', 200, 100], ['1_x.png', 150, 150]]) { const b = await mkImg(w, h, '#cc6633', n); const u8 = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); await raw.writeFile(base + '/in/' + n, { base64: btoa(s) }); }
await raw.writeFile(base + '/in/readme.txt', { text: 'not an image' });
r = await fa._imagesToPdfAdvanced({ folder: base + '/in', page_size: 'a5', output_path: base + '/out/result.pdf', ops: [{ op: 'reduce_colors', colors: 4 }] }); check('folder', r.ok ? { order: r.pages.map((p) => p.source), fmt: r.pages.map((p) => p.format), saved_to: r.saved_to } : r.error);
try { const st = await raw.readFile(base + '/out/result.pdf', 'base64'); check('saved_header', atob(st.base64).slice(0, 5) + ' ' + st.sizeBytes); } catch (e) { check('saved_header', 'ERR ' + e.message); }
// 7) EXIF 方向 6（順時針轉 90）：手機照片不能橫倒
const jb = await mkImg(100, 50, '#22aa22', 'e', 'image/jpeg', 0.9); const ju = new Uint8Array(await jb.arrayBuffer()); const exif = new Uint8Array([0xFF, 0xE1, 0x00, 0x22, 0x45, 0x78, 0x69, 0x66, 0, 0, 0x4D, 0x4D, 0, 0x2A, 0, 0, 0, 8, 0, 1, 0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, 6, 0, 0, 0, 0, 0, 0]);
const withExif = new Uint8Array(ju.length + exif.length); withExif.set(ju.subarray(0, 2), 0); withExif.set(exif, 2); withExif.set(ju.subarray(2), 2 + exif.length);
const d2 = await fa._imgPdfDecode(new Blob([withExif], { type: 'image/jpeg' }), 0); check('exif_dims', [d2.width, d2.height]);
// 8) 工具本身（模型呼叫的那一層）
try { const def = fa._getToolDefinition('images_to_pdf', null); const res = JSON.parse(await def.callback.call(fa, JSON.stringify({ files: [ids['1_a.png']], ops: ['灰階'], page_size: 'a4' }))); check('tool', res.ok ? { pages: res.pageCount, ops: res.pages[0].ops } : res.error); } catch (e) { check('tool', 'ERR ' + e.message); }
return R;
