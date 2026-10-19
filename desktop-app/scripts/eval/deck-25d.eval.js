// 2.5D 與素材工具（真實 Electron）：make_character_sprite／make_object_sprite／pixel_art 做出圖片，放進 depth: y 的村莊——人物走過樹後面再走到樹前面；tz 跳起來有影子。回傳關鍵時間點的 PNG。
if (typeof FaLlm !== 'undefined') { FaLlm.realFetch = null; }
const fa = window.fa; const R = {}; await fa._deckEnsureRuntime(); const Core = window.AiChatDeckCore; await window.AiChat2D.ensureJsYamlLoaded(); const yaml = window.jsyaml;
const call = async (name, a) => JSON.parse(await fa.tools[name].callback.call(fa, JSON.stringify(a)));
const bmpOf = async (j) => { const rec = await fa.fileCache.get(j.url.replace(/^client-file\//, '')); return createImageBitmap(rec.blob); };
const ch = await call('make_character_sprite', { preset: 'liu_bei', style: 'anime' }), tree = await call('make_object_sprite', { kind: 'tree' }), chest = await call('pixel_art', { template: 'chest' });
R.made = { ch: ch.ok, tree: tree.ok, chest: chest.ok, chest_preview: chest.preview, chest_size: chest.size };
R.pixel_err = await call('pixel_art', { palette: { a: '#ff0000' }, rows: ['aazz', 'aaaa', 'aaaa', 'aaaa'] });
R.pixel_custom = await call('pixel_art', { palette: { a: '#e63946', b: '#1d3557' }, size: [12, 12], ops: [{ op: 'circle', cx: 6, cy: 6, r: 4, c: 'a' }, { op: 'rect', x: 5, y: 5, w: 3, h: 3, c: 'b' }], shade: true, outline: true });
const imgs = [undefined, await bmpOf(tree), await bmpOf(chest), await bmpOf(ch)]; // 依項目順序（地圖、樹、箱子、人物）
const visual = { kind: 'collage', fullscreen: true, depth: 'y', items: [
  { src: 'map:village', enter: 'none', z: 0, at: 0 },
  { src: '@img2', tx: 6, ty: 3, tw: 1.8, pixel: true, enter: 'none', at: 0, z: 3 },
  { src: '@img3', tx: 9, ty: 5, tw: 1.2, pixel: true, enter: 'none', at: 0, z: 3 },
  { src: '@img1', sheet: { cols: 4, rows: 4, dirs: 'down,left,right,up', idle: 1 }, name: '劉備', tx: 6, ty: 1, tw: 1.4, pixel: true, enter: 'none', at: 0, z: 5, shadow: true,
    keys: [{ at: 4, sec: 4, tx: 6, ty: 6 }, { at: 6.5, sec: 0.4, tz: 1.2 }, { at: 7.2, sec: 0.4, tz: 0 }] }] };
const d = Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: '看。', visual }] }] }), yaml);
const slide = d.slides[0]; slide.index = 0; const timing = Core.timingFor(slide, 10, 0);
const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080; const ctx = cv.getContext('2d');
const info = { width: 1920, height: 1080, subtitles: false, assets: {}, preps: [{ visual: { images: imgs, portraits: [] }, timing }] };
R.frames = {}; for (const [k, t] of [['behind', 0.2], ['passing', 2.0], ['front', 4.5], ['jump', 6.9]]) { ctx.clearRect(0, 0, 1920, 1080); Core.drawSlide(ctx, d, slide, t, info); R.frames[k] = cv.toDataURL('image/png'); }
return R;
