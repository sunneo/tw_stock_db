// rfb-client.js —— Node 版 RFB（VNC）用戶端：不需要任何作業系統工具，就能看到遠端畫面並送出滑鼠／鍵盤。
// 支援：RFB 3.3／3.7／3.8；安全類型 None 與 VNC 驗證（DES）；ServerInit、SetPixelFormat（協商成 RGB888 小端，記憶體順序 R,G,B,X）、SetEncodings、
//   FramebufferUpdateRequest（增量）；解碼 Raw／CopyRect／RRE／Hextile／ZRLE，以及 Cursor、DesktopSize、ExtendedDesktopSize 虛擬編碼；
//   用戶端輸入 PointerEvent／KeyEvent／ClientCutText；傳輸層可以是 TCP 或 WebSocket（noVNC／websockify，見 computer-ws.js）。
// 不支援（會明確報錯）：Tight 與 TightPNG、VeNCrypt／TLS／RA2／ARD 等加密安全類型——伺服器要求這些時回報「請改用支援 None／VNC 驗證的設定」。
// RFB 沒有「繪圖物件」可以讀；這裡從「損壞矩形（damage）、CopyRect 搬移、游標形狀與位置」推出候選區域（deriveObjects），交給視覺模型命名。
// 連線機密（VNC 密碼）由呼叫端傳入（來自主行程的 secrets），這個檔案絕不寫進日誌、錯誤訊息或事件。
"use strict";
const net = require("net");
const { EventEmitter } = require("events");
const codec = require("./rfb-codec.js");
const PNG = require("./computer-png.js");
const { connectWs } = require("./computer-ws.js");

const ENC = { RAW: 0, COPYRECT: 1, RRE: 2, HEXTILE: 5, ZRLE: 16, CURSOR: -239, DESKTOPSIZE: -223, EXT_DESKTOPSIZE: -308, LASTRECT: -224 };
const SECURITY_NAMES = { 0: "invalid", 1: "None", 2: "VNC 驗證", 5: "RA2", 6: "RA2ne", 16: "Tight", 17: "Ultra", 18: "TLS", 19: "VeNCrypt", 20: "SASL", 21: "MD5", 22: "xvp", 30: "Apple Remote Desktop", 113: "MSLogonII", 129: "Tight（Unix 登入）", 130: "VNC 驗證（Mac）" };
const BUTTON_MASK = { left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16, wheelLeft: 32, wheelRight: 64 };

// ---------- 位元組佇列：async read(n) ----------
class ByteReader {
  constructor() { this.chunks = []; this.len = 0; this.waiter = null; this.err = null; }
  push(b) { this.chunks.push(b); this.len += b.length; this._wake(); }
  fail(e) { this.err = e; this._wake(); }
  _wake() { if (this.waiter) { const w = this.waiter; this.waiter = null; w(); } }
  async read(n) {
    for (;;) {
      if (this.len >= n) {
        if (this.chunks.length === 1 && this.chunks[0].length === n) { this.len = 0; return this.chunks.pop(); }
        const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks), out = all.subarray(0, n), rest = all.subarray(n);
        this.chunks = rest.length ? [rest] : []; this.len = rest.length; return out;
      }
      if (this.err) throw this.err;
      await new Promise((r) => { this.waiter = r; });
    }
  }
}

// ---------- 按鍵：字元／名稱 → X keysym ----------
const KEYSYM = { return: 0xff0d, enter: 0xff0d, escape: 0xff1b, esc: 0xff1b, tab: 0xff09, backspace: 0xff08, delete: 0xffff, insert: 0xff63, home: 0xff50, end: 0xff57, prior: 0xff55, next: 0xff56, left: 0xff51, up: 0xff52, right: 0xff53, down: 0xff54, space: 0x20, menu: 0xff67, print: 0xff61, pause: 0xff13, caps_lock: 0xffe5, num_lock: 0xff7f, scroll_lock: 0xff14, shift: 0xffe1, ctrl: 0xffe3, alt: 0xffe9, super: 0xffeb, plus: 0x2b, minus: 0x2d, comma: 0x2c, period: 0x2e, slash: 0x2f, backslash: 0x5c, equal: 0x3d, semicolon: 0x3b, apostrophe: 0x27, grave: 0x60, bracketleft: 0x5b, bracketright: 0x5d };
function keysymForChar(ch) {
  const cp = ch.codePointAt(0); if (cp === 10 || cp === 13) return 0xff0d; if (cp === 9) return 0xff09;
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp; return 0x01000000 + cp;
}
function keysymForName(name) {
  const n = String(name).toLowerCase(); if (KEYSYM[n] != null) return KEYSYM[n];
  const f = /^f(\d{1,2})$/.exec(n); if (f && +f[1] >= 1 && +f[1] <= 24) return 0xffbe + (+f[1] - 1);
  if (/^kp_/.test(n)) return null; if ([...n].length === 1) return keysymForChar(n); return null;
}
function chordToKeysyms(chord) { const parts = String(chord).split("+").filter(Boolean), syms = parts.map(keysymForName); return syms.some((s) => s == null) ? null : syms; }

function describeSecurity(types) { return (types || []).map((t) => (SECURITY_NAMES[t] || "type " + t) + "(" + t + ")").join("、"); }

class RfbClient extends EventEmitter {
  // opts：{ host, port, wsUrl, transport:'tcp'|'ws', password, getPassword, shared, connectTimeoutMs, autoUpdate, historyMs, label }
  constructor(opts) {
    super(); this.opts = Object.assign({ shared: true, connectTimeoutMs: 10000, autoUpdate: true, historyMs: 20000 }, opts || {});
    this.reader = new ByteReader(); this.state = "new"; this.width = 0; this.height = 0; this.name = ""; this.fb = null; this.version = ""; this.security = null; this.serverSecurityTypes = [];
    this.cursor = null; this.pointer = { x: 0, y: 0, mask: 0 }; this.updates = []; this.updateCount = 0; this.lastUpdateAt = 0; this._waiters = []; this.inflater = new codec.Inflater(); this.serverPixelFormat = null; this.closed = false;
  }
  _log(m) { if (this.opts.onLog) { try { this.opts.onLog(String(m)); } catch (_) { /* */ } } }
  _write(buf) { if (this.closed) throw new Error("RFB 連線已關閉"); this.transport.write(buf); }

  async connect() {
    const o = this.opts; this.state = "connecting";
    const timer = setTimeout(() => this._abort(new Error("RFB 連線逾時（" + o.connectTimeoutMs + " ms）")), o.connectTimeoutMs);
    try {
      await this._openTransport();
      await this._handshake();
      clearTimeout(timer); this.state = "connected";
      this._pump = this._messageLoop().catch((e) => this._abort(e));
      return { ok: true, width: this.width, height: this.height, name: this.name, version: this.version, security: this.security };
    } catch (e) { clearTimeout(timer); this._abort(e); throw e; }
  }
  _openTransport() {
    const o = this.opts;
    if (o.transport === "ws" || o.wsUrl) {
      return connectWs(o.wsUrl, { protocols: ["binary"], timeoutMs: o.connectTimeoutMs, rejectUnauthorized: o.rejectUnauthorized === true }).then((ws) => {
        this.ws = ws; this.transport = { write: (b) => ws.send(b), close: () => ws.close() };
        ws.on("message", (m) => { if (Buffer.isBuffer(m)) this.reader.push(m); else this.reader.push(Buffer.from(m, "latin1")); }); ws.on("close", () => this._onClosed()); ws.on("error", (e) => this._abort(e));
      });
    }
    return new Promise((resolve, reject) => {
      const s = net.connect({ host: o.host, port: o.port }); s.setNoDelay(true); this.sock = s;
      s.once("connect", () => { this.transport = { write: (b) => s.write(b), close: () => s.destroy() }; resolve(); });
      s.on("data", (d) => this.reader.push(d)); s.on("close", () => this._onClosed()); s.on("error", (e) => { reject(e); this._abort(e); });
    });
  }
  _onClosed() { if (this.closed) return; this.closed = true; this.state = "closed"; this.reader.fail(new Error("RFB 連線已關閉")); this.emit("close"); for (const w of this._waiters.splice(0)) w.resolve({ closed: true }); }
  _abort(e) { if (this.closed && this.state === "closed") return; this.reader.fail(e); try { this.transport && this.transport.close(); } catch (_) { /* */ } this.closed = true; this.state = "closed"; if (this.listenerCount("error")) this.emit("error", e); for (const w of this._waiters.splice(0)) w.resolve({ closed: true, error: String(e.message || e) }); }
  close() { if (this.closed) return; this.closed = true; this.state = "closed"; try { this.transport && this.transport.close(); } catch (_) { /* */ } this.reader.fail(new Error("closed")); for (const w of this._waiters.splice(0)) w.resolve({ closed: true }); this.emit("close"); }

  async _handshake() {
    const r = this.reader, banner = (await r.read(12)).toString("latin1"), m = /^RFB (\d{3})\.(\d{3})\n$/.exec(banner);
    if (!m) throw new Error("對方不是 RFB（VNC）伺服器（開頭是 " + JSON.stringify(banner.replace(/[^\x20-\x7e]/g, "?")) + "）");
    const major = +m[1], minor = +m[2]; this.version = m[1] + "." + m[2];
    const use = major > 3 || minor >= 8 ? 8 : minor === 7 ? 7 : 3; this._write(Buffer.from("RFB 003.00" + (use === 3 ? 3 : use) + "\n", "latin1")); this.protocol = use;
    let secType;
    if (use === 3) { secType = (await r.read(4)).readUInt32BE(0); this.serverSecurityTypes = [secType]; if (secType === 0) throw new Error("伺服器拒絕連線：" + (await this._readReason())); }
    else {
      const n = (await r.read(1))[0]; if (n === 0) throw new Error("伺服器拒絕連線：" + (await this._readReason()));
      const types = Array.from(await r.read(n)); this.serverSecurityTypes = types;
      const havePw = !!(this.opts.password || this.opts.getPassword);
      secType = havePw && types.includes(2) ? 2 : types.includes(1) ? 1 : types.includes(2) ? 2 : null;
      if (secType == null) throw new Error("這個伺服器要求的安全類型這個用戶端不支援：" + describeSecurity(types) + "。請把伺服器設成「None」或「VNC 驗證」（例如 x11vnc 不加 -ssl、TigerVNC 的 SecurityTypes=VncAuth），或改走視覺模型的慢路徑。");
      this._write(Buffer.from([secType]));
    }
    this.security = SECURITY_NAMES[secType] || "type " + secType;
    if (secType === 2) {
      const challenge = await r.read(16); let pw = this.opts.password; if (pw == null && this.opts.getPassword) pw = await this.opts.getPassword();
      if (pw == null || pw === "") throw new Error("伺服器需要 VNC 密碼，但沒有提供（remote_connect 的 secretName，或環境變數 FA_VNC_PASSWORD_<名稱>）");
      this._write(codec.vncAuthResponse(challenge, pw)); pw = null;
    } else if (secType !== 1) throw new Error("不支援的安全類型 " + secType + "（" + this.security + "）");
    if (secType === 2 || use === 8) {
      const res = (await r.read(4)).readUInt32BE(0);
      if (res !== 0) { let why = "驗證失敗"; if (use === 8) { try { why = await this._readReason(); } catch (_) { /* */ } } throw new Error("RFB 驗證失敗：" + why + (secType === 2 ? "（密碼錯誤？）" : "")); }
    }
    this._write(Buffer.from([this.opts.shared === false ? 0 : 1]));
    const si = await r.read(20); this.width = si.readUInt16BE(0); this.height = si.readUInt16BE(2);
    this.serverPixelFormat = { bpp: si[4], depth: si[5], bigEndian: !!si[6], trueColor: !!si[7], rmax: si.readUInt16BE(8), gmax: si.readUInt16BE(10), bmax: si.readUInt16BE(12), rshift: si[14], gshift: si[15], bshift: si[16] };
    const nameLen = (await r.read(4)).readUInt32BE(0); this.name = (await r.read(Math.min(nameLen, 4096))).toString("utf8");
    this.fb = new Uint8Array(this.width * this.height * 4);
    // 協商：32bpp、depth 24、小端、真彩色、每色 255、位移 0/8/16 → 記憶體順序 R,G,B,X
    const pf = Buffer.alloc(20); pf[0] = 0; pf[4] = 32; pf[5] = 24; pf[6] = 0; pf[7] = 1; pf.writeUInt16BE(255, 8); pf.writeUInt16BE(255, 10); pf.writeUInt16BE(255, 12); pf[14] = 0; pf[15] = 8; pf[16] = 16;
    this._write(pf);
    const encs = [ENC.ZRLE, ENC.HEXTILE, ENC.RRE, ENC.COPYRECT, ENC.RAW, ENC.CURSOR, ENC.DESKTOPSIZE, ENC.EXT_DESKTOPSIZE], se = Buffer.alloc(4 + encs.length * 4); se[0] = 2; se.writeUInt16BE(encs.length, 2); encs.forEach((e, i) => se.writeInt32BE(e, 4 + i * 4)); this._write(se);
    this.requestUpdate(false);
  }
  async _readReason() { const len = (await this.reader.read(4)).readUInt32BE(0); return (await this.reader.read(Math.min(len, 2000))).toString("utf8"); }

  requestUpdate(incremental, rect) {
    const x = rect ? rect.x : 0, y = rect ? rect.y : 0, w = rect ? rect.w : this.width, h = rect ? rect.h : this.height, b = Buffer.alloc(10);
    b[0] = 3; b[1] = incremental ? 1 : 0; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); b.writeUInt16BE(w, 6); b.writeUInt16BE(h, 8); this._write(b);
  }

  // ---------- 伺服器訊息 ----------
  async _messageLoop() {
    const r = this.reader;
    for (;;) {
      const type = (await r.read(1))[0];
      if (type === 0) await this._framebufferUpdate();
      else if (type === 1) { const h = await r.read(5); const n = h.readUInt16BE(3); await r.read(n * 6); }
      else if (type === 2) this.emit("bell");
      else if (type === 3) { const h = await r.read(7), len = h.readUInt32BE(3); const text = (await r.read(Math.min(len, 1 << 20))).toString("latin1"); this.emit("clipboard", text); }
      else throw new Error("未知的伺服器訊息類型 " + type);
    }
  }
  async _framebufferUpdate() {
    const r = this.reader, h = await r.read(3), n = h.readUInt16BE(1), upd = { t: Date.now(), rects: [], copyrects: [], cursor: false, resized: false, rectCount: n };
    for (let i = 0; i < n; i++) {
      const rh = await r.read(12), x = rh.readUInt16BE(0), y = rh.readUInt16BE(2), w = rh.readUInt16BE(4), hh = rh.readUInt16BE(6), enc = rh.readInt32BE(8);
      if (enc === ENC.LASTRECT) break;
      if (enc === ENC.CURSOR) { await this._cursor(x, y, w, hh); upd.cursor = true; continue; }
      if (enc === ENC.DESKTOPSIZE) { if (this._resize(w, hh)) upd.resized = true; continue; }
      // ExtendedDesktopSize：x＝原因（0 伺服器自己、1 這個用戶端要求、2 別的用戶端）、y＝結果碼；伺服器在初始與每次螢幕配置變動時都會送，尺寸沒變就不要動畫面（否則會清掉畫面又無限要求重畫）
      if (enc === ENC.EXT_DESKTOPSIZE) { const hd = await r.read(4), ns = hd[0]; await r.read(ns * 16); if (this._resize(w, hh)) upd.resized = true; continue; }
      if (x + w > this.width || y + hh > this.height) throw new Error("矩形超出畫面：" + x + "," + y + " " + w + "x" + hh);
      switch (enc) {
        case ENC.RAW: await this._raw(x, y, w, hh); break;
        case ENC.COPYRECT: { const sx = (await r.read(4)); const src = { x: sx.readUInt16BE(0), y: sx.readUInt16BE(2) }; this._copyRect(src.x, src.y, x, y, w, hh); upd.copyrects.push({ src, dst: { x, y, w, h: hh } }); break; }
        case ENC.RRE: await this._rre(x, y, w, hh); break;
        case ENC.HEXTILE: await this._hextile(x, y, w, hh); break;
        case ENC.ZRLE: { const len = (await r.read(4)).readUInt32BE(0), z = await r.read(len), inflated = this.inflater.push(z); codec.decodeZrle(inflated, x, y, w, hh, this.fb, this.width, 3); break; }
        default: throw new Error("伺服器送了沒有協商的編碼 " + enc);
      }
      upd.rects.push({ x, y, w, h: hh, enc });
    }
    if (upd.rects.length) this.hasFrame = true; // 有畫素的更新（只有 DesktopSize／游標之類的偽矩形不算）
    this.updateCount++; this.lastUpdateAt = upd.t; this.updates.push(upd); const cut = upd.t - this.opts.historyMs; while (this.updates.length && this.updates[0].t < cut) this.updates.shift(); if (this.updates.length > 400) this.updates.splice(0, this.updates.length - 400);
    this.emit("update", upd); const ws = this._waiters.splice(0); for (const w of ws) w.resolve(upd);
    if (this.opts.autoUpdate && !this.closed) this.requestUpdate(true);
  }
  _resize(w, h) { if (w === this.width && h === this.height) return false; this.width = w; this.height = h; this.fb = new Uint8Array(w * h * 4); this.requestUpdate(false); this.emit("resize", { width: w, height: h }); return true; }
  async _raw(x, y, w, h) {
    const d = await this.reader.read(w * h * 4), fb = this.fb, W = this.width;
    for (let row = 0; row < h; row++) { let q = ((y + row) * W + x) * 4, s = row * w * 4; for (let i = 0; i < w; i++, q += 4, s += 4) { fb[q] = d[s]; fb[q + 1] = d[s + 1]; fb[q + 2] = d[s + 2]; fb[q + 3] = 255; } }
  }
  _fill(x, y, w, h, c) { const fb = this.fb, W = this.width; for (let yy = y; yy < y + h; yy++) { let q = (yy * W + x) * 4; for (let i = 0; i < w; i++, q += 4) { fb[q] = c[0]; fb[q + 1] = c[1]; fb[q + 2] = c[2]; fb[q + 3] = 255; } } }
  _copyRect(sx, sy, dx, dy, w, h) {
    if (sx + w > this.width || sy + h > this.height) throw new Error("CopyRect 來源超出畫面");
    const tmp = new Uint8Array(w * h * 4), W = this.width, fb = this.fb;
    for (let row = 0; row < h; row++) tmp.set(fb.subarray(((sy + row) * W + sx) * 4, ((sy + row) * W + sx + w) * 4), row * w * 4);
    for (let row = 0; row < h; row++) fb.set(tmp.subarray(row * w * 4, (row + 1) * w * 4), ((dy + row) * W + dx) * 4);
  }
  async _rre(x, y, w, h) {
    const r = this.reader, hd = await r.read(8), n = hd.readUInt32BE(0), bg = [hd[4], hd[5], hd[6]]; this._fill(x, y, w, h, bg);
    if (n) { const d = await r.read(n * 12); for (let i = 0; i < n; i++) { const o = i * 12; this._fill(x + d.readUInt16BE(o + 4), y + d.readUInt16BE(o + 6), d.readUInt16BE(o + 8), d.readUInt16BE(o + 10), [d[o], d[o + 1], d[o + 2]]); } }
  }
  async _hextile(x0, y0, w, h) {
    const r = this.reader; let bg = [0, 0, 0], fg = [255, 255, 255];
    for (let ty = 0; ty < h; ty += 16) for (let tx = 0; tx < w; tx += 16) {
      const tw = Math.min(16, w - tx), th = Math.min(16, h - ty), sub = (await r.read(1))[0], X = x0 + tx, Y = y0 + ty;
      if (sub & 1) { await this._raw(X, Y, tw, th); continue; }
      if (sub & 2) { const c = await r.read(4); bg = [c[0], c[1], c[2]]; }
      if (sub & 4) { const c = await r.read(4); fg = [c[0], c[1], c[2]]; }
      this._fill(X, Y, tw, th, bg);
      if (sub & 8) {
        const ns = (await r.read(1))[0], coloured = !!(sub & 16), d = await r.read(ns * (coloured ? 6 : 2));
        for (let i = 0; i < ns; i++) { let o = i * (coloured ? 6 : 2), c = fg; if (coloured) { c = [d[o], d[o + 1], d[o + 2]]; o += 4; } const xy = d[o], wh = d[o + 1]; this._fill(X + (xy >> 4), Y + (xy & 15), (wh >> 4) + 1, (wh & 15) + 1, c); }
      }
    }
  }
  async _cursor(hotX, hotY, w, h) {
    const r = this.reader; if (!w || !h) { this.cursor = null; return; }
    const pix = await r.read(w * h * 4), maskRow = Math.ceil(w / 8), mask = await r.read(maskRow * h), rgba = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const q = (y * w + x) * 4, bit = (mask[y * maskRow + (x >> 3)] >> (7 - (x & 7))) & 1; rgba[q] = pix[q]; rgba[q + 1] = pix[q + 1]; rgba[q + 2] = pix[q + 2]; rgba[q + 3] = bit ? 255 : 0; }
    this.cursor = { w, h, hotX, hotY, rgba, serial: (this.cursor ? this.cursor.serial : 0) + 1, hash: PNG.fingerprint({ width: w, height: h, data: rgba }) };
  }

  // ---------- 等待更新 ----------
  waitForUpdate(timeoutMs) { return new Promise((resolve) => { if (this.closed) return resolve({ closed: true }); const w = { resolve: (v) => { clearTimeout(tm); resolve(v); } }; const tm = setTimeout(() => { const i = this._waiters.indexOf(w); if (i >= 0) this._waiters.splice(i, 1); resolve({ timedOut: true }); }, timeoutMs || 3000); this._waiters.push(w); }); }
  // 等到第一個帶畫素的更新（連線後的完整畫面）；伺服器常先送一個只有偽編碼（DesktopSize／游標）的更新，waitForUpdate 會被它提早喚醒
  async waitForFrame(timeoutMs) { const t0 = Date.now(); timeoutMs = timeoutMs || 5000; while (!this.hasFrame && !this.closed) { const left = timeoutMs - (Date.now() - t0); if (left <= 0) return { timedOut: true }; await this.waitForUpdate(Math.min(left, 500)); } return this.closed ? { closed: true } : { ok: true, waitedMs: Date.now() - t0 }; }
  // 等畫面安靜（quietMs 內沒有新更新）或到 maxMs
  async waitIdle(quietMs, maxMs) { const t0 = Date.now(); quietMs = quietMs || 300; maxMs = maxMs || 5000; for (;;) { const left = maxMs - (Date.now() - t0); if (left <= 0) return { idle: false }; const since = Date.now() - (this.lastUpdateAt || t0); if (since >= quietMs) return { idle: true, waitedMs: Date.now() - t0 }; const u = await this.waitForUpdate(Math.min(left, quietMs - since)); if (u.closed) return { closed: true }; } }

  // ---------- 影像 ----------
  getImage(rect) {
    const full = { width: this.width, height: this.height, data: this.fb };
    if (!rect) return { width: this.width, height: this.height, data: new Uint8Array(this.fb) };
    return PNG.crop(full, rect);
  }
  screenshot(o) {
    o = o || {}; let img = this.getImage(o.rect), rect = o.rect ? PNG.clampRect({ width: this.width, height: this.height }, o.rect) : { x: 0, y: 0, w: this.width, h: this.height }, scale = 1;
    if (o.cursor && this.cursor) { // 把游標畫上去（驗證游標形狀變化用）
      const px = this.pointer.x - this.cursor.hotX - rect.x, py = this.pointer.y - this.cursor.hotY - rect.y;
      for (let y = 0; y < this.cursor.h; y++) for (let x = 0; x < this.cursor.w; x++) { const q = (y * this.cursor.w + x) * 4; if (!this.cursor.rgba[q + 3]) continue; const X = px + x, Y = py + y; if (X < 0 || Y < 0 || X >= img.width || Y >= img.height) continue; const o2 = (Y * img.width + X) * 4; img.data[o2] = this.cursor.rgba[q]; img.data[o2 + 1] = this.cursor.rgba[q + 1]; img.data[o2 + 2] = this.cursor.rgba[q + 2]; }
    }
    if (o.maxSide) { const fw = PNG.fitWithin(img, o.maxSide); img = fw.img; scale = fw.scale; }
    return { ok: true, png: PNG.encodePng(img), width: img.width, height: img.height, origin: { x: rect.x, y: rect.y }, scale: { x: scale, y: scale }, rect, tool: "rfb", image: o.wantImage ? img : undefined };
  }

  // ---------- 輸入 ----------
  pointerEvent(x, y, mask) { x = Math.max(0, Math.min(this.width - 1, Math.round(x))); y = Math.max(0, Math.min(this.height - 1, Math.round(y))); const b = Buffer.alloc(6); b[0] = 5; b[1] = mask; b.writeUInt16BE(x, 2); b.writeUInt16BE(y, 4); this._write(b); this.pointer = { x, y, mask }; }
  keyEvent(keysym, down) { const b = Buffer.alloc(8); b[0] = 4; b[1] = down ? 1 : 0; b.writeUInt32BE(keysym >>> 0, 4); this._write(b); }
  clientCutText(text) { const t = Buffer.from(String(text), "latin1"), b = Buffer.alloc(8 + t.length); b[0] = 6; b.writeUInt32BE(t.length, 4); t.copy(b, 8); this._write(b); }
  async move(x, y) { this.pointerEvent(x, y, this.pointer.mask); }
  async click(x, y, button, count) {
    const mask = BUTTON_MASK[button || "left"] || 1; count = Math.max(1, Math.min(3, count || 1)); this.pointerEvent(x, y, 0); await sleep(30);
    for (let i = 0; i < count; i++) { this.pointerEvent(x, y, mask); await sleep(40); this.pointerEvent(x, y, 0); if (i < count - 1) await sleep(60); }
  }
  async drag(x, y, x2, y2, button) {
    const mask = BUTTON_MASK[button || "left"] || 1, steps = Math.max(2, Math.min(40, Math.ceil(Math.hypot(x2 - x, y2 - y) / 25)));
    this.pointerEvent(x, y, 0); await sleep(30); this.pointerEvent(x, y, mask); await sleep(80);
    for (let i = 1; i <= steps; i++) { this.pointerEvent(x + ((x2 - x) * i) / steps, y + ((y2 - y) * i) / steps, mask); await sleep(15); }
    await sleep(60); this.pointerEvent(x2, y2, 0);
  }
  async scroll(x, y, dx, dy) {
    this.pointerEvent(x, y, 0); await sleep(20);
    const tick = async (m, n) => { for (let i = 0; i < Math.min(50, n); i++) { this.pointerEvent(x, y, m); await sleep(8); this.pointerEvent(x, y, 0); await sleep(8); } };
    if (dy) await tick(dy > 0 ? BUTTON_MASK.wheelDown : BUTTON_MASK.wheelUp, Math.abs(dy)); if (dx) await tick(dx > 0 ? BUTTON_MASK.wheelRight : BUTTON_MASK.wheelLeft, Math.abs(dx));
  }
  async typeText(text, delayMs) { for (const ch of String(text)) { const ks = keysymForChar(ch); this.keyEvent(ks, true); await sleep(delayMs == null ? 8 : delayMs); this.keyEvent(ks, false); await sleep(delayMs == null ? 8 : delayMs); } }
  async keyChord(chord) { const syms = chordToKeysyms(chord); if (!syms) throw new Error("不認得的按鍵組合：" + chord); for (const s of syms) { this.keyEvent(s, true); await sleep(10); } for (const s of syms.slice().reverse()) { this.keyEvent(s, false); await sleep(10); } }
  releaseAll() { try { this.pointerEvent(this.pointer.x, this.pointer.y, 0); for (const k of [0xffe1, 0xffe2, 0xffe3, 0xffe4, 0xffe9, 0xffea, 0xffeb, 0xffec]) this.keyEvent(k, false); } catch (_) { /* */ } }
}

// ---------- 候選物件（RFB 沒有繪圖物件，從損壞矩形推） ----------
// updates：client.updates；opts：{ margin, minArea, maxObjects, sinceMs, screen:{w,h}（給了就會略過整個畫面重送的更新）, pointer, cursor }
// 回傳 [{ id, source:'rfb', kind:'damage'|'move'|'cursor', role:'unknown', rect, visible:true, count, animated, confidence }]
function deriveObjects(updates, o) {
  o = o || {}; const margin = o.margin == null ? 8 : o.margin, minArea = o.minArea || 16 * 16, now = o.now || Date.now(), since = o.sinceMs ? now - o.sinceMs : -Infinity;
  let regs = [];
  const area = (r) => r.w * r.h, near = (a, b) => a.x - margin < b.x + b.w && b.x - margin < a.x + a.w && a.y - margin < b.y + b.h && b.y - margin < a.y + a.h;
  const full = o.screen ? o.screen.w * o.screen.h * 0.85 : Infinity;
  for (const u of updates || []) {
    if (u.t < since) continue;
    if (u.rects.reduce((a, r) => a + r.w * r.h, 0) >= full) continue; // 整個畫面重送（初始或要求重繪）不是「哪裡變了」
    for (const r of u.rects) regs.push({ x: r.x, y: r.y, w: r.w, h: r.h, count: 1, times: [u.t], kind: "damage" });
    for (const c of u.copyrects) regs.push({ x: c.dst.x, y: c.dst.y, w: c.dst.w, h: c.dst.h, count: 1, times: [u.t], kind: "move", move: { dx: c.dst.x - c.src.x, dy: c.dst.y - c.src.y } });
  }
  // 反覆合併相鄰的矩形，直到穩定
  let changed = true;
  while (changed && regs.length > 1) {
    changed = false; const out = [];
    for (const r of regs) {
      const hit = out.find((q) => near(q, r) && (q.kind === r.kind || q.kind === "damage" || r.kind === "damage"));
      if (hit) { const x0 = Math.min(hit.x, r.x), y0 = Math.min(hit.y, r.y), x1 = Math.max(hit.x + hit.w, r.x + r.w), y1 = Math.max(hit.y + hit.h, r.y + r.h); hit.x = x0; hit.y = y0; hit.w = x1 - x0; hit.h = y1 - y0; hit.count += r.count; hit.times = hit.times.concat(r.times); if (r.kind === "move") { hit.kind = "move"; hit.move = r.move; } changed = true; }
      else out.push(Object.assign({}, r));
    }
    regs = out;
  }
  let objs = regs.filter((r) => area(r) >= minArea || r.kind === "move").map((r) => {
    const ts = r.times.slice().sort((a, b) => a - b), gaps = []; for (let i = 1; i < ts.length; i++) gaps.push(ts[i] - ts[i - 1]);
    const meanGap = gaps.length ? gaps.reduce((a, b) => a + b, 0) / gaps.length : 0, animated = r.count >= (o.animatedMin || 4) && meanGap > 0 && meanGap < (o.animatedGapMs || 1500);
    return { source: "rfb", kind: r.kind, role: animated ? "canvas" : "unknown", rect: { x: r.x, y: r.y, w: r.w, h: r.h }, visible: true, enabled: true, count: r.count, animated, updateIntervalMs: animated ? Math.round(meanGap) : null, move: r.move || null, confidence: Math.min(0.9, 0.3 + r.count * 0.1), name: "", states: [], actions: [] };
  });
  objs.sort((a, b) => b.count - a.count || area(b.rect) - area(a.rect)); objs = objs.slice(0, o.maxObjects || 30);
  if (o.pointer && o.cursor) objs.unshift({ source: "rfb", kind: "cursor", role: "unknown", rect: { x: o.pointer.x - o.cursor.hotX, y: o.pointer.y - o.cursor.hotY, w: o.cursor.w, h: o.cursor.h }, visible: true, enabled: true, count: 1, animated: false, confidence: 1, name: "cursor", states: [], actions: [], cursorHash: o.cursor.hash });
  const sid = o.sessionId || "rfb"; objs.forEach((x, i) => { x.id = sid + ":" + (i + 1); });
  return objs;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

module.exports = { RfbClient, ByteReader, deriveObjects, keysymForChar, keysymForName, chordToKeysyms, describeSecurity, ENC, BUTTON_MASK, SECURITY_NAMES };
