// 遠端結果的檢視器（兩條路共用 _rgOpenSnap／_rgOpenItem）＋ 3D 視窗化／最大化／全螢幕（真實 Electron；遠端取檔用假的）
// 用法：FA_DEBUG_EVAL_FILE=scripts/eval/rg_view.eval.js xvfb-run -a node_modules/electron/dist/electron . --no-sandbox --use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader --user-data-dir=$(mktemp -d)
const fa = window.fa; const R = {}; const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms = 20000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { try { const v = f(); if (v) return v; } catch (_) { /* */ } await wait(60); } return null; };
const yaml3d = 'title: t\ncamera: { position: [3, 3, 5], look_at: [0, 0, 0] }\nnodes:\n  - { mesh: box, size: [1, 1, 1], position: [0, 0.5, 0], material: { color: "#e33" } }\n';
const files = {
  's.3dscene.yaml': ['text/yaml', yaml3d],
  'a.2danim.yaml': ['text/yaml', 'width: 320\nheight: 200\nduration: 2\nobjects:\n  - { id: a, shape: rect, x: 10, y: 10, w: 40, h: 40, fill: "#36c" }\n'],
  'd.csv': ['text/csv', 'a,b\n1,2\n3,4\n'], 'p.html': ['text/html', '<h1>hi</h1>'], 'x.png': ['image/png', 'x'],
};
fa._rgGetItemBlob = async (g, item) => { const f = files[item.name]; return { blob: new Blob([f[1]], { type: f[0] }), name: item.name, mime: f[0] }; };
const group = { nodeId: 'n1', machine: '測試機', viewer: true };
const open = async (name) => { await fa._rgOpenItem(group, { name, mime: files[name][0], kind: fa._rgFileKind(files[name][0], name), size: 10 }, () => {}, { cancelled: false }); };
const K = (n, m) => fa._rgViewKind(n, m);
R.kinds = { scene: K('a.3dscene.yaml'), anim: K('a.2danim.yaml'), viewer: K('x.viewer.yaml'), model: K('m.STL'), data: K('t.xlsx'), html: K('a.html'), editor: K('p.faedit.json'), deck: K('a.deck.yaml'), png: K('x.png', 'image/png') };
// ── 3D：浮動視窗、最大化、全螢幕、重設解析度
await open('s.3dscene.yaml'); const card = await until(() => document.querySelector('body > .fa-3d-card.fwin-pop')); R.float = { card: !!card };
const cv = card && await until(() => card.querySelector('canvas')); R.float.canvas = !!cv; await wait(600);
const btns = card ? [...card.querySelectorAll('button')].map((b) => b.textContent) : []; R.float.buttons = btns;
const w0 = cv && cv.width, h0 = cv && cv.height; card._fwin.maximize(true); await wait(500);
R.maximized = { is: card._fwin.isMaximized(), w_grew: cv.width > w0, h_grew: cv.height > h0, fills: Math.abs(cv.getBoundingClientRect().height - (window.innerHeight - 40)) < 80, w0, h0, w1: cv.width, h1: cv.height };
card._fwin.maximize(false); await wait(300);
let fsOk = null; try { await card._fwin.fullscreen(true); await wait(500); fsOk = card._fwin.isFullscreen(); await card._fwin.fullscreen(false); } catch (e) { fsOk = 'err:' + e.message; } R.fullscreen = { entered: fsOk };
const cvf = card.querySelector('canvas'); R.fullscreen.canvas_same = cvf === cv;
[...card.querySelectorAll('button')].find((b) => b.textContent === '✕').click(); await wait(100); R.closed = !document.querySelector('body > .fa-3d-card') && !document.querySelector('.fwin-ph');
// ── 2D 動畫、資料、HTML、圖片
await open('a.2danim.yaml'); R.anim2d = !!(await until(() => document.querySelector('body > .fa-3d-card canvas, body > .fa-3d-card svg')));
[...document.querySelectorAll('body > .fa-3d-card button')].filter((b) => b.textContent === '✕').forEach((b) => b.click());
await open('d.csv'); R.data = !!(await until(() => document.querySelector('body > .fa-3d-card table, body > .fa-3d-card .fdv, body > .fa-3d-card [class*=dv]'), 8000));
[...document.querySelectorAll('body > .fa-3d-card button')].filter((b) => b.textContent === '✕').forEach((b) => b.click());
await open('p.html'); await wait(500); R.html = !!document.querySelector('.fwin-host iframe, .fwin-host');
await open('x.png'); R.image_overlay = !!(await until(() => [...document.querySelectorAll('body > div')].some((d) => /x\.png/.test(d.textContent) && d.querySelector('img')), 4000));
console.log('RG_VIEW_RESULT ' + JSON.stringify(R));
return R;
