// computer-remote.js —— 「目標是畫布」（遠端桌面、VNC、KVM／QEMU 主控台、RDP、NoMachine、瀏覽器裡的 noVNC）的處理：
//   1. 偵測哪些視窗其實是畫布（行程名稱／類別／標題），這種視窗沒有無障礙物件，只能走 OS 輸入＋視覺模型。
//   2. 協定探測：給 host:port（或 ws:// 網址）判斷對面講的是 RFB／RDP／NX／SPICE／SSH／HTTP(noVNC、Guacamole)，並說清楚能做到什麼程度。
//   3. remoteTarget 抽象：{ kind:'window'|'rfb'|'rdp'|'nx'|'spice'|'canvas', capabilities:{ objects:'protocol'|'a11y'|'vlm', input:'os'|'protocol' } }，
//      讓 AI 工具層不用在意目標是本機視窗還是 VNC 連線。
// 老實說（見 DESIGN.computer-use.md）：真正做到「協定層取得繪圖物件」的只有 RFB（rfb-client.js，從損壞矩形／CopyRect／游標推候選區）；
// RDP／NX／SPICE 目前只做到「辨識協定與安全等級」，要取得畫面內容需要完整用戶端（xfreerdp 等）開出視窗，之後走視覺模型的慢路徑。
"use strict";
const net = require("net");
const tls = require("tls");
const { connectWs } = require("./computer-ws.js");

const REMOTE_KINDS = ["window", "rfb", "rdp", "nx", "spice", "canvas"];
const OBJECT_SOURCES = ["protocol", "a11y", "vlm"];
const INPUT_PATHS = ["os", "protocol"];
function makeRemoteTarget(o) {
  o = o || {}; const kind = REMOTE_KINDS.includes(o.kind) ? o.kind : "window", cap = o.capabilities || {};
  return { id: String(o.id || ""), kind, label: String(o.label || ""), capabilities: { objects: OBJECT_SOURCES.includes(cap.objects) ? cap.objects : "vlm", input: INPUT_PATHS.includes(cap.input) ? cap.input : "os" }, notes: o.notes || [], window: o.window || null, endpoint: o.endpoint || null };
}

// ---------- 視窗是不是遠端畫面的畫布 ----------
const CANVAS_PROCS = [
  { re: /^(mstsc|msrdc|mstsc\.exe|msrdc\.exe|wfreerdp|xfreerdp|xfreerdp3|wlfreerdp|sdl-freerdp|sdl-freerdp3|freerdp|rdesktop|krdc|gnome-connections)(\.exe)?$/i, kind: "rdp", client: "RDP 用戶端" },
  { re: /^(remmina)$/i, kind: "remote-desktop", client: "Remmina（RDP／VNC／SPICE 等）" },
  { re: /^(vncviewer|vncviewer64|xtightvncviewer|xvnc4viewer|tigervnc|tvnviewer|vncviewer\.exe|realvnc|vnc-viewer|vinagre|krdc|x11vnc-viewer|vncpasswd-viewer|ssvnc)(\.exe)?$/i, kind: "vnc", client: "VNC 用戶端" },
  { re: /^(virt-viewer|virt-manager|remote-viewer|spicy|spice-gtk|spice-vdagent|virt-viewer\.exe)(\.exe)?$/i, kind: "spice", client: "SPICE／libvirt 主控台" },
  { re: /^(qemu(-system-[\w-]+)?|qemu-kvm|kvm|vboxheadless|virtualboxvm|virtualbox|vmware|vmplayer|vmware-vmx|vmware-view|vmrc|prlclient|prl_client_app|looking-glass-client|vmconnect|vmwp)(\.exe)?$/i, kind: "kvm", client: "虛擬機主控台" },
  { re: /^(nxplayer|nxclient|nxagent|nomachine|nxplayer\.bin|nxplayer\.exe)(\.exe)?$/i, kind: "nx", client: "NoMachine" },
  { re: /^(x2goclient|x2go|anydesk|teamviewer|rustdesk|parsecd|moonlight|wfica|wfica_wrapper|citrix|cdviewer|horizon-client|vmware-view|zoom|chrome-remote-desktop|remotely)(\.exe)?$/i, kind: "remote-desktop", client: "遠端桌面／串流用戶端" },
];
const BROWSER_PROCS = /^(firefox|firefox-esr|chrome|google-chrome|chromium|chromium-browser|msedge|microsoft-edge|brave|brave-browser|vivaldi|opera|librewolf|epiphany|safari)(\.exe)?$/i;
const CANVAS_TITLE = /(noVNC|Guacamole|KasmVNC|spice-html5|TightVNC|UltraVNC|Proxmox.*(Console|noVNC|SPICE)|(vSphere|ESXi|vCenter).*(Console|Remote)|MeshCentral|Chrome Remote Desktop|Azure.*(Bastion|Virtual Desktop)|AWS.*(Session Manager|Workspaces)|Cockpit.*Console|OpenStack.*Console|Remote Desktop|遠端桌面|遠端連線|ThinLinc|Splashtop|Jump Desktop|RustDesk|NoMachine|NX Web|XPRA|Xpra|webtop)/i;
const CANVAS_CLASS = /(TscShellContainerClass|RAIL_WINDOW|UIMainClass|TSMainClass|Vncviewer|vncviewer|FLTK|virt-viewer|Remmina|freerdp|FreeRDP|nxplayer|spicy|QEMU|Qemu|VirtualBox|vmware|VMware|XTightVNC|TightVNC)/;
function classifyWindow(w) {
  w = w || {}; const proc = String(w.process || w.processName || "").replace(/\.exe$/i, ""), title = String(w.title || ""), cls = String(w.class || w.className || "");
  for (const p of CANVAS_PROCS) if (p.re.test(proc)) return { canvas: true, kind: p.kind, client: p.client, reason: "行程名稱 " + proc, confidence: 0.95, capabilities: { objects: "vlm", input: "os" } };
  if (BROWSER_PROCS.test(proc) && CANVAS_TITLE.test(title)) return { canvas: true, kind: "browser-canvas", client: "瀏覽器分頁（canvas）", reason: "瀏覽器視窗標題像遠端桌面頁面：" + title.slice(0, 40), confidence: 0.7, capabilities: { objects: "vlm", input: "os" } };
  if (CANVAS_CLASS.test(cls)) return { canvas: true, kind: "remote-desktop", client: "視窗類別 " + cls, reason: "視窗類別 " + cls, confidence: 0.8, capabilities: { objects: "vlm", input: "os" } };
  if (!proc && CANVAS_TITLE.test(title)) return { canvas: true, kind: "remote-desktop", client: "標題比對", reason: "視窗標題 " + title.slice(0, 40), confidence: 0.5, capabilities: { objects: "vlm", input: "os" } };
  return { canvas: false };
}

// ---------- 目標字串 ----------
function parseTarget(t) {
  if (t && typeof t === "object") return { host: t.host, port: t.port ? Number(t.port) : undefined, wsUrl: t.wsUrl || t.url, display: t.display };
  const s = String(t || "").trim(); if (/^wss?:\/\//i.test(s)) return { wsUrl: s };
  if (/^https?:\/\//i.test(s)) { try { const u = new URL(s); return { httpUrl: s, host: u.hostname, port: Number(u.port) || (u.protocol === "https:" ? 443 : 80), https: u.protocol === "https:" }; } catch (_) { return { error: "網址格式不對" }; } }
  const v = /^vnc:\/\/([^/:]+)(?::(\d+))?/i.exec(s); if (v) { let vp = v[2] ? Number(v[2]) : 5900; if (vp < 100) vp += 5900; return { host: v[1], port: vp }; }
  let m = /^(?:\[([^\]]+)\]|([^:\s]+))::(\d+)$/.exec(s); // host::5901（VNC 慣例，雙冒號＝實際埠）
  if (m) return { host: m[1] || m[2], port: Number(m[3]) };
  m = /^(?:\[([^\]]+)\]|([^:\s]+))(?::(\d+))?$/.exec(s); // host、host:port、host:1（顯示編號 0~99 → 5900+n）
  if (!m) return { error: "不是 host:port 或 ws:// 網址" };
  let port = m[3] ? Number(m[3]) : undefined; if (port != null && port < 100) port += 5900;
  return { host: m[1] || m[2], port };
}

// ---------- 各協定的封包（純函式，fixture 可測） ----------
// RDP X.224 Connection Request（TPKT＋X.224 CR＋RDP_NEG_REQ）
function buildRdpRequest(protocols, cookie) {
  const ck = Buffer.from("Cookie: mstshash=" + (cookie || "probe") + "\r\n", "latin1"), neg = Buffer.alloc(8); neg[0] = 1; neg[1] = 0; neg.writeUInt16LE(8, 2); neg.writeUInt32LE(protocols >>> 0, 4);
  const li = 6 + ck.length + (protocols === null ? 0 : 8), x224 = Buffer.concat([Buffer.from([li, 0xe0, 0, 0, 0, 0, 0]), ck, protocols === null ? Buffer.alloc(0) : neg]), len = 4 + x224.length;
  return Buffer.concat([Buffer.from([3, 0, (len >> 8) & 255, len & 255]), x224]);
}
const RDP_PROTOCOLS = { 0: "Standard RDP Security（RC4，舊式）", 1: "TLS（SSL）", 2: "CredSSP／NLA（HYBRID）", 4: "RDSTLS", 8: "CredSSP／NLA＋Early User Authorization（HYBRID_EX）" };
const RDP_FAILURES = { 1: "伺服器要求 TLS（SSL_REQUIRED_BY_SERVER）", 2: "伺服器不允許 TLS（SSL_NOT_ALLOWED_BY_SERVER）", 3: "伺服器沒有 TLS 憑證（SSL_CERT_NOT_ON_SERVER）", 4: "旗標不一致（INCONSISTENT_FLAGS）", 5: "伺服器要求 NLA（HYBRID_REQUIRED_BY_SERVER）", 6: "要求 TLS 並使用者驗證（SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER）" };
function parseRdpResponse(buf) {
  if (!buf || buf.length < 11 || buf[0] !== 3 || buf[1] !== 0) return null;
  const tlen = buf.readUInt16BE(2); if (tlen < 11 || buf.length < Math.min(tlen, 11)) return null;
  const code = buf[5] & 0xf0; if (code !== 0xd0 && code !== 0x80) return code === 0xe0 ? { ok: false, error: "對方回的是 Connection Request（不是 RDP 伺服器）" } : null; // 0xD0＝Connection Confirm
  const out = { ok: true, kind: "rdp", tpktLength: tlen, negotiated: false };
  if (code === 0x80) { out.disconnect = true; return out; }
  if (buf.length >= 19 && (buf[11] === 2 || buf[11] === 3)) {
    out.negotiated = true; out.negType = buf[11]; out.flags = buf[12]; const v = buf.readUInt32LE(15);
    if (buf[11] === 2) { out.selected = v; out.selectedName = RDP_PROTOCOLS[v] || "未知(" + v + ")"; out.flagsInfo = { extendedClientData: !!(buf[12] & 1), gfxEx: !!(buf[12] & 2), restrictedAdmin: !!(buf[12] & 8), authRequired: !!(buf[12] & 16) }; }
    else { out.failure = v; out.failureName = RDP_FAILURES[v] || "未知失敗碼 " + v; }
  } else { out.selected = 0; out.selectedName = RDP_PROTOCOLS[0]; } // 沒有 negotiation 回應＝Standard RDP Security
  return out;
}
// SPICE link：header（"REDQ"，major 2，minor 2，size）＋ SpiceLinkMess（連線 id、通道型別 main、通道 id 0、共通能力數…）
function buildSpiceLink() {
  const caps = Buffer.alloc(4); caps.writeUInt32LE(0x0b, 0); // 共通能力：AUTH_SELECTION | AUTH_SPICE | MINI_HEADER
  const mess = Buffer.alloc(18); mess.writeUInt32LE(0, 0); mess[4] = 1; mess[5] = 0; mess.writeUInt32LE(1, 6); mess.writeUInt32LE(0, 10); mess.writeUInt32LE(18, 14);
  const body = Buffer.concat([mess, caps]), hdr = Buffer.alloc(16); hdr.write("REDQ", 0, "latin1"); hdr.writeUInt32LE(2, 4); hdr.writeUInt32LE(2, 8); hdr.writeUInt32LE(body.length, 12);
  return Buffer.concat([hdr, body]);
}
function parseSpiceReply(buf) {
  if (!buf || buf.length < 16 || buf.toString("latin1", 0, 4) !== "REDQ") return null;
  const out = { ok: true, kind: "spice", major: buf.readUInt32LE(4), minor: buf.readUInt32LE(8), size: buf.readUInt32LE(12) };
  if (buf.length >= 20) { out.linkError = buf.readUInt32LE(16); out.linkErrorName = { 0: "OK", 1: "ERROR", 2: "INVALID_MAGIC", 3: "INVALID_DATA", 4: "VERSION_MISMATCH", 5: "NEED_SECURED", 6: "NEED_UNSECURED", 7: "PERMISSION_DENIED", 8: "BAD_CONNECTION_ID", 9: "CHANNEL_NOT_AVAILABLE" }[out.linkError] || "未知"; }
  return out;
}
// 伺服器「先開口」的橫幅
function classifyBanner(buf) {
  const s = Buffer.from(buf || []).toString("latin1");
  let m = /^RFB (\d{3})\.(\d{3})\n/.exec(s); if (m) return { kind: "rfb", version: m[1] + "." + m[2], banner: s.slice(0, 12) };
  if (/^SSH-\d/.test(s)) return { kind: "ssh", banner: s.split("\n")[0].slice(0, 80) };
  if (/^NXD-|^NX> \d{3}|^NXSSH/.test(s)) return { kind: "nx", banner: s.split("\n")[0].slice(0, 80) };
  if (/^HTTP\/1\.[01] \d{3}/.test(s)) return { kind: "http", banner: s.split("\r\n")[0].slice(0, 80) };
  if (/^(220[ -]|\+OK|\* OK)/.test(s)) return { kind: "other-service", banner: s.split("\n")[0].slice(0, 80) };
  return null;
}
function classifyHttpBody(text) {
  const t = String(text || "");
  if (/guacamole/i.test(t)) return { web: "guacamole", note: "Apache Guacamole：用 HTTP tunnel 傳 guacd 協定，不是 RFB；瀏覽器分頁裡是 canvas，走視覺模型慢路徑（或直接連它後面的 VNC／RDP）" };
  if (/noVNC|websockify/i.test(t)) return { web: "novnc", note: "noVNC 頁面：底層是 WebSocket 上的 RFB，可用 ws:// 網址（常見路徑 /websockify）直接探測與連線" };
  if (/kasmvnc|kasm/i.test(t)) return { web: "kasmvnc", note: "KasmVNC（RFB 的變體，自訂編碼）" };
  if (/spice-html5|spice html5/i.test(t)) return { web: "spice-html5", note: "SPICE HTML5 用戶端（WebSocket 上的 SPICE）" };
  if (/proxmox/i.test(t)) return { web: "proxmox", note: "Proxmox 主控台（noVNC／SPICE，需要登入 ticket）" };
  return { web: "other" };
}

// ---------- 網路探測 ----------
function tcpExchange(host, port, send, o) {
  o = o || {};
  return new Promise((resolve) => {
    const chunks = []; let settled = false, sock;
    const done = (err) => { if (settled) return; settled = true; clearTimeout(tm); try { sock.destroy(); } catch (_) { /* */ } resolve({ data: Buffer.concat(chunks), error: err ? String(err.code || err.message || err) : null }); };
    const tm = setTimeout(() => done(null), o.waitMs || 800);
    const connectOpts = { host, port };
    sock = o.tls ? tls.connect(Object.assign({ servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false }, connectOpts)) : net.connect(connectOpts);
    sock.on(o.tls ? "secureConnect" : "connect", () => { if (send) { try { sock.write(send); } catch (_) { /* */ } } if (o.tls) o.tlsInfo = { protocol: sock.getProtocol && sock.getProtocol(), cipher: sock.getCipher && sock.getCipher().name, subject: (sock.getPeerCertificate && (sock.getPeerCertificate() || {}).subject) || null }; });
    sock.on("data", (d) => { chunks.push(d); if (o.stopAfter && Buffer.concat(chunks).length >= o.stopAfter) done(null); });
    sock.on("error", (e) => done(e)); sock.on("close", () => done(null));
  });
}

async function listRfbSecurity(host, port, o) {
  // 讀完 banner 後回 3.8 版本字串，看伺服器列出的安全類型（不真的登入）
  return new Promise((resolve) => {
    const sock = net.connect({ host, port }); let buf = Buffer.alloc(0), stage = 0, settled = false, this_minor = 8;
    const done = (r) => { if (settled) return; settled = true; clearTimeout(tm); try { sock.destroy(); } catch (_) { /* */ } resolve(r); }, tm = setTimeout(() => done({ types: null, error: "逾時" }), (o && o.waitMs) || 1500);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      if (stage === 0 && buf.length >= 12) { const m = /^RFB (\d{3})\.(\d{3})\n/.exec(buf.toString("latin1", 0, 12)); if (!m) return done({ types: null }); const minor = +m[2]; buf = buf.subarray(12); stage = 1; sock.write(Buffer.from("RFB 003.00" + (minor >= 8 ? 8 : minor === 7 ? 7 : 3) + "\n")); this_minor = minor; }
      if (stage === 1) {
        if (this_minor < 7) { if (buf.length >= 4) done({ types: [buf.readUInt32BE(0)] }); return; }
        if (buf.length >= 1) { const n = buf[0]; if (n === 0) return done({ types: [], refused: true }); if (buf.length >= 1 + n) done({ types: Array.from(buf.subarray(1, 1 + n)) }); }
      }
    });
    sock.on("error", (e) => done({ types: null, error: String(e.code || e.message) })); sock.on("close", () => done({ types: null }));
  });
}

// target：字串或 { host, port, wsUrl }；opts：{ timeoutMs, which(bin) }
async function probeRemote(target, opts) {
  opts = opts || {}; const t = parseTarget(target), result = { ok: true, target: t, kind: "unknown", details: {}, capabilities: { objects: "vlm", input: "os" }, advice: [], steps: [] };
  const step = (s) => result.steps.push(s);
  if (t.error) return Object.assign(result, { ok: false, error: t.error });
  const finish = (r) => r || result;
  const freerdp = () => { const w = opts.which || (() => ""); return { xfreerdp: w("xfreerdp") || w("xfreerdp3") || "", wlfreerdp: w("wlfreerdp") || w("wlfreerdp3") || "", shadow: w("freerdp-shadow-cli") || w("freerdp-shadow-cli3") || "" }; };
  // ----- WebSocket（noVNC／websockify） -----
  if (t.wsUrl) {
    try {
      const ws = await connectWs(t.wsUrl, { protocols: ["binary"], timeoutMs: opts.timeoutMs || 4000 });
      const first = await new Promise((res) => { const tm = setTimeout(() => res(null), 1500); ws.once("message", (m) => { clearTimeout(tm); res(Buffer.isBuffer(m) ? m : Buffer.from(String(m))); }); });
      ws.close(); step("WebSocket 升級成功，子協定=" + (ws.protocol || "(無)"));
      const b = first && classifyBanner(first);
      if (b && b.kind === "rfb") { Object.assign(result, { kind: "rfb" }); result.details = { transport: "websocket", version: b.version, wsUrl: t.wsUrl }; result.capabilities = { objects: "protocol", input: "protocol" }; result.advice.push("RFB over WebSocket：用內建 RFB 用戶端連線（remote_connect kind:'rfb', wsUrl）。RFB 沒有繪圖物件，物件是從損壞矩形／CopyRect／游標推出來的候選區，內容由視覺模型命名。"); return finish(); }
      result.kind = "websocket"; result.details = { transport: "websocket", firstMessage: first ? first.toString("latin1", 0, 40).replace(/[^\x20-\x7e]/g, ".") : null }; result.advice.push("WebSocket 可以連，但第一個訊息不是 RFB 橫幅；可能是 Guacamole／SPICE-HTML5／其他協定。走視覺模型慢路徑。"); return finish();
    } catch (e) { return Object.assign(result, { ok: false, error: "WebSocket 連線失敗：" + String(e.message || e) }); }
  }
  if (!t.host) return Object.assign(result, { ok: false, error: "沒有 host" });
  const host = t.host, port = t.port || 5900; result.target.port = port;
  // ----- 1. 伺服器先開口（RFB／SSH／NX） -----
  const p1 = await tcpExchange(host, port, null, { waitMs: opts.bannerWaitMs || 700 });
  if (p1.error && !p1.data.length) { step("TCP 連線失敗：" + p1.error); return Object.assign(result, { ok: false, kind: "closed", error: "連不上 " + host + ":" + port + "（" + p1.error + "）", advice: ["確認位址、埠與防火牆；VNC 預設 5900＋顯示編號，RDP 3389，SPICE 5900 起，NoMachine 4000。"] }); }
  const b = classifyBanner(p1.data); if (b) step("伺服器先送出橫幅：" + b.kind);
  if (b && b.kind === "rfb") {
    const sec = await listRfbSecurity(host, port), types = sec.types || [], names = require("./rfb-client.js").describeSecurity(types);
    const usable = types.includes(1) || types.includes(2);
    result.kind = "rfb"; result.details = { version: b.version, securityTypes: types, securityNames: names, supported: usable, transport: "tcp" };
    result.capabilities = usable ? { objects: "protocol", input: "protocol" } : { objects: "vlm", input: "os" };
    result.advice.push(usable ? "RFB（VNC）" + b.version + "：內建用戶端可直接連線（安全類型 " + names + "）。RFB 沒有繪圖物件；物件是從損壞矩形、CopyRect 搬移、游標形狀推出的候選區，由視覺模型命名並用「移動滑鼠→拍照→比對」驗證。" : "RFB 伺服器只提供這個用戶端不支援的安全類型（" + (names || "無") + "）：請把伺服器設成 None 或 VNC 驗證，或用桌面上的 VNC 用戶端開視窗後走視覺模型慢路徑。");
    if (types.includes(2)) result.advice.push("VNC 驗證需要密碼：用 secretName 指到主行程的機密（不要把密碼放進對話）。");
    return finish();
  }
  if (b && b.kind === "nx") { result.kind = "nx"; result.details = { banner: b.banner }; result.advice.push("NX／NoMachine：協定可辨識（" + b.banner + "），但 NX 的繪圖協定沒有公開的純 JS 用戶端；請用 NoMachine 用戶端開視窗，改走視覺模型慢路徑。"); return finish(); }
  if (b && b.kind === "ssh") { result.kind = "ssh"; result.details = { banner: b.banner }; result.advice.push("這是 SSH，不是遠端桌面；若要看遠端畫面可以用 ssh -L 轉發 VNC 埠後再探測 127.0.0.1:<本機埠>。"); return finish(); }
  if (b && b.kind === "http") { return httpPath(result, host, port, false, opts); }
  // ----- 2. RDP：X.224 Connection Request（要求全部協定、再要求只有 Standard） -----
  const rdpAll = await tcpExchange(host, port, buildRdpRequest(1 | 2 | 8), { waitMs: 1200, stopAfter: 11 });
  const r1 = parseRdpResponse(rdpAll.data);
  if (r1 && r1.ok) {
    step("RDP X.224 Connection Confirm");
    const std = await tcpExchange(host, port, buildRdpRequest(null), { waitMs: 1000, stopAfter: 11 }), r0 = parseRdpResponse(std.data), stdAllowed = !!(r0 && r0.ok && !r0.failure);
    result.kind = "rdp"; result.details = { selected: r1.selected, selectedName: r1.selectedName, failure: r1.failure, failureName: r1.failureName, flags: r1.flagsInfo || null, standardRdpSecurityAllowed: stdAllowed, nla: r1.selected === 2 || r1.selected === 8 };
    const fr = freerdp(); result.details.clients = fr;
    result.capabilities = { objects: "vlm", input: "os" };
    result.advice.push("RDP：協定可辨識，但需要完整 RDP 客戶端才能取得繪製物件；改走 VLM 慢路徑" + (r1.selectedName ? "（伺服器選的安全層：" + r1.selectedName + "）" : "") + "。");
    if (r1.failure) result.advice.push("協商失敗：" + r1.failureName + "。");
    if (r1.selected === 2 || r1.selected === 8) result.advice.push("伺服器要求 NLA（CredSSP）：任何用戶端都要帳密才能進到畫面，這個程式不自己實作 CredSSP；請用 xfreerdp 開視窗（帳密走主行程機密）。");
    if (stdAllowed) result.advice.push("⚠ 伺服器也接受 Standard RDP Security（RC4、無伺服器驗證），這是已知較弱的設定，建議關閉。");
    if (fr.xfreerdp || fr.wlfreerdp) result.advice.push("這台機器有 " + (fr.xfreerdp || fr.wlfreerdp) + "：remote_connect kind:'rdp' 可以替你組好指令開出視窗，之後把那個視窗當畫布，用截圖＋視覺模型操作。"); else result.advice.push("這台機器沒有 xfreerdp／wlfreerdp（Windows 用內建 mstsc）；沒有 RDP 用戶端就無法看到畫面。");
    return finish();
  }
  if (r1 && !r1.ok) step("回應像 RDP 但不是 Connection Confirm：" + r1.error);
  const hb = classifyBanner(rdpAll.data); if (hb && hb.kind === "http") return httpPath(result, host, port, false, opts);
  // ----- 3. SPICE -----
  const sp = await tcpExchange(host, port, buildSpiceLink(), { waitMs: 1200, stopAfter: 20 }), s1 = parseSpiceReply(sp.data);
  if (s1) {
    step("SPICE link reply");
    result.kind = "spice"; result.details = { major: s1.major, minor: s1.minor, linkError: s1.linkError, linkErrorName: s1.linkErrorName, replySize: s1.size, tls: false };
    result.advice.push("SPICE（" + s1.major + "." + s1.minor + "）：協定可辨識；SPICE 有多條通道（display／inputs／cursor），沒有公開的純 JS 用戶端。請用 remote-viewer／virt-viewer／spicy 開視窗，改走視覺模型慢路徑。" + (s1.linkError ? "（link 回應：" + s1.linkErrorName + "）" : ""));
    return finish();
  }
  // ----- 4. TLS 包起來的（RFB over TLS、SPICE+TLS、HTTPS、RDP 在 TLS 之內不會在這裡看到） -----
  const tl = { tls: true }; const t1 = await tcpExchange(host, port, null, Object.assign(tl, { waitMs: 900 }));
  if (!t1.error || t1.data.length) {
    step("TLS 握手成功"); result.details.tls = tl.tlsInfo || true;
    const tb = classifyBanner(t1.data);
    if (tb && tb.kind === "rfb") { result.kind = "rfb"; result.details.version = tb.version; result.details.transport = "tls"; result.capabilities = { objects: "vlm", input: "os" }; result.advice.push("RFB over TLS：這個用戶端不支援 TLS 包裝；請在伺服器開一個無 TLS 的埠（或 stunnel 轉接），或用桌面 VNC 用戶端開視窗走慢路徑。"); return finish(); }
    const tsp = await tcpExchange(host, port, buildSpiceLink(), { tls: true, waitMs: 1200, stopAfter: 20 }), ts = parseSpiceReply(tsp.data);
    if (ts) { result.kind = "spice"; result.details = Object.assign({ major: ts.major, minor: ts.minor, tls: true }, result.details); result.advice.push("SPICE over TLS（tls-port）：協定可辨識；走視覺模型慢路徑。"); return finish(); }
    return httpPath(result, host, port, true, opts);
  }
  result.kind = "unknown"; result.advice.push("連得上但不認得這個協定（沒有橫幅，RDP／SPICE／TLS 探測都沒有回應）。"); return finish();
}
async function httpPath(result, host, port, secure, o) {
  const req = Buffer.from("GET / HTTP/1.0\r\nHost: " + host + ":" + port + "\r\nUser-Agent: fa-computer-probe\r\nConnection: close\r\n\r\n");
  const r = await tcpExchange(host, port, req, { tls: secure, waitMs: 1500 }), text = r.data.toString("utf8", 0, 20000);
  if (!/^HTTP\/1\.[01]/.test(text)) { result.kind = "unknown"; result.details.tls = secure; result.advice.push("TLS 可連但不是 HTTP；不認得的協定。"); return result; }
  const web = classifyHttpBody(text);
  result.kind = "http"; result.details = Object.assign(result.details || {}, { status: (/^HTTP\/1\.[01] (\d{3})/.exec(text) || [])[1], web: web.web, secure, server: (/^server:\s*(.+)$/im.exec(text) || [])[1] || "" });
  result.advice.push("HTTP" + (secure ? "S" : "") + " 服務" + (web.note ? "：" + web.note : "") + "。");
  if (web.web === "novnc") { result.advice.push("試著用 ws" + (secure ? "s" : "") + "://" + host + ":" + port + "/websockify 探測（remote_probe 帶 wsUrl）。"); result.capabilities = { objects: "vlm", input: "os" }; }
  return result;
}

// ---------- xfreerdp 指令組裝（未實測：這台機器沒有 RDP 伺服器可以連） ----------
// 密碼從 stdin 傳（不放進 argv，ps 看不到）：/from-stdin:force
function buildFreerdpCommand(o) {
  o = o || {}; const bin = o.binary || "xfreerdp", args = ["/v:" + o.host + (o.port && Number(o.port) !== 3389 ? ":" + o.port : "")];
  if (o.user) args.push("/u:" + o.user); if (o.domain) args.push("/d:" + o.domain);
  args.push("/size:" + (o.width || 1280) + "x" + (o.height || 800)); args.push("/sec:" + ({ nla: "nla", tls: "tls", rdp: "rdp" }[o.security] || "tls"));
  if (o.certIgnore !== false) args.push("/cert:ignore"); args.push("+clipboard", "-wallpaper", "/title:" + (o.title || "fa-rdp:" + o.host)); if (o.password != null) args.push("/from-stdin:force");
  for (const e of o.extra || []) if (/^[+\/-][\w:.=@-]+$/.test(e) && !/^\/p:/.test(e)) args.push(e);
  return { cmd: bin, args, stdin: o.password != null ? String(o.password) + "\n" : null, titleHint: o.title || "fa-rdp:" + o.host };
}

module.exports = { REMOTE_KINDS, OBJECT_SOURCES, INPUT_PATHS, makeRemoteTarget, classifyWindow, CANVAS_PROCS, parseTarget, buildRdpRequest, parseRdpResponse, buildSpiceLink, parseSpiceReply, classifyBanner, classifyHttpBody, probeRemote, buildFreerdpCommand, RDP_PROTOCOLS, RDP_FAILURES };
