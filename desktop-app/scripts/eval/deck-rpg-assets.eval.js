// 使用者素材（真實 Electron 畫圖）：精靈圖（cols x rows，每一排是一個方向）＋頭像圖。假圖片：每個方向一種顏色，走路時依方向取那一排、站著用待機格，說話時對話框用使用者的頭像。
const fa = window.fa; const R = {}; await fa._deckEnsureRuntime(); const Core = window.AiChatDeckCore; await window.AiChat2D.ensureJsYamlLoaded(); const yaml = window.jsyaml;
const mkImg = (w, h, draw) => new Promise((res) => { const c = document.createElement('canvas'); c.width = w; c.height = h; draw(c.getContext('2d')); const im = new Image(); im.onload = () => res(im); im.src = c.toDataURL(); });
const ROWCOL = { down: '#E02020', left: '#20C020', right: '#2040E0', up: '#E0E020' }; const order = ['down', 'left', 'right', 'up'];
const sheetImg = await mkImg(256, 256, (g) => { order.forEach((d, r) => { for (let c = 0; c < 4; c++) { g.fillStyle = ROWCOL[d]; g.fillRect(c * 64, r * 64, 64, 64); g.fillStyle = '#000'; g.fillRect(c * 64 + 8 + c * 4, r * 64 + 8, 12, 48); } }); });
const portImg = await mkImg(100, 100, (g) => { g.fillStyle = '#FF00FF'; g.fillRect(0, 0, 100, 100); });
const visual = { kind: 'collage', fullscreen: true, spotlight: true, items: [
  { src: 'map:village', enter: 'none', z: 0, at: 0 },
  { src: '@img1', portrait: '@img2', name: '劉備', sheet: { cols: 4, rows: 4 }, tx: 3, ty: 5, tw: 1.6, enter: 'none', at: 0, z: 5,
    keys: [{ at: { sentence: 1, offset: 3 }, sec: 2, tx: 9, ty: 5 }, { at: { sentence: 1, offset: 5.2 }, sec: 1.5, tx: 9, ty: 3 }], say: [{ sentence: 2, text: '素材做的人物會走路，也有頭像。', style: 'box' }] }] };
const d = Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: '劉備走過去。劉備說話。', visual }] }] }), yaml);
const slide = d.slides[0]; slide.index = 0; const timing = Core.timingFor(slide, 14, 0); const S = timing.sentences.map((x) => x.start);
const cv = document.createElement('canvas'); cv.width = 1920; cv.height = 1080; const ctx = cv.getContext('2d', { willReadFrequently: true });
const info = { width: 1920, height: 1080, subtitles: false, assets: {}, preps: [{ visual: { images: [null, null].map(() => null).concat([]), portraits: [] }, timing }] }; info.preps[0].visual.images[1] = sheetImg; info.preps[0].visual.images[0] = null;
// the sprite is items[1]: images index 1; portraits index 1
info.preps[0].visual.images = [undefined, sheetImg]; info.preps[0].visual.portraits = [undefined, portImg];
const colorAt = (x, y) => { const p = ctx.getImageData(x, y, 1, 1).data; return [p[0], p[1], p[2]]; };
const near = (c, hex) => { const n = parseInt(hex.slice(1), 16), r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255; return Math.abs(c[0] - r) + Math.abs(c[1] - g) + Math.abs(c[2] - b) < 90; };
const T = 120; const feetOf = (tx, ty) => [(tx + 0.5) * T, (ty + 1) * T]; const probe = (tx, ty) => { const f = feetOf(tx, ty); return colorAt(Math.round(f[0] + 70), Math.round(f[1] - 60)); };
const frame = (t) => { ctx.clearRect(0, 0, 1920, 1080); Core.drawSlide(ctx, d, slide, t, info); };
// idle at the start: row "down" (red); walking right (blue); walking up (yellow); stopped after walking up still faces up
const t0 = S[0]; frame(t0 + 0.3); R.start_idle_down = near(probe(3, 5), ROWCOL.down);
frame(t0 + 2.0); R.walking_right_blue = (() => { for (let tx = 4; tx <= 9; tx += 0.25) { if (near(probe(tx, 5), ROWCOL.right)) return true; } return false; })();
frame(t0 + 4.5); R.walking_up_yellow = (() => { for (let ty = 3; ty <= 5; ty += 0.25) { if (near(probe(9, ty), ROWCOL.up)) return true; } return false; })();
frame(t0 + 6.5); R.stopped_faces_up = near(probe(9, 3), ROWCOL.up);
frame(S[1] + 2.5); let pFound = false; for (let x = 100; x < 400 && !pFound; x += 6) { for (let y = 760; y < 1040 && !pFound; y += 6) { if (near(colorAt(x, y), '#FF00FF')) pFound = true; } } R.user_portrait_in_box = pFound;
// validation of the new fields
const errs = (v) => { try { Core.parseDeck(yaml.dump({ deck: { title: 't', lang: 'zh-TW' }, chapters: [{ title: 'c', slides: [{ title: 's', layout: 'visual', narration: '一。二。', visual: v }] }] }), yaml); return []; } catch (e) { return [String(e.message).split('\n')[0]]; } };
R.bad_sheet = errs({ kind: 'collage', items: [{ src: '@img1', sheet: { cols: 0, rows: 4 } }] }); R.bad_dirs = errs({ kind: 'collage', items: [{ src: '@img1', sheet: { cols: 4, rows: 4, dirs: 'north,south' } }] });
return R;
