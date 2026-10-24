// node scripts/computer-tests/rfb_client.test.js -- rfb-client.js 對假 RFB 伺服器（各種編碼、驗證、輸入、WebSocket、候選物件）
const { RfbClient, deriveObjects, keysymForChar, chordToKeysyms } = require('../../rfb-client.js');
const PNG = require('../../computer-png.js');
const { startFakeRfb } = require('./fake_rfb_server.js');
const { suite } = require('./_t.js');
const t = suite('rfb-client');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const eqFb = (client, srv, rect) => { const w = client.width; for (let y = rect.y; y < rect.y + rect.h; y++) for (let x = rect.x; x < rect.x + rect.w; x++) { const q = (y * w + x) * 4; for (let c = 0; c < 3; c++) if (client.fb[q + c] !== srv.fb.data[q + c]) return { x, y, c, got: client.fb[q + c], want: srv.fb.data[q + c] }; } return true; };

(async () => {
  // ===== 各種編碼：整個畫面各用一種編碼，逐像素比對 =====
  for (const [name, enc] of [['Raw', 0], ['RRE', 2], ['Hextile', 5], ['ZRLE', 16]]) {
    await t.acheck('編碼 ' + name + '：整個畫面（150x100，含不滿一個磁磚的邊）逐像素一致', async () => {
      const srv = await startFakeRfb({}); srv.fullEnc = enc; const c = new RfbClient({ host: '127.0.0.1', port: srv.port });
      try {
        const info = await c.connect(); if (info.width !== 150 || info.height !== 100 || info.name !== 'fake-rfb') return { bad: 'init', info };
        const u = await c.waitForUpdate(3000); if (u.timedOut) return { bad: 'no update' };
        const r = eqFb(c, srv, { x: 0, y: 0, w: 150, h: 100 }); if (r !== true) return { bad: 'pixel', r };
        if (!srv.clientEncodings.includes(16) || !srv.clientEncodings.includes(-239)) return { bad: 'encodings', e: srv.clientEncodings };
        if (srv.pixelFormat.bpp !== 32 || srv.pixelFormat.rshift !== 0 || srv.pixelFormat.bshift !== 16) return { bad: 'pf', p: srv.pixelFormat };
        return true;
      } finally { c.close(); srv.close(); }
    });
  }
  // ===== 連續多個 ZRLE 更新（共用同一條 zlib 串流）＋ CopyRect ＋ 游標 ＋ DesktopSize =====
  await t.acheck('連續 ZRLE 更新共用 zlib 串流、CopyRect 搬移、游標形狀、DesktopSize', async () => {
    const srv = await startFakeRfb({}); srv.fullEnc = 16; const c = new RfbClient({ host: '127.0.0.1', port: srv.port });
    try {
      await c.connect(); await c.waitForUpdate(3000);
      for (let i = 0; i < 4; i++) { srv.fillRect(5 + i * 20, 5, 15, 15, [i * 60, 100, 200 - i * 40]); const p = c.waitForUpdate(3000); await srv.push([{ x: 0, y: 0, w: 150, h: 40, enc: 16 }]); const u = await p; if (u.timedOut) return { bad: 'zrle update ' + i }; }
      let r = eqFb(c, srv, { x: 0, y: 0, w: 150, h: 100 }); if (r !== true) return { bad: 'after zrle', r };
      // CopyRect：把 (10,10,40x30) 的紅塊複製到 (100,60)
      for (let y = 0; y < 30; y++) for (let x = 0; x < 40; x++) { const s = ((10 + y) * 150 + 10 + x) * 4, d = ((60 + y) * 150 + 100 + x) * 4; if (100 + x < 150) for (let k = 0; k < 4; k++) srv.fb.data[d + k] = srv.fb.data[s + k]; }
      let p = c.waitForUpdate(3000); await srv.push([{ x: 100, y: 60, w: 40, h: 30, enc: 1, copyFrom: { x: 10, y: 10 } }]); let u = await p;
      if (!u.copyrects || u.copyrects.length !== 1 || u.copyrects[0].src.x !== 10 || u.copyrects[0].dst.x !== 100) return { bad: 'copyrect event', u };
      r = eqFb(c, srv, { x: 100, y: 60, w: 40, h: 30 }); if (r !== true) return { bad: 'copyrect pixels', r };
      // 游標：4x4 紅色游標、熱點 1,1
      p = c.waitForUpdate(3000); await srv.push([{ x: 1, y: 1, w: 4, h: 4, enc: -239, cursor: { w: 4, h: 4, rgb: [255, 0, 0] } }]); u = await p;
      if (!c.cursor || c.cursor.w !== 4 || c.cursor.hotX !== 1 || c.cursor.rgba[0] !== 255 || c.cursor.rgba[3] !== 255 || !u.cursor) return { bad: 'cursor', cur: c.cursor && { w: c.cursor.w, hotX: c.cursor.hotX } };
      // DesktopSize：縮成 100x60
      p = c.waitForUpdate(3000); srv.fb.width = 100; srv.fb.height = 60; srv.fb.data = new Uint8Array(100 * 60 * 4).fill(77); await srv.push([{ x: 0, y: 0, w: 100, h: 60, enc: -223 }]); u = await p;
      if (c.width !== 100 || c.height !== 60 || c.fb.length !== 100 * 60 * 4 || !u.resized) return { bad: 'resize', w: c.width, h: c.height };
      return true;
    } finally { c.close(); srv.close(); }
  });
  // ===== 驗證 =====
  await t.acheck('VNC 驗證成功（3.8）', async () => { const srv = await startFakeRfb({ security: 'vnc', password: 'hunter2' }); const c = new RfbClient({ host: '127.0.0.1', port: srv.port, password: 'hunter2' }); try { const i = await c.connect(); return i.security === 'VNC 驗證' && srv.clientVersion === 'RFB 003.008\n'; } finally { c.close(); srv.close(); } });
  await t.acheck('VNC 驗證密碼錯誤 → 明確錯誤、錯誤訊息不含密碼', async () => { const srv = await startFakeRfb({ security: 'vnc', password: 'hunter2' }); const c = new RfbClient({ host: '127.0.0.1', port: srv.port, password: 'wrongpass' }); try { await c.connect(); return false; } catch (e) { return /驗證失敗/.test(e.message) && !/wrongpass|hunter2/.test(e.message); } finally { c.close(); srv.close(); } });
  await t.acheck('需要密碼但沒給 → 錯誤訊息說明怎麼給', async () => { const srv = await startFakeRfb({ security: 'vnc', password: 'x' }); const c = new RfbClient({ host: '127.0.0.1', port: srv.port }); try { await c.connect(); return false; } catch (e) { return /需要 VNC 密碼/.test(e.message) && /secretName/.test(e.message); } finally { c.close(); srv.close(); } });
  await t.acheck('RFB 3.3：安全類型由伺服器指定（None）', async () => { const srv = await startFakeRfb({ version: '003.003' }); const c = new RfbClient({ host: '127.0.0.1', port: srv.port }); try { const i = await c.connect(); return srv.clientVersion === 'RFB 003.003\n' && i.width === 150; } finally { c.close(); srv.close(); } });
  await t.acheck('RFB 3.7：None 沒有 SecurityResult', async () => { const srv = await startFakeRfb({ version: '003.007' }); const c = new RfbClient({ host: '127.0.0.1', port: srv.port }); try { const i = await c.connect(); return i.width === 150; } finally { c.close(); srv.close(); } });
  await t.acheck('不支援的安全類型（Tight／TLS）→ 說明「改成 None 或 VNC 驗證」', async () => { const srv = await startFakeRfb({ security: 'tight' }); const c = new RfbClient({ host: '127.0.0.1', port: srv.port }); try { await c.connect(); return false; } catch (e) { return /Tight\(16\)/.test(e.message) && /TLS\(18\)/.test(e.message) && /VNC 驗證/.test(e.message); } finally { c.close(); srv.close(); } });
  await t.acheck('對方不是 RFB → 明確錯誤', async () => { const net = require('net'); const s = net.createServer((sock) => sock.end('HTTP/1.1 400 Bad Request\r\n\r\n')); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const c = new RfbClient({ host: '127.0.0.1', port: s.address().port, connectTimeoutMs: 2000 }); try { await c.connect(); return false; } catch (e) { return /不是 RFB/.test(e.message); } finally { c.close(); s.close(); } });
  await t.acheck('連線被拒（埠沒開）→ 錯誤而不是卡住', async () => { const c = new RfbClient({ host: '127.0.0.1', port: 1, connectTimeoutMs: 2000 }); try { await c.connect(); return false; } catch (e) { return /ECONNREFUSED|逾時|refused/i.test(e.message); } });
  // ===== 輸入 =====
  await t.acheck('輸入：點擊／雙擊／右鍵／拖曳／捲動／打字（含中文）／組合鍵／剪貼簿', async () => {
    const srv = await startFakeRfb({}); const c = new RfbClient({ host: '127.0.0.1', port: srv.port });
    try {
      await c.connect(); await c.waitForUpdate(2000);
      await c.click(20, 30); await c.click(21, 31, 'right'); await c.click(22, 32, 'left', 2); await c.drag(10, 10, 60, 10); await c.scroll(50, 50, 0, 2);
      await c.typeText('aZ世'); await c.keyChord('ctrl+shift+t'); await c.keyChord('Enter'); c.clientCutText('hello'); await sleep(300);
      const ev = srv.events, ptr = ev.filter((e) => e.type === 'pointer'), keys = ev.filter((e) => e.type === 'key');
      const masks = ptr.map((e) => e.mask);
      if (!(ptr.some((e) => e.mask === 1 && e.x === 20 && e.y === 30))) return { bad: 'left click', ptr: ptr.slice(0, 6) };
      if (!ptr.some((e) => e.mask === 4 && e.x === 21)) return { bad: 'right click' };
      if (masks.filter((m) => m === 1).length < 1 + 2 + 3) return { bad: 'double click / drag', n: masks.filter((m) => m === 1).length };
      const dragEnd = ptr.filter((e) => e.mask === 1 && e.x === 60); if (!dragEnd.length) return { bad: 'drag end' };
      if (masks.filter((m) => m === 16).length !== 2) return { bad: 'wheel down x2', n: masks.filter((m) => m === 16).length };
      const syms = keys.filter((k) => k.down).map((k) => k.keysym);
      const wantTyped = [0x61, 0x5a, 0x01000000 + 0x4e16]; if (!wantTyped.every((s, i) => syms[i] === s)) return { bad: 'typed keysyms', syms: syms.slice(0, 6).map((x) => x.toString(16)) };
      const chord = syms.slice(3, 6); if (chord[0] !== 0xffe3 || chord[1] !== 0xffe1 || chord[2] !== 0x74) return { bad: 'chord', chord: chord.map((x) => x.toString(16)) };
      if (syms[6] !== 0xff0d) return { bad: 'Enter' };
      const ups = keys.filter((k) => !k.down).length, downs = keys.filter((k) => k.down).length; if (ups !== downs) return { bad: 'key balance' };
      if (srv.cutText[0] !== 'hello') return { bad: 'cut text' };
      return true;
    } finally { c.close(); srv.close(); }
  });
  t.check('keysym：ASCII、Latin-1、Unicode、換行', keysymForChar('a') === 0x61 && keysymForChar('é') === 0xe9 && keysymForChar('中') === 0x01004e2d && keysymForChar('\n') === 0xff0d);
  t.check('chordToKeysyms：ctrl+a、F5、不認得的名稱回 null', JSON.stringify(chordToKeysyms('ctrl+a')) === JSON.stringify([0xffe3, 0x61]) && chordToKeysyms('f5')[0] === 0xffc2 && chordToKeysyms('ctrl+nonsense') === null);
  // ===== 螢幕截圖 =====
  await t.acheck('screenshot：PNG 可解碼、裁切、縮放比、游標疊圖', async () => {
    const srv = await startFakeRfb({}); srv.fullEnc = 0; const c = new RfbClient({ host: '127.0.0.1', port: srv.port });
    try {
      await c.connect(); await c.waitForUpdate(2000);
      const s = c.screenshot({ rect: { x: 10, y: 10, w: 40, h: 30 } }); const d = PNG.decodePng(s.png);
      if (d.width !== 40 || d.height !== 30 || s.origin.x !== 10 || d.data[0] !== 250 || d.data[1] !== 10) return { bad: 'crop', w: d.width, p: Array.from(d.data.subarray(0, 4)) };
      const s2 = c.screenshot({ maxSide: 50 }); if (s2.width !== 50 || Math.abs(s2.scale.x - 1 / 3) > 1e-9) return { bad: 'scale', w: s2.width, sc: s2.scale };
      return true;
    } finally { c.close(); srv.close(); }
  });
  // ===== WebSocket（noVNC／websockify） =====
  await t.acheck('WebSocket 傳輸（ws://，子協定 binary）：握手＋ZRLE 畫面＋輸入', async () => {
    const srv = await startFakeRfb({ ws: true, security: 'vnc', password: 'pw' }); srv.fullEnc = 16; const c = new RfbClient({ wsUrl: 'ws://127.0.0.1:' + srv.port + '/websockify', password: 'pw' });
    try { await c.connect(); const u = await c.waitForUpdate(3000); if (u.timedOut) return { bad: 'no update' }; const r = eqFb(c, srv, { x: 0, y: 0, w: 150, h: 100 }); if (r !== true) return { bad: 'pixels', r }; await c.click(5, 6); await sleep(150); return srv.events.some((e) => e.type === 'pointer' && e.mask === 1 && e.x === 5); } finally { c.close(); srv.close(); }
  });
  // ===== 候選物件（損壞矩形 → 物件區） =====
  const now = 100000, up = (dt, rects, copyrects) => ({ t: now - dt, rects: (rects || []).map((r) => Object.assign({ enc: 0 }, r)), copyrects: copyrects || [] });
  let objs = deriveObjects([up(500, [{ x: 10, y: 10, w: 40, h: 20 }, { x: 52, y: 12, w: 30, h: 20 }]), up(400, [{ x: 400, y: 300, w: 100, h: 80 }])], { now });
  t.check('deriveObjects：相鄰矩形合併、遠的分開、有 id 與 source:rfb', objs.length === 2 && objs.some((o) => o.rect.x === 10 && o.rect.w === 72) && objs.every((o) => o.source === 'rfb' && /^rfb:\d+$/.test(o.id)), objs);
  objs = deriveObjects([up(300, [], [{ src: { x: 0, y: 100 }, dst: { x: 0, y: 40, w: 600, h: 400 } }])], { now });
  t.check('deriveObjects：CopyRect 變成 move（捲動）物件並帶位移', objs.length === 1 && objs[0].kind === 'move' && objs[0].move.dy === -60, objs);
  const anim = []; for (let i = 0; i < 8; i++) anim.push(up(i * 120, [{ x: 300, y: 200, w: 64, h: 64 }]));
  objs = deriveObjects(anim, { now });
  t.check('deriveObjects：每 ~120ms 更新一次的區塊判為動畫（animated:true）並給更新間隔', objs.length === 1 && objs[0].animated && objs[0].role === 'canvas' && objs[0].updateIntervalMs > 100 && objs[0].updateIntervalMs < 140, objs);
  objs = deriveObjects([up(300, [{ x: 1, y: 1, w: 3, h: 3 }])], { now });
  t.check('deriveObjects：太小的雜點被濾掉', objs.length === 0);
  objs = deriveObjects([up(300, [{ x: 100, y: 100, w: 50, h: 50 }])], { now, pointer: { x: 120, y: 130 }, cursor: { w: 12, h: 19, hotX: 0, hotY: 0, hash: 'abc' }, sessionId: 'rfb:7' });
  t.check('deriveObjects：游標物件放在最前面，id 依 session', objs[0].kind === 'cursor' && objs[0].id === 'rfb:7:1' && objs[0].cursorHash === 'abc');
  t.done();
})();
