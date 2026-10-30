// 遊戲的最終輸出:目標原始碼(設計見 DESIGN.edit-game.md §13)。兩種做法,誠實分開:
//   確定性輸出(程式產生,不叫模型,可以測):web(單檔 HTML,打包同一份試玩引擎,畫法與試玩一樣)、electron(視窗外殼＋同一份網頁)、nodejs(無頭模擬＋重播工具)、threejs(3D 的網頁版,three.js 畫)。
//   AI 逐檔產生(模型寫,程式只出題與驗形):sdl2、sdl3、qt、csharp-winforms、java-swing／awt／swt、android、python(pygame)、以及 fc／sfc／x68000／xbox／pc。
//     出給模型的題目＝遊戲的編譯結果(JSON)＋詞彙的白話語意＋模擬步驟順序＋「測試向量」(固定輸入重播,每 30 格的狀態摘要與最後狀態)＋這個目標的檔案清單與平台限制;
//     模型寫出來的碼沒有在這裡編譯執行過——輸出裡會附建置說明與測試向量,拿到平台上跑過才算數。FC 等舊機種先做「適配檢查」,超出限制的地方列出來,不假裝能放進去。
//   FaGameGen.targets(spec) -> [{ id, label, tier:'A'|'B'|'C', kind:'deterministic'|'ai', dim, note }]
//   FaGameGen.fitness(target, spec) -> { ok, problems:[], advice:[] }
//   FaGameGen.vectors(spec, { frames, every, script }) -> { frames:[held…], every, hashes:[…], checkpoints:[摘要…], final:{…}, status }(固定輸入的重播;hashes 只有 JS 引擎對得上,其他語言比 checkpoints:場景、狀態、變數、玩家位置)
//   FaGameGen.buildWeb(spec, { src, title, voices }) -> { files:[{path, content}], notes }      src = { vocab, sim, render2d, audio }(各模組的原始碼文字)
//   FaGameGen.build(targetId, spec, o) -> 同上(確定性的目標)           FaGameGen.aiPlan(targetId, spec, o) -> { system, files:[{path,purpose}], reference, user(fileIdx) }
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./game_core.js'), require('./game_sim.js'), require('./game_vocab.js')); else root.FaGameGen = factory((root.FaGame || (typeof FaGame !== 'undefined' ? FaGame : undefined)), (root.FaGameSim || (typeof FaGameSim !== 'undefined' ? FaGameSim : undefined)), (root.FaGameVocab || (typeof FaGameVocab !== 'undefined' ? FaGameVocab : undefined))); })(typeof self !== 'undefined' ? self : this, function (G, Sim, V) {
  'use strict';
  const safe = (s) => String(s || 'game').replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'game';
  const ident = (s) => String(s || 'game').replace(/[^A-Za-z0-9]+/g, '_').replace(/^(\d)/, '_$1').replace(/^_+|_+$/g, '') || 'game';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 放進 <script> 的字串:把會提早結束的 </script 與註解開頭換掉
  const inScript = (s) => String(s).replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');

  const TARGETS = [
    { id: 'web', label: '網頁版(單檔 HTML)', tier: 'A', kind: 'deterministic', dim: 'both', note: '同一份試玩引擎與畫法,雙擊就能玩;聲音也是程式合成的。' },
    { id: 'electron', label: 'Electron 程式', tier: 'A', kind: 'deterministic', dim: 'both', note: 'package.json＋main.js＋同一份網頁;npm install && npm start。' },
    { id: 'nodejs', label: 'Node.js(無頭模擬)', tier: 'A', kind: 'deterministic', dim: 'both', note: '沒有畫面:跑模擬、重播輸入、印文字畫面與狀態雜湊;拿來自動測試與當其他語言實作的對照。' },
    { id: 'threejs', label: 'three.js(3D 網頁)', tier: 'A', kind: 'deterministic', dim: '3d', note: '3D 遊戲的網頁版,用 three.js(從 CDN 載入)畫。' },
    { id: 'python', label: 'Python(pygame)', tier: 'A', kind: 'ai', dim: 'both', note: 'AI 逐檔移植;pygame 畫面。' },
    { id: 'sdl2', label: 'SDL2(C)', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;CMake;SDL2 畫面、輸入與聲音。' },
    { id: 'sdl3', label: 'SDL3(C)', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;SDL3 的新 API(SDL_Renderer、SDL_AudioStream)。' },
    { id: 'qt', label: 'Qt(C++)', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;QWidget／QPainter、QTimer 固定步長。' },
    { id: 'csharp-winforms', label: 'C# WinForms', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;Form＋雙緩衝 Panel、Timer。' },
    { id: 'java-swing', label: 'Java Swing', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;JPanel＋javax.swing.Timer。' },
    { id: 'java-awt', label: 'Java AWT', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;Canvas＋BufferStrategy。' },
    { id: 'java-swt', label: 'Java SWT', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;Canvas＋GC。' },
    { id: 'android', label: 'Android(Kotlin)', tier: 'B', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;SurfaceView＋Canvas、觸控。' },
    { id: 'pc', label: 'PC 執行檔(C++/SDL2,Windows)', tier: 'B', kind: 'ai', dim: '2d', note: '同 SDL2,加上 Windows 的 CMake／vcpkg 建置說明。' },
    { id: 'xbox', label: 'Xbox(C# MonoGame / UWP)', tier: 'C', kind: 'ai', dim: '2d', note: 'AI 逐檔移植;MonoGame。要上主機需要開發者模式與簽署,本輸出只到專案原始碼。' },
    { id: 'fc', label: 'FC／NES(6502,cc65)', tier: 'C', kind: 'ai', dim: '2d', note: 'AI 逐檔移植,先做適配檢查:256×240、8×8 圖塊、同畫面 64 個精靈(每行 8 個)、RAM 2KB。超出限制的地方會列出來。' },
    { id: 'sfc', label: 'SFC／SNES(65816,WLA-DX)', tier: 'C', kind: 'ai', dim: '2d', note: 'AI 逐檔移植,先做適配檢查:256×224、128 個精靈、RAM 128KB。' },
    { id: 'x68000', label: 'X68000(m68k,Human68k)', tier: 'C', kind: 'ai', dim: '2d', note: 'AI 逐檔移植(C／gcc-m68k 或 HAS 組合語言),先做適配檢查。' },
  ];
  function targets(spec) { const dim = spec && spec.game && spec.game.dimension === '3d' ? '3d' : '2d'; return TARGETS.filter((t) => t.dim === 'both' || t.dim === dim).map((t) => Object.assign({}, t)); }

  // ───── 適配檢查(舊機種:誠實列出放不下的地方) ─────
  const PROFILES = {
    fc: { name: 'FC／NES', w: 256, h: 240, tile: 8, spritesPerScreen: 64, spritesPerLine: 8, ram: 2048, maxScenes: 16, colors: 25, notes: ['背景與精靈各 4 組調色盤,每組 3 色＋共用背景色', '沒有浮點:位置與速度用 8.8 定點數', '聲音只有 5 個聲道(2 方波、1 三角、1 雜訊、1 DPCM);四條 bus 合併成一條'] },
    sfc: { name: 'SFC／SNES', w: 256, h: 224, tile: 8, spritesPerScreen: 128, spritesPerLine: 32, ram: 131072, maxScenes: 64, colors: 256, notes: ['定點數運算', 'BGM 要改寫成 SPC700 的格式'] },
    x68000: { name: 'X68000', w: 512, h: 512, tile: 16, spritesPerScreen: 128, spritesPerLine: 32, ram: 4194304, maxScenes: 64, colors: 65536, notes: ['精靈 16×16、最多 128 個', '聲音用 YM2151(FM)與 ADPCM;程式合成的 BGM 要改寫'] },
  };
  function fitness(target, spec) {
    const s = G.validate(spec).spec, P = PROFILES[target], out = { ok: true, problems: [], advice: [] };
    if (target === 'xbox' || target === 'pc' || !P) { if (s.game.dimension === '3d' && TARGETS.find((t) => t.id === target) && TARGETS.find((t) => t.id === target).dim === '2d') { out.ok = false; out.problems.push('這個目標只做 2D 遊戲'); } return out; }
    if (s.game.dimension === '3d') { out.ok = false; out.problems.push(P.name + ' 不做 3D 遊戲'); return out; }
    const view = s.game.view || { width: 320, height: 180 }; if (view.width > P.w || view.height > P.h) { out.problems.push('畫面 ' + view.width + '×' + view.height + ' 超過 ' + P.name + ' 的 ' + P.w + '×' + P.h); out.advice.push('把遊戲的解析度改成 ' + P.w + '×' + Math.min(P.h, 192) + ' 以內(說「把畫面改成 256×192」)'); }
    const scenes = G.of(s, 'scene'); if (scenes.length > P.maxScenes) { out.problems.push('場景有 ' + scenes.length + ' 個,超過 ' + P.maxScenes); }
    let maxObj = 0, maxPer = 0; scenes.forEach((sc) => { const kids = G.children(s, sc.id).filter((c) => c.type === 'object'); maxObj = Math.max(maxObj, kids.length); const rows = {}; kids.forEach((o) => { const pf = s.objects[G.byId(s, o.prefab)]; const hh = pf && pf.body ? (pf.body.h || (pf.body.r || 8) * 2) : 16; const y0 = Math.floor(o.at[1] / P.tile), y1 = Math.floor((o.at[1] + hh) / P.tile); for (let y = y0; y <= y1; y++) { rows[y] = (rows[y] || 0) + 1; } }); Object.keys(rows).forEach((k) => { maxPer = Math.max(maxPer, rows[k]); }); });
    if (maxObj > P.spritesPerScreen) { out.problems.push('一個場景最多有 ' + maxObj + ' 個物件,精靈上限 ' + P.spritesPerScreen); }
    if (maxPer > P.spritesPerLine) { out.advice.push('有同一橫排最多 ' + maxPer + ' 個物件,超過每行 ' + P.spritesPerLine + ' 個會閃爍;錯開高度或減少'); }
    const prefabs = G.of(s, 'prefab'); const colors = {}; prefabs.forEach((p) => { if (p.sprite && p.sprite.color) { colors[p.sprite.color] = 1; } }); if (Object.keys(colors).length > P.colors) { out.problems.push('用了 ' + Object.keys(colors).length + ' 種顏色,超過 ' + P.colors); }
    G.of(s, 'scene').forEach((sc) => { if (sc.tilemap && sc.tilemap.cell % P.tile !== 0) { out.advice.push('場景「' + sc.name + '」的磚塊大小 ' + sc.tilemap.cell + ' 不是 ' + P.tile + ' 的倍數,會被縮放'); } if (sc.tilemap && sc.tilemap.cols * sc.tilemap.rows * 1 > (P.ram === 2048 ? 2048 : 65536)) { out.advice.push('場景「' + sc.name + '」的磚塊地圖很大,要放進 ROM 並分段載入'); } });
    P.notes.forEach((n) => out.advice.push(n)); out.ok = out.problems.length === 0; return out;
  }

  // ───── 測試向量 ─────
  function defaultScript(spec, frames) {
    const s = G.validate(spec).spec, dim = s.game.dimension === '3d', out = [];
    for (let i = 0; i < frames; i++) { const h = {}; const ph = Math.floor(i / 45) % 4; if (dim) { h.up = ph === 0 || ph === 2; h.right = ph === 1; h.left = ph === 3; if (i % 90 === 40) { h.jump = true; } } else { h.right = ph !== 3; h.left = ph === 3; if (i % 50 === 20) { h.jump = true; h.up = true; } if (i % 70 === 35) { h.attack = true; } } out.push(h); }
    return out;
  }
  function vectors(spec, o) {
    o = o || {}; const s = G.validate(spec).spec, game = G.compile(s), frames = o.script || defaultScript(s, o.frames || 360), every = o.every || 30;
    const r = Sim.replay(game, frames, { seed: o.seed || 1, every }); const sim = Sim.create(game, { seed: o.seed || 1 }), checkpoints = []; for (let i = 0; i < frames.length; i++) { sim.step(frames[i] || {}); if (i % every === every - 1) { checkpoints.push(summary(sim.state)); } if (sim.state.status !== 'playing') { break; } }
    return { seed: o.seed || 1, every, dt: 1 / 60, frames, hashes: r.hashes, checkpoints, final: r.final, status: r.status };
  }
  // 一個遊戲狀態縮成一行可讀的摘要(不同語言的實作拿來比對:場景、狀態、玩家位置、變數)
  function summary(st) { const p = (st.entities || []).find((e) => (e.tags || []).indexOf('player') >= 0); return { scene: st.scene, status: st.status, tick: st.tick, vars: st.vars, player: p ? { pos: p.pos.map((x) => Math.round(x * 100) / 100), hp: p.hp } : null, alive: (st.entities || []).filter((e) => e.alive).length }; }

  // ───── 網頁版:單檔 HTML ─────
  const WEB_RUNTIME = String.raw`
(function () {
  var GAME = window.__GAME__, W = GAME.game.view.width, H = GAME.game.view.height, dim3 = GAME.game.dimension === '3d';
  var canvas = document.getElementById('c'), ctx = canvas.getContext('2d'), sim = FaGameSim.create(GAME, { seed: 1 });
  var down = {}, audio = null, actx = null, ptr = { down: false, x: 0, y: 0 }, running = true, acc = 0, last = performance.now();
  var input = {}; Object.keys(FaGameVocab.DEFAULT_INPUT).forEach(function (k) { input[k] = FaGameVocab.DEFAULT_INPUT[k]; }); Object.keys(GAME.game.input || {}).forEach(function (k) { input[k] = GAME.game.input[k]; });
  var mode = (GAME.game.interaction || {}).mode || 'keyboard';
  function fit() { var s = Math.max(1, Math.min(window.innerWidth / W, window.innerHeight / H)); canvas.width = Math.floor(W * s); canvas.height = Math.floor(H * s); }
  window.addEventListener('resize', fit); fit();
  function unlock() { if (audio || !window.FaGameAudio) { return; } try { var AC = window.AudioContext || window.webkitAudioContext; actx = new AC(); audio = FaGameAudio.createPlayer(actx, { buses: GAME.game.audio.buses, assets: GAME.assets, voiceProvider: window.__VOICES__ ? function (t, v, id) { var u = window.__VOICES__[id]; if (!u) { return null; } return fetch(u).then(function (r) { return r.arrayBuffer(); }).then(function (b) { return actx.decodeAudioData(b); }); } : null }); } catch (e) { audio = null; } if (audio) { audio.resume(); } }
  window.addEventListener('keydown', function (e) { unlock(); var k = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toLowerCase() : e.key); down[k] = true; if (/^Arrow| /.test(e.key)) { e.preventDefault(); } if ((k === 'r') && sim.state.status !== 'playing') { restart(); } });
  window.addEventListener('keyup', function (e) { var k = e.key === ' ' ? 'Space' : (e.key.length === 1 ? e.key.toLowerCase() : e.key); down[k] = false; });
  window.addEventListener('blur', function () { down = {}; running = false; hud('已暫停(點一下畫面繼續)'); });
  canvas.addEventListener('pointerdown', function (e) { unlock(); ptr.down = true; place(e); if (!running) { running = true; last = performance.now(); hud(''); } if (dim3) { canvas.focus(); } });
  canvas.addEventListener('pointermove', place); window.addEventListener('pointerup', function () { ptr.down = false; });
  function place(e) { var r = canvas.getBoundingClientRect(), cam = sim.state.camera || { x: 0, y: 0, w: W, h: H, zoom: 1 }; ptr.x = cam.x + (e.clientX - r.left) / r.width * (cam.w / (cam.zoom || 1)); ptr.y = cam.y + (e.clientY - r.top) / r.height * (cam.h / (cam.zoom || 1)); }
  var note = document.getElementById('note'); function hud(t) { note.textContent = t; note.style.display = t ? '' : 'none'; }
  function held() {
    var h = {}; Object.keys(input).forEach(function (a) { if ((input[a] || []).some(function (k) { return down[k]; })) { h[a] = true; } });
    if (mode === 'mouse' && ptr.down) { var p = sim.player(); if (p) { var dx = ptr.x - p.pos[0], dy = ptr.y - p.pos[1]; if (Math.abs(dx) > 6) { h[dx > 0 ? 'right' : 'left'] = true; } if (!dim3) { var sc = GAME.scenes[sim.state.scene] || {}; if (sc.gravity <= 0 && Math.abs(dy) > 6) { h[dy > 0 ? 'down' : 'up'] = true; } if (sc.gravity > 0 && dy < -24) { h.jump = true; } } } }
    return h;
  }
  function restart() { sim = FaGameSim.create(GAME, { seed: 1 }); window.FAGAME.sim = sim; if (audio) { audio.play({ kind: 'stop_all' }); } }
  function frame(ts) {
    requestAnimationFrame(frame); var dt = Math.min(100, ts - last); last = ts;
    if (running) { acc += dt / 1000; var n = 0; while (acc >= 1 / 60 && n++ < 5) { sim.step(held()); var a = sim.drainAudio(); if (audio) { a.forEach(function (x) { audio.play(x); }); } acc -= 1 / 60; } if (acc > 0.2) { acc = 0; } }
    if (window.__RENDER3D__) { window.__RENDER3D__(sim, canvas); } else { FaGameRender2d.draw(ctx, sim.state, GAME, { width: canvas.width, height: canvas.height, hud: true, time: ts / 1000, images: {} }); }
  }
  window.FAGAME = { sim: sim, GAME: GAME, step: function (h) { sim.step(h || {}); }, hash: function () { return sim.hash(); }, restart: restart };
  requestAnimationFrame(frame);
})();`;
  const THREE_RUNTIME = String.raw`
(function () {
  var GAME = window.__GAME__, canvas = document.getElementById('c'), r = new THREE.WebGLRenderer({ canvas: canvas, antialias: true }), scene = new THREE.Scene(), cam = new THREE.PerspectiveCamera(60, 1, 0.1, 500), map = {}, curScene = null;
  scene.add(new THREE.AmbientLight(0xffffff, 0.6)); var dl = new THREE.DirectionalLight(0xffffff, 0.9); dl.position.set(6, 10, 5); scene.add(dl);
  function meshGeo(a, sx, sy, sz) { var g = new THREE.BufferGeometry(), pos = []; a.vertices.forEach(function (v) { pos.push(v[0], v[1], v[2]); }); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex([].concat.apply([], a.faces)); g.computeVertexNormals(); g.computeBoundingBox(); var b = g.boundingBox; g.translate(-(b.min.x + b.max.x) / 2, -(b.min.y + b.max.y) / 2, -(b.min.z + b.max.z) / 2); g.scale(sx / Math.max(1e-6, b.max.x - b.min.x), sy / Math.max(1e-6, b.max.y - b.min.y), sz / Math.max(1e-6, b.max.z - b.min.z)); return g; }
  function mk(e, game) { var pf = game.prefabs[e.prefab] || {}, sp = pf.sprite || {}, col = new THREE.Color(/^#[0-9a-f]{6}$/i.test(e.color || sp.color) ? (e.color || sp.color) : '#4E79A7'), k = sp.kind, g, s = e.size; if (k === 'mesh' && sp.asset && game.assets && game.assets[sp.asset] && game.assets[sp.asset].vertices) { g = meshGeo(game.assets[sp.asset], s[0], s[1], s[2] || s[0]); } else if (k === 'sphere' || (pf.body && pf.body.shape === 'sphere')) { g = new THREE.SphereGeometry(Math.max(s[0], s[1]) / 2, 16, 12); } else if (k === 'cylinder' || k === 'capsule') { g = new THREE.CylinderGeometry(s[0] / 2, s[0] / 2, s[1], 16); } else if (k === 'cone') { g = new THREE.ConeGeometry(s[0] / 2, s[1], 16); } else { g = new THREE.BoxGeometry(s[0], s[1], s[2] || s[0]); } return new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: col, roughness: 0.7, transparent: !!e.trigger, opacity: e.trigger ? 0.6 : 1 })); }
  function load(sim) { while (scene.children.length > 2) { scene.remove(scene.children[2]); } map = {}; var sc = GAME.scenes[sim.state.scene] || {}; scene.background = new THREE.Color(sc.background || '#87a8d0'); if (sc.floor !== false) { var f = new THREE.Mesh(new THREE.BoxGeometry(sc.size[0], 0.2, sc.size[2]), new THREE.MeshStandardMaterial({ color: new THREE.Color(sc.floor_color || '#5d8a4a') })); f.position.y = -0.1; scene.add(f); } curScene = sim.state.scene; }
  var hudEl = document.getElementById('note');
  window.__RENDER3D__ = function (sim) {
    var w = canvas.clientWidth, h = canvas.clientHeight; if (canvas.width !== w || canvas.height !== h) { r.setSize(w, h, false); cam.aspect = w / h; cam.updateProjectionMatrix(); }
    if (curScene !== sim.state.scene) { load(sim); } var ids = {};
    sim.state.entities.forEach(function (e) { if (!e.alive) { return; } ids[e.id] = 1; if (!map[e.id]) { map[e.id] = mk(e, GAME); scene.add(map[e.id]); } var o = map[e.id]; o.visible = e.visible !== false; o.position.set(e.pos[0], e.pos[1], e.pos[2] || 0); o.rotation.y = e.yaw || 0; });
    Object.keys(map).forEach(function (id) { if (!ids[id]) { scene.remove(map[id]); delete map[id]; } });
    var c = sim.state.camera; if (c && c.pos) { cam.position.set(c.pos[0], c.pos[1], c.pos[2]); cam.lookAt(c.target[0], c.target[1], c.target[2]); }
    var v = sim.state.vars; hudEl.style.display = ''; hudEl.textContent = Object.keys(v).filter(function (k) { return typeof v[k] === 'number' && !/^item_/.test(k); }).map(function (k) { return k + ': ' + Math.round(v[k]); }).join('   ') + (sim.state.status === 'won' ? '   過關!(按 R 重來)' : sim.state.status === 'lost' ? '   失敗(按 R 重來)' : '');
    r.render(scene, cam);
  };
})();`;
  function buildWeb(spec, o) {
    o = o || {}; const s = G.validate(spec).spec, game = G.compile(s), src = o.src || {}, name = safe(s.game.title), dim3 = s.game.dimension === '3d', use3 = o.three || dim3;
    if (!src.vocab || !src.sim || (!use3 && !src.render2d)) { throw new Error('少了引擎的原始碼(vocab／sim' + (use3 ? '' : '／render2d') + ')'); }
    const vec = vectors(s, { frames: 240 }), voices = o.voices || null; const parts = [];
    parts.push('<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + esc(s.game.title) + '</title><style>html,body{margin:0;height:100%;background:#000;overflow:hidden}#c{display:block;margin:0 auto;outline:none;image-rendering:pixelated;max-width:100%;max-height:100%}#note{position:fixed;left:8px;top:8px;color:#fff;font:bold 14px system-ui,sans-serif;text-shadow:0 0 3px #000;pointer-events:none;display:none;white-space:pre}</style></head><body><canvas id="c" tabindex="0"></canvas><div id="note"></div>');
    if (use3) { parts.push('<script src="https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.min.js"></script>'); }
    parts.push('<script>window.__GAME__=' + inScript(JSON.stringify(game)) + ';window.__TESTVECTOR__=' + inScript(JSON.stringify({ every: vec.every, hashes: vec.hashes })) + ';' + (voices ? 'window.__VOICES__=' + inScript(JSON.stringify(voices)) + ';' : '') + '</script>');
    [src.vocab, src.sim].concat(use3 ? [] : [src.render2d]).concat(src.audio ? [src.audio] : []).forEach((code) => parts.push('<script>' + inScript(code) + '</script>'));
    if (use3) { parts.push('<script>' + inScript(THREE_RUNTIME) + '</script>'); }
    parts.push('<script>' + inScript(WEB_RUNTIME) + '</script></body></html>');
    const html = parts.join('\n');
    return { files: [{ path: name + '.html', content: html }], notes: ['單檔 HTML(' + Math.round(html.length / 1024) + ' KB),不用網路' + (use3 ? '(three.js 從 CDN 載入,第一次要連網)' : '') + ';按 R 重來。', '頁面上有 window.FAGAME(sim、step、hash),可以拿來自動測試。'], vector: vec };
  }
  function buildElectron(spec, o) {
    const w = buildWeb(spec, o), s = G.validate(spec).spec, name = safe(s.game.title), id = ident(s.game.title).toLowerCase() || 'game', view = s.game.view || { width: 640, height: 360 };
    const html = w.files[0].content;
    const pkg = { name: id, version: '1.0.0', description: s.game.title, main: 'main.js', scripts: { start: 'electron .' }, devDependencies: { electron: '^30.0.0' } };
    const main = "const { app, BrowserWindow } = require('electron');\nconst path = require('path');\nfunction create() {\n  const win = new BrowserWindow({ width: " + Math.min(1280, (view.width || 640) * 2) + ", height: " + Math.min(800, (view.height || 360) * 2) + ", title: " + JSON.stringify(s.game.title) + ", backgroundColor: '#000000', autoHideMenuBar: true, webPreferences: { contextIsolation: true } });\n  win.loadFile(path.join(__dirname, 'index.html'));\n}\napp.whenReady().then(create);\napp.on('window-all-closed', () => app.quit());\n";
    return { files: [{ path: name + '/package.json', content: JSON.stringify(pkg, null, 2) + '\n' }, { path: name + '/main.js', content: main }, { path: name + '/index.html', content: html }, { path: name + '/README.md', content: '# ' + s.game.title + '\n\n```\nnpm install\nnpm start\n```\n\n畫面與模擬是同一份引擎(index.html);按 R 重來。\n' }], notes: ['Electron 外殼＋同一份網頁。沒有在這裡執行過 npm install(需要網路)。'], vector: w.vector };
  }
  function buildNode(spec, o) {
    o = o || {}; const s = G.validate(spec).spec, game = G.compile(s), src = o.src || {}, name = safe(s.game.title); if (!src.vocab || !src.sim) { throw new Error('少了引擎的原始碼(vocab／sim)'); }
    const vec = vectors(s, { frames: 360 }); const cjs = (code, nm) => 'const ' + nm + ' = (function () { const module = { exports: {} }; const require = (p) => { if (/vocab/.test(p)) { return vocab; } throw new Error("no " + p); }; (function (module, exports, require) {\n' + code + '\n})(module, module.exports, require); return module.exports; })();\n';
    const run = "'use strict';\n// 無頭執行:node run.js [frames]  印每 30 格的狀態雜湊與最後狀態摘要;node run.js --check 對照 vectors.json\nconst fs = require('fs'), path = require('path');\nconst vocab = (function () { const module = { exports: {} }; (function (module, exports, require) {\n" + src.vocab + "\n})(module, module.exports, () => { throw new Error('no require'); }); return module.exports; })();\n"
      + "const sim = (function () { const module = { exports: {} }; (function (module, exports, require) {\n" + src.sim + "\n})(module, module.exports, (p) => { if (/vocab/.test(p)) { return vocab; } throw new Error('no ' + p); }); return module.exports; })();\n"
      + "const GAME = JSON.parse(fs.readFileSync(path.join(__dirname, 'game.json'), 'utf8'));\nconst VEC = JSON.parse(fs.readFileSync(path.join(__dirname, 'vectors.json'), 'utf8'));\n"
      + "if (process.argv.includes('--check')) { const r = sim.replay(GAME, VEC.frames, { seed: VEC.seed, every: VEC.every }); const ok = JSON.stringify(r.hashes) === JSON.stringify(VEC.hashes); console.log(ok ? '重播吻合 ' + r.hashes.length + ' 個雜湊' : '重播不吻合'); process.exit(ok ? 0 : 1); }\n"
      + "const n = Number(process.argv[2]) || 600, s = sim.create(GAME, { seed: 1 });\nfor (let i = 0; i < n; i++) { const phase = Math.floor(i / 45) % 4; s.step({ right: phase !== 3, left: phase === 3, jump: i % 50 === 20 }); if (i % 30 === 29) { console.log(i + 1, s.hash()); } if (s.state.status !== 'playing') { console.log('狀態', s.state.status, '在第', i + 1, '格'); break; } }\nconsole.log(JSON.stringify({ scene: s.state.scene, vars: s.state.vars, status: s.state.status }));\n";
    void cjs;
    return { files: [{ path: name + '/run.js', content: run }, { path: name + '/game.json', content: JSON.stringify(game) }, { path: name + '/vectors.json', content: JSON.stringify(vec) }, { path: name + '/README.md', content: '# ' + s.game.title + ' (Node.js 無頭模擬)\n\n```\nnode run.js          # 跑模擬並印出每 30 格的雜湊\nnode run.js --check  # 對照 vectors.json(固定輸入的重播)\n```\n\n沒有畫面;這份是「參考實作」:其他語言的移植版要得到同一串雜湊。\n' }], notes: ['沒有畫面的版本;--check 會重播固定輸入並比對雜湊。'], vector: vec };
  }
  function build(id, spec, o) { if (id === 'web') { return buildWeb(spec, o); } if (id === 'threejs') { return buildWeb(spec, Object.assign({}, o, { three: true })); } if (id === 'electron') { return buildElectron(spec, o); } if (id === 'nodejs') { return buildNode(spec, o); } throw new Error(id + ' 不是程式直接產生的目標(用 aiPlan)'); }

  // ───── AI 逐檔 ─────
  const PLANS = {
    python: { files: [['main.py', '入口:pygame 視窗、固定步長 1/60 的主迴圈、輸入對照、畫面'], ['sim.py', '模擬核心:實體、碰撞、規則引擎、狀態機、場景切換、對話'], ['render.py', '2D 畫法(或 3D 用 pygame 的簡易投影)'], ['game_data.py', '遊戲資料(把編譯結果的 JSON 轉成 Python 字典)'], ['requirements.txt', 'pygame'], ['README.md', '怎麼跑與已知限制']], lang: 'Python 3 + pygame' },
    sdl2: { files: [['CMakeLists.txt', 'CMake(find_package SDL2)'], ['src/main.c', '入口與固定步長主迴圈、輸入、畫面、SDL_mixer 或自己的混音'], ['src/sim.c', '模擬核心'], ['src/sim.h', '資料結構與公開函式'], ['src/data.c', '遊戲資料(陣列與常數)'], ['README.md', '建置與已知限制']], lang: 'C99 + SDL2' },
    sdl3: { files: [['CMakeLists.txt', 'CMake(find_package SDL3)'], ['src/main.c', '入口與固定步長主迴圈(SDL_AppIterate 或自己的迴圈)、輸入、SDL_Renderer 畫面、SDL_AudioStream'], ['src/sim.c', '模擬核心'], ['src/sim.h', '資料結構與公開函式'], ['src/data.c', '遊戲資料'], ['README.md', '建置與已知限制']], lang: 'C99 + SDL3' },
    pc: { files: [['CMakeLists.txt', 'CMake＋vcpkg(sdl2)'], ['src/main.cpp', '入口與主迴圈、輸入、畫面、聲音'], ['src/sim.cpp', '模擬核心'], ['src/sim.hpp', '資料結構與公開函式'], ['src/data.cpp', '遊戲資料'], ['README.md', 'Windows 的建置步驟(Visual Studio 或 cmake --preset)與已知限制']], lang: 'C++17 + SDL2(Windows)' },
    qt: { files: [['CMakeLists.txt', 'CMake(Qt6 Widgets)'], ['main.cpp', '入口'], ['GameWidget.h', 'QWidget:QPainter 畫面、QTimer 固定步長、鍵盤事件'], ['GameWidget.cpp', '同上的實作'], ['Sim.h', '模擬核心(資料結構)'], ['Sim.cpp', '模擬核心(實作)'], ['GameData.cpp', '遊戲資料'], ['README.md', '建置與已知限制']], lang: 'C++17 + Qt6 Widgets' },
    'csharp-winforms': { files: [['Game.csproj', '.NET 8 Windows 表單專案'], ['Program.cs', '入口'], ['GameForm.cs', 'Form:雙緩衝、Timer 固定步長、鍵盤、GDI+ 畫面'], ['Sim.cs', '模擬核心'], ['GameData.cs', '遊戲資料'], ['README.md', 'dotnet build／run 與已知限制']], lang: 'C# 12 / .NET 8 WinForms' },
    'java-swing': { files: [['Main.java', '入口:JFrame'], ['GamePanel.java', 'JPanel:paintComponent、javax.swing.Timer 固定步長、KeyListener'], ['Sim.java', '模擬核心'], ['GameData.java', '遊戲資料'], ['README.md', 'javac／java 指令與已知限制']], lang: 'Java 17 + Swing' },
    'java-awt': { files: [['Main.java', '入口:Frame＋Canvas＋BufferStrategy 主迴圈'], ['Sim.java', '模擬核心'], ['GameData.java', '遊戲資料'], ['README.md', '指令與已知限制']], lang: 'Java 17 + AWT' },
    'java-swt': { files: [['Main.java', '入口:Display／Shell／Canvas、PaintListener、display.timerExec 固定步長'], ['Sim.java', '模擬核心'], ['GameData.java', '遊戲資料'], ['pom.xml', 'Maven(SWT 依平台的 artifact)'], ['README.md', '指令與已知限制']], lang: 'Java 17 + SWT' },
    android: { files: [['app/build.gradle.kts', 'Gradle(Android 應用程式模組)'], ['app/src/main/AndroidManifest.xml', 'Manifest'], ['app/src/main/java/game/MainActivity.kt', 'Activity'], ['app/src/main/java/game/GameView.kt', 'SurfaceView:執行緒＋固定步長、Canvas 畫面、觸控(螢幕上的方向鍵與按鈕)'], ['app/src/main/java/game/Sim.kt', '模擬核心'], ['app/src/main/java/game/GameData.kt', '遊戲資料'], ['README.md', '建置與已知限制']], lang: 'Kotlin + Android SDK' },
    xbox: { files: [['Game.csproj', 'MonoGame(DesktopGL 或 WindowsDX)專案'], ['Program.cs', '入口'], ['Game1.cs', 'MonoGame Game 類別:固定步長 Update、SpriteBatch 畫面、GamePad／鍵盤輸入'], ['Sim.cs', '模擬核心'], ['GameData.cs', '遊戲資料'], ['README.md', '建置、在 Xbox 開發者模式部署的步驟與已知限制']], lang: 'C# + MonoGame' },
    fc: { files: [['nes.cfg', 'ld65 設定(NROM-256:32KB PRG＋8KB CHR)'], ['main.s', 'ca65:重置、NMI、主迴圈、讀手把、輸入對照'], ['sim.c', 'cc65 的 C:模擬核心(8.8 定點數;實體表用結構陣列;規則表展開成資料)'], ['data.c', '關卡資料(圖塊地圖、物件表、規則表)'], ['chr.s', '圖形資料(8×8 圖塊,從遊戲的像素圖轉出;沒有像素圖的原型用純色方塊)'], ['Makefile', 'cc65 建置'], ['README.md', '建置、放不下而被削掉的東西與已知限制']], lang: '6502 組合語言 + C(cc65)' },
    sfc: { files: [['main.asm', 'WLA-DX 65816:初始化、NMI、主迴圈、手把'], ['sim.asm', '模擬核心(定點數)'], ['data.asm', '關卡資料'], ['hdr.inc', 'ROM 標頭'], ['Makefile', 'WLA-DX 建置'], ['README.md', '建置、削掉的東西與已知限制']], lang: '65816 組合語言(WLA-DX)' },
    x68000: { files: [['main.c', 'gcc(m68k-human68k)＋XC 函式庫:顯示模式、精靈、搖桿／鍵盤、固定步長'], ['sim.c', '模擬核心(整數／定點數)'], ['data.c', '關卡資料'], ['Makefile', '建置'], ['README.md', '建置、削掉的東西與已知限制']], lang: 'C(gcc m68k, XC library)' },
  };
  const SIM_NOTES = '模擬步驟的順序(每一格 dt=1/60 秒):1. 讀輸入(算出剛按下／剛放開)→ 2. 控制器(玩家與敵人的移動意圖:走、跳、巡邏、追擊、路線)→ 3. 狀態機的 tick 事件與計時器 → 4. 整合速度與重力 → 5. 碰撞:先 x 軸再 y 軸(3D 還有 z),實心擋住、單向平台只從上面擋、觸發器只發事件 → 6. 發出 collide／enter_zone／exit_zone 事件 → 7. 規則(事件→條件→動作),動作可以再發訊息(同一格內處理,上限 40 個事件)→ 8. 相機 → 9. 場景切換(下一格開始)。亂數:自己的 xorshift,種子 1,不用系統亂數。座標 2D y 向下、3D y 向上;位置是盒子中心。';
  function aiPlan(id, spec, o) {
    o = o || {}; const P = PLANS[id]; if (!P) { throw new Error('不認得的目標 ' + id); } const s = G.validate(spec).spec, game = G.compile(s), t = TARGETS.find((x) => x.id === id) || {}, fit = fitness(id, s);
    const vec = vectors(s, { frames: 360 }); const cap = (str, n) => (str.length > n ? str.slice(0, n) + '…(已截短)' : str);
    const reference = { game: JSON.stringify(game), vocab: V.vocabText ? V.vocabText() : '', sim_notes: SIM_NOTES, vector: { seed: vec.seed, every: vec.every, script: vec.frames.length + ' 格:' + 'phase=floor(i/45)%4;2D 時 right=(phase!=3), left=(phase==3), i%50==20 時 jump+up, i%70==35 時 attack;3D 時 up=phase 0 或 2、right=phase 1、left=phase 3、i%90==40 時 jump', checkpoints: vec.checkpoints, final: summary(vec.final) } };
    const system = '你是遊戲移植工程師。把下面這個「已經能玩」的遊戲(JSON 描述＋JS 參考模擬)移植成 ' + P.lang + ' 專案(' + (t.label || id) + ')。規則:1. 一次只寫一個檔案,只輸出檔案內容本身(不要 Markdown 圍欄、不要說明);2. 行為要跟參考一致:同樣的輸入序列要得到同樣的狀態(測試向量每 ' + vec.every + ' 格有一個狀態摘要:場景、狀態、變數、玩家位置、活著的實體數;位置允許 ±1 像素(3D ±0.05)的誤差,變數與場景必須完全一樣);3. 資料用 JSON 描述裡的數字,不要自己改數值;4. 沒有實作的功能要寫在 README 的「已知限制」,不要假裝有;5. 不要用外部的非標準函式庫(除了該目標的平台函式庫);6. 程式要能編譯,不確定的 API 用最保守的寫法並在註解標明。'
      + (fit.problems.length ? ' 這個平台放不下:' + fit.problems.join(';') + '。' : '') + (fit.advice.length ? ' 平台提醒:' + fit.advice.join(';') + '。' : '');
    const files = P.files.map((f) => ({ path: f[0], purpose: f[1] }));
    function user(i, done) {
      const f = files[i]; return '遊戲:' + s.game.title + '(' + s.game.dimension + ',' + (s.game.view ? s.game.view.width + '×' + s.game.view.height : '') + ')\n\n【檔案清單】\n' + files.map((x, k) => (k + 1) + '. ' + x.path + ' — ' + x.purpose).join('\n') + '\n\n【現在要寫】第 ' + (i + 1) + ' 個:' + f.path + '(' + f.purpose + ')\n\n【遊戲資料(編譯後的 JSON)】\n' + cap(reference.game, o.maxGame || 60000) + '\n\n【詞彙的白話語意(事件、條件、動作、控制器的意思)】\n' + cap(reference.vocab, 12000) + '\n\n【模擬的步驟順序】\n' + SIM_NOTES + '\n\n【測試向量】\n' + JSON.stringify(reference.vector) + (o.simSource ? '\n\n【JS 參考模擬(節錄)】\n' + cap(o.simSource, o.maxSim || 40000) : '') + (done && done.length ? '\n\n【已經寫好的檔案(只看介面,別重寫)】\n' + done.map((d) => '--- ' + d.path + ' ---\n' + cap(d.content, 3500)).join('\n') : '') + '\n\n只輸出 ' + f.path + ' 的完整內容。';
    }
    return { id, label: t.label || id, tier: t.tier, lang: P.lang, system, files, reference, user, fitness: fit };
  }
  // 模型的輸出清理:去掉 Markdown 圍欄與前後的客套話
  function cleanFile(text) { let t = String(text || '').replace(/\r\n/g, '\n'); const m = /```[A-Za-z0-9_+#.-]*\n([\s\S]*?)```/.exec(t); if (m) { t = m[1]; } return t.replace(/^\s*\n+/, '').replace(/\s+$/, '') + '\n'; }
  // 逐檔產生:ask(system, user) -> Promise<text>
  async function aiBuild(id, spec, o, ask, onStatus) {
    const plan = aiPlan(id, spec, o), done = [], notes = []; if (!plan.fitness.ok && PROFILES[id]) { notes.push('適配檢查:' + plan.fitness.problems.join(';')); }
    for (let i = 0; i < plan.files.length; i++) { if (onStatus) { onStatus('(' + (i + 1) + '/' + plan.files.length + ') ' + plan.files[i].path); } const raw = await ask(plan.system, plan.user(i, done)); const content = cleanFile(raw); if (content.trim().length < 5) { notes.push(plan.files[i].path + ' 產生的內容是空的'); } done.push({ path: plan.files[i].path, content }); }
    const name = safe(spec.game ? spec.game.title : 'game'); done.push({ path: 'TESTVECTOR.json', content: JSON.stringify({ seed: plan.reference.vector.seed, every: plan.reference.vector.every, script: plan.reference.vector.script, checkpoints: plan.reference.vector.checkpoints, final: plan.reference.vector.final }, null, 2) + '\n' }); done.push({ path: 'GAME.json', content: plan.reference.game + '\n' });
    notes.push('這些程式是 AI 寫的,沒有在這裡編譯或執行過;到目標平台上建置,對照 TESTVECTOR.json 的 checkpoints(場景、變數、玩家位置),才算移植正確。');
    return { files: done.map((f) => ({ path: name + '_' + id + '/' + f.path, content: f.content })), notes, fitness: plan.fitness };
  }
  return { targets, TARGETS, PROFILES, fitness, vectors, summary, defaultScript, buildWeb, build, aiPlan, aiBuild, cleanFile, SIM_NOTES, safe };
});
