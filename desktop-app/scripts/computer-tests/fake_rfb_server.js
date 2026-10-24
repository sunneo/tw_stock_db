// 測試用的假 RFB 伺服器：照 RFB 規格送出各種編碼的矩形，記錄用戶端的輸入。可以包成 WebSocket（noVNC／websockify 的樣子）。
'use strict';
const net = require('net');
const http = require('http');
const zlib = require('zlib');
const crypto = require('crypto');
const codec = require('../../rfb-codec.js');
const { WsConn, acceptHeader } = require('../../computer-ws.js');

// 影像 → 各編碼（我們協商的像素格式：每像素 4 bytes，R,G,B,0）
const px = (img, x, y) => { const q = (y * img.width + x) * 4; return [img.data[q], img.data[q + 1], img.data[q + 2]]; };
const same = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
function pix4(c) { return Buffer.from([c[0], c[1], c[2], 0]); }
function encRaw(img, r) { const b = Buffer.alloc(r.w * r.h * 4); for (let y = 0; y < r.h; y++) for (let x = 0; x < r.w; x++) pix4(px(img, r.x + x, r.y + y)).copy(b, (y * r.w + x) * 4); return b; }
function encRre(img, r) {
  const bg = px(img, r.x, r.y), subs = [];
  for (let y = 0; y < r.h; y++) { let x = 0; while (x < r.w) { const c = px(img, r.x + x, r.y + y); if (same(c, bg)) { x++; continue; } let e = x; while (e < r.w && same(px(img, r.x + e, r.y + y), c)) e++; const s = Buffer.alloc(12); pix4(c).copy(s, 0); s.writeUInt16BE(x, 4); s.writeUInt16BE(y, 6); s.writeUInt16BE(e - x, 8); s.writeUInt16BE(1, 10); subs.push(s); x = e; } }
  const h = Buffer.alloc(8); h.writeUInt32BE(subs.length, 0); pix4(bg).copy(h, 4); return Buffer.concat([h].concat(subs));
}
function encHextile(img, r) {
  const out = []; let bg = null;
  for (let ty = 0; ty < r.h; ty += 16) for (let tx = 0; tx < r.w; tx += 16) {
    const tw = Math.min(16, r.w - tx), th = Math.min(16, r.h - ty), cols = new Map();
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const k = px(img, r.x + tx + x, r.y + ty + y).join(','); cols.set(k, (cols.get(k) || 0) + 1); }
    const sorted = [...cols.entries()].sort((a, b) => b[1] - a[1]), main = sorted[0][0].split(',').map(Number);
    if (cols.size === 1) { const sub = bg && same(bg, main) ? 0 : 2; out.push(Buffer.from([sub])); if (sub) { out.push(pix4(main)); bg = main; } continue; }
    if (cols.size <= 6) { // 背景 ＋ 彩色子矩形（逐列 run）
      const subs = []; for (let y = 0; y < th; y++) { let x = 0; while (x < tw) { const c = px(img, r.x + tx + x, r.y + ty + y); if (same(c, main)) { x++; continue; } let e = x; while (e < tw && e - x < 16 && same(px(img, r.x + tx + e, r.y + ty + y), c)) e++; subs.push(Buffer.concat([pix4(c), Buffer.from([(x << 4) | y, ((e - x - 1) << 4) | 0])])); x = e; } }
      if (subs.length < 256) { let sub = 8 | 16; const head = [Buffer.from([0])]; if (!bg || !same(bg, main)) { sub |= 2; head.push(pix4(main)); bg = main; } head[0] = Buffer.from([sub]); out.push(Buffer.concat(head), Buffer.from([subs.length]), Buffer.concat(subs)); continue; }
    }
    const tile = []; for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) tile.push(pix4(px(img, r.x + tx + x, r.y + ty + y))); out.push(Buffer.from([1]), Buffer.concat(tile)); bg = null;
  }
  return Buffer.concat(out);
}
function encZrleBody(img, r) {
  const out = [];
  for (let ty = 0; ty < r.h; ty += 64) for (let tx = 0; tx < r.w; tx += 64) {
    const tw = Math.min(64, r.w - tx), th = Math.min(64, r.h - ty), cols = new Map(), list = [];
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) { const c = px(img, r.x + tx + x, r.y + ty + y), k = c.join(','); if (!cols.has(k)) cols.set(k, cols.size), list.push(c); }
    if (cols.size === 1) { out.push(Buffer.from([1, ...list[0]])); continue; }
    if (cols.size <= 16) {
      const n = cols.size, bpp = n === 2 ? 1 : n <= 4 ? 2 : 4, pal = Buffer.concat(list.map((c) => Buffer.from(c)));
      const rows = []; for (let y = 0; y < th; y++) { const rb = Buffer.alloc(Math.ceil((tw * bpp) / 8)); for (let x = 0; x < tw; x++) { const idx = cols.get(px(img, r.x + tx + x, r.y + ty + y).join(',')), bit = x * bpp; rb[bit >> 3] |= idx << (8 - bpp - (bit & 7)); } rows.push(rb); }
      out.push(Buffer.from([n]), pal, Buffer.concat(rows)); continue;
    }
    const raw = []; for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) raw.push(Buffer.from(px(img, r.x + tx + x, r.y + ty + y))); out.push(Buffer.from([0]), Buffer.concat(raw));
  }
  return Buffer.concat(out);
}

// opts：{ version:'003.008'|'003.007'|'003.003', security:'none'|'vnc'|'tight', password, width, height, ws:false, name }
function startFakeRfb(opts) {
  opts = Object.assign({ version: '003.008', security: 'none', width: 150, height: 100, name: 'fake-rfb' }, opts || {});
  const state = { events: [], clientVersion: '', fb: { width: opts.width, height: opts.height, data: new Uint8Array(opts.width * opts.height * 4) }, requests: 0, conns: [], clientEncodings: [], pixelFormat: null, cutText: [] };
  const deflate = () => state.deflater || (state.deflater = zlib.createDeflate({ level: 6 }));
  // 預設畫面：漸層＋幾個色塊＋雜訊區
  const fb = state.fb; for (let y = 0; y < fb.height; y++) for (let x = 0; x < fb.width; x++) { const q = (y * fb.width + x) * 4; fb.data[q] = (x * 255 / fb.width) | 0; fb.data[q + 1] = (y * 255 / fb.height) | 0; fb.data[q + 2] = 80; fb.data[q + 3] = 255; }
  const fillRect = (x, y, w, h, c) => { for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const q = (yy * fb.width + xx) * 4; fb.data[q] = c[0]; fb.data[q + 1] = c[1]; fb.data[q + 2] = c[2]; } };
  fillRect(10, 10, 40, 30, [250, 10, 10]); fillRect(70, 20, 60, 50, [10, 250, 10]); fillRect(0, 80, 150, 20, [255, 255, 255]);
  for (let i = 0; i < 300; i++) { const x = (i * 37) % 150, y = (i * 53) % 100, q = (y * 150 + x) * 4; fb.data[q] = (i * 7) & 255; fb.data[q + 1] = (i * 13) & 255; fb.data[q + 2] = (i * 29) & 255; }
  state.fillRect = fillRect;

  async function handle(conn) {
    state.conns.push(conn);
    let buf = Buffer.alloc(0), waiter = null; const feed = (d) => { buf = Buffer.concat([buf, d]); if (waiter) { const w = waiter; waiter = null; w(); } };
    conn.onData(feed); conn.onClose(() => { state.closed = true; if (waiter) waiter(); });
    const read = async (n) => { while (buf.length < n) { if (state.closed && buf.length < n) throw new Error('closed'); await new Promise((r) => { waiter = r; }); } const o = buf.subarray(0, n); buf = buf.subarray(n); return o; };
    function sendRects(rects, opt) { // rects：{x,y,w,h,enc, copyFrom?, cursor?}
      const parts = [Buffer.from([0, 0, 0, 0])]; parts[0].writeUInt16BE(rects.length, 2);
      for (const r of rects) {
        const h = Buffer.alloc(12); h.writeUInt16BE(r.x || 0, 0); h.writeUInt16BE(r.y || 0, 2); h.writeUInt16BE(r.w || 0, 4); h.writeUInt16BE(r.h || 0, 6); h.writeInt32BE(r.enc, 8); parts.push(h);
        if (r.enc === 0) parts.push(encRaw(fb, r)); else if (r.enc === 2) parts.push(encRre(fb, r)); else if (r.enc === 5) parts.push(encHextile(fb, r));
        else if (r.enc === 1) { const b = Buffer.alloc(4); b.writeUInt16BE(r.copyFrom.x, 0); b.writeUInt16BE(r.copyFrom.y, 2); parts.push(b); }
        else if (r.enc === 16) { const body = encZrleBody(fb, r); state.zrleBodies = (state.zrleBodies || 0) + 1; parts.push({ zrle: body }); }
        else if (r.enc === -239) { const c = r.cursor, pixBuf = Buffer.alloc(c.w * c.h * 4), maskRow = Math.ceil(c.w / 8), mask = Buffer.alloc(maskRow * c.h); for (let y = 0; y < c.h; y++) for (let x = 0; x < c.w; x++) { const q = (y * c.w + x) * 4; Buffer.from([c.rgb[0], c.rgb[1], c.rgb[2], 0]).copy(pixBuf, q); mask[y * maskRow + (x >> 3)] |= 0x80 >> (x & 7); } parts.push(pixBuf, mask); }
        else if (r.enc === -223) { /* 沒有資料 */ }
      }
      // ZRLE 需要串流壓縮：同一個 deflate 串流、每個矩形結尾 sync flush
      const finalize = async () => {
        const out = [];
        for (const p of parts) { if (p && p.zrle) { const d = deflate(), chunks = []; const on = (c) => chunks.push(c); d.on('data', on); d.write(p.zrle); await new Promise((res) => d.flush(zlib.constants.Z_SYNC_FLUSH, res)); d.removeListener('data', on); const z = Buffer.concat(chunks), l = Buffer.alloc(4); l.writeUInt32BE(z.length); out.push(l, z); } else out.push(p); }
        conn.write(Buffer.concat(out));
      };
      state.sendQueue = (state.sendQueue || Promise.resolve()).then(finalize); return state.sendQueue;
    }
    state.sendRects = sendRects;
    try {
      conn.write(Buffer.from('RFB ' + opts.version + '\n', 'latin1'));
      state.clientVersion = (await read(12)).toString('latin1');
      const minor = Number(opts.version.slice(4));
      const secNum = opts.security === 'vnc' ? 2 : opts.security === 'tight' ? 16 : 1;
      if (minor >= 7) {
        conn.write(Buffer.from(opts.security === 'tight' ? [2, 16, 18] : [1, secNum])); const chosen = (await read(1))[0]; state.chosenSecurity = chosen;
        if (opts.security === 'tight') { conn.write(Buffer.from([0, 0, 0, 1, 0, 0, 0, 5]).subarray(0, 0)); const reason = Buffer.from('unsupported'); /* 用戶端應該在選型前就放棄 */ return; }
      } else { const b = Buffer.alloc(4); b.writeUInt32BE(secNum); conn.write(b); state.chosenSecurity = secNum; }
      if (secNum === 2) {
        const ch = crypto.randomBytes(16); conn.write(ch); const resp = await read(16); const ok = resp.equals(codec.vncAuthResponse(ch, opts.password));
        const res = Buffer.alloc(4); res.writeUInt32BE(ok ? 0 : 1); conn.write(res);
        if (!ok) { if (minor >= 8) { const m = Buffer.from('bad password'), l = Buffer.alloc(4); l.writeUInt32BE(m.length); conn.write(Buffer.concat([l, m])); } return; }
      } else if (minor >= 8) { conn.write(Buffer.alloc(4)); }
      const shared = (await read(1))[0]; state.shared = shared;
      const si = Buffer.alloc(24); si.writeUInt16BE(fb.width, 0); si.writeUInt16BE(fb.height, 2); si[4] = 16; si[5] = 16; si[6] = 0; si[7] = 1; si.writeUInt16BE(31, 8); si.writeUInt16BE(63, 10); si.writeUInt16BE(31, 12); si[14] = 11; si[15] = 5; si[16] = 0; const nm = Buffer.from(opts.name); si.writeUInt32BE(nm.length, 20); conn.write(Buffer.concat([si, nm]));
      for (;;) {
        const t = (await read(1))[0];
        if (t === 0) { const b = await read(19); state.pixelFormat = { bpp: b[3], depth: b[4], rshift: b[13], gshift: b[14], bshift: b[15] }; }
        else if (t === 2) { const h = await read(3), n = h.readUInt16BE(1), e = await read(n * 4); state.clientEncodings = Array.from({ length: n }, (_, i) => e.readInt32BE(i * 4)); }
        else if (t === 3) { const b = await read(9); state.requests++; state.lastRequest = { incremental: b[0], x: b.readUInt16BE(1), y: b.readUInt16BE(3), w: b.readUInt16BE(5), h: b.readUInt16BE(7) }; if (!b[0] && state.autoFull !== false) sendRects([{ x: 0, y: 0, w: fb.width, h: fb.height, enc: state.fullEnc == null ? 0 : state.fullEnc }]); if (state.onRequest) state.onRequest(state.lastRequest); }
        else if (t === 4) { const b = await read(7); state.events.push({ type: 'key', down: b[0], keysym: b.readUInt32BE(3) }); }
        else if (t === 5) { const b = await read(5); state.events.push({ type: 'pointer', mask: b[0], x: b.readUInt16BE(1), y: b.readUInt16BE(3) }); if (state.onPointer) state.onPointer(state.events[state.events.length - 1]); }
        else if (t === 6) { const h = await read(7), len = h.readUInt32BE(3), tx = await read(len); state.cutText.push(tx.toString('latin1')); }
        else throw new Error('未知客戶端訊息 ' + t);
      }
    } catch (e) { if (e.message !== 'closed') state.lastError = e.message; }
  }
  // sendRects 要在 handle 之外也能用：換成「對所有連線」
  state.push = (rects) => { if (!state.sendRects) throw new Error('沒有連線'); return state.sendRects(rects); };

  let server, wsServer;
  const wsMode = !!opts.ws;
  server = http.createServer((req, res) => { res.writeHead(404); res.end(); });
  if (wsMode) {
    server.on('upgrade', (req, sock) => {
      const key = req.headers['sec-websocket-key']; sock.write(acceptHeader(key, 'binary'));
      const ws = new WsConn(sock, { mask: false });
      const c = { write: (b) => ws.send(b), onData: (f) => ws.on('message', (m) => f(Buffer.isBuffer(m) ? m : Buffer.from(m))), onClose: (f) => { ws.on('close', f); }, destroy: () => sock.destroy() };
      handle(c);
    });
  } else {
    server = net.createServer((sock) => { const c = { write: (b) => sock.write(b), onData: (f) => sock.on('data', f), onClose: (f) => { sock.on('close', f); sock.on('error', () => {}); }, destroy: () => sock.destroy() }; handle(c); });
  }
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => { state.port = server.address().port; state.close = () => { for (const c of state.conns) { try { c.destroy(); } catch (_) { /* */ } } server.close(); }; resolve(state); }));
}
module.exports = { startFakeRfb, encRaw, encRre, encHextile, encZrleBody };
