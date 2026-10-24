// computer-ws.js —— 最小的 WebSocket 用戶端（RFC 6455，只用 node 的 net／tls／crypto）。
// 為什麼自己寫：node_modules 裡沒有 ws，而 noVNC／websockify 的 RFB 轉接要用 WebSocket 傳二進位資料。
// 只做 computer use 需要的部分：ws:// 與 wss://、子協定、遮罩的用戶端 frame、分片重組、ping/pong、close。
"use strict";
const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { EventEmitter } = require("events");
const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function parseUrl(u) {
  const m = /^(wss?):\/\/([^/:?#]+|\[[^\]]+\])(?::(\d+))?([^?#]*)(\?[^#]*)?/i.exec(String(u || "")); if (!m) throw new Error("不是 ws:// 或 wss:// 網址：" + u);
  const secure = m[1].toLowerCase() === "wss";
  return { secure, host: m[2].replace(/^\[|\]$/g, ""), port: m[3] ? Number(m[3]) : secure ? 443 : 80, path: (m[4] || "/") + (m[5] || "") };
}
function encodeFrame(opcode, payload, mask) {
  const len = payload.length; let hdr;
  if (len < 126) hdr = Buffer.from([0x80 | opcode, (mask ? 0x80 : 0) | len]);
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | opcode; hdr[1] = (mask ? 0x80 : 0) | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | opcode; hdr[1] = (mask ? 0x80 : 0) | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  if (!mask) return Buffer.concat([hdr, payload]);
  const key = crypto.randomBytes(4), out = Buffer.alloc(len); for (let i = 0; i < len; i++) out[i] = payload[i] ^ key[i & 3];
  return Buffer.concat([hdr, key, out]);
}

// 事件：'message'(Buffer|string, isBinary)、'close'(code)、'error'(err)
class WsConn extends EventEmitter {
  constructor(sock, o) { super(); this.sock = sock; this.mask = o.mask !== false; this.buf = Buffer.alloc(0); this.frag = []; this.fragOp = 0; this.closed = false; this.protocol = o.protocol || ""; this.headers = o.headers || {}; sock.on("data", (d) => this._onData(d)); sock.on("close", () => this._onClose(1006)); sock.on("error", (e) => { if (this.listenerCount("error")) this.emit("error", e); else this._onClose(1006); }); }
  _onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    for (;;) {
      if (this.buf.length < 2) return;
      const b0 = this.buf[0], b1 = this.buf[1], fin = !!(b0 & 0x80), op = b0 & 0x0f, masked = !!(b1 & 0x80); let len = b1 & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; } else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      let key = null; if (masked) { if (this.buf.length < off + 4) return; key = this.buf.subarray(off, off + 4); off += 4; }
      if (this.buf.length < off + len) return;
      let payload = this.buf.subarray(off, off + len); this.buf = this.buf.subarray(off + len);
      if (key) { const p = Buffer.alloc(len); for (let i = 0; i < len; i++) p[i] = payload[i] ^ key[i & 3]; payload = p; }
      if (op === 0x8) { const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005; try { this.sock.write(encodeFrame(0x8, payload.subarray(0, 2), this.mask)); } catch (_) { /* */ } this._onClose(code); try { this.sock.end(); } catch (_) { /* */ } return; }
      if (op === 0x9) { try { this.sock.write(encodeFrame(0xA, payload, this.mask)); } catch (_) { /* */ } continue; }
      if (op === 0xA) continue;
      if (op === 0x0 || op === 0x1 || op === 0x2) {
        if (op !== 0x0) { this.fragOp = op; this.frag = []; } this.frag.push(payload);
        if (fin) { const all = this.frag.length === 1 ? this.frag[0] : Buffer.concat(this.frag); this.frag = []; this.emit("message", this.fragOp === 0x1 ? all.toString("utf8") : all, this.fragOp === 0x2); }
      }
    }
  }
  _onClose(code) { if (this.closed) return; this.closed = true; this.emit("close", code); }
  send(data) { if (this.closed) throw new Error("WebSocket 已關閉"); const isText = typeof data === "string", p = isText ? Buffer.from(data, "utf8") : Buffer.from(data); this.sock.write(encodeFrame(isText ? 0x1 : 0x2, p, this.mask)); }
  close() { if (this.closed) return; try { this.sock.write(encodeFrame(0x8, Buffer.from([0x03, 0xe8]), this.mask)); this.sock.end(); } catch (_) { /* */ } setTimeout(() => { try { this.sock.destroy(); } catch (_) { /* */ } this._onClose(1000); }, 200).unref(); }
}

// 連線並升級。opts：{ protocols:['binary'], headers:{}, rejectUnauthorized:false, timeoutMs }
function connectWs(url, opts) {
  opts = opts || {}; const u = parseUrl(url);
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString("base64"); let done = false, head = Buffer.alloc(0);
    const sock = u.secure ? tls.connect({ host: u.host, port: u.port, servername: net.isIP(u.host) ? undefined : u.host, rejectUnauthorized: opts.rejectUnauthorized === true }) : net.connect({ host: u.host, port: u.port });
    const finish = (err, v) => { if (done) return; done = true; clearTimeout(timer); sock.removeListener("data", onData); if (err) { try { sock.destroy(); } catch (_) { /* */ } reject(err); } else resolve(v); };
    const timer = setTimeout(() => finish(new Error("WebSocket 連線逾時")), opts.timeoutMs || 8000);
    const onData = (d) => {
      head = Buffer.concat([head, d]); const i = head.indexOf("\r\n\r\n"); if (i < 0) { if (head.length > 16384) finish(new Error("WebSocket 回應標頭過大")); return; }
      const text = head.subarray(0, i).toString("latin1"), rest = head.subarray(i + 4), lines = text.split("\r\n"), status = /^HTTP\/1\.[01] (\d{3})/.exec(lines[0]);
      const h = {}; for (const l of lines.slice(1)) { const k = l.indexOf(":"); if (k > 0) h[l.slice(0, k).trim().toLowerCase()] = l.slice(k + 1).trim(); }
      if (!status || status[1] !== "101") return finish(new Error("WebSocket 升級失敗：" + lines[0].slice(0, 80)), null);
      const want = crypto.createHash("sha1").update(key + GUID).digest("base64"); if (h["sec-websocket-accept"] !== want) return finish(new Error("WebSocket 驗證碼不符"));
      sock.removeListener("data", onData); const conn = new WsConn(sock, { protocol: h["sec-websocket-protocol"], headers: h }); finish(null, conn); if (rest.length) setImmediate(() => conn._onData(rest)); // 標頭後面緊接的資料：等呼叫端掛好 message 監聽再送
    };
    sock.on("error", (e) => finish(e)); sock.on("close", () => finish(new Error("連線被關閉")));
    sock.on(u.secure ? "secureConnect" : "connect", () => {
      const hdrs = ["GET " + u.path + " HTTP/1.1", "Host: " + u.host + ":" + u.port, "Upgrade: websocket", "Connection: Upgrade", "Sec-WebSocket-Key: " + key, "Sec-WebSocket-Version: 13"];
      if (opts.protocols && opts.protocols.length) hdrs.push("Sec-WebSocket-Protocol: " + opts.protocols.join(", "));
      for (const [k, v] of Object.entries(opts.headers || {})) hdrs.push(k + ": " + v);
      sock.write(hdrs.join("\r\n") + "\r\n\r\n");
    });
    sock.on("data", onData);
  });
}

// 伺服器端升級（測試用／fixture）：回傳 101 回應字串
const acceptHeader = (clientKey, protocol) => "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + crypto.createHash("sha1").update(clientKey + GUID).digest("base64") + (protocol ? "\r\nSec-WebSocket-Protocol: " + protocol : "") + "\r\n\r\n";

module.exports = { connectWs, WsConn, encodeFrame, parseUrl, acceptHeader, GUID };
