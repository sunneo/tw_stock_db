// 點陣精靈（真實 Electron）：make_object_sprite 用既有 CPU 光柵＋雙背景去背，每一種物件都要畫得出來、32x48（房子 64x48）、顏色數在範圍內、有透明背景。回傳 PNG 的 data URL 供目視檢查。
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const fa = window.fa; const R = { kinds: {} }; await fa._deckEnsureRuntime();
const toUrl = (blob) => new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
const info = async (blob) => { const bmp = await createImageBitmap(blob); const c = document.createElement('canvas'); c.width = bmp.width; c.height = bmp.height; const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(bmp, 0, 0); const d = g.getImageData(0, 0, c.width, c.height).data; let tr = 0, op = 0, semi = 0; const cols = new Set(); for (let i = 0; i < d.length; i += 4) { if (d[i + 3] === 0) tr++; else if (d[i + 3] === 255) { op++; cols.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]); } else semi++; } return { w: c.width, h: c.height, transparent: tr, opaque: op, semi, colors: cols.size }; };
const t0 = Date.now();
for (const kind of ['tree', 'pine', 'house', 'table', 'chest', 'rock', 'well']) {
  const r = await fa.tools.make_object_sprite.callback.call(fa, JSON.stringify({ kind })); const j = typeof r === 'string' ? JSON.parse(r) : r;
  if (!j.ok) { R.kinds[kind] = { error: j.error }; continue; }
  const rec = await fa.fileCache.get(j.url.replace(/^client-file\//, '')); R.kinds[kind] = Object.assign({ ref: j.ref, frame: j.frame }, await info(rec.blob)); R.kinds[kind].png = await toUrl(rec.blob);
}
R.variants = {}; for (const a of [{ kind: 'tree', color: 'autumn' }, { kind: 'tree', color: 'pink' }, { kind: 'house', wall: 'brick', roof: 'blue' }, { kind: 'chest', color: 'blue' }]) { const j = JSON.parse(await fa.tools.make_object_sprite.callback.call(fa, JSON.stringify(a))); const rec = j.ok ? await fa.fileCache.get(j.url.replace(/^client-file\//, '')) : null; R.variants[a.kind + ':' + (a.color || a.wall)] = j.ok ? await toUrl(rec.blob) : { error: j.error }; }
R.bad_kind = JSON.parse(await fa.tools.make_object_sprite.callback.call(fa, JSON.stringify({ kind: 'dragon' })));
R.ms = Date.now() - t0;
return R;
