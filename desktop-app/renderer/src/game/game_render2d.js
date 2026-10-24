// 2D 遊戲的畫法(Canvas 2D;編輯器的畫面、試玩、匯出的 web 版共用這一份,所以三邊長得一樣)。
//   FaGameRender2d.draw(ctx, state, game, opts)       state = FaGameSim 的 state(試玩中,或編輯時用 create() 還沒 step 的狀態)
//   opts: { width, height(畫布像素), debug(顯示碰撞盒、區域、路線), grid, images:{素材 id: 圖}, selection:[ids], focus:{rect, ids}, flash(閃動用的時間), hud:true, time }
//   FaGameRender2d.worldToScreen(state, opts, x, y) / screenToWorld(state, opts, sx, sy)   座標換算(編輯器點選、拖曳要用)
(function (root, factory) { if (typeof module === 'object' && module.exports) module.exports = factory(require('./game_vocab.js')); else root.FaGameRender2d = factory((root.FaGameVocab || (typeof FaGameVocab !== 'undefined' ? FaGameVocab : undefined))); })(typeof self !== 'undefined' ? self : this, function (V) {
  'use strict';
  const FONT = '"Microsoft JhengHei","Noto Sans CJK TC","PingFang TC",system-ui,sans-serif';
  const T36 = '0123456789abcdefghijklmnopqrstuvwxyz';
  function view(state, opts) {
    const cam = state.camera || { x: 0, y: 0, w: opts.width, h: opts.height, zoom: 1 }; const zoom = cam.zoom || 1;
    const sx = opts.width / (cam.w / zoom), sy = opts.height / (cam.h / zoom), s = Math.min(sx, sy);
    const vw = opts.width / s, vh = opts.height / s; const ox = (opts.width - cam.w / zoom * s) / 2, oy = (opts.height - cam.h / zoom * s) / 2;
    return { cam, s, ox, oy, x: cam.x, y: cam.y, vw, vh };
  }
  function worldToScreen(state, opts, x, y) { const v = view(state, opts); return [v.ox + (x - v.x) * v.s, v.oy + (y - v.y) * v.s]; }
  function screenToWorld(state, opts, sx, sy) { const v = view(state, opts); return [(sx - v.ox) / v.s + v.x, (sy - v.oy) / v.s + v.y]; }
  function tileProps(state, id) { const ts = V.TILESETS[(state.tiles && state.tiles.tileset) || 'basic'] || V.TILESETS.basic; return ts.tiles[id] || {}; }
  function drawTiles(ctx, state, v, opts) {
    const t = state.tiles; if (!t) { return; } const cell = t.cell, c0 = Math.max(0, Math.floor(v.x / cell)), c1 = Math.min(t.cols - 1, Math.floor((v.x + opts.width / v.s) / cell)), r0 = Math.max(0, Math.floor(v.y / cell)), r1 = Math.min(t.rows - 1, Math.floor((v.y + opts.height / v.s) / cell));
    for (let r = r0; r <= r1; r++) { for (let c = c0; c <= c1; c++) { const id = T36.indexOf(t.data[r].charAt(c)); if (id <= 0) { continue; } const p = tileProps(state, id); if (!p.color) { continue; } ctx.fillStyle = p.color; const th = p.thin ? Math.max(3, cell / 4) : cell; ctx.fillRect(c * cell, r * cell, cell + 0.5, th + 0.5); if (p.top && (r === 0 || T36.indexOf(t.data[r - 1].charAt(c)) <= 0)) { ctx.fillStyle = p.top; ctx.fillRect(c * cell, r * cell, cell + 0.5, Math.max(2, cell / 5)); } if (p.glyph) { ctx.fillStyle = '#fff'; ctx.font = Math.floor(cell * 0.8) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(p.glyph, c * cell + cell / 2, r * cell + cell / 2); } } }
  }
  function pixelsDraw(ctx, px, w, h) { const rows = px.rows, n = rows.length, m = Math.max.apply(null, rows.map((r) => r.length)) || 1, cw = w / m, ch = h / n; for (let y = 0; y < n; y++) { for (let x = 0; x < rows[y].length; x++) { const k = T36.indexOf(rows[y].charAt(x).toLowerCase()); if (k < 0 || !px.palette[k]) { continue; } ctx.fillStyle = px.palette[k]; ctx.fillRect(-w / 2 + x * cw, -h / 2 + y * ch, cw + 0.4, ch + 0.4); } } }
  function drawEntity(ctx, e, spr, opts, state) {
    if (!e.visible || !e.alive) { return; } if (e.invuln > 0 && Math.floor((opts.time || 0) * 14) % 2 === 0 && e.tags.indexOf('player') >= 0) { return; }
    const w = e.size[0], h = e.size[1], color = e.color || (spr && spr.color) || '#4E79A7'; ctx.save(); ctx.translate(e.pos[0], e.pos[1]); if (e.facing < 0 || e.flip && e.facing >= 0 && false) { ctx.scale(-1, 1); } if (spr && spr.alpha != null) { ctx.globalAlpha = spr.alpha; }
    const kind = spr ? spr.kind : 'rect';
    if (kind === 'pixels' && spr.pixels) { pixelsDraw(ctx, spr.pixels, w, h); }
    else if (kind === 'image' && spr.asset && opts.images && opts.images[spr.asset]) { try { ctx.drawImage(opts.images[spr.asset], -w / 2, -h / 2, w, h); } catch (x) { /* 圖還沒好 */ } }
    else {
      if (kind === 'circle' || e.shape === 'circle') { ctx.fillStyle = color; ctx.beginPath(); ctx.arc(0, 0, Math.max(w, h) / 2, 0, Math.PI * 2); ctx.fill(); if (spr && spr.outline) { ctx.strokeStyle = spr.outline; ctx.lineWidth = 1; ctx.stroke(); } }
      else if (!(spr && spr.emoji && kind !== 'rect')) { ctx.fillStyle = color; ctx.fillRect(-w / 2, -h / 2, w, h); if (spr && spr.outline) { ctx.strokeStyle = spr.outline; ctx.lineWidth = 1; ctx.strokeRect(-w / 2, -h / 2, w, h); } }
      else { ctx.fillStyle = color; ctx.fillRect(-w / 2, -h / 2, w, h); }
      if (spr && spr.emoji) { ctx.scale(e.facing < 0 ? -1 : 1, 1); ctx.scale(e.facing < 0 ? 1 : 1, 1); ctx.font = Math.floor(Math.min(Math.max(w, h) * 0.95, 64)) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = '#fff'; ctx.fillText(spr.emoji, 0, 1); }
      else if (spr && spr.label) { ctx.fillStyle = '#fff'; ctx.font = 'bold ' + Math.floor(Math.min(w, h) * 0.7) + 'px ' + FONT; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(spr.label, 0, 1); }
    }
    ctx.restore();
    if (e.hud && e.maxHp > 0) { const bw = Math.max(18, w + 6), x = e.pos[0] - bw / 2, y = e.pos[1] - h / 2 - 6; ctx.fillStyle = '#000a'; ctx.fillRect(x - 1, y - 1, bw + 2, 5); ctx.fillStyle = e.hp / e.maxHp > 0.35 ? '#4caf50' : '#e53935'; ctx.fillRect(x, y, bw * Math.max(0, e.hp) / e.maxHp, 3); }
  }
  function drawOverlays(ctx, state, game, v, opts) {
    const sc = game.scenes[state.scene]; if (!sc) { return; }
    if (opts.grid && state.tiles) { ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 1 / v.s; const t = state.tiles; ctx.beginPath(); for (let c = 0; c <= t.cols; c++) { ctx.moveTo(c * t.cell, 0); ctx.lineTo(c * t.cell, t.rows * t.cell); } for (let r = 0; r <= t.rows; r++) { ctx.moveTo(0, r * t.cell); ctx.lineTo(t.cols * t.cell, r * t.cell); } ctx.stroke(); }
    if (opts.debug) {
      ctx.lineWidth = 1 / v.s; (sc.zones || []).forEach((z) => { ctx.strokeStyle = '#ff9800'; ctx.fillStyle = 'rgba(255,152,0,.12)'; ctx.fillRect(z.rect[0], z.rect[1], z.rect[2], z.rect[3]); ctx.strokeRect(z.rect[0], z.rect[1], z.rect[2], z.rect[3]); });
      Object.keys(sc.paths || {}).forEach((id) => { const p = sc.paths[id]; ctx.strokeStyle = '#00bcd4'; ctx.beginPath(); p.points.forEach((q, i) => { if (i) { ctx.lineTo(q[0], q[1]); } else { ctx.moveTo(q[0], q[1]); } }); if (p.mode === 'loop') { ctx.closePath(); } ctx.stroke(); p.points.forEach((q) => { ctx.fillStyle = '#00bcd4'; ctx.fillRect(q[0] - 2, q[1] - 2, 4, 4); }); });
      state.entities.forEach((e) => { if (!e.alive) { return; } ctx.strokeStyle = e.trigger ? '#e040fb' : (e.solid ? '#76ff03' : '#ffeb3b'); if (e.shape === 'circle') { ctx.beginPath(); ctx.arc(e.pos[0], e.pos[1], e.size[0] / 2, 0, Math.PI * 2); ctx.stroke(); } else { ctx.strokeRect(e.pos[0] - e.size[0] / 2, e.pos[1] - e.size[1] / 2, e.size[0], e.size[1]); } });
    }
    (opts.selection || []).forEach((id) => { const e = state.entities.find((x) => x.id === id); if (!e) { const z = (sc.zones || []).find((q) => q.id === id); if (z) { ctx.strokeStyle = '#2f81f7'; ctx.lineWidth = 2 / v.s; ctx.setLineDash([4 / v.s, 3 / v.s]); ctx.strokeRect(z.rect[0], z.rect[1], z.rect[2], z.rect[3]); ctx.setLineDash([]); } return; } ctx.strokeStyle = '#2f81f7'; ctx.lineWidth = 2 / v.s; ctx.setLineDash([4 / v.s, 3 / v.s]); ctx.strokeRect(e.pos[0] - e.size[0] / 2 - 2, e.pos[1] - e.size[1] / 2 - 2, e.size[0] + 4, e.size[1] + 4); ctx.setLineDash([]); });
    if (opts.focus && opts.focus.rect) { const r = opts.focus.rect; ctx.fillStyle = 'rgba(47,129,247,.15)'; ctx.fillRect(r[0], r[1], r[2], r[3]); ctx.strokeStyle = '#2f81f7'; ctx.lineWidth = 2 / v.s; ctx.strokeRect(r[0], r[1], r[2], r[3]); }
    (opts.preview || []).forEach((p) => { const col = p.kind === 'add' ? '#3fb950' : p.kind === 'del' ? '#f85149' : '#d29922'; ctx.strokeStyle = col; ctx.lineWidth = 2 / v.s; ctx.setLineDash(p.kind === 'del' ? [3 / v.s, 3 / v.s] : []); ctx.strokeRect(p.x - p.w / 2 - 2, p.y - p.h / 2 - 2, p.w + 4, p.h + 4); ctx.setLineDash([]); ctx.fillStyle = col + '22'; ctx.fillRect(p.x - p.w / 2, p.y - p.h / 2, p.w, p.h); });
  }
  function drawHud(ctx, state, game, opts) {
    if (opts.hud === false) { return; } const W = opts.width; ctx.save(); ctx.font = 'bold ' + Math.max(11, Math.round(W / 36)) + 'px ' + FONT; ctx.textBaseline = 'top'; ctx.textAlign = 'left'; let y = 6; const fs = Math.max(11, Math.round(W / 36));
    const vars = state.vars || {}; const show = Object.keys(vars).filter((k) => typeof vars[k] === 'number' && k !== 'lives' && !/^item_/.test(k)); ctx.shadowColor = '#000'; ctx.shadowBlur = 3;
    const pl = state.entities.find((e) => e.alive && e.tags.indexOf('player') >= 0 && e.ctrl);
    if (pl && pl.maxHp > 0) { ctx.fillStyle = '#ff5252'; let hearts = ''; for (let i = 0; i < Math.min(10, pl.maxHp); i++) { hearts += i < pl.hp ? '❤' : '♡'; } if (pl.maxHp > 10) { hearts = '❤ ' + Math.max(0, Math.round(pl.hp)) + '/' + pl.maxHp; } if (!pl.hud) { ctx.fillText(hearts, 8, y); y += fs + 4; } }
    ctx.fillStyle = '#fff'; show.forEach((k) => { ctx.fillText(k + ': ' + Math.round(vars[k]), 8, y); y += fs + 2; });
    ctx.restore();
  }
  function drawDialog(ctx, state, opts) {
    const d = state.dialog; if (!d) { return; } const W = opts.width, H = opts.height, bh = Math.max(46, H * 0.28), by = H - bh - 6; ctx.save(); ctx.fillStyle = 'rgba(10,14,30,.88)'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.fillRect(6, by, W - 12, bh); ctx.strokeRect(6, by, W - 12, bh);
    const l = d.lines[d.i] || { who: '', text: '' }, fs = Math.max(11, Math.round(W / 34)); ctx.font = 'bold ' + fs + 'px ' + FONT; ctx.textBaseline = 'top'; ctx.fillStyle = '#ffd54f'; ctx.fillText(l.who || '', 16, by + 6);
    ctx.font = fs + 'px ' + FONT; ctx.fillStyle = '#fff'; const shown = String(l.text).slice(0, Math.floor(d.t * 30)); const maxW = W - 36; let line = '', y = by + 8 + fs + 4; for (const ch of shown) { if (ctx.measureText(line + ch).width > maxW) { ctx.fillText(line, 16, y); line = ''; y += fs + 3; } line += ch; } ctx.fillText(line, 16, y);
    if (d.phase === 'choice' && d.choices) { d.choices.forEach((c, i) => { ctx.fillStyle = i === d.choice ? '#ffd54f' : '#ddd'; ctx.fillText((i === d.choice ? '▶ ' : '  ') + c.text, W - 150, by + 8 + i * (fs + 3)); }); } else if (shown.length >= String(l.text).length && Math.floor((opts.time || 0) * 2) % 2 === 0) { ctx.fillStyle = '#fff'; ctx.fillText('▼', W - 28, by + bh - fs - 6); }
    ctx.restore();
  }
  function drawBattle(ctx, state, opts) {
    const B = state.battle; if (!B) { return; } const W = opts.width, H = opts.height; ctx.save(); ctx.fillStyle = '#16162e'; ctx.fillRect(0, 0, W, H); ctx.textBaseline = 'middle'; ctx.textAlign = 'center';
    const draw = (list, x0, dir) => { list.forEach((c, i) => { const x = x0 + dir * (i % 2) * 38, y = H * 0.25 + i * (H * 0.18); ctx.globalAlpha = c.hp > 0 ? 1 : 0.25; ctx.fillStyle = c.color; ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.fill(); ctx.font = '22px ' + FONT; ctx.fillStyle = '#fff'; ctx.fillText(c.emoji || c.name.charAt(0), x, y + 1); ctx.font = '11px ' + FONT; ctx.fillText(c.name + ' ' + Math.max(0, c.hp) + '/' + c.maxHp, x, y + 28); ctx.fillStyle = '#000a'; ctx.fillRect(x - 22, y + 34, 44, 4); ctx.fillStyle = '#4caf50'; ctx.fillRect(x - 22, y + 34, 44 * Math.max(0, c.hp) / c.maxHp, 4); ctx.globalAlpha = 1; }); };
    draw(B.party, W * 0.22, 1); draw(B.enemies, W * 0.72, -1);
    const aliveE = B.enemies.filter((c) => c.hp > 0); if (aliveE.length && B.phase !== 'end') { const tg = aliveE[B.target % aliveE.length]; const i = B.enemies.indexOf(tg); const x = W * 0.72 - (i % 2) * 38, y = H * 0.25 + i * (H * 0.18); ctx.fillStyle = '#ffd54f'; ctx.fillText('▼', x, y - 26); }
    ctx.fillStyle = 'rgba(10,14,30,.92)'; ctx.strokeStyle = '#fff'; ctx.fillRect(6, H - 62, W - 12, 56); ctx.strokeRect(6, H - 62, W - 12, 56); ctx.textAlign = 'left'; ctx.font = '12px ' + FONT; ctx.fillStyle = '#fff'; B.log.slice(-3).forEach((t, i) => ctx.fillText(t, 14, H - 50 + i * 15));
    ['攻擊', '必殺', '藥水', '逃跑'].forEach((n, i) => { ctx.fillStyle = B.menu === i && B.phase !== 'end' ? '#ffd54f' : '#ddd'; ctx.fillText((B.menu === i ? '▶ ' : '  ') + n, W - 90, H - 54 + i * 12); });
    ctx.restore();
  }
  function drawStatus(ctx, state, opts) {
    if (state.status === 'playing') { return; } const W = opts.width, H = opts.height; ctx.save(); ctx.fillStyle = 'rgba(0,0,0,.55)'; ctx.fillRect(0, 0, W, H); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillStyle = state.status === 'won' ? '#ffd54f' : '#ff5252'; ctx.font = 'bold ' + Math.round(W / 9) + 'px ' + FONT; ctx.fillText(state.status === 'won' ? '過關!' : '失敗', W / 2, H / 2 - 12); ctx.fillStyle = '#fff'; ctx.font = Math.round(W / 26) + 'px ' + FONT; ctx.fillText('按 R 重來', W / 2, H / 2 + W / 12); ctx.restore();
  }
  function draw(ctx, state, game, opts) {
    opts = Object.assign({ width: 640, height: 360 }, opts || {}); const sc = game.scenes[state.scene]; ctx.save(); ctx.clearRect(0, 0, opts.width, opts.height);
    if (state.battle) { drawBattle(ctx, state, opts); drawStatus(ctx, state, opts); ctx.restore(); return; }
    ctx.fillStyle = (sc && sc.background) || '#222'; ctx.fillRect(0, 0, opts.width, opts.height);
    const v = view(state, opts); const sh = state.shake > 0 ? [(Math.sin((opts.time || 0) * 90) * state.shake * 4) | 0, (Math.cos((opts.time || 0) * 110) * state.shake * 4) | 0] : [0, 0];
    ctx.translate(v.ox + sh[0], v.oy + sh[1]); ctx.scale(v.s, v.s); ctx.translate(-v.x, -v.y); ctx.beginPath(); ctx.rect(v.x, v.y, opts.width / v.s, opts.height / v.s); ctx.clip();
    drawTiles(ctx, state, v, opts);
    const kind = sc && sc.kind; let ents = state.entities.filter((e) => e.alive); if (kind === 'topdown' || kind === 'rpg-field') { ents = ents.slice().sort((a, b) => (a.pos[1] + a.size[1] / 2) - (b.pos[1] + b.size[1] / 2)); }
    ents.forEach((e) => drawEntity(ctx, e, (game.prefabs[e.prefab] || {}).sprite, opts, state)); drawOverlays(ctx, state, game, v, opts);
    ctx.restore(); drawHud(ctx, state, game, opts); drawDialog(ctx, state, opts); drawStatus(ctx, state, opts);
  }
  return { draw, view, worldToScreen, screenToWorld, FONT };
});
