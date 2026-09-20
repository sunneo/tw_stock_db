// 桌面版「瀏覽器控制」本機服務：Chrome 擴充功能（Floating AI Assitant(Chrome Extension)）
// 主動來這裡輪詢指令，renderer 透過 IPC（fa:bc:call）丟指令、等結果。
// 只綁 127.0.0.1，所有請求都要帶 X-FA-Token（配對碼），CORS 只放行 chrome-extension:// 來源，
// 一般網頁即使能打到這個 port 也拿不到指令。
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const DEFAULT_PORT = 17923;
const CONNECTED_WINDOW_MS = 35000;

function createBrowserControlServer({ userDataDir, onLog }) {
  const log = onLog || (() => {});
  const tokenFile = path.join(userDataDir, "browser-control-token.txt");
  let token = "";
  try { token = fs.readFileSync(tokenFile, "utf8").trim(); } catch (_) {}
  if (!token) token = rotateToken();

  function rotateToken() {
    const t = crypto.randomBytes(16).toString("hex");
    try { fs.mkdirSync(userDataDir, { recursive: true }); fs.writeFileSync(tokenFile, t, { mode: 0o600 }); } catch (err) { log("[browser-control] 無法儲存配對碼：" + err.message); }
    token = t;
    return t;
  }

  const queue = [];
  const waiters = [];
  const pending = new Map();
  let lastPoll = 0;
  let extVersion = "";
  let port = 0;
  let serverError = "";
  let server = null;

  function deliver() {
    while (queue.length && waiters.length) {
      const w = waiters.shift();
      if (w.done) continue;
      w.done = true;
      clearTimeout(w.timer);
      w.res.writeHead(200, w.headers({ "Content-Type": "application/json" }));
      w.res.end(JSON.stringify(queue.shift()));
    }
  }

  function corsHeaders(req) {
    const origin = String(req.headers.origin || "");
    const h = { "Cache-Control": "no-store" };
    if (origin.startsWith("chrome-extension://")) {
      h["Access-Control-Allow-Origin"] = origin;
      h["Access-Control-Allow-Headers"] = "X-FA-Token, Content-Type";
      h["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS";
      h["Vary"] = "Origin";
    }
    return h;
  }

  function readBody(req, limit) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => { size += c.length; if (size > limit) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
      req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const headers = (extra) => Object.assign(corsHeaders(req), extra || {});
    if (req.method === "OPTIONS") { res.writeHead(204, headers()); res.end(); return; }
    const provided = String(req.headers["x-fa-token"] || "");
    const a = Buffer.from(provided), b = Buffer.from(token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) { res.writeHead(401, headers()); res.end(); return; }
    const url = new URL(req.url, "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/bc/poll") {
      lastPoll = Date.now();
      extVersion = url.searchParams.get("v") || extVersion;
      const wait = Math.min(Math.max(Number(url.searchParams.get("wait")) || 20000, 1000), 25000);
      const w = { res, headers, done: false, timer: null };
      w.timer = setTimeout(() => {
        if (w.done) return;
        w.done = true;
        const i = waiters.indexOf(w);
        if (i >= 0) waiters.splice(i, 1);
        res.writeHead(204, headers());
        res.end();
      }, wait);
      req.on("close", () => { if (!w.done) { w.done = true; clearTimeout(w.timer); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); } });
      waiters.push(w);
      deliver();
      return;
    }
    if (req.method === "POST" && url.pathname === "/bc/result") {
      try {
        const body = JSON.parse(await readBody(req, 40 * 1024 * 1024));
        const p = pending.get(body.id);
        if (p) { pending.delete(body.id); clearTimeout(p.timer); p.resolve(body.result); }
        res.writeHead(200, headers({ "Content-Type": "application/json" }));
        res.end("{}");
      } catch (err) {
        res.writeHead(400, headers());
        res.end();
      }
      return;
    }
    res.writeHead(404, headers());
    res.end();
  }

  function start(preferredPort) {
    return new Promise((resolve) => {
      server = http.createServer((req, res) => { handle(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (_) {} }); });
      server.on("error", (err) => {
        serverError = err && err.code === "EADDRINUSE" ? `連接埠 ${preferredPort} 已被占用，瀏覽器控制無法啟用（可用環境變數 FA_BROWSER_CONTROL_PORT 換一個，並同步改擴充功能的連接埠）` : String((err && err.message) || err);
        log("[browser-control] " + serverError);
        resolve(false);
      });
      server.listen(preferredPort, "127.0.0.1", () => { port = preferredPort; serverError = ""; log(`[browser-control] 本機服務啟動於 127.0.0.1:${port}`); resolve(true); });
    });
  }

  function connected() { return Date.now() - lastPoll < CONNECTED_WINDOW_MS; }

  function call(cmd, args, timeoutMs) {
    if (serverError) return Promise.resolve({ ok: false, error: serverError });
    if (!connected()) return Promise.resolve({ ok: false, error: "NOT_CONNECTED", note: "Chrome 擴充功能尚未連線到桌面版。請確認已安裝擴充功能、貼上配對碼並儲存（設定 → 瀏覽器控制）。" });
    const id = crypto.randomUUID();
    const ms = Math.min(Math.max(Number(timeoutMs) || 30000, 2000), 120000);
    return new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: `擴充功能 ${Math.round(ms / 1000)} 秒內沒有回應` }); }, ms);
      pending.set(id, { resolve, timer });
      queue.push({ id, cmd, args: args || {} });
      deliver();
    });
  }

  function status() {
    return { port, token, connected: connected(), lastPollAgoMs: lastPoll ? Date.now() - lastPoll : null, extensionVersion: extVersion, serverError };
  }

  function stop() { try { server && server.close(); } catch (_) {} }

  return { start, call, status, stop, regenerateToken: rotateToken, defaultPort: DEFAULT_PORT };
}

module.exports = { createBrowserControlServer, DEFAULT_PORT };
