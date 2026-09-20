// 桌面版「瀏覽器控制」本機服務：Chrome 擴充功能（Floating AI Assitant(Chrome Extension)）
// 主動來這裡輪詢指令，renderer 透過 IPC（fa:bc:call）丟指令、等結果。
// 只綁 127.0.0.1，所有請求都要帶 X-FA-Token（配對碼），CORS 只放行 chrome-extension:// 來源，
// 一般網頁即使能打到這個 port 也拿不到指令。
"use strict";
const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const DEFAULT_PORT = 17923;

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
  let lastSeen = 0;
  let launching = null;
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
      lastPoll = lastSeen = Date.now();
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
      req.on("close", () => { lastSeen = Date.now(); if (!w.done) { w.done = true; clearTimeout(w.timer); const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); } });
      waiters.push(w);
      deliver();
      return;
    }
    if (req.method === "POST" && url.pathname === "/bc/result") {
      try {
        const body = JSON.parse(await readBody(req, 40 * 1024 * 1024));
        const p = pending.get(body.id);
        lastSeen = Date.now();
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

  // 有一條還開著的長輪詢＝擴充功能活著；瀏覽器被關掉時那條連線會斷，約5秒內就判定離線
  // （不用等舊的35秒），才能盡快觸發自動開啟 Chrome。
  function connected() { return waiters.some((w) => !w.done) || Date.now() - lastSeen < 5000; }

  function findChrome() {
    const cands = [];
    if (process.env.FA_BROWSER_CONTROL_BROWSER) cands.push(process.env.FA_BROWSER_CONTROL_BROWSER);
    if (process.platform === "win32") {
      const roots = [process.env["ProgramFiles"], process.env["ProgramFiles(x86)"], process.env["LOCALAPPDATA"]].filter(Boolean);
      for (const r of roots) cands.push(path.join(r, "Google", "Chrome", "Application", "chrome.exe"));
      for (const r of roots) cands.push(path.join(r, "Microsoft", "Edge", "Application", "msedge.exe"));
    } else if (process.platform === "darwin") {
      cands.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium");
    } else {
      for (const n of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser", "microsoft-edge"]) {
        try { const p = execFileSync("which", [n], { encoding: "utf8" }).trim(); if (p) cands.push(p); } catch (_) {}
      }
    }
    return cands.find((c) => { try { return fs.existsSync(c); } catch (_) { return false; } }) || "";
  }

  // 單機版：擴充功能沒連上時，試著把 Chrome 開起來（擴充功能隨瀏覽器啟動就會來連線），最多等 25 秒。
  function ensureBrowser() {
    if (connected()) return Promise.resolve({ launched: false });
    if (launching) return launching;
    launching = (async () => {
      const exe = findChrome();
      if (!exe) return { launched: false, error: "找不到 Chrome（也沒有 Edge），請手動開啟瀏覽器" };
      try {
        const child = spawn(exe, [], { detached: true, stdio: "ignore" });
        child.on("error", () => {});
        child.unref();
      } catch (err) { return { launched: false, error: "無法啟動瀏覽器：" + String((err && err.message) || err) }; }
      log("[browser-control] 擴充功能未連線，已嘗試開啟瀏覽器：" + exe);
      const end = Date.now() + 25000;
      while (Date.now() < end) {
        if (connected()) return { launched: true, browser: path.basename(exe) };
        await new Promise((r) => setTimeout(r, 400));
      }
      return { launched: true, error: "已開啟瀏覽器，但擴充功能 25 秒內沒有連上（是否已安裝並貼上配對碼？）" };
    })().finally(() => { launching = null; });
    return launching;
  }

  async function call(cmd, args, timeoutMs) {
    if (serverError) return { ok: false, error: serverError };
    let launchInfo = null;
    if (!connected()) {
      launchInfo = await ensureBrowser();
      if (!connected()) return { ok: false, error: "NOT_CONNECTED", note: (launchInfo.error ? launchInfo.error + "。" : "") + "Chrome 擴充功能尚未連線到桌面版。請確認已安裝擴充功能、貼上配對碼並儲存（設定 → 瀏覽器控制）。" };
    }
    const id = crypto.randomUUID();
    const ms = Math.min(Math.max(Number(timeoutMs) || 30000, 2000), 120000);
    const result = await new Promise((resolve) => {
      const timer = setTimeout(() => { pending.delete(id); resolve({ ok: false, error: `擴充功能 ${Math.round(ms / 1000)} 秒內沒有回應` }); }, ms);
      pending.set(id, { resolve, timer });
      queue.push({ id, cmd, args: args || {} });
      deliver();
    });
    if (launchInfo && launchInfo.launched && result && typeof result === "object") result.browser_launched = true;
    return result;
  }

  function status() {
    return { port, token, connected: connected(), lastPollAgoMs: lastPoll ? Date.now() - lastPoll : null, extensionVersion: extVersion, serverError };
  }

  function stop() { try { server && server.close(); } catch (_) {} }

  return { start, call, status, stop, regenerateToken: rotateToken, defaultPort: DEFAULT_PORT };
}

module.exports = { createBrowserControlServer, DEFAULT_PORT };
